const pg = require('pg');
const config = require('./config');

// bigint (время в мс, count) — обычные числа: все значения меньше 2^53
pg.types.setTypeParser(20, v => +v);

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 15, idleTimeoutMillis: 30000 });

// fn(client) в одной транзакции; ошибка — откат
async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const res = await fn(c);
    await c.query('COMMIT');
    return res;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const one = async (c, sql, args) => (await c.query(sql, args)).rows[0] || null;
const all = async (c, sql, args) => (await c.query(sql, args)).rows;

module.exports = { pool, tx, one, all };
