'use strict';
// v3.85, the PPT credit budget. The vendor bills in credits (one per card returned, one more per card with includeEbay) and refuses with
// "Daily credit limit exceeded" once the day's are gone. The queue counts credits (the answer's metadata.apiCallsConsumed.total, else an
// estimate of 3 per search, 6 with eBay), spends against a budget set by the plan (Free 90 of 100, Paid 18,000 of 20,000), and reads the
// refusal as a pause for the rest of the vendor's day. Fetch is stubbed (tests/harness.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, makeSeed, jsonResponse, plain, ROOT } = require('./harness.js');
const { setClock, utcDayOf } = require('./clock.js');

const QUEUE_KEY = 'pokeinv_refresh_queue';
const UTC = () => new Date().toISOString().slice(0, 10);

const slab = (id, name, extra) => Object.assign({
  id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', costPrice: 500, marketPrice: '', status: 'Available', priceHistory: [],
}, extra || {});
const single = (id, name, extra) => Object.assign({ id, name, language: 'EN', status: 'Available', type: 'raw', costPrice: 5, marketPrice: '', priceHistory: [] }, extra || {});
// "Alpha 1" is card number 1 of the vendor's set, priced 100 plus its number at PSA 10
const NUMBERED = ['Alpha 1', 'Bravo 2', 'Charlie 3', 'Delta 4', 'Echo 5', 'Foxtrot 6', 'Golf 7', 'Hotel 8', 'India 9', 'Juliet 10',
  'Kilo 11', 'Lima 12', 'Mike 13', 'Nova 14', 'Oscar 15', 'Papa 16', 'Quebec 17', 'Romeo 18', 'Sierra 19', 'Tango 20'];
const manySlabs = (n) => NUMBERED.slice(0, n).map((name, i) => slab('s' + (i + 1), name, { costPrice: 1000 - i }));
const vendorCard = (search) => {
  const m = /^(.+) (\d+)$/.exec(search);
  return m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};
const searchOf = (url) => decodeURIComponent(new URL(url).searchParams.get('search'));
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total } } });

async function drain(fn, timers, seen) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 600 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    if (seen) timers.list().forEach((t) => seen.add(t.delay));
    timers.flush((e) => [6000, 1100, 250, 2000].includes(e.delay));
  }
  return p;
}

// total: what the vendor says each search cost. Slab searches carry includeEbay, so a total of 6 is the real price of one.
// jaLane: this suite forces the Japanese lane OFF unless a test asks for it (the constant PPT_JA_LANE_ENABLED is true since v3.89), so each test names the state it means
async function setup(seed, opts) {
  const o = Object.assign({ total: 6, local: null, jaLane: false }, opts || {});
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), localStorage: o.local || undefined, jaLane: o.jaLane });
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  app.fetchMock.route('/ppt/cards', (url) => answer([vendorCard(searchOf(url))].filter(Boolean), o.total));
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  app.slabRow = (id) => app.ctx.DB.slabs.find((r) => r.id === id);
  return app;
}
const queueWith = (items, extra) => Object.assign({
  schemaVersion: 2, items, cursor: 0, totalItems: items.length, totalRows: items.length, createdAt: '2026-10-01T00:00:00.000Z', doneToday: 0,
  dayCreditsUsed: {}, lastTcgdexPass: null, completed: false, creditsVersion: 1, freeLaneDay: 'local',
}, extra || {});
const entryOf = (row) => ({ id: row.id, table: 'slabs', lane: 'ppt', name: row.name, grader: 'PSA', grade: '10', language: null, tcgdexId: null, costPrice: row.costPrice, isPrimary: true, copyTargets: [], uniqueKey: row.name.toLowerCase() + '|EN|psa|10' });

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-credits: the plan is Free by default, 90 credits and a 6 second gap, Paid is 18,000 and 1.1 seconds', async () => {
  const app = await setup();
  const { ctx } = app;
  assert.equal(ctx.kjrPptPlan(), 'free');
  assert.equal(ctx.kjrDailyCredits(), 90);
  assert.equal(ctx.kjrRequestGapMs(), 6000);
  assert.equal(ctx.kjrPptSetPlan('paid'), true);
  assert.equal(app.localStorage.getItem('pokeinv_ppt_plan'), 'paid');
  assert.equal(ctx.kjrPptPlan(), 'paid');
  assert.equal(ctx.kjrDailyCredits(), 18000);
  assert.equal(ctx.kjrRequestGapMs(), 1100);
  assert.equal(ctx.kjrPptSetPlan('free'), true);
  assert.equal(ctx.kjrDailyCredits(), 90);
});

test('ppt-credits: only "free" and "paid" are plans, anything else is refused and a bad stored value reads as Free', async () => {
  const app = await setup();
  const { ctx } = app;
  for (const bad of ['gold', 'PAID', '', null, undefined, 1, {}, 'paid ']) {
    assert.equal(ctx.kjrPptSetPlan(bad), false, String(bad));
    assert.equal(app.localStorage.getItem('pokeinv_ppt_plan'), null, 'nothing was stored for ' + String(bad));
  }
  for (const stored of ['PAID', 'Paid', 'gold', '1', ' paid', 'true']) {
    app.localStorage.setItem('pokeinv_ppt_plan', stored);
    assert.equal(ctx.kjrPptPlan(), 'free', 'stored ' + JSON.stringify(stored));
    assert.equal(ctx.kjrDailyCredits(), 90);
  }
  const real = app.localStorage.getItem;
  app.localStorage.setItem('pokeinv_ppt_plan', 'paid');
  app.localStorage.getItem = () => { throw new Error('storage blocked'); };
  assert.equal(ctx.kjrPptPlan(), 'free', 'a browser that blocks storage is Free');
  app.localStorage.getItem = real;
  app.localStorage.setItem = () => { throw new Error('quota'); };
  assert.equal(ctx.kjrPptSetPlan('paid'), false, 'and a plan that can not be saved says so');
});

