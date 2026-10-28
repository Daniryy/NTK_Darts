// api.js страницы против настоящего сервера: вход, очередь неотправленного (обрыв сети, повтор, seq), замок, reopen.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://oche:oche@127.0.0.1:5432/oche_test';
if (!/test/.test(new URL(process.env.DATABASE_URL).pathname)) throw new Error('TEST_DATABASE_URL должен указывать на тестовую базу');
process.env.RATE_MAX = '100000';
const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('../server/app');
const { pool, tx } = require('../server/db');
const { migrate } = require('../db/migrate');
const { seed, ME } = require('../db/seed');
const makeApi = require('../api.js');

let app;
// окно браузера для api.js: localStorage, cookie и fetch через app.inject; net=false — «нет сети»
function browser() {
  const store = {}, w = { net: true, cookie: '', calls: [] };
  w.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  w.fetch = async (url, o) => {
    w.calls.push(o.method + ' ' + url);
    if (!w.net) throw new TypeError('Failed to fetch');
    const r = await app.inject({ method: o.method, url, payload: o.body, headers: Object.assign({ cookie: w.cookie }, o.headers) });
    const set = r.cookies.find(c => c.name === 'oche_sid');
    if (set) w.cookie = 'oche_sid=' + set.value;
    return { status: r.statusCode, ok: r.statusCode < 400, json: async () => JSON.parse(r.body) };
  };
  w.crypto = require('node:crypto').webcrypto;
  return w;
}
const until = async (f, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('не дождались'); await new Promise(r => setTimeout(r, 10)); } };
const mid = () => 'g' + Math.random().toString(36).slice(2, 14).padEnd(12, '0');
const v501 = (seq, p, s, pts) => ({ type: 'visit', leg: 1, p, s, pts, n: 3, b: 0, d: null });

test.before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(() => {});
  await tx(seed);
  app = build({ logger: false });
  await app.ready();
});
test.after(async () => { await app.close(); await pool.end(); });

test('режим, вход для разработки, выход', async () => {
  const w = browser(), Api = makeApi(w);
  assert.equal(await Api.detect(), 'server');
  assert.deepEqual(Api.config, { vk: false, phone: true, phoneBy: 'call', email: true, dev: true });
  assert.equal(Api.me, null);
  await Api.devLogin(ME);
  assert.equal(Api.me.id, ME);
  assert.match(Api.device, /^[A-Za-z0-9_-]{16,64}$/);
  assert.equal(Api.device, Api.device, 'устройство одно и то же');
  await Api.logout();
  assert.equal(Api.me, null);
  w.net = false;
  const w2 = browser(); w2.net = false;
  assert.equal(await makeApi(w2).detect(), 'demo', 'без сервера — демо');
  // работала с сервером, перезагрузилась без сети — остаётся на сервере с прежним входом
  w.net = false;
  const A2 = makeApi(w);
  assert.equal(await A2.detect(), 'server');
  assert.equal(A2.offline, true);
  const w3 = browser(); w3.localStorage.setItem('oche.mode', '"demo"');
  assert.equal(await makeApi(w3).detect(), 'demo', 'закреплённое демо');
  assert.equal(w3.calls.length, 0);
});

test('очередь: без сети копится, при появлении сети уходит по порядку; повтор безопасен', async () => {
  const w = browser(), Api = makeApi(w);
  await Api.detect(); await Api.devLogin(ME);
  const id = mid();
  w.net = false;
  Api.ob.open(id, { mode: 501, ltw: 1, players: [{ id: ME }, { name: 'Гость' }] });
  Api.ob.push(id, [v501(1, 0, 501, 100)]);
  await until(() => !Api.ob.busy[id]);
  assert.equal(Api.ob.pending(id), 2, 'старт и подход ждут сети');
  Api.ob.push(id, [v501(2, 1, 501, 60), v501(3, 0, 401, 140)]);
  assert.equal(Api.ob.pending(id), 4);
  // сохранено в localStorage: новая вкладка видит ту же очередь
  assert.equal(makeApi(w).ob.pending(id), 4);
  w.net = true;
  Api.ob.wait[id] = 0;
  Api.ob.kick();
  await until(() => Api.ob.pending(id) === 0);
  const m = (await Api.get('/api/matches/' + id)).match;
  assert.equal(m.lastSeq, 3);
  assert.deepEqual(m.state.scores, [261, 441]);
  // та же очередь ещё раз (как после перезагрузки страницы): сервер пропускает принятые seq
  const it = Api.ob.get(id);
  it.acked = 0; Api.ob.save(); Api.ob.kick(id);
  await until(() => Api.ob.pending(id) === 0 && !Api.ob.busy[id]);
  assert.equal((await Api.get('/api/matches/' + id)).match.lastSeq, 3);
});

