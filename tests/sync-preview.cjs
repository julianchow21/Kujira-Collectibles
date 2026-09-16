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
  '_kjrMutationGroupsV2', '_kjrSyncDiagnosticsV1', 'pokeinventory_version',
];

function previewSingle(id, name, index) {
  return {
    id, name, set: 'Synthetic Set', language: 'EN', type: 'raw', condition: 'Near Mint',
    qty: 1, costPrice: 5 + index, marketPrice: 10 + index, listPrice: '',
    datePurchased: '1 Sep 2026', status: 'Available', notes: '', priceAlert: '', tcgdexId: '',
  };
}

const PENDING_SINGLES = Array.from({ length: 24 }, (_, index) =>
  previewSingle('sync-preview-' + String(index + 1).padStart(2, '0'), 'Synthetic card ' + (index + 1), index + 1));
const EMPTY_SEED = {
  singles: [], slabs: [], sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [],
};
const PENDING_SEED = {
  ...EMPTY_SEED,
  singles: PENDING_SINGLES,
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
  pending: [{ table: 'singles', id: 'sync-preview-01', ts: 1 }], confirmed: [],
};
const PENDING_TRASH = [{
  id: 'sync-preview-trash-01',
  data: {
    originalTable: 'singles', originalId: 'sync-preview-02', item: PENDING_SINGLES[1],
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

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const PREVIEW_TOOLS = `
<aside id="kjr-sync-preview-tools" aria-label="Synthetic sync preview controls" style="position:fixed;right:10px;bottom:10px;z-index:10000;display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:calc(100vw - 20px);padding:7px 9px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--bg2);box-shadow:0 4px 20px rgba(0,0,0,.25);font:11px/1.3 system-ui,sans-serif">
  <strong style="color:var(--accent);white-space:nowrap">SYNC PREVIEW</strong>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('empty')">Empty</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('pending')">Pending many</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('failure')">Long failure</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('offline')">Offline</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('recovered')">Recovered local</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('ack')">Ack demo</button>
  <button type="button" onclick="window.__KJR_SYNC_PREVIEW_SCENARIO('warnings')">Health warnings</button>
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
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  var write = function (key, value) { localStorage.setItem(key, JSON.stringify(clone(value))); };

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

  var scenario = localStorage.getItem(SCENARIO_KEY) || 'empty';
  localStorage.removeItem(SCENARIO_KEY);
  var initialSeed = scenario === 'pending' ? PENDING_SEED : scenario === 'ack' ? ACK_SEED : scenario === 'warnings' ? WARNING_SEED : EMPTY_SEED;
  if (!localStorage.getItem(STORAGE_KEY)) write(STORAGE_KEY, initialSeed);
  if (scenario === 'pending') {
    write(STORAGE_KEY, PENDING_SEED);
    write(DIRTY_KEY, { singles: PENDING_SINGLES_PLACEHOLDER });
  } else if (scenario === 'ack') {
    write(STORAGE_KEY, ACK_SEED);
    write(DIRTY_KEY, { singles: [ACK_ID], _revisions: { singles: { [ACK_ID]: [ACK_TOKEN] } } });
    write(ACK_MARKER_KEY, { table: 'singles', id: ACK_ID, token: ACK_TOKEN, owner: 'peer-tab', createdAt: 1, rowJson: JSON.stringify(ACK_ROW) });
  } else if (scenario === 'warnings') {
    write(STORAGE_KEY, WARNING_SEED);
    write(DIRTY_KEY, { singles: [WARNING_ID], _revisions: { singles: { [WARNING_ID]: [WARNING_TOKEN] } } });
    write(WARNING_MARKER_KEY, { table: 'singles', id: WARNING_ID, token: WARNING_TOKEN, owner: 'peer-tab', createdAt: 1 });
  }

  window.__KJR_SYNC_PREVIEW_SCENARIO = function (next) {
    clearFixtureStorage();
    var nextSeed = next === 'pending' ? PENDING_SEED : next === 'ack' ? ACK_SEED : next === 'warnings' ? WARNING_SEED : EMPTY_SEED;
    write(STORAGE_KEY, nextSeed);
    if (next === 'pending') {
      var dirtyIds = PENDING_SEED.singles.map(function (row) { return row.id; });
      write(DIRTY_KEY, { singles: dirtyIds });
      write('_kjrDeleteStateV2', PENDING_DELETE_STATE);
      write('_kjrPendingTrashWrites', PENDING_TRASH);
      write('_kjrMutationGroupV2:' + PENDING_MUTATION.mutation_id, PENDING_MUTATION);
    } else if (next === 'ack') {
      write(DIRTY_KEY, { singles: [ACK_ID], _revisions: { singles: { [ACK_ID]: [ACK_TOKEN] } } });
      write(ACK_MARKER_KEY, { table: 'singles', id: ACK_ID, token: ACK_TOKEN, owner: 'peer-tab', createdAt: 1, rowJson: JSON.stringify(ACK_ROW) });
    } else if (next === 'warnings') {
      write(DIRTY_KEY, { singles: [WARNING_ID], _revisions: { singles: { [WARNING_ID]: [WARNING_TOKEN] } } });
      write(WARNING_MARKER_KEY, { table: 'singles', id: WARNING_ID, token: WARNING_TOKEN, owner: 'peer-tab', createdAt: 1 });
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
  var dirtyIds = PENDING_SEED.singles.map(function (row) { return row.id; });
  if (scenario === 'pending') write(DIRTY_KEY, { singles: dirtyIds });

  window.setTimeout(function () {
    function clearDiagnosticsForFixture() {
      _syncDiagnostics.failures = {};
      _syncDiagnostics.successes = { read: null, write: null };
      _syncStatus = 'idle';
      _syncDiagPersist();
      _syncDiagRenderIndicator();
    }
    clearDiagnosticsForFixture();
    if (scenario === 'pending') {
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
    } else if (scenario === 'warnings') {
      runHealthCheck();
    }
    if (scenario !== 'warnings') openSyncDiagnostics();
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
    console.log('Synthetic controls: Empty, Pending many, Long failure, Offline, Recovered local, Ack demo, Health warnings, Acknowledge, Show details, Toggle theme');
    console.log('Cloud, auth and service-worker access: disabled. Google Fonts remains enabled for visual parity.');
  });
  const stop = function () { server.close(function () { process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { HOST, PORT, ROOT, STATIC_FILES, PENDING_SINGLES, EMPTY_SEED, PENDING_SEED, ACK_SEED, WARNING_SEED, buildPreviewIndex, createPreviewServer, handleRequest };
