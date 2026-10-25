'use strict';
// v3.85, the Japanese lane: a Japanese single with a card number and a matched card is priced from PokemonPriceTracker's Japanese
// catalogue (language=japanese, limit=3), its price the card's TCGplayer market (prices.market). The match is strict: exactly one card
// whose number is the row's number, whose name and mechanic tags fit, nothing guessed. Anything else is a data miss that lands in the
// Singles "could not be matched" banner. A currency that is not USD is converted, never stored as dollars. Chinese, Indonesian and every
// other language stay manual, with the lane on as well. Fetch is stubbed (tests/harness.js), nothing here reaches a real API.
// v3.89 switched the lane ON (PPT_JA_LANE_ENABLED is true) after the 24/10/2026 live probe, which found that the vendor's search ignores the card
// number and that a card's setName is its set code, a colon, then the set name ("SV8a: Terastal Fest ex"). So a row whose TCGdex id gives a set
// code searches "<name> <set code>" and takes only a card filed under that code, and a Japanese single with no id is manual until the card art lookup
// writes one (no name-and-number search any more, a row of this file carries the id of the default jpCard's set, SV2a, unless a test says so). Most tests here pass
// loadApp({ jaLane: true }), which forces the reader on whatever the constant says. The section before the last one loads the app as shipped, with
// no option, and the last section forces the lane OFF (loadApp({ jaLane: false })), the kill switch that gives back the v3.84 rules.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeSeed, jsonResponse, plain } = require('./harness.js');

process.env.TZ = 'Asia/Singapore';

const jpCard = (o) => Object.assign({ id: 'jp-6', name: 'Charizard ex', setName: 'SV2a: Pokemon Card 151', cardNumber: '006/165', language: 'Japanese', prices: { market: 12.5 } }, o);
const answer = (cards, total) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total: total === undefined ? 3 : total } } });
// tcgdexId: the matched card the card art lookup writes (v3.89). A Japanese single with no id is manual and is never asked, so the rows of this file carry
// the id of the default jpCard's set (SV2a, "SV2a: Pokemon Card 151") unless a test says otherwise
const single = (o) => Object.assign({
  id: 'j1', name: 'Charizard ex 006', type: 'raw', language: 'JP', condition: 'Near Mint', qty: 1, costPrice: 10, marketPrice: '', listPrice: '',
  status: 'Available', notes: '', priceHistory: [], tcgdexId: 'SV2a-006',
}, o);

// the lane's own waits: the 6 second gap between PPT searches, the 250ms TCGdex gap. Not the app's startup timers.
async function drain(fn, timers) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 600 && !done; i++) {
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

test('ppt-japanese: a row with a matched card makes one search of the Japanese catalogue, "<name without its number> <set code>", limit 3, no eBay data', async () => {
  const app = await setup();
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.ppt().length, 1);
  const url = new URL(app.ppt()[0].url);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['language', 'limit', 'search']);
  assert.equal(url.searchParams.get('search'), 'Charizard ex SV2a', 'the id SV2a-006 gives the set code, the card number is not in the search');
  assert.equal(url.searchParams.get('language'), 'japanese');
  assert.equal(url.searchParams.get('limit'), '3');
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')).length, 0, 'TCGdex is never asked');
});

test('ppt-japanese: a name written "Umbreon VMAX 215/203" searches "Umbreon VMAX SV2a", the number is only what the answer is checked against', async () => {
  const app = await setup([single({ name: 'Umbreon VMAX 215/203' })], () => [jpCard({ name: 'Umbreon VMAX', cardNumber: '215/203' })]);
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(new URL(app.ppt()[0].url).searchParams.get('search'), 'Umbreon VMAX SV2a');
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
  const app = await setup([single({ marketPrice: 40 })], () => [jpCard({ id: 'a', setName: 'SV2a: Set A', prices: { market: 5 } }), jpCard({ id: 'b', setName: 'SV2a: Set B', prices: { market: 99 } })]);
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
  const ok = async (cardNumber) => (await setup([single()], () => [jpCard({ cardNumber })])).ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP', 'SV2a-006');
  for (const n of ['006/165', 'SV2a 006/165', '6', '006', ' 006 / 165 ']) assert.equal((await ok(n)).amount, 12.5, n);
  for (const n of ['016/165', 'TG6/TG30', '60', '', undefined, null]) assert.equal((await ok(n)).error, 'no match', String(n));
  const older = await (await setup([single()], () => [jpCard({ cardNumber: undefined, number: '6' })])).ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP', 'SV2a-006');
  assert.equal(older.amount, 12.5, 'the older number field is read too');
});

