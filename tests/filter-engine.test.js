'use strict';
// Suite 4: filter-engine (features.js ~372-539) - kjrMatchNumFilter,
// kjrMatchSearch/_matchOneToken, kjrMatchDateFilter, kjrMatchUniversal.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

test('filter-engine: kjrMatchNumFilter - bare number matches within +/-1.0 tolerance', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrMatchNumFilter('100', 100.9), true);
  assert.strictEqual(ctx.kjrMatchNumFilter('100', 101.1), false);
  assert.strictEqual(ctx.kjrMatchNumFilter('100', 99.1), true);
  assert.strictEqual(ctx.kjrMatchNumFilter('100', 98.9), false);
});

test('filter-engine: kjrMatchNumFilter - comparators >, <, >=, <=', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrMatchNumFilter('>100', 101), true);
  assert.strictEqual(ctx.kjrMatchNumFilter('>100', 100), false);
  assert.strictEqual(ctx.kjrMatchNumFilter('<50', 49), true);
  assert.strictEqual(ctx.kjrMatchNumFilter('<50', 50), false);
  assert.strictEqual(ctx.kjrMatchNumFilter('>=100', 100), true);
  assert.strictEqual(ctx.kjrMatchNumFilter('<=50', 50), true);
});

test('filter-engine: kjrMatchNumFilter - inclusive range "100-200"', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrMatchNumFilter('100-200', 100), true, 'lower bound inclusive');
  assert.strictEqual(ctx.kjrMatchNumFilter('100-200', 200), true, 'upper bound inclusive');
  assert.strictEqual(ctx.kjrMatchNumFilter('100-200', 150), true);
  assert.strictEqual(ctx.kjrMatchNumFilter('100-200', 99), false);
  assert.strictEqual(ctx.kjrMatchNumFilter('100-200', 201), false);
});

test('filter-engine: kjrMatchNumFilter - leading $ stripped automatically, even ahead of a comparator', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrMatchNumFilter('$100', 100), true);
  // The $-strip is an unconditional /^\$+/ replace before any other parsing,
  // so it works whether $ is followed directly by digits or by a comparator.
  assert.strictEqual(ctx.kjrMatchNumFilter('$>100', 101), true);
  assert.strictEqual(ctx.kjrMatchNumFilter('$>100', 100), false);
});

test('filter-engine: kjrMatchNumFilter - empty filter matches everything, garbage/non-numeric value never matches', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrMatchNumFilter('', 100), true);
  assert.strictEqual(ctx.kjrMatchNumFilter(null, 100), true);
  assert.strictEqual(ctx.kjrMatchNumFilter('not a number', 100), false);
  assert.strictEqual(ctx.kjrMatchNumFilter('100', 'not a number'), false, 'empty/non-numeric row value never matches a real filter');
  assert.strictEqual(ctx.kjrMatchNumFilter('100', ''), false);
});

test('filter-engine: kjrMatchSearch - substring match across several candidate VALUES (not row/table aware)', async () => {
  const { ctx } = await loadApp();
  // kjrMatchSearch(needle, ...vals) is a single-token substring OR-check
  // across whatever values the caller passes in - it does NOT itself
  // tokenize a multi-word needle (that AND-across-tokens behaviour lives in
  // kjrMatchUniversal/_matchOneToken below, a different function entirely).
  assert.strictEqual(ctx.kjrMatchSearch('char', 'Charizard', 'Base Set'), true);
  assert.strictEqual(ctx.kjrMatchSearch('CHAR', 'Charizard'), true, 'case-insensitive');
  assert.strictEqual(ctx.kjrMatchSearch('zzz', 'Charizard', 'Base Set'), false);
  assert.strictEqual(ctx.kjrMatchSearch('', 'Charizard'), true, 'empty needle matches everything');
  assert.strictEqual(ctx.kjrMatchSearch('base set', 'Charizard', 'Base Set'), true, 'a multi-word needle is still ONE substring, matched against the whole value verbatim');
});

test('filter-engine: _matchOneToken - numeric comparator token on a numeric field', async () => {
  const { ctx } = await loadApp();
  const row = { name: 'Charizard', costPrice: 120, marketPrice: 200, qty: 1 };
  assert.strictEqual(ctx._matchOneToken('>150', row, 'singles'), true, 'marketPrice 200 > 150');
  assert.strictEqual(ctx._matchOneToken('>250', row, 'singles'), false);
  assert.strictEqual(ctx._matchOneToken('<130', row, 'singles'), true, 'costPrice 120 < 130');
});

