'use strict';
// Suite 2: dates - toDateMmmYyyy, toIsoDateStr, dateToMs, normaliseToMonthYear,
// _monthIdxFromString, _parseHistDate, _kjrDaysHeld.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, isDate } = require('./harness.js');

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

test('dates: dateToMs - valid input -> ms consistent with a native Date', async () => {
  const { ctx } = await loadApp();
  const ms = ctx.dateToMs('23 Aug 2025');
  const expected = new Date(2025, 7, 23).getTime();
  assert.strictEqual(ms, expected);
});

test('dates: dateToMs - garbage input -> 0', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.dateToMs('not a real date'), 0);
  assert.strictEqual(ctx.dateToMs(''), 0);
});

test('dates: SUSPECT pair - toDateMmmYyyy vs dateToMs diverge on the SAME unparseable input', async () => {
  const { ctx } = await loadApp();
  const garbage = 'complete nonsense 12345';
  const dateResult = ctx.toDateMmmYyyy(garbage);
  const msResult = ctx.dateToMs(garbage);
  // SUSPECT: toDateMmmYyyy echoes the original string back (a visible "I could
  // not parse this" signal an editor can spot), while dateToMs silently
  // collapses the SAME failure to 0 - which is indistinguishable from a
  // legitimate "1 Jan 1970" timestamp to any caller that does new Date(ms).
  // Likely-correct behaviour: dateToMs should signal "unparseable" distinctly
  // from a real epoch-zero date (e.g. NaN, or null) rather than 0. Severity:
  // cosmetic/sort-order (an unparseable date silently sorts as "oldest
  // possible" instead of being flagged), not data-loss.
  assert.strictEqual(dateResult, garbage);
  assert.strictEqual(msResult, 0);
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

test('dates: SUSPECT - _monthIdxFromString\'s second "unambiguous prefix" branch is dead code', async () => {
  const { ctx } = await loadApp();
  // MONTHS_LOWER holds only 3-character abbreviations, so
  // `MONTHS_LOWER.find(m => m.startsWith(s))` (the second branch, guarded by
  // s.length>=3) can only ever match when s.length===3 - at which point it
  // degenerates to `m === s`, exactly what the FIRST branch
  // (`MONTHS_LOWER.indexOf(s.slice(0,3))`) already tried and rejected a line
  // earlier. Verified empirically across jan/january/june/july/sept/
  // september/xyz/xyzjun/octo/febr/marc/setp/aung: the second branch never
  // changes the outcome the first branch alone would give. SUSPECT: this is
  // unreachable/dead logic, not the "extra disambiguation for longer inputs"
  // its comment (app.js ~678-686) claims it is. Severity: cosmetic (no wrong
  // output today - check 1 alone is already correct - but misleading if
  // MONTHS_LOWER's shape ever changes).
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

test('dates: SUSPECT - normaliseToMonthYear("05/13/2025") warns (day<=12 AND month>12) but STILL returns null', async () => {
  const { ctx, consoleWarnings } = await loadApp();
  // "05/13/2025" parsed as DD/MM/YYYY means day=05, month=13. The code's own
  // ambiguity guard (mon>12 && day<=12) correctly fires here and warns that
  // this looks like a US MM/DD/YYYY date being misread - but the date it then
  // tries to construct is "2025-13-05", which new Date() rejects outright
  // (Invalid Date, verified: out-of-range ISO months do NOT roll over,
  // unlike out-of-range days - see the next test). So the function warns
  // about a real ambiguity and then silently returns null anyway - the
  // caller gets nothing usable, and would only know why if they read the
  // console. SUSPECT: likely-correct behaviour is to actually swap day/month
  // and return the sensible "May 2025" reading when the warn condition
  // fires, instead of warning then discarding. Severity: cosmetic (silently
  // dropped value, not corrupted data), but the warning is currently
  // pointless from a caller's perspective since nothing recovers from it.
  const result = ctx.normaliseToMonthYear('05/13/2025');
  assert.strictEqual(result, null);
  assert.ok(consoleWarnings.some(w => w.includes('05/13/2025')), 'console.warn should fire for the day<=12/month>12 ambiguity');
});

test('dates: SUSPECT - normaliseToMonthYear("30/02/2025") silently rolls over to Mar 2025, NO warning', async () => {
  const { ctx, consoleWarnings } = await loadApp();
  // "30/02/2025" as DD/MM/YYYY = day 30, month 2 (February). Day 30 does not
  // exist in February, but the warn guard only checks month>12 (never
  // day-out-of-range-for-the-given-month), so no warning fires here. The
  // constructed date string "2025-02-30" rolls over via JS's native Date
  // parser to 2 March 2025 (verified: unlike an out-of-range MONTH, which is
  // rejected outright, an out-of-range DAY silently overflows into the next
  // month). So an impossible date is normalised to a real month/year with
  // zero diagnostic trail. SUSPECT: likely-correct behaviour is to validate
  // day-of-month against the target month before accepting, or at minimum
  // warn. Severity: cosmetic/data-quality (a fat-fingered "30/02" import row
  // silently becomes "Mar 2025" in a report with no trace of the typo).
  const result = ctx.normaliseToMonthYear('30/02/2025');
  assert.strictEqual(result, 'Mar 2025');
  assert.strictEqual(consoleWarnings.length, 0, 'no warning fires for this silent rollover');
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

test('dates: SUSPECT - _parseHistDate\'s "garbage -> null" path is effectively unreachable for ordinary text', async () => {
  const { ctx } = await loadApp();
  // _parseHistDate always builds `new Date(dateStr + ' ' + currentYear)` for
  // any non-ISO, non-empty input. Verified directly against the native Date
  // constructor (see harness research): V8's lenient fallback parser
  // extracts a bare trailing 4-digit year from almost ANY prefix text and
  // defaults to 1 Jan of that year, rather than failing - "not a date at
  // all !!", "{}", "NaN", "----", "undefined", "\t\t\t" all parse "successfully"
  // this way. Only genuinely bizarre input (control characters) actually
  // trips isNaN and returns null. SUSPECT: any corrupted/free-text
  // priceHistory date silently becomes "1 Jan <this year>" instead of being
  // rejected, which _mktFreshDot then treats as a real, dateable price
  // refresh. Severity: cosmetic/trust (a freshness dot could show a
  // plausible age for data that was never a real date), not data-loss.
  const now = new Date();
  const result = ctx._parseHistDate('not a date at all !!');
  assert.ok(isDate(result), 'ordinary garbage text does NOT hit the null path');
  assert.strictEqual(result.getFullYear(), now.getFullYear());
  assert.strictEqual(result.getMonth(), 0);
  assert.strictEqual(result.getDate(), 1);
  // Only truly bizarre (control-character) input actually fails to parse.
  assert.strictEqual(ctx._parseHistDate(String.fromCharCode(0, 1)), null);
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

test('dates: SUSPECT - _kjrDaysHeld clamps a negative span (sold-before-acquired) to 0, not a signed value', async () => {
  const { ctx } = await loadApp();
  // dateSold earlier than dateAcquired is a data-entry error, but
  // Math.max(0, ...) silently reports "0 days held" identically to a
  // same-day flip, rather than surfacing the impossible ordering.
  const result = ctx._kjrDaysHeld('11 Jan 2025', '1 Jan 2025');
  assert.strictEqual(result, 0);
});
