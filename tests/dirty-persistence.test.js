'use strict';
// Suite 8: dirty-persistence - markDirty, _loadDirtyFromLS / _persistDirty
// round-trip via localStorage 'pokeinv_dirty_v1', corrupt JSON survival.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, syncPullResponse, syncSuccessResponse, syncCalls, syncRequest } = require('./harness.js');

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

test('dirty-persistence: snapshotless v2 marker materialises cached row bytes onto its original token', async () => {
  const row = { id: 'snapshotless_cached', product: 'Cached unsynced ETB', costPrice: 321, status: 'In Stock' };
  const token = 'older-tab:cached';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const marker = {
    table: 'etbs', id: row.id, token, owner: 'older-tab', createdAt: 123,
  };
  const loaded = await loadApp({
    seed: { singles: [], etbs: [row] },
    localStorage: {
      [markerKey]: JSON.stringify(marker),
      pokeinv_dirty_v1: JSON.stringify({ etbs: [row.id] }),
    },
  });

  const saved = JSON.parse(loaded.localStorage.getItem(markerKey));
  assert.strictEqual(saved.token, token);
  assert.strictEqual(saved.rowJson, JSON.stringify(row),
    'post-hydration repair preserves the exact cached JSON on the original marker');
  const matchingKeys = [];
  for (let i = 0; i < loaded.localStorage.length; i++) {
    const key = loaded.localStorage.key(i);
    if (!key || !key.startsWith('pokeinv_dirty_v2:')) continue;
    const candidate = JSON.parse(loaded.localStorage.getItem(key));
    if (candidate.table === 'etbs' && candidate.id === row.id) matchingKeys.push(key);
  }
  assert.deepStrictEqual(matchingKeys, [markerKey], 'fresh startup does not mint a second marker');
  const legacy = JSON.parse(loaded.localStorage.getItem('pokeinv_dirty_v1'));
  assert.deepStrictEqual(legacy._revisions.etbs[row.id], [token]);
});

test('dirty-persistence: snapshotless v2 marker without a cached row stays quarantined without multiplying', async () => {
  const id = 'snapshotless_missing';
  const token = 'older-tab:missing';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const markerRaw = JSON.stringify({ table: 'singles', id, token, owner: 'older-tab', createdAt: 456 });
  const loaded = await loadApp({
    localStorage: {
      [markerKey]: markerRaw,
      pokeinv_dirty_v1: JSON.stringify({ singles: [id] }),
    },
  });

  assert.strictEqual(loaded.localStorage.getItem(markerKey), markerRaw,
    'the unrecoverable original marker is retained byte-for-byte');
  const matchingKeys = [];
  for (let i = 0; i < loaded.localStorage.length; i++) {
    const key = loaded.localStorage.key(i);
    if (!key || !key.startsWith('pokeinv_dirty_v2:')) continue;
    const candidate = JSON.parse(loaded.localStorage.getItem(key));
    if (candidate.table === 'singles' && candidate.id === id) matchingKeys.push(key);
  }
  assert.deepStrictEqual(matchingKeys, [markerKey], 'fresh startup does not mint a synthetic token or marker');
  const legacy = JSON.parse(loaded.localStorage.getItem('pokeinv_dirty_v1'));
  assert.deepStrictEqual(legacy._revisions.singles[id], [token]);
  assert.ok(loaded.consoleWarnings.some(line => line.includes('has no recoverable row snapshot and remains pending')),
    'the quarantined marker remains visible for review');

  const reloaded = await loadApp({ seed: null, localStorage: copyStorage(loaded.localStorage) });
  const repeatedKeys = [];
  for (let i = 0; i < reloaded.localStorage.length; i++) {
    const key = reloaded.localStorage.key(i);
    if (!key || !key.startsWith('pokeinv_dirty_v2:')) continue;
    const candidate = JSON.parse(reloaded.localStorage.getItem(key));
    if (candidate.table === 'singles' && candidate.id === id) repeatedKeys.push(key);
  }
  assert.deepStrictEqual(repeatedKeys, [markerKey], 'repeated fresh startups retain one quarantined marker');
});

