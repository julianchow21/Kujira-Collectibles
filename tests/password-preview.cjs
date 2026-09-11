'use strict';

// Local-only browser fixture for the password-auth pass. This serves the real
// candidate shell and scripts, then injects a synthetic in-page Auth/Worker
// mock before app.js. The browser never contacts Supabase, the Worker, a CDN,
// Sentry or a service worker from this fixture.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = 4188;
const PREVIEW_PATH = '/auth-preview.html';
const SCENARIO_KEY = '__kjr_auth_preview_scenario_v1';
const OWNER_EMAIL = 'owner@example.test';
const PREVIEW_PASSWORD = 'Preview-Password-2026!';
const OWNER_USER_ID = '00000000-0000-4000-8000-000000000001';
const WRONG_OWNER_USER_ID = '00000000-0000-4000-8000-000000000099';
const OWNER_ACCESS_TOKEN = 'preview-owner-access-token';
const OWNER_REFRESH_TOKEN = 'preview-owner-refresh-token';
const WRONG_OWNER_ACCESS_TOKEN = 'preview-wrong-owner-access-token';
const WRONG_OWNER_REFRESH_TOKEN = 'preview-wrong-owner-refresh-token';
const RECOVERY_ACCESS_TOKEN = 'preview-recovery-access-token';
const RECOVERY_REFRESH_TOKEN = 'preview-recovery-refresh-token';

const STATIC_FILES = Object.freeze({
  '/app.js': 'app.js',
  '/features.js': 'features.js',
  '/styles.css': 'styles.css',
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
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
});

function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const PREVIEW_TOOLS = `
<aside id="kjr-auth-preview-tools" aria-label="Password authentication preview controls" style="position:fixed;left:10px;right:10px;bottom:10px;z-index:400000;display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-height:35vh;overflow:auto;padding:7px 9px;border:1px solid #786cc9;border-radius:10px;background:rgba(18,16,31,.97);color:#f5f3ff;box-shadow:0 4px 20px rgba(0,0,0,.35);font:11px/1.3 system-ui,sans-serif;visibility:visible!important">
  <strong style="color:#a99cff;white-space:nowrap">AUTH PREVIEW</strong>
  <span>owner@example.test / Preview-Password-2026!</span>
  <span id="kjr-auth-preview-status" role="status" aria-live="polite">Scenario: signed-out</span>
  <span id="kjr-auth-preview-last" aria-live="polite">Mock: waiting</span>
  <span role="group" aria-label="Authentication scenarios" style="display:flex;gap:4px;flex-wrap:wrap">
    <button type="button" data-preview-control="reset-signed-out" onclick="window.__KJR_AUTH_PREVIEW_RESET('signed-out')">Reset signed out</button>
    <button type="button" data-preview-control="wrong-owner" onclick="window.__KJR_AUTH_PREVIEW_RESET('wrong-owner')">Wrong owner</button>
    <button type="button" data-preview-control="invalid-credentials" onclick="window.__KJR_AUTH_PREVIEW_RESET('invalid-credentials')">Invalid credentials</button>
    <button type="button" data-preview-control="network-failure" onclick="window.__KJR_AUTH_PREVIEW_RESET('network-failure')">Network failure</button>
    <button type="button" data-preview-control="reset-email-failure" onclick="window.__KJR_AUTH_PREVIEW_RESET('reset-email-failure')">Reset email failure</button>
    <button type="button" data-preview-control="recovery-valid" onclick="window.__KJR_AUTH_PREVIEW_RECOVERY(false)">Recovery valid</button>
    <button type="button" data-preview-control="recovery-expired" onclick="window.__KJR_AUTH_PREVIEW_RECOVERY(true)">Recovery expired</button>
    <button type="button" data-preview-control="theme-toggle" onclick="window.__KJR_AUTH_PREVIEW_TOGGLE_THEME()">Toggle theme</button>
  </span>
</aside>`;

