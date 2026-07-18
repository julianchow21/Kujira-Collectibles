'use strict';
// Suite 1: smoke - harness boots, globals present, seed hydrates, migrateEbayStatuses
// ran without corrupting the seed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

test('smoke: both scripts eval without throwing, DB has all 8 table arrays', async () => {
  const { ctx, grab } = await loadApp();
  const { DB } = grab('DB');
  assert.ok(DB, 'DB should exist');
  for (const key of ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases', 'trash']) {
    assert.ok(Array.isArray(DB[key]), `DB.${key} should be an array`);
  }
  assert.strictEqual(typeof ctx.toDateMmmYyyy, 'function');
  assert.strictEqual(typeof ctx.mergeTable, 'function');
});

test('smoke: features.js loaded into the same scope (kjrMatchNumFilter reachable)', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(typeof ctx.kjrMatchNumFilter, 'function');
});

test('smoke: seeded single hydrates from localStorage into DB.singles', async () => {
  const { grab } = await loadApp();
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.length, 1);
  assert.strictEqual(DB.singles[0].id, 'single_seed_1');
  assert.strictEqual(DB.singles[0].name, 'Pikachu 25');
});

test('smoke: migrateEbayStatuses ran without corrupting the seed (legacy status migrated)', async () => {
  const { grab, localStorage } = await loadApp({
    seed: { ebayPurchases: [{ id: 'eb_1', status: 'Ordered', product: 'Test Card', priceUsd: 10, freightSgd: 2 }] },
  });
  const { DB } = grab('DB');
  assert.strictEqual(DB.ebayPurchases.length, 1, 'seed row must survive the migration, not be dropped');
  assert.strictEqual(DB.ebayPurchases[0].status, 'Paid', '"Ordered" legacy status migrates to "Paid"');
  assert.strictEqual(localStorage.getItem('pokeinv_ebay_status_migration_v1'), '1', 'migration flag set so it only runs once');
});

test('smoke: a second legacy status ("Received") migrates to Completed + _historical', async () => {
  const { grab } = await loadApp({
    seed: { ebayPurchases: [{ id: 'eb_2', status: 'Received', product: 'Old Row' }] },
  });
  const { DB } = grab('DB');
  assert.strictEqual(DB.ebayPurchases[0].status, 'Completed');
  assert.strictEqual(DB.ebayPurchases[0]._historical, true);
});

test('smoke: no npm deps, harness uses only node:vm/node:fs/node:path', async () => {
  // Static self-check: nothing exotic required at the top of harness.js.
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'harness.js'), 'utf8');
  assert.match(src, /require\('node:vm'\)/);
  assert.doesNotMatch(src, /require\(['"](?!node:)/, 'no non-node: package should be required');
});
