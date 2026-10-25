'use strict';
// v3.85, stale estimates. Until v3.14 a non-English single was priced by a fuzzy PokemonPriceTracker name search and a wrong card was easy
// to match. On 21/10/2026 the live data held 48 available non-English singles carrying such a price (history entries dated 28/05/2026 to
// 08/07/2026), one of them US$500.99 on a card that cost S$2. The rule is READ only: kjrIsStaleEstimate answers for a row, effectiveMarketInfo
// values a stale row at its cost, and every money aggregate goes through one of the two. The stored marketPrice and history are never
// deleted or rewritten and nothing is ever marked dirty. The Japanese lane replaces a stale price when it finds one unique card.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, jsonResponse, plain } = require('./harness.js');

// the two shapes the live data carries, exactly as they were described
const UMBREON = () => ({
  id: 'u93', name: 'Umbreon ex 93', set: 'Terastal Festival ex', language: 'JP', type: 'raw', condition: 'Near Mint', qty: 1, costPrice: 2,
  marketPrice: '645', listPrice: '', status: 'Available', tcgdexId: 'SV8a-093', notes: '', priceAlert: '',
  priceHistory: [{ ppt: 500.99, date: '2026-06-10', price: 644.63, source: 'PPT', poketrace: null }], // the legacy shape: no unit
});
const LOW_CONF = () => ({
  id: 'lc1', name: 'Pikachu 25', set: 'Base', language: 'JP', type: 'raw', condition: 'Near Mint', qty: 1, costPrice: 8,
  marketPrice: '90', listPrice: '', status: 'Available', tcgdexId: '', notes: '', priceAlert: '',
  priceHistory: [{ date: '2026-06-20', price: 90.12, unit: 'USD', source: 'PPT', confidence: 'low' }], // the shape with a unit and low confidence
});
const row = (o) => Object.assign({
  id: 'r1', name: 'Eevee 1', set: 'Base', language: 'EN', type: 'raw', condition: 'Near Mint', qty: 1, costPrice: 10, marketPrice: '40',
  listPrice: '', status: 'Available', tcgdexId: '', notes: '', priceAlert: '', priceHistory: [],
}, o);
const withHistory = (base, entries, o) => Object.assign({}, base, { priceHistory: entries }, o || {});
const entry = (o) => Object.assign({ date: '2026-06-10', price: 645, unit: 'USD', source: 'PPT' }, o);

// laneOn: this helper forces the Japanese lane OFF unless a test asks for it (the constant PPT_JA_LANE_ENABLED is true since v3.89), so each test names the state it means
async function setup(singles, slabs, laneOn) {
  const app = await loadApp({ jaLane: !!laneOn, seed: { singles: singles || [], slabs: slabs || [] } });
  app.toasts = [];
  app.ctx.toast = (m) => app.toasts.push(String(m));
  app.ctx.toastError = (m) => app.toasts.push('ERR ' + String(m));
  app.dirty = () => [...app.ctx._dirty.singles, ...app.ctx._dirty.slabs];
  app.single = (id) => app.ctx.DB.singles.find((r) => r.id === id);
  return app;
}
const snap = (v) => JSON.stringify(v);

// ── the rule ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('stale-estimate: the two live shapes are stale estimates', async () => {
  const { ctx } = await setup();
  assert.equal(ctx.kjrIsStaleEstimate(UMBREON()), true, '{ppt, date, price, source: PPT, poketrace}, no unit');
  assert.equal(ctx.kjrIsStaleEstimate(LOW_CONF()), true, '{unit: USD, source: PPT, confidence: low}');
});

test('stale-estimate: a stale estimate is valued at its cost and says so, nothing else changes shape', async () => {
  const { ctx } = await setup();
  assert.deepEqual(plain(ctx.effectiveMarketInfo(UMBREON())), { value: 2, isEstimate: true, stale: true });
  assert.deepEqual(plain(ctx.effectiveMarketInfo(LOW_CONF())), { value: 8, isEstimate: true, stale: true });
  assert.deepEqual(plain(ctx.effectiveMarketInfo(Object.assign(UMBREON(), { costPrice: '' }))), { value: 0, isEstimate: true, stale: true }, 'no cost either: nothing to count');
  assert.deepEqual(plain(ctx.effectiveMarketInfo(row())), { value: 40, isEstimate: false }, 'a normal row is exactly what it was, no new key');
  assert.deepEqual(plain(ctx.effectiveMarketInfo(row({ marketPrice: '' }))), { value: 10, isEstimate: true }, 'and so is an unpriced one');
  assert.equal(ctx.effectiveMarket(UMBREON()), 2);
  assert.ok(Number.isNaN(ctx.kjrLiveMarketPrice(UMBREON())), 'the counted market price of a stale estimate is none');
  assert.equal(ctx.kjrLiveMarketPrice(row()), 40);
  assert.ok(Number.isNaN(ctx.kjrLiveMarketPrice(row({ marketPrice: '' }))));
  assert.ok(Number.isNaN(ctx.kjrLiveMarketPrice(null)));
});

