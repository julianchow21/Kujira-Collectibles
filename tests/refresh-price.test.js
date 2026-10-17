'use strict';
// v3.75: refreshPrice(id, table), the per-row "Refresh price" action (the card inspector calls it), follows the refresh queue's
// lane rules instead of its own older ones. Two parked bugs:
//   - a slab needed a PPT key typed into this browser, but production prices slabs through the Cloudflare Worker, which holds
//     PPT_KEY as a secret, so a missing local key must not block it (runRefreshQueue only asks for one when the proxy is off)
//   - a single went to fetchMarketPrice without tcgdexOnly, so a TCGdex miss fell through to a fuzzy PPT search, a billed
//     request the free lane is forbidden to make. Non-English and numberless singles are manual (_queueLaneFor), no API at all.
// Fetch is stubbed (tests/harness.js createFetchMock), nothing here reaches a real API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const today = () => new Date().toISOString().slice(0, 10);
const slabRow = (extra) => Object.assign({
  id: 'sl1', name: 'Charizard 4', type: 'slab', grader: 'PSA', grade: '10', language: 'EN', costPrice: 500,
  marketPrice: '', listPrice: '', status: 'Available', priceHistory: [],
}, extra);
const singleRow = (extra) => Object.assign({
  id: 's1', name: 'Pikachu 25', type: 'raw', language: 'EN', costPrice: 10,
  marketPrice: '', listPrice: '', status: 'Available', priceHistory: [],
}, extra);

async function setup(seed) {
  const app = await loadApp({ seed: Object.assign({ singles: [], slabs: [] }, seed) });
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(String(m));
  app.ctx.toastError = (m) => toasts.push('ERR ' + String(m));
  app.fetchMock.calls.length = 0; // loadApp's boot fetches (the FX rate) are not part of the click
  app.toasts = toasts;
  app.ppt = () => app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards'));
  app.tcgdex = () => app.fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net'));
  app.row = (table, id) => app.grab('DB').DB[table].find((r) => r.id === id);
  app.dirty = (table, id) => app.grab('_dirty')._dirty[table].has(id);
  return app;
}
const fx = (app, rate) => app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: rate == null ? 1 : rate }] });
const pptHit = (app, avg) => app.fetchMock.route('/ppt/cards', { ok: true, json: { data: [{ name: 'Charizard', number: '4', ebay: { psa10: { avg } } }] } });

// ── slabs: PPT through the Worker, no local key needed ──────────────────────────────────────────────
test('refresh-price: a slab with no local PPT key still refreshes through the Worker (the PPT path)', async () => {
  const app = await setup({ slabs: [slabRow()] });
  assert.equal(app.ctx.getApiKey('ppt'), '', 'precondition: no PPT key in this browser');
  assert.ok(app.ctx.PRICE_PROXY_BASE, 'precondition: the Worker proxy is configured, as in production');
  pptHit(app, 500); fx(app, 1);
  await app.ctx.refreshPrice('sl1', 'slabs');
  assert.equal(app.ppt().length, 1, 'one PPT request, made through the proxy');
  assert.ok(app.ppt()[0].url.startsWith(app.ctx.PRICE_PROXY_BASE + '/ppt/cards'), 'to the Worker, which holds the key: ' + app.ppt()[0].url);
  assert.equal(app.tcgdex().length, 0, 'a slab never touches TCGdex');
  assert.ok(!app.toasts.some((t) => /Add API keys first/.test(t)), 'no key nag: ' + JSON.stringify(app.toasts));
  const row = app.row('slabs', 'sl1');
  assert.equal(row.marketPrice, '500');
  assert.equal(row.priceHistory.length, 1);
  assert.equal(row.priceHistory[0].source, 'PPT (PSA 10)');
  assert.equal(app.dirty('slabs', 'sl1'), true, 'a changed price syncs');
  assert.ok(app.toasts.some((t) => /^Updated S\$500 \(PPT \(PSA 10\)\)$/.test(t)), JSON.stringify(app.toasts));
});

test('refresh-price: a slab PPT miss is reported and writes nothing, still no key nag', async () => {
  const app = await setup({ slabs: [slabRow()] });
  app.fetchMock.route('/ppt/cards', { ok: true, json: { data: [] } });
  await app.ctx.refreshPrice('sl1', 'slabs');
  assert.ok(app.ppt().length >= 1, 'PPT was asked');
  assert.equal(app.tcgdex().length, 0);
  assert.equal(app.row('slabs', 'sl1').marketPrice, '');
  assert.equal(app.row('slabs', 'sl1').priceHistory.length, 0);
  assert.ok(app.toasts.some((t) => /^ERR No price found/.test(t)), JSON.stringify(app.toasts));
  assert.ok(!app.toasts.some((t) => /Add API keys first/.test(t)));
});

