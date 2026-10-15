'use strict';
// v3.80: card art for Japanese cards and slabs. TCGdex's Japanese catalogue stores Japanese names, so an English name finds nothing on
// /ja/. A Japanese row's English name is mapped to its katakana species name (Assets/species-ja.json), the /ja/ search is cut to the
// exact localId, narrowed by the set (the fetched TCGdex set list, static table as the offline floor), and accepted only when exactly
// one candidate is left. Art only: pricing for Japanese rows stays manual, zero price calls, whatever id a row now carries.
// fetch is stubbed (tests/harness.js createFetchMock), nothing here reaches a real API. The responses below are shaped like the live
// ones captured on 15/10/2026 (GET /ja/cards?name=リザードン&localId=006, /ja/sets).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { loadApp, makeSeed, jsonResponse, plain, ROOT } = require('./harness.js');

const SPECIES = JSON.parse(fs.readFileSync(path.join(ROOT, 'Assets', 'species-ja.json'), 'utf8'));
const CHARIZARD = 'リザードン';
const BASE_006 = 'https://assets.tcgdex.net/ja/SV/SV2a/006';

// GET /ja/cards?name=リザードン&localId=006, as TCGdex answered it: a contains-match on the name and a loose match on the id, so the
// card we want comes back with seven others. Some cards carry no image.
const LIVE_SEARCH_006 = [
  { id: 'SV2a-006', localId: '006', name: 'リザードンex', image: BASE_006 },
  { id: 'SM12a-016', localId: '016', name: 'レシラム&リザードンGX' },
  { id: 'SV3-066', localId: '066', name: 'リザードンex', image: 'https://assets.tcgdex.net/ja/SV/SV3/066' },
  { id: 'SM11a-067', localId: '067', name: 'リザードン&テールナーGX' },
  { id: 'SM11a-068', localId: '068', name: 'リザードン&テールナーGX' },
  { id: 'SM10-096', localId: '096', name: 'レシラム&リザードンGX' },
  { id: 'M2-116', localId: '116', name: 'メガリザードンXex' },
  { id: 'MC-766', localId: '766', name: 'メガリザードンYex' },
];
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
  const o = Object.assign({ search: LIVE_SEARCH_006, sets: LIVE_JA_SETS, species: SPECIES, detail: DETAIL_006 }, extra || {});
  const seed = makeSeed({ singles: (rows && rows.singles) || [jp()], slabs: (rows && rows.slabs) || [] });
  const app = await loadApp(o.localStorage ? { seed, localStorage: o.localStorage } : { seed });
  app.fetchMock.calls.length = 0;
  app.route = {
    species: () => jsonResponse(o.species),
    search: () => jsonResponse(o.search),
    sets: () => jsonResponse(o.sets),
    detail: () => jsonResponse(o.detail),
  };
  app.fetchMock.route('species-ja.json', (u, f) => app.route.species(u, f));
  app.fetchMock.route('/ja/cards?name=', (u, f) => app.route.search(u, f));
  app.fetchMock.route('/ja/sets', (u, f) => app.route.sets(u, f));
  app.fetchMock.route('/ja/cards/', (u, f) => app.route.detail(u, f));
  app.urls = () => app.fetchMock.calls.map((c) => decodeURIComponent(c.url));
  app.tcgdex = () => app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net'));
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
    assert.equal(row.tcgdexId, 'SV2a-006', name + ': the unique exact-localId candidate in the 151 set');
    assert.equal(row._tcgdexResolvedName, 'リザードンex', 'the local "Resolved to" note the edit modal shows');
    assert.deepEqual(plain(app.marks), [['singles', 'j1']], 'markDirty once, for that row');
    assert.equal(app.saves.n, 1, 'saved once');
    assert.equal(app.ctx._dirty.singles.has('j1'), true, 'and it is in the dirty queue, so it syncs');
    // nothing else on the row moved
    for (const k of Object.keys(before)) if (k !== 'tcgdexId') assert.deepEqual(plain(row[k]), before[k], k + ' untouched');
    assert.deepEqual(Object.keys(row).filter((k) => !(k in before)).sort(), ['_tcgdexResolvedName'], 'the only new key besides the id is the local note');

    const urls = app.urls();
    assert.equal(urls[0], 'Assets/species-ja.json', 'the species map is read first');
    assert.equal(urls[1], 'https://api.tcgdex.net/v2/ja/cards?name=' + CHARIZARD + '&localId=006', 'then the Japanese species name and the number as typed');
    assert.equal(urls[2], 'https://api.tcgdex.net/v2/ja/sets', 'the set list, because the row has a set');
    assert.equal(urls[3], 'https://api.tcgdex.net/v2/ja/cards/SV2a-006', 'then the card itself, on /ja/');
    assert.equal(urls.length, 4);
    assert.equal(app.ctx.kjrCardImageBase('SV2a-006', 'ja'), BASE_006, 'the image base is keyed per language');
    assert.equal(app.ctx.kjrCardImageBase('SV2a-006', 'en'), '', 'and never lands under the English key');
    const st = app.ctx.kjrArtState(row, 'singles');
    assert.deepEqual(plain(st), { state: 'hit', base: BASE_006, key: 'ja:SV2a-006' });

    // asking again does nothing: no lookup, no second write
    assert.equal(app.ctx.kjrQueueCardImage({ key: 'single:j1', single: 'j1', lang: 'ja' }), false);
    await drain(app);
    assert.equal(app.marks.length, 1);
    assert.equal(app.urls().length, 4);
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
test('art-ja: two candidates that share localId 006 and no set to tell them apart stay unresolved, a miss is cached, nothing is written', async () => {
  const two = [LIVE_SEARCH_006[0], { id: 'SV3a-006', localId: '006', name: 'リザードンex' }, ...LIVE_SEARCH_006.slice(1)];
  const app = await setup({ singles: [jp({ set: '' })] }, { search: two });
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, '', 'never a guessed id');
  assert.equal(app.marks.length, 0);
  assert.equal(app.saves.n, 0);
  assert.equal(app.urls().filter((u) => u.includes('/ja/cards/')).length, 0, 'no card is fetched');
  assert.equal(app.urls().filter((u) => u.endsWith('/ja/sets')).length, 0, 'no set text, so the set list is not even fetched');
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

test('art-ja: no candidate with that exact localId is a miss, the loose matches TCGdex returns are never taken', async () => {
  const app = await setup({ singles: [jp({ name: 'Charizard ex 7', set: '' })] }); // 7 is in none of the eight
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, '');
  assert.equal(app.links()['s:j1'].miss, iso(0));
  const app2 = await setup({ singles: [jp()] }, { search: [] });
  await app2.runSingle('j1');
  assert.equal(app2.single('j1').tcgdexId, '');
  assert.equal(app2.links()['s:j1'].miss, iso(0), 'zero results is a miss too');
});

