// Статистика Pro: из строк сыгранных матчей и подходов счётчика. Считается по запросу и только для себя;
// личные встречи — с любым игроком; выгрузка всех матчей в CSV для Excel.
const Games = require('../shared/games.js');
const { all, one } = require('./db');
const { activeVisits } = require('./darts');
const { matchCards } = require('./cards');
const { TRUSTED } = require('./stats');

const DAY = 864e5, MAX_MATCHES = 500;
const PERIODS = { 30: 30, 90: 90, 365: 365, all: 0 };
const X01_SQL = `(m.ex IS NULL OR m.ex->>'k' = 'x01')`;
const r1 = v => Math.round(v * 10) / 10;
const pct = (a, b) => b ? Math.round(a / b * 1000) / 10 : null;
// закрыть остаток одним подходом: с дублем — FIN, без дубля — SUM (1–3 дротика)
const canFinish = (s, dbl) => [1, 2, 3].some(n => (dbl ? Games.FIN : Games.SUM)[n].has(s));
const CO_BUCKETS = [[2, 40], [41, 80], [81, 120], [121, 170]];
// наборы вне зоны закрытия (остаток больше 170)
const BANDS = [[0, 39, '0–39'], [40, 59, '40–59'], [60, 99, '60–99'], [100, 139, '100–139'], [140, 179, '140–179'], [180, 180, '180']];

function summary(lines) {
  const o = { n: lines.length, w: 0, pts: 0, darts: 0, f9s: 0, f9n: 0, coh: 0, coa: 0, c180: 0, c140: 0, c100: 0, hco: 0 };
  lines.forEach(l => {
    if (l.mw === l.idx) o.w++;
    o.pts += l.pts; o.darts += l.darts;
    if (l.f9 != null) { o.f9s += l.f9; o.f9n++; }
    o.coh += l.coh; o.coa += l.coa; o.c180 += l.c180; o.c140 += l.c140; o.c100 += l.c100; o.hco = Math.max(o.hco, l.hco);
  });
  return { n: o.n, w: o.w, avg: o.darts ? r1(o.pts / o.darts * 3) : null, f9: o.f9n ? r1(o.f9s / o.f9n) : null, co: pct(o.coh, o.coa), c180: o.c180, c140: o.c140, c100: o.c100, hco: o.hco };
}

// форма: по неделям (с понедельника) или по месяцам; lines — по возрастанию времени
function form(lines, byMonth) {
  const key = t => {
    const d = new Date(t);
    return byMonth ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  };
  const m = new Map();
  lines.forEach(l => {
    const k = key(+l.finished), o = m.get(k) || { t: k, n: 0, pts: 0, darts: 0, coh: 0, coa: 0 };
    o.n++; o.pts += l.pts; o.darts += l.darts; o.coh += l.coh; o.coa += l.coa;
    m.set(k, o);
  });
  return [...m.values()].sort((a, b) => a.t - b.t).slice(-26).map(o => ({ t: o.t, n: o.n, avg: r1(o.pts / o.darts * 3), co: pct(o.coh, o.coa) }));
}

