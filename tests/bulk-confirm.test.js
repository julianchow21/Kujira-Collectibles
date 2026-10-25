'use strict';
// v3.93, the bulk refresh's question no longer lets a pass start under it. bulkRefreshPrices asks "Refresh N singles now?" and the owner can take as long as
// they like to answer. It checked _queueRunning, _bulkRefreshRunning and _kjrLookupsOpen before the question and set _bulkRefreshRunning only after the yes, so a
// pass that started in between (the page-load auto run at its 8 second mark, or Run Today's Batch) held the saved queue in memory while the bulk run started on
// the same queue and the same credits, and each wrote the queue back over the other. Now:
//   - while the question is open (_kjrBulkAsking) the auto run waits, as it waits for a lookup, and a pass asked for by hand is refused
//   - the waiting auto run goes once when the question closes, and after a yes only when the bulk run has finished
//   - after the yes the run looks again at _queueRunning, _bulkRefreshRunning and _kjrLookupsOpen, and does nothing if one of them started meanwhile
//   - the flag is cleared on every way out of the question: a yes, a no, Esc, a tap on the backdrop and a throw
//   - the run reads the day, the plan and the credits as they are after the yes, not as the question showed them
// Fetch is stubbed (tests/harness.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, plain, ROOT } = require('./harness.js');
const { setClock } = require('./clock.js');

// Every test here has a deadline: without the fix several of them would wait for an answer that never comes, and a hung test fails the run, it does not stall it
const test = (name, fn) => nodeTest(name, { timeout: 15000 }, fn);
const QUEUE_KEY = 'pokeinv_refresh_queue';
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

// TCGdex: card number N resolves to set-N and its TCGplayer market is prices['set-N']. While app.hold() is on, every TCGdex answer waits for app.letGo().
function tcgdex(app, prices) {
  app.holding = null;
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), async (url) => {
    if (app.holding) await app.holding.promise;
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) return prices['set-' + decodeURIComponent(list[2])] ? jsonResponse([{ id: 'set-' + decodeURIComponent(list[2]) }]) : jsonResponse([]);
    const card = url.match(/\/cards\/(set-\d+)$/);
    if (card) return prices[card[1]] ? jsonResponse({ id: card[1], pricing: { tcgplayer: { holofoil: { marketPrice: prices[card[1]] } } } }) : jsonResponse({}, 404);
    return jsonResponse({}, 404);
  });
  app.hold = () => { let go; const promise = new Promise((r) => { go = r; }); app.holding = { promise, go }; };
  app.letGo = () => { const h = app.holding; app.holding = null; if (h) h.go(); };
}

