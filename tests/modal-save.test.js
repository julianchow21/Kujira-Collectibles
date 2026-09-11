'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadApp, syncRequest, syncSuccessResponse, syncOperations,
} = require('./harness.js');

test('modal saves preserve server CAS revisions and explicit zero money values', async () => {
  const single = {
    id: 'modal-cas-single', name: 'Modal CAS single', set: 'Synthetic Set', language: 'EN',
    type: 'raw', condition: 'Near Mint', qty: 1, costPrice: 0, marketPrice: '', listPrice: '',
    datePurchased: '1 Sep 2026', status: 'Available', notes: 'before', priceAlert: '',
    ebayUrl: '', carousellUrl: '', tcgdexId: '', priceHistory: [],
    _serverVersion: 7, _updatedAt: '2026-09-04T00:00:00.000Z',
  };
  const slab = {
    id: 'modal-cas-slab', name: 'Modal CAS slab', grader: 'TAG', grade: '10', language: 'EN',
    certNo: 'SYNTHETIC', rank: '', type: 'slab', costPrice: 0, marketPrice: '', listPrice: '',
    dateListed: '1 Sep 2026', status: 'Available', notes: 'before', priceAlert: '',
    ebayUrl: '', carousellUrl: '', tcgdexId: '', priceHistory: [],
    _serverVersion: 8, _updatedAt: '2026-09-04T00:00:00.000Z',
  };
  const sale = {
    id: 'modal-cas-sale', dateSold: '5 Sep 2026', product: 'Modal CAS sale', buyer: 'Synthetic buyer',
    costPrice: 0, totalCollected: 0, shippingCost: 0, fees: 0, profit: 0, margin: '-',
    channel: 'Carousell', _serverVersion: 9, _updatedAt: '2026-09-04T00:00:00.000Z',
  };
  const loaded = await loadApp({
    seed: { singles: [single], slabs: [slab], sales: [sale] },
  });
  const { ctx, document, fetchMock, grab } = loaded;
  const toasts = [];
  ctx.toast = message => toasts.push(String(message));

  // Drive the actual Singles edit modal. The source row has a real zero cost,
  // so opening it must keep the zero visible before the Notes-only edit.
  ctx.openEditSingle(single.id);
  assert.strictEqual(String(document.getElementById('ms-cost').value), '0');
  document.getElementById('ms-notes').value = 'after single modal edit';
  ctx.saveSingle();

  // The parallel slab and sale modal paths must retain their existing server
  // stamps too, even though each path replaces the row object on save.
  ctx.openEditSlab(slab.id);
  assert.strictEqual(String(document.getElementById('msl-cost').value), '0');
  document.getElementById('msl-notes').value = 'after slab modal edit';
  ctx.saveSlab();

  ctx.openEditSale(sale.id);
  document.getElementById('msa-buyer').value = 'After sale modal edit';
  ctx.saveSale();

  fetchMock.calls.length = 0;
  const mutationRequests = [];
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    mutationRequests.push(syncRequest(opts));
    return syncSuccessResponse(opts);
  });
  await ctx._flushDirtyToSupabase();

  assert.deepStrictEqual(
    mutationRequests.flatMap(request => request.operations.map(operation => operation.expected_version)),
    [7, 8, 9],
    'existing-row modal saves must send their positive server revisions',
  );

  const operations = syncOperations(fetchMock);
  assert.deepStrictEqual(operations.map(operation => [operation.table, operation.expected_version]), [
    ['singles', 7], ['slabs', 8], ['sales', 9],
  ]);
  assert.deepStrictEqual(operations.map(operation => operation.data.costPrice), [0, 0, 0]);
  assert.strictEqual(grab('DB').DB.singles[0].costPrice, 0, 'editing only Notes must retain a zero single cost');
  assert.deepStrictEqual(
    grab('DB').DB.singles[0]._serverVersion,
    8,
    'successful modal flush stamps the next server revision onto the row',
  );
  assert.strictEqual(toasts.some(message => /sync conflict/i.test(message)), false,
    'a valid modal CAS update must not produce a conflict toast');
});

function storageSnapshot(localStorage) {
  const entries = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    entries.push([key, localStorage.getItem(key)]);
  }
  entries.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
  return JSON.stringify(entries);
}

function dirtySnapshot(dirtySet) {
  return JSON.stringify(Array.from(dirtySet || []).sort());
}

