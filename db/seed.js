// Демо-данные как в makeSeed() на странице. «Вы» со страницы — игрок p17 (вход для разработки).
// node db/seed.js — заполнить пустую базу; --reset — стереть всё и заполнить заново (не в production).
const B = require('../shared/bracket.js');
const { pool, tx } = require('../server/db');
const { migrate } = require('./migrate');
const { loadTours, refreshTour, TOUR_SQL } = require('../server/tour');
const { eloAll, refreshStats } = require('../server/stats');

const SEED_PLAYERS = [
  ['p1', 'Артём Волков', 'volkov180', 'OCH-1001', 'Москва', '«Тройная двадцатка»', 88, 1],
  ['p2', 'Игорь Белов', 'belov_spb', 'OCH-1002', 'Санкт-Петербург', '«Северный дубль»', 85, 1],
  ['p3', 'Марина Соколова', 'sokolova_m', 'OCH-1003', 'Казань', '«Бычий глаз»', 80, 1],
  ['p4', 'Денис Карпов', 'karpov_d', 'OCH-1004', 'Москва', '«Тройная двадцатка»', 76, 1],
  ['p5', 'Олег Ткаченко', 'tkachenko_o', 'OCH-1005', 'Екатеринбург', '«Уральский сектор»', 74, 1],
  ['p6', 'Ксения Лебедева', 'lebedeva_k', 'OCH-1006', 'Москва', '«Оче-бар»', 71, 0],
  ['p7', 'Руслан Гаврилов', 'gavrilov_r', 'OCH-1007', 'Новосибирск', '«Сибирский дубль»', 69, 1],
  ['p8', 'Павел Зуев', 'zuev_pavel', 'OCH-1008', 'Санкт-Петербург', '«Северный дубль»', 67, 0],
  ['p9', 'Анна Мельникова', 'melnikova_a', 'OCH-1009', 'Москва', '«Оче-бар»', 64, 0],
  ['p10', 'Тимур Ахметов', 'akhmetov_t', 'OCH-1010', 'Казань', '«Бычий глаз»', 62, 0],
  ['p11', 'Сергей Орлов', 'orlov_nn', 'OCH-1011', 'Нижний Новгород', '', 60, 0],
  ['p12', 'Дмитрий Фомин', 'fomin_d', 'OCH-1012', 'Москва', '«Оче-бар»', 57, 0],
  ['p13', 'Елена Савина', 'savina_spb', 'OCH-1013', 'Санкт-Петербург', '', 55, 0],
  ['p14', 'Никита Рябов', 'ryabov_ekb', 'OCH-1014', 'Екатеринбург', '«Уральский сектор»', 52, 0],
  ['p15', 'Вадим Крылов', 'krylov_v', 'OCH-1015', 'Москва', '', 49, 0],
  ['p16', 'Юлия Ершова', 'ershova_nsk', 'OCH-1016', 'Новосибирск', '«Сибирский дубль»', 46, 0],
  ['p17', 'Тестовый Игрок', 'player_me', 'OCH-7749', 'Москва', '«Оче-бар»', 58, 0]
];
const ME = 'p17';
const CHECKOUTS = [16, 20, 24, 32, 36, 40, 32, 40, 50, 56, 60, 64, 68, 72, 76, 80, 81, 84, 87, 90, 96, 100, 104, 107, 110, 116, 121, 124, 130, 141, 150, 161, 167, 170];
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;

