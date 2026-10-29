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
  const r = await app.inject(Object.assign({ method, url, payload: body, headers }, u && u.ip ? { remoteAddress: u.ip } : {}));
  const sid = r.cookies.find(c => c.name === 'oche_sid');
  if (u && sid) u.cookie = 'oche_sid=' + sid.value;
  return { s: r.statusCode, b: r.body ? JSON.parse(r.body) : null, h: r.headers };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
const err = (r, code, ecode) => { assert.equal(r.s, code, JSON.stringify(r.b)); if (ecode) assert.equal(r.b.error.code, ecode); return r.b.error; };
async function login(playerId) { const u = anon(); ok(await call(u, 'POST', '/api/auth/dev', { playerId })); return u; }
const T = require('../server/totp');
const nowStep = () => Math.floor(Date.now() / 30000);
// вход администратора целиком: пароль, затем код из приложения (привязка при первом входе). В тестах входы идут чаще,
// чем раз в 30 с, а один код дважды не принимается — поэтому «последний шаг» сбрасываем
async function full(u, url, body) {
  const r = ok(await call(u, 'POST', url, body));
  if (!r.need2fa) return r;
  let secret = r.secret;
  if (r.need2fa === 'code') {
    const row = (await pool.query('UPDATE players SET totp_last = 0 WHERE login = $1 OR email = $1 RETURNING totp_secret', [String(body.login || body.email).trim().toLowerCase()])).rows[0];
    secret = T.dec(row.totp_secret);
  }
  return ok(await call(u, 'POST', '/api/auth/2fa', { ticket: r.ticket, code: T.codeAt(secret, nowStep()) }));
}

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
  const r = await full(u, '/api/auth/password', { login: ' DANIL ', password: 'Darts-Secret-1' });
  assert.equal(r.player.id, ME);
  assert.equal(r.role, 'tech');
  assert.ok(r.perms.includes('banners') && r.perms.includes('audit'));
  assert.equal(r.player.login, 'danil');
  assert.equal(ok(await call(u, 'GET', '/api/me')).player.id, ME);
  // 5 неверных с одного адреса — с него вход закрыт даже с верным паролем; владелец с другого адреса входит
  const bad = () => Object.assign(anon(), { ip: '10.9.9.9' });
  for (let k = 0; k < 5; k++) err(await call(bad(), 'POST', '/api/auth/password', { login: 'danil', password: 'nope-nope-' + k }), 409, 'bad_login');
  const lk = err(await call(bad(), 'POST', '/api/auth/password', { login: 'danil', password: 'Darts-Secret-1' }), 429, 'too_many');
  assert.ok(lk.retryAfter > 0);
  ok(await call(Object.assign(anon(), { ip: '10.1.1.1' }), 'POST', '/api/auth/password', { login: 'danil', password: 'Darts-Secret-1' }));
  limits.reset();
  // роль ниже администратора — пароль не пускает
  await pool.query(`UPDATE players SET login = 'host1', pass_hash = $1 WHERE id = 'p1'`, [await hashPassword('Host-Secret-1')]);
  err(await call(anon(), 'POST', '/api/auth/password', { login: 'host1', password: 'Host-Secret-1' }), 403);
  await pool.query(`UPDATE players SET login = NULL, pass_hash = NULL WHERE id = 'p1'`);
  // вход записан в журнал
  assert.ok(ok(await call(TECH, 'GET', '/api/admin/audit?target=' + ME)).items.some(x => x.action === 'login.password'));
});

test('зал с одного IP: удачные входы не упираются в лимит; подбор с разных устройств — упирается', async () => {
  const hall = () => Object.assign(anon(), { ip: '10.7.7.7' });
  // 30 удачных входов подряд с одного адреса — ни одного отказа
  for (let k = 0; k < 30; k++) ok(await call(hall(), 'POST', '/api/auth/password', { login: 'danil', password: 'Darts-Secret-1' }));
  // подбор паролей к разным логинам с одного адреса: после 50 неудач — отказ
  for (let k = 0; k < 50; k++) err(await call(hall(), 'POST', '/api/auth/password', { login: 'x' + k, password: 'whatever-123' }), 409);
  const e = err(await call(hall(), 'POST', '/api/auth/password', { login: 'danil', password: 'Darts-Secret-1' }), 429, 'too_many');
  assert.ok(e.retryAfter > 0);
  limits.reset();
  // коды: считаются только неверные, 30 за 10 минут
  for (let k = 0; k < 30; k++) err(await call(hall(), 'POST', '/api/auth/code', { code: 'ZZZZ' + String(k).padStart(4, 'A') }), 404);
  err(await call(hall(), 'POST', '/api/auth/code', { code: 'ZZZZZZZZ' }), 429, 'too_many');
  limits.reset();
});

