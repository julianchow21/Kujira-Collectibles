'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadApp, jsonResponse, plain, syncPullResponse, syncRequest, syncSuccessResponse,
} = require('./harness.js');

const DELETE_STATE_KEY = '_kjrDeleteStateV2';
const TOMBSTONE_CACHE_KEY = '_kjrServerTombstonesV1';
const MUTATION_GROUPS_KEY = '_kjrMutationGroupsV2';
const PENDING_TRASH_KEY = '_kjrPendingTrashWrites';

function copyStorage(localStorage) {
  const out = {};
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key !== null) out[key] = localStorage.getItem(key);
  }
  return out;
}

function deleteState(confirmed) {
  return JSON.stringify({
    schema: 2,
    revision: 'restore-safety-fixture',
    pending: [],
    confirmed,
  });
}

function restoreEntry(id, name) {
  const deletedAt = '2026-09-10T00:00:00.000Z';
  return {
    id: 'trash_' + id,
    data: {
      originalTable: 'singles',
      originalId: id,
      item: { id, name: name || 'Recoverable card', status: 'Available', type: 'raw' },
      deletedAt,
    },
    updated_at: deletedAt,
  };
}

async function queueRestore(id, tombstoneVersion) {
  const entry = restoreEntry(id);
  const tombstone = {
    table: 'singles',
    id,
    row_version: tombstoneVersion,
    deleted_at: entry.data.deletedAt,
  };
  const app = await loadApp();
  app.ctx.DB.trash = [{ ...entry, _serverVersion: 2 }];
  app.ctx._serverTombstones = [tombstone];
  app.ctx._syncPullLoaded = true;
  await app.ctx.restoreFromTrash(entry.id);
  return { app, entry, tombstone };
}

function queuedGroup(localStorage) {
  return JSON.parse(localStorage.getItem(MUTATION_GROUPS_KEY) || '[]');
}

function tombstoneFor(id, rowVersion) {
  return { table: 'singles', id, row_version: rowVersion, deleted_at: '2026-09-10T00:00:00.000Z' };
}

test('restore-safety: an old confirmed-delete device accepts a higher server revision and keeps lower stale rows hidden', async () => {
  const id = 'cross-device-no-token';
  const stale = { id, name: 'Old cached bytes', status: 'Available', _serverVersion: 3 };
  const marker = { table: 'singles', id, ts: 1, restoreToken: '', state: 'deleted', row_version: 4 };
  const app = await loadApp({
    seed: { singles: [stale] },
    localStorage: {
      [DELETE_STATE_KEY]: deleteState([marker]),
      _kjrConfirmedCloudDeletes: JSON.stringify([marker]),
    },
  });
  app.fetchMock.route('/sync/v2/pull', () => syncPullResponse({
    singles: [{ id, data: { name: 'Restored on another device', status: 'Available' },
      row_version: 5, updated_at: '2026-09-10T00:00:00.000Z' }],
  }, []));

  const liveRows = await app.ctx.sbFetchAll('singles');
  const merged = app.ctx.mergeTable(liveRows, [stale], new Set(), 'singles');
  assert.deepStrictEqual(plain(merged).map(row => [row.id, row.name, row._serverVersion]), [
    [id, 'Restored on another device', 5],
  ]);
  assert.strictEqual(app.ctx._readDeleteState().state.confirmed.some(item => item.id === id), false,
    'the marker clears only after the authenticated live revision is strictly newer');

  const lowerRevision = await loadApp({
    seed: { singles: [stale] },
    localStorage: { [DELETE_STATE_KEY]: deleteState([{ ...marker, row_version: 6 }]) },
  });
  lowerRevision.fetchMock.route('/sync/v2/pull', () => syncPullResponse({
    singles: [{ id, data: { name: 'Stale server bytes', status: 'Available' },
      row_version: 5, updated_at: '2026-09-10T00:00:00.000Z' }],
  }, []));
  assert.deepStrictEqual(plain(await lowerRevision.ctx.sbFetchAll('singles')), [],
    'a live row below the deletion floor remains suppressed');
  assert.strictEqual(lowerRevision.ctx._readDeleteState().state.confirmed.some(item => item.id === id), true);
});

