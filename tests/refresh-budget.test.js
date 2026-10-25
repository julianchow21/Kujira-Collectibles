'use strict';
// v3.91, the card inspector's Refresh price (refreshPrice) spends PPT credits out of the same day's budget as the queue, bulkRefreshPrices and the
// hand lookups of v3.90. Until now it asked the vendor for a slab or a Japanese single whatever the day's count said, outside q.dayCreditsUsed
// and past q.creditsPausedDate. Now, for a slab or a Japanese single (the PPT lane):
//   - it is asked only when kjrCreditsLeft can pay for this search (a slab's costs up to 6, a Japanese single's up to 3), the vendor has not
//     refused for credits today and no refresh pass is running. Otherwise it is not asked at all: nothing is written, no miss is stamped, no id
//     is kept, and the toast says why in plain words
//   - what the answer cost (the vendor's count, else the estimate) is billed into q.dayCreditsUsed[utcDay], and the vendor's own refusal sets
//     the same pause the queue reads
//   - the price still goes through the price guard
// An English single is the free lane, TCGdex only: it is priced whatever the budget says and spends and bills nothing. While a refresh is in
// flight the queue and a bulk run do not start (_kjrLookupsOpen), because the bill is written into the same saved queue.
// Fetch is stubbed (tests/harness.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, plain, ROOT } = require('./harness.js');

const QUEUE_KEY = 'pokeinv_refresh_queue';
const UTC = () => new Date().toISOString().slice(0, 10);
const YESTERDAY = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total } } });
const EXHAUSTED = { error: 'Daily credit limit exceeded', retryAfter: 3600, resetsAt: '2026-10-26T00:00:00.000Z' };

// The three kinds of card a Refresh price can meet. "Alpha 1" is card number 1: TCGdex knows it as set-1 (US$12 for the English single), the vendor
// prices its PSA 10 slab at US$101 (the slab costs 500, so the price guard has nothing to say) and "Monaa 1" (Japanese, matched to SV8a-001) at US$3.
const enRow = (extra) => Object.assign({ id: 'e1', name: 'Alpha 1', language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabRow = (extra) => Object.assign({ id: 's1', name: 'Alpha 1', grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 500, marketPrice: '', priceHistory: [] }, extra);
const jpRow = (extra) => Object.assign({ id: 'j1', name: 'Monaa 1', language: 'JP', type: 'raw', status: 'Available', tcgdexId: 'SV8a-001', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabCard = (price) => ({ id: 'v-1', name: 'Alpha', cardNumber: '1/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price } } } } });
const jpCard = { id: 'c1', name: 'Monaa', setName: 'SV8a: Test Set', cardNumber: '001/100', prices: { market: 3 } };
// the vendor's reply by the flags the request carries: a Japanese search, a slab search (eBay data), or the old plain name search, which nothing here may ask
const pptReply = (totals) => (url) => {
  const u = new URL(url);
  if (u.searchParams.get('language') === 'japanese') return answer([jpCard], totals.jp);
  if (u.searchParams.get('includeEbay') === 'true') return answer([slabCard(101)], totals.slab);
  return answer([], 3);
};
// TCGdex: card number 1 resolves to set-1, whose TCGplayer market is 12. A gate holds every answer back until it opens, for a refresh left in flight.
function tcgdex(fetchMock, gate) {
  fetchMock.route((url) => url.includes('api.tcgdex.net'), async (url) => {
    if (gate) await gate;
    if (/\/cards\?name=([^&]+)&localId=1$/.test(url)) return jsonResponse([{ id: 'set-1' }]);
    if (/\/cards\/set-1$/.test(url)) return jsonResponse({ id: 'set-1', pricing: { tcgplayer: { holofoil: { marketPrice: 12 } } } });
    return jsonResponse({}, 404);
  });
}

async function setup(seed, opts) {
  const o = Object.assign({ totals: { slab: 6, jp: 3 }, ppt: null, gate: null }, opts || {});
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), jaLane: true });
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  tcgdex(app.fetchMock, o.gate);
  app.fetchMock.route('/ppt/cards', o.ppt || pptReply(o.totals));
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.tcg = () => app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net'));
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  app.rawQueue = () => app.localStorage.getItem(QUEUE_KEY);
  app.used = () => (app.saved() && app.saved().dayCreditsUsed ? app.saved().dayCreditsUsed[UTC()] : undefined);
  app.row = (table, id) => app.ctx.DB[table].find((r) => r.id === id);
  // a saved queue with this much of today's credits already spent (by the queue, a bulk run, a lookup or an earlier refresh)
  app.saveQueue = (patch) => {
    const q = plain(app.ctx.buildRefreshQueue());
    Object.assign(q, patch || {});
    app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    return q;
  };
  // everything a price or a stamp could be written to, as one string: the rows and the saved copy of them
  app.snapshot = () => JSON.stringify([app.ctx.DB.singles, app.ctx.DB.slabs]) + '|' + app.localStorage.getItem('pokeinventory_v3');
  return app;
}
// a pass waits between requests through the sandbox's setTimeout, which the harness never fires by itself
async function drain(fn, timers) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 800 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => [6000, 1100, 250, 2000].includes(e.delay));
  }
  if (!done) throw new Error('the pass did not finish');
  return p;
}
async function until(fn, rounds) {
  for (let i = 0; i < (rounds || 80); i++) { if (fn()) return true; await new Promise((r) => setImmediate(r)); }
  return fn();
}
const RESET = 'They reset at 8am Singapore time (midnight UTC).';
const refused = (reason, next) => 'PokemonPriceTracker was not asked because ' + reason + '. ' + (next || RESET) + ' Nothing was changed.';

