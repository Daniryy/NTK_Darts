// Двухфакторный вход (TOTP, RFC 6238): код из приложения — Яндекс Ключ, Google Authenticator и т. п.
// Секрет в базе зашифрован ключом от COOKIE_SECRET: копия базы без файла настроек его не выдаёт.
const crypto = require('node:crypto');
const config = require('./config');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', STEP = 30;
function b32enc(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32dec(s) {
  let bits = 0, val = 0;
  const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | B32.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const newSecret = () => b32enc(crypto.randomBytes(20));
function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(msg).digest(), o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// код подходит — номер шага (±1 шаг на расхождение часов), иначе 0; шаг не старше уже принятого (один код — один вход)
function check(secret, code, last, now = Date.now()) {
  const c = String(code == null ? '' : code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return 0;
  const t = Math.floor(now / 1000 / STEP);
  for (const s of [t, t - 1, t + 1]) {
    if (s > (last || 0) && crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(c))) return s;
  }
  return 0;
}
const otpauth = (label, secret) => 'otpauth://totp/' + encodeURIComponent('Oche:' + label) + '?secret=' + secret + '&issuer=Oche&digits=6&period=' + STEP;

// шифрование секрета: AES-256-GCM, ключ из COOKIE_SECRET
const key = () => crypto.createHash('sha256').update(config.cookieSecret + ':totp').digest();
function enc(secret) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map(b => b.toString('base64url')).join('.');
}
function dec(s) {
  const [iv, tag, body] = String(s).split('.').map(x => Buffer.from(x, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

// резервные коды: 8 одноразовых вида abcd-efgh, в базе — хэши
const normBackup = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z2-7]/g, '');
const hashBackup = s => crypto.createHash('sha256').update('oche-2fa:' + normBackup(s)).digest('hex');
function newBackup() {
  const codes = Array.from({ length: 8 }, () => { const s = b32enc(crypto.randomBytes(5)).toLowerCase(); return s.slice(0, 4) + '-' + s.slice(4, 8); });
  return { codes, hashes: codes.map(hashBackup) };
}

module.exports = { newSecret, codeAt, check, otpauth, enc, dec, newBackup, hashBackup, normBackup, STEP };
