// Пароли администраторов: scrypt с солью. Строка в базе: scrypt$N$r$p$соль$хэш (base64).
const crypto = require('node:crypto');

const N = 16384, R = 8, P = 1, LEN = 64;
const scrypt = (pw, salt, n, r, p) => new Promise((ok, fail) => crypto.scrypt(pw, salt, LEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (e, k) => e ? fail(e) : ok(k)));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return ['scrypt', N, R, P, salt.toString('base64'), (await scrypt(pw, salt, N, R, P)).toString('base64')].join('$');
}
async function verifyPassword(pw, stored) {
  const f = String(stored || '').split('$');
  if (f.length !== 6 || f[0] !== 'scrypt') return false;
  const want = Buffer.from(f[5], 'base64'), got = await scrypt(pw, Buffer.from(f[4], 'base64'), +f[1], +f[2], +f[3]);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
// требования: от 10 символов, не только цифры
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Пароль — не короче 10 символов';
  if (pw.length > 200) return 'Пароль слишком длинный';
  if (/^\d+$/.test(pw)) return 'Пароль не может состоять только из цифр';
  return null;
}
const LOGIN_RE = /^[a-z0-9._-]{3,32}$/;
const normLogin = v => String(v == null ? '' : v).trim().toLowerCase();

module.exports = { hashPassword, verifyPassword, passwordProblem, LOGIN_RE, normLogin };
