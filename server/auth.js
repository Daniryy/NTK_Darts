// Вход: сессия в httpOnly-cookie; VK ID (OAuth 2.1 + PKCE), телефон с кодом, код от ведущего,
// логин и пароль администраторов, вход для разработки.
const crypto = require('node:crypto');
const config = require('./config');
const { pool, tx, one } = require('./db');
const { E, V, ApiError } = require('./errors');
const { isAdmin, atLeast, can, permsOf } = require('./roles');
const { hit, wait, fail } = require('./limits');
const { hashPassword, verifyPassword, passwordProblem, normLogin } = require('./password');
const { sendCode, DIGITS } = require('./sms');
const { createPlayer, meJSON } = require('./players');
const T = require('./totp');

const SID = 'oche_sid', VKC = 'oche_vk';
const SESSION_MS = 180 * 864e5;
const secure = config.publicUrl.startsWith('https://');
const b64url = buf => buf.toString('base64url');
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// кэш сессий на 30 с: опрос зрителей не ходит в базу за каждым запросом
const cache = new Map();
async function playerBySession(token) {
  const h = sha(token), hit = cache.get(h), now = Date.now();
  if (hit && hit.at > now - 30000) return hit.p;
  const p = await one(pool, `SELECT p.* FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = $1 AND s.expires_at > $2`, [h, now]);
  if (cache.size > 5000) cache.clear();
  cache.set(h, { p, at: now });
  return p;
}

// ms — срок сессии: обычный вход полгода, вход администратора по паролю — 30 дней
async function startSession(reply, c, playerId, device, ms) {
  const token = b64url(crypto.randomBytes(32)), now = Date.now(), ttl = ms || SESSION_MS;
  await c.query('INSERT INTO sessions (token_hash, player_id, device_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [sha(token), playerId, device || null, now, now + ttl]);
  reply.setCookie(SID, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: Math.floor(ttl / 1000) });
}

const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;

function hooks(app) {
  app.decorateRequest('player', null);
  app.decorateRequest('device', null);
  app.addHook('onRequest', async req => {
    const d = req.headers['x-device-id'];
    if (typeof d === 'string' && DEVICE_RE.test(d)) req.device = d;
    // запись только с устройства: заголовок ещё и защищает от подделки запросов с чужих сайтов
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.device && req.url.startsWith('/api/')) throw E.bad('Нужен заголовок X-Device-Id', 'X-Device-Id');
    const tok = req.cookies[SID];
    if (tok) req.player = await playerBySession(tok);
    if (req.player && req.player.blocked) req.player = null;
  });
}

// сессии хранят игрока: после смены имени, фото или владельца аккаунта кэш сбрасывается
const clearCache = () => cache.clear();
const needPlayer = req => { if (!req.player) throw E.auth(); return req.player; };
// право из настроек ролей (roles.js): нет — 403
const needPerm = (req, k, msg) => { const me = needPlayer(req); if (!can(me, k)) throw E.forbidden(msg || 'Нет прав'); return me; };
// ответ «кто я»: игрок, роль, права и клубы, где он ведущий
async function meResp(c, p) {
  const clubs = p ? await c.query(`SELECT c.id, c.name FROM club_hosts h JOIN clubs c ON c.id = h.club_id WHERE h.player_id = $1 AND c.status = 'active' ORDER BY c.name`, [p.id]) : { rows: [] };
  return { player: meJSON(p), admin: isAdmin(p), role: p ? p.role : null, perms: permsOf(p), clubs: clubs.rows };
}
// второй шаг входа администратора: пароль уже проверен, сеанс — только после кода из приложения.
// Нет 2FA — сначала привязка: секрет и ссылка для QR-кода, вход после первого верного кода. Билет живёт 10 минут.
const tickets = new Map();
function adminTicket(p, action) {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.exp < now || tickets.size > 5000) tickets.delete(k);
  const ticket = b64url(crypto.randomBytes(24)), t = { pid: p.id, exp: now + 10 * 6e4, action };
  if (!p.totp_on) t.secret = T.newSecret();
  tickets.set(ticket, t);
  return p.totp_on ? { need2fa: 'code', ticket } : { need2fa: 'setup', ticket, secret: t.secret, otpauth: T.otpauth(p.login || p.email || p.code, t.secret) };
}
// код из приложения или резервный код: шаг принятого кода (или 'backup'), иначе null
async function takeTotp(c, p, code) {
  let secret;
  try { secret = T.dec(p.totp_secret); } catch (e) { throw E.conflict('conflict', 'Двухфакторный вход не читается (сменился COOKIE_SECRET) — сбросьте его на сервере: admin.sh 2fa-off'); }
  const step = T.check(secret, code, +p.totp_last || 0);
  if (step) { await c.query('UPDATE players SET totp_last = $2 WHERE id = $1', [p.id, step]); return step; }
  const n = T.normBackup(code), h = T.hashBackup(code), list = p.totp_backup || [];
  if (n.length !== 8 || !list.includes(h)) return null;
  await c.query('UPDATE players SET totp_backup = $2 WHERE id = $1', [p.id, JSON.stringify(list.filter(x => x !== h))]);
  return 'backup';
}

