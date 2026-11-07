// Сайт клуба по умолчанию: регистрация закрыта, профиль и пароль игроку меняет администратор;
// логин и пароль игроку выдают администратор или ведущий (своему аккаунту), игрок входит без кода из приложения.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
delete process.env.SITE_OPEN;
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');

let app, seq = 0;
const anon = () => ({ dev: 'device_site_' + String(++seq).padStart(8, '0'), cookie: '' });
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

let TECH, ADMIN, HOST, PL;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  await require('../server/audit').loadSettings();
  app = build({ logger: false });
  await app.ready();
  TECH = await login(ME); ADMIN = await login('p4'); HOST = await login('p1'); PL = await login('p6');
});
test.after(async () => { await app.close(); await pool.end(); });

test('по умолчанию закрыто: регистрации нет, игрок не правит профиль, фото и пароль; ведущий правит свой', async () => {
  assert.deepEqual(ok(await call(null, 'GET', '/api/config')).site, { signup: false, selfEdit: false, selfPass: false });
  err(await call(anon(), 'POST', '/api/auth/register', { consent: true, name: 'Новый', email: 'new@mail.ru', password: 'darts-2026' }), 403);
  err(await call(anon(), 'POST', '/api/auth/phone', { phone: '+79990009911' }), 403, 'forbidden');
  err(await call(PL, 'PATCH', '/api/me', { city: 'Казань' }), 403);
  err(await call(PL, 'PUT', '/api/me/password', { current: '', password: 'darts-2026' }), 403);
  err(await call(PL, 'DELETE', '/api/me/login/phone'), 403);
  err(await call(PL, 'DELETE', '/api/players/p6/photo'), 403);
  ok(await call(HOST, 'PATCH', '/api/me', { city: 'Москва' }));
  // администратор правит игроку профиль
  ok(await call(ADMIN, 'PATCH', '/api/admin/players/p6', { city: 'Казань' }));
  assert.equal(ok(await call(null, 'GET', '/api/players/p6')).player.city, 'Казань');
});

test('логин и пароль игроку: администратор выдаёт, игрок входит без кода; новый пароль гасит старый; снять вход', async () => {
  err(await call(PL, 'PUT', '/api/admin/players/p7/login', {}), 403);
  const r = ok(await call(ADMIN, 'PUT', '/api/admin/players/p6/login', {}));
  assert.match(r.login, /^[a-z0-9]{3,}$/);
  assert.match(r.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{2}$/);
  const u = anon(), me = ok(await call(u, 'POST', '/api/auth/password', { login: r.login, password: r.password }));
  assert.equal(me.need2fa, undefined);
  assert.equal(me.player.id, 'p6');
  assert.equal(ok(await call(u, 'GET', '/api/me')).player.id, 'p6');
  // новый пароль: прежний не пускает, старые сеансы закрыты
  const r2 = ok(await call(ADMIN, 'PUT', '/api/admin/players/p6/login', {}));
  assert.equal(r2.login, r.login);
  assert.notEqual(r2.password, r.password);
  assert.equal(ok(await call(u, 'GET', '/api/me')).player, null);
  err(await call(anon(), 'POST', '/api/auth/password', { login: r.login, password: r.password }), 409, 'bad_login');
  ok(await call(anon(), 'POST', '/api/auth/password', { login: r.login, password: r2.password }));
  // свой логин тоже можно
  assert.equal(ok(await call(ADMIN, 'PUT', '/api/admin/players/p6/login', { login: 'darts6', password: 'my-darts-26' })).password, undefined);
  ok(await call(anon(), 'POST', '/api/auth/password', { login: 'darts6', password: 'my-darts-26' }));
  // снять вход
  assert.equal(ok(await call(ADMIN, 'DELETE', '/api/admin/players/p6/login')).player.login, null);
  err(await call(anon(), 'POST', '/api/auth/password', { login: 'darts6', password: 'my-darts-26' }), 409, 'bad_login');
});

test('ведущий выдаёт логин своему аккаунту, но не чужому; логин — по фамилии латиницей', async () => {
  const p = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Иван Щукин', city: 'Москва' }), 201).player;
  const r = ok(await call(HOST, 'PUT', '/api/admin/players/' + p.id + '/login', {}));
  assert.equal(r.login, 'schukin');
  assert.equal(r.player.lite, false, 'с логином — полный аккаунт');
  err(await call(HOST, 'PUT', '/api/admin/players/p9/login', {}), 403);
  // тёзка получает следующий номер
  const q = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Пётр Щукин' }), 201).player;
  assert.equal(ok(await call(HOST, 'PUT', '/api/admin/players/' + q.id + '/login', {})).login, 'schukin2');
});

test('настройки сайта меняет тех. администратор: открыть регистрацию и правку профиля', async () => {
  err(await call(ADMIN, 'PUT', '/api/admin/site', { signup: true }), 403);
  err(await call(TECH, 'PUT', '/api/admin/site', {}), 400);
  assert.deepEqual(ok(await call(TECH, 'PUT', '/api/admin/site', { signup: true, selfEdit: true })).site, { signup: true, selfEdit: true, selfPass: false });
  assert.deepEqual(ok(await call(null, 'GET', '/api/config')).site, { signup: true, selfEdit: true, selfPass: false });
  ok(await call(anon(), 'POST', '/api/auth/register', { consent: true, name: 'Новый Игрок', email: 'new2@mail.ru', password: 'darts-2026' }));
  PL = await login('p6'); // новый пароль выше закрыл прежние сеансы
  ok(await call(PL, 'PATCH', '/api/me', { city: 'Тверь' }));
  err(await call(PL, 'PUT', '/api/me/password', { current: '', password: 'darts-2026' }), 403);
  // после перезапуска сервера — из базы
  require('../server/site').setSite({});
  await require('../server/audit').loadSettings();
  assert.equal(require('../server/site').site().signup, true);
  ok(await call(TECH, 'PUT', '/api/admin/site', { signup: false, selfEdit: false }));
});
