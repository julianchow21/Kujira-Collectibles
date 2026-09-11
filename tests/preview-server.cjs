'use strict';

// Local-only browser fixture for the Quick Sale keyboard pass. This server
// serves the real app shell, app.js, features.js and styles.css, then injects
// a test bootstrap into the index response. It never serves arbitrary paths,
// uses no credentials, and disables all non-local network access in the page.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = 4187;
const STORAGE_KEY = 'pokeinventory_v3';

function previewSingle(id, name, qty, costPrice) {
  return {
    id, name, set: 'Preview Set', language: 'EN', type: 'raw',
    condition: 'Near Mint', qty, costPrice, marketPrice: costPrice * 2,
    listPrice: 25, datePurchased: '1 Sep 2026', status: 'Available',
    notes: '', priceAlert: '', tcgdexId: '',
  };
}

const PREVIEW_SINGLES = [
  // Same group identity, three units total across two lots. Quick Sale can
  // stage two of the three units through the normal quantity stepper.
  previewSingle('preview-eevee-lot-a', 'Eevee VMAX', 2, 10),
  previewSingle('preview-eevee-lot-b', 'Eevee VMAX', 1, 12),
  previewSingle('preview-long', 'Preview Long Card Name That Keeps Its Full Text For Overflow Checks On Small Screens', 1, 8),
];
for (let i = 1; i <= 14; i++) {
  PREVIEW_SINGLES.push(previewSingle(
    'preview-card-' + String(i).padStart(2, '0'),
    'Preview Card ' + String(i).padStart(2, '0'),
    1,
    5 + i,
  ));
}

const PREVIEW_SEED = {
  singles: PREVIEW_SINGLES,
  slabs: [],
  sales: [],
  etbs: [],
  boosterBoxes: [],
  boosterPacks: [],
  ebayPurchases: [],
};

const EMPTY_SEED = {
  singles: [], slabs: [], sales: [], etbs: [], boosterBoxes: [],
  boosterPacks: [], ebayPurchases: [],
};

// JSON is generated from fixed fixture data above, but escape the one HTML
// significant character anyway so the bootstrap can never close its script.
function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const PREVIEW_TOOLS = `
<aside id="kjr-preview-tools" aria-label="Local preview controls" style="position:fixed;right:10px;bottom:10px;z-index:10000;display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:calc(100vw - 20px);padding:7px 9px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--bg2);box-shadow:0 4px 20px rgba(0,0,0,.25);font:11px/1.3 system-ui,sans-serif">
  <strong style="color:var(--accent);white-space:nowrap">LOCAL PREVIEW</strong>
  <button id="kjr-preview-open-sale" type="button" onclick="openCmdBar('sell')">Open Quick Sale</button>
  <button id="kjr-preview-reset" type="button" onclick="window.__kjrPreviewReset('seed')">Reset sample</button>
  <button id="kjr-preview-empty" type="button" onclick="window.__kjrPreviewReset('empty')">Empty inventory</button>
</aside>`;

const PREVIEW_BOOTSTRAP = `<script id="kjr-preview-bootstrap">
(function () {
  'use strict';
  var STORAGE_KEY = ${JSON.stringify(STORAGE_KEY)};
  var PREVIEW_SEED = ${jsonForScript(PREVIEW_SEED)};
  var EMPTY_SEED = ${jsonForScript(EMPTY_SEED)};
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  var write = function (value) { localStorage.setItem(STORAGE_KEY, JSON.stringify(clone(value))); };

  // This is a localhost fixture only. No owner session or production key is
  // created, and every page fetch is rejected before it can leave the origin.
  window.__KJR_QUICK_SALE_PREVIEW__ = true;
  window.fetch = function () { return Promise.reject(new TypeError('Quick Sale preview network disabled')); };
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
  if (!localStorage.getItem(STORAGE_KEY)) write(PREVIEW_SEED);

  window.__kjrPreviewReset = function (mode) {
    localStorage.clear();
    if (mode === 'empty') write(EMPTY_SEED);
    location.reload();
  };
})();
</script>`;

const STATIC_FILES = Object.freeze({
  '/app.js': 'app.js',
  '/features.js': 'features.js',
  '/styles.css': 'styles.css',
  '/sw.js': 'sw.js',
  '/Assets/apple-touch-icon.png': 'Assets/apple-touch-icon.png',
  '/Assets/manifest.webmanifest': 'Assets/manifest.webmanifest',
  '/Assets/whale-icon.png': 'Assets/whale-icon.png',
  '/Assets/whale-icon-192.png': 'Assets/whale-icon-192.png',
  '/Assets/whale-icon-maskable-512.png': 'Assets/whale-icon-maskable-512.png',
  '/Assets/lib/three.core.min.js': 'Assets/lib/three.core.min.js',
  '/Assets/lib/three.module.js': 'Assets/lib/three.module.js',
});

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
});

function readKnownFile(relativePath) {
  const absolutePath = path.resolve(ROOT, relativePath);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (absolutePath !== ROOT && !absolutePath.startsWith(rootPrefix)) throw new Error('fixture path escaped root');
  return fs.readFileSync(absolutePath);
}

function buildPreviewIndex() {
  let html = readKnownFile('index.html').toString('utf8');

  // Remove CDN scripts and font links from this response only. The committed
  // production index remains unchanged and the served app scripts stay real.
  html = html.replace(/\s*<script\s+src="https?:\/\/[^\"]+"[^>]*><\/script>\s*/gi, '\n');
  html = html.replace(/\s*<link\s+rel="preconnect"[^>]*>\s*/gi, '\n');
  html = html.replace(/\s*<link\s+rel="stylesheet"\s+href="https?:\/\/[^\"]+"[^>]*>\s*/gi, '\n');
  // Remove the production Sentry inline initialiser, including its public DSN,
  // from this test response. The real source remains untouched.
  html = html.replace(/\s*<script>\s*\(function\s*\(\)\s*\{\s*var DSN\s*=\s*[\s\S]*?<\/script>\s*/i, '\n');
  // The fixture has no auth session. Removing only the gate section lets the
  // real app start in its existing localhost preview mode.
  html = html.replace(/\s*<section id="kjr-auth-gate"[\s\S]*?<\/section>\s*/i, '\n');
  // Keep the real app shell, but skip its optional launch animation so the
  // Quick Sale control is immediately available for the browser check.
  html = html.replace('</head>', '<style id="kjr-preview-no-intro">#intro{display:none!important}</style>\n</head>');
  html = html.replace('<body>', '<body>' + PREVIEW_TOOLS);
  html = html.replace(/<script\s+src="app\.js[^\"]*"><\/script>/i, function (match) {
    return PREVIEW_BOOTSTRAP + '\n' + match;
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
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'",
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
    console.log('Quick Sale browser preview: http://' + HOST + ':' + PORT + '/');
    console.log('Synthetic data: two Eevee lots totalling 3 units, one long name, 17 searchable rows');
    console.log('Network and service-worker access: disabled in the served test page');
  });
  const stop = function () { server.close(function () { process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = {
  HOST, PORT, ROOT, STATIC_FILES, PREVIEW_SEED, EMPTY_SEED,
  buildPreviewIndex, createPreviewServer, handleRequest,
};