test('restore-safety: a legacy marker without a revision stays suppressed and reports the repair prerequisite', async () => {
  const id = 'legacy-marker-no-floor';
  const marker = { table: 'singles', id, ts: 1, restoreToken: '', state: 'deleted' };
  const app = await loadApp({
    seed: { singles: [{ id, name: 'Legacy stale row', status: 'Available', _serverVersion: 2 }] },
    localStorage: { [DELETE_STATE_KEY]: deleteState([marker]) },
  });
  app.fetchMock.route('/sync/v2/pull', () => syncPullResponse({
    singles: [{ id, data: { name: 'Live without a known floor', status: 'Available' },
      row_version: 9, updated_at: '2026-09-10T00:00:00.000Z' }],
  }, []));
  assert.deepStrictEqual(plain(await app.ctx.sbFetchAll('singles')), []);
  assert.ok(app.consoleWarnings.some(message => message.includes('authoritative server revision')),
    'the device reports why it cannot safely clear an unversioned legacy marker');
});

test('restore-safety: a delayed pull cannot overwrite an acknowledged delete state and retries from a fresh snapshot', async () => {
  const id = 'delayed-delete-pull';
  const entry = restoreEntry(id, 'Deleted elsewhere');
  const tombstone = tombstoneFor(id, 5);
  const app = await loadApp({
    seed: { singles: [{ ...entry.data.item, _serverVersion: 4 }] },
  });
  let releaseFirst;
  let pullCalls = 0;
  app.fetchMock.route('/sync/v2/pull', () => {
    pullCalls++;
    if (pullCalls === 1) return new Promise(resolve => { releaseFirst = resolve; });
    return syncPullResponse({
      singles: [],
      trash: [{ ...entry, row_version: 1, updated_at: tombstone.deleted_at }],
    }, [tombstone]);
  });

  const inFlight = app.ctx._pullSyncState();
  await new Promise(resolve => setImmediate(resolve));
  assert.strictEqual(pullCalls, 1);
  assert.strictEqual(app.ctx._confirmDeleteLocally('singles', id, 1, '', tombstone.row_version), true);
  app.ctx.DB.trash = [{ ...entry, _serverVersion: 1 }];
  app.ctx._serverTombstones = [tombstone];

  releaseFirst(syncPullResponse({
    singles: [{ id, data: { name: 'Stale pre-delete pull', status: 'Available' },
      row_version: 3, updated_at: '2026-09-10T00:00:00.000Z' }],
    trash: [],
  }, []));
  await inFlight;

  assert.strictEqual(pullCalls, 2, 'the stale snapshot caused one bounded retry');
  assert.strictEqual(app.ctx.DB.singles.some(row => row.id === id), false);
  assert.strictEqual(app.ctx.DB.trash.some(row => row.id === entry.id), true);
  assert.deepStrictEqual(plain(app.ctx._serverTombstones), [tombstone]);
  assert.strictEqual(app.ctx._readDeleteState().state.confirmed.find(item => item.id === id).row_version, 5);
});

test('restore-safety: nested user keys survive pull clean-up while reserved top-level keys are removed', async () => {
  const app = await loadApp();
  app.fetchMock.route('/sync/v2/pull', () => syncPullResponse({
    singles: [{ id: 'nested-user-data', data: {
      name: 'Nested data', nested: { _userFlag: true, value: 7 }, _serverOnly: 'discard',
    }, row_version: 3, updated_at: '2026-09-10T00:00:00.000Z' }],
  }, []));
  const [row] = await app.ctx.sbFetchAll('singles');
  assert.deepStrictEqual(plain(row), {
    id: 'nested-user-data', name: 'Nested data', nested: { _userFlag: true, value: 7 },
    _serverVersion: 3, _updatedAt: '2026-09-10T00:00:00.000Z',
  });
});

