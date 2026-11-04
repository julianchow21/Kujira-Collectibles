'use strict';
// v3.80: card art for Japanese cards and slabs. TCGdex's Japanese catalogue stores Japanese names, so an English name finds nothing on
// /ja/. Since v4.1 the matching (the katakana species name, the exact localId, the set narrowing, a unique candidate only) is the
// Worker's GET /resolve, tested in its own repo. These tests pin the browser's side: what kjrImgRun asks the Worker (the row name, ja,
// the set, art=1), what it does with each answer (a hit is written once and marked dirty, a definitive miss is a 7-day miss, "could
// not tell" is neither), the row changing under a lookup, and the set list the Unmatched cards picker still reads itself. Art only:
// the lookup makes zero price calls, and an id a row now carries never makes TCGdex a price source (v3.85: the price comes from PPT's
// Japanese catalogue, see the last tests below and tests/ppt-japanese.test.js).
// fetch is stubbed (tests/harness.js createFetchMock), nothing here reaches a real API. The /ja/sets list is shaped like the live one
// captured on 15/10/2026.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadApp, makeSeed, jsonResponse, plain, ROOT } = require('./harness.js');

const SPECIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'Assets', 'species-ja.json'), 'utf8'));
const BASE_006 = 'https://assets.tcgdex.net/ja/SV/SV2a/006';

// The Worker's /resolve hit for "Charizard ex 006" JP in set 151 (from the live /ja/ search of 15/10/2026, which returned the card with
// seven loose matches the Worker cuts away)
const HIT = { id: 'SV2a-006', name: 'リザードンex' };
const resolveUrl = (app, name, lang, set) => app.ctx.SB_WORKER_ORIGIN + '/resolve?name=' + name + '&lang=' + lang + (set ? '&set=' + set : '') + '&art=1';
// GET /ja/sets, a subset with the extra fields the live list carries (only id and name are kept)
const LIVE_JA_SETS = [
  { id: 'SV2a', name: 'ポケモンカード151', cardCount: { total: 210, official: 165 } },
  { id: 'SV3', name: '黒炎の支配者', cardCount: { total: 141, official: 108 } },
  { id: 'SV3a', name: 'レイジングサーフ', cardCount: { total: 66, official: 62 } },
  { id: 'SV4a', name: 'レイジングサーフ', cardCount: { total: 320, official: 190 } },
  { id: 'SV8', name: '超電ブレイカー', cardCount: { total: 106, official: 106 } },
  { id: 'SM12a', name: 'TAG TEAM GX タッグオールスターズ', cardCount: { total: 237, official: 173 } },
  { id: 'M2', name: 'インフェルノX', cardCount: { total: 116, official: 80 } },
  { id: 'SM1+', name: 'サン＆ムーン', cardCount: { total: 51, official: 51 } },
];
const DETAIL_006 = { id: 'SV2a-006', localId: '006', name: 'リザードンex', image: BASE_006, set: { id: 'SV2a', name: 'ポケモンカード151' }, pricing: { cardmarket: { avg: 2.2 } } };

const jp = (o) => Object.assign({}, makeSeed().singles[0], { id: 'j1', name: 'Charizard ex 006', set: '151', language: 'JP', tcgdexId: '', marketPrice: 30, costPrice: 12 }, o);
const jpSlab = (o) => Object.assign({
  id: 'p1', name: 'Charizard ex 006', set: '151', grader: 'PSA', grade: '10', certNo: '12345678', rank: '', language: 'JP', costPrice: 90, marketPrice: 140,
  listPrice: '', dateListed: '3 Jul 2026', status: 'Available', notes: '', priceAlert: '', _updatedAt: new Date().toISOString(),
}, o);
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
const DAY = 86400000;

// the harness never fires timers on its own, so run just the art queue's 150ms gap (never timers.flush(), it would fire the app's own)
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

// a placeholder already on the page, the way kjrArtSlot draws one for a single with no id yet
function singleSlot(id, sz) {
  const a = { 'data-need': '1', 'data-ik': 'single:' + id, 'data-single': id, 'data-lg': 'ja', 'data-sz': sz || 'c' };
  const cls = new Set(['kjr-art', 'kjr-art-ph']);
  return {
    inserted: [], _kjrVis: true, isConnected: true,
    getAttribute: (k) => (k in a ? a[k] : null),
    hasAttribute: (k) => k in a,
    removeAttribute: (k) => { delete a[k]; },
    classList: { remove: (c) => cls.delete(c), add: (c) => cls.add(c), contains: (c) => cls.has(c) },
    insertAdjacentHTML(pos, h) { this.inserted.push(h); },
  };
}

// loadApp + the routes a Japanese lookup uses. Every route is a function, so tests can change what it answers.
async function setup(rows, extra) {
  const o = Object.assign({ search: HIT, sets: LIVE_JA_SETS, species: SPECIES, detail: DETAIL_006 }, extra || {});
  const seed = makeSeed({ singles: (rows && rows.singles) || [jp()], slabs: (rows && rows.slabs) || [] });
  // jaLane: the Japanese price lane is forced OFF unless a test asks for it (the constant PPT_JA_LANE_ENABLED is true since v3.89), the pricing tests at the end say which state they mean
  const app = await loadApp(Object.assign({ seed, jaLane: !!o.jaLane }, o.localStorage ? { localStorage: o.localStorage } : {}));
  app.fetchMock.calls.length = 0;
  app.route = {
    species: () => jsonResponse(o.species),
    search: () => jsonResponse(o.search), // the Worker's /resolve answer
    sets: () => jsonResponse(o.sets),
    detail: () => jsonResponse(o.detail),
  };
  app.fetchMock.route('species-ja.json', (u, f) => app.route.species(u, f));
  app.fetchMock.route('/resolve?', (u, f) => app.route.search(u, f));
  app.fetchMock.route('/ja/sets', (u, f) => app.route.sets(u, f));
  app.fetchMock.route('/ja/cards/', (u, f) => app.route.detail(u, f));
  app.urls = () => app.fetchMock.calls.map((c) => decodeURIComponent(c.url));
  app.tcgdex = () => app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net') || c.url.includes('/resolve?')); // TCGdex, and the Worker's matcher
  app.single = (id) => app.ctx.DB.singles.find((r) => r.id === id);
  app.slab = (id) => app.ctx.DB.slabs.find((r) => r.id === id);
  app.marks = [];
  app.saves = { n: 0 };
  const realMark = app.ctx.markDirty, realSave = app.ctx.saveData;
  app.ctx.markDirty = (...a) => { app.marks.push(a); return realMark.apply(app.ctx, a); };
  app.ctx.saveData = (...a) => { app.saves.n++; return realSave.apply(app.ctx, a); };
  app.run = async (job) => { const queued = app.ctx.kjrQueueCardImage(job); await drain(app); return queued; };
  app.runSingle = (id) => app.run({ key: 'single:' + id, single: id, lang: 'ja' });
  app.runSlab = (id) => app.run({ key: 'slab:' + id, slab: id, lang: 'ja' });
  app.links = () => JSON.parse(app.localStorage.getItem('kjr_slab_card_ids') || '{}');
  return app;
}

