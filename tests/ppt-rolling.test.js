'use strict';
// v3.86, the rolling PPT order. The PPT lane used to be one cycle: every slab (and Japanese single) in cost order, the cursor walking it at the
// day's credit budget, and once it reached the end the queue was "complete" and the lane stood idle until someone pressed Rebuild Queue. After the
// owner's paid month the free plan (90 credits, 15 slab searches a day) needs the lane to keep going. The first run of each UTC day (the vendor's
// credit day) now gives the lane a fresh order read off the LIVE inventory (kjrPptPriority):
//   1. cards not looked up in the last 7 days (or never), the most valuable first, a tie going to the one looked up longest ago
//   2. then the cards looked up within 7 days, the oldest look-up first (a tie going to the more valuable)
// Within a day nothing changes (the cursor, the retries, the credit budget). The free TCGdex lane is untouched, QUEUE_SCHEMA_VERSION stays 2.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, plain } = require('./harness.js');
const { setClock } = require('./clock.js');

const QUEUE_KEY = 'pokeinv_refresh_queue';
// Day n is 04:00 UTC on 24 Oct 2026 plus n days, which is noon in Singapore: the UTC date and the local date are the same date, so a card
// "checked on day n" reads the same on every clock the app keeps (price history in UTC, the priced-today marker in local time).
const DAY = (n) => new Date(Date.UTC(2026, 9, 24 + n, 4, 0, 0)).toISOString();
const ISO = (n) => DAY(n).slice(0, 10);

const slab = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', costPrice: 500, marketPrice: '', status: 'Available', priceHistory: [] }, extra || {});
const single = (id, name, extra) => Object.assign({ id, name, language: 'EN', status: 'Available', type: 'raw', qty: 1, costPrice: 5, marketPrice: '', priceHistory: [] }, extra || {});
const NUMBERED = ['Alpha 1', 'Bravo 2', 'Charlie 3', 'Delta 4', 'Echo 5', 'Foxtrot 6', 'Golf 7', 'Hotel 8', 'India 9', 'Juliet 10',
  'Kilo 11', 'Lima 12', 'Mike 13', 'Nova 14', 'Oscar 15', 'Papa 16', 'Quebec 17', 'Romeo 18', 'Sierra 19', 'Tango 20'];
const manySlabs = (n) => NUMBERED.slice(0, n).map((name, i) => slab('s' + (i + 1), name, { costPrice: 1000 - i }));

// "Name N" is card number N at PSA 10, priced 100 + N, and a search for "Nomatch ..." finds no card at all
const searchOf = (url) => decodeURIComponent(new URL(url).searchParams.get('search'));
const vendorCard = (search) => {
  const m = /^(.+) (\d+)$/.exec(search);
  return m && !/^Nomatch/.test(search) ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total } } });
const EXHAUSTED = { error: 'Daily credit limit exceeded', retryAfter: 3600, resetsAt: '2026-10-26T00:00:00.000Z' };

async function drain(fn, timers) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 800 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => [6000, 1100, 250, 2000].includes(e.delay));
  }
  return p;
}

async function setup(seed, opts) {
  const o = Object.assign({ jaLane: false, day: 0 }, opts || {});
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), jaLane: o.jaLane });
  app.clock = setClock(app, DAY(o.day));
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.refuse = false;
  app.fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  app.fetchMock.route('/ppt/cards', (url) => (app.refuse ? jsonResponse(EXHAUSTED, 429) : answer([vendorCard(searchOf(url))].filter(Boolean), 6)));
  app.fetchMock.calls.length = 0;
  app.asked = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards')).map((c) => searchOf(c.url));
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  app.slabRow = (id) => app.ctx.DB.slabs.find((r) => r.id === id);
  app.goto = (n) => { app.clock.set(DAY(n)); app.fetchMock.calls.length = 0; };
  app.run = (manual) => drain(() => app.ctx.runRefreshQueue(!!manual), app.timers);
  return app;
}
const queueWith = (items, extra) => Object.assign({
  schemaVersion: 2, items, cursor: 0, totalItems: items.length, totalRows: items.length, createdAt: '2026-10-01T00:00:00.000Z', doneToday: 0,
  dayCreditsUsed: {}, lastTcgdexPass: null, completed: false, creditsVersion: 1, freeLaneDay: 'local',
}, extra || {});
const entryOf = (row) => ({ id: row.id, table: 'slabs', lane: 'ppt', name: row.name, grader: 'PSA', grade: '10', language: null, tcgdexId: null, costPrice: row.costPrice, isPrimary: true, copyTargets: [], uniqueKey: row.name.toLowerCase() + '|EN|psa|10' });

