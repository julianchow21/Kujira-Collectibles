'use strict';
// v3.92, the page-load auto run waits for a lookup, it is not dropped. runRefreshQueue turns an automatic call away while a hand lookup or a card refresh
// is in flight (_kjrLookupsOpen: the lookup's bill goes into the saved queue a pass holds in memory), and the 8 second mark after load (kjrStartOwnerApp) is
// the only automatic call there is, so a lookup open at that moment cost the day its pass until the next load. Now:
//   - the mark finds a lookup open: the run is noted (_kjrAutoRun), and the last lookup to close lets it go (_kjrAutoRunResume), once per load
//   - nothing polls: one flag, no timer is added while it waits
//   - a pass that is running at the mark is the day's work being done, nothing waits for it, and one that has started when the lookup closes is not run twice
//   - the run goes after the closing lookup's own tail, so a card refresh has written its price before the pass reads the rows
// Fetch is stubbed (tests/harness.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, ROOT } = require('./harness.js');

const enRow = (id, name, extra) => Object.assign({ id, name, language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);

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
  const app = await loadApp({ seed: Object.assign({ singles: [enRow('b', 'Raichu 26')], slabs: [] }, seed) });
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  tcgdex(app, { 'set-26': 8 });
  app.fetchMock.calls.length = 0;
  app.row = (id) => app.ctx.DB.singles.find((r) => r.id === id);
  // every call to runRefreshQueue, with the price the card carried at that moment, and then the real pass
  app.runs = [];
  const real = app.ctx.runRefreshQueue;
  app.ctx.runRefreshQueue = (...args) => { app.runs.push({ args, price: app.row('b').marketPrice }); return real(...args); };
  app.mark = () => app.timers.list().find((t) => t.type === 'timeout' && t.delay === 8000);
  app.reachMark = () => { const t = app.mark(); assert.ok(t, 'the app registered its 8 second timer at load'); app.timers.invoke(t.id); };
  // the lane waits 250ms between cards through the sandbox's setTimeout, which the harness never fires by itself: fire only that, never the app's 5 and 8 second timers
  app.settleQueue = async () => {
    for (let i = 0; i < 120 && (i < 6 || app.ctx._queueRunning); i++) {
      await new Promise((r) => setImmediate(r));
      app.timers.flush((e) => [250, 2000, 6000].includes(e.delay));
    }
  };
  // a hand lookup held in flight: while app.holdRouter is on the router answers when close() is called, so the count is exact and nothing else is going on.
  // A test that wants the real pass to price the card switches it off before the last lookup closes.
  app.lookups = [];
  app.holdRouter = true;
  const router = app.ctx.fetchMarketPrice;
  app.ctx.fetchMarketPrice = (descriptor) => (app.holdRouter ? new Promise((resolve, reject) => app.lookups.push({ descriptor, resolve, reject })) : router(descriptor));
  app.open = () => app.ctx.kjrBudgetedLookup({ name: 'Raichu 26', grader: null, grade: null, language: null });
  app.close = (i) => app.lookups[i].resolve({});
  app.opened = async (n) => { for (let i = 0; i < 80 && app.lookups.length < n; i++) await new Promise((r) => setImmediate(r)); return app.lookups.length >= n; };
  return app;
}
const tick = async (n) => { for (let i = 0; i < (n || 10); i++) await new Promise((r) => setImmediate(r)); };

// ── the mark finds nothing open ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('auto run: with no lookup open at the 8 second mark the run goes at once, as it always did, and a lookup that comes later starts nothing', async () => {
  const app = await setup();
  app.holdRouter = false;
  assert.equal(app.runs.length, 0, 'nothing runs at load');
  app.reachMark();
  assert.deepEqual(app.runs.map((r) => r.args), [[false]], 'one automatic call, with manual false');
  await app.settleQueue();
  assert.equal(app.row('b').marketPrice, '8', 'and it was a real pass: the card is priced');
  app.holdRouter = true;
  const look = app.open();
  assert.ok(await app.opened(1));
  app.close(0);
  await look;
  await tick();
  assert.equal(app.runs.length, 1, 'a lookup closing later does not run another');
  assert.equal(app.ctx._kjrAutoRunWaiting, false);
});

test('auto run: a lookup that closes before the mark starts nothing, the run then goes at the mark', async () => {
  const app = await setup();
  const look = app.open();
  assert.ok(await app.opened(1));
  app.close(0);
  await look;
  await tick();
  assert.equal(app.runs.length, 0, 'it was the mark that decides, not a lookup');
  assert.equal(app.ctx._kjrAutoRunWaiting, false);
  app.reachMark();
  assert.equal(app.runs.length, 1);
});

