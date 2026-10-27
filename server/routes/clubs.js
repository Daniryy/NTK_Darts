// Клубы. Игрок подаёт заявку, администратор подтверждает — подавший становится ведущим клуба:
// турниры от имени клуба (официальные), камеры, свои номера игроков, аккаунты для игроков.
// Клуб закрыт или ведущего убрали — роль ведущего снимается, если других клубов у него нет.
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer, clearCache } = require('../auth');
const { needPerm } = require('../auth');
const { audit } = require('../audit');
const { can } = require('../roles');
const { playerShort } = require('../players');
const T = require('../tour');

const DAY = 864e5, HELPERS_MAX = 5;
// управляет клубом: его ведущий (или администратор с правом clubs); tools — ещё и тариф «Ведущий»
async function clubOf(c, id, me, tools) {
  const club = await one(c, 'SELECT * FROM clubs WHERE id = $1', [id]);
  if (!club || club.status !== 'active') throw E.notFound('Клуб не найден');
  if (me) {
    const host = !!await one(c, 'SELECT 1 FROM club_hosts WHERE club_id = $1 AND player_id = $2', [id, me.id]);
    if (!host && !can(me, 'clubs')) throw E.forbidden('Это может ведущий клуба');
    if (tools && !can(me, 'club_tools')) throw E.forbidden('Это в тарифе «Ведущий»');
  }
  return club;
}
// статистика клуба для ведущего: посещаемость по месяцам, постоянные, пропавшие, новые, взносы
async function clubStats(c, id) {
  const now = Date.now();
  const rows = await all(c, `SELECT e.player_id, e.paid, t.start, t.fee, p.name FROM entries e JOIN tournaments t ON t.id = e.tournament_id JOIN players p ON p.id = e.player_id
    WHERE t.club_id = $1 AND t.status <> 'reg' AND t.start > $2`, [id, now - 365 * DAY]);
  const months = [];
  for (let k = 5; k >= 0; k--) {
    const d = new Date(now), from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k, 1), to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - k + 1, 1);
    const r = rows.filter(x => x.start >= from && x.start < to);
    months.push({ t: from, players: new Set(r.map(x => x.player_id)).size, visits: r.length });
  }
  const by = new Map();
  rows.forEach(x => { const o = by.get(x.player_id) || { id: x.player_id, name: x.name, n60: 0, old: 0, last: 0, first: Infinity }; if (x.start > now - 60 * DAY) o.n60++; else if (x.start > now - 180 * DAY) o.old++; o.last = Math.max(o.last, x.start); o.first = Math.min(o.first, x.start); by.set(x.player_id, o); });
  const ps = [...by.values()];
  const cash = rows.filter(x => x.start > now - 30 * DAY && x.paid && x.fee).reduce((a, x) => a + x.fee, 0);
  return {
    months,
    regulars: ps.filter(o => o.n60 >= 3).sort((a, b) => b.n60 - a.n60).slice(0, 10).map(o => ({ id: o.id, name: o.name, n: o.n60 })),
    lapsed: ps.filter(o => !o.n60 && o.old >= 2).sort((a, b) => b.last - a.last).slice(0, 10).map(o => ({ id: o.id, name: o.name, last: o.last })),
    newMonth: ps.filter(o => o.first > now - 30 * DAY).length,
    cash30: cash
  };
}

const STATUSES = ['pending', 'active', 'rejected', 'closed'];
const clubJSON = (c, hosts, full) => Object.assign({ id: c.id, name: c.name, city: c.city, address: c.address, contact: c.contact, about: c.about, status: c.status, hosts: hosts || [] },
  full ? { owner: c.owner_id ? { id: c.owner_id, name: c.owner_name } : null, note: c.note, created: c.created_at, decided: c.decided_at } : {});
const CLUB_SQL = 'SELECT c.*, p.name AS owner_name FROM clubs c LEFT JOIN players p ON p.id = c.owner_id';

async function hostsOf(c, ids) {
  const rows = ids.length ? await all(c, 'SELECT h.club_id, p.id, p.name, p.photo FROM club_hosts h JOIN players p ON p.id = h.player_id WHERE h.club_id = ANY($1) ORDER BY p.name', [ids]) : [];
  const out = {};
  rows.forEach(r => { (out[r.club_id] = out[r.club_id] || []).push({ id: r.id, name: r.name, photo: r.photo || null }); });
  return out;
}
async function listJSON(c, rows, full) {
  const h = await hostsOf(c, rows.map(r => r.id));
  return rows.map(r => clubJSON(r, h[r.id], full));
}
function fields(b, full) {
  const o = {};
  if (full || b.name !== undefined) o.name = V.str(b.name, 'name', 2, 60);
  if (full || b.city !== undefined) o.city = V.optStr(b.city, 'city', 40);
  if (full || b.address !== undefined) o.address = V.optStr(b.address, 'address', 120);
  if (full || b.contact !== undefined) o.contact = V.optStr(b.contact, 'contact', 120);
  if (full || b.about !== undefined) o.about = V.optStr(b.about, 'about', 500);
  return o;
}
// игрок — ведущий, пока у него есть открытый клуб; роли выше ведущего не трогаем
// с учётом тарифов: роль действующего тарифа, иначе ведущий при открытом клубе, иначе игрок (plans.js)
const syncHostRole = (c, pid) => require('../plans').syncPlanRole(c, pid);
const nameTaken = async (c, name, except) => !!await one(c, `SELECT 1 FROM clubs WHERE lower(name) = lower($1) AND status IN ('pending', 'active') AND id <> $2`, [name, except || '']);

