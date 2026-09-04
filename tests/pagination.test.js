'use strict';
// Suite 20: complete-table reads through the owner-authenticated sync v2 pull.
// The Worker now owns server-side pagination and returns one atomic snapshot,
// so the browser must preserve large tables without issuing legacy REST pages.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, syncPullResponse } = require('./harness.js');

function makeSyncPullResponder(totalRows) {
  const rows = Array.from({ length: totalRows }, (_, index) => ({
    id: 'row_' + index,
    data: { name: 'Row ' + index },
    row_version: 1,
    updated_at: '2025-01-01T00:00:00.000Z',
  }));
  return () => syncPullResponse({ singles: rows });
}

test('pagination: sbFetchAll preserves all 2500 rows from one server-paginated sync snapshot', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/pull', makeSyncPullResponder(2500));
  const rows = await ctx.sbFetchAll('singles');
  assert.strictEqual(rows.length, 2500);
  assert.strictEqual(rows[2499].id, 'row_2499');
  const pulls = fetchMock.calls.filter(call => call.url.includes('/sync/v2/pull'));
  assert.strictEqual(pulls.length, 1, 'the Worker supplies one complete atomic snapshot');
  assert.strictEqual(JSON.parse(pulls[0].opts.body).client_protocol, 2);
  assert.strictEqual(fetchMock.calls.some(call => call.url.includes('/rest/v1/singles')), false);
});

test('pagination: sbFetchAll - the row shape flattens {id, data, updated_at} into {id, ...data, _updatedAt}', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/sync/v2/pull', makeSyncPullResponder(1));
  const rows = await ctx.sbFetchAll('singles');
  assert.strictEqual(rows[0].id, 'row_0');
  assert.strictEqual(rows[0].name, 'Row 0');
  assert.strictEqual(rows[0]._serverVersion, 1);
  assert.strictEqual(rows[0]._updatedAt, '2025-01-01T00:00:00.000Z');
});

test('pagination: exactly 1000 rows still requires only one atomic sync pull', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/pull', makeSyncPullResponder(1000));
  const rows = await ctx.sbFetchAll('singles');
  assert.strictEqual(rows.length, 1000);
  assert.strictEqual(fetchMock.calls.filter(call => call.url.includes('/sync/v2/pull')).length, 1);
});

test('pagination: failed atomic sync pull rejects instead of returning a partial table', async () => {
  const { ctx, fetchMock, grab } = await loadApp();
  const before = grab('DB').DB.singles.map(row => ({ ...row }));
  fetchMock.route('/sync/v2/pull', () => jsonResponse({ ok: false, code: 'server_error' }, 500));
  await assert.rejects(() => ctx.sbFetchAll('singles'), /invalid_sync_response/,
    'a failed atomic snapshot never exposes partial rows');
  assert.deepStrictEqual(grab('DB').DB.singles.map(row => ({ ...row })), before);
});
