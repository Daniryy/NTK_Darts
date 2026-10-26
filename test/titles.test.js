// Подтверждение звания: документ, заявка, автопроверка, решение администратора, закрытые документы.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const os = require('node:os');
const path = require('node:path');
process.env.PRIVATE_DIR = path.join(os.tmpdir(), 'oche-private-test-' + process.pid);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');

let app, seq = 0;
const anon = () => ({ dev: 'device_ttl_' + String(++seq).padStart(10, '0'), cookie: '' });
async function call(u, method, url, body, type) {
  const headers = {};
  if (u) { headers['x-device-id'] = u.dev; if (u.cookie) headers.cookie = u.cookie; }
  if (type) headers['content-type'] = type;
  const r = await app.inject({ method, url, payload: body, headers });
  const sid = r.cookies.find(c => c.name === 'oche_sid');
  if (u && sid) u.cookie = 'oche_sid=' + sid.value;
  return { s: r.statusCode, b: r.body && /json/.test(r.headers['content-type'] || '') ? JSON.parse(r.body) : r.rawPayload, h: r.headers };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
const err = (r, code, ecode) => { assert.equal(r.s, code, JSON.stringify(r.b)); if (ecode) assert.equal(r.b.error.code, ecode); return r.b.error; };
async function login(playerId) { const u = anon(); ok(await call(u, 'POST', '/api/auth/dev', { playerId })); return u; }
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(100, 32)]);
const day = d => Date.UTC(2025, 2, d);

let ADMIN, HOST, P2, P3;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  ADMIN = await login('p4'); HOST = await login('p1'); P2 = await login('p2'); P3 = await login('p3');
});
test.after(async () => { await app.close(); await pool.end(); fs.rmSync(process.env.PRIVATE_DIR, { recursive: true, force: true }); });

let reqId, docId;
test('звание самому не вписать; документ — только фото или PDF и только владельцу и проверяющему', async () => {
  err(await call(P2, 'PATCH', '/api/me', { title: 'МС' }), 400);
  ok(await call(P2, 'PATCH', '/api/me', { city: 'Санкт-Петербург', title: '' }));
  err(await call(P2, 'POST', '/api/titles/docs', Buffer.from('hello'), 'image/jpeg'), 400);
  const d = ok(await call(P2, 'POST', '/api/titles/docs', JPG, 'image/jpeg'), 201).doc;
  docId = d.id;
  assert.equal(d.mime, 'image/jpeg');
  const pdf = ok(await call(P2, 'POST', '/api/titles/docs', PDF, 'application/pdf'), 201).doc;
  assert.equal(pdf.mime, 'application/pdf');
  const own = await call(P2, 'GET', d.url);
  assert.equal(own.s, 200);
  assert.equal(own.h['cache-control'], 'private, no-store');
  err(await call(P3, 'GET', d.url), 404);
  err(await call(null, 'GET', d.url), 401);
  assert.equal((await call(ADMIN, 'GET', d.url)).s, 200);
  // ведущий без права titles документ не видит
  err(await call(HOST, 'GET', d.url), 404);
  docId = [d.id, pdf.id];
});

test('заявка: автопроверка сразу, стадия «ждёт администратора»; вторая заявка — нельзя', async () => {
  const base = { fullName: 'Белов Игорь Сергеевич', title: 'ms', orderNo: '45 нг', orderDate: day(10), issuer: 'Федерация дартса', docs: docId };
  err(await call(P2, 'POST', '/api/titles', Object.assign({}, base, { docs: [] })), 400);
  err(await call(P3, 'POST', '/api/titles', base), 400, 'bad_request'); // чужие файлы
  const r = ok(await call(P2, 'POST', '/api/titles', base), 201).request;
  reqId = r.id;
  assert.equal(r.status, 'review');
  assert.ok(r.autoAt > 0);
  const st = Object.fromEntries(r.auto.map(x => [x.k, x.st]));
  assert.equal(st.doc, 'ok');
  assert.equal(st.name, 'ok', 'Игорь Белов есть в ФИО');
  assert.equal(st.order, 'ok');
  assert.equal(st.date, 'ok');
  assert.equal(st.issuer, 'warn', 'МС присваивает Минспорт, а не федерация');
  assert.equal(st.minsport, 'info');
  assert.equal(r.docs.length, 2);
  err(await call(P2, 'POST', '/api/titles', base), 409);
  const mine = ok(await call(P2, 'GET', '/api/titles/mine'));
  assert.equal(mine.requests[0].id, reqId);
  assert.equal(mine.title, '');
});