test('art-ja: a set the row names that rules the only candidate out leaves it unresolved, it never widens the pick', async () => {
  const app = await setup({ singles: [jp({ set: 'SV3' })] }); // the only 006 is in SV2a
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, '');
  assert.equal(app.links()['s:j1'].miss, iso(0));
  assert.equal(app.urls().filter((u) => u.includes('/ja/cards/')).length, 0);
});

test('art-ja: a set the lists do not know changes nothing, a unique exact candidate is still taken, two stay ambiguous', async () => {
  const a = await setup({ singles: [jp({ set: 'Shiny Treasure ex' })] });
  await a.runSingle('j1');
  assert.equal(a.single('j1').tcgdexId, 'SV2a-006');
  const two = [LIVE_SEARCH_006[0], { id: 'SV3a-006', localId: '006', name: 'リザードンex' }];
  const b = await setup({ singles: [jp({ set: 'Shiny Treasure ex' })] }, { search: two });
  await b.runSingle('j1');
  assert.equal(b.single('j1').tcgdexId, '');
  // the set list itself could not be fetched: no narrowing at all, the same two rules hold
  const c = await setup({ singles: [jp()] });
  c.route.sets = () => { throw new TypeError('offline'); };
  await c.runSingle('j1');
  assert.equal(c.single('j1').tcgdexId, 'SV2a-006', 'a unique candidate does not need the list');
  const d = await setup({ singles: [jp()] }, { search: two });
  d.route.sets = () => { throw new TypeError('offline'); };
  await d.runSingle('j1');
  assert.equal(d.single('j1').tcgdexId, '', 'two candidates with no list to narrow them stay unresolved');
  assert.equal(d.localStorage.getItem('kjr_slab_card_ids'), null, 'but the list that could have told them apart was missing: not a 7-day miss, a network blip must not cost a week');
  assert.ok(d.ctx._kjrImgCool['single:j1'] > Date.now(), 'it is asked again in a minute');
  assert.equal(d.ctx._kjrImgQ.fails, 0, 'a missing set list does not pause the queue');
  // with no set text at all there was nothing for the list to do, so that ambiguity is a data outcome and a miss
  const e = await setup({ singles: [jp({ set: '' })] }, { search: two });
  e.route.sets = () => { throw new TypeError('offline'); };
  await e.runSingle('j1');
  assert.equal(e.links()['s:j1'].miss, iso(0));
  assert.equal(e.urls().filter((u) => u.endsWith('/ja/sets')).length, 0);
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
  late.route.search = () => { late.single('j1').dealerCostBasis = 12; return jsonResponse(LIVE_SEARCH_006); };
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

// ── the name has to fit, a lone localId is not enough ───────────────────────────────────────────────
// Found by running the resolver against the live API: "Umbreon VMAX 215/203" (an English number on a Japanese row) matched exactly one
// card numbered 215 with Umbreon in its name, the Tag Team "ブラッキー&ダークライGX" (SM12a-215), which is another card entirely.
test('art-ja: the mechanic tags of the row and of the card must agree (ex, V, VMAX, VSTAR, GX, Tag Team, Mega)', async () => {
  const { ctx } = await loadApp();
  const fits = (rowName, cardName, species) => ctx._kjrJaNameFits(ctx._kjrRowTags(ctx._baseCardName(rowName)), species || 'リザードン', cardName);
  const yes = [
    ['Charizard ex 006', 'リザードンex'], ['Charizard EX 13/106', 'リザードンEX'], ['Charizard 4', 'リザードン'], ['Charizard-EX 13', 'リザードンEX'],
    ['Charizard VMAX 20', 'リザードンVMAX'], ['Charizard VSTAR 18', 'リザードンVSTAR'], ['Charizard V 17', 'リザードンV'], ['Charizard GX 20', 'リザードンGX'],
    ['Charizard BREAK 4', 'リザードンBREAK'], ['Mega Charizard X ex 013/108', 'メガリザードンXex'], ['M Charizard EX 13', 'メガリザードンEX'],
    ['Charizard & Braixen GX 22', 'リザードン&テールナーGX'], ['Charizard & Braixen Tag Team GX 22', 'リザードン＆テールナーGX'], ['Charizard V-UNION 20', 'リザードンV-UNION'],
    ['Radiant Charizard 11', 'かがやくリザードン'], ['Dark Charizard 4', 'わるいリザードン'], ["Team Rocket's Charizard ex 7", 'ロケット団のリザードンex'],
    ['Charizard ex 006 JP', 'リザードンex'],
  ];
  for (const [row, card] of yes) assert.equal(fits(row, card), true, row + ' = ' + card);
  const no = [
    ['Umbreon VMAX 215/203', 'ブラッキー&ダークライGX', 'ブラッキー'], // the live false positive: a Tag Team card
    ['Charizard ex 006', 'リザードン'], ['Charizard 006', 'リザードンex'], ['Charizard ex 006', 'リザードンGX'],
    ['Charizard V 17', 'リザードンVMAX'], ['Charizard VMAX 20', 'リザードンV'], ['Charizard VSTAR 18', 'リザードンVMAX'], ['Charizard ex 116', 'メガリザードンXex'],
    ['Charizard ex 006', 'レシラム&リザードンGX'], ['Charizard GX 20', 'リザードン&テールナーGX'], ['Charizard & Braixen GX 22', 'リザードンGX'],
    ['Charizard ex 006', 'ピカチュウex'], ['Charizard ex 006', ''], ['Charizard ex 006', null], ['Charizard ex 006', undefined], ['Charizard ex 006', 42],
  ];
  for (const [row, card, species] of no) assert.equal(fits(row, card, species), false, row + ' != ' + String(card));
  assert.equal(fits('Umbreon VMAX 095', 'ブラッキーVMAX', 'ブラッキー'), true, 'the right Umbreon VMAX');
  assert.equal(ctx._kjrRowTags('Pikachu & Zekrom GX'), 'gx,tagteam');
  assert.equal(ctx._kjrCardTags('ピカチュウ&ゼクロムGX'), 'gx,tagteam');
  assert.equal(ctx._kjrCardTags('メガリザードンXex'), 'ex,mega');
  assert.equal(ctx._kjrCardTags('ピカチュウ'), '');
});

test('art-ja: a lone localId match whose card is another card is not taken, the right printing is', async () => {
  const wrong = { id: 'SM12a-215', localId: '215', name: 'ブラッキー&ダークライGX', image: 'https://assets.tcgdex.net/ja/SM/SM12a/215' };
  const app = await setup({ singles: [jp({ id: 'u1', name: 'Umbreon VMAX 215/203', set: '' })] }, { search: [wrong] });
  app.route.species = () => jsonResponse({ Umbreon: 'ブラッキー' });
  await app.runSingle('u1');
  assert.equal(app.single('u1').tcgdexId, '', 'the Tag Team card shares only the species and the number');
  assert.equal(app.marks.length, 0);
  assert.equal(app.links()['s:u1'].miss, iso(0));
  assert.equal(app.urls().filter((u) => u.includes('/ja/cards/')).length, 0);
  const right = { id: 'S6a-215', localId: '215', name: 'ブラッキーVMAX', image: 'https://assets.tcgdex.net/ja/S/S6a/215' };
  const ok = await setup({ singles: [jp({ id: 'u1', name: 'Umbreon VMAX 215/203', set: '' })] }, { search: [wrong, right] });
  ok.route.species = () => jsonResponse({ Umbreon: 'ブラッキー' });
  await ok.runSingle('u1');
  assert.equal(ok.single('u1').tcgdexId, 'S6a-215', 'with the right printing beside it the wrong one is simply not a candidate');
  // a card with no name, or one that does not hold the species, is never a candidate
  const odd = await setup({ singles: [jp({ set: '' })] }, { search: [{ id: 'SV2a-006', localId: '006' }, { id: 'SV3-006', localId: '006', name: 'ピカチュウex' }] });
  await odd.runSingle('j1');
  assert.equal(odd.single('j1').tcgdexId, '');
  assert.equal(odd.links()['s:j1'].miss, iso(0));
});

// ── set narrowing ───────────────────────────────────────────────────────────────────────────────────
test('art-ja: the set narrows by id, by name, by a fragment of one name, and the longest phrase wins', async () => {
  const cands = [{ id: 'SV2a-006', localId: '006', name: 'リザードンex' }, { id: 'SV8-006', localId: '006', name: 'リザードンex' }];
  const pick = async (set, name) => {
    const app = await setup({ singles: [jp()] }, { search: cands });
    const item = { name: name || 'Charizard ex 006', language: 'JP' };
    const id = await app.ctx.resolveTcgdexId(item, { art: true, set });
    return id;
  };
  assert.equal(await pick('SV2a'), 'SV2a-006', 'by id');
  assert.equal(await pick('sv2a'), 'SV2a-006', 'ids are not case sensitive');
  assert.equal(await pick('Set: SV8 pack'), 'SV8-006', 'an id as a word of longer text');
  assert.equal(await pick('ポケモンカード151'), 'SV2a-006', 'by the full Japanese name');
  assert.equal(await pick('超電ブレイカー'), 'SV8-006');
  assert.equal(await pick('151'), 'SV2a-006', 'by a field that sits inside exactly one name');
  assert.equal(await pick('Shiny Treasure'), null, 'unknown set: no narrowing, two candidates stay ambiguous');
  assert.equal(await pick('レイジングサーフ'), null, 'two sets carry that name, so it names neither');
  assert.equal(await pick('SV'), null, 'under 3 characters of name, and "SV" is no set id');
  // set words in the NAME count when several candidates remain, after the card number only
  assert.equal(await pick('', 'Charizard ex 006 JP SV8'), 'SV8-006');
  assert.equal(await pick('', 'Charizard ex 006 JP'), null, '"JP" names no set');
  assert.equal(await pick('SV2a', 'Charizard ex 006 JP SV8'), null, 'the name says SV8 and the set field says SV2a: they disagree, nothing is picked');
  // pure function: the longest phrase over every source
  const { ctx } = await loadApp();
  const en = [{ id: 'base1', name: 'Base Set' }, { id: 'base4', name: 'Base Set 2' }, { id: 'ecard1', name: 'Expedition Base Set' }, { id: 'sv03.5', name: '151' }, { id: 'ex8', name: 'Deoxys' }, { id: 'ex3', name: 'Dragon' }];
  assert.equal(ctx._tcgdexSetIdIn('Base Set 2', en, 'en', true), 'base4');
  assert.equal(ctx._tcgdexSetIdIn('Expedition Base Set', en, 'en', true), 'ecard1');
  assert.equal(ctx._tcgdexSetIdIn('Base Set Shadowless', en, 'en', true), 'base1');
  assert.equal(ctx._tcgdexSetIdIn('sv3pt5', en, 'en', true), 'sv03.5', 'sv3pt5 is sv03.5 (pt is a point, zeros are padding)');
  assert.equal(ctx._tcgdexSetIdIn('SV03.5', en, 'en', true), 'sv03.5');
  assert.equal(ctx._tcgdexSetIdIn('151', en, 'en', true), 'sv03.5');
  const ja = [{ id: 'A1', name: 'ポケモン' }, { id: 'A2', name: 'ポケモンカード151' }, { id: 'A3', name: 'カード' }];
  assert.equal(ctx._tcgdexSetIdIn('ポケモンカード151', ja, 'ja', true), 'A2', 'the longest Japanese name wins over the shorter ones inside it');
  // set words in a card NAME: only after the number, so the Pokemon before it never names a set
  assert.equal(ctx._tcgdexSetIdIn('Deoxys 4', en, 'en', false), '', '"Deoxys" is a Pokemon here, not the Deoxys set');
  assert.equal(ctx._tcgdexSetIdIn('Dragonite 5', en, 'en', false), '', 'and a set name is a whole word, never the start of one');
  assert.equal(ctx._tcgdexSetIdIn('Charizard 4 Dragon', en, 'en', false), 'ex3');
  assert.equal(ctx._tcgdexSetIdIn('Dragonite 5', en, 'en', true), '', 'whole words in a set field too');
});

test('art-ja: the static English table is the floor for English and is never used for another language', async () => {
  const { ctx } = await loadApp();
  assert.equal(ctx._tcgdexSetIdIn('Jungle'), 'base2', 'one argument, as before');
  assert.equal(ctx._tcgdexSetIdIn('Jungle', null, 'en', true), 'base2', 'no list, still the table');
  assert.equal(ctx._tcgdexSetIdIn('Jungle', [], 'en', true), 'base2');
  assert.equal(ctx._tcgdexSetIdIn('Jungle', null, 'ja', true), '', 'English set ids would match nothing in Japanese');
  assert.equal(ctx._tcgdexSetIdIn('Jungle Fossil'), '', 'a tie names neither, as before');
  const en = [{ id: 'base2', name: 'Jungle' }, { id: 'ex7', name: 'Team Rocket Returns' }, { id: 'base5', name: 'Team Rocket' }];
  assert.equal(ctx._tcgdexSetIdIn('Team Rocket Returns', en, 'en', true), 'ex7', 'the table and the list agree, no false tie');
});

// ── numbers ─────────────────────────────────────────────────────────────────────────────────────────
test('art-ja: two numbers compare as numbers ("6" is "006"), anything else must match exactly ("TG11")', async () => {
  const { ctx } = await loadApp();
  const m = ctx._kjrLocalIdMatches;
  for (const [a, b] of [['006', '6'], ['6', '006'], ['06', '6'], ['006', '006'], ['0', '000'], ['TG11', 'TG11'], ['tg11', 'TG11']]) assert.equal(m(a, b), true, a + ' vs ' + b);
  for (const [a, b] of [['007', '6'], ['016', '6'], ['66', '6'], ['TG111', 'TG11'], ['TG011', 'TG11'], ['TG01', 'TG11'], ['11', 'TG11'], ['TG11', '11'], ['067a', '67'], ['', '6'], [null, '6'], [undefined, '6'], ['6', '']]) assert.equal(m(a, b), false, a + ' vs ' + b);
});

test('art-ja: end to end, a number typed as "6" finds "006" and "TG11" finds only TG11', async () => {
  const a = await setup({ singles: [jp({ name: 'Charizard ex 6', set: '' })] });
  await a.runSingle('j1');
  assert.equal(a.single('j1').tcgdexId, 'SV2a-006');
  assert.equal(a.urls()[1], 'https://api.tcgdex.net/v2/ja/cards?name=' + CHARIZARD + '&localId=6', 'sent as typed, matched as a number');
  const promos = [{ id: 'S10b-TG11', localId: 'TG11', name: 'ピカチュウ' }, { id: 'S10b-TG111', localId: 'TG111', name: 'ピカチュウ' }, { id: 'S12a-TG01', localId: 'TG01', name: 'ピカチュウ' }, { id: 'SV1V-011', localId: '011', name: 'ピカチュウ' }];
  const b = await setup({ singles: [jp({ id: 'j2', name: 'Pikachu TG11', set: '' })] }, { search: promos });
  await b.runSingle('j2');
  assert.equal(b.single('j2').tcgdexId, 'S10b-TG11');
});

// ── species ─────────────────────────────────────────────────────────────────────────────────────────
test('art-ja: a trainer card maps to no species, stays a placeholder, and costs no TCGdex call after the map', async () => {
  const app = await setup({ singles: [jp({ name: "Boss's Orders 172 JP", set: '' })] });
  await app.runSingle('j1');
  assert.deepEqual(app.urls(), ['Assets/species-ja.json'], 'the map lookup only');
  assert.equal(app.tcgdex().length, 0);
  assert.equal(app.single('j1').tcgdexId, '');
  assert.equal(app.marks.length, 0);
  assert.equal(app.links()['s:j1'].miss, iso(0), 'a definite "no species" is a 7-day miss, not a failure');
  assert.deepEqual(plain(app.ctx.kjrArtState(app.single('j1'), 'singles')), { state: 'none' });
  // the next trainer card does not even read the map again
  const row2 = Object.assign({}, app.single('j1'), { id: 'j2', name: 'Ultra Ball 91', language: 'JP' });
  app.ctx.DB.singles.push(row2);
  await app.runSingle('j2');
  assert.deepEqual(app.urls(), ['Assets/species-ja.json'], 'the map is held in memory for the session');
  assert.equal(app.tcgdex().length, 0);
});

test('art-ja: species names derive from the card name, with rarity words, regional prefixes and punctuation set aside', async () => {
  const { ctx } = await loadApp();
  const idx = ctx._kjrSpeciesBuild(SPECIES);
  assert.equal(Object.keys(idx).length, Object.keys(SPECIES).length, 'no two species share a normalised key');
  const ja = (n) => ctx._kjrJaSpeciesFrom(idx, n);
  const cases = [
    ['Charizard ex 006', 'リザードン'], ['Charizard EX 13/106', 'リザードン'], ['charizard GX 20', 'リザードン'], ['Umbreon VMAX 215/203', 'ブラッキー'],
    ['Charizard VSTAR 18', 'リザードン'], ['Mewtwo BREAK 4', 'ミュウツー'], ['Dark Charizard 4', 'リザードン'], ['Radiant Charizard 011/078', 'リザードン'],
    ['Shining Mew 8', 'ミュウ'], ['Alolan Raichu 6', 'ライチュウ'], ['Galarian Zigzagoon 117', 'ジグザグマ'], ['Hisuian Zoroark VSTAR 99', 'ゾロアーク'],
    ["Misty's Psyduck 4", 'コダック'], ['Team Rocket’s Mewtwo ex 8', 'ミュウツー'], ['Charizard-EX 13', 'リザードン'], ['Mega Charizard X ex 013/108', 'リザードン'],
    ['Pikachu & Zekrom GX 33', 'ピカチュウ'], ['Pikachu with Grey Felt Hat 85', 'ピカチュウ'], ['Detective Pikachu 1', 'ピカチュウ'],
    ['Mr. Mime 6', 'バリヤード'], ['Mr Mime 6', 'バリヤード'], ['MR. MIME 6', 'バリヤード'], ['Galarian Mr. Mime 4', 'バリヤード'], ['Mime Jr. 3', 'マネネ'],
    ['Tapu Koko ex 5', 'カプ・コケコ'], ['Type: Null 140', 'タイプ：ヌル'], ['Iron Hands ex 12', 'テツノカイナ'],
    ["Farfetch'd 27", 'カモネギ'], ['Farfetch’d 27', 'カモネギ'], ['Nidoran♀ 29', 'ニドラン♀'], ['Nidoran♂ 32', 'ニドラン♂'], ['Nidoran F 29', 'ニドラン♀'],
    ['Flabébé 12', 'フラベベ'], ['Flabebe 12', 'フラベベ'], ['Ho-Oh 7', 'ホウオウ'], ['Ho Oh 7', 'ホウオウ'], ['Porygon-Z 9', 'ポリゴンZ'], ['Porygon2 12', 'ポリゴン2'],
    ['Charizard ex 006 JP', 'リザードン'], ['Charizard ex Alt Art 006', 'リザードン'],
  ];
  for (const [name, want] of cases) assert.equal(ja(name), want, name);
  for (const name of ["Boss's Orders 172", "Professor's Research 190", 'Ultra Ball 91', 'Fire Energy 2', 'Switch 194', 'Iono 185', '', null, undefined]) assert.equal(ja(name), null, String(name));
  assert.equal(ctx._kjrJaSpeciesFrom(null, 'Charizard 4'), null, 'no map, no answer');
});

test('art-ja: the species map is read once per session and never blocks a lookup that has no use for it', async () => {
  const app = await setup({ singles: [jp()] });
  const a = app.ctx._kjrSpeciesIndex(), b = app.ctx._kjrSpeciesIndex();
  assert.equal(app.fetchMock.calls.length, 1, 'two callers share one request while it is in flight');
  assert.equal(await a, await b);
  assert.equal(app.fetchMock.calls.length, 1);
  assert.equal(await app.ctx._kjrJaSpeciesName('Charizard ex 006'), 'リザードン');
  assert.equal(app.fetchMock.calls.length, 1, 'and held in memory afterwards');
  assert.equal(app.localStorage.getItem('kjr_species_ja'), null, 'memory only, nothing stored');
});

// ── failure handling ────────────────────────────────────────────────────────────────────────────────
test('art-ja: a species map that will not load degrades to the placeholder, no throw, no miss recorded, retried next session', async () => {
  const failures = {
    'fetch rejects': (app) => { app.route.species = () => { throw new TypeError('offline'); }; },
    'HTTP 404': (app) => { app.route.species = () => jsonResponse({}, 404); },
    'HTML instead of JSON': (app) => { app.route.species = () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } }); },
    'an array': (app) => { app.route.species = () => jsonResponse(['Charizard']); },
    'an empty object': (app) => { app.route.species = () => jsonResponse({}); },
    'only junk values': (app) => { app.route.species = () => jsonResponse({ Charizard: 5, Pikachu: null, Mew: '' }); },
  };
  for (const [label, fail] of Object.entries(failures)) {
    const app = await setup({ singles: [jp()] });
    fail(app);
    const report = {};
    let id;
    await assert.doesNotReject(async () => { id = await app.ctx.resolveTcgdexId({ name: 'Charizard ex 006', language: 'JP' }, { art: true, set: '151', report }); }, label);
    assert.equal(id, null, label);
    assert.equal(report.transient, true, label + ': "could not tell"');
    assert.equal(report.why, 'map', label);
    assert.equal(app.tcgdex().length, 0, label + ': no TCGdex call without a species');

    await app.runSingle('j1');
    assert.equal(app.single('j1').tcgdexId, '', label);
    assert.equal(app.marks.length, 0, label);
    assert.equal(app.localStorage.getItem('kjr_slab_card_ids'), null, label + ': no 7-day miss, so it is asked again next session');
    assert.equal(app.ctx.kjrArtState(app.single('j1'), 'singles').state, 'need', label + ': still a candidate');
    assert.equal(app.ctx._kjrImgQ.fails, 0, label + ': the app\'s own file failing does not pause the queue for everyone');
    assert.ok(app.ctx._kjrImgCool['single:j1'] > Date.now(), label + ': this row waits a minute');
    // inside the minute the map is not requested again
    const reads = () => app.fetchMock.calls.filter((c) => c.url.includes('species-ja.json')).length;
    const before = reads();
    await app.ctx.resolveTcgdexId({ name: 'Pikachu 25', language: 'JP' }, { art: true });
    assert.equal(reads(), before, label + ': not hammered');
    // a minute later it is
    app.ctx._kjrSpeciesFailAt -= 61000;
    app.route.species = () => jsonResponse(SPECIES);
    assert.equal(await app.ctx._kjrJaSpeciesName('Charizard ex 006'), 'リザードン', label + ': it recovers within the session');
  }
  // next session: a fresh page asks again and resolves
  const next = await setup({ singles: [jp()] });
  await next.runSingle('j1');
  assert.equal(next.single('j1').tcgdexId, 'SV2a-006');
});

