'use strict';
// v3.92, one pace for every PokemonPriceTracker request. The plan's gap (kjrRequestGapMs: 6 seconds Free, 1.1 Paid) was kept only by the queue and a bulk
// run, which sleep it after each answer. The card inspector's Refresh price, the price lookup and Test Keys sent theirs the moment they were asked, so two in
// a row (or one straight after a pass) went out back to back, the pattern that got the free key blocked for 24 hours at 1.1 seconds. Now _pptSearch, the one
// place a PPT URL is built and fetched, waits at a gate (_kjrPptPace) until the gap since the last request has gone:
//   - the gap counts from the last request's answer, so a caller that has slept it already (the queue, a bulk run) finds it gone and adds no wait
//   - a hand action (a lookup or a card refresh in flight) says why it waits in a toast, a pass stays quiet
//   - TCGdex never comes here
// This is the one suite that runs the real gate (loadApp({ pace: true })), every other suite gets a gate that lets requests through (tests/harness.js).
// Time here is fake. Date is a clock the test moves (tests/clock.js), and a wait the app asks for passes only when the test fires it, which moves the clock on
// to the moment the wait would have ended. Only the waits that matter are taken over: the gate's own and the plan's gap that a pass sleeps. The app's other timers
// stay where the harness leaves them, never fired. Fetch is stubbed (tests/harness.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, ROOT } = require('./harness.js');
const { setClock } = require('./clock.js');

const START = '2026-10-25T04:00:00Z';
const GAP = { free: 6000, paid: 1100 };
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total } } });

// "Alpha 1" is card number 1: TCGdex knows it as set-1 (only when a test gives it a price), the vendor prices the PSA 10 slab at US$101 (the slab costs 500, so
// the price guard has nothing to say) and finds the plain card at US$7. A slab's search is the eBay one (6 credits), the old name search costs 3.
const enRow = (id, name, extra) => Object.assign({ id, name, language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabRow = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 500, marketPrice: '', priceHistory: [] }, extra);
const numbered = (search) => /^(.+?) (\d+)(?:\/\d+)?$/.exec(search || '');
const slabCard = (search) => {
  const m = numbered(search);
  return m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};
const plainCard = (search) => {
  const m = numbered(search);
  return m ? { id: 'p-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', prices: { market: 7 } } : null;
};
const pptReply = (url) => {
  const u = new URL(url);
  const search = u.searchParams.get('search');
  if (u.searchParams.get('includeEbay') === 'true') return answer([slabCard(search)].filter(Boolean), 6);
  return answer([plainCard(search)].filter(Boolean), 3);
};
// TCGdex: a card number N resolves to set-N, whose TCGplayer market is prices['set-N'] (a card with no price is a miss)
function tcgdex(fetchMock, prices) {
  fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) return prices['set-' + decodeURIComponent(list[2])] ? jsonResponse([{ id: 'set-' + decodeURIComponent(list[2]) }]) : jsonResponse([]);
    const card = url.match(/\/cards\/(set-\d+)$/);
    if (card) return prices[card[1]] ? jsonResponse({ id: card[1], pricing: { tcgplayer: { holofoil: { marketPrice: prices[card[1]] } } } }) : jsonResponse({}, 404);
    return jsonResponse({}, 404);
  });
}

// is the code asking for this timer the gate? (the gate's sleep is the one timer the app asks for from inside _kjrPptPace)
const fromGate = () => /_kjrPptPace/.test(new Error().stack);

