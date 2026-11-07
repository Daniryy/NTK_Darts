// Автоматизация: квалификация и группы закрываются сами, когда всё сыграно (квалификация — без равенства);
// судьи встают на готовые игры сами, если организатор включил «автоматически».
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed } = require('../db/seed');

let app, seq = 0;
const anon = () => ({ dev: 'device_auto_' + String(++seq).padStart(8, '0'), cookie: '' });
async function call(u, method, url, body) {
  const headers = {};
  if (u) { headers['x-device-id'] = u.dev; if (u.cookie) headers.cookie = u.cookie; }
  const r = await app.inject({ method, url, payload: body, headers });
  const sid = r.cookies.find(c => c.name === 'oche_sid');
  if (u && sid) u.cookie = 'oche_sid=' + sid.value;
  return { s: r.statusCode, b: r.body ? JSON.parse(r.body) : null };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
async function login(playerId) { const u = anon(); ok(await call(u, 'POST', '/api/auth/dev', { playerId })); return u; }

let HOST;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  HOST = await login('p1');
});
test.after(async () => { await app.close(); await pool.end(); });

test('квалификация закрывается сама; при равенстве — после перестрелки', async () => {
  const ids = ['p6', 'p7', 'p8', 'p9'], url = id => '/api/tournaments/' + t.id + '/qual/' + id;
  let t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Авто', format: 'ko', mode: 501, ltw: 1, qual: { ex: { k: 'score', lim: 3 }, tries: 1 }, players: ids }), 201).tournament;
  for (const [id, v] of [['p6', 500], ['p7', 500], ['p8', 400]]) t = ok(await call(HOST, 'PUT', url(id) + '/0', { v })).tournament;
  assert.equal(t.stage, 'qual', 'сдали не все');
  t = ok(await call(HOST, 'PUT', url('p9') + '/0', { v: 300 })).tournament;
  assert.equal(t.stage, 'qual', 'равенство p6 и p7 — ждём перестрелку');
  t = ok(await call(HOST, 'PUT', url('p6') + '/tb', { v: 2 })).tournament;
  assert.equal(t.stage, 'qual');
  t = ok(await call(HOST, 'PUT', url('p7') + '/tb', { v: 1 })).tournament;
  assert.equal(t.stage, undefined, 'перестрелка решила — сетка построена');
  assert.deepEqual(t.players, ['p6', 'p7', 'p8', 'p9']);
});

test('судьи автоматически: на готовые игры сразу и на новые после результата; выключили — больше не ставятся', async () => {
  let t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Судьи сами', format: 'ko', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13'] }), 201).tournament;
  const refs = '/api/tournaments/' + t.id + '/refs';
  ok(await call(HOST, 'PATCH', refs, { pool: ['Иванов И.', 'Петров П.'] }));
  t = ok(await call(HOST, 'PATCH', refs, { auto: true })).tournament;
  assert.equal(t.refs.auto, true);
  assert.deepEqual(Object.keys(t.refs.at).sort(), ['0:0', '0:1', '0:2', '0:3']);
  // по очереди: у каждого по два матча
  assert.deepEqual(Object.values(t.refs.at).sort(), ['Иванов И.', 'Иванов И.', 'Петров П.', 'Петров П.']);
  for (const i of [0, 1]) t = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/0/' + i + '/result', { la: 1, lb: 0 })).tournament;
  assert.ok(t.refs.at['1:0'], 'полуфинал получил судью сам');
  t = ok(await call(HOST, 'PATCH', refs, { auto: false })).tournament;
  assert.equal(t.refs.auto, undefined);
  for (const i of [2, 3]) t = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/0/' + i + '/result', { la: 1, lb: 0 })).tournament;
  assert.equal(t.refs.at['1:1'], undefined);
});