// ── singles: the free lane's rules, a miss is clean and never reaches PPT ───────────────────────────
test('refresh-price: an English single whose TCGdex lookup misses makes zero PPT calls and stays unpriced', async () => {
  const app = await setup({ singles: [singleRow()] });
  app.fetchMock.route('api.tcgdex.net', { ok: true, json: [] }); // resolve finds no candidate
  // if the old fuzzy fallback still ran, this is what it would find and write
  app.fetchMock.route('/ppt/cards', { ok: true, json: { data: [{ name: 'Pikachu', number: '25', prices: { market: 40 } }] } });
  fx(app, 1);
  await app.ctx.refreshPrice('s1', 'singles');
  assert.ok(app.tcgdex().length >= 1, 'TCGdex was asked');
  assert.equal(app.ppt().length, 0, 'a TCGdex miss must never fall through to a (billed) PPT search');
  const row = app.row('singles', 's1');
  assert.equal(row.marketPrice, '', 'no price from a fuzzy guess');
  assert.equal(row.priceHistory.length, 0);
  assert.ok(app.toasts.some((t) => /^ERR No price found/.test(t)), 'the miss is reported: ' + JSON.stringify(app.toasts));
});

test('refresh-price: a cached tcgdexId whose card has no price is a clean miss too, zero PPT calls', async () => {
  const app = await setup({ singles: [singleRow({ tcgdexId: 'sv3-199' })] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { id: 'sv3-199', name: 'Pikachu' } }); // no pricing block
  pptHit(app, 99);
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.ppt().length, 0);
  assert.equal(app.row('singles', 's1').marketPrice, '');
});

test('refresh-price: a TCGdex transport failure on a single is a miss, zero PPT calls', async () => {
  const app = await setup({ singles: [singleRow()] }); // fetch is offline by default, every call rejects
  pptHit(app, 99);
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.ppt().length, 0);
  assert.equal(app.row('singles', 's1').marketPrice, '');
});

test('refresh-price: an English single TCGdex can price is priced by TCGdex alone', async () => {
  const app = await setup({ singles: [singleRow({ tcgdexId: 'sv3-199' })] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  pptHit(app, 99); fx(app, 1);
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.ppt().length, 0, 'the free lane never needs PPT');
  const row = app.row('singles', 's1');
  assert.equal(row.marketPrice, '45');
  assert.equal(row.priceHistory.length, 1);
  assert.equal(row.priceHistory[0].source, 'TCGdex (TCGplayer)');
  assert.equal(app.dirty('singles', 's1'), true);
});

test('refresh-price: a blank language counts as English, like the queue', async () => {
  const app = await setup({ singles: [singleRow({ language: '', tcgdexId: 'sv3-199' })] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { normal: { marketPrice: 12 } } } } });
  fx(app, 1);
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.row('singles', 's1').marketPrice, '12');
});

// ── manual singles: no API at all, and the toast says why ───────────────────────────────────────────
test('refresh-price: a Japanese single makes zero API calls and says it is a manual price', async () => {
  for (const language of ['JP', 'CN', 'ID', 'KR']) {
    const app = await setup({ singles: [singleRow({ language, marketPrice: 30 })] });
    app.fetchMock.route('api.tcgdex.net', { ok: true, json: [{ id: 'sv3-199' }] });
    pptHit(app, 99); fx(app, 1);
    await app.ctx.refreshPrice('s1', 'singles');
    assert.equal(app.fetchMock.calls.length, 0, language + ': no TCGdex, no PPT, not even an FX lookup');
    assert.deepEqual(app.toasts, ['Manual price, no free source for this language'], language + ' says why, and does not claim to be fetching');
    const row = app.row('singles', 's1');
    assert.equal(row.marketPrice, 30, language + ': the hand-set price is untouched');
    assert.equal(row.priceHistory.length, 0);
    assert.equal(app.dirty('singles', 's1'), false, language + ': nothing to sync');
  }
});

test('refresh-price: a Japanese single with a cached tcgdexId is still manual', async () => {
  const app = await setup({ singles: [singleRow({ language: 'JP', tcgdexId: 'sv3-199' })] });
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.fetchMock.calls.length, 0);
  assert.deepEqual(app.toasts, ['Manual price, no free source for this language']);
});

