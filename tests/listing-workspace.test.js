'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, syncRequest, syncSuccessResponse, syncCalls } = require('./harness.js');

function readyMeta(ctx, overrides) {
  return ctx.kjrListingNormalise({
    schemaVersion: 1,
    photo: { status: 'ready', folderRef: 'photos v2', front: 'front.jpg', back: 'back.jpg', extras: [], photoItemId: 'photo-1' },
    copyTag: 'copy-1',
    draft: { title: 'Pikachu', description: 'A saved draft' },
    urgency: 'soon',
    proposedAsk: 18,
    approvedAsk: 16,
    priceEvidence: { ref: 'receipt-1', basis: 'owner review', observedAt: '2026-09-19', sourceStatus: 'reviewed' },
    holdReason: '',
    listingStatus: 'draft',
    history: [],
    ...(overrides || {})
  });
}

test('listing workspace defaults metadata, persists it locally and keeps it in the existing row serializer', async () => {
  const { ctx, grab, localStorage } = await loadApp();
  const meta = ctx.kjrListingNormalise();
  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.photo.status, 'unknown');
  assert.equal(meta.listingStatus, 'unknown');
  assert.equal(meta.proposedAsk, null);
  const row = { id: 'single-1', name: 'Pikachu', status: 'Available', qty: 1, listingMeta: meta };
  const op = ctx._upsertOperation('singles', row);
  assert.deepEqual(op.data.listingMeta, meta);
  assert.equal(op.data.id, undefined, 'row id remains the sync operation key');
  grab('DB').DB.singles = [row];
  ctx.saveData();
  const stored = JSON.parse(localStorage.getItem('pokeinventory_v3'));
  assert.equal(JSON.stringify(stored.singles[0].listingMeta), JSON.stringify(meta));
});

test('listing readiness blocks stock ambiguity, duplicate photos, explicit holds and closed statuses', async () => {
  const { ctx } = await loadApp();
  const row = { id: 'single-1', name: 'Pikachu', status: 'Available', qty: 1 };
  const meta = readyMeta(ctx);
  assert.equal(ctx.kjrListingReadiness(row, meta, 'singles').ready, true);
  row.qty = 2;
  assert.equal(ctx.kjrListingReadiness(row, meta, 'singles').ready, false);
  row.qty = 'unknown';
  assert.equal(ctx.kjrListingReadiness(row, meta, 'singles').ready, false);
  row.qty = 1;
  row.status = 'Sold';
  assert.equal(ctx.kjrListingReadiness(row, meta, 'singles').ready, false);
  row.status = 'Available';
  const duplicate = readyMeta(ctx, { photo: { ...meta.photo, back: meta.photo.front } });
  assert.equal(ctx.kjrListingReadiness(row, duplicate, 'singles').ready, false);
  const held = readyMeta(ctx, { holdReason: 'Confirm exact copy' });
  assert.equal(ctx.kjrListingReadiness(row, held, 'singles').ready, false);
  const sold = readyMeta(ctx, { listingStatus: 'sold' });
  assert.equal(ctx.kjrListingReadiness(row, sold, 'singles').ready, false);
});

test('listing metadata rejects unsafe photo references, invalid URLs and boundary prices', async () => {
  const { ctx } = await loadApp();
  const badRefs = ['/tmp/card.jpg', '../card.jpg', 'https://example.com/card.jpg', 'photos/%252fsecret.jpg', 'photos/%255csecret.jpg', 'photos/%252e%252e/secret.jpg'];
  for (const ref of badRefs) {
    const result = ctx.kjrListingValidateMeta({ photo: { status: 'ready', front: ref, back: 'back.jpg' } });
    assert.equal(result.ok, false, ref);
  }
  const longRef = 'x'.repeat(241) + '.jpg';
  assert.equal(ctx.kjrListingValidateMeta({ photo: { front: longRef, back: 'back.jpg' } }).ok, false);
  assert.equal(ctx.kjrListingValidateMeta({ proposedAsk: 0 }).ok, false);
  assert.equal(ctx.kjrListingValidateMeta({ proposedAsk: 0.001 }).ok, false);
  assert.equal(ctx.kjrListingValidateMeta({ approvedAsk: 'Infinity' }).ok, false);
  assert.equal(ctx.kjrListingValidateMeta({ history: [{ url: 'https://evil.example/p/1' }] }).ok, false);
});