// ── the main path ───────────────────────────────────────────────────────────────────────────────────
test('art-ja: "Charizard ex 006" JP with set 151 resolves to SV2a-006, the id is written once and marked dirty once', async () => {
  for (const name of ['Charizard ex 006', 'Charizard ex 006 JP']) {
    const app = await setup({ singles: [jp({ name })] });
    const before = plain(app.single('j1'));
    assert.equal(await app.runSingle('j1'), true);
    const row = app.single('j1');
    assert.equal(row.tcgdexId, 'SV2a-006', name + ': the Worker\'s hit');
    assert.equal(row._tcgdexResolvedName, 'リザードンex', 'the local "Resolved to" note the edit modal shows');
    assert.deepEqual(plain(app.marks), [['singles', 'j1']], 'markDirty once, for that row');
    assert.equal(app.saves.n, 1, 'saved once');
    assert.equal(app.ctx._dirty.singles.has('j1'), true, 'and it is in the dirty queue, so it syncs');
    // nothing else on the row moved
    for (const k of Object.keys(before)) if (k !== 'tcgdexId') assert.deepEqual(plain(row[k]), before[k], k + ' untouched');
    assert.deepEqual(Object.keys(row).filter((k) => !(k in before)).sort(), ['_tcgdexResolvedName'], 'the only new key besides the id is the local note');

    const urls = app.urls();
    assert.equal(urls[0], resolveUrl(app, name, 'ja', '151'), 'the Worker is asked with the row name, its language, its set and the art flag');
    assert.equal(urls[1], 'https://api.tcgdex.net/v2/ja/cards/SV2a-006', 'then the card itself, on /ja/');
    assert.equal(urls.length, 2, 'no species map and no set list in the browser');
    assert.equal(app.ctx.kjrCardImageBase('SV2a-006', 'ja'), BASE_006, 'the image base is keyed per language');
    assert.equal(app.ctx.kjrCardImageBase('SV2a-006', 'en'), '', 'and never lands under the English key');
    const st = app.ctx.kjrArtState(row, 'singles');
    assert.deepEqual(plain(st), { state: 'hit', base: BASE_006, key: 'ja:SV2a-006' });

    // asking again does nothing: no lookup, no second write
    assert.equal(app.ctx.kjrQueueCardImage({ key: 'single:j1', single: 'j1', lang: 'ja' }), false);
    await drain(app);
    assert.equal(app.marks.length, 1);
    assert.equal(app.urls().length, 2);
  }
});

test('art-ja: the late fill draws the image on the placeholder the row had, through its data attributes alone', async () => {
  const app = await setup({ singles: [jp()] });
  const slot = singleSlot('j1');
  app.document.querySelectorAll = (sel) => (sel === '.kjr-art[data-need]' ? [slot] : []);
  assert.deepEqual(plain(app.ctx.kjrSlotState(slot)), { state: 'need' }, 'before the lookup: a lookup could still fill it');
  assert.deepEqual(plain(app.ctx.kjrImgJobFromEl(slot)), { key: 'single:j1', tcg: '', slab: '', single: 'j1', lang: 'ja' });
  app.ctx.kjrQueueCardImage(app.ctx.kjrImgJobFromEl(slot), slot);
  await drain(app);
  assert.equal(slot.inserted.length, 1);
  assert.match(slot.inserted[0], /<img class="kjr-card-img" src="https:\/\/assets\.tcgdex\.net\/ja\/SV\/SV2a\/006\/low\.webp" width="245" height="337"/);
  assert.equal(slot.hasAttribute('data-need'), false, 'it is not asked about again');
  assert.equal(slot.classList.contains('kjr-art-ph'), false);
  // a slot whose row is gone stays blank, and a row with a fresh miss asks for nothing
  assert.deepEqual(plain(app.ctx.kjrSlotState(singleSlot('nobody'))), { state: 'none' });
});

test('art-ja: a placeholder carries the row id for the lookup, escaped, and rendering never fetches', async () => {
  const hostile = 'x"><b>';
  const app = await setup({ singles: [jp({ id: hostile }), jp({ id: 'j2', name: 'Umbreon Custom Card' }), jp({ id: 'j3', type: 'sealed', name: 'Charizard ex Box 6' }), jp({ id: 'j4', language: 'CN' }), jp({ id: 'j5', language: 'EN' })] });
  const rows = app.ctx.DB.singles;
  const html = app.ctx.kjrThumbHtml(rows[0], 'singles');
  assert.match(html, /^<span class="kjr-art kjr-thumb kjr-art-ph" data-sz="t" data-need="1" data-ik="single:x&quot;&gt;&lt;b&gt;" data-lg="ja" data-single="x&quot;&gt;&lt;b&gt;"><\/span>$/);
  assert.ok(!html.includes('<b>'), 'no raw tag from the id');
  assert.match(app.ctx.kjrTileHtml(rows[0], 'singles', false), /data-single="x&quot;&gt;&lt;b&gt;"/, 'tiles and the overview share the slot');
  const none = (r) => assert.deepEqual(plain(app.ctx.kjrArtState(r, 'singles')), { state: 'none' }, r.id);
  none(rows[1]); // no card number: nothing to resolve
  none(rows[2]); // a sealed product has no card number to look up
  none(rows[3]); // Chinese is out of scope
  none(rows[4]); // English singles keep today's path, their id comes from the price lane
  // list and grid render without one request
  for (const mode of ['list', 'grid']) {
    app.localStorage.setItem('kjr_view_singles', mode);
    app.fetchMock.calls.length = 0;
    app.ctx.renderSingles();
    await app.settle();
    assert.equal(app.fetchMock.calls.length, 0, mode + ' render fired a fetch: ' + app.urls().join(', '));
  }
  assert.match(app.document.getElementById('singles-grid').innerHTML, /data-single="x&quot;&gt;&lt;b&gt;"/, 'the placeholder is in the grid, escaped');
});

// ── ambiguity and misses ────────────────────────────────────────────────────────────────────────────
test('art-ja: the Worker\'s definitive miss (two candidates and no set to tell them apart) stays unresolved, a miss is cached, nothing is written', async () => {
  const app = await setup({ singles: [jp({ set: '' })] }, { search: { id: null } });
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, '', 'never a guessed id');
  assert.equal(app.marks.length, 0);
  assert.equal(app.saves.n, 0);
  assert.equal(app.urls().filter((u) => u.includes('/ja/cards/')).length, 0, 'no card is fetched');
  assert.equal(app.urls().filter((u) => u.endsWith('/ja/sets') || u.includes('species-ja')).length, 0, 'the browser reads no set list and no species map');
  assert.deepEqual(app.urls(), [resolveUrl(app, 'Charizard ex 006', 'ja', '')], 'one question to the Worker, with no set');
  assert.deepEqual(plain(app.links()), { 's:j1': { miss: iso(0), n: 'Charizard ex 006|ja' } }, 'a 7-day miss, kept with the signature it was looked up for');
  assert.deepEqual(plain(app.ctx.kjrArtState(app.single('j1'), 'singles')), { state: 'none' }, 'the placeholder stays');
  // not looked up again while the miss is fresh, however often the row is drawn
  const calls = app.fetchMock.calls.length;
  assert.equal(app.ctx.kjrQueueCardImage({ key: 'single:j1', single: 'j1', lang: 'ja' }), false);
  assert.equal(app.fetchMock.calls.length, calls);
  // an edit changes the signature: the old miss no longer counts, the row is asked again
  app.single('j1').set = 'SV2a';
  assert.equal(app.ctx.kjrArtState(app.single('j1'), 'singles').state, 'need');
  // and a miss older than a week expires on its own
  const old = app.links(); old['s:j1'] = { miss: iso(8), n: 'Charizard ex 006|ja|set:SV2a' };
  app.localStorage.setItem('kjr_slab_card_ids', JSON.stringify(old)); app.ctx._kjrSlabMem = null;
  assert.equal(app.ctx.kjrArtState(app.single('j1'), 'singles').state, 'need');
});