async function setup(seed) {
  const app = await loadApp({ seed: Object.assign({ singles: [enRow('b', 'Raichu 26')], slabs: [] }, seed), jaLane: true });
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  app.fetchMock.route('/ppt/cards', pptReply);
  tcgdex(app, { 'set-26': 8 });
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.tcgPrices = () => app.fetchMock.calls.filter((c) => /api\.tcgdex\.net\/.*\/cards\/set-\d+$/.test(c.url));
  app.row = (id, table) => app.ctx.DB[table || 'singles'].find((r) => r.id === id);
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  // a saved queue with this much of a day's credits spent, as the queue or a lookup would have left it
  app.saveQueue = (patch) => {
    const q = plain(app.ctx.buildRefreshQueue());
    Object.assign(q, patch || {});
    app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    return q;
  };
  // the question: held until the test answers it, with resolve(true) for a yes, resolve(false) for a no and reject(err) for a throw
  app.realConfirmFn = app.ctx.kjrConfirm;
  app.asks = [];
  app.heldConfirm = (msg) => new Promise((resolve, reject) => app.asks.push({ msg: String(msg), resolve, reject }));
  app.ctx.kjrConfirm = app.heldConfirm;
  // every call to runRefreshQueue, with the price the card carried at that moment, and then the real pass
  app.runs = [];
  const real = app.ctx.runRefreshQueue;
  app.ctx.runRefreshQueue = (...args) => { app.runs.push({ args, price: app.row('b') ? app.row('b').marketPrice : undefined }); return real(...args); };
  app.mark = () => app.timers.list().find((t) => t.type === 'timeout' && t.delay === 8000);
  app.reachMark = () => { const t = app.mark(); assert.ok(t, 'the app registered its 8 second timer at load'); app.timers.invoke(t.id); };
  // the lane waits 250ms between cards through the sandbox's setTimeout, which the harness never fires by itself: fire only that, never the app's 5 and 8 second timers
  app.settleQueue = async () => {
    for (let i = 0; i < 120 && (i < 6 || app.ctx._queueRunning); i++) {
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

// The real kjrConfirm against a confirm dialog the stub can open (the harness leaves it unable to, so that kjrConfirm falls back to window.confirm), the way
// tests/confirm-reentrant.test.js drives it
function realDialog(app) {
  const doc = app.document;
  const dlg = doc.getElementById('kjr-confirm-dialog');
  const c = { dlg, shows: 0, ok: doc.getElementById('kjr-confirm-ok'), cancel: doc.getElementById('kjr-confirm-cancel'), msg: doc.getElementById('kjr-confirm-msg') };
  dlg.showModal = function () { c.shows++; this.open = true; };
  dlg.close = function () { this.open = false; this.dispatchEvent({ type: 'close' }); };
  c.clickOk = () => c.ok.onclick();
  c.clickCancel = () => c.cancel.onclick();
  c.tapBackdrop = () => dlg.dispatchEvent({ type: 'click', target: dlg });
  c.esc = () => { dlg.open = false; dlg.dispatchEvent({ type: 'close' }); }; // Esc: the browser shuts it and sends close
  app.ctx.kjrConfirm = app.realConfirmFn;
  return c;
}

// ── the auto run waits for the question ─────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk confirm: the auto run at the 8 second mark waits while the question is open, and runs exactly once when the owner says no', async () => {
  const app = await setup();
  const run = app.ctx.bulkRefreshPrices('singles');
  assert.equal(app.asks.length, 1, 'the question is on the screen');
  assert.equal(app.ctx._kjrBulkAsking, true);
  app.reachMark();
  assert.equal(app.runs.length, 0, 'the run did not go under the question');
  assert.equal(app.ctx._kjrAutoRunWaiting, true, 'it is waiting');
  await tick(30);
  assert.equal(app.runs.length, 0, 'and keeps waiting for as long as the question is open');
  assert.deepEqual(app.toasts, [], 'a quiet wait, a page-load run was never announced');
  assert.equal(app.fetchMock.calls.length, 0, 'nothing was asked of any source meanwhile');
  app.asks[0].resolve(false);
  await run;
  await tick();
  assert.equal(app.ctx._kjrBulkAsking, false);
  assert.deepEqual(app.runs.map((r) => r.args), [[false]], 'it went when the question closed, once, as an automatic call');
  assert.equal(app.ctx._kjrAutoRunWaiting, false);
  await app.settleQueue();
  assert.equal(app.row('b').marketPrice, '8', 'a real pass, not only a call');
  assert.equal(app.ctx._queueRunning, false);
  // another question, answered no: the run is called once per load
  const again = app.ctx.bulkRefreshPrices('singles');
  assert.equal(app.asks.length, 2);
  app.asks[1].resolve(false);
  await again;
  await tick();
  assert.equal(app.runs.length, 1, 'at most once per load');
});

test('bulk confirm: after a yes the waiting auto run goes only when the bulk run has finished, once, after the bulk run has written its prices', async () => {
  const app = await setup();
  app.hold(); // the bulk run's TCGdex answer waits, so the run is mid-flight when the rest happens
  const run = app.ctx.bulkRefreshPrices('singles');
  app.reachMark();
  assert.equal(app.ctx._kjrAutoRunWaiting, true);
  app.asks[0].resolve(true);
  await tick(20);
  assert.equal(app.ctx._kjrBulkAsking, false, 'the question is closed');
  assert.equal(app.ctx._bulkRefreshRunning, true, 'and the bulk run is going');
  assert.equal(app.runs.length, 0, 'the auto run did not start under it');
  assert.equal(app.ctx._kjrAutoRunWaiting, true, 'the question closing did not let it go, it waits for the run');
  // what a lookup closing in the middle of the run does: it hands the waiting run back, and the run still holds it
  app.ctx._kjrAutoRunResume();
  await tick();
  assert.equal(app.runs.length, 0, 'still not under the bulk run');
  assert.equal(app.ctx._kjrAutoRunWaiting, true);
  app.letGo();
  await run;
  await tick();
  assert.equal(app.ctx._bulkRefreshRunning, false);
  assert.deepEqual(app.runs.map((r) => r.args), [[false]], 'then it went, once, as an automatic call');
  assert.equal(app.runs[0].price, '8', 'after the bulk run had written the price, not under it');
  assert.equal(app.ctx._kjrAutoRunWaiting, false);
  assert.ok(app.toasts.some((t) => /^Done: 1 updated$/.test(t)), JSON.stringify(app.toasts));
  await app.settleQueue();
  assert.equal(app.ctx._queueRunning, false);
  assert.equal(app.runs.length, 1, 'and not a second time');
});

test('bulk confirm: with a lookup and the question both open at the mark, the run waits for the last of the two, whichever closes first', async () => {
  for (const order of ['the lookup first', 'the question first']) {
    const app = await setup();
    app.hold();
    const run = app.ctx.bulkRefreshPrices('singles');
    const look = app.lookup();
    assert.equal(app.ctx._kjrLookupsOpen, 1, order);
    app.reachMark();
    assert.equal(app.ctx._kjrAutoRunWaiting, true, order);
    if (order === 'the lookup first') {
      app.letGo();
      await look;
      await tick();
      assert.equal(app.runs.length, 0, order + ': the question is still open');
      assert.equal(app.ctx._kjrAutoRunWaiting, true, order);
      app.asks[0].resolve(false);
      await run;
    } else {
      app.asks[0].resolve(false);
      await run;
      await tick();
      assert.equal(app.runs.length, 0, order + ': the lookup is still open');
      assert.equal(app.ctx._kjrAutoRunWaiting, true, order);
      app.letGo();
      await look;
    }
    await tick();
    assert.equal(app.runs.length, 1, order + ': the last one let it go');
    assert.equal(app.ctx._kjrAutoRunWaiting, false, order);
    await app.settleQueue();
  }
});

// ── a pass asked for by hand is refused ─────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk confirm: a pass asked for by hand while the question is open is refused, so is a second question, and nothing starts', async () => {
  const app = await setup();
  const run = app.ctx.bulkRefreshPrices('singles');
  app.toasts.length = 0;
  await app.ctx.runRefreshQueue(true);
  await app.ctx.runRefreshQueue(false);
  assert.equal(await soon(app.ctx.bulkRefreshPrices('singles')), true, 'a second question for the same table returns at once');
  assert.equal(await soon(app.ctx.bulkRefreshPrices('slabs')), true, 'and so does one for the other table');
  assert.deepEqual(app.toasts, [
    'A bulk refresh is waiting for your answer - answer it first',
    'A bulk refresh is already waiting for your answer - answer it first',
    'A bulk refresh is already waiting for your answer - answer it first',
  ], 'a manual pass says why, a direct automatic call is silent, and a second question is turned away whatever its table');
  assert.equal(app.asks.length, 1, 'one question on the screen, never a second');
  assert.equal(app.ctx._queueRunning, false);
  assert.equal(app.ctx._bulkRefreshRunning, false);
  assert.equal(app.fetchMock.calls.length, 0, 'none of them asked any source');
  assert.equal(app.saved(), null, 'and none made a queue for the bulk run to share');
  assert.equal(app.ctx._kjrAutoRunWaiting, false, 'a direct call to runRefreshQueue(false) sets nothing waiting, only the 8 second mark does');
  app.asks[0].resolve(false);
  await run;
  assert.equal(app.ctx._kjrBulkAsking, false);
  // with the question closed the same pass starts
  app.toasts.length = 0;
  const pass = app.ctx.runRefreshQueue(true);
  await app.settleQueue();
  await pass;
  assert.ok(!app.toasts.some((t) => /waiting for your answer/.test(t)), JSON.stringify(app.toasts));
  assert.equal(app.row('b').marketPrice, '8', 'a real pass');
});

