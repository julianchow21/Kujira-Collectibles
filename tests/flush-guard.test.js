'use strict';
// Suite 9: flush-guard - regression coverage for a real past data-loss bug.
// _flushDirtyToSupabase MUST bail at the top on a localhost preview WITHOUT
// clearing dirty flags (a guard-skipped upsert must never read as "synced").
//
// Note: loadApp() itself triggers initDB()'s own cloud-read attempts
// (sbFetchAll for all 7 tables) and the FX-rate fetches - none of those are
// gated by isLocalhostPreview() (only WRITES are guarded, reads are not,
// confirmed by running this against a localhost location below and still
// seeing load-time fetch attempts). So every test here resets
// fetchMock.calls to [] right after loadApp() resolves, and only inspects
// calls made by the explicit _flushDirtyToSupabase() call under test.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

const LOCALHOST_LOCATION = {
  protocol: 'http:', hostname: 'localhost', host: 'localhost:3800',
  href: 'http://localhost:3800/', origin: 'http://localhost:3800',
  pathname: '/', search: '',
};

function copyStorage(localStorage) {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) out[key] = localStorage.getItem(key);
  }
  return out;
}

function dirtyV2Snapshot(localStorage) {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('pokeinv_dirty_v2:')) out[key] = localStorage.getItem(key);
  }
  return out;
}

test('flush-guard: localhost preview -> _flushDirtyToSupabase makes ZERO fetch calls and does NOT clear the dirty flag', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  assert.strictEqual(ctx.isLocalhostPreview(), true, 'sanity check the location shim is actually read as a localhost preview');
  fetchMock.calls.length = 0; // drop load-time reads (sbFetchAll/FX rate), not gated by the preview guard
  await ctx._flushDirtyToSupabase();
  assert.strictEqual(fetchMock.calls.length, 0, 'the preview guard must bail BEFORE any network attempt');
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('single_seed_1'), true, 'dirty flag survives - a guard-skipped write must never be treated as synced');
});

test('flush-guard: github.io + successful upserts -> dirty flags clear, requests hit the correct snake_case table names', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  assert.strictEqual(ctx.isLocalhostPreview(), false);
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: true, status: 200, json: {} });
  await ctx._flushDirtyToSupabase();
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('single_seed_1'), false, 'dirty flag cleared after a real successful upsert');
  const upsertCalls = fetchMock.calls.filter(c => c.url.includes('/rest/v1/singles') && c.opts && c.opts.method === 'POST');
  assert.ok(upsertCalls.length >= 1, 'a POST upsert request was made against the singles table');
});

test('flush-guard: fetch failure during flush -> dirty flags are RETAINED, not cleared', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: false, status: 500, text: 'server exploded' });
  await ctx._flushDirtyToSupabase();
  const { _dirty } = grab('_dirty');
  assert.strictEqual(_dirty.singles.has('single_seed_1'), true, 'a failed upsert must leave the row dirty so the next saveData() retries it');
});

test('flush-guard: only tables with actually-dirty rows get an upsert request', async () => {
  const { ctx, fetchMock } = await loadApp({
    seed: {
      singles: [{ id: 'single_seed_1', name: 'A', status: 'Available' }],
      slabs: [{ id: 'slab_1', name: 'B', status: 'Available' }],
    },
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) }, // slabs NOT dirty
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: true, json: {} });
  await ctx._flushDirtyToSupabase();
  const posts = fetchMock.calls.filter(c => c.opts && c.opts.method === 'POST');
  assert.ok(posts.some(c => c.url.includes('/rest/v1/singles')));
  assert.ok(!posts.some(c => c.url.includes('/rest/v1/slabs')), 'slabs had no dirty rows, so it must not sync at all');
});

