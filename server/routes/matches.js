// Матчи счётчика: старт с замком устройства, события по seq, завершение в сетку, зрители по версии.
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer } = require('../auth');
const { stateOf, liveState, visitOf, checkVisit, checkFinish, lineOf, lineStats, activeVisits } = require('../darts');
const Games = require('../../shared/games.js');
const { TOUR_SQL, loadTours, readyPair, canScoreGame, isStaff, canClear, refreshTour } = require('../tour');
const { eloAdd, eloAll, refreshStats, PENDING } = require('../stats');
const { matchCards, lineJSON } = require('../cards');
const { version, forget } = require('../versions');
const B = require('../../shared/bracket.js');
const { can } = require('../roles');

const ID_RE = /^g[a-z0-9]{10,30}$/;
const LOCK_MS = 10 * 60000;
const MATCH_SQL = 'SELECT m.*, lp.name AS lock_name FROM matches m LEFT JOIN players lp ON lp.id = m.lock_player';

const matchJSON = (m, req, card) => ({
  id: m.id, status: m.status, tid: m.tournament_id, r: m.r, i: m.i, mode: m.mode, ltw: m.ltw, dbl: m.dbl, starter: m.starter,
  ex: m.ex || null, q: m.q_player ? { id: m.q_player, k: m.q_try } : null,
  players: m.players, legs: m.legs, w: m.w, state: m.state, lastSeq: m.last_seq, version: m.version, started: m.started, finished: m.finished, duo: !!m.duo,
  lock: { mine: !!req.device && m.lock_device === req.device, by: m.lock_name || null, until: m.lock_until }, card: card || null
});
// повтор события совпадает с записанным: тот же тип, для подхода — тот же игрок, лег и очки
function sameEvent(row, ev) {
  if (row.type !== ev.type) return false;
  if (ev.type !== 'visit' && ev.type !== 'bull') return true;
  const d = row.data || {};
  return d.p === ev.p && d.leg === ev.leg && (ev.type === 'bull' || (d.pts === ev.pts && JSON.stringify(d.v == null ? null : d.v) === JSON.stringify(ev.v == null ? null : ev.v)));
}
const eventJSON = e => Object.assign({ seq: e.seq, type: e.type }, e.data, { t: e.t });


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
// снять результат можно, только если от него ничего не зависит; попытку квалификации — пока квалификация идёт
async function checkClear(c, t, m) {
  if (m.q_player) { if (t.stage !== 'qual') throw E.conflict('result_locked', 'Нельзя отменить: квалификация уже закрыта'); return; }
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
  await insertMatch(c, req, me, { id, tid, r, i, mode: t.mode, ltw: B.ltwOf(t, r, i), dbl: t.dbl, ex: t.ex || null, starter, players: [{ id: x.a, name: nm(x.a) }, { id: x.b, name: nm(x.b) }] });
  // матч начался — отметки «Готов» этой игры больше не нужны
  await c.query(`UPDATE tournaments SET version = version + 1, ready = ready - $2 WHERE id = $1`, [tid, r + ':' + i]);
  forget('t', tid);
}

// попытка квалификации: один игрок, один лег упражнения квалификации; сдаёт сам игрок или организатор
async function startQualMatch(c, req, me, b, id) {
  const tid = V.id(b.tournamentId, 'tournamentId'), q = b.qual || {};
  const t = await tourOf(c, tid, true);
  if (t.stage !== 'qual') throw E.conflict('bad_state', 'Квалификация закрыта');
  const pid = V.id(q.playerId, 'qual.playerId'), k = V.int(q.try, 'qual.try', 0, t.qual.tries - 1);
  if (!t.players.includes(pid)) throw E.bad('Игрок не участвует в турнире', 'qual.playerId');
  if (pid !== me.id && !isStaff(t, me)) throw E.forbidden('Попытку сдаёт сам игрок или организатор');
  const busy = await one(c, 'SELECT id FROM matches WHERE tournament_id = $1 AND q_player = $2 AND q_try = $3', [tid, pid, k]);
  if (busy) throw E.conflict('game_taken', 'Эта попытка уже идёт или сыграна', { matchId: busy.id });
  if ((t.qual.res[pid] || [])[k]) throw E.conflict('game_taken', 'Результат этой попытки уже внесён', { matchId: null });
  if (k > 0 && !(t.qual.res[pid] || [])[k - 1]) throw E.conflict('bad_state', 'Сначала нужна попытка ' + k);
  const name = t._ents.find(e => e.player_id === pid).name;
  await insertMatch(c, req, me, { id, tid, r: null, i: null, q_player: pid, q_try: k, mode: 501, ltw: 1, dbl: true, ex: Games.norm(t.qual.ex), starter: 0, players: [{ id: pid, name }] });
  await c.query('UPDATE tournaments SET version = version + 1 WHERE id = $1', [tid]);
  forget('t', tid);
}

