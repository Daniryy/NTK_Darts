// Личные данные (152-ФЗ): выгрузка всего, что хранится об игроке, и удаление аккаунта им самим.
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { pool, tx, one, all } = require('../db');
const { E } = require('../errors');
const { needPlayer, clearCache } = require('../auth');
const { RANK } = require('../roles');

const SID = config.sidName;
const HIDDEN = ['pass_hash', 'pass_fails', 'pass_lock_until', 'claim'];

async function exportData(c, id) {
  const p = await one(c, 'SELECT * FROM players WHERE id = $1', [id]);
  for (const k of HIDDEN) delete p[k];
  return {
    exported_at: new Date().toISOString(),
    profile: p,
    sessions: await all(c, 'SELECT device_id, created_at, expires_at FROM sessions WHERE player_id = $1 ORDER BY created_at DESC', [id]),
    guests: await all(c, 'SELECT id, name, code, created_at FROM players WHERE owner_id = $1 ORDER BY created_at', [id]),
    tournaments: await all(c, `SELECT t.id, t.name, t.status, t.created_at, (t.owner_id = $1) AS mine FROM tournaments t
      WHERE t.owner_id = $1 OR EXISTS (SELECT 1 FROM entries e WHERE e.tournament_id = t.id AND e.player_id = $1) ORDER BY t.created_at`, [id]),
    matches: await all(c, `SELECT m.id, m.tournament_id, m.status, m.finished, l.* FROM match_lines l JOIN matches m ON m.id = l.match_id
      WHERE l.player_id = $1 ORDER BY m.finished NULLS LAST, m.id`, [id]),
    plans: await all(c, 'SELECT * FROM player_plans WHERE player_id = $1 ORDER BY 1', [id]),
    title_requests: await all(c, 'SELECT * FROM title_requests WHERE player_id = $1 ORDER BY created_at', [id]),
    title_docs: await all(c, 'SELECT id, request_id, mime, bytes, created_at FROM title_docs WHERE player_id = $1 ORDER BY created_at', [id]),
    photos: await all(c, 'SELECT id, kind, tournament_id, created_at FROM photos WHERE owner_id = $1 OR player_id = $1 ORDER BY created_at', [id])
  };
}

module.exports = async function (app) {
  // всё о себе одним файлом JSON
  app.get('/api/me/export', async (req, reply) => {
    const me = needPlayer(req);
    const data = await exportData(pool, me.id);
    reply.header('Content-Disposition', 'attachment; filename="oche-' + me.code + '.json"').header('Cache-Control', 'private, no-store');
    return data;
  });

  // удалить свой аккаунт: { confirm: true }. Без сыгранных турниров — удаляется целиком; иначе обезличивается:
  // имя «Удалённый игрок», контакты, входы, фото, звание и документы стираются, а матчи остаются у соперников и в сетках.
  app.delete('/api/me', async (req, reply) => {
    const me = needPlayer(req);
    if ((req.body || {}).confirm !== true) throw E.bad('Подтвердите удаление', 'confirm');
    if ((RANK[me.role] || 0) >= RANK.admin) throw E.forbidden('Аккаунт администратора удаляет тех. администратор');
    const files = await tx(async c => {
      const p = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [me.id]);
      const docs = await all(c, 'SELECT file FROM title_docs WHERE player_id = $1', [p.id]);
      const pics = await all(c, `SELECT file FROM photos WHERE player_id = $1`, [p.id]);
      const out = [...docs.map(d => path.join(config.privateDir, d.file)), ...pics.map(f => path.join(config.uploadDir, f.file.replace(/^.*\//, '')))];
      const busy = await one(c, `SELECT count(*)::int AS n FROM entries e JOIN tournaments t ON t.id = e.tournament_id WHERE e.player_id = $1 AND t.status <> 'reg'`, [p.id]);
      if (!busy.n) {
        await c.query('DELETE FROM players WHERE id = $1', [p.id]);
        return out;
      }
      await c.query(`DELETE FROM entries e USING tournaments t WHERE t.id = e.tournament_id AND e.player_id = $1 AND t.status = 'reg'`, [p.id]);
      for (const t of ['sessions', 'title_docs', 'email_codes', 'host_nums', 'club_hosts', 'club_helpers']) await c.query(`DELETE FROM ${t} WHERE player_id = $1`, [p.id]);
      await c.query('DELETE FROM host_nums WHERE host_id = $1', [p.id]);
      await c.query('DELETE FROM photos WHERE player_id = $1', [p.id]);
      await c.query('UPDATE players SET title_req = NULL WHERE id = $1', [p.id]);
      await c.query('DELETE FROM title_requests WHERE player_id = $1', [p.id]);
      await c.query(`UPDATE players SET name = 'Удалённый игрок', handle = 'deleted_' || id, city = '', club = '', ver = false, vk_id = NULL, phone = NULL,
        email = NULL, email_ok = false, login = NULL, pass_hash = NULL, claim = NULL, photo = NULL, title = '', walkon = '', role = 'player',
        base_role = 'player', blocked = true, rated = 0, consent_at = NULL WHERE id = $1`, [p.id]);
      return out;
    });
    for (const f of files) fs.promises.unlink(f).catch(() => {});
    clearCache();
    reply.clearCookie(SID, { path: '/' });
    return { ok: true };
  });
};

module.exports.exportData = exportData;