// ── the mark finds a lookup open ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('auto run: a lookup in flight at the 8 second mark defers the run, and it runs exactly once when the lookup closes', async () => {
  const app = await setup();
  const look = app.open();
  assert.ok(await app.opened(1));
  assert.equal(app.ctx._kjrLookupsOpen, 1);
  app.reachMark();
  assert.equal(app.runs.length, 0, 'the run did not go under the lookup');
  assert.equal(app.ctx._kjrAutoRunWaiting, true, 'it is waiting');
  await tick(30);
  assert.equal(app.runs.length, 0, 'and keeps waiting for as long as the lookup is open');
  assert.deepEqual(app.toasts, [], 'a quiet wait, a page-load run was never announced');
  app.holdRouter = false; // the pass that goes when this closes is a real one
  app.close(0);
  await look;
  await tick();
  assert.deepEqual(app.runs.map((r) => r.args), [[false]], 'it went when the lookup closed, once, as an automatic call');
  assert.equal(app.ctx._kjrAutoRunWaiting, false);
  await app.settleQueue();
  assert.equal(app.row('b').marketPrice, '8', 'a real pass, not only a call');
  assert.equal(app.ctx._queueRunning, false);
  // more lookups, open and closed, run nothing else: once per load
  app.holdRouter = true;
  const again = app.open();
  assert.ok(await app.opened(2));
  app.close(1);
  await again;
  await tick();
  assert.equal(app.runs.length, 1, 'at most once per load');
});

test('auto run: with two lookups in flight the run waits for the last one, not the first', async () => {
  const app = await setup();
  const a = app.open();
  const b = app.open();
  assert.ok(await app.opened(2));
  assert.equal(app.ctx._kjrLookupsOpen, 2);
  app.reachMark();
  app.close(0);
  await a;
  await tick();
  assert.equal(app.ctx._kjrLookupsOpen, 1);
  assert.equal(app.runs.length, 0, 'one is still in flight');
  assert.equal(app.ctx._kjrAutoRunWaiting, true);
  app.close(1);
  await b;
  await tick();
  assert.equal(app.runs.length, 1, 'the last one let it go');
});

test('auto run: waiting costs nothing, no timer or interval is added while the lookup is open and none is left after', async () => {
  const app = await setup();
  const markId = app.mark().id;
  const before = app.timers.list().filter((t) => t.id !== markId).map((t) => t.id + ':' + t.type + ':' + t.delay);
  const look = app.open();
  assert.ok(await app.opened(1));
  app.reachMark();
  await tick(30);
  const during = app.timers.list().map((t) => t.id + ':' + t.type + ':' + t.delay);
  assert.deepEqual(during.filter((t) => !before.includes(t)), [], 'nothing new was scheduled by waiting, not a timeout and not an interval');
  assert.deepEqual(before.filter((t) => !during.includes(t)), [], 'and nothing the app had was dropped');
  app.holdRouter = false;
  app.close(0);
  await look;
  await tick();
  await app.settleQueue();
  assert.equal(app.runs.length, 1);
});

// ── every way a lookup can end, and every kind of lookup ────────────────────────────────────────────────────────────────────────────────

const KINDS = {
  'the price lookup box': (app) => { app.document.getElementById('ebay-query').value = 'Raichu 26'; return app.ctx.searchEbay(); },
  'Test Keys': (app) => app.ctx.testApiKeys(),
  'a card\'s Refresh price': (app) => app.ctx.refreshPrice('b', 'singles'),
  'a lookup made by hand through the budget': (app) => app.open(),
};
for (const [name, start] of Object.entries(KINDS)) {
  test('auto run: ' + name + ' in flight at the mark defers the run, and it goes when that one closes', async () => {
    const app = await setup();
    const call = start(app);
    assert.ok(await app.opened(1), 'the lookup is waiting on the router');
    assert.equal(app.ctx._kjrLookupsOpen, 1);
    app.reachMark();
    assert.equal(app.runs.length, 0);
    app.close(0);
    await call;
    await tick();
    assert.equal(app.runs.length, 1);
    assert.equal(app.ctx._kjrLookupsOpen, 0);
  });
}

test('auto run: a lookup that throws still lets the run go, and the count is back to zero', async () => {
  const app = await setup();
  const look = app.open();
  assert.ok(await app.opened(1));
  app.reachMark();
  app.lookups[0].reject(new Error('boom'));
  await assert.rejects(() => look, /boom/);
  await tick();
  assert.equal(app.ctx._kjrLookupsOpen, 0);
  assert.equal(app.runs.length, 1);
});

test('auto run: it goes after the closing refresh has written its price, so the pass reads the rows as they are', async () => {
  const app = await setup();
  app.ctx.fetchMarketPrice = (d) => new Promise((resolve) => app.lookups.push({ d, resolve }));
  const refresh = app.ctx.refreshPrice('b', 'singles');
  assert.ok(await app.opened(1));
  app.reachMark();
  app.lookups[0].resolve({ maxSgd: 8, maxUsd: 8, source: 'TCGdex', confidence: 'high', sgdRate: 1, creditsUsed: 0, resolvedTcgdexId: 'set-26' });
  await refresh;
  await tick();
  assert.equal(app.row('b').marketPrice, '8', 'the refresh wrote its price');
  assert.equal(app.runs.length, 1);
  assert.equal(app.runs[0].price, '8', 'and the pass was called after that, not under it');
});

