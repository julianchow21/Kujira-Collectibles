'use strict';
// v3.98, the refresh queue's lock across tabs. The guards of v3.94 to v3.96 (_kjrQueueEditBlocker, _kjrHeldQueue, _kjrBulkBlocked) live in one tab's memory, so a second
// tab open on the app could start its own pass, rebuild or clear the queue, or clear the pause, while the first ran a pass or a bulk run, and each wrote its copy back over
// the other's. Now one named Web Lock (kjr-refresh-queue) covers the saved queue. Here two app instances share one localStorage and one fake navigator.locks, as two tabs
// share them in a browser:
//   - the tab running a pass or a bulk run holds the lock for the whole run, and lets it go however the run ends, a throw included
//   - the other tab refuses a pass, a bulk run, Rebuild Queue and Clear with a toast, its automatic run stands down quietly, and the plan change keeps the pause
//   - nothing in the refused tab writes the saved queue, the date key or the credits side record, and it asks no vendor
//   - a tab that holds the lock runs a nested call at once (Web Locks are not re-entrant), and with no navigator.locks every task runs at once, as before v3.98
// v3.99 adds query() to the fake, as the browser has it, and the peek the app makes with it (_kjrQueueLockBusyElsewhere):
//   - a hand lookup and a card's Refresh price in the other tab ask PPT nothing and bill nothing while the lock is held, and say so with the busy words
//   - Rebuild Queue and Clear in the other tab refuse before their question, and still refuse after the yes when the lock was taken while the question was open
//   - every refusal of the queue is the warning look (toastWarn), not the tick
//   - a plan change with the lock granted redraws the queue's panel once the pause is cleared, so the panel does not still show it
//   - with no query() (or no navigator.locks at all) nothing is peeked at and nothing waits on a peek, as before v3.99
// v4.0 closes the two loose ends v3.99 left:
//   - the bulk refresh peeks too: while another tab holds the lock it is refused before its question (nothing is asked, no flag is raised, the auto run is held back from
//     nothing), with the lock free it asks as ever, and the check under the lock after the yes stays. The in-memory looks are read after the peek, never before it
//   - a plan change chosen in the plan dialog (kjrPptPlanChoose) draws one toast: the warning when another tab holds the lock and a pause stays, else the tick, drawn once
//     the pause is cleared. It used to draw the tick at once and the warning a moment later. With no navigator.locks, or with this tab holding the lock, the tick is still at once
// Fetch is stubbed (tests/harness.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, createLocalStorage, jsonResponse, plain, ROOT } = require('./harness.js');
const { setClock } = require('./clock.js');

// Every test here has a deadline: a held call that is never let go would hang the file, and a hung test fails the run, it does not stall it
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
const LOCK = 'kjr-refresh-queue';
const BUSY = 'Another tab is refreshing prices. Try again when it has finished';
const QUEUE_KEY = 'pokeinv_refresh_queue';
const DATE_KEY = 'pokeinv_refresh_queue_date';
const STASH_KEY = 'pokeinv_refresh_queue_credits';
const DAY = '2026-10-25';
const AT = '2026-10-25T04:00:00Z';
const slabRow = (id, name) => ({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 500, marketPrice: '', priceHistory: [] });
const SEED = { singles: [], slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] };

// A Web Locks manager as the browser keeps one per origin: exclusive locks by name, a request that can not be granted waits its turn, one with ifAvailable is
// answered at once with null. The callback's promise settling lets the lock go, whether it resolved or threw. Every request is logged. query() answers a step later
// with the locks held now, as the browser's does (a snapshot, so it can be out of date once read), and is counted in queries.
function fakeLocks() {
  const held = new Set();
  const waiting = new Map();
  const log = [];
  const grant = (name, cb) => {
    held.add(name);
    return Promise.resolve().then(() => cb({ name, mode: 'exclusive' })).finally(() => {
      held.delete(name);
      const next = (waiting.get(name) || []).shift();
      if (next) next();
    });
  };
  const queries = [];
  return {
    held, log, queries,
    query() {
      const snap = { held: [...held].map((name) => ({ name, mode: 'exclusive', clientId: 'some-tab' })), pending: [] };
      queries.push(snap);
      return Promise.resolve().then(() => snap);
    },
    request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      log.push({ name, ifAvailable: !!(opts && opts.ifAvailable) });
      if (!held.has(name)) return grant(name, cb);
      if (opts && opts.ifAvailable) return Promise.resolve().then(() => cb(null));
      return new Promise((resolve, reject) => {
        if (!waiting.has(name)) waiting.set(name, []);
        waiting.get(name).push(() => grant(name, cb).then(resolve, reject));
      });
    },
  };
}