test('refresh-price: an English single with no card number makes zero API calls and asks for the number', async () => {
  const app = await setup({ singles: [singleRow({ name: 'Umbreon Custom Card', marketPrice: 8 })] });
  pptHit(app, 99); fx(app, 1);
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.fetchMock.calls.length, 0, 'no fuzzy name search anywhere');
  assert.deepEqual(app.toasts, ['Add or fix the card number for exact pricing']);
  assert.equal(app.row('singles', 's1').marketPrice, 8);
  assert.equal(app.dirty('singles', 's1'), false);
});

test('refresh-price: the manual verdict is the queue\'s own (_queueLaneFor), not a second rule', async () => {
  const app = await setup({ singles: [singleRow({ id: 'en', name: 'Pikachu 25' }), singleRow({ id: 'jp', language: 'JP' }), singleRow({ id: 'nn', name: 'Umbreon Custom Card' })] });
  const lanes = {};
  for (const id of ['en', 'jp', 'nn']) lanes[id] = app.ctx._queueLaneFor(app.row('singles', id));
  assert.deepEqual(lanes, { en: 'tcgdex', jp: 'manual', nn: 'manual' });
  for (const id of ['jp', 'nn']) {
    app.fetchMock.calls.length = 0;
    await app.ctx.refreshPrice(id, 'singles');
    assert.equal(app.fetchMock.calls.length, 0, id + ' is manual in the queue, so it makes no call here either');
  }
});

// ── v3.26: a same-value re-price is a no-op for sync ────────────────────────────────────────────────
test('refresh-price: same value on a single with its tcgdexId already cached is still a no-op for sync', async () => {
  const app = await setup({ singles: [singleRow({ marketPrice: '45', tcgdexId: 'sv3-199' })] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  fx(app, 1);
  await app.ctx.refreshPrice('s1', 'singles');
  const row = app.row('singles', 's1');
  assert.equal(row.priceHistory.length, 0, 'no priceHistory append');
  assert.equal(app.dirty('singles', 's1'), false, 'no markDirty');
  assert.equal(row._tcgdexPricedDate, today(), 'the local priced-today marker is still stamped');
  assert.equal(app.ppt().length, 0);
  assert.ok(app.toasts.some((t) => /^Price unchanged: S\$45 \(TCGdex \(TCGplayer\)\)$/.test(t)), JSON.stringify(app.toasts));
});

test('refresh-price: same value on a slab refreshed through the Worker is a no-op for sync too', async () => {
  const app = await setup({ slabs: [slabRow({ marketPrice: 500 })] }); // a number, as the edit modal stores it
  pptHit(app, 500); fx(app, 1);
  await app.ctx.refreshPrice('sl1', 'slabs');
  assert.equal(app.ppt().length, 1, 'it did ask PPT, with no local key');
  const row = app.row('slabs', 'sl1');
  assert.equal(row.priceHistory.length, 0, 'no priceHistory append');
  assert.equal(app.dirty('slabs', 'sl1'), false, 'no markDirty');
  assert.equal(row._tcgdexPricedDate, today());
  assert.ok(app.toasts.some((t) => /^Price unchanged: S\$500/.test(t)), JSON.stringify(app.toasts));
});

test('refresh-price: a changed value still appends history and marks dirty, a fresh tcgdexId still syncs', async () => {
  const app = await setup({ singles: [singleRow({ marketPrice: '45', tcgdexId: 'sv3-199' }), singleRow({ id: 's2', name: 'Raichu 14', marketPrice: '45' })] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 99 } } } } });
  app.fetchMock.route('/en/cards?name=', { ok: true, json: [{ id: 'sv3-14', name: 'Raichu' }] });
  app.fetchMock.route('/cards/sv3-14', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  fx(app, 1);
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.row('singles', 's1').marketPrice, '99');
  assert.equal(app.row('singles', 's1').priceHistory.length, 1);
  assert.equal(app.dirty('singles', 's1'), true);
  // unchanged price, but the id was just resolved: that id has to reach the other devices
  await app.ctx.refreshPrice('s2', 'singles');
  assert.equal(app.row('singles', 's2').tcgdexId, 'sv3-14');
  assert.equal(app.row('singles', 's2').priceHistory.length, 1);
  assert.equal(app.dirty('singles', 's2'), true);
  assert.equal(app.ppt().length, 0);
});

// ── guards that were already there stay ─────────────────────────────────────────────────────────────
test('refresh-price: an unknown row id does nothing', async () => {
  const app = await setup({ singles: [singleRow()] });
  await app.ctx.refreshPrice('nope', 'singles');
  assert.equal(app.fetchMock.calls.length, 0);
  assert.deepEqual(app.toasts, []);
});

