'use strict';
// v3.85: the TCGdex free lane's day is the device's LOCAL date, the PPT lane's day stays the vendor's UTC date.
//
// The free lane dated _tcgdexPricedDate, _tcgdexMissDate and lastTcgdexPass with the UTC date. In Singapore the UTC date turns over at
// 08:00, so an auto run at 06:30 found last evening's markers equal to "today" and skipped every card. TCGdex has no daily budget and
// "priced today" is something the owner reads off their own clock, so these markers now carry the local date. PPT credits reset at 00:00 UTC
// (08:00 in Singapore), so dayCreditsUsed and the refusal pause stay on the UTC date, and so do the priceHistory dates the charts read.
//
// The suite runs as Singapore with a faked clock. 23:30 on the 21st is 15:30Z the 21st, 06:30 on the 22nd is 22:30Z the 21st (the UTC
// date has not turned yet), 08:30 on the 22nd is 00:30Z the 22nd.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, plain } = require('./harness.js');
const { setClock, localDayOf, utcDayOf } = require('./clock.js');

const QUEUE_KEY = 'pokeinv_refresh_queue';
const single = (id, name, extra) => Object.assign({ id, name, language: 'EN', status: 'Available', type: 'raw', costPrice: 5, marketPrice: '', priceHistory: [] }, extra || {});
const rowOf = (ctx, id) => ctx.DB.singles.find((r) => r.id === id);

const LANE_WAITS = [250, 2000, 6000, 1100];
async function drain(fn, timers) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 200 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => LANE_WAITS.includes(e.delay));
  }
  return p;
}

// A TCGdex whose prices a test can change. "Alpha 1" is card number 1, which resolves to set-1.
function tcgdex(fetchMock, state) {
  fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) {
      const n = decodeURIComponent(list[2]);
      if (state.down && state.down.includes(n)) return jsonResponse({}, 503);
      return jsonResponse([{ id: 'set-' + n }]);
    }
    const card = url.match(/\/cards\/(set-\d+)$/);
    if (card) return jsonResponse({ id: card[1], pricing: { tcgplayer: { holofoil: { marketPrice: state.prices[card[1]] } } } });
    return jsonResponse({}, 404);
  });
  const cards = () => fetchMock.calls.filter((c) => /\/cards\/set-\d+$/.test(c.url)).length;
  return { cards };
}

async function setup(at, singles) {
  const app = await loadApp({ seed: { singles: singles || [single('s1', 'Alpha 1'), single('s2', 'Bravo 2'), single('s3', 'Charlie 3')], slabs: [] } });
  app.clock = setClock(app, at);
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.state = { prices: { 'set-1': 10, 'set-2': 20, 'set-3': 30 } };
  app.tcg = tcgdex(app.fetchMock, app.state);
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  app.run = (manual) => drain(() => app.ctx.runRefreshQueue(!!manual), app.timers);
  app.asked = () => app.tcg.cards();
  return app;
}

const EVENING = '2026-10-21T15:30:00Z';   // 23:30 on the 21st in Singapore
const MIDNIGHT = '2026-10-21T16:01:00Z';  // 00:01 on the 22nd
const MORNING = '2026-10-21T22:30:00Z';   // 06:30 on the 22nd, the UTC date is still the 21st
const EIGHT = '2026-10-22T00:30:00Z';     // 08:30 on the 22nd, the UTC date has turned