// ── an English single is the free lane ────────────────────────────────────────────────────────────────────────────────────────────────

test('refresh budget: an English single is priced from TCGdex whatever the PPT budget says, and bills nothing', async () => {
  const states = {
    'the day is spent': (a) => a.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } }),
    'the vendor refused today': (a) => a.saveQueue({ creditsPausedDate: UTC() }),
    'a refresh pass is running': (a) => { a.ctx._queueRunning = true; },
    'a bulk run is running': (a) => { a.ctx._bulkRefreshRunning = true; },
  };
  for (const [name, put] of Object.entries(states)) {
    const app = await setup({ singles: [enRow()] });
    put(app);
    const queue = app.rawQueue();
    await app.ctx.refreshPrice('e1', 'singles');
    assert.equal(app.ppt().length, 0, name + ': the free lane never asks the vendor');
    assert.ok(app.tcg().length > 0, name + ': TCGdex was asked');
    assert.equal(app.row('singles', 'e1').marketPrice, '12', name + ': and its price was written');
    assert.equal(app.row('singles', 'e1').priceHistory.length, 1);
    assert.deepEqual(app.toasts.filter((t) => !/^Fetching/.test(t)).map((t) => t.replace(/ \(.*$/, '')), ['Updated S$12'], name);
    assert.equal(app.rawQueue(), queue, name + ': no credit was spent, so the saved queue is as it was');
    assert.equal(app.ctx._kjrLookupsOpen, 0);
  }
});

// ── the budget can not pay: a slab or a Japanese single is not asked ──────────────────────────────────────────────────────────────

test('refresh budget: a slab the day can not pay for is not asked, nothing is written or stamped, and the toast says why in plain words', async () => {
  const app = await setup({ slabs: [slabRow()] });
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 85 } }); // 5 left, a slab's search can cost up to 6
  const before = app.snapshot(), queue = app.rawQueue();
  await app.ctx.refreshPrice('s1', 'slabs');
  assert.equal(app.ppt().length, 0, 'the vendor was not asked');
  assert.equal(app.tcg().length, 0, 'and a slab has no TCGdex price to fall back to');
  assert.equal(app.snapshot(), before, 'the card is exactly as it was: no price, no history, no id, no stamp');
  assert.ok(!('_tcgdexMissDate' in app.row('slabs', 's1')) && !('tcgdexId' in app.row('slabs', 's1')) && !('priceHold' in app.row('slabs', 's1')));
  assert.deepEqual(app.toasts, ['ERR ' + refused('only 5 credits are left today (85 of 90 used on the Free plan) and this search can cost up to 6')], 'one toast, no "Fetching" first');
  assert.equal(app.rawQueue(), queue, 'and the saved queue is untouched, a refusal bills nothing');
  assert.equal(app.ctx._kjrLookupsOpen, 0);
  // with nothing left it reads "used up", and one credit left reads "1 credit is left"
  const spent = await setup({ slabs: [slabRow()] });
  spent.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } });
  await spent.ctx.refreshPrice('s1', 'slabs');
  assert.deepEqual(spent.toasts, ['ERR ' + refused('today\'s credits are used up (90 of 90 on the Free plan)')]);
  const one = await setup({ slabs: [slabRow()] });
  one.saveQueue({ dayCreditsUsed: { [UTC()]: 89 } });
  await one.ctx.refreshPrice('s1', 'slabs');
  assert.deepEqual(one.toasts, ['ERR ' + refused('only 1 credit is left today (89 of 90 used on the Free plan) and this search can cost up to 6')]);
  assert.equal(one.ppt().length + spent.ppt().length, 0);
});

