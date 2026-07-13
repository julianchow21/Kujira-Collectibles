/* Kujira Collectibles service worker - offline shell + installable PWA.
   Network-first for the app HTML (so it always updates when you're online),
   cache-first for static assets, and a versioned cache that wipes old copies
   on activate. Cross-origin calls (Supabase, the price Worker, CDNs) are never
   intercepted - they pass straight through to the network.
   Bump CACHE when you want to force every client to drop its old shell. */
const CACHE = 'kujira-v29';
// three.core.min.js has no ?v= query: it's the vendored file's own internal
// import specifier (three.module.js imports "./three.core.min.js" verbatim,
// no query), so the real runtime request never carries one either - a query
// here would just make this entry miss its own precache. Busted by CACHE
// bumping instead, same as every other unversioned CORE entry below.
const CORE = ['./', './index.html', './styles.css', './app.js', './features.js', './Assets/manifest.webmanifest', './Assets/whale-icon.png', './Assets/apple-touch-icon.png', './Assets/whale-icon-192.png', './Assets/whale-icon-maskable-512.png', './Assets/lib/three.module.js?v=3.25', './Assets/lib/three.core.min.js'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => Promise.allSettled(CORE.map((u) => c.add(u)))));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // kujira-intro-art is a separate runtime cache for remote intro art, never wipe it on a version bump
    await Promise.all(keys.filter((k) => k !== CACHE && k !== 'kujira-intro-art').map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                  // never touch writes/sync
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // leave Supabase/Worker/CDN to the network

  const isHtml = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isHtml) {
    // Network-first: fresh app code when online, cached shell when offline.
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(CACHE);
        c.put('./index.html', fresh.clone());
        return fresh;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./')) ||
          new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Cache-first for static same-origin assets (icon, manifest).
  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) { const c = await caches.open(CACHE); c.put(req, fresh.clone()); }
      return fresh;
    } catch {
      return cached || (await caches.match(req, { ignoreSearch: true })) || new Response('', { status: 504 });
    }
  })());
});
