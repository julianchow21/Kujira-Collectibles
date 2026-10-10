'use strict';
// Redesign Step 2 (v3.69): card art cache, lazy lookup queue, drawn slabs and the Grid view.
// The image map is LOCAL ONLY (kjr_card_images, kjr_slab_card_ids). These tests pin that no data row is
// written or marked dirty by the feature, that rendering never fetches, and that markup is escaped.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeSeed, jsonResponse, plain } = require('./harness.js');

const BASE = 'https://assets.tcgdex.net/en/swsh/swsh7/215';
const single = (o) => Object.assign({}, makeSeed().singles[0], o);
const slab = (o) => Object.assign({
  id: 'slab_1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '12345678', rank: '',
  language: 'EN', costPrice: 900, marketPrice: 1380, listPrice: '', dateListed: '3 Jul 2026', status: 'Available',
  notes: '', priceAlert: '', _updatedAt: new Date().toISOString(),
}, o);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const idsIn = (html) => [...html.matchAll(/data-id="([^"]*)"/g)].map(m => m[1]);
// The harness captures timers and never fires them. The queue's only timer is the 150ms gap, so run
// just that one (never timers.flush(), which would also fire the app's own timers).
async function drain(app) {
  for (let n = 0; n < 8; n++) {
    await app.settle(20);
    const id = app.ctx._kjrImgQ.timer;
    if (!id) break;
    app.ctx._kjrImgQ.lastStart -= 1000; // pretend the gap has passed
    app.timers.invoke(id);
  }
  await app.settle(20);
}

// ── image map helpers ────────────────────────────────────────────────────────────────────────
test('card-art: remember stores a TCGdex base under the bare id and kjrCardImageBase reads it back', async () => {
  const { ctx, localStorage } = await loadApp();
  assert.equal(ctx.kjrCardImageBase('swsh7-215'), '', 'nothing known yet');
  assert.equal(ctx.kjrRememberCardImage('swsh7-215', BASE + '/', 'en'), true, 'a trailing slash is trimmed, not rejected');
  assert.equal(ctx.kjrCardImageBase('swsh7-215'), BASE);
  assert.deepEqual(JSON.parse(localStorage.getItem('kjr_card_images')), { 'swsh7-215': BASE });
  assert.equal(ctx.kjrCardImageUrl(BASE, 'low'), BASE + '/low.webp');
  assert.equal(ctx.kjrCardImageUrl(BASE, 'high'), BASE + '/high.webp');
});

test('card-art: only https URLs on the TCGdex asset host and clean ids are ever stored', async () => {
  const { ctx, localStorage } = await loadApp();
  for (const bad of ['https://evil.example/en/x/1', 'http://assets.tcgdex.net/en/x/1', 'javascript:alert(1)',
    'https://assets.tcgdex.net.evil.example/x', 'https://assets.tcgdex.net/en/x/1"onerror="x', 'https://assets.tcgdex.net/en/a b',
    '', null, undefined, 42, {}]) {
    assert.equal(ctx.kjrRememberCardImage('swsh7-215', bad, 'en'), false, 'rejected: ' + String(bad));
  }
  for (const badId of ['', ' ', '__proto__', 'a b', 'x'.repeat(60), null, undefined]) {
    assert.equal(ctx.kjrRememberCardImage(badId, BASE, 'en'), false, 'rejected id: ' + String(badId));
  }
  assert.equal(localStorage.getItem('kjr_card_images'), null, 'nothing was written');
  // a tampered stored value is never handed out as an image source
  localStorage.setItem('kjr_card_images', JSON.stringify({ 'swsh7-215': 'https://evil.example/x', 'swsh7-218': { miss: iso(0) } }));
  ctx._kjrImgMem = null;
  assert.equal(ctx.kjrCardImageBase('swsh7-215'), '');
  assert.equal(ctx.kjrCardImageBase('swsh7-218'), '', 'a miss entry is not a base');
});

test('card-art: non-English printings get a language-prefixed key so two printings never swap art', async () => {
  const { ctx, localStorage } = await loadApp();
  ctx.kjrRememberCardImage('SV2a-001', 'https://assets.tcgdex.net/ja/SV/SV2a/001', 'ja');
  ctx.kjrRememberCardImage('SV2a-001', BASE, 'en');
  const stored = JSON.parse(localStorage.getItem('kjr_card_images'));
  assert.deepEqual(Object.keys(stored).sort(), ['SV2a-001', 'ja:SV2a-001']);
  assert.equal(ctx.kjrCardImageBase('SV2a-001', 'ja'), 'https://assets.tcgdex.net/ja/SV/SV2a/001');
  assert.equal(ctx.kjrCardImageBase('SV2a-001', 'en'), BASE);
});

test('card-art: a miss is dated today, counts for 7 days, then expires. It never replaces a known base', async () => {
  const { ctx, localStorage } = await loadApp();
  assert.equal(ctx.kjrCardImageMissed('zz-1'), false);
  assert.equal(ctx.kjrRememberCardImageMiss('zz-1'), true);
  assert.deepEqual(JSON.parse(localStorage.getItem('kjr_card_images')), { 'zz-1': { miss: iso(0) } });
  assert.equal(ctx.kjrCardImageMissed('zz-1'), true);
  assert.equal(ctx.kjrCardImageBase('zz-1'), '');

  const put = (stamp) => { localStorage.setItem('kjr_card_images', JSON.stringify({ 'zz-1': { miss: stamp } })); ctx._kjrImgMem = null; };
  put(iso(6)); assert.equal(ctx.kjrCardImageMissed('zz-1'), true, '6 days old is still fresh');
  put(iso(8)); assert.equal(ctx.kjrCardImageMissed('zz-1'), false, '8 days old has expired, the lookup may run again');
  put('not-a-date'); assert.equal(ctx.kjrCardImageMissed('zz-1'), false, 'a malformed stamp expires at once');
  put(iso(-30)); assert.equal(ctx.kjrCardImageMissed('zz-1'), false, 'a stamp far in the future can never block a lookup for good');

  ctx.kjrRememberCardImage('zz-2', BASE, 'en');
  assert.equal(ctx.kjrRememberCardImageMiss('zz-2'), false, 'a miss does not overwrite a known image');
  assert.equal(ctx.kjrCardImageBase('zz-2'), BASE);
  ctx.kjrRememberCardImageMiss('zz-3');
  assert.equal(ctx.kjrRememberCardImage('zz-3', BASE, 'en'), true, 'a found image replaces an old miss');
  assert.equal(ctx.kjrCardImageBase('zz-3'), BASE);
});

