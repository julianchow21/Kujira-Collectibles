'use strict';
// v3.94, Rebuild Queue (startFreshQueue) and Clear (clearQueue) stand down like every other writer of the saved queue. They checked _queueRunning at most, so a rebuild
// or a Clear could rewrite or drop the saved queue (and the day's credits on it) under a bulk run, which keeps the queue in memory and saves it back after every answer:
// its next save put its own copy back and the Clear or the rebuild was lost without a word. The bulk refresh's open question (its yes starts that run) and a lookup in
// flight (it bills the queue it finds when its answer comes) are the other states that runRefreshQueue and bulkRefreshPrices already stand down for. Now both:
//   - refuse with a toast in the four states: a bulk run (_bulkRefreshRunning), the bulk question (_kjrBulkAsking), a pass (_queueRunning), a lookup (_kjrLookupsOpen)
//   - look before their question and again after the yes, because the question can stay open as long as the owner likes
//   - change nothing when they refuse: the saved queue, the credits side record and the confirm dialog are as they were
//   - still carry the day's credits when they go ahead (_kjrCarryCredits, _kjrStashCredits), and are not refused for good
// Fetch is stubbed (tests/harness.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, plain, ROOT } = require('./harness.js');
const { setClock } = require('./clock.js');

// Every test here has a deadline: a held call that is never let go would hang the file, and a hung test fails the run, it does not stall it
const test = (name, fn) => nodeTest(name, { timeout: 20000 }, fn);
const QUEUE_KEY = 'pokeinv_refresh_queue';
const DATE_KEY = 'pokeinv_refresh_queue_date';
const STASH_KEY = 'pokeinv_refresh_queue_credits';
const DAY = '2026-10-25';
const AT = '2026-10-25T04:00:00Z';
const enRow = (id, name, extra) => Object.assign({ id, name, language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabRow = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 500, marketPrice: '', priceHistory: [] }, extra);
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total } } });
// at PSA 10 the vendor prices "Alpha 1" at 101, and a slab search with eBay data costs 6 credits
const slabCard = (search) => {
  const m = /^(.+) (\d+)$/.exec(search || '');
  return m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};
const pptReply = (url) => {
  const u = new URL(url);
  return u.searchParams.get('includeEbay') === 'true' ? answer([slabCard(u.searchParams.get('search'))].filter(Boolean), 6) : answer([], 3);
};

async function setup(seed) {
  const app = await loadApp({ seed: Object.assign({ singles: [enRow('b', 'Raichu 26')], slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] }, seed), jaLane: true });
  app.clock = setClock(app, AT);
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  // While app.hold() is on, every TCGdex answer and every PPT answer from the nth on waits for app.letGo()
  app.holding = null; app.holdFrom = 1; let pptSeen = 0;
  app.fetchMock.route('/ppt/cards', async (url) => {
    const n = ++pptSeen;
    if (app.holding && n >= app.holdFrom) await app.holding.promise;
    return pptReply(url);
  });
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), async (url) => {
    if (app.holding) await app.holding.promise;
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) return decodeURIComponent(list[2]) === '26' ? jsonResponse([{ id: 'set-26' }]) : jsonResponse([]);
    if (/\/cards\/set-26$/.test(url)) return jsonResponse({ id: 'set-26', pricing: { tcgplayer: { holofoil: { marketPrice: 8 } } } });
    return jsonResponse({}, 404);
  });
  app.hold = (from) => { let go; const promise = new Promise((r) => { go = r; }); app.holding = { promise, go }; app.holdFrom = from || 1; };
  app.letGo = () => { const h = app.holding; app.holding = null; if (h) h.go(); };
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
  // everything an edit of the queue can touch, byte for byte
  app.snapshot = () => ({ queue: app.localStorage.getItem(QUEUE_KEY), date: app.localStorage.getItem(DATE_KEY), stash: app.localStorage.getItem(STASH_KEY) });
  // the question: held until the test answers it, with resolve(true) for a yes and resolve(false) for a no
  app.asks = [];
  app.heldConfirm = (msg) => new Promise((resolve) => app.asks.push({ msg: String(msg), resolve }));
  app.ctx.kjrConfirm = app.heldConfirm;
  // the lane waits 250ms between cards and the PPT lane 6 seconds through the sandbox's setTimeout, which the harness never fires by itself: fire only those
  app.settleQueue = async () => {
    for (let i = 0; i < 200 && (i < 6 || app.ctx._queueRunning); i++) {
      await new Promise((r) => setImmediate(r));
      app.timers.flush((e) => [250, 2000, 6000].includes(e.delay));
    }
  };
  app.lookup = () => app.ctx.kjrBudgetedLookup({ name: 'Raichu 26', grader: null, grade: null, language: null });
  return app;
}
const tick = async (n) => { for (let i = 0; i < (n || 10); i++) await new Promise((r) => setImmediate(r)); };
// did a call that must return at once return? It fails the assertion that asks, where an unbounded await would sit there until the test's deadline
async function soon(p) {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 60 && !done; i++) await new Promise((r) => setImmediate(r));
  return done;
}
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

