// Журнал действий: кто (actor), что (action), с кем (target: игрок, клуб, баннер…), подробности (data).
// Настройки сервера: права ролей — грузятся при старте и после изменения.
const { pool } = require('./db');
const { setPerms } = require('./roles');

async function audit(c, me, action, target, data) {
  await c.query('INSERT INTO audit (t, actor_id, actor_name, action, target, target_name, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [Date.now(), me ? me.id : null, me ? me.name : '', action, target ? target.id : null, target ? target.name || '' : null, data == null ? null : JSON.stringify(data)]);
}

async function loadSettings(c) {
  const r = await (c || pool).query(`SELECT value FROM settings WHERE key = 'perms'`);
  setPerms(r.rows[0] ? r.rows[0].value : {});
}

module.exports = { audit, loadSettings };
