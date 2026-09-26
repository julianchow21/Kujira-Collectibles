'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const preview = require('./dealer-preview.cjs');
const appSource = fs.readFileSync(path.join(preview.ROOT, 'app.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(preview.ROOT, 'styles.css'), 'utf8');

function fakeRequest(url, method = 'GET') {
  const chunks = [];
  const response = {
    statusCode: null,
    headers: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      if (body !== undefined) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
      this.body = Buffer.concat(chunks);
    },
  };
  preview.handleRequest({ method, url }, response);
  return response;
}

function dealerBootstrapSource() {
  const html = preview.buildPreviewIndex();
  const match = html.match(/<script id="kjr-dealer-preview-bootstrap">([\s\S]*?)<\/script>/i);
  assert.ok(match, 'Dealer bootstrap must be present');
  return match[1];
}

function runDealerBootstrap(initialValues = {}) {
  const values = new Map(Object.entries(initialValues));
  const removedClasses = [];
  const addedClasses = [];
  let reloaded = false;
  const serviceWorker = { register() {}, addEventListener() {} };
  const localStorage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const context = {
    localStorage,
    navigator: { serviceWorker },
    document: { documentElement: { classList: { add(name) { addedClasses.push(name); }, remove(name) { removedClasses.push(name); } } } },
    location: { reload() { reloaded = true; } },
    window: { location: { reload() { reloaded = true; } } },
  };
  vm.runInNewContext(dealerBootstrapSource(), context);
  return { values, removedClasses, addedClasses, reloaded, window: context.window };
}

test('Dealer preview is loopback-only and starts with an empty canonical seed', () => {
  assert.equal(preview.HOST, '127.0.0.1');
  assert.equal(preview.PORT, 8765);
  assert.deepEqual(preview.EMPTY_SEED, {
    singles: [], slabs: [], sales: [], etbs: [],
    boosterBoxes: [], boosterPacks: [], ebayPurchases: [],
  });
  assert.equal(preview.DEALER_PREVIEW_FIXTURE.label, 'SYNTHETIC LOCAL PREVIEW');
  assert.equal(preview.DEALER_PREVIEW_FIXTURE.candidate.preview, true);
  assert.match(preview.DEALER_PREVIEW_FIXTURE.generatedAt, /^20\d\d-\d\d-\d\dT/);
});

test('Dealer preview shell replaces Quick Sale controls and strips private integrations', () => {
  const html = preview.buildPreviewIndex();

  assert.match(html, /id="kjr-dealer-preview-bootstrap"/);
  assert.match(html, /window\.__KJR_DEALER_PREVIEW__ = true/);
  assert.match(html, /__KJR_DEALER_PREVIEW_RESTRICT_NAV__ = true/);
  assert.match(html, /__KJR_DEALER_PREVIEW_OWNER__/);
  assert.match(html, /__KJR_DEALER_PREVIEW_FIXTURE__/);
  assert.match(html, /__KJR_DEALER_PREVIEW_STORAGE_ERROR__/);
  assert.match(html, /__KJR_DEALER_PREVIEW_RESET__/);
  assert.match(html, /classList\.add\('dealer-preview-only'\)/);
  assert.match(html, /classList\.remove\('auth-gated'\)/);
  assert.match(html, /SYNTHETIC LOCAL PREVIEW/);
  assert.match(html, /<script src="dealer-money\.js(?:\?[^\"]+)?"><\/script>/);
  assert.match(html, /<script src="dealer-desk\.js(?:\?[^\"]+)?"><\/script>/);
  assert.match(html, /<script src="dealer-ui\.js(?:\?[^\"]+)?"><\/script>/);
  assert.match(html, /id="kjr-dealer-fixture-tools"/);
  assert.match(html, /Switch to light theme/);
  assert.match(html, /Load many synthetic candidates/);
  assert.match(html, /window\.DealerDesk/);
  assert.match(html, /desk\.createCandidate/);
  assert.match(html, /dealer-preview-many-/);

  assert.doesNotMatch(html, /id="kjr-preview-tools"/);
  assert.doesNotMatch(html, /id="kjr-preview-open-sale"/);
  assert.doesNotMatch(html, /__KJR_QUICK_SALE_PREVIEW__/);
  assert.doesNotMatch(html, /__KJR_DEALER_PREVIEW_LOAD_SYNTHETIC__/);
  assert.doesNotMatch(html, /localStorage\.clear\(\)/);
  assert.doesNotMatch(html, /<section id="kjr-auth-gate"/i);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//i);
  assert.doesNotMatch(html, /<link[^>]+(?:href|src)="https?:\/\//i);
});

test('Dealer preview startup skips legacy FX and refresh work after DB hydration', () => {
  assert.match(appSource, /protocol === 'http:' \|\| protocol === 'https:'/);
  assert.doesNotMatch(appSource, /hostname === '0\.0\.0\.0'/);
  assert.match(appSource, /if \(!_kjrDealerPreviewOnly\(\)\) \{\s*getSgdRate\(\)\.then/);
  assert.match(appSource, /initDB\(\);\s*\/\/ Keep the local synthetic fixture offline[\s\S]*?if \(_kjrDealerPreviewOnly\(\)\) return;/);
});

test('Dealer form and fixture QA controls use theme-aware scoped styling', () => {
  assert.match(stylesSource, /#dealer-root \.dealer-grid label input/);
  assert.match(stylesSource, /background:var\(--bg3\)/);
  assert.match(stylesSource, /box-shadow:0 0 0 3px var\(--accent-glow\)/);
  assert.match(stylesSource, /\.dealer-fixture-tools/);
});

test('Dealer bootstrap clears only auth prepaint and preserves an existing pilot DB', () => {
  const fresh = runDealerBootstrap();
  assert.deepEqual(JSON.parse(fresh.values.get(preview.STORAGE_KEY)), preview.EMPTY_SEED);
  assert.equal(fresh.values.get(preview.INIT_KEY), '1');
  assert.deepEqual(fresh.removedClasses, ['auth-gated']);
  assert.deepEqual(fresh.addedClasses, ['dealer-preview-only']);
  assert.equal(fresh.window.__KJR_DEALER_PREVIEW__, true);
  assert.equal(fresh.window.__KJR_DEALER_PREVIEW_OWNER__.label, 'Synthetic Dealer Desk preview owner');

  const existing = JSON.stringify({ singles: [{ id: 'existing-local-pilot-row' }] });
  const preserved = runDealerBootstrap({ [preview.STORAGE_KEY]: existing });
  assert.equal(preserved.values.get(preview.STORAGE_KEY), existing);
  assert.equal(preserved.values.get(preview.INIT_KEY), '1');

  const reset = runDealerBootstrap({
    [preview.STORAGE_KEY]: JSON.stringify({ singles: [{ id: 'synthetic-row' }] }),
    kjr_dealer_desk_r0_v1: '{"ownerId":"old"}',
    kjr_dealer_desk_wal_r0_v1: '{"pending":true}',
    kjr_dealer_owner_r0_v1: 'old-owner',
    unrelated_fixture_key: 'keep-me',
  });
  assert.equal(reset.window.__KJR_DEALER_PREVIEW_RESET__(), true);
  assert.deepEqual(JSON.parse(reset.values.get(preview.STORAGE_KEY)), preview.EMPTY_SEED);
  assert.equal(reset.values.has('kjr_dealer_desk_r0_v1'), false);
  assert.equal(reset.values.has('kjr_dealer_desk_wal_r0_v1'), false);
  assert.equal(reset.values.has('kjr_dealer_owner_r0_v1'), false);
  assert.equal(reset.values.get('unrelated_fixture_key'), 'keep-me');

  const malformed = '{"singles":';
  const preservedMalformed = runDealerBootstrap({ [preview.STORAGE_KEY]: malformed });
  assert.equal(preservedMalformed.values.get(preview.STORAGE_KEY), malformed);
  assert.equal(preservedMalformed.window.__KJR_DEALER_PREVIEW_STORAGE_ERROR__, true);
});

test('Dealer script injection preserves versioned production tags and adds only missing fallbacks', () => {
  const production = [
    '<script src="dealer-money.js?v=42"></script>',
    '<script src="app.js?v=60"></script>',
    '<script src="features.js?v=60"></script>',
    '<script src="dealer-desk.js?v=42"></script>',
    '<script src="dealer-ui.js?v=42"></script>',
  ].join('\n');
  const preserved = preview.injectDealerScripts(production);
  assert.match(preserved, /dealer-money\.js\?v=42/);
  assert.match(preserved, /dealer-desk\.js\?v=42/);
  assert.match(preserved, /dealer-ui\.js\?v=42/);
  assert.equal((preserved.match(/dealer-money\.js/g) || []).length, 1);
  assert.equal((preserved.match(/dealer-desk\.js/g) || []).length, 1);
  assert.equal((preserved.match(/dealer-ui\.js/g) || []).length, 1);

  const fallback = preview.injectDealerScripts(
    '<script src="app.js?v=60"></script><script src="features.js?v=60"></script></body>',
  );
  assert.ok(fallback.indexOf('dealer-money.js') < fallback.indexOf('app.js'));
  assert.ok(fallback.indexOf('dealer-desk.js') > fallback.indexOf('features.js'));
  assert.ok(fallback.indexOf('dealer-ui.js') > fallback.indexOf('features.js'));
});

test('Dealer preview serves only allowlisted local assets with restrictive headers', () => {
  const root = fakeRequest('/');
  assert.equal(root.statusCode, 200);
  assert.equal(root.headers['Cache-Control'], 'no-store');
  assert.match(root.headers['Content-Security-Policy'], /connect-src 'none'/);
  assert.equal(root.headers['X-Content-Type-Options'], 'nosniff');
  assert.match(root.body.toString('utf8'), /kjr-dealer-preview-bootstrap/);

  for (const pathname of ['/dealer-money.js', '/dealer-desk.js', '/dealer-ui.js']) {
    const response = fakeRequest(pathname);
    const sourcePath = path.join(preview.ROOT, preview.STATIC_FILES[pathname]);
    if (fs.existsSync(sourcePath)) {
      assert.equal(response.statusCode, 200, pathname);
      assert.match(response.headers['Content-Type'], /javascript/);
    } else {
      assert.equal(response.statusCode, 404, pathname);
      assert.equal(response.body.toString('utf8'), 'Fixture asset unavailable');
    }
  }

  const app = fakeRequest('/app.js?cache=dealer-preview');
  assert.equal(app.statusCode, 200);
  assert.match(app.headers['Content-Type'], /javascript/);

  const unknown = fakeRequest('/private-data.json');
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.toString('utf8'), 'Not found');
});

test('Dealer preview rejects writes and supports HEAD without returning a body', () => {
  const post = fakeRequest('/', 'POST');
  assert.equal(post.statusCode, 405);
  assert.equal(post.headers.Allow, 'GET, HEAD');

  const head = fakeRequest('/', 'HEAD');
  assert.equal(head.statusCode, 200);
  assert.equal(head.body.length, 0);
  assert.match(head.headers['Content-Type'], /text\/html/);
});

test('Dealer preview server is not started by importing the fixture', () => {
  const server = preview.createPreviewServer();
  assert.equal(server.address(), null);
  server.close();
});
