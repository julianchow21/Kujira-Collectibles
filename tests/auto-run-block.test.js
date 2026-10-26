'use strict';
// v3.96, the page-load auto run stands down after a bulk run that ended on a vendor block. Since v3.94 the auto run waits for a bulk run and goes from the run's finally
// (_kjrAutoRunResume). A bulk run that stopped at the first 429 or 403 (hardBlock) or at five transport failures in a row (aborted) left no mark, so the pass went out
// from that finally and asked the vendor again within seconds (or TCGdex, which had just refused too). On the Free plan a burst of 429s earns the key a 24 hour block.
// Now the run marks such an end (_kjrBulkBlocked) and runRefreshQueue turns the automatic call away for the rest of the load:
//   - a bulk run ended by a 429, a 403 or five failures in a row: the waiting auto run stands down, no pass, no request, and nothing brings it back this load
//   - the same when the run ended before the 8 second mark: the mark makes its one call and it is turned away
//   - a pass asked for by hand still goes, that is the owner's choice
//   - a bulk run that ends any other way (priced, a miss, one failure, out of credits) hands the auto run back as it has since v3.94, once
// The router is held by the test (every call waits for its answer), fetch is stubbed (tests/harness.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT } = require('./harness.js');

const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);
const enRow = (id, name, extra) => Object.assign({ id, name, language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabRow = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 500, marketPrice: '', priceHistory: [] }, extra);
// the router's answers: a price, the vendor's refusal (a block), a transport failure that is no block, a plain miss, and the day's credits gone
const PRICED = { maxSgd: 8, maxUsd: 8, source: 'TCGdex', confidence: 'high', sgdRate: 1, creditsUsed: 0, resolvedTcgdexId: 'set-26', tcgdexError: null, pptError: 'not applicable' };
const unpriced = (extra) => Object.assign({ maxUsd: null, maxEur: null, maxSgd: null, source: null, confidence: 'none', creditsUsed: 0, resolvedTcgdexId: null, sgdRate: null }, extra);
const REFUSED = (words) => unpriced({ tcgdexError: words, tcgdexTransient: true, pptError: 'not applicable' });
const DOWN = unpriced({ tcgdexError: 'network error', tcgdexTransient: true, pptError: 'not applicable' });
const MISS = unpriced({ tcgdexError: 'no match', pptError: 'not applicable' });
const EXHAUSTED = unpriced({ creditsExhausted: true, pptError: 'PPT daily credit limit reached', tcgdexError: 'not applicable' });

async function setup(seed) {
  const app = await loadApp({ seed: Object.assign({ singles: [enRow('b', 'Raichu 26')], slabs: [] }, seed), jaLane: true });
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.ctx.kjrConfirm = async () => true;
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  app.fetchMock.calls.length = 0;
  app.row = (id, table) => app.ctx.DB[table || 'singles'].find((r) => r.id === id);
  // every call to runRefreshQueue, and then the real one
  app.runs = [];
  const realRun = app.ctx.runRefreshQueue;
  app.ctx.runRefreshQueue = (...args) => { app.runs.push(args); return realRun(...args); };
  // the pass itself: a call turned away at the top of runRefreshQueue never gets here
  app.passes = [];
  const realBody = app.ctx._runRefreshQueueBody;
  app.ctx._runRefreshQueueBody = (...args) => { app.passes.push(args); return realBody(...args); };
  app.mark = () => app.timers.list().find((t) => t.type === 'timeout' && t.delay === 8000);
  app.reachMark = () => { const t = app.mark(); assert.ok(t, 'the app registered its 8 second timer at load'); app.timers.invoke(t.id); };
  // the router, held: every call waits for the test's answer, so the count of requests is exact and nothing else is going on
  app.lookups = [];
  app.answered = 0;
  app.ctx.fetchMarketPrice = (descriptor) => new Promise((resolve, reject) => app.lookups.push({ descriptor, resolve, reject }));
  app.opened = async (n) => { for (let i = 0; i < 80 && app.lookups.length < n; i++) await new Promise((r) => setImmediate(r)); return app.lookups.length >= n; };
  // answer the next request in flight, then let the run reach its next one (its gap between cards is slept through setTimeout, which the harness never fires itself)
  app.answer = async (reply) => {
    assert.ok(await app.opened(app.answered + 1), 'request ' + (app.answered + 1) + ' is in flight');
    app.lookups[app.answered++].resolve(reply);
    await app.settle(10);
  };
  app.settle = async (n) => { for (let i = 0; i < (n || 20); i++) { await new Promise((r) => setImmediate(r)); app.timers.flush((e) => [250, 1100, 6000, 2000].includes(e.delay)); } };
  return app;
}
const tick = async (n) => { for (let i = 0; i < (n || 10); i++) await new Promise((r) => setImmediate(r)); };
// a bulk run of one table, confirmed and held in flight on its first card. It returns the run inside an object: an async function that returned the promise itself
// would be waited for to its end, and the run is held until the test answers its request
async function startBulk(app, table) {
  const run = app.ctx.bulkRefreshPrices(table || 'singles');
  assert.ok(await app.opened(1), 'the bulk run is in flight on its first card');
  assert.equal(app.ctx._bulkRefreshRunning, true);
  return { run };
}

