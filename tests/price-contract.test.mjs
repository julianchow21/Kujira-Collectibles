// Price contract: the real client (fetchPriceFromPPT and the refresh queue in
// app.js) wired to the real Worker (Server/worker.js), with only the vendor
// stubbed. Guards the 16/09/2026 production failure: v3.54 searched with
// limit=5 (fallback limit=10), the deployed Worker accepts only limit=3, so
// every slab got HTTP 400 "invalid query" and the queue paused after five.
// The per-side tests pin each half to a literal, this suite fails when the
// two halves disagree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { loadApp, plain } = require('./harness.js');

globalThis.caches = {
  default: {
    match: async () => null,
    put: async () => {}
  }
};

const source = fs.readFileSync(
  new URL('../Server/worker.js', import.meta.url),
  'utf8'
);
const worker = (await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
)).default;

const PRICE_ENV = { PPT_KEY: 'synthetic-price-key' };
const APP_ORIGIN = 'https://julianchow21.github.io';
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

// Same drain as refresh-queue.test.js: the queue awaits sandbox setTimeout
// gaps that the harness timer shim only fires on flush().
async function runWithTimerDrain(fn, timers, maxRounds) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < maxRounds && !done; i++) {
    await new Promise(r => setImmediate(r));
    timers.flush();
  }
  return p;
}

// The vendor echoes one graded card named after the search, or nothing for
// searches listed in emptyFor. Every client request goes through worker.fetch
// exactly as the browser would send it from the production origin.
async function wireClientToWorker(appOpts, emptyFor = []) {
  const app = await loadApp(appOpts);
  const vendorSearches = [];
  const workerStatuses = [];
  globalThis.fetch = async url => {
    const search = new URL(String(url)).searchParams.get('search');
    vendorSearches.push(search);
    if (emptyFor.includes(search)) return Response.json({ data: [] });
    return Response.json({ data: [{ name: search, number: '', ebay: { psa10: { avg: 500 } } }] });
  };
  app.fetchMock.route('/ppt/cards', async url => {
    const response = await worker.fetch(
      new Request(url, { headers: { Origin: APP_ORIGIN } }),
      PRICE_ENV
    );
    workerStatuses.push(response.status);
    return response;
  });
  app.fetchMock.route('frankfurter.app', { ok: true, json: { rates: { SGD: 1 } } });
  return { ...app, vendorSearches, workerStatuses };
}

test('price contract: client PPT searches pass the Worker validator end to end', async () => {
  const cases = [
    { name: 'Charizard 4/102', language: 'EN', search: 'Charizard 4/102' },
    { name: 'Pikachu & Zekrom GX #33', language: 'EN', search: 'Pikachu & Zekrom GX #33' },
    { name: 'Flabébé 85', language: null, search: 'Flabébé 85' },
    { name: 'Poliwhirl 176', language: 'JP', search: 'Poliwhirl 176 japanese' }
  ];
  for (const c of cases) {
    const { ctx, vendorSearches, workerStatuses } = await wireClientToWorker();
    const result = await ctx.fetchPriceFromPPT(c.name, 'PSA', '10', c.language);
    assert.deepEqual(workerStatuses, [200], c.name + ' must not be refused by the Worker');
    assert.deepEqual(vendorSearches, [c.search], c.name + ' must reach the vendor as one intact search');
    assert.equal(result.priceUsd, 500, c.name + ' must price');
  }
});

test('price contract: the base-name fallback search also passes the Worker', async () => {
  const { ctx, vendorSearches, workerStatuses } = await wireClientToWorker(undefined, ['Gardevoir ex 93']);
  const result = await ctx.fetchPriceFromPPT('Gardevoir ex 93', 'PSA', '10', 'EN');
  assert.deepEqual(workerStatuses, [200, 200]);
  assert.deepEqual(vendorSearches, ['Gardevoir ex 93', 'Gardevoir ex']);
  assert.equal(result.priceUsd, 500);
  assert.equal(result.usedFallback, true);
});

