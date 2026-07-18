'use strict';
// Suite 20: pagination - sbFetchAll / sbFetchPaged.
//
// CORRECTION vs the packet's wording: the packet describes pagination via
// "Range headers". The actual current implementation (app.js sbFetchPaged,
// ~line 360) paginates with `limit=`/`offset=` QUERY PARAMS, not Range/
// Range-Unit headers - the code comment there explains this directly: the
// Cloudflare Worker DB proxy does not forward Range headers, which blocked
// flipping USE_WORKER_DB, so it was switched to limit/offset. The project's
// own CLAUDE.md ("sbFetchAll paginates with Range headers") is stale on this
// point too. Tests below characterise the ACTUAL current behaviour.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

function makePaginatedResponder(totalRows) {
  return async (url) => {
    const u = new URL(url);
    const offset = parseInt(u.searchParams.get('offset') || '0', 10);
    const limit = parseInt(u.searchParams.get('limit') || '1000', 10);
    const rows = [];
    for (let i = offset; i < Math.min(offset + limit, totalRows); i++) {
      rows.push({ id: 'row_' + i, data: { name: 'Row ' + i }, updated_at: '2025-01-01T00:00:00.000Z' });
    }
    return { ok: true, status: 200, json: async () => rows, text: async () => JSON.stringify(rows) };
  };
}

test('pagination: sbFetchAll - 2500 rows requires 3 requests with advancing offset= query params, stops after the short page', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/singles', makePaginatedResponder(2500));
  const rows = await ctx.sbFetchAll('singles');
  assert.strictEqual(rows.length, 2500);
  const paginationCalls = fetchMock.calls.filter((c) => c.url.includes('/rest/v1/singles'));
  assert.strictEqual(paginationCalls.length, 3, '1000 + 1000 + 500 = 3 requests');
  const offsets = paginationCalls.map((c) => new URL(c.url).searchParams.get('offset'));
  assert.deepStrictEqual(offsets, ['0', '1000', '2000'], 'offset advances by the page size each request');
  assert.ok(paginationCalls.every((c) => c.url.includes('limit=1000')));
  assert.ok(!paginationCalls.some((c) => c.url.match(/[Rr]ange/) && c.opts && c.opts.headers && c.opts.headers.Range), 'no Range header is used at all - confirms the limit/offset characterisation above');
});

test('pagination: sbFetchAll - the row shape flattens {id, data, updated_at} into {id, ...data, _updatedAt}', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/rest/v1/singles', makePaginatedResponder(1));
  const rows = await ctx.sbFetchAll('singles');
  assert.strictEqual(rows[0].id, 'row_0');
  assert.strictEqual(rows[0].name, 'Row 0');
  assert.strictEqual(rows[0]._updatedAt, '2025-01-01T00:00:00.000Z');
});

test('pagination: SUSPECT - exactly 1000 rows (landing exactly on the page boundary) costs one extra, empty confirmation request', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/singles', makePaginatedResponder(1000));
  const rows = await ctx.sbFetchAll('singles');
  assert.strictEqual(rows.length, 1000);
  const paginationCalls = fetchMock.calls.filter((c) => c.url.includes('/rest/v1/singles'));
  // A full first page (exactly PAGE=1000 rows) does not itself signal "end of
  // data" (only rows.length < PAGE does), so the loop always issues a SECOND
  // request at offset=1000 purely to confirm there's nothing more, which
  // then comes back empty. Harmless (one extra cheap round-trip), but worth
  // knowing when diagnosing "why did that only-1000-rows table make 2
  // requests" during a network-usage investigation.
  assert.strictEqual(paginationCalls.length, 2, 'one full page + one empty confirmation page');
});

test('pagination: fetch error mid-pagination - sbFetchPaged THROWS (does not silently return the partial rows collected so far)', async () => {
  const { ctx, fetchMock } = await loadApp();
  let call = 0;
  fetchMock.route('/rest/v1/singles', async () => {
    call++;
    if (call === 1) {
      const rows = Array.from({ length: 1000 }, (_, i) => ({ id: 'row_' + i, data: {}, updated_at: '2025-01-01T00:00:00.000Z' }));
      return { ok: true, status: 200, json: async () => rows };
    }
    return { ok: false, status: 500, text: async () => 'server exploded on page 2' };
  });
  await assert.rejects(() => ctx.sbFetchAll('singles'), /server exploded on page 2/, 'a mid-pagination failure propagates as a rejection - the 1000 rows already fetched are discarded, not returned partially');
});