test('ppt-credits: changing the plan gives today\'s refusal a fresh start', async () => {
  const app = await setup({ slabs: [slab('s1', 'Alpha 1')] });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith([entryOf(slab('s1', 'Alpha 1'))], { creditsPausedDate: UTC() })));
  app.ctx.kjrPptSetPlan('paid');
  assert.equal(app.saved().creditsPausedDate, null);
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), UTC()), 18000);
});

// ── counting credits ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-credits: an answer costs what its metadata.apiCallsConsumed.total says, else 3 for a search and 6 with eBay', async () => {
  const { ctx } = await setup();
  const of = (data, ebay) => ctx._pptCreditsOf(data, ebay);
  assert.equal(of({ metadata: { apiCallsConsumed: { total: 4, breakdown: { cards: 2, ebay: 2 }, costPerCard: 2 } } }, true), 4);
  assert.equal(of({ metadata: { apiCallsConsumed: { total: 0 } } }, true), 0, 'an empty answer that cost nothing');
  assert.equal(of({ metadata: { apiCallsConsumed: { total: 1 } } }, false), 1, 'one card returned');
  assert.equal(of({ metadata: { apiCallsConsumed: 7 } }, false), 7, 'a bare number');
  assert.equal(of({ metadata: { apiCallsConsumed: { total: '5' } } }, false), 5, 'a numeric string');
  for (const odd of [{}, { metadata: {} }, { metadata: { apiCallsConsumed: {} } }, { metadata: { apiCallsConsumed: { total: -2 } } }, { metadata: { apiCallsConsumed: { total: 'lots' } } },
    { metadata: { apiCallsConsumed: { total: NaN } } }, { metadata: { apiCallsConsumed: { total: 1e9 } } }, { metadata: { apiCallsConsumed: [3] } }, { metadata: null }, null, undefined, 'x', 7]) {
    assert.equal(of(odd, false), 3, 'estimated at 3: ' + JSON.stringify(odd));
    assert.equal(of(odd, true), 6, 'and 6 with eBay: ' + JSON.stringify(odd));
  }
});

test('ppt-credits: the queue bills the vendor\'s own total for each answer, a refused request and a transport failure bill nothing', async () => {
  const slabs = manySlabs(4);
  const app = await setup({ slabs });
  const totals = { 'Alpha 1': 6, 'Bravo 2': 4, 'Charlie 3': 0 };
  app.fetchMock.route('/ppt/cards', (url) => {
    const s = searchOf(url);
    if (s === 'Delta 4') return jsonResponse({ error: 'boom' }, 500);
    return answer([vendorCard(s)], totals[s]);
  });
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.saved().dayCreditsUsed[UTC()], 10, '6 + 4 + 0, the 500 cost nothing');
  assert.equal(app.saved().creditsVersion, 1);
});

// ── the budget ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-credits: the free plan stops at its 90 credits, 15 slab searches, and waits for tomorrow', async () => {
  const app = await setup({ slabs: manySlabs(20) });
  const seen = new Set();
  await drain(() => app.ctx.runRefreshQueue(false), app.timers, seen);
  assert.equal(app.ppt().length, 15, 'fifteen searches at 6 credits is the 90');
  const q = app.saved();
  assert.equal(q.dayCreditsUsed[UTC()], 90);
  assert.equal(q.cursor, 15, 'the cursor stands after the last card asked');
  assert.equal(q.completed, false);
  assert.equal(q.items.length - q.cursor, 5, 'five cards wait');
  assert.ok(seen.has(6000) && !seen.has(1100), 'the free plan\'s 6 second gap');
  assert.equal(app.slabRow('s15').marketPrice, '115');
  assert.equal(app.slabRow('s16').marketPrice, '');
  // the day's budget is spent, so another run today asks for nothing, and says why on a manual one
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  assert.equal(app.ppt().length, 0, 'zero PPT requests once the budget is spent');
  assert.ok(app.toasts.some((t) => /PPT credits are used up for today/.test(t)), JSON.stringify(app.toasts));
});

test('ppt-credits: the paid plan runs the same queue through, with a 1.1 second gap', async () => {
  const app = await setup({ slabs: manySlabs(20) });
  app.ctx.kjrPptSetPlan('paid');
  const seen = new Set();
  await drain(() => app.ctx.runRefreshQueue(false), app.timers, seen);
  assert.equal(app.ppt().length, 20);
  assert.equal(app.saved().dayCreditsUsed[UTC()], 120);
  assert.equal(app.saved().completed, true);
  assert.ok(seen.has(1100) && !seen.has(6000), 'the paid plan\'s gap: ' + [...seen]);
});

test('ppt-credits: a search the credits left can not pay for is not made: 5 left buys neither a slab at 6 nor starts anything', async () => {
  const slabs = manySlabs(2);
  const app = await setup({ slabs });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { dayCreditsUsed: { [UTC()]: 85 } })));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 0, '85 spent, 5 left, a slab search is up to 6');
  const q = app.saved();
  assert.equal(q.cursor, 0, 'nothing advanced');
  assert.equal(q.items.length, 2, 'and nothing was dropped');
  assert.equal(q.dayCreditsUsed[UTC()], 85);
  assert.equal(q.completed, false);
});