function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function makeData() {
  const R = rng(20261014), NOW = Date.now();
  const gauss = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pick = a => a[Math.floor(R() * a.length)];
  const byId = Object.fromEntries(SEED_PLAYERS.map(([id, name, , , , , base]) => [id, { id, name, base }]));
  const matches = [], tours = [];

  const line = (p, won, legs, isW, mode) => {
    const avg = Math.max(24, Math.min(112, p.base + gauss() * 5 + (isW ? 2 : -2)));
    const perLeg = mode / (avg / 3);
    const darts = Math.max(3, Math.round(won * (perLeg + 2) + (legs - won) * perLeg * 0.85));
    const visits = Math.round(darts / 3);
    const sk = Math.max(0, Math.min(1.1, (avg - 30) / 75));
    const cnt = q => { let c = 0; for (let i = 0; i < visits; i++) if (R() < q) c++; return c; };
    const c180 = cnt(0.002 + 0.06 * sk ** 3);
    const c140 = c180 + cnt(0.015 + 0.2 * sk * sk);
    const c100 = c140 + cnt(0.1 + 0.3 * sk);
    let hi = c180 ? 180 : c140 > c180 ? pick([140, 140, 140, 140, 145, 149, 151, 154, 160, 171, 177]) : c100 > c140 ? 100 + Math.floor(R() * 36) : 60 + Math.floor(R() * 40);
    let hco = 0, bl = 0, coa;
    if (won) {
      hco = CHECKOUTS[Math.min(CHECKOUTS.length - 1, Math.floor(CHECKOUTS.length * Math.pow(R(), 2.6 - 1.6 * sk)))];
      bl = Math.max(mode === 301 ? 6 : mode === 501 ? 9 : 12, Math.round(perLeg * 0.82 + R() * 5));
      coa = Math.max(won, Math.round(won / Math.max(0.1, Math.min(0.6, 0.12 + 0.3 * sk + gauss() * 0.05))));
      hi = Math.max(hi, hco);
    } else coa = Math.floor(R() * 3);
    return { player_id: p.id, name: p.name, legs: won, pts: Math.round(avg * darts / 3), darts, f9: +(avg + 3 + R() * 8).toFixed(1), hi, hco, c180, c140, c100, coh: won, coa, bl };
  };
  const addMatch = (a, b, t, o) => {
    const pa = byId[a], pb = byId[b], mode = o.mode || 501;
    const pr = 1 / (1 + Math.exp(-(pa.base - pb.base) / 9));
    let la = 0, lb = 0;
    while (la < o.ltw && lb < o.ltw) { if (R() < pr) la++; else lb++; }
    const m = { id: 'm' + (matches.length + 1), finished: Math.round(t), tid: o.tid || null, r: o.r == null ? null : o.r, i: o.i == null ? null : o.i, mode, ltw: o.ltw, w: la > lb ? 0 : 1,
      lines: [line(pa, la, la + lb, la > lb, mode), line(pb, lb, la + lb, lb > la, mode)] };
    matches.push(m);
    return m;
  };
  const T = o => { const t = Object.assign({ id: 't' + (tours.length + 1), mode: 501, status: 'live', cap: 16, owner: ME, orgName: null, orgVer: false, official: false, players: [], games: [] }, o); tours.push(t); return t; };
  const play = (t, g, time) => {
    const [a, b] = B.gamePlayersIn(t, g);
    const m = addMatch(a, b, time, { tid: t.id, r: g.r, i: g.i, ltw: t.ltw, mode: t.mode });
    g.res = { la: m.lines[0].legs, lb: m.lines[1].legs, w: m.w === 0 ? a : b, mid: m.id };
  };
  const bracket = (t, fmt, ids, upTo, gap) => {
    B.setBracket(t, fmt, ids.slice().sort((x, y) => byId[y].base - byId[x].base));
    let k = 0;
    t.games.forEach(g => {
      if ((upTo != null && k >= upTo) || B.gameState(t, g).st !== 'ready') return;
      play(t, g, t.start + 90 * MIN + k * gap);
      k++;
    });
  };
  const ALL16 = SEED_PLAYERS.slice(0, 16).map(p => p[0]);
  const LEAGUE = { official: true, orgName: 'Лига Oche', orgVer: true, owner: 'p1' };

  [92, 61, 31].forEach((d, k) => {
    const t = T(Object.assign({ name: 'Кубок Лиги Oche · этап ' + (k + 1), city: 'Москва', venue: 'Клуб «Тройная двадцатка»', start: NOW - d * DAY, ltw: 3 }, LEAGUE));
    bracket(t, 'pl', ALL16, null, 20 * MIN);
  });
  const spb = T({ name: 'Открытый чемпионат Петербурга', official: true, orgName: 'Клуб «Северный дубль»', orgVer: true, owner: 'p2', city: 'Санкт-Петербург', venue: 'Клуб «Северный дубль»', start: NOW - 24 * DAY, ltw: 3, cap: 8 });
  bracket(spb, 'ko', ['p2', 'p8', 'p13', 'p1', 'p4', 'p5', 'p3', 'p7'], null, 35 * MIN);
  const fr = T({ name: 'Дартс и пицца у Анны', owner: 'p9', city: 'Москва', venue: 'Квартирник', start: NOW - 10 * DAY, ltw: 2, cap: 5 });
  bracket(fr, 'pl', [ME, 'p9', 'p12', 'p15', 'p6'], null, 30 * MIN);
  // идущий этап ведёт тестовый игрок, чтобы проверять права организатора
  const live = T(Object.assign({ name: 'Кубок Лиги Oche · этап 4', city: 'Москва', venue: 'Клуб «Тройная двадцатка»', start: NOW - 6 * HOUR, ltw: 3 }, LEAGUE, { owner: ME }));
  bracket(live, 'pl', ALL16, 18, 15 * MIN);
  const rr = T({ name: 'Пятничная лига «Оче-бара»', owner: 'p4', city: 'Москва', venue: '«Оче-бар»', start: NOW - 14 * DAY - 3 * HOUR, ltw: 2, cap: 6, format: 'rr' });
  rr.players = [ME, 'p6', 'p9', 'p12', 'p15', 'p4'];
  rr.games = B.rrGames(rr.players);
  rr.games.forEach(g => { if (g.r < 3) play(rr, g, rr.start + g.r * 7 * DAY + g.i * 30 * MIN); });
  T({ name: 'Осенний кубок Казани', official: true, orgName: 'Клуб «Бычий глаз»', orgVer: true, owner: 'p3', city: 'Казань', venue: 'Клуб «Бычий глаз»', start: NOW + 25 * DAY, regUntil: NOW + 22 * DAY, status: 'reg', format: 'pl', ltw: 3, cap: 8, players: ['p3', 'p10', 'p5', 'p7', 'p11', 'p1', 'p2'] });
  T({ name: 'Ночной турнир в «Оче-баре»', owner: ME, city: 'Москва', venue: '«Оче-бар»', start: NOW + 3 * DAY, regUntil: NOW + 2 * DAY, status: 'reg', format: 'rr', ltw: 2, cap: 6, players: ['p6', 'p12', 'p9', 'p4'] });

  for (let k = 0; k < 36; k++) {
    let a = pick(ALL16), b = pick(ALL16);
    if (k % 4 === 1 || k === 3) a = ME;
    while (b === a) b = pick(ALL16);
    addMatch(a, b, NOW - (2 * HOUR + R() * 20 * DAY), { ltw: pick([1, 2, 2, 3]), mode: pick([501, 501, 501, 301]) });
  }
  return { tours, matches };
}

