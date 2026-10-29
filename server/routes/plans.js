// Тарифы и роли.
// Игрок видит тарифы со своей скидкой за звание и оставляет заявку; администратор (право plans) подключает на срок
// тарифа, продлевает и завершает. Роль игрока — роль действующего тарифа (plans.js), по окончании снимается сама.
// Тех. администратор меняет тарифы, скидки и роли (свои роли для тарифов).
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer, needPerm, clearCache } = require('../auth');
const { RANK, ROLES, can } = require('../roles');
const { audit, loadSettings } = require('../audit');
const P = require('../plans');

const needTech = req => { const me = needPlayer(req); if (me.role !== 'tech' || me.blocked) throw E.forbidden('Это может только тех. администратор'); return me; };
const planJSON = (p, title) => {
  const d = P.discountFor(title || '');
  return { id: p.id, name: p.name, price: p.price, days: p.days, role: p.role, about: p.about, active: p.active, sort: p.sort, discount: d.pct, why: d.why, final: P.priceWith(p.price, d.pct),
    year: p.year_price == null ? null : p.year_price, yearFinal: p.year_price == null ? null : P.priceWith(p.year_price, d.pct) };
};
const subJSON = r => ({ id: +r.id, player: r.player_id ? { id: r.player_id, name: r.player_name, code: r.player_code, title: r.player_title || '' } : undefined, plan: { id: r.plan_id, name: r.plan_name, price: r.plan_price, days: r.plan_days },
  year: !!r.year, status: r.status, price: r.price, discount: r.discount, starts: r.starts == null ? null : +r.starts, ends: r.ends == null ? null : +r.ends, note: r.note, created: +r.created_at, by: r.by_name || null });
const SUB_SQL = `SELECT pp.*, pl.name AS plan_name, pl.price AS plan_price, pl.year_price AS plan_year, pl.days AS plan_days, p.name AS player_name, p.code AS player_code, p.title AS player_title, g.name AS by_name
  FROM player_plans pp JOIN plans pl ON pl.id = pp.plan_id JOIN players p ON p.id = pp.player_id LEFT JOIN players g ON g.id = pp.granted_by`;

function planFields(b, full) {
  const o = {};
  if (full || b.name !== undefined) o.name = V.str(b.name, 'name', 2, 40);
  if (full || b.price !== undefined) o.price = V.int(b.price, 'price', 0, 1000000);
  if (full || b.days !== undefined) o.days = V.int(b.days, 'days', 1, 3660);
  if (full || b.role !== undefined) {
    o.role = V.oneOf(b.role, 'role', ROLES);
    if (RANK[o.role] >= RANK.admin) throw E.bad('Тариф не может давать роль администратора', 'role');
  }
  if (full || b.about !== undefined) o.about = V.optStr(String(b.about == null ? '' : b.about).replace(/\r/g, ''), 'about', 1000);
  if (b.yearPrice !== undefined) o.year_price = b.yearPrice == null || b.yearPrice === '' ? null : V.int(b.yearPrice, 'yearPrice', 0, 10000000);
  if (b.active !== undefined) o.active = V.bool(b.active, 'active');
  if (b.sort !== undefined) o.sort = V.int(b.sort, 'sort', 0, 1000);
  return o;
}
// подключить тариф: новый срок идёт с конца действующего такого же тарифа (продление) или с сейчас;
// year — на год по цене за год (срок 365 дней)
async function grant(c, me, pid, plan, days, note, reqId, year) {
  if (year && plan.year_price == null) throw E.bad('У этого тарифа нет оплаты за год', 'year');
  const p = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [pid]);
  if (!p) throw E.notFound('Игрок не найден');
  const now = Date.now(), cur = await one(c, `SELECT * FROM player_plans WHERE player_id = $1 AND plan_id = $2 AND status = 'active' AND ends > $3 ORDER BY ends DESC LIMIT 1`, [pid, plan.id, now]);
  const d = P.discountFor(p.title || ''), price = P.priceWith(year ? plan.year_price : plan.price, d.pct), dur = (year ? 365 : days || plan.days) * 864e5;
  let row;
  if (cur) row = await one(c, 'UPDATE player_plans SET ends = ends + $2, price = price + $3 WHERE id = $1 RETURNING *', [cur.id, dur, price]);
  else row = await one(c, `INSERT INTO player_plans (player_id, plan_id, status, price, discount, starts, ends, note, granted_by, created_at, year) VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $5, $9) RETURNING *`,
    [pid, plan.id, price, d.pct, now, now + dur, note || '', me.id, !!year]);
  if (reqId) await c.query(`UPDATE player_plans SET status = 'cancelled', note = 'подключено' WHERE id = $1 AND status = 'requested'`, [reqId]);
  await P.syncPlanRole(c, pid);
  await audit(c, me, cur ? 'plan.extend' : 'plan.grant', p, { plan: plan.name, days: year ? 365 : days || plan.days, price, discount: d.pct });
  return row;
}

