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
  const r = await app.inject(Object.assign({ method, url, payload: body, headers }, u && u.ip ? { remoteAddress: u.ip } : {}));
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
  err(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Иван Петров', email: 'не почта', password: 'darts-2026' }), 400);
  err(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Иван Петров', email: 'ivan@mail.ru', password: '1234567' }), 400);
  err(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Иван Петров', email: 'ivan@mail.ru', password: '12345678' }), 400);
  const r = ok(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Иван Петров', city: 'Казань', email: ' Ivan@Mail.RU ', password: 'darts-2026' }));
  assert.equal(r.sent, true);
  assert.match(r.devCode, /^\d{6}$/);
  // аккаунта ещё нет, пока код не введён
  assert.equal(ok(await call(u, 'GET', '/api/me')).player, null);
  // повтор раньше чем через минуту — 429
  err(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Иван Петров', email: 'ivan@mail.ru', password: 'darts-2026' }), 429, 'too_many');
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
  err(await call(anon(), 'POST', '/api/auth/register', { consent: true, name: 'Другой', email: 'IVAN@mail.ru', password: 'darts-2026' }), 409, 'email_taken');
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
  // 5 неверных с одного адреса — с него закрыто; владелец с другого адреса входит
  const bad = () => Object.assign(anon(), { ip: '10.8.8.8' });
  for (let k = 0; k < 5; k++) err(await call(bad(), 'POST', '/api/auth/email/login', { email: 'ivan@mail.ru', password: 'nope-nope-' + k }), 409, 'bad_login');
  err(await call(bad(), 'POST', '/api/auth/email/login', { email: 'ivan@mail.ru', password: 'darts-2026' }), 429, 'too_many');
  ok(await call(Object.assign(anon(), { ip: '10.2.2.2' }), 'POST', '/api/auth/email/login', { email: 'ivan@mail.ru', password: 'darts-2026' }));
  // 25 регистраций с одного адреса (зал) — без отказов
  for (let k = 0; k < 25; k++) ok(await call(Object.assign(anon(), { ip: '10.3.3.3' }), 'POST', '/api/auth/register', { consent: true, name: 'Игрок Зала ' + k, email: 'hall' + k + '@mail.ru', password: 'darts-2026' }));
  limits.reset();
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
  // у администратора после пароля — код из приложения; вход в журнал пишется после него
  const st = ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'tech@mail.ru', password: 'tech-darts-2026' }));
  assert.equal(st.need2fa, 'setup');
  ok(await call(anon(), 'POST', '/api/auth/2fa', { ticket: st.ticket, code: require('../server/totp').codeAt(st.secret, Math.floor(Date.now() / 30000)) }));
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
    const r = ok(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Без Письма', email: 'nomail@mail.ru', password: 'darts-2026' }));
    assert.equal(r.created, true);
    assert.equal(r.player.emailOk, false);
    assert.equal(ok(await call(u, 'GET', '/api/me')).player.name, 'Без Письма');
    ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'nomail@mail.ru', password: 'darts-2026' }));
    err(await call(anon(), 'POST', '/api/auth/email/send', { email: 'nomail@mail.ru', purpose: 'reset' }), 404);
    // привязать почту к аккаунту без писем: сразу, неподтверждённой; без пароля — нужно задать
    const P = await login('p12');
    err(await call(P, 'PUT', '/api/me/email', { email: 'p12@mail.ru' }), 400);
    err(await call(P, 'PUT', '/api/me/email', { email: 'nomail@mail.ru', password: 'darts-2026' }), 409, 'email_taken');
    const me = ok(await call(P, 'PUT', '/api/me/email', { email: 'P12@mail.ru', password: 'p12-darts-26' }));
    assert.equal(me.player.email, 'p12@mail.ru'); assert.equal(me.player.emailOk, false); assert.equal(me.player.pass, true);
    ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'p12@mail.ru', password: 'p12-darts-26' }));
    // пароль уже есть — второй раз не нужен
    ok(await call(P, 'PUT', '/api/me/email', { email: 'p12.new@mail.ru' }));
  } finally { config.mail.provider = was; }
  // письма настроены — только через код
  err(await call(await login('p13'), 'PUT', '/api/me/email', { email: 'p13@mail.ru', password: 'darts-2026' }), 409, 'need_code');
});

