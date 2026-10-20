'use strict';
// Redesign Step 3 (v3.70): the Overview (page id "dashboard") and the new Reports page.
// The selectors are pure reads of DB, the builders return strings, so most of this runs without a browser.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT } = require('./harness.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');

let seq = 0;
function single(o) {
  seq += 1;
  return Object.assign({
    id: 'ov-s' + seq, name: 'Card ' + seq, set: 'Base Set', language: 'EN', type: 'raw', condition: 'Near Mint',
    qty: 1, costPrice: 10, marketPrice: 15, listPrice: '', status: 'Available', tcgdexId: '', priceHistory: [],
  }, o);
}
function slab(o) {
  seq += 1;
  return Object.assign({
    id: 'ov-sl' + seq, name: 'Slab ' + seq, grader: 'PSA', grade: '10', language: 'EN', certNo: '', costPrice: 100,
    marketPrice: 150, listPrice: '', status: 'Available', priceHistory: [],
  }, o);
}
function sale(o) {
  seq += 1;
  return Object.assign({
    id: 'ov-sa' + seq, dateSold: '1 Oct 2026', product: 'Product ' + seq, buyer: '', costPrice: 10, totalCollected: 15,
    shippingCost: 0, fees: 0, channel: 'Carousell', profit: 5,
  }, o);
}
// The price code stores the UTC date (toISOString().slice(0, 10)), so a fixture does the same
function utcDay() { return new Date().toISOString().slice(0, 10); }
async function app(db) {
  const a = await loadApp();
  a.ctx.DB.singles = (db && db.singles) || [];
  a.ctx.DB.slabs = (db && db.slabs) || [];
  a.ctx.DB.sales = (db && db.sales) || [];
  a.ctx.DB.etbs = (db && db.etbs) || [];
  a.ctx.DB.boosterBoxes = (db && db.boosterBoxes) || [];
  a.ctx.DB.boosterPacks = (db && db.boosterPacks) || [];
  return a;
}
const text = (document, id) => document.getElementById(id).innerHTML;

// ── Best and worst against cost ─────────────────────────────────────────────

test('best and worst: only a real market price and cost count, three gains then two losses, best to worst', async () => {
  const rows = [
    single({ id: 'g1', name: 'Gain 100', costPrice: 10, marketPrice: 20 }),
    single({ id: 'g2', name: 'Gain 50', costPrice: 10, marketPrice: 15 }),
    single({ id: 'g3', name: 'Gain 25', costPrice: 10, marketPrice: 12.5 }),
    single({ id: 'g4', name: 'Gain 10', costPrice: 10, marketPrice: 11 }),
    single({ id: 'l1', name: 'Loss 10', costPrice: 10, marketPrice: 9 }),
    single({ id: 'l2', name: 'Loss 30', costPrice: 10, marketPrice: 7 }),
    single({ id: 'l3', name: 'Loss 50', costPrice: 10, marketPrice: 5 }),
    single({ id: 'flat', name: 'Flat', costPrice: 10, marketPrice: 10 }),
    single({ id: 'nomkt', name: 'No market price', costPrice: 500, marketPrice: '' }),
    single({ id: 'nocost', name: 'No cost', costPrice: 0, marketPrice: 40 }),
    single({ id: 'sold', name: 'Sold gain', costPrice: 1, marketPrice: 900, status: 'Sold' }),
  ];
  const { ctx, document } = await app({ singles: rows, slabs: [slab({ id: 'sl1', name: 'Slab gain', costPrice: 100, marketPrice: 105 })] });
  const m = ctx.kjrOverviewMovers();
  assert.deepEqual(Array.from(m.best, r => r.item.id), ['g1', 'g2', 'g3'], 'three biggest gains, largest first');
  assert.deepEqual(Array.from(m.worst, r => r.item.id), ['l3', 'l2'], 'two worst losses, most negative first');
  assert.deepEqual(Array.from(m.list, r => r.item.id), ['g1', 'g2', 'g3', 'l2', 'l3'], 'listed best to worst');
  for (const id of ['flat', 'nomkt', 'nocost', 'sold', 'g4', 'l1', 'sl1']) assert.ok(!m.list.some(r => r.item.id === id), id + ' is not listed');

  ctx.renderDashboard();
  const markup = text(document, 'dash-movers');
  assert.equal((markup.match(/class="ov-mover"/g) || []).length, 5);
  assert.match(markup, /▲ \+100%/, 'a gain of 100% or more drops the decimal, like the Step 2 tiles');
  assert.match(markup, /▼ -50\.0%/);
  assert.doesNotMatch(markup, /No market price|Sold gain|No cost/);
  assert.match(markup, /data-ov-act="edit" data-table="singles" data-id="g1"/);
});

test('best and worst: a slab can lead, and a row with quantity shows the position total', async () => {
  const { ctx, document } = await app({
    singles: [single({ id: 'q', name: 'Pair', qty: 2, costPrice: 48, marketPrice: 72, set: 'SV 151' })],
    slabs: [slab({ id: 'sl', name: 'Big slab', grader: 'PSA', grade: '9', costPrice: 1000, marketPrice: 2000 })],
  });
  const m = ctx.kjrOverviewMovers();
  assert.equal(m.list[0].item.id, 'sl');
  ctx.renderDashboard();
  const markup = text(document, 'dash-movers');
  assert.match(markup, /Pair ×2/);
  assert.match(markup, /SV 151 · bought S\$96/, 'bought and value are both position totals');
  assert.match(markup, /S\$144/);
  assert.match(markup, /PSA 9 · bought S\$1,000/);
});

test('best and worst: empty state when nothing has a real price', async () => {
  const { ctx, document } = await app({
    singles: [single({ marketPrice: '', costPrice: 20 }), single({ marketPrice: 0, costPrice: 30 })],
  });
  assert.equal(ctx.kjrOverviewMovers().list.length, 0);
  ctx.renderDashboard();
  assert.match(text(document, 'dash-movers'), /Add market prices to see gains and losses/);
});

// ── Top of the collection ───────────────────────────────────────────────────

test('top of the collection: five highest unit values across singles and slabs, sold rows out', async () => {
  const { ctx, document } = await app({
    singles: [
      single({ id: 'a', name: 'A', marketPrice: 40 }), single({ id: 'b', name: 'B', marketPrice: 90 }),
      single({ id: 'c', name: 'C', marketPrice: 60, qty: 5 }), single({ id: 'd', name: 'D', marketPrice: 10 }),
      single({ id: 'e', name: 'E', marketPrice: 500, status: 'Sold' }),
      single({ id: 'f', name: 'F', marketPrice: '', costPrice: 70 }), // no market price, the cost stands in as an estimate
    ],
    slabs: [slab({ id: 'x', name: 'X', marketPrice: 800 }), slab({ id: 'y', name: 'Y', marketPrice: 25 })],
  });
  const top = ctx.kjrOverviewTop(5);
  assert.deepEqual(Array.from(top, r => r.item.id), ['x', 'b', 'f', 'c', 'a'], 'unit value, quantity does not lift a row');
  assert.deepEqual(Array.from(top, r => r.table), ['slabs', 'singles', 'singles', 'singles', 'singles']);

  ctx.renderDashboard();
  const markup = text(document, 'dash-top');
  assert.equal((markup.match(/class="ov-top-item"/g) || []).length, 5);
  assert.match(markup, /class="ov-top-item" data-ov-act="edit" data-table="slabs" data-id="x"/);
  assert.match(markup, /~S\$70/, 'the estimate from cost is marked with a tilde');
  assert.equal(document.getElementById('dash-top-sec').hidden, false);
});

test('top of the collection: the section hides when there is no inventory', async () => {
  const { ctx, document } = await app({ singles: [single({ status: 'Sold' })] });
  ctx.renderDashboard();
  assert.equal(document.getElementById('dash-top-sec').hidden, true);
  assert.equal(text(document, 'dash-top'), '');
});

// ── Recent sales ────────────────────────────────────────────────────────────

test('recent sales: newest first by parsed date, three at most, undated last, ties keep array order', async () => {
  const { ctx, document } = await app({
    sales: [
      sale({ id: 'tieA', dateSold: '2 Oct 2026', product: 'Tie A' }),
      sale({ id: 'old', dateSold: '28 Sep 2026', product: 'Old' }),
      sale({ id: 'nine', dateSold: '9 Oct 2026', product: 'Nine' }),
      sale({ id: 'ten', dateSold: '10 Oct 2026', product: 'Ten' }),
      sale({ id: 'tieB', dateSold: '2 Oct 2026', product: 'Tie B' }),
      sale({ id: 'none', dateSold: '', product: 'Undated' }),
    ],
  });
  assert.deepEqual(Array.from(ctx.kjrOverviewRecentSales(3), r => r.row.id), ['ten', 'nine', 'tieA'], '10 Oct before 9 Oct, not alphabetical');
  assert.deepEqual(Array.from(ctx.kjrOverviewRecentSales(6), r => r.row.id), ['ten', 'nine', 'tieA', 'tieB', 'old', 'none']);
  ctx.renderDashboard();
  const markup = text(document, 'dash-sales');
  assert.equal((markup.match(/class="ov-sale"/g) || []).length, 3);
  assert.match(markup, /<span class="ov-date-day">10<\/span><span class="ov-date-mon">Oct<\/span>/);
});

