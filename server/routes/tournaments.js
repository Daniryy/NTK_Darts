// Турниры: список, страница с версией, создание, регистрация, запуск, быстрый счёт.
const crypto = require('node:crypto');
const B = require('../../shared/bracket.js');
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer } = require('../auth');
const T = require('../tour');
const { eloAdd, eloAll, refreshStats } = require('../stats');
const { matchCards } = require('../cards');
const { version, forget } = require('../versions');

const LIST_MAX = 50;

async function getTour(c, id, lock) {
  const row = await one(c, T.TOUR_SQL + ' WHERE t.id = $1' + (lock ? ' FOR UPDATE OF t' : ''), [id]);
  if (!row) throw E.notFound('Турнир не найден');
  return (await T.loadTours(c, [row]))[0];
}
const tourResp = async (c, id, me) => ({ tournament: T.tourJSON(await getTour(c, id, false), me) });
const needOwner = (t, me) => { if (!T.isOwner(t, me)) throw E.forbidden('Это может только организатор'); };
const bump = async (c, id) => { await c.query('UPDATE tournaments SET version = version + 1 WHERE id = $1', [id]); forget('t', id); };

function shuffle(a) {
  for (let k = a.length - 1; k > 0; k--) { const j = crypto.randomInt(k + 1); [a[k], a[j]] = [a[j], a[k]]; }
  return a;
}
// порядок посева: по рейтингу (сильнейший первым) или жеребьёвка
async function seedOrder(c, ids, seed) {
  if (seed === 'x') return shuffle(ids.slice());
  const rows = await all(c, 'SELECT id, rating FROM players WHERE id = ANY($1)', [ids]);
  const r = Object.fromEntries(rows.map(x => [x.id, x.rating]));
  return ids.slice().sort((a, b) => r[b] - r[a] || (a < b ? -1 : 1));
}

// посев и сетка; турнир становится live
async function launch(c, id, fmt, order) {
  const t = { players: [], games: [] };
  let slots = null;
  if (fmt === 'rr') t.players = order;
  else { B.setBracket(t, fmt, order); slots = t.slots; }
  await c.query('DELETE FROM entries WHERE tournament_id = $1', [id]);
  await c.query('INSERT INTO entries (tournament_id, player_id, seed_no) SELECT $1, x.id, x.n FROM unnest($2::text[]) WITH ORDINALITY AS x(id, n)', [id, order]);
  await c.query(`UPDATE tournaments SET status = 'live', slots = $2, start = $3 WHERE id = $1`, [id, slots && JSON.stringify(slots), Date.now()]);
  await T.refreshTour(c, await getTour(c, id, false));
}

// общие поля создания и правки; full — все обязательны
function tourFields(b, full, me) {
  const o = {};
  if (full || b.name !== undefined) o.name = V.str(b.name, 'name', 1, 60);
  if (full || b.city !== undefined) o.city = V.optStr(b.city, 'city', 40);
  if (full || b.venue !== undefined) o.venue = V.optStr(b.venue, 'venue', 60);
  if (full || b.format !== undefined) o.format = V.oneOf(b.format, 'format', ['pl', 'ko', 'rr']);
  if (full || b.mode !== undefined) o.mode = V.oneOf(b.mode, 'mode', [301, 501, 701]);
  if (full || b.ltw !== undefined) o.ltw = V.int(b.ltw, 'ltw', 1, 5);
  if (b.regUntil !== undefined) o.reg_until = V.optTime(b.regUntil, 'regUntil');
  if (b.start != null) o.start = V.optTime(b.start, 'start');
  if (b.official !== undefined || b.orgName !== undefined || b.orgVer !== undefined) {
    if (!me.admin) throw E.forbidden('Официальный статус задаёт администратор');
    if (b.official !== undefined) o.official = V.bool(b.official, 'official');
    if (b.orgName !== undefined) o.org_name = b.orgName == null ? null : V.str(b.orgName, 'orgName', 1, 60);
    if (b.orgVer !== undefined) o.org_ver = V.bool(b.orgVer, 'orgVer');
  }
  return o;
}