test('card-art: blocked or full storage never throws, the map keeps serving from memory', async () => {
  const { ctx, localStorage } = await loadApp();
  const real = { get: localStorage.getItem, set: localStorage.setItem };
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.doesNotThrow(() => ctx.kjrRememberCardImage('swsh7-215', BASE, 'en'));
  assert.equal(ctx.kjrCardImageBase('swsh7-215'), BASE, 'held in memory for this session');
  assert.doesNotThrow(() => ctx.kjrRememberCardImageMiss('zz-9'));
  assert.doesNotThrow(() => ctx.kjrSlabLinkSet('slab_1', 'Umbreon VMAX 215/203|en', 'swsh7-215'));
  assert.equal(ctx.kjrSlabLinkState({ id: 'slab_1', name: 'Umbreon VMAX 215/203', language: 'EN' }).id, 'swsh7-215');

  localStorage.setItem = real.set;
  localStorage.getItem = () => { throw new Error('SecurityError'); };
  ctx._kjrImgMem = null; ctx._kjrSlabMem = null;
  assert.doesNotThrow(() => ctx.kjrCardImageBase('swsh7-215'));
  assert.equal(ctx.kjrCardImageBase('swsh7-215'), '', 'unreadable storage reads as empty');
  assert.equal(ctx.kjrViewMode('singles'), 'list', 'the view preference falls back to the list');
  localStorage.getItem = real.get;
});

test('card-art: corrupt or non-object stored maps are ignored', async () => {
  for (const junk of ['{not json', '[]', '"text"', 'null', '42']) {
    const { ctx } = await loadApp({ localStorage: { kjr_card_images: junk, kjr_slab_card_ids: junk } });
    assert.equal(ctx.kjrCardImageBase('swsh7-215'), '');
    assert.equal(ctx.kjrRememberCardImage('swsh7-215', BASE, 'en'), true);
    assert.equal(ctx.kjrSlabLinkState({ id: 's1', name: 'x 1', language: 'EN' }).state, 'none');
  }
});

// ── what a row shows ─────────────────────────────────────────────────────────────────────────
test('card-art: kjrArtState covers hit, need and none for singles and slabs, and never guesses', async () => {
  const { ctx } = await loadApp();
  assert.equal(ctx.kjrArtState(single({ tcgdexId: '' }), 'singles').state, 'none', 'no id, no art, no lookup');
  assert.equal(ctx.kjrArtState(single({ tcgdexId: 'swsh7-215' }), 'singles').state, 'need');
  ctx.kjrRememberCardImage('swsh7-215', BASE, 'en');
  assert.equal(ctx.kjrArtState(single({ tcgdexId: 'swsh7-215' }), 'singles').state, 'hit');
  ctx.kjrRememberCardImageMiss('zz-1');
  assert.equal(ctx.kjrArtState(single({ tcgdexId: 'zz-1' }), 'singles').state, 'none', 'a fresh miss shows the placeholder');
  const jp = ctx.kjrArtState(single({ tcgdexId: 'SV2a-001', language: 'JP' }), 'singles');
  assert.equal(jp.state, 'need'); assert.equal(jp.key, 'ja:SV2a-001'); assert.equal(jp.lang, 'ja');

  // slabs: only an English slab whose name carries a card number can ever resolve
  assert.equal(ctx.kjrArtState(slab({ id: 'a' }), 'slabs').state, 'need');
  assert.equal(ctx.kjrArtState(slab({ id: 'a' }), 'slabs').key, 'slab:a');
  assert.equal(ctx.kjrArtState(slab({ id: 'b', name: 'Umbreon Custom Card' }), 'slabs').state, 'none', 'no number, nothing to resolve');
  assert.equal(ctx.kjrArtState(slab({ id: 'c', language: 'JP' }), 'slabs').state, 'none', 'non-English slabs stay placeholders');
  assert.equal(ctx.kjrArtState(slab({ id: 'd', tcgdexId: 'swsh7-215' }), 'slabs').state, 'hit', 'an id on the slab itself is used as is');
  // a stored link wins, a renamed slab no longer matches it
  ctx.kjrSlabLinkSet('a', 'Umbreon VMAX 215/203|en', 'swsh7-215');
  assert.equal(ctx.kjrArtState(slab({ id: 'a' }), 'slabs').state, 'hit');
  assert.equal(ctx.kjrArtState(slab({ id: 'a', name: 'Umbreon VMAX 215/203 (fixed)' }), 'slabs').state, 'need', 'renamed: resolve again');
  ctx.kjrSlabLinkSet('e', 'Pikachu 25|en', null);
  assert.equal(ctx.kjrArtState(slab({ id: 'e', name: 'Pikachu 25' }), 'slabs').state, 'none', 'a fresh slab miss shows the placeholder');
});

test('card-art: an image that failed to load drops to the placeholder and is not requested again this session', async () => {
  const { ctx } = await loadApp();
  ctx.kjrRememberCardImage('swsh7-215', BASE, 'en');
  const row = single({ tcgdexId: 'swsh7-215' });
  assert.equal(ctx.kjrArtState(row, 'singles').state, 'hit');
  const classes = new Set(['kjr-art']);
  let removed = false;
  const slot = { classList: { add: (c) => classes.add(c) } };
  const img = { tagName: 'IMG', classList: { contains: (c) => c === 'kjr-card-img' }, getAttribute: () => BASE + '/low.webp', parentNode: slot, remove: () => { removed = true; } };
  ctx.kjrImgOnError({ target: img });
  assert.ok(removed && classes.has('kjr-art-ph'));
  assert.equal(ctx.kjrArtState(row, 'singles').state, 'none', 'the broken URL is remembered for the session only');
  assert.equal(JSON.parse(ctx.localStorage.getItem('kjr_card_images'))['swsh7-215'], BASE, 'the stored base is untouched');
  // not an art image, or offline: ignored / not remembered
  assert.doesNotThrow(() => ctx.kjrImgOnError({ target: { tagName: 'IMG', classList: { contains: () => false } } }));
  const { ctx: c2 } = await loadApp();
  c2.kjrRememberCardImage('swsh7-215', BASE, 'en');
  c2.navigator.onLine = false;
  c2.kjrImgOnError({ target: Object.assign({}, img, { parentNode: { classList: { add() {} } } }) });
  assert.equal(c2.kjrArtState(row, 'singles').state, 'hit', 'offline failures are not held against the card');
});

