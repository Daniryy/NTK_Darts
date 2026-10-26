// Баннеры: показываются в ленте (feed), на странице турнира (tour) и на табло (tv).
// Заводит тех. администратор; переходы по баннеру считаются.
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPerm } = require('../auth');
const { can } = require('../roles');
const { audit } = require('../audit');

const PLACES = ['feed', 'tour', 'tv'];
const pub = b => ({ id: b.id, place: b.place, title: b.title, body: b.body, image: b.image, link: b.link });
const full = b => Object.assign(pub(b), { active: b.active, starts: b.starts, ends: b.ends, clicks: b.clicks, created: b.created_at });
function url(v, field, uploads) {
  if (v == null || v === '') return null;
  const s = V.str(v, field, 1, 500);
  if (uploads && /^\/uploads\/[\w.-]+$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch (e) { throw E.bad('Поле ' + field + ': нужна ссылка https', field); }
  if (u.protocol !== 'https:') throw E.bad('Поле ' + field + ': нужна ссылка https', field);
  return u.href;
}
function fields(b, all) {
  const o = {};
  if (all || b.place !== undefined) o.place = V.oneOf(b.place, 'place', PLACES);
  if (all || b.title !== undefined) o.title = V.optStr(b.title, 'title', 80);
  if (all || b.body !== undefined) o.body = V.optStr(b.body, 'body', 200);
  if (all || b.image !== undefined) o.image = url(b.image, 'image', true);
  if (all || b.link !== undefined) o.link = url(b.link, 'link');
  if (b.active !== undefined) o.active = V.bool(b.active, 'active');
  if (b.starts !== undefined) o.starts = V.optTime(b.starts, 'starts');
  if (b.ends !== undefined) o.ends = V.optTime(b.ends, 'ends');
  return o;
}
const need = req => needPerm(req, 'banners', 'Баннерами занимается тех. администратор');

module.exports = async function (app) {
  // GET /api/banners?place=feed — действующие сейчас
  app.get('/api/banners', async req => {
    const place = V.oneOf(req.query.place, 'place', PLACES), now = Date.now();
    // Pro — без рекламы; табло в зале смотрят все, там баннеры остаются
    if (place !== 'tv' && can(req.player, 'pro')) return { banners: [] };
    const rows = await all(pool, `SELECT * FROM banners WHERE place = $1 AND active AND (starts IS NULL OR starts <= $2) AND (ends IS NULL OR ends > $2) ORDER BY created_at DESC LIMIT 5`, [place, now]);
    return { banners: rows.map(pub) };
  });
  // переход по баннеру: страница шлёт перед открытием ссылки
  app.post('/api/banners/:id/click', async req => {
    await pool.query('UPDATE banners SET clicks = clicks + 1 WHERE id = $1', [req.params.id]);
    return { ok: true };
  });

  app.get('/api/admin/banners', async req => {
    need(req);
    return { banners: (await all(pool, 'SELECT * FROM banners ORDER BY created_at DESC')).map(full) };
  });
  app.post('/api/admin/banners', async (req, reply) => {
    const me = need(req), f = fields(req.body || {}, true);
    if (!f.title && !f.image) throw E.bad('Нужен заголовок или картинка', 'title');
    const row = await one(pool, `INSERT INTO banners (place, title, body, image, link, active, starts, ends, created_by, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [f.place, f.title, f.body, f.image, f.link, f.active !== false, f.starts || null, f.ends || null, me.id, Date.now()]);
    await audit(pool, me, 'banner.create', { id: row.id, name: row.title }, { place: row.place });
    return reply.code(201).send({ banner: full(row) });
  });
  app.patch('/api/admin/banners/:id', async req => {
    const me = need(req);
    const f = fields(req.body || {}, false), keys = Object.keys(f);
    if (!keys.length) throw E.bad('Нечего менять');
    const row = await one(pool, `UPDATE banners SET ${keys.map((k, n) => k + ' = $' + (n + 2)).join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...keys.map(k => f[k])]);
    if (!row) throw E.notFound('Баннер не найден');
    await audit(pool, me, 'banner.edit', { id: row.id, name: row.title }, f);
    return { banner: full(row) };
  });
  // удалить баннер и его загруженную картинку
  app.delete('/api/admin/banners/:id', async req => {
    const me = need(req);
    const files = await tx(async c => {
      const row = await one(c, 'DELETE FROM banners WHERE id = $1 RETURNING *', [req.params.id]);
      if (!row) throw E.notFound('Баннер не найден');
      await audit(c, me, 'banner.delete', { id: row.id, name: row.title }, null);
      const m = row.image && row.image.match(/^\/uploads\/([\w.-]+)$/);
      if (!m || await one(c, 'SELECT 1 FROM banners WHERE image = $1', [row.image])) return [];
      return (await all(c, `DELETE FROM photos WHERE file = $1 AND kind = 'banner' RETURNING file`, [m[1]])).map(x => x.file);
    });
    require('./photos').unlink(files);
    return { ok: true };
  });
};
