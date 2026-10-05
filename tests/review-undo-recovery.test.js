'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeSeed, plain, syncRequest, syncSuccessResponse } = require('./harness.js');
const keys = ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'];
const state = app => Object.fromEntries(keys.map(key => [key, plain(app.ctx.DB[key])]));
const fill = (app, fields) => Object.entries(fields).forEach(([id, value]) => { app.document.getElementById(id).value = value; });
const messagesFor = app => { const messages = []; app.ctx.toast = app.ctx.toastError = message => messages.push(message); return messages; };
const routes = app => { const operations = []; app.fetchMock.route('/sync/v2/mutate', (_url, options) => { operations.push(...syncRequest(options).operations); return syncSuccessResponse(options); }); return operations; };
async function queuedSale(id) {
  const app = await loadApp({ seed: makeSeed({ singles: [], slabs: [{ id, name: 'Synthetic slab', costPrice: 10, status: 'Available', _serverVersion: 1 }] }) });
  await app.ctx.markStatus('slabs', id, 'Sold');
  fill(app, { 'qs-total': '25', 'qs-cost': '10', 'qs-date': '2026-10-03' });
  app.ctx.confirmQuickSell();
  return app;
}
function pausePreflight(app) {
  const original = app.ctx._prepareExplicitRowRestores;
  let release;
  app.ctx._prepareExplicitRowRestores = (...args) => new Promise(resolve => { release = async () => resolve(await original(...args)); });
  return () => release();
}
function dispatchPeer(app, peer) {
  const incoming = JSON.stringify({ ...state(app), singles: [...plain(app.ctx.DB.singles), peer] });
  app.localStorage.setItem('pokeinventory_v3', incoming);
  app.ctx.dispatchEvent({ type: 'storage', key: 'pokeinventory_v3', newValue: incoming, oldValue: null, storageArea: null });
  return incoming;
}

for (const action of ['undo', 'redo']) {
  test(`${action} preserves an unresolved atomic sale instead of reporting a reversal replayed on reload`, async () => {
    const app = await queuedSale(action + '-offline');
    if (action === 'redo') app.ctx.redoStack.push(JSON.stringify({ ...state(app), sales: [] }));
    const before = state(app), group = JSON.stringify(app.ctx._readMutationGroups());
    const stacks = [app.ctx.undoStack.length, app.ctx.redoStack.length];
    const messages = messagesFor(app);
    assert.equal(await app.ctx[action === 'undo' ? 'undoLast' : 'redoLast'](), false);
    assert.deepEqual(state(app), before);
    assert.equal(JSON.stringify(app.ctx._readMutationGroups()), group);
    assert.deepEqual([app.ctx.undoStack.length, app.ctx.redoStack.length], stacks);
    assert.match(messages.at(-1), /pending sync transaction/);
    const reloaded = await loadApp({ seed: null, storage: app.localStorage });
    assert.equal(reloaded.ctx.DB.slabs[0].status, 'Sold');
    assert.equal(reloaded.ctx.DB.sales.length, 1);
  });
}

test('Undo retains a transaction after a simulated lost acknowledgement', async () => {
  const app = await queuedSale('lost-ack');
  let committed = false;
  app.fetchMock.route('/sync/v2/mutate', () => { committed = true; throw new Error('synthetic lost acknowledgement'); });
  await app.ctx._flushDirtyToSupabase();
  assert.equal(committed, true);
  const group = JSON.stringify(app.ctx._readMutationGroups());
  assert.equal(await app.ctx.undoLast(), false);
  assert.equal(JSON.stringify(app.ctx._readMutationGroups()), group);
  assert.equal(app.ctx.DB.sales.length, 1);
});