async function setup(seed, opts) {
  const o = Object.assign({ plan: 'free', prices: {}, ppt: pptReply, jaLane: true }, opts || {});
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), jaLane: o.jaLane, pace: true, localStorage: o.plan === 'paid' ? { pokeinv_ppt_plan: 'paid' } : {} });
  const clock = setClock(app, START);
  const gapMs = GAP[o.plan];
  app.clock = clock;
  app.gapMs = gapMs;
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.waited = () => app.toasts.filter((t) => /^Waiting/.test(t));
  app.ctx.kjrConfirm = async () => true;
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  tcgdex(app.fetchMock, o.prices);
  app.sent = []; // the fake time of every PPT request, as it went out
  app.fetchMock.route('/ppt/cards', (url, opts) => { app.sent.push(clock.now); return o.ppt(url, opts); });
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.row = (table, id) => app.ctx.DB[table].find((r) => r.id === id);
  // the gate, watched: how long each request was held back (fake ms)
  app.gate = [];
  const realGate = app.sandbox._kjrPptPace;
  app.sandbox._kjrPptPace = async () => {
    const from = clock.now;
    await realGate();
    app.gate.push(clock.now - from);
  };
  // the waits that matter are the gate's own sleeps (asked for from inside _kjrPptPace) and the plan's gap a pass sleeps, they pass when the test fires them
  const harnessTimeout = app.sandbox.setTimeout;
  const pending = new Set();
  app.sleeps = []; // the length of every wait taken over, in the order asked for
  app.sandbox.setTimeout = (fn, ms, ...rest) => {
    if (ms !== gapMs && !fromGate()) return harnessTimeout(fn, ms, ...rest);
    app.sleeps.push(ms);
    const dueAt = clock.now + ms;
    const id = app.timers.setTimeoutShim(() => { if (clock.now < dueAt) clock.set(dueAt); fn(...rest); }, ms);
    pending.add(id);
    return id;
  };
  app.fire = () => { let n = 0; for (const id of [...pending]) { pending.delete(id); if (app.timers.invoke(id)) n++; } return n; };
  // run a started call to its end, passing every wait it makes
  app.until = async (p) => {
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 600 && !done; i++) {
      await new Promise((r) => setImmediate(r));
      app.fire();
    }
    if (!done) throw new Error('the call did not finish');
    return p;
  };
  app.lookup = (text) => { app.document.getElementById('ebay-query').value = text; return app.ctx.searchEbay(); };
  return app;
}

// ── a hand action straight after another ────────────────────────────────────────────────────────────────────────────────────────────────

for (const plan of ['free', 'paid']) {
  test('ppt-pacing: a card refresh straight after another waits the ' + plan + ' plan\'s gap and says so, the first request of all waits for nothing', async () => {
    const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] }, { plan });
    await app.until(app.ctx.refreshPrice('s1', 'slabs'));
    assert.deepEqual(app.gate, [0], 'nothing was asked before it');
    assert.deepEqual(app.waited(), []);
    app.clock.add(300);
    await app.until(app.ctx.refreshPrice('s2', 'slabs'));
    assert.deepEqual(app.gate, [0, app.gapMs - 300], 'the second was held back for what was left of the gap');
    assert.equal(app.sent.length, 2);
    assert.equal(app.sent[1] - app.sent[0], app.gapMs, 'and went out exactly one gap after the first');
    const left = app.gapMs - 300;
    const label = plan === 'free' ? 'Free' : 'Paid';
    assert.deepEqual(app.waited(), ['Waiting ' + Math.ceil(left / 1000) + ' second' + (Math.ceil(left / 1000) === 1 ? '' : 's') + ' to keep within the ' + label + ' plan\'s pace']);
    assert.equal(app.row('slabs', 's2').marketPrice, '102', 'and the card was priced all the same');
    assert.equal(app.ctx._kjrLookupsOpen, 0);
  });
}

test('ppt-pacing: the toast is plain words, rounds up to whole seconds, and a wait nobody would notice is slept without one', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2'), slabRow('s3', 'Charlie 3'), slabRow('s4', 'Delta 4')] }, { plan: 'paid' });
  await app.until(app.ctx.refreshPrice('s1', 'slabs'));
  app.clock.add(500);
  await app.until(app.ctx.refreshPrice('s2', 'slabs'));
  assert.deepEqual(app.waited(), ['Waiting 1 second to keep within the Paid plan\'s pace'], 'a wait of 0.6 seconds reads as one second, in the singular');
  app.toasts.length = 0;
  app.clock.add(700);
  await app.until(app.ctx.refreshPrice('s3', 'slabs'));
  assert.equal(app.gate[2], 400, 'the third waited 0.4 seconds');
  assert.deepEqual(app.waited(), [], 'and said nothing, under half a second');
  const free = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] });
  await free.until(free.ctx.refreshPrice('s1', 'slabs'));
  await free.until(free.ctx.refreshPrice('s2', 'slabs'));
  assert.deepEqual(free.waited(), ['Waiting 6 seconds to keep within the Free plan\'s pace']);
  for (const t of [...app.waited(), ...free.waited(), 'Waiting 1 second to keep within the Paid plan\'s pace']) assert.doesNotMatch(t, new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ';]'), t);
});

