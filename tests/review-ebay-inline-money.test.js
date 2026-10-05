'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeSeed, plain } = require('./harness.js');

const purchase = extra => ({
  id: 'inline-money', product: 'Synthetic eBay purchase', status: 'Paid',
  date: '1 Oct 2026', priceUsd: 10, freightSgd: 5, totalSgd: 17.7,
  totalSgdManual: false, targetTable: 'singles', lastUpdated: 1, _serverVersion: 3,
  ...extra,
});

async function setup(extra) {
  const app = await loadApp({ seed: makeSeed({ ebayPurchases: [purchase(extra)] }) });
  app.ctx._sgdRate = 1.27;
  const messages = [];
  app.ctx.toast = message => messages.push(String(message));
  return { ...app, messages };
}

function capture(app) {
  const dirty = {}, revisions = {};
  for (const key of Object.keys(app.ctx._dirty)) {
    dirty[key] = [...app.ctx._dirty[key]].sort();
    revisions[key] = [...app.ctx._dirtyRevisions[key]].sort();
  }
  const markers = [];
  for (let index = 0; index < app.localStorage.length; index++) {
    const key = app.localStorage.key(index);
    if (key.startsWith('pokeinv_dirty_v2:')) markers.push([key, app.localStorage.getItem(key)]);
  }
  return {
    db: JSON.stringify(plain(app.ctx.DB)),
    cache: app.localStorage.getItem('pokeinventory_v3'),
    dirty, revisions, markers: markers.sort(),
    dirtyRaw: app.localStorage.getItem(app.ctx.DIRTY_LS_KEY),
    undo: JSON.stringify(plain(app.ctx.undoStack)),
    redo: JSON.stringify(plain(app.ctx.redoStack)),
  };
}

function assertUnchanged(app, before) {
  assert.deepEqual(capture(app), before, 'DB, cache, dirty markers/revisions, Undo and Redo retain their exact prior state');
}

test('eBay inline money rejects negative, partial and non-finite inputs before changing any state', async () => {
  const app = await setup();
  const before = capture(app);
  for (const field of ['freightSgd', 'priceUsd', 'totalSgd']) {
    for (const value of ['-1', '-0.01', '12oops', 'Infinity', 'NaN', '1e309', '--2', '2.5.4']) {
      assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', field, value), false, field + '=' + value);
      assertUnchanged(app, before);
    }
  }
  assert.equal(app.messages.length, 24);
  assert.ok(app.messages.every(message => /finite number at or above 0/.test(message)));
});

test('eBay inline freight preserves explicit zero and computes a zero total when appropriate', async () => {
  for (const usd of [10, 0]) {
    const app = await setup({ priceUsd: usd, totalSgd: usd * 1.27 + 5 });
    assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'freightSgd', '0'), true);
    const row = app.ctx.DB.ebayPurchases[0];
    assert.equal(row.freightSgd, 0);
    assert.equal(row.totalSgd, usd * 1.27);
    assert.equal(row.totalSgdManual, false);
    assert.equal(app.ctx.undoStack.length, 1);
    assert.equal(app.ctx._dirty.ebayPurchases.has(row.id), true);
    assert.equal(JSON.parse(app.localStorage.getItem('pokeinventory_v3')).ebayPurchases[0].freightSgd, 0);
    assert.equal(row._serverVersion, 3);
  }
});

test('eBay inline freight accepts a complete currency-formatted amount through the shared parser', async () => {
  const app = await setup();
  assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'freightSgd', 'SGD 1,234.50'), true);
  assert.equal(app.ctx.DB.ebayPurchases[0].freightSgd, 1234.5);
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, 1247.2);
});

test('eBay inline blank freight clears the optional field without replacing the existing total', async () => {
  for (const blank of ['', '   ']) {
    const app = await setup();
    assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'freightSgd', blank), true);
    assert.equal(app.ctx.DB.ebayPurchases[0].freightSgd, '');
    assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, 17.7);
    assert.equal(app.ctx.DB.ebayPurchases[0].totalSgdManual, false);
  }
});

test('eBay inline freight retains manual totals, including an explicit zero override', async () => {
  const app = await setup({ totalSgdManual: true, totalSgd: 99.25 });
  assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'freightSgd', '12'), true);
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, 99.25);
  assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'totalSgd', '0'), true);
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgdManual, true);
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, 0);
  assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'freightSgd', '20'), true);
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, 0);
  assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'totalSgd', ''), true);
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, '');
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgdManual, true, 'clearing a manual total retains the existing override behavior');
});

test('eBay inline freight rejects a non-finite computed total before mutation', async () => {
  const app = await setup({ priceUsd: 1e308, totalSgd: 17.7 });
  const before = capture(app);
  assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'freightSgd', '1e308'), false);
  assertUnchanged(app, before);
  assert.match(app.messages.at(-1), /Total SGD must be a finite number/);
});

for (const mode of ['reported save failure', 'inventory cache quota', 'stamp failure after cache write', 'dirty marker write failure']) {
  test('eBay inline edit rolls back ' + mode + ' and preserves an earlier unsynced edit', async () => {
    const app = await setup();
    app.ctx.snapshotForUndo();
    app.ctx.DB.ebayPurchases[0].notes = 'Earlier unsynced edit must survive';
    app.ctx.markDirty('ebayPurchases', 'inline-money');
    assert.equal(app.ctx.saveData(), true);
    const before = capture(app);
    const originalSave = app.ctx.saveData;
    const originalSet = app.localStorage.setItem.bind(app.localStorage);
    if (mode === 'reported save failure') app.ctx.saveData = () => false;
    else app.localStorage.setItem = (key, value) => {
      if ((mode === 'inventory cache quota' && key === 'pokeinventory_v3') ||
          (mode === 'stamp failure after cache write' && key === app.ctx.LS_VERSION_KEY + '_time') ||
          (mode === 'dirty marker write failure' && key.startsWith('pokeinv_dirty_v2:'))) {
        throw new Error('Synthetic ' + mode);
      }
      originalSet(key, value);
    };
    try {
      assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'freightSgd', '22.50'), false);
      assertUnchanged(app, before);
      assert.match(app.messages.at(-1), /could not be saved locally/);
    } finally {
      app.ctx.saveData = originalSave;
      app.localStorage.setItem = originalSet;
    }
  });
}

test('eBay inline edit aborts before mutation if a rollback snapshot cannot be captured', async () => {
  const app = await setup();
  const before = capture(app);
  app.ctx._captureModalSaveState = () => null;
  assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'freightSgd', '20'), false);
  assertUnchanged(app, before);
  assert.match(app.messages.at(-1), /could not be saved safely/);
});

test('eBay inline money refuses unsupported fields and retains the Dealer write guard', async () => {
  const app = await setup();
  const before = capture(app);
  assert.equal(app.ctx.kjrEbayInlineEdit('inline-money', 'id', '20'), false);
  assertUnchanged(app, before);
  app.ctx.DB.ebayPurchases[0].dealerCandidateId = 'synthetic-dealer-candidate';
  const dealerBefore = capture(app);
  app.ctx.kjrEbayInlineEdit('inline-money', 'freightSgd', '20');
  assertUnchanged(app, dealerBefore);
});
