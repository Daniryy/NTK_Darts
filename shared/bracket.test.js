// Запуск: node --test shared/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const B = require('./bracket.js');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const ids = n => range(1, n).map(i => 'p' + i);

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function make(fmt, n) {
  const t = { id: 't', players: [], games: [] };
  B.setBracket(t, fmt, ids(n));
  return t;
}
// играет все готовые матчи по одному; pick(a, b, g) -> id победителя. Возвращает число сыгранных.
function playAll(t, pick) {
  let played = 0;
  for (;;) {
    const rv = B.resolver(t);
    const g = t.games.find(x => B.gameState(t, x, rv).st === 'ready');
    if (!g) return played;
    const { a, b } = B.gameState(t, g, rv), w = pick(a, b, g);
    g.res = { w, la: w === a ? 3 : 1, lb: w === b ? 3 : 1 };
    played++;
    assert.ok(played < 5000, 'турнир не заканчивается');
  }
}
const seedWins = (a, b) => (Number(a.slice(1)) < Number(b.slice(1)) ? a : b);
const randomWins = seed => { const R = rng(seed); return (a, b) => (R() < 0.5 ? a : b); };

const SIZES = range(3, 64);

test('pl: 3–64 игроков, каждый получает своё место 1..N', () => {
  for (const n of SIZES) {
    for (const [name, pick] of [['по посеву', seedWins], ['случайно', randomWins(n)], ['наоборот', (a, b) => seedWins(b, a)]]) {
      const t = make('pl', n);
      playAll(t, pick);
      const pls = B.places(t);
      assert.equal(pls.length, n, `n=${n} ${name}: не у всех есть место`);
      pls.forEach(p => assert.equal(p.lo, p.hi, `n=${n} ${name}: место ${p.id} не определено (${p.lo}–${p.hi})`));
      assert.deepEqual(pls.map(p => p.lo), range(1, n), `n=${n} ${name}: места повторяются или пропущены`);
      assert.equal(new Set(pls.map(p => p.id)).size, n);
    }
  }
});

test('pl: при игре по посеву места совпадают с посевом', () => {
  for (const n of SIZES) {
    const t = make('pl', n);
    playAll(t, seedWins);
    B.places(t).forEach(p => assert.equal(p.lo, Number(p.id.slice(1)), `n=${n}: ${p.id} занял ${p.lo}`));
  }
});

test('pl: все матчи сыграны, ничего не висит', () => {
  for (const n of SIZES) {
    const t = make('pl', n);
    const played = playAll(t, randomWins(100 + n));
    const rv = B.resolver(t), pr = B.tProgress(t, rv);
    assert.equal(played, pr.total, `n=${n}`);
    assert.equal(pr.done, pr.total, `n=${n}`);
    t.games.forEach(g => assert.ok(['done', 'bye', 'void'].includes(B.gameState(t, g, rv).st), `n=${n}: матч ${g.r}:${g.i} не закрыт`));
  }
});

test('ko: 3–64 игроков, чемпион, финалист и диапазоны мест', () => {
  for (const n of SIZES) {
    const t = make('ko', n);
    const played = playAll(t, randomWins(7 * n));
    assert.equal(played, n - 1, `n=${n}: на вылет играется N−1 матч`);
    const pls = B.places(t);
    assert.equal(pls.length, n);
    assert.equal(pls.filter(p => p.lo === 1 && p.hi === 1).length, 1, `n=${n}: чемпион один`);
    assert.equal(pls.filter(p => p.lo === 2 && p.hi === 2).length, 1, `n=${n}: финалист один`);
    pls.forEach(p => { assert.ok(p.lo >= 1 && p.hi <= n && p.lo <= p.hi, `n=${n}: ${p.id} ${p.lo}–${p.hi}`); });
    // у проигравших в одном круге общий диапазон; они должны занимать места целиком
    const covered = new Set();
    pls.forEach(p => covered.add(p.lo + '-' + p.hi));
    const total = [...covered].reduce((s, k) => { const [a, b] = k.split('-').map(Number); return s + (b - a + 1); }, 0);
    assert.ok(total >= n - 1, `n=${n}: диапазоны не покрывают места`);
    const w = B.finalGame(t).res.w;
    assert.deepEqual(B.placeRange(t, w), [1, 1]);
  }
});