// ── rendering never fetches, never writes a row ─────────────────────────────────────────────
test('card-art: renderSingles and renderSlabs fire NO fetch, in list or grid mode, even with an observer present', async () => {
  const seed = makeSeed({
    singles: [single({ id: 's1', tcgdexId: 'swsh7-215' }), single({ id: 's2', tcgdexId: 'swsh7-218', name: 'Rayquaza VMAX 218/203' })],
    slabs: [slab({ id: 'p1' }), slab({ id: 'p2', name: 'Mew ex 232/091' })],
  });
  for (const mode of ['list', 'grid']) {
    const { ctx, fetchMock, settle } = await loadApp({ seed, localStorage: { kjr_view_singles: mode, kjr_view_slabs: mode } });
    fetchMock.calls.length = 0;
    const observed = [];
    ctx.IntersectionObserver = class { constructor() {} observe(el) { observed.push(el); } disconnect() {} };
    ctx.renderSingles(); ctx.renderSlabs();
    await settle();
    assert.equal(fetchMock.calls.length, 0, mode + ' render fired a fetch: ' + fetchMock.calls.map(c => c.url).join(', '));
  }
});

test('card-art: the image feature writes no data row, marks nothing dirty and never saves', async () => {
  const seed = makeSeed({ singles: [single({ id: 's1', tcgdexId: 'swsh7-215' })], slabs: [slab({ id: 'p1' })] });
  const app = await loadApp({ seed, localStorage: { kjr_view_singles: 'grid', kjr_view_slabs: 'grid' } });
  const { ctx, fetchMock, localStorage } = app;
  const dbBefore = JSON.stringify(ctx.DB);
  const storedBefore = localStorage.getItem('pokeinventory_v3');
  const dirtyBefore = JSON.stringify([...ctx._dirty.singles, ...ctx._dirty.slabs]);
  let marks = 0, saves = 0;
  const realMark = ctx.markDirty, realSave = ctx.saveData;
  ctx.markDirty = (...a) => { marks++; return realMark.apply(ctx, a); };
  ctx.saveData = (...a) => { saves++; return realSave.apply(ctx, a); };

  fetchMock.calls.length = 0;
  fetchMock.route('/cards?name=', () => jsonResponse([{ id: 'swsh7-215', name: 'Umbreon VMAX' }]));
  fetchMock.route('/cards/swsh7-215', () => jsonResponse({ id: 'swsh7-215', image: BASE, pricing: {} }));
  ctx.renderSingles(); ctx.renderSlabs();
  ctx.kjrQueueCardImage({ key: 'swsh7-215', tcg: 'swsh7-215', lang: 'en' });
  ctx.kjrQueueCardImage({ key: 'slab:p1', slab: 'p1', lang: 'en' });
  await drain(app);

  const urls = fetchMock.calls.map(c => c.url);
  assert.ok(urls.some(u => u.includes('/cards/swsh7-215')), 'the card lookup ran');
  assert.ok(urls.some(u => u.includes('/cards?name=')), 'and so did the slab resolve');
  assert.equal(ctx.kjrCardImageBase('swsh7-215'), BASE, 'the base reached the local map');
  assert.equal(JSON.stringify(ctx.DB), dbBefore, 'no row changed');
  assert.equal(localStorage.getItem('pokeinventory_v3'), storedBefore, 'the stored database is byte for byte the same');
  assert.equal(JSON.stringify([...ctx._dirty.singles, ...ctx._dirty.slabs]), dirtyBefore, 'nothing was marked dirty');
  assert.equal(marks, 0, 'markDirty was never called');
  assert.equal(saves, 0, 'saveData was never called');
  assert.equal(ctx.DB.slabs[0].tcgdexId, undefined);
});

// ── slab resolution on a copy ───────────────────────────────────────────────────────────────
test('card-art: a slab is resolved on a SHALLOW COPY, the row gets no tcgdexId, the link lands in the local map', async () => {
  const seed = makeSeed({ slabs: [slab({ id: 'p1' }), slab({ id: 'p2' })] });
  const app = await loadApp({ seed });
  const { ctx, fetchMock, localStorage } = app;
  const rowBefore = JSON.stringify(ctx.DB.slabs);
  fetchMock.calls.length = 0;
  fetchMock.route('/cards?name=', () => jsonResponse([{ id: 'swsh7-215', name: 'Umbreon VMAX' }]));
  fetchMock.route('/cards/swsh7-215', () => jsonResponse({ id: 'swsh7-215', image: BASE, pricing: {} }));

  assert.equal(ctx.kjrQueueCardImage({ key: 'slab:p1', slab: 'p1', lang: 'en' }), true);
  await drain(app);
  const urls = fetchMock.calls.map(c => c.url);
  assert.equal(urls.length, 2, 'one resolve, one card fetch: ' + urls.join(' | '));
  assert.match(urls[0], /\/en\/cards\?name=Umbreon%20VMAX&localId=215$/);
  assert.match(urls[1], /\/en\/cards\/swsh7-215$/);

  assert.equal(ctx.DB.slabs[0].tcgdexId, undefined, 'the row has no tcgdexId afterwards');
  assert.equal(ctx.DB.slabs[0]._tcgdexResolvedName, undefined, 'and no resolved-name marker either');
  assert.equal(JSON.stringify(ctx.DB.slabs), rowBefore);
  assert.deepEqual(JSON.parse(localStorage.getItem('kjr_slab_card_ids')), { p1: { id: 'swsh7-215', n: 'Umbreon VMAX 215/203|en' } });
  assert.equal(ctx.kjrCardImageBase('swsh7-215'), BASE);
  assert.equal(ctx.kjrArtState(ctx.DB.slabs[0], 'slabs').state, 'hit');

  // an identical slab reuses the link and the cached base: no further request at all
  assert.equal(ctx.kjrQueueCardImage({ key: 'slab:p2', slab: 'p2', lang: 'en' }), true);
  await drain(app);
  assert.equal(fetchMock.calls.length, 2, 'the twin slab cost no request');
  assert.equal(ctx.kjrArtState(ctx.DB.slabs[1], 'slabs').state, 'hit', 'and it now shows the art');
  assert.equal(ctx.DB.slabs[1].tcgdexId, undefined);
});

