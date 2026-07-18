'use strict';
// Suite 14: refresh-queue - buildRefreshQueue, QUEUE_SCHEMA_VERSION staleness,
// _tcgdexLaneHasWork, and (best-effort) the transport-vs-non-attempt
// classification inside _runTcgdexLane / _runRefreshQueueBody.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

// Drains an async function that awaits sandbox setTimeout-based delays our
// timer shim never fires on its own: repeatedly let a real macrotask tick
// pass (so the sandbox's synchronous/microtask work advances to its next
// setTimeout call) then immediately flush() any newly-pending timeouts.
async function runWithTimerDrain(fn, timers, maxRounds) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < (maxRounds || 40) && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush();
  }
  return p;
}

test('refresh-queue: buildRefreshQueue - slabs->ppt lane, EN numbered singles->tcgdex lane, manual-lane cards excluded', async () => {
  const { ctx } = await loadApp({
    seed: {
      slabs: [{ id: 'sl1', name: 'Charizard', grader: 'PSA', grade: '10', costPrice: 500, status: 'Available' }],
      singles: [
        { id: 's1', name: 'Pikachu 25', language: 'EN', costPrice: 10, status: 'Available' },   // -> tcgdex
        { id: 's2', name: 'Eevee 1', language: 'JP', costPrice: 5, status: 'Available' },        // -> manual (non-EN)
        { id: 's3', name: 'Custom Card', language: 'EN', costPrice: 1, status: 'Available' },    // -> manual (no number)
      ],
    },
  });
  const q = plain(ctx.buildRefreshQueue());
  assert.strictEqual(q.totalRows, 4, 'totalRows counts every eligible row, including manual-lane ones');
  assert.strictEqual(q.totalItems, 2, 'only tcgdex+ppt lane items make it into the ordered queue - manual-lane cards are excluded entirely');
  const ids = q.items.map((i) => i.id).sort();
  assert.deepStrictEqual(ids, ['s1', 'sl1']);
  assert.strictEqual(q.items.find((i) => i.id === 'sl1').lane, 'ppt');
  assert.strictEqual(q.items.find((i) => i.id === 's1').lane, 'tcgdex');
});

test('refresh-queue: buildRefreshQueue - duplicate name+language singles dedupe to one primary + copyTargets, no duplicate ids', async () => {
  const { ctx } = await loadApp({
    seed: {
      singles: [
        { id: 's1', name: 'Pikachu 25', language: 'EN', costPrice: 10, status: 'Available' },
        { id: 's2', name: 'Pikachu 25', language: 'EN', costPrice: 8, status: 'Available' }, // same name+language -> dedupes with s1
      ],
    },
  });
  const q = plain(ctx.buildRefreshQueue());
  assert.strictEqual(q.items.length, 1, 'only ONE primary entry for the duplicate name+language pair');
  assert.strictEqual(q.items[0].id, 's1', 'the higher-cost row (sorted first) becomes the primary');
  assert.deepStrictEqual(q.items[0].copyTargets, [{ id: 's2', table: 'singles' }]);
  const allIds = new Set(q.items.map((i) => i.id));
  assert.strictEqual(allIds.size, q.items.length, 'no duplicate ids in the ordered queue');
});

test('refresh-queue: QUEUE_SCHEMA_VERSION - a stale/old-shape persisted queue is discarded on load', async () => {
  const { ctx, localStorage } = await loadApp({
    localStorage: { pokeinv_refresh_queue: JSON.stringify({ schemaVersion: 1, items: [{ fake: 'old-shape' }] }) },
  });
  const q = ctx.loadQueue();
  assert.strictEqual(q, null, 'a mismatched schemaVersion is treated exactly like "no queue yet"');
  assert.strictEqual(localStorage.getItem('pokeinv_refresh_queue'), null, 'the stale queue is actively removed, not just ignored');
});

test('refresh-queue: QUEUE_SCHEMA_VERSION - a queue with NO version stamp at all (pre-dates the constant) is also discarded', async () => {
  const { ctx } = await loadApp({
    localStorage: { pokeinv_refresh_queue: JSON.stringify({ items: [] }) }, // no schemaVersion key at all
  });
  assert.strictEqual(ctx.loadQueue(), null);
});

