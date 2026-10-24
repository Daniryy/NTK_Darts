// Турниры: список, страница с версией, создание, регистрация, запуск, быстрый счёт.
const crypto = require('node:crypto');
const B = require('../../shared/bracket.js');
const Games = require('../../shared/games.js');
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

// посев и сетка; турнир становится live. С квалификацией сетки ещё нет: сначала стадия qual.
async function launch(c, id, fmt, order, row) {
  const t = { players: [], games: [] };
  let slots = null;
  if (row.qual) t.players = order;
  else if (fmt === 'rr') t.players = order;
  else { B.setBracket(t, fmt, order, row.split); slots = t.slots; }
  await c.query('DELETE FROM entries WHERE tournament_id = $1', [id]);
  await c.query('INSERT INTO entries (tournament_id, player_id, seed_no) SELECT $1, x.id, x.n FROM unnest($2::text[]) WITH ORDINALITY AS x(id, n)', [id, order]);
  await c.query(`UPDATE tournaments SET status = 'live', slots = $2, block = $3, stage = $4, start = $5 WHERE id = $1`,
    [id, slots && JSON.stringify(slots), t.block || null, row.qual ? 'qual' : null, Date.now()]);
  await T.refreshTour(c, await getTour(c, id, false));
}

// упражнение: обычный x01 без лимита хранится как mode/dbl, остальное — в ex
function exField(v, field) {
  const ex = Games.norm(v);
  if (!ex) throw E.bad('Поле ' + field + ': неизвестное упражнение', field);
  return ex;
}
const QUAL_KINDS = ['score', 'round', 'sector'];

