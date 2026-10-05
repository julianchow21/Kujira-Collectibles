'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain, syncSuccessResponse, syncOperations } = require('./harness.js');

async function importRows(app, type, raw, mode = 'append') {
  app.ctx.kjrConfirm = async () => true;
  app.ctx.document.getElementById('import-type').value = type;
  app.ctx.document.getElementById('import-mode').value = mode;
  app.ctx.document.getElementById('import-data').value = raw;
  await app.ctx.importData();
}
function csvExport(app, type) {
  let result;
  app.ctx.dl = (name, content, mime) => { result = { name, content, mime }; };
  app.ctx.exportCSV(type);
  return result.content;
}
const preview = { hostname: 'localhost', protocol: 'http:' };

test('CSV/TSV round trip preserves quotes, separators, line breaks, Unicode, spaces and zero', async () => {
  const app = await loadApp();
  const rows = [['name','notes','costPrice'], ['カード, "quoted"',' first\nsecond\r\nthird\tfourth ',0]];
  for (const separator of [',','\t']) {
    const encoded = app.ctx.kjrEncodeDelimited(rows, separator);
    assert.match(encoded, /""quoted""/);
    const parsed = plain(app.ctx.kjrParseDelimitedTable('\uFEFF' + encoded));
    assert.deepEqual(parsed.headers, ['name','notes','costprice']);
    assert.deepEqual(parsed.rows, [[rows[1][0],rows[1][1],'0']]);
  }
});

test('direct CSV import ignores arbitrary/internal columns and does not adopt an unsafe append ID', async () => {
  const app = await loadApp({ seed: { singles: [] }, location: preview });
  await importRows(app, 'singles', 'id,name,costPrice,marketPrice,notes,__proto__,constructor,_serverVersion,listingState\r\n"bad\'id",Card,0,0,"a, \"\"quote\"\"\nline",unsafe,unsafe,999,unsafe');
  assert.equal(app.ctx.DB.singles.length, 1);
  const row = app.ctx.DB.singles[0];
  assert.match(row.id, /^s_/);
  assert.notEqual(row.id, "bad'id");
  assert.equal(row.notes, 'a, "quote"\nline');
  assert.equal(row.costPrice, 0);
  assert.equal(row.marketPrice, '0');
  for (const key of ['__proto__','constructor','_serverVersion','listingState']) assert.equal(Object.hasOwn(row, key), false, key);
});

test('repeat append creates unique physical IDs and unique CAS targets', async () => {
  const app = await loadApp({ seed: { singles: [{ id: 'source-copy', name: 'Original', status: 'Available', _serverVersion: 3 }] } });
  app.fetchMock.route('/sync/v2/mutate', (_url, options) => syncSuccessResponse(options));
  const data = 'id\tname\tcostPrice\nsource-copy\tCopy A\t10\nsource-copy\tCopy B\t20';
  await importRows(app, 'singles', data);
  await importRows(app, 'singles', data);
  assert.equal(app.ctx.DB.singles.length, 5);
  assert.equal(new Set(app.ctx.DB.singles.map(row => row.id)).size, 5);
  const operations = syncOperations(app.fetchMock).filter(op => op.table === 'singles');
  assert.equal(operations.length, 4);
  assert.equal(new Set(operations.map(op => op.id)).size, 4);
  assert.ok(operations.every(op => op.id !== 'source-copy' && op.expected_version === 0));
});

for (const [label, input] of [
  ['duplicate IDs', 'id\tname\ncopied-id\tOne\ncopied-id\tTwo'],
  ['unsafe ID', 'id\tname\ninvalid\'id\tOne'],
  ['duplicate aliases', 'id\tname\tcost\tcostPrice\nnew-id\tOne\t10\t20'],
  ['malformed quotes', 'id,name\nnew-id,"unfinished'],
  ['unquoted extra columns', 'name,costPrice,marketPrice\nCard,1,200,50'],
]) {
  test('Replace rejects ' + label + ' before any inventory or recovery write', async () => {
    const existing = { id: 'keep', name: 'Keep original', status: 'Available', costPrice: 12 };
    const app = await loadApp({ seed: { singles: [existing] } });
    const cache = app.localStorage.getItem('pokeinventory_v3');
    const messages = [];
    app.ctx.toastError = message => messages.push(message);
    app.fetchMock.calls.length = 0;
    await importRows(app, 'singles', input, 'replace');
    assert.deepEqual(plain(app.ctx.DB.singles), [existing]);
    assert.equal(app.localStorage.getItem('pokeinventory_v3'), cache);
    assert.equal(syncOperations(app.fetchMock).length, 0);
    assert.match(messages.join('\n'), /Import stopped/);
  });
}