// One tab. storage and locks are shared between the tabs of a test, everything else (DB in memory, toasts, timers, fetch) is the tab's own
async function tab(shared, opts) {
  const app = await loadApp(Object.assign({ seed: SEED, storage: shared.storage }, shared.locks ? { locks: shared.locks } : {}, opts || {}));
  app.clock = setClock(app, AT);
  app.toasts = [];
  app.looks = []; // the variant each toast asked for: 'tick' for a plain one, else toast()'s third place ('warn', 'info')
  app.ctx.toast = (m, d, kind) => { app.toasts.push(String(m)); app.looks.push(kind === undefined || kind === false ? 'tick' : kind); };
  app.ctx.toastError = (m) => { app.toasts.push('ERR ' + String(m)); app.looks.push('error'); };
  app.asked = 0; // questions put to the owner
  app.ctx.kjrConfirm = async () => { app.asked++; return true; };
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  // While app.hold() is on, every PPT answer waits for app.letGo()
  app.holding = null;
  app.fetchMock.route('/ppt/cards', async (url) => {
    if (app.holding) await app.holding.promise;
    const m = /^(.+) (\d+)$/.exec(new URL(url).searchParams.get('search') || '');
    const card = m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
    return jsonResponse({ data: card ? [card] : [], metadata: { apiCallsConsumed: { total: 6 } } });
  });
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), async () => jsonResponse({}, 404));
  app.hold = () => { let go; const promise = new Promise((r) => { go = r; }); app.holding = { promise, go }; };
  app.letGo = () => { const h = app.holding; app.holding = null; if (h) h.go(); };
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  return app;
}
async function twoTabs() {
  const shared = { storage: createLocalStorage(), locks: fakeLocks() };
  const a = await tab(shared);
  const b = await tab(shared);
  return { shared, a, b };
}
const savedQueue = (shared, patch, app) => {
  const q = plain(app.ctx.buildRefreshQueue());
  Object.assign(q, patch || {});
  shared.storage.setItem(QUEUE_KEY, JSON.stringify(q));
  return q;
};
// everything a write of the queue can touch, byte for byte
const snapshot = (shared) => ({ queue: shared.storage.getItem(QUEUE_KEY), date: shared.storage.getItem(DATE_KEY), stash: shared.storage.getItem(STASH_KEY) });
const tick = async (n) => { for (let i = 0; i < (n || 10); i++) await new Promise((r) => setImmediate(r)); };
// let a held run go as far as it can, firing the waits it makes, until the test's condition holds
async function until(app, cond) {
  for (let i = 0; i < 400 && !cond(); i++) {
    await new Promise((r) => setImmediate(r));
    app.timers.flush((e) => [6000, 1100, 250, 2000].includes(e.delay));
  }
  assert.ok(cond(), 'the state was reached');
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

// What tab A can be doing while it holds the lock: each starts for real, and its end function lets it finish for real
const HOLDERS = {
  'a bulk run': async (a) => {
    a.hold();
    const run = a.ctx.bulkRefreshPrices('slabs');
    await until(a, () => a.ppt().length >= 1);
    assert.equal(a.ctx._bulkRefreshRunning, true);
    return async () => { a.letGo(); await finish(a, run); };
  },
  'a pass': async (a) => {
    a.hold();
    const pass = a.ctx.runRefreshQueue(true);
    await until(a, () => a.ppt().length >= 1);
    assert.equal(a.ctx._queueRunning, true);
    return async () => { a.letGo(); await finish(a, pass); };
  },
};

for (const [what, start] of Object.entries(HOLDERS)) {
  test('queue lock: while one tab runs ' + what + ', the other refuses every run and every edit of the queue, writes nothing and asks no vendor', async () => {
    const { shared, a, b } = await twoTabs();
    savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: null }, a);
    const end = await start(a);
    assert.ok(shared.locks.held.has(LOCK), 'tab A holds the queue\'s lock for its run');
    assert.equal(a.ctx._kjrQueueLockHeld, true, 'and knows it does');
    assert.equal(b.ctx._kjrQueueLockHeld, false, 'tab B does not');
    const snap = snapshot(shared);

    // a pass asked for by hand
    b.toasts.length = 0;
    await b.ctx.runRefreshQueue(true);
    assert.deepEqual(b.toasts, [BUSY]);
    assert.equal(b.ctx._queueRunning, false, 'no pass started in tab B');
    // the automatic run stands down quietly
    b.toasts.length = 0;
    await b.ctx.runRefreshQueue(false);
    assert.deepEqual(b.toasts, [], 'the automatic call says nothing');
    // Rebuild Queue, refused before the question (v3.99, the peek)
    b.asked = 0;
    await b.ctx.startFreshQueue();
    assert.deepEqual(b.toasts, ['Nothing was rebuilt. ' + BUSY]);
    // Clear, refused before the question as well
    b.toasts.length = 0;
    await b.ctx.clearQueueAsk();
    assert.deepEqual(b.toasts, ['Nothing was cleared. ' + BUSY]);
    assert.equal(b.asked, 0, 'neither asked the owner a question it would only refuse');
    // a bulk run (v4.0, the peek): refused before the question too, no flag raised, and the toast says nothing was refreshed
    b.toasts.length = 0;
    await finish(b, b.ctx.bulkRefreshPrices('slabs'));
    assert.deepEqual(b.toasts, ['Nothing was refreshed. ' + BUSY]);
    assert.equal(b.asked, 0, 'the bulk refresh did not ask the owner a question it would only refuse either');
    assert.equal(b.ctx._kjrBulkAsking, false);
    assert.equal(b.ctx._bulkRefreshRunning, false);
    assert.equal(b.ctx._kjrHeldQueue, null);
    // a hand lookup (v3.99): the peek finds the lock held, so PPT is not asked and nothing is billed, the TCGdex lane is free and still answers
    const look = await b.ctx.kjrBudgetedLookup({ name: 'Alpha 1', grader: null, grade: null, language: null }); // a plain name lookup, as searchEbay asks
    assert.deepEqual(plain(look.refusal), { why: 'running', elsewhere: true });
    assert.equal(look.billed, null, 'nothing billed, nothing was spent');
    assert.equal(b.ctx._kjrLookupsOpen, 0, 'and the lookup is no longer counted in flight');
    // a card's Refresh price on a slab: refused before the request, the card left as it was, and the busy words in the warning look
    b.toasts.length = 0; b.looks.length = 0;
    const row = JSON.stringify(b.ctx.DB.slabs.find((r) => r.id === 's1'));
    await b.ctx.refreshPrice('s1', 'slabs');
    assert.deepEqual(b.toasts, ['PokemonPriceTracker was not asked because another tab is refreshing prices. Try again when it has finished. Nothing was changed.']);
    assert.ok(b.toasts[0].includes(BUSY.charAt(0).toLowerCase() + BUSY.slice(1)), 'the busy message\'s own words');
    assert.deepEqual(b.looks, ['warn']);
    assert.equal(JSON.stringify(b.ctx.DB.slabs.find((r) => r.id === 's1')), row, 'the card is as it was');
    assert.equal(b.ctx._kjrLookupsOpen, 0);
    // every refusal above is the warning look, not the tick (the automatic call said nothing at all)
    b.toasts.length = 0; b.looks.length = 0;
    await b.ctx.runRefreshQueue(true);
    await b.ctx.startFreshQueue();
    await b.ctx.clearQueueAsk();
    await finish(b, b.ctx.bulkRefreshPrices('slabs'));
    assert.deepEqual(b.looks, ['warn', 'warn', 'warn', 'warn'], JSON.stringify(b.toasts));
    assert.ok(shared.locks.queries.length > 0, 'tab B peeked');

    assert.equal(b.ppt().length, 0, 'tab B asked the vendor nothing');
    assert.deepEqual(snapshot(shared), snap, 'the saved queue, the date key and the credits side record are as tab A left them');
    assert.equal(b.ctx._kjrQueueLockHeld, false);
    assert.ok(shared.locks.log.filter((r) => r.name === LOCK).every((r) => r.ifAvailable), 'nothing waits for the queue\'s lock, every request is ifAvailable');

    // tab A ends its run and lets the lock go, and tab B's pass then goes
    await end();
    assert.equal(shared.locks.held.has(LOCK), false, 'the lock went with the run');
    assert.equal(a.ctx._kjrQueueLockHeld, false);
    // tab B's pass now holds the lock and reads the queue afresh under it, as tab A left it
    const realLoad = b.ctx.loadQueue;
    let readsUnderLock = 0;
    b.ctx.loadQueue = () => { if (b.ctx._kjrQueueLockHeld && shared.locks.held.has(LOCK)) readsUnderLock++; return realLoad(); };
    b.toasts.length = 0;
    await finish(b, b.ctx.runRefreshQueue(true));
    assert.ok(!b.toasts.includes(BUSY), JSON.stringify(b.toasts));
    assert.ok(readsUnderLock > 0, 'tab B\'s pass read the queue under the lock once it was free');
    assert.equal(shared.locks.held.has(LOCK), false, 'and let the lock go at its end');
  });
}