test('ppt-pacing: once the gap has gone nothing waits, and a gap that has half gone waits the other half', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2'), slabRow('s3', 'Charlie 3')] });
  await app.until(app.ctx.refreshPrice('s1', 'slabs'));
  app.clock.add(6000);
  await app.until(app.ctx.refreshPrice('s2', 'slabs'));
  assert.deepEqual(app.gate, [0, 0], 'a whole gap later, no wait at all');
  assert.deepEqual(app.waited(), []);
  app.clock.add(3000);
  await app.until(app.ctx.refreshPrice('s3', 'slabs'));
  assert.deepEqual(app.gate, [0, 0, 3000]);
  assert.deepEqual(app.sent.slice(1).map((t, i) => t - app.sent[i]), [6000, 6000]);
});

test('ppt-pacing: the price lookup and Test Keys wait the gap too, whichever of them comes first or after a card refresh', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1')] });
  await app.until(app.lookup('Alpha 1'));
  assert.equal(app.sent.length, 1, 'TCGdex missed, so the fuzzy search went to the vendor');
  await app.until(app.ctx.refreshPrice('s1', 'slabs'));
  await app.until(app.ctx.testApiKeys());
  await app.until(app.lookup('Alpha 1'));
  const diffs = app.sent.slice(1).map((t, i) => t - app.sent[i]);
  assert.ok(app.sent.length >= 4);
  assert.ok(diffs.every((d) => d === 6000), 'each one exactly a gap after the one before: ' + diffs);
  assert.ok(app.waited().length >= 3, 'and each said why it waited: ' + JSON.stringify(app.toasts));
});

test('ppt-pacing: the fuzzy search\'s second request, the one with the number dropped, waits the gap as well', async () => {
  // the vendor knows the base name only: the full name finds nothing, so the search tries again without the number
  const app = await setup({}, { ppt: (url) => answer(new URL(url).searchParams.get('search') === 'Alpha' ? [plainCard('Alpha 1')] : [], 3) });
  await app.until(app.lookup('Alpha 1'));
  assert.deepEqual(app.ppt().map((c) => new URL(c.url).searchParams.get('search')), ['Alpha 1', 'Alpha']);
  assert.equal(app.sent[1] - app.sent[0], 6000, 'a lookup that makes two requests keeps the gap between its own two');
  assert.deepEqual(app.gate, [0, 6000]);
});

// ── a TCGdex answer never waits ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-pacing: a TCGdex-only refresh never waits, straight after a slab refresh or on its own, and neither does a lookup that TCGdex answers', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1')], singles: [enRow('e1', 'Alpha 1'), enRow('e2', 'Alpha 1')] }, { prices: { 'set-1': 12 } });
  await app.until(app.ctx.refreshPrice('s1', 'slabs'));
  assert.deepEqual(app.gate, [0]);
  await app.until(app.ctx.refreshPrice('e1', 'singles'));
  await app.until(app.lookup('Alpha 1'));
  await app.until(app.ctx.refreshPrice('e2', 'singles'));
  assert.equal(app.row('singles', 'e1').marketPrice, '12', 'the English single was priced');
  assert.equal(app.row('singles', 'e2').marketPrice, '12');
  assert.match(app.document.getElementById('ebay-out').innerHTML, /Market Price \(TCGdex/, 'and the lookup was answered by TCGdex');
  assert.deepEqual(app.gate, [0], 'none of them reached the gate');
  assert.equal(app.ppt().length, 1, 'only the slab asked the vendor');
  assert.deepEqual(app.waited(), []);
  assert.deepEqual(app.sleeps, [], 'and no wait was taken at all');
});