test('refresh budget: a Japanese single the day can not pay for is not asked, no miss is stamped and no id is touched', async () => {
  const app = await setup({ singles: [jpRow()] });
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 88 } }); // 2 left, a search costs up to 3
  const before = app.snapshot(), queue = app.rawQueue();
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.ppt().length, 0, 'the vendor was not asked');
  assert.equal(app.tcg().length, 0, 'and a Japanese single is never priced from TCGdex');
  assert.equal(app.snapshot(), before, 'unchanged');
  assert.ok(!('_tcgdexMissDate' in app.row('singles', 'j1')), 'a card nobody asked about is not "could not be matched"');
  assert.equal(app.row('singles', 'j1').tcgdexId, 'SV8a-001');
  assert.deepEqual(app.toasts, ['ERR ' + refused('today\'s credits are used up (88 of 90 on the Free plan)')]);
  assert.equal(app.rawQueue(), queue);
  assert.equal(app.ctx._kjrLookupsOpen, 0);
  // a miss stamp it already carried is not touched either, and the banner count does not move
  const stamped = await setup({ singles: [jpRow({ _tcgdexMissDate: '2026-10-20' })] });
  stamped.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } });
  await stamped.ctx.refreshPrice('j1', 'singles');
  assert.equal(stamped.row('singles', 'j1')._tcgdexMissDate, '2026-10-20');
});

test('refresh budget: the cost of the search is what is checked, a slab needs 6 and a Japanese single 3, and a Paid day is held to its own 18,000', async () => {
  // 5 left: the Japanese single goes through, the slab does not
  const both = await setup({ slabs: [slabRow()], singles: [jpRow()] });
  both.saveQueue({ dayCreditsUsed: { [UTC()]: 85 } });
  await both.ctx.refreshPrice('s1', 'slabs');
  assert.equal(both.ppt().length, 0, 'the slab is refused at 5 left');
  await both.ctx.refreshPrice('j1', 'singles');
  assert.equal(both.ppt().length, 1, 'the Japanese single is asked at 5 left');
  assert.equal(both.used(), 88, 'and billed its 3');
  assert.equal(both.row('singles', 'j1').marketPrice, '3');
  // exactly 3 left is enough for a Japanese single and 6 exactly for a slab
  const edge = await setup({ singles: [jpRow()] });
  edge.saveQueue({ dayCreditsUsed: { [UTC()]: 87 } });
  await edge.ctx.refreshPrice('j1', 'singles');
  assert.equal(edge.used(), 90);
  assert.equal(edge.row('singles', 'j1').marketPrice, '3');
  const six = await setup({ slabs: [slabRow()] });
  six.saveQueue({ dayCreditsUsed: { [UTC()]: 84 } });
  await six.ctx.refreshPrice('s1', 'slabs');
  assert.equal(six.ppt().length, 1);
  assert.equal(six.used(), 90, 'the whole of what was left');
  assert.equal(six.row('slabs', 's1').marketPrice, '101');
  assert.ok(six.toasts.some((t) => /^Updated S\$101 \(PPT \(PSA 10\)\)$/.test(t)), JSON.stringify(six.toasts));
  // and nothing is left for the next one
  const next = await setup({ slabs: [slabRow({ id: 's2', name: 'Alpha 1' })] });
  next.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } });
  await next.ctx.refreshPrice('s2', 'slabs');
  assert.equal(next.ppt().length, 0);
  // the Paid plan has its own budget and says so
  const paid = await setup({ slabs: [slabRow()] });
  paid.ctx.kjrPptSetPlan('paid');
  paid.saveQueue({ dayCreditsUsed: { [UTC()]: 17995 } });
  await paid.ctx.refreshPrice('s1', 'slabs');
  assert.equal(paid.ppt().length, 0);
  assert.deepEqual(paid.toasts, ['ERR ' + refused('only 5 credits are left today (17,995 of 18,000 used on the Paid plan) and this search can cost up to 6')]);
  const plenty = await setup({ slabs: [slabRow()] });
  plenty.ctx.kjrPptSetPlan('paid');
  plenty.saveQueue({ dayCreditsUsed: { [UTC()]: 5000 } });
  await plenty.ctx.refreshPrice('s1', 'slabs');
  assert.equal(plenty.used(), 5006);
});

