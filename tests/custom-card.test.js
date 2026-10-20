'use strict';
// The "Custom card" flag on a single: customCard === true says "this card has no TCGdex match by design". It is a synced field of the
// row (no underscore, jsonb data, no schema change). It only means "do not auto-match, do not nag": the pricing lane is 'manual', the
// card leaves the unmatched banner and the "needs a card number" counts, and valuation is untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {
  loadApp, makeSeed, plain, jsonResponse, syncRequest, syncSuccessResponse, syncOperations, ROOT,
} = require('./harness.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');

const single = (id, name, extra) => Object.assign({
  id, name, set: '', language: 'EN', type: 'raw', condition: 'Near Mint', qty: 1, costPrice: 10, marketPrice: '',
  listPrice: '', datePurchased: '1 Sep 2026', status: 'Available', notes: '', priceAlert: '', tcgdexId: '', priceHistory: [],
}, extra || {});
const rowOf = (ctx, id) => ctx.DB.singles.find((r) => r.id === id);
const TODAY = () => new Date().toISOString().slice(0, 10);

// Three unmatched cards (a name with no number, a name with a number that TCGdex could not match, one with a set) and four that are not.
const unmatchedSeed = () => ({
  singles: [
    single('u1', 'Umbreon Custom Card'),
    single('u2', 'Zard Custom 5', { _tcgdexMissDate: '2026-10-01' }),
    single('u3', 'Foo Custom', { set: 'Fan Set' }),
    single('ok', 'Pikachu 25'),
    single('jp', 'Pikachu 25', { language: 'JP' }),
    single('id', 'Mew', { tcgdexId: 'base1-8' }),
    single('sold', 'Sold Custom', { status: 'Sold' }),
  ],
});

const clickOf = (attrs) => {
  const holder = { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
  return { type: 'click', target: { closest: () => holder } };
};
const act = (app, name, id) => app.document.getElementById('kjr-custom-overlay').dispatchEvent(clickOf({ 'data-cr-act': name, 'data-cr-id': id }));

// ── the flag ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('custom-card: only a boolean true is a flag', async () => {
  const { ctx } = await loadApp();
  assert.equal(ctx.kjrIsCustomCard({ customCard: true }), true);
  for (const v of [false, 'true', 'false', 1, 0, null, undefined, {}, []]) assert.equal(ctx.kjrIsCustomCard({ customCard: v }), false, String(v));
  assert.equal(ctx.kjrIsCustomCard(null), false);
  assert.equal(ctx.kjrIsCustomCard(undefined), false);
  assert.equal(ctx.kjrIsCustomCard({}), false);
});

test('custom-card: the lane is manual, whatever the name, language or a cached id say, and slabs are untouched', async () => {
  const { ctx } = await loadApp();
  assert.equal(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'EN' }), 'tcgdex', 'precondition');
  assert.equal(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'EN', customCard: true }), 'manual', 'a numbered English card');
  assert.equal(ctx._queueLaneFor({ name: 'Anything', language: 'EN', tcgdexId: 'base1-58', customCard: true }), 'manual', 'an art lookup can hand a custom card an id, the flag still wins');
  assert.equal(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'JP', customCard: true }), 'manual');
  assert.equal(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'EN', customCard: 'true' }), 'tcgdex', 'a string is not the flag');
  assert.equal(ctx._queueLaneFor({ name: 'Charizard', grader: 'PSA', grade: '10', language: 'EN', customCard: true }), 'ppt', 'the flag is for singles, a slab stays the PPT lane');
});

test('custom-card: a custom card is out of the unmatched list, whatever stale miss stamp it carries', async () => {
  const { ctx } = await loadApp({ seed: unmatchedSeed() });
  assert.deepStrictEqual(plain(ctx._kjrUnresolvedSingles().map((r) => r.id).sort()), ['u1', 'u2', 'u3']);
  rowOf(ctx, 'u1').customCard = true;
  rowOf(ctx, 'u2').customCard = true; // carries _tcgdexMissDate from before it was flagged
  assert.deepStrictEqual(plain(ctx._kjrUnresolvedSingles().map((r) => r.id)), ['u3']);
  assert.equal(rowOf(ctx, 'u2')._tcgdexMissDate, '2026-10-01', 'the local stamp is left alone, only the flag decides');
});

test('custom-card: the banner count drops, and the banner is gone at zero', async () => {
  const { ctx, document } = await loadApp({ seed: unmatchedSeed() });
  const banner = document.getElementById('singles-unresolved-banner');
  const text = () => document.getElementById('singles-unresolved-text').textContent;
  ctx.renderSingles();
  assert.equal(banner.classList.contains('show'), true);
  assert.match(text(), /^3 cards could not be matched automatically\./);
  rowOf(ctx, 'u1').customCard = true;
  ctx.renderSingles();
  assert.match(text(), /^2 cards could not be matched automatically\./);
  rowOf(ctx, 'u2').customCard = true;
  ctx.renderSingles();
  assert.match(text(), /^1 card could not be matched automatically\./);
  rowOf(ctx, 'u3').customCard = true;
  ctx.renderSingles();
  assert.equal(banner.classList.contains('show'), false, 'nothing left to flag, no banner');
});

test('custom-card: the Overview "needs a card number" count drops with it', async () => {
  const { ctx, document } = await loadApp({ seed: unmatchedSeed() });
  const hero = () => document.getElementById('dash-hero').innerHTML;
  ctx.renderDashboard();
  assert.match(hero(), /3 cards need a card number/);
  rowOf(ctx, 'u1').customCard = true;
  ctx.renderDashboard();
  assert.match(hero(), /2 cards need a card number/);
  rowOf(ctx, 'u2').customCard = true;
  rowOf(ctx, 'u3').customCard = true;
  ctx.renderDashboard();
  assert.doesNotMatch(hero(), /need a card number|needs a card number/, 'the row is gone, not a zero');
});

