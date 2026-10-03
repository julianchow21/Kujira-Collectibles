'use strict';

// Local-only browser fixture for the Cloud Sync diagnostics pass. It serves
// the real app scripts and styles, keeps the house Google Fonts stylesheet for
// visual parity, removes the production auth/CDN shell from the response, and
// blocks application network, authentication and service-worker access. All
// rows and failure details below are synthetic.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = Number(process.env.KJR_SYNC_PREVIEW_PORT || 3817);
const STORAGE_KEY = 'pokeinventory_v3';
const DIRTY_KEY = 'pokeinv_dirty_v1';
const SCENARIO_KEY = '_kjrSyncPreviewScenario';
const FIXTURE_OWNED_KEYS = [
  STORAGE_KEY, DIRTY_KEY, SCENARIO_KEY, '_kjrDeleteStateV2', '_kjrPendingCloudDeletes',
  '_kjrConfirmedCloudDeletes', '_kjrPendingTrashWrites', '_kjrLocalTrash',
  '_kjrServerTombstonesV1', '_kjrMutationGroupsV2', '_kjrSyncDiagnosticsV1', 'pokeinventory_version',
];

function previewSingle(id, name, index) {
  return {
    id, name, set: 'Synthetic Set', language: 'EN', type: 'raw', condition: 'Near Mint',
    qty: 1, costPrice: 5 + index, marketPrice: 10 + index, listPrice: '',
    datePurchased: '1 Sep 2026', status: 'Available', notes: '', priceAlert: '', tcgdexId: '',
  };
}

const PENDING_SINGLES = Array.from({ length: 125 }, (_, index) =>
  previewSingle(
    'sync-preview-' + String(index + 1).padStart(3, '0'),
    index === 0 ? 'Synthetic card ' + 'L'.repeat(120 - 'Synthetic card '.length) : 'Synthetic card ' + (index + 1),
    index + 1));
const EMPTY_SEED = {
  singles: [], slabs: [], sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [],
};
const PENDING_SEED = {
  ...EMPTY_SEED,
  singles: PENDING_SINGLES,
};
const QUEUE_MANY_SINGLES = Array.from({ length: 125 }, (_, index) =>
  previewSingle('sync-preview-over-100-' + String(index + 1).padStart(3, '0'), 'Synthetic queue item ' + (index + 1), index + 1));
const QUEUE_MANY_SEED = {
  ...EMPTY_SEED,
  singles: QUEUE_MANY_SINGLES,
};
const QUEUE_LONG_SINGLES = Array.from({ length: 4 }, (_, index) =>
  previewSingle(
    'sync-preview-long-' + (index + 1),
    'Synthetic queue label ' + (index + 1) + ' ' + 'Long display name '.repeat(18) + 'end',
    index + 1));
