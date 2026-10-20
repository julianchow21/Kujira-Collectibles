'use strict';
// v3.83: card art that says what it is doing. An art slot is in one of three looks, never ambiguous: LOADING (a shimmer, aria-busy: a lookup is
// queued or running for it, or its picture is on the way), NO ART (the dimmed whale, a role=img with a name: no id, a miss, a lookup that
// could not answer, a picture that failed) and LOADED (the picture fades in as the loading class comes off). Also pinned here: the faster
// queue, the image map written once per burst instead of once per card (and flushed when the page hides), and the pictures asking for CORS.
// The service worker's art cache is in sw-art.test.js. The DOM here is a small fake (the sandbox has no layout), the CSS is pinned as text,
// and tests/preview-server.cjs plus a browser pass cover what a vm cannot (computed styles, the fade, the shimmer).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, makeSeed, jsonResponse, plain, ROOT } = require('./harness.js');

const BASE = 'https://assets.tcgdex.net/en/swsh/swsh7/215';
const BASE2 = 'https://assets.tcgdex.net/en/swsh/swsh7/218';
const single = (o) => Object.assign({}, makeSeed().singles[0], o);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
// the queue's only timer is its gap, run just that one (never timers.flush(), it would fire the app's own)
async function drain(app) {
  for (let n = 0; n < 8; n++) {
    await app.settle(20);
    const id = app.ctx._kjrImgQ.timer;
    if (!id) break;
    app.ctx._kjrImgQ.lastStart -= 1000;
    app.timers.invoke(id);
  }
  await app.settle(20);
}

// A slot, and a picture inside it, with the parts of the DOM the art code touches. cls and at are exposed so a test can read the look.
function artSlot(classes, attrs) {
  const cls = new Set(String(classes || 'kjr-art').split(' ').filter(Boolean));
  const at = Object.assign({}, attrs);
  const slot = {
    _kjrVis: true, isConnected: true, inserted: [], img: null, cls, at, onInsert: null,
    classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c) },
    getAttribute: (k) => (k in at ? at[k] : null),
    hasAttribute: (k) => k in at,
    setAttribute: (k, v) => { at[k] = String(v); },
    removeAttribute: (k) => { delete at[k]; },
    insertAdjacentHTML(pos, h) { slot.inserted.push(h); if (slot.onInsert) slot.onInsert(h); },
    querySelector: (sel) => (String(sel).startsWith('img.kjr-card-img') ? slot.img : null),
  };
  return slot;
}
function artImg(src, slot, extra) {
  const at = { src, crossorigin: 'anonymous' };
  const cls = new Set(['kjr-card-img']);
  const img = Object.assign({
    tagName: 'IMG', parentNode: slot, complete: false, naturalWidth: 0, removed: false, at,
    classList: { contains: (c) => cls.has(c), add: (c) => cls.add(c) },
    getAttribute: (k) => (k in at ? at[k] : null),
    hasAttribute: (k) => k in at,
    setAttribute: (k, v) => { at[k] = String(v); },
    removeAttribute: (k) => { delete at[k]; },
    remove() { img.removed = true; if (slot) slot.img = null; },
  }, extra);
  if (slot) slot.img = img;
  return img;
}
// a placeholder a lookup could fill, the way kjrArtSlot draws one
const placeholder = (key, extra) => artSlot('kjr-art kjr-thumb kjr-art-ph', Object.assign({ 'data-need': '1', 'data-ik': key, 'data-tcg': key, 'data-lg': 'en', 'data-sz': 't' }, extra));
const job = (key) => ({ key, tcg: key, lang: 'en' });
// the page's placeholders, the way the selector sees them: a slot only matches while it still carries data-need
const onPage = (app, ...slots) => { app.document.querySelectorAll = (sel) => (sel === '.kjr-art[data-need]' ? slots.filter((x) => 'data-need' in x.at) : []); };
const isLoading = (slot) => slot.cls.has('kjr-art-loading') && slot.at['aria-busy'] === 'true' && !slot.cls.has('kjr-art-none') && !('role' in slot.at);
const isNone = (slot, label) => slot.cls.has('kjr-art-none') && slot.cls.has('kjr-art-ph') && !slot.cls.has('kjr-art-loading') && !('aria-busy' in slot.at) &&
  slot.at.role === 'img' && slot.at['aria-label'] === label && slot.at.title === label;
const isLoaded = (slot) => !slot.cls.has('kjr-art-loading') && !slot.cls.has('kjr-art-none') && !('aria-busy' in slot.at) && !('role' in slot.at) && !('aria-label' in slot.at) && !('title' in slot.at);
const NONE = 'No image yet';
const FAIL = 'Image could not load';