test('listing handoff uses exact baselines, rejects stale inventory and changes metadata only', async () => {
  const { ctx, grab } = await loadApp();
  const db = grab('DB').DB;
  const row = { id: 'single-1', name: 'Pikachu', status: 'Available', qty: 1, listPrice: 9, marketPrice: 8, carousellUrl: 'https://www.carousell.sg/p/existing-1' };
  db.singles = [row];
  db.slabs = [];
  grab('_kjrListingSelected')._kjrListingSelected.add('singles::single-1');
  const packet = ctx.kjrBuildListingHandoff();
  assert.equal(packet.records.length, 1);
  assert.equal(packet.records[0].baseline.fingerprint, ctx.kjrListingRowFingerprint(row));
  packet.records[0].listingMeta = readyMeta(ctx, { listingStatus: 'listed', history: [] });
  const preview = ctx.kjrPreflightListingImport(packet);
  assert.equal(preview.ok, true);
  assert.equal(preview.changes.length, 1);
  assert.ok(preview.warnings.some(warning => warning.includes('reported')));
  row.listPrice = 10;
  assert.equal(ctx.kjrPreflightListingImport(packet).ok, false);
});

test('listing import preserves existing stock fields and imported evidence stays reported, undo restores the row', async () => {
  const { ctx, grab } = await loadApp();
  const db = grab('DB').DB;
  const row = { id: 'single-2', name: 'Eevee', status: 'Available', qty: 1, listPrice: 20, marketPrice: 18, carousellUrl: 'https://www.carousell.sg/p/existing-2' };
  db.singles = [row];
  db.slabs = [];
  ctx.saveData();
  grab('_kjrListingSelected')._kjrListingSelected.add('singles::single-2');
  const packet = ctx.kjrBuildListingHandoff();
  packet.records[0].listingMeta = readyMeta(ctx, {
    listingStatus: 'listed',
    priceEvidence: { ref: 'provider-receipt', basis: 'imported note', observedAt: '2026-09-19', sourceStatus: 'verified' },
    history: [{ url: 'https://www.carousell.sg/p/existing-2', price: 25, photoRefs: { front: 'front.jpg', back: 'back.jpg', extras: [] }, description: 'Reported listing', observedAt: '2026-09-19T00:00:00.000Z', basis: 'pasted packet', listingStatus: 'listed', verification: 'verified' }]
  });
  const report = await ctx.kjrApplyListingImport(packet);
  assert.equal(report.ok, true);
  assert.equal(db.singles[0].listPrice, 20);
  assert.equal(db.singles[0].qty, 1);
  assert.equal(db.singles[0].status, 'Available');
  assert.equal(db.singles[0].carousellUrl, 'https://www.carousell.sg/p/existing-2');
  assert.equal(db.singles[0].listingMeta.priceEvidence.sourceStatus, 'reported');
  assert.equal(db.singles[0].listingMeta.history[0].verification, 'reported');
  await ctx.undoLast();
  assert.equal(grab('DB').DB.singles[0].listingMeta, undefined);
});

