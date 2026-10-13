'use strict';
// v3.77: a blank Carousell price must save as "no price", never as 0. The Edit Single and Edit Slab saves wrote
// listPrice: kjrNum(field), and kjrNum('') is 0, so a blank field (or any unrelated edit of a row whose price was blank) stored a
// real S$0. Money data: a 0 reads as "listed at nothing" to a filter ("<50" matched it), sorts first, and lands in exports and the
// cloud copy as a number the owner never typed. kjrNumOrNull is the nullable twin, kjrNum itself keeps returning 0 because
// the cost, total and fee callers rely on that. These drive the real modal functions in the vm sandbox, the way
// tests/slab-modal-dates.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, syncSuccessResponse, syncOperations } = require('./harness.js');

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
