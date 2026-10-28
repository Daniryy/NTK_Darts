// Рейтинг: области по городам, поиск по городу и области, страницы; клуб в профиле — из зарегистрированных.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed } = require('../db/seed');
const R = require('../server/regions');

let app, seq = 0;
const anon = () => ({ dev: 'device_rate_' + String(++seq).padStart(10, '0'), cookie: '' });
async function call(u, method, url, body) {
  const headers = {};
  if (u) { headers['x-device-id'] = u.dev; if (u.cookie) headers.cookie = u.cookie; }
  const r = await app.inject({ method, url, payload: body, headers });
  const sid = r.cookies.find(c => c.name === 'oche_sid');
  if (u && sid) u.cookie = 'oche_sid=' + sid.value;
  return { s: r.statusCode, b: r.body ? JSON.parse(r.body) : null };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
const err = (r, code) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b.error; };
async function login(playerId) { const u = anon(); ok(await call(u, 'POST', '/api/auth/dev', { playerId })); return u; }
const q = s => encodeURIComponent(s);

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  // 150 игроков в рейтинге из разных городов, часть — с «г.» и «ё»
  await pool.query(`INSERT INTO players (id, name, handle, code, city, rating, rated, created_at)
    SELECT 'r' || g, 'Рейтинг ' || g, 'rate_' || g, 'OCH-' || (9000 + g), (ARRAY['Екатеринбург', 'г. Нижний Тагил', 'Тюмень', 'Орёл', 'Хутор Ромашка'])[1 + g % 5], 1300 + g, 1, 0
    FROM generate_series(1, 150) g`);
  app = build({ logger: false });
  await app.ready();
});
test.after(async () => { await app.close(); await pool.end(); });

test('справочник областей: город → область без регистра, «г.» и «ё»', () => {
  assert.equal(R.regionOf('Новоуральск'), 'Свердловская область');
  assert.equal(R.regionOf(' г. Нижний Тагил '), 'Свердловская область');
  assert.equal(R.regionOf('ОРЕЛ'), 'Орловская область');
  assert.equal(R.regionOf('Хутор Ромашка'), null);
  assert.deepEqual(R.findRegions('свердловская область'), ['Свердловская область']);
  assert.deepEqual(R.findRegions('св'), [], 'короче 3 букв — не ищем');
});

test('рейтинг: страницы по 100, номера мест продолжаются', async () => {
  const p1 = ok(await call(null, 'GET', '/api/rating?limit=100'));
  const p2 = ok(await call(null, 'GET', '/api/rating?limit=100&offset=100'));
  assert.equal(p1.rows.length, 100);
  assert.equal(p2.rows[0].rank, 101);
  assert.equal(p1.total, p2.total);
  assert.ok(p1.total > 150);
  assert.ok(!p2.rows.some(x => p1.rows.some(y => y.id === x.id)), 'страницы не повторяются');
});

test('рейтинг: фильтр по области, поиск по городу и области, список областей', async () => {
  const all = ok(await call(null, 'GET', '/api/rating?limit=200'));
  const sv = all.regions.find(x => x.name === 'Свердловская область');
  assert.ok(sv && sv.n >= 60, 'Екатеринбург и Нижний Тагил — одна область');
  const reg = ok(await call(null, 'GET', '/api/rating?limit=200&region=' + q('Свердловская область')));
  assert.equal(reg.total, sv.n);
  assert.ok(reg.rows.every(x => x.region === 'Свердловская область'));
  const byRegion = ok(await call(null, 'GET', '/api/rating?limit=200&q=' + q('свердловская обл')));
  assert.equal(byRegion.total, sv.n);
  const byCity = ok(await call(null, 'GET', '/api/rating?limit=200&q=' + q('тюмен')));
  assert.ok(byCity.total >= 30 && byCity.rows.every(x => x.city === 'Тюмень'));
  const noReg = ok(await call(null, 'GET', '/api/rating?limit=200&q=' + q('ромашка')));
  assert.ok(noReg.total >= 30 && noReg.rows.every(x => x.region === null), 'город вне справочника находится по названию');
  assert.ok(ok(await call(null, 'GET', '/api/regions')).regions.length > 80);
});

test('профиль: клуб — только из зарегистрированных, прежнее значение можно оставить', async () => {
  const P = await login('p20');
  err(await call(P, 'PATCH', '/api/me', { club: 'Мой гаражный клуб' }), 400);
  const r = ok(await call(P, 'PATCH', '/api/me', { club: 'Клуб «Тройная двадцатка»' }));
  assert.equal(r.player.club, 'Клуб «Тройная двадцатка»');
  ok(await call(P, 'PATCH', '/api/me', { club: '' }));
  // у кого клуб был вписан раньше — сохранение профиля его не сбрасывает
  await pool.query(`UPDATE players SET club = 'Старый клуб' WHERE id = 'p20'`);
  ok(await call(P, 'PATCH', '/api/me', { name: 'Игрок Двадцать', club: 'Старый клуб' }));
});
