// Найденное при проверке: привязка по коду, коды ведущего, формат с квалификацией, роль вручную и тариф.
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
const dev = () => 'device_fix_' + String(++seq).padStart(8, '0');
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


test('привязка по коду: аккаунт с ролью, званием, клубом или тарифом не растворяется', async () => {
  const code = async () => ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Гость ' + seq }), 201).player.claim;
  // ведущий клуба (роль, клуб, номера) — нельзя
  err(await call(HOST, 'POST', '/api/me/claim', { code: await code() }), 409, 'conflict');
  assert.equal(ok(await call(HOST, 'GET', '/api/me')).player.id, 'p1');
  // игрок с подтверждённым званием — нельзя
  const u = anon();
  const sent = ok(await call(u, 'POST', '/api/auth/phone', { phone: '+79990001101' }));
  const fresh = ok(await call(u, 'POST', '/api/auth/phone/verify', { phone: '+79990001101', code: sent.devCode }));
  await pool.query(`UPDATE players SET title = 'КМС' WHERE id = $1`, [fresh.player.id]);
  const { clearCache } = require('../server/auth'); clearCache();
  err(await call(u, 'POST', '/api/me/claim', { code: await code() }), 409, 'conflict');
  // пустой новый аккаунт — можно, как раньше
  await pool.query(`UPDATE players SET title = '' WHERE id = $1`, [fresh.player.id]); clearCache();
  const c = await code();
  const me = ok(await call(u, 'POST', '/api/me/claim', { code: c }));
  assert.notEqual(me.player.id, fresh.player.id);
  assert.equal(me.player.phone, '+79990001101');
});

test('ведущий не выпускает новый код аккаунту, который входит по телефону; администратор может', async () => {
  const p = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Сам Входит', phone: '+79990001102' }), 201).player;
  ok(await call(HOST, 'PATCH', '/api/admin/players/' + p.id, { city: 'Тверь' }));
  err(await call(HOST, 'PATCH', '/api/admin/players/' + p.id, { claim: true }), 403, 'forbidden');
  assert.match(ok(await call(ADMIN, 'PATCH', '/api/admin/players/' + p.id, { claim: true })).player.claim, /^[A-Z2-9]{8}$/);
});

test('смена формата не оставляет квалификацию у ko и rr', async () => {
  const t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'С квалой', format: 'pl', mode: 501, ltw: 2, reg: true, cap: 16, qual: { ex: { k: 'score', lim: 3 }, tries: 2 } }), 201).tournament;
  err(await call(HOST, 'PATCH', '/api/tournaments/' + t.id, { format: 'ko' }), 400);
  err(await call(HOST, 'PATCH', '/api/tournaments/' + t.id, { format: 'rr', cap: 10 }), 400);
  ok(await call(HOST, 'PATCH', '/api/tournaments/' + t.id, { format: 'ko', qual: null, split: null }));
});

test('роль, выданная вручную, возвращается после тарифа', async () => {
  const plans = ok(await call(null, 'GET', '/api/plans')).plans, plus = plans.find(p => p.role === 'plus');
  ok(await call(ADMIN, 'PATCH', '/api/admin/players/p9', { role: 'host' }));
  ok(await call(ADMIN, 'POST', '/api/admin/plans/grant', { playerId: 'p9', planId: plus.id }));
  assert.equal(ok(await call(null, 'GET', '/api/players/p9')).player.role, 'host', 'ведущий с «Игрок+» остаётся ведущим');
  const sub = ok(await call(ADMIN, 'GET', '/api/admin/players/p9/plans')).subs.find(s => s.status === 'active');
  ok(await call(ADMIN, 'POST', '/api/admin/plans/subs/' + sub.id + '/end'));
  assert.equal(ok(await call(null, 'GET', '/api/players/p9')).player.role, 'host', 'после тарифа — роль, выданная вручную');
  // игроку без ручной роли тариф даёт и снимает свою роль
  ok(await call(ADMIN, 'POST', '/api/admin/plans/grant', { playerId: 'p10', planId: plus.id }));
  assert.equal(ok(await call(null, 'GET', '/api/players/p10')).player.role, 'plus');
  await pool.query(`UPDATE player_plans SET ends = $1 WHERE player_id = 'p10' AND status = 'active'`, [Date.now() - 1]);
  await tx(require('../server/plans').sweepPlans);
  assert.equal(ok(await call(null, 'GET', '/api/players/p10')).player.role, 'player');
  // снять ручную роль — снова игрок
  ok(await call(ADMIN, 'PATCH', '/api/admin/players/p9', { role: 'player' }));
  assert.equal(ok(await call(null, 'GET', '/api/players/p9')).player.role, 'player');
});

test('рейтинг честно: итог без игры вносит только организатор; Эло — только официальные турниры', async () => {
  const rat = async ids => (await pool.query('SELECT id, rating, rated FROM players WHERE id = ANY($1) ORDER BY id', [ids])).rows.map(x => x.rating + '/' + x.rated).join(' ');
  const ids = ['p6', 'p7', 'p8', 'p9'];
  const t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Дружеский кубок', format: 'ko', mode: 501, ltw: 1, players: ids }), 201).tournament;
  assert.equal(t.official, false);
  const g = t.games.find(x => x.r === 0 && [x.a, x.b].includes('p6')) || t.games.find(x => x.r === 0);
  const before = await rat(ids);
  // игрок пары — только сыграть в счётчике
  err(await call(PL, 'POST', '/api/tournaments/' + t.id + '/games/0/' + g.i + '/result', { la: 1, lb: 0 }), 403);
  ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/0/' + g.i + '/result', { la: 1, lb: 0 }));
  assert.equal(await rat(ids), before, 'неофициальный турнир не меняет Эло');
  const o = ok(await call(TECH, 'POST', '/api/tournaments', { name: 'Официальный кубок', official: true, format: 'ko', mode: 501, ltw: 1, players: ids }), 201).tournament;
  assert.equal(o.official, true);
  const og = o.games.find(x => x.r === 0);
  ok(await call(TECH, 'POST', '/api/tournaments/' + o.id + '/games/0/' + og.i + '/result', { la: 1, lb: 0 }));
  assert.notEqual(await rat(ids), before, 'официальный — меняет');
  // полный пересчёт даёт то же самое
  const now = await rat(ids);
  await tx(require('../server/stats').eloAll);
  assert.equal(await rat(ids), now);
});