test('art-ja: a row Dealer Desk controls is never written by art, it stays a placeholder', async () => {
  const app = await setup({ singles: [jp({ dealerOwnerId: 'owner-1' }), jp({ id: 'j2' })] });
  assert.equal(app.ctx.kjrDealerControlledRow('singles', app.single('j1')), true, 'precondition: the app sees it as Dealer Desk owned');
  assert.deepEqual(plain(app.ctx.kjrArtState(app.single('j1'), 'singles')), { state: 'none' }, 'no lookup is even asked for');
  assert.equal(app.ctx.kjrArtState(app.single('j2'), 'singles').state, 'need');
  await app.runSingle('j1');
  assert.equal(app.fetchMock.calls.length, 0, 'nothing requested');
  assert.equal(app.single('j1').tcgdexId, '');
  assert.equal(app.marks.length, 0);
  // an id it already has still draws its art
  app.single('j1').tcgdexId = 'SV2a-006';
  app.ctx.kjrRememberCardImage('SV2a-006', BASE_006, 'ja');
  assert.equal(app.ctx.kjrArtState(app.single('j1'), 'singles').state, 'hit');
  // a row that becomes Dealer Desk owned while its lookup runs (a sync pull) is dropped, not written
  const late = await setup({ singles: [jp()] });
  late.route.search = () => { late.single('j1').dealerCostBasis = 12; return jsonResponse(HIT); };
  await late.runSingle('j1');
  assert.equal(late.single('j1').tcgdexId, '');
  assert.equal(late.marks.length, 0);
  assert.equal(late.localStorage.getItem('kjr_slab_card_ids'), null, 'and no miss for it');
});

test('art-ja: while the edit dialog is open on a row the id waits, so the dialog\'s save is not refused as stale', async () => {
  const app = await setup({ singles: [jp(), jp({ id: 'j2' })] });
  app.document.getElementById('modal-single').open = true;
  app.document.getElementById('ms-id').value = 'j1';
  assert.equal(app.ctx.kjrSingleEditOpen('j1'), true);
  assert.equal(app.ctx.kjrSingleEditOpen('j2'), false, 'only the row the dialog is on');
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, '', 'nothing written under the dialog');
  assert.equal(app.marks.length, 0);
  assert.equal(app.localStorage.getItem('kjr_slab_card_ids'), null, 'and not a miss either');
  assert.ok(app.ctx._kjrImgCool['single:j1'] > Date.now());
  assert.equal(app.ctx._kjrImgQ.fails, 0);
  await app.runSingle('j2');
  assert.equal(app.single('j2').tcgdexId, 'SV2a-006', 'another row is not held up');
  // closed, and a minute on: it is written
  app.document.getElementById('modal-single').open = false;
  delete app.ctx._kjrImgCool['single:j1'];
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, 'SV2a-006');
  assert.deepEqual(plain(app.marks), [['singles', 'j2'], ['singles', 'j1']]);
});

// Found by running the resolver against the live API: "Umbreon VMAX 215/203" (an English number on a Japanese row) matched exactly one
// card numbered 215 with Umbreon in its name, the Tag Team "ブラッキー&ダークライGX" (SM12a-215), which is another card entirely.
// ── numbers ─────────────────────────────────────────────────────────────────────────────────────────
test('art-ja: two numbers compare as numbers ("6" is "006"), anything else must match exactly ("TG11")', async () => {
  const { ctx } = await loadApp();
  const m = ctx._kjrLocalIdMatches;
  for (const [a, b] of [['006', '6'], ['6', '006'], ['06', '6'], ['006', '006'], ['0', '000'], ['TG11', 'TG11'], ['tg11', 'TG11']]) assert.equal(m(a, b), true, a + ' vs ' + b);
  for (const [a, b] of [['007', '6'], ['016', '6'], ['66', '6'], ['TG111', 'TG11'], ['TG011', 'TG11'], ['TG01', 'TG11'], ['11', 'TG11'], ['TG11', '11'], ['067a', '67'], ['', '6'], [null, '6'], [undefined, '6'], ['6', '']]) assert.equal(m(a, b), false, a + ' vs ' + b);
});

// ── failure handling ────────────────────────────────────────────────────────────────────────────────
test('art-ja: the Worker\'s species map or set list that would not load (why map, sets) degrades to the placeholder, no miss, no queue pause', async () => {
  for (const why of ['map', 'sets']) {
    const app = await setup({ singles: [jp()] }, { search: { id: null, transient: true, why } });
    const report = {};
    let id;
    await assert.doesNotReject(async () => { id = await app.ctx.resolveTcgdexId({ name: 'Charizard ex 006', language: 'JP' }, { art: true, set: '151', report }); }, why);
    assert.equal(id, null, why);
    assert.deepEqual(plain(report), { transient: true, why }, why + ': "could not tell", with the Worker\'s why');

    await app.runSingle('j1');
    assert.equal(app.single('j1').tcgdexId, '', why);
    assert.equal(app.marks.length, 0, why);
    assert.equal(app.localStorage.getItem('kjr_slab_card_ids'), null, why + ': no 7-day miss, so it is asked again');
    assert.equal(app.ctx.kjrArtState(app.single('j1'), 'singles').state, 'need', why + ': still a candidate');
    assert.equal(app.ctx._kjrImgQ.fails, 0, why + ': the Worker\'s own data failing does not pause the queue for everyone');
    assert.ok(app.ctx._kjrImgCool['single:j1'] > Date.now(), why + ': this row waits a minute');
    // a minute later the Worker has its map again: the row resolves
    delete app.ctx._kjrImgCool['single:j1'];
    app.route.search = () => jsonResponse(HIT);
    await app.runSingle('j1');
    assert.equal(app.single('j1').tcgdexId, 'SV2a-006', why + ': it recovers within the session');
  }
});

