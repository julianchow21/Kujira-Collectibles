'use strict';
// Suite 19: trash-lifecycle - sendToTrash, kjrDeleteRow, purgeExpiredTrash,
// restoreFromTrash.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadApp, plain, jsonResponse, syncRequest, syncSuccessResponse,
  syncPullResponse, syncCalls, syncOperations,
} = require('./harness.js');

const LOCALHOST_LOCATION = {
  protocol: 'http:', hostname: 'localhost', host: 'localhost:3800',
  href: 'http://localhost:3800/', origin: 'http://localhost:3800',
  pathname: '/', search: '',
};

function copyStorage(localStorage) {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) out[key] = localStorage.getItem(key);
  }
  return out;
}

function deleteStateV2(pending = [], confirmed = [], revision = 'test-revision') {
  return JSON.stringify({ schema: 2, revision, pending, confirmed });
}

function setDeleteStateV2(localStorage, pending = [], confirmed = [], revision) {
  localStorage.setItem('_kjrDeleteStateV2', deleteStateV2(pending, confirmed, revision));
}

function getDeleteStateV2(localStorage) {
  return JSON.parse(localStorage.getItem('_kjrDeleteStateV2'));
}

async function queuedRestoreFixture(id, tombstoneVersion) {
  const deletedAt = '2026-09-04T00:00:00.000Z';
  const tombstone = { table: 'singles', id, row_version: tombstoneVersion, deleted_at: deletedAt };
  const entry = {
    id: 'trash_' + id,
    data: {
      originalTable: 'singles', originalId: id,
      item: { id, name: 'Queued restore ' + id, status: 'Available' },
      deletedAt,
    },
    updated_at: deletedAt,
  };
  const first = await loadApp();
  first.grab('DB').DB.trash = [{ ...entry, _serverVersion: 2 }];
  first.ctx._serverTombstones = [tombstone];
  first.ctx._syncPullLoaded = true;
  await first.ctx.restoreFromTrash(entry.id);
  const storage = copyStorage(first.localStorage);
  storage._kjrServerTombstonesV1 = JSON.stringify([tombstone]);
  return { storage, tombstone, restored: entry.data.item };
}

test('trash-lifecycle: sendToTrash (localhost, local path) - entry shape and DB.trash push', async () => {
  const { ctx, grab } = await loadApp({ location: LOCALHOST_LOCATION });
  const item = { id: 's1', name: 'Test Card', costPrice: 10 };
  await ctx.sendToTrash('singles', item, 'manual');
  const { DB } = grab('DB');
  assert.strictEqual(DB.trash.length, 1);
  const entry = DB.trash[0];
  assert.match(entry.id, /^trash_/);
  assert.strictEqual(entry.data.originalTable, 'singles');
  assert.strictEqual(entry.data.originalId, 's1');
  assert.strictEqual(entry.data.reason, 'manual');
  assert.ok(entry.data.deletedAt);
  assert.strictEqual(entry.data.item.name, 'Test Card', 'full snapshot of the item is kept');
});

test('trash-lifecycle: sendToTrash does NOT itself remove the row from the source table (that is the caller\'s job, e.g. kjrDeleteRow)', async () => {
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    seed: { singles: [{ id: 's1', name: 'Still Here', status: 'Available' }] },
  });
  await ctx.sendToTrash('singles', { id: 's1', name: 'Still Here' }, 'manual');
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.length, 1, 'sendToTrash only writes the snapshot - it never touches DB.singles itself');
});

test('trash-lifecycle: sendToTrash on github.io durably queues the snapshot before any CAS delete', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  await ctx.sendToTrash('singles', { id: 's1', name: 'Test' }, 'manual');
  const pending = JSON.parse(localStorage.getItem('_kjrPendingTrashWrites') || '[]');
  assert.strictEqual(pending.length, 1, 'the recoverable snapshot is durable before the server transaction starts');
  assert.strictEqual(pending[0].data.originalId, 's1');
  assert.strictEqual(syncCalls(fetchMock).length, 0, 'sendToTrash alone never sends a non-atomic cloud write');
});

test('trash-lifecycle: a successful atomic CAS delete clears the pending Trash snapshot', async () => {
  const row = { id: 's1', name: 'Test', _serverVersion: 4 };
  const { ctx, fetchMock, localStorage, grab } = await loadApp({ seed: { singles: [row] } });
  fetchMock.calls.length = 0;
  await ctx.sendToTrash('singles', grab('DB').DB.singles[0], 'manual');
  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts, (results, request) => [
    ...results,
    { type: 'upsert', table: 'trash', id: request.operations[0].trash.id,
      row_version: 1, updated_at: '2026-09-04T00:00:00.000Z' },
  ]));
  assert.strictEqual(await ctx.sbDelete('singles', row.id), true);
  assert.deepStrictEqual(JSON.parse(localStorage.getItem('_kjrPendingTrashWrites') || '[]'), []);
  assert.ok(grab('DB').DB.trash.some(entry => entry.data.originalId === row.id));
});

test('trash-lifecycle: a failed cloud delete older than seven days stays queued until confirmed success', async () => {
  const old = { table: 'singles', id: 'old_failed_delete', ts: Date.now() - 8 * 86400000 };
  const { ctx, fetchMock, localStorage, grab } = await loadApp({
    localStorage: {
      _kjrPendingCloudDeletes: JSON.stringify([old]),
      _kjrPendingTrashWrites: JSON.stringify([{ id: 'trash-old-failed', data: {
        originalTable: 'singles', originalId: old.id, item: { id: old.id, name: 'Old failed delete', _serverVersion: 2 },
      } }]),
    },
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', () => jsonResponse({ ok: false, code: 'unavailable' }, 503));
  await ctx.flushPendingDeletes();
  const pending = JSON.parse(localStorage.getItem('_kjrPendingCloudDeletes'));
  assert.strictEqual(pending.length, 1, 'age never converts a failed delete into a cleared delete');
  assert.strictEqual(pending[0].id, 'old_failed_delete');
  assert.strictEqual(grab('_syncStatus')._syncStatus, 'error',
    'an old failure is surfaced through the sync status without being discarded');
});

test('trash-lifecycle: a delete queued during retry write-back is not clobbered by an older success', async () => {
  const first = { table: 'singles', id: 'first_delete', ts: Date.now() - 1000 };
  const { ctx, fetchMock, localStorage } = await loadApp({
    localStorage: {
      _kjrPendingCloudDeletes: JSON.stringify([first]),
      _kjrPendingTrashWrites: JSON.stringify([{ id: 'trash-first-delete', data: {
        originalTable: 'singles', originalId: first.id, item: { id: first.id, name: 'First delete', _serverVersion: 2 },
      } }]),
    },
  });
  fetchMock.calls.length = 0;
  let releaseDelete;
  let announceDelete;
  const deleteStarted = new Promise(resolve => { announceDelete = resolve; });
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    announceDelete();
    return new Promise(resolve => {
      releaseDelete = () => resolve(syncSuccessResponse(opts));
    });
  });
  const flushing = ctx.flushPendingDeletes();
  await deleteStarted;
  ctx._queuePendingDelete('slabs', 'new_delete');
  releaseDelete();
  await flushing;
  const pending = JSON.parse(localStorage.getItem('_kjrPendingCloudDeletes'));
  assert.deepStrictEqual(pending.map(item => item.id), ['new_delete'],
    'write-back removes the confirmed snapshot only and preserves the concurrent addition');
});

test('trash-lifecycle: a queued delete stays hidden from cached and cloud rows while retry is failing', async () => {
  const doomed = { id: 'doomed_1', name: 'Must Stay Deleted', status: 'Available' };
  const response = (status, json, text) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => text || JSON.stringify(json),
    headers: { get: () => null },
  });
  const { grab, localStorage } = await loadApp({
    seed: { singles: [doomed] },
    localStorage: {
      _kjrPendingCloudDeletes: JSON.stringify([{ table: 'singles', id: 'doomed_1', ts: Date.now() }]),
      _kjrPendingTrashWrites: JSON.stringify([{ id: 'trash-doomed-1', data: {
        originalTable: 'singles', originalId: doomed.id, item: doomed,
      } }]),
    },
    fetch: async (url, opts) => {
      if (url.includes('/sync/v2/mutate')) return response(503, { ok: false }, 'delete still failing');
      if (url.includes('/sync/v2/pull')) {
        const data = { ...doomed };
        delete data.id;
        return syncPullResponse({ singles: [{ id: doomed.id, data, row_version: 1, updated_at: '2026-08-29T12:00:00.000Z' }] });
      }
      return response(200, { rates: { SGD: 1.3 } });
    },
  });
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.some(row => row.id === 'doomed_1'), false,
    'neither the quick local paint nor the cloud merge resurrects a queued deletion');
  assert.strictEqual(JSON.parse(localStorage.getItem('_kjrPendingCloudDeletes')).length, 1,
    'the failed delete remains queued while hidden');
});

