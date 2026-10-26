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

// ── the scan for writers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Every way a script can write or remove the saved queue's two keys (QUEUE_KEY and QUEUE_DATE_KEY, defined in app.js), found in the source and filed under the top-level
// statement it really sits in. It reads tokens, not lines, so it sees what a line match cannot:
//   - a key named by its constant or by the string it holds, in any call (setItem, removeItem), a bracket assignment, an alias of the storage or of the key, or a call split over lines
//   - saveQueue called, handed on (.then(saveQueue)) or reached through window, and localStorage.clear(), which takes the queue with everything else
//   - comments, strings and regular expressions that only mention a name are skipped, and a call inside a template's ${...} is code
// A hit is filed under the declaration it is inside, found at column 0 and brace depth 0: a function, a class, or a const, let or var holding an arrow, a function expression
// or an object of methods. Code that runs on load (a listener, an IIFE, window.x = ...) has no name and is filed under its own line. The first scan filed a hit under the nearest
// earlier "function" line, so a writer written as a const arrow or a method sat under whichever approved function came before it. A plain read, getItem(KEY), and the two
// definitions are not writers. Every script of the page shares app.js's global scope, so every one of them is scanned (below).
// Its limits: a regular expression straight after ) or } reads as a division, which does no harm unless the pattern holds a quote, a backtick or a brace, and then the scan
// most likely fails to balance and throws, where it would otherwise go quiet. A key built from pieces ('pokeinv_' + 'refresh_queue') or swept by a prefix is out of reach of any source scan.
const QUEUE_NAMES = ['QUEUE_KEY', 'QUEUE_DATE_KEY'];
const QUEUE_STRINGS = ['pokeinv_refresh_queue', 'pokeinv_refresh_queue_date']; // what they hold, so a key spelt out is found too (the credits side record is a third key, not the queue)
const DECLARES = ['const', 'let', 'var'];
const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

// the tokens of a script: ids, numbers, strings (a template with no ${} is a string), punctuation one character at a time, each with its line, its column and the depth of
// the brackets open around it. Comments and regular expression text are dropped, a template's own text is dropped but the code in its ${} is kept
function lexScript(src) {
  const n = src.length;
  const lineStarts = [0];
  for (let k = 0; k < n; k++) if (src.charCodeAt(k) === 10) lineStarts.push(k + 1);
  const lineAt = (pos) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; } return lo; };
  const fail = (what, pos) => { throw new Error('writer scan cannot read the script: ' + what + ' (line ' + (lineAt(pos) + 1) + ')'); };
  const toks = [];
  const open = []; // the brackets still open: { ( [ and ${ (a template's substitution)
  const add = (type, value, pos) => { const ln = lineAt(pos); toks.push({ type, value, pos, line: ln + 1, col: pos - lineStarts[ln], depth: open.length }); };
  // a template's text from `from` to its closing backtick or its next ${
  const templateText = (from) => {
    for (let j = from; j < n; j++) {
      if (src[j] === '\\') j++;
      else if (src[j] === '`') return { end: j + 1, raw: src.slice(from, j), subst: false };
      else if (src[j] === '$' && src[j + 1] === '{') return { end: j + 2, raw: src.slice(from, j), subst: true };
    }
    return fail('a template is never closed', from);
  };
  const idChar = (ch) => /[\w$]/.test(ch) || ch > '\x7f'; // an identifier may hold any letter, so anything past ASCII counts
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); if (end < 0) fail('a comment is never closed', i); i = end + 2; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; else if (src[j] === '\n') fail('a string is never closed', i); j++; }
      if (j >= n) fail('a string is never closed', i);
      add('str', src.slice(i + 1, j), i);
      i = j + 1; continue;
    }
    if (c === '`') {
      const t = templateText(i + 1);
      if (t.subst) { add('tpl', '`', i); open.push('${'); } else add('str', t.raw, i);
      i = t.end; continue;
    }
    if (c === '}' && open[open.length - 1] === '${') { // the end of a substitution: the template's text goes on
      open.pop();
      const t = templateText(i + 1);
      if (t.subst) open.push('${');
      i = t.end; continue;
    }
    if (c >= '0' && c <= '9') { let j = i + 1; while (j < n && /[\w.]/.test(src[j])) j++; add('num', src.slice(i, j), i); i = j; continue; }
    if (idChar(c)) { let j = i + 1; while (j < n && idChar(src[j])) j++; add('id', src.slice(i, j), i); i = j; continue; }
    if (c === '/') { // a regular expression where a value is expected, else a division
      const prev = toks[toks.length - 1];
      if (!prev || (prev.type === 'punct' && !')]}'.includes(prev.value)) || (prev.type === 'id' && REGEX_AFTER.has(prev.value))) {
        let j = i + 1, inClass = false;
        while (j < n && (src[j] !== '/' || inClass)) {
          if (src[j] === '\\') j++;
          else if (src[j] === '[') inClass = true;
          else if (src[j] === ']') inClass = false;
          else if (src[j] === '\n') fail('a regular expression is never closed', i);
          j++;
        }
        if (j >= n) fail('a regular expression is never closed', i);
        j++;
        while (j < n && /[a-z]/.test(src[j])) j++;
        add('regex', src.slice(i, j), i);
        i = j; continue;
      }
    }
    if (c === '{' || c === '(' || c === '[') { add('punct', c, i); open.push(c); i++; continue; }
    if (c === '}' || c === ')' || c === ']') {
      add('punct', c, i);
      if (open.pop() !== { '}': '{', ')': '(', ']': '[' }[c]) fail('unbalanced ' + c, i);
      i++; continue;
    }
    add('punct', c, i); i++;
  }
  if (open.length) fail('a ' + open[open.length - 1] + ' is never closed', n - 1);
  return toks;
}

