'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, makeSeed, plain, jsonResponse, syncSuccessResponse, syncRequest, syncOperations } = require('./harness');
const keys = storage => Array.from(storage._store.keys()).filter(key => key.startsWith('pokeinv_version_upload:'));
const state = singles => makeSeed({ singles });
const version = (id, singles) => ({ id, name: id, ts: 123, data: JSON.stringify(state(singles)) });
function messages(ctx) { const list = []; ctx.toast = text => list.push(text); ctx.toastError = text => list.push(text); return list; }
async function restoreApp(current, older, options = {}) {
  const ver = version('saved-state', older);
  const app = await loadApp({ seed: state(current), localStorage: { pokeinv_versions: JSON.stringify([ver]) }, ...options });
  app.ctx.kjrConfirm = async () => true;
  return { ...app, ver };
}
function routeSuccess(app) { app.fetchMock.route('/sync/v2/mutate', (_url, options) => syncSuccessResponse(options)); }

test('versions: all three offline backups survive eviction and reload with exact snapshots', async () => {
  const app = await loadApp();
  const saved = [];
  for (let i = 0; i < 3; i++) { app.ctx.DB.singles[0].notes = 'offline-' + i; saved.push(await app.ctx._saveVersionWithName('offline-' + i)); }
  assert.equal(keys(app.localStorage).length, 3);
  app.ctx._evictVersionBlobsFromLS();
  const reload = await loadApp({ seed: null, storage: app.localStorage });
  for (const ver of saved) {
    const recovered = reload.ctx.loadVersions().find(item => item.id === ver.id);
    assert.equal(recovered.data, ver.data);
    assert.equal(recovered._pendingUpload, true);
  }
});

test('versions: a lost acknowledgement retries exact receipt and payload after reload', async () => {
  const app = await loadApp();
  let original;
  app.fetchMock.route('/sync/v2/mutate', (_url, options) => { original = syncRequest(options); throw new Error('lost response'); });
  const saved = await app.ctx._saveVersionWithName('lost response');
  const reload = await loadApp({ seed: null, storage: app.localStorage });
  reload.ctx.DB.singles[0].notes = 'later edit';
  reload.fetchMock.route('/sync/v2/mutate', (_url, options) => { assert.deepEqual(syncRequest(options), original); return syncSuccessResponse(options); });
  assert.equal(await reload.ctx._flushPendingVersionUploads(), true);
  assert.equal(keys(app.localStorage).length, 0);
  const ack = reload.ctx.loadVersions().find(item => item.id === saved.id);
  assert.equal(ack.data, saved.data); assert.equal(ack._serverVersion, 1); assert.equal(ack._pendingUpload, undefined);
});

test('versions: acknowledgement cache failure keeps the durable original receipt', async () => {
  const app = await loadApp();
  const saved = await app.ctx._saveVersionWithName('ack quota');
  const key = keys(app.localStorage)[0], original = app.localStorage.getItem(key);
  const realSet = app.localStorage.setItem.bind(app.localStorage);
  app.localStorage.setItem = (key, value) => { if (key === 'pokeinv_versions') throw new Error('quota'); realSet(key, value); };
  routeSuccess(app);
  assert.equal(await app.ctx.sbSaveVersion(saved), true);
  assert.equal(app.localStorage.getItem(key), original);
});

test('versions: failed durable save keeps the form and leaves daily snapshot eligible for retry', async () => {
  const app = await loadApp();
  const log = messages(app.ctx), realSet = app.localStorage.setItem.bind(app.localStorage);
  app.localStorage.setItem = (key, value) => { if (key.startsWith('pokeinv_version_upload:')) throw new Error('quota'); realSet(key, value); };
  app.document.getElementById('ver-name-input').value = 'important';
  await app.ctx.saveVersion(); await app.ctx.maybeRunDailyAutoVersion();
  assert.equal(app.document.getElementById('ver-name-input').value, 'important');
  assert.ok(log.some(text => /not saved/.test(text)));
  assert.equal(app.localStorage.getItem('pokeinv_last_auto_version_date'), null);
  assert.equal(syncOperations(app.fetchMock).length, 0);
});