// ── the two days ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('local-day: kjrLocalDay is the device\'s calendar date and kjrUtcDay is the vendor\'s, and they differ for the first 8 hours in Singapore', async () => {
  const app = await setup(EVENING);
  const { ctx, clock } = app;
  assert.deepEqual([ctx.kjrLocalDay(), ctx.kjrUtcDay()], ['2026-10-21', '2026-10-21'], '23:30');
  clock.set(MIDNIGHT);
  assert.deepEqual([ctx.kjrLocalDay(), ctx.kjrUtcDay()], ['2026-10-22', '2026-10-21'], '00:01 on the 22nd');
  clock.set(MORNING);
  assert.deepEqual([ctx.kjrLocalDay(), ctx.kjrUtcDay()], ['2026-10-22', '2026-10-21'], '06:30');
  clock.set('2026-10-21T23:59:59Z');
  assert.deepEqual([ctx.kjrLocalDay(), ctx.kjrUtcDay()], ['2026-10-22', '2026-10-21'], '07:59:59');
  clock.set('2026-10-22T00:00:00Z');
  assert.deepEqual([ctx.kjrLocalDay(), ctx.kjrUtcDay()], ['2026-10-22', '2026-10-22'], '08:00:00, the vendor\'s reset');
  assert.equal(ctx.kjrLocalDay(Date.UTC(2026, 11, 31, 17, 0, 0)), '2027-01-01', 'an explicit instant, across a year');
  assert.equal(ctx.kjrUtcDay(Date.UTC(2026, 11, 31, 17, 0, 0)), '2026-12-31');
  assert.equal(ctx._kjrDayBefore('2026-03-01'), '2026-02-28');
  assert.equal(ctx._kjrDayBefore('2028-03-01'), '2028-02-29');
  assert.equal(ctx._kjrDayBefore('2026-01-01'), '2025-12-31');
  assert.equal(ctx._kjrDayBefore('junk'), 'junk');
});

// ── the bug: an auto run at 06:30 took last evening's pass for today's ────────────────────────────────────────────────────────────────

test('local-day: last evening\'s pass is not today\'s at 06:30, the cards are asked again once, and not again at 08:30', async () => {
  const app = await setup(EVENING);
  await app.run();
  assert.equal(app.asked(), 3, 'the evening pass');
  assert.deepEqual(['s1', 's2', 's3'].map((id) => rowOf(app.ctx, id)._tcgdexPricedDate), ['2026-10-21', '2026-10-21', '2026-10-21'], 'stamped with the local date');
  assert.equal(app.saved().lastTcgdexPass, '2026-10-21');
  assert.equal(app.ctx._tcgdexLaneHasWork(app.saved(), app.ctx.kjrLocalDay()), false, 'nothing left for the 21st');

  app.fetchMock.calls.length = 0;
  app.clock.set(MORNING); // the UTC date is still the 21st, the owner\'s morning is the 22nd
  assert.equal(app.ctx._tcgdexLaneHasWork(app.saved(), app.ctx.kjrLocalDay()), true, 'a new day for the owner, so there is work');
  app.state.prices['set-2'] = 25;
  await app.run();
  assert.equal(app.asked(), 3, 'every card was asked again, the old UTC-dated reading skipped all of them');
  assert.equal(rowOf(app.ctx, 's2').marketPrice, '25');
  assert.deepEqual(['s1', 's2', 's3'].map((id) => rowOf(app.ctx, id)._tcgdexPricedDate), ['2026-10-22', '2026-10-22', '2026-10-22']);
  assert.equal(app.saved().lastTcgdexPass, '2026-10-22');
  assert.equal(app.saved().lastTcgdexDone, 3);

  app.fetchMock.calls.length = 0;
  app.clock.set(EIGHT); // the UTC date turns over: nothing changes for the free lane
  assert.equal(app.ctx._tcgdexLaneHasWork(app.saved(), app.ctx.kjrLocalDay()), false);
  await app.run();
  assert.equal(app.asked(), 0, 'no second pass at 08:00');
  assert.equal(app.saved().lastTcgdexDone, 3, 'and the numbers still read 3 of 3');
});

