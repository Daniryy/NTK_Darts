/* Сетки турниров: общая логика для страницы и сервера.
   Работает без DOM и без хранилища: на входе объект турнира, на выходе вычисленные матчи и места.
   В браузере подключается тегом <script src="shared/bracket.js"> и даёт глобальный Bracket,
   на сервере — const Bracket = require('./shared/bracket.js').

   Форматы:
     ko — на вылет;
     pl — розыгрыш всех мест (победители группы → верхняя подгруппа, проигравшие → нижняя);
     rr — круговая (только список матчей, см. rrGames).

   Объект турнира t:
     t.format   'ko' | 'pl' | 'rr'
     t.players  id игроков в порядке посева
     t.slots    первый круг сеток: id или null (null = свободное место); у старых ko берётся players
     t.games    [{ r, i, res }]; у rr ещё a и b
     g.res      null или { w: id победителя, la, lb: леги игрока a и b, mid? }
   Результаты хранятся только в g.res. Кто играет в матче, всегда вычисляет resolver(t). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bracket = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BYE = '~';
  const isReal = x => !!x && x !== BYE;
  const isBracket = t => t.format === 'ko' || t.format === 'pl';
  const slotsOf = t => t.slots || t.players;
  const bSize = t => slotsOf(t).length;
  const bRounds = t => Math.round(Math.log2(bSize(t)));

  function seedOrder(n) { let o = [1, 2]; while (o.length < n) { const m = o.length * 2; o = o.flatMap(s => [s, m + 1 - s]); } return o; }
  function bracketSize(n) { let s = 2; while (s < n) s *= 2; return s; }
  function bracketGames(fmt, size) {
    const rounds = Math.round(Math.log2(size)), games = [];
    for (let r = 0; r < rounds; r++) {
      const cnt = fmt === 'pl' ? size / 2 : size / 2 ** (r + 1);
      for (let i = 0; i < cnt; i++) games.push({ r, i, res: null });
    }
    return games;
  }
  // ids — игроки по посеву (сильнейший первым); заполняет t.format, players, slots, games
  function setBracket(t, fmt, ids) {
    const size = bracketSize(ids.length);
    t.format = fmt;
    t.players = ids.slice();
    t.slots = seedOrder(size).map(k => k <= ids.length ? ids[k - 1] : null);
    t.games = bracketGames(fmt, size);
  }
  const roundGames = (t, r) => t.format === 'pl' ? bSize(t) / 2 : bSize(t) / 2 ** (r + 1);

  // группа матча в круге r у pl: grp — номер группы, per — матчей в группе, lo — первое место группы
  function plGroup(t, r, i) {
    const per = bSize(t) / 2 ** (r + 1), grp = Math.floor(i / per);
    return { grp, per, lo: grp * per * 2 + 1 };
  }
  // откуда берутся игроки матча (r, i): [[i в круге r-1, 'w' | 'l'], ...]
  function feeders(t, r, i) {
    if (t.format === 'pl') {
      const { grp, per } = plGroup(t, r, i), j = i % per;
      const base = (grp >> 1) * per * 2 + 2 * j, take = grp & 1 ? 'l' : 'w';
      return [[base, take], [base + 1, take]];
    }
    return [[2 * i, 'w'], [2 * i + 1, 'w']];
  }

  const GIDX = new WeakMap();
  function gameAt(t, r, i) {
    let m = GIDX.get(t.games);
    if (!m) { m = new Map(); t.games.forEach(g => m.set(g.r + ':' + g.i, g)); GIDX.set(t.games, m); }
    return m.get(r + ':' + i) || null;
  }

  // игрок: id | BYE | null (ещё не определён). Свободные места проходят сами: соперник побеждает без игры.
  function resolver(t) {
    if (!isBracket(t)) return { players: (r, i) => { const g = gameAt(t, r, i); return g ? [g.a, g.b] : [null, null]; } };
    const memo = new Map(), sl = slotsOf(t);
    const players = (r, i) => {
      if (r === 0) return [sl[2 * i] || BYE, sl[2 * i + 1] || BYE];
      const k = r + ':' + i;
      if (!memo.has(k)) memo.set(k, feeders(t, r, i).map(([fi, take]) => outcome(r - 1, fi)[take]));
      return memo.get(k);
    };
    const outcome = (r, i) => {
      const [a, b] = players(r, i), g = gameAt(t, r, i);
      if (a === BYE) return { w: b, l: BYE };
      if (b === BYE) return { w: a, l: BYE };
      if (g && g.res && isReal(a) && isReal(b)) {
        if (g.res.w === a) return { w: a, l: b };
        if (g.res.w === b) return { w: b, l: a };
      }
      return { w: null, l: null };
    };
    return { players, outcome };
  }
  const gamePlayersIn = (t, g) => resolver(t).players(g.r, g.i);

  // st: done | ready | tbd | bye | void
  function gameState(t, g, rv) {
    const [a, b] = (rv || resolver(t)).players(g.r, g.i);
    let st;
    if (a === BYE && b === BYE) st = 'void';
    else if (a === BYE || b === BYE) st = 'bye';
    else if (!isReal(a) || !isReal(b)) st = 'tbd';
    else st = g.res && (g.res.w === a || g.res.w === b) ? 'done' : 'ready';
    return { a, b, st };
  }

  // сколько реальных игроков в группе grp круга r (pl)
  function groupReal(t, rv, r, grp) {
    const per = bSize(t) / 2 ** (r + 1);
    let c = 0;
    for (let j = 0; j < per; j++) rv.players(r, grp * per + j).forEach(x => { if (x !== BYE) c++; });
    return c;
  }

  // номера стабильны: бай известен заранее и не нумеруется
  function gameNums(t, rv) {
    const m = new Map(), last = t.format === 'pl' ? bRounds(t) - 1 : -1;
    let n = 0;
    // в последнем круге pl финал получает последний номер
    (last < 0 ? t.games : t.games.slice().sort((x, y) => x.r - y.r || (x.r === last ? y.i - x.i : x.i - y.i))).forEach(g => { const [a, b] = rv.players(g.r, g.i); if (a !== BYE && b !== BYE) m.set(g.r + ':' + g.i, ++n); });
    return m;
  }

  // подпись источника игрока: «Победитель №3» / «Проигравший №3»; '' если источника нет
  function srcText(t, rv, nums, r, i, side) {
    let [fi, take] = feeders(t, r, i)[side], fr = r - 1;
    while (fr >= 0) {
      const n = nums.get(fr + ':' + fi);
      if (n) return (take === 'w' ? 'Победитель' : 'Проигравший') + ' №' + n;
      if (take !== 'w' || fr === 0) return '';
      const pp = rv.players(fr, fi);
      [fi, take] = feeders(t, fr, fi)[pp[0] === BYE ? 1 : 0];
      fr--;
    }
    return '';
  }

  // сколько матчей сыграно из всех, где есть два игрока
  function tProgress(t, rv) {
    rv = rv || resolver(t);
    let done = 0, total = 0;
    t.games.forEach(g => { const s = gameState(t, g, rv).st; if (s === 'void' || s === 'bye') return; total++; if (s === 'done') done++; });
    return { done, total };
  }

  // можно ли убрать результат матча g: после этого все остальные результаты должны остаться верными.
  // extra(rv) — дополнительная проверка (например, идущая игра), вызывается, пока результат снят.
  function canClear(t, g, extra) {
    if (!g.res || !isBracket(t)) return true;
    const saved = g.res;
    g.res = null;
    try {
      const rv = resolver(t);
      let ok = t.games.every(x => !x.res || gameState(t, x, rv).st === 'done');
      if (ok && extra) ok = !!extra(rv);
      return ok;
    } finally { g.res = saved; }
  }

  // круговая: каждый с каждым, без дублей; null в списке игроков не нужен
  function rrGames(ids) {
    const a = ids.slice(); if (a.length % 2) a.push(null);
    const n = a.length, games = [];
    for (let r = 0; r < n - 1; r++) {
      let i = 0;
      for (let k = 0; k < n / 2; k++) { const x = a[k], y = a[n - 1 - k]; if (x && y) games.push({ r, i: i++, a: x, b: y, res: null }); }
      a.splice(1, 0, a.pop());
    }
    return games;
  }

  const finalGame = t => isBracket(t) ? gameAt(t, bRounds(t) - 1, 0) : null;

  // места игрока [от, до]; пока место не решено, это диапазон. null — игрока нет в сетке.
  function placeRange(t, pid, rv) {
    rv = rv || resolver(t);
    const R = bRounds(t), S = bSize(t), N = t.players.length;
    for (let r = R - 1; r >= 0; r--) {
      for (let i = 0, n = roundGames(t, r); i < n; i++) {
        const pp = rv.players(r, i);
        if (pp[0] !== pid && pp[1] !== pid) continue;
        const o = rv.outcome(r, i);
        if (t.format === 'pl') {
          const { grp, lo } = plGroup(t, r, i);
          if (r === R - 1 && o.w === pid) return [lo, lo];
          if (r === R - 1 && o.l === pid) return [lo + 1, lo + 1];
          return [lo, lo + groupReal(t, rv, r, grp) - 1];
        }
        if (r === R - 1 && o.w === pid) return [1, 1];
        if (o.l === pid) return r === R - 1 ? [2, 2] : [S / 2 ** (r + 1) + 1, Math.min(N, S / 2 ** r)];
        return [1, Math.min(N, S / 2 ** r)];
      }
    }
    return null;
  }

  // все игроки с местами: [{ id, lo, hi }], по возрастанию места; для сервера и итоговой таблицы
  function places(t) {
    const rv = resolver(t), N = t.players.length;
    return t.players.map(id => { const rg = placeRange(t, id, rv) || [N, N]; return { id, lo: rg[0], hi: rg[1] }; })
      .sort((x, y) => x.lo - y.lo || x.hi - y.hi);
  }

  return {
    BYE, isReal, isBracket, slotsOf, bSize, bRounds, seedOrder, bracketSize, bracketGames, setBracket,
    roundGames, plGroup, feeders, gameAt, resolver, gamePlayersIn, gameState, groupReal, gameNums,
    srcText, tProgress, canClear, rrGames, finalGame, placeRange, places
  };
});