// лимит попыток входа с одного IP: 429 с Retry-After
function ipLimit(req, kind, max, ms) {
  const wait = hit(kind + ':' + req.ip, max, ms);
  if (wait) throw tooMany(wait, 'Слишком много попыток входа с этого адреса — повторите через ' + Math.ceil(wait / 60) + ' мин');
}
// неудачные попытки входа: [ключ, сколько можно, окно мс]. Проверяем до попытки, засчитываем после ошибки;
// удачные не считаются — в зале у всех телефонов один IP
function failCheck(keys) {
  for (const [key, max] of keys) {
    const w = wait(key, max);
    if (w) throw tooMany(w, 'Слишком много неудачных попыток — повторите через ' + Math.ceil(w / 60) + ' мин');
  }
}
const failAdd = keys => keys.forEach(([key, , ms]) => fail(key, ms));
// пароль: на аккаунт с одного адреса — 5 ошибок за 15 минут (посторонний с другого адреса владельцу вход не закроет),
// на аккаунт со всех адресов — 30 в час, с одного адреса на любые аккаунты — 50 за 15 минут
const PASS_FAILS = 5, PASS_LOCK = 15 * 6e4, PASS_SESSION = 30 * 864e5;
const passKeys = (req, acct) => [['pw:' + acct + ':' + req.ip, PASS_FAILS, PASS_LOCK], ['pw:' + acct, 30, 36e5], ['pwip:' + req.ip, 50, PASS_LOCK]];
const blockedErr = () => E.forbidden('Аккаунт заблокирован администратором');
// администраторы входят только с паролем (логин или почта): код, звонок и VK для них закрыты
const RANK_ADMIN = t => ['admin', 'tech'].includes(t.role);
const adminPassErr = () => E.forbidden('Администраторы входят по логину или почте с паролем');

// телефон в виде +79991234567: 8… и 9… без кода страны считаем российскими
function normPhone(v) {
  const raw = String(v == null ? '' : v).trim(), plus = raw.startsWith('+');
  let d = raw.replace(/\D/g, '');
  if (!plus && d.length === 11 && d[0] === '8') d = '7' + d.slice(1);
  if (!plus && d.length === 10 && d[0] === '9') d = '7' + d;
  if (d.length < 10 || d.length > 15) throw E.bad('Номер телефона, например +7 999 123-45-67', 'phone');
  return '+' + d;
}
const phoneOn = () => config.sms.provider === 'log' || (config.sms.provider === 'smsru' && !!config.sms.smsruId);
const codeHash = (phone, code) => sha(phone + ':' + code);
const tooMany = (sec, msg) => new ApiError(429, 'too_many', msg || 'Слишком часто, повторите через ' + sec + ' с', { retryAfter: sec });
// попыток ввода: у 4 цифр звонка меньше, чем у 6 цифр SMS
const SMS_GAP = 60e3, CODE_TTL = 10 * 6e4, TRIES = { 4: 3, 6: 5 };
// код от ведущего или администратора: буквы и цифры без похожих
const normCode = v => V.str(v, 'code', 4, 16).toUpperCase().replace(/[^A-Z0-9]/g, '');
const safeReturn = r => typeof r === 'string' && /^\/(?!\/)[^\\\s]*$/.test(r) ? r : '/';

