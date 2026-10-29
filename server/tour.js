// Турнир из базы в том виде, в каком его хранит страница, и всё, что из него вычисляется.
const B = require('../shared/bracket.js');
const { all } = require('./db');
const { can, RANK } = require('./roles');
const config = require('./config');

const RR_MAX = 10, BR_MAX = 64;
// строки турниров всегда берём с именем владельца
const TOUR_SQL = 'SELECT t.*, o.name AS owner_name FROM tournaments t LEFT JOIN players o ON o.id = t.owner_id';
const maxPlayers = fmt => fmt === 'rr' ? RR_MAX : BR_MAX;

// rows — строки tournaments; один запрос на участников и один на матчи для всех сразу
async function loadTours(c, rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ents = await all(c, `SELECT e.tournament_id, e.player_id, e.place_lo, e.place_hi, e.paid, p.name, p.city, p.club, p.rating, p.photo, p.title, p.role, p.walkon
    FROM entries e JOIN players p ON p.id = e.player_id WHERE e.tournament_id = ANY($1) ORDER BY e.seed_no, e.player_id`, [ids]);
  // ln — [очки, дротики] строк сыгранного матча: средний набор в сетке
  const ms = await all(c, `SELECT m.id, m.tournament_id, m.r, m.i, m.q_player, m.q_try, m.status, m.players, m.legs, m.w, m.finished, m.started, m.quick,
    (SELECT json_agg(json_build_array(l.pts, l.darts) ORDER BY l.idx) FROM match_lines l WHERE l.match_id = m.id) AS ln
    FROM matches m WHERE m.tournament_id = ANY($1)`, [ids]);
  const ph = await all(c, `SELECT id, file, tournament_id, w, h FROM photos WHERE tournament_id = ANY($1) ORDER BY created_at`, [ids]);
  const qs = rows.some(r => r.qual) ? await all(c, 'SELECT * FROM qual_results WHERE tournament_id = ANY($1) ORDER BY try', [ids]) : [];
  // турниры клуба: ведущие клуба (соорганизаторы), помощники, логотип
  const cids = [...new Set(rows.map(r => r.club_id).filter(Boolean))];
  const hosts = cids.length ? await all(c, `SELECT h.club_id, h.player_id, p.role FROM club_hosts h JOIN players p ON p.id = h.player_id JOIN clubs c ON c.id = h.club_id
    WHERE h.club_id = ANY($1) AND c.status = 'active' AND NOT p.blocked`, [cids]) : [];
  const helpers = cids.length ? await all(c, 'SELECT club_id, player_id FROM club_helpers WHERE club_id = ANY($1)', [cids]) : [];
  const logos = cids.length ? await all(c, 'SELECT id, logo FROM clubs WHERE id = ANY($1)', [cids]) : [];
  return rows.map(row => {
    const t = build(row, ents.filter(e => e.tournament_id === row.id), ms.filter(m => m.tournament_id === row.id), qs.filter(q => q.tournament_id === row.id));
    t.photos = ph.filter(p => p.tournament_id === row.id).map(p => ({ id: p.id, url: config.uploadUrl + p.file, w: p.w, h: p.h }));
    // общее фото игроков — одно из фото турнира
    t.cover = row.cover ? t.photos.find(p => p.id === row.cover) || null : null;
    t.links = row.links || [];
    t.streams = row.streams || [];
    const hs = hosts.filter(h => h.club_id === row.club_id);
    Object.defineProperty(t, '_club', { value: row.club_id ? {
      hosts: new Set(hs.map(h => h.player_id)), helpers: new Set(helpers.filter(h => h.club_id === row.club_id).map(h => h.player_id)),
      branded: hs.some(h => can({ role: h.role }, 'club_tools')), logo: (logos.find(x => x.id === row.club_id) || {}).logo || null
    } : null });
    return t;
  });
}

const avgOf = l => l && l[1] ? Math.round(l[0] / l[1] * 30) / 10 : null;

