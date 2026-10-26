'use strict';
// v3.96, a bulk run prices and writes the live row, checks the budget on the day the request goes out on, and reports the plan that decided a stop.
//   - bulkRefreshPrices kept the row objects it read before its question, and the question can stay open as long as the owner likes, the run itself lasts hours on the
//     Paid plan. A storage event from another tab (mergeIntoMemory) or a cloud pull swaps in new row objects, and a row is sold or trashed meanwhile. The run priced the
//     old object all the same (up to 6 credits on a Sold card), wrote the price on the detached copy, called markDirty on the live row (which never got it) and counted
//     it as updated. Now the list holds ids (_kjrBulkWork), is made again after the yes, and each row is read from its table as its turn comes and once more as its
//     price is written (_kjrBulkRow): gone or no longer Available, it is left out and counted, and it is priced on the lane it has at that moment
//   - the end toast fixed the limit and the plan after the yes, while the budget check read the plan live: after a switch to Free mid-run it read
//     "90 of 18,000 on the Paid plan". Now a stop at the budget quotes the plan and limit that decided it
//   - the budget check read the day before the gap, the request and its bill the day after it: a reset inside the gap stopped the run at the old day's spent budget
//     although the request would have gone out on the new day with full credits. Now the day is read once the gap is over and the check is made on it
// Fetch is stubbed (tests/harness.js) and the clock is faked (tests/clock.js), nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const nodeTest = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, plain, ROOT } = require('./harness.js');
const { setClock } = require('./clock.js');

const test = (name, fn) => nodeTest(name, { timeout: 30000 }, fn);
const QUEUE_KEY = 'pokeinv_refresh_queue';
const D1 = '2026-10-25';
const D2 = '2026-10-26';
const BEFORE = '2026-10-25T23:59:30Z'; // 07:59:30 on 26/10 in Singapore, the vendor's day is still the 25th
const AFTER = '2026-10-26T00:00:30Z';  // 08:00:30, the credits have reset
const LATER = '2030-01-01T00:00:00.000Z'; // an _updatedAt newer than any row the tests seed, so a merged copy wins (_rowTime)
const fmt = (n) => Number(n).toLocaleString('en-GB');
const enRow = (id, name, extra) => Object.assign({ id, name, language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabRow = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 500, marketPrice: '', priceHistory: [] }, extra);
// "Card N" is slab number N, which the vendor prices at 100 plus N
const slabs = (n) => Array.from({ length: n }, (_, i) => slabRow('s' + (i + 1), 'Card ' + (i + 1)));
const slabCard = (search) => {
  const m = /^(.+) (\d+)$/.exec(search || '');
  return m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};
const searchOf = (c) => new URL(c.url).searchParams.get('search');

async function setup(seed, opts) {
  const o = Object.assign({ plan: 'free', at: BEFORE, hold: false }, opts || {});
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), jaLane: true });
  app.clock = setClock(app, o.at);
  if (o.plan === 'paid') assert.equal(app.ctx.kjrPptSetPlan('paid'), true);
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  // the question: answered yes at once, or held until the test answers it (app.asks[0].resolve)
  app.asks = [];
  app.ctx.kjrConfirm = o.hold ? (msg) => new Promise((resolve) => app.asks.push({ msg: String(msg), resolve })) : async (msg) => { app.asks.push({ msg: String(msg) }); return true; };
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  // the vendor: a slab search with eBay data costs 6 credits and prices "Card N" at 100 plus N, a plain name search finds nothing. A hook runs as the nth request arrives
  app.pptHooks = {}; let seen = 0;
  app.fetchMock.route('/ppt/cards', (url) => {
    const n = ++seen;
    if (app.pptHooks[n]) app.pptHooks[n]();
    const u = new URL(url);
    if (u.searchParams.get('includeEbay') !== 'true') return jsonResponse({ data: [], metadata: { apiCallsConsumed: { total: 3 } } });
    return jsonResponse({ data: [slabCard(u.searchParams.get('search'))].filter(Boolean), metadata: { apiCallsConsumed: { total: 6 } } });
  });
  // TCGdex: card number N resolves to set-N, priced at N, except the numbers in app.unknown, which it has no card for
  app.unknown = new Set();
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) { const n = decodeURIComponent(list[2]); return app.unknown.has(n) ? jsonResponse([]) : jsonResponse([{ id: 'set-' + n }]); }
    const card = url.match(/\/cards\/set-(\d+)$/);
    if (card && !app.unknown.has(card[1])) return jsonResponse({ id: 'set-' + card[1], pricing: { tcgplayer: { holofoil: { marketPrice: Number(card[1]) } } } });
    return jsonResponse({}, 404);
  });
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.tcgPriced = () => app.fetchMock.calls.map((c) => (c.url.match(/api\.tcgdex\.net\/.*\/cards\/(set-\d+)$/) || [])[1]).filter(Boolean);
  app.row = (id, table) => app.ctx.DB[table || 'singles'].find((r) => r.id === id);
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  app.saveQueue = (patch) => {
    const q = plain(app.ctx.buildRefreshQueue());
    Object.assign(q, patch || {});
    app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    return q;
  };
  // another tab's rows arriving (the storage event's merge): a newer copy of a row replaces the object under the same id
  app.merge = (table, rows) => app.ctx.mergeIntoMemory(table, rows);
  return app;
}
const tick = async (n) => { for (let i = 0; i < (n || 10); i++) await new Promise((r) => setImmediate(r)); };
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
const LEFT_OUT = (n) => ', ' + n + ' left out (sold or removed while the run was going)';