test('flush-guard: an edit made during an in-flight upload stays dirty and survives reload', async () => {
  const { ctx, fetchMock, grab, localStorage } = await loadApp({
    seed: { singles: [{ id: 'single_seed_1', name: 'Before upload', status: 'Available' }] },
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  fetchMock.calls.length = 0;
  let releasePost;
  let announcePost;
  const postStarted = new Promise(resolve => { announcePost = resolve; });
  fetchMock.route('/rest/v1/singles', (url, opts) => {
    assert.strictEqual(opts.method, 'POST');
    announcePost();
    return new Promise(resolve => {
      releasePost = () => resolve({
        ok: true, status: 200,
        json: async () => [{ updated_at: '2026-08-29T12:00:00.000Z' }],
        text: async () => '', headers: { get: () => null },
      });
    });
  });

  const flushing = ctx._flushDirtyToSupabase();
  await postStarted;
  const { DB } = grab('DB');
  DB.singles[0].name = 'Edited while uploading';
  ctx.markDirty('singles', 'single_seed_1');
  ctx.saveData();
  releasePost();
  await flushing;

  const posted = JSON.parse(fetchMock.calls.find(c => c.opts && c.opts.method === 'POST').opts.body);
  assert.strictEqual(posted[0].data.name, 'Before upload', 'the request body is the exact pre-await snapshot, not a live object reference');
  const dirtyAfter = JSON.parse(localStorage.getItem('pokeinv_dirty_v1'));
  assert.ok(dirtyAfter.singles.includes('single_seed_1'), 'the newer mutation token remains dirty after the older upload succeeds');
  assert.strictEqual(JSON.parse(localStorage.getItem('pokeinventory_v3')).singles[0].name, 'Edited while uploading');

  const reloaded = await loadApp({
    localStorage: {
      pokeinventory_v3: localStorage.getItem('pokeinventory_v3'),
      pokeinv_dirty_v1: localStorage.getItem('pokeinv_dirty_v1'),
    },
  });
  const reloadState = reloaded.grab('DB', '_dirty');
  assert.strictEqual(reloadState.DB.singles[0].name, 'Edited while uploading');
  assert.strictEqual(reloadState._dirty.singles.has('single_seed_1'), true, 'reload retains the unsynced newer edit');
});

test('flush-guard: another tab mutation token is not cleared by this tab finishing the same id', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  fetchMock.calls.length = 0;
  let releasePost;
  let announcePost;
  const postStarted = new Promise(resolve => { announcePost = resolve; });
  fetchMock.route('/rest/v1/singles', () => {
    announcePost();
    return new Promise(resolve => {
      releasePost = () => resolve({
        ok: true, status: 200,
        json: async () => [{ updated_at: '2026-08-29T12:00:00.000Z' }],
        text: async () => '', headers: { get: () => null },
      });
    });
  });

  const flushing = ctx._flushDirtyToSupabase();
  await postStarted;
  const shared = JSON.parse(localStorage.getItem('pokeinv_dirty_v1'));
  shared._revisions.singles.single_seed_1.push('other-tab:1');
  localStorage.setItem('pokeinv_dirty_v1', JSON.stringify(shared));
  releasePost();
  await flushing;

  const after = JSON.parse(localStorage.getItem('pokeinv_dirty_v1'));
  assert.ok(after.singles.includes('single_seed_1'));
  assert.deepStrictEqual(after._revisions.singles.single_seed_1, ['other-tab:1'],
    'only the uploaded tab token clears, the concurrently persisted token survives');
});

test('flush-guard: a different tab token present before snapshot is never claimed by this upload', async () => {
  const seededDirty = {
    singles: ['single_seed_1'],
    _revisions: { singles: { single_seed_1: ['other-tab:before-snapshot'] } },
  };
  const { ctx, fetchMock, localStorage } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify(seededDirty) },
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/singles', {
    ok: true, status: 200,
    json: [{ updated_at: '2026-08-29T12:00:00.000Z' }],
  });
  await ctx._flushDirtyToSupabase();
  const after = JSON.parse(localStorage.getItem('pokeinv_dirty_v1'));
  assert.ok(after.singles.includes('single_seed_1'));
  assert.deepStrictEqual(after._revisions.singles.single_seed_1, ['other-tab:before-snapshot'],
    'the uploader clears only its own revision, even when the foreign token existed before snapshot');
});

