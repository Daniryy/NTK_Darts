// Тарифы: скидка за подтверждённое звание и роль, которую даёт действующий тариф.
// Роль игрока — из роли, выданной вручную, и действующего тарифа (syncPlanRole).
// Администраторов это не касается: их роль меняет только тех. администратор.
const { all, one } = require('./db');
const { KINDS } = require('./titles');
const { RANK, permsOf } = require('./roles');

// скидка за подтверждённое звание, % — у каждого звания своя (ЗМС в дартсе один на всю Россию, МСМК — 18, МС — 322);
// 1 разряд — без скидки (таких много), но её можно включить в админке
const DEF = { zms: 90, msmk: 70, ms: 40, kms: 10, r1: 0 };
let discounts = Object.assign({}, DEF);
const DISC_KEYS = [['zms', 'ЗМС'], ['msmk', 'МСМК'], ['ms', 'МС'], ['kms', 'КМС'], ['r1', '1 разряд']];
function setDiscounts(v) {
  const out = {};
  DISC_KEYS.forEach(([k]) => { const n = v && Number.isInteger(v[k]) ? v[k] : DEF[k]; out[k] = Math.max(0, Math.min(90, n)); });
  discounts = out;
  return out;
}
const getDiscounts = () => Object.assign({}, discounts);
// скидка по короткому званию из профиля («МС», «КМС», «1 разряд»): { pct, why }
function discountFor(title) {
  const k = (KINDS.find(x => x[1] === title) || [])[0];
  const key = DISC_KEYS.some(x => x[0] === k) ? k : null;
  return key && discounts[key] ? { pct: discounts[key], why: 'звание ' + title } : { pct: 0, why: '' };
}
const priceWith = (price, pct) => Math.round(price * (100 - pct) / 100);

// скидка на открытие: { pct, until, title } — общая на все тарифы, пока не кончился срок
let sale = { pct: 0, until: null, title: 'Скидка на открытие' };
function setSale(v) {
  const o = v || {};
  sale = { pct: Number.isInteger(o.pct) ? Math.max(0, Math.min(90, o.pct)) : 0, until: Number.isFinite(o.until) ? o.until : null, title: typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 60) : 'Скидка на открытие' };
  return getSale();
}
const getSale = () => Object.assign({}, sale);
const saleNow = now => sale.pct > 0 && (sale.until == null || sale.until > (now || Date.now())) ? sale : null;
// красивая цена со скидкой: до тысячи — на …9 (124,5 → 119, 399,5 → 399), от тысячи — на …90 (1245 → 1190, 3995 → 3990)
function nicePrice(v) {
  if (v < 10) return Math.max(0, Math.round(v));
  if (v < 1000) return Math.floor((v + 1) / 10) * 10 - 1;
  return Math.floor((v + 10) / 100) * 100 - 10;
}
// цена тарифа для игрока: из скидки на открытие и скидки за звание — выгоднейшая (не складываются), промокод — сверху.
// Ответ { price, base, pct (итоговая скидка от base), why }
function priceFor(plan, title, year, promo, now) {
  const base = year ? plan.year_price : plan.price, t = discountFor(title || ''), s = saleNow(now);
  const byTitle = priceWith(base, t.pct), bySale = s ? Math.min(base, nicePrice(base * (100 - s.pct) / 100)) : base;
  let price = byTitle, why = t.why;
  if (s && bySale <= byTitle) { price = bySale; why = s.title.toLowerCase(); }
  if (promo) { price = priceWith(price, promo.pct); why = (why ? why + ' + ' : '') + 'промокод ' + promo.code; }
  return { price, base, pct: base ? Math.round((1 - price / base) * 100) : 0, why };
}

// выставить роль игрока по тарифам (кроме администраторов). Клуб роль не даёт: инструменты ведущего — по тарифу.
// Основа — роль, выданная вручную (base_role); тариф её повышает,
// а роль того же ранга (например «Игрок+» у ведущего) не заменяет: ведущий остаётся ведущим.
async function syncPlanRole(c, pid) {
  const p = await one(c, 'SELECT id, role, base_role FROM players WHERE id = $1 FOR UPDATE', [pid]);
  if (!p || (RANK[p.role] || 0) >= RANK.admin) return p && p.role;
  // из нескольких действующих тарифов — роль старше, при равном ранге — с большим числом прав
  // (Pro и «Ведущий» сразу — ведущий, сколько бы ни оставалось Pro)
  const score = r => (RANK[r] || 0) * 1000 + permsOf({ role: r }).length;
  const act = (await all(c, `SELECT DISTINCT pl.role FROM player_plans pp JOIN plans pl ON pl.id = pp.plan_id
    WHERE pp.player_id = $1 AND pp.status = 'active' AND pp.ends > $2`, [pid, Date.now()])).sort((a, b) => score(b.role) - score(a.role))[0];
  const base = p.base_role && (RANK[p.base_role] || 0) < RANK.admin ? p.base_role : 'player';
  const want = act && ((RANK[act.role] || 0) > (RANK[base] || 0) || base === 'player') ? act.role : base;
  if (want !== p.role) await c.query('UPDATE players SET role = $2 WHERE id = $1', [pid, want]);
  return want;
}
// закончившиеся тарифы: статус ended и роль по оставшимся; возвращает число закрытых
async function sweepPlans(c) {
  const done = await all(c, `UPDATE player_plans SET status = 'ended' WHERE status = 'active' AND ends <= $1 RETURNING player_id`, [Date.now()]);
  for (const pid of new Set(done.map(x => x.player_id))) await syncPlanRole(c, pid);
  return done.length;
}

module.exports = { DISC_KEYS, setDiscounts, getDiscounts, discountFor, priceWith, setSale, getSale, saleNow, nicePrice, priceFor, syncPlanRole, sweepPlans };
