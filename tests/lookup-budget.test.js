'use strict';
// v3.90, hand lookups bill the day's PokemonPriceTracker credits. testApiKeys (Settings, Test Keys) and searchEbay (the price lookup on Listings)
// were the two callers that could still reach the router's fuzzy raw PPT search after a TCGdex miss. They only show a result and never write a
// price, but they spent credits outside q.dayCreditsUsed, past the budget and the pause the queue and bulkRefreshPrices keep. Now a lookup:
//   - asks TCGdex first, as ever (free), and goes on to PPT only when the day's budget can pay for one search (kjrCreditsLeft) and the vendor
//     has not refused today (q.creditsPausedDate) and no refresh pass is running
//   - bills what the vendor says the search cost into the saved queue's day (q.dayCreditsUsed[utcDay]), and the vendor's own refusal into the
//     same pause, so the queue and a bulk run see it
//   - says on screen why PPT was left out, and what it spent when it spent anything
//   - never writes a price or marks a card
// The fuzzy search stays reachable from these two on purpose (see the comment above kjrBudgetedLookup). Fetch is stubbed (tests/harness.js),
// nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, plain, ROOT } = require('./harness.js');

const QUEUE_KEY = 'pokeinv_refresh_queue';
const STASH_KEY = 'pokeinv_refresh_queue_credits';
const UTC = () => new Date().toISOString().slice(0, 10);
const YESTERDAY = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total } } });
const EXHAUSTED = { error: 'Daily credit limit exceeded', retryAfter: 3600, resetsAt: '2026-10-26T00:00:00.000Z' };
// "Alpha 1" is card number 1 of a set TCGdex knows as set-1, "Charizard ex 223/197" is set-223. The vendor's fuzzy search finds Alpha at US$7.
const fuzzyCard = { id: 'v-1', name: 'Alpha', cardNumber: '1/100', setName: 'Set', prices: { market: 7 } };

// TCGdex: a card number N resolves to set-N, whose TCGplayer market is prices['set-N'] (a card with none is a 404, an unknown list is empty)
function tcgdex(fetchMock, prices) {
  fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) return prices['set-' + decodeURIComponent(list[2])] ? jsonResponse([{ id: 'set-' + decodeURIComponent(list[2]) }]) : jsonResponse([]);
    const card = url.match(/\/cards\/(set-\d+)$/);
    if (card) return prices[card[1]] ? jsonResponse({ id: card[1], pricing: { tcgplayer: { holofoil: { marketPrice: prices[card[1]] } } } }) : jsonResponse({}, 404);
    return jsonResponse({}, 404);
  });
}

async function setup(seed, opts) {
  const o = Object.assign({ prices: {}, ppt: () => answer([fuzzyCard], 3) }, opts || {});
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), jaLane: true });
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  tcgdex(app.fetchMock, o.prices);
  app.fetchMock.route('/ppt/cards', o.ppt);
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.tcg = () => app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net'));
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  app.used = () => (app.saved() && app.saved().dayCreditsUsed ? app.saved().dayCreditsUsed[UTC()] : undefined);
  // a saved queue with this much of today's credits already spent (by the queue, a bulk run or an earlier lookup)
  app.saveQueue = (patch) => {
    const q = plain(app.ctx.buildRefreshQueue());
    Object.assign(q, patch || {});
    app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    return q;
  };
  app.search = async (text) => { app.document.getElementById('ebay-query').value = text; await app.ctx.searchEbay(); return app.document.getElementById('ebay-out').innerHTML; };
  app.testKeys = async () => { await app.ctx.testApiKeys(); return app.document.getElementById('api-key-status').innerHTML; };
  // everything a price could be written to, as one string: the rows and the saved copy of them
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

// ── a TCGdex answer needs no credits ────────────────────────────────────────────────────────────────────────────────────────────────────