async function startFriendly(c, req, me, b, id) {
  let ex = null, mode, dbl;
  if (b.ex != null) {
    ex = Games.norm(b.ex);
    if (!ex) throw E.bad('ex: неизвестное упражнение', 'ex');
    if (ex.k === 'x01') { mode = ex.mode; dbl = ex.dbl; if (!ex.lim) ex = null; } else { mode = 501; dbl = true; }
  } else {
    mode = V.oneOf(b.mode, 'mode', [301, 501, 701]);
    dbl = b.dbl == null ? true : V.bool(b.dbl, 'dbl');
  }
  const ltw = V.int(b.ltw, 'ltw', 1, 11);
  if (!Array.isArray(b.players) || b.players.length < 1 || b.players.length > 4) throw E.bad('Игроков от 1 до 4', 'players');
  const ids = b.players.map(x => x && x.id != null ? V.id(x.id, 'players') : null).filter(Boolean);
  if (!ids.length) throw E.bad('Нужен хотя бы один игрок из базы', 'players');
  if (new Set(ids).size !== ids.length) throw E.bad('Один и тот же игрок указан дважды', 'players');
  const found = await all(c, 'SELECT id, name FROM players WHERE id = ANY($1)', [ids]);
  if (found.length !== ids.length) throw E.bad('Игрок не найден', 'players');
  const players = b.players.map(x => x && x.id != null ? { id: x.id, name: found.find(p => p.id === x.id).name } : { id: null, name: V.str(x && x.name, 'players', 1, 32) });
  const starter = b.starter == null ? 0 : V.int(b.starter, 'starter', 0, players.length - 1);
  await insertMatch(c, req, me, { id, tid: null, r: null, i: null, mode, ltw, dbl, ex, starter, players });
}

function insertMatch(c, req, me, m) {
  const now = Date.now();
  return c.query(`INSERT INTO matches (id, tournament_id, r, i, q_player, q_try, status, mode, ltw, dbl, ex, starter, players, legs, state, lock_device, lock_player, lock_until, created_by, started)
    VALUES ($1, $2, $3, $4, $5, $6, 'live', $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $16, $18)`,
  [m.id, m.tid, m.r, m.i, m.q_player || null, m.q_player ? m.q_try : null, m.mode, m.ltw, m.dbl, m.ex ? JSON.stringify(m.ex) : null, m.starter,
    JSON.stringify(m.players), JSON.stringify(m.players.map(() => 0)), JSON.stringify(liveState(m, [])), req.device, me.id, now + LOCK_MS, now]);
}