// ── the order itself ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('rolling order: cards not looked up in 7 days come first by value, the rest after them oldest first', async () => {
  const slabs = [
    slab('A', 'A 1', { marketPrice: 500 }),                                                                              // never looked up, 500
    slab('B', 'B 2', { marketPrice: 300, _tcgdexPricedDate: ISO(-10) }),                                                 // 10 days ago, 300
    slab('C', 'C 3', { marketPrice: 300, priceHistory: [{ date: ISO(-20), price: 300, unit: 'USD', source: 'PPT (PSA 10)', confidence: 'high' }] }), // 20 days ago (history), 300
    slab('D', 'D 4', { marketPrice: 100 }),                                                                              // never, 100
    slab('E', 'E 5', { marketPrice: 9000, _tcgdexPricedDate: ISO(0) }),                                                  // today, dearest of all
    slab('F', 'F 6', { marketPrice: 50, _tcgdexPricedDate: ISO(-3) }),                                                   // 3 days ago, 50
    slab('G', 'G 7', { marketPrice: 8000, _tcgdexPricedDate: ISO(-6) }),                                                 // 6 days ago: still within 7 days
    slab('H', 'H 8', { marketPrice: 40, _tcgdexPricedDate: ISO(-7) }),                                                   // 7 days ago: due again
    slab('I', 'I 9', { marketPrice: '', costPrice: 1000, _tcgdexMissDate: ISO(-2) }),                                    // no price, the vendor had no card 2 days ago
    slab('J', 'J 10', { marketPrice: '', costPrice: 700 }),                                                              // never, no price: valued at its cost
    slab('K', 'K 11', { marketPrice: 80, _tcgdexPricedDate: ISO(-3) }),                                                  // 3 days ago like F, worth more
    slab('L', 'L 12', { marketPrice: 200, _tcgdexPricedDate: ISO(0) }),                                                  // a primary checked today ...
    slab('L2', 'L 12', { marketPrice: '', costPrice: 10 }),                                                              // ... whose copy was never priced
  ];
  const app = await setup({ slabs });
  const entries = slabs.map((r) => ({ id: r.id, table: 'slabs', lane: 'ppt', copyTargets: r.id === 'L' ? [{ id: 'L2', table: 'slabs' }] : [] })).filter((e) => e.id !== 'L2');
  const before = JSON.stringify(entries);
  const out = app.ctx.kjrPptPriority(entries, new Date(DAY(0)).getTime());
  assert.deepEqual(plain(out.map((e) => e.id)), ['J', 'A', 'C', 'B', 'L', 'D', 'H', 'G', 'K', 'F', 'I', 'E'],
    'due: J 700 (a cost is a value), A 500, C and B 300 (C was looked up longest ago), L 200 (a copy never priced makes the group due), D 100, H 40 (7 days is due). Then within 7 days, oldest first: G 6 days, K and F 3 days (K worth more), I 2 days (a miss counts), E today');
  assert.equal(JSON.stringify(entries), before, 'pure: the entries are as they were');
  assert.notEqual(out, entries, 'a new array');
  assert.deepEqual(plain(app.ctx.kjrPptPriority([], 0)), []);
  assert.deepEqual(plain(app.ctx.kjrPptPriority(undefined, 0)), []);
  assert.deepEqual(plain(app.ctx.kjrPptPriority([{ id: 'gone', table: 'slabs', copyTargets: [] }, entries[0]], new Date(DAY(0)).getTime()).map((e) => e.id)), ['A', 'gone'], 'a card that left the inventory does not throw, it is due with no value');
});