test('custom-card: the queue leaves a custom card out and does not let a plain duplicate copy a price onto it, or take its lane', async () => {
  const { ctx } = await loadApp({
    seed: { singles: [single('c1', 'Pikachu 25', { costPrice: 20, customCard: true }), single('p1', 'Pikachu 25', { costPrice: 10 })] },
  });
  const q = plain(ctx.buildRefreshQueue());
  assert.deepStrictEqual(q.items.map((i) => i.id), ['p1'], 'only the plain card is queued');
  assert.equal(q.items[0].lane, 'tcgdex');
  assert.deepStrictEqual(q.items[0].copyTargets, [], 'the custom duplicate is not a copy target of the plain one');
  assert.equal(q.totalRows, 2);
});

test('custom-card: a plain card in the queue carries no customCard key', async () => {
  const { ctx } = await loadApp({ seed: { singles: [single('p1', 'Pikachu 25')] } });
  assert.equal('customCard' in plain(ctx.buildRefreshQueue()).items[0], false);
});

test('custom-card: applyPriceToGroup never writes a price onto a custom card, as primary or as copy target', async () => {
  const { ctx } = await loadApp({
    seed: { singles: [single('p1', 'Pikachu 25'), single('c1', 'Pikachu 25', { customCard: true, marketPrice: 12 })] },
  });
  ctx.applyPriceToGroup('p1', 'singles', [{ id: 'c1', table: 'singles' }], 45, 'USD', 'TCGdex (TCGplayer)', 'high', 'base1-58');
  assert.equal(rowOf(ctx, 'p1').marketPrice, '45');
  assert.equal(rowOf(ctx, 'c1').marketPrice, 12, 'the hand-set price stays');
  assert.deepStrictEqual(plain(rowOf(ctx, 'c1').priceHistory), []);
  assert.equal(rowOf(ctx, 'c1').tcgdexId, '', 'and no id is cached on it');
  ctx.applyPriceToGroup('c1', 'singles', [], 99, 'USD', 'TCGdex (TCGplayer)', 'high', null);
  assert.equal(rowOf(ctx, 'c1').marketPrice, 12, 'even as the primary of a stale queue entry');
});

test('custom-card: a queue built before the flag was set does not ask TCGdex about the card', async () => {
  const { ctx, fetchMock, timers } = await loadApp({ seed: { singles: [single('c1', 'Pikachu 25', { customCard: true, marketPrice: 12 })] } });
  fetchMock.calls.length = 0;
  const q = { items: [{ lane: 'tcgdex', id: 'c1', table: 'singles', name: 'Pikachu 25', language: 'EN', tcgdexId: null, copyTargets: [] }] };
  const result = plain(await ctx._runTcgdexLane(q, false, TODAY()));
  assert.equal(fetchMock.calls.filter((c) => c.url.includes('tcgdex')).length, 0, 'zero requests');
  assert.equal(result.done, 0);
  assert.equal(result.failedData, 0, 'and it is not a miss');
  assert.equal(result.total, 0, 'a custom card is not a free-lane card at all (the lane reads the live inventory), so the stale entry is dropped before anything is asked');
  assert.equal(result.ran, false);
  assert.equal(rowOf(ctx, 'c1').marketPrice, 12);
  assert.ok(!rowOf(ctx, 'c1')._tcgdexMissDate, 'no stamp');
  assert.equal(ctx._tcgdexLaneHasWork(q, TODAY()), false, 'and it is no work for the next run either');
});

test('custom-card: Refresh price on a custom card makes no request and says why', async () => {
  const { ctx, fetchMock } = await loadApp({ seed: { singles: [single('c1', 'Pikachu 25', { customCard: true, marketPrice: 12 })] } });
  const said = [];
  ctx.toast = (m) => said.push(String(m));
  fetchMock.calls.length = 0;
  await ctx.refreshPrice('c1', 'singles');
  assert.equal(fetchMock.calls.filter((c) => c.url.includes('tcgdex')).length, 0);
  assert.deepStrictEqual(said, ['Custom card, price by hand (no auto-match)']);
  assert.equal(rowOf(ctx, 'c1').marketPrice, 12);
});

test('custom-card: the empty market cell and the inspector explain a custom card in words', async () => {
  const { ctx } = await loadApp();
  assert.equal(ctx._mktEmptyCellTitle({ name: 'Foo', language: 'EN', customCard: true }), 'Custom card, price by hand (no auto-match)');
  assert.equal(ctx._mktEmptyCellTitle({ name: 'Foo', language: 'JP', customCard: true }), 'Custom card, price by hand (no auto-match)', 'the owner\'s reason wins over the language one');
  assert.equal(ctx._mktEmptyCellTitle({ name: 'Foo', language: 'EN', customCard: true, marketPrice: 5 }), '', 'a priced card needs no explanation');
  assert.equal(ctx._mktEmptyCellTitle({ name: 'Foo', language: 'EN' }), 'Add or fix the card number for exact pricing', 'unchanged for a plain card');
  assert.deepStrictEqual(plain(ctx.kjrInspectRefreshInfo('singles', { name: 'Pikachu 25', language: 'EN', customCard: true })), { ok: false, why: 'Custom card, price by hand (no auto-match)' });
  assert.deepStrictEqual(plain(ctx.kjrInspectRefreshInfo('singles', { name: 'Pikachu 25', language: 'EN' })), { ok: true, why: '' });
});

test('custom-card: the inspector shows a "Custom card" chip in words, only for a flagged single', async () => {
  const { ctx } = await loadApp();
  const row = single('c1', 'Umbreon Custom Card', { customCard: true, marketPrice: 30 });
  const on = ctx.kjrInspectHtml('singles', row, { n: 1, total: 1, now: Date.UTC(2026, 9, 11, 12) });
  assert.match(on, /<span class="kjr-insp-chip" title="Priced by hand, never matched to TCGdex">Custom card<\/span>/);
  assert.ok(on.indexOf('>Custom card<') < on.indexOf('>In stock<'), 'it sits with the other chips, before the stock one');
  const off = ctx.kjrInspectHtml('singles', Object.assign({}, row, { customCard: undefined }), { n: 1, total: 1, now: Date.UTC(2026, 9, 11, 12) });
  assert.doesNotMatch(off, />Custom card</);
  const slab = ctx.kjrInspectHtml('slabs', { id: 'sl', name: 'Umbreon', grader: 'PSA', grade: '10', customCard: true, status: 'Available', costPrice: 1, marketPrice: 2 }, { n: 1, total: 1, now: Date.UTC(2026, 9, 11, 12) });
  assert.doesNotMatch(slab, />Custom card</, 'slabs have no such flag');
});

