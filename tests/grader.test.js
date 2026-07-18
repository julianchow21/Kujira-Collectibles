'use strict';
// Suite 5: grader - _resolveGrader against the 7 documented messy shapes
// (app.js comment ~4351-4358) plus PSA-never-pristine, BGS pristine/black
// label, unknown grader passthrough, and graderBadge/graderGradeBadge/
// _graderClass mapping sanity.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

test('grader: _resolveGrader - ALL 7 documented messy shapes resolve to PSA/10 (shape 6 fixed in v3.32)', async () => {
  const { ctx } = await loadApp();
  // 1. canonical
  assert.deepStrictEqual(pick(ctx._resolveGrader('PSA', '10')), { grader: 'PSA', grade: '10' });
  // 2. lowercase
  assert.deepStrictEqual(pick(ctx._resolveGrader('psa', '10')), { grader: 'PSA', grade: '10' });
  // 3. padded whitespace
  assert.deepStrictEqual(pick(ctx._resolveGrader(' PSA  ', '10 ')), { grader: 'PSA', grade: '10' });
  // 4. grader field carries both
  assert.deepStrictEqual(pick(ctx._resolveGrader('PSA 10', '')), { grader: 'PSA', grade: '10' });
  // 5. grade field carries both
  assert.deepStrictEqual(pick(ctx._resolveGrader('', 'PSA 10')), { grader: 'PSA', grade: '10' });
  // 6. no separator - pre-v3.32 the leading \b in the grade regex could
  //    never match between 'A' and '1' (both word chars), so the grade was
  //    silently lost; the letter-digit-split retry now recovers it
  assert.deepStrictEqual(pick(ctx._resolveGrader('PSA10', '')), { grader: 'PSA', grade: '10' });
  // 7. modifiers attached in the grader field
  assert.deepStrictEqual(pick(ctx._resolveGrader('psa 10 pristine', '')), { grader: 'PSA', grade: '10' });

  function pick(r) { return { grader: r.grader, grade: r.grade }; }
});

test('grader: _resolveGrader - glued "P10" pristine shorthand now counts for TAG/CGC/BGS 10 (v3.32)', async () => {
  const { ctx } = await loadApp();
  // The pristine comment documents " P" / "P10" as recognised shorthands,
  // but /\bP\b/ could never match "P10" (P followed by a digit is not a
  // boundary). The same letter-digit split that fixes shape 6 fixes this.
  const r = ctx._resolveGrader('TAG 10', '', 'P10');
  assert.strictEqual(r.grader, 'TAG');
  assert.strictEqual(r.grade, '10');
  assert.strictEqual(r.pristine, true, 'glued P10 shorthand sets pristine, per its own documentation');
});

test('grader: _resolveGrader - the split retry must not invent grades from digit runs in card names', async () => {
  const { ctx } = await loadApp();
  // "V2124999" splits to "V 2124999" - no standalone 1-10 token appears, so
  // no grade may materialise from a cert-number-like digit run.
  const r = ctx._resolveGrader('', '', 'Charizard V2124999');
  assert.strictEqual(r.grader, '');
  assert.strictEqual(r.grade, '', 'no grade invented from a long digit run');
});

test('grader: _resolveGrader - PSA never gets the Pristine flag, even if the word appears', async () => {
  const { ctx } = await loadApp();
  const r = ctx._resolveGrader('PSA', '10', 'Pristine');
  assert.strictEqual(r.grader, 'PSA');
  assert.strictEqual(r.grade, '10');
  assert.strictEqual(r.pristine, false, 'PSA has no Pristine subgrade by design (Gem Mint 10 is their top grade)');
});

test('grader: _resolveGrader - BGS 10 + the word "Pristine" sets the pristine flag', async () => {
  const { ctx } = await loadApp();
  const r = ctx._resolveGrader('BGS', '10', 'Pristine');
  assert.strictEqual(r.grader, 'BGS');
  assert.strictEqual(r.grade, '10');
  assert.strictEqual(r.pristine, true);
});