test('art-ja: a Worker or TCGdex failure or an offline lookup is "could not tell", never a 7-day miss', async () => {
  for (const [label, fail] of [
    ['Worker HTTP 500', (app) => { app.route.search = () => jsonResponse({}, 500); }],
    ['Worker HTTP 404 (the route not deployed yet)', (app) => { app.route.search = () => jsonResponse({}, 404); }],
    ['fetch rejects', (app) => { app.route.search = () => { throw new TypeError('offline'); }; }],
    ['a body that is not an answer', (app) => { app.route.search = () => jsonResponse({ error: 'x' }); }],
    ['TCGdex 503 behind the Worker', (app) => { app.route.search = () => jsonResponse({ id: null, transient: true, why: 'net', status: 503 }); }],
  ]) {
    const app = await setup({ singles: [jp()] });
    fail(app);
    await app.runSingle('j1');
    assert.equal(app.single('j1').tcgdexId, '', label);
    assert.equal(app.localStorage.getItem('kjr_slab_card_ids'), null, label + ': no miss recorded');
    assert.equal(app.ctx.kjrArtState(app.single('j1'), 'singles').state, 'need', label);
    assert.ok(app.ctx._kjrImgCool['single:j1'] > Date.now(), label + ': cooled down for a minute');
    assert.equal(app.ctx._kjrImgQ.fails, 1, label + ': counts toward the queue pause like any failed lookup');
    assert.equal(app.ctx.kjrQueueCardImage({ key: 'single:j1', single: 'j1', lang: 'ja' }), false, label + ': not retried at once');
  }
  const off = await setup({ singles: [jp()] });
  off.ctx.navigator.onLine = false;
  await off.runSingle('j1');
  assert.equal(off.tcgdex().length, 0, 'offline: nothing is requested');
  assert.equal(off.ctx.kjrArtState(off.single('j1'), 'singles').state, 'need');
  // offline in the middle of a lookup: resolveTcgdexId swallows the error, onLine is how the run tells
  const mid = await setup({ singles: [jp()] });
  mid.route.search = () => { mid.ctx.navigator.onLine = false; throw new TypeError('offline'); };
  await mid.runSingle('j1');
  assert.equal(mid.localStorage.getItem('kjr_slab_card_ids'), null);
});

test('art-ja: a card with no image, or a 404 on its page, shows the placeholder and the id the search found is kept', async () => {
  const app = await setup({ singles: [jp()] }, { detail: { id: 'SV2a-006', name: 'リザードンex' } }); // no image field
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, 'SV2a-006', 'the id is right even if the image is not there');
  assert.equal(app.ctx.kjrCardImageMissed('SV2a-006', 'ja'), true);
  assert.equal(app.ctx.kjrArtState(app.single('j1'), 'singles').state, 'none');
  const nf = await setup({ singles: [jp()] });
  nf.route.detail = () => jsonResponse({}, 404);
  await nf.runSingle('j1');
  assert.equal(nf.ctx.kjrCardImageMissed('SV2a-006', 'ja'), true);
});

// ── the row can change while a lookup runs ──────────────────────────────────────────────────────────
test('art-ja: a row edited while its lookup ran is not written, and no miss is recorded for the old text', async () => {
  const app = await setup({ singles: [jp()] });
  app.route.search = () => { app.single('j1').name = 'Charizard ex 125'; return jsonResponse(HIT); };
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, '', 'the answer was for 006, the row now says 125');
  assert.equal(app.marks.length, 0);
  assert.equal(app.localStorage.getItem('kjr_slab_card_ids'), null);
  assert.equal(app.ctx.kjrArtState(app.single('j1'), 'singles').state, 'need', 'the next render asks about the new name');
  // a row whose language changed meanwhile is no longer a Japanese single
  const app2 = await setup({ singles: [jp()] });
  app2.route.search = () => { app2.single('j1').language = 'EN'; return jsonResponse(HIT); };
  await app2.runSingle('j1');
  assert.equal(app2.single('j1').tcgdexId, '');
});

test('art-ja: an id typed into the edit modal while the lookup ran wins, ours is dropped and only its image is fetched', async () => {
  const app = await setup({ singles: [jp()] });
  app.route.search = () => { app.single('j1').tcgdexId = 'SV3-066'; return jsonResponse(HIT); };
  app.route.detail = () => jsonResponse({ id: 'SV3-066', image: 'https://assets.tcgdex.net/ja/SV/SV3/066' });
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, 'SV3-066', 'theirs, untouched');
  assert.equal(app.marks.length, 0, 'we wrote nothing');
  assert.equal(app.single('j1')._tcgdexResolvedName, undefined);
  assert.equal(app.ctx.kjrCardImageBase('SV3-066', 'ja'), 'https://assets.tcgdex.net/ja/SV/SV3/066');
  assert.equal(app.urls().filter((u) => u.includes('/ja/cards/')).pop(), 'https://api.tcgdex.net/v2/ja/cards/SV3-066');
  // typed BEFORE the lookup started (the placeholder was drawn without it): no search at all
  const early = await setup({ singles: [jp({ tcgdexId: 'SV3-066' })] });
  early.route.detail = () => jsonResponse({ id: 'SV3-066', image: 'https://assets.tcgdex.net/ja/SV/SV3/066' });
  await early.runSingle('j1');
  assert.equal(early.urls().filter((u) => u.includes('/resolve?')).length, 0, 'an id on the row is never searched for');
  assert.equal(early.marks.length, 0);
});

test('art-ja: a row deleted while its lookup ran is left alone, and an id the image cache cannot hold is a miss, not a write', async () => {
  const app = await setup({ singles: [jp()] });
  app.route.search = () => { app.ctx.DB.singles.splice(0, 1); return jsonResponse(HIT); };
  await assert.doesNotReject(() => app.runSingle('j1'));
  assert.equal(app.marks.length, 0);
  assert.equal(app.localStorage.getItem('kjr_slab_card_ids'), null);
  const odd = await setup({ singles: [jp()] }, { search: { id: 'SM1+-006', name: 'リザードンex' } });
  await odd.runSingle('j1');
  assert.equal(odd.single('j1').tcgdexId, '', 'only ids the image cache can key are ever written');
  assert.equal(odd.links()['s:j1'].miss, iso(0));
});

test('art-ja: two identical Japanese singles each get their id, once each, and each is its own dirty row', async () => {
  const app = await setup({ singles: [jp(), jp({ id: 'j2' })] });
  await app.runSingle('j1');
  await app.runSingle('j2');
  assert.equal(app.single('j1').tcgdexId, 'SV2a-006');
  assert.equal(app.single('j2').tcgdexId, 'SV2a-006');
  assert.deepEqual(plain(app.marks), [['singles', 'j1'], ['singles', 'j2']]);
  assert.equal(app.urls().filter((u) => u.endsWith('/ja/cards/SV2a-006')).length, 1, 'the second finds the image already on file');
});