test('custom-card: valuation does not change when the flag is set', async () => {
  const { ctx } = await loadApp({ seed: { singles: [single('c1', 'Pikachu 25', { costPrice: 10, marketPrice: 40, qty: 2 }), single('p1', 'Eevee 7', { costPrice: 5, marketPrice: '' })] } });
  const read = () => JSON.stringify([plain(ctx.computeDashboardStats()), plain(ctx.effectiveMarketInfo(rowOf(ctx, 'c1'))), plain(ctx.effectiveMarketInfo(rowOf(ctx, 'p1')))]);
  const before = read();
  rowOf(ctx, 'c1').customCard = true;
  rowOf(ctx, 'p1').customCard = true;
  assert.equal(read(), before);
});

test('custom-card: the bulk refresh leaves a custom card alone', async () => {
  const { ctx, fetchMock, timers } = await loadApp({
    seed: { singles: [single('c1', 'Pikachu 25', { customCard: true, marketPrice: 12 }), single('p1', 'Bravo 7')] },
  });
  fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  fetchMock.route('/cards?name=', () => jsonResponse([{ id: 'set-7' }]));
  fetchMock.route('/cards/set-7', () => jsonResponse({ pricing: { tcgplayer: { holofoil: { marketPrice: 70 } } } }));
  ctx.kjrConfirm = async () => true;
  const p = ctx.bulkRefreshPrices('singles');
  let finished = false;
  p.then(() => { finished = true; });
  for (let i = 0; i < 40 && !finished; i++) { await new Promise((r) => setImmediate(r)); timers.flush((e) => e.delay === 1100); }
  await p;
  const names = fetchMock.calls.filter((c) => c.url.includes('/cards?name=')).map((c) => new URL(c.url).searchParams.get('name'));
  assert.deepStrictEqual(names, ['Bravo'], 'only the plain card was asked about');
  assert.equal(rowOf(ctx, 'c1').marketPrice, 12);
  assert.equal(rowOf(ctx, 'p1').marketPrice, '70');
});

// ── sync: the flag is a row field that survives markDirty, the local cache, the upsert and a pull ──────────────────────────────

test('custom-card: the flag round-trips through markDirty, the local save, the upsert and a pulled row', async () => {
  const first = await loadApp({ seed: { singles: [single('u1', 'Umbreon Custom Card', { _serverVersion: 4, _tcgdexMissDate: '2026-10-01' })] } });
  const { ctx, fetchMock, localStorage } = first;
  ctx.toast = () => {};
  const requests = [];
  fetchMock.route('/sync/v2/mutate', (url, opts) => { requests.push(syncRequest(opts)); return syncSuccessResponse(opts); });

  assert.equal(await ctx.kjrCustomMark('u1'), true);

  assert.equal(rowOf(ctx, 'u1').customCard, true);
  const cached = JSON.parse(localStorage.getItem('pokeinventory_v3')).singles.find((r) => r.id === 'u1');
  assert.equal(cached.customCard, true, 'saved to the local cache straight away');
  const ops = syncOperations(fetchMock).filter((o) => o.table === 'singles' && o.id === 'u1');
  assert.equal(ops.length, 1, 'one upsert, awaited');
  assert.equal(ops[0].type, 'upsert');
  assert.equal(ops[0].expected_version, 4, 'against the revision it read');
  assert.equal(ops[0].data.customCard, true, 'the flag is in the stored data');
  assert.equal('_tcgdexMissDate' in ops[0].data, false, 'the local marker is not');
  assert.equal(first.grab('_dirty')._dirty.singles.has('u1'), false, 'and the row is clean once the cloud has it');
  assert.equal(rowOf(ctx, 'u1')._serverVersion, 5);

  // another device pulls that row
  const pulled = plain(ctx._normalisePulledRow({ id: 'u1', data: ops[0].data, row_version: 5, updated_at: '2026-10-20T00:00:00.000Z' }, 'singles'));
  assert.equal(pulled.customCard, true);
  assert.equal(pulled.name, 'Umbreon Custom Card');

  // and a reload reads it back from the local cache
  const second = await loadApp({ storage: localStorage, seed: null });
  assert.equal(rowOf(second.ctx, 'u1').customCard, true, 'still custom after a reload');
  assert.deepStrictEqual(plain(second.ctx._kjrUnresolvedSingles()), [], 'and still not on the unmatched list');
});

test('custom-card: Undo takes the key off the row, syncs it, and an unflagged row carries no customCard key at all', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp({ seed: { singles: [single('u1', 'Umbreon Custom Card', { _serverVersion: 4 })] } });
  ctx.toast = () => {};
  const ops = [];
  fetchMock.route('/sync/v2/mutate', (url, opts) => { ops.push(...syncRequest(opts).operations); return syncSuccessResponse(opts); });
  await ctx.kjrCustomMark('u1');
  await ctx.kjrCustomUnmark('u1');
  assert.equal('customCard' in rowOf(ctx, 'u1'), false);
  assert.equal('customCard' in JSON.parse(localStorage.getItem('pokeinventory_v3')).singles.find((r) => r.id === 'u1'), false);
  const last = ops.filter((o) => o.id === 'u1').pop();
  assert.equal('customCard' in last.data, false, 'the upsert after Undo carries no flag');
  assert.deepStrictEqual(plain(ctx._kjrUnresolvedSingles().map((r) => r.id)), ['u1'], 'so the card is unmatched again');
});

test('custom-card: a Dealer-controlled row is refused, nothing changes', async () => {
  const { ctx } = await loadApp({ seed: unmatchedSeed() });
  ctx.toast = () => {};
  const guarded = [];
  ctx.kjrDealerWriteGuard = (table, row, action) => { guarded.push([table, row.id, action]); return true; };
  assert.equal(await ctx.kjrCustomMark('u1'), false);
  assert.equal('customCard' in rowOf(ctx, 'u1'), false);
  assert.deepStrictEqual(guarded, [['singles', 'u1', 'edit']]);
  rowOf(ctx, 'u2').customCard = true;
  assert.equal(await ctx.kjrCustomUnmark('u2'), false);
  assert.equal(rowOf(ctx, 'u2').customCard, true);
});

