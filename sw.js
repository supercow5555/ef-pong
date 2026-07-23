// EF Pong service worker — makes the app installable + offline-tolerant.
//
// Strategy: NETWORK-FIRST for our own files. When the phone is online a fresh
// deploy always wins (no stale-build trap — the whole reason we avoid cache-first);
// the cache is only a fallback when the network is unavailable. Cross-origin
// requests (Supabase API, the Phosphor icon CDN, Google Fonts) are left entirely
// to the browser so we never cache API responses or opaque third-party payloads.
const CACHE = 'efpong-v1';
const SHELL = [
  './', './index.html',
  './css/app.css',
  './js/app.js', './js/api.js', './js/config.js',
  './icon-192.png', './icon-512.png', './manifest.webmanifest',
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Supabase / CDN / fonts → straight to network

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // stash a copy for offline use (only successful basic responses)
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch (err) {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = (await caches.match('./index.html')) || (await caches.match('./'));
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
