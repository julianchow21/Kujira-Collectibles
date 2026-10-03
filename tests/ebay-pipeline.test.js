'use strict';
// Suite 17: ebay-pipeline (features.js) - kjrEbayComputeSgd, kjrDetectTargetTable,
// kjrParseMultiItemProduct, kjrIsActiveStatus, KJR_EBAY_PIPELINE/kjrEbayAdvance.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

function modalField(key, value) {
  return { dataset: { k: key }, value: String(value == null ? '' : value) };
}

function installModalFields(document, values) {
  const fields = Object.entries(values).map(([key, value]) => modalField(key, value));
  const originalQuerySelectorAll = document.querySelectorAll;
  document.querySelectorAll = selector => selector === '#kjr-modal-fields [data-k]'
    ? fields
    : originalQuerySelectorAll(selector);
  return () => { document.querySelectorAll = originalQuerySelectorAll; };
}

test('ebay-pipeline: kjrEbayComputeSgd - priceUsd*rate+freight, no override', async () => {
  const { ctx } = await loadApp();
  ctx._sgdRate = 1.35;
  const r = plain(ctx.kjrEbayComputeSgd(100, 5, ''));
  assert.strictEqual(r.computed, 140);
  assert.strictEqual(r.used, 140);
  assert.strictEqual(r.overridden, false);
  assert.strictEqual(r.rate, 1.35);
});

test('ebay-pipeline: kjrEbayComputeSgd - an explicit override wins over the computed value, but "computed" is still reported', async () => {
  const { ctx } = await loadApp();
  ctx._sgdRate = 1.35;
  const r = plain(ctx.kjrEbayComputeSgd(100, 5, '999'));
  assert.strictEqual(r.computed, 140, 'the auto-computed figure is still returned for comparison/audit');
  assert.strictEqual(r.used, 999, 'but "used" (what the row actually stores) is the override');
  assert.strictEqual(r.overridden, true);
});

test('ebay-pipeline: kjrEbayComputeSgd - falls back to the hardcoded 1.27 rate when _sgdRate is unset', async () => {
  const { ctx } = await loadApp();
  ctx._sgdRate = null;
  const r = plain(ctx.kjrEbayComputeSgd(100, 0, ''));
  assert.strictEqual(r.rate, 1.27);
  assert.strictEqual(r.computed, 127);
});

test('ebay-pipeline: kjrDetectTargetTable - keyword routing (ETB/booster box/booster pack/slab/plain single)', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrDetectTargetTable('Evolving Skies ETB'), 'etbs');
  assert.strictEqual(ctx.kjrDetectTargetTable('Scarlet & Violet booster box'), 'boosterBoxes');
  assert.strictEqual(ctx.kjrDetectTargetTable('Scarlet & Violet booster pack'), 'boosterPacks');
  assert.strictEqual(ctx.kjrDetectTargetTable('PSA 10 Charizard'), 'slabs');
  assert.strictEqual(ctx.kjrDetectTargetTable('Pikachu 25'), 'singles');
  assert.strictEqual(ctx.kjrDetectTargetTable(''), '');
});

test('ebay-pipeline: kjrParseMultiItemProduct - 2+ dollar-amount chunks split into items', async () => {
  const { ctx } = await loadApp();
  const items = plain(ctx.kjrParseMultiItemProduct('Jirachi XY67a $82.95 and Gyarados 21 $20'));
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0].usdPrice, 82.95);
  assert.strictEqual(items[1].usdPrice, 20);
  assert.match(items[0].name, /Jirachi/);
  assert.match(items[1].name, /Gyarados/);
});

test('ebay-pipeline: kjrParseMultiItemProduct - a single item returns an EMPTY ARRAY, not null', async () => {
  const { ctx } = await loadApp();
  // Characterisation note: the packet's own wording expected null for the
  // single-item case; the actual early-return value is [].
  assert.deepStrictEqual(plain(ctx.kjrParseMultiItemProduct('Charizard $50')), []);
  assert.deepStrictEqual(plain(ctx.kjrParseMultiItemProduct('')), []);
});

