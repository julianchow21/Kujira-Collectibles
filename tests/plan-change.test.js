'use strict';
// v3.95, a plan change clears the vendor's pause on the queue a pass or a bulk run holds in memory, not on the saved queue alone. kjrPptSetPlan cleared
// creditsPausedDate on the saved queue, and the pass and the bulk run keep their own copy of the queue and write it back as they go:
//   - the vendor had refused today, the page-load pass was on its free lane, the owner picked the other plan in the API settings: the toast confirmed the plan and
//     storage showed the pause gone, then the pass's next save wrote the pause back, and PPT stayed off for the day with no word
//   - a bulk run holding the paused queue went on reading the pause in its copy, so every PPT row after the upgrade stopped at the old pause
// Now the change clears the pause on the held copy too (_kjrHeldQueue), in the same step as on the saved one, and:
//   - the plan is always saved, a pass, a bulk run, the bulk question or a lookup in flight never refuses it
//   - after the holder finishes the saved queue has no pause from before the change, and a refusal the vendor gives after the change still pauses the day
//   - the open bulk question and a lookup in flight hold no copy, they read the saved queue after the change, as before
// Fetch is stubbed (tests/harness.js) and the clock is faked (tests/clock.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, plain, ROOT } = require('./harness.js');
const { setClock } = require('./clock.js');

const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);
const QUEUE_KEY = 'pokeinv_refresh_queue';
const DAY = '2026-10-25';
const AT = '2026-10-25T04:00:00Z'; // 12:00 in Singapore, the vendor's day is the 25th
const EXHAUSTED = { error: 'Daily credit limit exceeded', retryAfter: 3600, resetsAt: '2026-10-26T00:00:00.000Z' };
const PLAN_TOAST = 'Price plan: Paid, 18,000 credits a day for the queue';
const enRow = (id, name, extra) => Object.assign({ id, name, language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabRow = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 500, marketPrice: '', priceHistory: [] }, extra);
// a Japanese single the PPT lane takes: a card number and a matched card (a TCGdex id with a set code), "Monaa 1" is SV8a-001
const jaRow = (id, n) => { const c = String.fromCharCode(96 + n); return { id, name: 'Mon' + c + c + ' ' + n, language: 'JP', type: 'raw', status: 'Available', tcgdexId: 'SV8a-00' + n, costPrice: 100, marketPrice: '', priceHistory: [] }; };
// the vendor: "Alpha 1" at PSA 10 is 101 and a slab search with eBay data costs 6 credits, a Japanese search costs 3 and prices the card at 3
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total } } });
const slabCard = (search) => {
  const m = /^(.+) (\d+)$/.exec(search || '');
  return m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};
const jaCard = (search) => {
  const m = /^Mon([a-z])\1 SV8a$/.exec(search || '');
  const n = m ? m[1].charCodeAt(0) - 96 : 0;
  return n ? { id: 'c' + n, name: 'Mon' + m[1] + m[1], setName: 'SV8a: Test Set', cardNumber: '00' + n + '/100', prices: { market: 3 } } : null;
};
// TCGdex: card number 26 is set-26 at 8 and 27 is set-27 at 9, it knows no other number
const TCG_PRICES = { 26: 8, 27: 9 };