test('restore-safety: every malformed restore acknowledgement leaves the group, dirty row, and Trash recovery copy intact', async (t) => {
  const variants = [
    ['missing result', () => []],
    ['duplicate result', valid => [valid, { ...valid }]],
    ['wrong row', valid => [{ ...valid, id: 'unrelated-row' }]],
    ['wrong type', valid => [{ ...valid, type: 'upsert' }]],
    ['wrong successor', valid => [{ ...valid, row_version: valid.row_version - 1 }]],
    ['restore row version one', valid => [{ ...valid, row_version: 1 }]],
  ];
  for (const [name, makeResults] of variants) {
    await t.test(name, async () => {
      const { app, entry, tombstone } = await queueRestore('malformed-' + name.replace(/\W+/g, '-'), 4);
      app.fetchMock.route('/sync/v2/mutate', (url, opts) => {
        const request = syncRequest(opts);
        const operation = request.operations[0];
        const valid = {
          type: 'restore', table: operation.table, id: operation.id,
          row_version: operation.tombstone_version + 1,
          updated_at: '2026-09-10T00:00:00.000Z',
        };
        return jsonResponse({
          ok: true, mutation_id: request.mutation_id,
          results: makeResults(valid),
        });
      });
      assert.strictEqual(await app.ctx._flushMutationGroups(), false);
      assert.strictEqual(queuedGroup(app.localStorage).length, 1);
      assert.strictEqual(app.ctx.DB.singles.some(row => row.id === entry.data.originalId), true);
      assert.strictEqual(app.ctx.DB.trash.some(row => row.id === entry.id), true);
      assert.strictEqual(app.grab('_dirty')._dirty.singles.has(entry.data.originalId), true);
      assert.strictEqual(queuedGroup(app.localStorage)[0].operations[0].tombstone_version, tombstone.row_version);
    });
  }
});

test('restore-safety: a lost restore response keeps the durable retry and both recovery copies', async () => {
  const { app, entry } = await queueRestore('lost-response', 4);
  app.fetchMock.reject('/sync/v2/mutate', new TypeError('response lost'));
  assert.strictEqual(await app.ctx._flushMutationGroups(), false);
  assert.strictEqual(queuedGroup(app.localStorage).length, 1);
  assert.ok(app.ctx.DB.singles.some(row => row.id === entry.data.originalId));
  assert.ok(app.ctx.DB.trash.some(row => row.id === entry.id));
  assert.ok(app.localStorage.getItem(MUTATION_GROUPS_KEY));
});

test('restore-safety: production restore sends exact legacy Trash bytes, then rebases canonical local bytes', async () => {
  const id = 'legacy-condition-restore';
  const entry = {
    id: 'trash_' + id,
    data: {
      originalTable: 'singles',
      originalId: id,
      item: {
        id,
        name: 'Synthetic legacy condition',
        condition: 'NM',
        status: 'Available',
        type: 'raw',
      },
      deletedAt: '2026-09-10T00:00:00.000Z',
    },
    _serverVersion: 2,
  };
  const tombstone = tombstoneFor(id, 3);
  const app = await loadApp();
  app.ctx.DB.trash = [entry];
  app.ctx._serverTombstones = [tombstone];
  app.ctx._syncPullLoaded = true;

  const restoreData = {
    name: 'Synthetic legacy condition',
    condition: 'NM',
    status: 'Available',
    type: 'raw',
  };
  let restoreRequest = null;
  let upsertRequest = null;
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => {
    const request = syncRequest(opts);
    const operation = request.operations[0];
    if (operation.type === 'restore') {
      restoreRequest = request;
      assert.deepStrictEqual(plain(operation.data), restoreData);
      assert.strictEqual(operation.tombstone_version, 3);
      return syncSuccessResponse(opts);
    }
    upsertRequest = request;
    return syncSuccessResponse(opts);
  });

  await app.ctx.restoreFromTrash(entry.id);
  const queued = queuedGroup(app.localStorage);
  assert.strictEqual(queued.length, 1);
  assert.deepStrictEqual(plain(queued[0].operations[0].data), restoreData);
  const optimistic = app.ctx.DB.singles.find(row => row.id === id);
  assert.strictEqual(optimistic.condition, 'Near Mint');
  assert.strictEqual(app.ctx._dirty.singles.has(id), true);
  assert.strictEqual(app.ctx.DB.trash.some(row => row.id === entry.id), true);

  assert.strictEqual(await app.ctx._flushMutationGroups(), true);
  assert.ok(restoreRequest, 'the restore request was sent');
  assert.strictEqual(queuedGroup(app.localStorage).length, 0);
  assert.strictEqual(app.ctx.DB.trash.some(row => row.id === entry.id), false);
  assert.strictEqual(app.ctx._serverTombstones.some(row => row.id === id), false);
  assert.strictEqual(app.ctx.DB.singles.find(row => row.id === id).condition, 'Near Mint');
  assert.strictEqual(app.ctx.DB.singles.find(row => row.id === id)._serverVersion, 4);
  assert.strictEqual(app.ctx._dirty.singles.has(id), true,
    'canonical local bytes remain dirty after the exact legacy restore is acknowledged');

  await app.ctx._flushDirtyToSupabase();
  assert.ok(upsertRequest, 'the canonical follow-up upsert was sent');
  assert.strictEqual(upsertRequest.operations.length, 1);
  assert.strictEqual(upsertRequest.operations[0].type, 'upsert');
  assert.strictEqual(upsertRequest.operations[0].expected_version, 4);
  assert.strictEqual(upsertRequest.operations[0].data.condition, 'Near Mint');
  assert.strictEqual(app.ctx.DB.singles.find(row => row.id === id)._serverVersion, 5);
});

