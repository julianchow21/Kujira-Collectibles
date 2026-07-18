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

test('pricing-lanes: _queueLaneFor - non-English (JP/CN/ID) raw singles are always manual, regardless of a number', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'JP' }), 'manual');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'CN' }), 'manual');
  assert.strictEqual(ctx._queueLaneFor({ name: 'Pikachu 25', language: 'ID' }), 'manual');
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

test('pricing-lanes: _kjrManualLangCards / _kjrUnresolvedSingles against a mixed seeded DB', async () => {
  const { ctx, grab } = await loadApp({
    seed: {
      singles: [
        { id: 's_en_numbered', name: 'Pikachu 25', language: 'EN', status: 'Available' }, // resolvable, not unresolved
        { id: 's_en_numberless', name: 'Umbreon Custom Card', language: 'EN', status: 'Available' }, // unresolved (no number)
        { id: 's_jp', name: 'Pikachu 25', language: 'JP', status: 'Available' }, // manual-language, NOT unresolved
        { id: 's_cn_sold', name: 'Some Card', language: 'CN', status: 'Sold' }, // manual-language but SOLD - excluded from both
        { id: 's_en_missdate', name: 'Somenumbered 12', language: 'EN', status: 'Available', _tcgdexMissDate: '2026-01-01' }, // had a number, today's TCGdex miss -> unresolved
        { id: 's_en_resolved', name: 'Bulbasaur 44', language: 'EN', status: 'Available', tcgdexId: 'base1-44' }, // already resolved -> not unresolved
      ],
    },
  });
  const manualLang = plain(ctx._kjrManualLangCards()).map(r => r.id).sort();
  assert.deepStrictEqual(manualLang, ['s_jp'], 'only the Available non-EN card counts (sold CN excluded)');

  const unresolved = plain(ctx._kjrUnresolvedSingles()).map(r => r.id).sort();
  assert.deepStrictEqual(unresolved, ['s_en_missdate', 's_en_numberless'].sort());
});