// подходы игрока в этих матчах: закрытия по остаткам и распределение наборов
async function visitStats(c, lines) {
  const out = { visits: 0, co: CO_BUCKETS.map(([lo, hi]) => ({ lo, hi, att: 0, hit: 0, pct: null })), top: [], bands: BANDS.map(([, , label]) => ({ label, n: 0, pct: null })) };
  if (!lines.length) return out;
  const byMatch = new Map(lines.map(l => [l.match_id, l]));
  const rows = await all(c, `SELECT match_id, type, data FROM match_events WHERE match_id = ANY($1) AND type IN ('visit', 'bull', 'undo') ORDER BY match_id, seq`, [[...byMatch.keys()]]);
  const ev = new Map();
  rows.forEach(e => { if (!ev.has(e.match_id)) ev.set(e.match_id, []); ev.get(e.match_id).push(e); });
  const rem = new Map();
  let scoring = 0;
  ev.forEach((list, mid) => {
    const l = byMatch.get(mid);
    activeVisits(list).forEach(v => {
      if (v.tb || v.p !== l.idx || v.s == null) return;
      out.visits++;
      const hit = !v.b && v.s === v.pts;
      if (canFinish(v.s, l.dbl)) {
        const b = out.co.find(x => v.s >= x.lo && v.s <= x.hi);
        if (b) { b.att++; if (hit) b.hit++; }
        const r = rem.get(v.s) || { s: v.s, att: 0, hit: 0 };
        r.att++; if (hit) r.hit++;
        rem.set(v.s, r);
      } else if (v.s > 170 && v.n === 3) {
        scoring++;
        out.bands[BANDS.findIndex(([lo, hi]) => v.pts >= lo && v.pts <= hi)].n++;
      }
    });
  });
  out.co.forEach(b => { b.pct = pct(b.hit, b.att); });
  out.bands.forEach(b => { b.pct = pct(b.n, scoring); });
  out.top = [...rem.values()].sort((a, b) => b.att - a.att || b.s - a.s).slice(0, 12).map(r => Object.assign(r, { pct: pct(r.hit, r.att) }));
  return out;
}

// рекорды упражнений за всё время: лучший лег каждого упражнения
async function records(c, pid) {
  const rows = await all(c, `SELECT l.pts, l.sc, m.ex, m.finished FROM match_lines l JOIN matches m ON m.id = l.match_id
    WHERE l.player_id = $1 AND m.status = 'done' AND m.ex IS NOT NULL AND m.ex->>'k' <> 'x01' AND ${TRUSTED('l', 'm')}`, [pid]);
  const by = new Map();
  rows.forEach(r => {
    const ex = Games.norm(r.ex);
    if (!ex) return;
    const label = Games.label(ex), legs = Array.isArray(r.sc) && r.sc.length ? r.sc : [r.pts];
    const o = by.get(label) || { label, unit: Games.unit(ex).tot, best: -1, at: null, legs: 0 };
    legs.forEach(v => { o.legs++; if (v > o.best) { o.best = v; o.at = +r.finished; } });
    by.set(label, o);
  });
  return [...by.values()].sort((a, b) => b.legs - a.legs);
}

// сравнение с игроками своего уровня: рейтинг ±100, не меньше 100 подходов
async function peers(c, pid) {
  const me = await one(c, `SELECT p.rating, p.rated, s.pts, s.darts, s.coh, s.coa FROM players p LEFT JOIN player_stats s ON s.player_id = p.id AND s.scope = 'all' WHERE p.id = $1`, [pid]);
  if (!me || !me.rated || !me.darts) return null;
  const rows = await all(c, `SELECT s.pts, s.darts, s.coh, s.coa FROM player_stats s JOIN players p ON p.id = s.player_id
    WHERE s.scope = 'all' AND s.darts >= 300 AND p.rated > 0 AND NOT p.lite AND abs(p.rating - $1) <= 100 AND p.id <> $2`, [me.rating, pid]);
  const avg = me.pts / me.darts * 3, co = me.coa ? me.coh / me.coa : 0;
  const below = f => rows.length ? Math.round(rows.filter(f).length / rows.length * 100) : null;
  return {
    n: rows.length, lo: Math.round(me.rating - 100), hi: Math.round(me.rating + 100),
    avg: below(r => r.pts / r.darts * 3 < avg), co: below(r => (r.coa ? r.coh / r.coa : 0) < co)
  };
}

const LINES_SQL = `SELECT l.*, m.finished, m.w AS mw, m.dbl FROM match_lines l JOIN matches m ON m.id = l.match_id
  WHERE l.player_id = $1 AND m.status = 'done' AND m.q_player IS NULL AND ${X01_SQL} AND l.darts > 0 AND m.finished >= $2 AND m.finished < $3 AND ${TRUSTED('l', 'm')}
  ORDER BY m.finished DESC, m.id LIMIT ${MAX_MATCHES}`;

