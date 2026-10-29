// Игроки, профиль, рейтинг, лента.
const { pool, tx, one, all } = require('../db');
const { E, V } = require('../errors');
const { needPlayer } = require('../auth');
const { atLeast } = require('../roles');
const { createPlayer, playerShort } = require('../players');
const { statsJSON, TRUSTED } = require('../stats');
const { matchCards } = require('../cards');
const { TOUR_SQL, loadTours, tourCard } = require('../tour');

const lim = (v, def, max) => Math.min(max, Math.max(1, +v || def));
const R = require('../regions');
const before = v => v == null ? Number.MAX_SAFE_INTEGER : Math.max(0, +v || 0);
// поиск как на странице: имя, @handle, код OCH-1003 или #1003
function searchSql(q, arg, alias) {
  const s = String(q).trim().toLowerCase();
  if (!s) return null;
  const p = alias ? alias + '.' : '';
  return `(position(${arg(s)} in lower(${p}name)) > 0 OR position(${arg(s.replace(/^@/, ''))} in ${p}handle) > 0 OR position(${arg(s.replace(/^#/, ''))} in lower(${p}code)) > 0)`;
}

async function playerMatches(c, id, scope, bef, limit) {
  const ms = await all(c, `SELECT m.* FROM matches m JOIN match_lines l ON l.match_id = m.id AND l.player_id = $1
    WHERE m.status = 'done' AND m.finished < $2 AND ${TRUSTED('l', 'm')} ${scope === 'tour' ? 'AND m.tournament_id IS NOT NULL' : ''}
    ORDER BY m.finished DESC, m.id LIMIT ${limit}`, [id, bef]);
  return matchCards(c, ms);
}