// ── the four states, each started for real and ended for real ───────────────────────────────────────────────────────────────────────────────
// start(app) leaves the state in place and returns the function that ends it. The question of a state that asks one is the held one, answered by that end function.
const STATES = {
  'a bulk run is in flight': {
    why: 'A bulk refresh is running - wait for it to finish first',
    async start(app) {
      app.hold(2); // the first PPT answer comes at once and is billed, the second waits
      app.ctx.kjrConfirm = async () => true;
      const run = app.ctx.bulkRefreshPrices('slabs');
      await until(app, () => app.ppt().length >= 2);
      assert.equal(app.ctx._bulkRefreshRunning, true);
      return async () => { app.letGo(); await finish(app, run); };
    },
  },
  'the bulk refresh question is open': {
    why: 'A bulk refresh is waiting for your answer - answer it first',
    async start(app) {
      app.ctx.kjrConfirm = app.heldConfirm;
      const at = app.asks.length;
      const run = app.ctx.bulkRefreshPrices('slabs');
      assert.equal(app.ctx._kjrBulkAsking, true);
      return async () => { app.asks[at].resolve(false); await run; };
    },
  },
  'a pass is running': {
    why: 'A refresh pass is already running - wait for it to finish first',
    async start(app) {
      app.hold();
      const pass = app.ctx.runRefreshQueue(true);
      assert.equal(app.ctx._queueRunning, true);
      return async () => { app.letGo(); await app.settleQueue(); await pass; };
    },
  },
  'a lookup is in flight': {
    why: 'A price lookup is running - wait for it to finish first',
    async start(app) {
      app.hold();
      const look = app.lookup();
      assert.equal(app.ctx._kjrLookupsOpen, 1);
      return async () => { app.letGo(); await look; };
    },
  },
};

