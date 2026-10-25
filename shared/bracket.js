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
     t.block    только pl: размер части сетки (например 8). Сетка — несколько независимых частей:
                игроки 1–8 играют за места 1–8, 9–16 — за 9–16 и т. д. Номер игры i сквозной:
                часть k занимает i от k·block/2 до (k+1)·block/2 − 1 в каждом круге.
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
  // размер одной части сетки; без частей — вся сетка
  const bSize = t => (t.format === 'pl' && t.block) || slotsOf(t).length;
  const bParts = t => slotsOf(t).length / bSize(t);
  const bRounds = t => Math.round(Math.log2(bSize(t)));

  function seedOrder(n) { let o = [1, 2]; while (o.length < n) { const m = o.length * 2; o = o.flatMap(s => [s, m + 1 - s]); } return o; }
  // порядок как на бумажном листе NDL: 1–8, 5–4, 3–6, 7–2 (пары и дальнейшие встречи те же, другой только порядок)
  const NDL_ORDER = { 2: [1, 2], 4: [1, 4, 3, 2], 8: [1, 8, 5, 4, 3, 6, 7, 2] };
  const orderOf = (t, n) => (t.layout === 'ndl' && NDL_ORDER[n]) || seedOrder(n);
  function bracketSize(n) { let s = 2; while (s < n) s *= 2; return s; }
  // size — мест во всей сетке, block — в одной части (pl)
  function bracketGames(fmt, size, block) {
    const rounds = Math.round(Math.log2(fmt === 'pl' && block ? block : size)), games = [];
    for (let r = 0; r < rounds; r++) {
      const cnt = fmt === 'pl' ? size / 2 : size / 2 ** (r + 1);
      for (let i = 0; i < cnt; i++) games.push({ r, i, res: null });
    }
    return games;
  }
  // ids — игроки по посеву (сильнейший первым); заполняет t.format, players, slots, games.
  // block (только pl) — делить сетку на части по block мест: посев 1..block в первой части и т. д.
  // t.layout = 'ndl' — порядок матчей как на листе NDL (части до 8 мест)
  function setBracket(t, fmt, ids, block) {
    const n = ids.length, B = fmt === 'pl' && block ? Math.min(block, bracketSize(n)) : bracketSize(n);
    const parts = Math.ceil(n / B), order = orderOf(t, B);
    t.format = fmt;
    t.players = ids.slice();
    t.slots = [];
    for (let k = 0; k < parts; k++) order.forEach(s => t.slots.push(k * B + s <= n ? ids[k * B + s - 1] : null));
    if (parts > 1) t.block = B; else delete t.block;
    t.games = bracketGames(fmt, t.slots.length, t.block);
  }
  const roundGames = (t, r) => t.format === 'pl' ? slotsOf(t).length / 2 : bSize(t) / 2 ** (r + 1);

  // группа матча в круге r у pl: grp — сквозной номер группы, per — матчей в группе, lo — первое место группы,
  // part — часть сетки, lg — номер группы внутри части
  function plGroup(t, r, i) {
    const B = bSize(t), half = B / 2, part = Math.floor(i / half);
    const per = B / 2 ** (r + 1), lg = Math.floor((i % half) / per);
    return { grp: part * 2 ** r + lg, per, lo: part * B + lg * per * 2 + 1, part, lg };
  }
  const partOf = (t, i) => t.format === 'pl' && t.block ? Math.floor(i / (t.block / 2)) : 0;
  // откуда берутся игроки матча (r, i): [[i в круге r-1, 'w' | 'l'], ...]
  function feeders(t, r, i) {
    if (t.format === 'pl') {
      const { per, part, lg } = plGroup(t, r, i), j = i % per;
      const base = part * bSize(t) / 2 + (lg >> 1) * per * 2 + 2 * j, take = lg & 1 ? 'l' : 'w';
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
    const m = new Map(), last = t.format === 'pl' ? bRounds(t) - 1 : -1, half = bSize(t) / 2;
    // в последнем круге pl финал части получает последний номер в её части
    const key = g => g.r === last ? partOf(t, g.i) * half + half - 1 - g.i % half : g.i;
    let n = 0;
    (last < 0 ? t.games : t.games.slice().sort((x, y) => x.r - y.r || key(x) - key(y))).forEach(g => { const [a, b] = rv.players(g.r, g.i); if (a !== BYE && b !== BYE) m.set(g.r + ':' + g.i, ++n); });
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

  // подписи как на бумажном листе NDL (t.labels = 'ab'): места второго круга A1, A2…, третьего B1…, сквозные по частям
  const slotTag = (r, i, side) => String.fromCharCode(64 + r) + (2 * i + side + 1);
  // куда идут победитель и проигравший матча (r, i): { w: [i, сторона] | null, l: [i, сторона] | null } в круге r + 1
  function nextOf(t, r, i) {
    const out = { w: null, l: null };
    if (!isBracket(t) || r + 1 >= bRounds(t)) return out;
    for (let j = 0, n = roundGames(t, r + 1); j < n; j++) feeders(t, r + 1, j).forEach(([fi, take], side) => { if (fi === i) out[take] = [j, side]; });
    return out;
  }
  // название матча при подписях NDL: «A1–A2», «B3–B4»; в первом круге — номера посева «1–8». null — подписи номерами
  function gameTag(t, g) {
    if (t.labels !== 'ab' || !isBracket(t)) return null;
    if (g.r > 0) return slotTag(g.r, g.i, 0) + '–' + slotTag(g.r, g.i, 1);
    const B = bSize(t), base = partOf(t, g.i) * B, o = orderOf(t, B), k = (2 * g.i) % B;
    return (base + o[k]) + '–' + (base + o[k + 1]);
  }

  // сколько матчей сыграно из всех, где есть два игрока
  function tProgress(t, rv) {
    rv = rv || resolver(t);
    let done = 0, total = 0;
    t.games.forEach(g => { const s = gameState(t, g, rv).st; if (s === 'void' || s === 'bye') return; total++; if (s === 'done') done++; });
    return { done, total };
  }
  // прогресс по кругам: [{ r, done, total }]; круги без игр не попадают
  function roundProgress(t, rv) {
    rv = rv || resolver(t);
    const out = [];
    t.games.forEach(g => {
      const s = gameState(t, g, rv).st;
      if (s === 'void' || s === 'bye') return;
      let x = out.find(o => o.r === g.r);
      if (!x) out.push(x = { r: g.r, done: 0, total: 0 });
      x.total++; if (s === 'done') x.done++;
    });
    return out.sort((a, b) => a.r - b.r);
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

  // мишени: t.boards = { n, at: { 'r:i': номер } }. Мишень держится за готовой игрой, сыгранная её освобождает;
  // свободные мишени получают готовые игры без мишени по порядку номеров. true — что-то поменялось.
  function assignBoards(t, rv) {
    const bd = t.boards;
    if (!bd || !t.games || !t.games.length) return false;
    rv = rv || resolver(t);
    const at = bd.at || (bd.at = {}), before = JSON.stringify(at), used = new Set();
    Object.keys(at).forEach(k => {
      const [r, i] = k.split(':').map(Number), g = gameAt(t, r, i), b = at[k];
      if (!g || gameState(t, g, rv).st !== 'ready' || !(Number.isInteger(b) && b >= 1 && b <= bd.n) || used.has(b)) delete at[k];
      else used.add(b);
    });
    const nums = gameNums(t, rv), no = g => nums.get(g.r + ':' + g.i) || 0;
    const wait = t.games.filter(g => !at[g.r + ':' + g.i] && gameState(t, g, rv).st === 'ready').sort((x, y) => no(x) - no(y));
    let b = 1;
    for (const g of wait) {
      while (b <= bd.n && used.has(b)) b++;
      if (b > bd.n) break;
      at[g.r + ':' + g.i] = b; used.add(b);
    }
    return JSON.stringify(at) !== before;
  }

  // все игроки с местами: [{ id, lo, hi }], по возрастанию места; для сервера и итоговой таблицы
  function places(t) {
    const rv = resolver(t), N = t.players.length;
    return t.players.map(id => { const rg = placeRange(t, id, rv) || [N, N]; return { id, lo: rg[0], hi: rg[1] }; })
      .sort((x, y) => x.lo - y.lo || x.hi - y.hi);
  }

  return {
    BYE, isReal, isBracket, slotsOf, bSize, bParts, bRounds, seedOrder, bracketSize, bracketGames, setBracket,
    roundGames, plGroup, partOf, feeders, gameAt, resolver, gamePlayersIn, gameState, groupReal, gameNums,
    srcText, tProgress, roundProgress, canClear, rrGames, finalGame, placeRange, places, assignBoards,
    NDL_ORDER, slotTag, nextOf, gameTag
  };
});