test('ppt-japanese: the name must fit, same species and the same mechanic tags', async () => {
  const fits = async (rowName, cardName) => {
    const num = (rowName.match(/\d+/) || ['1'])[0]; // the card carries the row's number, this is about the name
    const app = await setup([single({ name: rowName })], () => [jpCard({ name: cardName, cardNumber: num + '/165' })]);
    return !!(await app.ctx.fetchJapanesePriceFromPPT(rowName, 'JP', 'SV2a-006')).amount;
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
    assert.equal(!!(await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP', 'SV2a-006')).amount, ok, String(language));
  }
});

test('ppt-japanese: junk in the answer never throws and never prices', async () => {
  for (const cards of [[], [null], [42], ['x'], [{}], [{ name: 'Charizard ex' }]]) {
    const app = await setup([single()], () => cards);
    const r = await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP', 'SV2a-006');
    assert.equal(r.amount, undefined, JSON.stringify(cards));
  }
  const app = await setup();
  app.fetchMock.route('/ppt/cards', () => jsonResponse({ nothing: 'here' }));
  assert.equal((await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP', 'SV2a-006')).error, 'no match');
  app.fetchMock.route('/ppt/cards', () => jsonResponse(null));
  assert.equal((await app.ctx.fetchJapanesePriceFromPPT('Charizard ex 006', 'JP', 'SV2a-006')).error, 'no match');
});

// ── the currency guard ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('ppt-japanese: a card with no currency field, or USD, is dollars', async () => {
  for (const extra of [{}, { currency: 'USD' }, { currency: 'usd' }, { prices: { market: 12.5, currency: 'USD' } }, { currency: '' }, { currency: null }]) {
    const app = await setup([single()], () => [jpCard(extra)]);
    const r = await app.ctx.fetchMarketPrice({ name: 'Charizard ex 006', language: 'JP', tcgdexId: 'SV2a-006', japanese: true });
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
  const routed = await app.ctx.fetchMarketPrice({ name: 'Charizard ex 006', language: 'JP', tcgdexId: 'SV2a-006', japanese: true });
  assert.equal(routed.maxUsd, null, 'no USD figure is invented');
  assert.equal(routed.unit, 'JPY');
});

test('ppt-japanese: a currency on the prices block is read too, and EUR uses the EUR rate', async () => {
  const app = await setup([single()], () => [jpCard({ prices: { market: 10, currency: 'eur' } })]);
  app.fetchMock.route('base=EUR', { ok: true, json: [{ quote: 'SGD', rate: 1.5 }] });
  const r = await app.ctx.fetchMarketPrice({ name: 'Charizard ex 006', language: 'JP', tcgdexId: 'SV2a-006', japanese: true });
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
  assert.deepEqual(searches, ['Charizard 4', 'Charizard ex SV2a', 'Pikachu SV2a'], 'three searches for four rows, the slab by its name and the singles by their set code');
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
  const ambiguous = [jpCard({ id: 'a', prices: { market: 5 } }), jpCard({ id: 'b', setName: 'SV2a: Other Set', prices: { market: 99 } })];
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
      rows({ id: 'jp', name: 'Charizard ex 006', language: 'JP', tcgdexId: 'SV2a-006' }),
      rows({ id: 'jb', name: 'Charizard ex 006', language: 'JP', tcgdexId: 'SV2a-006', costPrice: 1 }), // a copy of jp in the queue
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

// ── which card of that name: the set code (v3.89) ─────────────────────────────────────────────────────────────────────────────────────
// The 24/10/2026 live probe of the vendor's Japanese catalogue found that its search ignores the card number ("Vaporeon 30" returned other 030
// cards, "Vaporeon SV8a" the right one) and that a card's setName is its set code, a colon and a space, then the English set name. A row whose
// TCGdex id gives a set code ("SV8a-030" gives SV8a) searches "<name> <set code>" and takes only a card filed under that code, the text before
// the setName's first colon compared whole and without regard to case. A row with no id has no set to search by or to check, so it is manual (below). The two
// answers below are the probe's, verbatim: no id, no language label, no currency field. The Vaporeon cards are built for the tests, only the
// Umbreon and the Pikachu are real.
const LIVE_UMBREON = { name: 'Umbreon ex - 093/187', setName: 'SV8a: Terastal Fest ex', cardNumber: '093/187', prices: { market: 2.87 } };
const LIVE_PIKACHU = { name: 'Pikachu - 030/103', setName: 'M6a: MEGA Expansion 30th Celebration', cardNumber: '030/103', prices: { market: 1.2 } };
const vaporeon = (o) => Object.assign({ id: 'vap', name: 'Vaporeon - 030/187', setName: 'SV8a: Terastal Fest ex', cardNumber: '030/187', prices: { market: 3.1 } }, o);
const umbreonRow = (o) => single(Object.assign({ id: 'u1', name: 'Umbreon ex 93', tcgdexId: 'SV8a-093', costPrice: 10, marketPrice: 40 }, o));
const vaporeonRow = (o) => single(Object.assign({ id: 'v1', name: 'Vaporeon 30', tcgdexId: 'SV8a-030', costPrice: 10, marketPrice: 40 }, o));
const UTC = () => new Date().toISOString().slice(0, 10);
const searchOf = (app, n) => decodeURIComponent(new URL(app.ppt()[n || 0].url).searchParams.get('search'));
const savedQueue = (app) => JSON.parse(app.localStorage.getItem('pokeinv_refresh_queue'));
// the lane's answer for the "Vaporeon 30" row with this TCGdex id, over a vendor answer of these cards
async function ask(cards, tcgdexId) {
  const app = await setup([vaporeonRow({ tcgdexId })], () => cards);
  return { app, r: await app.ctx.fetchJapanesePriceFromPPT('Vaporeon 30', 'JP', tcgdexId) };
}

test('ppt-japanese: a row with a TCGdex id searches the name and its set code, not the number, and the live Umbreon sample is priced', async () => {
  const app = await setup([umbreonRow()], () => [LIVE_UMBREON]);
  await app.ctx.refreshPrice('u1', 'singles');
  assert.equal(app.ppt().length, 1);
  const url = new URL(app.ppt()[0].url);
  assert.deepEqual([...url.searchParams.keys()].sort(), ['language', 'limit', 'search']);
  assert.equal(url.searchParams.get('search'), 'Umbreon ex SV8a', 'the id up to its last dash, and no card number in it');
  assert.equal(url.searchParams.get('language'), 'japanese');
  assert.equal(url.searchParams.get('limit'), '3');
  const row = app.row('u1');
  assert.equal(row.marketPrice, '6', '2.87 USD at 2 is S$5.74');
  assert.equal(row.priceHistory.length, 1);
  assert.equal(row.priceHistory[0].source, 'PPT (Japanese)');
  assert.ok(Math.abs(row.priceHistory[0].price - 5.74) < 1e-9);
  assert.equal(row.tcgdexId, 'SV8a-093', 'the id is read for its set and never rewritten');
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')).length, 0, 'TCGdex is not asked');
});

test('ppt-japanese: the set code is everything before the id\'s last dash, and an id with no dash to cut at has none', async () => {
  const app = await setup([single({ name: 'Pikachu 1', tcgdexId: 'SV-P-001' })], () => [vaporeon({ name: 'Pikachu - 001/SV-P', cardNumber: '001/SV-P', setName: 'SV-P: Scarlet & Violet Promo Cards' })]);
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(searchOf(app), 'Pikachu SV-P', 'a dash inside the code stays in it');
  assert.equal(app.row('j1').marketPrice, '6', 'and the card is filed under that whole code');
  for (const [id, code] of [['SV8a-030', 'SV8a'], ['S10b-TG11', 'S10b'], ['  SV8a-030 ', 'SV8a'], ['sv8a-030', 'sv8a']]) assert.equal(app.ctx._kjrPptSetCode(id), code, id);
  for (const id of ['', '   ', 'SV8a030', '-030', ' -030', null, undefined, 42, {}, ['SV8a-030']]) assert.equal(app.ctx._kjrPptSetCode(id), '', JSON.stringify(id));
});

// ── no matched card, no price (v3.89) ─────────────────────────────────────────────────────────────────────────────────────────────────
// The vendor's Japanese search ignores the card number, so a name and a number alone can not tell which of several sets' cards a row is. A Japanese
// single with no TCGdex id, or an id that gives no set code, is manual like a Chinese one until the card art lookup writes its id: it is not queued,
// not asked by the bulk refresh, not priced by Refresh price, and the name-plus-number search it used to fall back on is gone.
const NO_SET_CODE = [undefined, null, '', '   ', 'SV8a093', '-093', 'SV8a', 42, {}];

test('ppt-japanese: with no set code fetchJapanesePriceFromPPT refuses: no request, not billed, no verdict, and there is no name-and-number fallback', async () => {
  for (const tcgdexId of NO_SET_CODE) {
    const { app, r } = await ask([vaporeon(), LIVE_PIKACHU], tcgdexId);
    const label = JSON.stringify(tcgdexId);
    assert.equal(r.error, 'no set code', label);
    assert.equal(r.amount, undefined, label);
    assert.equal(r._ppt_requests, 0, label);
    assert.equal(r._ppt_credits, undefined, label + ': nothing was billed');
    assert.equal(r.pptTransient, undefined, label + ': a refusal of the card, not a failure to ask');
    assert.equal(r.creditsExhausted, undefined, label);
    assert.equal(app.fetchMock.calls.length, 0, label + ': not one request of any kind');
    // through the router the same, and still nothing is asked
    const routed = await app.ctx.fetchMarketPrice({ name: 'Vaporeon 30', language: 'JP', tcgdexId, japanese: true });
    assert.equal(routed.maxSgd, null, label);
    assert.equal(routed.pptError, 'no set code', label);
    assert.equal(routed.creditsUsed, 0, label);
    assert.equal(routed.pptTransient, undefined, label);
    assert.equal(app.fetchMock.calls.length, 0, label);
  }
  // the order of the refusals is unchanged: a card with no number is still told so first
  const app = await setup();
  assert.equal((await app.ctx.fetchJapanesePriceFromPPT('Charizard ex', 'JP', '')).error, 'no card number');
  // and the card picker itself fails closed, a direct call with no set code takes nothing even when the name and the number fit
  assert.deepEqual(plain(app.ctx._kjrPickJapanese([vaporeon()], 'Vaporeon 30', '')), {});
  assert.deepEqual(plain(app.ctx._kjrPickJapanese([vaporeon()], 'Vaporeon 30')), {});
  assert.deepEqual(plain(app.ctx._kjrPickJapanese([vaporeon()], 'Vaporeon 30', 'SV8a')), { card: vaporeon() });
});

test('ppt-japanese: a Japanese single with no matched card is manual everywhere, with zero PPT calls: the queue, the bulk refresh and Refresh price', async () => {
  for (const tcgdexId of NO_SET_CODE) {
    const label = JSON.stringify(tcgdexId);
    const app = await setup([umbreonRow({ tcgdexId, marketPrice: 40 })], () => [LIVE_UMBREON]);
    const row = app.row('u1');
    assert.equal(app.ctx._queueLaneFor(row), 'manual', label);
    assert.equal(app.ctx._kjrJapaneseLane(row), false, label);
    assert.deepEqual(plain(app.ctx.buildRefreshQueue().items), [], label + ': not queued');
    // Refresh price says what is missing, and asks nothing
    await app.ctx.refreshPrice('u1', 'singles');
    assert.deepEqual(app.toasts, ['Needs a matched card first, the card art lookup finds it or add its TCGdex ID'], label);
    // a manual pass and an automatic one
    await drain(() => app.ctx.runRefreshQueue(true), app.timers);
    await drain(() => app.ctx.runRefreshQueue(false), app.timers);
    // the bulk refresh counts it as manual: nothing to price, so it does not even ask
    app.toasts.length = 0;
    let asked = 0;
    app.ctx.kjrConfirm = async () => { asked++; return true; };
    await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
    assert.deepEqual(app.toasts, ['Nothing to price automatically: 1 card has no automatic source, price it by hand'], label);
    assert.equal(asked, 0, label + ': no question for a run with nothing to do');
    assert.equal(app.fetchMock.calls.length, 0, label + ': not one request of any kind');
    assert.equal(row.marketPrice, 40, label + ': the price on the card stays');
    assert.equal(row.priceHistory.length, 0, label);
    assert.equal(row._tcgdexMissDate, undefined, label + ': never asked, so not unmatched');
    assert.equal(app.ctx._dirty.singles.has('u1'), false, label);
    const saved = JSON.parse(app.localStorage.getItem('pokeinv_refresh_queue'));
    assert.equal((saved.dayCreditsUsed || {})[UTC()] || 0, 0, label + ': no credit was spent');
  }
  // an entry a queue saved before the id was cleared is passed over without a request, a credit or a verdict
  const app = await setup([umbreonRow({ tcgdexId: '' })], () => [LIVE_UMBREON]);
  const q = plain(app.ctx.buildRefreshQueue());
  q.items = [{ id: 'u1', table: 'singles', lane: 'ppt', name: 'Umbreon ex 93', language: 'JP', grader: null, grade: null, tcgdexId: 'SV8a-093', copyTargets: [] }];
  q.totalItems = 1;
  await drain(() => app.ctx._runRefreshQueueBody(q, 90, false, UTC(), 0), app.timers);
  assert.equal(app.ppt().length, 0);
  assert.equal(q.dayCreditsUsed[UTC()], 0);
  assert.equal(q.cursor, 1, 'it counts as done for this cycle');
  assert.equal(app.row('u1')._tcgdexMissDate, undefined);
});

test('ppt-japanese: the id the card art lookup writes moves the card into the PPT lane on the next run with no extra step, by the top-up the same day or the roll of a new day', async () => {
  // (1) the same day: a pass runs with the card unmatched, then the lookup writes its id, and the next run adds it to the queue it already has
  const app = await setup([umbreonRow({ tcgdexId: '', marketPrice: 40 }), umbreonRow({ id: 'u2', name: 'Pikachu 25', tcgdexId: 'SV8a-025', marketPrice: '' })], (url) => (/Umbreon/.test(url) ? [LIVE_UMBREON] : []));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.deepEqual(app.ppt().map((c) => new URL(c.url).searchParams.get('search')), ['Pikachu SV8a'], 'only the matched card was asked');
  assert.deepEqual(plain(JSON.parse(app.localStorage.getItem('pokeinv_refresh_queue')).items.map((i) => i.id)), ['u2'], 'the queue holds the matched one only');
  assert.equal(app.row('u1').marketPrice, 40);
  app.fetchMock.calls.length = 0;
  // the lookup's whole effect on pricing: it writes the id and marks the row, nothing else is told
  app.row('u1').tcgdexId = 'SV8a-093';
  app.ctx.markDirty('singles', 'u1');
  assert.equal(app.ctx._queueLaneFor(app.row('u1')), 'ppt', 'on the lane the moment it has the id');
  assert.deepEqual(plain(app.ctx.buildRefreshQueue().items.map((i) => i.id).sort()), ['u1', 'u2'], 'a rebuild holds it');
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.deepEqual(app.ppt().map((c) => new URL(c.url).searchParams.get('search')), ['Umbreon ex SV8a'], 'the next run asked for it, and only for it');
  assert.equal(app.row('u1').marketPrice, '6', 'priced by the Japanese lane');
  assert.equal(app.row('u1').priceHistory[0].source, 'PPT (Japanese)');
  assert.deepEqual(plain(JSON.parse(app.localStorage.getItem('pokeinv_refresh_queue')).items.map((i) => i.id)), ['u2', 'u1'], 'added at the end of the queue it had, no rebuild');
  // (2) a new vendor day: the roll rebuilds the PPT entries from the live inventory and the matched card is in them
  const next = await setup([umbreonRow({ tcgdexId: '', marketPrice: 40 })], () => [LIVE_UMBREON]);
  await drain(() => next.ctx.runRefreshQueue(false), next.timers);
  assert.equal(next.ppt().length, 0, 'nothing to ask while it is unmatched');
  next.row('u1').tcgdexId = 'SV8a-093';
  const q = JSON.parse(next.localStorage.getItem('pokeinv_refresh_queue'));
  q.pptDay = '2000-01-01'; // the queue last rolled on an earlier vendor day
  q.dayCreditsUsed = {};
  next.localStorage.setItem('pokeinv_refresh_queue', JSON.stringify(q));
  await drain(() => next.ctx.runRefreshQueue(false), next.timers);
  assert.deepEqual(next.ppt().map((c) => new URL(c.url).searchParams.get('search')), ['Umbreon ex SV8a']);
  assert.equal(next.row('u1').marketPrice, '6');
  assert.equal(JSON.parse(next.localStorage.getItem('pokeinv_refresh_queue')).pptDay, UTC(), 'rolled today');
});

test('ppt-japanese: a Japanese single with no matched card is counted as a manual price, never as unmatched, and the words say it needs the match first', async () => {
  const unmatched = umbreonRow({ id: 'a1', tcgdexId: '', marketPrice: '' });
  const matched = umbreonRow({ id: 'a2', name: 'Pikachu 25', tcgdexId: 'SV8a-025', marketPrice: '' });
  const nonumber = umbreonRow({ id: 'a3', name: 'Umbreon ex', tcgdexId: '', marketPrice: '' });
  const chinese = umbreonRow({ id: 'a4', language: 'CN', tcgdexId: '', marketPrice: '' });
  const missed = umbreonRow({ id: 'a5', name: 'Pikachu 26', tcgdexId: 'SV8a-026', marketPrice: '', _tcgdexMissDate: '2026-10-20' });
  const app = await setup([unmatched, matched, nonumber, chinese, missed], () => []);
  const ids = (list) => plain(list.map((r) => r.id)).sort();
  assert.deepEqual(ids(app.ctx._kjrManualLangCards()), ['a1', 'a3', 'a4'], 'the card with no match is counted with the Chinese one and the one with no number');
  assert.deepEqual(ids(app.ctx._kjrUnresolvedSingles()), ['a5'], 'only a card the lane asked about and found no unique match for is unmatched');
  const row = (id) => app.row(id);
  const NEEDS = 'Needs a matched card first, the card art lookup finds it or add its TCGdex ID';
  assert.equal(app.ctx._kjrManualReason(row('a1')), NEEDS);
  assert.equal(app.ctx._kjrManualReason(row('a3')), 'Add or fix the card number for exact pricing', 'no number: the number first');
  assert.equal(app.ctx._kjrManualReason(row('a4')), 'Manual price, no free source for this language');
  assert.equal(app.ctx._mktEmptyCellTitle(row('a1')), NEEDS);
  assert.equal(app.ctx._mktEmptyCellTitle(row('a3')), 'Add or fix the card number for exact pricing');
  assert.equal(app.ctx._mktEmptyCellTitle(row('a2')), '', 'a matched card not asked yet has nothing to explain');
  assert.equal(app.ctx._mktEmptyCellTitle(row('a5')), 'No unique match on PokemonPriceTracker, check the name and number');
  assert.equal(app.ctx.kjrInspectPriceLine('singles', row('a1'), Date.now()), NEEDS);
  assert.equal(app.ctx.kjrInspectPriceLine('singles', row('a3'), Date.now()), 'Add or fix the card number for exact pricing');
  assert.deepEqual(plain(app.ctx.kjrInspectRefreshInfo('singles', row('a1'))), { ok: false, why: NEEDS });
  assert.deepEqual(plain(app.ctx.kjrInspectRefreshInfo('singles', row('a2'))), { ok: true, why: '' });
  // the Settings panel and its tile: the manual note says what a Japanese card needs, and no copy promises a price for a card with only a number
  app.ctx.saveQueue(app.ctx.buildRefreshQueue());
  const doc = app.document;
  const panel = doc.getElementById('queue-status-panel') || doc.createElement('div');
  if (!panel.parentNode) { panel.id = 'queue-status-panel'; doc.body.appendChild(panel); }
  app.ctx._renderQueueStatus();
  const html = doc.getElementById('queue-status-panel').innerHTML;
  assert.match(html, /3 non-English cards priced manually\. Only a Japanese card with a card number and a matched card has an automatic source, the card art lookup finds the match, or add the TCGdex ID to the card\./);
  assert.match(html, /title="Slabs \(eBay sold data\), plus Japanese singles with a card number and a matched card \(TCGplayer market\), priced via PokemonPriceTracker\./);
  assert.doesNotMatch(html, /add the number to a Japanese card to price it automatically/);
});

test('ppt-japanese: the live wrong-card answer for a "Vaporeon 30" search is never a price for a Vaporeon SV8a-030 row', async () => {
  // the probe's Pikachu 030/103 on its own: another name, another set, only the number is the same
  const alone = await ask([LIVE_PIKACHU], 'SV8a-030');
  assert.equal(searchOf(alone.app), 'Vaporeon SV8a');
  assert.equal(alone.r.amount, undefined);
  assert.equal(alone.r.error, 'no match');
  assert.equal(alone.r._ppt_requests, 1);
  assert.equal(alone.r._ppt_credits, 3, 'the vendor billed the answer');
  // beside the right card it is simply not a candidate
  const beside = await ask([LIVE_PIKACHU, vaporeon()], 'SV8a-030');
  assert.equal(beside.r.amount, 3.1);
  assert.equal(beside.r.cardName, 'Vaporeon - 030/187');
  // as the inspector click: nothing written, nothing synced, the card is listed as not matched
  const app = await setup([vaporeonRow()], () => [LIVE_PIKACHU]);
  await app.ctx.refreshPrice('v1', 'singles');
  const row = app.row('v1');
  assert.equal(row.marketPrice, 40, 'the price on the card stays');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(app.ctx._dirty.singles.has('v1'), false);
  assert.equal(row._tcgdexMissDate, app.ctx.kjrLocalDay());
  assert.ok(app.toasts.some((t) => /^ERR No price found .* PPT: no match$/.test(t)), JSON.stringify(app.toasts));
});

test('ppt-japanese: a Vaporeon numbered 030 that the vendor files under another set is a miss of its own, "set code mismatch", never a price', async () => {
  const wrongSet = vaporeon({ id: 'other', setName: 'M6a: MEGA Expansion 30th Celebration' });
  const { app, r } = await ask([LIVE_PIKACHU, wrongSet], 'SV8a-030');
  assert.equal(r.amount, undefined);
  assert.equal(r.error, 'set code mismatch');
  assert.equal(r.pptTransient, undefined, 'a verdict on the card, not a failure to ask');
  assert.equal(r.creditsExhausted, undefined);
  assert.equal(r._ppt_requests, 1);
  assert.equal(r._ppt_credits, 3, 'and the vendor billed the answer');
  // through the router the reason and the bill survive
  const routed = await app.ctx.fetchMarketPrice({ name: 'Vaporeon 30', language: 'JP', tcgdexId: 'SV8a-030', japanese: true });
  assert.equal(routed.maxSgd, null);
  assert.equal(routed.pptError, 'set code mismatch');
  assert.equal(routed.pptTransient, undefined);
  assert.equal(routed.creditsUsed, 3);
  // and as the inspector click: the reason is named, the card is listed as not matched, the price on it stays
  await app.ctx.refreshPrice('v1', 'singles');
  const row = app.row('v1');
  assert.equal(row.marketPrice, 40);
  assert.equal(row.priceHistory.length, 0);
  assert.equal(row._tcgdexMissDate, app.ctx.kjrLocalDay());
  assert.ok(app.toasts.some((t) => /^ERR No price found .* PPT: set code mismatch$/.test(t)), JSON.stringify(app.toasts));
});

test('ppt-japanese: the set code is compared whole, SV8 never takes a card filed under SV8a and SV8a never one filed under SV8', async () => {
  const sv8a = vaporeon({ id: 'a', setName: 'SV8a: Terastal Fest ex', prices: { market: 3.1 } });
  const sv8 = vaporeon({ id: 'b', setName: 'SV8: Super Electric Breaker', prices: { market: 4.2 } });
  assert.equal((await ask([sv8a], 'SV8-030')).r.error, 'set code mismatch', 'row SV8, card SV8a');
  assert.equal((await ask([sv8], 'SV8a-030')).r.error, 'set code mismatch', 'row SV8a, card SV8');
  assert.equal((await ask([sv8a], 'SV8a-030')).r.amount, 3.1, 'row SV8a, card SV8a');
  assert.equal((await ask([sv8], 'SV8-030')).r.amount, 4.2, 'row SV8, card SV8');
  // both in one answer: each row takes the card of its own set and nothing else
  assert.equal((await ask([sv8a, sv8], 'SV8-030')).r.amount, 4.2);
  assert.equal((await ask([sv8a, sv8], 'SV8a-030')).r.amount, 3.1);
  // and each row searched its own code
  assert.equal(searchOf((await ask([sv8a], 'SV8-030')).app), 'Vaporeon SV8');
  assert.equal(searchOf((await ask([sv8a], 'SV8a-030')).app), 'Vaporeon SV8a');
});

test('ppt-japanese: right set plus right number is taken, the code read before the first colon, trimmed, in any case', async () => {
  for (const setName of ['SV8a: Terastal Fest ex', 'sv8a: terastal fest ex', 'SV8A: Terastal Fest ex', '  SV8a  : Terastal Fest ex', 'SV8a:Terastal Fest ex', 'SV8a:', 'SV8a: Terastal Fest ex: Master Ball']) {
    assert.equal((await ask([vaporeon({ setName })], 'SV8a-030')).r.amount, 3.1, JSON.stringify(setName));
  }
  for (const id of ['sv8a-030', 'SV8A-030', ' SV8a-030 ']) assert.equal((await ask([vaporeon()], id)).r.amount, 3.1, 'the row\'s side reads the same: ' + JSON.stringify(id));
  // the number is still the row\'s: 030 is 30, and a right set with another number is no card at all (a plain no match, not a set miss)
  assert.equal((await ask([vaporeon({ cardNumber: '030/187' })], 'SV8a-030')).r.amount, 3.1);
  assert.equal((await ask([vaporeon({ cardNumber: '31/187' })], 'SV8a-030')).r.error, 'no match');
});

test('ppt-japanese: a setName that is not the row\'s code before a colon is a "set code mismatch": no colon, another code, nothing, not text', async () => {
  for (const setName of ['SV8a Terastal Fest ex', 'Terastal Fest ex', 'SV8a', 'SV8: Super Electric Breaker', 'SV8 a: x', 'Terastal Fest ex: SV8a', ': SV8a', '', '   ', undefined, null, 42, {}, ['SV8a: x']]) {
    const { r } = await ask([vaporeon({ setName })], 'SV8a-030');
    assert.equal(r.amount, undefined, JSON.stringify(setName));
    assert.equal(r.error, 'set code mismatch', JSON.stringify(setName));
  }
});

test('ppt-japanese: only the cards filed under the row\'s set count, one is taken and two are ambiguous, a card of another set is neither', async () => {
  const a = vaporeon({ id: 'a' });
  const b = vaporeon({ id: 'b', prices: { market: 9 } });
  const other = vaporeon({ id: 'c', setName: 'M6a: MEGA Expansion 30th Celebration', prices: { market: 99 } });
  const one = (await ask([other, a], 'SV8a-030')).r;
  assert.equal(one.amount, 3.1, 'a card of another set beside the right one is no ambiguity');
  const two = (await ask([a, b, other], 'SV8a-030')).r;
  assert.equal(two.amount, undefined);
  assert.equal(two.error, 'no unique match (2 cards fit)', 'the other set\'s card is not counted');
  // with no set code (no matched card) there is nothing to check a card against, so nothing is asked and nothing is taken
  assert.equal((await ask([a, b, other], '')).r.error, 'no set code');
  // the same card listed twice still counts once, with the set check in place
  assert.equal((await ask([a, a], 'SV8a-030')).r.amount, 3.1);
});

test('ppt-japanese: in the queue "set code mismatch" is a data miss of its own: tallied by name, billed, listed as unmatched, and a price beside it is still written', async () => {
  const app = await setup([vaporeonRow({ costPrice: 50 }), umbreonRow({ costPrice: 5 })],
    (url) => (/Vaporeon/.test(url) ? [vaporeon({ setName: 'M6a: MEGA Expansion 30th Celebration' })] : [LIVE_UMBREON]));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  const q = savedQueue(app);
  assert.deepEqual(plain(q.lastErrorTally), { 'set code mismatch': 1 }, 'its own reason, so a first live run can tell it from "no match"');
  assert.equal(q.dayCreditsUsed[UTC()], 6, 'both answers were billed, 3 credits each');
  assert.equal(q.cursor, 2, 'a data miss is done for this cycle');
  assert.equal(q.completed, true);
  assert.equal(app.row('v1').marketPrice, 40, 'the price on the card is untouched');
  assert.equal(app.row('v1').priceHistory.length, 0);
  assert.equal(app.row('v1')._tcgdexMissDate, app.ctx.kjrLocalDay());
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles().map((r) => r.id)), ['v1'], 'it lands in the could-not-be-matched banner');
  assert.equal(app.row('u1').marketPrice, '6', 'the card beside it is priced');
  assert.ok(app.toasts.some((t) => /1 fetched.*1 failed \(1× set code mismatch\)/.test(t)), JSON.stringify(app.toasts));
  // an answer with no card at all is the other reason, and the two do not blur
  const empty = await setup([vaporeonRow()], () => []);
  await drain(() => empty.ctx.runRefreshQueue(false), empty.timers);
  assert.deepEqual(plain(savedQueue(empty).lastErrorTally), { 'no match': 1 });
});

test('ppt-japanese: the queue reads the set code off the row, which can be newer than the queue\'s own entry, and the bulk refresh reads the row too', async () => {
  const app = await setup([vaporeonRow({ tcgdexId: 'SV8-030' })], () => [vaporeon()]);
  const q = plain(app.ctx.buildRefreshQueue());
  assert.equal(q.items[0].tcgdexId, 'SV8-030', 'the entry was built with this id');
  app.row('v1').tcgdexId = 'SV8a-030'; // the owner corrected it since
  await drain(() => app.ctx._runRefreshQueueBody(q, 90, false, UTC(), 0), app.timers);
  assert.equal(app.ppt().length, 1);
  assert.equal(searchOf(app), 'Vaporeon SV8a', 'the row\'s id, not the entry\'s');
  assert.equal(app.row('v1').marketPrice, '6');
  // the other way round: the owner cleared the id after the queue was built, so there is no matched card and nothing is asked
  const cleared = await setup([vaporeonRow()], () => [vaporeon({ setName: 'M6a: MEGA Expansion 30th Celebration' })]);
  const q2 = plain(cleared.ctx.buildRefreshQueue());
  assert.equal(q2.items[0].tcgdexId, 'SV8a-030');
  cleared.row('v1').tcgdexId = '';
  await drain(() => cleared.ctx._runRefreshQueueBody(q2, 90, false, UTC(), 0), cleared.timers);
  assert.equal(cleared.ppt().length, 0, 'the entry is passed over, no request');
  assert.equal(q2.dayCreditsUsed[UTC()], 0);
  // the manual bulk refresh asks with the row's id as well
  const bulk = await setup([vaporeonRow()], () => [vaporeon()]);
  bulk.ctx.kjrConfirm = async () => true;
  await drain(() => bulk.ctx.bulkRefreshPrices('singles'), bulk.timers);
  assert.equal(searchOf(bulk), 'Vaporeon SV8a');
  assert.equal(bulk.row('v1').marketPrice, '6');
});

// ── the price guard on the Japanese lane ──────────────────────────────────────────────────────────────────────────────────────────────
// Every automatic price passes kjrPriceGuard (v3.86): S$20 and up, over 20 times the cost or over 5 times the price the app counts, is held on
// the row as priceHold and marketPrice and priceHistory stay as they were. The Japanese lane converts the vendor's amount to S$ inside
// fetchMarketPrice (maxSgd), before any write site sees it, so the guard compares S$ with S$.

test('ppt-japanese: a price the guard doubts is held on the Japanese lane, run through the queue: marketPrice and history untouched, the hold on the row', async () => {
  // cost S$1, the vendor says US$12.50, S$2 to the dollar: S$25, 25 times the cost. US$12.50 is under the guard's S$20 floor, so only a
  // guard that reads the converted figure holds it
  const app = await setup([vaporeonRow({ costPrice: 1, marketPrice: '' }), umbreonRow({ costPrice: 10, marketPrice: '' })],
    (url) => (/Vaporeon/.test(url) ? [vaporeon({ prices: { market: 12.5 } })] : [LIVE_UMBREON]), 2);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  const held = app.row('v1');
  assert.equal(held.marketPrice, '', 'the price on the card is untouched');
  assert.equal(held.priceHistory.length, 0, 'and so is its history');
  assert.deepEqual(plain(held.priceHold), { price: 25, unit: 'USD', source: 'PPT (Japanese)', confidence: 'medium', date: UTC(), prev: null, reason: '25× cost' });
  assert.equal(held._tcgdexPricedDate, app.ctx.kjrLocalDay(), 'stamped as looked up today, so the queue does not ask again');
  assert.ok(!held._tcgdexMissDate, 'a held price is an answer, not a miss (the lane clears the stamp, it does not leave one)');
  assert.equal(app.ctx._dirty.singles.has('v1'), true, 'a hold is a synced field');
  assert.deepEqual(plain(app.ctx.kjrPriceHolds().map((h) => h.item.id)), ['v1'], 'it waits for the owner on the Overview');
  assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles()), []);
  // the same pass wrote the card the guard had no doubt about
  assert.equal(app.row('u1').marketPrice, '6');
  assert.equal('priceHold' in app.row('u1'), false);
  assert.equal(savedQueue(app).dayCreditsUsed[UTC()], 6, 'the held answer was billed like any other');
});

test('ppt-japanese: the inspector\'s Refresh holds a price over 5 times the last one, and the S$ figure is what the guard compares, not the vendor\'s amount', async () => {
  const app = await setup([vaporeonRow({ costPrice: 10, marketPrice: '4' })], () => [vaporeon({ prices: { market: 12.5 } })], 2);
  await app.ctx.refreshPrice('v1', 'singles');
  const row = app.row('v1');
  assert.equal(row.marketPrice, '4');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(row.priceHold.price, 25, 'in S$, the unit beside it says what the vendor priced in');
  assert.equal(row.priceHold.unit, 'USD');
  assert.equal(row.priceHold.prev, 4);
  assert.equal(row.priceHold.reason, '6.3× last price');
  assert.ok(app.toasts.includes('⚠ Held for your OK: S$25 is 6.3× last price. The price on the card is unchanged.'), JSON.stringify(app.toasts));
  // the conversion comes first: the same US$12.50 at S$1 to the dollar is S$12.50, under the floor, so the guard has no doubt and it is written
  // (the page refuses a USD rate outside 0.5 to 5, so 1 is the cheapest rate a test can use)
  const cheap = await setup([vaporeonRow({ costPrice: 1, marketPrice: '' })], () => [vaporeon({ prices: { market: 12.5 } })], 1);
  await cheap.ctx.refreshPrice('v1', 'singles');
  assert.equal(cheap.row('v1').marketPrice, '13');
  assert.equal('priceHold' in cheap.row('v1'), false);
  // and a yen price is converted before it is compared: 12,500 yen is S$108.75, under 20 times a S$10 cost, where 12,500 itself is 1,250 times
  const yen = await setup([vaporeonRow({ costPrice: 10, marketPrice: '' })], () => [vaporeon({ currency: 'JPY', prices: { market: 12500 } })], 2);
  yen.fetchMock.route('base=JPY', { ok: true, json: [{ quote: 'SGD', rate: 0.0087 }] });
  await yen.ctx.refreshPrice('v1', 'singles');
  assert.equal(yen.row('v1').marketPrice, '109');
  assert.equal('priceHold' in yen.row('v1'), false);
});

test('ppt-japanese: a manual bulk refresh holds a Japanese price too, counted apart from the updates', async () => {
  const app = await setup([vaporeonRow({ costPrice: 1, marketPrice: '5' })], () => [vaporeon({ prices: { market: 12.5 } })], 2);
  app.ctx.kjrConfirm = async () => true;
  await drain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  const row = app.row('v1');
  assert.equal(row.marketPrice, '5');
  assert.equal(row.priceHistory.length, 0);
  assert.equal(row.priceHold.price, 25);
  assert.ok(app.toasts.some((t) => /^Done: 0 updated, 1 held for your OK/.test(t)), JSON.stringify(app.toasts));
});

// ── the credit budget and the pauses, the Japanese lane exactly like the slabs ────────────────────────────────────────────────────────
// One loop (_runRefreshQueueBody) runs both: it bills the vendor's own total for each answer into dayCreditsUsed, stops before a search the day's
// credits left cannot pay for (kjrDailyCredits, Free 90), reads "Daily credit limit exceeded" as a pause until the vendor's reset, and a bare 429
// or 403 as the hard pause. These tests drive it with Japanese singles alone. A plain lookup from the inspector or the bulk button is outside the
// queue and is not counted into dayCreditsUsed, for slabs as much as for these.
const wordOf = (i) => 'Mon' + String.fromCharCode(97 + Math.floor(i / 26)) + String.fromCharCode(97 + (i % 26)); // Monaa, Monab ...: all different species words
const lots = (n) => Array.from({ length: n }, (_, i) => single({ id: 'm' + (i + 1), name: wordOf(i) + ' ' + (i + 1), tcgdexId: 'SV8a-' + String(i + 1).padStart(3, '0'), costPrice: 100 - i, marketPrice: '' }));
const lotCard = (url) => {
  const m = /search=Mon([a-z])([a-z]) SV8a&/.exec(url);
  if (!m) return [];
  const n = (m[1].charCodeAt(0) - 97) * 26 + (m[2].charCodeAt(0) - 97) + 1;
  return [{ id: 'c' + n, name: 'Mon' + m[1] + m[2], setName: 'SV8a: Test Set', cardNumber: String(n).padStart(3, '0') + '/100', prices: { market: 3 } }];
};
const EXHAUSTED = { error: 'Daily credit limit exceeded', retryAfter: 3600, resetsAt: '2026-10-22T00:00:00.000Z' };

test('ppt-japanese: the lane bills its answers into dayCreditsUsed and stops at the free plan\'s 90 credits, 30 searches at 3, the rest wait for tomorrow', async () => {
  const app = await setup(lots(40), lotCard, 1);
  assert.equal(app.ctx.kjrPptPlan(), 'free');
  assert.equal(app.ctx.kjrDailyCredits(), 90);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 30, 'thirty searches at 3 credits is the 90');
  const q = savedQueue(app);
  assert.equal(q.dayCreditsUsed[UTC()], 90, 'billed in credits');
  assert.equal(q.creditsVersion, 1);
  assert.equal(q.cursor, 30);
  assert.equal(q.completed, false);
  assert.equal(q.items.length - q.cursor, 10, 'ten cards wait');
  assert.equal(app.row('m30').marketPrice, '3');
  assert.equal(app.row('m31').marketPrice, '', 'the 31st was not asked');
  assert.equal(app.row('m31')._tcgdexMissDate, undefined, 'and is not marked unmatched for it');
  // the budget is spent: another run today, automatic or manual, asks the vendor for nothing, and a manual one says why
  app.fetchMock.calls.length = 0;
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  assert.equal(app.ppt().length, 0, 'zero PPT requests once the budget is spent');
  assert.ok(app.toasts.some((t) => /PPT credits are used up for today/.test(t)), JSON.stringify(app.toasts));
  assert.equal(savedQueue(app).dayCreditsUsed[UTC()], 90);
});

test('ppt-japanese: it bills the vendor\'s own total, not a guess, and stops before a search the credits left can not pay for', async () => {
  const app = await setup(lots(30), lotCard, 1);
  app.fetchMock.route('/ppt/cards', (url) => answer(lotCard(decodeURIComponent(url)), 4));
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ppt().length, 22, '22 answers at 4 credits is 88, the 2 left do not pay for another search (3)');
  const q = savedQueue(app);
  assert.equal(q.dayCreditsUsed[UTC()], 88);
  assert.equal(q.cursor, 22);
  assert.equal(app.row('m22').marketPrice, '3');
  assert.equal(app.row('m23').marketPrice, '');
  assert.ok(app.toasts.some((t) => /8 waiting for tomorrow/.test(t)), JSON.stringify(app.toasts));
});

