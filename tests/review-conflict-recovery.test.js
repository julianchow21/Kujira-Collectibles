'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const RECOVERY = 'pokeinv_conflict_recovery_v1:';
function snapshot(storage) {
  return Object.fromEntries(Array.from({ length: storage.length }, (_, index) => {
    const key = storage.key(index);
    return [key, storage.getItem(key)];
  }));
}
function recoveredRows(extra) {
  return JSON.parse(extra.slice(extra.indexOf('preserved older snapshots: ') + 'preserved older snapshots: '.length));
}
function archives(storage) {
  return Object.entries(snapshot(storage)).filter(([key]) => key.startsWith(RECOVERY));
}
async function conflictFixture(count = 2) {
  const loaded = await loadApp({ seed: { singles: [] } });
  const markers = [];
  for (let index = 0; index < count; index++) {
    const token = 'foreign-' + index + ':edit';
    const row = { id: 'shared', name: 'Exact original ' + index, costPrice: index, notes: 'x'.repeat(150) };
    const marker = { table: 'singles', id: row.id, token, owner: 'foreign-' + index,
      createdAt: index + 1, rowJson: JSON.stringify(row) };
    const key = 'pokeinv_dirty_v2:' + token;
    loaded.localStorage.setItem(key, JSON.stringify(marker));
    markers.push({ key, marker });
  }
  return { ...loaded, markers };
}

test('review recovery: quota failure keeps both exact snapshots and does not authorise cleanup', async () => {
  const { ctx, localStorage, markers } = await conflictFixture();
  const original = snapshot(localStorage);
  const realSet = localStorage.setItem.bind(localStorage);
  const bytes = pairs => Object.entries(pairs).reduce((total, [key, value]) => total + key.length + value.length, 0);
  const limit = bytes(original) + 128;
  localStorage.setItem = (key, value) => {
    if (bytes({ ...snapshot(localStorage), [key]: String(value) }) > limit) throw new Error('QuotaExceededError');
    realSet(key, value);
  };
  ctx._recoverDirtyV2Snapshots();
  for (const { key } of markers) assert.equal(localStorage.getItem(key), original[key]);
  assert.equal(ctx._unresolvedDirtyWinnerTokens.has(markers[1].marker.token), true);
  assert.equal(archives(localStorage).length, 0);
  localStorage.setItem = realSet;
  ctx._recoverDirtyV2Snapshots();
  assert.equal(localStorage.getItem(markers[0].key), null);
  assert.equal(ctx._unresolvedDirtyWinnerTokens.has(markers[1].marker.token), false);
  assert.match(archives(localStorage)[0][1], /Exact original 0/);
});

test('review recovery: failed winner journal write keeps losers and reuses its recovery record', async () => {
  const { ctx, localStorage, markers } = await conflictFixture();
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === markers[1].key) throw new Error('winner journal unavailable');
    realSet(key, value);
  };
  ctx._recoverDirtyV2Snapshots();
  assert.ok(localStorage.getItem(markers[0].key));
  assert.equal(archives(localStorage).length, 1);
  localStorage.setItem = realSet;
  ctx._recoverDirtyV2Snapshots();
  assert.equal(localStorage.getItem(markers[0].key), null);
  assert.equal(archives(localStorage).length, 1);
});

test('review recovery: removal follows durable archival despite a peer replacing the shared log', async () => {
  const { ctx, localStorage, markers } = await conflictFixture();
  const realRemove = localStorage.removeItem.bind(localStorage);
  let observed = false;
  localStorage.removeItem = key => {
    if (key === markers[0].key) {
      const records = archives(localStorage);
      assert.equal(records.length, 1);
      assert.ok(recoveredRows(JSON.parse(records[0][1]).extra).some(row => row.rowJson === markers[0].marker.rowJson));
      localStorage.setItem('pokeinv_changelog', '[]');
      observed = true;
    }
    realRemove(key);
  };
  ctx._recoverDirtyV2Snapshots();
  assert.equal(observed, true);
  const reloaded = await loadApp({ localStorage: snapshot(localStorage) });
  assert.ok(reloaded.ctx.clLoad().some(entry => entry.extra.includes('preserved older snapshots: ') && recoveredRows(entry.extra).some(row => row.rowJson === markers[0].marker.rowJson)));
  reloaded.ctx.kjrConfirm = async () => true;
  await reloaded.ctx.clearChangelog();
  assert.equal(archives(reloaded.localStorage).length, 1);
  assert.ok(reloaded.ctx.clLoad().some(entry => entry.extra.includes('preserved older snapshots: ') && recoveredRows(entry.extra).some(row => row.rowJson === markers[0].marker.rowJson)));
});

test('review recovery: more than the audit limit preserves every losing payload', async () => {
  const { ctx, localStorage, markers } = await conflictFixture(502);
  ctx._recoverDirtyV2Snapshots();
  const records = archives(localStorage);
  assert.equal(records.length, 1);
  const extra = JSON.parse(records[0][1]).extra;
  for (const { key, marker } of markers.slice(0, -1)) {
    assert.ok(recoveredRows(extra).some(row => row.rowJson === marker.rowJson), marker.token);
    assert.equal(localStorage.getItem(key), null);
  }
  for (let index = 0; index < 505; index++) ctx.clLog('edit', 'singles', 'ordinary ' + index, '');
  assert.ok(ctx.clLoad().some(entry => entry.extra === extra));
});

test('review recovery: generic sync conflict completes when only the shared audit mirror fails', async () => {
  const { ctx, localStorage } = await loadApp({
    seed: { singles: [{ id: 'same', name: 'Unacknowledged local', costPrice: 25, _serverVersion: 2 }] },
  });
  const realSet = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === 'pokeinv_changelog') throw new Error('audit mirror unavailable');
    realSet(key, value);
  };
  const conflict = { table: 'singles', id: 'same', current: {
    id: 'same', data: { name: 'Acknowledged server', costPrice: 50 },
    row_version: 3, updated_at: '2026-10-03T00:00:00Z',
  }, tombstone: null };
  const operation = { type: 'upsert', table: 'singles', id: 'same', expected_version: 2,
    data: { name: 'Unacknowledged local', costPrice: 25 } };
  assert.equal(ctx._applySyncConflict(conflict, operation), true);
  assert.equal(ctx.DB.singles[0].name, 'Acknowledged server');
  assert.equal(archives(localStorage).length, 1);
  assert.ok(ctx.clLoad()[0].extra.includes('Unacknowledged local'));
  assert.equal(ctx.clLog('edit', 'singles', 'ordinary write', ''), false);
});

test('review recovery: unreadable archive bytes are never removed by loading or clearing the audit log', async () => {
  const { ctx, localStorage } = await loadApp();
  localStorage.setItem(RECOVERY + 'damaged', '{ exact damaged recovery bytes');
  ctx.clLoad();
  ctx.kjrConfirm = async () => true;
  await ctx.clearChangelog();
  assert.equal(localStorage.getItem(RECOVERY + 'damaged'), '{ exact damaged recovery bytes');
});
