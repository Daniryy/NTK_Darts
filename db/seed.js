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
// игроки лиги NDL для демо-турниров с квалификацией (как NDL_PLAYERS на странице)
const NDL_PLAYERS = [
  ['p18', 'Дмитрий Горбунов', 'gorbunov_d', 'OCH-1018', 'Новоуральск', '«Новоуральская Дартс Лига»', 77, 1],
  ['p19', 'Алексей Козеев', 'kozeev_a', 'OCH-1019', 'Новоуральск', '«Новоуральская Дартс Лига»', 82, 0],
  ['p20', 'Ирина Сыханова', 'syhanova_i', 'OCH-1020', 'Новоуральск', '«Новоуральская Дартс Лига»', 63, 0]
];
// ещё игроки, чтобы показать большую сетку на 64 (как MORE_PLAYERS на странице)
const MORE_PLAYERS = [
  ['p21', 'Максим Захаров', 'zakharov_21', 'OCH-1021', 'Новосибирск', '«Сибирский дубль»', 66, 1],
  ['p22', 'Иван Воробьёв', 'vorobiev_22', 'OCH-1022', 'Новосибирск', '«Сибирский дубль»', 71, 1],
  ['p23', 'Кирилл Попов', 'popov_23', 'OCH-1023', 'Нижний Новгород', '', 67, 1],
  ['p24', 'Екатерина Андреева', 'andreeva_24', 'OCH-1024', 'Краснодар', '', 69, 1],
  ['p25', 'Андрей Богданов', 'bogdanov_25', 'OCH-1025', 'Москва', '«Тройная двадцатка»', 69, 1],
  ['p26', 'Евгений Кузнецов', 'kuznetsov_26', 'OCH-1026', 'Санкт-Петербург', '«Северный дубль»', 62, 0],
  ['p27', 'Роман Степанов', 'stepanov_27', 'OCH-1027', 'Новоуральск', '«Новоуральская Дартс Лига»', 60, 0],
  ['p28', 'Вера Лебедева', 'lebedeva2_28', 'OCH-1028', 'Казань', '«Бычий глаз»', 59, 0],
  ['p29', 'Илья Смирнов', 'smirnov_29', 'OCH-1029', 'Москва', '«Тройная двадцатка»', 63, 1],
  ['p30', 'Григорий Козлов', 'kozlov_30', 'OCH-1030', 'Новоуральск', '«Новоуральская Дартс Лига»', 64, 1],
  ['p31', 'Владимир Голубев', 'golubev_31', 'OCH-1031', 'Самара', '«Волжская стрела»', 57, 0],
  ['p32', 'Ольга Новикова', 'novikova_32', 'OCH-1032', 'Нижний Новгород', '', 60, 0],
  ['p33', 'Константин Морозов', 'morozov_33', 'OCH-1033', 'Санкт-Петербург', '«Северный дубль»', 62, 0],
  ['p34', 'Степан Семёнов', 'semenov_34', 'OCH-1034', 'Москва', '«Тройная двадцатка»', 61, 0],
  ['p35', 'Фёдор Беляев', 'belyaev_35', 'OCH-1035', 'Москва', '«Оче-бар»', 54, 0],
  ['p36', 'Мария Морозова', 'morozova_36', 'OCH-1036', 'Самара', '«Волжская стрела»', 59, 0],
  ['p37', 'Борис Михайлов', 'mikhailov_37', 'OCH-1037', 'Краснодар', '', 59, 0],
  ['p38', 'Пётр Петров', 'petrov_38', 'OCH-1038', 'Краснодар', '', 57, 0],
  ['p39', 'Арсений Зайцев', 'zaitsev_39', 'OCH-1039', 'Москва', '«Тройная двадцатка»', 53, 0],
  ['p40', 'Полина Макарова', 'makarova_40', 'OCH-1040', 'Москва', '«Оче-бар»', 55, 0],
  ['p41', 'Александр Петров', 'petrov_41', 'OCH-1041', 'Казань', '«Бычий глаз»', 51, 0],
  ['p42', 'Максим Зайцев', 'zaitsev_42', 'OCH-1042', 'Самара', '«Волжская стрела»', 51, 0],
  ['p43', 'Иван Фёдоров', 'fedorov_43', 'OCH-1043', 'Краснодар', '', 52, 0],
  ['p44', 'Татьяна Егорова', 'egorova_44', 'OCH-1044', 'Санкт-Петербург', '«Северный дубль»', 50, 0],
  ['p45', 'Михаил Захаров', 'zakharov_45', 'OCH-1045', 'Новосибирск', '«Сибирский дубль»', 49, 0],
  ['p46', 'Андрей Воробьёв', 'vorobiev_46', 'OCH-1046', 'Санкт-Петербург', '«Северный дубль»', 52, 0],
  ['p47', 'Евгений Попов', 'popov_47', 'OCH-1047', 'Нижний Новгород', '', 47, 0],
  ['p48', 'Дарья Козлова', 'kozlova_48', 'OCH-1048', 'Самара', '«Волжская стрела»', 48, 0],
  ['p49', 'Илья Кузнецов', 'kuznetsov_49', 'OCH-1049', 'Казань', '«Бычий глаз»', 48, 0],
  ['p50', 'Григорий Степанов', 'stepanov_50', 'OCH-1050', 'Санкт-Петербург', '«Северный дубль»', 43, 0],
  ['p51', 'Владимир Виноградов', 'vinogradov_51', 'OCH-1051', 'Новосибирск', '«Сибирский дубль»', 46, 0],
  ['p52', 'Софья Волкова', 'volkova_52', 'OCH-1052', 'Екатеринбург', '«Уральский сектор»', 43, 0],
  ['p53', 'Константин Козлов', 'kozlov_53', 'OCH-1053', 'Екатеринбург', '«Уральский сектор»', 41, 0],
  ['p54', 'Степан Голубев', 'golubev_54', 'OCH-1054', 'Самара', '«Волжская стрела»', 41, 0],
  ['p55', 'Фёдор Тарасов', 'tarasov_55', 'OCH-1055', 'Москва', '«Оче-бар»', 45, 0],
  ['p56', 'Светлана Кузнецова', 'kuznetsova_56', 'OCH-1056', 'Нижний Новгород', '', 43, 0],
  ['p57', 'Лев Семёнов', 'semenov_57', 'OCH-1057', 'Новоуральск', '«Новоуральская Дартс Лига»', 39, 0],
  ['p58', 'Борис Беляев', 'belyaev_58', 'OCH-1058', 'Екатеринбург', '«Уральский сектор»', 39, 0],
  ['p59', 'Пётр Новиков', 'novikov_59', 'OCH-1059', 'Нижний Новгород', '', 41, 0],
  ['p60', 'Алина Попова', 'popova_60', 'OCH-1060', 'Санкт-Петербург', '«Северный дубль»', 36, 0],
  ['p61', 'Александр Новиков', 'novikov_61', 'OCH-1061', 'Нижний Новгород', '', 34, 0],
  ['p62', 'Максим Павлов', 'pavlov_62', 'OCH-1062', 'Санкт-Петербург', '«Северный дубль»', 39, 0],
  ['p63', 'Иван Михайлов', 'mikhailov_63', 'OCH-1063', 'Самара', '«Волжская стрела»', 36, 0],
  ['p64', 'Людмила Орлова', 'orlova_64', 'OCH-1064', 'Казань', '«Бычий глаз»', 36, 0]
];
const ALL_PLAYERS = SEED_PLAYERS.concat(NDL_PLAYERS, MORE_PLAYERS);
const ME = 'p17';
const CHECKOUTS = [16, 20, 24, 32, 36, 40, 32, 40, 50, 56, 60, 64, 68, 72, 76, 80, 81, 84, 87, 90, 96, 100, 104, 107, 110, 116, 121, 124, 130, 141, 150, 161, 167, 170];
const MIN = 6e4, HOUR = 36e5, DAY = 864e5;

