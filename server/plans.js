// Тарифы: скидка за подтверждённое звание и роль, которую даёт действующий тариф.
// Роль игрока = роль действующего тарифа; нет тарифа — ведущий, если он ведёт открытый клуб, иначе игрок.
// Администраторов это не касается: их роль меняет только тех. администратор.
const { all, one } = require('./db');
const { KINDS } = require('./titles');
const { RANK } = require('./roles');

// скидка, %: ms — МС и выше (МС, МСМК, ЗМС), kms — КМС, r1 — 1 разряд
let discounts = { ms: 25, kms: 10, r1: 5 };
const DISC_KEYS = [['ms', 'МС и выше (МС, МСМК, ЗМС)'], ['kms', 'КМС'], ['r1', '1 разряд']];
function setDiscounts(v) {
  const out = {};
  DISC_KEYS.forEach(([k]) => { const n = v && Number.isInteger(v[k]) ? v[k] : 0; out[k] = Math.max(0, Math.min(90, n)); });
  discounts = out;
  return out;
}
const getDiscounts = () => Object.assign({}, discounts);
// скидка по короткому званию из профиля («МС», «КМС», «1 разряд»): { pct, why }
function discountFor(title) {
  const k = (KINDS.find(x => x[1] === title) || [])[0];
  const key = k === 'zms' || k === 'msmk' || k === 'ms' ? 'ms' : k === 'kms' ? 'kms' : k === 'r1' ? 'r1' : null;
  return key && discounts[key] ? { pct: discounts[key], why: 'звание ' + title } : { pct: 0, why: '' };
}
const priceWith = (price, pct) => Math.round(price * (100 - pct) / 100);

// выставить роль игрока по тарифам и клубам (кроме администраторов)
async function syncPlanRole(c, pid) {
  const p = await one(c, 'SELECT id, role FROM players WHERE id = $1 FOR UPDATE', [pid]);
  if (!p || (RANK[p.role] || 0) >= RANK.admin) return p && p.role;
  const act = await one(c, `SELECT pl.role FROM player_plans pp JOIN plans pl ON pl.id = pp.plan_id
    WHERE pp.player_id = $1 AND pp.status = 'active' AND pp.ends > $2 ORDER BY pp.ends DESC LIMIT 1`, [pid, Date.now()]);
  const club = await one(c, `SELECT 1 FROM club_hosts h JOIN clubs c ON c.id = h.club_id WHERE h.player_id = $1 AND c.status = 'active'`, [pid]);
  // ведущий по клубу сильнее роли тарифа «Игрок+»; две роли тарифов — берётся самая поздняя
  const want = act && !(club && act.role !== 'host' && (RANK[act.role] || 0) <= RANK.host) ? act.role : club ? 'host' : 'player';
  if (want !== p.role) await c.query('UPDATE players SET role = $2 WHERE id = $1', [pid, want]);
  return want;
}
// закончившиеся тарифы: статус ended и роль по оставшимся; возвращает число закрытых
async function sweepPlans(c) {
  const done = await all(c, `UPDATE player_plans SET status = 'ended' WHERE status = 'active' AND ends <= $1 RETURNING player_id`, [Date.now()]);
  for (const pid of new Set(done.map(x => x.player_id))) await syncPlanRole(c, pid);
  return done.length;
}

module.exports = { DISC_KEYS, setDiscounts, getDiscounts, discountFor, priceWith, syncPlanRole, sweepPlans };
