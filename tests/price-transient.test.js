'use strict';
// Transient pricing failures are not misses, and a same-value re-check counts as a check.
//
// Bug 1: fetchPriceFromTcgdex turned every exception or !r.ok into 'not found' and _runTcgdexLane stamped _tcgdexMissDate for it, so a
// network blip, a 429, a 5xx or a 403 blocked the card for the day and put it on the "could not be matched" list. Now only a definitive
// no-match (no card, a 404, a card with no price, a client error about this request) is a miss. A request TCGdex never answered is
// transient: nothing is stamped, the card is asked once more after a backoff, and whatever is still unanswered waits in q.tcgdexRetry.
// Five unanswered requests in a row stop the pass with a toast.
//
// Bug 2: freshness and "Prices checked" read only the last priceHistory date, but a same-value re-price appends no history by design,
// so a successful full pass could read stale. They now read the newer of that date and the device-local _tcgdexPricedDate marker.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, plain } = require('./harness.js');

// the free lane's markers carry the device's LOCAL date (kjrLocalDay), the price history keeps UTC dates
const TODAY = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// The lane waits on sandbox setTimeout calls the harness never fires on its own: let a real tick pass, then flush the lane's own waits
// (the 250ms gap, the 2s and 6s retry backoffs). Not the app's startup timers, flushing those would start its 8s auto-run of the queue
// in the middle of the test.
const LANE_WAITS = [250, 2000, 6000];
async function runWithTimerDrain(fn, timers, maxRounds) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < (maxRounds || 80) && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => LANE_WAITS.includes(e.delay));
  }
  return p;
}
// toast() is rebound while the launch intro holds the top layer, so a test captures what the app says by taking the name over
function captureToasts(ctx) {
  const said = [];
  ctx.toast = (message) => said.push(String(message));
  return said;
}

const single = (id, name, extra) => Object.assign({ id, name, language: 'EN', status: 'Available', type: 'raw', costPrice: 5, marketPrice: '', priceHistory: [] }, extra || {});
const laneItem = (id, name, extra) => Object.assign({ lane: 'tcgdex', id, table: 'singles', name, language: 'EN', tcgdexId: null, copyTargets: [] }, extra || {});
const cardJson = (id, usd) => jsonResponse({ id, pricing: { tcgplayer: { holofoil: { marketPrice: usd } } } });

// A TCGdex whose answers a test scripts per card. The name in the URL ("Bravo") picks the script, the localId is the card number.
// script[name] = (callNumber) => 'ok' | 'empty' | 503 | 'throw' | ...   (callNumber counts the list calls for that name, from 1)
function tcgdex(fetchMock, script, opts) {
  const calls = {};
  const priced = {};
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  fetchMock.route(url => url.includes('api.tcgdex.net'), async (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) {
      const name = decodeURIComponent(list[1]);
      const num = decodeURIComponent(list[2]);
      calls[name] = (calls[name] || 0) + 1;
      const verdict = (script[name] || (() => 'ok'))(calls[name]);
      if (verdict === 'throw') throw new TypeError('Failed to fetch');
      if (verdict === 'empty') return jsonResponse([]);
      if (typeof verdict === 'number') return jsonResponse({}, verdict);
      return jsonResponse([{ id: 'set-' + num }]);
    }
    const card = url.match(/\/cards\/([^/?]+)$/);
    if (card) {
      const id = decodeURIComponent(card[1]);
      priced[id] = (priced[id] || 0) + 1;
      const verdict = opts && opts.card ? opts.card(id, priced[id]) : 'ok';
      if (verdict === 'throw') throw new TypeError('Failed to fetch');
      if (verdict === 'nopricing') return jsonResponse({ id });
      if (typeof verdict === 'number') return jsonResponse({}, verdict);
      return cardJson(id, Number(id.replace(/\D/g, '')) * 10);
    }
    return jsonResponse({}, 404);
  });
  return { calls, priced };
}

const rowOf = (ctx, id) => ctx.DB.singles.find((r) => r.id === id);

// ── fetchPriceFromTcgdex: the classification ──────────────────────────────────────────────────────────────────────────────────────

test('price-transient: list-endpoint statuses 408/425/429/403/5xx are "could not tell", 404 and 400 are answers', async () => {
  for (const status of [408, 425, 429, 403, 500, 502, 503, 504]) {
    const { ctx, fetchMock } = await loadApp();
    fetchMock.route('/cards?name=', () => jsonResponse({}, status));
    const res = plain(await ctx.fetchPriceFromTcgdex({ name: 'Pikachu 25', language: 'EN' }));
    assert.deepStrictEqual(res, { error: 'HTTP ' + status, transient: true }, 'HTTP ' + status + ' says nothing about the card');
  }
  {
    const { ctx, fetchMock } = await loadApp();
    fetchMock.route('/cards?name=', () => jsonResponse({}, 404));
    assert.deepStrictEqual(plain(await ctx.fetchPriceFromTcgdex({ name: 'Pikachu 25', language: 'EN' })), { error: 'not found' }, '404 is TCGdex saying there is nothing there');
  }
  {
    const { ctx, fetchMock } = await loadApp();
    fetchMock.route('/cards?name=', () => jsonResponse({}, 400));
    assert.deepStrictEqual(plain(await ctx.fetchPriceFromTcgdex({ name: 'Pikachu 25', language: 'EN' })), { error: 'HTTP 400' }, 'a client error about this very request is a plain error, which the lane stamps');
  }
  {
    const { ctx, fetchMock } = await loadApp();
    fetchMock.route('/cards?name=', () => jsonResponse([]));
    assert.deepStrictEqual(plain(await ctx.fetchPriceFromTcgdex({ name: 'Pikachu 25', language: 'EN' })), { error: 'not found' }, 'an empty list is no match');
  }
});

