// Рейтинг Эло и готовая статистика игроков. Считается после матча, а не при каждом запросе.
const { all } = require('./db');

const K = 32;
const expect = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

// новый турнирный матч всегда последний по времени, поэтому достаточно сдвинуть двоих
async function eloAdd(c, a, b, aWon) {
  const rows = await all(c, 'SELECT id, rating FROM players WHERE id = ANY($1) FOR UPDATE', [[a, b]]);
  const ra = rows.find(x => x.id === a), rb = rows.find(x => x.id === b);
  if (!ra || !rb) return;
  const d = K * ((aWon ? 1 : 0) - expect(ra.rating, rb.rating));
  await c.query('UPDATE players SET rating = rating + $2, rated = rated + 1 WHERE id = $1', [a, d]);
  await c.query('UPDATE players SET rating = rating - $2, rated = rated + 1 WHERE id = $1', [b, d]);
}

// полный пересчёт: после отмены результата или удаления турнира (как recalc() на странице).
// В рейтинг идут только официальные турниры (клубные — тоже официальные)
async function eloAll(c) {
  const ms = await all(c, `SELECT m.w, a.player_id AS a, b.player_id AS b FROM matches m JOIN tournaments t ON t.id = m.tournament_id AND t.official
    JOIN match_lines a ON a.match_id = m.id AND a.idx = 0 JOIN match_lines b ON b.match_id = m.id AND b.idx = 1
    WHERE m.status = 'done' AND a.player_id IS NOT NULL AND b.player_id IS NOT NULL
    ORDER BY m.finished, m.id`);
  const r = new Map(), n = new Map(), get = id => r.has(id) ? r.get(id) : 1500;
  ms.forEach(m => {
    const d = K * ((m.w === 0 ? 1 : 0) - expect(get(m.a), get(m.b)));
    r.set(m.a, get(m.a) + d); r.set(m.b, get(m.b) - d);
    n.set(m.a, (n.get(m.a) || 0) + 1); n.set(m.b, (n.get(m.b) || 0) + 1);
  });
  await c.query('UPDATE players SET rating = 1500, rated = 0 WHERE rated <> 0 OR rating <> 1500');
  const ids = [...r.keys()];
  if (ids.length) await c.query(`UPDATE players p SET rating = x.r, rated = x.n FROM unnest($1::text[], $2::float8[], $3::int[]) AS x(id, r, n) WHERE p.id = x.id`,
    [ids, ids.map(id => r.get(id)), ids.map(id => n.get(id))]);
}

// матч засчитан игроку: турнирный, или его вёл сам игрок, или игрок — гость того, кто вёл, или игрок сам подтвердил матч.
// Дружеский матч с чужим аккаунтом может создать кто угодно — в статистику, профиль и ленту этого игрока он идёт
// только после подтверждения («да, я играл»)
const OWN = (l, m) => `(${m}.tournament_id IS NOT NULL OR ${m}.created_by = ${l}.player_id OR EXISTS (SELECT 1 FROM players tp WHERE tp.id = ${l}.player_id AND tp.owner_id = ${m}.created_by))`;
const TRUSTED = (l, m) => `(${OWN(l, m)} OR ${l}.confirmed IS TRUE)`;
// ждёт ответа игрока: чужой дружеский матч, на который он ещё не ответил
const PENDING = (l, m) => `(${l}.player_id IS NOT NULL AND ${l}.confirmed IS NULL AND ${m}.status = 'done' AND NOT ${OWN(l, m)})`;

const FIELDS = ['n', 'w', 'pts', 'darts', 'f9s', 'f9n', 'coh', 'coa', 'hco', 'hi', 'c180', 'c140', 'c100', 'bl'];

// как pStats() на странице, для «всех матчей» и «турнирных»
async function refreshStats(c, ids) {
  ids = [...new Set(ids.filter(Boolean))];
  if (!ids.length) return;
  // попытки квалификации — не матчи; упражнения считаются матчами, но в средние x01 не входят
  const rows = await all(c, `SELECT l.*, m.mode, m.ex, m.w AS mw, m.tournament_id IS NOT NULL AS tour FROM match_lines l
    JOIN matches m ON m.id = l.match_id WHERE l.player_id = ANY($1) AND m.status = 'done' AND m.q_player IS NULL AND ${TRUSTED('l', 'm')}`, [ids]);
  const acc = {};
  ids.forEach(id => { acc[id] = { all: blank(), tour: blank() }; });
  rows.forEach(l => {
    add(acc[l.player_id].all, l);
    if (l.tour) add(acc[l.player_id].tour, l);
  });
  const vals = [], args = [];
  ids.forEach(id => ['all', 'tour'].forEach(sc => {
    const o = acc[id][sc], base = args.length;
    args.push(id, sc, ...FIELDS.map(f => o[f]));
    vals.push('(' + Array.from({ length: FIELDS.length + 2 }, (_, k) => '$' + (base + k + 1)).join(',') + ')');
  }));
  await c.query(`INSERT INTO player_stats (player_id, scope, ${FIELDS.join(',')}) VALUES ${vals.join(',')}
    ON CONFLICT (player_id, scope) DO UPDATE SET ${FIELDS.map(f => f + ' = EXCLUDED.' + f).join(',')}`, args);
}
const blank = () => Object.fromEntries(FIELDS.map(f => [f, 0]));
function add(o, l) {
  o.n++;
  if (l.mw === l.idx) o.w++;
  if (l.ex && l.ex.k !== 'x01') return;
  o.pts += l.pts; o.darts += l.darts;
  if (l.f9 != null) { o.f9s += l.f9; o.f9n++; }
  o.coh += l.coh; o.coa += l.coa;
  o.hco = Math.max(o.hco, l.hco); o.hi = Math.max(o.hi, l.hi);
  o.c180 += l.c180; o.c140 += l.c140; o.c100 += l.c100;
  if (l.mode === 501 && l.bl && (!o.bl || l.bl < o.bl)) o.bl = l.bl;
}

const r1 = v => Math.round(v * 10) / 10;
// Stats из api.md
function statsJSON(o) {
  o = o || blank();
  return {
    n: o.n, w: o.w, pts: o.pts, darts: o.darts, avg: o.darts ? r1(o.pts / o.darts * 3) : null, f9: o.f9n ? r1(o.f9s / o.f9n) : null,
    coh: o.coh, coa: o.coa, hco: o.hco, hi: o.hi, c180: o.c180, c140: o.c140, c100: o.c100, bl: o.bl
  };
}

module.exports = { eloAdd, eloAll, refreshStats, statsJSON, TRUSTED, PENDING };
