// Стадии турнира: запуск, закрытие квалификации и групп, «Кубок B», судьи на матчи.
// Закрытие и судьи срабатывают и сами (autoStage) — после каждого результата.
const B = require('../shared/bracket.js');
const { one, all } = require('./db');
const { E } = require('./errors');
const T = require('./tour');
const { forget } = require('./versions');

async function getTour(c, id, lock) {
  const row = await one(c, T.TOUR_SQL + ' WHERE t.id = $1' + (lock ? ' FOR UPDATE OF t' : ''), [id]);
  if (!row) throw E.notFound('Турнир не найден');
  return (await T.loadTours(c, [row]))[0];
}

// посев и сетка; турнир становится live. С квалификацией сетки ещё нет: сначала стадия qual.
// участники в порядке посева; отметки «оплатил» сохраняются
async function reseed(c, id, order) {
  const paid = (await all(c, 'SELECT player_id FROM entries WHERE tournament_id = $1 AND paid', [id])).map(x => x.player_id);
  await c.query('DELETE FROM entries WHERE tournament_id = $1', [id]);
  await c.query('INSERT INTO entries (tournament_id, player_id, seed_no, paid) SELECT $1, x.id, x.n, x.id = ANY($3) FROM unnest($2::text[]) WITH ORDINALITY AS x(id, n)', [id, order, paid]);
}
// групповой этап: в каждой группе должно быть больше игроков, чем из неё выходит
function groupsCheck(G, n) {
  if (G.n * G.adv > T.BR_MAX) throw E.bad('Из групп в сетку выходят не больше ' + T.BR_MAX, 'groups');
  if (Math.floor(n / G.n) < Math.max(2, G.adv + 1)) throw E.conflict('bad_state', 'Мало участников для ' + G.n + ' ' + (G.n === 1 ? 'группы' : 'групп') + ': в каждой нужно больше, чем выходит из неё (' + G.adv + ')');
}
const BRK = ['ko', 'pl', 'de'];
// «Кубок B»: отдельный турнир с той же игрой для не попавших в основную сетку; off — сколько мест до него
async function makeCup(c, t, rest, off) {
  const r = t._row, cup = await one(c, `INSERT INTO tournaments (name, official, owner_id, org_name, org_ver, city, venue, start, status, format, mode, dbl, ltw, cap, ex, club_id, layout, labels, created_at, ltw_by, refs, parent, fee, split, place_off)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reg', $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24) RETURNING *`,
  [(r.name + ' · Кубок B').slice(0, 60), r.official, r.owner_id, r.org_name, r.org_ver, r.city, r.venue, Date.now(), t.format, r.mode, r.dbl, r.ltw, rest.length, r.ex ? JSON.stringify(r.ex) : null,
    r.club_id, r.layout, r.labels, Date.now(), r.ltw_by ? JSON.stringify(r.ltw_by) : null, r.refs ? JSON.stringify(Object.assign({ chief: r.refs.chief || null, pool: r.refs.pool || [], at: {} }, r.refs.auto ? { auto: true } : {})) : null, t.id, r.fee, t.format === 'pl' ? r.split : null, off]);
  // мишени — те же номера, что у основного турнира (ведущий может поменять)
  const bd = r.boards && (r.boards.n || (r.boards.names || []).length) ? Object.assign({ n: r.boards.n }, r.boards.names ? { names: r.boards.names } : {}) : null;
  if (bd) await c.query('UPDATE tournaments SET boards = $2 WHERE id = $1', [cup.id, JSON.stringify(bd)]);
  await launch(c, cup.id, t.format, rest, Object.assign({}, cup, bd ? { boards: bd } : {}));
  return cup.id;
}
const groupsRow = (G, ids) => JSON.stringify(Object.assign({ n: G.n, adv: G.adv, ids, done: false }, G.cups ? { cups: true } : {}));

