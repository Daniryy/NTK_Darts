// Спортивные звания и разряды: справочник и автоматическая проверка заявки.
// Автопроверка не заменяет администратора: она собирает замечания, а решение принимает человек.

// [код, коротко (в профиле), полностью, кто присваивает, федеральное ли]
const KINDS = [
  ['zms', 'ЗМС', 'Заслуженный мастер спорта России', 'Минспорт России', true],
  ['msmk', 'МСМК', 'Мастер спорта России международного класса', 'Минспорт России', true],
  ['ms', 'МС', 'Мастер спорта России', 'Минспорт России', true],
  ['kms', 'КМС', 'Кандидат в мастера спорта', 'орган власти субъекта РФ в области спорта', false],
  ['r1', '1 разряд', 'Первый спортивный разряд', 'орган власти субъекта РФ в области спорта', false],
  ['r2', '2 разряд', 'Второй спортивный разряд', 'орган местного самоуправления или спортивная организация', false],
  ['r3', '3 разряд', 'Третий спортивный разряд', 'орган местного самоуправления или спортивная организация', false],
  ['y1', '1 юн. разряд', 'Первый юношеский спортивный разряд', 'спортивная организация', false],
  ['y2', '2 юн. разряд', 'Второй юношеский спортивный разряд', 'спортивная организация', false],
  ['y3', '3 юн. разряд', 'Третий юношеский спортивный разряд', 'спортивная организация', false]
];
const KIND = Object.fromEntries(KINDS.map(([k, short, full, issuer, fed], i) => [k, { k, short, full, issuer, fed, rank: KINDS.length - i }]));
const kindsJSON = () => KINDS.map(([k]) => ({ k, short: KIND[k].short, full: KIND[k].full, issuer: KIND[k].issuer, fed: KIND[k].fed }));
const rankOfShort = s => { const k = KINDS.find(x => x[1] === s); return k ? KIND[k[0]].rank : 0; };

const words = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я\s-]/g, ' ').split(/[\s-]+/).filter(w => w.length > 1);
// ссылка для администратора: поиск приказа на сайте Минспорта (сайт ищет по тексту)
const searchUrl = r => 'https://www.minsport.gov.ru/search/?q=' + encodeURIComponent(['приказ', r.order_no, words(r.full_name)[0] || ''].filter(Boolean).join(' '));

// проверки заявки r (строка title_requests) игрока p; c — подключение к базе.
// Каждая: { k, st: ok | warn | info, label, text } — коротко, в одну строку. warn — администратору стоит присмотреться.
async function autoCheck(c, r, p) {
  const out = [], add = (k, st, label, text) => out.push({ k, st, label, text }), kind = KIND[r.title];
  const docs = (await c.query('SELECT count(*)::int AS n FROM title_docs WHERE request_id = $1', [r.id])).rows[0].n;
  add('doc', docs ? 'ok' : 'warn', 'Документ', docs ? docs + ' ' + (docs === 1 ? 'файл' : docs < 5 ? 'файла' : 'файлов') : 'нет файла');
  // ФИО: все слова имени из профиля есть в ФИО заявки
  const prof = words(p.name), full = words(r.full_name);
  const same = prof.length && prof.every(w => full.includes(w));
  add('name', same && full.length >= 2 ? 'ok' : 'warn', 'ФИО', full.length < 2 ? 'нужны фамилия и имя' : same ? 'совпадает с профилем' : 'не совпадает с профилем: ' + p.name);
  // приказ: номер и дата одной строкой
  const no = String(r.order_no || '').trim(), now = Date.now(), dt = r.order_date ? new Date(+r.order_date).toLocaleDateString('ru-RU') : '';
  const noBad = !no ? 'нет номера' : !/\d/.test(no) || no.length > 40 ? 'странный номер «' + no + '»' : '';
  const dtBad = !r.order_date ? 'нет даты' : r.order_date > now + 864e5 ? 'дата в будущем' : r.order_date < Date.UTC(1950, 0, 1) ? 'слишком ранняя дата' : '';
  add('order', noBad || dtBad ? 'warn' : 'ok', 'Приказ', noBad || dtBad ? [noBad, dtBad].filter(Boolean).join(', ') : '№ ' + no + ' от ' + dt);
  // кто присвоил: федеральные звания — только Минспорт России
  const iss = String(r.issuer || '').toLowerCase();
  if (kind.fed) {
    const ok = /минспорт|министерств[оа] спорта/.test(iss) && !/област|кра[йя]|республик|город/.test(iss);
    add('issuer', ok ? 'ok' : 'warn', 'Присвоил', ok ? r.issuer : kind.short + ' присваивает Минспорт России, указано: ' + (r.issuer || '—'));
  } else add('issuer', r.issuer ? 'ok' : 'warn', 'Присвоил', r.issuer || 'не указано');
  // тот же приказ и ФИО уже подтверждены у другого аккаунта
  if (no) {
    const dup = (await c.query(`SELECT r.full_name, p.name, p.code FROM title_requests r JOIN players p ON p.id = r.player_id
      WHERE r.status = 'approved' AND r.player_id <> $1 AND lower(r.order_no) = lower($2) AND r.title = $3`, [p.id, no, r.title])).rows
      .filter(x => { const w = words(x.full_name); return full.length && full.every(y => w.includes(y)); });
    add('dup', dup.length ? 'warn' : 'ok', 'Повторы', dup.length ? 'уже у ' + dup.map(x => x.name + ' (' + x.code + ')').join(', ') : 'нет');
  }
  // уже есть звание выше
  if (p.title && rankOfShort(p.title) > kind.rank) add('rank', 'info', 'Сейчас', 'подтверждено звание выше: ' + p.title);
  if (kind.fed) add('minsport', 'info', 'Минспорт', searchUrl(r));
  return out;
}

module.exports = { KINDS, KIND, kindsJSON, autoCheck, searchUrl };
