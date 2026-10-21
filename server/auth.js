// Вход: сессия в httpOnly-cookie, VK ID (OAuth 2.1 + PKCE), вход для разработки.
const crypto = require('node:crypto');
const config = require('./config');
const { pool, tx, one } = require('./db');
const { E, V } = require('./errors');
const { createPlayer, meJSON } = require('./players');

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

async function startSession(reply, c, playerId, device) {
  const token = b64url(crypto.randomBytes(32)), now = Date.now();
  await c.query('INSERT INTO sessions (token_hash, player_id, device_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [sha(token), playerId, device || null, now, now + SESSION_MS]);
  reply.setCookie(SID, token, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_MS / 1000 });
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
  });
}

const needPlayer = req => { if (!req.player) throw E.auth(); return req.player; };
const safeReturn = r => typeof r === 'string' && /^\/(?!\/)[^\\\s]*$/.test(r) ? r : '/';

async function vkPost(path, query, body) {
  const url = 'https://' + config.vk.domain + path + '?' + new URLSearchParams(query);
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(body), signal: AbortSignal.timeout(8000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error('VK ' + path + ': ' + (data.error_description || data.error || res.status));
  return data;
}

function routes(app) {
  app.get('/api/me', async req => ({ player: meJSON(req.player), admin: !!(req.player && req.player.admin) }));

  app.patch('/api/me', async req => {
    const me = needPlayer(req), b = req.body || {}, set = {};
    if (b.name !== undefined) set.name = V.str(b.name, 'name', 2, 32);
    if (b.city !== undefined) set.city = V.optStr(b.city, 'city', 40);
    if (b.club !== undefined) set.club = V.optStr(b.club, 'club', 40);
    const keys = Object.keys(set);
    if (!keys.length) throw E.bad('Нечего менять');
    const p = await one(pool, `UPDATE players SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1 RETURNING *`, [me.id, ...keys.map(k => set[k])]);
    cache.clear();
    return { player: meJSON(p), admin: p.admin };
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
        if (!await one(c, 'SELECT 1 FROM players WHERE id = $1', [id])) throw E.notFound('Игрок не найден');
        await startSession(reply, c, id, req.device);
      });
      return { ok: true };
    });
  }

  app.get('/api/auth/vk', async (req, reply) => {
    if (!config.vk.appId) throw E.notFound('Вход через VK не настроен');
    const verifier = b64url(crypto.randomBytes(48)), state = b64url(crypto.randomBytes(24));
    reply.setCookie(VKC, JSON.stringify({ v: verifier, s: state, r: safeReturn(req.query.return) }),
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
      await tx(async c => {
        let p = await one(c, 'SELECT id FROM players WHERE vk_id = $1', [vkId]);
        if (!p) p = await createPlayer(c, { name, vk_id: vkId });
        await startSession(reply, c, p.id, req.device);
      });
      return reply.redirect(back);
    } catch (e) {
      return fail(e.message);
    }
  });
}

module.exports = { hooks, routes, needPlayer, startSession };
