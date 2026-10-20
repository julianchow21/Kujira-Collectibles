'use strict';
// v3.85, the slab side of PokemonPriceTracker pricing. A slab search asks for the graded eBay data (includeEbay=true, limit=3 always), reads
// the price off card.ebay.salesByGrade[key] in the vendor's own order of trust, builds the key from _resolveGrader so "PSA 10" in either
// field works, and takes the card whose number is the slab's when several come back. Fetch is stubbed (tests/harness.js), nothing here
// reaches a real API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, plain } = require('./harness.js');

// salesByGrade as the vendor sent it on 21/10/2026: one entry per grade, a key like psa10, cgc9 or bgs9_5
const grade = (o) => Object.assign({
  count: 6, averagePrice: 5200, medianPrice: 5100, marketPrice7Day: 5000, marketPriceMedian7Day: 4900,
  smartMarketPrice: { price: 4800, confidence: 'high', method: 'median' }, lastSaleDate: '2026-10-18',
}, o);
const card = (o) => Object.assign({
  id: 'pk-4', name: 'Charizard', setName: 'Base Set', cardNumber: '4/102', prices: { market: 300 },
  ebay: { salesByGrade: { psa10: grade() } },
}, o);
// the answer, with the metadata the vendor attaches (a limit=3 search with includeEbay=true costs up to 6 credits)
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total: total === undefined ? 6 : total, breakdown: { cards: 3, ebay: 3 }, costPerCard: 2 } } });
const slab = (o) => Object.assign({
  id: 'sl1', name: 'Charizard 4', type: 'slab', grader: 'PSA', grade: '10', language: 'EN', costPrice: 500,
  marketPrice: '', listPrice: '', status: 'Available', priceHistory: [],
}, o);

async function setup(rows, respond) {
  const app = await loadApp({ seed: { singles: [], slabs: rows || [slab()] } });
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(String(m));
  app.ctx.toastError = (m) => toasts.push('ERR ' + String(m));
  app.toasts = toasts;
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  app.fetchMock.route('/ppt/cards', respond || (() => answer([card()])));
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.params = (i) => new URL(app.ppt()[i === undefined ? 0 : i].url).searchParams;
  app.row = (id) => app.ctx.DB.slabs.find((r) => r.id === id);
  return app;
}

// ── the request ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-slabs: a slab search sends includeEbay=true and limit=3, and nothing else the Worker would refuse', async () => {
  const app = await setup();
  const r = await app.ctx.fetchPriceFromPPT('Charizard 4', 'PSA', '10', 'EN');
  assert.equal(r.priceUsd, 4800);
  assert.equal(app.ppt().length, 1);
  const url = new URL(app.ppt()[0].url);
  assert.equal(url.pathname, '/ppt/cards');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['includeEbay', 'limit', 'search']);
  assert.equal(url.searchParams.get('search'), 'Charizard 4');
  assert.equal(url.searchParams.get('limit'), '3');
  assert.equal(url.searchParams.get('includeEbay'), 'true');
});

test('ppt-slabs: a Japanese slab keeps the word in the search text and still sends only the allowed flags', async () => {
  const app = await setup();
  await app.ctx.fetchPriceFromPPT('Charizard 4', 'PSA', '10', 'JP');
  const p = app.params();
  assert.equal(p.get('search'), 'Charizard 4 japanese');
  assert.equal(p.get('includeEbay'), 'true');
  assert.equal(p.has('language'), false, 'language=japanese is the Japanese single lane\'s flag, a slab\'s language rides in the search text as before');
});

test('ppt-slabs: the raw fuzzy lookup (price check, bulk refresh) asks for no eBay data', async () => {
  const app = await setup();
  await app.ctx.fetchPriceFromPPT('Charizard 4', null, null, 'EN');
  assert.equal(app.params().has('includeEbay'), false);
});

// ── the price, in the vendor's order of trust ─────────────────────────────────────────────────────────────────────────────────────

test('ppt-slabs: the price is the first of smartMarketPrice.price, marketPriceMedian7Day, medianPrice, averagePrice, then the old avg', async () => {
  const ctx = (await loadApp()).ctx;
  const entry = { smartMarketPrice: { price: 4800 }, marketPriceMedian7Day: 4900, medianPrice: 5100, averagePrice: 5200, avg: 5300 };
  const pick = (e) => ctx._pptEbayGradePrice({ ebay: { salesByGrade: { psa10: e } } }, 'PSA', '10');
  assert.equal(pick(entry), 4800);
  delete entry.smartMarketPrice; assert.equal(pick(entry), 4900);
  delete entry.marketPriceMedian7Day; assert.equal(pick(entry), 5100);
  delete entry.medianPrice; assert.equal(pick(entry), 5200);
  delete entry.averagePrice; assert.equal(pick(entry), 5300, 'the old avg is the last resort');
  delete entry.avg; assert.equal(pick(entry), 0, 'nothing to read is no price, never a guess');
});

