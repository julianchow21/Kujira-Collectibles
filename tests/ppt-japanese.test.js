'use strict';
// v3.85, the Japanese lane: a Japanese single with a card number is priced from PokemonPriceTracker's Japanese
// catalogue (language=japanese, limit=3), its price the card's TCGplayer market (prices.market). The match is strict: exactly one card
// whose number is the row's number, whose name and mechanic tags fit, nothing guessed. Anything else is a data miss that lands in the
// Singles "could not be matched" banner. A currency that is not USD is converted, never stored as dollars. Chinese, Indonesian and every
// other language stay manual, with the lane on as well. Fetch is stubbed (tests/harness.js), nothing here reaches a real API. The Japanese
// answer shape is assumed to be the English one (not yet seen live), which is why the lane ships OFF (PPT_JA_LANE_ENABLED): every test up to
// the last section turns it on through the harness, loadApp({ jaLane: true }), and the last section is the shipped state, the lane off.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeSeed, jsonResponse, plain } = require('./harness.js');

process.env.TZ = 'Asia/Singapore';

const jpCard = (o) => Object.assign({ id: 'jp-6', name: 'Charizard ex', setName: 'Pokemon Card 151', cardNumber: '006/165', language: 'Japanese', prices: { market: 12.5 } }, o);
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total: total === undefined ? 3 : total } } });
const single = (o) => Object.assign({
  id: 'j1', name: 'Charizard ex 006', type: 'raw', language: 'JP', condition: 'Near Mint', qty: 1, costPrice: 10, marketPrice: '', listPrice: '',
  status: 'Available', notes: '', priceHistory: [],
}, o);

// the lane's own waits: the 6 second gap between PPT searches, the 250ms TCGdex gap. Not the app's startup timers.
async function drain(fn, timers) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 120 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => [6000, 250, 1100].includes(e.delay));
  }
  return p;
}

// respond: (decodedUrl) => the cards of that search. Rate 2 keeps the arithmetic whole (a 12.5 USD card is S$25).
// laneOn: the lane is switched on through the harness unless a test passes false, which is the shipped state (PPT_JA_LANE_ENABLED false)
async function setup(singles, respond, rate, laneOn) {
  const app = await loadApp({ jaLane: laneOn !== false, seed: { singles: singles || [single()], slabs: [] } });
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  // the page's own two rates, USD and EUR. A rate for any other currency is a test's to route, so an unrouted one is a source that is down.
  app.fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: rate === undefined ? 2 : rate }] });
  app.fetchMock.route('/ppt/cards', (url) => answer((respond || (() => [jpCard()]))(decodeURIComponent(url))));
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.row = (id) => app.ctx.DB.singles.find((r) => r.id === id);
  return app;
}

// ── the request and the price ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-japanese: one search of the Japanese catalogue, "<name without its number> <number>", limit 3, no eBay data', async () => {
  const app = await setup();
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.ppt().length, 1);
  const url = new URL(app.ppt()[0].url);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['language', 'limit', 'search']);
  assert.equal(url.searchParams.get('search'), 'Charizard ex 006');
  assert.equal(url.searchParams.get('language'), 'japanese');
  assert.equal(url.searchParams.get('limit'), '3');
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')).length, 0, 'TCGdex is never asked');
});

test('ppt-japanese: a name written "Umbreon VMAX 215/203" searches "Umbreon VMAX 215"', async () => {
  const app = await setup([single({ name: 'Umbreon VMAX 215/203' })], () => [jpCard({ name: 'Umbreon VMAX', cardNumber: '215/203' })]);
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(new URL(app.ppt()[0].url).searchParams.get('search'), 'Umbreon VMAX 215');
  assert.equal(app.row('j1').marketPrice, '25');
});

test('ppt-japanese: the price is prices.market in USD converted to SGD, and the history entry says where it came from', async () => {
  const app = await setup([single({ marketPrice: 40 })]); // a hand-typed price, no history
  await app.ctx.refreshPrice('j1', 'singles');
  const row = app.row('j1');
  assert.equal(row.marketPrice, '25', '12.5 USD at 2');
  assert.deepEqual(plain(row.priceHistory), [{ date: new Date().toISOString().slice(0, 10), price: 25, unit: 'USD', source: 'PPT (Japanese)', confidence: 'medium' }]);
  assert.equal(app.ctx._dirty.singles.has('j1'), true, 'a replaced hand price syncs');
  assert.equal(row._tcgdexMissDate, undefined);
  assert.ok(app.toasts.some((t) => /^Updated S\$25 \(PPT \(Japanese\)\)$/.test(t)), JSON.stringify(app.toasts));
});