test('listing import waits for a running dirty flush, follows with the selected row and skips clean tables', async () => {
  const selectedSeed = { id: 'listing-target', name: 'Serperior', status: 'Available', qty: 1 };
  const queuedSeed = { id: 'legacy-queued-row', name: 'Pikachu', status: 'Available', qty: 1 };
  const lateSeed = { id: 'late-legacy-row', name: 'Eevee', status: 'Available', qty: 1 };
  const cleanSlab = { id: 'clean-slab-row', name: 'Clean slab', status: 'Available', qty: 1 };
  const loaded = await loadApp({ seed: { singles: [selectedSeed, queuedSeed, lateSeed], slabs: [cleanSlab] } });
  const { ctx, grab, fetchMock, settle } = loaded;
  const db = grab('DB').DB;
  fetchMock.calls.length = 0;
  ctx.markDirty('singles', queuedSeed.id, db.singles.find(row => row.id === queuedSeed.id));

  let requestNo = 0;
  let releaseFirst;
  let releaseSecond;
  let firstStartedResolve;
  let secondStartedResolve;
  const firstStarted = new Promise(resolve => { firstStartedResolve = resolve; });
  const secondStarted = new Promise(resolve => { secondStartedResolve = resolve; });
  fetchMock.route('/sync/v2/mutate', (url, opts) => {
    requestNo++;
    if (requestNo === 1) {
      firstStartedResolve();
      return new Promise(resolve => { releaseFirst = () => resolve(syncSuccessResponse(opts)); });
    }
    if (requestNo === 2) {
      secondStartedResolve();
      return new Promise(resolve => { releaseSecond = () => resolve(syncSuccessResponse(opts)); });
    }
    return syncSuccessResponse(opts);
  });
  const firstFlush = ctx._flushDirtyToSupabase();
  await firstStarted;

  grab('_kjrListingSelected')._kjrListingSelected.add('singles::' + selectedSeed.id);
  const packet = ctx.kjrBuildListingHandoff();
  packet.records[0].listingMeta = readyMeta(ctx, { draft: { title: 'Imported Serperior', description: 'Imported draft' } });
  let fullSaveCalls = 0;
  ctx.saveAllToSupabase = () => {
    fullSaveCalls++;
    return Promise.reject(new Error('listing import must not call saveAllToSupabase'));
  };

  let finished = false;
  const applying = ctx.kjrApplyListingImport(packet).then(report => {
    finished = true;
    return report;
  });
  await settle();
  assert.equal(finished, false, 'import remains pending while the older dirty flush is in flight');
  assert.equal(syncCalls(fetchMock).length, 1, 'the follow-up request waits for the running request');

  releaseFirst();
  await firstFlush;
  await secondStarted;
  ctx.markDirty('singles', lateSeed.id, db.singles.find(row => row.id === lateSeed.id));
  releaseSecond();
  const report = await applying;
  assert.equal(report.persistence.confirmed, false,
    'a dirty row added after the selected follow-up snapshot keeps the result pending');
  assert.equal(fullSaveCalls, 0, 'listing import never invokes the full-library save');
  const batches = syncCalls(fetchMock).map(call => syncRequest(call.opts).operations);
  assert.deepEqual(batches.map(batch => batch.map(operation => operation.id)), [
    [queuedSeed.id], [selectedSeed.id],
  ]);
  assert.equal(batches.some(batch => batch.some(operation => operation.id === cleanSlab.id)), false,
    'clean rows in other tables are excluded');
  assert.equal(db.singles.find(row => row.id === selectedSeed.id).listingMeta.draft.title, 'Imported Serperior');
  assert.equal(Number.isSafeInteger(db.singles.find(row => row.id === selectedSeed.id)._serverVersion), true,
    'the selected row still receives the cloud acknowledgement');
  assert.equal(grab('_dirty')._dirty.singles.has(selectedSeed.id), false);
  assert.equal(grab('_dirty')._dirty.singles.has(queuedSeed.id), false);
  assert.equal(grab('_dirty')._dirty.singles.has(lateSeed.id), true,
    'a late unrelated dirty marker remains queued for its own later flush');
});

test('listing import keeps local metadata and its dirty marker when targeted cloud persistence fails', async () => {
  const { ctx, grab, localStorage, fetchMock } = await loadApp({
    seed: { singles: [{ id: 'listing-cloud-error', name: 'Umbreon', status: 'Available', qty: 1 }], slabs: [] },
  });
  const row = grab('DB').DB.singles[0];
  grab('_kjrListingSelected')._kjrListingSelected.add('singles::' + row.id);
  const packet = ctx.kjrBuildListingHandoff();
  packet.records[0].listingMeta = readyMeta(ctx, { draft: { title: 'Saved locally', description: 'Cloud retry required' } });
  fetchMock.calls.length = 0;
  fetchMock.reject('/sync/v2/mutate', new TypeError('offline'));

  const report = await ctx.kjrApplyListingImport(packet);
  assert.equal(report.persistence.confirmed, false);
  assert.equal(report.persistence.status, 'error');
  const savedRow = grab('DB').DB.singles.find(candidate => candidate.id === row.id);
  assert.equal(savedRow.listingMeta.draft.title, 'Saved locally');
  assert.equal(grab('_dirty')._dirty.singles.has(row.id), true);
  const cached = JSON.parse(localStorage.getItem('pokeinventory_v3'));
  assert.equal(cached.singles.find(candidate => candidate.id === row.id).listingMeta.draft.title, 'Saved locally');
  assert.equal(syncCalls(fetchMock).length, 1);
});