// ── what a slot is drawn as ────────────────────────────────────────────────────────────────────────────────────────────────────
test('art states: kjrArtSlot draws each state differently, loading with aria-busy, the plain placeholder a lookup could fill, the whale with a name', async () => {
  const { ctx } = await loadApp();
  const hit = ctx.kjrArtSlot({ state: 'hit', base: BASE }, 't', 'kjr-thumb');
  assert.match(hit, /^<span class="kjr-art kjr-thumb kjr-art-loading" data-sz="t" aria-busy="true"><img class="kjr-card-img" src="https:\/\/assets\.tcgdex\.net\/en\/swsh\/swsh7\/215\/low\.webp" width="28" height="39" alt="" /);
  assert.match(hit, / crossorigin="anonymous"><\/span>$/, 'the picture asks for CORS, so the worker can cache it under its real size');
  assert.match(hit, / loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false"/, 'a thumbnail keeps native lazy loading');
  assert.match(ctx.kjrArtSlot({ state: 'hit', base: BASE }, 'c', 'kjr-tile-art'), / loading="lazy" /, 'and so does a tile');
  const big = ctx.kjrArtSlot({ state: 'hit', base: BASE }, 'h', 'kjr-insp-art');
  assert.match(big, / fetchpriority="high" decoding="async"/, 'the inspector art is what the open panel is for: high priority');
  assert.doesNotMatch(big, /loading="lazy"/, 'and lazy there would only wait for the sheet to slide in');

  const need = ctx.kjrArtSlot({ state: 'need', key: 'swsh7-215', tcg: 'swsh7-215', lang: 'en' }, 'c', 'kjr-tile-art');
  assert.equal(need, '<span class="kjr-art kjr-tile-art kjr-art-ph" data-sz="c" data-need="1" data-ik="swsh7-215" data-lg="en" data-tcg="swsh7-215"></span>',
    'no lookup is queued for it yet, so it is neither shimmering nor the whale (the observer that queues it runs after the render, the palette\'s too since v3.84)');
  const none = ctx.kjrArtSlot({ state: 'none' }, 't', 'kjr-thumb');
  assert.equal(none, '<span class="kjr-art kjr-thumb kjr-art-ph kjr-art-none" data-sz="t" role="img" aria-label="No image yet" title="No image yet"></span>');
});

test('art states: a picture that has been on screen this session is drawn without the shimmer, so a redraw never flashes', async () => {
  const { ctx } = await loadApp();
  const draw = (sz) => ctx.kjrArtSlot({ state: 'hit', base: BASE }, sz, 'kjr-thumb');
  assert.match(draw('t'), /kjr-art-loading/);
  const slot = artSlot('kjr-art kjr-art-loading', { 'aria-busy': 'true' });
  ctx.kjrImgOnLoad({ target: artImg(BASE + '/low.webp', slot) });
  assert.equal(ctx._kjrImgSeen[BASE + '/low.webp'], true);
  assert.doesNotMatch(draw('t'), /kjr-art-loading|aria-busy/, 'the small picture was seen');
  assert.match(draw('h'), /kjr-art-loading/, 'the large one was not, it is a different file');
  // the cap keeps the set from growing for ever
  for (let n = 0; n < ctx.KJR_IMG_SEEN_MAX + 5; n++) ctx.kjrImgSeenAdd('https://assets.tcgdex.net/x/' + n + '/low.webp');
  assert.ok(Object.keys(ctx._kjrImgSeen).length <= ctx.KJR_IMG_SEEN_MAX, 'bounded');
  assert.doesNotThrow(() => ctx.kjrImgSeenAdd(''));
});

test('art states: a picture that failed to load says so on every redraw, not just the first time, and a late fill onto a known-broken picture does too', async () => {
  const { ctx } = await loadApp();
  ctx.kjrRememberCardImage('swsh7-215', BASE, 'en');
  const row = single({ id: 'u', name: 'Umbreon VMAX 215/203', tcgdexId: 'swsh7-215' });
  assert.equal(ctx.kjrArtState(row, 'singles').state, 'hit');
  ctx._kjrImgBroken[BASE + '/low.webp'] = true; // what kjrImgOnError records for the session
  assert.deepEqual(plain(ctx.kjrArtState(row, 'singles')), { state: 'none', why: 'fail' });
  assert.match(ctx.kjrThumbHtml(row, 'singles'), /kjr-art-ph kjr-art-none" data-sz="t" role="img" aria-label="Image could not load" title="Image could not load"><\/span>$/);
  assert.match(ctx.kjrTileHtml(row, 'singles', false), /<span class="kjr-art kjr-tile-art kjr-art-ph kjr-art-none" data-sz="c" role="img" aria-label="Image could not load"/);
  // no id and a miss are still "no image yet"
  assert.deepEqual(plain(ctx.kjrArtState(single({ tcgdexId: '' }), 'singles')), { state: 'none' });
  // the same answer from a placeholder already on the page, for a single and for a slab
  const slot = placeholder('swsh7-215');
  assert.deepEqual(plain(ctx.kjrSlotState(slot)), { state: 'none', why: 'fail' });
  const app = await loadApp();
  app.ctx.kjrRememberCardImage('swsh7-215', BASE, 'en');
  app.ctx._kjrImgBroken[BASE + '/low.webp'] = true;
  const late = placeholder('swsh7-215');
  onPage(app, late);
  app.ctx.kjrApplyArt(['swsh7-215']);
  assert.ok(isNone(late, FAIL), 'a late fill finds the picture is known broken: the whale, worded as a failure');
  assert.equal(late.inserted.length, 0, 'and draws nothing');
});

for (const mode of ['list', 'grid']) {
  test('art states: a ' + (mode === 'list' ? 'list row' : 'grid tile') + ' wears the look its card is in: loading picture, plain placeholder awaiting a lookup, whale for a miss and for no id', async () => {
    const seed = makeSeed({ singles: [
      single({ id: 's1', name: 'Umbreon VMAX 215/203', tcgdexId: 'swsh7-215' }),   // base known
      single({ id: 's2', name: 'Rayquaza VMAX 218/203', tcgdexId: 'swsh7-218' }),  // a lookup could find it
      single({ id: 's3', name: 'Pikachu 25', tcgdexId: 'zz-miss' }),               // a fresh miss
      single({ id: 's4', name: 'Mew 8', tcgdexId: '' }),                           // nothing to resolve
    ] });
    const { ctx, document } = await loadApp({ seed, localStorage: { kjr_view_singles: mode, kjr_card_images: { 'swsh7-215': BASE, 'zz-miss': { miss: iso(0) } } } });
    ctx.renderSingles();
    const html = document.getElementById(mode === 'list' ? 'singles-body' : 'singles-grid').innerHTML;
    const seg = (id) => { const i = html.indexOf('data-id="' + id + '"'); const j = html.indexOf('data-id="', i + 10); return html.slice(i, j < 0 ? undefined : j); };
    assert.match(seg('s1'), /<span class="kjr-art [^"]*kjr-art-loading" data-sz="[tc]" aria-busy="true"><img class="kjr-card-img"/, 'the known picture is on its way');
    const need = seg('s2');
    assert.match(need, /<span class="kjr-art [^"]*kjr-art-ph" data-sz="[tc]" data-need="1" data-ik="swsh7-218"/);
    assert.doesNotMatch(need.slice(need.indexOf('<span class="kjr-art')).split('</span>')[0], /kjr-art-loading|kjr-art-none|aria-busy/, 'no lookup queued yet: plain');
    for (const id of ['s3', 's4']) {
      assert.match(seg(id), /<span class="kjr-art [^"]*kjr-art-ph kjr-art-none" data-sz="[tc]" role="img" aria-label="No image yet" title="No image yet"><\/span>/, id + ' shows the whale');
    }
    assert.equal((html.match(/kjr-art-none/g) || []).length, 2, 'two whales, and nothing else is one');
  });
}

test('art states: a slab draws the same looks inside its case, in the list thumbnail and on the tile', async () => {
  const slabRow = (o) => Object.assign({ id: 'p1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '1', language: 'EN', costPrice: 1, marketPrice: 2, status: 'Available', notes: '', _updatedAt: new Date().toISOString() }, o);
  const { ctx } = await loadApp({ seed: makeSeed({ slabs: [] }) });
  assert.match(ctx.kjrSlabArtHtml(slabRow({ name: 'Umbreon Custom Card' }), 'thumb'), /class="kjr-art kjr-thumb kjr-thumb-slab kjr-g-psa kjr-art-ph kjr-art-none" data-sz="t" role="img" aria-label="No image yet"/);
  assert.match(ctx.kjrSlabArtHtml(slabRow({ name: 'Umbreon Custom Card' }), 'tile'), /<span class="kjr-art kjr-slab-art kjr-art-ph kjr-art-none" data-sz="c" role="img" aria-label="No image yet"/);
  assert.match(ctx.kjrSlabArtHtml(slabRow(), 'thumb'), /kjr-art-ph" data-sz="t" data-need="1" data-ik="slab:p1"/, 'a slab with a number is a candidate for a lookup');
  ctx.kjrRememberCardImage('swsh7-215', BASE, 'en');
  assert.match(ctx.kjrSlabArtHtml(slabRow({ tcgdexId: 'swsh7-215' }), 'tile'), /<span class="kjr-art kjr-slab-art kjr-art-loading" data-sz="c" aria-busy="true"><img /);
});

// ── the queue gives a slot its look ────────────────────────────────────────────────────────────────────────────────────────────
test('art states: a slot shimmers while its lookup is queued or running, and offline it shows the whale until the lookup starts', async () => {
  const app = await loadApp();
  const { ctx, fetchMock } = app;
  const slot = placeholder('zz-1');
  fetchMock.route('/cards/zz-1', () => new Promise(() => {})); // a lookup that never answers, so "running" lasts
  ctx.navigator.onLine = false;
  assert.equal(ctx.kjrQueueCardImage(job('zz-1'), slot), true, 'queued, though nothing can run offline');
  assert.ok(isNone(slot, NONE), 'offline: the whale, plainly worded');
  assert.ok('data-need' in slot.at, 'and still a candidate');
  ctx.navigator.onLine = true;
  ctx.kjrImgPump();
  assert.ok(isLoading(slot), 'asked now, it shimmers');
  assert.equal(slot.cls.has('kjr-art-ph'), true, 'still no picture drawn');
  // a second slot for the same card joins the lookup in flight and shimmers too
  const twin = placeholder('zz-1');
  assert.equal(ctx.kjrQueueCardImage(job('zz-1'), twin), false);
  assert.ok(isLoading(twin));
});

test('art states: a lookup that ends with no answer leaves the whale worded as a failure, keeps the slot fillable, and a later fill draws it', async () => {
  const app = await loadApp();
  const { ctx, fetchMock } = app;
  const slot = placeholder('zz-2');
  onPage(app, slot);
  fetchMock.route('/cards/zz-2', { status: 503, ok: false, json: {} });
  ctx.kjrQueueCardImage(job('zz-2'), slot);
  assert.ok(isLoading(slot), 'while it runs');
  await drain(app);
  assert.ok(isNone(slot, FAIL), 'a 503 says nothing about the card, nothing is coming until it is asked again: the whale, "could not load"');
  assert.ok('data-need' in slot.at, 'it stays fillable');
  // the price lane learns the card later: the slot draws it
  slot.onInsert = (h) => { assert.match(h, /^<img class="kjr-card-img" src="https:\/\/assets\.tcgdex\.net\/x\/y\/zz-2\/low\.webp"/); };
  ctx.kjrRememberCardImage('zz-2', 'https://assets.tcgdex.net/x/y/zz-2', 'en');
  assert.equal(slot.inserted.length, 1);
  assert.ok(isLoading(slot), 'its picture is now on the way');
  assert.equal(slot.cls.has('kjr-art-ph'), false, 'drawn: no longer a placeholder');
  assert.ok(!('data-need' in slot.at));
  assert.equal('title' in slot.at, false, 'the whale name is gone');
});

test('art states: an answered miss is the plain "no image yet" whale, a cooling-down lookup is the failure one, and neither touches a drawn slot', async () => {
  const app = await loadApp();
  const { ctx, fetchMock } = app;
  const miss = placeholder('zz-3');
  onPage(app, miss);
  fetchMock.route('/cards/zz-3', { status: 404, ok: false, json: {} });
  ctx.kjrQueueCardImage(job('zz-3'), miss);
  await drain(app);
  assert.ok(isNone(miss, NONE), 'a 404 is an answer: this card has no art');
  assert.ok(!('data-need' in miss.at), 'and no lookup can fill it');

  const cooling = placeholder('zz-4');
  ctx._kjrImgCool['zz-4'] = Date.now() + 60000;
  assert.equal(ctx.kjrQueueCardImage(job('zz-4'), cooling), false);
  assert.ok(isNone(cooling, FAIL));

  // a slot drawn since (no data-need, its picture inside) is never given a queue look
  const drawn = artSlot('kjr-art kjr-thumb', {});
  assert.equal(ctx.kjrQueueCardImage(job('zz-5'), drawn), true);
  assert.ok(isLoaded(drawn), 'untouched');
  assert.doesNotThrow(() => ctx.kjrQueueCardImage(job('zz-6')), 'a lookup with no slot at all is still fine');
  assert.doesNotThrow(() => ctx.kjrQueueCardImage(job('zz-7'), { _kjrVis: true }), 'and so is a bare object');
});

test('art states: a slot another lookup is still going to fill is not given the whale when a neighbouring lookup ends', async () => {
  const app = await loadApp();
  const { ctx } = app;
  const slot = placeholder('zz-8');
  onPage(app, slot);
  ctx._kjrImgQ.byKey['zz-8'] = { key: 'zz-8', els: [slot] }; // its own job is queued
  ctx.kjrApplyArt(['zz-8'], true);
  assert.ok(!slot.cls.has('kjr-art-none'), 'its own lookup is still to come');
  delete ctx._kjrImgQ.byKey['zz-8'];
  ctx.kjrApplyArt(['zz-8'], true);
  assert.ok(isNone(slot, FAIL), 'with none left it gives up');
});

// ── a picture arrives, or does not ─────────────────────────────────────────────────────────────────────────────────────────────
test('art states: a picture that arrives leaves the loading look, and the capture-phase listeners are wired like the error one', async () => {
  const { ctx } = await loadApp();
  const slot = artSlot('kjr-art kjr-thumb kjr-art-loading', { 'aria-busy': 'true', 'data-sz': 't' });
  const img = artImg(BASE + '/low.webp', slot);
  ctx.kjrImgOnLoad({ target: img });
  assert.ok(isLoaded(slot), 'no shimmer, no busy flag: the picture fades in (styles.css)');
  assert.equal(ctx._kjrImgSeen[BASE + '/low.webp'], true);
  // not ours, or not a picture: ignored
  const other = artSlot('kjr-art kjr-art-loading', { 'aria-busy': 'true' });
  ctx.kjrImgOnLoad({ target: { tagName: 'IMG', classList: { contains: () => false }, parentNode: other, getAttribute: () => 'x' } });
  ctx.kjrImgOnLoad({ target: { tagName: 'SCRIPT', classList: { contains: () => true }, parentNode: other, getAttribute: () => 'x' } });
  ctx.kjrImgOnLoad(null); ctx.kjrImgOnLoad({});
  assert.ok(other.cls.has('kjr-art-loading'));
  const src = fs.readFileSync(path.join(ROOT, 'features.js'), 'utf8');
  assert.match(src, /document\.addEventListener\('error', kjrImgOnError, true\);\s*document\.addEventListener\('load', kjrImgOnLoad, true\);/, 'load does not bubble, so it is caught in the capture phase like error');
});

test('art states: a picture that fails is retried once as a plain one, then drops to the whale, and offline it is not retried or held against the card', async () => {
  const { ctx } = await loadApp();
  const url = BASE + '/high.webp';
  const slot = artSlot('kjr-art kjr-insp-art kjr-art-loading', { 'aria-busy': 'true', 'data-sz': 'h' });
  const img = artImg(url, slot);
  ctx.kjrImgOnError({ target: img });
  assert.equal('crossorigin' in img.at, false, 'asked again without CORS, in case TCGdex ever stopped sending it');
  assert.equal(img.at.src, url);
  assert.equal(img.removed, false);
  assert.ok(isLoading(slot), 'still on its way');
  assert.equal(ctx._kjrImgBroken[url], undefined);
  ctx.kjrImgOnError({ target: img });
  assert.equal(img.removed, true, 'the second failure is final');
  assert.ok(isNone(slot, FAIL));
  assert.equal(ctx._kjrImgBroken[url], true, 'and is not tried again this session');

  const off = await loadApp();
  off.ctx.navigator.onLine = false;
  const slot2 = artSlot('kjr-art kjr-thumb kjr-art-loading', { 'aria-busy': 'true', 'data-sz': 't' });
  const img2 = artImg(BASE2 + '/low.webp', slot2);
  off.ctx.kjrImgOnError({ target: img2 });
  assert.equal(img2.removed, true, 'offline there is nothing to retry');
  assert.ok(isNone(slot2, FAIL));
  assert.equal(off.ctx._kjrImgBroken[BASE2 + '/low.webp'], undefined, 'a dropped connection is not held against the card');
});

test('art states: a picture the browser already holds shows at once (the render sweep and the late fill check img.complete), and a throwing sweep never breaks a render', async () => {
  const { ctx } = await loadApp();
  const loadingSlot = (src, img) => { const s = artSlot('kjr-art kjr-thumb kjr-art-loading', { 'aria-busy': 'true' }); artImg(src, s, img); return s; };
  const done = loadingSlot(BASE + '/low.webp', { complete: true, naturalWidth: 245 });
  const waiting = loadingSlot(BASE2 + '/low.webp', { complete: false });
  const broken = loadingSlot('https://assets.tcgdex.net/en/x/y/low.webp', { complete: true, naturalWidth: 0 });
  const root = { querySelectorAll: (sel) => (sel === '.kjr-art-loading' ? [done, waiting, broken] : []) };
  assert.equal(ctx.kjrObserveCardImages(root, 'singles'), 0, 'no IntersectionObserver in the sandbox');
  assert.ok(isLoaded(done), 'complete: shown now, not a frame later');
  assert.equal(ctx._kjrImgSeen[BASE + '/low.webp'], true);
  assert.ok(isLoading(waiting), 'still downloading: its load event does the rest');
  assert.ok(isLoading(broken), 'complete but empty is a broken picture: its error event does the rest');
  assert.doesNotThrow(() => ctx.kjrObserveCardImages({ querySelectorAll: () => { throw new Error('boom'); } }, 'singles'));

  // the late fill of a slot whose picture the browser already has
  const slot = placeholder('zz-9');
  slot.onInsert = () => { artImg('https://assets.tcgdex.net/x/y/zz-9/low.webp', slot, { complete: true, naturalWidth: 245 }); };
  const app = await loadApp();
  onPage(app, slot);
  app.ctx.kjrRememberCardImage('zz-9', 'https://assets.tcgdex.net/x/y/zz-9', 'en');
  assert.ok(isLoaded(slot), 'never left shimmering or invisible');
});

// ── lazy pictures near the viewport are woken early ────────────────────────────────────────────────────────────────────────────
test('art states: lazy pictures within 900px of the viewport are told to load, others and hidden ones are left to the browser, each redraw watches afresh', async () => {
  const { ctx } = await loadApp();
  const made = [];
  ctx.IntersectionObserver = class {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.watched = []; this.gone = []; this.disconnected = 0; made.push(this); }
    observe(el) { this.watched.push(el); } unobserve(el) { this.gone.push(el); } disconnect() { this.disconnected++; }
  };
  const lazy = (src) => { const s = artSlot('kjr-art kjr-thumb kjr-art-loading', { 'aria-busy': 'true' }); const i = artImg(src, s); i.at.loading = 'lazy'; return i; };
  const a = lazy(BASE + '/low.webp'), b = lazy(BASE2 + '/low.webp');
  const root = { querySelectorAll: (sel) => (sel === '.kjr-art > img.kjr-card-img[loading="lazy"]' ? [a, b] : []) };
  assert.equal(ctx.kjrObserveCardImages(root, 'singles'), 0, 'no placeholders to look up');
  assert.equal(made.length, 1);
  assert.equal(made[0].opts.rootMargin, '900px 0px');
  assert.deepEqual(made[0].watched, [a.parentNode, b.parentNode], 'it watches the slots');
  made[0].cb([{ target: a.parentNode, isIntersecting: true }, { target: b.parentNode, isIntersecting: false }], made[0]);
  assert.equal(a.at.loading, 'eager', 'inside the margin: load now');
  assert.deepEqual(made[0].gone, [a.parentNode], 'and that slot is not watched again');
  assert.equal(b.at.loading, 'lazy', 'outside it: the browser decides');
  // a redraw replaces the rows: the watch starts afresh on the same observer, another table gets its own
  ctx.kjrObserveCardImages(root, 'singles');
  assert.equal(made.length, 1);
  assert.equal(made[0].disconnected, 1);
  ctx.kjrObserveCardImages(root, 'slabs');
  assert.equal(made.length, 2);
  // nothing lazy on the page (the inspector art is eager), nothing watched
  const quiet = { querySelectorAll: () => [] };
  assert.equal(ctx.kjrObserveCardImages(quiet, 'inspector'), 0);
  assert.equal(made.length, 2);
  // an observer that throws on unobserve cannot stop the picture loading
  const c = lazy(BASE + '/high.webp');
  assert.doesNotThrow(() => ctx.kjrImgOnAhead([{ target: c.parentNode, isIntersecting: true }], { unobserve() { throw new Error('gone'); } }));
  assert.equal(c.at.loading, 'eager');
});

// ── the image map is written once per burst ───────────────────────────────────────────────────────────────────────────────────
test('art map: 30 learned cards cost one write, 500ms after the last, and the map serves from memory meanwhile', async () => {
  const { ctx, localStorage, timers } = await loadApp();
  assert.equal(ctx.KJR_IMG_SAVE_MS, 500);
  let writes = 0;
  const realSet = localStorage.setItem;
  localStorage.setItem = (k, v) => { if (k === 'kjr_card_images') writes++; return realSet.call(localStorage, k, v); };
  const timersBefore = timers.list().length;
  for (let n = 1; n <= 30; n++) ctx.kjrRememberCardImage('zz-' + n, 'https://assets.tcgdex.net/en/x/y/zz-' + n, 'en');
  assert.equal(writes, 0, 'nothing is written per card');
  assert.equal(localStorage.getItem('kjr_card_images'), null);
  assert.equal(ctx.kjrCardImageBase('zz-30'), 'https://assets.tcgdex.net/en/x/y/zz-30', 'memory answers meanwhile');
  assert.equal(timers.list().length - timersBefore, 1, 'one timer arms the whole burst');
  assert.equal(timers.pending.get(ctx._kjrImgSaveTimer).delay, 500);
  timers.invoke(ctx._kjrImgSaveTimer);
  assert.equal(writes, 1);
  assert.equal(Object.keys(JSON.parse(localStorage.getItem('kjr_card_images'))).length, 30, 'every card of the burst is in it');
  assert.equal(ctx._kjrImgSaveTimer, 0);
  assert.equal(ctx._kjrImgDirty, false);
  assert.equal(ctx.kjrImgMapFlush(), false, 'nothing new: a flush writes nothing');
  assert.equal(writes, 1);
  ctx.kjrRememberCardImageMiss('zz-99');
  assert.ok(ctx._kjrImgSaveTimer > 0, 'the next change arms a new timer');
  ctx.kjrRememberCardImage('zz-98', 'https://assets.tcgdex.net/en/x/y/zz-98', 'en');
  assert.equal(timers.list().length - timersBefore, 1, 'and a second change inside it shares it');
});

test('art map: the pending write is flushed at once on pagehide and when the tab goes hidden, so nothing waits on the timer past that moment', async () => {
  const { ctx, localStorage, timers } = await loadApp();
  const stored = () => (localStorage.getItem('kjr_card_images') ? Object.keys(JSON.parse(localStorage.getItem('kjr_card_images'))) : []);
  ctx.kjrRememberCardImage('zz-1', 'https://assets.tcgdex.net/en/x/y/zz-1', 'en');
  assert.deepEqual(stored(), []);
  ctx.dispatchEvent({ type: 'pagehide' });
  assert.deepEqual(stored(), ['zz-1'], 'pagehide flushes');
  assert.equal(ctx._kjrImgSaveTimer, 0, 'and cancels the timer');
  assert.equal(timers.pending.has(1_000_000), false);

  ctx.kjrRememberCardImage('zz-2', 'https://assets.tcgdex.net/en/x/y/zz-2', 'en');
  ctx.document.visibilityState = 'visible';
  ctx.kjrImgOnVisibility();
  assert.deepEqual(stored(), ['zz-1'], 'visible: nothing yet');
  ctx.document.visibilityState = 'hidden';
  ctx.kjrImgOnVisibility();
  assert.deepEqual(stored().sort(), ['zz-1', 'zz-2'], 'hidden: flushed');
  const src = fs.readFileSync(path.join(ROOT, 'features.js'), 'utf8');
  assert.match(src, /document\.addEventListener\('visibilitychange', kjrImgOnVisibility\)/);
  assert.match(src, /window\.addEventListener\('pagehide', function \(\) \{ kjrImgMapFlush\(\); \}\)/);
});

test('art map: another tab writing the map while this one holds unwritten entries loses nothing on either side, and a miss never beats their picture', async () => {
  const { ctx, localStorage } = await loadApp();
  ctx.kjrRememberCardImage('mine-1', 'https://assets.tcgdex.net/en/x/y/mine-1', 'en');
  ctx.kjrRememberCardImageMiss('shared-1');
  const theirs = { 'theirs-1': 'https://assets.tcgdex.net/en/x/y/theirs-1', 'shared-1': 'https://assets.tcgdex.net/en/x/y/shared-1', 'theirs-miss': { miss: iso(0) } };
  ctx.dispatchEvent({ type: 'storage', key: 'kjr_card_images', newValue: JSON.stringify(theirs) });
  assert.equal(ctx.kjrCardImageBase('mine-1'), 'https://assets.tcgdex.net/en/x/y/mine-1', 'our unwritten answer survives');
  assert.equal(ctx.kjrCardImageBase('theirs-1'), 'https://assets.tcgdex.net/en/x/y/theirs-1', 'theirs arrives');
  assert.equal(ctx.kjrCardImageBase('shared-1'), 'https://assets.tcgdex.net/en/x/y/shared-1', 'our miss does not replace their picture');
  assert.equal(ctx.kjrCardImageMissed('theirs-miss'), true);
  ctx.kjrImgMapFlush();
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem('kjr_card_images'))).sort(), ['mine-1', 'shared-1', 'theirs-1', 'theirs-miss']);
  // nothing pending: the memory is dropped and read again, as before
  ctx.dispatchEvent({ type: 'storage', key: 'kjr_card_images', newValue: JSON.stringify({ 'only-theirs': 'https://assets.tcgdex.net/en/x/y/only-theirs' }) });
  assert.equal(ctx._kjrImgMem, null);
  // a hostile or damaged value from the other side never throws or poisons the prototype
  ctx.kjrRememberCardImage('mine-2', 'https://assets.tcgdex.net/en/x/y/mine-2', 'en');
  for (const junk of ['{not json', '[]', 'null', '"x"', '{"__proto__":{"miss":"2026-01-01"}}']) {
    assert.doesNotThrow(() => ctx.dispatchEvent({ type: 'storage', key: 'kjr_card_images', newValue: junk }), junk);
    assert.equal(ctx.kjrCardImageBase('mine-2'), 'https://assets.tcgdex.net/en/x/y/mine-2', 'ours survives ' + junk);
  }
  assert.equal({}.miss, undefined, 'Object.prototype is untouched');
});

test('art map: a flush never writes an empty map over a good one, and blocked storage keeps the entries for a later flush', async () => {
  const { ctx, localStorage } = await loadApp({ localStorage: { kjr_card_images: { 'old-1': 'https://assets.tcgdex.net/en/x/y/old-1' } } });
  ctx.kjrRememberCardImage('new-1', 'https://assets.tcgdex.net/en/x/y/new-1', 'en');
  ctx._kjrImgMem = null; // as if a storage event had dropped the memory
  assert.equal(ctx.kjrImgMapFlush(), false);
  assert.deepEqual(Object.keys(JSON.parse(localStorage.getItem('kjr_card_images'))), ['old-1'], 'the stored map is untouched, not replaced by {}');

  ctx.kjrRememberCardImage('new-2', 'https://assets.tcgdex.net/en/x/y/new-2', 'en');
  const realSet = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.doesNotThrow(() => ctx.kjrImgMapFlush());
  assert.equal(ctx.kjrImgMapFlush(), false);
  assert.equal(ctx._kjrImgDirty, true, 'still owed');
  assert.equal(ctx.kjrCardImageBase('new-2'), 'https://assets.tcgdex.net/en/x/y/new-2', 'served from memory meanwhile');
  localStorage.setItem = realSet;
  assert.equal(ctx.kjrImgMapFlush(), true);
  assert.ok('new-2' in JSON.parse(localStorage.getItem('kjr_card_images')), 'written once storage works again');
});

test('art map: a lookup that learns a card still draws it at once, the write being late changes nothing on screen', async () => {
  const app = await loadApp();
  const { ctx, fetchMock, localStorage } = app;
  const slot = placeholder('zz-1');
  onPage(app, slot);
  fetchMock.route('/cards/zz-1', () => jsonResponse({ id: 'zz-1', image: 'https://assets.tcgdex.net/en/x/y/zz-1', pricing: {} }));
  ctx.kjrQueueCardImage(job('zz-1'), slot);
  await drain(app);
  assert.equal(slot.inserted.length, 1, 'drawn');
  assert.equal(localStorage.getItem('kjr_card_images'), null, 'not written yet');
  ctx.kjrImgMapFlush();
  assert.ok(JSON.parse(localStorage.getItem('kjr_card_images'))['zz-1']);
});

// ── the styles, pinned as text (tests/preview-server.cjs and a browser pass prove them applied) ──────────────────────────────
test('art css: three looks in the art section, tokens only, the whale from the app icon, the outline only on a plain placeholder', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const start = css.indexOf('/* Card image (any size) and its three looks (v3.83).');
  const end = css.indexOf('/* List view: the thumbnail lives inside the name cell');
  assert.ok(start > 0 && end > start, 'the art look block is in place');
  const block = css.slice(start, end);
  assert.doesNotMatch(block.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no raw colour in the new rules, existing tokens only');
  assert.match(block, /\.kjr-card-img\{[^}]*transition:opacity 0\.18s ease-out\}/, 'the picture fades in over about 180ms');
  assert.match(block, /\.kjr-art-loading \.kjr-card-img\{opacity:0;animation:kjr-art-reveal 0s linear 10s forwards\}/, 'the picture waits, with a backstop so it is never stuck invisible');
  assert.match(block, /@keyframes kjr-art-reveal\{to\{opacity:1\}\}/);
  assert.match(block, /\.kjr-art\.kjr-art-loading\{background:var\(--bg3\)\}/);
  assert.match(block, /\.kjr-art-loading::after\{[^}]*linear-gradient\(100deg,transparent 20%,color-mix\(in srgb,var\(--bg4\),var\(--text\) 5%\) 50%,transparent 80%\)[^}]*transform:translateX\(-100%\);animation:kjr-art-sweep 1\.4s ease-in-out infinite\}/, 'a band of --bg4 with a touch of --text sweeps on the compositor');
  assert.match(block, /@keyframes kjr-art-sweep\{to\{transform:translateX\(100%\)\}\}/);
  assert.match(block, /\.kjr-art-none::after\{[^}]*url\("Assets\/whale-icon-192\.png"\) center\/56% auto no-repeat;opacity:0\.3\}/, 'the whale, about half the slot, dimmed');
  assert.match(block, /html\.light \.kjr-art-none::after\{opacity:0\.4;filter:brightness\(0\.55\) saturate\(1\.4\)\}/, 'and darker in the light theme');
  assert.match(block, /\.kjr-art-ph:not\(\.kjr-art-loading\):not\(\.kjr-art-none\)::after\{[^}]*inset:6px;border:1px solid var\(--border2\)/, 'the old frame is only for a plain placeholder');
  assert.doesNotMatch(css, /\.kjr-art-ph::after\{/, 'no unconditional frame rule is left to beat the whale or the sweep');
  // sizes: the thumbnail and the slab art take their own ratios, the frame variants are guarded the same way
  assert.match(css, /\.kjr-thumb\.kjr-art-ph:not\(\.kjr-art-loading\):not\(\.kjr-art-none\)::after\{inset:3px;border-radius:2px\}/);
  assert.match(css, /\.kjr-thumb\.kjr-art-none::after\{background-size:90% auto\}/);
  assert.match(css, /\.kjr-slab-art\.kjr-art-ph:not\(\.kjr-art-loading\):not\(\.kjr-art-none\)::after\{inset:4px;border-radius:3px\}/);
  assert.match(css, /\.kjr-slab-art\.kjr-art-none::after\{background-size:72% auto\}/);
});

