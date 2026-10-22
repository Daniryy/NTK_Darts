// Табло турнира: снимок идущих матчей и поток изменений (Server-Sent Events).
// База сообщает об изменениях через LISTEN/NOTIFY (после COMMIT), сервер рассылает их всем открытым табло.
const pg = require('pg');
const config = require('../config');
const { pool, one, all } = require('../db');
const { E, ApiError } = require('../errors');

const MAX_CLIENTS = 3000, PING_MS = 15000;
const LIVE_SQL = `SELECT m.id, m.tournament_id, m.r, m.i, m.status, m.mode, m.ltw, m.players, m.legs, m.w, m.state, m.version, m.last_seq,
  m.lock_until, lp.name AS lock_name FROM matches m LEFT JOIN players lp ON lp.id = m.lock_player`;

const liveJSON = m => ({
  id: m.id, r: m.r, i: m.i, status: m.status, mode: m.mode, ltw: m.ltw, players: m.players, legs: m.legs, w: m.w,
  state: m.state, version: m.version, lastSeq: m.last_seq, by: m.lock_name || null
});

async function snapshot(c, tid) {
  const t = await one(c, 'SELECT version FROM tournaments WHERE id = $1', [tid]);
  if (!t) return null;
  const ms = await all(c, LIVE_SQL + ` WHERE m.tournament_id = $1 AND m.status = 'live' ORDER BY m.r, m.i`, [tid]);
  return { version: t.version, matches: ms.map(liveJSON) };
}

// tid -> Set(res)
const clients = new Map();
let count = 0, listener = null, closing = false;
const pending = new Map(); // id матча -> tid, собираем частые изменения в одну рассылку

function send(tid, event, data) {
  const set = clients.get(tid);
  if (!set) return;
  const msg = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  set.forEach(res => res.write(msg));
}

async function flush() {
  const batch = [...pending];
  pending.clear();
  const ids = batch.map(([id]) => id);
  const rows = ids.length ? await all(pool, LIVE_SQL + ' WHERE m.id = ANY($1)', [ids]) : [];
  batch.forEach(([id, tid]) => {
    const m = rows.find(x => x.id === id);
    send(tid, 'match', m ? liveJSON(m) : { id, deleted: true });
  });
}

function onNotify(msg) {
  let p;
  try { p = JSON.parse(msg.payload); } catch (e) { return; }
  if (!clients.has(p.tid)) return;
  if (msg.channel === 'oche_tour') { send(p.tid, 'tour', p.deleted ? { deleted: true } : { version: p.v }); return; }
  if (!pending.size) setTimeout(() => flush().catch(() => {}), 50);
  pending.set(p.id, p.tid);
}

// после переподключения часть уведомлений могла потеряться — каждому табло новый снимок
async function resync() {
  for (const tid of clients.keys()) {
    const s = await snapshot(pool, tid);
    send(tid, 'snapshot', s || { deleted: true });
  }
}

let wasConnected = false;
async function listen(log) {
  if (listener || closing) return;
  const c = new pg.Client({ connectionString: config.databaseUrl });
  listener = c;
  const retry = () => {
    if (listener !== c) return;
    listener = null;
    c.end().catch(() => {});
    if (!closing) setTimeout(() => listen(log).catch(() => {}), 2000);
  };
  c.on('error', e => { log.warn({ err: e.message }, 'live listener'); retry(); });
  c.on('end', retry);
  c.on('notification', onNotify);
  try {
    await c.connect();
    await c.query('LISTEN oche_tour; LISTEN oche_match');
    if (wasConnected) await resync();
    wasConnected = true;
  } catch (e) {
    retry();
    throw e;
  }
}

module.exports = async function (app) {
  closing = false;
  // до остановки HTTP-сервера: иначе открытые табло не дают ему закрыться
  app.addHook('preClose', async () => {
    closing = true;
    clients.forEach(set => set.forEach(res => res.end()));
    clients.clear();
    if (listener) { const c = listener; listener = null; await c.end().catch(() => {}); }
  });

  app.get('/api/tournaments/:id/live', async req => {
    const s = await snapshot(pool, req.params.id);
    if (!s) throw E.notFound('Турнир не найден');
    return s;
  });

  app.get('/api/tournaments/:id/stream', async (req, reply) => {
    const tid = req.params.id;
    if (count >= MAX_CLIENTS) throw new ApiError(503, 'busy', 'Слишком много открытых табло, повторите позже');
    await listen(req.log);
    const s = await snapshot(pool, tid);
    if (!s) throw E.notFound('Турнир не найден');
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\nevent: snapshot\ndata: ' + JSON.stringify(s) + '\n\n');
    if (!clients.has(tid)) clients.set(tid, new Set());
    clients.get(tid).add(res);
    count++;
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    req.raw.on('close', () => {
      clearInterval(ping);
      const set = clients.get(tid);
      if (set && set.delete(res)) count--;
      if (set && !set.size) clients.delete(tid);
    });
  });
};
