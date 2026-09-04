'use strict';
// Suite 2: dates - toDateMmmYyyy, toIsoDateStr, dateToMs, normaliseToMonthYear,
// _monthIdxFromString, _parseHistDate, _kjrDaysHeld.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, isDate, plain } = require('./harness.js');

test('dates: toDateMmmYyyy - ISO "2025-08-23" -> "23 Aug 2025"', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toDateMmmYyyy('2025-08-23'), '23 Aug 2025');
});

test('dates: toDateMmmYyyy - DD/MM/YYYY "23/08/2025" -> "23 Aug 2025"', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toDateMmmYyyy('23/08/2025'), '23 Aug 2025');
});

test('dates: toDateMmmYyyy - already-canonical "23 Aug 2025" passes through unchanged', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toDateMmmYyyy('23 Aug 2025'), '23 Aug 2025');
});

test('dates: toDateMmmYyyy - full month-name input normalises to 3-letter abbreviation', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toDateMmmYyyy('23 August 2025'), '23 Aug 2025');
  assert.strictEqual(ctx.toDateMmmYyyy('September 2025'), '1 Sep 2025'); // "MMM YYYY" only branch -> day defaults to 1
});

test('dates: toDateMmmYyyy - single-digit day, no leading zero in output', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toDateMmmYyyy('2025-08-03'), '3 Aug 2025');
  assert.strictEqual(ctx.toDateMmmYyyy('03 Aug 2025'), '3 Aug 2025');
});

test('dates: toDateMmmYyyy - impossible calendar dates stay as raw text', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toDateMmmYyyy('2025-02-29'), '2025-02-29', 'non-leap-year ISO date remains correctable raw input');
  assert.strictEqual(ctx.toDateMmmYyyy('30 Feb 2025'), '30 Feb 2025');
  assert.strictEqual(ctx.toDateMmmYyyy('31/04/2025'), '31/04/2025');
  assert.strictEqual(ctx.toDateMmmYyyy('2025-08-23 trailing text'), '2025-08-23 trailing text');
});

test('dates: toDateMmmYyyy - leap-day input is accepted only in a leap year', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toDateMmmYyyy('2024-02-29'), '29 Feb 2024');
  assert.strictEqual(ctx.toDateMmmYyyy('29 Feb 2024'), '29 Feb 2024');
});

test('dates: toDateMmmYyyy - garbage input returns the trimmed original string unchanged', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toDateMmmYyyy('not a real date'), 'not a real date');
  assert.strictEqual(ctx.toDateMmmYyyy('  spaced garbage  '), 'spaced garbage');
});

test('dates: toDateMmmYyyy - null/empty -> empty string', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toDateMmmYyyy(null), '');
  assert.strictEqual(ctx.toDateMmmYyyy(''), '');
  assert.strictEqual(ctx.toDateMmmYyyy(undefined), '');
});

test('dates: toIsoDateStr - valid input -> YYYY-MM-DD', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toIsoDateStr('23 Aug 2025'), '2025-08-23');
  assert.strictEqual(ctx.toIsoDateStr('2025-08-23'), '2025-08-23');
  assert.strictEqual(ctx.toIsoDateStr('3 Aug 2025'), '2025-08-03', 'single-digit day is zero-padded going into ISO form');
});

test('dates: toIsoDateStr - garbage input -> empty string', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toIsoDateStr('not a real date'), '');
  assert.strictEqual(ctx.toIsoDateStr(''), '');
});

test('dates: toIsoDateStr - impossible dates -> empty string', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.toIsoDateStr('2025-02-29'), '');
  assert.strictEqual(ctx.toIsoDateStr('30 Feb 2025'), '');
  assert.strictEqual(ctx.toIsoDateStr('31/04/2025'), '');
  assert.strictEqual(ctx.toIsoDateStr('29 Feb 2024'), '2024-02-29');
});

test('dates: dateToMs - valid input -> ms consistent with a native Date', async () => {
  const { ctx } = await loadApp();
  const ms = ctx.dateToMs('23 Aug 2025');
  const expected = new Date(2025, 7, 23).getTime();
  assert.strictEqual(ms, expected);
});

test('dates: dateToMs - malformed input -> NaN, not epoch zero', async () => {
  const { ctx } = await loadApp();
  assert.ok(Number.isNaN(ctx.dateToMs('not a real date')));
  assert.ok(Number.isNaN(ctx.dateToMs('')));
  assert.ok(Number.isFinite(ctx.dateToMs('1 Jan 1970')), 'a real epoch-era date remains distinguishable from malformed input');
});

test('dates: dateToMs - preserves invalid raw text without treating it as a date', async () => {
  const { ctx } = await loadApp();
  const garbage = 'complete nonsense 12345';
  const dateResult = ctx.toDateMmmYyyy(garbage);
  const msResult = ctx.dateToMs(garbage);
  assert.strictEqual(dateResult, garbage);
  assert.ok(Number.isNaN(msResult));
});

