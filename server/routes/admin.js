// Аккаунты игроков, роли, права ролей, журнал действий.
// Ведущий (право accounts) заводит аккаунты тем, кто не может войти сам (бабушка, гость бара): получает код входа —
// игрок вводит его на телефоне и сразу играет. Ведущий видит и правит только свои аккаунты.
// Право players — все игроки: правка, подтверждение, коды; block — блокировка; give_host — роль ведущего.
// Только тех. администратор: роли администратора и тех. администратора, логины и пароли администраторов, права ролей.
const crypto = require('node:crypto');
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer, needPerm, clearCache, normPhone } = require('../auth');
const { createPlayer, playerShort } = require('../players');
const { RANK, ROLES, ROLE_NAME, PERM, grantable, can, permTable, setPerms } = require('../roles');
const { audit } = require('../audit');
const { hashPassword, passwordProblem, LOGIN_RE, normLogin } = require('../password');

const needTech = req => { const me = needPlayer(req); if (me.role !== 'tech' || me.blocked) throw E.forbidden('Это может только тех. администратор'); return me; };
// код без похожих букв и цифр (0/O, 1/I)
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function newClaim(c) {
  for (;;) {
    const code = Array.from(crypto.randomBytes(8), b => ABC[b % ABC.length]).join('');
    if (!await one(c, 'SELECT 1 FROM players WHERE claim = $1', [code])) return code;
  }
}
const adminJSON = p => Object.assign(playerShort(p), {
  vk: p.vk_id != null, phone: p.phone || null, claim: p.claim || null, role: p.role, blocked: p.blocked, owner: p.owner_id, created: p.created_at,
  login: p.login || null, email: p.email || null, emailOk: !!p.email_ok
});
// свой номер ведущего для игрока: n — 1…9999, занятый номер переходит к новому игроку
async function setNum(c, hostId, n, playerId) {
  await c.query('DELETE FROM host_nums WHERE host_id = $1 AND (n = $2 OR player_id = $3)', [hostId, n, playerId]);
  await c.query('INSERT INTO host_nums (host_id, n, player_id) VALUES ($1, $2, $3)', [hostId, n, playerId]);
}
// кто может открыть игрока: с правом players — любого, с правом accounts — только своих
function canSee(me, p) { return can(me, 'players') || (can(me, 'accounts') && p.owner_id === me.id); }
// администраторов и тех. администраторов меняет только тех. администратор
const guardHigh = (me, p) => { if (p.id !== me.id && RANK[p.role] >= RANK.admin && me.role !== 'tech') throw E.forbidden('Администраторов меняет тех. администратор'); };