test('restore-safety: a newer tombstone conflict preserves latest attempted bytes, Trash, and a deliberate later retry', async () => {
  const { app, entry } = await queueRestore('newer-tombstone', 4);
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => {
    const request = syncRequest(opts);
    return jsonResponse({
      ok: false,
      code: 'version_conflict',
      mutation_id: request.mutation_id,
      conflicts: [{
        table: 'singles', id: entry.data.originalId, current: null,
        tombstone: tombstoneFor(entry.data.originalId, 5),
      }],
    });
  });
  assert.strictEqual(await app.ctx._flushMutationGroups(), true);
  assert.strictEqual(queuedGroup(app.localStorage).length, 0);
  assert.strictEqual(app.ctx.DB.singles.some(row => row.id === entry.data.originalId), false);
  assert.strictEqual(app.ctx.DB.trash.some(row => row.id === entry.id), true);
  const pending = JSON.parse(app.localStorage.getItem(PENDING_TRASH_KEY) || '[]');
  assert.strictEqual(pending.some(row => row.id === entry.id), true);
  assert.strictEqual(app.ctx._serverTombstones.find(row => row.id === entry.data.originalId).row_version, 5);
  assert.match(app.localStorage.getItem('pokeinv_changelog') || '', /attempted local change preserved here/);

  await app.ctx.restoreFromTrash(entry.id);
  assert.strictEqual(queuedGroup(app.localStorage).length, 1);
  assert.strictEqual(queuedGroup(app.localStorage)[0].operations[0].tombstone_version, 5,
    'the user can deliberately retry against the newer authoritative tombstone');
  assert.ok(app.ctx.DB.singles.some(row => row.id === entry.data.originalId));
});

test('restore-safety: a persistence failure after a valid acknowledgement keeps the restore queued and recoverable', async () => {
  const { app, entry } = await queueRestore('persistence-failure', 4);
  const realSetItem = app.localStorage.setItem.bind(app.localStorage);
  app.localStorage.setItem = (key, value) => {
    if (key === TOMBSTONE_CACHE_KEY) throw new Error('tombstone cache unavailable');
    return realSetItem(key, value);
  };
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));

  assert.strictEqual(await app.ctx._flushMutationGroups(), false);
  assert.strictEqual(queuedGroup(app.localStorage).length, 1);
  assert.strictEqual(app.ctx.DB.singles.some(row => row.id === entry.data.originalId), true);
  assert.strictEqual(app.ctx.DB.trash.some(row => row.id === entry.id), true);
  assert.strictEqual(app.ctx._serverTombstones.some(row => row.id === entry.data.originalId), true);

  app.localStorage.setItem = realSetItem;
  assert.strictEqual(await app.ctx._flushMutationGroups(), true);
  assert.strictEqual(queuedGroup(app.localStorage).length, 0);
  assert.strictEqual(app.ctx.DB.trash.some(row => row.id === entry.id), false);
});

