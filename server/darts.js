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

// подходы, которые остались после отмен; бросок в булл при ничьей — тоже подход
function activeVisits(rows) {
  const v = [];
  rows.forEach(e => { if (e.type === 'visit') v.push(e.data); else if (e.type === 'bull') v.push(Object.assign({ tb: 1 }, e.data)); else if (e.type === 'undo') v.pop(); });
  return v;
}

// подход из события: только известные поля
// at — момент подхода на телефоне (для статистики времени): принимается, если он в пределах матча
function visitOf(m, ev) {
  const at = Number.isFinite(ev.at) && ev.at >= (+m.started || 0) - 6e4 && ev.at <= Date.now() + 6e4 ? Math.round(ev.at) : null;
  const v = ev.type === 'bull' ? { leg: ev.leg, p: ev.p, tb: 1 }
    : exOf(m).k === 'x01' ? { leg: ev.leg, p: ev.p, s: ev.s, pts: ev.pts, n: ev.n, b: ev.b, d: ev.d == null ? null : ev.d }
      : { leg: ev.leg, p: ev.p, v: ev.v, d: ev.d == null ? null : ev.d };
  if (at != null) v.at = at;
  return v;
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

// дротик по подписи счётчика: «T20» 60, «D16» 32, «Bull» 50, «25», «7»; промах — 0
function dartVal(l) {
  const s = String(l == null ? '' : l), t = s.match(/^([TD]?)(\d{1,2})$/);
  if (s === 'Bull') return 50;
  if (!t) return 0;
  return +t[2] * (t[1] === 'T' ? 3 : t[1] === 'D' ? 2 : 1);
}
// закрытие с этого остатка одним дротиком и наименьшее число дротиков на закрытие
const oneDart = (rem, dbl) => rem > 0 && (dbl ? Games.FIN[1].has(rem) : rem <= 60 && Games.SUM[1].has(rem));
function minDarts(rem, dbl) { for (let n = 1; n <= 3; n++) if ((dbl ? Games.FIN[n] : Games.SUM[n]).has(rem)) return n; return 0; }

// статистика строки x01 — только из принятых подходов: максимумы, 180/140/100, закрытие, первые 9, лучший лег, попытки на дубль.
// Что прислал телефон, не используется (иначе любую статистику можно было вписать руками)
function lineStats(m, visits) {
  const ex = exOf(m), dbl = ex.dbl !== false, out = m.players.map(() => ({ hi: 0, hco: 0, c180: 0, c140: 0, c100: 0, f9p: 0, f9d: 0, coa: 0, bl: 0 }));
  if (ex.k !== 'x01') return out;
  const legVis = {}, legDarts = {};
  for (const v of visits) {
    if (v.tb || !out[v.p]) continue;
    const o = out[v.p], key = v.leg + ':' + v.p, n = v.n || 3, pts = v.b ? 0 : v.pts, win = !v.b && v.s - v.pts === 0;
    legVis[key] = (legVis[key] || 0) + 1;
    legDarts[key] = (legDarts[key] || 0) + n;
    if (legVis[key] <= 3) { o.f9p += pts; o.f9d += n; }
    if (!v.b) {
      o.hi = Math.max(o.hi, pts);
      if (pts >= 100) o.c100++;
      if (pts >= 140) o.c140++;
      if (pts === 180) o.c180++;
    }
    // попытки на дубль: по дротикам, если их отметили; иначе — как считает счётчик по сумме
    if (Array.isArray(v.d) && v.d.length) {
      let rem = v.s;
      for (const l of v.d) { if (oneDart(rem, dbl)) o.coa++; rem -= dartVal(l); }
    } else o.coa += win ? Math.max(1, n - (minDarts(v.s, dbl) - 1)) : oneDart(v.s, dbl) ? 3 : 0;
    if (win) {
      o.hco = Math.max(o.hco, v.pts);
      if (!o.bl || legDarts[key] < o.bl) o.bl = legDarts[key];
    }
  }
  return out;
}

// строка для match_lines из finish (имя берём из матча, итоги легов и статистика — из подходов)
const lineOf = (m, l, k, st, calc) => {
  const c = calc[k];
  return {
    idx: k, player_id: m.players[k].id || null, name: m.players[k].name, legs: l.legs, pts: l.pts, darts: l.darts,
    f9: c.f9d ? Math.round(c.f9p / c.f9d * 30) / 10 : null, hi: c.hi, hco: c.hco, c180: c.c180, c140: c.c140,
    c100: c.c100, coh: l.legs, coa: Math.max(Math.min(c.coa, l.darts), l.legs), bl: c.bl,
    sc: m.ex && st ? st.legsLog.map(L => L.tot[k]) : null
  };
};

module.exports = { IMPOSSIBLE, exOf, stateOf, liveState, visitOf, checkVisit, checkFinish, lineOf, lineStats, activeVisits };