// ── the question window ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk live rows: the list is made again after the yes, a row replaced, sold or removed while the question was open is read as it is then, and one added since is priced', async () => {
  const app = await setup({ singles: [enRow('e1', 'Raichu 26'), enRow('e2', 'Pidgey 27'), enRow('e3', 'Rattata 28')] }, { hold: true });
  const run = app.ctx.bulkRefreshPrices('singles');
  await tick();
  assert.equal(app.asks.length, 1);
  assert.match(app.asks[0].msg, /^Refresh 3 singles now\? 3 priced free from TCGdex\./, 'worded on the rows as they were');
  // while the question is open: e1 comes in anew from another tab (a new object under the same id), e2 is sold, e3 is trashed, e4 arrives
  const e1Old = app.row('e1');
  app.merge('singles', [enRow('e1', 'Raichu 26', { _updatedAt: LATER })]);
  assert.notEqual(app.row('e1'), e1Old, 'the merge swapped the object');
  app.row('e2').status = 'Sold';
  app.ctx.DB.singles = app.ctx.DB.singles.filter((r) => r.id !== 'e3');
  app.ctx.DB.singles.push(enRow('e4', 'Spearow 21'));
  app.asks[0].resolve(true);
  await finish(app, run);
  assert.deepEqual(app.tcgPriced(), ['set-26', 'set-21'], 'the rows on the list after the yes, and no other');
  assert.equal(app.row('e1').marketPrice, '26', 'written on the live row');
  assert.equal(e1Old.marketPrice, '', 'not on the object the question was worded from');
  assert.equal(app.row('e2').marketPrice, '', 'a Sold card is neither asked about nor priced');
  assert.equal(app.row('e4').marketPrice, '21', 'a card added while the question was open is priced');
  assert.equal(app.ctx._dirty.singles.has('e1'), true);
  assert.equal(app.ctx._dirty.singles.has('e2'), false);
  assert.equal(doneToast(app), 'Done: 2 updated', JSON.stringify(app.toasts));
});

test('bulk live rows: with every row sold while the question was open the run says so, asks nothing, and hands the waiting auto run back', async () => {
  const app = await setup({ singles: [enRow('e1', 'Raichu 26')] }, { hold: true });
  app.runs = [];
  const realRun = app.ctx.runRefreshQueue;
  app.ctx.runRefreshQueue = (...args) => { app.runs.push(args); return realRun(...args); };
  const run = app.ctx.bulkRefreshPrices('singles');
  await tick();
  const mark = app.timers.list().find((t) => t.type === 'timeout' && t.delay === 8000);
  app.timers.invoke(mark.id);
  assert.equal(app.ctx._kjrAutoRunWaiting, true, 'the auto run waits for the question');
  app.row('e1').status = 'Sold';
  app.asks[0].resolve(true);
  await run;
  await tick();
  assert.deepEqual(app.tcgPriced(), [], 'nothing asked');
  assert.equal(app.row('e1').marketPrice, '');
  assert.equal(app.toasts.at(-1), 'Nothing was refreshed. No singles with an automatic price are left', JSON.stringify(app.toasts));
  assert.equal(app.ctx._bulkRefreshRunning, false);
  assert.equal(app.ctx._kjrAutoRunWaiting, false);
  assert.deepEqual(app.runs, [[false]], 'the waiting auto run went, once');
});