test('flush-guard: a foreign unique marker survives the exact legacy-v1 read/write interleaving and reload discovers it', async () => {
  const { ctx, grab, localStorage } = await loadApp();
  const foreignToken = 'other-tab-v2:interleaved';
  const foreignKey = 'pokeinv_dirty_v2:' + foreignToken;
  const foreignRow = JSON.stringify(grab('DB').DB.singles[0]);
  const realGetItem = localStorage.getItem.bind(localStorage);
  const realSetItem = localStorage.setItem.bind(localStorage);
  let injected = false;
  localStorage.getItem = key => {
    const value = realGetItem(key);
    if (key === 'pokeinv_dirty_v1' && !injected) {
      injected = true;
      realSetItem(foreignKey, JSON.stringify({
        table: 'singles', id: 'single_seed_1', token: foreignToken, owner: 'other-tab-v2', rowJson: foreignRow,
      }));
    }
    return value;
  };

  ctx.markDirty('slabs', 'slab_seed_1');
  assert.ok(localStorage.getItem(foreignKey), 'the unique marker is not overwritten by the later shared-v1 setItem');

  const reloaded = await loadApp({ localStorage: copyStorage(localStorage) });
  assert.strictEqual(reloaded.grab('_dirty')._dirty.singles.has('single_seed_1'), true,
    'reload scans the independent v2 keys even when the compatibility mirror missed the interleaved write');
});

test('flush-guard: matching foreign v2 snapshot clears after upload, while a different snapshot marker survives', async () => {
  const base = { id: 'single_seed_1', name: 'Exact uploaded bytes', status: 'Available' };
  const exactToken = 'other-tab-v2:exact';
  const newerToken = 'other-tab-v2:newer';
  const exactKey = 'pokeinv_dirty_v2:' + exactToken;
  const newerKey = 'pokeinv_dirty_v2:' + newerToken;
  const { ctx, fetchMock, localStorage } = await loadApp({ seed: { singles: [base] } });
  ctx.markDirty('singles', base.id, base);
  // Inject both foreign markers after init. Init-time recovery deliberately
  // resolves conflicting orphan snapshots, while this test isolates the flush
  // rule: only exact bytes can be claimed by an already-running tab.
  localStorage.setItem(exactKey, JSON.stringify({
    table: 'singles', id: base.id, token: exactToken, owner: 'other-tab-v2', rowJson: JSON.stringify(base), createdAt: 1,
  }));
  localStorage.setItem(newerKey, JSON.stringify({
    table: 'singles', id: base.id, token: newerToken, owner: 'other-tab-v2',
    rowJson: JSON.stringify({ ...base, name: 'Different newer bytes' }), createdAt: 2,
  }));
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/singles', {
    ok: true, status: 200, json: [{ updated_at: '2026-08-29T12:00:00.000Z' }],
  });

  await ctx._flushDirtyToSupabase();
  assert.strictEqual(localStorage.getItem(exactKey), null,
    'an exact row snapshot proves the foreign marker was included in this upload');
  assert.ok(localStorage.getItem(newerKey), 'different bytes are never cleared speculatively');

  const reloaded = await loadApp({ localStorage: copyStorage(localStorage) });
  assert.strictEqual(reloaded.grab('_dirty')._dirty.singles.has(base.id), true,
    'the surviving newer marker remains discoverable across sessions');
});

test('flush-guard: orphan v2 snapshot overrides stale cache bytes and uploads the recovered money edit', async () => {
  const stale = { id: 'single_replay_1', name: 'Old cache bytes', costPrice: 10, status: 'Available', _updatedAt: '2026-08-29T10:00:00.000Z' };
  const recovered = { ...stale, name: 'Unsynced money edit', costPrice: 999 };
  const token = 'closed-tab:money-edit';
  const key = 'pokeinv_dirty_v2:' + token;
  const { ctx, fetchMock, grab } = await loadApp({
    seed: { singles: [stale] },
    localStorage: {
      [key]: JSON.stringify({ table: 'singles', id: stale.id, token, owner: 'closed-tab', createdAt: 10, rowJson: JSON.stringify(recovered) }),
    },
  });

  assert.strictEqual(grab('DB').DB.singles[0].costPrice, 999, 'the journal snapshot replaces stale shared-cache bytes on reload');
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/singles', { ok: true, status: 200, json: [{ updated_at: '2026-08-29T12:00:00.000Z' }] });
  await ctx._flushDirtyToSupabase();
  const posted = JSON.parse(fetchMock.calls.find(call => call.opts && call.opts.method === 'POST').opts.body);
  assert.strictEqual(posted[0].data.name, 'Unsynced money edit');
  assert.strictEqual(posted[0].data.costPrice, 999, 'the exact durable journal bytes reach the cloud');
});