test('ppt-japanese: "Daily credit limit exceeded" pauses the lane for the vendor\'s day: the cursor stays on the card, no card is missed, no more requests', async () => {
  for (const status of [429, 403, 402, 200]) {
    const app = await setup(lots(4), lotCard, 1);
    let n = 0;
    app.fetchMock.route('/ppt/cards', (url) => (++n === 2 ? jsonResponse(EXHAUSTED, status) : answer(lotCard(decodeURIComponent(url)))));
    await drain(() => app.ctx.runRefreshQueue(false), app.timers);
    const q = savedQueue(app);
    assert.equal(app.ppt().length, 2, 'asked twice, refused once, then no more today: ' + status);
    assert.equal(q.cursor, 1, 'only the first card advanced: ' + status);
    assert.deepEqual(q.items.map((i) => i.id), ['m1', 'm2', 'm3', 'm4'], 'the refused card and the rest stay queued in order');
    assert.equal(q.creditsPausedDate, UTC(), 'paused for the vendor\'s day');
    assert.equal(q.dayCreditsUsed[UTC()], 3, 'only the answered search was billed');
    assert.equal(q.lastPausedReason, null, 'it is not a blocked key');
    assert.deepEqual(plain(q.lastErrorTally), {}, 'and not a failure of a card');
    assert.equal(q.completed, false);
    assert.equal(app.row('m1').marketPrice, '3');
    assert.equal(app.row('m2').marketPrice, '', 'nothing written for the refused card');
    assert.equal(app.row('m2').priceHistory.length, 0);
    assert.equal(app.row('m2')._tcgdexMissDate, undefined, 'and it is not marked unmatched');
    assert.deepEqual(plain(app.ctx._kjrUnresolvedSingles()), []);
    assert.ok(app.toasts.some((t) => /PPT credits are used up for today, pricing resumes after the reset \(8am Singapore time\)/.test(t) && /3 waiting for tomorrow/.test(t)), JSON.stringify(app.toasts));
    // the rest of the day asks for nothing
    app.fetchMock.calls.length = 0;
    await drain(() => app.ctx.runRefreshQueue(false), app.timers);
    assert.equal(app.ppt().length, 0, 'no request after the refusal: ' + status);
    assert.equal(savedQueue(app).cursor, 1);
  }
});

