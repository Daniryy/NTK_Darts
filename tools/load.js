// Нагрузочный прогон: N игроков на сервере, как на большом турнире.
//   node tools/load.js --players 1000 [--base http://127.0.0.1:3100] [--interval 10] [--duration 60] [--viewers 2] [--pid <pid сервера>]
// Сервер — на отдельной базе (не production: нужен вход для разработки, игрок p17 — администратор из демо-данных).
//   - игроки создаются через /api/admin/players, турниры по 64 игрока («все места»);
//   - все матчи первого круга идут одновременно, каждый со своего «телефона»: подход раз в --interval с;
//   - каждый игрок опрашивает свой турнир раз в 30 с (?since=версия);
//   - на каждый турнир открыто --viewers табло (поток SSE): замеряем, через сколько счёт доходит до табло.
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://127.0.0.1:3100'), N = +arg('players', 250), INTERVAL = +arg('interval', 10) * 1000;
const DURATION = +arg('duration', 60) * 1000, VIEWERS = +arg('viewers', 2), PID = arg('pid', null), POLL = 30000;
const dev = () => crypto.randomBytes(12).toString('hex');
let cookie = '';

const stats = { req: 0, err: 0, codes: {}, lat: { post: [], poll: [], sse: [] } };
async function call(method, path, body, device, kind) {
  const t0 = performance.now();
  stats.req++;
  try {
    const r = await fetch(BASE + path, { method, headers: { 'x-device-id': device || dev(), 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const txt = await r.text();
    if (kind) stats.lat[kind].push(performance.now() - t0);
    if (r.status >= 400) { stats.err++; stats.codes[r.status] = (stats.codes[r.status] || 0) + 1; }
    const sc = r.headers.get('set-cookie');
    if (sc && /oche_sid=/.test(sc)) cookie = sc.split(';')[0];
    return { s: r.status, b: txt ? JSON.parse(txt) : null };
  } catch (e) {
    stats.err++; stats.codes.net = (stats.codes.net || 0) + 1;
    return { s: 0, b: null };
  }
}
const pct = (a, p) => { if (!a.length) return '—'; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(0); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// CPU процесса из /proc: тики user+system
function ticks(pid) {
  try { const f = fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' '); return +f[11] + +f[12]; } catch (e) { return 0; }
}
const rss = pid => { try { return +fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/VmRSS:\s+(\d+)/)[1] / 1024; } catch (e) { return 0; } };
const pgPids = () => fs.readdirSync('/proc').filter(x => /^\d+$/.test(x)).filter(p => { try { return fs.readFileSync('/proc/' + p + '/comm', 'utf8').trim() === 'postgres'; } catch (e) { return false; } });

// табло: поток SSE; на событие match считаем задержку от отправки подхода
const sent = new Map(); // id матча:seq → время отправки
const got = new Map();  // id матча:seq → сколько табло получили
let late = 0;
const perTour = {}; // tid → событий на табло
function viewer(tid) {
  perTour[tid] = perTour[tid] || 0;
  const req = http.get(BASE + '/api/tournaments/' + tid + '/stream?d=' + dev(), res => {
    if (res.statusCode !== 200) stats.codes['sse' + res.statusCode] = (stats.codes['sse' + res.statusCode] || 0) + 1;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', ch => {
      buf += ch;
      let k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, k); buf = buf.slice(k + 2);
        if (!block.startsWith('event: match')) continue;
        perTour[tid]++;
        const m = JSON.parse(block.split('\ndata: ')[1]), key = m.id + ':' + m.lastSeq, t0 = sent.get(key);
        if (t0) { stats.lat.sse.push(performance.now() - t0); got.set(key, (got.get(key) || 0) + 1); } else if (m.lastSeq) late++;
      }
    });
  });
  req.on('error', () => { stats.codes.sse = (stats.codes.sse || 0) + 1; });
  return req;
}