test('stale-estimate: the cutoff is 08/07/2026, the old source name is "PPT" exactly, and the legacy shape is stale at any date', async () => {
  const { ctx } = await setup();
  const jp = (e) => ctx.kjrIsStaleEstimate(withHistory(UMBREON(), [e]));
  assert.equal(jp(entry({ date: '2026-05-28' })), true, 'the oldest of the 48');
  assert.equal(jp(entry({ date: '2026-07-08' })), true, 'on the cutoff day');
  assert.equal(jp(entry({ date: '2026-07-09' })), false, 'the day after');
  assert.equal(jp(entry({ date: '2026-10-21' })), false, 'a bare PPT entry written today is not this problem');
  assert.equal(jp({ ppt: 12, date: '2026-09-01', price: 645, source: 'PPT' }), true, 'the legacy ppt key with no unit is stale whatever its date');
  assert.equal(jp({ ppt: 12, date: '2026-09-01', price: 645, source: 'PPT', unit: 'USD' }), false, 'with a unit it is the new shape');
  assert.equal(jp({ ppt: 645, price: 645 }), true, 'no source, no date, only the legacy key');
  assert.equal(jp(entry({ date: '8 Jun' })), true, 'a legacy day-month label is read, 8 June is before the cutoff');
  assert.equal(jp(entry({ date: 'garbled' })), true, 'a date that can not be read on an old-style PPT entry counts as old');
  assert.equal(jp(entry({ date: undefined })), true);
  assert.equal(jp(entry({ source: 'PPT (Japanese)' })), false, 'the Japanese lane\'s own source is never stale, whatever the date');
  assert.equal(jp(entry({ source: 'PPT (PSA 10)', date: '2026-06-01' })), false);
  assert.equal(jp(entry({ source: 'ppt ' })), true, 'case and spaces do not hide the old name... ');
  assert.equal(jp(entry({ source: 'TCGdex (TCGplayer)' })), false);
  assert.equal(jp(entry({ source: 'manual' })), false);
  assert.equal(jp(entry({ source: '' })), false);
  assert.equal(jp(entry({ source: null })), false);
});

test('stale-estimate: rule 4, a newer PPT entry written by the new Japanese lane (after 08/07/2026, with a unit) is not stale', async () => {
  const { ctx } = await setup();
  const fresh = { date: '2026-10-21', price: 25, unit: 'USD', source: 'PPT (Japanese)', confidence: 'medium' };
  assert.equal(ctx.kjrIsStaleEstimate(withHistory(UMBREON(), [UMBREON().priceHistory[0], fresh], { marketPrice: '25' })), false);
  assert.deepEqual(plain(ctx.effectiveMarketInfo(withHistory(UMBREON(), [fresh], { marketPrice: '25' }))), { value: 25, isEstimate: false });
});

test('stale-estimate: only non-English singles, an English single with the same old PPT entry is untouched', async () => {
  const { ctx } = await setup();
  for (const language of ['EN', 'en', '', ' EN ', undefined, null]) {
    const en = Object.assign(UMBREON(), { language });
    assert.equal(ctx.kjrIsStaleEstimate(en), false, JSON.stringify(language));
    assert.deepEqual(plain(ctx.effectiveMarketInfo(en)), { value: 645, isEstimate: false }, 'it keeps its price: ' + JSON.stringify(language));
  }
  for (const language of ['JP', 'jp', 'CN', 'ID', 'KR', 'TH']) {
    assert.equal(ctx.kjrIsStaleEstimate(Object.assign(UMBREON(), { language })), true, language);
  }
  const slab = Object.assign(UMBREON(), { grader: 'PSA', grade: '10' });
  assert.equal(ctx.kjrIsStaleEstimate(slab), false, 'a slab\'s PPT price is its graded eBay price');
  assert.equal(ctx.kjrIsStaleEstimate(Object.assign(UMBREON(), { grader: '', grade: 'PSA 10' })), false, 'and so is one with the grade typed alone');
  assert.equal(ctx.kjrIsStaleEstimate({ marketPrice: 645, costPrice: 2, priceHistory: UMBREON().priceHistory }), false, 'a sealed row (no language) is not a non-English single');
  assert.deepEqual(plain(ctx.effectiveMarketInfo({ marketPrice: 50, costPrice: 20 })), { value: 50, isEstimate: false });
});

