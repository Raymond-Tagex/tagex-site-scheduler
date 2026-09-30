// TAGEX O&M Site Visit Scheduler — service worker.
//
// It exists so the app can be installed to a phone's home screen (Chrome will not offer to
// install a site with no fetch handler), and so it still opens if the signal drops on site.
//
// NETWORK FIRST, DELIBERATELY. The usual PWA pattern is cache-first for the app shell, which is
// wrong for this application: it is deployed alongside the delivery app and shares its identity
// and permission code, so a cached shell would keep running yesterday's JavaScript — including
// the access-control logic — against today's data. Every request goes to the network, and the
// cache is only consulted when the network fails.
//
// NOTHING UNDER /api/ IS EVER CACHED OR SERVED FROM CACHE. A cached /api/auth/me would keep a
// signed-out user looking signed in, and a cached proxy response on a shared device would hand
// one person's data to whoever picked it up next.

const CACHE = 'tagex-om-scheduler';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Same-origin GETs only. The API, cross-origin fonts, and every write pass straight through
  // and are never stored.
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => (
        hit || (e.request.mode === 'navigate' ? caches.match('/') : undefined)
      ))),
  );
});