test('flush-guard: orphan v2 snapshot restores a row when the shared cache is missing', async () => {
  const row = { id: 'single_replay_missing', name: 'Only durable copy', costPrice: 321, status: 'Available' };
  const token = 'closed-tab:missing-cache';
  const { grab, localStorage } = await loadApp({
    seed: null,
    localStorage: {
      ['pokeinv_dirty_v2:' + token]: JSON.stringify({
        table: 'singles', id: row.id, token, owner: 'closed-tab', createdAt: 20, rowJson: JSON.stringify(row),
      }),
    },
  });

  assert.strictEqual(grab('DB').DB.singles.find(candidate => candidate.id === row.id).costPrice, 321);
  const cached = JSON.parse(localStorage.getItem('pokeinventory_v3'));
  assert.strictEqual(cached.singles.find(candidate => candidate.id === row.id).name, 'Only durable copy',
    'recovery immediately rebuilds a reload-safe shared cache row');
});

test('flush-guard: conflicting orphan snapshots choose createdAt then token, log losers, and cannot resurrect later', async () => {
  const base = { id: 'single_replay_conflict', name: 'Stale cache', costPrice: 1, status: 'Available' };
  const older = { ...base, name: 'Older edit', costPrice: 100 };
  const tieLow = { ...base, name: 'Tie low token', costPrice: 200 };
  const winner = { ...base, name: 'Tie high token', costPrice: 300 };
  const keys = {
    older: 'pokeinv_dirty_v2:foreign:z-old',
    low: 'pokeinv_dirty_v2:foreign:a-tie',
    winner: 'pokeinv_dirty_v2:foreign:z-tie',
  };
  const { grab, localStorage } = await loadApp({
    seed: { singles: [base] },
    localStorage: {
      [keys.older]: JSON.stringify({ table: 'singles', id: base.id, token: 'foreign:z-old', owner: 'foreign', createdAt: 9, rowJson: JSON.stringify(older) }),
      [keys.low]: JSON.stringify({ table: 'singles', id: base.id, token: 'foreign:a-tie', owner: 'foreign', createdAt: 10, rowJson: JSON.stringify(tieLow) }),
      [keys.winner]: JSON.stringify({ table: 'singles', id: base.id, token: 'foreign:z-tie', owner: 'foreign', createdAt: 10, rowJson: JSON.stringify(winner) }),
    },
  });

  assert.strictEqual(grab('DB').DB.singles[0].name, 'Tie high token');
  assert.strictEqual(localStorage.getItem(keys.older), null);
  assert.strictEqual(localStorage.getItem(keys.low), null);
  assert.ok(localStorage.getItem(keys.winner), 'the winning snapshot remains durable until upload');
  const log = JSON.parse(localStorage.getItem('pokeinv_changelog'));
  assert.ok(log.some(entry => entry.extra.includes(JSON.stringify(older))));
  assert.ok(log.some(entry => entry.extra.includes(JSON.stringify(tieLow))), 'every discarded conflicting snapshot is recoverable from Changelog');

  const reloaded = await loadApp({ localStorage: copyStorage(localStorage) });
  assert.strictEqual(reloaded.grab('DB').DB.singles[0].name, 'Tie high token');
  assert.strictEqual(reloaded.localStorage.getItem(keys.older), null, 'a removed loser cannot reappear on a later reload');
  assert.strictEqual(reloaded.localStorage.getItem(keys.low), null);
});