test('ppt-pacing: a Japanese refusal is no request, so it neither waits nor moves the gap', async () => {
  const app = await setup({}, { jaLane: false });
  assert.deepEqual(app.toasts, []);
  const refused = await app.ctx._pptSearch('Monaa SV8a', { japanese: true });
  assert.equal(refused.transport, 'Japanese lane is off');
  assert.deepEqual(app.gate, [], 'the gate is after the lane\'s switch');
  assert.equal(app.ctx._kjrPptLastAt, 0, 'and nothing was stamped for a request that was never made');
  assert.equal(app.ppt().length, 0);
});

// ── the queue and a bulk run are not made to wait twice ─────────────────────────────────────────────────────────────────────────────────

for (const plan of ['free', 'paid']) {
  test('ppt-pacing: a queue request after its own ' + plan + ' plan sleep adds no wait of the gate\'s, and the first one waits for nothing', async () => {
    const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2'), slabRow('s3', 'Charlie 3')] }, { plan });
    await app.until(app.ctx.runRefreshQueue(true));
    assert.equal(app.sent.length, 3, 'three searches, one per slab');
    assert.deepEqual(app.gate, [0, 0, 0], 'the gate held none of them back');
    assert.deepEqual(app.sent.slice(1).map((t, i) => t - app.sent[i]), [app.gapMs, app.gapMs], 'each went out exactly the gap after the last, the queue\'s own sleep');
    assert.deepEqual(app.sleeps, [app.gapMs, app.gapMs, app.gapMs], 'and the only waits were the queue\'s: one gap after each card');
    assert.deepEqual(app.waited(), []);
    assert.equal(app.row('slabs', 's3').marketPrice, '103');
  });

  test('ppt-pacing: a bulk run\'s own ' + plan + ' plan sleep is not doubled either', async () => {
    const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2'), slabRow('s3', 'Charlie 3')] }, { plan });
    await app.until(app.ctx.bulkRefreshPrices('slabs'));
    assert.equal(app.sent.length, 3);
    assert.deepEqual(app.gate, [0, 0, 0]);
    assert.deepEqual(app.sent.slice(1).map((t, i) => t - app.sent[i]), [app.gapMs, app.gapMs]);
    assert.deepEqual(app.sleeps, [app.gapMs, app.gapMs], 'a bulk run sleeps before each request after the first, and only that');
    assert.equal(app.row('slabs', 's3').marketPrice, '103');
  });
}

test('ppt-pacing: a pass that starts straight after a card refresh waits the rest of the gap for its first request, silently, and then paces itself', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] });
  await app.until(app.ctx.refreshPrice('s1', 'slabs'));
  app.clock.add(1000);
  app.toasts.length = 0;
  await app.until(app.ctx.runRefreshQueue(true));
  assert.deepEqual(app.gate, [0, 5000, 0], 'the queue\'s first request waited the rest of the gap, its second found it gone');
  assert.deepEqual(app.waited(), [], 'a pass shows its progress bar, it does not toast');
  assert.deepEqual(app.sent.slice(1).map((t, i) => t - app.sent[i]), [6000, 6000]);
});

// ── every caller, one after another ─────────────────────────────────────────────────────────────────────────────────────────────────────