test('card-art: an ambiguous slab name records a miss and shows the placeholder, it is not guessed', async () => {
  const app = await loadApp({ seed: makeSeed({ slabs: [slab({ id: 'p1', name: 'Pikachu 25' })] }) });
  const { ctx, fetchMock, localStorage } = app;
  fetchMock.calls.length = 0;
  fetchMock.route('/cards?name=', () => jsonResponse([{ id: 'basep-25' }, { id: 'sv03.5-025' }, { id: '2021swsh-25' }]));
  ctx.kjrQueueCardImage({ key: 'slab:p1', slab: 'p1', lang: 'en' });
  await drain(app);
  assert.equal(fetchMock.calls.length, 1, 'no card fetch for an unresolved slab');
  assert.deepEqual(JSON.parse(localStorage.getItem('kjr_slab_card_ids')), { p1: { miss: iso(0), n: 'Pikachu 25|en' } });
  assert.equal(ctx.kjrArtState(ctx.DB.slabs[0], 'slabs').state, 'none');
  assert.equal(ctx.DB.slabs[0].tcgdexId, undefined);
  // and it is not looked up again while the miss is fresh
  assert.equal(ctx.kjrQueueCardImage({ key: 'slab:p1', slab: 'p1', lang: 'en' }), false);
  assert.equal(fetchMock.calls.length, 1);
});

test('card-art: offline, a slab that resolves to nothing is not recorded as a miss', async () => {
  const app = await loadApp({ seed: makeSeed({ slabs: [slab({ id: 'p1' })] }) });
  const { ctx, fetchMock, localStorage } = app;
  fetchMock.calls.length = 0;
  // the network drops while resolveTcgdexId (which swallows its own errors) is in flight
  fetchMock.route('/cards?name=', async () => { ctx.navigator.onLine = false; throw new TypeError('offline'); });
  ctx.kjrQueueCardImage({ key: 'slab:p1', slab: 'p1', lang: 'en' });
  await drain(app);
  assert.equal(localStorage.getItem('kjr_slab_card_ids'), null, 'no 7-day miss for a blip');
  assert.equal(ctx.kjrArtState(ctx.DB.slabs[0], 'slabs').state, 'need', 'it stays a candidate for a later lookup');
});

// ── the throttled queue ─────────────────────────────────────────────────────────────────────
test('card-art: the queue runs at most 3 lookups at once, about 150ms apart, one per card', async () => {
  const { ctx, fetchMock, timers, settle } = await loadApp();
  fetchMock.calls.length = 0;
  const pending = [];
  fetchMock.route('/cards/', (url) => new Promise((resolve) => pending.push({ url, resolve })));
  for (let n = 1; n <= 7; n++) ctx.kjrQueueCardImage({ key: 'zz-' + n, tcg: 'zz-' + n, lang: 'en' });
  assert.equal(ctx.kjrQueueCardImage({ key: 'zz-1', tcg: 'zz-1', lang: 'en' }), false, 'a card already queued is not queued twice');
  await settle();
  assert.equal(fetchMock.calls.length, 1, 'only the first starts at once, the rest wait for the 150ms gap');
  const gap = timers.pending.get(ctx._kjrImgQ.timer);
  assert.ok(gap && gap.delay > 0 && gap.delay <= 150, 'a gap timer of at most 150ms is pending');

  const step = async () => {
    const id = ctx._kjrImgQ.timer;
    if (id) { ctx._kjrImgQ.lastStart -= 1000; timers.invoke(id); }
    await settle();
  };
  for (let i = 0; i < 6; i++) await step();
  assert.equal(fetchMock.calls.length, 3, 'never more than 3 at once');
  assert.equal(ctx._kjrImgQ.active, 3);
  assert.equal(ctx._kjrImgQ.jobs.length, 4);

  pending[0].resolve(jsonResponse({ id: 'zz-1', image: 'https://assets.tcgdex.net/en/x/y/zz-1', pricing: {} }));
  await settle(); await step();
  assert.equal(fetchMock.calls.length, 4, 'a finished lookup frees a slot for the next');
  assert.equal(ctx.kjrCardImageBase('zz-1'), 'https://assets.tcgdex.net/en/x/y/zz-1');
  const all = fetchMock.calls.map(c => c.url);
  assert.equal(new Set(all).size, all.length, 'no card is requested twice');
});

test('card-art: a lookup waits while offline and nothing is requested', async () => {
  const { ctx, fetchMock, settle } = await loadApp();
  fetchMock.calls.length = 0;
  ctx.navigator.onLine = false;
  ctx.kjrQueueCardImage({ key: 'zz-1', tcg: 'zz-1', lang: 'en' });
  await settle();
  assert.equal(fetchMock.calls.length, 0);
  fetchMock.route('/cards/', () => jsonResponse({ id: 'zz-1', image: BASE, pricing: {} }));
  ctx.navigator.onLine = true;
  ctx.kjrImgPump();
  await settle();
  assert.equal(fetchMock.calls.length, 1, 'back online, the waiting lookup runs');
});

test('card-art: a 404 is a 7-day miss, a server error is not remembered, and repeated failures pause the queue', async () => {
  const { ctx, fetchMock, settle } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/cards/zz-404', { status: 404, ok: false, json: {} });
  fetchMock.route('/cards/zz-500', { status: 500, ok: false, json: {} });
  ctx.kjrQueueCardImage({ key: 'zz-404', tcg: 'zz-404', lang: 'en' });
  await settle();
  assert.equal(ctx.kjrCardImageMissed('zz-404'), true);
  ctx._kjrImgQ.lastStart = 0;
  ctx.kjrQueueCardImage({ key: 'zz-500', tcg: 'zz-500', lang: 'en' });
  await settle();
  assert.equal(ctx.kjrCardImageMissed('zz-500'), false, 'a 5xx says nothing about the card');
  assert.equal(ctx.kjrQueueCardImage({ key: 'zz-500', tcg: 'zz-500', lang: 'en' }), false, 'but it is not hammered: cooled down for this session');
  for (const k of ['zz-a', 'zz-b', 'zz-c']) {
    fetchMock.route('/cards/' + k, { status: 503, ok: false, json: {} });
    ctx._kjrImgQ.lastStart = 0;
    ctx.kjrQueueCardImage({ key: k, tcg: k, lang: 'en' });
    await settle();
  }
  assert.ok(ctx._kjrImgQ.pauseUntil > Date.now(), 'three failures in a row pause the whole queue');
});