// города и области игроков рейтинга для фильтра: общие для всех запросов, пересчёт раз в минуту
let geoCache = null;
async function ratingGeo() {
  if (geoCache && geoCache.at > Date.now() - 60000) return geoCache;
  const cityRows = await all(pool, `SELECT city, count(*)::int AS n FROM players WHERE rated > 0 AND NOT lite AND city <> '' GROUP BY city ORDER BY city`);
  // области, где есть игроки в рейтинге; по убыванию числа игроков
  const regs = new Map();
  cityRows.forEach(x => { const r = R.regionOf(x.city); if (r) regs.set(r, (regs.get(r) || 0) + x.n); });
  geoCache = { at: Date.now(), cities: cityRows.map(x => x.city), regions: [...regs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru')).map(([name, n]) => ({ name, n })) };
  return geoCache;
}

module.exports = async function (app) {
  app.get('/api/players', async req => {
    const args = [], arg = v => { args.push(v); return '$' + args.length; };
    const w = searchSql(req.query.q || '', arg);
    const rows = await all(pool, 'SELECT * FROM players' + (w ? ' WHERE ' + w : '') + ` ORDER BY rated > 0 DESC, rating DESC, name LIMIT ${lim(req.query.limit, 20, 50)}`, args);
    return { players: rows.map(playerShort) };
  });

  app.post('/api/players', async req => {
    const me = needPlayer(req), b = req.body || {};
    const name = V.str(b.name, 'name', 2, 32), city = b.city == null ? me.city : V.optStr(b.city, 'city', 40);
    const p = await tx(async c => {
      const same = await one(c, 'SELECT * FROM players WHERE owner_id = $1 AND vk_id IS NULL AND lower(name) = lower($2)', [me.id, name]);
      if (same) return same;
      // квота от засорения: игроку 100 новых гостей в сутки, ведущему и выше — 1000
      const day = await one(c, 'SELECT count(*)::int AS n FROM players WHERE owner_id = $1 AND created_at > $2', [me.id, Date.now() - 864e5]);
      if (day.n >= (atLeast(me, 'host') ? 1000 : 100)) throw E.quota('Слишком много новых игроков за сутки — продолжите завтра');
      return createPlayer(c, { name, city, owner_id: me.id });
    });
    return { player: playerShort(p) };
  });

  app.get('/api/players/:id', async req => {
    const p = await one(pool, 'SELECT * FROM players WHERE id = $1', [req.params.id]);
    if (!p) throw E.notFound('Игрок не найден');
    const st = await all(pool, 'SELECT * FROM player_stats WHERE player_id = $1', [p.id]);
    // лайт-профиль в общий рейтинг не входит
    const rank = p.rated > 0 && !p.lite ? (await one(pool, 'SELECT count(*) + 1 AS n FROM players WHERE rated > 0 AND NOT lite AND rating > $1', [p.rating])).n : null;
    // лучшее среднее за матч x01 (от 9 дротиков) — для достижений
    const best = await one(pool, `SELECT max(l.pts::float8 / l.darts * 3) AS a FROM match_lines l JOIN matches m ON m.id = l.match_id
      WHERE l.player_id = $1 AND m.status = 'done' AND m.q_player IS NULL AND (m.ex IS NULL OR m.ex->>'k' = 'x01') AND l.darts >= 9 AND ${TRUSTED('l', 'm')}`, [p.id]);
    const tours = await all(pool, `SELECT t.id, t.name, t.start, t.status, t.format, e.place_lo, e.place_hi FROM entries e
      JOIN tournaments t ON t.id = e.tournament_id WHERE e.player_id = $1 ORDER BY t.start DESC LIMIT 100`, [p.id]);
    return {
      player: playerShort(p), rank, bestAvg: best.a == null ? null : Math.round(best.a * 10) / 10,
      stats: { all: statsJSON(st.find(x => x.scope === 'all')), tour: statsJSON(st.find(x => x.scope === 'tour')) },
      matches: await playerMatches(pool, p.id, 'all', before(null), 50),
      tournaments: tours.map(t => ({ id: t.id, name: t.name, start: t.start, status: t.status, format: t.format, place: t.place_lo == null ? null : [t.place_lo, t.place_hi] }))
    };
  });

  app.get('/api/players/:id/matches', async req => {
    const scope = req.query.scope == null ? 'all' : V.oneOf(req.query.scope, 'scope', ['all', 'tour']);
    return { matches: await playerMatches(pool, req.params.id, scope, before(req.query.before), lim(req.query.limit, 50, 100)) };
  });

  // справочник «город → область»: фильтр рейтинга и подсказки городов в профиле
  app.get('/api/regions', async (req, reply) => { reply.header('Cache-Control', 'public, max-age=86400'); return { regions: R.REGIONS }; });

  app.get('/api/rating', async req => {
    const q = req.query, args = [], arg = v => { args.push(v); return '$' + args.length; };
    const sort = q.sort == null ? 'r' : V.oneOf(q.sort, 'sort', ['r', 'avg']);
    const where = ['p.rated > 0', 'NOT p.lite'], city = R.citySql('p.city');
    if (q.city) where.push('p.city = ' + arg(String(q.city)));
    // область: её города; поиск — по имени, ID, городу или области («свердл», «екатеринбург»)
    if (q.region) where.push(city + ' = ANY(' + arg(R.citiesOf(String(q.region))) + ')');
    const s = searchSql(q.q || '', arg, 'p');
    if (s) {
      const qs = R.norm(q.q), regs = R.findRegions(q.q).flatMap(R.citiesOf);
      where.push('(' + s + ' OR position(' + arg(qs) + ' in ' + city + ') > 0' + (regs.length ? ' OR ' + city + ' = ANY(' + arg(regs) + ')' : '') + ')');
    }
    const limit = lim(q.limit, 50, 200), offset = Math.max(0, +q.offset || 0);
    const avg = 'CASE WHEN s.darts > 0 THEN s.pts::float8 / s.darts * 3 ELSE 0 END';
    const from = ` FROM players p LEFT JOIN player_stats s ON s.player_id = p.id AND s.scope = 'tour' WHERE ${where.join(' AND ')}`;
    const total = (await one(pool, 'SELECT count(*) AS n' + from, args)).n;
    const rows = await all(pool, `SELECT p.id, p.name, p.city, p.club, p.photo, p.rating, p.rated, ${avg} AS avg` + from +
      ` ORDER BY ${sort === 'avg' ? avg + ' DESC, p.rating DESC' : 'p.rating DESC'}, p.id LIMIT ${limit} OFFSET ${offset}`, args);
    const geo = await ratingGeo();
    return {
      total, cities: geo.cities, regions: geo.regions,
      rows: rows.map((x, k) => ({ rank: offset + k + 1, id: x.id, name: x.name, city: x.city, region: R.regionOf(x.city), club: x.club, photo: x.photo || null, r: Math.round(x.rating), avg: Math.round(x.avg * 10) / 10, n: x.rated }))
    };
  });

  app.get('/api/feed', async req => {
    const q = req.query, scope = q.scope == null ? 'all' : V.oneOf(q.scope, 'scope', ['all', 'my']);
    const me = scope === 'my' ? needPlayer(req) : null, bef = before(q.before), limit = lim(q.limit, 30, 50);
    // в ленте — только матчи, засчитанные всем их игрокам (чужой дружеский матч от имени игрока не показываем)
    const ms = await all(pool, `SELECT m.* FROM matches m WHERE m.status = 'done' AND m.q_player IS NULL AND m.finished < $1
      AND NOT EXISTS (SELECT 1 FROM match_lines l2 WHERE l2.match_id = m.id AND l2.player_id IS NOT NULL AND NOT ${TRUSTED('l2', 'm')})
      ${me ? 'AND EXISTS (SELECT 1 FROM match_lines l WHERE l.match_id = m.id AND l.player_id = $2)' : ''}
      ORDER BY m.finished DESC, m.id LIMIT ${limit}`, me ? [bef, me.id] : [bef]);
    // турнир в ленте — сразу после последнего матча, как на странице
    const ts = await all(pool, TOUR_SQL + ` WHERE t.status = 'done' AND t.done_at + 1 < $1
      ${me ? 'AND EXISTS (SELECT 1 FROM entries e WHERE e.tournament_id = t.id AND e.player_id = $2)' : ''}
      ORDER BY t.done_at DESC LIMIT ${limit}`, me ? [bef, me.id] : [bef]);
    const items = (await matchCards(pool, ms)).map(m => ({ type: 'match', t: m.t, match: m }))
      .concat((await loadTours(pool, ts)).map(t => ({ type: 'tournament', t: t._row.done_at + 1, tournament: tourCard(t, req.player) })));
    return { items: items.sort((a, b) => b.t - a.t).slice(0, limit) };
  });
};