test('recent sales: profit carries a sign and colour class, a pending Dealer sale says Pending', async () => {
  const { ctx, document } = await app({
    sales: [
      sale({ id: 'win', dateSold: '5 Oct 2026', product: 'Winner', channel: 'Meetup', totalCollected: 260, profit: 60 }),
      sale({ id: 'loss', dateSold: '4 Oct 2026', product: 'Loser', channel: 'eBay', totalCollected: 600, profit: -40 }),
      sale({ id: 'dealer', dateSold: '3 Oct 2026', product: 'Dealer one | Second | Third', channel: 'Carousell', totalCollected: 35,
        profit: 12, dealerPaymentStatus: 'Unknown', paymentStatus: 'Unknown', dealerRelease: '3.62' }),
    ],
  });
  ctx.renderDashboard();
  const markup = text(document, 'dash-sales');
  assert.match(markup, /Meetup · sold for S\$260/);
  assert.match(markup, /<span class="ov-sale-profit pos">\+S\$60<\/span>/);
  assert.match(markup, /eBay · sold for S\$600/);
  assert.match(markup, /<span class="ov-sale-profit neg">-S\$40<\/span>/);
  assert.match(markup, /Dealer one \+2 more/, 'a multi-item sale shows its first product and the rest as a count');
  assert.match(markup, /Carousell · awaiting settlement/, 'an unsettled Dealer sale shows no revenue');
  assert.match(markup, /<span class="ov-sale-profit dim">Pending<\/span>/);
  assert.doesNotMatch(markup, /S\$35|\+S\$12/, 'unsettled money stays Unknown');
});

test('recent sales: empty state', async () => {
  const { ctx, document } = await app({ singles: [single()] });
  ctx.renderDashboard();
  assert.match(text(document, 'dash-sales'), /No sales yet/);
});

// ── Escaping ────────────────────────────────────────────────────────────────

test('names, sets, products, channels and ids are escaped in every Overview list', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const { ctx, document } = await app({
    singles: [single({ id: 'a"b\'c', name: evil, set: evil, costPrice: 10, marketPrice: 30 })],
    slabs: [slab({ id: 'sl<1>', name: evil, grader: evil, grade: '9', costPrice: 10, marketPrice: 30 })],
    sales: [sale({ product: evil, channel: evil })],
  });
  ctx.renderDashboard();
  for (const id of ['dash-top', 'dash-movers', 'dash-sales', 'dash-exposure-body']) {
    const markup = text(document, id);
    assert.doesNotMatch(markup, /<img/i, id + ' has no raw tag from user data');
    assert.match(markup, /&lt;img/);
  }
  assert.match(text(document, 'dash-movers'), /data-id="a&quot;b&#39;c"/);
  assert.match(text(document, 'dash-top'), /data-id="sl&lt;1&gt;"/);
});

// ── Needs attention ─────────────────────────────────────────────────────────

test('needs attention lists only the non-zero items', () => {
  return loadApp().then(({ ctx }) => {
    assert.deepEqual(Array.from(ctx.kjrOverviewAttention({}), i => i.key), []);
    assert.deepEqual(Array.from(ctx.kjrOverviewAttention({ manualLang: 0, unresolved: 0, pendingSales: 0 }), i => i.key), []);
    const all = ctx.kjrOverviewAttention({ manualLang: 3, unresolved: 1, pendingSales: 2 });
    assert.deepEqual(Array.from(all, i => i.key), ['manual', 'unresolved', 'pending']);
    assert.deepEqual(Array.from(all, i => i.act), ['singles', 'unresolved', 'sales']);
    assert.equal(all[0].text, '3 non-English cards on manual prices');
    assert.equal(all[1].text, '1 card needs a card number');
    assert.equal(all[2].text, '2 Dealer sales pending settlement');
    assert.deepEqual(Array.from(ctx.kjrOverviewAttention({ manualLang: 1 }), i => i.text), ['1 non-English card on manual prices']);
    assert.deepEqual(Array.from(ctx.kjrOverviewAttention({ unresolved: 4 }), i => i.text), ['4 cards need a card number']);
  });
});

test('needs attention: the all-clear state and the populated state in the hero', async () => {
  const clean = await app({ singles: [single({ name: 'Pikachu 25', tcgdexId: 'base1-25' })] });
  clean.ctx.renderDashboard();
  const calm = text(clean.document, 'dash-hero');
  assert.match(calm, /All caught up/);
  assert.doesNotMatch(calm, /Needs attention/);

  const busy = await app({
    singles: [single({ name: 'Pikachu 25 JP', language: 'JP' }), single({ name: 'Eevee' })],
    sales: [sale({ dealerPaymentStatus: 'Unknown', paymentStatus: 'Unknown', dealerRelease: '3.62', profit: null })],
  });
  busy.ctx.renderDashboard();
  const hero = text(busy.document, 'dash-hero');
  assert.match(hero, /Needs attention/);
  assert.doesNotMatch(hero, /All caught up/);
  assert.match(hero, /1 non-English card on manual prices/);
  assert.match(hero, /1 card needs a card number/);
  assert.match(hero, /1 Dealer sale pending settlement/);
  assert.match(hero, /data-ov-act="singles">Review prices/);
  assert.match(hero, /data-ov-act="unresolved">Add card numbers/);
  assert.match(hero, /data-ov-act="sales">View sales/);

  const jpOnly = await app({ singles: [single({ name: 'Pikachu 25 JP', language: 'JP' })] });
  jpOnly.ctx.renderDashboard();
  const one = text(jpOnly.document, 'dash-hero');
  assert.match(one, /non-English card on manual prices/);
  assert.doesNotMatch(one, /need a card number|needs a card number|pending settlement/);
});

// ── Hero ────────────────────────────────────────────────────────────────────

