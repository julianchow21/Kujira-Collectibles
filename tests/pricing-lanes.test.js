'use strict';
// Suite 10: pricing-lanes - _queueLaneFor, _kjrManualLangCards, _kjrUnresolvedSingles.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

test('pricing-lanes: _queueLaneFor - EN raw single with a number in the name -> tcgdex', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'EN' }), 'tcgdex');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25' }), 'tcgdex', 'blank language defaults to EN');
});

test('pricing-lanes: _queueLaneFor - a Korean (or any other unlisted language) raw single is always manual, regardless of a number', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'KR' }), 'manual');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'TH' }), 'manual');
});

// v3.85 ships with the Japanese lane OFF (PPT_JA_LANE_ENABLED), so every non-English single is manual exactly as in v3.84
test('pricing-lanes: _queueLaneFor - with the Japanese lane off, as v3.85 ships, every non-English raw single is manual, with a number or without', async () => {
  const { ctx } = await loadApp({ jaLane: false });
  assert.strictEqual(ctx.kjrPptJaLaneOn(), false);
  for (const language of ['JP', 'CN', 'ID', 'KR', 'TH']) {
    assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language }), 'manual', language);
    assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu', language }), 'manual', language + ': no card number');
    assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language, tcgdexId: 'SV2a-025' }), 'manual', language + ': an art id does not move it');
    assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language, customCard: true }), 'manual', language + ': a custom card');
  }
  assert.strictEqual(ctx._queueLaneFor({ name: 'Charizard ex 006/165', language: 'jp ' }), 'manual', 'the language is read as the app reads it everywhere');
  // the slabs, the English singles and the free lane are untouched by the switch
  assert.strictEqual(ctx._queueLaneFor({ name: 'Charizard', grader: 'PSA', grade: '10', language: 'JP' }), 'ppt');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'EN' }), 'tcgdex');
});

// with the lane switched on (the harness, loadApp({ jaLane: true })) the one exception is a JAPANESE single with a card number
test('pricing-lanes: _queueLaneFor - with the lane on a Japanese single with a card number is the ppt lane, Chinese and Indonesian ones stay manual', async () => {
  const { ctx } = await loadApp({ jaLane: true });
  assert.strictEqual(ctx.kjrPptJaLaneOn(), true);
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'JP' }), 'ppt');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu', language: 'JP' }), 'manual', 'no card number to match on');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'JP', tcgdexId: 'SV2a-025' }), 'ppt', 'an art id does not move it');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'JP', customCard: true }), 'manual', 'a custom card is priced by hand');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Charizard ex 006/165', language: 'jp ' }), 'ppt', 'the language is read as the app reads it everywhere');
  // their numbering does not reliably match the Japanese sets, a wrong card's price is worse than none
  for (const language of ['CN', 'ID', 'cn', ' id ']) {
    assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language }), 'manual', language);
    assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language, tcgdexId: 'SV2a-025' }), 'manual', language + ': an art id does not move it');
  }
  assert.deepStrictEqual(plain(ctx._kjrPptJaLangs()), ['JP'], 'the lane covers Japanese only');
});

test('pricing-lanes: _queueLaneFor - EN raw single with NO extractable number -> manual (not a PPT fallback)', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._queueLaneFor({ name: 'Umbreon Custom Card', language: 'EN' }), 'manual');
});

test('pricing-lanes: _queueLaneFor - slabs always go to the ppt lane, regardless of language', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._queueLaneFor({ name: 'Charizard', grader: 'PSA', grade: '10', language: 'EN' }), 'ppt');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Charizard', grader: 'PSA', grade: '10', language: 'JP' }), 'ppt', 'the English-only rule does not apply to slabs at all');
});

test('pricing-lanes: _queueLaneFor - an already-resolved tcgdexId skips straight to the free lane', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._queueLaneFor({ name: 'anything at all', language: 'EN', tcgdexId: 'base1-58' }), 'tcgdex');
});

const MIXED_DB = () => ({
  singles: [
    { id: 's_en_numbered', name: 'Pikachu 25', language: 'EN', status: 'Available' }, // resolvable, not unresolved
    { id: 's_en_numberless', name: 'Umbreon Custom Card', language: 'EN', status: 'Available' }, // unresolved (no number)
    { id: 's_jp', name: 'Pikachu 25', language: 'JP', status: 'Available' }, // Japanese lane (v3.85) when it is on: priced by PPT, neither manual-language nor unresolved
    { id: 's_jp_nonum', name: 'Pikachu', language: 'JP', status: 'Available' }, // Japanese without a number: priced by hand
    { id: 's_cn', name: 'Pikachu 25', language: 'CN', status: 'Available' }, // Chinese: manual, with the lane on as well
    { id: 's_kr', name: 'Pikachu 25', language: 'KR', status: 'Available' }, // manual-language, NOT unresolved
    { id: 's_cn_sold', name: 'Some Card', language: 'CN', status: 'Sold' }, // manual-language but SOLD - excluded from both
    { id: 's_en_missdate', name: 'Somenumbered 12', language: 'EN', status: 'Available', _tcgdexMissDate: '2026-01-01' }, // had a number, today's TCGdex miss -> unresolved
    { id: 's_en_resolved', name: 'Bulbasaur 44', language: 'EN', status: 'Available', tcgdexId: 'base1-44' }, // already resolved -> not unresolved
  ],
});

test('pricing-lanes: _kjrManualLangCards / _kjrUnresolvedSingles against a mixed seeded DB, the Japanese lane off as shipped', async () => {
  const { ctx } = await loadApp({ seed: MIXED_DB(), jaLane: false });
  const manualLang = plain(ctx._kjrManualLangCards()).map(r => r.id).sort();
  assert.deepStrictEqual(manualLang, ['s_cn', 's_jp', 's_jp_nonum', 's_kr'], 'every Available non-EN card is manual, as in v3.84 (sold CN excluded)');
  const unresolved = plain(ctx._kjrUnresolvedSingles()).map(r => r.id).sort();
  assert.deepStrictEqual(unresolved, ['s_en_missdate', 's_en_numberless'].sort());
});

test('pricing-lanes: _kjrManualLangCards / _kjrUnresolvedSingles against the same DB, the Japanese lane on', async () => {
  const { ctx } = await loadApp({ seed: MIXED_DB(), jaLane: true });
  const manualLang = plain(ctx._kjrManualLangCards()).map(r => r.id).sort();
  assert.deepStrictEqual(manualLang, ['s_cn', 's_jp_nonum', 's_kr'], 'the numbered Japanese one is a Japanese-lane card, the Chinese one is not');
  const unresolved = plain(ctx._kjrUnresolvedSingles()).map(r => r.id).sort();
  assert.deepStrictEqual(unresolved, ['s_en_missdate', 's_en_numberless'].sort(), 'a Japanese card never asked is not unresolved either');
  ctx.DB.singles.find(r => r.id === 's_jp')._tcgdexMissDate = '2026-01-01';
  ctx.DB.singles.find(r => r.id === 's_cn')._tcgdexMissDate = '2026-01-01';
  assert.deepStrictEqual(plain(ctx._kjrUnresolvedSingles()).map(r => r.id).sort(), ['s_en_missdate', 's_en_numberless', 's_jp'].sort(), 'the lane asked about the Japanese one and found no unique card, a Chinese one is never asked');
});
