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

// v3.77: the table is walked in declared order, and "base set" is declared before "expedition", so "Expedition Base Set" used to hit
// "base set" first and resolve to Base Set (base1), a wrong card priced as the right one. It now takes the LONGEST phrase the name
// holds, the same rule _tcgdexSetIdIn uses (the two share one implementation, they cannot drift apart again). Ids are TCGdex's own,
// from the table: Base Set base1, Jungle base2, Fossil base3, Base Set 2 base4, Team Rocket base5, Expedition Base Set ecard1.
test('tcgdex-resolution: _disambiguateBySetName - "Base Set", "Base Set 2" and "Expedition Base Set" each pick their own set (base1, base4, ecard1)', async () => {
  const { ctx } = await loadApp();
  // One printing per set, so a pick of the wrong set is possible for every name and shows up as a wrong id.
  const candidates = [{ id: 'base1-4' }, { id: 'base4-4' }, { id: 'ecard1-4' }];
  assert.strictEqual(ctx._disambiguateBySetName('Charizard 4 Base Set', candidates).id, 'base1-4');
  assert.strictEqual(ctx._disambiguateBySetName('Charizard 4 Base Set 2', candidates).id, 'base4-4', '"Base Set 2" is base4, not base2 (that is Jungle) and not base1');
  assert.strictEqual(ctx._disambiguateBySetName('Charizard 4 Expedition Base Set', candidates).id, 'ecard1-4', 'first-match over the table gave base1 here');
  // candidate order must not matter
  const reversed = candidates.slice().reverse();
  assert.strictEqual(ctx._disambiguateBySetName('Charizard 4 Expedition Base Set', reversed).id, 'ecard1-4');
  assert.strictEqual(ctx._disambiguateBySetName('Charizard 4 Base Set 2', reversed).id, 'base4-4');
  assert.strictEqual(ctx._disambiguateBySetName('Charizard 4 Base Set', reversed).id, 'base1-4');
  // the set words can sit anywhere in the name, in any case
  assert.strictEqual(ctx._disambiguateBySetName('EXPEDITION BASE SET Charizard 4', candidates).id, 'ecard1-4');
});

test('tcgdex-resolution: _disambiguateBySetName - agrees with _tcgdexSetIdIn for every set the table names', async () => {
  const { ctx } = await loadApp();
  const names = ['Base Set', 'Base Set 2', 'Expedition Base Set', 'Team Rocket', 'Team Rocket Returns', 'Jungle', 'Fossil', 'Neo Genesis', 'Skyridge'];
  for (const text of names) {
    const setId = ctx._tcgdexSetIdIn(text);
    assert.ok(setId, text + ' names a set');
    const picked = ctx._disambiguateBySetName('Card 7 ' + text, [{ id: setId + '-7' }, { id: 'zzz-7' }]);
    assert.strictEqual(picked && picked.id, setId + '-7', text);
  }
});

test('tcgdex-resolution: _disambiguateBySetName - the longest phrase names the set, so a shorter phrase inside it never rescues a miss (never guess)', async () => {
  const { ctx } = await loadApp();
  // The name says Expedition Base Set but only Base Set and Base Set 2 printings came back. Falling through to the shorter "base set"
  // used to hand back base1-4, a different set's card. Now it is unresolved.
  assert.strictEqual(ctx._disambiguateBySetName('Charizard 4 Expedition Base Set', [{ id: 'base1-4' }, { id: 'base4-4' }]), null);
  // "Base Set 2" with no base4 printing must not fall back to base1 either
  assert.strictEqual(ctx._disambiguateBySetName('Charizard 4 Base Set 2', [{ id: 'base1-4' }, { id: 'base3-4' }]), null);
  // "Team Rocket Returns" with no ex7 printing must not fall back to base5
  assert.strictEqual(ctx._disambiguateBySetName('Some Card 1 Team Rocket Returns', [{ id: 'base5-1' }, { id: 'base2-1' }]), null);
});

test('tcgdex-resolution: _disambiguateBySetName - two different sets named by phrases of the same length name neither (null, never a guess)', async () => {
  const { ctx } = await loadApp();
  // "jungle" and "fossil" are both six letters, so the name does not say which set. First-match used to return Jungle (declared first).
  assert.strictEqual(ctx._disambiguateBySetName('Gyarados 5 Jungle Fossil', [{ id: 'base2-5' }, { id: 'base3-5' }]), null);
  assert.strictEqual(ctx._disambiguateBySetName('Gyarados 5 Fossil Jungle', [{ id: 'base2-5' }, { id: 'base3-5' }]), null);
});

test('tcgdex-resolution: _disambiguateBySetName - still null when the named set has no candidate or more than one, and tolerates junk input', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._disambiguateBySetName('Gyarados 5 Jungle', [{ id: 'base3-5' }]), null, 'the named set has no candidate');
  assert.strictEqual(ctx._disambiguateBySetName('Gyarados 5 Jungle', [{ id: 'base2-5' }, { id: 'base2-5b' }, { id: 'base3-5' }]), null, 'two candidates in the named set is still ambiguous');
  assert.strictEqual(ctx._disambiguateBySetName('Gyarados 5 Jungle', []), null);
  assert.strictEqual(ctx._disambiguateBySetName('Gyarados 5 Jungle', [null, undefined, { id: 7 }, {}]), null, 'malformed candidates never throw');
  assert.strictEqual(ctx._disambiguateBySetName(null, [{ id: 'base2-5' }]), null);
  assert.strictEqual(ctx._disambiguateBySetName(undefined, [{ id: 'base2-5' }]), null);
  assert.strictEqual(ctx._disambiguateBySetName('Gyarados 5 Jungle', null), null, 'a missing candidate list is unresolved, not a throw');
});

test('tcgdex-resolution: resolveTcgdexId - "Charizard 4 Expedition Base Set" resolves to the Expedition printing, not the Base Set one (end to end through the lookup)', async () => {
  const { ctx, fetchMock } = await loadApp();
  fetchMock.route('/cards?name=', { ok: true, json: [{ id: 'base1-4', name: 'Charizard' }, { id: 'base4-4', name: 'Charizard' }, { id: 'ecard1-4', name: 'Charizard' }] });
  const item = { name: 'Charizard 4 Expedition Base Set', language: 'EN' };
  assert.strictEqual(await ctx.resolveTcgdexId(item), 'ecard1-4');
  assert.strictEqual(item.tcgdexId, 'ecard1-4');
  // a name with no set words stays unresolved against the same three printings
  const bare = { name: 'Charizard 4', language: 'EN' };
  assert.strictEqual(await ctx.resolveTcgdexId(bare), null);
  assert.strictEqual(bare.tcgdexId, undefined);
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
