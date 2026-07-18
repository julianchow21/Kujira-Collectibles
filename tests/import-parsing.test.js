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