test('rolling order: the line between "due" and "within 7 days" is a week, counted in days, on the same clock the freshness dots use', async () => {
  const slabs = [6, 7, 8].map((n) => slab('d' + n, 'Day ' + n, { marketPrice: 100, _tcgdexPricedDate: ISO(-n) })).concat([slab('dueV', 'Due V', { marketPrice: 10 })]);
  const app = await setup({ slabs });
  const entries = slabs.map((r) => ({ id: r.id, table: 'slabs', lane: 'ppt', copyTargets: [] }));
  const order = (day) => plain(app.ctx.kjrPptPriority(entries, new Date(DAY(day)).getTime()).map((e) => e.id));
  // today: 7 and 8 days are due (equal in value, the older look-up first), then the cheap unpriced card, and 6 days is within the week
  assert.deepEqual(order(0), ['d8', 'd7', 'dueV', 'd6']);
  // a day on, six days has become seven and the card is due as well
  assert.deepEqual(order(1), ['d8', 'd7', 'd6', 'dueV']);
});

test('rolling order: a miss stamp counts as a look-up, a held price counts as a look-up, a price check on either clock counts', async () => {
  const slabs = [
    slab('miss', 'Miss 1', { marketPrice: '', costPrice: 900, _tcgdexMissDate: ISO(0) }),
    slab('held', 'Held 2', { marketPrice: 5, costPrice: 1, _tcgdexPricedDate: ISO(0) }),
    slab('hist', 'Hist 3', { marketPrice: 50, priceHistory: [{ date: ISO(-1), price: 50, unit: 'USD', source: 'PPT (PSA 10)', confidence: 'high' }] }),
    slab('old', 'Old 4', { marketPrice: 10, priceHistory: [{ date: ISO(-30), price: 10, unit: 'USD', source: 'PPT (PSA 10)', confidence: 'high' }] }),
    slab('junk', 'Junk 5', { marketPrice: 20, _tcgdexMissDate: 'not a date', _tcgdexPricedDate: '' }),
  ];
  const app = await setup({ slabs });
  const entries = slabs.map((r) => ({ id: r.id, table: 'slabs', lane: 'ppt', copyTargets: [] }));
  const out = plain(app.ctx.kjrPptPriority(entries, new Date(DAY(0)).getTime()).map((e) => e.id));
  assert.deepEqual(out, ['junk', 'old', 'hist', 'miss', 'held'],
    'due first, the dearer first: junk (an unreadable stamp is no look-up) 20, old (30 days) 10. Then the oldest look-up: hist (yesterday), then the two from today, the dearer first (a miss is valued at its cost)');
});

// ── a new vendor day, through runRefreshQueue ─────────────────────────────────────────────────────────────────────────────────────

test('free plan: each day asks the cards not looked up in a week first, then the oldest look-ups, 15 searches a day, rotating through all 20', async () => {
  const app = await setup({ slabs: manySlabs(20) });
  await app.run();
  assert.deepEqual(app.asked(), NUMBERED.slice(0, 15), 'day 1: nothing is checked, so the dearest first, by cost');
  assert.equal(app.saved().dayCreditsUsed[ISO(0)], 90);
  assert.equal(app.saved().pptDay, ISO(0));
  assert.deepEqual(app.saved().items.map((i) => i.id), manySlabs(20).map((r) => r.id), 'the order of the day is what was saved');
  assert.equal(app.saved().completed, false);
  const created = app.saved().createdAt;

  app.goto(1);
  await app.run();
  assert.deepEqual(app.asked(), ['Papa 16', 'Quebec 17', 'Romeo 18', 'Sierra 19', 'Tango 20', 'Oscar 15', 'Nova 14', 'Mike 13', 'Lima 12', 'Kilo 11', 'Juliet 10', 'India 9', 'Hotel 8', 'Golf 7', 'Foxtrot 6'],
    'day 2: the five nobody has looked at, then yesterday\'s, the dearer first (they all tie on age)');
  assert.equal(app.saved().dayCreditsUsed[ISO(1)], 90, 'the credits count from zero on their own day');
  assert.equal(app.saved().pptDay, ISO(1));

  app.goto(2);
  await app.run();
  assert.deepEqual(app.asked(), ['Echo 5', 'Delta 4', 'Charlie 3', 'Bravo 2', 'Alpha 1', 'Tango 20', 'Sierra 19', 'Romeo 18', 'Quebec 17', 'Papa 16', 'Oscar 15', 'Nova 14', 'Mike 13', 'Lima 12', 'Kilo 11'],
    'day 3: nothing is due, so the oldest look-ups (day 1\'s five that day 2 skipped), then day 2\'s');
  assert.equal(app.saved().createdAt, created, 'three days on one queue, never rebuilt');
  assert.equal(app.saved().schemaVersion, 2);
});