test('администратор: отказ только с причиной, подтверждение — звание видно всем; журнал', async () => {
  err(await call(HOST, 'GET', '/api/admin/titles'), 403);
  const list = ok(await call(ADMIN, 'GET', '/api/admin/titles')).requests;
  const r = list.find(x => x.id === reqId);
  assert.equal(r.player.id, 'p2');
  assert.ok(r.search.startsWith('https://www.minsport.gov.ru/search/'));
  err(await call(ADMIN, 'PATCH', '/api/admin/titles/' + reqId, { status: 'rejected' }), 400);
  const done = ok(await call(ADMIN, 'PATCH', '/api/admin/titles/' + reqId, { status: 'approved', note: 'Сверено с приказом' })).request;
  assert.equal(done.status, 'approved');
  assert.equal(done.decidedBy, 'Денис Карпов');
  err(await call(ADMIN, 'PATCH', '/api/admin/titles/' + reqId, { status: 'rejected', note: 'x' }), 409);
  assert.equal(ok(await call(null, 'GET', '/api/players/p2')).player.title, 'МС');
  assert.equal(ok(await call(P2, 'GET', '/api/titles/mine')).title, 'МС');
  const log = ok(await call(ADMIN, 'GET', '/api/admin/audit')).items.map(x => x.action);
  assert.ok(log.includes('title.submit') && log.includes('title.approved'));
});

test('повтор приказа с тем же ФИО у другого аккаунта — замечание; отзыв заявки; отказ; снятие звания', async () => {
  const d = ok(await call(P3, 'POST', '/api/titles/docs', JPG, 'image/jpeg'), 201).doc;
  const r = ok(await call(P3, 'POST', '/api/titles', { fullName: 'Белов Игорь Сергеевич', title: 'ms', orderNo: '45 НГ', orderDate: day(10), issuer: 'Минспорт России', docs: [d.id] }), 201).request;
  const st = Object.fromEntries(r.auto.map(x => [x.k, x.st]));
  assert.equal(st.dup, 'warn');
  assert.equal(st.name, 'warn', 'профиль — Марина Соколова');
  assert.equal(st.issuer, 'ok');
  // отозвать и подать снова
  assert.equal(ok(await call(P3, 'DELETE', '/api/titles/' + r.id)).request.status, 'cancelled');
  err(await call(P3, 'DELETE', '/api/titles/' + r.id), 404);
  const d2 = ok(await call(P3, 'POST', '/api/titles/docs', JPG, 'image/jpeg'), 201).doc;
  const r2 = ok(await call(P3, 'POST', '/api/titles', { fullName: 'Соколова Марина', title: 'kms', orderNo: '12-к', orderDate: day(1), issuer: 'Минспорт Татарстана', docs: [d2.id] }), 201).request;
  ok(await call(ADMIN, 'PATCH', '/api/admin/titles/' + r2.id, { status: 'rejected', note: 'На фото не видно номера приказа' }));
  const mine = ok(await call(P3, 'GET', '/api/titles/mine')).requests;
  assert.equal(mine[0].status, 'rejected');
  assert.equal(mine[0].note, 'На фото не видно номера приказа');
  // снять звание
  err(await call(HOST, 'DELETE', '/api/admin/players/p2/title', { note: 'x' }), 403);
  ok(await call(ADMIN, 'DELETE', '/api/admin/players/p2/title', { note: 'Ошибочно подтверждено' }));
  assert.equal(ok(await call(null, 'GET', '/api/players/p2')).player.title, '');
  // администратор с правом titles задаёт звание напрямую, ведущий — нет
  const acc = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Пётр Новый', title: 'МС' }), 201).player;
  assert.equal(acc.title, '');
  err(await call(HOST, 'PATCH', '/api/admin/players/' + acc.id, { title: 'МС' }), 403);
  assert.equal(ok(await call(ADMIN, 'PATCH', '/api/admin/players/' + acc.id, { title: 'КМС' })).player.title, 'КМС');
});
