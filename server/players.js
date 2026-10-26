// Создание игроков: уникальные @handle и код OCH-xxxx, как на странице.
const crypto = require('node:crypto');
const { one } = require('./db');

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

function handleBase(name) {
  const base = String(name).toLowerCase().split('').map(c => c in TRANSLIT ? TRANSLIT[c] : c).join('')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'player';
  return base.length < 3 ? 'player_' + base : base;
}

async function uniqueHandle(c, name) {
  const root = handleBase(name);
  let h = root;
  for (let k = 2; await one(c, 'SELECT 1 FROM players WHERE handle = $1', [h]); k++) h = root + '_' + k;
  return h;
}

async function uniqueCode(c) {
  for (let digits = 4; ; digits++) {
    for (let k = 0; k < 20; k++) {
      const code = 'OCH-' + crypto.randomInt(10 ** (digits - 1), 10 ** digits);
      if (!await one(c, 'SELECT 1 FROM players WHERE code = $1', [code])) return code;
    }
  }
}

// p: { name, city, club, vk_id, phone, owner_id }; в транзакции, чтобы handle и code не заняли параллельно
async function createPlayer(c, p) {
  await c.query('LOCK TABLE players IN SHARE ROW EXCLUSIVE MODE');
  const handle = await uniqueHandle(c, p.name), code = await uniqueCode(c);
  return one(c, `INSERT INTO players (name, handle, code, city, club, vk_id, phone, owner_id, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
  [p.name, handle, code, p.city || '', p.club || '', p.vk_id || null, p.phone || null, p.owner_id || null, Date.now()]);
}

const playerShort = p => ({ id: p.id, name: p.name, handle: p.handle, code: p.code, city: p.city, club: p.club, ver: p.ver, r: Math.round(p.rating), n: p.rated, photo: p.photo || null, title: p.title || '', role: p.role });
// свой профиль: ещё способы входа (телефон целиком — только себе)
const meJSON = p => p ? { id: p.id, name: p.name, handle: p.handle, code: p.code, city: p.city, club: p.club, ver: p.ver, photo: p.photo || null, title: p.title || '', role: p.role, phone: p.phone || null, vk: p.vk_id != null, login: p.login || null } : null;

module.exports = { createPlayer, playerShort, meJSON };