async function seed(c) {
  const now = Date.now(), { tours, matches } = makeData();
  for (const [id, name, handle, code, city, club, , ver] of SEED_PLAYERS) {
    await c.query('INSERT INTO players (id, name, handle, code, city, club, ver, admin, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, false, $8)', [id, name, handle, code, city, club, !!ver, now]);
  }
  await c.query(`SELECT setval('player_seq', $1)`, [SEED_PLAYERS.length]);
  for (const t of tours) {
    await c.query(`INSERT INTO tournaments (id, name, official, owner_id, org_name, org_ver, city, venue, start, reg_until, status, format, mode, ltw, cap, slots, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [t.id, t.name, t.official, t.owner, t.orgName, t.orgVer, t.city, t.venue, t.start, t.regUntil || null, t.status, t.format, t.mode, t.ltw, t.cap, t.slots ? JSON.stringify(t.slots) : null, now]);
    await c.query('INSERT INTO entries (tournament_id, player_id, seed_no) SELECT $1, x.id, x.n FROM unnest($2::text[]) WITH ORDINALITY AS x(id, n)', [t.id, t.players]);
  }
  await c.query(`SELECT setval('tour_seq', $1)`, [tours.length]);
  for (const m of matches) {
    const pl = m.lines.map(l => ({ id: l.player_id, name: l.name }));
    await c.query(`INSERT INTO matches (id, tournament_id, r, i, status, mode, ltw, dbl, players, legs, w, created_by, started, finished)
      VALUES ($1, $2, $3, $4, 'done', $5, $6, true, $7, $8, $9, $10, $11, $12)`,
    [m.id, m.tid, m.r, m.i, m.mode, m.ltw, JSON.stringify(pl), JSON.stringify(m.lines.map(l => l.legs)), m.w, pl[0].id, m.finished - 20 * MIN, m.finished]);
    for (const [k, l] of m.lines.entries()) {
      await c.query(`INSERT INTO match_lines (match_id, idx, player_id, name, legs, pts, darts, f9, hi, hco, c180, c140, c100, coh, coa, bl)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [m.id, k, l.player_id, l.name, l.legs, l.pts, l.darts, l.f9, l.hi, l.hco, l.c180, l.c140, l.c100, l.coh, l.coa, l.bl]);
    }
  }
  for (const t of await loadTours(c, (await c.query(TOUR_SQL + ` WHERE t.status <> 'reg'`)).rows)) await refreshTour(c, t);
  await eloAll(c);
  await refreshStats(c, SEED_PLAYERS.map(p => p[0]));
  return { players: SEED_PLAYERS.length, tours: tours.length, matches: matches.length };
}

async function main() {
  if (process.argv.includes('--reset')) {
    if (process.env.NODE_ENV === 'production') throw new Error('--reset запрещён в production');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  }
  await migrate();
  const n = (await pool.query('SELECT count(*) AS n FROM players')).rows[0].n;
  if (n > 0) { console.log('База уже заполнена (' + n + ' игроков). Для пересоздания: npm run seed -- --reset'); return; }
  const r = await tx(seed);
  console.log('Демо-данные: ' + r.players + ' игроков, ' + r.tours + ' турниров, ' + r.matches + ' матчей. Вход для разработки: ' + ME);
}

if (require.main === module) main().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });

module.exports = { seed, ME };