test('flush-guard: identical orphan snapshots share one upload and all matching markers clear together', async () => {
  const row = { id: 'single_replay_identical', name: 'Same edit', costPrice: 88, status: 'Available' };
  const keyA = 'pokeinv_dirty_v2:foreign:identical-a';
  const keyB = 'pokeinv_dirty_v2:foreign:identical-b';
  const marker = token => JSON.stringify({ table: 'singles', id: row.id, token, owner: 'foreign', createdAt: 10, rowJson: JSON.stringify(row) });
  const { ctx, fetchMock, localStorage } = await loadApp({
    seed: { singles: [{ ...row, name: 'Stale cache' }] },
    localStorage: {
      [keyA]: marker('foreign:identical-a'),
      [keyB]: marker('foreign:identical-b'),
    },
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/singles', { ok: true, status: 200, json: [{ updated_at: '2026-08-29T12:00:00.000Z' }] });
  await ctx._flushDirtyToSupabase();
  const posts = fetchMock.calls.filter(call => call.url.includes('/rest/v1/singles') && call.opts && call.opts.method === 'POST');
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(localStorage.getItem(keyA), null);
  assert.strictEqual(localStorage.getItem(keyB), null, 'every token proven to describe the uploaded bytes clears');
});

test('flush-guard: a strictly newer cloud row beats a recovered snapshot and logs its full discarded bytes', async () => {
  const recovered = { id: 'single_replay_cloud', name: 'Recovered local edit', costPrice: 444, status: 'Available', _updatedAt: '2026-08-29T10:00:00.000Z' };
  const cloud = { ...recovered, name: 'Strictly newer cloud edit', costPrice: 555 };
  const token = 'closed-tab:newer-cloud';
  const markerKey = 'pokeinv_dirty_v2:' + token;
  const response = json => ({
    ok: true, status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
    headers: { get: () => null },
  });
  const loaded = await loadApp({
    seed: { singles: [{ ...recovered, name: 'Stale cache before recovery' }] },
    localStorage: {
      [markerKey]: JSON.stringify({ table: 'singles', id: recovered.id, token, owner: 'closed-tab', createdAt: 30, rowJson: JSON.stringify(recovered) }),
    },
    fetch: async url => {
      if (String(url).includes('/rest/v1/singles')) {
        return response([{ id: cloud.id, data: cloud, updated_at: '2026-08-29T12:00:00.000Z' }]);
      }
      if (String(url).includes('/rest/v1/')) return response([]);
      return response({ rates: { SGD: 1.3 } });
    },
  });

  assert.strictEqual(loaded.grab('DB').DB.singles[0].name, 'Strictly newer cloud edit');
  assert.strictEqual(loaded.localStorage.getItem(markerKey), null, 'the resolved local snapshot no longer remains queued');
  const log = JSON.parse(loaded.localStorage.getItem('pokeinv_changelog'));
  assert.ok(log.some(entry => entry.action === 'conflict' && entry.extra.includes(JSON.stringify(recovered))),
    'the entire discarded recovered snapshot remains in Changelog');
});

test('flush-guard: timestamp write-back preserves a newer same-id cache row saved by another tab', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/singles', () => ({
    ok: true, status: 200,
    json: async () => {
      const cache = JSON.parse(localStorage.getItem('pokeinventory_v3'));
      cache.singles[0].name = 'Newer bytes from another tab';
      cache.singles[0]._updatedAt = '2026-08-29T12:00:01.000Z';
      localStorage.setItem('pokeinventory_v3', JSON.stringify(cache));
      return [{ updated_at: '2026-08-29T12:00:00.000Z' }];
    },
    text: async () => '', headers: { get: () => null },
  }));

  await ctx._flushDirtyToSupabase();
  const cached = JSON.parse(localStorage.getItem('pokeinventory_v3')).singles[0];
  assert.strictEqual(cached.name, 'Newer bytes from another tab');
  assert.strictEqual(cached._updatedAt, '2026-08-29T12:00:01.000Z',
    'timestamp-only persistence must not replace a cache row that no longer matches the uploaded snapshot');
});