// ── the set list (the Unmatched cards picker's set names, read in the browser) ──────────────────────
test('art-ja: the set list is fetched once per language, kept as id and name only, and served from memory afterwards', async () => {
  const app = await setup({ singles: [jp()] });
  const a = app.ctx._kjrTcgdexSets('ja'), b = app.ctx._kjrTcgdexSets('ja');
  assert.equal(app.fetchMock.calls.length, 1, 'two callers share one request');
  const list = plain(await a);
  assert.deepEqual(plain(await b), list);
  assert.equal(list.length, LIVE_JA_SETS.length);
  assert.deepEqual(list[0], { id: 'SV2a', name: 'ポケモンカード151' }, 'no cardCount, logo or symbol is kept');
  await app.ctx._kjrTcgdexSets('ja');
  assert.equal(app.fetchMock.calls.length, 1);
  assert.equal(app.fetchMock.calls[0].url, 'https://api.tcgdex.net/v2/ja/sets');
  const stored = JSON.parse(app.localStorage.getItem('kjr_tcgdex_sets_v1:ja'));
  assert.equal(stored.v, 1);
  assert.ok(Math.abs(stored.t - Date.now()) < 10000);
  assert.deepEqual(stored.list, list);
  assert.equal(app.localStorage.getItem('kjr_tcgdex_sets_v1:en'), null, 'each language has its own entry');
  // English is a separate request with its own key
  app.fetchMock.route('/en/sets', () => jsonResponse([{ id: 'base1', name: 'Base Set', logo: 'x' }]));
  assert.deepEqual(plain(await app.ctx._kjrTcgdexSets('en')), [{ id: 'base1', name: 'Base Set' }]);
  assert.equal(app.fetchMock.calls.length, 2);
  // a language that cannot be a path segment is refused
  assert.equal(await app.ctx._kjrTcgdexSets('../x'), null);
});

test('art-ja: a stored set list is served for 30 days with no request, an expired or future-dated one is fetched again', async () => {
  const stored = (ageDays, list) => ({ 'kjr_tcgdex_sets_v1:ja': { v: 1, t: Date.now() - ageDays * DAY, list: list || [{ id: 'OLD1', name: 'Stored Set' }] } });
  const fresh = await setup({ singles: [jp()] }, { localStorage: stored(29) });
  assert.deepEqual(plain(await fresh.ctx._kjrTcgdexSets('ja')), [{ id: 'OLD1', name: 'Stored Set' }]);
  assert.equal(fresh.fetchMock.calls.length, 0, 'inside 30 days: served from localStorage');
  for (const [label, age] of [['31 days old', 31], ['a stamp from the future', -3]]) {
    const old = await setup({ singles: [jp()] }, { localStorage: stored(age) });
    const got = plain(await old.ctx._kjrTcgdexSets('ja'));
    assert.equal(old.fetchMock.calls.length, 1, label + ': refetched');
    assert.equal(got.length, LIVE_JA_SETS.length, label);
    const rewritten = JSON.parse(old.localStorage.getItem('kjr_tcgdex_sets_v1:ja'));
    assert.ok(Math.abs(rewritten.t - Date.now()) < 10000, label + ': the stamp is renewed');
  }
  for (const [label, junk] of [['not JSON', '{nope'], ['wrong version', JSON.stringify({ v: 2, t: Date.now(), list: [{ id: 'X1', name: 'x set' }] })], ['no list', JSON.stringify({ v: 1, t: Date.now() })], ['empty list', JSON.stringify({ v: 1, t: Date.now(), list: [] })], ['no stamp', JSON.stringify({ v: 1, list: [{ id: 'X1', name: 'x set' }] })]]) {
    const bad = await setup({ singles: [jp()] }, { localStorage: { 'kjr_tcgdex_sets_v1:ja': junk } });
    assert.equal((await bad.ctx._kjrTcgdexSets('ja')).length, LIVE_JA_SETS.length, label + ': ignored, fetched');
  }
});

test('art-ja: when the set list cannot be fetched there is none to use, a stale list beats none, a failure is not hammered', async () => {
  const app = await setup({ singles: [jp()] });
  app.route.sets = () => { throw new TypeError('offline'); };
  assert.equal(await app.ctx._kjrTcgdexSets('ja'), null, 'no list to use');
  assert.equal(app.fetchMock.calls.length, 1);
  assert.equal(await app.ctx._kjrTcgdexSets('ja'), null);
  assert.equal(app.fetchMock.calls.length, 1, 'not retried inside a minute');
  assert.equal(app.localStorage.getItem('kjr_tcgdex_sets_v1:ja'), null, 'a failure stores nothing');
  // HTTP error, junk body
  for (const [label, route] of [['HTTP 503', () => jsonResponse({}, 503)], ['junk', () => jsonResponse({ nope: 1 })], ['all entries unusable', () => jsonResponse([{ id: '', name: 'x' }, { id: 'ok1' }, null, 5])]]) {
    const a = await setup({ singles: [jp()] });
    a.route.sets = route;
    assert.equal(await a.ctx._kjrTcgdexSets('ja'), null, label);
    assert.equal(a.localStorage.getItem('kjr_tcgdex_sets_v1:ja'), null, label);
  }
  // an expired list is stale, not gone: it serves when the refresh fails
  const stale = await setup({ singles: [jp()] }, { localStorage: { 'kjr_tcgdex_sets_v1:ja': { v: 1, t: Date.now() - 90 * DAY, list: [{ id: 'SV2a', name: 'ポケモンカード151' }] } } });
  stale.route.sets = () => { throw new TypeError('offline'); };
  assert.deepEqual(plain(await stale.ctx._kjrTcgdexSets('ja')), [{ id: 'SV2a', name: 'ポケモンカード151' }]);
  assert.equal(stale.fetchMock.calls.length, 1, 'it did try');
  // offline: no attempt at all
  const off = await setup({ singles: [jp()] });
  off.ctx.navigator.onLine = false;
  assert.equal(await off.ctx._kjrTcgdexSets('ja'), null);
  assert.equal(off.fetchMock.calls.length, 0);
  // junk entries inside a good list are dropped one by one
  const mixed = await setup({ singles: [jp()] }, { sets: [{ id: 'SV2a', name: 'ポケモンカード151' }, { id: 'bad id', name: 'x set' }, { id: 'SM1+', name: 'サン＆ムーン' }, { id: 'X9', name: '' }, { id: 'X8', name: 'y'.repeat(200) }, 'text', null, { id: 7, name: 'n' }] });
  assert.deepEqual(plain(await mixed.ctx._kjrTcgdexSets('ja')), [{ id: 'SV2a', name: 'ポケモンカード151' }, { id: 'SM1+', name: 'サン＆ムーン' }]);
});

// ── slabs ───────────────────────────────────────────────────────────────────────────────────────────
test('art-ja: a Japanese slab resolves on /ja/, kjrImgRun fetches /ja/cards/SV2a-006, the slab row stays untouched', async () => {
  const app = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab()] });
  const rowsBefore = JSON.stringify(app.ctx.DB.slabs);
  const dirtyBefore = JSON.stringify([...app.ctx._dirty.slabs]);
  assert.deepEqual(plain(app.ctx.kjrArtState(app.slab('p1'), 'slabs')), { state: 'need', key: 'slab:p1', slab: 'p1', lang: 'ja' });
  await app.runSlab('p1');
  const urls = app.urls();
  assert.equal(urls[0], resolveUrl(app, 'Charizard ex 006', 'ja', '151'), 'the Worker, with the slab\'s language and set');
  assert.equal(urls.length, 2, 'then only the card page');
  assert.equal(urls[urls.length - 1], 'https://api.tcgdex.net/v2/ja/cards/SV2a-006', 'the card page is fetched in the slab\'s own language');
  assert.equal(urls.filter((u) => u.includes('/en/')).length, 0, 'nothing on /en/');
  assert.deepEqual(plain(app.links()), { p1: { id: 'SV2a-006', n: 'Charizard ex 006|ja|set:151' } }, 'the link keeps the language in its signature');
  assert.equal(app.ctx.kjrCardImageBase('SV2a-006', 'ja'), BASE_006);
  assert.deepEqual(plain(app.ctx.kjrArtState(app.slab('p1'), 'slabs')), { state: 'hit', base: BASE_006, key: 'ja:SV2a-006' });
  assert.equal(JSON.stringify(app.ctx.DB.slabs), rowsBefore, 'no tcgdexId lands on a slab row');
  assert.equal(JSON.stringify([...app.ctx._dirty.slabs]), dirtyBefore);
  assert.equal(app.marks.length, 0);
  assert.equal(app.saves.n, 0);
  // an identical Japanese slab takes the link, no lookup
  app.ctx.DB.slabs.push(Object.assign({}, jpSlab(), { id: 'p2' }));
  const calls = app.fetchMock.calls.length;
  assert.equal(await app.runSlab('p2'), true);
  assert.equal(app.fetchMock.calls.length, calls, 'the twin cost no request');
  assert.equal(app.ctx.kjrArtState(app.slab('p2'), 'slabs').state, 'hit');
});