test('dirty persistence caps CAS batches at 100 and clears every queued row', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: 'queued-listing-' + index,
    name: 'Queued card ' + index,
    status: 'Available',
    qty: 1,
  }));
  const loaded = await loadApp({ seed: { singles: rows, slabs: [] } });
  const { ctx, grab, fetchMock } = loaded;
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  rows.forEach(row => ctx.markDirty('singles', row.id, row));

  const result = await ctx._flushDirtyToSupabase();
  assert.equal(result.confirmed, true);
  const batches = syncCalls(fetchMock).map(call => syncRequest(call.opts).operations);
  assert.deepEqual(batches.map(batch => batch.length), [100, 1]);
  assert.equal(new Set(batches.flat().map(operation => operation.id)).size, 101);
  assert.equal(grab('_dirty')._dirty.singles.size, 0);
});

test('listing tracker renders empty and many long rows with readable identity refs', async () => {
  const { ctx, grab, document } = await loadApp();
  const db = grab('DB').DB;
  db.slabs = [];
  db.singles = Array.from({ length: 24 }, (_, index) => ({
    id: 'single-' + index,
    name: index === 23 ? 'Very long card name '.repeat(25) : 'Card ' + index,
    status: 'Available',
    qty: index === 4 ? 2 : 1,
    listingMeta: index === 23 ? { photo: { folderRef: 'photos v2/' + 'long-folder/'.repeat(12) } } : undefined
  }));
  ctx.renderListingTracker();
  const body = document.getElementById('lst-tracker-body');
  assert.match(body.innerHTML, /single-23/);
  assert.match(body.innerHTML, /Very long card name/);
  assert.match(body.innerHTML, /qty &gt; 1 needs one-copy identity/);
  document.getElementById('lst-tracker-search').value = 'does-not-exist';
  ctx.renderListingTracker();
  assert.equal(document.getElementById('lst-tracker-empty').hidden, false);
});

test('listing suggested ask controls stay synchronised without touching current inventory price', async () => {
  const { ctx, document } = await loadApp();
  document.getElementById('lst-price').value = '12';
  ctx.lstSyncSuggestedAsk('12');
  assert.equal(document.getElementById('lst-proposed-ask').value, '12');
  ctx.lstSyncSuggestedAsk('15', true);
  assert.equal(document.getElementById('lst-price').value, '15');
  assert.equal(document.getElementById('lst-current-price').value, '');
});

test('listing form keeps invalid asks visible to validation and allows an intentional clear', async () => {
  const { ctx, document } = await loadApp();
  const existing = readyMeta(ctx, { proposedAsk: 19, approvedAsk: 19 });
  document.getElementById('lst-proposed-ask').value = '0';
  document.getElementById('lst-price').value = '19';
  const invalid = ctx._kjrListingReadForm(existing);
  assert.equal(ctx.kjrListingValidateMeta(invalid).ok, false);
  document.getElementById('lst-proposed-ask').value = '';
  document.getElementById('lst-price').value = '19';
  const cleared = ctx._kjrListingReadForm(existing);
  assert.equal(cleared.proposedAsk, null);
});

test('listing import requires complete metadata and never replaces existing history with sparse or missing data', async () => {
  const { ctx, grab } = await loadApp();
  const db = grab('DB').DB;
  const existing = readyMeta(ctx, {
    history: [{ url: 'https://www.carousell.sg/p/old', price: 20, photoRefs: { folderRef: 'photos v2', front: 'old-front.jpg', back: 'old-back.jpg', extras: [] }, description: 'Old receipt', observedAt: '2026-09-18T00:00:00.000Z', basis: 'owner note', listingStatus: 'listed', verification: 'reviewed' }]
  });
  const row = { id: 'single-import-shape', name: 'Raichu', status: 'Available', qty: 1, listingMeta: existing };
  db.singles = [row]; db.slabs = [];
  grab('_kjrListingSelected')._kjrListingSelected.add('singles::single-import-shape');
  const packet = ctx.kjrBuildListingHandoff();
  delete packet.records[0].listingMeta;
  assert.equal(ctx.kjrPreflightListingImport(packet).ok, false);
  packet.records[0].listingMeta = {};
  assert.equal(ctx.kjrPreflightListingImport(packet).ok, false);
  assert.equal(row.listingMeta.history[0].url, 'https://www.carousell.sg/p/old');
  packet.records[0].listingMeta = null;
  await assert.rejects(() => ctx.kjrApplyListingImport(packet));
  assert.equal(row.listingMeta.history[0].url, 'https://www.carousell.sg/p/old');
});

