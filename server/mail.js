// Письма с кодами. SMTP — любой почтовый ящик (Яндекс, Mail.ru) с паролем приложения; log — код только в журнал (разработка).
const nodemailer = require('nodemailer');
const config = require('./config');

let transport = null;
const mailOn = () => config.mail.provider === 'log' || (config.mail.provider === 'smtp' && !!config.mail.user && !!config.mail.pass);
function smtp() {
  const m = config.mail;
  if (!transport) transport = nodemailer.createTransport({
    host: m.host, port: m.port, secure: m.port === 465, auth: { user: m.user, pass: m.pass },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000
  });
  return transport;
}
const fromAddr = () => ({ name: 'Oche', address: config.mail.from });

// отправить письмо; ошибка SMTP — исключение (вызывающий отвечает 502)
async function sendMail(to, subject, text, log) {
  if (config.mail.provider === 'log') { log.warn({ to, subject, text }, 'письмо (не отправлено, SMTP не настроен)'); return; }
  if (!mailOn()) throw new Error('Почта не настроена');
  await smtp().sendMail({ from: fromAddr(), to, subject, text });
}
// проверка настроек: соединение и вход на SMTP-сервер
const verifyMail = () => smtp().verify();

module.exports = { mailOn, sendMail, verifyMail };
