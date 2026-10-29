// Время у мишени. Ход игрока — от предыдущего подхода (или начала матча) до его подхода: соперник внёс свой —
// пошло время этого игрока, он внёс — пошло время следующего. Момент подхода — с телефона (at), без него — когда
// событие пришло на сервер. Паузы дольше 5 минут (смена лега, перерыв) в среднее не идут.
const { all } = require('./db');

const BREAK = 5 * 6e4;

// подходы матча с моментами: отменённые убраны, бросок в булл сдвигает отсчёт
function timedVisits(rows) {
  const vis = [];
  for (const e of rows) {
    const at = e.data && Number.isFinite(e.data.at) ? e.data.at : +e.t;
    if (e.type === 'visit') vis.push({ p: e.data.p, at });
    else if (e.type === 'bull') vis.push({ p: e.data.p, at, tb: true });
    else if (e.type === 'undo') vis.pop();
  }
  return vis;
}

// по игрокам матча: подходов, время ходов (мс), самый долгий ход
function matchTimes(m, rows) {
  const per = m.players.map(() => ({ n: 0, ms: 0, max: 0 }));
  let prev = +m.started || null;
  for (const v of timedVisits(rows)) {
    const d = prev == null ? 0 : v.at - prev;
    prev = v.at;
    if (v.tb || d <= 0 || d > BREAK || !per[v.p]) continue;
    per[v.p].n++; per[v.p].ms += d; per[v.p].max = Math.max(per[v.p].max, d);
  }
  return { dur: m.started && m.finished ? +m.finished - +m.started : null, per: per.map(x => ({ n: x.n, avg: x.n ? Math.round(x.ms / x.n) : null, ms: x.ms, max: x.max || null })) };
}

const avg = a => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : null;

// весь турнир: сколько идёт, средний и самый долгий матч, попытки квалификации, игроки — среднее время на подход
async function tourTimes(c, t) {
  const ms = await all(c, `SELECT id, players, started, finished, status, q_player, r, i FROM matches WHERE tournament_id = $1 AND NOT quick ORDER BY started`, [t.id]);
  const evs = ms.length ? await all(c, 'SELECT match_id, seq, type, data, t FROM match_events WHERE match_id = ANY($1) ORDER BY match_id, seq', [ms.map(m => m.id)]) : [];
  const by = new Map();
  evs.forEach(e => { if (!by.has(e.match_id)) by.set(e.match_id, []); by.get(e.match_id).push(e); });
  const pl = new Map(), done = [], qual = [];
  for (const m of ms) {
    const x = matchTimes(m, by.get(m.id) || []), fin = m.status === 'done' && x.dur != null && x.dur > 0;
    if (fin) (m.q_player ? qual : done).push({ id: m.id, dur: x.dur, players: m.players.map(p => p.name), r: m.r, i: m.i });
    m.players.forEach((p, k) => {
      if (!p.id) return;
      const a = pl.get(p.id) || { id: p.id, name: p.name, n: 0, ms: 0, max: 0, matches: 0, board: 0 };
      a.n += x.per[k].n; a.ms += x.per[k].ms; a.max = Math.max(a.max, x.per[k].max || 0);
      if (fin) { a.matches++; a.board += x.dur; }
      pl.set(p.id, a);
    });
  }
  const began = ms.length ? Math.min(...ms.map(m => +m.started).filter(Boolean)) : null;
  const ended = t.status === 'done' ? Math.max(...ms.map(m => +m.finished || 0), 0) || null : null;
  const longest = done.slice().sort((a, b) => b.dur - a.dur)[0] || null, fastest = done.slice().sort((a, b) => a.dur - b.dur)[0] || null;
  const players = [...pl.values()].filter(a => a.n).map(a => ({ id: a.id, name: a.name, visits: a.n, avg: Math.round(a.ms / a.n), max: a.max || null, matches: a.matches, board: a.board }))
    .sort((a, b) => a.avg - b.avg);
  return {
    began: Number.isFinite(began) ? began : null, ended, now: Date.now(),
    matches: { n: done.length, avg: avg(done.map(x => x.dur)), longest, fastest },
    qual: { n: qual.length, avg: avg(qual.map(x => x.dur)) },
    players
  };
}

module.exports = { matchTimes, tourTimes, timedVisits, BREAK };
