'use strict';
// v3.78: kjrNum and kjrNumOrNull stripped the letter e, so "1e3" became 13. Four money inputs are <input type="number">, which hands the
// browser's own text to the app and writes large or small amounts in exponent form (ms-cost, ms-list, msl-list, qs-cost, and their
// neighbours ms-market and msl-market). 1e3 typed into Cost saved a cost of 13, and the Quick Sale profit line read it the same way, a
// different number to the one the sale itself saved (confirmQuickSell uses kjrParseNonNegativeNumber, which always read exponents).
// Each lenient parser now runs two steps: _kjrPlainNumber (app.js) reads a clean number, exponent form included, with the currency marks
// (S$, US$, SGD, USD, $), commas and spaces off, and only text that is not a clean number falls to the old strip-the-letters regex. So
// "(50)" is still 50 and "12-5" still 12. The same two steps run in kjrMoneyStr, _kjrFmtCurrency (kjrFmt, fmtUsd) and normalizeRecord, which
// keeps its own copy of the call in app.js because app.js loads before features.js and must not lean on kjrNum.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, plain, ROOT } = require('./harness.js');

// The four parsers exactly as they were before v3.78, for the parity check below.
const OLD = {
  kjrNum(n) {
    if (n == null || n === '') return 0;
    if (typeof n === 'number') return isFinite(n) ? n : 0;
    const x = parseFloat(String(n).replace(/[^0-9.\-]/g, ''));
    return isNaN(x) ? 0 : x;
  },
  kjrNumOrNull(n) {
    if (n == null) return null;
    if (typeof n === 'number') return isFinite(n) ? n : null;
    const cleaned = String(n).replace(/[^0-9.\-]/g, '');
    if (!/\d/.test(cleaned)) return null;
    const x = parseFloat(cleaned);
    return isNaN(x) ? null : x;
  },
  kjrMoneyStr(val) {
    if (val == null || val === '') return '';
    const cleaned = String(val).replace(/[^0-9.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return '';
    const n = parseFloat(cleaned);
    return isNaN(n) ? '' : String(n);
  },
  normalizeNumber(value) {
    if (value === '' || value == null) return value;
    const v = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
    return isNaN(v) ? '' : v;
  },
};

// [input, kjrNum, kjrNumOrNull, kjrMoneyStr]: what the exponent forms read as now
const EXPONENT_CASES = [
  ['1e3', 1000, 1000, '1000'],
  ['1E3', 1000, 1000, '1000'],
  ['-1.5e2', -150, -150, '-150'],
  ['1e-2', 0.01, 0.01, '0.01'],
  ['2.5E+3', 2500, 2500, '2500'],
  ['.5e1', 5, 5, '5'],
  ['5.e1', 50, 50, '50'],
  ['+1e1', 10, 10, '10'],
  ['1e0', 1, 1, '1'],
  ['0e5', 0, 0, '0'],
  [' 1e3 ', 1000, 1000, '1000'],
  ['S$1e3', 1000, 1000, '1000'],
  ['US$ 1e3', 1000, 1000, '1000'],
  ['SGD 1.5e3', 1500, 1500, '1500'],
  ['1e3 SGD', 1000, 1000, '1000'],
  ['$1e3', 1000, 1000, '1000'],
  ['1e3USD', 1000, 1000, '1000'],
];
// the cases the packet names, and the neighbours that must not move
const PLAIN_CASES = [
  ['S$1,250', 1250, 1250, '1250'],
  ['1,250.50', 1250.5, 1250.5, '1250.5'],
  ['$1,250.50', 1250.5, 1250.5, '1250.5'],
  ['155', 155, 155, '155'],
  ['155.5', 155.5, 155.5, '155.5'],
  [' 155 ', 155, 155, '155'],
  ['S$ 155', 155, 155, '155'],
  ['SGD 155', 155, 155, '155'],
  ['155 SGD', 155, 155, '155'],
  ['US$155', 155, 155, '155'],
  ['-5', -5, -5, '-5'],
  ['+5', 5, 5, '5'],
  ['.5', 0.5, 0.5, '0.5'],
  ['5.', 5, 5, '5'],
  ['0', 0, 0, '0'],
  ['0.00', 0, 0, '0'],
  ['(50)', 50, 50, '50'], // accounting brackets lose their sign, exactly as before
  ['12-5', 12, 12, '12'],
  ['5 pcs', 5, 5, '5'],
  ['1.2.3', 1.2, 1.2, '1.2'],
  ['', 0, null, ''],
  ['   ', 0, null, ''],
  ['abc', 0, null, ''],
  ['$', 0, null, ''],
  ['S$', 0, null, ''],
  ['-', 0, null, ''],
  ['.', 0, null, ''],
  ['--5', 0, null, ''],
  [null, 0, null, ''],
  [undefined, 0, null, ''],
];

test('num-exponent: kjrNum, kjrNumOrNull and kjrMoneyStr read exponent form as the number it is', async () => {
  const { ctx } = await loadApp();
  for (const [input, num, orNull, str] of EXPONENT_CASES) {
    assert.strictEqual(ctx.kjrNum(input), num, 'kjrNum ' + JSON.stringify(input));
    assert.strictEqual(ctx.kjrNumOrNull(input), orNull, 'kjrNumOrNull ' + JSON.stringify(input));
    assert.strictEqual(ctx.kjrMoneyStr(input), str, 'kjrMoneyStr ' + JSON.stringify(input));
  }
});

test('num-exponent: plain numbers, currency text, brackets, blanks and junk read exactly as they did', async () => {
  const { ctx } = await loadApp();
  for (const [input, num, orNull, str] of PLAIN_CASES) {
    assert.strictEqual(ctx.kjrNum(input), num, 'kjrNum ' + JSON.stringify(input));
    assert.strictEqual(ctx.kjrNumOrNull(input), orNull, 'kjrNumOrNull ' + JSON.stringify(input));
    assert.strictEqual(ctx.kjrMoneyStr(input), str, 'kjrMoneyStr ' + JSON.stringify(input));
  }
  // the three the packet asks for by name
  assert.strictEqual(ctx.kjrNumOrNull(''), null, 'a blank optional field is still no value, never 0');
  assert.strictEqual(ctx.kjrNum(''), 0, 'and kjrNum still says 0 for the cost, total and fee callers');
  assert.strictEqual(ctx.kjrNum(null), 0);
  // real numbers take the number path, untouched
  assert.strictEqual(ctx.kjrNum(1000), 1000);
  assert.strictEqual(ctx.kjrNum(Infinity), 0);
  assert.strictEqual(ctx.kjrNumOrNull(NaN), null);
  assert.ok(Object.is(ctx.kjrNumOrNull('0'), 0) && Object.is(ctx.kjrNumOrNull(0), 0));
});

test('num-exponent: every other kind of text still goes the old way, so the fix moves nothing but the exponent forms', async () => {
  const { ctx } = await loadApp();
  // text that is not a clean number keeps the strip-the-letters reading, hex and words included, and a clean number reads the same
  // either way when it has no exponent. So over all of these the new parsers and the old ones agree to the last digit.
  const corpus = [
    '', ' ', '5', '05', '155', '155.5', '-5', '+5', '.5', '5.', '0.1', '1,250', '1.250,50', '1 000', '1 000', '1,2,3',
    '$155', 'S$ 155', 'US$155', 'SGD 155', '155 SGD', '$1,250.50', '(50)', '12-5', '5 pcs', '1.2.3', '--5', '..5', '5-', '-5-',
    'abc', '$', '-', '.', 'S$', '12abc', 'abc12', 'a1b2c3', '٣', '0x10', '0b11', '1_000', '−5', 'NaN', 'Infinity', '-Infinity', 'null',
    'undefined', 'true', '1e', 'e5', '1e+', '1ee3', '1e3.5', '1e3e', '12e3x', '1 e 3 pieces', 'two', '5k', '5%', '5/2', '1/2e3',
  ];
  for (const input of corpus) {
    assert.strictEqual(ctx.kjrNum(input), OLD.kjrNum(input), 'kjrNum ' + JSON.stringify(input));
    assert.strictEqual(ctx.kjrNumOrNull(input), OLD.kjrNumOrNull(input), 'kjrNumOrNull ' + JSON.stringify(input));
    assert.strictEqual(ctx.kjrMoneyStr(input), OLD.kjrMoneyStr(input), 'kjrMoneyStr ' + JSON.stringify(input));
    assert.strictEqual(plain(ctx.normalizeRecord('singles', { costPrice: input })).costPrice, input === '' ? '' : OLD.normalizeNumber(input), 'normalizeRecord ' + JSON.stringify(input));
  }
  // and non-string input (numbers, booleans, arrays, objects) is as it was
  for (const input of [0, 1, -1, 1.5, 1e21, 1e-7, true, false, [], [5], {}, NaN, Infinity]) {
    assert.strictEqual(ctx.kjrNum(input), OLD.kjrNum(input), 'kjrNum ' + String(input));
    assert.strictEqual(ctx.kjrNumOrNull(input), OLD.kjrNumOrNull(input), 'kjrNumOrNull ' + String(input));
  }
});

test('num-exponent: kjrFmt and fmtUsd show an exponent amount as the amount it is', async () => {
  const { ctx } = await loadApp();
  assert.equal(ctx.kjrFmt('1e3'), 'S$1,000');
  assert.equal(ctx.kjrFmt('2.5E2'), 'S$250');
  assert.equal(ctx.kjrFmt('S$1e3'), 'S$1,000');
  assert.equal(ctx.fmtUsd('1e3'), 'US$1,000');
  assert.equal(ctx.fmtUsd('$1.5e2'), 'US$150');
  assert.equal(ctx.kjrFmt('1,250'), 'S$1,250');
  // the pinned behaviour of the rest: blanks stay blank, an explicit zero stays visible
  assert.equal(ctx.kjrFmt('0.00'), 'S$0');
  assert.equal(ctx.kjrFmt(0), 'S$0');
  for (const blank of ['', '   ', null, undefined, 'garbage', '.', '-', '$']) assert.equal(ctx.kjrFmt(blank), '', JSON.stringify(blank));
  assert.equal(ctx.kjrFmt(45.6), 'S$46');
  assert.equal(ctx.kjrFmt('(50)'), 'S$50');
  // a number the language writes in exponent form when it becomes text (1e21, 1e-7) no longer loses its letter on the way back in
  assert.equal(ctx.kjrFmt(1e-7), 'S$0');
  assert.equal(ctx.kjrFmt(1e21), 'S$' + Math.round(1e21).toLocaleString('en-SG'));
});

test('num-exponent: normalizeRecord reads every money field the same way, and a number the language wrote with an e survives it', async () => {
  const { ctx } = await loadApp();
  const keys = ['costPrice', 'marketPrice', 'listPrice', 'unitPrice', 'totalPrice', 'totalCollected', 'shippingCost', 'profit', 'priceUsd', 'freightSgd', 'totalSgd', 'priceAlert'];
  const typed = Object.fromEntries(keys.map((k, i) => [k, i % 2 ? '2.5E2' : '1e3']));
  const out = plain(ctx.normalizeRecord('singles', { name: ' Card ', qty: '2e0', ...typed }));
  for (const [i, k] of keys.entries()) assert.strictEqual(out[k], i % 2 ? 250 : 1000, k);
  assert.strictEqual(out.qty, 2, 'a quantity too: 2e0 is 2');
  assert.strictEqual(plain(ctx.normalizeRecord('singles', { qty: '1e1' })).qty, 10);
  assert.strictEqual(plain(ctx.normalizeRecord('singles', { qty: '0.2e1' })).qty, 2);
  assert.strictEqual(out.name, 'Card', 'the rest of the normalizer is untouched');
  // text that is not a number, brackets, currency marks and blanks: as before
  const rest = plain(ctx.normalizeRecord('singles', { costPrice: '$1,250.50', marketPrice: '(50)', listPrice: 'abc', unitPrice: '', totalPrice: null, priceUsd: undefined }));
  assert.strictEqual(rest.costPrice, 1250.5);
  assert.strictEqual(rest.marketPrice, 50);
  assert.strictEqual(rest.listPrice, '');
  assert.strictEqual(rest.unitPrice, '');
  assert.strictEqual(rest.totalPrice, null);
  assert.strictEqual(rest.priceUsd, undefined);
  // JavaScript writes 1e21 and 1e-7 with an e when it turns them into text. The old strip made them 121 and 1.
  assert.strictEqual(plain(ctx.normalizeRecord('singles', { costPrice: 1e21 })).costPrice, 1e21);
  assert.strictEqual(plain(ctx.normalizeRecord('singles', { costPrice: 1e-7 })).costPrice, 1e-7);
  assert.strictEqual(plain(ctx.normalizeRecord('singles', { costPrice: NaN })).costPrice, '', 'NaN is still dropped');
  assert.strictEqual(plain(ctx.normalizeRecord('singles', { costPrice: Infinity })).costPrice, '', 'and so is Infinity');
});

test('num-exponent: normalizeRecord is self-contained in app.js, the shared reader is defined there and features.js only calls it', () => {
  const app = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const features = fs.readFileSync(ROOT + '/features.js', 'utf8');
  assert.match(app, /\nfunction _kjrPlainNumber\(raw\) \{/);
  assert.doesNotMatch(features, /function _kjrPlainNumber/, 'one definition, in the file that loads first');
  assert.ok(app.indexOf('function _kjrPlainNumber(') < app.indexOf('function normalizeRecord('), 'defined before the normalizer that calls it');
  const start = app.indexOf('function normalizeRecord(');
  const body = app.slice(start, app.indexOf('\nfunction ', start + 10));
  assert.match(body, /_kjrPlainNumber\(out\[k\]\)/);
  assert.doesNotMatch(body, /\bkjr(?:Num|NumOrNull|MoneyStr)\(|_kjrFmtCurrency\(/, 'app.js loads before features.js, so the normalizer never calls into it');
  // the same two steps in the four features.js helpers, the strip regex still the second step
  for (const name of ['kjrNum', 'kjrNumOrNull', 'kjrMoneyStr', '_kjrFmtCurrency']) {
    const at = features.indexOf('function ' + name + '(');
    assert.ok(at > 0, name);
    const fn = features.slice(at, features.indexOf('\n}', at));
    assert.match(fn, /_kjrPlainNumber\(/, name + ' reads a clean number first');
    assert.match(fn, /replace\(\/\[\^0-9\.\\-\]\/g, ''\)/, name + ' still falls back to the strip');
  }
});

test('num-exponent: the Add Single and Add Slab forms save "1e3" as 1000 in cost, market and Carousell price', async () => {
  const { ctx, document } = await loadApp({ seed: { singles: [], slabs: [] } });
  const toasts = [];
  ctx.toast = (m) => toasts.push(String(m));
  const set = (id, value) => { document.getElementById(id).value = value; };
  ctx.openAddSingle();
  set('ms-name', 'Exponent single'); set('ms-cost', '1e3'); set('ms-market', '2.5E2'); set('ms-list', '1.5e2');
  await ctx.saveSingle();
  assert.ok(toasts.includes('Added!'), JSON.stringify(toasts));
  const single = ctx.DB.singles.at(-1);
  assert.deepEqual([single.costPrice, single.marketPrice, single.listPrice], [1000, 250, 150]);
  ctx.openAddSlab();
  set('msl-name', 'Exponent slab'); set('msl-cost', '1e3'); set('msl-market', '2.5E2'); set('msl-list', '1.5e2');
  await ctx.saveSlab();
  const slab = ctx.DB.slabs.at(-1);
  assert.deepEqual([slab.costPrice, slab.marketPrice, slab.listPrice], [1000, 250, 150]);
  // a blank Carousell price is still no price, next to the exponent ones
  ctx.openAddSingle();
  set('ms-name', 'Blank list'); set('ms-cost', '1e3'); set('ms-list', '');
  await ctx.saveSingle();
  const blank = ctx.DB.singles.at(-1);
  assert.deepEqual([blank.costPrice, blank.listPrice], [1000, null]);
});

test('num-exponent: the Quick Sale profit line reads "1e3" in Cost as 1000, the number the sale itself saves', async () => {
  const { ctx, document } = await loadApp({ seed: { singles: [], slabs: [] } });
  const set = (id, value) => { document.getElementById(id).value = value; };
  set('qs-cost', '1e3'); set('qs-total', '1500'); set('qs-ship', ''); set('qs-fees', '');
  ctx.calcQsProfit();
  assert.equal(document.getElementById('qs-profit').value, '+S$500  (33% margin)', 'it was +S$1487 (99% margin), the cost read as 13');
  set('qs-cost', '1,000'); ctx.calcQsProfit();
  assert.equal(document.getElementById('qs-profit').value, '+S$500  (33% margin)');
  // and the sale path that always read exponents agrees with it
  assert.deepEqual(plain(ctx.kjrParseNonNegativeNumber('1e3', { label: 'Cost price', allowBlank: true, blankValue: 0 })), { ok: true, value: 1000, blank: false });
});
