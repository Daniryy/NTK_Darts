// Тесты API на настоящей PostgreSQL: база пересоздаётся из демо-данных.
// TEST_DATABASE_URL=postgres://… npm test   (по умолчанию локальная база oche_test)
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
// тест стирает базу целиком — только базы с «test» в имени
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
process.env.VK_APP_ID = '5550001';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');
const { eloAll } = require('../server/stats');

let app, seq = 0;
const dev = () => 'device_' + String(++seq).padStart(12, '0');

async function login(playerId) {
  const u = { dev: dev(), cookie: '' };
  const r = await app.inject({ method: 'POST', url: '/api/auth/dev', payload: { playerId }, headers: { 'x-device-id': u.dev } });
  assert.equal(r.statusCode, 200, r.body);
  u.cookie = r.cookies.map(c => c.name + '=' + c.value).join('; ');
  return u;
}
async function call(u, method, url, body) {
  const headers = {};
  if (u) { headers.cookie = u.cookie; headers['x-device-id'] = u.dev; }
  const r = await app.inject({ method, url, payload: body, headers });
  return { s: r.statusCode, b: r.body ? JSON.parse(r.body) : null };
}
const ok = (r, code = 200) => { assert.equal(r.s, code, JSON.stringify(r.b)); return r.b; };
const err = (r, code, ecode) => { assert.equal(r.s, code, JSON.stringify(r.b)); if (ecode) assert.equal(r.b.error.code, ecode); return r.b.error; };

// лег 501: победитель 180, 180, 141; остальные по 60
function legEvents(np, starter, winner, leg) {
  const out = [], sc = Array(np).fill(501), plan = [180, 180, 141];
  let p = starter, k = 0;
  for (;;) {
    const pts = p === winner ? plan[k++] : 60;
    out.push({ type: 'visit', leg, p, s: sc[p], pts, n: 3, b: 0, d: null });
    sc[p] -= pts;
    if (sc[p] === 0) return out;
    p = (p + 1) % np;
  }
}
// весь матч: победитель выигрывает ltw легов подряд; finish со статистикой
function matchEvents(m, winner, from = 1) {
  const np = m.players.length, evs = [];
  for (let leg = 1; leg <= m.ltw; leg++) evs.push(...legEvents(np, (m.starter + leg - 1) % np, winner, leg));
  const pl = m.players.map((p, k) => {
    const mine = evs.filter(e => e.p === k);
    return { id: p.id, legs: k === winner ? m.ltw : 0, pts: mine.reduce((a, e) => a + e.pts, 0), darts: mine.length * 3, f9: 100, hi: 180, hco: k === winner ? 141 : 0, c180: 0, c140: 0, c100: 0, coh: 0, coa: 0, bl: 0 };
  });
  evs.push({ type: 'finish', w: winner, pl });
  return evs.map((e, k) => Object.assign({ seq: from + k }, e));
}
const mid = () => 'g' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
});
test.after(async () => { await app.close(); await pool.end(); });

test('чтение без входа и базовые ошибки', async () => {
  ok(await call(null, 'GET', '/api/health'));
  assert.deepEqual(ok(await call(null, 'GET', '/api/config')), { vk: true, phone: true, phoneBy: 'call', email: true, dev: true });
  assert.equal(ok(await call(null, 'GET', '/api/me')).player, null);
  err(await call(null, 'POST', '/api/tournaments', {}), 400, 'bad_request'); // нет X-Device-Id
  err(await call({ dev: dev(), cookie: '' }, 'POST', '/api/tournaments', {}), 401, 'unauthorized');
  err(await call(null, 'GET', '/api/tournaments/t999'), 404, 'not_found');
  // битый JSON — 400; пустое тело с заголовком JSON — не ошибка
  const bad = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: '{oops', headers: { 'content-type': 'application/json', 'x-device-id': dev() } });
  assert.equal(bad.statusCode, 400);
  assert.equal(JSON.parse(bad.body).error.code, 'bad_request');
  const empty = await app.inject({ method: 'POST', url: '/api/auth/logout', payload: '', headers: { 'content-type': 'application/json', 'x-device-id': dev() } });
  assert.equal(empty.statusCode, 200);
  const list = ok(await call(null, 'GET', '/api/tournaments?status=reg'));
  assert.equal(list.total, 2);
  assert.ok(ok(await call(null, 'GET', '/api/players?q=волк')).players.some(p => p.id === 'p1'));
  assert.ok(ok(await call(null, 'GET', '/api/players?q=%231003')).players.some(p => p.id === 'p3'));
});