// ── a pass that started anyway ──────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk confirm: something that started while the question was open makes the confirmed run refuse, ask nothing and leave the flags as it found them', async () => {
  const cases = [
    // the flag the test raises, the value it raises it to, the toast the owner reads, whether the auto run still waits for it
    ['_queueRunning', true, 'A refresh pass is already running - wait for it to finish first', false],
    ['_bulkRefreshRunning', true, 'Refresh already running...', true],
    ['_kjrLookupsOpen', 1, 'A price lookup is running - wait for it to finish first', true],
  ];
  for (const [flag, up, why, stillWaits] of cases) {
    const app = await setup();
    const run = app.ctx.bulkRefreshPrices('singles');
    app.reachMark();
    app.ctx[flag] = up;
    app.toasts.length = 0;
    app.asks[0].resolve(true);
    await run;
    await tick();
    assert.deepEqual(app.toasts, ['Nothing was refreshed. ' + why], flag);
    assert.equal(app.fetchMock.calls.length, 0, flag + ': no request of any source');
    assert.equal(app.row('b').marketPrice, '', flag + ': no price written');
    assert.equal(app.saved(), null, flag + ': no queue made or touched');
    assert.equal(app.ctx._kjrBulkAsking, false, flag);
    assert.equal(app.ctx._bulkRefreshRunning, flag === '_bulkRefreshRunning', flag + ': the refused run took no flag of its own');
    assert.equal(app.runs.length, 0, flag + ': the auto run did not start under it');
    assert.equal(app.ctx._kjrAutoRunWaiting, stillWaits, flag + (stillWaits ? ': still waiting for the one that is running' : ': stood down, a pass is doing the day\'s work'));
    if (stillWaits) {
      // the other one ending hands the waiting run back, and it goes
      app.ctx[flag] = flag === '_kjrLookupsOpen' ? 0 : false;
      app.ctx._kjrAutoRunResume();
      await tick();
      assert.equal(app.runs.length, 1, flag + ': it went when that one ended');
      await app.settleQueue();
    } else {
      app.ctx[flag] = false;
    }
  }
});

