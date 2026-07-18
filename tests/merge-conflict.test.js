'use strict';
// Suite 7: merge-conflict (data safety, the most important suite) -
// mergeTable, _rowTime, mergeIntoMemory.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

test('merge-conflict: (a) cloud strictly newer + row in dirtySet -> cloud wins, discarded edit logged, dirty id cleared', async () => {
  const { ctx, localStorage } = await loadApp();
  const localRow = { id: 'x1', name: 'Old Name', costPrice: 100, _updatedAt: '2025-01-01T00:00:00.000Z' };
  const cloudRow = { id: 'x1', name: 'New Name', costPrice: 150, _updatedAt: '2025-06-01T00:00:00.000Z' };
  const dirtySet = new Set(['x1']);
  const result = ctx.mergeTable([cloudRow], [localRow], dirtySet, 'singles');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'New Name', 'cloud copy wins');
  assert.strictEqual(dirtySet.has('x1'), false, 'the discarded local edit is no longer dirty (nothing left to flush)');
  const changelog = JSON.parse(localStorage.getItem('pokeinv_changelog') || '[]');
  assert.ok(changelog.some(e => e.action === 'conflict'), 'a conflict entry was logged to the changelog');
});

test('merge-conflict: (b) local dirty + cloud copy is OLDER -> local kept, stays dirty', async () => {
  const { ctx } = await loadApp();
  const localRow = { id: 'x1', name: 'Local Edit', _updatedAt: '2025-06-01T00:00:00.000Z' };
  const cloudRow = { id: 'x1', name: 'Stale Cloud', _updatedAt: '2025-01-01T00:00:00.000Z' };
  const dirtySet = new Set(['x1']);
  const result = ctx.mergeTable([cloudRow], [localRow], dirtySet, 'singles');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].name, 'Local Edit');
  assert.strictEqual(dirtySet.has('x1'), true, 'still dirty - the local edit has not synced yet');
});

test('merge-conflict: (c) tie timestamps -> local kept (only a STRICTLY newer cloud copy wins)', async () => {
  const { ctx } = await loadApp();
  const sameTs = '2025-06-01T00:00:00.000Z';
  const localRow = { id: 'x1', name: 'Local Version', _updatedAt: sameTs };
  const cloudRow = { id: 'x1', name: 'Cloud Version', _updatedAt: sameTs };
  const dirtySet = new Set(['x1']);
  const result = ctx.mergeTable([cloudRow], [localRow], dirtySet, 'singles');
  assert.strictEqual(result[0].name, 'Local Version');
  assert.strictEqual(dirtySet.has('x1'), true);
});

test('merge-conflict: (d) a cloud-only row (never local, never dirty) appears in the result', async () => {
  const { ctx } = await loadApp();
  const cloudOnly = { id: 'c1', name: 'Cloud Only', _updatedAt: '2025-01-01T00:00:00.000Z' };
  // dirtySet empty -> mergeTable takes its early-return fast path (return cloudRows verbatim).
  const result = ctx.mergeTable([cloudOnly], [], new Set(), 'singles');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].id, 'c1');

  // Also verify it appears when dirtySet is non-empty for an UNRELATED id
  // (exercises the byId-Map path instead of the empty-dirtySet fast path).
  const dirtySet2 = new Set(['some_other_dirty_id']);
  const result2 = ctx.mergeTable([cloudOnly], [{ id: 'some_other_dirty_id', _updatedAt: '2025-01-01T00:00:00.000Z' }], dirtySet2, 'singles');
  assert.ok(result2.some(r => r.id === 'c1'));
});

test('merge-conflict: (e) CHARACTERISATION - a local-only, non-dirty row is silently DROPPED when the cloud is non-empty', async () => {
  const { ctx } = await loadApp();
  // dirtySet is non-empty (some OTHER row is dirty) so mergeTable does NOT
  // take the empty-dirtySet fast path - it builds byId from cloudRows only,
  // and the loop below only ever pulls a LOCAL row into byId when its id is
  // in dirtySet. An "orphan" local row that isn't dirty and isn't on the
  // cloud never gets a chance to be added back in - deletion-propagation
  // semantics: cloud is trusted as the source of truth for anything not
  // actively in flight. This is DATA LOSS from the local row's perspective
  // if it was never actually meant to be deleted (e.g. it was added locally
  // but markDirty was somehow never called for it) - documenting exactly as
  // asked, not fixing.
  const cloudRow = { id: 'c1', _updatedAt: '2025-01-01T00:00:00.000Z' };
  const dirtyElsewhereRow = { id: 'c1', _updatedAt: '2025-01-01T00:00:00.000Z' };
  const orphanLocalOnly = { id: 'orphan', name: 'ghost row', _updatedAt: '2025-01-01T00:00:00.000Z' };
  const dirtySet = new Set(['unrelated_dirty_id']); // non-empty, but does not include "orphan"
  const result = ctx.mergeTable([cloudRow], [dirtyElsewhereRow, orphanLocalOnly], dirtySet, 'singles');
  assert.strictEqual(result.length, 1, 'only the cloud row survives - "orphan" is gone');
  assert.ok(!result.some(r => r.id === 'orphan'), 'the local-only non-dirty row was dropped, not preserved');
});

