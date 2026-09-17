'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

const ORDER_TABLES = ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'];

function defaultOrder(ctx, rows, table) {
  return ['singles', 'slabs', 'sales'].includes(table)
    ? ctx.sortItems(rows, table)
    : ctx.kjrApplySort(rows, table);
}

test('creation-order: every persisted inventory table uses newest input first, including same-millisecond ties', async () => {
  const seed = {};
  ORDER_TABLES.forEach(table => {
    const labelKey = table === 'singles' || table === 'slabs' ? 'name' : table === 'sales' ? 'product' : 'product';
    seed[table] = [
      { id: table + '-old', [labelKey]: 'Older ' + table, createdAt: 500, createdAtSeq: 10,
        datePurchased: '17 Sep 2026', dateListed: '17 Sep 2026', dateSold: '17 Sep 2026', date: '17 Sep 2026' },
      { id: table + '-new', [labelKey]: 'Newer ' + table, createdAt: 500, createdAtSeq: 11,
        datePurchased: '1 Jan 2020', dateListed: '1 Jan 2020', dateSold: '1 Jan 2020', date: '1 Jan 2020' },
    ];
  });
  const { ctx } = await loadApp({ seed });

  ORDER_TABLES.forEach(table => {
    const rows = ctx.DB[table];
    assert.deepStrictEqual(plain(defaultOrder(ctx, rows, table)).map(row => row.id),
      [table + '-new', table + '-old'], table + ' defaults to creation order, with sequence breaking a timestamp tie');
  });
});

test('creation-order: metadata survives a JSON round trip and edit reconstruction', async () => {
  const original = { id: 's-original', name: 'Original', createdAt: 900, createdAtSeq: 42, datePurchased: '1 Jan 2020' };
  const first = await loadApp({ seed: { singles: [original] } });
  const editedWithoutMetadata = first.ctx.normalizeRecord('singles', { id: original.id, name: 'Renamed', datePurchased: '17 Sep 2026' });
  first.ctx.kjrPreserveCreatedMetadata(editedWithoutMetadata, first.ctx.DB.singles[0]);
  assert.equal(editedWithoutMetadata.createdAt, 900);
  assert.equal(editedWithoutMetadata.createdAtSeq, 42);

  const persisted = JSON.parse(JSON.stringify(first.ctx.DB));
  const second = await loadApp({ seed: persisted });
  assert.deepStrictEqual(plain(defaultOrder(second.ctx, second.ctx.DB.singles, 'singles')).map(row => row.id), ['s-original']);
  assert.equal(second.ctx.DB.singles[0].createdAt, 900);
  assert.equal(second.ctx.DB.singles[0].createdAtSeq, 42);
});

test('creation-order: legacy fallback accepts one exact current label event and explicit Quick Entry ids only', async () => {
  const rows = [
    { id: 'stable-first', name: 'Stable first', datePurchased: '1 Jan 2020' },
    { id: 'legacy-pack', name: '2 pack blister', datePurchased: '17 Sep 2026' },
    { id: 'duplicate-a', name: 'Duplicate label' },
    { id: 'duplicate-b', name: 'Duplicate label' },
    { id: 'renamed', name: 'Current name' },
    { id: 'no-history', name: 'No history' },
  ];
  const { ctx, localStorage } = await loadApp({
    seed: { singles: rows },
    localStorage: {
      pokeinv_changelog: [
        { id: 'cl-legacy', ts: 200, action: 'add', table: 'singles', detail: '2 pack blister', extra: 'via Quick Entry' },
        { id: 'cl-duplicate', ts: 300, action: 'add', table: 'singles', detail: 'Duplicate label', extra: '' },
        { id: 'cl-old-name', ts: 400, action: 'add', table: 'singles', detail: 'Original name', extra: '' },
      ],
    },
  });
  const ordered = plain(ctx.kjrOrderRows(ctx.DB.singles, 'singles')).map(row => row.id);
  assert.deepStrictEqual(ordered, ['legacy-pack', 'stable-first', 'duplicate-a', 'duplicate-b', 'renamed', 'no-history'],
    'unique exact history rises, duplicate and renamed or missing history stay stable');
  assert.equal(ctx.DB.singles.find(row => row.id === 'legacy-pack').createdAt, undefined,
    'legacy inference is render-only and is not persisted onto the row');

  const explicitRows = [
    { id: 'quick-a', name: 'Same label' },
    { id: 'quick-b', name: 'Same label' },
    { id: 'quick-c', name: 'Same label' },
    { id: 'unlisted', name: 'Unlisted row' },
  ];
  ctx.DB.singles = explicitRows;
  localStorage.setItem('pokeinv_changelog', JSON.stringify([
    { id: 'cl-ids', ts: 800, action: 'add', table: 'singles', detail: 'Same label', extra: 'cost · ×3 rows (ids: quick-a, quick-b, quick-c) · via Quick Entry' },
  ]));
  assert.deepStrictEqual(plain(ctx.kjrOrderRows(explicitRows, 'singles')).map(row => row.id), ['quick-a', 'quick-b', 'quick-c', 'unlisted'],
    'every listed Quick Entry id maps despite duplicate labels and a closing parenthesis');
});

