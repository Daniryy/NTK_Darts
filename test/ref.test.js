// Судья по QR конкретного матча: организатор выдаёт ключ на игру сетки, судья без аккаунта ведёт счёт,
// его имя — в судьях турнира и на этой игре; чужой матч, отозванный ключ и сыгранная игра — нельзя.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed } = require('../db/seed');

let app, seq = 0;
const anon = () => ({ dev: 'device_ref_' + String(++seq).padStart(8, '0'), cookie: '' });
async function call(u, method, url, body, extra) {
  const headers = Object.assign({}, extra || {});
  if (u) { headers['x-device-id'] = u.dev; if (u.cookie) headers.cookie = u.cookie; }
  const r = await app.inject({ method, url, payload: body, headers });
  const sid = r.cookies.find(c => c.name === 'oche_sid');
  if (u && sid) u.cookie = 'oche_sid=' + sid.value;
  return { s: r.statusCode, b: r.body ? JSON.parse(r.body) : null };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
const err = (r, code, ecode) => { assert.equal(r.s, code, JSON.stringify(r.b)); if (ecode) assert.equal(r.b.error.code, ecode); return r.b.error; };
async function login(playerId) { const u = anon(); ok(await call(u, 'POST', '/api/auth/dev', { playerId })); return u; }
const mid = () => 'g' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');
const asRef = (key, name) => ({ 'x-ref-key': key, 'x-ref-name': encodeURIComponent(name) });
function legEvents(starter, winner, leg) {
  const out = [], sc = [501, 501], plan = [180, 180, 141];
  let p = starter, k = 0;
  for (;;) {
    const pts = p === winner ? plan[k++] : 60;
    out.push({ type: 'visit', leg, p, s: sc[p], pts, n: 3, b: 0, d: null });
    sc[p] -= pts;
    if (sc[p] === 0) return out;
    p = (p + 1) % 2;
  }
}

let HOST, PL, T;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  HOST = await login('p1'); PL = await login('p20');
  T = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Судьи по QR', format: 'ko', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13'] }), 201).tournament;
});
test.after(async () => { await app.close(); await pool.end(); });

test('QR судьи: выдаёт организатор, судья без аккаунта ведёт счёт своего матча, имя — в судьях турнира', async () => {
  const base = '/api/tournaments/' + T.id + '/games/0/0/refkey';
  err(await call(PL, 'POST', base), 403);
  err(await call(anon(), 'POST', base), 401);
  assert.equal(ok(await call(HOST, 'GET', base)).active, false);
  const { key } = ok(await call(HOST, 'POST', base));
  assert.match(key, /^[A-Z2-9]{16}$/);
  assert.equal(ok(await call(HOST, 'GET', base)).active, true);
  // судья открыл QR: что за матч
  const info = ok(await call(null, 'GET', '/api/ref/' + key));
  assert.equal(info.tid, T.id); assert.equal(info.r, 0); assert.equal(info.i, 0);
  assert.equal(info.players.length, 2); assert.equal(info.match, null);
  err(await call(null, 'GET', '/api/ref/AAAAAAAAAAAAAAAA'), 404);
  // без ключа и без входа — 401; с ключом — только свой матч и только матч сетки
  const R = anon(), H = asRef(key, 'Иванов Иван');
  err(await call(R, 'PUT', '/api/matches/' + mid(), { tournamentId: T.id, r: 0, i: 0 }), 401);
  err(await call(R, 'PUT', '/api/matches/' + mid(), { tournamentId: T.id, r: 0, i: 1 }, H), 403);
  err(await call(R, 'PUT', '/api/matches/' + mid(), { players: [{ id: 'p6' }], ltw: 1, mode: 501 }, H), 401);
  const id = mid(), m = ok(await call(R, 'PUT', '/api/matches/' + id, { tournamentId: T.id, r: 0, i: 0 }, H), 201).match;
  assert.equal(m.lock.by, 'Иванов Иван'); assert.equal(m.lock.mine, true);
  // повтор старта до первого подхода — смена начинающего
  assert.equal(ok(await call(R, 'PUT', '/api/matches/' + id, { tournamentId: T.id, r: 0, i: 0, starter: 1 }, H)).match.starter, 1);
  const t1 = ok(await call(null, 'GET', '/api/tournaments/' + T.id)).tournament;
  assert.equal(t1.refs.at['0:0'], 'Иванов Иван'); assert.ok(t1.refs.pool.includes('Иванов Иван'));
  // подходы с ключом; чужой ключ к этому матчу не подходит
  const evs = legEvents(1, 0, 1).map((e, k) => Object.assign({ seq: k + 1 }, e));
  ok(await call(R, 'POST', '/api/matches/' + id + '/events', { events: evs.slice(0, 2) }, H));
  err(await call(R, 'POST', '/api/matches/' + id + '/events', { events: evs.slice(2, 3) }), 401);
  const { key: k2 } = ok(await call(HOST, 'POST', '/api/tournaments/' + T.id + '/games/0/1/refkey'));
  err(await call(anon(), 'POST', '/api/matches/' + id + '/takeover', {}, asRef(k2, 'Петров')), 403);
  // второй телефон с тем же QR забирает счёт; первый больше не вносит
  const R2 = anon(), H2 = asRef(key, 'Сидоров Сидор');
  const tk = ok(await call(R2, 'POST', '/api/matches/' + id + '/takeover', {}, H2));
  assert.equal(tk.match.lock.by, 'Сидоров Сидор'); assert.equal(tk.events.length, 2);
  err(await call(R, 'POST', '/api/matches/' + id + '/events', { events: evs.slice(2, 3) }, H), 423);
  assert.equal(ok(await call(null, 'GET', '/api/tournaments/' + T.id)).tournament.refs.at['0:0'], 'Сидоров Сидор');
  // отозвали — ключ не действует
  ok(await call(HOST, 'DELETE', base));
  err(await call(R2, 'POST', '/api/matches/' + id + '/events', { events: evs.slice(2, 3) }, H2), 401);
  err(await call(null, 'GET', '/api/ref/' + key), 404);
  // новый QR — судья доводит матч до конца, результат в сетке
  const { key: k3 } = ok(await call(HOST, 'POST', base)), H3 = asRef(k3, 'Сидоров Сидор');
  assert.equal(ok(await call(null, 'GET', '/api/ref/' + k3)).match, id);
  const sc = [0, 0]; evs.forEach(e => { sc[e.p] += e.pts; });
  const pl = tk.match.players.map((p, k) => ({ id: p.id, legs: k === 0 ? 1 : 0, pts: sc[k], darts: evs.filter(e => e.p === k).length * 3, f9: null, hi: 180, hco: k === 0 ? 141 : 0, c180: 0, c140: 0, c100: 0, coh: 0, coa: 0, bl: 0 }));
  ok(await call(R2, 'POST', '/api/matches/' + id + '/events', { events: evs.slice(2).concat([{ seq: evs.length + 1, type: 'finish', w: 0, pl }]) }, H3));
  assert.equal(ok(await call(null, 'GET', '/api/matches/' + id)).match.status, 'done');
  // игра сыграна — QR больше не открывает матч
  err(await call(null, 'GET', '/api/ref/' + k3), 404);
  // результат игры 0:1, внесённый организатором, гасит её QR
  ok(await call(HOST, 'POST', '/api/tournaments/' + T.id + '/games/0/1/result', { la: 1, lb: 0 }));
  err(await call(null, 'GET', '/api/ref/' + k2), 404);
  err(await call(anon(), 'PUT', '/api/matches/' + mid(), { tournamentId: T.id, r: 0, i: 1 }, asRef(k2, 'Петров')), 409);
});