test('local-day: at 00:01 the free lane has a new day, at 23:59 it does not', async () => {
  const app = await setup('2026-10-21T15:00:00Z'); // 23:00
  await app.run();
  assert.equal(app.asked(), 3);
  app.fetchMock.calls.length = 0;
  app.clock.set('2026-10-21T15:59:00Z'); // 23:59
  await app.run();
  assert.equal(app.asked(), 0, 'still the 21st');
  app.clock.set(MIDNIGHT);
  await app.run();
  assert.equal(app.asked(), 3, 'the 22nd');
});

test('local-day: a miss stamped last evening is asked again in the morning, a miss stamped this morning is not asked twice', async () => {
  const app = await setup(EVENING, [single('s1', 'Alpha 1'), single('s9', 'Nine 9')]);
  app.fetchMock.route((url) => url.includes('api.tcgdex.net') && /localId=9/.test(url), () => jsonResponse([]));
  app.state.prices = { 'set-1': 10 };
  await app.run();
  assert.equal(rowOf(app.ctx, 's9')._tcgdexMissDate, '2026-10-21', 'a miss, dated with the local day');
  app.clock.set(MORNING);
  app.fetchMock.calls.length = 0;
  await app.run();
  const nine = app.fetchMock.calls.filter((c) => /localId=9/.test(c.url)).length;
  assert.equal(nine, 1, 'asked again on the 22nd');
  assert.equal(rowOf(app.ctx, 's9')._tcgdexMissDate, '2026-10-22');
  app.fetchMock.calls.length = 0;
  app.clock.set(EIGHT);
  await app.run();
  assert.equal(app.fetchMock.calls.filter((c) => /localId=9/.test(c.url)).length, 0, 'and not a second time that day');
});

test('local-day: cards a pass could not get an answer for before midnight are asked with everything else on the new day, once', async () => {
  const app = await setup('2026-10-21T15:50:00Z'); // 23:50
  app.state.down = ['2']; // TCGdex does not answer for Bravo, before or after the retry round
  await app.run();
  assert.deepEqual(plain(app.saved().tcgdexRetry.map((i) => i.id)), ['s2'], 'the unanswered card waits in the retry list');
  assert.equal(rowOf(app.ctx, 's2')._tcgdexMissDate, undefined, 'and is not a miss');
  app.state.down = [];
  app.clock.set(MIDNIGHT);
  app.fetchMock.calls.length = 0;
  await app.run();
  assert.equal(app.asked(), 3, 'the new day asks all three, the retry card among them, once each');
  assert.equal(app.saved().tcgdexRetry, undefined, 'the carried list is empty now');
  assert.equal(rowOf(app.ctx, 's2').marketPrice, '20');
  app.fetchMock.calls.length = 0;
  await app.run();
  assert.equal(app.asked(), 0);
});

// ── what carries which day ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('local-day: a write at 06:30 dates the history in UTC and the checked marker in local time', async () => {
  const app = await setup(MORNING, [single('s1', 'Alpha 1', { tcgdexId: 'set-1', marketPrice: '5' })]);
  app.ctx.applyPriceToGroup('s1', 'singles', [], 10, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  const row = rowOf(app.ctx, 's1');
  assert.equal(row.priceHistory[0].date, '2026-10-21', 'price history keeps UTC dates, the charts and kjrCheckedDays read them so');
  assert.equal(row._tcgdexPricedDate, '2026-10-22', 'a changed price is a check too, dated with the local day');
  // the same through the inspector button and the bulk path
  app.state.prices['set-1'] = 12;
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(row.priceHistory[1].date, '2026-10-21');
  assert.equal(row._tcgdexPricedDate, '2026-10-22');
  app.state.prices['set-1'] = 14;
  app.ctx.kjrConfirm = async () => true;
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(row.priceHistory[2].date, '2026-10-21');
  assert.equal(row._tcgdexPricedDate, '2026-10-22');
  // a same-value re-price is the no-op: no history, the marker only
  row._tcgdexPricedDate = '2026-10-01';
  app.ctx.applyPriceToGroup('s1', 'singles', [], 14, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(row.priceHistory.length, 3);
  assert.equal(row._tcgdexPricedDate, '2026-10-22');
});