function build(row, ents, ms, qs) {
  const t = {
    id: row.id, name: row.name, official: row.official, city: row.city, venue: row.venue, start: row.start, regUntil: row.reg_until,
    status: row.status, format: row.format, mode: row.mode, ltw: row.ltw, dbl: row.dbl, cap: row.cap,
    players: ents.map(e => e.player_id), games: [], live: {}, version: row.version
  };
  if (row.ex) t.ex = row.ex;
  if (row.split) t.split = row.split;
  if (row.stage) t.stage = row.stage;
  if (row.boards) t.boards = row.boards;
  if (row.ready) t.ready = row.ready;
  if (row.nums) t.nums = row.nums;
  if (row.layout) t.layout = row.layout;
  if (row.labels) t.labels = row.labels;
  if (row.qual) {
    t.qual = { ex: row.qual.ex, tries: row.qual.tries, res: {} };
    qs.forEach(q => { (t.qual.res[q.player_id] = t.qual.res[q.player_id] || [])[q.try] = { v: q.v, mid: q.match_id, t: q.t }; });
  }
  // темп: средняя длительность матча и попытки квалификации в счётчике (мс) — для «осталось примерно»
  const dur = q => { const d = ms.filter(m => m.status === 'done' && !m.quick && (m.q_player != null) === q && m.started && m.finished).map(m => m.finished - m.started).filter(x => x > 30e3 && x < 90 * 6e4); return d.length ? Math.round(d.reduce((a, x) => a + x, 0) / d.length) : null; };
  t.pace = { match: dur(false), qual: dur(true) };
  // когда турнир на деле начался — первый матч в счётчике (для «идёт 1 ч 20 мин»)
  const st0 = ms.map(m => +m.started).filter(Boolean);
  if (st0.length) t.began = Math.min(...st0);
  if (row.done_at) t.doneAt = +row.done_at;
  Object.defineProperty(t, '_row', { value: row });
  Object.defineProperty(t, '_ents', { value: ents });
  if (row.status === 'reg') return t;
  ms.forEach(m => { if (m.q_player != null && m.status === 'live') t.live['q:' + m.q_player + ':' + m.q_try] = m.id; });
  if (t.stage === 'qual') return t;
  if (B.isBracket(t)) {
    t.slots = row.slots;
    if (row.block) t.block = row.block;
    t.games = B.bracketGames(t.format, t.slots.length, t.block);
  } else t.games = B.rrGames(t.players);
  ms.forEach(m => {
    const g = m.r == null ? null : B.gameAt(t, m.r, m.i);
    if (!g) return;
    if (m.status === 'live') t.live[m.r + ':' + m.i] = m.id;
    else g.res = { la: m.legs[0], lb: m.legs[1], w: m.players[m.w].id, mid: m.id, avg: m.ln ? [avgOf(m.ln[0]), avgOf(m.ln[1])] : [null, null] };
  });
  return t;
}

function standings(t) {
  const s = {};
  t.players.forEach(id => { s[id] = { id, w: 0, lf: 0, la: 0 }; });
  t.games.forEach(g => {
    if (!g.res || !s[g.a] || !s[g.b]) return;
    s[g.a].lf += g.res.la; s[g.a].la += g.res.lb; s[g.b].lf += g.res.lb; s[g.b].la += g.res.la;
    s[g.res.w === g.a ? g.a : g.b].w++;
  });
  return Object.values(s).sort((x, y) => y.w - x.w || (y.lf - y.la) - (x.lf - x.la) || y.lf - x.lf);
}

function tStatus(t) {
  if (t.status === 'reg') return 'reg';
  const p = B.tProgress(t);
  return p.total && p.done === p.total ? 'done' : 'live';
}

function champion(t) {
  if (tStatus(t) !== 'done') return null;
  if (B.isBracket(t)) { const w = B.resolver(t).outcome(B.bRounds(t) - 1, 0).w; return B.isReal(w) ? w : null; }
  return standings(t)[0].id;
}

// призёры для ленты: до 4 мест [{ id, name, lo, hi }]
function podiumOf(t) {
  const pl = placesOf(t);
  return Object.keys(pl).filter(id => pl[id][0] <= 3).sort((a, b) => pl[a][0] - pl[b][0] || (a < b ? -1 : 1)).slice(0, 4)
    .map(id => ({ id, name: (t._ents.find(e => e.player_id === id) || {}).name || '—', lo: pl[id][0], hi: pl[id][1] }));
}
// лучшее в сыгранном турнире: среднее за матч, закрытие, 180 — для итогов и поста
async function tourBest(c, tid) {
  const rows = await all(c, `SELECT l.player_id AS id, l.name, l.pts, l.darts, l.hco, l.c180 FROM match_lines l JOIN matches m ON m.id = l.match_id
    WHERE m.tournament_id = $1 AND m.status = 'done' AND m.q_player IS NULL AND (m.ex IS NULL OR m.ex->>'k' = 'x01') AND l.player_id IS NOT NULL`, [tid]);
  let avg = null, hco = null;
  const c180 = new Map();
  rows.forEach(r => {
    if (r.darts >= 9) { const v = Math.round(r.pts / r.darts * 30) / 10; if (!avg || v > avg.v) avg = { id: r.id, name: r.name, v }; }
    if (r.hco && (!hco || r.hco > hco.v)) hco = { id: r.id, name: r.name, v: r.hco };
    if (r.c180) c180.set(r.id, { id: r.id, name: r.name, n: ((c180.get(r.id) || {}).n || 0) + r.c180 });
  });
  const top = [...c180.values()].sort((a, b) => b.n - a.n)[0] || null;
  return { avg, hco, c180: { total: [...c180.values()].reduce((a, x) => a + x.n, 0), top } };
}

