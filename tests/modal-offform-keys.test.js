'use strict';
// v3.75 round 2: a full-row modal save (Edit Single, Edit Slab) only changes what the form shows. The saved row used to be built from the
// form alone, so every key the form has no input for was dropped by a save that never touched it: datePurchased, set and dateSold on a
// slab, anything a future feature adds, the local pricing markers. The upsert sends the whole row, so the cloud copy lost the synced ones.
// _preserveModalOffFormKeys carries them over. The deliberate exceptions under test here:
//   - a lookup marker (_tcgdexMissDate, _tcgdexPricedDate) describes one pricing identity, so it resets when the identity changes: tcgdexId,
//     name, language, and for a slab grader and grade. _tcgdexResolvedName keeps its older rule (kept only while a non-blank tcgdexId is unchanged)
//   - createdAt, createdAtSeq, _serverVersion, _updatedAt and listingMeta keep their own rules (valid values only, the edit context, a byte copy)
//   - an unreadable stored date is not erased by a save that never touched the date picker
// These drive the real modal functions in the vm sandbox, the way tests/modal-save.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

const STAMP = { _serverVersion: 4, _updatedAt: '2026-09-04T00:00:00.000Z' };
const MARKERS = { _tcgdexResolvedName: 'Charizard VSTAR', _tcgdexMissDate: '2026-10-11', _tcgdexPricedDate: '2026-10-12' };
// keys no form owns, so a save has no business touching them. "image" is just an unknown key here, the app keeps card art in local maps.
const COMMON_OFF_FORM = {
  date: '1 Jan 2026', dateSold: '2 Jan 2026', image: 'https://assets.tcgdex.net/en/swsh/swsh12/186',
  futureField: { nested: [1, 2, { deep: true }], flag: true }, _futureLocal: 'local only',
};

const CONFIG = {
  slabs: {
    id: 'of-slab',
    // the slab form has no set, datePurchased or dateSold input
    offForm: Object.assign({ set: 'Silver Tempest', datePurchased: '3 Jul 2026' }, COMMON_OFF_FORM),
    row(extra) {
      return Object.assign({
        id: 'of-slab', name: 'Charizard 4', grader: 'PSA', grade: '10', language: 'EN', certNo: 'L6786028', rank: '1st', type: 'slab',
        costPrice: 500, marketPrice: 800, listPrice: 650, dateListed: '5 Jul 2026', status: 'Available', notes: 'before', priceAlert: 450,
        ebayUrl: 'https://www.ebay.com/itm/1', carousellUrl: 'https://www.carousell.sg/p/1', tcgdexId: 'swsh12-186', priceHistory: [],
      }, this.offForm, MARKERS, STAMP, extra);
    },
    open: (ctx, id) => ctx.openEditSlab(id),
    save: (ctx) => ctx.saveSlab(),
    el: { notes: 'msl-notes', tcgdexId: 'msl-tcgdexid', name: 'msl-name', lang: 'msl-lang', grader: 'msl-grader', grade: 'msl-grade', market: 'msl-market', status: 'msl-status', date: 'msl-date' },
    dateKey: 'dateListed',
    identityEdits: { name: ['msl-name', 'Charizard 4 Holo'], language: ['msl-lang', 'JP'], grader: ['msl-grader', 'CGC'], grade: ['msl-grade', '9'] },
  },
  singles: {
    id: 'of-single',
    // the single form owns set and datePurchased, the rest is off form
    offForm: Object.assign({ dateListed: '4 Sep 2026' }, COMMON_OFF_FORM),
    row(extra) {
      return Object.assign({
        id: 'of-single', name: 'Pikachu 25', set: 'Base Set', language: 'EN', type: 'raw', condition: 'Near Mint', qty: 2, costPrice: 10,
        marketPrice: 15, listPrice: 20, datePurchased: '1 Sep 2026', status: 'Available', notes: 'before', priceAlert: 12,
        ebayUrl: 'https://www.ebay.com/itm/2', carousellUrl: 'https://www.carousell.sg/p/2', tcgdexId: 'base1-58', priceHistory: [],
      }, this.offForm, MARKERS, STAMP, extra);
    },
    open: (ctx, id) => ctx.openEditSingle(id),
    save: (ctx) => ctx.saveSingle(),
    el: { notes: 'ms-notes', tcgdexId: 'ms-tcgdexid', name: 'ms-name', lang: 'ms-lang', market: 'ms-market', status: 'ms-status', date: 'ms-date' },
    dateKey: 'datePurchased',
    identityEdits: { name: ['ms-name', 'Pikachu 25 Reverse Holo'], language: ['ms-lang', 'JP'] },
  },
};

