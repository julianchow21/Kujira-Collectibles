'use strict';
// Suite 15: profit-money - cmdCalcProfit, calcQsProfit, calcSaleProfit,
// computeDashboardStats, runHealthCheck.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

const SAMPLE = { total: 250, cost: 100, ship: 10, fees: 12 }; // profit 128, margin 51.2% -> "51%"

test('profit-money: calcQsProfit - {total 250, cost 100, ship 10, fees 12} -> +S$128 (51% margin)', async () => {
  const { ctx } = await loadApp();
  ctx.document.getElementById('qs-cost').value = String(SAMPLE.cost);
  ctx.document.getElementById('qs-total').value = String(SAMPLE.total);
  ctx.document.getElementById('qs-ship').value = String(SAMPLE.ship);
  ctx.document.getElementById('qs-fees').value = String(SAMPLE.fees);
  ctx.calcQsProfit();
  const out = ctx.document.getElementById('qs-profit').value;
  assert.match(out, /\+S\$128/);
  assert.match(out, /51%/);
});

test('profit-money: calcSaleProfit - identical inputs -> the same 128 profit / 51% margin, in its own field shapes', async () => {
  const { ctx } = await loadApp();
  ctx.document.getElementById('msa-cost').value = String(SAMPLE.cost);
  ctx.document.getElementById('msa-total').value = String(SAMPLE.total);
  ctx.document.getElementById('msa-ship').value = String(SAMPLE.ship);
  ctx.document.getElementById('msa-fees').value = String(SAMPLE.fees);
  ctx.calcSaleProfit();
  assert.strictEqual(ctx.document.getElementById('msa-profit').value, '+128', 'plain signed number, no S$ prefix (different shape to calcQsProfit)');
  assert.strictEqual(ctx.document.getElementById('msa-margin').value, '51%');
});

test('profit-money: cmdCalcProfit - a single-line cart with the same {250,100,10,12} shape -> the same 128/51%', async () => {
  const { ctx } = await loadApp();
  ctx.cmdSellCart = [{ _table: 'slabs', id: 'x1', costPrice: SAMPLE.cost, qty: 1, price: SAMPLE.total }];
  ctx.document.getElementById('cmd-sell-ship').value = String(SAMPLE.ship);
  ctx.document.getElementById('cmd-sell-fees').value = String(SAMPLE.fees);
  ctx.cmdCalcProfit();
  const html = ctx.document.getElementById('cmd-sell-profit-preview').innerHTML;
  assert.match(html, /\+S\$128/);
  assert.match(html, />51%</);
});

test('profit-money: all three profit calculators agree exactly on the sample figures', async () => {
  const { ctx } = await loadApp();
  ctx.document.getElementById('qs-cost').value = '100'; ctx.document.getElementById('qs-total').value = '250';
  ctx.document.getElementById('qs-ship').value = '10'; ctx.document.getElementById('qs-fees').value = '12';
  ctx.calcQsProfit();
  ctx.document.getElementById('msa-cost').value = '100'; ctx.document.getElementById('msa-total').value = '250';
  ctx.document.getElementById('msa-ship').value = '10'; ctx.document.getElementById('msa-fees').value = '12';
  ctx.calcSaleProfit();
  ctx.cmdSellCart = [{ _table: 'slabs', id: 'x1', costPrice: 100, qty: 1, price: 250 }];
  ctx.document.getElementById('cmd-sell-ship').value = '10'; ctx.document.getElementById('cmd-sell-fees').value = '12';
  ctx.cmdCalcProfit();
  assert.match(ctx.document.getElementById('qs-profit').value, /128/);
  assert.match(ctx.document.getElementById('msa-profit').value, /128/);
  assert.match(ctx.document.getElementById('cmd-sell-profit-preview').innerHTML, /128/);
});

