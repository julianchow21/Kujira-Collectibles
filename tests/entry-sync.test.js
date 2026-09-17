'use strict';

// Hosted Quick Entry sync regressions. These tests use the real dirty-row
// flush, with every network response supplied by the synthetic fetch harness.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadApp, jsonResponse, syncSuccessResponse, syncOperations,
} = require('./harness.js');

function clearDiagnostics(ctx) {
  ctx._syncDiagnostics.failures = {};
  ctx._syncDiagnostics.successes = { read: null, write: null };
  ctx._syncDiagPersist();
  ctx._syncStatus = 'idle';
}

async function hostedApp(options) {
  const loaded = await loadApp(options);
  loaded.fetchMock.calls.length = 0;
  clearDiagnostics(loaded.ctx);
  return loaded;
}

function enter(ctx, document, line) {
  const input = document.getElementById('cmd-add-input');
  input.value = line;
  return ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });
}

function dirtyHas(loaded, table, id) {
  return loaded.grab('_dirty')._dirty[table].has(id);
}

function markerFor(loaded, table, id) {
  const { localStorage } = loaded;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith('pokeinv_dirty_v2:')) continue;
    const marker = JSON.parse(localStorage.getItem(key));
    if (marker.table === table && marker.id === id) return marker;
  }
  return null;
}

function copyStorage(localStorage) {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) out[key] = localStorage.getItem(key);
  }
  return out;
}

function seedRow() {
  return {
    id: 'entry_sync_seed', name: 'Seed row', status: 'Available', language: 'EN', type: 'raw',
    condition: 'Near Mint', qty: 1, costPrice: 10, marketPrice: 15, listPrice: '',
    datePurchased: '1 Jan 2025', notes: '', tcgdexId: '',
  };
}

test('entry-sync: hosted Quick Entry saves locally before cloud work, consumes duplicate Enter, and preserves a new draft', async () => {
  const loaded = await hostedApp();
  const { ctx, document, localStorage } = loaded;
  const input = document.getElementById('cmd-add-input');
  const initialCount = ctx.DB.singles.length;

  const first = enter(ctx, document, 'Eevee 173 EN $9');
  const added = ctx.DB.singles.at(-1);
  assert.equal(ctx.DB.singles.length, initialCount + 1);
  assert.equal(added.name, 'Eevee 173');
  assert.equal(input.value, '', 'the submitted line is consumed synchronously');
  assert.equal(dirtyHas(loaded, 'singles', added.id), true);
  const cached = JSON.parse(localStorage.getItem('pokeinventory_v3'));
  assert.ok(cached.singles.some(row => row.id === added.id && row.name === 'Eevee 173'),
    'the new row is in the immediate local cache');

  const duplicate = ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });
  assert.equal(ctx.DB.singles.length, initialCount + 1, 'rapid repeated Enter cannot duplicate an emptied draft');
  input.value = 'Pikachu 25 EN $10';
  await Promise.all([first, duplicate]);
  assert.equal(input.value, 'Pikachu 25 EN $10', 'a later draft is not cleared by the completed submission');
});

test('entry-sync: saveData timer flushes only the dirty Quick Entry row, excluding a clean seed row', async () => {
  const seed = seedRow();
  const loaded = await hostedApp({ seed: { singles: [seed] } });
  const { ctx, document, fetchMock, timers } = loaded;
  assert.equal(dirtyHas(loaded, 'singles', seed.id), false, 'the seeded row starts clean');
  await enter(ctx, document, 'Eevee 173 EN $9');
  const added = ctx.DB.singles.at(-1);
  const saveTimer = loaded.grab('_saveTimer')._saveTimer;
  assert.ok(saveTimer, 'Quick Entry arms the established one-second save timer');

  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  assert.equal(timers.invoke(saveTimer), true, 'the captured saveData timer invokes the dirty flush');
  await loaded.settle();

  const operations = syncOperations(fetchMock);
  assert.equal(operations.length, 1, 'one dirty-row mutation is sent');
  assert.deepEqual(
    operations.map(operation => [operation.table, operation.id]),
    [['singles', added.id]],
    'the clean seed row is excluded from the hosted request'
  );
  assert.equal(dirtyHas(loaded, 'singles', added.id), false, 'the acknowledged Quick Entry marker clears');
  assert.equal(markerFor(loaded, 'singles', added.id), null, 'the acknowledged v2 marker is removed');

  const reloaded = await loadApp({ seed: null, localStorage: copyStorage(loaded.localStorage) });
  assert.ok(reloaded.grab('DB').DB.singles.some(row => row.id === added.id),
    'the acknowledged row remains in the local cache after reload');
  assert.equal(dirtyHas(reloaded, 'singles', added.id), false,
    'a fresh load does not resurrect the acknowledged row as dirty');
  assert.equal(markerFor(reloaded, 'singles', added.id), null,
    'a fresh load does not resurrect the acknowledged marker');
});

