// Вход администраторов по паролю, лимиты по IP, права ролей, журнал, карточка игрока.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');
const { hashPassword } = require('../server/password');
const limits = require('../server/limits');

let app, seq = 0;
const anon = () => ({ dev: 'device_adm_' + String(++seq).padStart(10, '0'), cookie: '' });
async function call(u, method, url, body) {
  const headers = {};
  if (u) { headers['x-device-id'] = u.dev; if (u.cookie) headers.cookie = u.cookie; }
  const r = await app.inject({ method, url, payload: body, headers });
  const sid = r.cookies.find(c => c.name === 'oche_sid');
  if (u && sid) u.cookie = 'oche_sid=' + sid.value;
  return { s: r.statusCode, b: r.body ? JSON.parse(r.body) : null, h: r.headers };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
const err = (r, code, ecode) => { assert.equal(r.s, code, JSON.stringify(r.b)); if (ecode) assert.equal(r.b.error.code, ecode); return r.b.error; };
async function login(playerId) { const u = anon(); ok(await call(u, 'POST', '/api/auth/dev', { playerId })); return u; }

let TECH, ADMIN, HOST, PL;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  await pool.query(`UPDATE players SET login = 'danil', pass_hash = $1 WHERE id = $2`, [await hashPassword('Darts-Secret-1'), ME]);
  app = build({ logger: false });
  await app.ready();
  TECH = await login(ME); ADMIN = await login('p4'); HOST = await login('p1'); PL = await login('p6');
});
test.after(async () => { await app.close(); await pool.end(); });
test.beforeEach(() => limits.reset());

test('вход по логину и паролю: верный, неверный, блокировка после 5 ошибок, не администратор', async () => {
  const u = anon();
  err(await call(u, 'POST', '/api/auth/password', { login: 'danil', password: 'wrong-password' }), 409, 'bad_login');
  err(await call(u, 'POST', '/api/auth/password', { login: 'nobody', password: 'Darts-Secret-1' }), 409, 'bad_login');
  const r = ok(await call(u, 'POST', '/api/auth/password', { login: ' DANIL ', password: 'Darts-Secret-1' }));
  assert.equal(r.player.id, ME);
  assert.equal(r.role, 'tech');
  assert.ok(r.perms.includes('banners') && r.perms.includes('audit'));
  assert.equal(r.player.login, 'danil');
  assert.equal(ok(await call(u, 'GET', '/api/me')).player.id, ME);
  // 5 неверных — вход по логину закрыт даже с верным паролем
  for (let k = 0; k < 5; k++) err(await call(anon(), 'POST', '/api/auth/password', { login: 'danil', password: 'nope-nope-' + k }), 409, 'bad_login');
  limits.reset();
  const lk = err(await call(anon(), 'POST', '/api/auth/password', { login: 'danil', password: 'Darts-Secret-1' }), 429, 'too_many');
  assert.ok(lk.retryAfter > 0);
  await pool.query('UPDATE players SET pass_lock_until = NULL, pass_fails = 0 WHERE id = $1', [ME]);
  ok(await call(anon(), 'POST', '/api/auth/password', { login: 'danil', password: 'Darts-Secret-1' }));
  // роль ниже администратора — пароль не пускает
  await pool.query(`UPDATE players SET login = 'host1', pass_hash = $1 WHERE id = 'p1'`, [await hashPassword('Host-Secret-1')]);
  err(await call(anon(), 'POST', '/api/auth/password', { login: 'host1', password: 'Host-Secret-1' }), 403);
  await pool.query(`UPDATE players SET login = NULL, pass_hash = NULL WHERE id = 'p1'`);
  // вход записан в журнал
  assert.ok(ok(await call(TECH, 'GET', '/api/admin/audit?target=' + ME)).items.some(x => x.action === 'login.password'));
});

test('подбор с разных устройств упирается в лимит по IP', async () => {
  for (let k = 0; k < 10; k++) await call(anon(), 'POST', '/api/auth/password', { login: 'x' + k, password: 'whatever-123' });
  const e = err(await call(anon(), 'POST', '/api/auth/password', { login: 'danil', password: 'Darts-Secret-1' }), 429, 'too_many');
  assert.ok(e.retryAfter > 0);
  limits.reset();
  for (let k = 0; k < 60; k++) await call(anon(), 'POST', '/api/auth/code', { code: 'ZZZZ' + String(k).padStart(4, 'A') });
  err(await call(anon(), 'POST', '/api/auth/code', { code: 'ZZZZZZZZ' }), 429, 'too_many');
});

test('смена своего пароля', async () => {
  const u = anon();
  ok(await call(u, 'POST', '/api/auth/password', { login: 'danil', password: 'Darts-Secret-1' }));
  err(await call(u, 'PUT', '/api/me/password', { current: 'wrong', password: 'New-Secret-22' }), 409, 'bad_login');
  err(await call(u, 'PUT', '/api/me/password', { current: 'Darts-Secret-1', password: '1234567890123' }), 400);
  err(await call(u, 'PUT', '/api/me/password', { current: 'Darts-Secret-1', password: 'short' }), 400);
  ok(await call(u, 'PUT', '/api/me/password', { current: 'Darts-Secret-1', password: 'New-Secret-22' }));
  ok(await call(anon(), 'POST', '/api/auth/password', { login: 'danil', password: 'New-Secret-22' }));
  err(await call(PL, 'PUT', '/api/me/password', { current: 'x', password: 'New-Secret-22' }), 409);
});

