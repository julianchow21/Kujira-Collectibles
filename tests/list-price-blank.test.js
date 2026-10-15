'use strict';
// v3.77: a blank Carousell price must save as "no price", never as 0. The Edit Single and Edit Slab saves wrote
// listPrice: kjrNum(field), and kjrNum('') is 0, so a blank field (or any unrelated edit of a row whose price was blank) stored a
// real S$0. Money data: a 0 reads as "listed at nothing" to a filter ("<50" matched it), sorts first, and lands in exports and the
// cloud copy as a number the owner never typed. kjrNumOrNull is the nullable twin, kjrNum itself keeps returning 0 because
// the cost, total and fee callers rely on that. These drive the real modal functions in the vm sandbox, the way
// tests/slab-modal-dates.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain, syncSuccessResponse, syncOperations } = require('./harness.js');

test('kjrNumOrNull: blank, whitespace, null, undefined and text with no digit are no value, never 0', async () => {
  const { ctx } = await loadApp();
  for (const input of ['', '   ', '\t\n', null, undefined, 'abc', '$', '-', '.', '--', 'S$', NaN, Infinity, -Infinity]) {
    assert.strictEqual(ctx.kjrNumOrNull(input), null, JSON.stringify(String(input)) + ' is no value');
  }
});

test('kjrNumOrNull: a typed zero is a real zero, and every other number parses exactly as kjrNum does', async () => {
  const { ctx } = await loadApp();
  assert.ok(Object.is(ctx.kjrNumOrNull('0'), 0), '"0" is a number');
  assert.ok(Object.is(ctx.kjrNumOrNull('0.00'), 0), '"0.00" is a number');
  assert.ok(Object.is(ctx.kjrNumOrNull(0), 0), 'the number 0 is a number');
  for (const [input, expected] of [
    ['155', 155], [155, 155], ['155.5', 155.5], [' 155 ', 155], ['$155', 155], ['S$ 155', 155],
    ['$1,250.50', 1250.5], ['1,250', 1250], ['-5', -5], [0.5, 0.5],
  ]) {
    assert.strictEqual(ctx.kjrNumOrNull(input), expected, JSON.stringify(input));
    assert.strictEqual(ctx.kjrNumOrNull(input), ctx.kjrNum(input), JSON.stringify(input) + ' agrees with kjrNum');
  }
});

test('kjrNum itself is unchanged: blank is still 0 for the cost, total and fee callers that rely on it', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrNum(''), 0);
  assert.strictEqual(ctx.kjrNum(null), 0);
  assert.strictEqual(ctx.kjrNum(undefined), 0);
  assert.strictEqual(ctx.kjrNum('abc'), 0);
});

const STAMP = { _serverVersion: 4, _updatedAt: '2026-09-04T00:00:00.000Z' };
const TABLES = {
  slabs: {
    id: 'lp-slab', input: 'msl-list', notes: 'msl-notes', name: 'msl-name',
    row: (extra) => Object.assign({
      id: 'lp-slab', name: 'Charizard 4', grader: 'PSA', grade: '10', language: 'EN', certNo: 'L6786028', rank: '1st', type: 'slab',
      costPrice: 500, marketPrice: 800, listPrice: 650, dateListed: '5 Jul 2026', status: 'Available', notes: 'before', priceAlert: '',
      ebayUrl: '', carousellUrl: '', tcgdexId: '', priceHistory: [],
    }, STAMP, extra),
    open: (ctx, id) => ctx.openEditSlab(id), openAdd: (ctx) => ctx.openAddSlab(), save: (ctx) => ctx.saveSlab(),
  },
  singles: {
    id: 'lp-single', input: 'ms-list', notes: 'ms-notes', name: 'ms-name',
    row: (extra) => Object.assign({
      id: 'lp-single', name: 'Pikachu 25', set: 'Base Set', language: 'EN', type: 'raw', condition: 'Near Mint', qty: 1, costPrice: 10,
      marketPrice: 15, listPrice: 20, datePurchased: '1 Sep 2026', status: 'Available', notes: 'before', priceAlert: '',
      ebayUrl: '', carousellUrl: '', tcgdexId: '', priceHistory: [],
    }, STAMP, extra),
    open: (ctx, id) => ctx.openEditSingle(id), openAdd: (ctx) => ctx.openAddSingle(), save: (ctx) => ctx.saveSingle(),
  },
};
const had = (row, key) => Object.prototype.hasOwnProperty.call(row, key);

