'use strict';
// Suite 18: import-parsing (features.js). parsePastedTable/mapFields/normH
// (~136-153) are private closures inside the import-installer IIFE - never
// exposed on window/the module scope (confirmed: window.importData is the
// only thing the IIFE publishes; grep finds zero `window.parsePastedTable`-
// style exports). They are NOT independently unit-callable without
// refactoring features.js, which this round forbids. Tested here indirectly,
// end-to-end, via window.importData() for the 'etbs' schema - this exercises
// parsePastedTable, mapFields, normH and kjrGenId for real, just not by name.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

test('import-parsing: tab-separated happy path - header aliases map correctly, numeric fields coerced, defaults applied', async () => {
  const { ctx, grab } = await loadApp();
  const tsv = [
    'Product\tTotalPrice\tCondition\tDate',
    'Evolving Skies ETB\t150\tMint\t2025-01-15',
    'Brilliant Stars ETB\t120\tSealed\t2025-02-20',
  ].join('\n');
  ctx.document.getElementById('import-data').value = tsv;
  ctx.document.getElementById('import-type').value = 'etbs';
  ctx.document.getElementById('import-mode').value = ''; // add mode (default) - never triggers the replace-mode confirm dialog

  await ctx.importData();

  const { DB } = grab('DB');
  assert.strictEqual(DB.etbs.length, 2);
  const row = DB.etbs.find((r) => r.product === 'Evolving Skies ETB');
  assert.ok(row, 'product header alias mapped correctly');
  assert.strictEqual(row.totalPrice, 150, 'numeric field coerced to a real number, not the string "150"');
  assert.strictEqual(row.condition, 'Mint');
  assert.strictEqual(row.date, '2025-01-15');
  assert.match(row.id, /^etb_/, 'kjrGenId used the schema\'s idPrefix');
  const row2 = DB.etbs.find((r) => r.product === 'Brilliant Stars ETB');
  assert.strictEqual(row2.totalPrice, 120);
});

test('import-parsing: a default is applied when the source column is absent (status defaults to "In Stock")', async () => {
  const { ctx, grab } = await loadApp();
  ctx.document.getElementById('import-data').value = 'Product\tTotalPrice\nSome ETB\t100';
  ctx.document.getElementById('import-type').value = 'etbs';
  ctx.document.getElementById('import-mode').value = '';
  await ctx.importData();
  const { DB } = grab('DB');
  assert.strictEqual(DB.etbs[0].status, 'In Stock', 'schema default fills in when no "status" column was pasted at all');
});

test('import-parsing: fewer than 2 lines (header only, or empty) -> nothing imported', async () => {
  const { ctx, grab } = await loadApp();
  ctx.document.getElementById('import-data').value = 'Product\tTotalPrice'; // header row only, zero data rows
  ctx.document.getElementById('import-type').value = 'etbs';
  ctx.document.getElementById('import-mode').value = '';
  await ctx.importData();
  const { DB } = grab('DB');
  assert.strictEqual(DB.etbs.length, 0, 'parsePastedTable returns null for <2 lines, so importNewType bails before creating anything');
});

test('import-parsing: a ragged row missing the "product" alias entirely is skipped, not imported as a blank row', async () => {
  const { ctx, grab } = await loadApp();
  const tsv = [
    'Product\tTotalPrice\tCondition',
    'Good Row\t100\tMint',
    '\t50\tDamaged', // no product text at all on this row
  ].join('\n');
  ctx.document.getElementById('import-data').value = tsv;
  ctx.document.getElementById('import-type').value = 'etbs';
  ctx.document.getElementById('import-mode').value = '';
  await ctx.importData();
  const { DB } = grab('DB');
  assert.strictEqual(DB.etbs.length, 1, 'only the row with a product name was imported - the productless row was skipped');
  assert.strictEqual(DB.etbs[0].product, 'Good Row');
});

test('import-parsing: a genuinely ragged row (fewer columns than headers) still imports on its present fields', async () => {
  const { ctx, grab } = await loadApp();
  const tsv = [
    'Product\tTotalPrice\tCondition',
    'Short Row\t80', // missing the trailing "Condition" column entirely
  ].join('\n');
  ctx.document.getElementById('import-data').value = tsv;
  ctx.document.getElementById('import-type').value = 'etbs';
  ctx.document.getElementById('import-mode').value = '';
  await ctx.importData();
  const { DB } = grab('DB');
  assert.strictEqual(DB.etbs.length, 1);
  assert.strictEqual(DB.etbs[0].product, 'Short Row');
  assert.strictEqual(DB.etbs[0].totalPrice, 80);
  assert.strictEqual(DB.etbs[0].condition, 'Mint', 'the missing column falls back to the schema default rather than blank/undefined');
});

