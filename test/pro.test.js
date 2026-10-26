// Тариф Pro: статистика, личные встречи, выгрузка, выходная музыка, без рекламы, значок PRO.
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
const dev = () => 'device_pro_' + String(++seq).padStart(8, '0');
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

const mid = () => 'g' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');

let TECH, ADMIN, MS, PL;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  TECH = await login(ME); ADMIN = await login('p4'); MS = await login('p3'); PL = await login('p6');
});
test.after(async () => { await app.close(); await pool.end(); });

test('без Pro: статистика, встречи, выгрузка и музыка закрыты', async () => {
  err(await call(MS, 'GET', '/api/me/pro'), 403);
  err(await call(MS, 'GET', '/api/players/p6/h2h'), 403);
  err(await call(MS, 'GET', '/api/me/export.csv'), 403);
  err(await call(MS, 'PATCH', '/api/me', { walkon: 'Песня' }), 403);
  const plans = ok(await call(null, 'GET', '/api/plans')).plans;
  assert.equal(plans.find(p => p.role === 'plus').name, 'Pro');
  assert.ok(plans.find(p => p.role === 'host').about.startsWith('Всё из Pro'));
  // Pro по умолчанию есть у роли plus, ведущего и администратора
  assert.deepEqual(ok(await call(TECH, 'GET', '/api/admin/perms')).perms.find(x => x.key === 'pro').roles, ['host', 'plus', 'admin']);
});

test('Pro: статистика по подходам, личные встречи, выгрузка', async () => {
  const plus = ok(await call(null, 'GET', '/api/plans')).plans.find(p => p.role === 'plus');
  ok(await call(ADMIN, 'POST', '/api/admin/plans/grant', { playerId: 'p3', planId: plus.id }));
  assert.ok(ok(await call(MS, 'GET', '/api/me')).perms.includes('pro'));
  // дружеский матч p3 — p6: 180, 180, (отменённый подход), 141 — закрытие; соперник по 60
  const id = mid();
  ok(await call(MS, 'PUT', '/api/matches/' + id, { mode: 501, ltw: 1, players: [{ id: 'p3' }, { id: 'p6' }] }), 201);
  const v = (p, s, pts) => ({ type: 'visit', leg: 1, p, s, pts, n: 3, b: 0, d: null });
  const evs = [v(0, 501, 180), v(1, 501, 60), v(0, 321, 180), v(1, 441, 60), v(0, 141, 100), { type: 'undo' }, v(0, 141, 141)];
  const pl = [{ id: 'p3', legs: 1, pts: 501, darts: 9, f9: 167, hi: 180, hco: 141, c180: 2, c140: 0, c100: 0, coh: 1, coa: 1, bl: 9 }, { id: 'p6', legs: 0, pts: 120, darts: 6, f9: 60, hi: 60, hco: 0, c180: 0, c140: 0, c100: 0, coh: 0, coa: 0, bl: 0 }];
  evs.push({ type: 'finish', w: 0, pl });
  ok(await call(MS, 'POST', '/api/matches/' + id + '/events', { events: evs.map((e, k) => Object.assign({ seq: k + 1 }, e)) }));
  const s = ok(await call(MS, 'GET', '/api/me/pro?period=30'));
  assert.equal(s.summary.n >= 1, true);
  const b = s.co.find(x => x.lo === 121);
  assert.deepEqual([b.att, b.hit, b.pct], [1, 1, 100], 'отменённый подход не считается');
  assert.deepEqual(s.top.find(x => x.s === 141), { s: 141, att: 1, hit: 1, pct: 100 });
  assert.equal(s.bands.find(x => x.label === '180').n, 2);
  assert.ok(s.form.length >= 1 && s.prev);
  err(await call(MS, 'GET', '/api/me/pro?period=7'), 400);
  assert.equal(ok(await call(MS, 'GET', '/api/me/pro?period=all')).prev, null);
  // личные встречи
  const h = ok(await call(MS, 'GET', '/api/players/p6/h2h'));
  assert.ok(h.n >= 1 && h.w >= 1);
  assert.equal(h.matches[0].id, id);
  err(await call(MS, 'GET', '/api/players/p3/h2h'), 400);
  err(await call(MS, 'GET', '/api/players/nope/h2h'), 404);
  // выгрузка
  const r = await app.inject({ method: 'GET', url: '/api/me/export.csv', headers: { cookie: MS.cookie } });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /text\/csv/);
  assert.ok(r.body.startsWith('﻿Дата;Турнир;Игра;Соперник;Счёт;Итог'));
  assert.ok(r.body.includes('дружеский;501;Тимур') || r.body.includes(';победа;'));
});

test('Pro: выходная музыка в составе турнира, значок PRO, без рекламы; лучшее среднее', async () => {
  ok(await call(MS, 'PATCH', '/api/me', { walkon: 'Seven Nation Army' }));
  assert.equal(ok(await call(MS, 'GET', '/api/me')).player.walkon, 'Seven Nation Army');
  const t = ok(await call(MS, 'POST', '/api/tournaments', { name: 'Pro-кубок', format: 'pl', mode: 501, ltw: 1, players: ['p3', 'p6', 'p9'] }), 201).tournament;
  assert.deepEqual([t.roster.p3.walkon, t.roster.p3.pro, t.roster.p6.pro], ['Seven Nation Army', true, false]);
  ok(await call(TECH, 'POST', '/api/admin/banners', { place: 'feed', title: 'Реклама' }), 201);
  ok(await call(TECH, 'POST', '/api/admin/banners', { place: 'tv', title: 'Реклама на табло' }), 201);
  assert.equal(ok(await call(MS, 'GET', '/api/banners?place=feed')).banners.length, 0);
  const tv = n => ok(n).banners.length;
  assert.equal(tv(await call(MS, 'GET', '/api/banners?place=tv')), tv(await call(PL, 'GET', '/api/banners?place=tv')), 'табло — для всех');
  assert.ok(tv(await call(PL, 'GET', '/api/banners?place=feed')) >= 1);
  assert.equal(typeof ok(await call(null, 'GET', '/api/players/p3')).bestAvg, 'number');
});