test('stale-estimate: only the LATEST history entry counts, a newer entry of any other kind clears it', async () => {
  const { ctx } = await setup();
  const old = UMBREON().priceHistory[0];
  const newer = (e, mp) => withHistory(UMBREON(), [old, e], { marketPrice: mp });
  assert.equal(ctx.kjrIsStaleEstimate(newer({ date: '2026-09-01', price: 20, source: 'manual' }, '20')), false, 'a hand edit of the inline cell');
  assert.equal(ctx.kjrIsStaleEstimate(newer({ date: '2026-10-21', price: 25, unit: 'USD', source: 'PPT (Japanese)' }, '25')), false, 'the Japanese lane');
  assert.equal(ctx.kjrIsStaleEstimate(withHistory(UMBREON(), [{ date: '2026-06-01', price: 1, source: 'manual' }, old])), true, 'the stale one is last');
  for (const h of [[], undefined, null, 'x', {}, [null], [undefined], [42], ['x']]) {
    assert.equal(ctx.kjrIsStaleEstimate(Object.assign(UMBREON(), { priceHistory: h })), false, 'no readable latest entry: ' + JSON.stringify(h));
  }
  assert.equal(ctx.kjrIsStaleEstimate(null), false);
  assert.equal(ctx.kjrIsStaleEstimate(undefined), false);
  assert.equal(ctx.kjrIsStaleEstimate('x'), false);
});

test('stale-estimate: a price the owner has typed since is theirs and counts, the stale one is only the price that entry wrote', async () => {
  const { ctx } = await setup();
  const at = (marketPrice) => ctx.kjrIsStaleEstimate(Object.assign(UMBREON(), { marketPrice }));
  assert.equal(at('645'), true, 'the rounded SGD the entry wrote');
  assert.equal(at(645), true, 'as a number');
  assert.equal(at('644.63'), true);
  assert.equal(at('644'), true, 'within S$1');
  assert.equal(at('500.99'), true, 'the entry\'s own USD figure');
  assert.equal(at('501'), true);
  assert.equal(at('646'), false, 'S$1.37 away: an edit');
  assert.equal(at('12'), false, 'the edit form saves a typed price with no history entry, and this one is the owner\'s');
  assert.equal(at('2'), false);
  assert.equal(at(''), false, 'no price, nothing to ignore');
  assert.equal(at('abc'), false);
  assert.equal(at(0), false);
  // an entry with no number of its own to compare is taken as the writer
  const bare = (mp) => ctx.kjrIsStaleEstimate(withHistory(LOW_CONF(), [{ date: '2026-06-20', unit: 'USD', source: 'PPT', confidence: 'low' }], { marketPrice: mp }));
  assert.equal(bare('90'), true);
  assert.equal(bare('5'), true);
});

test('stale-estimate: the rule only reads, rows, history and the dirty set are untouched', async () => {
  const app = await setup([UMBREON(), LOW_CONF(), row()]);
  const { ctx } = app;
  const before = snap(ctx.DB.singles), storage = snap([...app.localStorage._store.entries()]);
  const saved = [], marked = [];
  const realSave = ctx.saveData, realMark = ctx.markDirty;
  ctx.saveData = (...a) => { saved.push(a); return realSave.apply(ctx, a); };
  ctx.markDirty = (...a) => { marked.push(a); return realMark.apply(ctx, a); };
  for (const r of ctx.DB.singles) { ctx.kjrIsStaleEstimate(r); ctx.effectiveMarketInfo(r); ctx.kjrLiveMarketPrice(r); ctx.bestMarketFor(r); }
  ctx.computeDashboardStats(); ctx.kjrOvExposureStats(); ctx.kjrOverviewTop(5); ctx.kjrOverviewMovers(); ctx._buildAnalystSnapshot();
  ctx.renderDashboard(); ctx.renderSingles(); ctx.showMarketValueBreakdown();
  ctx.saveData = realSave; ctx.markDirty = realMark;
  assert.equal(snap(ctx.DB.singles), before, 'every row is exactly as it was, marketPrice and history included');
  assert.deepEqual(marked, [], 'nothing was marked dirty, so nothing can reach sync');
  assert.deepEqual(app.dirty(), []);
  assert.deepEqual(saved, [], 'and nothing was saved');
  assert.equal(snap([...app.localStorage._store.entries()].filter(([k]) => k === 'pokeinventory_v3' || k === 'pokeinventory_version')), snap([...JSON.parse(storage)].filter(([k]) => k === 'pokeinventory_v3' || k === 'pokeinventory_version')), 'the stored data is as it was');
});

