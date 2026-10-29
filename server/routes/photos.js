// Фото: аватары игроков и снимки к итогам турнира. Страница сама обрезает и сжимает картинку,
// сервер принимает готовый файл (JPEG, WebP или PNG до 3 МБ), кладёт в UPLOAD_DIR и отдаёт по /uploads/.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer } = require('../auth');
const { playerShort } = require('../players');
const { isOwner, TOUR_SQL, loadTours } = require('../tour');
const { can } = require('../roles');
const { forget } = require('../versions');
const { clearCache } = require('../auth');

const MAX_BYTES = 3 * 1024 * 1024, TOUR_MAX = 60;
const urlOf = file => config.uploadUrl + file;
const photoJSON = p => ({ id: p.id, url: urlOf(p.file), w: p.w, h: p.h });

// тип по первым байтам: подпись файла, а не заголовок запроса
function kindOf(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'png';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

// файлы удаляем после записи в базу; ошибка удаления не мешает ответу
const unlink = files => files.forEach(f => fs.promises.unlink(path.join(config.uploadDir, f)).catch(() => {}));

async function tourOwned(c, id, me) {
  const row = await one(c, TOUR_SQL + ' WHERE t.id = $1 FOR UPDATE OF t', [id]);
  if (!row) throw E.notFound('Турнир не найден');
  const t = (await loadTours(c, [row]))[0];
  if (!isOwner(t, me)) throw E.forbidden('Фото к итогам добавляет организатор');
  return t;
}
// чей аватар можно менять: свой, гостя или аккаунта, который я завёл, любой — администратору
async function avatarTarget(c, me, pid) {
  if (!pid || pid === me.id) return me;
  const p = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [pid]);
  if (!p) throw E.notFound('Игрок не найден');
  if (!can(me, 'players') && !(p.vk_id == null && p.phone == null && p.owner_id === me.id)) throw E.forbidden('Менять фото можно себе, своим гостям или администратору');
  return p;
}

