'use strict';
// Suite 8: dirty-persistence - markDirty, _loadDirtyFromLS / _persistDirty
// round-trip via localStorage 'pokeinv_dirty_v1', corrupt JSON survival.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, syncSuccessResponse, syncCalls, syncRequest } = require('./harness.js');

function copyStorage(localStorage) {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) out[key] = localStorage.getItem(key);
  }
  return out;
}

test('dirty-persistence: markDirty adds the id to the in-memory dirty set for that table', async () => {
  const { ctx, grab } = await loadApp();
  ctx.markDirty('singles', 'abc123');
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('abc123'), true);
});

test('dirty-persistence: markDirty persists to localStorage "pokeinv_dirty_v1"', async () => {
  const { ctx, localStorage } = await loadApp({
    seed: { slabs: [{ id: 'slab_1', name: 'Marker snapshot slab', status: 'Available' }] },
  });
  ctx.markDirty('slabs', 'slab_1');
  const raw = localStorage.getItem('pokeinv_dirty_v1');
  assert.ok(raw, 'dirty set must be persisted synchronously, not just kept in memory');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.slabs) && parsed.slabs.includes('slab_1'));
  assert.ok(Array.isArray(parsed._revisions.slabs.slab_1) && parsed._revisions.slabs.slab_1.length === 1,
    'the persisted id keeps a mutation token so only that exact edit can be cleared');
  const v2Keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('pokeinv_dirty_v2:')) v2Keys.push(key);
  }
  assert.strictEqual(v2Keys.length, 1, 'the authoritative mutation marker uses its own collision-free storage key');
  const marker = JSON.parse(localStorage.getItem(v2Keys[0]));
  assert.strictEqual(marker.table, 'slabs');
  assert.strictEqual(marker.id, 'slab_1');
  assert.strictEqual(typeof marker.rowJson, 'string', 'the marker records the exact row bytes when available');
});

test('dirty-persistence: markDirty on an unknown table is a safe no-op (not a throw)', async () => {
  const { ctx } = await loadApp();
  assert.doesNotThrow(() => ctx.markDirty('not_a_real_table', 'x'));
});

test('dirty-persistence: _loadDirtyFromLS restores a seeded dirty set on a fresh loadApp', async () => {
  const { grab } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['s1', 's2'], slabs: ['sl1'] }) },
  });
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('s1'), true);
  assert.strictEqual(_dirty.singles.has('s2'), true);
  assert.strictEqual(_dirty.slabs.has('sl1'), true);
  assert.strictEqual(_dirty.sales.size, 0, 'tables not present in the seeded blob start empty, not undefined/throwing');
});

test('dirty-persistence: legacy array-only dirty blobs are upgraded without changing the array shape', async () => {
  const { localStorage } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['legacy_1'] }) },
  });
  const parsed = JSON.parse(localStorage.getItem('pokeinv_dirty_v1'));
  assert.deepStrictEqual(parsed.singles, ['legacy_1']);
  assert.ok(Array.isArray(parsed._revisions.singles.legacy_1));
  assert.strictEqual(parsed._revisions.singles.legacy_1.length, 1);
});

test('dirty-persistence: corrupt JSON in "pokeinv_dirty_v1" does not throw and falls back to empty sets', async () => {
  const { grab } = await loadApp({
    localStorage: { pokeinv_dirty_v1: 'not valid json {{{' },
  });
  const { _dirty } = grab('_dirty');
  for (const table of ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases']) {
    assert.ok(_dirty[table] instanceof Set || typeof _dirty[table].add === 'function', `${table} dirty set must still be a working Set-like`);
    assert.strictEqual(_dirty[table].size, 0);
  }
});

test('dirty-persistence: a fresh loadApp with no seeded dirty key starts with all tables empty', async () => {
  const { grab } = await loadApp();
  const { _dirty } = grab('_dirty');
  const total = Object.values(_dirty).reduce((s, set) => s + set.size, 0);
  assert.strictEqual(total, 0);
});

test('dirty-persistence: v2 marker write failure keeps in-memory dirty state and gives a user warning', async () => {
  const { ctx, grab, localStorage, consoleErrors } = await loadApp();
  const userWarnings = [];
  ctx.toast = message => userWarnings.push(message);
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (String(key).startsWith('pokeinv_dirty_v2:')) throw new Error('marker storage unavailable');
    return realSetItem(key, value);
  };
  grab('DB').DB.singles[0].name = 'Unsaved marker edit';
  ctx.markDirty('singles', 'single_seed_1');
  assert.strictEqual(grab('_dirty')._dirty.singles.has('single_seed_1'), true);
  assert.ok(consoleErrors.some(line => line.includes('unique marker write failed')));
  assert.ok(userWarnings.some(message => message.includes('Could not save the latest sync marker')),
    'the failure is visible to the user, not console-only');
});