module.exports = async function (app) {
  // GET /api/admin/players?q=&limit=&role=&mine=1&blocked=1 — с правом accounts без players только свои аккаунты
  app.get('/api/admin/players', async req => {
    const me = needPlayer(req);
    if (!can(me, 'players') && !can(me, 'accounts')) throw E.forbidden('Раздел для ведущих и администраторов');
    const q = String(req.query.q || '').trim().toLowerCase(), limit = Math.min(200, Math.max(1, +req.query.limit || 50));
    const where = [], args = [];
    const arg = v => { args.push(v); return '$' + args.length; };
    if (!can(me, 'players') || req.query.mine === '1') where.push('owner_id = ' + arg(me.id));
    if (req.query.role) where.push('role = ' + arg(V.oneOf(req.query.role, 'role', ROLES)));
    if (req.query.blocked === '1') where.push('blocked');
    if (q) {
      const a = arg(q), digits = q.replace(/\D/g, '');
      where.push(`(position(${a} in lower(name)) > 0 OR position(${a} in handle) > 0 OR position(${a} in lower(code)) > 0 OR position(${a} in coalesce(login, '')) > 0 OR position(${a} in coalesce(email, '')) > 0` + (digits.length >= 4 ? ` OR position(${arg(digits)} in coalesce(phone, '')) > 0` : '') + ')');
    }
    const rows = await all(pool, 'SELECT * FROM players' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ` ORDER BY ${q ? 'name' : 'created_at DESC, id DESC'} LIMIT ${limit}`, args);
    return { players: rows.map(adminJSON) };
  });

  // GET /api/admin/players/:id — карточка: всё об аккаунте, клубы, сеансы, матчи, турниры, последние действия
  app.get('/api/admin/players/:id', async req => {
    const me = needPlayer(req);
    const p = await one(pool, 'SELECT * FROM players WHERE id = $1', [req.params.id]);
    if (!p) throw E.notFound('Игрок не найден');
    if (!canSee(me, p)) throw E.forbidden('Нет доступа к этому аккаунту');
    const n = async (sql) => (await one(pool, sql, [p.id])).n;
    const owner = p.owner_id ? await one(pool, 'SELECT id, name FROM players WHERE id = $1', [p.owner_id]) : null;
    return {
      player: adminJSON(p),
      owner,
      clubs: await all(pool, `SELECT c.id, c.name, c.status FROM club_hosts h JOIN clubs c ON c.id = h.club_id WHERE h.player_id = $1 ORDER BY c.name`, [p.id]),
      sessions: await n('SELECT count(*)::int AS n FROM sessions WHERE player_id = $1 AND expires_at > ' + Date.now()),
      matches: await n('SELECT count(*)::int AS n FROM match_lines WHERE player_id = $1'),
      tours: await n('SELECT count(*)::int AS n FROM entries WHERE player_id = $1'),
      owned: await n('SELECT count(*)::int AS n FROM players WHERE owner_id = $1'),
      locked: p.pass_lock_until && p.pass_lock_until > Date.now() ? p.pass_lock_until : null,
      log: can(me, 'audit') ? await all(pool, 'SELECT t, actor_name, action, data FROM audit WHERE target = $1 ORDER BY t DESC LIMIT 20', [p.id]) : []
    };
  });

  // POST /api/admin/players — { name, city, club, title, phone?, n? } → игрок с кодом входа; n — номер в списке ведущего
  app.post('/api/admin/players', async (req, reply) => {
    const me = needPlayer(req), b = req.body || {};
    if (!can(me, 'accounts') && !can(me, 'players')) throw E.forbidden('Аккаунты заводят ведущие и администраторы');
    const phone = b.phone == null || b.phone === '' ? null : normPhone(b.phone);
    const n = b.n == null ? null : V.int(b.n, 'n', 1, 9999);
    const p = await tx(async c => {
      if (phone && await one(c, 'SELECT 1 FROM players WHERE phone = $1', [phone])) throw E.conflict('phone_taken', 'Этот номер уже привязан к другому аккаунту');
      const pl = await createPlayer(c, { name: V.str(b.name, 'name', 2, 32), city: V.optStr(b.city, 'city', 40), club: V.optStr(b.club, 'club', 40), phone, owner_id: me.id });
      if (n) await setNum(c, me.id, n, pl.id);
      // звание при создании — только с правом titles (оно сразу считается подтверждённым)
      const title = b.title && can(me, 'titles') ? V.optStr(b.title, 'title', 40) : '';
      const out = await one(c, 'UPDATE players SET title = $2, claim = $3 WHERE id = $1 RETURNING *', [pl.id, title, await newClaim(c)]);
      await audit(c, me, 'player.create', out, { phone: !!phone });
      return out;
    });
    return reply.code(201).send({ player: adminJSON(p) });
  });

  // PATCH /api/admin/players/:id — { name, city, club, title, claim: true (новый код) | false (убрать),
  //   ver, blocked, role (give_host: player | host; тех. администратор: любая) }
  app.patch('/api/admin/players/:id', async req => {
    const me = needPlayer(req), b = req.body || {}, full = can(me, 'players');
    if (!full && !can(me, 'accounts')) throw E.forbidden('Нет прав');
    const p = await tx(async c => {
      const cur = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur) throw E.notFound('Игрок не найден');
      if (!full && cur.owner_id !== me.id) throw E.forbidden('Ведущий меняет только аккаунты, которые завёл сам');
      if (!full && cur.vk_id != null) throw E.forbidden('Игрок привязал VK и ведёт аккаунт сам');
      guardHigh(me, cur);
      const set = {};
      if (b.name !== undefined) set.name = V.str(b.name, 'name', 2, 32);
      if (b.city !== undefined) set.city = V.optStr(b.city, 'city', 40);
      if (b.club !== undefined) set.club = V.optStr(b.club, 'club', 40);
      if (b.title !== undefined && b.title !== (cur.title || '')) {
        if (!can(me, 'titles')) throw E.forbidden('Звание подтверждается заявкой — меняет его администратор');
        set.title = V.optStr(b.title, 'title', 40);
      }
      if (b.claim === true) {
        if (cur.vk_id != null) throw E.conflict('conflict', 'Аккаунт привязан к VK — игрок входит сам');
        // по коду войдёт любой, у кого он есть: аккаунту с телефоном новый код выдаёт только администратор
        if (!full && (cur.phone != null || cur.login || cur.email)) throw E.forbidden('Игрок входит сам (телефон или почта) — новый код выдаёт администратор');
        set.claim = await newClaim(c);
      } else if (b.claim === false) set.claim = null;
      if (b.ver !== undefined) {
        if (!full) throw E.forbidden('Подтверждает администратор');
        set.ver = V.bool(b.ver, 'ver');
      }
      if (b.blocked !== undefined) {
        if (!can(me, 'block')) throw E.forbidden('Блокировать может администратор');
        if (cur.id === me.id) throw E.conflict('conflict', 'Нельзя заблокировать себя');
        set.blocked = V.bool(b.blocked, 'blocked');
      }
      if (b.role !== undefined) {
        const role = V.oneOf(b.role, 'role', ROLES);
        if (cur.id === me.id) throw E.conflict('conflict', 'Свою роль менять нельзя');
        if ((RANK[role] >= RANK.admin || RANK[cur.role] >= RANK.admin) && me.role !== 'tech') throw E.forbidden('Роль администратора выдаёт тех. администратор');
        if (!can(me, 'give_host') && me.role !== 'tech') throw E.forbidden('Роль ведущего выдаёт администратор');
        set.role = role;
        // выданная вручную роль остаётся основой: к ней игрок вернётся, когда кончится тариф (plans.js)
        set.base_role = RANK[role] < RANK.admin ? role : 'player';
        // ниже администратора вход по паролю не нужен
        if (RANK[role] < RANK.admin) { set.login = null; set.pass_hash = null; }
      }
      const keys = Object.keys(set);
      if (!keys.length) throw E.bad('Нечего менять');
      if (set.blocked || set.pass_hash === null) await c.query('DELETE FROM sessions WHERE player_id = $1', [cur.id]);
      const out = await one(c, `UPDATE players SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1 RETURNING *`, [cur.id, ...keys.map(k => set[k])]);
      const log = Object.fromEntries(keys.filter(k => !['claim', 'pass_hash', 'login', 'base_role'].includes(k)).map(k => [k, set[k]]));
      if (set.role) log.from = cur.role;
      if (b.claim === true) log.code = 'новый';
      await audit(c, me, set.role ? 'player.role' : set.blocked !== undefined ? 'player.block' : 'player.edit', out, log);
      return out;
    });
    clearCache();
    return { player: adminJSON(p) };
  });

  // завершить все сеансы игрока (потерял телефон, вход с чужого устройства)
  app.post('/api/admin/players/:id/logout', async req => {
    const me = needPerm(req, 'players', 'Это может администратор');
    const out = await tx(async c => {
      const p = await one(c, 'SELECT * FROM players WHERE id = $1', [req.params.id]);
      if (!p) throw E.notFound('Игрок не найден');
      guardHigh(me, p);
      const r = await c.query('DELETE FROM sessions WHERE player_id = $1', [p.id]);
      await audit(c, me, 'player.logout', p, { sessions: r.rowCount });
      return r.rowCount;
    });
    clearCache();
    return { ok: true, sessions: out };
  });

  // логин и пароль администратора (тех. администратор): { login, password }; пароль задаёт тот, кто знает, и передаёт лично
  app.put('/api/admin/players/:id/login', async req => {
    const me = needTech(req), b = req.body || {}, login = normLogin(b.login);
    if (!LOGIN_RE.test(login)) throw E.bad('Логин: 3–32 символа, латиница, цифры, точка, дефис, подчёркивание', 'login');
    const bad = passwordProblem(b.password);
    if (bad) throw E.bad(bad, 'password');
    const hash = await hashPassword(b.password);
    const p = await tx(async c => {
      const cur = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur) throw E.notFound('Игрок не найден');
      if (RANK[cur.role] < RANK.admin) throw E.conflict('conflict', 'Вход по паролю — только для администраторов: сначала выдайте роль');
      if (await one(c, 'SELECT 1 FROM players WHERE login = $1 AND id <> $2', [login, cur.id])) throw E.conflict('login_taken', 'Такой логин уже занят');
      const out = await one(c, 'UPDATE players SET login = $2, pass_hash = $3, pass_fails = 0, pass_lock_until = NULL WHERE id = $1 RETURNING *', [cur.id, login, hash]);
      await audit(c, me, 'player.login', out, { login });
      return out;
    });
    clearCache();
    return { player: adminJSON(p) };
  });
  app.delete('/api/admin/players/:id/login', async req => {
    const me = needTech(req);
    const p = await tx(async c => {
      const cur = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur) throw E.notFound('Игрок не найден');
      if (cur.id === me.id && cur.vk_id == null && cur.phone == null) throw E.conflict('conflict', 'Это ваш единственный способ входа');
      const out = await one(c, 'UPDATE players SET login = NULL, pass_hash = NULL, pass_fails = 0, pass_lock_until = NULL WHERE id = $1 RETURNING *', [cur.id]);
      await audit(c, me, 'player.login_off', out, null);
      return out;
    });
    clearCache();
    return { player: adminJSON(p) };
  });

  // права ролей: таблица и изменение (тех. администратор). PUT { perms: { ключ: [роли] } }
  const permsResp = () => ({ perms: permTable(), roles: grantable().map(k => ({ key: k, name: ROLE_NAME[k], rank: RANK[k] })) });
  app.get('/api/admin/perms', async req => {
    needPlayer(req);
    return permsResp();
  });
  app.put('/api/admin/perms', async req => {
    const me = needTech(req), b = req.body || {};
    if (!b.perms || typeof b.perms !== 'object' || Array.isArray(b.perms)) throw E.bad('perms: { ключ: [роли] }', 'perms');
    for (const [k, v] of Object.entries(b.perms)) {
      if (!PERM[k]) throw E.bad('Неизвестное право: ' + k, 'perms');
      if (!Array.isArray(v) || v.some(r => !grantable().includes(r))) throw E.bad('Роли права ' + k + ': ' + grantable().join(', '), 'perms');
    }
    const saved = await tx(async c => {
      const cur = await one(c, `SELECT value FROM settings WHERE key = 'perms' FOR UPDATE`);
      const next = Object.assign({}, cur ? cur.value : {}, b.perms);
      await c.query(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('perms', $1, $2, $3)
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = $2, updated_by = $3`, [JSON.stringify(next), Date.now(), me.id]);
      await audit(c, me, 'perms', null, b.perms);
      return next;
    });
    setPerms(saved);
    clearCache();
    return permsResp();
  });

  // журнал: GET /api/admin/audit?limit=&before=время&target=
  app.get('/api/admin/audit', async req => {
    needPerm(req, 'audit', 'Журнал — для администратора');
    const limit = Math.min(200, Math.max(1, +req.query.limit || 50)), args = [], where = [];
    if (req.query.before) { args.push(+req.query.before); where.push('t < $' + args.length); }
    if (req.query.target) { args.push(String(req.query.target)); where.push('target = $' + args.length); }
    const rows = await all(pool, 'SELECT id, t, actor_id, actor_name, action, target, target_name, data FROM audit' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ` ORDER BY t DESC, id DESC LIMIT ${limit}`, args);
    return { items: rows.map(r => ({ id: +r.id, t: +r.t, actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null, action: r.action, target: r.target ? { id: r.target, name: r.target_name } : null, data: r.data })) };
  });

  // GET /api/admin/stats — сводка
  app.get('/api/admin/stats', async req => {
    needPerm(req, 'stats', 'Раздел для администратора');
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
      titlesPending: await n(`SELECT count(*)::int AS n FROM title_requests WHERE status = 'review'`),
      smsDay: await n('SELECT count(*)::int AS n FROM sms_log WHERE t > $1', [now - 864e5])
    };
  });
};

module.exports.setNum = setNum;