test('ppt-slabs: a field that is zero, null, text or negative is skipped for the next one', async () => {
  const ctx = (await loadApp()).ctx;
  const pick = (e) => ctx._pptEbayGradePrice({ ebay: { salesByGrade: { psa10: e } } }, 'PSA', '10');
  assert.equal(pick({ smartMarketPrice: { price: 0 }, marketPriceMedian7Day: null, medianPrice: 'n/a', averagePrice: -4, avg: '77.5' }), 77.5, 'a numeric string is read, the rest are not prices');
  assert.equal(pick({ smartMarketPrice: null, marketPriceMedian7Day: undefined, medianPrice: 5100 }), 5100);
  assert.equal(pick({ smartMarketPrice: 'oops', averagePrice: 12 }), 12, 'smartMarketPrice that is not an object is ignored');
  assert.equal(pick(null), 0);
  assert.equal(pick('psa10'), 0);
});

test('ppt-slabs: the older answer shape, card.ebay.psa10.avg, still prices', async () => {
  const ctx = (await loadApp()).ctx;
  assert.equal(ctx._pptEbayGradePrice({ ebay: { psa10: { avg: 500 } } }, 'PSA', '10'), 500);
  assert.equal(ctx._pptEbayGradePrice({ ebay: { psa10: { avg: 500 }, salesByGrade: { psa10: grade() } } }, 'PSA', '10'), 4800, 'salesByGrade wins when both are there');
  assert.equal(ctx._pptEbayGradePrice({ ebay: { psa10: { avg: 500 }, salesByGrade: {} } }, 'PSA', '10'), 500, 'and the old key answers when salesByGrade has no such grade');
  assert.equal(ctx._pptEbayGradePrice({ ebay: { salesByGrade: { psa9: grade() } } }, 'PSA', '10'), 0, 'another grade is never substituted');
  assert.equal(ctx._pptEbayGradePrice({}, 'PSA', '10'), 0);
  assert.equal(ctx._pptEbayGradePrice(null, 'PSA', '10'), 0);
});

test('ppt-slabs: a half grade is found under bgs9_5, bgs95 or bgs9.5, in any case', async () => {
  const ctx = (await loadApp()).ctx;
  for (const key of ['bgs9_5', 'bgs95', 'bgs9.5', 'BGS9_5', 'Bgs_9_5']) {
    assert.equal(ctx._pptEbayGradePrice({ ebay: { salesByGrade: { [key]: grade({ smartMarketPrice: { price: 700 } }) } } }, 'BGS', '9.5'), 700, key);
  }
  assert.equal(ctx._pptEbayGradePrice({ ebay: { salesByGrade: { bgs9: grade() } } }, 'BGS', '9.5'), 0, 'bgs9 is not bgs9.5');
  assert.equal(ctx._pptEbayGradePrice({ ebay: { salesByGrade: { bgs9_5: grade() } } }, 'BGS', '9'), 0, 'and bgs9_5 is not bgs9');
  assert.equal(ctx._pptEbayGradePrice({ ebay: { salesByGrade: { cgc10: grade() } } }, 'PSA', '10'), 0, 'another grader is never substituted');
});

test('ppt-slabs: a PSA 9.5-style grade written both ways prices end to end', async () => {
  const bgs = card({ ebay: { salesByGrade: { bgs9_5: grade({ smartMarketPrice: { price: 910 } }) } } });
  const app = await setup([slab({ id: 'b1', grader: 'BGS', grade: '9.5' })], () => answer([bgs]));
  const r = await app.ctx.fetchPriceFromPPT('Charizard 4', 'BGS', '9.5', 'EN');
  assert.equal(r.priceUsd, 910);
  assert.equal(r.source, 'PPT (BGS 9.5)');
});