test('повтор старта до первого подхода меняет начинающего', async () => {
  const w = browser(), Api = makeApi(w);
  await Api.detect(); await Api.devLogin(ME);
  const id = mid(), body = { mode: 501, ltw: 1, starter: 0, players: [{ id: ME }, { name: 'Гость' }] };
  assert.equal((await Api.put('/api/matches/' + id, body)).match.starter, 0);
  const m = (await Api.put('/api/matches/' + id, Object.assign({}, body, { starter: 1 }))).match;
  assert.equal(m.starter, 1);
  assert.equal(m.state.cur, 1);
  await Api.post('/api/matches/' + id + '/events', { events: [{ seq: 1, type: 'visit', leg: 1, p: 1, s: 501, pts: 60, n: 3, b: 0, d: null }] });
  assert.equal((await Api.put('/api/matches/' + id, body)).match.starter, 1, 'после подходов начинающий не меняется');
});

test('очередь: замок у другого устройства останавливает отправку; забрать — и дальше', async () => {
  const a = browser(), A = makeApi(a), b = browser(), Bp = makeApi(b);
  await A.detect(); await A.devLogin(ME);
  await Bp.detect(); await Bp.devLogin(ME);
  const id = mid();
  A.ob.open(id, { mode: 501, ltw: 1, players: [{ id: ME }, { name: 'Гость' }] });
  A.ob.push(id, [v501(1, 0, 501, 100)]);
  await until(() => A.ob.pending(id) === 0);
  // второй телефон забирает ведение счёта
  const tk = await Bp.post('/api/matches/' + id + '/takeover');
  assert.equal(tk.events.length, 1);
  Bp.ob.reset(id, null, tk.match.lastSeq);
  Bp.ob.push(id, [v501(0, 1, 501, 60)]);
  await until(() => Bp.ob.pending(id) === 0);
  // первый пытается писать — замок
  A.ob.push(id, [v501(0, 1, 501, 45)]);
  await until(() => A.ob.get(id).stop);
  assert.equal(A.ob.get(id).stop.code, 'locked');
  assert.equal(A.ob.get(id).stop.by, 'Тестовый Игрок');
  assert.equal((await Bp.get('/api/matches/' + id)).match.lastSeq, 2);
});

test('очередь: завершение, отмена завершения (reopen) и новое завершение', async () => {
  const w = browser(), Api = makeApi(w);
  await Api.detect(); await Api.devLogin(ME);
  const id = mid(), sc = [301, 301], evs = [];
  Api.ob.open(id, { mode: 301, ltw: 1, players: [{ id: ME }, { name: 'Гость' }] });
  for (const [p, pts] of [[0, 180], [1, 60], [0, 121]]) { evs.push(v501(0, p, sc[p], pts)); sc[p] -= pts; }
  const fin = { type: 'finish', w: 0, pl: [{ id: ME, legs: 1, pts: 301, darts: 6 }, { id: null, legs: 0, pts: 60, darts: 3 }] };
  Api.ob.push(id, evs.concat([{ type: 'finish', w: 0, pl: fin.pl }]));
  await until(() => Api.ob.pending(id) === 0 || Api.ob.get(id).stop);
  assert.equal(Api.ob.get(id).stop, null, JSON.stringify(Api.ob.get(id).stop));
  assert.equal(Api.ob.get(id).done, true);
  // «Отменить последний бросок» после конца матча: reopen, undo, другой подход, снова finish
  Api.ob.push(id, [{ type: 'reopen' }, { type: 'undo' }, v501(0, 0, 121, 121), fin]);
  await until(() => Api.ob.pending(id) === 0 || Api.ob.get(id).stop);
  assert.equal(Api.ob.get(id).stop, null, JSON.stringify(Api.ob.get(id).stop));
  const m = (await Api.get('/api/matches/' + id)).match;
  assert.equal(m.status, 'done');
  assert.equal(m.lastSeq, 8);
  Api.ob.clean();
  assert.equal(Api.ob.get(id), null, 'отправленный завершённый матч убран из очереди');
});

test('очередь: неверный подход (422) останавливает отправку с номером события', async () => {
  const w = browser(), Api = makeApi(w);
  await Api.detect(); await Api.devLogin(ME);
  const id = mid();
  Api.ob.open(id, { mode: 501, ltw: 1, players: [{ id: ME }, { name: 'Гость' }] });
  Api.ob.push(id, [v501(0, 0, 501, 100), v501(0, 1, 501, 179)]);
  await until(() => Api.ob.get(id).stop);
  const st = Api.ob.get(id).stop;
  assert.equal(st.code, 'bad_event');
  assert.equal(st.seq, 2);
  assert.equal(Api.ob.pending(id), 2, 'пачка не принята целиком');
});
