// Матчи счётчика: старт с замком устройства, события по seq, завершение в сетку, зрители по версии.
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer } = require('../auth');
const { stateOf, checkVisit, checkFinish, lineOf } = require('../darts');
const { TOUR_SQL, loadTours, readyPair, canScoreGame, isOwner, canClear, refreshTour } = require('../tour');
const { eloAdd, eloAll, refreshStats } = require('../stats');
const { matchCards, lineJSON } = require('../cards');
const { version, forget } = require('../versions');
const B = require('../../shared/bracket.js');

const ID_RE = /^g[a-z0-9]{10,30}$/;
const LOCK_MS = 10 * 60000;
const MATCH_SQL = 'SELECT m.*, lp.name AS lock_name FROM matches m LEFT JOIN players lp ON lp.id = m.lock_player';

const matchJSON = (m, req, card) => ({
  id: m.id, status: m.status, tid: m.tournament_id, r: m.r, i: m.i, mode: m.mode, ltw: m.ltw, dbl: m.dbl, starter: m.starter,
  players: m.players, legs: m.legs, w: m.w, lastSeq: m.last_seq, version: m.version, started: m.started, finished: m.finished,
  lock: { mine: !!req.device && m.lock_device === req.device, by: m.lock_name || null, until: m.lock_until }, card: card || null
});
const eventJSON = e => Object.assign({ seq: e.seq, type: e.type }, e.data, { t: e.t });

// подходы, которые остались после отмен
function activeVisits(rows) {
  const v = [];
  rows.forEach(e => { if (e.type === 'visit') v.push(e.data); else if (e.type === 'undo') v.pop(); });
  return v;
}

async function lockMatch(c, id) {
  const m = await one(c, MATCH_SQL + ' WHERE m.id = $1 FOR UPDATE OF m', [id]);
  if (!m) throw E.notFound('Матч не найден');
  return m;
}
async function tourOf(c, id, lock) {
  const row = await one(c, TOUR_SQL + ' WHERE t.id = $1' + (lock ? ' FOR UPDATE OF t' : ''), [id]);
  if (!row) throw E.notFound('Турнир не найден');
  return (await loadTours(c, [row]))[0];
}
// после изменения результата: статус и места турнира, рейтинг, статистика
async function afterResult(c, tid, ids, fullElo) {
  if (tid) {
    await refreshTour(c, await tourOf(c, tid, false));
    forget('t', tid);
    if (fullElo) await eloAll(c);
  }
  await refreshStats(c, ids);
}
// снять результат можно, только если от него ничего не зависит
async function checkClear(c, t, m) {
  const live = await all(c, `SELECT r, i, players FROM matches WHERE tournament_id = $1 AND status = 'live' AND id <> $2`, [t.id, m.id]);
  if (!canClear(t, B.gameAt(t, m.r, m.i), live)) throw E.conflict('result_locked', 'Нельзя отменить: следующие матчи сетки уже сыграны или идут');
}

async function startTourMatch(c, req, me, b, id) {
  const tid = V.id(b.tournamentId, 'tournamentId'), r = V.int(b.r, 'r', 0, 63), i = V.int(b.i, 'i', 0, 63);
  const t = await tourOf(c, tid, true);
  const busy = await one(c, 'SELECT id FROM matches WHERE tournament_id = $1 AND r = $2 AND i = $3', [tid, r, i]);
  if (busy) throw E.conflict('game_taken', 'Этот матч уже ведётся или сыгран', { matchId: busy.id });
  const x = readyPair(t, r, i);
  if (!x) throw E.conflict('bad_state', 'Этот матч сейчас нельзя начать');
  if (!canScoreGame(t, me, x.a, x.b)) throw E.forbidden('Вести счёт может организатор или игрок этой пары');
  const nm = pid => t._ents.find(e => e.player_id === pid).name;
  const starter = b.starter == null ? 0 : V.int(b.starter, 'starter', 0, 1);
  await insertMatch(c, req, me, { id, tid, r, i, mode: t.mode, ltw: t.ltw, dbl: t.dbl, starter, players: [{ id: x.a, name: nm(x.a) }, { id: x.b, name: nm(x.b) }] });
  await c.query('UPDATE tournaments SET version = version + 1 WHERE id = $1', [tid]);
  forget('t', tid);
}