test('смена своего пароля', async () => {
  const u = anon();
  await full(u, '/api/auth/password', { login: 'danil', password: 'Darts-Secret-1' });
  err(await call(u, 'PUT', '/api/me/password', { current: 'wrong', password: 'New-Secret-22' }), 409, 'bad_login');
  err(await call(u, 'PUT', '/api/me/password', { current: 'Darts-Secret-1', password: '1234567890123' }), 400);
  err(await call(u, 'PUT', '/api/me/password', { current: 'Darts-Secret-1', password: 'short' }), 400);
  ok(await call(u, 'PUT', '/api/me/password', { current: 'Darts-Secret-1', password: 'New-Secret-22' }));
  // новый пароль: этот вход остаётся, остальные (в том числе общий TECH) закрыты
  assert.equal(ok(await call(u, 'GET', '/api/me')).player.id, ME);
  assert.equal(ok(await call(TECH, 'GET', '/api/me')).player, null);
  TECH = await login(ME);
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
  assert.equal((await full(u, '/api/auth/password', { login: 'customer', password: 'Customer-Pass-1' })).role, 'admin');
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

test('удаление аккаунта: право delete_players, не себя, не игрока турниров; турниры на регистрации — запись убирается', async () => {
  // свой аккаунт без матчей и турниров
  const a = ok(await call(TECH, 'POST', '/api/admin/players', { name: 'На Удаление' }), 201).player;
  err(await call(ADMIN, 'DELETE', '/api/admin/players/' + a.id), 403);
  err(await call(TECH, 'DELETE', '/api/admin/players/' + ME), 409);
  // в сыгранных турнирах — нельзя
  const busy = err(await call(TECH, 'DELETE', '/api/admin/players/p6'), 409);
  assert.equal(busy.code, 'in_tournaments');
  ok(await call(TECH, 'DELETE', '/api/admin/players/' + a.id));
  err(await call(null, 'GET', '/api/players/' + a.id), 404);
  assert.ok(ok(await call(TECH, 'GET', '/api/admin/audit?limit=20')).items.some(x => x.action === 'player.delete' && x.data.name === 'На Удаление'));
  // право можно выдать администратору; администратора он всё равно не удалит
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { delete_players: ['admin'] } }));
  const b = ok(await call(ADMIN, 'POST', '/api/admin/players', { name: 'Ещё Один' }), 201).player;
  ok(await call(ADMIN, 'DELETE', '/api/admin/players/' + b.id));
  err(await call(ADMIN, 'DELETE', '/api/admin/players/' + ME), 403);
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { delete_players: [] } }));
});

test('права: создавать турниры (create_tour), видеть контакты (contacts), тарифы (plans_edit)', async () => {
  const body = { name: 'Проверка права', format: 'rr', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8'] };
  ok(await call(PL, 'POST', '/api/tournaments', body), 201);
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { create_tour: ['host', 'admin'] } }));
  err(await call(PL, 'POST', '/api/tournaments', body), 403);
  ok(await call(HOST, 'POST', '/api/tournaments', body), 201);
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { create_tour: ['player', 'host', 'admin'] } }));
  // контакты: администратор без права видит «скрыт», свой аккаунт ведущий видит всегда
  await pool.query(`UPDATE players SET phone = '+79990001122' WHERE id = 'p11'`);
  assert.equal(ok(await call(ADMIN, 'GET', '/api/admin/players/p11')).player.phone, '+79990001122');
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { contacts: [] } }));
  const card = ok(await call(ADMIN, 'GET', '/api/admin/players/p11')).player;
  assert.equal(card.phone, 'скрыт'); assert.equal(card.contacts, false);
  assert.ok(!ok(await call(ADMIN, 'GET', '/api/admin/players?q=0001122')).players.some(x => x.id === 'p11'), 'поиск по телефону без права не находит');
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { contacts: ['admin'] } }));
  // тарифы: по умолчанию только тех. администратор, право можно выдать
  err(await call(ADMIN, 'PUT', '/api/admin/discounts', { ms: 20, kms: 10, r1: 5 }), 403);
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { plans_edit: ['admin'] } }));
  ok(await call(ADMIN, 'PUT', '/api/admin/discounts', { ms: 20, kms: 10, r1: 5 }));
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { plans_edit: [] } }));
});

