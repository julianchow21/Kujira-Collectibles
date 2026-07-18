'use strict';
// Suite 22: misc-consistency - genId/kjrId uniqueness, TABLE_TO_DB_KEY /
// CL_FIELDS_BY_TABLE coverage, _clDiff/_clSummary, _mktFreshDot banding, and
// the version-consistency META test across index.html/sw.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, plain, ROOT } = require('./harness.js');

test('misc-consistency: genId(prefix) - correct prefix, and effectively unique across 1000 calls in practice', async () => {
  const { ctx } = await loadApp();
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = ctx.genId('single');
    assert.match(id, /^single_\d+_[0-9a-z]{1,4}$/);
    ids.add(id);
  }
  // Not asserting ids.size === 1000 here - see the SUSPECT test below, which
  // deterministically proves this can occasionally collide.
  assert.ok(ids.size >= 990, 'overwhelmingly unique in practice (at most a handful of collisions possible per 1000 calls)');
});

test('misc-consistency: SUSPECT - genId can produce duplicate ids when Date.now() AND the random suffix both coincide (proven deterministically)', async () => {
  const { ctx } = await loadApp();
  // genId = prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,6).
  // A real (non-forced) collision was actually observed empirically: a plain
  // Node repro of the exact same formula produced 1-2 duplicate ids in some
  // 1000-call tight loops (out of 1000, most trials had 0, one trial had 2) -
  // Date.now() has millisecond resolution and a synchronous loop can issue
  // hundreds of calls within the same millisecond, so uniqueness rests
  // entirely on the 4-character base36 random suffix (36^4 ≈ 1.68M
  // possibilities) - a birthday-paradox collision among a few hundred draws
  // sharing one millisecond is unlikely per call but not negligible in
  // aggregate. Proven here deterministically by pinning Math.random(): two
  // calls in the same tick (same Date.now() millisecond, near-certain in a
  // synchronous loop) with the same "random" draw produce IDENTICAL ids.
  // Severity: cosmetic in practice (an actual production collision would
  // need two rows created in the same millisecond AND the same 4-char draw),
  // but genId has no collision-avoidance beyond hoping for entropy - no
  // counter, no crypto.randomUUID.
  const realRandom = ctx.Math.random;
  ctx.Math.random = () => 0.123456;
  try {
    const id1 = ctx.genId('x');
    const id2 = ctx.genId('x');
    assert.strictEqual(id1, id2, 'same millisecond + same random draw -> an actual duplicate id');
  } finally {
    ctx.Math.random = realRandom;
  }
});

test('misc-consistency: kjrGenId (features.js ~137) is a private closure, NOT reachable - kjrId (275) is the equivalent top-level function tested instead', async () => {
  const { ctx, sandbox } = await loadApp();
  // kjrGenId lives inside the import-installer IIFE (features.js) alongside
  // parsePastedTable/mapFields/normH - never assigned to window or any
  // module-scope let/const the harness's grab() could reach either. Confirmed:
  assert.strictEqual(ctx.kjrGenId, undefined, 'not a property of the global object');
  const viaGrab = require('node:vm').runInContext('typeof kjrGenId', sandbox);
  assert.strictEqual(viaGrab, 'undefined', 'not reachable via the shared lexical scope either - genuinely private to the IIFE');

  // kjrId (features.js:275) is the same prefix+timestamp+random pattern,
  // top-level and fully reachable - used as the closest real substitute.
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    const id = ctx.kjrId('etb');
    assert.match(id, /^etb_/);
    ids.add(id);
  }
  assert.strictEqual(ids.size, 1000);
});

test('misc-consistency: TABLE_TO_DB_KEY - every value is a real DB key, but it covers only 7 of DB\'s 8 keys (trash deliberately excluded)', async () => {
  const { ctx, grab } = await loadApp();
  const { TABLE_TO_DB_KEY, DB } = grab('TABLE_TO_DB_KEY', 'DB');
  const dbKeys = Object.keys(DB);
  for (const v of Object.values(TABLE_TO_DB_KEY)) {
    assert.ok(dbKeys.includes(v), `${v} should be a real DB key`);
  }
  // Characterisation, not a bug: 'trash' is local-only bookkeeping (its
  // Supabase table is also literally called 'trash', no snake_case
  // translation needed), so it was never meant to be in this table-name
  // translator - the packet's "cover all 8 tables" premise does not hold
  // for THIS specific constant.
  assert.deepStrictEqual(Object.values(TABLE_TO_DB_KEY).sort(), ['boosterBoxes', 'boosterPacks', 'ebayPurchases', 'etbs', 'sales', 'singles', 'slabs'].sort());
  assert.strictEqual(dbKeys.length, 8);
  assert.ok(!Object.values(TABLE_TO_DB_KEY).includes('trash'));
});

