'use strict';
// The TCGdex free lane runs every day. It used to be built once, with the queue, and a pass dropped its items from q.items, so after
// the first pass nothing asked TCGdex again until the queue was rebuilt: not the next day, not on "run now". Now its cards are read off
// the live inventory on every run (_tcgdexLaneItems), an auto run asks the cards not priced today and not missed today, and a manual
// "run now" asks every eligible card. The PPT lane's cursor, items and dayCreditsUsed are never touched, QUEUE_SCHEMA_VERSION is not
// bumped, and no queue is rebuilt or replaced to make it happen.
//
// "Day 2" is simulated by moving the data back a day (the price markers and history dates, lastTcgdexPass), because the app reads the
// real clock: the rows then look exactly like the morning after a pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, plain } = require('./harness.js');

const QUEUE_KEY = 'pokeinv_refresh_queue';
const TODAY = () => new Date().toISOString().slice(0, 10);
const YESTERDAY = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);

// The lane's own waits (the 250ms gap, the 2s and 6s retry backoffs), not the app's startup timers: flushing those would start its 8s
// auto-run of the queue in the middle of the test.
const LANE_WAITS = [250, 2000, 6000];
async function drain(fn, timers, maxRounds) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < (maxRounds || 120) && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => LANE_WAITS.includes(e.delay));
  }
  return p;
}

const single = (id, name, extra) => Object.assign({ id, name, language: 'EN', status: 'Available', type: 'raw', costPrice: 5, marketPrice: '', priceHistory: [] }, extra || {});

// A TCGdex whose card prices a test can change between runs. "Alpha 1" is card number 1, which resolves to set-1.
function tcgdex(fetchMock, state) {
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) return state.unknown && state.unknown.includes(decodeURIComponent(list[2])) ? jsonResponse([]) : jsonResponse([{ id: 'set-' + decodeURIComponent(list[2]) }]);
    const card = url.match(/\/cards\/(set-\d+)$/);
    if (card) return state.prices[card[1]] ? jsonResponse({ id: card[1], pricing: { tcgplayer: { holofoil: { marketPrice: state.prices[card[1]] } } } }) : jsonResponse({}, 404);
    return jsonResponse({}, 404);
  });
  const calls = () => fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')).map((c) => c.url);
  return { calls, lists: () => calls().filter((u) => /\/cards\?name=/.test(u)), cards: () => calls().filter((u) => /\/cards\/set-/.test(u)) };
}

const savedQueue = (localStorage) => JSON.parse(localStorage.getItem(QUEUE_KEY));
const rowOf = (ctx, id) => ctx.DB.singles.find((r) => r.id === id);

// the morning after: every row was priced and checked yesterday, and the queue says so
function moveBackOneDay(app, patch) {
  app.ctx.DB.singles.forEach((r) => {
    if (r._tcgdexPricedDate) r._tcgdexPricedDate = YESTERDAY();
    (r.priceHistory || []).forEach((h) => { h.date = YESTERDAY(); });
  });
  const q = savedQueue(app.localStorage);
  q.lastTcgdexPass = YESTERDAY();
  if (patch) patch(q);
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  return q;
}