// ── the money aggregates ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

// a stale JP card (S$645 stored, cost 2), a JP card priced by the new lane (S$30, cost 10), an English card with an old PPT entry (S$50,
// cost 20, counted), an English card (S$40, cost 10) and a slab (S$150, cost 100)
function inventory() {
  const fresh = row({ id: 'j2', name: 'Mew 151', language: 'JP', costPrice: 10, marketPrice: '30', priceHistory: [{ date: '2026-10-20', price: 30, unit: 'USD', source: 'PPT (Japanese)', confidence: 'medium' }] });
  const enOld = row({ id: 'e2', name: 'Eevee 2', costPrice: 20, marketPrice: '50', priceHistory: [{ date: '2026-06-10', price: 50, unit: 'USD', source: 'PPT', confidence: 'low' }] });
  const en = row({ id: 'e1', name: 'Eevee 1', costPrice: 10, marketPrice: '40' });
  const slab = { id: 'sl1', name: 'Charizard 4', grader: 'PSA', grade: '10', language: 'EN', certNo: '', costPrice: 100, marketPrice: 150, listPrice: '', status: 'Available', priceHistory: [] };
  return { singles: [UMBREON(), fresh, enOld, en], slabs: [slab] };
}

test('stale-estimate: the Overview total counts the stale card at its cost, not at S$645', async () => {
  const inv = inventory();
  const app = await setup(inv.singles, inv.slabs);
  const { ctx, document } = app;
  const stats = ctx.computeDashboardStats();
  assert.equal(stats.totalMktValue, 2 + 30 + 50 + 40 + 150, '272, not 917');
  ctx.renderDashboard();
  assert.match(document.getElementById('dash-hero').innerHTML, /class="ov-hero-value">S\$272</, 'the hero reads the same number');
  // the same card with a fresh price counts that price: the total moves by exactly the difference
  const priced = withHistory(UMBREON(), [{ date: '2026-10-21', price: 25, unit: 'USD', source: 'PPT (Japanese)', confidence: 'medium' }], { marketPrice: '25' });
  ctx.DB.singles[0] = priced;
  assert.equal(ctx.computeDashboardStats().totalMktValue, 25 + 30 + 50 + 40 + 150);
});

test('stale-estimate: Where the money sits counts it as estimated, never as priced', async () => {
  const inv = inventory();
  const { ctx } = await setup(inv.singles, inv.slabs);
  const ex = plain(ctx.kjrOvExposureStats());
  const singles = ex.buckets ? ex.buckets.find((b) => b.key === 'singles') : ex.singles;
  assert.equal(singles.market, 2 + 30 + 50 + 40);
  assert.equal(singles.priced, 30 + 50 + 40, 'the three real prices');
  assert.equal(singles.estimated, 2, 'the stale card at its cost');
  assert.ok(singles.pricedPct < 100);
});

test('stale-estimate: Most valuable ranks it by its cost, and best and worst against cost leave it out', async () => {
  const inv = inventory();
  const { ctx } = await setup(inv.singles, inv.slabs);
  const top = plain(ctx.kjrOverviewTop(10)).map((r) => [r.item.id, r.value]);
  assert.deepEqual(top, [['sl1', 150], ['e2', 50], ['e1', 40], ['j2', 30], ['u93', 2]], 'it is the last, at S$2, not the first at S$645');
  const movers = plain(ctx.kjrOverviewMovers());
  const ids = movers.list.map((r) => r.item.id);
  assert.ok(!ids.includes('u93'), 'a stale price is no gain: it would have been +32,150%');
  assert.deepEqual(ids.sort(), ['e1', 'e2', 'j2'], 'the three best gains, as the Overview lists up to three');
});

test('stale-estimate: the coverage line does not count a stale card as priced', async () => {
  const inv = inventory();
  const { ctx, document } = await setup(inv.singles, inv.slabs);
  ctx.renderDashboard();
  const title = document.getElementById('dash-sub').title;
  assert.match(title, /80% priced \(4\/5\)/, '4 of the 5 are priced, the stale one is not');
  assert.match(document.getElementById('dash-last-updated').textContent, /· 80% priced$/);
});