test('очистка сервера от демо-данных: право cleanup, подтверждение; остаются аккаунты со входом и тот, кто чистил', async () => {
  err(await call(ADMIN, 'POST', '/api/admin/cleanup', { confirm: true }), 403);
  err(await call(TECH, 'POST', '/api/admin/cleanup', {}), 400);
  await pool.query(`UPDATE players SET email = 'p20@mail.ru' WHERE id = 'p20'`);
  const n = ok(await call(TECH, 'POST', '/api/admin/cleanup', { confirm: true }));
  assert.ok(n.tours > 0 && n.removed > 0);
  const left = (await pool.query('SELECT id FROM players ORDER BY id')).rows.map(x => x.id);
  assert.ok(left.includes(ME) && left.includes('p20') && left.includes('p11'), 'со входом и тот, кто чистил');
  assert.ok(!left.includes('p6'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tournaments')).rows[0].n, 0);
  assert.equal(ok(await call(null, 'GET', '/api/rating')).total, 0);
  assert.equal(ok(await call(TECH, 'GET', '/api/me')).player.id, ME);
});

test('роль игроку с почтой и снятие входа по логину не стирают пароль от почты', async () => {
  // игрок зарегистрировался по почте
  const u = anon();
  const reg = ok(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Почтовый Игрок', email: 'mailer@mail.ru', password: 'darts-2026' }));
  const id = ok(await call(u, 'POST', '/api/auth/email/verify', { email: 'mailer@mail.ru', purpose: 'reg', code: reg.devCode })).player.id;
  // выдали роль ведущего — вход по почте и сеанс остаются
  ok(await call(TECH, 'PATCH', '/api/admin/players/' + id, { role: 'host' }));
  assert.equal(ok(await call(u, 'GET', '/api/me')).player.id, id);
  ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'mailer@mail.ru', password: 'darts-2026' }));
  // администратор с логином и почтой: снятие логина оставляет вход по почте
  ok(await call(TECH, 'PATCH', '/api/admin/players/' + id, { role: 'admin' }));
  ok(await call(TECH, 'PUT', '/api/admin/players/' + id + '/login', { login: 'mailadm', password: 'Strong-Pass-12' }));
  const off = ok(await call(TECH, 'DELETE', '/api/admin/players/' + id + '/login'));
  assert.equal(off.player.login, null);
  err(await call(anon(), 'POST', '/api/auth/password', { login: 'mailadm', password: 'Strong-Pass-12' }), 409, 'bad_login');
  ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'mailer@mail.ru', password: 'Strong-Pass-12' }));
  // понижение администратора с логином: логин снят, сеансы закрыты, почта по-прежнему пускает
  ok(await call(TECH, 'PUT', '/api/admin/players/' + id + '/login', { login: 'mailadm', password: 'Strong-Pass-12' }));
  const a = anon();
  await full(a, '/api/auth/password', { login: 'mailadm', password: 'Strong-Pass-12' });
  const down = ok(await call(TECH, 'PATCH', '/api/admin/players/' + id, { role: 'player' }));
  assert.equal(down.player.login, null);
  err(await call(a, 'GET', '/api/admin/stats'), 401);
  ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'mailer@mail.ru', password: 'Strong-Pass-12' }));
});

test('кривые параметры журнала и нулевой байт в строке — 400, не ошибка сервера', async () => {
  err(await call(TECH, 'GET', '/api/admin/audit?before=abc'), 400);
  err(await call(TECH, 'GET', '/api/admin/audit?target=%00'), 400);
  err(await call(TECH, 'GET', '/api/admin/players?q=a%00b'), 400);
  ok(await call(TECH, 'GET', '/api/admin/audit?before=' + Date.now()));
});