test('creation-order: malformed or missing changelog keeps unknown legacy rows in stable stored order', async () => {
  const rows = [
    { id: 'legacy-a', name: 'Legacy A', datePurchased: '1 Jan 2020' },
    { id: 'legacy-b', name: 'Legacy B', datePurchased: '17 Sep 2026' },
  ];
  const { ctx, localStorage } = await loadApp({ seed: { singles: rows }, localStorage: { pokeinv_changelog: '{not-json' } });
  assert.deepStrictEqual(plain(ctx.kjrOrderRows(ctx.DB.singles, 'singles')).map(row => row.id), ['legacy-a', 'legacy-b']);
  localStorage.setItem('pokeinv_changelog', JSON.stringify({ unexpected: true }));
  assert.deepStrictEqual(plain(ctx.kjrOrderRows(ctx.DB.singles, 'singles')).map(row => row.id), ['legacy-a', 'legacy-b']);
});

test('creation-order: local recent pinning cannot override a newer row from another tab, and explicit columns remain effective', async () => {
  const rows = [
    { id: 'local-old', name: 'Alpha', createdAt: 100 },
    { id: 'remote-new', name: 'Zulu', createdAt: 200 },
  ];
  const { ctx } = await loadApp({ seed: { singles: rows } });
  ctx._pinRecentlyAdded('singles', 'local-old');
  assert.deepStrictEqual(plain(ctx.sortItems(rows, 'singles')).map(row => row.id), ['remote-new', 'local-old']);
  ctx.sortState.singles.col = 'name';
  ctx.sortState.singles.dir = 1;
  assert.deepStrictEqual(plain(ctx.sortItems(rows, 'singles')).map(row => row.id), ['local-old', 'remote-new'],
    'a clicked column sort still controls the visible order');
});

test('creation-order: listing picker and search include booster packs and apply creation order before the twelve-result cap', async () => {
  const rows = Array.from({ length: 13 }, (_, index) => ({
    id: 'pack-' + index,
    product: 'Searchable Pack ' + index,
    status: 'Sealed',
    createdAt: 100 + index,
  }));
  const { ctx, document } = await loadApp({ seed: { boosterPacks: rows } });
  const candidates = rows.map(data => ({ src: 'boosterPacks', data }));
  assert.deepStrictEqual(plain(ctx.kjrOrderListingCandidates(candidates)).map(candidate => candidate.data.id),
    rows.slice().reverse().map(row => row.id));

  ctx.lstSearchItems('searchable');
  assert.deepStrictEqual(plain(ctx._lstHits).map(hit => hit.data.id), rows.slice().reverse().slice(0, 12).map(row => row.id));
  ctx.populateListingSelect();
  const html = document.getElementById('lst-item').innerHTML;
  assert.ok(html.indexOf('pack-12') < html.indexOf('pack-11'), 'listing select puts the newest pack before the next newest pack');
});

test('creation-order: sales history uses sell events, while add events do not invent a sales timestamp', async () => {
  const rows = [
    { id: 'sale-old', product: 'Older sale' },
    { id: 'sale-new', product: 'Newer sale' },
  ];
  const { ctx, localStorage } = await loadApp({ seed: { sales: rows }, localStorage: {
    pokeinv_changelog: [
      { id: 'wrong-action', ts: 900, action: 'add', table: 'sales', detail: 'Older sale', extra: '' },
      { id: 'right-action', ts: 800, action: 'sell', table: 'sales', detail: 'Newer sale', extra: '' },
    ],
  } });
  assert.deepStrictEqual(plain(ctx.kjrOrderRows(ctx.DB.sales, 'sales')).map(row => row.id), ['sale-new', 'sale-old']);
  localStorage.setItem('pokeinv_changelog', JSON.stringify([
    { id: 'wrong-action', ts: 900, action: 'add', table: 'sales', detail: 'Older sale', extra: '' },
  ]));
  assert.deepStrictEqual(plain(ctx.kjrOrderRows(ctx.DB.sales, 'sales')).map(row => row.id), ['sale-old', 'sale-new']);
});
