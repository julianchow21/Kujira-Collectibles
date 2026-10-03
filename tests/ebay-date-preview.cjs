'use strict';

// Local-only fixture for the eBay blank-date browser check. It reuses the
// existing Quick Sale preview shell and transport guard, then replaces the
// local seed with one clearly synthetic eBay purchase whose date is blank.
// No credentials, production records or external requests are used.
const http = require('node:http');
const quickSalePreview = require('./preview-server.cjs');

const HOST = '127.0.0.1';
const PORT = 8767;
const STORAGE_KEY = 'pokeinventory_v3';
const EBAY_ID = 'ebay-date-preview-blank';

const EBAY_ROW = Object.freeze({
  id: EBAY_ID,
  product: 'Synthetic eBay blank-date card',
  status: 'Paid',
  tracking: 'SYNTHETIC-TRACK-001',
  declared: 'No',
  priceUsd: 10,
  freightSgd: 1,
  totalSgd: 13,
  targetTable: 'singles',
  date: '',
  notes: 'Synthetic local QA row, blank date is intentional',
});

const PREVIEW_SEED = Object.freeze({
  singles: quickSalePreview.PREVIEW_SEED.singles,
  slabs: [],
  sales: [],
  etbs: [],
  boosterBoxes: [],
  boosterPacks: [],
  ebayPurchases: [EBAY_ROW],
});

const PREVIEW_TOOLS = `
<aside id="kjr-ebay-date-preview-tools" aria-label="Synthetic eBay date preview controls" style="position:fixed;left:10px;bottom:10px;z-index:10000;display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:calc(100vw - 20px);padding:7px 9px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--bg2);box-shadow:0 4px 20px rgba(0,0,0,.25);font:11px/1.3 system-ui,sans-serif">
  <strong style="color:var(--accent);white-space:nowrap">SYNTHETIC eBAY DATE PREVIEW</strong>
  <span style="color:var(--text2)">Blank Date row</span>
  <button id="kjr-ebay-date-preview-open" type="button" onclick="window.__KJR_EBAY_DATE_PREVIEW_OPEN__()">Open eBay edit</button>
  <button id="kjr-ebay-date-preview-reset" type="button" onclick="window.__KJR_EBAY_DATE_PREVIEW_RESET__()">Reset row</button>
</aside>`;

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function buildBootstrap() {
  return `<script id="kjr-ebay-date-preview-bootstrap">
(function () {
  'use strict';
  var STORAGE_KEY = ${JSON.stringify(STORAGE_KEY)};
  var SEED = ${jsonForScript(PREVIEW_SEED)};
  var EBAY_ID = ${JSON.stringify(EBAY_ID)};
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  var writeSeed = function () { localStorage.setItem(STORAGE_KEY, JSON.stringify(clone(SEED))); };

  // Loopback fixture only. Keep the production transport and auth boundaries
  // closed even if a browser or an app helper tries to fetch during the check.
  window.__KJR_EBAY_DATE_PREVIEW__ = true;
  window.fetch = function () { return Promise.reject(new TypeError('eBay date preview network disabled')); };
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
  document.documentElement.classList.remove('auth-gated');
  writeSeed();

  window.__KJR_EBAY_DATE_PREVIEW_OPEN__ = function () {
    if (typeof window.showPage === 'function') window.showPage('ebay');
    if (typeof window.kjrOpenEbayModal === 'function') window.kjrOpenEbayModal(EBAY_ID);
  };
  window.__KJR_EBAY_DATE_PREVIEW_RESET__ = function () {
    writeSeed();
    location.reload();
  };
})();
</script>`;
}

function buildPreviewIndex() {
  let html = quickSalePreview.buildPreviewIndex();
  html = html.replace('<body>', '<body>' + PREVIEW_TOOLS);
  html = html.replace(/<script\s+src="app\.js[^\"]*"><\/script>/i, function (match) {
    return buildBootstrap() + '\n' + match;
  });
  return html;
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
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end(); else res.end(body);
    return;
  }
  const relativePath = quickSalePreview.STATIC_FILES[pathname];
  if (!relativePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Not found');
    return;
  }
  try {
    const body = require('node:fs').readFileSync(require('node:path').resolve(quickSalePreview.ROOT, relativePath));
    const ext = require('node:path').extname(relativePath).toLowerCase();
    const contentType = ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.json' || ext === '.webmanifest' ? 'application/manifest+json; charset=utf-8'
      : ext === '.png' ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; object-src 'none'; connect-src 'self'; worker-src 'none'",
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') res.end(); else res.end(body);
  } catch (_) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Fixture asset unavailable');
  }
}

function createPreviewServer() {
  return http.createServer(handleRequest);
}

if (require.main === module) {
  const server = createPreviewServer();
  server.listen(PORT, HOST, function () {
    console.log('eBay blank-date browser preview: http://' + HOST + ':' + PORT + '/');
    console.log('Synthetic row: ' + EBAY_ID + ', Date blank, status Paid, target Singles');
    console.log('Network, auth and service-worker access: disabled in the served test page');
  });
  const stop = function () { server.close(function () { process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = {
  HOST,
  PORT,
  ROOT: quickSalePreview.ROOT,
  EBAY_ID,
  EBAY_ROW,
  PREVIEW_SEED,
  buildBootstrap,
  buildPreviewIndex,
  createPreviewServer,
  handleRequest,
};
