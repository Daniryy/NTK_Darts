// Формат NDL на сервере: квалификация, сетки частями, упражнения в счётчике, мишени, номера игроков.
// TEST_DATABASE_URL=postgres://… npm test   (по умолчанию локальная база oche_test, стирается целиком)
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');
const B = require('../shared/bracket.js');
const Games = require('../shared/games.js');

let app, seq = 0;
const dev = () => 'ndl_device_' + String(++seq).padStart(8, '0');
async function login(playerId) {
  const u = { dev: dev(), cookie: '' };
  const r = await app.inject({ method: 'POST', url: '/api/auth/dev', payload: { playerId }, headers: { 'x-device-id': u.dev } });
  assert.equal(r.statusCode, 200, r.body);
  u.cookie = r.cookies.map(c => c.name + '=' + c.value).join('; ');
  return u;
}
async function call(u, method, url, body) {
  const headers = {};
  if (u) { headers.cookie = u.cookie; headers['x-device-id'] = u.dev; }
  const r = await app.inject({ method, url, payload: body, headers });
  return { s: r.statusCode, b: r.body ? JSON.parse(r.body) : null };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
const err = (r, code, ecode) => { assert.equal(r.s, code, JSON.stringify(r.b)); if (ecode) assert.equal(r.b.error.code, ecode); return r.b.error; };
const mid = () => 'g' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');
const SCORE = { k: 'score', lim: 10 };

// события подходов по очереди: vals[p] — значения игрока p; start — кто начинает лег
function legEvents(leg, start, vals, from) {
  const out = [], np = vals.length, k = Array(np).fill(0);
  let p = start;
  for (let n = 0; n < vals.reduce((a, x) => a + x.length, 0); n++) { out.push({ seq: from + n, type: 'visit', leg, p, v: vals[p][k[p]++], d: null }); p = (p + 1) % np; }
  return out;
}
// итог матча из движка, как его считает страница
function finishOf(m, visits, seqNo) {
  const st = Games.state({ ex: m.ex, np: m.players.length, ltw: m.ltw, starter: m.starter }, visits);
  return { seq: seqNo, type: 'finish', w: st.winner, pl: m.players.map((p, k) => ({ id: p.id, legs: st.legs[k], pts: st.pts[k], darts: st.darts[k], f9: null })) };
}
const asVisit = e => e.type === 'bull' ? { leg: e.leg, p: e.p, tb: 1 } : { leg: e.leg, p: e.p, v: e.v, d: e.d };

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: process.env.TEST_LOG ? { level: 'error' } : false });
  await app.ready();
});
test.after(async () => { await app.close(); await pool.end(); });

test('демо NDL: сетки частями, средний набор, мишени, номера; этап в квалификации', async () => {
  const list = ok(await call(null, 'GET', '/api/tournaments?q=NDL')).tournaments;
  const live = list.find(t => t.stage === null && t.split === 8), q = list.find(t => t.stage === 'qual');
  assert.ok(live && q, 'оба демо-этапа');
  assert.equal(q.progress.total, 20);
  assert.equal(q.progress.done, 12);
  const t = ok(await call(null, 'GET', '/api/tournaments/' + live.id)).tournament;
  assert.equal(t.block, 8);
  assert.equal(t.slots.length, 24);
  assert.equal(t.games.length, 36);
  assert.deepEqual(t.ex, SCORE);
  const done = t.games.filter(g => g.res);
  assert.equal(done.length, 17);
  done.forEach(g => assert.ok(g.res.avg.every(a => a > 10 && a < 200), 'средний набор в сетке: ' + JSON.stringify(g.res.avg)));
  assert.equal(Object.keys(t.boards.at).length, 6, 'все 6 мишеней заняты готовыми играми');
  assert.equal(t.nums[t.players[0]], 1);
  assert.equal(Object.keys(t.qual.res).length, 20);
  const card = (await call(null, 'GET', '/api/feed?limit=50')).b.items.find(x => x.type === 'match' && x.match.tid === t.id);
  assert.ok(card, 'матчи упражнений есть в ленте');
  assert.deepEqual(card.match.ex, SCORE);
  assert.equal(card.match.pl[0].sc.length, card.match.pl[0].legs + card.match.pl[1].legs);
});

