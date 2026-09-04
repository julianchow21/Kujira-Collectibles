'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadApp, plain, syncRequest, syncSuccessResponse, syncCalls, syncOperations,
} = require('./harness.js');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function authorise(ctx) {
  assert.strictEqual(ctx._kjrSaveSession({
    access_token: 'owner-access-token', refresh_token: 'owner-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
  }), true);
}

function copyStorage(localStorage) {
  const out = {};
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key !== null) out[key] = localStorage.getItem(key);
  }
  return out;
}

function mutationKeys(localStorage) {
  const keys = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key && key.startsWith('_kjrMutationGroupV2:')) keys.push(key);
  }
  return keys.sort();
}

test('sync-v2: mutation IDs are RFC 4122 UUID v4 values', async () => {
  const { ctx } = await loadApp();
  const ids = new Set(Array.from({ length: 100 }, () => ctx._newMutationId()));
  assert.strictEqual(ids.size, 100);
  for (const id of ids) assert.match(id, UUID);
});

test('sync-v2: authenticated mutation sends bearer protocol 2 and expected_version for create and update', async () => {
  const { ctx, fetchMock } = await loadApp();
  authorise(ctx);
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    const request = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({ ok: true, mutation_id: request.mutation_id, results: request.operations.map((op, i) => ({
        type: op.type, table: op.table, id: op.id, row_version: i + 1, updated_at: '2026-09-04T00:00:00Z',
      })) }),
      text: async () => '', headers: { get: () => null },
    };
  });
  const create = ctx._upsertOperation('singles', { id: 'new', name: 'New' });
  const update = ctx._upsertOperation('singles', { id: 'old', name: 'Old', _serverVersion: 7 });
  const outcome = await ctx._syncMutate([create, update]);
  assert.strictEqual(outcome.ok, true);
  const call = fetchMock.calls.find(item => item.url.includes('/sync/v2/mutate'));
  assert.strictEqual(call.opts.headers.Authorization, 'Bearer owner-access-token');
  assert.deepStrictEqual(JSON.parse(call.opts.body).operations.map(op => op.expected_version), [0, 7]);
  assert.strictEqual(JSON.parse(call.opts.body).client_protocol, 2);
  assert.doesNotMatch(JSON.stringify(fetchMock.calls.map(call => call.url)), /owner-access-token/,
    'the bearer token stays in headers and is never placed in a logged URL');
});

test('sync-v2: delete contract includes the source row expected_version', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    seed: { singles: [{ id: 'delete-me', name: 'Server row', status: 'Available', _serverVersion: 9 }] },
  });
  authorise(ctx);
  const { DB } = grab('DB');
  const source = DB.singles[0];
  DB.trash.push({ id: 'trash-delete-me', data: { originalTable: 'singles', originalId: 'delete-me', item: JSON.parse(JSON.stringify(source)) } });
  ctx._queuePendingTrash(DB.trash[0]);
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    const request = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => ({ ok: true, mutation_id: request.mutation_id, results: [
      { type: 'delete', table: 'singles', id: 'delete-me', row_version: 10, deleted_at: '2026-09-04T00:00:00Z' },
      { type: 'upsert', table: 'trash', id: 'trash-delete-me', row_version: 1, updated_at: '2026-09-04T00:00:00Z' },
    ] }), text: async () => '', headers: { get: () => null } };
  });
  await ctx.sbDelete('singles', 'delete-me');
  const body = JSON.parse(fetchMock.calls.find(call => call.url.includes('/sync/v2/mutate')).opts.body);
  assert.strictEqual(body.operations[0].type, 'delete');
  assert.strictEqual(body.operations[0].expected_version, 9);
  assert.strictEqual(body.operations[0].trash.id, 'trash-delete-me');
});

