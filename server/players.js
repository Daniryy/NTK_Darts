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

// p: { name, city, club, vk_id, phone, owner_id, consent }. Без блокировки всей таблицы: handle и code уникальны в базе,
// если их параллельно заняли — пробуем снова с новыми
async function createPlayer(c, p) {
  for (let k = 0; k < 5; k++) {
    const handle = await uniqueHandle(c, p.name), code = await uniqueCode(c);
    const row = await one(c, `INSERT INTO players (name, handle, code, city, club, vk_id, phone, owner_id, created_at, consent_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING RETURNING *`,
    [p.name, handle + (k ? '_' + crypto.randomInt(100, 1000) : ''), code, p.city || '', p.club || '', p.vk_id || null, p.phone || null, p.owner_id || null, Date.now(), p.consent ? Date.now() : null]);
    if (row) return row;
    // тот же VK или телефон уже занят параллельным входом — повтор не поможет
    if ((p.vk_id && await one(c, 'SELECT 1 FROM players WHERE vk_id = $1', [p.vk_id])) || (p.phone && await one(c, 'SELECT 1 FROM players WHERE phone = $1', [p.phone]))) {
      throw new (require('./errors').ApiError)(409, 'conflict', 'Аккаунт уже создан — войдите ещё раз');
    }
  }
  throw new Error('createPlayer: не удалось подобрать handle и code');
}

// данные для протокола: { lastName, firstName, midName, birthYear, sex, region } → поля players (только присланные)
function infoFields(b) {
  const { V, E } = require('./errors'), R = require('./regions'), o = {};
  if (b.lastName !== undefined) o.last_name = V.optStr(b.lastName, 'lastName', 40);
  if (b.firstName !== undefined) o.first_name = V.optStr(b.firstName, 'firstName', 40);
  if (b.midName !== undefined) o.mid_name = V.optStr(b.midName, 'midName', 40);
  if (b.birthYear !== undefined) o.birth_year = b.birthYear === null || b.birthYear === '' ? null : V.int(+b.birthYear, 'birthYear', 1920, new Date().getFullYear());
  if (b.sex !== undefined) o.sex = b.sex === null || b.sex === '' ? null : V.oneOf(b.sex, 'sex', ['m', 'f']);
  if (b.region !== undefined) {
    o.region = V.optStr(b.region, 'region', 80);
    if (o.region && !R.REGIONS.some(r => r[0] === o.region)) throw E.bad('Субъект РФ — из списка', 'region');
  }
  return o;
}
const infoJSON = p => ({ lastName: p.last_name || '', firstName: p.first_name || '', midName: p.mid_name || '', birthYear: p.birth_year || null, sex: p.sex || null, region: p.region || '' });
const playerShort = p => ({ id: p.id, name: p.name, handle: p.handle, code: p.code, city: p.city, club: p.club, ver: p.ver, r: Math.round(p.rating), n: p.rated, photo: p.photo || null, title: p.title || '', role: p.role, walkon: p.walkon || '', lite: !!p.lite });
// свой профиль: ещё способы входа (телефон целиком — только себе)
const meJSON = p => p ? Object.assign(infoJSON(p), { id: p.id, name: p.name, handle: p.handle, code: p.code, city: p.city, club: p.club, ver: p.ver, photo: p.photo || null, title: p.title || '', role: p.role, walkon: p.walkon || '', phone: p.phone || null, vk: p.vk_id != null, login: p.login || null, email: p.email || null, emailOk: !!p.email_ok, pass: !!p.pass_hash, lite: !!p.lite, twofa: !!p.totp_on, backupLeft: p.totp_on ? (p.totp_backup || []).length : null }) : null;

module.exports = { createPlayer, playerShort, meJSON, infoFields, infoJSON };