test('trash-lifecycle: successful retry purges stale cache before its pending marker clears and reload stays deleted', async () => {
  const doomed = { id: 'doomed_retry_1', name: 'Must Not Return', status: 'Available' };
  let deleteSucceeds = false;
  const response = (status, json, text) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => text || JSON.stringify(json),
    headers: { get: () => null },
  });
  const pending = [{ table: 'singles', id: doomed.id, ts: Date.now(), restoreToken: '' }];
  const first = await loadApp({
    seed: { singles: [doomed] },
    localStorage: {
      _kjrPendingCloudDeletes: JSON.stringify(pending),
      _kjrPendingTrashWrites: JSON.stringify([{ id: 'trash-doomed-retry', data: {
        originalTable: 'singles', originalId: doomed.id, item: doomed,
      } }]),
    },
    fetch: async (url, opts) => {
      if (url.includes('/sync/v2/mutate')) {
        return deleteSucceeds ? syncSuccessResponse(opts) : response(503, { ok: false }, 'offline');
      }
      if (url.includes('/sync/v2/pull')) {
        const data = { ...doomed };
        delete data.id;
        return syncPullResponse({ singles: [{ id: doomed.id, data, row_version: 1, updated_at: '2026-08-29T12:00:00.000Z' }] });
      }
      return response(200, { rates: { SGD: 1.3 } });
    },
  });
  assert.strictEqual(first.grab('DB').DB.singles.some(row => row.id === doomed.id), false);
  assert.strictEqual(JSON.parse(first.localStorage.getItem('_kjrPendingCloudDeletes')).length, 1);

  deleteSucceeds = true;
  await first.ctx.flushPendingDeletes();
  assert.deepStrictEqual(JSON.parse(first.localStorage.getItem('_kjrPendingCloudDeletes')), []);
  assert.strictEqual(JSON.parse(first.localStorage.getItem('pokeinventory_v3')).singles.some(row => row.id === doomed.id), false,
    'confirmed success removes stale cached bytes before the retry obligation clears');

  const reloaded = await loadApp({
    seed: null,
    localStorage: {
      pokeinventory_v3: first.localStorage.getItem('pokeinventory_v3'),
      _kjrPendingCloudDeletes: first.localStorage.getItem('_kjrPendingCloudDeletes'),
      _kjrConfirmedCloudDeletes: first.localStorage.getItem('_kjrConfirmedCloudDeletes'),
    },
    fetch: async (url) => url.includes('/sync/v2/pull') ? syncPullResponse() : response(200, { rates: { SGD: 1.3 } }),
  });
  assert.strictEqual(reloaded.grab('DB').DB.singles.some(row => row.id === doomed.id), false);
  assert.strictEqual(syncOperations(reloaded.fetchMock).some(op => op.type === 'upsert' && op.table === 'singles'), false,
    'reload never re-uploads a quick-painted stale row');
});

test('trash-lifecycle: kjrDeleteRow (confirmed) - the original row is REMOVED from its table and a matching trash entry appears, never hard-deleted', async () => {
  const { ctx, grab, settle } = await loadApp({
    location: LOCALHOST_LOCATION,
    seed: { singles: [{ id: 's1', name: 'To Delete', status: 'Available' }] },
  });
  ctx.confirm = () => true; // kjrConfirm's native-confirm fallback path (no real <dialog> in the stub DOM)
  await ctx.kjrDeleteRow('singles', 's1');
  await settle(); // kjrDeleteRow's background Promise.all([sendToTrash, sbDelete]) is fire-and-forget
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.find((r) => r.id === 's1'), undefined, 'removed from the live table');
  assert.strictEqual(DB.trash.length, 1, 'but recoverable from trash, not hard-deleted');
  assert.strictEqual(DB.trash[0].data.originalId, 's1');
  assert.strictEqual(DB.trash[0].data.originalTable, 'singles');
});

test('trash-lifecycle: kjrDeleteRow (cancelled) - nothing happens when confirm resolves false', async () => {
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    seed: { singles: [{ id: 's1', name: 'Keep Me', status: 'Available' }] },
  });
  // Default confirm() shim already resolves false - the harness's deliberate default.
  await ctx.kjrDeleteRow('singles', 's1');
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.length, 1, 'row survives - the delete was never confirmed');
  assert.strictEqual(DB.trash.length, 0);
});

test('trash-lifecycle: purgeExpiredTrash - purges entries older than 30 days, keeps fresh ones (localhost, local DB.trash)', async () => {
  const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
  const freshDate = new Date().toISOString();
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: {
      _kjrLocalTrash: JSON.stringify([
        { id: 'trash_old', data: { originalTable: 'singles', originalId: 'old1', item: {}, deletedAt: oldDate }, updated_at: oldDate },
        { id: 'trash_fresh', data: { originalTable: 'singles', originalId: 'fresh1', item: {}, deletedAt: freshDate }, updated_at: freshDate },
      ]),
    },
  });
  await ctx.purgeExpiredTrash();
  const { DB } = grab('DB');
  const ids = plain(DB.trash).map((e) => e.id);
  assert.deepStrictEqual(ids, ['trash_fresh'], 'the 40-day-old entry is purged, the fresh one survives');
});

test('trash-lifecycle: the app itself schedules purgeExpiredTrash as a captured ~5s timeout at load - invoking it drives the same purge', async () => {
  const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
  const { timers, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: {
      _kjrLocalTrash: JSON.stringify([
        { id: 'trash_old', data: { originalTable: 'singles', originalId: 'old1', item: {}, deletedAt: oldDate }, updated_at: oldDate },
      ]),
    },
  });
  const captured = timers.list().find((t) => t.type === 'timeout' && t.delay === 5000);
  assert.ok(captured, 'app.js registers a 5000ms setTimeout for purgeExpiredTrash at load, never auto-firing in the harness');
  timers.invoke(captured.id);
  await new Promise((r) => setImmediate(r)); // let the now-invoked async purgeExpiredTrash settle
  await new Promise((r) => setImmediate(r));
  const { DB } = grab('DB');
  assert.strictEqual(DB.trash.length, 0, 'driving the captured callback purged the stale entry exactly like calling purgeExpiredTrash() directly');
});

test('trash-lifecycle: restoreFromTrash - the row returns to its original table and the trash entry is cleared', async () => {
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: {
      _kjrLocalTrash: JSON.stringify([
        { id: 'trash_1', data: { originalTable: 'singles', originalId: 's1', item: { id: 's1', name: 'Restored Card', status: 'Available' }, deletedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
      ]),
    },
  });
  await ctx.restoreFromTrash('trash_1');
  const { DB } = grab('DB');
  assert.ok(DB.singles.some((r) => r.id === 's1' && r.name === 'Restored Card'), 'row is back in DB.singles');
  assert.strictEqual(DB.trash.length, 0, 'the trash entry is gone after a successful restore');
});