// ── a refusal before the question ───────────────────────────────────────────────────────────────────────────────────────────────────────────
for (const [name, st] of Object.entries(STATES)) {
  test('queue edit: Rebuild Queue is refused while ' + name + ', before the question, and changes nothing', async () => {
    const app = await setup();
    app.saveQueue({ creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 } });
    const end = await st.start(app);
    app.ctx.kjrConfirm = app.heldConfirm; // a question asked from here on waits for the test, and shows in app.asks
    const asked = app.asks.length;
    const snap = app.snapshot();
    app.clock.add(60000); // a rebuilt queue would carry a later createdAt
    app.toasts.length = 0;
    assert.equal(await soon(app.ctx.startFreshQueue()), true, 'it returns at once, there is no question to wait for');
    assert.deepEqual(app.toasts, [st.why]);
    assert.equal(app.asks.length, asked, 'and no question was put to the owner');
    assert.deepEqual(app.snapshot(), snap, 'the saved queue, the date key and the credits side record are as they were');
    await end();
    // not refused for good, and the credits travel: the rebuild after the state has ended carries what the queue holds by then
    const before = app.saved();
    app.clock.add(60000);
    app.ctx.kjrConfirm = async () => true;
    app.toasts.length = 0;
    await app.ctx.startFreshQueue();
    const after = app.saved();
    assert.ok(app.toasts.some((t) => /^Queue built: /.test(t)), JSON.stringify(app.toasts));
    assert.notEqual(after.createdAt, before.createdAt, 'a new queue');
    assert.equal(after.cursor, 0, 'the progress started again');
    assert.deepEqual(after.dayCreditsUsed, before.dayCreditsUsed, 'the day\'s credits did not');
    assert.ok(after.dayCreditsUsed[DAY] >= 30, 'and none of the 30 was lost');
  });

  test('queue edit: Clear is refused while ' + name + ', by the button and by clearQueue itself, and changes nothing', async () => {
    const app = await setup();
    app.saveQueue({ creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 } });
    const end = await st.start(app);
    app.ctx.kjrConfirm = app.heldConfirm;
    const asked = app.asks.length;
    const snap = app.snapshot();
    app.toasts.length = 0;
    assert.equal(await soon(app.ctx.clearQueueAsk()), true, 'the button returns at once, there is no question to wait for');
    assert.deepEqual(app.toasts, [st.why]);
    assert.equal(app.asks.length, asked, 'and no question was put to the owner');
    assert.equal(app.ctx.clearQueue(), false, 'the function itself says no');
    assert.deepEqual(app.toasts, [st.why, 'Nothing was cleared. ' + st.why]);
    assert.deepEqual(app.snapshot(), snap, 'the saved queue, the date key and the credits side record are as they were');
    assert.equal(app.localStorage.getItem(STASH_KEY), snap.stash, 'no credits were set aside, so none can be picked up twice');
    await end();
    // not refused for good: the queue is cleared after the state has ended, and its credits are set aside for the next queue
    const before = app.saved();
    app.ctx.kjrConfirm = async () => true;
    app.toasts.length = 0;
    await app.ctx.clearQueueAsk();
    assert.equal(app.localStorage.getItem(QUEUE_KEY), null, 'cleared');
    assert.deepEqual(JSON.parse(app.localStorage.getItem(STASH_KEY)).dayCreditsUsed, before.dayCreditsUsed, 'with the day\'s credits kept');
  });

  test('queue edit: ' + name + ' after the owner opened the Rebuild or Clear question, the yes does nothing and says so', async () => {
    for (const edit of ['rebuild', 'clear']) {
      const app = await setup();
      app.saveQueue({ creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 } });
      const asking = edit === 'rebuild' ? app.ctx.startFreshQueue() : app.ctx.clearQueueAsk();
      assert.equal(app.asks.length, 1, edit + ': the question is on the screen');
      assert.match(app.asks[0].msg, edit === 'rebuild' ? /^Build a new refresh queue/ : /^Clear queue\?$/);
      const end = await st.start(app); // the state starts while the question is open
      app.clock.add(60000);
      const snap = app.snapshot();
      app.toasts.length = 0;
      app.asks[0].resolve(true);
      assert.equal(await soon(asking), true, edit + ': the yes returns at once');
      assert.deepEqual(app.toasts, [(edit === 'rebuild' ? 'Nothing was rebuilt. ' : 'Nothing was cleared. ') + st.why], edit);
      assert.deepEqual(app.snapshot(), snap, edit + ': nothing changed');
      await end();
    }
  });
}