test('local-day: a miss from the inspector is dated with the local day too', async () => {
  const app = await setup(MORNING, [single('s9', 'Nine 9')]);
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), () => jsonResponse([]));
  await app.ctx.refreshPrice('s9', 'singles');
  assert.equal(rowOf(app.ctx, 's9')._tcgdexMissDate, '2026-10-22');
});

test('local-day: a price already written today by this device is "priced today" from its marker, a UTC history date alone proves nothing', async () => {
  const app = await setup(MORNING, [single('s1', 'Alpha 1', { marketPrice: '10', priceHistory: [{ date: '2026-10-21', price: 10 }] })]);
  const item = { table: 'singles', id: 's1' };
  assert.equal(app.ctx._tcgdexPricedToday(item, '2026-10-22'), false, 'a history date of the 21st (UTC) is not a check on the local 22nd');
  assert.equal(app.ctx._tcgdexPricedToday(item, '2026-10-21'), false, 'nor is it read as one on the 21st: only the marker is');
  rowOf(app.ctx, 's1')._tcgdexPricedDate = '2026-10-22';
  assert.equal(app.ctx._tcgdexPricedToday(item, '2026-10-22'), true);
  assert.equal(app.ctx._tcgdexPricedToday(item, '2026-10-23'), false);
  rowOf(app.ctx, 's1').marketPrice = '';
  assert.equal(app.ctx._tcgdexPricedToday(item, '2026-10-22'), false, 'a card with no price is never done');
});

test('local-day: the PPT lane\'s credits roll over at 08:00 Singapore time, the vendor\'s midnight, not at the owner\'s', async () => {
  const slabs = [1, 2, 3].map((n) => ({ id: 'sl' + n, name: 'Card ' + n, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', costPrice: 100 - n, status: 'Available', marketPrice: '', priceHistory: [] }));
  const app = await loadApp({ seed: { singles: [], slabs } });
  const clock = setClock(app, '2026-10-21T22:30:00Z'); // 06:30 on the 22nd, the vendor is still on the 21st
  app.ctx.toast = () => {};
  app.fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  const pptAsked = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards')).length;
  app.fetchMock.route('/ppt/cards', (url) => {
    const n = decodeURIComponent(new URL(url).searchParams.get('search')).match(/\d+$/)[0];
    return jsonResponse({ data: [{ id: 'v' + n, name: 'Card', cardNumber: n + '/100', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 50 } } } } }], metadata: { apiCallsConsumed: { total: 6 } } });
  });
  const entries = slabs.map((r) => ({ id: r.id, table: 'slabs', lane: 'ppt', name: r.name, grader: 'PSA', grade: '10', language: null, tcgdexId: null, costPrice: r.costPrice, isPrimary: true, copyTargets: [], uniqueKey: r.name.toLowerCase() + '|EN|psa|10' }));
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify({ schemaVersion: 2, items: entries, cursor: 0, totalItems: 3, totalRows: 3, createdAt: '2026-10-01T00:00:00.000Z', doneToday: 0, dayCreditsUsed: { '2026-10-21': 90 }, creditsVersion: 1, freeLaneDay: 'local', lastTcgdexPass: null, completed: false }));
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(pptAsked(), 0, 'the 90 credits are the 21st\'s (the vendor\'s day) at 06:30 on the 22nd: spent');
  clock.set('2026-10-21T23:59:00Z'); // 07:59
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(pptAsked(), 0);
  clock.set('2026-10-22T00:01:00Z'); // 08:01, the vendor has reset
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(pptAsked(), 3, 'a fresh budget');
  assert.equal(JSON.parse(app.localStorage.getItem(QUEUE_KEY)).dayCreditsUsed['2026-10-22'], 18);
});

// ── markers written before this version ───────────────────────────────────────────────────────────────────────────────────────────────