const PREVIEW_BOOTSTRAP = `<script id="kjr-auth-preview-bootstrap">
(function () {
  'use strict';
  var SCENARIO_KEY = ${jsonForScript(SCENARIO_KEY)};
  var OWNER_EMAIL = ${jsonForScript(OWNER_EMAIL)};
  var PREVIEW_PASSWORD = ${jsonForScript(PREVIEW_PASSWORD)};
  var OWNER_USER_ID = ${jsonForScript(OWNER_USER_ID)};
  var WRONG_OWNER_USER_ID = ${jsonForScript(WRONG_OWNER_USER_ID)};
  var OWNER_ACCESS_TOKEN = ${jsonForScript(OWNER_ACCESS_TOKEN)};
  var OWNER_REFRESH_TOKEN = ${jsonForScript(OWNER_REFRESH_TOKEN)};
  var WRONG_OWNER_ACCESS_TOKEN = ${jsonForScript(WRONG_OWNER_ACCESS_TOKEN)};
  var WRONG_OWNER_REFRESH_TOKEN = ${jsonForScript(WRONG_OWNER_REFRESH_TOKEN)};
  var RECOVERY_ACCESS_TOKEN = ${jsonForScript(RECOVERY_ACCESS_TOKEN)};
  var RECOVERY_REFRESH_TOKEN = ${jsonForScript(RECOVERY_REFRESH_TOKEN)};
  var SYNCED_TABLES = ['singles', 'slabs', 'sales', 'etbs', 'booster_boxes', 'booster_packs', 'ebay_purchases'];
  var state = { lastRequest: 'waiting', unknownRequests: 0 };
  var storage = {
    get: function (key) { try { return localStorage.getItem(key); } catch (_) { return null; } },
    set: function (key, value) { try { localStorage.setItem(key, value); } catch (_) {} },
    clear: function () { try { localStorage.clear(); } catch (_) {} },
  };

  function scenario() { return storage.get(SCENARIO_KEY) || 'signed-out'; }
  function setScenario(value) { storage.set(SCENARIO_KEY, value); }
  function updateStatus(message) {
    state.lastRequest = message;
    var scenarioEl = document.getElementById('kjr-auth-preview-status');
    var lastEl = document.getElementById('kjr-auth-preview-last');
    if (scenarioEl) scenarioEl.textContent = 'Scenario: ' + scenario();
    if (lastEl) lastEl.textContent = 'Mock: ' + message;
  }
  function clearAuthStorage() {
    try {
      localStorage.removeItem('_kjrOwnerSessionV1');
      localStorage.removeItem('_kjrOwnerVerifiedV1');
      localStorage.removeItem('pokeinventory_v3');
      localStorage.removeItem('pokeinventory_v3_version');
      localStorage.removeItem('pokeinventory_v3_version_time');
      localStorage.removeItem('pokeinv_dirty_v1');
      localStorage.removeItem('pokeinv_server_tombstones_v1');
    } catch (_) {}
    try { sessionStorage.removeItem('_kjrAuthCallback'); } catch (_) {}
  }
  function resetScenario(next) {
    var theme = storage.get('pokeinv_theme');
    storage.clear();
    if (theme) storage.set('pokeinv_theme', theme);
    setScenario(next);
    location.reload();
  }
  function goRecovery(expired) {
    var theme = storage.get('pokeinv_theme');
    storage.clear();
    if (theme) storage.set('pokeinv_theme', theme);
    setScenario('signed-out');
    clearAuthStorage();
    var callback = expired
      ? '#type=recovery&access_token=' + encodeURIComponent(RECOVERY_ACCESS_TOKEN) + '&refresh_token=' + encodeURIComponent(RECOVERY_REFRESH_TOKEN) + '&expires_at=1'
      : '#type=recovery&access_token=' + encodeURIComponent(RECOVERY_ACCESS_TOKEN) + '&refresh_token=' + encodeURIComponent(RECOVERY_REFRESH_TOKEN) + '&expires_in=3600';
    // This is a real navigation. The production pre-paint script must capture
    // and scrub this fragment, and a later reload must not inject it again.
    var nonce = String(Date.now()) + '-' + String(Math.random()).slice(2);
    location.href = '/auth-preview.html?preview_nonce=' + encodeURIComponent(nonce) + callback;
  }
  function toggleTheme() {
    var next = storage.get('pokeinv_theme') === 'light' ? 'dark' : 'light';
    if (next === 'light') storage.set('pokeinv_theme', 'light');
    else { try { localStorage.removeItem('pokeinv_theme'); } catch (_) {} }
    location.reload();
  }
  window.__KJR_AUTH_PREVIEW_RESET = resetScenario;
  window.__KJR_AUTH_PREVIEW_RECOVERY = goRecovery;
  window.__KJR_AUTH_PREVIEW_TOGGLE_THEME = toggleTheme;
  window.__KJR_AUTH_PREVIEW_STATE__ = state;

  // Keep fixture controls interactive while the real app marks all other body
  // children inert behind the auth gate. This exemption exists only in the
  // served fixture and never changes production _kjrSetAuthGate behaviour.
  var controls = document.getElementById('kjr-auth-preview-tools');
  if (controls && typeof MutationObserver === 'function') {
    var keepControlsInteractive = function () { if (controls.hasAttribute('inert')) controls.removeAttribute('inert'); };
    new MutationObserver(keepControlsInteractive).observe(controls, { attributes: true, attributeFilter: ['inert'] });
    keepControlsInteractive();
  }
  try { localStorage.setItem('kujira_intro_enabled', 'false'); } catch (_) {}
  try { Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); } catch (_) {}
  try {
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: function () { return Promise.resolve({ waiting: null, installing: null, addEventListener: function () {} }); },
        addEventListener: function () {},
      },
    });
  } catch (_) {}
  window.Chart = window.Chart || class { constructor() {} destroy() {} update() {} resize() {} };
  window.marked = window.marked || { parse: function (value) { return String(value || ''); } };
  window.Sentry = undefined;

  function getHeader(headers, name) {
    if (!headers) return '';
    if (typeof headers.get === 'function') return headers.get(name) || '';
    var target = name.toLowerCase();
    for (var key in headers) if (Object.prototype.hasOwnProperty.call(headers, key) && key.toLowerCase() === target) return String(headers[key] || '');
    return '';
  }
  function bearer(init) {
    var value = getHeader(init && init.headers, 'Authorization');
    return value.indexOf('Bearer ') === 0 ? value.slice(7) : '';
  }
  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }
  function emptyResponse(status) { return new Response('', { status: status || 204 }); }
  function validOwnerToken(token) { return token === OWNER_ACCESS_TOKEN || token === RECOVERY_ACCESS_TOKEN; }
  function wrongOwnerToken(token) { return token === WRONG_OWNER_ACCESS_TOKEN; }
  function userForToken(token) {
    if (validOwnerToken(token)) return { id: OWNER_USER_ID, email: OWNER_EMAIL };
    if (wrongOwnerToken(token)) return { id: WRONG_OWNER_USER_ID, email: OWNER_EMAIL };
    return null;
  }
  function syncBody() {
    var tables = {};
    SYNCED_TABLES.forEach(function (table) { tables[table] = []; });
    tables.trash = [];
    return { ok: true, client_protocol: 2, tables: tables, tombstones: [] };
  }
  async function requestBody(init) {
    try { return JSON.parse((init && init.body) || '{}'); } catch (_) { return {}; }
  }
  async function mockFetch(input, init) {
    init = init || {};
    var method = String(init.method || 'GET').toUpperCase();
    var target;
    try { target = new URL(String(input && input.url ? input.url : input), location.href); }
    catch (_) { state.unknownRequests += 1; updateStatus('blocked malformed request'); throw new TypeError('Auth preview network disabled'); }
    var host = target.hostname;
    var pathname = target.pathname;
    var token = bearer(init);
    var currentScenario = scenario();
    var body;

    if (currentScenario === 'network-failure' && (host === 'eywncywatxtlqtrvxjsi.supabase.co' || host === 'kujira-prices.julianchow21.workers.dev')) {
      updateStatus('network failure');
      throw new TypeError('Auth preview network failure');
    }

    if (host === 'eywncywatxtlqtrvxjsi.supabase.co' && pathname === '/auth/v1/token' && target.searchParams.get('grant_type') === 'password' && method === 'POST') {
      body = await requestBody(init);
      updateStatus('password login');
      if (currentScenario === 'invalid-credentials' || body.email !== OWNER_EMAIL || body.password !== PREVIEW_PASSWORD) {
        return jsonResponse({ error: 'invalid_grant', error_description: 'Invalid login credentials' }, 400);
      }
      if (currentScenario === 'wrong-owner') {
        return jsonResponse({ access_token: WRONG_OWNER_ACCESS_TOKEN, refresh_token: WRONG_OWNER_REFRESH_TOKEN, expires_in: 3600, user: userForToken(WRONG_OWNER_ACCESS_TOKEN) });
      }
      return jsonResponse({ access_token: OWNER_ACCESS_TOKEN, refresh_token: OWNER_REFRESH_TOKEN, expires_in: 3600, user: userForToken(OWNER_ACCESS_TOKEN) });
    }

    if (host === 'eywncywatxtlqtrvxjsi.supabase.co' && pathname === '/auth/v1/token' && target.searchParams.get('grant_type') === 'refresh_token' && method === 'POST') {
      body = await requestBody(init);
      updateStatus('refresh token');
      if (body.refresh_token === OWNER_REFRESH_TOKEN) return jsonResponse({ access_token: OWNER_ACCESS_TOKEN, refresh_token: OWNER_REFRESH_TOKEN, expires_in: 3600, user: userForToken(OWNER_ACCESS_TOKEN) });
      if (body.refresh_token === WRONG_OWNER_REFRESH_TOKEN) return jsonResponse({ access_token: WRONG_OWNER_ACCESS_TOKEN, refresh_token: WRONG_OWNER_REFRESH_TOKEN, expires_in: 3600, user: userForToken(WRONG_OWNER_ACCESS_TOKEN) });
      if (body.refresh_token === RECOVERY_REFRESH_TOKEN) return jsonResponse({ access_token: RECOVERY_ACCESS_TOKEN, refresh_token: RECOVERY_REFRESH_TOKEN, expires_in: 3600, user: userForToken(RECOVERY_ACCESS_TOKEN) });
      return jsonResponse({ error: 'invalid_refresh_token' }, 401);
    }

    if (host === 'eywncywatxtlqtrvxjsi.supabase.co' && pathname === '/auth/v1/user' && method === 'GET') {
      updateStatus('user validation');
      var user = userForToken(token);
      return user ? jsonResponse(user, 200) : jsonResponse({ error: 'invalid_token' }, 401);
    }

    if (host === 'eywncywatxtlqtrvxjsi.supabase.co' && pathname === '/auth/v1/user' && method === 'PUT') {
      body = await requestBody(init);
      updateStatus('password update');
      if (!body.password || token !== RECOVERY_ACCESS_TOKEN) return jsonResponse({ error: 'invalid_token' }, 401);
      return jsonResponse(userForToken(RECOVERY_ACCESS_TOKEN), 200);
    }

    if (host === 'eywncywatxtlqtrvxjsi.supabase.co' && pathname === '/auth/v1/recover' && method === 'POST') {
      updateStatus('reset email');
      if (currentScenario === 'reset-email-failure') return jsonResponse({ error: 'email_provider_disabled' }, 503);
      return emptyResponse(200);
    }

    if (host === 'eywncywatxtlqtrvxjsi.supabase.co' && pathname === '/auth/v1/logout' && method === 'POST') {
      updateStatus('logout');
      return emptyResponse(204);
    }

    if (host === 'kujira-prices.julianchow21.workers.dev' && pathname === '/db/rest/v1/singles' && method === 'GET') {
      updateStatus('owner check');
      if (validOwnerToken(token)) return jsonResponse([], 200);
      if (wrongOwnerToken(token)) return jsonResponse({ code: 'owner_forbidden' }, 403);
      return jsonResponse({ code: 'invalid_token' }, 401);
    }

    if (host === 'kujira-prices.julianchow21.workers.dev' && pathname === '/sync/v2/pull' && method === 'POST') {
      updateStatus('owner sync pull');
      if (validOwnerToken(token)) return jsonResponse(syncBody(), 200);
      if (wrongOwnerToken(token)) return jsonResponse({ code: 'owner_forbidden' }, 403);
      return jsonResponse({ code: 'invalid_token' }, 401);
    }

    state.unknownRequests += 1;
    updateStatus('blocked unknown request');
    throw new TypeError('Auth preview network disabled for unknown request');
  }
  window.fetch = mockFetch;
  updateStatus('ready, network mocked');
})();
</script>`;