// ── the run ends on a block ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

for (const words of ['HTTP 429', 'HTTP 403']) {
  test('auto run block: a bulk run going at the mark that stops at ' + words + ' stands the waiting run down, no pass goes, and nothing brings it back this load', async () => {
    const app = await setup();
    const { run } = await startBulk(app);
    app.reachMark();
    assert.equal(app.ctx._kjrAutoRunWaiting, true, 'it waits for the bulk run, as since v3.94');
    await app.answer(REFUSED(words));
    await run;
    await tick();
    assert.equal(app.ctx._bulkRefreshRunning, false);
    assert.ok(app.toasts.some((t) => t.includes('stopped at the first refusal (' + words + ')')), JSON.stringify(app.toasts));
    assert.equal(app.ctx._kjrBulkBlocked, words, 'the run left its mark');
    assert.equal(app.ctx._kjrAutoRunWaiting, false, 'the run was handed back');
    await app.settle();
    assert.deepEqual(app.runs, [[false]], 'and made its one automatic call');
    assert.equal(app.passes.length, 0, 'which was turned away: no pass');
    assert.equal(app.lookups.length, 1, 'no source was asked after the refusal, the bulk run\'s one request is all there was');
    assert.equal(app.ctx._queueRunning, false);
    // nothing brings it back this load: a second bulk run that ends well, a lookup in flight closing, a question answered no
    const again = app.ctx.bulkRefreshPrices('singles');
    await app.answer(PRICED);
    await again;
    await tick();
    assert.equal(app.row('b').marketPrice, '8', 'the second bulk run itself is not refused, it is the automatic pass that stands down');
    const look = app.ctx.kjrBudgetedLookup({ name: 'Raichu 26', grader: null, grade: null, language: null });
    await app.answer(PRICED);
    await look;
    app.ctx.kjrConfirm = async () => false;
    await app.ctx.bulkRefreshPrices('singles');
    await tick();
    await app.settle();
    assert.deepEqual(app.runs, [[false]], 'no other automatic call');
    assert.equal(app.passes.length, 0, 'and no pass');
    assert.equal(app.ctx._kjrBulkBlocked, words, 'the mark stays for the load');
  });
}

test('auto run block: five transport failures in a row stop the bulk run and stand the waiting run down the same way', async () => {
  const app = await setup({ singles: [1, 2, 3, 4, 5].map((n) => enRow('c' + n, 'Card ' + (20 + n))) });
  const { run } = await startBulk(app);
  app.reachMark();
  assert.equal(app.ctx._kjrAutoRunWaiting, true);
  for (let n = 0; n < 5; n++) await app.answer(DOWN);
  await run;
  await tick();
  assert.ok(app.toasts.some((t) => t.includes('auto-paused after 5 failures in a row')), JSON.stringify(app.toasts));
  assert.equal(app.ctx._kjrBulkBlocked, 'five failures in a row');
  assert.equal(app.ctx._kjrAutoRunWaiting, false);
  await app.settle();
  assert.deepEqual(app.runs, [[false]]);
  assert.equal(app.passes.length, 0, 'no pass');
  assert.equal(app.lookups.length, 5, 'the five requests the bulk run made, and none after them');
});

