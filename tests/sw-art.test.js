'use strict';
// v3.83: sw.js keeps TCGdex card art (the images on assets.tcgdex.net) cache-first in its own cache, `kujira-card-art`, so a card seen once shows
// again with no network, and the browser's own HTTP cache (small and quick to be emptied on iOS) is no longer the only copy. Pinned here: what is
// intercepted and what is left alone, what is stored (a readable CORS image only, never an opaque response, a 404 or a page that is not an
// image), the cap, that activate leaves the art cache (and the intro one) alone when the version cache changes, and that a failing cache
// never costs the picture. The worker is the real sw.js, run in a vm with a Map-backed Cache Storage.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ROOT } = require('./harness.js');

const SW = fs.readFileSync(ROOT + '/sw.js', 'utf8');
const ART = 'https://assets.tcgdex.net/en/swsh/swsh7/215/low.webp';
// the version cache's name belongs to the ship bump, not to these tests
const SHELL = SW.match(/const CACHE = '([^']+)'/)[1];

// Cache Storage: named caches over Maps, in insertion order like the real one. failPut makes every put reject (a full quota).
function makeCaches(opts) {
  const stores = new Map();
  const key = (r) => (typeof r === 'string' ? r : r.url);
  const cache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (r) => m.get(key(r)),
      put: async (r, res) => { if (opts && opts.failPut) throw new Error('QuotaExceededError'); m.set(key(r), res); },
      delete: async (r) => m.delete(key(r)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
      add: async () => {}, addAll: async (list) => { cache.added = list; },
    };
  };
  return {
    stores, cache,
    open: async (name) => cache(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (r) => { for (const m of stores.values()) if (m.has(key(r))) return m.get(key(r)); return undefined; },
  };
}
function res(o) {
  const { headers, ...rest } = o || {};
  const h = Object.assign({ 'content-type': 'image/webp' }, headers);
  const r = Object.assign({ ok: true, status: 200, type: 'cors', body: 'bytes', headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) } }, rest);
  r.clone = () => Object.assign({}, r, { cloned: true });
  return r;
}
function req(url, o) {
  const { headers, ...rest } = o || {};
  const h = Object.assign({}, headers);
  return Object.assign({ method: 'GET', url, mode: 'cors', destination: 'image', headers: { get: (k) => (h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()]) } }, rest);
}
// load sw.js, the origin is the page's own. network(url) answers fetches, and every fetch is recorded
function boot(opts) {
  opts = opts || {};
  const listeners = {};
  const caches = makeCaches(opts);
  const fetched = [];
  const sandbox = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting() {}, clients: { claim: async () => { sandbox.claimed = true; } }, location: { origin: 'https://julianchow21.github.io' } },
    caches, URL, Response, Promise, Date,
    fetch: async (r) => { fetched.push(r.url); return (opts.network || (() => res()))(r.url, r); },
  };
  vm.createContext(sandbox);
  vm.runInContext(SW, sandbox, { filename: 'sw.js' });
  const run = (code) => vm.runInContext(code, sandbox);
  // dispatch a fetch event, wait for the response and for what the worker was told to finish (waitUntil)
  async function fetchEvent(request) {
    const ev = { request, responded: null, waits: [], respondWith(p) { ev.responded = Promise.resolve(p); }, waitUntil(p) { ev.waits.push(Promise.resolve(p)); } };
    listeners.fetch(ev);
    let response, error;
    if (ev.responded) { try { response = await ev.responded; } catch (e) { error = e; } }
    await Promise.all(ev.waits);
    return { intercepted: !!ev.responded, response, error };
  }
  return { listeners, caches, fetched, sandbox, run, fetchEvent };
}

