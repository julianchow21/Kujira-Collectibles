'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain, syncRequest, syncSuccessResponse } = require('./harness.js');

const purchase = (extra = {}) => ({ id: 'one-purchase', product: 'Synthetic card',
  status: 'Shipping to Singapore', totalSgd: 20, _serverVersion: 1, ...extra });

async function setup(extra) {
  const app = await loadApp({ seed: { singles: [], ebayPurchases: [purchase(extra)] } });
  app.ctx.kjrOpenCompleteModal('one-purchase');
  return app;
}

function capture(app) {
  return {
    db: JSON.stringify(plain(app.ctx.DB)),
    cache: app.localStorage.getItem('pokeinventory_v3'),
    groups: JSON.stringify(plain(app.ctx._readMutationGroups())),
    undo: JSON.stringify(plain(app.ctx.undoStack)),
    dirty: Object.fromEntries(Object.entries(app.ctx._dirty).map(([key, ids]) => [key, [...ids].sort()])),
  };
}

function pauseConfirmation(app) {
  let release, calls = 0;
  app.ctx._kjrCompleteCtx.items[0].cost = 10;
  app.ctx.kjrConfirm = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  return { release: value => release(value), calls: () => calls };
}

for (const deliverStorageEvent of [true, false]) {
  test('eBay stale completion creates stock only once with storage event delivery=' + deliverStorageEvent, async () => {
    const first = await setup();
    const second = await loadApp({ seed: null, storage: first.localStorage });
    second.ctx.kjrOpenCompleteModal('one-purchase');
    const cloud = new Map([['ebay_purchases/one-purchase', { version: 1, data: purchase() }]]);
    const receipts = new Map();
    const responder = (_url, options) => {
      const request = syncRequest(options);
      if (receipts.has(request.mutation_id)) return receipts.get(request.mutation_id);
      // The original bug passed every one of these strict CAS checks: the
      // stale dialog silently adopted the already-completed row's revision.
      for (const op of request.operations) {
        assert.equal(op.expected_version, cloud.get(op.table + '/' + op.id)?.version || 0);
      }
      for (const op of request.operations) {
        cloud.set(op.table + '/' + op.id, { version: op.expected_version + 1, data: op.data });
      }
      const response = syncSuccessResponse(options);
      receipts.set(request.mutation_id, response);
      return response;
    };
    first.fetchMock.route('/sync/v2/mutate', responder);
    second.fetchMock.route('/sync/v2/mutate', responder);
    await first.ctx.kjrConfirmCompletion();
    assert.equal(await first.ctx._flushMutationGroups(), true);
    if (deliverStorageEvent) {
      second.ctx.dispatchEvent({ type: 'storage', key: 'pokeinventory_v3', oldValue: null,
        newValue: first.localStorage.getItem('pokeinventory_v3'), storageArea: null });
      assert.equal(second.ctx.DB.ebayPurchases[0].status, 'Completed');
      assert.equal(second.ctx.DB.ebayPurchases[0]._serverVersion, 2);
    }
    const before = capture(second);
    const form = second.ctx._kjrCompleteCtx;
    await second.ctx.kjrConfirmCompletion();
    assert.deepEqual(capture(second), before, 'a stale click has no inventory, cache, Undo or queue side effects');
    assert.equal(second.ctx._kjrCompleteCtx, form, 'the reviewed allocation remains available');
    assert.equal(await second.ctx._flushMutationGroups(), true);
    assert.equal([...cloud.keys()].filter(key => key.startsWith('singles/')).length, 1);
    assert.equal(cloud.get('ebay_purchases/one-purchase').version, 2);
  });
}

for (const [name, mutate] of [
  ['purchase deletion', app => { app.ctx.DB.ebayPurchases = []; }],
  ['a newer server version', app => { app.ctx.DB.ebayPurchases[0]._serverVersion = 2; }],
  ['a local cost edit', app => { app.ctx.DB.ebayPurchases[0].totalSgd = 99; }],
  ['a local product edit', app => { app.ctx.DB.ebayPurchases[0].product = 'Different physical purchase'; }],
  ['a status change', app => { app.ctx.DB.ebayPurchases[0].status = 'Paid'; }],
  ['Dealer ownership', app => { app.ctx.DB.ebayPurchases[0].dealerCandidateId = 'synthetic-dealer'; }],
]) {
  test('eBay completion rejects ' + name + ' after review', async () => {
    const app = await setup();
    mutate(app);
    const before = capture(app);
    await app.ctx.kjrConfirmCompletion();
    assert.deepEqual(capture(app), before);
  });
}

test('eBay completion rechecks the row after the allocation confirmation await', async () => {
  const app = await setup();
  const confirmation = pauseConfirmation(app);
  const saving = app.ctx.kjrConfirmCompletion();
  app.ctx.DB.ebayPurchases[0].totalSgd = 40;
  app.ctx.saveData();
  const before = capture(app);
  confirmation.release(true);
  await saving;
  assert.deepEqual(capture(app), before);
  assert.equal(app.ctx._kjrCompleteCtx.items[0].cost, 10);
});

test('eBay completion checks shared storage again while confirmation is open', async () => {
  const app = await setup();
  const confirmation = pauseConfirmation(app);
  const saving = app.ctx.kjrConfirmCompletion();
  const cache = JSON.parse(app.localStorage.getItem('pokeinventory_v3'));
  cache.ebayPurchases[0].status = 'Completed';
  cache.ebayPurchases[0]._serverVersion = 2;
  app.localStorage.setItem('pokeinventory_v3', JSON.stringify(cache));
  const before = capture(app);
  confirmation.release(true);
  await saving;
  assert.deepEqual(capture(app), before);
});

