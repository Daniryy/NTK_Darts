// Вход по почте и паролю для всех игроков: регистрация с кодом из письма, привязка почты к аккаунту,
// новый пароль по письму. Почта не настроена (нет SMTP) — регистрация сразу, адрес остаётся неподтверждённым.
const crypto = require('node:crypto');
const config = require('./config');
const { pool, tx, one } = require('./db');
const { E, V, ApiError } = require('./errors');
const { atLeast } = require('./roles');
const { hashPassword, verifyPassword, passwordProblem } = require('./password');
const { mailOn, sendMail } = require('./mail');
const { createPlayer } = require('./players');
const { audit } = require('./audit');
const A = require('./auth');

const MAIL_GAP = 60e3, CODE_TTL = 30 * 6e4, TRIES = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function normEmail(v) {
  const e = String(v == null ? '' : v).trim().toLowerCase();
  if (e.length > 120 || !EMAIL_RE.test(e)) throw E.bad('Почта, например name@mail.ru', 'email');
  return e;
}
// пароль игрока: от 8 символов, не только цифры (администраторам — от 10, см. password.js)
function playerPassProblem(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Пароль — не короче 8 символов';
  if (pw.length > 200) return 'Пароль слишком длинный';
  if (/^\d+$/.test(pw)) return 'Пароль не может состоять только из цифр';
  return null;
}
const needPass = pw => { const bad = playerPassProblem(pw); if (bad) throw E.bad(bad, 'password'); return pw; };
const codeHash = (email, purpose, code) => A.sha(email + ':' + purpose + ':' + code);
const SUBJ = { reg: 'код для регистрации', link: 'код подтверждения почты', reset: 'код для нового пароля' };
const WHY = { reg: 'регистрации в Oche', link: 'подтверждения почты в Oche', reset: 'нового пароля в Oche' };

// письмо с кодом: лимиты — раз в минуту и 5 в час на адрес, 10 в час с устройства, MAIL_DAY_MAX в сутки на сервер
async function sendCode(req, email, purpose, extra) {
  const now = Date.now();
  await tx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['mail:' + email]);
    const last = await one(c, 'SELECT max(t) AS t FROM mail_log WHERE email = $1', [email]);
    if (last.t && now - last.t < MAIL_GAP) { const sec = Math.ceil((MAIL_GAP - (now - last.t)) / 1000); throw A.tooMany(sec, 'Письмо уже отправлено — новое можно запросить через ' + sec + ' с'); }
    const n = async (where, args) => (await one(c, 'SELECT count(*)::int AS n FROM mail_log WHERE ' + where, args)).n;
    if (await n('email = $1 AND t > $2', [email, now - 36e5]) >= 5) throw A.tooMany(600, 'На эту почту уже отправлено 5 писем за час — попробуйте позже');
    if (req.device && await n('device_id = $1 AND t > $2', [req.device, now - 36e5]) >= 10) throw A.tooMany(600, 'С этого устройства запрошено слишком много писем — попробуйте позже');
    if (await n('t > $1', [now - 864e5]) >= config.mail.dayMax) throw new ApiError(503, 'mail_limit', 'Письма временно не отправляются — попробуйте завтра');
    await c.query('INSERT INTO mail_log (email, device_id, t) VALUES ($1, $2, $3)', [email, req.device, now]);
  });
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  try {
    await sendMail(email, 'Oche: ' + SUBJ[purpose] + ' ' + code,
      'Ваш код для ' + WHY[purpose] + ': ' + code + '\n\nКод действует 30 минут. Никому его не сообщайте.\nЕсли вы ничего не запрашивали — просто удалите это письмо.\n\n' + config.publicUrl + '/', req.log);
  } catch (e) {
    req.log.error({ err: e.message }, 'mail failed');
    throw new ApiError(502, 'mail_failed', 'Не удалось отправить письмо — проверьте адрес или попробуйте позже');
  }
  await pool.query(`INSERT INTO email_codes (email, purpose, code_hash, expires_at, tries, sent_at, player_id, data) VALUES ($1, $2, $3, $4, 0, $5, $6, $7)
    ON CONFLICT (email, purpose) DO UPDATE SET code_hash = $3, expires_at = $4, tries = 0, sent_at = $5, player_id = $6, data = $7`,
  [email, purpose, codeHash(email, purpose, code), now + CODE_TTL, now, (extra && extra.player) || null, extra && extra.data ? JSON.stringify(extra.data) : null]);
  // в разработке письма не уходят: код возвращается в ответе
  return Object.assign({ ok: true, sent: true, wait: MAIL_GAP / 1000 }, config.mail.provider === 'log' && !config.prod ? { devCode: code } : {});
}
// проверить код: попытка считается сразу (неверный код не откатывает счётчик); ответ — строка кода
async function takeCode(email, purpose, code) {
  code = String(code == null ? '' : code).replace(/\D/g, '');
  if (code.length !== 6) throw E.bad('Код — 6 цифр из письма', 'code');
  const row = await one(pool, 'UPDATE email_codes SET tries = tries + 1 WHERE email = $1 AND purpose = $2 AND expires_at > $3 AND tries < $4 RETURNING *', [email, purpose, Date.now(), TRIES]);
  if (!row) throw E.conflict('code_expired', 'Код устарел или кончились попытки — запросите новый');
  if (!crypto.timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(codeHash(email, purpose, code)))) throw E.conflict('bad_code', 'Неверный код');
  return row;
}
const taken = () => E.conflict('email_taken', 'Эта почта уже зарегистрирована — войдите или восстановите пароль');
const sessionMs = p => atLeast(p, 'admin') ? A.PASS_SESSION : A.SESSION_MS;

