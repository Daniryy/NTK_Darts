// Роли: все видят список (названия для значков); тех. администратор добавляет, переименовывает и удаляет свои.
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer } = require('../auth');
const { audit, loadSettings } = require('../audit');

const needTech = req => { const me = needPlayer(req); if (me.role !== 'tech' || me.blocked) throw E.forbidden('Это может только тех. администратор'); return me; };

module.exports = async function (app) {
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
      await c.query('DELETE FROM roles WHERE key = $1', [r.key]);
      await audit(c, me, 'role.delete', { id: r.key, name: r.name }, null);
    });
    await loadSettings();
    return { ok: true };
  });
};