test('Replace retains current CAS revision and ignores pasted internal revision', async () => {
  const app = await loadApp({ seed: { singles: [{ id: 'same-copy', name: 'Before', costPrice: 10, status: 'Available', _serverVersion: 7 }] } });
  app.fetchMock.route('/sync/v2/mutate', (_url, options) => syncSuccessResponse(options));
  await importRows(app, 'singles', 'id\tname\tcostPrice\t_serverVersion\nsame-copy\tAfter\t12\t999', 'replace');
  const operation = syncOperations(app.fetchMock).find(op => op.table === 'singles');
  assert.equal(operation.type, 'upsert');
  assert.equal(operation.id, 'same-copy');
  assert.equal(operation.expected_version, 7);
  assert.equal(operation.data.costPrice, 12);
  assert.equal(app.ctx.DB.singles[0]._serverVersion, 8);
});

test('sales CSV retains fees, links, channel and holding period; unchanged edit keeps profit', async () => {
  const sale = { id: 'sold-copy', dateSold: '2 Jan 2026', product: 'Synthetic "rare", card', buyer: 'Test',
    costPrice: 10, totalCollected: 30, shippingCost: 2, fees: 5, profit: 13, margin: '43%',
    inventoryId: 'physical-copy', inventoryTable: 'singles', channel: 'eBay', dateAcquired: '2 Jan 2026', daysHeld: 0 };
  const app = await loadApp({ seed: { singles: [], sales: [sale] }, location: preview });
  await importRows(app, 'sales', csvExport(app, 'sales'), 'replace');
  const row = app.ctx.DB.sales[0];
  for (const [key,value] of Object.entries(sale)) assert.equal(row[key], value, key);
  app.ctx.openEditSale(row.id);
  await app.ctx.saveSale();
  assert.equal(app.ctx.DB.sales[0].profit, 13);
  assert.equal(app.ctx.DB.sales[0].fees, 5);
  assert.equal(app.ctx.DB.sales[0].daysHeld, 0);
  assert.equal(app.ctx.DB.sales[0].inventoryId, 'physical-copy');
});

test('inventory CSV retains alerts, listing URLs, acquisition date and zeros, excluding tracker metadata', async () => {
  for (const type of ['singles','slabs']) {
    const original = { id: 'physical_' + type, name: 'Card', qty: 1, status: 'Available',
      costPrice: 0, listPrice: 0, marketPrice: '0', priceAlert: 0, datePurchased: '1 Jan 2026',
      ebayUrl: 'https://example.invalid/ebay?a=1,b=2', carousellUrl: 'https://example.invalid/carousell',
      tcgdexId: 'base1-4', notes: 'First\n"second"', listingState: 'private workflow metadata' };
    const app = await loadApp({ seed: { singles: [], slabs: [], [type]: [original] }, location: preview });
    const csv = csvExport(app, type);
    assert.equal(csv.includes('listingState'), false);
    assert.equal(csv.includes('private workflow metadata'), false);
    await importRows(app, type, csv, 'replace');
    for (const key of ['id','costPrice','listPrice','marketPrice','priceAlert','datePurchased','ebayUrl','carousellUrl','tcgdexId','notes']) assert.equal(app.ctx.DB[type][0][key], original[key], type + '.' + key);
  }
});