module.exports = async function (app) {
  // картинка приходит телом запроса как есть
  for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (req, body, done) => done(null, body));
  }

  // POST /api/photos?kind=avatar[&playerId=] | kind=tour&tournamentId=… | kind=banner (тех. администратор); w и h — размер после обрезки
  app.post('/api/photos', { bodyLimit: MAX_BYTES }, async (req, reply) => {
    const me = needPlayer(req), q = req.query, buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw E.bad('Нужна картинка: JPEG, WebP или PNG', 'body');
    const ext = kindOf(buf);
    if (!ext) throw E.bad('Это не JPEG, WebP или PNG', 'body');
    const kind = V.oneOf(q.kind, 'kind', ['avatar', 'tour', 'banner', 'club']);
    // логотип клуба и картинки спонсоров — ведущему клуба с тарифом «Ведущий»
    const clubId = kind === 'club' || (kind === 'banner' && q.clubId != null) ? V.id(q.clubId, 'clubId') : null;
    if (kind === 'banner' && !clubId && !can(me, 'banners')) throw E.forbidden('Баннерами занимается тех. администратор');
    const w = V.int(+q.w, 'w', 16, 4096), h = V.int(+q.h, 'h', 16, 4096);
    const id = crypto.randomBytes(12).toString('hex'), file = id + '.' + ext;
    await fs.promises.mkdir(config.uploadDir, { recursive: true });
    await fs.promises.writeFile(path.join(config.uploadDir, file), buf);
    const old = [];
    try {
      const res = await tx(async c => {
        if (kind === 'avatar') {
          const p = await avatarTarget(c, me, q.playerId == null ? null : V.id(q.playerId, 'playerId'));
          (await all(c, 'DELETE FROM photos WHERE player_id = $1 RETURNING file', [p.id])).forEach(x => old.push(x.file));
          const row = await one(c, `INSERT INTO photos (id, file, kind, owner_id, player_id, w, h, bytes, created_at) VALUES ($1, $2, 'avatar', $3, $4, $5, $6, $7, $8) RETURNING *`,
            [id, file, me.id, p.id, w, h, buf.length, Date.now()]);
          const pl = await one(c, 'UPDATE players SET photo = $2 WHERE id = $1 RETURNING *', [p.id, urlOf(file)]);
          return { photo: photoJSON(row), player: playerShort(pl) };
        }
        if (clubId) {
          const host = await one(c, `SELECT 1 FROM club_hosts h JOIN clubs cl ON cl.id = h.club_id WHERE h.club_id = $1 AND h.player_id = $2 AND cl.status = 'active'`, [clubId, me.id]);
          if (!(host || can(me, 'clubs')) || !can(me, 'club_tools')) throw E.forbidden('Логотип и спонсоры клуба — в тарифе «Ведущий»');
        }
        if (kind === 'club') {
          const cur = await one(c, 'SELECT logo FROM clubs WHERE id = $1 FOR UPDATE', [clubId]);
          if (!cur) throw E.notFound('Клуб не найден');
          if (cur.logo) (await all(c, `DELETE FROM photos WHERE file = $1 AND kind = 'club' RETURNING file`, [cur.logo.replace(config.uploadUrl, '')])).forEach(x => old.push(x.file));
          const row = await one(c, `INSERT INTO photos (id, file, kind, owner_id, w, h, bytes, created_at) VALUES ($1, $2, 'club', $3, $4, $5, $6, $7) RETURNING *`,
            [id, file, me.id, w, h, buf.length, Date.now()]);
          await c.query('UPDATE clubs SET logo = $2 WHERE id = $1', [clubId, urlOf(file)]);
          return { photo: photoJSON(row) };
        }
        if (kind === 'banner') {
          const row = await one(c, `INSERT INTO photos (id, file, kind, owner_id, w, h, bytes, created_at) VALUES ($1, $2, 'banner', $3, $4, $5, $6, $7) RETURNING *`,
            [id, file, me.id, w, h, buf.length, Date.now()]);
          return { photo: photoJSON(row) };
        }
        const t = await tourOwned(c, V.id(q.tournamentId, 'tournamentId'), me);
        if ((await one(c, 'SELECT count(*) AS n FROM photos WHERE tournament_id = $1', [t.id])).n >= TOUR_MAX) throw E.conflict('conflict', 'У турнира уже ' + TOUR_MAX + ' фото');
        const row = await one(c, `INSERT INTO photos (id, file, kind, owner_id, tournament_id, w, h, bytes, created_at) VALUES ($1, $2, 'tour', $3, $4, $5, $6, $7, $8) RETURNING *`,
          [id, file, me.id, t.id, w, h, buf.length, Date.now()]);
        // &cover=1 — это общее фото игроков
        await c.query('UPDATE tournaments SET version = version + 1' + (q.cover === '1' ? ', cover = $2' : '') + ' WHERE id = $1', q.cover === '1' ? [t.id, row.id] : [t.id]);
        forget('t', t.id);
        return { photo: photoJSON(row) };
      });
      unlink(old);
      if (res.player) clearCache();
      return reply.code(201).send(res);
    } catch (e) {
      unlink([file]);
      throw e;
    }
  });

  // DELETE /api/players/:id/photo — убрать аватар (те же права, что на загрузку)
  app.delete('/api/players/:id/photo', async req => {
    const me = needPlayer(req), files = [];
    await tx(async c => {
      const p = await avatarTarget(c, me, req.params.id);
      (await all(c, 'DELETE FROM photos WHERE player_id = $1 RETURNING file', [p.id])).forEach(x => files.push(x.file));
      await c.query('UPDATE players SET photo = NULL WHERE id = $1', [p.id]);
    });
    unlink(files);
    clearCache();
    return { ok: true };
  });

  // DELETE /api/photos/:id — свой аватар, аватар гостя, фото турнира (организатор), администратор — любое
  app.delete('/api/photos/:id', async req => {
    const me = needPlayer(req);
    const files = [];
    await tx(async c => {
      const p = await one(c, 'SELECT * FROM photos WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!p) throw E.notFound('Фото не найдено');
      if (p.kind === 'avatar') {
        await avatarTarget(c, me, p.player_id);
        await c.query('UPDATE players SET photo = NULL WHERE id = $1', [p.player_id]);
      } else {
        await tourOwned(c, p.tournament_id, me);
        await c.query('UPDATE tournaments SET version = version + 1 WHERE id = $1', [p.tournament_id]);
        forget('t', p.tournament_id);
      }
      await c.query('DELETE FROM photos WHERE id = $1', [p.id]);
      files.push(p.file);
    });
    unlink(files);
    clearCache();
    return { ok: true };
  });
};

module.exports.unlink = unlink;
module.exports.photoJSON = photoJSON;