async function setup(seed) {
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), jaLane: true });
  app.clock = setClock(app, AT);
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.ctx.kjrConfirm = async () => true;
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  // A hook runs as the nth PPT request, or the nth TCGdex price request, arrives at the source: the request is in flight and its answer is not in yet, which is
  // when the owner changes the plan in these tests. A hook records what it saw in app.mid, it never asserts (a throw inside fetch would read as a transport failure).
  // The nth PPT request can be refused for credits.
  app.pptHooks = {}; app.tcgHooks = {}; app.refuseAt = 0; app.mid = null;
  let pptSeen = 0, tcgSeen = 0;
  app.fetchMock.route('/ppt/cards', (url) => {
    const n = ++pptSeen;
    if (app.pptHooks[n]) app.pptHooks[n]();
    if (n === app.refuseAt) return jsonResponse(EXHAUSTED, 200);
    const u = new URL(url);
    const search = u.searchParams.get('search');
    if (u.searchParams.get('language') === 'japanese') return answer([jaCard(search)].filter(Boolean), 3);
    if (u.searchParams.get('includeEbay') === 'true') return answer([slabCard(search)].filter(Boolean), 6);
    return answer([], 3); // the plain name search a lookup falls back to after a TCGdex miss: nothing found
  });
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) { const n = decodeURIComponent(list[2]); return TCG_PRICES[n] ? jsonResponse([{ id: 'set-' + n }]) : jsonResponse([]); }
    const card = url.match(/\/cards\/set-(\d+)$/);
    if (card && TCG_PRICES[card[1]]) {
      const n = ++tcgSeen;
      if (app.tcgHooks[n]) app.tcgHooks[n]();
      return jsonResponse({ id: 'set-' + card[1], pricing: { tcgplayer: { holofoil: { marketPrice: TCG_PRICES[card[1]] } } } });
    }
    return jsonResponse({}, 404);
  });
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.row = (id, table) => app.ctx.DB[table || 'singles'].find((r) => r.id === id);
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  // a saved queue, as the queue or a lookup would have left it
  app.saveQueue = (patch) => {
    const q = plain(app.ctx.buildRefreshQueue());
    Object.assign(q, patch || {});
    app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    return q;
  };
  return app;
}
// run a started call to its end, firing every wait it makes, and fail (not hang) when it does not end
async function finish(app, p) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 1500 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    app.timers.flush((e) => [6000, 1100, 250, 2000].includes(e.delay));
  }
  if (!done) throw new Error('the run did not finish');
  return p;
}
const doneToast = (app) => app.toasts.find((t) => /^Done: /.test(t));

// ── the pass ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('plan change: during the page-load pass that holds the paused queue, the plan is saved, the pause goes at once and the pass does not put it back', async () => {
  const app = await setup({ singles: [enRow('b', 'Raichu 26')], slabs: [slabRow('s1', 'Alpha 1')] });
  app.saveQueue({ dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: DAY }); // the vendor refused earlier today
  app.tcgHooks[1] = () => { // the pass is on its free lane, Raichu's price request is in flight, and the owner picks Paid in the API settings
    app.ctx.kjrPptPlanChoose('paid');
    app.mid = { plan: app.ctx.kjrPptPlan(), stored: app.saved().creditsPausedDate, pass: app.ctx._queueRunning, toasts: app.toasts.slice() };
  };
  await finish(app, app.ctx.runRefreshQueue(false)); // the page-load pass: a pass asked for by hand clears the pause itself, by design
  assert.deepEqual(app.mid, { plan: 'paid', stored: null, pass: true, toasts: [PLAN_TOAST] }, 'under the pass: the plan is saved, the pause is gone from storage, the one toast as before');
  assert.equal(app.row('b').marketPrice, '8', 'the pass finished its free lane');
  assert.equal(app.ppt().length, 0, 'and asked the vendor nothing: its budget was read when it started, the next run asks on the new plan');
  assert.equal(app.saved().creditsPausedDate, null, 'the pass\'s saves did not put the pause back');
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), DAY), 18000 - 30, 'so the day has the Paid plan\'s credits');
  assert.deepEqual(app.toasts, [PLAN_TOAST], 'and nothing else was said');
  // the next pass of the day asks the vendor on the Paid plan
  app.fetchMock.calls.length = 0;
  await finish(app, app.ctx.runRefreshQueue(false));
  assert.equal(app.ppt().length, 1, 'the slab was asked');
  assert.equal(app.row('s1', 'slabs').marketPrice, '101');
  assert.deepEqual(plain(app.saved().dayCreditsUsed), { [DAY]: 36 });
  assert.equal(app.saved().creditsPausedDate, null);
});

test('plan change: a refusal the vendor gives after the change still pauses the day in a pass, the change clears only what came before it', async () => {
  const app = await setup({ singles: [enRow('b', 'Raichu 26')], slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] });
  app.saveQueue({ dayCreditsUsed: { [DAY]: 30 } }); // credits left, no pause
  app.tcgHooks[1] = () => { app.mid = app.ctx.kjrPptSetPlan('paid'); }; // on the free lane, before the PPT batch
  app.refuseAt = 1; // the first slab, asked after the change, is refused
  await finish(app, app.ctx.runRefreshQueue(false));
  assert.equal(app.mid, true);
  assert.equal(app.ppt().length, 1, 'asked once, the refusal stops the batch');
  assert.equal(app.saved().creditsPausedDate, DAY, 'the refusal after the change is the day\'s pause');
  assert.equal(app.saved().cursor, 0, 'the refused slab stays where it was');
  assert.equal(app.row('s1', 'slabs').marketPrice, '');
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), DAY), 0, 'nothing more is asked today');
  assert.equal(app.ctx.kjrPptPlan(), 'paid', 'and the plan stays Paid');
});