test('art css: reduced motion gives a static loading surface and no fade, and the phone override comes after the base thumbnail rule', () => {
  const css = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const rm = css.match(/@media\(prefers-reduced-motion:reduce\)\{\s*\.kjr-tile-art,\.kjr-slab,\.kjr-view-btn\{transition:none\}[\s\S]*?\n\}/);
  assert.ok(rm, 'the art reduced-motion block');
  assert.match(rm[0], /\.kjr-card-img\{transition:none\}/);
  assert.match(rm[0], /\.kjr-art\.kjr-art-loading\{background:var\(--bg4\)\}/, 'flat and a step lighter, still no whale, so it never reads as "no art"');
  assert.match(rm[0], /\.kjr-art-loading::after\{display:none\}/, 'no sweep');
  const base = css.indexOf('.kjr-thumb.kjr-art-none::after{background-size:90% auto}');
  const phone = css.indexOf('.kjr-thumb.kjr-art-none::after{background-size:104% auto}');
  assert.ok(base > 0 && phone > base, 'the phone ratio is written after the base ratio, so the media rule is not beaten by source order');
  const blockStart = css.lastIndexOf('@media(max-width:600px){', phone);
  assert.ok(blockStart > base && css.slice(blockStart, phone).includes('.kjr-thumb{width:20px;height:28px;border-radius:3px}'), 'inside the phones block that shrinks the thumbnail to 20x28');
});

