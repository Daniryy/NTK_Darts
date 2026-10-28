// Убрать демо-данные с сервера (см. server/clean.js). Обычно через deploy/clean.sh (там копия базы и подтверждение)
// или в панели: «Управление» → «Сервер».
//   node tools/clean.js --yes
const { pool } = require('../server/db');
const { cleanAll } = require('../server/clean');

if (!process.argv.includes('--yes')) { console.log('Удаление без возврата: запустите с --yes (или bash deploy/clean.sh)'); process.exit(1); }
cleanAll().then(async n => {
  console.log(`Удалено: турниров ${n.tours}, матчей ${n.matches}, игроков ${n.removed}, файлов фото ${n.files}. Осталось аккаунтов: ${n.kept}.`);
  await pool.end();
}).catch(e => { console.error('Ошибка: ' + e.message); process.exit(1); });