test('import-parsing: unknown headers are simply ignored (no alias match -> that column is dropped)', async () => {
  const { ctx, grab } = await loadApp();
  const tsv = [
    'Product\tRandomJunkColumn\tTotalPrice',
    'Some ETB\twhatever\t99',
  ].join('\n');
  ctx.document.getElementById('import-data').value = tsv;
  ctx.document.getElementById('import-type').value = 'etbs';
  ctx.document.getElementById('import-mode').value = '';
  await ctx.importData();
  const { DB } = grab('DB');
  const row = DB.etbs[0];
  assert.strictEqual(row.totalPrice, 99);
  assert.ok(!Object.values(row).includes('whatever'), 'the unrecognised column\'s value never lands anywhere on the row');
});

test('import-parsing: sealed import rejects invalid quantities and money with row reasons, while quoted currency remains valid', async () => {
  const { ctx, grab } = await loadApp();
  ctx.document.getElementById('import-data').value = [
    'Product\tQty\tUnit Price\tTotal Price',
    'Negative quantity\t-4\t5\t20',
    'Zero quantity\t0\t5\t20',
    'Fractional quantity\t1.5\t5\t20',
    'Negative money\t1\t-5\t20',
    'Overflow money\t1\t5\t1e309',
    'Valid currency\t2\t"S$1,200"\t"SGD 2,400"',
  ].join('\n');
  ctx.document.getElementById('import-type').value = 'booster_packs';
  ctx.document.getElementById('import-mode').value = 'append';
  await ctx.importData();

  const rows = grab('DB').DB.boosterPacks;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].product, 'Valid currency');
  assert.strictEqual(rows[0].qty, 2);
  assert.strictEqual(rows[0].unitPrice, 1200);
  assert.strictEqual(rows[0].totalPrice, 2400);
  const result = ctx.document.getElementById('import-result').innerHTML;
  assert.match(result, /5 skipped/);
  assert.match(result, /Quantity must be a whole number of 1 or more/);
  assert.match(result, /Unit price must be a finite number at or above 0/);
  assert.doesNotMatch(result, /skipped \(no product\)/);
});

test('import-parsing: all-invalid sealed replacement preserves existing rows and reports the rejected values', async () => {
  const existing = { id: 'keep-pack', product: 'Keep existing pack', qty: 2, unitPrice: 4,
    totalPrice: 8, status: 'Sealed' };
  const { ctx, grab, localStorage } = await loadApp({ seed: { boosterPacks: [existing] } });
  const cacheBefore = localStorage.getItem('pokeinventory_v3');
  ctx.document.getElementById('import-data').value = [
    'Product\tQty\tTotal Price',
    'Bad pack\t0\t-20',
  ].join('\n');
  ctx.document.getElementById('import-type').value = 'booster_packs';
  ctx.document.getElementById('import-mode').value = 'replace';
  await ctx.importData();

  assert.deepStrictEqual(plain(grab('DB').DB.boosterPacks), [existing]);
  assert.strictEqual(localStorage.getItem('pokeinventory_v3'), cacheBefore);
  assert.match(ctx.document.getElementById('import-result').innerHTML, /Row 2/);
  assert.match(ctx.document.getElementById('import-result').innerHTML, /Quantity must be a whole number of 1 or more/);
});

test('import-parsing: legacy singles import rejects invalid quantities and money before accepting valid quoted currency', async () => {
  const { ctx, grab } = await loadApp({ seed: { singles: [] } });
  ctx.kjrConfirm = async () => true;
  ctx.document.getElementById('import-data').value = [
    'Name\tQty\tCost\tMarket',
    'Negative lot\t-3\t10\t20',
    'Zero lot\t0\t10\t20',
    'Fractional lot\t1.5\t10\t20',
    'Negative cost\t1\t-10\t20',
    'Overflow market\t1\t10\t1e309',
    'Valid lot\t2\t"$1,200"\t"SGD 1,500"',
  ].join('\n');
  ctx.document.getElementById('import-type').value = 'singles';
  ctx.document.getElementById('import-mode').value = 'append';
  await ctx.importData();

  const rows = grab('DB').DB.singles;
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'Valid lot');
  assert.strictEqual(rows[0].qty, 2);
  assert.strictEqual(rows[0].costPrice, 1200);
  assert.strictEqual(rows[0].marketPrice, '1500');
  const result = ctx.document.getElementById('import-result').innerHTML;
  assert.match(result, /5 skipped/);
  assert.match(result, /Market price must be a finite number at or above 0/);
});