test('ppt-japanese: a card with no prices.market is a miss, never a zero or a guess from another field', async () => {
  for (const prices of [undefined, {}, { market: null }, { market: 0 }, { market: 'n/a' }, { low: 9, mid: 10 }]) {
    const app = await setup([single({ marketPrice: 40 })], () => [jpCard({ prices })]);
    await app.ctx.refreshPrice('j1', 'singles');
    assert.equal(app.row('j1').marketPrice, 40, 'the hand price stays: ' + JSON.stringify(prices));
    assert.equal(app.row('j1').priceHistory.length, 0);
    assert.ok(app.toasts.some((t) => /^ERR No price found .* PPT: no price data$/.test(t)), JSON.stringify(app.toasts));
  }
});

// ── exactly one card, or nothing ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-japanese: two cards that both fit is a miss: nothing written, the card listed in the banner, the error says how many', async () => {
  const app = await setup([single({ marketPrice: 40 })], () => [jpCard({ id: 'a', setName: 'Set A', prices: { market: 5 } }), jpCard({ id: 'b', setName: 'Set B', prices: { market: 99 } })]);
  await app.ctx.refreshPrice('j1', 'singles');
  const row = app.row('j1');
  assert.equal(row.marketPrice, 40, 'no price on a non-unique match');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(app.ctx._dirty.singles.has('j1'), false);
  assert.equal(row._tcgdexMissDate, app.ctx.kjrLocalDay(), 'the local marker puts it on the could-not-be-matched list');
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles().map((r) => r.id)), ['j1']);
  assert.ok(app.toasts.some((t) => /PPT: no unique match \(2 cards fit\)/.test(t)), JSON.stringify(app.toasts));
});

test('ppt-japanese: the same card listed twice counts once', async () => {
  const app = await setup([single()], () => [jpCard(), jpCard()]);
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.row('j1').marketPrice, '25');
});

test('ppt-japanese: one fitting card among others that do not is priced, the others never are', async () => {
  const cards = [
    jpCard({ id: 'plain', name: 'Charizard', prices: { market: 1 } }),          // no ex
    jpCard({ id: 'other-no', cardNumber: '016/165', prices: { market: 2 } }),    // another number
    jpCard({ id: 'right', prices: { market: 12.5 } }),
  ];
  const app = await setup([single()], () => cards);
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.row('j1').marketPrice, '25');
});

test('ppt-japanese: no card number in the name means no search at all, and the lane is manual', async () => {
  const app = await setup([single({ name: 'Charizard ex' })]);
  assert.equal(app.ctx._queueLaneFor(app.row('j1')), 'manual');
  const direct = await app.ctx.fetchJapanesePriceFromPPT('Charizard ex', 'JP');
  assert.equal(direct.error, 'no card number');
  const routed = await app.ctx.fetchMarketPrice({ name: 'Charizard ex', language: 'JP', japanese: true });
  assert.equal(routed.maxSgd, null);
  assert.equal(routed.pptError, 'no card number');
  assert.equal(routed.creditsUsed, 0);
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.ppt().length, 0, 'not one request');
  assert.ok(app.toasts.includes('Add or fix the card number for exact pricing'), JSON.stringify(app.toasts));
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles()), [], 'a card that was never asked is not listed as unmatched');
});

test('ppt-japanese: a blank name is a miss with no request, and a number alone is not a name', async () => {
  const app = await setup();
  assert.equal((await app.ctx.fetchJapanesePriceFromPPT('   ', 'JP')).error, 'no card name');
  assert.equal((await app.ctx.fetchJapanesePriceFromPPT('', 'JP')).error, 'no card name');
  assert.equal((await app.ctx.fetchJapanesePriceFromPPT('006', 'JP')).error, 'no card number', 'token 0 is the name, never the number');
  assert.equal(app.ppt().length, 0);
});

test('ppt-japanese: the card number must match, "006/165", "SV2a 006/165" and "6" are all 6, "016" and "TG6" are not', async () => {
  const ok = async (cardNumber) => (await setup([single()], () => [jpCard({ cardNumber })])).ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP');
  for (const n of ['006/165', 'SV2a 006/165', '6', '006', ' 006 / 165 ']) assert.equal((await ok(n)).amount, 12.5, n);
  for (const n of ['016/165', 'TG6/TG30', '60', '', undefined, null]) assert.equal((await ok(n)).error, 'no match', String(n));
  const older = await (await setup([single()], () => [jpCard({ cardNumber: undefined, number: '6' })])).ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP');
  assert.equal(older.amount, 12.5, 'the older number field is read too');
});

