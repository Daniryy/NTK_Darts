// Отправка SMS с кодом входа. SMS_PROVIDER: smsru (SMS_RU_API_ID) или log — код только в журнал (разработка).
const config = require('./config');

async function sendSms(phone, text, log) {
  const s = config.sms;
  if (s.provider === 'log') { log.warn({ phone, text }, 'sms (не отправлено, SMS_PROVIDER=log)'); return; }
  if (s.provider === 'smsru') {
    const q = new URLSearchParams({ api_id: s.smsruId, to: phone.replace(/^\+/, ''), msg: text, json: '1' });
    if (s.from) q.set('from', s.from);
    const res = await fetch('https://sms.ru/sms/send?' + q, { signal: AbortSignal.timeout(10000) });
    const d = await res.json().catch(() => ({}));
    const one = d.sms && Object.values(d.sms)[0];
    if (d.status !== 'OK' || !one || one.status !== 'OK') throw new Error('sms.ru: ' + ((one && one.status_text) || d.status_text || res.status));
    return;
  }
  throw new Error('SMS не настроены');
}

module.exports = { sendSms };
