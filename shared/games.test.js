// Запуск: node --test shared/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const G = require('./games.js');

// сыграть подходы по очереди, каждый должен пройти проверку
function run(cfg, list) {
  const vs = [];
  list.forEach((v, k) => {
    const err = G.check(cfg, vs, v);
    assert.equal(err, null, 'подход №' + (k + 1) + ': ' + err);
    vs.push(v);
  });
  return { vs, st: G.state(cfg, vs) };
}
// лег «по очереди»: vals[j] — значения подходов игрока j
function alt(cfg, leg, vals, mk) {
  const st = G.state(cfg, cfg._vs || []), out = [];
  let p = st.cur;
  const k = Array(cfg.np).fill(0);
  for (let n = 0; n < vals.reduce((a, x) => a + x.length, 0); n++) { out.push(mk(leg, p, vals[p][k[p]++])); p = (p + 1) % cfg.np; }
  return out;
}

test('norm: умолчания и неверные упражнения', () => {
  assert.deepEqual(G.norm({ k: 'score' }), { k: 'score', lim: 10 });
  assert.deepEqual(G.norm({ k: 'sector' }), { k: 'sector', sec: 20, lim: 10 });
  assert.deepEqual(G.norm({ k: 'cricket' }), { k: 'cricket', lim: 10 });
  assert.deepEqual(G.norm({ k: 'cricket', lim: 0 }), { k: 'cricket', lim: 0 });
  assert.deepEqual(G.norm({ k: 'x01', mode: 501, lim: 10 }), { k: 'x01', mode: 501, dbl: true, lim: 10 });
  assert.equal(G.norm({ k: 'x01', mode: 400 }), null);
  assert.equal(G.norm({ k: 'golf' }), null);
  assert.equal(G.norm({ k: 'sector', sec: 21 }), null);
  assert.equal(G.label({ k: 'score' }), 'Набор очков · 10 подходов');
  assert.equal(G.label({ k: 'round' }), 'Большой раунд');
  assert.equal(G.label({ k: 'x01', mode: 501, lim: 10 }), '501 · 10 подходов');
});

test('Набор очков: квалификация одного игрока — 10 подходов, сумма', () => {
  const cfg = { ex: { k: 'score' }, np: 1, ltw: 1 };
  const pts = [100, 60, 85, 140, 45, 81, 100, 26, 180, 28];
  const { st } = run(cfg, pts.map(v => ({ leg: 1, p: 0, v })));
  assert.equal(st.winner, 0);
  assert.equal(st.legsLog[0].tot[0], 845);
  assert.equal(st.pts[0], 845);
  assert.equal(st.darts[0], 30);
  assert.equal(G.avg(st.pts[0], st.darts[0]), 84.5);
  assert.match(G.check(cfg, [], { leg: 1, p: 0, v: 179 }), /нельзя/);
  assert.match(G.check(cfg, [], { leg: 1, p: 0, v: 60, d: ['T20', 'T20', '0'] }), /Сумма/);
  assert.equal(G.check(cfg, [], { leg: 1, p: 0, v: 120, d: ['T20', 'T20', '0'] }), null);
});

test('Набор очков: матч до 2 побед, ничья в леге — бросок в булл', () => {
  const cfg = { ex: { k: 'score', lim: 3 }, np: 2, ltw: 2, starter: 0 };
  // лег 1: 300 против 240
  let r = run(cfg, alt(cfg, 1, [[100, 100, 100], [80, 80, 80]], (leg, p, v) => ({ leg, p, v })));
  assert.deepEqual(r.st.legs, [1, 0]);
  assert.equal(r.st.leg, 2);
  assert.equal(r.st.cur, 1, 'второй лег начинает второй игрок');
  // лег 2: ничья 180:180
  cfg._vs = r.vs;
  const leg2 = alt(cfg, 2, [[60, 60, 60], [60, 60, 60]], (leg, p, v) => ({ leg, p, v }));
  r = run(cfg, r.vs.concat(leg2));
  assert.equal(r.st.need, 'tb');
  assert.deepEqual(r.st.tie, [0, 1]);
  assert.equal(r.st.cur, null);
  assert.match(G.check(cfg, r.vs, { leg: 2, p: 0, v: 10 }), /булл/);
  const fin = G.play(cfg, r.vs, { leg: 2, p: 1, tb: 1 });
  assert.equal(fin.err, null);
  assert.deepEqual(fin.st.legs, [1, 1]);
  assert.equal(fin.st.leg, 3);
  assert.match(G.check(cfg, r.vs.concat([{ leg: 2, p: 1, tb: 1 }]), { leg: 3, p: 1, tb: 1 }), /только при ничьей/);
});