// ── mid-run ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk live rows: mid-run, a row sold while the run is going is not asked (no credits spent on it), and a row replaced by a merge is priced on the live object', async () => {
  const app = await setup({ slabs: slabs(3) });
  const s3Old = app.row('s3', 'slabs');
  app.pptHooks[1] = () => { // the first slab's request is in flight when another tab sells the second and sends a newer copy of the third
    app.row('s2', 'slabs').status = 'Sold';
    app.merge('slabs', [slabRow('s3', 'Card 3', { _updatedAt: LATER })]);
  };
  await finish(app, app.ctx.bulkRefreshPrices('slabs'));
  assert.deepEqual(app.ppt().map(searchOf), ['Card 1', 'Card 3'], 'the Sold slab was not asked about');
  assert.equal(app.saved().dayCreditsUsed[D1], 12, 'two searches billed, not three');
  assert.equal(app.row('s1', 'slabs').marketPrice, '101');
  assert.equal(app.row('s2', 'slabs').marketPrice, '', 'nothing written on the Sold card');
  assert.equal(app.ctx._dirty.slabs.has('s2'), false, 'and it was not marked dirty');
  assert.notEqual(app.row('s3', 'slabs'), s3Old);
  assert.equal(app.row('s3', 'slabs').marketPrice, '103', 'on the live object');
  assert.equal(s3Old.marketPrice, '', 'not on the one the list once held');
  assert.equal(doneToast(app), 'Done: 2 updated' + LEFT_OUT(1), JSON.stringify(app.toasts));
});

test('bulk live rows: a row sold while its own request is in flight gets no price and is not counted as updated, the credits its answer cost are billed', async () => {
  const app = await setup({ slabs: slabs(2) });
  app.pptHooks[1] = () => { app.row('s1', 'slabs').status = 'Sold'; };
  await finish(app, app.ctx.bulkRefreshPrices('slabs'));
  assert.deepEqual(app.ppt().map(searchOf), ['Card 1', 'Card 2']);
  assert.equal(app.row('s1', 'slabs').marketPrice, '', 'the answer was dropped');
  assert.deepEqual(plain(app.row('s1', 'slabs').priceHistory), []);
  assert.equal(app.ctx._dirty.slabs.has('s1'), false);
  assert.equal(app.saved().dayCreditsUsed[D1], 12, 'the request went out, its answer cost what it cost');
  assert.equal(app.row('s2', 'slabs').marketPrice, '102');
  assert.equal(doneToast(app), 'Done: 1 updated' + LEFT_OUT(1), JSON.stringify(app.toasts));
});

test('bulk live rows: a row is priced on the lane it has when its turn comes, a Slabs row whose grader was cleared mid-run is TCGdex only and never a graderless PPT search', async () => {
  const app = await setup({ slabs: [slabRow('s1', 'Card 1'), slabRow('s2', 'Zeta 99')] });
  app.unknown.add('99'); // TCGdex has no card 99, so a raw search for it would fall through to the vendor's name search
  app.pptHooks[1] = () => { const s2 = app.row('s2', 'slabs'); s2.grader = ''; s2.grade = ''; };
  await finish(app, app.ctx.bulkRefreshPrices('slabs'));
  assert.deepEqual(app.ppt().map(searchOf), ['Card 1'], 'one PPT search, the slab that is still a slab');
  assert.ok(app.ppt().every((c) => c.url.includes('includeEbay=true')), 'and it was the eBay lane, no plain name search went out');
  assert.equal(app.row('s2', 'slabs').marketPrice, '', 'no guessed price');
  assert.equal(app.saved().dayCreditsUsed[D1], 6);
  assert.match(doneToast(app), /^Done: 1 updated, 1 failed/, JSON.stringify(app.toasts));
});

// ── the plan the toast quotes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk live rows: a stop at the budget quotes the plan and limit that decided it, a switch to Free during the run reads "of 90 on the Free plan", not the Paid figures read after the yes', async () => {
  const app = await setup({ slabs: slabs(3) }, { plan: 'paid' });
  app.saveQueue({ dayCreditsUsed: { [D1]: 84 } });
  assert.equal(app.ctx.kjrCreditsLeft(app.saved(), D1), 18000 - 84);
  app.pptHooks[1] = () => { assert.equal(app.ctx.kjrPptSetPlan('free'), true); }; // the first slab's request is in flight when the owner switches to Free
  await finish(app, app.ctx.bulkRefreshPrices('slabs'));
  assert.equal(app.ppt().length, 1, 'the second slab is out of the Free plan\'s reach once the first is billed');
  assert.equal(app.saved().dayCreditsUsed[D1], 90);
  assert.equal(doneToast(app), 'Done: 1 updated · ⏸ PPT credits are used up for today (90 of 90 on the Free plan), they reset at 8am Singapore time (2 not priced)', JSON.stringify(app.toasts));
  // control: no change, the Paid figures as ever
  const control = await setup({ slabs: slabs(3) }, { plan: 'paid' });
  control.saveQueue({ dayCreditsUsed: { [D1]: 17994 } }); // one slab's worth is left
  await finish(control, control.ctx.bulkRefreshPrices('slabs'));
  assert.equal(control.ppt().length, 1);
  assert.equal(doneToast(control), 'Done: 1 updated · ⏸ PPT credits are used up for today (18,000 of 18,000 on the Paid plan), they reset at 8am Singapore time (2 not priced)', JSON.stringify(control.toasts));
});