test('art-ja: a Japanese slab with an id of its own wins, and an English slab is still looked up on /en/ exactly as before', async () => {
  const own = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab({ tcgdexId: 'SV3-066' })] });
  own.route.detail = () => jsonResponse({ id: 'SV3-066', image: 'https://assets.tcgdex.net/ja/SV/SV3/066' });
  await own.runSlab('p1');
  assert.deepEqual(own.urls(), ['https://api.tcgdex.net/v2/ja/cards/SV3-066'], 'no species, no search, only its card, on /ja/');
  const en = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab({ language: 'EN', name: 'Umbreon VMAX 215/203', set: '' })] });
  en.route.search = () => jsonResponse({ id: 'swsh7-215', name: 'Umbreon VMAX' });
  en.fetchMock.route('/en/cards/swsh7-215', () => jsonResponse({ id: 'swsh7-215', image: 'https://assets.tcgdex.net/en/swsh/swsh7/215' }));
  await en.run({ key: 'slab:p1', slab: 'p1', lang: 'en' });
  assert.deepEqual(en.urls(), [resolveUrl(en, 'Umbreon VMAX 215/203', 'en', ''), 'https://api.tcgdex.net/v2/en/cards/swsh7-215'], 'lang=en, no species map, no set list');
  assert.deepEqual(plain(en.links()), { p1: { id: 'swsh7-215', n: 'Umbreon VMAX 215/203|en' } });
});

test('art-ja: a Japanese slab that does not resolve is a 7-day miss, one that could not be asked is not', async () => {
  const app = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab({ name: "Boss's Orders 172" })] }, { search: { id: null } }); // a trainer: no species, the Worker's miss
  await app.runSlab('p1');
  assert.deepEqual(plain(app.links()), { p1: { miss: iso(0), n: "Boss's Orders 172|ja|set:151" } });
  assert.equal(app.ctx.kjrArtState(app.slab('p1'), 'slabs').state, 'none');
  const down = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab()] });
  down.route.search = () => jsonResponse({ id: null, transient: true, why: 'map' });
  await down.runSlab('p1');
  assert.equal(down.localStorage.getItem('kjr_slab_card_ids'), null, 'the Worker\'s species map failing is not a miss');
  assert.equal(down.ctx.kjrArtState(down.slab('p1'), 'slabs').state, 'need');
  const five = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab()] });
  five.route.search = () => jsonResponse({}, 500);
  await five.runSlab('p1');
  assert.equal(five.localStorage.getItem('kjr_slab_card_ids'), null, 'a failed search is not a miss either');
});

test('art-ja: a full link map is pruned of rows that are gone, the misses of live singles and the links of live slabs stay', async () => {
  const app = await setup({ singles: [jp(), jp({ id: 'j2' })], slabs: [jpSlab()] });
  app.ctx.KJR_IMG_MAX_ENTRIES = 4;
  app.ctx.kjrSlabLinkSet('s:j1', 'sig1', null);
  app.ctx.kjrSlabLinkSet('s:j2', 'sig2', null);
  app.ctx.kjrSlabLinkSet('p1', 'sig3', 'SV2a-006');
  app.ctx.kjrSlabLinkSet('s:gone', 'sig4', null);
  assert.deepEqual(Object.keys(app.links()).sort(), ['p1', 's:gone', 's:j1', 's:j2']);
  assert.equal(app.ctx.kjrSlabLinkSet('s:j3', 'sig5', null), true, 'room was made by dropping the row that is gone');
  assert.deepEqual(Object.keys(app.links()).sort(), ['p1', 's:j1', 's:j2', 's:j3']);
  // nothing to drop and still full: it gives up quietly, it never throws
  app.ctx.DB.singles.push(jp({ id: 'j3' }));
  assert.equal(app.ctx.kjrSlabLinkSet('s:j4', 'sig6', null), false);
});

// ── English and the rest are not disturbed ──────────────────────────────────────────────────────────
test('art-ja: pricing sends no art flag and no set unless given one, the browser never reads the species map or the set list, Japanese included', async () => {
  const app = await setup({ singles: [jp({ id: 'keep' })] }, { search: { id: null } });
  const q = () => plain(app.fetchMock.resolveCalls().pop());
  assert.equal(await app.ctx.resolveTcgdexId({ name: 'Gyarados 5 Jungle', language: 'EN' }), null);
  assert.deepEqual(q(), { name: 'Gyarados 5 Jungle', lang: 'en', set: '', art: false, num: '5' });
  assert.equal(await app.ctx.resolveTcgdexId({ name: 'Gyarados 5', language: 'EN' }, { set: 'Jungle' }), null);
  assert.deepEqual(q(), { name: 'Gyarados 5', lang: 'en', set: 'Jungle', art: false, num: '5' }, 'a set hint is sent, and it is not the art flag');
  // Japanese with no opts is a plain lookup on ja, the Worker decides what that means
  assert.equal(await app.ctx.resolveTcgdexId({ name: 'Charizard ex 006', language: 'JP' }), null);
  assert.deepEqual(q(), { name: 'Charizard ex 006', lang: 'ja', set: '', art: false, num: '006' });
  assert.equal(app.urls().filter((u) => u.includes('species-ja') || u.endsWith('/sets') || u.includes('api.tcgdex.net')).length, 0, 'no species map, no set list, no TCGdex search');
  // an id already on the item short-circuits, art or not
  const calls = app.fetchMock.calls.length;
  assert.equal(await app.ctx.resolveTcgdexId({ name: 'Charizard ex 006', language: 'JP', tcgdexId: 'SV3-066' }, { art: true }), 'SV3-066');
  assert.equal(app.fetchMock.calls.length, calls);
  // Chinese goes as zh-tw, art or not
  app.route.search = () => jsonResponse({ id: 'sv1-25' });
  const cn = { name: 'Pikachu 25', language: 'CN' };
  assert.equal(await app.ctx.resolveTcgdexId(cn, { art: true, set: 'x' }), 'sv1-25');
  assert.deepEqual(q(), { name: 'Pikachu 25', lang: 'zh-tw', set: 'x', art: true, num: '25' });
  assert.equal(app.urls().filter((u) => u.includes('species-ja') || u.endsWith('/sets')).length, 0);
});

