'use strict';
// Suite 6: normalize-record - normalizeRecord(table, obj) per table: numeric
// coercion, date canonicalisation, language/condition/grader canonicalisation,
// defaults, unknown-field preservation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

test('normalize-record: numeric coercion of price/qty strings, strips currency symbols', async () => {
  const { ctx } = await loadApp();
  const out = ctx.normalizeRecord('singles', { name: 'Test', costPrice: '$45.50', qty: '3', marketPrice: '' });
  assert.strictEqual(out.costPrice, 45.5);
  assert.strictEqual(out.qty, 3);
  assert.strictEqual(out.marketPrice, '', 'blank stays blank, not coerced to 0');
});

test('normalize-record: qty is rounded and floored at 1 (never 0 or negative)', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.normalizeRecord('singles', { qty: '0' }).qty, 1);
  assert.strictEqual(ctx.normalizeRecord('singles', { qty: '-5' }).qty, 1);
  assert.strictEqual(ctx.normalizeRecord('singles', { qty: '2.6' }).qty, 3, 'rounds, does not floor');
});

test('normalize-record: unparseable numeric field coerces to empty string, not NaN', async () => {
  const { ctx } = await loadApp();
  const out = ctx.normalizeRecord('singles', { costPrice: 'not a number' });
  assert.strictEqual(out.costPrice, '');
});

test('normalize-record: date fields normalise to "D MMM YYYY" canonical form', async () => {
  const { ctx } = await loadApp();
  const out = ctx.normalizeRecord('singles', { datePurchased: '2025-08-23' });
  assert.strictEqual(out.datePurchased, '23 Aug 2025');
  const out2 = ctx.normalizeRecord('sales', { dateSold: '23/08/2025' });
  assert.strictEqual(out2.dateSold, '23 Aug 2025');
});

test('normalize-record: language field is uppercased and trimmed', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.normalizeRecord('singles', { language: 'jp' }).language, 'JP');
  assert.strictEqual(ctx.normalizeRecord('singles', { language: ' Japanese ' }).language, 'JAPANESE');
});

test('normalize-record: SUSPECT - language "canonicalisation" never actually rejects/maps an unknown value', async () => {
  const { ctx } = await loadApp();
  // The code computes `['EN','JP','CN','ID','KR'].includes(L)` but then does
  // `? L : L` - identical on both branches, so the includes() check result
  // is entirely discarded. Any free-text language value (e.g. "Japanese",
  // "French", a typo) passes straight through as uppercase+trim, with no
  // actual canonicalisation to the 5-code set the check implies exists.
  // Severity: cosmetic - a "Japanese" entry never becomes "JP" here (the
  // full-name-to-code mapping only happens elsewhere, e.g. parseSmartLine's
  // LANG_FUZZY table), so filters/pricing-lane logic keyed on exact "JP"
  // would miss it if this were the only normalisation path taken.
  const out = ctx.normalizeRecord('singles', { language: 'Japanese' });
  assert.strictEqual(out.language, 'JAPANESE', 'not canonicalised to "JP" despite the includes() check suggesting it would be');
});

test('normalize-record: condition canonicalises abbreviations and fuzzy words to full names (singles/slabs)', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.normalizeRecord('singles', { condition: 'nm' }).condition, 'Near Mint');
  assert.strictEqual(ctx.normalizeRecord('singles', { condition: 'Near mint plus' }).condition, 'Near Mint');
  assert.strictEqual(ctx.normalizeRecord('singles', { condition: 'lp' }).condition, 'Lightly Played');
  assert.strictEqual(ctx.normalizeRecord('singles', { condition: 'mp' }).condition, 'Moderately Played');
  assert.strictEqual(ctx.normalizeRecord('singles', { condition: 'hp' }).condition, 'Heavily Played');
  assert.strictEqual(ctx.normalizeRecord('singles', { condition: 'damaged' }).condition, 'Damaged');
  assert.strictEqual(ctx.normalizeRecord('singles', { condition: 'mint' }).condition, 'Mint');
  assert.strictEqual(ctx.normalizeRecord('singles', { condition: 'Gem 10' }).condition, 'Gem 10', 'an unrecognised condition string passes through untouched');
});