test('card-art: a lookup that scrolled away before its turn is dropped, one still on screen runs', async () => {
  const { ctx, fetchMock, timers, settle } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/cards/', () => jsonResponse({ id: 'x', image: BASE, pricing: {} }));
  const gone = { _kjrVis: false, isConnected: true, getAttribute: () => null };
  const here = { _kjrVis: true, isConnected: true, getAttribute: () => null };
  ctx._kjrImgQ.lastStart = Date.now(); // the gap is open, so both lookups wait in the queue
  ctx.kjrQueueCardImage({ key: 'zz-gone', tcg: 'zz-gone', lang: 'en' }, gone);
  ctx.kjrQueueCardImage({ key: 'zz-here', tcg: 'zz-here', lang: 'en' }, here);
  assert.equal(fetchMock.calls.length, 0);
  ctx._kjrImgQ.lastStart = 0;
  timers.invoke(ctx._kjrImgQ.timer);
  await settle(40);
  const urls = fetchMock.calls.map(c => c.url);
  assert.ok(!urls.some(u => u.includes('zz-gone')), 'scrolled away: not requested');
  assert.ok(urls.some(u => u.includes('zz-here')), 'still visible: requested');
  assert.equal(ctx.kjrQueueCardImage({ key: 'zz-gone', tcg: 'zz-gone', lang: 'en' }, here), true, 'it can be queued again if it scrolls back');
});

test('card-art: kjrObserveCardImages needs an IntersectionObserver and watches only placeholders that could be filled', async () => {
  const { ctx } = await loadApp();
  const slotA = { id: 'a' }, slotB = { id: 'b' };
  const root = { querySelectorAll: (sel) => { assert.equal(sel, '.kjr-art[data-need]'); return [slotA, slotB]; } };
  assert.equal(ctx.kjrObserveCardImages(root, 'singles'), 0, 'no IntersectionObserver in this sandbox: a quiet no-op');
  const watched = [];
  ctx.IntersectionObserver = class { constructor(cb, opts) { this.opts = opts; } observe(el) { watched.push(el); } disconnect() {} };
  assert.equal(ctx.kjrObserveCardImages(root, 'singles'), 2);
  assert.deepEqual(watched, [slotA, slotB]);
  assert.equal(ctx.kjrObserveCardImages(null, 'singles'), 0);
});

// ── grid view ───────────────────────────────────────────────────────────────────────────────
test('card-art: the view preference defaults to the list, persists per tab and survives bad values', async () => {
  const { ctx, localStorage } = await loadApp();
  assert.equal(ctx.kjrViewMode('singles'), 'list');
  assert.equal(ctx.kjrViewMode('slabs'), 'list');
  ctx.kjrSetView('singles', 'grid');
  assert.equal(localStorage.getItem('kjr_view_singles'), 'grid');
  assert.equal(localStorage.getItem('kjr_view_slabs'), null, 'each tab has its own preference');
  assert.equal(ctx.kjrViewMode('singles'), 'grid');
  assert.equal(ctx.kjrViewMode('slabs'), 'list');
  ctx.kjrSetView('singles', 'banana');
  assert.equal(localStorage.getItem('kjr_view_singles'), 'list', 'anything but grid is the list');
  localStorage.setItem('kjr_view_singles', 'grid'); // another tab picks the grid
  assert.equal(ctx.kjrViewMode('singles'), 'grid', 'localStorage is the source while it works');

  const { ctx: c2 } = await loadApp({ localStorage: { kjr_view_singles: 'banana', kjr_view_slabs: 'grid' } });
  assert.equal(c2.kjrViewMode('singles'), 'list');
  assert.equal(c2.kjrViewMode('slabs'), 'grid', 'read back after a reload');
  assert.equal(c2.kjrViewMode('sales'), 'list', 'tabs without a grid are always lists');
});

test('card-art: with the grid markup missing (a stale page) the grid preference falls back to the table', async () => {
  const { ctx, document } = await loadApp({ localStorage: { kjr_view_singles: 'grid' } });
  const real = document.getElementById.bind(document);
  document.getElementById = (id) => (id === 'singles-grid' ? null : real(id));
  assert.equal(ctx.kjrViewApply('singles'), 'list');
  ctx.renderSingles();
  assert.ok(document.getElementById('singles-body').innerHTML.includes('<tr'), 'the table still renders, the page is never left blank');
});

test('card-art: switching to the grid clears a hidden bulk selection, and survives blocked storage', async () => {
  const { ctx, localStorage } = await loadApp();
  ctx.selectedIds.singles.add('single_seed_1');
  ctx.kjrSetView('singles', 'grid');
  assert.equal(ctx.selectedIds.singles.size, 0, 'the grid has no checkboxes, so no invisible selection is left behind');
  localStorage.setItem = () => { throw new Error('blocked'); };
  assert.doesNotThrow(() => ctx.kjrSetView('slabs', 'grid'));
  assert.equal(ctx.kjrViewMode('slabs'), 'grid', 'the choice holds for this session');
});

test('card-art: grid tiles carry the same rows in the same order as the list, for every status filter', async () => {
  const singles = [
    single({ id: 'a', name: 'Alakazam 1', marketPrice: 30, status: 'Available' }),
    single({ id: 'b', name: 'Blastoise 2', marketPrice: 90, status: 'Sold' }),
    single({ id: 'c', name: 'Charizard 3', marketPrice: 10, status: 'Available' }),
    single({ id: 'd', name: 'Dragonite 4', marketPrice: 50, status: 'Sold' }),
    single({ id: 'e', name: 'Eevee 5', marketPrice: 70, status: 'Available' }),
  ];
  for (const status of ['available', 'sold', 'all']) {
    for (const sort of [null, { col: 'marketPrice', dir: -1 }, { col: 'name', dir: 1 }]) {
      const list = await loadApp({ seed: makeSeed({ singles }) });
      list.document.getElementById('singles-status-filter').value = status;
      if (sort) { list.ctx.sortState.singles.col = sort.col; list.ctx.sortState.singles.dir = sort.dir; }
      list.ctx.renderSingles();
      const listIds = idsIn(list.document.getElementById('singles-body').innerHTML);

      const grid = await loadApp({ seed: makeSeed({ singles }), localStorage: { kjr_view_singles: 'grid' } });
      grid.document.getElementById('singles-status-filter').value = status;
      if (sort) { grid.ctx.sortState.singles.col = sort.col; grid.ctx.sortState.singles.dir = sort.dir; }
      grid.ctx.renderSingles();
      const gridIds = idsIn(grid.document.getElementById('singles-grid').innerHTML);
      assert.deepEqual(gridIds, listIds, 'status=' + status + ' sort=' + JSON.stringify(sort));
      assert.equal(grid.document.getElementById('singles-body').innerHTML, '', 'the table is not built while the grid shows');
    }
  }
});

