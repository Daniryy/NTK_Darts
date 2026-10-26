// Ограничение частоты: по устройству (заголовок или ?d= у потока табло), а не по общему IP зала.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
process.env.RATE_MAX = '5';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool } = require('../server/db');

let app;
test.before(async () => { app = build({ logger: false }); await app.ready(); });
test.after(async () => { await app.close(); await pool.end(); });

const get = (url, headers) => app.inject({ method: 'GET', url, headers }).then(r => r.statusCode);
const dev = k => 'rate_device_' + String(k).padStart(8, '0');

test('много устройств с одного IP не мешают друг другу; одно устройство упирается в лимит', async () => {
  const codes = await Promise.all(Array.from({ length: 12 }, (_, k) => get('/api/config?d=' + dev(k))));
  assert.deepEqual([...new Set(codes)], [200], 'поток табло с ?d= — у каждого свой лимит');
  const hdr = await Promise.all(Array.from({ length: 12 }, (_, k) => get('/api/config', { 'x-device-id': dev(100 + k) })));
  assert.deepEqual([...new Set(hdr)], [200]);
  // одно устройство — по очереди (при одновременных запросах хранилище лимита отдаёт всем итоговый счётчик)
  const one = [];
  for (let k = 0; k < 8; k++) one.push(await get('/api/config', { 'x-device-id': dev(999) }));
  assert.equal(one.filter(c => c === 429).length, 3, 'одно устройство — 5 запросов за 2 с');
  const bad = [];
  for (let k = 0; k < 8; k++) bad.push(await get('/api/config?d=short'));
  assert.ok(bad.includes(429), 'неверный id — лимит по IP');
});