test('sync-v2: tombstones apply before live merge and block stale resurrection', async () => {
  const { ctx, grab } = await loadApp();
  const { _dirty } = grab('_dirty');
  const stale = { id: 'gone', name: 'Stale local', _serverVersion: 1 };
  ctx._serverTombstones = [{ table: 'singles', id: 'gone', row_version: 2, deleted_at: '2026-09-04T00:00:00Z' }];
  const merged = ctx.mergeTable([{ id: 'live', name: 'Live', _serverVersion: 1 }], [stale], _dirty.singles, 'singles');
  assert.strictEqual(merged.some(row => row.id === 'gone'), false);
  assert.strictEqual(merged.some(row => row.id === 'live'), true);
});

test('sync-v2: stale delete conflict restores current server row and archives attempted bytes', async () => {
  const { ctx, grab, localStorage } = await loadApp({
    seed: { singles: [{ id: 'same', name: 'Stale local', _serverVersion: 2 }] },
  });
  const operation = { type: 'delete', table: 'singles', id: 'same', expected_version: 2 };
  const conflict = { table: 'singles', id: 'same', current: {
    id: 'same', data: { name: 'Newer server', status: 'Available' }, row_version: 3, updated_at: '2026-09-04T00:00:00Z',
  }, tombstone: null };
  assert.strictEqual(ctx._applySyncConflict(conflict, operation), true);
  assert.strictEqual(grab('DB').DB.singles[0].name, 'Newer server');
  assert.strictEqual(grab('DB').DB.singles[0]._serverVersion, 3);
  assert.match(localStorage.getItem('pokeinv_changelog') || '', /attempted local change preserved here/);
});

test('sync-v2: Quick Sale queues one atomic mutation group with inventory update and Sales create', async () => {
  const { ctx, document, localStorage, grab } = await loadApp({
    seed: { singles: [{ id: 'sell-one', name: 'Pikachu', qty: 2, costPrice: 10, status: 'Available', _serverVersion: 4 }] },
  });
  const values = { 'qs-table': 'singles', 'qs-id': 'sell-one', 'qs-total': '25', 'qs-cost': '10',
    'qs-ship': '2', 'qs-fees': '1', 'qs-channel': 'Carousell', 'qs-date': '2026-09-04', 'qs-buyer': 'Test buyer' };
  for (const [id, value] of Object.entries(values)) document.getElementById(id).value = value;
  ctx.confirmQuickSell();
  const groups = JSON.parse(localStorage.getItem('_kjrMutationGroupsV2'));
  assert.strictEqual(groups.length, 1);
  assert.match(groups[0].mutation_id, UUID);
  assert.strictEqual(groups[0].operations.length, 2);
  assert.deepStrictEqual(plain(groups[0].operations.map(op => [op.table, op.type, op.expected_version])), [
    ['singles', 'upsert', 4], ['sales', 'upsert', 0],
  ]);
  assert.strictEqual(grab('DB').DB.singles[0].qty, 1);
  assert.strictEqual(grab('DB').DB.sales.length, 1);
});

test('sync-v2: crash before local apply replays the queued after-state from its exact before-state', async () => {
  const before = { id: 'crash-before-apply', name: 'Before crash', costPrice: 10, status: 'Available', _serverVersion: 4 };
  const first = await loadApp({ seed: { singles: [before] } });
  const operation = first.ctx._upsertOperation('singles', {
    ...before, name: 'Queued after-state', costPrice: 77,
  });
  const group = first.ctx._queueMutationGroup([operation]);
  assert.ok(group);
  assert.strictEqual(first.grab('DB').DB.singles[0].name, 'Before crash',
    'the crash point is after durable queueing but before local mutation');

  const reloaded = await loadApp({ localStorage: copyStorage(first.localStorage) });
  const recovered = reloaded.grab('DB').DB.singles.find(row => row.id === before.id);
  assert.strictEqual(recovered.name, 'Queued after-state');
  assert.strictEqual(recovered.costPrice, 77);
  assert.strictEqual(recovered._serverVersion, 4);
  assert.strictEqual(reloaded.grab('_dirty')._dirty.singles.has(before.id), true);
  assert.strictEqual(mutationKeys(reloaded.localStorage).length, 1,
    'recovery leaves the transaction queued until the server acknowledges it');
});