test('trash-lifecycle: restoring a row queues one tombstone-checked CAS restore', async () => {
  const entry = {
    id: 'trash_restore_1',
    data: {
      originalTable: 'singles', originalId: 'restore_1',
      item: { id: 'restore_1', name: 'Restored Against Retry', status: 'Available' },
      deletedAt: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
  const { ctx, fetchMock, localStorage, grab } = await loadApp({
    localStorage: {
      _kjrPendingCloudDeletes: JSON.stringify([{ table: 'singles', id: 'restore_1', ts: Date.now() }]),
    },
  });
  fetchMock.calls.length = 0;
  grab('DB').DB.trash = [{ ...entry, _serverVersion: 3 }];
  ctx._serverTombstones = [{ table: 'singles', id: 'restore_1', row_version: 4, deleted_at: entry.data.deletedAt }];
  ctx._syncPullLoaded = true;

  const messages = [];
  ctx.toast = message => messages.push(message);
  await ctx.restoreFromTrash('trash_restore_1');
  const { DB } = grab('DB');
  assert.ok(DB.singles.some(row => row.id === 'restore_1'));
  const groups = JSON.parse(localStorage.getItem('_kjrMutationGroupsV2'));
  assert.strictEqual(groups.length, 1);
  assert.deepStrictEqual(plain(groups[0].operations.map(op => [op.type, op.table, op.id, op.tombstone_version, op.trash_id])), [
    ['restore', 'singles', 'restore_1', 4, 'trash_restore_1'],
  ]);
  assert.strictEqual(syncCalls(fetchMock).length, 0, 'restore is durable locally before its debounced CAS request');
  assert.ok(messages.some(message => message.includes('Restore queued locally')),
    'optimistic UI says the restore is queued, not already confirmed');

  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  assert.strictEqual(await ctx._flushMutationGroups(), true);
  assert.ok(messages.includes('Restore synced'), 'final success appears only after the server acknowledgement');
});

test('trash-lifecycle: matching restore tombstone is suppressed across a fresh-tab pull while CAS remains queued', async () => {
  const fixture = await queuedRestoreFixture('restore_fresh_matching', 4);
  const serverControl = {
    id: 'server_control_matching', data: { name: 'Server control', status: 'Available' },
    row_version: 1, updated_at: '2026-09-04T00:00:00.000Z',
  };
  const reloaded = await loadApp({
    seed: null,
    localStorage: fixture.storage,
    fetch: async (url) => url.includes('/sync/v2/pull')
      ? syncPullResponse({ singles: [serverControl] }, [fixture.tombstone])
      : jsonResponse({ rates: { SGD: 1.3 } }),
  });

  assert.ok(reloaded.grab('DB').DB.singles.some(row => row.id === fixture.restored.id),
    'the matching cached and pulled tombstone cannot erase the queued restore');
  assert.strictEqual(reloaded.ctx._serverTombstones.some(row =>
    row.table === fixture.tombstone.table && row.id === fixture.tombstone.id &&
    row.row_version === fixture.tombstone.row_version), false);
  assert.strictEqual(JSON.parse(reloaded.localStorage.getItem('_kjrMutationGroupsV2')).length, 1,
    'the restore remains queued until its CAS request is acknowledged');
});

test('trash-lifecycle: a newer tombstone still wins over a queued restore after a fresh-tab pull', async () => {
  const fixture = await queuedRestoreFixture('restore_fresh_newer_delete', 4);
  const newerTombstone = { ...fixture.tombstone, row_version: 5, deleted_at: '2026-09-04T00:01:00.000Z' };
  const serverControl = {
    id: 'server_control_newer', data: { name: 'Server control', status: 'Available' },
    row_version: 1, updated_at: '2026-09-04T00:00:00.000Z',
  };
  const reloaded = await loadApp({
    seed: null,
    localStorage: fixture.storage,
    fetch: async (url) => url.includes('/sync/v2/pull')
      ? syncPullResponse({ singles: [serverControl] }, [newerTombstone])
      : jsonResponse({ rates: { SGD: 1.3 } }),
  });

  assert.strictEqual(reloaded.grab('DB').DB.singles.some(row => row.id === fixture.restored.id), false,
    'a later server delete is authoritative');
  assert.ok(reloaded.ctx._serverTombstones.some(row =>
    row.table === newerTombstone.table && row.id === newerTombstone.id &&
    row.row_version === newerTombstone.row_version));
});

test('trash-lifecycle: restore queued during a stale delete retry survives that response', async () => {
  const id = 'restore_during_retry';
  const pending = { table: 'singles', id, ts: Date.now(), restoreToken: '' };
  const entry = {
    id: 'trash_restore_during_retry',
    data: {
      originalTable: 'singles', originalId: id,
      item: { id, name: 'Recovered during retry', status: 'Available' },
      deletedAt: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
  const { ctx, fetchMock, localStorage, grab } = await loadApp();
  grab('DB').DB.singles = grab('DB').DB.singles.filter(row => row.id !== id);
  grab('DB').DB.trash = [{ ...entry, _serverVersion: 2 }];
  ctx._serverTombstones = [{ table: 'singles', id, row_version: 3, deleted_at: entry.data.deletedAt }];
  ctx._syncPullLoaded = true;
  const cache = JSON.parse(localStorage.getItem('pokeinventory_v3'));
  cache.singles = cache.singles.filter(row => row.id !== id);
  localStorage.setItem('pokeinventory_v3', JSON.stringify(cache));
  setDeleteStateV2(localStorage, [pending]);
  fetchMock.calls.length = 0;

  let releaseDelete;
  let announceDelete;
  const deleteStarted = new Promise(resolve => { announceDelete = resolve; });
  ctx._queuePendingTrash(entry);
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    const operation = syncRequest(opts).operations[0];
    if (operation.type === 'delete') {
      announceDelete();
      return new Promise(resolve => {
        releaseDelete = () => resolve(syncSuccessResponse(opts));
      });
    }
    return syncSuccessResponse(opts);
  });

  const retrying = ctx.flushPendingDeletes();
  await deleteStarted;
  const restoring = ctx.restoreFromTrash(entry.id);
  await restoring;
  assert.strictEqual(JSON.parse(localStorage.getItem('_kjrMutationGroupsV2')).length, 1,
    'the inverse transaction is durable before the stale delete response is released');
  releaseDelete();
  await retrying;

  const restored = grab('DB').DB.singles.find(row => row.id === id);
  assert.ok(restored, 'stale retry confirmation does not evict the restored in-memory row');
  assert.ok(JSON.parse(localStorage.getItem('pokeinventory_v3')).singles.some(row => row.id === id),
    'the cache retains a recovery copy while the queued restore awaits its CAS flush');
  assert.strictEqual(JSON.parse(localStorage.getItem('_kjrMutationGroupsV2')).length, 1,
    'the queued restore, not an unsafe blind upsert, remains the recovery obligation');
});

test('trash-lifecycle: direct delete skips stale confirmation after its exact pending attempt is cancelled', async () => {
  const id = 'direct_cancel_race';
  const restored = { id, name: 'Direct-path restore wins', status: 'Available', _restoreToken: 'restore_direct_new' };
  const { ctx, fetchMock, localStorage, grab } = await loadApp({ seed: { singles: [{ id, name: 'Delete me', status: 'Available' }] } });
  fetchMock.calls.length = 0;
  let releaseDelete;
  let announceDelete;
  const deleteStarted = new Promise(resolve => { announceDelete = resolve; });
  const source = grab('DB').DB.singles[0];
  ctx._queuePendingTrash({ id: 'trash-direct-cancel', data: {
    originalTable: 'singles', originalId: id, item: JSON.parse(JSON.stringify(source)),
  } });
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    announceDelete();
    return new Promise(resolve => {
      releaseDelete = () => resolve(syncSuccessResponse(opts));
    });
  });

  const deleting = ctx.sbDelete('singles', id);
  await deleteStarted;
  assert.strictEqual(await ctx._queueDeleteStateOp(() => ctx._cancelPendingDelete('singles', id, restored._restoreToken)), true);
  grab('DB').DB.singles = [restored];
  const cache = JSON.parse(localStorage.getItem('pokeinventory_v3'));
  cache.singles = [restored];
  localStorage.setItem('pokeinventory_v3', JSON.stringify(cache));
  ctx.markDirty('singles', id, restored);
  releaseDelete();
  assert.strictEqual(await deleting, true);
  assert.strictEqual(grab('DB').DB.singles[0].name, restored.name);
  assert.strictEqual(JSON.parse(localStorage.getItem('pokeinventory_v3')).singles[0].name, restored.name);
  assert.strictEqual(grab('_dirty')._dirty.singles.has(id), true);
});