test('ppt-japanese: the name must fit, same species and the same mechanic tags', async () => {
  const fits = async (rowName, cardName) => {
    const num = (rowName.match(/\d+/) || ['1'])[0]; // the card carries the row's number, this is about the name
    const app = await setup([single({ name: rowName })], () => [jpCard({ name: cardName, cardNumber: num + '/165' })]);
    return !!(await app.ctx.fetchJapanesePriceFromPPT(rowName, 'JP')).amount;
  };
  assert.equal(await fits('Charizard ex 006', 'Charizard ex'), true);
  assert.equal(await fits('Charizard ex 006', 'Charizard EX'), true, 'case');
  assert.equal(await fits('Charizard ex 006', 'Charizard ex (Special Art Rare)'), true, 'a bracketed trailer');
  assert.equal(await fits('Charizard ex 006', 'Charizard ex - 006/165'), true, 'a dashed trailer');
  assert.equal(await fits('Charizard ex 006', 'Charizard ex Holo'), true, 'a printing word');
  assert.equal(await fits('Pikachu 25', 'Pikachu'), true);
  assert.equal(await fits('Flabébé 85', 'Flabebe'), true, 'accents');
  assert.equal(await fits("Farfetch'd 80", 'Farfetchd'), true, 'apostrophes');
  assert.equal(await fits('Charizard ex 006', 'Charizard'), false, 'the plain Charizard is not the ex');
  assert.equal(await fits('Charizard 006', 'Charizard ex'), false, 'and the ex is not the plain one');
  assert.equal(await fits('Umbreon VMAX 215', 'Umbreon V'), false, 'VMAX is not V');
  assert.equal(await fits('Umbreon V 215', 'Umbreon VMAX'), false);
  assert.equal(await fits('Pikachu 25', 'Pikachu & Zekrom GX'), false, 'a tag team is another card');
  assert.equal(await fits('Charizard ex 006', 'Charmeleon ex'), false, 'another species');
  assert.equal(await fits('Charizard 006', 'Dark Charizard'), false, 'an extra species word');
  assert.equal(await fits('Dark Charizard 006', 'Charizard'), false, 'a missing species word');
  assert.equal(await fits('Mega Charizard X ex 006', 'Mega Charizard X ex'), true);
  assert.equal(await fits('Mega Charizard X ex 006', 'Charizard X ex'), false, 'Mega is a tag');
  assert.equal(await fits('Pikachu 25', ''), false, 'a card with no name can not be checked');
  assert.equal(await fits('Pikachu 25', undefined), false);
  assert.equal(await fits('Pikachu 25', 99), false);
});