async function vkPost(path, query, body) {
  const url = 'https://' + config.vk.domain + path + '?' + new URLSearchParams(query);
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(body), signal: AbortSignal.timeout(8000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error('VK ' + path + ': ' + (data.error_description || data.error || res.status));
  return data;
}

function routes(app) {
  app.get('/api/me', async req => meResp(pool, req.player));
  // что умеет сервер: вход через VK, по телефону, вход для разработки
  app.get('/api/config', async () => ({ vk: !!config.vk.appId, phone: phoneOn(), phoneBy: config.sms.method, email: require('./mail').mailOn(), dev: config.devLogin, contact: config.contact }));

  app.patch('/api/me', async req => {
    const me = needPlayer(req), b = req.body || {}, set = {};
    if (b.name !== undefined) set.name = V.str(b.name, 'name', 2, 32);
    if (b.city !== undefined) set.city = V.optStr(b.city, 'city', 40);
    // клуб — только из зарегистрированных (открытых); прежнее значение можно оставить как есть
    if (b.club !== undefined && b.club !== (me.club || '')) {
      set.club = V.optStr(b.club, 'club', 40);
      if (set.club && !await one(pool, `SELECT 1 FROM clubs WHERE status = 'active' AND name = $1`, [set.club])) throw E.bad('Клуб выбирается из зарегистрированных в Oche', 'club');
    }
    // выходная музыка на табло — в тарифе Pro
    if (b.walkon !== undefined && b.walkon !== (me.walkon || '')) {
      if (!can(me, 'pro')) throw E.forbidden('Выходная музыка — в тарифе Pro');
      set.walkon = V.optStr(b.walkon, 'walkon', 60);
    }
    // звание — только через подтверждение (POST /api/titles)
    if (b.title !== undefined && b.title !== (me.title || '')) throw E.bad('Звание подтверждается заявкой с документом', 'title');
    const keys = Object.keys(set);
    if (!keys.length) throw E.bad('Нечего менять');
    const p = await one(pool, `UPDATE players SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1 RETURNING *`, [me.id, ...keys.map(k => set[k])]);
    cache.clear();
    return meResp(pool, p);
  });

  // привязать аккаунт, созданный администратором: { code }. Свой новый аккаунт (без матчей и турниров) растворяется в нём.
  app.post('/api/me/claim', async req => {
    const me = needPlayer(req), code = normCode((req.body || {}).code), keys = [['code:' + req.ip, 30, 10 * 6e4]];
    failCheck(keys);
    const p = await tx(async c => {
      const t = await one(c, 'SELECT * FROM players WHERE claim = $1 FOR UPDATE', [code]);
      if (!t) { failAdd(keys); throw E.notFound('Код не найден — проверьте у организатора'); }
      if (t.id === me.id) throw E.conflict('conflict', 'Этот аккаунт уже ваш');
      if (RANK_ADMIN(t)) throw adminPassErr();
      if (t.vk_id != null || t.phone != null || t.email != null) throw E.conflict('conflict', 'К аккаунту уже привязан вход');
      const used = await one(c, `SELECT (SELECT count(*) FROM match_lines WHERE player_id = $1) + (SELECT count(*) FROM entries WHERE player_id = $1)
        + (SELECT count(*) FROM tournaments WHERE owner_id = $1) AS n`, [me.id]);
      if (used.n > 0) throw E.conflict('conflict', 'У вашего аккаунта уже есть матчи или турниры — объединить может только администратор');
      const cur = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [me.id]);
      // свой аккаунт растворяется: роль, звание, вход по паролю, клуб, номера, тариф и заявки пропали бы вместе с ним
      const own = await one(c, `SELECT (SELECT count(*) FROM club_hosts WHERE player_id = $1) + (SELECT count(*) FROM host_nums WHERE host_id = $1)
        + (SELECT count(*) FROM player_plans WHERE player_id = $1 AND status IN ('active', 'requested')) + (SELECT count(*) FROM title_requests WHERE player_id = $1 AND status = 'review')
        + (SELECT count(*) FROM clubs WHERE owner_id = $1 AND status IN ('pending', 'active')) AS n`, [me.id]);
      if (cur.role !== 'player' || cur.title || cur.login || own.n > 0) throw E.conflict('conflict', 'У вашего аккаунта есть роль, звание, клуб или тариф — объединить может только администратор');
      await c.query('UPDATE players SET vk_id = NULL, phone = NULL, email = NULL WHERE id = $1', [me.id]);
      await c.query('UPDATE sessions SET player_id = $2 WHERE player_id = $1', [me.id, t.id]);
      await c.query('UPDATE photos SET owner_id = $2 WHERE owner_id = $1', [me.id, t.id]);
      await c.query('UPDATE players SET owner_id = $2 WHERE owner_id = $1', [me.id, t.id]);
      const out = await one(c, 'UPDATE players SET vk_id = $2, phone = $3, email = $4, email_ok = $5, pass_hash = $6, claim = NULL WHERE id = $1 RETURNING *', [t.id, cur.vk_id, cur.phone, cur.email, cur.email_ok, cur.pass_hash]);
      await c.query('DELETE FROM players WHERE id = $1', [me.id]);
      return out;
    });
    cache.clear();
    return meResp(pool, p);
  });

  // вход по коду от ведущего: аккаунт для тех, у кого нет VK и кто не хочет SMS. Код одноразовый.
  app.post('/api/auth/code', async (req, reply) => {
    const code = normCode((req.body || {}).code), keys = [['code:' + req.ip, 30, 10 * 6e4]];
    failCheck(keys);
    const p = await tx(async c => {
      const t = await one(c, 'SELECT * FROM players WHERE claim = $1 FOR UPDATE', [code]);
      if (!t) { failAdd(keys); throw E.notFound('Код не найден — проверьте у ведущего'); }
      if (t.blocked) throw blockedErr();
      if (atLeast(t, 'admin')) throw adminPassErr();
      await c.query('UPDATE players SET claim = NULL WHERE id = $1', [t.id]);
      await startSession(reply, c, t.id, req.device);
      return t;
    });
    return meResp(pool, p);
  });

  // вход по телефону, шаг 1: { phone } → звонок-сброс или SMS с кодом. Не чаще раза в минуту и 5 раз в час на номер.
  app.post('/api/auth/phone', async (req, reply) => {
    if (!phoneOn()) throw E.notFound('Вход по телефону не настроен');
    const phone = normPhone((req.body || {}).phone), now = Date.now(), method = config.sms.method;
    ipLimit(req, 'sms', 100, 36e5);
    // лимиты и запись в журнал — до отправки: ошибки провайдера тоже считаются
    await tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [phone]);
      const last = await one(c, 'SELECT max(t) AS t FROM sms_log WHERE phone = $1', [phone]);
      if (last.t && now - last.t < SMS_GAP) { const sec = Math.ceil((SMS_GAP - (now - last.t)) / 1000); throw tooMany(sec, 'Код уже отправлен — новый можно запросить через ' + sec + ' с'); }
      const n = async (where, args) => (await one(c, 'SELECT count(*)::int AS n FROM sms_log WHERE ' + where, args)).n;
      if (await n('phone = $1 AND t > $2', [phone, now - 36e5]) >= 5) throw tooMany(600, 'На этот номер уже отправлено 5 кодов за час — попробуйте позже');
      if (req.device && await n('device_id = $1 AND t > $2', [req.device, now - 36e5]) >= 10) throw tooMany(600, 'С этого устройства запрошено слишком много кодов — попробуйте позже');
      if (await n('t > $1', [now - 864e5]) >= config.sms.dayMax) throw new ApiError(503, 'sms_limit', 'Вход по телефону временно недоступен — войдите через VK');
      await c.query('INSERT INTO sms_log (phone, device_id, t) VALUES ($1, $2, $3)', [phone, req.device, now]);
    });
    let code;
    try {
      code = await sendCode(phone, req.ip, req.log);
    } catch (e) {
      req.log.error({ err: e.message }, 'phone code failed');
      throw new ApiError(502, 'sms_failed', (method === 'call' ? 'Не удалось позвонить' : 'Не удалось отправить SMS') + ' — попробуйте ещё раз или войдите через VK');
    }
    await pool.query(`INSERT INTO phone_codes (phone, code_hash, expires_at, tries, sent_at, digits) VALUES ($1, $2, $3, 0, $4, $5)
      ON CONFLICT (phone) DO UPDATE SET code_hash = $2, expires_at = $3, tries = 0, sent_at = $4, digits = $5`, [phone, codeHash(phone, code), now + CODE_TTL, now, code.length]);
    // в разработке ничего не уходит: код возвращается в ответе
    return Object.assign({ ok: true, wait: SMS_GAP / 1000, method, digits: code.length }, config.sms.provider === 'log' && !config.prod ? { devCode: code } : {});
  });

  // шаг 2: { phone, code } → вход (новый номер — новый игрок); { link: true } — привязать номер к своему аккаунту
  app.post('/api/auth/phone/verify', async (req, reply) => {
    const b = req.body || {}, phone = normPhone(b.phone), code = String(b.code == null ? '' : b.code).replace(/\D/g, ''), now = Date.now();
    // неверные коды: на номер — 10 в сутки (у кода звонка всего 4 цифры), с одного адреса — 60 за 10 минут
    const keys = [['pv:' + phone, 10, 864e5], ['pvip:' + req.ip, 60, 10 * 6e4]];
    failCheck(keys);
    if (code.length !== DIGITS.call && code.length !== DIGITS.sms) throw E.bad('Код — 4 последние цифры номера, с которого звонили, или 6 цифр из SMS', 'code');
    const link = b.link === true, me = link ? needPlayer(req) : null;
    // попытка считается сразу и вне транзакции: неверный код не откатывает счётчик
    const row = await one(pool, `UPDATE phone_codes SET tries = tries + 1 WHERE phone = $1 AND expires_at > $2 AND tries < CASE digits WHEN 4 THEN ${TRIES[4]} ELSE ${TRIES[6]} END RETURNING code_hash`, [phone, now]);
    if (!row) { failAdd(keys); throw E.conflict('code_expired', 'Код устарел или кончились попытки — запросите новый'); }
    const want = Buffer.from(row.code_hash), got = Buffer.from(codeHash(phone, code));
    if (!crypto.timingSafeEqual(want, got)) { failAdd(keys); throw E.conflict('bad_code', 'Неверный код'); }
    let created = false;
    const p = await tx(async c => {
      if (!(await c.query('DELETE FROM phone_codes WHERE phone = $1 AND code_hash = $2', [phone, row.code_hash])).rowCount) throw E.conflict('code_expired', 'Код уже использован — запросите новый');
      const owner = await one(c, 'SELECT * FROM players WHERE phone = $1 FOR UPDATE', [phone]);
      if (link) {
        if (owner && owner.id !== me.id) throw E.conflict('phone_taken', 'Этот номер уже привязан к другому аккаунту');
        return one(c, 'UPDATE players SET phone = $2 WHERE id = $1 RETURNING *', [me.id, phone]);
      }
      let t = owner;
      // новый аккаунт: на экране входа написано, что вход — согласие с политикой
      if (!t) { t = await createPlayer(c, { name: 'Игрок ' + phone.slice(-4), phone, consent: true }); created = true; }
      if (t.blocked) throw blockedErr();
      if (atLeast(t, 'admin')) throw adminPassErr();
      await startSession(reply, c, t.id, req.device);
      return t;
    });
    cache.clear();
    return Object.assign(await meResp(pool, p), { created });
  });

  // вход администратора по логину и паролю (страница #staff). Логин и пароль задаются командой на сервере
  // (npm run admin) или тех. администратором в панели; после 5 неверных паролей вход по логину закрыт на 15 минут.
  app.post('/api/auth/password', async (req, reply) => {
    const b = req.body || {}, login = normLogin(b.login), pw = typeof b.password === 'string' ? b.password : '';
    const keys = passKeys(req, 'l:' + login);
    failCheck(keys);
    const bad = () => { failAdd(keys); return E.conflict('bad_login', 'Неверный логин или пароль'); };
    if (!login || !pw || pw.length > 200) throw bad();
    const p = await one(pool, 'SELECT * FROM players WHERE login = $1', [login]);
    // нет такого логина — всё равно считаем хэш: ответ по времени не выдаёт, есть ли логин
    if (!p || !p.pass_hash) { await verifyPassword(pw, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'); throw bad(); }
    if (!await verifyPassword(pw, p.pass_hash)) {
      req.log.warn({ login }, 'bad admin password');
      throw bad();
    }
    if (p.blocked) throw blockedErr();
    if (!atLeast(p, 'admin')) throw E.forbidden('Вход по паролю — только для администраторов');
    await pool.query('UPDATE players SET pass_fails = 0, pass_lock_until = NULL WHERE id = $1', [p.id]);
    return adminTicket(p, 'login.password');
  });

  // второй шаг входа администратора: { ticket, code } — код из приложения (6 цифр) или резервный (abcd-efgh).
  // Привязка (need2fa: 'setup'): первый верный код включает 2FA, в ответе один раз — резервные коды (backup)
  app.post('/api/auth/2fa', async (req, reply) => {
    const b = req.body || {}, id = String(b.ticket || ''), t = tickets.get(id);
    if (!t || t.exp < Date.now()) throw E.conflict('code_expired', 'Время на код вышло — войдите заново');
    const keys = [['2fa:' + t.pid, 5, PASS_LOCK], ['2faip:' + req.ip, 30, PASS_LOCK]];
    failCheck(keys);
    let backup = null, left = null;
    const ok = await tx(async c => {
      const p = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [t.pid]);
      if (!p) throw E.notFound('Аккаунт не найден');
      if (p.blocked) throw blockedErr();
      if (t.secret) {
        if (p.totp_on) throw E.conflict('code_expired', 'Двухфакторный вход уже включён — войдите заново');
        const step = T.check(t.secret, b.code, 0);
        if (!step) return false;
        const bk = T.newBackup();
        backup = bk.codes;
        await c.query('UPDATE players SET totp_secret = $2, totp_on = true, totp_last = $3, totp_backup = $4 WHERE id = $1', [p.id, T.enc(t.secret), step, JSON.stringify(bk.hashes)]);
        await require('./audit').audit(c, p, '2fa.on', p, null);
      } else {
        if (!p.totp_on) throw E.conflict('code_expired', 'Двухфакторный вход сброшен — войдите заново');
        const r = await takeTotp(c, p, b.code);
        if (!r) return false;
        if (r === 'backup') left = (p.totp_backup || []).length - 1;
      }
      tickets.delete(id);
      await startSession(reply, c, p.id, req.device, PASS_SESSION);
      await require('./audit').audit(c, p, t.action, p, { ip: req.ip, backup: left != null || undefined });
      return true;
    });
    if (!ok) { failAdd(keys); throw E.conflict('bad_code', 'Неверный код'); }
    cache.clear();
    const p = await one(pool, 'SELECT * FROM players WHERE id = $1', [t.pid]);
    return Object.assign(await meResp(pool, p), backup ? { backup } : {}, left != null ? { backupLeft: left } : {});
  });

  // новые резервные коды (старые перестают работать): { code } — текущий код из приложения
  app.post('/api/me/2fa/backup', async req => {
    const me = needPlayer(req), keys = [['2fa:' + me.id, 5, PASS_LOCK]];
    failCheck(keys);
    const codes = await tx(async c => {
      const p = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [me.id]);
      if (!p.totp_on) throw E.conflict('conflict', 'Двухфакторный вход не включён');
      const r = await takeTotp(c, p, (req.body || {}).code);
      if (r !== 'backup' && !r) return null;
      const bk = T.newBackup();
      await c.query('UPDATE players SET totp_backup = $2 WHERE id = $1', [p.id, JSON.stringify(bk.hashes)]);
      await require('./audit').audit(c, p, '2fa.backup', p, null);
      return bk.codes;
    });
    if (!codes) { failAdd(keys); throw E.conflict('bad_code', 'Неверный код'); }
    return { backup: codes };
  });

  // сменить свой пароль: { current, password }. Пароля ещё нет, а почта привязана — задать без current
  app.put('/api/me/password', async req => {
    const me = needPlayer(req), b = req.body || {}, keys = [['pwc:' + me.id, 10, PASS_LOCK]];
    failCheck(keys);
    const cur = await one(pool, 'SELECT * FROM players WHERE id = $1', [me.id]);
    if (!cur.pass_hash && !cur.email) throw E.conflict('conflict', 'Сначала привяжите почту — по ней и паролю будете входить');
    if (cur.pass_hash && !await verifyPassword(typeof b.current === 'string' ? b.current : '', cur.pass_hash)) { failAdd(keys); throw E.conflict('bad_login', 'Текущий пароль неверный'); }
    // администраторам с логином — строже (от 10 символов)
    const bad = cur.login ? passwordProblem(b.password) : require('./email').playerPassProblem(b.password);
    if (bad) throw E.bad(bad, 'password');
    await tx(async c => {
      await c.query('UPDATE players SET pass_hash = $2, pass_fails = 0, pass_lock_until = NULL WHERE id = $1', [me.id, await hashPassword(b.password)]);
      // новый пароль: остальные входы закрываются, этот остаётся
      await c.query('DELETE FROM sessions WHERE player_id = $1 AND token_hash <> $2', [me.id, sha(req.cookies[SID] || '')]);
      await require('./audit').audit(c, me, 'password.change', me, null);
    });
    cache.clear();
    return { ok: true };
  });

  // отвязать способ входа: { phone | vk | email }; хотя бы один должен остаться
  app.delete('/api/me/login/:kind', async req => {
    const me = needPlayer(req), kind = V.oneOf(req.params.kind, 'kind', ['phone', 'vk', 'email']);
    const p = await tx(async c => {
      const cur = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [me.id]);
      const ways = { phone: cur.phone != null, vk: cur.vk_id != null, email: !!(cur.email && cur.pass_hash), login: !!(cur.login && cur.pass_hash) };
      delete ways[kind];
      if (!Object.values(ways).some(Boolean)) throw E.conflict('conflict', 'Это единственный способ входа — сначала привяжите другой');
      return one(c, `UPDATE players SET ${kind === 'phone' ? 'phone = NULL' : kind === 'vk' ? 'vk_id = NULL' : 'email = NULL, email_ok = false'} WHERE id = $1 RETURNING *`, [me.id]);
    });
    cache.clear();
    return meResp(pool, p);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const tok = req.cookies[SID];
    if (tok) { await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha(tok)]); cache.delete(sha(tok)); }
    reply.clearCookie(SID, { path: '/' });
    return { ok: true };
  });

  if (config.devLogin) {
    app.post('/api/auth/dev', async (req, reply) => {
      const id = V.id((req.body || {}).playerId, 'playerId');
      await tx(async c => {
        const p = await one(c, 'SELECT blocked FROM players WHERE id = $1', [id]);
        if (!p) throw E.notFound('Игрок не найден');
        if (p.blocked) throw blockedErr();
        await startSession(reply, c, id, req.device);
      });
      return { ok: true };
    });
  }

  app.get('/api/auth/vk', async (req, reply) => {
    if (!config.vk.appId) throw E.notFound('Вход через VK не настроен');
    const verifier = b64url(crypto.randomBytes(48)), state = b64url(crypto.randomBytes(24));
    // link=1 — привязать VK к аккаунту, в который уже вошли
    const link = req.query.link === '1' ? needPlayer(req).id : null;
    reply.setCookie(VKC, JSON.stringify({ v: verifier, s: state, r: safeReturn(req.query.return), l: link }),
      { path: '/api/auth', httpOnly: true, sameSite: 'lax', secure, maxAge: 900, signed: true });
    const q = new URLSearchParams({
      response_type: 'code', client_id: config.vk.appId, redirect_uri: config.publicUrl + '/api/auth/vk/callback', state,
      code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 's256', scope: 'vkid.personal_info'
    });
    return reply.redirect('https://' + config.vk.domain + '/authorize?' + q);
  });

  app.get('/api/auth/vk/callback', async (req, reply) => {
    const raw = req.cookies[VKC], un = raw ? req.unsignCookie(raw) : null;
    let saved = null;
    try { saved = un && un.valid ? JSON.parse(un.value) : null; } catch (e) { saved = null; }
    reply.clearCookie(VKC, { path: '/api/auth' });
    const back = saved ? saved.r : '/';
    const fail = why => { req.log.warn({ why }, 'vk login failed'); return reply.redirect(back + (back.includes('?') ? '&' : '?') + 'login=fail'); };
    const { code, state, device_id: deviceId } = req.query;
    if (!saved || !code || !deviceId || state !== saved.s) return fail('state');
    try {
      const tok = await vkPost('/oauth2/auth', {
        grant_type: 'authorization_code', redirect_uri: config.publicUrl + '/api/auth/vk/callback', client_id: config.vk.appId,
        code_verifier: saved.v, state: saved.s, device_id: deviceId
      }, { code });
      const info = await vkPost('/oauth2/user_info', { client_id: config.vk.appId }, { access_token: tok.access_token });
      const u = info.user || {}, vkId = +(u.user_id || tok.user_id);
      if (!vkId) return fail('no user id');
      const name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim().replace(/\s+/g, ' ').slice(0, 32) || 'Игрок VK';
      const out = await tx(async c => {
        const p = await one(c, 'SELECT id, blocked, role FROM players WHERE vk_id = $1', [vkId]);
        if (saved.l) {
          if (!req.player || req.player.id !== saved.l) return 'fail';
          if (p && p.id !== saved.l) return 'vk_taken';
          await c.query('UPDATE players SET vk_id = $2 WHERE id = $1', [saved.l, vkId]);
          return 'linked';
        }
        if (p && p.blocked) return 'blocked';
        if (p && atLeast(p, 'admin')) return 'admin_pass';
        await startSession(reply, c, p ? p.id : (await createPlayer(c, { name, vk_id: vkId, consent: true })).id, req.device);
        return null;
      });
      cache.clear();
      if (out === 'fail') return fail('link session');
      return reply.redirect(out ? back + (back.includes('?') ? '&' : '?') + 'login=' + out : back);
    } catch (e) {
      return fail(e.message);
    }
  });
}

module.exports = { adminTicket, hooks, routes, needPlayer, needPerm, startSession, clearCache, meResp, normPhone, ipLimit, failCheck, failAdd, passKeys, tooMany, blockedErr, sha, PASS_FAILS, PASS_LOCK, PASS_SESSION, SESSION_MS };