test('a finished queue does not stall the lane on a later day: it starts a new pass, with no rebuild, and the new day\'s credits are counted on their own', async () => {
  const app = await setup({ slabs: manySlabs(3) });
  app.ctx.kjrPptSetPlan('paid');
  await app.run();
  assert.equal(app.asked().length, 3);
  const done = app.saved();
  assert.equal(done.completed, true, 'the paid day finished the lane');
  assert.equal(done.cursor, 3);
  assert.equal(done.dayCreditsUsed[ISO(0)], 18);

  // later the same day nothing more is asked (the finished queue is the day's answer, as it always was)
  app.fetchMock.calls.length = 0;
  await app.run();
  assert.deepEqual(app.asked(), []);

  // the paid month is over: the free plan, the next vendor day
  app.ctx.kjrPptSetPlan('free');
  app.goto(1);
  await app.run();
  assert.deepEqual(app.asked(), ['Charlie 3', 'Bravo 2', 'Alpha 1'], 'asked again, the dearer first (all three were looked up on the same day)');
  const q = app.saved();
  assert.equal(q.createdAt, done.createdAt, 'the queue was not rebuilt or replaced');
  assert.equal(q.dayCreditsUsed[ISO(1)], 18, 'and today\'s credits are today\'s alone');
  assert.equal(q.dayCreditsUsed[ISO(0)], 18, 'yesterday\'s record is kept');
  assert.equal(q.pptDay, ISO(1));
  assert.equal(q.completed, true, 'three cards fit in 90 credits, so it finishes again');
  assert.equal(q.schemaVersion, 2, 'QUEUE_SCHEMA_VERSION is not bumped');
});

test('a finished queue from before this change (no pptDay) rolls on its next run, whatever its cursor says', async () => {
  const slabs = manySlabs(3);
  const app = await setup({ slabs });
  const old = queueWith(slabs.map(entryOf), { cursor: 3, completed: true, dayCreditsUsed: { '2026-10-20': 18 } });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(old));
  await app.run();
  assert.deepEqual(app.asked(), ['Alpha 1', 'Bravo 2', 'Charlie 3'], 'nothing is looked up, so by value');
  const q = app.saved();
  assert.equal(q.pptDay, ISO(0));
  assert.equal(q.dayCreditsUsed['2026-10-20'], 18);
  assert.equal(q.dayCreditsUsed[ISO(0)], 18);
  assert.equal(q.createdAt, '2026-10-01T00:00:00.000Z');
});

test('a queue from before this change that has already worked today keeps today as its own cycle, and rolls tomorrow', async () => {
  const slabs = manySlabs(4);
  const app = await setup({ slabs });
  const old = queueWith(slabs.map(entryOf), { cursor: 2, dayCreditsUsed: { [ISO(0)]: 12 } });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(old));
  await app.run();
  assert.deepEqual(app.asked(), ['Charlie 3', 'Delta 4'], 'it went on from its cursor');
  assert.equal(app.saved().pptDay, ISO(0), 'and is stamped with today');
  app.goto(1);
  await app.run();
  assert.equal(app.asked().length, 4, 'tomorrow it rolls: the two nobody has looked up first');
  assert.deepEqual(app.asked().slice(0, 2), ['Alpha 1', 'Bravo 2']);
  assert.equal(app.saved().pptDay, ISO(1));
});