module.exports = async function (app) {
  app.get('/api/tournaments', async req => {
    const q = req.query, me = req.player, where = [], args = [];
    const arg = v => { args.push(v); return '$' + args.length; };
    if (q.status) where.push('t.status = ' + arg(V.oneOf(q.status, 'status', ['reg', 'live', 'done'])));
    if (q.city) where.push('t.city = ' + arg(String(q.city)));
    if (q.q) where.push('position(lower(' + arg(String(q.q)) + ') in lower(t.name)) > 0');
    if (q.mine === '1') {
      if (!me) throw E.auth();
      where.push(`(t.owner_id = ${arg(me.id)} OR EXISTS (SELECT 1 FROM entries e WHERE e.tournament_id = t.id AND e.player_id = $${args.length}))`);
    }
    const limit = Math.min(LIST_MAX, Math.max(1, +q.limit || 30)), offset = Math.max(0, +q.offset || 0);
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = (await one(pool, 'SELECT count(*) AS n FROM tournaments t' + w, args)).n;
    const rows = await all(pool, T.TOUR_SQL + w + ` ORDER BY CASE t.status WHEN 'live' THEN 0 WHEN 'reg' THEN 1 ELSE 2 END, t.start DESC, t.id LIMIT ${limit} OFFSET ${offset}`, args);
    return { total, tournaments: (await T.loadTours(pool, rows)).map(t => T.tourCard(t, me)) };
  });

  app.get('/api/tournaments/:id', async (req, reply) => {
    const id = req.params.id, since = req.query.since == null ? null : +req.query.since;
    if (since != null && !(Number.isInteger(since) && since >= 0)) throw E.bad('since: целое число', 'since');
    if (since != null) {
      const v = await version(pool, 't', id);
      if (v == null) throw E.notFound('Турнир не найден');
      if (v === since) return reply.code(204).send();
    }
    return tourResp(pool, id, req.player);
  });

  app.post('/api/tournaments', async (req, reply) => {
    const me = needPlayer(req), b = req.body || {};
    const f = tourFields(b, true, me);
    const reg = b.reg === undefined ? false : V.bool(b.reg, 'reg');
    const seed = b.seed == null ? 'r' : V.oneOf(b.seed, 'seed', ['r', 'x']);
    const max = T.maxPlayers(f.format);
    const ids = b.players == null && reg ? [] : b.players;
    if (!Array.isArray(ids) || ids.some(x => typeof x !== 'string')) throw E.bad('players: список id', 'players');
    if (new Set(ids).size !== ids.length) throw E.bad('Один и тот же игрок указан дважды', 'players');
    let cap;
    if (reg) {
      cap = V.int(b.cap, 'cap', 3, max);
      if (ids.length > cap) throw E.bad('Участников больше лимита мест', 'players');
    } else {
      if (ids.length < 3 || ids.length > max) throw E.bad('Участников от 3 до ' + max, 'players');
      cap = ids.length;
    }
    const res = await tx(async c => {
      if (ids.length && (await all(c, 'SELECT id FROM players WHERE id = ANY($1)', [ids])).length !== ids.length) throw E.bad('Игрок не найден', 'players');
      const row = await one(c, `INSERT INTO tournaments (name, official, owner_id, org_name, org_ver, city, venue, start, reg_until, status, format, mode, ltw, cap, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reg', $10, $11, $12, $13, $14) RETURNING id`,
      [f.name, !!f.official, me.id, f.org_name || null, !!f.org_ver, f.city || me.city || '', f.venue, f.start || Date.now(), reg ? f.reg_until || null : null, f.format, f.mode, f.ltw, cap, Date.now()]);
      if (reg) await c.query('INSERT INTO entries (tournament_id, player_id, seed_no) SELECT $1, x.id, x.n FROM unnest($2::text[]) WITH ORDINALITY AS x(id, n)', [row.id, ids]);
      else await launch(c, row.id, f.format, f.format === 'rr' ? await seedOrder(c, ids, 'r') : await seedOrder(c, ids, seed));
      return tourResp(c, row.id, me);
    });
    return reply.code(201).send(res);
  });

  app.patch('/api/tournaments/:id', async req => {
    const me = needPlayer(req);
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      if (t.status !== 'reg') throw E.conflict('bad_state', 'Менять настройки можно только до старта');
      const b = req.body || {}, f = tourFields(b, false, me);
      if (b.cap !== undefined) f.cap = V.int(b.cap, 'cap', Math.max(3, t.players.length), T.maxPlayers(f.format || t.format));
      if (f.format && t.players.length > T.maxPlayers(f.format)) throw E.bad('Для этого формата слишком много участников', 'format');
      if (f.format && !f.cap && t.cap > T.maxPlayers(f.format)) f.cap = T.maxPlayers(f.format);
      const keys = Object.keys(f);
      if (!keys.length) throw E.bad('Нечего менять');
      await c.query(`UPDATE tournaments SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')}, version = version + 1 WHERE id = $1`, [t.id, ...keys.map(k => f[k])]);
      forget('t', t.id);
      return tourResp(c, t.id, me);
    });
  });

  app.delete('/api/tournaments/:id', async req => {
    const me = needPlayer(req);
    await tx(async c => {
      // сначала матчи, потом турнир — тот же порядок блокировок, что у счётчика
      await c.query('SELECT id FROM matches WHERE tournament_id = $1 ORDER BY id FOR UPDATE', [req.params.id]);
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      const ids = (await all(c, 'SELECT DISTINCT l.player_id FROM match_lines l JOIN matches m ON m.id = l.match_id WHERE m.tournament_id = $1', [t.id])).map(x => x.player_id);
      await c.query('DELETE FROM tournaments WHERE id = $1', [t.id]);
      if (ids.length) { await eloAll(c); await refreshStats(c, ids); }
      forget('t', t.id);
    });
    return { ok: true };
  });

  app.post('/api/tournaments/:id/entries', async req => {
    const me = needPlayer(req), b = req.body || {};
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      const pid = b.playerId == null ? me.id : V.id(b.playerId, 'playerId');
      if (pid !== me.id) needOwner(t, me);
      if (t.status !== 'reg') throw E.conflict('bad_state', 'Регистрация закрыта');
      if (!await one(c, 'SELECT 1 FROM players WHERE id = $1', [pid])) throw E.notFound('Игрок не найден');
      if (t.players.includes(pid)) throw E.conflict('conflict', 'Игрок уже записан', { reason: 'already' });
      if (t.players.length >= t.cap) throw E.conflict('conflict', 'Мест нет', { reason: 'full' });
      await c.query('INSERT INTO entries (tournament_id, player_id, seed_no) VALUES ($1, $2, $3)', [t.id, pid, t.players.length + 1]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });

  app.delete('/api/tournaments/:id/entries/:pid', async req => {
    const me = needPlayer(req), pid = req.params.pid;
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      if (pid !== me.id) needOwner(t, me);
      if (t.status !== 'reg') throw E.conflict('bad_state', 'Регистрация закрыта');
      if (!t.players.includes(pid)) throw E.notFound('Игрок не записан');
      await c.query('DELETE FROM entries WHERE tournament_id = $1 AND player_id = $2', [t.id, pid]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });

  app.post('/api/tournaments/:id/launch', async req => {
    const me = needPlayer(req);
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      if (t.status !== 'reg') throw E.conflict('bad_state', 'Турнир уже начался');
      const max = T.maxPlayers(t.format);
      if (t.players.length < 3) throw E.conflict('bad_state', 'Нужно минимум 3 участника');
      if (t.players.length > max) throw E.conflict('bad_state', 'Для этого формата максимум ' + max + ' участников');
      await launch(c, t.id, t.format, await seedOrder(c, t.players, 'r'));
      forget('t', t.id);
      return tourResp(c, t.id, me);
    });
  });

  app.post('/api/tournaments/:id/games/:r/:i/result', async req => {
    const me = needPlayer(req), b = req.body || {};
    const r = +req.params.r, i = +req.params.i;
    if (!Number.isInteger(r) || !Number.isInteger(i)) throw E.bad('r и i: целые числа');
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      const busy = await one(c, 'SELECT id FROM matches WHERE tournament_id = $1 AND r = $2 AND i = $3', [t.id, r, i]);
      if (busy) throw E.conflict('game_taken', 'Этот матч уже ведётся или сыгран', { matchId: busy.id });
      const x = T.readyPair(t, r, i);
      if (!x) throw E.conflict('bad_state', 'Счёт этого матча сейчас внести нельзя');
      if (!T.canScoreGame(t, me, x.a, x.b)) throw E.forbidden('Вносить счёт может организатор или игрок этой пары');
      const la = V.int(b.la, 'la', 0, t.ltw), lb = V.int(b.lb, 'lb', 0, t.ltw);
      if (!((la === t.ltw && lb < t.ltw) || (lb === t.ltw && la < t.ltw))) throw E.bad('Победитель должен выиграть ' + t.ltw + ' лег(а)', 'la');
      const id = 'q' + crypto.randomBytes(8).toString('hex'), now = Date.now(), w = la > lb ? 0 : 1;
      const nm = pid => t._ents.find(e => e.player_id === pid).name;
      await c.query(`INSERT INTO matches (id, tournament_id, r, i, status, mode, ltw, dbl, players, legs, w, quick, created_by, started, finished)
        VALUES ($1, $2, $3, $4, 'done', $5, $6, $7, $8, $9, $10, true, $11, $12, $12)`,
      [id, t.id, r, i, t.mode, t.ltw, t.dbl, JSON.stringify([{ id: x.a, name: nm(x.a) }, { id: x.b, name: nm(x.b) }]), JSON.stringify([la, lb]), w, me.id, now]);
      // без бросков: в средние не попадает (darts 0), как на странице
      for (const [k, pid, legs] of [[0, x.a, la], [1, x.b, lb]]) {
        await c.query(`INSERT INTO match_lines (match_id, idx, player_id, name, legs, pts, darts, f9) VALUES ($1, $2, $3, $4, $5, 0, 0, NULL)`, [id, k, pid, nm(pid), legs]);
      }
      await eloAdd(c, x.a, x.b, w === 0);
      await T.refreshTour(c, await getTour(c, t.id, false));
      await refreshStats(c, [x.a, x.b]);
      forget('t', t.id);
      const m = await one(c, 'SELECT * FROM matches WHERE id = $1', [id]);
      return Object.assign(await tourResp(c, t.id, me), { match: (await matchCards(c, [m]))[0] });
    });
  });
};
