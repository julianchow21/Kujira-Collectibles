'use strict';
// v3.94, a bulk run that crosses 00:00 UTC bills the right day. The vendor's credits reset at 00:00 UTC (08:00 in Singapore) and bulkRefreshPrices fixed its day once,
// after the owner's yes. On the Paid plan a run lasts hours, so a run that crossed the reset went on checking and billing the day it began on: it stopped at the old day's
// spent budget (or at a pause set on it) with a whole fresh day waiting, and billed the new day's answers to the old one. Now the day is read again for every card:
//   - the budget check reads the day it is made on, and a card is billed to the day its request goes out on
//   - from the reset the run checks and bills the new day, and the old day keeps the total it had
//   - a pause set on the old day (creditsPausedDate) does not block the new day, and the vendor's refusal on the new day is paused on the new day
//   - a run that does not cross the reset behaves exactly as before
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
const EXHAUSTED = { error: 'Daily credit limit exceeded', retryAfter: 3600, resetsAt: '2026-10-26T00:00:00.000Z' };
const enRow = (id, name, extra) => Object.assign({ id, name, language: 'EN', type: 'raw', status: 'Available', costPrice: 5, marketPrice: '', priceHistory: [] }, extra);
const slabRow = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 500, marketPrice: '', priceHistory: [] }, extra);
// "Card N" is slab number N, which the vendor prices at 100 plus N
const slabs = (n) => Array.from({ length: n }, (_, i) => slabRow('s' + (i + 1), 'Card ' + (i + 1)));
const slabCard = (search) => {
  const m = /^(.+) (\d+)$/.exec(search || '');
  return m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};

async function setup(seed, opts) {
  const o = Object.assign({ plan: 'free', cost: 6, at: BEFORE }, opts || {});
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), jaLane: true });
  app.clock = setClock(app, o.at);
  if (o.plan === 'paid') assert.equal(app.ctx.kjrPptSetPlan('paid'), true);
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.asked = [];
  app.ctx.kjrConfirm = async (m) => { app.asked.push(String(m)); return true; };
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  // the vendor: every slab search costs app.cost credits, and a hook can run as the nth request arrives (move the clock, say) or the nth can be refused for credits
  app.cost = o.cost; app.pptHooks = {}; app.refuseAt = 0; let seen = 0;
  app.fetchMock.route('/ppt/cards', (url) => {
    const n = ++seen;
    if (app.pptHooks[n]) app.pptHooks[n]();
    if (n === app.refuseAt) return jsonResponse(EXHAUSTED, 200);
    const u = new URL(url);
    return jsonResponse({ data: [slabCard(u.searchParams.get('search'))].filter(Boolean), metadata: { apiCallsConsumed: { total: app.cost } } });
  });
  // TCGdex: card number N resolves to set-N, priced at N. A hook can run as the nth price request arrives.
  app.tcgHooks = {}; let tcgSeen = 0;
  app.fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) return jsonResponse([{ id: 'set-' + decodeURIComponent(list[2]) }]);
    const card = url.match(/\/cards\/set-(\d+)$/);
    if (card) {
      const n = ++tcgSeen;
      if (app.tcgHooks[n]) app.tcgHooks[n]();
      return jsonResponse({ id: 'set-' + card[1], pricing: { tcgplayer: { holofoil: { marketPrice: Number(card[1]) } } } });
    }
    return jsonResponse({}, 404);
  });
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.row = (id, table) => app.ctx.DB[table || 'singles'].find((r) => r.id === id);
  app.saved = () => JSON.parse(app.localStorage.getItem(QUEUE_KEY));
  app.saveQueue = (patch) => {
    const q = plain(app.ctx.buildRefreshQueue());
    Object.assign(q, patch || {});
    app.localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
    return q;
  };
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

// what each plan has to spend on a day, how long its gap is, and how much of the 25th is already spent for the tests below (12 credits are left)
const PLANS = {
  free: { gap: 6000, limit: 90, spent: 78 },       // 12 credits left on the 25th pay for two slabs
  paid: { gap: 1100, limit: 18000, spent: 17988 },
};

