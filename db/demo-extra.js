// Демо для показа: турниры новых форматов, созданные и сыгранные через обычные маршруты сервера — как ведущий на сайте.
// Запуск после seed на демо-сервере (DEMO=1) или локально: node db/demo-extra.js
const { build } = require('../server/app');
const B = require('../shared/bracket.js');

const HOST = 'p1', PLAYERS = ['p6', 'p7', 'p8', 'p9', 'p10', 'p11', 'p12', 'p13', 'p14', 'p15', 'p16', 'p18'];

async function demoExtra() {
  // десятки запросов подряд с одного «устройства» — без лимита частоты на время наполнения
  const config = require('../server/config'), rate = config.rateMax;
  config.rateMax = 1e6;
  const app = build({ logger: false });
  await app.ready();
  let cookie = '';
  const call = async (method, url, body) => {
    const r = await app.inject({ method, url, payload: body, headers: { 'x-device-id': 'device_demo_extra_01', cookie } });
    const sid = r.cookies.find(c => /_sid$/.test(c.name));
    if (sid) cookie = sid.name + '=' + sid.value;
    if (r.statusCode >= 400) throw new Error(method + ' ' + url + ': ' + r.body);
    return r.body ? JSON.parse(r.body) : null;
  };
  // сыграть n готовых матчей быстрым счётом: побеждает тот, кто выше в посеве (иногда — нет)
  let k = 0;
  const play = async (t, n) => {
    for (let j = 0; j < n; j++) {
      const g = t.games.find(x => B.gameState(t, x).st === 'ready');
      if (!g) break;
      const s = B.gameState(t, g), ltw = B.ltwOf(t, g.r, g.i), aWins = (k++ % 5 !== 0) === (t.players.indexOf(s.a) < t.players.indexOf(s.b));
      const lose = (k * 7) % ltw;
      t = (await call('POST', '/api/tournaments/' + t.id + '/games/' + g.r + '/' + g.i + '/result', { la: aWins ? ltw : lose, lb: aWins ? lose : ltw })).tournament;
    }
    return t;
  };
  try {
    await call('POST', '/api/auth/dev', { playerId: HOST });
    const refs = { chief: { name: 'Петров Пётр Петрович', city: 'Москва' }, pool: ['Иванов И.', 'Сидоров С.', 'Кузнецова А.'] };
    const base = { mode: 501, ltw: 2, clubId: 'c1' };
    // «Стандарт» с «Кубком B»: группы сыграны и закрыты, сетка идёт
    let t = (await call('POST', '/api/tournaments', Object.assign({ name: 'Кубок клуба · Стандарт', format: 'ko', players: PLAYERS.slice(0, 12), groups: { n: 3, adv: 2, cups: true }, ltwBy: { groups: 1, f: 3 } }, base))).tournament;
    await call('PATCH', '/api/tournaments/' + t.id + '/refs', refs);
    t = await play(t, 60);
    t = (await call('POST', '/api/tournaments/' + t.id + '/groups/close')).tournament;
    await call('PATCH', '/api/tournaments/' + t.id + '/refs', { auto: true });
    t = await play(t, 2);
    // двойное выбывание — наполовину сыгран
    t = (await call('POST', '/api/tournaments', Object.assign({ name: 'Двойное выбывание · пятница', format: 'de', players: PLAYERS.slice(0, 8), ltwBy: { f: 3 } }, base))).tournament;
    await call('PATCH', '/api/tournaments/' + t.id + '/refs', refs);
    t = await play(t, 8);
    // швейцарка — сыграна целиком, с протоколом
    t = (await call('POST', '/api/tournaments', Object.assign({ name: 'Швейцарская система · октябрь', format: 'sw', rounds: 4, players: PLAYERS.slice(0, 10) }, base))).tournament;
    await call('PATCH', '/api/tournaments/' + t.id + '/refs', refs);
    t = await play(t, 40);
    await call('PATCH', '/api/tournaments/' + t.id + '/protocol', { league: 'Лига клуба «Тройная двадцатка»', tour: 'Октябрьский этап', about: 'Клуб «Тройная двадцатка», Москва, ул. Лесная, 5. Турниры по пятницам.' });
    // квалификация + сетка на вылет: идёт квалификация
    t = (await call('POST', '/api/tournaments', Object.assign({ name: 'Квалификация + олимпийская', format: 'ko', qual: { ex: { k: 'score', lim: 10 }, tries: 2 }, players: PLAYERS.slice(0, 8) }, base))).tournament;
    for (const [j, id] of PLAYERS.slice(0, 5).entries()) await call('PUT', '/api/tournaments/' + t.id + '/qual/' + id + '/0', { v: 420 + j * 37 });
    // лайт-профиль от ведущего с QR-карточкой
    await call('POST', '/api/admin/players', { name: 'Нина Петровна', city: 'Москва' });
  } finally { await app.close(); config.rateMax = rate; }
}

module.exports = { demoExtra };
if (require.main === module) demoExtra().then(() => { console.log('Демо: турниры новых форматов добавлены.'); return require('../server/db').pool.end(); }).catch(e => { console.error(e); process.exit(1); });
