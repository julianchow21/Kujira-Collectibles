'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ROOT } = require('./harness.js');

test('sw-update: v3.64 badge, asset URLs and cache v67 are pinned', () => {
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const sw = fs.readFileSync(ROOT + '/sw.js', 'utf8');
  assert.match(html, /id="app-ver"[^>]*>v3\.64 \(3 Oct\)</);
  for (const asset of ['styles.css', 'app.js', 'features.js', 'dealer-money.js', 'dealer-desk.js', 'dealer-ui.js', 'dealer-store.js', 'dealer-production-ui.js']) assert.ok(html.includes(asset + '?v=3.64'));
  assert.match(sw, /const CACHE = 'kujira-v67'/);
  for (const asset of ['styles.css', 'app.js', 'features.js', 'dealer-money.js', 'dealer-desk.js', 'dealer-ui.js', 'dealer-store.js', 'dealer-production-ui.js']) assert.ok(sw.includes(asset + '?v=3.64'));
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