test('ppt-japanese: a card the vendor labels with another language is not taken, one with no label is', async () => {
  for (const [language, ok] of [['Japanese', true], ['JP', true], ['ja', true], [undefined, true], ['', true], ['English', false], ['en', false], ['Korean', false]]) {
    const app = await setup([single()], () => [jpCard({ language })]);
    assert.equal(!!(await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP')).amount, ok, String(language));
  }
});

test('ppt-japanese: junk in the answer never throws and never prices', async () => {
  for (const cards of [[], [null], [42], ['x'], [{}], [{ name: 'Charizard ex' }]]) {
    const app = await setup([single()], () => cards);
    const r = await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP');
    assert.equal(r.amount, undefined, JSON.stringify(cards));
  }
  const app = await setup();
  app.fetchMock.route('/ppt/cards', () => jsonResponse({ nothing: 'here' }));
  assert.equal((await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP')).error, 'no match');
  app.fetchMock.route('/ppt/cards', () => jsonResponse(null));
  assert.equal((await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP')).error, 'no match');
});

// ── the currency guard ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-japanese: a card with no currency field, or USD, is dollars', async () => {
  for (const extra of [{}, { currency: 'USD' }, { currency: 'usd' }, { prices: { market: 12.5, currency: 'USD' } }, { currency: '' }, { currency: null }]) {
    const app = await setup([single()], () => [jpCard(extra)]);
    const r = await app.ctx.fetchMarketPrice({ name: 'Charizard ex 006', language: 'JP', japanese: true });
    assert.equal(r.maxUsd, 12.5, JSON.stringify(extra));
    assert.equal(r.unit, 'USD');
    assert.equal(r.maxSgd, 25);
  }
});

test('ppt-japanese: a card priced in another currency is converted by that currency\'s own rate, never stored as dollars', async () => {
  const app = await setup([single({ marketPrice: 40 })], () => [jpCard({ currency: 'JPY', prices: { market: 12500 } })]);
  app.fetchMock.route('base=JPY', { ok: true, json: [{ quote: 'SGD', rate: 0.0087 }] });
  await app.ctx.refreshPrice('j1', 'singles');
  const row = app.row('j1');
  assert.equal(row.marketPrice, '109', '12,500 yen at 0.0087 is S$108.75, not S$25,000 from reading yen as dollars');
  assert.equal(row.priceHistory[0].unit, 'JPY');
  assert.ok(Math.abs(row.priceHistory[0].price - 108.75) < 1e-9, 'the SGD figure, 12,500 x 0.0087');
  assert.equal(row.priceHistory[0].source, 'PPT (Japanese)');
  const routed = await app.ctx.fetchMarketPrice({ name: 'Charizard ex 006', language: 'JP', japanese: true });
  assert.equal(routed.maxUsd, null, 'no USD figure is invented');
  assert.equal(routed.unit, 'JPY');
});

test('ppt-japanese: a currency on the prices block is read too, and EUR uses the EUR rate', async () => {
  const app = await setup([single()], () => [jpCard({ prices: { market: 10, currency: 'eur' } })]);
  app.fetchMock.route('base=EUR', { ok: true, json: [{ quote: 'SGD', rate: 1.5 }] });
  const r = await app.ctx.fetchMarketPrice({ name: 'Charizard ex 006', language: 'JP', japanese: true });
  assert.equal(r.maxEur, 10);
  assert.equal(r.maxUsd, null);
  assert.equal(r.maxSgd, 15);
  assert.equal(r.unit, 'EUR');
});

test('ppt-japanese: with no exchange rate for the currency nothing is priced, and it is not a miss either', async () => {
  const app = await setup([single({ marketPrice: 40 })], () => [jpCard({ currency: 'JPY', prices: { market: 12500 } })]);
  // every FX source is down (the harness default is offline) and no rate was ever cached for yen
  await app.ctx.refreshPrice('j1', 'singles');
  const row = app.row('j1');
  assert.equal(row.marketPrice, 40, 'the hand price stays');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(row._tcgdexMissDate, undefined, 'a card that could not be converted is not listed as unmatched');
  assert.ok(app.toasts.some((t) => /Could not reach PokemonPriceTracker \(no exchange rate for JPY\)\. Nothing was marked as unmatched/.test(t)), JSON.stringify(app.toasts));
  assert.equal((await app.ctx.getFxToSgd('JPY')), null);
  assert.equal(await app.ctx.getFxToSgd('not a code'), null);
  assert.equal(await app.ctx.getFxToSgd('SGD'), 1);
});

test('ppt-japanese: a stale cached rate stands in when every source is down, and a new one is cached for the day', async () => {
  const app = await setup();
  assert.equal(await app.ctx.getFxToSgd('JPY'), null);
  app.fetchMock.route('base=JPY', { ok: true, json: [{ quote: 'SGD', rate: 0.0087 }] });
  assert.equal(await app.ctx.getFxToSgd('JPY'), 0.0087);
  assert.deepEqual(plain(JSON.parse(app.localStorage.getItem('pokeinv_fxrate_jpy'))), { date: new Date().toISOString().slice(0, 10), rate: 0.0087 });
  app.fetchMock.reset();
  assert.equal(await app.ctx.getFxToSgd('JPY'), 0.0087, 'today\'s cache, no request');
  assert.equal(app.fetchMock.calls.length, 0);
  app.localStorage.setItem('pokeinv_fxrate_jpy', JSON.stringify({ date: '2026-01-01', rate: 0.009 }));
  assert.equal(await app.ctx.getFxToSgd('JPY'), 0.009, 'sources down: the last rate it cached');
});

test('ppt-japanese: a rate that is zero, negative, text or absurd from a source is refused', async () => {
  for (const rate of [0, -1, 'x', null, 1e9]) {
    const app = await setup();
    app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate }] });
    assert.equal(await app.ctx.getFxToSgd('JPY'), null, String(rate));
  }
});

test('ppt-japanese: a currency field that is not a currency code is a miss, the amount is not read as dollars', async () => {
  for (const currency of ['$', 'US$', 12, 'Yen!']) {
    const app = await setup([single({ marketPrice: 40 })], () => [jpCard({ currency })]);
    await app.ctx.refreshPrice('j1', 'singles');
    assert.equal(app.row('j1').marketPrice, 40, String(currency));
    assert.ok(app.toasts.some((t) => /PPT: unreadable currency/.test(t)), JSON.stringify(app.toasts));
  }
  // three letters that no source has a rate for are not dollars either: no rate, no price
  const app = await setup([single({ marketPrice: 40 })], () => [jpCard({ currency: 'yen' })]);
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.row('j1').marketPrice, 40);
  assert.ok(app.toasts.some((t) => /no exchange rate for YEN/.test(t)), JSON.stringify(app.toasts));
});

// ── the flag, the languages and the lane rules ────────────────────────────────────────────────────────────────────────────────────

