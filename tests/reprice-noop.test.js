'use strict';
// Suite 13: reprice-noop (v3.26 regression) - applyPriceToGroup and
// refreshPrice must BOTH skip priceHistory/markDirty on a genuine same-value
// re-price, while still stamping the local _tcgdexPricedDate marker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

function today() { return new Date().toISOString().slice(0, 10); }

test('reprice-noop: applyPriceToGroup - identical price (string-typed, matching cached tcgdexId) -> no history, no markDirty, priced-today marker set', async () => {
  const { ctx, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', marketPrice: '45', tcgdexId: 'sv3-199', priceHistory: [], status: 'Available' }] },
  });
  ctx.applyPriceToGroup('s1', 'singles', [], 45, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  const { DB, _dirty } = grab('DB', '_dirty');
  const row = DB.singles.find(r => r.id === 's1');
  assert.strictEqual(row.marketPrice, '45');
  assert.strictEqual(row.priceHistory.length, 0, 'no history entry appended for a genuine no-op re-price');
  assert.strictEqual(_dirty.singles.has('s1'), false, 'not marked dirty - nothing to sync');
  assert.strictEqual(row._tcgdexPricedDate, today(), 'the local priced-today marker is still stamped');
  // _tcgdexPricedToday takes a QUEUE-item shape ({table, id}), not a raw DB row -
  // it looks the live row up itself via DB[item.table].find(...).
  assert.strictEqual(ctx._tcgdexPricedToday({ table: 'singles', id: 's1' }, today()), true);
});

test('reprice-noop: applyPriceToGroup - a genuinely DIFFERENT price appends history and marks dirty', async () => {
  const { ctx, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', marketPrice: '45', tcgdexId: 'sv3-199', priceHistory: [], status: 'Available' }] },
  });
  ctx.applyPriceToGroup('s1', 'singles', [], 50, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  const { DB, _dirty } = grab('DB', '_dirty');
  const row = DB.singles.find(r => r.id === 's1');
  assert.strictEqual(row.marketPrice, '50');
  assert.strictEqual(row.priceHistory.length, 1);
  assert.strictEqual(_dirty.singles.has('s1'), true);
});

test('reprice-noop: applyPriceToGroup - no-op guard holds when marketPrice is stored as a NUMBER (v3.32 coercion fix)', async () => {
  const { ctx, grab } = await loadApp({
    // marketPrice stored as a genuine NUMBER (as the edit modal leaves it
    // after a manual edit), not the string the resolver's own writes
    // (`item.marketPrice = priceSgd.toFixed(0)`) use. Pre-v3.32 the guard
    // compared NUMBER === STRING, never matched, and re-generated phantom
    // history + markDirty on every identical daily re-price of a
    // hand-edited row - the exact churn v3.26 was built to stop.
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', marketPrice: 45, tcgdexId: 'sv3-199', priceHistory: [], status: 'Available' }] },
  });
  ctx.applyPriceToGroup('s1', 'singles', [], 45, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  const { DB, _dirty } = grab('DB', '_dirty');
  const row = DB.singles.find(r => r.id === 's1');
  assert.strictEqual(row.priceHistory.length, 0, 'no history entry - Number() coercion recognises 45 and "45" as the same value');
  assert.strictEqual(_dirty.singles.has('s1'), false, 'not marked dirty - no phantom sync traffic');
  assert.strictEqual(row._tcgdexPricedDate, today(), 'priced-today marker still stamped on the no-op path');
});

test('reprice-noop: refreshPrice - a freshly-resolved tcgdexId with an UNCHANGED price still syncs (v3.32 idIsNew ordering fix)', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    // No tcgdexId yet: this call resolves it. Pre-v3.32, refreshPrice
    // assigned item.tcgdexId BEFORE computing idIsNew, so idIsNew was always
    // false and an unchanged price sent the fresh id down the no-op path -
    // saved locally, never markDirty'd, never synced to other devices.
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', language: 'EN', marketPrice: '45', priceHistory: [], status: 'Available' }] },
  });
  fetchMock.route('/en/cards?name=', { ok: true, json: [{ id: 'sv3-199', name: 'Pikachu' }] }); // unique candidate, auto-accepted
  fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1 } } });
  await ctx.refreshPrice('s1', 'singles');
  const { DB, _dirty } = grab('DB', '_dirty');
  const row = DB.singles.find(r => r.id === 's1');
  assert.strictEqual(row.tcgdexId, 'sv3-199', 'the freshly-resolved id is cached onto the row');
  assert.strictEqual(row.priceHistory.length, 1, 'idIsNew bypasses the no-op guard even though the price is unchanged');
  assert.strictEqual(_dirty.singles.has('s1'), true, 'marked dirty so the new id actually syncs');
});

test('reprice-noop: applyPriceToGroup - a newly-resolved tcgdexId is never treated as a no-op, even with the same price', async () => {
  const { ctx, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', marketPrice: '45', priceHistory: [], status: 'Available' }] }, // no tcgdexId yet
  });
  ctx.applyPriceToGroup('s1', 'singles', [], 45, 'USD', 'TCGdex (TCGplayer)', 'high', 'sv3-199');
  const { DB } = grab('DB');
  const row = DB.singles.find(r => r.id === 's1');
  assert.strictEqual(row.tcgdexId, 'sv3-199', 'the newly-resolved id is cached');
  assert.strictEqual(row.priceHistory.length, 1, 'idIsNew forces a real write even though the price string matches');
});

test('reprice-noop: applyPriceToGroup - copy targets receive the same treatment as the primary row', async () => {
  const { ctx, grab } = await loadApp({
    seed: {
      singles: [
        { id: 's1', name: 'Pikachu 25', marketPrice: '10', priceHistory: [], status: 'Available' },
        { id: 's2', name: 'Pikachu 25', marketPrice: '10', priceHistory: [], status: 'Available' },
      ],
    },
  });
  ctx.applyPriceToGroup('s1', 'singles', [{ id: 's2', table: 'singles' }], 20, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.find(r => r.id === 's1').marketPrice, '20');
  assert.strictEqual(DB.singles.find(r => r.id === 's2').marketPrice, '20', 'copy target gets the same price applied');
});

test('reprice-noop: refreshPrice - identical fetched price on an already-cached tcgdexId is a no-op (mirrors applyPriceToGroup)', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', language: 'EN', marketPrice: '45', tcgdexId: 'sv3-199', priceHistory: [], status: 'Available' }] },
  });
  fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1 } } }); // rate=1 keeps maxSgd === maxUsd, easy to predict
  await ctx.refreshPrice('s1', 'singles');
  const { DB, _dirty } = grab('DB', '_dirty');
  const row = DB.singles.find(r => r.id === 's1');
  assert.strictEqual(row.priceHistory.length, 0, 'refreshPrice also skips history on a genuine no-op re-price');
  assert.strictEqual(_dirty.singles.has('s1'), false);
  assert.strictEqual(row._tcgdexPricedDate, today());
});

test('reprice-noop: refreshPrice - a different fetched price appends history and marks dirty (same as applyPriceToGroup)', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', language: 'EN', marketPrice: '45', tcgdexId: 'sv3-199', priceHistory: [], status: 'Available' }] },
  });
  fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 99 } } } } });
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1 } } });
  await ctx.refreshPrice('s1', 'singles');
  const { DB, _dirty } = grab('DB', '_dirty');
  const row = DB.singles.find(r => r.id === 's1');
  assert.strictEqual(row.marketPrice, '99');
  assert.strictEqual(row.priceHistory.length, 1);
  assert.strictEqual(_dirty.singles.has('s1'), true);
});
