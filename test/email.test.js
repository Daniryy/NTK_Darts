// Регистрация по почте с кодом из письма, вход по почте и паролю, новый пароль по письму, привязка почты.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');
const config = require('../server/config');
const limits = require('../server/limits');

let app, seq = 0;
const anon = () => ({ dev: 'device_mail_' + String(++seq).padStart(10, '0'), cookie: '' });
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
// письмо ушло недавно — следующее только через минуту: в тестах сдвигаем время отправки
const forget = email => pool.query('UPDATE mail_log SET t = t - 3600e3 WHERE email = $1', [email]);

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
});
test.after(async () => { await app.close(); await pool.end(); });
test.beforeEach(() => limits.reset());

test('регистрация: письмо с кодом, неверный код, аккаунт и вход; почта занята', async () => {
  assert.equal(ok(await call(null, 'GET', '/api/config')).email, true);
  const u = anon();
  err(await call(u, 'POST', '/api/auth/register', { name: 'Иван Петров', email: 'не почта', password: 'darts-2026' }), 400);
  err(await call(u, 'POST', '/api/auth/register', { name: 'Иван Петров', email: 'ivan@mail.ru', password: '1234567' }), 400);
  err(await call(u, 'POST', '/api/auth/register', { name: 'Иван Петров', email: 'ivan@mail.ru', password: '12345678' }), 400);
  const r = ok(await call(u, 'POST', '/api/auth/register', { name: 'Иван Петров', city: 'Казань', email: ' Ivan@Mail.RU ', password: 'darts-2026' }));
  assert.equal(r.sent, true);
  assert.match(r.devCode, /^\d{6}$/);
  // аккаунта ещё нет, пока код не введён
  assert.equal(ok(await call(u, 'GET', '/api/me')).player, null);
  // повтор раньше чем через минуту — 429
  err(await call(u, 'POST', '/api/auth/register', { name: 'Иван Петров', email: 'ivan@mail.ru', password: 'darts-2026' }), 429, 'too_many');
  const wrong = r.devCode === '000000' ? '111111' : '000000';
  err(await call(u, 'POST', '/api/auth/email/verify', { email: 'ivan@mail.ru', purpose: 'reg', code: wrong }), 409, 'bad_code');
  const me = ok(await call(u, 'POST', '/api/auth/email/verify', { email: 'ivan@mail.ru', purpose: 'reg', code: r.devCode }));
  assert.equal(me.created, true);
  assert.equal(me.player.name, 'Иван Петров');
  assert.equal(me.player.city, 'Казань');
  assert.equal(me.player.email, 'ivan@mail.ru');
  assert.equal(me.player.emailOk, true);
  assert.equal(me.role, 'player');
  assert.equal(ok(await call(u, 'GET', '/api/me')).player.id, me.player.id);
  // код одноразовый
  err(await call(anon(), 'POST', '/api/auth/email/verify', { email: 'ivan@mail.ru', purpose: 'reg', code: r.devCode }), 409, 'code_expired');
  // почта уже занята
  err(await call(anon(), 'POST', '/api/auth/register', { name: 'Другой', email: 'IVAN@mail.ru', password: 'darts-2026' }), 409, 'email_taken');
  // почта в чужом профиле не видна, только своя
  assert.equal(ok(await call(null, 'GET', '/api/players/' + me.player.id)).player.email, undefined);
});

test('вход по почте и паролю: верный, неверный, блокировка после 5 ошибок', async () => {
  const u = anon();
  err(await call(u, 'POST', '/api/auth/email/login', { email: 'ivan@mail.ru', password: 'wrong-pass-1' }), 409, 'bad_login');
  err(await call(u, 'POST', '/api/auth/email/login', { email: 'nobody@mail.ru', password: 'darts-2026' }), 409, 'bad_login');
  err(await call(u, 'POST', '/api/auth/email/login', { email: 'x', password: 'darts-2026' }), 409, 'bad_login');
  const r = ok(await call(u, 'POST', '/api/auth/email/login', { email: 'IVAN@mail.ru', password: 'darts-2026' }));
  assert.equal(r.player.email, 'ivan@mail.ru');
  for (let k = 0; k < 5; k++) err(await call(anon(), 'POST', '/api/auth/email/login', { email: 'ivan@mail.ru', password: 'nope-nope-' + k }), 409, 'bad_login');
  limits.reset();
  err(await call(anon(), 'POST', '/api/auth/email/login', { email: 'ivan@mail.ru', password: 'darts-2026' }), 429, 'too_many');
});

test('новый пароль по письму: снимает блокировку, закрывает старые входы', async () => {
  const old = anon();
  await pool.query(`UPDATE players SET pass_lock_until = NULL, pass_fails = 0 WHERE email = 'ivan@mail.ru'`);
  ok(await call(old, 'POST', '/api/auth/email/login', { email: 'ivan@mail.ru', password: 'darts-2026' }));
  await pool.query(`UPDATE players SET pass_lock_until = $1, pass_fails = 5 WHERE email = 'ivan@mail.ru'`, [Date.now() + 9e5]);
  // неизвестная почта: ответ такой же, письма нет
  const none = ok(await call(anon(), 'POST', '/api/auth/email/send', { email: 'ghost@mail.ru', purpose: 'reset' }));
  assert.equal(none.sent, true); assert.equal(none.devCode, undefined);
  await forget('ivan@mail.ru');
  const u = anon(), s = ok(await call(u, 'POST', '/api/auth/email/send', { email: 'ivan@mail.ru', purpose: 'reset' }));
  err(await call(u, 'POST', '/api/auth/email/verify', { email: 'ivan@mail.ru', purpose: 'reset', code: s.devCode, password: 'short' }), 400);
  const r = ok(await call(u, 'POST', '/api/auth/email/verify', { email: 'ivan@mail.ru', purpose: 'reset', code: s.devCode, password: 'new-darts-2026' }));
  assert.equal(r.player.email, 'ivan@mail.ru');
  assert.equal(ok(await call(old, 'GET', '/api/me')).player, null, 'старый вход закрыт');
  err(await call(anon(), 'POST', '/api/auth/email/login', { email: 'ivan@mail.ru', password: 'darts-2026' }), 409, 'bad_login');
  ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'ivan@mail.ru', password: 'new-darts-2026' }));
});

