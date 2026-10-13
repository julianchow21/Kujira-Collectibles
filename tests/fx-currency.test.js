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
  fetchMock.route('frankfurter.dev', { ok: true, json: { rates: { SGD: 9.9 } } }); // out of the (0.5, 5) sanity band
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
// The response shape is the same ({ rates: { SGD } }), so the sanity band, the daily cache and the fallbacks are untouched.
const NEW_USD = 'https://api.frankfurter.dev/v1/latest?from=USD&to=SGD';
const NEW_EUR = 'https://api.frankfurter.dev/v1/latest?from=EUR&to=SGD';
const callUrls = (fetchMock) => fetchMock.calls.map((c) => c.url);

test('fx-currency: getSgdRate - the first source is api.frankfurter.dev/v1, one call, cached for today, no other source touched', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.dev', { ok: true, json: { amount: 1, base: 'USD', date: '2026-10-12', rates: { SGD: 1.2802 } } });
  const rate = await ctx.getSgdRate();
  assert.strictEqual(rate, 1.2802);
  assert.deepStrictEqual(callUrls(fetchMock), [NEW_USD], 'exactly one request, to the new host and path');
  const cached = JSON.parse(localStorage.getItem('pokeinv_fxrate'));
  assert.strictEqual(cached.rate, 1.2802);
  assert.strictEqual(cached.date, new Date().toISOString().slice(0, 10));
  // the second call the same day is served from the cache, no request at all
  fetchMock.calls.length = 0;
  assert.strictEqual(await ctx.getSgdRate(), 1.2802);
  assert.strictEqual(fetchMock.calls.length, 0);
});

test('fx-currency: getEurSgdRate - the first source is api.frankfurter.dev/v1, one call, cached for today, no other source touched', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.dev', { ok: true, json: { amount: 1, base: 'EUR', date: '2026-10-12', rates: { SGD: 1.4314 } } });
  const rate = await ctx.getEurSgdRate();
  assert.strictEqual(rate, 1.4314);
  assert.deepStrictEqual(callUrls(fetchMock), [NEW_EUR]);
  const cached = JSON.parse(localStorage.getItem('pokeinv_fxrate_eur'));
  assert.strictEqual(cached.rate, 1.4314);
  assert.strictEqual(cached.date, new Date().toISOString().slice(0, 10));
  fetchMock.calls.length = 0;
  assert.strictEqual(await ctx.getEurSgdRate(), 1.4314);
  assert.strictEqual(fetchMock.calls.length, 0);
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
    fetchMock.route('frankfurter.dev', { ok: true, json: { rates: { SGD: bad } } });
    assert.strictEqual(await ctx.getEurSgdRate(), 1.45, 'a rate of ' + bad + ' is outside the (1.0, 2.5) band');
  }
});
