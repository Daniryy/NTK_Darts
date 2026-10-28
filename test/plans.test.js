// Тарифы: скидка за звание, заявка, подключение и продление, окончание по сроку; свои роли.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');
const { sweepPlans } = require('../server/plans');

let app, seq = 0;
const anon = () => ({ dev: 'device_pln_' + String(++seq).padStart(10, '0'), cookie: '' });
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
const role = async id => ok(await call(null, 'GET', '/api/players/' + id)).player.role;

let TECH, ADMIN, HOST, MS, KMS, PL, plans;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  await pool.query(`UPDATE players SET title = 'МС' WHERE id = 'p3'; UPDATE players SET title = 'КМС' WHERE id = 'p5'; UPDATE players SET title = '1 разряд' WHERE id = 'p7'`);
  app = build({ logger: false });
  await app.ready();
  TECH = await login(ME); ADMIN = await login('p4'); HOST = await login('p1'); MS = await login('p3'); KMS = await login('p5'); PL = await login('p6');
});
test.after(async () => { await app.close(); await pool.end(); });

test('тарифы и цена со скидкой за звание', async () => {
  plans = ok(await call(null, 'GET', '/api/plans')).plans;
  assert.deepEqual(plans.map(p => [p.name, p.price, p.final, p.role]), [['Pro', 249, 249, 'plus'], ['Ведущий', 799, 799, 'host']]);
  const host = id => plans.find(p => p.role === 'host').id;
  const v = async u => ok(await call(u, 'GET', '/api/plans')).plans.find(p => p.role === 'host');
  assert.deepEqual([(await v(MS)).discount, (await v(MS)).final], [25, 599]);
  assert.deepEqual([(await v(KMS)).discount, (await v(KMS)).final], [10, 719]);
  assert.equal((await v(await login('p7'))).final, 759);
  assert.equal((await v(PL)).discount, 0);
  assert.ok(host());
});

test('заявка → подключение по заявке → роль тарифа; продление; завершение', async () => {
  const plus = plans.find(p => p.role === 'plus');
  const rq = ok(await call(MS, 'POST', '/api/plans/' + plus.id + '/request'), 201).request;
  assert.equal(rq.status, 'requested');
  assert.equal(rq.price, 187, 'Игрок+ со скидкой 25%');
  err(await call(MS, 'POST', '/api/plans/' + plus.id + '/request'), 409);
  err(await call(HOST, 'GET', '/api/admin/plans'), 403);
  const adm = ok(await call(ADMIN, 'GET', '/api/admin/plans'));
  assert.equal(adm.requests.length, 1);
  assert.equal(adm.requests[0].player.id, 'p3');
  const sub = ok(await call(ADMIN, 'POST', '/api/admin/plans/grant', { requestId: adm.requests[0].id })).sub;
  assert.equal(sub.status, 'active');
  assert.ok(Math.abs(sub.ends - Date.now() - 30 * 864e5) < 60000);
  assert.equal(await role('p3'), 'plus');
  assert.equal(ok(await call(MS, 'GET', '/api/me')).role, 'plus');
  assert.equal(ok(await call(ADMIN, 'GET', '/api/admin/plans')).requests.length, 0);
  // продление: тот же тариф — срок прибавляется к концу
  const ext = ok(await call(ADMIN, 'POST', '/api/admin/plans/grant', { playerId: 'p3', planId: plus.id, days: 10 })).sub;
  assert.equal(ext.id, sub.id);
  assert.equal(ext.ends, sub.ends + 10 * 864e5);
  // завершить сейчас — роль игрока
  ok(await call(ADMIN, 'POST', '/api/admin/plans/subs/' + sub.id + '/end'));
  assert.equal(await role('p3'), 'player');
  const log = ok(await call(ADMIN, 'GET', '/api/admin/audit')).items.map(x => x.action);
  assert.ok(['plan.request', 'plan.grant', 'plan.extend', 'plan.end'].every(a => log.includes(a)));
});

