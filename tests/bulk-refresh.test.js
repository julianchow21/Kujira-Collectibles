'use strict';
// v3.89, the manual bulk refresh (bulkRefreshPrices, a console tool: nothing in the page calls it). It prices what the queue prices, by the
// queue's rules, out of the queue's budget:
//   - each row goes to the lane the queue gives it (_kjrBulkKind): an English single to TCGdex ALONE, a slab to the PPT eBay lane, a Japanese
//     single to the set-checked Japanese lane, everything else is skipped and never priced, so the old name-only PPT search is never reached
//   - the PPT lane spends the saved queue's credits for today's vendor day (kjrDailyCredits, Free 90), stops when they are used up or when the
//     vendor refuses for credits (the same creditsPausedDate the queue sets) and at the first 429 or 403, and none of those stops stamps a miss
//   - a PPT request waits the plan's gap (kjrRequestGapMs, 6 seconds Free and 1.1 Paid), a TCGdex request the free lane's 250ms
//   - every price still goes through the price guard
// Fetch is stubbed (tests/harness.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, plain } = require('./harness.js');

const QUEUE_KEY = 'pokeinv_refresh_queue';
const UTC = () => new Date().toISOString().slice(0, 10);
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total: total === undefined ? 3 : total } } });
const EXHAUSTED = { error: 'Daily credit limit exceeded', retryAfter: 3600, resetsAt: '2026-10-22T00:00:00.000Z' };

// Japanese singles "Monaa 1", "Monab 2" ... with the TCGdex ids SV8a-001, SV8a-002 ..., each of which the vendor knows as one card at US$3
const wordOf = (i) => 'Mon' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26));
const jpRow = (i, extra) => Object.assign({ id: 'm' + (i + 1), name: wordOf(i) + ' ' + (i + 1), language: 'JP', type: 'raw', status: 'Available', tcgdexId: 'SV8a-' + String(i + 1).padStart(3, '0'), costPrice: 100 - i, marketPrice: '', priceHistory: [] }, extra);
const jps = (n, extra) => Array.from({ length: n }, (_, i) => jpRow(i, extra));
const jpCards = (search) => {
  const m = /^Mon([a-z])([a-z]) SV8a$/.exec(search || '');
  if (!m) return [];
  const n = (m[1].charCodeAt(0) - 97) * 26 + (m[2].charCodeAt(0) - 97) + 1;
  return [{ id: 'c' + n, name: 'Mon' + m[1] + m[2], setName: 'SV8a: Test Set', cardNumber: String(n).padStart(3, '0') + '/100', prices: { market: 3 } }];
};
// English singles and slabs: "Alpha 1" is card number 1, which TCGdex resolves to set-1, and at PSA 10 the vendor prices it 100 plus its number
const enRow = (id, name, extra) => Object.assign({ id, name, language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabRow = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabCard = (search) => {
  const m = /^(.+) (\d+)$/.exec(search || '');
  return m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};
// the vendor's reply to a request, by the flags it carries. A plain search (no eBay data, no language flag) is the old name-only raw search, which
// no test here expects: it answers with nothing and the tests assert it was never asked.
const pptReply = (url) => {
  const u = new URL(url);
  const search = u.searchParams.get('search');
  if (u.searchParams.get('language') === 'japanese') return answer(jpCards(search));
  if (u.searchParams.get('includeEbay') === 'true') return answer([slabCard(search)].filter(Boolean), 6);
  return answer([], 3);
};
// the TCGdex answers the free lane reads: card number N resolves to set-N, whose TCGplayer market is prices['set-N'] (a card with none is a 404)
function tcgdex(fetchMock, prices) {
  fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) return jsonResponse([{ id: 'set-' + decodeURIComponent(list[2]) }]);
    const card = url.match(/\/cards\/(set-\d+)$/);
    if (card) return prices[card[1]] ? jsonResponse({ id: card[1], pricing: { tcgplayer: { holofoil: { marketPrice: prices[card[1]] } } } }) : jsonResponse({}, 404);
    return jsonResponse({}, 404);
  });
}