test('Undo of a synced addition sends a CAS delete with its recoverable source snapshot', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [] }) });
  const ops = routes(app);
  app.ctx.openAddSingle(); fill(app, { 'ms-name': 'Synthetic addition', 'ms-cost': '10' });
  await app.ctx.saveSingle(); await app.ctx._flushDirtyToSupabase();
  const created = plain(app.ctx.DB.singles[0]);
  assert.equal(created._serverVersion, 1);
  assert.equal(await app.ctx.undoLast(), true);
  const deletion = ops.find(op => op.type === 'delete' && op.id === created.id);
  assert.equal(deletion.expected_version, 1);
  assert.deepEqual(deletion.trash.data.item, created);
  assert.equal(app.ctx.DB.singles.length, 0);
  assert.equal(app.ctx._readDeleteState().state.pending.length, 0);
  assert.ok(app.ctx.DB.trash.some(row => row.data.originalId === created.id));
  const reloaded = await loadApp({ seed: null, storage: app.localStorage });
  assert.equal(reloaded.ctx.DB.singles.length, 0);
  const messages = messagesFor(app);
  assert.equal(await app.ctx.redoLast(), false);
  assert.match(messages.at(-1), /Trash/);
  assert.equal(app.ctx.redoStack.length, 1);
});

test('after sale acknowledgement Undo rebases its inventory edit and snapshots the removed sale', async () => {
  const app = await queuedSale('synced-sale');
  const ops = routes(app);
  await app.ctx._flushDirtyToSupabase();
  assert.equal(app.ctx._readMutationGroups().length, 0);
  const sale = plain(app.ctx.DB.sales[0]);
  assert.equal(await app.ctx.undoLast(), true);
  assert.equal(app.ctx.DB.slabs[0].status, 'Available');
  assert.equal(app.ctx.DB.slabs[0]._serverVersion, 2);
  await app.ctx._flushDirtyToSupabase();
  assert.equal(ops.find(op => op.table === 'slabs' && op.data?.status === 'Available').expected_version, 2);
  assert.ok(ops.some(op => op.type === 'delete' && op.id === sale.id && op.expected_version === 1 && op.trash.data.item.id === sale.id));
});

test('Undo keeps state and stacks when its Trash snapshot cannot be saved', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [] }) });
  app.ctx.snapshotForUndo(); app.ctx.DB.singles.push({ id: 'trash-failure', name: 'Keep', _serverVersion: 2 }); app.ctx.saveData();
  const before = state(app), set = app.localStorage.setItem.bind(app.localStorage);
  app.localStorage.setItem = (key, value) => { if (key === '_kjrPendingTrashWrites') throw new Error('synthetic storage full'); return set(key, value); };
  const ops = routes(app);
  assert.equal(await app.ctx.undoLast(), false);
  assert.deepEqual(state(app), before);
  assert.equal(app.ctx.undoStack.length, 1); assert.equal(app.ctx.redoStack.length, 0);
  assert.equal(ops.length, 0); assert.equal(app.ctx._readDeleteState().state.pending.length, 0);
});

test('Redo also snapshots a synced source before deleting it', async () => {
  const row = { id: 'redo-delete', name: 'Synthetic', _serverVersion: 3 };
  const app = await loadApp({ seed: makeSeed({ singles: [row] }) });
  app.ctx.redoStack.push(JSON.stringify({ ...state(app), singles: [] }));
  const ops = routes(app);
  assert.equal(await app.ctx.redoLast(), true);
  const deletion = ops.find(op => op.type === 'delete' && op.id === row.id);
  assert.equal(deletion.expected_version, 3); assert.equal(deletion.trash.data.item.name, row.name);
});

for (const evidence of ['pending-delete', 'server-tombstone', 'missing-current-stamp']) {
  test(`Undo blocks same-ID restoration when current CAS safety is unresolved: ${evidence}`, async () => {
    const row = { id: 'same-id-guard', name: 'Synthetic', costPrice: 10, _serverVersion: 1 };
    const app = await loadApp({ seed: makeSeed({ singles: [row] }) });
    app.ctx.snapshotForUndo(); app.ctx.DB.singles[0].costPrice = 20;
    if (evidence === 'pending-delete') app.ctx._queuePendingDelete('singles', row.id, '');
    if (evidence === 'server-tombstone') app.ctx._serverTombstones = [{ table: 'singles', id: row.id, row_version: 2 }];
    if (evidence === 'missing-current-stamp') delete app.ctx.DB.singles[0]._serverVersion;
    const before = state(app), markers = JSON.stringify(app.ctx._readDeleteState().state);
    const messages = messagesFor(app);
    assert.equal(await app.ctx.undoLast(), false);
    assert.deepEqual(state(app), before); assert.equal(app.ctx.undoStack.length, 1);
    assert.equal(JSON.stringify(app.ctx._readDeleteState().state), markers);
    assert.match(messages.at(-1), /Trash or refresh/);
  });
}