// Open the real modal on one row (or an empty Add form when row is null), apply the edits (element id -> value), press Save.
async function editSave(table, row, edits) {
  const cfg = TABLES[table];
  const app = await loadApp({ seed: { singles: table === 'singles' && row ? [row] : [], slabs: table === 'slabs' && row ? [row] : [] } });
  const { ctx, document, grab } = app;
  const toasts = [];
  ctx.toast = (m) => toasts.push(String(m));
  ctx.toastError = (m) => toasts.push('ERR ' + String(m));
  if (row) cfg.open(ctx, row.id); else cfg.openAdd(ctx);
  for (const [el, value] of Object.entries(edits || {})) document.getElementById(el).value = value;
  await cfg.save(ctx);
  const rows = grab('DB').DB[table];
  const saved = row ? rows.find((r) => r.id === row.id) : rows[rows.length - 1];
  return { app, cfg, saved, toasts };
}

// What the save leaves behind, three ways: the in-memory row, the local cache the next load reads, and the row the cloud is sent.
async function storedEverywhere(app, table, id) {
  const { ctx, localStorage, fetchMock } = app;
  const cached = JSON.parse(localStorage.getItem('pokeinventory_v3'))[table].find((r) => r.id === id);
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  await ctx._flushDirtyToSupabase();
  const ops = syncOperations(fetchMock).filter((op) => op.table === table && op.id === id);
  return { cached, ops };
}

const PRICE_CASES = [
  { label: 'a blank field', typed: '', expected: null },
  { label: 'a whitespace-only field', typed: '   ', expected: null },
  { label: '"0"', typed: '0', expected: 0 },
  { label: '"155"', typed: '155', expected: 155 },
  { label: '"155.50"', typed: '155.50', expected: 155.5 },
];