test('ppt-japanese: a bare 429 or 403 is the hard pause: the first one stops the batch, nothing is billed and no card is marked unmatched', async () => {
  for (const status of [429, 403]) {
    const app = await setup(lots(3), lotCard, 1);
    app.fetchMock.route('/ppt/cards', { ok: false, status, text: 'Too Many Requests' });
    await drain(() => app.ctx.runRefreshQueue(false), app.timers);
    const q = savedQueue(app);
    assert.equal(app.ppt().length, 1, 'the first refusal stops the batch: ' + status);
    assert.equal(q.lastPausedReason, 'PPT refused (HTTP ' + status + ')');
    assert.equal(q.cursor, 0);
    assert.equal(q.creditsPausedDate, undefined, 'a bare refusal is not a credit pause, tomorrow\'s run asks again');
    assert.equal(q.dayCreditsUsed[UTC()], 0, 'a refusal bills nothing');
    assert.deepEqual(q.items.map((i) => i.id), ['m1', 'm2', 'm3']);
    assert.deepEqual(plain(q.lastErrorTally), { ['HTTP ' + status]: 1 });
    assert.equal(app.row('m1')._tcgdexMissDate, undefined, 'not a verdict on the card');
    assert.equal(app.row('m1').marketPrice, '');
    assert.ok(app.toasts.some((t) => t.includes('paused: PPT refused (HTTP ' + status + ')')), JSON.stringify(app.toasts));
  }
});