test('bulk confirm: a pass that really started under the question (a held queue pass) makes the yes do nothing, and the pass is not disturbed', async () => {
  const app = await setup();
  app.hold();
  const run = app.ctx.bulkRefreshPrices('singles');
  // the question holds every pass back, so this one is forced in the way something unforeseen would be: the flag is lowered for the one call only
  app.ctx._kjrBulkAsking = false;
  const pass = app.ctx.runRefreshQueue(true);
  app.ctx._kjrBulkAsking = true;
  assert.equal(app.ctx._queueRunning, true, 'the pass is running');
  app.toasts.length = 0;
  app.asks[0].resolve(true);
  assert.equal(await soon(run), true, 'the yes returns at once: it started nothing that waits on the held answer');
  assert.deepEqual(app.toasts, ['Nothing was refreshed. A refresh pass is already running - wait for it to finish first']);
  assert.equal(app.ctx._bulkRefreshRunning, false);
  assert.equal(app.ctx._queueRunning, true, 'the pass goes on');
  app.letGo();
  await app.settleQueue();
  await pass;
  assert.equal(app.row('b').marketPrice, '8');
  assert.equal(app.tcgPrices().length, 1, 'one price request for the card, the pass\'s: the bulk run made none');
});

test('bulk confirm: a lookup still in flight at the yes makes the run refuse, and the lookup carries on untouched', async () => {
  const app = await setup();
  app.hold();
  const run = app.ctx.bulkRefreshPrices('singles');
  const look = app.lookup();
  assert.equal(app.ctx._kjrLookupsOpen, 1);
  app.toasts.length = 0;
  app.asks[0].resolve(true);
  assert.equal(await soon(run), true, 'the yes returns at once: it started nothing that waits on the held answer');
  assert.deepEqual(app.toasts, ['Nothing was refreshed. A price lookup is running - wait for it to finish first']);
  assert.equal(app.ctx._bulkRefreshRunning, false);
  assert.equal(app.ctx._kjrLookupsOpen, 1, 'the lookup was not disturbed');
  app.letGo();
  const found = await look;
  assert.equal(found.r.maxSgd, 8, 'and it was answered');
  assert.equal(app.ctx._kjrLookupsOpen, 0);
  assert.equal(app.row('b').marketPrice, '', 'a lookup writes no price');
});