test('normalize-record: condition canonicalisation is deliberately SKIPPED for etbs/boosterBoxes/boosterPacks', async () => {
  const { ctx } = await loadApp();
  // Sealed-product condition vocab (Mint/Dented/Damaged/Sealed for ETBs) is
  // a different scale to the raw-card NM/LP/MP/HP scale, so the singles/
  // slabs canonicaliser must not touch it.
  assert.strictEqual(ctx.normalizeRecord('etbs', { condition: 'nm' }).condition, 'nm', 'left exactly as typed for ETBs');
  assert.strictEqual(ctx.normalizeRecord('boosterBoxes', { condition: 'nm' }).condition, 'nm');
  assert.strictEqual(ctx.normalizeRecord('boosterPacks', { condition: 'nm' }).condition, 'nm');
});

test('normalize-record: grader on a slab row goes through the full _resolveGrader treatment', async () => {
  const { ctx } = await loadApp();
  const out = ctx.normalizeRecord('slabs', { grader: 'psa10', grade: '' });
  assert.strictEqual(out.grader, 'PSA');
  // v3.32: the glued "psa10" shape now recovers its grade through
  // _resolveGrader's letter-digit-split retry, and normalizeRecord inherits
  // the recovered value.
  assert.strictEqual(out.grade, '10');
});

test('normalize-record: grader on a NON-slab row is just uppercased/trimmed, not fully resolved', async () => {
  const { ctx } = await loadApp();
  const out = ctx.normalizeRecord('singles', { grader: ' psa ' });
  assert.strictEqual(out.grader, 'PSA');
});

test('normalize-record: status defaults to "Available" for singles/slabs when unset, untouched otherwise', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.normalizeRecord('singles', {}).status, 'Available');
  assert.strictEqual(ctx.normalizeRecord('slabs', {}).status, 'Available');
  assert.strictEqual(ctx.normalizeRecord('singles', { status: 'Sold' }).status, 'Sold', 'existing status is never overwritten');
  assert.strictEqual(ctx.normalizeRecord('etbs', {}).status, undefined, 'the Available default is singles/slabs only');
});

test('normalize-record: type defaults - singles defaults to "raw" only if unset, slabs is ALWAYS forced to "slab"', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.normalizeRecord('singles', {}).type, 'raw');
  assert.strictEqual(ctx.normalizeRecord('singles', { type: 'sealed' }).type, 'sealed', 'an existing type is preserved for singles');
  assert.strictEqual(ctx.normalizeRecord('slabs', { type: 'raw' }).type, 'slab', 'slabs always get type overwritten to "slab", even if something else was passed in');
});

test('normalize-record: text fields are trimmed', async () => {
  const { ctx } = await loadApp();
  const out = ctx.normalizeRecord('singles', { name: '  Charizard  ', set: '  Base Set  ', notes: ' hi ' });
  assert.strictEqual(out.name, 'Charizard');
  assert.strictEqual(out.set, 'Base Set');
  assert.strictEqual(out.notes, 'hi');
});

test('normalize-record: unknown/unmapped fields are preserved verbatim', async () => {
  const { ctx } = await loadApp();
  const out = ctx.normalizeRecord('singles', { name: 'Test', someRandomField: 'keepme', ebayUrl: 'https://x' });
  assert.strictEqual(out.someRandomField, 'keepme');
  assert.strictEqual(out.ebayUrl, 'https://x');
});

test('normalize-record: non-object input is returned unchanged (no throw)', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.normalizeRecord('singles', null), null);
  assert.strictEqual(ctx.normalizeRecord('singles', undefined), undefined);
  assert.strictEqual(ctx.normalizeRecord('singles', 'a string'), 'a string');
});