// ── pricing: the art lookup is art only, the price comes from PPT's Japanese catalogue ───────────────────────────────────────────────
// v3.85: a Japanese single with a card number is priced by the PPT lane's Japanese lane (tests/ppt-japanese.test.js), once that lane is
// switched on (it has shipped on since v3.89, these tests force it on or off through the harness). That lane asks the vendor and never TCGdex: the art id a row carries
// stays art only, so the art lookup makes no price call and the price lane makes no /ja/ call, whatever id the row holds. An English control
// row proves the queue really ran.
const JP_CARD = { id: 'jp-006', name: 'Charizard ex', cardNumber: '006/165', setName: 'SV2a: Pokemon Card 151', prices: { market: 12 }, language: 'Japanese' }; // the vendor's setName is the set code, a colon, the set name (v3.89)
const pptAnswer = (cards) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total: 3 } } });
const SEARCH_WAITS = [6000, 250];
async function drainQueue(fn, timers) {
  const p = fn();
  let finished = false;
  p.then(() => { finished = true; }, () => { finished = true; });
  for (let i = 0; i < 80 && !finished; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => SEARCH_WAITS.includes(e.delay));
  }
  return p;
}

test('art-ja: the art lookup makes no price call, and refreshPrice then asks PPT\'s Japanese catalogue, never TCGdex for a price', async () => {
  const app = await setup({ singles: [jp()] }, { jaLane: true });
  assert.equal(app.ctx._queueLaneFor(app.single('j1')), 'manual', 'no matched card yet (v3.89): the art lookup has not written its id');
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, 'SV2a-006');
  assert.deepEqual(app.urls().filter((u) => u.includes('/ppt/') || u.includes('frankfurter')), [], 'the art lookup made no price call');
  app.fetchMock.calls.length = 0;
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(String(m));
  app.fetchMock.route('/ppt/cards', () => pptAnswer([JP_CARD]));
  app.fetchMock.route('frankfurter.dev', () => jsonResponse([{ quote: 'SGD', rate: 1 }]));
  await app.ctx.refreshPrice('j1', 'singles');
  const urls = app.urls();
  assert.equal(urls.filter((u) => u.includes('/ppt/cards')).length, 1, 'one PPT search: ' + urls.join(', '));
  assert.match(urls.find((u) => u.includes('/ppt/cards')), /language=japanese/, 'in the Japanese catalogue');
  assert.deepEqual(urls.filter((u) => u.includes('api.tcgdex.net')), [], 'TCGdex is not asked for a price, the art id does not make it a price source');
  const row = app.single('j1');
  assert.equal(row.marketPrice, '12', 'the card\'s TCGplayer market');
  assert.equal(row.priceHistory.length, 1);
  assert.equal(row.priceHistory[0].source, 'PPT (Japanese)');
  assert.equal(row.tcgdexId, 'SV2a-006', 'and the art id is untouched');
  assert.equal(urls.find((u) => u.includes('/ppt/cards')).includes('search=Charizard ex SV2a&'), true, 'the search is the name and the set code of the id the art lookup wrote');
  assert.equal(app.ctx._queueLaneFor(row), 'ppt', 'with the matched card it is a Japanese-lane card');
  assert.equal(app.ctx._queueLaneFor(Object.assign({}, row, { tcgdexId: '' })), 'manual', 'and without one it is manual, the id is the matched card (v3.89)');
});

test('art-ja: a Japanese single with no matched card is manual and no pass asks for it, the art lookup then matches it and the next queue run prices it with no step in between', async () => {
  const app = await setup({ singles: [jp()] }, { jaLane: true });
  app.ctx.toast = () => {};
  app.fetchMock.route('/ppt/cards', () => pptAnswer([JP_CARD]));
  app.fetchMock.route('frankfurter.dev', () => jsonResponse([{ quote: 'SGD', rate: 1 }]));
  const searches = () => app.urls().filter((u) => u.includes('/ppt/cards'));
  // before the match: a manual pass and an automatic one ask the vendor nothing, and the price typed in stays
  app.fetchMock.calls.length = 0;
  await drainQueue(() => app.ctx.runRefreshQueue(true), app.timers);
  await drainQueue(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.deepEqual(searches(), [], 'no matched card, no request');
  assert.equal(app.single('j1').marketPrice, 30, 'the hand-set price is untouched');
  assert.equal(app.single('j1')._tcgdexMissDate, undefined, 'and it was never asked, so it is not unmatched');
  assert.deepEqual(plain(app.ctx._kjrManualLangCards().map((r) => r.id)), ['j1'], 'it is counted as a manual price, like a Chinese one');
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles()), [], 'and never as unmatched');
  // the card art lookup (the real one) finds the card and writes the id, marking the row so it syncs
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, 'SV2a-006');
  assert.equal(app.ctx._dirty.singles.has('j1'), true, 'written with markDirty');
  // the next run, with nothing done in between, asks for it
  app.fetchMock.calls.length = 0;
  await drainQueue(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(searches().length, 1);
  assert.match(decodeURIComponent(searches()[0]), /search=Charizard ex SV2a&limit=3&language=japanese/);
  assert.equal(app.single('j1').marketPrice, '12');
  assert.deepEqual(plain(app.ctx._kjrManualLangCards()), [], 'it is no longer a manual price');
});

test('art-ja: with the Japanese price lane forced off (the kill switch state), the art id is still art only and the Japanese row is a manual price, no call', async () => {
  const app = await setup({ singles: [jp()] });
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, 'SV2a-006', 'the art lookup is unaffected by the switch');
  app.fetchMock.calls.length = 0;
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(String(m));
  app.fetchMock.route('/ppt/cards', () => pptAnswer([JP_CARD]));
  await app.ctx.refreshPrice('j1', 'singles');
  assert.deepEqual(app.urls(), [], 'not one request of any kind');
  assert.ok(toasts.includes('Manual price, no free source for this language'), JSON.stringify(toasts));
  assert.equal(app.ctx._queueLaneFor(app.single('j1')), 'manual', 'the id does not move it, nor does the language');
  assert.equal(app.single('j1').marketPrice, 30, 'the hand-set price is untouched');
  assert.ok(!(app.single('j1').priceHistory || []).length, 'and no history entry was written');
});

