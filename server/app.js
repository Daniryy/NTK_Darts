const path = require('node:path');
const Fastify = require('fastify');
const config = require('./config');
const { pool } = require('./db');
const { ApiError } = require('./errors');
const auth = require('./auth');

function build(opts = {}) {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: '127.0.0.1', // перед сервером стоит nginx
    bodyLimit: 64 * 1024
  });

  app.register(require('@fastify/cookie'), { secret: config.cookieSecret });
  app.register(require('@fastify/rate-limit'), {
    max: config.rateMax, timeWindow: 2000,
    keyGenerator: req => req.headers['x-device-id'] || req.ip,
    errorResponseBuilder: (req, ctx) => new ApiError(429, 'too_many', 'Слишком много запросов, повторите через ' + Math.ceil(ctx.ttl / 1000) + ' с')
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: Object.assign({ code: err.code, message: err.message }, err.extra) });
    if (err.validation || err.statusCode === 400 || err.statusCode === 415 || err.statusCode === 413) {
      return reply.code(err.statusCode || 400).send({ error: { code: 'bad_request', message: 'Неверный запрос: ' + err.message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'server', message: 'Ошибка сервера' } });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: { code: 'not_found', message: 'Нет такого адреса' } }));

  app.register(async api => {
    auth.hooks(api);
    api.get('/api/health', async () => { await pool.query('SELECT 1'); return { ok: true }; });
    auth.routes(api);
    api.register(require('./routes/players'));
    api.register(require('./routes/tournaments'));
    api.register(require('./routes/matches'));
  });

  if (config.serveStatic) {
    const root = path.join(__dirname, '..');
    app.register(require('@fastify/static'), { root, serve: false });
    app.get('/', (req, reply) => reply.sendFile('index.html'));
    app.get('/index.html', (req, reply) => reply.sendFile('index.html'));
    app.get('/shared/bracket.js', (req, reply) => reply.sendFile('shared/bracket.js'));
  }
  return app;
}

module.exports = { build };