// what the top-level statement starting at token i is called: the function, class, const, let or var it declares, else its own line
function statementName(toks, i, src) {
  const at = (k) => toks[k] || { type: '', value: '' };
  let k = i;
  if (at(k).type === 'id' && at(k).value === 'async' && at(k + 1).value === 'function') k++;
  if (at(k).type === 'id' && at(k).value === 'function') { k++; if (at(k).value === '*') k++; if (at(k).type === 'id') return at(k).value; }
  else if (at(k).type === 'id' && at(k).value === 'class' && at(k + 1).type === 'id') return at(k + 1).value;
  else if (at(k).type === 'id' && DECLARES.includes(at(k).value) && at(k + 1).type === 'id') return at(k + 1).value;
  const t = toks[i];
  const eol = src.indexOf('\n', t.pos);
  return '<code at line ' + t.line + ': ' + src.slice(t.pos, eol < 0 ? undefined : eol).trim().slice(0, 60) + '>';
}

// whether token i writes or removes the queue, and how: 'key' (a queue key named by its constant or its string, outside a plain read), 'saveQueue' or 'clear'
function queueHitAt(toks, i) {
  const at = (k) => toks[i + k] || { type: '', value: '' };
  const t = at(0), prev = at(-1), next = at(1);
  const read = prev.value === '(' && prev.type === 'punct' && at(-2).type === 'id' && at(-2).value === 'getItem' && next.value === ')' && next.type === 'punct';
  if (t.type === 'id' && t.value === 'saveQueue') return prev.type === 'id' && prev.value === 'function' ? null : 'saveQueue'; // its own declaration is no call
  if (t.type === 'str' && t.value === 'saveQueue') return 'saveQueue'; // window['saveQueue'](q)
  if (t.type === 'id' && QUEUE_NAMES.includes(t.value)) return (prev.type === 'id' && DECLARES.includes(prev.value)) || read ? null : 'key';
  if (t.type === 'str' && QUEUE_STRINGS.includes(t.value)) {
    const defines = prev.value === '=' && QUEUE_NAMES.includes(at(-2).value) && DECLARES.includes(at(-3).value);
    return defines || read ? null : 'key';
  }
  if (t.type === 'id' && t.value === 'localStorage') { // .clear(), ?.clear() and ['clear']()
    const o = next.value === '?' ? 1 : 0;
    if ((at(1 + o).value === '.' && at(2 + o).type === 'id' && at(2 + o).value === 'clear') || (at(1).value === '[' && at(2).type === 'str' && at(2).value === 'clear')) return 'clear';
  }
  return null;
}

// every hit in a script as { line, kind, name }, name being the top-level statement it is inside
function scanQueueWriters(src) {
  const toks = lexScript(src);
  const hits = [];
  let inside = '<before the first statement>';
  toks.forEach((t, i) => {
    const closer = t.type === 'punct' && ')]}'.includes(t.value);
    if (t.depth === 0 && t.col === 0 && !closer && !(t.type === 'id' && ['else', 'catch', 'finally'].includes(t.value))) inside = statementName(toks, i, src);
    const kind = queueHitAt(toks, i);
    if (kind) hits.push({ line: t.line, kind, name: inside });
  });
  return hits;
}

