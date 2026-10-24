// Аккаунты игроков и роли.
// Ведущий заводит аккаунты тем, кто не может войти сам (бабушка, гость бара): получает код входа —
// игрок вводит его на телефоне и сразу играет. Ведущий видит и правит только свои аккаунты.
// Администратор — всех игроков: правка, подтверждение, блокировка, роль ведущего.
// Тех. администратор — ещё роли администратора и тех. администратора.
const crypto = require('node:crypto');
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer, clearCache, normPhone } = require('../auth');
const { createPlayer, playerShort } = require('../players');
const { RANK, ROLES, atLeast, isAdmin } = require('../roles');

const needRole = (req, role, msg) => { const me = needPlayer(req); if (!atLeast(me, role)) throw E.forbidden(msg || 'Нет прав'); return me; };
// код без похожих букв и цифр (0/O, 1/I)
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function newClaim(c) {
  for (;;) {
    const code = Array.from(crypto.randomBytes(8), b => ABC[b % ABC.length]).join('');
    if (!await one(c, 'SELECT 1 FROM players WHERE claim = $1', [code])) return code;
  }
}
const adminJSON = p => Object.assign(playerShort(p), {
  vk: p.vk_id != null, phone: p.phone || null, claim: p.claim || null, role: p.role, blocked: p.blocked, owner: p.owner_id, created: p.created_at
});
// свой номер ведущего для игрока: n — 1…9999, занятый номер переходит к новому игроку
async function setNum(c, hostId, n, playerId) {
  await c.query('DELETE FROM host_nums WHERE host_id = $1 AND (n = $2 OR player_id = $3)', [hostId, n, playerId]);
  await c.query('INSERT INTO host_nums (host_id, n, player_id) VALUES ($1, $2, $3)', [hostId, n, playerId]);
}