// ── the vendor said no today ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('refresh budget: a day the vendor already refused stops a slab and a Japanese single before they ask, and another day\'s pause does not', async () => {
  for (const [table, id, row] of [['slabs', 's1', slabRow()], ['singles', 'j1', jpRow()]]) {
    const app = await setup(table === 'slabs' ? { slabs: [row] } : { singles: [row] });
    app.saveQueue({ creditsPausedDate: UTC(), dayCreditsUsed: { [UTC()]: 3 } });
    const before = app.snapshot(), queue = app.rawQueue();
    await app.ctx.refreshPrice(id, table);
    assert.equal(app.ppt().length, 0, table);
    assert.equal(app.snapshot(), before, table + ': nothing written, no miss stamp');
    assert.deepEqual(app.toasts, ['ERR ' + refused('it refused any more credits earlier today')], table);
    assert.equal(app.rawQueue(), queue, table);
    // yesterday's pause is the vendor's old day
    const fresh = await setup(table === 'slabs' ? { slabs: [row] } : { singles: [row] });
    fresh.saveQueue({ creditsPausedDate: YESTERDAY(), dayCreditsUsed: { [YESTERDAY()]: 90 } });
    await fresh.ctx.refreshPrice(id, table);
    assert.equal(fresh.ppt().length, 1, table + ': asked');
    assert.equal(fresh.used(), table === 'slabs' ? 6 : 3, table + ': counted from zero on its own day');
  }
});

test('refresh budget: the vendor refusing for credits during a refresh pauses the day, marks nothing, and the next refresh does not ask', async () => {
  for (const [table, id, row] of [['slabs', 's1', slabRow()], ['singles', 'j1', jpRow()]]) {
    const app = await setup(table === 'slabs' ? { slabs: [row] } : { singles: [row] }, { ppt: () => jsonResponse(EXHAUSTED, 429) });
    const before = app.snapshot();
    await app.ctx.refreshPrice(id, table);
    assert.equal(app.ppt().length, 1, table);
    assert.deepEqual(app.toasts, ['Fetching market price...', 'ERR PokemonPriceTracker credits are used up for today. They reset at 8am Singapore time, nothing was changed.'], table);
    assert.equal(app.snapshot(), before, table + ': a refusal is no price and no miss');
    assert.equal(app.saved().creditsPausedDate, UTC(), table + ': the pause the queue and a bulk run read');
    assert.equal(app.used() || 0, 0, table + ': a refusal costs nothing');
    assert.equal(app.ctx.kjrCreditsLeft(app.saved(), UTC()), 0);
    // the next refresh, of either kind, does not ask at all
    app.toasts.length = 0;
    await app.ctx.refreshPrice(id, table);
    assert.equal(app.ppt().length, 1, table + ': still the one request');
    assert.deepEqual(app.toasts, ['ERR ' + refused('it refused any more credits earlier today')], table);
  }
  // a refusal after the first of a slab's two searches bills that first search and pauses the day
  let n = 0;
  const two = await setup({ slabs: [slabRow()] }, { ppt: () => (++n === 1 ? answer([], 6) : jsonResponse(EXHAUSTED, 429)) });
  await two.ctx.refreshPrice('s1', 'slabs');
  assert.equal(two.ppt().length, 2);
  assert.equal(two.used(), 6, 'the first search was an answer');
  assert.equal(two.saved().creditsPausedDate, UTC());
  assert.equal(two.row('slabs', 's1').marketPrice, '');
  // and a plan change gives the vendor a fresh start, as it does for the queue
  two.ctx.kjrPptSetPlan('paid');
  assert.equal(two.saved().creditsPausedDate, null);
});