test('Большой раунд: 21 подход, очки = попадания × сектор, булл до 6 попаданий', () => {
  const cfg = { ex: { k: 'round' }, np: 1, ltw: 1 };
  const hits = Array.from({ length: 21 }, (_, k) => k % 4);
  const list = hits.map(v => ({ leg: 1, p: 0, v }));
  const { st } = run(cfg, list);
  const want = hits.reduce((a, h, k) => a + h * (k < 20 ? k + 1 : 25), 0);
  assert.equal(st.legsLog[0].tot[0], want);
  assert.equal(st.winner, 0);
  // 20-й сектор и булл
  const vs = list.slice(0, 20);
  assert.match(G.check(cfg, vs, { leg: 1, p: 0, v: 7 }), /булл: от 0 до 6/);
  assert.equal(G.check(cfg, vs, { leg: 1, p: 0, v: 3, d: ['Bull', '25', '0'] }), null);
  assert.match(G.check(cfg, vs, { leg: 1, p: 0, v: 2, d: ['Bull', '25', '0'] }), /не дают/);
  assert.equal(G.check(cfg, list.slice(0, 2), { leg: 1, p: 0, v: 9, d: ['T3', 'T3', 'T3'] }), null);
  assert.equal(G.target({ k: 'round' }, 0), 1);
  assert.equal(G.target({ k: 'round' }, 20), 25);
});

test('Сектор 20: считаются попадания (дубль 2, трипл 3), не очки', () => {
  const cfg = { ex: { k: 'sector' }, np: 2, ltw: 1, starter: 0 };
  const list = [];
  for (let k = 0; k < 10; k++) { list.push({ leg: 1, p: 0, v: 3 }); list.push({ leg: 1, p: 1, v: 2 }); }
  list[0] = { leg: 1, p: 0, v: 5, d: ['T20', 'D20', '1'] };
  const { st } = run(cfg, list);
  assert.deepEqual(st.legsLog[0].tot, [32, 20]);
  assert.equal(st.winner, 0);
  assert.match(G.check(cfg, [], { leg: 1, p: 0, v: 10 }), /от 0 до 9/);
});

test('Крикет: закрытие с перевесом по очкам выигрывает лег, неполный подход только при закрытии', () => {
  const cfg = { ex: { k: 'cricket', lim: 0 }, np: 2, ltw: 1, starter: 0 };
  const v = (p, d) => ({ leg: 1, p, d });
  const list = [
    v(0, ['T20', 'T20', 'T19']), v(1, ['0', '0', '0']),       // 0: 20 закрыт + 60 очков, 19 закрыт
    v(0, ['T18', 'T17', 'T16']), v(1, ['5', '5', '5']),
    v(0, ['T15', 'Bull', '25'])                                 // всё закрыто, очков 60 > 0
  ];
  const { st } = run(cfg, list);
  assert.equal(st.winner, 0);
  assert.equal(st.legsLog[0].tot[0], 60);
  assert.equal(st.pts[0], 24, 'меток за матч: 9 + 9 + 6 (три метки по 20 пошли в очки)');
  const cut = list.slice(0, 4);
  assert.equal(G.check(cfg, cut, v(0, ['T15', 'Bull', '25'])), null);
  assert.match(G.check(cfg, cut, v(0, ['T15'])), /только при закрытии/);
  assert.match(G.check(cfg, cut, v(0, ['X1'])), /метки/);
  // закрыл всё, но очков меньше — игра продолжается
  const c2 = { ex: { k: 'cricket', lim: 0 }, np: 2, ltw: 1, starter: 0 };
  const l2 = [v(0, ['0', '0', '0']), v(1, ['T20', 'T20', 'T20']), v(0, ['T20', 'T19', 'T18']), v(1, ['0', '0', '0']), v(0, ['T17', 'T16', 'T15']), v(1, ['0', '0', '0']), v(0, ['Bull', '25', '0'])];
  const r2 = run(c2, l2);
  assert.equal(r2.st.winner, null, 'у второго 120 очков');
  assert.equal(r2.st.cur, 1);
});

