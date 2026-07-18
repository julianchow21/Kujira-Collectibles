'use strict';
// Suite 8: dirty-persistence - markDirty, _loadDirtyFromLS / _persistDirty
// round-trip via localStorage 'pokeinv_dirty_v1', corrupt JSON survival.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

test('dirty-persistence: markDirty adds the id to the in-memory dirty set for that table', async () => {
  const { ctx, grab } = await loadApp();
  ctx.markDirty('singles', 'abc123');
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('abc123'), true);
});

test('dirty-persistence: markDirty persists to localStorage "pokeinv_dirty_v1"', async () => {
  const { ctx, localStorage } = await loadApp();
  ctx.markDirty('slabs', 'slab_1');
  const raw = localStorage.getItem('pokeinv_dirty_v1');
  assert.ok(raw, 'dirty set must be persisted synchronously, not just kept in memory');
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.slabs) && parsed.slabs.includes('slab_1'));
});

test('dirty-persistence: markDirty on an unknown table is a safe no-op (not a throw)', async () => {
  const { ctx } = await loadApp();
  assert.doesNotThrow(() => ctx.markDirty('not_a_real_table', 'x'));
});

test('dirty-persistence: _loadDirtyFromLS restores a seeded dirty set on a fresh loadApp', async () => {
  const { grab } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['s1', 's2'], slabs: ['sl1'] }) },
  });
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('s1'), true);
  assert.strictEqual(_dirty.singles.has('s2'), true);
  assert.strictEqual(_dirty.slabs.has('sl1'), true);
  assert.strictEqual(_dirty.sales.size, 0, 'tables not present in the seeded blob start empty, not undefined/throwing');
});

test('dirty-persistence: corrupt JSON in "pokeinv_dirty_v1" does not throw and falls back to empty sets', async () => {
  const { grab } = await loadApp({
    localStorage: { pokeinv_dirty_v1: 'not valid json {{{' },
  });
  const { _dirty } = grab('_dirty');
  for (const table of ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases']) {
    assert.ok(_dirty[table] instanceof Set || typeof _dirty[table].add === 'function', `${table} dirty set must still be a working Set-like`);
    assert.strictEqual(_dirty[table].size, 0);
  }
});

test('dirty-persistence: a fresh loadApp with no seeded dirty key starts with all tables empty', async () => {
  const { grab } = await loadApp();
  const { _dirty } = grab('_dirty');
  const total = Object.values(_dirty).reduce((s, set) => s + set.size, 0);
  assert.strictEqual(total, 0);
});