test('price-transient: a thrown fetch, a timeout and a non-list body are transient, never a miss', async () => {
  const flaky = async (respond) => {
    const { ctx, fetchMock } = await loadApp();
    fetchMock.route('/cards?name=', respond);
    return plain(await ctx.fetchPriceFromTcgdex({ name: 'Pikachu 25', language: 'EN' }));
  };
  assert.deepStrictEqual(await flaky(async () => { throw new TypeError('Failed to fetch'); }), { error: 'network error', transient: true });
  assert.deepStrictEqual(await flaky(async () => { const e = new Error('The operation timed out'); e.name = 'TimeoutError'; throw e; }), { error: 'timeout', transient: true });
  assert.deepStrictEqual(await flaky(async () => jsonResponse({ gateway: 'html page' })), { error: 'network error', transient: true }, 'a 200 that is not a card list is a gateway page');
});

test('price-transient: the card endpoint is classified the same way (a cached id skips the list call)', async () => {
  const run = async (respond) => {
    const { ctx, fetchMock } = await loadApp();
    fetchMock.route('/cards/sv3-199', respond);
    return plain(await ctx.fetchPriceFromTcgdex({ name: 'Pikachu 25', language: 'EN', tcgdexId: 'sv3-199' }));
  };
  for (const status of [408, 425, 429, 403, 500, 503]) {
    assert.deepStrictEqual(await run(() => jsonResponse({}, status)), { error: 'HTTP ' + status, transient: true });
  }
  assert.deepStrictEqual(await run(() => jsonResponse({}, 404)), { error: 'not found' });
  assert.deepStrictEqual(await run(() => jsonResponse({}, 400)), { error: 'HTTP 400' });
  assert.deepStrictEqual(await run(() => jsonResponse({ id: 'sv3-199' })), { error: 'not found' }, 'a card with no pricing block is a clean miss');
  assert.deepStrictEqual(await run(() => jsonResponse({ id: 'sv3-199', pricing: { tcgplayer: {} } })), { error: 'not found' }, 'no price variant is a clean miss');
  assert.deepStrictEqual(await run(async () => { throw new TypeError('Failed to fetch'); }), { error: 'network error', transient: true });
  assert.deepStrictEqual(await run(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } })), { error: 'network error', transient: true });
});

test('price-transient: a priced card carries no error and no transient flag', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/cards/sv3-199', () => cardJson('sv3-199', 45));
  const res = plain(await ctx.fetchPriceFromTcgdex({ name: 'Pikachu 25', language: 'EN', tcgdexId: 'sv3-199' }));
  assert.deepStrictEqual(res, { priceUsd: 45, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high', creditsUsed: 0 });
});

test('price-transient: the TCGdex requests carry a timeout signal where AbortSignal.timeout exists', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/cards?name=', () => jsonResponse([{ id: 'sv3-199' }]));
  fetchMock.route('/cards/sv3-199', () => cardJson('sv3-199', 45));
  await ctx.fetchPriceFromTcgdex({ name: 'Pikachu 25', language: 'EN' });
  const tcg = fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net'));
  assert.equal(tcg.length, 2);
  for (const c of tcg) assert.ok(c.opts && c.opts.signal, 'a stalled request becomes a thrown one: ' + c.url);
});

test('price-transient: fetchMarketPrice reads tcgdexTransient off the TCGdex source, a PPT sentinel can not turn it into a miss', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/cards?name=', () => jsonResponse({}, 503));
  const down = plain(await ctx.fetchMarketPrice({ name: 'Pikachu 25', language: 'EN', tcgdexOnly: true }));
  assert.equal(down.maxSgd, null);
  assert.equal(down.tcgdexTransient, true);
  assert.equal(down.pptError, 'not applicable', 'the sentinel is a non-empty string, which is why the lane never classifies on error text');
  assert.equal(down.tcgdexError, 'HTTP 503');
  assert.ok(!fetchMock.calls.some((c) => c.url.includes('/ppt/cards')), 'tcgdexOnly: zero PPT calls');

  fetchMock.reset();
  fetchMock.route('/cards?name=', () => jsonResponse([]));
  const gone = plain(await ctx.fetchMarketPrice({ name: 'Pikachu 25', language: 'EN', tcgdexOnly: true }));
  assert.equal(gone.tcgdexTransient, false, 'an empty list is a definitive no-match');
  assert.equal(gone.tcgdexError, 'not found');
});

