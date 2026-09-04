'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ROOT } = require('./harness.js');

test('sw-update: v3.43 badge, asset URLs and cache v46 are pinned', () => {
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const sw = fs.readFileSync(ROOT + '/sw.js', 'utf8');
  assert.match(html, /id="app-ver"[^>]*>v3\.43 \(4 Sep\)</);
  for (const asset of ['styles.css', 'app.js', 'features.js']) assert.ok(html.includes(asset + '?v=3.43'));
  assert.match(sw, /const CACHE = 'kujira-v46'/);
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
