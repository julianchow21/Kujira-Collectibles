'use strict';
// Suite 12: price-router (mocked fetch) - fetchMarketPrice, resolveTcgdexId.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

test('price-router: slab descriptor hits the PPT worker URL and never touches TCGdex', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/ppt/cards', { ok: true, json: { data: [{ name: 'Charizard', number: '4', ebay: { psa10: { avg: 500 } } }] } });
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1.35 } } });

  const result = await ctx.fetchMarketPrice({ name: 'Charizard', grader: 'PSA', grade: '10', language: 'EN' });

  assert.strictEqual(result.maxUsd, 500);
  assert.ok(result.source.includes('PPT'));
  assert.strictEqual(result.tcgdexError, 'not applicable');
  assert.ok(!fetchMock.calls.some(c => c.url.includes('api.tcgdex.net')), 'a slab must never call TCGdex at all');
  assert.ok(fetchMock.calls.some(c => c.url.includes('/ppt/cards')), 'the PPT worker proxy was actually hit');
});

test('price-router: tcgdexOnly:true + TCGdex miss -> clean unpriced result with ZERO PPT calls (the 403-hammering regression)', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('api.tcgdex.net', { ok: true, json: [] }); // resolveTcgdexId finds zero candidates -> unresolved
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
  fetchMock.route('/cards?name=', { ok: true, json: [{ id: 'sv3-199' }] }); // resolveTcgdexId: unique candidate
  fetchMock.route('/cards/sv3-199', {
    ok: true,
    json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 }, 'reverse-holofoil': { marketPrice: 60 } } } },
  });
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1.35 } } });

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
  fetchMock.route('/cards?name=', { ok: true, json: [{ id: 'sv3-199' }] });
  fetchMock.route('/cards/sv3-199', {
    ok: true,
    json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 }, 'reverse-holofoil': { marketPrice: 60 } } } },
  });
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1.35 } } });

  const result = await ctx.fetchMarketPrice({ name: 'Pikachu 25 RH', language: 'EN' });
  assert.strictEqual(result.maxUsd, 60, 'a name flagged reverse-holo prefers reverse-holofoil ahead of the normal precedence');
});

test('price-router: TCGdex fallback to Cardmarket EUR when TCGplayer has nothing', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/cards?name=', { ok: true, json: [{ id: 'sv3-199' }] });
  fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { cardmarket: { avg: 12.5 } } } });
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1.5 } } });

  const result = await ctx.fetchMarketPrice({ name: 'Pikachu 25', language: 'EN' });
  assert.strictEqual(result.maxEur, 12.5);
  assert.strictEqual(result.maxUsd, null);
  assert.strictEqual(result.source, 'TCGdex (Cardmarket)');
});

test('price-router: resolveTcgdexId - a unique candidate is auto-accepted and cached onto item.tcgdexId', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/cards?name=', { ok: true, json: [{ id: 'base1-58' }] });
  const item = { name: 'Pikachu 25', language: 'EN' };
  const id = await ctx.resolveTcgdexId(item);
  assert.strictEqual(id, 'base1-58');
  assert.strictEqual(item.tcgdexId, 'base1-58', 'the resolved id is cached back onto the item so repeat lookups skip the round-trip');
});

test('price-router: resolveTcgdexId - multiple candidates with no set-name token in the name stays unresolved', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/cards?name=', { ok: true, json: [{ id: 'base2-21' }, { id: 'base3-21' }] });
  const item = { name: 'Gyarados 21', language: 'EN' }; // no "Jungle"/"Fossil" mentioned
  const id = await ctx.resolveTcgdexId(item);
  assert.strictEqual(id, null);
  assert.strictEqual(item.tcgdexId, undefined, 'never guessed - the item is left unresolved');
});

test('price-router: resolveTcgdexId - multiple candidates WITH a set-name token disambiguates to one', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/cards?name=', { ok: true, json: [{ id: 'base2-21' }, { id: 'base3-21' }] });
  const item = { name: 'Gyarados 21 Jungle', language: 'EN' };
  const id = await ctx.resolveTcgdexId(item);
  assert.strictEqual(id, 'base2-21', '"Jungle" in the name picks the base2 (Jungle set) candidate');
  assert.strictEqual(item.tcgdexId, 'base2-21');
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