test('art css: the whale file is the same-origin app icon and the service worker precaches it, so the no-art look works offline', () => {
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  const core = sw.match(/^const CORE = \[.*\];$/m);
  assert.ok(core && core[0].includes("'./Assets/whale-icon-192.png'"), 'precached in CORE');
  assert.ok(fs.statSync(path.join(ROOT, 'Assets/whale-icon-192.png')).size < 60000, 'a small file');
  const server = require('./preview-server.cjs');
  assert.equal(server.STATIC_FILES['/Assets/whale-icon-192.png'], 'Assets/whale-icon-192.png', 'the browser fixture serves it');
});

test('art markup: every picture asks for CORS and none carries an inline handler, and the head preconnects to both TCGdex hosts', async () => {
  const { ctx } = await loadApp();
  for (const sz of ['t', 'c', 'h']) {
    const tag = ctx.kjrImgTag(BASE, sz);
    assert.match(tag, / crossorigin="anonymous">$/);
    assert.doesNotMatch(tag, /\son[a-z]+=/i);
    assert.match(tag, / referrerpolicy="no-referrer" /);
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes('<link rel="preconnect" href="https://assets.tcgdex.net" crossorigin>'));
  assert.ok(head.includes('<link rel="preconnect" href="https://api.tcgdex.net" crossorigin>'));
});

test('art states: the markup the states draw is escaped, a hostile card id cannot break out of the placeholder', async () => {
  const { ctx } = await loadApp();
  const html = ctx.kjrArtSlot({ state: 'need', key: 'x"><b>', tcg: 'x"><b>', lang: 'e"n' }, 't', 'kjr-thumb');
  assert.ok(!html.includes('<b>'));
  assert.match(html, /data-ik="x&quot;&gt;&lt;b&gt;"/);
  assert.equal(plain(ctx.kjrArtState(single({ tcgdexId: '' }), 'singles')).state, 'none');
});