// Open the real modal on one row, apply the edits (element id -> value), press Save. Hands back what the app loaded, what it saved, the toasts.
async function editSave(table, rowExtra, edits) {
  const cfg = CONFIG[table];
  const row = cfg.row(rowExtra);
  const app = await loadApp({ seed: { singles: table === 'singles' ? [row] : [], slabs: table === 'slabs' ? [row] : [] } });
  const { ctx, document, grab } = app;
  const toasts = [];
  ctx.toast = (m) => toasts.push(String(m));
  ctx.toastError = (m) => toasts.push('ERR ' + String(m));
  const loaded = grab('DB').DB[table].find((r) => r.id === cfg.id);
  const before = JSON.parse(JSON.stringify(loaded));
  const beforeObjectRefs = { futureField: loaded.futureField };
  cfg.open(ctx, cfg.id);
  for (const [el, value] of Object.entries(edits || {})) document.getElementById(el).value = value;
  await cfg.save(ctx);
  const saved = plain(grab('DB').DB[table].find((r) => r.id === cfg.id));
  return { app, cfg, before, saved, toasts, beforeObjectRefs };
}
const had = (row, key) => Object.prototype.hasOwnProperty.call(row, key);
const without = (row, keys) => { const out = Object.assign({}, row); for (const k of keys) delete out[k]; return out; };

for (const table of ['slabs', 'singles']) {
  const offFormKeys = Object.keys(CONFIG[table].offForm);
  const cfg = CONFIG[table];

  test(`${table}: an edit that only touches the notes changes nothing else on the row`, async () => {
    const { before, saved, toasts } = await editSave(table, {}, { [cfg.el.notes]: 'after' });
    assert.ok(toasts.includes('Updated!'), 'the save went through: ' + JSON.stringify(toasts));
    assert.equal(saved.notes, 'after', 'the edit itself was applied');
    assert.deepStrictEqual(saved, Object.assign({}, before, { notes: 'after' }), 'every other key, the local ones included, is exactly as it was');
  });

  test(`${table}: keys no form owns survive a save (${offFormKeys.join(', ')})`, async () => {
    const { before, saved, beforeObjectRefs } = await editSave(table, {}, { [cfg.el.notes]: 'after' });
    for (const key of offFormKeys) {
      assert.ok(had(saved, key), `"${key}" is still on the row after the save`);
      assert.deepStrictEqual(saved[key], before[key], `"${key}" keeps its value`);
    }
    assert.deepStrictEqual(saved.futureField, { nested: [1, 2, { deep: true }], flag: true }, 'an unknown future object key comes through whole');
    assert.notEqual(saved.futureField, beforeObjectRefs.futureField, 'as a copy, not the old row\'s own object');
  });

  test(`${table}: the local pricing markers survive an edit that leaves the card's identity alone`, async () => {
    const edits = { [cfg.el.notes]: 'after', [cfg.el.market]: '900', [cfg.el.status]: 'Available' };
    const { saved, toasts } = await editSave(table, {}, edits);
    assert.ok(toasts.includes('Updated!'));
    assert.equal(saved._tcgdexMissDate, '2026-10-11', 'a miss stays a miss, the card stays flagged');
    assert.equal(saved._tcgdexPricedDate, '2026-10-12', 'a priced-today marker still skips the card today');
    assert.equal(saved._tcgdexResolvedName, 'Charizard VSTAR', 'the confirm name stays while the id is unchanged');
  });

  test(`${table}: a changed tcgdexId resets the markers tied to the old id, the data keys still carry`, async () => {
    const { before, saved, toasts } = await editSave(table, {}, { [cfg.el.tcgdexId]: 'swsh12-999' });
    assert.ok(toasts.includes('Updated!'));
    assert.equal(saved.tcgdexId, 'swsh12-999', 'the new id saved');
    for (const key of ['_tcgdexResolvedName', '_tcgdexMissDate', '_tcgdexPricedDate']) assert.equal(had(saved, key), false, `"${key}" belongs to the old id and must not carry`);
    for (const key of offFormKeys) assert.deepStrictEqual(saved[key], before[key], `"${key}" is data, it still carries`);
    assert.deepStrictEqual(saved, Object.assign(without(before, ['_tcgdexResolvedName', '_tcgdexMissDate', '_tcgdexPricedDate']), { tcgdexId: 'swsh12-999' }), 'and nothing else moved');
  });

  test(`${table}: clearing the tcgdexId resets the same markers`, async () => {
    const { saved } = await editSave(table, {}, { [cfg.el.tcgdexId]: '' });
    assert.equal(saved.tcgdexId, '');
    for (const key of ['_tcgdexResolvedName', '_tcgdexMissDate', '_tcgdexPricedDate']) assert.equal(had(saved, key), false, `"${key}"`);
    assert.deepStrictEqual(saved.futureField, { nested: [1, 2, { deep: true }], flag: true });
  });

  for (const [what, [el, value]] of Object.entries(CONFIG[table].identityEdits)) {
    test(`${table}: changing the ${what} resets the lookup markers too, so the card is looked up afresh`, async () => {
      const { saved, toasts } = await editSave(table, {}, { [el]: value });
      assert.ok(toasts.includes('Updated!'), JSON.stringify(toasts));
      assert.equal(had(saved, '_tcgdexMissDate'), false, 'a card whose number was just fixed must leave the "needs a card number" list');
      assert.equal(had(saved, '_tcgdexPricedDate'), false, 'and must not stay skipped under its old identity');
      assert.equal(saved._tcgdexResolvedName, 'Charizard VSTAR', 'the confirm name still follows its own rule, kept while the tcgdexId is unchanged');
      assert.deepStrictEqual(saved.futureField, { nested: [1, 2, { deep: true }], flag: true }, 'data keys carry');
    });
  }

  test(`${table}: a row with no language, saved by the form as EN, has not changed identity so its markers stay`, async () => {
    const { before, saved, toasts } = await editSave(table, { language: undefined }, { [cfg.el.notes]: 'after' });
    assert.ok(toasts.includes('Updated!'), JSON.stringify(toasts));
    assert.equal(had(before, 'language'), false, 'precondition: the stored row has no language, which pricing reads as English');
    assert.equal(saved.language, 'EN', 'the form saves it as EN');
    assert.equal(saved._tcgdexMissDate, '2026-10-11', 'blank and EN are the same lookup, so the miss stands');
    assert.equal(saved._tcgdexPricedDate, '2026-10-12');
  });

  test(`${table}: a row with none of the off-form keys gets none invented`, async () => {
    const minimal = { id: cfg.id, name: 'Plain Card 7', language: 'EN', status: 'Available', notes: 'before', costPrice: 5, marketPrice: 6, tcgdexId: '', priceHistory: [] };
    if (table === 'slabs') Object.assign(minimal, { type: 'slab', grader: 'PSA', grade: '9' });
    else Object.assign(minimal, { type: 'raw', condition: 'Near Mint', qty: 1 });
    const app = await loadApp({ seed: { singles: table === 'singles' ? [minimal] : [], slabs: table === 'slabs' ? [minimal] : [] } });
    app.ctx.toast = () => {};
    cfg.open(app.ctx, cfg.id);
    app.document.getElementById(cfg.el.notes).value = 'after';
    await cfg.save(app.ctx);
    const saved = plain(app.grab('DB').DB[table].find((r) => r.id === cfg.id));
    for (const key of [...offFormKeys, 'datePurchased', 'dateListed', 'dateSold', 'set', '_tcgdexMissDate', '_tcgdexPricedDate', '_tcgdexResolvedName']) {
      if (key === 'datePurchased' && table === 'singles') continue; // the single form owns it and always writes it
      if (key === 'dateListed' && table === 'slabs') continue;      // so does the slab form
      if (key === 'set' && table === 'singles') continue;
      assert.equal(had(saved, key), false, `"${key}" must not appear out of nowhere`);
    }
  });
}