test('local-day: a queue saved before v3.85 has its UTC-dated markers lowered once, so none can pass for today', async () => {
  const app = await setup(MORNING); // 06:30 on the 22nd, local day 2026-10-22
  const { ctx } = app;
  const rows = [
    single('a', 'Alpha 1', { marketPrice: '10', _tcgdexPricedDate: '2026-10-22', _tcgdexMissDate: '2026-10-22' }),
    single('b', 'Bravo 2', { marketPrice: '20', _tcgdexPricedDate: '2026-10-21' }),
    single('c', 'Charlie 3', { marketPrice: '30', _tcgdexPricedDate: '2026-10-23' }),
  ];
  ctx.DB.singles.length = 0; rows.forEach((r) => ctx.DB.singles.push(r));
  const retry = { id: 'a', table: 'singles', lane: 'tcgdex', _tcgdexMissDate: '2026-10-22' };
  const q = { schemaVersion: 2, items: [{ id: 'a', table: 'singles', lane: 'tcgdex', _tcgdexMissDate: '2026-10-22' }], tcgdexRetry: [retry], lastTcgdexPass: '2026-10-22', cursor: 0, dayCreditsUsed: {} };
  assert.equal(ctx._kjrFreeLaneDayMigrate(q, '2026-10-22'), true);
  assert.equal(rows[0]._tcgdexPricedDate, '2026-10-21', 'today\'s date or later is lowered to the day before');
  assert.equal(rows[0]._tcgdexMissDate, '2026-10-21', 'a miss stays a miss (the banner reads the truth of it), it is just not today\'s');
  assert.equal(rows[1]._tcgdexPricedDate, '2026-10-21', 'an earlier date is left alone');
  assert.equal(rows[2]._tcgdexPricedDate, '2026-10-21', 'a date after today (the zone west of UTC) is lowered too');
  assert.equal(q.lastTcgdexPass, '2026-10-21');
  assert.equal(q.items[0]._tcgdexMissDate, '2026-10-21');
  assert.equal(q.tcgdexRetry[0]._tcgdexMissDate, '2026-10-21');
  assert.equal(q.freeLaneDay, 'local');
  assert.equal(ctx._kjrFreeLaneDayMigrate(q, '2026-10-22'), false, 'once');
  assert.equal(ctx._kjrFreeLaneDayMigrate(null, '2026-10-22'), false);
  // nothing equals today now, so the first run asks every card
  assert.equal(ctx._tcgdexPricedToday({ table: 'singles', id: 'a' }, '2026-10-22'), false);
  assert.equal(ctx._tcgdexMissedToday({ table: 'singles', id: 'a', _tcgdexMissDate: q.items[0]._tcgdexMissDate }, '2026-10-22'), false);
});

test('local-day: the first run on an older queue asks every card although its markers say today, the second run asks none', async () => {
  const app = await setup(EIGHT); // 08:30 on the 22nd, both days are the 22nd
  const { ctx } = app;
  ctx.DB.singles.forEach((r) => { r.marketPrice = '1'; r._tcgdexPricedDate = '2026-10-22'; });
  const old = { schemaVersion: 2, items: [], cursor: 0, totalItems: 0, totalRows: 3, createdAt: '2026-10-01T00:00:00.000Z', dayCreditsUsed: {}, lastTcgdexPass: '2026-10-22', completed: true };
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(old));
  await app.run();
  assert.equal(app.asked(), 3, 'a marker of an older version could be a UTC date from yesterday, so it proves nothing');
  assert.equal(app.saved().freeLaneDay, 'local');
  assert.deepEqual(['s1', 's2', 's3'].map((id) => rowOf(ctx, id)._tcgdexPricedDate), ['2026-10-22', '2026-10-22', '2026-10-22'], 'restamped in local dates');
  app.fetchMock.calls.length = 0;
  await app.run();
  assert.equal(app.asked(), 0);
});