for (const action of ['undo', 'redo']) {
  test(`${action} preserves a real storage-event peer addition while waiting for preflight`, async () => {
    const app = await loadApp({ seed: makeSeed({ singles: [{ id: 'reviewed', name: 'Synthetic', costPrice: 10, _serverVersion: 1 }] }) });
    if (action === 'undo') { app.ctx.snapshotForUndo(); app.ctx.DB.singles[0].costPrice = 20; }
    else app.ctx.redoStack.push(JSON.stringify({ ...state(app), singles: [{ ...plain(app.ctx.DB.singles[0]), costPrice: 20 }] }));
    app.ctx.saveData(); const stacks = [app.ctx.undoStack.length, app.ctx.redoStack.length];
    const beforeDeletes = JSON.stringify(app.ctx._readDeleteState().state), release = pausePreflight(app), messages = messagesFor(app);
    const pending = app.ctx[action === 'undo' ? 'undoLast' : 'redoLast'](); await app.settle();
    const raw = dispatchPeer(app, { id: 'peer-addition', name: 'Peer', costPrice: 70, _serverVersion: 1 });
    await release(); assert.equal(await pending, false);
    assert.equal(app.ctx.DB.singles.length, 2); assert.equal(app.localStorage.getItem('pokeinventory_v3'), raw);
    assert.deepEqual([app.ctx.undoStack.length, app.ctx.redoStack.length], stacks);
    assert.equal(JSON.stringify(app.ctx._readDeleteState().state), beforeDeletes); assert.match(messages.at(-1), /inventory changed/);
  });

  test(`${action} merges peer updates delivered after the safety callback but before lock completion`, async () => {
    let app, armed = false;
    const locks = { request: async (name, _options, callback) => {
      const result = await callback();
      if (armed && name === 'kjr-cloud-row:__kjr_local__/delete-state') { armed = false; dispatchPeer(app, { id: 'late-peer', name: 'Late peer', _serverVersion: 1 }); }
      return result;
    } };
    app = await loadApp({ locks, seed: makeSeed({ singles: [{ id: 'reviewed', name: 'Synthetic', costPrice: 10, _serverVersion: 1 }] }) });
    if (action === 'undo') { app.ctx.snapshotForUndo(); app.ctx.DB.singles[0].costPrice = 20; }
    else app.ctx.redoStack.push(JSON.stringify({ ...state(app), singles: [{ ...plain(app.ctx.DB.singles[0]), costPrice: 20 }] }));
    app.ctx.saveData(); armed = true;
    assert.equal(await app.ctx[action === 'undo' ? 'undoLast' : 'redoLast'](), true);
    assert.equal(armed, false); assert.equal(app.ctx.DB.singles.length, 2);
    assert.equal(app.ctx.DB.singles.find(row => row.id === 'reviewed').costPrice, action === 'undo' ? 10 : 20);
    assert.equal(JSON.parse(app.localStorage.getItem('pokeinventory_v3')).singles.length, 2);
  });
}