for (const plan of ['free', 'paid']) {
  const P = PLANS[plan];
  const Plan = plan[0].toUpperCase() + plan.slice(1);

  // ── the day changes between two cards ─────────────────────────────────────────────────────────────────────────────────────────────────

  test('bulk day (' + plan + '): a run that crosses 00:00 UTC bills the cards after it to the new day, checks the new day\'s budget, and the old day keeps its total', async () => {
    const app = await setup({ slabs: slabs(5) }, { plan });
    app.saveQueue({ dayCreditsUsed: { [D1]: P.spent } }); // two slabs of the 25th's budget are left
    app.pptHooks[2] = () => app.clock.set(AFTER); // the second slab is on its way before the reset: it is the last card of the 25th
    await finish(app, app.ctx.bulkRefreshPrices('slabs'));
    assert.equal(app.ppt().length, 5, 'the new day\'s budget paid for the rest: on the old day\'s the run would have stopped at the third slab');
    assert.deepEqual(plain(app.saved().dayCreditsUsed), { [D1]: P.spent + 12, [D2]: 18 }, 'the old day keeps what two slabs cost it, the three after the reset are the new day\'s');
    assert.equal(app.saved().creditsPausedDate, undefined);
    for (const n of [1, 2, 3, 4, 5]) assert.equal(app.row('s' + n, 'slabs').marketPrice, String(100 + n), 'slab ' + n + ' priced');
    assert.equal(doneToast(app), 'Done: 5 updated', JSON.stringify(app.toasts));
    // the queue reads the same record: today (the 26th) it has spent 18, not the old day's figure
    assert.equal(app.ctx.kjrCreditsUsedOn(app.saved(), D2), 18);
    assert.equal(app.ctx.kjrCreditsLeft(app.saved(), D2), P.limit - 18);
  });

  test('bulk day (' + plan + '): control, the same run that does not cross the reset stops at the old day\'s budget exactly as before', async () => {
    const app = await setup({ slabs: slabs(5) }, { plan });
    app.saveQueue({ dayCreditsUsed: { [D1]: P.spent } });
    await finish(app, app.ctx.bulkRefreshPrices('slabs'));
    assert.equal(app.ppt().length, 2, 'two slabs fit in what is left, a third is out of reach');
    assert.deepEqual(plain(app.saved().dayCreditsUsed), { [D1]: P.spent + 12 }, 'one day, and no key for the next');
    assert.equal(app.row('s3', 'slabs').marketPrice, '');
    const total = P.spent + 12;
    assert.ok(app.toasts.some((t) => t === 'Done: 2 updated · ⏸ PPT credits are used up for today (' + total.toLocaleString('en-GB') + ' of ' + P.limit.toLocaleString('en-GB') + ' on the ' + Plan + ' plan), they reset at 8am Singapore time (3 not priced)'), JSON.stringify(app.toasts));
  });

  // ── the gap straddles the reset ───────────────────────────────────────────────────────────────────────────────────────────────────

  test('bulk day (' + plan + '): a request that goes out after the reset, because the gap ended on the other side of it, is billed to the new day', async () => {
    const app = await setup({ slabs: slabs(2) }, { plan });
    app.saveQueue({ dayCreditsUsed: { [D1]: P.spent } }); // two slabs of the 25th's budget are left: the check for the second passes on the 25th
    const run = app.ctx.bulkRefreshPrices('slabs');
    await tick(40);
    assert.equal(app.ppt().length, 1, 'the first slab is asked at once');
    assert.ok(app.timers.list().some((t) => t.delay === P.gap), 'and the run sits on the ' + Plan + ' plan\'s gap');
    app.clock.set(AFTER); // the gap ends after midnight
    await finish(app, run);
    assert.equal(app.ppt().length, 2);
    assert.deepEqual(plain(app.saved().dayCreditsUsed), { [D1]: P.spent + 6, [D2]: 6 }, 'the second slab went out on the 26th, so it is the 26th\'s');
    assert.equal(doneToast(app), 'Done: 2 updated');
  });

  // ── a pause on the old day ────────────────────────────────────────────────────────────────────────────────────────────────────────

  test('bulk day (' + plan + '): baseline, a pause is for its own day: one set on the 25th does not stop a run that begins on the 26th', async () => {
    const app = await setup({ slabs: slabs(2) }, { plan, at: AFTER });
    app.saveQueue({ dayCreditsUsed: { [D1]: 10 }, creditsPausedDate: D1 }); // the vendor refused earlier on the 25th
    await finish(app, app.ctx.bulkRefreshPrices('slabs'));
    assert.equal(app.ppt().length, 2, 'the 26th is asked');
    assert.deepEqual(plain(app.saved().dayCreditsUsed), { [D1]: 10, [D2]: 12 });
    assert.equal(app.saved().creditsPausedDate, D1, 'the record of the old refusal is left as it was');
    assert.equal(doneToast(app), 'Done: 2 updated');
  });

  test('bulk day (' + plan + '): a run that begins on a paused day and crosses the reset on its free rows goes on to the PPT rows on the new day', async () => {
    // one table with both kinds of row: free singles first, then PPT cards. The Japanese lane is the PPT kind a Singles table has.
    const ja = (id, n) => ({ id, name: 'Mon' + String.fromCharCode(96 + n) + String.fromCharCode(96 + n) + ' ' + n, language: 'JP', type: 'raw', status: 'Available', tcgdexId: 'SV8a-00' + n, costPrice: 100, marketPrice: '', priceHistory: [] });
    const app = await setup({ singles: [enRow('e1', 'Raichu 26'), enRow('e2', 'Pidgey 27'), ja('j1', 1), ja('j2', 2)] }, { plan });
    app.fetchMock.route('/ppt/cards', (url) => {
      const search = new URL(url).searchParams.get('search') || '';
      const m = /^Mon([a-z])\1 SV8a$/.exec(search);
      const n = m ? m[1].charCodeAt(0) - 96 : 0;
      return jsonResponse({ data: n ? [{ id: 'c' + n, name: 'Mon' + m[1] + m[1], setName: 'SV8a: Test Set', cardNumber: '00' + n + '/100', prices: { market: 3 } }] : [], metadata: { apiCallsConsumed: { total: 3 } } });
    });
    app.saveQueue({ dayCreditsUsed: { [D1]: 10 }, creditsPausedDate: D1 });
    app.tcgHooks[2] = () => app.clock.set(AFTER); // the reset comes during the second free row
    await finish(app, app.ctx.bulkRefreshPrices('singles'));
    assert.equal(app.row('e1').marketPrice, '26');
    assert.equal(app.row('e2').marketPrice, '27');
    assert.equal(app.ppt().length, 2, 'the pause was for the 25th: both Japanese singles are asked on the 26th');
    assert.equal(app.row('j1').marketPrice, '3');
    assert.equal(app.row('j2').marketPrice, '3');
    assert.deepEqual(plain(app.saved().dayCreditsUsed), { [D1]: 10, [D2]: 6 }, 'two searches at 3 credits, on the new day');
    assert.equal(app.saved().creditsPausedDate, D1);
    assert.equal(doneToast(app), 'Done: 4 updated');
    // control: no reset, the pause holds and the free rows are still priced
    const control = await setup({ singles: [enRow('e1', 'Raichu 26'), enRow('e2', 'Pidgey 27'), ja('j1', 1), ja('j2', 2)] }, { plan });
    control.saveQueue({ dayCreditsUsed: { [D1]: 10 }, creditsPausedDate: D1 });
    await finish(control, control.ctx.bulkRefreshPrices('singles'));
    assert.equal(control.ppt().length, 0, 'control: the same pause on the same day asks for nothing');
    assert.equal(control.row('e2').marketPrice, '27');
    assert.equal(control.row('j1').marketPrice, '');
    assert.equal(doneToast(control), 'Done: 2 updated · ⏸ PPT credits are used up for today, they reset at 8am Singapore time (2 not priced)');
  });
}

