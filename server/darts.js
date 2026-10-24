// Проверка подходов счётчика. Состояние матча всегда пересчитывается из принятых подходов
// общим движком упражнений shared/games.js (тот же считает страница).
const Games = require('../shared/games.js');

const IMPOSSIBLE = Games.IMPOSSIBLE;

// упражнение матча: у старых матчей x01 по mode и dbl
const exOf = m => m.ex || Games.x01(m.mode, m.dbl);
const cfgOf = m => ({ ex: exOf(m), np: m.players.length, ltw: m.ltw, starter: m.starter });

// visits — принятые подходы (у x01 { leg, p, s, pts, n, b, d }, у упражнений { leg, p, v, d }, булл при ничьей { leg, p, tb })
const stateOf = (m, visits) => Games.state(cfgOf(m), visits);

// живое состояние для табло: лег, кто бросает, счёт лега (остатки x01 или очки упражнения), последний подход;
// у упражнений ещё подходы в леге, метки крикета и ничья (нужен бросок в булл)
function liveState(m, visits) {
  const st = stateOf(m, visits), v = st.last;
  const out = {
    leg: st.leg, cur: st.winner == null ? st.cur : null, scores: st.tot,
    // средний за подход (3 дротика) по всему матчу — для табло
    avg: st.pts.map((p, i) => st.darts[i] ? Math.round(p / st.darts[i] * 30) / 10 : null),
    last: v ? (v.tb ? { p: v.p, tb: 1 } : { p: v.p, pts: v.pts != null ? v.pts : v.v, n: v.n != null ? v.n : v.d ? v.d.length : 3, b: v.b || 0, d: v.d || null }) : null
  };
  if (m.ex) {
    out.vis = st.vis;
    if (st.marks) out.marks = st.marks;
    if (st.need) out.tie = st.tie;
  }
  return out;
}

// подход из события: только известные поля
function visitOf(m, ev) {
  if (ev.type === 'bull') return { leg: ev.leg, p: ev.p, tb: 1 };
  if (exOf(m).k === 'x01') return { leg: ev.leg, p: ev.p, s: ev.s, pts: ev.pts, n: ev.n, b: ev.b, d: ev.d == null ? null : ev.d };
  return { leg: ev.leg, p: ev.p, v: ev.v, d: ev.d == null ? null : ev.d };
}

// ошибка — текст; иначе null. Подход должен совпасть с тем, что считает сервер.
const checkVisit = (m, visits, v) => Games.check(cfgOf(m), visits, v);

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const LINE_INT = ['hi', 'hco', 'c180', 'c140', 'c100', 'coh', 'coa', 'bl'];
// итог матча из finish: леги, очки и дротики должны совпасть с подходами
function checkFinish(m, st, ev) {
  if (st.winner == null) return 'Матч ещё не выигран';
  if (ev.w !== st.winner) return 'Победитель — игрок ' + (st.winner + 1);
  if (!Array.isArray(ev.pl) || ev.pl.length !== m.players.length) return 'В pl нужна строка на каждого игрока';
  for (let k = 0; k < ev.pl.length; k++) {
    const l = ev.pl[k];
    if (!l || typeof l !== 'object') return 'Неверная строка pl[' + k + ']';
    if ((l.id || null) !== (m.players[k].id || null)) return 'pl[' + k + '].id не совпадает с игроком';
    if (l.legs !== st.legs[k]) return 'pl[' + k + '].legs должно быть ' + st.legs[k];
    if (l.pts !== st.pts[k]) return 'pl[' + k + '].pts должно быть ' + st.pts[k];
    if (l.darts !== st.darts[k]) return 'pl[' + k + '].darts должно быть ' + st.darts[k];
    if (l.f9 != null && !(typeof l.f9 === 'number' && l.f9 >= 0 && l.f9 <= 180)) return 'pl[' + k + '].f9: 0–180 или null';
    for (const f of LINE_INT) if (l[f] != null && !isInt(l[f], 0, 100000)) return 'pl[' + k + '].' + f + ': целое число';
  }
  return null;
}

// строка для match_lines из finish (имя берём из матча, итоги легов — из подходов)
const lineOf = (m, l, k, st) => ({
  idx: k, player_id: m.players[k].id || null, name: m.players[k].name, legs: l.legs, pts: l.pts, darts: l.darts,
  f9: l.f9 == null ? null : Math.round(l.f9 * 10) / 10, hi: l.hi || 0, hco: l.hco || 0, c180: l.c180 || 0, c140: l.c140 || 0,
  c100: l.c100 || 0, coh: l.coh != null ? l.coh : l.legs, coa: Math.max(l.coa || 0, l.legs), bl: l.bl || 0,
  sc: m.ex && st ? st.legsLog.map(L => L.tot[k]) : null
});

module.exports = { IMPOSSIBLE, exOf, stateOf, liveState, visitOf, checkVisit, checkFinish, lineOf };