test('ppt-credits: with less than the cheapest search left the PPT lane does not start, the free lane still runs', async () => {
  const slabs = manySlabs(1);
  const app = await setup({ slabs, singles: [single('e1', 'Pikachu 25')] });
  app.fetchMock.route('api.tcgdex.net', (url) => /\/cards\?name=/.test(url) ? jsonResponse([{ id: 'sv-25' }]) : jsonResponse({ pricing: { tcgplayer: { holofoil: { marketPrice: 9 } } } }));
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { dayCreditsUsed: { [UTC()]: 88 } })));
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), UTC()), 0, '2 left is less than the cheapest search');
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 0);
  assert.equal(app.ctx.DB.singles.find((r) => r.id === 'e1').marketPrice, '9', 'TCGdex is free and independent of the PPT budget');
});

// ── the vendor refuses for credits ────────────────────────────────────────────────────────────────────────────────────────────────────

const EXHAUSTED = { error: 'Daily credit limit exceeded', retryAfter: 3600, resetsAt: '2026-10-22T00:00:00.000Z' };

async function exhaustedQueue(status, body) {
  const slabs = manySlabs(4);
  const app = await setup({ slabs });
  let n = 0;
  app.fetchMock.route('/ppt/cards', (url) => {
    n++;
    if (n === 2) return status === 200 ? jsonResponse(body === undefined ? EXHAUSTED : body, 200) : jsonResponse(body === undefined ? EXHAUSTED : body, status);
    return answer([vendorCard(searchOf(url))], 6);
  });
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  return app;
}

test('ppt-credits: "Daily credit limit exceeded" pauses the queue for the day: the cursor stays on the card, no card is missed', async () => {
  for (const [status, body] of [[429, undefined], [403, undefined], [402, undefined], [200, undefined], [429, { error: { message: 'Daily credit limit exceeded' } }], [429, { message: 'daily credit limit exceeded, resets 00:00 UTC' }]]) {
    const app = await exhaustedQueue(status, body);
    const q = app.saved();
    const label = status + ' ' + JSON.stringify(body || EXHAUSTED);
    assert.equal(app.ppt().length, 2, 'asked twice, refused once, then no more today: ' + label);
    assert.equal(q.cursor, 1, 'only the first card advanced: ' + label);
    assert.deepEqual(q.items.map((i) => i.id), ['s1', 's2', 's3', 's4'], 'the refused card and the rest stay queued in order');
    assert.equal(q.creditsPausedDate, UTC(), 'paused for the vendor\'s day');
    assert.equal(q.dayCreditsUsed[UTC()], 6, 'only the answered search was billed');
    assert.equal(q.lastPausedReason, null, 'it is not a blocked key, the dashboard chip stays out of the red');
    assert.deepEqual(plain(q.lastErrorTally), {}, 'and it is not tallied as a failure of a card');
    assert.equal(q.completed, false);
    assert.equal(app.slabRow('s1').marketPrice, '101');
    assert.equal(app.slabRow('s2').marketPrice, '', 'nothing written for the refused card');
    assert.equal(app.slabRow('s2').priceHistory.length, 0);
    assert.ok(!('_tcgdexMissDate' in app.slabRow('s2')), 'and no miss stamp');
    assert.ok(app.toasts.some((t) => /PPT credits are used up for today, pricing resumes after the reset \(8am Singapore time\)/.test(t) && /3 waiting for tomorrow/.test(t)), JSON.stringify(app.toasts));
  }
});

test('ppt-credits: after the refusal the day makes no more PPT requests, an automatic run or a repeat', async () => {
  const app = await exhaustedQueue(429);
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 0);
  assert.equal(app.saved().cursor, 1);
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), UTC()), 0);
});

test('ppt-credits: a manual run asks the vendor once more, a refusal costs nothing, and it pauses again', async () => {
  const app = await exhaustedQueue(429);
  app.fetchMock.route('/ppt/cards', () => jsonResponse(EXHAUSTED, 429));
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  assert.equal(app.ppt().length, 1, 'one request, refused at once');
  assert.equal(app.saved().creditsPausedDate, UTC());
  assert.equal(app.saved().cursor, 1);
  // the account was topped up in the meantime: the same manual run goes through
  app.fetchMock.route('/ppt/cards', (url) => answer([vendorCard(searchOf(url))], 6));
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  assert.ok(!app.saved().creditsPausedDate, 'the pause is gone');
  assert.equal(app.saved().cursor, 4, 'the rest were priced');
});

