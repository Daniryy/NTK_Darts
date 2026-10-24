// Администратор: аккаунты игроков. Созданный аккаунт получает код привязки — игрок входит через VK
// и вводит код в профиле (POST /api/me/claim), после этого аккаунт со всеми матчами становится его.
const crypto = require('node:crypto');
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer, clearCache } = require('../auth');
const { createPlayer, playerShort } = require('../players');

const needAdmin = req => { const me = needPlayer(req); if (!me.admin) throw E.forbidden('Это может только администратор'); return me; };
// код без похожих букв и цифр (0/O, 1/I)
const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function newClaim(c) {
  for (;;) {
    const code = Array.from(crypto.randomBytes(8), b => ABC[b % ABC.length]).join('');
    if (!await one(c, 'SELECT 1 FROM players WHERE claim = $1', [code])) return code;
  }
}
const adminJSON = p => Object.assign(playerShort(p), { vk: p.vk_id != null, claim: p.claim || null, admin: p.admin, owner: p.owner_id });

module.exports = async function (app) {
  // GET /api/admin/players?q=&limit= — игроки с отметкой VK и кодом привязки
  app.get('/api/admin/players', async req => {
    needAdmin(req);
    const q = String(req.query.q || '').trim().toLowerCase(), limit = Math.min(200, Math.max(1, +req.query.limit || 50));
    const rows = q
      ? await all(pool, `SELECT * FROM players WHERE position($1 in lower(name)) > 0 OR position($1 in handle) > 0 OR position($1 in lower(code)) > 0 ORDER BY name LIMIT ${limit}`, [q])
      : await all(pool, `SELECT * FROM players ORDER BY created_at DESC, id DESC LIMIT ${limit}`);
    return { players: rows.map(adminJSON) };
  });

  // POST /api/admin/players — { name, city, club, title } → игрок и код привязки
  app.post('/api/admin/players', async (req, reply) => {
    const me = needAdmin(req), b = req.body || {};
    const p = await tx(async c => {
      const pl = await createPlayer(c, { name: V.str(b.name, 'name', 2, 32), city: V.optStr(b.city, 'city', 40), club: V.optStr(b.club, 'club', 40), owner_id: me.id });
      return one(c, 'UPDATE players SET title = $2, claim = $3 WHERE id = $1 RETURNING *', [pl.id, V.optStr(b.title, 'title', 40), await newClaim(c)]);
    });
    return reply.code(201).send({ player: adminJSON(p) });
  });

  // PATCH /api/admin/players/:id — { name, city, club, title, ver, admin, claim: true (новый код) | false (убрать) }
  app.patch('/api/admin/players/:id', async req => {
    const me = needAdmin(req), b = req.body || {};
    const p = await tx(async c => {
      const cur = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur) throw E.notFound('Игрок не найден');
      const set = {};
      if (b.name !== undefined) set.name = V.str(b.name, 'name', 2, 32);
      if (b.city !== undefined) set.city = V.optStr(b.city, 'city', 40);
      if (b.club !== undefined) set.club = V.optStr(b.club, 'club', 40);
      if (b.title !== undefined) set.title = V.optStr(b.title, 'title', 40);
      if (b.ver !== undefined) set.ver = V.bool(b.ver, 'ver');
      if (b.admin !== undefined) {
        if (cur.id === me.id && !b.admin) throw E.conflict('conflict', 'Нельзя снять права администратора с себя');
        set.admin = V.bool(b.admin, 'admin');
      }
      if (b.claim === true) {
        if (cur.vk_id != null) throw E.conflict('conflict', 'Аккаунт уже привязан к VK');
        set.claim = await newClaim(c);
      } else if (b.claim === false) set.claim = null;
      const keys = Object.keys(set);
      if (!keys.length) throw E.bad('Нечего менять');
      return one(c, `UPDATE players SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1 RETURNING *`, [cur.id, ...keys.map(k => set[k])]);
    });
    clearCache();
    return { player: adminJSON(p) };
  });
};