test('dirty-persistence: 100 same-row offline edits retain one current-tab marker and preserve foreign markers', async () => {
  const { ctx, grab, localStorage } = await loadApp();
  const foreignToken = 'foreign-tab:keep-me';
  const foreignKey = 'pokeinv_dirty_v2:' + foreignToken;
  localStorage.setItem(foreignKey, JSON.stringify({
    table: 'singles', id: 'single_seed_1', token: foreignToken, owner: 'foreign-tab',
    rowJson: JSON.stringify({ ...grab('DB').DB.singles[0], name: 'Foreign bytes' }),
  }));

  for (let i = 1; i <= 100; i++) {
    grab('DB').DB.singles[0].name = 'Offline edit ' + i;
    ctx.markDirty('singles', 'single_seed_1');
  }

  const markers = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('pokeinv_dirty_v2:')) continue;
    const marker = JSON.parse(localStorage.getItem(key));
    if (marker.table === 'singles' && marker.id === 'single_seed_1') markers.push(marker);
  }
  const tabId = grab('_dirtyTabId')._dirtyTabId;
  assert.strictEqual(markers.filter(marker => marker.owner === tabId).length, 1,
    'a later durable mutation supersedes the previous marker owned by this tab');
  assert.strictEqual(markers.some(marker => marker.token === foreignToken), true,
    'same-tab compaction never touches a foreign tab marker');
  const current = markers.find(marker => marker.owner === tabId);
  assert.strictEqual(JSON.parse(current.rowJson).name, 'Offline edit 100');
});

test('dirty-persistence: fixed-time cleanup failures still recover the exact edit after base36 token rollover', async () => {
  const { ctx, grab, localStorage } = await loadApp();
  ctx.Date.now = () => 1234567890;
  const realRemoveItem = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = key => {
    if (!String(key).startsWith('pokeinv_dirty_v2:')) realRemoveItem(key);
  };

  for (let i = 1; i <= 40; i++) {
    grab('DB').DB.singles[0].costPrice = i;
    ctx.markDirty('singles', 'single_seed_1');
  }
  const staleCache = JSON.parse(localStorage.getItem('pokeinventory_v3'));
  staleCache.singles[0].costPrice = -1;
  localStorage.setItem('pokeinventory_v3', JSON.stringify(staleCache));

  const reloaded = await loadApp({ localStorage: copyStorage(localStorage) });
  assert.strictEqual(reloaded.grab('DB').DB.singles[0].costPrice, 40,
    'numeric owner sequence outranks lexical :z versus :10 ordering when every createdAt is equal');
});

test('dirty-persistence: legacy v1 dirty rows upgrade after cache hydration with exact replayable bytes', async () => {
  const row = { id: 'legacy_exact_row', name: 'Legacy unsynced money edit', costPrice: 777, status: 'Available' };
  const loaded = await loadApp({
    seed: { singles: [row] },
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: [row.id] }) },
  });
  const markerKeys = [];
  for (let i = 0; i < loaded.localStorage.length; i++) {
    const key = loaded.localStorage.key(i);
    if (key && key.startsWith('pokeinv_dirty_v2:')) markerKeys.push(key);
  }
  const marker = markerKeys.map(key => JSON.parse(loaded.localStorage.getItem(key)))
    .find(candidate => candidate.table === 'singles' && candidate.id === row.id);
  assert.ok(marker);
  assert.strictEqual(marker.rowJson, JSON.stringify(row), 'legacy materialisation runs only after DB contains the cached row');

  const stale = JSON.parse(loaded.localStorage.getItem('pokeinventory_v3'));
  stale.singles[0] = { ...row, name: 'Clobbered stale cache', costPrice: 1 };
  loaded.localStorage.setItem('pokeinventory_v3', JSON.stringify(stale));
  const reloaded = await loadApp({ localStorage: copyStorage(loaded.localStorage) });
  assert.strictEqual(reloaded.grab('DB').DB.singles[0].costPrice, 777);
  reloaded.fetchMock.calls.length = 0;
  reloaded.fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  await reloaded.ctx._flushDirtyToSupabase();
  const post = syncCalls(reloaded.fetchMock)[0];
  const operation = syncRequest(post.opts).operations[0];
  assert.strictEqual(operation.table, 'singles');
  assert.strictEqual(operation.data.name, 'Legacy unsynced money edit');
  assert.strictEqual(operation.data.costPrice, 777);
});
