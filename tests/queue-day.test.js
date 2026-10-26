'use strict';
// v3.96, a pass bills each answer to the UTC day its request went out on. runRefreshQueue read the vendor's day once and _runRefreshQueueBody billed the whole batch
// (creditsSpent) to it at the end, so a pass that crossed 00:00 UTC (08:00 in Singapore) put the new day's answers on the old day, and a refusal for credits after the
// reset paused the old day, leaving the new one open. The v3.94 comment on the bulk run said the bulk run handles the day change "as the queue does", which the queue
// did not. Now:
//   - the day is read as each request goes out (sentDay), its answer is billed to that day (spentByDay), and the day the pass began on is stamped as it always was
//   - a refusal for credits pauses the day the refused request went out on
//   - the batch is still sized and checked against the day the pass began on: after a reset that is the stricter of the two, so neither day is over-spent, and the next
//     pass reads the new day in full. The bulk run (tests/bulk-day.test.js) checks the new day's budget from the reset on, the two are described each in their own words
//   - a pass that does not cross the reset bills exactly as before
// Fetch is stubbed (tests/harness.js) and the clock is faked (tests/clock.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, plain, ROOT } = require('./harness.js');
const { setClock } = require('./clock.js');

const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);
const QUEUE_KEY = 'pokeinv_refresh_queue';
const D1 = '2026-10-25';
const D2 = '2026-10-26';
const BEFORE = '2026-10-25T23:59:30Z'; // 07:59:30 on 26/10 in Singapore, the vendor's day is still the 25th
const AFTER = '2026-10-26T00:00:30Z';  // 08:00:30, the credits have reset
const EXHAUSTED = { error: 'Daily credit limit exceeded', retryAfter: 3600, resetsAt: '2026-10-26T00:00:00.000Z' };
const slabRow = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 500, marketPrice: '', priceHistory: [] }, extra);
// "Card N" is slab number N, which the vendor prices at 100 plus N. The dearer slab goes first in the day's order, so the costs step down with N
const slabs = (n) => Array.from({ length: n }, (_, i) => slabRow('s' + (i + 1), 'Card ' + (i + 1), { costPrice: 1000 - i }));
const slabCard = (search) => {
  const m = /^(.+) (\d+)$/.exec(search || '');
  return m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};
const searchOf = (c) => new URL(c.url).searchParams.get('search');

async function setup(seed, opts) {
  const o = Object.assign({ at: BEFORE }, opts || {});
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), jaLane: true });
  app.clock = setClock(app, o.at);
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  // the vendor: every slab search costs 6 credits. A hook runs as the nth request arrives (its day was read before it went out), and the nth can be refused for credits
  app.pptHooks = {}; app.refuseAt = 0; let seen = 0;
  app.fetchMock.route('/ppt/cards', (url) => {
    const n = ++seen;
    if (app.pptHooks[n]) app.pptHooks[n]();
    if (n === app.refuseAt) return jsonResponse(EXHAUSTED, 200);
    return jsonResponse({ data: [slabCard(searchOf({ url }))].filter(Boolean), metadata: { apiCallsConsumed: { total: 6 } } });
  });
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.row = (id) => app.ctx.DB.slabs.find((r) => r.id === id);
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  // a saved queue with this much of the 25th spent, as an earlier pass would have left it
  app.saveQueue = (patch) => {
    const q = plain(app.ctx.buildRefreshQueue());
    Object.assign(q, patch || {});
    app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    return q;
  };
  return app;
}
// run a started pass to its end, firing every wait it makes, and fail (not hang) when it does not end
async function finish(app, p) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 1500 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    app.timers.flush((e) => [6000, 1100, 250, 2000].includes(e.delay));
  }
  if (!done) throw new Error('the pass did not finish');
  return p;
}

// ── a pass that crosses the reset ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('queue day: a pass that crosses 00:00 UTC bills the answers after the reset to the new day, and the old day keeps what its own answers cost', async () => {
  const app = await setup({ slabs: slabs(3) });
  app.saveQueue({ dayCreditsUsed: { [D1]: 72 } }); // 18 of the 25th's credits are left, three slabs' worth
  app.pptHooks[2] = () => app.clock.set(AFTER); // the second request is on its way before the reset, it is the last of the 25th
  await finish(app, app.ctx.runRefreshQueue(false));
  assert.deepEqual(app.ppt().map(searchOf), ['Card 1', 'Card 2', 'Card 3'], 'the whole batch went out');
  assert.deepEqual(plain(app.saved().dayCreditsUsed), { [D1]: 84, [D2]: 6 }, 'two answers on the 25th, one on the 26th');
  assert.equal(app.saved().creditsPausedDate, undefined);
  for (const n of [1, 2, 3]) assert.equal(app.row('s' + n).marketPrice, String(100 + n));
  assert.equal(app.saved().completed, true);
  // the queue reads the same record: the 26th has spent 6, and the 25th is full
  assert.equal(app.ctx.kjrCreditsUsedOn(app.saved(), D2), 6);
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), D2), 84);
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), D1), 6, 'the 25th was not charged for the 26th\'s answer');
});

test('queue day: a refusal for credits after the reset pauses the new day, the day the refused request went out on, not the day the pass began on', async () => {
  const app = await setup({ slabs: slabs(3) });
  app.saveQueue({ dayCreditsUsed: { [D1]: 72 } });
  app.pptHooks[2] = () => app.clock.set(AFTER);
  app.refuseAt = 3; // the third request, the first of the 26th, is refused
  await finish(app, app.ctx.runRefreshQueue(false));
  assert.equal(app.ppt().length, 3);
  const q = app.saved();
  assert.deepEqual(plain(q.dayCreditsUsed), { [D1]: 84 }, 'the two answers of the 25th, a refusal is not billed');
  assert.equal(q.creditsPausedDate, D2, 'the pause is the 26th\'s');
  assert.equal(app.ctx.kjrCreditsLeft(q, D2), 0, 'so nothing more is asked on the 26th');
  assert.equal(app.ctx.kjrCreditsLeft(q, '2026-10-27'), 90, 'and the 27th is free');
  assert.equal(app.row('s3').marketPrice, '', 'the refused card is neither priced nor marked');
  assert.equal(q.cursor, 2, 'and stays where it was');
});

