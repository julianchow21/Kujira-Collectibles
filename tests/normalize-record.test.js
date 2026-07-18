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

// ---------------------------------------------------------------------------
// v3.33 - canonicalCondition extraction. Quick Entry used to default to the
// short form 'NM' while normalizeRecord expanded to 'Near Mint', logging a
// phantom changelog diff on every edit-modal save that didn't touch condition.
// Both paths (plus CSV import) now delegate to one shared canonicalCondition()
// helper - these tests pin the write paths to canonical agreement.
// ---------------------------------------------------------------------------

test('normalize-record: parseSmartLine defaults to condition "Near Mint" with conditionExplicit false when no condition token is present', async () => {
  const { ctx } = await loadApp();
  const out = ctx.parseSmartLine('Zapdos 42 RH $35 EN');
  assert.strictEqual(out.condition, 'Near Mint');
  assert.strictEqual(out.conditionExplicit, false);
});

test('normalize-record: parseSmartLine and normalizeRecord agree on every condition token, both landing on one of the six canonical long forms', async () => {
  const { ctx } = await loadApp();
  const CANON = ['Mint', 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
  const tokens = ['NM', 'nm', 'near mint', 'LP', 'lightly played', 'MP', 'moderately played', 'HP', 'heavily played', 'damaged', 'mint'];
  for (const token of tokens) {
    const parsed = ctx.parseSmartLine('Zapdos 42 $10 ' + token).condition;
    const normalized = ctx.normalizeRecord('singles', { condition: token }).condition;
    assert.strictEqual(parsed, normalized, `parseSmartLine and normalizeRecord disagree on token "${token}"`);
    assert.ok(CANON.includes(parsed), `"${parsed}" (from token "${token}") is not one of the six canonical forms`);
  }
});

test('normalize-record: canonicalCondition is a no-op on all six already-canonical values (idempotent)', async () => {
  const { ctx } = await loadApp();
  const CANON = ['Mint', 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
  for (const c of CANON) {
    assert.strictEqual(ctx.canonicalCondition(c), c);
  }
});

test('normalize-record: normalizeRecord is idempotent on condition - running it twice matches running it once', async () => {
  const { ctx } = await loadApp();
  const CANON = ['Mint', 'Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
  for (const c of CANON) {
    const once = ctx.normalizeRecord('singles', { condition: c }).condition;
    const twice = ctx.normalizeRecord('singles', { condition: once }).condition;
    assert.strictEqual(twice, once, `double-normalizing "${c}" changed the value`);
  }
  // Also starting from a short form - the fixed point is reached after one pass.
  const onceShort = ctx.normalizeRecord('singles', { condition: 'nm' }).condition;
  const twiceShort = ctx.normalizeRecord('singles', { condition: onceShort }).condition;
  assert.strictEqual(onceShort, 'Near Mint');
  assert.strictEqual(twiceShort, 'Near Mint');
});

test('normalize-record: migration v4 canonicalises legacy short-form condition in DB.singles and DB.trash on first load, guarded by pokeinv_migrated_v4 thereafter', async () => {
  const LOCALHOST_LOCATION = {
    protocol: 'http:', hostname: 'localhost', host: 'localhost:3800',
    href: 'http://localhost:3800/', origin: 'http://localhost:3800',
    pathname: '/', search: '',
  };
  // sbFetchAll('singles'/'slabs'/'sales') is NOT gated by isLocalhostPreview
  // (only writes are - see flush-guard.test.js) and has no internal .catch, so
  // the harness's default "everything rejects" fetch would send initDB
  // straight to its outer catch (app.js ~1023), skipping every migration
  // block. Resolve just those three to an empty page so the rest of initDB
  // runs exactly like a real "cloud has nothing new" load; everything else
  // (etbs/booster*/ebay, FX rate, etc.) keeps the proven-safe default
  // rejection every other test in this suite already relies on.
  const fetchStub = async (url) => {
    const u = String(url);
    if (u.includes('/rest/v1/singles') || u.includes('/rest/v1/slabs') || u.includes('/rest/v1/sales')) {
      return { ok: true, status: 200, json: async () => [], text: async () => '[]', headers: { get: () => null } };
    }
    throw new TypeError('offline');
  };
  const trashSnapshot = [{
    id: 'trash_1',
    data: { originalTable: 'singles', originalId: 'x9', item: { id: 'x9', name: 'Old Trashed', condition: 'NM' }, deletedAt: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  }];

  const first = await loadApp({
    location: LOCALHOST_LOCATION,
    fetch: fetchStub,
    seed: { singles: [{ id: 's1', name: 'Test Card', condition: 'NM', qty: 1, status: 'Available' }] },
    localStorage: {
      pokeinv_migrated_v2: '1',
      pokeinv_migrated_v3: '1',
      _kjrLocalTrash: JSON.stringify(trashSnapshot),
    },
  });
  const { DB: db1 } = first.grab('DB');
  const { _dirty: dirty1 } = first.grab('_dirty');
  assert.strictEqual(db1.singles.find(r => r.id === 's1').condition, 'Near Mint', 'legacy short form is canonicalised on load');
  assert.strictEqual(dirty1.singles.has('s1'), true, 'the fixed row is marked dirty so it re-syncs');
  assert.strictEqual(db1.trash[0].data.item.condition, 'Near Mint', 'trash snapshot condition is canonicalised too');
  assert.strictEqual(first.localStorage.getItem('pokeinv_migrated_v4'), '1', 'flag is set once the migration has run');

  // Second load: identical starting data, but the v4 flag is already set -
  // the block must be skipped entirely, leaving the still-legacy value alone.
  const second = await loadApp({
    location: LOCALHOST_LOCATION,
    fetch: fetchStub,
    seed: { singles: [{ id: 's1', name: 'Test Card', condition: 'NM', qty: 1, status: 'Available' }] },
    localStorage: {
      pokeinv_migrated_v2: '1',
      pokeinv_migrated_v3: '1',
      pokeinv_migrated_v4: '1',
      _kjrLocalTrash: JSON.stringify(trashSnapshot),
    },
  });
  const { DB: db2 } = second.grab('DB');
  assert.strictEqual(db2.singles.find(r => r.id === 's1').condition, 'NM', 'guarded by the flag - a second load does not touch it');
});