// v3.86: a new vendor day gives the PPT lane a fresh order read off the live inventory (tests/ppt-rolling.test.js has the order itself). The card
// the old cycle had not reached comes first, the four it priced the evening before come after it, and the budget (a whole 90 here) is spent on all five.
test('ppt-credits: the next UTC day, 08:00 in Singapore, the lane asks again, the card nobody has checked first', async () => {
  const slabs = manySlabs(4);
  const app = await setup({ slabs });
  const clock = setClock(app, '2026-10-21T23:30:00Z'); // 07:30 on the 22nd in Singapore, still the 21st in UTC
  let refuse = false;
  app.fetchMock.route('/ppt/cards', (url) => (refuse ? jsonResponse(EXHAUSTED, 429) : answer([vendorCard(searchOf(url))], 6)));
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { dayCreditsUsed: { '2026-10-21': 6 }, cursor: 0 })));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.saved().cursor, 4, 'priced on the 21st (UTC)');
  // a fifth card is added, the vendor is out of credits
  app.ctx.DB.slabs.push(slab('s5', 'Echo 5'));
  const q = app.saved(); q.items.push(entryOf(slab('s5', 'Echo 5'))); q.completed = false; q.totalRows = 5; q.totalItems = 5;
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  refuse = true;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.saved().creditsPausedDate, '2026-10-21');
  app.fetchMock.calls.length = 0;
  clock.set('2026-10-21T23:59:00Z');
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 0, '08:00 has not come: still paused');
  refuse = false;
  clock.set('2026-10-22T00:01:00Z'); // 08:01 in Singapore: the vendor has reset
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.deepEqual(app.ppt().map((c) => searchOf(c.url)), ['Echo 5', 'Delta 4', 'Charlie 3', 'Bravo 2', 'Alpha 1'], 'the new vendor day asks again: the unchecked card, then the four checked a moment ago, the dearer first');
  assert.equal(app.slabRow('s5').marketPrice, '105');
  assert.equal(app.saved().dayCreditsUsed['2026-10-22'], 30, 'and counts from zero on its own day: five searches at 6');
  assert.equal(app.saved().pptDay, '2026-10-22', 'the order is stamped with the vendor day it was made for');
});

test('ppt-credits: a plain 429 or 403 with no body keeps the old hard pause (the key may be blocked), and reads "blocked" in the chip', async () => {
  for (const status of [429, 403]) {
    const app = await setup({ slabs: manySlabs(3) });
    app.fetchMock.route('/ppt/cards', { ok: false, status, text: 'Too Many Requests' });
    await drain(() => app.ctx.runRefreshQueue(false), app.timers);
    const q = app.saved();
    assert.equal(app.ppt().length, 1, 'the first refusal stops the batch: ' + status);
    assert.equal(q.lastPausedReason, 'PPT refused (HTTP ' + status + ')');
    assert.equal(q.cursor, 0);
    assert.equal(q.creditsPausedDate, undefined, 'a bare refusal is not a credit pause: tomorrow\'s run asks again');
    assert.deepEqual(q.items.map((i) => i.id), ['s1', 's2', 's3']);
  }
});

test('ppt-credits: the refusal read from a router call, a price check and an inspector refresh says so and writes nothing', async () => {
  const app = await setup({ slabs: [slab('s1', 'Alpha 1', { marketPrice: 77 })] });
  app.fetchMock.route('/ppt/cards', () => jsonResponse(EXHAUSTED, 429));
  const r = await app.ctx.fetchMarketPrice({ name: 'Alpha 1', grader: 'PSA', grade: '10', language: 'EN' });
  assert.equal(r.creditsExhausted, true);
  assert.equal(r.maxSgd, null);
  assert.equal(r.creditsUsed, 0);
  await app.ctx.refreshPrice('s1', 'slabs');
  assert.equal(app.slabRow('s1').marketPrice, 77, 'the typed price is untouched');
  assert.equal(app.slabRow('s1').priceHistory.length, 0);
  assert.ok(app.toasts.some((t) => /^ERR PokemonPriceTracker credits are used up for today\. They reset at 8am Singapore time/.test(t)), JSON.stringify(app.toasts));
  assert.ok(!app.toasts.some((t) => /No price found/.test(t)), 'it is not reported as a miss');
  assert.equal(app.ctx.DB.slabs[0]._tcgdexMissDate, undefined);
});

test('ppt-credits: a bulk refresh stops at the refusal instead of asking for every other card', async () => {
  const app = await setup({ slabs: manySlabs(3) });
  app.ctx.kjrConfirm = async () => true;
  let n = 0;
  app.fetchMock.route('/ppt/cards', (url) => (++n === 2 ? jsonResponse(EXHAUSTED, 429) : answer([vendorCard(searchOf(url))], 6)));
  await drain(() => app.ctx.bulkRefreshPrices('slabs'), app.timers);
  assert.equal(app.ppt().length, 2);
  assert.equal(app.slabRow('s1').marketPrice, '101');
  assert.equal(app.slabRow('s3').marketPrice, '');
  assert.ok(app.toasts.some((t) => /Done: 1 updated.*PPT credits are used up for today/.test(t)), JSON.stringify(app.toasts));
});

test('ppt-credits: the price check shows the credit message for the refusal', async () => {
  const app = await setup();
  app.document.getElementById('ebay-query').value = 'Alpha 1';
  app.fetchMock.route('api.tcgdex.net', { ok: true, json: [] });
  app.fetchMock.route('/ppt/cards', () => jsonResponse(EXHAUSTED, 429));
  await app.ctx.searchEbay();
  const html = app.document.getElementById('ebay-out').innerHTML;
  assert.match(html, /Daily price-lookup limit reached/);
  assert.match(html, /100 credits a day on the free plan/);
  assert.doesNotMatch(html, /lookups/);
});