test('the keys with their own rules keep them: a valid createdAt carries, an invalid one is still dropped, the stamp follows the edit context', async () => {
  const ok = await editSave('slabs', { createdAt: 1700000000000, createdAtSeq: 3 }, { 'msl-notes': 'after' });
  assert.equal(ok.saved.createdAt, 1700000000000);
  assert.equal(ok.saved.createdAtSeq, 3);
  assert.equal(ok.saved._serverVersion, 4);
  assert.equal(ok.saved._updatedAt, '2026-09-04T00:00:00.000Z');
  const bad = await editSave('singles', { createdAt: 'not a time', createdAtSeq: -2 }, { 'ms-notes': 'after' });
  assert.equal(had(bad.saved, 'createdAt'), false, 'kjrPreserveCreatedMetadata only keeps valid values, an invalid one is not resurrected by the generic carry-over');
  assert.equal(had(bad.saved, 'createdAtSeq'), false);
});

// ── the unreadable stored date on the Edit Single modal (the slab twin lives in tests/slab-modal-dates.test.js) ──────────────
test('singles: a Date Purchased the picker cannot show is not erased by a save that never touched it', async () => {
  for (const unreadable of ['31 Feb 2026', 'sometime in 2025', '2025/05/19']) {
    const open = await loadApp({ seed: { singles: [CONFIG.singles.row({ datePurchased: unreadable })], slabs: [] } });
    open.ctx.toast = () => {};
    open.ctx.openEditSingle('of-single');
    assert.equal(open.document.getElementById('ms-date').value, '', 'precondition: the picker opens blank for ' + JSON.stringify(unreadable));

    const kept = await editSave('singles', { datePurchased: unreadable }, { 'ms-notes': 'after' });
    assert.ok(kept.toasts.includes('Updated!'));
    assert.equal(kept.saved.datePurchased, unreadable, 'the stored text survives a notes-only edit: ' + JSON.stringify(unreadable));

    const replaced = await editSave('singles', { datePurchased: unreadable }, { 'ms-date': '2026-03-01' });
    assert.equal(replaced.saved.datePurchased, '1 Mar 2026', 'typing a real date replaces it, in "D MMM YYYY"');
  }
});

test('singles: a readable Date Purchased still round-trips, still changes, and still clears', async () => {
  const same = await editSave('singles', {}, { 'ms-notes': 'after' });
  assert.equal(same.saved.datePurchased, '1 Sep 2026');
  const changed = await editSave('singles', {}, { 'ms-date': '2026-09-20' });
  assert.equal(changed.saved.datePurchased, '20 Sep 2026');
  const cleared = await editSave('singles', {}, { 'ms-date': '' });
  assert.equal(cleared.saved.datePurchased, '', 'an intended clear is honoured');
});