test('card-art: a search filter narrows the grid exactly as it narrows the list', async () => {
  const singles = [single({ id: 'a', name: 'Pikachu 25' }), single({ id: 'b', name: 'Charizard 4' }), single({ id: 'c', name: 'Pikachu 58' })];
  const list = await loadApp({ seed: makeSeed({ singles }) });
  list.document.getElementById('singles-search').value = 'pika';
  list.ctx.renderSingles();
  const grid = await loadApp({ seed: makeSeed({ singles }), localStorage: { kjr_view_singles: 'grid' } });
  grid.document.getElementById('singles-search').value = 'pika';
  grid.ctx.renderSingles();
  const ids = idsIn(grid.document.getElementById('singles-grid').innerHTML);
  assert.deepEqual(ids, idsIn(list.document.getElementById('singles-body').innerHTML));
  assert.deepEqual(ids.slice().sort(), ['a', 'c']);
});

test('card-art: slab grid tiles match the slab list order, with sold slabs behind the same toggle', async () => {
  const slabs = [
    slab({ id: 'p1', name: 'Umbreon VMAX 215/203', marketPrice: 1380 }),
    slab({ id: 'p2', name: 'Mew ex 232/091', grader: 'TAG', grade: '10', marketPrice: 260 }),
    slab({ id: 'p3', name: 'Charizard 4 Base Set', grader: 'BGS', grade: '9.5', marketPrice: 820, status: 'Sold' }),
  ];
  const list = await loadApp({ seed: makeSeed({ slabs }) });
  list.document.getElementById('slabs-sold-divider').dataset.open = '1';
  list.ctx.renderSlabs();
  const listIds = [...idsIn(list.document.getElementById('slabs-body').innerHTML), ...idsIn(list.document.getElementById('slabs-sold-body').innerHTML)];
  const grid = await loadApp({ seed: makeSeed({ slabs }), localStorage: { kjr_view_slabs: 'grid' } });
  grid.document.getElementById('slabs-sold-divider').dataset.open = '1';
  grid.ctx.renderSlabs();
  const gridIds = [...idsIn(grid.document.getElementById('slabs-grid').innerHTML), ...idsIn(grid.document.getElementById('slabs-grid-alt').innerHTML)];
  assert.deepEqual(gridIds, listIds);
  const alt = grid.document.getElementById('slabs-grid-alt').innerHTML;
  assert.match(alt, /data-kjr-act="alt"[^>]*aria-expanded="true"/);
  assert.match(alt, /is-sold/);
  grid.document.getElementById('slabs-sold-divider').dataset.open = '0';
  grid.ctx.renderSlabs();
  assert.doesNotMatch(grid.document.getElementById('slabs-grid-alt').innerHTML, /kjr-tile/, 'closed: only the toggle shows');
});

test('card-art: grid markup escapes every data value and carries no inline handlers', async () => {
  const hostile = '<img src=x onerror=alert(1)> "q" & \'s\' </span><script>';
  const singles = [single({ id: 'x"><b>', name: hostile, set: '<b>Set</b> & co', tcgdexId: '', language: 'E"N' })];
  const slabs = [slab({ id: 'y"><i>', name: hostile, grader: '<u>PSA</u>', grade: '"10"', certNo: '<cert>' })];
  const { ctx, document } = await loadApp({ seed: makeSeed({ singles, slabs }), localStorage: { kjr_view_singles: 'grid', kjr_view_slabs: 'grid' } });
  ctx.renderSingles(); ctx.renderSlabs();
  for (const id of ['singles-grid', 'slabs-grid']) {
    const html = document.getElementById(id).innerHTML;
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), id + ': the name is escaped');
    assert.ok(!html.includes('<img src=x'), id + ': no raw injected element');
    assert.ok(!html.includes('<script'), id + ': no raw script tag');
    assert.ok(!html.includes('<b>') && !html.includes('<i>') && !html.includes('<u>') && !html.includes('<cert>'), id + ': no raw tags from data');
    const tagsOnly = html.replace(/="[^"]*"/g, '=""'); // attribute values may legitimately contain the escaped hostile text
    assert.ok(!/<[^>]*\son[a-z]+\s*=/i.test(tagsOnly), id + ': no inline event handler attributes');
    assert.match(html, /<button type="button" class="kjr-tile[^"]*" data-id="[^"]*&quot;&gt;/, id + ': the id lives in an escaped data attribute');
    assert.match(html, /aria-label="&lt;img src=x onerror=alert\(1\)&gt; &quot;q&quot; &amp; &#39;s&#39;/, id + ': the accessible name is the escaped card name');
  }
});