test('flush-guard: saveAll timestamp write-back also preserves a newer same-id cache row', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/singles', () => ({
    ok: true, status: 200,
    json: async () => {
      const cache = JSON.parse(localStorage.getItem('pokeinventory_v3'));
      cache.singles[0].name = 'Concurrent save during saveAll';
      cache.singles[0]._updatedAt = '2026-08-29T12:00:02.000Z';
      localStorage.setItem('pokeinventory_v3', JSON.stringify(cache));
      return [{ updated_at: '2026-08-29T12:00:00.000Z' }];
    },
    text: async () => '', headers: { get: () => null },
  }));

  await ctx.saveAllToSupabase();
  const cached = JSON.parse(localStorage.getItem('pokeinventory_v3')).singles[0];
  assert.strictEqual(cached.name, 'Concurrent save during saveAll');
  assert.strictEqual(cached._updatedAt, '2026-08-29T12:00:02.000Z');
});

test('flush-guard: a delete is not attempted or removed from dirty state when its retry marker cannot persist', async () => {
  const { ctx, fetchMock, localStorage, grab } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  fetchMock.calls.length = 0;
  const realSetItem = localStorage.setItem.bind(localStorage);
  localStorage.setItem = (key, value) => {
    if (key === '_kjrDeleteStateV2') throw new Error('storage full');
    return realSetItem(key, value);
  };

  const result = await ctx.sbDelete('singles', 'single_seed_1');
  assert.strictEqual(result, false);
  assert.strictEqual(fetchMock.calls.some(call => call.opts && call.opts.method === 'DELETE'), false,
    'cloud deletion is fail-closed when no durable retry can be recorded');
  assert.strictEqual(grab('_dirty')._dirty.singles.has('single_seed_1'), true,
    'the last persisted recovery path is not discarded');
});

test('flush-guard: deleting a row clears only this tab dirty token and preserves a foreign token', async () => {
  const seededDirty = {
    singles: ['single_seed_1'],
    _revisions: { singles: { single_seed_1: ['other-tab:delete-race'] } },
  };
  const { ctx, fetchMock, localStorage } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify(seededDirty) },
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/singles', { ok: true, status: 204, json: {} });

  assert.strictEqual(await ctx.sbDelete('singles', 'single_seed_1'), true);
  const after = JSON.parse(localStorage.getItem('pokeinv_dirty_v1'));
  assert.ok(after.singles.includes('single_seed_1'));
  assert.deepStrictEqual(after._revisions.singles.single_seed_1, ['other-tab:delete-race'],
    'another tab remains responsible for its own unsynchronised mutation');
});

test('flush-guard: a delete invoked during an older in-flight upsert runs last, so the cloud row stays deleted', async () => {
  const { ctx, fetchMock, grab, settle } = await loadApp({
    localStorage: { pokeinv_dirty_v1: JSON.stringify({ singles: ['single_seed_1'] }) },
  });
  fetchMock.calls.length = 0;
  const events = [];
  let cloudHasRow = false;
  let releasePost;
  let announcePost;
  const postStarted = new Promise(resolve => { announcePost = resolve; });
  fetchMock.route('/rest/v1/singles', (url, opts) => {
    if (opts.method === 'POST') {
      events.push('post-start');
      announcePost();
      return new Promise(resolve => {
        releasePost = () => {
          cloudHasRow = true;
          events.push('post-finish');
          resolve({ ok: true, status: 200, json: async () => [{ updated_at: '2026-08-29T12:00:00.000Z' }], text: async () => '', headers: { get: () => null } });
        };
      });
    }
    if (opts.method === 'DELETE') {
      events.push('delete');
      cloudHasRow = false;
      return { ok: true, status: 204, json: async () => ({}), text: async () => '', headers: { get: () => null } };
    }
    throw new Error('unexpected method ' + opts.method);
  });

  const flushing = ctx._flushDirtyToSupabase();
  await postStarted;
  const { DB } = grab('DB');
  DB.singles = [];
  const deleting = ctx.sbDelete('singles', 'single_seed_1');
  await settle(3);
  assert.deepStrictEqual(events, ['post-start'], 'delete waits behind the older upload for the same row');
  releasePost();
  await Promise.all([flushing, deleting]);
  assert.deepStrictEqual(events, ['post-start', 'post-finish', 'delete']);
  assert.strictEqual(cloudHasRow, false, 'the final server operation is the delete, so the row cannot resurrect');
});

