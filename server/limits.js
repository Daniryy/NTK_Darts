// Лимиты на вход по IP (в памяти процесса). Общий лимит частоты считается по устройству, а id устройства
// присылает сам клиент — подбор кода или пароля его меняет. Поэтому вход дополнительно ограничен по IP;
// пороги с запасом: в зале все телефоны выходят в интернет с одного адреса.
const buckets = new Map();

// засчитать попытку: 0 — можно, иначе сколько секунд ждать
function hit(key, max, ms) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.reset <= now) { b = { n: 0, reset: now + ms }; buckets.set(key, b); }
  b.n++;
  if (buckets.size > 50000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
  return b.n <= max ? 0 : Math.ceil((b.reset - now) / 1000);
}
const reset = () => buckets.clear();

module.exports = { hit, reset };