test('art-ja: a TCGdex failure or an offline lookup is "could not tell", never a 7-day miss', async () => {
  for (const [label, fail] of [
    ['HTTP 500', (app) => { app.route.search = () => jsonResponse({}, 500); }],
    ['fetch rejects', (app) => { app.route.search = () => { throw new TypeError('offline'); }; }],
    ['an object instead of a list', (app) => { app.route.search = () => jsonResponse({ error: 'x' }); }],
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
  app.route.search = () => { app.single('j1').name = 'Charizard ex 125'; return jsonResponse(LIVE_SEARCH_006); };
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, '', 'the answer was for 006, the row now says 125');
  assert.equal(app.marks.length, 0);
  assert.equal(app.localStorage.getItem('kjr_slab_card_ids'), null);
  assert.equal(app.ctx.kjrArtState(app.single('j1'), 'singles').state, 'need', 'the next render asks about the new name');
  // a row whose language changed meanwhile is no longer a Japanese single
  const app2 = await setup({ singles: [jp()] });
  app2.route.search = () => { app2.single('j1').language = 'EN'; return jsonResponse(LIVE_SEARCH_006); };
  await app2.runSingle('j1');
  assert.equal(app2.single('j1').tcgdexId, '');
});

test('art-ja: an id typed into the edit modal while the lookup ran wins, ours is dropped and only its image is fetched', async () => {
  const app = await setup({ singles: [jp()] });
  app.route.search = () => { app.single('j1').tcgdexId = 'SV3-066'; return jsonResponse(LIVE_SEARCH_006); };
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
  assert.equal(early.urls().filter((u) => u.includes('/cards?name=')).length, 0, 'an id on the row is never searched for');
  assert.equal(early.marks.length, 0);
});

test('art-ja: a row deleted while its lookup ran is left alone, and an id the image cache cannot hold is a miss, not a write', async () => {
  const app = await setup({ singles: [jp()] });
  app.route.search = () => { app.ctx.DB.singles.splice(0, 1); return jsonResponse(LIVE_SEARCH_006); };
  await assert.doesNotReject(() => app.runSingle('j1'));
  assert.equal(app.marks.length, 0);
  assert.equal(app.localStorage.getItem('kjr_slab_card_ids'), null);
  const odd = await setup({ singles: [jp()] }, { search: [{ id: 'SM1+-006', localId: '006', name: 'リザードンex' }], sets: [] });
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

// ── the set list ────────────────────────────────────────────────────────────────────────────────────
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

test('art-ja: when the set list cannot be fetched the static English tokens still work, a stale list beats none, a failure is not hammered', async () => {
  const app = await setup({ singles: [jp()] });
  app.route.sets = () => { throw new TypeError('offline'); };
  assert.equal(await app.ctx._kjrTcgdexSets('ja'), null, 'no list to use');
  assert.equal(app.fetchMock.calls.length, 1);
  assert.equal(await app.ctx._kjrTcgdexSets('ja'), null);
  assert.equal(app.fetchMock.calls.length, 1, 'not retried inside a minute');
  assert.equal(app.localStorage.getItem('kjr_tcgdex_sets_v1:ja'), null, 'a failure stores nothing');
  assert.equal(app.ctx._tcgdexSetIdIn('Charizard 4 Jungle', null, 'en', false), 'base2', 'the static table answers when there is no list');
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

test('art-ja: the set list is only fetched when its answer could change the pick', async () => {
  const none = await setup({ singles: [jp({ set: '' })] });
  await none.runSingle('j1');
  assert.equal(none.urls().filter((u) => u.endsWith('/ja/sets')).length, 0, 'unique candidate, no set text');
  assert.equal(none.single('j1').tcgdexId, 'SV2a-006');
  const withSet = await setup({ singles: [jp({ set: 'SV2a' })] });
  await withSet.runSingle('j1');
  assert.equal(withSet.urls().filter((u) => u.endsWith('/ja/sets')).length, 1, 'a set field is always checked against the list');
  const jpTag = await setup({ singles: [jp({ set: '', name: 'Charizard ex 006 JP' })] });
  await jpTag.runSingle('j1');
  assert.equal(jpTag.urls().filter((u) => u.endsWith('/ja/sets')).length, 0, 'words after the number only matter when several candidates are left');
});

// ── slabs ───────────────────────────────────────────────────────────────────────────────────────────
test('art-ja: a Japanese slab resolves on /ja/, kjrImgRun fetches /ja/cards/SV2a-006, the slab row stays untouched', async () => {
  const app = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab()] });
  const rowsBefore = JSON.stringify(app.ctx.DB.slabs);
  const dirtyBefore = JSON.stringify([...app.ctx._dirty.slabs]);
  assert.deepEqual(plain(app.ctx.kjrArtState(app.slab('p1'), 'slabs')), { state: 'need', key: 'slab:p1', slab: 'p1', lang: 'ja' });
  await app.runSlab('p1');
  const urls = app.urls();
  assert.equal(urls[0], 'Assets/species-ja.json');
  assert.equal(urls[1], 'https://api.tcgdex.net/v2/ja/cards?name=' + CHARIZARD + '&localId=006');
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
  en.fetchMock.route('/en/cards?name=', () => jsonResponse([{ id: 'swsh7-215', localId: '215', name: 'Umbreon VMAX' }]));
  en.fetchMock.route('/en/cards/swsh7-215', () => jsonResponse({ id: 'swsh7-215', image: 'https://assets.tcgdex.net/en/swsh/swsh7/215' }));
  await en.run({ key: 'slab:p1', slab: 'p1', lang: 'en' });
  assert.deepEqual(en.urls(), ['https://api.tcgdex.net/v2/en/cards?name=Umbreon VMAX&localId=215', 'https://api.tcgdex.net/v2/en/cards/swsh7-215'], 'no species map, no set list');
  assert.deepEqual(plain(en.links()), { p1: { id: 'swsh7-215', n: 'Umbreon VMAX 215/203|en' } });
});

test('art-ja: a Japanese slab that does not resolve is a 7-day miss, one that could not be asked is not', async () => {
  const app = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab({ name: "Boss's Orders 172" })] });
  await app.runSlab('p1');
  assert.deepEqual(plain(app.links()), { p1: { miss: iso(0), n: "Boss's Orders 172|ja|set:151" } });
  assert.equal(app.ctx.kjrArtState(app.slab('p1'), 'slabs').state, 'none');
  const down = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab()] });
  down.route.species = () => { throw new TypeError('offline'); };
  await down.runSlab('p1');
  assert.equal(down.localStorage.getItem('kjr_slab_card_ids'), null, 'the species map failing is not a miss');
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
test('art-ja: an English slab whose modern set the static table does not know is un-stuck by the fetched set list', async () => {
  const cands = [{ id: 'basep-25', localId: '25', name: 'Pikachu' }, { id: 'cel25-25', localId: '25', name: 'Pikachu' }, { id: 'sv03.5-025', localId: '025', name: 'Pikachu' }];
  const run = async (slabSet, setList, extra) => {
    const app = await setup({ singles: [jp({ id: 'keep' })], slabs: [jpSlab({ language: 'EN', name: 'Pikachu 25', set: slabSet })] });
    app.fetchMock.route('/en/cards?name=', () => jsonResponse(cands));
    app.fetchMock.route('/en/cards/', (u) => jsonResponse({ id: u.split('/').pop(), image: 'https://assets.tcgdex.net/en/x/y/z' }));
    app.fetchMock.route('/en/sets', setList || (() => jsonResponse([{ id: 'cel25', name: 'Celebrations' }, { id: 'sv03.5', name: '151' }, { id: 'basep', name: 'Wizards Black Star Promos' }])));
    await app.run({ key: 'slab:p1', slab: 'p1', lang: 'en' });
    return app;
  };
  const a = await run('Celebrations');
  assert.equal(a.links().p1.id, 'cel25-25', 'Celebrations is not in the 17-entry table, the list names it');
  assert.equal(a.urls().filter((u) => u.endsWith('/en/sets')).length, 1);
  const b = await run('151');
  assert.equal(b.links().p1.id, 'sv03.5-025', 'the set "151" is a name in the English list');
  const c = await run('sv3pt5');
  assert.equal(c.links().p1.id, 'sv03.5-025', 'and sv3pt5 is its id');
  const d = await run('Celebrations', () => { throw new TypeError('offline'); });
  assert.equal(d.links().p1.miss, iso(0), 'no list: the old behaviour, ambiguous stays unresolved');
  const e = await run('Base Set');
  assert.equal(e.urls().filter((u) => u.endsWith('/en/sets')).length, 0, 'a set the static table already knows never needs the list');
  assert.equal(e.links().p1.miss, iso(0), 'and base1 matches none of the three');
});