function orphanMarker(id, token) {
  return { table: 'singles', id, token, owner: 'older-tab', createdAt: 456 };
}

function currentPullWith(tombstones, tables) {
  return async url => {
    if (String(url).includes('/sync/v2/pull')) return syncPullResponse(tables, tombstones);
    throw new TypeError('offline');
  };
}

test('dirty-persistence: a current authenticated tombstone pull clears only a snapshotless orphan marker and exact legacy state', async () => {
  const id = 'orphan_tombstoned_row';
  const token = 'older-tab:orphan';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const unrelatedToken = 'other-tab:keep';
  const unrelatedKey = 'pokeinv_dirty_v2:' + unrelatedToken;
  const loaded = await loadApp({
    seed: null,
    fetch: currentPullWith([{ table: 'singles', id, row_version: 3, deleted_at: '2026-09-04T00:00:00.000Z' }]),
    localStorage: {
      [markerKey]: JSON.stringify(orphanMarker(id, token)),
      [unrelatedKey]: JSON.stringify({ ...orphanMarker('unrelated_row', unrelatedToken), rowJson: JSON.stringify({ id: 'unrelated_row', name: 'Keep me' }) }),
      pokeinv_dirty_v1: JSON.stringify({
        singles: [id, 'unrelated_row'],
        _revisions: { singles: { [id]: [token], unrelated_row: [unrelatedToken] } },
      }),
    },
  });

  assert.strictEqual(loaded.localStorage.getItem(markerKey), null, 'only the proven empty orphan marker is removed');
  assert.ok(loaded.localStorage.getItem(unrelatedKey), 'an unrelated marker remains durable');
  const legacy = JSON.parse(loaded.localStorage.getItem('pokeinv_dirty_v1'));
  assert.ok(!legacy.singles.includes(id));
  assert.strictEqual(legacy._revisions.singles[id], undefined);
  assert.ok(legacy.singles.includes('unrelated_row'));
  assert.ok(legacy._revisions.singles.unrelated_row.includes(unrelatedToken),
    'the unrelated marker keeps its own revision even if startup adds its local retry token');
  assert.strictEqual(loaded.grab('_dirty')._dirty.singles.has(id), false);
  assert.strictEqual(loaded.grab('_dirtyRevisions')._dirtyRevisions.singles.has(id), false);

  const reloaded = await loadApp({
    seed: null,
    fetch: currentPullWith([{ table: 'singles', id, row_version: 3, deleted_at: '2026-09-04T00:00:00.000Z' }]),
    localStorage: copyStorage(loaded.localStorage),
  });
  assert.strictEqual(reloaded.localStorage.getItem(markerKey), null, 'a fresh load cannot replay the cleared orphan');
  assert.ok(!reloaded.grab('DB').DB.singles.some(row => row.id === id), 'the tombstoned row stays absent after reload');
});

test('dirty-persistence: confirmed deleted state remains byte-for-byte while a current tombstone pull clears its orphan marker', async () => {
  const id = 'confirmed_deleted_orphan';
  const token = 'older-tab:confirmed-deleted';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const confirmedDeletedRaw = JSON.stringify({
    schema: 2,
    revision: 'confirmed-delete-proof',
    pending: [],
    confirmed: [{ table: 'singles', id, ts: 456, restoreToken: 'original-delete-token', state: 'deleted' }],
  });
  const loaded = await loadApp({
    seed: null,
    fetch: currentPullWith([{ table: 'singles', id, row_version: 3, deleted_at: '2026-09-04T00:00:00.000Z' }]),
    localStorage: {
      [markerKey]: JSON.stringify(orphanMarker(id, token)),
      _kjrDeleteStateV2: confirmedDeletedRaw,
      pokeinv_dirty_v1: JSON.stringify({ singles: [id], _revisions: { singles: { [id]: [token] } } }),
    },
  });

  assert.strictEqual(loaded.localStorage.getItem(markerKey), null);
  assert.strictEqual(loaded.localStorage.getItem('_kjrDeleteStateV2'), confirmedDeletedRaw,
    'orphan cleanup must not rewrite or remove confirmed deletion evidence');
});