test('sw art: a TCGdex picture is fetched once, stored, and then served from the cache with no network', async () => {
  const w = boot();
  const first = await w.fetchEvent(req(ART));
  assert.equal(first.intercepted, true);
  assert.equal(first.response.body, 'bytes');
  assert.deepEqual(w.fetched, [ART]);
  const art = w.caches.stores.get('kujira-card-art');
  assert.ok(art && art.has(ART), 'stored under its own cache name');
  assert.equal(art.get(ART).cloned, true, 'a clone is stored, the page gets the original');
  assert.equal(w.caches.stores.has(SHELL), false, 'nothing went into the shell cache');
  const second = await w.fetchEvent(req(ART));
  assert.equal(second.response, art.get(ART), 'cache-first');
  assert.deepEqual(w.fetched, [ART], 'no second network request');
  // every picture type TCGdex serves, high and low
  for (const u of ['https://assets.tcgdex.net/ja/SV/SV2a/006/high.webp', 'https://assets.tcgdex.net/en/base/base1/58/low.png', 'https://assets.tcgdex.net/en/base/base1/58/low.JPG', 'https://assets.tcgdex.net/en/base/base1/58/low.jpeg']) {
    assert.equal((await w.fetchEvent(req(u))).intercepted, true, u);
  }
  // a plain (no-cors) request for a picture already stored is answered from the same entry
  assert.equal((await w.fetchEvent(req(ART, { mode: 'no-cors' }))).response, art.get(ART));
});

test('sw art: only a whole, readable picture is stored. An opaque response, a 404, a page that is not an image, a partial response and an error pass through uncached', async () => {
  const cases = {
    'opaque (a plain cross-origin <img>, padded to megabytes in the quota)': res({ ok: false, status: 0, type: 'opaque' }),
    '404': res({ ok: false, status: 404, headers: { 'content-type': 'text/html, image/webp' } }),
    '500': res({ ok: false, status: 500 }),
    '200 with a page, not an image': res({ headers: { 'content-type': 'text/html; charset=utf-8' } }),
    '200 with no content type': res({ headers: { 'content-type': '' } }),
  };
  for (const [label, answer] of Object.entries(cases)) {
    const w = boot({ network: () => answer });
    const got = await w.fetchEvent(req(ART));
    assert.equal(got.response, answer, label + ': the page still gets exactly what the network said');
    const store = w.caches.stores.get('kujira-card-art');
    assert.ok(!store || store.size === 0, label + ': nothing stored');
  }
  // a range request is the browser's own business
  const w = boot();
  assert.equal((await w.fetchEvent(req(ART, { headers: { range: 'bytes=0-99' } }))).intercepted, false);
});

test('sw art: everything else cross-origin is left to the network: the TCGdex lookups, other hosts, look-alike hosts, other file types, writes', async () => {
  const w = boot();
  const left = [
    'https://api.tcgdex.net/v2/en/cards/swsh7-215',
    'https://api.tcgdex.net/v2/en/cards/swsh7-215/low.webp',
    'https://assets.tcgdex.net/en/swsh/swsh7/215.json',
    'https://assets.tcgdex.net/en/swsh/swsh7/215/low.webp.exe',
    'https://assets.tcgdex.net/en/swsh/swsh7/215',
    'http://assets.tcgdex.net/en/swsh/swsh7/215/low.webp',
    'https://assets.tcgdex.net.evil.example/en/swsh/swsh7/215/low.webp',
    'https://evil.example/assets.tcgdex.net/low.webp',
    'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
    'https://eywncywatxtlqtrvxjsi.supabase.co/rest/v1/singles',
  ];
  for (const u of left) assert.equal((await w.fetchEvent(req(u))).intercepted, false, u + ' passes straight through');
  assert.equal((await w.fetchEvent(req(ART, { method: 'POST' }))).intercepted, false, 'a write is never touched');
  assert.equal((await w.fetchEvent(req(ART, { method: 'HEAD' }))).intercepted, false);
  assert.deepEqual(w.fetched, [], 'the worker fetched nothing for any of them');
  // and same-origin traffic still takes the old paths: the shell cache for assets, network-first for the page
  const own = await w.fetchEvent(req('https://julianchow21.github.io/Kujira-Collectibles/styles.css?v=3.83', { mode: 'no-cors', destination: 'style' }));
  assert.equal(own.intercepted, true);
  assert.ok(w.caches.stores.has(SHELL), 'static assets go to the shell cache');
  assert.equal(w.caches.stores.has('kujira-card-art'), false);
});