test('custom-card: marking a row that is already custom, or one that is gone, is a no-op', async () => {
  const { ctx } = await loadApp({ seed: unmatchedSeed() });
  const said = [];
  ctx.toast = (m) => said.push(String(m));
  await ctx.kjrCustomMark('u1');
  const undoDepth = ctx.undoStack.length;
  assert.equal(await ctx.kjrCustomMark('u1'), false, 'already custom');
  assert.equal(ctx.undoStack.length, undoDepth, 'no second undo step');
  assert.equal(await ctx.kjrCustomMark('nope'), false);
  assert.ok(said.some((m) => /no longer in your collection/.test(m)));
  assert.equal(await ctx.kjrCustomUnmark('ok'), false, 'a plain card has nothing to undo');
});

test('custom-card: a flag change is undoable with the app\'s Ctrl+Z and logged in the changelog', async () => {
  const { ctx } = await loadApp({ seed: unmatchedSeed() });
  ctx.toast = () => {};
  await ctx.kjrCustomMark('u1');
  assert.equal(ctx.undoStack.length > 0, true, 'a snapshot was taken BEFORE the change');
  const before = JSON.parse(ctx.undoStack[ctx.undoStack.length - 1]);
  assert.equal(before.singles.find((r) => r.id === 'u1').customCard, undefined, 'and it holds the row as it was');
  const log = plain(ctx.clLoad()).find((e) => e.table === 'singles' && /customCard/.test(e.extra || e.detail || ''));
  assert.ok(log, 'a changelog entry names the field');
  assert.match(log.extra || log.detail, /customCard: ∅ → true/);
});

test('custom-card: the changelog tracks the field in the edit diff', async () => {
  const { ctx } = await loadApp();
  assert.ok(ctx.CL_FIELDS_BY_TABLE.singles.includes('customCard'));
  assert.equal(ctx._clDiff('singles', { name: 'A' }, { name: 'A', customCard: true }), 'customCard: ∅ → true');
  assert.equal(ctx._clDiff('singles', { name: 'A', customCard: true }, { name: 'A' }), 'customCard: true → ∅');
  assert.equal(ctx._clDiff('singles', { name: 'A' }, { name: 'A' }), '');
});

// ── the review sheet ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('custom-card: the sheet lists name, language, set and why, and escapes everything from the row', async () => {
  const { ctx } = await loadApp();
  const evil = single('x"><b>', '<img src=x onerror=alert(1)> 5', { set: '"><script>alert(2)</script>', language: 'EN' });
  const out = ctx.kjrCustomReviewHtml([evil, single('u1', 'Umbreon Custom Card', { set: 'Fan Set' }), single('u2', 'Zard Custom 5', { _tcgdexMissDate: '2026-10-01' })], []);
  assert.doesNotMatch(out, /<img src=x|<script>|<b>/, 'no markup from the row survives');
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt; 5/);
  assert.match(out, /data-cr-id="x&quot;&gt;&lt;b&gt;"/, 'the id is escaped inside its attribute too');
  assert.match(out, /<div class="kjr-cr-name">Umbreon Custom Card<\/div>/);
  assert.match(out, /<span class="badge b-lang">EN<\/span><span class="kjr-cr-set">Fan Set<\/span><span class="kjr-cr-why">No card number in the name<\/span>/);
  assert.match(out, /<span class="kjr-cr-why">TCGdex found no unique match<\/span>/, 'a numbered name that was looked up and missed says so');
  assert.match(out, /3 cards could not be matched\./);
  assert.equal((out.match(/data-cr-act="open"/g) || []).length, 3, 'Open on each');
  assert.equal((out.match(/data-cr-act="mark"/g) || []).length, 3, 'Custom card on each');
  assert.match(out, /aria-label="Open Umbreon Custom Card"/);
  assert.match(out, /aria-label="Mark Umbreon Custom Card as a custom card"/);
  assert.match(out, /data-cr-act="filter">Show in list<\/button>/);
  assert.equal(ctx.kjrCustomReviewHtml([single('u1', 'One')], []).includes('1 card could not be matched.'), true, 'singular');
});

test('custom-card: no unmatched cards is a designed empty state, with or without cards just marked', async () => {
  const { ctx } = await loadApp();
  const empty = ctx.kjrCustomReviewHtml([], []);
  assert.match(empty, /class="hig-empty-title">All cards matched or marked custom</);
  assert.match(empty, /Custom cards keep the price you set\./);
  assert.doesNotMatch(empty, /data-cr-act/, 'nothing to press');
  const withMarked = ctx.kjrCustomReviewHtml([], [single('u1', 'Umbreon Custom Card')]);
  assert.match(withMarked, /All cards matched or marked custom/);
  assert.match(withMarked, /<h4 class="kjr-cr-sub">Marked custom just now<\/h4>/);
  assert.match(withMarked, /data-cr-act="undo" data-cr-id="u1" aria-label="Undo custom card for Umbreon Custom Card">Undo<\/button>/);
  assert.doesNotMatch(withMarked, /data-cr-act="mark"/);
});