// ── a pass is running ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('refresh budget: while the queue or a bulk run is running a slab or a Japanese single is not asked, the toast is a wait and not an error, and it asks again after', async () => {
  for (const flag of ['_queueRunning', '_bulkRefreshRunning']) {
    for (const [table, id, row] of [['slabs', 's1', slabRow()], ['singles', 'j1', jpRow()]]) {
      const app = await setup(table === 'slabs' ? { slabs: [row] } : { singles: [row] });
      app.ctx[flag] = true;
      const before = app.snapshot();
      await app.ctx.refreshPrice(id, table);
      const label = flag + ' ' + table;
      assert.equal(app.ppt().length, 0, label);
      assert.deepEqual(app.toasts, [refused('a price refresh is running and spends the same daily credits', 'Try again when it has finished.')], label + ': a plain toast');
      assert.doesNotMatch(app.toasts[0], /8am Singapore/, 'nothing to wait for until tomorrow');
      assert.equal(app.snapshot(), before, label);
      assert.equal(app.saved(), null, label + ': nothing written under a pass that holds the queue in memory');
      app.ctx[flag] = false;
      app.toasts.length = 0;
      await app.ctx.refreshPrice(id, table);
      assert.equal(app.ppt().length, 1, label + ': asked once the pass is over');
    }
  }
});

// ── billing ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('refresh budget: what the answer cost is billed, the vendor\'s own count first and the estimate when it gives none', async () => {
  const counted = await setup({ slabs: [slabRow()], singles: [jpRow()] }, { totals: { slab: 4, jp: 2 } });
  await counted.ctx.refreshPrice('s1', 'slabs');
  assert.equal(counted.used(), 4, 'a slab search the vendor says cost 4');
  await counted.ctx.refreshPrice('j1', 'singles');
  assert.equal(counted.used(), 6, 'and a Japanese one that cost 2, on the same day');
  assert.equal(counted.saved().creditsVersion, 1);
  assert.equal(counted.ctx.kjrCreditsLeft(counted.saved(), UTC()), 84, 'the queue and a bulk run see it');
  // no metadata at all: 6 for a search with eBay data, 3 for a plain one
  const bare = await setup({ slabs: [slabRow()], singles: [jpRow()] }, {
    ppt: (url) => jsonResponse({ data: [new URL(url).searchParams.get('language') === 'japanese' ? jpCard : slabCard(101)] }),
  });
  await bare.ctx.refreshPrice('s1', 'slabs');
  assert.equal(bare.used(), 6);
  await bare.ctx.refreshPrice('j1', 'singles');
  assert.equal(bare.used(), 9);
});

