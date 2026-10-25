/* Kujira Collectibles service worker - offline shell + installable PWA.
   Network-first for the app HTML (so it always updates when you're online),
   cache-first for static assets, and a versioned cache that wipes old copies
   on activate. Cross-origin calls (Supabase, the price Worker, CDNs, the TCGdex
   card lookups) are never intercepted - they pass straight through to the
   network. The one exception is TCGdex card art (v3.83): the images on
   assets.tcgdex.net are immutable files, so they are served cache-first from
   their own cache, `kujira-card-art`, which survives version bumps.
   Bump CACHE when you want to force every client to drop its old shell. */
const CACHE = 'kujira-v93';
// three.core.min.js has no ?v= query: it's the vendored file's own internal
// import specifier (three.module.js imports "./three.core.min.js" verbatim,
// no query), so the real runtime request never carries one either - a query
// here would just make this entry miss its own precache. Busted by CACHE
// bumping instead, same as every other unversioned CORE entry below.
const CORE = ['./', './index.html', './styles.css?v=3.90', './app.js?v=3.90', './features.js?v=3.90', './dealer-money.js?v=3.90', './dealer-desk.js?v=3.90', './dealer-ui.js?v=3.90', './dealer-store.js?v=3.90', './dealer-production-ui.js?v=3.90', './Assets/manifest.webmanifest', './Assets/whale-icon.png', './Assets/apple-touch-icon.png', './Assets/whale-icon-192.png', './Assets/fonts/Geist-Variable.woff2', './Assets/fonts/GeistMono-Variable.woff2', './Assets/lib/three.module.js?v=3.31', './Assets/lib/three.core.min.js'];

// Card art (v3.83). The page asks for each picture with crossorigin=anonymous and TCGdex answers with access-control-allow-origin: *, so the
// response the worker sees is a readable CORS one. Only that kind is stored: an opaque one (a plain cross-origin <img>) is padded to
// megabytes in the storage quota, so a few hundred of them would exhaust it, and is passed through uncached. The cache is capped,
// oldest out, and is not wiped when CACHE changes (see activate). api.tcgdex.net (the card lookups, JSON) is never touched.
const ART_CACHE = 'kujira-card-art';
const ART_HOST = 'assets.tcgdex.net';
const ART_MAX = 1500;
const ART_TRIM_GAP = 5000;
let lastArtTrim = 0;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) =>
    typeof c.addAll === 'function' ? c.addAll(CORE) : Promise.all(CORE.map((u) => c.add(u)))
  ));
});

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    // kujira-intro-art (remote intro art) and kujira-card-art (TCGdex card art) are separate runtime caches, never wipe them on a version bump
    const keep = [CACHE, 'kujira-intro-art', ART_CACHE];
    await Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function isArtRequest(url) {
  return url.protocol === 'https:' && url.hostname === ART_HOST && /\.(?:webp|png|jpe?g)$/i.test(url.pathname);
}

// Cache-first. A miss goes to the network, and only a whole, readable picture is kept: a CORS response with an image type (a 404
// page, a soft error and an opaque response all pass through uncached). A failed fetch rejects, so the page sees the same network error it
// would without a worker. A full or blocked cache must never cost the picture, so writing is best effort.
async function artResponse(e, req) {
  const cache = await caches.open(ART_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok && res.type !== 'opaque' && /^image\//i.test(res.headers.get('content-type') || '')) {
    e.waitUntil(cache.put(req, res.clone()).then(trimArt).catch(() => {}));
  }
  return res;
}

// Oldest out once the cache passes ART_MAX (cache.keys() lists entries in the order they were added). The check reads every key, so it
// runs at most once every ART_TRIM_GAP, the cap is soft by what one burst adds.
async function trimArt() {
  if (Date.now() - lastArtTrim < ART_TRIM_GAP) return;
  lastArtTrim = Date.now();
  const cache = await caches.open(ART_CACHE);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - ART_MAX; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                  // never touch writes/sync
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // leave Supabase/Worker/CDN to the network, card art is the one cross-origin thing kept
    if (isArtRequest(url) && !req.headers.get('range')) e.respondWith(artResponse(e, req));
    return;
  }

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
