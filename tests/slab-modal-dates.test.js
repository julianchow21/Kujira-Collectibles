'use strict';
// v3.75: the Edit Slab modal and the dates a slab row carries. Parked bug: _saveSlabNow rebuilt the whole row from the form, the
// form has one date input (Date Listed, dateListed) and none for datePurchased, so every edit-save dropped datePurchased. Nothing
// logged it either (CL_FIELDS_BY_TABLE.slabs does not track it), and the inspector's "Bought" line quietly fell back to "Listed".
// These drive the real modal functions (openEditSlab, saveSlab) in the vm sandbox, the way tests/modal-save.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, syncSuccessResponse, syncOperations } = require('./harness.js');

const ID = 'slab-dates-1';
const slabRow = (extra) => Object.assign({
  id: ID, name: 'Charizard 4', grader: 'PSA', grade: '10', language: 'EN', certNo: 'L6786028', rank: '1st', type: 'slab',
  costPrice: 500, marketPrice: 800, listPrice: 650, dateListed: '5 Jul 2026', datePurchased: '3 Jul 2026', status: 'Available',
  notes: 'before', priceAlert: 450, ebayUrl: 'https://www.ebay.com/itm/1', carousellUrl: 'https://www.carousell.sg/p/1',
  tcgdexId: 'swsh12-186', priceHistory: [], _serverVersion: 4, _updatedAt: '2026-09-04T00:00:00.000Z',
}, extra);

// Open the real modal on one slab, apply the edits (element id -> value), press Save, hand back what is stored.
async function editSave(row, edits) {
  const app = await loadApp({ seed: { singles: [], slabs: [row] } });
  const { ctx, document, grab } = app;
  const toasts = [];
  ctx.toast = (m) => toasts.push(String(m));
  ctx.toastError = (m) => toasts.push('ERR ' + String(m));
  ctx.openEditSlab(row.id);
  for (const [el, value] of Object.entries(edits || {})) document.getElementById(el).value = value;
  await ctx.saveSlab();
  const saved = grab('DB').DB.slabs.find((r) => r.id === row.id);
  return { app, saved, toasts };
}
const had = (row, key) => Object.prototype.hasOwnProperty.call(row, key);

test('slab edit-save keeps the datePurchased the modal has no input for', async () => {
  const { saved, toasts } = await editSave(slabRow(), { 'msl-notes': 'after' });
  assert.ok(toasts.includes('Updated!'), 'the save went through: ' + JSON.stringify(toasts));
  assert.equal(saved.notes, 'after', 'the edit itself was applied');
  assert.equal(saved.datePurchased, '3 Jul 2026', 'datePurchased survives an edit that never touched it');
  assert.equal(saved.dateListed, '5 Jul 2026', 'and so does the date the modal does show');
});

test('slab edit-save: the kept datePurchased reaches the stored cache and the sync payload', async () => {
  const { app, saved } = await editSave(slabRow(), { 'msl-notes': 'after' });
  const { ctx, localStorage, fetchMock } = app;
  assert.equal(saved.datePurchased, '3 Jul 2026');
  const cached = JSON.parse(localStorage.getItem('pokeinventory_v3')).slabs.find((r) => r.id === ID);
  assert.equal(cached.datePurchased, '3 Jul 2026', 'the local cache holds it');
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  await ctx._flushDirtyToSupabase();
  const ops = syncOperations(fetchMock).filter((op) => op.table === 'slabs' && op.id === ID);
  assert.equal(ops.length, 1, 'the edited slab is queued for the cloud once');
  assert.equal(ops[0].data.datePurchased, '3 Jul 2026', 'the cloud copy is not stripped of it either');
  assert.equal(ops[0].data.dateListed, '5 Jul 2026');
});

test('slab edit-save: every public slab field survives an edit that only touches the notes', async () => {
  const row = slabRow();
  const { app, saved } = await editSave(row, { 'msl-notes': 'after' });
  const publicKeys = app.ctx.KJR_TABULAR_FIELDS.slabs; // the interchange shape: the fields a slab owns
  for (const key of publicKeys) {
    if (key === 'notes') continue;
    assert.equal(saved[key], row[key], 'slab field "' + key + '" must not change on a notes-only edit');
  }
  assert.ok(publicKeys.includes('datePurchased'), 'datePurchased is part of the slab interchange shape, so it is a real field');
});