test('окончание по сроку: роль снимается сама; роль, выданная вручную, остаётся', async () => {
  const host = plans.find(p => p.role === 'host'), plus = plans.find(p => p.role === 'plus');
  ok(await call(ADMIN, 'POST', '/api/admin/plans/grant', { playerId: 'p6', planId: host.id }));
  assert.equal(await role('p6'), 'host');
  // ведущий (роль выдана вручную) с «Игрок+» остаётся ведущим
  ok(await call(ADMIN, 'POST', '/api/admin/plans/grant', { playerId: 'p1', planId: plus.id }));
  assert.equal(await role('p1'), 'host');
  await pool.query(`UPDATE player_plans SET ends = $1 WHERE status = 'active'`, [Date.now() - 1000]);
  assert.equal(await tx(sweepPlans), 2);
  assert.equal(await role('p6'), 'player');
  assert.equal(await role('p1'), 'host');
  // отказ в заявке
  const rq = ok(await call(PL, 'POST', '/api/plans/' + host.id + '/request'), 201).request;
  ok(await call(ADMIN, 'POST', '/api/admin/plans/requests/' + rq.id + '/reject', { note: 'Сначала зарегистрируйте клуб' }));
  assert.equal(ok(await call(PL, 'GET', '/api/plans')).request, null);
  // отозвать свою
  const rq2 = ok(await call(PL, 'POST', '/api/plans/' + plus.id + '/request'), 201).request;
  ok(await call(PL, 'DELETE', '/api/plans/requests/' + rq2.id));
  err(await call(PL, 'DELETE', '/api/plans/requests/' + rq2.id), 404);
});

test('тех. администратор: тарифы, скидки, свои роли', async () => {
  err(await call(ADMIN, 'POST', '/api/admin/plans', { name: 'Старт', price: 199, days: 30, role: 'plus' }), 403);
  err(await call(TECH, 'POST', '/api/admin/plans', { name: 'Админ', price: 1, days: 30, role: 'admin' }), 400);
  // своя роль для нового тарифа
  const r = ok(await call(TECH, 'POST', '/api/admin/roles', { name: 'Игрок Про' }), 201).role;
  assert.equal(r.rank, 1);
  err(await call(TECH, 'POST', '/api/admin/roles', { name: 'игрок про' }), 409);
  assert.ok(ok(await call(null, 'GET', '/api/roles')).roles.some(x => x.key === r.key && x.name === 'Игрок Про'));
  assert.ok(ok(await call(TECH, 'GET', '/api/admin/perms')).roles.some(x => x.key === r.key));
  const p = ok(await call(TECH, 'POST', '/api/admin/plans', { name: 'Про', price: 499, days: 30, role: r.key, about: 'Всё\nи ещё' }), 201).plan;
  ok(await call(TECH, 'PATCH', '/api/admin/plans/' + p.id, { price: 449 }));
  assert.equal(ok(await call(null, 'GET', '/api/plans')).plans.find(x => x.id === p.id).price, 449);
  // роль с тарифом не удалить; переименовать можно
  err(await call(TECH, 'DELETE', '/api/admin/roles/' + r.key), 409);
  ok(await call(TECH, 'PATCH', '/api/admin/roles/' + r.key, { name: 'Про' }));
  err(await call(TECH, 'DELETE', '/api/admin/roles/host'), 409);
  // права своей роли настраиваются как у остальных
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { host_nums: ['host', 'admin', r.key] } }));
  ok(await call(ADMIN, 'POST', '/api/admin/plans/grant', { playerId: 'p9', planId: p.id }));
  assert.equal(await role('p9'), r.key);
  ok(await call(await login('p9'), 'GET', '/api/host/nums'));
  // скидки
  err(await call(ADMIN, 'PUT', '/api/admin/discounts', { ms: 50, kms: 0, r1: 0 }), 403);
  ok(await call(TECH, 'PUT', '/api/admin/discounts', { ms: 30, kms: 15, r1: 0 }));
  const v = ok(await call(MS, 'GET', '/api/plans')).plans.find(x => x.id === p.id);
  assert.deepEqual([v.discount, v.final], [30, 314]);
  err(await call(TECH, 'PUT', '/api/admin/discounts', { ms: 95 }), 400);
});
