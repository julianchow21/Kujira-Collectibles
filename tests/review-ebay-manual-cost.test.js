'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');
const preview = { hostname: 'localhost', protocol: 'http:' };

async function exportEbayCsv(app) {
  let downloaded;
  const originalUrl = app.ctx.URL;
  app.ctx.URL = {
    createObjectURL(blob) { downloaded = blob; return 'blob:synthetic-export'; },
    revokeObjectURL() {},
  };
  try { app.ctx.kjrExportCsv('ebayPurchases'); }
  finally { app.ctx.URL = originalUrl; }
  assert.ok(downloaded instanceof Blob, 'the actual CSV exporter creates its download');
  return downloaded.text();
}

async function replaceFromCsv(app, csv) {
  app.ctx.kjrConfirm = async () => true;
  app.document.getElementById('import-type').value = 'ebay_purchases';
  app.document.getElementById('import-mode').value = 'replace';
  app.document.getElementById('import-data').value = csv;
  await app.ctx.importData();
}

for (const [manual, amount] of [[true,40], [true,0], [false,17.7]]) {
  test('eBay CSV round trip retains manual=' + manual + ', total=' + amount + ' through unchanged freight edit', async () => {
    const source = { id: 'ebay-cost-copy', product: 'Synthetic, "quoted" purchase', status: 'Ordered',
      priceUsd: 10, freightSgd: 5, totalSgd: amount, totalSgdManual: manual };
    const app = await loadApp({ seed: { ebayPurchases: [source] }, location: preview });
    app.ctx._sgdRate = 1.27;
    const csv = await exportEbayCsv(app);
    assert.match(csv.split('\r\n')[0], /totalSgdManual/);
    await replaceFromCsv(app, csv);
    const imported = app.ctx.DB.ebayPurchases[0];
    assert.equal(imported.id, source.id);
    assert.equal(imported.product, source.product);
    assert.equal(imported.totalSgdManual, manual);
    assert.equal(typeof imported.totalSgdManual, 'boolean');
    assert.equal(imported.totalSgd, amount);

    app.ctx.kjrEbayInlineEdit(imported.id, 'freightSgd', '5');
    assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, amount);
    app.ctx.kjrEbayInlineEdit(imported.id, 'freightSgd', '6');
    assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, manual ? amount : 18.7,
      'false remains automatic rather than a truthy string');
  });
}

test('legacy eBay CSV without a manual flag still imports without inventing one', async () => {
  const app = await loadApp({ location: preview });
  await replaceFromCsv(app, 'product,priceUsd,freightSgd,totalSgd\nLegacy purchase,10,5,40');
  assert.equal(app.ctx.DB.ebayPurchases.length, 1);
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, 40);
  assert.equal(Object.hasOwn(app.ctx.DB.ebayPurchases[0], 'totalSgdManual'), false);
});

test('eBay manual flags accept explicit booleans and reject truthy-looking or arbitrary values', async () => {
  const app = await loadApp({ location: preview });
  await replaceFromCsv(app, [
    'product,totalSgd,totalSgdManual,_serverVersion,__proto__',
    'Manual,40,TRUE,999,unsafe',
    'Auto,17.7,False,999,unsafe',
    'Unspecified,40,,,',
    'Whitespace,40," ",,',
    'Numeric one,40,1,,',
    'Numeric zero,40,0,,',
    'Truthy text,40,yes,,',
    'Null text,40,null,,',
  ].join('\n'));
  const rows = app.ctx.DB.ebayPurchases;
  assert.equal(rows.length, 4);
  assert.equal(rows.find(row => row.product === 'Manual').totalSgdManual, true);
  assert.equal(rows.find(row => row.product === 'Auto').totalSgdManual, false);
  assert.equal(Object.hasOwn(rows.find(row => row.product === 'Unspecified'), 'totalSgdManual'), false);
  assert.equal(Object.hasOwn(rows.find(row => row.product === 'Whitespace'), 'totalSgdManual'), false);
  for (const row of rows) {
    assert.equal(Object.hasOwn(row, '_serverVersion'), false);
    assert.equal(Object.hasOwn(row, '__proto__'), false);
  }
  assert.match(app.document.getElementById('import-result').innerHTML, /4 skipped/);
  assert.match(app.document.getElementById('import-result').innerHTML, /Manual SGD total must be true or false/);
});

test('invalid boolean-only Replace leaves the prior eBay inventory intact', async () => {
  const source = { id: 'keep-cost', product: 'Keep manual cost', totalSgd: 40, totalSgdManual: true };
  const app = await loadApp({ seed: { ebayPurchases: [source] }, location: preview });
  const before = app.localStorage.getItem('pokeinventory_v3');
  await replaceFromCsv(app, 'product,totalSgdManual\nInvalid override,yes');
  assert.equal(app.ctx.DB.ebayPurchases.length, 1);
  assert.equal(app.ctx.DB.ebayPurchases[0].id, 'keep-cost');
  assert.equal(app.ctx.DB.ebayPurchases[0].totalSgd, 40);
  assert.equal(app.localStorage.getItem('pokeinventory_v3'), before);
});