// ── "PSA 10" in the grade field ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-slabs: "PSA 10" typed into the grade field alone is a slab, in the lane, the queue entry and the request', async () => {
  const row = slab({ id: 'g1', grader: '', grade: 'PSA 10' });
  const app = await setup([row]);
  assert.equal(app.ctx._queueLaneFor(row), 'ppt', 'the lane reads the resolver, not the grader field');
  const q = plain(app.ctx.buildRefreshQueue());
  assert.deepEqual(q.items.map((i) => [i.id, i.lane, i.grader, i.grade]), [['g1', 'ppt', 'PSA', '10']], 'the entry carries the canonical grader and grade');
  await app.ctx.refreshPrice('g1', 'slabs');
  assert.equal(app.ppt().length, 1);
  assert.equal(app.params().get('includeEbay'), 'true');
  assert.equal(app.row('g1').marketPrice, '4800');
  assert.equal(app.row('g1').priceHistory[0].source, 'PPT (PSA 10)');
  assert.equal(app.row('g1').priceHistory[0].confidence, 'medium');
});

test('ppt-slabs: the same slab spelled three ways is one lookup', async () => {
  const app = await setup([
    slab({ id: 'a', grader: 'PSA', grade: '10', costPrice: 30 }),
    slab({ id: 'b', grader: '', grade: 'PSA 10', costPrice: 20 }),
    slab({ id: 'c', grader: 'psa 10', grade: '', costPrice: 10 }),
  ]);
  const q = plain(app.ctx.buildRefreshQueue());
  assert.equal(q.items.length, 1, 'one primary');
  assert.equal(q.items[0].id, 'a');
  assert.deepEqual(q.items[0].copyTargets.map((t) => t.id).sort(), ['b', 'c'], 'the others are copies and take its price');
  assert.equal(q.totalRows, 3);
});

test('ppt-slabs: a grade the resolver can not read is a miss with no request, not 6 credits for a certain miss', async () => {
  const app = await setup();
  for (const [g, gr] of [['Beckett', '9.5'], ['AGS', '10'], ['PSA', 'Gem Mint'], ['Mint', '10']]) {
    const r = await app.ctx.fetchPriceFromPPT('Charizard 4', g, gr, 'EN');
    assert.equal(r.error, 'unrecognised grader or grade', g + ' ' + gr);
    assert.equal(r._ppt_requests, 0);
    assert.equal(r._ppt_credits, undefined, 'and nothing is billed');
  }
  assert.equal(app.ppt().length, 0, 'no search was made for any of them');
});

test('ppt-slabs: a grader with no grade is never priced as a raw card', async () => {
  const app = await setup();
  app.fetchMock.route('api.tcgdex.net', { ok: true, json: [{ id: 'sv3-199' }] });
  const r = await app.ctx.fetchMarketPrice({ name: 'Charizard 4', grader: 'PSA', grade: '', language: 'EN' });
  assert.equal(r.maxSgd, null);
  assert.equal(r.pptError, 'unrecognised grader or grade');
  assert.equal(r.creditsUsed, 0);
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net') || c.url.includes('/ppt/')).length, 0, 'neither TCGdex nor PPT was asked');
});

// ── several cards come back ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-slabs: of several cards the one whose number is the slab\'s is priced', async () => {
  const wrong = card({ id: 'pk-x', name: 'Charizard', setName: 'Other Set', cardNumber: '3/102', ebay: { salesByGrade: { psa10: grade({ smartMarketPrice: { price: 111 } }) } } });
  const right = card({ id: 'pk-4', setName: 'Base Set', cardNumber: '4/102' });
  const app = await setup([slab()], () => answer([wrong, right]));
  const r = await app.ctx.fetchPriceFromPPT('Charizard 4', 'PSA', '10', 'EN');
  assert.equal(r.priceUsd, 4800, 'the card numbered 4');
  assert.equal(r.ambiguous, false, 'one card had that number');
});

test('ppt-slabs: the slab\'s number is read as a number, "025/165" is 25 and "4/102" is 4', async () => {
  const ctx = (await loadApp()).ctx;
  assert.equal(ctx._kjrCardNumberMatches('025/165', '25'), true);
  assert.equal(ctx._kjrCardNumberMatches('4/102', '4'), true);
  assert.equal(ctx._kjrCardNumberMatches('SV2a 205/165', '205'), true);
  assert.equal(ctx._kjrCardNumberMatches('TG11/TG30', 'TG11'), true);
  assert.equal(ctx._kjrCardNumberMatches('TG11/TG30', 'TG1'), false, 'TG1 is not TG11');
  assert.equal(ctx._kjrCardNumberMatches('44', '4'), false);
  assert.equal(ctx._kjrCardNumberMatches('', '4'), false);
  assert.equal(ctx._kjrCardNumberMatches('4/102', ''), false);
});

