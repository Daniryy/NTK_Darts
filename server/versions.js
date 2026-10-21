// Версии матчей и турниров для ответа 204 без лишней работы.
// Живут 2 с: если запись прошла в другом процессе, зритель увидит её на следующем опросе.
const { one } = require('./db');

const TTL = 2000, cache = new Map();

async function version(c, kind, id) {
  const key = kind + id, hit = cache.get(key), now = Date.now();
  if (hit && hit.at > now - TTL) return hit.v;
  const row = await one(c, kind === 'm' ? 'SELECT version FROM matches WHERE id = $1' : 'SELECT version FROM tournaments WHERE id = $1', [id]);
  const v = row ? row.version : null;
  if (cache.size > 20000) cache.clear();
  cache.set(key, { v, at: now });
  return v;
}
const forget = (kind, id) => cache.delete(kind + id);

module.exports = { version, forget };