test('dirty-persistence: cached or untombstoned snapshotless markers stay queued, including any marker with row bytes', async () => {
  const cases = [
    {
      name: 'cached tombstone is not a current pull',
      id: 'cached_tombstone_only',
      localStorage: { _kjrServerTombstonesV1: JSON.stringify([{ table: 'singles', id: 'cached_tombstone_only', row_version: 3 }]) },
      fetch: undefined,
    },
    {
      name: 'current pull has no tombstone',
      id: 'untombstoned_orphan',
      localStorage: {},
      fetch: currentPullWith([]),
    },
    {
      name: 'marker carries recoverable row bytes',
      id: 'byte_bearing_orphan',
      localStorage: {},
      fetch: currentPullWith([{ table: 'singles', id: 'byte_bearing_orphan', row_version: 3 }]),
      rowJson: JSON.stringify({ id: 'byte_bearing_orphan', name: 'Recoverable bytes' }),
    },
  ];
  for (const item of cases) {
    const token = 'older-tab:' + item.id;
    const markerKey = 'pokeinv_dirty_v2:' + token;
    const marker = { ...orphanMarker(item.id, token), ...(item.rowJson ? { rowJson: item.rowJson } : {}) };
    const loaded = await loadApp({
      seed: null,
      fetch: item.fetch,
      localStorage: {
        ...item.localStorage,
        [markerKey]: JSON.stringify(marker),
        pokeinv_dirty_v1: JSON.stringify({ singles: [item.id], _revisions: { singles: { [item.id]: [token] } } }),
      },
    });
    assert.ok(loaded.localStorage.getItem(markerKey), item.name + ' keeps its marker');
    const legacy = JSON.parse(loaded.localStorage.getItem('pokeinv_dirty_v1'));
    assert.ok(legacy.singles.includes(item.id), item.name + ' keeps its dirty id');
  }
});

test('dirty-persistence: any same-row delete state, cached row, or later token blocks orphan cleanup', async () => {
  const cases = [
    {
      name: 'cached row',
      id: 'cached_row_blocks',
      seed: { singles: [{ id: 'cached_row_blocks', name: 'Later cached edit' }] },
      extra: {},
    },
    {
      name: 'later same-row token',
      id: 'later_token_blocks',
      seed: null,
      extra: { secondMarker: true },
    },
    {
      name: 'pending delete state',
      id: 'pending_delete_blocks',
      seed: null,
      extra: { pendingDelete: true },
    },
    {
      name: 'confirmed restored state',
      id: 'confirmed_restore_blocks',
      seed: null,
      extra: { confirmedRestore: true },
    },
  ];
  for (const item of cases) {
    const token = 'older-tab:' + item.id;
    const markerKey = 'pokeinv_dirty_v2:' + token;
    const localStorage = {
      [markerKey]: JSON.stringify(orphanMarker(item.id, token)),
      pokeinv_dirty_v1: JSON.stringify({ singles: [item.id], _revisions: { singles: { [item.id]: [token] } } }),
    };
    if (item.extra.secondMarker) {
      const laterToken = 'newer-tab:' + item.id;
      localStorage['pokeinv_dirty_v2:' + laterToken] = JSON.stringify({
        ...orphanMarker(item.id, laterToken), rowJson: JSON.stringify({ id: item.id, name: 'Later edit' }),
      });
      localStorage.pokeinv_dirty_v1 = JSON.stringify({ singles: [item.id], _revisions: { singles: { [item.id]: [token, laterToken] } } });
    }
    if (item.extra.pendingDelete) {
      localStorage._kjrDeleteStateV2 = JSON.stringify({ schema: 2, revision: 'test-delete-state', pending: [{ table: 'singles', id: item.id }], confirmed: [] });
    }
    if (item.extra.confirmedRestore) {
      localStorage._kjrDeleteStateV2 = JSON.stringify({
        schema: 2,
        revision: 'test-restored-state',
        pending: [],
        confirmed: [{ table: 'singles', id: item.id, ts: 456, restoreToken: 'restore-token', state: 'restored' }],
      });
    }
    const loaded = await loadApp({
      seed: item.seed,
      fetch: currentPullWith([{ table: 'singles', id: item.id, row_version: 3 }]),
      localStorage,
    });
    assert.ok(loaded.localStorage.getItem(markerKey), item.name + ' keeps the target marker');
  }
});