function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function makeData() {
  const R = rng(20261014), NOW = Date.now();
  const gauss = () => { let u = 0, v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const pick = a => a[Math.floor(R() * a.length)];
  const byId = Object.fromEntries(ALL_PLAYERS.map(([id, name, , , , , base]) => [id, { id, name, base }]));
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
  const SCORE = { k: 'score', lim: 10 };
  const total = p => Math.max(150, Math.min(1500, Math.round(p.base * 10 + gauss() * 55)));
  const qualOf = ids => Object.fromEntries(ids.map(id => [id, R() < 0.75 ? [total(byId[id]), total(byId[id])] : [total(byId[id])]]));
  // завершённый турнир по-новому: квалификация «Набор очков», места по квалификации, сетки по 8 мест, все матчи сыграны
  const qualTour = (o, ids, gap) => {
    const t = T(Object.assign({ cap: ids.length, split: 8, format: 'pl', layout: 'ndl', labels: 'ab' }, o));
    t.qual = { ex: SCORE, tries: 2, res: qualOf(ids) };
    const order = ids.slice().sort((x, y) => Math.max(...t.qual.res[y]) - Math.max(...t.qual.res[x]));
    B.setBracket(t, 'pl', order, 8);
    t.nums = Object.fromEntries(order.map((id, k) => [id, k + 1]));
    let k = 0;
    t.games.forEach(g => { if (B.gameState(t, g).st === 'ready') { play(t, g, t.start + 60 * MIN + k * gap); k++; } });
    return t;
  };
  const ALL64 = ALL16.concat([ME], NDL_PLAYERS.map(p => p[0]), MORE_PLAYERS.map(p => p[0]));
  // большая сетка: 64 игрока, 8 сеток по 8 мест
  qualTour(Object.assign({ name: 'Гран-при Oche · финал сезона', city: 'Москва', venue: 'Клуб «Тройная двадцатка»', start: NOW - 92 * DAY, ltw: 2 }, LEAGUE), ALL64, 4 * MIN);
  // средняя: 24 игрока, 3 сетки
  qualTour(Object.assign({ name: 'Кубок Лиги Oche · этап 2', city: 'Москва', venue: 'Клуб «Тройная двадцатка»', start: NOW - 61 * DAY, ltw: 2 }, LEAGUE), ALL16.concat(['p21', 'p22', 'p23', 'p24', 'p25', 'p29', 'p30', 'p33']), 7 * MIN);
  qualTour(Object.assign({ name: 'Кубок Лиги Oche · этап 3', city: 'Москва', venue: 'Клуб «Тройная двадцатка»', start: NOW - 31 * DAY, ltw: 3 }, LEAGUE), ALL16, 12 * MIN);
  // маленькая: 8 игроков, одна сетка
  qualTour({ name: 'Открытый чемпионат Петербурга', club: 'c2', official: true, orgName: 'Клуб «Северный дубль»', orgVer: true, owner: 'p2', city: 'Санкт-Петербург', venue: 'Клуб «Северный дубль»', start: NOW - 24 * DAY, ltw: 3 }, ['p2', 'p8', 'p13', 'p1', 'p4', 'p5', 'p3', 'p7'], 25 * MIN);
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

  // NDL: квалификация «Набор очков» (лучшая из двух попыток), затем сетки по 8 мест; матчи — «Набор очков» до 2 побед
  const NDL_ORG = { official: true, orgName: 'Новоуральская Дартс Лига', orgVer: true, owner: ME };
  const NDL20 = ALL16.concat([ME, 'p18', 'p19', 'p20']);
  const scoreMatch = (t, g, time) => {
    const [a, b] = B.gamePlayersIn(t, g), legs = [0, 0], sc = [[], []];
    while (legs[0] < t.ltw && legs[1] < t.ltw) {
      let x = total(byId[a]), y = total(byId[b]);
      if (x === y) x++;
      sc[0].push(x); sc[1].push(y); legs[x > y ? 0 : 1]++;
    }
    const n = sc[0].length, mk = (id, k) => ({ player_id: id, name: byId[id].name, legs: legs[k], pts: sc[k].reduce((s, v) => s + v, 0), darts: 30 * n, f9: null, hi: 0, hco: 0, c180: 0, c140: 0, c100: 0, coh: legs[k], coa: legs[k], bl: 0, sc: sc[k] });
    const m = { id: 'm' + (matches.length + 1), finished: Math.round(time), tid: t.id, r: g.r, i: g.i, mode: 501, ltw: t.ltw, ex: SCORE, w: legs[0] > legs[1] ? 0 : 1, lines: [mk(a, 0), mk(b, 1)] };
    matches.push(m);
    g.res = { la: legs[0], lb: legs[1], w: m.w === 0 ? a : b, mid: m.id };
  };
  const ndl = T(Object.assign({ name: 'Лига NDL · этап 2', city: 'Новоуральск', venue: 'Клуб NDL', start: NOW - 4 * HOUR, ltw: 2, cap: 20, ex: SCORE, split: 8, layout: 'ndl', labels: 'ab', boards: { n: 6, at: {} } }, NDL_ORG));
  ndl.qual = { ex: SCORE, tries: 2, res: qualOf(NDL20) };
  const best = id => Math.max(...ndl.qual.res[id]);
  const order = NDL20.slice().sort((x, y) => best(y) - best(x));
  B.setBracket(ndl, 'pl', order, 8);
  ndl.nums = Object.fromEntries(order.map((id, k) => [id, k + 1]));
  let k = 0;
  ndl.games.forEach(g => { if (k < 17 && B.gameState(ndl, g).st === 'ready') { scoreMatch(ndl, g, ndl.start + 70 * MIN + k * 6 * MIN); k++; } });
  B.assignBoards(ndl);
  // следующий этап: идёт квалификация, часть игроков уже сдала
  const nq = T(Object.assign({ name: 'Лига NDL · этап 3', city: 'Новоуральск', venue: 'Клуб NDL', start: NOW - 40 * MIN, ltw: 2, cap: 20, ex: SCORE, split: 8, layout: 'ndl', labels: 'ab', stage: 'qual', format: 'pl' }, NDL_ORG));
  nq.players = NDL20.filter(id => id !== ME).concat([ME]);
  nq.qual = { ex: SCORE, tries: 2, res: qualOf(nq.players.slice(0, 12)) };
  return { tours, matches };
}

async function seed(c) {
  const now = Date.now(), { tours, matches } = makeData();
  // роли: тестовый игрок — тех. администратор (проверять всё), p4 — администратор, p1 и p2 — ведущие клубов
  const ROLE = { [ME]: 'tech', p4: 'admin', p1: 'host', p2: 'host' };
  for (const [id, name, handle, code, city, club, , ver] of ALL_PLAYERS) {
    // ведущим роль выдана вручную (base_role): клуб её не даёт
    await c.query('INSERT INTO players (id, name, handle, code, city, club, ver, role, base_role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)', [id, name, handle, code, city, club, !!ver, ROLE[id] || 'player', ROLE[id] === 'host' ? 'host' : 'player', now]);
  }
  await c.query(`SELECT setval('player_seq', $1)`, [ALL_PLAYERS.length]);
  // клубы: два подтверждённых с ведущими и одна заявка на рассмотрении
  const CLUBS = [
    ['c1', 'Клуб «Тройная двадцатка»', 'Москва', 'ул. Лесная, 5', '+7 495 000-00-20', 'Шесть мишеней, турниры по пятницам.', 'active', 'p1'],
    ['c2', 'Клуб «Северный дубль»', 'Санкт-Петербург', 'Невский пр., 100', 'vk.com/north_double', 'Открытый чемпионат Петербурга.', 'active', 'p2'],
    ['c3', 'Квартирник у Анны', 'Москва', '', '@melnikova_a', 'Домашние турниры для друзей.', 'pending', 'p9']
  ];
  for (const [id, name, city, address, contact, about, status, owner] of CLUBS) {
    await c.query(`INSERT INTO clubs (id, name, city, address, contact, about, status, owner_id, decided_by, decided_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, name, city, address, contact, about, status, owner, status === 'active' ? 'p4' : null, status === 'active' ? now : null, now - 30 * 864e5]);
    if (status === 'active') await c.query('INSERT INTO club_hosts (club_id, player_id) VALUES ($1, $2)', [id, owner]);
  }
  await c.query(`SELECT setval('club_seq', $1)`, [CLUBS.length]);
  // пример баннера в ленте
  await c.query(`INSERT INTO banners (place, title, body, link, active, created_by, created_at) VALUES ('feed', $1, $2, NULL, true, $3, $4)`,
    ['Место для вашей рекламы', 'Баннеры показываются в ленте, на странице турнира и на табло. Ведёт тех. администратор.', ME, now]);
  // свои номера у тестового игрока: постоянные игроки «Оче-бара»
  for (const [n, pid] of [[1, 'p6'], [2, 'p9'], [3, 'p12'], [4, 'p15'], [5, 'p4'], [7, 'p35'], [8, 'p40'], [9, 'p55']]) await c.query('INSERT INTO host_nums (host_id, n, player_id) VALUES ($1, $2, $3)', [ME, n, pid]);
  const js = v => v == null ? null : JSON.stringify(v);
  for (const t of tours) {
    await c.query(`INSERT INTO tournaments (id, name, official, owner_id, org_name, org_ver, city, venue, start, reg_until, status, format, mode, ltw, cap, slots,
      ex, qual, split, block, stage, boards, nums, club_id, layout, labels, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)`,
    [t.id, t.name, t.official, t.owner, t.orgName, t.orgVer, t.city, t.venue, t.start, t.regUntil || null, t.status, t.format, t.mode, t.ltw, t.cap, js(t.slots),
      js(t.ex), t.qual ? js({ ex: t.qual.ex, tries: t.qual.tries }) : null, t.split || null, t.block || null, t.stage || null, js(t.boards), js(t.nums), t.club || null, t.layout || null, t.labels || null, now]);
    await c.query('INSERT INTO entries (tournament_id, player_id, seed_no) SELECT $1, x.id, x.n FROM unnest($2::text[]) WITH ORDINALITY AS x(id, n)', [t.id, t.players]);
    if (t.qual) for (const [pid, vs] of Object.entries(t.qual.res)) for (const [k, v] of vs.entries()) {
      await c.query('INSERT INTO qual_results (tournament_id, player_id, try, v, t) VALUES ($1, $2, $3, $4, $5)', [t.id, pid, k, v, t.start + 5 * MIN]);
    }
  }
  await c.query(`SELECT setval('tour_seq', $1)`, [tours.length]);
  for (const m of matches) {
    const pl = m.lines.map(l => ({ id: l.player_id, name: l.name }));
    await c.query(`INSERT INTO matches (id, tournament_id, r, i, status, mode, ltw, dbl, ex, players, legs, w, created_by, started, finished)
      VALUES ($1, $2, $3, $4, 'done', $5, $6, true, $7, $8, $9, $10, $11, $12, $13)`,
    [m.id, m.tid, m.r, m.i, m.mode, m.ltw, js(m.ex), JSON.stringify(pl), JSON.stringify(m.lines.map(l => l.legs)), m.w, pl[0].id, m.finished - 20 * MIN, m.finished]);
    for (const [k, l] of m.lines.entries()) {
      await c.query(`INSERT INTO match_lines (match_id, idx, player_id, name, legs, pts, darts, f9, hi, hco, c180, c140, c100, coh, coa, bl, sc)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [m.id, k, l.player_id, l.name, l.legs, l.pts, l.darts, l.f9, l.hi, l.hco, l.c180, l.c140, l.c100, l.coh, l.coa, l.bl, js(l.sc)]);
    }
  }
  for (const t of await loadTours(c, (await c.query(TOUR_SQL + ` WHERE t.status <> 'reg'`)).rows)) await refreshTour(c, t);
  await eloAll(c);
  await refreshStats(c, ALL_PLAYERS.map(p => p[0]));
  return { players: ALL_PLAYERS.length, tours: tours.length, matches: matches.length };
}