test('refresh budget: every search a refresh makes is billed, the slab\'s second one too, and a miss and a held price cost what they cost', async () => {
  // the full name finds nothing, the base name does: two searches, two bills, and the price is marked low confidence as ever
  const twice = await setup({ slabs: [slabRow()] }, { ppt: (url) => (new URL(url).searchParams.get('search') === 'Alpha' ? answer([slabCard(101)], 6) : answer([], 6)) });
  await twice.ctx.refreshPrice('s1', 'slabs');
  assert.equal(twice.ppt().length, 2);
  assert.equal(twice.used(), 12);
  assert.equal(twice.row('slabs', 's1').marketPrice, '101');
  assert.equal(twice.row('slabs', 's1').priceHistory[0].confidence, 'low');
  // a slab no search finds is a miss, and both searches were still answers
  const miss = await setup({ slabs: [slabRow()] }, { ppt: () => answer([], 6) });
  await miss.ctx.refreshPrice('s1', 'slabs');
  assert.equal(miss.used(), 12);
  assert.ok(miss.toasts.some((t) => /^ERR No price found/.test(t)), JSON.stringify(miss.toasts));
  assert.equal(miss.row('slabs', 's1').priceHistory.length, 0);
  // a Japanese card the vendor does not have: billed, and stamped as unmatched the way the queue stamps it (an answer is a verdict on the card)
  const jpMiss = await setup({ singles: [jpRow()] }, { ppt: () => answer([], 3) });
  await jpMiss.ctx.refreshPrice('j1', 'singles');
  assert.equal(jpMiss.used(), 3);
  assert.equal(jpMiss.row('singles', 'j1')._tcgdexMissDate, new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0') + '-' + String(new Date().getDate()).padStart(2, '0'));
  // an HTTP error is no answer and costs nothing: no queue made for it, no stamp on the Japanese card
  const down = await setup({ slabs: [slabRow()], singles: [jpRow()] }, { ppt: () => jsonResponse({}, 503) });
  await down.ctx.refreshPrice('s1', 'slabs');
  await down.ctx.refreshPrice('j1', 'singles');
  assert.equal(down.saved(), null, 'nothing was spent, so nothing was billed');
  assert.ok(!('_tcgdexMissDate' in down.row('singles', 'j1')), 'a card the vendor never answered about is not marked missed');
  // the price guard still decides: a slab 101 over 20x its cost is held, not written, and the search that found it is billed
  const held = await setup({ slabs: [slabRow({ costPrice: 3 })] });
  await held.ctx.refreshPrice('s1', 'slabs');
  assert.equal(held.used(), 6);
  assert.equal(held.row('slabs', 's1').marketPrice, '', 'the price on the card is unchanged');
  assert.ok(held.row('slabs', 's1').priceHold, 'it waits for the owner\'s OK');
  assert.ok(held.toasts.some((t) => /^⚠ Held for your OK: S\$101/.test(t)), JSON.stringify(held.toasts));
});

test('refresh budget: a refresh bills the day it asked on, and two refreshes in flight together both bill', async () => {
  const gates = [];
  const app = await setup({ slabs: [slabRow(), slabRow({ id: 's2', name: 'Alpha 1' })] }, { ppt: () => new Promise((r) => gates.push(() => r(answer([slabCard(101)], 6)))) });
  const a = app.ctx.refreshPrice('s1', 'slabs');
  const b = app.ctx.refreshPrice('s2', 'slabs');
  assert.ok(await until(() => gates.length === 2), 'both are waiting on the vendor');
  assert.equal(app.ctx._kjrLookupsOpen, 2);
  gates[0](); await a;
  assert.equal(app.ctx._kjrLookupsOpen, 1);
  assert.equal(app.used(), 6);
  gates[1](); await b;
  assert.equal(app.ctx._kjrLookupsOpen, 0);
  assert.equal(app.used(), 12, 'each read the saved queue fresh when its own answer came, so the second added to the first');
});

// ── the pass guard ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('refresh budget: a pass does not start while a slab refresh is waiting for the vendor, and the refresh\'s bill is there once it is answered', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = await setup({ slabs: [slabRow()] }, { ppt: () => gate.then(() => answer([slabCard(101)], 6)) });
  app.ctx.kjrConfirm = async () => true;
  const refresh = app.ctx.refreshPrice('s1', 'slabs');
  assert.ok(await until(() => app.ppt().length === 1), 'the refresh is waiting on the vendor');
  assert.equal(app.ctx._kjrLookupsOpen, 1);
  app.toasts.length = 0;
  await app.ctx.runRefreshQueue(true);
  await app.ctx.runRefreshQueue(false);
  await app.ctx.bulkRefreshPrices('slabs');
  assert.deepEqual(app.toasts, ['A price lookup is running - wait for it to finish first', 'A price lookup is running - wait for it to finish first'], 'the two asked for by hand say why, the auto run stays quiet');
  assert.equal(app.ppt().length, 1, 'none of them asked the vendor anything');
  assert.equal(app.saved(), null, 'and none made a queue for the refresh\'s bill to be lost under');
  assert.equal(app.ctx._queueRunning || app.ctx._bulkRefreshRunning, false);
  release();
  await refresh;
  assert.equal(app.ctx._kjrLookupsOpen, 0, 'none in flight again');
  assert.equal(app.used(), 6);
  assert.equal(app.row('slabs', 's1').marketPrice, '101');
  // with nothing in flight the same queue starts, and spends on top of what the refresh billed
  app.toasts.length = 0;
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  assert.ok(!app.toasts.some((t) => /price lookup is running/.test(t)), JSON.stringify(app.toasts));
  assert.ok(app.used() >= 6, 'one day, one record');
});