// ── the flag is cleared on every way out ────────────────────────────────────────────────────────────────────────────────────────────────

const WAYS = {
  'a no': { go: (app) => app.asks[0].resolve(false) },
  'a yes': { go: (app) => app.asks[0].resolve(true) },
  'a throw': { go: (app) => app.asks[0].reject(new Error('boom')), throws: /boom/ },
};
for (const [name, way] of Object.entries(WAYS)) {
  test('bulk confirm: ' + name + ' clears the flag, lets the waiting auto run go once, and the next pass or question is not refused', async () => {
    const app = await setup();
    const run = app.ctx.bulkRefreshPrices('singles');
    app.reachMark();
    assert.equal(app.ctx._kjrBulkAsking, true);
    way.go(app);
    if (way.throws) await assert.rejects(() => run, way.throws);
    else await finish(app, run);
    await tick();
    assert.equal(app.ctx._kjrBulkAsking, false, 'the flag is down');
    assert.equal(app.ctx._bulkRefreshRunning, false);
    assert.equal(app.ctx._kjrAutoRunWaiting, false, 'nothing is left waiting');
    assert.deepEqual(app.runs.map((r) => r.args), [[false]], 'the auto run went, once');
    await app.settleQueue();
    // nothing is refused for good: a pass by hand and a new question both go through
    app.toasts.length = 0;
    const pass = app.ctx.runRefreshQueue(true);
    await app.settleQueue();
    await pass;
    assert.ok(!app.toasts.some((t) => /waiting for your answer|Nothing was refreshed/.test(t)), JSON.stringify(app.toasts));
    const asks = app.asks.length;
    const next = app.ctx.bulkRefreshPrices('singles');
    assert.equal(app.asks.length, asks + 1, 'a new question opens');
    app.asks[asks].resolve(false);
    await next;
    assert.equal(app.ctx._kjrBulkAsking, false);
  });
}

test('bulk confirm: a question that throws as it is asked clears the flag at once, the error reaches the caller, and the next question opens', async () => {
  const app = await setup();
  app.ctx.kjrConfirm = () => { throw new Error('no dialog'); };
  const run = app.ctx.bulkRefreshPrices('singles');
  assert.equal(app.ctx._kjrBulkAsking, false, 'down at once, the throw came before any wait');
  await assert.rejects(() => run, /no dialog/);
  assert.equal(app.ctx._kjrBulkAsking, false);
  assert.equal(app.ctx._bulkRefreshRunning, false);
  app.ctx.kjrConfirm = app.heldConfirm;
  const next = app.ctx.bulkRefreshPrices('singles');
  assert.equal(app.asks.length, 1, 'a new question opens');
  assert.equal(app.ctx._kjrBulkAsking, true);
  app.asks[0].resolve(false);
  await next;
  assert.equal(app.ctx._kjrBulkAsking, false);
});