test('refresh-price: the inspector still disables the action in a local preview, in its own words', async () => {
  const app = await setup({ singles: [singleRow()] });
  app.ctx.location = Object.assign({}, app.ctx.location, { hostname: '127.0.0.1', protocol: 'http:' });
  const info = app.ctx.kjrInspectRefreshInfo('singles', app.row('singles', 's1'));
  assert.equal(info.ok, false);
  assert.equal(info.why, 'Price refresh is disabled in local preview (sync off). Use the live site.');
});

// ═══ round 2 ════════════════════════════════════════════════════════════════════════════════════════
// A slab is a row of the Slabs table, as buildRefreshQueue sees it, not a row whose type field happens to say so.
test('refresh-price: a row of the Slabs table is a slab whatever its type field says, priced through PPT with no local key', async () => {
  const row = slabRow();
  delete row.type; // older rows may not carry it, normalizeRecord only stamps it on a save
  const app = await setup({ slabs: [row] });
  pptHit(app, 500); fx(app, 1);
  await app.ctx.refreshPrice('sl1', 'slabs');
  assert.equal(app.ppt().length, 1, 'the graded lookup went to PPT');
  assert.equal(app.tcgdex().length, 0, 'TCGdex has no graded prices, so it is never asked');
  assert.equal(app.row('slabs', 'sl1').marketPrice, '500');
  assert.equal(app.row('slabs', 'sl1').priceHistory[0].source, 'PPT (PSA 10)');
});

test('refresh-price: a row of the Singles table is a single even if its type field says slab, as the queue sees it', async () => {
  const app = await setup({ singles: [singleRow({ type: 'slab', grader: 'PSA', grade: '10', tcgdexId: 'sv3-199' })] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  pptHit(app, 500); fx(app, 1);
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.ppt().length, 0, 'no graded PPT lookup for a Singles row');
  assert.equal(app.row('singles', 's1').marketPrice, '45', 'priced by TCGdex like any other single');
});

test('refresh-price: a Slabs row with no grader is routed as the queue routes it, free lane only, never a fuzzy PPT search', async () => {
  const app = await setup({ slabs: [slabRow({ grader: '', grade: '' })] });
  app.fetchMock.route('api.tcgdex.net', { ok: true, json: [] });
  pptHit(app, 500); fx(app, 1);
  assert.equal(app.ctx._queueLaneFor(app.row('slabs', 'sl1')), 'tcgdex', 'precondition: the queue sends it to the free lane');
  await app.ctx.refreshPrice('sl1', 'slabs');
  assert.ok(app.tcgdex().length >= 1, 'TCGdex was asked');
  assert.equal(app.ppt().length, 0, 'and PPT never was');
  assert.equal(app.row('slabs', 'sl1').marketPrice, '');
});

// A miss is a data outcome. Only a freshly resolved tcgdexId is a change worth syncing, so a pure miss must not queue a phantom upsert.
test('refresh-price: a pure miss changes nothing worth syncing, so it does not markDirty', async () => {
  const app = await setup({ singles: [singleRow()] });
  app.fetchMock.route('api.tcgdex.net', { ok: true, json: [] });
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.row('singles', 's1').priceHistory.length, 0);
  assert.equal(app.dirty('singles', 's1'), false, 'no phantom sync');
  assert.ok(app.toasts.some((t) => /^ERR No price found/.test(t)), 'the miss is still reported');
});

test('refresh-price: a slab PPT miss does not markDirty either', async () => {
  const app = await setup({ slabs: [slabRow()] });
  app.fetchMock.route('/ppt/cards', { ok: true, json: { data: [] } });
  await app.ctx.refreshPrice('sl1', 'slabs');
  assert.equal(app.dirty('slabs', 'sl1'), false);
});

test('refresh-price: a miss that did resolve a tcgdexId still syncs that id', async () => {
  const app = await setup({ singles: [singleRow()] });
  app.fetchMock.route('/en/cards?name=', { ok: true, json: [{ id: 'sv3-199', name: 'Pikachu' }] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { id: 'sv3-199', name: 'Pikachu' } }); // no pricing block, so a miss
  await app.ctx.refreshPrice('s1', 'singles');
  const row = app.row('singles', 's1');
  assert.equal(row.tcgdexId, 'sv3-199', 'the id is cached');
  assert.equal(row.marketPrice, '');
  assert.equal(app.dirty('singles', 's1'), true, 'the new id has to reach the other devices');
});

