// Роли, клубы, вход по телефону и по коду от ведущего, номера ведущего, баннеры.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');

let app, seq = 0;
const dev = () => 'device_role_' + String(++seq).padStart(8, '0');
const anon = () => ({ dev: dev(), cookie: '' });
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
  app = build({ logger: false });
  await app.ready();
  TECH = await login(ME); ADMIN = await login('p4'); HOST = await login('p1'); PL = await login('p6');
});
test.after(async () => { await app.close(); await pool.end(); });

test('кто я: роль и клубы', async () => {
  const t = ok(await call(TECH, 'GET', '/api/me'));
  assert.equal(t.role, 'tech');
  assert.equal(t.admin, true);
  const h = ok(await call(HOST, 'GET', '/api/me'));
  assert.equal(h.role, 'host');
  assert.equal(h.admin, false);
  assert.deepEqual(h.clubs, [{ id: 'c1', name: 'Клуб «Тройная двадцатка»' }]);
  assert.equal(ok(await call(PL, 'GET', '/api/me')).role, 'player');
  assert.equal(ok(await call(null, 'GET', '/api/players/p1')).player.role, 'host');
});

test('вход по телефону: код из SMS, новый игрок, лимиты, неверный код', async () => {
  const u = anon();
  err(await call(u, 'POST', '/api/auth/phone', { phone: '123' }), 400);
  const s1 = ok(await call(u, 'POST', '/api/auth/phone', { phone: '8 (912) 345-67-89' }));
  assert.equal(s1.wait, 60);
  assert.match(s1.devCode, /^\d{4}$/);
  assert.equal(s1.method, 'call');
  assert.equal(s1.digits, 4);
  const again = err(await call(u, 'POST', '/api/auth/phone', { phone: '+79123456789' }), 429, 'too_many');
  assert.ok(again.retryAfter > 0);
  const wrong = s1.devCode === '0000' ? '1111' : '0000';
  err(await call(u, 'POST', '/api/auth/phone/verify', { phone: '+79123456789', code: wrong }), 409, 'bad_code');
  const r = ok(await call(u, 'POST', '/api/auth/phone/verify', { phone: '89123456789', code: s1.devCode }));
  assert.equal(r.created, true);
  assert.equal(r.player.phone, '+79123456789');
  assert.equal(r.player.name, 'Игрок 6789');
  assert.equal(ok(await call(u, 'GET', '/api/me')).player.id, r.player.id);
  // код одноразовый
  err(await call(anon(), 'POST', '/api/auth/phone/verify', { phone: '+79123456789', code: s1.devCode }), 409, 'code_expired');
  // повторный вход тем же номером — тот же игрок
  await pool.query('DELETE FROM sms_log');
  const v = anon(), s2 = ok(await call(v, 'POST', '/api/auth/phone', { phone: '+7 912 345 67 89' }));
  const r2 = ok(await call(v, 'POST', '/api/auth/phone/verify', { phone: '+79123456789', code: s2.devCode }));
  assert.equal(r2.created, false);
  assert.equal(r2.player.id, r.player.id);
  // пять неверных попыток — код сгорает
  const w = anon(), phone = '+79990000001', s3 = ok(await call(w, 'POST', '/api/auth/phone', { phone }));
  const bad = s3.devCode === '1234' ? '4321' : '1234';
  // у кода звонка 3 попытки
  for (let k = 0; k < 3; k++) err(await call(w, 'POST', '/api/auth/phone/verify', { phone, code: bad }), 409, 'bad_code');
  err(await call(w, 'POST', '/api/auth/phone/verify', { phone, code: s3.devCode }), 409, 'code_expired');
  err(await call(w, 'POST', '/api/auth/phone/verify', { phone, code: '12' }), 400);
});

test('привязка телефона к своему аккаунту и отвязка', async () => {
  const u = await login('p11'), phone = '+79990000011';
  const s = ok(await call(u, 'POST', '/api/auth/phone', { phone }));
  const r = ok(await call(u, 'POST', '/api/auth/phone/verify', { phone, code: s.devCode, link: true }));
  assert.equal(r.player.id, 'p11');
  assert.equal(r.player.phone, phone);
  // занятый номер к другому аккаунту не привязать
  const o = await login('p12');
  await pool.query('DELETE FROM sms_log');
  const s2 = ok(await call(o, 'POST', '/api/auth/phone', { phone }));
  err(await call(o, 'POST', '/api/auth/phone/verify', { phone, code: s2.devCode, link: true }), 409, 'phone_taken');
  // единственный способ входа не отвязать
  err(await call(u, 'DELETE', '/api/me/login/phone'), 409);
  await pool.query(`UPDATE players SET vk_id = 900011 WHERE id = 'p11'`);
  const un = ok(await call(u, 'DELETE', '/api/me/login/phone'));
  assert.equal(un.player.phone, null);
  assert.equal(un.player.vk, true);
});