async function launch(c, id, fmt, order, row) {
  const t = { players: [], games: [], layout: row.layout };
  let slots = null, groups = row.groups || null;
  if (row.groups) groupsCheck(row.groups, order.length);
  if (fmt === 'sw' && row.rounds && row.rounds >= order.length) throw E.conflict('bad_state', 'Туров должно быть меньше, чем участников (' + order.length + ')');
  if (row.qual) t.players = order;
  else if (row.groups) groups = groupsRow(row.groups, B.drawGroups(order, row.groups.n));
  else if (fmt === 'rr' || fmt === 'sw') t.players = order;
  if (fmt === 'sw' && !row.rounds) await c.query('UPDATE tournaments SET rounds = $2 WHERE id = $1', [id, Math.min(15, Math.max(1, Math.ceil(Math.log2(order.length))))]);
  else { B.setBracket(t, fmt, order, row.split); slots = t.slots; }
  await reseed(c, id, order);
  await c.query(`UPDATE tournaments SET status = 'live', slots = $2, block = $3, stage = $4, start = $5, groups = $6 WHERE id = $1`,
    [id, slots && JSON.stringify(slots), t.block || null, row.qual ? 'qual' : row.groups ? 'groups' : null, Date.now(), groups && (typeof groups === 'string' ? groups : JSON.stringify(groups))]);
  await T.refreshTour(c, await getTour(c, id, false));
}

// закрыть квалификацию: посев по лучшему результату; основная сетка и «Кубок B», группы или таблица
async function closeQual(c, t) {
  const order = T.qualOrder(t), g = { players: [], games: [], layout: t.layout }, G = t._row.groups;
  // основная сетка — первые main (больше 64 участников — 64 сама), остальные играют «Кубок B»
  let main = !G && BRK.includes(t.format) ? t.qual.main || (order.length > T.BR_MAX ? T.BR_MAX : null) : null;
  if (main && order.length <= main) main = null;
  const top = main ? order.slice(0, main) : order, rest = main ? order.slice(main) : [];
  const cups = t._row.qual.cups !== false;
  if (cups && rest.length > T.BR_MAX) throw E.conflict('bad_state', 'В «Кубок B» уходит больше ' + T.BR_MAX + ' игроков — увеличьте основную сетку');
  // «Комплексный»: после квалификации — группы змейкой по её итогам; круговая — таблица в этом порядке; иначе сетка (pl — частями, если задано)
  if (G) groupsCheck(G, order.length); else if (t.format !== 'rr' && t.format !== 'sw') B.setBracket(g, t.format, top, t.format === 'pl' ? t.split : undefined);
  await reseed(c, t.id, order);
  if (main) {
    const q = Object.assign({}, t._row.qual, { main });
    if (cups && rest.length >= 2) q.cupB = await makeCup(c, t, rest, main);
    // места в этом турнире — после сетки: точные придут из «Кубка B»; без кубка — по квалификации
    q.rest = Object.fromEntries(rest.map((id, k) => [id, q.cupB ? [main + 1, main + rest.length] : [main + 1 + k, main + 1 + k]]));
    await c.query('UPDATE tournaments SET qual = $2 WHERE id = $1', [t.id, JSON.stringify(q)]);
  }
  const nums = JSON.stringify(Object.fromEntries(order.map((id, k) => [id, k + 1])));
  if (G) await c.query(`UPDATE tournaments SET stage = 'groups', groups = $2, nums = $3 WHERE id = $1`, [t.id, groupsRow(G, B.drawGroups(order, G.n)), nums]);
  else await c.query(`UPDATE tournaments SET stage = NULL, slots = $2, block = $3, nums = $4 WHERE id = $1`, [t.id, g.slots ? JSON.stringify(g.slots) : null, g.block || null, nums]);
  await T.refreshTour(c, await getTour(c, t.id, false));
  forget('t', t.id);
}