// места всех участников: { id: [lo, hi] }
function placesOf(t) {
  if (t.status === 'reg' || t.stage === 'qual') return {};
  const out = {};
  if (B.isBracket(t)) B.places(t).forEach(x => { out[x.id] = [x.lo, x.hi]; });
  else standings(t).forEach((x, k) => { out[x.id] = [k + 1, k + 1]; });
  return out;
}

// после любого изменения результатов: статус, время окончания, места
async function refreshTour(c, t) {
  const st = tStatus(t);
  let doneAt = null;
  if (st === 'done') doneAt = (await all(c, 'SELECT max(finished) AS f FROM matches WHERE tournament_id = $1', [t.id]))[0].f;
  // мишени держатся за готовыми играми: сыгранная игра освобождает свою
  const moved = t.boards && B.assignBoards(t);
  await c.query('UPDATE tournaments SET status = $2, done_at = $3, version = version + 1' + (moved ? ', boards = $4' : '') + ' WHERE id = $1',
    moved ? [t.id, st, doneAt, JSON.stringify(t.boards)] : [t.id, st, doneAt]);
  const pl = placesOf(t), ids = Object.keys(pl);
  await c.query(`UPDATE entries e SET place_lo = x.lo, place_hi = x.hi
    FROM unnest($2::text[], $3::int[], $4::int[]) AS x(id, lo, hi) WHERE e.tournament_id = $1 AND e.player_id = x.id`,
  [t.id, ids, ids.map(k => pl[k][0]), ids.map(k => pl[k][1])]);
  t.status = st;
}

// подписи как на странице (gameLabel)
const koName = k => k === 1 ? 'финал' : k === 2 ? '1/2 финала' : k === 3 ? '1/4 финала' : '1/' + 2 ** (k - 1) + ' финала';
function roundLabel(t, r) {
  if (t.format === 'rr') return 'тур ' + (r + 1);
  if (t.format === 'pl') return 'круг ' + (r + 1);
  return koName(B.bRounds(t) - r);
}
const placesTxt = (lo, hi) => lo === hi ? lo + '-е место' : lo + '–' + hi + ' места';
function gameLabel(t, g, rv) {
  if (!g) return '';
  if (t.format !== 'pl') return roundLabel(t, g.r);
  rv = rv || B.resolver(t);
  const { grp, lo } = B.plGroup(t, g.r, g.i), c = B.groupReal(t, rv, g.r, grp);
  if (g.r === B.bRounds(t) - 1) return lo === 1 ? 'финал' : 'матч за ' + lo + '-е место';
  if (g.r === 0 && !t.block) return 'круг 1';
  return 'круг ' + (g.r + 1) + ' · за ' + placesTxt(lo, lo + c - 1);
}

// значок PRO: тариф Pro или выше, кроме администраторов
const isPro = e => can({ role: e.role }, 'pro') && (RANK[e.role] || 0) < RANK.admin;
// организатор: создатель, ведущие клуба турнира, администратор с правом any_tour
const isOwner = (t, me) => !!me && (can(me, 'any_tour') || t._row.owner_id === me.id || !!(t._club && t._club.hosts.has(me.id)));
// команда турнира: организатор и помощники клуба — ведут счёт, ставят мишени, отмечают взносы
const isStaff = (t, me) => isOwner(t, me) || !!(me && t._club && t._club.helpers.has(me.id));
// взносы — в тарифе «Ведущий»: у клуба, где ведущий с этим правом, или у организатора с ним
const feesOn = (t, me) => isStaff(t, me) && (can(me, 'club_tools') || !!(t._club && t._club.branded));

