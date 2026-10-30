// Турниры: список, страница с версией, создание, регистрация, запуск, быстрый счёт.
const crypto = require('node:crypto');
const B = require('../../shared/bracket.js');
const Games = require('../../shared/games.js');
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer } = require('../auth');
const { can, atLeast } = require('../roles');
const T = require('../tour');
const { eloAdd, eloAll, refreshStats } = require('../stats');
const { matchCards } = require('../cards');
const { version, forget } = require('../versions');
const { newClaim } = require('./admin');

const LIST_MAX = 50;

async function getTour(c, id, lock) {
  const row = await one(c, T.TOUR_SQL + ' WHERE t.id = $1' + (lock ? ' FOR UPDATE OF t' : ''), [id]);
  if (!row) throw E.notFound('Турнир не найден');
  return (await T.loadTours(c, [row]))[0];
}
const tourResp = async (c, id, me) => {
  const t = await getTour(c, id, false), out = T.tourJSON(t, me);
  if (t.status === 'done') out.best = await T.tourBest(c, t.id);
  return { tournament: out };
};
const needOwner = (t, me) => { if (!T.isOwner(t, me)) throw E.forbidden('Это может только организатор'); };
// организатор или помощник клуба
const needStaff = (t, me) => { if (!T.isStaff(t, me)) throw E.forbidden('Это может организатор или помощник'); };
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
// участники в порядке посева; отметки «оплатил» сохраняются
async function reseed(c, id, order) {
  const paid = (await all(c, 'SELECT player_id FROM entries WHERE tournament_id = $1 AND paid', [id])).map(x => x.player_id);
  await c.query('DELETE FROM entries WHERE tournament_id = $1', [id]);
  await c.query('INSERT INTO entries (tournament_id, player_id, seed_no, paid) SELECT $1, x.id, x.n, x.id = ANY($3) FROM unnest($2::text[]) WITH ORDINALITY AS x(id, n)', [id, order, paid]);
}
// групповой этап: в каждой группе должно быть больше игроков, чем из неё выходит
function groupsCheck(G, n) {
  if (Math.floor(n / G.n) < Math.max(2, G.adv + 1)) throw E.conflict('bad_state', 'Мало участников для ' + G.n + ' ' + (G.n === 1 ? 'группы' : 'групп') + ': в каждой нужно больше, чем выходит из неё (' + G.adv + ')');
}
const groupsRow = (G, ids) => JSON.stringify({ n: G.n, adv: G.adv, ids, done: false });

async function launch(c, id, fmt, order, row) {
  const t = { players: [], games: [], layout: row.layout };
  let slots = null, groups = row.groups || null;
  if (row.groups) groupsCheck(row.groups, order.length);
  if (row.qual) t.players = order;
  else if (row.groups) groups = groupsRow(row.groups, B.drawGroups(order, row.groups.n));
  else if (fmt === 'rr') t.players = order;
  else { B.setBracket(t, fmt, order, row.split); slots = t.slots; }
  await reseed(c, id, order);
  await c.query(`UPDATE tournaments SET status = 'live', slots = $2, block = $3, stage = $4, start = $5, groups = $6 WHERE id = $1`,
    [id, slots && JSON.stringify(slots), t.block || null, row.qual ? 'qual' : row.groups ? 'groups' : null, Date.now(), groups && (typeof groups === 'string' ? groups : JSON.stringify(groups))]);
  await T.refreshTour(c, await getTour(c, id, false));
}

// упражнение: обычный x01 без лимита хранится как mode/dbl, остальное — в ex
function exField(v, field) {
  const ex = Games.norm(v);
  if (!ex) throw E.bad('Поле ' + field + ': неизвестное упражнение', field);
  return ex;
}
const QUAL_KINDS = ['score', 'round', 'sector'];
const LTW_MAX = 11;
function ltwByField(v) {
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw E.bad('ltwBy: { f, sf, qf, early, places }', 'ltwBy');
  const o = {};
  for (const [k, x] of Object.entries(v)) {
    if (!B.STAGES.includes(k)) throw E.bad('ltwBy: стадии f, sf, qf, early, places', 'ltwBy');
    if (x != null) o[k] = V.int(x, 'ltwBy.' + k, 1, LTW_MAX);
  }
  return Object.keys(o).length ? o : null;
}