let A, tid, t0;
test('создание турнира и права', async () => {
  A = await login(ME);
  const r = await call(A, 'POST', '/api/tournaments', { name: 'Тест', city: 'Москва', venue: '', format: 'pl', mode: 501, ltw: 1, seed: 'r', players: ['p1', 'p2', 'p3', 'p4', ME] });
  t0 = ok(r, 201).tournament;
  tid = t0.id;
  assert.equal(t0.status, 'live');
  assert.equal(t0.slots.length, 8);
  assert.equal(t0.games.length, 12);
  assert.deepEqual(t0.can, { org: true, stream: true, edit: false, delete: true, launch: false, score: true, join: false, staff: true, fees: true });
  assert.deepEqual(t0.players.map(id => t0.roster[id].r), t0.players.map(id => t0.roster[id].r).sort((a, b) => b - a)); // посев по рейтингу
  err(await call(A, 'POST', '/api/tournaments', { name: 'x', format: 'rr', mode: 501, ltw: 1, players: ['p1', 'p2'] }), 400);
  err(await call(A, 'POST', '/api/tournaments', { name: 'x', format: 'pl', mode: 500, ltw: 1, players: ['p1', 'p2', 'p3'] }), 400);
  const X = await login('p9');
  err(await call(X, 'DELETE', '/api/tournaments/' + tid), 403, 'forbidden');
  assert.equal(ok(await call(X, 'GET', '/api/tournaments/' + tid)).tournament.can.score, false);
});

let m1, mId;
test('матч: старт, замок, события по seq', async () => {
  const t = ok(await call(A, 'GET', '/api/tournaments/' + tid)).tournament;
  // первая игра с двумя игроками
  const B = require('../shared/bracket.js');
  const g = t.games.find(x => B.gameState(t, x).st === 'ready');
  mId = mid();
  m1 = ok(await call(A, 'PUT', '/api/matches/' + mId, { tournamentId: tid, r: g.r, i: g.i }), 201).match;
  assert.equal(m1.status, 'live');
  assert.equal(m1.lock.mine, true);
  ok(await call(A, 'PUT', '/api/matches/' + mId, { tournamentId: tid, r: g.r, i: g.i }), 200); // повтор безопасен
  const A2 = Object.assign({}, A, { dev: dev() });
  const busy = err(await call(A2, 'PUT', '/api/matches/' + mid(), { tournamentId: tid, r: g.r, i: g.i }), 409, 'game_taken');
  assert.equal(busy.matchId, mId);
  const t2 = ok(await call(A, 'GET', '/api/tournaments/' + tid)).tournament;
  assert.equal(t2.live[g.r + ':' + g.i], mId);
  assert.ok(t2.version > t.version);

  const evs = matchEvents(m1, 0);
  // пропуск
  assert.equal(err(await call(A, 'POST', `/api/matches/${mId}/events`, { events: [evs[1]] }), 409, 'seq_gap').expectSeq, 1);
  // неверный остаток
  err(await call(A, 'POST', `/api/matches/${mId}/events`, { events: [Object.assign({}, evs[0], { s: 500 })] }), 422, 'bad_event');
  // невозможные очки и чужая очередь
  err(await call(A, 'POST', `/api/matches/${mId}/events`, { events: [Object.assign({}, evs[0], { pts: 179 })] }), 422, 'bad_event');
  err(await call(A, 'POST', `/api/matches/${mId}/events`, { events: [Object.assign({}, evs[0], { p: 1 })] }), 422, 'bad_event');
  // чужое устройство
  err(await call(A2, 'POST', `/api/matches/${mId}/events`, { events: [evs[0]] }), 423, 'locked');
  // два подхода, повтор, отмена и снова
  let r = ok(await call(A, 'POST', `/api/matches/${mId}/events`, { events: evs.slice(0, 2) }));
  assert.equal(r.seq, 2);
  r = ok(await call(A, 'POST', `/api/matches/${mId}/events`, { events: evs.slice(0, 2) }));
  assert.equal(r.seq, 2);
  ok(await call(A, 'POST', `/api/matches/${mId}/events`, { events: [{ seq: 3, type: 'undo' }] }));
  const rest = matchEvents(m1, 0).slice(1).map((e, k) => Object.assign(e, { seq: 4 + k }));
  // закрытие 141 одним дротиком невозможно
  const bad = rest.map(e => Object.assign({}, e));
  const fin = bad.findIndex(e => e.type === 'visit' && e.pts === 141);
  bad[fin].n = 1;
  err(await call(A, 'POST', `/api/matches/${mId}/events`, { events: bad }), 422, 'bad_event');
  // finish с неверной статистикой
  const wrong = rest.map(e => Object.assign({}, e));
  wrong[wrong.length - 1] = Object.assign({}, wrong[wrong.length - 1], { pl: wrong[wrong.length - 1].pl.map(l => Object.assign({}, l, { pts: l.pts + 1 })) });
  err(await call(A, 'POST', `/api/matches/${mId}/events`, { events: wrong }), 422, 'bad_event');
  r = ok(await call(A, 'POST', `/api/matches/${mId}/events`, { events: rest }));
  assert.equal(r.seq, 3 + rest.length);
  // после завершения отмена не принимается
  err(await call(A, 'POST', `/api/matches/${mId}/events`, { events: [{ seq: r.seq + 1, type: 'undo' }] }), 409, 'bad_state');
});