test('trash-lifecycle: restore aborts before DB or cloud writes when the server tombstone is missing', async () => {
  const entry = {
    id: 'trash_restore_fail_closed',
    data: {
      originalTable: 'singles', originalId: 'restore_fail_closed',
      item: { id: 'restore_fail_closed', name: 'Protected restore', status: 'Available' },
      deletedAt: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
  const { ctx, fetchMock, localStorage, grab } = await loadApp();
  fetchMock.calls.length = 0;
  grab('DB').DB.trash = [{ ...entry, _serverVersion: 2 }];
  ctx._serverTombstones = [];
  ctx._syncPullLoaded = true;

  await ctx.restoreFromTrash(entry.id);
  assert.strictEqual(grab('DB').DB.singles.some(row => row.id === 'restore_fail_closed'), false);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.strictEqual(localStorage.getItem('_kjrMutationGroupsV2'), null,
    'Trash remains the recovery copy when cancellation is not durable');
});

test('trash-lifecycle: restore acknowledgement rebases onto a later local edit without losing it', async () => {
  const entry = {
    id: 'trash_restore_cache_race',
    data: {
      originalTable: 'singles', originalId: 'restore_cache_race',
      item: { id: 'restore_cache_race', name: 'Restored row', status: 'Available' },
      deletedAt: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  const state = ctx.DB;
  state.trash = [{ ...entry, _serverVersion: 2 }];
  ctx._serverTombstones = [{ table: 'singles', id: 'restore_cache_race', row_version: 3, deleted_at: entry.data.deletedAt }];
  ctx._syncPullLoaded = true;
  await ctx.restoreFromTrash(entry.id);
  let calls = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    calls += 1;
    if (calls === 1) {
      const row = state.singles.find(candidate => candidate.id === 'restore_cache_race');
      row.name = 'Newer local restore edit';
      ctx.markDirty('singles', row.id, row);
      ctx.saveData();
    }
    return syncSuccessResponse(opts);
  });

  assert.strictEqual(await ctx._flushMutationGroups(), true);
  const rebased = state.singles.find(row => row.id === 'restore_cache_race');
  assert.strictEqual(rebased.name, 'Newer local restore edit');
  assert.strictEqual(rebased._serverVersion, 1, 'the later edit rebases onto the acknowledged restore version');
  assert.strictEqual(ctx._dirty.singles.has(rebased.id), true, 'the later edit remains dirty after restore acknowledgement');
  assert.strictEqual(localStorage.getItem('_kjrMutationGroupsV2'), '[]');

  await ctx._flushDirtyToSupabase();
  const ordinaryUpsert = syncOperations(fetchMock).find(op =>
    op.type === 'upsert' && op.table === 'singles' && op.id === 'restore_cache_race');
  assert.ok(ordinaryUpsert);
  assert.strictEqual(ordinaryUpsert.expected_version, 1);
  assert.strictEqual(ordinaryUpsert.data.name, 'Newer local restore edit');
  const cached = JSON.parse(localStorage.getItem('pokeinventory_v3')).singles.find(row => row.id === 'restore_cache_race');
  assert.strictEqual(cached.name, 'Newer local restore edit');
  assert.strictEqual(ctx._dirty.singles.has(rebased.id), false);
});

test('trash-lifecycle: a new explicit restore token supersedes an older confirmed-delete marker across devices', async () => {
  const restored = { id: 'cross_device_restore', name: 'Restored elsewhere', status: 'Available', _restoreToken: 'restore_new' };
  const { grab, localStorage } = await loadApp({
    seed: { singles: [restored] },
    localStorage: {
      _kjrConfirmedCloudDeletes: JSON.stringify([{ table: 'singles', id: restored.id, ts: Date.now(), restoreToken: 'restore_old' }]),
    },
  });
  assert.strictEqual(grab('DB').DB.singles.some(row => row.id === restored.id), true);
  const marker = JSON.parse(localStorage.getItem('_kjrConfirmedCloudDeletes'))[0];
  assert.strictEqual(marker.state, 'restored');
  assert.strictEqual(marker.restoreToken, 'restore_new',
    'the fresh token replaces the delete tombstone with a restore marker that still blocks older stale copies');
});

test('trash-lifecycle: a confirmed delete still blocks a stale row carrying the deleted restore token', async () => {
  const stale = { id: 'stale_restore_token', name: 'Stale copy', status: 'Available', _restoreToken: 'restore_deleted' };
  const { grab } = await loadApp({
    seed: { singles: [stale] },
    localStorage: {
      _kjrConfirmedCloudDeletes: JSON.stringify([{
        table: 'singles', id: stale.id, ts: Date.now(), restoreToken: 'restore_deleted', state: 'deleted',
      }]),
    },
  });
  assert.strictEqual(grab('DB').DB.singles.some(row => row.id === stale.id), false);
});

test('trash-lifecycle: corrupt pending-delete state warns but does not hide every ordinary row', async () => {
  const { grab, consoleWarnings } = await loadApp({
    localStorage: { _kjrPendingCloudDeletes: '{broken-json' },
  });
  assert.strictEqual(grab('DB').DB.singles.some(row => row.id === 'single_seed_1'), true);
  assert.ok(consoleWarnings.some(line => line.includes('pending delete state is unreadable')));
});

test('trash-lifecycle: corrupt confirmed-delete state warns but does not hide every ordinary row', async () => {
  const { grab, consoleWarnings } = await loadApp({
    localStorage: { _kjrConfirmedCloudDeletes: '{broken-json' },
  });
  assert.strictEqual(grab('DB').DB.singles.some(row => row.id === 'single_seed_1'), true);
  assert.ok(consoleWarnings.some(line => line.includes('confirmed delete state is unreadable')));
});

test('trash-lifecycle: legacy pending and confirmed arrays migrate into one authoritative v2 record', async () => {
  const pending = [{ table: 'slabs', id: 'legacy_pending_1', ts: 101, restoreToken: '' }];
  const confirmed = [{ table: 'singles', id: 'legacy_confirmed_1', ts: 202, restoreToken: '', state: 'deleted' }];
  const { localStorage } = await loadApp({
    localStorage: {
      _kjrPendingCloudDeletes: JSON.stringify(pending),
      _kjrConfirmedCloudDeletes: JSON.stringify(confirmed),
    },
  });
  const migrated = getDeleteStateV2(localStorage);
  assert.strictEqual(migrated.schema, 2);
  assert.deepStrictEqual(plain(migrated.pending), pending);
  assert.deepStrictEqual(plain(migrated.confirmed), confirmed);
  assert.match(migrated.revision, /^delete_state_/);
});

test('trash-lifecycle: corrupt authoritative v2 never falls back to a partial legacy marker or hides inventory', async () => {
  const legacyWouldHide = [{ table: 'singles', id: 'single_seed_1', ts: 303, restoreToken: '' }];
  const { ctx, grab, localStorage, fetchMock, consoleWarnings } = await loadApp({
    localStorage: {
      _kjrDeleteStateV2: '{broken-json',
      _kjrPendingCloudDeletes: JSON.stringify(legacyWouldHide),
      _kjrConfirmedCloudDeletes: '[]',
    },
  });
  assert.ok(grab('DB').DB.singles.some(row => row.id === 'single_seed_1'));
  assert.strictEqual(ctx._deleteBlocksRow('singles', grab('DB').DB.singles[0]), false);
  fetchMock.calls.length = 0;
  assert.strictEqual(await ctx.sbDelete('singles', 'single_seed_1'), false,
    'mutations stop when authoritative state is corrupt');
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.strictEqual(localStorage.getItem('_kjrDeleteStateV2'), '{broken-json');
  assert.ok(consoleWarnings.some(line => line.includes('Delete recovery state is unreadable')));
});

test('trash-lifecycle: a v2 storage event applies another tab pending delete immediately', async () => {
  const { ctx, grab, localStorage } = await loadApp();
  const pending = [{ table: 'singles', id: 'single_seed_1', ts: 404, restoreToken: '' }];
  const raw = deleteStateV2(pending, [], 'other-tab-revision');
  localStorage.setItem('_kjrDeleteStateV2', raw);
  ctx.dispatchEvent({ type: 'storage', key: '_kjrDeleteStateV2', newValue: raw });
  assert.strictEqual(grab('DB').DB.singles.some(row => row.id === 'single_seed_1'), false,
    'the authoritative cross-tab state filters the in-memory row without consulting legacy mirrors');
});

test('trash-lifecycle: one failed v2 set leaves the exact prior combined state and never touches legacy mirrors', async () => {
  const { ctx, localStorage } = await loadApp();
  const before = localStorage.getItem('_kjrDeleteStateV2');
  const legacyBefore = {
    pending: localStorage.getItem('_kjrPendingCloudDeletes'),
    confirmed: localStorage.getItem('_kjrConfirmedCloudDeletes'),
  };
  const realSetItem = localStorage.setItem.bind(localStorage);
  let legacyWrites = 0;
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('authoritative set failed');
    if (key === '_kjrPendingCloudDeletes' || key === '_kjrConfirmedCloudDeletes') legacyWrites += 1;
    return realSetItem(key, value);
  };
  assert.strictEqual(await ctx._preflightPendingDeletes([{ table: 'singles', id: 'atomic_fail_1', restoreToken: '' }]), false);
  assert.strictEqual(localStorage.getItem('_kjrDeleteStateV2'), before);
  assert.strictEqual(localStorage.getItem('_kjrPendingCloudDeletes'), legacyBefore.pending);
  assert.strictEqual(localStorage.getItem('_kjrConfirmedCloudDeletes'), legacyBefore.confirmed);
  assert.strictEqual(legacyWrites, 0,
    'legacy mirrors run only after the authoritative transaction commits');
});

test('trash-lifecycle: pending legacy mirror failure cannot invalidate an authoritative preflight', async () => {
  const { ctx, localStorage } = await loadApp();
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrPendingCloudDeletes') throw new Error('pending mirror unavailable');
    return realSetItem(key, value);
  };
  assert.strictEqual(await ctx._preflightPendingDeletes([{ table: 'slabs', id: 'mirror_pending_1', restoreToken: '' }]), true);
  assert.ok(getDeleteStateV2(localStorage).pending.some(item => item.table === 'slabs' && item.id === 'mirror_pending_1'));
});

test('trash-lifecycle: undoing a delete writes a fresh restore token before the row becomes dirty', async () => {
  const { ctx, grab, localStorage } = await loadApp();
  const original = grab('DB').DB.singles[0];
  ctx.snapshotForUndo();
  grab('DB').DB.singles = [];
  setDeleteStateV2(localStorage, [], [{
    table: 'singles', id: original.id, ts: Date.now(), restoreToken: original._restoreToken || '', state: 'deleted',
  }]);
  ctx.saveData();

  await ctx.undoLast();
  const restored = grab('DB').DB.singles.find(row => row.id === original.id);
  assert.ok(restored);
  assert.match(restored._restoreToken, /^restore_/);
  const marker = getDeleteStateV2(localStorage).confirmed[0];
  assert.strictEqual(marker.state, 'restored');
  assert.strictEqual(marker.restoreToken, restored._restoreToken);
});

test('trash-lifecycle: version restore of a deleted id writes a fresh restore token', async () => {
  const deleted = { id: 'version_deleted_1', name: 'Version recovery', status: 'Available' };
  const snapshot = { singles: [deleted], slabs: [], sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [] };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: [] } });
  grab('DB').DB.singles = [];
  localStorage.setItem('pokeinv_versions', JSON.stringify([{
    id: 'version_restore_test', name: 'Before delete', ts: Date.now(), data: JSON.stringify(snapshot),
  }]));
  setDeleteStateV2(localStorage, [], [{
    table: 'singles', id: deleted.id, ts: Date.now(), restoreToken: '', state: 'deleted',
  }]);
  ctx.kjrConfirm = async () => true;
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', () => jsonResponse({ ok: false, code: 'offline_for_backup' }, 503));

  await ctx.restoreVersion('version_restore_test');
  const restored = grab('DB').DB.singles.find(row => row.id === deleted.id);
  assert.ok(restored);
  assert.match(restored._restoreToken, /^restore_/);
  const marker = getDeleteStateV2(localStorage).confirmed[0];
  assert.strictEqual(marker.state, 'restored');
  assert.strictEqual(marker.restoreToken, restored._restoreToken);
});

test('trash-lifecycle: same-id version restore replaces a mismatched allowed restore token', async () => {
  const id = 'version_same_id_1';
  const current = { id, name: 'Current row', status: 'Available', _restoreToken: 'restore_current' };
  const older = { id, name: 'Older snapshot', status: 'Available', _restoreToken: 'restore_snapshot_old' };
  const snapshot = { singles: [older], slabs: [], sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [] };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { singles: [current] },
    localStorage: {
      _kjrConfirmedCloudDeletes: JSON.stringify([{
        table: 'singles', id, ts: Date.now(), restoreToken: current._restoreToken, state: 'restored',
      }]),
    },
  });
  localStorage.setItem('pokeinv_versions', JSON.stringify([{
    id: 'version_same_id_test', name: 'Older same-id snapshot', ts: Date.now(), data: JSON.stringify(snapshot),
  }]));
  ctx.kjrConfirm = async () => true;
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', () => jsonResponse({ ok: false, code: 'offline_for_backup' }, 503));

  await ctx.restoreVersion('version_same_id_test');
  const restored = grab('DB').DB.singles.find(row => row.id === id);
  assert.ok(restored);
  assert.strictEqual(restored.name, 'Older snapshot');
  assert.match(restored._restoreToken, /^restore_/);
  assert.notStrictEqual(restored._restoreToken, current._restoreToken);
  assert.notStrictEqual(restored._restoreToken, older._restoreToken);
  const marker = JSON.parse(localStorage.getItem('_kjrConfirmedCloudDeletes'))[0];
  assert.strictEqual(marker.state, 'restored');
  assert.strictEqual(marker.restoreToken, restored._restoreToken,
    'the marker follows the deliberate same-id recovery before it can be marked dirty or synced');
});