const QUEUE_LONG_SEED = {
  ...EMPTY_SEED,
  singles: QUEUE_LONG_SINGLES,
};
const BACKFILL_SEED = {
  ...EMPTY_SEED,
  singles: [
    { ...previewSingle('sync-preview-backfill-full-source', 'Synthetic full date source', 1), datePurchased: '1 Jan 2026', status: 'Sold' },
    { ...previewSingle('sync-preview-backfill-month-source', 'Synthetic month only source', 2), datePurchased: 'Jan 2026', status: 'Sold' },
    { ...previewSingle('sync-preview-backfill-invalid-source', 'Synthetic invalid date source', 3), datePurchased: '31 Feb 2026', status: 'Sold' },
  ],
  sales: [
    { id: 'sync-preview-backfill-full-sale', product: 'Synthetic full date sale', inventoryId: 'sync-preview-backfill-full-source', inventoryTable: 'singles', dateSold: '5 Jan 2026' },
    { id: 'sync-preview-backfill-month-sale', product: 'Synthetic month only sale', inventoryId: 'sync-preview-backfill-month-source', inventoryTable: 'singles', dateSold: '5 Jan 2026' },
    { id: 'sync-preview-backfill-invalid-sale', product: 'Synthetic invalid date sale', inventoryId: 'sync-preview-backfill-invalid-source', inventoryTable: 'singles', dateSold: '5 Jan 2026' },
  ],
};
const ACK_ID = 'sync-preview-ack-row';
const ACK_TOKEN = 'peer-tab:sync-preview-ack';
const ACK_MARKER_KEY = 'pokeinv_dirty_v2:' + ACK_TOKEN;
const ACK_ROW = previewSingle(ACK_ID, 'Synthetic acknowledged row', 1);
const ACK_SEED = { ...EMPTY_SEED, singles: [ACK_ROW] };
const WARNING_ID = 'sync-preview-snapshotless';
const WARNING_TOKEN = 'peer-tab:sync-preview-snapshotless';
const WARNING_MARKER_KEY = 'pokeinv_dirty_v2:' + WARNING_TOKEN;
const WARNING_SEED = {
  ...EMPTY_SEED,
  singles: [{ ...previewSingle('sync-preview-warning-single', 'Synthetic warning single', 2), status: 'Sold', costPrice: 0, datePurchased: '2026-09-16' }],
  sales: [{ id: 'sync-preview-warning-sale', product: 'Synthetic orphan sale', dateSold: '16 Sep 2026', buyer: 'Preview', inventoryId: 'missing-preview-row', inventoryTable: 'singles' }],
  ebayPurchases: [{ id: 'sync-preview-warning-ebay', product: 'Synthetic eBay purchase', priceUsd: 100, freightSgd: 0, totalSgd: 1, date: '16 Sep 2026' }],
};
const PENDING_DELETE_STATE = {
  schema: 2, revision: 'sync-preview-delete-state',
  pending: [{ table: 'singles', id: 'sync-preview-001', ts: 1 }], confirmed: [],
};
const PENDING_TRASH = [{
  id: 'sync-preview-trash-01',
  data: {
    originalTable: 'singles', originalId: 'sync-preview-002', item: PENDING_SINGLES[1],
    reason: 'synthetic preview', deletedAt: '2026-09-16T00:00:00.000Z',
  },
  updated_at: '2026-09-16T00:00:00.000Z',
}];
const PENDING_MUTATION_ID = '123e4567-e89b-42d3-a456-426614174000';
const PENDING_MUTATION = {
  mutation_id: PENDING_MUTATION_ID,
  created_at: 1726444800000,
  operations: [{
    type: 'upsert', table: 'singles', id: 'sync-preview-queued', expected_version: 0,
    data: { name: 'Synthetic queued card', status: 'Available' },
  }],
  before_states: [{ table: 'singles', id: 'sync-preview-queued', present: false }],
};
const RESTORE_ACK_ID = 'sync-preview-restore-card';
const RESTORE_ACK_TRASH_ID = 'sync-preview-restore-trash';
const RESTORE_ACK_MUTATION_ID = '123e4567-e89b-42d3-a456-426614174001';
const RESTORE_ACK_DELETED_AT = '2026-09-16T00:00:00.000Z';
const RESTORE_ACK_ITEM = {
  ...previewSingle(RESTORE_ACK_ID, 'Synthetic restore acknowledgement card', 3),
  condition: 'Near Mint',
};
const RESTORE_ACK_DATA = Object.fromEntries(Object.entries(RESTORE_ACK_ITEM)
  .filter(([key]) => key !== 'id' && !key.startsWith('_')));
