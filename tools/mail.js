// Проверка почты: node tools/mail.js you@mail.ru — соединение с SMTP, вход, тестовое письмо.
// Подсказывает, что делать, если порт закрыт хостингом или пароль не подходит.
const config = require('../server/config');
const { verifyMail, sendMail } = require('../server/mail');
const net = require('node:net');

const m = config.mail, to = process.argv[2];
if (!to || !/@/.test(to)) { console.log('Укажите адрес: node tools/mail.js you@mail.ru'); process.exit(1); }
if (m.provider !== 'smtp') { console.log('SMTP не настроен: задайте SMTP_HOST, SMTP_USER, SMTP_PASS (deploy/set.sh)'); process.exit(1); }
if (!m.user || !m.pass) { console.log('Не хватает SMTP_USER или SMTP_PASS'); process.exit(1); }

// открыт ли порт: хостинги иногда закрывают исходящую почту
const port = (p) => new Promise(ok => {
  const s = net.connect({ host: m.host, port: p, timeout: 6000 });
  s.on('connect', () => { s.destroy(); ok(true); });
  s.on('timeout', () => { s.destroy(); ok(false); });
  s.on('error', () => ok(false));
});
(async () => {
  console.log('SMTP: ' + m.host + ':' + m.port + ', вход ' + m.user + ', от имени ' + m.from);
  const open = {};
  for (const p of [...new Set([m.port, 465, 587])]) { open[p] = await port(p); console.log('  порт ' + p + ': ' + (open[p] ? 'открыт' : 'закрыт или недоступен')); }
  if (!open[m.port]) {
    const alt = [465, 587].find(p => p !== m.port && open[p]);
    console.log(alt ? 'Порт ' + m.port + ' закрыт, а ' + alt + ' открыт — задайте: bash /srv/oche/app/deploy/set.sh SMTP_PORT=' + alt : 'Порты почты закрыты: хостинг не пускает почту наружу. Напишите в поддержку хостинга — попросите открыть исходящие порты 465 и 587.');
    process.exit(1);
  }
  try { await verifyMail(); console.log('Вход на SMTP: успешно'); }
  catch (e) {
    console.log('Вход на SMTP не удался: ' + e.message);
    if (/auth|535|534|Invalid login|password/i.test(e.message)) console.log('Похоже, неверный пароль. Для Яндекса и Mail.ru нужен пароль приложения (не обычный пароль от почты), а в настройках ящика должен быть разрешён доступ по протоколу IMAP/SMTP.');
    process.exit(1);
  }
  await sendMail(to, 'Oche: проверка почты', 'Если вы видите это письмо — почта на сервере Oche настроена правильно.\n\n' + config.publicUrl + '/', console);
  console.log('Тестовое письмо отправлено на ' + to + ' — проверьте входящие и «Спам».');
  process.exit(0);
})().catch(e => { console.log('Ошибка: ' + e.message); process.exit(1); });