test('lookup budget: a TCGdex answer asks PokemonPriceTracker nothing, spends nothing and leaves no queue behind', async () => {
  const app = await setup({}, { prices: { 'set-1': 12 } });
  const before = app.snapshot();
  const html = await app.search('Alpha 1');
  assert.match(html, /Market Price \(TCGdex/);
  assert.equal(app.ppt().length, 0, 'no PPT request');
  assert.equal(app.saved(), null, 'nothing was spent, so no queue was made to hold it');
  assert.doesNotMatch(html, /PokemonPriceTracker used|credits used/);
  assert.equal(app.snapshot(), before, 'and no price or row was touched');
});

// ── the fuzzy search is billed ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('lookup budget: a TCGdex miss goes on to the fuzzy PPT search, its credits are billed into today\'s budget and the screen says so', async () => {
  const app = await setup({ singles: [{ id: 'a1', name: 'Alpha 1', language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }] });
  const before = app.snapshot();
  const html = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 1, 'TCGdex missed, so one fuzzy search');
  const u = new URL(app.ppt()[0].url);
  assert.equal(u.searchParams.get('search'), 'Alpha 1');
  assert.equal(u.searchParams.get('limit'), '3');
  assert.equal(u.searchParams.get('includeEbay'), null, 'the plain name search, no eBay data');
  assert.equal(u.searchParams.get('language'), null);
  assert.match(html, /Market Price \(PPT\)/);
  assert.match(html, /S\$7/);
  assert.match(html, /PokemonPriceTracker used 3 credits, 3 of 90 spent today on the Free plan/);
  assert.equal(app.used(), 3, 'billed into the queue\'s day, in credits');
  assert.equal(app.saved().creditsVersion, 1);
  assert.equal(app.saved().creditsPausedDate === undefined || app.saved().creditsPausedDate === null, true, 'no pause');
  // a second lookup adds to the same day
  await app.search('Alpha 1');
  assert.equal(app.used(), 6);
  assert.equal(app.ctx.kjrCreditsUsedOn(app.saved(), UTC()), 6);
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), UTC()), 84, 'the queue and a bulk run see what the lookups spent');
  assert.equal(app.snapshot(), before, 'display only: no price written, no row marked, nothing saved but the credits');
});

test('lookup budget: what the vendor says a search cost is what is billed, one credit reads as one credit, and a lookup with no metadata is billed the estimate', async () => {
  let total = 1;
  const app = await setup({}, { ppt: () => answer([fuzzyCard], total) });
  assert.match(await app.search('Alpha 1'), /PokemonPriceTracker used 1 credit, 1 of 90 spent today/);
  assert.equal(app.used(), 1);
  total = 5;
  assert.match(await app.search('Alpha 1'), /PokemonPriceTracker used 5 credits, 6 of 90 spent today/);
  assert.equal(app.used(), 6);
  // an answer with no metadata is a search the estimate prices: 3 credits (PPT_SEARCH_CREDITS)
  const bare = await setup({}, { ppt: () => jsonResponse({ data: [fuzzyCard] }) });
  await bare.search('Alpha 1');
  assert.equal(bare.used(), 3);
  // the fuzzy search makes two requests when the first finds nothing (the second drops the number), both are billed
  const two = await setup({}, { ppt: (url) => answer(new URL(url).searchParams.get('search') === 'Alpha' ? [fuzzyCard] : [], 3) });
  const html = await two.search('Alpha 1');
  assert.equal(two.ppt().length, 2, 'the full name, then the base name');
  assert.equal(two.used(), 6, 'six credits for two searches');
  assert.match(html, /PokemonPriceTracker used 6 credits, 6 of 90 spent today/);
  assert.match(html, /Confidence: low/, 'the broader search is still marked a guess');
});

test('lookup budget: a miss that spent credits still reports them, and a request that never got an answer costs nothing', async () => {
  const miss = await setup({}, { ppt: () => answer([], 3) });
  const html = await miss.search('Alpha 1');
  assert.match(html, /No price found for "Alpha 1"/);
  assert.match(html, /PokemonPriceTracker used 6 credits, 6 of 90 spent today/, 'two empty searches were still billed, the answer was an answer');
  assert.equal(miss.used(), 6);
  const down = await setup({}, { ppt: () => jsonResponse({}, 503) });
  const out = await down.search('Alpha 1');
  assert.match(out, /No price found/);
  assert.doesNotMatch(out, /credits used|PokemonPriceTracker used/);
  assert.equal(down.saved(), null, 'an HTTP 503 spent nothing, so nothing was billed and no queue made');
});

