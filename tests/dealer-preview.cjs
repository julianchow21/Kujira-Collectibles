'use strict';

// Local-only browser fixture for the Dealer Desk pilot. It reuses the existing
// preview shell sanitiser, but replaces the Quick Sale bootstrap and controls.
// No credentials are created and no request can leave the loopback origin.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const quickSalePreview = require('./preview-server.cjs');

const ROOT = quickSalePreview.ROOT;
const HOST = '127.0.0.1';
const PORT = 8765;
const STORAGE_KEY = 'pokeinventory_v3';
const INIT_KEY = '_kjrDealerPreviewInitialised';

const EMPTY_SEED = Object.freeze({
  singles: [],
  slabs: [],
  sales: [],
  etbs: [],
  boosterBoxes: [],
  boosterPacks: [],
  ebayPurchases: [],
});

// This is deliberately not written on first load. The Dealer UI can call the
// labelled loader below when the browser check needs a candidate row.
const DEALER_PREVIEW_FIXTURE = Object.freeze({
  label: 'SYNTHETIC LOCAL PREVIEW',
  ownerLabel: 'Synthetic Dealer Desk preview owner',
  generatedAt: new Date().toISOString(),
  candidate: Object.freeze({
    id: 'dealer-preview-candidate-001',
    preview: true,
    previewLabel: 'SYNTHETIC LOCAL PREVIEW',
    name: 'Preview Eevee VMAX',
    set: 'Synthetic Preview Set',
    language: 'EN',
    type: 'raw',
    condition: 'Near Mint',
    qty: 1,
    costPrice: 10,
    listPrice: 25,
    status: 'Available',
    datePurchased: '',
    notes: 'Synthetic Dealer Desk candidate. No live record.',
  }),
});

const STATIC_FILES = Object.freeze({
  ...quickSalePreview.STATIC_FILES,
  '/dealer-money.js': 'dealer-money.js',
  '/dealer-desk.js': 'dealer-desk.js',
  '/dealer-ui.js': 'dealer-ui.js',
});

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
});

const PREVIEW_CSP = "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; worker-src 'none'";

