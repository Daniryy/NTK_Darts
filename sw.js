/* Oche: страница открывается и без сети. Оболочка (страница и её скрипты) — сначала из сети, без сети — из кэша.
   Запросы к /api не кэшируются: счёт без сети копит очередь api.js. Фото — из кэша, если уже открывались. */
const SHELL = 'oche-shell-v1', MEDIA = 'oche-media-v1', MEDIA_MAX = 300;
const FILES = ['./', 'index.html', 'api.js', 'shared/bracket.js', 'shared/games.js', 'vendor/qrcode.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL && k !== MEDIA).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/uploads/')) {
    e.respondWith(caches.open(MEDIA).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      // новые фото в конец; старые (сменённые аватары) уходят, когда их больше MEDIA_MAX
      if (res.ok) c.put(req, res.clone()).then(() => c.keys()).then(ks => Promise.all(ks.slice(0, Math.max(0, ks.length - MEDIA_MAX)).map(k => c.delete(k)))).catch(() => {});
      return res;
    }));
    return;
  }
  // страница и скрипты: свежие из сети, без сети — сохранённые
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))));
});