// ── the rest of the questions ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('queue edit: with nothing in the way a Rebuild and a Clear go ahead as ever, carry the day\'s credits, and a no changes nothing', async () => {
  const app = await setup();
  const old = app.saveQueue({ creditsVersion: 1, dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: DAY, cursor: 1 });
  // a no to either question leaves everything as it was
  const snap = app.snapshot();
  const rebuildNo = app.ctx.startFreshQueue();
  app.asks[0].resolve(false);
  await rebuildNo;
  const clearNo = app.ctx.clearQueueAsk();
  app.asks[1].resolve(false);
  await clearNo;
  assert.deepEqual(app.snapshot(), snap);
  assert.deepEqual(app.toasts, [], 'and no toast, nothing was done');
  // a yes to the rebuild: the progress starts again, the credits and the pause stay
  app.clock.add(60000);
  const rebuild = app.ctx.startFreshQueue();
  assert.equal(app.asks.length, 3);
  app.asks[2].resolve(true);
  await rebuild;
  const q = app.saved();
  assert.equal(q.cursor, 0);
  assert.notEqual(q.createdAt, old.createdAt);
  assert.equal(q.dayCreditsUsed[DAY], 30);
  assert.equal(q.creditsPausedDate, DAY);
  assert.equal(q.creditsVersion, 1);
  assert.ok(app.toasts.some((t) => /^Queue built: /.test(t)));
  // a yes to the Clear: the queue goes, the credits are set aside, and the queue made next starts from them
  const clear = app.ctx.clearQueueAsk();
  app.asks[3].resolve(true);
  await clear;
  assert.equal(app.localStorage.getItem(QUEUE_KEY), null);
  assert.deepEqual(plain(JSON.parse(app.localStorage.getItem(STASH_KEY))), { dayCreditsUsed: { [DAY]: 30 }, creditsPausedDate: DAY });
  app.ctx.kjrConfirm = async () => true;
  await app.ctx.startFreshQueue();
  assert.equal(app.saved().dayCreditsUsed[DAY], 30, 'the queue built after it starts from them');
  assert.equal(app.localStorage.getItem(STASH_KEY), null, 'and the record is used up');
});

test('queue edit: a Rebuild or a Clear with no saved queue yet is no error, and a Clear of nothing says yes and sets nothing aside', async () => {
  const app = await setup();
  app.ctx.kjrConfirm = async () => true;
  assert.equal(app.localStorage.getItem(QUEUE_KEY), null);
  assert.equal(app.ctx.clearQueue(), true);
  assert.equal(app.localStorage.getItem(STASH_KEY), null, 'nothing to set aside');
  await app.ctx.startFreshQueue();
  assert.equal(app.saved().cursor, 0);
  assert.deepEqual(plain(app.saved().dayCreditsUsed), {});
});

// ── the case that cost data: a bulk run billing credits while the queue is rebuilt or cleared under it ──────────────────────────────────────