test('sw art: a failed fetch is a plain network error for the page and stores nothing, a full or blocked cache never costs the picture', async () => {
  const down = boot({ network: () => { throw new TypeError('Failed to fetch'); } });
  const lost = await down.fetchEvent(req(ART));
  assert.equal(lost.intercepted, true);
  assert.ok(lost.error instanceof TypeError, 'the page sees the same network error it would without a worker');
  assert.ok(!down.caches.stores.get('kujira-card-art') || down.caches.stores.get('kujira-card-art').size === 0);

  const full = boot({ failPut: true });
  const got = await full.fetchEvent(req(ART));
  assert.equal(got.error, undefined);
  assert.equal(got.response.body, 'bytes', 'the picture is still shown when the cache will not take it');
});

test('sw art: the cache is capped at 1500 pictures, oldest out, checked at most once every few seconds', async () => {
  const w = boot();
  assert.equal(w.run('ART_MAX'), 1500);
  await w.caches.open('kujira-card-art');
  const store = w.caches.stores.get('kujira-card-art');
  for (let n = 0; n < 1500; n++) store.set('https://assets.tcgdex.net/old/' + n + '/low.webp', res());
  const gap = w.run('ART_TRIM_GAP');
  assert.ok(gap >= 1000 && gap <= 10000, 'a few seconds');
  // three more arrive close together: the first trims the one picture over the cap, the other two fall inside the gap
  for (let n = 0; n < 3; n++) await w.fetchEvent(req('https://assets.tcgdex.net/new/' + n + '/low.webp'));
  assert.equal(store.size, 1502, 'soft cap, by what a burst adds inside the gap');
  assert.equal(store.has('https://assets.tcgdex.net/old/0/low.webp'), false, 'the oldest went first');
  assert.equal(store.has('https://assets.tcgdex.net/old/1/low.webp'), true);
  // once the gap has passed the next put trims again and the cache is back at the cap
  w.run('lastArtTrim = 0');
  await w.fetchEvent(req('https://assets.tcgdex.net/new/3/low.webp'));
  assert.equal(store.size, 1500);
  for (const n of [1, 2, 3]) assert.equal(store.has('https://assets.tcgdex.net/old/' + n + '/low.webp'), false, 'old ' + n);
  assert.equal(store.has('https://assets.tcgdex.net/old/4/low.webp'), true);
  assert.equal(store.has('https://assets.tcgdex.net/new/3/low.webp'), true, 'the picture just stored is never the one trimmed');
});

test('sw art: activate drops old shell caches but never the art cache or the intro art cache, and still claims the clients', async () => {
  const w = boot();
  for (const name of ['kujira-v1', 'kujira-v2', SHELL, 'kujira-card-art', 'kujira-intro-art', 'something-else']) await w.caches.open(name);
  let done;
  w.listeners.activate({ waitUntil: (p) => { done = p; } });
  await done;
  assert.deepEqual([...w.caches.stores.keys()].sort(), ['kujira-card-art', 'kujira-intro-art', SHELL].sort());
  assert.equal(w.sandbox.claimed, true);

  // a version bump moves CACHE to a new name: the old shell goes, the art stays
  const bumped = SW.replace(/const CACHE = '[^']+'/, "const CACHE = 'kujira-next'");
  const listeners = {};
  const caches = makeCaches();
  const sb = { self: { addEventListener: (t, f) => { listeners[t] = f; }, clients: { claim: async () => {} }, location: { origin: 'https://x.test' } }, caches, URL, Response, Promise, Date, fetch: async () => res() };
  vm.runInNewContext(bumped, sb);
  for (const name of [SHELL, 'kujira-card-art', 'kujira-intro-art']) await caches.open(name);
  let d2;
  listeners.activate({ waitUntil: (p) => { d2 = p; } });
  await d2;
  assert.deepEqual([...caches.stores.keys()].sort(), ['kujira-card-art', 'kujira-intro-art'], 'the old shell went, both art caches stayed (the new shell cache fills on install)');
});

test('sw art: install still precaches the shell including the whale the no-art look draws', async () => {
  const w = boot();
  let installed;
  w.listeners.install({ waitUntil: (p) => { installed = p; } });
  await installed;
  const added = w.caches.cache.added;
  assert.ok(Array.isArray(added) && added.includes('./Assets/whale-icon-192.png'));
  assert.ok(added.includes('./index.html') && added.some((u) => u.startsWith('./app.js')));
  assert.match(SW, /const ART_CACHE = 'kujira-card-art'/);
  assert.match(SW, /const ART_HOST = 'assets\.tcgdex\.net'/);
});