test('custom-card: a long list is capped at 100 rows with a note, and a long name is kept whole', async () => {
  const { ctx } = await loadApp();
  const cards = Array.from({ length: 130 }, (_, i) => single('c' + i, 'Custom ' + i));
  const out = ctx.kjrCustomReviewHtml(cards, []);
  assert.equal((out.match(/<li class="kjr-cr-row/g) || []).length, 100);
  assert.match(out, /Showing the first 100 of 130\./);
  assert.match(out, /130 cards could not be matched\./);
  const long = 'A very long hand made card name that goes on and on and on and on and on and on 12345678901234567890';
  assert.ok(ctx.kjrCustomReviewHtml([single('l', long)], []).includes('<div class="kjr-cr-name">' + long + '</div>'));
});

test('custom-card: Review opens the sheet through the modal controller, lists the unmatched cards, and a second open does not throw', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  const dlg = document.getElementById('kjr-custom-overlay');
  ctx.renderSingles();
  ctx.kjrCustomReviewOpen();
  assert.equal(dlg.open, true);
  const body = document.getElementById('kjr-custom-body').innerHTML;
  for (const name of ['Umbreon Custom Card', 'Zard Custom 5', 'Foo Custom']) assert.ok(body.includes(name), name);
  for (const name of ['Pikachu 25', 'Mew', 'Sold Custom']) assert.ok(!body.includes(name), name + ' is matched, manual by language, or sold');
  assert.equal(document.getElementById('kjr-custom-live').textContent, '3 cards left to review');
  let opened = 0;
  const open = dlg.showModal;
  dlg.showModal = function () { opened++; return open.apply(this, arguments); };
  ctx.kjrCustomReviewOpen();
  assert.equal(opened, 0, 'showModal() on an open dialog throws, so a second Review only redraws');
  ctx.kjrCustomReviewClose();
  assert.equal(dlg.open, false);
});

test('custom-card: Custom card moves the card to "just now" with an Undo, drops the banner count, and the banner goes at zero', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  const said = [];
  ctx.toast = (m) => said.push(String(m));
  const banner = document.getElementById('singles-unresolved-banner');
  const text = () => document.getElementById('singles-unresolved-text').textContent;
  const body = () => document.getElementById('kjr-custom-body').innerHTML;
  ctx.renderSingles();
  ctx.kjrCustomReviewOpen();

  act(app, 'mark', 'u1');
  await app.settle();
  assert.equal(rowOf(ctx, 'u1').customCard, true);
  assert.match(text(), /^2 cards could not be matched/, 'the count drops');
  assert.ok(!body().includes('data-cr-act="mark" data-cr-id="u1"'), 'it left the list');
  assert.match(body(), /Marked custom just now[\s\S]*data-cr-act="undo" data-cr-id="u1"/, 'and it is in "just now", with its Undo');
  assert.match(document.getElementById('kjr-custom-live').textContent, /^2 cards left to review$/);
  const bar = document.getElementById('kjr-custom-toast');
  assert.equal(bar.hidden, false, 'the Undo bar is up');
  assert.match(bar.innerHTML, /<span class="kjr-cr-toast-msg">Marked &quot;Umbreon Custom Card&quot; as a custom card\.<\/span><button type="button" class="toast-undo" data-cr-act="undo" data-cr-id="u1">Undo<\/button>/);
  assert.deepStrictEqual(said, [], 'the page toast is not used over an open sheet, it could not be pressed');

  act(app, 'undo', 'u1'); // what the bar's Undo button carries too
  await app.settle();
  assert.equal('customCard' in rowOf(ctx, 'u1'), false);
  assert.match(text(), /^3 cards could not be matched/, 'Undo puts it back');
  assert.ok(body().includes('data-cr-act="mark" data-cr-id="u1"'));
  assert.doesNotMatch(body(), /Marked custom just now/);
  assert.equal(bar.hidden, true, 'and the bar is gone with it');
  assert.deepStrictEqual(said, [], 'no page toast for the Undo either');

  for (const id of ['u1', 'u2', 'u3']) { act(app, 'mark', id); await app.settle(); }
  assert.equal(banner.classList.contains('show'), false, 'zero left: the banner is gone');
  assert.match(body(), /All cards matched or marked custom/);
  assert.equal((body().match(/data-cr-act="undo"/g) || []).length, 3, 'all three can still be undone');
  assert.equal(document.getElementById('kjr-custom-live').textContent, 'All cards matched or marked custom');
  assert.deepStrictEqual(plain(ctx._kjrUnresolvedSingles()), []);

  act(app, 'undo', 'u2');
  await app.settle();
  assert.match(body(), /data-cr-act="open" data-cr-id="u2"/, 'an undone card is back in the list');
  assert.equal(banner.classList.contains('show'), true, 'and the banner with it');
});

test('custom-card: with no sheet open the page toast carries the Undo, and it puts the card back', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  const said = [];
  ctx.toast = (m) => said.push(String(m));
  await ctx.kjrCustomMark('u1');
  assert.deepStrictEqual(said, ['Marked "Umbreon Custom Card" as a custom card. ']);
  const kids = document.getElementById('toast-msg').children;
  const button = kids.find((k) => k.className === 'toast-undo');
  assert.ok(button, 'an Undo button was added to the toast');
  assert.equal(button.textContent, 'Undo');
  assert.equal(button.type, 'button');
  assert.equal(document.getElementById('kjr-custom-toast').hidden !== false, true, 'the sheet bar stays down when there is no sheet');
  button._listeners.get('click')[0]();
  await app.settle();
  assert.equal('customCard' in rowOf(ctx, 'u1'), false);
  assert.ok(said.includes('Custom card undone: Umbreon Custom Card'), 'closed sheet: the page says so');
  button._listeners.get('click')[0](); // a second tap is harmless
  await app.settle();
  assert.equal('customCard' in rowOf(ctx, 'u1'), false);
});

test('custom-card: the Undo bar in the sheet hides itself after a few seconds, on the next Undo and when the sheet closes', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document, timers } = app;
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  ctx.toast = () => {};
  const bar = document.getElementById('kjr-custom-toast');
  ctx.kjrCustomReviewOpen();
  await ctx.kjrCustomMark('u1');
  assert.equal(bar.hidden, false);
  assert.ok(timers.list().some((t) => t.delay === 6000), 'a 6 second timer was set');
  timers.flush((e) => e.delay === 6000);
  assert.equal(bar.hidden, true, 'gone by itself');
  assert.equal(bar.innerHTML, '');

  await ctx.kjrCustomMark('u2');
  await ctx.kjrCustomMark('u3');
  assert.match(bar.innerHTML, /data-cr-id="u3"/, 'a second mark replaces the bar, it does not stack');
  assert.equal((bar.innerHTML.match(/toast-undo/g) || []).length, 1);
  ctx.kjrCustomReviewClose();
  assert.equal(bar.hidden, true, 'closing the sheet takes the bar with it');
  assert.equal(rowOf(ctx, 'u3').customCard, true, 'the marks stay');
});