test('price contract: the v3.54 request limits are the ones the Worker refuses', async () => {
  globalThis.fetch = async () => {
    throw new Error('a refused query must never reach the vendor');
  };
  for (const limit of ['5', '10']) {
    const response = await worker.fetch(new Request(
      'https://worker.example/ppt/cards?search=Charizard&limit=' + limit,
      { headers: { Origin: APP_ORIGIN } }
    ), PRICE_ENV);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'invalid query' });
  }
});

test('price contract: a blank name is a data miss with no request, never a Worker 400', async () => {
  const blank = await worker.fetch(new Request(
    'https://worker.example/ppt/cards?search=%20&limit=3',
    { headers: { Origin: APP_ORIGIN } }
  ), PRICE_ENV);
  assert.equal(blank.status, 400, 'the Worker refuses a blank search, so the client must not send one');

  const { ctx, fetchMock } = await wireClientToWorker();
  fetchMock.calls.length = 0;
  for (const name of ['', '   ']) {
    const ppt = await ctx.fetchPriceFromPPT(name, 'PSA', '10', 'JP');
    assert.deepEqual(plain(ppt), { error: 'no card name', _ppt_requests: 0, usedFallback: false });
  }
  const routed = await ctx.fetchMarketPrice({ name: ' ', grader: 'PSA', grade: '10', language: 'EN' });
  assert.equal(routed.pptError, 'no card name');
  assert.equal(routed.creditsUsed, 0);
  assert.ok(!fetchMock.calls.some(c => c.url.includes('/ppt/cards')), 'no proxy request for a blank name');
});

test('price contract: the 16/09 eight-slab queue prices through the Worker without pausing', async () => {
  const names = [
    'Charizard 4/102', 'Blastoise 2/102', 'Venusaur 15/102', 'Umbreon VMAX 215',
    'Rayquaza VMAX 218', 'Pikachu & Zekrom GX #33', 'Lugia V 186', 'Gengar VMAX 271'
  ];
  const slabs = names.map((name, i) => ({
    id: 'contract-slab-' + i, name, grader: 'PSA', grade: '10',
    costPrice: 800 - i * 10, status: 'Available', marketPrice: '', priceHistory: []
  }));
  slabs.push({
    id: 'contract-slab-blank', name: ' ', grader: 'PSA', grade: '10',
    costPrice: 1, status: 'Available', marketPrice: '', priceHistory: []
  });
  const { ctx, timers, grab, workerStatuses } = await wireClientToWorker({ seed: { singles: [], slabs } });
  const today = new Date().toISOString().slice(0, 10);

  // The automatic page-load run, the path that paused on 16/09. Its own 8s
  // scheduled twin finds the queue already running and bails.
  await runWithTimerDrain(() => ctx.runRefreshQueue(false), timers, 600);
  const q = plain(ctx.loadQueue());

  assert.equal(q.items.length, 9);
  assert.ok(q.items.every(item => item.lane === 'ppt'), 'every slab is in the PPT lane');
  assert.equal(workerStatuses.length, 8, 'one Worker request per named slab, none for the blank one');
  assert.ok(workerStatuses.every(status => status === 200), 'no Worker refusal: ' + workerStatuses.join(','));
  assert.equal(q.lastPausedReason, null, 'the queue must not pause');
  assert.deepEqual(plain(q.lastErrorTally), { 'no card name': 1 }, 'only the blank slab is a miss');
  assert.equal(q.cursor, 9, 'priced slabs and the blank data miss all advance');
  assert.equal(q.completed, true);
  assert.equal(q.dayCreditsUsed[today], 8, 'eight billed requests, the blank slab costs nothing');

  const { DB } = grab('DB');
  for (const slab of slabs.slice(0, 8)) {
    assert.equal(DB.slabs.find(row => row.id === slab.id).marketPrice, '500', slab.name + ' priced');
  }
});