async function startFriendly(c, req, me, b, id) {
  const mode = V.oneOf(b.mode, 'mode', [301, 501, 701]), ltw = V.int(b.ltw, 'ltw', 1, 5);
  const dbl = b.dbl == null ? true : V.bool(b.dbl, 'dbl');
  if (!Array.isArray(b.players) || b.players.length < 1 || b.players.length > 4) throw E.bad('Игроков от 1 до 4', 'players');
  const ids = b.players.map(x => x && x.id != null ? V.id(x.id, 'players') : null).filter(Boolean);
  if (!ids.length) throw E.bad('Нужен хотя бы один игрок из базы', 'players');
  if (new Set(ids).size !== ids.length) throw E.bad('Один и тот же игрок указан дважды', 'players');
  const found = await all(c, 'SELECT id, name FROM players WHERE id = ANY($1)', [ids]);
  if (found.length !== ids.length) throw E.bad('Игрок не найден', 'players');
  const players = b.players.map(x => x && x.id != null ? { id: x.id, name: found.find(p => p.id === x.id).name } : { id: null, name: V.str(x && x.name, 'players', 1, 32) });
  const starter = b.starter == null ? 0 : V.int(b.starter, 'starter', 0, players.length - 1);
  await insertMatch(c, req, me, { id, tid: null, r: null, i: null, mode, ltw, dbl, starter, players });
}

function insertMatch(c, req, me, m) {
  const now = Date.now();
  return c.query(`INSERT INTO matches (id, tournament_id, r, i, status, mode, ltw, dbl, starter, players, legs, lock_device, lock_player, lock_until, created_by, started)
    VALUES ($1, $2, $3, $4, 'live', $5, $6, $7, $8, $9, $10, $11, $12, $13, $12, $14)`,
  [m.id, m.tid, m.r, m.i, m.mode, m.ltw, m.dbl, m.starter, JSON.stringify(m.players), JSON.stringify(m.players.map(() => 0)), req.device, me.id, now + LOCK_MS, now]);
}