async function setup(seed, opts) {
  const o = Object.assign({ jaLane: true }, opts || {});
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), jaLane: o.jaLane });
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.confirms = [];
  app.ctx.kjrConfirm = async (m) => { app.confirms.push(String(m)); return true; };
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  app.fetchMock.route('/ppt/cards', pptReply);
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.tcg = () => app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net'));
  app.row = (id, table) => app.ctx.DB[table || 'singles'].find((r) => r.id === id);
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  // a saved queue with this much of today's credits already spent (by the queue, or an earlier bulk run)
  app.saveQueue = (patch) => {
    const q = plain(app.ctx.buildRefreshQueue());
    Object.assign(q, patch || {});
    app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    return q;
  };
  return app;
}

// the run waits between requests through the sandbox's setTimeout, which the harness never fires by itself
async function drain(fn, timers, keep) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 800 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => [6000, 1100, 250, 2000].includes(e.delay));
  }
  if (!done) throw new Error('the run did not finish');
  return p;
}
// let the run go as far as it can, firing only the timers of these delays (none: just let it settle)
async function pump(app, delays, rounds) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setImmediate(r));
    app.timers.flush((e) => delays.includes(e.delay));
  }
}

// run a started call to its end, firing every wait it makes, and fail (not hang) when it does not end
async function finish(app, p) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 400 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    app.timers.flush((e) => [6000, 1100, 250, 2000].includes(e.delay));
  }
  if (!done) throw new Error('the run did not finish');
  return p;
}

// wait for a call that must return at once, without firing any wait (a bulk run sitting on its gap must stay there). When it does not return
// the caller's assertions fail, where an unbounded await would hang the whole file
async function soon(p) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 60 && !done; i++) await new Promise((r) => setImmediate(r));
  return done;
}

// ── which lane each row goes to ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk refresh: each row goes to the lane the queue gives it and every other row is manual, never asked', async () => {
  const app = await setup();
  const kind = (item, table) => app.ctx._kjrBulkKind(item, table || 'singles');
  const rows = [
    [enRow('a', 'Alpha 1'), 'free'], [enRow('b', 'Alpha', { tcgdexId: 'sv3-199' }), 'free', 'an id stands in for the number'],
    [enRow('c', 'Alpha 1', { language: '' }), 'free', 'a blank language is English'], [enRow('d', 'Alpha'), 'manual', 'no number, no id'],
    [jpRow(0), 'japanese'], [jpRow(0, { tcgdexId: '' }), 'manual', 'a Japanese card with no matched card yet waits for the card art lookup'], [jpRow(0, { tcgdexId: 'SV8a001' }), 'manual', 'an id with no set code is no match'],
    [jpRow(0, { name: 'Monaa' }), 'manual', 'a Japanese card with no number'],
    [enRow('e', 'Alpha 1', { language: 'CN' }), 'manual'], [enRow('f', 'Alpha 1', { language: 'ID' }), 'manual'], [enRow('g', 'Alpha 1', { language: 'KR' }), 'manual'],
    [enRow('h', 'Alpha 1', { customCard: true }), 'manual'], [jpRow(0, { customCard: true }), 'manual'],
  ];
  for (const [item, want, why] of rows) assert.equal(kind(item), want, item.name + ' ' + item.language + (why ? ', ' + why : ''));
  const slabs = [
    [slabRow('s1', 'Alpha 1'), 'slab'], [slabRow('s2', 'Alpha 1', { grader: '', grade: 'PSA 10' }), 'slab', 'PSA 10 in the grade field alone'],
    [slabRow('s3', 'Alpha 1', { grade: '' }), 'slab', 'a grader with no grade is asked, and is a miss with no request'],
    [slabRow('s4', 'Alpha 1', { grader: '', grade: '' }), 'free', 'no grader: the free lane would take it'], [slabRow('s5', 'Alpha', { grader: '', grade: '' }), 'manual'],
    [slabRow('s6', 'Monaa 1', { grader: '', grade: '', language: 'JP' }), 'manual', 'a Japanese row with no grader is no slab and no single'],
    [slabRow('s7', 'Alpha 1', { grader: '', grade: '', language: 'CN' }), 'manual'],
  ];
  for (const [item, want, why] of slabs) assert.equal(kind(item, 'slabs'), want, item.id + (why ? ', ' + why : ''));
  // with the Japanese switch off, the kill switch, a Japanese single is manual again
  const off = await setup({}, { jaLane: false });
  assert.equal(off.ctx._kjrBulkKind(jpRow(0), 'singles'), 'manual');
  assert.equal(off.ctx._kjrBulkKind(enRow('a', 'Alpha 1'), 'singles'), 'free');
});