test('custom-card: Open puts the card\'s edit form on top of the sheet and leaves the sheet open', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  const opened = [];
  ctx.openEditSingle = (id) => opened.push(id);
  ctx.kjrCustomReviewOpen();
  act(app, 'open', 'u2');
  assert.deepStrictEqual(opened, ['u2']);
  assert.equal(document.getElementById('kjr-custom-overlay').open, true);
  ctx.toast = () => {};
  act(app, 'open', 'gone');
  assert.deepStrictEqual(opened, ['u2'], 'a card that has gone opens nothing');
});

test('custom-card: Show in list closes the sheet and filters the Singles list to the unmatched cards', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  const calls = [];
  ctx._kjrShowUnresolvedOnly = () => calls.push('filter');
  ctx.kjrCustomReviewOpen();
  act(app, 'filter');
  assert.equal(document.getElementById('kjr-custom-overlay').open, false);
  assert.deepStrictEqual(calls, ['filter']);
});

test('custom-card: a card fixed in the edit form leaves the open sheet, and an unmatched list filter clears when the last one goes', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  ctx.toast = () => {};
  ctx._kjrSinglesUnresolvedOnly = true;
  ctx.renderSingles();
  ctx.kjrCustomReviewOpen();
  // the edit form adds a number to Umbreon and saves: renderSingles redraws the banner, which redraws the sheet
  rowOf(ctx, 'u1').name = 'Umbreon Custom Card 215';
  ctx.renderSingles();
  assert.ok(!document.getElementById('kjr-custom-body').innerHTML.includes('Umbreon Custom Card 215'), 'it has a number now, so it is no longer unmatched');
  assert.match(document.getElementById('kjr-custom-live').textContent, /^2 cards left/);
  rowOf(ctx, 'u2').customCard = true;
  rowOf(ctx, 'u3').customCard = true;
  assert.equal(ctx._kjrSinglesUnresolvedOnly, true);
  ctx.renderSingles();
  assert.equal(ctx._kjrSinglesUnresolvedOnly, false, 'an empty filtered list would only say "no matches"');
  assert.match(document.getElementById('kjr-custom-body').innerHTML, /All cards matched or marked custom/);
});

test('custom-card: a redraw with nothing changed leaves the sheet markup alone, so a pressed button is never replaced under a finger', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  const body = document.getElementById('kjr-custom-body');
  let writes = 0, markup = '';
  Object.defineProperty(body, 'innerHTML', { configurable: true, get: () => markup, set: (v) => { markup = String(v); writes++; } });
  ctx.kjrCustomReviewOpen();
  const opened = writes;
  assert.equal(opened, 1);
  ctx.renderSingles();
  ctx.renderSingles();
  assert.equal(writes, opened, 'two Singles redraws, no change in the unmatched cards, no write');
  rowOf(ctx, 'u1').customCard = true;
  ctx.renderSingles();
  assert.equal(writes, opened + 1, 'a change is drawn');
  ctx.kjrCustomReviewClose();
  ctx.kjrCustomReviewOpen();
  assert.equal(writes, opened + 2, 'opening the sheet always draws it');
});

test('custom-card: a dismissed banner comes back when the unmatched cards are asked for on purpose', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  const banner = document.getElementById('singles-unresolved-banner');
  ctx.renderSingles();
  ctx._dismissUnresolvedBanner();
  ctx.renderSingles();
  assert.equal(banner.classList.contains('show'), false, 'the x hides it for the session');
  ctx._kjrShowUnresolvedOnly();
  assert.equal(ctx._kjrSinglesUnresolvedOnly, true);
  assert.equal(banner.classList.contains('show'), true, 'Overview "Add card numbers" or Show in list brings it, and its Review button, back');
});

test('custom-card: a closed sheet is not redrawn, and closing it forgets what was marked', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  ctx.toast = () => {};
  ctx.kjrCustomReviewOpen();
  await ctx.kjrCustomMark('u1');
  ctx.kjrCustomReviewClose();
  const frozen = document.getElementById('kjr-custom-body').innerHTML;
  rowOf(ctx, 'u2').customCard = true;
  ctx.renderSingles();
  assert.equal(document.getElementById('kjr-custom-body').innerHTML, frozen, 'a closed sheet is left alone');
  ctx.kjrCustomReviewOpen();
  assert.doesNotMatch(document.getElementById('kjr-custom-body').innerHTML, /Marked custom just now/, 'a fresh open starts with no "just now" list');
});

// keyboard focus survives the redraw that a press causes
function fakeSheetBody(app) {
  const body = app.document.getElementById('kjr-custom-body');
  let markup = '';
  let nodes = [];
  let rowObjects = [];
  const state = { focused: null };
  const parse = (m) => {
    const out = [];
    let row = -1;
    rowObjects = [];
    const re = /<li class="kjr-cr-row|<button type="button" class="btn btn-sm" data-cr-act="([a-z]+)"(?: data-cr-id="([^"]*)")?/g;
    let hit;
    while ((hit = re.exec(m))) {
      if (!hit[1]) { row++; rowObjects[row] = { _rowIndex: row }; continue; }
      const actName = hit[1], id = hit[2] === undefined ? null : hit[2], rowIndex = row;
      const node = {
        _row: rowIndex,
        getAttribute: (n) => (n === 'data-cr-act' ? actName : (n === 'data-cr-id' ? id : null)),
        closest: () => rowObjects[rowIndex],
        focus() { state.focused = node; },
      };
      out.push(node);
    }
    return out;
  };
  Object.defineProperty(body, 'innerHTML', { configurable: true, get: () => markup, set: (v) => { markup = String(v); nodes = parse(markup); } });
  body.contains = (n) => nodes.includes(n);
  app.document.getElementById('kjr-custom-overlay').contains = (n) => nodes.includes(n) || (n && n._inBar === true);
  body.querySelectorAll = (sel) => {
    if (sel === '.kjr-cr-row') return rowObjects.slice();
    const m = sel.match(/^\[data-cr-act(?:="([a-z]+)")?\]$/);
    return m ? nodes.filter((n) => !m[1] || n.getAttribute('data-cr-act') === m[1]) : [];
  };
  state.nodes = () => nodes;
  return state;
}

test('custom-card: after Custom card the keyboard focus lands on the next card, not on a button that is gone', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  ctx.toast = () => {};
  const sheet = fakeSheetBody(app);
  ctx.renderSingles();
  ctx.kjrCustomReviewOpen();
  const order = ctx._kjrUnresolvedSingles().slice().sort((a, b) => a.name.localeCompare(b.name)).map((r) => r.id); // Foo, Umbreon, Zard
  assert.deepStrictEqual(plain(order), ['u3', 'u1', 'u2']);
  const second = sheet.nodes().find((n) => n.getAttribute('data-cr-act') === 'mark' && n.getAttribute('data-cr-id') === 'u1');
  document.activeElement = second;
  await ctx.kjrCustomMark('u1');
  assert.ok(sheet.focused, 'focus was moved');
  assert.equal(sheet.focused.getAttribute('data-cr-act'), 'open');
  assert.equal(sheet.focused.getAttribute('data-cr-id'), 'u2', 'to the card that took its place');

  // the last card in the list: focus goes to the previous one, and once the list is empty to the Undo of the card just marked
  const last = sheet.nodes().find((n) => n.getAttribute('data-cr-act') === 'mark' && n.getAttribute('data-cr-id') === 'u2');
  document.activeElement = last;
  await ctx.kjrCustomMark('u2');
  assert.equal(sheet.focused.getAttribute('data-cr-id'), 'u3');
  document.activeElement = sheet.nodes().find((n) => n.getAttribute('data-cr-act') === 'mark' && n.getAttribute('data-cr-id') === 'u3');
  await ctx.kjrCustomMark('u3');
  assert.equal(sheet.focused.getAttribute('data-cr-act'), 'undo', 'an empty list leaves the Undo buttons as the only controls');
});