test('код от ведущего: аккаунт с почтой забирает её в аккаунт ведущего', async () => {
  const HOST = await login('p1');
  const acc = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Новичок Клуба' }), 201).player;
  const u = anon();
  const reg = ok(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Новичок', email: 'novice@mail.ru', password: 'darts-2026' }));
  ok(await call(u, 'POST', '/api/auth/email/verify', { email: 'novice@mail.ru', purpose: 'reg', code: reg.devCode }));
  const me = ok(await call(u, 'POST', '/api/me/claim', { code: acc.claim }));
  assert.equal(me.player.id, acc.id);
  assert.equal(me.player.email, 'novice@mail.ru');
  ok(await call(anon(), 'POST', '/api/auth/email/login', { email: 'novice@mail.ru', password: 'darts-2026' }));
});

test('личные данные: согласие при регистрации, выгрузка, удаление аккаунта и обезличивание', async () => {
  const u = anon();
  err(await call(u, 'POST', '/api/auth/register', { name: 'Без Согласия', email: 'noconsent@mail.ru', password: 'darts-2026' }), 400);
  const r = ok(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Анна Удалова', email: 'anna.del@mail.ru', password: 'darts-2026' }));
  const me = ok(await call(u, 'POST', '/api/auth/email/verify', { email: 'anna.del@mail.ru', purpose: 'reg', code: r.devCode })).player;
  const x = await call(u, 'GET', '/api/me/export');
  assert.equal(x.s, 200);
  assert.match(x.h['content-disposition'], /attachment/);
  assert.equal(x.b.profile.email, 'anna.del@mail.ru');
  assert.ok(x.b.profile.consent_at > 0);
  assert.equal(x.b.profile.pass_hash, undefined);
  assert.ok(Array.isArray(x.b.matches) && Array.isArray(x.b.sessions) && x.b.sessions.length === 1);
  err(await call(null, 'GET', '/api/me/export'), 401);
  // без подтверждения — нет; администратора — нет
  err(await call(u, 'DELETE', '/api/me', {}), 400);
  await pool.query(`UPDATE players SET role = 'admin' WHERE id = $1`, [me.id]);
  require('../server/auth').clearCache();
  err(await call(u, 'DELETE', '/api/me', { confirm: true }), 403);
  await pool.query(`UPDATE players SET role = 'player' WHERE id = $1`, [me.id]);
  require('../server/auth').clearCache();
  // без турниров — удаляется целиком, почта свободна
  ok(await call(u, 'DELETE', '/api/me', { confirm: true }));
  assert.equal(ok(await call(u, 'GET', '/api/me')).player, null);
  assert.equal((await pool.query('SELECT 1 FROM players WHERE id = $1', [me.id])).rowCount, 0);
  forget('anna.del@mail.ru');
  ok(await call(anon(), 'POST', '/api/auth/register', { consent: true, name: 'Анна Снова', email: 'anna.del@mail.ru', password: 'darts-2026' }));
  // сыгравший в турнире — обезличивается, матчи остаются
  const pl = (await pool.query(`SELECT e.player_id AS id FROM entries e JOIN tournaments t ON t.id = e.tournament_id JOIN players p ON p.id = e.player_id
    WHERE t.status <> 'reg' AND p.role = 'player' AND EXISTS (SELECT 1 FROM match_lines l WHERE l.player_id = p.id) LIMIT 1`)).rows[0];
  assert.ok(pl, 'в демо есть игрок турнира');
  const v = await login(pl.id);
  const before = (await pool.query('SELECT count(*)::int AS n FROM match_lines WHERE player_id = $1', [pl.id])).rows[0].n;
  assert.ok(ok(await call(v, 'GET', '/api/me/export')).tournaments.length > 0);
  ok(await call(v, 'DELETE', '/api/me', { confirm: true }));
  const row = (await pool.query('SELECT * FROM players WHERE id = $1', [pl.id])).rows[0];
  assert.equal(row.name, 'Удалённый игрок');
  assert.equal(row.blocked, true);
  assert.equal(row.phone, null);
  assert.equal(row.vk_id, null);
  assert.equal(row.photo, null);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM sessions WHERE player_id = $1', [pl.id])).rows[0].n, 0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM match_lines WHERE player_id = $1', [pl.id])).rows[0].n, before);
  assert.equal(ok(await call(v, 'GET', '/api/me')).player, null);
});

test('квота: не больше 100 новых гостей в сутки у игрока; тот же гость повторно — не новый', async () => {
  const u = anon();
  const r = ok(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Квота Гостей', email: 'quota@mail.ru', password: 'darts-2026' }));
  ok(await call(u, 'POST', '/api/auth/email/verify', { email: 'quota@mail.ru', purpose: 'reg', code: r.devCode }));
  for (let i = 0; i < 100; i++) ok(await call(u, 'POST', '/api/players', { name: 'Гость ' + i }));
  ok(await call(u, 'POST', '/api/players', { name: 'Гость 7' }));
  err(await call(u, 'POST', '/api/players', { name: 'Гость 100' }), 429, 'quota');
});

test('администратор: вход по почте и новый пароль по письму — только с кодом из приложения', async () => {
  const u = anon();
  const r = ok(await call(u, 'POST', '/api/auth/register', { consent: true, name: 'Почтовый Админ', email: 'adm2fa@mail.ru', password: 'darts-2026' }));
  const id = ok(await call(u, 'POST', '/api/auth/email/verify', { email: 'adm2fa@mail.ru', purpose: 'reg', code: r.devCode })).player.id;
  await pool.query(`UPDATE players SET role = 'admin' WHERE id = $1`, [id]);
  const v = anon();
  const l = ok(await call(v, 'POST', '/api/auth/email/login', { email: 'adm2fa@mail.ru', password: 'darts-2026' }));
  assert.equal(l.need2fa, 'setup');
  assert.equal(ok(await call(v, 'GET', '/api/me')).player, null);
  // новый пароль по письму: сеансы закрыты, вход — через код
  await forget('adm2fa@mail.ru');
  const s = ok(await call(v, 'POST', '/api/auth/email/send', { email: 'adm2fa@mail.ru', purpose: 'reset' }));
  const x = ok(await call(v, 'POST', '/api/auth/email/verify', { email: 'adm2fa@mail.ru', purpose: 'reset', code: s.devCode, password: 'Admin-Pass-2026' }));
  assert.equal(x.need2fa, 'setup');
  assert.equal(x.player, undefined);
  assert.equal(ok(await call(v, 'GET', '/api/me')).player, null);
  const T = require('../server/totp');
  const me = ok(await call(v, 'POST', '/api/auth/2fa', { ticket: x.ticket, code: T.codeAt(x.secret, Math.floor(Date.now() / 30000)) }));
  assert.equal(me.player.id, id);
  assert.equal(me.player.twofa, true);
});