test('ppt-slabs: when every card states another number the slab gets no price, never the wrong card\'s', async () => {
  const a = card({ id: 'pk-a', cardNumber: '3/102' }), b = card({ id: 'pk-b', cardNumber: '5/102' });
  const app = await setup([slab()], () => answer([a, b]));
  const r = await app.ctx.fetchPriceFromPPT('Charizard 4', 'PSA', '10', 'EN');
  assert.equal(r.priceUsd, undefined);
  assert.equal(r.error, 'no match');
  assert.equal(app.ppt().length, 2, 'the base-name fallback search ran (and found the same two)');
});

test('ppt-slabs: cards that state no number are not ruled out, and a slab with no number in its name takes the best name match as before', async () => {
  const bare = card({ cardNumber: undefined, number: undefined });
  const app = await setup([slab()], () => answer([bare]));
  assert.equal((await app.ctx.fetchPriceFromPPT('Charizard 4', 'PSA', '10', 'EN')).priceUsd, 4800, 'the vendor gave no number to check against');
  assert.equal((await app.ctx.fetchPriceFromPPT('Charizard', 'PSA', '10', 'EN')).priceUsd, 4800, 'and a name without a number has nothing to filter by');
});

test('ppt-slabs: two cards carrying the slab\'s number is a low confidence price, not a medium one', async () => {
  const a = card({ id: 'pk-a', setName: 'Base Set', cardNumber: '4/102' });
  const b = card({ id: 'pk-b', setName: 'Base Set 2', cardNumber: '4/130', ebay: { salesByGrade: { psa10: grade({ smartMarketPrice: { price: 999 } }) } } });
  const app = await setup([slab({ name: 'Charizard 4 Base Set' })], () => answer([a, b]));
  const r = await app.ctx.fetchMarketPrice({ name: 'Charizard 4 Base Set', grader: 'PSA', grade: '10', language: 'EN' });
  assert.equal(r.maxUsd, 4800, 'the better name match of the two');
  assert.equal(r.confidence, 'low', 'but it was a pick between cards that all had the number');
});

test('ppt-slabs: the vendor\'s cardNumber now reaches the name scoring (the number bonus used to read a field the vendor never sends)', async () => {
  const ctx = (await loadApp()).ctx;
  const hit = { name: 'Charizard', cardNumber: '4/102' }, miss = { name: 'Charizard', cardNumber: '9/102' };
  assert.equal(ctx._pickBestMatch([miss, hit], 'Charizard 4', ''), hit, 'the matching number wins over the same name');
  const older = { name: 'Charizard', number: '4' };
  assert.equal(ctx._pickBestMatch([{ name: 'Charizard', number: '9' }, older], 'Charizard 4', ''), older, 'the older number field still scores');
});

// ── the queue and the router ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-slabs: a priced slab goes into the history with its USD unit, source and confidence, and a replaced hand price is replaced in one write', async () => {
  const app = await setup([slab({ marketPrice: 4000 })]); // a hand-typed price, no history
  await app.ctx.refreshPrice('sl1', 'slabs');
  const row = app.row('sl1');
  assert.equal(row.marketPrice, '4800');
  assert.equal(row.priceHistory.length, 1);
  assert.deepEqual(plain(row.priceHistory[0]), { date: new Date().toISOString().slice(0, 10), price: 4800, unit: 'USD', source: 'PPT (PSA 10)', confidence: 'medium' });
  assert.equal(app.ctx._dirty.slabs.has('sl1'), true, 'and the replacement syncs');
});

test('ppt-slabs: the router bills a slab search by its metadata and falls back to 6 credits when there is none', async () => {
  let total = 6;
  const app = await setup([slab()], () => answer([card()], total));
  assert.equal((await app.ctx.fetchMarketPrice({ name: 'Charizard 4', grader: 'PSA', grade: '10', language: 'EN' })).creditsUsed, 6);
  total = 4; // two cards came back, 2 x 2
  assert.equal((await app.ctx.fetchMarketPrice({ name: 'Charizard 4', grader: 'PSA', grade: '10', language: 'EN' })).creditsUsed, 4);
  app.fetchMock.route('/ppt/cards', () => jsonResponse({ data: [card()] })); // no metadata at all
  assert.equal((await app.ctx.fetchMarketPrice({ name: 'Charizard 4', grader: 'PSA', grade: '10', language: 'EN' })).creditsUsed, 6, 'estimated: 3 for the search, 3 for eBay');
});