test('stale-estimate: the value breakdown agrees with the headline, listing the card at cost with the reason', async () => {
  const inv = inventory();
  const { ctx, document } = await setup(inv.singles, inv.slabs);
  ctx.showMarketValueBreakdown();
  const html = document.body._lastInsertedHTML;
  assert.match(html, /cost basis \(old price not counted\)/);
  assert.match(html, /Total here must equal Collection value on the Overview: <strong>S\$272<\/strong>/);
  assert.doesNotMatch(html, /645/);
});

test('stale-estimate: the Singles table shows it as a cost estimate with the reason, trips no alert and is not found by a market filter', async () => {
  const stale = Object.assign(UMBREON(), { priceAlert: '100' });
  const normal = row({ id: 'n1', name: 'Eevee 1', marketPrice: '150', priceAlert: '100' }); // 150 passes a 100 alert
  const { ctx, document } = await setup([stale, normal]);
  ctx.renderSingles();
  const body = document.getElementById('singles-body').innerHTML;
  const rowOf = (id) => body.split('<tr ').find((chunk) => chunk.includes('data-id="' + id + '"')) || '';
  const staleRow = rowOf('u93'), normalRow = rowOf('n1');
  assert.match(staleRow, /value="~\$2"/, 'the leading ~ marks an estimate, not colour alone');
  assert.match(staleRow, /title="Estimated from cost price, the stored price is an old PokemonPriceTracker match that is not counted"/);
  assert.doesNotMatch(staleRow, /🔔/, 'S$645 is not above the S$100 alert as a real price would be');
  assert.match(normalRow, /🔔/, 'control: a real S$150 price does trip it');
  assert.doesNotMatch(staleRow, /645/);
  document.getElementById('sf-mkt').value = '>100';
  ctx.renderSingles();
  const filtered = document.getElementById('singles-body').innerHTML;
  assert.ok(!filtered.includes('data-id="u93"'), 'a market filter of >100 does not find the stale S$645');
  assert.ok(filtered.includes('data-id="n1"'));
});