// ── _runTcgdexLane ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('price-transient: three cards fail transiently, succeed on the retry round, and are never stamped as misses', async () => {
  const { ctx, fetchMock, timers } = await loadApp({
    seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2'), single('s3', 'Charlie 3'), single('s4', 'Delta 4'), single('s5', 'Echo 5')] },
  });
  const t = tcgdex(fetchMock, {
    Bravo: (n) => (n === 1 ? 503 : 'ok'),
    Charlie: (n) => (n === 1 ? 'throw' : 'ok'),
    Delta: (n) => (n === 1 ? 429 : 'ok'),
  });
  const q = { items: ['Alpha 1', 'Bravo 2', 'Charlie 3', 'Delta 4', 'Echo 5'].map((n, i) => laneItem('s' + (i + 1), n)) };
  const result = plain(await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers));

  assert.equal(result.done, 5, 'all five priced in the end');
  assert.equal(result.failedData, 0, 'nothing was a miss');
  assert.equal(result.recovered, 3, 'the three that failed were priced by the retry round');
  assert.equal(result.paused, false);
  assert.equal(result.unanswered, 0);
  for (const id of ['s1', 's2', 's3', 's4', 's5']) {
    const row = rowOf(ctx, id);
    assert.ok(Number(row.marketPrice) > 0, id + ' has a price');
    assert.ok(!row._tcgdexMissDate, id + ' on the live row carries no miss stamp');
  }
  for (const item of q.items) assert.ok(!item._tcgdexMissDate, item.id + ' on the queue item carries no miss stamp either');
  assert.equal(q.tcgdexRetry, undefined, 'nothing is left waiting');
  assert.equal(q.lastTcgdexPass, TODAY(), 'a full pass is stamped');
  assert.equal(t.calls.Alpha, 1, 'a card that was answered is asked once');
  assert.equal(t.calls.Bravo, 2, 'a card that was not is asked once more');
  assert.equal(ctx.DB.singles.filter((r) => r._tcgdexMissDate).length, 0);
  assert.equal(ctx._kjrUnresolvedSingles().length, 0, 'so a blip never reaches the "could not be matched" banner');
});

test('price-transient: a 404 stays a miss and is stamped, a card with no price stays a miss, neither is retried', async () => {
  const { ctx, fetchMock, timers } = await loadApp({
    seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2'), single('s3', 'Charlie 3')] },
  });
  const t = tcgdex(fetchMock, { Alpha: () => 'empty', Bravo: () => 404 }, { card: (id) => (id === 'set-3' ? 'nopricing' : 'ok') });
  const q = { items: [laneItem('s1', 'Alpha 1'), laneItem('s2', 'Bravo 2'), laneItem('s3', 'Charlie 3')] };
  const result = plain(await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers));

  assert.equal(result.done, 0);
  assert.equal(result.failedData, 3, 'an empty list, a 404 and a card with no price are three definitive misses');
  assert.equal(result.unanswered, 0);
  assert.equal(q.tcgdexRetry, undefined);
  for (const id of ['s1', 's2', 's3']) assert.equal(rowOf(ctx, id)._tcgdexMissDate, TODAY(), id + ' is stamped');
  assert.equal(t.calls.Alpha, 1, 'a miss is not retried');
  assert.equal(t.calls.Bravo, 1, 'a 404 is not retried');
  assert.equal(t.calls.Charlie, 1);
  assert.equal(t.priced['set-3'], 1, 'a card with no price is not retried');
  assert.deepStrictEqual(plain(ctx._kjrUnresolvedSingles().map((r) => r.id).sort()), ['s1', 's2', 's3'], 'definitive misses are exactly what the banner lists');
});

test('price-transient: a miss and a blip in the same pass are told apart', async () => {
  const { ctx, fetchMock, timers } = await loadApp({
    seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2'), single('s3', 'Charlie 3')] },
  });
  tcgdex(fetchMock, { Alpha: () => 'empty', Bravo: (n) => (n === 1 ? 500 : 'ok') });
  const q = { items: [laneItem('s1', 'Alpha 1'), laneItem('s2', 'Bravo 2'), laneItem('s3', 'Charlie 3')] };
  const result = plain(await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers));
  assert.equal(result.done, 2);
  assert.equal(result.failedData, 1);
  assert.equal(rowOf(ctx, 's1')._tcgdexMissDate, TODAY(), 'the empty list is stamped');
  assert.ok(!rowOf(ctx, 's2')._tcgdexMissDate, 'the 500 is not');
  assert.ok(Number(rowOf(ctx, 's2').marketPrice) > 0);
});

test('price-transient: five unanswered requests in a row stop the pass, with a toast, no stamps and nothing left to loop', async () => {
  const names = ['Alpha 1', 'Bravo 2', 'Charlie 3', 'Delta 4', 'Echo 5', 'Foxtrot 6', 'Golf 7', 'Hotel 8'];
  const { ctx, fetchMock, timers } = await loadApp({
    seed: { singles: names.map((n, i) => single('s' + (i + 1), n)) },
  });
  const said = captureToasts(ctx);
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  fetchMock.reject(url => url.includes('api.tcgdex.net'), new TypeError('Failed to fetch'));
  const q = { items: names.map((n, i) => laneItem('s' + (i + 1), n)) };
  const before = fetchMock.calls.length;
  const result = plain(await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers));
  const tcgdexCalls = fetchMock.calls.slice(before).filter((c) => c.url.includes('api.tcgdex.net')).length;

  assert.equal(result.paused, true);
  assert.equal(tcgdexCalls, 5, 'five failed requests, then the pass stops: the other three cards are not asked and there is no retry round');
  assert.equal(result.done, 0);
  assert.equal(result.failedData, 0);
  assert.deepStrictEqual(said.filter((m) => /paused/i.test(m)), ['⚠ Pricing paused: network trouble, will retry'], 'one toast, and it says so');
  assert.equal(ctx.DB.singles.filter((r) => r._tcgdexMissDate).length, 0, 'an outage stamps nothing');
  assert.deepStrictEqual(plain(q.tcgdexRetry.map((i) => i.id)), ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'], 'every card waits for the next run, asked or not');
  assert.equal(q.lastTcgdexPass, undefined, 'a pass that stopped early is not stamped as done');
  assert.equal(ctx._tcgdexLaneHasWork({ items: [], tcgdexRetry: q.tcgdexRetry }, TODAY()), true, 'so the next run has work');
});

