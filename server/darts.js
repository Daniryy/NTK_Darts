// Проверка подходов счётчика. Состояние матча всегда пересчитывается из принятых подходов.
const IMPOSSIBLE = new Set([163, 166, 169, 172, 173, 175, 176, 178, 179]);

const DART = [0, 25, 50];
for (let k = 1; k <= 20; k++) DART.push(k, 2 * k, 3 * k);
const DOUBLE = [50];
for (let k = 1; k <= 20; k++) DOUBLE.push(2 * k);

// SUM[n] — суммы n дротиков; FIN[n] — закрытия n дротиками с последним в дубль
const SUM = [new Set([0])], FIN = [new Set()];
for (let n = 1; n <= 3; n++) {
  const s = new Set(), f = new Set();
  SUM[n - 1].forEach(a => { DART.forEach(d => s.add(a + d)); DOUBLE.forEach(d => f.add(a + d)); });
  SUM.push(s); FIN.push(f);
}

// visits — принятые подходы [{ leg, p, s, pts, n, b }]
function stateOf(m, visits) {
  const np = m.players.length;
  const st = { leg: 1, cur: m.starter % np, scores: Array(np).fill(m.mode), legs: Array(np).fill(0), pts: Array(np).fill(0), darts: Array(np).fill(0), winner: null };
  for (const v of visits) {
    st.pts[v.p] += v.pts; st.darts[v.p] += v.n;
    st.scores[v.p] -= v.pts;
    if (!v.b && st.scores[v.p] === 0) {
      st.legs[v.p]++;
      if (st.legs[v.p] >= m.ltw) { st.winner = v.p; break; }
      st.leg++;
      st.cur = (m.starter + st.leg - 1) % np;
      st.scores.fill(m.mode);
    } else st.cur = (v.p + 1) % np;
  }
  return st;
}

// живое состояние для табло: лег, кто бросает, остатки, последний подход
function liveState(m, visits) {
  const st = stateOf(m, visits), v = visits[visits.length - 1];
  return { leg: st.leg, cur: st.winner == null ? st.cur : null, scores: st.scores, last: v ? { p: v.p, pts: v.pts, n: v.n, b: v.b, d: v.d } : null };
}

const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// ошибка — текст; иначе null. Подход должен совпасть с тем, что считает сервер.
function checkVisit(m, st, v) {
  if (st.winner != null) return 'Матч уже выигран, ожидается завершение';
  if (v.leg !== st.leg) return 'Ожидается лег ' + st.leg;
  if (v.p !== st.cur) return 'Сейчас бросает игрок ' + (st.cur + 1);
  if (v.s !== st.scores[v.p]) return 'Остаток игрока ' + st.scores[v.p] + ', а не ' + v.s;
  if (!isInt(v.n, 1, 3)) return 'Дротиков должно быть 1–3';
  if (v.b !== 0 && v.b !== 1) return 'Поле b: 0 или 1';
  if (!isInt(v.pts, 0, 180)) return 'Очки должны быть от 0 до 180';
  if (v.d != null && !(Array.isArray(v.d) && v.d.length <= 3 && v.d.every(x => typeof x === 'string' && x.length <= 4))) return 'Неверные метки дротиков';
  if (v.b) return v.pts === 0 ? null : 'При переборе очки 0';
  if (IMPOSSIBLE.has(v.pts) || !SUM[v.n].has(v.pts)) return v.pts + ' нельзя набрать ' + v.n + ' дротиками';
  const rem = v.s - v.pts;
  if (rem < 0 || (m.dbl && rem === 1)) return 'Это перебор';
  if (rem === 0) return (m.dbl ? FIN[v.n] : SUM[v.n]).has(v.pts) ? null : v.pts + ' нельзя закрыть ' + v.n + ' дротиками';
  return v.n === 3 ? null : 'Меньше 3 дротиков только при закрытии или переборе';
}

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

// строка для match_lines из finish (имя берём из матча)
const lineOf = (m, l, k) => ({
  idx: k, player_id: m.players[k].id || null, name: m.players[k].name, legs: l.legs, pts: l.pts, darts: l.darts,
  f9: l.f9 == null ? null : Math.round(l.f9 * 10) / 10, hi: l.hi || 0, hco: l.hco || 0, c180: l.c180 || 0, c140: l.c140 || 0,
  c100: l.c100 || 0, coh: l.coh != null ? l.coh : l.legs, coa: Math.max(l.coa || 0, l.legs), bl: l.bl || 0
});

module.exports = { IMPOSSIBLE, stateOf, liveState, checkVisit, checkFinish, lineOf };