// ── the old name-only PPT search is never reached ────────────────────────────────────────────────────────────────────────────────────────

test('bulk refresh: no path reaches the name-only PPT search: English cards go to TCGdex alone, the rest is a slab, the Japanese lane or skipped', async () => {
  const singles = [
    enRow('en1', 'Alpha 1'), enRow('en2', 'Bravo 2'), // TCGdex knows the first, not the second
    enRow('en3', 'Echo'),                              // no number
    enRow('cn1', 'Alpha 1', { language: 'CN' }), enRow('id1', 'Delta 4', { language: 'ID' }), enRow('kr1', 'Foxtrot 6', { language: 'KR' }),
    enRow('cu1', 'Golf 7', { customCard: true }), jpRow(5, { id: 'jpn', name: 'Hotel' }), // custom, and a Japanese card with no number
    jpRow(0),
  ];
  const slabs = [
    slabRow('sl1', 'Alpha 1', { costPrice: 10 }), // S$101 is 10 times the cost, the guard has no doubt
    slabRow('sl2', 'Monab 2', { grader: '', grade: '', language: 'JP', tcgdexId: 'SV8a-002' }), // a Japanese row in Slabs with no grader
    slabRow('sl3', 'Charlie', { grader: '', grade: '' }),
  ];
  const app = await setup({ singles, slabs });
  tcgdex(app.fetchMock, { 'set-1': 7 });
  // the spy: the function behind the old raw search, which only the router's raw lane without tcgdexOnly calls
  const real = app.ctx.fetchPriceFromPPT;
  const spy = [];
  app.ctx.fetchPriceFromPPT = (...args) => { spy.push(args); return real(...args); };
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  await drain(() => app.ctx.bulkRefreshPrices('slabs'), app.timers);
  // every PPT request carries the eBay flag (a slab) or the Japanese catalogue flag: a plain search is the old fuzzy one
  const urls = app.ppt().map((c) => new URL(c.url));
  assert.equal(urls.length, 2, 'one for the Japanese single, one for the slab: ' + urls.map((u) => u.search).join(' | '));
  assert.ok(urls.every((u) => u.searchParams.get('includeEbay') === 'true' || u.searchParams.get('language') === 'japanese'));
  assert.deepEqual(plain(urls.map((u) => u.searchParams.get('search')).sort()), ['Alpha 1', 'Monaa SV8a']);
  assert.deepEqual(spy.map((a) => [a[0], a[1], a[2]]), [['Alpha 1', 'PSA', '10']], 'the old function ran once, for the slab, never as a raw card');
  // TCGdex was asked about the two English cards with a number only
  const names = app.tcg().filter((c) => c.url.includes('/cards?name=')).map((c) => new URL(c.url).searchParams.get('name')).sort();
  assert.deepEqual(plain(names), ['Alpha', 'Bravo'], 'not for the Chinese, Indonesian or Korean cards, the custom card, or either with no number');
  assert.equal(app.row('en1').marketPrice, '7');
  assert.equal(app.row('en2').marketPrice, '', 'a TCGdex miss is a miss: no PPT search stands in for it');
  assert.equal(app.row('m1').marketPrice, '3');
  assert.equal(app.row('sl1', 'slabs').marketPrice, '101');
  // the skipped rows are exactly as they were: no price, no stamp, nothing marked
  for (const id of ['en3', 'cn1', 'id1', 'kr1', 'cu1', 'jpn']) {
    assert.equal(app.row(id).marketPrice, '', id);
    assert.equal(app.row(id)._tcgdexMissDate, undefined, id + ' was never asked');
    assert.equal(app.ctx._dirty.singles.has(id), false, id);
  }
  for (const id of ['sl2', 'sl3']) {
    assert.equal(app.row(id, 'slabs').marketPrice, '', id);
    assert.equal(app.row(id, 'slabs')._tcgdexMissDate, undefined, id);
    assert.equal(app.ctx._dirty.slabs.has(id), false, id);
  }
  assert.ok(app.toasts.some((t) => /^Done: 2 updated, 6 skipped \(no automatic price\), 1 failed/.test(t)), JSON.stringify(app.toasts));
  assert.ok(app.toasts.some((t) => /^Done: 1 updated, 2 skipped \(no automatic price\)$/.test(t)), JSON.stringify(app.toasts));
  // the spy is not blind: the router's raw lane without tcgdexOnly, the way the bulk run used to call it, does reach the old function
  spy.length = 0;
  await app.ctx.fetchMarketPrice({ name: 'Bravo 2', grader: null, grade: null, language: 'EN' });
  assert.equal(spy.length, 1, 'the old path is still there for the price check, it is only not reachable from the bulk run');
  assert.deepEqual(spy[0].slice(0, 2), ['Bravo 2', null]);
});