test('результат в сетке, версии и зрители', async () => {
  const t = ok(await call(null, 'GET', '/api/tournaments/' + tid)).tournament;
  const g = t.games.find(x => x.res && x.res.mid === mId);
  assert.ok(g, 'результат записан в сетку');
  assert.equal(g.res.w, m1.players[0].id);
  assert.equal(t.live[g.r + ':' + g.i], undefined);
  assert.equal((await call(null, 'GET', `/api/tournaments/${tid}?since=${t.version}`)).s, 204);
  assert.equal((await call(null, 'GET', `/api/tournaments/${tid}?since=${t.version - 1}`)).s, 200);
  const full = ok(await call(null, 'GET', '/api/matches/' + mId));
  assert.equal(full.match.status, 'done');
  assert.equal(full.match.card.pl.length, 2);
  assert.ok(full.match.card.label);
  assert.equal(full.events.filter(e => e.type === 'visit').length, matchEvents(m1, 0).length - 1 + 1); // одна отменённая
  assert.equal((await call(null, 'GET', `/api/matches/${mId}?since=${full.version}`)).s, 204);
  const part = ok(await call(null, 'GET', `/api/matches/${mId}?since=${full.version - 1}`));
  assert.equal(part.events.length, 1);
  assert.equal(part.events[0].type, 'finish');
  const feed = ok(await call(null, 'GET', '/api/feed?limit=5'));
  assert.equal(feed.items[0].match.id, mId);
});

test('отмена завершения и повторное завершение', async () => {
  const before = ok(await call(null, 'GET', '/api/players/' + m1.players[0].id));
  const r = ok(await call(A, 'POST', `/api/matches/${mId}/reopen`));
  assert.equal(r.match.status, 'live');
  const t = ok(await call(null, 'GET', '/api/tournaments/' + tid)).tournament;
  assert.ok(!t.games.some(x => x.res && x.res.mid === mId));
  const mid1 = ok(await call(null, 'GET', '/api/players/' + m1.players[0].id));
  assert.equal(mid1.stats.all.n, before.stats.all.n - 1);
  // отменить последний подход и закрыть заново
  const last = r.match.lastSeq;
  const legs = matchEvents(m1, 0);
  const fin = legs[legs.length - 1], closing = legs[legs.length - 2];
  ok(await call(A, 'POST', `/api/matches/${mId}/events`, { events: [{ seq: last + 1, type: 'undo' }, Object.assign({}, closing, { seq: last + 2 }), Object.assign({}, fin, { seq: last + 3 })] }));
  const after = ok(await call(null, 'GET', '/api/players/' + m1.players[0].id));
  assert.equal(after.stats.all.n, before.stats.all.n);
  assert.equal(after.player.r, before.player.r);
});

