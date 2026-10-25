// Код входа по телефону. SMS_PROVIDER: smsru (SMS_RU_API_ID) или log — код только в журнал (разработка).
// SMS_METHOD: call — звонок-сброс (код — последние 4 цифры номера, с которого звонят; в разы дешевле SMS) или sms.
const crypto = require('node:crypto');
const config = require('./config');

const DIGITS = { call: 4, sms: 6 };
const randomCode = n => String(crypto.randomInt(0, 10 ** n)).padStart(n, '0');

async function smsru(path, params) {
  const q = new URLSearchParams(Object.assign({ api_id: config.sms.smsruId, json: '1' }, params));
  const res = await fetch('https://sms.ru' + path + '?' + q, { signal: AbortSignal.timeout(15000) });
  return { res, d: await res.json().catch(() => ({})) };
}

// отправить код: звонком или SMS; ответ — код, который должен ввести игрок
async function sendCode(phone, ip, log) {
  const s = config.sms, method = s.method, to = phone.replace(/^\+/, '');
  if (s.provider === 'log') {
    const code = randomCode(DIGITS[method]);
    log.warn({ phone, code, method }, 'код входа (не отправлен, SMS_PROVIDER=log)');
    return code;
  }
  if (s.provider !== 'smsru') throw new Error('Вход по телефону не настроен');
  if (method === 'call') {
    // sms.ru звонит с номера, последние 4 цифры которого — код, и сообщает его нам
    const { res, d } = await smsru('/code/call', { phone: to, ip: ip || '-1' });
    if (d.status !== 'OK' || !/^\d{4}$/.test(String(d.code))) throw new Error('sms.ru call: ' + (d.status_text || res.status));
    return String(d.code);
  }
  const code = randomCode(DIGITS.sms), params = { to, msg: 'Oche: код входа ' + code + '. Никому его не сообщайте.' };
  if (s.from) params.from = s.from;
  const { res, d } = await smsru('/sms/send', params);
  const one = d.sms && Object.values(d.sms)[0];
  if (d.status !== 'OK' || !one || one.status !== 'OK') throw new Error('sms.ru: ' + ((one && one.status_text) || d.status_text || res.status));
  return code;
}

module.exports = { sendCode, DIGITS };