test('card-art: a tile reads as name, set, value with a signed arrow percentage, then asking or manual price', async () => {
  const { ctx } = await loadApp();
  const html = (i, t, sold) => ctx.kjrTileHtml(i, t || 'singles', !!sold);
  const gain = html(single({ id: '1', name: 'Umbreon VMAX', set: 'Evolving Skies', costPrice: 520, marketPrice: 610, listPrice: 680, qty: 1 }));
  assert.match(gain, /<span class="kjr-tile-name" title="Umbreon VMAX">Umbreon VMAX<\/span>/);
  assert.match(gain, /<span class="kjr-tile-set">Evolving Skies<\/span>/);
  assert.match(gain, /<span class="kjr-tile-price">S\$610<\/span>/);
  assert.match(gain, /<span class="kjr-tile-pct pos">▲ \+17\.3%<\/span>/, 'gain: arrow, plus sign, one decimal');
  assert.match(gain, /<span class="kjr-tile-note">Asking S\$680<\/span>/);
  assert.doesNotMatch(gain, /kjr-tile-qty/, 'no quantity badge for one');

  const loss = html(single({ id: '2', costPrice: 88, marketPrice: 74, listPrice: '' }));
  assert.match(loss, /<span class="kjr-tile-pct neg">▼ -15\.9%<\/span>/, 'loss: arrow and minus sign, not colour alone');

  const multi = html(single({ id: '3', qty: 4, language: 'JP', costPrice: 36, marketPrice: 56, listPrice: 18 }));
  assert.match(multi, /<span class="kjr-tile-qty">×4<\/span>/);
  assert.match(multi, /<span class="kjr-tile-lang">JP<\/span>/);
  assert.match(multi, /<span class="kjr-tile-note">Manual price<\/span><span class="kjr-tile-note">Asking S\$18 each<\/span>/);

  const estimate = html(single({ id: '4', costPrice: 12, marketPrice: '', listPrice: '' }));
  assert.match(estimate, /<span class="kjr-tile-price">~S\$12<\/span>/, 'an estimate from cost is flagged with ~');
  assert.doesNotMatch(estimate, /kjr-tile-pct/, 'and has no gain to show');
  const flat = html(single({ id: '5', costPrice: 5, marketPrice: 5 }));
  assert.match(flat, /<span class="kjr-tile-pct ">0%<\/span>/);
  const cheap = html(single({ id: '6', costPrice: 0.1, marketPrice: 0.4 }));
  assert.match(cheap, /<S\$1|&lt;S\$1/, 'a priced card never reads S$0');
  const blankLang = html(single({ id: '7', language: '' }));
  assert.match(blankLang, /<span class="kjr-tile-lang">EN<\/span>/, 'a blank language has always meant EN');

  const sold = html(single({ id: '8', name: 'Gone', status: 'Sold' }), 'singles', true);
  assert.match(sold, /class="kjr-tile is-sold"/);
  assert.match(sold, /<span class="kjr-tile-soldtag">Sold<\/span>/);
  assert.match(sold, /aria-label="Gone, sold"/);
  assert.match(gain, /aria-label="Umbreon VMAX"/, 'an available tile is named by the card name alone');
});

test('card-art: drawn slabs take the grader colour, show grader left and grade right, and leave the badge alone', async () => {
  const { ctx } = await loadApp();
  const cases = [
    [{ grader: 'PSA', grade: '10' }, 'psa', 'PSA', '10'],
    [{ grader: 'cgc', grade: '9.5' }, 'cgc', 'CGC', '9.5'],
    [{ grader: 'BGS', grade: '9.5' }, 'bgs', 'BGS', '9.5'],
    [{ grader: 'TAG', grade: '10' }, 'tag', 'TAG', '10'],
    [{ grader: 'TAG', grade: '10 Pristine' }, 'tag', 'TAG', '10 ★'],
    [{ grader: 'SGC', grade: '9' }, 'other', 'SGC', '9'],
    [{ grader: 'PSA 8', grade: '' }, 'psa', 'PSA', '8'],
    [{ grader: '', grade: '' }, 'other', '?', '?'],
  ];
  for (const [fields, key, grader, grade] of cases) {
    const html = ctx.kjrSlabArtHtml(slab(fields), 'tile');
    assert.match(html, new RegExp('<span class="kjr-slab-label kjr-g-' + key + '"><span>' + grader.replace('?', '\\?') + '</span><span>' + grade.replace('?', '\\?') + '</span></span>'), JSON.stringify(fields));
    assert.match(html, /<span class="kjr-slab" aria-hidden="true">/, 'the drawing is decorative, the tile text carries the grade');
    assert.match(html, /kjr-slab-art/);
  }
  const thumb = ctx.kjrSlabArtHtml(slab({ grader: 'BGS', grade: '9.5' }), 'thumb');
  assert.match(thumb, /class="kjr-art kjr-thumb kjr-thumb-slab kjr-g-bgs/);
  const tile = ctx.kjrTileHtml(slab({ grader: 'TAG', grade: '10 Pristine', name: 'Gengar VMAX 271/264' }), 'slabs', false);
  assert.match(tile, /aria-label="Gengar VMAX 271\/264, TAG 10 pristine"/, 'the drawn label is decorative, so a slab tile is named with its grade');
  assert.match(tile, /<span class="kjr-tile-set">TAG 10 ★ · 12345678<\/span>/, 'and the grade is also plain text on the tile');
  // the table badge function is untouched
  assert.match(ctx.graderGradeBadge('PSA', '10'), /<span class="badge b-psa"[^>]*>PSA 10<\/span>/);
});

test('card-art: the empty and filtered-empty states in the grid say what the list says', async () => {
  const { ctx, document } = await loadApp({ localStorage: { kjr_view_singles: 'grid', kjr_view_slabs: 'grid' } });
  ctx.DB.singles = []; ctx.DB.slabs = [];
  ctx.renderSingles(); ctx.renderSlabs();
  const s = document.getElementById('singles-grid').innerHTML;
  assert.match(s, /No singles yet/); assert.match(s, /Add your first one to get started\./);
  assert.match(s, /<button type="button" class="btn btn-primary" data-kjr-act="add">\+ Add your first card<\/button>/);
  assert.doesNotMatch(s, /onclick/, 'the CTA is wired by the one delegated listener');
  assert.match(document.getElementById('slabs-grid').innerHTML, /No slabs yet/);

  ctx.DB.singles = [single({ id: 'z', name: 'Zubat 1' })];
  document.getElementById('singles-search').value = 'nothing like this';
  ctx.renderSingles();
  const f = document.getElementById('singles-grid').innerHTML;
  assert.match(f, /No matches/); assert.match(f, /Nothing matches the current search or filters\. Clear them to see everything\./);
  assert.doesNotMatch(f, /btn-primary/, 'a filtered-empty state has no add-first-card CTA');
});

test('card-art: one delegated click listener opens the editor with the exact id, for tiles, the sold toggle and the empty CTA', async () => {
  const { ctx, document } = await loadApp({ localStorage: { kjr_view_singles: 'grid', kjr_view_slabs: 'grid' } });
  ctx.renderSingles(); ctx.renderSlabs();
  const wrap = document.getElementById('singles-grid-wrap');
  assert.equal(wrap._listeners.get('click').length, 1, 'one listener on the container, none per tile');
  ctx.renderSingles();
  assert.equal(wrap._listeners.get('click').length, 1, 're-rendering does not stack listeners');

  const calls = [];
  ctx.openEditSingle = (id) => calls.push(['single', id]);
  ctx.openEditSlab = (id) => calls.push(['slab', id]);
  ctx.openAddSingle = () => calls.push(['add-single']);
  ctx.toggleSoldSection = (t) => calls.push(['toggle', t]);
  const weirdId = 'legacy "quoted" \\ <id> & \'x\'';
  const fire = (table, attrs) => ctx.kjrGridClick(table, { target: { closest: () => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null) }) } });
  fire('singles', { 'data-id': weirdId });
  fire('slabs', { 'data-id': 'slab_9' });
  fire('singles', { 'data-kjr-act': 'alt' });
  fire('singles', { 'data-kjr-act': 'add' });
  ctx.kjrGridClick('singles', { target: { closest: () => null } }); // a click on empty space does nothing
  assert.deepEqual(plain(calls), [['single', weirdId], ['slab', 'slab_9'], ['toggle', 'singles'], ['add-single']]);
});