test('Undo detects a peer cache write before its storage event arrives', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [{ id: 'reviewed', name: 'Synthetic', costPrice: 10, _serverVersion: 1 }] }) });
  app.ctx.snapshotForUndo(); app.ctx.DB.singles[0].costPrice = 20; app.ctx.saveData();
  const release = pausePreflight(app), pending = app.ctx.undoLast(); await app.settle();
  const raw = JSON.stringify({ ...state(app), singles: [...plain(app.ctx.DB.singles), { id: 'cache-peer', name: 'Peer' }] });
  app.localStorage.setItem('pokeinventory_v3', raw); await release();
  assert.equal(await pending, false); assert.equal(app.ctx.DB.singles[0].costPrice, 20);
  assert.equal(app.localStorage.getItem('pokeinventory_v3'), raw); assert.equal(app.ctx.undoStack.length, 1);
});

test('failed local Undo persistence restores inventory, stacks, and recovery queues', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [] }) });
  app.ctx.snapshotForUndo(); app.ctx.DB.singles.push({ id: 'cache-failure', name: 'Keep', _serverVersion: 2 }); app.ctx.saveData();
  const before = state(app), raw = app.localStorage.getItem('pokeinventory_v3'), marker = JSON.stringify(app.ctx._readDeleteState().state);
  const set = app.localStorage.setItem.bind(app.localStorage);
  app.localStorage.setItem = (key, value) => { if (key === 'pokeinventory_v3') throw new Error('synthetic cache failure'); return set(key, value); };
  assert.equal(await app.ctx.undoLast(), false); assert.deepEqual(state(app), before);
  assert.equal(app.localStorage.getItem('pokeinventory_v3'), raw); assert.equal(JSON.stringify(app.ctx._readDeleteState().state), marker);
  assert.equal(app.ctx._readPendingTrashEntries().length, 0); assert.equal(app.ctx.undoStack.length, 1); assert.equal(app.ctx.redoStack.length, 0);
});

test('shared replacement rollback matches canonical cache when next state includes non-cache tables', async () => {
  const app = await loadApp(); const before = state(app), raw = app.localStorage.getItem('pokeinventory_v3');
  const next = { ...state(app), singles: [{ id: 'attempted', name: 'New row' }], trash: [], changelog: [] };
  const result = await app.ctx._prepareReplacementSafety(next, [], { apply: () => {
    app.ctx.snapshotForUndo(); app.ctx.DB.singles = next.singles; app.ctx.markDirty('singles', 'attempted'); app.ctx.saveData(); return false;
  } });
  assert.equal(result, false); assert.deepEqual(state(app), before); assert.equal(app.localStorage.getItem('pokeinventory_v3'), raw);
  assert.equal(app.ctx.undoStack.length, 0); assert.equal(app.ctx._dirty.singles.has('attempted'), false);
});

test('a transaction arriving while Undo waits blocks before destructive recovery markers', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [] }) });
  const row = { id: 'pending-arrival', name: 'Synthetic', costPrice: 10, _serverVersion: 1 };
  app.ctx.snapshotForUndo(); app.ctx.DB.singles.push(row); const release = pausePreflight(app);
  const pending = app.ctx.undoLast(); await app.settle();
  assert.ok(app.ctx._queueMutationGroup([app.ctx._upsertOperation('singles', { ...row, costPrice: 20 })]));
  await release(); assert.equal(await pending, false);
  assert.equal(app.ctx._readDeleteState().state.pending.length, 0); assert.equal(app.ctx._readPendingTrashEntries().length, 0);
  assert.equal(app.ctx.DB.singles.length, 1); assert.equal(app.ctx.undoStack.length, 1);
});

test('corrupt queued transaction recovery blocks Undo without discarding its bytes', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [] }) });
  app.ctx.snapshotForUndo(); app.ctx.DB.singles.push({ id: 'corrupt', name: 'Keep' });
  const group = app.ctx._queueMutationGroup([app.ctx._upsertOperation('singles', app.ctx.DB.singles[0])]);
  const key = app.ctx.PENDING_MUTATION_GROUP_KEY_PREFIX + group.mutation_id;
  app.localStorage.setItem(key, '{invalid-json');
  assert.equal(await app.ctx.undoLast(), false); assert.equal(app.localStorage.getItem(key), '{invalid-json');
  assert.equal(app.ctx.DB.singles.length, 1); assert.equal(app.ctx.undoStack.length, 1);
});