test('flush-guard: saveAll skips a later-table snapshot deleted while an earlier table is uploading', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    seed: {
      singles: [{ id: 'single_seed_1', name: 'A', status: 'Available' }],
      slabs: [{ id: 'slab_1', name: 'B', status: 'Available' }],
    },
  });
  fetchMock.calls.length = 0;
  let releaseSingles;
  let announceSingles;
  const singlesStarted = new Promise(resolve => { announceSingles = resolve; });
  fetchMock.route('/rest/v1/', (url, opts) => {
    if (opts.method === 'POST' && url.includes('/singles')) {
      announceSingles();
      return new Promise(resolve => {
        releaseSingles = () => resolve({ ok: true, status: 200, json: async () => [{ updated_at: '2026-08-29T12:00:00.000Z' }], text: async () => '', headers: { get: () => null } });
      });
    }
    return { ok: true, status: opts.method === 'DELETE' ? 204 : 200, json: async () => [{ updated_at: '2026-08-29T12:00:00.000Z' }], text: async () => '', headers: { get: () => null } };
  });

  const savingAll = ctx.saveAllToSupabase();
  await singlesStarted;
  const { DB } = grab('DB');
  DB.slabs = [];
  const deleting = ctx.sbDelete('slabs', 'slab_1');
  await deleting;
  releaseSingles();
  await savingAll;
  const slabPosts = fetchMock.calls.filter(c => c.opts && c.opts.method === 'POST' && c.url.includes('/rest/v1/slabs'));
  assert.strictEqual(slabPosts.length, 0, 'saveAll never uploads the stale slab snapshot after its delete');
  assert.ok(fetchMock.calls.some(c => c.opts && c.opts.method === 'DELETE' && c.url.includes('/rest/v1/slabs')));
});

test('flush-guard: corrupt authoritative delete state blocks saveAll while rows and dirty recovery stay intact', async () => {
  const row = { id: 'stale_under_corrupt_v2', name: 'Visible local money row', costPrice: 999, status: 'Available' };
  const { ctx, fetchMock, localStorage, grab } = await loadApp({
    seed: { singles: [row] },
    localStorage: { _kjrDeleteStateV2: '{broken-json' },
  });
  ctx.markDirty('singles', row.id, grab('DB').DB.singles[0]);
  const beforeV1 = localStorage.getItem('pokeinv_dirty_v1');
  const beforeV2 = dirtyV2Snapshot(localStorage);
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: true, status: 200, json: [{ updated_at: '2026-08-30T00:00:00.000Z' }] });

  assert.strictEqual(await ctx.saveAllToSupabase(), false);
  assert.strictEqual(fetchMock.calls.some(call => call.opts && (call.opts.method === 'POST' || call.opts.method === 'DELETE')), false);
  assert.ok(grab('DB').DB.singles.some(candidate => candidate.id === row.id), 'corruption never turns into an empty UI');
  assert.strictEqual(grab('_dirty')._dirty.singles.has(row.id), true);
  assert.strictEqual(localStorage.getItem('pokeinv_dirty_v1'), beforeV1);
  assert.deepStrictEqual(dirtyV2Snapshot(localStorage), beforeV2);
});