test('inside a day nothing re-rolls: a second run, a manual run and an interrupted day all go on from the cursor', async () => {
  const app = await setup({ slabs: manySlabs(20) });
  await app.run();
  const first = app.saved();
  assert.equal(first.cursor, 15);
  const order = first.items.map((i) => i.id);
  app.clock.add(3 * 3600 * 1000); // three hours later, still the same vendor day
  app.fetchMock.calls.length = 0;
  await app.run();
  await app.run(true);
  assert.deepEqual(app.asked(), [], 'the day\'s credits are spent: no request');
  const second = app.saved();
  assert.deepEqual(second.items.map((i) => i.id), order, 'the same order');
  assert.equal(second.cursor, 15);
  assert.equal(second.pptDay, ISO(0));
  // an interrupted day: 6 credits spent and a cursor at 1, then the app is opened again
  const slabs = manySlabs(4);
  const resumed = await setup({ slabs });
  resumed.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(slabs.map(entryOf), { cursor: 1, pptDay: ISO(0), dayCreditsUsed: { [ISO(0)]: 6 } })));
  await resumed.run();
  assert.deepEqual(resumed.asked(), ['Bravo 2', 'Charlie 3', 'Delta 4'], 'resumed at the cursor, Alpha 1 is not asked again');
});

test('the plan toggle still sets the day\'s budget: a paid day takes every card, free takes 15, and a vendor refusal after a roll pauses the day', async () => {
  const app = await setup({ slabs: manySlabs(20) });
  await app.run();
  assert.equal(app.asked().length, 15);
  app.ctx.kjrPptSetPlan('paid');
  app.goto(1);
  await app.run();
  assert.equal(app.asked().length, 20, 'paid: all twenty on the next day');
  assert.deepEqual(app.asked().slice(0, 5), ['Papa 16', 'Quebec 17', 'Romeo 18', 'Sierra 19', 'Tango 20'], 'the unchecked ones first');
  assert.equal(app.saved().dayCreditsUsed[ISO(1)], 120);
  assert.equal(app.saved().completed, true);
  app.ctx.kjrPptSetPlan('free');
  app.goto(2);
  await app.run();
  assert.equal(app.asked().length, 15, 'back to free: 90 credits');
  assert.equal(app.saved().dayCreditsUsed[ISO(2)], 90);

  // the vendor says the credits are gone on the first request of a new day
  app.goto(3);
  app.refuse = true;
  await app.run();
  assert.equal(app.asked().length, 1, 'one request, refused');
  assert.equal(app.saved().creditsPausedDate, ISO(3));
  assert.equal(app.saved().cursor, 0, 'the rolled order stands, nothing advanced');
  app.refuse = false;
  app.fetchMock.calls.length = 0;
  await app.run();
  assert.deepEqual(app.asked(), [], 'no more requests that day');
  app.goto(4);
  await app.run();
  assert.equal(app.asked().length, 15, 'the next vendor day asks again');
});

test('a card the vendor has no match for is stamped, drops back for a week, and does not take the same credits every day', async () => {
  const slabs = [slab('u', 'Nomatch 9', { costPrice: 5000 })].concat(Array.from({ length: 30 }, (_, i) => slab('n' + (i + 1), 'Card' + (i + 1) + ' ' + (i + 1), { costPrice: 1000 - i })));
  const app = await setup({ slabs });
  await app.run();
  assert.equal(app.asked()[0], 'Nomatch 9', 'day 1: the dearest card is asked first');
  assert.equal(app.slabRow('u').marketPrice, '', 'no price was invented');
  assert.equal(app.slabRow('u')._tcgdexMissDate, ISO(0), 'the miss is stamped, locally');
  assert.equal(app.slabRow('u').priceHistory.length, 0);
  assert.equal(app.ctx._dirty.slabs.has('u'), false, 'and nothing syncs for it');
  assert.equal(app.saved().dayCreditsUsed[ISO(0)], 90, 'the day\'s credits were spent, the miss included');
  app.goto(1);
  await app.run();
  assert.ok(app.asked().length >= 14, 'day 2 spends its credits too');
  assert.ok(!app.asked().some((name) => /^Nomatch/.test(name)), 'day 2: cards nobody has looked at fill the day, the unmatched one waits');
  // a week after the miss it is due again, and the dearest card due. Day 6 is still inside the week.
  const rank = (day) => plain(app.ctx.kjrPptPriority(app.ctx.buildRefreshQueue().items.filter((i) => i.lane === 'ppt'), new Date(DAY(day)).getTime()).map((e) => e.id));
  const never = Array.from(app.ctx.DB.slabs).filter((r) => r.id !== 'u' && !r._tcgdexPricedDate).map((r) => r.id);
  assert.ok(never.length >= 1, 'precondition: some cards are still waiting for their first look');
  assert.deepEqual(rank(6).slice(0, never.length).sort(), never.slice().sort(), 'six days after: the cards nobody has looked at lead');
  assert.ok(rank(6).indexOf('u') >= never.length, 'and the unmatched card is behind them');
  assert.equal(rank(7)[0], 'u', 'seven days after: due again, and the dearest');
});

