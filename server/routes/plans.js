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
// цена для игрока: скидка на открытие или за звание (выгоднейшая), промокод — сверху
const planJSON = (p, title, promo) => {
  const m = P.priceFor(p, title, false, promo), y = p.year_price == null ? null : P.priceFor(p, title, true, promo);
  return { id: p.id, name: p.name, price: p.price, days: p.days, role: p.role, about: p.about, active: p.active, sort: p.sort, discount: m.pct, why: m.why, final: m.price,
    year: p.year_price == null ? null : p.year_price, yearFinal: y ? y.price : null, yearDiscount: y ? y.pct : 0 };
};
const saleJSON = () => { const s = P.saleNow(); return s ? { pct: s.pct, until: s.until, title: s.title } : null; };
const promoJSON = r => ({ id: r.id, code: r.code, pct: r.pct, until: r.until == null ? null : +r.until, maxUses: r.max_uses, used: r.used, plans: r.plans || null, active: r.active, note: r.note, created: +r.created_at });
// промокод для тарифа: действует, не истёк, не исчерпан, подходит к тарифу
async function promoFor(c, code, planId, lock) {
  const k = String(code == null ? '' : code).trim().toUpperCase();
  if (!k) return null;
  const r = await one(c, 'SELECT * FROM promo_codes WHERE code = $1' + (lock ? ' FOR UPDATE' : ''), [k]);
  if (!r || !r.active) throw E.notFound('Промокод не найден');
  if (r.until != null && r.until <= Date.now()) throw E.conflict('promo_expired', 'Срок промокода истёк');
  if (r.max_uses != null && r.used >= r.max_uses) throw E.conflict('promo_used', 'Промокод уже использован');
  if (planId && r.plans && !r.plans.includes(planId)) throw E.conflict('promo_plan', 'Промокод не для этого тарифа');
  return r;
}
const subJSON = r => ({ id: +r.id, player: r.player_id ? { id: r.player_id, name: r.player_name, code: r.player_code, title: r.player_title || '' } : undefined, plan: { id: r.plan_id, name: r.plan_name, price: r.plan_price, days: r.plan_days },
  year: !!r.year, promo: r.promo_code || null, status: r.status, price: r.price, discount: r.discount, starts: r.starts == null ? null : +r.starts, ends: r.ends == null ? null : +r.ends, note: r.note, created: +r.created_at, by: r.by_name || null });
const SUB_SQL = `SELECT pp.*, pl.name AS plan_name, pl.price AS plan_price, pl.year_price AS plan_year, pl.days AS plan_days, p.name AS player_name, p.code AS player_code, p.title AS player_title, g.name AS by_name, pc.code AS promo_code
  FROM player_plans pp JOIN plans pl ON pl.id = pp.plan_id JOIN players p ON p.id = pp.player_id LEFT JOIN players g ON g.id = pp.granted_by LEFT JOIN promo_codes pc ON pc.id = pp.promo_id`;

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
// year — на год по цене за год (срок 365 дней); rq — заявка: цена и промокод из неё (как видел игрок)
async function grant(c, me, pid, plan, days, note, rq, year) {
  if (year && plan.year_price == null) throw E.bad('У этого тарифа нет оплаты за год', 'year');
  const p = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [pid]);
  if (!p) throw E.notFound('Игрок не найден');
  const now = Date.now(), cur = await one(c, `SELECT * FROM player_plans WHERE player_id = $1 AND plan_id = $2 AND status = 'active' AND ends > $3 ORDER BY ends DESC LIMIT 1`, [pid, plan.id, now]);
  const d = rq ? { price: rq.price, pct: rq.discount } : P.priceFor(plan, p.title, year, null), price = d.price, dur = (year ? 365 : days || plan.days) * 864e5;
  let row;
  if (cur) row = await one(c, 'UPDATE player_plans SET ends = ends + $2, price = price + $3 WHERE id = $1 RETURNING *', [cur.id, dur, price]);
  else row = await one(c, `INSERT INTO player_plans (player_id, plan_id, status, price, discount, starts, ends, note, granted_by, created_at, year, promo_id) VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $5, $9, $10) RETURNING *`,
    [pid, plan.id, price, d.pct, now, now + dur, note || '', me.id, !!year, rq ? rq.promo_id : null]);
  if (rq) await c.query(`UPDATE player_plans SET status = 'cancelled', note = 'подключено' WHERE id = $1 AND status = 'requested'`, [rq.id]);
  // промокод считается использованным, когда тариф подключили
  if (rq && rq.promo_id) await c.query('UPDATE promo_codes SET used = used + 1 WHERE id = $1', [rq.promo_id]);
  await P.syncPlanRole(c, pid);
  await audit(c, me, cur ? 'plan.extend' : 'plan.grant', p, { plan: plan.name, days: year ? 365 : days || plan.days, price, discount: d.pct });
  return row;
}