// ── the vendor refuses for credits after the reset ──────────────────────────────────────────────────────────────────────────────────────────

test('bulk day: the vendor\'s refusal after the reset is paused on the new day, the old day is untouched, and the run stops there', async () => {
  const app = await setup({ slabs: slabs(5) });
  app.saveQueue({ dayCreditsUsed: { [D1]: 78 } });
  app.pptHooks[2] = () => app.clock.set(AFTER); // the second slab is the last of the 25th
  app.refuseAt = 4; // and the fourth card, the third of the 26th, is refused for credits
  await finish(app, app.ctx.bulkRefreshPrices('slabs'));
  assert.equal(app.ppt().length, 4, 'nothing is asked after the refusal');
  const q = app.saved();
  assert.deepEqual(plain(q.dayCreditsUsed), { [D1]: 90, [D2]: 6 }, 'only the answered searches were billed');
  assert.equal(q.creditsPausedDate, D2, 'the pause is the new day\'s: the refused request went out on the 26th');
  assert.equal(app.ctx.kjrCreditsLeft(q, D2), 0, 'so the queue is paused for the 26th');
  assert.equal(app.ctx.kjrCreditsLeft(q, '2026-10-27') > 0, true, 'and not for the 27th');
  assert.equal(doneToast(app), 'Done: 3 updated · ⏸ PPT credits are used up for today, they reset at 8am Singapore time (2 not priced)');
  // the queue agrees on the 26th: it asks the vendor nothing
  app.fetchMock.calls.length = 0;
  app.ctx.DB.slabs.forEach((r) => { r.marketPrice = ''; });
  await finish(app, app.ctx.runRefreshQueue(false)); // an automatic pass: a run asked for by hand clears the pause by design, to ask the vendor again
  assert.equal(app.ppt().length, 0);
});

