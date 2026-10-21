// Применяет новые файлы из db/migrations по порядку, каждый в своей транзакции.
const fs = require('node:fs');
const path = require('node:path');
const { pool, tx } = require('../server/db');

async function migrate(log = console.log) {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at bigint NOT NULL)');
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(r => r.name));
  const dir = path.join(__dirname, 'migrations');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    await tx(async c => {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name, applied_at) VALUES ($1, $2)', [f, Date.now()]);
    });
    log('применена ' + f);
  }
}

if (require.main === module) {
  migrate().then(() => pool.end()).catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { migrate };
