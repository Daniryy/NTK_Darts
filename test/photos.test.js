// Фото (аватары и итоги турнира), ссылки к итогам, аккаунты от администратора и привязка по коду.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'oche-uploads-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');

let app, seq = 0;
const dev = () => 'photo_device_' + String(++seq).padStart(6, '0');
async function login(playerId) {
  const u = { dev: dev(), cookie: '' };
  const r = await app.inject({ method: 'POST', url: '/api/auth/dev', payload: { playerId }, headers: { 'x-device-id': u.dev } });
  assert.equal(r.statusCode, 200, r.body);
  u.cookie = r.cookies.map(c => c.name + '=' + c.value).join('; ');
  return u;
}
async function call(u, method, url, body, type) {
  const headers = {};
  if (u) { headers.cookie = u.cookie; headers['x-device-id'] = u.dev; }
  if (type) headers['content-type'] = type;
  const r = await app.inject({ method, url, payload: body, headers });
  return { s: r.statusCode, b: r.body ? JSON.parse(r.body) : null };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
const err = (r, code, ecode) => { assert.equal(r.s, code, JSON.stringify(r.b)); if (ecode) assert.equal(r.b.error.code, ecode); return r.b.error; };
// маленький «JPEG»: сервер смотрит только на подпись файла
const jpeg = n => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(n || 200, 7)]);
const fileOf = url => path.join(process.env.UPLOAD_DIR, url.replace('/uploads/', ''));

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
});
test.after(async () => { await app.close(); await pool.end(); fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); });

let A, X;
test('аватар: загрузка, замена удаляет старый файл, не картинка — 400, чужой — 403', async () => {
  A = await login(ME); X = await login('p9');
  err(await call(A, 'POST', '/api/photos?kind=avatar&w=400&h=400', Buffer.from('hello'), 'image/jpeg'), 400);
  err(await call(A, 'POST', '/api/photos?kind=avatar&w=4&h=400', jpeg(), 'image/jpeg'), 400);
  const r1 = ok(await call(A, 'POST', '/api/photos?kind=avatar&w=400&h=400', jpeg(), 'image/jpeg'), 201);
  assert.match(r1.photo.url, /^\/uploads\/[0-9a-f]{24}\.jpg$/);
  assert.ok(fs.existsSync(fileOf(r1.photo.url)));
  assert.equal(r1.player.photo, r1.photo.url);
  assert.equal(ok(await call(A, 'GET', '/api/me')).player.photo, r1.photo.url, 'сессия видит новое фото');
  const r2 = ok(await call(A, 'POST', '/api/photos?kind=avatar&w=400&h=400', jpeg(300), 'image/jpeg'), 201);
  assert.ok(!fs.existsSync(fileOf(r1.photo.url)), 'старый аватар удалён');
  // фото видно в карточке игрока и в составе турнира
  assert.equal(ok(await call(null, 'GET', '/api/players/' + ME)).player.photo, r2.photo.url);
  const t = ok(await call(null, 'GET', '/api/tournaments/t5')).tournament;
  assert.equal(t.roster[ME].photo, r2.photo.url);
  // чужой аватар — нельзя; администратор (p17) — может
  err(await call(X, 'POST', '/api/photos?kind=avatar&playerId=p1&w=400&h=400', jpeg(), 'image/jpeg'), 403, 'forbidden');
  const r3 = ok(await call(A, 'POST', '/api/photos?kind=avatar&playerId=p9&w=400&h=400', jpeg(), 'image/jpeg'), 201);
  assert.equal(r3.player.id, 'p9');
  // удалить свой
  ok(await call(X, 'DELETE', '/api/photos/' + r3.photo.id));
  assert.equal(ok(await call(null, 'GET', '/api/players/p9')).player.photo, null);
  assert.ok(!fs.existsSync(fileOf(r3.photo.url)));
  // убрать аватар по игроку
  const r4 = ok(await call(X, 'POST', '/api/photos?kind=avatar&w=400&h=400', jpeg(), 'image/jpeg'), 201);
  err(await call(X, 'DELETE', '/api/players/p1/photo'), 403);
  ok(await call(X, 'DELETE', '/api/players/p9/photo'));
  assert.equal(ok(await call(null, 'GET', '/api/players/p9')).player.photo, null);
  assert.ok(!fs.existsSync(fileOf(r4.photo.url)));
  // в разработке файлы отдаёт сам сервер
  const got = await app.inject({ method: 'GET', url: r2.photo.url });
  assert.equal(got.statusCode, 200);
  assert.equal(got.rawPayload.length, 304);
});