// общие поля создания и правки; full — все обязательны
function tourFields(b, full, me) {
  const o = {};
  if (full || b.name !== undefined) o.name = V.str(b.name, 'name', 1, 60);
  if (full || b.city !== undefined) o.city = V.optStr(b.city, 'city', 40);
  if (full || b.venue !== undefined) o.venue = V.optStr(b.venue, 'venue', 60);
  if (full || b.format !== undefined) o.format = V.oneOf(b.format, 'format', ['pl', 'ko', 'rr']);
  if ((full && b.ex == null) || b.mode !== undefined) o.mode = V.oneOf(b.mode, 'mode', [301, 501, 701]);
  if (full || b.ltw !== undefined) o.ltw = V.int(b.ltw, 'ltw', 1, 5);
  if (b.ex != null) {
    const ex = exField(b.ex, 'ex');
    if (ex.k === 'x01') { o.mode = ex.mode; o.dbl = ex.dbl; o.ex = ex.lim ? ex : null; }
    else o.ex = ex;
  } else if (b.ex === null) o.ex = null;
  if (b.qual != null) {
    const q = b.qual;
    if (typeof q !== 'object') throw E.bad('qual: { ex, tries }', 'qual');
    const ex = exField(q.ex, 'qual.ex');
    if (!QUAL_KINDS.includes(ex.k)) throw E.bad('Квалификация: Набор очков, Большой раунд или Сектор', 'qual.ex');
    o.qual = { ex, tries: q.tries == null ? 2 : V.int(q.tries, 'qual.tries', 1, 2) };
    if (b.split === undefined) o.split = 8;
  } else if (b.qual === null) o.qual = null;
  if (b.split != null) o.split = V.oneOf(b.split, 'split', [4, 8, 16, 32]);
  else if (b.split === null) o.split = null;
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
    if ((f.qual || f.split) && f.format !== 'pl') throw E.bad('Квалификация и сетки частями — только в формате pl', 'format');
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
      const row = await one(c, `INSERT INTO tournaments (name, official, owner_id, org_name, org_ver, city, venue, start, reg_until, status, format, mode, dbl, ltw, cap, ex, qual, split, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reg', $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
      [f.name, !!f.official, me.id, f.org_name || null, !!f.org_ver, f.city || me.city || '', f.venue, f.start || Date.now(), reg ? f.reg_until || null : null, f.format, f.mode || 501, f.dbl !== false, f.ltw, cap,
        f.ex ? JSON.stringify(f.ex) : null, f.qual ? JSON.stringify(f.qual) : null, f.split || null, Date.now()]);
      if (reg) await c.query('INSERT INTO entries (tournament_id, player_id, seed_no) SELECT $1, x.id, x.n FROM unnest($2::text[]) WITH ORDINALITY AS x(id, n)', [row.id, ids]);
      // с квалификацией порядок — как прислали (номера игроков), посев сделает квалификация
      else await launch(c, row.id, f.format, f.qual ? ids : f.format === 'rr' ? await seedOrder(c, ids, 'r') : await seedOrder(c, ids, seed), row);
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
      if ((f.qual || f.split) && (f.format || t.format) !== 'pl') throw E.bad('Квалификация и сетки частями — только в формате pl', 'format');
      ['ex', 'qual'].forEach(k => { if (f[k]) f[k] = JSON.stringify(f[k]); });
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
    const me = needPlayer(req), files = [];
    await tx(async c => {
      // сначала матчи, потом турнир — тот же порядок блокировок, что у счётчика
      await c.query('SELECT id FROM matches WHERE tournament_id = $1 ORDER BY id FOR UPDATE', [req.params.id]);
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      const ids = (await all(c, 'SELECT DISTINCT l.player_id FROM match_lines l JOIN matches m ON m.id = l.match_id WHERE m.tournament_id = $1', [t.id])).map(x => x.player_id);
      (await all(c, 'SELECT file FROM photos WHERE tournament_id = $1', [t.id])).forEach(x => files.push(x.file));
      await c.query('DELETE FROM tournaments WHERE id = $1', [t.id]);
      if (ids.length) { await eloAll(c); await refreshStats(c, ids); }
      forget('t', t.id);
    });
    require('./photos').unlink(files);
    return { ok: true };
  });

  // камеры (организатор): { streams: [{ title, url, boards: [номера мишеней] }] } — до 4, ссылка https
  app.patch('/api/tournaments/:id/streams', async req => {
    const me = needPlayer(req), b = req.body || {};
    if (!Array.isArray(b.streams) || b.streams.length > 4) throw E.bad('streams: до 4 камер', 'streams');
    const streams = b.streams.map((s, k) => {
      const url = V.str(s && s.url, 'streams', 8, 1000);
      let u;
      try { u = new URL(url); } catch (e) { throw E.bad('Камера №' + (k + 1) + ': ссылка не похожа на адрес', 'streams'); }
      if (u.protocol !== 'https:') throw E.bad('Камера №' + (k + 1) + ': нужна ссылка https', 'streams');
      const boards = s.boards == null ? [] : s.boards;
      if (!Array.isArray(boards) || boards.length > 64 || boards.some(x => !Number.isInteger(x) || x < 1 || x > 64)) throw E.bad('Камера №' + (k + 1) + ': мишени — номера 1–64', 'streams');
      return { title: s.title == null || s.title === '' ? 'Камера ' + (k + 1) : V.str(s.title, 'streams', 1, 40), url: u.href, boards: [...new Set(boards)].sort((x, y) => x - y) };
    });
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      await c.query('UPDATE tournaments SET streams = $2 WHERE id = $1', [t.id, JSON.stringify(streams)]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });

  // ссылки к итогам (организатор, в любой момент): { links: [{ title, url }] } — до 20, только http(s)
  app.patch('/api/tournaments/:id/links', async req => {
    const me = needPlayer(req), b = req.body || {};
    if (!Array.isArray(b.links) || b.links.length > 20) throw E.bad('links: до 20 ссылок', 'links');
    const links = b.links.map((l, k) => {
      const url = V.str(l && l.url, 'links', 8, 500);
      let u;
      try { u = new URL(url); } catch (e) { throw E.bad('Ссылка №' + (k + 1) + ' не похожа на адрес', 'links'); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw E.bad('Ссылка №' + (k + 1) + ': только http или https', 'links');
      return { title: l.title == null || l.title === '' ? u.hostname : V.str(l.title, 'links', 1, 60), url: u.href };
    });
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      await c.query('UPDATE tournaments SET links = $2 WHERE id = $1', [t.id, JSON.stringify(links)]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
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
      await launch(c, t.id, t.format, t._row.qual ? t.players : await seedOrder(c, t.players, 'r'), t._row);
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
      await c.query(`INSERT INTO matches (id, tournament_id, r, i, status, mode, ltw, dbl, ex, players, legs, w, quick, created_by, started, finished)
        VALUES ($1, $2, $3, $4, 'done', $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $13)`,
      [id, t.id, r, i, t.mode, t.ltw, t.dbl, t.ex ? JSON.stringify(t.ex) : null, JSON.stringify([{ id: x.a, name: nm(x.a) }, { id: x.b, name: nm(x.b) }]), JSON.stringify([la, lb]), w, me.id, now]);
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

  // результат попытки квалификации вручную (организатор); тело { v }
  app.put('/api/tournaments/:id/qual/:pid/:try', async req => {
    const me = needPlayer(req), b = req.body || {};
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      const { pid, k } = qualSlot(t, req.params);
      const max = qualMax(t.qual.ex), v = V.int(b.v, 'v', 0, max);
      const old = await one(c, 'SELECT match_id FROM qual_results WHERE tournament_id = $1 AND player_id = $2 AND try = $3', [t.id, pid, k]);
      if (old && old.match_id) throw E.conflict('game_taken', 'Эта попытка сыграна в счётчике', { matchId: old.match_id });
      const live = await one(c, `SELECT id FROM matches WHERE tournament_id = $1 AND q_player = $2 AND q_try = $3`, [t.id, pid, k]);
      if (live) throw E.conflict('game_taken', 'Эта попытка идёт в счётчике', { matchId: live.id });
      if (k > 0 && !await one(c, 'SELECT 1 FROM qual_results WHERE tournament_id = $1 AND player_id = $2 AND try = $3', [t.id, pid, k - 1])) throw E.conflict('bad_state', 'Сначала нужна попытка ' + k);
      await c.query(`INSERT INTO qual_results (tournament_id, player_id, try, v, t) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tournament_id, player_id, try) DO UPDATE SET v = EXCLUDED.v, t = EXCLUDED.t`, [t.id, pid, k, v, Date.now()]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });

  // удалить результат попытки и следующих (организатор); сыгранные в счётчике попытки удаляются вместе с матчем
  app.delete('/api/tournaments/:id/qual/:pid/:try', async req => {
    const me = needPlayer(req);
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      const { pid, k } = qualSlot(t, req.params);
      await c.query(`DELETE FROM matches WHERE tournament_id = $1 AND q_player = $2 AND q_try >= $3`, [t.id, pid, k]);
      await c.query('DELETE FROM qual_results WHERE tournament_id = $1 AND player_id = $2 AND try >= $3', [t.id, pid, k]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });

  // закончить квалификацию: посев по лучшему результату, сетки частями по split мест (организатор)
  app.post('/api/tournaments/:id/qual/close', async req => {
    const me = needPlayer(req);
    return tx(async c => {
      await c.query('SELECT id FROM matches WHERE tournament_id = $1 ORDER BY id FOR UPDATE', [req.params.id]);
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      if (t.stage !== 'qual') throw E.conflict('bad_state', 'Квалификация уже закрыта');
      if (T.qualDone(t) < 2) throw E.conflict('bad_state', 'Нужны результаты хотя бы двух игроков');
      if (Object.keys(t.live).length) throw E.conflict('bad_state', 'Ещё идут попытки в счётчике: доиграйте или удалите их', { matches: Object.values(t.live) });
      const order = T.qualOrder(t), g = { players: [], games: [] };
      B.setBracket(g, 'pl', order, t.split || 8);
      await c.query('DELETE FROM entries WHERE tournament_id = $1', [t.id]);
      await c.query('INSERT INTO entries (tournament_id, player_id, seed_no) SELECT $1, x.id, x.n FROM unnest($2::text[]) WITH ORDINALITY AS x(id, n)', [t.id, order]);
      await c.query(`UPDATE tournaments SET stage = NULL, slots = $2, block = $3, nums = $4 WHERE id = $1`,
        [t.id, JSON.stringify(g.slots), g.block || null, JSON.stringify(Object.fromEntries(order.map((id, k) => [id, k + 1])))]);
      await T.refreshTour(c, await getTour(c, t.id, false));
      forget('t', t.id);
      return tourResp(c, t.id, me);
    });
  });

  // мишени (организатор): { n } — сколько их, { r, i, board } — поставить игре мишень
  app.patch('/api/tournaments/:id/boards', async req => {
    const me = needPlayer(req), b = req.body || {};
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      if (t.status === 'reg') throw E.conflict('bad_state', 'Мишени — после старта');
      let bd = t.boards ? { n: t.boards.n, at: Object.assign({}, t.boards.at) } : { n: 0, at: {} };
      if (b.n !== undefined) bd.n = V.int(b.n, 'n', 0, 64);
      if (b.board !== undefined) {
        const r = V.int(b.r, 'r', 0, 63), i = V.int(b.i, 'i', 0, 63), no = V.int(b.board, 'board', 1, Math.max(1, bd.n));
        const g = B.gameAt(t, r, i);
        if (!g || B.gameState(t, g).st !== 'ready') throw E.conflict('bad_state', 'Мишень ставится только готовой к игре паре');
        Object.keys(bd.at).forEach(k => { if (bd.at[k] === no) delete bd.at[k]; });
        bd.at[r + ':' + i] = no;
      }
      t.boards = bd.n ? bd : null;
      if (t.boards) B.assignBoards(t);
      await c.query('UPDATE tournaments SET boards = $2 WHERE id = $1', [t.id, t.boards && JSON.stringify(t.boards)]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });

  // номера игроков (организатор): { nums: { id: номер } } — только меняемые; null — номера по порядку
  app.patch('/api/tournaments/:id/nums', async req => {
    const me = needPlayer(req), b = req.body || {};
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      let nums = null;
      if (b.nums !== null) {
        if (!b.nums || typeof b.nums !== 'object' || Array.isArray(b.nums)) throw E.bad('nums: { id: номер }', 'nums');
        nums = Object.fromEntries(t.players.map((id, k) => [id, (t.nums && t.nums[id]) || k + 1]));
        for (const [id, n] of Object.entries(b.nums)) {
          if (!t.players.includes(id)) throw E.bad('Игрок ' + id + ' не участвует', 'nums');
          nums[id] = V.int(n, 'nums', 1, 999);
        }
      }
      await c.query('UPDATE tournaments SET nums = $2 WHERE id = $1', [t.id, nums && JSON.stringify(nums)]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });
};

// игрок и номер попытки из адреса; турнир должен быть в квалификации
function qualSlot(t, p) {
  if (t.stage !== 'qual') throw E.conflict('bad_state', 'Квалификация закрыта');
  const pid = p.pid, k = +p.try;
  if (!t.players.includes(pid)) throw E.notFound('Игрок не участвует');
  if (!Number.isInteger(k) || k < 0 || k >= t.qual.tries) throw E.bad('Попытка от 0 до ' + (t.qual.tries - 1), 'try');
  return { pid, k };
}
// наибольший результат упражнения квалификации
function qualMax(ex) {
  ex = Games.norm(ex);
  if (ex.k === 'score') return 180 * ex.lim;
  if (ex.k === 'round') return 9 * 210 + 6 * 25;
  return 9 * ex.lim;
}
module.exports.qualMax = qualMax;