test('dirty-persistence: a pending same-row mutation group blocks orphan cleanup without changing either recovery record', async () => {
  const id = 'pending_group_blocks';
  const token = 'older-tab:pending-group';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const mutationId = '11111111-1111-4111-8111-111111111111';
  const groupKey = '_kjrMutationGroupV2:' + mutationId;
  const groupRaw = JSON.stringify({
    mutation_id: mutationId,
    created_at: 1,
    operations: [{ type: 'upsert', table: 'singles', id, expected_version: 0, data: { name: 'Pending recovery', status: 'Available' } }],
    before_states: [{ table: 'singles', id, present: false }],
  });
  const loaded = await loadApp({ seed: null });
  loaded.localStorage.setItem(markerKey, JSON.stringify(orphanMarker(id, token)));
  loaded.localStorage.setItem(groupKey, groupRaw);
  loaded.localStorage.setItem('pokeinv_dirty_v1', JSON.stringify({
    singles: [id], _revisions: { singles: { [id]: [token] } },
  }));
  const cleared = loaded.ctx._clearProvenOrphanDirtyMarkersAfterPull(
    [{ table: 'singles', id, row_version: 3 }],
    { singles: [], slabs: [], sales: [], etbs: [], booster_boxes: [], booster_packs: [], ebay_purchases: [], trash: [] },
  );
  assert.strictEqual(cleared, 0);
  assert.ok(loaded.localStorage.getItem(markerKey));
  assert.strictEqual(loaded.localStorage.getItem(groupKey), groupRaw);
});

test('dirty-persistence: unreadable markers fail closed and are never cleared beside an orphan candidate', async () => {
  const id = 'malformed_marker_blocks';
  const token = 'older-tab:malformed-block';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const loaded = await loadApp({ seed: null });
  loaded.localStorage.setItem(markerKey, JSON.stringify(orphanMarker(id, token)));
  loaded.localStorage.setItem('pokeinv_dirty_v2:malformed', '{not-json');
  loaded.localStorage.setItem('pokeinv_dirty_v1', JSON.stringify({ singles: [id], _revisions: { singles: { [id]: [token] } } }));
  const cleared = loaded.ctx._clearProvenOrphanDirtyMarkersAfterPull(
    [{ table: 'singles', id, row_version: 3 }],
    { singles: [], slabs: [], sales: [], etbs: [], booster_boxes: [], booster_packs: [], ebay_purchases: [], trash: [] },
  );
  assert.strictEqual(cleared, 0);
  assert.ok(loaded.localStorage.getItem(markerKey));
  assert.strictEqual(loaded.localStorage.getItem('pokeinv_dirty_v2:malformed'), '{not-json');
});