test('refresh-price: a free-lane miss is stamped _tcgdexMissDate the way the lane stamps it, locally and never synced', async () => {
  const app = await setup({ singles: [singleRow()] });
  app.fetchMock.route('api.tcgdex.net', { ok: true, json: [] });
  await app.ctx.refreshPrice('s1', 'singles');
  const row = app.row('singles', 's1');
  assert.equal(row._tcgdexMissDate, today(), 'stamped with today');
  assert.equal(app.dirty('singles', 's1'), false, 'stamping is not a change to sync');
  assert.equal('_tcgdexMissDate' in app.ctx._stripInternalData(row), false, 'and the cloud payload never carries it');
  assert.ok(app.ctx._kjrUnresolvedSingles().some((r) => r.id === 's1'), 'the unresolved banner now sees a numbered card TCGdex could not match');
  const stored = JSON.parse(app.localStorage.getItem('pokeinventory_v3')).singles.find((r) => r.id === 's1');
  assert.equal(stored._tcgdexMissDate, today(), 'and it is saved locally');
});

test('refresh-price: a slab PPT miss stamps nothing, the marker belongs to the free lane', async () => {
  const app = await setup({ slabs: [slabRow()] });
  app.fetchMock.route('/ppt/cards', { ok: true, json: { data: [] } });
  await app.ctx.refreshPrice('sl1', 'slabs');
  assert.equal('_tcgdexMissDate' in app.row('slabs', 'sl1'), false);
});

test('refresh-price: a successful refresh clears a stale miss marker, as the lane does', async () => {
  const app = await setup({ singles: [singleRow({ tcgdexId: 'sv3-199', _tcgdexMissDate: '2026-10-01' })] });
  app.fetchMock.route('/cards/sv3-199', { ok: true, json: { pricing: { tcgplayer: { holofoil: { marketPrice: 45 } } } } });
  fx(app, 1);
  await app.ctx.refreshPrice('s1', 'singles');
  assert.equal(app.row('singles', 's1').marketPrice, '45');
  assert.ok(!app.row('singles', 's1')._tcgdexMissDate, 'no stale miss left on a priced card');
});

test('refresh-price: after a miss the free lane does not try that card again today, a manual run still does', async () => {
  const app = await setup({ singles: [singleRow()] });
  app.fetchMock.route('api.tcgdex.net', { ok: true, json: [] });
  await app.ctx.refreshPrice('s1', 'singles');
  const q = app.ctx.buildRefreshQueue();
  assert.equal(q.items.filter((i) => i.lane === 'tcgdex').length, 1, 'precondition: the card is in the free lane');
  assert.equal(app.ctx._tcgdexLaneHasWork(q, today()), false, 'a known miss today is not work');
  app.fetchMock.calls.length = 0;
  const auto = await app.ctx._runTcgdexLane(q, false, today());
  assert.equal(auto.skipped, 1, 'the auto pass skips it');
  assert.equal(app.fetchMock.calls.length, 0, 'with zero requests');
  const manual = await app.ctx._runTcgdexLane(q, true, today());
  assert.ok(app.tcgdex().length >= 1, 'a manual "run now" always re-attempts everything');
  assert.equal(manual.failedData, 1);
});

// ═══ bulkRefreshPrices: the same key rule ═══════════════════════════════════════════════════════════
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

test('bulk refresh: slabs with no local PPT key run through the Worker instead of asking for one', async () => {
  const app = await setup({ slabs: [slabRow()] });
  let opened = 0;
  app.ctx.openApiSettings = () => { opened++; };
  app.ctx.kjrConfirm = async () => true;
  assert.equal(app.ctx.getApiKey('ppt'), '', 'precondition: no local key');
  pptHit(app, 500); fx(app, 1);
  await runWithTimerDrain(() => app.ctx.bulkRefreshPrices('slabs'), app.timers);
  assert.ok(!app.toasts.some((t) => /Add API keys first/.test(t)), 'no key nag: ' + JSON.stringify(app.toasts));
  assert.equal(opened, 0, 'the key settings are not thrown open');
  assert.equal(app.ppt().length, 1, 'one PPT request');
  assert.ok(app.ppt()[0].url.startsWith(app.ctx.PRICE_PROXY_BASE + '/ppt/cards'), 'through the Worker, which holds the key');
  assert.equal(app.row('slabs', 'sl1').marketPrice, '500');
  assert.ok(app.toasts.some((t) => /^Done: 1 updated/.test(t)), JSON.stringify(app.toasts));
});

test('bulk refresh: declining the confirm still ends the run before any request', async () => {
  const app = await setup({ slabs: [slabRow()] });
  app.ctx.kjrConfirm = async () => false;
  pptHit(app, 500);
  await app.ctx.bulkRefreshPrices('slabs');
  assert.equal(app.fetchMock.calls.length, 0);
  assert.deepEqual(app.toasts, []);
});