test('bulk day: a refusal on the old day pauses the old day, and the run that stopped there leaves the next day free', async () => {
  const app = await setup({ slabs: slabs(3) });
  app.saveQueue({ dayCreditsUsed: { [D1]: 60 } });
  app.refuseAt = 2; // refused on the 25th, before any reset
  await finish(app, app.ctx.bulkRefreshPrices('slabs'));
  const q = app.saved();
  assert.equal(q.creditsPausedDate, D1);
  assert.deepEqual(plain(q.dayCreditsUsed), { [D1]: 66 });
  app.clock.set(AFTER);
  assert.equal(app.ctx.kjrCreditsLeft(q, D2), 90, 'the 26th starts with the full budget');
});

// ── the figures the run reports are the new day's ───────────────────────────────────────────────────────────────────────────────────────────

test('bulk day: a run that crosses the reset and then uses up the new day\'s credits reports the new day\'s figure, not the old day\'s', async () => {
  const app = await setup({ slabs: slabs(25) }, { cost: 4 }); // a slab search is billed 4 here, so a day ends at 88 of 90 (2 are left, a slab needs 6)
  app.saveQueue({ dayCreditsUsed: { [D1]: 80 } }); // the 25th: ten left, enough for two slabs (the check is on the estimate, 6)
  app.pptHooks[1] = () => app.clock.set(AFTER); // the first slab is the only card of the 25th
  await finish(app, app.ctx.bulkRefreshPrices('slabs'));
  const q = app.saved();
  assert.equal(q.dayCreditsUsed[D1], 84);
  assert.equal(q.dayCreditsUsed[D2], 88, 'twenty-two slabs at 4');
  assert.equal(app.ppt().length, 23);
  assert.equal(doneToast(app), 'Done: 23 updated · ⏸ PPT credits are used up for today (88 of 90 on the Free plan), they reset at 8am Singapore time (2 not priced)', JSON.stringify(app.toasts));
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('bulk day: the day is read again for every card, once the gap is over and before the budget check, and nothing in the loop keeps the day the run began on', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const at = src.indexOf('\nasync function bulkRefreshPrices(');
  const body = src.slice(at, at + 1 + src.slice(at + 1).search(/\n(?:async )?function /));
  assert.match(body, /\n\s*let utcDay = kjrUtcDay\(\);/, 'a let, it moves');
  const from = body.indexOf('for (let i = 0; i < work.length; i++) {');
  const loop = body.slice(from, body.indexOf('} finally {', from));
  assert.ok(loop.length > 1000, 'the loop was found');
  assert.match(loop, /\n\s*utcDay = kjrUtcDay\(\);\s*\/\/[^\n]*\n(?:[^\n]*\n)*?\s*if \(isPpt && kjrCreditsLeft\(q, utcDay\) < _pptEstimateCredits\(\{ grader, grade \}\)\) \{ budgetStop = true;/, 'read, then the check');
  assert.match(loop, /if \(waitMs\) await new Promise\(res => setTimeout\(res, waitMs\)\);\s*utcDay = kjrUtcDay\(\);/, 'read again once the gap is over, as the request goes out');
  assert.equal((loop.match(/utcDay = kjrUtcDay\(\)/g) || []).length, 1, 'once a card, after the gap and before the check (v3.96), and nowhere else in the loop');
  assert.match(loop, /q\.dayCreditsUsed\[utcDay\] = \(q\.dayCreditsUsed\[utcDay\] \|\| 0\) \+ spent/, 'the bill is the day of the request');
  assert.match(loop, /q\.creditsPausedDate = utcDay/, 'and so is the pause');
  assert.match(body, /\n\s*utcDay = kjrUtcDay\(\);\s*limit = kjrDailyCredits\(\);\s*planLabel = /, 'the read after the yes is still there');
});