module.exports = async function (app) {
  // GET /api/admin/players?q=&limit=&role=&mine=1 — ведущему только свои аккаунты
  app.get('/api/admin/players', async req => {
    const me = needRole(req, 'host', 'Раздел для ведущих и администраторов');
    const q = String(req.query.q || '').trim().toLowerCase(), limit = Math.min(200, Math.max(1, +req.query.limit || 50));
    const where = [], args = [];
    const arg = v => { args.push(v); return '$' + args.length; };
    if (!isAdmin(me) || req.query.mine === '1') where.push('owner_id = ' + arg(me.id));
    if (req.query.role) where.push('role = ' + arg(V.oneOf(req.query.role, 'role', ROLES)));
    if (req.query.blocked === '1') where.push('blocked');
    if (q) {
      const a = arg(q), digits = q.replace(/\D/g, '');
      where.push(`(position(${a} in lower(name)) > 0 OR position(${a} in handle) > 0 OR position(${a} in lower(code)) > 0` + (digits.length >= 4 ? ` OR position(${arg(digits)} in coalesce(phone, '')) > 0` : '') + ')');
    }
    const rows = await all(pool, 'SELECT * FROM players' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ` ORDER BY ${q ? 'name' : 'created_at DESC, id DESC'} LIMIT ${limit}`, args);
    return { players: rows.map(adminJSON) };
  });

  // POST /api/admin/players — { name, city, club, title, phone?, n? } → игрок с кодом входа; n — номер в списке ведущего
  app.post('/api/admin/players', async (req, reply) => {
    const me = needRole(req, 'host', 'Аккаунты заводят ведущие и администраторы'), b = req.body || {};
    const phone = b.phone == null || b.phone === '' ? null : normPhone(b.phone);
    const n = b.n == null ? null : V.int(b.n, 'n', 1, 9999);
    const p = await tx(async c => {
      if (phone && await one(c, 'SELECT 1 FROM players WHERE phone = $1', [phone])) throw E.conflict('phone_taken', 'Этот номер уже привязан к другому аккаунту');
      const pl = await createPlayer(c, { name: V.str(b.name, 'name', 2, 32), city: V.optStr(b.city, 'city', 40), club: V.optStr(b.club, 'club', 40), phone, owner_id: me.id });
      if (n) await setNum(c, me.id, n, pl.id);
      return one(c, 'UPDATE players SET title = $2, claim = $3 WHERE id = $1 RETURNING *', [pl.id, V.optStr(b.title, 'title', 40), await newClaim(c)]);
    });
    return reply.code(201).send({ player: adminJSON(p) });
  });

  // PATCH /api/admin/players/:id — { name, city, club, title, claim: true (новый код) | false (убрать),
  //   ver, blocked, role (администратор: player | host; тех. администратор: любая) }
  app.patch('/api/admin/players/:id', async req => {
    const me = needRole(req, 'host'), b = req.body || {}, admin = isAdmin(me);
    const p = await tx(async c => {
      const cur = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur) throw E.notFound('Игрок не найден');
      if (!admin && cur.owner_id !== me.id) throw E.forbidden('Ведущий меняет только аккаунты, которые завёл сам');
      if (!admin && cur.vk_id != null) throw E.forbidden('Игрок привязал VK и ведёт аккаунт сам');
      if (cur.id !== me.id && RANK[cur.role] >= RANK.admin && me.role !== 'tech') throw E.forbidden('Администраторов меняет тех. администратор');
      const set = {};
      if (b.name !== undefined) set.name = V.str(b.name, 'name', 2, 32);
      if (b.city !== undefined) set.city = V.optStr(b.city, 'city', 40);
      if (b.club !== undefined) set.club = V.optStr(b.club, 'club', 40);
      if (b.title !== undefined) set.title = V.optStr(b.title, 'title', 40);
      if (b.claim === true) {
        if (cur.vk_id != null) throw E.conflict('conflict', 'Аккаунт привязан к VK — игрок входит сам');
        set.claim = await newClaim(c);
      } else if (b.claim === false) set.claim = null;
      if (b.ver !== undefined || b.blocked !== undefined || b.role !== undefined) {
        if (!admin) throw E.forbidden('Это может только администратор');
        if (b.ver !== undefined) set.ver = V.bool(b.ver, 'ver');
        if (b.blocked !== undefined) {
          if (cur.id === me.id) throw E.conflict('conflict', 'Нельзя заблокировать себя');
          set.blocked = V.bool(b.blocked, 'blocked');
        }
        if (b.role !== undefined) {
          const role = V.oneOf(b.role, 'role', ROLES);
          if (cur.id === me.id) throw E.conflict('conflict', 'Свою роль менять нельзя');
          if (RANK[role] >= RANK.admin && me.role !== 'tech') throw E.forbidden('Роль администратора выдаёт тех. администратор');
          set.role = role;
        }
      }
      const keys = Object.keys(set);
      if (!keys.length) throw E.bad('Нечего менять');
      if (set.blocked) await c.query('DELETE FROM sessions WHERE player_id = $1', [cur.id]);
      return one(c, `UPDATE players SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1 RETURNING *`, [cur.id, ...keys.map(k => set[k])]);
    });
    clearCache();
    return { player: adminJSON(p) };
  });

  // GET /api/admin/stats — сводка для администратора
  app.get('/api/admin/stats', async req => {
    needRole(req, 'admin', 'Раздел для администратора');
    const now = Date.now(), n = async (sql, args) => (await one(pool, sql, args || [])).n;
    const roles = Object.fromEntries((await all(pool, 'SELECT role, count(*)::int AS n FROM players GROUP BY role')).map(r => [r.role, r.n]));
    return {
      players: await n('SELECT count(*)::int AS n FROM players'),
      roles: Object.fromEntries(ROLES.map(r => [r, roles[r] || 0])),
      newWeek: await n('SELECT count(*)::int AS n FROM players WHERE created_at > $1', [now - 7 * 864e5]),
      blocked: await n('SELECT count(*)::int AS n FROM players WHERE blocked'),
      tours: Object.fromEntries((await all(pool, 'SELECT status, count(*)::int AS n FROM tournaments GROUP BY status')).map(r => [r.status, r.n])),
      liveMatches: await n(`SELECT count(*)::int AS n FROM matches WHERE status = 'live'`),
      matchesDay: await n(`SELECT count(*)::int AS n FROM matches WHERE status = 'done' AND finished > $1`, [now - 864e5]),
      clubsPending: await n(`SELECT count(*)::int AS n FROM clubs WHERE status = 'pending'`),
      smsDay: await n('SELECT count(*)::int AS n FROM sms_log WHERE t > $1', [now - 864e5])
    };
  });
};

module.exports.needRole = needRole;
module.exports.setNum = setNum;