const RESTORE_ACK_ENTRY = {
  id: RESTORE_ACK_TRASH_ID,
  data: {
    originalTable: 'singles', originalId: RESTORE_ACK_ID, item: RESTORE_ACK_ITEM,
    reason: 'synthetic restore acknowledgement', deletedAt: RESTORE_ACK_DELETED_AT,
  },
  updated_at: RESTORE_ACK_DELETED_AT,
  _serverVersion: 4,
};
const RESTORE_ACK_TOMBSTONE = {
  table: 'singles', id: RESTORE_ACK_ID, row_version: 4, deleted_at: RESTORE_ACK_DELETED_AT,
};
const RESTORE_ACK_OPERATION = {
  type: 'restore', table: 'singles', id: RESTORE_ACK_ID, expected_version: 0,
  tombstone_version: RESTORE_ACK_TOMBSTONE.row_version, data: RESTORE_ACK_DATA,
  trash_id: RESTORE_ACK_TRASH_ID,
};
const RESTORE_ACK_GROUP = {
  mutation_id: RESTORE_ACK_MUTATION_ID,
  created_at: 1726444800000,
  operations: [RESTORE_ACK_OPERATION],
  before_states: [{ table: 'singles', id: RESTORE_ACK_ID, present: false }],
  restore_snapshots: [RESTORE_ACK_ENTRY],
};

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const PREVIEW_TOOLS = `
<aside id="kjr-sync-preview-tools" aria-label="Synthetic sync preview controls" style="position:fixed;right:10px;bottom:10px;z-index:10000;display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:calc(100vw - 20px);padding:7px 9px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--bg2);box-shadow:0 4px 20px rgba(0,0,0,.25);font:11px/1.3 system-ui,sans-serif">
  <strong style="color:var(--accent);white-space:nowrap">SYNC PREVIEW</strong>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('empty')">Empty</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('pending')">Pending many</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('queue-many')">Queue 125</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('queue-long')">Long queue names</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('failure')">Long failure</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('offline')">Offline</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('recovered')">Recovered local</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('review')">Retained receipt</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('ack')">Ack demo</button>
  <button id="kjr-sync-preview-restore-ack" type="button" hidden onclick="window.__KJR_SYNC_PREVIEW_RESTORE_ACK()">Acknowledge restore</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('warnings')">Health warnings</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('backfill')">Backfill guards</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_ACK()">Acknowledge</button>
  <button type="button" onclick="openSyncDiagnostics()">Show details</button>
  <button type="button" onclick="document.documentElement.classList.toggle('light')">Toggle theme</button>
</aside>`;

