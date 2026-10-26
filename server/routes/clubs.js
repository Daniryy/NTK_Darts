// Клубы. Игрок подаёт заявку, администратор подтверждает — подавший становится ведущим клуба:
// турниры от имени клуба (официальные), камеры, свои номера игроков, аккаунты для игроков.
// Клуб закрыт или ведущего убрали — роль ведущего снимается, если других клубов у него нет.
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer, clearCache } = require('../auth');
const { needPerm } = require('../auth');
const { audit } = require('../audit');

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
async function syncHostRole(c, pid) {
  const has = await one(c, `SELECT 1 FROM club_hosts h JOIN clubs c ON c.id = h.club_id WHERE h.player_id = $1 AND c.status = 'active'`, [pid]);
  await c.query(`UPDATE players SET role = $2 WHERE id = $1 AND role = $3`, [pid, has ? 'host' : 'player', has ? 'player' : 'host']);
}
const nameTaken = async (c, name, except) => !!await one(c, `SELECT 1 FROM clubs WHERE lower(name) = lower($1) AND status IN ('pending', 'active') AND id <> $2`, [name, except || '']);

module.exports = async function (app) {
  // открытые клубы — всем
  app.get('/api/clubs', async () => ({ clubs: await listJSON(pool, await all(pool, CLUB_SQL + ` WHERE c.status = 'active' ORDER BY c.city, c.name`)) }));

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