test('listing import rejects a supplied row version when the current version is unavailable', async () => {
  const { ctx, grab } = await loadApp();
  const db = grab('DB').DB;
  const row = { id: 'single-version-guard', name: 'Mew', status: 'Available', qty: 1 };
  db.singles = [row]; db.slabs = [];
  grab('_kjrListingSelected')._kjrListingSelected.add('singles::single-version-guard');
  const packet = ctx.kjrBuildListingHandoff();
  packet.records[0].baseline.rowVersion = 3;
  const report = ctx.kjrPreflightListingImport(packet);
  assert.equal(report.ok, false);
  assert.match(report.errors[0], /row version is unavailable/);
  row._serverVersion = '3';
  assert.equal(ctx.kjrPreflightListingImport(packet).ok, false);
});

test('malformed stored metadata remains held and requires an explicit repair before handoff or save', async () => {
  const { ctx, grab, document } = await loadApp();
  const db = grab('DB').DB;
  const malformed = { photo: { front: '../private.jpg' }, history: 'not-an-array' };
  const row = { id: 'single-malformed-meta', name: 'Gengar', status: 'Available', qty: 1, listingMeta: malformed };
  db.singles = [row]; db.slabs = [];
  assert.equal(ctx._kjrListingMetaState(row).ok, false);
  grab('_kjrListingSelected')._kjrListingSelected.add('singles::single-malformed-meta');
  assert.throws(() => ctx.kjrBuildListingHandoff(), /repair listing metadata first/);
  document.getElementById('lst-item').value = 'singles:single-malformed-meta';
  ctx.lstSaveTrackerRecord();
  assert.deepEqual(row.listingMeta, malformed);
});

test('listing import preflight exposes photo, ask, draft and history changes', async () => {
  const { ctx, grab } = await loadApp();
  const db = grab('DB').DB;
  const row = { id: 'single-diff', name: 'Serperior', status: 'Available', qty: 1, listingMeta: readyMeta(ctx, { history: [{ url: 'https://www.carousell.sg/p/old', price: 20, photoRefs: { folderRef: 'photos v2', front: 'old.jpg', back: 'old-back.jpg', extras: [] }, description: 'Old', observedAt: '2026-09-18T00:00:00.000Z', basis: 'old', listingStatus: 'listed', verification: 'reviewed' }] }) };
  db.singles = [row]; db.slabs = [];
  grab('_kjrListingSelected')._kjrListingSelected.add('singles::single-diff');
  const packet = ctx.kjrBuildListingHandoff();
  packet.records[0].listingMeta = readyMeta(ctx, {
    photo: { status: 'ready', folderRef: 'photos v2', front: 'new-front.jpg', back: 'new-back.jpg', extras: [], photoItemId: 'photo-2' },
    proposedAsk: 28, approvedAsk: 25,
    draft: { title: 'Serperior new title', description: 'New description' },
    history: [{ url: 'https://www.carousell.sg/p/new', price: 25, photoRefs: { folderRef: 'photos v2', front: 'new-front.jpg', back: 'new-back.jpg', extras: [] }, description: 'New', observedAt: '2026-09-19T00:00:00.000Z', basis: 'new', listingStatus: 'listed', verification: 'reviewed' }]
  });
  const report = ctx.kjrPreflightListingImport(packet);
  assert.equal(report.ok, true);
  assert.ok(report.changes[0].diff.some(line => line.includes('photos:')));
  assert.ok(report.changes[0].diff.some(line => line.includes('proposed ask')));
  assert.ok(report.changes[0].diff.some(line => line.includes('approved ask')));
  assert.ok(report.changes[0].diff.some(line => line.includes('draft title changed')));
  assert.ok(report.changes[0].diff.some(line => line.includes('draft description changed')));
  assert.ok(report.changes[0].diff.some(line => line.includes('history entries added')));
  assert.ok(report.changes[0].diff.some(line => line.includes('history entries removed')));
});

