const config = require('./config');
const { pool } = require('./db');
const { build } = require('./app');

const app = build();

app.listen({ port: config.port, host: config.host }).then(addr => {
  console.log('Oche: ' + addr + (config.serveStatic ? ' (страница тоже здесь)' : ''));
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