// ── an older queue keeps working ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-credits: a queue from before v3.85 counted requests, today\'s figure reads as three times that and the queue is not wiped', async () => {
  const slabs = manySlabs(3);
  const old = queueWith(slabs.map(entryOf), { dayCreditsUsed: { '2026-10-19': 30, [UTC()]: 5 }, cursor: 1, lastTcgdexPass: '2026-10-19' });
  delete old.creditsVersion; delete old.freeLaneDay;
  const app = await setup({ slabs });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(old));
  const q0 = app.ctx.loadQueue();
  assert.ok(q0, 'schema 2 still loads');
  assert.equal(app.ctx.kjrCreditsUsedOn(q0, UTC()), 15, '5 requests, each a limit=3 search');
  assert.equal(app.ctx.kjrCreditsLeft(q0, UTC()), 75);
  assert.equal(app.saved().dayCreditsUsed[UTC()], 5, 'reading does not rewrite the stored queue');
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  const q = app.saved();
  assert.equal(q.schemaVersion, 2, 'not bumped');
  assert.equal(q.createdAt, '2026-10-01T00:00:00.000Z', 'not rebuilt');
  assert.equal(q.creditsVersion, 1);
  assert.equal(q.dayCreditsUsed[UTC()], 15 + 12, 'the converted 15, plus two searches at 6');
  assert.equal(q.dayCreditsUsed['2026-10-19'], 90, 'and the old days read as credits too');
  assert.equal(app.ppt().length, 2, 'it resumed at the cursor: cards 2 and 3');
  assert.equal(q.cursor, 3);
  assert.equal(app.slabRow('s1').marketPrice, '', 'the first card was already done in the old cycle');
});

test('ppt-credits: an old queue that had spent the old 30 requests has spent its 90 credits', async () => {
  const slabs = manySlabs(2);
  const old = queueWith(slabs.map(entryOf), { dayCreditsUsed: { [UTC()]: 30 } });
  delete old.creditsVersion;
  const app = await setup({ slabs });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(old));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 0, 'the free plan\'s day is spent, as it was under the old limit');
  assert.equal(app.saved().cursor, 0);
});

test('ppt-credits: a complete older queue picks up a Japanese single it never had, without a rebuild and without touching the credits', async () => {
  const slabs = manySlabs(1);
  const seed = { slabs, singles: [single('j1', 'Pikachu 25', { language: 'JP', tcgdexId: 'SV1S-025', marketPrice: 40 })] }; // a number and a matched card (v3.89)
  const app = await setup(seed, { jaLane: true });
  app.fetchMock.route('/ppt/cards', (url) => answer([{ id: 'jp', name: 'Pikachu', cardNumber: '25/100', setName: 'SV1S: Scarlet ex', language: 'Japanese', prices: { market: 8 } }], 3));
  const old = queueWith(slabs.map(entryOf), { cursor: 1, completed: true, dayCreditsUsed: { [UTC()]: 2 }, totalRows: 1 });
  delete old.creditsVersion; delete old.freeLaneDay;
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(old));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 1, 'only the new card was asked, the done slab was not asked again');
  assert.match(app.ppt()[0].url, /language=japanese/);
  const q = app.saved();
  assert.equal(app.ctx.DB.singles[0].marketPrice, '8');
  assert.equal(app.ctx.DB.singles[0].priceHistory[0].source, 'PPT (Japanese)');
  assert.equal(q.createdAt, '2026-10-01T00:00:00.000Z', 'no rebuild');
  assert.deepEqual(q.items.map((i) => i.id), ['s1', 'j1'], 'added at the end');
  assert.equal(q.cursor, 2);
  assert.equal(q.completed, true);
  assert.equal(q.dayCreditsUsed[UTC()], 6 + 3, 'the converted 2 requests (6 credits) plus the 3 for this search');
});

test('ppt-credits: topping up adds only what the queue does not hold, copies stay copies, and a queue with nothing to add is left as it was', async () => {
  const slabs = manySlabs(2);
  const app = await setup({ slabs, singles: [single('j1', 'Pikachu 25', { language: 'JP', tcgdexId: 'SV1S-025' }), single('j2', 'Pikachu 25', { language: 'JP', tcgdexId: 'SV1S-025' })] }, { jaLane: true });
  const held = entryOf(slabs[0]);
  const q = queueWith([held, Object.assign({}, entryOf(slabs[1]), { copyTargets: [] })], { cursor: 1, totalRows: 2 });
  const before = JSON.stringify(q);
  assert.equal(app.ctx._pptLaneTopUp(q), true);
  assert.deepEqual(q.items.map((i) => i.id), ['s1', 's2', 'j1'], 'the Japanese pair is one entry');
  assert.deepEqual(plain(q.items[2].copyTargets.map((t) => t.id)), ['j2']);
  assert.equal(q.cursor, 1);
  assert.equal(q.totalRows, 4);
  assert.equal(q.completed, false);
  const after = JSON.stringify(q);
  assert.equal(app.ctx._pptLaneTopUp(q), false, 'a second call finds nothing to add');
  assert.equal(JSON.stringify(q), after);
  assert.notEqual(before, after);
  // a free-lane entry in a queue that has not run yet holds nothing for the PPT lane
  const unrun = queueWith([{ id: 'j1', table: 'singles', lane: 'tcgdex', name: 'Pikachu 25', language: 'JP', copyTargets: [] }]);
  assert.equal(app.ctx._pptLaneTopUp(unrun), true);
  assert.deepEqual(plain(unrun.items.map((i) => i.lane + ':' + i.id)), ['tcgdex:j1', 'ppt:s1', 'ppt:s2', 'ppt:j1'], 'the slabs and the Japanese pair are all new to the PPT lane, the free-lane entry for j1 holds nothing of it');
});

// ── every way a queue is replaced keeps the day's credits ─────────────────────────────────────────────────────────────────────────────

async function spentSetup() {
  const slabs = manySlabs(3);
  const app = await setup({ slabs });
  app.ctx.kjrConfirm = async () => true;
  return { app, slabs };
}
const spent = { creditsVersion: 1, dayCreditsUsed: { [UTC()]: 90 } };