test('dates: kjrApplySort - eBay default and date directions keep invalid dates last', async () => {
  const { ctx } = await loadApp();
  const rows = [
    { id: 'bad', date: '30 Feb 2025' },
    { id: 'old', date: '1 Jan 2020' },
    { id: 'new', date: '1 Jan 2026' },
  ];
  const defaultSort = plain(ctx.kjrApplySort(rows, 'ebayPurchases')).map(row => row.id);
  assert.deepStrictEqual(defaultSort, ['new', 'old', 'bad'], 'default eBay date sort is newest first with invalid dates last');

  ctx._kjrSort.ebayPurchases.k = 'date';
  ctx._kjrSort.ebayPurchases.dir = 1;
  assert.deepStrictEqual(plain(ctx.kjrApplySort(rows, 'ebayPurchases')).map(row => row.id), ['old', 'new', 'bad']);
  ctx._kjrSort.ebayPurchases.dir = -1;
  assert.deepStrictEqual(plain(ctx.kjrApplySort(rows, 'ebayPurchases')).map(row => row.id), ['new', 'old', 'bad']);
});

test('dates: _kjrXlsxParseDate - only finite dateToMs values become Dates', async () => {
  const { ctx } = await loadApp();
  const valid = ctx._kjrXlsxParseDate('23 Aug 2025');
  assert.ok(isDate(valid) && Number.isFinite(valid.getTime()));
  assert.strictEqual(ctx._kjrXlsxParseDate('30 Feb 2025'), null);
  assert.strictEqual(ctx._kjrXlsxParseDate('not a date at all'), null);
  assert.strictEqual(ctx._kjrXlsxParseDate(''), null);
});

test('dates: _monthIdxFromString - exact 3-letter and full month names', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._monthIdxFromString('Jan'), 0);
  assert.strictEqual(ctx._monthIdxFromString('december'), 11);
  assert.strictEqual(ctx._monthIdxFromString('JUNE'), 5);
  assert.strictEqual(ctx._monthIdxFromString('September'), 8);
});

test('dates: _monthIdxFromString - unambiguous longer prefix still resolves (via the exact 3-letter slice)', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._monthIdxFromString('septe'), 8);
  assert.strictEqual(ctx._monthIdxFromString('augustus'), 7);
});

test('dates: _monthIdxFromString - ambiguous short prefix rejected (-1)', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._monthIdxFromString('ju'), -1, '"ju" is ambiguous between Jun/Jul and must not silently resolve to either');
  assert.strictEqual(ctx._monthIdxFromString('j'), -1);
  assert.strictEqual(ctx._monthIdxFromString(''), -1);
  assert.strictEqual(ctx._monthIdxFromString(null), -1);
});

test('dates: _monthIdxFromString - longer month names resolve by their unambiguous prefix', async () => {
  const { ctx } = await loadApp();
  const MONTHS_LOWER = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  function checkOneOnly(str) {
    if (!str) return -1;
    const s = str.toString().trim().toLowerCase();
    return MONTHS_LOWER.indexOf(s.slice(0, 3));
  }
  const inputs = ['jan','january','june','july','sept','september','ju','j','xyz','xyzjun','augustus','octo','febr','marc','setp','aung'];
  for (const input of inputs) {
    assert.strictEqual(ctx._monthIdxFromString(input), checkOneOnly(input), `mismatch for "${input}" would prove the 2nd branch is reachable`);
  }
});

test('dates: normaliseToMonthYear - "Aug 2025" and "23 Aug 2025"', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.normaliseToMonthYear('Aug 2025'), 'Aug 2025');
  assert.strictEqual(ctx.normaliseToMonthYear('23 Aug 2025'), 'Aug 2025');
});

test('dates: normaliseToMonthYear - ISO and DD/MM/YYYY', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.normaliseToMonthYear('2025-08-23'), 'Aug 2025');
  assert.strictEqual(ctx.normaliseToMonthYear('23/08/2025'), 'Aug 2025');
});

test('dates: normaliseToMonthYear - returns null for empty/unparseable input', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.normaliseToMonthYear(''), null);
  assert.strictEqual(ctx.normaliseToMonthYear('   '), null);
  assert.strictEqual(ctx.normaliseToMonthYear('complete garbage'), null);
});

test('dates: normaliseToMonthYear - impossible month warns and returns null', async () => {
  const { ctx, consoleWarnings } = await loadApp();
  const result = ctx.normaliseToMonthYear('05/13/2025');
  assert.strictEqual(result, null);
  assert.ok(consoleWarnings.some(w => w.includes('05/13/2025')), 'console.warn should fire for the day<=12/month>12 ambiguity');
});