test('ebay-pipeline: kjrIsActiveStatus - eBay "Received" (exact, legacy) is terminal but "Partially Received" stays active', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrIsActiveStatus('ebayPurchases', 'Received'), false, 'exact legacy "Received" is terminal');
  assert.strictEqual(ctx.kjrIsActiveStatus('ebayPurchases', 'Partially Received'), true, 'the one-word regression this guards against');
  assert.strictEqual(ctx.kjrIsActiveStatus('ebayPurchases', 'Completed'), false);
  assert.strictEqual(ctx.kjrIsActiveStatus('ebayPurchases', 'Cancelled'), false);
  assert.strictEqual(ctx.kjrIsActiveStatus('ebayPurchases', 'Paid'), true);
  assert.strictEqual(ctx.kjrIsActiveStatus('ebayPurchases', 'Shipping to Buyandship'), true);
});

test('ebay-pipeline: kjrIsActiveStatus - etbs/boosterBoxes/boosterPacks use their own status vocab', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrIsActiveStatus('etbs', 'In Stock'), true);
  assert.strictEqual(ctx.kjrIsActiveStatus('etbs', 'Sold'), false);
  assert.strictEqual(ctx.kjrIsActiveStatus('boosterBoxes', 'Unopened Stock'), true);
  assert.strictEqual(ctx.kjrIsActiveStatus('boosterBoxes', 'Reserved'), true);
  assert.strictEqual(ctx.kjrIsActiveStatus('boosterBoxes', 'Sold'), false);
  assert.strictEqual(ctx.kjrIsActiveStatus('boosterPacks', 'Sealed'), true);
});

test('ebay-pipeline: kjrIsActiveStatus - the generic fallback (any other table) treats only sold/traded as inactive', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrIsActiveStatus('singles', 'Available'), true);
  assert.strictEqual(ctx.kjrIsActiveStatus('singles', 'Sold'), false);
  assert.strictEqual(ctx.kjrIsActiveStatus('slabs', 'Traded'), false);
});

test('ebay-pipeline: KJR_EBAY_PIPELINE ordering - kjrEbayNextStatus walks the pipeline, Completed/Cancelled are terminal', async () => {
  const { ctx, grab } = await loadApp();
  const { KJR_EBAY_PIPELINE } = grab('KJR_EBAY_PIPELINE');
  assert.deepStrictEqual(plain(KJR_EBAY_PIPELINE), ['Paid', 'Shipping to Buyandship', 'At Buyandship', 'Ready to Consolidate', 'Shipping to Singapore', 'Completed']);
  assert.strictEqual(ctx.kjrEbayNextStatus('Paid'), 'Shipping to Buyandship');
  assert.strictEqual(ctx.kjrEbayNextStatus('Shipping to Singapore'), 'Completed', 'the final pipeline step advances to Completed');
  assert.strictEqual(ctx.kjrEbayNextStatus('Completed'), null, 'terminal - already at the end');
  assert.strictEqual(ctx.kjrEbayNextStatus('Cancelled'), null, 'Cancelled is not even IN the pipeline array (indexOf -1)');
});

test('ebay-pipeline: kjrEbayAdvance - a non-completing transition mutates the row and marks it dirty', async () => {
  const { ctx, grab } = await loadApp({
    seed: { ebayPurchases: [{ id: 'eb1', product: 'Test', status: 'Paid' }] },
  });
  ctx.kjrEbayAdvance('eb1');
  const { DB, _dirty } = grab('DB', '_dirty');
  const row = DB.ebayPurchases.find((r) => r.id === 'eb1');
  assert.strictEqual(row.status, 'Shipping to Buyandship');
  assert.strictEqual(_dirty.ebayPurchases.has('eb1'), true);
});