test('local-day: west of UTC a late-evening UTC marker can not skip a card the next morning', async () => {
  const saved = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const app = await setup('2026-10-22T01:30:00Z'); // 21:30 on the 21st in New York, the UTC date is the 22nd
    const { ctx } = app;
    assert.deepEqual([ctx.kjrLocalDay(), ctx.kjrUtcDay()], ['2026-10-21', '2026-10-22']);
    // the old code priced the cards now and dated them with the UTC date, a day ahead of the owner's calendar
    ctx.DB.singles.forEach((r) => { r.marketPrice = '1'; r._tcgdexPricedDate = '2026-10-22'; });
    app.localStorage.setItem(QUEUE_KEY, JSON.stringify({ schemaVersion: 2, items: [], cursor: 0, totalItems: 0, totalRows: 3, createdAt: '2026-10-01T00:00:00.000Z', dayCreditsUsed: {}, lastTcgdexPass: '2026-10-22', completed: true }));
    await app.run(); // the first run of this version: it asks everything and dates what it asks with the local date
    assert.deepEqual(['s1', 's2', 's3'].map((id) => rowOf(ctx, id)._tcgdexPricedDate), ['2026-10-21', '2026-10-21', '2026-10-21']);
    app.clock.set('2026-10-22T14:00:00Z'); // 10:00 on the 22nd in New York
    app.fetchMock.calls.length = 0;
    await app.run();
    assert.equal(app.asked(), 3, 'the next morning asks again: a UTC-dated marker equal to the new local day did not skip them');
  } finally {
    process.env.TZ = saved;
  }
});

test('local-day: a card an older version dated in UTC and never re-asked is not skipped on the next day either', async () => {
  const app = await setup(MORNING);
  const { ctx } = app;
  const q = { schemaVersion: 2, items: [], cursor: 0, lastTcgdexPass: '2026-10-21', dayCreditsUsed: {} };
  ctx.DB.singles.forEach((r) => { r.marketPrice = '1'; r._tcgdexPricedDate = '2026-10-21'; });
  ctx._kjrFreeLaneDayMigrate(q, ctx.kjrLocalDay());
  assert.equal(ctx._tcgdexLaneHasWork(q, '2026-10-23'), true);
  assert.equal(ctx._tcgdexLaneHasWork(q, '2026-10-22'), true);
});

// ── the display ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('local-day: a card checked this morning reads "today" in every reader from 06:30 through 08:30, and "yesterday" a day on', async () => {
  const app = await setup(MORNING, [single('s1', 'Alpha 1', { marketPrice: '10', priceHistory: [{ date: '2026-09-01', price: 10, source: 'TCGdex (TCGplayer)', confidence: 'high' }], _tcgdexPricedDate: '2026-10-22' })]);
  const { ctx, clock } = app;
  const row = rowOf(ctx, 's1');
  const ts = ctx.kjrPriceCheckedTs(row);
  assert.equal(ts, new Date('2026-10-22T00:00:00').getTime(), 'the local midnight of the marker');
  const readers = () => [
    ctx.kjrOverviewCheckedText(ts, clock.now),
    (ctx.kjrInspectPriceLine('singles', row, clock.now).match(/checked (.*)$/) || [])[1],
    (ctx._mktFreshDot(row).match(/\((today|1 day ago|\d+ days ago)\)/) || [])[1],
    (ctx._statMktFreshDot([row]).match(/Oldest refresh: (today|1 day ago|\d+ days ago)/) || [])[1],
  ];
  const norm = (a) => a.map((x) => (x === '1 day ago' ? 'yesterday' : x));
  for (const at of [MORNING, '2026-10-21T23:59:00Z', '2026-10-22T00:00:00Z', EIGHT, '2026-10-22T15:30:00Z']) {
    clock.set(at);
    assert.deepEqual(norm(readers()), ['today', 'today', 'today', 'today'], at);
    assert.equal(ctx.kjrCheckedDays(ts, clock.now), 0, at);
  }
  clock.set('2026-10-23T00:30:00Z'); // 08:30 on the 23rd
  assert.deepEqual(norm(readers()), ['yesterday', 'yesterday', 'yesterday', 'yesterday'], 'every reader says the same, a day on');
  assert.equal(ctx.kjrCheckedDays(ts, clock.now), 1);
  clock.set('2026-10-21T15:30:00Z'); // 23:30 on the 21st, the owner\'s evening before: a marker dated the 22nd is ahead of the clock
  assert.equal(ctx.kjrCheckedDays(ts, clock.now), 0, 'never "-1 days ago"');
});