for (const plan of ['free', 'paid']) {
  test('ppt-pacing (' + plan + '): the lookup, a card refresh, Test Keys, the queue and a bulk run, each straight after the last, are never closer than the plan\'s gap and never doubled', async () => {
    const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] }, { plan });
    const steps = [];
    const step = async (name, hand, run) => {
      const sent = app.sent.length, said = app.toasts.length;
      await app.until(run());
      steps.push({ name, hand, requests: app.sent.length - sent, told: app.toasts.slice(said).filter((t) => /^Waiting/.test(t)).length });
    };
    await step('lookup', true, () => app.lookup('Alpha 1'));
    await step('card refresh', true, () => app.ctx.refreshPrice('s1', 'slabs'));
    await step('test keys', true, () => app.ctx.testApiKeys());
    await step('queue', false, () => app.ctx.runRefreshQueue(true));
    await step('bulk run', false, () => app.ctx.bulkRefreshPrices('slabs'));
    await step('card refresh again', true, () => app.ctx.refreshPrice('s2', 'slabs'));
    for (const s of steps) assert.ok(s.requests >= 1, s.name + ' reached the vendor');
    const diffs = app.sent.slice(1).map((t, i) => t - app.sent[i]);
    assert.ok(app.sent.length >= 8, 'a good many requests: ' + app.sent.length);
    assert.ok(diffs.every((d) => d === app.gapMs), 'every request exactly one gap after the one before, never closer and never two gaps: ' + diffs);
    assert.equal(steps[0].told, 0, 'the very first request had nothing to wait for');
    for (const s of steps.slice(1)) {
      if (s.hand) assert.ok(s.told >= 1, s.name + ' said why it waited');
      else assert.equal(s.told, 0, s.name + ' is a pass and stays quiet');
    }
    assert.equal(app.ctx._kjrLookupsOpen, 0);
    assert.equal(app.ctx._queueRunning || app.ctx._bulkRefreshRunning, false);
  });
}

// ── how the gate behaves ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-pacing: two callers at once take turns, the second goes one gap after the first, not with it', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] });
  await app.until(Promise.all([app.ctx.refreshPrice('s1', 'slabs'), app.ctx.refreshPrice('s2', 'slabs')]));
  assert.equal(app.sent.length, 2);
  assert.equal(app.sent[1] - app.sent[0], 6000);
  assert.deepEqual(app.gate.slice().sort((a, b) => a - b), [0, 6000]);
  assert.equal(app.row('slabs', 's1').marketPrice, '101');
  assert.equal(app.row('slabs', 's2').marketPrice, '102');
  assert.equal(app.ctx._kjrLookupsOpen, 0);
});

test('ppt-pacing: a request that waits measures again when it wakes, so the answer of the one in front moves its turn back to a gap after that answer', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  let n = 0;
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] }, { ppt: (url) => (++n === 1 ? slow.then(() => pptReply(url)) : pptReply(url)) });
  const first = app.ctx.refreshPrice('s1', 'slabs');
  const second = app.ctx.refreshPrice('s2', 'slabs'); // it is asleep until a gap after the first went out
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  assert.equal(app.sent.length, 1, 'only the first has gone, the second is asleep');
  app.clock.add(5000);
  release(); // the first answer comes in at 5 seconds, so the second is owed until a gap after that: 11 seconds
  await app.until(Promise.all([first, second]));
  assert.equal(app.sent[1] - app.sent[0], 11000, 'a gap after the first answer, not after the first request');
  assert.deepEqual(app.gate.slice().sort((a, b) => a - b), [0, 11000], 'one sleep to six seconds and a second one of five');
  assert.deepEqual(app.sleeps, [6000, 5000]);
});

test('ppt-pacing: a request that fails still counts, the next one waits the gap after it', async () => {
  let n = 0;
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] }, { ppt: (url) => (++n === 1 ? jsonResponse({}, 503) : pptReply(url)) });
  await app.until(app.ctx.refreshPrice('s1', 'slabs'));
  assert.equal(app.row('slabs', 's1').marketPrice, '', 'the 503 priced nothing');
  await app.until(app.ctx.refreshPrice('s2', 'slabs'));
  assert.deepEqual(app.gate, [0, 6000]);
  const down = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] }, { ppt: (url) => { throw new TypeError('offline'); } });
  await down.until(down.ctx.refreshPrice('s1', 'slabs'));
  await down.until(down.ctx.refreshPrice('s2', 'slabs'));
  assert.deepEqual(down.gate, [0, 6000], 'a request that threw is a request too');
});