test('merge-conflict: (f) cloud returns 0 rows + local non-empty -> ALL local rows kept and re-marked dirty (resurrection guard)', async () => {
  const { ctx } = await loadApp();
  const local1 = { id: 'l1', name: 'Keep me 1' };
  const local2 = { id: 'l2', name: 'Keep me 2' };
  const dirtySet = new Set(); // neither row was dirty before this merge
  const result = ctx.mergeTable([], [local1, local2], dirtySet, 'singles');
  assert.strictEqual(result.length, 2);
  assert.deepStrictEqual(result.map(r => r.id).sort(), ['l1', 'l2']);
  // SUSPECT (flagged in the app's own comments too, "M5"): a cloud response
  // of zero rows is indistinguishable at the HTTP level from a transient
  // RLS/schema hiccup and a genuine mass-delete. The guard assumes the
  // former and marks every local row dirty for re-upload - which is safe
  // against accidental data loss, but means a REAL bulk-delete-everything
  // on another device can never actually propagate via a simple empty
  // cloud response; the deleted rows keep resurrecting from any device that
  // still has them locally. Severity: by-design tradeoff, not a bug, but
  // worth remembering next time "sync says empty but rows keep coming back"
  // gets investigated.
  assert.strictEqual(dirtySet.has('l1'), true, 'even though l1 was NOT dirty before, the guard marks it dirty so it re-uploads');
  assert.strictEqual(dirtySet.has('l2'), true);
});

test('merge-conflict: _rowTime is NaN-safe and null-safe', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._rowTime({ _updatedAt: 'not a date' }), 0);
  assert.strictEqual(ctx._rowTime({}), 0);
  assert.strictEqual(ctx._rowTime(null), 0);
  assert.strictEqual(ctx._rowTime(undefined), 0);
  const validMs = ctx._rowTime({ _updatedAt: '2025-06-01T00:00:00.000Z' });
  assert.strictEqual(validMs, new Date('2025-06-01T00:00:00.000Z').getTime());
  assert.strictEqual(ctx._rowTime({ updated: '2025-06-01T00:00:00.000Z' }), validMs, 'falls back to .updated when ._updatedAt is absent');
});

test('merge-conflict: mergeIntoMemory - strictly-newer-wins against a seeded live DB', async () => {
  const { ctx, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Original', costPrice: 10, _updatedAt: '2025-01-01T00:00:00.000Z' }] },
  });
  ctx.mergeIntoMemory('singles', [{ id: 's1', name: 'Updated Elsewhere', costPrice: 20, _updatedAt: '2025-06-01T00:00:00.000Z' }]);
  const { DB } = grab('DB');
  const row = DB.singles.find(r => r.id === 's1');
  assert.strictEqual(row.name, 'Updated Elsewhere', 'strictly newer incoming row wins');
});

test('merge-conflict: mergeIntoMemory - a TIE keeps the current in-memory copy (never overwrites for free on equal timestamps)', async () => {
  const { ctx, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Original', _updatedAt: '2025-06-01T00:00:00.000Z' }] },
  });
  ctx.mergeIntoMemory('singles', [{ id: 's1', name: 'Should Not Win', _updatedAt: '2025-06-01T00:00:00.000Z' }]);
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.find(r => r.id === 's1').name, 'Original');
});

test('merge-conflict: mergeIntoMemory - a brand new incoming row (unseen id) is added', async () => {
  const { ctx, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Original', _updatedAt: '2025-06-01T00:00:00.000Z' }] },
  });
  ctx.mergeIntoMemory('singles', [{ id: 's2', name: 'Brand New', _updatedAt: '2025-06-01T00:00:00.000Z' }]);
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.length, 2);
  assert.ok(DB.singles.some(r => r.id === 's2' && r.name === 'Brand New'));
});
