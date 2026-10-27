// Тариф «Ведущий»: страница клуба, помощники, взносы, спонсоры и логотип клуба, статистика.
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
const dev = () => 'device_club_' + String(++seq).padStart(8, '0');
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
const B = require('../shared/bracket.js');
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);

let TECH, ADMIN, HOST, PL, HELP, tour;
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  TECH = await login(ME); ADMIN = await login('p4'); HOST = await login('p1'); PL = await login('p6'); HELP = await login('p9');
});
test.after(async () => { await app.close(); await pool.end(); });

test('страница клуба: всем — расписание и игроки, ведущему — управление и статистика', async () => {
  const pub = ok(await call(null, 'GET', '/api/clubs/c1'));
  assert.equal(pub.club.name, 'Клуб «Тройная двадцатка»');
  assert.deepEqual([pub.manage, pub.tools, pub.stats], [false, false, undefined]);
  err(await call(null, 'GET', '/api/clubs/nope'), 404);
  const own = ok(await call(HOST, 'GET', '/api/clubs/c1'));
  assert.deepEqual([own.manage, own.tools], [true, true]);
  assert.equal(own.stats.months.length, 6);
  assert.deepEqual(own.helpers, []);
  // описание — ведущий, название — только администратор
  ok(await call(HOST, 'PATCH', '/api/clubs/c1', { about: 'Пятничные турниры, 6 мишеней' }));
  err(await call(HOST, 'PATCH', '/api/clubs/c1', { name: 'Другое' }), 403);
  err(await call(PL, 'PATCH', '/api/clubs/c1', { about: 'взлом' }), 403);
  assert.equal(ok(await call(null, 'GET', '/api/clubs/c1')).club.about, 'Пятничные турниры, 6 мишеней');
});

test('помощник клуба ведёт счёт и ставит мишени, но не управляет турниром', async () => {
  err(await call(PL, 'POST', '/api/clubs/c1/helpers', { playerId: 'p9' }), 403);
  ok(await call(HOST, 'POST', '/api/clubs/c1/helpers', { playerId: 'p9' }));
  tour = ok(await call(HOST, 'POST', '/api/tournaments', { name: 'Пятница', format: 'pl', mode: 501, ltw: 1, clubId: 'c1', fee: 500, players: ['p6', 'p10', 'p12', 'p13'] }), 201).tournament;
  const t = ok(await call(HELP, 'GET', '/api/tournaments/' + tour.id)).tournament;
  assert.deepEqual([t.can.org, t.can.staff, t.can.score, t.can.fees], [false, true, true, true]);
  const g = t.games.find(x => B.gameState(t, x).st === 'ready');
  ok(await call(HELP, 'PUT', '/api/matches/' + mid(), { tournamentId: tour.id, r: g.r, i: g.i }), 201);
  ok(await call(HELP, 'PATCH', '/api/tournaments/' + tour.id + '/boards', { n: 4 }));
  err(await call(HELP, 'PATCH', '/api/tournaments/' + tour.id + '/links', { links: [] }), 403);
  err(await call(HELP, 'DELETE', '/api/tournaments/' + tour.id), 403);
  // убрали из помощников — счёт чужой пары вести нельзя
  ok(await call(HOST, 'DELETE', '/api/clubs/c1/helpers/p9'));
  const t2 = ok(await call(HELP, 'GET', '/api/tournaments/' + tour.id)).tournament;
  const g2 = t2.games.find(x => B.gameState(t2, x).st === 'ready' && !t2.live[x.r + ':' + x.i]);
  err(await call(HELP, 'PUT', '/api/matches/' + mid(), { tournamentId: tour.id, r: g2.r, i: g2.i }), 403);
  ok(await call(HOST, 'POST', '/api/clubs/c1/helpers', { playerId: 'p9' }));
  for (const p of ['p2', 'p3', 'p5', 'p7', 'p8']) await call(HOST, 'POST', '/api/clubs/c1/helpers', { playerId: p });
  err(await call(HOST, 'POST', '/api/clubs/c1/helpers', { playerId: 'p11' }), 409);
});