const PREVIEW_BOOTSTRAP = `<script id="kjr-sync-preview-bootstrap">
(function () {
  'use strict';
  var STORAGE_KEY = ${JSON.stringify(STORAGE_KEY)};
  var DIRTY_KEY = ${JSON.stringify(DIRTY_KEY)};
  var SCENARIO_KEY = ${JSON.stringify(SCENARIO_KEY)};
  var EMPTY_SEED = ${jsonForScript(EMPTY_SEED)};
  var PENDING_SEED = ${jsonForScript(PENDING_SEED)};
  var QUEUE_MANY_SEED = ${jsonForScript(QUEUE_MANY_SEED)};
  var QUEUE_LONG_SEED = ${jsonForScript(QUEUE_LONG_SEED)};
  var BACKFILL_SEED = ${jsonForScript(BACKFILL_SEED)};
  var ACK_SEED = ${jsonForScript(ACK_SEED)};
  var ACK_ID = ${JSON.stringify(ACK_ID)};
  var ACK_TOKEN = ${JSON.stringify(ACK_TOKEN)};
  var ACK_MARKER_KEY = ${JSON.stringify(ACK_MARKER_KEY)};
  var ACK_ROW = ${jsonForScript(ACK_ROW)};
  var WARNING_SEED = ${jsonForScript(WARNING_SEED)};
  var WARNING_ID = ${JSON.stringify(WARNING_ID)};
  var WARNING_TOKEN = ${JSON.stringify(WARNING_TOKEN)};
  var WARNING_MARKER_KEY = ${JSON.stringify(WARNING_MARKER_KEY)};
  var PENDING_DELETE_STATE = ${jsonForScript(PENDING_DELETE_STATE)};
  var PENDING_TRASH = ${jsonForScript(PENDING_TRASH)};
  var PENDING_MUTATION = ${jsonForScript(PENDING_MUTATION)};
  var RESTORE_ACK_ID = ${JSON.stringify(RESTORE_ACK_ID)};
  var RESTORE_ACK_TRASH_ID = ${JSON.stringify(RESTORE_ACK_TRASH_ID)};
  var RESTORE_ACK_MUTATION_ID = ${JSON.stringify(RESTORE_ACK_MUTATION_ID)};
  var RESTORE_ACK_ITEM = ${jsonForScript(RESTORE_ACK_ITEM)};
  var RESTORE_ACK_ENTRY = ${jsonForScript(RESTORE_ACK_ENTRY)};
  var RESTORE_ACK_TOMBSTONE = ${jsonForScript(RESTORE_ACK_TOMBSTONE)};
  var RESTORE_ACK_OPERATION = ${jsonForScript(RESTORE_ACK_OPERATION)};
  var RESTORE_ACK_GROUP = ${jsonForScript(RESTORE_ACK_GROUP)};
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  var write = function (key, value) { localStorage.setItem(key, JSON.stringify(clone(value))); };
  var seedRestoreAckFixture = function () {
    write(STORAGE_KEY, EMPTY_SEED);
    write(DIRTY_KEY, { singles: [], _revisions: { singles: {} } });
    write('_kjrLocalTrash', [RESTORE_ACK_ENTRY]);
    write('_kjrServerTombstonesV1', [RESTORE_ACK_TOMBSTONE]);
    write('_kjrPendingTrashWrites', []);
    write('_kjrMutationGroupsV2', []);
  };

  // No owner session, production data or credentials are created by this
  // fixture. The localhost write guard remains active in the real app.
  window.fetch = function () { return Promise.reject(new TypeError('Synthetic preview network disabled')); };
  window.Sentry = undefined;
  window.Chart = class { constructor() {} destroy() {} update() {} resize() {} };
  window.marked = { parse: function (value) { return String(value || ''); } };
  try { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); } catch (_) {}
  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: function () {
        return Promise.resolve({ waiting: null, installing: null, addEventListener: function () {} });
      } });
      Object.defineProperty(navigator.serviceWorker, 'addEventListener', { configurable: true, value: function () {} });
    }
  } catch (_) {}
  document.documentElement.classList.remove('auth-gated');

  var requestedScenario = '';
  try { requestedScenario = new URL(location.href).searchParams.get('scenario') || ''; } catch (_) {}
  var scenario = localStorage.getItem(SCENARIO_KEY) || requestedScenario || 'empty';
  localStorage.removeItem(SCENARIO_KEY);
  var restoreAckButton = document.getElementById('kjr-sync-preview-restore-ack');
  if (restoreAckButton) restoreAckButton.hidden = scenario !== 'restore-ack';
  var initialSeed = scenario === 'pending' || scenario === 'review' ? PENDING_SEED
    : scenario === 'queue-many' ? QUEUE_MANY_SEED
    : scenario === 'queue-long' ? QUEUE_LONG_SEED
    : scenario === 'backfill' ? BACKFILL_SEED
    : scenario === 'ack' ? ACK_SEED : scenario === 'warnings' ? WARNING_SEED : EMPTY_SEED;
  if (!localStorage.getItem(STORAGE_KEY)) write(STORAGE_KEY, initialSeed);
  if (scenario === 'restore-ack') {
    clearFixtureStorage();
    seedRestoreAckFixture();
  } else if (scenario === 'pending' || scenario === 'review' || scenario === 'queue-many' || scenario === 'queue-long') {
    var queuedSeed = scenario === 'queue-many' ? QUEUE_MANY_SEED : scenario === 'queue-long' ? QUEUE_LONG_SEED : PENDING_SEED;
    write(STORAGE_KEY, queuedSeed);
    write(DIRTY_KEY, { singles: queuedSeed.singles.map(function (row) { return row.id; }) });
    if (scenario === 'review') {
      write('_kjrDeleteStateV2', PENDING_DELETE_STATE);
      write('_kjrPendingTrashWrites', PENDING_TRASH);
      write('_kjrMutationGroupV2:' + PENDING_MUTATION.mutation_id, PENDING_MUTATION);
    }
  } else if (scenario === 'ack') {
    write(STORAGE_KEY, ACK_SEED);
    write(DIRTY_KEY, { singles: [ACK_ID], _revisions: { singles: { [ACK_ID]: [ACK_TOKEN] } } });
    write(ACK_MARKER_KEY, { table: 'singles', id: ACK_ID, token: ACK_TOKEN, owner: 'peer-tab', createdAt: 1, rowJson: JSON.stringify(ACK_ROW) });
  } else if (scenario === 'warnings') {
    write(STORAGE_KEY, WARNING_SEED);
    write(DIRTY_KEY, { singles: [WARNING_ID], _revisions: { singles: { [WARNING_ID]: [WARNING_TOKEN] } } });
    write(WARNING_MARKER_KEY, { table: 'singles', id: WARNING_ID, token: WARNING_TOKEN, owner: 'peer-tab', createdAt: 1 });
  } else if (scenario === 'backfill') {
    write(STORAGE_KEY, BACKFILL_SEED);
    write(DIRTY_KEY, { singles: [], sales: [] });
  }

  window.__KJR_SYNC_PREVIEW_SCENARIO = function (next) {
    clearFixtureStorage();
    var nextSeed = next === 'pending' || next === 'review' ? PENDING_SEED
      : next === 'queue-many' ? QUEUE_MANY_SEED
      : next === 'queue-long' ? QUEUE_LONG_SEED
      : next === 'backfill' ? BACKFILL_SEED
      : next === 'ack' ? ACK_SEED : next === 'warnings' ? WARNING_SEED : EMPTY_SEED;
    write(STORAGE_KEY, nextSeed);
    if (next === 'pending' || next === 'review' || next === 'queue-many' || next === 'queue-long') {
      var queuedNextSeed = next === 'queue-many' ? QUEUE_MANY_SEED : next === 'queue-long' ? QUEUE_LONG_SEED : PENDING_SEED;
      var dirtyIds = queuedNextSeed.singles.map(function (row) { return row.id; });
      write(DIRTY_KEY, { singles: dirtyIds });
      if (next === 'pending' || next === 'review') {
        write('_kjrDeleteStateV2', PENDING_DELETE_STATE);
        write('_kjrPendingTrashWrites', PENDING_TRASH);
        write('_kjrMutationGroupV2:' + PENDING_MUTATION.mutation_id, PENDING_MUTATION);
      }
    } else if (next === 'restore-ack') {
      seedRestoreAckFixture();
    } else if (next === 'ack') {
      write(DIRTY_KEY, { singles: [ACK_ID], _revisions: { singles: { [ACK_ID]: [ACK_TOKEN] } } });
      write(ACK_MARKER_KEY, { table: 'singles', id: ACK_ID, token: ACK_TOKEN, owner: 'peer-tab', createdAt: 1, rowJson: JSON.stringify(ACK_ROW) });
    } else if (next === 'warnings') {
      write(DIRTY_KEY, { singles: [WARNING_ID], _revisions: { singles: { [WARNING_ID]: [WARNING_TOKEN] } } });
      write(WARNING_MARKER_KEY, { table: 'singles', id: WARNING_ID, token: WARNING_TOKEN, owner: 'peer-tab', createdAt: 1 });
    } else if (next === 'backfill') {
      write(DIRTY_KEY, { singles: [], sales: [] });
    }
    localStorage.setItem(SCENARIO_KEY, next);
    location.reload();
  };

  function dispatchStorage(key, oldValue, newValue) {
    var event;
    try {
      event = new StorageEvent('storage', { key: key, oldValue: oldValue, newValue: newValue, storageArea: localStorage, url: location.href });
    } catch (_) {
      event = new Event('storage');
      Object.defineProperty(event, 'key', { value: key });
      Object.defineProperty(event, 'oldValue', { value: oldValue });
      Object.defineProperty(event, 'newValue', { value: newValue });
    }
    window.dispatchEvent(event);
  }

  window.__KJR_SYNC_PREVIEW_ACK = function () {
    var markerRaw = localStorage.getItem(ACK_MARKER_KEY);
    if (markerRaw !== null) {
      localStorage.removeItem(ACK_MARKER_KEY);
      dispatchStorage(ACK_MARKER_KEY, markerRaw, null);
    }
    var legacyRaw = localStorage.getItem(DIRTY_KEY);
    write(DIRTY_KEY, { singles: [], _revisions: { singles: {} } });
    dispatchStorage(DIRTY_KEY, legacyRaw, localStorage.getItem(DIRTY_KEY));
    if (typeof _syncDiagRenderBody === 'function') _syncDiagRenderBody();
    if (typeof toast === 'function') toast('Synthetic peer acknowledgement received');
  };

  window.__KJR_SYNC_PREVIEW_RESTORE_ACK = async function () {
    if (scenario !== 'restore-ack') {
      if (typeof toast === 'function') toast('Choose Restore ack demo first');
      return;
    }
    if (window.__KJR_SYNC_PREVIEW_RESTORE_ACK.running) return;
    window.__KJR_SYNC_PREVIEW_RESTORE_ACK.running = true;
    var button = document.getElementById('kjr-sync-preview-restore-ack');
    if (button) { button.disabled = true; button.textContent = 'Acknowledging…'; }
    var originalPreviewGuard = isLocalhostPreview;
    var originalFetch = window.fetch;
    var originalRenderTrash = renderTrash;
    var originalSession = _kjrAuthSession;
    var originalAuthHeader = SB_HDR.Authorization;
    var requestCount = 0;
    var repaintRequested = false;
    try {
      if (!DB.trash.some(function (entry) { return entry && entry.id === RESTORE_ACK_TRASH_ID; })) {
        throw new Error('synthetic Trash entry is missing');
      }
      if (DB.singles.some(function (row) { return row && row.id === RESTORE_ACK_ID; })) {
        throw new Error('synthetic restore row already exists');
      }
      var optimistic = clone(RESTORE_ACK_ITEM);
      optimistic._serverVersion = RESTORE_ACK_OPERATION.expected_version;
      DB.singles.push(optimistic);
      markDirty('singles', RESTORE_ACK_ID, optimistic);
      // Keep this isolated to the mutation-group path below. Calling the
      // normal save helper would schedule an unrelated debounced row flush.
      write('_kjrMutationGroupV2:' + RESTORE_ACK_MUTATION_ID, RESTORE_ACK_GROUP);
      write('_kjrMutationGroupsV2', [RESTORE_ACK_GROUP]);

      // This override exists only for this synthetic acknowledgement action.
      // The shipped app's localhost write guard is restored in finally below.
      isLocalhostPreview = function () { return false; };
      _kjrAuthSession = {
        user_id: 'synthetic-preview-user', session_id: 'synthetic-preview-session',
        access_token: 'synthetic-preview-token',
      };
      SB_HDR.Authorization = 'Bearer synthetic-preview-token';
      window.fetch = function (url, options) {
        var requestUrl = String(url);
        var opts = options || {};
        if (requestUrl !== SYNC_MUTATE_URL || opts.method !== 'POST') {
          return Promise.reject(new TypeError('Synthetic restore fixture rejects unknown request'));
        }
        requestCount++;
        var body;
        try { body = JSON.parse(opts.body); } catch (_) { body = null; }
        var keys = body && typeof body === 'object' ? Object.keys(body).sort().join(',') : '';
        var exact = keys === 'client_protocol,mutation_id,operations' &&
          body.client_protocol === 2 && body.mutation_id === RESTORE_ACK_MUTATION_ID &&
          JSON.stringify(body.operations) === JSON.stringify([RESTORE_ACK_OPERATION]);
        if (!exact) return Promise.reject(new TypeError('Synthetic restore fixture rejects unknown mutation envelope'));
        return Promise.resolve({
          ok: true,
          status: 200,
          json: function () { return Promise.resolve({
            ok: true,
            mutation_id: RESTORE_ACK_MUTATION_ID,
            results: [{
              type: 'restore', table: 'singles', id: RESTORE_ACK_ID,
              row_version: RESTORE_ACK_TOMBSTONE.row_version + 1,
              updated_at: '2026-09-16T00:01:00.000Z',
            }],
          }); },
        });
      };
      renderTrash = function () {
        repaintRequested = true;
        var guard = isLocalhostPreview;
        isLocalhostPreview = function () { return true; };
        try { return originalRenderTrash(false); }
        finally { isLocalhostPreview = guard; }
      };

      var flushed = await _flushMutationGroups();
      await new Promise(function (resolve) { setTimeout(resolve, 0); });
      await new Promise(function (resolve) { setTimeout(resolve, 0); });
      if (!flushed || requestCount !== 1 || !repaintRequested ||
          DB.trash.some(function (entry) { return entry && entry.id === RESTORE_ACK_TRASH_ID; })) {
        throw new Error('synthetic restore acknowledgement did not repaint Trash');
      }
      if (button) button.textContent = 'Restore acknowledged';
      if (typeof toast === 'function') toast('Synthetic restore acknowledged');
    } catch (error) {
      if (button) { button.disabled = false; button.textContent = 'Acknowledge restore'; }
      if (typeof toastError === 'function') toastError('Synthetic restore fixture failed: ' + error.message);
      console.error('[sync preview] restore acknowledgement failed:', error);
    } finally {
      window.fetch = originalFetch;
      isLocalhostPreview = originalPreviewGuard;
      renderTrash = originalRenderTrash;
      _kjrAuthSession = originalSession;
      if (originalAuthHeader === undefined) delete SB_HDR.Authorization;
      else SB_HDR.Authorization = originalAuthHeader;
      window.__KJR_SYNC_PREVIEW_RESTORE_ACK.running = false;
    }
  };

  function clearFixtureStorage() {
    var owned = ${jsonForScript(FIXTURE_OWNED_KEYS)};
    var keys = [];
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (key && (owned.indexOf(key) >= 0 || key.indexOf('pokeinv_dirty_v2:') === 0 || key.indexOf('_kjrMutationGroupV2:') === 0)) keys.push(key);
    }
    keys.forEach(function (key) { localStorage.removeItem(key); });
  }

  // The placeholder is replaced by the server with a real JSON array. It
  // keeps the bootstrap source independent from any row values.
  var initialQueuedSeed = scenario === 'queue-many' ? QUEUE_MANY_SEED : scenario === 'queue-long' ? QUEUE_LONG_SEED : PENDING_SEED;
  var dirtyIds = initialQueuedSeed.singles.map(function (row) { return row.id; });
  if (scenario === 'pending' || scenario === 'queue-many' || scenario === 'queue-long') write(DIRTY_KEY, { singles: dirtyIds });

  window.setTimeout(function () {
    function clearDiagnosticsForFixture() {
      _syncDiagnostics.failures = {};
      _syncDiagnostics.successes = { read: null, write: null };
      _syncDiagnostics.retryReview = null;
      _syncStatus = 'idle';
      _syncDiagPersist();
      _syncDiagRenderIndicator();
    }
    clearDiagnosticsForFixture();
    if (scenario === 'pending' || scenario === 'queue-many' || scenario === 'queue-long') {
      _syncDiagSetSettledStatus();
    } else if (scenario === 'review') {
      // Synthetic chronology only. Production timestamps come from validated
      // cloud acknowledgements, never from preview fixtures.
      var now = Date.now();
      var previousFailureAt = now - 60000;
      _syncDiagnostics.failures.write = {
        at: previousFailureAt,
        code: 'owner_session_expired',
        detail: 'Synthetic previous sign-in expiry',
      };
      _syncDiagnostics.successes.read = now - 2000;
      _syncDiagnostics.successes.write = now - 1000;
      _syncDiagnostics.retryReview = {
        kind: 'pending_review', at: now, pullConfirmed: true,
        historicalWriteAt: previousFailureAt, writeConfirmed: true,
        skipped: { missing: 0, blocked: 0 },
      };
      _syncDiagPersist();
      _syncDiagSetSettledStatus();
    } else if (scenario === 'failure') {
      setSyncStatus('error', 'POST https://synthetic.invalid/sync/v2/pull Bearer fixture-token {"access_token":"fixture-token","email":"fixture@example.test"} ' + 'x'.repeat(600), 'read');
    } else if (scenario === 'offline') {
      try { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); } catch (_) {}
      setSyncStatus('error', 'The browser is offline. Changes remain queued here.', 'read');
    } else if (scenario === 'recovered') {
      // Explicitly synthetic, for the browser QA state only. Production code
      // records these timestamps only from validated cloud acknowledgements.
      _syncDiagRecordSuccess('read');
      _syncDiagRecordSuccess('write');
      setSyncStatus('ok');
    } else if (scenario === 'restore-ack') {
      showPage('trash');
    } else if (scenario === 'warnings') {
      runHealthCheck();
    } else if (scenario === 'backfill') {
      runHealthCheck();
    }
    if (scenario !== 'warnings' && scenario !== 'backfill' && scenario !== 'restore-ack') openSyncDiagnostics();
  }, 700);
})();
</script>`;

