// Лайт-профиль: аккаунт от ведущего без своего входа — QR-карточка, вне общего рейтинга; привязал вход — полный, матчи при нём.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed } = require('../db/seed');
const { clearCache } = require('../server/auth');

let app, seq = 0;
const dev = () => 'device_lite_' + String(++seq).padStart(8, '0');
const anon = () => ({ dev: dev(), cookie: '' });
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

let HOST, PL, ADMIN;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  HOST = await login('p1'); PL = await login('p6'); ADMIN = await login('p4');
});
test.after(async () => { await app.close(); await pool.end(); });

test('лайт-профиль: вне общего рейтинга, карточка многоразовая, привязал вход — полный и карточка гаснет', async () => {
  const p = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Зинаида Ивановна', city: 'Москва' }), 201).player;
  assert.equal(p.lite, true);
  // сыграла в официальном турнире: Эло считается, но в общий рейтинг лайт-профиль не входит
  await pool.query('UPDATE players SET rating = 2400, rated = 5 WHERE id = $1', [p.id]);
  const rows = ok(await call(null, 'GET', '/api/rating?limit=200')).rows;
  assert.ok(!rows.some(x => x.id === p.id));
  const prof = ok(await call(null, 'GET', '/api/players/' + p.id));
  assert.equal(prof.rank, null);
  assert.equal(prof.player.lite, true);
  // карточка: входит на двух телефонах
  const a = anon(), b = anon();
  assert.equal(ok(await call(a, 'POST', '/api/auth/code', { code: p.claim })).player.lite, true);
  ok(await call(b, 'POST', '/api/auth/code', { code: p.claim }));
  // привязала свой телефон — профиль полный, в рейтинге, карточка больше не пускает
  const sent = ok(await call(a, 'POST', '/api/auth/phone', { phone: '+79990007701' }));
  const me = ok(await call(a, 'POST', '/api/auth/phone/verify', { phone: '+79990007701', code: sent.devCode, link: true }));
  assert.equal(me.player.id, p.id);
  assert.equal(me.player.lite, false);
  err(await call(anon(), 'POST', '/api/auth/code', { code: p.claim }), 404, 'not_found');
  assert.ok(ok(await call(null, 'GET', '/api/rating?limit=200')).rows.some(x => x.id === p.id));
  assert.ok(ok(await call(null, 'GET', '/api/players/' + p.id)).rank >= 1);
  // ведущий по-прежнему правит имя (телефон мог внести и он сам), а с почтой и паролем — уже нет
  await pool.query(`UPDATE players SET email = 'zina@example.com', pass_hash = 'x' WHERE id = $1`, [p.id]); clearCache();
  err(await call(HOST, 'PATCH', '/api/admin/players/' + p.id, { name: 'Другое' }), 403, 'forbidden');
  // новый код может выдать администратор — в том же изменении он не гасится
  const c2 = ok(await call(ADMIN, 'PATCH', '/api/admin/players/' + p.id, { claim: true })).player.claim;
  assert.match(c2, /^[A-Z2-9]{8}$/);
  // у полного аккаунта код одноразовый
  ok(await call(anon(), 'POST', '/api/auth/code', { code: c2 }));
  err(await call(anon(), 'POST', '/api/auth/code', { code: c2 }), 404);
});

test('ведущий добавил телефон лайт-профилю — карточка гаснет, игрок входит по номеру', async () => {
  const p = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Гость Телефон' }), 201).player;
  await pool.query(`UPDATE players SET phone = '+79990007711' WHERE id = $1`, [p.id]);
  const row = (await pool.query('SELECT lite, claim FROM players WHERE id = $1', [p.id])).rows[0];
  assert.deepEqual(row, { lite: false, claim: null });
});

test('QR-карточки турнира: только организатору, только свои лайт-профили, код выдаётся', async () => {
  const z = ok(await call(HOST, 'POST', '/api/admin/players', { name: 'Карточка Один' }), 201).player;
  const g = ok(await call(HOST, 'POST', '/api/players', { name: 'Гость Бара' })).player; // гость ведущего — без кода
  const foreign = ok(await call(PL, 'POST', '/api/players', { name: 'Чужой Гость' })).player;
  const t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Карточки', format: 'pl', mode: 501, ltw: 1, reg: true, cap: 8 }), 201).tournament;
  for (const id of [z.id, g.id, foreign.id, 'p6']) ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/entries', { playerId: id }));
  err(await call(PL, 'POST', '/api/tournaments/' + t.id + '/cards'), 403);
  const r = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/cards'));
  assert.deepEqual(r.cards.map(x => x.id), [z.id, g.id]);
  assert.equal(r.cards[0].claim, z.claim);
  assert.match(r.cards[1].claim, /^[A-Z2-9]{8}$/);
  assert.equal(r.others, 1);
  // повторно — те же коды
  assert.deepEqual(ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/cards')).cards.map(x => x.claim), r.cards.map(x => x.claim));
  // гость входит по карточке
  assert.equal(ok(await call(anon(), 'POST', '/api/auth/code', { code: r.cards[1].claim })).player.id, g.id);
  clearCache();
});

test('вписанный по имени игрок — лайт-профиль; опоздавшего можно вписать, пока идёт квалификация', async () => {
  const SCORE = { k: 'score', lim: 3 };
  const t = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Опоздавший', format: 'ko', mode: 501, ltw: 1, qual: { ex: SCORE, tries: 1 }, players: ['p6', 'p7', 'p8'] }), 201).tournament;
  assert.equal(t.stage, 'qual');
  const g = ok(await call(HOST, 'POST', '/api/players', { name: 'Опоздавший Игрок' })).player;
  assert.equal(g.lite, true);
  err(await call(PL, 'POST', '/api/tournaments/' + t.id + '/entries', { playerId: g.id }), 403);
  const t2 = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/entries', { playerId: g.id })).tournament;
  assert.ok(t2.players.includes(g.id));
  assert.equal(t2.roster[g.id].lite, true);
  assert.equal(t2.cap, 4);
  // QR-карточка для него — у организатора
  const cards = ok(await call(HOST, 'POST', '/api/tournaments/' + t.id + '/cards')).cards;
  assert.ok(cards.some(x => x.id === g.id && x.claim));
});