const DEALER_FIXTURE_CONTROLS = '<aside id="kjr-dealer-fixture-tools" class="dealer-fixture-tools" aria-labelledby="kjr-dealer-fixture-tools-title">' +
  '<div class="dealer-fixture-tools-copy"><strong id="kjr-dealer-fixture-tools-title">Synthetic QA controls</strong><span>Loopback fixture only, no production data or network access</span></div>' +
  '<div class="dealer-fixture-tools-actions">' +
  '<button class="btn btn-ghost" id="kjr-dealer-theme-toggle" type="button" aria-pressed="false">Switch to light theme</button>' +
  '<button class="btn btn-ghost" id="kjr-dealer-load-many" type="button">Load many synthetic candidates</button>' +
  '</div>' +
  '<p class="dealer-fixture-tools-status" id="kjr-dealer-fixture-status" aria-live="polite"></p>' +
  '</aside>';

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function buildDealerBootstrap() {
  return `<script id="kjr-dealer-preview-bootstrap">
(function () {
  'use strict';
  var STORAGE_KEY = ${JSON.stringify(STORAGE_KEY)};
  var INIT_KEY = ${JSON.stringify(INIT_KEY)};
  var EMPTY_SEED = ${jsonForScript(EMPTY_SEED)};
  var FIXTURE = ${jsonForScript(DEALER_PREVIEW_FIXTURE)};
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  var existingCanonical = localStorage.getItem(STORAGE_KEY);
  var canonicalStorageError = false;
  if (existingCanonical) {
    try {
      var parsedCanonical = JSON.parse(existingCanonical);
      var canonicalTables = ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'];
      canonicalStorageError = !parsedCanonical || typeof parsedCanonical !== 'object' || Array.isArray(parsedCanonical) || canonicalTables.some(function (table) {
        return parsedCanonical[table] !== undefined && !Array.isArray(parsedCanonical[table]);
      });
    } catch (_) { canonicalStorageError = true; }
  }
  var writeCanonical = function (value) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clone(value)));
  };

  // This bootstrap is injected only by the loopback fixture. It creates no
  // owner session, reads no credentials, and rejects application fetches.
  window.__KJR_DEALER_PREVIEW__ = true;
  window.__KJR_DEALER_PREVIEW_RESTRICT_NAV__ = true;
  window.__KJR_DEALER_PREVIEW_OWNER__ = { label: FIXTURE.ownerLabel };
  window.__KJR_DEALER_PREVIEW_FIXTURE__ = clone(FIXTURE);
  window.__KJR_DEALER_PREVIEW_STORAGE_ERROR__ = canonicalStorageError;
  document.documentElement.classList.add('dealer-preview-only');
  document.documentElement.classList.remove('auth-gated');
  window.fetch = function () {
    return Promise.reject(new TypeError('Dealer Desk preview network disabled'));
  };
  try { Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); } catch (_) {}
  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: function () {
        return Promise.resolve({ waiting: null, installing: null, addEventListener: function () {} });
      } });
      Object.defineProperty(navigator.serviceWorker, 'addEventListener', { configurable: true, value: function () {} });
    }
  } catch (_) {}
  window.Chart = class { constructor() {} destroy() {} update() {} resize() {} };
  window.marked = { parse: function (value) { return String(value || ''); } };
  window.Sentry = undefined;

  function fixtureLoopback() {
    var locationValue = window.location || {};
    var protocol = String(locationValue.protocol || '').toLowerCase();
    var hostname = String(locationValue.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return (protocol === 'http:' || protocol === 'https:') &&
      (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') &&
      window.__KJR_DEALER_PREVIEW__ === true &&
      window.__KJR_DEALER_PREVIEW_RESTRICT_NAV__ === true;
  }

  function fixtureStatus(message, tone) {
    var node = document.getElementById('kjr-dealer-fixture-status');
    if (!node) return;
    node.textContent = message || '';
    if (tone) node.setAttribute('data-tone', tone); else node.removeAttribute('data-tone');
  }

  function syncFixtureThemeButton() {
    var button = document.getElementById('kjr-dealer-theme-toggle');
    if (!button) return;
    var light = document.documentElement.classList.contains('light');
    button.textContent = light ? 'Switch to dark theme' : 'Switch to light theme';
    button.setAttribute('aria-pressed', light ? 'true' : 'false');
  }

  function syntheticCandidate(index) {
    var id = 'dealer-preview-many-' + String(index).padStart(3, '0');
    var isLong = index === 1;
    var longName = 'Synthetic responsive review candidate with a deliberately long identity label ' + 'X'.repeat(42);
    var longSet = 'Synthetic QA set with a deliberately long set label for narrow viewport wrapping ' + 'Y'.repeat(30);
    var longNotes = 'Synthetic long text used to verify wrapping, disclosure spacing, keyboard focus, and readable recovery on a narrow viewport. '.repeat(7);
    return {
      id: id,
      name: isLong ? longName : 'Synthetic QA Candidate ' + String(index).padStart(2, '0'),
      set: isLong ? longSet : 'Synthetic QA Set ' + String(index).padStart(2, '0'),
      number: String(100 + index),
      language: 'EN',
      variant: isLong ? 'Synthetic variant with a long label for responsive wrapping' : 'Synthetic variant ' + String(index),
      format: 'raw',
      ownership: 'Business',
      condition: { value: 'Near Mint', certainty: 'Known', scenario: '' },
      frontRef: 'synthetic://qa-front-' + String(index),
      backRef: 'synthetic://qa-back-' + String(index),
      notes: isLong ? longNotes : 'Synthetic QA candidate for pagination and responsive review, no live record.',
      evidenceRefs: [{
        class: 'manual',
        sourceDate: new Date().toISOString(),
        match: 'Exact synthetic fixture match',
        confidence: 'high',
        reference: 'synthetic://dealer-preview-many/' + String(index),
        rationale: 'Synthetic QA fixture identity and references are controlled by this loopback preview.',
        synthetic: true
      }]
    };
  }

  async function loadManySyntheticCandidates() {
    if (!fixtureLoopback()) return;
    var button = document.getElementById('kjr-dealer-load-many');
    var desk = window.DealerDesk;
    if (!desk || typeof desk.getState !== 'function' || typeof desk.createCandidate !== 'function') {
      fixtureStatus('Dealer Desk is still loading, try again shortly.', 'error');
      return;
    }
    if (button) button.disabled = true;
    var loaded = 0;
    var total = 24;
    try {
      for (var index = 1; index <= total; index += 1) {
        var stateResult = desk.getState();
        if (!stateResult || !stateResult.ok) throw new Error(stateResult && (stateResult.message || stateResult.code) || 'Dealer state could not be read');
        var id = 'dealer-preview-many-' + String(index).padStart(3, '0');
        var exists = stateResult.state.candidates.some(function (candidate) { return candidate.id === id; });
        if (exists) continue;
        fixtureStatus('Loading synthetic candidates, ' + String(index) + ' of ' + String(total) + '…');
        var result = await desk.createCandidate(syntheticCandidate(index), {
          ownerId: stateResult.ownerId,
          requestId: 'fixture-many-' + id + '-' + String(Date.now()),
          expectedRevision: stateResult.revision,
          candidateVersion: 0
        });
        if (!result || (!result.ok && result.code !== 'candidate_exists')) throw new Error(result && (result.message || result.code) || 'Synthetic candidate could not be created');
        if (result.ok) loaded += 1;
      }
      if (typeof window.showPage === 'function') window.showPage('dealer');
      else if (typeof window.renderDealerDesk === 'function') window.renderDealerDesk();
      fixtureStatus(loaded ? 'Loaded ' + String(loaded) + ' synthetic candidates, including one long-text candidate.' : 'Synthetic QA candidates are already loaded.', 'success');
    } catch (error) {
      fixtureStatus('Synthetic candidate load stopped safely: ' + String(error && error.message || error), 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  function bindFixtureControls() {
    var themeButton = document.getElementById('kjr-dealer-theme-toggle');
    if (themeButton && !themeButton.dataset.bound) {
      themeButton.dataset.bound = '1';
      themeButton.addEventListener('click', function () {
        if (!fixtureLoopback()) return;
        if (typeof window.toggleTheme === 'function') window.toggleTheme();
        syncFixtureThemeButton();
        fixtureStatus('Theme changed for this local preview.', 'success');
      });
    }
    var manyButton = document.getElementById('kjr-dealer-load-many');
    if (manyButton && !manyButton.dataset.bound) {
      manyButton.dataset.bound = '1';
      manyButton.addEventListener('click', loadManySyntheticCandidates);
    }
    syncFixtureThemeButton();
    if (window.__KJR_DEALER_PREVIEW_STORAGE_ERROR__ === true) {
      fixtureStatus('Existing local canonical cache is invalid. It was preserved, and no reset was performed.', 'error');
    }
  }

  if (document && typeof document.getElementById === 'function') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindFixtureControls);
    else bindFixtureControls();
  }

  // Explicitly bounded reset for discarded synthetic pilot state. The UI
  // confirmation calls this only on the marked loopback fixture. It removes
  // Dealer metadata/WAL/owner scope together with the canonical fixture DB,
  // never the whole localStorage namespace and never production state.
  window.__KJR_DEALER_PREVIEW_RESET__ = function () {
    if (window.__KJR_DEALER_PREVIEW__ !== true) return false;
    localStorage.removeItem('kjr_dealer_desk_r0_v1');
    localStorage.removeItem('kjr_dealer_desk_wal_r0_v1');
    localStorage.removeItem('kjr_dealer_owner_r0_v1');
    localStorage.removeItem('_kjrLocalTrash');
    writeCanonical(EMPTY_SEED);
    window.location.reload();
    return true;
  };

  // The fixture origin starts with an empty canonical DB. Only known keys are
  // touched, so another origin's localStorage can never be cleared.
  localStorage.removeItem('_kjrSyncDiagnosticsV1');
  if (!localStorage.getItem(STORAGE_KEY)) writeCanonical(EMPTY_SEED);
  if (!localStorage.getItem(INIT_KEY)) localStorage.setItem(INIT_KEY, '1');
})();
</script>`;
}