test('ppt-japanese: a custom card is not queued, not asked, and a stale queue entry for it spends nothing', async () => {
  const app = await setup([single({ customCard: true, marketPrice: 40 }), single({ id: 'j2', name: 'Pikachu 25' })]);
  assert.deepEqual(plain(app.ctx.buildRefreshQueue().items.map((i) => i.id)), ['j2']);
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.ppt().length, 0);
  assert.ok(app.toasts.includes('Custom card, price by hand (no auto-match)'));
  // a queue saved before the card was flagged still holds its entry: the run skips it, no request and no credits
  const q = plain(app.ctx.buildRefreshQueue());
  q.items = [{ id: 'j1', table: 'singles', lane: 'ppt', name: 'Charizard ex 006', language: 'JP', grader: null, grade: null, copyTargets: [] }];
  q.totalItems = 1;
  await drain(() => app.ctx._runRefreshQueueBody(q, 90, false, new Date().toISOString().slice(0, 10), 0), app.timers);
  assert.equal(app.ppt().length, 0, 'the flagged card was not asked about');
  assert.equal(app.row('j1').marketPrice, 40);
  assert.equal(q.dayCreditsUsed[new Date().toISOString().slice(0, 10)], 0, 'and no credit was spent on it');
  assert.equal(q.cursor, 1, 'it counts as done for this cycle');
  // and applyPriceToGroup still refuses it, the v3.84 rule
  app.ctx.applyPriceToGroup('j1', 'singles', [], 99, 'USD', 'PPT (Japanese)', 'medium', null);
  assert.equal(app.row('j1').marketPrice, 40);
});

test('ppt-japanese: Chinese, Indonesian and Korean singles stay manual with the lane on, nothing is asked of the Japanese catalogue for them', async () => {
  // their numbering does not reliably match the Japanese sets, and a wrong card's price is worse than none
  for (const language of ['CN', 'ID', 'KR', 'cn', ' id ']) {
    const app = await setup([single({ language, marketPrice: 40 })]);
    assert.equal(app.ctx._queueLaneFor(app.row('j1')), 'manual', language);
    assert.equal(app.ctx._kjrJapaneseLane(app.row('j1')), false, language);
    assert.deepEqual(plain(app.ctx.buildRefreshQueue().items), [], language + ': not queued');
    await app.ctx.refreshPrice('j1', 'singles');
    assert.ok(app.toasts.includes('Manual price, no free source for this language'), language + ' ' + JSON.stringify(app.toasts));
    assert.equal(app.row('j1').marketPrice, 40);
    // asked directly or through the router it refuses before any request, and passes no verdict on the card
    const direct = await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', language);
    assert.equal(direct.error, 'not a Japanese card', language);
    assert.equal(direct._ppt_requests, 0);
    assert.equal(direct.pptTransient, true);
    const routed = await app.ctx.fetchMarketPrice({ name: 'Charizard ex 006', language, japanese: true });
    assert.equal(routed.maxSgd, null);
    assert.equal(routed.pptError, 'not a Japanese card');
    assert.equal(routed.creditsUsed, 0);
    assert.equal(app.ppt().length, 0, language + ': no search of any catalogue');
  }
  // no language at all is not Japanese either, it is the English default
  assert.equal((await (await setup()).ctx.fetchJapanesePriceFromPPT('Charizard ex 006')).error, 'not a Japanese card');
  assert.equal((await (await setup()).ctx.fetchJapanesePriceFromPPT('Charizard ex 006', '')).error, 'not a Japanese card');
  // a queue entry a build that took them saved is passed over without a request, a credit or a verdict
  const app = await setup([single({ language: 'CN', marketPrice: 40 })]);
  const q = plain(app.ctx.buildRefreshQueue());
  q.items = [{ id: 'j1', table: 'singles', lane: 'ppt', name: 'Charizard ex 006', language: 'CN', grader: null, grade: null, copyTargets: [] }];
  q.totalItems = 1;
  const day = new Date().toISOString().slice(0, 10);
  await drain(() => app.ctx._runRefreshQueueBody(q, 90, false, day, 0), app.timers);
  assert.equal(app.ppt().length, 0, 'the Chinese card was not asked about');
  assert.equal(q.dayCreditsUsed[day], 0);
  assert.equal(q.cursor, 1, 'it counts as done for this cycle');
  assert.equal(app.row('j1').marketPrice, 40);
  assert.equal(app.row('j1')._tcgdexMissDate, undefined, 'and it is not stamped as unmatched');
});