test('queue day: the batch is still bound by the day the pass began on, the cards beyond it wait, and the next pass asks on the new day in full', async () => {
  const app = await setup({ slabs: slabs(5) });
  app.saveQueue({ dayCreditsUsed: { [D1]: 72 } }); // three slabs' worth on the 25th
  app.pptHooks[2] = () => app.clock.set(AFTER);
  await finish(app, app.ctx.runRefreshQueue(false));
  assert.equal(app.ppt().length, 3, 'the batch the 25th\'s credits paid for, the reset inside it does not stretch it');
  assert.deepEqual(plain(app.saved().dayCreditsUsed), { [D1]: 84, [D2]: 6 });
  assert.equal(app.saved().completed, false);
  assert.ok(app.toasts.some((t) => /^Queue: 3 fetched.*2 remaining \(2 waiting for tomorrow\)$/.test(t)), JSON.stringify(app.toasts));
  // the next pass, on the 26th: the two that waited go first (not checked in 7 days), out of the 26th's 84 remaining credits
  app.fetchMock.calls.length = 0;
  await finish(app, app.ctx.runRefreshQueue(false));
  assert.deepEqual(app.ppt().map(searchOf).slice(0, 2), ['Card 4', 'Card 5'], 'the unpriced two first');
  assert.equal(app.row('s4').marketPrice, '104');
  assert.equal(app.row('s5').marketPrice, '105');
  assert.equal(app.saved().dayCreditsUsed[D1], 84, 'the old day is untouched by the new day\'s pass');
  assert.equal(app.saved().dayCreditsUsed[D2], 6 + 6 * app.ppt().length);
});

// ── a pass inside one day ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('queue day: control, a pass that does not cross the reset bills the one day exactly as before, with the day stamped even when nothing was spent', async () => {
  const app = await setup({ slabs: slabs(3) });
  app.saveQueue({ dayCreditsUsed: { [D1]: 72 } });
  await finish(app, app.ctx.runRefreshQueue(false));
  assert.equal(app.ppt().length, 3);
  assert.deepEqual(plain(app.saved().dayCreditsUsed), { [D1]: 90 }, 'one day, no key for another');
  // a batch that spends nothing (its one entry's row is gone, so no request is made) still stamps the day the pass began on with 0, as it always did (several suites read that key)
  const idle = await setup({ slabs: slabs(1) });
  idle.saveQueue({ pptDay: D1 }); // the day's order is already made, so the pass does not rebuild the lane from the inventory
  idle.ctx.DB.slabs = [];
  await finish(idle, idle.ctx.runRefreshQueue(false));
  assert.equal(idle.ppt().length, 0, 'a gone row is not asked about');
  assert.deepEqual(plain(idle.saved().dayCreditsUsed), { [D1]: 0 }, 'stamped with 0');
  // a refusal inside the one day pauses that day, as before
  const refused = await setup({ slabs: slabs(2) });
  refused.saveQueue({ dayCreditsUsed: { [D1]: 60 } });
  refused.refuseAt = 2;
  await finish(refused, refused.ctx.runRefreshQueue(false));
  assert.equal(refused.saved().creditsPausedDate, D1);
  assert.deepEqual(plain(refused.saved().dayCreditsUsed), { [D1]: 66 });
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('queue day: the pass reads the day as each request goes out, bills by that day, pauses the refused day, and the bulk run\'s comment no longer claims the queue did this already', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const body = (name) => {
    const at = src.indexOf('\nasync function ' + name + '(');
    assert.ok(at >= 0, name);
    return src.slice(at, at + 1 + src.slice(at + 1).search(/\n(?:async )?function /));
  };
  const pass = body('_runRefreshQueueBody');
  assert.match(pass, /const sentDay = kjrUtcDay\(\);[^\n]*\n\s*const r = await fetchMarketPrice\(/, 'the day is read right before the request goes out');
  assert.match(pass, /if \(r\.creditsUsed > 0\) spentByDay\[sentDay\] = \(spentByDay\[sentDay\] \|\| 0\) \+ r\.creditsUsed;/, 'and the answer is tallied to it');
  assert.match(pass, /creditsRefused = true;\s*refusedDay = sentDay;/, 'a refusal remembers its day');
  assert.match(pass, /spentByDay\[pptDay\] = spentByDay\[pptDay\] \|\| 0;[^\n]*\n\s*Object\.keys\(spentByDay\)\.forEach\(day => \{ q\.dayCreditsUsed\[day\] = \(q\.dayCreditsUsed\[day\] \|\| 0\) \+ spentByDay\[day\]; \}\);\s*if \(creditsRefused\) q\.creditsPausedDate = refusedDay;/, 'billed by day at the end, the start day stamped as ever, the pause on the refused day');
  assert.doesNotMatch(pass, /dayCreditsUsed\[pptDay\]/, 'nothing bills the whole batch to the day the pass began on');
  const bulk = body('bulkRefreshPrices');
  assert.doesNotMatch(bulk, /as the queue does when its next pass/, 'the old claim is gone');
  assert.doesNotMatch(src.slice(src.indexOf('// ── Manual bulk refresh of one table'), src.indexOf('function _kjrBulkKind(')), /as the queue does/, 'and the block above it makes none either');
});
