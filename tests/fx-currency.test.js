'use strict';
// Suite 21: fx-currency - usdToSgd, eurToSgd, getSgdRate.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

test('fx-currency: usdToSgd - uses the live _sgdRate when set', async () => {
  const { ctx } = await loadApp();
  ctx._sgdRate = 1.35;
  assert.strictEqual(ctx.usdToSgd(100), 135);
});

test('fx-currency: usdToSgd - falls back to a hardcoded 1.27 when _sgdRate is unset', async () => {
  const { ctx } = await loadApp();
  ctx._sgdRate = null;
  assert.strictEqual(ctx.usdToSgd(100), 127);
});

test('fx-currency: eurToSgd - uses the live _eurSgdRate when set, else the hardcoded 1.45 fallback', async () => {
  const { ctx } = await loadApp();
  ctx._eurSgdRate = 1.5;
  assert.strictEqual(ctx.eurToSgd(100), 150);
  ctx._eurSgdRate = null;
  assert.strictEqual(ctx.eurToSgd(100), 145);
});

test('fx-currency: getSgdRate - today\'s cached rate is returned immediately, with ZERO fetch calls', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const { ctx, fetchMock } = await loadApp({
    localStorage: { pokeinv_fxrate: JSON.stringify({ date: today, rate: 1.4 }) },
  });
  fetchMock.calls.length = 0;
  const rate = await ctx.getSgdRate();
  assert.strictEqual(rate, 1.4);
  assert.strictEqual(fetchMock.calls.length, 0);
});

test('fx-currency: getSgdRate - an out-of-sanity-band rate (9.9) from the first source is rejected, falls to the next source', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 9.9 }] }); // out of the (0.5, 5) sanity band
  fetchMock.route('open.er-api.com', { ok: true, json: { rates: { SGD: 1.35 } } }); // in-band, second source
  const rate = await ctx.getSgdRate();
  assert.strictEqual(rate, 1.35, 'the out-of-band first source is skipped in favour of the in-band second source');
  const cached = JSON.parse(localStorage.getItem('pokeinv_fxrate'));
  assert.strictEqual(cached.rate, 1.35, 'the accepted rate is cached for today');
});

test('fx-currency: getSgdRate - all 3 sources fail/out-of-band -> falls back to a STALE cache rather than the hardcoded default', async () => {
  const { ctx, fetchMock } = await loadApp({
    localStorage: { pokeinv_fxrate: JSON.stringify({ date: '2020-01-01', rate: 1.3 }) }, // old date, so the fast-path is skipped
  });
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.dev', { ok: false, status: 500 });
  fetchMock.route('open.er-api.com', { ok: false, status: 500 });
  fetchMock.route('jsdelivr.net', { ok: false, status: 500 });
  const rate = await ctx.getSgdRate();
  assert.strictEqual(rate, 1.3, 'a stale cached rate is preferred over the hardcoded 1.27 when every live source fails');
});

test('fx-currency: getSgdRate - all sources fail AND there is no cache at all -> the hardcoded 1.27 fallback', async () => {
  const { ctx, fetchMock } = await loadApp(); // no pokeinv_fxrate seeded at all
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.dev', { ok: false, status: 500 });
  fetchMock.route('open.er-api.com', { ok: false, status: 500 });
  fetchMock.route('jsdelivr.net', { ok: false, status: 500 });
  const rate = await ctx.getSgdRate();
  assert.strictEqual(rate, 1.27);
});

// v3.77: the first source moved from api.frankfurter.app to api.frankfurter.dev/v1. The old host now answers every request with a 301
// to the new one and sends no Access-Control-Allow-Origin on that redirect, so a browser on github.io blocks it (CORS) and the rate
// silently fell through to the second source. The new host answers 200 with access-control-allow-origin: * (checked 13/10/2026).
// v3.82: v1 now sends a deprecation header and a link to /v2/rates as its successor, so the first source moved again, to
// GET /v2/rates?base=USD&quotes=SGD (checked 17/10/2026, access-control-allow-origin: * still). v2 answers an ARRAY, one object per quote:
// [{ "date": "2026-10-17", "base": "USD", "quote": "SGD", "rate": 1.2808 }], and an error is an object ({ "status": 422, "message": ... }).
// The sanity band, the 4 second timeout, the daily cache, the other two sources and their order are untouched.
const NEW_USD = 'https://api.frankfurter.dev/v2/rates?base=USD&quotes=SGD';
const NEW_EUR = 'https://api.frankfurter.dev/v2/rates?base=EUR&quotes=SGD';
const ER_USD = 'https://open.er-api.com/v6/latest/USD';
const ER_EUR = 'https://open.er-api.com/v6/latest/EUR';
const callUrls = (fetchMock) => fetchMock.calls.map((c) => c.url);
const v2 = (base, rate) => [{ date: '2026-10-17', base, quote: 'SGD', rate }];