test('queue lock: a plan change in the other tab saves the plan, keeps the pause the running tab holds, and says so', async () => {
  const { shared, a, b } = await twoTabs();
  const utc = new Date(Date.parse(AT)).toISOString().slice(0, 10);
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [utc]: 30 }, creditsPausedDate: null }, a);
  const end = await HOLDERS['a bulk run'](a);
  // the vendor's refusal as tab A's run would have saved it, with tab A still holding the lock
  const paused = () => { const q = JSON.parse(shared.storage.getItem(QUEUE_KEY)); q.creditsPausedDate = utc; shared.storage.setItem(QUEUE_KEY, JSON.stringify(q)); };
  paused();
  b.toasts.length = 0;
  assert.equal(b.ctx.kjrPptSetPlan('paid'), true, 'the plan is the owner\'s setting and is saved');
  await tick();
  assert.equal(b.ctx.kjrPptPlan(), 'paid');
  assert.equal(JSON.parse(shared.storage.getItem(QUEUE_KEY)).creditsPausedDate, utc, 'the pause stays on the saved queue');
  assert.equal(b.toasts.length, 1, JSON.stringify(b.toasts));
  assert.match(b.toasts[0], /^The plan is saved, but today's credits pause stays while another tab is refreshing prices\. /);
  assert.deepEqual(b.looks, ['warn'], 'a note that the pause stays is a not done, not the tick (v3.99)');
  await end();
  // with the lock free the same change clears the pause under the lock, and says nothing more
  paused();
  b.toasts.length = 0;
  assert.equal(b.ctx.kjrPptSetPlan('free'), true);
  await tick();
  assert.deepEqual(b.toasts, []);
  assert.equal(JSON.parse(shared.storage.getItem(QUEUE_KEY)).creditsPausedDate, null);
});

test('queue lock: a plan change with no pause to clear says nothing while the other tab holds the lock', async () => {
  const { shared, a, b } = await twoTabs();
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: {}, creditsPausedDate: null }, a);
  const end = await HOLDERS['a pass'](a);
  b.toasts.length = 0;
  assert.equal(b.ctx.kjrPptSetPlan('paid'), true);
  await tick();
  assert.deepEqual(b.toasts, []);
  await end();
});

test('queue lock: a run that throws lets the lock go, clears the tab\'s flag, and the next run gets the lock', async () => {
  const { shared, a, b } = await twoTabs();
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: {} }, a);
  a.ctx._runRefreshQueueBody = async () => {
    assert.ok(shared.locks.held.has(LOCK), 'the body runs under the lock');
    throw new Error('boom');
  };
  await assert.rejects(a.ctx.runRefreshQueue(true), /boom/);
  assert.equal(shared.locks.held.has(LOCK), false, 'the lock went with the throw');
  assert.equal(a.ctx._kjrQueueLockHeld, false, 'and the tab no longer thinks it holds it');
  assert.equal(a.ctx._queueRunning, false);
  // the helper itself: the throw reaches the caller, onBusy is not called, and the lock is free again for the other tab
  let busy = 0;
  await assert.rejects(b.ctx._kjrWithQueueLock(() => { throw new Error('sync boom'); }, () => { busy++; }), /sync boom/);
  await assert.rejects(b.ctx._kjrWithQueueLock(async () => { await tick(1); throw new Error('async boom'); }, () => { busy++; }), /async boom/);
  assert.equal(busy, 0, 'a throw is not a refusal');
  assert.equal(shared.locks.held.has(LOCK), false);
  assert.equal(await b.ctx._kjrWithQueueLock(() => 'ran', () => 'busy'), 'ran', 'the next task gets the lock');
  // and an early return lets it go as well (the pass with no inventory returns before it holds the queue)
  const empty = await tab(shared, { seed: { singles: [], slabs: [] } });
  shared.storage.removeItem(QUEUE_KEY);
  empty.toasts.length = 0;
  await empty.ctx.runRefreshQueue(true);
  assert.ok(empty.toasts.some((t) => /^No inventory yet/.test(t)), JSON.stringify(empty.toasts));
  assert.equal(shared.locks.held.has(LOCK), false, 'an early return lets the lock go');
});

test('queue lock: a tab that holds the lock runs a nested call at once and asks for no second lock', async () => {
  const { shared, a } = await twoTabs();
  const seen = [];
  const out = await a.ctx._kjrWithQueueLock(async () => {
    const before = shared.locks.log.length;
    let inner = false;
    const p = a.ctx._kjrWithQueueLock(() => { inner = true; return 'inner'; }, () => 'busy');
    seen.push(inner); // ran in the same step, not after a request
    seen.push(await p);
    seen.push(shared.locks.log.length - before);
    return 'outer';
  }, () => 'busy');
  assert.equal(out, 'outer');
  assert.deepEqual(seen, [true, 'inner', 0], 'at once, its own answer, and no request of its own');
  assert.equal(a.ctx._kjrQueueLockHeld, false);
});

test('queue lock: with no navigator.locks every task runs at once, as before v3.98, and the queue is written as it was', async () => {
  const shared = { storage: createLocalStorage(), locks: null };
  const app = await tab(shared);
  assert.equal(app.ctx._kjrQueueLocks(), null, 'the API is absent');
  assert.equal(app.ctx._kjrQueueWritable(), true, 'and the tab may write the queue');
  let ran = false;
  const p = app.ctx._kjrWithQueueLock(() => { ran = true; return 7; }, () => 'busy');
  assert.equal(ran, true, 'the task ran in the same step');
  assert.equal(await p, 7);
  await assert.rejects(app.ctx._kjrWithQueueLock(() => { throw new Error('no api boom'); }), /no api boom/, 'a throw still reaches the caller as a rejection');
  assert.equal(app.ctx._kjrQueueLockHeld, false, 'the flag is only for a lock really held');
  // a queue of an older schema is dropped by any reader, as it always was
  shared.storage.setItem(QUEUE_KEY, JSON.stringify({ schemaVersion: 1, dayCreditsUsed: { [DAY]: 12 } }));
  assert.equal(app.ctx.loadQueue(), null);
  assert.equal(shared.storage.getItem(QUEUE_KEY), null, 'dropped');
  // Rebuild and Clear go ahead
  await app.ctx.startFreshQueue();
  assert.ok(app.toasts.some((t) => /^Queue built: /.test(t)), JSON.stringify(app.toasts));
  assert.ok(shared.storage.getItem(QUEUE_KEY));
  await app.ctx.clearQueueAsk();
  assert.equal(shared.storage.getItem(QUEUE_KEY), null, 'cleared');
});

