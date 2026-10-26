const config = require('./config');
const { pool, tx } = require('./db');
const { sweepPlans } = require('./plans');
const { clearCache } = require('./auth');
const { build } = require('./app');

const app = build();

app.listen({ port: config.port, host: config.host }).then(addr => {
  console.log('Oche: ' + addr + (config.serveStatic ? ' (страница тоже здесь)' : ''));
  // закончившиеся тарифы: при старте и раз в 10 минут роль возвращается
  const sweep = () => tx(sweepPlans).then(n => { if (n) { clearCache(); app.log.info({ n }, 'тарифы закончились'); } }).catch(e => app.log.error(e));
  sweep();
  setInterval(sweep, 10 * 6e4).unref();
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