test('price-transient: four failures in a row still get their retry round', async () => {
  const { ctx, fetchMock, timers } = await loadApp({
    seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2'), single('s3', 'Charlie 3'), single('s4', 'Delta 4'), single('s5', 'Echo 5')] },
  });
  tcgdex(fetchMock, { Alpha: (n) => (n === 1 ? 503 : 'ok'), Bravo: (n) => (n === 1 ? 503 : 'ok'), Charlie: (n) => (n === 1 ? 503 : 'ok'), Delta: (n) => (n === 1 ? 503 : 'ok') });
  const q = { items: ['Alpha 1', 'Bravo 2', 'Charlie 3', 'Delta 4', 'Echo 5'].map((n, i) => laneItem('s' + (i + 1), n)) };
  const result = plain(await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers));
  assert.equal(result.paused, false, 'four is under the limit, and the fifth card was answered');
  assert.equal(result.done, 5);
  assert.equal(result.recovered, 4);
});

test('price-transient: cards still unanswered after the retry round stay unstamped in q.tcgdexRetry and the next run prices them', async () => {
  const { ctx, fetchMock, timers } = await loadApp({
    seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2'), single('s3', 'Charlie 3'), single('s4', 'Delta 4')] },
  });
  let up = false;
  const t = tcgdex(fetchMock, {
    Bravo: () => (up ? 'ok' : 503),
    Charlie: () => (up ? 'ok' : 'throw'),
  });
  const q = { items: ['Alpha 1', 'Bravo 2', 'Charlie 3', 'Delta 4'].map((n, i) => laneItem('s' + (i + 1), n)), cursor: 0 };

  const first = plain(await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers));
  assert.equal(first.done, 2);
  assert.equal(first.unanswered, 2, 'Bravo and Charlie never got an answer, even after the retry');
  assert.equal(first.paused, false);
  assert.equal(t.calls.Bravo, 2, 'asked, then once more after the backoff, and no more than that');
  assert.equal(t.calls.Charlie, 2);
  assert.deepStrictEqual(plain(q.tcgdexRetry.map((i) => i.id)), ['s2', 's3']);
  assert.ok(!rowOf(ctx, 's2')._tcgdexMissDate);
  assert.ok(!rowOf(ctx, 's3')._tcgdexMissDate);
  assert.equal(ctx._kjrUnresolvedSingles().length, 0, 'unanswered is not unmatched');
  assert.equal(q.lastTcgdexPass, TODAY());

  // The runner drops the lane's items from q.items after a pass (_runRefreshQueueBody), so what survives is q.tcgdexRetry, persisted as JSON.
  const persisted = JSON.parse(JSON.stringify(Object.assign({}, q, { items: [] })));
  assert.equal(ctx._tcgdexLaneHasWork(persisted, TODAY()), true, 'the waiting cards count as work for the next run');

  up = true;
  const second = plain(await runWithTimerDrain(() => ctx._runTcgdexLane(persisted, false, TODAY()), timers));
  assert.equal(second.done, 2, 'the next run asked them again and priced them');
  assert.equal(second.alreadyPriced, 2, 'and found the other two already priced today');
  assert.equal(persisted.tcgdexRetry, undefined, 'nothing waits any more');
  assert.ok(Number(rowOf(ctx, 's2').marketPrice) > 0);
  assert.ok(Number(rowOf(ctx, 's3').marketPrice) > 0);
  assert.equal(ctx._tcgdexLaneHasWork(persisted, TODAY()), false);
});

test('price-transient: runRefreshQueue picks the waiting cards up on a later run of a queue that is already complete', async () => {
  const { ctx, fetchMock, timers, localStorage } = await loadApp({
    seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2')] },
  });
  tcgdex(fetchMock, {});
  const today = TODAY();
  // What a finished run left behind: the lane's items gone from q.items, the PPT lane complete, two cards waiting.
  const q = ctx.buildRefreshQueue();
  q.tcgdexRetry = q.items.filter((i) => i.lane === 'tcgdex');
  q.items = [];
  q.totalItems = 0;
  q.completed = true;
  q.lastTcgdexPass = today;
  localStorage.setItem('pokeinv_refresh_queue', JSON.stringify(q));

  await runWithTimerDrain(() => ctx.runRefreshQueue(false), timers);
  assert.ok(Number(rowOf(ctx, 's1').marketPrice) > 0, 'priced by the later run');
  assert.ok(Number(rowOf(ctx, 's2').marketPrice) > 0);
  const saved = JSON.parse(localStorage.getItem('pokeinv_refresh_queue'));
  assert.equal(saved.tcgdexRetry, undefined, 'and the waiting list is empty');
});

