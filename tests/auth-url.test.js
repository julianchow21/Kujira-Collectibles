const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const INDEX_HTML = fs.readFileSync(path.join(PROJECT_ROOT, 'index.html'), 'utf8');
const FIRST_PREPAINT_SCRIPT = (() => {
  const match = INDEX_HTML.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html must contain the inline pre-paint script');
  assert.match(match[1], /_kjrAuthCallback/);
  assert.match(match[1], /replaceState/);
  return match[1];
})();

const CALLBACK_CASES = [
  {
    name: 'hash only',
    search: '',
    hash: '#access_token=access-value&refresh_token=refresh-value&type=magiclink',
    stored: 'access_token=access-value&refresh_token=refresh-value&type=magiclink',
  },
  {
    name: 'query only',
    search: '?code=pkce-value&type=recovery',
    hash: '',
    stored: 'code=pkce-value&type=recovery',
  },
  {
    name: 'hash and query combined',
    search: '?code=pkce-value&type=recovery',
    hash: '#access_token=access-value&refresh_token=refresh-value&type=recovery',
    stored: 'access_token=access-value&refresh_token=refresh-value&type=recovery&code=pkce-value&type=recovery',
  },
];

function runPrepaint({ search, hash, storageThrows = false }) {
  const currentUrl = {
    pathname: '/Kujira-Collectibles/',
    search,
    hash,
  };
  const stored = new Map();
  const historyCalls = [];
  const fetchCalls = [];
  const themeClasses = new Set();
  const sessionStorage = {
    getItem() {
      return null;
    },
    setItem(key, value) {
      if (storageThrows) throw new Error('sessionStorage unavailable');
      stored.set(String(key), String(value));
    },
  };
  const location = {
    get pathname() {
      return currentUrl.pathname;
    },
    get search() {
      return currentUrl.search;
    },
    get hash() {
      return currentUrl.hash;
    },
  };
  const history = {
    replaceState(_state, _title, nextUrl) {
      historyCalls.push(nextUrl);
      const parsed = new URL(nextUrl, `https://example.test${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      currentUrl.pathname = parsed.pathname;
      currentUrl.search = parsed.search;
      currentUrl.hash = parsed.hash;
    },
  };
  const context = vm.createContext({
    URL,
    console: { info() {}, warn() {}, error() {} },
    document: {
      documentElement: {
        classList: {
          add(value) {
            themeClasses.add(value);
          },
        },
      },
    },
    history,
    location,
    localStorage: {
      getItem() {
        return null;
      },
    },
    sessionStorage,
    fetch(...args) {
      fetchCalls.push(args);
      throw new Error('pre-paint code must not exchange a callback');
    },
  });

  vm.runInContext(FIRST_PREPAINT_SCRIPT, context, { filename: 'index.html#prepaint' });
  vm.runInContext('globalThis.__laterUrl = location.search + location.hash', context, { filename: 'later-script.js' });

  return {
    context,
    currentUrl,
    stored,
    historyCalls,
    fetchCalls,
    themeClasses,
  };
}

for (const callbackCase of CALLBACK_CASES) {
  test(`scrubs ${callbackCase.name} callback before later code and preserves it in sessionStorage`, () => {
    const result = runPrepaint(callbackCase);

    assert.equal(result.currentUrl.search, '', 'query must be removed from the visible URL');
    assert.equal(result.currentUrl.hash, '', 'hash must be removed from the visible URL');
    assert.equal(result.context.__laterUrl, '', 'later scripts must see a clean URL');
    assert.equal(result.historyCalls.length, 1, 'history must be replaced exactly once');
    assert.equal(result.historyCalls[0], '/Kujira-Collectibles/');
    assert.equal(result.stored.get('_kjrAuthCallback'), callbackCase.stored);
    assert.equal(result.fetchCalls.length, 0, 'pre-paint callback handling must not exchange tokens');
  });
}

for (const callbackCase of CALLBACK_CASES) {
  test(`scrubs ${callbackCase.name} callback even when sessionStorage.setItem throws`, () => {
    const result = runPrepaint({ ...callbackCase, storageThrows: true });

    assert.equal(result.currentUrl.search, '', 'query must be removed when storage fails');
    assert.equal(result.currentUrl.hash, '', 'hash must be removed when storage fails');
    assert.equal(result.context.__laterUrl, '', 'later scripts must never see callback secrets');
    assert.equal(result.historyCalls.length, 1, 'history cleanup must not depend on storage');
    assert.equal(result.stored.size, 0, 'failed storage must not report a saved callback');
    assert.equal(result.fetchCalls.length, 0, 'storage failure must not trigger a token exchange');
  });
}

test('scrubs an unsupported PKCE code without attempting a claim exchange', () => {
  const result = runPrepaint({
    search: '?code=unsupported-pkce-code&state=opaque-state',
    hash: '',
  });

  assert.equal(result.currentUrl.search, '');
  assert.equal(result.currentUrl.hash, '');
  assert.equal(result.context.__laterUrl, '');
  assert.equal(result.stored.get('_kjrAuthCallback'), 'code=unsupported-pkce-code&state=opaque-state');
  assert.equal(result.fetchCalls.length, 0, 'the pre-paint script must not claim or exchange a PKCE code');
});