test('bulk confirm: on the real dialog Esc, a tap on the backdrop and Cancel each answer no, clear the flag and release the waiting auto run, and OK starts the run', async () => {
  for (const how of ['esc', 'backdrop', 'cancel', 'ok']) {
    const app = await setup();
    const c = realDialog(app);
    const run = app.ctx.bulkRefreshPrices('singles');
    assert.equal(c.shows, 1, how + ': the real dialog is up');
    assert.match(c.msg.innerHTML, /^Refresh 1 singles now\?/, how);
    assert.equal(c.dlg.open, true);
    assert.equal(app.ctx._kjrBulkAsking, true, how);
    app.reachMark();
    assert.equal(app.runs.length, 0, how + ': waiting');
    if (how === 'esc') c.esc();
    else if (how === 'backdrop') c.tapBackdrop();
    else if (how === 'cancel') c.clickCancel();
    else c.clickOk();
    await finish(app, run);
    await tick();
    assert.equal(c.dlg.open, false, how);
    assert.equal(app.ctx._kjrBulkAsking, false, how + ': the flag is down');
    assert.equal(app.ctx._bulkRefreshRunning, false, how);
    assert.deepEqual(app.runs.map((r) => r.args), [[false]], how + ': the auto run went once');
    assert.equal(app.runs[0].price, how === 'ok' ? '8' : '', how + (how === 'ok' ? ': after the bulk run had priced the card' : ': the run was declined, so the card was not priced yet'));
    await app.settleQueue();
    assert.equal(app.row('b').marketPrice, '8', how);
  }
});

// ── the run reads the credits, the plan and the day as they are after the yes ───────────────────────────────────────────────────────────

test('bulk confirm: credits spent while the question was open are seen by the run, which stops at what is left now and not at the figure the question showed', async () => {
  const app = await setup({ singles: [], slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] });
  const day = app.ctx.kjrUtcDay();
  app.saveQueue({ dayCreditsUsed: { [day]: 60 } });
  const run = app.ctx.bulkRefreshPrices('slabs');
  assert.match(app.asks[0].msg, /\(30 of 90 left on the Free plan\)/, 'the question says 30 are left');
  app.saveQueue({ dayCreditsUsed: { [day]: 85 } }); // a lookup billed the queue while the question was open: 5 are left, and a slab search can cost 6
  app.asks[0].resolve(true);
  await finish(app, run);
  assert.equal(app.ppt().length, 0, 'five credits buy no slab search, whatever the question said');
  assert.equal(app.saved().dayCreditsUsed[day], 85, 'and nothing was billed');
  assert.equal(app.row('s1', 'slabs').marketPrice, '');
  assert.ok(app.toasts.some((t) => /^Done: 0 updated · ⏸ PPT credits are used up for today \(85 of 90 on the Free plan\), they reset at 8am Singapore time \(2 not priced\)$/.test(t)), JSON.stringify(app.toasts));
});

test('bulk confirm: a question left open across 00:00 UTC bills the new day, not the day it was asked on, and checks the new day\'s credits', async () => {
  const app = await setup({ singles: [], slabs: [slabRow('s1', 'Alpha 1')] });
  const clock = setClock(app, '2026-10-25T23:59:30Z'); // 07:59:30 on 26/10 in Singapore, the vendor's day is still the 25th
  app.saveQueue({ dayCreditsUsed: { '2026-10-25': 90 } }); // the 25th's budget is all spent
  const run = app.ctx.bulkRefreshPrices('slabs');
  assert.match(app.asks[0].msg, /\(0 of 90 left on the Free plan\)/, 'asked on a spent day');
  clock.set('2026-10-26T00:00:30Z'); // the vendor's credits reset while the question is open
  app.asks[0].resolve(true);
  await finish(app, run);
  assert.equal(app.ppt().length, 1, 'the 26th has a fresh budget, so the slab is asked');
  assert.equal(app.row('s1', 'slabs').marketPrice, '101');
  assert.equal(app.saved().dayCreditsUsed['2026-10-26'], 6, 'billed on the new day');
  assert.equal(app.saved().dayCreditsUsed['2026-10-25'], 90, 'and the old day is as it was');
  assert.ok(app.toasts.some((t) => /^Done: 1 updated$/.test(t)), JSON.stringify(app.toasts));
});