test('ko и pl: свободные места проходят сами', () => {
  for (const fmt of ['ko', 'pl']) {
    for (const n of SIZES) {
      const t = make(fmt, n), S = B.bSize(t), rv = B.resolver(t);
      assert.equal(S - n, t.slots.filter(x => x === null).length);
      // до начала игры: нигде нет матча «бай против бая» с игроком из ниоткуда, а в круге 1 нет pending
      for (let i = 0; i < S / 2; i++) {
        const [a, b] = rv.players(0, i), st = B.gameState(t, B.gameAt(t, 0, i), rv).st;
        assert.ok(a !== null && b !== null);
        if (a === B.BYE || b === B.BYE) assert.ok(st === 'bye' || st === 'void', `n=${n}: бай в круге 1 требует игры`);
        else assert.equal(st, 'ready');
      }
      // сильнейшие игроки с байем сразу попадают во второй круг без единого результата
      if (S > n && B.bRounds(t) > 1) {
        const second = range(0, B.roundGames(t, 1) - 1).flatMap(i => rv.players(1, i));
        assert.ok(second.includes('p1'), `${fmt} n=${n}: p1 имеет бай и должен быть во втором круге`);
      }
      // матчи с байем не нумеруются и не требуют результата
      const nums = B.gameNums(t, rv);
      t.games.forEach(g => { const st = B.gameState(t, g, rv).st; if (st === 'bye' || st === 'void') assert.ok(!nums.has(g.r + ':' + g.i)); });
    }
  }
});

test('сетки: после результатов сервер и страница считают одно и то же (JSON туда и обратно)', () => {
  for (const fmt of ['ko', 'pl']) {
    for (const n of [3, 5, 8, 13, 16, 33, 64]) {
      const t = make(fmt, n);
      playAll(t, randomWins(n));
      const copy = JSON.parse(JSON.stringify(t));
      assert.deepEqual(B.places(copy), B.places(t));
      assert.deepEqual([...B.gameNums(copy, B.resolver(copy))], [...B.gameNums(t, B.resolver(t))]);
    }
  }
});

test('placeRange: в начале турнира у всех диапазон, по ходу сужается', () => {
  const t = make('pl', 16);
  B.places(t).forEach(p => assert.deepEqual([p.lo, p.hi], [1, 16]));
  const g = B.gameAt(t, 0, 0), { a, b } = B.gameState(t, g);
  g.res = { w: a, la: 3, lb: 0 };
  assert.deepEqual(B.placeRange(t, a), [1, 8]);
  assert.deepEqual(B.placeRange(t, b), [9, 16]);
});

test('canClear: результат можно убрать только если дальше нет зависящих матчей', () => {
  const t = make('ko', 8);
  playAll(t, seedWins);
  const first = B.gameAt(t, 0, 0), fin = B.finalGame(t), saved = JSON.stringify(first.res);
  assert.equal(B.canClear(t, first), false);
  assert.equal(JSON.stringify(first.res), saved, 'результат не должен потеряться');
  assert.equal(B.canClear(t, fin), true);
  assert.ok(fin.res, 'результат финала не должен потеряться');
  assert.equal(B.canClear(t, fin, () => false), false, 'дополнительная проверка учитывается');
  assert.equal(B.canClear(t, B.gameAt(t, 0, 1)), false);
});

test('rr: каждый с каждым один раз, никто не играет дважды в туре', () => {
  for (const n of range(3, 12)) {
    const games = B.rrGames(ids(n));
    assert.equal(games.length, n * (n - 1) / 2, `n=${n}`);
    const pairs = new Set(games.map(g => [g.a, g.b].sort().join('|')));
    assert.equal(pairs.size, games.length, `n=${n}: есть повторы`);
    const rounds = new Map();
    games.forEach(g => { const s = rounds.get(g.r) || new Set(); [g.a, g.b].forEach(p => { assert.ok(!s.has(p), `n=${n}: ${p} дважды в туре ${g.r}`); s.add(p); }); rounds.set(g.r, s); });
    assert.equal(rounds.size, n % 2 ? n : n - 1, `n=${n}: число туров`);
  }
});

test('seedOrder: перестановка 1..S, первые два посева в разных половинах', () => {
  for (const s of [2, 4, 8, 16, 32, 64]) {
    const o = B.seedOrder(s);
    assert.deepEqual([...o].sort((x, y) => x - y), range(1, s));
    if (s > 2) assert.ok(o.indexOf(1) < s / 2 && o.indexOf(2) >= s / 2);
    for (let i = 0; i < s; i += 2) assert.equal(o[i] + o[i + 1], s + 1, 'в первом круге сильный играет со слабым');
  }
});

test('модуль грузится в браузере как глобальный Bracket', () => {
  const src = fs.readFileSync(path.join(__dirname, 'bracket.js'), 'utf8');
  const ctx = { self: {} };
  vm.runInNewContext(src, ctx);
  assert.equal(typeof ctx.self.Bracket.setBracket, 'function');
  assert.equal(typeof ctx.self.Bracket.places, 'function');
});