// ── the budget is checked before PPT is asked ──────────────────────────────────────────────────────────────────────────────────────────

test('lookup budget: with less than a search left only TCGdex is asked, nothing is billed and the screen says why', async () => {
  const app = await setup();
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 88 } }); // 2 left of 90, a search costs up to 3
  const before = app.localStorage.getItem(QUEUE_KEY);
  const html = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 0, 'PPT was not asked');
  assert.ok(app.tcg().length > 0, 'TCGdex still was, it is free');
  assert.match(html, /Daily price-lookup limit reached/);
  assert.match(html, /PokemonPriceTracker was not asked because today's credits are used up \(88 of 90 on the Free plan\)\. They reset at 8am Singapore time \(midnight UTC\)\./);
  assert.match(html, /TCGdex: /);
  assert.match(html, /add the card number so TCGdex can price it for free/);
  assert.equal(app.localStorage.getItem(QUEUE_KEY), before, 'the saved queue is untouched, a refusal writes nothing');
});

test('lookup budget: exactly one search of budget left is allowed, and it is billed to the full day', async () => {
  const app = await setup();
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 87 } }); // 3 left of 90
  const html = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 1);
  assert.equal(app.used(), 90);
  assert.match(html, /PokemonPriceTracker used 3 credits, 90 of 90 spent today on the Free plan/);
  // and now there is nothing left for the next one
  const next = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 1, 'no second request');
  assert.match(next, /today's credits are used up \(90 of 90 on the Free plan\)/);
});

test('lookup budget: a vendor pause earlier today stops the lookup whatever the count says, and a pause from another day does not', async () => {
  const app = await setup();
  app.saveQueue({ creditsPausedDate: UTC(), dayCreditsUsed: { [UTC()]: 3 } });
  const html = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 0);
  assert.match(html, /PokemonPriceTracker was not asked because it refused any more credits earlier today\. They reset at 8am Singapore time \(midnight UTC\)\./);
  assert.equal(app.used(), 3);
  // the vendor's day rolled over: yesterday's pause is no pause
  const fresh = await setup();
  fresh.saveQueue({ creditsPausedDate: YESTERDAY(), dayCreditsUsed: { [YESTERDAY()]: 90 } });
  const ok = await fresh.search('Alpha 1');
  assert.equal(fresh.ppt().length, 1);
  assert.match(ok, /Market Price \(PPT\)/);
  assert.equal(fresh.used(), 3);
});

test('lookup budget: the budget is the plan\'s, so the Paid plan\'s refusal names 18,000 and its label', async () => {
  const app = await setup();
  app.ctx.kjrPptSetPlan('paid');
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 17999 } });
  const html = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 0);
  assert.match(html, /today's credits are used up \(17,999 of 18,000 on the Paid plan\)/);
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 5000 } });
  assert.match(await app.search('Alpha 1'), /PokemonPriceTracker used 3 credits, 5,003 of 18,000 spent today on the Paid plan/);
});

// ── the vendor's own refusal ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('lookup budget: the vendor refusing for credits during a lookup pauses the queue for the day, marks no card and stops the next lookup before it asks', async () => {
  const app = await setup({ singles: [{ id: 'a1', name: 'Alpha 1', language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }] }, { ppt: () => jsonResponse(EXHAUSTED, 429) });
  const before = app.snapshot();
  const html = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 1);
  assert.match(html, /Daily price-lookup limit reached/);
  assert.match(html, /PokemonPriceTracker refused any more credits today\. They reset at 8am Singapore time \(midnight UTC\)\./);
  assert.equal(app.saved().creditsPausedDate, UTC(), 'the queue\'s pause, the one the queue and a bulk run read');
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), UTC()), 0);
  assert.equal(app.used() || 0, 0, 'a refusal costs nothing');
  assert.doesNotMatch(html, /credits used|PokemonPriceTracker used/);
  assert.equal(app.snapshot(), before, 'no card was marked as unmatched, the vendor\'s answer says nothing about it');
  // the next lookup does not ask at all
  const next = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 1, 'still the one request');
  assert.match(next, /PokemonPriceTracker was not asked because it refused any more credits earlier today/);
  // a plan change gives the vendor a fresh start, the same rule as for the queue (kjrPptSetPlan clears the pause)
  app.ctx.kjrPptSetPlan('paid');
  assert.equal(app.saved().creditsPausedDate, null);
});

