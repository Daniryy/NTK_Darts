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
  // загруженные фото; на VPS — /srv/oche/uploads (nginx отдаёт их по /uploads/)
  uploadDir: env.UPLOAD_DIR || (prod ? '/srv/oche/uploads' : require('node:path').join(__dirname, '..', 'uploads')),
  // документы заявок на звания: закрытая папка, nginx её не отдаёт; на VPS — /srv/oche/private
  privateDir: env.PRIVATE_DIR || (prod ? '/srv/oche/private' : require('node:path').join(__dirname, '..', 'uploads-private')),
  vk: { appId: env.VK_APP_ID || '', domain: env.VK_DOMAIN || 'id.vk.ru' },
  // вход по телефону: SMS_PROVIDER=smsru и SMS_RU_API_ID; в разработке по умолчанию log — код пишется в журнал
  sms: {
    provider: env.SMS_PROVIDER || (prod ? '' : 'log'),
    method: env.SMS_METHOD === 'sms' ? 'sms' : 'call', // call — звонок-сброс (дешевле), sms — код в SMS
    smsruId: env.SMS_RU_API_ID || '',
    from: env.SMS_FROM || '',
    dayMax: +env.SMS_DAY_MAX || 300 // SMS за сутки на весь сервер: защита от счёта за рассылку
  },
  rateMax: +env.RATE_MAX || 20, // запросов за 2 с с одного устройства
  logLevel: env.LOG_LEVEL || (prod ? 'info' : 'warn')
};