test('trash-lifecycle: Replace preflight saves the Trash snapshot before its delete marker and retry does not duplicate either', async () => {
  const oldRow = { id: 'replace_preflight_order', name: 'Recoverable old row', costPrice: 432, status: 'Available' };
  const { ctx, grab, localStorage } = await loadApp({ seed: { singles: [oldRow] } });
  const writes = [];
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrPendingTrashWrites' || key === '_kjrDeleteStateV2') writes.push(key);
    return realSetItem(key, value);
  };
  const nextState = { singles: [{ id: 'replace_preflight_new', name: 'Incoming row', status: 'Available' }] };
  const targets = [{ table: 'singles', id: oldRow.id, restoreToken: '' }];

  assert.strictEqual(await ctx._prepareReplacementSafety(nextState, targets), true);
  assert.ok(writes.indexOf('_kjrPendingTrashWrites') >= 0);
  assert.ok(writes.indexOf('_kjrPendingTrashWrites') < writes.indexOf('_kjrDeleteStateV2'),
    'the recoverable snapshot is durably written before the destructive marker');
  const firstTrash = JSON.parse(localStorage.getItem('_kjrPendingTrashWrites'));
  assert.strictEqual(firstTrash.length, 1);
  assert.deepStrictEqual(plain(firstTrash[0].data.item), oldRow);
  assert.strictEqual(getDeleteStateV2(localStorage).pending.filter(item => item.id === oldRow.id).length, 1);

  assert.strictEqual(await ctx._prepareReplacementSafety(nextState, targets), true);
  const retriedTrash = JSON.parse(localStorage.getItem('_kjrPendingTrashWrites'));
  assert.strictEqual(retriedTrash.length, 1, 'retry reuses the verified Trash snapshot');
  assert.strictEqual(retriedTrash[0].id, firstTrash[0].id);
  assert.strictEqual(getDeleteStateV2(localStorage).pending.filter(item => item.id === oldRow.id).length, 1,
    'retry does not duplicate the pending delete marker');
  assert.strictEqual(grab('DB').DB.singles[0].id, oldRow.id, 'preflight itself does not mutate inventory');
});

test('trash-lifecycle: Replace aborts byte-for-byte when its first Trash snapshot cannot persist', async () => {
  const oldRow = { id: 'replace_snapshot_fail', name: 'Keep snapshot source', costPrice: 654, status: 'Available' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: [oldRow] } });
  ctx.kjrConfirm = async () => true;
  ctx.document.getElementById('import-data').value = 'Name\tCost\nMust not import\t12';
  ctx.document.getElementById('import-type').value = 'singles';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const beforeTrash = localStorage.getItem('_kjrPendingTrashWrites');
  const beforeDeleteState = localStorage.getItem('_kjrDeleteStateV2');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrPendingTrashWrites') throw new Error('first Trash snapshot unavailable');
    return realSetItem(key, value);
  };

  await ctx.importData();
  assert.deepStrictEqual(plain(grab('DB').DB.singles), [oldRow]);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(localStorage.getItem('_kjrPendingTrashWrites'), beforeTrash);
  assert.strictEqual(localStorage.getItem('_kjrDeleteStateV2'), beforeDeleteState);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
});

test('trash-lifecycle: Replace import upserts reused ids without DELETE and deletes old-only ids', async () => {
  const existingId = 'replace_reused_1';
  const oldOnlyId = 'replace_old_only_1';
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { singles: [
      { id: existingId, name: 'Old import row', status: 'Available' },
      { id: oldOnlyId, name: 'Remove me', status: 'Available' },
    ] },
  });
  setDeleteStateV2(localStorage, [], [{
    table: 'singles', id: existingId, ts: Date.now(), restoreToken: '', state: 'deleted',
  }]);
  ctx.kjrConfirm = async () => true;
  const realGenId = ctx.genId;
  ctx.genId = prefix => prefix === 's' ? existingId : realGenId(prefix);
  ctx.document.getElementById('import-data').value = 'Name\tCost\nReplacement row\t12';
  ctx.document.getElementById('import-type').value = 'singles';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));

  await ctx.importData();
  const replacement = grab('DB').DB.singles.find(row => row.id === existingId);
  assert.ok(replacement);
  assert.strictEqual(replacement.name, 'Replacement row');
  assert.match(replacement._restoreToken, /^restore_/);
  const marker = getDeleteStateV2(localStorage).confirmed[0];
  assert.strictEqual(marker.state, 'restored');
  assert.strictEqual(marker.restoreToken, replacement._restoreToken);
  const operations = syncOperations(fetchMock);
  assert.ok(operations.some(op => op.type === 'upsert' && op.table === 'singles' && op.id === existingId),
    'saveAll dispatches the deliberate replacement instead of blocking it as stale');
  const deletes = operations.filter(op => op.type === 'delete' && op.table === 'singles');
  assert.strictEqual(deletes.length, 1);
  assert.strictEqual(deletes[0].id, oldOnlyId);
  assert.ok(deletes[0].trash && deletes[0].trash.id);
  assert.strictEqual(deletes[0].trash.data.originalId, oldOnlyId);
  assert.strictEqual(deletes[0].trash.data.item.name, 'Remove me',
    'the CAS delete carries the exact recoverable old-only snapshot');
  assert.ok(!deletes.some(op => op.id === existingId), 'the reused primary key is replaced by upsert, never deleted first');
});

test('trash-lifecycle: Replace import gives a fresh restore token to a deleted id absent from current memory', async () => {
  const deletedId = 'replace_deleted_absent';
  const oldOnlyId = 'replace_old_only_for_absent';
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { singles: [{ id: oldOnlyId, name: 'Old current row', status: 'Available' }] },
    localStorage: {
      _kjrConfirmedCloudDeletes: JSON.stringify([{
        table: 'singles', id: deletedId, ts: Date.now(), restoreToken: '', state: 'deleted',
      }]),
    },
  });
  ctx.kjrConfirm = async () => true;
  const realGenId = ctx.genId;
  ctx.genId = prefix => prefix === 's' ? deletedId : realGenId(prefix);
  ctx.document.getElementById('import-data').value = 'Name\tCost\nRecovered by Replace\t12';
  ctx.document.getElementById('import-type').value = 'singles';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));

  await ctx.importData();
  const replacement = grab('DB').DB.singles.find(row => row.id === deletedId);
  assert.ok(replacement);
  assert.match(replacement._restoreToken, /^restore_/);
  const marker = JSON.parse(localStorage.getItem('_kjrConfirmedCloudDeletes')).find(item => item.id === deletedId);
  assert.strictEqual(marker.state, 'restored');
  assert.strictEqual(marker.restoreToken, replacement._restoreToken,
    'marker preflight covers incoming IDs even when no current row reuses the ID');
  const deletes = syncOperations(fetchMock).filter(op => op.type === 'delete' && op.table === 'singles');
  assert.strictEqual(deletes.length, 1);
  assert.strictEqual(deletes[0].id, oldOnlyId);
  assert.strictEqual(deletes[0].trash.data.originalId, oldOnlyId);
  assert.strictEqual(deletes[0].trash.data.item.name, 'Old current row');
  assert.ok(!deletes.some(op => op.id === deletedId));
});

test('trash-lifecycle: main Replace aborts before cloud or local deletion when restore-marker preflight cannot persist', async () => {
  const id = 'replace_main_preflight_fail';
  const oldRow = { id, name: 'Keep original main row', status: 'Available', _restoreToken: 'restore_current_main' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { singles: [oldRow] },
    localStorage: {
      _kjrConfirmedCloudDeletes: JSON.stringify([{
        table: 'singles', id, ts: Date.now(), restoreToken: oldRow._restoreToken, state: 'restored',
      }]),
    },
  });
  ctx.kjrConfirm = async () => true;
  const realGenId = ctx.genId;
  ctx.genId = prefix => prefix === 's' ? id : realGenId(prefix);
  ctx.document.getElementById('import-data').value = 'Name\tCost\nReplacement main row\t12';
  ctx.document.getElementById('import-type').value = 'singles';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const beforeTrash = localStorage.getItem('_kjrPendingTrashWrites');
  const beforeDeleteState = localStorage.getItem('_kjrDeleteStateV2');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('confirmed marker storage unavailable');
    return realSetItem(key, value);
  };

  await ctx.importData();
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.strictEqual(grab('DB').DB.singles[0].name, oldRow.name);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache,
    'the persisted inventory is untouched when preflight fails');
  assert.strictEqual(localStorage.getItem('_kjrPendingTrashWrites'), beforeTrash);
  assert.strictEqual(localStorage.getItem('_kjrDeleteStateV2'), beforeDeleteState);
});