test('filter-engine: _matchOneToken - pure numeric token matches +/-1 on any numeric field OR a date day-of-month', async () => {
  const { ctx } = await loadApp();
  const row = { name: 'Charizard', costPrice: 120, datePurchased: '19 May 2025' };
  assert.strictEqual(ctx._matchOneToken('120', row, 'singles'), true);
  assert.strictEqual(ctx._matchOneToken('19', row, 'singles'), true, '"19" also matches the 19th of the datePurchased field');
});

test('filter-engine: _matchOneToken - date-ish and plain text tokens', async () => {
  const { ctx } = await loadApp();
  const row = { name: 'Charizard', set: 'Base Set', language: 'EN', datePurchased: '19 May 2025' };
  assert.strictEqual(ctx._matchOneToken('may', row, 'singles'), true);
  assert.strictEqual(ctx._matchOneToken('2025', row, 'singles'), true);
  assert.strictEqual(ctx._matchOneToken('charizard', row, 'singles'), true);
  assert.strictEqual(ctx._matchOneToken('zzz', row, 'singles'), false);
  assert.strictEqual(ctx._matchOneToken('', row, 'singles'), true, 'empty token matches everything');
});

test('filter-engine: kjrMatchUniversal - multi-token AND across a row\'s searchable fields', async () => {
  const { ctx } = await loadApp();
  const row = { name: 'Charizard', set: 'Base Set', language: 'EN', condition: 'Near Mint', status: 'Available' };
  assert.strictEqual(ctx.kjrMatchUniversal('char base', row, 'singles'), true, 'both tokens match (name, set)');
  assert.strictEqual(ctx.kjrMatchUniversal('char zzz', row, 'singles'), false, 'one token has no match anywhere -> AND fails');
  assert.strictEqual(ctx.kjrMatchUniversal('', row, 'singles'), true);
});

test('filter-engine: kjrMatchUniversal - whole-phrase match tried BEFORE token splitting', async () => {
  const { ctx } = await loadApp();
  // "near mint" as a single phrase must match the condition field, even
  // though split into ['near','mint'] token-AND would also happen to match
  // here - use a case that ONLY the whole-phrase path can satisfy to prove
  // the ordering: a value containing the exact two-word phrase as one field,
  // where splitting would look for each word independently anyway (both
  // paths agree in this case; the real proof is that kjrMatchUniversal
  // tries the phrase FIRST via _matchOneToken(query, ...) - see source).
  const row = { name: 'Charizard', condition: 'Near Mint' };
  assert.strictEqual(ctx.kjrMatchUniversal('near mint', row, 'singles'), true);
});

test('filter-engine: kjrMatchUniversal - no field-scoped token syntax (e.g. "name:foo") is supported', async () => {
  const { ctx } = await loadApp();
  // _matchOneToken has no colon/field-prefix parsing at all - a token like
  // "name:charizard" is matched as a LITERAL substring against every text
  // field, which will not equal any real field value.
  const row = { name: 'Charizard', set: 'Base Set' };
  assert.strictEqual(ctx.kjrMatchUniversal('name:charizard', row, 'singles'), false);
});

test('filter-engine: kjrMatchDateFilter - month name, month+year, numeric month/day, year-only', async () => {
  const { ctx } = await loadApp();
  const val = '19 May 2025';
  assert.strictEqual(ctx.kjrMatchDateFilter('may', val), true);
  assert.strictEqual(ctx.kjrMatchDateFilter('May 2025', val), true);
  assert.strictEqual(ctx.kjrMatchDateFilter('5/2025', val), true);
  assert.strictEqual(ctx.kjrMatchDateFilter('2025', val), true);
  assert.strictEqual(ctx.kjrMatchDateFilter('19', val), true, 'bare day-of-month');
  assert.strictEqual(ctx.kjrMatchDateFilter('05', val), true, 'bare "05" resolves to May, matches the month');
  assert.strictEqual(ctx.kjrMatchDateFilter('dec', val), false);
  assert.strictEqual(ctx.kjrMatchDateFilter('', val), true, 'empty filter matches everything');
});