// игроки игры сетки, если её можно начать: { a, b } или null
function readyPair(t, r, i) {
  const g = B.gameAt(t, r, i);
  if (!g || tStatus(t) !== 'live') return null;
  const s = B.gameState(t, g);
  return s.st === 'ready' ? { g, a: s.a, b: s.b } : null;
}
const canScoreGame = (t, me, a, b) => !!me && (isStaff(t, me) || me.id === a || me.id === b);

// можно ли снять результат игры g: дальше нет зависящих сыгранных матчей, идущие матчи остаются готовыми
function canClear(t, g, liveMatches) {
  return B.canClear(t, g, rv => liveMatches.every(m => {
    const lg = B.gameAt(t, m.r, m.i), s = lg && B.gameState(t, lg, rv);
    return s && s.st === 'ready' && s.a === m.players[0].id && s.b === m.players[1].id;
  }));
}

// сколько игроков сдали квалификацию
const qualDone = t => t.qual ? t.players.filter(id => (t.qual.res[id] || []).some(Boolean)).length : 0;
// порядок по квалификации: лучший результат, затем вторая попытка, затем рейтинг (как на странице)
function qualOrder(t) {
  const r = Object.fromEntries(t._ents.map(e => [e.player_id, e.rating]));
  const key = id => { const v = (t.qual.res[id] || []).filter(Boolean).map(x => x.v).sort((a, b) => b - a); return [v.length ? v[0] : -1, v.length > 1 ? v[1] : -1]; };
  return t.players.slice().sort((a, b) => { const ka = key(a), kb = key(b); return kb[0] - ka[0] || kb[1] - ka[1] || r[b] - r[a] || (a < b ? -1 : 1); });
}

// logo — у клуба с тарифом «Ведущий»
const orgOf = (row, t) => ({ id: row.owner_id, name: row.org_name || row.owner_name || '—', ver: row.org_ver, club: row.club_id || null, logo: t && t._club && t._club.branded ? t._club.logo : null });

function tourJSON(t, me) {
  const row = t._row, joined = !!me && t.players.includes(me.id), owner = isOwner(t, me), staff = isStaff(t, me), fees = feesOn(t, me);
  const roster = {};
  t._ents.forEach(e => { roster[e.player_id] = { name: e.name, city: e.city, club: e.club, r: Math.round(e.rating), photo: e.photo || null, title: e.title || '', walkon: e.walkon || '', pro: isPro(e) }; });
  const out = Object.assign({}, t, {
    org: orgOf(row, t), roster,
    can: {
      org: owner,
      stream: owner && can(me, 'streams'),
      edit: owner && t.status === 'reg',
      delete: owner,
      launch: owner && t.status === 'reg',
      score: !!me && t.status === 'live' && (staff || joined),
      staff,
      fees,
      join: !!me && t.status === 'reg' && (joined || t.players.length < t.cap)
    }
  });
  out.games = t.games.map(g => Object.assign({}, g));
  out.fee = row.fee == null ? null : row.fee;
  // отметки «оплатил» видит только команда турнира
  if (fees) out.fees = { fee: row.fee, paid: t._ents.filter(e => e.paid).map(e => e.player_id) };
  return out;
}

function tourCard(t, me) {
  const row = t._row, ch = champion(t), e = ch && t._ents.find(x => x.player_id === ch);
  return {
    id: t.id, name: t.name, official: t.official, org: orgOf(row, t), city: t.city, venue: t.venue, start: t.start, regUntil: t.regUntil,
    status: t.status, format: t.format, mode: t.mode, ltw: t.ltw, cap: t.cap, count: t.players.length,
    ex: t.ex || null, qual: t.qual ? { ex: t.qual.ex, tries: t.qual.tries } : null, split: t.split || null, stage: t.stage || null, layout: t.layout || null, labels: t.labels || null,
    progress: t.status === 'reg' ? { done: 0, total: 0 } : t.stage === 'qual' ? { done: qualDone(t), total: t.players.length } : B.tProgress(t),
    champion: e ? { id: ch, name: e.name } : null, joined: !!me && t.players.includes(me.id), version: t.version,
    fee: row.fee == null ? null : row.fee, cover: t.cover, podium: t.status === 'done' ? podiumOf(t) : null
  };
}

module.exports = {
  RR_MAX, BR_MAX, TOUR_SQL, maxPlayers, loadTours, standings, tStatus, champion, placesOf, refreshTour,
  roundLabel, gameLabel, isOwner, isStaff, feesOn, tourBest, readyPair, canScoreGame, canClear, tourJSON, tourCard, qualDone, qualOrder
};
