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

  // пустое тело с Content-Type: application/json (так шлют DELETE многие клиенты) — не ошибка
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (body === '') return done(null, undefined);
    try { done(null, JSON.parse(body)); } catch (e) { e.statusCode = 400; done(e); }
  });

  app.register(require('@fastify/cookie'), { secret: config.cookieSecret });
  app.register(require('@fastify/rate-limit'), {
    max: config.rateMax, timeWindow: 2000,
    // устройство из заголовка; поток табло (EventSource не шлёт заголовки) — из ?d=; иначе IP.
    // По IP нельзя: в зале все телефоны в одном Wi-Fi выходят с одного адреса.
    keyGenerator: req => {
      const d = req.headers['x-device-id'] || (req.query && req.query.d);
      return typeof d === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(d) ? d : req.ip;
    },
    errorResponseBuilder: (req, ctx) => new ApiError(429, 'too_many', 'Слишком много запросов, повторите через ' + Math.ceil(ctx.ttl / 1000) + ' с')
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError && err.extra && err.extra.retryAfter) reply.header('Retry-After', String(err.extra.retryAfter));
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
    api.register(require('./routes/live'));
    api.register(require('./routes/photos'));
    api.register(require('./routes/admin'));
    api.register(require('./routes/clubs'));
    api.register(require('./routes/host'));
    api.register(require('./routes/banners'));
  });

  if (config.serveStatic) {
    const root = path.join(__dirname, '..');
    app.register(require('@fastify/static'), { root, serve: false });
    app.get('/', (req, reply) => reply.sendFile('index.html'));
    app.get('/index.html', (req, reply) => reply.sendFile('index.html'));
    app.get('/shared/bracket.js', (req, reply) => reply.sendFile('shared/bracket.js'));
    app.get('/shared/games.js', (req, reply) => reply.sendFile('shared/games.js'));
    app.get('/api.js', (req, reply) => reply.sendFile('api.js'));
    app.get('/vendor/qrcode.js', (req, reply) => reply.sendFile('vendor/qrcode.js'));
    app.get('/sw.js', (req, reply) => reply.sendFile('sw.js'));
    app.get('/manifest.webmanifest', (req, reply) => reply.type('application/manifest+json').sendFile('manifest.webmanifest'));
    app.get('/icons/:f', (req, reply) => /^[\w-]+\.png$/.test(req.params.f) ? reply.sendFile('icons/' + req.params.f) : reply.code(404).send());
    app.register(require('@fastify/static'), { root: config.uploadDir, prefix: '/uploads/', decorateReply: false });
  }
  return app;
}

module.exports = { build };