for (const table of ['slabs', 'singles']) {
  for (const c of PRICE_CASES) {
    test(`${table} edit-save: ${c.label} in the Carousell price saves as ${c.expected === null ? 'null (no price)' : c.expected}, in memory, in the cache and in the cloud row`, async () => {
      const cfg = TABLES[table];
      const { app, saved, toasts } = await editSave(table, cfg.row(), { [cfg.input]: c.typed });
      assert.ok(toasts.includes('Updated!'), 'the save went through: ' + JSON.stringify(toasts));
      assert.strictEqual(saved.listPrice, c.expected, 'in memory');
      assert.ok(had(saved, 'listPrice'), 'the key stays on the row, so the clear is an explicit decision and not a missing field');
      const { cached, ops } = await storedEverywhere(app, table, cfg.id);
      assert.strictEqual(cached.listPrice, c.expected, 'in the local cache');
      assert.ok(had(cached, 'listPrice'), 'the cache keeps the key too');
      assert.equal(ops.length, 1, 'the edited row is queued for the cloud once');
      assert.strictEqual(ops[0].data.listPrice, c.expected, 'in the row the cloud is sent');
      assert.ok(had(ops[0].data, 'listPrice'), 'the cloud row carries the key, a dropped key could leave the old price in place');
    });
  }

  test(`${table} edit-save: clearing a real price is logged in the changelog as a change to nothing`, async () => {
    const cfg = TABLES[table];
    const { app, saved } = await editSave(table, cfg.row({ listPrice: 650 }), { [cfg.input]: '' });
    assert.strictEqual(saved.listPrice, null);
    const entry = app.ctx.clLoad()[0];
    assert.equal(entry.action, 'edit');
    assert.match(entry.extra, /listPrice: S\$650 → ∅/, 'the audit line shows the price going to nothing: ' + entry.extra);
  });

  test(`${table} edit-save: a notes-only edit of a row whose price was blank leaves it blank, it is never turned into 0`, async () => {
    const cfg = TABLES[table];
    for (const blank of ['', null]) {
      const { saved, toasts } = await editSave(table, cfg.row({ listPrice: blank }), { [cfg.notes]: 'after' });
      assert.ok(toasts.includes('Updated!'), JSON.stringify(blank));
      assert.equal(saved.notes, 'after', 'the edit itself was applied');
      assert.strictEqual(saved.listPrice, null, 'a stored ' + JSON.stringify(blank) + ' is still no price');
    }
    const absent = cfg.row();
    delete absent.listPrice;
    const a = await editSave(table, absent, { [cfg.notes]: 'after' });
    assert.strictEqual(a.saved.listPrice, null, 'a row with no listPrice key at all is still no price');
  });

  test(`${table} edit-save: a stored explicit zero stays 0 through an edit that never touched the price`, async () => {
    const cfg = TABLES[table];
    const { saved } = await editSave(table, cfg.row({ listPrice: 0 }), { [cfg.notes]: 'after' });
    assert.strictEqual(saved.listPrice, 0, 'a deliberate zero is a decision, only a blank field means no price');
  });

  test(`${table} edit-save: a real price is kept through a notes-only edit and replaced by a new one`, async () => {
    const cfg = TABLES[table];
    const kept = await editSave(table, cfg.row({ listPrice: 650 }), { [cfg.notes]: 'after' });
    assert.strictEqual(kept.saved.listPrice, 650);
    const changed = await editSave(table, cfg.row({ listPrice: 650 }), { [cfg.input]: '$1,250.50' });
    assert.strictEqual(changed.saved.listPrice, 1250.5, 'a pasted comma-formatted price still parses whole');
  });

  test(`${table} add: a new row with the Carousell price left blank is saved with no price, with "155" it is 155`, async () => {
    const cfg = TABLES[table];
    const blank = await editSave(table, null, { [cfg.name]: 'New card' });
    assert.ok(blank.toasts.includes('Added!'), JSON.stringify(blank.toasts));
    assert.strictEqual(blank.saved.listPrice, null, 'blank is no price');
    assert.ok(had(blank.saved, 'listPrice'));
    const priced = await editSave(table, null, { [cfg.name]: 'New card', [cfg.input]: '155' });
    assert.strictEqual(priced.saved.listPrice, 155);
    const zero = await editSave(table, null, { [cfg.name]: 'New card', [cfg.input]: '0' });
    assert.strictEqual(zero.saved.listPrice, 0, 'a typed zero on a new row is kept');
  });
}

test('why it matters: the Carousell column filter matches a real 0 for "<50" but never an empty price', async () => {
  const { ctx } = await loadApp();
  // A blank saved as 0 used to turn up under "<50". An empty price matches no filter at all.
  assert.strictEqual(ctx.kjrMatchNumFilter('<50', null), false);
  assert.strictEqual(ctx.kjrMatchNumFilter('<50', ''), false);
  assert.strictEqual(ctx.kjrMatchNumFilter('<50', 0), true, 'a real zero still matches, which is why a stored blank-as-0 was wrong');
});

// ═══ v3.78: CSV import, Quick Entry and Smart Add wrote 0 for a blank Carousell price too ═══
// v3.77 fixed the two edit modals. Three more writers still stored a price nobody typed: the CSV importer (its List price cell defaulted to 0
// for Singles and Slabs, parseMoneyField('listPrice', 'List price', 0)) and parseSmartLine, which seeded listPrice: 0 and so fed both
// Quick Entry in the ⌘K bar (cmdAddKey) and the Smart Add modal (saveSmartAdd). All three now leave it null, the same "no price" the modals
// save, and a cell or field that really says 0 stays 0. Cost and the other money fields are untouched, they keep their own defaults.
const CSV_CASES = [
  { label: 'a blank cell', cell: '', expected: null },
  { label: 'a whitespace-only cell', cell: '"   "', expected: null },
  { label: '"0"', cell: '0', expected: 0 },
  { label: '"0.00"', cell: '0.00', expected: 0 },
  { label: '"155"', cell: '155', expected: 155 },
  { label: '"S$1,250.50"', cell: '"S$1,250.50"', expected: 1250.5 },
];