test('ведущий заводит аккаунт: вход по коду, только свои аккаунты, номер в списке', async () => {
  err(await call(PL, 'POST', '/api/admin/players', { name: 'Баба Валя' }), 403);
  const p = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Валентина Петровна', city: 'Москва', n: 12 }), 201).player;
  assert.equal(p.owner, 'p1');
  assert.match(p.claim, /^[A-HJ-NP-Z2-9]{8}$/);
  // ведущий видит только свои аккаунты, администратор — всех
  const mine = ok(await call(HOST, 'GET', '/api/admin/players')).players;
  assert.ok(mine.length >= 1 && mine.every(x => x.owner === 'p1'));
  assert.ok(ok(await call(ADMIN, 'GET', '/api/admin/players?q=валентина')).players.some(x => x.id === p.id));
  // чужой аккаунт ведущему не править, роль не выдать
  err(await call(HOST, 'PATCH', '/api/admin/players/p6', { name: 'Взлом' }), 403);
  err(await call(HOST, 'PATCH', '/api/admin/players/' + p.id, { ver: true }), 403);
  ok(await call(HOST, 'PATCH', '/api/admin/players/' + p.id, { city: 'Подольск' }));
  err(await call(HOST, 'PATCH', '/api/admin/players/' + p.id, { title: '2 разряд' }), 403, 'forbidden'); // звание — только по заявке
  // номер 12 в списке ведущего
  const nums = ok(await call(HOST, 'GET', '/api/host/nums')).nums;
  assert.deepEqual(nums.map(x => [x.n, x.player.id]), [[12, p.id]]);
  // вход на телефоне бабушки по коду
  const g = anon();
  err(await call(g, 'POST', '/api/auth/code', { code: 'ZZZZZZZZ' }), 404);
  const me = ok(await call(g, 'POST', '/api/auth/code', { code: p.claim.toLowerCase() }));
  assert.equal(me.player.id, p.id);
  assert.equal(ok(await call(g, 'GET', '/api/me')).player.name, 'Валентина Петровна');
  err(await call(anon(), 'POST', '/api/auth/code', { code: p.claim }), 404, 'not_found'); // одноразовый
  // новый код выдаёт ведущий
  const c2 = ok(await call(HOST, 'PATCH', '/api/admin/players/' + p.id, { claim: true })).player.claim;
  ok(await call(anon(), 'POST', '/api/auth/code', { code: c2 }));
  // игрок привязал VK — аккаунт больше не правит ведущий
  await pool.query('UPDATE players SET vk_id = 900021 WHERE id = $1', [p.id]);
  err(await call(HOST, 'PATCH', '/api/admin/players/' + p.id, { name: 'Другое имя' }), 403);
  // с телефоном при создании
  const q = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Пётр Ильич', phone: '89990000077' }), 201).player;
  assert.equal(q.phone, '+79990000077');
  err(await call(HOST, 'POST', '/api/admin/players', { name: 'Двойник', phone: '+79990000077' }), 409, 'phone_taken');
});

test('номера ведущего: назначить, перенести, убрать; игроку недоступно', async () => {
  err(await call(PL, 'GET', '/api/host/nums'), 403);
  ok(await call(HOST, 'PUT', '/api/host/nums/1', { playerId: 'p6' }));
  ok(await call(HOST, 'PUT', '/api/host/nums/2', { playerId: 'p9' }));
  // номер 1 переходит к p9, у p9 был 2 — освобождается
  let nums = ok(await call(HOST, 'PUT', '/api/host/nums/1', { playerId: 'p9' })).nums;
  assert.deepEqual(nums.filter(x => x.n < 10).map(x => [x.n, x.player.id]), [[1, 'p9']]);
  nums = ok(await call(HOST, 'DELETE', '/api/host/nums/1')).nums;
  assert.ok(!nums.some(x => x.n === 1));
  err(await call(HOST, 'PUT', '/api/host/nums/0', { playerId: 'p9' }), 400);
  err(await call(HOST, 'PUT', '/api/host/nums/5', { playerId: 'p999' }), 404);
});