test('ppt-credits: Rebuild Queue after the day\'s credits are spent makes no PPT request', async () => {
  const { app, slabs } = await spentSetup();
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), spent)));
  await app.ctx.startFreshQueue();
  assert.equal(app.saved().cursor, 0, 'the progress did start again');
  assert.equal(app.saved().dayCreditsUsed[UTC()], 90, 'the credits did not');
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  assert.equal(app.ppt().length, 0);
});

test('ppt-credits: a rebuild that replaces an older queue converts its request count and keeps it', async () => {
  const { app, slabs } = await spentSetup();
  const old = queueWith(slabs.map(entryOf), { dayCreditsUsed: { [UTC()]: 30 } });
  delete old.creditsVersion;
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(old));
  await app.ctx.startFreshQueue();
  assert.equal(app.saved().dayCreditsUsed[UTC()], 90, '30 requests were 90 credits');
  assert.equal(app.saved().creditsVersion, 1);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 0);
});

test('ppt-credits: a queue discarded for a schema mismatch hands its credits to the one that replaces it', async () => {
  const { app, slabs } = await spentSetup();
  const stale = queueWith(slabs.map(entryOf), { schemaVersion: 1, dayCreditsUsed: { [UTC()]: 30 } });
  delete stale.creditsVersion;
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(stale));
  assert.equal(app.ctx.loadQueue(), null, 'discarded');
  assert.equal(app.localStorage.getItem(QUEUE_KEY), null);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers); // no queue: the run builds one
  const q = app.saved();
  assert.equal(q.schemaVersion, 2);
  assert.equal(q.dayCreditsUsed[UTC()], 90, 'the old 30 requests are 90 credits on the new queue');
  assert.equal(app.ppt().length, 0, 'so the replacement makes no PPT request today');
  assert.equal(app.localStorage.getItem('pokeinv_refresh_queue_credits'), null, 'and the hand-over record is used up');
});

test('ppt-credits: the same discard on the first run, before anything else has read the queue', async () => {
  const { app, slabs } = await spentSetup();
  const stale = queueWith(slabs.map(entryOf), { schemaVersion: 1, dayCreditsUsed: { [UTC()]: 90 }, creditsPausedDate: UTC() });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(stale));
  await drain(() => app.ctx.runRefreshQueue(true), app.timers); // a manual run reads the queue first, then builds
  assert.equal(app.ppt().length, 0);
  assert.equal(app.saved().dayCreditsUsed[UTC()], 90);
});

test('ppt-credits: a rebuild because the inventory grew keeps the credits too', async () => {
  const { app, slabs } = await spentSetup();
  const done = queueWith(slabs.map(entryOf), spent);
  done.cursor = 3; done.completed = true; done.totalRows = 2; // the queue knew two rows, there are three now
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(done));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  const q = app.saved();
  assert.notEqual(q.createdAt, '2026-10-01T00:00:00.000Z', 'it was rebuilt');
  assert.equal(q.cursor, 0);
  assert.equal(q.dayCreditsUsed[UTC()], 90, 'with the day\'s credits');
  assert.equal(app.ppt().length, 0);
});

test('ppt-credits: Clear drops the queue, not the credits: the queue built after it starts from them', async () => {
  const { app, slabs } = await spentSetup();
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), spent)));
  app.ctx.clearQueue();
  assert.equal(app.localStorage.getItem(QUEUE_KEY), null);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.saved().dayCreditsUsed[UTC()], 90);
  assert.equal(app.ppt().length, 0);
});

test('ppt-credits: a vendor refusal also survives a rebuild, and a rebuild with credits to spare does ask', async () => {
  const { app, slabs } = await spentSetup();
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { creditsVersion: 1, dayCreditsUsed: { [UTC()]: 12 }, creditsPausedDate: UTC() })));
  await app.ctx.startFreshQueue();
  assert.equal(app.saved().creditsPausedDate, UTC());
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 0, 'paused until the reset');
  // control: the same rebuild with the day\'s credits mostly unspent goes on to ask
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { creditsVersion: 1, dayCreditsUsed: { [UTC()]: 12 } })));
  await app.ctx.startFreshQueue();
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 3, 'control: 12 of 90 spent, so the three cards are asked');
  assert.equal(app.saved().dayCreditsUsed[UTC()], 12 + 18);
});

test('ppt-credits: a stash left by an earlier discard does not outlive a newer queue\'s own count', async () => {
  const { app, slabs } = await spentSetup();
  app.localStorage.setItem('pokeinv_refresh_queue_credits', JSON.stringify({ dayCreditsUsed: { [UTC()]: 90 }, creditsPausedDate: null }));
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { creditsVersion: 1, dayCreditsUsed: { [UTC()]: 6 } })));
  await app.ctx.startFreshQueue();
  assert.equal(app.saved().dayCreditsUsed[UTC()], 6, 'the live queue\'s count wins');
  assert.equal(app.localStorage.getItem('pokeinv_refresh_queue_credits'), null);
});