// A cloud sync that succeeds, so the rows the writer queued can be read back as the cloud is sent them. Routed before the write when the
// writer flushes itself (the importer does), and read once more here for the writers that only queue (Quick Entry, Smart Add).
async function cloudRowsOf(app, table, id) {
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  await app.ctx._flushDirtyToSupabase();
  return syncOperations(app.fetchMock).filter((op) => op.table === table && op.id === id);
}
function cachedRow(app, table, id) {
  return JSON.parse(app.localStorage.getItem('pokeinventory_v3'))[table].find((r) => r.id === id);
}
// Run the real importer on a pasted table, append mode, the preview confirmed.
async function importCsv(table, csv, seed) {
  const app = await loadApp({ seed: seed || { singles: [], slabs: [] } });
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  app.ctx.kjrConfirm = async () => true;
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(String(m));
  app.ctx.toastError = (m) => toasts.push('ERR ' + String(m));
  app.ctx.document.getElementById('import-type').value = table;
  app.ctx.document.getElementById('import-mode').value = 'append';
  app.ctx.document.getElementById('import-data').value = csv;
  await app.ctx.importData();
  return { app, toasts, rows: app.ctx.DB[table] };
}

for (const table of ['singles', 'slabs']) {
  for (const c of CSV_CASES) {
    test(`${table} CSV import: ${c.label} in the List price column saves as ${c.expected === null ? 'null (no price)' : c.expected}, in memory, in the cache and in the cloud row`, async () => {
      const { app, toasts, rows } = await importCsv(table, 'name,costPrice,listPrice\r\nNew card,10,' + c.cell);
      assert.ok(toasts.includes('Imported 1 records!'), JSON.stringify(toasts));
      assert.equal(rows.length, 1);
      const saved = rows[0];
      assert.strictEqual(saved.listPrice, c.expected, 'in memory');
      assert.ok(had(saved, 'listPrice'), 'the key is on the row, an explicit "no price"');
      assert.strictEqual(saved.costPrice, 10, 'the cost beside it is read as before');
      const cached = cachedRow(app, table, saved.id);
      assert.strictEqual(cached.listPrice, c.expected, 'in the local cache');
      assert.ok(had(cached, 'listPrice'));
      const ops = await cloudRowsOf(app, table, saved.id);
      assert.equal(ops.length, 1, 'the new row is queued for the cloud once');
      assert.strictEqual(ops[0].data.listPrice, c.expected, 'in the row the cloud is sent');
      assert.ok(had(ops[0].data, 'listPrice'));
    });
  }

  test(`${table} CSV import: a sheet with no List price column at all saves no price, and one bad price still skips only its own row`, async () => {
    const noColumn = await importCsv(table, 'name,costPrice\r\nNo column,10');
    assert.strictEqual(noColumn.rows[0].listPrice, null, 'the column is absent, so there is no price');
    assert.ok(had(noColumn.rows[0], 'listPrice'));
    const mixed = await importCsv(table, ['name,costPrice,listPrice', 'Blank,5,', 'Bad,5,abc', 'Negative,5,-3', 'Zero,5,0'].join('\r\n'));
    assert.deepEqual(plain(mixed.rows.map((r) => [r.name, r.listPrice])), [['Blank', null], ['Zero', 0]]);
    const result = mixed.app.ctx.document.getElementById('import-result').innerHTML;
    assert.match(result, /2 skipped/);
    assert.match(result, /List price must be a finite number at or above 0/, 'a typed value that is not a price is still refused');
  });

  test(`${table} CSV import: the other money fields keep their own blank defaults, only the Carousell price changed`, async () => {
    const { rows } = await importCsv(table, 'name,costPrice,marketPrice,listPrice\r\nBlanks,,,');
    assert.strictEqual(rows[0].costPrice, '', 'a blank cost is still the empty string');
    assert.strictEqual(rows[0].marketPrice, '', 'and so is a blank market price');
    assert.strictEqual(rows[0].listPrice, null);
  });

  test(`${table} CSV round trip: an exported blank price re-imports as blank and an exported 0 re-imports as 0`, async () => {
    const cfg = TABLES[table];
    const seedRows = [
      cfg.row({ id: 'rt-null', name: 'Null price', certNo: 'RT-1', listPrice: null }),
      cfg.row({ id: 'rt-empty', name: 'Empty price', certNo: 'RT-2', listPrice: '' }),
      cfg.row({ id: 'rt-zero', name: 'Zero price', certNo: 'RT-3', listPrice: 0 }),
      cfg.row({ id: 'rt-five', name: 'Five price', certNo: 'RT-4', listPrice: 5 }),
    ];
    const source = await loadApp({ seed: { singles: table === 'singles' ? seedRows : [], slabs: table === 'slabs' ? seedRows : [] } });
    let csv = '';
    source.ctx.dl = (name, content) => { csv = content; };
    source.ctx.exportCSV(table);
    assert.match(csv, /listPrice/);
    const { rows } = await importCsv(table, csv);
    assert.deepEqual(plain(rows.map((r) => [r.name, r.listPrice])), [['Null price', null], ['Empty price', null], ['Zero price', 0], ['Five price', 5]]);
  });
}

