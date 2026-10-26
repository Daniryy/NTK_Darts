// Подтверждение спортивного звания. Игрок: документ → заявка (ФИО, звание, приказ) → автопроверка → ждёт
// администратора. Администратор (право titles) подтверждает или отклоняет с комментарием; подтверждённое звание
// видно в профиле, рейтинге, сетке и на табло. Самому вписать звание нельзя.
// Документы лежат в закрытой папке config.privateDir и отдаются только владельцу и проверяющим.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer, needPerm, clearCache } = require('../auth');
const { can } = require('../roles');
const { audit } = require('../audit');
const { KIND, kindsJSON, autoCheck, searchUrl } = require('../titles');

const MAX_BYTES = 8 * 1024 * 1024, MAX_DOCS = 5;
// тип по первым байтам: JPEG, PNG, WebP, PDF
function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['jpg', 'image/jpeg'];
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return ['png', 'image/png'];
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return ['webp', 'image/webp'];
  if (b.length > 5 && b.toString('ascii', 0, 5) === '%PDF-') return ['pdf', 'application/pdf'];
  return null;
}
const fileOf = f => path.join(config.privateDir, f);
const unlink = files => files.forEach(f => fs.promises.unlink(fileOf(f)).catch(() => {}));

async function reqJSON(c, r, full) {
  const docs = await all(c, 'SELECT id, mime FROM title_docs WHERE request_id = $1 ORDER BY created_at', [r.id]);
  const k = KIND[r.title] || { short: r.title, full: r.title };
  const out = {
    id: r.id, title: r.title, short: k.short, full: k.full, fullName: r.full_name, sport: r.sport, orderNo: r.order_no, orderDate: r.order_date == null ? null : +r.order_date,
    issuer: r.issuer, comment: r.comment, status: r.status, auto: r.auto, autoAt: r.auto_at == null ? null : +r.auto_at, note: r.note,
    created: +r.created_at, decided: r.decided_at == null ? null : +r.decided_at, docs: docs.map(d => ({ id: d.id, mime: d.mime, url: '/api/titles/docs/' + d.id }))
  };
  if (full) Object.assign(out, { player: { id: r.player_id, name: r.player_name, code: r.player_code, title: r.player_title || '' }, search: KIND[r.title] && KIND[r.title].fed ? searchUrl(r) : null, decidedBy: r.decided_name || null });
  return out;
}
const REQ_SQL = `SELECT r.*, p.name AS player_name, p.code AS player_code, p.title AS player_title, d.name AS decided_name
  FROM title_requests r JOIN players p ON p.id = r.player_id LEFT JOIN players d ON d.id = r.decided_by`;

