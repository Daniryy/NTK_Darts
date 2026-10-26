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
// Каждая: { k, st: ok | warn | info, text }. warn — администратору стоит присмотреться.
async function autoCheck(c, r, p) {
  const out = [], add = (k, st, text) => out.push({ k, st, text }), kind = KIND[r.title];
  const docs = (await c.query('SELECT count(*)::int AS n FROM title_docs WHERE request_id = $1', [r.id])).rows[0].n;
  add('doc', docs ? 'ok' : 'warn', docs ? 'Документ приложен (' + docs + ' ' + (docs === 1 ? 'файл' : docs < 5 ? 'файла' : 'файлов') + ')' : 'Нет документа');
  // ФИО: все слова имени из профиля есть в ФИО заявки
  const prof = words(p.name), full = words(r.full_name);
  const same = prof.length && prof.every(w => full.includes(w));
  add('name', same ? 'ok' : 'warn', same ? 'ФИО совпадает с именем в профиле' : 'ФИО в заявке («' + r.full_name + '») не совпадает с именем в профиле («' + p.name + '»)');
  if (full.length < 2) add('fio', 'warn', 'В ФИО меньше двух слов — нужна фамилия и имя (лучше и отчество)');
  // приказ: номер и дата
  const no = String(r.order_no || '').trim();
  if (!no) add('order', 'warn', 'Не указан номер приказа');
  else if (!/\d/.test(no) || no.length > 40) add('order', 'warn', 'Номер приказа выглядит странно: «' + no + '»');
  else add('order', 'ok', 'Номер приказа: ' + no);
  const now = Date.now();
  if (!r.order_date) add('date', 'warn', 'Не указана дата приказа');
  else if (r.order_date > now + 864e5) add('date', 'warn', 'Дата приказа в будущем');
  else if (r.order_date < Date.UTC(1950, 0, 1)) add('date', 'warn', 'Слишком ранняя дата приказа');
  else add('date', 'ok', 'Дата приказа: ' + new Date(+r.order_date).toLocaleDateString('ru-RU'));
  // кто присвоил: федеральные звания — только Минспорт России
  const iss = String(r.issuer || '').toLowerCase();
  if (kind.fed) {
    const ok = /минспорт|министерств[оа] спорта/.test(iss);
    add('issuer', ok ? 'ok' : 'warn', ok ? 'Присвоил Минспорт России — верно для звания «' + kind.short + '»' : 'Звание «' + kind.short + '» присваивает Минспорт России, а в заявке: «' + (r.issuer || 'не указано') + '»');
  } else add('issuer', r.issuer ? 'ok' : 'warn', r.issuer ? 'Присвоил: ' + r.issuer + ' (обычно — ' + kind.issuer + ')' : 'Не указано, кто присвоил (обычно — ' + kind.issuer + ')');
  // тот же приказ и ФИО уже подтверждены у другого аккаунта
  if (no) {
    const dup = (await c.query(`SELECT r.full_name, p.name, p.code FROM title_requests r JOIN players p ON p.id = r.player_id
      WHERE r.status = 'approved' AND r.player_id <> $1 AND lower(r.order_no) = lower($2) AND r.title = $3`, [p.id, no, r.title])).rows
      .filter(x => { const w = words(x.full_name); return full.length && full.every(y => w.includes(y)); });
    add('dup', dup.length ? 'warn' : 'ok', dup.length ? 'Этот приказ с тем же ФИО уже подтверждён у другого аккаунта: ' + dup.map(x => x.name + ' (' + x.code + ')').join(', ') : 'Повторов у других аккаунтов нет');
  }
  // уже есть звание выше
  if (p.title && rankOfShort(p.title) > kind.rank) add('rank', 'info', 'Сейчас подтверждено звание выше: ' + p.title);
  if (kind.fed) add('minsport', 'info', 'Сверьте с приказом на сайте Минспорта: ' + searchUrl(r));
  return out;
}

module.exports = { KINDS, KIND, kindsJSON, autoCheck, searchUrl };