// ── the bulk run ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('plan change: during a bulk run that holds the paused queue, the PPT rows after the change are asked, not stopped at the old pause', async () => {
  const app = await setup({ singles: [enRow('e1', 'Raichu 26'), enRow('e2', 'Pidgey 27'), jaRow('j1', 1), jaRow('j2', 2)] });
  app.saveQueue({ dayCreditsUsed: { [DAY]: 10 }, creditsPausedDate: DAY }); // the vendor refused earlier today
  app.tcgHooks[2] = () => { // the run is on its second free row when the owner upgrades
    const ok = app.ctx.kjrPptSetPlan('paid');
    app.mid = { ok, plan: app.ctx.kjrPptPlan(), stored: app.saved().creditsPausedDate, bulk: app.ctx._bulkRefreshRunning };
  };
  await finish(app, app.ctx.bulkRefreshPrices('singles'));
  assert.deepEqual(app.mid, { ok: true, plan: 'paid', stored: null, bulk: true }, 'under the run: the plan is saved and the pause is gone from storage');
  assert.equal(app.row('e1').marketPrice, '8');
  assert.equal(app.row('e2').marketPrice, '9');
  assert.equal(app.ppt().length, 2, 'both Japanese singles were asked after the change');
  assert.equal(app.row('j1').marketPrice, '3');
  assert.equal(app.row('j2').marketPrice, '3');
  assert.deepEqual(plain(app.saved().dayCreditsUsed), { [DAY]: 16 }, 'two searches at 3 credits, billed on the day');
  assert.equal(app.saved().creditsPausedDate, null, 'the run\'s saves did not put the old pause back');
  assert.equal(doneToast(app), 'Done: 4 updated', JSON.stringify(app.toasts));
});

test('plan change: a refusal the vendor gives after the change still pauses the day and stops the bulk run, as a refusal always did', async () => {
  const app = await setup({ singles: [enRow('e1', 'Raichu 26'), enRow('e2', 'Pidgey 27'), jaRow('j1', 1), jaRow('j2', 2)] });
  app.saveQueue({ dayCreditsUsed: { [DAY]: 10 }, creditsPausedDate: DAY });
  app.tcgHooks[2] = () => { app.mid = app.ctx.kjrPptSetPlan('paid'); };
  app.refuseAt = 1; // the first request after the change is refused for credits
  await finish(app, app.ctx.bulkRefreshPrices('singles'));
  assert.equal(app.mid, true);
  assert.equal(app.ppt().length, 1, 'the first Japanese single was asked, the refusal stopped the run there');
  assert.equal(app.row('j1').marketPrice, '', 'neither priced nor marked');
  assert.equal(app.row('j1')._tcgdexMissDate, undefined);
  assert.equal(app.saved().creditsPausedDate, DAY, 'the refusal after the change is the day\'s pause');
  assert.deepEqual(plain(app.saved().dayCreditsUsed), { [DAY]: 10 }, 'a refusal is not billed');
  assert.equal(doneToast(app), 'Done: 2 updated · ⏸ PPT credits are used up for today, they reset at 8am Singapore time (2 not priced)', JSON.stringify(app.toasts));
  assert.equal(app.ctx.kjrPptPlan(), 'paid', 'and the plan stays Paid');
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), DAY), 0, 'so the queue asks nothing more today');
});

// ── the two states that hold no copy ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('plan change: while the bulk question is open nothing holds the queue, the yes starts on the saved queue with no pause and the Paid budget', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] });
  app.saveQueue({ dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: DAY });
  const asks = [];
  app.ctx.kjrConfirm = (msg) => new Promise((resolve) => asks.push({ msg: String(msg), resolve }));
  const run = app.ctx.bulkRefreshPrices('slabs');
  assert.equal(app.ctx._kjrBulkAsking, true);
  assert.match(asks[0].msg, /0 of 90 left on the Free plan/, 'the question was worded on the paused Free day');
  assert.equal(app.ctx.kjrPptSetPlan('paid'), true, 'the plan is saved under the question');
  assert.equal(app.saved().creditsPausedDate, null);
  asks[0].resolve(true);
  await finish(app, run);
  assert.equal(app.ppt().length, 2, 'the run read the queue after the yes: no pause, the Paid plan\'s budget');
  assert.equal(app.row('s2', 'slabs').marketPrice, '102');
  assert.deepEqual(plain(app.saved().dayCreditsUsed), { [DAY]: 42 });
  assert.equal(app.saved().creditsPausedDate, null);
  assert.equal(doneToast(app), 'Done: 2 updated', JSON.stringify(app.toasts));
});