// ── as shipped: the lane is on, and Chinese and Indonesian stay manual ───────────────────────────────────────────────────────────────
// No jaLane option here, so the constant itself decides.

test('ppt-japanese: as shipped (v3.89) the constant is true, a Japanese single with a number is the PPT lane, every other language stays manual', async () => {
  const rows = [
    single({ id: 'jp', language: 'JP' }), single({ id: 'jpl', language: ' jp ', name: 'Pikachu 25' }), single({ id: 'jpn', language: 'JP', name: 'Charizard ex' }),
    single({ id: 'cn', language: 'CN' }), single({ id: 'idn', language: 'ID', name: 'Pikachu 25' }), single({ id: 'kr', language: 'KR' }),
    single({ id: 'th', language: 'TH' }), single({ id: 'zh', language: 'ZH' }),
    single({ id: 'en', language: 'EN', name: 'Pikachu 25' }), single({ id: 'blank', language: '', name: 'Eevee 1' }),
  ];
  const app = await loadApp({ seed: { singles: rows, slabs: [] } });
  assert.equal(app.ctx.PPT_JA_LANE_ENABLED, true, 'the constant ships true');
  assert.equal(app.ctx.kjrPptJaLaneOn(), true);
  assert.deepEqual(plain(app.ctx._kjrPptJaLangs()), ['JP'], 'Japanese and nothing else');
  const lanes = Object.fromEntries(app.ctx.DB.singles.map((r) => [r.id, app.ctx._queueLaneFor(r)]));
  assert.deepEqual(lanes, { jp: 'ppt', jpl: 'ppt', jpn: 'manual', cn: 'manual', idn: 'manual', kr: 'manual', th: 'manual', zh: 'manual', en: 'tcgdex', blank: 'tcgdex' });
  assert.deepEqual(plain(app.ctx._kjrManualLangCards().map((r) => r.id).sort()), ['cn', 'idn', 'jpn', 'kr', 'th', 'zh'], 'a Japanese card with no number is manual too');
  assert.equal(app.ctx._kjrJapaneseLane(app.ctx.DB.singles.find((r) => r.id === 'cn')), false);
  assert.equal(app.ctx._kjrJapaneseLane(app.ctx.DB.singles.find((r) => r.id === 'idn')), false);
});