test('custom-card: Undo from the bar under the list puts the focus on the Open button of the card it put back', async () => {
  const app = await loadApp({ seed: unmatchedSeed() });
  const { ctx, document } = app;
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => syncSuccessResponse(opts));
  ctx.toast = () => {};
  const sheet = fakeSheetBody(app);
  ctx.kjrCustomReviewOpen();
  await ctx.kjrCustomMark('u1');
  // the Undo in the bar is outside the list: it is not one of the parsed nodes, the dialog still contains it
  document.activeElement = { _inBar: true, getAttribute: (n) => ({ 'data-cr-act': 'undo', 'data-cr-id': 'u1' })[n] || null, closest: () => null };
  await ctx.kjrCustomUnmark('u1');
  assert.ok(sheet.focused, 'focus was moved, not left on a button that was removed');
  assert.equal(sheet.focused.getAttribute('data-cr-act'), 'open');
  assert.equal(sheet.focused.getAttribute('data-cr-id'), 'u1');
});

// ── the edit form ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('custom-card: the edit form carries a switch with a hint, and the dialog and banner markup are wired', () => {
  assert.match(html, /<label class="kjr-switch" for="ms-custom">\s*<input type="checkbox" role="switch" id="ms-custom" aria-describedby="ms-custom-hint">[\s\S]*?Custom card, price by hand \(no auto-match\)<\/span>\s*<\/label>\s*<span class="kjr-switch-hint" id="ms-custom-hint">/);
  assert.match(html, /<dialog class="overlay" id="kjr-custom-overlay" aria-labelledby="kjr-custom-title">/);
  assert.match(html, /id="kjr-custom-title"/);
  assert.match(html, /id="kjr-custom-live" role="status" aria-live="polite"/);
  assert.match(html, /id="kjr-custom-body"/);
  assert.match(html, /<div class="kjr-cr-toast" id="kjr-custom-toast" role="status" aria-live="polite" hidden><\/div>/);
  assert.match(html, /<button class="btn btn-sm" type="button" onclick="kjrCustomReviewOpen\(\)">Review<\/button>/);
  assert.match(html, /id="singles-unresolved-text"[^>]*onclick="kjrCustomReviewOpen\(\)"/);
  assert.match(html, /onclick="_dismissUnresolvedBanner\(\)" aria-label="Dismiss"/, 'the dismiss stays');
});

test('custom-card: the new styles use tokens only and a phone layout that comes after the base rules', () => {
  const block = css.slice(css.indexOf('.unresolved-banner-text{'), css.indexOf('.toast-undo{') + 300);
  assert.ok(block.includes('.kjr-cr-row{'), 'block found');
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'no hardcoded colour');
  assert.doesNotMatch(block, /rgba?\(/, 'no hardcoded colour');
  assert.ok(block.indexOf('.kjr-cr-acts{') < block.indexOf('@media(max-width:480px){.kjr-cr-acts'), 'the phone override follows the base rule');
});

test('custom-card: opening the form shows the flag, and saving writes it, clears it, or leaves a plain card without the key', async () => {
  const app = await loadApp({ seed: { singles: [single('c1', 'Umbreon Custom Card', { customCard: true, marketPrice: 30 }), single('p1', 'Pikachu 25', { marketPrice: 15 })] } });
  const { ctx, document } = app;
  ctx.toast = () => {};
  const box = () => document.getElementById('ms-custom');

  ctx.openEditSingle('c1');
  assert.equal(box().checked, true, 'a flagged card opens with the switch on');
  ctx.openEditSingle('p1');
  assert.equal(box().checked, false);
  ctx.openAddSingle();
  assert.equal(box().checked, false, 'a new card starts off');

  // a notes-only save of a custom card keeps the flag (the form shows it on)
  ctx.openEditSingle('c1');
  document.getElementById('ms-notes').value = 'edited';
  await ctx.saveSingle();
  assert.equal(rowOf(ctx, 'c1').customCard, true);
  assert.equal(rowOf(ctx, 'c1').notes, 'edited');
  assert.equal(rowOf(ctx, 'c1').marketPrice, 30, 'and the price typed in stays');

  // switching it off clears the key, it does not leave customCard: false behind
  ctx.openEditSingle('c1');
  box().checked = false;
  await ctx.saveSingle();
  assert.equal('customCard' in rowOf(ctx, 'c1'), false);
  assert.deepStrictEqual(plain(ctx._kjrUnresolvedSingles().map((r) => r.id)), ['c1'], 'back on the unmatched list');

  // switching it on from a plain card
  ctx.openEditSingle('p1');
  box().checked = true;
  await ctx.saveSingle();
  assert.equal(rowOf(ctx, 'p1').customCard, true);
  assert.equal(ctx._queueLaneFor(rowOf(ctx, 'p1')), 'manual');

  // an ordinary edit of a plain card writes no key
  ctx.openEditSingle('c1');
  document.getElementById('ms-notes').value = 'plain edit';
  await ctx.saveSingle();
  assert.equal('customCard' in rowOf(ctx, 'c1'), false, 'no customCard: false is ever written');
});