test('slab edit-save: a slab with no datePurchased stays without one, no date is invented', async () => {
  const absent = slabRow();
  delete absent.datePurchased;
  const a = await editSave(absent, { 'msl-notes': 'after' });
  assert.ok(a.toasts.includes('Updated!'));
  assert.equal(had(a.saved, 'datePurchased'), false, 'no datePurchased key appears out of nowhere');
  assert.equal(a.saved.dateListed, '5 Jul 2026', 'Date Listed is untouched, it is not copied across');

  const blank = await editSave(slabRow({ datePurchased: '' }), { 'msl-notes': 'after' });
  assert.equal(blank.saved.datePurchased, '', 'a blank datePurchased stays blank');

  const none = slabRow({ dateListed: '' });
  delete none.datePurchased;
  const n = await editSave(none, { 'msl-notes': 'after' });
  assert.equal(n.saved.dateListed, '', 'a slab with no dates at all stays dateless');
  assert.equal(had(n.saved, 'datePurchased'), false);
});

test('slab edit-save: a genuinely changed Date Listed saves as "D MMM YYYY", datePurchased is left alone', async () => {
  const { saved, toasts } = await editSave(slabRow(), { 'msl-date': '2026-07-10' });
  assert.ok(toasts.includes('Updated!'));
  assert.equal(saved.dateListed, '10 Jul 2026', 'the picker value is stored in the canonical form, not as ISO');
  assert.equal(saved.datePurchased, '3 Jul 2026', 'the other date is not dragged along');
});

test('slab edit-save: clearing a readable Date Listed still clears it', async () => {
  const { saved } = await editSave(slabRow(), { 'msl-date': '' });
  assert.equal(saved.dateListed, '', 'an intended clear is honoured');
  assert.equal(saved.datePurchased, '3 Jul 2026');
});

test('slab modal opens with the stored Date Listed in the picker form and saves it back unchanged', async () => {
  const app = await loadApp({ seed: { singles: [], slabs: [slabRow()] } });
  const { ctx, document, grab } = app;
  ctx.toast = () => {};
  ctx.openEditSlab(ID);
  assert.equal(document.getElementById('msl-date').value, '2026-07-05', 'the picker needs YYYY-MM-DD, "D MMM YYYY" would show blank');
  await ctx.saveSlab();
  assert.equal(grab('DB').DB.slabs[0].dateListed, '5 Jul 2026', 'an untouched date round-trips exactly');
});

test('slab edit-save: a Date Listed the picker cannot show is not erased by a save that never touched it', async () => {
  for (const unreadable of ['31 Feb 2026', 'sometime in 2025', '2025/05/19']) {
    const open = await loadApp({ seed: { singles: [], slabs: [slabRow({ dateListed: unreadable })] } });
    open.ctx.toast = () => {};
    open.ctx.openEditSlab(ID);
    assert.equal(open.document.getElementById('msl-date').value, '', 'precondition: the picker opens blank for ' + JSON.stringify(unreadable));

    const kept = await editSave(slabRow({ dateListed: unreadable }), { 'msl-notes': 'after' });
    assert.ok(kept.toasts.includes('Updated!'));
    assert.equal(kept.saved.dateListed, unreadable, 'the stored text survives a notes-only edit: ' + JSON.stringify(unreadable));
    assert.equal(kept.saved.datePurchased, '3 Jul 2026');

    const replaced = await editSave(slabRow({ dateListed: unreadable }), { 'msl-date': '2026-03-01' });
    assert.equal(replaced.saved.dateListed, '1 Mar 2026', 'typing a real date replaces it');
  }
});

test('slab edit-save: a datePurchased in an older stored form is kept exactly as it was', async () => {
  for (const stored of ['2026-07-03', 'Jul 2026', '3 July 2026']) {
    const { saved } = await editSave(slabRow({ datePurchased: stored }), { 'msl-notes': 'after' });
    assert.equal(saved.datePurchased, stored, 'a field the user did not touch is not reformatted: ' + stored);
  }
});

test('add slab: a new slab saves its Date Listed in "D MMM YYYY" and gets no datePurchased', async () => {
  const app = await loadApp({ seed: { singles: [], slabs: [slabRow()] } });
  const { ctx, document, grab } = app;
  const toasts = [];
  ctx.toast = (m) => toasts.push(String(m));
  ctx.openAddSlab();
  document.getElementById('msl-name').value = 'Umbreon VMAX 215';
  document.getElementById('msl-grade').value = '9';
  document.getElementById('msl-date').value = '2026-07-12';
  await ctx.saveSlab();
  assert.ok(toasts.includes('Added!'), JSON.stringify(toasts));
  const added = grab('DB').DB.slabs.find((r) => r.name === 'Umbreon VMAX 215');
  assert.ok(added, 'the new slab exists');
  assert.equal(added.dateListed, '12 Jul 2026');
  assert.equal(had(added, 'datePurchased'), false, 'an add never invents a purchase date');
});
