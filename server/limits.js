// Лимиты входа (в памяти процесса). Общий лимит частоты считается по устройству, а id устройства присылает сам
// клиент — подбор кода или пароля его меняет. Поэтому вход ограничен ещё и по IP и по аккаунту. В зале все телефоны
// выходят в интернет с одного адреса, поэтому для входа считаются только неудачные попытки (wait/fail), а не все.
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
// неудачи: сколько секунд ждать, если по ключу уже max ошибок (сама проверка ошибку не засчитывает)
function wait(key, max) {
  const b = buckets.get(key), now = Date.now();
  if (!b || b.reset <= now) return 0;
  return b.n >= max ? Math.ceil((b.reset - now) / 1000) : 0;
}
// засчитать неудачу
const fail = (key, ms) => { hit(key, Infinity, ms); };
// забыть неудачи по ключам с этим началом (новый пароль — подбор старого больше не важен)
function clear(prefix) { for (const k of buckets.keys()) if (k.startsWith(prefix)) buckets.delete(k); }
const reset = () => buckets.clear();

module.exports = { hit, wait, fail, clear, reset };