test('баннеры: ссылка на страницу сайта, кнопка, сразу на несколько мест, копия', async () => {
  err(await call(TECH, 'POST', '/api/admin/banners', { places: ['feed', 'feed'], title: 'x' }), 400);
  err(await call(TECH, 'POST', '/api/admin/banners', { place: 'feed', title: 'x', link: 'javascript:alert(1)' }), 400);
  err(await call(TECH, 'POST', '/api/admin/banners', { place: 'feed', title: 'x', link: '#plans<script>' }), 400);
  const r = ok(await call(TECH, 'POST', '/api/admin/banners', { places: ['feed', 'tour'], title: 'Скидка на тарифы −50%', body: 'До конца месяца', link: '#plans', cta: 'Подключить →' }), 201);
  assert.deepEqual(r.banners.map(b => [b.place, b.link, b.cta]), [['feed', '#plans', 'Подключить →'], ['tour', '#plans', 'Подключить →']]);
  const pub = ok(await call(null, 'GET', '/api/banners?place=tour')).banners.find(b => b.id === r.banners[1].id);
  assert.equal(pub.cta, 'Подключить →');
  const cp = ok(await call(TECH, 'POST', '/api/admin/banners/' + r.banner.id + '/copy', { places: ['tv'] }), 201).banners;
  assert.deepEqual(cp.map(b => [b.place, b.title, b.link]), [['tv', 'Скидка на тарифы −50%', '#plans']]);
  // обычный игрок (новый: прежних могла удалить очистка в тесте выше)
  const U = anon(), reg = ok(await call(U, 'POST', '/api/auth/register', { consent: true, name: 'Без Прав', email: 'noperm@mail.ru', password: 'darts-2026' }));
  if (reg.devCode) ok(await call(U, 'POST', '/api/auth/email/verify', { email: 'noperm@mail.ru', purpose: 'reg', code: reg.devCode }));
  err(await call(U, 'POST', '/api/admin/banners/' + r.banner.id + '/copy', { places: ['tv'] }), 403);
  for (const b of r.banners.concat(cp)) ok(await call(TECH, 'DELETE', '/api/admin/banners/' + b.id));
});

test('администраторы входят только с паролем: код от ведущего и телефон закрыты; неверные коды на номер — 10 в сутки', async () => {
  // код от ведущего у администратора (прежних игроков могли удалить тесты выше — берём любого и делаем админом)
  const adm = (await pool.query(`UPDATE players SET role = 'admin', claim = 'ADMINCODE' WHERE id = (SELECT id FROM players WHERE id <> $1 ORDER BY id LIMIT 1) RETURNING id`, [ME])).rows[0].id;
  err(await call(anon(), 'POST', '/api/auth/code', { code: 'ADMINCODE' }), 403);
  await pool.query(`UPDATE players SET claim = NULL, phone = '+79990000444' WHERE id = $1`, [adm]);
  const s = ok(await call(anon(), 'POST', '/api/auth/phone', { phone: '+79990000444' }));
  err(await call(anon(), 'POST', '/api/auth/phone/verify', { phone: '+79990000444', code: s.devCode }), 403);
  await pool.query(`UPDATE players SET phone = NULL WHERE id = $1`, [adm]);
  // подбор кода к номеру: после 10 неверных за сутки — отказ даже с разных адресов
  limits.reset();
  await pool.query(`DELETE FROM sms_log`);
  const ph = '+79990000555';
  for (let k = 0; k < 10; k++) {
    if (k % 3 === 0) { await pool.query(`DELETE FROM sms_log WHERE phone = $1`, [ph]); ok(await call(anon(), 'POST', '/api/auth/phone', { phone: ph })); }
    err(await call(Object.assign(anon(), { ip: '10.5.5.' + k }), 'POST', '/api/auth/phone/verify', { phone: ph, code: '000000' }), 409);
  }
  await pool.query(`DELETE FROM sms_log WHERE phone = $1`, [ph]);
  const s2 = ok(await call(anon(), 'POST', '/api/auth/phone', { phone: ph }));
  err(await call(Object.assign(anon(), { ip: '10.6.6.6' }), 'POST', '/api/auth/phone/verify', { phone: ph, code: s2.devCode }), 429, 'too_many');
  limits.reset();
});

