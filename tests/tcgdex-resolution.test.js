'use strict';
// Suite 11: tcgdex-resolution - _tcgdexNumber, _isReverseHoloName, _baseCardName,
// _cardNumberTokens, _nameSimilarity, _disambiguateBySetName, _pickBestMatch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

test('tcgdex-resolution: _tcgdexNumber - number anywhere in the name, not just trailing', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._tcgdexNumber('Zapdos 42 RH'), '42');
  assert.strictEqual(ctx._tcgdexNumber('Pikachu 25'), '25');
});

test('tcgdex-resolution: _tcgdexNumber - alpha-prefixed / suffixed forms (TG11, 67a) preserved verbatim + uppercased', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._tcgdexNumber('Some Card TG11'), 'TG11');
  assert.strictEqual(ctx._tcgdexNumber('Some Card 67a'), '67A');
});

test('tcgdex-resolution: _tcgdexNumber - a plain name with no number token returns an empty string (not null/undefined)', async () => {
  const { ctx } = await loadApp();
  // Characterisation note: the packet's own wording expected null/undefined
  // here; the actual implementation's ternary else-branch is an explicit ''.
  assert.strictEqual(ctx._tcgdexNumber('Umbreon Custom Card'), '');
});

test('tcgdex-resolution: _isReverseHoloName - positive matches (RH token, "reverse", "rev holo"/"rev-holo")', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._isReverseHoloName('Zapdos 42 RH'), true);
  assert.strictEqual(ctx._isReverseHoloName('Charizard Reverse Holo'), true);
  assert.strictEqual(ctx._isReverseHoloName('Charizard rev-holo'), true);
  assert.strictEqual(ctx._isReverseHoloName('Charizard rev holo'), true);
});

test('tcgdex-resolution: _isReverseHoloName - negative matches, notably Rhydon/Rhyhorn/Rhyperior do NOT false-hit on the "Rh" prefix', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._isReverseHoloName('Rhydon'), false);
  assert.strictEqual(ctx._isReverseHoloName('Rhyhorn 111'), false);
  assert.strictEqual(ctx._isReverseHoloName('Rhyperior VMAX'), false);
  assert.strictEqual(ctx._isReverseHoloName('Charizard'), false);
});

test('tcgdex-resolution: _baseCardName - strips the number token and everything after it', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._baseCardName('Gardevoir ex 93'), 'Gardevoir ex');
  assert.strictEqual(ctx._baseCardName('Zapdos 42 RH'), 'Zapdos');
  assert.strictEqual(ctx._baseCardName('Riolu 10 (Pokemon Centre) (Sealed)'), 'Riolu');
});

test('tcgdex-resolution: _baseCardName - no number token falls back to the whole trimmed name', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._baseCardName('Umbreon Custom Card'), 'Umbreon Custom Card');
  assert.strictEqual(ctx._baseCardName(''), '');
});

test('tcgdex-resolution: _cardNumberTokens - extracts every digit run, strips leading zeros', async () => {
  const { ctx } = await loadApp();
  const tokens = plain(ctx._cardNumberTokens('223/197'));
  assert.deepStrictEqual(tokens.sort(), ['197', '223']);
  const tokens2 = plain(ctx._cardNumberTokens('007'));
  assert.strictEqual(tokens2[0], '7');
});

test('tcgdex-resolution: _nameSimilarity - identical ~1, disjoint ~0, symmetric', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._nameSimilarity('Charizard ex', 'Charizard ex'), 1);
  assert.strictEqual(ctx._nameSimilarity('Charizard', 'Squirtle Fossil Base'), 0);
  const ab = ctx._nameSimilarity('Charizard ex 223', 'Charizard ex Base Set');
  const ba = ctx._nameSimilarity('Charizard ex Base Set', 'Charizard ex 223');
  assert.strictEqual(ab, ba, 'Jaccard similarity is symmetric');
  assert.ok(ab > 0 && ab < 1, 'partial overlap sits strictly between 0 and 1');
});

test('tcgdex-resolution: _nameSimilarity - empty input on either side is 0, not NaN', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._nameSimilarity('', 'Charizard'), 0);
  assert.strictEqual(ctx._nameSimilarity('Charizard', ''), 0);
  assert.strictEqual(ctx._nameSimilarity('', ''), 0);
});

test('tcgdex-resolution: _disambiguateBySetName - a set-name token in the name picks the single matching candidate', async () => {
  const { ctx } = await loadApp();
  const candidates = [{ id: 'base2-5' }, { id: 'base3-5' }];
  const picked = ctx._disambiguateBySetName('Gyarados 5 Jungle', candidates);
  assert.strictEqual(picked.id, 'base2-5');
});

test('tcgdex-resolution: _disambiguateBySetName - no recognised set token in the name -> null (never guess)', async () => {
  const { ctx } = await loadApp();
  const candidates = [{ id: 'base2-5' }, { id: 'base3-5' }];
  assert.strictEqual(ctx._disambiguateBySetName('Gyarados 5', candidates), null);
});

test('tcgdex-resolution: _disambiguateBySetName - longest-phrase-first ("Team Rocket Returns" beats the shorter "Team Rocket")', async () => {
  const { ctx } = await loadApp();
  const candidates = [{ id: 'ex7-1' }, { id: 'base5-1' }];
  const picked = ctx._disambiguateBySetName('Some Card 1 Team Rocket Returns', candidates);
  assert.strictEqual(picked.id, 'ex7-1', '"Team Rocket Returns" must resolve to ex7, not be short-circuited by "Team Rocket" -> base5');
});

test('tcgdex-resolution: _pickBestMatch - a card-number match outweighs plain name similarity', async () => {
  const { ctx } = await loadApp();
  const results = [
    { name: 'Gyarados', number: '5', setName: 'Jungle' },   // right number, weaker name overlap with the query below
    { name: 'Gyarados EX', number: '99', setName: 'XY' },   // closer name text, but wrong number
  ];
  const best = ctx._pickBestMatch(results, 'Gyarados 5', '');
  assert.strictEqual(best.number, '5', 'the number-matching candidate wins despite a less specific name');
});

test('tcgdex-resolution: _pickBestMatch - a language hint boosts a matching-language candidate', async () => {
  const { ctx } = await loadApp();
  const results = [
    { name: 'Poliwhirl', number: '176', language: 'English' },
    { name: 'Poliwhirl', number: '176', language: 'Japanese' },
  ];
  const best = ctx._pickBestMatch(results, 'Poliwhirl 176', 'japanese');
  assert.strictEqual(best.language, 'Japanese', 'the JP candidate wins when the caller passes a japanese language hint');
  const bestEn = ctx._pickBestMatch(results, 'Poliwhirl 176', '');
  assert.strictEqual(bestEn.language, 'English', 'with no language hint (EN default), the non-EN candidate is penalised instead');
});

test('tcgdex-resolution: _pickBestMatch - below the similarity floor (~0.2) returns null rather than a bad guess', async () => {
  const { ctx } = await loadApp();
  const results = [{ name: 'Completely Unrelated Card Name', number: '999', setName: 'Some Other Set' }];
  const best = ctx._pickBestMatch(results, 'Charizard', '');
  assert.strictEqual(best, null);
});

test('tcgdex-resolution: _pickBestMatch - empty/no results -> null', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._pickBestMatch([], 'Charizard', ''), null);
  assert.strictEqual(ctx._pickBestMatch(null, 'Charizard', ''), null);
});
