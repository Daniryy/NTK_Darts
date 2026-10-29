const config = require('./config');
const { pool, tx } = require('./db');
const { sweepPlans } = require('./plans');
const { clearCache } = require('./auth');
const { build } = require('./app');

const app = build();

app.listen({ port: config.port, host: config.host }).then(addr => {
  console.log('Oche: ' + addr + (config.serveStatic ? ' (страница тоже здесь)' : ''));
  // закончившиеся тарифы: при старте и раз в 10 минут роль возвращается; старые коды, сеансы и журналы убираются
  const sweep = () => tx(async c => {
    const now = Date.now();
    await c.query('DELETE FROM email_codes WHERE expires_at < $1', [now]);
    await c.query('DELETE FROM mail_log WHERE t < $1', [now - 2 * 864e5]);
    // таблицы не растут без конца: истёкшие сеансы и коды, журнал SMS за 2 суток, журнал действий за год
    await c.query('DELETE FROM sessions WHERE expires_at < $1', [now]);
    await c.query('DELETE FROM phone_codes WHERE expires_at < $1', [now]);
    await c.query('DELETE FROM sms_log WHERE t < $1', [now - 2 * 864e5]);
    await c.query('DELETE FROM audit WHERE t < $1', [now - 365 * 864e5]);
    return sweepPlans(c);
  }).then(n => { if (n) { clearCache(); app.log.info({ n }, 'тарифы закончились'); } }).catch(e => app.log.error(e));
  sweep();
  setInterval(sweep, 10 * 6e4).unref();
  // база без UTF-8 или с локалью без кириллицы: поиск по имени без учёта регистра не найдёт «иван» в «Иван»
  pool.query(`SELECT pg_encoding_to_char(encoding) AS enc, datctype, lower('ЁЖ') = 'ёж' AS ok FROM pg_database WHERE datname = current_database()`)
    .then(r => { const d = r.rows[0]; if (d && (d.enc !== 'UTF8' || !d.ok)) app.log.warn(d, 'база: кодировка или локаль не UTF-8 — поиск по русским именам будет с ошибками (см. docs/server.md)'); })
    .catch(() => {});
  // статистика по новым правилам — один раз после обновления
  tx(require('./fixstats').fixStats).then(r => { if (r) app.log.info(r, 'статистика пересчитана'); }).catch(e => app.log.error(e));
}).catch(e => {
  console.error(e);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