async function finishMatch(c, m, st, lines, now) {
  await c.query(`UPDATE matches SET status = 'done', w = $2, finished = $3 WHERE id = $1`, [m.id, st.winner, now]);
  for (const l of lines) {
    await c.query(`INSERT INTO match_lines (match_id, idx, player_id, name, legs, pts, darts, f9, hi, hco, c180, c140, c100, coh, coa, bl)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [m.id, l.idx, l.player_id, l.name, l.legs, l.pts, l.darts, l.f9, l.hi, l.hco, l.c180, l.c140, l.c100, l.coh, l.coa, l.bl]);
  }
  if (m.tournament_id) {
    await tourOf(c, m.tournament_id, true);
    await eloAdd(c, m.players[0].id, m.players[1].id, st.winner === 0);
  }
  await afterResult(c, m.tournament_id, m.players.map(p => p.id), false);
}

module.exports = async function (app) {
  app.put('/api/matches/:id', async (req, reply) => {
    const me = needPlayer(req), id = req.params.id, b = req.body || {};
    if (!ID_RE.test(id)) throw E.bad('id матча: «g» и 10–30 латинских букв или цифр', 'id');
    const res = await tx(async c => {
      const ex = await one(c, MATCH_SQL + ' WHERE m.id = $1', [id]);
      if (ex) {
        if (ex.created_by === me.id && ex.lock_device === req.device) return { code: 200, m: ex };
        throw E.conflict('conflict', 'Матч с таким id уже есть');
      }
      if (b.tournamentId != null) await startTourMatch(c, req, me, b, id);
      else await startFriendly(c, req, me, b, id);
      return { code: 201, m: await one(c, MATCH_SQL + ' WHERE m.id = $1', [id]) };
    });
    return reply.code(res.code).send({ match: matchJSON(res.m, req) });
  });

  app.post('/api/matches/:id/events', async req => {
    needPlayer(req);
    const evs = (req.body || {}).events;
    if (!Array.isArray(evs) || evs.length < 1 || evs.length > 50) throw E.bad('events: от 1 до 50 событий', 'events');
    return tx(async c => {
      const m = await lockMatch(c, req.params.id);
      if (m.lock_device !== req.device) throw E.locked(m.lock_name, m.lock_until);
      const rows = await all(c, 'SELECT seq, type, data FROM match_events WHERE match_id = $1 ORDER BY seq', [m.id]);
      const visits = activeVisits(rows), now = Date.now(), add = [];
      let seq = m.last_seq, ver = m.version, done = m.status === 'done', fin = null;
      for (const ev of evs) {
        if (!ev || !Number.isInteger(ev.seq) || ev.seq < 1) throw E.bad('seq: целое число от 1', 'events');
        if (ev.seq <= seq) continue; // уже принято: повтор безопасен
        if (ev.seq !== seq + 1) throw E.conflict('seq_gap', 'Ожидается событие №' + (seq + 1), { expectSeq: seq + 1 });
        if (done) throw E.conflict('bad_state', 'Матч завершён');
        const st = stateOf(m, visits);
        let data;
        if (ev.type === 'visit') {
          data = { leg: ev.leg, p: ev.p, s: ev.s, pts: ev.pts, n: ev.n, b: ev.b, d: ev.d == null ? null : ev.d };
          const err = checkVisit(m, st, data);
          if (err) throw E.badEvent(err, ev.seq);
          visits.push(data);
        } else if (ev.type === 'undo') {
          if (!visits.length) throw E.badEvent('Нечего отменять', ev.seq);
          visits.pop();
          data = {};
        } else if (ev.type === 'finish') {
          const err = checkFinish(m, st, ev);
          if (err) throw E.badEvent(err, ev.seq);
          const lines = ev.pl.map((l, k) => lineOf(m, l, k));
          fin = { st, lines };
          data = { w: ev.w, pl: lines.map(lineJSON) };
          done = true;
        } else throw E.badEvent('Неизвестный тип события', ev.seq);
        seq = ev.seq; ver++;
        add.push([seq, ver, ev.type, data]);
      }
      if (add.length) {
        for (const [s, v, type, data] of add) {
          await c.query('INSERT INTO match_events (match_id, seq, ver, type, data, t) VALUES ($1, $2, $3, $4, $5, $6)', [m.id, s, v, type, JSON.stringify(data), now]);
        }
        await c.query('UPDATE matches SET last_seq = $2, version = $3, legs = $4, lock_until = $5 WHERE id = $1',
          [m.id, seq, ver, JSON.stringify(stateOf(m, visits).legs), now + LOCK_MS]);
        if (fin) await finishMatch(c, m, fin.st, fin.lines, now);
        forget('m', m.id);
      }
      return { ok: true, seq, version: ver };
    });
  });

  app.post('/api/matches/:id/takeover', async req => {
    const me = needPlayer(req);
    return tx(async c => {
      const m = await lockMatch(c, req.params.id);
      if (m.status !== 'live') throw E.conflict('bad_state', 'Матч уже завершён');
      const inMatch = m.players.some(p => p.id === me.id);
      const ok = m.tournament_id ? inMatch || isOwner(await tourOf(c, m.tournament_id, false), me) : inMatch || m.created_by === me.id || me.admin;
      if (!ok) throw E.forbidden('Забрать счёт может организатор или игрок этого матча');
      await c.query('UPDATE matches SET lock_device = $2, lock_player = $3, lock_until = $4, version = version + 1 WHERE id = $1', [m.id, req.device, me.id, Date.now() + LOCK_MS]);
      forget('m', m.id);
      const rows = await all(c, 'SELECT * FROM match_events WHERE match_id = $1 ORDER BY seq', [m.id]);
      return { match: matchJSON(await one(c, MATCH_SQL + ' WHERE m.id = $1', [m.id]), req), events: rows.map(eventJSON) };
    });
  });

  app.post('/api/matches/:id/reopen', async req => {
    needPlayer(req);
    return tx(async c => {
      const m = await lockMatch(c, req.params.id);
      if (m.lock_device !== req.device) throw E.locked(m.lock_name, m.lock_until);
      if (m.status !== 'done' || m.quick) throw E.conflict('bad_state', 'Матч не завершён в счётчике');
      if (m.tournament_id) await checkClear(c, await tourOf(c, m.tournament_id, true), m);
      const now = Date.now();
      await c.query('DELETE FROM match_lines WHERE match_id = $1', [m.id]);
      await c.query(`UPDATE matches SET status = 'live', w = NULL, finished = NULL, last_seq = last_seq + 1, version = version + 1, lock_until = $2 WHERE id = $1`, [m.id, now + LOCK_MS]);
      await c.query(`INSERT INTO match_events (match_id, seq, ver, type, data, t) VALUES ($1, $2, $3, 'reopen', '{}', $4)`, [m.id, m.last_seq + 1, m.version + 1, now]);
      await afterResult(c, m.tournament_id, m.players.map(p => p.id), true);
      forget('m', m.id);
      return { match: matchJSON(await one(c, MATCH_SQL + ' WHERE m.id = $1', [m.id]), req) };
    });
  });

  app.delete('/api/matches/:id', async req => {
    const me = needPlayer(req);
    return tx(async c => {
      const m = await lockMatch(c, req.params.id);
      const t = m.tournament_id ? await tourOf(c, m.tournament_id, true) : null;
      const owner = t ? isOwner(t, me) : m.created_by === me.id || me.admin;
      if (m.status === 'live') {
        if (!owner && m.lock_device !== req.device) throw E.forbidden('Бросить матч может тот, кто ведёт счёт, или организатор');
        await c.query('DELETE FROM matches WHERE id = $1', [m.id]);
        if (t) { await c.query('UPDATE tournaments SET version = version + 1 WHERE id = $1', [t.id]); forget('t', t.id); }
      } else {
        if (!owner) throw E.forbidden('Снять результат может организатор');
        if (t) await checkClear(c, t, m);
        await c.query('DELETE FROM matches WHERE id = $1', [m.id]);
        await afterResult(c, m.tournament_id, m.players.map(p => p.id), true);
      }
      forget('m', m.id);
      return { ok: true };
    });
  });

  app.get('/api/matches/:id', async (req, reply) => {
    const id = req.params.id, since = req.query.since == null ? null : +req.query.since;
    if (since != null && !(Number.isInteger(since) && since >= 0)) throw E.bad('since: целое число', 'since');
    if (since != null) {
      const v = await version(pool, 'm', id);
      if (v == null) throw E.notFound('Матч не найден');
      if (v === since) return reply.code(204).send();
    }
    const m = await one(pool, MATCH_SQL + ' WHERE m.id = $1', [id]);
    if (!m) throw E.notFound('Матч не найден');
    const evs = await all(pool, 'SELECT * FROM match_events WHERE match_id = $1 AND ver > $2 ORDER BY seq', [id, since || 0]);
    const card = m.status === 'done' ? (await matchCards(pool, [m]))[0] : null;
    return { match: matchJSON(m, req, card), events: evs.map(eventJSON), version: m.version };
  });
};

module.exports.MATCH_SQL = MATCH_SQL;
