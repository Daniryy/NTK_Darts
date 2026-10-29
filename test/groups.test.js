// Групповой этап: «Стандарт» (группы + сетка), «Лига» (одна группа + сетка), «Комплексный» (квалификация + группы + сетка).
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed } = require('../db/seed');
const { clearCache } = require('../server/auth');

let app, seq = 0;
const dev = () => 'device_grp_' + String(++seq).padStart(8, '0');
const anon = () => ({ dev: dev(), cookie: '' });
async function call(u, method, url, body) {
  const headers = {};
  if (u) { headers['x-device-id'] = u.dev; if (u.cookie) headers.cookie = u.cookie; }
  const r = await app.inject({ method, url, payload: body, headers });
  const sid = r.cookies.find(c => c.name === 'oche_sid');
  if (u && sid) u.cookie = 'oche_sid=' + sid.value;
  return { s: r.statusCode, b: r.body ? JSON.parse(r.body) : null };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
const err = (r, code, ecode) => { assert.equal(r.s, code, JSON.stringify(r.b)); if (ecode) assert.equal(r.b.error.code, ecode); return r.b.error; };
async function login(playerId) { const u = anon(); ok(await call(u, 'POST', '/api/auth/dev', { playerId })); return u; }

let HOST, PL, ADMIN;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  HOST = await login('p1'); PL = await login('p6'); ADMIN = await login('p4');
});
test.after(async () => { await app.close(); await pool.end(); });

const B = require('../shared/bracket.js');

test('группы змейкой, матчи групп, таблица и выход в сетку', () => {
  assert.deepEqual(B.drawGroups(['1', '2', '3', '4', '5', '6', '7', '8'], 2), [['1', '4', '5', '8'], ['2', '3', '6', '7']]);
  const gs = B.groupGames([['a', 'b', 'c', 'd'], ['e', 'f', 'g']]);
  assert.equal(gs.length, 6 + 3);
  assert.ok(gs.every((g, k) => k === 0 || gs[k - 1].r < g.r || gs[k - 1].i + 1 === g.i));
  // a выиграл всё, b — у c и d, c — у d
  const win = { a: 3, b: 2, c: 1, d: 0 };
  gs.filter(g => g.grp === 0).forEach(g => { const w = win[g.a] > win[g.b] ? g.a : g.b; g.res = { la: w === g.a ? 1 : 0, lb: w === g.b ? 1 : 0, w }; });
  assert.deepEqual(B.table(['a', 'b', 'c', 'd'], gs.filter(g => g.grp === 0)).map(x => x.id), ['a', 'b', 'c', 'd']);
});

async function playAll(t, u) {
  for (let k = 0; k < 40; k++) {
    const g = t.games.find(x => B.gameState(t, x).st === 'ready');
    if (!g) return t;
    t = ok(await call(u, 'POST', '/api/tournaments/' + t.id + '/games/' + g.r + '/' + g.i + '/result', { la: 1, lb: 0 })).tournament;
  }
  return t;
}

test('«Стандарт»: 2 группы по 4, выходят по двое, сетка ko, места невышедших', async () => {
  const ids = ['p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13'];
  err(await call(HOST, 'POST', '/api/tournaments', { name: 'x', format: 'rr', mode: 501, ltw: 1, players: ids, groups: { n: 2, adv: 2 } }), 400);
  err(await call(HOST, 'POST', '/api/tournaments', { name: 'x', format: 'ko', mode: 501, ltw: 1, players: ids, groups: { n: 4, adv: 2 } }), 409); // по 2 в группе, выходят 2
  let t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Стандарт', format: 'ko', mode: 501, ltw: 1, players: ids, groups: { n: 2, adv: 2 }, ltwBy: { groups: 1, f: 2 } }), 201).tournament;
  assert.equal(t.stage, 'groups');
  assert.equal(t.status, 'live');
  assert.equal(t.groups.ids.length, 2);
  assert.equal(t.games.length, 12);
  assert.ok(t.games.every(g => g.grp != null));
  err(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/groups/close'), 409);
  t = await playAll(t, HOST);
  assert.equal(t.status, 'live', 'группы сыграны, но впереди сетка');
  err(await call(PL, 'POST', '/api/tournaments/' + t.id + '/groups/close'), 403);
  t = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/groups/close')).tournament;
  assert.equal(t.stage, undefined);
  assert.equal(t.groups.done, true);
  assert.equal(t.groups.games.filter(g => g.res).length, 12, 'результаты групп остались');
  assert.equal(t.slots.length, 4);
  // 1A — 2B и 2A — 1B: первые места групп по разные стороны
  const tabs = t.groups.ids.map((g, k) => B.table(g, t.groups.games.filter(x => x.grp === k)));
  assert.deepEqual(t.slots, [tabs[0][0].id, tabs[1][1].id, tabs[0][1].id, tabs[1][0].id]);
  // финал — до 2: быстрый счёт 1:0 не годится
  for (const i of [0, 1]) ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/0/' + i + '/result', { la: 1, lb: 0 }));
  err(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/1/0/result', { la: 1, lb: 0 }), 400);
  t = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/1/0/result', { la: 2, lb: 1 })).tournament;
  assert.equal(t.status, 'done');
  const pl = (await pool.query('SELECT player_id, place_lo, place_hi FROM entries WHERE tournament_id = $1 ORDER BY place_lo, player_id', [t.id])).rows;
  assert.deepEqual(pl.map(x => [x.place_lo, x.place_hi]), [[1, 1], [2, 2], [3, 4], [3, 4], [5, 6], [5, 6], [7, 8], [7, 8]]);
  // третьи места групп — 5–6
  assert.deepEqual(pl.filter(x => x.place_lo === 5).map(x => x.player_id).sort(), [tabs[0][2].id, tabs[1][2].id].sort());
});

test('«Лига»: одна группа, выходят четверо — полуфиналы', async () => {
  let t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Лига', format: 'ko', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8', 'p9', 'p10'], groups: { n: 1, adv: 4 } }), 201).tournament;
  assert.equal(t.games.length, 10);
  t = await playAll(t, HOST);
  t = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/groups/close')).tournament;
  assert.equal(t.slots.length, 4);
  t = await playAll(t, HOST);
  assert.equal(t.status, 'done');
});

test('«Комплексный»: квалификация → группы → сетка', async () => {
  const SCORE = { k: 'score', lim: 3 }, ids = ['p6', 'p7', 'p8', 'p9', 'p10', 'p11'];
  let t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Комплексный', format: 'pl', mode: 501, ltw: 1, qual: { ex: SCORE, tries: 1 }, groups: { n: 2, adv: 2 }, players: ids }), 201).tournament;
  assert.equal(t.stage, 'qual');
  assert.equal(t.split, undefined, 'с группами сетка частями не делится');
  for (const [k, id] of ids.entries()) t = ok(await call(HOST, 'PUT', '/api/tournaments/' + t.id + '/qual/' + id + '/0', { v: 100 + k })).tournament;
  t = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/qual/close')).tournament;
  assert.equal(t.stage, 'groups');
  // змейка по итогам квалификации: лучший (p11) — в A, второй (p10) — в B
  assert.equal(t.groups.ids[0][0], 'p11'); assert.equal(t.groups.ids[1][0], 'p10');
  t = await playAll(t, HOST);
  t = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/groups/close')).tournament;
  t = await playAll(t, HOST);
  assert.equal(t.status, 'done');
});