test('versions: daily pending save is durable and retried before deduplication', async () => {
  const app = await loadApp();
  await app.ctx.maybeRunDailyAutoVersion();
  assert.equal(keys(app.localStorage).length, 1);
  assert.ok(app.localStorage.getItem('pokeinv_last_auto_version_date'));
  routeSuccess(app); await app.ctx.maybeRunDailyAutoVersion();
  assert.equal(keys(app.localStorage).length, 0); assert.equal(app.ctx.loadVersions().length, 1);
});

test('versions: cloud refresh and another tab cannot hide pending snapshots', async () => {
  const a = await loadApp(), va = await a.ctx._saveVersionWithName('A');
  const b = await loadApp({ seed: null, storage: a.localStorage }), vb = await b.ctx._saveVersionWithName('B');
  a.fetchMock.route('/rest/v1/versions?', () => jsonResponse([]));
  await a.ctx.renderVerList();
  assert.deepEqual(new Set(plain(a.ctx.loadVersions()).map(row => row.id)), new Set([va.id, vb.id]));
  assert.equal(keys(a.localStorage).length, 2);
});

test('versions: legacy unverified blobs including revision zero are never evicted', async () => {
  const records = [0, 1, 2].map(n => ({ ...version('legacy-' + n, []), ...(n === 0 ? { _serverVersion: 0 } : {}) }));
  const app = await loadApp({ localStorage: { pokeinv_versions: JSON.stringify(records) } });
  app.ctx.kjrCompactVersionCache(); app.ctx._evictVersionBlobsFromLS();
  assert.deepEqual(JSON.parse(app.localStorage.getItem('pokeinv_versions')), records);
});

test('versions: only acknowledged snapshot blobs are eligible for cache eviction', async () => {
  const app = await loadApp();
  assert.equal(app.ctx._cacheVersions([0, 1, 2].map(n => ({ ...version('ack-' + n, []), _serverVersion: 1 }))), true);
  assert.equal(JSON.parse(app.localStorage.getItem('pokeinv_versions')).filter(row => row.data).length, 2);
  app.ctx._evictVersionBlobsFromLS();
  assert.equal(JSON.parse(app.localStorage.getItem('pokeinv_versions')).filter(row => row.data).length, 0);
});

test('versions: restoration uses current CAS revision and survives acknowledgement plus reload', async () => {
  const current = { id: 'current', name: 'current', costPrice: 50, _serverVersion: 2 };
  const app = await restoreApp([current], [{ ...current, costPrice: 20, _serverVersion: 1 }]);
  app.fetchMock.route('/sync/v2/mutate', (_url, options) => {
    for (const op of syncRequest(options).operations.filter(op => op.table === 'singles')) {
      assert.equal(op.expected_version, 2); assert.equal(op.data.costPrice, 20);
    }
    return syncSuccessResponse(options);
  });
  await app.ctx.restoreVersion(app.ver.id);
  assert.equal(app.ctx.DB.singles[0].costPrice, 20); assert.equal(app.ctx.DB.singles[0]._serverVersion, 2);
  await app.ctx._flushDirtyToSupabase();
  const reload = await loadApp({ seed: null, storage: app.localStorage });
  assert.equal(reload.ctx.DB.singles[0].costPrice, 20); assert.equal(reload.ctx.DB.singles[0]._serverVersion, 3);
});

test('versions: unavailable backup storage stops restore before any inventory or delete changes', async () => {
  const app = await restoreApp([{ id: 'keep', name: 'keep', _serverVersion: 2 }], []);
  const before = JSON.stringify(app.ctx.DB), realSet = app.localStorage.setItem.bind(app.localStorage);
  app.localStorage.setItem = (key, value) => { if (key.startsWith('pokeinv_version_upload:')) throw new Error('quota'); realSet(key, value); };
  await app.ctx.restoreVersion(app.ver.id);
  assert.equal(JSON.stringify(app.ctx.DB), before); assert.equal(app.ctx._readDeleteState().state.pending.length, 0);
});

test('versions: missing synced rows and unavailable current revisions need explicit recovery', async () => {
  for (const current of [[], [{ id: 'missing', name: 'current' }]]) {
    const app = await restoreApp(current, [{ id: 'missing', name: 'old', _serverVersion: 3 }]);
    const before = JSON.stringify(app.ctx.DB), log = messages(app.ctx);
    await app.ctx.restoreVersion(app.ver.id);
    assert.equal(JSON.stringify(app.ctx.DB), before); assert.equal(syncOperations(app.fetchMock).length, 0);
    assert.ok(log.some(text => /Trash|current cloud state/.test(text)));
  }
});