test('логин администратору выдаёт только тех. администратор', async () => {
  err(await call(ADMIN, 'PUT', '/api/admin/players/p4/login', { login: 'customer', password: 'Customer-Pass-1' }), 403);
  err(await call(TECH, 'PUT', '/api/admin/players/p6/login', { login: 'player6', password: 'Player-Pass-11' }), 409, 'conflict');
  err(await call(TECH, 'PUT', '/api/admin/players/p4/login', { login: 'Д', password: 'Customer-Pass-1' }), 400);
  err(await call(TECH, 'PUT', '/api/admin/players/p4/login', { login: 'danil', password: 'Customer-Pass-1' }), 409, 'login_taken');
  assert.equal(ok(await call(TECH, 'PUT', '/api/admin/players/p4/login', { login: 'customer', password: 'Customer-Pass-1' })).player.login, 'customer');
  const u = anon();
  assert.equal(ok(await call(u, 'POST', '/api/auth/password', { login: 'customer', password: 'Customer-Pass-1' })).role, 'admin');
  // роль ниже администратора — логин снимается, сеансы закрываются
  ok(await call(TECH, 'PATCH', '/api/admin/players/p4', { role: 'host' }));
  assert.equal(ok(await call(u, 'GET', '/api/me')).player, null);
  err(await call(anon(), 'POST', '/api/auth/password', { login: 'customer', password: 'Customer-Pass-1' }), 409, 'bad_login');
  ok(await call(TECH, 'PATCH', '/api/admin/players/p4', { role: 'admin' }));
  ADMIN = await login('p4');
});

test('права ролей: тех. администратор настраивает, остальные получают по настройке', async () => {
  const t = ok(await call(PL, 'GET', '/api/admin/perms'));
  assert.deepEqual(t.roles.map(r => r.key), ['player', 'host', 'plus', 'admin']);
  assert.deepEqual(t.perms.find(x => x.key === 'streams').roles, ['host', 'admin']);
  err(await call(ADMIN, 'PUT', '/api/admin/perms', { perms: { streams: ['player'] } }), 403);
  err(await call(TECH, 'PUT', '/api/admin/perms', { perms: { nope: [] } }), 400);
  err(await call(TECH, 'PUT', '/api/admin/perms', { perms: { streams: ['tech'] } }), 400);
  // админу — баннеры; ведущему — без своих номеров; игроку — камеры
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { banners: ['admin'], host_nums: ['admin'], streams: ['player', 'host', 'admin'] } }));
  assert.ok(ok(await call(ADMIN, 'GET', '/api/me')).perms.includes('banners'));
  ok(await call(ADMIN, 'GET', '/api/admin/banners'));
  err(await call(HOST, 'GET', '/api/host/nums'), 403);
  const tour = ok(await call(PL, 'POST', '/api/tournaments', { name: 'Камеры', format: 'pl', mode: 501, ltw: 1, players: ['p6', 'p9', 'p12'] }), 201).tournament;
  assert.equal(tour.can.stream, true);
  ok(await call(PL, 'PATCH', '/api/tournaments/' + tour.id + '/streams', { streams: [{ url: 'https://vk.com/video-1_2' }] }));
  // журнал: изменение прав видно
  assert.ok(ok(await call(ADMIN, 'GET', '/api/admin/audit')).items.some(x => x.action === 'perms'));
  // вернуть как было
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { banners: [], host_nums: ['host', 'admin'], streams: ['host', 'admin'] } }));
  err(await call(ADMIN, 'GET', '/api/admin/banners'), 403);
  ok(await call(HOST, 'GET', '/api/host/nums'));
});

test('карточка игрока, завершить сеансы, журнал действий', async () => {
  const V = await login('p9');
  err(await call(HOST, 'GET', '/api/admin/players/p9'), 403);
  const card = ok(await call(ADMIN, 'GET', '/api/admin/players/p9'));
  assert.equal(card.player.id, 'p9');
  assert.ok(card.sessions >= 1);
  assert.ok(card.matches > 0);
  ok(await call(ADMIN, 'PATCH', '/api/admin/players/p9', { title: 'КМС' }));
  const r = ok(await call(ADMIN, 'POST', '/api/admin/players/p9/logout'));
  assert.ok(r.sessions >= 1);
  assert.equal(ok(await call(V, 'GET', '/api/me')).player, null);
  err(await call(ADMIN, 'POST', '/api/admin/players/' + ME + '/logout'), 403);
  const log = ok(await call(ADMIN, 'GET', '/api/admin/players/p9')).log.map(x => x.action);
  assert.ok(log.includes('player.logout') && log.includes('player.edit'));
  // ведущий открывает свой аккаунт
  const own = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Свой Игрок' }), 201).player;
  ok(await call(HOST, 'GET', '/api/admin/players/' + own.id));
  err(await call(PL, 'GET', '/api/admin/audit'), 403);
  const all = ok(await call(TECH, 'GET', '/api/admin/audit?limit=200')).items.map(x => x.action);
  assert.ok(all.includes('player.create'));
});
