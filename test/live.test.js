// Табло: снимок идущих матчей и поток изменений на настоящем HTTP-сервере.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../shared/bracket.js');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');

let app, base, U;
async function call(method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-device-id': U.dev, cookie: U.cookie }, body: body && JSON.stringify(body) });
  return { s: r.status, b: r.status === 204 ? null : await r.json() };
}
// поток событий: читает SSE и складывает события в массив, ждёт нужное
function stream(tid) {
  const ctl = new AbortController(), events = [];
  let wake = null;
  const done = fetch(base + '/api/tournaments/' + tid + '/stream', { signal: ctl.signal }).then(async r => {
    assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        const ev = /^event: (.+)$/m.exec(block), data = /^data: (.+)$/m.exec(block);
        if (ev && data) { events.push({ type: ev[1], data: JSON.parse(data[1]), at: Date.now() }); if (wake) wake(); }
      }
    }
  }).catch(e => { if (e.name !== 'AbortError') throw e; });
  const next = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const e = events.find(pred);
      if (e) { events.splice(events.indexOf(e), 1); return e; }
      if (Date.now() > end) throw new Error('нет события за ' + ms + ' мс; есть: ' + JSON.stringify(events.map(x => x.type)));
      await new Promise(r => { wake = r; setTimeout(r, 50); });
    }
  };
  return { next, close: () => { ctl.abort(); return done; } };
}

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = 'http://127.0.0.1:' + app.server.address().port;
  U = { dev: 'live_test_device_01', cookie: '' };
  const r = await fetch(base + '/api/auth/dev', { method: 'POST', headers: { 'content-type': 'application/json', 'x-device-id': U.dev }, body: JSON.stringify({ playerId: ME }) });
  U.cookie = r.headers.get('set-cookie').split(';')[0];
});
test.after(async () => { await app.close(); await pool.end(); });

test('табло получает подходы и результат сразу после записи', async () => {
  const t = (await call('POST', '/api/tournaments', { name: 'Табло', format: 'ko', mode: 501, ltw: 1, players: [ME, 'p1', 'p2', 'p3'] })).b.tournament;
  const s = stream(t.id);
  const snap = await s.next(e => e.type === 'snapshot');
  assert.deepEqual(snap.data.matches, []);
  assert.equal(snap.data.version, t.version);

  const g = t.games.find(x => B.gameState(t, x).st === 'ready');
  const id = 'gtablo' + Date.now().toString(36);
  assert.equal((await call('PUT', '/api/matches/' + id, { tournamentId: t.id, r: g.r, i: g.i })).s, 201);
  const started = await s.next(e => e.type === 'match' && e.data.id === id);
  assert.deepEqual(started.data.state, { leg: 1, cur: 0, scores: [501, 501], last: null });
  await s.next(e => e.type === 'tour');

  const live = (await call('GET', `/api/tournaments/${t.id}/live`)).b;
  assert.equal(live.matches.length, 1);
  assert.equal(live.matches[0].by, 'Тестовый Игрок');

  // подход 180: табло видит его быстрее 300 мс после ответа сервера
  const sent = await call('POST', `/api/matches/${id}/events`, { events: [{ seq: 1, type: 'visit', leg: 1, p: 0, s: 501, pts: 180, n: 3, b: 0, d: ['T20', 'T20', 'T20'] }] });
  const okAt = Date.now();
  assert.equal(sent.s, 200);
  const v = await s.next(e => e.type === 'match' && e.data.version === sent.b.version);
  assert.ok(v.at - okAt < 300, 'задержка ' + (v.at - okAt) + ' мс');
  assert.deepEqual(v.data.state, { leg: 1, cur: 1, scores: [321, 501], last: { p: 0, pts: 180, n: 3, b: 0, d: ['T20', 'T20', 'T20'] } });

  // отмена тоже видна
  await call('POST', `/api/matches/${id}/events`, { events: [{ seq: 2, type: 'undo' }] });
  const u = await s.next(e => e.type === 'match' && e.data.lastSeq === 2);
  assert.deepEqual(u.data.state.scores, [501, 501]);

  // весь лег и завершение: матч уходит с табло, сетка получает новую версию
  const evs = [], sc = [501, 501], plan = [180, 180, 141];
  let p = 0, k = 0;
  for (;;) {
    const pts = p === 0 ? plan[k++] : 60;
    evs.push({ seq: 3 + evs.length, type: 'visit', leg: 1, p, s: sc[p], pts, n: 3, b: 0, d: null });
    sc[p] -= pts;
    if (!sc[p]) break;
    p = 1 - p;
  }
  const sum = q => evs.filter(e => e.p === q).reduce((a, e) => a + e.pts, 0), darts = q => evs.filter(e => e.p === q).length * 3;
  const pl = started.data.players.map((x, q) => ({ id: x.id, legs: q === 0 ? 1 : 0, pts: sum(q), darts: darts(q) }));
  evs.push({ seq: 3 + evs.length, type: 'finish', w: 0, pl });
  assert.equal((await call('POST', `/api/matches/${id}/events`, { events: evs })).s, 200);
  const fin = await s.next(e => e.type === 'match' && e.data.status === 'done');
  assert.equal(fin.data.w, 0);
  const tv = await s.next(e => e.type === 'tour');
  assert.ok(tv.data.version > t.version);
  assert.equal((await call('GET', `/api/tournaments/${t.id}?since=${tv.data.version}`)).s, 204);
  assert.equal((await call('GET', `/api/tournaments/${t.id}/live`)).b.matches.length, 0);

  // брошенный матч исчезает с табло
  const t2 = (await call('GET', '/api/tournaments/' + t.id)).b.tournament;
  const g2 = t2.games.find(x => B.gameState(t2, x).st === 'ready');
  const id2 = 'gtablo2' + Date.now().toString(36);
  await call('PUT', '/api/matches/' + id2, { tournamentId: t.id, r: g2.r, i: g2.i });
  await s.next(e => e.type === 'match' && e.data.id === id2);
  assert.equal((await call('DELETE', '/api/matches/' + id2)).s, 200);
  await s.next(e => e.type === 'match' && e.data.id === id2 && e.data.deleted);
  await s.close();
});

test('чужой турнир в поток не попадает, несуществующий — 404', async () => {
  const a = (await call('POST', '/api/tournaments', { name: 'А', format: 'ko', mode: 501, ltw: 1, players: [ME, 'p1', 'p2'] })).b.tournament;
  const b = (await call('POST', '/api/tournaments', { name: 'Б', format: 'ko', mode: 501, ltw: 1, players: [ME, 'p4', 'p5'] })).b.tournament;
  const s = stream(a.id);
  await s.next(e => e.type === 'snapshot');
  const g = b.games.find(x => B.gameState(b, x).st === 'ready');
  await call('PUT', '/api/matches/gother' + Date.now().toString(36), { tournamentId: b.id, r: g.r, i: g.i });
  await assert.rejects(s.next(e => e.type === 'match', 500));
  await s.close();
  assert.equal((await fetch(base + '/api/tournaments/t999/stream')).status, 404);
});