test('lookup budget: a refusal after the first of the fuzzy search\'s two requests bills that first request and pauses the day', async () => {
  let n = 0;
  const app = await setup({}, { ppt: () => (++n === 1 ? answer([], 3) : jsonResponse(EXHAUSTED, 429)) });
  const html = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 2);
  assert.equal(app.used(), 3, 'the first search was an answer and is billed');
  assert.equal(app.saved().creditsPausedDate, UTC());
  assert.match(html, /Daily price-lookup limit reached/);
  assert.match(html, /PokemonPriceTracker used 3 credits, 3 of 90 spent today/);
});

// ── the one record the credits live on ────────────────────────────────────────────────────────────────────────────────────────────────────

test('lookup budget: a queue saved before v3.85 counted requests, so a lookup reads its day as three times that and writes the conversion back', async () => {
  const app = await setup();
  const old = app.saveQueue({ dayCreditsUsed: { [UTC()]: 28 } }); // 28 requests of up to 3 credits: 84 credits, 6 left
  delete old.creditsVersion;
  app.localStorage.setItem(QUEUE_KEY, JSON.stringify(old));
  assert.equal(app.ctx.kjrCreditsUsedOn(app.saved(), UTC()), 84);
  assert.match(await app.search('Alpha 1'), /PokemonPriceTracker used 3 credits, 87 of 90 spent today/);
  assert.equal(app.saved().creditsVersion, 1);
  assert.equal(app.used(), 87, 'in credits now, 84 and 3');
  const full = await setup();
  const older = full.saveQueue({ dayCreditsUsed: { [UTC()]: 30 } }); // 90 credits
  delete older.creditsVersion;
  full.localStorage.setItem(QUEUE_KEY, JSON.stringify(older));
  assert.match(await full.search('Alpha 1'), /today's credits are used up \(90 of 90/);
  assert.equal(full.ppt().length, 0);
  assert.equal(full.saved().creditsVersion, undefined, 'a refusal leaves the old queue exactly as it was');
});

test('lookup budget: credits a cleared queue left aside still count, the check only reads them, and the queue a lookup then makes picks them up', async () => {
  const app = await setup();
  assert.equal(app.saved(), null);
  app.localStorage.setItem(STASH_KEY, JSON.stringify({ dayCreditsUsed: { [UTC()]: 88 }, creditsPausedDate: null }));
  const html = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 0, '88 of 90 are spent whatever queue they sit on');
  assert.match(html, /today's credits are used up \(88 of 90/);
  assert.equal(app.saved(), null, 'refusing made no queue');
  assert.ok(app.localStorage.getItem(STASH_KEY), 'and took nothing off the side record');

  const room = await setup();
  room.localStorage.setItem(STASH_KEY, JSON.stringify({ dayCreditsUsed: { [UTC()]: 60 }, creditsPausedDate: null }));
  assert.match(await room.search('Alpha 1'), /PokemonPriceTracker used 3 credits, 63 of 90 spent today/);
  assert.equal(room.used(), 63, 'the new queue holds the 60 that were set aside, and the 3');
  assert.equal(room.localStorage.getItem(STASH_KEY), null, 'taken, as the queue itself takes it');
});

test('lookup budget: a queue of an older schema is set aside the way loadQueue always does it, and the credits it held still count', async () => {
  const app = await setup();
  app.saveQueue({ schemaVersion: 1, dayCreditsUsed: { [UTC()]: 88 } });
  const html = await app.search('Alpha 1');
  assert.equal(app.ppt().length, 0, 'PPT was not asked, 88 of 90 are spent');
  assert.match(html, /today's credits are used up \(88 of 90/);
  assert.equal(app.saved(), null, 'loadQueue dropped the old queue for every caller alike');
  assert.deepEqual(plain(JSON.parse(app.localStorage.getItem(STASH_KEY)).dayCreditsUsed), { [UTC()]: 88 }, 'and left its credits for the queue that replaces it');
});

test('lookup budget: with no queue and nothing spent, the first lookup that spends makes the queue, and the check itself writes nothing', async () => {
  const app = await setup();
  const keys = () => JSON.stringify(Array.from({ length: app.localStorage.length }, (_, i) => app.localStorage.key(i)).sort());
  const before = keys();
  assert.equal(app.ctx.kjrLookupRefusal(), null, 'a fresh day has room');
  assert.equal(keys(), before, 'asking is read only');
  await app.search('Alpha 1');
  assert.deepEqual(plain(app.saved().dayCreditsUsed), { [UTC()]: 3 });
  assert.equal(app.saved().schemaVersion, app.ctx.QUEUE_SCHEMA_VERSION);
  assert.equal(app.saved().completed, false, 'an ordinary queue, the first run of the day will use it');
});

// ── passes and lookups do not run over each other ─────────────────────────────────────────────────────────────────────────────────────

test('lookup budget: while the queue or a bulk run is running a lookup asks TCGdex only and says a refresh is running', async () => {
  for (const flag of ['_queueRunning', '_bulkRefreshRunning']) {
    const app = await setup();
    app.ctx[flag] = true;
    const html = await app.search('Alpha 1');
    assert.equal(app.ppt().length, 0, flag);
    assert.match(html, /A price refresh is running/, flag);
    assert.match(html, /PokemonPriceTracker was not asked because a price refresh is running and spends the same daily credits\. Try again when it has finished\./, flag);
    assert.doesNotMatch(html, /8am Singapore/, 'nothing to wait for until tomorrow: ' + flag);
    assert.equal(app.saved(), null, flag + ': nothing written under a pass that holds the queue in memory');
    app.ctx[flag] = false;
    assert.match(await app.search('Alpha 1'), /Market Price \(PPT\)/, 'and it asks again once the pass has ended: ' + flag);
  }
});

test('lookup budget: a pass does not start under a lookup that is still waiting for the vendor, and the lookup\'s bill lands once it is answered', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = await setup({ slabs: [{ id: 's1', name: 'Alpha 1', grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }] },
    { ppt: () => gate.then(() => answer([fuzzyCard], 3)) });
  app.ctx.kjrConfirm = async () => true;
  const lookup = app.search('Alpha 1');
  assert.ok(await until(() => app.ppt().length === 1), 'the lookup is waiting on its fuzzy search');
  assert.equal(app.ctx._kjrLookupsOpen, 1);
  // the queue (asked for by hand, and the quiet auto run) and a bulk run all refuse, and make no request of their own
  await app.ctx.runRefreshQueue(true);
  await app.ctx.runRefreshQueue(false);
  await app.ctx.bulkRefreshPrices('slabs');
  assert.deepEqual(app.toasts.filter((t) => /price lookup is running/.test(t)), [
    'A price lookup is running - wait for it to finish first', 'A price lookup is running - wait for it to finish first'], 'the two asked for by hand say why, the auto run stays quiet');
  assert.equal(app.ppt().length, 1, 'none of them asked the vendor anything');
  assert.equal(app.saved(), null, 'and none made a queue for the lookup\'s bill to be lost under');
  assert.equal(app.ctx._queueRunning || app.ctx._bulkRefreshRunning, false);
  release();
  const html = await lookup;
  assert.match(html, /PokemonPriceTracker used 3 credits/);
  assert.equal(app.ctx._kjrLookupsOpen, 0, 'open lookups back to none');
  assert.equal(app.used(), 3);
  // with no lookup open the same pass starts, and spends on top of what the lookup billed
  app.toasts.length = 0;
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  assert.ok(!app.toasts.some((t) => /price lookup is running/.test(t)), JSON.stringify(app.toasts));
  assert.ok(app.ppt().length > 1, 'the queue went to the vendor for the slab');
  assert.ok(app.used() > 3, 'its credits were added to the lookup\'s, one day, one record');
});

test('lookup budget: a lookup that throws, or is refused, leaves no pass locked out', async () => {
  const app = await setup();
  const real = app.ctx.fetchMarketPrice;
  app.ctx.fetchMarketPrice = async () => { throw new Error('boom'); };
  const html = await app.search('Alpha 1');
  assert.match(html, /Price lookup threw: boom/);
  assert.equal(app.ctx._kjrLookupsOpen, 0, 'the count is back to zero after a throw');
  app.ctx.fetchMarketPrice = real;
  await app.testKeys();
  assert.equal(app.ctx._kjrLookupsOpen, 0);
});

test('lookup budget: two lookups in flight together both bill, neither overwrites the other', async () => {
  const gates = [];
  const app = await setup({}, { ppt: () => new Promise((r) => gates.push(() => r(answer([fuzzyCard], 3)))) });
  const a = app.ctx.kjrBudgetedLookup({ name: 'Alpha 1', grader: null, grade: null, language: null });
  const b = app.ctx.kjrBudgetedLookup({ name: 'Alpha 1', grader: null, grade: null, language: null });
  assert.ok(await until(() => gates.length === 2), 'both are waiting on the vendor');
  assert.equal(app.ctx._kjrLookupsOpen, 2);
  gates[0]();
  await a;
  assert.equal(app.ctx._kjrLookupsOpen, 1, 'one left in flight');
  gates[1]();
  const [ra, rb] = [await a, await b];
  assert.equal(app.ctx._kjrLookupsOpen, 0);
  assert.equal(app.used(), 6, 'each read the queue fresh when its own answer came, so the second added to the first');
  assert.equal(rb.billed.used, 6);
  assert.equal(ra.billed.used, 3, 'the first one reported the day as it stood when it was billed');
});

// ── Test Keys ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('lookup budget: Test Keys with a TCGdex answer reads as it always did, asks no PPT and spends nothing', async () => {
  const app = await setup({}, { prices: { 'set-223': 80 } });
  const html = await app.testKeys();
  assert.match(html, /✓ <strong>TCGdex:<\/strong> US\$80 → S\$80 \(TCGdex/);
  assert.match(html, /<div style="color:var\(--red\)">✗ PokemonPriceTracker \(slab fallback\): not applicable<\/div>/, 'the line it has always printed when PPT was not needed');
  assert.equal(app.ppt().length, 0);
  assert.equal(app.saved(), null);
  assert.doesNotMatch(html, /credits used|not tried/);
});