// ── the rest of the queue is as it was ────────────────────────────────────────────────────────────────────────────────────────────

test('the roll keeps the free lane\'s entries where they are, puts the PPT entries after them at cursor 0, and leaves the credits alone', async () => {
  const slabs = manySlabs(3);
  const app = await setup({ slabs, singles: [single('e1', 'Pikachu 25', { language: 'EN' })] });
  const free = { id: 'e1', table: 'singles', lane: 'tcgdex', name: 'Pikachu 25', language: 'EN', tcgdexId: null, copyTargets: [], _tcgdexMissDate: ISO(-1) };
  const q = queueWith([free].concat(slabs.map(entryOf)), { cursor: 2, completed: true, dayCreditsUsed: { [ISO(-1)]: 54 }, creditsPausedDate: ISO(-1), lastTcgdexPass: ISO(-1) });
  assert.equal(app.ctx._pptLaneRoll(q, ISO(0)), true);
  assert.deepEqual(plain(q.items.map((i) => i.lane + ':' + i.id)), ['tcgdex:e1', 'ppt:s1', 'ppt:s2', 'ppt:s3']);
  assert.equal(q.items[0]._tcgdexMissDate, ISO(-1), 'the free lane\'s entry is the very object it was');
  assert.equal(q.cursor, 0);
  assert.equal(q.totalItems, 4);
  assert.equal(q.completed, false);
  assert.equal(q.pptDay, ISO(0));
  assert.deepEqual(plain(q.dayCreditsUsed), { [ISO(-1)]: 54 }, 'credits untouched');
  assert.equal(q.creditsPausedDate, ISO(-1), 'and so is the refusal of an earlier day');
  assert.equal(q.lastTcgdexPass, ISO(-1));
  assert.equal(app.ctx._pptLaneRoll(q, ISO(0)), false, 'once per day');
  assert.equal(app.ctx._pptLaneRoll(q, ISO(-3)), false, 'a clock that went back does not roll');
  assert.equal(app.ctx._pptLaneRoll(null, ISO(0)), false);
  assert.equal(app.ctx._pptLaneRoll({}, ISO(0)), false);
});

test('the queue still loads under schema 2 with the new field, and the constant did not move', async () => {
  const app = await setup({ slabs: manySlabs(1) });
  assert.equal(app.ctx.QUEUE_SCHEMA_VERSION, 2);
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith([entryOf(manySlabs(1)[0])], { pptDay: ISO(0) })));
  const q = app.ctx.loadQueue();
  assert.ok(q, 'not discarded');
  assert.equal(q.pptDay, ISO(0));
});

test('the free lane runs on the rolled day as before: an English single is priced, the PPT order is made, the credits are the PPT lane\'s alone', async () => {
  const app = await setup({ slabs: manySlabs(2), singles: [single('e1', 'Alpha 1', { language: 'EN', costPrice: 100, marketPrice: '' })] });
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    if (/\/cards\?name=/.test(url)) return jsonResponse([{ id: 'set-1' }]);
    return jsonResponse({ id: 'set-1', pricing: { tcgplayer: { holofoil: { marketPrice: 30 } } } });
  });
  await app.run();
  assert.equal(app.ctx.DB.singles[0].marketPrice, '30', 'priced by TCGdex');
  assert.deepEqual(app.asked(), ['Alpha 1', 'Bravo 2']);
  assert.equal(app.saved().dayCreditsUsed[ISO(0)], 12, 'TCGdex spends no PPT credits');
  assert.equal(app.saved().lastTcgdexPass, ISO(0));
  assert.equal(app.saved().items.filter((i) => i.lane === 'tcgdex').length, 0, 'a pass still drops the lane from q.items');
  app.goto(1);
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => (/\/cards\?name=/.test(url) ? jsonResponse([{ id: 'set-1' }]) : jsonResponse({ id: 'set-1', pricing: { tcgplayer: { holofoil: { marketPrice: 33 } } } })));
  await app.run();
  assert.equal(app.ctx.DB.singles[0].marketPrice, '33', 'the next day too');
  assert.equal(app.saved().lastTcgdexPass, ISO(1));
});