test('local-day: the Overview and the freshness line go on reading the UTC price history exactly as before', async () => {
  const app = await setup(MORNING, [single('s1', 'Alpha 1', { marketPrice: '10', priceHistory: [{ date: '2026-10-21', price: 10, source: 'TCGdex (TCGplayer)', confidence: 'high' }] })]);
  const { ctx, clock } = app;
  const ts = ctx.kjrPriceCheckedTs(rowOf(ctx, 's1'));
  assert.equal(ctx.kjrCheckedDays(ts, clock.now), 0, '06:30 on the 22nd, history of the 21st (UTC): today');
  clock.set(EIGHT);
  assert.equal(ctx.kjrCheckedDays(ts, clock.now), 1, 'and one day once the UTC date turns, as v3.84 read it');
});

// ── the Settings tile and the toast ───────────────────────────────────────────────────────────────────────────────────────────────

const staleTile = (extra) => Object.assign({
  schemaVersion: 2, items: [], cursor: 0, totalItems: 0, totalRows: 2, createdAt: '2026-10-01T00:00:00.000Z', dayCreditsUsed: {}, creditsVersion: 1, freeLaneDay: 'local',
  lastTcgdexPass: '2026-10-21', lastTcgdexTotal: 12, lastTcgdexDone: 12, completed: true,
}, extra || {});

test('local-day: a run with no free-lane card clears yesterday\'s numbers, and the tile says nothing to check, never "12/12 today"', async () => {
  // the inventory holds only cards the free lane never asks about: a Korean single and a slab
  const slab = { id: 'sl1', name: 'Charizard 4', grader: 'PSA', grade: '10', type: 'slab', costPrice: 1, status: 'Available', marketPrice: 50, priceHistory: [] };
  const app = await setup(MORNING, [single('k1', 'Pikachu 25', { language: 'KR' })]);
  app.ctx.DB.slabs.push(slab);
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(staleTile({ items: [{ id: 'sl1', table: 'slabs', lane: 'ppt', name: 'Charizard 4', grader: 'PSA', grade: '10', copyTargets: [] }], cursor: 1, totalItems: 1 })));
  assert.match((app.ctx._renderQueueStatus(), app.document.getElementById('queue-status-panel').innerHTML), /12\/12 \(last run\)/, 'precondition: yesterday\'s numbers, honestly labelled');
  await app.run(true);
  const q = app.saved();
  assert.equal(q.lastTcgdexPass, '2026-10-22', 'the pass ran today');
  assert.equal(q.lastTcgdexTotal, 0);
  assert.equal(q.lastTcgdexDone, 0, 'and its numbers are today\'s, not the last busy day\'s');
  app.ctx._renderQueueStatus();
  const panel = app.document.getElementById('queue-status-panel').innerHTML;
  assert.match(panel, />Exact \(TCGdex\)<\/div>\s*<div style="font-weight:600">Nothing to check today<\/div>/);
  assert.doesNotMatch(panel, /12\/12/);
  assert.doesNotMatch(panel, /Exact \(TCGdex\)<\/div>\s*<div style="font-weight:600">0\/0/, 'and not the bare "0/0" either');
  app.ctx.renderDashboard();
  assert.match(app.document.getElementById('dash-sub').title, /Exact \(TCGdex\): nothing to check today/);
});