module.exports = async function (app) {
  // тарифы для игрока: цена со скидкой за его звание, действующий тариф и заявка
  app.get('/api/plans', async req => {
    const me = req.player, now = Date.now();
    const plans = (await all(pool, 'SELECT * FROM plans WHERE active ORDER BY sort, price')).map(p => planJSON(p, me && me.title));
    if (!me) return { plans, mine: [], request: null, discounts: P.getDiscounts(), sale: saleJSON() };
    const mine = (await all(pool, SUB_SQL + ` WHERE pp.player_id = $1 AND pp.status = 'active' AND pp.ends > $2 ORDER BY pp.ends DESC`, [me.id, now])).map(subJSON);
    const rq = await one(pool, SUB_SQL + ` WHERE pp.player_id = $1 AND pp.status = 'requested'`, [me.id]);
    return { plans, mine, request: rq ? subJSON(rq) : null, discounts: P.getDiscounts(), sale: saleJSON() };
  });
  // проверить промокод: ?code= → тарифы с ценой по нему
  app.get('/api/plans/promo', async req => {
    const me = needPlayer(req);
    require('../auth').ipLimit(req, 'promo', 30, 10 * 6e4);
    const promo = await promoFor(pool, req.query.code, null);
    if (!promo) throw E.bad('Введите промокод', 'code');
    const plans = (await all(pool, 'SELECT * FROM plans WHERE active ORDER BY sort, price')).filter(p => !promo.plans || promo.plans.includes(p.id)).map(p => planJSON(p, me.title, promo));
    return { promo: { code: promo.code, pct: promo.pct, until: promo.until == null ? null : +promo.until, plans: promo.plans || null }, plans };
  });

  // заявка на тариф (онлайн-оплаты пока нет — подключает администратор): { year: true } — на год, { promo } — промокод
  app.post('/api/plans/:id/request', async (req, reply) => {
    const me = needPlayer(req), year = (req.body || {}).year == null ? false : V.bool(req.body.year, 'year');
    const r = await tx(async c => {
      const plan = await one(c, 'SELECT * FROM plans WHERE id = $1 AND active', [req.params.id]);
      if (!plan) throw E.notFound('Тариф не найден');
      if (year && plan.year_price == null) throw E.bad('У этого тарифа нет оплаты за год', 'year');
      if (await one(c, `SELECT 1 FROM player_plans WHERE player_id = $1 AND status = 'requested'`, [me.id])) throw E.conflict('conflict', 'Заявка на тариф уже отправлена — дождитесь подключения или отзовите её');
      const promo = await promoFor(c, (req.body || {}).promo, plan.id), d = P.priceFor(plan, me.title, year, promo);
      const row = await one(c, `INSERT INTO player_plans (player_id, plan_id, status, price, discount, note, created_at, year, promo_id) VALUES ($1, $2, 'requested', $3, $4, $5, $6, $7, $8) RETURNING *`,
        [me.id, plan.id, d.price, d.pct, V.optStr((req.body || {}).note, 'note', 300), Date.now(), year, promo ? promo.id : null]);
      await audit(c, me, 'plan.request', me, Object.assign({ plan: plan.name, year, price: d.price }, promo ? { promo: promo.code } : {}));
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
      requests: (await all(pool, SUB_SQL + ` WHERE pp.status = 'requested' ORDER BY pp.created_at`)).map(r => Object.assign(subJSON(r), { final: r.price })),
      active: (await all(pool, SUB_SQL + ` WHERE pp.status = 'active' AND pp.ends > $1 ORDER BY pp.ends`, [now])).map(subJSON),
      discounts: P.getDiscounts(), discountKeys: P.DISC_KEYS.map(([k, name]) => ({ k, name })),
      sale: P.getSale(), saleNow: !!P.saleNow(), promos: (await all(pool, 'SELECT * FROM promo_codes ORDER BY active DESC, created_at DESC LIMIT 200')).map(promoJSON)
    };
  });
  // подключить: { playerId, planId, days?, year?, note?, requestId? } — year: на год по цене за год
  app.post('/api/admin/plans/grant', async req => {
    const me = needPerm(req, 'plans', 'Тарифы подключает администратор'), b = req.body || {};
    const days = b.days == null ? null : V.int(b.days, 'days', 1, 3660);
    let year = b.year == null ? null : V.bool(b.year, 'year');
    const row = await tx(async c => {
      let pid = b.playerId == null ? null : V.id(b.playerId, 'playerId'), planId = b.planId, rq = null;
      if (b.requestId != null) {
        rq = await one(c, `SELECT * FROM player_plans WHERE id = $1 AND status = 'requested' FOR UPDATE`, [V.int(b.requestId, 'requestId', 1, 2 ** 31)]);
        if (!rq) throw E.notFound('Заявка не найдена');
        pid = rq.player_id; planId = rq.plan_id;
        year = rq.year;
      }
      const plan = await one(c, 'SELECT * FROM plans WHERE id = $1', [String(planId || '')]);
      if (!plan || !pid) throw E.bad('Нужен игрок и тариф', 'planId');
      return grant(c, me, pid, plan, days, V.optStr(b.note, 'note', 300), rq, !!year);
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

  // скидка на открытие (право plans): { pct 0–90, until: время | null (бессрочно), title }
  app.put('/api/admin/sale', async req => {
    const me = needPerm(req, 'plans', 'Скидку меняет администратор'), b = req.body || {};
    const next = { pct: V.int(b.pct, 'pct', 0, 90), until: V.optTime(b.until, 'until'), title: V.optStr(b.title, 'title', 60) || 'Скидка на открытие' };
    await tx(async c => {
      await c.query(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('sale', $1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = $2, updated_by = $3`, [JSON.stringify(next), Date.now(), me.id]);
      await audit(c, me, 'sale', null, next);
    });
    return { sale: P.setSale(next) };
  });

  // промокоды (право plans): { code?, pct, until?, maxUses?, plans?: [id тарифа], note? } — без кода придумаем сами
  app.post('/api/admin/promos', async (req, reply) => {
    const me = needPerm(req, 'plans', 'Промокоды создаёт администратор'), b = req.body || {};
    let code = b.code == null || b.code === '' ? null : V.str(b.code, 'code', 3, 24).trim().toUpperCase();
    if (code && !/^[A-ZА-ЯЁ0-9_-]+$/.test(code)) throw E.bad('Промокод: буквы, цифры, «-» и «_», без пробелов', 'code');
    const pct = V.int(b.pct, 'pct', 1, 90), until = V.optTime(b.until, 'until'), maxUses = b.maxUses == null || b.maxUses === '' ? null : V.int(b.maxUses, 'maxUses', 1, 100000);
    const plans = b.plans == null || (Array.isArray(b.plans) && !b.plans.length) ? null : b.plans;
    if (plans && (!Array.isArray(plans) || plans.some(x => typeof x !== 'string'))) throw E.bad('plans: список id тарифов', 'plans');
    const row = await tx(async c => {
      if (plans && (await all(c, 'SELECT id FROM plans WHERE id = ANY($1)', [plans])).length !== plans.length) throw E.bad('Тариф не найден', 'plans');
      if (!code) for (;;) { code = 'OCHE' + require('node:crypto').randomBytes(3).toString('hex').toUpperCase(); if (!await one(c, 'SELECT 1 FROM promo_codes WHERE code = $1', [code])) break; }
      if (await one(c, 'SELECT 1 FROM promo_codes WHERE code = $1', [code])) throw E.conflict('conflict', 'Такой промокод уже есть');
      const out = await one(c, 'INSERT INTO promo_codes (code, pct, until, max_uses, plans, note, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *', [code, pct, until, maxUses, plans, V.optStr(b.note, 'note', 200), me.id, Date.now()]);
      await audit(c, me, 'promo.create', { id: String(out.id), name: code }, { pct, until, maxUses });
      return out;
    });
    return reply.code(201).send({ promo: promoJSON(row) });
  });
  // { active, pct, until, maxUses, note }
  app.patch('/api/admin/promos/:id', async req => {
    const me = needPerm(req, 'plans', 'Промокоды меняет администратор'), b = req.body || {}, set = {};
    if (b.active !== undefined) set.active = V.bool(b.active, 'active');
    if (b.pct !== undefined) set.pct = V.int(b.pct, 'pct', 1, 90);
    if (b.until !== undefined) set.until = V.optTime(b.until, 'until');
    if (b.maxUses !== undefined) set.max_uses = b.maxUses == null || b.maxUses === '' ? null : V.int(b.maxUses, 'maxUses', 1, 100000);
    if (b.note !== undefined) set.note = V.optStr(b.note, 'note', 200);
    const keys = Object.keys(set);
    if (!keys.length) throw E.bad('Нечего менять');
    const row = await one(pool, `UPDATE promo_codes SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1 RETURNING *`, [+req.params.id || 0, ...keys.map(k => set[k])]);
    if (!row) throw E.notFound('Промокод не найден');
    await audit(pool, me, 'promo.edit', { id: String(row.id), name: row.code }, set);
    return { promo: promoJSON(row) };
  });
  app.delete('/api/admin/promos/:id', async req => {
    const me = needPerm(req, 'plans', 'Промокоды удаляет администратор');
    const row = await one(pool, 'DELETE FROM promo_codes WHERE id = $1 RETURNING *', [+req.params.id || 0]);
    if (!row) throw E.notFound('Промокод не найден');
    await audit(pool, me, 'promo.delete', { id: String(row.id), name: row.code }, null);
    return { ok: true };
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
