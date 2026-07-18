'use strict';
// Suite 9: flush-guard - regression coverage for a real past data-loss bug.
// _flushDirtyToSupabase MUST bail at the top on a localhost preview WITHOUT
// clearing dirty flags (a guard-skipped upsert must never read as "synced").
//
// Note: loadApp() itself triggers initDB()'s own cloud-read attempts
// (sbFetchAll for all 7 tables) and the FX-rate fetches - none of those are
// gated by isLocalhostPreview() (only WRITES are guarded, reads are not,
// confirmed by running this against a localhost location below and still
// seeing load-time fetch attempts). So every test here resets
// fetchMock.calls to [] right after loadApp() resolves, and only inspects
// calls made by the explicit _flushDirtyToSupabase() call under test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const LOCALHOST_LOCATION = {
  protocol: 'http:', hostname: 'localhost', host: 'localhost:3800',
  href: 'http://localhost:3800/', origin: 'http://localhost:3800',
  pathname: '/', search: '',
};

test('flush-guard: localhost preview -> _flushDirtyToSupabase makes ZERO fetch calls and does NOT clear the dirty flag', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  assert.strictEqual(ctx.isLocalhostPreview(), true, 'sanity check the location shim is actually read as a localhost preview');
  fetchMock.calls.length = 0; // drop load-time reads (sbFetchAll/FX rate), not gated by the preview guard
  await ctx._flushDirtyToSupabase();
  assert.strictEqual(fetchMock.calls.length, 0, 'the preview guard must bail BEFORE any network attempt');
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('single_seed_1'), true, 'dirty flag survives - a guard-skipped write must never be treated as synced');
});

test('flush-guard: github.io + successful upserts -> dirty flags clear, requests hit the correct snake_case table names', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  assert.strictEqual(ctx.isLocalhostPreview(), false);
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: true, status: 200, json: {} });
  await ctx._flushDirtyToSupabase();
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('single_seed_1'), false, 'dirty flag cleared after a real successful upsert');
  const upsertCalls = fetchMock.calls.filter(c => c.url.includes('/rest/v1/singles') && c.opts && c.opts.method === 'POST');
  assert.ok(upsertCalls.length >= 1, 'a POST upsert request was made against the singles table');
});

test('flush-guard: fetch failure during flush -> dirty flags are RETAINED, not cleared', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: false, status: 500, text: 'server exploded' });
  await ctx._flushDirtyToSupabase();
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('single_seed_1'), true, 'a failed upsert must leave the row dirty so the next saveData() retries it');
});

test('flush-guard: only tables with actually-dirty rows get an upsert request', async () => {
  const { ctx, fetchMock } = await loadApp({
    seed: {
      singles: [{ id: 'single_seed_1', name: 'A', status: 'Available' }],
      slabs: [{ id: 'slab_1', name: 'B', status: 'Available' }],
    },
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) }, // slabs NOT dirty
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: true, json: {} });
  await ctx._flushDirtyToSupabase();
  const posts = fetchMock.calls.filter(c => c.opts && c.opts.method === 'POST');
  assert.ok(posts.some(c => c.url.includes('/rest/v1/singles')));
  assert.ok(!posts.some(c => c.url.includes('/rest/v1/slabs')), 'slabs had no dirty rows, so it must not sync at all');
});