test('refresh-queue: QUEUE_SCHEMA_VERSION - a queue matching the CURRENT version loads through unchanged', async () => {
  const { ctx, grab } = await loadApp();
  const { QUEUE_SCHEMA_VERSION } = grab('QUEUE_SCHEMA_VERSION');
  const q = { schemaVersion: QUEUE_SCHEMA_VERSION, items: [{ id: 'x' }], cursor: 0 };
  // Re-load a fresh app instance with this exact version pre-seeded.
  const second = await loadApp({ localStorage: { pokeinv_refresh_queue: JSON.stringify(q) } });
  const loaded = plain(second.ctx.loadQueue());
  assert.strictEqual(loaded.schemaVersion, QUEUE_SCHEMA_VERSION);
  assert.strictEqual(loaded.items.length, 1);
});

test('refresh-queue: _tcgdexLaneHasWork - true when a tcgdex-lane item is not yet priced today, false once all are', async () => {
  const { ctx, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', language: 'EN', status: 'Available', marketPrice: '' }] },
  });
  const today = '2026-07-18';
  const q = { items: [{ lane: 'tcgdex', id: 's1', table: 'singles' }] };
  assert.strictEqual(ctx._tcgdexLaneHasWork(q, today), true, 'unpriced item still needs an attempt');

  const { DB } = grab('DB');
  const row = DB.singles.find((r) => r.id === 's1');
  row.marketPrice = '45';
  row._tcgdexPricedDate = today;
  assert.strictEqual(ctx._tcgdexLaneHasWork(q, today), false, 'priced-today marker means nothing left to do');
});

test('refresh-queue: _tcgdexLaneHasWork - a known miss today does not count as remaining work either', async () => {
  const { ctx } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', language: 'EN', status: 'Available' }] },
  });
  const today = '2026-07-18';
  const q = { items: [{ lane: 'tcgdex', id: 's1', table: 'singles', _tcgdexMissDate: today }] };
  assert.strictEqual(ctx._tcgdexLaneHasWork(q, today), false);
});

test('refresh-queue: _runTcgdexLane - a single-item lane that resolves applies the price and clears the miss marker', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', language: 'EN', status: 'Available', marketPrice: '', priceHistory: [] }] },
  });
  fetchMock.route('/cards?name=', { ok: true, json: [{ id: 'sv3-199' }] });
  fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1 } } });

  const today = new Date().toISOString().slice(0, 10);
  const q = { items: [{ lane: 'tcgdex', id: 's1', table: 'singles', name: 'Pikachu 25', language: 'EN', tcgdexId: null, copyTargets: [] }] };
  // Single-item lane: the TCGDEX_GAP_MS wait is only awaited BETWEEN items
  // (`if (i < todo.length - 1)`), so a lane of exactly 1 has no gap-wait to
  // drain and can simply be awaited directly.
  const result = await ctx._runTcgdexLane(q, false, today);
  assert.strictEqual(result.done, 1);
  assert.strictEqual(result.failedData, 0);
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.find((r) => r.id === 's1').marketPrice, '45');
});

test('refresh-queue: _runTcgdexLane - a miss stamps _tcgdexMissDate on both the queue item and the live DB row', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    seed: { singles: [{ id: 's1', name: 'Pikachu 25', language: 'EN', status: 'Available' }] },
  });
  fetchMock.route('/cards?name=', { ok: true, json: [] }); // zero candidates -> unresolved miss

  const today = new Date().toISOString().slice(0, 10);
  const q = { items: [{ lane: 'tcgdex', id: 's1', table: 'singles', name: 'Pikachu 25', language: 'EN', tcgdexId: null, copyTargets: [] }] };
  const result = await ctx._runTcgdexLane(q, false, today);
  assert.strictEqual(result.failedData, 1);
  assert.strictEqual(q.items[0]._tcgdexMissDate, today);
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.find((r) => r.id === 's1')._tcgdexMissDate, today, 'mirrored onto the live row for _kjrUnresolvedSingles to see');
});