function readKnownFile(relativePath) {
  const absolutePath = path.resolve(ROOT, relativePath);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (absolutePath !== ROOT && !absolutePath.startsWith(rootPrefix)) throw new Error('fixture path escaped root');
  return fs.readFileSync(absolutePath);
}

function buildPreviewIndex() {
  let html = readKnownFile('index.html').toString('utf8');

  // Strip every remote script, stylesheet and font hint from this response.
  // The committed production index remains unchanged.
  html = html.replace(/\s*<script\s+src="https?:\/\/[^\"]+"[^>]*><\/script>\s*/gi, '\n');
  html = html.replace(/\s*<link\s+rel="preconnect"[^>]*>\s*/gi, '\n');
  html = html.replace(/\s*<link\s+rel="stylesheet"\s+href="https?:\/\/[^\"]+"[^>]*>\s*/gi, '\n');
  // Remove the production Sentry inline initialiser, including its public DSN.
  html = html.replace(/\s*<script>\s*\(function\s*\(\)\s*\{\s*var DSN\s*=\s*[\s\S]*?<\/script>\s*/i, '\n');
  // The auth gate remains intact. The fixture controls are a served-only
  // sibling with an inline visibility rule and a served-only inert exemption.
  html = html.replace('<body>', '<body>' + PREVIEW_TOOLS);
  html = html.replace('</head>', '<style id="kjr-auth-preview-style">#intro{display:none!important}html.auth-gated #kjr-auth-preview-tools{visibility:visible!important}#kjr-auth-preview-tools button{font:inherit;padding:3px 6px;border:1px solid #786cc9;border-radius:6px;background:#2e2752;color:#f5f3ff;cursor:pointer}#kjr-auth-preview-tools button:focus-visible{outline:2px solid #c9c2ff;outline-offset:2px}</style>\n</head>');
  html = html.replace(/<script\s+src="app\.js[^\"]*"><\/script>/i, function (match) {
    return PREVIEW_BOOTSTRAP + '\n' + match;
  });
  return html;
}

function contentTypeFor(relativePath) {
  return CONTENT_TYPES[path.extname(relativePath).toLowerCase()] || 'application/octet-stream';
}

function rawTraversalAttempt(req) {
  const rawPath = String(req.url || '').split('?')[0];
  let decoded = rawPath;
  try { decoded = decodeURIComponent(rawPath); } catch (_) {}
  return /(?:^|\/)\.\.(?:\/|$)/.test(rawPath) || /(?:^|\/)\.\.(?:\/|$)/.test(decoded);
}

function requestPath(req) {
  try { return new URL(req.url || '/', 'http://' + HOST + ':' + PORT).pathname; }
  catch (_) { return null; }
}

function writeText(res, status, text, extraHeaders) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function handleRequest(req, res) {
  if (rawTraversalAttempt(req)) {
    writeText(res, 403, 'Forbidden');
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    writeText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return;
  }

  const pathname = requestPath(req);
  if (pathname === PREVIEW_PATH) {
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
    writeText(res, 404, 'Not found');
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
    writeText(res, 500, 'Fixture asset unavailable');
  }
}

function createPreviewServer() {
  return http.createServer(handleRequest);
}

if (require.main === module) {
  const server = createPreviewServer();
  server.listen(PORT, HOST, function () {
    console.log('Password auth browser preview: http://' + HOST + ':' + PORT + PREVIEW_PATH);
    console.log('Synthetic credentials: ' + OWNER_EMAIL + ' / ' + PREVIEW_PASSWORD);
    console.log('Controls: Reset signed out, Wrong owner, Invalid credentials, Network failure, Reset email failure, Recovery valid, Recovery expired, Toggle theme');
    console.log('Supabase, Worker, CDN, Sentry and service-worker network: mocked or disabled');
  });
  const stop = function () { server.close(function () { process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = {
  HOST,
  PORT,
  ROOT,
  PREVIEW_PATH,
  STATIC_FILES,
  OWNER_EMAIL,
  PREVIEW_PASSWORD,
  OWNER_USER_ID,
  buildPreviewIndex,
  createPreviewServer,
  handleRequest,
};