test('привязка почты к аккаунту: код, пароль без текущего, вход по почте, отвязка', async () => {
  const P = await login('p6');
  err(await call(anon(), 'POST', '/api/auth/email/send', { email: 'p6@mail.ru', purpose: 'link' }), 401);
  err(await call(P, 'POST', '/api/auth/email/send', { email: 'ivan@mail.ru', purpose: 'link' }), 409, 'email_taken');
  // без почты пароль не задать
  err(await call(P, 'PUT', '/api/me/password', { password: 'p6-darts-2026' }), 409);
  const s = ok(await call(P, 'POST', '/api/auth/email/send', { email: 'p6@mail.ru', purpose: 'link' }));
  // код, запрошенный другим аккаунтом, не подходит
  const Q = await login('p7');
  err(await call(Q, 'POST', '/api/auth/email/verify', { email: 'p6@mail.ru', purpose: 'link', code: s.devCode }), 409);
  const me = ok(await call(P, 'POST', '/api/auth/email/verify', { email: 'p6@mail.ru', purpose: 'link', code: s.devCode }));
  assert.equal(me.player.email, 'p6@mail.ru'); assert.equal(me.player.emailOk, true); assert.equal(me.player.pass, false);
  ok(await call(P, 'PUT', '/api/me/password', { password: 'p6-darts-2026' }));
  assert.equal(ok(await call(P, 'GET', '/api/me')).player.pass, true);
  // второй раз — уже с текущим паролем
  err(await call(P, 'PUT', '/api/me/password', { password: 'p6-darts-2027' }), 409, 'bad_login');
  const r = ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'p6@mail.ru', password: 'p6-darts-2026' }));
  assert.equal(r.player.id, 'p6');
  // почта — единственный способ входа: не отвязать
  err(await call(P, 'DELETE', '/api/me/login/email'), 409);
  // администратор видит почту и ищет по ней
  const ADMIN = await login('p4');
  const card = ok(await call(ADMIN, 'GET', '/api/admin/players/p6'));
  assert.equal(card.player.email, 'p6@mail.ru'); assert.equal(card.player.emailOk, true);
  assert.ok(ok(await call(ADMIN, 'GET', '/api/admin/players?q=p6@mail')).players.some(x => x.id === 'p6'));
});

test('администратор подтверждает свою почту: запись в журнале; вход по почте пишется в журнал', async () => {
  const T = await login(ME);
  const s = ok(await call(T, 'POST', '/api/auth/email/send', { email: 'tech@mail.ru', purpose: 'link' }));
  ok(await call(T, 'POST', '/api/auth/email/verify', { email: 'tech@mail.ru', purpose: 'link', code: s.devCode }));
  ok(await call(T, 'PUT', '/api/me/password', { password: 'tech-darts-2026' }));
  ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'tech@mail.ru', password: 'tech-darts-2026' }));
  const log = ok(await call(T, 'GET', '/api/admin/audit?target=' + ME)).items.map(x => x.action);
  assert.ok(log.includes('email.link') && log.includes('login.email'));
  // новый пароль по письму: у администратора с логином — от 10 символов
  await pool.query(`UPDATE players SET login = 'tech1' WHERE id = $1`, [ME]);
  await forget('tech@mail.ru');
  const r = ok(await call(anon(), 'POST', '/api/auth/email/send', { email: 'tech@mail.ru', purpose: 'reset' }));
  err(await call(anon(), 'POST', '/api/auth/email/verify', { email: 'tech@mail.ru', purpose: 'reset', code: r.devCode, password: 'short-12' }), 400);
});

test('почта на сервере не настроена: регистрация сразу, адрес не подтверждён; письма не отправляются', async () => {
  const was = config.mail.provider;
  config.mail.provider = '';
  try {
    assert.equal(ok(await call(null, 'GET', '/api/config')).email, false);
    const u = anon();
    const r = ok(await call(u, 'POST', '/api/auth/register', { name: 'Без Письма', email: 'nomail@mail.ru', password: 'darts-2026' }));
    assert.equal(r.created, true);
    assert.equal(r.player.emailOk, false);
    assert.equal(ok(await call(u, 'GET', '/api/me')).player.name, 'Без Письма');
    ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'nomail@mail.ru', password: 'darts-2026' }));
    err(await call(anon(), 'POST', '/api/auth/email/send', { email: 'nomail@mail.ru', purpose: 'reset' }), 404);
  } finally { config.mail.provider = was; }
});

test('код от ведущего: аккаунт с почтой забирает её в аккаунт ведущего', async () => {
  const HOST = await login('p1');
  const acc = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Новичок Клуба' }), 201).player;
  const u = anon();
  const reg = ok(await call(u, 'POST', '/api/auth/register', { name: 'Новичок', email: 'novice@mail.ru', password: 'darts-2026' }));
  ok(await call(u, 'POST', '/api/auth/email/verify', { email: 'novice@mail.ru', purpose: 'reg', code: reg.devCode }));
  const me = ok(await call(u, 'POST', '/api/me/claim', { code: acc.claim }));
  assert.equal(me.player.id, acc.id);
  assert.equal(me.player.email, 'novice@mail.ru');
  ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'novice@mail.ru', password: 'darts-2026' }));
});