function injectDealerScripts(html) {
  const hasDealerScript = function (filename) {
    const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('<script\\b[^>]*\\bsrc=["\\\'][^"\\\']*' + escaped + '(?:\\?[^"\\\']*)?["\\\'][^>]*>', 'i').test(html);
  };
  const missingMoney = !hasDealerScript('dealer-money.js');
  const missingDesk = !hasDealerScript('dealer-desk.js');
  const missingUi = !hasDealerScript('dealer-ui.js');
  const afterFeatures = [
    missingDesk ? '<script src="dealer-desk.js"></script>' : '',
    missingUi ? '<script src="dealer-ui.js"></script>' : '',
  ].filter(Boolean).join('\n');

  // Keep the bootstrap before the real app. Existing production Dealer tags
  // retain their exact URL and position, fallbacks are added only when absent.
  html = html.replace(/<script\s+src="app\.js[^\"]*"><\/script>/i, function (match) {
    return buildDealerBootstrap() + '\n' + (missingMoney ? '<script src="dealer-money.js"></script>\n' : '') + match;
  });
  if (afterFeatures) {
    const withFeatures = html.replace(/(<script\s+src="features\.js[^\"]*"><\/script>)/i, '$1\n' + afterFeatures);
    html = withFeatures === html
      ? html.replace('</body>', afterFeatures + '\n</body>')
      : withFeatures;
  }
  return html;
}