test('lookup budget: Test Keys after a TCGdex miss uses the PPT fallback inside the budget, bills it and says what it cost', async () => {
  const app = await setup({}, { ppt: () => answer([{ id: 'v-223', name: 'Charizard ex', cardNumber: '223/197', setName: 'Set', prices: { market: 90 } }], 3) });
  const html = await app.testKeys();
  assert.equal(app.ppt().length, 1);
  assert.match(html, /\(TCGdex missed, PPT fallback served this test\)/);
  assert.match(html, /<div style="font-size:11px;color:var\(--text3\)">PokemonPriceTracker used 3 credits, 3 of 90 spent today on the Free plan<\/div>/);
  assert.equal(app.used(), 3);
});

test('lookup budget: Test Keys with the budget spent does not ask PPT, says it was not tried and why, and an answer from TCGdex needs none of it', async () => {
  const app = await setup();
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } });
  const html = await app.testKeys();
  assert.equal(app.ppt().length, 0);
  assert.match(html, /<div style="color:var\(--red\)">✗ TCGdex: /);
  assert.match(html, /<div style="color:var\(--amber\)">⏸ PokemonPriceTracker: not tried, today's credits are used up \(90 of 90 on the Free plan\)<\/div>/);
  assert.equal(app.used(), 90);
  // with TCGdex answering, the same spent day says nothing about PPT it was never going to be asked
  const answered = await setup({}, { prices: { 'set-223': 80 } });
  answered.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } });
  const ok = await answered.testKeys();
  assert.match(ok, /✓ <strong>TCGdex:/);
  assert.doesNotMatch(ok, /not tried|used up/);
  // paused and running read as their own words
  const paused = await setup();
  paused.saveQueue({ creditsPausedDate: UTC() });
  assert.match(await paused.testKeys(), /not tried, it refused any more credits earlier today/);
  const running = await setup();
  running.ctx._queueRunning = true;
  assert.match(await running.testKeys(), /not tried, a price refresh is running and spends the same daily credits/);
  assert.equal(running.ppt().length, 0);
});