test('profit-money: calcQsProfit/calcSaleProfit - zero/empty fields do not throw and read as 0', async () => {
  const { ctx } = await loadApp();
  ['qs-cost', 'qs-total', 'qs-ship', 'qs-fees'].forEach((id) => { ctx.document.getElementById(id).value = ''; });
  assert.doesNotThrow(() => ctx.calcQsProfit());
  assert.match(ctx.document.getElementById('qs-profit').value, /\bS\$0\b/, 'all-zero inputs -> S$0, and total=0 skips the margin suffix entirely');

  ['msa-cost', 'msa-total', 'msa-ship', 'msa-fees'].forEach((id) => { ctx.document.getElementById(id).value = ''; });
  assert.doesNotThrow(() => ctx.calcSaleProfit());
  assert.strictEqual(ctx.document.getElementById('msa-profit').value, '0');
  assert.strictEqual(ctx.document.getElementById('msa-margin').value, '-', 'total=0 -> margin renders as "-", not a divide-by-zero artefact');
});

test('profit-money: cmdCalcProfit - an empty cart shows the "add items" placeholder rather than S$0', async () => {
  const { ctx } = await loadApp();
  ctx.cmdSellCart = [];
  ctx.document.getElementById('cmd-sell-ship').value = '0';
  ctx.document.getElementById('cmd-sell-fees').value = '0';
  ctx.cmdCalcProfit();
  assert.match(ctx.document.getElementById('cmd-sell-profit-preview').innerHTML, /Add items to see totals/);
});

test('profit-money: computeDashboardStats - hand-computed cost/market sums against a small seeded DB (dash-range=all)', async () => {
  const { ctx, grab } = await loadApp({
    seed: {
      singles: [
        { id: 's1', name: 'A', status: 'Available', costPrice: 10, marketPrice: 15, qty: 1 },
        { id: 's2', name: 'B', status: 'Available', costPrice: 20, marketPrice: '', qty: 2 }, // no market price -> falls back to cost*qty for the headline
        { id: 's3', name: 'C', status: 'Sold', costPrice: 999, marketPrice: 999, qty: 1 }, // excluded (sold)
      ],
      slabs: [{ id: 'sl1', name: 'D', status: 'Available', costPrice: 100, marketPrice: 150 }],
      etbs: [{ id: 'e1', status: 'In Stock', totalPrice: 50, marketPrice: 60 }],
      sales: [{ id: 'sale1', dateSold: '1 Jan 2025', totalCollected: 300, profit: 100 }],
    },
  });
  ctx.document.getElementById('dash-range').value = 'all';
  const stats = plain(ctx.computeDashboardStats());

  // invCostSingles: (10*1) + (20*2) = 50 (sold s3 excluded)
  assert.strictEqual(stats.invCostSingles, 50);
  assert.strictEqual(stats.invCostSlabs, 100);
  // mktSingles: s1 explicit market 15*1=15; s2 has no market -> falls back to cost 20*2=40 -> total 55
  assert.strictEqual(stats.mktSingles, 55);
  assert.strictEqual(stats.mktSlabs, 150);
  assert.strictEqual(stats.totalMktValue, 205, 'singles+slabs only, sealed excluded from the headline');
  assert.strictEqual(stats.unrealisedPL, 205 - (50 + 100));
  assert.strictEqual(stats.invCostEtb, 50);
  assert.strictEqual(stats.mktEtb, 60);
  assert.strictEqual(stats.allTimeRevenue, 300);
  assert.strictEqual(stats.allTimeProfit, 100);
  assert.strictEqual(stats.singlesAvail, 2);
  assert.strictEqual(stats.singlesSold, 1);
});

test('profit-money: computeDashboardStats - an empty DB never produces NaN in any numeric stat', async () => {
  const { ctx } = await loadApp({ seed: { singles: [{ id: 'gate_row', status: 'Sold', costPrice: 0 }] } }); // keeps the local-fast-path gate happy, but excluded from every Available-only sum
  ctx.document.getElementById('dash-range').value = 'all';
  const stats = plain(ctx.computeDashboardStats());
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v === 'number') assert.ok(!Number.isNaN(v), `${k} must not be NaN`);
  }
  assert.strictEqual(stats.roiPct, null, 'no sales at all -> null, not NaN or a false 0%');
});