// ── a pass that is running, or has started ──────────────────────────────────────────────────────────────────────────────────────────────

test('auto run: a pass already running at the mark is the day\'s work being done, nothing waits for it and nothing runs when the lookup closes', async () => {
  for (const flag of ['_queueRunning', '_bulkRefreshRunning']) {
    const app = await setup();
    app.ctx[flag] = true;
    const look = app.open();
    assert.ok(await app.opened(1));
    app.reachMark();
    assert.equal(app.ctx._kjrAutoRunWaiting, false, flag + ': not waiting');
    app.close(0);
    await look;
    await tick();
    assert.equal(app.runs.length, 0, flag + ': no second pass');
    app.ctx[flag] = false;
  }
});

test('auto run: a pass that has started by the time the lookup closes is not run a second time, and the run does not come back later', async () => {
  const app = await setup();
  const look = app.open();
  assert.ok(await app.opened(1));
  app.reachMark();
  assert.equal(app.ctx._kjrAutoRunWaiting, true);
  app.ctx._queueRunning = true; // a pass has started in the meantime
  app.close(0);
  await look;
  await tick();
  assert.equal(app.runs.length, 0, 'the waiting run found a pass running and stood down');
  assert.equal(app.ctx._kjrAutoRunWaiting, false, 'for good');
  app.ctx._queueRunning = false;
  const again = app.open();
  assert.ok(await app.opened(2));
  app.close(1);
  await again;
  await tick();
  assert.equal(app.runs.length, 0, 'a later lookup does not bring it back');
});

test('auto run: a pass asked for by hand while a lookup is open is refused as ever, and the waiting run is still there for the close', async () => {
  const app = await setup();
  app.ctx.kjrConfirm = async () => true;
  const look = app.open();
  assert.ok(await app.opened(1));
  app.reachMark();
  app.toasts.length = 0;
  await app.ctx.runRefreshQueue(true);
  await app.ctx.bulkRefreshPrices('singles');
  assert.deepEqual(app.toasts, ['A price lookup is running - wait for it to finish first', 'A price lookup is running - wait for it to finish first']);
  assert.deepEqual(app.runs.map((r) => r.args), [[true]], 'only the refused hand call so far');
  assert.equal(app.ctx._kjrAutoRunWaiting, true);
  app.close(0);
  await look;
  await tick();
  assert.deepEqual(app.runs.map((r) => r.args), [[true], [false]], 'then the automatic one, once');
});

test('auto run: a call to runRefreshQueue(false) made directly while a lookup is open stays quiet and sets nothing waiting, only the 8 second mark does', async () => {
  const app = await setup();
  const look = app.open();
  assert.ok(await app.opened(1));
  await app.ctx.runRefreshQueue(false);
  assert.equal(app.ctx._kjrAutoRunWaiting, false);
  assert.deepEqual(app.toasts, []);
  app.close(0);
  await look;
  await tick();
  assert.equal(app.runs.length, 1, 'just the direct call');
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('auto run: the 8 second timer calls _kjrAutoRun, and both places a lookup ends hand over to it after the count goes down', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  assert.match(src, /setTimeout\(\(\) => \{ _kjrAutoRun\(\); \}, 8000\);/, 'the mark goes through _kjrAutoRun');
  assert.ok(!/setTimeout\(\(\) => \{ runRefreshQueue\(false\); \}, 8000\)/.test(src), 'and no longer straight to the queue');
  const body = (name) => {
    const at = src.indexOf('\nasync function ' + name + '(');
    assert.ok(at >= 0, name);
    return src.slice(at, at + 10 + src.slice(at + 10).search(/\n(?:async )?function /));
  };
  for (const fn of ['refreshPrice', 'kjrBudgetedLookup']) {
    assert.match(body(fn), /finally \{\s*_kjrLookupsOpen--;\s*_kjrAutoRunResume\(\);/, fn + ' lets the waiting run go when its lookup ends, whatever happened to it');
  }
  assert.equal((src.match(/_kjrLookupsOpen--/g) || []).length, 2, 'and those are the only two places the count goes down');
  const resume = src.slice(src.indexOf('function _kjrAutoRunResume()'), src.indexOf('async function bulkRefreshPrices('));
  assert.match(resume, /Promise\.resolve\(\)\.then\(_kjrAutoRun\)/, 'after a microtask, so the closing lookup\'s tail comes first');
  assert.ok(!/setInterval|setTimeout/.test(src.slice(src.indexOf('let _kjrAutoRunWaiting'), src.indexOf('async function bulkRefreshPrices('))), 'no timer, no polling');
});