test('queue edit: under a bulk run that has billed credits, a Rebuild and a Clear are refused and the run saves the queue it began with, every credit on it', async () => {
  const app = await setup({ singles: [], slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2'), slabRow('s3', 'Charlie 3')] });
  app.saveQueue({ creditsVersion: 1, dayCreditsUsed: { [DAY]: 12 } });
  app.hold(2);
  app.ctx.kjrConfirm = async () => true;
  const run = app.ctx.bulkRefreshPrices('slabs');
  await until(app, () => app.ppt().length >= 2); // the first slab is answered and billed, the second is in flight
  const mid = app.saved();
  assert.equal(mid.dayCreditsUsed[DAY], 18, '12 and the first slab\'s 6');
  const snap = app.snapshot();
  app.clock.add(60000);
  app.ctx.kjrConfirm = async () => true; // a yes to anything: only the check can stop them now
  await app.ctx.startFreshQueue();
  await app.ctx.clearQueueAsk();
  assert.equal(app.ctx.clearQueue(), false);
  assert.deepEqual(app.snapshot(), snap, 'the queue the run holds is in storage, untouched');
  assert.equal(app.localStorage.getItem(STASH_KEY), null, 'no side record of credits was written for a queue that was never dropped');
  assert.deepEqual(app.toasts.slice(-3), [
    'A bulk refresh is running - wait for it to finish first',
    'A bulk refresh is running - wait for it to finish first',
    'Nothing was cleared. A bulk refresh is running - wait for it to finish first',
  ]);
  app.letGo();
  await finish(app, run);
  const end = app.saved();
  assert.equal(end.dayCreditsUsed[DAY], 12 + 18, 'all three slabs were billed on the one queue');
  assert.equal(end.createdAt, mid.createdAt, 'it is the queue the run began with, never a rebuilt one');
  assert.equal(app.row('s3', 'slabs').marketPrice, '103');
  assert.ok(app.toasts.some((t) => /^Done: 3 updated$/.test(t)), JSON.stringify(app.toasts));
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('queue edit: every writer of the saved queue is known, and the two that replace or drop it ask _kjrQueueEditBlocker before and after the question', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const writers = new Set();
  let fn = null;
  for (const line of src.split('\n')) {
    const m = /^(?:async )?function (\w+)\(/.exec(line);
    if (m) fn = m[1];
    if (/^\s*\/\//.test(line) || /^function saveQueue\(/.test(line)) continue;
    if (/\bsaveQueue\(/.test(line) || /localStorage\.removeItem\(QUEUE_KEY\)/.test(line)) writers.add(fn);
  }
  // A new writer fails this on purpose: read it against _kjrQueueEditBlocker (does it hold the queue in memory, does it replace or drop it) before adding it here.
  // kjrPptSetPlan: one field, read and written in one step.  loadQueue: drops a queue of an old schema, setting its credits aside.  The pass and the bulk run own the queue
  // while their flag is up.  _kjrBillLookup: read, added to and written in one step after the answer.  startFreshQueue and clearQueue are the two that this suite guards.
  assert.deepEqual([...writers].sort(), ['_kjrBillLookup', '_runRefreshQueueBody', 'bulkRefreshPrices', 'clearQueue', 'kjrPptSetPlan', 'loadQueue', 'runRefreshQueue', 'startFreshQueue']);
  const body = (name) => {
    const at = src.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name);
    return src.slice(at, at + 10 + src.slice(at + 10).search(/\n(?:async )?function /));
  };
  const start = body('startFreshQueue');
  assert.match(start, /const blocked = _kjrQueueEditBlocker\(\);\s*if \(blocked\) \{ toast\(blocked\); return; \}\s*if \(!await kjrConfirm\(/, 'a look, then the question');
  assert.match(start, /\{ok:'Rebuild queue'\}\)\) return;\s*const blockedNow = _kjrQueueEditBlocker\(\);\s*if \(blockedNow\) \{ toast\('Nothing was rebuilt\. ' \+ blockedNow, 6000\); return; \}/, 'and another look straight after the yes');
  const afterYes = start.slice(start.indexOf('const blockedNow'), start.indexOf('saveQueue(q);'));
  assert.doesNotMatch(afterYes.replace(/\/\/[^\n]*/g, ''), /\bawait\b/, 'nothing awaits between that look and the save');
  assert.match(afterYes, /_kjrCarryCredits\(buildRefreshQueue\(\), loadQueue\(\)\)/, 'and the credits travel');
  assert.match(body('clearQueue'), /^function clearQueue\(\) \{\s*const blocked = _kjrQueueEditBlocker\(\);\s*if \(blocked\) \{ toast\('Nothing was cleared\. ' \+ blocked, 6000\); return false; \}\s*_kjrStashCredits\(loadQueue\(\)\);/);
  assert.match(body('clearQueueAsk'), /const blocked = _kjrQueueEditBlocker\(\);\s*if \(blocked\) \{ toast\(blocked\); return; \}\s*if \(await kjrConfirm\('Clear queue\?', \{ok:'Clear', danger:true\}\) && clearQueue\(\)\) _renderQueueStatus\(\);/);
  assert.match(src, /<button class="btn btn-sm" style="color:var\(--red\)" onclick="clearQueueAsk\(\)">✕ Clear<\/button>/, 'the Clear button asks through the function that looks first');
  assert.doesNotMatch(src, /onclick="[^"]*clearQueue\(\)/, 'and nothing in the page calls clearQueue without the question');
  const blocker = body('_kjrQueueEditBlocker');
  assert.match(blocker, /_bulkRefreshRunning[\s\S]*_kjrBulkAsking[\s\S]*_kjrBulkBlocker\(\)/, 'the four states: a bulk run, the bulk question, then a pass and a lookup through _kjrBulkBlocker');
});

test('queue edit: the new toasts are plain British English with no dash bar and no semicolon', async () => {
  const words = [];
  for (const st of Object.values(STATES)) {
    const a = await setup();
    const end = await st.start(a);
    a.ctx.kjrConfirm = a.heldConfirm;
    a.toasts.length = 0;
    await a.ctx.startFreshQueue();
    a.ctx.clearQueue();
    words.push(...a.toasts);
    await end();
  }
  assert.equal(words.length, 8, '4 states, a refusal each from the rebuild and from the clear');
  for (const t of words) assert.doesNotMatch(t, new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ';]'), t);
});
