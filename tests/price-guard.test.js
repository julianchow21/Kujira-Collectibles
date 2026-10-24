'use strict';
// v3.86, the price guard and held prices. A wrong-card match once wrote US$500.99, which became S$644.63, onto a card worth about S$5. Every
// automatic price (applyPriceToGroup for both queue lanes, refreshPrice, bulkRefreshPrices) now passes kjrPriceGuard first. A price from S$20 up that
// is more than 20 times the cost, or more than 5 times the price the app counts for the card, is NOT written: marketPrice and priceHistory stay as
// they were and the price waits on the row as priceHold, for the owner to Accept or Reject from the Overview. Valuation never reads priceHold.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, jsonResponse, plain, ROOT } = require('./harness.js');
const { setClock } = require('./clock.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');

const pad2 = (n) => String(n).padStart(2, '0');
const UTC = () => new Date().toISOString().slice(0, 10);
const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10); // the UTC date n days back, so a rejection fixture never ages out under the suite
const LOCAL = () => { const d = new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); };

const single = (id, name, extra) => Object.assign({ id, name, language: 'EN', status: 'Available', type: 'raw', qty: 1, costPrice: 5, marketPrice: '5', priceHistory: [] }, extra || {});
const slab = (id, name, extra) => Object.assign({ id, name, grader: 'PSA', grade: '10', type: 'slab', language: 'EN', status: 'Available', costPrice: 5, marketPrice: '5', priceHistory: [] }, extra || {});

// the TCGdex answers the free lane reads: "Alpha 1" is card number 1, which resolves to set-1, priced from the table. USD 1 is S$1.
function tcgdex(fetchMock, prices) {
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  fetchMock.route((url) => url.includes('api.tcgdex.net'), (url) => {
    const list = url.match(/\/cards\?name=([^&]+)&localId=([^&]+)/);
    if (list) return jsonResponse([{ id: 'set-' + decodeURIComponent(list[2]) }]);
    const card = url.match(/\/cards\/(set-\d+)$/);
    if (card) return prices[card[1]] ? jsonResponse({ id: card[1], pricing: { tcgplayer: { holofoil: { marketPrice: prices[card[1]] } } } }) : jsonResponse({}, 404);
    return jsonResponse({}, 404);
  });
}
// the PokemonPriceTracker answers the PPT lane reads: "Alpha 1" at PSA 10 is S$101
const searchOf = (url) => decodeURIComponent(new URL(url).searchParams.get('search'));
const vendorCard = (search) => {
  const m = /^(.+) (\d+)$/.exec(search);
  return m ? { id: 'v-' + m[2], name: m[1], cardNumber: m[2] + '/100', setName: 'Set', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 + Number(m[2]) } } } } } : null;
};
function ppt(fetchMock) {
  fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  fetchMock.route('/ppt/cards', (url) => jsonResponse({ data: [vendorCard(searchOf(url))].filter(Boolean), metadata: { apiCallsConsumed: { total: 6 } } }));
}
// the lanes wait between requests (250ms, 1.1s, 6s, the retry backoff), the harness never fires a timer by itself
async function drain(fn, timers) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 400 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => [6000, 1100, 250, 2000].includes(e.delay));
  }
  return p;
}

async function setup(seed, opts) {
  const app = await loadApp(Object.assign({ seed: Object.assign({ singles: [], slabs: [] }, seed) }, opts || {}));
  app.said = [];
  app.ctx.toast = (m) => app.said.push(String(m));
  app.ctx.toastError = (m) => app.said.push('ERR ' + String(m));
  app.marks = [];
  const real = app.ctx.markDirty;
  app.ctx.markDirty = (...a) => { app.marks.push(a[0] + ':' + a[1]); return real.apply(app.ctx, a); };
  app.row = (id, table) => app.ctx.DB[table || 'singles'].find((r) => r.id === id);
  app.flushes = 0;
  app.ctx._flushDirtyToSupabase = async () => { app.flushes++; return { status: 'ok' }; };
  return app;
}

// ── the rule ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('guard: a price under S$20 is never held, whatever the cost or the last price', async () => {
  const { ctx } = await loadApp();
  const cheap = { costPrice: 0.5, marketPrice: 1 }; // 40 times the cost and 20 times the last price at S$20
  for (const p of [19.99, 19, 10, 1, 0.01, 0, -5]) assert.equal(ctx.kjrPriceGuard(cheap, p), null, String(p));
  assert.deepEqual(plain(ctx.kjrPriceGuard(cheap, 20)), { reason: '40× cost' }, 'S$20 itself is in range');
});

test('guard: more than 20 times the cost is held, exactly 20 times is not, 21 times is', async () => {
  const { ctx } = await loadApp();
  const item = { costPrice: 10, marketPrice: '' };
  assert.equal(ctx.kjrPriceGuard(item, 200), null, '20 times is not more than 20 times');
  assert.deepEqual(plain(ctx.kjrPriceGuard(item, 210)), { reason: '21× cost' });
  assert.deepEqual(plain(ctx.kjrPriceGuard({ costPrice: '5', marketPrice: '' }, 644.63)), { reason: '129× cost' }, 'the incident: a multiple over 10 is a whole number');
  assert.deepEqual(plain(ctx.kjrPriceGuard({ costPrice: 5, marketPrice: '' }, 100.5)), { reason: '20× cost' }, 'just over 20 times is held, and the reason shows the multiple rounded');
});

test('guard: more than 5 times the last price is held, exactly 5 times is not, 5.1 times is', async () => {
  const { ctx } = await loadApp();
  const item = { costPrice: '', marketPrice: 50 };
  assert.equal(ctx.kjrPriceGuard(item, 250), null, '5 times is not more than 5 times');
  assert.deepEqual(plain(ctx.kjrPriceGuard(item, 255)), { reason: '5.1× last price' }, 'a multiple under 10 keeps one decimal');
  assert.deepEqual(plain(ctx.kjrPriceGuard({ costPrice: '', marketPrice: '8' }, 644.63)), { reason: '81× last price' });
  assert.equal(ctx.kjrPriceGuard({ costPrice: '', marketPrice: '50' }, 249.99), null, 'a string price reads the same');
});

test('guard: no cost skips the cost half, no last price skips the other, neither means nothing to compare', async () => {
  const { ctx } = await loadApp();
  for (const cost of ['', 0, '0', -5, null, undefined, 'abc']) {
    assert.equal(ctx.kjrPriceGuard({ costPrice: cost, marketPrice: 1000 }, 999), null, 'no cost ' + String(cost) + ': 0.99 times the last price');
    assert.deepEqual(plain(ctx.kjrPriceGuard({ costPrice: cost, marketPrice: 100 }, 600)), { reason: '6× last price' }, 'no cost ' + String(cost) + ' leaves the last price rule');
  }
  for (const last of ['', 0, '0', -5, null, undefined, 'abc']) {
    assert.equal(ctx.kjrPriceGuard({ costPrice: 100, marketPrice: last }, 2000), null, 'no last price ' + String(last) + ': 20 times the cost');
    assert.deepEqual(plain(ctx.kjrPriceGuard({ costPrice: 100, marketPrice: last }, 2001)), { reason: '20× cost' }, 'no last price ' + String(last) + ' leaves the cost rule');
  }
  assert.equal(ctx.kjrPriceGuard({ costPrice: '', marketPrice: '' }, 100000), null, 'a card with neither has nothing to be compared with');
  assert.equal(ctx.kjrPriceGuard({}, 100000), null);
  // a stale PokemonPriceTracker estimate is not a price the app counts (kjrLiveMarketPrice), so it is not a last price
  const stale = { language: 'JP', marketPrice: 40, costPrice: '', priceHistory: [{ date: '2026-06-01', price: 40, ppt: 40 }] };
  assert.equal(Number.isNaN(ctx.kjrLiveMarketPrice(stale)), true, 'precondition');
  assert.equal(ctx.kjrPriceGuard(stale, 1000), null);
});

test('guard: when both halves doubt the price the cost is named, and the item is only read', async () => {
  const { ctx } = await loadApp();
  const item = { costPrice: 10, marketPrice: 10, name: 'Zard', priceHistory: [] };
  const before = JSON.stringify(item);
  assert.deepEqual(plain(ctx.kjrPriceGuard(item, 250)), { reason: '25× cost' });
  assert.equal(JSON.stringify(item), before, 'pure: nothing on the row changed');
  for (const bad of [NaN, undefined, null, 'abc', Infinity, {}]) assert.equal(ctx.kjrPriceGuard(item, bad), null, String(bad));
  assert.equal(ctx.kjrPriceGuard(null, 500), null);
  assert.equal(ctx.kjrPriceGuard(undefined, 500), null);
});

// ── the write sites hold, and write nothing ───────────────────────────────────────────────────────────────────────────────────────