// ── the day the check is made on ────────────────────────────────────────────────────────────────────────────────────────────────────────

const PLANS = { free: { gap: 6000, limit: 90, label: 'Free' }, paid: { gap: 1100, limit: 18000, label: 'Paid' } };
for (const plan of ['free', 'paid']) {
  const P = PLANS[plan];
  test('bulk live rows (' + plan + '): the budget is checked on the day the request goes out on, a reset inside the gap lets the run go on with the new day\'s credits', async () => {
    const app = await setup({ slabs: slabs(2) }, { plan });
    app.saveQueue({ dayCreditsUsed: { [D1]: P.limit - 6 } }); // one slab's worth is left on the 25th
    const run = app.ctx.bulkRefreshPrices('slabs');
    await tick(40);
    assert.equal(app.ppt().length, 1, 'the first slab is asked at once and spends the 25th\'s last credits');
    assert.ok(app.timers.list().some((t) => t.delay === P.gap), 'the run sits on the ' + P.label + ' plan\'s gap');
    app.clock.set(AFTER); // the gap ends after midnight
    await finish(app, run);
    assert.equal(app.ppt().length, 2, 'the second slab went out on the 26th, which has its credits');
    assert.deepEqual(plain(app.saved().dayCreditsUsed), { [D1]: P.limit, [D2]: 6 });
    assert.equal(app.row('s2', 'slabs').marketPrice, '102');
    assert.equal(doneToast(app), 'Done: 2 updated', JSON.stringify(app.toasts));
    // control: the same run with no reset stops at the 25th's spent budget, with nothing sent for the second slab
    const control = await setup({ slabs: slabs(2) }, { plan });
    control.saveQueue({ dayCreditsUsed: { [D1]: P.limit - 6 } });
    await finish(control, control.ctx.bulkRefreshPrices('slabs'));
    assert.equal(control.ppt().length, 1);
    assert.deepEqual(plain(control.saved().dayCreditsUsed), { [D1]: P.limit });
    assert.equal(doneToast(control), 'Done: 1 updated · ⏸ PPT credits are used up for today (' + fmt(P.limit) + ' of ' + fmt(P.limit) + ' on the ' + P.label + ' plan), they reset at 8am Singapore time (1 not priced)', JSON.stringify(control.toasts));
  });
}

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk live rows: the list is ids, made before the question and again after the yes, each row is read as its turn comes and again before its price is written, and the check follows the gap', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const at = src.indexOf('\nasync function bulkRefreshPrices(');
  assert.ok(at >= 0);
  const body = src.slice(at, at + 1 + src.slice(at + 1).search(/\n(?:async )?function /));
  assert.match(body, /let \{ free, ppt, manual \} = _kjrBulkWork\(table\);/, 'read for the question');
  const after = body.slice(body.indexOf('const blockedNow = _kjrBulkBlocker();'), body.indexOf('_bulkRefreshRunning = true;'));
  assert.match(after, /\(\{ free, ppt, manual \} = _kjrBulkWork\(table\)\);\s*work = free\.concat\(ppt\);/, 'and again after the yes, before the run flag goes up');
  assert.doesNotMatch(body, /\.push\(\{ item, kind \}\)/, 'no row object is kept on the list');
  const from = body.indexOf('for (let i = 0; i < work.length; i++) {');
  const loop = body.slice(from, body.indexOf('} finally {', from));
  assert.equal((loop.match(/item = _kjrBulkRow\(table, work\[i\]\);/g) || []).length, 2, 'the row is read twice: as its turn comes, and before its price is written');
  assert.ok(loop.indexOf('_kjrBulkRow(table, work[i])') < loop.indexOf('await fetchMarketPrice('), 'the first read comes before the request');
  assert.ok(loop.lastIndexOf('_kjrBulkRow(table, work[i])') > loop.indexOf('await fetchMarketPrice('), 'the second after its answer');
  assert.ok(loop.indexOf('if (waitMs) await new Promise(res => setTimeout(res, waitMs));') < loop.indexOf('if (isPpt && kjrCreditsLeft(q, utcDay) < _pptEstimateCredits({ grader, grade }))'), 'the gap is slept before the budget check, not after it');
  assert.match(loop, /\{ budgetStop = true; stoppedAt = i; limit = kjrDailyCredits\(\); planLabel = PPT_PLANS\[kjrPptPlan\(\)\]\.label; break; \}/, 'the stop reads the plan that decided it');
  assert.match(src, /^function _kjrBulkRow\(table, id\) \{\s*const row = \(DB\[table\] \|\| \[\]\)\.find\(r => r\.id === id\);\s*return row && \(row\.status\|\|'Available'\) === 'Available' \? row : null;\s*\}/m, 'the live row is the Available one under that id, or nothing');
});