test('local-day: the same run on a day it did have cards still reads N/N today, and a paused pass leaves its numbers alone', async () => {
  const app = await setup(MORNING);
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(staleTile({ totalRows: 3 })));
  await app.run(true);
  assert.equal(app.saved().lastTcgdexTotal, 3);
  assert.equal(app.saved().lastTcgdexDone, 3);
  app.ctx._renderQueueStatus();
  assert.match(app.document.getElementById('queue-status-panel').innerHTML, /<div style="font-weight:600">3\/3 today<\/div>/);
  // five unanswered requests in a row stop a pass: it is not stamped as done, and the tile keeps reading "last run", never "today"
  const down = await setup(MORNING, [1, 2, 3, 4, 5, 6].map((n) => single('d' + n, 'Dn ' + n)));
  down.state.down = ['1', '2', '3', '4', '5', '6'];
  down.localStorage.setItem(QUEUE_KEY, JSON.stringify(staleTile({ totalRows: 6 })));
  await down.run(true);
  assert.equal(down.saved().lastTcgdexPass, '2026-10-21', 'not stamped as done today');
  assert.equal(down.saved().lastTcgdexDone, 0);
  assert.equal(down.saved().lastTcgdexTotal, 6, 'the numbers are this run\'s, as they always were');
  down.ctx._renderQueueStatus();
  assert.match(down.document.getElementById('queue-status-panel').innerHTML, /<div style="font-weight:600">0\/6 \(last run\)<\/div>/);
});

test('local-day: the dashboard note reads 0 of 0 as "nothing to check today" and keeps N/N for a busy day', async () => {
  const app = await setup(MORNING, [single('k1', 'Pikachu 25', { language: 'KR' })]);
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(staleTile({ lastTcgdexPass: '2026-10-22', lastTcgdexTotal: 0, lastTcgdexDone: 0 })));
  app.ctx.renderDashboard();
  assert.match(app.document.getElementById('dash-sub').title, /Exact \(TCGdex\): nothing to check today/);
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(staleTile({ lastTcgdexPass: '2026-10-22', lastTcgdexTotal: 7, lastTcgdexDone: 5 })));
  app.ctx.renderDashboard();
  assert.match(app.document.getElementById('dash-sub').title, /Exact \(TCGdex\): 5\/7 today/);
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(staleTile({ lastTcgdexPass: '2026-10-21', lastTcgdexTotal: 7, lastTcgdexDone: 5 })));
  app.ctx.renderDashboard();
  assert.match(app.document.getElementById('dash-sub').title, /Exact \(TCGdex\): 5\/7 last run/, 'yesterday\'s pass is labelled yesterday\'s');
});

test('local-day: the "All cards refreshed!" toast puts a separator between the free lane\'s count and the rebuild hint', async () => {
  const app = await setup(EVENING);
  await app.run(); // the first pass builds the queue and prices the cards, the PPT lane has nothing, so the queue is complete
  app.toasts.length = 0;
  await app.run(true);
  const done = app.toasts.find((t) => /^All cards refreshed!/.test(t));
  assert.ok(done, JSON.stringify(app.toasts));
  assert.equal(done, 'All cards refreshed! · Exact (TCGdex): 3/3 priced · Rebuild the queue to start a new Search (PPT) cycle.');
  assert.doesNotMatch(done, /priced Reset|Reset queue/);

  // no free-lane card at all: no note to run on from
  const bare = await setup(EVENING, [single('k1', 'Pikachu 25', { language: 'KR' })]);
  await bare.run();
  bare.toasts.length = 0;
  await bare.run(true);
  assert.ok(bare.toasts.includes('All cards refreshed! · Rebuild the queue to start a new Search (PPT) cycle.'), JSON.stringify(bare.toasts));
});