test('price-transient: a waiting card that was sold, renamed or flagged custom meanwhile is checked against its live row', async () => {
  const { ctx, fetchMock, timers } = await loadApp({
    seed: {
      singles: [
        single('sold', 'Alpha 1', { status: 'Sold' }),
        single('renamed', 'Bravo 2'),
        single('custom', 'Charlie 3', { customCard: true }),
        single('gone-lane', 'Delta', { language: 'JP' }),
      ],
    },
  });
  const t = tcgdex(fetchMock, {});
  const waiting = [laneItem('sold', 'Alpha 1'), laneItem('renamed', 'Old Name 9'), laneItem('custom', 'Charlie 3'), laneItem('gone-lane', 'Delta 4'), laneItem('deleted', 'Echo 5')];
  const q = { items: [], tcgdexRetry: waiting };
  const result = plain(await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers));
  assert.equal(result.total, 1, 'only the renamed card is still a free-lane card');
  assert.deepStrictEqual(Object.keys(t.calls), ['Bravo'], 'and it is asked under the name it has now');
  assert.ok(Number(rowOf(ctx, 'renamed').marketPrice) > 0);
  assert.equal(rowOf(ctx, 'custom').marketPrice, '', 'a custom card takes no automatic price');
});

test('price-transient: a 429 waits three times as long before the retry round', async () => {
  const run = async (status) => {
    const { ctx, fetchMock, timers } = await loadApp({ seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2')] } });
    tcgdex(fetchMock, { Alpha: (n) => (n === 1 ? status : 'ok') });
    const delays = [];
    const real = ctx.setTimeout;
    ctx.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return real(fn, ms, ...rest); };
    const q = { items: [laneItem('s1', 'Alpha 1'), laneItem('s2', 'Bravo 2')] };
    await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers);
    return delays;
  };
  const plainBlip = await run(503);
  const limited = await run(429);
  assert.ok(plainBlip.includes(2000), 'a 5xx waits the base backoff: ' + plainBlip);
  assert.ok(limited.includes(6000), 'a 429 waits three times that: ' + limited);
  assert.ok(!limited.includes(2000));
});

test('price-transient: a retry round larger than the cap asks the first 50 and leaves the rest waiting', async () => {
  const total = 70;
  const names = Array.from({ length: total }, (_, i) => 'Name' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(97 + Math.floor(i / 26)) + ' ' + (i + 1));
  const { ctx, fetchMock, timers } = await loadApp({ seed: { singles: names.map((n, i) => single('s' + i, n)) } });
  // every fourth card is answered the first time, so no streak of five unanswered ever builds, and the other 52 are answered on the retry
  const script = {};
  names.forEach((n, i) => { script[n.split(' ')[0]] = (c) => (i % 4 === 0 || c > 1 ? 'ok' : 503); });
  const t = tcgdex(fetchMock, script);
  const q = { items: names.map((n, i) => laneItem('s' + i, n)) };
  const result = plain(await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers, 800));
  assert.equal(Object.values(t.calls).filter((c) => c === 2).length, 50, 'the retry round is capped at 50 cards');
  assert.equal(Object.values(t.calls).filter((c) => c === 1).length, 20, '18 answered the first time, and 2 beyond the cap were not asked again');
  assert.equal(result.recovered, 50);
  assert.equal(result.done, 68);
  assert.equal(result.unanswered, 2, 'the two beyond the cap are not given up on');
  assert.equal(q.tcgdexRetry.length, 2, 'they wait for the next run');
  assert.ok(!rowOf(ctx, q.tcgdexRetry[0].id)._tcgdexMissDate);
});