test('parseSmartLine: a line seeds no Carousell price, with or without a $ amount, and the $ amount is the cost', async () => {
  const { ctx } = await loadApp();
  for (const line of ['Eevee 173 EN NM', 'Eevee 173 EN NM $9', 'Charmander 44 sealed JP x2 $30', 'PSA 10 Charizard ex 223 #119569490 $850', 'TAG 9 Eevee 173 cert L6786028', 'SV8 Booster Box x3 $5']) {
    const parsed = ctx.parseSmartLine(line);
    assert.strictEqual(parsed.listPrice, null, line);
    assert.ok(had(parsed, 'listPrice'), line);
  }
  assert.equal(ctx.parseSmartLine('Eevee 173 EN NM $9').costPrice, 9);
  assert.equal(ctx.parseSmartLine('Eevee 173 EN NM').costPrice, '', 'no $ amount, no cost, as before');
  assert.equal(ctx.parseSmartLine('Eevee 173 EN NM $9 list $12').listPrice, null, 'even a "list" word never fills it, every $ amount is the cost');
});

for (const [label, line, table] of [
  ['a single with a cost', 'Eevee 173 EN NM $9', 'singles'],
  ['a single with no price at all', 'Eevee 173 EN NM', 'singles'],
  ['a sealed single', 'Charmander 44 sealed JP $30', 'singles'],
  ['a slab with a cost', 'PSA 10 Charizard ex 223 #119569490 $850', 'slabs'],
  ['a slab with no price at all', 'TAG 9 Eevee 173 cert L6786028', 'slabs'],
]) {
  test(`Quick Entry (⌘K bar): ${label} saves a null Carousell price, in memory, in the cache and in the cloud row`, async () => {
    const app = await loadApp({ seed: { singles: [], slabs: [] } });
    const { ctx, document } = app;
    const input = document.getElementById('cmd-add-input');
    input.value = line;
    // the preview must not invent a price: no S$0, no "null", no NaN
    ctx.cmdAddPreview();
    const preview = document.getElementById('cmd-add-preview').innerHTML;
    assert.match(preview, /Will be added to/);
    assert.doesNotMatch(preview, /S\$0(?!\d)|null|NaN|undefined/, preview);
    await ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });
    const saved = ctx.DB[table].at(-1);
    assert.strictEqual(saved.listPrice, null, 'in memory');
    assert.ok(had(saved, 'listPrice'));
    assert.strictEqual(cachedRow(app, table, saved.id).listPrice, null, 'in the local cache');
    const ops = await cloudRowsOf(app, table, saved.id);
    assert.equal(ops.length, 1);
    assert.strictEqual(ops[0].data.listPrice, null, 'in the row the cloud is sent');
    assert.ok(had(ops[0].data, 'listPrice'));
    assert.strictEqual(String(ops[0].data.listPrice), 'null');
    // the audit line names no price it never had
    const entry = ctx.clLoad()[0];
    assert.equal(entry.action, 'add');
    assert.doesNotMatch(entry.extra, /listPrice/, entry.extra);
  });
}