test('bulk refresh: Sealed tables, and a table with nothing to price automatically, ask nothing and say so', async () => {
  const app = await setup({ singles: [enRow('cn1', 'Alpha 1', { language: 'CN' }), enRow('kr1', 'Alpha 1', { language: 'KR' }), enRow('cu1', 'Alpha 1', { customCard: true })] });
  await app.ctx.bulkRefreshPrices('etbs');
  assert.ok(app.toasts.includes('Only Singles and Slabs have an automatic price, the rest are priced by hand'), JSON.stringify(app.toasts));
  await app.ctx.bulkRefreshPrices('singles');
  assert.ok(app.toasts.includes('Nothing to price automatically: 3 cards have no automatic source, price them by hand'), JSON.stringify(app.toasts));
  await app.ctx.bulkRefreshPrices('slabs');
  assert.ok(app.toasts.includes('No available items to refresh'));
  assert.equal(app.confirms.length, 0, 'no question for a run with nothing to do');
  assert.equal(app.fetchMock.calls.length, 0);
});

// ── the credit budget is the queue's own ─────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk refresh: it spends the queue\'s credits for today: 60 already spent leaves ten searches, it bills them into dayCreditsUsed, and the queue then has none', async () => {
  const app = await setup({ singles: jps(20) });
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 60 } });
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.ppt().length, 10, 'thirty credits left buys ten searches at 3');
  assert.equal(app.saved().dayCreditsUsed[UTC()], 90, 'billed on the queue\'s own day, in credits');
  assert.equal(app.saved().creditsVersion, 1);
  assert.equal(app.row('m10').marketPrice, '3');
  assert.equal(app.row('m11').marketPrice, '', 'the eleventh was not asked');
  // it stopped at the budget with a plain message, and marked nothing as unmatched
  assert.ok(app.toasts.some((t) => /^Done: 10 updated.* · ⏸ PPT credits are used up for today \(90 of 90 on the Free plan\), they reset at 8am Singapore time \(10 not priced\)$/.test(t)), JSON.stringify(app.toasts));
  for (const r of app.ctx.DB.singles) assert.equal(r._tcgdexMissDate, undefined, r.id);
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles()), []);
  // the day is spent for the queue as well: neither an automatic nor a manual run asks the vendor
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  assert.equal(app.ppt().length, 0, 'a bulk run and the queue can not spend the one day twice');
  assert.equal(app.saved().dayCreditsUsed[UTC()], 90);
});

test('bulk refresh: the other way round, what the queue spent is not spent again, and a run that finds the day spent still prices the free cards', async () => {
  const app = await setup({ singles: jps(40).concat([enRow('e1', 'Alpha 1')]) });
  tcgdex(app.fetchMock, { 'set-1': 9 });
  await drain(() => app.ctx.runRefreshQueue(false), app.timers); // the queue spends the free plan's 90: thirty searches
  assert.equal(app.ppt().length, 30);
  assert.equal(app.saved().dayCreditsUsed[UTC()], 90);
  app.ctx.DB.singles.find((r) => r.id === 'e1').marketPrice = ''; // so the free card has something to price again
  app.fetchMock.calls.length = 0;
  app.toasts.length = 0;
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.ppt().length, 0, 'not one more PPT request');
  assert.equal(app.row('e1').marketPrice, '9', 'the free card is still priced');
  assert.equal(app.saved().dayCreditsUsed[UTC()], 90, 'and nothing was billed');
  assert.ok(app.toasts.some((t) => /^Done: 1 updated.* · ⏸ PPT credits are used up for today \(90 of 90 on the Free plan\), they reset at 8am Singapore time \(40 not priced\)$/.test(t)), JSON.stringify(app.toasts));
  assert.equal(app.row('m31').marketPrice, '', 'the cards past the queue\'s thirty are left for tomorrow');
});

