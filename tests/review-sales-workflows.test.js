'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadApp, makeSeed, plain, createLocalStorage, syncRequest, syncSuccessResponse,
} = require('./harness.js');

const slab = (id, extra) => ({ id, name: 'Synthetic ' + id, grader: 'PSA', grade: '10',
  certNo: id, costPrice: 10, listPrice: 25, status: 'Available', _serverVersion: 1,
  datePurchased: '1 Jan 2026', ...extra });
const single = (id, extra) => ({ id, name: 'Synthetic grouped card', set: 'Base',
  language: 'EN', condition: 'Near Mint', type: 'raw', qty: 1, costPrice: 10,
  listPrice: 25, status: 'Available', _serverVersion: 1, datePurchased: '1 Jan 2026', ...extra });
const fill = (app, values) => Object.entries(values).forEach(([id, value]) => {
  app.document.getElementById(id).value = value;
});

function addToCart(app, table, id, price = '25', qty = 1) {
  const current = app.ctx.DB[table].find(row => row.id === id);
  app.ctx.cmdSellResults = [{ ...plain(current), _table: table }];
  app.ctx.cmdSellAddToCart(0);
  const line = app.ctx.cmdSellCart.find(row => table === 'singles'
    ? row._table === table && row.groupKey === app.ctx.cmdSingleGroupKey(current)
    : row._table === table && row.id === id);
  assert.ok(line, 'the actual add-to-cart flow creates a reviewed line');
  app.ctx.cmdSellSetPrice(line.id, price);
  if (qty > 1) app.ctx.cmdSellSetQty(line.id, qty - 1);
  return line;
}

function saleFields(app, extra = {}) {
  fill(app, { 'cmd-sell-date': '2026-10-03', 'cmd-sell-ship': '0', 'cmd-sell-fees': '0',
    'cmd-sell-channel': 'Carousell', 'cmd-sell-buyer': 'Synthetic buyer', ...extra });
}

function recordBefore(app) {
  return { db: JSON.stringify(plain(app.ctx.DB)), cache: app.localStorage.getItem('pokeinventory_v3'),
    undo: app.ctx.undoStack.length, groups: JSON.stringify(plain(app.ctx._readMutationGroups())) };
}

function assertUnchanged(app, before) {
  assert.equal(JSON.stringify(plain(app.ctx.DB)), before.db, 'no inventory or sale is changed');
  assert.equal(app.localStorage.getItem('pokeinventory_v3'), before.cache, 'no inventory cache is replaced');
  assert.equal(app.ctx.undoStack.length, before.undo, 'no undo snapshot is added');
  assert.equal(JSON.stringify(plain(app.ctx._readMutationGroups())), before.groups, 'no transaction is queued');
}

test('review-sales: a peer sale invalidates an already-open Quick Sell dialog', async () => {
  const row = slab('one-physical-copy', { _updatedAt: '2026-01-01T00:00:00Z' });
  const storage = createLocalStorage();
  const first = await loadApp({ seed: makeSeed({ slabs: [row] }), storage });
  const second = await loadApp({ seed: null, storage });
  let serverVersion = 1;
  const acceptedSales = new Set();
  const responder = (_url, options) => {
    const request = syncRequest(options);
    const inventory = request.operations.find(op => op.table === 'slabs');
    if (inventory) {
      assert.equal(inventory.expected_version, serverVersion);
      serverVersion++;
    }
    request.operations.filter(op => op.table === 'sales').forEach(op => acceptedSales.add(op.id));
    return syncSuccessResponse(options);
  };
  for (const app of [first, second]) {
    app.fetchMock.route('/sync/v2/mutate', responder);
    await app.ctx.markStatus('slabs', row.id, 'Sold');
    fill(app, { 'qs-total': '25', 'qs-cost': '10', 'qs-date': '2026-10-03' });
  }
  first.ctx.confirmQuickSell();
  await first.ctx._flushDirtyToSupabase();
  second.ctx.dispatchEvent({ type: 'storage', key: 'pokeinventory_v3', oldValue: null,
    newValue: storage.getItem('pokeinventory_v3'), storageArea: null });
  assert.equal(second.ctx.DB.slabs[0].status, 'Sold');
  assert.equal(second.ctx.DB.slabs[0]._serverVersion, 2);
  const messages = [];
  second.ctx.toast = text => messages.push(text);
  const before = recordBefore(second);
  second.ctx.confirmQuickSell();
  assertUnchanged(second, before);
  await second.ctx._flushDirtyToSupabase();
  assert.equal(second.ctx.DB.sales.length, 1);
  assert.equal(acceptedSales.size, 1, 'only one sale reaches the fake CAS server');
  assert.match(messages.join('\n'), /reopen Quick Sell/);
});