// общие поля создания и правки; full — все обязательны
function tourFields(b, full, me) {
  const o = {};
  if (full || b.name !== undefined) o.name = V.str(b.name, 'name', 1, 60);
  if (full || b.city !== undefined) o.city = V.optStr(b.city, 'city', 40);
  if (full || b.venue !== undefined) o.venue = V.optStr(b.venue, 'venue', 60);
  if (full || b.format !== undefined) o.format = V.oneOf(b.format, 'format', ['pl', 'ko', 'rr']);
  if ((full && b.ex == null) || b.mode !== undefined) o.mode = V.oneOf(b.mode, 'mode', [301, 501, 701]);
  if (full || b.ltw !== undefined) o.ltw = V.int(b.ltw, 'ltw', 1, LTW_MAX);
  // до скольких побед по стадиям сетки: { f, sf, qf, early, places }; пустое — как общее
  if (b.ltwBy !== undefined) o.ltw_by = ltwByField(b.ltwBy);
  if (b.ex != null) {
    const ex = exField(b.ex, 'ex');
    if (ex.k === 'x01') { o.mode = ex.mode; o.dbl = ex.dbl; o.ex = ex.lim ? ex : null; }
    else o.ex = ex;
  } else if (b.ex === null) o.ex = null;
  // групповой этап перед сеткой: { n: групп, adv: выходит из каждой }; null — без групп
  if (b.groups !== undefined) {
    const g = b.groups;
    if (g !== null && (typeof g !== 'object' || Array.isArray(g))) throw E.bad('groups: { n, adv }', 'groups');
    o.groups = g === null ? null : { n: V.int(g.n, 'groups.n', 1, 16), adv: V.int(g.adv, 'groups.adv', 1, 16) };
    if (o.groups && o.groups.n * o.groups.adv < 2) throw E.bad('Из групп в сетку должны выйти хотя бы двое', 'groups');
  }
  if (b.qual != null) {
    const q = b.qual;
    if (typeof q !== 'object') throw E.bad('qual: { ex, tries }', 'qual');
    const ex = exField(q.ex, 'qual.ex');
    if (!QUAL_KINDS.includes(ex.k)) throw E.bad('Квалификация: Набор очков, Большой раунд или Сектор', 'qual.ex');
    o.qual = { ex, tries: q.tries == null ? 2 : V.int(q.tries, 'qual.tries', 1, 2) };
    // по умолчанию, как в NDL, — сетки по 8 (только у розыгрыша всех мест)
    if (b.split === undefined && !o.groups && (o.format || 'pl') === 'pl') o.split = 8;
  } else if (b.qual === null) o.qual = null;
  if (b.split != null) o.split = V.oneOf(b.split, 'split', [4, 8, 16, 32]);
  else if (b.split === null) o.split = null;
  // вид сетки: порядок матчей как на листе NDL или классический, подписи A1/B1 или №1
  if (b.layout != null) o.layout = V.oneOf(b.layout, 'layout', ['ndl', 'std']);
  if (b.labels != null) o.labels = V.oneOf(b.labels, 'labels', ['ab', 'num']);
  if (b.regUntil !== undefined) o.reg_until = V.optTime(b.regUntil, 'regUntil');
  if (b.start != null) o.start = V.optTime(b.start, 'start');
  // взнос за участие, ₽ (null — без взноса); отметки «оплатил» — в тарифе «Ведущий»
  if (b.fee !== undefined) o.fee = b.fee === null ? null : V.int(b.fee, 'fee', 0, 100000);
  if (b.official !== undefined || b.orgName !== undefined || b.orgVer !== undefined) {
    if (!can(me, 'official')) throw E.forbidden('Официальный статус задаёт администратор');
    if (b.official !== undefined) o.official = V.bool(b.official, 'official');
    if (b.orgName !== undefined) o.org_name = b.orgName == null ? null : V.str(b.orgName, 'orgName', 1, 60);
    if (b.orgVer !== undefined) o.org_ver = V.bool(b.orgVer, 'orgVer');
  }
  return o;
}