test('bulk refresh: a search the credits left can not pay for is not made: a slab is 6, so 5 left buys none, and the answers bill the vendor\'s own total', async () => {
  const slabs = [slabRow('sl1', 'Alpha 1', { costPrice: 10 }), slabRow('sl2', 'Bravo 2', { costPrice: 10 }), slabRow('sl3', 'Charlie 3', { costPrice: 10 })];
  const app = await setup({ slabs });
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 79 } }); // 11 left
  app.fetchMock.route('/ppt/cards', (url) => answer([slabCard(new URL(url).searchParams.get('search'))], 4)); // the vendor bills 4 for each
  await drain(() => app.ctx.bulkRefreshPrices('slabs'), app.timers);
  assert.equal(app.ppt().length, 2, '11 left: a slab needs 6, so one at 4 (7 left) and a second at 4 (3 left), and a third is out of reach');
  assert.equal(app.saved().dayCreditsUsed[UTC()], 87, '79 and the two answers at 4 each');
  assert.equal(app.row('sl3', 'slabs').marketPrice, '');
  assert.ok(app.toasts.some((t) => /^Done: 2 updated.* · ⏸ PPT credits are used up for today \(87 of 90 on the Free plan\).* \(1 not priced\)$/.test(t)), JSON.stringify(app.toasts));
});

test('bulk refresh: the Paid plan\'s budget is 18,000, so the same forty cards that stop at 30 on Free are all asked', async () => {
  const app = await setup({ singles: jps(40) });
  assert.equal(app.ctx.kjrPptSetPlan('paid'), true);
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.ppt().length, 40);
  assert.equal(app.saved().dayCreditsUsed[UTC()], 120);
  assert.ok(app.toasts.some((t) => /^Done: 40 updated$/.test(t)), JSON.stringify(app.toasts));
  assert.ok(app.confirms[0].includes('(18,000 of 18,000 left on the Paid plan)'), app.confirms[0]);
});

test('bulk refresh: with the vendor\'s refusal already on record for today it asks for nothing from the PPT lane, and the free cards are still priced', async () => {
  const app = await setup({ singles: jps(3).concat([enRow('e1', 'Alpha 1')]) });
  tcgdex(app.fetchMock, { 'set-1': 9 });
  app.saveQueue({ creditsPausedDate: UTC() });
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.ppt().length, 0);
  assert.equal(app.row('e1').marketPrice, '9');
  assert.ok(app.toasts.some((t) => /^Done: 1 updated · ⏸ PPT credits are used up for today, they reset at 8am Singapore time \(3 not priced\)$/.test(t)), JSON.stringify(app.toasts));
  assert.ok(app.confirms[0].includes('(0 of 90 left on the Free plan)'), app.confirms[0]);
  assert.equal(app.saved().creditsPausedDate, UTC(), 'and the record is as it was');
});

test('bulk refresh: a queue saved before credits were counted is read as credits, the 29 requests it holds are 87, and it is saved in credits', async () => {
  const app = await setup({ singles: jps(5) });
  const old = app.saveQueue({ dayCreditsUsed: { [UTC()]: 29 } });
  delete old.creditsVersion;
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(old));
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.ppt().length, 1, '90 less 87 leaves one search');
  assert.equal(app.saved().creditsVersion, 1);
  assert.equal(app.saved().dayCreditsUsed[UTC()], 90);
});

test('bulk refresh: with no queue saved the first PPT answer builds one to hold the credits, and a declined run builds nothing', async () => {
  const declined = await setup({ singles: jps(2) });
  declined.ctx.kjrConfirm = async (m) => { declined.confirms.push(String(m)); return false; };
  await declined.ctx.bulkRefreshPrices('singles');
  assert.equal(declined.ppt().length, 0);
  assert.equal(declined.localStorage.getItem(QUEUE_KEY), null, 'saying no changes nothing');
  assert.ok(declined.confirms[0].includes('2 use PokemonPriceTracker credits from today\'s budget (90 of 90 left on the Free plan)'), declined.confirms[0]);
  const app = await setup({ singles: jps(2) });
  assert.equal(app.localStorage.getItem(QUEUE_KEY), null);
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  const q = app.saved();
  assert.equal(q.dayCreditsUsed[UTC()], 6);
  assert.equal(q.creditsVersion, 1);
  assert.equal(q.schemaVersion, 2);
  assert.equal(app.row('m2').marketPrice, '3');
});