// ── the router is called with the descriptor each case needs ────────────────────────────────────────────────────────────────────────

test('lookup budget: the router is given a plain name lookup while the budget can pay, and tcgdexOnly the moment it cannot, never a grader or the Japanese flag', async () => {
  const seen = [];
  const app = await setup();
  const real = app.ctx.fetchMarketPrice;
  app.ctx.fetchMarketPrice = (d) => { seen.push(plain(d)); return real(d); };
  await app.search('Alpha 1');
  await app.testKeys();
  assert.deepEqual(seen, [
    { name: 'Alpha 1', grader: null, grade: null, language: null },
    { name: 'Charizard ex 223/197', grader: null, grade: null, language: 'EN' },
  ], 'the fuzzy search is reachable while there is budget, that is what these two are for');
  seen.length = 0;
  app.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } });
  await app.search('Alpha 1');
  await app.testKeys();
  assert.deepEqual(seen, [
    { name: 'Alpha 1', grader: null, grade: null, language: null, tcgdexOnly: true },
    { name: 'Charizard ex 223/197', grader: null, grade: null, language: 'EN', tcgdexOnly: true },
  ], 'with none, the same lookups with the fuzzy search shut');
  for (const d of seen) assert.ok(!d.japanese && !d.grader && !d.grade);
});