test('price-transient: the progress label and the counter say the same thing', async () => {
  const { ctx, fetchMock, timers } = await loadApp({ seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2'), single('s3', 'Charlie 3')] } });
  tcgdex(fetchMock, {});
  const seen = [];
  ctx.showSyncProgress = (current, total, label) => seen.push([current, total, label]);
  const q = { items: [laneItem('s1', 'Alpha 1'), laneItem('s2', 'Bravo 2'), laneItem('s3', 'Charlie 3')] };
  await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers);
  assert.deepStrictEqual(seen, [
    [0, 3, 'Exact (TCGdex): checking card 1 of 3'],
    [1, 3, 'Exact (TCGdex): checking card 2 of 3'],
    [2, 3, 'Exact (TCGdex): checking card 3 of 3'],
  ], 'the counter counts cards done (0, 1, 2), the label names the card in hand (1 of 3, 2 of 3, 3 of 3)');
});

test('price-transient: the retry round has its own progress wording', async () => {
  const { ctx, fetchMock, timers } = await loadApp({ seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2')] } });
  tcgdex(fetchMock, { Alpha: (n) => (n === 1 ? 503 : 'ok') });
  const seen = [];
  ctx.showSyncProgress = (current, total, label) => seen.push(label);
  const q = { items: [laneItem('s1', 'Alpha 1'), laneItem('s2', 'Bravo 2')] };
  await runWithTimerDrain(() => ctx._runTcgdexLane(q, false, TODAY()), timers);
  assert.deepStrictEqual(seen, ['Exact (TCGdex): checking card 1 of 2', 'Exact (TCGdex): checking card 2 of 2', 'Exact (TCGdex): retrying card 1 of 1']);
});

test('price-transient: manual run now still re-asks cards that missed earlier today', async () => {
  const { ctx, fetchMock, timers } = await loadApp({ seed: { singles: [single('s1', 'Alpha 1', { _tcgdexMissDate: TODAY() })] } });
  const t = tcgdex(fetchMock, {});
  const auto = plain(await runWithTimerDrain(() => ctx._runTcgdexLane({ items: [laneItem('s1', 'Alpha 1')] }, false, TODAY()), timers));
  assert.equal(auto.total, 1);
  assert.equal(t.calls.Alpha, undefined, 'an auto run leaves a known miss alone');
  const manual = plain(await runWithTimerDrain(() => ctx._runTcgdexLane({ items: [laneItem('s1', 'Alpha 1')] }, true, TODAY()), timers));
  assert.equal(manual.done, 1);
  assert.equal(rowOf(ctx, 's1')._tcgdexMissDate, null, 'priced, so the stale stamp is cleared');
});

test('price-transient: the run summary names the cards waiting and a pass that stopped early', async () => {
  const { ctx } = await loadApp();
  assert.equal(ctx._tcgdexNote({ ran: false }), '');
  assert.equal(ctx._tcgdexNote({ ran: true, done: 12, total: 14, unanswered: 0, paused: false }), ' · Exact (TCGdex): 12/14 priced');
  assert.equal(ctx._tcgdexNote({ ran: true, done: 12, total: 14, unanswered: 2, paused: false }), ' · Exact (TCGdex): 12/14 priced (2 waiting to retry)');
  assert.equal(ctx._tcgdexNote({ ran: true, done: 3, total: 14, unanswered: 11, paused: true }), ' · Exact (TCGdex): 3/14 priced (paused, network trouble, will retry)');
});

// ── refreshPrice (the inspector's Refresh price) ──────────────────────────────────────────────────────────────────────────────────

test('price-transient: refreshPrice does not stamp a miss for a network blip, and still stamps a real one', async () => {
  const { ctx, fetchMock } = await loadApp({ seed: { singles: [single('s1', 'Alpha 1'), single('s2', 'Bravo 2')] } });
  const said = captureToasts(ctx);
  tcgdex(fetchMock, { Alpha: () => 503, Bravo: () => 'empty' });
  await ctx.refreshPrice('s1', 'singles');
  assert.equal(rowOf(ctx, 's1')._tcgdexMissDate, undefined, 'a 503 stamps nothing');
  assert.match(said.join('|'), /Could not reach TCGdex \(HTTP 503\)/);
  assert.doesNotMatch(said.join('|'), /No price found/);
  said.length = 0;
  await ctx.refreshPrice('s2', 'singles');
  assert.equal(rowOf(ctx, 's2')._tcgdexMissDate, TODAY(), 'an empty list is a miss, as before');
  assert.match(said.join('|'), /No price found/);
});

// ── Bug 2: freshness and "Prices checked" ─────────────────────────────────────────────────────────────────────────────────────────

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const priced = (id, extra) => single(id, 'Card ' + id + ' 1', Object.assign({ marketPrice: '40', priceHistory: [{ date: daysAgo(40), price: 40, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high' }] }, extra || {}));

test('price-transient: kjrPriceCheckedTs is the newer of the last history day and the local marker', async () => {
  const { ctx } = await loadApp();
  const midnight = (d) => new Date(d + 'T00:00:00').getTime();
  assert.equal(ctx.kjrPriceCheckedTs({ priceHistory: [{ date: '2026-09-01' }] }), midnight('2026-09-01'));
  assert.equal(ctx.kjrPriceCheckedTs({ priceHistory: [{ date: '2026-09-01' }], _tcgdexPricedDate: '2026-10-19' }), midnight('2026-10-19'), 'a same-value re-check is newer than the history');
  assert.equal(ctx.kjrPriceCheckedTs({ priceHistory: [{ date: '2026-10-19' }], _tcgdexPricedDate: '2026-09-01' }), midnight('2026-10-19'), 'and the history wins when it is newer');
  assert.equal(ctx.kjrPriceCheckedTs({ _tcgdexPricedDate: '2026-10-19' }), midnight('2026-10-19'), 'a hand-priced card re-checked at the same value has a marker and no history');
  assert.equal(ctx.kjrPriceCheckedTs({}), 0);
  assert.equal(ctx.kjrPriceCheckedTs({ priceHistory: [], _tcgdexPricedDate: '' }), 0);
  assert.equal(ctx.kjrPriceCheckedTs({ priceHistory: [{ date: 'not a date' }], _tcgdexPricedDate: 'junk' }), 0, 'junk is ignored, never NaN');
  assert.equal(ctx.kjrPriceCheckedTs({ priceHistory: [{ date: null }, null] }), 0);
  assert.equal(ctx.kjrPriceCheckedTs(null), 0);
});

// With no refresh queue on file the Overview forces the dot amber ("auto-refresh starting"), so these runs have a finished queue.
const finishedQueue = { schemaVersion: 2, items: [], cursor: 0, totalItems: 0, totalRows: 4, dayCreditsUsed: {}, createdAt: '2026-10-01T00:00:00.000Z', completed: true };

test('price-transient: a full pass of same-value re-checks reads current, not stale', async () => {
  const marker = TODAY();
  const stale = await loadApp({ seed: { singles: [priced('a'), priced('b'), priced('c')] }, localStorage: { pokeinv_refresh_queue: finishedQueue } });
  stale.ctx.renderDashboard();
  assert.match(stale.document.getElementById('dash-last-updated').textContent, /^Prices checked \d+ [A-Z][a-z]{2} \d{4} · 100% priced$/, 'history alone: last priced 40 days ago');
  assert.match(stale.document.getElementById('dash-trust-dot').className, /\bbad\b/, 'and the trust dot is red');

  const fresh = await loadApp({
    seed: { singles: [priced('a', { _tcgdexPricedDate: marker }), priced('b', { _tcgdexPricedDate: marker }), priced('c', { _tcgdexPricedDate: marker })] },
    localStorage: { pokeinv_refresh_queue: finishedQueue },
  });
  fresh.ctx.renderDashboard();
  assert.equal(fresh.document.getElementById('dash-last-updated').textContent, 'Prices checked today · 100% priced');
  assert.match(fresh.document.getElementById('dash-trust-dot').className, /\bok\b/, 'the same inventory, all re-checked today, reads current');
});

test('price-transient: freshness counts a marker on only some cards, and does not mark anything dirty', async () => {
  const { ctx, document, grab } = await loadApp({
    seed: { singles: [priced('a', { _tcgdexPricedDate: TODAY() }), priced('b', { _tcgdexPricedDate: TODAY() }), priced('c'), priced('d')] },
    localStorage: { pokeinv_refresh_queue: finishedQueue },
  });
  const dirtyBefore = grab('_dirty')._dirty.singles.size;
  const rowsBefore = JSON.stringify(ctx.DB.singles);
  ctx.renderDashboard();
  assert.equal(document.getElementById('dash-last-updated').textContent, 'Prices checked today · 100% priced', 'the newest check among the cards');
  assert.match(document.getElementById('dash-trust-dot').className, /\bwarn\b/, '2 of 4 fresh is partly current, not red and not green');
  assert.equal(grab('_dirty')._dirty.singles.size, dirtyBefore, 'reading the marker never marks a row dirty');
  assert.equal(JSON.stringify(ctx.DB.singles), rowsBefore, 'and never changes a row');
});

test('price-transient: the marker is device-local: it never goes into the synced row', async () => {
  const { ctx } = await loadApp();
  const row = priced('a', { _tcgdexPricedDate: TODAY(), _tcgdexMissDate: TODAY() });
  const data = ctx._stripInternalData(row);
  assert.equal('_tcgdexPricedDate' in data, false);
  assert.equal('_tcgdexMissDate' in data, false);
  assert.equal(data.marketPrice, '40');
});

test('price-transient: a same-value re-price stamps the marker, appends no history and does not mark the row dirty', async () => {
  const { ctx, grab } = await loadApp({ seed: { singles: [priced('a', { marketPrice: '40' })] } });
  const historyBefore = rowOf(ctx, 'a').priceHistory.length;
  ctx.applyPriceToGroup('a', 'singles', [], 40, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  const row = rowOf(ctx, 'a');
  assert.equal(row.priceHistory.length, historyBefore, 'the no-op rule stands: no history entry');
  assert.equal(row._tcgdexPricedDate, TODAY());
  assert.equal(grab('_dirty')._dirty.singles.has('a'), false, 'and no phantom sync');
  assert.equal(ctx.kjrPriceCheckedTs(row) > new Date(daysAgo(1) + 'T00:00:00').getTime(), true, 'yet the card now reads as checked today');
});

test('price-transient: the list dot, the summary strip dot and the inspector line read the same check as the Overview', async () => {
  const { ctx } = await loadApp();
  const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const stale = { marketPrice: 45, priceHistory: [{ date: iso(40), price: 45, source: 'TCGdex (TCGplayer)', confidence: 'high' }] };
  const rechecked = Object.assign({}, stale, { _tcgdexPricedDate: iso(0) }); // the same card, looked at again today at the same price

  // the per-row dot on the list: the last entry alone said amber, the re-check says green
  assert.match(ctx._mktFreshDot(stale), /#f59e0b/, 'history only: 40 days, amber');
  const dot = ctx._mktFreshDot(rechecked);
  assert.match(dot, /#22c55e/, 're-checked today: green');
  assert.match(dot, /title="Refreshed \d{4}-\d{2}-\d{2} \(today\) · TCGdex \(TCGplayer\) · high confidence"/, 'the date is the newest check, source and confidence are still the last price written');
  assert.match(ctx._mktFreshDot({ marketPrice: 45, priceHistory: [], _tcgdexPricedDate: iso(0) }), /#22c55e/, 'a hand price confirmed today has a marker and no history, it gets a dot');
  assert.equal(ctx._mktFreshDot({ marketPrice: 45, priceHistory: [] }), '', 'no history and no marker: still no dot');
  assert.equal(ctx._mktFreshDot({ marketPrice: '', priceHistory: [], _tcgdexPricedDate: iso(0) }), '', 'and no price: still none');
  assert.match(ctx._mktFreshDot({ marketPrice: 45, priceHistory: [{ date: iso(40), confidence: 'low' }], _tcgdexPricedDate: iso(0) }), /#f59e0b/, 'a fuzzy match is amber whatever its age');
  assert.match(ctx._mktFreshDot({ marketPrice: 45, priceHistory: [{ date: 'junk' }] }), /Price age unknown/, 'an unreadable date is still the grey dot');
  assert.match(ctx._mktFreshDot({ marketPrice: 45, priceHistory: [{ date: '23 Aug' }] }), /Refreshed \d{4}-08-23/, 'a legacy day-month label is read, and shown as the day it is');

  // the summary strip: the oldest check among the cards
  const recent = { marketPrice: 10, priceHistory: [{ date: iso(5) }] };
  assert.match(ctx._statMktFreshDot([stale, recent]), /#f59e0b.*Oldest refresh: 40 days ago/);
  assert.match(ctx._statMktFreshDot([rechecked, recent]), /#22c55e.*Oldest refresh: 5 days ago/, 'the re-checked card is no longer the oldest');
  assert.equal(ctx._statMktFreshDot([{ marketPrice: 45, priceHistory: [] }]), '');
  assert.match(ctx._statMktFreshDot([{ marketPrice: 45, priceHistory: [], _tcgdexPricedDate: iso(0) }]), /#22c55e/);

  // the inspector's line under the chart
  const now = Date.now();
  assert.match(ctx.kjrInspectPriceLine('singles', stale, now), /^TCGplayer market via TCGdex · checked \d+ [A-Z][a-z]{2} \d{4}$/, 'history only: the old date');
  assert.match(ctx.kjrInspectPriceLine('singles', rechecked, now), /^TCGplayer market via TCGdex · checked today$/, 'a re-check: today');
  assert.match(ctx.kjrInspectPriceLine('singles', { marketPrice: 12, priceHistory: [], _tcgdexPricedDate: iso(0), language: 'EN', name: 'Pikachu 25' }, now), /^Manual price · checked today$/);
  assert.equal(ctx.kjrInspectPriceLine('singles', { marketPrice: 12, priceHistory: [], language: 'EN', name: 'Pikachu 25' }, now), 'Manual price', 'no record at all: as before');
});

test('price-transient: every freshness reader names the same day for the same card', async () => {
  const { ctx } = await loadApp();
  const iso = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const row = { marketPrice: 45, priceHistory: [{ date: iso(30), price: 45 }], _tcgdexPricedDate: iso(2) };
  const ts = ctx.kjrPriceCheckedTs(row);
  assert.equal(ts, new Date(iso(2) + 'T00:00:00').getTime());
  assert.match(ctx._mktFreshDot(row), new RegExp('Refreshed ' + iso(2)), 'the list dot');
  assert.match(ctx.kjrInspectPriceLine('singles', row, Date.now()), /checked 2 days ago/, 'the inspector');
  assert.match(ctx._statMktFreshDot([row]), /Oldest refresh: 2 days ago/, 'the strip');
});

test('price-transient: every reader counts age in UTC days, so none says "1 day ago" while the Overview says today', async () => {
  // 03:00 in Singapore on 21/10/2026 is 19:00Z on 20/10/2026. The price code stamps UTC dates, so a price checked a moment ago carries
  // 2026-10-20 while the local clock already reads the 21st. The Overview text counted UTC days, the list dot, the summary strip dot
  // and the Overview tooltip counted elapsed hours, so for those 8 hours every morning they said "1 day ago" for a card just checked.
  const { ctx, document } = await loadApp({
    seed: { singles: [single('a', 'Card a 1', { marketPrice: '45', priceHistory: [{ date: '2026-10-20', price: 45, source: 'TCGdex (TCGplayer)', confidence: 'high' }] })] },
    localStorage: { pokeinv_refresh_queue: Object.assign({}, finishedQueue, { completed: false, totalRows: 1 }) },
  });
  const realNow = ctx.Date.now;
  try {
    const row = rowOf(ctx, 'a');
    const ts = ctx.kjrPriceCheckedTs(row);

    const early = Date.UTC(2026, 9, 20, 19, 0, 0);
    ctx.Date.now = () => early;
    assert.equal(ctx.kjrCheckedDays(ts, early), 0);
    assert.equal(ctx.kjrOverviewCheckedText(ts, early), 'today', 'the Overview text');
    assert.match(ctx.kjrInspectPriceLine('singles', row, early), /checked today$/, 'the inspector');
    assert.match(ctx._mktFreshDot(row), /\(today\)/, 'the list dot');
    assert.match(ctx._statMktFreshDot([row]), /Oldest refresh: today/, 'the summary strip dot');
    ctx.renderDashboard();
    assert.equal(document.getElementById('dash-last-updated').textContent, 'Prices checked today · 100% priced');
    assert.match(document.getElementById('dash-sub').title, /refreshed today/, 'and the Overview tooltip, which counts days its own way');

    // one UTC day later they all say one day
    const later = Date.UTC(2026, 9, 21, 1, 0, 0);
    ctx.Date.now = () => later;
    assert.equal(ctx.kjrCheckedDays(ts, later), 1);
    assert.equal(ctx.kjrOverviewCheckedText(ts, later), 'yesterday');
    assert.match(ctx.kjrInspectPriceLine('singles', row, later), /checked yesterday$/);
    assert.match(ctx._mktFreshDot(row), /\(1 day ago\)/);
    assert.match(ctx._statMktFreshDot([row]), /Oldest refresh: 1 day ago/);
    ctx.renderDashboard();
    assert.match(document.getElementById('dash-sub').title, /refreshed yesterday/);

    // a check dated after the clock (a device whose clock ran slow) is today, never "-1 days ago"
    const ahead = { marketPrice: 45, priceHistory: [{ date: '2026-10-22' }] };
    ctx.Date.now = () => early;
    assert.equal(ctx.kjrCheckedDays(ctx.kjrPriceCheckedTs(ahead), early), 0);
    assert.match(ctx._mktFreshDot(ahead), /\(today\)/);
    assert.match(ctx._statMktFreshDot([ahead]), /Oldest refresh: today/);
  } finally {
    ctx.Date.now = realNow;
  }
});
