'use strict';
// Suite 16: sorting - sortItems(items, table) driven via sortState.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

test('sorting: name ascending / descending (text column)', async () => {
  const { ctx } = await loadApp();
  const items = [{ id: 1, name: 'Charizard' }, { id: 2, name: 'Blastoise' }, { id: 3, name: 'Alakazam' }];
  ctx.sortState.singles.col = 'name'; ctx.sortState.singles.dir = 1;
  const asc = plain(ctx.sortItems(items, 'singles')).map((i) => i.name);
  assert.deepStrictEqual(asc, ['Alakazam', 'Blastoise', 'Charizard']);

  ctx.sortState.singles.col = 'name'; ctx.sortState.singles.dir = -1;
  const desc = plain(ctx.sortItems(items, 'singles')).map((i) => i.name);
  assert.deepStrictEqual(desc, ['Charizard', 'Blastoise', 'Alakazam']);
});

test('sorting: marketPrice - missing/unpriced rows always sort to the bottom regardless of direction', async () => {
  const { ctx } = await loadApp();
  const items = [
    { id: 1, name: 'A', marketPrice: 100 },
    { id: 2, name: 'B', marketPrice: '' },
    { id: 3, name: 'C', marketPrice: 50 },
    { id: 4, name: 'D' }, // marketPrice entirely absent
  ];
  ctx.sortState.singles.col = 'marketPrice'; ctx.sortState.singles.dir = 1;
  const asc = plain(ctx.sortItems(items, 'singles')).map((i) => i.id);
  assert.deepStrictEqual(asc, [3, 1, 2, 4], 'priced rows ascending first (50,100), unpriced rows trail in original relative order');

  ctx.sortState.singles.dir = -1;
  const desc = plain(ctx.sortItems(items, 'singles')).map((i) => i.id);
  assert.deepStrictEqual(desc, [1, 3, 2, 4], 'priced rows descending first (100,50), unpriced STILL trail even on descending');
});

test('sorting: marketPrice - a cost-basis fallback IS used for sorting (F2: effectiveMarketInfo), interleaved among real market prices', async () => {
  const { ctx } = await loadApp();
  // sortItems' effectiveMarket() now routes through effectiveMarketInfo (F2),
  // matching the marketPrice cell, dashboard and chart builder: a row with no
  // marketPrice but a costPrice sorts by that cost-as-estimate value, landing
  // wherever it falls among real market prices, not dumped at the end.
  // Before F2 this test's old assertion ([2,1,3]) would have failed here -
  // the old effectiveMarket() only read marketPrice, so id 3 (cost-only, 60)
  // sorted as empty/0 and trailed regardless of value.
  const items = [
    { id: 1, name: 'A', marketPrice: 100 },
    { id: 2, name: 'B', marketPrice: 10 },
    { id: 3, name: 'C', costPrice: 60 }, // no marketPrice, cost-basis estimate = 60
  ];
  ctx.sortState.singles.col = 'marketPrice'; ctx.sortState.singles.dir = 1;
  const asc = plain(ctx.sortItems(items, 'singles')).map((i) => i.id);
  assert.deepStrictEqual(asc, [2, 3, 1], 'cost-estimate row (60) sorts between the two real market prices (10, 100), not trailing');
});

test('sorting: date columns sort chronologically via dateToMs, not lexicographically', async () => {
  const { ctx } = await loadApp();
  // Lexicographic order would put "13 May 2025" before "2 Jan 2026" (since
  // '1' < '2'), which is chronologically backwards.
  const items = [
    { id: 1, name: 'A', datePurchased: '13 May 2025' },
    { id: 2, name: 'B', datePurchased: '2 Jan 2026' },
    { id: 3, name: 'C', datePurchased: '1 Jan 2025' },
  ];
  ctx.sortState.singles.col = 'datePurchased'; ctx.sortState.singles.dir = 1;
  const asc = plain(ctx.sortItems(items, 'singles')).map((i) => i.id);
  assert.deepStrictEqual(asc, [3, 1, 2], 'chronological: 1 Jan 2025, 13 May 2025, 2 Jan 2026');
});

test('sorting: date columns - unparseable dates sort to the bottom (dateToMs -> 0)', async () => {
  const { ctx } = await loadApp();
  const items = [
    { id: 1, name: 'A', datePurchased: '13 May 2025' },
    { id: 2, name: 'B', datePurchased: 'garbage date' },
  ];
  ctx.sortState.singles.col = 'datePurchased'; ctx.sortState.singles.dir = 1;
  const asc = plain(ctx.sortItems(items, 'singles')).map((i) => i.id);
  assert.deepStrictEqual(asc, [1, 2], 'the unparseable date (dateToMs=0) trails even though 0 would normally sort first numerically');
});

test('sorting: slabs "grade" column uses the RESOLVED canonical grade (_resolveGrader), not the raw field', async () => {
  const { ctx } = await loadApp();
  // sl1 stores the grade INSIDE the grader field ("PSA 10", grade:"") - a raw
  // parseFloat(grade) would be NaN and wrongly sink it to the bottom.
  const items = [
    { id: 'sl1', name: 'A', grader: 'PSA 10', grade: '' },
    { id: 'sl2', name: 'B', grader: 'PSA', grade: '5' },
    { id: 'sl3', name: 'C', grader: 'PSA', grade: '9' },
  ];
  ctx.sortState.slabs.col = 'grade'; ctx.sortState.slabs.dir = 1;
  const asc = plain(ctx.sortItems(items, 'slabs')).map((i) => i.id);
  assert.deepStrictEqual(asc, ['sl2', 'sl3', 'sl1'], 'resolved grades 5, 9, 10 in ascending order - sl1\'s "PSA 10" packed grade is NOT treated as missing');
});

test('sorting: default sort (no column picked) - singles/slabs default to most-recent-first by their default date column', async () => {
  const { ctx } = await loadApp();
  ctx.sortState.singles.col = null; // never clicked a header
  const items = [
    { id: 1, name: 'Older', datePurchased: '1 Jan 2020' },
    { id: 2, name: 'Newer', datePurchased: '1 Jan 2025' },
  ];
  const result = plain(ctx.sortItems(items, 'singles')).map((i) => i.id);
  assert.deepStrictEqual(result, [2, 1], 'most-recently-added first by default, descending on datePurchased');
});

test('effectiveMarketInfo: real market price, cost-basis fallback (flagged as estimate), and the zero case', async () => {
  const { ctx } = await loadApp();
  const real = ctx.effectiveMarketInfo({ marketPrice: 120, costPrice: 80 });
  assert.deepStrictEqual(plain(real), { value: 120, isEstimate: false }, 'a real marketPrice wins outright, cost is ignored');

  const costFallback = ctx.effectiveMarketInfo({ marketPrice: '', costPrice: 45 });
  assert.deepStrictEqual(plain(costFallback), { value: 45, isEstimate: true }, 'no marketPrice falls back to costPrice, flagged as an estimate');

  const empty = ctx.effectiveMarketInfo({ marketPrice: '', costPrice: '' });
  assert.deepStrictEqual(plain(empty), { value: 0, isEstimate: true }, 'neither field set: zero value, still flagged (nothing to show)');
});