test('restore-safety: conflict validation rejects empty, unrelated, and contradictory lists but accepts authoritative absence', async () => {
  const cases = [
    ['empty', []],
    ['unrelated', [{ table: 'singles', id: 'other', current: null, tombstone: null }]],
    ['contradictory', [{
      table: 'singles', id: 'absence-target',
      current: { id: 'absence-target', data: { name: 'live' }, row_version: 3 },
      tombstone: { table: 'singles', id: 'absence-target', row_version: 3 },
    }]],
  ];
  for (const [name, conflicts] of cases) {
    const app = await loadApp();
    app.fetchMock.route('/sync/v2/mutate', (url, opts) => {
      const request = syncRequest(opts);
      return jsonResponse({ ok: false, code: 'version_conflict', mutation_id: request.mutation_id, conflicts });
    });
    const operation = {
      type: 'restore', table: 'singles', id: 'absence-target', expected_version: 0,
      tombstone_version: 2, data: { name: 'attempted' }, trash_id: 'trash-absence-target',
    };
    await assert.rejects(() => app.ctx._syncMutate([operation], app.ctx._newMutationId()), /sync_request_failed/, name);
  }

  const accepted = await loadApp();
  accepted.fetchMock.route('/sync/v2/mutate', (url, opts) => {
    const request = syncRequest(opts);
    return jsonResponse({
      ok: false, code: 'version_conflict', mutation_id: request.mutation_id,
      conflicts: [{ table: 'singles', id: 'absence-target', current: null, tombstone: null }],
    });
  });
  const operation = {
    type: 'restore', table: 'singles', id: 'absence-target', expected_version: 0,
    tombstone_version: 2, data: { name: 'attempted' }, trash_id: 'trash-absence-target',
  };
  const outcome = await accepted.ctx._syncMutate([operation], accepted.ctx._newMutationId());
  assert.strictEqual(outcome.ok, false);
  assert.strictEqual(outcome.conflicts.length, 1);
});

test('restore-safety: client operation validation follows the SQL table and revision contract', async () => {
  const { ctx } = await loadApp();
  const base = { type: 'delete', table: 'singles', id: 'row', expected_version: 1 };
  assert.strictEqual(ctx._validSyncOperation({ ...base, expected_version: 0 }), false);
  assert.strictEqual(ctx._validSyncOperation({ type: 'restore', table: 'trash', id: 'row', expected_version: 0,
    tombstone_version: 2, data: {}, trash_id: 'trash-row' }), false);
  assert.strictEqual(ctx._validSyncOperation({ type: 'upsert', table: 'trash', id: 'row', expected_version: 0, data: {} }), false);
  assert.strictEqual(ctx._validSyncOperation({ ...base, table: 'versions', expected_version: 1 }), true);
  assert.strictEqual(ctx._expectedSyncResults([{ ...base, table: 'versions', expected_version: 1,
    data: { should: 'not be used' } }]).size, 1,
    'a versions delete has no implicit Trash companion result');
  const deleteWithTrash = {
    ...base,
    trash: { id: 'trash-row', data: { originalTable: 'singles', originalId: 'row', item: { id: 'row' } } },
  };
  assert.strictEqual(ctx._expectedSyncResults([
    { type: 'upsert', table: 'singles', id: 'row', expected_version: 1, data: { name: 'same target' } },
    deleteWithTrash,
  ]), null, 'mixed operation types cannot target the same source row');
  assert.strictEqual(ctx._expectedSyncResults([
    deleteWithTrash,
    { type: 'delete', table: 'trash', id: 'trash-row', expected_version: 1 },
  ]), null, 'an explicit Trash operation cannot collide with a delete companion');
});

test('restore-safety: a queued restore reloads with its exact snapshot and remains pending for retry', async () => {
  const { app, entry, tombstone } = await queueRestore('reload-pending', 4);
  const storage = copyStorage(app.localStorage);
  storage[TOMBSTONE_CACHE_KEY] = JSON.stringify([tombstone]);
  const reloaded = await loadApp({
    seed: null,
    localStorage: storage,
    fetch: async url => {
      if (url.includes('/sync/v2/pull')) {
        return syncPullResponse({
          singles: [],
          trash: [{ ...entry, row_version: 1, updated_at: tombstone.deleted_at }],
        }, [tombstone]);
      }
      if (url.includes('/sync/v2/mutate')) return jsonResponse({ ok: false, code: 'unavailable' }, 503);
      return jsonResponse({ rates: { SGD: 1.3 } });
    },
  });
  assert.ok(reloaded.ctx.DB.singles.some(row => row.id === entry.data.originalId));
  assert.ok(reloaded.ctx.DB.trash.some(row => row.id === entry.id));
  assert.ok(JSON.parse(reloaded.localStorage.getItem(PENDING_TRASH_KEY) || '[]').some(row => row.id === entry.id));
  assert.strictEqual(queuedGroup(reloaded.localStorage).length, 1);
});