module.exports = async function (app) {
  // открытые клубы — всем
  app.get('/api/clubs', async () => ({ clubs: await listJSON(pool, await all(pool, CLUB_SQL + ` WHERE c.status = 'active' ORDER BY c.city, c.name`)) }));

  // страница клуба — всем: расписание, прошедшие турниры, игроки, фото; ведущему — ещё управление и статистика
  app.get('/api/clubs/:id', async req => {
    const club = await clubOf(pool, req.params.id, null);
    const me = req.player, host = !!me && !!await one(pool, 'SELECT 1 FROM club_hosts WHERE club_id = $1 AND player_id = $2', [club.id, me.id]);
    const manage = host || can(me, 'clubs'), tools = manage && can(me, 'club_tools');
    const upcoming = await all(pool, T.TOUR_SQL + ` WHERE t.club_id = $1 AND t.status IN ('reg', 'live') ORDER BY t.status = 'live' DESC, t.start LIMIT 20`, [club.id]);
    const past = await all(pool, T.TOUR_SQL + ` WHERE t.club_id = $1 AND t.status = 'done' ORDER BY t.done_at DESC LIMIT 10`, [club.id]);
    const top = await all(pool, `SELECT p.*, count(*)::int AS visits FROM entries e JOIN tournaments t ON t.id = e.tournament_id JOIN players p ON p.id = e.player_id
      WHERE t.club_id = $1 AND t.status <> 'reg' AND t.start > $2 GROUP BY p.id ORDER BY p.rating DESC, p.id LIMIT 10`, [club.id, Date.now() - 180 * DAY]);
    const photos = await all(pool, `SELECT ph.id, ph.file, ph.w, ph.h, ph.tournament_id FROM photos ph JOIN tournaments t ON t.id = ph.tournament_id WHERE t.club_id = $1 ORDER BY ph.created_at DESC LIMIT 12`, [club.id]);
    const hosts = await hostsOf(pool, [club.id]);
    const out = {
      club: Object.assign(clubJSON(club, hosts[club.id]), { logo: club.logo || null }),
      upcoming: (await T.loadTours(pool, upcoming)).map(t => T.tourCard(t, me)),
      past: (await T.loadTours(pool, past)).map(t => T.tourCard(t, me)),
      players: top.map(p => Object.assign(playerShort(p), { visits: p.visits })),
      photos: photos.map(p => ({ id: p.id, url: '/uploads/' + p.file, w: p.w, h: p.h, tid: p.tournament_id })),
      manage, tools
    };
    if (tools) {
      out.helpers = (await all(pool, 'SELECT p.* FROM club_helpers h JOIN players p ON p.id = h.player_id WHERE h.club_id = $1 ORDER BY p.name', [club.id])).map(playerShort);
      out.banners = (await all(pool, 'SELECT * FROM banners WHERE club_id = $1 ORDER BY created_at DESC', [club.id])).map(b => ({ id: b.id, place: b.place, title: b.title, body: b.body, image: b.image, link: b.link, active: b.active, clicks: b.clicks }));
      out.stats = await clubStats(pool, club.id);
    }
    return out;
  });

  // ведущий меняет описание клуба (название — администратор): { city, address, contact, about }
  app.patch('/api/clubs/:id', async req => {
    const me = needPlayer(req), b = req.body || {};
    if (b.name !== undefined) throw E.forbidden('Название клуба меняет администратор');
    const set = fields(b, false), keys = Object.keys(set);
    if (!keys.length) throw E.bad('Нечего менять');
    await clubOf(pool, req.params.id, me);
    await pool.query(`UPDATE clubs SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1`, [req.params.id, ...keys.map(k => set[k])]);
    await audit(pool, me, 'club.edit', { id: req.params.id, name: '' }, set);
    return { ok: true };
  });

  // помощники клуба (тариф «Ведущий»): { playerId }
  app.post('/api/clubs/:id/helpers', async req => {
    const me = needPlayer(req), pid = V.id((req.body || {}).playerId, 'playerId');
    await tx(async c => {
      const club = await clubOf(c, req.params.id, me, true);
      await c.query('SELECT 1 FROM clubs WHERE id = $1 FOR UPDATE', [club.id]);
      const p = await one(c, 'SELECT id, name FROM players WHERE id = $1', [pid]);
      if (!p) throw E.notFound('Игрок не найден');
      if ((await one(c, 'SELECT count(*)::int AS n FROM club_helpers WHERE club_id = $1', [club.id])).n >= HELPERS_MAX) throw E.conflict('conflict', 'Помощников не больше ' + HELPERS_MAX);
      await c.query('INSERT INTO club_helpers (club_id, player_id, added_by, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [club.id, pid, me.id, Date.now()]);
      await audit(c, me, 'club.helper_add', p, { club: club.name });
    });
    return { ok: true };
  });
  app.delete('/api/clubs/:id/helpers/:pid', async req => {
    const me = needPlayer(req);
    await tx(async c => {
      const club = await clubOf(c, req.params.id, me, true);
      const r = await c.query('DELETE FROM club_helpers WHERE club_id = $1 AND player_id = $2', [club.id, req.params.pid]);
      if (!r.rowCount) throw E.notFound('Это не помощник клуба');
      await audit(c, me, 'club.helper_rm', await one(c, 'SELECT id, name FROM players WHERE id = $1', [req.params.pid]), { club: club.name });
    });
    return { ok: true };
  });

  // спонсоры клуба (тариф «Ведущий»): баннеры на странице турнира и табло вместо баннеров Oche
  app.post('/api/clubs/:id/banners', async (req, reply) => {
    const me = needPlayer(req), f = require('./banners').fields(req.body || {}, true);
    if (!['tour', 'tv'].includes(f.place)) throw E.bad('Спонсоры клуба — на странице турнира (tour) или табло (tv)', 'place');
    if (!f.title && !f.image) throw E.bad('Нужен заголовок или картинка', 'title');
    const club = await clubOf(pool, req.params.id, me, true);
    if ((await one(pool, 'SELECT count(*)::int AS n FROM banners WHERE club_id = $1', [club.id])).n >= 10) throw E.conflict('conflict', 'У клуба не больше 10 баннеров');
    const row = await one(pool, `INSERT INTO banners (place, title, body, image, link, active, starts, ends, created_by, created_at, club_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`, [f.place, f.title, f.body, f.image, f.link, f.active !== false, f.starts || null, f.ends || null, me.id, Date.now(), club.id]);
    await audit(pool, me, 'banner.create', { id: row.id, name: row.title }, { place: row.place, club: club.name });
    return reply.code(201).send({ banner: { id: row.id } });
  });
  app.patch('/api/clubs/:id/banners/:bid', async req => {
    const me = needPlayer(req), f = require('./banners').fields(req.body || {}, false), keys = Object.keys(f);
    if (f.place && !['tour', 'tv'].includes(f.place)) throw E.bad('Спонсоры клуба — tour или tv', 'place');
    if (!keys.length) throw E.bad('Нечего менять');
    const club = await clubOf(pool, req.params.id, me, true);
    const row = await one(pool, `UPDATE banners SET ${keys.map((k, n) => k + ' = $' + (n + 3)).join(', ')} WHERE id = $1 AND club_id = $2 RETURNING *`, [req.params.bid, club.id, ...keys.map(k => f[k])]);
    if (!row) throw E.notFound('Баннер не найден');
    return { ok: true };
  });
  app.delete('/api/clubs/:id/banners/:bid', async req => {
    const me = needPlayer(req);
    const club = await clubOf(pool, req.params.id, me, true);
    const row = await one(pool, 'DELETE FROM banners WHERE id = $1 AND club_id = $2 RETURNING *', [req.params.bid, club.id]);
    if (!row) throw E.notFound('Баннер не найден');
    await audit(pool, me, 'banner.delete', { id: row.id, name: row.title }, { club: club.name });
    return { ok: true };
  });

  // мои заявки и клубы
  app.get('/api/clubs/mine', async req => {
    const me = needPlayer(req);
    const rows = await all(pool, CLUB_SQL + ' WHERE c.owner_id = $1 OR c.id IN (SELECT club_id FROM club_hosts WHERE player_id = $1) ORDER BY c.created_at DESC', [me.id]);
    return { clubs: await listJSON(pool, rows, true) };
  });

  // заявка на клуб: { name, city, address, contact, about }
  app.post('/api/clubs', async (req, reply) => {
    const me = needPlayer(req), f = fields(req.body || {}, true);
    const row = await tx(async c => {
      await c.query('LOCK TABLE clubs IN SHARE ROW EXCLUSIVE MODE');
      if (await one(c, `SELECT 1 FROM clubs WHERE owner_id = $1 AND status = 'pending'`, [me.id])) throw E.conflict('conflict', 'Ваша заявка уже на рассмотрении');
      if (await nameTaken(c, f.name)) throw E.conflict('conflict', 'Клуб с таким названием уже есть');
      return one(c, `INSERT INTO clubs (name, city, address, contact, about, status, owner_id, created_at) VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7) RETURNING *`,
        [f.name, f.city || me.city || '', f.address, f.contact, f.about, me.id, Date.now()]);
    });
    return reply.code(201).send({ club: clubJSON(Object.assign(row, { owner_name: me.name }), [], true) });
  });

  // администратор: заявки и клубы
  app.get('/api/admin/clubs', async req => {
    needPerm(req, 'clubs', 'Раздел для администратора');
    const st = req.query.status ? V.oneOf(req.query.status, 'status', STATUSES) : null;
    const rows = await all(pool, CLUB_SQL + (st ? ' WHERE c.status = $1' : '') + ` ORDER BY CASE c.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, c.created_at DESC LIMIT 300`, st ? [st] : []);
    return { clubs: await listJSON(pool, rows, true) };
  });

  // { status: active (подтвердить) | rejected | closed, note, name, city, address, contact, about }
  app.patch('/api/admin/clubs/:id', async req => {
    const me = needPerm(req, 'clubs', 'Клубы подтверждает администратор'), b = req.body || {}, set = fields(b, false);
    if (b.status !== undefined) set.status = V.oneOf(b.status, 'status', STATUSES);
    if (b.note !== undefined) set.note = V.optStr(b.note, 'note', 300);
    const keys = Object.keys(set);
    if (!keys.length) throw E.bad('Нечего менять');
    const row = await tx(async c => {
      const cur = await one(c, 'SELECT * FROM clubs WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur) throw E.notFound('Клуб не найден');
      if (set.name && await nameTaken(c, set.name, cur.id)) throw E.conflict('conflict', 'Клуб с таким названием уже есть');
      if (set.status && set.status !== cur.status) { set.decided_by = me.id; set.decided_at = Date.now(); }
      const k2 = Object.keys(set);
      const out = await one(c, `UPDATE clubs SET ${k2.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1 RETURNING *`, [cur.id, ...k2.map(k => set[k])]);
      if (out.status === 'active' && cur.status !== 'active' && out.owner_id) await c.query('INSERT INTO club_hosts (club_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [out.id, out.owner_id]);
      for (const h of await all(c, 'SELECT player_id FROM club_hosts WHERE club_id = $1', [out.id])) await syncHostRole(c, h.player_id);
      await audit(c, me, set.status && set.status !== cur.status ? 'club.' + set.status : 'club.edit', { id: out.id, name: out.name }, Object.assign({}, b));
      return one(c, CLUB_SQL + ' WHERE c.id = $1', [out.id]);
    });
    clearCache();
    return { club: (await listJSON(pool, [row], true))[0] };
  });

  // ведущие клуба: добавить { playerId } и убрать
  app.post('/api/admin/clubs/:id/hosts', async req => {
    const me = needPerm(req, 'clubs', 'Ведущих назначает администратор');
    const pid = V.id((req.body || {}).playerId, 'playerId');
    const row = await tx(async c => {
      const club = await one(c, 'SELECT * FROM clubs WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!club) throw E.notFound('Клуб не найден');
      if (club.status !== 'active') throw E.conflict('bad_state', 'Сначала подтвердите клуб');
      if (!await one(c, 'SELECT 1 FROM players WHERE id = $1', [pid])) throw E.notFound('Игрок не найден');
      await c.query('INSERT INTO club_hosts (club_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [club.id, pid]);
      await syncHostRole(c, pid);
      await audit(c, me, 'club.host_add', await one(c, 'SELECT id, name FROM players WHERE id = $1', [pid]), { club: club.name });
      return one(c, CLUB_SQL + ' WHERE c.id = $1', [club.id]);
    });
    clearCache();
    return { club: (await listJSON(pool, [row], true))[0] };
  });
  app.delete('/api/admin/clubs/:id/hosts/:pid', async req => {
    const me = needPerm(req, 'clubs', 'Ведущих назначает администратор');
    const row = await tx(async c => {
      const club = await one(c, 'SELECT * FROM clubs WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!club) throw E.notFound('Клуб не найден');
      await c.query('DELETE FROM club_hosts WHERE club_id = $1 AND player_id = $2', [club.id, req.params.pid]);
      await syncHostRole(c, req.params.pid);
      await audit(c, me, 'club.host_rm', await one(c, 'SELECT id, name FROM players WHERE id = $1', [req.params.pid]), { club: club.name });
      return one(c, CLUB_SQL + ' WHERE c.id = $1', [club.id]);
    });
    clearCache();
    return { club: (await listJSON(pool, [row], true))[0] };
  });
};

module.exports.syncHostRole = syncHostRole;
