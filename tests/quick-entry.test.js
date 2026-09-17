'use strict';

// Quick Entry regression coverage: parser metadata, destination row shapes,
// and the deferred sync boundary used by cmdAddKey.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const LOCALHOST_LOCATION = {
  protocol: 'http:', hostname: 'localhost', host: 'localhost:3800',
  href: 'http://localhost:3800/', origin: 'http://localhost:3800',
  pathname: '/', search: '',
};

function enter(ctx, document, line) {
  const input = document.getElementById('cmd-add-input');
  input.value = line;
  return ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });
}

test('quick-entry: slabs preserve language and dates in preview and saved rows', async () => {
  const { ctx, document } = await loadApp({ location: LOCALHOST_LOCATION });
  const today = ctx._quickEntryToday();
  const previewInput = document.getElementById('cmd-add-input');

  previewInput.value = 'TAG 9 Eevee 173 JP cert L6786028 date 2026-09-10 $81';
  ctx.cmdAddPreview();
  assert.match(document.getElementById('cmd-add-preview').innerHTML, /Will be added to Slabs/);
  assert.match(document.getElementById('cmd-add-preview').innerHTML, /JP/);
  assert.match(document.getElementById('cmd-add-preview').innerHTML, /Date: 10 Sep 2026/);
  await ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });

  const explicit = ctx.DB.slabs.at(-1);
  assert.equal(explicit.name, 'Eevee 173');
  assert.equal(explicit.language, 'JP');
  assert.equal(explicit.dateListed, '10 Sep 2026');
  assert.equal(explicit.certNo, 'L6786028');
  assert.equal(explicit.costPrice, 81);
  assert.equal(ctx._dirty.slabs.has(explicit.id), true, 'the saved slab is queued against the slabs table');
  const cached = JSON.parse(ctx.localStorage.getItem('pokeinventory_v3'));
  assert.equal(cached.slabs.some(row => row.id === explicit.id && row.language === 'JP'), true,
    'the saved slab is present in the immediate local cache');

  await enter(ctx, document, 'PSA 10 Charizard ex 223 #119569490 $850');
  const defaulted = ctx.DB.slabs.at(-1);
  assert.equal(defaulted.language, 'EN');
  assert.equal(defaulted.dateListed, today);
  assert.equal(defaulted.certNo, '119569490');
  assert.equal(defaulted.costPrice, 850);
});

test('quick-entry: sealed product phrases route to existing tables and preserve product quantities', async () => {
  const { ctx, document } = await loadApp({ location: LOCALHOST_LOCATION });
  const cases = [
    { table: 'etbs', line: 'Crown Zenith ETB JP x2 $30 date 2026-09-01', product: 'Crown Zenith ETB', rows: 2, language: 'JP' },
    { table: 'boosterBoxes', line: 'SV8 Booster Box x3 $5 date 2026-09-02', product: 'SV8 Booster Box', rows: 1, qty: 3, total: 15 },
    { table: 'boosterPacks', line: 'SV8 Booster Pack JP x4 $2', product: 'SV8 Booster Pack', rows: 1, qty: 4, total: 8, language: 'JP' },
    { table: 'boosterPacks', line: 'SV8 Booster Bundle x2 $20', product: 'SV8 Booster Bundle', rows: 1, qty: 2, total: 40 },
    { table: 'boosterPacks', line: 'SV8 Sleeved Booster x2 $7', product: 'SV8 Sleeved Booster', rows: 1, qty: 2, total: 14 },
    { table: 'boosterPacks', line: 'SV8 Booster Sleeves x2 $6', product: 'SV8 Booster Sleeves', rows: 1, qty: 2, total: 12 },
    { table: 'boosterPacks', line: 'SV8 Blister Packs x2 $12', product: 'SV8 Blister Packs', rows: 1, qty: 2, total: 24 },
  ];

  document.getElementById('cmd-add-input').value = 'SV8 Booster Box x3 $5';
  ctx.cmdAddPreview();
  const preview = document.getElementById('cmd-add-preview').innerHTML;
  assert.match(preview, /Will be added to Booster Boxes/);
  assert.match(preview, /EN/);
  assert.match(preview, /Date:/);
  assert.doesNotMatch(preview, /Near Mint/, 'sealed rows do not claim a card condition they will not save');

  const before = Object.fromEntries(Object.keys(ctx.DB).map(table => [table, ctx.DB[table].length]));
  for (const item of cases) {
    await enter(ctx, document, item.line);
    assert.equal(ctx.DB[item.table].length, before[item.table] + item.rows, item.line);
    const saved = ctx.DB[item.table].at(-1);
    if (item.table === 'etbs') {
      assert.equal(saved.product, item.product);
      assert.equal(saved.language, item.language);
      assert.equal(saved.totalPrice, 30);
      assert.equal(saved.date, '1 Sep 2026');
    } else {
      assert.equal(saved.product, item.product);
      assert.equal(saved.language, item.language || 'EN');
      assert.equal(saved.qty, item.qty);
      assert.equal(saved.unitPrice, item.total / item.qty);
      assert.equal(saved.totalPrice, item.total);
    }
    before[item.table] = ctx.DB[item.table].length;
  }
});