test('sync-v2: reload treats an already-applied queued after-state as a no-op', async () => {
  const before = { id: 'already-applied', name: 'Before apply', status: 'Available', _serverVersion: 2 };
  const first = await loadApp({ seed: { singles: [before] } });
  const after = { ...before, name: 'Already applied locally' };
  const group = first.ctx._queueMutationGroup([first.ctx._upsertOperation('singles', after)]);
  assert.ok(group);
  first.grab('DB').DB.singles[0] = after;
  first.ctx.saveData();

  const reloaded = await loadApp({ localStorage: copyStorage(first.localStorage) });
  const rows = reloaded.grab('DB').DB.singles.filter(row => row.id === before.id);
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(plain(rows[0]), after);
  assert.strictEqual(reloaded.grab('_dirty')._dirty.singles.has(before.id), false,
    'an exact already-applied after-state is not manufactured into a new local edit');
  assert.strictEqual(mutationKeys(reloaded.localStorage).length, 1);
});

test('sync-v2: reload preserves a later local edit, then acknowledgement rebases and retries those bytes', async () => {
  const before = { id: 'later-than-queued', name: 'Before queue', costPrice: 20, status: 'Available', _serverVersion: 4 };
  const first = await loadApp({ seed: { singles: [before] } });
  const queued = { ...before, name: 'Queued snapshot', costPrice: 30 };
  const group = first.ctx._queueMutationGroup([first.ctx._upsertOperation('singles', queued)]);
  assert.ok(group);
  const later = { ...before, name: 'Later local edit', costPrice: 99 };
  first.grab('DB').DB.singles[0] = later;
  first.ctx.saveData();

  const reloaded = await loadApp({ localStorage: copyStorage(first.localStorage) });
  const row = reloaded.grab('DB').DB.singles.find(item => item.id === before.id);
  assert.strictEqual(row.name, 'Later local edit');
  assert.strictEqual(row.costPrice, 99);
  assert.strictEqual(reloaded.grab('_dirty')._dirty.singles.has(before.id), true,
    'the before-state mismatch keeps the later bytes and creates durable retry state');

  reloaded.fetchMock.calls.length = 0;
  reloaded.fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  assert.strictEqual(await reloaded.ctx._flushMutationGroups(), true);
  assert.strictEqual(row.name, 'Later local edit');
  assert.strictEqual(row.costPrice, 99);
  assert.strictEqual(row._serverVersion, 5, 'the later edit rebases onto the queued acknowledgement version');
  assert.strictEqual(reloaded.grab('_dirty')._dirty.singles.has(before.id), true);
  assert.strictEqual(mutationKeys(reloaded.localStorage).length, 0);

  reloaded.fetchMock.calls.length = 0;
  await reloaded.ctx._flushDirtyToSupabase();
  const retry = syncOperations(reloaded.fetchMock).find(op => op.table === 'singles' && op.id === before.id);
  assert.ok(retry);
  assert.strictEqual(retry.type, 'upsert');
  assert.strictEqual(retry.expected_version, 5);
  assert.strictEqual(retry.data.name, 'Later local edit');
  assert.strictEqual(retry.data.costPrice, 99);
  assert.strictEqual(reloaded.grab('_dirty')._dirty.singles.has(before.id), false);
});

test('sync-v2: malformed authoritative mutation group fails closed and blocks ordinary writes', async () => {
  const mutationId = '11111111-1111-4111-8111-111111111111';
  const storageKey = '_kjrMutationGroupV2:' + mutationId;
  const malformed = JSON.stringify({
    mutation_id: mutationId,
    created_at: 1,
    operations: [{ type: 'upsert', table: 'singles', id: 'malformed-target', expected_version: -1, data: { name: 'Invalid' } }],
    before_states: [{ table: 'singles', id: 'malformed-target', present: false }],
  });
  const loaded = await loadApp({
    seed: { singles: [{ id: 'ordinary-blocked', name: 'Keep dirty', status: 'Available' }] },
    localStorage: { [storageKey]: malformed },
  });
  loaded.ctx.markDirty('singles', 'ordinary-blocked', loaded.grab('DB').DB.singles[0]);
  loaded.fetchMock.calls.length = 0;

  await loaded.ctx._flushDirtyToSupabase();
  assert.strictEqual(syncCalls(loaded.fetchMock).length, 0);
  assert.strictEqual(loaded.localStorage.getItem(storageKey), malformed,
    'invalid recovery data remains untouched for explicit repair');
  assert.strictEqual(loaded.grab('DB').DB.singles[0].name, 'Keep dirty');
  assert.strictEqual(loaded.grab('_dirty')._dirty.singles.has('ordinary-blocked'), true);
});