test('queue lock: a request the browser fails runs the task without the lock, and says so in the console', async () => {
  // only the queue's lock fails, the app's other locks (cloud rows, the inventory cache) are granted as usual
  const failing = (fail) => { const real = fakeLocks(); return { request: (name, opts, cb) => name === LOCK ? fail() : real.request(name, opts, cb) }; };
  const app = await tab({ storage: createLocalStorage(), locks: failing(() => { throw new Error('SecurityError'); }) });
  let ran = 0;
  assert.equal(await app.ctx._kjrWithQueueLock(() => { ran++; return 'ran'; }, () => 'busy'), 'ran');
  const rejecting = await tab({ storage: createLocalStorage(), locks: failing(() => Promise.reject(new Error('InvalidStateError'))) });
  assert.equal(await rejecting.ctx._kjrWithQueueLock(() => { ran++; return 'ran'; }, () => 'busy'), 'ran');
  assert.equal(ran, 2);
  assert.ok(app.consoleWarnings.concat(rejecting.consoleWarnings).filter((w) => /queue lock could not be asked for/.test(JSON.stringify(w))).length >= 2, JSON.stringify(app.consoleWarnings));
});

test('queue lock: a queue of an older schema is left alone by a tab without the lock and dropped by the one that holds it', async () => {
  const { shared, a, b } = await twoTabs();
  const stale = JSON.stringify({ schemaVersion: 1, creditsVersion: 1, dayCreditsUsed: { [DAY]: 12 } });
  shared.storage.setItem(QUEUE_KEY, stale);
  assert.equal(b.ctx.loadQueue(), null, 'read as no queue');
  assert.equal(shared.storage.getItem(QUEUE_KEY), stale, 'and left as it was');
  assert.ok(JSON.parse(shared.storage.getItem(STASH_KEY)).dayCreditsUsed[DAY] === 12, 'its credits are still kept aside, so a budget read counts them');
  await a.ctx._kjrWithQueueLock(() => { assert.equal(a.ctx.loadQueue(), null); });
  assert.equal(shared.storage.getItem(QUEUE_KEY), null, 'the holder drops it');
});

// ── v3.99: the peek, the after-yes check, the plan change's redraw and the fallback ────────────────────────────────────────────────────────

// a question held open until the test answers it
const heldQuestions = (app) => {
  app.asks = [];
  app.ctx.kjrConfirm = (msg) => new Promise((resolve) => app.asks.push({ msg: String(msg), resolve }));
};

for (const edit of ['rebuild', 'clear']) {
  test('queue lock: a ' + edit + ' whose question is open when the other tab takes the lock is refused after the yes, the peek before the question can not stand in for that', async () => {
    const { shared, a, b } = await twoTabs();
    savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 } }, a);
    heldQuestions(b);
    const asking = edit === 'rebuild' ? b.ctx.startFreshQueue() : b.ctx.clearQueueAsk();
    await tick();
    assert.equal(b.asks.length, 1, 'the lock was free at the peek, so the owner is asked');
    const end = await HOLDERS['a bulk run'](a); // tab A takes the lock while the question is open
    const snap = snapshot(shared);
    b.toasts.length = 0; b.looks.length = 0;
    b.asks[0].resolve(true);
    await asking;
    assert.deepEqual(b.toasts, [(edit === 'rebuild' ? 'Nothing was rebuilt. ' : 'Nothing was cleared. ') + BUSY]);
    assert.deepEqual(b.looks, ['warn']);
    assert.deepEqual(snapshot(shared), snap, 'nothing was written');
    await end();
  });
}

test('queue lock: with the lock free the peek finds nothing, a lookup asks PPT and bills the day, and a rebuild and a clear go ahead', async () => {
  const { shared, a, b } = await twoTabs();
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 } }, a);
  assert.equal(await b.ctx._kjrQueueLockBusyElsewhere(), false);
  assert.equal(await b.ctx.kjrLookupRefusal(), null);
  const look = await b.ctx.kjrBudgetedLookup({ name: 'Alpha 1', grader: null, grade: null, language: null });
  assert.equal(look.refusal, null);
  assert.ok(b.ppt().length >= 1, 'PPT was asked');
  assert.ok(look.billed && look.billed.used > 30, 'and the bill landed on the saved queue');
  assert.equal(shared.locks.log.filter((r) => r.name === LOCK).length, 0, 'a lookup only looks at the lock, it never asks for it');
  b.toasts.length = 0;
  await b.ctx.startFreshQueue();
  assert.ok(b.toasts.some((t) => /^Queue built: /.test(t)), JSON.stringify(b.toasts));
  await b.ctx.clearQueueAsk();
  assert.equal(shared.storage.getItem(QUEUE_KEY), null, 'cleared');
  assert.equal(b.asked, 2, 'each asked its question');
  // a lock this tab holds is its own: the peek makes no look and lets the in-memory guards speak
  await b.ctx._kjrWithQueueLock(() => { assert.equal(b.ctx._kjrQueueLockBusyElsewhere(), null); });
});

test('queue lock: a plan change with the lock granted clears the pause and the queue\'s panel is drawn again without it', async () => {
  const { shared, a, b } = await twoTabs();
  const utc = new Date(Date.parse(AT)).toISOString().slice(0, 10);
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [utc]: 30 }, creditsPausedDate: utc }, a);
  const panel = b.document.getElementById('queue-status-panel');
  const PAUSE = /PokemonPriceTracker says today's credits are used up\./;
  b.ctx._renderQueueStatus();
  assert.match(panel.innerHTML, PAUSE, 'the panel shows the pause to begin with');
  b.ctx.kjrPptPlanChoose('paid');
  assert.equal(b.ctx.kjrPptPlan(), 'paid', 'the plan is saved at once');
  assert.match(panel.innerHTML, PAUSE, 'the draw made at once still shows it: the lock is granted a step later, and the pause is cleared under it');
  await tick();
  assert.equal(JSON.parse(shared.storage.getItem(QUEUE_KEY)).creditsPausedDate, null, 'cleared under the lock');
  assert.equal(shared.locks.held.has(LOCK), false, 'and the lock let go');
  assert.doesNotMatch(panel.innerHTML, PAUSE, 'the panel was drawn again once the clear had landed');
  assert.match(panel.innerHTML, /Queue built 25\/10\/2026 ·/, 'with the queue\'s date as DD/MM/YYYY');
  // kjrPptSetPlan still answers at once, and its onSettled comes once the clear has landed, refused or not
  let settled = 0;
  assert.equal(b.ctx.kjrPptSetPlan('free', () => { settled++; }), true);
  assert.equal(settled, 0, 'not in the same step');
  await tick();
  assert.equal(settled, 1);
  const end = await HOLDERS['a pass'](a);
  assert.equal(b.ctx.kjrPptSetPlan('paid', () => { settled++; }), true);
  await tick();
  assert.equal(settled, 2, 'and when the other tab held the lock');
  await end();
});

