// Разовый пересчёт статистики по новым правилам: итоги строк матча — из принятых подходов (а не из того, что прислал
// телефон), чужие дружеские матчи — не в статистике игрока. Запускается при старте, один раз (settings.stats_v).
const { one, all } = require('./db');
const { activeVisits, lineStats } = require('./darts');
const { refreshStats, eloAll } = require('./stats');

// 2 — строки матчей из подходов; 3 — рейтинг Эло только по официальным турнирам
const VERSION = 3;

async function fixStats(c) {
  const st = await one(c, `SELECT value FROM settings WHERE key = 'stats_v'`);
  const was = st ? +st.value : 0;
  if (was >= VERSION) return null;
  const ms = was >= 2 ? [] : await all(c, `SELECT * FROM matches WHERE status = 'done' AND NOT quick`);
  let fixed = 0;
  for (const m of ms) {
    const visits = activeVisits(await all(c, 'SELECT seq, type, data FROM match_events WHERE match_id = $1 ORDER BY seq', [m.id]));
    // матчи без подходов (старые демо-данные) не трогаем
    if (!visits.length) continue;
    const calc = lineStats(m, visits);
    for (const l of await all(c, 'SELECT idx, legs, darts FROM match_lines WHERE match_id = $1', [m.id])) {
      const x = calc[l.idx];
      if (!x) continue;
      await c.query(`UPDATE match_lines SET hi = $3, hco = $4, c180 = $5, c140 = $6, c100 = $7, coh = $8, coa = $9, bl = $10, f9 = $11 WHERE match_id = $1 AND idx = $2`,
        [m.id, l.idx, x.hi, x.hco, x.c180, x.c140, x.c100, l.legs, Math.max(Math.min(x.coa, l.darts), l.legs), x.bl, x.f9d ? Math.round(x.f9p / x.f9d * 30) / 10 : null]);
    }
    fixed++;
  }
  if (was < 3) await eloAll(c);
  const ids = was >= 2 ? [] : (await all(c, 'SELECT DISTINCT player_id FROM match_lines WHERE player_id IS NOT NULL')).map(r => r.player_id);
  for (let k = 0; k < ids.length; k += 500) await refreshStats(c, ids.slice(k, k + 500));
  await c.query(`INSERT INTO settings (key, value, updated_at) VALUES ('stats_v', $1, $2) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = $2`, [JSON.stringify(VERSION), Date.now()]);
  return { matches: fixed, players: ids.length };
}

module.exports = { fixStats };