test('stale-estimate: a stale card with no cost is an empty cell that says why, a counted price stays silent', async () => {
  const why = 'The stored price is an old PokemonPriceTracker match that is not counted';
  const noCost = Object.assign(UMBREON(), { id: 'nc1', costPrice: '' });                                    // Japanese with a number, not asked yet
  const missed = Object.assign(UMBREON(), { id: 'nc2', costPrice: '', _tcgdexMissDate: '2026-10-20' });    // asked, no unique card
  const korean = Object.assign(UMBREON(), { id: 'nc3', costPrice: '', language: 'KR' });                    // no lane at all
  // the lane is forced off here (the default of setup), so every non-English card gets the same reason, whichever language it is
  const { ctx, document } = await setup([noCost, missed, korean, row({ id: 'n1' })]);
  assert.equal(ctx._mktEmptyCellTitle(ctx.DB.singles[0]), why, 'nothing else to say, so it says that');
  assert.equal(ctx._mktEmptyCellTitle(ctx.DB.singles[1]), why, 'a miss stamp means nothing while the lane is off');
  assert.equal(ctx._mktEmptyCellTitle(ctx.DB.singles[2]), why, 'and a Korean card has the same blank cell, the same reason');
  assert.equal(ctx._mktEmptyCellTitle(ctx.DB.singles[3]), '', 'a counted price needs no explanation');
  assert.equal(ctx._mktEmptyCellTitle(Object.assign(UMBREON(), { priceHistory: [entry({ date: '2026-10-21', source: 'PPT (Japanese)' })] })), '', 'and a stale price the lane has replaced is no longer stale');
  ctx.renderSingles();
  const body = document.getElementById('singles-body').innerHTML;
  const rowOf = (id) => body.split('<tr ').find((chunk) => chunk.includes('data-id="' + id + '"')) || '';
  const mktCell = (id) => (rowOf(id).match(/<td data-col-key="marketPrice"[^>]*>[\s\S]*?<\/td>/) || [''])[0];
  assert.match(mktCell('nc1'), new RegExp('title="' + why + '"'), 'the Singles cell carries the reason');
  assert.match(mktCell('nc1'), /value=""/, 'and shows no price');
  assert.doesNotMatch(mktCell('nc1'), /645/);
  assert.doesNotMatch(mktCell('n1'), /title="/, 'control: a normal priced cell has no title');
  assert.equal(ctx.effectiveMarketInfo(ctx.DB.singles[0]).value, 0, 'nothing is counted for it');
  // with the lane on, a Japanese card the lane asked about and found no unique card for says that, which is more to the point
  const on = await setup([Object.assign({}, missed), Object.assign({}, noCost), Object.assign({}, korean)], [], true);
  assert.equal(on.ctx._mktEmptyCellTitle(on.ctx.DB.singles[0]), 'No unique match on PokemonPriceTracker, check the name and number');
  assert.equal(on.ctx._mktEmptyCellTitle(on.ctx.DB.singles[1]), why, 'not asked yet: the stale reason');
  assert.equal(on.ctx._mktEmptyCellTitle(on.ctx.DB.singles[2]), why);
});

test('stale-estimate: the grid tile, the card inspector and the sort treat it as an estimate', async () => {
  const { ctx } = await setup([UMBREON(), row({ id: 'n1', marketPrice: '5', costPrice: 1 })]);
  const tile = ctx.kjrTileHtml(ctx.DB.singles[0], 'singles', false);
  assert.match(tile, /~S\$2|~\$2/);
  assert.doesNotMatch(tile, /645/);
  assert.equal(ctx.kjrInspectPriceLine('singles', ctx.DB.singles[0], Date.now()), 'Old PokemonPriceTracker match, counted at cost until it is priced again');
  const sorted = ctx.sortItems(ctx.DB.singles.slice(), 'singles');
  assert.ok(sorted.length === 2);
  ctx.sortState.singles.col = 'marketPrice'; ctx.sortState.singles.dir = -1;
  assert.deepEqual(plain(ctx.sortItems(ctx.DB.singles.slice(), 'singles').map((r) => r.id)), ['n1', 'u93'], 'by what the cell shows: S$5 above S$2');
});

test('stale-estimate: the quick-sale pre-fill, the listing editor and the AI snapshot do not use it', async () => {
  const app = await setup([Object.assign(UMBREON(), { listPrice: '30' }), Object.assign(LOW_CONF(), { listPrice: '' }), row()], []);
  const { ctx, document } = app;
  assert.equal(ctx.bestMarketFor(ctx.DB.singles[0]), 30, 'the list price stands in for the stale market price');
  assert.equal(ctx.bestMarketFor(ctx.DB.singles[1]), '', 'no list price either: nothing to pre-fill, never S$90 from the old match');
  assert.equal(ctx.bestMarketFor(ctx.DB.singles[2]), 40, 'control');
  ctx.openListingFor('singles', 'u93');
  assert.equal(document.getElementById('lst-market').value, '-', 'the listing\'s market field shows no market price');
  ctx.openListingFor('singles', 'r1');
  assert.equal(document.getElementById('lst-market').value, 'S$40');
  const snap2 = ctx._buildAnalystSnapshot();
  const find = (name) => plain(snap2.singles || snap2.inventory.singles).find((s) => s.name === name);
  assert.equal(find('Umbreon ex 93').market_sgd, 0, 'sent as unpriced');
  assert.equal(find('Umbreon ex 93').cost_sgd, 2);
  assert.equal(find('Eevee 1').market_sgd, 40);
  const totals = snap2.totals || snap2.summary || {};
  if ('market_singles_sgd' in totals) assert.equal(totals.market_singles_sgd, 2 + 8 + 40, 'the AI\'s total counts the two stale cards at cost');
});

// ── the Japanese lane clears it ───────────────────────────────────────────────────────────────────────────────────────────────────────

const WAITS = [6000, 250, 1100];
async function drain(fn, timers) {
  const p = fn();
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 100 && !done; i++) {
    await new Promise((r) => setImmediate(r));
    timers.flush((e) => WAITS.includes(e.delay));
  }
  return p;
}
const jpCard = (o) => Object.assign({ id: 'jp-93', name: 'Umbreon ex', cardNumber: '093/187', setName: 'SV8a: Terastal Fest ex', language: 'Japanese', prices: { market: 12.5 } }, o); // the vendor's setName is the set code, a colon, the set name (v3.89)
const answer = (cards) => jsonResponse({ data: cards, metadata: { apiCallsConsumed: { total: 3 } } });
async function lane(rows, cards) {
  const app = await setup(rows, [], true);
  app.fetchMock.route('base=USD', { ok: true, json: [{ quote: 'SGD', rate: 2 }] });
  app.fetchMock.route('/ppt/cards', () => answer(cards));
  app.fetchMock.calls.length = 0;
  return app;
}