test('versions: pending sale transactions block replacement before backup or preflight', async () => {
  const row = { id: 'sale-row', status: 'Sold', _serverVersion: 2 };
  const app = await restoreApp([row], [{ ...row, status: 'Available', _serverVersion: 1 }]);
  assert.ok(app.ctx._queueMutationGroup([app.ctx._upsertOperation('singles', row)]));
  const before = JSON.stringify(app.ctx.DB), log = messages(app.ctx);
  await app.ctx.restoreVersion(app.ver.id);
  assert.equal(JSON.stringify(app.ctx.DB), before); assert.equal(keys(app.localStorage).length, 0);
  assert.ok(log.some(text => /pending sync transaction/.test(text)));
});

test('versions: peer cache changes during backup cannot be overwritten before their storage event', async () => {
  const row = { id: 'current', name: 'current', costPrice: 50, _serverVersion: 2 }, peer = { id: 'peer', name: 'peer', _serverVersion: 1 };
  const app = await restoreApp([row], [{ ...row, costPrice: 20, _serverVersion: 1 }]);
  app.fetchMock.route('/sync/v2/mutate', (_url, options) => { app.localStorage.setItem('pokeinventory_v3', JSON.stringify(state([row, peer]))); return syncSuccessResponse(options); });
  await app.ctx.restoreVersion(app.ver.id);
  assert.equal(app.ctx.DB.singles[0].costPrice, 50);
  assert.ok(JSON.parse(app.localStorage.getItem('pokeinventory_v3')).singles.some(item => item.id === peer.id));
  assert.equal(app.ctx._readDeleteState().state.pending.length, 0);
});

test('versions: apply occurs before a peer event delivered after the safety callback resolves', async () => {
  const row = { id: 'current', name: 'current', costPrice: 50, _serverVersion: 2 }, peer = { id: 'peer-after', name: 'peer', _serverVersion: 1 };
  let app, armed = false, injected = false;
  const locks = { async request(name, _options, callback) {
    const result = await callback();
    if (armed && !injected && name.includes('delete-state')) {
      injected = true;
      const raw = JSON.stringify(state([...plain(app.ctx.DB.singles), peer]));
      app.localStorage.setItem('pokeinventory_v3', raw);
      app.ctx.dispatchEvent({ type: 'storage', key: 'pokeinventory_v3', newValue: raw, oldValue: null, storageArea: null });
    }
    return result;
  } };
  app = await restoreApp([row], [{ ...row, costPrice: 20, _serverVersion: 1 }], { locks });
  armed = true;
  await app.ctx.restoreVersion(app.ver.id);
  assert.equal(injected, true);
  assert.equal(app.ctx.DB.singles.find(item => item.id === row.id).costPrice, 20);
  assert.ok(app.ctx.DB.singles.some(item => item.id === peer.id));
  assert.ok(JSON.parse(app.localStorage.getItem('pokeinventory_v3')).singles.some(item => item.id === peer.id));
});

test('versions: failed inventory cache persistence rolls back restore and its delete recovery state', async () => {
  const row = { id: 'keep-on-quota', name: 'keep', costPrice: 50, _serverVersion: 2 };
  const app = await restoreApp([row], []), before = JSON.stringify(app.ctx.DB);
  const realSet = app.localStorage.setItem.bind(app.localStorage);
  app.localStorage.setItem = (key, value) => { if (key === 'pokeinventory_v3') throw new Error('quota'); realSet(key, value); };
  await app.ctx.restoreVersion(app.ver.id);
  assert.equal(JSON.stringify(app.ctx.DB), before);
  assert.equal(app.ctx._readDeleteState().state.pending.length, 0);
  assert.equal(syncOperations(app.fetchMock).filter(op => op.type === 'delete').length, 0);
});

test('versions: duplicate-id snapshots fail validation before changing data', async () => {
  const duplicate = { id: 'same', name: 'same' }, app = await restoreApp([], [duplicate, duplicate]);
  const before = JSON.stringify(app.ctx.DB), log = messages(app.ctx);
  await app.ctx.restoreVersion(app.ver.id);
  assert.equal(JSON.stringify(app.ctx.DB), before); assert.ok(log.some(text => /unreadable/.test(text)));
});