// Filled after declaration so the inline bootstrap never carries a second
// hand-maintained list of synthetic IDs.
const PREVIEW_SINGLES_JSON = jsonForScript(PENDING_SINGLES.map(row => row.id));
const PREVIEW_BOOTSTRAP_READY = PREVIEW_BOOTSTRAP.replace('PENDING_SINGLES_PLACEHOLDER', PREVIEW_SINGLES_JSON);

const STATIC_FILES = Object.freeze({
  '/app.js': 'app.js', '/features.js': 'features.js', '/styles.css': 'styles.css', '/sw.js': 'sw.js',
  '/Assets/apple-touch-icon.png': 'Assets/apple-touch-icon.png',
  '/Assets/manifest.webmanifest': 'Assets/manifest.webmanifest',
  '/Assets/whale-icon.png': 'Assets/whale-icon.png',
  '/Assets/whale-icon-192.png': 'Assets/whale-icon-192.png',
  '/Assets/whale-icon-maskable-512.png': 'Assets/whale-icon-maskable-512.png',
  '/Assets/lib/three.core.min.js': 'Assets/lib/three.core.min.js',
  '/Assets/lib/three.module.js': 'Assets/lib/three.module.js',
});

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/manifest+json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
});

function readKnownFile(relativePath) {
  const absolutePath = path.resolve(ROOT, relativePath);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (absolutePath !== ROOT && !absolutePath.startsWith(rootPrefix)) throw new Error('fixture path escaped root');
  return fs.readFileSync(absolutePath);
}

