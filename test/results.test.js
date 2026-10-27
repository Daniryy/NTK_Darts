// Итоги турнира: общее фото, призёры и лучшее в ленте и в ответе турнира.
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
const dev = () => 'device_res_' + String(++seq).padStart(8, '0');
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
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300)]);
const B = require('../shared/bracket.js');

let HOST, PL;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  HOST = await login('p1'); PL = await login('p6');
});
test.after(async () => { await app.close(); await pool.end(); });

const upload = (u, tid, cover) => app.inject({ method: 'POST', url: '/api/photos?kind=tour&tournamentId=' + tid + '&w=1600&h=1200' + (cover ? '&cover=1' : ''), payload: JPG, headers: { 'content-type': 'image/jpeg', 'x-device-id': u.dev, cookie: u.cookie } });

test('общее фото: загрузка с cover=1, выбор из фото турнира, в ленте; призёры и лучшее', async () => {
  let t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Итоговый', format: 'rr', mode: 501, ltw: 1, players: ['p6', 'p10', 'p12'] }), 201).tournament;
  // сыграть все матчи быстрым счётом
  for (const g of t.games) {
    const s = B.gameState(t, g);
    if (s.st !== 'ready') continue;
    t = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/games/' + g.r + '/' + g.i + '/result', { la: 1, lb: 0 })).tournament;
  }
  assert.equal(t.status, 'done');
  assert.equal(t.cover, null);
  const r1 = await upload(HOST, t.id, true);
  assert.equal(r1.statusCode, 201, r1.body);
  const cover = JSON.parse(r1.body).photo.id;
  t = ok(await call(null, 'GET', '/api/tournaments/' + t.id)).tournament;
  assert.equal(t.cover.id, cover);
  assert.ok(t.best && 'avg' in t.best && 'hco' in t.best && t.best.c180.total >= 0);
  // обычное фото не меняет общее; выбрать другое; чужой — нельзя
  const other = JSON.parse((await upload(HOST, t.id, false)).body).photo.id;
  assert.equal(ok(await call(null, 'GET', '/api/tournaments/' + t.id)).tournament.cover.id, cover);
  err(await call(PL, 'PATCH', '/api/tournaments/' + t.id + '/cover', { photoId: other }), 403);
  err(await call(HOST, 'PATCH', '/api/tournaments/' + t.id + '/cover', { photoId: 'nope' }), 404);
  assert.equal(ok(await call(HOST, 'PATCH', '/api/tournaments/' + t.id + '/cover', { photoId: other })).tournament.cover.id, other);
  // в ленте: турнир с общим фото и призёрами
  const it = ok(await call(null, 'GET', '/api/feed?limit=50')).items.find(x => x.type === 'tournament' && x.tournament.id === t.id);
  assert.equal(it.tournament.cover.id, other);
  assert.equal(it.tournament.podium[0].lo, 1);
  assert.ok(it.tournament.podium[0].name);
  // фото удалили — общего фото нет
  ok(await call(HOST, 'DELETE', '/api/photos/' + other));
  assert.equal(ok(await call(null, 'GET', '/api/tournaments/' + t.id)).tournament.cover, null);
  ok(await call(HOST, 'PATCH', '/api/tournaments/' + t.id + '/cover', { photoId: null }));
});