test('queue lock: with no query() or no navigator.locks nothing is peeked at and nothing waits on a peek, as before v3.99', async () => {
  // request() alone, shared by two tabs: the v3.98 lock still guards every write, the lookup is not turned away by it
  const real = fakeLocks();
  const shared = { storage: createLocalStorage(), locks: { held: real.held, log: real.log, request: real.request } };
  const a = await tab(shared);
  const b = await tab(shared);
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 } }, a);
  const end = await HOLDERS['a bulk run'](a);
  assert.equal(b.ctx._kjrQueueLockBusyElsewhere(), null, 'no look to make');
  assert.equal(await b.ctx.kjrLookupRefusal(), null, 'the lookup is not turned away by a lock it can not see, as in v3.98');
  // the question comes in the same step, as before v3.99, and the lock still refuses the rebuild after the yes
  heldQuestions(b);
  const asking = b.ctx.startFreshQueue();
  assert.equal(b.asks.length, 1, 'asked in the same step');
  b.toasts.length = 0;
  b.asks[0].resolve(true);
  await asking;
  assert.deepEqual(b.toasts, ['Nothing was rebuilt. ' + BUSY]);
  // the bulk refresh too (v4.0): its question comes in the same step, and the lock still refuses the run after the yes
  b.toasts.length = 0;
  const bulking = b.ctx.bulkRefreshPrices('slabs');
  assert.equal(b.asks.length, 2, 'the bulk refresh asked in the same step as well');
  b.asks[1].resolve(true);
  await finish(b, bulking);
  assert.deepEqual(b.toasts, ['Nothing was refreshed. ' + BUSY]);
  await end();
  // no navigator.locks at all: the same, and the lookup, the clear and the bulk refresh go ahead
  const none = await tab({ storage: createLocalStorage(), locks: null });
  assert.equal(none.ctx._kjrQueueLockBusyElsewhere(), null);
  heldQuestions(none);
  const clearing = none.ctx.clearQueueAsk();
  assert.equal(none.asks.length, 1, 'asked in the same step');
  none.asks[0].resolve(false);
  await clearing;
  const noneBulk = none.ctx.bulkRefreshPrices('slabs');
  assert.equal(none.asks.length, 2, 'and so does the bulk refresh');
  assert.match(none.asks[1].msg, /^Refresh 2 slabs now\?/);
  none.asks[1].resolve(false);
  await noneBulk;
  assert.equal(none.ctx._kjrBulkAsking, false);
  // a query() that fails is no look either: false, said in the console, and the lookup goes on
  const failing = fakeLocks();
  failing.query = () => Promise.reject(new Error('InvalidStateError'));
  const odd = await tab({ storage: createLocalStorage(), locks: failing });
  assert.equal(await odd.ctx._kjrQueueLockBusyElsewhere(), false);
  assert.equal(await odd.ctx.kjrLookupRefusal(), null);
  assert.ok(odd.consoleWarnings.some((w) => /queue lock could not be looked at/.test(JSON.stringify(w))), JSON.stringify(odd.consoleWarnings));
});

// ── v4.0: the bulk refresh peeks before its question ──────────────────────────────────────────────────────────────────────────────────────

// an English single the free lane takes, so a bulk refresh of Singles has a row to ask about (tab B's TCGdex answers 404 and nothing here needs a price)
const SINGLES_SEED = { singles: [{ id: 'e1', name: 'Raichu 26', language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }], slabs: SEED.slabs };

for (const [what, start] of Object.entries(HOLDERS)) {
  for (const table of ['singles', 'slabs']) {
    test('queue lock: while one tab runs ' + what + ', a bulk refresh of ' + table + ' in the other tab is refused before its question, asks nothing and holds nothing back', async () => {
      const shared = { storage: createLocalStorage(), locks: fakeLocks() };
      const a = await tab(shared);
      const b = await tab(shared, { seed: SINGLES_SEED });
      savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: null }, a);
      const end = await start(a);
      assert.ok(shared.locks.held.has(LOCK), 'tab A holds the queue\'s lock');
      const snap = snapshot(shared);
      const requests = shared.locks.log.length, peeks = shared.locks.queries.length;
      heldQuestions(b); // a question that is put is held open, so one that is asked cannot slip by unseen, and is seen here rather than hanging the call
      b.toasts.length = 0; b.looks.length = 0;
      const refused = b.ctx.bulkRefreshPrices(table);
      await tick();
      assert.equal(b.asks.length, 0, 'the owner was not asked a question it would only refuse');
      await refused;
      assert.deepEqual(b.toasts, ['Nothing was refreshed. ' + BUSY]);
      assert.deepEqual(b.looks, ['warn'], 'the warning look, not the tick');
      assert.equal(shared.locks.queries.length, peeks + 1, 'it took one look at the lock');
      assert.equal(shared.locks.log.length, requests, 'and asked for no lock: the peek only looks');
      assert.equal(b.ctx._kjrBulkAsking, false, 'no question flag was raised, so nothing is held back');
      assert.equal(b.ctx._bulkRefreshRunning, false);
      assert.equal(b.ctx._kjrHeldQueue, null);
      assert.equal(b.ppt().length, 0, 'the vendor was asked nothing');
      assert.deepEqual(snapshot(shared), snap, 'the saved queue, the date key and the credits side record are as tab A left them');
      // the page-load auto run is not held by it: it does not wait, it goes to the pass, which stands down quietly at the lock
      b.toasts.length = 0;
      b.ctx._kjrAutoRun();
      assert.equal(b.ctx._kjrAutoRunWaiting, false, 'the auto run is not left waiting for a question that was never asked');
      await tick();
      assert.deepEqual(b.toasts, [], 'and it stands down without a word');
      // once tab A has finished the lock is free and the same call asks its question
      await end();
      const again = b.ctx.bulkRefreshPrices(table);
      await tick();
      assert.equal(b.asks.length, 1, 'the question is asked once the lock is free');
      b.asks[0].resolve(false);
      await again;
      assert.equal(b.ctx._kjrBulkAsking, false);
    });
  }
}

test('queue lock: with the lock free a bulk refresh asks its question as before, a no leaves everything alone and a yes runs it under the lock', async () => {
  const { shared, a, b } = await twoTabs();
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 } }, a);
  const snap = snapshot(shared);
  heldQuestions(b);
  b.toasts.length = 0;
  const declined = b.ctx.bulkRefreshPrices('slabs');
  await tick();
  assert.equal(b.asks.length, 1, 'asked');
  assert.match(b.asks[0].msg, /^Refresh 2 slabs now\? 2 use PokemonPriceTracker credits from today's budget \(60 of 90 left on the Free plan\)/);
  assert.equal(b.ctx._kjrBulkAsking, true, 'the question holds the queue back while it is open');
  assert.equal(shared.locks.queries.length, 1, 'after one look at the lock');
  assert.equal(shared.locks.log.filter((r) => r.name === LOCK).length, 0, 'the question takes no lock');
  b.asks[0].resolve(false);
  await declined;
  assert.deepEqual(b.toasts, [], 'a no says nothing');
  assert.equal(b.ctx._kjrBulkAsking, false);
  assert.equal(b.ppt().length, 0, 'nothing was priced');
  assert.equal(shared.locks.log.filter((r) => r.name === LOCK).length, 0, 'and no lock was taken');
  assert.deepEqual(snapshot(shared), snap, 'the saved queue is as it was');
  // a yes: the run goes ahead, holding the lock from its first read of the queue to its last write
  b.toasts.length = 0;
  const run = b.ctx.bulkRefreshPrices('slabs');
  await tick();
  assert.equal(b.asks.length, 2);
  b.asks[1].resolve(true);
  await finish(b, run);
  assert.ok(b.toasts.some((t) => /^Done: 2 updated$/.test(t)), JSON.stringify(b.toasts));
  assert.ok(shared.locks.log.some((r) => r.name === LOCK && r.ifAvailable), 'the run asked for the lock after the yes');
  assert.equal(shared.locks.held.has(LOCK), false, 'and let it go');
  assert.notDeepEqual(snapshot(shared), snap, 'the bill landed on the saved queue');
});