test('versions: reconnect drains uploads without opening version history', async () => {
  const app = await loadApp(); await app.ctx._saveVersionWithName('reconnect'); routeSuccess(app);
  app.ctx.dispatchEvent({ type: 'online' }); await app.settle(); assert.equal(keys(app.localStorage).length, 0);
});

test('versions: a stale two-tab scan cannot recreate an acknowledged second upload', async () => {
  const a = await loadApp(); await a.ctx._saveVersionWithName('first'); await a.ctx._saveVersionWithName('second');
  const b = await loadApp({ seed: null, storage: a.localStorage });
  const receipts = new Map(), existing = new Set();
  function server(options) {
    const request = syncRequest(options);
    if (receipts.has(request.mutation_id)) return receipts.get(request.mutation_id);
    for (const operation of request.operations) assert.equal(existing.has(operation.id), false, 'never recreate an existing version with a new receipt');
    request.operations.forEach(operation => existing.add(operation.id));
    const response = syncSuccessResponse(options); receipts.set(request.mutation_id, response); return response;
  }
  let release, held, calls = 0;
  b.fetchMock.route('/sync/v2/mutate', (_url, options) => {
    calls++; if (calls === 1) { held = options; return new Promise(resolve => { release = resolve; }); }
    return server(options);
  });
  a.fetchMock.route('/sync/v2/mutate', (_url, options) => server(options));
  const runB = b.ctx._flushPendingVersionUploads(); await b.settle(3);
  assert.equal(await a.ctx._flushPendingVersionUploads(), true);
  release(server(held)); assert.equal(await runB, true);
  assert.equal(calls, 1); assert.equal(keys(a.localStorage).length, 0); assert.equal(existing.size, 2);
});

test('versions: deletion refreshes pending state after confirmation in another tab', async () => {
  const a = await loadApp(), saved = await a.ctx._saveVersionWithName('delete after upload');
  const b = await loadApp({ seed: null, storage: a.localStorage });
  let confirm; b.ctx.kjrConfirm = () => new Promise(resolve => { confirm = resolve; });
  const deleting = b.ctx.deleteVersion(saved.id); await b.settle(3);
  routeSuccess(a); assert.equal(await a.ctx._flushPendingVersionUploads(), true);
  b.fetchMock.route('/sync/v2/mutate', (_url, options) => {
    const operation = syncRequest(options).operations[0];
    assert.equal(operation.type, 'delete'); assert.equal(operation.expected_version, 1);
    return syncSuccessResponse(options);
  });
  confirm(true); await deleting;
  assert.equal(keys(a.localStorage).length, 0); assert.equal(b.ctx.loadVersions().some(item => item.id === saved.id), false);
});

test('versions: acknowledgement cannot clear a replacement outbox entry', async () => {
  const app = await loadApp(), saved = await app.ctx._saveVersionWithName('old receipt');
  const key = keys(app.localStorage)[0], original = JSON.parse(app.localStorage.getItem(key));
  let release;
  app.fetchMock.route('/sync/v2/mutate', (_url, options) => new Promise(resolve => { release = () => resolve(syncSuccessResponse(options)); }));
  const attempt = app.ctx._sendVersionUpload(original, saved); await app.settle(3);
  const replacement = { ...original, mutation_id: '12345678-1234-4234-8234-123456789abc' };
  const raw = JSON.stringify(replacement); app.localStorage.setItem(key, raw);
  release(); assert.equal(await attempt, true); assert.equal(app.localStorage.getItem(key), raw);
});

test('versions: automatic backup covers sealed-only and eBay-only data once per day', async () => {
  for (const key of ['etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases']) {
    const seed = makeSeed({ singles: [], [key]: [{ id: key + '-only', product: 'Only record', status: 'Available' }] });
    const app = await loadApp({ seed });
    // The older inventory hydration path may omit secondary-only data. This
    // test isolates the daily-backup guard; hydration has its own regression.
    app.ctx.DB[key] = seed[key];
    await app.ctx.maybeRunDailyAutoVersion();
    await app.ctx.maybeRunDailyAutoVersion();
    assert.equal(keys(app.localStorage).length, 1, key + ' gets exactly one durable daily backup');
    const saved = app.ctx.loadVersions()[0];
    assert.equal(JSON.parse(saved.data)[key][0].id, key + '-only');
  }
});