(async () => {
  console.log('Нагрузка: ' + N + ' игроков, подход раз в ' + INTERVAL / 1000 + ' с на матч, ' + DURATION / 1000 + ' с, табло на турнир: ' + VIEWERS);
  if ((await call('POST', '/api/auth/dev', { playerId: 'p17' })).s !== 200) throw new Error('нет входа для разработки (сервер в production?)');
  // игроки
  const ids = [];
  for (let k = 0; k < N; k += 25) {
    const part = await Promise.all(Array.from({ length: Math.min(25, N - k) }, (_, j) => call('POST', '/api/admin/players', { name: 'Нагрузка ' + (k + j + 1), city: 'Тест' })));
    part.forEach(r => { if (r.b && r.b.player) ids.push(r.b.player.id); });
  }
  console.log('игроков создано: ' + ids.length);
  // турниры по 64
  const tours = [];
  for (let k = 0; k < ids.length; k += 64) {
    const pl = ids.slice(k, k + 64);
    if (pl.length < 3) break;
    const r = await call('POST', '/api/tournaments', { name: 'Нагрузка ' + (tours.length + 1), format: 'pl', mode: 501, ltw: 3, players: pl });
    if (r.b && r.b.tournament) tours.push(r.b.tournament);
  }
  const B = require('../shared/bracket.js');
  const games = [];
  tours.forEach(t => { const rv = B.resolver(t); t.games.forEach(g => { const s = B.gameState(t, g, rv); if (s.st === 'ready') games.push({ tid: t.id, r: g.r, i: g.i }); }); });
  console.log('турниров: ' + tours.length + ', матчей одновременно: ' + games.length);
  // табло
  const views = [];
  tours.forEach(t => { for (let v = 0; v < VIEWERS; v++) views.push(viewer(t.id)); });
  await sleep(1000);
  // матчи: старт каждого со своего устройства
  const matches = await Promise.all(games.map(async g => {
    const id = 'g' + crypto.randomBytes(8).toString('hex'), device = dev();
    const r = await call('PUT', '/api/matches/' + id, { tournamentId: g.tid, r: g.r, i: g.i }, device);
    return r.s === 201 ? { id, device, seq: 0, sc: [501, 501], p: 0, leg: 1 } : null;
  }));
  const live = matches.filter(Boolean);
  console.log('матчей начато: ' + live.length);
  const t0ticks = PID ? ticks(PID) : 0, pg0 = pgPids().reduce((a, p) => a + ticks(p), 0), started = Date.now();
  let stop = false;
  // маркеры: подход по 60 очков (лег не кончается за время прогона, нагрузка ровная)
  const markers = live.map(async (m, k) => {
    await sleep((k / live.length) * INTERVAL);
    while (!stop) {
      const pts = m.sc[m.p] > 100 ? 60 : 0, ev = { seq: m.seq + 1, type: 'visit', leg: m.leg, p: m.p, s: m.sc[m.p], pts, n: 3, b: 0, d: null };
      sent.set(m.id + ':' + ev.seq, performance.now());
      const r = await call('POST', '/api/matches/' + m.id + '/events', { events: [ev] }, m.device, 'post');
      if (!stop) m.counted = (m.counted || 0) + 1;
      if (r.s === 200) { m.seq++; m.sc[m.p] -= pts; m.p = 1 - m.p; }
      await sleep(INTERVAL);
    }
  });
  // игроки: опрос своего турнира раз в 30 с
  const pollers = ids.map(async (pid, k) => {
    const t = tours[Math.floor(k / 64)];
    if (!t) return;
    const device = dev();
    let ver = t.version;
    await sleep((k / ids.length) * POLL);
    while (!stop) {
      const r = await call('GET', '/api/tournaments/' + t.id + '?since=' + ver, undefined, device, 'poll');
      if (r.s === 200 && r.b) ver = r.b.tournament.version;
      await sleep(POLL);
    }
  });
  await sleep(DURATION);
  stop = true;
  const secs = (Date.now() - started) / 1000, hz = 100;
  const cpu = PID ? ((ticks(PID) - t0ticks) / hz / secs * 100).toFixed(1) : '—';
  const pgcpu = ((pgPids().reduce((a, p) => a + ticks(p), 0) - pg0) / hz / secs * 100).toFixed(1);
  await sleep(1500);
  views.forEach(v => v.destroy());
  const expect = live.reduce((a, m) => a + (m.counted || 0), 0) * VIEWERS, missed = [...sent.keys()].filter(k => !got.has(k)).length;
  await Promise.race([Promise.all(markers.concat(pollers)), sleep(INTERVAL + 2000)]);
  const L = stats.lat;
  console.log('\n== итог за ' + secs.toFixed(0) + ' с');
  console.log('запросов: ' + stats.req + ' (' + (stats.req / secs).toFixed(0) + '/с), ошибок: ' + stats.err + ' ' + JSON.stringify(stats.codes));
  console.log('подход (POST events), мс: p50 ' + pct(L.post, 0.5) + ', p95 ' + pct(L.post, 0.95) + ', p99 ' + pct(L.post, 0.99) + ' · подходов: ' + L.post.length + ' (' + (L.post.length / secs).toFixed(1) + '/с)');
  console.log('опрос турнира (?since), мс: p50 ' + pct(L.poll, 0.5) + ', p95 ' + pct(L.poll, 0.95) + ' · опросов: ' + L.poll.length);
  console.log('счёт до табло (SSE), мс: p50 ' + pct(L.sse, 0.5) + ', p95 ' + pct(L.sse, 0.95) + ', p99 ' + pct(L.sse, 0.99) + ' · доставок: ' + L.sse.length + ' на ' + views.length + ' табло');
  console.log('доставлено табло: ' + stats.lat.sse.length + ' из ' + expect + ' ожидаемых; подходов без доставки: ' + missed + ', событий без отметки: ' + late);
  if (process.env.LOAD_DEBUG) console.log('событий по турнирам: ' + JSON.stringify(perTour));
  console.log('CPU сервера (Node): ' + cpu + '% одного ядра' + (PID ? ', память ' + rss(PID).toFixed(0) + ' МБ' : '') + ' · PostgreSQL: ' + pgcpu + '%');
  process.exit(0);
})();