test('lookup budget: no other caller can reach the fuzzy raw PPT search, every call of the router outside these two lookups names its lane', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const calls = [];
  for (let at = src.indexOf('fetchMarketPrice('); at >= 0; at = src.indexOf('fetchMarketPrice(', at + 1)) {
    if (/function\s+$/.test(src.slice(Math.max(0, at - 20), at))) continue; // the declaration
    if (/\/\/[^\n]*$/.test(src.slice(src.lastIndexOf('\n', at), at))) continue; // a comment that mentions it
    let depth = 0, end = at + 'fetchMarketPrice'.length;
    for (let i = end; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) { end = i; break; } }
    const fnAt = src.lastIndexOf('\nasync function ', at);
    calls.push({ fn: src.slice(fnAt + 16, src.indexOf('(', fnAt)), text: src.slice(at, end + 1) });
  }
  assert.deepEqual(calls.map((c) => c.fn), ['refreshPrice', '_runTcgdexLane', '_runRefreshQueueBody', 'bulkRefreshPrices', 'kjrBudgetedLookup']);
  for (const c of calls.filter((x) => x.fn !== 'kjrBudgetedLookup')) {
    assert.match(c.text, /tcgdexOnly|japanese|grader/, c.fn + ' names a lane, so the raw fuzzy search is not reachable from it');
  }
  assert.ok(!/fetchMarketPrice\(/.test(fs.readFileSync(ROOT + '/features.js', 'utf8').replace(/\/\/[^\n]*/g, '')), 'and features.js calls it nowhere');
  // the two lookups reach it only through the budgeted helper
  const lookups = src.slice(src.indexOf('async function testApiKeys()'), src.indexOf('async function testApiKeys()') + 2500) + src.slice(src.indexOf('async function searchEbay()'), src.indexOf('async function searchEbay()') + 1800);
  assert.ok(!/(^|[^.\w])fetchMarketPrice\(/.test(lookups.replace(/\/\/[^\n]*/g, '')), 'testApiKeys and searchEbay call kjrBudgetedLookup, not the router');
  assert.equal((lookups.match(/kjrBudgetedLookup\(/g) || []).length, 2);
});

// ── the words ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('lookup budget: the label on the Listings lookup says what it does, TCGdex first then PokemonPriceTracker, with its credits', () => {
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const label = html.match(/<div style="font-size:12px;color:var\(--text3\);margin-bottom:8px">([^<]*)<\/div>\s*<div id="ebay-out"/)[1];
  assert.equal(label, 'Checks TCGdex first, then PokemonPriceTracker if TCGdex has no match. The PokemonPriceTracker step spends credits from today\'s price budget. It shows a price only and never changes a card.');
  assert.doesNotMatch(label, /eBay|completed listings|real time|AI/, 'not what it did before the price rework');
  assert.doesNotMatch(label, new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ';]'), 'no dash bar, no semicolon');
});

