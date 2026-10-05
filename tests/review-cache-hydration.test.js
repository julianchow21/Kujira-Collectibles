'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadApp, makeSeed } = require('./harness');

const TABLES = ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'];
const STATUSES = { singles: 'Available', slabs: 'Available', sales: 'Sold', etbs: 'In Stock', boosterBoxes: 'Unopened', boosterPacks: 'Sealed', ebayPurchases: 'Paid' };

// All fetches stay inside the harness and fail: no real services or user data.
async function offline() { throw new TypeError('Synthetic offline connection'); }

for (const table of TABLES) {
  test('offline startup, save and reload preserve a cache containing only ' + table, async () => {
    const row = {
      id: 'offline-only-' + table, name: 'Synthetic cached row', product: 'Synthetic cached product',
      status: STATUSES[table], qty: 1, language: 'EN', condition: 'Near Mint',
      costPrice: 11, totalPrice: 11, marketPrice: 15, totalCollected: 25, shippingCost: 2,
      fees: 1, channel: 'Carousell', priceUsd: 5, freightSgd: 1, totalSgd: 8,
      datePurchased: '1 Jan 2025', dateSold: '2 Jan 2025', date: '1 Jan 2025',
      _serverVersion: 1, _updatedAt: '2025-01-02T00:00:00.000Z',
    };
    const seed = makeSeed(Object.fromEntries(TABLES.map(key => [key, key === table ? [row] : []])));
    const loaded = await loadApp({ seed, fetch: offline });
    assert.deepEqual(Array.from(loaded.ctx.DB[table], item => item.id), [row.id], 'startup shows the only cached table');
    for (const key of TABLES.filter(key => key !== table)) {
      assert.equal(loaded.ctx.DB[key].length, 0, 'does not require or invent a row in ' + key);
    }

    // Exercise the authenticated startup cloud attempt after the harness has
    // installed its synthetic owner session. The same cache survives failure.
    await loaded.ctx.initDB();
    assert.ok(loaded.fetchMock.calls.some(call => String(call.url).includes('/sync/v2/pull')), 'the mocked cloud pull was attempted');
    assert.equal(loaded.ctx._syncStatus, 'error', 'the failed pull is visible');
    assert.deepEqual(Array.from(loaded.ctx.DB[table], item => item.id), [row.id]);

    // A later ordinary save must not overwrite that cache with an empty table.
    loaded.ctx.saveData();
    const persisted = JSON.parse(loaded.localStorage.getItem('pokeinventory_v3'));
    assert.deepEqual(persisted[table].map(item => item.id), [row.id]);
    const reloaded = await loadApp({ storage: loaded.localStorage, seed: null, fetch: offline });
    await reloaded.ctx.initDB();
    assert.deepEqual(Array.from(reloaded.ctx.DB[table], item => item.id), [row.id], 'the cached row survives another offline launch');
  });
}