async function proStats(c, pid, period) {
  const days = PERIODS[period], now = Date.now(), since = days ? now - days * DAY : 0;
  const cur = await all(c, LINES_SQL, [pid, since, now + 1]);
  const prev = days ? await all(c, LINES_SQL, [pid, since - days * DAY, since]) : null;
  return {
    period: String(period), since: since || null,
    summary: summary(cur), prev: prev ? summary(prev) : null,
    form: form(cur.slice().reverse(), !days || days > 90),
    ...await visitStats(c, cur),
    records: await records(c, pid),
    peers: await peers(c, pid)
  };
}

// личные встречи me с other: все сыгранные матчи, где были оба
async function h2h(c, me, other) {
  const ms = await all(c, `SELECT m.* FROM matches m WHERE m.status = 'done' AND m.q_player IS NULL
    AND EXISTS (SELECT 1 FROM match_lines a WHERE a.match_id = m.id AND a.player_id = $1)
    AND EXISTS (SELECT 1 FROM match_lines b WHERE b.match_id = m.id AND b.player_id = $2)
    ORDER BY m.finished DESC, m.id LIMIT 300`, [me, other]);
  const cards = await matchCards(c, ms);
  const o = { n: cards.length, w: 0, l: 0, legs: [0, 0], pts: [0, 0], darts: [0, 0] };
  cards.forEach(m => {
    const i = m.pl.findIndex(x => x.id === me), j = m.pl.findIndex(x => x.id === other);
    if (m.w === i) o.w++; else if (m.w === j) o.l++;
    o.legs[0] += m.pl[i].legs; o.legs[1] += m.pl[j].legs;
    if (!m.ex || m.ex.k === 'x01') { o.pts[0] += m.pl[i].pts; o.darts[0] += m.pl[i].darts; o.pts[1] += m.pl[j].pts; o.darts[1] += m.pl[j].darts; }
  });
  return { n: o.n, w: o.w, l: o.l, legs: o.legs, avg: [0, 1].map(k => o.darts[k] ? r1(o.pts[k] / o.darts[k] * 3) : null), matches: cards.slice(0, 10) };
}

// все матчи игрока в CSV (разделитель «;», как ждёт русский Excel)
async function exportCsv(c, pid) {
  const rows = await all(c, `SELECT m.finished, m.ex, m.mode, m.w, m.q_player, t.name AS tname, l.idx, l.legs, l.pts, l.darts, l.f9, l.c180, l.hco, l.coh, l.coa,
    (SELECT string_agg(o.name, ', ' ORDER BY o.idx) FROM match_lines o WHERE o.match_id = m.id AND o.idx <> l.idx) AS opp,
    (SELECT string_agg(o.legs::text, ':' ORDER BY o.idx <> l.idx, o.idx) FROM match_lines o WHERE o.match_id = m.id) AS score
    FROM match_lines l JOIN matches m ON m.id = l.match_id LEFT JOIN tournaments t ON t.id = m.tournament_id
    WHERE l.player_id = $1 AND m.status = 'done' AND ${TRUSTED('l', 'm')} ORDER BY m.finished DESC, m.id LIMIT 20000`, [pid]);
  const cell = v => { const s = v == null ? '' : String(v); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const num = v => v == null ? '' : String(v).replace('.', ',');
  const head = ['Дата', 'Турнир', 'Игра', 'Соперник', 'Счёт', 'Итог', 'Среднее', 'Первые 9', '180', 'Закрытия', 'Макс. закрытие'];
  const lines = rows.map(r => {
    const ex = Games.norm(r.ex) || Games.x01(r.mode, true), x01 = ex.k === 'x01';
    return [
      new Date(+r.finished).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      r.tname || (r.q_player ? '' : 'дружеский'), (r.q_player ? 'квалификация · ' : '') + Games.label(ex), r.opp || '', r.score,
      r.w === r.idx ? 'победа' : r.opp ? 'поражение' : '',
      x01 && r.darts ? num(r1(r.pts / r.darts * 3)) : '', x01 ? num(r.f9) : '', x01 ? r.c180 : '',
      x01 && r.coa ? r.coh + ' из ' + r.coa : '', x01 && r.hco ? r.hco : ''
    ].map(cell).join(';');
  });
  return [head.join(';')].concat(lines).join('\r\n') + '\r\n';
}

module.exports = { PERIODS, proStats, h2h, exportCsv, canFinish };
