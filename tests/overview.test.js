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
  for (const id of ['dash-top', 'dash-movers', 'dash-sales']) {
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
  assert.match(text(document, 'dash-exposure-body'), /Add some inventory to see exposure breakdown/);
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

// ── Where the money sits ────────────────────────────────────────────────────

test('exposure card: keeps the pinned ids, shows amount and share, and the Sealed disclosure keeps its state across a re-render', async () => {
  const { ctx, document } = await app({
    singles: [single({ costPrice: 600, marketPrice: 700 })],
    slabs: [slab({ costPrice: 300, marketPrice: 350 })],
    etbs: [{ id: 'e1', status: 'In Stock', totalPrice: 100, marketPrice: 120 }],
  });
  ctx.renderDashboard();
  const markup = text(document, 'dash-exposure-body');
  assert.match(markup, /id="exp-toggle-sealed"/);
  assert.match(markup, /id="exp-sub-sealed" class="exp-sub" style="display:none"/);
  assert.match(markup, /class="exp-amt">S\$600<\/span><span class="exp-pct">60%/);
  assert.match(markup, /class="exp-amt">S\$300<\/span><span class="exp-pct">30%/);
  assert.match(markup, /class="exp-amt">S\$100<\/span><span class="exp-pct">10%/);
  assert.match(markup, /class="ov-seg exp-seg-singles"/);

  document.getElementById('exp-sub-sealed').style.display = 'none'; // what the browser has after the first render
  ctx._toggleExposureSub('sealed');
  ctx.renderDashboard();
  const open = text(document, 'dash-exposure-body');
  assert.match(open, /id="exp-toggle-sealed"[^>]*aria-expanded="true"/);
  assert.match(open, /id="exp-sub-sealed" class="exp-sub" style="display:block"/);
  ctx._toggleExposureSub('sealed');
  ctx.renderDashboard();
  assert.match(text(document, 'dash-exposure-body'), /id="exp-toggle-sealed"[^>]*aria-expanded="false"/);
});

test('exposure card: a type with nothing in it is a plain muted row, not a disclosure', async () => {
  const { ctx, document } = await app({ singles: [single({ costPrice: 50, marketPrice: 60 })] });
  ctx.renderDashboard();
  const markup = text(document, 'dash-exposure-body');
  assert.match(markup, /Slabs<span class="exp-count"> · none<\/span>/);
  assert.match(markup, /Sealed<span class="exp-count"> · none in stock<\/span>/);
  assert.doesNotMatch(markup, /exp-toggle-sealed/);
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

test('tiles and rows open the existing edit modal by table, the text buttons go where they say', async () => {
  const { ctx } = await app({ singles: [single({ id: 'one' })], slabs: [slab({ id: 'two' }), slab({ id: 3, name: 'Numeric id' })] });
  const calls = [];
  const toasts = [];
  ctx.toast = msg => toasts.push(msg);
  ctx.openEditSingle = id => calls.push(['single', id]);
  ctx.openEditSlab = id => calls.push(['slab', id]);
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
    ['single', 'one'], ['slab', 'two'], ['slab', 3], ['page', 'inventory'], ['page', 'sales'], ['unresolved'], ['breakdown'], ['add'],
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

test('Reports is registered with More: the page set, the desktop dropdown, the mobile sheet and the Dealer preview list', async () => {
  const { ctx } = await loadApp();
  assert.ok(ctx.MORE_PAGES.has('reports'));
  assert.match(html, /<button class="nav-dd-item" onclick="showPage\('reports'\);closeNavDD\(\)">/);
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
  const phone = css.slice(css.lastIndexOf('@media(max-width:600px){'));
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