test('the order is read off the live inventory: a sold card is gone, a new card is in, a custom card never was, no rebuild', async () => {
  const slabs = manySlabs(3);
  const app = await setup({ slabs });
  const q = queueWith(slabs.map(entryOf), { cursor: 3, completed: true, dayCreditsUsed: { [ISO(-1)]: 18 } });
  app.slabRow('s2').status = 'Sold';
  app.ctx.DB.slabs.push(slab('s9', 'Zeta 26', { costPrice: 2000 }));
  app.ctx.DB.singles.push(single('c1', 'Fan Card 5', { language: 'EN', customCard: true }));
  app.ctx._pptLaneRoll(q, ISO(0));
  assert.deepEqual(plain(q.items.map((i) => i.id)), ['s9', 's1', 's3'], 'the new card is the dearest and goes first, the sold one is gone');
  assert.equal(q.createdAt, '2026-10-01T00:00:00.000Z');
  assert.equal(q.totalRows, 4, 'and the row count is today\'s (every Available row, the custom card too), so a finished queue is not rebuilt for rows it has just taken in');
});

test('with the Japanese lane on, Japanese singles and slabs share one order by value; with it off a Japanese single is not in it', async () => {
  const seed = () => ({ slabs: [slab('s1', 'Charizard 4', { marketPrice: 30 })], singles: [single('j1', 'Pikachu 25', { language: 'JP', costPrice: 10, marketPrice: 40 }), single('j2', 'Eevee 9', { language: 'JP', costPrice: 10, marketPrice: 20 })] });
  const on = await setup(seed(), { jaLane: true });
  const q = queueWith([]);
  on.ctx._pptLaneRoll(q, ISO(0));
  assert.deepEqual(plain(q.items.map((i) => i.id)), ['j1', 's1', 'j2'], 'by value across both tables');
  const off = await setup(seed(), { jaLane: false });
  const q2 = queueWith([]);
  off.ctx._pptLaneRoll(q2, ISO(0));
  assert.deepEqual(plain(q2.items.map((i) => i.id)), ['s1']);
});

test('a price the guard holds is a look-up: the held card is not due again tomorrow', async () => {
  const slabs = [slab('a', 'Alpha 1', { costPrice: 1, marketPrice: '4' }), slab('b', 'Bravo 2', { costPrice: 500, marketPrice: '' })];
  const app = await setup({ slabs });
  await app.run();
  assert.equal(app.slabRow('a').priceHold.price, 101, 'precondition: the wrong-looking price is held, not written');
  assert.equal(app.slabRow('a').marketPrice, '4');
  assert.equal(app.slabRow('b').marketPrice, '102');
  assert.equal(app.ctx._kjrPptAttemptTs(app.slabRow('a')) > 0, true, 'the hold stamped it as looked up');
  app.ctx.DB.slabs.push(slab('z', 'Zulu 26', { costPrice: 1, marketPrice: '' })); // a card nobody has looked at, worth next to nothing
  const order = plain(app.ctx.kjrPptPriority(app.ctx.buildRefreshQueue().items.filter((i) => i.lane === 'ppt'), new Date(DAY(1)).getTime()).map((e) => e.id));
  assert.deepEqual(order, ['z', 'b', 'a'], 'the new card is due and leads although it is worth the least, the held card waits behind the priced one');
});

test('the queue panel no longer tells the owner to rebuild a finished PPT lane', async () => {
  const app = await setup({ slabs: manySlabs(2) });
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(queueWith(manySlabs(2).map(entryOf), { cursor: 2, completed: true, pptDay: ISO(0), dayCreditsUsed: { [ISO(0)]: 12 } })));
  app.ctx._renderQueueStatus();
  const panel = app.document.getElementById('queue-status-panel').innerHTML;
  assert.match(panel, /PPT lane done for today\. The next pass starts by itself tomorrow, cards not checked in 7 days first\./);
  assert.doesNotMatch(panel, /Rebuild queue to start next cycle/);
});