// турнир от имени клуба (его ведущий или администратор): официальный, подпись — название клуба; null — убрать
async function clubFields(c, v, me) {
  if (v === null) return { club_id: null, official: false, org_name: null, org_ver: false };
  const id = V.id(v, 'clubId');
  const club = await one(c, `SELECT * FROM clubs WHERE id = $1 AND status = 'active'`, [id]);
  if (!club) throw E.notFound('Клуб не найден');
  if (!can(me, 'clubs') && !(can(me, 'club_tour') && await one(c, 'SELECT 1 FROM club_hosts WHERE club_id = $1 AND player_id = $2', [id, me.id]))) throw E.forbidden('Турнир от имени клуба создаёт его ведущий');
  return { club_id: id, official: true, org_name: club.name, org_ver: true };
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

  // время турнира: сколько идёт, матчи, квалификация, игроки — среднее время на подход
  app.get('/api/tournaments/:id/time', async req => {
    const t = await one(pool, 'SELECT id, status FROM tournaments WHERE id = $1', [String(req.params.id)]);
    if (!t) throw E.notFound('Турнир не найден');
    return require('../timing').tourTimes(pool, t);
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
    if (!can(me, 'create_tour')) throw E.forbidden('Создавать турниры вам не разрешено — обратитесь к администратору');
    // квота от засорения: игроку 20 турниров в сутки, ведущему и выше — 200
    const day = await one(pool, 'SELECT count(*)::int AS n FROM tournaments WHERE owner_id = $1 AND created_at > $2', [me.id, Date.now() - 864e5]);
    if (day.n >= (atLeast(me, 'host') ? 200 : 20)) throw E.quota('Слишком много турниров за сутки — продолжите завтра');
    const f = tourFields(b, true, me);
    const reg = b.reg === undefined ? false : V.bool(b.reg, 'reg');
    const seed = b.seed == null ? 'r' : V.oneOf(b.seed, 'seed', ['r', 'x']);
    if (f.split && f.format !== 'pl') throw E.bad('Сетки частями — только в формате pl', 'format');
    if (f.groups && f.format === 'rr') throw E.bad('После групп — сетка: format ko или pl', 'format');
    if (f.groups && f.split) throw E.bad('С группами сетка частями не делится', 'split');
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
      if (b.clubId != null) Object.assign(f, await clubFields(c, b.clubId, me));
      // по умолчанию: порядок как на листе NDL; подписи A/B — у турниров с квалификацией, остальным номера
      const layout = f.layout || 'ndl', labels = f.labels || (f.qual ? 'ab' : 'num');
      const row = await one(c, `INSERT INTO tournaments (name, official, owner_id, org_name, org_ver, city, venue, start, reg_until, status, format, mode, dbl, ltw, cap, ex, qual, split, club_id, layout, labels, created_at, ltw_by, groups)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reg', $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23) RETURNING *`,
      [f.name, !!f.official, me.id, f.org_name || null, !!f.org_ver, f.city || me.city || '', f.venue, f.start || Date.now(), reg ? f.reg_until || null : null, f.format, f.mode || 501, f.dbl !== false, f.ltw, cap,
        f.ex ? JSON.stringify(f.ex) : null, f.qual ? JSON.stringify(f.qual) : null, f.split || null, f.club_id || null, layout, labels, Date.now(), f.ltw_by ? JSON.stringify(f.ltw_by) : null, f.groups ? JSON.stringify(f.groups) : null]);
      if (f.fee != null) await c.query('UPDATE tournaments SET fee = $2 WHERE id = $1', [row.id, f.fee]);
      // мишени в зале: сразу при создании — после старта игры и квалификация распределяются по ним сами
      if (b.boards != null) {
        const names = b.boards;
        if (!Array.isArray(names) || names.length > 64 || names.some(x => !Number.isInteger(x) || x < 1 || x > 999) || new Set(names).size !== names.length) throw E.bad('Номера мишеней: до 64 разных чисел 1–999', 'boards');
        if (names.length) await c.query('UPDATE tournaments SET boards = $2 WHERE id = $1', [row.id, JSON.stringify(Object.assign({ n: names.length, at: {} }, names.every((x, k) => x === k + 1) ? {} : { names }))]);
      }
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
      const b = req.body || {};
      // подписи матчей, взнос и «до скольких побед» можно менять и после старта — для матчей, которые ещё не начаты
      const LATE = ['labels', 'fee', 'ltw', 'ltwBy'];
      if (t.status !== 'reg' && !(Object.keys(b).length && Object.keys(b).every(k => LATE.includes(k)))) throw E.conflict('bad_state', 'Менять настройки можно только до старта');
      const f = tourFields(b, false, me);
      if (b.clubId !== undefined) Object.assign(f, await clubFields(c, b.clubId, me));
      // с учётом того, что уже стоит у турнира: смена формата не должна оставить квалификацию у ko или rr
      const qual = 'qual' in f ? f.qual : t._row.qual, split = 'split' in f ? f.split : t._row.split;
      const groups = 'groups' in f ? f.groups : t._row.groups, fmt = f.format || t.format;
      if (split && fmt !== 'pl' && !groups) throw E.bad('Сетки частями — только в формате pl', 'format');
      if (groups && fmt === 'rr') throw E.bad('После групп — сетка: format ko или pl', 'format');
      // с группами сетка частями не делится
      if (groups && split) f.split = null;
      ['ex', 'qual', 'ltw_by', 'groups'].forEach(k => { if (f[k]) f[k] = JSON.stringify(f[k]); });
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
    if (!can(me, 'streams')) throw E.forbidden('Камеры подключают ведущие клубов — подайте заявку на клуб');
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

  // протокол результатов (организатор или помощник): шапка, главный судья, места с данными игроков для протокола
  app.get('/api/tournaments/:id/protocol', async (req, reply) => {
    const me = needPlayer(req), t = await getTour(pool, req.params.id, false);
    needStaff(t, me);
    const R = require('../regions');
    const rows = await all(pool, `SELECT e.place_lo, e.place_hi, e.seed_no, p.id, p.name, p.last_name, p.first_name, p.mid_name, p.birth_year, p.sex,
      p.title, p.region, p.city, p.club FROM entries e JOIN players p ON p.id = e.player_id WHERE e.tournament_id = $1
      ORDER BY e.place_lo NULLS LAST, e.place_hi NULLS LAST, e.seed_no`, [t.id]);
    reply.header('Cache-Control', 'private, no-store');
    return {
      proto: t._row.proto || {}, chief: (t.refs && t.refs.chief) || null,
      rows: rows.map(p => ({ id: p.id, lo: p.place_lo, hi: p.place_hi, name: p.name, lastName: p.last_name, firstName: p.first_name, midName: p.mid_name,
        birthYear: p.birth_year, sex: p.sex, title: p.title || '', region: p.region || R.regionOf(p.city) || '', city: p.city, club: p.club }))
    };
  });
  // шапка протокола и выполненные разряды (организатор): { league, tour, about, done: { id: «КМС» } }
  app.patch('/api/tournaments/:id/protocol', async req => {
    const me = needPlayer(req), b = req.body || {};
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      const pr = Object.assign({}, t._row.proto);
      if (b.league !== undefined) pr.league = V.optStr(b.league, 'league', 120);
      if (b.tour !== undefined) pr.tour = V.optStr(b.tour, 'tour', 120);
      if (b.about !== undefined) pr.about = V.optStr(b.about, 'about', 1500);
      if (b.done !== undefined) {
        if (!b.done || typeof b.done !== 'object' || Array.isArray(b.done)) throw E.bad('done: { id: разряд }', 'done');
        const done = {};
        for (const [id, v] of Object.entries(b.done)) {
          if (!t.players.includes(id)) throw E.bad('Игрок не участвует в турнире', 'done');
          const x = V.optStr(v, 'done', 20);
          if (x) done[id] = x;
        }
        pr.done = done;
      }
      await c.query('UPDATE tournaments SET proto = $2 WHERE id = $1', [t.id, JSON.stringify(pr)]);
      forget('t', t.id);
      return { proto: pr };
    });
  });

  // QR-карточки участников с лайт-профилем: игрок наводит камеру — входит и сразу видит турнир. Организатор получает
  // карточки тех, кого завёл сам (или его клуб); с правом players — всех. Кода ещё нет — выдаётся.
  app.post('/api/tournaments/:id/cards', async req => {
    const me = needPlayer(req);
    return tx(async c => {
      const t = await getTour(c, req.params.id, false);
      needOwner(t, me);
      const rows = await all(c, `SELECT p.* FROM entries e JOIN players p ON p.id = e.player_id WHERE e.tournament_id = $1 AND p.lite AND NOT p.blocked
        ORDER BY e.seed_no FOR UPDATE OF p`, [t.id]);
      const mine = p => can(me, 'players') || p.owner_id === me.id || !!(t._club && t._club.hosts.has(p.owner_id));
      const out = [];
      for (const p of rows.filter(mine)) {
        const claim = p.claim || (await one(c, 'UPDATE players SET claim = $2 WHERE id = $1 RETURNING claim', [p.id, await newClaim(c)])).claim;
        out.push({ id: p.id, name: p.name, code: p.code, city: p.city, claim });
      }
      return { cards: out, others: rows.length - out.length };
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

  // { paidOnly: true } — играют только отмеченные «оплатил» (пришли и оплатили на регистрации в клубе),
  // остальные убираются из турнира; отметки — у команды турнира с тарифом «Ведущий»
  app.post('/api/tournaments/:id/launch', async req => {
    const me = needPlayer(req), b = req.body || {};
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      if (t.status !== 'reg') throw E.conflict('bad_state', 'Турнир уже начался');
      if (b.paidOnly === true) {
        if (!T.feesOn(t, me)) throw E.forbidden('Отметки об оплате — в тарифе «Ведущий»');
        const paid = new Set(t._ents.filter(e => e.paid).map(e => e.player_id));
        if (paid.size < 3) throw E.conflict('bad_state', 'Оплатили меньше трёх — отметьте оплативших во вкладке «Взносы»');
        await c.query('DELETE FROM entries WHERE tournament_id = $1 AND NOT paid', [t.id]);
        t.players = t.players.filter(id => paid.has(id));
      }
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
      // сначала матч, потом турнир — тот же порядок блокировок, что у счётчика
      if (b.force === true) await c.query('SELECT id FROM matches WHERE tournament_id = $1 AND r = $2 AND i = $3 FOR UPDATE', [String(req.params.id), r, i]);
      const t = await getTour(c, req.params.id, true);
      const busy = await one(c, 'SELECT id, status FROM matches WHERE tournament_id = $1 AND r = $2 AND i = $3', [t.id, r, i]);
      // force: результат с телефона игрока без сети («покажите ведущему») — идущий матч этой игры заменяется итогом
      if (busy && !(b.force === true && busy.status === 'live' && T.isStaff(t, me))) throw E.conflict('game_taken', 'Этот матч уже ведётся или сыгран', { matchId: busy.id });
      if (busy) { await c.query('DELETE FROM matches WHERE id = $1', [busy.id]); delete t.live[r + ':' + i]; }
      const x = T.readyPair(t, r, i);
      if (!x) throw E.conflict('bad_state', 'Счёт этого матча сейчас внести нельзя');
      // итог без бросков меняет рейтинг — вносит только команда турнира; игроки пары играют матч в счётчике
      if (!T.isStaff(t, me)) throw E.forbidden('Итог без игры вносит организатор турнира — сыграйте матч в счётчике');
      const ltw = B.ltwOf(t, r, i), la = V.int(b.la, 'la', 0, ltw), lb = V.int(b.lb, 'lb', 0, ltw);
      if (!((la === ltw && lb < ltw) || (lb === ltw && la < ltw))) throw E.bad('Победитель должен выиграть ' + ltw + ' лег(а)', 'la');
      const id = 'q' + crypto.randomBytes(8).toString('hex'), now = Date.now(), w = la > lb ? 0 : 1;
      const nm = pid => t._ents.find(e => e.player_id === pid).name;
      await c.query(`INSERT INTO matches (id, tournament_id, r, i, status, mode, ltw, dbl, ex, players, legs, w, quick, created_by, started, finished)
        VALUES ($1, $2, $3, $4, 'done', $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $13)`,
      [id, t.id, r, i, t.mode, ltw, t.dbl, t.ex ? JSON.stringify(t.ex) : null, JSON.stringify([{ id: x.a, name: nm(x.a) }, { id: x.b, name: nm(x.b) }]), JSON.stringify([la, lb]), w, me.id, now]);
      // без бросков: в средние не попадает (darts 0), как на странице
      for (const [k, pid, legs] of [[0, x.a, la], [1, x.b, lb]]) {
        await c.query(`INSERT INTO match_lines (match_id, idx, player_id, name, legs, pts, darts, f9) VALUES ($1, $2, $3, $4, $5, 0, 0, NULL)`, [id, k, pid, nm(pid), legs]);
      }
      if (t.official) await eloAdd(c, x.a, x.b, w === 0);
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
      needStaff(t, me);
      const { pid, k } = qualSlot(t, req.params);
      const max = qualMax(t.qual.ex), v = V.int(b.v, 'v', 0, max);
      const old = await one(c, 'SELECT match_id FROM qual_results WHERE tournament_id = $1 AND player_id = $2 AND try = $3', [t.id, pid, k]);
      if (old && old.match_id) throw E.conflict('game_taken', 'Эта попытка сыграна в счётчике', { matchId: old.match_id });
      const live = await one(c, `SELECT id FROM matches WHERE tournament_id = $1 AND q_player = $2 AND q_try = $3`, [t.id, pid, k]);
      if (live) throw E.conflict('game_taken', 'Эта попытка идёт в счётчике', { matchId: live.id });
      if (k > 0 && !await one(c, 'SELECT 1 FROM qual_results WHERE tournament_id = $1 AND player_id = $2 AND try = $3', [t.id, pid, k - 1])) throw E.conflict('bad_state', 'Сначала нужна попытка ' + k);
      await c.query(`INSERT INTO qual_results (tournament_id, player_id, try, v, t) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (tournament_id, player_id, try) DO UPDATE SET v = EXCLUDED.v, t = EXCLUDED.t`, [t.id, pid, k, v, Date.now()]);
      // сдавшие все попытки освобождают мишень — её получает следующий
      await T.refreshTour(c, await getTour(c, t.id, false));
      forget('t', t.id);
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
      await T.refreshTour(c, await getTour(c, t.id, false));
      forget('t', t.id);
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
      const order = T.qualOrder(t), g = { players: [], games: [], layout: t.layout }, G = t._row.groups;
      // «Комплексный»: после квалификации — группы змейкой по её итогам; круговая — таблица в этом порядке; иначе сетка (pl — частями, если задано)
      if (G) groupsCheck(G, order.length); else if (t.format !== 'rr') B.setBracket(g, t.format, order, t.format === 'pl' ? t.split : undefined);
      await reseed(c, t.id, order);
      const nums = JSON.stringify(Object.fromEntries(order.map((id, k) => [id, k + 1])));
      if (G) await c.query(`UPDATE tournaments SET stage = 'groups', groups = $2, nums = $3 WHERE id = $1`, [t.id, groupsRow(G, B.drawGroups(order, G.n)), nums]);
      else await c.query(`UPDATE tournaments SET stage = NULL, slots = $2, block = $3, nums = $4 WHERE id = $1`, [t.id, g.slots ? JSON.stringify(g.slots) : null, g.block || null, nums]);
      await T.refreshTour(c, await getTour(c, t.id, false));
      forget('t', t.id);
      return tourResp(c, t.id, me);
    });
  });

  // закрыть групповой этап (организатор): все матчи групп сыграны — из каждой группы выходят первые adv, строится сетка.
  // Матчи групп уходят в r + 64, судьи групп — в ключи «g r:i»; мишени и «Готов» начинаются заново
  app.post('/api/tournaments/:id/groups/close', async req => {
    const me = needPlayer(req);
    return tx(async c => {
      await c.query('SELECT id FROM matches WHERE tournament_id = $1 ORDER BY id FOR UPDATE', [req.params.id]);
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      if (t.stage !== 'groups') throw E.conflict('bad_state', 'Групповой этап не идёт');
      if (Object.keys(t.live).length) throw E.conflict('bad_state', 'Ещё идут матчи групп: доиграйте или удалите их', { matches: Object.values(t.live) });
      const pr = B.tProgress(t);
      if (pr.done < pr.total) throw E.conflict('bad_state', 'Сыграны не все матчи групп: осталось ' + (pr.total - pr.done));
      const order = B.groupAdvance(t), g = { players: [], games: [], layout: t.layout };
      B.setBracket(g, t.format, order);
      await c.query('UPDATE matches SET r = r + 64 WHERE tournament_id = $1 AND r IS NOT NULL AND r < 64', [t.id]);
      const G = Object.assign({}, t._row.groups, { done: true });
      const refs = t.refs && Object.keys(t.refs.at || {}).length ? Object.assign({}, t.refs, { at: Object.fromEntries(Object.entries(t.refs.at).map(([k, v]) => [/^g/.test(k) ? k : 'g' + k, v])) }) : t.refs || null;
      const boards = t.boards ? Object.assign({}, t.boards, { at: {} }) : null;
      await c.query(`UPDATE tournaments SET stage = NULL, slots = $2, block = NULL, groups = $3, refs = $4, boards = $5, ready = NULL WHERE id = $1`,
        [t.id, JSON.stringify(g.slots), JSON.stringify(G), refs && JSON.stringify(refs), boards && JSON.stringify(boards)]);
      await T.refreshTour(c, await getTour(c, t.id, false));
      forget('t', t.id);
      return tourResp(c, t.id, me);
    });
  });

  // общее фото игроков (организатор): { photoId } — одно из фото турнира, null — убрать
  app.patch('/api/tournaments/:id/cover', async req => {
    const me = needPlayer(req), b = req.body || {};
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needOwner(t, me);
      const pid = b.photoId == null ? null : V.str(b.photoId, 'photoId', 1, 64);
      if (pid && !t.photos.some(p => p.id === pid)) throw E.notFound('Фото не из этого турнира');
      await c.query('UPDATE tournaments SET cover = $2 WHERE id = $1', [t.id, pid]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });

  // взносы (команда турнира с тарифом «Ведущий»): { playerId, paid }
  app.patch('/api/tournaments/:id/paid', async req => {
    const me = needPlayer(req), b = req.body || {};
    const pid = V.id(b.playerId, 'playerId'), paid = V.bool(b.paid, 'paid');
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      if (!T.feesOn(t, me)) throw E.forbidden('Взносы отмечает организатор или помощник клуба с тарифом «Ведущий»');
      if (!t.players.includes(pid)) throw E.notFound('Игрок не участвует');
      await c.query('UPDATE entries SET paid = $3 WHERE tournament_id = $1 AND player_id = $2', [t.id, pid, paid]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });

  // мишени (организатор или помощник, можно и до старта): { n } — сколько их (номера 1…n), { names: [3, 5, 7] } —
  // свои номера мишеней в зале, { r, i, board } — поставить игре мишень (board — порядковый 1…n)
  app.patch('/api/tournaments/:id/boards', async req => {
    const me = needPlayer(req), b = req.body || {};
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needStaff(t, me);
      if (t.status === 'done') throw E.conflict('bad_state', 'Турнир завершён');
      let bd = t.boards ? Object.assign({}, t.boards, { at: Object.assign({}, t.boards.at) }) : { n: 0, at: {} };
      if (b.names !== undefined) {
        const names = b.names == null ? [] : b.names;
        if (!Array.isArray(names) || names.length > 64 || names.some(x => !Number.isInteger(x) || x < 1 || x > 999) || new Set(names).size !== names.length) throw E.bad('Номера мишеней: до 64 разных чисел 1–999', 'names');
        bd.n = names.length;
        // номера 1…n подряд — обычный случай, отдельный список не нужен
        if (names.every((x, k) => x === k + 1)) delete bd.names; else bd.names = names;
      } else if (b.n !== undefined) { bd.n = V.int(b.n, 'n', 0, 64); delete bd.names; }
      if (b.board !== undefined) {
        if (t.status === 'reg') throw E.conflict('bad_state', 'Мишени играм — после старта');
        const r = V.int(b.r, 'r', 0, 63), i = V.int(b.i, 'i', 0, 63), no = V.int(b.board, 'board', 1, Math.max(1, bd.n));
        const g = B.gameAt(t, r, i);
        if (!g || B.gameState(t, g).st !== 'ready') throw E.conflict('bad_state', 'Мишень ставится только готовой к игре паре');
        Object.keys(bd.at).forEach(k => { if (bd.at[k] === no) delete bd.at[k]; });
        bd.at[r + ':' + i] = no;
      }
      t.boards = bd.n ? bd : null;
      if (t.boards && t.status !== 'reg') B.assignBoards(t);
      await c.query('UPDATE tournaments SET boards = $2 WHERE id = $1', [t.id, t.boards && JSON.stringify(t.boards)]);
      await bump(c, t.id);
      return tourResp(c, t.id, me);
    });
  });

  // судьи: { chief: { name, city } | null } — главный судья, { pool: [имена] } — судьи турнира (организатор);
  // { r, i, ref: имя | null } — кто судит матч, { auto: true } — раздать судей матчам без судьи по очереди (организатор или помощник)
  app.patch('/api/tournaments/:id/refs', async req => {
    const me = needPlayer(req), b = req.body || {};
    return tx(async c => {
      const t = await getTour(c, req.params.id, true);
      needStaff(t, me);
      const cur = t.refs || {}, rf = { chief: cur.chief || null, pool: (cur.pool || []).slice(), at: Object.assign({}, cur.at) };
      if (b.chief !== undefined || b.pool !== undefined) needOwner(t, me);
      if (b.chief !== undefined) {
        const ch = b.chief;
        if (ch !== null && (typeof ch !== 'object' || Array.isArray(ch))) throw E.bad('chief: { name, city }', 'chief');
        rf.chief = ch === null || !ch.name ? null : { name: V.str(ch.name, 'chief.name', 2, 60), city: V.optStr(ch.city, 'chief.city', 40) };
      }
      if (b.pool !== undefined) {
        const pool = b.pool == null ? [] : b.pool;
        if (!Array.isArray(pool) || pool.length > 40) throw E.bad('Судьи: список до 40 имён', 'pool');
        rf.pool = [...new Set(pool.map(x => V.str(x, 'pool', 2, 60)))];
        // снятый из списка судья больше не стоит на матчах
        Object.keys(rf.at).forEach(k => { if (!rf.pool.includes(rf.at[k])) delete rf.at[k]; });
      }
      if (b.ref !== undefined || b.auto) {
        if (t.status === 'reg') throw E.conflict('bad_state', 'Судей матчам — после старта');
        if (!t.games.length) throw E.conflict('bad_state', 'Матчей ещё нет');
      }
      if (b.ref !== undefined) {
        const r = V.int(b.r, 'r', 0, 63), i = V.int(b.i, 'i', 0, 63);
        if (!B.gameAt(t, r, i)) throw E.notFound('Матч не найден');
        if (b.ref === null) delete rf.at[r + ':' + i];
        else {
          const name = V.str(b.ref, 'ref', 2, 60);
          if (!rf.pool.includes(name)) throw E.bad('Сначала добавьте судью в список турнира', 'ref');
          rf.at[r + ':' + i] = name;
        }
      }
      // по очереди: матчам, которые можно играть (и идущим), — судья, у которого меньше всего матчей
      if (b.auto) {
        if (!rf.pool.length) throw E.conflict('bad_state', 'Добавьте судей в список турнира');
        const rv = B.resolver(t), load = Object.fromEntries(rf.pool.map(n => [n, 0]));
        Object.values(rf.at).forEach(n => { if (n in load) load[n]++; });
        for (const g of t.games) {
          const k = g.r + ':' + g.i, gs = B.gameState(t, g, rv);
          if (rf.at[k] || gs.st !== 'ready') continue;
          // сам себя не судит
          const pl = [gs.a, gs.b].map(id => (t._ents.find(e => e.player_id === id) || {}).name);
          const free = rf.pool.filter(n => !pl.includes(n));
          if (!free.length) continue;
          const pick = free.reduce((a, n) => load[n] < load[a] ? n : a);
          rf.at[k] = pick; load[pick]++;
        }
      }
      const empty = !rf.chief && !rf.pool.length && !Object.keys(rf.at).length;
      await c.query('UPDATE tournaments SET refs = $2 WHERE id = $1', [t.id, empty ? null : JSON.stringify(rf)]);
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
