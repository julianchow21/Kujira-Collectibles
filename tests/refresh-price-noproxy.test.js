'use strict';
// v3.75: refreshPrice's PPT gate is the refresh queue's own, so a local PPT key is still required, but only when the Worker proxy is
// off (runRefreshQueue: "Only require a local key when proxy is disabled"). PRICE_PROXY_BASE is a top-level const, a test cannot
// reassign it, so this file loads the real app.js with that one line blanked (the harness reads app.js when it is first required,
// and each test file runs in its own process, so the patch reaches nothing else). The with-proxy half is tests/refresh-price.test.js.
const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const PROXY_LINE = "const PRICE_PROXY_BASE = 'https://kujira-prices.julianchow21.workers.dev';";
const realRead = fs.readFileSync;
let patched = false;
fs.readFileSync = function (file, ...rest) {
  const out = realRead.call(this, file, ...rest);
  if (!patched && typeof out === 'string' && /[\\/]app\.js$/.test(String(file)) && out.includes(PROXY_LINE)) {
    patched = true;
    return out.replace(PROXY_LINE, "const PRICE_PROXY_BASE = '';");
  }
  return out;
};
const { loadApp } = require('./harness.js');
fs.readFileSync = realRead;

const slabRow = (extra) => Object.assign({
  id: 'sl1', name: 'Charizard 4', type: 'slab', grader: 'PSA', grade: '10', language: 'EN', costPrice: 500,
  marketPrice: '', listPrice: '', status: 'Available', priceHistory: [],
}, extra);

async function setup(seed, key) {
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed), localStorage: key ? { pokeinv_ppt_apikey: key } : {} });
  assert.equal(patched, true, 'the proxy line was found and blanked, if app.js moved it this test needs updating');
  assert.equal(app.ctx.PRICE_PROXY_BASE, '', 'precondition: the proxy is off');
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.fetchMock.calls.length = 0;
  return app;
}

test('refresh-price, proxy off: a slab with no local PPT key is asked for one and nothing is requested', async () => {
  const app = await setup({ slabs: [slabRow()] });
  assert.equal(app.ctx.getApiKey('ppt'), '');
  app.fetchMock.route('/api/v2/cards', { ok: true, json: { data: [{ name: 'Charizard', number: '4', ebay: { psa10: { avg: 500 } } }] } });
  await app.ctx.refreshPrice('sl1', 'slabs');
  assert.deepEqual(app.toasts, ['Add API keys first: open Settings, then API settings']);
  assert.equal(app.fetchMock.calls.length, 0);
  assert.equal(app.grab('DB').DB.slabs[0].marketPrice, '');
});

test('refresh-price, proxy off: with a local key the slab goes to PPT directly, carrying the key', async () => {
  const app = await setup({ slabs: [slabRow()] }, 'test-key-not-real');
  app.fetchMock.route('/api/v2/cards', { ok: true, json: { data: [{ name: 'Charizard', number: '4', ebay: { psa10: { avg: 500 } } }] } });
  app.fetchMock.route('frankfurter.dev', { ok: true, json: { rates: { SGD: 1 } } });
  await app.ctx.refreshPrice('sl1', 'slabs');
  const ppt = app.fetchMock.calls.filter((c) => c.url.includes('pokemonpricetracker.com'));
  assert.equal(ppt.length, 1);
  assert.equal(ppt[0].opts.headers.Authorization, 'Bearer test-key-not-real');
  assert.equal(app.grab('DB').DB.slabs[0].marketPrice, '500');
});

test('refresh-price, proxy off: singles never needed a key, and a manual single still makes no call', async () => {
  const app = await setup({ singles: [
    { id: 's1', name: 'Pikachu 25', type: 'raw', language: 'EN', tcgdexId: 'sv3-199', marketPrice: '', priceHistory: [], status: 'Available' },
    { id: 'j1', name: 'Pikachu 25', type: 'raw', language: 'JP', marketPrice: 30, priceHistory: [], status: 'Available' },
  ] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  app.fetchMock.route('frankfurter.dev', { ok: true, json: { rates: { SGD: 1 } } });
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.grab('DB').DB.singles.find((r) => r.id === 's1').marketPrice, '45', 'priced free, no key involved');
  app.fetchMock.calls.length = 0; app.toasts.length = 0;
  await app.ctx.refreshPrice('j1', 'singles');
  assert.equal(app.fetchMock.calls.length, 0);
  assert.deepEqual(app.toasts, ['Manual price, no free source for this language']);
});

// ── bulkRefreshPrices follows the same rule (round 2) ──────────────────────────────────────────────
// The bulk run waits 1.1s between rows through the sandbox's setTimeout, which the harness never fires by itself. Only that wait is fired here,
// flushing everything would also run the app's own boot timers (the 8s refresh-queue start) and add requests of its own.
async function runWithTimerDrain(fn, timers, maxRounds) {
  const p = fn();
  let finished = false;
  p.then(() => { finished = true; }, () => { finished = true; });
  for (let i = 0; i < (maxRounds || 60) && !finished; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => e.delay === 1100);
  }
  return p;
}

test('bulk refresh, proxy off: slabs with no local PPT key are asked for one and nothing is requested', async () => {
  const app = await setup({ slabs: [slabRow()] });
  let opened = 0;
  app.ctx.openApiSettings = () => { opened++; };
  app.ctx.kjrConfirm = async () => true;
  app.fetchMock.route('/api/v2/cards', { ok: true, json: { data: [{ name: 'Charizard', number: '4', ebay: { psa10: { avg: 500 } } }] } });
  await app.ctx.bulkRefreshPrices('slabs');
  assert.deepEqual(app.toasts, ['Add API keys first: open Settings, then API settings']);
  assert.equal(opened, 1, 'the key settings open, as before');
  assert.equal(app.fetchMock.calls.length, 0);
});

test('bulk refresh, proxy off: with a local key the slabs go to PPT directly, carrying it', async () => {
  const app = await setup({ slabs: [slabRow()] }, 'test-key-not-real');
  app.ctx.kjrConfirm = async () => true;
  app.fetchMock.route('/api/v2/cards', { ok: true, json: { data: [{ name: 'Charizard', number: '4', ebay: { psa10: { avg: 500 } } }] } });
  app.fetchMock.route('frankfurter.dev', { ok: true, json: { rates: { SGD: 1 } } });
  await runWithTimerDrain(() => app.ctx.bulkRefreshPrices('slabs'), app.timers);
  const ppt = app.fetchMock.calls.filter((c) => c.url.includes('pokemonpricetracker.com'));
  assert.equal(ppt.length, 1);
  assert.equal(ppt[0].opts.headers.Authorization, 'Bearer test-key-not-real');
  assert.equal(app.grab('DB').DB.slabs[0].marketPrice, '500');
});

test('bulk refresh, proxy off: singles never needed a key, the gate is for the Slabs table only', async () => {
  const app = await setup({ singles: [{ id: 's1', name: 'Pikachu 25', type: 'raw', language: 'EN', tcgdexId: 'sv3-199', marketPrice: '', priceHistory: [], status: 'Available' }] });
  let opened = 0;
  app.ctx.openApiSettings = () => { opened++; };
  app.ctx.kjrConfirm = async () => true;
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  app.fetchMock.route('frankfurter.dev', { ok: true, json: { rates: { SGD: 1 } } });
  await runWithTimerDrain(() => app.ctx.bulkRefreshPrices('singles'), app.timers);
  assert.equal(opened, 0);
  assert.ok(!app.toasts.some((t) => /Add API keys first/.test(t)));
  assert.equal(app.grab('DB').DB.singles[0].marketPrice, '45');
});