test('art-ja: pricing resolves exactly as before, it never reads the species map or the set list, Japanese included', async () => {
  const app = await setup({ singles: [jp({ id: 'keep' })] });
  app.fetchMock.route('/en/cards?name=', () => jsonResponse([{ id: 'base2-5' }, { id: 'base3-5' }]));
  app.fetchMock.route('/ja/cards?name=', () => jsonResponse([]));
  // English, set words in the name: the static table decides, as it always did
  const en = { name: 'Gyarados 5 Jungle', language: 'EN' };
  assert.equal(await app.ctx.resolveTcgdexId(en), 'base2-5');
  assert.equal(await app.ctx.resolveTcgdexId({ name: 'Gyarados 5', language: 'EN' }), null);
  // a set field alone never reaches pricing, and without opts.art a hint is static-only
  assert.equal(await app.ctx.resolveTcgdexId({ name: 'Gyarados 5', language: 'EN' }, { set: 'Jungle' }), 'base2-5');
  // Japanese with no opts is the old English-name search on /ja/, not the species path
  assert.equal(await app.ctx.resolveTcgdexId({ name: 'Charizard ex 006', language: 'JP' }), null);
  assert.equal(await app.ctx.resolveTcgdexId({ name: 'Charizard ex 006', language: 'JP' }, { set: '151' }), null, 'a set hint is not the art flag');
  assert.deepEqual(app.urls().filter((u) => u.includes('/ja/')), [
    'https://api.tcgdex.net/v2/ja/cards?name=Charizard ex&localId=006',
    'https://api.tcgdex.net/v2/ja/cards?name=Charizard ex&localId=006',
  ]);
  assert.equal(app.urls().filter((u) => u.includes('species-ja') || u.endsWith('/sets')).length, 0);
  // an id already on the item short-circuits, art or not
  const calls = app.fetchMock.calls.length;
  assert.equal(await app.ctx.resolveTcgdexId({ name: 'Charizard ex 006', language: 'JP', tcgdexId: 'SV3-066' }, { art: true }), 'SV3-066');
  assert.equal(app.fetchMock.calls.length, calls);
  // Chinese stays on its old path even for an art lookup: no species map, no list
  app.fetchMock.route('/zh-tw/cards?name=', () => jsonResponse([{ id: 'sv1-25' }]));
  const cn = { name: 'Pikachu 25', language: 'CN' };
  assert.equal(await app.ctx.resolveTcgdexId(cn, { art: true, set: 'x' }), 'sv1-25');
  assert.deepEqual(app.urls().filter((u) => u.includes('/zh-tw/')), ['https://api.tcgdex.net/v2/zh-tw/cards?name=Pikachu&localId=25']);
  assert.equal(app.urls().filter((u) => u.includes('species-ja') || u.endsWith('/sets')).length, 0);
});

