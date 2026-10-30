/* Упражнения: правила и счёт. Общий модуль страницы и сервера, без DOM и хранилища.
   В браузере — <script src="shared/games.js"> и глобальный Games, на сервере — require('./shared/games.js').

   Упражнение ex:
     { k: 'x01', mode: 301|501|701, dbl: true, lim: 0 }  обычный x01; lim — подходов на игрока в леге (0 — без ограничения)
     { k: 'score', lim: 10 }                             «Набор очков»: сумма за lim подходов
     { k: 'round' }                                      «Большой раунд»: 21 подход — сектора 1…20 и булл,
                                                         очки = попадания в нужный сектор × номер сектора
                                                         (дубль — 2 попадания, трипл — 3; 25 — 1, булл 50 — 2, по 25 очков)
     { k: 'sector', sec: 20, lim: 10 }                   «Сектор»: число попаданий в сектор sec (дубль 2, трипл 3)
     { k: 'cricket', lim: 10 }                           «Крикет» 15–20 и булл; lim — подходов на игрока (0 — до закрытия)
     { k: 'lives', lives: 7, lim: 15 }                   «7 жизней»: каждый должен набрать больше, чем предыдущий подход;
                                                         столько же или меньше — минус жизнь, без жизней — выбыл, остался
                                                         один — он выиграл. lim подходов (15 = 45 дротиков) кончились —
                                                         побеждает тот, у кого больше жизней, поровну — бросок в булл

   Матч — несколько легов, лег — одно упражнение. Игроки бросают по очереди, лег k начинает (starter + k − 1) mod n.
   Лег без закрытия (лимит подходов) выигрывает лучший результат; при равенстве — бросок в булл (событие tb).

   Подход visits[j]:
     x01:   { leg, p, s, pts, n, b, d }  как G.log на странице: s — остаток до подхода, b — перебор, d — метки дротиков
     другие: { leg, p, v, d }           v — очки (score) или попадания (round, sector); у крикета обязательны d
     ничья: { leg, p, tb: 1 }            p выиграл бросок в булл и с ним лег */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Games = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KINDS = ['x01', 'score', 'round', 'sector', 'cricket', 'lives'];
  const IMPOSSIBLE = new Set([163, 166, 169, 172, 173, 175, 176, 178, 179]);
  const CRICKET = [20, 19, 18, 17, 16, 15, 25];
  const ROUND_N = 21;

  // SUM[n] — суммы n дротиков; FIN[n] — закрытия n дротиками с последним в дубль
  const DART = [0, 25, 50], DOUBLE = [50];
  for (let k = 1; k <= 20; k++) { DART.push(k, 2 * k, 3 * k); DOUBLE.push(2 * k); }
  const SUM = [new Set([0])], FIN = [new Set()];
  for (let n = 1; n <= 3; n++) {
    const s = new Set(), f = new Set();
    SUM[n - 1].forEach(a => { DART.forEach(d => s.add(a + d)); DOUBLE.forEach(d => f.add(a + d)); });
    SUM.push(s); FIN.push(f);
  }

  const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

  // упражнение с умолчаниями; null — неверное
  function norm(ex) {
    if (!ex || typeof ex !== 'object' || !KINDS.includes(ex.k)) return null;
    const lim = ex.lim == null ? null : ex.lim;
    if (lim != null && !isInt(lim, 0, 30)) return null;
    switch (ex.k) {
      case 'x01':
        if (![301, 501, 701].includes(ex.mode)) return null;
        return { k: 'x01', mode: ex.mode, dbl: ex.dbl !== false, lim: lim || 0 };
      case 'score': return { k: 'score', lim: lim || 10 };
      case 'round': return { k: 'round' };
      case 'sector': {
        const sec = ex.sec == null ? 20 : ex.sec;
        if (!(isInt(sec, 1, 20) || sec === 25)) return null;
        return { k: 'sector', sec, lim: lim || 10 };
      }
      case 'cricket': return { k: 'cricket', lim: lim == null ? 10 : lim };
      case 'lives': {
        const lives = ex.lives == null ? 7 : ex.lives;
        if (!isInt(lives, 1, 20)) return null;
        return { k: 'lives', lives, lim: lim == null ? 15 : lim };
      }
    }
    return null;
  }
  const x01 = (mode, dbl) => ({ k: 'x01', mode, dbl: dbl !== false, lim: 0 });
  const isX01 = ex => !ex || ex.k === 'x01';

  function name(ex) {
    ex = norm(ex);
    if (!ex) return '';
    if (ex.k === 'x01') return String(ex.mode);
    if (ex.k === 'score') return 'Набор очков';
    if (ex.k === 'round') return 'Большой раунд';
    if (ex.k === 'sector') return 'Сектор ' + (ex.sec === 25 ? 'булл' : ex.sec);
    if (ex.k === 'lives') return ex.lives + ' ' + plural(ex.lives, 'жизнь', 'жизни', 'жизней');
    return 'Крикет';
  }
  // имя и лимит: «501 · 10 подходов», «Набор очков · 10 подходов»
  function label(ex) {
    ex = norm(ex);
    if (!ex) return '';
    const n = ex.k === 'round' ? 0 : ex.lim;
    return name(ex) + (n ? ' · ' + n + ' ' + plural(n, 'подход', 'подхода', 'подходов') : '') + (ex.k === 'x01' && !ex.dbl ? ' · без дубля' : '');
  }
  function plural(n, a, b, c) { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c; }

  // подходов на игрока в леге; 0 — до закрытия
  const perLeg = ex => ex.k === 'round' ? ROUND_N : ex.lim || 0;
  // сектор k-го подхода (с 0) в «Большом раунде»
  const roundTarget = k => k < 20 ? k + 1 : 25;
  // цель подхода: «Большой раунд» — свой сектор, «Сектор» — sec
  function target(ex, k) {
    if (ex.k === 'round') return roundTarget(k);
    if (ex.k === 'sector') return ex.sec;
    return null;
  }
  // что считается результатом лега и средним за подход
  function unit(ex) {
    if (ex.k === 'sector') return { tot: 'попаданий', avg: 'попад. за подход' };
    if (ex.k === 'cricket') return { tot: 'очков', avg: 'меток за подход' };
    if (ex.k === 'x01') return { tot: 'остаток', avg: 'ср. за 3 дротика' };
    if (ex.k === 'lives') return { tot: 'жизней', avg: 'ср. за подход' };
    return { tot: 'очков', avg: 'ср. за подход' };
  }

  // метка дротика: «—» или «0» мимо, «20», «D20», «T20», «25», «Bull»
  const LABEL = /^(—|0|25|Bull|[DT]?([1-9]|1[0-9]|20))$/;
  function dart(l) {
    if (typeof l !== 'string' || !LABEL.test(l)) return null;
    if (l === '—' || l === '0') return { n: 0, m: 0 };
    if (l === 'Bull') return { n: 25, m: 2 };
    if (l === '25') return { n: 25, m: 1 };
    const m = l[0] === 'D' ? 2 : l[0] === 'T' ? 3 : 1;
    return { n: +(m > 1 ? l.slice(1) : l), m };
  }
  // попадания в сектор sec по меткам
  const hitsOn = (d, sec) => d.reduce((a, l) => { const x = dart(l); return a + (x && x.n === sec ? x.m : 0); }, 0);
  const validDarts = d => Array.isArray(d) && d.length >= 1 && d.length <= 3 && d.every(l => dart(l));
  const nOf = (ex, v) => ex.k === 'x01' ? v.n : v.d ? v.d.length : 3;

  // начальное значение лега: остаток x01 или 0
  const start = (ex, np) => Array(np).fill(ex.k === 'x01' ? ex.mode : ex.k === 'lives' ? ex.lives : 0);

  // крикет: дротики подхода игрока p; меняет marks и pts, возвращает число меток
  function cricketVisit(st, p, d) {
    let got = 0;
    d.forEach(l => {
      const x = dart(l);
      if (!x || !CRICKET.includes(x.n)) return;
      for (let k = 0; k < x.m; k++) {
        const mk = st.marks[p];
        if ((mk[x.n] || 0) < 3) { mk[x.n] = (mk[x.n] || 0) + 1; got++; }
        else if (st.marks.some((o, j) => j !== p && (o[x.n] || 0) < 3)) { st.tot[p] += x.n; got++; }
      }
    });
    return got;
  }
  const closedAll = mk => CRICKET.every(n => (mk[n] || 0) >= 3);
  const marksSum = mk => CRICKET.reduce((a, n) => a + Math.min(3, mk[n] || 0), 0);

  /* Состояние матча по принятым подходам. cfg: { ex, np, ltw, starter }.
     leg, cur (кто бросает; null — нужен бросок в булл или матч окончен), legs — выиграно легов,
     tot — счёт лега (остаток x01, очки, попадания, очки крикета), vis — подходов в леге,
     marks — метки крикета [{ 20: 3, … }], need: 'tb' и tie — кто разыгрывает булл,
     pts и darts — за матч (для строки матча и среднего), legsLog — итоги сыгранных легов, winner;
     «7 жизней»: tot — жизни, prev — очки предыдущего подхода (их надо перебить). */
  function state(cfg, visits) {
    const ex = norm(cfg.ex), np = cfg.np, N = perLeg(ex), ltw = cfg.ltw, st0 = cfg.starter || 0;
    const st = {
      leg: 1, cur: st0 % np, legs: Array(np).fill(0), tot: null, vis: null, marks: null, need: null, tie: null,
      pts: Array(np).fill(0), darts: Array(np).fill(0), legsLog: [], winner: null, last: null
    };
    const begin = () => {
      st.tot = start(ex, np); st.vis = Array(np).fill(0); st.need = null; st.tie = null; st.prev = null;
      st.marks = ex.k === 'cricket' ? Array.from({ length: np }, () => ({})) : null;
      st.cur = (st0 + st.leg - 1) % np;
    };
    const legWon = w => {
      st.legs[w]++;
      st.legsLog.push({ leg: st.leg, w, tot: st.tot.slice() });
      if (st.legs[w] >= ltw) { st.winner = w; st.cur = null; return; }
      st.leg++;
      begin();
    };
    begin();
    for (const v of visits) {
      if (st.winner != null) break;
      st.last = v;
      if (v.tb) { legWon(v.p); continue; }
      const p = v.p, n = nOf(ex, v);
      st.darts[p] += n;
      let w = null;
      if (ex.k === 'x01') {
        st.pts[p] += v.pts; st.tot[p] -= v.pts;
        if (!v.b && st.tot[p] === 0) w = p;
      } else if (ex.k === 'cricket') {
        st.pts[p] += cricketVisit(st, p, v.d || []);
        if (closedAll(st.marks[p]) && st.tot.every((x, j) => j === p || st.tot[p] >= x)) w = p;
      } else if (ex.k === 'lives') {
        st.pts[p] += v.v;
        if (st.prev != null && v.v <= st.prev) st.tot[p]--;
        st.prev = v.v;
      } else {
        const add = ex.k === 'round' ? v.v * roundTarget(st.vis[p]) : v.v;
        st.pts[p] += add; st.tot[p] += add;
      }
      st.vis[p]++;
      if (w != null) { legWon(w); continue; }
      if (ex.k === 'lives') {
        const alive = st.tot.map((_, j) => j).filter(j => st.tot[j] > 0);
        // остался один — он выиграл лег; в одиночку — пока есть жизни
        if (np > 1 ? alive.length === 1 : !alive.length) { legWon(np > 1 ? alive[0] : 0); continue; }
        let q = (p + 1) % np;
        while (st.tot[q] <= 0) q = (q + 1) % np;
        st.cur = q;
        if (N && alive.every(j => st.vis[j] >= N)) {
          const tie = leaders(ex, st);
          if (tie.length === 1) legWon(tie[0]);
          else { st.need = 'tb'; st.tie = tie; st.cur = null; }
        }
        continue;
      }
      st.cur = (p + 1) % np;
      if (N && st.vis.every(x => x >= N)) {
        const tie = leaders(ex, st);
        if (tie.length === 1) legWon(tie[0]);
        else { st.need = 'tb'; st.tie = tie; st.cur = null; }
      }
    }
    return st;
  }
  // лучшие по итогу лега без закрытия: x01 — меньший остаток, крикет — очки, затем метки; иначе — больше
  function leaders(ex, st) {
    const key = j => ex.k === 'x01' ? -st.tot[j] : ex.k === 'cricket' ? st.tot[j] * 1000 + marksSum(st.marks[j]) : st.tot[j];
    const idx = st.tot.map((_, j) => j), best = Math.max(...idx.map(key));
    return idx.filter(j => key(j) === best);
  }

  // ошибка подхода v после принятых visits — текст; иначе null
  function check(cfg, visits, v) {
    const ex = norm(cfg.ex), st = state(cfg, visits);
    if (!v || typeof v !== 'object') return 'Неверный подход';
    if (st.winner != null) return 'Матч уже выигран, ожидается завершение';
    if (v.leg !== st.leg) return 'Ожидается лег ' + st.leg;
    if (st.need === 'tb') {
      if (!v.tb) return 'Ничья в леге: нужен бросок в булл';
      return st.tie.includes(v.p) ? null : 'Булл разыгрывают игроки ' + st.tie.map(j => j + 1).join(' и ');
    }
    if (v.tb) return 'Бросок в булл нужен только при ничьей';
    if (v.p !== st.cur) return 'Сейчас бросает игрок ' + (st.cur + 1);
    if (v.d != null && !(Array.isArray(v.d) && v.d.length <= 3 && v.d.every(x => typeof x === 'string' && x.length <= 4))) return 'Неверные метки дротиков';
    if (ex.k === 'x01') return checkX01(ex, st, v);
    if (ex.k === 'cricket') {
      if (!validDarts(v.d)) return 'В крикете нужны метки дротиков';
      if (v.d.length < 3) {
        const after = state(cfg, visits.concat([v]));
        if (!(after.winner != null || after.leg > st.leg)) return 'Меньше 3 дротиков только при закрытии';
      }
      return null;
    }
    if (v.d != null && !validDarts(v.d)) return 'Неверные метки дротиков';
    if (ex.k === 'score' || ex.k === 'lives') {
      if (!isInt(v.v, 0, 180) || !SUM[3].has(v.v)) return v.v + ' нельзя набрать тремя дротиками';
      if (v.d && v.d.reduce((a, l) => { const x = dart(l); return a + x.n * x.m; }, 0) !== v.v) return 'Сумма дротиков не равна ' + v.v;
      return null;
    }
    const sec = target(ex, st.vis[v.p]), max = sec === 25 ? 6 : 9;
    if (!isInt(v.v, 0, max)) return 'Попаданий в ' + (sec === 25 ? 'булл' : sec) + ': от 0 до ' + max;
    if (v.d && hitsOn(v.d, sec) !== v.v) return 'Метки дротиков не дают ' + v.v + ' попаданий';
    return null;
  }

  function checkX01(ex, st, v) {
    if (v.s !== st.tot[v.p]) return 'Остаток игрока ' + st.tot[v.p] + ', а не ' + v.s;
    if (!isInt(v.n, 1, 3)) return 'Дротиков должно быть 1–3';
    if (v.b !== 0 && v.b !== 1) return 'Поле b: 0 или 1';
    if (!isInt(v.pts, 0, 180)) return 'Очки должны быть от 0 до 180';
    if (v.b) return v.pts === 0 ? null : 'При переборе очки 0';
    if (IMPOSSIBLE.has(v.pts) || !SUM[v.n].has(v.pts)) return v.pts + ' нельзя набрать ' + v.n + ' дротиками';
    const rem = v.s - v.pts;
    if (rem < 0 || (ex.dbl && rem === 1)) return 'Это перебор';
    if (rem === 0) return (ex.dbl ? FIN[v.n] : SUM[v.n]).has(v.pts) ? null : v.pts + ' нельзя закрыть ' + v.n + ' дротиками';
    return v.n === 3 ? null : 'Меньше 3 дротиков только при закрытии или переборе';
  }

  // проверить и принять подход: { st, err }; visits не меняется
  function play(cfg, visits, v) {
    const err = check(cfg, visits, v);
    return { err, st: state(cfg, err ? visits : visits.concat([v])) };
  }

  // среднее за подход (3 дротика): очки x01 и «Набора», очки раунда, попадания сектора, метки крикета
  const avg = (pts, darts) => darts ? pts / darts * 3 : null;

  return {
    KINDS, CRICKET, ROUND_N, IMPOSSIBLE, SUM, FIN,
    norm, x01, isX01, name, label, perLeg, target, roundTarget, unit, dart, hitsOn, state, check, play, avg
  };
});
