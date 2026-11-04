'use strict';
// Suite 12: price-router (mocked fetch) - fetchMarketPrice, resolveTcgdexId (v4.1: a thin client of the Worker's GET /resolve).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

test('price-router: slab descriptor hits the PPT worker URL and never touches TCGdex', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/ppt/cards', { ok: true, json: { data: [{ name: 'Charizard', number: '4', ebay: { psa10: { avg: 500 } } }] } });
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1.35 }] });

  const result = await ctx.fetchMarketPrice({ name: 'Charizard', grader: 'PSA', grade: '10', language: 'EN' });

  assert.strictEqual(result.maxUsd, 500);
  assert.ok(result.source.includes('PPT'));
  assert.strictEqual(result.tcgdexError, 'not applicable');
  assert.ok(!fetchMock.calls.some(c => c.url.includes('api.tcgdex.net')), 'a slab must never call TCGdex at all');
  assert.ok(fetchMock.calls.some(c => c.url.includes('/ppt/cards')), 'the PPT worker proxy was actually hit');
});

test('price-router: PPT primary and fallback searches use the Worker limit=3 contract', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/ppt/cards', [
    { ok: true, json: { data: [] } },
    { ok: true, json: { data: [] } },
  ]);

  const result = await ctx.fetchPriceFromPPT('Charizard 4', 'PSA', '10', 'EN');
  const calls = fetchMock.calls.filter(c => c.url.includes('/ppt/cards'));
  const urls = calls.map(c => new URL(c.url));

  assert.strictEqual(result.error, 'no match');
  assert.strictEqual(result._ppt_requests, 2, 'both successful empty responses remain billable attempts');
  assert.deepStrictEqual(urls.map(u => u.searchParams.get('search')), ['Charizard 4', 'Charizard']);
  assert.deepStrictEqual(urls.map(u => u.searchParams.get('limit')), ['3', '3'], 'primary and fallback must obey the Worker contract');
});

test('price-router: PPT HTTP 400 stays non-billable and does not trigger fallback', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/ppt/cards', { ok: false, status: 400, text: 'invalid query' });

  const result = await ctx.fetchPriceFromPPT('Charizard 4', 'PSA', '10', 'EN');
  const calls = fetchMock.calls.filter(c => c.url.includes('/ppt/cards'));

  assert.strictEqual(result.error, 'HTTP 400');
  assert.strictEqual(result._ppt_requests, 0, 'a rejected request must not spend a credit');
  assert.strictEqual(calls.length, 1, 'transport failure must not run the fallback search');
  assert.strictEqual(new URL(calls[0].url).searchParams.get('limit'), '3');
});

test('price-router: tcgdexOnly:true + TCGdex miss -> clean unpriced result with ZERO PPT calls (the 403-hammering regression)', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.resolve({ id: null }); // the Worker's /resolve: a definitive miss -> unresolved
  fetchMock.route('/ppt/cards', { ok: true, json: { data: [{ name: 'should never be requested', number: '1' }] } });

  const result = await ctx.fetchMarketPrice({ name: 'Pikachu 25', language: 'EN', tcgdexOnly: true });

  assert.strictEqual(result.maxSgd, null);
  assert.strictEqual(result.pptError, 'not applicable');
  assert.ok(result.tcgdexError, 'a tcgdex error/miss reason is reported');
  assert.ok(!fetchMock.calls.some(c => c.url.includes('/ppt/cards')), 'tcgdexOnly must suppress ANY PPT fallback request, even on a miss');
});

test('price-router: raw EN single happy path - TCGdex resolves and prices via TCGplayer holofoil', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.resolve({ id: 'sv3-199' }); // the Worker's /resolve: a hit
  fetchMock.route('/cards/sv3-199', {
    ok: true,
    json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 }, 'reverse-holofoil': { marketPrice: 60 } } } },
  });
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1.35 }] });

  const result = await ctx.fetchMarketPrice({ name: 'Pikachu 25', language: 'EN' });

  assert.strictEqual(result.maxUsd, 45, 'holofoil precedes reverse-holofoil in the default order (name is not flagged reverse-holo)');
  assert.strictEqual(result.source, 'TCGdex (TCGplayer)');
  assert.strictEqual(result.confidence, 'high');
  assert.strictEqual(result.resolvedTcgdexId, 'sv3-199');
  assert.ok(!fetchMock.calls.some(c => c.url.includes('/ppt/cards')), 'a clean TCGdex hit never falls through to PPT');
});

test('price-router: raw EN single flagged reverse-holo prefers the reverse-holofoil TCGplayer variant', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.resolve({ id: 'sv3-199' });
  fetchMock.route('/cards/sv3-199', {
    ok: true,
    json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 }, 'reverse-holofoil': { marketPrice: 60 } } } },
  });
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1.35 }] });

  const result = await ctx.fetchMarketPrice({ name: 'Pikachu 25 RH', language: 'EN' });
  assert.strictEqual(result.maxUsd, 60, 'a name flagged reverse-holo prefers reverse-holofoil ahead of the normal precedence');
});

