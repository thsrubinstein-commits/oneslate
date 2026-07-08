// OneSlate service worker — offline shell, but always prefers fresh content so new
// deploys show up immediately. Same-origin GETs only; never touches API calls.
const CACHE = 'oneslate-v4';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => e.waitUntil((async () => {
  // Purge every old cache so a stale index.html can't linger.
  const keys = await caches.keys();
  await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return;

  const isDoc = req.mode === 'navigate' || u.pathname.endsWith('/') || u.pathname.endsWith('.html');

  if (isDoc) {
    // Network-first for the app itself: always get the newest deploy, fall back to
    // cache only when truly offline.
    e.respondWith((async () => {
      try {
        const net = await fetch(req, { cache: 'no-store' });
        const cache = await caches.open(CACHE);
        cache.put(req, net.clone());
        return net;
      } catch (err) {
        const cached = await caches.match(req);
        return cached || Response.error();
      }
    })());
    return;
  }

  // Static assets (fonts, icons): stale-while-revalidate — fast, but refreshed in bg.
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const net = fetch(req).then((r) => {
      if (r && r.status === 200 && r.type === 'basic') cache.put(req, r.clone());
      return r;
    }).catch(() => cached);
    return cached || net;
  })());
});