test('entry-sync: successful acknowledgement clears its marker but retains a concurrent marker for another row', async () => {
  const seed = seedRow();
  const loaded = await hostedApp({ seed: { singles: [seed] } });
  const { ctx, document, fetchMock } = loaded;
  await enter(ctx, document, 'Eevee 173 EN $9');
  const added = ctx.DB.singles.at(-1);
  let releasePost;
  let announcePost;
  const postStarted = new Promise(resolve => { announcePost = resolve; });
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    announcePost();
    return new Promise(resolve => { releasePost = () => resolve(syncSuccessResponse(opts)); });
  });

  const flushing = ctx._flushDirtyToSupabase();
  await postStarted;
  const seedInMemory = ctx.DB.singles.find(row => row.id === seed.id);
  seedInMemory.name = 'Edited while Quick Entry uploads';
  ctx.markDirty('singles', seed.id, seedInMemory);
  releasePost();
  await flushing;

  assert.equal(dirtyHas(loaded, 'singles', added.id), false, 'the acknowledged row is cleared');
  assert.equal(markerFor(loaded, 'singles', added.id), null, 'the acknowledged row marker is removed');
  assert.equal(dirtyHas(loaded, 'singles', seed.id), true, 'the concurrent seed edit remains dirty');
  assert.ok(markerFor(loaded, 'singles', seed.id), 'the concurrent seed marker remains durable');
  assert.equal(loaded.ctx._syncDiagPendingSnapshot().totals.dirty, 1);
});

test('entry-sync: a same-row edit during an in-flight acknowledgement remains durable', async () => {
  const loaded = await hostedApp();
  const { ctx, document, fetchMock, localStorage } = loaded;
  await enter(ctx, document, 'Eevee 173 EN $9');
  const added = ctx.DB.singles.at(-1);
  const initialMarker = markerFor(loaded, 'singles', added.id);
  let releasePost;
  let announcePost;
  const postStarted = new Promise(resolve => { announcePost = resolve; });
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    announcePost();
    return new Promise(resolve => { releasePost = () => resolve(syncSuccessResponse(opts)); });
  });

  const flushing = ctx._flushDirtyToSupabase();
  await postStarted;
  const current = ctx.DB.singles.find(row => row.id === added.id);
  current.name = 'Eevee edited during upload';
  ctx.markDirty('singles', added.id, current);
  const newerMarker = markerFor(loaded, 'singles', added.id);
  assert.notEqual(newerMarker.token, initialMarker.token, 'the later same-row edit owns a new token');
  releasePost();
  await flushing;

  assert.equal(ctx.DB.singles.find(row => row.id === added.id).name, 'Eevee edited during upload');
  assert.equal(dirtyHas(loaded, 'singles', added.id), true, 'the later same-row edit remains dirty');
  assert.equal(JSON.parse(markerFor(loaded, 'singles', added.id).rowJson).name, 'Eevee edited during upload');
  assert.equal(localStorage.getItem('pokeinv_dirty_v2:' + initialMarker.token), null,
    'the superseded in-flight marker is not retained beside the newer edit');

  const reloaded = await loadApp({ seed: null, localStorage: copyStorage(localStorage) });
  assert.equal(reloaded.grab('DB').DB.singles.find(row => row.id === added.id).name,
    'Eevee edited during upload');
  assert.equal(dirtyHas(reloaded, 'singles', added.id), true,
    'reload retains the newer same-row edit as dirty');
});