for (const [label, mutate] of [
  ['a newer server revision', row => { row._serverVersion++; }],
  ['an unsynced quantity change', row => { row.qty = 2; }],
  ['an unsynced cost change', row => { row.costPrice = 99; }],
  ['a new Dealer Desk owner', row => { row.dealerCopyId = 'synthetic-dealer-copy'; }],
]) {
  test('review-sales: Quick Sell rechecks ' + label + ' at confirmation', async () => {
    const app = await loadApp({ seed: makeSeed({ singles: [single('quick-review', { qty: 3 })] }) });
    await app.ctx.markStatus('singles', 'quick-review', 'Sold');
    fill(app, { 'qs-total': '25', 'qs-date': '2026-10-03' });
    mutate(app.ctx.DB.singles[0]);
    const before = recordBefore(app);
    app.ctx.confirmQuickSell();
    assertUnchanged(app, before);
  });
}

test('review-sales: a valid Quick Sell consumes one unit and repeated confirmation cannot sell again', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single('quick-multi', { qty: 2 })] }) });
  await app.ctx.markStatus('singles', 'quick-multi', 'Sold');
  fill(app, { 'qs-total': '25', 'qs-date': '2026-10-03' });
  app.ctx.confirmQuickSell();
  assert.equal(app.ctx.DB.singles[0].qty, 1);
  assert.equal(app.ctx.DB.singles[0].status, 'Available');
  assert.equal(app.ctx.DB.sales.length, 1);
  const before = recordBefore(app);
  app.ctx.confirmQuickSell();
  assertUnchanged(app, before);
  app.fetchMock.route('/sync/v2/mutate', (_url, options) => syncSuccessResponse(options));
  assert.equal(await app.ctx._flushMutationGroups(), true);
  await app.ctx.markStatus('singles', 'quick-multi', 'Sold');
  fill(app, { 'qs-total': '30', 'qs-date': '2026-10-03' });
  app.ctx.confirmQuickSell();
  assert.equal(app.ctx.DB.singles[0].status, 'Sold');
  assert.equal(app.ctx.DB.sales.length, 2, 'an explicit fresh review can sell the remaining unit');
});

test('review-sales: a second Quick Sell waits for the earlier row transaction to be acknowledged', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single('pending-quick', { qty: 2 })] }) });
  await app.ctx.markStatus('singles', 'pending-quick', 'Sold');
  fill(app, { 'qs-total': '25', 'qs-date': '2026-10-03' });
  app.ctx.confirmQuickSell();
  assert.equal(app.ctx.DB.singles[0].qty, 1);
  assert.equal(app.ctx._readMutationGroups().length, 1);
  const before = recordBefore(app);
  const messages = [];
  app.ctx.toast = text => messages.push(text);
  await app.ctx.markStatus('singles', 'pending-quick', 'Sold');
  fill(app, { 'qs-total': '30' });
  app.ctx.confirmQuickSell();
  assertUnchanged(app, before);
  assert.equal(app.document.getElementById('qs-total').value, '30', 'rejected confirmation preserves the entered price');
  assert.match(messages.join('\n'), /Sync it before recording another sale/);
  app.fetchMock.route('/sync/v2/mutate', (_url, options) => syncSuccessResponse(options));
  assert.equal(await app.ctx._flushMutationGroups(), true);
  await app.ctx.markStatus('singles', 'pending-quick', 'Sold');
  fill(app, { 'qs-total': '30', 'qs-date': '2026-10-03' });
  app.ctx.confirmQuickSell();
  const next = plain(app.ctx._readMutationGroups());
  assert.equal(next[0].operations.find(op => op.table === 'singles').expected_version, 2);
  assert.equal(await app.ctx._flushMutationGroups(), true);
  assert.equal(app.ctx.DB.sales.length, 2);
  assert.equal(app.ctx.DB.singles[0].status, 'Sold');
});

