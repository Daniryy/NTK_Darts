// «7 жизней»: перебить предыдущий подход, иначе минус жизнь; выбывание, лимит подходов, булл при равенстве.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../shared/games.js');

function game(cfg) {
  const vs = [];
  return v => { const r = G.play(cfg, vs, v); assert.equal(r.err, null); vs.push(v); return r.st; };
}

test('правила: первый подход без жизни, «столько же или меньше» — минус жизнь, выбывшие пропускают ход', () => {
  const pl = game({ ex: { k: 'lives', lives: 2, lim: 0 }, np: 3, ltw: 1 });
  let s = pl({ leg: 1, p: 0, v: 60 });
  assert.deepEqual(s.tot, [2, 2, 2]);
  s = pl({ leg: 1, p: 1, v: 60 }); // поровну — минус жизнь
  assert.deepEqual(s.tot, [2, 1, 2]);
  s = pl({ leg: 1, p: 2, v: 100 }); s = pl({ leg: 1, p: 0, v: 100 }); s = pl({ leg: 1, p: 1, v: 20 });
  assert.deepEqual(s.tot, [1, 0, 2]);
  assert.equal(s.cur, 2, 'выбывший пропускает ход');
  s = pl({ leg: 1, p: 2, v: 140 });
  assert.equal(s.cur, 0);
  s = pl({ leg: 1, p: 0, v: 26 });
  assert.equal(s.winner, 2, 'остался один — он выиграл');
});

test('лимит подходов: больше жизней — победа, поровну — бросок в булл', () => {
  const cfg = { ex: { k: 'lives', lives: 7, lim: 3 }, np: 2, ltw: 1 }, pl = game(cfg);
  let s;
  for (const [p, v] of [[0, 60], [1, 61], [0, 62], [1, 63], [0, 64], [1, 65]]) s = pl({ leg: 1, p, v });
  assert.equal(s.need, 'tb');
  assert.deepEqual(s.tie, [0, 1]);
  s = pl({ leg: 1, p: 1, tb: 1 });
  assert.equal(s.winner, 1);
  const pl2 = game(cfg);
  for (const [p, v] of [[0, 60], [1, 50], [0, 62], [1, 63], [0, 64], [1, 65]]) s = pl2({ leg: 1, p, v });
  assert.equal(s.winner, 0, 'у второго на жизнь меньше');
});

test('умолчания и проверки', () => {
  assert.deepEqual(G.norm({ k: 'lives' }), { k: 'lives', lives: 7, lim: 15 });
  assert.equal(G.norm({ k: 'lives', lives: 0 }), null);
  assert.equal(G.label({ k: 'lives' }), '7 жизней · 15 подходов');
  assert.match(G.check({ ex: { k: 'lives' }, np: 2, ltw: 1 }, [], { leg: 1, p: 0, v: 179 }), /нельзя набрать/);
});