test('забрать ведение счёта', async () => {
  const t = ok(await call(A, 'GET', '/api/tournaments/' + tid)).tournament;
  const B = require('../shared/bracket.js');
  const g = t.games.find(x => B.gameState(t, x).st === 'ready');
  const s = B.gameState(t, g);
  const id = mid();
  const m = ok(await call(A, 'PUT', '/api/matches/' + id, { tournamentId: tid, r: g.r, i: g.i, starter: 1 }), 201).match;
  const P = await login(s.a === ME ? s.b : s.a);
  const X = await login('p16'); // не участник турнира
  err(await call(X, 'POST', `/api/matches/${id}/takeover`), 403);
  const evs = matchEvents(m, 1);
  ok(await call(A, 'POST', `/api/matches/${id}/events`, { events: evs.slice(0, 2) }));
  const tk = ok(await call(P, 'POST', `/api/matches/${id}/takeover`));
  assert.equal(tk.events.length, 2);
  assert.equal(tk.match.lock.mine, true);
  err(await call(A, 'POST', `/api/matches/${id}/events`, { events: [evs[2]] }), 423, 'locked');
  ok(await call(P, 'POST', `/api/matches/${id}/events`, { events: evs.slice(2) }));
  const done = ok(await call(null, 'GET', '/api/matches/' + id)).match;
  assert.equal(done.status, 'done');
  assert.equal(done.w, 1);
});

test('быстрый счёт, снятие результата, весь турнир до конца', async () => {
  const B = require('../shared/bracket.js');
  let t = ok(await call(A, 'GET', '/api/tournaments/' + tid)).tournament;
  // неверный счёт
  const g0 = t.games.find(x => B.gameState(t, x).st === 'ready');
  err(await call(A, 'POST', `/api/tournaments/${tid}/games/${g0.r}/${g0.i}/result`, { la: 0, lb: 0 }), 400);
  for (;;) {
    t = ok(await call(A, 'GET', '/api/tournaments/' + tid)).tournament;
    const g = t.games.find(x => B.gameState(t, x).st === 'ready');
    if (!g) break;
    const r = ok(await call(A, 'POST', `/api/tournaments/${tid}/games/${g.r}/${g.i}/result`, { la: 1, lb: 0 }));
    assert.equal(r.match.quick, true);
  }
  assert.equal(t.status, 'done');
  // результат первого круга снять нельзя: от него зависят сыгранные матчи
  const first = t.games.find(x => x.r === 0 && x.res);
  err(await call(A, 'DELETE', '/api/matches/' + first.res.mid), 409, 'result_locked');
  // последний матч снять можно — турнир снова идёт
  const lastRound = Math.max(...t.games.map(x => x.r));
  const fin = t.games.find(x => x.r === lastRound && x.res);
  ok(await call(A, 'DELETE', '/api/matches/' + fin.res.mid));
  t = ok(await call(A, 'GET', '/api/tournaments/' + tid)).tournament;
  assert.equal(t.status, 'live');
  ok(await call(A, 'POST', `/api/tournaments/${tid}/games/${fin.r}/${fin.i}/result`, { la: 0, lb: 1 }));
  const card = ok(await call(null, 'GET', '/api/tournaments?status=done&q=Тест')).tournaments[0];
  assert.ok(card.champion);
  // места 1..5 все разные
  const prof = await Promise.all(t.players.map(id => call(null, 'GET', '/api/players/' + id)));
  const places = prof.map(p => p.b.tournaments.find(x => x.id === tid).place);
  assert.deepEqual(places.map(p => p[0]).sort(), [1, 2, 3, 4, 5]);
  assert.ok(places.every(p => p[0] === p[1]));
});