test('price-router: TCGdex fallback to Cardmarket EUR when TCGplayer has nothing', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.resolve({ id: 'sv3-199' });
  fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { cardmarket: { avg: 12.5 } } } });
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1.5 }] });

  const result = await ctx.fetchMarketPrice({ name: 'Pikachu 25', language: 'EN' });
  assert.strictEqual(result.maxEur, 12.5);
  assert.strictEqual(result.maxUsd, null);
  assert.strictEqual(result.source, 'TCGdex (Cardmarket)');
});

test('price-router: resolveTcgdexId - a Worker hit is accepted and cached onto item.tcgdexId and _tcgdexResolvedName', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.resolve({ id: 'base1-58', name: 'Pikachu' });
  const item = { name: 'Pikachu 25', language: 'EN' };
  const id = await ctx.resolveTcgdexId(item);
  assert.strictEqual(id, 'base1-58');
  assert.strictEqual(item.tcgdexId, 'base1-58', 'the resolved id is cached back onto the item so repeat lookups skip the round-trip');
  assert.strictEqual(item._tcgdexResolvedName, 'Pikachu', 'the matched name, for the edit modal\'s confirm tooltip');
  assert.strictEqual(item.name, 'Pikachu 25', 'the stored name is never rewritten');
  const calls = fetchMock.calls.filter((c) => c.url.includes('/resolve?'));
  assert.strictEqual(calls.length, 1, 'one request');
  assert.ok(calls[0].url.startsWith(ctx.SB_WORKER_ORIGIN + '/resolve?'), 'to the Worker: ' + calls[0].url);
  assert.ok(!fetchMock.calls.some((c) => c.url.includes('api.tcgdex.net')), 'the browser no longer searches TCGdex itself');
  const again = await ctx.resolveTcgdexId(item);
  assert.strictEqual(again, 'base1-58');
  assert.strictEqual(fetchMock.calls.filter((c) => c.url.includes('/resolve?')).length, 1, 'the cached id answers the second call');
});

test('price-router: resolveTcgdexId - a definitive miss from the Worker stays unresolved and is never guessed', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.resolve({ id: null }); // several candidates the Worker could not tell apart, or none
  const item = { name: 'Gyarados 21', language: 'EN' };
  const priceReport = {};
  const id = await ctx.resolveTcgdexId(item, { priceReport });
  assert.strictEqual(id, null);
  assert.strictEqual(item.tcgdexId, undefined, 'never guessed - the item is left unresolved');
  assert.strictEqual(item._tcgdexResolvedName, undefined);
  assert.deepStrictEqual({ ...priceReport }, {}, 'a real miss is not "could not tell"');
});

test('price-router: resolveTcgdexId - the whole row name goes to the Worker, set words included, with the row language and no art flag', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.resolve((q) => (q.name === 'Gyarados 21 Jungle' ? { id: 'base2-21', name: 'Gyarados' } : { id: null }));
  const item = { name: 'Gyarados 21 Jungle', language: 'EN' };
  const id = await ctx.resolveTcgdexId(item);
  assert.strictEqual(id, 'base2-21', 'the Worker reads "Jungle" off the name it was sent');
  assert.strictEqual(item.tcgdexId, 'base2-21');
  assert.deepStrictEqual({ ...fetchMock.resolveCalls()[0] }, { name: 'Gyarados 21 Jungle', lang: 'en', set: '', art: false, num: '21' }, 'pricing sends no set and no art flag');
  for (const [language, lang] of [['JP', 'ja'], ['CN', 'zh-tw'], ['', 'en']]) {
    await ctx.resolveTcgdexId({ name: 'Gyarados 21', language });
    assert.strictEqual(fetchMock.resolveCalls().pop().lang, lang, language + ' is lang=' + lang);
  }
});

test('price-router: resolveTcgdexId - already-cached tcgdexId short-circuits, no fetch at all', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  const item = { name: 'Pikachu 25', language: 'EN', tcgdexId: 'already-resolved-1' };
  const id = await ctx.resolveTcgdexId(item);
  assert.strictEqual(id, 'already-resolved-1');
  assert.strictEqual(fetchMock.calls.length, 0);
});

test('price-router: resolveTcgdexId - name with no extractable number never even attempts a fetch', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  const item = { name: 'Umbreon Custom Card', language: 'EN' };
  const id = await ctx.resolveTcgdexId(item);
  assert.strictEqual(id, null);
  assert.strictEqual(fetchMock.calls.length, 0, 'nothing to resolve against - resolveTcgdexId bails before ever calling fetch');
});