test('refresh budget: an English refresh in flight holds the passes back too, and a refresh that throws leaves nothing locked or billed', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = await setup({ singles: [enRow()] }, { gate });
  app.ctx.kjrConfirm = async () => true;
  const refresh = app.ctx.refreshPrice('e1', 'singles');
  assert.ok(await until(() => app.tcg().length >= 1), 'waiting on TCGdex');
  assert.equal(app.ctx._kjrLookupsOpen, 1, 'a refresh in flight counts, whichever lane it is on');
  app.toasts.length = 0;
  await app.ctx.runRefreshQueue(true);
  assert.deepEqual(app.toasts, ['A price lookup is running - wait for it to finish first']);
  release();
  await refresh;
  assert.equal(app.ctx._kjrLookupsOpen, 0);
  assert.equal(app.row('singles', 'e1').marketPrice, '12');
  // the router throwing: the error reaches the caller as it always did, the count is back to zero, nothing was billed
  const boom = await setup({ slabs: [slabRow()] });
  boom.ctx.fetchMarketPrice = async () => { throw new Error('boom'); };
  await assert.rejects(() => boom.ctx.refreshPrice('s1', 'slabs'), /boom/);
  assert.equal(boom.ctx._kjrLookupsOpen, 0);
  assert.equal(boom.saved(), null);
});

// ── from the inspector ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('refresh budget: the inspector\'s Refresh price runs the same rules, says why in a toast and is free to press again', async () => {
  const app = await setup({ slabs: [slabRow()] });
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } });
  const item = app.row('slabs', 's1');
  const before = app.snapshot();
  app.ctx.kjrInspectAct('refresh', { table: 'slabs' }, item);
  assert.equal(app.ctx.kjrInspectAct.busy, true, 'busy while it runs');
  await app.settle();
  assert.equal(app.ctx.kjrInspectAct.busy, false, 'and free again at once, nothing was asked');
  assert.equal(app.ppt().length, 0);
  assert.deepEqual(app.toasts, ['ERR ' + refused('today\'s credits are used up (90 of 90 on the Free plan)')]);
  assert.equal(app.snapshot(), before);
  // the next day's credits: the same control prices the slab and bills it
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 0 } });
  app.toasts.length = 0;
  app.ctx.kjrInspectAct('refresh', { table: 'slabs' }, item);
  await app.settle();
  assert.equal(app.row('slabs', 's1').marketPrice, '101');
  assert.equal(app.used(), 6);
  assert.equal(app.ctx.kjrInspectAct.busy, false);
  // a manual-lane single still says its own reason first, and never reaches the budget
  const manual = await setup({ singles: [enRow({ id: 'm1', name: 'Custom Card' })] });
  manual.ctx.kjrInspectAct('refresh', { table: 'singles' }, manual.row('singles', 'm1'));
  assert.deepEqual(manual.toasts, ['Add or fix the card number for exact pricing']);
});

// ── no spender is left outside the budget ────────────────────────────────────────────────────────────────────────────────────────────

