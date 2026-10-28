// Очистка сервера от демо-данных: все турниры и матчи, клубы, баннеры и игроки, которые не могут войти сами.
// Остаются аккаунты с логином, почтой, телефоном или VK и аккаунты, которые они завели (вход по коду);
// у оставшихся рейтинг и статистика обнуляются, клуб очищается. Вызывают tools/clean.js и панель (POST /api/admin/cleanup).
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');
const { pool, tx, one, all } = require('./db');

// keep — id, которые остаются в любом случае (тот, кто запустил очистку)
async function cleanAll(keep) {
  const n = await tx(async c => {
    const cnt = async sql => (await one(c, sql)).n;
    const out = { tours: await cnt('SELECT count(*)::int AS n FROM tournaments'), matches: await cnt('SELECT count(*)::int AS n FROM matches'), players: await cnt('SELECT count(*)::int AS n FROM players') };
    // кто останется: может войти сам, или его завёл такой аккаунт
    await c.query(`CREATE TEMP TABLE keep ON COMMIT DROP AS
      SELECT id FROM players WHERE login IS NOT NULL OR email IS NOT NULL OR phone IS NOT NULL OR vk_id IS NOT NULL`);
    if (keep && keep.length) await c.query('INSERT INTO keep SELECT id FROM players WHERE id = ANY($1) AND id NOT IN (SELECT id FROM keep)', [keep]);
    await c.query(`INSERT INTO keep SELECT id FROM players WHERE owner_id IN (SELECT id FROM keep) AND id NOT IN (SELECT id FROM keep)`);
    await c.query('UPDATE tournaments SET cover = NULL');
    await c.query('DELETE FROM matches');
    await c.query('DELETE FROM tournaments');
    await c.query('DELETE FROM banners');
    await c.query('DELETE FROM clubs');
    await c.query('DELETE FROM players WHERE id NOT IN (SELECT id FROM keep)');
    await c.query('DELETE FROM player_stats');
    await c.query(`UPDATE players SET rating = 1500, rated = 0, club = ''`);
    out.kept = await cnt('SELECT count(*)::int AS n FROM players');
    out.removed = out.players - out.kept;
    return out;
  });
  // файлы фото, на которые больше никто не ссылается
  n.files = 0;
  if (fs.existsSync(config.uploadDir)) {
    const used = new Set((await all(pool, `SELECT file FROM photos UNION SELECT regexp_replace(photo, '^.*/', '') FROM players WHERE photo IS NOT NULL`)).map(x => x.file));
    for (const f of fs.readdirSync(config.uploadDir)) {
      const full = path.join(config.uploadDir, f);
      if (!used.has(f) && fs.statSync(full).isFile()) { fs.unlinkSync(full); n.files++; }
    }
  }
  return n;
}

module.exports = { cleanAll };