// ── pricing isolation ───────────────────────────────────────────────────────────────────────────────
// A Japanese single that now carries an id is still manual-priced: zero price calls in the daily queue, in a manual "run now" and in
// refreshPrice, with or without the art lookup having just run. An English control row proves the queue really ran.
test('art-ja: a Japanese single with an id makes zero price calls in refreshPrice, even right after the art lookup wrote it', async () => {
  const app = await setup({ singles: [jp()] });
  await app.runSingle('j1');
  assert.equal(app.single('j1').tcgdexId, 'SV2a-006');
  app.fetchMock.calls.length = 0;
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(String(m));
  app.fetchMock.route('/ppt/cards', () => jsonResponse({ data: [{ name: 'Charizard', number: '6', prices: { market: 99 } }] }));
  app.fetchMock.route('frankfurter.dev', () => jsonResponse({ rates: { SGD: 1 } }));
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.fetchMock.calls.length, 0, 'no TCGdex, no PPT, not even an FX lookup: ' + app.urls().join(', '));
  assert.deepEqual(toasts, ['Manual price, no free source for this language']);
  const row = app.single('j1');
  assert.equal(Number(row.marketPrice), 30, 'the hand-set price is untouched');
  assert.equal((row.priceHistory || []).length, 0);
  assert.equal(app.ctx._queueLaneFor(row), 'manual', 'the lane stays language-based, an id does not move it');
  assert.equal(app.ctx._queueLaneFor(Object.assign({}, row, { tcgdexId: '' })), 'manual');
});