test('ppt-japanese: a Japanese single priced by the lane is high enough in trust for the green dot', async () => {
  const app = await setup([single()]);
  await app.ctx.refreshPrice('j1', 'singles');
  assert.match(app.ctx._mktFreshDot(app.row('j1')), /#22c55e/, 'fresh and medium confidence');
  assert.equal(app.row('j1').priceHistory[0].confidence, 'medium');
  assert.equal(app.row('j1').priceHistory[0].source, 'PPT (Japanese)');
});

test('ppt-japanese: the lane\'s empty-cell wording and the could-not-be-matched reason say what to do', async () => {
  const app = await setup([single({ id: 'miss', _tcgdexMissDate: '2026-10-20' }), single({ id: 'fresh' }), single({ id: 'nonum', name: 'Charizard ex' }), single({ id: 'kr', language: 'KR' })]);
  assert.equal(app.ctx._mktEmptyCellTitle(app.row('miss')), 'No unique match on PokemonPriceTracker, check the name and number');
  assert.equal(app.ctx._mktEmptyCellTitle(app.row('fresh')), '', 'not asked yet: nothing to explain');
  assert.equal(app.ctx._mktEmptyCellTitle(app.row('nonum')), 'Add or fix the card number for exact pricing');
  assert.equal(app.ctx._mktEmptyCellTitle(app.row('kr')), 'Manual price, no free source for this language');
  assert.equal(app.ctx._kjrCustomReason(app.row('miss')), 'PokemonPriceTracker found no unique match');
  assert.equal(app.ctx._kjrCustomReason(app.row('nonum')), 'No card number in the name');
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles().map((r) => r.id)), ['miss']);
});

// ── the queue ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-japanese: the queue puts slabs first, then Japanese singles, prices a duplicate from one search, and bills the credits the vendor says', async () => {
  const seed = makeSeed({
    singles: [single({ id: 'j1', costPrice: 50 }), single({ id: 'j2', costPrice: 5 }), single({ id: 'j3', name: 'Pikachu 25', costPrice: 20 })],
    slabs: [{ id: 'sl1', name: 'Charizard 4', grader: 'PSA', grade: '10', costPrice: 500, status: 'Available', marketPrice: '', priceHistory: [] }],
  });
  const app = await loadApp({ seed, jaLane: true });
  app.ctx.toast = () => {};
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 2 }] });
  app.fetchMock.route('/ppt/cards', (url) => {
    const u = decodeURIComponent(url);
    if (u.includes('includeEbay')) return jsonResponse({ data: [{ id: 's', name: 'Charizard', cardNumber: '4/102', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 } } } } }], metadata: { apiCallsConsumed: { total: 5 } } });
    if (/Pikachu/.test(u)) return answer([jpCard({ id: 'pk', name: 'Pikachu', cardNumber: '25/165', prices: { market: 3 } })], 2);
    return answer([jpCard()], 3);
  });
  app.fetchMock.calls.length = 0;
  const q = plain(app.ctx.buildRefreshQueue());
  assert.deepEqual(q.items.map((i) => i.id), ['sl1', 'j1', 'j3'], 'the slab, then the Japanese singles by cost, the duplicate of j1 is its copy');
  assert.deepEqual(q.items[1].copyTargets.map((t) => t.id), ['j2']);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  const searches = app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards')).map((c) => decodeURIComponent(new URL(c.url).searchParams.get('search')));
  assert.deepEqual(searches, ['Charizard 4', 'Charizard ex 006', 'Pikachu 25'], 'three searches for four rows');
  const row = (id) => app.ctx.DB.singles.find((r) => r.id === id);
  assert.equal(row('j1').marketPrice, '25');
  assert.equal(row('j2').marketPrice, '25', 'the duplicate took the same price');
  assert.equal(row('j3').marketPrice, '6');
  const saved = JSON.parse(app.localStorage.getItem('pokeinv_refresh_queue'));
  assert.equal(saved.dayCreditsUsed[new Date().toISOString().slice(0, 10)], 5 + 3 + 2, 'the vendor\'s own totals: 5, 3 and 2 credits');
  assert.equal(saved.creditsVersion, 1);
  assert.equal(saved.completed, true);
});

test('ppt-japanese: a Japanese card the vendor has no single card for is stamped on its copies too, and a later price clears it', async () => {
  const app = await setup([single({ id: 'j1', costPrice: 50 }), single({ id: 'j2', costPrice: 5 })], () => []);
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 1, 'one search for the pair');
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles().map((r) => r.id).sort()), ['j1', 'j2']);
  // the owner fixes it and asks again from the inspector: the stamp goes when the card is priced
  app.fetchMock.route('/ppt/cards', () => answer([jpCard()]));
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.row('j1')._tcgdexMissDate, null);
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles().map((r) => r.id)), ['j2']);
});

test('ppt-japanese: a manual bulk refresh prices a Japanese single through the same strict match, not the older fuzzy name search', async () => {
  const ambiguous = [jpCard({ id: 'a', prices: { market: 5 } }), jpCard({ id: 'b', setName: 'Other Set', prices: { market: 99 } })];
  const app = await setup([single({ marketPrice: 40 })], () => ambiguous);
  app.ctx.kjrConfirm = async () => true;
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(app.row('j1').marketPrice, 40, 'two fitting cards: no price, where the fuzzy pick would have taken the best-scoring one');
  assert.equal(app.row('j1')._tcgdexMissDate, app.ctx.kjrLocalDay());
  assert.match(app.ppt()[0].url, /language=japanese/);
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')).length, 0);
});

