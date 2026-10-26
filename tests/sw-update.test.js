'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ROOT } = require('./harness.js');
const { ASSETS, CACHE, tag, escapeRegExp } = require('./version.js'); // the build the worker should carry, written once (tests/version.js)

// The worker's half of a bump: a new CACHE name is what makes every client drop the old shell, and the precache list holds each app asset at its new ?v= URL, so the
// install fetches the new bytes and not the old ones. The page's half (badge, Sentry release, the eight tags) is pinned in navigation.test.js, each part once.
test('sw-update: the cache name and every precached app asset carry the current build, the vendored library keeps its own', () => {
  const sw = fs.readFileSync(ROOT + '/sw.js', 'utf8');
  assert.match(sw, new RegExp("const CACHE = '" + escapeRegExp(CACHE) + "'"));
  for (const asset of ASSETS) assert.ok(sw.includes("'./" + tag(asset) + "'"), 'sw CORE ' + asset);
  assert.match(sw, /'\.\/Assets\/lib\/three\.module\.js\?v=3\.31'/, 'the vendored library keeps its own version');
});

test('sw-update: waiting update action is a keyboard-native button which posts SKIP_WAITING', () => {
  const src = fs.readFileSync(ROOT + '/features.js', 'utf8');
  assert.match(src, /<button id="kjr-update-pill-action"[^>]*type="button"[^>]*>Reload now<\/button>/);
  assert.match(src, /_kjrWaitingWorker\.postMessage\(\{ type: 'SKIP_WAITING' \}\)/);
  assert.doesNotMatch(src, /kjr-update-pill-action[^\n]+(?:keydown|keypress)/,
    'native button activation must not be replaced with a click-only keyboard shim');
});

test('sw-update: service worker waits on install and honours SKIP_WAITING', () => {
  const listeners = {};
  let skipped = 0;
  const sandbox = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, skipWaiting: () => { skipped++; },
      clients: { claim: async () => {} }, location: { origin: 'https://example.test' } },
    caches: { open: async () => ({ add: async () => {} }), keys: async () => [], delete: async () => {}, match: async () => null },
    fetch: async () => ({ ok: true, clone() { return this; } }), URL, Response, Promise,
  };
  vm.runInNewContext(fs.readFileSync(ROOT + '/sw.js', 'utf8'), sandbox);
  let installPromise;
  listeners.install({ waitUntil: promise => { installPromise = promise; } });
  assert.ok(installPromise && typeof installPromise.then === 'function');
  listeners.message({ data: { type: 'OTHER' } });
  assert.strictEqual(skipped, 0);
  listeners.message({ data: { type: 'SKIP_WAITING' } });
  assert.strictEqual(skipped, 1);
});