// v3.91: the card's heading said "eBay Last Sold Lookup" and its button "Search eBay", the words of the old AI lookup the v3.90 label had already
// replaced, so the label contradicted its own heading. The function (searchEbay) and the ids (ebay-query, ebay-out) keep their names, they are code
// and not words on a screen, and the eBay pipeline page and its nav item are another thing and are untouched.
test('lookup wording: the heading and the button say what the lookup does and nothing in the box promises eBay', () => {
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const head = html.indexOf('<h3>');
  const at = html.indexOf('<h3>🔍 Market Price Lookup</h3>');
  assert.ok(at > head, 'the heading is the market price one');
  const start = html.lastIndexOf('<div class="card">', at);
  const card = html.slice(start, html.indexOf('<div id="ebay-out"', at));
  assert.match(card, /<div class="card-head"><h3>🔍 Market Price Lookup<\/h3><span id="fx-rate-display"/);
  assert.match(card, /<button class="btn btn-primary" onclick="searchEbay\(\)" title="Checks TCGdex first, then PokemonPriceTracker, which uses credits">Look up price<\/button>/);
  assert.doesNotMatch(html, /Last Sold Lookup|Search eBay<\/button>/);
  // nothing a person reads or hears in that card says eBay: its words, and every title, placeholder and aria-label in it
  const words = card.replace(/<[^>]*>/g, ' ');
  assert.doesNotMatch(words, /ebay/i, 'visible words');
  const attrs = [...card.matchAll(/\b(title|placeholder|aria-label|alt|aria-describedby)="([^"]*)"/g)].map((m) => m[2]);
  assert.ok(attrs.length >= 2, 'the button\'s title and the field\'s placeholder at least');
  for (const a of attrs) assert.doesNotMatch(a, /ebay/i, a);
  // the words the lookup prints are the same: its results and its errors never say eBay either (the code around them does, in names)
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const fn = src.slice(src.indexOf('async function searchEbay()'), src.indexOf('\n}\n', src.indexOf('async function searchEbay()')));
  assert.doesNotMatch(fn.replace(/\/\/[^\n]*/g, '').replace('async function searchEbay()', '').replace(/getElementById\('ebay-(query|out)'\)/g, ''), /ebay/i, 'no eBay in what searchEbay shows, only in the names of the function and the two elements it reads');
  // the in-app guide, the Settings text and the command words do not promise it either
  const guide = html.slice(html.indexOf('id="guide-source"'), html.indexOf('</script>', html.indexOf('id="guide-source"')));
  assert.doesNotMatch(guide, /last sold|search ebay|completed listing/i);
  assert.match(guide, /\*\*Listings\*\* - builds a Carousell title and description and pulls the market price\./, 'the guide line for the page is still true');
  // and the eBay pipeline page keeps its own name
  assert.match(html, /<button class="nav-btn[^"]*" aria-label="eBay" onclick="showPage\('ebay'\)">/);
  assert.match(html, /aria-label="Search eBay purchases"/);
});

test('lookup budget: every line the lookups print about credits is plain British English with no dash bar and no semicolon', async () => {
  const lines = [];
  for (const prep of [
    (a) => a.saveQueue({ dayCreditsUsed: { [UTC()]: 90 } }),
    (a) => a.saveQueue({ creditsPausedDate: UTC() }),
    (a) => { a.ctx._queueRunning = true; },
  ]) {
    const a = await setup();
    prep(a);
    lines.push(await a.search('Alpha 1'), await a.testKeys());
  }
  const vendor = await setup({}, { ppt: () => jsonResponse(EXHAUSTED, 429) });
  lines.push(await vendor.search('Alpha 1'));
  const cost = await setup();
  lines.push(await cost.search('Alpha 1'), await cost.testKeys());
  for (const html of lines) {
    const copy = html.replace(/<[^>]*>/g, ' ').replace(/&[#\w]+;/g, '');
    assert.doesNotMatch(copy, new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']'), copy);
    assert.doesNotMatch(copy, /;/, 'no semicolon: ' + copy);
  }
});