test('двухфакторный вход администраторов: привязка, код, резервные коды, повтор кода, сброс', async () => {
  const adm = await tx(c => require('../server/players').createPlayer(c, { name: 'Админ Двухфакторный' }));
  const AID = adm.id;
  await pool.query(`UPDATE players SET role = 'admin', login = 'twofa', pass_hash = $1 WHERE id = $2`, [await hashPassword('Twofa-Secret-1'), AID]);
  // пароль верный — сеанса ещё нет: привязка приложения
  const u = anon();
  const s = ok(await call(u, 'POST', '/api/auth/password', { login: 'twofa', password: 'Twofa-Secret-1' }));
  assert.equal(s.need2fa, 'setup');
  assert.match(s.secret, /^[A-Z2-7]{32}$/);
  assert.match(s.otpauth, /^otpauth:\/\/totp\/Oche%3Atwofa\?secret=/);
  assert.equal(s.player, undefined);
  assert.equal(ok(await call(u, 'GET', '/api/me')).player, null);
  err(await call(u, 'POST', '/api/auth/2fa', { ticket: s.ticket, code: '000000' === T.codeAt(s.secret, nowStep()) ? '111111' : '000000' }), 409, 'bad_code');
  err(await call(u, 'POST', '/api/auth/2fa', { ticket: 'нет-такого', code: '123456' }), 409, 'code_expired');
  const on = ok(await call(u, 'POST', '/api/auth/2fa', { ticket: s.ticket, code: T.codeAt(s.secret, nowStep()) }));
  assert.equal(on.player.id, AID);
  assert.equal(on.player.twofa, true);
  assert.equal(on.backup.length, 8);
  assert.match(on.backup[0], /^[a-z2-7]{4}-[a-z2-7]{4}$/);
  // секрет в базе зашифрован
  const row = (await pool.query(`SELECT totp_secret FROM players WHERE id = $1`, [AID])).rows[0];
  assert.notEqual(row.totp_secret, s.secret);
  assert.equal(T.dec(row.totp_secret), s.secret);
  // билет одноразовый
  err(await call(anon(), 'POST', '/api/auth/2fa', { ticket: s.ticket, code: T.codeAt(s.secret, nowStep()) }), 409, 'code_expired');
  // следующий вход: код; тот же код второй раз не принимается
  const c1 = ok(await call(anon(), 'POST', '/api/auth/password', { login: 'twofa', password: 'Twofa-Secret-1' }));
  assert.equal(c1.need2fa, 'code');
  assert.equal(c1.secret, undefined);
  err(await call(anon(), 'POST', '/api/auth/2fa', { ticket: c1.ticket, code: T.codeAt(s.secret, nowStep()) }), 409, 'bad_code');
  // резервный код — один раз
  const v = anon();
  const r1 = ok(await call(v, 'POST', '/api/auth/2fa', { ticket: c1.ticket, code: on.backup[0].toUpperCase() }));
  assert.equal(r1.backupLeft, 7);
  assert.equal(ok(await call(v, 'GET', '/api/me')).player.id, AID);
  const c2 = ok(await call(anon(), 'POST', '/api/auth/password', { login: 'twofa', password: 'Twofa-Secret-1' }));
  err(await call(anon(), 'POST', '/api/auth/2fa', { ticket: c2.ticket, code: on.backup[0] }), 409, 'bad_code');
  // новые резервные коды — по коду из приложения
  await pool.query(`UPDATE players SET totp_last = 0 WHERE id = $1`, [AID]);
  const nb = ok(await call(v, 'POST', '/api/me/2fa/backup', { code: T.codeAt(s.secret, nowStep()) })).backup;
  assert.equal(nb.length, 8);
  assert.notDeepEqual(nb, on.backup);
  // 5 неверных кодов — пауза
  limits.reset();
  const c3 = ok(await call(anon(), 'POST', '/api/auth/password', { login: 'twofa', password: 'Twofa-Secret-1' }));
  for (let k = 0; k < 5; k++) err(await call(anon(), 'POST', '/api/auth/2fa', { ticket: c3.ticket, code: '00000' + k }), 409, 'bad_code');
  err(await call(anon(), 'POST', '/api/auth/2fa', { ticket: c3.ticket, code: nb[1] }), 429, 'too_many');
  limits.reset();
  // вход по почте у администратора — тоже с кодом
  await pool.query(`UPDATE players SET email = 'twofa@mail.ru' WHERE id = $1`, [AID]);
  assert.equal(ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'twofa@mail.ru', password: 'Twofa-Secret-1' })).need2fa, 'code');
  // сброс: только тех. администратор, сеансы закрываются, при входе — привязка заново
  err(await call(await login((await tx(c => require('../server/players').createPlayer(c, { name: 'Простой Игрок' }))).id), 'DELETE', '/api/admin/players/' + AID + '/2fa'), 403);
  assert.equal(ok(await call(TECH, 'DELETE', '/api/admin/players/' + AID + '/2fa')).player.twofa, false);
  assert.equal(ok(await call(v, 'GET', '/api/me')).player, null);
  assert.equal(ok(await call(anon(), 'POST', '/api/auth/password', { login: 'twofa', password: 'Twofa-Secret-1' })).need2fa, 'setup');
  err(await call(TECH, 'DELETE', '/api/admin/players/' + AID + '/2fa'), 409);
});