const MODAL_CONCURRENCY_CASES = [
  {
    label: 'single', table: 'singles', id: 'modal-stale-single', revision: 11,
    row: {
      id: 'modal-stale-single', name: 'Stale modal single', set: 'Synthetic Set', language: 'EN',
      type: 'raw', condition: 'Near Mint', qty: 1, costPrice: 0, marketPrice: '', listPrice: '',
      datePurchased: '1 Sep 2026', status: 'Available', notes: 'before', priceAlert: '',
      ebayUrl: '', carousellUrl: '', tcgdexId: '', priceHistory: [],
      _serverVersion: 11, _updatedAt: '2026-09-04T00:00:00.000Z',
    },
    open: (ctx, id) => ctx.openEditSingle(id),
    save: ctx => ctx.saveSingle(),
    edit: document => { document.getElementById('ms-notes').value = 'local unsaved single'; },
    read: document => document.getElementById('ms-notes').value,
    remote: row => ({ ...row, notes: 'remote winning single', _updatedAt: '2026-09-04T01:00:00.000Z' }),
  },
  {
    label: 'slab', table: 'slabs', id: 'modal-stale-slab', revision: 12,
    row: {
      id: 'modal-stale-slab', name: 'Stale modal slab', grader: 'TAG', grade: '10', language: 'EN',
      certNo: 'SYNTHETIC', rank: '', type: 'slab', costPrice: 0, marketPrice: '', listPrice: '',
      dateListed: '1 Sep 2026', status: 'Available', notes: 'before', priceAlert: '',
      ebayUrl: '', carousellUrl: '', tcgdexId: '', priceHistory: [],
      _serverVersion: 12, _updatedAt: '2026-09-04T00:00:00.000Z',
    },
    open: (ctx, id) => ctx.openEditSlab(id),
    save: ctx => ctx.saveSlab(),
    edit: document => { document.getElementById('msl-notes').value = 'local unsaved slab'; },
    read: document => document.getElementById('msl-notes').value,
    remote: row => ({ ...row, notes: 'remote winning slab', _serverVersion: 13, _updatedAt: '2026-09-04T01:00:00.000Z' }),
  },
  {
    label: 'sale', table: 'sales', id: 'modal-stale-sale', revision: 14,
    row: {
      id: 'modal-stale-sale', dateSold: '5 Sep 2026', product: 'Stale modal sale', buyer: 'Before',
      costPrice: 0, totalCollected: 0, shippingCost: 0, fees: 0, profit: 0, margin: '-',
      channel: 'Carousell', _serverVersion: 14, _updatedAt: '2026-09-04T00:00:00.000Z',
    },
    open: (ctx, id) => ctx.openEditSale(id),
    save: ctx => ctx.saveSale(),
    edit: document => { document.getElementById('msa-buyer').value = 'local unsaved buyer'; },
    read: document => document.getElementById('msa-buyer').value,
    remote: row => ({ ...row, buyer: 'remote winning buyer', _serverVersion: 15, _updatedAt: '2026-09-04T01:00:00.000Z' }),
  },
];

for (const scenario of MODAL_CONCURRENCY_CASES) {
  test(`modal ${scenario.label} save rejects a row changed after it opened`, async () => {
    const loaded = await loadApp({ seed: { [scenario.table]: [scenario.row] } });
    const { ctx, document, fetchMock, localStorage, grab } = loaded;
    const toasts = [];
    ctx.toast = message => toasts.push(String(message));

    scenario.open(ctx, scenario.id);
    scenario.edit(document);
    const localForm = scenario.read(document);
    const storageBefore = storageSnapshot(localStorage);
    const dirtyBefore = dirtySnapshot(grab('_dirty')._dirty[scenario.table]);
    const undoBefore = grab('undoStack').undoStack.length;

    // Simulate a newer storage merge while this tab's full-row edit remains open.
    const current = grab('DB').DB[scenario.table].find(row => row.id === scenario.id);
    ctx.mergeIntoMemory(scenario.table, [scenario.remote(current)]);
    fetchMock.calls.length = 0;
    scenario.save(ctx);

    const winner = grab('DB').DB[scenario.table].find(row => row.id === scenario.id);
    assert.strictEqual(scenario.read(document), localForm, 'the unsaved form stays open and intact');
    assert.strictEqual(JSON.stringify(winner), JSON.stringify(scenario.remote(current)),
      'the newer row remains the winning in-memory copy');
    assert.strictEqual(fetchMock.calls.length, 0, 'a stale modal does not dispatch a mutation');
    assert.strictEqual(storageSnapshot(localStorage), storageBefore,
      'stale rejection does not write cache, dirty markers, or Changelog');
    assert.strictEqual(dirtySnapshot(grab('_dirty')._dirty[scenario.table]), dirtyBefore,
      'stale rejection does not mark the row dirty');
    assert.strictEqual(grab('undoStack').undoStack.length, undoBefore,
      'stale rejection does not create an undo snapshot');
    assert.ok(toasts.some(message => /changed elsewhere/i.test(message)),
      'the user sees a clear changed-record message');
  });

  test(`modal ${scenario.label} save rejects a row deleted after it opened`, async () => {
    const loaded = await loadApp({ seed: { [scenario.table]: [scenario.row] } });
    const { ctx, document, fetchMock, localStorage, grab } = loaded;
    const toasts = [];
    ctx.toast = message => toasts.push(String(message));

    scenario.open(ctx, scenario.id);
    scenario.edit(document);
    const localForm = scenario.read(document);
    const storageBefore = storageSnapshot(localStorage);
    const dirtyBefore = dirtySnapshot(grab('_dirty')._dirty[scenario.table]);
    const undoBefore = grab('undoStack').undoStack.length;
    const db = grab('DB').DB;
    db[scenario.table] = db[scenario.table].filter(row => row.id !== scenario.id);
    fetchMock.calls.length = 0;
    scenario.save(ctx);

    assert.strictEqual(db[scenario.table].some(row => row.id === scenario.id), false,
      'a deleted row is not resurrected by the stale modal');
    assert.strictEqual(scenario.read(document), localForm, 'the unsaved form stays open and intact');
    assert.strictEqual(fetchMock.calls.length, 0, 'a deleted modal does not dispatch a mutation');
    assert.strictEqual(storageSnapshot(localStorage), storageBefore,
      'deleted-row rejection does not write cache, dirty markers, or Changelog');
    assert.strictEqual(dirtySnapshot(grab('_dirty')._dirty[scenario.table]), dirtyBefore,
      'deleted-row rejection does not mark the row dirty');
    assert.strictEqual(grab('undoStack').undoStack.length, undoBefore,
      'deleted-row rejection does not create an undo snapshot');
    assert.ok(toasts.some(message => /deleted elsewhere/i.test(message)),
      'the user sees a clear deleted-record message');
  });
}