test('ppt-japanese: as shipped, a pass asks the Japanese catalogue for the Japanese card only, Chinese, Indonesian and Korean cards cost nothing', async () => {
  const rows = [single({ id: 'jp', language: 'JP', tcgdexId: 'SV2a-006' }), single({ id: 'cn', language: 'CN' }), single({ id: 'idn', language: 'ID' }), single({ id: 'kr', language: 'KR' })];
  const app = await loadApp({ seed: { singles: rows, slabs: [] } });
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(String(m));
  app.ctx.toastError = (m) => toasts.push('ERR ' + String(m));
  app.fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 2 }] });
  app.fetchMock.route('/ppt/cards', () => answer([jpCard()]));
  app.fetchMock.calls.length = 0;
  assert.deepEqual(plain(app.ctx.buildRefreshQueue().items.map((i) => i.id)), ['jp'], 'only the Japanese card is queued');
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  const asked = app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  assert.equal(asked.length, 1, 'one search, for the Japanese card');
  assert.equal(decodeURIComponent(new URL(asked[0].url).searchParams.get('search')), 'Charizard ex SV2a');
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')).length, 0);
  const row = (id) => app.ctx.DB.singles.find((r) => r.id === id);
  assert.equal(row('jp').marketPrice, '25');
  for (const id of ['cn', 'idn', 'kr']) {
    await app.ctx.refreshPrice(id, 'singles');
    assert.equal(row(id).marketPrice, '', id + ': nothing written');
    assert.equal(row(id).priceHistory.length, 0);
    assert.equal(row(id)._tcgdexMissDate, undefined, id + ': never asked, so not unmatched');
  }
  assert.equal(toasts.filter((t) => t === 'Manual price, no free source for this language').length, 3, 'the inspector says why, for each of the three');
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards')).length, 1, 'still the one search');
});