test('refresh-queue: _runTcgdexLane - a TWO item lane exercises the inter-item gap-wait (timer-drain), one hit + one miss', async () => {
  const { ctx, fetchMock, timers, grab } = await loadApp({
    seed: {
      singles: [
        { id: 's1', name: 'Pikachu 25', language: 'EN', status: 'Available', marketPrice: '', priceHistory: [] },
        { id: 's2', name: 'Eevee 999', language: 'EN', status: 'Available' },
      ],
    },
  });
  fetchMock.route('/cards?name=Pikachu', { ok: true, json: [{ id: 'sv3-199' }] });
  fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  fetchMock.route('/cards?name=Eevee', { ok: true, json: [] }); // miss
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1 } } });

  const today = new Date().toISOString().slice(0, 10);
  const q = {
    items: [
      { lane: 'tcgdex', id: 's1', table: 'singles', name: 'Pikachu 25', language: 'EN', tcgdexId: null, copyTargets: [] },
      { lane: 'tcgdex', id: 's2', table: 'singles', name: 'Eevee 999', language: 'EN', tcgdexId: null, copyTargets: [] },
    ],
  };
  const result = await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, today), timers);
  assert.strictEqual(result.done, 1);
  assert.strictEqual(result.failedData, 1);
  assert.strictEqual(result.total, 2);
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.find((r) => r.id === 's1').marketPrice, '45');
  assert.strictEqual(DB.singles.find((r) => r.id === 's2')._tcgdexMissDate, today);
});

test('refresh-queue: _runRefreshQueueBody - PPT lane classifies ok vs data-miss vs transport-failure (timer-drained, best-effort)', async () => {
  // This exercises the NON_ATTEMPT-sentinel-stripping classifyResult/tallyErrors
  // closures indirectly (they are not independently callable - private to
  // _runRefreshQueueBody) via their observable effects: an 'ok' item is
  // priced and advances the cursor; a transport failure (HTTP 500) does NOT
  // advance the cursor (kept for retry) and does NOT burn a credit; a clean
  // data-miss ("no match") DOES advance the cursor and burns a credit.
  const { ctx, fetchMock, timers, grab } = await loadApp({
    seed: {
      slabs: [
        { id: 'sl1', name: 'Charizard', grader: 'PSA', grade: '10', costPrice: 500, status: 'Available', marketPrice: '', priceHistory: [] },
        { id: 'sl2', name: 'Blastoise', grader: 'PSA', grade: '9', costPrice: 400, status: 'Available' },
        { id: 'sl3', name: 'Venusaur', grader: 'PSA', grade: '8', costPrice: 300, status: 'Available' },
      ],
    },
  });
  fetchMock.route('search=Charizard', { ok: true, json: { data: [{ name: 'Charizard', number: '4', ebay: { psa10: { avg: 800 } } }] } });
  fetchMock.route('search=Blastoise', { ok: false, status: 500, text: 'server error' }); // transport failure, never burns a credit
  fetchMock.route('search=Venusaur', { ok: true, json: { data: [] } }); // clean "no match" data miss
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1 } } }); // rate=1 keeps maxSgd === maxUsd, easy to predict

  const today = new Date().toISOString().slice(0, 10);
  const q = {
    items: [
      { id: 'sl1', table: 'slabs', lane: 'ppt', name: 'Charizard', grader: 'PSA', grade: '10', language: null, tcgdexId: null, costPrice: 500, copyTargets: [] },
      { id: 'sl2', table: 'slabs', lane: 'ppt', name: 'Blastoise', grader: 'PSA', grade: '9', language: null, tcgdexId: null, costPrice: 400, copyTargets: [] },
      { id: 'sl3', table: 'slabs', lane: 'ppt', name: 'Venusaur', grader: 'PSA', grade: '8', language: null, tcgdexId: null, costPrice: 300, copyTargets: [] },
    ],
    cursor: 0, totalItems: 3, dayCreditsUsed: {},
  };

  await runWithTimerDrain(() => ctx._runRefreshQueueBody(q, 30, false, today, 0), timers, 80);

  const { DB } = grab('DB');
  assert.strictEqual(DB.slabs.find((r) => r.id === 'sl1').marketPrice, '800', 'the ok item was priced');

  // Cursor bookkeeping: advancedItems = [sl1 (ok), sl3 (data-miss)] both
  // "accepted" and advanced past; sl2 (transport) is kept in retryItems, NOT
  // advanced past, so q.cursor counts only the 2 accepted items.
  assert.strictEqual(q.cursor, 2, 'ok + data-miss both advance the cursor; the transport failure does not');
  const remainingIds = plain(q.items).slice(q.cursor).map((i) => i.id);
  assert.deepStrictEqual(remainingIds, ['sl2'], 'the transport-failed item is kept in the queue for a future retry');

  assert.strictEqual(q.dayCreditsUsed[today], 2, 'ok (1 request) + data-miss (1 request) billed; the transport failure billed 0');
});