test('queue lock: a bulk refresh whose question is open when the other tab takes the lock is refused after the yes, the peek before the question can not stand in for that', async () => {
  const { shared, a, b } = await twoTabs();
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 } }, a);
  heldQuestions(b);
  const asking = b.ctx.bulkRefreshPrices('slabs');
  await tick();
  assert.equal(b.asks.length, 1, 'the lock was free at the peek, so the owner is asked');
  b.ctx._kjrAutoRun(); // the page-load auto run comes due under the question and waits for the answer
  assert.equal(b.ctx._kjrAutoRunWaiting, true);
  const end = await HOLDERS['a bulk run'](a); // tab A takes the lock while the question is open
  const snap = snapshot(shared);
  b.toasts.length = 0; b.looks.length = 0;
  b.asks[0].resolve(true);
  await finish(b, asking);
  assert.deepEqual(b.toasts, ['Nothing was refreshed. ' + BUSY]);
  assert.deepEqual(b.looks, ['warn']);
  assert.deepEqual(snapshot(shared), snap, 'nothing was written');
  assert.equal(b.ctx._kjrBulkAsking, false);
  assert.equal(b.ctx._bulkRefreshRunning, false);
  assert.equal(b.ctx._kjrHeldQueue, null);
  assert.equal(b.ctx._kjrAutoRunWaiting, false, 'the auto run that waited for the question was handed back by the refusal');
  assert.equal(b.ppt().length, 0, 'the vendor was asked nothing');
  await end();
});

test('queue lock: the bulk refresh peeks first and reads its in-memory guards after the peek, so a second call or a pass that starts while the peek is out is seen', async () => {
  const { b } = await twoTabs();
  heldQuestions(b);
  // a second call made while the first one's peek is out: the first raises the question flag, the second is turned away by it, and one question is open
  b.toasts.length = 0;
  const first = b.ctx.bulkRefreshPrices('slabs');
  const second = b.ctx.bulkRefreshPrices('slabs');
  await tick();
  assert.equal(b.asks.length, 1, 'one question, not two');
  await second;
  assert.deepEqual(b.toasts, ['A bulk refresh is already waiting for your answer - answer it first']);
  b.asks[0].resolve(false);
  await first;
  // a pass of this tab that starts while the peek is out: the guard that sees it is read after the peek, so no question is asked over it
  b.toasts.length = 0;
  const third = b.ctx.bulkRefreshPrices('slabs');
  b.ctx._queueRunning = true;
  await tick();
  b.ctx._queueRunning = false;
  assert.equal(b.asks.length, 1, 'no second question was put over the pass');
  await third;
  assert.deepEqual(b.toasts, ['A refresh pass is already running - wait for it to finish first']);
  assert.equal(b.ctx._kjrBulkAsking, false);
});

// ── v4.0: a plan change draws one toast ───────────────────────────────────────────────────────────────────────────────────────────────────

const PLAN_PAID = 'Price plan: Paid, 18,000 credits a day for the queue';
const PLAN_FREE = 'Price plan: Free, 90 credits a day for the queue';
const PAUSE_WORDS = /^The plan is saved, but today's credits pause stays while another tab is refreshing prices\. Run the queue by hand once it has finished to ask again$/;
// the plan dialog's radios and budget labels, which the stub document does not hold: plain objects the app writes to
function planDialog(app) {
  const radios = ['free', 'paid'].map((value) => ({ value, checked: value === 'free' }));
  const limit = { textContent: '90' }, name = { textContent: 'Free' };
  app.document.querySelectorAll = (sel) => sel === 'input[name="ppt-plan"]' ? radios : sel === '.ppt-limit' ? [limit] : sel === '.ppt-plan-name' ? [name] : [];
  return { radios, limit, name, shows: () => ({ checked: radios.filter((r) => r.checked).map((r) => r.value), limit: limit.textContent, name: name.textContent }) };
}
// the vendor's refusal as the running tab would have saved it, with that tab still holding the lock
const pauseSaved = (shared) => { const q = JSON.parse(shared.storage.getItem(QUEUE_KEY)); q.creditsPausedDate = DAY; shared.storage.setItem(QUEUE_KEY, JSON.stringify(q)); };

for (const [what, start] of Object.entries(HOLDERS)) {
  test('queue lock: a plan change chosen in the dialog while another tab runs ' + what + ' and a pause stays draws one toast, the warning, with no tick ahead of it', async () => {
    const { shared, a, b } = await twoTabs();
    savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: null }, a);
    const end = await start(a);
    pauseSaved(shared);
    const dialog = planDialog(b);
    // every toast with the moment it was drawn: a flash of the tick is a toast too, however short
    const drawn = [];
    const base = b.ctx.toast;
    b.ctx.toast = (...args) => { drawn.push({ words: String(args[0]), look: args[2] === undefined ? 'tick' : args[2], pause: JSON.parse(shared.storage.getItem(QUEUE_KEY)).creditsPausedDate }); return base(...args); };
    b.toasts.length = 0; b.looks.length = 0;
    b.ctx.kjrPptPlanChoose('paid');
    // at once: the plan, the radios and the budget labels, and no toast yet (the outcome is not known)
    assert.equal(b.ctx.kjrPptPlan(), 'paid');
    assert.deepEqual(dialog.shows(), { checked: ['paid'], limit: '18,000', name: 'Paid' });
    assert.deepEqual(drawn, [], 'no tick ahead of the outcome');
    await tick();
    assert.equal(drawn.length, 1, 'one toast in all: ' + JSON.stringify(drawn));
    assert.match(drawn[0].words, PAUSE_WORDS);
    assert.equal(drawn[0].look, 'warn');
    assert.equal(drawn[0].pause, DAY, 'the pause does stay');
    assert.ok(!b.toasts.some((t) => /^Price plan: /.test(t)), 'the tick never came');
    assert.deepEqual(dialog.shows(), { checked: ['paid'], limit: '18,000', name: 'Paid' }, 'and the dialog still shows the plan that was chosen');
    assert.equal(JSON.parse(shared.storage.getItem(QUEUE_KEY)).creditsPausedDate, DAY, 'the saved queue keeps the pause the running tab holds');
    await end();
  });
}