test('роли: администратор выдаёт ведущего, тех. администратор — администратора; блокировка', async () => {
  err(await call(HOST, 'PATCH', '/api/admin/players/p7', { role: 'host' }), 403);
  assert.equal(ok(await call(ADMIN, 'PATCH', '/api/admin/players/p7', { role: 'host' })).player.role, 'host');
  err(await call(ADMIN, 'PATCH', '/api/admin/players/p7', { role: 'admin' }), 403);
  err(await call(ADMIN, 'PATCH', '/api/admin/players/' + ME, { name: 'Взлом' }), 403, 'forbidden');
  err(await call(ADMIN, 'PATCH', '/api/admin/players/p4', { role: 'tech' }), 409);
  assert.equal(ok(await call(TECH, 'PATCH', '/api/admin/players/p7', { role: 'admin' })).player.role, 'admin');
  ok(await call(TECH, 'PATCH', '/api/admin/players/p7', { role: 'player' }));
  assert.equal(ok(await call(ADMIN, 'GET', '/api/admin/players?role=tech')).players.map(x => x.id).join(), ME);
  // блокировка: сессии закрыты, вход запрещён
  const V = await login('p8');
  ok(await call(ADMIN, 'PATCH', '/api/admin/players/p8', { blocked: true }));
  assert.equal(ok(await call(V, 'GET', '/api/me')).player, null);
  err(await call(anon(), 'POST', '/api/auth/dev', { playerId: 'p8' }), 403);
  ok(await call(ADMIN, 'PATCH', '/api/admin/players/p8', { blocked: false }));
  ok(await call(anon(), 'POST', '/api/auth/dev', { playerId: 'p8' }));
  // сводка — только администратору
  err(await call(HOST, 'GET', '/api/admin/stats'), 403);
  const st = ok(await call(ADMIN, 'GET', '/api/admin/stats'));
  assert.equal(st.clubsPending, 1);
  assert.ok(st.players >= 64);
  assert.equal(st.roles.tech, 1);
});