test('bulk refresh: the question names what is asked, the free cards, the credits left in the plan, and what is skipped', async () => {
  const app = await setup({ singles: [enRow('e1', 'Alpha 1'), enRow('e2', 'Bravo 2'), jpRow(0), enRow('cn1', 'Alpha 1', { language: 'CN' })] });
  tcgdex(app.fetchMock, { 'set-1': 9, 'set-2': 8 });
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 30 } });
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.confirms[0], 'Refresh 3 singles now? 2 priced free from TCGdex. 1 use PokemonPriceTracker credits from today\'s budget (60 of 90 left on the Free plan), and the run stops when they are used up. 1 with no automatic price is skipped.');
});

// ── the vendor refuses for credits, or with a 429 or 403 ─────────────────────────────────────────────────────────────────────────────────

test('bulk refresh: "Daily credit limit exceeded" stops the PPT lane, sets the queue\'s own pause, marks no card, and the queue then asks nothing', async () => {
  for (const status of [429, 403, 402, 200]) {
    const app = await setup({ singles: jps(5).concat([enRow('e1', 'Alpha 1')]) });
    tcgdex(app.fetchMock, { 'set-1': 9 });
    let n = 0;
    app.fetchMock.route('/ppt/cards', (url) => (++n === 3 ? jsonResponse(EXHAUSTED, status) : pptReply(url)));
    await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
    assert.equal(app.ppt().length, 3, 'two answered, the third refused, no more: ' + status);
    const q = app.saved();
    assert.equal(q.creditsPausedDate, UTC(), 'the same pause the queue sets: ' + status);
    assert.equal(q.dayCreditsUsed[UTC()], 6, 'only the answered searches were billed');
    assert.equal(app.row('e1').marketPrice, '9', 'the free card ahead of them was priced');
    assert.equal(app.row('m1').marketPrice, '3');
    assert.equal(app.row('m2').marketPrice, '3');
    for (const id of ['m3', 'm4', 'm5']) {
      assert.equal(app.row(id).marketPrice, '', id + ': nothing written');
      assert.equal(app.row(id).priceHistory.length, 0);
      assert.equal(app.row(id)._tcgdexMissDate, undefined, id + ': the refused card and the rest are not marked unmatched');
      assert.equal(app.ctx._dirty.singles.has(id), false, id);
    }
    assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles()), []);
    assert.ok(app.toasts.some((t) => /^Done: 3 updated · ⏸ PPT credits are used up for today, they reset at 8am Singapore time \(3 not priced\)$/.test(t)), JSON.stringify(app.toasts));
    // shared with the queue: it is told, and asks nothing for the rest of the day
    app.fetchMock.route('/ppt/cards', pptReply);
    app.fetchMock.calls.length = 0;
    await drain(() => app.ctx.runRefreshQueue(false), app.timers);
    assert.equal(app.ppt().length, 0, 'the queue makes no request after the refusal: ' + status);
  }
});

test('bulk refresh: the first 429 or 403 stops the run, nothing is billed for it and no card is marked unmatched', async () => {
  for (const status of [429, 403]) {
    const app = await setup({ singles: jps(4).concat([enRow('e1', 'Alpha 1')]) });
    tcgdex(app.fetchMock, { 'set-1': 9 });
    let n = 0;
    app.fetchMock.route('/ppt/cards', (url) => (++n === 2 ? jsonResponse({ error: 'Too Many Requests' }, status) : pptReply(url)));
    await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
    assert.equal(app.ppt().length, 2, 'one answered, the second refused, and not a request after it: ' + status);
    const q = app.saved();
    assert.equal(q.dayCreditsUsed[UTC()], 3, 'only the answered search was billed');
    assert.equal(q.creditsPausedDate, undefined, 'a bare refusal is not the credit pause, tomorrow asks again');
    assert.equal(app.row('e1').marketPrice, '9');
    assert.equal(app.row('m1').marketPrice, '3');
    for (const id of ['m2', 'm3', 'm4']) {
      assert.equal(app.row(id).marketPrice, '', id);
      assert.equal(app.row(id)._tcgdexMissDate, undefined, id + ': a refusal is no verdict on the card');
      assert.equal(app.ctx._dirty.singles.has(id), false, id + ': and changes nothing worth syncing');
    }
    assert.ok(app.toasts.some((t) => new RegExp('^Done: 2 updated, 1 failed \\(1× HTTP ' + status + '\\) .*· ⏸ stopped at the first refusal \\(HTTP ' + status + '\\), nothing was marked as unmatched \\(3 not priced\\)$').test(t)), JSON.stringify(app.toasts));
  }
  // a 429 from TCGdex stops the run too, before any PPT request
  const app = await setup({ singles: [enRow('e1', 'Alpha 1'), enRow('e2', 'Bravo 2'), jpRow(0)] });
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), () => jsonResponse({}, 429));
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.tcg().length, 1, 'one TCGdex request, refused');
  assert.equal(app.ppt().length, 0);
  assert.equal(app.row('e1')._tcgdexMissDate, undefined);
  assert.ok(app.toasts.some((t) => /⏸ stopped at the first refusal/.test(t)), JSON.stringify(app.toasts));
});