test('Крикет 10 подходов: без закрытия побеждают очки, затем метки', () => {
  const cfg = { ex: { k: 'cricket' }, np: 2, ltw: 1, starter: 0 };
  const list = [];
  for (let k = 0; k < 10; k++) { list.push({ leg: 1, p: 0, d: k === 0 ? ['T20', 'T19', '0'] : ['0', '0', '0'] }); list.push({ leg: 1, p: 1, d: k === 0 ? ['T20', '0', '0'] : ['0', '0', '0'] }); }
  const { st } = run(cfg, list);
  assert.deepEqual(st.legsLog[0].tot, [0, 0]);
  assert.equal(st.winner, 0, 'очков поровну, у первого больше меток');
});

test('501 с лимитом 10 подходов: закрытие раньше лимита или меньший остаток', () => {
  const cfg = { ex: { k: 'x01', mode: 501, lim: 10 }, np: 2, ltw: 1, starter: 0 };
  const sc = [501, 501], list = [];
  for (let k = 0; k < 10; k++) for (const p of [0, 1]) { const pts = p ? 40 : 45; list.push({ leg: 1, p, s: sc[p], pts, n: 3, b: 0, d: null }); sc[p] -= pts; }
  const { st } = run(cfg, list);
  assert.deepEqual(st.legsLog[0].tot, [51, 101]);
  assert.equal(st.winner, 0);
  // закрытие на 9-м подходе
  const c2 = { ex: { k: 'x01', mode: 301, lim: 10 }, np: 2, ltw: 1, starter: 0 };
  const s2 = [301, 301], l2 = [];
  const plan = [100, 100, 60, 41];
  for (let k = 0; k < 4; k++) for (const p of [0, 1]) {
    if (p === 1 && k === 3) break;
    const pts = p ? 20 : plan[k], n = p === 0 && k === 3 ? 2 : 3;
    l2.push({ leg: 1, p, s: s2[p], pts, n, b: 0, d: null }); s2[p] -= pts;
  }
  const r2 = run(c2, l2);
  assert.equal(r2.st.winner, 0);
  assert.equal(r2.st.darts[0], 11);
});

test('501 без лимита: как раньше на сервере — перебор, закрытие через дубль', () => {
  const cfg = { ex: G.x01(501, true), np: 2, ltw: 2, starter: 0 };
  const v = (p, s, pts, n = 3, b = 0) => ({ leg: 1, p, s, pts, n, b, d: null });
  assert.match(G.check(cfg, [], v(0, 501, 179)), /нельзя/);
  assert.match(G.check(cfg, [], v(1, 501, 60)), /игрок 1/);
  assert.match(G.check(cfg, [], v(0, 500, 60)), /Остаток/);
  const list = [v(0, 501, 180), v(1, 501, 60), v(0, 321, 180), v(1, 441, 60), v(0, 141, 0, 3, 1), v(1, 381, 60), v(0, 141, 141)];
  const { st } = run(cfg, list);
  assert.deepEqual(st.legs, [1, 0]);
  assert.equal(st.leg, 2);
  assert.equal(st.cur, 1);
  assert.equal(st.pts[0], 501);
});

test('модуль грузится в браузере как глобальный Games', () => {
  const src = fs.readFileSync(path.join(__dirname, 'games.js'), 'utf8');
  const ctx = { self: {} };
  vm.runInNewContext(src, ctx);
  assert.equal(typeof ctx.self.Games.state, 'function');
});