test('взносы: сумма у турнира, отметки «оплатил» — только команде турнира', async () => {
  const t = ok(await call(HOST, 'GET', '/api/tournaments/' + tour.id)).tournament;
  assert.deepEqual(t.fees, { fee: 500, paid: [] });
  assert.equal(ok(await call(PL, 'GET', '/api/tournaments/' + tour.id)).tournament.fees, undefined);
  assert.deepEqual(ok(await call(HOST, 'PATCH', '/api/tournaments/' + tour.id + '/paid', { playerId: 'p6', paid: true })).tournament.fees.paid, ['p6']);
  ok(await call(HELP, 'PATCH', '/api/tournaments/' + tour.id + '/paid', { playerId: 'p10', paid: true }));
  err(await call(PL, 'PATCH', '/api/tournaments/' + tour.id + '/paid', { playerId: 'p6', paid: false }), 403);
  err(await call(HOST, 'PATCH', '/api/tournaments/' + tour.id + '/paid', { playerId: 'p2', paid: true }), 404);
  ok(await call(HOST, 'PATCH', '/api/tournaments/' + tour.id, { fee: 700 }));
  // сумму взноса может указать любой организатор, её видят все; отметки «оплатил» — только с тарифом
  const own = ok(await call(PL, 'POST', '/api/tournaments', { name: 'Свой', format: 'pl', mode: 501, ltw: 1, fee: 300, players: ['p6', 'p10', 'p12'] }), 201).tournament;
  assert.deepEqual([own.fee, own.fees, own.can.fees], [300, undefined, false]);
  assert.equal(ok(await call(null, 'GET', '/api/tournaments/' + own.id)).tournament.fee, 300);
  assert.equal(ok(await call(null, 'GET', '/api/tournaments?status=live')).tournaments.find(x => x.id === own.id).fee, 300);
  err(await call(PL, 'PATCH', '/api/tournaments/' + own.id + '/paid', { playerId: 'p10', paid: true }), 403);
  assert.equal(ok(await call(HOST, 'GET', '/api/clubs/c1')).stats.cash30, 1400, 'касса за 30 дней: двое оплатили по 700');
});

test('логотип и спонсоры клуба вместо баннеров Oche; без тарифа — снова баннеры Oche', async () => {
  ok(await call(TECH, 'POST', '/api/admin/banners', { place: 'tv', title: 'Реклама Oche' }), 201);
  ok(await call(HOST, 'POST', '/api/clubs/c1/banners', { place: 'tv', title: 'Пиво «Дротик»' }), 201);
  err(await call(HOST, 'POST', '/api/clubs/c1/banners', { place: 'feed', title: 'В ленту' }), 400);
  err(await call(PL, 'POST', '/api/clubs/c1/banners', { place: 'tv', title: 'Чужой' }), 403);
  const tv = ok(await call(null, 'GET', '/api/banners?place=tv&tid=' + tour.id));
  assert.deepEqual([tv.club, tv.banners.map(b => b.title)], [true, ['Пиво «Дротик»']]);
  assert.ok(!ok(await call(null, 'GET', '/api/banners?place=tv')).banners.some(b => b.title === 'Пиво «Дротик»'));
  assert.ok(!ok(await call(TECH, 'GET', '/api/admin/banners')).banners.some(b => b.title === 'Пиво «Дротик»'));
  // логотип
  const r = await app.inject({ method: 'POST', url: '/api/photos?kind=club&clubId=c1&w=200&h=200', payload: JPG, headers: { 'content-type': 'image/jpeg', 'x-device-id': HOST.dev, cookie: HOST.cookie } });
  assert.equal(r.statusCode, 201, r.body);
  const logo = ok(await call(null, 'GET', '/api/tournaments/' + tour.id)).tournament.org.logo;
  assert.match(logo, /^\/uploads\/\w+\.jpg$/);
  assert.equal(ok(await call(null, 'GET', '/api/clubs/c1')).club.logo, logo);
  const r2 = await app.inject({ method: 'POST', url: '/api/photos?kind=club&clubId=c1&w=200&h=200', payload: JPG, headers: { 'content-type': 'image/jpeg', 'x-device-id': PL.dev, cookie: PL.cookie } });
  assert.equal(r2.statusCode, 403);
  // право club_tools сняли у ведущих — логотипа и спонсоров нет, снова баннеры Oche
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { club_tools: ['admin'] } }));
  assert.equal(ok(await call(null, 'GET', '/api/tournaments/' + tour.id)).tournament.org.logo, null);
  assert.ok(ok(await call(null, 'GET', '/api/banners?place=tv&tid=' + tour.id)).banners.some(b => b.title === 'Реклама Oche'));
  err(await call(HOST, 'POST', '/api/clubs/c1/helpers', { playerId: 'p11' }), 403);
  ok(await call(TECH, 'PUT', '/api/admin/perms', { perms: { club_tools: ['host', 'admin'] } }));
});