test('review-sales: cart guards pending rows both when adding and when confirming, without changing the form', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single('pending-cart', { qty: 3 })] }) });
  addToCart(app, 'singles', 'pending-cart', '25', 2);
  saleFields(app, { 'cmd-sell-ship': '1.23', 'cmd-sell-buyer': 'Keep this buyer' });
  const row = app.ctx.DB.singles[0];
  // The queue-before-state crash boundary leaves review facts unchanged.
  assert.ok(app.ctx._queueMutationGroup([app.ctx._upsertOperation('singles', { ...row, notes: 'Queued edit' })]));
  const before = recordBefore(app);
  const cartBefore = JSON.stringify(plain(app.ctx.cmdSellCart));
  const messages = [];
  app.ctx.toast = text => messages.push(text);
  app.ctx.cmdConfirmSell();
  assertUnchanged(app, before);
  assert.equal(JSON.stringify(plain(app.ctx.cmdSellCart)), cartBefore);
  assert.equal(app.document.getElementById('cmd-sell-ship').value, '1.23');
  assert.equal(app.document.getElementById('cmd-sell-buyer').value, 'Keep this buyer');
  app.ctx.cmdSellResults = [{ ...plain(row), _table: 'singles' }];
  app.ctx.cmdSellAddToCart(0);
  assert.equal(JSON.stringify(plain(app.ctx.cmdSellCart)), cartBefore, 'adding the same pending lot cannot increase its quantity');
  assert.match(messages.join('\n'), /Sync it before recording another sale/);
});

test('review-sales: Quick Sell still uses the agreed highest-cost matching single', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single('cheap', { costPrice: 5 }), single('costly', { costPrice: 15 })] }) });
  await app.ctx.markStatus('singles', 'cheap', 'Sold');
  assert.equal(app.document.getElementById('qs-id').value, 'costly');
  fill(app, { 'qs-total': '25', 'qs-date': '2026-10-03' });
  app.ctx.confirmQuickSell();
  assert.equal(app.ctx.DB.sales[0].inventoryId, 'costly');
  assert.equal(app.ctx.DB.sales[0].costPrice, 15);
  assert.equal(app.ctx.DB.singles.find(row => row.id === 'cheap').status, 'Available');
});

test('review-sales: invalid cart money never becomes an implicit zero or a partial sale', async () => {
  const app = await loadApp({ seed: makeSeed({ slabs: [slab('money-a'), slab('money-b')] }) });
  addToCart(app, 'slabs', 'money-a');
  addToCart(app, 'slabs', 'money-b');
  const cases = [
    ['price', '-5'], ['price', 'Infinity'], ['price', 'NaN'], ['price', '1e309'],
    ['price', '25x'], ['price', ''], ['price', '0.001'], ['price', '1e100'],
    ['cmd-sell-ship', '-10'], ['cmd-sell-ship', 'Infinity'], ['cmd-sell-ship', '2oops'],
    ['cmd-sell-fees', '-1'], ['cmd-sell-fees', 'NaN'], ['cmd-sell-fees', '1e309'],
    ['cmd-sell-fees', '0.001'],
  ];
  for (const [field, value] of cases) {
    saleFields(app);
    app.ctx.cmdSellSetPrice('money-a', field === 'price' ? value : '25');
    if (field !== 'price') fill(app, { [field]: value });
    const before = recordBefore(app);
    app.ctx.cmdConfirmSell();
    assertUnchanged(app, before);
  }
  saleFields(app, { 'cmd-sell-ship': '', 'cmd-sell-fees': '' });
  app.ctx.cmdSellSetPrice('money-a', '0');
  app.ctx.cmdSellSetPrice('money-b', '0');
  app.ctx.cmdConfirmSell();
  assert.equal(app.ctx.DB.sales.length, 2);
  assert.ok(app.ctx.DB.sales.every(row => row.totalCollected === 0 && row.shippingCost === 0 && row.fees === 0));
});