test('регистрация и запуск', async () => {
  const t = ok(await call(A, 'POST', '/api/tournaments', { name: 'Рег', format: 'rr', mode: 501, ltw: 2, reg: true, cap: 4 }), 201).tournament;
  assert.equal(t.status, 'reg');
  assert.deepEqual(t.can, { org: true, stream: true, edit: true, delete: true, launch: true, score: false, join: true, staff: true, fees: true });
  const U = await login('p5');
  ok(await call(U, 'POST', `/api/tournaments/${t.id}/entries`));
  assert.equal(err(await call(U, 'POST', `/api/tournaments/${t.id}/entries`), 409).reason, 'already');
  err(await call(A, 'POST', `/api/tournaments/${t.id}/launch`), 409, 'bad_state');
  err(await call(U, 'POST', `/api/tournaments/${t.id}/entries`, { playerId: 'p6' }), 403);
  for (const p of ['p6', 'p7', 'p8']) ok(await call(A, 'POST', `/api/tournaments/${t.id}/entries`, { playerId: p }));
  assert.equal(err(await call(A, 'POST', `/api/tournaments/${t.id}/entries`), 409).reason, 'full');
  ok(await call(U, 'DELETE', `/api/tournaments/${t.id}/entries/p5`));
  ok(await call(A, 'PATCH', `/api/tournaments/${t.id}`, { name: 'Рег 2', cap: 5 }));
  err(await call(U, 'PATCH', `/api/tournaments/${t.id}`, { name: 'Взлом' }), 403);
  const live = ok(await call(A, 'POST', `/api/tournaments/${t.id}/launch`)).tournament;
  assert.equal(live.status, 'live');
  assert.equal(live.name, 'Рег 2');
  assert.equal(live.games.length, 3); // 3 игрока: каждый с каждым
  assert.ok(live.games.every(g => g.a && g.b));
  err(await call(A, 'PATCH', `/api/tournaments/${t.id}`, { name: 'Поздно' }), 409, 'bad_state');
});

test('дружеский матч с гостем', async () => {
  const before = ok(await call(null, 'GET', '/api/players/' + ME)).stats;
  const id = mid();
  const m = ok(await call(A, 'PUT', '/api/matches/' + id, { mode: 501, ltw: 1, dbl: true, players: [{ id: ME }, { name: 'Гость' }] }), 201).match;
  assert.deepEqual(m.players.map(p => p.name), ['Тестовый Игрок', 'Гость']);
  ok(await call(A, 'POST', `/api/matches/${id}/events`, { events: matchEvents(m, 1) }));
  const after = ok(await call(null, 'GET', '/api/players/' + ME)).stats;
  assert.equal(after.all.n, before.all.n + 1);
  assert.equal(after.tour.n, before.tour.n);
  err(await call(A, 'PUT', '/api/matches/' + mid(), { mode: 501, ltw: 1, players: [{ name: 'А' }, { name: 'Б' }] }), 400);
  const g = ok(await call(A, 'POST', '/api/players', { name: 'Новичок Петров' })).player;
  assert.equal(ok(await call(A, 'POST', '/api/players', { name: 'новичок  петров' })).player.id, g.id);
});

test('рейтинг после всех изменений совпадает с полным пересчётом, удаление турнира', async () => {
  const snap = async () => (await pool.query('SELECT id, rating, rated FROM players ORDER BY id')).rows.map(x => [x.id, Math.round(x.rating * 1e6), x.rated]);
  const a = await snap();
  await tx(eloAll);
  assert.deepEqual(await snap(), a);
  const r1 = ok(await call(null, 'GET', '/api/rating?limit=200'));
  ok(await call(A, 'DELETE', '/api/tournaments/' + tid));
  err(await call(null, 'GET', '/api/tournaments/' + tid), 404);
  const r2 = ok(await call(null, 'GET', '/api/rating?limit=200'));
  assert.notDeepEqual(r1.rows, r2.rows);
  const b = await snap();
  await tx(eloAll);
  assert.deepEqual(await snap(), b);
});

