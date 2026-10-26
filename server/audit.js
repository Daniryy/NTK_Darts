// Журнал действий: кто (actor), что (action), с кем (target: игрок, клуб, баннер…), подробности (data).
// Настройки сервера: права ролей — грузятся при старте и после изменения.
const { pool } = require('./db');
const { setPerms, setRoles } = require('./roles');

async function audit(c, me, action, target, data) {
  await c.query('INSERT INTO audit (t, actor_id, actor_name, action, target, target_name, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [Date.now(), me ? me.id : null, me ? me.name : '', action, target ? target.id : null, target ? target.name || '' : null, data == null ? null : JSON.stringify(data)]);
}

// роли, права ролей и скидки — при старте и после изменения
async function loadSettings(c) {
  c = c || pool;
  setRoles((await c.query('SELECT key, name, rank FROM roles')).rows);
  const st = Object.fromEntries((await c.query(`SELECT key, value FROM settings WHERE key IN ('perms', 'discounts')`)).rows.map(r => [r.key, r.value]));
  setPerms(st.perms || {});
  require('./plans').setDiscounts(st.discounts || {});
}

module.exports = { audit, loadSettings };