for (const manual of [false, true]) {
  test('art-ja: the ' + (manual ? 'manual "run now"' : 'daily') + ' queue prices Japanese rows from PPT only, no /ja/ or species call, an English single beside it is priced by TCGdex', async () => {
    const seed = makeSeed({ singles: [
      jp({ tcgdexId: 'SV2a-006', _tcgdexResolvedName: 'リザードンex', name: 'Charizard ex 006' }),
      jp({ id: 'j2', name: 'Pikachu 025', tcgdexId: 'SV2a-025', set: '' }),
      jp({ id: 'j3', name: 'Mew ex 151', tcgdexId: '' }), // no matched card yet (v3.89): manual, never asked, until the art lookup writes its id
      jp({ id: 'en1', name: 'Pikachu 25', language: 'EN', tcgdexId: 'sv3-199', set: 'Scarlet', marketPrice: '', priceHistory: [] }),
    ] });
    const app = await loadApp({ seed, jaLane: true });
    app.fetchMock.calls.length = 0;
    app.urls = () => app.fetchMock.calls.map((c) => decodeURIComponent(c.url));
    app.fetchMock.route('/cards/sv3-199', () => jsonResponse({ id: 'sv3-199', pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } }));
    app.fetchMock.route('frankfurter.dev', () => jsonResponse([{ quote: 'SGD', rate: 1 }]));
    // the vendor knows the Charizard only: the other two searches find nothing, which is a miss, never a guess
    app.fetchMock.route('/ppt/cards', (u) => pptAnswer(/Charizard/.test(decodeURIComponent(u)) ? [JP_CARD] : []));
    app.fetchMock.route('/ja/', () => jsonResponse([{ id: 'SV2a-006', localId: '006', name: 'リザードンex' }]));
    app.ctx.toast = () => {};
    const q = app.ctx.buildRefreshQueue();
    const lanes = Object.fromEntries(plain(q.items).map((i) => [i.id, i.lane]));
    assert.deepEqual(lanes, { en1: 'tcgdex', j1: 'ppt', j2: 'ppt' }, 'the Japanese rows with a matched card are the PPT lane\'s, the one with no id is manual');
    const dirtyBefore = [...app.ctx._dirty.singles];
    await drainQueue(() => app.ctx.runRefreshQueue(manual), app.timers);
    await app.settle(40);
    const urls = app.urls();
    assert.ok(urls.some((u) => u.endsWith('/cards/sv3-199')), 'control: the queue ran and priced the English row');
    assert.equal(app.ctx.DB.singles.find((r) => r.id === 'en1').marketPrice, '45');
    assert.deepEqual(urls.filter((u) => u.includes('/ja/') || u.includes('species-ja') || u.endsWith('/sets')), [], 'not one Japanese TCGdex, species or set call');
    const ppt = urls.filter((u) => u.includes('/ppt/cards'));
    assert.equal(ppt.length, 2, 'one PPT search per matched Japanese row: ' + ppt.join(', '));
    assert.ok(ppt.every((u) => /language=japanese/.test(u) && /limit=3/.test(u) && !/includeEbay/.test(u)), 'each in the Japanese catalogue, plain (no eBay data)');
    const row = (id) => app.ctx.DB.singles.find((r) => r.id === id);
    assert.equal(row('j1').marketPrice, '12', 'the one the vendor has is priced');
    assert.equal(row('j2').marketPrice, 30, 'a miss leaves the hand-set price alone');
    assert.equal(row('j2')._tcgdexMissDate, app.ctx.kjrLocalDay(), 'and lists the card in the could-not-be-matched banner');
    assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles().map((r) => r.id).sort()), ['j2'], 'only the card the lane asked about and found no unique match for, the one with no matched card is a manual price');
    assert.equal(row('j3').marketPrice, 30, 'the unmatched one keeps its price and is never stamped');
    assert.equal(row('j3')._tcgdexMissDate, undefined);
    assert.deepEqual(plain(app.ctx._kjrManualLangCards().map((r) => r.id)), ['j3']);
    assert.deepEqual([...app.ctx._dirty.singles].filter((id) => !dirtyBefore.includes(id)).sort(), ['en1', 'j1'], 'only the rows whose price changed are marked dirty, a miss stamp is local');
  });
}

// ── what the pieces are made of ─────────────────────────────────────────────────────────────────────
test('art-ja: Assets/species-ja.json is the generated map, about a thousand entries, and stays out of the service worker precache and the page', async () => {
  const keys = Object.keys(SPECIES);
  assert.ok(keys.length >= 1000, 'entries: ' + keys.length);
  assert.equal(SPECIES.Charizard, 'リザードン');
  assert.equal(SPECIES.Pikachu, 'ピカチュウ');
  assert.equal(SPECIES['Mr. Mime'], 'バリヤード');
  assert.equal(SPECIES.Porygon2, 'ポリゴン2', 'full-width digits become ASCII, the way TCGdex spells card names');
  assert.equal(SPECIES['Porygon-Z'], 'ポリゴンZ');
  assert.equal(SPECIES['Type: Null'], 'タイプ：ヌル', 'other punctuation is left alone');
  assert.equal(SPECIES["Farfetch'd"], 'カモネギ');
  for (const k of keys) assert.match(SPECIES[k], /^[\u3040-\u30FF\u2640\u2642\uFF1A0-9A-Za-z]+$/, k);
  const raw = fs.readFileSync(path.join(ROOT, 'Assets', 'species-ja.json'), 'utf8');
  assert.ok(raw.startsWith('{"Bulbasaur":"フシギダネ"'), 'compact JSON in species id order');
  assert.ok(raw.length < 60000, 'small enough to fetch on demand: ' + raw.length);
  const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert.ok(!sw.includes('species-ja'), 'loaded on demand, not precached');
  assert.ok(!fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').includes('species-ja.json'), 'the browser no longer loads it, the Worker\'s /resolve maps species (v4.1)');
});

test('art-ja: scripts/species-ja.mjs builds the map from the PokeAPI CSV shape (quotes, full-width digits, curly apostrophes)', async () => {
  const gen = await import(pathToFileURL(path.join(ROOT, 'scripts', 'species-ja.mjs')).href);
  const csv = [
    'pokemon_species_id,local_language_id,name,genus',
    '6,1,リザードン,かえんポケモン', '6,9,Charizard,Flame Pokémon', '6,11,リザードン,かえんポケモン', '6,5,Dracaufeu,Pokémon Flamme',
    '233,9,Porygon2,"Virtual, ""Pokémon"""', '233,1,ポリゴン２,"x, y"',
    '83,1,カモネギ,x', '83,9,Farfetch’d,x',
    '474,1,ポリゴンＺ,x', '474,9,Porygon-Z,x',
    '772,1,タイプ：ヌル,x', '772,9,Type: Null,x',
    '99,9,OnlyEnglish,x', '98,1,ニホンゴノミ,x', 'x,1,bad,x', '',
  ].join('\r\n');
  const map = gen.buildSpeciesMap(csv);
  assert.deepEqual(Object.keys(map), ['Charizard', "Farfetch'd", 'Porygon2', 'Porygon-Z', 'Type: Null'], 'species id order, rows with only one language dropped');
  assert.deepEqual(map, { Charizard: 'リザードン', "Farfetch'd": 'カモネギ', Porygon2: 'ポリゴン2', 'Porygon-Z': 'ポリゴンZ', 'Type: Null': 'タイプ：ヌル' });
  assert.deepEqual(gen.parseCsv('a,"b,c","d""e"\n1,2,3'), [['a', 'b,c', 'd"e'], ['1', '2', '3']]);
  assert.equal(gen.fullWidthToAscii('ポリゴン２Ｚｚ'), 'ポリゴン2Zz');
  assert.ok(gen.MIN_ENTRIES >= 1000, 'a short download is refused, not written');
});
