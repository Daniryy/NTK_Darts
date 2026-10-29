// Протокол результатов: данные игрока для протокола, шапка, выполненные разряды.
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
const dev = () => 'device_prt_' + String(++seq).padStart(8, '0');
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


test('данные для протокола: сам игрок, ведущий своему аккаунту; заметки видит ведущий', async () => {
  const me = ok(await call(PL, 'PATCH', '/api/me', { lastName: 'Лебедева', firstName: 'Ксения', midName: 'Андреевна', birthYear: 1994, sex: 'f', region: 'Московская область' })).player;
  assert.deepEqual([me.lastName, me.firstName, me.midName, me.birthYear, me.sex, me.region], ['Лебедева', 'Ксения', 'Андреевна', 1994, 'f', 'Московская область']);
  err(await call(PL, 'PATCH', '/api/me', { region: 'Марс' }), 400);
  err(await call(PL, 'PATCH', '/api/me', { birthYear: 1800 }), 400);
  err(await call(PL, 'PATCH', '/api/me', { sex: 'x' }), 400);
  const g = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Пётр Сидоров' }), 201).player;
  const a = ok(await call(HOST, 'PATCH', '/api/admin/players/' + g.id, { lastName: 'Сидоров', firstName: 'Пётр', birthYear: 1950, sex: 'm', note: 'плохо видит' })).player;
  assert.equal(a.note, 'плохо видит'); assert.equal(a.birthYear, 1950);
  // в общем профиле год рождения и заметки не видны
  const pub = ok(await call(null, 'GET', '/api/players/' + g.id)).player;
  assert.equal(pub.birthYear, undefined); assert.equal(pub.note, undefined);
});

test('протокол: места и данные игроков организатору, шапка и разряды', async () => {
  const ids = ['p6', 'p7', 'p8', 'p9'];
  let t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Протокол', format: 'ko', mode: 501, ltw: 1, players: ids }), 201).tournament;
  for (const [r, i] of [[0, 0], [0, 1], [1, 0]]) t = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/' + r + '/' + i + '/result', { la: 1, lb: 0 })).tournament;
  assert.equal(t.status, 'done');
  err(await call(PL, 'GET', '/api/tournaments/' + t.id + '/protocol'), 403);
  ok(await call(HOST, 'PATCH', '/api/tournaments/' + t.id + '/refs', { chief: { name: 'Петров Пётр Петрович', city: 'Москва' } }));
  let p = ok(await call(HOST, 'GET', '/api/tournaments/' + t.id + '/protocol'));
  assert.equal(p.chief.name, 'Петров Пётр Петрович');
  assert.deepEqual(p.rows.map(x => [x.lo, x.hi]), [[1, 1], [2, 2], [3, 4], [3, 4]]);
  const k = p.rows.find(x => x.id === 'p6');
  assert.equal(k.lastName, 'Лебедева'); assert.equal(k.birthYear, 1994); assert.equal(k.region, 'Московская область');
  // субъект по городу, если не указан
  assert.ok(p.rows.filter(x => x.id !== 'p6').every(x => typeof x.region === 'string'));
  err(await call(HOST, 'PATCH', '/api/tournaments/' + t.id + '/protocol', { done: { p99: 'КМС' } }), 400);
  const pr = ok(await call(HOST, 'PATCH', '/api/tournaments/' + t.id + '/protocol', { league: 'Лига московского дартса', tour: '1 тур', about: 'Клуб «Оче»', done: { p6: 'КМС', p7: '' } })).proto;
  assert.deepEqual(pr, { league: 'Лига московского дартса', tour: '1 тур', about: 'Клуб «Оче»', done: { p6: 'КМС' } });
  p = ok(await call(HOST, 'GET', '/api/tournaments/' + t.id + '/protocol'));
  assert.equal(p.proto.done.p6, 'КМС');
});
