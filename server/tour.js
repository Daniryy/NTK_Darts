// Турнир из базы в том виде, в каком его хранит страница, и всё, что из него вычисляется.
const B = require('../shared/bracket.js');
const { all } = require('./db');

const RR_MAX = 10, BR_MAX = 64;
// строки турниров всегда берём с именем владельца
const TOUR_SQL = 'SELECT t.*, o.name AS owner_name FROM tournaments t LEFT JOIN players o ON o.id = t.owner_id';
const maxPlayers = fmt => fmt === 'rr' ? RR_MAX : BR_MAX;

// rows — строки tournaments; один запрос на участников и один на матчи для всех сразу
async function loadTours(c, rows) {
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const ents = await all(c, `SELECT e.tournament_id, e.player_id, e.place_lo, e.place_hi, p.name, p.city, p.club, p.rating
    FROM entries e JOIN players p ON p.id = e.player_id WHERE e.tournament_id = ANY($1) ORDER BY e.seed_no, e.player_id`, [ids]);
  // ln — [очки, дротики] строк сыгранного матча: средний набор в сетке
  const ms = await all(c, `SELECT m.id, m.tournament_id, m.r, m.i, m.q_player, m.q_try, m.status, m.players, m.legs, m.w, m.finished,
    (SELECT json_agg(json_build_array(l.pts, l.darts) ORDER BY l.idx) FROM match_lines l WHERE l.match_id = m.id) AS ln
    FROM matches m WHERE m.tournament_id = ANY($1)`, [ids]);
  const qs = rows.some(r => r.qual) ? await all(c, 'SELECT * FROM qual_results WHERE tournament_id = ANY($1) ORDER BY try', [ids]) : [];
  return rows.map(row => build(row, ents.filter(e => e.tournament_id === row.id), ms.filter(m => m.tournament_id === row.id), qs.filter(q => q.tournament_id === row.id)));
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
  if (row.nums) t.nums = row.nums;
  if (row.qual) {
    t.qual = { ex: row.qual.ex, tries: row.qual.tries, res: {} };
    qs.forEach(q => { (t.qual.res[q.player_id] = t.qual.res[q.player_id] || [])[q.try] = { v: q.v, mid: q.match_id, t: q.t }; });
  }
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

const isOwner = (t, me) => !!me && (me.admin || t._row.owner_id === me.id);

// игроки игры сетки, если её можно начать: { a, b } или null
function readyPair(t, r, i) {
  const g = B.gameAt(t, r, i);
  if (!g || tStatus(t) !== 'live') return null;
  const s = B.gameState(t, g);
  return s.st === 'ready' ? { g, a: s.a, b: s.b } : null;
}
const canScoreGame = (t, me, a, b) => !!me && (isOwner(t, me) || me.id === a || me.id === b);

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

const orgOf = row => ({ id: row.owner_id, name: row.org_name || row.owner_name || '—', ver: row.org_ver });

function tourJSON(t, me) {
  const row = t._row, joined = !!me && t.players.includes(me.id), owner = isOwner(t, me);
  const roster = {};
  t._ents.forEach(e => { roster[e.player_id] = { name: e.name, city: e.city, club: e.club, r: Math.round(e.rating) }; });
  const out = Object.assign({}, t, {
    org: orgOf(row), roster,
    can: {
      edit: owner && t.status === 'reg',
      delete: owner,
      launch: owner && t.status === 'reg',
      score: !!me && t.status === 'live' && (owner || joined),
      join: !!me && t.status === 'reg' && (joined || t.players.length < t.cap)
    }
  });
  out.games = t.games.map(g => Object.assign({}, g));
  return out;
}

function tourCard(t, me) {
  const row = t._row, ch = champion(t), e = ch && t._ents.find(x => x.player_id === ch);
  return {
    id: t.id, name: t.name, official: t.official, org: orgOf(row), city: t.city, venue: t.venue, start: t.start, regUntil: t.regUntil,
    status: t.status, format: t.format, mode: t.mode, ltw: t.ltw, cap: t.cap, count: t.players.length,
    ex: t.ex || null, qual: t.qual ? { ex: t.qual.ex, tries: t.qual.tries } : null, split: t.split || null, stage: t.stage || null,
    progress: t.status === 'reg' ? { done: 0, total: 0 } : t.stage === 'qual' ? { done: qualDone(t), total: t.players.length } : B.tProgress(t),
    champion: e ? { id: ch, name: e.name } : null, joined: !!me && t.players.includes(me.id), version: t.version
  };
}

module.exports = {
  RR_MAX, BR_MAX, TOUR_SQL, maxPlayers, loadTours, standings, tStatus, champion, placesOf, refreshTour,
  roundLabel, gameLabel, isOwner, readyPair, canScoreGame, canClear, tourJSON, tourCard, qualDone, qualOrder
};