for (const [label, mutate] of [
  ['sold row', app => { app.ctx.DB.slabs[1].status = 'Sold'; }],
  ['removed row', app => { app.ctx.DB.slabs.pop(); }],
  ['cost edit', app => { app.ctx.DB.slabs[1].costPrice = 42; }],
  ['new revision', app => { app.ctx.DB.slabs[1]._serverVersion++; }],
  ['Dealer Desk ownership', app => { app.ctx.DB.slabs[1].dealerCopyId = 'synthetic-copy'; }],
]) {
  test('review-sales: cart stops the whole transaction after ' + label, async () => {
    const app = await loadApp({ seed: makeSeed({ slabs: [slab('cart-a'), slab('cart-b')] }) });
    addToCart(app, 'slabs', 'cart-a', '30');
    addToCart(app, 'slabs', 'cart-b', '40');
    saleFields(app, { 'cmd-sell-ship': '6' });
    mutate(app);
    const before = recordBefore(app);
    const messages = [];
    app.ctx.toast = text => messages.push(text);
    app.ctx.cmdConfirmSell();
    assertUnchanged(app, before);
    assert.equal(app.ctx.DB.sales.length, 0);
    assert.match(messages.join('\n'), /Inventory changed/);
  });
}

test('review-sales: changed pack quantity and changed grouped-single membership require another review', async () => {
  const packs = await loadApp({ seed: makeSeed({ boosterPacks: [{ id: 'pack-lot', product: 'Synthetic pack',
    qty: 3, unitPrice: 5, status: 'Sealed', _serverVersion: 1 }] }) });
  addToCart(packs, 'boosterPacks', 'pack-lot', '10', 3);
  saleFields(packs);
  packs.ctx.DB.boosterPacks[0].qty = 2;
  const packBefore = recordBefore(packs);
  packs.ctx.cmdConfirmSell();
  assertUnchanged(packs, packBefore);

  const cards = await loadApp({ seed: makeSeed({ singles: [single('lot-a'), single('lot-b')] }) });
  addToCart(cards, 'singles', 'lot-a', '25', 2);
  saleFields(cards);
  cards.ctx.DB.singles[1] = { ...cards.ctx.DB.singles[1], id: 'replacement-physical-copy' };
  const cardBefore = recordBefore(cards);
  cards.ctx.cmdConfirmSell();
  assertUnchanged(cards, cardBefore);
});