test('double-clicking an allocation confirmation only queues one completion', async () => {
  const app = await setup();
  const confirmation = pauseConfirmation(app);
  const first = app.ctx.kjrConfirmCompletion();
  await app.ctx.kjrConfirmCompletion();
  assert.equal(confirmation.calls(), 1);
  confirmation.release(true);
  await first;
  await app.ctx.kjrConfirmCompletion();
  assert.equal(app.ctx.DB.singles.length, 1);
  assert.equal(app.ctx.DB.ebayPurchases[0].status, 'Completed');
  assert.equal(app.ctx._readMutationGroups().length, 1);
});

for (const change of ['allocation', 'close', 'reopen']) {
  test('eBay completion stops if the form changes during confirmation: ' + change, async () => {
    const app = await setup();
    const confirmation = pauseConfirmation(app);
    const saving = app.ctx.kjrConfirmCompletion();
    if (change === 'allocation') app.ctx._kjrCompleteCtx.items[0].name = 'Edited after confirming';
    else app.ctx.kjrCloseCompleteModal();
    if (change === 'reopen') app.ctx.kjrOpenCompleteModal('one-purchase');
    const before = capture(app);
    const form = app.ctx._kjrCompleteCtx;
    confirmation.release(true);
    await saving;
    assert.deepEqual(capture(app), before);
    assert.equal(app.ctx._kjrCompleteCtx, form);
  });
}

test('declining an allocation warning lets the user review and confirm later', async () => {
  const app = await setup();
  const confirmation = pauseConfirmation(app);
  const before = capture(app);
  const saving = app.ctx.kjrConfirmCompletion();
  confirmation.release(false);
  await saving;
  assert.deepEqual(capture(app), before);
  app.ctx._kjrCompleteCtx.items[0].cost = 20;
  await app.ctx.kjrConfirmCompletion();
  assert.equal(app.ctx.DB.singles.length, 1);
});

for (const state of ['pending transaction', 'corrupt queue', 'unavailable cache']) {
  test('eBay completion refuses an unsafe sync state: ' + state, async () => {
    const app = await setup();
    if (state === 'pending transaction') {
      assert.ok(app.ctx._queueMutationGroup([app.ctx._upsertOperation('ebay_purchases', {
        ...plain(app.ctx.DB.ebayPurchases[0]), notes: 'Pending edit',
      })]));
    } else if (state === 'corrupt queue') {
      app.localStorage.setItem('_kjrMutationGroupV2:bad-record', '{');
    } else {
      app.localStorage.setItem('pokeinventory_v3', '{');
    }
    const before = capture(app);
    await app.ctx.kjrConfirmCompletion();
    assert.deepEqual(capture(app), before);
  });
}

test('the completion entry point rejects an already-completed purchase', async () => {
  const app = await loadApp({ seed: { ebayPurchases: [purchase({ status: 'Completed' })] } });
  app.ctx.kjrOpenCompleteModal('one-purchase');
  assert.equal(app.ctx._kjrCompleteCtx, null);
});

test('completion carries a reviewed manual zero total into the inventory cost', async () => {
  const app = await setup({ totalSgd: 0, totalSgdManual: true, priceUsd: 10, freightSgd: 5 });
  assert.equal(app.ctx._kjrCompleteCtx.sgdCost, 0);
  assert.equal(app.ctx._kjrCompleteCtx.items[0].cost, 0);
  await app.ctx.kjrConfirmCompletion();
  assert.equal(app.ctx.DB.singles.length, 1);
  assert.equal(app.ctx.DB.singles[0].costPrice, 0);
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, 0);
});

test('a lost completion acknowledgement survives reload and retries without creating more stock', async () => {
  const first = await setup();
  let committed, response;
  first.fetchMock.route('/sync/v2/mutate', (_url, options) => {
    const request = syncRequest(options);
    assert.equal(committed, undefined, 'only one initial transaction reaches the server');
    assert.equal(request.operations.find(op => op.table === 'ebay_purchases').expected_version, 1);
    committed = request;
    response = syncSuccessResponse(options);
    throw new Error('Synthetic acknowledgement lost after commit');
  });
  await first.ctx.kjrConfirmCompletion();
  assert.equal(await first.ctx._flushMutationGroups(), false);
  assert.equal(first.ctx._readMutationGroups().length, 1);
  const reloaded = await loadApp({ seed: null, storage: first.localStorage });
  reloaded.ctx.kjrOpenCompleteModal('one-purchase');
  assert.equal(reloaded.ctx._kjrCompleteCtx, null);
  await reloaded.ctx.kjrConfirmCompletion();
  assert.equal(reloaded.ctx.DB.singles.length, 1);
  reloaded.fetchMock.route('/sync/v2/mutate', (_url, options) => {
    assert.deepEqual(syncRequest(options), committed, 'retry reuses the exact idempotent transaction');
    return response;
  });
  assert.equal(await reloaded.ctx._flushMutationGroups(), true);
  assert.equal(reloaded.ctx._readMutationGroups().length, 0);
  assert.equal(reloaded.ctx.DB.singles.length, 1);
  assert.equal(reloaded.ctx.DB.ebayPurchases[0]._serverVersion, 2);
});