let A, X, tid, tour;
test('создание NDL: квалификация, ввод результата организатором, права', async () => {
  A = await login(ME); X = await login('p9');
  const ids = [ME, 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'];
  err(await call(A, 'POST', '/api/tournaments', { name: 'x', format: 'ko', ltw: 2, ex: SCORE, qual: { ex: SCORE }, players: ids }), 400);
  err(await call(A, 'POST', '/api/tournaments', { name: 'x', format: 'pl', ltw: 2, ex: SCORE, qual: { ex: { k: 'cricket' } }, players: ids }), 400);
  err(await call(A, 'POST', '/api/tournaments', { name: 'x', format: 'pl', ltw: 2, ex: { k: 'golf' }, players: ids }), 400);
  tour = ok(await call(A, 'POST', '/api/tournaments', { name: 'NDL тест', city: 'Новоуральск', format: 'pl', ltw: 2, ex: SCORE, qual: { ex: SCORE, tries: 2 }, players: ids }), 201).tournament;
  tid = tour.id;
  assert.equal(tour.stage, 'qual');
  assert.equal(tour.split, 8);
  assert.deepEqual(tour.games, []);
  assert.deepEqual(tour.players, ids, 'до квалификации порядок как прислали');
  assert.deepEqual(tour.qual, { ex: SCORE, tries: 2, res: {} });
  err(await call(X, 'PUT', '/api/tournaments/' + tid + '/qual/p1/0', { v: 700 }), 403, 'forbidden');
  err(await call(A, 'PUT', '/api/tournaments/' + tid + '/qual/p1/0', { v: 1801 }), 400);
  err(await call(A, 'PUT', '/api/tournaments/' + tid + '/qual/p1/1', { v: 700 }), 409, 'bad_state');
  err(await call(A, 'PUT', '/api/tournaments/' + tid + '/qual/p1/2', { v: 700 }), 400);
  const vals = { p1: [810, 845], p2: [790], p3: [600, 905], p4: [500], p5: [640], p6: [620, 630], p7: [580], p8: [700] };
  for (const [pid, vs] of Object.entries(vals)) for (const [k, v] of vs.entries()) tour = ok(await call(A, 'PUT', '/api/tournaments/' + tid + '/qual/' + pid + '/' + k, { v })).tournament;
  assert.deepEqual(tour.qual.res.p3.map(x => x.v), [600, 905]);
  // удалить попытку и следующие
  tour = ok(await call(A, 'DELETE', '/api/tournaments/' + tid + '/qual/p6/0')).tournament;
  assert.equal(tour.qual.res.p6, undefined);
  tour = ok(await call(A, 'PUT', '/api/tournaments/' + tid + '/qual/p6/0', { v: 620 })).tournament;
});

test('попытка квалификации в счётчике: 10 подходов, результат в таблицу; повтор и чужие запрещены', async () => {
  const id = mid();
  err(await call(X, 'PUT', '/api/matches/' + id, { tournamentId: tid, qual: { playerId: 'p1', try: 1 } }), 403, 'forbidden');
  err(await call(A, 'PUT', '/api/matches/' + id, { tournamentId: tid, qual: { playerId: 'p1', try: 0 } }), 409, 'game_taken');
  const m = ok(await call(A, 'PUT', '/api/matches/' + id, { tournamentId: tid, qual: { playerId: ME, try: 0 } }), 201).match;
  assert.deepEqual(m.q, { id: ME, k: 0 });
  assert.deepEqual(m.ex, SCORE);
  assert.equal(m.ltw, 1);
  // идёт попытка — видно в турнире и на табло
  const t1 = ok(await call(null, 'GET', '/api/tournaments/' + tid)).tournament;
  assert.equal(t1.live['q:' + ME + ':0'], id);
  const snap = ok(await call(null, 'GET', '/api/tournaments/' + tid + '/live'));
  assert.deepEqual(snap.matches[0].q, { id: ME, k: 0 });
  err(await call(A, 'POST', '/api/matches/' + id + '/events', { events: [{ seq: 1, type: 'visit', leg: 1, p: 0, v: 179, d: null }] }), 422, 'bad_event');
  const pts = [100, 60, 85, 140, 45, 81, 100, 26, 180, 28];
  const evs = legEvents(1, 0, [pts], 1);
  evs.push(finishOf(m, evs.map(asVisit), 11));
  // строка с неверной суммой не принимается
  const bad = JSON.parse(JSON.stringify(evs));
  bad[10].pl[0].pts = 900;
  err(await call(A, 'POST', '/api/matches/' + id + '/events', { events: bad }), 422, 'bad_event');
  ok(await call(A, 'POST', '/api/matches/' + id + '/events', { events: evs }));
  const t = ok(await call(null, 'GET', '/api/tournaments/' + tid)).tournament;
  assert.equal(t.qual.res[ME][0].v, 845);
  assert.equal(t.qual.res[ME][0].mid, id);
  err(await call(A, 'PUT', '/api/tournaments/' + tid + '/qual/' + ME + '/0', { v: 900 }), 409, 'game_taken');
  const card = ok(await call(null, 'GET', '/api/matches/' + id)).match.card;
  assert.equal(card.label, 'квалификация · попытка 1');
  assert.deepEqual(card.pl[0].sc, [845]);
  // попытки квалификации не в ленте
  assert.ok(!ok(await call(null, 'GET', '/api/feed?limit=50')).items.some(x => x.type === 'match' && x.match.id === id));
  // отмена завершения снимает результат, повторное завершение возвращает
  ok(await call(A, 'POST', '/api/matches/' + id + '/reopen'));
  assert.equal(ok(await call(null, 'GET', '/api/tournaments/' + tid)).tournament.qual.res[ME], undefined);
  const again = finishOf(m, evs.slice(0, 10).map(asVisit), 13);
  ok(await call(A, 'POST', '/api/matches/' + id + '/events', { events: [again] }));
  assert.equal(ok(await call(null, 'GET', '/api/tournaments/' + tid)).tournament.qual.res[ME][0].v, 845);
});

test('закрытие квалификации: посев по лучшему результату, сетки по 8, номера', async () => {
  err(await call(X, 'POST', '/api/tournaments/' + tid + '/qual/close'), 403, 'forbidden');
  // идущая попытка мешает закрыть
  const id = mid();
  ok(await call(A, 'PUT', '/api/matches/' + id, { tournamentId: tid, qual: { playerId: 'p2', try: 1 } }), 201);
  err(await call(A, 'POST', '/api/tournaments/' + tid + '/qual/close'), 409, 'bad_state');
  ok(await call(A, 'DELETE', '/api/matches/' + id));
  const t = ok(await call(A, 'POST', '/api/tournaments/' + tid + '/qual/close')).tournament;
  assert.equal(t.stage, undefined);
  // лучшие: p3 905, p1 845, ME 845 (вторая попытка у p1 решает), p2 790, p8 700, p5 640, p6 620, p7 580, p4 500, p9 —
  assert.deepEqual(t.players, ['p3', 'p1', ME, 'p2', 'p8', 'p5', 'p6', 'p7', 'p4', 'p9']);
  assert.equal(t.block, 8);
  assert.equal(t.slots.length, 16);
  assert.equal(t.nums.p3, 1);
  assert.equal(t.nums.p9, 10);
  assert.equal(t.games.length, 24);
  const rv = B.resolver(t);
  assert.deepEqual(rv.players(0, 0), ['p3', 'p7'], 'первый против восьмого');
  assert.deepEqual(rv.players(0, 4), ['p4', B.BYE], 'девятый — в нижней части, соперника нет');
  err(await call(A, 'POST', '/api/tournaments/' + tid + '/qual/close'), 409, 'bad_state');
  err(await call(A, 'PUT', '/api/tournaments/' + tid + '/qual/p9/0', { v: 500 }), 409, 'bad_state');
  tour = t;
});

test('мишени и номера: организатор задаёт, готовые игры получают свободные', async () => {
  err(await call(X, 'PATCH', '/api/tournaments/' + tid + '/boards', { n: 3 }), 403, 'forbidden');
  let t = ok(await call(A, 'PATCH', '/api/tournaments/' + tid + '/boards', { n: 3 })).tournament;
  assert.deepEqual(t.boards, { n: 3, at: { '0:0': 1, '0:1': 2, '0:2': 3 } });
  t = ok(await call(A, 'PATCH', '/api/tournaments/' + tid + '/boards', { r: 0, i: 3, board: 1 })).tournament;
  assert.equal(t.boards.at['0:3'], 1);
  assert.equal(t.boards.at['0:0'], undefined, 'мишень 1 ушла к другой игре, свободной нет');
  err(await call(A, 'PATCH', '/api/tournaments/' + tid + '/boards', { r: 1, i: 0, board: 2 }), 409, 'bad_state');
  t = ok(await call(A, 'PATCH', '/api/tournaments/' + tid + '/nums', { nums: { p9: 99 } })).tournament;
  assert.equal(t.nums.p9, 99);
  assert.equal(t.nums.p3, 1);
  err(await call(A, 'PATCH', '/api/tournaments/' + tid + '/nums', { nums: { p17x: 1 } }), 400);
  err(await call(A, 'PATCH', '/api/tournaments/' + tid + '/nums', { nums: { p9: 0 } }), 400);
  tour = t;
});

test('матч сетки «Набор очков» до 2 побед: ничья в леге решается буллом, мишень освобождается', async () => {
  const id = mid(), [a, b] = B.resolver(tour).players(0, 3);
  const m = ok(await call(A, 'PUT', '/api/matches/' + id, { tournamentId: tid, r: 0, i: 3, starter: 0 }), 201).match;
  assert.deepEqual(m.ex, SCORE);
  assert.deepEqual(m.players.map(p => p.id), [a, b]);
  const L = (n, v) => Array(n).fill(v);
  // лег 1: 1000 : 600; лег 2 (начинает второй): 500 : 500 — ничья, булл у первого
  const leg1 = legEvents(1, 0, [L(10, 100), L(10, 60)], 1);
  err(await call(A, 'POST', '/api/matches/' + id + '/events', { events: [{ seq: 1, type: 'bull', leg: 1, p: 0 }] }), 422, 'bad_event');
  ok(await call(A, 'POST', '/api/matches/' + id + '/events', { events: leg1 }));
  let live = ok(await call(null, 'GET', '/api/matches/' + id)).match;
  assert.deepEqual(live.legs, [1, 0]);
  assert.equal(live.state.leg, 2);
  assert.equal(live.state.cur, 1);
  assert.deepEqual(live.state.vis, [0, 0]);
  const leg2 = legEvents(2, 1, [L(10, 50), L(10, 50)], 21);
  ok(await call(A, 'POST', '/api/matches/' + id + '/events', { events: leg2 }));
  live = ok(await call(null, 'GET', '/api/matches/' + id)).match;
  assert.deepEqual(live.state.tie, [0, 1]);
  assert.equal(live.state.cur, null);
  err(await call(A, 'POST', '/api/matches/' + id + '/events', { events: [{ seq: 41, type: 'visit', leg: 2, p: 1, v: 60, d: null }] }), 422, 'bad_event');
  const bull = { seq: 41, type: 'bull', leg: 2, p: 0 };
  const visits = leg1.concat(leg2, [bull]).map(asVisit);
  ok(await call(A, 'POST', '/api/matches/' + id + '/events', { events: [bull, finishOf(m, visits, 42)] }));
  const t = ok(await call(null, 'GET', '/api/tournaments/' + tid)).tournament, g = t.games.find(x => x.r === 0 && x.i === 3);
  assert.deepEqual([g.res.la, g.res.lb, g.res.w], [2, 0, a]);
  assert.deepEqual(g.res.avg, [75, 55], 'средний набор за подход: 1500 и 1100 очков за 20 подходов');
  assert.equal(t.boards.at['0:3'], undefined, 'сыгранная игра освободила мишень');
  assert.equal(t.boards.at['0:0'], 1, 'мишень 1 перешла к ждущей игре');
  const card = ok(await call(null, 'GET', '/api/matches/' + id)).match.card;
  assert.deepEqual(card.pl.map(l => l.sc), [[1000, 500], [600, 500]]);
});

test('дружеский крикет и сектор: метки дротиков, статистика x01 не меняется', async () => {
  const before = ok(await call(null, 'GET', '/api/players/' + ME)).stats.all;
  const id = mid();
  err(await call(A, 'PUT', '/api/matches/' + id, { ex: { k: 'golf' }, ltw: 1, players: [{ id: ME }, { name: 'Гость' }] }), 400);
  const m = ok(await call(A, 'PUT', '/api/matches/' + id, { ex: { k: 'cricket', lim: 0 }, ltw: 1, players: [{ id: ME }, { name: 'Гость' }] }), 201).match;
  const v = (seqNo, p, d) => ({ seq: seqNo, type: 'visit', leg: 1, p, d });
  const evs = [v(1, 0, ['T20', 'T20', 'T19']), v(2, 1, ['0', '0', '0']), v(3, 0, ['T18', 'T17', 'T16']), v(4, 1, ['5', '5', '5'])];
  err(await call(A, 'POST', '/api/matches/' + id + '/events', { events: [v(1, 0, null)] }), 422, 'bad_event');
  err(await call(A, 'POST', '/api/matches/' + id + '/events', { events: [v(1, 0, ['T20'])] }), 422, 'bad_event');
  evs.push(v(5, 0, ['T15', 'Bull', '25']));
  evs.push(finishOf(m, evs.map(e => ({ leg: 1, p: e.p, d: e.d })), 6));
  ok(await call(A, 'POST', '/api/matches/' + id + '/events', { events: evs }));
  const done = ok(await call(null, 'GET', '/api/matches/' + id)).match;
  assert.equal(done.status, 'done');
  assert.equal(done.state.scores[0], 60);
  assert.equal(done.card.pl[0].pts, 24, 'у крикета в строке — метки');
  const after = ok(await call(null, 'GET', '/api/players/' + ME)).stats.all;
  assert.equal(after.n, before.n + 1);
  assert.equal(after.darts, before.darts, 'дротики упражнения не входят в средний x01');
  assert.equal(after.avg, before.avg);
  // 501 с лимитом 10 подходов: меньший остаток выигрывает
  const id2 = mid();
  const m2 = ok(await call(A, 'PUT', '/api/matches/' + id2, { ex: { k: 'x01', mode: 501, lim: 10 }, ltw: 1, players: [{ id: ME }, { name: 'Гость' }] }), 201).match;
  assert.deepEqual(m2.ex, { k: 'x01', mode: 501, dbl: true, lim: 10 });
  const sc = [501, 501], ev2 = [];
  for (let k = 0; k < 20; k++) { const p = k % 2, pts = p ? 40 : 45; ev2.push({ seq: k + 1, type: 'visit', leg: 1, p, s: sc[p], pts, n: 3, b: 0, d: null }); sc[p] -= pts; }
  const st = Games.state({ ex: m2.ex, np: 2, ltw: 1, starter: 0 }, ev2.map(e => ({ leg: 1, p: e.p, s: e.s, pts: e.pts, n: 3, b: 0 })));
  ev2.push({ seq: 21, type: 'finish', w: st.winner, pl: [{ id: ME, legs: 1, pts: 450, darts: 30 }, { id: null, legs: 0, pts: 400, darts: 30 }] });
  ok(await call(A, 'POST', '/api/matches/' + id2 + '/events', { events: ev2 }));
  const d2 = ok(await call(null, 'GET', '/api/matches/' + id2)).match;
  assert.deepEqual(d2.state.scores, [51, 101]);
  assert.equal(d2.w, 0);
});
