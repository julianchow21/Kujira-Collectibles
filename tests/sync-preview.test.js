'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const preview = require('./sync-preview.cjs');

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
    end(body) { this.body = body ? Buffer.from(body).toString('utf8') : ''; },
  };
}

function bootstrapSource() {
  const html = preview.buildPreviewIndex();
  const match = html.match(/<script id="kjr-sync-preview-bootstrap">([\s\S]*?)<\/script>/i);
  assert.ok(match, 'sync preview bootstrap must be present');
  return match[1];
}

function runBootstrap(scenario) {
  const values = new Map();
  const button = { hidden: true };
  const localStorage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] || null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const sandbox = {
    URL,
    localStorage,
    location: { href: 'http://127.0.0.1:3817/?scenario=' + (scenario || 'restore-ack') },
    navigator: { onLine: true, serviceWorker: null },
    document: {
      documentElement: { classList: { remove() {} } },
      getElementById(id) { return id === 'kjr-sync-preview-restore-ack' ? button : null; },
    },
    setTimeout() {},
    clearTimeout() {},
    console,
  };
  sandbox.window = sandbox;
  vm.runInNewContext(bootstrapSource(), sandbox, { filename: 'sync-preview-bootstrap.js' });
  return { values, button, window: sandbox.window };
}

test('sync preview restore acknowledgement is labelled and fixture-only', () => {
  const html = preview.buildPreviewIndex();
  assert.match(html, /SYNC PREVIEW/);
  assert.match(html, /__KJR_SYNC_PREVIEW_SCENARIO\('queue-many'\)/);
  assert.match(html, /__KJR_SYNC_PREVIEW_SCENARIO\('queue-long'\)/);
  assert.match(html, /__KJR_SYNC_PREVIEW_SCENARIO\('backfill'\)/);
  assert.match(html, /id="kjr-sync-preview-restore-ack"/);
  assert.match(html, /scenario === 'restore-ack'/);
  assert.match(html, /Synthetic restore fixture rejects unknown request/);
  assert.match(html, /isLocalhostPreview = function \(\) \{ return false; \}/);
  assert.match(html, /isLocalhostPreview = function \(\) \{ return true; \}/);
  assert.match(html, /window\.fetch = originalFetch/);
});

test('sync preview serves only loopback assets and rejects writes', () => {
  assert.equal(preview.HOST, '127.0.0.1');
  const page = fakeResponse();
  preview.handleRequest({ method: 'GET', url: '/?scenario=restore-ack' }, page);
  assert.equal(page.status, 200);
  assert.match(page.headers['Content-Security-Policy'], /connect-src 'self'/);

  const unknown = fakeResponse();
  preview.handleRequest({ method: 'GET', url: '/private-data.json' }, unknown);
  assert.equal(unknown.status, 404);

  const post = fakeResponse();
  preview.handleRequest({ method: 'POST', url: '/' }, post);
  assert.equal(post.status, 405);
  assert.equal(post.headers.Allow, 'GET, HEAD');
});

test('restore acknowledgement bootstrap seeds one synthetic Trash row and tombstone', () => {
  const fixture = runBootstrap();
  assert.equal(fixture.button.hidden, false);
  assert.equal(typeof fixture.window.__KJR_SYNC_PREVIEW_RESTORE_ACK, 'function');
  const trash = JSON.parse(fixture.values.get('_kjrLocalTrash'));
  const tombstones = JSON.parse(fixture.values.get('_kjrServerTombstonesV1'));
  assert.deepEqual(trash.map(entry => entry.id), ['sync-preview-restore-trash']);
  assert.deepEqual(tombstones.map(entry => entry.id), ['sync-preview-restore-card']);
  assert.equal(JSON.parse(fixture.values.get('pokeinventory_v3')).singles.length, 0);
});

test('sync preview queue layout fixtures are synthetic and bounded for browser review', () => {
  const pending = runBootstrap('pending');
  const pendingSeed = JSON.parse(pending.values.get('pokeinventory_v3'));
  assert.equal(pendingSeed.singles.length, 125);
  assert.equal(pendingSeed.singles[0].name.length, 120);

  const many = runBootstrap('queue-many');
  const manySeed = JSON.parse(many.values.get('pokeinventory_v3'));
  const manyDirty = JSON.parse(many.values.get('pokeinv_dirty_v1'));
  assert.equal(manySeed.singles.length, 125);
  assert.equal(manyDirty.singles.length, 125);

  const long = runBootstrap('queue-long');
  const longSeed = JSON.parse(long.values.get('pokeinventory_v3'));
  assert.equal(longSeed.singles.length, 4);
  assert.ok(longSeed.singles.every(row => row.name.length > 300));

  const backfill = runBootstrap('backfill');
  const backfillSeed = JSON.parse(backfill.values.get('pokeinventory_v3'));
  assert.equal(backfillSeed.singles.length, 3);
  assert.equal(backfillSeed.sales.length, 3);
  assert.equal(backfill.values.get('pokeinv_dirty_v1'), JSON.stringify({ singles: [], sales: [] }));
});