test('queue edit: the writer scan finds every spelling of a write or a removal, and files it under the statement it is really in', () => {
  // an approved function first, so a hit filed under "the function before it" is told apart from one filed under its own statement
  const after = (code) => scanQueueWriters('function loadQueue() {\n  return 1;\n}\n' + code + '\n').map((h) => h.name + ' ' + h.kind);
  // the spellings the first scan missed (it matched saveQueue( and removeItem(QUEUE_KEY) on a line), and the ones it matched
  const SPELLINGS = [
    ['setItem on the key', 'function w() { localStorage.setItem(QUEUE_KEY, "{}"); }', 'w key'],
    ['removeItem on the date key', 'function w() { localStorage.removeItem(QUEUE_DATE_KEY); }', 'w key'],
    ['setItem on the date key', 'function w() { localStorage.setItem(QUEUE_DATE_KEY, "2026-10-26"); }', 'w key'],
    ['the key spelt out, setItem', 'function w() { localStorage.setItem(\'pokeinv_refresh_queue\', "{}"); }', 'w key'],
    ['the date key spelt out, removeItem', 'function w() { localStorage.removeItem("pokeinv_refresh_queue_date"); }', 'w key'],
    ['the key in a template with nothing in it', 'function w() { localStorage.setItem(`pokeinv_refresh_queue`, "{}"); }', 'w key'],
    ['a bracket assignment', 'function w() { localStorage[QUEUE_KEY] = "{}"; }', 'w key'],
    ['a delete through brackets', 'function w() { delete localStorage[QUEUE_DATE_KEY]; }', 'w key'],
    ['through window (the first scan found this one too)', 'function w() { window.localStorage.removeItem(QUEUE_KEY); }', 'w key'],
    ['a call split over lines', 'function w() {\n  localStorage.setItem(\n    QUEUE_KEY,\n    "{}"\n  );\n}', 'w key'],
    ['an alias of the storage', 'function w() { const s = localStorage; s.setItem(QUEUE_KEY, "{}"); }', 'w key'],
    ['an alias of the key', 'function w() { const k = QUEUE_KEY; localStorage.removeItem(k); }', 'w key'],
    ['removeItem on the key (the first scan found this one too)', 'function w() { localStorage.removeItem(QUEUE_KEY); }', 'w key'],
    ['saveQueue called (the first scan found this one too)', 'function w(q) { saveQueue(q); }', 'w saveQueue'],
    ['saveQueue handed on', 'function w(q) { return Promise.resolve(q).then(saveQueue); }', 'w saveQueue'],
    ['saveQueue through window (the first scan found this one too)', 'function w(q) { window.saveQueue(q); }', 'w saveQueue'],
    ['saveQueue through a string', 'function w(q) { window["saveQueue"](q); }', 'w saveQueue'],
    ['saveQueue inside a template', 'const w = `<p>${saveQueue(q)}</p>`;', 'w saveQueue'],
    ['localStorage.clear()', 'function w() { localStorage.clear(); }', 'w clear'],
    ['localStorage?.clear()', 'function w() { localStorage?.clear(); }', 'w clear'],
    ['localStorage["clear"]()', 'function w() { window.localStorage["clear"](); }', 'w clear'],
  ];
  for (const [label, code, want] of SPELLINGS) assert.deepEqual(after(code), [want], label);
  // the ways a top-level statement can be written, each holding one write: the hit belongs to the statement, never to loadQueue above it
  const SHAPES = [
    ['a const holding an arrow', 'const w = (q) => {\n  saveQueue(q);\n};'],
    ['a const holding an async arrow', 'const w = async (q) => {\n  saveQueue(q);\n};'],
    ['a let holding a function expression', 'let w = function () {\n  saveQueue(q);\n};'],
    ['a var holding a named function expression', 'var w = function inner() {\n  saveQueue(q);\n};'],
    ['a method of an object held by a const', 'const w = {\n  other: 1,\n  go() {\n    saveQueue(q);\n  },\n};'],
    ['a property function of an object held by a const', 'const w = {\n  go: function () { localStorage.removeItem(QUEUE_KEY); },\n};'],
    ['a method of a class', 'class w {\n  go() {\n    saveQueue(q);\n  }\n}'],
    ['an async function', 'async function w() {\n  saveQueue(q);\n}'],
    ['a generator', 'function* w() {\n  saveQueue(q);\n}'],
    ['a function inside a function', 'function w() {\n  function inner() {\n    saveQueue(q);\n  }\n}'],
  ];
  for (const [label, code] of SHAPES) assert.deepEqual(after(code).map((s) => s.split(' ')[0]), ['w'], label);
  // code that runs on load has no name: it is filed under its own line, which is line 4 here
  const LOADED = [
    ['a property of window', 'window.w = function () {\n  saveQueue(q);\n};', 'window.w = function () {'],
    ['a listener', "document.addEventListener('click', () => {\n  saveQueue(q);\n});", "document.addEventListener('click', () => {"],
    ['an IIFE', '(function () {\n  saveQueue(q);\n})();', '(function () {'],
    ['an if', 'if (ok) {\n  saveQueue(q);\n}', 'if (ok) {'],
  ];
  for (const [label, code, line] of LOADED) assert.deepEqual(after(code).map((s) => s.split(' saveQueue')[0]), ['<code at line 4: ' + line + '>'], label);
  // two hits in one statement are two entries under one name (clearQueue drops both keys)
  assert.deepEqual(scanQueueWriters('function clearQueue() {\n  localStorage.removeItem(QUEUE_KEY); localStorage.removeItem(QUEUE_DATE_KEY);\n}').map((h) => h.name + ' ' + h.kind), ['clearQueue key', 'clearQueue key']);
});

