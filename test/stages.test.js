// До скольких побед по стадиям сетки: финал, полуфинал, четвертьфинал, ранние круги, матчи за места.
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
const dev = () => 'device_stg_' + String(++seq).padStart(8, '0');
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

test('стадии сетки: ko и pl', () => {
  const ko = { format: 'ko', players: Array(8).fill('x'), ltw: 1, ltwBy: { f: 5, sf: 3 } };
  assert.deepEqual([0, 1, 2].map(r => B.stageOf(ko, r, 0)), ['qf', 'sf', 'f']);
  assert.deepEqual([0, 1, 2].map(r => B.ltwOf(ko, r, 0)), [1, 3, 5]);
  const big = { format: 'ko', players: Array(32).fill('x'), ltw: 2 };
  assert.deepEqual([0, 1, 2, 3, 4].map(r => B.stageOf(big, r, 0)), ['early', 'early', 'qf', 'sf', 'f']);
  // pl на 8: в круге 2 группа победителей — полуфинал, проигравших — за места; финал и матч за 3-е место
  const pl = { format: 'pl', players: Array(8).fill('x'), ltw: 2, ltwBy: { f: 4, places: 1 } };
  assert.equal(B.stageOf(pl, 0, 3), 'qf');
  assert.deepEqual([0, 1, 2, 3].map(i => B.stageOf(pl, 1, i)), ['sf', 'sf', 'places', 'places']);
  assert.equal(B.stageOf(pl, 2, 0), 'f');
  assert.equal(B.ltwOf(pl, 2, 0), 4);
  assert.equal(B.ltwOf(pl, 2, 1), 1);
  assert.equal(B.ltwOf(pl, 1, 0), 2); // полуфинал не задан — общее
  assert.equal(B.stageOf({ format: 'rr', players: ['a', 'b', 'c'], ltw: 3 }, 0, 0), null);
});

test('турнир: ltwBy при создании и после старта, матч и быстрый счёт берут лег стадии', async () => {
  err(await call(HOST, 'POST', '/api/tournaments', { name: 'x', format: 'ko', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8', 'p9'], ltwBy: { semi: 2 } }), 400);
  err(await call(HOST, 'POST', '/api/tournaments', { name: 'x', format: 'ko', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8', 'p9'], ltwBy: { f: 12 } }), 400);
  const t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Стадии', format: 'ko', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8', 'p9'], ltwBy: { f: 3, sf: null } }), 201).tournament;
  assert.deepEqual(t.ltwBy, { f: 3 });
  // полуфиналы — до 1 победы
  for (const i of [0, 1]) ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/0/' + i + '/result', { la: 1, lb: 0 }));
  // финал — до 3: 1:0 не годится
  err(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/1/0/result', { la: 1, lb: 0 }), 400);
  // после старта ведущий меняет финал на «до 2»; другие настройки — нет
  err(await call(HOST, 'PATCH', '/api/tournaments/' + t.id, { name: 'Другое' }), 409, 'bad_state');
  err(await call(PL, 'PATCH', '/api/tournaments/' + t.id, { ltwBy: { f: 2 } }), 403);
  assert.deepEqual(ok(await call(HOST, 'PATCH', '/api/tournaments/' + t.id, { ltwBy: { f: 2 } })).tournament.ltwBy, { f: 2 });
  // финал в счётчике: матч создаётся с ltw стадии
  const m = ok(await call(HOST, 'PUT', '/api/matches/g' + 'stagefinal00000001', { tournamentId: t.id, r: 1, i: 0 }), 201);
  assert.equal((m.match || m).ltw, 2);
  // общее «до скольких» — до 11
  ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Сильные', format: 'ko', mode: 501, ltw: 7, players: ['p6', 'p7', 'p8', 'p9'] }), 201);
});