test('grader: SUSPECT - BGS "Black Label" (the real-world term for BGS\'s top grade) does NOT set pristine', async () => {
  const { ctx } = await loadApp();
  // Collectors call BGS's perfect-10 tier "Black Label", not "Pristine" (that
  // word is TAG/CGC terminology). _resolveGrader only recognises the literal
  // word "PRISTINE" or a standalone "P" token next to a TAG/CGC/BGS 10 - it
  // has no "black label" synonym, so a BGS 10 Black Label slab renders as a
  // plain "BGS 10" badge with no distinguishing top-pop marker. Severity:
  // cosmetic (a real premium grade is visually indistinguishable from an
  // ordinary BGS 10).
  const r = ctx._resolveGrader('BGS', '10', 'Black Label');
  assert.strictEqual(r.grader, 'BGS');
  assert.strictEqual(r.grade, '10');
  assert.strictEqual(r.pristine, false);
});

test('grader: _resolveGrader - standalone "P" token also triggers pristine for TAG/CGC/BGS 10', async () => {
  const { ctx } = await loadApp();
  const r = ctx._resolveGrader('TAG', '10', 'P');
  assert.strictEqual(r.pristine, true);
});

test('grader: _resolveGrader - unknown grader passes through with empty canonical grader, grade still extracted', async () => {
  const { ctx } = await loadApp();
  const r = ctx._resolveGrader('UnknownGrader', '7');
  assert.strictEqual(r.grader, '');
  assert.strictEqual(r.grade, '7');
  assert.deepStrictEqual(plain(r.raw), { grader: 'UnknownGrader', grade: '7' }, 'raw input preserved for callers that want the original values');
});

test('grader: graderBadge() - class mapping (TAG/PSA/CGC distinct, everything else generic b-slab)', async () => {
  const { ctx } = await loadApp();
  assert.match(ctx.graderBadge('TAG', '10'), /b-tag/);
  assert.match(ctx.graderBadge('PSA', '10'), /b-psa/);
  assert.match(ctx.graderBadge('CGC', '10'), /b-cgc/);
  assert.match(ctx.graderBadge('BGS', '10'), /b-slab/, 'BGS has no dedicated colour in graderBadge, falls into the generic bucket');
  assert.match(ctx.graderBadge('PSA', '10', 'PRISTINE'), /PRISTINE| P</, 'graderBadge just appends " P" for a PRISTINE note, no dedicated pristine class (that is graderGradeBadge\'s job)');
});

test('grader: _graderClass() - same TAG/PSA/CGC/generic mapping used by graderGradeBadge', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._graderClass('TAG'), 'b-tag');
  assert.strictEqual(ctx._graderClass('PSA'), 'b-psa');
  assert.strictEqual(ctx._graderClass('CGC'), 'b-cgc');
  assert.strictEqual(ctx._graderClass('BGS'), 'b-slab');
  assert.strictEqual(ctx._graderClass(''), 'b-slab');
});

test('grader: graderGradeBadge() - resolves messy input to a clean "GRADER GRADE" badge, pristine gets a star + dedicated class', async () => {
  const { ctx } = await loadApp();
  const clean = ctx.graderGradeBadge('psa', '10', '');
  assert.match(clean, /b-psa/);
  assert.match(clean, />PSA 10</);

  const pristine = ctx.graderGradeBadge('BGS', '10', 'Pristine');
  assert.match(pristine, /b-pristine/);
  assert.match(pristine, /★/);
  assert.match(pristine, /BGS 10/);
});

test('grader: graderGradeBadge() - unresolvable grader/grade falls back to "?" rather than a blank badge', async () => {
  const { ctx } = await loadApp();
  const badge = ctx.graderGradeBadge('', '');
  assert.match(badge, /\?/, 'both grader and grade unknown -> "?" placeholders, not empty/undefined text');
});