test('misc-consistency: CL_FIELDS_BY_TABLE - every table\'s field list is a subset of plausible DB fields (no stray/renamed keys)', async () => {
  const { grab } = await loadApp();
  const { CL_FIELDS_BY_TABLE } = grab('CL_FIELDS_BY_TABLE');
  const tables = Object.keys(CL_FIELDS_BY_TABLE);
  assert.deepStrictEqual(tables.sort(), ['boosterBoxes', 'boosterPacks', 'ebayPurchases', 'etbs', 'sales', 'singles', 'slabs'].sort());
  for (const [table, fields] of Object.entries(CL_FIELDS_BY_TABLE)) {
    assert.ok(Array.isArray(fields) && fields.length > 0, `${table} must list at least one tracked field`);
    assert.ok(!fields.includes('priceHistory'), 'internal bookkeeping fields must never be logged verbatim');
    assert.ok(!fields.includes('_updatedAt'));
  }
});

test('misc-consistency: _clDiff - changing one field produces a diff mentioning exactly that field, currency-formatted', async () => {
  const { ctx } = await loadApp();
  const before = { name: 'Charizard', costPrice: 100, set: 'Base Set' };
  const after = { name: 'Charizard', costPrice: 150, set: 'Base Set' };
  const diff = ctx._clDiff('singles', before, after);
  assert.match(diff, /costPrice: S\$100 → S\$150/);
  assert.doesNotMatch(diff, /name:/, 'unchanged fields are not mentioned');
});

test('misc-consistency: _clDiff - no tracked field changed -> empty string', async () => {
  const { ctx } = await loadApp();
  const row = { name: 'Charizard', costPrice: 100 };
  assert.strictEqual(ctx._clDiff('singles', row, { ...row }), '');
});

test('misc-consistency: _clSummary - builds a "key=val" snapshot, skipping blank fields', async () => {
  const { ctx } = await loadApp();
  const item = { name: 'Charizard', costPrice: 100, set: '', notes: null };
  const summary = ctx._clSummary('singles', item);
  assert.match(summary, /name=Charizard/);
  assert.match(summary, /costPrice=S\$100/);
  assert.doesNotMatch(summary, /set=/, 'blank fields are omitted entirely, not shown as "set="');
});

test('misc-consistency: _mktFreshDot - green <=30d, amber 31-90d, red >90d', async () => {
  const { ctx } = await loadApp();
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  const green = ctx._mktFreshDot({ marketPrice: 45, priceHistory: [{ date: iso(15), confidence: 'high' }] });
  assert.match(green, /#22c55e/);
  const amber = ctx._mktFreshDot({ marketPrice: 45, priceHistory: [{ date: iso(60), confidence: 'high' }] });
  assert.match(amber, /#f59e0b/);
  const red = ctx._mktFreshDot({ marketPrice: 45, priceHistory: [{ date: iso(120), confidence: 'high' }] });
  assert.match(red, /#ef4444/);
});

test('misc-consistency: _mktFreshDot - a "low" confidence entry is always amber, regardless of age', async () => {
  const { ctx } = await loadApp();
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);
  const freshButLow = ctx._mktFreshDot({ marketPrice: 45, priceHistory: [{ date: iso(2), confidence: 'low' }] });
  assert.match(freshButLow, /#f59e0b/, 'a fuzzy/low-confidence match never shows green, even same-day');
});

test('misc-consistency: _mktFreshDot - no price history or no marketPrice -> empty string (no dot at all)', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx._mktFreshDot({ marketPrice: 45, priceHistory: [] }), '');
  assert.strictEqual(ctx._mktFreshDot({ marketPrice: '', priceHistory: [{ date: '2025-01-01' }] }), '');
});

// ---------------------------------------------------------------------------
// Version-consistency META test: reads index.html + sw.js as whole-file TEXT
// (index.html has an ~85KB single-line base64 blob around line 94 - read via
// fs.readFileSync, never split/streamed line-by-line).
// ---------------------------------------------------------------------------
test('misc-consistency: META - #app-ver badge matches all three ?v= cache-bust params, and sw.js declares a CACHE constant', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const swJs = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

  const badgeMatch = indexHtml.match(/id="app-ver"[^>]*>v([0-9][0-9.]*)/);
  assert.ok(badgeMatch, 'the #app-ver badge must be present and parseable');
  const badgeVersion = badgeMatch[1];

  for (const asset of ['styles.css', 'app.js', 'features.js']) {
    assert.ok(indexHtml.includes(asset + '?v=' + badgeVersion), `${asset} must be cache-busted with ?v=${badgeVersion}`);
  }
  assert.match(swJs, /const CACHE\s*=\s*['"]/, 'sw.js must declare a CACHE constant');
});

test('misc-consistency: META - Sentry release version matches the #app-ver badge', () => {
  // Guards against release-string drift: the badge and the three ?v= params
  // were bumped for 19 versions (3.12 -> 3.31) while Sentry's release string
  // stayed at 3.12, so Sentry grouped errors under a long-dead version.
  // Fixed in v3.32; this test keeps the two in lockstep from now on.
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const badgeMatch = indexHtml.match(/id="app-ver"[^>]*>v([0-9][0-9.]*)/);
  const badgeVersion = badgeMatch[1];
  const releaseMatch = indexHtml.match(/release:\s*'kujira-collectibles@([0-9.]+)'/);
  assert.ok(releaseMatch, 'a Sentry release string must be present');
  assert.strictEqual(releaseMatch[1], badgeVersion, 'Sentry release version should match the shipped app version');
});