test('фото и ссылки к итогам турнира: только организатор; удаление турнира удаляет файлы', async () => {
  const tour = ok(await call(A, 'POST', '/api/tournaments', { name: 'Фото', format: 'pl', mode: 501, ltw: 1, players: ['p1', 'p2', 'p3', ME] }), 201).tournament;
  err(await call(X, 'POST', '/api/photos?kind=tour&tournamentId=' + tour.id + '&w=1280&h=960', jpeg(), 'image/jpeg'), 403);
  const p = ok(await call(A, 'POST', '/api/photos?kind=tour&tournamentId=' + tour.id + '&w=1280&h=960', jpeg(), 'image/png'), 201).photo;
  let t = ok(await call(null, 'GET', '/api/tournaments/' + tour.id)).tournament;
  assert.deepEqual(t.photos, [p]);
  assert.ok(t.version > tour.version, 'фото меняет версию турнира');
  err(await call(A, 'PATCH', '/api/tournaments/' + tour.id + '/links', { links: [{ title: 'x', url: 'javascript:alert(1)' }] }), 400);
  err(await call(X, 'PATCH', '/api/tournaments/' + tour.id + '/links', { links: [] }), 403);
  t = ok(await call(A, 'PATCH', '/api/tournaments/' + tour.id + '/links', { links: [{ title: 'Трансляция', url: 'https://vk.com/video-1_2' }, { url: 'https://example.org/res' }] })).tournament;
  assert.deepEqual(t.links, [{ title: 'Трансляция', url: 'https://vk.com/video-1_2' }, { title: 'example.org', url: 'https://example.org/res' }]);
  // камеры: до 4, только https, мишени — номера
  err(await call(A, 'PATCH', '/api/tournaments/' + tour.id + '/streams', { streams: [{ url: 'http://vk.com/video-1_2' }] }), 400);
  err(await call(A, 'PATCH', '/api/tournaments/' + tour.id + '/streams', { streams: [{ url: 'https://vk.com/video-1_2', boards: [0] }] }), 400);
  err(await call(X, 'PATCH', '/api/tournaments/' + tour.id + '/streams', { streams: [] }), 403);
  t = ok(await call(A, 'PATCH', '/api/tournaments/' + tour.id + '/streams', { streams: [{ url: 'https://vk.com/video-1_2', boards: [2, 1, 2] }, { title: 'Общий план', url: 'https://vkvideo.ru/video-1_3' }] })).tournament;
  assert.deepEqual(t.streams, [{ title: 'Камера 1', url: 'https://vk.com/video-1_2', boards: [1, 2] }, { title: 'Общий план', url: 'https://vkvideo.ru/video-1_3', boards: [] }]);
  ok(await call(A, 'DELETE', '/api/tournaments/' + tour.id));
  await new Promise(r => setTimeout(r, 50));
  assert.ok(!fs.existsSync(fileOf(p.url)), 'файлы турнира удалены');
});

test('администратор создаёт аккаунт, игрок привязывает его кодом после входа', async () => {
  err(await call(X, 'POST', '/api/admin/players', { name: 'Иван Новый' }), 403, 'forbidden');
  err(await call(X, 'GET', '/api/admin/players'), 403);
  const p = ok(await call(A, 'POST', '/api/admin/players', { name: 'Иван Новый', city: 'Новоуральск', title: 'КМС' }), 201).player;
  assert.match(p.claim, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(p.vk, false);
  assert.equal(p.title, 'КМС');
  assert.ok(ok(await call(A, 'GET', '/api/admin/players?q=иван')).players.some(x => x.id === p.id && x.claim === p.claim));
  // админ записывает его в турнир и вносит результат — у аккаунта уже есть история
  const tour = ok(await call(A, 'POST', '/api/tournaments', { name: 'С новичком', format: 'pl', mode: 501, ltw: 1, players: ['p1', 'p2', p.id] }), 201).tournament;
  // новый игрок (как после первого входа через VK): гость без истории
  const guest = ok(await call(A, 'POST', '/api/players', { name: 'Иван VK' })).player;
  const G = await login(guest.id);
  err(await call(G, 'POST', '/api/me/claim', { code: 'ZZZZZZZZ' }), 404);
  const me = ok(await call(G, 'POST', '/api/me/claim', { code: p.claim.toLowerCase().slice(0, 4) + '-' + p.claim.slice(4) }));
  assert.equal(me.player.id, p.id);
  assert.equal(ok(await call(G, 'GET', '/api/me')).player.id, p.id, 'сессия теперь у привязанного аккаунта');
  err(await call(null, 'GET', '/api/players/' + guest.id), 404, 'not_found');
  assert.ok(ok(await call(G, 'GET', '/api/tournaments/' + tour.id)).tournament.players.includes(p.id));
  err(await call(G, 'POST', '/api/me/claim', { code: p.claim }), 404, 'not_found'); // код одноразовый
  // у аккаунта с историей привязка не делается
  const p2 = ok(await call(A, 'POST', '/api/admin/players', { name: 'Пётр Второй' }), 201).player;
  err(await call(X, 'POST', '/api/me/claim', { code: p2.claim }), 409, 'conflict');
  // правка администратором: разряд, новый код
  const ed = ok(await call(A, 'PATCH', '/api/admin/players/' + p2.id, { title: 'МС', claim: true })).player;
  assert.equal(ed.title, 'МС');
  assert.notEqual(ed.claim, p2.claim);
  err(await call(A, 'PATCH', '/api/admin/players/' + ME, { role: 'player' }), 409);
  // разряд в своём профиле
  assert.equal(ok(await call(X, 'PATCH', '/api/me', { title: '1 разряд' })).player.title, '1 разряд');
});