// ── a Slabs row with no grader is never the Japanese lane (v3.89) ─────────────────────────────────────────────────────────────────────
// With the lane on, a row of the SLABS table that was Japanese, carried a card number and had no grader got the lane 'ppt' from _queueLaneFor, which
// asked for the language and the number and never for the table. The queue runner then took it for a raw card, passed neither tcgdexOnly nor
// japanese, and the router ran the old fuzzy name-only PPT search ("Vaporeon 30 japanese", no language flag, no eBay data) and wrote the price of
// whatever card it matched: an M6a card for a row whose id says SV8a. The Japanese lane is for singles, so such a row is 'manual' wherever it is asked
// about (the queue, the inspector's Refresh, the bulk refresh, a queue saved by an older build). An English slab row with no grader keeps its free lane.
const graderlessJp = (o) => Object.assign({ id: 'x1', name: 'Vaporeon 30', language: 'JP', type: 'slab', status: 'Available', grader: '', grade: '', costPrice: 10, marketPrice: '', priceHistory: [], tcgdexId: 'SV8a-030' }, o);
const M6A_VAPOREON = { id: 'm6a', name: 'Vaporeon', cardNumber: '030/187', setName: 'M6a: MEGA Expansion 30th Celebration', prices: { market: 9 } }; // what the fuzzy search matched

test('ppt-japanese: a Slabs row with no grader is manual in every language but English, and graded slabs, singles and English rows keep their lanes', async () => {
  const app = await loadApp({ jaLane: true });
  const lane = (item, table) => app.ctx._queueLaneFor(item, table);
  const jp = graderlessJp();
  assert.equal(lane(jp, 'slabs'), 'manual', 'a DB row, the table said');
  assert.equal(lane(Object.assign({}, jp, { table: 'slabs' })), 'manual', 'a queue entry carries its own table');
  assert.equal(lane(Object.assign({}, jp, { table: 'slabs' }), 'slabs'), 'manual');
  assert.equal(app.ctx._kjrJapaneseLane(jp, 'slabs'), false, 'the Japanese lane is for singles');
  assert.equal(app.ctx._kjrJapaneseLane(Object.assign({}, jp, { table: 'slabs' })), false);
  for (const language of ['CN', 'ID', 'KR']) assert.equal(lane(graderlessJp({ language }), 'slabs'), 'manual', language);
  // unchanged: a Japanese single with a number, a graded Japanese slab (both ways of writing the grade), and an English row with no grader
  const single = graderlessJp({ type: 'raw' });
  assert.equal(lane(single, 'singles'), 'ppt');
  assert.equal(lane(Object.assign({}, single, { table: 'singles' })), 'ppt');
  assert.equal(lane(single), 'ppt', 'a row asked about with no table at all is read as a single, as it always was');
  assert.equal(app.ctx._kjrJapaneseLane(single, 'singles'), true);
  assert.equal(lane(graderlessJp({ grader: 'PSA', grade: '10' }), 'slabs'), 'ppt');
  assert.equal(lane(graderlessJp({ grader: '', grade: 'PSA 10' }), 'slabs'), 'ppt');
  assert.equal(lane(Object.assign({}, graderlessJp({ grader: 'PSA', grade: '10' }), { table: 'slabs' })), 'ppt');
  assert.equal(lane(graderlessJp({ language: 'EN' }), 'slabs'), 'tcgdex', 'an English slab row with no grader keeps the free lane');
  assert.equal(lane(graderlessJp({ language: 'EN', tcgdexId: '' }), 'slabs'), 'tcgdex');
  assert.equal(lane(graderlessJp({ language: '', tcgdexId: '', name: 'Vaporeon' }), 'slabs'), 'manual', 'and with no number it is manual as before');
  // with the switch off nothing changes either: the same rows are manual as in v3.84
  const off = await loadApp({ jaLane: false });
  assert.equal(off.ctx._queueLaneFor(jp, 'slabs'), 'manual');
  assert.equal(off.ctx._queueLaneFor(single, 'singles'), 'manual');
});