test('fx-currency: getSgdRate - the first source is api.frankfurter.dev/v2/rates, one call, cached for today, no other source touched', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.dev', { ok: true, json: v2('USD', 1.2808) });
  const rate = await ctx.getSgdRate();
  assert.strictEqual(rate, 1.2808);
  assert.deepStrictEqual(callUrls(fetchMock), [NEW_USD], 'exactly one request, to the new host and path');
  assert.ok(fetchMock.calls[0].opts && fetchMock.calls[0].opts.signal, 'the 4 second timeout signal is still passed');
  const cached = JSON.parse(localStorage.getItem('pokeinv_fxrate'));
  assert.strictEqual(cached.rate, 1.2808);
  assert.strictEqual(cached.date, new Date().toISOString().slice(0, 10));
  // the second call the same day is served from the cache, no request at all
  fetchMock.calls.length = 0;
  assert.strictEqual(await ctx.getSgdRate(), 1.2808);
  assert.strictEqual(fetchMock.calls.length, 0);
});

test('fx-currency: getEurSgdRate - the first source is api.frankfurter.dev/v2/rates, one call, cached for today, no other source touched', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.dev', { ok: true, json: v2('EUR', 1.4381) });
  const rate = await ctx.getEurSgdRate();
  assert.strictEqual(rate, 1.4381);
  assert.deepStrictEqual(callUrls(fetchMock), [NEW_EUR]);
  assert.ok(fetchMock.calls[0].opts && fetchMock.calls[0].opts.signal, 'the 4 second timeout signal is still passed');
  const cached = JSON.parse(localStorage.getItem('pokeinv_fxrate_eur'));
  assert.strictEqual(cached.rate, 1.4381);
  assert.strictEqual(cached.date, new Date().toISOString().slice(0, 10));
  fetchMock.calls.length = 0;
  assert.strictEqual(await ctx.getEurSgdRate(), 1.4381);
  assert.strictEqual(fetchMock.calls.length, 0);
});

test('fx-currency: the v2 array is read by its quote, not by position: the SGD element is found among others, a repeated SGD takes the first', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.dev', { ok: true, json: [
    { date: '2026-10-17', base: 'USD', quote: 'EUR', rate: 0.8905 },
    { date: '2026-10-17', base: 'USD', quote: 'SGD', rate: 1.2808 },
    { date: '2026-10-17', base: 'USD', quote: 'SGD', rate: 1.9 },
  ] });
  assert.strictEqual(await ctx.getSgdRate(), 1.2808);
  assert.strictEqual(await ctx.getEurSgdRate(), 1.2808, 'the same body read for the EUR base: the quote is what is matched');
  assert.deepStrictEqual(callUrls(fetchMock), [NEW_USD, NEW_EUR]);
});

// A first source that answers but gives no usable SGD rate counts as a failed source: the second one runs next, exactly as it does for
// a source that is down, and the third is never touched when the second answers.
const NO_SGD_RATE = {
  'an empty array': [],
  'an array with no SGD element': [{ date: '2026-10-17', base: 'USD', quote: 'EUR', rate: 0.8905 }],
  'an SGD element with no rate': [{ date: '2026-10-17', base: 'USD', quote: 'SGD' }],
  'a rate of null': v2('USD', null),
  'a text rate': v2('USD', 'abc'),
  'a numeric string rate': v2('USD', '1.2808'),
  'a rate of NaN': v2('USD', NaN),
  'a rate of Infinity': v2('USD', Infinity),
  'a rate of an object': v2('USD', { value: 1.28 }),
  'a lower-case quote': [{ date: '2026-10-17', base: 'USD', quote: 'sgd', rate: 1.2808 }],
  'junk elements only': [null, 5, 'SGD', [], { quote: 'SGD' }],
  'the retired v1 shape': { amount: 1, base: 'USD', date: '2026-10-12', rates: { SGD: 1.2802 } },
  'the v2 error object': { status: 422, message: 'invalid currency: SGD' },
  'null': null,
  'a number': 1.2808,
  'text': 'SGD',
};
test('fx-currency: a v2 answer with no usable SGD rate is a failed source: getSgdRate and getEurSgdRate fall to the second source in order', async () => {
  for (const [label, body] of Object.entries(NO_SGD_RATE)) {
    const { ctx, fetchMock, localStorage } = await loadApp();
    fetchMock.calls.length = 0;
    fetchMock.route('frankfurter.dev', { ok: true, json: body });
    fetchMock.route(ER_USD, { ok: true, json: { rates: { SGD: 1.31 } } });
    fetchMock.route(ER_EUR, { ok: true, json: { rates: { SGD: 1.52 } } });
    assert.strictEqual(await ctx.getSgdRate(), 1.31, label);
    assert.strictEqual(await ctx.getEurSgdRate(), 1.52, label);
    assert.deepStrictEqual(callUrls(fetchMock), [NEW_USD, ER_USD, NEW_EUR, ER_EUR], label + ': the second source answered, the third was not asked');
    assert.strictEqual(JSON.parse(localStorage.getItem('pokeinv_fxrate')).rate, 1.31, label + ': the second source\'s rate is the one cached');
    assert.strictEqual(JSON.parse(localStorage.getItem('pokeinv_fxrate_eur')).rate, 1.52, label);
  }
});