module.exports = function routes(app) {
  // регистрация: { name, city?, email, password } → письмо с кодом (шаг 2 — /api/auth/email/verify с purpose reg).
  // Почта на сервере не настроена — аккаунт сразу, адрес неподтверждённый.
  app.post('/api/auth/register', async (req, reply) => {
    const b = req.body || {}, name = V.str(b.name, 'name', 2, 32), city = V.optStr(b.city, 'city', 40), email = normEmail(b.email), pw = needPass(b.password);
    A.ipLimit(req, 'reg', 20, 36e5);
    if (await one(pool, 'SELECT 1 FROM players WHERE email = $1', [email])) throw taken();
    const pass = await hashPassword(pw);
    if (mailOn()) return sendCode(req, email, 'reg', { data: { name, city, pass } });
    const p = await tx(async c => {
      if (await one(c, 'SELECT 1 FROM players WHERE email = $1 FOR UPDATE', [email])) throw taken();
      const t = await createPlayer(c, { name, city });
      await c.query('UPDATE players SET email = $2, pass_hash = $3 WHERE id = $1', [t.id, email, pass]);
      await A.startSession(reply, c, t.id, req.device);
      return one(c, 'SELECT * FROM players WHERE id = $1', [t.id]);
    });
    return Object.assign(await A.meResp(pool, p), { created: true });
  });

  // письмо с кодом: { email, purpose: link | reset }. link — привязать почту к своему аккаунту (нужен вход);
  // reset — новый пароль: письмо уходит, только если такая почта есть, но ответ одинаковый (не выдаёт, есть ли аккаунт)
  app.post('/api/auth/email/send', async req => {
    const b = req.body || {}, purpose = V.oneOf(b.purpose, 'purpose', ['link', 'reset']), email = normEmail(b.email);
    if (!mailOn()) throw E.notFound('Письма на сервере не настроены — обратитесь к администратору');
    A.ipLimit(req, 'mail', 30, 36e5);
    if (purpose === 'link') {
      const me = A.needPlayer(req), owner = await one(pool, 'SELECT id FROM players WHERE email = $1', [email]);
      if (owner && owner.id !== me.id) throw taken();
      return sendCode(req, email, 'link', { player: me.id });
    }
    const p = await one(pool, 'SELECT id, blocked FROM players WHERE email = $1', [email]);
    if (!p || p.blocked) return { ok: true, sent: true, wait: MAIL_GAP / 1000 };
    return sendCode(req, email, 'reset', { player: p.id });
  });

  // шаг 2: { email, purpose, code, password? } — reg: создать аккаунт и войти; link: почта подтверждена;
  // reset: новый пароль (password) и вход
  app.post('/api/auth/email/verify', async (req, reply) => {
    const b = req.body || {}, purpose = V.oneOf(b.purpose, 'purpose', ['reg', 'link', 'reset']), email = normEmail(b.email);
    A.ipLimit(req, 'verify', 60, 10 * 6e4);
    const me = purpose === 'link' ? A.needPlayer(req) : null, pw = purpose === 'reset' ? needPass(b.password) : null;
    const row = await takeCode(email, purpose, b.code);
    if (me && row.player_id !== me.id) throw E.conflict('code_expired', 'Код запрошен с другого аккаунта — запросите новый');
    const pass = pw ? await hashPassword(pw) : null;
    let created = false;
    const p = await tx(async c => {
      if (!(await c.query('DELETE FROM email_codes WHERE email = $1 AND purpose = $2 AND code_hash = $3', [email, purpose, row.code_hash])).rowCount) throw E.conflict('code_expired', 'Код уже использован — запросите новый');
      const owner = await one(c, 'SELECT * FROM players WHERE email = $1 FOR UPDATE', [email]);
      if (purpose === 'link') {
        if (owner && owner.id !== me.id) throw taken();
        const out = await one(c, 'UPDATE players SET email = $2, email_ok = true WHERE id = $1 RETURNING *', [me.id, email]);
        await audit(c, me, 'email.link', me, { email });
        return out;
      }
      if (purpose === 'reg') {
        if (owner) throw taken();
        const d = row.data || {}, t = await createPlayer(c, { name: d.name, city: d.city });
        const out = await one(c, 'UPDATE players SET email = $2, email_ok = true, pass_hash = $3 WHERE id = $1 RETURNING *', [t.id, email, d.pass]);
        created = true;
        await A.startSession(reply, c, out.id, req.device);
        return out;
      }
      if (!owner || owner.id !== row.player_id) throw E.conflict('code_expired', 'Код устарел — запросите новый');
      if (owner.blocked) throw A.blockedErr();
      // у администратора с логином пароль строже — от 10 символов
      if (owner.login && passwordProblem(pw)) throw E.bad(passwordProblem(pw), 'password');
      const out = await one(c, 'UPDATE players SET pass_hash = $2, email_ok = true, pass_fails = 0, pass_lock_until = NULL WHERE id = $1 RETURNING *', [owner.id, pass]);
      // новый пароль — старые входы закрываются
      await c.query('DELETE FROM sessions WHERE player_id = $1', [owner.id]);
      await A.startSession(reply, c, out.id, req.device, sessionMs(out));
      await audit(c, out, 'password.reset', out, { ip: req.ip });
      return out;
    });
    A.clearCache();
    return Object.assign(await A.meResp(pool, p), { created });
  });

  // письма на сервере не настроены: почта привязывается сразу, неподтверждённой; { email, password? } —
  // пароль нужен, если его ещё нет (вход по почте и паролю). Когда письма заработают — подтверждается кодом.
  app.put('/api/me/email', async req => {
    const me = A.needPlayer(req), b = req.body || {}, email = normEmail(b.email);
    if (mailOn()) throw E.conflict('need_code', 'Подтвердите почту кодом из письма');
    A.ipLimit(req, 'mail', 30, 36e5);
    const pass = b.password ? await hashPassword(needPass(b.password)) : null;
    const p = await tx(async c => {
      const cur = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [me.id]);
      const owner = await one(c, 'SELECT id FROM players WHERE email = $1', [email]);
      if (owner && owner.id !== me.id) throw taken();
      if (!cur.pass_hash && !pass) throw E.bad('Задайте пароль — по почте и паролю будете входить', 'password');
      const out = await one(c, 'UPDATE players SET email = $2, email_ok = false, pass_hash = coalesce(pass_hash, $3) WHERE id = $1 RETURNING *', [me.id, email, pass]);
      await audit(c, me, 'email.set', me, { email });
      return out;
    });
    A.clearCache();
    return A.meResp(pool, p);
  });

  // вход по почте и паролю: { email, password }. 5 неверных паролей — вход закрыт на 15 минут
  app.post('/api/auth/email/login', async (req, reply) => {
    const b = req.body || {}, pw = typeof b.password === 'string' ? b.password : '';
    A.ipLimit(req, 'pass', 10, 10 * 6e4);
    const bad = () => E.conflict('bad_login', 'Неверная почта или пароль');
    let email;
    try { email = normEmail(b.email); } catch (e) { throw bad(); }
    if (!pw || pw.length > 200) throw bad();
    const p = await one(pool, 'SELECT * FROM players WHERE email = $1', [email]);
    // нет такой почты — всё равно считаем хэш: ответ по времени не выдаёт, есть ли аккаунт
    if (!p || !p.pass_hash) { await verifyPassword(pw, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'); throw bad(); }
    const now = Date.now();
    if (p.pass_lock_until && p.pass_lock_until > now) throw A.tooMany(Math.ceil((p.pass_lock_until - now) / 1000), 'Вход временно закрыт после неверных паролей — повторите через ' + Math.ceil((p.pass_lock_until - now) / 6e4) + ' мин или восстановите пароль');
    if (!await verifyPassword(pw, p.pass_hash)) {
      await pool.query('UPDATE players SET pass_fails = pass_fails + 1, pass_lock_until = CASE WHEN pass_fails + 1 >= $2 THEN $3 ELSE pass_lock_until END WHERE id = $1', [p.id, A.PASS_FAILS, now + A.PASS_LOCK]);
      throw bad();
    }
    if (p.blocked) throw A.blockedErr();
    await tx(async c => {
      await c.query('UPDATE players SET pass_fails = 0, pass_lock_until = NULL WHERE id = $1', [p.id]);
      await A.startSession(reply, c, p.id, req.device, sessionMs(p));
      if (atLeast(p, 'admin')) await audit(c, p, 'login.email', p, { ip: req.ip });
    });
    return A.meResp(pool, p);
  });
};
module.exports.normEmail = normEmail;
module.exports.playerPassProblem = playerPassProblem;