test('auto run block: a bulk run that ended on a refusal before the 8 second mark leaves the mark with nothing to run', async () => {
  const app = await setup();
  const { run } = await startBulk(app);
  await app.answer(REFUSED('HTTP 429'));
  await run;
  await tick();
  assert.equal(app.ctx._kjrAutoRunWaiting, false, 'nothing was waiting, the run ended before the mark');
  assert.deepEqual(app.runs, [], 'and nothing has been called yet');
  app.reachMark();
  await tick();
  await app.settle();
  assert.deepEqual(app.runs, [[false]], 'the mark made its one automatic call');
  assert.equal(app.passes.length, 0, 'which was turned away');
  assert.equal(app.lookups.length, 1, 'no request after the refusal');
  assert.equal(app.ctx._queueRunning, false);
});

test('auto run block: a pass asked for by hand still goes after the block, and the mark stays for the load', async () => {
  const app = await setup();
  const { run } = await startBulk(app);
  app.reachMark();
  await app.answer(REFUSED('HTTP 403'));
  await run;
  await tick();
  await app.settle();
  assert.equal(app.passes.length, 0, 'the automatic pass stood down');
  const hand = app.ctx.runRefreshQueue(true);
  assert.ok(await app.opened(2), 'the hand pass asked the source for its free lane card');
  assert.equal(app.passes.length, 1, 'the hand pass ran');
  await app.answer(PRICED);
  await hand;
  await app.settle();
  assert.equal(app.ctx._queueRunning, false);
  assert.equal(app.row('b').marketPrice, '8', 'a real pass');
  assert.equal(app.ctx._kjrBulkBlocked, 'HTTP 403', 'the mark is for the automatic call alone and stays');
  assert.deepEqual(app.runs, [[false], [true]]);
});

// ── every other end keeps the v3.94 hand-back ───────────────────────────────────────────────────────────────────────────────────────────

test('auto run block: a bulk run that ends any other way still hands the waiting run back, once, and the pass runs', async () => {
  const ends = [
    ['priced', { singles: [enRow('b', 'Raichu 26')] }, 'singles', PRICED],
    ['a miss', { singles: [enRow('b', 'Raichu 26')] }, 'singles', MISS],
    ['one failure that is no block', { singles: [enRow('b', 'Raichu 26')] }, 'singles', DOWN],
    ['out of credits', { singles: [], slabs: [slabRow('s1', 'Alpha 1')] }, 'slabs', EXHAUSTED],
  ];
  for (const [name, seed, table, reply] of ends) {
    const app = await setup(seed);
    const { run } = await startBulk(app, table);
    app.reachMark();
    assert.equal(app.ctx._kjrAutoRunWaiting, true, name + ': waits for the bulk run');
    await app.answer(reply);
    await run;
    await tick();
    assert.equal(app.ctx._kjrBulkBlocked, '', name + ': no mark');
    assert.equal(app.ctx._kjrAutoRunWaiting, false, name + ': handed back');
    assert.deepEqual(app.runs, [[false]], name + ': the automatic call went');
    assert.equal(app.passes.length, 1, name + ': and was not turned away, the pass ran');
    // the pass's free lane asks the held router for a single not priced today (the card the bulk run just priced is skipped), a slabs-only inventory has nothing on that lane
    if (await app.opened(app.answered + 1)) await app.answer(PRICED);
    await app.settle();
    assert.equal(app.ctx._queueRunning, false, name + ': and finished');
  }
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('auto run block: runRefreshQueue reads the mark for the automatic call alone, the bulk run sets it before its finally, and _kjrAutoRun is as the auto run suite pins it', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const body = (name) => {
    const at = src.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name);
    return src.slice(at, at + 10 + src.slice(at + 10).search(/\n(?:async )?function /));
  };
  assert.match(src, /^let _kjrBulkBlocked = '';$/m, 'declared once, in memory, for the load');
  assert.match(body('runRefreshQueue'), /if \(!manual && _kjrBulkBlocked\) return;/, 'the automatic call is turned away, quietly, a hand call is not');
  assert.match(body('bulkRefreshPrices'), /if \(hardBlock \|\| aborted\) _kjrBulkBlocked = hardBlock \|\| 'five failures in a row';\s*\} finally \{/, 'set as the loop ends, before the finally hands the auto run back');
  assert.equal((src.match(/_kjrBulkBlocked = /g) || []).length, 2, 'the declaration and the one place it is set, nothing clears it');
  const auto = src.slice(src.indexOf('function _kjrAutoRun() {'), src.indexOf('function _kjrAutoRunResume()'));
  assert.doesNotMatch(auto, /_kjrBulkBlocked/, '_kjrAutoRun itself is untouched, the mark is read where the automatic call is already told apart from a hand one');
});