test('dirty-persistence: orphan cleanup rolls storage and in-memory state back when its exact legacy write fails', async () => {
  const id = 'legacy_write_failure';
  const token = 'older-tab:legacy-write-failure';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const markerRaw = JSON.stringify(orphanMarker(id, token));
  const legacyRaw = JSON.stringify({ singles: [id], _revisions: { singles: { [id]: [token] } } });
  const loaded = await loadApp({
    seed: null,
    localStorage: { [markerKey]: markerRaw, pokeinv_dirty_v1: legacyRaw },
  });
  const dirtyBefore = loaded.localStorage.getItem('pokeinv_dirty_v1');
  const realSetItem = loaded.localStorage.setItem.bind(loaded.localStorage);
  loaded.localStorage.setItem = (key, value) => {
    if (key === 'pokeinv_dirty_v1') throw new Error('injected legacy write failure');
    return realSetItem(key, value);
  };
  const cleared = loaded.ctx._clearProvenOrphanDirtyMarkersAfterPull(
    [{ table: 'singles', id, row_version: 3 }],
    { singles: [], slabs: [], sales: [], etbs: [], booster_boxes: [], booster_packs: [], ebay_purchases: [], trash: [] },
  );
  assert.strictEqual(cleared, 0);
  assert.strictEqual(loaded.localStorage.getItem(markerKey), markerRaw);
  assert.strictEqual(loaded.localStorage.getItem('pokeinv_dirty_v1'), dirtyBefore);
  assert.strictEqual(loaded.grab('_dirty')._dirty.singles.has(id), true);
  assert.strictEqual(loaded.grab('_dirtyRevisions')._dirtyRevisions.singles.get(id), token);
});

test('dirty-persistence: orphan cleanup restores the exact legacy bytes when marker removal fails', async () => {
  const id = 'marker_remove_failure';
  const token = 'older-tab:marker-remove-failure';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const markerRaw = JSON.stringify(orphanMarker(id, token));
  const loaded = await loadApp({
    seed: null,
    localStorage: {
      [markerKey]: markerRaw,
      pokeinv_dirty_v1: JSON.stringify({ singles: [id], _revisions: { singles: { [id]: [token] } } }),
    },
  });
  const dirtyBefore = loaded.localStorage.getItem('pokeinv_dirty_v1');
  const realRemoveItem = loaded.localStorage.removeItem.bind(loaded.localStorage);
  loaded.localStorage.removeItem = key => {
    if (key === markerKey) throw new Error('injected marker removal failure');
    return realRemoveItem(key);
  };
  const cleared = loaded.ctx._clearProvenOrphanDirtyMarkersAfterPull(
    [{ table: 'singles', id, row_version: 3 }],
    { singles: [], slabs: [], sales: [], etbs: [], booster_boxes: [], booster_packs: [], ebay_purchases: [], trash: [] },
  );
  assert.strictEqual(cleared, 0);
  assert.strictEqual(loaded.localStorage.getItem(markerKey), markerRaw);
  assert.strictEqual(loaded.localStorage.getItem('pokeinv_dirty_v1'), dirtyBefore);
  assert.strictEqual(loaded.grab('_dirty')._dirty.singles.has(id), true);
  assert.strictEqual(loaded.grab('_dirtyRevisions')._dirtyRevisions.singles.get(id), token);
});

test('dirty-persistence: cache preflight failure leaves an orphan marker and exact dirty state recoverable', async () => {
  const id = 'cache_read_failure';
  const token = 'older-tab:cache-read-failure';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const markerRaw = JSON.stringify(orphanMarker(id, token));
  const legacyRaw = JSON.stringify({ singles: [id], _revisions: { singles: { [id]: [token] } } });
  const loaded = await loadApp({
    seed: null,
    localStorage: { [markerKey]: markerRaw, pokeinv_dirty_v1: legacyRaw },
  });
  const dirtyBefore = loaded.localStorage.getItem('pokeinv_dirty_v1');
  const realGetItem = loaded.localStorage.getItem.bind(loaded.localStorage);
  loaded.localStorage.getItem = key => {
    if (key === 'pokeinventory_v3') throw new Error('injected cache read failure');
    return realGetItem(key);
  };
  const cleared = loaded.ctx._clearProvenOrphanDirtyMarkersAfterPull(
    [{ table: 'singles', id, row_version: 3 }],
    { singles: [], slabs: [], sales: [], etbs: [], booster_boxes: [], booster_packs: [], ebay_purchases: [], trash: [] },
  );
  assert.strictEqual(cleared, 0);
  assert.strictEqual(loaded.localStorage.getItem(markerKey), markerRaw);
  assert.strictEqual(loaded.localStorage.getItem('pokeinv_dirty_v1'), dirtyBefore);
  assert.strictEqual(loaded.grab('_dirty')._dirty.singles.has(id), true);
});