async function firstDay(extraSeed) {
  const app = await loadApp({ seed: Object.assign({ singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2'), single('s3', 'Charlie 3')] }, extraSeed || {}) });
  app.ctx.toast = () => {};
  app.state = { prices: { 'set-1': 10, 'set-2': 20, 'set-3': 30 } };
  app.tcg = tcgdex(app.fetchMock, app.state);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers); // day 1: no queue yet, so the auto run builds it and prices the cards
  return app;
}

test('free-lane-daily: day 1 prices every English card, the queue is complete and holds no free-lane entry', async () => {
  const app = await firstDay();
  assert.deepStrictEqual(['s1', 's2', 's3'].map((id) => rowOf(app.ctx, id).marketPrice), ['10', '20', '30']);
  const q = savedQueue(app.localStorage);
  assert.equal(q.completed, true);
  assert.equal(q.lastTcgdexPass, TODAY());
  assert.equal(q.items.filter((i) => i.lane === 'tcgdex').length, 0, 'a pass still drops the lane from q.items, the PPT cursor never sees it');
  assert.equal(q.lastTcgdexDone, 3);
  assert.equal(q.lastTcgdexTotal, 3);
  assert.equal(q.schemaVersion, 2, 'and the schema version is still 2');
});

test('free-lane-daily: day 2 re-prices the cards priced on day 1, with no rebuild and the PPT credits untouched', async () => {
  const app = await firstDay();
  const { ctx, fetchMock, timers, localStorage } = app;
  const today = TODAY();
  // PPT credits already spent today on the new day, and a queue that finished its PPT lane long ago
  const q2 = moveBackOneDay(app, (q) => { q.dayCreditsUsed = { [today]: 7 }; });
  const createdAt = q2.createdAt;
  assert.equal(ctx._tcgdexLaneHasWork(q2, today), true, 'a new day is work, although the PPT lane is complete');

  app.state.prices = { 'set-1': 11, 'set-2': 20, 'set-3': 33 }; // two prices moved overnight, one did not
  fetchMock.calls.length = 0;
  const marks = [];
  const realMark = ctx.markDirty;
  ctx.markDirty = (...a) => { marks.push(a[1]); return realMark.apply(ctx, a); };
  await drain(() => ctx.runRefreshQueue(false), timers);
  ctx.markDirty = realMark;

  assert.deepStrictEqual(app.tcg.lists(), [], 'the ids are cached on the rows, so no search is repeated');
  assert.equal(app.tcg.cards().length, 3, 'every card was asked again');
  assert.deepStrictEqual(['s1', 's2', 's3'].map((id) => rowOf(ctx, id).marketPrice), ['11', '20', '33'], 'the new prices are written');
  assert.deepStrictEqual(['s1', 's2', 's3'].map((id) => rowOf(ctx, id).priceHistory.length), [2, 1, 2], 'a changed price appends history, an unchanged one does not (the no-op rule stands)');
  const midnight = new Date(today + 'T00:00:00').getTime();
  assert.deepStrictEqual(['s1', 's2', 's3'].map((id) => ctx.kjrPriceCheckedTs(rowOf(ctx, id))), [midnight, midnight, midnight], 'and every card reads as checked today: a changed price by its new history entry, an unchanged one by the local marker');
  assert.equal(rowOf(ctx, 's2')._tcgdexPricedDate, today);
  assert.deepStrictEqual(marks.sort(), ['s1', 's3'], 'only the rows whose price changed are marked dirty, nothing syncs for the unchanged one');
  const q3 = savedQueue(localStorage);
  assert.equal(q3.lastTcgdexPass, today);
  assert.equal(q3.lastTcgdexDone, 3);
  assert.equal(q3.lastTcgdexTotal, 3);
  assert.equal(q3.createdAt, createdAt, 'the queue was not rebuilt or replaced');
  assert.equal(q3.schemaVersion, 2, 'and QUEUE_SCHEMA_VERSION is not bumped');
  assert.deepStrictEqual(plain(q3.dayCreditsUsed), { [today]: 7 }, 'the PPT credits spent today are exactly as they were');
  assert.equal(q3.completed, true);
  assert.equal(q3.cursor, q2.cursor);
  assert.ok(!fetchMock.calls.some((c) => c.url.includes('/ppt/')), 'no PPT request');
  assert.equal(ctx._tcgdexLaneHasWork(q3, today), false, 'and nothing is left for today');
});

test('free-lane-daily: a second auto run on the same day asks nothing, and the numbers keep reading 3 of 3', async () => {
  const app = await firstDay();
  const { ctx, fetchMock, timers, localStorage } = app;
  fetchMock.calls.length = 0;
  await drain(() => ctx.runRefreshQueue(false), timers);
  assert.deepStrictEqual(app.tcg.calls(), [], 'everything is priced today: zero requests');
  const q = savedQueue(localStorage);
  assert.equal(q.lastTcgdexDone, 3, 'priced today, not "0 of 3"');
  assert.equal(q.lastTcgdexTotal, 3);
});

test('free-lane-daily: a manual run after a completed pass makes requests, asks every card and spends no PPT credit', async () => {
  const app = await firstDay();
  const { ctx, fetchMock, timers, localStorage } = app;
  const today = TODAY();
  const before = savedQueue(localStorage);
  before.dayCreditsUsed = { [today]: 4 };
  localStorage.setItem(QUEUE_KEY, JSON.stringify(before));
  rowOf(ctx, 's2')._tcgdexMissDate = today; // a miss stamped earlier today
  app.state.prices['set-2'] = 25;
  fetchMock.calls.length = 0;
  await drain(() => ctx.runRefreshQueue(true), timers);
  assert.equal(app.tcg.cards().length, 3, 'every eligible card is asked again, priced today or not');
  assert.equal(rowOf(ctx, 's2').marketPrice, '25', 'including the one that carried a miss stamp today, which is cleared');
  assert.ok(!rowOf(ctx, 's2')._tcgdexMissDate, 'and no stale stamp is left behind');
  const after = savedQueue(localStorage);
  assert.deepStrictEqual(plain(after.dayCreditsUsed), { [today]: 4 }, 'PPT credits untouched');
  assert.equal(after.createdAt, before.createdAt, 'no rebuild');
  assert.ok(!fetchMock.calls.some((c) => c.url.includes('/ppt/')));
});

test('free-lane-daily: a manual run is not blocked by a PPT lane that has nothing left either', async () => {
  const app = await firstDay();
  const { ctx, fetchMock, timers } = app;
  const q = savedQueue(app.localStorage);
  assert.equal(q.completed, true, 'precondition: the "queue complete" state that used to make a manual run do nothing');
  fetchMock.calls.length = 0;
  await drain(() => ctx.runRefreshQueue(true), timers);
  assert.ok(app.tcg.cards().length >= 3);
});

test('free-lane-daily: with the PPT budget spent and a PPT entry waiting, the free lane still runs and the PPT lane stays exactly as it was', async () => {
  const slab = { id: 'sl1', name: 'Charizard', grader: 'PSA', grade: '10', language: 'EN', costPrice: 500, status: 'Available', type: 'slab', marketPrice: '', priceHistory: [] };
  const app = await loadApp({ seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2')], slabs: [slab] } });
  app.ctx.toast = () => {};
  app.state = { prices: { 'set-1': 10, 'set-2': 20 } };
  app.tcg = tcgdex(app.fetchMock, app.state);
  const today = TODAY();
  const entry = { id: 'sl1', table: 'slabs', name: 'Charizard', grader: 'PSA', grade: '10', language: null, tcgdexId: null, costPrice: 500, isPrimary: true, copyTargets: [], uniqueKey: 'charizard|EN|psa|10', lane: 'ppt' };
  const queue = { schemaVersion: 2, items: [entry], cursor: 0, totalItems: 1, totalRows: 3, createdAt: '2026-10-01T00:00:00.000Z', doneToday: 0, dayCreditsUsed: { [today]: 30 }, lastTcgdexPass: YESTERDAY(), completed: false };
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.deepStrictEqual(['s1', 's2'].map((id) => rowOf(app.ctx, id).marketPrice), ['10', '20'], 'the free lane ran');
  const q = savedQueue(app.localStorage);
  assert.deepStrictEqual(plain(q.dayCreditsUsed), { [today]: 30 }, 'the credits are as they were');
  assert.equal(q.cursor, 0, 'the PPT cursor did not move');
  assert.deepStrictEqual(q.items.map((i) => i.id), ['sl1'], 'and its entry is still waiting');
  assert.equal(q.completed, false);
  assert.ok(!app.fetchMock.calls.some((c) => c.url.includes('/ppt/')), 'no PPT request');
});

test('free-lane-daily: a queue from an older version that still holds free-lane entries loses them, keeps its PPT entries and cursor', async () => {
  const slab = { id: 'sl1', name: 'Charizard', grader: 'PSA', grade: '10', language: 'EN', costPrice: 500, status: 'Available', type: 'slab', marketPrice: '', priceHistory: [] };
  const app = await loadApp({ seed: { singles: [single('s1', 'Alpha 1'), single('c1', 'Custom 9', { customCard: true }), single('jp', 'Pikachu 25', { language: 'JP' })], slabs: [slab] } });
  app.ctx.toast = () => {};
  app.state = { prices: { 'set-1': 10 } };
  app.tcg = tcgdex(app.fetchMock, app.state);
  const today = TODAY();
  const ppt = { id: 'sl1', table: 'slabs', lane: 'ppt', name: 'Charizard', grader: 'PSA', grade: '10', copyTargets: [] };
  const stale = [
    { id: 's1', table: 'singles', lane: 'tcgdex', name: 'Alpha 1', language: 'EN', copyTargets: [] },
    { id: 'c1', table: 'singles', lane: 'tcgdex', name: 'Custom 9', language: 'EN', copyTargets: [] }, // flagged since the queue was built
    { id: 'jp', table: 'singles', lane: 'tcgdex', name: 'Pikachu 25', language: 'JP', copyTargets: [] },
    { id: 'gone', table: 'singles', lane: 'tcgdex', name: 'Deleted 3', language: 'EN', copyTargets: [] },
  ];
  const queue = { schemaVersion: 2, items: stale.concat([ppt]), cursor: 0, totalItems: 5, totalRows: 4, createdAt: '2026-10-01T00:00:00.000Z', dayCreditsUsed: { [today]: 30 }, completed: false };
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  const q = savedQueue(app.localStorage);
  assert.deepStrictEqual(q.items.map((i) => i.id), ['sl1'], 'only the PPT entry is left, so the PPT batch never sees a free-lane card');
  assert.equal(q.cursor, 0);
  assert.equal(rowOf(app.ctx, 's1').marketPrice, '10');
  assert.equal(rowOf(app.ctx, 'c1').marketPrice, '', 'the custom card was not asked about');
  assert.equal(rowOf(app.ctx, 'jp').marketPrice, '', 'neither was the Japanese one');
  assert.deepStrictEqual(app.tcg.cards().length, 1, 'one card request in all');
});

test('free-lane-daily: with no free-lane card at all, stale entries are still dropped and nothing is asked', async () => {
  const app = await loadApp({ seed: { singles: [single('c1', 'Custom 9', { customCard: true })] } });
  app.ctx.toast = () => {};
  app.tcg = tcgdex(app.fetchMock, { prices: {} });
  const queue = { schemaVersion: 2, items: [{ id: 'c1', table: 'singles', lane: 'tcgdex', name: 'Custom 9', language: 'EN', copyTargets: [] }], cursor: 0, totalItems: 1, totalRows: 1, createdAt: '2026-10-01T00:00:00.000Z', dayCreditsUsed: {}, completed: false };
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.deepStrictEqual(savedQueue(app.localStorage).items, []);
  assert.deepStrictEqual(app.tcg.calls(), []);
});

test('free-lane-daily: a card added after the pass is picked up on its own, the rest are not asked again', async () => {
  const app = await firstDay();
  const { ctx, timers, localStorage } = app;
  const today = TODAY();
  ctx.DB.singles.push(single('s4', 'Delta 4'));
  app.state.prices['set-4'] = 40;
  const q = savedQueue(localStorage);
  assert.equal(ctx._tcgdexLaneHasWork(q, today), true, 'a new unpriced card is work for the next auto run');
  app.fetchMock.calls.length = 0;
  const result = plain(await drain(() => ctx._runTcgdexLane(q, false, today), timers));
  assert.equal(rowOf(ctx, 's4').marketPrice, '40');
  assert.equal(result.done, 1);
  assert.equal(result.alreadyPriced, 3, 'the other three were found priced today');
  assert.equal(result.total, 4);
  assert.equal(app.tcg.cards().length, 1, 'one card request, one search');
  assert.equal(app.tcg.lists().length, 1);
});

test('free-lane-daily: a miss from an earlier day is asked again today, a miss today is not', async () => {
  const app = await loadApp({ seed: { singles: [single('s1', 'Alpha 1', { _tcgdexMissDate: YESTERDAY() }), single('s2', 'Bravo 2', { _tcgdexMissDate: TODAY() }), single('s3', 'Charlie 3', { _tcgdexMissDate: YESTERDAY() })] } });
  app.ctx.toast = () => {};
  app.state = { prices: { 'set-1': 10, 'set-3': 30 }, unknown: ['3'] }; // TCGdex knows Alpha now, still does not know Charlie
  app.tcg = tcgdex(app.fetchMock, app.state);
  const result = plain(await drain(() => app.ctx._runTcgdexLane({ items: [] }, false, TODAY()), app.timers));
  assert.equal(rowOf(app.ctx, 's1').marketPrice, '10', 'yesterday\'s miss is priced now');
  assert.ok(!rowOf(app.ctx, 's1')._tcgdexMissDate, 'and its stamp is cleared');
  assert.equal(rowOf(app.ctx, 's2').marketPrice, '', 'today\'s miss is left alone');
  assert.equal(rowOf(app.ctx, 's2')._tcgdexMissDate, TODAY());
  assert.equal(rowOf(app.ctx, 's3')._tcgdexMissDate, TODAY(), 'yesterday\'s miss that is still a miss is stamped again, for today');
  assert.equal(result.done, 1);
  assert.equal(result.failedData, 1);
  assert.equal(result.skipped, 1);
  assert.deepStrictEqual(app.tcg.lists().map((u) => decodeURIComponent(u.match(/name=([^&]+)/)[1])).sort(), ['Alpha', 'Charlie']);
});

test('free-lane-daily: the run summary counts cards found already priced, "3/3" and not "0/3"', async () => {
  const app = await firstDay();
  const result = plain(await drain(() => app.ctx._runTcgdexLane(savedQueue(app.localStorage), false, TODAY()), app.timers));
  assert.equal(result.done, 0);
  assert.equal(result.alreadyPriced, 3);
  assert.equal(app.ctx._tcgdexNote(result), ' · Exact (TCGdex): 3/3 priced');
});

test('free-lane-daily: a row with no name can not break the lane or the queue builder', async () => {
  const app = await loadApp({ seed: { singles: [{ id: 'x', status: 'Available', language: 'EN', costPrice: 1 }, single('s1', 'Alpha 1')] } });
  app.ctx.toast = () => {};
  app.state = { prices: { 'set-1': 10 } };
  app.tcg = tcgdex(app.fetchMock, app.state);
  assert.doesNotThrow(() => app.ctx.buildRefreshQueue());
  await drain(() => app.ctx._runTcgdexLane({ items: [] }, false, TODAY()), app.timers);
  assert.equal(rowOf(app.ctx, 's1').marketPrice, '10');
});

test('free-lane-daily: cards a pass left unanswered still count, they are in the list the next run reads', async () => {
  const app = await loadApp({ seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2')] } });
  app.ctx.toast = () => {};
  app.state = { prices: { 'set-1': 10, 'set-2': 20 } };
  app.tcg = tcgdex(app.fetchMock, app.state);
  const q = { items: [], tcgdexRetry: [{ id: 's2', table: 'singles', lane: 'tcgdex', name: 'Old Name 9', language: 'EN', copyTargets: [] }] };
  const items = plain(app.ctx._tcgdexLaneItems(q));
  assert.deepStrictEqual(items.map((i) => i.id), ['s1', 's2'], 'the live inventory already holds them, once each');
  assert.equal(items.find((i) => i.id === 's2').name, 'Bravo 2', 'under the name the row has now');
});

// ── the Overview and the Settings text ───────────────────────────────────────────────────────────────────────────────────────────

test('free-lane-daily: a pass that ends with the Overview on screen redraws it, so "Prices checked" reads today', async () => {
  const app = await firstDay();
  const { ctx, document, timers } = app;
  moveBackOneDay(app);
  ctx.renderDashboard();
  assert.match(document.getElementById('dash-last-updated').textContent, /^Prices checked yesterday/, 'precondition: the morning reading');
  document.getElementById('page-dashboard').classList.add('active');
  await drain(() => ctx.runRefreshQueue(false), timers);
  assert.match(document.getElementById('dash-last-updated').textContent, /^Prices checked today · 100% priced$/);
});

test('free-lane-daily: a pass with another page on screen leaves the Overview alone', async () => {
  const app = await firstDay();
  const { ctx, document, timers } = app;
  moveBackOneDay(app);
  ctx.renderDashboard();
  const before = document.getElementById('dash-last-updated').textContent;
  document.getElementById('page-dashboard').classList.remove('active'); // the person is on Singles
  await drain(() => ctx.runRefreshQueue(false), timers);
  assert.equal(document.getElementById('dash-last-updated').textContent, before, 'it is drawn again when it is next shown');
  ctx.renderDashboard();
  assert.match(document.getElementById('dash-last-updated').textContent, /^Prices checked today/, 'and then it reads today');
});

test('free-lane-daily: the Settings text says what the lane does, and the claim is now true', async () => {
  const app = await firstDay();
  app.ctx._renderQueueStatus();
  const panel = app.document.getElementById('queue-status-panel').innerHTML;
  assert.match(panel, /title="Raw English singles priced free via TCGdex \(TCGplayer\/Cardmarket\), matched by card number\. A full pass runs the first time the app opens each day, and Run Today's Batch runs it again now\."/);
  assert.match(panel, /3\/3 today/, 'the tile reads priced today out of eligible');
  assert.doesNotMatch(panel, /Runs a full pass once a day/);
  app.ctx.openApiSettings();
  const modal = app.document.body._lastInsertedHTML;
  assert.match(modal, /a full pass over every English raw single the first time the app opens each day, Run Today's Batch repeats it now/);
});