test('refresh budget: every caller of the router is either TCGdex only or bills the day, and refreshPrice asks before it spends and bills what it spent', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const body = (name) => {
    const at = src.indexOf('\nasync function ' + name + '(');
    assert.ok(at >= 0, name + ' exists');
    const next = src.slice(at + 10).search(/\n(?:async )?function /);
    return src.slice(at, at + 10 + next);
  };
  assert.match(body('_runTcgdexLane'), /tcgdexOnly: true/, 'the free lane never reaches PPT');
  assert.match(body('_runRefreshQueueBody'), /dayCreditsUsed\[/, 'the queue bills its own searches');
  assert.match(body('bulkRefreshPrices'), /dayCreditsUsed\[/, 'a bulk run bills its own');
  assert.match(body('kjrBudgetedLookup'), /kjrLookupRefusal\(\)[\s\S]*_kjrBillLookup\(r\)/, 'the lookups ask, then bill');
  const refresh = body('refreshPrice');
  assert.match(refresh, /kjrLookupRefusal\(_pptEstimateCredits\(\{ grader, grade \}\)\)/, 'a card refresh asks with the cost of its own search');
  assert.match(refresh, /if \(lane === 'ppt'\) _kjrBillLookup\(r\);/, 'and bills the PPT lane');
  assert.match(refresh, /_kjrLookupsOpen\+\+;[\s\S]*await fetchMarketPrice\([\s\S]*finally \{\s*_kjrLookupsOpen--;/, 'with the call counted as in flight, whatever happens to it');
  assert.ok(refresh.indexOf('kjrLookupRefusal(') < refresh.indexOf('await fetchMarketPrice('), 'the question comes before the request');
  assert.ok(refresh.indexOf('_kjrBillLookup(r)') < refresh.indexOf('if (r.creditsExhausted)'), 'and the bill before any early return');
  // the router is called from these five functions and no other, in app.js and nowhere in features.js
  const callers = [];
  for (let at = src.indexOf('fetchMarketPrice('); at >= 0; at = src.indexOf('fetchMarketPrice(', at + 1)) {
    if (/function\s+$/.test(src.slice(Math.max(0, at - 20), at))) continue; // the declaration
    if (/\/\/[^\n]*$/.test(src.slice(src.lastIndexOf('\n', at), at))) continue; // a comment that mentions it
    const fnAt = src.lastIndexOf('\nasync function ', at);
    callers.push(src.slice(fnAt + 16, src.indexOf('(', fnAt)));
  }
  assert.deepEqual(callers, ['refreshPrice', '_runTcgdexLane', '_runRefreshQueueBody', 'bulkRefreshPrices', 'kjrBudgetedLookup']);
  assert.ok(!/fetchMarketPrice\(/.test(fs.readFileSync(ROOT + '/features.js', 'utf8').replace(/\/\/[^\n]*/g, '')), 'features.js never calls it');
});

// ── the words ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('refresh budget: the refusal toasts are plain British English with no dash bar and no semicolon, and the lookups\' own wording is as it was', async () => {
  const lines = [];
  const reasons = [
    (a) => a.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } }),
    (a) => a.saveQueue({ dayCreditsUsed: { [UTC()]: 85 } }),
    (a) => a.saveQueue({ creditsPausedDate: UTC() }),
    (a) => { a.ctx._queueRunning = true; },
  ];
  for (const put of reasons) {
    const a = await setup({ slabs: [slabRow()] });
    put(a);
    await a.ctx.refreshPrice('s1', 'slabs');
    lines.push(...a.toasts);
  }
  assert.equal(lines.length, 4);
  for (const t of lines) {
    assert.doesNotMatch(t, new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ';]'), t);
    assert.match(t, /Nothing was changed\.$/);
    assert.ok(t.length <= 220, 'short enough for a toast: ' + t.length);
  }
  // the v3.90 lookups read the same refusal text for a plain search, nothing about it moved
  const app = await setup();
  assert.deepEqual(plain(app.ctx._kjrLookupRefusalText({ why: 'spent', used: 88, limit: 90 })), { reason: 'today\'s credits are used up (88 of 90 on the Free plan)', next: RESET });
  assert.deepEqual(plain(app.ctx._kjrLookupRefusalText({ why: 'spent', used: 88, limit: 90, need: 3 })), { reason: 'today\'s credits are used up (88 of 90 on the Free plan)', next: RESET }, 'a plain search is worded as before');
  assert.deepEqual(plain(app.ctx._kjrLookupRefusalText({ why: 'spent', used: 90, limit: 90, need: 6 })), { reason: 'today\'s credits are used up (90 of 90 on the Free plan)', next: RESET }, 'nothing left reads used up for a slab too');
  assert.equal(app.ctx.kjrLookupRefusal(), null, 'no argument is the plain search\'s 3');
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 85 } });
  assert.equal(app.ctx.kjrLookupRefusal(), null, '5 left pays for a plain search');
  assert.equal(app.ctx.kjrLookupRefusal(3), null);
  assert.deepEqual(plain(app.ctx.kjrLookupRefusal(6)), { why: 'spent', used: 85, limit: 90, need: 6 }, 'and not for a slab\'s');
});