// ── pacing ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk refresh: a PPT request waits the plan\'s gap, 6 seconds on Free and 1.1 on Paid, not a fixed 1.1', async () => {
  const free = await setup({ singles: jps(3) });
  const run = free.ctx.bulkRefreshPrices('singles');
  await pump(free, [1100, 250, 2000], 40); // the wrong gaps release nothing
  assert.equal(free.ppt().length, 1, 'the first search is made at once, the second waits');
  await pump(free, [6000], 1);
  await pump(free, [], 10);
  assert.equal(free.ppt().length, 2, 'six seconds release exactly one');
  await pump(free, [1100, 250], 40);
  assert.equal(free.ppt().length, 2, 'and the third waits six seconds too');
  await pump(free, [6000], 1);
  await pump(free, [], 10);
  assert.equal(free.ppt().length, 3);
  await finish(free, run);
  assert.equal(free.timers.list().filter((t) => t.delay === 6000).length, 0, 'no wait is left behind after the last card');
  const paid = await setup({ singles: jps(3) });
  paid.ctx.kjrPptSetPlan('paid');
  const runPaid = paid.ctx.bulkRefreshPrices('singles');
  await pump(paid, [6000, 250], 40);
  assert.equal(paid.ppt().length, 1, 'six seconds and 0.25 do not release a Paid run');
  await pump(paid, [1100], 1);
  await pump(paid, [], 10);
  assert.equal(paid.ppt().length, 2, 'one and a tenth seconds do');
  await pump(paid, [1100], 1);
  await pump(paid, [], 10);
  await finish(paid, runPaid);
  assert.equal(paid.ppt().length, 3);
});

test('bulk refresh: a TCGdex request waits the free lane\'s 250ms and nothing more, and the free cards go before the PPT ones', async () => {
  const app = await setup({ singles: [jpRow(0), enRow('e1', 'Alpha 1'), enRow('e2', 'Bravo 2'), enRow('e3', 'Charlie 3')] });
  tcgdex(app.fetchMock, { 'set-1': 9, 'set-2': 8, 'set-3': 7 });
  const run = app.ctx.bulkRefreshPrices('singles');
  const asked = () => app.tcg().filter((c) => /\/cards\/set-\d$/.test(c.url)).length;
  await pump(app, [1100, 6000, 2000], 40); // only the wrong gaps
  assert.equal(asked(), 1, 'the first card is asked at once, the second waits for the 250ms');
  await pump(app, [250], 1);
  await pump(app, [], 20);
  assert.equal(asked(), 2);
  await pump(app, [250], 1);
  await pump(app, [], 20);
  assert.equal(asked(), 3);
  assert.equal(app.ppt().length, 0, 'the Japanese card, a PPT one, comes after every free card');
  await pump(app, [250], 1);   // the free lane's gap before the first PPT request
  await pump(app, [], 20);
  assert.equal(app.ppt().length, 1);
  await finish(app, run);
  assert.equal(app.row('m1').marketPrice, '3');
  const order = app.fetchMock.calls.map((c) => (c.url.includes('/ppt/cards') ? 'ppt' : c.url.includes('api.tcgdex.net') ? 'tcgdex' : 'other')).filter((k) => k !== 'other');
  assert.ok(order.lastIndexOf('tcgdex') < order.indexOf('ppt'), order.join(' '));
});