function buildPreviewIndex() {
  let html = quickSalePreview.buildPreviewIndex();

  // Remove the existing Quick Sale-only controls and bootstrap. The base
  // function still provides the production shell sanitisation.
  html = html.replace(/\s*<aside id="kjr-preview-tools"[\s\S]*?<\/aside>\s*/i, '\n');
  html = html.replace(/\s*<script id="kjr-preview-bootstrap">[\s\S]*?<\/script>\s*/i, '\n');
  html = injectDealerFixtureControls(html);
  return injectDealerScripts(html);
}

function injectDealerFixtureControls(html) {
  if (html.includes('id="kjr-dealer-fixture-tools"')) return html;
  const pageMarker = /(<div id="page-dealer"[^>]*>)/i;
  if (pageMarker.test(html)) return html.replace(pageMarker, '$1\n' + DEALER_FIXTURE_CONTROLS);
  const rootMarker = /(<div id="dealer-root"[^>]*>)/i;
  if (rootMarker.test(html)) return html.replace(rootMarker, DEALER_FIXTURE_CONTROLS + '\n$1');
  return html;
}

function readKnownFile(relativePath) {
  const absolutePath = path.resolve(ROOT, relativePath);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (absolutePath !== ROOT && !absolutePath.startsWith(rootPrefix)) {
    throw new Error('fixture path escaped root');
  }
  return fs.readFileSync(absolutePath);
}

function contentTypeFor(relativePath) {
  return CONTENT_TYPES[path.extname(relativePath).toLowerCase()] || 'application/octet-stream';
}

function requestPath(req) {
  try {
    return new URL(req.url || '/', 'http://' + HOST + ':' + PORT).pathname;
  } catch (_) {
    return null;
  }
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
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': PREVIEW_CSP,
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
      'Content-Type': contentTypeFor(relativePath),
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': PREVIEW_CSP,
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end(); else res.end(body);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Fixture asset unavailable');
  }
}

function createPreviewServer() {
  return http.createServer(handleRequest);
}

if (require.main === module) {
  const server = createPreviewServer();
  server.listen(PORT, HOST, function () {
    console.log('Dealer Desk browser preview: http://' + HOST + ':' + PORT + '/');
    console.log('Initial canonical DB: empty; use the labelled synthetic candidate control');
    console.log('Network and service-worker access: disabled in the served test page');
  });
  const stop = function () { server.close(function () { process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = {
  HOST,
  PORT,
  ROOT,
  STORAGE_KEY,
  INIT_KEY,
  EMPTY_SEED,
  DEALER_PREVIEW_FIXTURE,
  STATIC_FILES,
  DEALER_FIXTURE_CONTROLS,
  injectDealerScripts,
  injectDealerFixtureControls,
  buildPreviewIndex,
  createPreviewServer,
  handleRequest,
};