test('card-art: a data-id with awkward characters round-trips through the tile attribute', async () => {
  const { ctx } = await loadApp();
  const id = 'legacy "q" \\ <r> & \'s\'';
  const html = ctx.kjrTileHtml(single({ id }), 'singles', false);
  const raw = html.match(/data-id="([^"]*)"/)[1];
  const decoded = raw.replace(/&(amp|lt|gt|quot|#39);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[n]));
  assert.equal(decoded, id);
});

// ── list thumbnails and the fetch hooks ─────────────────────────────────────────────────────
test('card-art: list rows get the thumbnail inside the name cell, set underneath, and no new inline handlers', async () => {
  const seed = makeSeed({ singles: [single({ id: 's1', name: 'Umbreon VMAX 215/203', set: 'Evolving Skies', tcgdexId: 'swsh7-215' })], slabs: [slab({ id: 'p1' })] });
  const { ctx, document } = await loadApp({ seed });
  ctx.kjrRememberCardImage('swsh7-215', BASE, 'en');
  ctx.renderSingles(); ctx.renderSlabs();
  const row = document.getElementById('singles-body').innerHTML;
  assert.match(row, /<td data-col-key="name"[^>]*><div class="kjr-name-cell"><span class="kjr-art kjr-thumb" data-sz="t"><img class="kjr-card-img" src="https:\/\/assets\.tcgdex\.net\/en\/swsh\/swsh7\/215\/low\.webp" width="28" height="39" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"/);
  assert.match(row, /<div class="kjr-name-set" title="Evolving Skies">Evolving Skies<\/div>/);
  assert.equal((row.match(/data-col-key="/g) || []).length, 9, 'no new column: the same nine cells as before');
  assert.doesNotMatch(row, /<img[^>]*\son(error|load)=/i);
  const srow = document.getElementById('slabs-body').innerHTML;
  assert.match(srow, /<span class="kjr-art kjr-thumb kjr-thumb-slab kjr-g-psa kjr-art-ph" data-sz="t" data-need="1" data-ik="slab:p1" data-lg="en" data-slab="p1"><\/span>/);
  assert.match(srow, /class="cert-no"/, 'the cert number uses the mono class');
  assert.equal((srow.match(/data-col-key="/g) || []).length, 11);
});

test('card-art: fetchPriceFromTcgdex keeps the image base it already fetched and returns exactly what it did before', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/cards/base1-58', () => jsonResponse({ id: 'base1-58', image: 'https://assets.tcgdex.net/en/base/base1/58', pricing: { tcgplayer: { holofoil: { marketPrice: 12.5 } } } }));
  const item = { name: 'Pikachu 58', language: 'EN', tcgdexId: 'base1-58' };
  const res = await ctx.fetchPriceFromTcgdex(item);
  assert.deepEqual(plain(res), { priceUsd: 12.5, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high', creditsUsed: 0 });
  assert.equal(fetchMock.calls.length, 1, 'no extra request for the image');
  assert.equal(ctx.kjrCardImageBase('base1-58'), 'https://assets.tcgdex.net/en/base/base1/58');
  assert.deepEqual(Object.keys(item).sort(), ['language', 'name', 'tcgdexId'], 'the item is not touched');

  // a card with no pricing block is still a clean miss, and its image is still kept
  fetchMock.route('/cards/svp-044', () => jsonResponse({ id: 'svp-044', image: 'https://assets.tcgdex.net/en/svp/svp/044' }));
  const miss = await ctx.fetchPriceFromTcgdex({ name: 'Charmander 044', language: 'EN', tcgdexId: 'svp-044' });
  assert.deepEqual(plain(miss), { error: 'not found' });
  assert.equal(ctx.kjrCardImageBase('svp-044'), 'https://assets.tcgdex.net/en/svp/svp/044');

  // a throwing art cache can never change the price result
  ctx.kjrRememberCardImage = () => { throw new Error('boom'); };
  fetchMock.route('/cards/swsh7-215', () => jsonResponse({ id: 'swsh7-215', image: BASE, pricing: { cardmarket: { avg: 20 } } }));
  const res2 = await ctx.fetchPriceFromTcgdex({ name: 'Umbreon VMAX 215/203', language: 'EN', tcgdexId: 'swsh7-215' });
  assert.deepEqual(plain(res2), { priceEur: 20, unit: 'EUR', source: 'TCGdex (Cardmarket)', confidence: 'high', creditsUsed: 0 });
  assert.ok(localStorage.getItem('kjr_card_images'));
});

test('card-art: a Japanese lookup is keyed by language and never overwrites the English art for the same id', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/en/cards/sv03-001', () => jsonResponse({ id: 'sv03-001', image: BASE, pricing: {} }));
  fetchMock.route('/ja/cards/sv03-001', () => jsonResponse({ id: 'sv03-001', image: 'https://assets.tcgdex.net/ja/SV/sv03/001', pricing: {} }));
  await ctx.fetchPriceFromTcgdex({ name: 'Card 1', language: 'EN', tcgdexId: 'sv03-001' });
  await ctx.fetchPriceFromTcgdex({ name: 'Card 1', language: 'JP', tcgdexId: 'sv03-001' });
  assert.equal(ctx.kjrCardImageBase('sv03-001', 'en'), BASE);
  assert.equal(ctx.kjrCardImageBase('sv03-001', 'ja'), 'https://assets.tcgdex.net/ja/SV/sv03/001');
});