// закрыть групповой этап: из каждой группы выходят первые adv, строится сетка; остальные — «Кубок B», если включён
async function closeGroups(c, t) {
  const order = B.groupAdvance(t), g = { players: [], games: [], layout: t.layout };
  B.setBracket(g, t.format, order);
  await c.query('UPDATE matches SET r = r + 64 WHERE tournament_id = $1 AND r IS NOT NULL AND r < 64', [t.id]);
  const G = Object.assign({}, t._row.groups, { done: true });
  // «Кубок B»: остальные — по месту в группе — играют свою сетку в отдельном турнире
  if (G.cups) {
    const tabs = G.ids.map((ids, k) => B.table(ids, t.groups.games.filter(x => x.grp === k))), rest = [];
    for (let p = G.adv; p < Math.max(...tabs.map(x => x.length)); p++) tabs.forEach(tb => { if (tb[p]) rest.push(tb[p].id); });
    if (rest.length >= 2) G.cupB = await makeCup(c, t, rest, order.length);
  }
  const refs = t.refs && Object.keys(t.refs.at || {}).length ? Object.assign({}, t.refs, { at: Object.fromEntries(Object.entries(t.refs.at).map(([k, v]) => [/^g/.test(k) ? k : 'g' + k, v])) }) : t.refs || null;
  const boards = t.boards ? Object.assign({}, t.boards, { at: {} }) : null;
  await c.query(`UPDATE tournaments SET stage = NULL, slots = $2, block = NULL, groups = $3, refs = $4, boards = $5, ready = NULL WHERE id = $1`,
    [t.id, JSON.stringify(g.slots), JSON.stringify(G), refs && JSON.stringify(refs), boards && JSON.stringify(boards)]);
  await T.refreshTour(c, await getTour(c, t.id, false));
  forget('t', t.id);
}

// судьи на готовые игры (и идущие без судьи): по очереди, у кого меньше всего матчей; сам себя не судит. true — что-то поменялось
function autoRefs(t, rf) {
  const rv = B.resolver(t), load = Object.fromEntries(rf.pool.map(n => [n, 0]));
  let changed = false;
  Object.values(rf.at).forEach(n => { if (n in load) load[n]++; });
  for (const g of t.games) {
    const k = g.r + ':' + g.i, gs = B.gameState(t, g, rv);
    if (rf.at[k] || gs.st !== 'ready') continue;
    // сам себя не судит
    const pl = [gs.a, gs.b].map(id => (t._ents.find(e => e.player_id === id) || {}).name);
    const free = rf.pool.filter(n => !pl.includes(n));
    if (!free.length) continue;
    const pick = free.reduce((a, n) => load[n] < load[a] ? n : a);
    rf.at[k] = pick; load[pick]++; changed = true;
  }
  return changed;
}

// после каждого результата: всё сыграно — стадия закрывается сама (квалификация — если нет равенства); судьи — на новые игры
async function autoStage(c, tid) {
  let t = await getTour(c, tid, true);
  if (t.status !== 'live') return;
  const idle = !Object.keys(t.live).length;
  if (t.stage === 'qual' && idle && T.qualDone(t) >= 2 && t.players.every(id => (t.qual.res[id] || []).filter(Boolean).length >= t.qual.tries) && !T.qualTies(t, true).length) {
    await closeQual(c, t);
    t = await getTour(c, tid, true);
  } else if (t.stage === 'groups' && idle) {
    const pr = B.tProgress(t);
    if (pr.total && pr.done >= pr.total) { await closeGroups(c, t); t = await getTour(c, tid, true); }
  }
  if (t.refs && t.refs.auto && (t.refs.pool || []).length && t.games.length) {
    const rf = Object.assign({}, t.refs, { at: Object.assign({}, t.refs.at) });
    if (autoRefs(t, rf)) {
      await c.query('UPDATE tournaments SET refs = $2, version = version + 1 WHERE id = $1', [t.id, JSON.stringify(rf)]);
      forget('t', t.id);
    }
  }
}

module.exports = { getTour, reseed, groupsCheck, groupsRow, BRK, makeCup, launch, closeQual, closeGroups, autoRefs, autoStage };