test('hero: collection value, gain chip with arrow and sign, cost line, no info buttons', async () => {
  const { ctx, document } = await app({
    singles: [single({ costPrice: 100, marketPrice: 160, qty: 1 })],
    slabs: [slab({ costPrice: 400, marketPrice: 440 })],
  });
  ctx.renderDashboard();
  const hero = text(document, 'dash-hero');
  assert.match(hero, /class="ov-hero-value">S\$600</);
  assert.match(hero, /class="ov-chip pos"><span aria-hidden="true">▲<\/span> \+S\$100 · \+20\.0%/);
  assert.match(hero, /unrealised gain on S\$500 cost/);
  assert.match(hero, /data-ov-act="breakdown">See breakdown/);
  assert.match(hero, /Cost basis<\/div><div class="ov-stat-value">S\$500</);
  assert.match(hero, /1 single · 1 slab/);
  assert.doesNotMatch(hero, /metric-info|kjrToggleTooltip|aria-label="Info"/);
  assert.match(hero, /class="ov-hero-label"><span title="Estimated value/, 'the explanation is a tooltip on the label');
});

test('hero is one band: the value block, then Cost basis, Realised profit and Needs attention as regions of the same card', async () => {
  const { ctx, document } = await app({ singles: [single({ name: 'Eevee', language: 'JP', costPrice: 10, marketPrice: 20 })] });
  ctx.renderDashboard();
  const hero = text(document, 'dash-hero');
  const stats = hero.indexOf('class="ov-stats"');
  assert.ok(hero.startsWith('<div class="ov-hero-main">') && stats > 0, 'the value block comes first, the stat regions after it');
  const regions = [...hero.slice(stats).matchAll(/<div class="ov-stat">/g)].map(m => m.index + stats);
  assert.equal(regions.length, 3, 'three regions');
  const at = (i, needle) => hero.indexOf(needle, regions[i]) > 0 && hero.indexOf(needle, regions[i]) < (regions[i + 1] || Infinity);
  assert.ok(at(0, 'Cost basis'), 'first region is Cost basis');
  assert.ok(at(1, 'Realised profit'), 'second region is Realised profit');
  assert.ok(at(2, 'ov-att-head'), 'third region is the Needs attention block');
  assert.doesNotMatch(css, /\.ov-stats\{[^}]*(background|border-radius)/, 'no separate inset panel behind the stats');
  assert.match(css, /\.ov-hero-main\{flex:2 1 320px;[^}]*justify-content:flex-start/, 'the value block is about two parts and top-aligned');
  assert.match(css, /\.ov-stat\{flex:1 1 180px;[^}]*border-left:1px solid var\(--border\)/, 'each stat is one part with a hairline');
  const phone = css.slice(css.lastIndexOf('@media(max-width:900px){'));
  assert.match(phone, /\.ov-hero\{flex-direction:column\}/, 'at 900px or less the value block goes on top');
  assert.match(phone, /\.ov-hero-main\{[^}]*border-bottom:1px solid var\(--border\)/, 'with a horizontal hairline under it');
});

test('hero: a loss reads down with a minus and the loss wording', async () => {
  const { ctx, document } = await app({ singles: [single({ costPrice: 200, marketPrice: 150 })] });
  ctx.renderDashboard();
  const hero = text(document, 'dash-hero');
  assert.match(hero, /class="ov-chip neg"><span aria-hidden="true">▼<\/span> -S\$50 · -25\.0%/);
  assert.match(hero, /unrealised loss on S\$200 cost/);
});

test('hero: realised profit is signed with its return, None yet without sales, Unknown while all are pending', async () => {
  const withSales = await app({
    singles: [single()],
    sales: [sale({ costPrice: 100, totalCollected: 130, profit: 30 }), sale({ costPrice: 50, totalCollected: 40, profit: -10 })],
  });
  withSales.ctx.renderDashboard();
  const a = text(withSales.document, 'dash-hero');
  assert.match(a, /Realised profit<\/div><div class="ov-stat-value pos">\+S\$20</);
  assert.match(a, /13\.3% return across 2 sales/);

  const negative = await app({ singles: [single()], sales: [sale({ costPrice: 100, totalCollected: 60, profit: -40 })] });
  negative.ctx.renderDashboard();
  assert.match(text(negative.document, 'dash-hero'), /ov-stat-value neg">-S\$40</);

  const none = await app({ singles: [single()] });
  none.ctx.renderDashboard();
  assert.match(text(none.document, 'dash-hero'), /ov-stat-value dim">None yet</);

  const pending = await app({
    singles: [single()],
    sales: [sale({ dealerPaymentStatus: 'Unknown', paymentStatus: 'Unknown', dealerRelease: '3.62', profit: null })],
  });
  pending.ctx.renderDashboard();
  const p = text(pending.document, 'dash-hero');
  assert.match(p, /ov-stat-value dim">Unknown</);
  assert.match(p, /1 Dealer sale pending settlement/);
});

test('hero: an empty collection says so and offers one action', async () => {
  const { ctx, document } = await app({});
  ctx.renderDashboard();
  const hero = text(document, 'dash-hero');
  assert.match(hero, /class="ov-hero-value">S\$0</);
  assert.match(hero, /No singles or slabs yet/);
  assert.match(hero, /data-ov-act="add">Add a card/);
  assert.doesNotMatch(hero, /See breakdown|ov-chip/);
  assert.match(text(document, 'dash-exposure-body'), /Add some inventory to see where the money sits/);
  assert.match(text(document, 'dash-movers'), /Add market prices to see gains and losses/);
  assert.match(text(document, 'dash-sales'), /No sales yet/);
  assert.equal(document.getElementById('dash-top-sec').hidden, true);
  assert.equal(document.getElementById('dash-trust-dot').hidden, true);
  assert.equal(document.getElementById('dash-last-updated').textContent, 'No prices yet');
});

// ── Header line ─────────────────────────────────────────────────────────────

test('header: states when prices were checked and the coverage, never a clock time', async () => {
  const fresh = await app({ singles: [single({ marketPrice: 20, priceHistory: [{ date: utcDay(), price: 20 }] }), single({ marketPrice: '' })] });
  fresh.ctx.renderDashboard();
  const el = fresh.document.getElementById('dash-last-updated');
  assert.equal(el.textContent, 'Prices checked today · 50% priced');
  assert.doesNotMatch(el.textContent, /^Updated|\d:\d\d/);
  assert.equal(fresh.document.getElementById('dash-trust-dot').hidden, false);
  assert.match(fresh.document.getElementById('dash-trust-dot').className, /^ov-trust (ok|warn|bad)$/);
  assert.match(fresh.document.getElementById('dash-sub').title, /50% priced \(1\/2\)/, 'the tooltip carries the full coverage text');
  assert.match(fresh.document.getElementById('dash-trust-sr').textContent, /Price status: /, 'the state is also in words');

  const noPrices = await app({ singles: [single({ marketPrice: '' })] });
  noPrices.ctx.renderDashboard();
  assert.equal(noPrices.document.getElementById('dash-last-updated').textContent, 'No prices yet');

  const undated = await app({ singles: [single({ marketPrice: 20, priceHistory: [] })] });
  undated.ctx.renderDashboard();
  assert.equal(undated.document.getElementById('dash-last-updated').textContent, 'Price date unknown · 100% priced');
});

test('header: the age counts in UTC days, because the stored price date is a UTC date', async () => {
  const { ctx } = await loadApp();
  const at = day => new Date(day + 'T00:00:00').getTime();
  assert.equal(ctx.kjrOverviewCheckedText(at('2026-10-10'), Date.UTC(2026, 9, 10, 23, 30)), 'today');
  assert.equal(ctx.kjrOverviewCheckedText(at('2026-10-10'), Date.UTC(2026, 9, 10, 0, 5)), 'today', 'an hour-old check is never "yesterday"');
  assert.equal(ctx.kjrOverviewCheckedText(at('2026-10-10'), Date.UTC(2026, 9, 11, 1, 0)), 'yesterday');
  assert.equal(ctx.kjrOverviewCheckedText(at('2026-10-07'), Date.UTC(2026, 9, 10, 12, 0)), '3 days ago');
  assert.equal(ctx.kjrOverviewCheckedText(at('2026-09-12'), Date.UTC(2026, 9, 10, 12, 0)), '12 Sep 2026');
  assert.equal(ctx.kjrOverviewCheckedText(at('2026-10-12'), Date.UTC(2026, 9, 10, 12, 0)), 'today', 'a date a day ahead (clock skew) reads as today');
  assert.equal(ctx.kjrOverviewCheckedText(0, Date.now()), '');
});

// ── Where the money sits (v3.83) ────────────────────────────────────────────
// One fixture with a bit of everything, in whole dollars so every figure can be checked by hand:
//   Singles  A x2 (cost 10, price 15): cost 20, value 30 on a price.  B (cost 40, no price): cost 40, value 40 estimated.  C is Sold, left out.
//   Slabs    D (cost 100, price 150) on a price.  E (cost 200, no price) estimated at 200.
//   Sealed   ETB (paid 50, price 80).  Booster Box x3 (paid 300, no price) estimated at 300.  Booster Pack x10 (paid 40, price 100).
//            Three rows that are Sold or Opened are left out.
//   Singles  3 units, cost 60, market 70 (30 priced, 40 estimated), gain 10
//   Slabs    2 units, cost 300, market 350 (150 priced, 200 estimated), gain 50
//   Sealed   14 units, cost 390, market 480 (180 priced, 300 estimated), gain 90
//   Total    19 units, cost 750, market 900 (360 priced, 540 estimated), gain 150
function moneyFixture() {
  return {
    singles: [
      single({ id: 'A', name: 'Alpha', qty: 2, costPrice: 10, marketPrice: 15 }),
      single({ id: 'B', name: 'Bravo', qty: 1, costPrice: 40, marketPrice: '' }),
      single({ id: 'C', name: 'Charlie sold', qty: 1, costPrice: 500, marketPrice: 900, status: 'Sold' }),
    ],
    slabs: [
      slab({ id: 'D', name: 'Delta slab', costPrice: 100, marketPrice: 150 }),
      slab({ id: 'E', name: 'Echo slab', costPrice: 200, marketPrice: '' }),
    ],
    etbs: [
      { id: 'e1', product: 'Foxtrot ETB', status: 'In Stock', totalPrice: 50, marketPrice: 80 },
      { id: 'e2', product: 'Sold ETB', status: 'Sold', totalPrice: 999, marketPrice: 999 },
    ],
    boosterBoxes: [
      { id: 'b1', product: 'Golf Box', status: 'Unopened', qty: 3, unitPrice: 100, totalPrice: 300, marketPrice: '' },
      { id: 'b2', product: 'Opened Box', status: 'Opened', qty: 1, totalPrice: 888, marketPrice: 888 },
    ],
    boosterPacks: [
      { id: 'p1', product: 'Hotel Pack', status: 'Sealed', qty: 10, unitPrice: 4, totalPrice: 40, marketPrice: 100 },
      { id: 'p2', product: 'Opened Pack', status: 'Opened', qty: 5, totalPrice: 777, marketPrice: 777 },
    ],
  };
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, (msg || 'value') + ': ' + a + ' is not ' + b);
// The markup of one type's row: from its data-bucket to the next row or the footer (Sealed's runs on into its sub-rows)
function moneyRow(markup, key) {
  const start = markup.indexOf('data-bucket="' + key + '"');
  assert.ok(start > 0, key + ' row is drawn');
  const next = markup.slice(start + 1).search(/data-bucket="|class="exp-foot"|<\/div><\/div>$/);
  return markup.slice(start, next < 0 ? undefined : start + 1 + next);
}

test('exposure stats: units, cost, market value and gain per type, Sold and not-in-stock rows left out', async () => {
  const { ctx } = await app(moneyFixture());
  const s = ctx.kjrOvExposureStats(ctx.DB);
  const by = key => s.buckets.find(b => b.key === key);
  assert.deepEqual(Array.from(s.buckets, b => b.key), ['singles', 'slabs', 'sealed'], 'the three types, in card order');
  assert.deepEqual([by('singles').units, by('singles').cost, by('singles').market, by('singles').gain], [3, 60, 70, 10]);
  assert.deepEqual([by('slabs').units, by('slabs').cost, by('slabs').market, by('slabs').gain], [2, 300, 350, 50]);
  assert.deepEqual([by('sealed').units, by('sealed').cost, by('sealed').market, by('sealed').gain], [14, 390, 480, 90]);
  assert.deepEqual([s.total.units, s.total.cost, s.total.market, s.total.gain], [19, 750, 900, 150]);
  close(by('singles').gainPct, 10 / 60 * 100, 'singles gain % is on its cost');
  close(s.total.gainPct, 20, 'total gain %');
  close(by('singles').share, 70 / 900 * 100, 'a type\'s share is of the total market value');
  close(by('sealed').share, 480 / 900 * 100);
  close(Array.from(s.buckets, b => b.share).reduce((a, b) => a + b, 0), 100, 'the three shares make the whole');
  // the sealed sub-rows add up to the Sealed row, ETBs one unit each, boxes and packs by quantity
  const parts = by('sealed').parts;
  assert.deepEqual(Array.from(parts, p => p.label), ['ETBs', 'Booster Boxes', 'Booster Packs']);
  assert.deepEqual(Array.from(parts, p => p.units), [1, 3, 10]);
  assert.deepEqual(Array.from(parts, p => p.cost), [50, 300, 40]);
  assert.deepEqual(Array.from(parts, p => p.market), [80, 300, 100]);
  assert.equal(parts.reduce((a, p) => a + p.units, 0), by('sealed').units);
});

test('exposure stats: the same totals as computeDashboardStats, so the card and the hero cannot drift', async () => {
  const { ctx } = await app(moneyFixture());
  const s = ctx.kjrOvExposureStats(ctx.DB);
  const d = ctx.computeDashboardStats();
  const by = key => s.buckets.find(b => b.key === key);
  close(by('singles').market, d.mktSingles, 'singles market');
  close(by('slabs').market, d.mktSlabs, 'slabs market');
  close(by('sealed').market, d.mktSealed, 'sealed market');
  close(by('singles').cost, d.invCostSingles, 'singles cost');
  close(by('slabs').cost, d.invCostSlabs, 'slabs cost');
  close(by('sealed').cost, d.invCostSealed, 'sealed cost');
  close(s.total.cost, d.totalInvCost, 'total cost');
  assert.equal(by('singles').units, d.singlesAvail);
  assert.equal(by('slabs').units, d.slabsAvail);
  assert.equal(by('sealed').units, d.sealedItemCount, 'Sealed counts units, the same count the Excel summary uses');
  assert.equal(s.total.units, d.grandItemCount);
  // the hero is singles + slabs only, the card says it includes sealed
  close(by('singles').market + by('slabs').market, d.totalMktValue, 'the hero value is singles plus slabs');
});

test('exposure stats: priced share is by value, an estimate (cost standing in for a price) never counts as priced', async () => {
  const { ctx } = await app(moneyFixture());
  const s = ctx.kjrOvExposureStats(ctx.DB);
  const by = key => s.buckets.find(b => b.key === key);
  assert.deepEqual([by('singles').priced, by('singles').estimated], [30, 40]);
  assert.deepEqual([by('slabs').priced, by('slabs').estimated], [150, 200]);
  assert.deepEqual([by('sealed').priced, by('sealed').estimated], [180, 300]);
  close(by('singles').pricedPct, 30 / 70 * 100, 'by value, not by rows (one of two rows is priced, 43% of the value)');
  close(by('sealed').pricedPct, 37.5);
  close(s.total.pricedPct, 40);
  for (const b of s.buckets) close(b.priced + b.estimated, b.market, b.key + ' priced plus estimated is the market value');

  const allEst = ctx.kjrOvExposureStats({ singles: [single({ costPrice: 25, marketPrice: '', qty: 4 })] });
  assert.equal(allEst.buckets[0].pricedPct, 0, 'all estimate, 0% priced');
  assert.equal(allEst.buckets[0].market, 100, 'still valued, at cost');
  assert.equal(allEst.buckets[0].gain, 0);
  const none = ctx.kjrOvExposureStats({ singles: [single({ costPrice: '', marketPrice: '' })] });
  assert.equal(none.buckets[0].pricedPct, null, 'no value at all, no percentage to state');
  assert.equal(none.buckets[0].gainPct, null, 'no cost, no gain percentage');
  assert.equal(none.top, null, 'and nothing to concentrate');
});

test('exposure stats: quantity counts for singles, boxes and packs, slabs and ETBs are one unit a row, a bad quantity cannot go negative', async () => {
  const { ctx } = await app({});
  const s = ctx.kjrOvExposureStats({
    singles: [single({ qty: 5, costPrice: 2, marketPrice: 3 }), single({ qty: '4', costPrice: 1, marketPrice: 1 }),
      single({ qty: 0, costPrice: 10, marketPrice: 10 }), single({ qty: -3, costPrice: 10, marketPrice: 10 }), single({ qty: 'x', costPrice: 10, marketPrice: 10 })],
    slabs: [slab({ qty: 7, costPrice: 50, marketPrice: 60 })],
    etbs: [{ product: 'ETB', status: 'In Stock', qty: 9, totalPrice: 10, marketPrice: 12 }],
    boosterBoxes: [{ product: 'Box', status: 'Unopened', qty: 6, totalPrice: 60, marketPrice: 90 }, { product: 'Box zero', status: 'Unopened', qty: 0, totalPrice: 5 }],
    boosterPacks: [{ product: 'Pack', status: 'Sealed', qty: '12', totalPrice: 24, marketPrice: 36 }],
  });
  const by = key => s.buckets.find(b => b.key === key);
  assert.equal(by('singles').units, 5 + 4 + 1 + 1 + 1, 'a quantity under 1 or unreadable counts as 1');
  assert.equal(by('singles').cost, 5 * 2 + 4 * 1 + 10 + 10 + 10, 'cost and value are multiplied by the same quantity');
  assert.equal(by('singles').market, 5 * 3 + 4 * 1 + 10 + 10 + 10);
  assert.equal(by('slabs').units, 1, 'a slab is one unit whatever the row says');
  assert.deepEqual(Array.from(by('sealed').parts, p => p.units), [1, 6 + 1, 12], 'an ETB row is one unit, boxes and packs go by quantity');
  assert.equal(by('sealed').market, 12 + 90 + 5 + 36, 'sealed prices are line totals, never multiplied by quantity');
});

test('exposure stats: concentration is the five largest holdings by value, one row each, with the largest named', async () => {
  const { ctx } = await app(moneyFixture());
  const s = ctx.kjrOvExposureStats(ctx.DB);
  assert.equal(s.holdings, 7, 'seven Available rows (Sold and Opened rows are not holdings)');
  assert.equal(s.top.n, 5);
  close(s.top.pct, (300 + 200 + 150 + 100 + 80) / 900 * 100, 'top five: Golf Box 300, Echo 200, Delta 150, Hotel 100, Foxtrot 80');
  assert.equal(s.top.name, 'Golf Box');
  assert.equal(s.top.units, 3);
  assert.equal(s.top.value, 300);
  close(s.top.bigPct, 300 / 900 * 100);

  const three = ctx.kjrOvExposureStats({
    singles: [single({ name: 'Big', qty: 1, costPrice: 50, marketPrice: 60 })],
    slabs: [slab({ name: 'Mid', costPrice: 20, marketPrice: 30 })],
    etbs: [{ product: 'Small', status: 'In Stock', totalPrice: 8, marketPrice: 10 }],
  });
  assert.equal(three.top.n, 3, 'fewer than five holdings: the top N, all of them');
  close(three.top.pct, 100);
  assert.equal(three.top.name, 'Big');
  close(three.top.bigPct, 60);
  const one = ctx.kjrOvExposureStats({ slabs: [slab({ name: 'Only', costPrice: 20, marketPrice: 30 })] });
  assert.equal(one.top.n, 1);
  close(one.top.bigPct, 100);

  // ties keep the order the rows are read in (singles, slabs, sealed), so the named holding never flickers between redraws
  const tie = ctx.kjrOvExposureStats({ singles: [single({ name: 'First', costPrice: 1, marketPrice: 10 })], slabs: [slab({ name: 'Second', costPrice: 1, marketPrice: 10 })] });
  assert.equal(tie.top.name, 'First');
});

test('exposure stats: a missing table, a null row or an unreadable number is skipped, never thrown', async () => {
  const { ctx } = await app({});
  let s;
  assert.doesNotThrow(() => {
    s = ctx.kjrOvExposureStats({ singles: [null, undefined, { status: 'Available', qty: 2, costPrice: 'abc', marketPrice: 'Infinity', name: null }], slabs: null, etbs: [null], boosterBoxes: undefined });
  });
  assert.equal(s.total.units, 2, 'the readable row still counts as units');
  assert.equal(s.total.market, 0, 'an unreadable or infinite price adds nothing');
  assert.ok(Number.isFinite(s.total.cost) && Number.isFinite(s.total.gain));
  assert.doesNotThrow(() => ctx.kjrOvExposureStats(), 'no argument reads the live DB');
  assert.equal(ctx.kjrOvExposureHtml(null).includes('exp-empty'), true, 'a missing stats object draws the empty state');
});

test('exposure card: total with the gain, "Incl. sealed", and a row per type with value, cost, priced share and gain', async () => {
  const { ctx, document } = await app(moneyFixture());
  ctx.renderDashboard();
  const markup = text(document, 'dash-exposure-body');
  // total block: includes sealed (900), the hero does not (singles + slabs = 420)
  assert.match(markup, /class="exp-tag">Incl\. sealed</);
  assert.match(markup, /class="exp-total-val">S\$900</);
  assert.match(markup, /class="ov-chip pos"><span aria-hidden="true">▲<\/span> \+S\$150 · \+20\.0%/);
  assert.match(markup, /class="exp-total-sub">on S\$750 cost · 40% of value priced</);
  assert.match(text(document, 'dash-hero'), /class="ov-hero-value">S\$420</, 'the hero stays singles plus slabs');

  const singles = moneyRow(markup, 'singles');
  assert.match(singles, /Singles<span class="exp-count"> · 3 units<\/span>/);
  assert.match(singles, /class="exp-val">S\$70</);
  assert.match(singles, /on S\$60 cost · <span class="exp-priced" title="[^"]*">43% priced<\/span>/);
  assert.match(singles, /class="exp-gain pos"><span aria-hidden="true">▲<\/span> \+S\$10 · \+16\.7%/);
  assert.match(singles, /class="exp-share">8%/);
  assert.match(singles, /class="exp-fill exp-seg-singles" style="width:7\.78%"><span class="exp-solid" style="flex-grow:42\.86"><\/span><span class="exp-est" style="flex-grow:57\.14"><\/span>/);

  const slabs = moneyRow(markup, 'slabs');
  assert.match(slabs, /Slabs<span class="exp-count"> · 2 units<\/span>/);
  assert.match(slabs, /class="exp-val">S\$350</);
  assert.match(slabs, /on S\$300 cost · <span class="exp-priced"[^>]*>43% priced</);
  assert.match(slabs, /\+S\$50 · \+16\.7%/);
  assert.match(slabs, /class="exp-share">39%/);

  const sealed = moneyRow(markup, 'sealed');
  assert.match(sealed, /Sealed<span class="exp-count"> · 14 units<\/span>/, 'sealed counts units, not rows (3 rows here)');
  assert.match(sealed, /class="exp-val">S\$480</);
  assert.match(sealed, /on S\$390 cost · <span class="exp-priced"[^>]*>38% priced</);
  assert.match(sealed, /\+S\$90 · \+23\.1%/);
  assert.match(sealed, /exp-fill exp-seg-sealed" style="width:53\.33%"><span class="exp-solid" style="flex-grow:37\.50"><\/span><span class="exp-est" style="flex-grow:62\.50">/);

  // the sub-rows, in the same units
  assert.match(sealed, /ETBs<span class="exp-count"> · 1 unit<\/span><\/span><span class="exp-sub-val">S\$80<\/span><span class="exp-gain pos"><span aria-hidden="true">▲<\/span> \+S\$30 · \+60\.0%/);
  assert.match(sealed, /Booster Boxes<span class="exp-count"> · 3 units<\/span><\/span><span class="exp-sub-val">S\$300<\/span><span class="exp-gain flat"[^>]*>at cost</);
  assert.match(sealed, /Booster Packs<span class="exp-count"> · 10 units<\/span><\/span><span class="exp-sub-val">S\$100<\/span><span class="exp-gain pos"><span aria-hidden="true">▲<\/span> \+S\$60 · \+150%/);

  // the key and the concentration line
  assert.match(markup, /class="exp-key"><span class="exp-swatch" aria-hidden="true"><\/span>Market price/);
  assert.match(markup, /class="exp-swatch est" aria-hidden="true"><\/span>Estimated from cost/);
  assert.match(markup, /Top 5 holdings are <b>92%<\/b> of value/);
  assert.match(markup, /Largest: <span class="exp-conc-name" title="Golf Box ×3">Golf Box ×3<\/span><span class="exp-conc-pct">\(33%\)<\/span>/);
});

test('exposure card: keeps the pinned ids, and the Sealed disclosure keeps its state across a re-render', async () => {
  const { ctx, document } = await app({
    singles: [single({ costPrice: 600, marketPrice: 700 })],
    slabs: [slab({ costPrice: 300, marketPrice: 350 })],
    etbs: [{ id: 'e1', status: 'In Stock', totalPrice: 100, marketPrice: 120 }],
  });
  ctx.renderDashboard();
  const markup = text(document, 'dash-exposure-body');
  assert.match(markup, /id="exp-toggle-sealed"/);
  assert.match(markup, /id="exp-sub-sealed" class="exp-sub" style="display:none"/);
  assert.match(markup, /class="exp-val">S\$700</);
  assert.match(markup, /class="exp-val">S\$350</);
  assert.match(markup, /class="exp-val">S\$120</);
  assert.match(markup, /class="exp-fill exp-seg-singles"/);
  assert.match(markup, /<button type="button" class="exp-item exp-item-toggle"[^>]*id="exp-toggle-sealed" aria-controls="exp-sub-sealed" aria-expanded="false"/, 'Sealed is the one native disclosure');
  assert.equal((markup.match(/<button/g) || []).length, 1, 'and the only button in the card');

  document.getElementById('exp-sub-sealed').style.display = 'none'; // what the browser has after the first render
  ctx._toggleExposureSub('sealed');
  ctx.renderDashboard();
  const open = text(document, 'dash-exposure-body');
  assert.match(open, /id="exp-toggle-sealed"[^>]*aria-expanded="true"/);
  assert.match(open, /id="exp-sub-sealed" class="exp-sub" style="display:block"/);
  assert.match(open, /id="exp-caret-sealed" aria-hidden="true" style="transform:rotate\(90deg\)"/, 'the caret stays turned');
  ctx._toggleExposureSub('sealed');
  ctx.renderDashboard();
  assert.match(text(document, 'dash-exposure-body'), /id="exp-toggle-sealed"[^>]*aria-expanded="false"/);
});

test('exposure card: the Sealed disclosure gets keyboard focus back when a redraw replaces it, and a click on it does nothing else', async () => {
  const { ctx, document } = await app({ singles: [single()], etbs: [{ id: 'e1', product: 'ETB', status: 'In Stock', totalPrice: 10, marketPrice: 12 }] });
  ctx.renderDashboard();
  const body = document.getElementById('dash-exposure-body');
  assert.match(body.innerHTML, /<button type="button" class="exp-item exp-item-toggle"[^>]*data-ov-act="exposure"[^>]*id="exp-toggle-sealed"/, 'the toggle can be found again after a redraw');
  // the browser: the old button holds focus, the redraw puts a new one in its place
  const attrs = { 'data-ov-act': 'exposure' };
  const holder = { getAttribute: n => (n in attrs ? attrs[n] : null) };
  let focused = 0;
  const fresh = { tagName: 'BUTTON', getAttribute: holder.getAttribute, focus: () => { focused += 1; } };
  document.activeElement = { closest: sel => (sel === '[data-ov-act]' ? holder : null) };
  body.contains = node => node === document.activeElement;
  body.querySelectorAll = () => [fresh];
  ctx._kjrExpSealedOpen = true; // just opened by the keyboard, so the next draw differs from the last
  ctx.renderDashboard();
  assert.equal(focused, 1, 'focus goes back to the Sealed button');
  const calls = [];
  ctx.showPage = n => calls.push(n);
  ctx._kjrOvClick({ target: { closest: () => holder } });
  assert.deepEqual(calls, [], 'the delegated Overview click has no branch for it');
});

test('exposure card: a type with nothing in it is a plain muted row, not a disclosure, and has no bar', async () => {
  const { ctx, document } = await app({ singles: [single({ costPrice: 50, marketPrice: 60 })] });
  ctx.renderDashboard();
  const markup = text(document, 'dash-exposure-body');
  assert.match(markup, /Slabs<span class="exp-count"> · none<\/span>/);
  assert.match(markup, /Sealed<span class="exp-count"> · none in stock<\/span>/);
  assert.doesNotMatch(markup, /exp-toggle-sealed/);
  assert.equal((markup.match(/class="exp-track"/g) || []).length, 1, 'only the type that has something draws a bar');
  assert.match(moneyRow(markup, 'singles'), /class="exp-share">100%/);
  assert.match(markup, /exp-fill exp-seg-singles" style="width:100\.00%"/, 'the one type fills its track');
  assert.doesNotMatch(markup, /exp-legend/, 'every bit of value is on a real price, so there are no stripes to explain');
  assert.match(markup, /Top 1 holding is/, 'the concentration line stays');
});

test('exposure card: an all-estimate type still draws its bar, fully striped, and says 0% priced and "at cost"', async () => {
  const { ctx, document } = await app({ singles: [single({ costPrice: 25, marketPrice: '', qty: 4 })] });
  ctx.renderDashboard();
  const row = moneyRow(text(document, 'dash-exposure-body'), 'singles');
  assert.match(row, /class="exp-solid" style="flex-grow:0\.00"><\/span><span class="exp-est" style="flex-grow:100\.00">/, 'all of it striped');
  assert.match(row, />0% priced</);
  assert.match(row, /class="exp-gain flat" title="[^"]*">at cost</, 'no market verdict, valued at cost');
  assert.doesNotMatch(row, /▲|▼/);
  assert.match(text(document, 'dash-exposure-body'), /class="ov-chip flat"[^>]*>at cost</);
  assert.match(text(document, 'dash-exposure-body'), /class="exp-swatch est" aria-hidden="true"><\/span>Estimated from cost/, 'the key is there to explain the stripes');
});

test('exposure card: the gain says up or down with an arrow and a sign, a dash with no cost, "at cost" with no price, "<0.1%" for a speck', async () => {
  const { ctx } = await app({});
  const g = (gain, cost, priced) => ctx._kjrOvGainHtml({ gain, cost, priced: priced === undefined ? 1 : priced }, 'exp-gain');
  assert.match(g(25, 100), /^<span class="exp-gain pos"><span aria-hidden="true">▲<\/span> \+S\$25 · \+25\.0%<\/span>$/);
  assert.match(g(-25, 100), /^<span class="exp-gain neg"><span aria-hidden="true">▼<\/span> -S\$25 · -25\.0%<\/span>$/);
  assert.match(g(1500, 100), /\+S\$1,500 · \+1500%/, 'a gain of 100% or more drops the decimal, like the hero');
  assert.match(g(0, 100), /^<span class="exp-gain flat">S\$0 · 0%<\/span>$/, 'flat has neither arrow nor colour');
  assert.match(g(0.3, 1000000), /^<span class="exp-gain flat">S\$0 · 0%<\/span>$/, 'under S$0.50 and under 0.05% is flat');
  assert.match(g(0.3, 100), /\+S\$0 · \+0\.3%/, 'a visible percentage keeps its sign and arrow, the same call the hero chip makes');
  assert.match(g(37, 1358052), /\+S\$37 · <0\.1%/, 'a real but tiny move never prints a signed 0.0%');
  assert.match(g(-37, 1358052), /▼<\/span> -S\$37 · <0\.1%/);
  const none = g(50, 0);
  assert.match(none, /^<span class="exp-gain flat" title="No cost recorded">–<span class="sr-only"> no cost recorded<\/span><\/span>$/, 'no cost, a dash a screen reader can say');
  assert.doesNotMatch(none, new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ']'), 'an en dash, never an em dash or a bar');
  assert.match(g(0, 100, 0), />at cost</, 'nothing priced, so no gain to claim');
  assert.match(g(50, 0, 0), /No cost recorded/, 'no cost wins over no price');
  assert.match(ctx._kjrOvGainHtml({ gain: 5, cost: 50, priced: 5 }, 'ov-chip'), /^<span class="ov-chip pos">/, 'the total uses the hero chip');
});

test('exposure card: shares round honestly, 100% only ever means all of it', async () => {
  const { ctx } = await app({});
  const sh = ctx._kjrOvShare;
  assert.equal(sh(0), '0%');
  assert.equal(sh(NaN), '0%');
  assert.equal(sh(0.4), '<1%');
  assert.equal(sh(7.78), '8%');
  assert.equal(sh(50), '50%');
  assert.equal(sh(99.6), '99%', 'something is left out, so not 100%');
  assert.equal(sh(99.9999999), '100%', 'float dust is not something left out');
  assert.equal(sh(100), '100%');
  assert.equal(ctx._kjrOvUnits(1), '1 unit');
  assert.equal(ctx._kjrOvUnits(0), '0 units');
  assert.equal(ctx._kjrOvUnits(1234567), '1,234,567 units');
});

test('exposure card: concentration line for fewer than five holdings says Top N, one holding is singular', async () => {
  const three = await app({
    singles: [single({ name: 'Big', costPrice: 50, marketPrice: 60 })], slabs: [slab({ name: 'Mid', costPrice: 20, marketPrice: 30 })],
    etbs: [{ id: 'e', product: 'Small', status: 'In Stock', totalPrice: 8, marketPrice: 10 }],
  });
  three.ctx.renderDashboard();
  const a = text(three.document, 'dash-exposure-body');
  assert.match(a, /Top 3 holdings are <b>100%<\/b> of value/);
  assert.match(a, /Largest: <span class="exp-conc-name" title="Big">Big<\/span><span class="exp-conc-pct">\(60%\)<\/span>/);

  const one = await app({ slabs: [slab({ name: 'Only', costPrice: 20, marketPrice: 30 })] });
  one.ctx.renderDashboard();
  assert.match(text(one.document, 'dash-exposure-body'), /Top 1 holding is <b>100%<\/b> of value/);
});

test('exposure card: a long name is cut with an ellipsis and carries its full text, escaped, in the title', async () => {
  const long = 'Pikachu With Grey Felt Hat Black Star Promo Japanese Edition Limited Print Run Signed By The Illustrator 2026';
  const { ctx, document } = await app({ singles: [single({ name: long + ' <b>"x"</b>', qty: 3, costPrice: 10, marketPrice: 90 })] });
  ctx.renderDashboard();
  const markup = text(document, 'dash-exposure-body');
  const full = long + ' &lt;b&gt;&quot;x&quot;&lt;/b&gt; ×3';
  assert.ok(markup.includes('class="exp-conc-name" title="' + full + '">' + full + '</span>'), 'the name, its quantity, escaped in both places');
  assert.doesNotMatch(markup, /<b>"x"<\/b>/);
  const block = css.slice(css.indexOf('.exp-conc-name{'), css.indexOf('}', css.indexOf('.exp-conc-name{')));
  assert.match(block, /overflow:hidden/);
  assert.match(block, /text-overflow:ellipsis/);
  assert.match(block, /white-space:nowrap/);
  assert.match(block, /min-width:0/, 'so it can shrink below its text inside the flex line');
  const blank = await app({ singles: [single({ name: '   ', costPrice: 10, marketPrice: 20 })] });
  blank.ctx.renderDashboard();
  assert.match(text(blank.document, 'dash-exposure-body'), /title="Unnamed">Unnamed</, 'a blank name never leaves an empty slot');
});

test('exposure card: empty and sold-out collections show the empty state, not a card of zeros', async () => {
  const empty = await app({});
  empty.ctx.renderDashboard();
  assert.match(text(empty.document, 'dash-exposure-body'), /^<div class="exp-empty">Add some inventory to see where the money sits\.<\/div>$/);

  const soldOut = await app({ singles: [single({ status: 'Sold' })], slabs: [slab({ status: 'Sold' })], etbs: [{ id: 'x', product: 'Gone', status: 'Sold', totalPrice: 5, marketPrice: 6 }] });
  soldOut.ctx.renderDashboard();
  assert.match(text(soldOut.document, 'dash-exposure-body'), /exp-empty/);
  assert.doesNotMatch(text(soldOut.document, 'dash-exposure-body'), /exp-total|exp-item/);
});

test('exposure card: inventory with no cost and no price is S$0 with a note, no stripes, no key, no concentration', async () => {
  const { ctx, document } = await app({ singles: [single({ qty: 2, costPrice: '', marketPrice: '' })] });
  ctx.renderDashboard();
  const markup = text(document, 'dash-exposure-body');
  assert.match(markup, /class="exp-total-val">S\$0</);
  assert.match(markup, /class="exp-note">No cost or price recorded yet\.</);
  assert.match(moneyRow(markup, 'singles'), /Singles<span class="exp-count"> · 2 units<\/span>/);
  assert.doesNotMatch(markup, /exp-fill|exp-legend|exp-conc|priced/, 'nothing to size a bar, state a share or name a holding');
  assert.match(markup, /class="ov-chip flat" title="No cost recorded">–/, 'no cost, a dash');
});

test('exposure card: a card with a price and no cost has a gain of a dash, not an invented percentage', async () => {
  const { ctx, document } = await app({ singles: [single({ costPrice: '', marketPrice: 50 })] });
  ctx.renderDashboard();
  const row = moneyRow(text(document, 'dash-exposure-body'), 'singles');
  assert.match(row, /class="exp-gain flat" title="No cost recorded">–<span class="sr-only"> no cost recorded<\/span>/);
  assert.match(row, /on S\$0 cost/);
  assert.doesNotMatch(row, /▲|▼|%<\/span><\/span>$/);
  assert.match(row, />100% priced</, 'the value itself is a real price');
});

test('exposure card: a loss reads down and red-signed, and large figures keep their thousands separators', async () => {
  const { ctx, document } = await app({
    singles: [single({ name: 'Whale', qty: 12345, costPrice: 100, marketPrice: 90 })],
    slabs: [slab({ name: 'Grail', costPrice: 1234567, marketPrice: 1500000 })],
  });
  ctx.renderDashboard();
  const markup = text(document, 'dash-exposure-body');
  assert.match(moneyRow(markup, 'singles'), /class="exp-val">S\$1,111,050</);
  assert.match(moneyRow(markup, 'singles'), /class="exp-gain neg"><span aria-hidden="true">▼<\/span> -S\$123,450 · -10\.0%/);
  assert.match(moneyRow(markup, 'singles'), /12,345 units/);
  assert.match(moneyRow(markup, 'slabs'), /class="exp-val">S\$1,500,000</);
  assert.match(markup, /class="exp-total-val">S\$2,611,050</);
});

test('exposure card: markup changes only when the numbers do, so a sync that finds the same data leaves the card alone', async () => {
  const { ctx, document } = await app(moneyFixture());
  ctx.renderDashboard();
  const el = document.getElementById('dash-exposure-body');
  const first = el.innerHTML;
  el.__marker = true;
  ctx.renderDashboard();
  assert.equal(el.innerHTML, first);
  ctx.DB.singles[0].marketPrice = 16;
  ctx.renderDashboard();
  assert.notEqual(el.innerHTML, first, 'a changed price redraws');
  assert.match(el.innerHTML, /class="exp-val">S\$72</);
});

test('exposure card: styles use tokens only, hatch the estimate, and never rely on a media query that could out-rank the base rules', () => {
  const start = css.indexOf('/* Where the money sits (Overview');
  const end = css.indexOf('/* Recently-added row highlight', start);
  assert.ok(start > 0 && end > start, 'the exposure block is found');
  const block = css.slice(start, end);
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/, 'no hex, rgb or hsl colour in the exposure rules');
  assert.match(block, /\.exp-est\{[^}]*repeating-linear-gradient\(135deg,var\(--hue\)/, 'the estimate is striped in the type\'s own hue');
  assert.match(block, /\.exp-solid\{background:var\(--hue\)\}/);
  assert.match(block, /\.exp-seg-singles\{--hue:var\(--cat1\)\}[\s\S]*\.exp-seg-slabs\{--hue:var\(--cat2\)\}[\s\S]*\.exp-seg-sealed\{--hue:var\(--cat3\)\}/);
  assert.match(block, /\.exp-track\{[^}]*border-radius:999px[^}]*overflow:hidden/, 'each bar sits on its own rounded track');
  assert.match(block, /\.exp-fill\{[^}]*min-width:6px/, 'a tiny type is still a visible sliver');
  assert.doesNotMatch(block, /@media/, 'the rows wrap on their own, nothing depends on a breakpoint');
  assert.doesNotMatch(block, /\.ov-bar|\.ov-seg|\.exp-row|\.exp-amt|\.exp-pct|\.exp-legend-dot/, 'the old segmented-bar rules are gone');
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\s*\.ov-mover,\.exp-caret\{transition:none\}/, 'the caret turn still stops for reduced motion');
});

test('the Overview card row keeps each card at the height of its own content, so a tall Where the money sits leaves no empty box beside it', () => {
  const selectors = css.match(/\.ov-row3[^{]*\{/g) || [];
  assert.deepEqual(selectors, ['.ov-row3{'], 'one rule styles the row, so no later or narrower rule can out-rank it');
  const row = css.match(/\.ov-row3\{[^}]*\}/)[0];
  assert.match(row, /display:flex/);
  assert.match(row, /flex-wrap:wrap/);
  assert.match(row, /align-items:flex-start/, 'the cards are not stretched to the tallest one');
  assert.doesNotMatch(css, /\.ov-card[^{]*\{[^}]*align-self:\s*(stretch|auto|normal)/, 'and no card opts back in to stretching');
  const markup = html.slice(html.indexOf('<div class="ov-row3">'), html.indexOf('<!-- REPORTS PAGE'));
  assert.equal((markup.match(/<section class="ov-card"/g) || []).length, 3, 'the row holds the three cards');
});

// ── The Overview never reaches into Reports ─────────────────────────────────

test('the Overview render does not call initAiAnalyst or touch the AI chart, the builder or the saved charts', async () => {
  const { ctx, document } = await app({ singles: [single()], sales: [sale()] });
  let aiInits = 0, destroyed = 0;
  ctx.initAiAnalyst = () => { aiInits += 1; };
  const aiChart = { destroy() { destroyed += 1; } };
  ctx.dashCharts.aiChart = aiChart;

  const requested = new Set();
  const original = document.getElementById;
  document.getElementById = id => { requested.add(String(id)); return original.call(document, id); };
  try {
    ctx.renderDashboard();
    ctx.renderDashboard();
    ctx.showPage('dashboard');
  } finally { document.getElementById = original; }

  assert.equal(aiInits, 0, 'renderDashboard never calls initAiAnalyst');
  assert.equal(destroyed, 0, 'a dashboard re-render (a sync) cannot destroy the AI chart');
  assert.strictEqual(ctx.dashCharts.aiChart, aiChart);
  const reached = Array.from(requested).filter(id => /^(ai-|cb-|saved-charts|customChart|sc-)/.test(id));
  assert.deepEqual(reached, [], 'no Reports element is read or written by the Overview');
});

test('the Overview binds one delegated click listener however often it renders', async () => {
  const { ctx, document } = await app({ singles: [single()] });
  ctx.renderDashboard();
  ctx.renderDashboard();
  ctx.renderDashboard();
  assert.equal(document.getElementById('page-dashboard')._listeners.get('click').length, 1);
});

test('the Overview redraws when a dialog closes over it, and only while it is the open page', async () => {
  const { ctx, document } = await app({ singles: [single({ id: 'e1', costPrice: 10, marketPrice: 20 })] });
  const page = document.getElementById('page-dashboard');
  const listeners = [];
  document.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
  page._kjrOvBound = false; // the first render at load already bound it, bind again so the listener can be captured
  ctx.renderDashboard();
  const close = listeners.find(l => l.type === 'close');
  assert.ok(close, 'a close listener is bound');
  assert.equal(close.capture, true, 'close does not bubble, so it is listened for in the capture phase');
  assert.match(text(document, 'dash-hero'), /class="ov-hero-value">S\$20</);

  ctx.DB.singles[0].marketPrice = 40; // an edit saved behind the modal
  page.classList.remove('active');
  close.fn();
  assert.match(text(document, 'dash-hero'), /class="ov-hero-value">S\$20</, 'another page is open, nothing is redrawn');
  page.classList.add('active');
  close.fn();
  assert.match(text(document, 'dash-hero'), /class="ov-hero-value">S\$40</, 'the Overview is open, so the saved edit shows');
});

test('a render that runs before features.js has loaded is repeated once all scripts have run', async () => {
  const { ctx, document } = await app({ singles: [single({ marketPrice: 50 })] });
  const real = ctx.kjrTileHtml;
  const listeners = [];
  document.readyState = 'loading';
  document.addEventListener = (type, fn, opts) => listeners.push({ type, fn, opts });
  ctx.kjrTileHtml = undefined; // features.js has not defined it yet
  ctx.renderDashboard();
  ctx.renderDashboard();
  assert.equal(document.getElementById('dash-top-sec').hidden, true, 'no tiles without the card helpers');
  const late = listeners.filter(l => l.type === 'DOMContentLoaded');
  assert.equal(late.length, 1, 'one repeat is registered however often it renders');
  assert.equal(late[0].opts.once, true);
  ctx.kjrTileHtml = real;
  document.readyState = 'complete';
  late[0].fn();
  assert.equal(document.getElementById('dash-top-sec').hidden, false);
  assert.match(text(document, 'dash-top'), /ov-top-item/);
});

test('a section that fails to draw is skipped and never throws into the sync paths that call renderDashboard', async () => {
  const { ctx, document, consoleWarnings } = await app({ singles: [single()] });
  ctx.kjrOverviewMovers = () => { throw new Error('boom'); };
  assert.doesNotThrow(() => ctx.renderDashboard());
  assert.match(text(document, 'dash-movers'), /Could not draw this section/);
  assert.ok(consoleWarnings.some(w => /\[overview\] movers failed to render/.test(w)));
  assert.match(text(document, 'dash-hero'), /ov-hero-value/, 'the other sections still draw');
});

// ── Clicks ──────────────────────────────────────────────────────────────────

function fakeClick(attrs) {
  const holder = { getAttribute: name => (name in attrs ? attrs[name] : null) };
  return { target: { closest: () => holder } };
}

test('tiles and rows open the card inspector by table, the text buttons go where they say', async () => {
  const { ctx } = await app({ singles: [single({ id: 'one' })], slabs: [slab({ id: 'two' }), slab({ id: 3, name: 'Numeric id' })] });
  const calls = [];
  const toasts = [];
  ctx.toast = msg => toasts.push(msg);
  // v3.72: a tile or a mover opens the inspector, Edit is one click further. The row's own id goes through (3, not '3').
  ctx.kjrInspect = (table, id) => { calls.push(['inspect', table, id]); return true; };
  ctx.openEditSingle = id => calls.push(['edit-single', id]);
  ctx.openEditSlab = id => calls.push(['edit-slab', id]);
  ctx.showPage = name => calls.push(['page', name]);
  ctx._kjrShowUnresolvedOnly = () => calls.push(['unresolved']);
  ctx.showMarketValueBreakdown = () => calls.push(['breakdown']);
  ctx.openAddSingle = () => calls.push(['add']);

  ctx._kjrOvClick(fakeClick({ 'data-ov-act': 'edit', 'data-table': 'singles', 'data-id': 'one' }));
  ctx._kjrOvClick(fakeClick({ 'data-ov-act': 'edit', 'data-table': 'slabs', 'data-id': 'two' }));
  ctx._kjrOvClick(fakeClick({ 'data-ov-act': 'edit', 'data-table': 'slabs', 'data-id': '3' }));
  ctx._kjrOvClick(fakeClick({ 'data-ov-act': 'singles' }));
  ctx._kjrOvClick(fakeClick({ 'data-ov-act': 'sales' }));
  ctx._kjrOvClick(fakeClick({ 'data-ov-act': 'unresolved' }));
  ctx._kjrOvClick(fakeClick({ 'data-ov-act': 'breakdown' }));
  ctx._kjrOvClick(fakeClick({ 'data-ov-act': 'add' }));
  assert.deepEqual(calls, [
    ['inspect', 'singles', 'one'], ['inspect', 'slabs', 'two'], ['inspect', 'slabs', 3], ['page', 'inventory'], ['page', 'sales'], ['unresolved'], ['breakdown'], ['add'],
  ]);

  calls.length = 0;
  ctx._kjrOvClick(fakeClick({ 'data-ov-act': 'edit', 'data-table': 'singles', 'data-id': 'gone' }));
  assert.deepEqual(calls, [], 'a stale tile opens nothing');
  assert.match(toasts.join('|'), /no longer in your collection/);
  ctx._kjrOvClick({ target: { closest: () => null } });
  ctx._kjrOvClick(null);
  assert.deepEqual(calls, []);
});

// ── Reports ─────────────────────────────────────────────────────────────────

test('Reports is registered: the phone More page set and sheet, the sidebar item, and the Dealer preview list', async () => {
  const { ctx } = await loadApp();
  assert.ok(ctx.MORE_PAGES.has('reports'));
  // v3.73: the desktop More dropdown is retired, Reports is a sidebar item (Workspace) in its place
  assert.match(html, /<button class="nav-btn" aria-label="Reports" onclick="showPage\('reports'\)">/);
  assert.doesNotMatch(html, /<button class="nav-dd-item" onclick="showPage\('reports'\);closeNavDD\(\)">/);
  assert.match(html, /<button class="sheet-item" data-page="reports" onclick="moreGo\('reports'\)">/);
  assert.match(css, /html\.dealer-preview-only #page-reports,/);
  const guide = html.slice(html.indexOf('id="guide-source"'), html.indexOf('</script>', html.indexOf('id="guide-source"')));
  assert.match(guide, /Overview/);
  assert.match(guide, /Reports/);
  assert.doesNotMatch(guide, /Dashboard/);
});

test('Reports holds the Chart Builder, saved charts and AI Analyst in that order, with their ids unchanged, and the Overview holds none of them', () => {
  const start = html.indexOf('<div id="page-reports"');
  const end = html.indexOf('<!-- DEALER DESK PRODUCTION PAGE -->');
  const reports = html.slice(start, end);
  const overview = html.slice(html.indexOf('<div id="page-dashboard"'), html.indexOf('<!-- REPORTS PAGE'));
  assert.ok(start > 0 && end > start && overview.length > 100);
  const ids = ['cb-field-palette', 'customChart', 'cb-save-btn', 'saved-charts-container', 'ai-analyst-card', 'ai-panel-toggle', 'ai-analyst-body', 'ai-chat-input'];
  for (const id of ids) {
    assert.ok(reports.includes('id="' + id + '"'), id + ' is on Reports');
    assert.ok(!overview.includes('id="' + id + '"'), id + ' is not on the Overview');
  }
  assert.ok(reports.indexOf('id="cb-field-palette"') < reports.indexOf('id="saved-charts-container"'));
  assert.ok(reports.indexOf('id="saved-charts-container"') < reports.indexOf('id="ai-analyst-card"'));
  assert.match(reports, /<h1 class="pg-title">Reports<\/h1>/);
  assert.match(reports, /Build charts and ask the AI analyst about your collection/);
  assert.match(reports, /id="cb-save-btn" disabled title="Configure a chart first">Save chart</);
  assert.doesNotMatch(reports, /Add to Dashboard/);
  assert.match(reports, /class="ai-icon-chip"/);
  assert.doesNotMatch(reports, /#7c3aed|#4a9eff|🤖/, 'the gradient chip and robot emoji are gone from the AI header');
  assert.match(css, /\.ai-icon-chip\{[^}]*background:var\(--accent-soft\)[^}]*color:var\(--accent\)/);
  assert.match(overview, /<h1 class="pg-title">Overview<\/h1>/);
  assert.doesNotMatch(overview, /metric-info|dash-metrics-primary|Chart Builder|AI Portfolio Analyst/);
});

test('the visible label is Overview in the desktop nav and the mobile tab bar, with the page id and handler unchanged', () => {
  assert.match(html, /<button class="nav-btn active" aria-label="Overview" onclick="showPage\('dashboard'\)">/);
  assert.match(html, /<span>Overview<\/span>/);
  assert.match(html, /id="btb-dashboard" onclick="showPage\('dashboard'\)">[\s\S]*?<\/svg>\s*Overview\s*<\/button>/);
  assert.match(html, /aria-label="Open overview"/);
  assert.doesNotMatch(html, /<span>Dashboard<\/span>|aria-label="Dashboard"/);
});

test('showPage("reports") sets up the builder, saved charts and AI analyst after 150 ms, the dashboard does not', async () => {
  const { ctx, document, timers } = await loadApp();
  const calls = [];
  ctx.initCustomChartBuilder = () => calls.push('builder');
  ctx.renderAllSavedCharts = () => calls.push('saved');
  ctx.initAiAnalyst = () => calls.push('ai');
  const pending = () => new Set(timers.list().map(t => t.id));
  const newTimers = before => timers.list().filter(t => !before.has(t.id));

  let before = pending();
  ctx.showPage('dashboard');
  assert.deepEqual(newTimers(before).filter(t => t.delay === 150), [], 'the Overview schedules nothing for Reports');
  timers.flush(t => t.delay === 150);
  assert.deepEqual(calls, []);

  before = pending();
  ctx.showPage('reports');
  assert.deepEqual(calls, [], 'nothing runs before layout');
  const timer = newTimers(before).filter(t => t.delay === 150);
  assert.equal(timer.length, 1);
  timers.invoke(timer[0].id);
  assert.deepEqual(calls, ['builder', 'saved', 'ai']);

  // leaving Reports before the timer fires skips the work
  calls.length = 0;
  before = pending();
  ctx.showPage('reports');
  document.getElementById('page-reports').classList.remove('active');
  const late = newTimers(before).filter(t => t.delay === 150);
  timers.invoke(late[0].id);
  assert.deepEqual(calls, []);
});

// ── AI Analyst on Reports ───────────────────────────────────────────────────

test('AI sub-line names the real place for a key, shows a link-style button, and never points at a topbar key', async () => {
  const { ctx, document } = await loadApp();
  ctx.initAiAnalyst();
  const sub = document.getElementById('ai-panel-subline');
  assert.equal(sub.textContent, 'Add an AI key in Settings, API settings');
  assert.doesNotMatch(sub.textContent, /🔑|top ?bar/i);
  assert.equal(document.getElementById('ai-key-notice').hidden, false, 'the notice shows while there is no key');

  ctx.setGeminiKey('test-key');
  ctx.initAiAnalyst();
  assert.match(sub.textContent, /^Using Google Gemini \(free\)/);
  assert.equal(document.getElementById('ai-key-notice').hidden, true, 'and hides once a key is set');

  const notice = html.slice(html.indexOf('id="ai-key-notice"'), html.indexOf('<!-- Quick prompts -->'));
  assert.match(notice, /<button type="button" class="ov-link" onclick="openApiSettings\(\)">Add a key in API settings<\/button>/);
  assert.match(html.slice(html.indexOf('id="ai-key-notice"') - 40, html.indexOf('id="ai-key-notice"') + 60), /class="ai-key-notice" hidden/);
  assert.ok(html.indexOf('id="ai-analyst-body"') < html.indexOf('id="ai-key-notice"'), 'the notice sits inside the panel body');
  assert.doesNotMatch(html.slice(html.indexOf('id="page-reports"'), html.indexOf('<!-- DEALER DESK PRODUCTION PAGE -->')), /🔑/);
});

test('the topbar has no key button, so the copy points at the gear and API settings', () => {
  const topbar = html.slice(html.indexOf('<div class="topbar">'), html.indexOf('<main') > 0 ? html.indexOf('<main') : html.indexOf('<div class="main">'));
  assert.doesNotMatch(topbar, /🔑/);
  assert.match(topbar, /aria-label="Settings"/);
  assert.match(topbar, /onclick="openApiSettings\(\);closeNavDD\(\)"[^>]*title="TCGdex \(free\) \+ PokemonPriceTracker">[\s\S]*?API settings/);
});

test('saving API keys refreshes the AI Analyst sub-line straight away', async () => {
  const { ctx, document } = await loadApp();
  ctx.initAiAnalyst();
  const sub = document.getElementById('ai-panel-subline');
  assert.match(sub.textContent, /^Add an AI key/);
  document.getElementById('gemini-key-input').value = 'test-key';
  ctx.saveApiKeys();
  assert.match(sub.textContent, /^Using Google Gemini \(free\)/, 'saving a key while on Reports updates it without a revisit');
  assert.equal(document.getElementById('ai-key-notice').hidden, true);
  let refreshed = 0;
  ctx.initAiAnalyst = () => { refreshed += 1; };
  ctx.saveApiKeys();
  assert.equal(refreshed, 1, 'every save runs the refresh once');
});

test('the AI chat messages for a missing key point at Settings, not a topbar key', async () => {
  const { ctx, document } = await loadApp();
  const said = [];
  ctx.appendAiMessage = (role, msg) => said.push(msg);
  document.getElementById('ai-chat-input').value = 'How many cards do I own?';
  await ctx.sendAiAnalyst();
  assert.equal(said.length, 2, 'the question and the notice');
  assert.match(said[1], /Settings, API settings/);
  assert.doesNotMatch(said.join('|'), /🔑|top bar/i);
  const help = await ctx.callAI('hello', false);
  assert.match(help, /Open Settings \(the gear\), then API settings/);
  assert.doesNotMatch(help, /🔑|top bar/i);
});

test('the AI input bar lets the field shrink so Send and Clear chat never clip, and wraps with 44px buttons on a phone', () => {
  const bar = html.slice(html.indexOf('<div class="ai-input-bar">'), html.indexOf('</div>', html.indexOf('id="ai-send-btn"')) + 6);
  assert.match(bar, /<div class="ai-input-wrap">/);
  assert.match(bar, /<input id="ai-chat-input" aria-label="Ask AI Portfolio Analyst"/);
  assert.match(bar, /id="ai-send-btn"/);
  assert.match(bar, /<button class="btn btn-sm ai-clear-btn" onclick="clearAiChat\(\)" title="Clear chat" aria-label="Clear chat"/);
  assert.match(css, /\.ai-input-wrap\{flex:1 1 0;min-width:0;/, 'the field can shrink below its content width');
  assert.match(css, /\.ai-input-wrap input\{[^}]*min-width:0;width:100%/);
  assert.match(css, /\.ai-input-bar \.btn\{flex:none\}/, 'the buttons keep their width');
  // Step 3's phone block, which ends where Step 4's section (Table cleanup, v3.71) begins
  const phoneStart = css.indexOf('/* Phones: the hero stats go two-up');
  const phoneEnd = css.indexOf('/* ═══════════ Table cleanup', phoneStart);
  assert.ok(phoneStart > 0, 'the Step 3 phone block is still in the file');
  const phoneEndAt = phoneEnd > 0 ? phoneEnd : css.length;
  const phone = css.slice(css.lastIndexOf('@media(max-width:600px){', phoneEndAt), phoneEndAt);
  assert.match(phone, /\.ai-input-bar\{flex-wrap:wrap\}/);
  assert.match(phone, /\.ai-input-wrap\{flex:1 1 100%;min-height:44px\}/);
  assert.match(phone, /\.ai-input-bar \.btn\{min-height:44px/);
  assert.match(phone, /\.ai-input-bar \.ai-clear-btn\{min-width:44px\}/);
});

test('a saved chart drawn while Reports was hidden (0 px wide) is drawn again once Reports is open', async () => {
  const { ctx, timers, localStorage } = await loadApp();
  const cfg = id => ({ id, title: id, xFields: ['language'], yFields: ['costPrice'], source: 'singles', topN: 5, sort: 'desc', chartType: 'bar' });
  localStorage.setItem('pokeinv_saved_charts', JSON.stringify([cfg('hidden'), cfg('sized'), cfg('absent')]));
  ctx._savedChartInstances = { hidden: { width: 0 }, sized: { width: 640 } };
  const redrawn = [];
  ctx.initCustomChartBuilder = () => {};
  ctx.renderAllSavedCharts = () => {};
  ctx.initAiAnalyst = () => {};
  ctx._drawSavedChart = config => redrawn.push(config.id);
  const before = new Set(timers.list().map(t => t.id));
  ctx.showPage('reports');
  const timer = timers.list().filter(t => !before.has(t.id) && t.delay === 150);
  assert.equal(timer.length, 1);
  timers.invoke(timer[0].id);
  assert.deepEqual(redrawn, ['hidden'], 'only the chart that has no width is redrawn');
});

test('saving a chart says "Chart saved" and the saved chart handler is unchanged', async () => {
  const { ctx, localStorage } = await loadApp();
  const toasts = [];
  ctx.toast = msg => toasts.push(msg);
  ctx._drawSavedChart = () => {};
  ctx.cbState.x = ['language'];
  ctx.cbState.y = ['costPrice'];
  ctx.prompt = () => 'Cost by language';
  ctx.saveChartToDashboard();
  assert.match(toasts.join('|'), /^Chart saved/);
  const saved = JSON.parse(localStorage.getItem('pokeinv_saved_charts'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].title, 'Cost by language');
  assert.match(html, /onclick="saveChartToDashboard\(\)"/);
});

test('the breakdown modal uses the Overview wording', async () => {
  const { ctx, document } = await app({ singles: [single({ marketPrice: 20 })] });
  ctx.showMarketValueBreakdown();
  const modal = document.body._lastInsertedHTML;
  assert.match(modal, /Collection value · breakdown/);
  assert.match(modal, /Collection value on the Overview/);
  assert.doesNotMatch(modal, /Total Market Value|dashboard headline/);
});