test('Quick Entry (⌘K bar): a line for several singles saves every row with no Carousell price', async () => {
  const { ctx, document } = await loadApp({ seed: { singles: [], slabs: [] } });
  document.getElementById('cmd-add-input').value = 'Pikachu V JP NM x3 $15';
  await ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });
  const rows = ctx.DB.singles.slice(-3);
  assert.equal(rows.length, 3);
  for (const r of rows) { assert.strictEqual(r.listPrice, null); assert.equal(r.costPrice, 15); }
});

test('Quick Entry (⌘K bar): the sealed tables never carry a Carousell price, so the null changes nothing there', async () => {
  const { ctx, document } = await loadApp({ seed: { singles: [], slabs: [] } });
  for (const [line, table] of [['Crown Zenith ETB JP x2 $30', 'etbs'], ['SV8 Booster Box x3 $5', 'boosterBoxes'], ['SV8 Booster Pack JP x4 $2', 'boosterPacks']]) {
    document.getElementById('cmd-add-input').value = line;
    await ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });
    assert.equal(had(ctx.DB[table].at(-1), 'listPrice'), false, table);
  }
});

test('Smart Add modal: singles (with a quantity) and slabs save no Carousell price, and a typed zero never appears', async () => {
  const app = await loadApp({ seed: { singles: [], slabs: [] } });
  const { ctx, document } = app;
  ctx.toast = () => {};
  document.getElementById('smart-add-input').value = 'Pikachu 25 EN x2 $5\nEevee 173 EN NM\nPSA 9 Mew 151 #123456789 $60\nTAG 10 Umbreon VMAX cert L6786028';
  ctx.previewSmartAdd();
  const listHtml = document.getElementById('smart-add-preview-list').innerHTML;
  assert.doesNotMatch(listHtml, /null|NaN|undefined|S\$0(?!\d)/, 'the preview shows no price it never had');
  ctx.saveSmartAdd();
  assert.deepEqual(plain(ctx.DB.singles.map((r) => [r.name, r.listPrice])), [['Pikachu 25', null], ['Pikachu 25', null], ['Eevee 173', null]]);
  assert.deepEqual(plain(ctx.DB.slabs.map((r) => [r.name, r.listPrice])), [['Mew 151', null], ['Umbreon VMAX', null]]);
  for (const r of [...ctx.DB.singles, ...ctx.DB.slabs]) assert.ok(had(r, 'listPrice'), r.name);
  const slab = ctx.DB.slabs[0];
  assert.strictEqual(cachedRow(app, 'slabs', slab.id).listPrice, null, 'in the local cache');
  const ops = await cloudRowsOf(app, 'slabs', slab.id);
  assert.equal(ops.length, 1);
  assert.strictEqual(ops[0].data.listPrice, null, 'in the row the cloud is sent');
  const batch = ctx.clLoad().filter((e) => e.action === 'add' && e.table);
  assert.ok(batch.length >= 4);
  for (const e of batch) assert.doesNotMatch(e.extra, /listPrice/, e.extra);
});

test('why it matters (v3.78): an imported blank price is an empty price to the Carousell filter, and an imported 0 is still a real zero', async () => {
  const { app, rows } = await importCsv('singles', 'name,costPrice,listPrice\r\nBlank,5,\r\nZero,5,0');
  const [blank, zero] = rows;
  assert.strictEqual(app.ctx.kjrMatchNumFilter('<50', blank.listPrice), false, 'blank: no filter matches it, as the old 0 did not hold');
  assert.strictEqual(app.ctx.kjrMatchNumFilter('<50', zero.listPrice), true, 'a real zero still does');
});