async function finishMatch(c, m, st, lines, now) {
  await c.query(`UPDATE matches SET status = 'done', w = $2, finished = $3 WHERE id = $1`, [m.id, st.winner, now]);
  for (const l of lines) {
    await c.query(`INSERT INTO match_lines (match_id, idx, player_id, name, legs, pts, darts, f9, hi, hco, c180, c140, c100, coh, coa, bl, sc)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [m.id, l.idx, l.player_id, l.name, l.legs, l.pts, l.darts, l.f9, l.hi, l.hco, l.c180, l.c140, l.c100, l.coh, l.coa, l.bl, l.sc ? JSON.stringify(l.sc) : null]);
  }
  if (m.q_player) {
    // результат попытки — итог лега; если квалификацию уже закрыли или результат внесли вручную, матч остаётся тренировкой
    const t = await tourOf(c, m.tournament_id, true);
    if (t.stage === 'qual') await c.query(`INSERT INTO qual_results (tournament_id, player_id, try, v, match_id, t) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tournament_id, player_id, try) DO NOTHING`, [m.tournament_id, m.q_player, m.q_try, st.legsLog[0].tot[0], m.id, now]);
  } else if (m.tournament_id) {
    // рейтинг Эло — только официальные и клубные турниры: в своём турнире любой мог бы вписать кого угодно
    const t = await tourOf(c, m.tournament_id, true);
    if (t.official) await eloAdd(c, m.players[0].id, m.players[1].id, st.winner === 0);
  }
  await afterResult(c, m.tournament_id, m.players.map(p => p.id), false);
}

module.exports = async function (app) {
  // «Готов» (игрок готовой игры сетки у мишени): { on } — отметиться или снять отметку. Когда готовы оба —
  // матч начинается сам, счёт ведёт телефон того, кто отметился вторым; ответ { ready: [id], match | null }
  app.post('/api/tournaments/:id/games/:r/:i/ready', async req => {
    const me = needPlayer(req), b = req.body || {}, on = b.on == null ? true : V.bool(b.on, 'on');
    const r = V.int(+req.params.r, 'r', 0, 63), i = V.int(+req.params.i, 'i', 0, 63), key = r + ':' + i;
    return tx(async c => {
      const t = await tourOf(c, req.params.id, true);
      const busy = await one(c, 'SELECT id FROM matches WHERE tournament_id = $1 AND r = $2 AND i = $3', [t.id, r, i]);
      if (busy) throw E.conflict('game_taken', 'Матч уже идёт', { matchId: busy.id });
      const x = readyPair(t, r, i);
      if (!x) throw E.conflict('bad_state', 'Эта игра сейчас не готова');
      if (me.id !== x.a && me.id !== x.b) throw E.forbidden('«Готов» отмечают игроки этой пары');
      const all = Object.assign({}, t.ready || {}), cur = Object.assign({}, all[key] || {});
      if (on) cur[me.id] = Date.now(); else delete cur[me.id];
      // устаревшие отметки (игры, которые уже не готовы) не копятся
      Object.keys(all).forEach(k => { const [rr, ii] = k.split(':').map(Number); if (!readyPair(t, rr, ii)) delete all[k]; });
      let match = null;
      if (cur[x.a] && cur[x.b]) {
        delete all[key];
        const id = 'g' + require('node:crypto').randomBytes(10).toString('hex');
        const nm = pid => t._ents.find(e => e.player_id === pid).name;
        await insertMatch(c, req, me, { id, tid: t.id, r, i, mode: t.mode, ltw: B.ltwOf(t, r, i), dbl: t.dbl, ex: t.ex || null, starter: 0, players: [{ id: x.a, name: nm(x.a) }, { id: x.b, name: nm(x.b) }] });
        // оба отметились со своих телефонов — каждый вносит свои подходы сам
        await c.query('UPDATE matches SET duo = true WHERE id = $1', [id]);
        match = matchJSON(await one(c, MATCH_SQL + ' WHERE m.id = $1', [id]), req);
      } else if (Object.keys(cur).length) all[key] = cur; else delete all[key];
      await c.query('UPDATE tournaments SET ready = $2, version = version + 1 WHERE id = $1', [t.id, Object.keys(all).length ? JSON.stringify(all) : null]);
      forget('t', t.id);
      return { ready: match ? [x.a, x.b] : Object.keys(cur), match };
    });
  });

  app.put('/api/matches/:id', async (req, reply) => {
    const me = needPlayer(req), id = req.params.id, b = req.body || {};
    if (!ID_RE.test(id)) throw E.bad('id матча: «g» и 10–30 латинских букв или цифр', 'id');
    const res = await tx(async c => {
      const ex = await one(c, MATCH_SQL + ' WHERE m.id = $1 FOR UPDATE OF m', [id]);
      if (ex) {
        if (ex.created_by === me.id && ex.lock_device === req.device) {
          // до первого подхода повтор старта может сменить того, кто начинает («Начинает другой»)
          const st = b.starter == null ? ex.starter : V.int(b.starter, 'starter', 0, ex.players.length - 1);
          if (ex.status === 'live' && ex.last_seq === 0 && st !== ex.starter) {
            await c.query('UPDATE matches SET starter = $2, state = $3, version = version + 1 WHERE id = $1', [id, st, JSON.stringify(liveState(Object.assign({}, ex, { starter: st }), []))]);
            forget('m', id);
            return { code: 200, m: await one(c, MATCH_SQL + ' WHERE m.id = $1', [id]) };
          }
          return { code: 200, m: ex };
        }
        throw E.conflict('conflict', 'Матч с таким id уже есть');
      }
      if (b.tournamentId != null && b.qual != null) await startQualMatch(c, req, me, b, id);
      else if (b.tournamentId != null) await startTourMatch(c, req, me, b, id);
      else await startFriendly(c, req, me, b, id);
      return { code: 201, m: await one(c, MATCH_SQL + ' WHERE m.id = $1', [id]) };
    });
    return reply.code(res.code).send({ match: matchJSON(res.m, req) });
  });

  app.post('/api/matches/:id/events', async req => {
    const me = needPlayer(req);
    const evs = (req.body || {}).events;
    if (!Array.isArray(evs) || evs.length < 1 || evs.length > 50) throw E.bad('events: от 1 до 50 событий', 'events');
    return tx(async c => {
      const m = await lockMatch(c, req.params.id);
      // «каждый за себя»: игрок пары вносит со своего телефона только свои подходы (и отменяет только свой последний)
      const own = m.duo ? m.players.findIndex(p => p.id === me.id) : -1;
      if (own < 0 && m.lock_device !== req.device) throw E.locked(m.lock_name, m.lock_until);
      const rows = await all(c, 'SELECT seq, type, data FROM match_events WHERE match_id = $1 ORDER BY seq', [m.id]);
      const visits = activeVisits(rows), now = Date.now(), add = [], byseq = new Map(rows.map(r => [r.seq, r]));
      let seq = m.last_seq, ver = m.version, done = m.status === 'done', fin = null;
      for (const ev of evs) {
        if (!ev || !Number.isInteger(ev.seq) || ev.seq < 1) throw E.bad('seq: целое число от 1', 'events');
        if (ev.seq <= seq) {
          // уже принято: повтор безопасен. Но если под этим номером записано другое (второй телефон успел раньше) —
          // телефон отстал: пусть заберёт счёт с сервера
          const was = byseq.get(ev.seq);
          if (was && !sameEvent(was, ev)) throw E.conflict('stale', 'Счёт изменился на другом телефоне — обновляем', { expectSeq: seq + 1 });
          continue;
        }
        if (ev.seq !== seq + 1) throw E.conflict('seq_gap', 'Ожидается событие №' + (seq + 1), { expectSeq: seq + 1 });
        if (done) throw E.conflict('bad_state', 'Матч завершён');
        let data;
        if (ev.type === 'visit' || ev.type === 'bull') {
          const v = visitOf(m, ev);
          if (own >= 0 && !v.tb && v.p !== own) throw E.badEvent('Подход соперника он вносит сам со своего телефона', ev.seq);
          const err = checkVisit(m, visits, v);
          if (err) throw E.badEvent(err, ev.seq);
          visits.push(v);
          data = ev.type === 'bull' ? Object.assign({ leg: v.leg, p: v.p }, v.at ? { at: v.at } : {}) : v;
        } else if (ev.type === 'undo') {
          if (!visits.length) throw E.badEvent('Нечего отменять', ev.seq);
          if (own >= 0 && !visits[visits.length - 1].tb && visits[visits.length - 1].p !== own) throw E.badEvent('Отменить можно только свой последний подход — соперник уже бросил', ev.seq);
          visits.pop();
          data = {};
        } else if (ev.type === 'finish') {
          const st = stateOf(m, visits), err = checkFinish(m, st, ev);
          if (err) throw E.badEvent(err, ev.seq);
          const calc = lineStats(m, visits), lines = ev.pl.map((l, k) => lineOf(m, l, k, st, calc));
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
        await c.query('UPDATE matches SET last_seq = $2, version = $3, legs = $4, state = $5, lock_until = $6 WHERE id = $1',
          [m.id, seq, ver, JSON.stringify(stateOf(m, visits).legs), JSON.stringify(liveState(m, visits)), now + LOCK_MS]);
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
      const ok = m.tournament_id ? inMatch || isStaff(await tourOf(c, m.tournament_id, false), me) : inMatch || m.created_by === me.id || can(me, 'any_tour');
      if (!ok) throw E.forbidden('Забрать счёт может организатор или игрок этого матча');
      // забрать ведение — дальше счёт за обоих с этого телефона
      await c.query('UPDATE matches SET lock_device = $2, lock_player = $3, lock_until = $4, duo = false, version = version + 1 WHERE id = $1', [m.id, req.device, me.id, Date.now() + LOCK_MS]);
      forget('m', m.id);
      const rows = await all(c, 'SELECT * FROM match_events WHERE match_id = $1 ORDER BY seq', [m.id]);
      return { match: matchJSON(await one(c, MATCH_SQL + ' WHERE m.id = $1', [m.id]), req), events: rows.map(eventJSON) };
    });
  });

  app.post('/api/matches/:id/reopen', async req => {
    const me = needPlayer(req);
    return tx(async c => {
      const m = await lockMatch(c, req.params.id);
      // «каждый за себя»: вернуть матч может тот, кто бросил последний (закрывающий) подход
      const own = m.duo ? m.players.findIndex(p => p.id === me.id) : -1;
      if (own >= 0) {
        const vs = activeVisits(await all(c, 'SELECT seq, type, data FROM match_events WHERE match_id = $1 ORDER BY seq', [m.id]));
        if (!vs.length || vs[vs.length - 1].p !== own) throw E.forbidden('Вернуть матч может тот, кто бросил закрывающий подход');
      } else if (m.lock_device !== req.device) throw E.locked(m.lock_name, m.lock_until);
      if (m.status !== 'done' || m.quick) throw E.conflict('bad_state', 'Матч не завершён в счётчике');
      if (m.tournament_id) await checkClear(c, await tourOf(c, m.tournament_id, true), m);
      const now = Date.now();
      await c.query('DELETE FROM match_lines WHERE match_id = $1', [m.id]);
      if (m.q_player) await c.query('DELETE FROM qual_results WHERE match_id = $1', [m.id]);
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
      const owner = t ? isStaff(t, me) : m.created_by === me.id || can(me, 'any_tour');
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

  // чужие дружеские матчи со мной, ждущие ответа: «да, я играл» — матч идёт в мою статистику, «это не я» — нет
  app.get('/api/me/confirms', async req => {
    const me = needPlayer(req);
    const ms = await all(pool, `SELECT m.*, cp.name AS by_name FROM match_lines l JOIN matches m ON m.id = l.match_id LEFT JOIN players cp ON cp.id = m.created_by
      WHERE l.player_id = $1 AND ${PENDING('l', 'm')} ORDER BY m.finished DESC, m.id LIMIT 50`, [me.id]);
    const cards = await matchCards(pool, ms);
    return { matches: cards.map((x, k) => Object.assign(x, { by: ms[k].by_name || null })) };
  });
  app.post('/api/matches/:id/confirm', async req => {
    const me = needPlayer(req), ok = V.bool((req.body || {}).ok, 'ok');
    const left = await tx(async c => {
      const l = await one(c, `SELECT l.idx FROM match_lines l JOIN matches m ON m.id = l.match_id WHERE l.match_id = $1 AND l.player_id = $2 AND ${PENDING('l', 'm')} FOR UPDATE OF l`, [String(req.params.id), me.id]);
      if (!l) throw E.notFound('Нет такого матча на подтверждение');
      await c.query('UPDATE match_lines SET confirmed = $3 WHERE match_id = $1 AND idx = $2', [String(req.params.id), l.idx, ok]);
      if (ok) await refreshStats(c, [me.id]);
      return (await one(c, `SELECT count(*)::int AS n FROM match_lines l JOIN matches m ON m.id = l.match_id WHERE l.player_id = $1 AND ${PENDING('l', 'm')}`, [me.id])).n;
    });
    return { ok: true, left };
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
    // фото игроков — для просмотра матча
    const ids = m.players.map(p => p.id).filter(Boolean), ph = ids.length ? await all(pool, 'SELECT id, photo FROM players WHERE id = ANY($1)', [ids]) : [];
    const out = matchJSON(m, req, card);
    out.players = m.players.map(p => Object.assign({}, p, { photo: (ph.find(x => x.id === p.id) || {}).photo || null }));
    // время ходов игроков — по всем событиям (когда запрошен весь матч)
    if (since == null) out.times = require('../timing').matchTimes(m, evs);
    return { match: out, events: evs.map(eventJSON), version: m.version };
  });
};

module.exports.MATCH_SQL = MATCH_SQL;