// ── the price guard ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk refresh: a spike is held for the owner on the PPT lane, a slab and a Japanese single, counted apart from the updates, and still billed', async () => {
  // a slab: the vendor says S$101 for a card that cost S$1, which is 101 times the cost
  const slabs = [slabRow('sl1', 'Alpha 1', { costPrice: 1, marketPrice: '4' })];
  const app = await setup({ slabs });
  await drain(() => app.ctx.bulkRefreshPrices('slabs'), app.timers);
  const slab = app.row('sl1', 'slabs');
  assert.equal(slab.marketPrice, '4', 'the price on the card is untouched');
  assert.equal(slab.priceHistory.length, 0);
  assert.equal(slab.priceHold.price, 101);
  assert.equal(slab.priceHold.reason, '101× cost');
  assert.equal(slab.priceHold.prev, 4);
  assert.equal(app.ctx._dirty.slabs.has('sl1'), true, 'a hold is a synced field');
  assert.equal(app.saved().dayCreditsUsed[UTC()], 6, 'the held answer was billed like any other');
  assert.ok(app.toasts.some((t) => /^Done: 0 updated, 1 held for your OK \(Overview, Needs attention\)$/.test(t)), JSON.stringify(app.toasts));
  assert.deepEqual(plain(app.ctx.kjrPriceHolds().map((h) => h.item.id)), ['sl1']);
  // a Japanese single: US$25 for a card that cost S$1
  const jp = await setup({ singles: [jpRow(0, { costPrice: 1, marketPrice: '' })] });
  jp.fetchMock.route('/ppt/cards', () => answer([Object.assign(jpCards('Monaa SV8a')[0], { prices: { market: 25 } })]));
  await drain(() => jp.ctx.bulkRefreshPrices('singles'), jp.timers);
  const single = jp.row('m1');
  assert.equal(single.marketPrice, '');
  assert.equal(single.priceHistory.length, 0);
  assert.deepEqual(plain(single.priceHold), { price: 25, unit: 'USD', source: 'PPT (Japanese)', confidence: 'medium', date: UTC(), prev: null, reason: '25× cost' });
  assert.ok(!single._tcgdexMissDate, 'a held price is an answer, not a miss');
  assert.ok(jp.toasts.some((t) => /^Done: 0 updated, 1 held for your OK/.test(t)), JSON.stringify(jp.toasts));
});

// ── it never runs at the same time as the queue ──────────────────────────────────────────────────────────────────────────────────────────

test('bulk refresh: it and the queue never run at once, each refuses while the other is running', async () => {
  const app = await setup({ singles: jps(2) });
  const run = app.ctx.bulkRefreshPrices('singles');
  await pump(app, [], 20);
  assert.equal(app.ppt().length, 1, 'the first search is made and the run sits on its gap');
  app.toasts.length = 0;
  assert.equal(await soon(app.ctx.runRefreshQueue(true)), true, 'a manual run returns at once');
  assert.equal(await soon(app.ctx.runRefreshQueue(false)), true, 'and so does an automatic one');
  assert.equal(app.ppt().length, 1, 'the queue asked nothing');
  assert.deepEqual(app.toasts, ['A bulk refresh is running - wait for it to finish first'], 'a manual run says why, an automatic one is silent');
  assert.equal(await soon(app.ctx.bulkRefreshPrices('singles')), true, 'a second bulk run returns at once');
  assert.ok(app.toasts.includes('Refresh already running...'));
  await pump(app, [6000], 1);
  await pump(app, [], 20);
  await finish(app, run);
  assert.equal(app.ppt().length, 2);
  // the other way round
  app.ctx._queueRunning = true;
  app.toasts.length = 0;
  assert.equal(await soon(app.ctx.bulkRefreshPrices('singles')), true, 'and so does a bulk run while the queue runs');
  assert.deepEqual(app.toasts, ['A refresh pass is already running - wait for it to finish first']);
  assert.equal(app.ppt().length, 2);
  assert.equal(app.confirms.length, 1, 'and it did not even ask');
  app.ctx._queueRunning = false;
});

test('bulk refresh: a failure inside the run does not leave it marked as running', async () => {
  const app = await setup({ singles: jps(2) });
  const real = app.ctx.fetchMarketPrice;
  app.ctx.fetchMarketPrice = async () => { throw new Error('boom'); };
  await assert.rejects(() => drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers), /boom/);
  app.ctx.fetchMarketPrice = real;
  assert.equal(app.ctx._bulkRefreshRunning, false);
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.row('m1').marketPrice, '3', 'the next run goes through');
});