test('trash-lifecycle: features Replace aborts before cloud or local deletion when restore-marker preflight cannot persist', async () => {
  const id = 'replace_features_preflight_fail';
  const oldRow = {
    id, product: 'Keep original ETB', status: 'In Stock', totalPrice: 100,
    _restoreToken: 'restore_current_features',
  };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { etbs: [oldRow] },
    localStorage: {
      _kjrConfirmedCloudDeletes: JSON.stringify([{
        table: 'etbs', id, ts: Date.now(), restoreToken: oldRow._restoreToken, state: 'restored',
      }]),
    },
  });
  ctx.kjrConfirm = async () => true;
  const realGenId = ctx.genId;
  ctx.genId = prefix => prefix === 'etb' ? id : realGenId(prefix);
  ctx.document.getElementById('import-data').value = 'Product\tTotal Price\nReplacement ETB\t120';
  ctx.document.getElementById('import-type').value = 'etbs';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const beforeTrash = localStorage.getItem('_kjrPendingTrashWrites');
  const beforeDeleteState = localStorage.getItem('_kjrDeleteStateV2');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('confirmed marker storage unavailable');
    return realSetItem(key, value);
  };

  await ctx.importData();
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.strictEqual(grab('DB').DB.etbs[0].product, oldRow.product);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(localStorage.getItem('_kjrPendingTrashWrites'), beforeTrash);
  assert.strictEqual(localStorage.getItem('_kjrDeleteStateV2'), beforeDeleteState);
});

test('trash-lifecycle: main Replace A to B aborts before every write when old-only delete preflight cannot persist', async () => {
  const oldRow = { id: 'replace_main_old_a', name: 'Keep main A', costPrice: 777, status: 'Available' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: [oldRow] } });
  const messages = [];
  ctx.kjrConfirm = async () => true;
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  ctx.document.getElementById('import-data').value = 'Name\tCost\nNew main B\t12';
  ctx.document.getElementById('import-type').value = 'singles';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const beforeTrash = localStorage.getItem('_kjrPendingTrashWrites');
  const beforeDeleteState = localStorage.getItem('_kjrDeleteStateV2');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.importData();
  assert.deepStrictEqual(plain(grab('DB').DB.singles), [oldRow]);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(localStorage.getItem('_kjrPendingTrashWrites'), beforeTrash,
    'the Trash snapshot is rolled back when the following marker write fails');
  assert.strictEqual(localStorage.getItem('_kjrDeleteStateV2'), beforeDeleteState);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.strictEqual(syncOperations(fetchMock).some(op => op.type === 'upsert' && op.table === 'singles'), false,
    'the incoming B row is not uploaded after destructive preflight fails');
  assert.ok(messages.some(message => message.includes('restore and delete recovery state')));
  assert.ok(!messages.some(message => message.includes('Imported')));
});

test('trash-lifecycle: features Replace A to B aborts before every write when old-only delete preflight cannot persist', async () => {
  const oldRow = { id: 'replace_features_old_a', product: 'Keep ETB A', totalPrice: 888, status: 'In Stock' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { etbs: [oldRow] } });
  const messages = [];
  ctx.kjrConfirm = async () => true;
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  ctx.document.getElementById('import-data').value = 'Product\tTotal Price\nNew ETB B\t120';
  ctx.document.getElementById('import-type').value = 'etbs';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const beforeTrash = localStorage.getItem('_kjrPendingTrashWrites');
  const beforeDeleteState = localStorage.getItem('_kjrDeleteStateV2');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.importData();
  assert.deepStrictEqual(plain(grab('DB').DB.etbs), [oldRow]);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(localStorage.getItem('_kjrPendingTrashWrites'), beforeTrash);
  assert.strictEqual(localStorage.getItem('_kjrDeleteStateV2'), beforeDeleteState);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.strictEqual(syncOperations(fetchMock).some(op => op.type === 'upsert' && op.table === 'etbs'), false,
    'the incoming ETB B row is not uploaded after destructive preflight fails');
  assert.ok(messages.some(message => message.includes('restore and delete recovery state')));
  assert.ok(!messages.some(message => message.includes('Imported')));
});

test('trash-lifecycle: main mixed Replace rolls back reused restore state when old-only pending write fails', async () => {
  const reused = { id: 'mixed_main_reused', name: 'Keep reused main', status: 'Available', _restoreToken: 'restore_main_current' };
  const oldOnly = { id: 'mixed_main_old_only', name: 'Keep old-only main', status: 'Available' };
  const confirmedRaw = JSON.stringify([{
    table: 'singles', id: reused.id, ts: 123, restoreToken: reused._restoreToken, state: 'restored',
  }]);
  const pendingRaw = JSON.stringify([{ table: 'slabs', id: 'foreign_pending', ts: 456, restoreToken: '' }]);
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { singles: [reused, oldOnly] },
    localStorage: {
      _kjrConfirmedCloudDeletes: confirmedRaw,
      _kjrPendingCloudDeletes: pendingRaw,
    },
  });
  const messages = [];
  ctx.kjrConfirm = async () => true;
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  const realGenId = ctx.genId;
  ctx.genId = prefix => prefix === 's' ? reused.id : realGenId(prefix);
  ctx.document.getElementById('import-data').value = 'Name\tCost\nIncoming reused main\t12';
  ctx.document.getElementById('import-type').value = 'singles';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const beforeDeleteState = localStorage.getItem('_kjrDeleteStateV2');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('pending write unavailable');
    return realSetItem(key, value);
  };

  await ctx.importData();
  assert.deepStrictEqual(plain(grab('DB').DB.singles), [reused, oldOnly]);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(localStorage.getItem('_kjrConfirmedCloudDeletes'), confirmedRaw);
  assert.strictEqual(localStorage.getItem('_kjrPendingCloudDeletes'), pendingRaw);
  assert.strictEqual(localStorage.getItem('_kjrDeleteStateV2'), beforeDeleteState,
    'one failed authoritative write leaves the exact prior combined state intact');
  assert.strictEqual(ctx._deleteBlocksRow('singles', grab('DB').DB.singles[0]), false);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.ok(!messages.some(message => message.includes('Imported')));

  const reloaded = await loadApp({ localStorage: copyStorage(localStorage) });
  assert.ok(reloaded.grab('DB').DB.singles.some(row => row.id === reused.id));
  assert.ok(reloaded.grab('DB').DB.singles.some(row => row.id === oldOnly.id));
});

test('trash-lifecycle: features mixed Replace rolls back reused restore state when old-only pending write fails', async () => {
  const reused = { id: 'mixed_features_reused', product: 'Keep reused ETB', status: 'In Stock', _restoreToken: 'restore_features_current' };
  const oldOnly = { id: 'mixed_features_old_only', product: 'Keep old-only ETB', status: 'In Stock' };
  const confirmedRaw = JSON.stringify([{
    table: 'etbs', id: reused.id, ts: 123, restoreToken: reused._restoreToken, state: 'restored',
  }]);
  const pendingRaw = JSON.stringify([{ table: 'singles', id: 'foreign_pending_feature', ts: 456, restoreToken: '' }]);
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { etbs: [reused, oldOnly] },
    localStorage: {
      _kjrConfirmedCloudDeletes: confirmedRaw,
      _kjrPendingCloudDeletes: pendingRaw,
    },
  });
  const messages = [];
  ctx.kjrConfirm = async () => true;
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  const realGenId = ctx.genId;
  ctx.genId = prefix => prefix === 'etb' ? reused.id : realGenId(prefix);
  ctx.document.getElementById('import-data').value = 'Product\tTotal Price\nIncoming reused ETB\t120';
  ctx.document.getElementById('import-type').value = 'etbs';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const beforeDeleteState = localStorage.getItem('_kjrDeleteStateV2');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('pending write unavailable');
    return realSetItem(key, value);
  };

  await ctx.importData();
  assert.deepStrictEqual(plain(grab('DB').DB.etbs), [reused, oldOnly]);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(localStorage.getItem('_kjrConfirmedCloudDeletes'), confirmedRaw);
  assert.strictEqual(localStorage.getItem('_kjrPendingCloudDeletes'), pendingRaw);
  assert.strictEqual(localStorage.getItem('_kjrDeleteStateV2'), beforeDeleteState,
    'the features importer cannot leave half of a Replace safety transaction active');
  assert.strictEqual(ctx._deleteBlocksRow('etbs', grab('DB').DB.etbs[0]), false);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.ok(!messages.some(message => message.includes('Imported')));

  const reloaded = await loadApp({ localStorage: copyStorage(localStorage) });
  assert.ok(reloaded.grab('DB').DB.etbs.some(row => row.id === reused.id));
  assert.ok(reloaded.grab('DB').DB.etbs.some(row => row.id === oldOnly.id));
});