module.exports = async function (app) {
  // тарифы для игрока: цена со скидкой за его звание, действующий тариф и заявка
  app.get('/api/plans', async req => {
    const me = req.player, now = Date.now();
    const plans = (await all(pool, 'SELECT * FROM plans WHERE active ORDER BY sort, price')).map(p => planJSON(p, me && me.title));
    if (!me) return { plans, mine: [], request: null, discounts: P.getDiscounts() };
    const mine = (await all(pool, SUB_SQL + ` WHERE pp.player_id = $1 AND pp.status = 'active' AND pp.ends > $2 ORDER BY pp.ends DESC`, [me.id, now])).map(subJSON);
    const rq = await one(pool, SUB_SQL + ` WHERE pp.player_id = $1 AND pp.status = 'requested'`, [me.id]);
    return { plans, mine, request: rq ? subJSON(rq) : null, discounts: P.getDiscounts() };
  });

  // заявка на тариф (онлайн-оплаты пока нет — подключает администратор): { year: true } — на год
  app.post('/api/plans/:id/request', async (req, reply) => {
    const me = needPlayer(req), year = (req.body || {}).year == null ? false : V.bool(req.body.year, 'year');
    const r = await tx(async c => {
      const plan = await one(c, 'SELECT * FROM plans WHERE id = $1 AND active', [req.params.id]);
      if (!plan) throw E.notFound('Тариф не найден');
      if (year && plan.year_price == null) throw E.bad('У этого тарифа нет оплаты за год', 'year');
      if (await one(c, `SELECT 1 FROM player_plans WHERE player_id = $1 AND status = 'requested'`, [me.id])) throw E.conflict('conflict', 'Заявка на тариф уже отправлена — дождитесь подключения или отзовите её');
      const d = P.discountFor(me.title || '');
      const row = await one(c, `INSERT INTO player_plans (player_id, plan_id, status, price, discount, note, created_at, year) VALUES ($1, $2, 'requested', $3, $4, $5, $6, $7) RETURNING *`,
        [me.id, plan.id, P.priceWith(year ? plan.year_price : plan.price, d.pct), d.pct, V.optStr((req.body || {}).note, 'note', 300), Date.now(), year]);
      await audit(c, me, 'plan.request', me, { plan: plan.name, year });
      return one(c, SUB_SQL + ' WHERE pp.id = $1', [row.id]);
    });
    return reply.code(201).send({ request: subJSON(r) });
  });
  app.delete('/api/plans/requests/:id', async req => {
    const me = needPlayer(req);
    const r = await one(pool, `UPDATE player_plans SET status = 'cancelled' WHERE id = $1 AND player_id = $2 AND status = 'requested' RETURNING id`, [+req.params.id || 0, me.id]);
    if (!r) throw E.notFound('Заявки нет');
    return { ok: true };
  });

  // администратор: тарифы, заявки, действующие подключения
  app.get('/api/admin/plans', async req => {
    needPerm(req, 'plans', 'Тарифы подключает администратор');
    const now = Date.now();
    return {
      plans: (await all(pool, 'SELECT * FROM plans ORDER BY sort, price')).map(p => planJSON(p, '')),
      requests: (await all(pool, SUB_SQL + ` WHERE pp.status = 'requested' ORDER BY pp.created_at`)).map(r => Object.assign(subJSON(r), { final: P.priceWith(r.year && r.plan_year != null ? r.plan_year : r.plan_price, P.discountFor(r.player_title || '').pct), discount: P.discountFor(r.player_title || '').pct })),
      active: (await all(pool, SUB_SQL + ` WHERE pp.status = 'active' AND pp.ends > $1 ORDER BY pp.ends`, [now])).map(subJSON),
      discounts: P.getDiscounts(), discountKeys: P.DISC_KEYS.map(([k, name]) => ({ k, name }))
    };
  });
  // подключить: { playerId, planId, days?, year?, note?, requestId? } — year: на год по цене за год
  app.post('/api/admin/plans/grant', async req => {
    const me = needPerm(req, 'plans', 'Тарифы подключает администратор'), b = req.body || {};
    const days = b.days == null ? null : V.int(b.days, 'days', 1, 3660);
    let year = b.year == null ? null : V.bool(b.year, 'year');
    const row = await tx(async c => {
      let pid = b.playerId == null ? null : V.id(b.playerId, 'playerId'), planId = b.planId, reqId = null;
      if (b.requestId != null) {
        const rq = await one(c, `SELECT * FROM player_plans WHERE id = $1 AND status = 'requested' FOR UPDATE`, [V.int(b.requestId, 'requestId', 1, 2 ** 31)]);
        if (!rq) throw E.notFound('Заявка не найдена');
        pid = rq.player_id; planId = planId || rq.plan_id; reqId = rq.id;
        if (year == null) year = rq.year;
      }
      const plan = await one(c, 'SELECT * FROM plans WHERE id = $1', [String(planId || '')]);
      if (!plan || !pid) throw E.bad('Нужен игрок и тариф', 'planId');
      return grant(c, me, pid, plan, days, V.optStr(b.note, 'note', 300), reqId, !!year);
    });
    clearCache();
    return { sub: subJSON(await one(pool, SUB_SQL + ' WHERE pp.id = $1', [row.id])) };
  });
  // отклонить заявку: { note }
  app.post('/api/admin/plans/requests/:id/reject', async req => {
    const me = needPerm(req, 'plans', 'Тарифы подключает администратор'), note = V.optStr((req.body || {}).note, 'note', 300);
    await tx(async c => {
      const r = await one(c, `UPDATE player_plans SET status = 'rejected', note = $2, granted_by = $3 WHERE id = $1 AND status = 'requested' RETURNING player_id`, [+req.params.id || 0, note, me.id]);
      if (!r) throw E.notFound('Заявка не найдена');
      await audit(c, me, 'plan.reject', await one(c, 'SELECT id, name FROM players WHERE id = $1', [r.player_id]), { note });
    });
    return { ok: true };
  });
  // завершить действующий тариф сейчас
  app.post('/api/admin/plans/subs/:id/end', async req => {
    const me = needPerm(req, 'plans', 'Тарифы подключает администратор');
    await tx(async c => {
      const r = await one(c, `UPDATE player_plans SET status = 'ended', ends = $2 WHERE id = $1 AND status = 'active' RETURNING player_id`, [+req.params.id || 0, Date.now()]);
      if (!r) throw E.notFound('Подключение не найдено');
      await P.syncPlanRole(c, r.player_id);
      await audit(c, me, 'plan.end', await one(c, 'SELECT id, name FROM players WHERE id = $1', [r.player_id]), null);
    });
    clearCache();
    return { ok: true };
  });
  // тарифы игрока для карточки
  app.get('/api/admin/players/:id/plans', async req => {
    needPerm(req, 'plans', 'Тарифы подключает администратор');
    return { subs: (await all(pool, SUB_SQL + ' WHERE pp.player_id = $1 ORDER BY pp.created_at DESC LIMIT 20', [req.params.id])).map(subJSON) };
  });

  // тарифы и скидки — право plans_edit (по умолчанию тех. администратор)
  const needEdit = req => needPerm(req, 'plans_edit', 'Цены и состав тарифов меняет тех. администратор');
  app.post('/api/admin/plans', async (req, reply) => {
    const me = needEdit(req), f = planFields(req.body || {}, true);
    const row = await one(pool, 'INSERT INTO plans (name, price, days, role, about, active, sort, created_at, year_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
      [f.name, f.price, f.days, f.role, f.about, f.active !== false, f.sort || 0, Date.now(), f.year_price == null ? null : f.year_price]);
    await audit(pool, me, 'plan.create', { id: row.id, name: row.name }, { price: row.price, days: row.days, role: row.role });
    return reply.code(201).send({ plan: planJSON(row, '') });
  });
  app.patch('/api/admin/plans/:id', async req => {
    const me = needEdit(req), f = planFields(req.body || {}, false), keys = Object.keys(f);
    if (!keys.length) throw E.bad('Нечего менять');
    const row = await one(pool, `UPDATE plans SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...keys.map(k => f[k])]);
    if (!row) throw E.notFound('Тариф не найден');
    await audit(pool, me, 'plan.edit', { id: row.id, name: row.name }, f);
    return { plan: planJSON(row, '') };
  });
  app.put('/api/admin/discounts', async req => {
    const me = needEdit(req), b = req.body || {};
    const next = {};
    for (const [k] of P.DISC_KEYS) next[k] = b[k] == null ? 0 : V.int(b[k], k, 0, 90);
    await tx(async c => {
      await c.query(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('discounts', $1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = $2, updated_by = $3`, [JSON.stringify(next), Date.now(), me.id]);
      await audit(c, me, 'discounts', null, next);
    });
    return { discounts: P.setDiscounts(next) };
  });

  // роли: все видят список (названия для значков); тех. администратор добавляет, переименовывает, удаляет свои
  app.get('/api/roles', async () => ({ roles: (await all(pool, 'SELECT key, name, rank, builtin FROM roles ORDER BY rank, key')) }));
  app.post('/api/admin/roles', async (req, reply) => {
    const me = needTech(req), name = V.str((req.body || {}).name, 'name', 2, 30);
    const row = await tx(async c => {
      if (await one(c, 'SELECT 1 FROM roles WHERE lower(name) = lower($1)', [name])) throw E.conflict('conflict', 'Такая роль уже есть');
      let key;
      for (let n = 1; ; n++) { key = 'role' + n; if (!await one(c, 'SELECT 1 FROM roles WHERE key = $1', [key])) break; }
      const out = await one(c, 'INSERT INTO roles (key, name, rank, created_at) VALUES ($1, $2, 1, $3) RETURNING key, name, rank, builtin', [key, name, Date.now()]);
      await audit(c, me, 'role.create', { id: key, name }, null);
      return out;
    });
    await loadSettings();
    return reply.code(201).send({ role: row });
  });
  app.patch('/api/admin/roles/:key', async req => {
    const me = needTech(req), name = V.str((req.body || {}).name, 'name', 2, 30);
    const row = await one(pool, 'UPDATE roles SET name = $2 WHERE key = $1 RETURNING key, name, rank, builtin', [req.params.key, name]);
    if (!row) throw E.notFound('Роли нет');
    await audit(pool, me, 'role.rename', { id: row.key, name }, null);
    await loadSettings();
    return { role: row };
  });
  app.delete('/api/admin/roles/:key', async req => {
    const me = needTech(req);
    await tx(async c => {
      const r = await one(c, 'SELECT * FROM roles WHERE key = $1 FOR UPDATE', [req.params.key]);
      if (!r) throw E.notFound('Роли нет');
      if (r.builtin) throw E.conflict('conflict', 'Встроенную роль удалить нельзя');
      if (await one(c, 'SELECT 1 FROM players WHERE role = $1 OR base_role = $1', [r.key])) throw E.conflict('conflict', 'У этой роли есть игроки — сначала смените им роль');
      if (await one(c, 'SELECT 1 FROM plans WHERE role = $1', [r.key])) throw E.conflict('conflict', 'Роль даёт тариф — сначала поменяйте тариф');
      await c.query('DELETE FROM roles WHERE key = $1', [r.key]);
      await audit(c, me, 'role.delete', { id: r.key, name: r.name }, null);
    });
    await loadSettings();
    return { ok: true };
  });
};
