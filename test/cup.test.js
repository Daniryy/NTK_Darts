// Больше 64 участников: с квалификацией — до 128; основная сетка — первые 64 (или 8/16/32),
// остальные сами уходят в «Кубок B» со сквозными местами (65, 66…), которые видны и в основном турнире.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');
const B = require('../shared/bracket.js');

let app, seq = 0;
const anon = () => ({ dev: 'device_cup_' + String(++seq).padStart(8, '0'), cookie: '' });
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
const QUAL = { ex: { k: 'score', lim: 10 }, tries: 1 };

let TECH, ids;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  TECH = await login(ME);
  ids = (await pool.query('SELECT id FROM players ORDER BY id')).rows.map(r => r.id);
  for (let k = ids.length; k < 90; k++) ids.push(ok(await call(TECH, 'POST', '/api/admin/players', { name: 'Игрок ' + k }), 201).player.id);
});
test.after(async () => { await app.close(); await pool.end(); });

test('лимиты: без отбора — 64, с квалификацией — 128; в «Кубок B» — не больше 64', async () => {
  const base = { name: 'Большой', format: 'ko', mode: 501, ltw: 1 };
  err(await call(TECH, 'POST', '/api/tournaments', Object.assign({ players: ids.slice(0, 70) }, base)), 400);
  err(await call(TECH, 'POST', '/api/tournaments', Object.assign({ reg: true, cap: 129, qual: QUAL }, base)), 400);
  err(await call(TECH, 'POST', '/api/tournaments', Object.assign({ players: ids.slice(0, 90), qual: Object.assign({ main: 16 }, QUAL) }, base)), 400);
  err(await call(TECH, 'POST', '/api/tournaments', Object.assign({ players: ids.slice(0, 20), qual: Object.assign({ main: 12 }, QUAL) }, base)), 400);
  err(await call(TECH, 'POST', '/api/tournaments', Object.assign({ players: ids.slice(0, 10), format: 'rr', qual: Object.assign({ main: 8 }, QUAL) }, base, { format: 'rr' })), 400);
  // регистрация до 128 мест — основная сетка 64 сама
  const r = ok(await call(TECH, 'POST', '/api/tournaments', Object.assign({ reg: true, cap: 128, qual: QUAL }, base)), 201).tournament;
  assert.equal(r.cap, 128); assert.equal(r.qual.main, 64);
});

test('72 участника: сетка на 64, «Кубок B» на 8 с местами 65–72 — и в основном турнире', async () => {
  const pl = ids.slice(0, 72);
  let t = ok(await call(TECH, 'POST', '/api/tournaments', { name: 'Кубок 72', format: 'ko', mode: 501, ltw: 1, players: pl, qual: QUAL }), 201).tournament;
  assert.equal(t.qual.main, 64); assert.equal(t.stage, 'qual');
  // результат квалификации: чем раньше в списке, тем больше очков
  for (const [k, id] of pl.entries()) ok(await call(TECH, 'PUT', '/api/tournaments/' + t.id + '/qual/' + id + '/0', { v: 1000 - k }));
  // все сдали — квалификация закрылась сама
  t = ok(await call(null, 'GET', '/api/tournaments/' + t.id)).tournament;
  assert.equal(t.stage, undefined);
  const inB = t.slots.filter(B.isReal);
  assert.equal(inB.length, 64);
  assert.deepEqual(inB.slice().sort(), pl.slice(0, 64).sort());
  assert.ok(t.qual.cupB);
  let cup = ok(await call(null, 'GET', '/api/tournaments/' + t.qual.cupB)).tournament;
  assert.equal(cup.parent, t.id); assert.equal(cup.off, 64); assert.equal(cup.status, 'live');
  assert.deepEqual(cup.players.slice().sort(), pl.slice(64).sort());
  // пока «Кубок B» не сыгран — у не попавших в сетку места 65–72
  assert.deepEqual(B.placeRange(t, pl[70]), [65, 72]);
  // играем «Кубок B» целиком: побеждает тот, кто выше по квалификации
  for (;;) {
    const g = cup.games.find(x => B.gameState(cup, x).st === 'ready');
    if (!g) break;
    const s = B.gameState(cup, g), aw = pl.indexOf(s.a) < pl.indexOf(s.b);
    cup = ok(await call(TECH, 'POST', '/api/tournaments/' + cup.id + '/games/' + g.r + '/' + g.i + '/result', { la: aw ? 1 : 0, lb: aw ? 0 : 1 })).tournament;
  }
  assert.equal(cup.status, 'done');
  assert.deepEqual(B.placeRange(cup, pl[64]), [65, 65]);
  const main = ok(await call(null, 'GET', '/api/tournaments/' + t.id)).tournament;
  assert.deepEqual(B.placeRange(main, pl[64]), [65, 65]);
  assert.deepEqual(B.placeRange(main, pl[65]), [66, 66]);
  const ent = (await pool.query('SELECT place_lo, place_hi FROM entries WHERE tournament_id = $1 AND player_id = $2', [t.id, pl[64]])).rows[0];
  assert.deepEqual([ent.place_lo, ent.place_hi], [65, 65]);
});