// ── the Settings panel ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-credits: the queue panel says "credits used today X of Y" for the plan, and with the Japanese lane off the tile\'s title names slabs only', async () => {
  const slabs = manySlabs(2);
  const app = await setup({ slabs, singles: [single('c1', 'Pikachu 25', { language: 'CN' })] });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { dayCreditsUsed: { [UTC()]: 24 } })));
  app.ctx._renderQueueStatus();
  const panel = app.document.getElementById('queue-status-panel').innerHTML;
  assert.match(panel, /Search \(PPT\) credits used today<\/div>\s*<div style="font-weight:600">24 of 90<\/div>/);
  assert.match(panel, /title="Slabs \(eBay sold data\), priced via PokemonPriceTracker\. A slab search costs up to 6 credits\. The Free plan is held to 90 credits a day\."/);
  assert.doesNotMatch(panel, /Japanese|Chinese|Indonesian/, 'no claim that a lane runs which does not');
  assert.match(panel, /1 non-English card priced manually, no free source for that language\./, 'the v3.84 wording while every non-English single is manual');
  assert.doesNotMatch(panel, /TCGdex misses|any TCGdex miss/);
  assert.doesNotMatch(panel, /Today's PPT credits are used up/);
  app.ctx.kjrPptSetPlan('paid');
  app.ctx._renderQueueStatus();
  assert.match(app.document.getElementById('queue-status-panel').innerHTML, /24 of 18,000/);
  assert.match(app.document.getElementById('queue-status-panel').innerHTML, /The Paid plan is held to 18,000 credits a day/);
});

test('ppt-credits: with the Japanese lane on the tile\'s title names Japanese singles only, never Chinese or Indonesian ones', async () => {
  const slabs = manySlabs(2);
  const app = await setup({ slabs, singles: [single('c1', 'Pikachu 25', { language: 'CN' }), single('j1', 'Pikachu 25', { language: 'JP', tcgdexId: 'SV1S-025' }), single('j2', 'Pikachu', { language: 'JP', tcgdexId: 'SV1S-025' }), single('j3', 'Pikachu 26', { language: 'JP' })] }, { jaLane: true });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { dayCreditsUsed: { [UTC()]: 24 } })));
  app.ctx._renderQueueStatus();
  const panel = app.document.getElementById('queue-status-panel').innerHTML;
  assert.match(panel, /title="Slabs \(eBay sold data\), plus Japanese singles with a card number and a matched card \(TCGplayer market\), priced via PokemonPriceTracker\. A slab search costs up to 6 credits, a single up to 3\. The Free plan is held to 90 credits a day\."/);
  assert.doesNotMatch(panel, /Chinese|Indonesian/);
  assert.match(panel, /3 non-English cards priced manually\. Only a Japanese card with a card number and a matched card has an automatic source, the card art lookup finds the match, or add the TCGdex ID to the card\./, 'the Chinese card, the numberless Japanese one and the Japanese one with no matched card are manual');
});

test('ppt-credits: spent credits, and a vendor refusal, are said in the panel and the Run button stays usable', async () => {
  const slabs = manySlabs(2);
  const app = await setup({ slabs });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { dayCreditsUsed: { [UTC()]: 90 } })));
  app.ctx._renderQueueStatus();
  let panel = app.document.getElementById('queue-status-panel').innerHTML;
  assert.match(panel, /Today's PPT credits are used up\. The Search lane resumes after the reset at 8am Singapore time \(the Exact\/TCGdex lane is unaffected\)\./);
  assert.match(panel, /color:var\(--amber\)/, 'in the amber token, with words, not colour alone');
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { dayCreditsUsed: { [UTC()]: 12 }, creditsPausedDate: UTC() })));
  app.ctx._renderQueueStatus();
  panel = app.document.getElementById('queue-status-panel').innerHTML;
  assert.match(panel, /PokemonPriceTracker says today's credits are used up\./);
  assert.doesNotMatch(panel, /<button class="btn btn-primary btn-sm" onclick="runRefreshQueue\(true\)" disabled>/, 'a manual run is how the owner asks again');
});

test('ppt-credits: the Overview chip counts credits, not requests', async () => {
  const slabs = manySlabs(2);
  const app = await setup({ slabs });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { dayCreditsUsed: { [UTC()]: 24 } })));
  app.ctx.renderDashboard();
  assert.match(app.document.getElementById('dash-sub').title, /Search \(PPT\) 24 of 90 credits today, 2 left/);
});

// ── the plan toggle in the Price API settings ─────────────────────────────────────────────────────────────────────────────────────────

