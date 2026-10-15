'use strict';
// v3.77: the Quick Sale fixture (tests/preview-server.cjs) serves the real index.html, which loads seven scripts, but its route table only
// had app.js and features.js, so a browser pass over it logged five 404s for the Dealer Desk scripts (dealer-money, dealer-desk, dealer-ui,
// dealer-store, dealer-production-ui). The eBay date fixture and the Dealer Desk fixture borrow its route table, so they 404ed the same way.
// Every local script, stylesheet, preload, manifest and icon the served page names must now answer 200 with the file's exact bytes, and the
// table is still an allowlist.
// v3.78: the Cloud Sync diagnostics fixture (sync-preview.cjs) and the password fixture (password-preview.cjs) keep route tables of their own and
// had the same five 404s (the password one had no /sw.js either), so both are pinned here too.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
// [file, the path its page is served from]: the first three serve the index through preview-server.cjs's route table, the last two keep their own
const FIXTURES = [
  ['preview-server.cjs', '/'],
  ['ebay-date-preview.cjs', '/'],
  ['dealer-preview.cjs', '/'],
  ['sync-preview.cjs', '/'],
  ['password-preview.cjs', '/auth-preview.html'],
];
const DEALER_SCRIPTS = ['dealer-money.js', 'dealer-desk.js', 'dealer-ui.js', 'dealer-store.js', 'dealer-production-ui.js'];

function call(fixture, method, url) {
  const res = {
    status: 0, headers: {}, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
    end(body) { this.body = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body)); },
  };
  fixture.handleRequest({ method, url, headers: {} }, res);
  return res;
}

// every local file the page asks for: scripts, stylesheets, preloads, the manifest and the icons (remote ones are stripped by the fixture)
function localRefs(html) {
  const refs = new Set();
  for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/gi)) refs.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*\bhref="([^"]+)"/gi)) refs.add(m[1]);
  return [...refs].filter((r) => !/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(r) && !/^(?:data|blob|javascript):/i.test(r) && !r.startsWith('#'));
}

for (const [file, page] of FIXTURES) {
  test(`${file}: the page it serves loads with no 404, every local script and stylesheet answers 200 with the file's exact bytes`, () => {
    const fixture = require('./' + file);
    const home = call(fixture, 'GET', page);
    assert.equal(home.status, 200);
    const refs = localRefs(home.body.toString('utf8'));
    const names = refs.map((r) => r.replace(/[?#].*$/, ''));
    for (const script of DEALER_SCRIPTS) assert.ok(names.includes(script), `index.html still loads ${script}, so this test is not vacuous`);
    assert.ok(names.includes('app.js') && names.includes('features.js') && names.includes('styles.css'));
    const missing = [];
    for (const ref of refs) {
      const got = call(fixture, 'GET', '/' + ref.replace(/^\.?\//, ''));
      if (got.status !== 200) { missing.push(ref + ' -> ' + got.status); continue; }
      const onDisk = fs.readFileSync(path.join(ROOT, ref.replace(/[?#].*$/, '')));
      assert.ok(got.body && got.body.equals(onDisk), `${file} serves ${ref} as the file on disk`);
      if (/\.js$/.test(ref.replace(/[?#].*$/, ''))) assert.match(got.headers['Content-Type'], /^text\/javascript/, ref);
      assert.equal(got.headers['X-Content-Type-Options'], 'nosniff', ref);
    }
    assert.deepEqual(missing, [], `${file} 404s on assets its own page loads`);
    // the page registers sw.js from script and no tag names it, so it is checked by name
    const sw = call(fixture, 'GET', '/sw.js');
    assert.equal(sw.status, 200, `${file} serves /sw.js`);
    assert.ok(sw.body && sw.body.equals(fs.readFileSync(path.join(ROOT, 'sw.js'))), `${file} serves /sw.js as the file on disk`);
  });
}

test('preview-server.cjs: the five Dealer Desk scripts are served for GET and HEAD, and the route table is still an allowlist', () => {
  const fixture = require('./preview-server.cjs');
  for (const script of DEALER_SCRIPTS) {
    const bytes = fs.readFileSync(path.join(ROOT, script));
    const get = call(fixture, 'GET', '/' + script + '?v=3.78');
    assert.equal(get.status, 200, script);
    assert.equal(get.headers['Content-Length'], bytes.length, script);
    assert.equal(get.headers['Cache-Control'], 'no-store', script);
    assert.ok(get.body.equals(bytes), script + ' is the file on disk');
    const head = call(fixture, 'HEAD', '/' + script);
    assert.equal(head.status, 200, 'HEAD ' + script);
    assert.equal(head.body, null, 'HEAD sends no body');
    const post = call(fixture, 'POST', '/' + script);
    assert.equal(post.status, 405, 'writes are refused');
  }
  // only the five known dealer files were added: near misses, source maps, the Worker and a path out of the folder stay refused
  for (const url of ['/dealer-missing.js', '/dealer-money.js.map', '/dealer-money.js/', '/Dealer.sql', '/Server/worker.js', '/Server/Dealer.sql', '/../package.json', '/%2e%2e/package.json', '/tests/preview-server.cjs']) {
    const got = call(fixture, 'GET', url);
    assert.ok(got.status === 404 || got.status === 403, url + ' refused (got ' + got.status + ')');
  }
});
