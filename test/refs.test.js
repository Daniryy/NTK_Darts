// Судьи: главный судья турнира, список судей, кто судит матч, раздача по очереди.
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
const dev = () => 'device_ref_' + String(++seq).padStart(8, '0');
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


test('судьи: главный и список — организатор; матчам — после старта, из списка; по очереди — без своих матчей', async () => {
  const t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Судьи', format: 'ko', mode: 501, ltw: 1, reg: true, cap: 8, players: ['p6', 'p7', 'p8', 'p9'] }), 201).tournament;
  const U = '/api/tournaments/' + t.id + '/refs';
  err(await call(PL, 'PATCH', U, { chief: { name: 'Петров П.' } }), 403);
  let r = ok(await call(HOST, 'PATCH', U, { chief: { name: 'Петров Пётр', city: 'Москва' }, pool: ['Иванов И.', 'Сидоров С.', 'Иванов И.'] })).tournament.refs;
  assert.deepEqual(r, { chief: { name: 'Петров Пётр', city: 'Москва' }, pool: ['Иванов И.', 'Сидоров С.'], at: {} });
  err(await call(HOST, 'PATCH', U, { r: 0, i: 0, ref: 'Иванов И.' }), 409, 'bad_state'); // до старта
  ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/launch'));
  err(await call(HOST, 'PATCH', U, { r: 0, i: 0, ref: 'Кто-то' }), 400);
  r = ok(await call(HOST, 'PATCH', U, { r: 0, i: 0, ref: 'Сидоров С.' })).tournament.refs;
  assert.equal(r.at['0:0'], 'Сидоров С.');
  r = ok(await call(HOST, 'PATCH', U, { auto: true })).tournament.refs;
  assert.deepEqual(r.at, { '0:0': 'Сидоров С.', '0:1': 'Иванов И.' }); // финал ещё не готов
  // снятый из списка — снимается и с матчей
  r = ok(await call(HOST, 'PATCH', U, { pool: ['Иванов И.'] })).tournament.refs;
  assert.deepEqual(r.at, { '0:1': 'Иванов И.' });
  r = ok(await call(HOST, 'PATCH', U, { r: 0, i: 1, ref: null })).tournament.refs;
  assert.deepEqual(r.at, {});
  // игрок сам себя не судит
  const me = ok(await call(HOST, 'GET', '/api/tournaments/' + t.id)).tournament;
  const g = me.games.find(x => x.r === 0 && x.i === 0), nm = me.roster[me.slots[0]].name;
  r = ok(await call(HOST, 'PATCH', U, { pool: [nm] })).tournament.refs;
  r = ok(await call(HOST, 'PATCH', U, { auto: true })).tournament.refs;
  assert.equal(r.at['0:0'], undefined); assert.equal(r.at['0:1'], nm);
  assert.ok(g);
  // всё убрали — поле пустое
  assert.equal(ok(await call(HOST, 'PATCH', U, { chief: null, pool: [] })).tournament.refs, undefined);
});