test('flush-guard: corrupt authoritative delete state blocks dirty flush without clearing either dirty format', async () => {
  const row = { id: 'dirty_under_corrupt_v2', name: 'Queued local edit', costPrice: 777, status: 'Available' };
  const { ctx, fetchMock, localStorage, grab } = await loadApp({
    seed: { singles: [row] },
    localStorage: {
      _kjrDeleteStateV2: '{broken-json',
      pokeinv_dirty_v1: JSON.stringify({ singles: [row.id] }),
    },
  });
  const beforeV1 = localStorage.getItem('pokeinv_dirty_v1');
  const beforeV2 = dirtyV2Snapshot(localStorage);
  assert.ok(Object.keys(beforeV2).length > 0, 'load upgrades the legacy dirty id with exact cached row bytes');
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: true, status: 200, json: [{ updated_at: '2026-08-30T00:00:00.000Z' }] });

  await ctx._flushDirtyToSupabase();
  assert.strictEqual(fetchMock.calls.some(call => call.opts && (call.opts.method === 'POST' || call.opts.method === 'DELETE')), false);
  assert.strictEqual(grab('_dirty')._dirty.singles.has(row.id), true);
  assert.ok(grab('DB').DB.singles.some(candidate => candidate.id === row.id));
  assert.strictEqual(localStorage.getItem('pokeinv_dirty_v1'), beforeV1);
  assert.deepStrictEqual(dirtyV2Snapshot(localStorage), beforeV2);
});

test('flush-guard: corrupt authoritative delete state blocks init empty-cloud upload and retains its orphan snapshot', async () => {
  const row = { id: 'init_empty_corrupt_v2', name: 'Offline cache wins locally', costPrice: 555, status: 'Available' };
  const calls = [];
  const response = json => ({
    ok: true, status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
    headers: { get: () => null },
  });
  const loaded = await loadApp({
    seed: { singles: [row] },
    localStorage: {
      _kjrDeleteStateV2: '{broken-json',
      pokeinv_dirty_v1: JSON.stringify({ singles: [row.id] }),
    },
    fetch: async (url, opts = {}) => {
      calls.push({ url: String(url), opts });
      if (String(url).includes('/rest/v1/')) return response([]);
      return response({ rates: { SGD: 1.3 } });
    },
  });
  assert.strictEqual(calls.some(call => call.opts && (call.opts.method === 'POST' || call.opts.method === 'DELETE')), false);
  assert.ok(loaded.grab('DB').DB.singles.some(candidate => candidate.id === row.id));
  assert.strictEqual(loaded.grab('_dirty')._dirty.singles.has(row.id), true);
  assert.ok(Object.keys(dirtyV2Snapshot(loaded.localStorage)).length > 0);
});

test('flush-guard: direct upsert and append import cannot bypass a corrupt delete-state freeze', async () => {
  const { ctx, fetchMock, localStorage, grab, settle } = await loadApp({
    localStorage: { _kjrDeleteStateV2: '{broken-json' },
  });
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: true, status: 200, json: [{ updated_at: '2026-08-30T00:00:00.000Z' }] });
  await assert.rejects(
    ctx.sbUpsert('singles', 'single_seed_1', { name: 'Must not upload' }),
    /delete recovery state needs repair/
  );
  ctx.kjrConfirm = async () => true;
  ctx.document.getElementById('import-data').value = 'Name\tCost\nQueued import\t42';
  ctx.document.getElementById('import-type').value = 'singles';
  ctx.document.getElementById('import-mode').value = 'append';
  await ctx.importData();
  await settle();

  assert.strictEqual(fetchMock.calls.some(call => call.opts && (call.opts.method === 'POST' || call.opts.method === 'DELETE')), false);
  const imported = grab('DB').DB.singles.find(candidate => candidate.name === 'Queued import');
  assert.ok(imported, 'append import remains available locally');
  assert.strictEqual(grab('_dirty')._dirty.singles.has(imported.id), true);
  assert.ok(Object.keys(dirtyV2Snapshot(localStorage)).length > 0);
});

test('flush-guard: valid v2 state leaves normal saveAll uploads unchanged', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  assert.strictEqual(JSON.parse(localStorage.getItem('_kjrDeleteStateV2')).schema, 2);
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/', { ok: true, status: 200, json: [{ updated_at: '2026-08-30T00:00:00.000Z' }] });
  await ctx.saveAllToSupabase();
  assert.ok(fetchMock.calls.some(call => call.opts && call.opts.method === 'POST' && call.url.includes('/rest/v1/singles')));
});