test('ppt-credits: the modal has a two-option plan group beside the key field, labelled, with the help line', async () => {
  const app = await setup();
  app.ctx.openApiSettings();
  const html = app.document.body._lastInsertedHTML;
  assert.match(html, /<div id="ppt-plan-label"[^>]*>Price plan<\/div>/);
  assert.match(html, /<div class="kjr-plan" id="ppt-plan" role="radiogroup" aria-labelledby="ppt-plan-label" aria-describedby="ppt-plan-help">/);
  const radios = html.match(/<input type="radio" name="ppt-plan"[^>]*>/g);
  assert.equal(radios.length, 2);
  assert.match(radios[0], /value="free" checked onchange="kjrPptPlanChoose\('free'\)"/, 'Free is the one chosen by default');
  assert.doesNotMatch(radios[1], /checked /);
  assert.match(html, /<span class="kjr-plan-txt">Free \(100 credits a day\)<\/span>/);
  assert.match(html, /<span class="kjr-plan-txt">Paid \(20,000 credits a day\)<\/span>/);
  assert.match(html, /<div id="ppt-plan-help"[^>]*>Switch back to Free after you cancel, or the queue pauses on the first refusal\.<\/div>/);
  assert.ok(html.indexOf('id="ppt-key-input"') < html.indexOf('id="ppt-plan-label"') && html.indexOf('id="ppt-plan-label"') < html.indexOf('AI Analyst'), 'right after the key field');
  assert.match(html, /100 free credits a day/, 'the old "100 free lookups/day" is gone');
  assert.doesNotMatch(html, /lookups/);
  // with the Japanese lane forced off (this suite's default), the blurb and the Search (PPT) line name slabs only (v3.84 said the same of its lane)
  assert.match(html, /Slabs are priced from real eBay sold data via <strong style="color:var\(--text\)">PokemonPriceTracker<\/strong>, within <span class="ppt-limit">90<\/span> credits a day\. Both convert to SGD automatically, refreshed daily\./);
  assert.match(html, /<strong style="color:var\(--text\)">Search \(PPT\):<\/strong> slabs, high cost → low, capped at <span class="ppt-limit">90<\/span> credits a day on the <span class="ppt-plan-name">Free<\/span> plan \(a slab search costs up to 6 credits\)<br>/);
  assert.doesNotMatch(html, /Japanese|Chinese|Indonesian/, 'no claim that a lane runs which does not');
  assert.doesNotMatch(html, /any TCGdex miss|TCGdex misses/);
  assert.doesNotMatch(html, /\u2014|\u2015/, 'no em-dashes');
  assert.doesNotMatch(html.replace(/&[#\w]+;/g, ''), /Search \(PPT\)[^<]*;/, 'no semicolons in the copy');
});

test('ppt-credits: with the Japanese lane on the blurb and the Search (PPT) line name Japanese singles, and never Chinese or Indonesian ones', async () => {
  const app = await setup(undefined, { jaLane: true });
  app.ctx.openApiSettings();
  const html = app.document.body._lastInsertedHTML;
  assert.match(html, /Slabs are priced from real eBay sold data, and Japanese singles with a card number and a matched card from the Japanese TCGplayer market, both via <strong style="color:var\(--text\)">PokemonPriceTracker<\/strong>, within <span class="ppt-limit">90<\/span> credits a day\. All convert to SGD automatically, refreshed daily\./);
  assert.match(html, /<strong style="color:var\(--text\)">Search \(PPT\):<\/strong> slabs, plus Japanese singles with a card number and a matched card, high cost → low, capped at <span class="ppt-limit">90<\/span> credits a day on the <span class="ppt-plan-name">Free<\/span> plan \(a slab search costs up to 6 credits, a single up to 3\)<br>/);
  assert.doesNotMatch(html, /Chinese|Indonesian/);
  assert.doesNotMatch(html, new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']'), 'no em-dashes');
});

test('ppt-credits: the modal shows the stored plan as the chosen one', async () => {
  const app = await setup();
  app.ctx.kjrPptSetPlan('paid');
  app.ctx.openApiSettings();
  const radios = app.document.body._lastInsertedHTML.match(/<input type="radio" name="ppt-plan"[^>]*>/g);
  assert.doesNotMatch(radios[0], /checked /);
  assert.match(radios[1], /value="paid" checked /);
  assert.match(app.document.body._lastInsertedHTML, /capped at <span class="ppt-limit">18,000<\/span> credits a day on the <span class="ppt-plan-name">Paid<\/span> plan/);
  assert.match(app.document.body._lastInsertedHTML, /within <span class="ppt-limit">18,000<\/span> credits a day/);
});

test('ppt-credits: choosing a plan saves it on this device, says so and redraws the queue panel, a refused one changes nothing', async () => {
  const app = await setup({ slabs: manySlabs(1) });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(manySlabs(1).map(entryOf), { dayCreditsUsed: { [UTC()]: 24 } })));
  app.ctx.kjrPptPlanChoose('paid');
  assert.equal(app.ctx.kjrPptPlan(), 'paid');
  assert.deepEqual(app.toasts.slice(-1), ['Price plan: Paid, 18,000 credits a day for the queue']);
  assert.match(app.document.getElementById('queue-status-panel').innerHTML, /24 of 18,000/, 'the panel was redrawn with the new limit');
  app.ctx.kjrPptPlanChoose('free');
  assert.equal(app.ctx.kjrPptPlan(), 'free');
  assert.deepEqual(app.toasts.slice(-1), ['Price plan: Free, 90 credits a day for the queue']);
  app.ctx.kjrPptPlanChoose('platinum');
  assert.equal(app.ctx.kjrPptPlan(), 'free', 'nothing changed');
  assert.deepEqual(app.toasts.slice(-1), ['Could not save the price plan on this device']);
});

test('ppt-credits: the toggle\'s CSS is one marked block of design tokens, with a tick as well as a colour, and a stacked layout for narrow dialogs', async () => {
  const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
  assert.equal(css.split('/* v3.85 Price API plan toggle */').length, 2, 'one block, clearly marked');
  const block = css.match(/\/\* v3\.85 Price API plan toggle \*\/[\s\S]*?\.kjr-plan-txt\{min-height:44px\}\}/)[0];
  assert.match(block, /\.kjr-plan\{display:grid;grid-template-columns:repeat\(auto-fit,minmax\(160px,1fr\)\)/, 'two columns when there is room, one when there is not');
  assert.match(block, /\.kjr-plan-opt input:checked\+\.kjr-plan-txt\{[^}]*box-shadow:inset 0 0 0 1px var\(--accent\)/);
  assert.match(block, /\.kjr-plan-opt input:checked\+\.kjr-plan-txt::before\{content:"\\2713"/, 'a tick on the chosen option');
  assert.match(block, /\.kjr-plan-opt input:focus-visible\+\.kjr-plan-txt\{outline:2px solid var\(--accent\)/);
  assert.match(block, /@media\(pointer:coarse\)\{\.kjr-plan-txt\{min-height:44px\}\}/, 'a 44px touch target');
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'tokens only, no raw colour');
  assert.match(block.replace(/\/\*[\s\S]*?\*\//g, ''), /var\(--bg3\)[\s\S]*var\(--border2\)[\s\S]*var\(--radius\)/);
});