async function main() {
  if (process.argv.includes('--reset')) {
    // на VPS сбросить можно только демо-сервер (DEMO=1): его база и фото пересоздаются каждую ночь
    if (process.env.NODE_ENV === 'production' && process.env.DEMO !== '1') throw new Error('--reset запрещён в production');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    if (process.env.DEMO === '1') {
      const fs = require('node:fs'), path = require('node:path'), config = require('../server/config');
      for (const dir of [config.uploadDir, config.privateDir]) {
        try { for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true }); } catch (e) { /* папки ещё нет */ }
      }
    }
  }
  await migrate();
  const n = (await pool.query('SELECT count(*) AS n FROM players')).rows[0].n;
  if (n > 0) { console.log('База уже заполнена (' + n + ' игроков). Для пересоздания: npm run seed -- --reset'); return; }
  const r = await tx(seed);
  // демо-сервер: ещё турниры новых форматов — через маршруты сервера, как ведущий на сайте
  if (process.env.DEMO === '1') await require('./demo-extra').demoExtra();
  console.log('Демо-данные: ' + r.players + ' игроков, ' + r.tours + ' турниров, ' + r.matches + ' матчей.' + (process.env.NODE_ENV === 'production' ? '' : ' Вход для разработки: ' + ME));
}

if (require.main === module) main().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });

module.exports = { seed, ME };