test('stale-estimate: a unique Japanese match replaces the stale price, with a history entry, and the flag clears', async () => {
  const app = await lane([UMBREON()], [jpCard()]);
  const { ctx } = app;
  assert.equal(ctx.kjrIsStaleEstimate(app.single('u93')), true, 'precondition');
  await drain(() => ctx.runRefreshQueue(false), app.timers);
  const r = app.single('u93');
  assert.equal(r.marketPrice, '25', '12.5 USD at 2');
  assert.equal(r.priceHistory.length, 2, 'the old entry is kept, the new one added');
  assert.deepEqual(plain(r.priceHistory[0]), plain(UMBREON().priceHistory[0]), 'the old entry untouched');
  assert.deepEqual(plain(r.priceHistory[1]), { date: new Date().toISOString().slice(0, 10), price: 25, unit: 'USD', source: 'PPT (Japanese)', confidence: 'medium' });
  assert.equal(ctx.kjrIsStaleEstimate(r), false);
  assert.deepEqual(plain(ctx.effectiveMarketInfo(r)), { value: 25, isEstimate: false });
  assert.equal(ctx.computeDashboardStats().totalMktValue, 25);
  assert.equal(app.ctx._dirty.singles.has('u93'), true, 'a real price change syncs, as any other');
});

test('stale-estimate: a fresh price EQUAL to the stale one still writes its history entry, so the flag clears', async () => {
  const app = await lane([Object.assign(UMBREON(), { marketPrice: '25', priceHistory: [{ ppt: 12.5, date: '2026-06-10', price: 25, source: 'PPT', poketrace: null }] })], [jpCard()]);
  const { ctx } = app;
  assert.equal(ctx.kjrIsStaleEstimate(app.single('u93')), true);
  await drain(() => ctx.runRefreshQueue(false), app.timers);
  const r = app.single('u93');
  assert.equal(r.priceHistory.length, 2, 'not skipped as a same-value re-price');
  assert.equal(r.priceHistory[1].source, 'PPT (Japanese)');
  assert.equal(ctx.kjrIsStaleEstimate(r), false);
  assert.equal(ctx.effectiveMarketInfo(r).value, 25);
  assert.equal(ctx.effectiveMarketInfo(r).isEstimate, false, 'counted as priced now');
  // the same through the inspector button and the bulk path
  for (const how of ['refresh', 'bulk']) {
    const a = await lane([Object.assign(UMBREON(), { marketPrice: '25', priceHistory: [{ ppt: 12.5, date: '2026-06-10', price: 25, source: 'PPT', poketrace: null }] })], [jpCard()]);
    if (how === 'refresh') await a.ctx.refreshPrice('u93', 'singles');
    else { a.ctx.kjrConfirm = async () => true; await drain(() => a.ctx.bulkRefreshPrices('singles'), a.timers); }
    assert.equal(a.single('u93').priceHistory.length, 2, how);
    assert.equal(a.ctx.kjrIsStaleEstimate(a.single('u93')), false, how);
  }
});

test('stale-estimate: rule 3, when the Japanese lane finds no match the card stays on its cost, never on the old price', async () => {
  for (const [label, cards] of [['no card', []], ['two cards', [jpCard({ id: 'a' }), jpCard({ id: 'b', setName: 'SV8a: Other' })]], ['another number', [jpCard({ cardNumber: '094/187' })]]]) {
    const app = await lane([UMBREON()], cards);
    const before = snap(app.single('u93'));
    await drain(() => app.ctx.runRefreshQueue(false), app.timers);
    const r = app.single('u93');
    assert.equal(r.marketPrice, '645', label + ': the stored price is not touched');
    assert.equal(r.priceHistory.length, 1, label + ': no history entry written');
    assert.equal(app.ctx.kjrIsStaleEstimate(r), true, label);
    assert.deepEqual(plain(app.ctx.effectiveMarketInfo(r)), { value: 2, isEstimate: true, stale: true }, label + ': it stays on cost');
    assert.equal(app.ctx.computeDashboardStats().totalMktValue, 2, label);
    assert.equal(r._tcgdexMissDate, app.ctx.kjrLocalDay(), label + ': and is listed as unmatched');
    assert.equal(snap(Object.assign({}, r, { _tcgdexMissDate: undefined })), snap(Object.assign(JSON.parse(before), { _tcgdexMissDate: undefined })), label + ': nothing else about the row changed');
    assert.equal(app.ctx._dirty.singles.has('u93'), false, label + ': nothing syncs');
  }
});