test('queue lock: a plan change chosen in the dialog with the lock free draws one toast, the tick, once the pause has been cleared', async () => {
  const { shared, a, b } = await twoTabs();
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: DAY }, a);
  const dialog = planDialog(b);
  const drawn = [];
  const base = b.ctx.toast;
  b.ctx.toast = (...args) => { drawn.push({ words: String(args[0]), look: args[2] === undefined ? 'tick' : args[2], pause: JSON.parse(shared.storage.getItem(QUEUE_KEY)).creditsPausedDate }); return base(...args); };
  b.ctx.kjrPptPlanChoose('paid');
  assert.deepEqual(dialog.shows(), { checked: ['paid'], limit: '18,000', name: 'Paid' }, 'the radios and labels do not wait');
  assert.deepEqual(drawn, [], 'the clear is asked of the lock, the toast follows it');
  await tick();
  assert.deepEqual(drawn, [{ words: PLAN_PAID, look: 'tick', pause: null }], 'one toast, the tick, drawn after the pause was cleared and not before');
  assert.equal(shared.locks.held.has(LOCK), false);
  // and the other way, Free again: one more tick, one toast
  drawn.length = 0;
  b.ctx.kjrPptPlanChoose('free');
  await tick();
  assert.deepEqual(drawn.map((d) => d.words), [PLAN_FREE]);
  assert.deepEqual(dialog.shows(), { checked: ['free'], limit: '90', name: 'Free' });
});

test('queue lock: a plan change chosen in the dialog while another tab holds the lock but no pause stays draws one toast, the tick', async () => {
  const { shared, a, b } = await twoTabs();
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: null }, a);
  const end = await HOLDERS['a pass'](a);
  b.toasts.length = 0; b.looks.length = 0;
  b.ctx.kjrPptPlanChoose('paid');
  assert.deepEqual(b.toasts, [], 'not before the outcome');
  await tick();
  assert.deepEqual(b.toasts, [PLAN_PAID], 'a lock held with no pause to keep is no refusal, so the tick');
  assert.deepEqual(b.looks, ['tick']);
  await end();
});

test('queue lock: with no navigator.locks, or with this tab holding the lock, the plan change draws its tick at once and nothing else, as before', async () => {
  const none = await tab({ storage: createLocalStorage(), locks: null });
  none.toasts.length = 0;
  none.ctx.kjrPptPlanChoose('paid');
  assert.deepEqual(none.toasts, [PLAN_PAID], 'in the same step as the choice');
  await tick();
  assert.deepEqual(none.toasts, [PLAN_PAID], 'and drawn once only');
  // this tab holds the lock: a pass of its own is running, the clear is made at once under it
  const { shared, b } = await twoTabs();
  savedQueue(shared, { creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: DAY }, b);
  b.toasts.length = 0;
  await b.ctx._kjrWithQueueLock(() => {
    b.ctx.kjrPptPlanChoose('paid');
    assert.deepEqual(b.toasts, [PLAN_PAID], 'in the same step as the choice');
    assert.equal(JSON.parse(shared.storage.getItem(QUEUE_KEY)).creditsPausedDate, null, 'with the pause already cleared');
  });
  await tick();
  assert.deepEqual(b.toasts, [PLAN_PAID], 'and drawn once only');
});