test('profit-money: SUSPECT - computeDashboardStats silently reports ZERO date-ranged sales when dash-range is blank/unrecognised (not "all-time")', async () => {
  const { ctx, grab } = await loadApp({
    seed: { sales: [{ id: 'sale1', dateSold: '1 Jan 2025', totalCollected: 300, profit: 100 }] },
  });
  // getDateRange(): `const val = sel ? sel.value : '12'`. In PRODUCTION,
  // document.getElementById('dash-range') actually returns null (that id
  // does not exist anywhere in index.html today - grep confirms zero
  // matches), so real usage always falls back to '12' months. Our stub
  // never returns null (per the harness's permissive-DOM spec), so a
  // never-set stub .value defaults to '' - NOT 'all' and NOT a parseable
  // number. parseInt('') is NaN, cutoff.setMonth(NaN) produces a truthy but
  // Invalid Date, and `new Date(...) >= <Invalid Date>` is always false, so
  // EVERY sale gets filtered out of the date-ranged stats. This is a
  // harness-vs-production divergence (production never hits the blank-value
  // path since the element does not exist there) rather than a live app
  // bug, but it does disprove the "empty string = all-time" assumption
  // outright: getDateRange do NOT treat '' as all-time, it silently
  // produces zero results instead. Severity: cosmetic (dashboard chart data
  // only) if this id is ever re-added to index.html without a default value.
  const stats = plain(ctx.computeDashboardStats());
  assert.strictEqual(stats.filteredSales.length, 0, 'the sale is silently excluded from the date-ranged view');
  assert.strictEqual(stats.totalRevenue, 0);
  // The lifetime KPI tiles are unaffected (by design, cutoff never applies to them).
  assert.strictEqual(stats.allTimeRevenue, 300);
});

test('profit-money: runHealthCheck - a clean DB raises no fail/warn findings (info-level chips still appear)', async () => {
  const { ctx } = await loadApp({
    seed: {
      singles: [{ id: 's1', name: 'Clean', status: 'Available', costPrice: 10, marketPrice: 15, datePurchased: '1 Jan 2025' }],
    },
  });
  ctx.runHealthCheck();
  const { findings } = ctx.window._lastHealthFindings ? { findings: plain(ctx.window._lastHealthFindings) } : { findings: plain(ctx._lastHealthFindings) };
  const actionable = findings.filter((f) => f.sev === 'fail' || f.sev === 'warn');
  assert.deepStrictEqual(actionable, [], 'a clean DB has zero fail/warn findings (info-level Dashboard/Sync chips always appear regardless)');
});

test('profit-money: runHealthCheck - flags duplicate sale ids, negative cost, absurd market, duplicate slab certNo, and an orphaned sale link', async () => {
  const { ctx } = await loadApp({
    seed: {
      singles: [
        { id: 's1', name: 'NegCost', status: 'Available', costPrice: -5 },
        { id: 's2', name: 'Absurd', status: 'Available', costPrice: 10, marketPrice: 10000 }, // >50x cost
      ],
      slabs: [
        { id: 'sl1', name: 'DupCert', grader: 'PSA', certNo: '12345', status: 'Available' },
        { id: 'sl2', name: 'DupCert2', grader: 'PSA', certNo: '12345', status: 'Available' },
      ],
      sales: [
        { id: 'dup1', product: 'X', dateSold: '1 Jan 2025', inventoryId: 'missing_id', inventoryTable: 'singles' },
        { id: 'dup1', product: 'X duplicate id', dateSold: '1 Jan 2025' },
      ],
    },
  });
  ctx.runHealthCheck();
  const findings = plain(ctx._lastHealthFindings);
  const areas = findings.map((f) => f.area + ':' + f.sev);
  assert.ok(findings.some((f) => f.area === 'Pricing' && f.message.includes('negative cost')));
  assert.ok(findings.some((f) => f.area === 'Pricing' && f.message.includes('50')));
  assert.ok(findings.some((f) => f.area === 'Slabs' && f.message.includes('cert')));
  assert.ok(findings.some((f) => f.area === 'Sales' && f.message.includes('reference no inventory') === false && f.sev === 'fail'), 'the duplicate sale id is a fail');
  assert.ok(findings.some((f) => f.area === 'Sales' && f.sev === 'warn'), 'the orphaned inventory link is a warn');
});