test('trash-lifecycle: confirmed legacy mirror failure cannot invalidate a committed Replace transaction', async () => {
  const reused = { id: 'mixed_inverse_reused', name: 'Keep inverse reused', status: 'Available', _restoreToken: 'restore_inverse_current' };
  const oldOnly = { id: 'mixed_inverse_old_only', name: 'Keep inverse old-only', status: 'Available' };
  const confirmedRaw = JSON.stringify([{
    table: 'singles', id: reused.id, ts: 123, restoreToken: reused._restoreToken, state: 'restored',
  }]);
  const pendingRaw = JSON.stringify([{ table: 'sales', id: 'foreign_inverse', ts: 456, restoreToken: '' }]);
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { singles: [reused, oldOnly] },
    localStorage: {
      _kjrConfirmedCloudDeletes: confirmedRaw,
      _kjrPendingCloudDeletes: pendingRaw,
    },
  });
  ctx.kjrConfirm = async () => true;
  const realGenId = ctx.genId;
  ctx.genId = prefix => prefix === 's' ? reused.id : realGenId(prefix);
  ctx.document.getElementById('import-data').value = 'Name\tCost\nIncoming inverse\t12';
  ctx.document.getElementById('import-type').value = 'singles';
  ctx.document.getElementById('import-mode').value = 'replace';
  fetchMock.calls.length = 0;
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrConfirmedCloudDeletes') throw new Error('confirmed write unavailable');
    return realSetItem(key, value);
  };
  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));

  await ctx.importData();
  assert.strictEqual(grab('DB').DB.singles.length, 1);
  assert.strictEqual(grab('DB').DB.singles[0].name, 'Incoming inverse');
  const authoritative = getDeleteStateV2(localStorage);
  assert.ok(authoritative.pending.every(item => item.id !== oldOnly.id));
  const marker = authoritative.confirmed.find(item => item.id === reused.id);
  assert.strictEqual(marker.state, 'restored');
  assert.strictEqual(marker.restoreToken, grab('DB').DB.singles[0]._restoreToken);
  assert.strictEqual(localStorage.getItem('_kjrConfirmedCloudDeletes'), confirmedRaw);
  assert.strictEqual(ctx._deleteBlocksRow('singles', grab('DB').DB.singles[0]), false,
    'the stale confirmed mirror cannot override authoritative v2 state');
  assert.ok(syncOperations(fetchMock).some(op => op.type === 'delete' && op.table === 'singles' && op.id === oldOnly.id));
});

test('trash-lifecycle: single delete keeps its source when cloud Trash and durable queue both fail', async () => {
  const row = { id: 'trash_copy_single_fail', name: 'Keep this money row', costPrice: 777, status: 'Available' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: [row] } });
  const errors = [];
  ctx.kjrConfirm = async () => true;
  ctx.toastError = message => errors.push(message);
  fetchMock.calls.length = 0;
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrPendingTrashWrites') throw new Error('trash queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.deleteItem(row.id, 'singles');
  assert.ok(grab('DB').DB.singles.some(item => item.id === row.id));
  assert.strictEqual(syncCalls(fetchMock).length, 0,
    'source DELETE never starts without a recoverable Trash snapshot');
  assert.strictEqual(localStorage.getItem('_kjrPendingCloudDeletes'), null);
  assert.strictEqual(localStorage.getItem('_kjrConfirmedCloudDeletes'), null);
  assert.ok(errors.some(message => message.includes('no recoverable Trash copy')));
});

test('trash-lifecycle: batch delete keeps every source when cloud Trash and durable queue both fail', async () => {
  const rows = [
    { id: 'trash_copy_batch_a', name: 'Batch A', costPrice: 100, status: 'Available' },
    { id: 'trash_copy_batch_b', name: 'Batch B', costPrice: 200, status: 'Available' },
  ];
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: rows } });
  const errors = [];
  ctx.kjrConfirm = async () => true;
  ctx.toastError = message => errors.push(message);
  const selected = grab('selectedIds').selectedIds.singles;
  rows.forEach(row => selected.add(row.id));
  fetchMock.calls.length = 0;
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrPendingTrashWrites') throw new Error('trash queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.deleteSelected('singles');
  assert.deepStrictEqual(plain(grab('DB').DB.singles.map(row => row.id).sort()), rows.map(row => row.id).sort());
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.strictEqual(localStorage.getItem('_kjrPendingCloudDeletes'), null);
  assert.ok(errors.some(message => message.includes('no recoverable Trash copies')));
});

test('trash-lifecycle: durably queued Trash cannot remove a single source without delete preflight', async () => {
  const row = { id: 'source_preflight_single', name: 'Keep single source', costPrice: 901, status: 'Available' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: [row] } });
  const messages = [];
  ctx.kjrConfirm = async () => true;
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.deleteItem(row.id, 'singles');
  assert.deepStrictEqual(plain(grab('DB').DB.singles), [row]);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(JSON.parse(localStorage.getItem('_kjrPendingTrashWrites') || '[]').length, 1,
    'the Trash snapshot is durable even though the delete preflight stopped the mutation');
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.strictEqual(localStorage.getItem('_kjrConfirmedCloudDeletes'), null);
  assert.ok(messages.some(message => message.includes('cloud rows could not be queued safely')));
  assert.ok(!messages.some(message => message.includes('Moved to trash')));
});

test('trash-lifecycle: durably queued Trash cannot remove batch sources without delete preflight', async () => {
  const rows = [
    { id: 'source_preflight_batch_a', name: 'Keep batch A', costPrice: 902, status: 'Available' },
    { id: 'source_preflight_batch_b', name: 'Keep batch B', costPrice: 903, status: 'Available' },
  ];
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: rows } });
  const messages = [];
  ctx.kjrConfirm = async () => true;
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  rows.forEach(row => grab('selectedIds').selectedIds.singles.add(row.id));
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.deleteSelected('singles');
  assert.deepStrictEqual(plain(grab('DB').DB.singles), rows);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(JSON.parse(localStorage.getItem('_kjrPendingTrashWrites') || '[]').length, 2);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.ok(messages.some(message => message.includes('cloud rows could not be queued safely')));
  assert.ok(!messages.some(message => message.includes('moved to trash')));
});

test('trash-lifecycle: features delete keeps its source after Trash queues but delete preflight fails', async () => {
  const row = { id: 'source_preflight_etb', product: 'Keep feature source', totalPrice: 904, status: 'In Stock' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { etbs: [row] } });
  const messages = [];
  ctx.kjrConfirm = async () => true;
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.kjrDeleteRow('etbs', row.id);
  assert.deepStrictEqual(plain(grab('DB').DB.etbs), [row]);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
  assert.ok(messages.some(message => message.includes('cloud row could not be queued safely')));
  assert.ok(!messages.some(message => message.includes('Moved to trash')));
});

test('trash-lifecycle: durable local Trash queue still cannot remove a source when delete preflight fails', async () => {
  const row = { id: 'source_preflight_after_trash_queue', name: 'Keep queued-trash source', costPrice: 905, status: 'Available' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: [row] } });
  ctx.kjrConfirm = async () => true;
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.deleteItem(row.id, 'singles');
  assert.deepStrictEqual(plain(grab('DB').DB.singles), [row]);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  const trashQueue = JSON.parse(localStorage.getItem('_kjrPendingTrashWrites') || '[]');
  assert.strictEqual(trashQueue.length, 1);
  assert.strictEqual(trashQueue[0].data.item.costPrice, 905);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
});

test('trash-lifecycle: linked-sale removal aborts before status or source mutation when delete preflight fails', async () => {
  const item = { id: 'linked_preflight_item', name: 'Sold item', status: 'Sold' };
  const sale = { id: 'linked_preflight_sale', product: 'Sold item', inventoryId: item.id, inventoryTable: 'singles' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: [item], sales: [sale] } });
  ctx.kjrConfirm = async () => true;
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.markStatus('singles', item.id, 'Available');
  assert.strictEqual(grab('DB').DB.singles[0].status, 'Sold');
  assert.strictEqual(grab('DB').DB.sales.length, 1);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
});

test('trash-lifecycle: box-to-pack migration aborts before local move when delete preflight fails', async () => {
  const row = { id: 'box_migration_preflight', product: 'Test BP', totalPrice: 906, status: 'Unopened Stock' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { boosterBoxes: [row], boosterPacks: [] } });
  ctx.kjrConfirm = async () => true;
  fetchMock.calls.length = 0;
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };

  await ctx.kjrMigrateBoxesToPacks();
  assert.deepStrictEqual(plain(grab('DB').DB.boosterBoxes), [row]);
  assert.deepStrictEqual(plain(grab('DB').DB.boosterPacks), []);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.strictEqual(syncCalls(fetchMock).length, 0);
});

test('trash-lifecycle: durably queued Trash copy permits delete and reload retries the snapshot', async () => {
  const row = { id: 'trash_copy_retry', name: 'Retry-safe row', costPrice: 333, status: 'Available' };
  const first = await loadApp({ seed: { singles: [row] } });
  first.ctx.kjrConfirm = async () => true;
  first.fetchMock.calls.length = 0;
  first.fetchMock.route('/sync/v2/mutate', () => jsonResponse({ ok: false, code: 'offline' }, 503));
  await first.ctx.deleteItem(row.id, 'singles');
  assert.strictEqual(first.grab('DB').DB.singles.some(item => item.id === row.id), false);
  assert.strictEqual(JSON.parse(first.localStorage.getItem('_kjrPendingTrashWrites')).length, 1);

  const reloaded = await loadApp({
    localStorage: copyStorage(first.localStorage),
    fetch: async (url, opts) => {
      if (String(url).includes('/sync/v2/mutate')) return syncSuccessResponse(opts);
      if (String(url).includes('/sync/v2/pull')) return syncPullResponse();
      return jsonResponse({ rates: { SGD: 1.3 } });
    },
  });
  assert.deepStrictEqual(JSON.parse(reloaded.localStorage.getItem('_kjrPendingTrashWrites')), []);
  assert.strictEqual(reloaded.grab('DB').DB.singles.some(item => item.id === row.id), false);
});