test('applyPriceToGroup: the S$644.63 incident is held, marketPrice and history stay, the hold carries everything the owner needs', async () => {
  const app = await setup({ singles: [single('s1', 'Charmander 4', { costPrice: 5, marketPrice: '5', tcgdexId: '' })] });
  app.ctx.applyPriceToGroup('s1', 'singles', [], 644.63, 'USD', 'TCGdex (TCGplayer)', 'high', 'base1-4');
  const row = app.row('s1');
  assert.equal(row.marketPrice, '5', 'the price on the card is untouched');
  assert.equal(row.priceHistory.length, 0, 'and so is its history');
  assert.deepEqual(plain(row.priceHold), { price: 644.63, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high', date: UTC(), prev: 5, reason: '129× cost' });
  assert.equal(row._tcgdexPricedDate, LOCAL(), 'stamped as looked up today, so the queue does not ask again');
  assert.equal(row.tcgdexId, 'base1-4', 'the id the pass resolved is kept, the match was found and only its price is in doubt');
  assert.deepEqual(app.marks, ['singles:s1'], 'a hold is a synced field: marked dirty once, the id rides on the same mark');
  assert.equal(app.ctx._dirty.singles.has('s1'), true);
  // a price that passes is written as before
  app.ctx.applyPriceToGroup('s1', 'singles', [], 12, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(row.marketPrice, '12');
  assert.equal(row.priceHistory.length, 1);
  assert.equal('priceHold' in row, false, 'a price that passes makes the older hold obsolete');
});

test('applyPriceToGroup: a hold with no price on the card has prev null, and the cost half is what held it', async () => {
  const app = await setup({ singles: [single('s1', 'Charmander 4', { costPrice: 3, marketPrice: '' })] });
  app.ctx.applyPriceToGroup('s1', 'singles', [], 70, 'EUR', 'TCGdex (Cardmarket)', 'high', null);
  assert.deepEqual(plain(app.row('s1').priceHold), { price: 70, unit: 'EUR', source: 'TCGdex (Cardmarket)', confidence: 'high', date: UTC(), prev: null, reason: '23× cost' });
  assert.equal(app.row('s1').marketPrice, '');
});

test('applyPriceToGroup: a group of same-card rows gets one treatment, decided on the first row, copies included', async () => {
  const held = await setup({ singles: [single('a', 'Eevee 9', { costPrice: 1, marketPrice: '4' }), single('b', 'Eevee 9', { costPrice: 100, marketPrice: '4' })] });
  held.ctx.applyPriceToGroup('a', 'singles', [{ id: 'b', table: 'singles' }], 90, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(held.row('a').priceHold.reason, '90× cost');
  assert.equal(held.row('b').priceHold.reason, '90× cost', 'the copy is held with the primary, although 90 is under its own cost (cost 100): one card, one decision');
  assert.deepEqual([held.row('a').marketPrice, held.row('b').marketPrice], ['4', '4']);

  const written = await setup({ singles: [single('a', 'Eevee 9', { costPrice: 10, marketPrice: '15' }), single('b', 'Eevee 9', { costPrice: 1, marketPrice: '15' })] });
  written.ctx.applyPriceToGroup('a', 'singles', [{ id: 'b', table: 'singles' }], 25, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.deepEqual([written.row('a').marketPrice, written.row('b').marketPrice], ['25', '25'], 'the primary passes, so the copy bought for S$1 takes the same price (25 times its cost)');
  assert.equal('priceHold' in written.row('b'), false);
  assert.deepEqual([written.row('a').priceHistory.length, written.row('b').priceHistory.length], [1, 1]);
});

test('applyPriceToGroup: a group whose first row already has the price is decided on the first row that would change', async () => {
  const app = await setup({ singles: [single('a', 'Eevee 9', { costPrice: 1, marketPrice: '25' }), single('b', 'Eevee 9', { costPrice: 1, marketPrice: '4' })] });
  app.ctx.applyPriceToGroup('a', 'singles', [{ id: 'b', table: 'singles' }], 25, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(app.row('a').marketPrice, '25', 'unchanged, and not held against itself');
  assert.equal('priceHold' in app.row('a'), false);
  assert.equal(app.row('a')._tcgdexPricedDate, LOCAL(), 'still a check');
  assert.equal(app.row('b').priceHold.reason, '25× cost', 'the row that would change is the one the guard asks');
  assert.equal(app.row('b').marketPrice, '4');
});

test('applyPriceToGroup: a custom card still takes no price, held or not', async () => {
  const app = await setup({ singles: [single('c', 'Fan Card 1', { costPrice: 1, marketPrice: '4', customCard: true })] });
  app.ctx.applyPriceToGroup('c', 'singles', [], 500, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal('priceHold' in app.row('c'), false);
  assert.equal(app.row('c').marketPrice, '4');
});

test('refreshPrice: a card\'s own Refresh is held like the daily pass, with a toast that says so and a hold on the card', async () => {
  const app = await setup({ singles: [single('s1', 'Alpha 1', { costPrice: 5, marketPrice: '5' })] });
  tcgdex(app.fetchMock, { 'set-1': 500 });
  await app.ctx.refreshPrice('s1', 'singles');
  const row = app.row('s1');
  assert.equal(row.marketPrice, '5');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(row.priceHold.price, 500);
  assert.equal(row.priceHold.reason, '100× cost');
  assert.equal(row.priceHold.prev, 5);
  assert.equal(row._tcgdexPricedDate, LOCAL());
  assert.equal(row.tcgdexId, 'set-1', 'the resolved id is kept');
  assert.equal(app.ctx._dirty.singles.has('s1'), true);
  assert.deepEqual(app.said.filter((m) => !/^Fetching/.test(m)), ['⚠ Held for your OK: S$500 is 100× cost. The price on the card is unchanged.']);
  // a second Refresh with the price a little different is the same price seen again: the hold stays, nothing syncs again
  app.marks.length = 0;
  app.said.length = 0;
  tcgdex(app.fetchMock, { 'set-1': 520 });
  row.priceHold.date = '2026-01-01';
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(row.priceHold.price, 500, 'the hold is as it was');
  assert.equal(row.priceHold.date, UTC(), 'only its date moved');
  assert.deepEqual(app.marks, [], 'and that is a local change, not a sync');
  assert.equal(row.marketPrice, '5');
});

test('refreshPrice: a slab through the PPT lane is held too, and a price that passes later clears the hold', async () => {
  const app = await setup({ slabs: [slab('sl1', 'Alpha 1', { costPrice: 1, marketPrice: '4' })] });
  ppt(app.fetchMock);
  await drain(() => app.ctx.refreshPrice('sl1', 'slabs'), app.timers);
  const row = app.row('sl1', 'slabs');
  assert.equal(row.marketPrice, '4');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(row.priceHold.price, 101);
  assert.equal(row.priceHold.reason, '101× cost');
  assert.match(row.priceHold.source, /^PPT/);
  // the owner raises the cost to what it really was: the same lookup now passes, is written, and the stale hold goes with it
  row.costPrice = 90;
  row.marketPrice = '80';
  await drain(() => app.ctx.refreshPrice('sl1', 'slabs'), app.timers);
  assert.equal(row.marketPrice, '101');
  assert.equal(row.priceHistory.length, 1);
  assert.equal('priceHold' in row, false);
});

test('refreshPrice: the same price as the card carries is no new price, and an old hold on some other price goes', async () => {
  const app = await setup({ singles: [single('s1', 'Alpha 1', { costPrice: 1, marketPrice: '500', tcgdexId: 'set-1' })] }); // the id is cached already: a freshly resolved id is never a no-op
  tcgdex(app.fetchMock, { 'set-1': 500 });
  app.row('s1').priceHold = { price: 900, unit: 'USD', source: 'x', confidence: 'high', date: '2026-10-01', prev: 500, reason: '900× cost' };
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.row('s1').marketPrice, '500');
  assert.equal(app.row('s1').priceHistory.length, 0, 'unchanged: no history');
  assert.equal('priceHold' in app.row('s1'), false, 'the source agrees with the card again, so the hold on 900 is obsolete');
  assert.deepEqual(app.marks, ['singles:s1'], 'dropping it is a synced change');
  assert.ok(app.said.some((m) => /^Price unchanged: S\$500/.test(m)));
});

test('bulkRefreshPrices: a held price is not an update, it is counted apart and written nowhere', async () => {
  const app = await setup({ singles: [single('s1', 'Alpha 1', { costPrice: 5, marketPrice: '5' }), single('s2', 'Bravo 2', { costPrice: 5, marketPrice: '5' })] });
  tcgdex(app.fetchMock, { 'set-1': 500, 'set-2': 8 });
  app.ctx.kjrConfirm = async () => true;
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.row('s1').marketPrice, '5');
  assert.equal(app.row('s1').priceHistory.length, 0);
  assert.equal(app.row('s1').priceHold.price, 500);
  assert.equal(app.row('s2').marketPrice, '8', 'the other card is updated as before');
  assert.equal(app.row('s2').priceHistory.length, 1);
  assert.ok(app.said.some((m) => /^Done: 1 updated, 1 held for your OK \(Overview, Needs attention\)/.test(m)), JSON.stringify(app.said));
  assert.equal(app.row('s1')._tcgdexPricedDate, LOCAL());
});

test('the free lane holds a wrong match, a manual "run now" too, and the PPT lane holds a slab', async () => {
  const app = await setup({
    singles: [single('s1', 'Alpha 1', { costPrice: 5, marketPrice: '5' }), single('s2', 'Bravo 2', { costPrice: 5, marketPrice: '5' })],
    slabs: [slab('sl1', 'Alpha 1', { costPrice: 1, marketPrice: '4' })],
  });
  tcgdex(app.fetchMock, { 'set-1': 500, 'set-2': 8 });
  ppt(app.fetchMock);
  await drain(() => app.ctx.runRefreshQueue(true), app.timers); // a manual run: nothing is exempt
  assert.equal(app.row('s1').marketPrice, '5', 'free lane');
  assert.equal(app.row('s1').priceHold.price, 500);
  assert.equal(app.row('s2').marketPrice, '8', 'a plain price from the same pass is written');
  assert.equal(app.row('sl1', 'slabs').marketPrice, '4', 'PPT lane');
  assert.equal(app.row('sl1', 'slabs').priceHold.price, 101);
  assert.equal(app.row('s1').priceHistory.length, 0);
  assert.equal(app.row('sl1', 'slabs').priceHistory.length, 0);
  // the pass is done for today: an automatic run asks for neither card again, the held single included
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.deepEqual(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')).map((c) => c.url), [], 'TCGdex is not asked again today');
});

test('a held card with no price on it still counts as priced today for the free lane, so a page load does not ask again', async () => {
  const app = await setup({ singles: [single('s1', 'Alpha 1', { costPrice: 3, marketPrice: '' })] });
  tcgdex(app.fetchMock, { 'set-1': 70 });
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.row('s1').priceHold.price, 70, 'precondition: held by the cost half');
  assert.equal(app.row('s1').marketPrice, '');
  assert.equal(app.ctx._tcgdexPricedToday({ id: 's1', table: 'singles' }, LOCAL()), true);
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.deepEqual(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')), [], 'asked nothing');
  assert.equal(app.ctx._tcgdexPricedToday({ id: 's1', table: 'singles' }, '2000-01-01'), false, 'and it is today\'s marker that counts');
  assert.equal(app.ctx._tcgdexPricedToday({ id: 'nobody', table: 'singles' }, LOCAL()), false);
});

test('a match picked in the Unmatched cards sheet whose price the guard holds keeps the match and says the price is waiting', async () => {
  const app = await setup({ singles: [single('p1', 'Pikachu 25', { costPrice: 5, marketPrice: '', _tcgdexMissDate: '2026-10-01' })] });
  app.ctx.refreshPrice = async (id) => { app.ctx.applyPriceToGroup(id, 'singles', [], 600, 'USD', 'TCGdex (TCGplayer)', 'high', null); };
  assert.equal(await app.ctx._kjrCustomPickRun('p1', { id: 'sv03.5-025', name: 'Pikachu' }, '151 025'), true);
  assert.equal(app.row('p1').tcgdexId, 'sv03.5-025', 'the match is saved');
  assert.equal(app.row('p1').marketPrice, '', 'the price is not');
  assert.equal(app.row('p1').priceHold.price, 600);
  assert.deepEqual(app.said.slice(-1), ['Matched to 151 025, but its price looks wrong and is waiting for your OK']);
});

// ── the same price seen again, and a price the owner turned down ──────────────────────────────────────────────────────────────────

test('a repeat within 10% of the hold only moves its date, a price beyond 10% replaces it', async () => {
  const app = await setup({ singles: [single('s1', 'Charmander 4', { costPrice: 1, marketPrice: '5' })] });
  app.ctx.applyPriceToGroup('s1', 'singles', [], 100, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  const row = app.row('s1');
  row.priceHold.date = '2026-01-01';
  app.marks.length = 0;
  app.ctx.applyPriceToGroup('s1', 'singles', [], 110, 'USD', 'TCGdex (Cardmarket)', 'medium', null); // exactly 10% above
  assert.deepEqual(plain(row.priceHold), { price: 100, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high', date: UTC(), prev: 5, reason: '100× cost' }, 'only the date moved');
  assert.deepEqual(app.marks, [], 'and a date that changes daily is not a sync');
  app.ctx.applyPriceToGroup('s1', 'singles', [], 90, 'USD', 'TCGdex (TCGplayer)', 'high', null); // exactly 10% below
  assert.equal(row.priceHold.price, 100);
  assert.deepEqual(app.marks, []);
  app.ctx.applyPriceToGroup('s1', 'singles', [], 110.01, 'USD', 'TCGdex (Cardmarket)', 'medium', null);
  assert.equal(row.priceHold.price, 110.01, 'just beyond 10% is a different price: it replaces the hold');
  assert.equal(row.priceHold.source, 'TCGdex (Cardmarket)');
  assert.deepEqual(app.marks, ['singles:s1'], 'and that one syncs');
  assert.equal(row.marketPrice, '5');
  assert.equal(row.priceHistory.length, 0, 'through all of it nothing was written');
});

test('a price within 10% of one the owner rejected is skipped without a word, still stamped as looked up', async () => {
  const app = await setup({ singles: [single('s1', 'Charmander 4', { costPrice: 1, marketPrice: '5', priceHoldRejected: { price: 100, date: ago(3) } })] });
  const row = app.row('s1');
  app.ctx.applyPriceToGroup('s1', 'singles', [], 110, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal('priceHold' in row, false, 'no hold');
  assert.equal(row.marketPrice, '5', 'no write');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(row._tcgdexPricedDate, LOCAL(), 'but it counts as looked up today');
  assert.deepEqual(app.marks, [], 'and nothing syncs');
  assert.deepEqual(plain(row.priceHoldRejected), { price: 100, date: ago(3) }, 'the rejection stays as it was');
  app.ctx.applyPriceToGroup('s1', 'singles', [], 90, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal('priceHold' in row, false, 'the other side of 10% is skipped too');
  app.ctx.applyPriceToGroup('s1', 'singles', [], 110.01, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(row.priceHold.price, 110.01, 'a price beyond 10% of the rejected one is asked about again');
  // a price the guard does not doubt is never skipped on account of a rejection
  app.ctx.applyPriceToGroup('s1', 'singles', [], 12, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(row.marketPrice, '12');
});

test('refreshPrice says a price the owner rejected before is ignored, and writes nothing', async () => {
  const app = await setup({ singles: [single('s1', 'Alpha 1', { costPrice: 5, marketPrice: '5', priceHoldRejected: { price: 500, date: ago(3) } })] });
  tcgdex(app.fetchMock, { 'set-1': 520 });
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal('priceHold' in app.row('s1'), false);
  assert.equal(app.row('s1').marketPrice, '5');
  assert.ok(app.said.includes('S$520 (TCGdex (TCGplayer)) is a price you rejected before. The price on the card is unchanged.'), JSON.stringify(app.said));
});

// ── a rejection is remembered for 30 days ────────────────────────────────────────────────────────────────────────────────────────────
// A fixed clock here: 04:00 UTC on 24 Oct 2026 is noon in Singapore, so the UTC date and the local date are the same date, and "n days ago" is exact.
const TODAY_FIXED = '2026-10-24';
const DAYS_BACK = (n) => new Date(Date.UTC(2026, 9, 24 - n)).toISOString().slice(0, 10);
async function rejectedSetup(rejection, extra) {
  const app = await setup({ singles: [single('s1', 'Charmander 4', Object.assign({ costPrice: 1, marketPrice: '5', priceHoldRejected: rejection }, extra || {}))] });
  app.clock = setClock(app, TODAY_FIXED + 'T04:00:00Z');
  return app;
}

test('the rule says a rejection counts for 30 days', async () => {
  const { ctx } = await loadApp();
  assert.equal(ctx.kjrPriceGuardRule().rejectDays, 30);
});

test('a rejection counts for 30 days: day 29 and day 30 skip a near price, day 31 holds it again and the old key goes with the hold', async () => {
  for (const [days, counts] of [[0, true], [1, true], [29, true], [30, true], [31, false], [32, false], [400, false]]) {
    const app = await rejectedSetup({ price: 100, date: DAYS_BACK(days) });
    const row = app.row('s1');
    app.ctx.applyPriceToGroup('s1', 'singles', [], 105, 'USD', 'TCGdex (TCGplayer)', 'high', null);
    assert.equal(row.marketPrice, '5', 'day ' + days + ': nothing is written either way');
    assert.equal(row.priceHistory.length, 0);
    assert.equal(row._tcgdexPricedDate, TODAY_FIXED, 'day ' + days + ': it counts as looked up today');
    if (counts) {
      assert.equal('priceHold' in row, false, 'day ' + days + ': skipped, no hold');
      assert.deepEqual(plain(row.priceHoldRejected), { price: 100, date: DAYS_BACK(days) }, 'day ' + days + ': the rejection is left alone');
      assert.deepEqual(app.marks, [], 'day ' + days + ': nothing syncs');
    } else {
      assert.deepEqual(plain(row.priceHold), { price: 105, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high', date: TODAY_FIXED, prev: 5, reason: '105× cost' }, 'day ' + days + ': held again');
      assert.equal('priceHoldRejected' in row, false, 'day ' + days + ': the old rejection was deleted with it');
      assert.deepEqual(app.marks, ['singles:s1'], 'day ' + days + ': marked dirty once, the row was being written for the hold');
    }
  }
});

test('the 30 days run from the rejection itself: Reject on day 0, a near price is skipped on day 29 and asked about again on day 31', async () => {
  const app = await setup({ singles: [single('x1', 'Charmander 4', { costPrice: 1, marketPrice: '5' })] });
  const clock = setClock(app, TODAY_FIXED + 'T04:00:00Z');
  app.ctx.applyPriceToGroup('x1', 'singles', [], 100, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  await app.ctx.kjrPriceHoldReject('singles', 'x1');
  assert.deepEqual(plain(app.row('x1').priceHoldRejected), { price: 100, date: TODAY_FIXED });
  app.marks.length = 0;
  clock.set(DAYS_BACK(-29) + 'T04:00:00Z');
  app.ctx.applyPriceToGroup('x1', 'singles', [], 104, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal('priceHold' in app.row('x1'), false, 'day 29: still turned down');
  assert.deepEqual(app.marks, []);
  clock.set(DAYS_BACK(-31) + 'T04:00:00Z');
  app.ctx.applyPriceToGroup('x1', 'singles', [], 104, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(app.row('x1').priceHold.price, 104, 'day 31: the owner is asked again');
  assert.equal('priceHoldRejected' in app.row('x1'), false);
  assert.equal(app.row('x1').marketPrice, '5', 'and nothing was written');
});

test('a rejection with no readable date can not be aged, so it does not count: the price is held again and the key goes', async () => {
  for (const bad of [{ price: 100 }, { price: 100, date: '' }, { price: 100, date: 'garbage' }, { price: 100, date: 20261001 }, { price: 100, date: null }, 'x', 5, true, [], null]) {
    const app = await rejectedSetup(bad);
    app.ctx.applyPriceToGroup('s1', 'singles', [], 105, 'USD', 'TCGdex (TCGplayer)', 'high', null);
    assert.equal(app.row('s1').priceHold.price, 105, JSON.stringify(bad));
    assert.equal('priceHoldRejected' in app.row('s1'), false, JSON.stringify(bad) + ' is gone');
  }
});

test('a rejection of a price that is not near the new one never skips it, old or new, and a live one is kept beside the new hold', async () => {
  const live = await rejectedSetup({ price: 100, date: DAYS_BACK(5) });
  live.ctx.applyPriceToGroup('s1', 'singles', [], 200, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(live.row('s1').priceHold.price, 200, 'a different price is held');
  assert.deepEqual(plain(live.row('s1').priceHoldRejected), { price: 100, date: DAYS_BACK(5) }, 'and the rejection that still counts stays');
  const old = await rejectedSetup({ price: 100, date: DAYS_BACK(60) });
  old.ctx.applyPriceToGroup('s1', 'singles', [], 200, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(old.row('s1').priceHold.price, 200);
  assert.equal('priceHoldRejected' in old.row('s1'), false, 'the old one goes with the new hold');
});

test('an old rejection is deleted when the row is next written, by any of the three write sites, and one that still counts is kept', async () => {
  const seedRow = (date) => ({ costPrice: 100, marketPrice: '50', tcgdexId: 'set-1', priceHoldRejected: { price: 900, date } });
  const OLD = DAYS_BACK(40), LIVE = DAYS_BACK(5);

  // applyPriceToGroup: a price that passes is written, the row is marked dirty by the write itself
  for (const [date, kept] of [[OLD, false], [LIVE, true]]) {
    const app = await setup({ singles: [single('s1', 'Alpha 1', seedRow(date))] });
    app.clock = setClock(app, TODAY_FIXED + 'T04:00:00Z');
    app.ctx.applyPriceToGroup('s1', 'singles', [], 60, 'USD', 'TCGdex (TCGplayer)', 'high', null);
    assert.equal(app.row('s1').marketPrice, '60', 'applyPriceToGroup writes');
    assert.equal('priceHoldRejected' in app.row('s1'), kept, 'applyPriceToGroup, rejection from ' + date);
    assert.deepEqual(app.marks, ['singles:s1']);
  }
  // refreshPrice
  for (const [date, kept] of [[OLD, false], [LIVE, true]]) {
    const app = await setup({ singles: [single('s1', 'Alpha 1', seedRow(date))] });
    app.clock = setClock(app, TODAY_FIXED + 'T04:00:00Z');
    tcgdex(app.fetchMock, { 'set-1': 60 });
    await app.ctx.refreshPrice('s1', 'singles');
    assert.equal(app.row('s1').marketPrice, '60', 'refreshPrice writes');
    assert.equal('priceHoldRejected' in app.row('s1'), kept, 'refreshPrice, rejection from ' + date);
    assert.equal(app.ctx._dirty.singles.has('s1'), true);
  }
  // bulkRefreshPrices
  for (const [date, kept] of [[OLD, false], [LIVE, true]]) {
    const app = await setup({ singles: [single('s1', 'Alpha 1', seedRow(date))] });
    app.clock = setClock(app, TODAY_FIXED + 'T04:00:00Z');
    tcgdex(app.fetchMock, { 'set-1': 60 });
    app.ctx.kjrConfirm = async () => true;
    await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
    assert.equal(app.row('s1').marketPrice, '60', 'bulkRefreshPrices writes');
    assert.equal('priceHoldRejected' in app.row('s1'), kept, 'bulkRefreshPrices, rejection from ' + date);
    assert.equal(app.ctx._dirty.singles.has('s1'), true);
  }
});

test('an unchanged price writes nothing, so an old rejection stays until the row is next written, and an obsolete hold takes it along', async () => {
  const quiet = await setup({ singles: [single('s1', 'Alpha 1', { costPrice: 100, marketPrice: '60', tcgdexId: 'set-1', priceHoldRejected: { price: 900, date: DAYS_BACK(40) } })] });
  quiet.clock = setClock(quiet, TODAY_FIXED + 'T04:00:00Z');
  quiet.ctx.applyPriceToGroup('s1', 'singles', [], 60, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal('priceHoldRejected' in quiet.row('s1'), true, 'the same-value pass is not a write');
  assert.deepEqual(quiet.marks, []);
  const held = await setup({ singles: [single('s1', 'Alpha 1', { costPrice: 100, marketPrice: '60', tcgdexId: 'set-1', priceHold: hold({ price: 900 }), priceHoldRejected: { price: 700, date: DAYS_BACK(40) } })] });
  held.clock = setClock(held, TODAY_FIXED + 'T04:00:00Z');
  held.ctx.applyPriceToGroup('s1', 'singles', [], 60, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal('priceHold' in held.row('s1'), false, 'the hold on some other price is obsolete');
  assert.equal('priceHoldRejected' in held.row('s1'), false, 'and the row is being written, so the old rejection goes too');
  assert.deepEqual(held.marks, ['singles:s1']);
});

// ── Accept and Reject ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function held(extra, table) {
  const row = table === 'slabs' ? slab('x1', 'Charmander 4', extra) : single('x1', 'Charmander 4', extra);
  const app = await setup(table === 'slabs' ? { slabs: [row] } : { singles: [row] });
  app.ctx.applyPriceToGroup('x1', table || 'singles', [], 644.63, 'USD', 'TCGdex (TCGplayer)', 'high', 'base1-4');
  app.marks.length = 0;
  app.said.length = 0;
  return app;
}

test('Accept: the held price becomes the market price and a history entry, the hold goes, undoable, marked dirty, then flushed', async () => {
  const app = await held({ costPrice: 5, marketPrice: '5' });
  const order = [];
  const realSnap = app.ctx.snapshotForUndo;
  app.ctx.snapshotForUndo = () => { order.push('snapshot:' + app.row('x1').marketPrice); return realSnap.apply(app.ctx, arguments); };
  const realMark = app.ctx.markDirty;
  app.ctx.markDirty = (...a) => { order.push('mark:' + app.row('x1').marketPrice); return realMark.apply(app.ctx, a); };
  app.ctx._flushDirtyToSupabase = async () => { order.push('flush:' + app.row('x1').marketPrice + ':' + ('priceHold' in app.row('x1'))); app.flushes++; return { status: 'ok' }; };
  const hold = plain(app.row('x1').priceHold);
  assert.equal(await app.ctx.kjrPriceHoldAccept('singles', 'x1'), true);
  const row = app.row('x1');
  assert.equal(row.marketPrice, '645');
  assert.deepEqual(plain(row.priceHistory), [{ date: hold.date, price: 644.63, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high' }]);
  assert.equal('priceHold' in row, false);
  assert.equal(row.tcgdexId, 'base1-4', 'the match is untouched');
  assert.deepEqual(order, ['snapshot:5', 'mark:645', 'flush:645:false'], 'snapshot before the write, then mark, then the flush');
  assert.equal(app.flushes, 1);
  assert.equal(app.ctx._dirty.singles.has('x1'), true);
  assert.deepEqual(app.said, ['Accepted S$645 for Charmander 4']);
  // Ctrl+Z takes it back: the old price and the hold are both there again
  await app.ctx.undoLast();
  assert.equal(app.row('x1').marketPrice, '5');
  assert.equal(app.row('x1').priceHold.price, 644.63);
});

test('Accept on a slab writes the slab, and the history date is the day the price was last seen', async () => {
  const app = await held({ costPrice: 1, marketPrice: '4' }, 'slabs');
  app.row('x1', 'slabs').priceHold.date = '2026-10-20';
  await app.ctx.kjrPriceHoldAccept('slabs', 'x1');
  const row = app.row('x1', 'slabs');
  assert.equal(row.marketPrice, '645');
  assert.equal(row.priceHistory[0].date, '2026-10-20');
  assert.equal(app.ctx._dirty.slabs.has('x1'), true);
});

test('Accept refuses a hold that is gone or malformed, says so and changes nothing', async () => {
  const app = await held({ costPrice: 5, marketPrice: '5' });
  delete app.row('x1').priceHold;
  assert.equal(await app.ctx.kjrPriceHoldAccept('singles', 'x1'), false);
  assert.equal(await app.ctx.kjrPriceHoldAccept('singles', 'nobody'), false);
  assert.equal(await app.ctx.kjrPriceHoldAccept('etbs', 'x1'), false);
  app.row('x1').priceHold = { price: 'lots', reason: 'x' };
  assert.equal(await app.ctx.kjrPriceHoldAccept('singles', 'x1'), false, 'a hold without a price above zero is not a hold');
  app.row('x1').priceHold = null;
  assert.equal(await app.ctx.kjrPriceHoldAccept('singles', 'x1'), false);
  assert.equal(app.row('x1').marketPrice, '5');
  assert.equal(app.row('x1').priceHistory.length, 0);
  assert.equal(app.flushes, 0);
  assert.equal(app.said.filter((m) => m === 'That price is no longer waiting').length, 5);
});

test('Reject: the hold goes, the rejection is remembered, the price on the card and its match are left alone, and the toast says where to fix a wrong match', async () => {
  const app = await held({ costPrice: 5, marketPrice: '5' });
  const order = [];
  const realSnap = app.ctx.snapshotForUndo;
  app.ctx.snapshotForUndo = () => { order.push('snapshot'); return realSnap.apply(app.ctx, arguments); };
  app.ctx._flushDirtyToSupabase = async () => { order.push('flush'); app.flushes++; return { status: 'ok' }; };
  assert.equal(await app.ctx.kjrPriceHoldReject('singles', 'x1'), true);
  const row = app.row('x1');
  assert.equal('priceHold' in row, false);
  assert.deepEqual(plain(row.priceHoldRejected), { price: 644.63, date: UTC() });
  assert.equal(row.marketPrice, '5');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(row.tcgdexId, 'base1-4', 'an id the pass set is left alone');
  assert.deepEqual(app.marks, ['singles:x1']);
  assert.equal(app.flushes, 1);
  assert.deepEqual(order, ['snapshot', 'flush']);
  assert.deepEqual(app.said, ['Kept S$5. If the match is wrong, open the card to fix it']);
  // the same wrong price on a later pass is skipped without a word
  app.said.length = 0; app.marks.length = 0;
  app.ctx.applyPriceToGroup('x1', 'singles', [], 650, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal('priceHold' in row, false);
  assert.deepEqual(app.marks, []);
  assert.deepEqual(app.said, []);
});

test('Reject on a card with no price says so, and a failed upload says the change is saved on this device', async () => {
  const app = await held({ costPrice: 3, marketPrice: '' });
  app.ctx._flushDirtyToSupabase = async () => ({ status: 'error' });
  await app.ctx.kjrPriceHoldReject('singles', 'x1');
  assert.deepEqual(app.said, ['No price set. If the match is wrong, open the card to fix it. Saved on this device, cloud sync will retry, check the sync indicator']);
  const second = await held({ costPrice: 5, marketPrice: '5' });
  second.ctx._flushDirtyToSupabase = async () => { throw new Error('offline'); };
  await second.ctx.kjrPriceHoldAccept('singles', 'x1');
  assert.equal(second.row('x1').marketPrice, '645', 'the decision is kept on this device');
  assert.match(second.said[0], /^Accepted S\$645 for Charmander 4\. Saved on this device, cloud sync will retry/);
});

// ── what the owner sees ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('Needs attention: "N prices waiting for your OK" comes first, singular for one, a Review link on act price-holds', async () => {
  const { ctx } = await loadApp();
  const one = Array.from(ctx.kjrOverviewAttention({ priceHolds: 1 }));
  assert.equal(one.length, 1);
  assert.equal(one[0].text, '1 price waiting for your OK');
  assert.equal(one[0].link, 'Review');
  assert.equal(one[0].act, 'price-holds');
  assert.equal(one[0].key, 'price-holds');
  assert.equal(one[0].label, 'Review 1 price waiting for your OK', 'the link\'s name starts with its visible word and says which row it is');
  assert.equal(ctx.kjrOverviewAttention({ priceHolds: 3 })[0].text, '3 prices waiting for your OK');
  const all = ctx.kjrOverviewAttention({ priceHolds: 2, unresolved: 1, staleSingles: 3, staleSlabs: 2, pendingSales: 2 });
  assert.deepEqual(Array.from(all, (i) => i.key), ['price-holds', 'unresolved', 'stale-singles', 'stale-slabs', 'pending']);
  for (const none of [0, undefined, null, -2, NaN, 'x']) assert.deepEqual(Array.from(ctx.kjrOverviewAttention({ priceHolds: none }), (i) => i.key), [], String(none));
  assert.deepEqual(Array.from(ctx.kjrOverviewAttention({}), (i) => i.key), []);
});

test('the Overview counts the Available singles and slabs that carry a hold, and a Sold or malformed one is not counted', async () => {
  const hold = (price) => ({ price, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high', date: UTC(), prev: 5, reason: '129× cost' });
  const app = await setup({
    singles: [single('a', 'Held single', { priceHold: hold(600) }), single('b', 'Plain'), single('c', 'Sold held', { status: 'Sold', priceHold: hold(600) }),
      single('d', 'Broken hold', { priceHold: { price: 'lots' } }), single('e', 'Zero hold', { priceHold: hold(0) }), single('f', 'Null hold', { priceHold: null })],
    slabs: [slab('g', 'Held slab', { priceHold: hold(900) })],
  });
  assert.deepEqual(plain(app.ctx.kjrPriceHolds().map((r) => r.table + ':' + r.item.id)), ['singles:a', 'slabs:g']);
  app.ctx.renderDashboard();
  const hero = app.document.getElementById('dash-hero').innerHTML;
  assert.match(hero, /2 prices waiting for your OK/);
  assert.match(hero, /<button type="button" class="ov-link" aria-label="Review 2 prices waiting for your OK" data-ov-act="price-holds">Review<\/button>/);
  assert.ok(hero.indexOf('prices waiting for your OK') < hero.indexOf('Needs attention') + 400, 'in the Needs attention list');
  delete app.row('a').priceHold;
  app.ctx.renderDashboard();
  assert.match(app.document.getElementById('dash-hero').innerHTML, /1 price waiting for your OK/);
  delete app.row('g', 'slabs').priceHold;
  app.ctx.renderDashboard();
  assert.doesNotMatch(app.document.getElementById('dash-hero').innerHTML, /waiting for your OK/);
});

test('the Overview Review link opens the sheet', async () => {
  const app = await setup({ singles: [single('a', 'Held single', { priceHold: { price: 600, unit: 'USD', source: 'x', confidence: 'high', date: UTC(), prev: 5, reason: '120× cost' } })] });
  const calls = [];
  const real = app.ctx.kjrPriceHoldsOpen;
  app.ctx.kjrPriceHoldsOpen = () => calls.push('open');
  const holder = { getAttribute: (n) => (n === 'data-ov-act' ? 'price-holds' : null) };
  app.ctx._kjrOvClick({ target: { closest: () => holder } });
  assert.deepEqual(calls, ['open']);
  app.ctx.kjrPriceHoldsOpen = real;
  app.ctx._kjrOvClick({ target: { closest: () => holder } });
  assert.equal(app.document.getElementById('kjr-holds-overlay').open, true, 'the real thing opens the dialog');
});

// ── the sheet ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const clickOf = (attrs) => {
  const holder = { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
  return { type: 'click', target: { closest: () => holder } };
};
const press = (app, act, table, id) => app.document.getElementById('kjr-holds-overlay').dispatchEvent(clickOf({ 'data-ph-act': act, 'data-ph-table': table, 'data-ph-id': id }));
const hold = (extra) => Object.assign({ price: 644.63, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high', date: '2026-10-24', prev: 5, reason: '129× cost' }, extra || {});

test('the sheet lists each held price: name, language chip, S$old to S$new, reason, source and date, with Accept, Reject and Open', async () => {
  const app = await setup({
    singles: [single('a', 'Zard 4', { language: 'JP', set: 'Base Set', priceHold: hold() })],
    slabs: [slab('b', 'Alpha 1', { priceHold: hold({ price: 900, prev: null, reason: '180× cost', source: 'PPT (PSA 10)', date: '2026-10-22' }) })],
  });
  app.ctx.kjrPriceHoldsOpen();
  const dlg = app.document.getElementById('kjr-holds-overlay');
  const body = app.document.getElementById('kjr-holds-body').innerHTML;
  assert.equal(dlg.open, true);
  assert.equal((body.match(/<li class="kjr-cr-row kjr-ph-row">/g) || []).length, 2);
  assert.ok(body.indexOf('Alpha 1') < body.indexOf('Zard 4'), 'by name');
  assert.match(body, /<div class="kjr-cr-name">Zard 4<\/div>/);
  assert.match(body, /<span class="badge b-lang">JP<\/span><span class="kjr-cr-set">Base Set<\/span>/, 'the language chip, then the set');
  assert.match(body, /<span class="badge b-lang">EN<\/span><span class="kjr-cr-set">PSA 10<\/span>/, 'a slab names its grade');
  assert.match(body, /<span class="kjr-ph-was">S\$5<\/span><span class="sr-only"> to <\/span><span aria-hidden="true"> → <\/span><span class="kjr-ph-now">S\$645<\/span><span class="kjr-ph-why">129× cost<\/span>/, 'S$5 to S$645 and why');
  assert.match(body, /<span class="kjr-ph-was">No price<\/span>[\s\S]*<span class="kjr-ph-now">S\$900<\/span><span class="kjr-ph-why">180× cost<\/span>/, 'a card with no price says so');
  assert.match(body, /<span>TCGplayer market via TCGdex<\/span><span>24 Oct 2026<\/span>/, 'the source in words, and the date');
  assert.match(body, /<span>eBay sold average via PokemonPriceTracker<\/span><span>22 Oct 2026<\/span>/);
  for (const act of ['accept', 'reject', 'open']) assert.equal((body.match(new RegExp('data-ph-act="' + act + '"', 'g')) || []).length, 2, act);
  assert.match(body, /<button type="button" class="btn btn-sm" data-ph-act="accept" data-ph-table="singles" data-ph-id="a" aria-label="Accept S\$645 for Zard 4">Accept<\/button>/);
  assert.match(body, /data-ph-act="reject" data-ph-table="slabs" data-ph-id="b" aria-label="Reject S\$900 for Alpha 1">Reject<\/button>/);
  assert.match(body, /data-ph-act="open" data-ph-table="singles" data-ph-id="a" aria-label="Open Zard 4">Open<\/button>/);
  assert.match(body, /2 prices looked wrong against cost or the last price, so they were not applied\. Accept uses the new price, Reject keeps the price on the card\./);
  assert.equal(app.document.getElementById('kjr-holds-live').textContent, '2 prices waiting for your OK');
  assert.doesNotMatch(body, new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']'), 'no em-dashes');
});

test('the sheet escapes every value from a row', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const app = await setup({ singles: [single('a"b', evil, { set: evil, priceHold: hold({ reason: evil, source: evil, date: evil }) })] });
  app.ctx.kjrPriceHoldsOpen();
  const body = app.document.getElementById('kjr-holds-body').innerHTML;
  assert.doesNotMatch(body, /<img/i);
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(body, /data-ph-id="a&quot;b"/);
});

test('nothing waiting is a state of its own, it opens, says so, closes cleanly and opens again', async () => {
  const app = await setup({ singles: [single('a', 'Plain')] });
  const dlg = app.document.getElementById('kjr-holds-overlay');
  app.ctx.kjrPriceHoldsOpen();
  assert.equal(dlg.open, true);
  assert.match(app.document.getElementById('kjr-holds-body').innerHTML, /<div class="hig-empty-title">Nothing waiting<\/div>/);
  assert.doesNotMatch(app.document.getElementById('kjr-holds-body').innerHTML, /kjr-cr-list/);
  assert.equal(app.document.getElementById('kjr-holds-live').textContent, 'Nothing waiting');
  let opened = 0;
  const showModal = dlg.showModal;
  dlg.showModal = function () { opened++; return showModal.apply(this, arguments); };
  app.ctx.kjrPriceHoldsOpen();
  assert.equal(opened, 0, 'showModal() on an open dialog throws, so a second open only redraws');
  app.ctx.kjrPriceHoldsClose();
  assert.equal(dlg.open, false, 'closes');
  app.ctx.kjrPriceHoldsClose(); // a second close is harmless
  app.ctx.kjrPriceHoldsOpen();
  assert.equal(dlg.open, true, 'and opens again');
  app.ctx.kjrPriceHoldsClose();
  assert.equal(dlg.open, false);
});

test('Accept from the sheet takes the row off the list, the last one leaves the empty state, and the Overview behind it follows', async () => {
  const app = await setup({ singles: [single('a', 'Alpha 1', { priceHold: hold() }), single('b', 'Bravo 2', { priceHold: hold({ price: 700 }) })] });
  app.document.getElementById('page-dashboard').classList.add('active');
  app.ctx.renderDashboard();
  assert.match(app.document.getElementById('dash-hero').innerHTML, /2 prices waiting for your OK/);
  app.ctx.kjrPriceHoldsOpen();
  press(app, 'accept', 'singles', 'a');
  await app.settle();
  assert.equal(app.row('a').marketPrice, '645');
  const body = () => app.document.getElementById('kjr-holds-body').innerHTML;
  assert.doesNotMatch(body(), /data-ph-id="a"/, 'it left the list');
  assert.match(body(), /data-ph-id="b"/);
  assert.equal(app.document.getElementById('kjr-holds-live').textContent, '1 price waiting for your OK');
  assert.match(app.document.getElementById('dash-hero').innerHTML, /1 price waiting for your OK/, 'the Overview behind the sheet redrew');
  press(app, 'reject', 'singles', 'b');
  await app.settle();
  assert.equal(app.row('b').marketPrice, '5');
  assert.match(body(), /Nothing waiting/);
  assert.equal(app.document.getElementById('kjr-holds-live').textContent, 'Nothing waiting');
  assert.doesNotMatch(app.document.getElementById('dash-hero').innerHTML, /waiting for your OK/);
  assert.equal(app.document.getElementById('kjr-holds-overlay').open, true, 'the sheet stays open until Done');
  app.ctx.kjrPriceHoldsClose();
});

test('Open puts the card\'s edit form on top of the sheet, singles and slabs, and the sheet follows an edit saved over it', async () => {
  const app = await setup({ singles: [single('a', 'Alpha 1', { priceHold: hold() })], slabs: [slab('b', 'Bravo 2', { priceHold: hold({ price: 700 }) })] });
  const opened = [];
  app.ctx.openEditSingle = (id) => opened.push(['single', id]);
  app.ctx.openEditSlab = (id) => opened.push(['slab', id]);
  app.ctx.kjrPriceHoldsOpen();
  press(app, 'open', 'singles', 'a');
  press(app, 'open', 'slabs', 'b');
  assert.deepEqual(opened, [['single', 'a'], ['slab', 'b']]);
  assert.equal(app.document.getElementById('kjr-holds-overlay').open, true, 'the sheet stays up');
  press(app, 'open', 'singles', 'gone');
  assert.deepEqual(opened, [['single', 'a'], ['slab', 'b']], 'a card that has gone opens nothing');
  assert.ok(app.said.includes('That card is no longer in your collection'));
  // the edit form fixes the match and saves: renderSingles redraws, and the sheet loses a row it has no business showing
  delete app.row('a').priceHold;
  app.ctx.renderSingles();
  assert.doesNotMatch(app.document.getElementById('kjr-holds-body').innerHTML, /data-ph-id="a"/);
  delete app.row('b', 'slabs').priceHold;
  app.ctx.renderSlabs();
  assert.match(app.document.getElementById('kjr-holds-body').innerHTML, /Nothing waiting/);
});

test('a redraw with nothing changed leaves the sheet markup alone, so a pressed button is never replaced under a finger', async () => {
  const app = await setup({ singles: [single('a', 'Alpha 1', { priceHold: hold() })] });
  const body = app.document.getElementById('kjr-holds-body');
  let writes = 0, markup = '';
  Object.defineProperty(body, 'innerHTML', { configurable: true, get: () => markup, set: (v) => { markup = String(v); writes++; } });
  app.ctx.kjrPriceHoldsOpen();
  assert.equal(writes, 1);
  app.ctx.renderSingles();
  app.ctx.renderSlabs();
  assert.equal(writes, 1, 'two redraws, no change, no write');
  app.row('a').priceHold.price = 700;
  app.ctx.renderSingles();
  assert.equal(writes, 2, 'a change is drawn');
  app.ctx.kjrPriceHoldsClose();
  app.row('a').priceHold.price = 800;
  app.ctx.renderSingles();
  assert.equal(writes, 2, 'a closed sheet is not drawn at all');
});

function fakeHoldsBody(app) {
  const body = app.document.getElementById('kjr-holds-body');
  let markup = '', nodes = [], rows = [];
  const state = { focused: null };
  const parse = (m) => {
    const out = [];
    let row = -1;
    rows = [];
    const re = /<li class="kjr-cr-row kjr-ph-row"|<button type="button" class="btn btn-sm" data-ph-act="([a-z]+)" data-ph-table="([^"]*)" data-ph-id="([^"]*)"/g;
    let hit;
    while ((hit = re.exec(m))) {
      if (!hit[1]) { row++; rows[row] = { _row: row }; continue; }
      const idx = row, attrs = { 'data-ph-act': hit[1], 'data-ph-table': hit[2], 'data-ph-id': hit[3] };
      const node = { getAttribute: (n) => attrs[n] || null, closest: () => rows[idx], focus() { state.focused = node; } };
      out.push(node);
    }
    return out;
  };
  Object.defineProperty(body, 'innerHTML', { configurable: true, get: () => markup, set: (v) => { markup = String(v); nodes = parse(markup); } });
  app.document.getElementById('kjr-holds-overlay').contains = (n) => nodes.includes(n);
  body.querySelectorAll = (sel) => {
    if (sel === '.kjr-ph-row') return rows.slice();
    const m = sel.match(/^\[data-ph-act(?:="([a-z]+)")?\]$/);
    return m ? nodes.filter((n) => !m[1] || n.getAttribute('data-ph-act') === m[1]) : [];
  };
  state.nodes = () => nodes;
  return state;
}

test('after Accept or Reject the keyboard focus lands on the same button of the next card, not on a button that is gone', async () => {
  const app = await setup({ singles: ['Alpha 1', 'Bravo 2', 'Charlie 3'].map((n, i) => single('c' + i, n, { priceHold: hold() })) });
  const sheet = fakeHoldsBody(app);
  app.ctx.kjrPriceHoldsOpen();
  const node = (act, id) => sheet.nodes().find((n) => n.getAttribute('data-ph-act') === act && n.getAttribute('data-ph-id') === id);
  app.document.activeElement = node('accept', 'c1');
  await app.ctx.kjrPriceHoldAccept('singles', 'c1');
  assert.ok(sheet.focused, 'focus was moved');
  assert.equal(sheet.focused.getAttribute('data-ph-act'), 'accept');
  assert.equal(sheet.focused.getAttribute('data-ph-id'), 'c2', 'to the card that took its place');
  app.document.activeElement = node('reject', 'c2');
  await app.ctx.kjrPriceHoldReject('singles', 'c2');
  assert.equal(sheet.focused.getAttribute('data-ph-act'), 'reject');
  assert.equal(sheet.focused.getAttribute('data-ph-id'), 'c0', 'the last card hands it to the one before');
  app.document.getElementById('kjr-holds-title').focus = () => { sheet.focused = { title: true }; };
  app.document.activeElement = node('accept', 'c0');
  await app.ctx.kjrPriceHoldAccept('singles', 'c0');
  assert.equal(sheet.focused.title, true, 'an empty list: the title');
});

// ── a price typed by hand settles a held price ────────────────────────────────────────────────────────────────────────────────────────
// The owner has just decided the price, so a hold waiting on that decision and the memory of a rejected one are both deleted, by the inline
// table edit (updateField) and by the edit form's save. A save that leaves the market price as it was keeps them. The row is marked dirty by the
// save path itself, so the deletion syncs.
const waiting = (extra) => Object.assign({ costPrice: 5, marketPrice: '5', priceHold: hold(), priceHoldRejected: { price: 300, date: ago(4) } }, extra || {});

test('inline edit: a market price typed in the table deletes the hold and the rejection, marks the row dirty, and the Overview forgets the row', async () => {
  const app = await setup({ singles: [single('a', 'Charmander 4', waiting())], slabs: [slab('b', 'Charizard 4', waiting({ costPrice: 100, marketPrice: '150' }))] });
  assert.equal(app.ctx.kjrPriceHolds().length, 2, 'precondition');
  app.ctx.updateField('singles', 'a', 'marketPrice', '600');
  const a = app.row('a');
  assert.equal(a.marketPrice, '600');
  assert.equal('priceHold' in a, false);
  assert.equal('priceHoldRejected' in a, false);
  assert.deepEqual(app.marks, ['singles:a'], 'marked dirty by the existing save path, once');
  assert.equal(app.ctx._dirty.singles.has('a'), true);
  assert.equal(a.priceHistory.length, 1, 'the manual entry the inline edit always wrote');
  assert.equal(a.priceHistory[0].source, 'manual');
  assert.deepEqual(plain(app.ctx.kjrPriceHolds().map((r) => r.item.id)), ['b']);
  app.ctx.updateField('slabs', 'b', 'marketPrice', '200');
  assert.equal(app.row('b', 'slabs').marketPrice, '200');
  assert.equal('priceHold' in app.row('b', 'slabs'), false, 'a slab too');
  assert.equal('priceHoldRejected' in app.row('b', 'slabs'), false);
  assert.equal(app.ctx._dirty.slabs.has('b'), true);
  assert.equal(app.ctx.kjrPriceHolds().length, 0);
});

test('inline edit: clearing the price is a decision too, and a value or a field the edit leaves alone keeps the hold', async () => {
  const app = await setup({ singles: [single('a', 'Charmander 4', waiting()), single('b', 'Bravo 2', waiting()), single('c', 'Charlie 3', waiting())] });
  app.ctx.updateField('singles', 'a', 'marketPrice', '');
  assert.equal(app.row('a').marketPrice, '');
  assert.equal('priceHold' in app.row('a'), false, 'a cleared price settles it');
  assert.equal('priceHoldRejected' in app.row('a'), false);
  app.marks.length = 0;
  app.ctx.updateField('singles', 'b', 'marketPrice', '5');
  assert.deepEqual(app.marks, [], 'the same value is no edit at all');
  assert.equal(app.row('b').priceHold.price, 644.63);
  assert.equal(app.row('b').priceHoldRejected.price, 300);
  app.ctx.updateField('singles', 'c', 'listPrice', '40');
  app.ctx.updateField('singles', 'c', 'costPrice', '6');
  app.ctx.updateField('singles', 'c', 'notes', 'a note');
  assert.equal(app.row('c').priceHold.price, 644.63, 'another field is not a price decision');
  assert.equal(app.row('c').priceHoldRejected.price, 300);
  assert.deepEqual(app.marks, ['singles:c', 'singles:c', 'singles:c'], 'the edits themselves still sync');
});

async function formSave(table, extra, edits) {
  const row = table === 'slabs' ? slab('f1', 'Charmander 4', extra) : single('f1', 'Charmander 4', extra);
  const app = await setup(table === 'slabs' ? { slabs: [row] } : { singles: [row] });
  if (table === 'slabs') app.ctx.openEditSlab('f1'); else app.ctx.openEditSingle('f1');
  for (const [el, value] of Object.entries(edits || {})) app.document.getElementById(el).value = value;
  app.marks.length = 0;
  app.said.length = 0;
  if (table === 'slabs') await app.ctx.saveSlab(); else await app.ctx.saveSingle();
  app.saved = () => app.row('f1', table);
  return app;
}
const FORM = { singles: { market: 'ms-market', notes: 'ms-notes' }, slabs: { market: 'msl-market', notes: 'msl-notes' } };

for (const table of ['singles', 'slabs']) {
  test(`edit form (${table}): saving a market price typed by hand deletes the hold and the rejection, and the save path marks the row dirty`, async () => {
    const app = await formSave(table, waiting(), { [FORM[table].market]: '600' });
    assert.ok(app.said.includes('Updated!'), JSON.stringify(app.said));
    assert.equal(app.saved().marketPrice, 600);
    assert.equal('priceHold' in app.saved(), false);
    assert.equal('priceHoldRejected' in app.saved(), false);
    assert.equal(app.marks.includes(table + ':f1'), true, 'marked dirty by the existing save');
    assert.equal(app.ctx._dirty[table].has('f1'), true);
    assert.equal(app.ctx.kjrPriceHolds().length, 0);
  });

  test(`edit form (${table}): clearing the market price is a decision too`, async () => {
    const app = await formSave(table, waiting(), { [FORM[table].market]: '' });
    assert.equal(app.saved().marketPrice, '');
    assert.equal('priceHold' in app.saved(), false);
    assert.equal('priceHoldRejected' in app.saved(), false);
  });

  test(`edit form (${table}): a save that leaves the market price as it was keeps the hold and the rejection, however the price is written`, async () => {
    for (const [why, edits] of [
      ['a note only', { [FORM[table].notes]: 'a new note' }],
      ['the same price retyped', { [FORM[table].market]: '5', [FORM[table].notes]: 'x' }],
      ['the same price with a decimal point', { [FORM[table].market]: '5.00' }],
    ]) {
      const app = await formSave(table, waiting(), edits);
      assert.ok(app.said.includes('Updated!'), why);
      assert.equal(app.saved().priceHold.price, 644.63, why + ': the hold is still waiting');
      assert.deepEqual(plain(app.saved().priceHoldRejected), { price: 300, date: ago(4) }, why + ': and so is the rejection');
      assert.equal(app.ctx.kjrPriceHolds().length, 1, why);
    }
  });
}

test('edit form: a card with no hold is saved as before, a typed price adds no key', async () => {
  const app = await formSave('singles', { costPrice: 5, marketPrice: '5' }, { 'ms-market': '600' });
  assert.equal(app.saved().marketPrice, 600);
  assert.equal('priceHold' in app.saved(), false);
  assert.equal('priceHoldRejected' in app.saved(), false);
});

// ── nothing else moves ────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('valuation never reads a hold: the totals, the tiles and the effective price are the same with or without it', async () => {
  const rows = () => ({
    singles: [single('a', 'Alpha 1', { costPrice: 5, marketPrice: '5' }), single('b', 'Bravo 2', { costPrice: 10, marketPrice: '' })],
    slabs: [slab('c', 'Charlie 3', { costPrice: 100, marketPrice: '150' })],
  });
  const plainApp = await setup(rows());
  const heldApp = await setup(rows());
  heldApp.ctx.applyPriceToGroup('a', 'singles', [], 644.63, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  heldApp.ctx.applyPriceToGroup('b', 'singles', [], 900, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  heldApp.ctx.applyPriceToGroup('c', 'slabs', [], 5000, 'USD', 'PPT (PSA 10)', 'high', null);
  assert.equal(heldApp.ctx.kjrPriceHolds().length, 3, 'precondition: all three are held');
  const keys = ['totalMktValue', 'unrealisedPL', 'invCostSingles', 'invCostSlabs'];
  const a = plainApp.ctx.computeDashboardStats(), b = heldApp.ctx.computeDashboardStats();
  for (const k of keys) assert.equal(b[k], a[k], k);
  assert.equal(b.totalMktValue, 5 + 10 + 150, 'the single with no price is counted at cost, as always');
  for (const [id, t] of [['a', 'singles'], ['b', 'singles'], ['c', 'slabs']]) {
    assert.deepEqual(plain(heldApp.ctx.effectiveMarketInfo(heldApp.row(id, t))), plain(plainApp.ctx.effectiveMarketInfo(plainApp.row(id, t))), id);
  }
  assert.deepEqual(plain(heldApp.ctx.kjrOverviewTop(5).map((r) => [r.item.id, r.value])), plain(plainApp.ctx.kjrOverviewTop(5).map((r) => [r.item.id, r.value])));
  heldApp.ctx.renderDashboard();
  plainApp.ctx.renderDashboard();
  const hero = (app) => app.document.getElementById('dash-hero').innerHTML.replace(/<ul class="ov-att-list">[\s\S]*?<\/ul>/, '').replace(/<div class="ov-att-head[\s\S]*?<\/div>/, '');
  assert.equal(hero(heldApp), hero(plainApp), 'the hero is the same bar its Needs attention list');
});

test('the edit form keeps a hold while the card\'s pricing identity is unchanged and drops it when the name, language or id changes', async () => {
  const { ctx } = await loadApp();
  const existing = { id: 'a', name: 'Charmander 4', language: 'EN', tcgdexId: 'base1-4', priceHold: { price: 600 }, priceHoldRejected: { price: 500, date: '2026-10-01' }, _tcgdexPricedDate: '2026-10-24' };
  const same = { id: 'a', name: 'Charmander 4', language: 'EN', tcgdexId: 'base1-4' };
  ctx._preserveModalOffFormKeys('singles', same, existing);
  assert.deepEqual(plain(same.priceHold), { price: 600 }, 'an edit of the notes keeps the hold');
  assert.deepEqual(plain(same.priceHoldRejected), { price: 500, date: '2026-10-01' });
  for (const change of [{ name: 'Charmander 5' }, { language: 'JP' }, { tcgdexId: 'base1-5' }]) {
    const edited = Object.assign({ id: 'a', name: 'Charmander 4', language: 'EN', tcgdexId: 'base1-4' }, change);
    ctx._preserveModalOffFormKeys('singles', edited, existing);
    assert.equal('priceHold' in edited, false, 'the match changed (' + Object.keys(change) + '): the hold was for the old one');
    assert.equal('priceHoldRejected' in edited, false);
    assert.equal('_tcgdexPricedDate' in edited, false);
  }
  const slabEdit = { id: 'b', name: 'Alpha 1', grader: 'PSA', grade: '9', language: 'EN', tcgdexId: '' };
  ctx._preserveModalOffFormKeys('slabs', slabEdit, { id: 'b', name: 'Alpha 1', grader: 'PSA', grade: '10', language: 'EN', tcgdexId: '', priceHold: { price: 600 } });
  assert.equal('priceHold' in slabEdit, false, 'a slab\'s grade is part of its identity');
});

test('a price held on one device reaches the next: priceHold and priceHoldRejected are synced fields, with no underscore', async () => {
  const app = await setup({ singles: [single('s1', 'Charmander 4', { costPrice: 5, marketPrice: '5' })] });
  app.ctx.applyPriceToGroup('s1', 'singles', [], 644.63, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  const sent = JSON.parse(JSON.stringify(app.row('s1')));
  assert.ok(sent.priceHold && sent.priceHold.price === 644.63, 'it survives the JSON the upsert sends');
  assert.ok(!Object.keys(sent).some((k) => k.startsWith('_') && /hold/i.test(k)), 'and no underscore key carries it');
  // Server/CAS.sql drops only underscore keys (and the row's own version columns) from the stored data column, so no schema change carries these
  const cas = fs.readFileSync(ROOT + '/Server/CAS.sql', 'utf8');
  const cleaner = cas.slice(cas.indexOf('function public.collectibles_clean_data'), cas.indexOf('function public.collectibles_clean_trash_data'));
  assert.match(cleaner, /where left\(key, 1\) <> '_'\s+and key not in \('row_version', 'updated_at'\)/);
});

test('the sheet is wired in the page and styled with design tokens only', () => {
  assert.match(html, /<dialog class="overlay" id="kjr-holds-overlay" aria-labelledby="kjr-holds-title">/);
  assert.match(html, /<h3 id="kjr-holds-title" tabindex="-1">Prices waiting for your OK<\/h3>/);
  assert.match(html, /id="kjr-holds-live" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /<div class="modal-body" id="kjr-holds-body"><\/div>/);
  assert.match(html, /onclick="kjrPriceHoldsClose\(\)" aria-label="Close"/);
  assert.match(html, /<button class="btn" type="button" onclick="kjrPriceHoldsClose\(\)">Done<\/button>/);
  assert.equal((html.match(/id="kjr-holds-overlay"/g) || []).length, 1, 'one dialog');
  const block = css.match(/\.kjr-ph-prices\{[^\n]*\n(?:\.kjr-ph-[^\n]*\n)+/)[0];
  assert.match(block, /\.kjr-ph-why\{[^}]*var\(--amber\)[^}]*var\(--amber-soft\)/);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'no raw colour');
});