test('ppt-pacing: a clock set back waits one gap, never the hours it was set back by', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] });
  await app.until(app.ctx.refreshPrice('s1', 'slabs'));
  app.clock.add(-3 * 3600 * 1000);
  await app.until(app.ctx.refreshPrice('s2', 'slabs'));
  assert.deepEqual(app.gate, [0, 6000]);
  assert.equal(app.sent.length, 2);
});

test('ppt-pacing: a clock that never moves can not make a request spin, it goes after the most sleeps one request may take', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Alpha 1'), slabRow('s2', 'Bravo 2')] });
  await app.until(app.ctx.refreshPrice('s1', 'slabs'));
  let asked = 0;
  const before = app.sandbox.setTimeout;
  app.sandbox.setTimeout = (fn, ms, ...rest) => { // every wait the gate asks for ends at once and the clock stays put
    if (!fromGate()) return before(fn, ms, ...rest);
    asked++;
    Promise.resolve().then(fn);
    return 0;
  };
  await app.ctx.refreshPrice('s2', 'slabs');
  assert.equal(asked, app.ctx.KJR_PPT_PACE_ROUNDS, 'it slept the most it may, then went');
  assert.equal(app.sent.length, 2, 'and the request was made');
  assert.equal(app.waited().length, 1, 'one toast, not one per round');
});

// ── nothing reaches the vendor around the gate ──────────────────────────────────────────────────────────────────────────────────────────

test('ppt-pacing: the vendor is reached from one function, which waits at the gate before it sends, and every caller comes through it', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'); // the comment lines off, a URL in code keeps its slashes
  assert.equal((code.match(/\/ppt\/cards/g) || []).length, 1, 'the Worker\'s route is built once');
  assert.equal((code.match(/pokemonpricetracker\.com\/api\/v2/g) || []).length, 1, 'and so is the vendor\'s own, for a local key');
  const at = code.indexOf('async function _pptSearch(');
  const body = code.slice(at, code.indexOf('\n}\n', at));
  assert.equal((body.match(/\bfetch\(/g) || []).length, 1, 'one fetch in it');
  assert.ok(body.indexOf('/ppt/cards') > body.indexOf('await _kjrPptPace();'), 'built after the gate');
  assert.ok(body.indexOf('await _kjrPptPace();') > body.indexOf('Japanese lane is off'), 'and the gate is after the switch that refuses a request');
  assert.ok(body.indexOf('await fetch(') > body.indexOf('await _kjrPptPace();'));
  const gateEnd = body.indexOf('await _kjrPptPace();') + 'await _kjrPptPace();'.length;
  assert.doesNotMatch(body.slice(gateEnd, body.indexOf('await fetch(')), /\bawait\b/, 'nothing between the gate and the send waits');
  assert.match(body, /finally \{\s*_kjrPptStamp\(\);/, 'and the answer, or its failure, moves the stamp');
  // the callers: _pptSearch is called by the two PPT fetchers, they by the router, the router by the five callers the budget suite pins
  const calls = (name) => {
    const found = [];
    for (let i = code.indexOf(name + '('); i >= 0; i = code.indexOf(name + '(', i + 1)) {
      if (/function\s+$/.test(code.slice(Math.max(0, i - 20), i))) continue; // the declaration
      const fn = code.lastIndexOf('\nasync function ', i);
      found.push(code.slice(fn + 16, code.indexOf('(', fn)));
    }
    return found;
  };
  assert.deepEqual(calls('_pptSearch'), ['fetchJapanesePriceFromPPT', 'fetchPriceFromPPT']);
  assert.deepEqual(calls('fetchJapanesePriceFromPPT'), ['fetchMarketPrice']);
  assert.deepEqual(calls('fetchPriceFromPPT'), ['fetchMarketPrice', 'fetchMarketPrice']);
  for (const file of ['features.js', 'dealer-money.js', 'dealer-desk.js', 'dealer-ui.js', 'dealer-store.js', 'dealer-production-ui.js']) {
    assert.doesNotMatch(fs.readFileSync(ROOT + '/' + file, 'utf8'), /\/ppt\/|pokemonpricetracker\.com\/api\/v2|_pptSearch/, file + ' never builds a PPT request');
  }
});
