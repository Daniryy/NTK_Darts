const env = process.env;
const prod = env.NODE_ENV === 'production';

if (prod && !env.COOKIE_SECRET) throw new Error('COOKIE_SECRET не задан');

module.exports = {
  prod,
  port: +env.PORT || 3000,
  host: env.HOST || '127.0.0.1',
  databaseUrl: env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/oche',
  cookieSecret: env.COOKIE_SECRET || 'dev-only-cookie-secret-change-me-0123456789',
  // адрес сайта снаружи: нужен для возврата из VK и флага Secure у cookie
  publicUrl: (env.PUBLIC_URL || 'http://localhost:' + (+env.PORT || 3000)).replace(/\/$/, ''),
  // в разработке сервер сам отдаёт index.html и shared/; на VPS это делает nginx
  serveStatic: env.SERVE_STATIC ? env.SERVE_STATIC === '1' : !prod,
  devLogin: !prod && env.DEV_LOGIN !== '0',
  vk: { appId: env.VK_APP_ID || '', domain: env.VK_DOMAIN || 'id.vk.ru' },
  rateMax: +env.RATE_MAX || 20, // запросов за 2 с с одного устройства
  logLevel: env.LOG_LEVEL || (prod ? 'info' : 'warn')
};