test('stale-estimate: Chinese and Indonesian cards are never replaced by the Japanese lane, even with it on, they stay on cost', async () => {
  // their numbering does not reliably match the Japanese sets, a wrong card's price is worse than none
  for (const language of ['CN', 'ID']) {
    const app = await lane([Object.assign(UMBREON(), { language })], [jpCard()]);
    const before = snap(app.single('u93'));
    await drain(() => app.ctx.runRefreshQueue(false), app.timers);
    await app.ctx.refreshPrice('u93', 'singles');
    assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards')).length, 0, language + ': nothing was asked of the vendor');
    assert.equal(snap(app.single('u93')), before, language + ': the row is exactly as it was');
    assert.equal(app.ctx.kjrIsStaleEstimate(app.single('u93')), true, language);
    assert.deepEqual(plain(app.ctx.effectiveMarketInfo(app.single('u93'))), { value: 2, isEstimate: true, stale: true }, language + ': still on cost');
    assert.equal(app.ctx._dirty.singles.has('u93'), false);
  }
});

test('stale-estimate: with the lane off, as v3.85 ships, a stale card stays on its cost, nothing is asked and nothing replaces the old price', async () => {
  const app = await setup([UMBREON(), LOW_CONF()]);
  app.fetchMock.route('/ppt/cards', () => answer([jpCard()]));
  app.fetchMock.calls.length = 0;
  const before = snap(app.ctx.DB.singles);
  await drain(() => app.ctx.runRefreshQueue(true), app.timers);
  await app.ctx.refreshPrice('u93', 'singles');
  assert.equal(app.fetchMock.calls.filter((c) => c.url.includes('/ppt/cards')).length, 0, 'not one PPT request');
  assert.equal(snap(app.ctx.DB.singles), before, 'the stored prices and histories are exactly as they were');
  assert.equal(app.ctx._dirty.singles.size, 0, 'and nothing syncs');
  assert.deepEqual(plain(app.ctx.effectiveMarketInfo(app.single('u93'))), { value: 2, isEstimate: true, stale: true });
  assert.deepEqual(plain(app.ctx.effectiveMarketInfo(app.single('lc1'))), { value: 8, isEstimate: true, stale: true });
  assert.equal(app.ctx.computeDashboardStats().totalMktValue, 2 + 8, 'the headline counts both at cost');
  // the owner's own price still clears it, as before
  app.ctx.updateField('singles', 'u93', 'marketPrice', '30');
  assert.equal(app.ctx.kjrIsStaleEstimate(app.single('u93')), false);
  assert.equal(app.ctx.computeDashboardStats().totalMktValue, 30 + 8);
});

test('stale-estimate: a Korean card (no lane) stays on cost until the owner types a price, which then counts', async () => {
  const app = await setup([Object.assign(LOW_CONF(), { language: 'KR' })]);
  const { ctx } = app;
  assert.equal(ctx.computeDashboardStats().totalMktValue, 8, 'at cost');
  ctx.updateField('singles', 'lc1', 'marketPrice', '12'); // the inline cell: a manual history entry
  assert.equal(app.single('lc1').priceHistory.slice(-1)[0].source, 'manual');
  assert.equal(ctx.kjrIsStaleEstimate(app.single('lc1')), false);
  assert.equal(ctx.computeDashboardStats().totalMktValue, 12);
  // and through the edit form, which keeps the history as it was: the price differs from what the old entry wrote
  const b = await setup([Object.assign(LOW_CONF(), { language: 'KR' })]);
  b.single('lc1').marketPrice = 15;
  assert.equal(b.ctx.kjrIsStaleEstimate(b.single('lc1')), false);
  assert.equal(b.ctx.computeDashboardStats().totalMktValue, 15, 'a price typed in the edit form counts');
  assert.equal(b.single('lc1').priceHistory.length, 1, 'the history was not rewritten');
});

test('stale-estimate: an English single with an old PPT entry is not affected anywhere', async () => {
  const enOld = row({ id: 'e2', name: 'Eevee 2', costPrice: 20, marketPrice: '645', priceAlert: '100', priceHistory: [{ ppt: 500.99, date: '2026-06-10', price: 644.63, source: 'PPT', poketrace: null }] });
  const { ctx, document } = await setup([enOld]);
  assert.equal(ctx.kjrIsStaleEstimate(enOld), false);
  assert.equal(ctx.computeDashboardStats().totalMktValue, 645);
  assert.equal(plain(ctx.kjrOverviewTop(1))[0].value, 645);
  assert.deepEqual(plain(ctx.kjrOverviewMovers().list.map((r) => r.item.id)), ['e2']);
  ctx.renderSingles();
  const html = document.getElementById('singles-body').innerHTML;
  assert.match(html, /value="\$645"/);
  assert.match(html, /🔔/);
  assert.equal(ctx.bestMarketFor(enOld), 645);
});
