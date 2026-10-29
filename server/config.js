const env = process.env;
const prod = env.NODE_ENV === 'production';

if (prod && !env.COOKIE_SECRET) throw new Error('COOKIE_SECRET не задан');
// демо-сервер (DEMO=1): та же программа с отдельной базой демо-данных — вход «как любой игрок», данные сбрасываются каждую ночь
const demo = env.DEMO === '1';

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
  demo,
  devLogin: demo || (!prod && env.DEV_LOGIN !== '0'),
  // cookie сеанса: у демо своя, чтобы вход в демо не путался с настоящим
  sidName: demo ? 'oche_demo_sid' : 'oche_sid',
  // адрес загруженных фото: у демо — /demo/uploads/
  uploadUrl: env.UPLOAD_URL || '/uploads/',
  // загруженные фото; на VPS — /srv/oche/uploads (nginx отдаёт их по /uploads/)
  uploadDir: env.UPLOAD_DIR || (prod ? '/srv/oche/uploads' : require('node:path').join(__dirname, '..', 'uploads')),
  // документы заявок на звания: закрытая папка, nginx её не отдаёт; на VPS — /srv/oche/private
  privateDir: env.PRIVATE_DIR || (prod ? '/srv/oche/private' : require('node:path').join(__dirname, '..', 'uploads-private')),
  // почта для вопросов о личных данных — показывается на странице политики
  contact: env.CONTACT_EMAIL || '',
  vk: { appId: env.VK_APP_ID || '', domain: env.VK_DOMAIN || 'id.vk.ru' },
  // вход по телефону: SMS_PROVIDER=smsru и SMS_RU_API_ID; в разработке по умолчанию log — код пишется в журнал
  sms: {
    provider: env.SMS_PROVIDER || (prod ? '' : 'log'),
    method: env.SMS_METHOD === 'sms' ? 'sms' : 'call', // call — звонок-сброс (дешевле), sms — код в SMS
    smsruId: env.SMS_RU_API_ID || '',
    from: env.SMS_FROM || '',
    dayMax: +env.SMS_DAY_MAX || 300 // SMS за сутки на весь сервер: защита от счёта за рассылку
  },
  // письма с кодами: SMTP_HOST, SMTP_PORT (465 — SSL, 587 — STARTTLS), SMTP_USER, SMTP_PASS, MAIL_FROM;
  // без SMTP_HOST в разработке — log (код пишется в журнал и приходит в ответе)
  mail: {
    provider: env.SMTP_HOST ? 'smtp' : (prod ? '' : 'log'),
    host: env.SMTP_HOST || '',
    port: +env.SMTP_PORT || 465,
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || env.SMTP_USER || '',
    dayMax: +env.MAIL_DAY_MAX || 500 // писем за сутки на весь сервер
  },
  rateMax: +env.RATE_MAX || 20, // запросов за 2 с с одного устройства
  logLevel: env.LOG_LEVEL || (prod ? 'info' : 'warn')
};