// ── every lane writes a price history entry when it replaces a price ──────────────────────────────────────────────────────────────────

test('ppt-japanese: every lane writes a priceHistory entry when it replaces a price, a hand-typed one included', async () => {
  const rows = (extra) => Object.assign({ status: 'Available', type: 'raw', costPrice: 10, marketPrice: 40, priceHistory: [] }, extra); // 40 typed by hand, no history
  const seed = makeSeed({
    singles: [
      rows({ id: 'en', name: 'Pikachu 25', language: 'EN', tcgdexId: 'sv3-199' }),
      rows({ id: 'jp', name: 'Charizard ex 006', language: 'JP' }),
      rows({ id: 'jb', name: 'Charizard ex 006', language: 'JP', costPrice: 1 }), // a copy of jp in the queue
    ],
    slabs: [{ id: 'sl', name: 'Charizard 4', grader: 'PSA', grade: '10', costPrice: 500, status: 'Available', marketPrice: 40, priceHistory: [] }],
  });
  const app = await loadApp({ seed, jaLane: true });
  app.ctx.toast = () => {};
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 2 }] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 30 } } } } });
  app.fetchMock.route('/ppt/cards', (url) => decodeURIComponent(url).includes('includeEbay')
    ? jsonResponse({ data: [{ id: 's', name: 'Charizard', cardNumber: '4/102', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 } } } } }] })
    : answer([jpCard()]));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  const entries = (id, table) => plain((app.ctx.DB[table || 'singles'].find((r) => r.id === id)).priceHistory.map((h) => [h.price, h.source]));
  assert.deepEqual(entries('en'), [[60, 'TCGdex (TCGplayer)']], 'the free lane');
  assert.deepEqual(entries('jp'), [[25, 'PPT (Japanese)']], 'the Japanese lane');
  assert.deepEqual(entries('jb'), [[25, 'PPT (Japanese)']], 'and its copy');
  assert.deepEqual(entries('sl', 'slabs'), [[200, 'PPT (PSA 10)']], 'the slab lane');
  for (const id of ['en', 'jp', 'jb']) assert.equal(app.ctx._dirty.singles.has(id), true, id + ' syncs');
  assert.equal(app.ctx._dirty.slabs.has('sl'), true);

  // refreshPrice and the bulk path, on rows whose price now differs again
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 31 } } } } });
  await app.ctx.refreshPrice('en', 'singles');
  assert.deepEqual(entries('en').map((e) => e[0]), [60, 62], 'refreshPrice appends too');
  app.fetchMock.route('/ppt/cards', () => answer([jpCard({ prices: { market: 13 } })]));
  app.ctx.kjrConfirm = async () => true;
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.deepEqual(entries('jp').map((e) => e[0]), [25, 26], 'and so does the bulk path');
});

test('ppt-japanese: an unchanged price adds no history entry and no sync traffic, but is a check', async () => {
  const app = await setup([single({ marketPrice: '25', priceHistory: [{ date: '2026-10-01', price: 25, unit: 'USD', source: 'PPT (Japanese)', confidence: 'medium' }] })]);
  await app.ctx.refreshPrice('j1', 'singles');
  const row = app.row('j1');
  assert.equal(row.priceHistory.length, 1);
  assert.equal(app.ctx._dirty.singles.has('j1'), false);
  assert.equal(row._tcgdexPricedDate, app.ctx.kjrLocalDay(), 'stamped as checked');
});

// ── the lane OFF, which is how v3.85 ships ────────────────────────────────────────────────────────────────────────────────────────────
// The vendor's Japanese answer (the currency, the names, the cardNumber) has not been checked live, a yen price stored as dollars would
// corrupt real money data, so PPT_JA_LANE_ENABLED is false until a follow-up has looked. These tests load the app with no jaLane option.