test('fx-currency: a v2 answer with no usable SGD rate, with every other source down, ends on the stale cache and then the hardcoded rates, as before', async () => {
  const stale = { date: '2020-01-01', rate: 1.3 };
  // a spread of the cases rather than all of them, each of these ends in a console warning
  for (const label of ['an empty array', 'an array with no SGD element', 'a text rate', 'the retired v1 shape', 'the v2 error object']) {
    const body = NO_SGD_RATE[label];
    const withCache = await loadApp({ localStorage: { pokeinv_fxrate: JSON.stringify(stale), pokeinv_fxrate_eur: JSON.stringify({ date: '2020-01-01', rate: 1.6 }) } });
    withCache.fetchMock.calls.length = 0;
    withCache.fetchMock.route('frankfurter.dev', { ok: true, json: body });
    assert.strictEqual(await withCache.ctx.getSgdRate(), 1.3, label + ': stale cache');
    assert.strictEqual(await withCache.ctx.getEurSgdRate(), 1.6, label + ': stale cache');
    const bare = await loadApp();
    bare.fetchMock.calls.length = 0;
    bare.fetchMock.route('frankfurter.dev', { ok: true, json: body });
    assert.strictEqual(await bare.ctx.getSgdRate(), 1.27, label + ': hardcoded USD');
    assert.strictEqual(await bare.ctx.getEurSgdRate(), 1.45, label + ': hardcoded EUR');
    assert.strictEqual(bare.localStorage.getItem('pokeinv_fxrate'), null, label + ': a failed lookup caches nothing');
  }
});

test('fx-currency: the Frankfurter calls name /v2/rates with base and quotes, keep the 4 second timeout, and no v1 URL is left in the FX functions', () => {
  const src = require('node:fs').readFileSync(require('./harness.js').ROOT + '/app.js', 'utf8');
  const fx = src.slice(src.indexOf('async function getSgdRate()'), src.indexOf('function eurToSgd('));
  assert.ok(fx.length > 1000 && fx.includes('getEurSgdRate'), 'the slice is both waterfalls');
  for (const base of ['USD', 'EUR']) {
    assert.ok(fx.includes("fetch('https://api.frankfurter.dev/v2/rates?base=" + base + "&quotes=SGD', { signal: AbortSignal.timeout(4000) })"), base);
  }
  assert.strictEqual((fx.match(/api\.frankfurter\.dev\//g) || []).length, 3, 'two calls, and the comment that tells the move');
  assert.doesNotMatch(fx, /fetch\('https:\/\/api\.frankfurter\.dev\/v1/, 'no call goes to v1');
  assert.doesNotMatch(fx, /[?&](?:from|to|symbols)=/, 'v1 and v2 spell their parameters differently: base and quotes, not from, to or symbols');
});

test('fx-currency: no request ever goes to the retired api.frankfurter.app host, even when the new host is down', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.dev', { ok: false, status: 500 });
  fetchMock.route('open.er-api.com', { ok: false, status: 500 });
  fetchMock.route('jsdelivr.net', { ok: false, status: 500 });
  await ctx.getSgdRate();
  await ctx.getEurSgdRate();
  const urls = callUrls(fetchMock);
  assert.ok(urls.length >= 6, 'both waterfalls ran to the end: ' + urls.join(' '));
  assert.deepStrictEqual(urls.filter((u) => /frankfurter\.app/.test(u)), []);
  const fs = require('node:fs');
  const { ROOT } = require('./harness.js');
  for (const file of ['app.js', 'features.js', 'index.html', 'sw.js']) {
    assert.doesNotMatch(fs.readFileSync(ROOT + '/' + file, 'utf8'), /frankfurter\.app/, file + ' no longer names the retired host');
  }
});

test('fx-currency: getSgdRate and getEurSgdRate - when the new host is down the existing fallback chain still runs in order', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.reject('frankfurter.dev'); // a network failure, which is what a CORS block looks like to fetch
  fetchMock.route('open.er-api.com/v6/latest/USD', { ok: true, json: { rates: { SGD: 1.31 } } });
  fetchMock.route('open.er-api.com/v6/latest/EUR', { ok: true, json: { rates: { SGD: 1.52 } } });
  assert.strictEqual(await ctx.getSgdRate(), 1.31);
  assert.strictEqual(await ctx.getEurSgdRate(), 1.52);
  assert.deepStrictEqual(callUrls(fetchMock), [NEW_USD, 'https://open.er-api.com/v6/latest/USD', NEW_EUR, 'https://open.er-api.com/v6/latest/EUR']);
});

test('fx-currency: getEurSgdRate - an out-of-band rate from the new host (0.4, 9) is rejected and the hardcoded 1.45 holds when nothing else answers', async () => {
  for (const bad of [0.4, 9]) {
    const { ctx, fetchMock } = await loadApp();
    fetchMock.calls.length = 0;
    fetchMock.route('frankfurter.dev', { ok: true, json: v2('EUR', bad) });
    assert.strictEqual(await ctx.getEurSgdRate(), 1.45, 'a rate of ' + bad + ' is outside the (1.0, 2.5) band');
  }
});