test('одновременные запросы: один старт на игру, без дублей подходов', async () => {
  const B = require('../shared/bracket.js');
  const t = ok(await call(A, 'POST', '/api/tournaments', { name: 'Гонка', format: 'ko', mode: 501, ltw: 1, players: [ME, 'p1', 'p2', 'p3'] }), 201).tournament;
  const g = t.games.find(x => B.gameState(t, x).st === 'ready');
  const devs = await Promise.all([0, 1, 2, 3, 4].map(() => login(ME)));
  const res = await Promise.all(devs.map(u => call(u, 'PUT', '/api/matches/' + mid(), { tournamentId: t.id, r: g.r, i: g.i })));
  assert.equal(res.filter(r => r.s === 201).length, 1);
  assert.equal(res.filter(r => r.s === 409 && r.b.error.code === 'game_taken').length, 4);
  const k = res.findIndex(r => r.s === 201), m = res[k].b.match, u = devs[k];
  const evs = matchEvents(m, 0);
  const sent = await Promise.all([0, 1, 2].map(() => call(u, 'POST', `/api/matches/${m.id}/events`, { events: evs.slice(0, 3) })));
  sent.forEach(r => assert.equal(r.s, 200, JSON.stringify(r.b)));
  const full = ok(await call(null, 'GET', '/api/matches/' + m.id));
  assert.deepEqual(full.events.map(e => e.seq), [1, 2, 3]);
});

test('вход через VK: обмен кода, новый игрок, защита state', async () => {
  const r1 = await app.inject({ method: 'GET', url: '/api/auth/vk?return=/t.t6' });
  assert.equal(r1.statusCode, 302);
  const loc = new URL(r1.headers.location);
  assert.equal(loc.host, 'id.vk.ru');
  assert.equal(loc.searchParams.get('client_id'), '5550001');
  assert.equal(loc.searchParams.get('code_challenge_method'), 's256');
  const vkCookie = r1.cookies.find(c => c.name === 'oche_vk');
  const state = loc.searchParams.get('state');
  const calls = [], realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: String(opts.body) });
    const json = String(url).includes('/oauth2/auth') ? { access_token: 'tok', user_id: 777001, state } : { user: { user_id: '777001', first_name: 'Вера', last_name: 'Котова' } };
    return { ok: true, status: 200, json: async () => json };
  };
  try {
    const bad = await app.inject({ method: 'GET', url: '/api/auth/vk/callback?code=c1&state=wrong&device_id=d1', headers: { cookie: 'oche_vk=' + vkCookie.value } });
    assert.match(bad.headers.location, /login=fail/);
    const r2 = await app.inject({ method: 'GET', url: `/api/auth/vk/callback?code=c1&state=${state}&device_id=d1`, headers: { cookie: 'oche_vk=' + vkCookie.value } });
    assert.equal(r2.headers.location, '/t.t6');
    const sid = r2.cookies.find(c => c.name === 'oche_sid');
    assert.ok(sid && sid.httpOnly);
    assert.match(calls[0].url, /code_verifier=/);
    assert.match(calls[0].body, /code=c1/);
    const me = JSON.parse((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: 'oche_sid=' + sid.value } })).body);
    assert.equal(me.player.name, 'Вера Котова');
    // повторный вход — тот же игрок
    const r3 = await app.inject({ method: 'GET', url: `/api/auth/vk/callback?code=c2&state=${state}&device_id=d1`, headers: { cookie: 'oche_vk=' + vkCookie.value } });
    const sid2 = r3.cookies.find(c => c.name === 'oche_sid');
    const me2 = JSON.parse((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: 'oche_sid=' + sid2.value } })).body);
    assert.equal(me2.player.id, me.player.id);
    // поддельная cookie не принимается
    const forged = await app.inject({ method: 'GET', url: `/api/auth/vk/callback?code=c1&state=${state}&device_id=d1`, headers: { cookie: 'oche_vk=' + encodeURIComponent(JSON.stringify({ v: 'x', s: state, r: '/' })) } });
    assert.match(forged.headers.location, /login=fail/);
  } finally { global.fetch = realFetch; }
});