test('ppt-japanese: with the lane off, as v3.85 ships, a Japanese single with a number is manual and makes no PPT call', async () => {
  const app = await setup([single({ marketPrice: 40 })], undefined, undefined, false);
  assert.equal(app.ctx.PPT_JA_LANE_ENABLED, false, 'the constant ships false');
  assert.equal(app.ctx.kjrPptJaLaneOn(), false);
  assert.equal(app.ctx._queueLaneFor(app.row('j1')), 'manual', 'the v3.84 rule for every non-English single');
  assert.equal(app.ctx._kjrJapaneseLane(app.row('j1')), false);
  assert.deepEqual(plain(app.ctx._kjrPptJaLangs()), []);
  assert.deepEqual(plain(app.ctx.buildRefreshQueue().items), [], 'not in the queue');
  assert.equal(app.ctx._pptLaneTopUp({ items: [], cursor: 0, totalItems: 0, totalRows: 1 }), false, 'and a top-up does not take it in');
  // Refresh price says why and asks nothing
  await app.ctx.refreshPrice('j1', 'singles');
  assert.ok(app.toasts.includes('Manual price, no free source for this language'), JSON.stringify(app.toasts));
  // a manual run and an automatic one
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 0, 'not one PPT request');
  assert.equal(app.fetchMock.calls.filter((c) => /language=japanese/.test(c.url)).length, 0, 'and nothing asks the Japanese catalogue');
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')).length, 0, 'TCGdex is not asked for a non-English single either');
  const row = app.row('j1');
  assert.equal(row.marketPrice, 40, 'the price typed in stays');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(app.ctx._dirty.singles.has('j1'), false);
  assert.equal(row._tcgdexMissDate, undefined, 'it was never asked, so it is not unmatched');
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles()), []);
  assert.equal(app.ctx._kjrManualLangCards().length, 1, 'it counts as a manual one, as in v3.84');
  // the words are v3.84's, the lane that would change them is not running
  assert.equal(app.ctx._kjrManualReason(row), 'Manual price, no free source for this language');
  assert.equal(app.ctx._mktEmptyCellTitle(single({ marketPrice: '' })), 'Manual price, no free source for this language');
  assert.equal(app.ctx._mktEmptyCellTitle(single({ marketPrice: '', name: 'Charizard ex' })), 'Manual price, no free source for this language', 'a Japanese card with no number too');
  assert.equal(app.ctx._kjrCustomReason(single({ _tcgdexMissDate: '2026-10-20' })), 'TCGdex found no unique match');
  assert.equal(app.ctx.kjrInspectRefreshInfo('singles', row).why, 'Manual price, no free source for this language');
  assert.equal(app.ctx.kjrInspectPriceLine('singles', single({ marketPrice: '' }), Date.now()), 'Manual price, no free source for this language');
});

test('ppt-japanese: with the lane off nothing can send language=japanese, whoever asks', async () => {
  const app = await setup([single()], undefined, undefined, false);
  assert.deepEqual(plain(await app.ctx._pptSearch('Charizard ex 006', { japanese: true })), { transport: 'Japanese lane is off' });
  const direct = await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP');
  assert.equal(direct.error, 'Japanese lane is off');
  assert.equal(direct.pptTransient, true, 'it is no verdict on the card');
  assert.equal(direct._ppt_requests, 0);
  const routed = await app.ctx.fetchMarketPrice({ name: 'Charizard ex 006', language: 'JP', japanese: true });
  assert.equal(routed.maxSgd, null);
  assert.equal(routed.pptError, 'Japanese lane is off');
  assert.equal(routed.pptTransient, true);
  assert.equal(routed.creditsUsed, 0);
  assert.equal(app.fetchMock.calls.length, 0, 'not a request of any kind');
  // a queue entry a build with the lane on saved is passed over: no request, no credit, no verdict, and it counts as done for the cycle
  const q = plain(app.ctx.buildRefreshQueue());
  q.items = [{ id: 'j1', table: 'singles', lane: 'ppt', name: 'Charizard ex 006', language: 'JP', grader: null, grade: null, copyTargets: [] }];
  q.totalItems = 1;
  const day = new Date().toISOString().slice(0, 10);
  await drain(() => app.ctx._runRefreshQueueBody(q, 90, false, day, 0), app.timers);
  assert.equal(app.ppt().length, 0);
  assert.equal(q.dayCreditsUsed[day], 0);
  assert.equal(q.cursor, 1);
  assert.equal(app.row('j1')._tcgdexMissDate, undefined, 'not stamped as unmatched');
  // the one search that is still made is the slab's, and it carries no language flag
  const slabApp = await loadApp({ jaLane: false, seed: { singles: [], slabs: [{ id: 'sl', name: 'Charizard 4', grader: 'PSA', grade: '10', costPrice: 500, status: 'Available', marketPrice: '', priceHistory: [] }] } });
  slabApp.ctx.toast = () => {};
  slabApp.fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 2 }] });
  slabApp.fetchMock.route('/ppt/cards', () => jsonResponse({ data: [{ id: 's', name: 'Charizard', cardNumber: '4/102', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 100 } } } } }] }));
  slabApp.fetchMock.calls.length = 0;
  await slabApp.ctx.refreshPrice('sl', 'slabs');
  const asked = slabApp.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  assert.equal(asked.length, 1, 'slabs are unaffected by the switch');
  assert.match(asked[0].url, /includeEbay=true/);
  assert.doesNotMatch(asked[0].url, /language=/);
});