test('plan change: a lookup in flight holds no queue, its end does not put the pause back, and a refusal it gets after the change still pauses', async () => {
  // under the pause the lookup is planned TCGdex only and bills nothing, and the pause it was planned under is still gone when it ends
  const a = await setup({ singles: [enRow('b', 'Raichu 26')], slabs: [slabRow('s1', 'Alpha 1')] });
  a.saveQueue({ dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: DAY });
  a.tcgHooks[1] = () => { a.mid = a.ctx.kjrPptSetPlan('paid'); };
  const look = await finish(a, a.ctx.kjrBudgetedLookup({ name: 'Raichu 26', grader: null, grade: null, language: null }));
  assert.equal(a.mid, true);
  assert.equal(look.refusal && look.refusal.why, 'paused', 'planned under the pause');
  assert.equal(look.r.maxSgd, 8, 'TCGdex answered');
  assert.equal(a.ppt().length, 0);
  assert.equal(a.saved().creditsPausedDate, null, 'and the lookup\'s end did not put the pause back');
  // with credits to spend the lookup reaches the vendor, and the refusal that comes back after the change pauses the day
  const b = await setup({ singles: [enRow('b', 'Raichu 26')], slabs: [slabRow('s1', 'Alpha 1')] });
  b.saveQueue({ dayCreditsUsed: { [DAY]: 30 } });
  b.pptHooks[1] = () => { b.mid = b.ctx.kjrPptSetPlan('paid'); };
  b.refuseAt = 1;
  const look2 = await finish(b, b.ctx.kjrBudgetedLookup({ name: 'Nothing 99', grader: null, grade: null, language: null })); // TCGdex has no card 99, so the vendor is asked
  assert.equal(b.mid, true);
  assert.equal(look2.refusal, null);
  assert.equal(look2.r.creditsExhausted, true);
  assert.equal(b.ppt().length, 1);
  assert.equal(b.saved().creditsPausedDate, DAY, 'the refusal after the change is the day\'s pause');
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('plan change: kjrPptSetPlan clears the held copy in the same step, and the pass and the bulk run hold and release it with their flags', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const body = (name) => {
    const at = src.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name);
    return src.slice(at, at + 10 + src.slice(at + 10).search(/\n(?:async )?function /));
  };
  assert.match(src, /^let _kjrHeldQueue = null;$/m, 'one in-memory reference, nothing is saved for it');
  assert.match(body('kjrPptSetPlan'), /if \(q && q\.creditsPausedDate\) \{ q\.creditsPausedDate = null; saveQueue\(q\); \}\s*if \(_kjrHeldQueue && _kjrHeldQueue\.creditsPausedDate\) _kjrHeldQueue\.creditsPausedDate = null;\s*return true;/, 'the saved queue and the held copy, nothing awaits between them');
  const run = body('runRefreshQueue');
  assert.equal((run.match(/_queueRunning = true;/g) || []).length, 3, 'the three places a pass starts');
  assert.equal((run.match(/_queueRunning = true;\s*_kjrHeldQueue = q;/g) || []).length, 3, 'each holds the queue where the flag goes up');
  assert.equal((run.match(/finally \{\s*_queueRunning = false;\s*_kjrHeldQueue = null;/g) || []).length, 3, 'and releases it where the flag comes down, whatever happened to the pass');
  const bulk = body('bulkRefreshPrices');
  assert.match(bulk, /_kjrAdoptCredits\(q\);\s*\}\s*_kjrHeldQueue = q;/, 'the bulk run holds the queue once it has loaded or built it (null when it prices free rows alone)');
  assert.match(bulk, /\} finally \{\s*_bulkRefreshRunning = false;\s*_kjrAutoRunResume\(\);[^\n]*\n\s*_kjrHeldQueue = null;/, 'and releases it in the finally, after the flag and the hand-back the auto run suite pins');
  assert.equal((src.match(/_kjrHeldQueue = /g) || []).length, 9, 'the declaration, three holds and three releases in runRefreshQueue, one of each in bulkRefreshPrices, and nothing else writes it');
});