for (const manual of [false, true]) {
  test('art-ja: a Japanese single carrying an id makes zero price calls in the ' + (manual ? 'manual "run now"' : 'daily') + ' queue, an English single beside it is priced', async () => {
    const seed = makeSeed({ singles: [
      jp({ tcgdexId: 'SV2a-006', _tcgdexResolvedName: 'リザードンex' }),
      jp({ id: 'j2', name: 'Pikachu 025', tcgdexId: 'SV2a-025', set: '' }),
      jp({ id: 'j3', name: 'Mew ex 151', tcgdexId: '' }), // no id yet: still manual, still no call
      jp({ id: 'en1', name: 'Pikachu 25', language: 'EN', tcgdexId: 'sv3-199', set: 'Scarlet', marketPrice: '', priceHistory: [] }),
    ] });
    const app = await loadApp({ seed });
    app.fetchMock.calls.length = 0;
    app.urls = () => app.fetchMock.calls.map((c) => decodeURIComponent(c.url));
    app.fetchMock.route('/cards/sv3-199', () => jsonResponse({ id: 'sv3-199', pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } }));
    app.fetchMock.route('frankfurter.dev', () => jsonResponse({ rates: { SGD: 1 } }));
    app.fetchMock.route('/ppt/cards', () => jsonResponse({ data: [{ name: 'Charizard', number: '6', prices: { market: 99 } }] }));
    app.fetchMock.route('/ja/', () => jsonResponse([{ id: 'SV2a-006', localId: '006', name: 'リザードンex' }]));
    app.ctx.toast = () => {};
    const q = app.ctx.buildRefreshQueue();
    const lanes = Object.fromEntries(plain(q.items).map((i) => [i.id, i.lane]));
    assert.deepEqual(lanes, { en1: 'tcgdex' }, 'only the English single is in the queue at all, the Japanese rows are manual');
    const jpBefore = JSON.stringify(app.ctx.DB.singles.filter((r) => r.language === 'JP'));
    const dirtyBefore = [...app.ctx._dirty.singles];
    await app.ctx.runRefreshQueue(manual);
    await app.settle(40);
    const urls = app.urls();
    assert.ok(urls.some((u) => u.endsWith('/cards/sv3-199')), 'control: the queue ran and priced the English row');
    assert.equal(app.ctx.DB.singles.find((r) => r.id === 'en1').marketPrice, '45');
    assert.deepEqual(urls.filter((u) => u.includes('/ja/') || u.includes('/ppt/') || u.includes('species-ja') || u.endsWith('/sets')), [], 'not one Japanese, PPT, species or set call');
    assert.equal(JSON.stringify(app.ctx.DB.singles.filter((r) => r.language === 'JP')), jpBefore, 'the Japanese rows are byte for byte the same');
    assert.deepEqual([...app.ctx._dirty.singles].filter((id) => id !== 'en1' && !dirtyBefore.includes(id)), [], 'and none of them is marked dirty');
  });
}

// ── what the pieces are made of ─────────────────────────────────────────────────────────────────────
test('art-ja: Assets/species-ja.json is the generated map, about a thousand entries, and stays out of the service worker precache', async () => {
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
  assert.ok(fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').includes("'Assets/species-ja.json'"));
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