test('dates: normaliseToMonthYear - impossible day warns and returns null', async () => {
  const { ctx, consoleWarnings } = await loadApp();
  const result = ctx.normaliseToMonthYear('30/02/2025');
  assert.strictEqual(result, null);
  assert.ok(consoleWarnings.some(w => w.includes('30/02/2025')), 'console.warn should identify the impossible day');
});

test('dates: normaliseToMonthYear - leap-day validation', async () => {
  const { ctx, consoleWarnings } = await loadApp();
  assert.strictEqual(ctx.normaliseToMonthYear('29/02/2024'), 'Feb 2024');
  assert.strictEqual(ctx.normaliseToMonthYear('2024-02-29'), 'Feb 2024');
  assert.strictEqual(ctx.normaliseToMonthYear('29/02/2025'), null);
  assert.strictEqual(ctx.normaliseToMonthYear('2025-02-29'), null);
  assert.ok(consoleWarnings.some(w => w.includes('29/02/2025')));
  assert.ok(consoleWarnings.some(w => w.includes('2025-02-29')));
});

test('dates: _parseHistDate - yearless date later in the year than today rolls back to the prior year', async () => {
  const { ctx } = await loadApp();
  const now = new Date();
  const future = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 3);
  const monthAbbr = future.toLocaleString('en-US', { month: 'short' });
  const dateStr = `${future.getDate()} ${monthAbbr}`;
  const result = ctx._parseHistDate(dateStr);
  assert.ok(isDate(result) && !isNaN(result.getTime()), 'should still parse to a valid Date');
  assert.ok(result.getTime() <= now.getTime(), 'a "future" yearless date rolls back to last year, landing at/before now');
  assert.strictEqual(result.getFullYear(), now.getFullYear() - 1);
});

test('dates: _parseHistDate - yearless date earlier in the year than today stays in the current year', async () => {
  const { ctx } = await loadApp();
  const now = new Date();
  const past = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 3);
  if (past.getFullYear() !== now.getFullYear()) return; // skip near a year boundary, not the behaviour under test
  const monthAbbr = past.toLocaleString('en-US', { month: 'short' });
  const dateStr = `${past.getDate()} ${monthAbbr}`;
  const result = ctx._parseHistDate(dateStr);
  assert.ok(isDate(result) && !isNaN(result.getTime()));
  assert.strictEqual(result.getFullYear(), now.getFullYear());
});

test('dates: _parseHistDate - ISO "YYYY-MM-DD" parses directly, empty -> null', async () => {
  const { ctx } = await loadApp();
  const result = ctx._parseHistDate('2025-08-23');
  assert.ok(isDate(result));
  assert.strictEqual(result.getUTCFullYear ? result.getFullYear() : null, 2025);
  assert.strictEqual(ctx._parseHistDate(''), null);
});

test('dates: _parseHistDate - malformed and impossible values return null', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._parseHistDate('not a date at all !!'), null);
  assert.strictEqual(ctx._parseHistDate('2025-02-30'), null);
  assert.strictEqual(ctx._parseHistDate('30 Feb 2025'), null);
  assert.strictEqual(ctx._parseHistDate('29/02/2025'), null);
  assert.strictEqual(ctx._parseHistDate(String.fromCharCode(0, 1)), null);
});

test('dates: _parseHistDate - valid explicit and numeric day-month forms parse', async () => {
  const { ctx } = await loadApp();
  const explicit = ctx._parseHistDate('23 Aug 2025');
  assert.ok(isDate(explicit) && !isNaN(explicit.getTime()));
  assert.strictEqual(explicit.getFullYear(), 2025);
  assert.strictEqual(explicit.getMonth(), 7);
  assert.strictEqual(explicit.getDate(), 23);
  const numeric = ctx._parseHistDate('23/08/2025');
  assert.ok(isDate(numeric) && !isNaN(numeric.getTime()));
  assert.strictEqual(numeric.getFullYear(), 2025);
  assert.strictEqual(numeric.getMonth(), 7);
  assert.strictEqual(numeric.getDate(), 23);
});

test('dates: _kjrDaysHeld - basic day-count between two canonical dates', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._kjrDaysHeld('1 Jan 2025', '11 Jan 2025'), 10);
});

test('dates: _kjrDaysHeld - missing either date -> null', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._kjrDaysHeld('', '11 Jan 2025'), null);
  assert.strictEqual(ctx._kjrDaysHeld('1 Jan 2025', ''), null);
  assert.strictEqual(ctx._kjrDaysHeld(null, null), null);
});

test('dates: _kjrDaysHeld returns null for a negative span (sold-before-acquired)', async () => {
  const { ctx } = await loadApp();
  const result = ctx._kjrDaysHeld('11 Jan 2025', '1 Jan 2025');
  assert.strictEqual(result, null);
});

test('dates: _kjrDaysHeld keeps a same-day sale at 0 days', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._kjrDaysHeld('11 Jan 2025', '11 Jan 2025'), 0);
});