test('sync-v2: unstable mutation queue reads fail closed with zero ordinary writes', async () => {
  const loaded = await loadApp({ seed: { singles: [{ id: 'unstable-queue', name: 'Keep me', status: 'Available' }] } });
  loaded.ctx.markDirty('singles', 'unstable-queue', loaded.grab('DB').DB.singles[0]);
  loaded.fetchMock.calls.length = 0;
  const realKey = loaded.localStorage.key.bind(loaded.localStorage);
  const realSetItem = loaded.localStorage.setItem.bind(loaded.localStorage);
  let reads = 0;
  loaded.localStorage.key = index => {
    realSetItem('_queue-read-race-' + (++reads), 'changed');
    return realKey(index);
  };

  await loaded.ctx._flushDirtyToSupabase();
  assert.ok(reads > 0);
  assert.strictEqual(syncCalls(loaded.fetchMock).length, 0);
  assert.strictEqual(loaded.grab('_dirty')._dirty.singles.has('unstable-queue'), true);
  assert.strictEqual(loaded.grab('DB').DB.singles[0].name, 'Keep me');
});

test('sync-v2: mutation queue read exception fails closed with zero ordinary writes', async () => {
  const loaded = await loadApp({ seed: { singles: [{ id: 'queue-read-error', name: 'Keep me too', status: 'Available' }] } });
  loaded.ctx.markDirty('singles', 'queue-read-error', loaded.grab('DB').DB.singles[0]);
  loaded.fetchMock.calls.length = 0;
  loaded.localStorage.key = () => { throw new Error('queue enumeration unavailable'); };

  await loaded.ctx._flushDirtyToSupabase();
  assert.strictEqual(syncCalls(loaded.fetchMock).length, 0);
  assert.strictEqual(loaded.grab('_dirty')._dirty.singles.has('queue-read-error'), true);
  assert.strictEqual(loaded.grab('DB').DB.singles[0].name, 'Keep me too');
});

test('sync-v2: same-tab queue epoch change stops later ordinary table writes', async () => {
  const loaded = await loadApp({
    seed: {
      singles: [{ id: 'epoch-single', name: 'First ordinary write', status: 'Available' }],
      slabs: [{ id: 'epoch-slab', name: 'Must wait', grade: '10', status: 'Available' }],
    },
  });
  loaded.ctx.markDirty('singles', 'epoch-single', loaded.grab('DB').DB.singles[0]);
  loaded.ctx.markDirty('slabs', 'epoch-slab', loaded.grab('DB').DB.slabs[0]);
  loaded.fetchMock.calls.length = 0;
  let queued = false;
  loaded.fetchMock.route('/sync/v2/mutate', (url, opts) => {
    const operation = syncRequest(opts).operations[0];
    if (!queued && operation.table === 'singles') {
      queued = true;
      assert.ok(loaded.ctx._queueMutationGroup([{
        type: 'upsert', table: 'sales', id: 'same-tab-queued-sale', expected_version: 0,
        data: { product: 'Queued during ordinary flush', totalPrice: 12 },
      }]));
    }
    return syncSuccessResponse(opts);
  });

  await loaded.ctx._flushDirtyToSupabase();
  const operations = syncOperations(loaded.fetchMock);
  assert.strictEqual(operations.filter(op => op.table === 'singles').length, 1);
  assert.strictEqual(operations.some(op => op.table === 'slabs'), false,
    'the epoch change blocks ordinary writes that were not yet dispatched');
  assert.strictEqual(loaded.grab('_dirty')._dirty.slabs.has('epoch-slab'), true);
  assert.strictEqual(mutationKeys(loaded.localStorage).length, 1);
});