test('quick-entry: notes stay attached to singles, sealed singles retain metadata, and invalid lines do not write', async () => {
  const { ctx, document } = await loadApp({ location: LOCALHOST_LOCATION });
  const input = document.getElementById('cmd-add-input');
  const counts = () => Object.fromEntries(Object.keys(ctx.DB).map(table => [table, ctx.DB[table].length]));

  const noted = ctx.parseSmartLine('Pikachu 25 notes: booster pack');
  assert.equal(noted.targetTable, 'singles');
  assert.equal(noted.type, 'raw');
  assert.equal(noted.name, 'Pikachu 25');
  assert.equal(noted.notes, 'booster pack');
  await enter(ctx, document, 'Pikachu 25 notes: booster pack');
  assert.equal(ctx.DB.singles.at(-1).name, 'Pikachu 25');
  assert.equal(ctx.DB.singles.at(-1).notes, 'booster pack');
  const notedLogs = JSON.parse(ctx.localStorage.getItem('pokeinv_changelog') || '[]')
    .filter(entry => entry.action === 'add' && entry.table === 'singles' && entry.detail === 'Pikachu 25');
  assert.equal(notedLogs.length, 1, 'one Quick Entry action creates one changelog entry');

  await enter(ctx, document, 'Charmander 44 sealed JP $30 date 2026-09-03');
  const sealedSingle = ctx.DB.singles.at(-1);
  assert.equal(sealedSingle.type, 'sealed');
  assert.equal(sealedSingle.language, 'JP');
  assert.equal(sealedSingle.datePurchased, '3 Sep 2026');
  assert.equal(sealedSingle.costPrice, 30);

  const beforeInvalid = counts();
  const impossible = ctx.parseSmartLine('Pikachu 25 date 31 Feb 2026 $10');
  assert.equal(impossible._error, 'Invalid date');
  await enter(ctx, document, 'Pikachu 25 date 31 Feb 2026 $10');
  assert.deepEqual(counts(), beforeInvalid, 'impossible canonical dates must not create rows');
  await enter(ctx, document, '$10');
  assert.deepEqual(counts(), beforeInvalid, 'unnamed input must not create rows');
  input.value = '';
  await ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(counts(), beforeInvalid, 'empty input must not create rows');
});

test('quick-entry: submitted input is consumed before deferred sync', async () => {
  const { ctx, document } = await loadApp({ location: LOCALHOST_LOCATION });
  const input = document.getElementById('cmd-add-input');
  const initialCount = ctx.DB.singles.length;
  let release;
  let syncCalls = 0;
  ctx.saveAllToSupabase = () => {
    syncCalls++;
    return new Promise(resolve => { release = resolve; });
  };

  input.value = 'Eevee 173 EN $9';
  const firstSave = ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });
  assert.equal(syncCalls, 1);
  assert.equal(input.value, '', 'the submitted line is cleared before awaiting sync');
  assert.equal(ctx.DB.singles.length, initialCount + 1);

  await ctx.cmdAddKey({ key: 'Enter', preventDefault() {} });
  assert.equal(ctx.DB.singles.length, initialCount + 1, 'a second Enter cannot duplicate the submitted line');

  input.value = 'Pikachu 25 EN $10';
  release();
  await firstSave;
  assert.equal(input.value, 'Pikachu 25 EN $10', 'a new draft typed while sync is pending is preserved');
});