test('sealed CSV uses shared parser, canonical financial fields and fresh append IDs', async () => {
  const app = await loadApp({ seed: { boosterPacks: [] }, location: preview });
  const csv = 'id,product,qty,unitPrice,totalPrice,marketPrice,notes\r\nold-id,"Pack, \"\"special\"\"",2,0,0,0,"line 1\nline 2"';
  await importRows(app, 'booster_packs', csv);
  await importRows(app, 'booster_packs', csv);
  assert.equal(app.ctx.DB.boosterPacks.length, 2);
  const row = app.ctx.DB.boosterPacks[0];
  assert.equal(row.product, 'Pack, "special"');
  assert.equal(row.notes, 'line 1\nline 2');
  assert.equal(row.marketPrice, 0);
  assert.equal(row.unitPrice, 0);
  assert.notEqual(row.id, 'old-id');
  assert.notEqual(row.id, app.ctx.DB.boosterPacks[1].id);
});

test('sales rejects invalid holding periods and non-finite fees with row reasons', async () => {
  const app = await loadApp({ seed: { sales: [] }, location: preview });
  await importRows(app, 'sales', 'product,fees,daysHeld\nBad fee,1e309,1\nBad days,0,-1\nFraction days,0,1.5\nValid zero,0,0');
  assert.equal(app.ctx.DB.sales.length, 1);
  assert.equal(app.ctx.DB.sales[0].fees, 0);
  assert.equal(app.ctx.DB.sales[0].daysHeld, 0);
  assert.match(app.ctx.document.getElementById('import-result').innerHTML, /3 skipped/);
});

for (const type of ['singles','etbs']) {
  for (const change of ['memory','cache','preflight']) {
    test(type + ' Replace stops if reviewed data changes in ' + change, async () => {
      const old = type === 'singles' ? { id: 'reviewed', name: 'Original' } : { id: 'reviewed', product: 'Original' };
      const app = await loadApp({ seed: { [type]: [old] } });
      const peer = { ...old, notes: 'Peer edit retained' };
      const applyPeer = () => {
        if (change !== 'cache') app.ctx.DB[type][0] = peer;
        const cache = JSON.parse(app.localStorage.getItem('pokeinventory_v3'));
        cache[type][0] = peer;
        app.localStorage.setItem('pokeinventory_v3', JSON.stringify(cache));
      };
      app.ctx.kjrConfirm = async () => { if (change !== 'preflight') applyPeer(); return true; };
      if (change === 'preflight') {
        const queue = app.ctx._queueDeleteStateOp;
        app.ctx._queueDeleteStateOp = operation => { applyPeer(); return queue(operation); };
      }
      app.document.getElementById('import-type').value = type;
      app.document.getElementById('import-mode').value = 'replace';
      app.document.getElementById('import-data').value = 'id\t' + (type === 'singles' ? 'name' : 'product') + '\nreviewed\tReplacement';
      const messages = [];
      app.ctx.toastError = message => messages.push(message);
      await app.ctx.importData();
      assert.equal(app.ctx.DB[type][0][type === 'singles' ? 'name' : 'product'], 'Original');
      assert.equal(JSON.parse(app.localStorage.getItem('pokeinventory_v3'))[type][0].notes, peer.notes);
      assert.equal(app.ctx._readDeleteState().state.pending.length, 0);
      assert.equal(syncOperations(app.fetchMock).length, 0);
      assert.ok(messages.some(message => /changed|review/i.test(message)));
    });
  }
}

test('Replace cannot overwrite an unresolved sale transaction', async () => {
  const app = await loadApp({ seed: { singles: [], slabs: [{ id: 'pending-copy', name: 'Pending sale copy', costPrice: 10, status: 'Available', _serverVersion: 1 }] } });
  await app.ctx.markStatus('slabs', 'pending-copy', 'Sold');
  for (const [key,value] of Object.entries({ 'qs-total': '25', 'qs-cost': '10', 'qs-date': '2026-10-03' })) app.document.getElementById(key).value = value;
  await app.ctx.confirmQuickSell();
  const group = JSON.stringify(app.ctx._readMutationGroups());
  const before = plain(app.ctx.DB.slabs);
  await importRows(app, 'slabs', 'id\tname\tstatus\npending-copy\tReplacement\tAvailable', 'replace');
  assert.deepEqual(plain(app.ctx.DB.slabs), before);
  assert.equal(JSON.stringify(app.ctx._readMutationGroups()), group);
  assert.equal(app.ctx.DB.sales.length, 1);
});

