// Логины и пароли администраторов — только с сервера (нужен доступ по SSH).
//   npm run admin -- list                                   — кто может входить по паролю
//   npm run admin -- new "Имя Фамилия" --login danil        — новый тех. администратор
//   npm run admin -- set OCH-1234 --login danil [--role tech|admin] — дать логин существующему игроку
//   npm run admin -- password danil                         — сменить пароль
//   npm run admin -- unlock danil                           — снять блокировку после неверных паролей
//   npm run admin -- off danil                              — убрать вход по паролю
//   npm run admin -- 2fa-off danil                          — сбросить двухфакторный вход (потерян телефон): при входе — привязка заново
// Пароль спрашивается без показа на экране (или из переменной ADMIN_PASSWORD, если запуск не в терминале).
const { pool, tx, one, all } = require('../server/db');
const { migrate } = require('../db/migrate');
const { createPlayer } = require('../server/players');
const { hashPassword, passwordProblem, LOGIN_RE, normLogin } = require('../server/password');
const { audit } = require('../server/audit');

const argv = process.argv.slice(2), cmd = argv[0];
const opt = k => { const i = argv.indexOf('--' + k); return i > 0 ? argv[i + 1] : null; };
const fail = msg => { console.error('Ошибка: ' + msg); process.exit(1); };

function ask(q, hidden) {
  if (!process.stdin.isTTY) {
    if (hidden && process.env.ADMIN_PASSWORD) return Promise.resolve(process.env.ADMIN_PASSWORD);
    fail('запустите в терминале или передайте ADMIN_PASSWORD');
  }
  return new Promise(ok => {
    process.stdout.write(q);
    const stdin = process.stdin;
    let s = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = ch => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', on); process.stdout.write('\n'); ok(s); }
      else if (ch === '\u0003') process.exit(130);
      else if (ch === '\u007f' || ch === '\b') s = s.slice(0, -1);
      else { s += ch; if (!hidden) process.stdout.write(ch); }
    };
    stdin.on('data', on);
  });
}
async function newPassword() {
  const a = await ask('Пароль (от 10 символов): ', true);
  const bad = passwordProblem(a);
  if (bad) fail(bad);
  if (process.stdin.isTTY && await ask('Повторите пароль: ', true) !== a) fail('пароли не совпали');
  return hashPassword(a);
}
const who = p => p.name + ' (' + p.code + ', ' + p.role + (p.login ? ', логин ' + p.login : '') + ')';

(async () => {
  await migrate(() => {});
  if (cmd === 'list') {
    const rows = await all(pool, `SELECT * FROM players WHERE role IN ('admin', 'tech') ORDER BY role DESC, name`);
    if (!rows.length) console.log('Администраторов нет.');
    rows.forEach(p => console.log((p.login && p.pass_hash ? '[пароль] ' : '[без пароля] ') + (p.totp_on ? '[2FA] ' : '[без 2FA] ') + who(p) + (p.pass_lock_until > Date.now() ? ' — заблокирован до ' + new Date(+p.pass_lock_until).toLocaleTimeString('ru-RU') : '')));
  } else if (cmd === 'new' || cmd === 'set') {
    const login = normLogin(opt('login')), role = opt('role') || 'tech';
    if (!LOGIN_RE.test(login)) fail('--login: 3–32 символа, латиница, цифры, точка, дефис, подчёркивание');
    if (!['admin', 'tech'].includes(role)) fail('--role: admin или tech');
    const hash = await newPassword();
    const p = await tx(async c => {
      if (await one(c, 'SELECT 1 FROM players WHERE login = $1', [login])) fail('логин ' + login + ' уже занят');
      let t;
      if (cmd === 'new') {
        const name = argv[1];
        if (!name || name.startsWith('--') || name.length < 2) fail('укажите имя: npm run admin -- new "Имя Фамилия" --login …');
        t = await createPlayer(c, { name });
      } else {
        const key = String(argv[1] || '');
        t = await one(c, 'SELECT * FROM players WHERE id = $1 OR upper(code) = upper($1) OR upper(code) = upper($2)', [key, 'OCH-' + key.replace(/^#/, '')]);
        if (!t) fail('игрок ' + key + ' не найден (нужен ID из профиля, например OCH-1234)');
      }
      const out = await one(c, 'UPDATE players SET role = $2, login = $3, pass_hash = $4, pass_fails = 0, pass_lock_until = NULL, blocked = false WHERE id = $1 RETURNING *', [t.id, role, login, hash]);
      await audit(c, null, 'cli.login', out, { login, role });
      return out;
    });
    console.log('Готово: ' + who(p) + '. Вход: страница /#admin, логин ' + login + ', затем код из Google Authenticator (привязка при первом входе).');
  } else if (cmd === 'password' || cmd === 'unlock' || cmd === 'off' || cmd === '2fa-off') {
    const login = normLogin(argv[1]);
    const p = await one(pool, 'SELECT * FROM players WHERE login = $1', [login]);
    if (!p) fail('логина ' + login + ' нет');
    if (cmd === 'password') await pool.query('UPDATE players SET pass_hash = $2, pass_fails = 0, pass_lock_until = NULL WHERE id = $1', [p.id, await newPassword()]);
    if (cmd === 'unlock') await pool.query('UPDATE players SET pass_fails = 0, pass_lock_until = NULL WHERE id = $1', [p.id]);
    if (cmd === 'off') { await pool.query('UPDATE players SET login = NULL, pass_hash = CASE WHEN email IS NULL THEN NULL ELSE pass_hash END WHERE id = $1', [p.id]); await pool.query('DELETE FROM sessions WHERE player_id = $1', [p.id]); }
    if (cmd === '2fa-off') { await pool.query(`UPDATE players SET totp_on = false, totp_secret = NULL, totp_last = NULL, totp_backup = '[]' WHERE id = $1`, [p.id]); await pool.query('DELETE FROM sessions WHERE player_id = $1', [p.id]); }
    await audit(pool, null, 'cli.' + cmd, p, { login });
    console.log('Готово: ' + who(p) + ' — ' + { password: 'пароль изменён', unlock: 'блокировка снята', off: 'вход по паролю убран, сеансы закрыты', '2fa-off': 'двухфакторный вход сброшен, сеансы закрыты — при входе привяжите приложение заново' }[cmd] + '.');
  } else {
    console.log(require('node:fs').readFileSync(__filename, 'utf8').split('\n').slice(0, 9).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  }
  await pool.end();
})().catch(e => { console.error(e.message); process.exit(1); });