test('custom-card: a new card saved with the switch on is flagged', async () => {
  const app = await loadApp({ seed: { singles: [single('p1', 'Pikachu 25')] } });
  const { ctx, document } = app;
  ctx.toast = () => {};
  ctx.openAddSingle();
  document.getElementById('ms-name').value = 'Hand made Eevee';
  document.getElementById('ms-custom').checked = true;
  await ctx.saveSingle();
  const added = ctx.DB.singles.find((r) => r.name === 'Hand made Eevee');
  assert.ok(added);
  assert.equal(added.customCard, true);
  ctx.openAddSingle();
  document.getElementById('ms-name').value = 'Plain Eevee 7';
  await ctx.saveSingle();
  assert.equal('customCard' in ctx.DB.singles.find((r) => r.name === 'Plain Eevee 7'), false);
});

test('custom-card: the edit-form save is logged with the flag change', async () => {
  const app = await loadApp({ seed: { singles: [single('p1', 'Pikachu 25')] } });
  const { ctx, document } = app;
  ctx.toast = () => {};
  ctx.openEditSingle('p1');
  document.getElementById('ms-custom').checked = true;
  await ctx.saveSingle();
  const entry = plain(ctx.clLoad()).find((e) => e.action === 'edit' && /customCard/.test(e.extra || ''));
  assert.ok(entry, 'the edit diff names the field');
  assert.match(entry.extra, /customCard: ∅ → true/);
});

// ── art: a custom card with no id is never looked up, one with an id of its own keeps its picture ───────────────────────────────

const jpRow = (extra) => Object.assign({
  id: 'j1', name: 'Charizard ex 006', set: '151', language: 'JP', type: 'raw', condition: 'Near Mint', qty: 1, costPrice: 12, marketPrice: 30,
  listPrice: '', status: 'Available', notes: '', priceAlert: '', tcgdexId: '', priceHistory: [],
}, extra || {});
const BASE_006 = 'https://assets.tcgdex.net/ja/SV/SV2a/006';

test('custom-card: art: a custom Japanese single with no id is not looked up, and no id is guessed onto it', async () => {
  const app = await loadApp({ seed: { singles: [jpRow({ customCard: true })] } });
  const { ctx, fetchMock } = app;
  fetchMock.route((u) => u.includes('api.tcgdex.net') || u.includes('species-ja'), () => jsonResponse([{ id: 'SV2a-006', localId: '006', name: 'リザードンex', image: BASE_006 }]));
  fetchMock.calls.length = 0;
  const row = ctx.DB.singles[0];
  const dirtyBefore = [...ctx._dirty.singles];

  assert.deepStrictEqual(plain(ctx.kjrArtState(row, 'singles')), { state: 'none' }, 'the whale, no lookup to wait for');
  assert.equal(ctx.kjrQueueCardImage({ key: 'single:j1', single: 'j1', lang: 'ja' }), false, 'a placeholder drawn before the flag was set is settled, never queued');
  await app.settle(40);
  assert.deepStrictEqual(fetchMock.calls.filter((c) => c.url.includes('api.tcgdex.net') || c.url.includes('species-ja')).map((c) => c.url), [], 'not one request');
  assert.equal(row.tcgdexId, '', 'no id was written onto the row');
  assert.deepStrictEqual([...ctx._dirty.singles], dirtyBefore, 'and it was not marked dirty');

  // the control: the same row unflagged is still an art lookup
  const plainRow = Object.assign({}, row); delete plainRow.customCard;
  assert.deepStrictEqual(plain(ctx.kjrArtState(plainRow, 'singles')), { state: 'need', key: 'single:j1', single: 'j1', lang: 'ja' });

  // a placeholder already on the page asks the row as it is now
  const slot = { getAttribute: (k) => ({ 'data-single': 'j1', 'data-lg': 'ja' })[k] || null };
  assert.deepStrictEqual(plain(ctx.kjrSlotState(slot)), { state: 'none' });
});

test('custom-card: art: a custom English single with no id is as it always was, no lookup', async () => {
  const { ctx } = await loadApp({ seed: { singles: [single('e1', 'Umbreon Custom Card', { customCard: true })] } });
  assert.deepStrictEqual(plain(ctx.kjrArtState(ctx.DB.singles[0], 'singles')), { state: 'none' });
});

test('custom-card: art: a custom single with an id typed in by hand still shows its picture', async () => {
  const app = await loadApp({ seed: { singles: [jpRow({ customCard: true, tcgdexId: 'SV2a-006' })] } });
  const { ctx, fetchMock } = app;
  fetchMock.route('/ja/cards/SV2a-006', () => jsonResponse({ id: 'SV2a-006', localId: '006', name: 'リザードンex', image: BASE_006, pricing: {} }));
  fetchMock.calls.length = 0;
  const row = ctx.DB.singles[0];
  assert.deepStrictEqual(plain(ctx.kjrArtState(row, 'singles')), { state: 'need', key: 'ja:SV2a-006', tcg: 'SV2a-006', lang: 'ja' }, 'the id is a lookup of that card\'s picture');
  assert.equal(ctx.kjrQueueCardImage({ key: 'ja:SV2a-006', tcg: 'SV2a-006', lang: 'ja' }), true);
  await app.settle(40);
  assert.deepStrictEqual(fetchMock.calls.map((c) => c.url), ['https://api.tcgdex.net/v2/ja/cards/SV2a-006'], 'one request, for that card');
  assert.deepStrictEqual(plain(ctx.kjrArtState(row, 'singles')), { state: 'hit', base: BASE_006, key: 'ja:SV2a-006' });
  assert.equal(row.tcgdexId, 'SV2a-006', 'the id is the one that was typed');
  assert.equal(ctx._queueLaneFor(row), 'manual', 'and the card is still priced by hand');
});