test('apply import requires a fresh explicit preview after packet text changes', async () => {
  const { ctx, grab, document } = await loadApp();
  const db = grab('DB').DB;
  const row = { id: 'single-preview-gate', name: 'Umbreon', status: 'Available', qty: 1, listingMeta: readyMeta(ctx) };
  db.singles = [row]; db.slabs = [];
  ctx.saveData();
  grab('_kjrListingSelected')._kjrListingSelected.add('singles::single-preview-gate');
  const packet = ctx.kjrBuildListingHandoff();
  packet.records[0].listingMeta = readyMeta(ctx, { draft: { title: 'Changed', description: 'Changed description' } });
  const input = document.getElementById('lst-handoff-input');
  input.value = JSON.stringify(packet);
  ctx.lstPreviewImport();
  input.value += ' ';
  await ctx.lstApplyImport();
  assert.equal(row.listingMeta.draft.title, 'Pikachu');
  assert.match(document.getElementById('lst-import-status').textContent, /Preview import again/);
});

test('listing editor and import preserve another tab change and reject same-row stale writes', async () => {
  const first = await loadApp();
  const storage = first.localStorage;
  const row1 = { id: 'shared-row-1', name: 'Eevee', status: 'Available', qty: 1, listingMeta: readyMeta(first.ctx, { draft: { title: 'Before', description: 'Before' }, proposedAsk: 9, approvedAsk: 9 }) };
  const row2 = { id: 'shared-row-2', name: 'Vaporeon', status: 'Available', qty: 1, listingMeta: readyMeta(first.ctx, { draft: { title: 'Second', description: 'Second' }, proposedAsk: 11, approvedAsk: 11 }) };
  const row3 = { id: 'shared-row-3', name: 'Jolteon', status: 'Available', qty: 1, listingMeta: readyMeta(first.ctx, { draft: { title: 'Untouched', description: 'Untouched' }, proposedAsk: 13, approvedAsk: 13 }) };
  first.grab('DB').DB.singles = [row1, row2, row3]; first.grab('DB').DB.slabs = []; first.ctx.saveData();
  const second = await loadApp({ storage, seed: null });
  second.grab('DB').DB.singles = second.grab('DB').DB.singles.map(row => row.id === row1.id ? { ...row, listingMeta: readyMeta(second.ctx, { draft: { title: 'Before', description: 'Before' }, proposedAsk: 9, approvedAsk: 9 }) } : row);
  second.ctx._kjrListingLoadEditor('singles', second.grab('DB').DB.singles[0]);
  first.ctx._kjrListingLoadEditor('singles', first.grab('DB').DB.singles[0]);
  second.grab('_kjrListingSelected')._kjrListingSelected.add('singles::' + row1.id);
  const staleImportPacket = second.ctx.kjrBuildListingHandoff();
  const firstMeta = readyMeta(first.ctx, { draft: { title: 'First wins', description: 'A' }, proposedAsk: 12, approvedAsk: 12 });
  await first.ctx._kjrListingCommitMeta('singles', row1.id, firstMeta);
  const staleImport = await second.ctx.kjrApplyListingImport(staleImportPacket).catch(error => ({ ok: false, error }));
  assert.equal(staleImport.ok, false);
  const staleMeta = readyMeta(second.ctx, { draft: { title: 'Stale overwrite', description: 'B' }, proposedAsk: 8, approvedAsk: 8 });
  const staleResult = await second.ctx._kjrListingCommitMeta('singles', row1.id, staleMeta);
  assert.equal(staleResult, false);
  const storedAfterSame = JSON.parse(storage.getItem('pokeinventory_v3'));
  assert.equal(storedAfterSame.singles.find(row => row.id === row1.id).listingMeta.draft.title, 'First wins');

  const untouchedBefore = JSON.stringify(second.grab('DB').DB.singles.find(row => row.id === row3.id));
  second.ctx.markDirty('singles', row3.id, second.grab('DB').DB.singles.find(row => row.id === row3.id));
  assert.equal(second.grab('_dirty')._dirty.singles.has(row3.id), true);
  second.ctx._kjrListingLoadEditor('singles', second.grab('DB').DB.singles.find(row => row.id === row2.id));
  const row2Packet = second.ctx.kjrBuildListingHandoff ? (() => {
    second.grab('_kjrListingSelected')._kjrListingSelected.clear();
    second.grab('_kjrListingSelected')._kjrListingSelected.add('singles::' + row2.id);
    return second.ctx.kjrBuildListingHandoff();
  })() : null;
  row2Packet.records[0].listingMeta = readyMeta(second.ctx, { draft: { title: 'Second updated', description: 'Second updated' }, proposedAsk: 14, approvedAsk: 14 });
  const row2Report = await second.ctx.kjrApplyListingImport(row2Packet).catch(error => ({ ok: false, error }));
  assert.equal(row2Report.ok, true);
  const storedAfterDifferent = JSON.parse(storage.getItem('pokeinventory_v3'));
  assert.equal(storedAfterDifferent.singles.find(row => row.id === row1.id).listingMeta.draft.title, 'First wins');
  assert.equal(storedAfterDifferent.singles.find(row => row.id === row2.id).listingMeta.draft.title, 'Second updated');
  assert.equal(JSON.stringify(storedAfterDifferent.singles.find(row => row.id === row3.id)), untouchedBefore);
  assert.equal(second.grab('_dirty')._dirty.singles.has(row3.id), true);
});