test('entry-sync: a controlled version conflict keeps the new local row queued and reports the conflict', async () => {
  const seed = seedRow();
  const loaded = await hostedApp({ seed: { singles: [seed] } });
  const { ctx, document, fetchMock } = loaded;
  await enter(ctx, document, 'Eevee 173 EN $9');
  const added = ctx.DB.singles.at(-1);
  const seedInMemory = ctx.DB.singles.find(row => row.id === seed.id);
  seedInMemory.name = 'Local seed edit';
  ctx.markDirty('singles', seed.id, seedInMemory);
  fetchMock.route('/sync/v2/mutate', (url, opts) => jsonResponse({
    ok: false,
    code: 'version_conflict',
    conflicts: [{
      table: 'singles',
      id: seed.id,
      current: {
        id: seed.id,
        data: { name: 'Cloud seed copy', status: 'Available' },
        row_version: 2,
        updated_at: '2026-09-17T00:00:00.000Z',
      },
      tombstone: null,
    }],
  }, 409));

  await ctx._flushDirtyToSupabase();
  assert.ok(ctx.DB.singles.some(row => row.id === added.id && row.name === 'Eevee 173'),
    'a conflict on the seed does not remove the new local row');
  assert.equal(dirtyHas(loaded, 'singles', added.id), true, 'the unacknowledged new row remains dirty');
  assert.ok(markerFor(loaded, 'singles', added.id), 'the unacknowledged new row marker remains durable');
  assert.equal(ctx._syncDiagnostics.failures.write.code, 'version_conflict');
  assert.equal(ctx._syncStatus, 'error');
  assert.equal(ctx._syncDiagPendingSnapshot().totals.dirty, 1);
});

test('entry-sync: a controlled transport failure keeps the new local row and reports network_error', async () => {
  const loaded = await hostedApp();
  const { ctx, document, fetchMock } = loaded;
  await enter(ctx, document, 'Eevee 173 EN $9');
  const added = ctx.DB.singles.at(-1);
  fetchMock.reject('/sync/v2/mutate', new TypeError('offline'));

  await ctx._flushDirtyToSupabase();
  assert.ok(ctx.DB.singles.some(row => row.id === added.id && row.name === 'Eevee 173'),
    'a transport failure does not remove the new local row');
  assert.equal(dirtyHas(loaded, 'singles', added.id), true, 'the failed row remains dirty');
  const marker = markerFor(loaded, 'singles', added.id);
  assert.ok(marker, 'the failed row marker remains durable');
  assert.equal(JSON.parse(marker.rowJson).name, 'Eevee 173');
  assert.equal(ctx._syncDiagnostics.failures.write.code, 'network_error');
  assert.equal(ctx._syncStatus, 'error');
  assert.equal(ctx._syncDiagPendingSnapshot().totals.dirty, 1);
});

test('entry-sync: a durable marker removal failure keeps the acknowledged row queued', async () => {
  const loaded = await hostedApp();
  const { ctx, document, fetchMock, localStorage } = loaded;
  await enter(ctx, document, 'Eevee 173 EN $9');
  const added = ctx.DB.singles.at(-1);
  const marker = markerFor(loaded, 'singles', added.id);
  const markerKey = 'pokeinv_dirty_v2:' + marker.token;
  const realRemoveItem = localStorage.removeItem.bind(localStorage);
  localStorage.removeItem = key => {
    if (key === markerKey) throw new Error('marker removal unavailable');
    return realRemoveItem(key);
  };
  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));

  await ctx._flushDirtyToSupabase();
  assert.ok(ctx.DB.singles.some(row => row.id === added.id && row.name === 'Eevee 173'));
  assert.equal(dirtyHas(loaded, 'singles', added.id), true,
    'a marker removal failure keeps the row dirty');
  assert.equal(markerFor(loaded, 'singles', added.id).token, marker.token,
    'a marker removal failure keeps the original durable token');
  assert.equal(ctx._syncDiagPendingSnapshot().totals.dirty, 1);
});