function buildPreviewIndex() {
  let html = readKnownFile('index.html').toString('utf8');
  html = html.replace(/\s*<script\s+src="https?:\/\/[^\"]+"[^>]*><\/script>\s*/gi, '\n');
  html = html.replace(/\s*<link\s+rel="preconnect"[^>]*>\s*/gi, '\n');
  html = html.replace(/\s*<link\s+rel="stylesheet"\s+href="https?:\/\/(?!fonts\.googleapis\.com\/)[^\"]+"[^>]*>\s*/gi, '\n');
  html = html.replace(/\s*<script>\s*\(function\s*\(\)\s*\{\s*var DSN\s*=\s*[\s\S]*?<\/script>\s*/i, '\n');
  html = html.replace(/\s*<section id="kjr-auth-gate"[\s\S]*?<\/section>\s*/i, '\n');
  html = html.replace('</head>', '<style id="kjr-sync-preview-style">#intro{display:none!important}#kjr-sync-preview-tools button{font:inherit;padding:3px 6px;border:1px solid var(--border2);border-radius:6px;background:var(--bg3);color:var(--text);cursor:pointer}#kjr-sync-preview-tools button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}</style>\n</head>');
  html = html.replace('<body>', '<body>' + PREVIEW_TOOLS);
  html = html.replace(/<script\s+src="app\.js[^\"]*"><\/script>/i, function (match) {
    return PREVIEW_BOOTSTRAP_READY + '\n' + match;
  });
  return html;
}

function contentTypeFor(relativePath) {
  return CONTENT_TYPES[path.extname(relativePath).toLowerCase()] || 'application/octet-stream';
}

function requestPath(req) {
  try { return new URL(req.url || '/', 'http://' + HOST + ':' + PORT).pathname; }
  catch (_) { return null; }
}

function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method not allowed');
    return;
  }
  const pathname = requestPath(req);
  if (pathname === '/' || pathname === '/index.html') {
    const body = Buffer.from(buildPreviewIndex(), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self'; worker-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end(); else res.end(body);
    return;
  }
  const relativePath = STATIC_FILES[pathname];
  if (!relativePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Not found');
    return;
  }
  try {
    const body = readKnownFile(relativePath);
    res.writeHead(200, {
      'Content-Type': contentTypeFor(relativePath), 'Content-Length': body.length, 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; connect-src 'self'; worker-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end(); else res.end(body);
  } catch (_) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Fixture asset unavailable');
  }
}

function createPreviewServer() { return http.createServer(handleRequest); }

if (require.main === module) {
  const server = createPreviewServer();
  server.listen(PORT, HOST, function () {
    console.log('Cloud Sync diagnostics preview: http://' + HOST + ':' + PORT + '/');
    console.log('Synthetic controls: Empty, Pending many, Queue 125, Long queue names, Long failure, Offline, Recovered local, Retained receipt, Ack demo, Health warnings, Backfill guards, Acknowledge, Show details, Toggle theme');
    console.log('Cloud, auth and service-worker access: disabled. Google Fonts remains enabled for visual parity.');
  });
  const stop = function () { server.close(function () { process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = {
  HOST, PORT, ROOT, STATIC_FILES, PENDING_SINGLES, EMPTY_SEED, PENDING_SEED,
  QUEUE_MANY_SINGLES, QUEUE_MANY_SEED, QUEUE_LONG_SINGLES, QUEUE_LONG_SEED,
  BACKFILL_SEED, ACK_SEED, WARNING_SEED, buildPreviewIndex, createPreviewServer, handleRequest,
};