module.exports = async function (app) {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
    app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (req, body, done) => done(null, body));
  }

  app.get('/api/titles/kinds', async () => ({ kinds: kindsJSON() }));

  // POST /api/titles/docs — файл документа телом запроса (JPEG, PNG, WebP или PDF до 8 МБ) → { doc: { id, mime } }
  app.post('/api/titles/docs', { bodyLimit: MAX_BYTES }, async (req, reply) => {
    const me = needPlayer(req), buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw E.bad('Нужен файл: фото (JPEG, PNG, WebP) или PDF', 'body');
    const t = sniff(buf);
    if (!t) throw E.bad('Это не фото и не PDF', 'body');
    // за сутки не больше 20 файлов; прикреплённые к заявке не считаются, старые неприкреплённые удаляются
    const stale = await all(pool, 'DELETE FROM title_docs WHERE player_id = $1 AND request_id IS NULL AND created_at < $2 RETURNING file', [me.id, Date.now() - 864e5]);
    unlink(stale.map(x => x.file));
    if ((await one(pool, 'SELECT count(*)::int AS n FROM title_docs WHERE player_id = $1 AND request_id IS NULL', [me.id])).n >= 20) throw E.conflict('conflict', 'Слишком много файлов без заявки — отправьте заявку или повторите завтра');
    const id = crypto.randomBytes(12).toString('hex'), file = id + '.' + t[0];
    await fs.promises.mkdir(config.privateDir, { recursive: true });
    await fs.promises.writeFile(fileOf(file), buf);
    await pool.query('INSERT INTO title_docs (id, player_id, file, mime, bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [id, me.id, file, t[1], buf.length, Date.now()]);
    return reply.code(201).send({ doc: { id, mime: t[1], url: '/api/titles/docs/' + id } });
  });

  // файл документа: владелец или проверяющий (право titles)
  app.get('/api/titles/docs/:id', async (req, reply) => {
    const me = needPlayer(req);
    const d = await one(pool, 'SELECT * FROM title_docs WHERE id = $1', [String(req.params.id)]);
    if (!d || (d.player_id !== me.id && !can(me, 'titles'))) throw E.notFound('Файл не найден');
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').type(d.mime);
    if (d.mime === 'application/pdf') reply.header('Content-Disposition', 'inline; filename="document.pdf"');
    return reply.send(fs.createReadStream(fileOf(d.file)));
  });

  // POST /api/titles — { fullName, title, orderNo, orderDate, issuer, comment, docs: [id] } → заявка после автопроверки
  app.post('/api/titles', async (req, reply) => {
    const me = needPlayer(req), b = req.body || {};
    const title = V.oneOf(b.title, 'title', Object.keys(KIND));
    const fullName = V.str(b.fullName, 'fullName', 5, 100);
    const orderNo = V.str(b.orderNo, 'orderNo', 1, 40), orderDate = V.optTime(b.orderDate, 'orderDate');
    if (!orderDate) throw E.bad('Укажите дату приказа', 'orderDate');
    const issuer = V.str(b.issuer, 'issuer', 2, 120), comment = V.optStr(b.comment, 'comment', 500);
    const docs = Array.isArray(b.docs) ? [...new Set(b.docs.map(String))] : [];
    if (!docs.length) throw E.bad('Приложите фото или скан документа', 'docs');
    if (docs.length > MAX_DOCS) throw E.bad('Не больше ' + MAX_DOCS + ' файлов', 'docs');
    const r = await tx(async c => {
      const p = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [me.id]);
      if (await one(c, `SELECT 1 FROM title_requests WHERE player_id = $1 AND status = 'review'`, [me.id])) throw E.conflict('conflict', 'Заявка уже на проверке — дождитесь решения или отзовите её');
      const own = await all(c, 'SELECT id FROM title_docs WHERE id = ANY($1) AND player_id = $2 AND request_id IS NULL', [docs, me.id]);
      if (own.length !== docs.length) throw E.bad('Файл не найден — загрузите документ ещё раз', 'docs');
      const row = await one(c, `INSERT INTO title_requests (player_id, full_name, title, order_no, order_date, issuer, comment, status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'review', $8) RETURNING *`, [me.id, fullName, title, orderNo, orderDate, issuer, comment, Date.now()]);
      await c.query('UPDATE title_docs SET request_id = $1 WHERE id = ANY($2)', [row.id, docs]);
      // автоматическая проверка — сразу, в той же транзакции
      const checks = await autoCheck(c, row, p);
      const out = await one(c, 'UPDATE title_requests SET auto = $2, auto_at = $3 WHERE id = $1 RETURNING *', [row.id, JSON.stringify(checks), Date.now()]);
      await audit(c, me, 'title.submit', { id: me.id, name: me.name }, { title: KIND[title].short, order: orderNo });
      return out;
    });
    return reply.code(201).send({ request: await reqJSON(pool, r) });
  });

  // мои заявки, новые сверху; title — подтверждённое сейчас звание
  app.get('/api/titles/mine', async req => {
    const me = needPlayer(req);
    const rows = await all(pool, 'SELECT * FROM title_requests WHERE player_id = $1 ORDER BY created_at DESC LIMIT 20', [me.id]);
    const p = await one(pool, 'SELECT title FROM players WHERE id = $1', [me.id]);
    return { title: p.title || '', requests: await Promise.all(rows.map(r => reqJSON(pool, r))) };
  });

  // отозвать свою заявку, пока её не проверили
  app.delete('/api/titles/:id', async req => {
    const me = needPlayer(req);
    const r = await one(pool, `UPDATE title_requests SET status = 'cancelled', decided_at = $3 WHERE id = $1 AND player_id = $2 AND status = 'review' RETURNING *`, [req.params.id, me.id, Date.now()]);
    if (!r) throw E.notFound('Заявки на проверке нет');
    return { request: await reqJSON(pool, r) };
  });

  // администратор: заявки (по умолчанию ждущие проверки, старые сверху)
  app.get('/api/admin/titles', async req => {
    needPerm(req, 'titles', 'Звания проверяет администратор');
    const st = req.query.status ? V.oneOf(req.query.status, 'status', ['review', 'approved', 'rejected', 'cancelled', 'all']) : 'review';
    const rows = await all(pool, REQ_SQL + (st === 'all' ? '' : ' WHERE r.status = $1') + ' ORDER BY r.created_at ' + (st === 'review' ? 'ASC' : 'DESC') + ' LIMIT 100', st === 'all' ? [] : [st]);
    return { requests: await Promise.all(rows.map(r => reqJSON(pool, r, true))) };
  });

  // решение: { status: approved | rejected, note } — при отказе комментарий обязателен
  app.patch('/api/admin/titles/:id', async req => {
    const me = needPerm(req, 'titles', 'Звания проверяет администратор'), b = req.body || {};
    const status = V.oneOf(b.status, 'status', ['approved', 'rejected']), note = V.optStr(b.note, 'note', 300);
    if (status === 'rejected' && !note) throw E.bad('Напишите, почему отклонено — игрок увидит это', 'note');
    const r = await tx(async c => {
      const cur = await one(c, 'SELECT * FROM title_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!cur) throw E.notFound('Заявка не найдена');
      if (cur.status !== 'review') throw E.conflict('bad_state', 'Заявка уже рассмотрена');
      const out = await one(c, 'UPDATE title_requests SET status = $2, note = $3, decided_by = $4, decided_at = $5 WHERE id = $1 RETURNING *', [cur.id, status, note, me.id, Date.now()]);
      const p = await one(c, 'SELECT id, name FROM players WHERE id = $1', [cur.player_id]);
      if (status === 'approved') await c.query('UPDATE players SET title = $2, title_req = $3 WHERE id = $1', [cur.player_id, KIND[cur.title].short, cur.id]);
      await audit(c, me, 'title.' + status, p, { title: KIND[cur.title].short, note });
      return one(c, REQ_SQL + ' WHERE r.id = $1', [out.id]);
    });
    clearCache();
    return { request: await reqJSON(pool, r, true) };
  });

  // снять подтверждённое звание (ошибка, лишение звания): { note }
  app.delete('/api/admin/players/:id/title', async req => {
    const me = needPerm(req, 'titles', 'Звания снимает администратор'), note = V.optStr((req.body || {}).note, 'note', 300);
    await tx(async c => {
      const p = await one(c, 'SELECT * FROM players WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!p) throw E.notFound('Игрок не найден');
      if (!p.title) throw E.conflict('conflict', 'Звания нет');
      await c.query(`UPDATE players SET title = '', title_req = NULL WHERE id = $1`, [p.id]);
      await audit(c, me, 'title.revoke', p, { title: p.title, note });
    });
    clearCache();
    return { ok: true };
  });
};

module.exports.unlink = unlink;