test('listing editor rolls back metadata and dirty state when local cache persistence fails', async () => {
  const { ctx, grab, localStorage } = await loadApp();
  const db = grab('DB').DB;
  const row = { id: 'single-save-quota', name: 'Espeon', status: 'Available', qty: 1, listingMeta: readyMeta(ctx, { draft: { title: 'Before quota', description: 'Before quota' } }) };
  db.singles = [row]; db.slabs = [];
  ctx.saveData();
  ctx._kjrListingLoadEditor('singles', row);
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === 'pokeinventory_v3') throw new Error('quota');
    return originalSetItem.call(localStorage, key, value);
  };
  const result = await ctx._kjrListingCommitMeta('singles', row.id, readyMeta(ctx, { draft: { title: 'Should roll back', description: 'Should roll back' } }));
  assert.equal(result, false);
  assert.equal(row.listingMeta.draft.title, 'Before quota');
  assert.equal(localStorage.getItem('pokeinventory_v3'), beforeCache);
});

test('listing bulk import rolls back all rows and preserves an unrelated dirty queue when local cache persistence fails', async () => {
  const { ctx, grab, localStorage } = await loadApp();
  const db = grab('DB').DB;
  const row = { id: 'single-import-quota', name: 'Glaceon', status: 'Available', qty: 1, listingMeta: readyMeta(ctx, { draft: { title: 'Import before', description: 'Import before' } }) };
  const untouched = { id: 'single-import-untouched', name: 'Leafeon', status: 'Available', qty: 1, listingMeta: readyMeta(ctx, { draft: { title: 'Untouched', description: 'Untouched' } }) };
  db.singles = [row, untouched]; db.slabs = [];
  ctx.saveData();
  grab('_kjrListingSelected')._kjrListingSelected.add('singles::' + row.id);
  const packet = ctx.kjrBuildListingHandoff();
  packet.records[0].listingMeta = readyMeta(ctx, { draft: { title: 'Should not persist', description: 'Should not persist' } });
  ctx.markDirty('singles', untouched.id, untouched);
  const beforeCache = localStorage.getItem('pokeinventory_v3');
  const originalSetItem = localStorage.setItem;
  localStorage.setItem = (key, value) => {
    if (key === 'pokeinventory_v3') throw new Error('quota');
    return originalSetItem.call(localStorage, key, value);
  };
  await assert.rejects(() => ctx.kjrApplyListingImport(packet), /saved locally/);
  assert.equal(row.listingMeta.draft.title, 'Import before');
  assert.equal(untouched.listingMeta.draft.title, 'Untouched');
  assert.equal(localStorage.getItem('pokeinventory_v3'), beforeCache);
  assert.equal(grab('_dirty')._dirty.singles.has(untouched.id), true);
});