test('ppt-japanese: a Japanese Slabs row with no grader (Vaporeon 30, SV8a-030, an M6a card stubbed) is never priced: the queue, the inspector, the bulk refresh and an old queue entry make no name-only PPT search', async () => {
  const graded = graderlessJp({ id: 'g1', name: 'Charizard ex 6', grader: 'PSA', grade: '10', tcgdexId: '' });
  const jpSingle = single({ id: 'u1', name: 'Umbreon ex 93', tcgdexId: 'SV8a-093', costPrice: 10, marketPrice: '' });
  const app = await loadApp({ jaLane: true, seed: { singles: [jpSingle], slabs: [graderlessJp(), graded] } });
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(String(m));
  app.ctx.toastError = (m) => toasts.push('ERR ' + String(m));
  app.ctx.kjrConfirm = async () => true;
  app.fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 2 }] });
  // the vendor: a graded slab search is answered with the slab, a Japanese search by its set code, and the OLD plain search, the one that must not be made,
  // with the M6a card that matches this row's name and number but not its set. TCGdex would price this row's id too, if it were ever asked.
  app.fetchMock.route('/ppt/cards', (url) => {
    const u = new URL(url);
    if (u.searchParams.get('includeEbay') === 'true') return answer([{ id: 'sg', name: 'Charizard ex', cardNumber: '6/165', setName: 'SV2a: Pokemon Card 151', ebay: { salesByGrade: { psa10: { smartMarketPrice: { price: 40 } } } } }], 6);
    if (u.searchParams.get('language') === 'japanese') return answer(u.searchParams.get('search') === 'Umbreon ex SV8a' ? [LIVE_UMBREON] : []);
    return answer([M6A_VAPOREON]);
  });
  app.fetchMock.route('api.tcgdex.net', () => jsonResponse({ id: 'SV8a-030', pricing: { tcgplayer: { holofoil: { marketPrice: 7 } } } }));
  app.fetchMock.calls.length = 0;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  const fuzzy = [];
  const real = app.ctx.fetchPriceFromPPT;
  app.ctx.fetchPriceFromPPT = (...args) => { fuzzy.push(args); return real(...args); };
  const row = () => app.ctx.DB.slabs.find((r) => r.id === 'x1');
  const untouched = () => {
    assert.equal(row().marketPrice, '', 'nothing written');
    assert.equal(row().priceHistory.length, 0);
    assert.equal(row().priceHold, undefined);
    assert.equal(row()._tcgdexMissDate, undefined, 'and not stamped either, it was never asked');
    assert.equal(row().tcgdexId, 'SV8a-030');
    assert.equal(app.ctx._dirty.slabs.has('x1'), false, 'nothing to sync');
  };
  // the queue never holds it
  const built = plain(app.ctx.buildRefreshQueue());
  assert.deepEqual(built.items.map((i) => i.id + ':' + i.lane).sort(), ['g1:ppt', 'u1:ppt']);
  assert.equal(built.totalRows, 3, 'it is counted as a row and left manual');
  // the inspector's Refresh says what to add, and asks nothing
  await app.ctx.refreshPrice('x1', 'slabs');
  assert.deepEqual(toasts, ['Add the grader and grade to price this slab']);
  assert.equal(app.fetchMock.calls.length, 0, 'not one request of any kind');
  untouched();
  // a manual pass and an automatic one price the two control rows by their own lanes and leave this one alone
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  await drain(() => app.ctx.runRefreshQueue(false), app.timers);
  assert.equal(app.ctx.DB.slabs.find((r) => r.id === 'g1').marketPrice, '80', 'the graded Japanese slab is still the PPT slab lane: US$40 at 2');
  assert.equal(app.ctx.DB.singles.find((r) => r.id === 'u1').marketPrice, '6', 'the Japanese single is still the Japanese lane');
  assert.equal(JSON.parse(app.localStorage.getItem('pokeinv_refresh_queue')).dayCreditsUsed[UTC()], 9, 'a slab (6) and a single (3), nothing for the third row');
  untouched();
  // an entry a queue saved by an older build can hold for it is passed over without a request, a credit or a verdict
  const q = plain(app.ctx.buildRefreshQueue());
  q.items = [{ id: 'x1', table: 'slabs', lane: 'ppt', name: 'Vaporeon 30', language: 'JP', grader: null, grade: null, tcgdexId: 'SV8a-030', copyTargets: [] }];
  q.totalItems = 1;
  const before = app.ppt().length;
  await drain(() => app.ctx._runRefreshQueueBody(q, 90, false, UTC(), 0), app.timers);
  assert.equal(app.ppt().length, before, 'the old entry asked nothing');
  assert.equal(q.dayCreditsUsed[UTC()], 0, 'and spent nothing');
  assert.equal(q.cursor, 1, 'it counts as done for this cycle');
  untouched();
  // the bulk refresh counts it as manual
  await drain(() => app.ctx.bulkRefreshPrices('slabs'), app.timers);
  assert.ok(toasts.some((t) => /^Done: 1 updated, 1 skipped \(no automatic price\)$/.test(t)), JSON.stringify(toasts));
  untouched();
  // the whole run: every PPT request is a graded slab search or a Japanese one by set code, none is the plain name-only search, and nothing went to TCGdex
  const searches = app.ppt().map((c) => new URL(c.url));
  assert.ok(searches.length >= 3, 'control: the passes really ran');
  assert.deepEqual(searches.filter((u) => u.searchParams.get('includeEbay') !== 'true' && u.searchParams.get('language') !== 'japanese').map((u) => u.search), [], 'not one plain search');
  assert.ok(searches.every((u) => !/vaporeon/i.test(u.searchParams.get('search'))), 'and no search names the row');
  assert.deepEqual(fuzzy.filter((a) => !(a[1] && a[2])), [], 'the old fuzzy function only ever ran for a graded slab');
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net')).length, 0, 'TCGdex was never asked for it either');
});

test('ppt-japanese: a Japanese single that shares its name with a Slabs row with no grader keeps its own lookup, the manual slab row does not swallow it as a copy', async () => {
  // slabs are listed first, so the slab row used to be the primary of the pair: with its lane now manual the single would have been left without a lookup
  const twin = single({ id: 'u1', name: 'Umbreon ex 93', tcgdexId: 'SV8a-093', costPrice: 10, marketPrice: '' });
  const app = await loadApp({ jaLane: true, seed: { singles: [twin], slabs: [graderlessJp({ id: 'x1', name: 'Umbreon ex 93', tcgdexId: 'SV8a-093' })] } });
  app.ctx.toast = () => {};
  app.fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 2 }] });
  app.fetchMock.route('/ppt/cards', () => answer([LIVE_UMBREON]));
  app.fetchMock.calls.length = 0;
  const items = plain(app.ctx.buildRefreshQueue().items);
  assert.deepEqual(items.map((i) => [i.id, i.table, i.lane, i.copyTargets.length]), [['u1', 'singles', 'ppt', 0]], 'the single is queued on its own, as when it stands alone');
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  const asked = app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards')).map((c) => new URL(c.url));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].searchParams.get('language'), 'japanese');
  assert.equal(asked[0].searchParams.get('search'), 'Umbreon ex SV8a');
  assert.equal(app.ctx.DB.singles[0].marketPrice, '6', 'the single is priced by the Japanese lane');
  const slabRow = app.ctx.DB.slabs[0];
  assert.equal(slabRow.marketPrice, '', 'the Slabs row is not priced, nothing is copied onto it');
  assert.equal(slabRow.priceHistory.length, 0);
  assert.equal(app.ctx._dirty.slabs.has('x1'), false);
});

// ── the kill switch: the lane forced OFF through the harness─────────────────────────────────────────────────────────────────────────
// Setting PPT_JA_LANE_ENABLED back to false gives back v3.84 exactly: every non-English single is manual and nothing sends language=japanese.
// loadApp({ jaLane: false }) replaces the lane's one reader, so these tests do not depend on the constant's value.

test('ppt-japanese: with the switch off (the kill switch) a Japanese single with a number is manual and makes no PPT call, the v3.84 rules', async () => {
  const app = await setup([single({ marketPrice: 40 })], undefined, undefined, false);
  assert.equal(app.ctx.PPT_JA_LANE_ENABLED, true, 'the constant ships true (v3.89), this test forces the reader off through the harness');
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