test('queue lock: a plan that can not be saved, or is not a plan, says so at once and waits for nothing', async () => {
  const { b } = await twoTabs();
  b.toasts.length = 0;
  b.ctx.kjrPptPlanChoose('platinum');
  assert.deepEqual(b.toasts, ['Could not save the price plan on this device'], 'at once, with the lock free to ask for');
  await tick();
  assert.deepEqual(b.toasts, ['Could not save the price plan on this device'], 'and nothing follows it');
  assert.equal(b.ctx.kjrPptPlan(), 'free');
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('queue lock: one named lock, asked for with ifAvailable, around every read-modify-write of the saved queue', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const body = (name) => {
    const at = src.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name);
    return src.slice(at, at + 10 + src.slice(at + 10).search(/\n(?:async )?function /));
  };
  assert.match(src, /^const KJR_QUEUE_LOCK = 'kjr-refresh-queue';$/m);
  assert.equal((src.match(/KJR_QUEUE_LOCK,/g) || []).length, 1, 'requested in one place');
  const helper = body('_kjrWithQueueLock');
  assert.match(helper, /locks\.request\(KJR_QUEUE_LOCK, \{ mode: 'exclusive', ifAvailable: true \}, async \(lock\) => \{/);
  assert.match(helper, /if \(!locks \|\| _kjrQueueLockHeld\) return now\(\);/, 'no API, or already held: at once');
  assert.match(helper, /_kjrQueueLockHeld = true;\s*try \{ return await task\(\); \} finally \{ _kjrQueueLockHeld = false; \}/, 'the flag comes down however the task ends');
  assert.match(body('_kjrQueueLocks'), /navigator\.locks && typeof navigator\.locks\.request === 'function'/, 'the feature check _withCrossTabRowLocks makes');
  // the pass: the lock comes before the first read of the queue, and the guards are read again once it is held
  const run = body('runRefreshQueue');
  const lockAt = run.indexOf('return _kjrWithQueueLock(async () => {');
  assert.ok(lockAt > 0 && lockAt < run.indexOf('loadQueue()') && lockAt < run.indexOf('saveQueue('), 'every read and write of the pass is inside the lock');
  assert.ok(run.indexOf('if (!manual && _kjrBulkBlocked) return;') < lockAt, 'the in-memory guards are kept, before the lock');
  assert.match(run.slice(lockAt), /^return _kjrWithQueueLock\(async \(\) => \{\s*(?:\/\/[^\n]*\n\s*)*const busyNow = _kjrQueueEditBlocker\(\);\s*if \(busyNow\) \{ if \(manual\) toastWarn\(busyNow\); return; \}/);
  assert.match(run, /\}, \(\) => \{ if \(manual\) toastWarn\(KJR_QUEUE_LOCK_BUSY, 6000\); \}\);\n\}\n/, 'refused quietly when automatic, with the warning toast by hand (v3.99)');
  // the bulk run: the flag goes up, then the lock, then the queue is read
  const bulk = body('bulkRefreshPrices');
  const bulkLock = bulk.indexOf('await _kjrWithQueueLock(async () => {');
  assert.ok(bulk.indexOf('_bulkRefreshRunning = true;') < bulkLock && bulkLock < bulk.indexOf('q = loadQueue();'), 'flag, lock, read');
  assert.match(bulk, /\}, \(\) => \{ lockBusy = true; \}\);\s*\} finally \{/);
  assert.match(bulk, /if \(lockBusy\) \{ toastWarn\('Nothing was refreshed\. ' \+ KJR_QUEUE_LOCK_BUSY, 6000\); return; \}/);
  // Rebuild, Clear and the plan change hold it for their one read and write
  assert.match(body('startFreshQueue'), /await _kjrWithQueueLock\(\(\) => \{[\s\S]*?loadQueue\(\)\);\s*saveQueue\(q\);\s*return q;\s*\}, \(\) => \{ toastWarn\('Nothing was rebuilt\. ' \+ KJR_QUEUE_LOCK_BUSY, 6000\); return null; \}\);/);
  assert.match(body('clearQueueAsk'), /await _kjrWithQueueLock\(clearQueue, /);
  assert.match(body('kjrPptSetPlan'), /_kjrWithQueueLock\(\(\) => \{\s*const q = loadQueue\(\);/);
  // v3.99: the peek is a query() only, it takes no lock, and it is made before the lookups ask PPT and before Rebuild and Clear ask the owner
  const peek = body('_kjrQueueLockBusyElsewhere');
  assert.match(peek, /if \(!locks \|\| typeof locks\.query !== 'function' \|\| _kjrQueueLockHeld\) return null;/, 'no look to make: null, and the caller awaits nothing');
  assert.match(peek, /locks\.query\(\)/);
  assert.doesNotMatch(peek, /locks\.request\(/);
  assert.match(body('kjrLookupRefusal'), /^function kjrLookupRefusal\(need\) \{\s*const peek = _kjrQueueLockBusyElsewhere\(\);\s*if \(peek && await peek\) return \{ why: 'running', elsewhere: true \};\s*if \(_queueRunning \|\| _bulkRefreshRunning\) return \{ why: 'running' \};/, 'the peek first, the in-memory reads after it');
  assert.match(src, /\nasync function kjrLookupRefusal\(need\) \{/);
  assert.match(body('kjrBudgetedLookup'), /_kjrLookupsOpen\+\+;[^\n]*\n\s*try \{\s*const refusal = await kjrLookupRefusal\(\);/, 'counted in flight before it asks');
  const refresh = body('refreshPrice');
  assert.ok(refresh.indexOf('_kjrLookupsOpen++;') < refresh.indexOf('await kjrLookupRefusal('), 'and so is a card refresh');
  // v4.0: the bulk refresh joins Rebuild and Clear
  for (const [fn, words] of [['startFreshQueue', 'Nothing was rebuilt. '], ['clearQueueAsk', 'Nothing was cleared. '], ['bulkRefreshPrices', 'Nothing was refreshed. ']]) {
    const f = body(fn);
    const at = f.indexOf('if (peek && await peek) { toastWarn(\'' + words + '\' + KJR_QUEUE_LOCK_BUSY, 6000); return; }');
    assert.ok(at > 0 && at < f.indexOf('kjrConfirm('), fn + ' peeks before the question');
    assert.ok(f.indexOf('_kjrWithQueueLock(') > f.indexOf('kjrConfirm('), fn + ' and still checks under the lock after the yes');
  }
  // v4.0: the peek is the first thing the bulk refresh does, so its in-memory guards and the flag the question raises come after it, and nothing is awaited from the first guard to the flag
  const bulkTop = bulk.slice(0, bulk.indexOf('let { free, ppt, manual } = _kjrBulkWork(table);'));
  assert.match(bulkTop, /^function bulkRefreshPrices\(table\) \{\s*(?:\/\/[^\n]*\n\s*)*const peek = _kjrQueueLockBusyElsewhere\(\);[^\n]*\n\s*if \(peek && await peek\) \{ toastWarn\('Nothing was refreshed\. ' \+ KJR_QUEUE_LOCK_BUSY, 6000\); return; \}\s*if \(_kjrBulkAsking\) \{/, 'the peek first, then the guards');
  assert.ok(bulk.indexOf('if (peek && await peek)') < bulk.indexOf('if (_kjrBulkAsking)') && bulk.indexOf('if (_kjrBulkAsking)') < bulk.indexOf('const blocked = _kjrBulkBlocker();') && bulk.indexOf('const blocked = _kjrBulkBlocker();') < bulk.indexOf('_kjrBulkAsking = true;'), 'peek, flag guard, blocker, then the flag goes up');
  assert.doesNotMatch(bulk.slice(bulk.indexOf('if (_kjrBulkAsking)'), bulk.indexOf('_kjrBulkAsking = true;')).replace(/\/\/[^\n]*/g, ''), /\bawait\b/, 'and nothing is awaited between the first guard and the flag');
  assert.equal((bulk.match(/_kjrQueueLockBusyElsewhere\(\)/g) || []).length, 1, 'one peek, the check after the yes is the lock itself');
  // v4.0: the plan dialog draws its tick once, at once when the clear runs in the same step (no lock to ask for, or this tab holds it) and else from onSettled unless the clear was refused
  const choose = body('kjrPptPlanChoose');
  assert.match(choose, /const waits = !_kjrQueueWritable\(\);/, 'whether the clear lands in this step is read before the plan is set');
  assert.match(choose, /const ok = kjrPptSetPlan\(plan, \(outcome\) => \{\s*if \(waits && !\(outcome && outcome\.refused\)\) tick\(\);\s*if \(typeof _renderQueueStatus === 'function'\) _renderQueueStatus\(\);\s*\}\);/, 'after the clear: the tick unless it was refused, and the panel drawn again either way');
  assert.match(choose, /if \(!ok\) \{ toast\('Could not save the price plan on this device'\); return; \}\s*if \(!waits\) tick\(\);\s*if \(typeof _renderQueueStatus === 'function'\) _renderQueueStatus\(\);\s*\}\s*$/, 'and at once when nothing is waited for');
  assert.equal((choose.match(/toast\('Price plan: /g) || []).length, 1, 'the tick is worded in one place, so it can only be drawn from the two calls above');
  assert.equal((choose.match(/\btick\(\)/g) || []).length, 2, 'drawn from onSettled or at once, never both: they are told apart by waits');
  // loadQueue drops an old queue only where it may write
  assert.match(body('loadQueue'), /if \(_kjrQueueWritable\(\)\) localStorage\.removeItem\(QUEUE_KEY\);/);
});

test('queue lock: the new toasts are plain British English with no dash bar and no semicolon', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const plan = /toastWarn\('(The plan is saved, but today\\'s credits pause stays[^']*(?:\\'[^']*)*)'/.exec(src);
  assert.ok(plan, 'the plan change\'s toast');
  for (const words of [BUSY, plan[1]]) {
    assert.doesNotMatch(words, /[—–;]| - /, words);
  }
  assert.match(src, /^const KJR_QUEUE_LOCK_BUSY = 'Another tab is refreshing prices\. Try again when it has finished';$/m);
});