test('queue edit: the writer scan stays quiet for what is no writer, and does not lose its place in strings, templates, regular expressions and divisions', () => {
  const QUIET = [
    ['a comment line', '// saveQueue(q) and localStorage.setItem(QUEUE_KEY, x)'],
    ['a trailing comment', 'const a = 1; // saveQueue(q) and localStorage.removeItem(QUEUE_DATE_KEY)'],
    ['a block comment', '/* saveQueue(q);\n   localStorage.removeItem(QUEUE_KEY); */'],
    ['a string that only mentions it', "const a = 'call saveQueue(q) or localStorage.setItem(QUEUE_KEY, x) here';"],
    ['text in a template', 'const a = `<button onclick="saveQueue(q)">${x}</button> localStorage.clear()`;'],
    ['a regular expression', 'const a = /saveQueue\\(|QUEUE_KEY/.test(s);'],
    ['a read by the constant', "function w() { return JSON.parse(localStorage.getItem(QUEUE_KEY) || 'null'); }"],
    ['a read by the string', "function w() { return localStorage.getItem('pokeinv_refresh_queue'); }"],
    ['the two definitions', "const QUEUE_KEY = 'pokeinv_refresh_queue';\nconst QUEUE_DATE_KEY = 'pokeinv_refresh_queue_date';"],
    ['the declaration of saveQueue, and a longer name that starts with it', 'function saveQueue(q) { return q; }\nasync function saveQueue2(q) { return q; }'],
    ['the credits side record, which is not the queue', "function w() { localStorage.setItem('pokeinv_refresh_queue_credits', '{}'); localStorage.removeItem(KJR_CREDITS_STASH_KEY); }"],
    ['another key', "function w() { localStorage.setItem('pokeinv_ppt_plan', 'paid'); localStorage.removeItem('kjr_price_cache'); }"],
    ['a property that is not the function', 'function w(o) { return o.save + o.saveQueueAt; }'],
  ];
  for (const [label, code] of QUIET) assert.deepEqual(scanQueueWriters(code), [], label);
  // a quote, a backtick or slashes inside a regular expression, a division, a template within a template: none may swallow or shift the writer that follows
  const TRAPS = [
    ['a quote in a regular expression', "const r = /'[^']*/g;\nfunction w() { saveQueue(q); }"],
    ['a backtick in a regular expression', 'const r = /`+/g;\nfunction w() { saveQueue(q); }'],
    ['slashes in a regular expression', 'const r = /https?:\\/\\/[^/]+\\//;\nfunction w() { saveQueue(q); }'],
    ['a slash inside a character class', 'const r = /[/]x/;\nfunction w() { saveQueue(q); }'],
    ['divisions', 'const a = b / 2, c = d / 3 / e;\nfunction w() { saveQueue(q); }'],
    ['a division after a bracket', 'const a = (b + 1) / 2 + c[0] / 3;\nfunction w() { saveQueue(q); }'],
    ['a regular expression after return', 'function v() { return /\'/.test(s); }\nfunction w() { saveQueue(q); }'],
    ['a template inside a template', 'const t = `a ${`b ${c}`} d`;\nfunction w() { saveQueue(q); }'],
    ['braces in strings and templates', "const t = '}{' + `}{ ${x}`;\nfunction w() { saveQueue(q); }"],
    ['an escaped quote', "const t = 'it\\'s';\nfunction w() { saveQueue(q); }"],
  ];
  for (const [label, code] of TRAPS) assert.deepEqual(scanQueueWriters(code).map((h) => h.name + ' ' + h.kind + ' ' + h.line), ['w saveQueue 2'], label);
  // a script it cannot read is an error, not a clean bill
  assert.throws(() => scanQueueWriters('function w() {\n  saveQueue(q);\n'), /never closed/);
  assert.throws(() => scanQueueWriters('function w() {\n  saveQueue(q);\n}}'), /unbalanced/);
  assert.throws(() => scanQueueWriters("const a = 'saveQueue;"), /string is never closed/);
  assert.throws(() => scanQueueWriters('const a = `saveQueue'), /template is never closed/);
  assert.throws(() => scanQueueWriters('const a = /saveQueue'), /regular expression is never closed/);
  assert.throws(() => scanQueueWriters('const a = 1; /* saveQueue'), /comment is never closed/);
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('queue edit: every writer of the saved queue is known, and the two that replace or drop it ask _kjrQueueEditBlocker before and after the question', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const hits = scanQueueWriters(src);
  const where = hits.map((h) => h.name + ' (line ' + h.line + ', ' + h.kind + ')').join(', ');
  // saveQueue is the primitive the others write through, each caller is listed below, so it holds one setItem of the queue key and nothing else
  assert.deepEqual(hits.filter((h) => h.name === 'saveQueue').map((h) => h.kind), ['key'], 'saveQueue is a single write of the queue key: ' + where);
  const writers = new Set(hits.filter((h) => h.name !== 'saveQueue').map((h) => h.name));
  // A new writer fails this on purpose: read it against _kjrQueueEditBlocker (does it hold the queue in memory, does it replace or drop it) before adding it here.
  // kjrPptSetPlan: one field, read and written in one step, and it is never refused for a holder (the plan is the owner's setting), so since v3.95 it clears that field on
  // the copy a running pass or bulk run holds as well (_kjrHeldQueue), or the holder's next save put the pause back (tests/plan-change.test.js). A one-step write alone was
  // not enough.  loadQueue: drops a queue of an old schema, setting its credits aside.  The pass and the bulk run own the queue while their flag is up.  _kjrBillLookup:
  // read, added to and written in one step after the answer, and never under a holder (kjrLookupRefusal says running).  startFreshQueue and clearQueue are the two that
  // this suite guards.
  assert.deepEqual([...writers].sort(), ['_kjrBillLookup', '_runRefreshQueueBody', 'bulkRefreshPrices', 'clearQueue', 'kjrPptSetPlan', 'loadQueue', 'runRefreshQueue', 'startFreshQueue'], 'found: ' + where);
  // every script the page loads shares app.js's global scope, saveQueue and the keys included, so a writer in any of them is a writer: the others have none
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script src="([A-Za-z0-9_./-]+)\?v=[^"]*"><\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.includes('app.js') && scripts.includes('features.js') && scripts.length >= 7, 'the page loads ' + scripts.join(', '));
  for (const file of scripts.filter((f) => f !== 'app.js')) {
    assert.deepEqual(scanQueueWriters(fs.readFileSync(ROOT + '/' + file, 'utf8')), [], file + ' never writes or removes the saved queue');
  }
  const body = (name) => {
    const at = src.indexOf('function ' + name + '(');
    assert.ok(at >= 0, name);
    return src.slice(at, at + 10 + src.slice(at + 10).search(/\n(?:async )?function /));
  };
  assert.match(body('kjrPptSetPlan'), /_kjrHeldQueue\.creditsPausedDate = null;/, 'the plan change clears the pause on the held copy too (v3.95), the one-step write alone is not its approval');
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