test('review-sales: unchanged mixed cart preserves HIFO cost, physical links, exact quantities and one atomic group', async () => {
  const app = await loadApp({ seed: makeSeed({
    singles: [single('lot-low', { qty: 2, costPrice: 5 }), single('lot-high', { costPrice: 15 })],
    slabs: [slab('mixed-slab')],
    etbs: [{ id: 'mixed-etb', product: 'Synthetic ETB', totalPrice: 30, status: 'In Stock', _serverVersion: 3 }],
    boosterBoxes: [{ id: 'mixed-box', product: 'Synthetic box', totalPrice: 50, status: 'Unopened', _serverVersion: 4 }],
    boosterPacks: [{ id: 'mixed-pack', product: 'Synthetic pack', unitPrice: 5, qty: 3, status: 'Sealed', _serverVersion: 2 }],
  }) });
  addToCart(app, 'singles', 'lot-low', '25', 2);
  addToCart(app, 'slabs', 'mixed-slab', '30');
  addToCart(app, 'etbs', 'mixed-etb', '45');
  addToCart(app, 'boosterBoxes', 'mixed-box', '80');
  addToCart(app, 'boosterPacks', 'mixed-pack', '10', 2);
  saleFields(app, { 'cmd-sell-ship': '0.07', 'cmd-sell-fees': '0.03' });
  app.ctx.cmdConfirmSell();
  const sales = plain(app.ctx.DB.sales);
  assert.equal(sales.length, 7);
  assert.deepEqual(sales.filter(row => row.inventoryTable === 'singles').map(row => [row.inventoryId, row.costPrice]),
    [['lot-high', 15], ['lot-low', 5]]);
  assert.equal(app.ctx.DB.singles.find(row => row.id === 'lot-low').qty, 1);
  assert.equal(app.ctx.DB.singles.find(row => row.id === 'lot-high').status, 'Sold');
  assert.equal(app.ctx.DB.boosterPacks[0].qty, 1);
  assert.equal(app.ctx.DB.slabs[0].status, 'Sold');
  assert.equal(app.ctx.DB.etbs[0].status, 'Sold');
  assert.equal(app.ctx.DB.boosterBoxes[0].status, 'Sold');
  assert.equal(sales.reduce((total, row) => total + Math.round(row.shippingCost * 100), 0), 7);
  assert.equal(sales.reduce((total, row) => total + Math.round(row.fees * 100), 0), 3);
  const groups = plain(app.ctx._readMutationGroups());
  assert.equal(groups.length, 1);
  assert.equal(new Set(groups[0].operations.map(op => op.table + '/' + op.id)).size, groups[0].operations.length);
  app.fetchMock.route('/sync/v2/mutate', (_url, options) => syncSuccessResponse(options));
  assert.equal(await app.ctx._flushMutationGroups(), true);
  assert.equal(app.ctx._readMutationGroups().length, 0);
});

test('review-sales: four equal-price units never get negative penny allocations', async () => {
  for (const unitPrice of ['1', '0']) {
    const rows = Array.from({ length: 4 }, (_, index) => slab('round-' + index, { costPrice: 0 }));
    const app = await loadApp({ seed: makeSeed({ slabs: rows }) });
    rows.forEach(row => addToCart(app, 'slabs', row.id, unitPrice));
    saleFields(app, { 'cmd-sell-ship': '0.02', 'cmd-sell-fees': '0.02' });
    app.ctx.cmdConfirmSell();
    const sales = plain(app.ctx.DB.sales);
    assert.equal(sales.length, 4);
    assert.deepEqual(sales.map(row => row.shippingCost), [0.01, 0.01, 0, 0]);
    assert.deepEqual(sales.map(row => row.fees), [0.01, 0.01, 0, 0]);
    assert.ok(sales.every(row => row.shippingCost >= 0 && row.fees >= 0));
  }
});

test('review-sales: cent allocator conserves total and proportional shares across varied carts', async () => {
  const app = await loadApp();
  for (let count = 1; count <= 20; count++) {
    for (const total of [0, 1, 2, 7, 19, 100, 10001]) {
      const weights = Array.from({ length: count }, (_, index) => (index * 17 + count) % 23);
      const allocated = plain(app.ctx._cmdAllocateSaleCents(total, weights));
      assert.equal(allocated.reduce((sum, part) => sum + part, 0), total);
      assert.ok(allocated.every(part => Number.isInteger(part) && part >= 0));
      const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
      allocated.forEach((part, index) => {
        const exact = weightSum > 0 ? total * weights[index] / weightSum : total / count;
        assert.ok(Math.abs(part - exact) < 1.0000001, 'every allocation is within one cent of its exact share');
      });
    }
  }
});
