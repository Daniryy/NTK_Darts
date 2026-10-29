// Мишени в зале: свои номера, распределение игр и квалификации по мишеням, «Готов» — матч начинается сам, темп турнира.
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
const dev = () => 'device_brd_' + String(++seq).padStart(8, '0');
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

let A, PL;
const SCORE = { k: 'score', lim: 3 };
test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
  A = await login('p4'); PL = await login('p6');
});
test.after(async () => { await app.close(); await pool.end(); });



const tourOf = async (u, id) => ok(await call(u, 'GET', '/api/tournaments/' + id)).tournament;

test('мишени со своими номерами: при создании, до старта; готовые игры получают их сами', async () => {
  err(await call(A, 'POST', '/api/tournaments', { name: 'x', format: 'ko', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8', 'p9'], boards: [3, 3] }), 400);
  const t = ok(await call(A, 'POST', '/api/tournaments', { name: 'Мишени', format: 'ko', mode: 501, ltw: 1, reg: true, cap: 8, players: ['p6', 'p7', 'p8', 'p9'], boards: [3, 5] }), 201).tournament;
  assert.deepEqual(t.boards, { n: 2, at: {}, names: [3, 5] });
  // до старта номера можно поменять; 1…n подряд — без списка
  let b = ok(await call(A, 'PATCH', '/api/tournaments/' + t.id + '/boards', { names: [1, 2, 3] })).tournament.boards;
  assert.deepEqual(b, { n: 3, at: {} });
  b = ok(await call(A, 'PATCH', '/api/tournaments/' + t.id + '/boards', { names: [7, 12] })).tournament.boards;
  assert.deepEqual(b.names, [7, 12]);
  err(await call(A, 'PATCH', '/api/tournaments/' + t.id + '/boards', { r: 0, i: 0, board: 1 }), 409, 'bad_state');
  err(await call(PL, 'PATCH', '/api/tournaments/' + t.id + '/boards', { names: [1] }), 403);
  const live = ok(await call(A, 'POST', '/api/tournaments/' + t.id + '/launch')).tournament;
  assert.equal(Object.keys(live.boards.at).length, 2);
  assert.deepEqual(Object.values(live.boards.at).sort(), [1, 2]);
});

test('«Готов»: отметился один — ждём; второй — матч начинается на его телефоне', async () => {
  const t = ok(await call(A, 'POST', '/api/tournaments', { name: 'Готов', format: 'ko', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8', 'p9'], boards: [1, 2] }), 201).tournament;
  const B = require('../shared/bracket.js');
  const g = t.games.map(x => Object.assign({}, x, B.gameState(t, x))).find(x => x.r === 0 && [x.a, x.b].includes('p6'));
  const opp = g.a === 'p6' ? g.b : g.a, O = await login(opp), X = await login(['p7', 'p8', 'p9'].find(x => x !== opp));
  const url = '/api/tournaments/' + t.id + '/games/' + g.r + '/' + g.i + '/ready';
  err(await call(X, 'POST', url), 403);
  let r = ok(await call(PL, 'POST', url));
  assert.deepEqual(r.ready, ['p6']); assert.equal(r.match, null);
  assert.ok((await tourOf(PL, t.id)).ready[g.r + ':' + g.i].p6);
  // снять и снова отметиться
  assert.deepEqual(ok(await call(PL, 'POST', url, { on: false })).ready, []);
  assert.equal((await tourOf(PL, t.id)).ready, undefined);
  ok(await call(PL, 'POST', url));
  r = ok(await call(O, 'POST', url));
  assert.ok(r.match && r.match.lock.mine);
  assert.equal(r.match.status, 'live');
  assert.deepEqual(r.match.players.map(p => p.id), [g.a, g.b]);
  const after = await tourOf(PL, t.id);
  assert.equal(after.live[g.r + ':' + g.i], r.match.id);
  assert.ok(!after.ready || !after.ready[g.r + ':' + g.i]);
  err(await call(PL, 'POST', url), 409, 'game_taken');
  // оба отметились со своих телефонов — «каждый за себя»
  assert.equal(r.match.duo, true);
  const mid = r.match.id, ev = (u, e) => call(u, 'POST', '/api/matches/' + mid + '/events', { events: [e] });
  const dev = { [g.a]: g.a === 'p6' ? PL : O, [g.b]: g.b === 'p6' ? PL : O }, P0 = dev[g.a], P1 = dev[g.b];
  const v = (seq, p, s, pts) => ({ seq, type: 'visit', leg: 1, p, s, pts, n: 3, b: 0 });
  // за соперника — нельзя, свой — можно; посторонний — замок
  err(await ev(P1, v(1, 0, 501, 60)), 422, 'bad_event');
  err(await ev(X, v(1, 0, 501, 60)), 423);
  ok(await ev(P0, v(1, 0, 501, 60)));
  err(await ev(P0, v(2, 1, 501, 100)), 422, 'bad_event');
  ok(await ev(P1, v(2, 1, 501, 100)));
  // отменить свой последний подход — можно; чужой — нельзя
  err(await ev(P0, { seq: 3, type: 'undo' }), 422, 'bad_event');
  ok(await ev(P1, { seq: 3, type: 'undo' }));
  ok(await ev(P1, v(4, 1, 501, 140)));
  // отставший телефон: под этим номером уже другое — 409 stale, а не тихий пропуск подхода
  ok(await ev(P1, { seq: 5, type: 'undo' }));
  err(await ev(P0, v(5, 0, 441, 60)), 409, 'stale');
  ok(await ev(P1, v(6, 1, 501, 140)));
  const st = ok(await call(null, 'GET', '/api/matches/' + mid)).match;
  assert.equal(st.lastSeq, 6);
  assert.deepEqual(st.legs, [0, 0]);
  // «Вести счёт за обоих»: забрал ведение — дальше один телефон за обоих
  const tk = ok(await call(PL, 'POST', '/api/matches/' + mid + '/takeover'));
  assert.equal(tk.match.duo, false);
  assert.equal(tk.events.length, 6);
  ok(await ev(PL, v(7, 0, 441, 45)));
  ok(await ev(PL, v(8, 1, 361, 26)));
  err(await ev(O, v(9, 0, 396, 60)), 423);
});

test('квалификация по мишеням: по двое на мишень, сдавший освобождает место следующему', async () => {
  const ids = ['p6', 'p7', 'p8', 'p9', 'p10', 'p11'];
  const t = ok(await call(A, 'POST', '/api/tournaments', { name: 'Квала', format: 'pl', ltw: 1, ex: SCORE, qual: { ex: SCORE, tries: 1 }, players: ids, boards: [4, 9] }), 201).tournament;
  const q = t.boards.q;
  assert.equal(Object.keys(q).length, 4);
  // сначала по одному на мишень, потом вторые
  assert.deepEqual(Object.values(q).sort(), [1, 1, 2, 2]);
  const first = Object.keys(q)[0], wait = ids.filter(x => !q[x]);
  ok(await call(A, 'PUT', '/api/tournaments/' + t.id + '/qual/' + first + '/0', { v: 300 }));
  const q2 = (await tourOf(A, t.id)).boards.q;
  assert.equal(q2[first], undefined);
  assert.equal(Object.keys(q2).length, 4);
  assert.equal(q2[wait[0]], q[first]);
  // удалили результат — игрок снова ждёт мишень (мест нет — в очереди)
  ok(await call(A, 'DELETE', '/api/tournaments/' + t.id + '/qual/' + first + '/0'));
  assert.equal(Object.keys((await tourOf(A, t.id)).boards.q).length, 4);
  // все сдали — закрыли квалификацию: мишени у игр сетки
  for (const id of ids) await call(A, 'PUT', '/api/tournaments/' + t.id + '/qual/' + id + '/0', { v: 100 + ids.indexOf(id) });
  assert.deepEqual((await tourOf(A, t.id)).boards.q, {});
  const sb = ok(await call(A, 'POST', '/api/tournaments/' + t.id + '/qual/close')).tournament.boards;
  assert.equal(sb.q, undefined);
  assert.equal(Object.keys(sb.at).length, 2);
});

test('темп турнира: средняя длительность матчей в счётчике', async () => {
  const t = ok(await call(A, 'POST', '/api/tournaments', { name: 'Темп', format: 'ko', mode: 501, ltw: 1, players: ['p6', 'p7', 'p8', 'p9'] }), 201).tournament;
  assert.deepEqual(t.pace, { match: null, qual: null });
  const g = t.games.find(x => x.r === 0);
  ok(await call(A, 'POST', '/api/tournaments/' + t.id + '/games/0/' + g.i + '/result', { la: 1, lb: 0 }));
  // быстрый счёт (без бросков) в темп не идёт
  assert.equal((await tourOf(A, t.id)).pace.match, null);
  await pool.query(`INSERT INTO matches (id, tournament_id, r, i, status, mode, ltw, dbl, players, legs, w, created_by, started, finished)
    SELECT 'gpace0000001', $1, 0, 1, 'done', 501, 1, true, '[{"id":"p8"},{"id":"p9"}]', '[1,0]', 0, 'p4', 1000, 1000 + 9 * 6e4`, [t.id]);
  assert.equal((await tourOf(A, t.id)).pace.match, 9 * 6e4);
});
