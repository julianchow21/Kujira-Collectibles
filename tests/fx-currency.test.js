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
  fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 9.9 } } }); // out of the (0.5, 5) sanity band
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
  fetchMock.route('frankfurter.app', { ok: false, status: 500 });
  fetchMock.route('open.er-api.com', { ok: false, status: 500 });
  fetchMock.route('jsdelivr.net', { ok: false, status: 500 });
  const rate = await ctx.getSgdRate();
  assert.strictEqual(rate, 1.3, 'a stale cached rate is preferred over the hardcoded 1.27 when every live source fails');
});

test('fx-currency: getSgdRate - all sources fail AND there is no cache at all -> the hardcoded 1.27 fallback', async () => {
  const { ctx, fetchMock } = await loadApp(); // no pokeinv_fxrate seeded at all
  fetchMock.calls.length = 0;
  fetchMock.route('frankfurter.app', { ok: false, status: 500 });
  fetchMock.route('open.er-api.com', { ok: false, status: 500 });
  fetchMock.route('jsdelivr.net', { ok: false, status: 500 });
  const rate = await ctx.getSgdRate();
  assert.strictEqual(rate, 1.27);
});