test('клуб: заявка, подтверждение; роль ведущего — только по тарифу; турнир от клуба, камеры, закрытие', async () => {
  const U = await login('p10');
  const c = ok(await call(U, 'POST', '/api/clubs', { name: 'Казанский дротик', city: 'Казань', contact: '+7 843 000-00-00' }), 201).club;
  assert.equal(c.status, 'pending');
  err(await call(U, 'POST', '/api/clubs', { name: 'Ещё один' }), 409);
  err(await call(PL, 'POST', '/api/clubs', { name: 'казанский ДРОТИК' }), 409);
  assert.equal(ok(await call(U, 'GET', '/api/clubs/mine')).clubs[0].id, c.id);
  err(await call(HOST, 'GET', '/api/admin/clubs'), 403);
  assert.ok(ok(await call(ADMIN, 'GET', '/api/admin/clubs?status=pending')).clubs.some(x => x.id === c.id));
  // до подтверждения турнир от клуба и камеры недоступны
  const t0 = ok(await call(U, 'POST', '/api/tournaments', { name: 'Пробный', format: 'pl', mode: 501, ltw: 1, players: ['p10', 'p3', 'p5'] }), 201).tournament;
  assert.equal(t0.can.stream, false);
  err(await call(U, 'PATCH', '/api/tournaments/' + t0.id + '/streams', { streams: [{ url: 'https://vk.com/video-1_2' }] }), 403);
  err(await call(U, 'POST', '/api/tournaments', { name: 'От клуба', clubId: c.id, format: 'pl', mode: 501, ltw: 1, players: ['p10', 'p3', 'p5'] }), 404);
  // подтверждение
  const a = ok(await call(ADMIN, 'PATCH', '/api/admin/clubs/' + c.id, { status: 'active' })).club;
  assert.deepEqual(a.hosts.map(h => h.id), ['p10']);
  let me = ok(await call(U, 'GET', '/api/me'));
  assert.equal(me.role, 'player', 'клуб сам роль не даёт');
  assert.deepEqual(me.clubs.map(x => x.id), [c.id]);
  assert.ok(ok(await call(null, 'GET', '/api/clubs')).clubs.some(x => x.id === c.id));
  // без тарифа: турнира от клуба нет, инструменты клуба закрыты
  err(await call(U, 'POST', '/api/tournaments', { name: 'От клуба', clubId: c.id, format: 'pl', mode: 501, ltw: 1, players: ['p10', 'p3', 'p5'] }), 403);
  const page = ok(await call(U, 'GET', '/api/clubs/' + c.id));
  assert.equal(page.manage, true); assert.equal(page.tools, false);
  // тариф «Ведущий» — роль ведущего
  const hostPlan = ok(await call(null, 'GET', '/api/plans')).plans.find(p => p.role === 'host');
  ok(await call(ADMIN, 'POST', '/api/admin/plans/grant', { playerId: 'p10', planId: hostPlan.id }));
  me = ok(await call(U, 'GET', '/api/me'));
  assert.equal(me.role, 'host');
  assert.equal(ok(await call(U, 'GET', '/api/clubs/' + c.id)).tools, true);
  const t = ok(await call(U, 'POST', '/api/tournaments', { name: 'От клуба', clubId: c.id, format: 'pl', mode: 501, ltw: 1, players: ['p10', 'p3', 'p5'] }), 201).tournament;
  assert.equal(t.official, true);
  assert.deepEqual(t.org, { id: 'p10', name: 'Казанский дротик', ver: true, club: c.id, logo: null });
  assert.equal(t.can.stream, true);
  ok(await call(U, 'PATCH', '/api/tournaments/' + t.id + '/streams', { streams: [{ url: 'https://vk.com/video-1_2' }] }));
  // чужой клуб в турнир не подставить
  err(await call(HOST, 'POST', '/api/tournaments', { name: 'Чужой', clubId: c.id, format: 'pl', mode: 501, ltw: 1, players: ['p1', 'p3', 'p5'] }), 403);
  // второй ведущий клуба без тарифа роли не получает
  ok(await call(ADMIN, 'POST', '/api/admin/clubs/' + c.id + '/hosts', { playerId: 'p14' }));
  assert.equal(ok(await call(null, 'GET', '/api/players/p14')).player.role, 'player');
  ok(await call(ADMIN, 'DELETE', '/api/admin/clubs/' + c.id + '/hosts/p14'));
  // закрытие клуба тариф не трогает
  ok(await call(ADMIN, 'PATCH', '/api/admin/clubs/' + c.id, { status: 'closed', note: 'Клуб закрылся' }));
  assert.equal(ok(await call(U, 'GET', '/api/me')).role, 'host');
  // отказ в заявке
  const P9 = await login('p9');
  ok(await call(ADMIN, 'PATCH', '/api/admin/clubs/c3', { status: 'rejected', note: 'Нет адреса' }));
  assert.equal(ok(await call(P9, 'GET', '/api/me')).role, 'player');
  assert.equal(ok(await call(P9, 'GET', '/api/clubs/mine')).clubs[0].note, 'Нет адреса');
});

test('баннеры: ведёт тех. администратор, показ по месту и времени, переходы', async () => {
  err(await call(ADMIN, 'POST', '/api/admin/banners', { place: 'feed', title: 'x' }), 403);
  err(await call(TECH, 'POST', '/api/admin/banners', { place: 'feed', title: 'x', link: 'javascript:alert(1)' }), 400);
  const b = ok(await call(TECH, 'POST', '/api/admin/banners', { place: 'tour', title: 'Магазин дротиков', body: 'Скидка участникам', link: 'https://example.com/darts' }), 201).banner;
  const later = ok(await call(TECH, 'POST', '/api/admin/banners', { place: 'tour', title: 'Позже', starts: Date.now() + 864e5 }), 201).banner;
  const list = ok(await call(null, 'GET', '/api/banners?place=tour')).banners;
  assert.deepEqual(list.map(x => x.id), [b.id]);
  assert.equal(list[0].clicks, undefined, 'счётчик видит только тех. администратор');
  ok(await call(anon(), 'POST', '/api/banners/' + b.id + '/click'));
  ok(await call(anon(), 'POST', '/api/banners/' + b.id + '/click'));
  assert.equal(ok(await call(TECH, 'GET', '/api/admin/banners')).banners.find(x => x.id === b.id).clicks, 2);
  ok(await call(TECH, 'PATCH', '/api/admin/banners/' + b.id, { active: false }));
  assert.equal(ok(await call(null, 'GET', '/api/banners?place=tour')).banners.length, 0);
  ok(await call(TECH, 'DELETE', '/api/admin/banners/' + later.id));
  err(await call(TECH, 'DELETE', '/api/admin/banners/' + later.id), 404);
  err(await call(null, 'GET', '/api/banners?place=nowhere'), 400);
});