test('ebay-pipeline: editing another field keeps an existing blank date blank, while a valid date round-trips through the real modal', async () => {
  const { ctx, document } = await loadApp({
    seed: {
      ebayPurchases: [
        { id: 'eb-blank-date', product: 'Blank date card', status: 'Paid', tracking: 'before', declared: 'No', priceUsd: 10, freightSgd: 1, totalSgd: 13, targetTable: 'singles', date: '' },
        { id: 'eb-missing-date', product: 'Missing date card', status: 'Paid', tracking: 'before', declared: 'No', priceUsd: 10, freightSgd: 1, totalSgd: 13, targetTable: 'singles' },
        { id: 'eb-valid-date', product: 'Dated card', status: 'Paid', tracking: 'before', declared: 'No', priceUsd: 10, freightSgd: 1, totalSgd: 13, targetTable: 'singles', date: '4 Sep 2026' },
      ],
    },
  });

  ctx.kjrOpenEbayModal('eb-blank-date');
  const blankHtml = document.getElementById('kjr-modal-fields').innerHTML;
  assert.match(blankHtml, /data-k="date" type="date" value=""/, 'an existing blank date renders as a blank date input');
  const restoreBlankFields = installModalFields(document, {
    date: '', status: 'Paid', product: 'Blank date card', tracking: 'after', declared: 'No',
    priceUsd: '10', freightSgd: '1', totalSgd: '13', targetTable: 'singles',
  });
  try {
    ctx.kjrSaveModal();
  } finally {
    restoreBlankFields();
  }
  const blankRow = ctx.DB.ebayPurchases.find(row => row.id === 'eb-blank-date');
  assert.equal(blankRow.date, '', 'saving a different field does not invent a date');
  assert.equal(blankRow.tracking, 'after', 'the unrelated edit still saves');

  ctx.kjrOpenEbayModal('eb-missing-date');
  const missingHtml = document.getElementById('kjr-modal-fields').innerHTML;
  assert.match(missingHtml, /data-k="date" type="date" value=""/, 'a missing existing date also renders as a blank date input');
  const restoreMissingFields = installModalFields(document, {
    date: '', status: 'Paid', product: 'Missing date card', tracking: 'after-missing', declared: 'No',
    priceUsd: '10', freightSgd: '1', totalSgd: '13', targetTable: 'singles',
  });
  try {
    ctx.kjrSaveModal();
  } finally {
    restoreMissingFields();
  }
  const missingRow = ctx.DB.ebayPurchases.find(row => row.id === 'eb-missing-date');
  assert.equal(missingRow.date, '', 'saving a different field does not invent a missing date');
  assert.equal(missingRow.tracking, 'after-missing');

  ctx.kjrOpenEbayModal('eb-valid-date');
  const validHtml = document.getElementById('kjr-modal-fields').innerHTML;
  assert.match(validHtml, /data-k="date" type="date" value="2026-09-04"/, 'a valid stored date remains visible in the modal');
  const restoreValidFields = installModalFields(document, {
    date: '2026-09-04', status: 'Paid', product: 'Dated card', tracking: 'after-valid', declared: 'No',
    priceUsd: '10', freightSgd: '1', totalSgd: '13', targetTable: 'singles',
  });
  try {
    ctx.kjrSaveModal();
  } finally {
    restoreValidFields();
  }
  const validRow = ctx.DB.ebayPurchases.find(row => row.id === 'eb-valid-date');
  assert.equal(validRow.date, '4 Sep 2026', 'saving another field preserves the valid stored date');
  assert.equal(validRow.tracking, 'after-valid');
});

test('ebay-pipeline: a new eBay purchase still defaults its date to today', async () => {
  const { ctx, document } = await loadApp();
  ctx.kjrOpenEbayModal();
  const today = new Date().toISOString().slice(0, 10);
  const html = document.getElementById('kjr-modal-fields').innerHTML;
  assert.match(html, new RegExp('data-k="date" type="date" value="' + today + '"'));
});