test('trash-lifecycle: rapid double Undo serialises stack reads and uploads the final sequential state', async () => {
  const { ctx, grab, fetchMock, settle } = await loadApp({
    seed: { singles: [{ id: 'undo_mutex_row', name: 'Mutex row', costPrice: 0, status: 'Available' }] },
  });
  ctx.snapshotForUndo();
  grab('DB').DB.singles[0].costPrice = 1;
  ctx.saveData();
  ctx.snapshotForUndo();
  grab('DB').DB.singles[0].costPrice = 2;
  ctx.saveData();
  const originalPreflight = ctx._prepareExplicitRowRestores;
  let releaseFirst;
  let calls = 0;
  ctx._prepareExplicitRowRestores = (...args) => {
    calls += 1;
    if (calls !== 1) return originalPreflight(...args);
    return new Promise(resolve => { releaseFirst = async () => resolve(await originalPreflight(...args)); });
  };

  const first = ctx.undoLast();
  const second = ctx.undoLast();
  await settle();
  assert.strictEqual(calls, 1, 'the second Undo cannot inspect the stack while the first preflight is pending');
  releaseFirst();
  await Promise.all([first, second]);
  assert.strictEqual(grab('DB').DB.singles[0].costPrice, 0);
  const stacks = grab('undoStack', 'redoStack');
  assert.strictEqual(stacks.undoStack.length, 0);
  assert.strictEqual(stacks.redoStack.length, 2);
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  await ctx._flushDirtyToSupabase();
  const posted = syncOperations(fetchMock).find(op => op.table === 'singles' && op.id === 'undo_mutex_row');
  assert.strictEqual(posted.id, 'undo_mutex_row');
  assert.strictEqual(posted.data.costPrice, 0);
});

test('trash-lifecycle: rapid Undo then Redo waits for preflight and delete, preserving stacks and target id', async () => {
  const row = { id: 'undo_redo_mutex_row', name: 'Undo Redo row', status: 'Available' };
  const { ctx, grab, localStorage, fetchMock, settle } = await loadApp({ seed: { singles: [row] } });
  ctx.snapshotForUndo();
  grab('DB').DB.singles = [];
  ctx.saveData();
  assert.strictEqual(ctx._queuePendingTrash({
    id: 'trash_undo_redo_mutex_row',
    data: {
      originalTable: 'singles', originalId: row.id,
      item: JSON.parse(JSON.stringify(row)), reason: 'test-delete', deletedAt: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  }), true, 'the fixture models the recoverable Trash snapshot written by a real delete');
  const originalPreflight = ctx._prepareExplicitRowRestores;
  let releasePreflight;
  ctx._prepareExplicitRowRestores = (...args) => new Promise(resolve => {
    releasePreflight = async () => resolve(await originalPreflight(...args));
    ctx._prepareExplicitRowRestores = originalPreflight;
  });
  let releaseDelete;
  let deleteStarted;
  const announced = new Promise(resolve => { deleteStarted = resolve; });
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    const operation = syncRequest(opts).operations[0];
    if (operation.type !== 'delete') return syncSuccessResponse(opts);
    deleteStarted();
    return new Promise(resolve => { releaseDelete = () => resolve(syncSuccessResponse(opts)); });
  });

  const undoing = ctx.undoLast();
  const redoing = ctx.redoLast();
  await settle();
  releasePreflight();
  await announced;
  assert.strictEqual(grab('DB').DB.singles.length, 0, 'Redo applies only after Undo has restored and queued its own state');
  releaseDelete();
  await Promise.all([undoing, redoing]);
  assert.strictEqual(grab('DB').DB.singles.length, 0);
  const stacks = grab('undoStack', 'redoStack');
  assert.strictEqual(stacks.undoStack.length, 1);
  assert.strictEqual(stacks.redoStack.length, 0);
  const deletes = syncOperations(fetchMock).filter(op => op.type === 'delete');
  assert.strictEqual(deletes.length, 1);
  assert.strictEqual(deletes[0].id, row.id);
  const reloaded = await loadApp({
    localStorage: copyStorage(localStorage),
    fetch: async url => {
      if (String(url).includes('/sync/v2/pull')) {
        const data = { ...row };
        delete data.id;
        return syncPullResponse({ singles: [{ id: row.id, data, row_version: 1, updated_at: '2026-08-29T12:00:00.000Z' }] });
      }
      return jsonResponse({ rates: { SGD: 1.3 } });
    },
  });
  assert.strictEqual(reloaded.grab('DB').DB.singles.some(item => item.id === row.id), false,
    'confirmed delete blocks a stale cloud resurrection after reload');
});

test('trash-lifecycle: Undo aborts with intact state and stacks when delete queue persistence fails', async () => {
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: [] } });
  const row = { id: 'undo_queue_fail', name: 'Keep S$777', costPrice: 777, status: 'Available' };
  const messages = [];
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  ctx.snapshotForUndo();
  grab('DB').DB.singles.push(row);
  ctx.markDirty('singles', row.id);
  ctx.saveData();
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };
  fetchMock.calls.length = 0;
  await ctx.undoLast();
  assert.strictEqual(grab('DB').DB.singles[0].costPrice, 777);
  assert.strictEqual(grab('undoStack').undoStack.length, 1);
  assert.strictEqual(grab('redoStack').redoStack.length, 0);
  assert.strictEqual(syncOperations(fetchMock).some(op => op.type === 'delete'), false);
  assert.ok(messages.some(message => message.includes('Undo stopped')));
  assert.ok(!messages.some(message => message.includes('Undone')));
  const reloaded = await loadApp({ localStorage: copyStorage(localStorage) });
  assert.strictEqual(reloaded.grab('DB').DB.singles[0].costPrice, 777);
});

test('trash-lifecycle: Redo aborts with intact state and stacks when delete queue persistence fails', async () => {
  const row = { id: 'redo_queue_fail', name: 'Keep redo row', costPrice: 888, status: 'Available' };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({ seed: { singles: [row] } });
  const messages = [];
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  const empty = { singles: [], slabs: [], sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [] };
  grab('redoStack').redoStack.push(JSON.stringify(empty));
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };
  fetchMock.calls.length = 0;
  await ctx.redoLast();
  assert.strictEqual(grab('DB').DB.singles[0].id, row.id);
  assert.strictEqual(grab('redoStack').redoStack.length, 1);
  assert.strictEqual(grab('undoStack').undoStack.length, 0);
  assert.strictEqual(syncOperations(fetchMock).some(op => op.type === 'delete'), false);
  assert.ok(messages.some(message => message.includes('Redo stopped')));
  assert.ok(!messages.some(message => message.includes('Redone')));
  const reloaded = await loadApp({ localStorage: copyStorage(localStorage) });
  assert.strictEqual(reloaded.grab('DB').DB.singles[0].id, row.id);
});

test('trash-lifecycle: version restore aborts before state replacement when delete queue persistence fails', async () => {
  const row = { id: 'version_queue_fail', name: 'Keep version row', costPrice: 999, status: 'Available' };
  const empty = { singles: [], slabs: [], sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [] };
  const version = { id: 'version_empty_target', name: 'Empty target', ts: Date.now(), data: JSON.stringify(empty) };
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { singles: [row] },
    localStorage: { pokeinv_versions: JSON.stringify([version]) },
  });
  const messages = [];
  ctx.kjrConfirm = async () => true;
  ctx.toast = message => messages.push(message);
  ctx.toastError = message => messages.push(message);
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('delete queue unavailable');
    return realSetItem(key, value);
  };
  fetchMock.calls.length = 0;
  await ctx.restoreVersion(version.id);
  assert.strictEqual(grab('DB').DB.singles[0].id, row.id);
  assert.strictEqual(syncOperations(fetchMock).some(op => op.type === 'delete'), false);
  assert.ok(messages.some(message => message.includes('Version restore stopped')));
  assert.ok(!messages.some(message => message.includes('Restored:')));
  const reloaded = await loadApp({ localStorage: copyStorage(localStorage) });
  assert.strictEqual(reloaded.grab('DB').DB.singles[0].id, row.id);
});

test('trash-lifecycle: restoreFromTrash canonicalises a legacy short-form condition on a restored singles snapshot, and marks it dirty', async () => {
  // Regression pin (v3.33 review round): production trash lives in Supabase
  // and the v4 condition migration can never reach it (DB.trash is only ever
  // populated from the localhost-only _kjrLocalTrash key - see initDB). So a
  // singles row trashed before the migration ran, then restored after the
  // one-shot flag has burned, must still come back canonicalised - not with
  // the legacy 'NM' reintroduced verbatim.
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: {
      _kjrLocalTrash: JSON.stringify([
        { id: 'trash_1', data: { originalTable: 'singles', originalId: 's1', item: { id: 's1', name: 'Legacy Card', condition: 'NM', status: 'Available' }, deletedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
      ]),
    },
  });
  await ctx.restoreFromTrash('trash_1');
  const { DB } = grab('DB');
  const { _dirty } = grab('_dirty');
  const restored = DB.singles.find((r) => r.id === 's1');
  assert.ok(restored, 'row is back in DB.singles');
  assert.strictEqual(restored.condition, 'Near Mint', 'legacy short-form condition is canonicalised on restore, not reintroduced verbatim');
  assert.strictEqual(_dirty.singles.has('s1'), true, 'the restored row is marked dirty so the canonicalised value re-syncs');
});

test('trash-lifecycle: restoreFromTrash - restoring an id already back in the table is a safe no-op (does not duplicate)', async () => {
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    seed: { singles: [{ id: 's1', name: 'Already Here', status: 'Available' }] },
    localStorage: {
      _kjrLocalTrash: JSON.stringify([
        { id: 'trash_1', data: { originalTable: 'singles', originalId: 's1', item: { id: 's1', name: 'Stale Snapshot' }, deletedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
      ]),
    },
  });
  await ctx.restoreFromTrash('trash_1');
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.filter((r) => r.id === 's1').length, 1, 'no duplicate row created');
  assert.strictEqual(DB.trash.length, 0, 'the trash entry is still cleared even on the already-restored guard path');
});