test('bulk confirm: a plan changed while the question was open is the plan the run is budgeted and worded by', async () => {
  const app = await setup({ singles: [], slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] });
  const day = app.ctx.kjrUtcDay();
  app.saveQueue({ dayCreditsUsed: { [day]: 17999 } }); // the Paid plan's 18,000 but for one, and far past the Free plan's 90
  const run = app.ctx.bulkRefreshPrices('slabs');
  assert.match(app.asks[0].msg, /\(0 of 90 left on the Free plan\)/);
  assert.equal(app.ctx.kjrPptSetPlan('paid'), true); // changed on another tab, say: the plan lives in this browser's storage
  app.asks[0].resolve(true);
  await finish(app, run);
  assert.equal(app.ppt().length, 0, 'one credit left buys nothing');
  assert.ok(app.toasts.some((t) => /^Done: 0 updated · ⏸ PPT credits are used up for today \(17,999 of 18,000 on the Paid plan\), they reset at 8am Singapore time \(2 not priced\)$/.test(t)), JSON.stringify(app.toasts));
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk confirm: the flag is raised in one place and lowered in the finally of that same await, the auto run and a manual pass read it, and nothing awaits between the yes and the run', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const at = src.indexOf('\nasync function bulkRefreshPrices(');
  assert.ok(at >= 0);
  const body = src.slice(at, at + 1 + src.slice(at + 1).search(/\n(?:async )?function /));
  assert.equal((src.match(/_kjrBulkAsking = true/g) || []).length, 1, 'raised once');
  assert.equal((src.match(/_kjrBulkAsking = false/g) || []).length, 2, 'declared down, and lowered once');
  assert.match(body, /_kjrBulkAsking = true;\s*try \{\s*confirmed = await kjrConfirm\(askText, \{ok:'Refresh now'\}\);\s*\} finally \{\s*_kjrBulkAsking = false;\s*if \(!confirmed\) _kjrAutoRunResume\(\);\s*\}/, 'a try/finally round the one await');
  const after = body.slice(body.indexOf('_kjrBulkAsking = false;'), body.indexOf('_bulkRefreshRunning = true;'));
  assert.ok(after.length > 0, 'the run flag comes after the question');
  assert.doesNotMatch(after.replace(/\/\/[^\n]*/g, ''), /\bawait\b/, 'no await between the flag coming down and the run flag going up');
  assert.match(after, /_kjrBulkBlocker\(\)/, 'the second look');
  assert.match(after, /utcDay = kjrUtcDay\(\);\s*limit = kjrDailyCredits\(\);\s*planLabel = /, 'the day, the credits and the plan are read again after the yes');
  assert.match(body, /\} finally \{\s*_bulkRefreshRunning = false;\s*_kjrAutoRunResume\(\);/, 'the run hands the waiting auto run back from its finally');
  assert.match(body, /kjrCreditsLeft\(q, utcDay\) < _pptEstimateCredits/, 'and the budget is checked at every card on the queue the run holds');
  assert.match(src, /function _kjrAutoRun\(\) \{[^}]*_kjrBulkAsking/, '_kjrAutoRun reads the flag');
  assert.match(src, /function _kjrAutoRunResume\(\) \{[^}]*_kjrBulkAsking/, '_kjrAutoRunResume reads the flag');
  assert.match(src, /async function runRefreshQueue\([^)]*\) \{[\s\S]*?_kjrBulkAsking/, 'and so does runRefreshQueue');
});

test('bulk confirm: the new toasts are plain British English with no dash bar and no semicolon', async () => {
  const app = await setup();
  const run = app.ctx.bulkRefreshPrices('singles');
  app.toasts.length = 0;
  await app.ctx.runRefreshQueue(true);
  assert.equal(await soon(app.ctx.bulkRefreshPrices('singles')), true);
  app.ctx._queueRunning = true;
  app.asks[0].resolve(true);
  await run;
  app.ctx._queueRunning = false;
  assert.equal(app.toasts.length, 3);
  for (const t of app.toasts) assert.doesNotMatch(t, new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ';]'), t);
});