test('Replace stops tombstoned IDs instead of emitting an ordinary upsert', async () => {
  const app = await loadApp({ seed: { singles: [] } });
  app.ctx._serverTombstones.push({ table: 'singles', id: 'deleted-copy', row_version: 2, deleted_at: '2026-10-03T00:00:00Z' });
  const messages = [];
  app.ctx.toastError = message => messages.push(message);
  await importRows(app, 'singles', 'id\tname\ndeleted-copy\tMust restore from Trash', 'replace');
  assert.equal(app.ctx.DB.singles.length, 0);
  assert.equal(syncOperations(app.fetchMock).length, 0);
  assert.ok(messages.some(message => /Trash.*first/.test(message)));
});

for (const type of ['singles','etbs']) {
  test(type + ' Replace preserves a peer addition delivered after the synchronous commit', async () => {
    const field = type === 'singles' ? 'name' : 'product';
    const app = await loadApp({ seed: { [type]: [{ id: 'reviewed', [field]: 'Original' }] } });
    let inserted = false;
    const queue = app.ctx._queueDeleteStateOp;
    app.ctx._queueDeleteStateOp = async operation => {
      const outcome = await queue(operation);
      if (!inserted && app.ctx.DB[type][0]?.[field] === 'Replacement') {
        inserted = true;
        const oldValue = app.localStorage.getItem('pokeinventory_v3');
        const next = JSON.parse(oldValue);
        next[type].push({ id: 'peer-copy', [field]: 'Peer addition', _updatedAt: '2099-01-01T00:00:00Z' });
        const newValue = JSON.stringify(next);
        app.localStorage.setItem('pokeinventory_v3', newValue);
        app.ctx.dispatchEvent({ type: 'storage', key: 'pokeinventory_v3', oldValue, newValue });
      }
      return outcome;
    };
    await importRows(app, type, 'id\t' + field + '\nreviewed\tReplacement', 'replace');
    assert.equal(inserted, true);
    assert.equal(app.ctx.DB[type].find(row => row.id === 'peer-copy')?.[field], 'Peer addition');
    assert.equal(JSON.parse(app.localStorage.getItem('pokeinventory_v3'))[type].find(row => row.id === 'peer-copy')?.[field], 'Peer addition');
  });

  test(type + ' Replace rolls back inventory, dirty state and recovery markers on cache write failure', async () => {
    const field = type === 'singles' ? 'name' : 'product';
    const original = { id: 'old-copy', [field]: 'Original' };
    const app = await loadApp({ seed: { [type]: [original] } });
    const cache = app.localStorage.getItem('pokeinventory_v3');
    const trash = app.localStorage.getItem('_kjrPendingTrashWrites');
    const dirtyKey = app.ctx.DIRTY_LS_KEY;
    const dirty = app.localStorage.getItem(dirtyKey);
    const write = app.localStorage.setItem.bind(app.localStorage);
    app.localStorage.setItem = (key, value) => {
      if (key === 'pokeinventory_v3' && String(value).includes('Replacement')) throw new Error('synthetic quota failure');
      return write(key, value);
    };
    await importRows(app, type, 'id\t' + field + '\nnew-copy\tReplacement', 'replace');
    assert.deepEqual(plain(app.ctx.DB[type]), [original]);
    assert.equal(app.localStorage.getItem('pokeinventory_v3'), cache);
    assert.equal(app.localStorage.getItem('_kjrPendingTrashWrites'), trash);
    assert.equal(app.localStorage.getItem(dirtyKey), dirty);
    assert.equal(app.ctx._dirty[type].has('new-copy'), false);
    assert.equal(app.ctx._readDeleteState().state.pending.length, 0);
    assert.equal(syncOperations(app.fetchMock).length, 0);
  });
}
