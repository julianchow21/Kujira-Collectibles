'use strict';
// The browser fixtures (tests/*.cjs) serve the self-hosted Geist faces. styles.css asks for Assets/fonts/*.woff2 and index.html preloads
// the sans, so a fixture that did not serve them rendered in the fallback stack and logged a failed preload. Each fixture answers both
// files with font/woff2, the page it serves allows fonts from its own origin only, and no fixture names Google Fonts any more.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FONTS = ['Geist-Variable.woff2', 'GeistMono-Variable.woff2'];
// [file, the path its page is served from]
const FIXTURES = [
  ['preview-server.cjs', '/'],
  ['sync-preview.cjs', '/'],
  ['dealer-preview.cjs', '/'],
  ['dealer-production-preview.cjs', '/'],
  ['ebay-date-preview.cjs', '/'],
  ['password-preview.cjs', '/auth-preview.html'],
];

function call(fixture, method, url) {
  const res = {
    status: 0, headers: {}, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
    end(body) { this.body = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body)); },
  };
  fixture.handleRequest({ method, url, headers: {} }, res);
  return res;
}

test('fixtures: every preview server answers both Geist files with font/woff2 and the exact bytes, for GET and HEAD', () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'Assets/fonts')).filter(f => f.endsWith('.woff2')).sort(), [...FONTS].sort(), 'the two files the fixtures list are all there is');
  for (const [file] of FIXTURES) {
    const fixture = require('./' + file);
    for (const font of FONTS) {
      const bytes = fs.readFileSync(path.join(ROOT, 'Assets/fonts', font));
      const got = call(fixture, 'GET', '/Assets/fonts/' + font + '?v=1');
      assert.equal(got.status, 200, file + ' serves ' + font);
      assert.equal(got.headers['Content-Type'], 'font/woff2', file + ': ' + font + ' has the font type');
      assert.equal(got.headers['Content-Length'], bytes.length, file + ': ' + font + ' length');
      assert.equal(got.headers['X-Content-Type-Options'], 'nosniff', file + ': still nosniff');
      assert.ok(got.body && got.body.equals(bytes), file + ': ' + font + ' is the file on disk');
      assert.equal(got.body.subarray(0, 4).toString('latin1'), 'wOF2');
      const head = call(fixture, 'HEAD', '/Assets/fonts/' + font);
      assert.equal(head.status, 200, file + ': HEAD ' + font);
      assert.equal(head.headers['Content-Type'], 'font/woff2');
      assert.equal(head.body, null, file + ': HEAD sends no body');
    }
    // the allowlist still holds: a font that is not in it, the licence and a path out of the folder are refused
    for (const url of ['/Assets/fonts/Missing.woff2', '/Assets/fonts/OFL.txt', '/Assets/fonts/../../package.json']) {
      const got = call(fixture, 'GET', url);
      assert.ok(got.status === 404 || got.status === 403, file + ' refuses ' + url + ' (got ' + got.status + ')');
    }
  }
});

test('fixtures: the page each one serves allows fonts and styles from its own origin only, with no Google Fonts host', () => {
  for (const [file, page] of FIXTURES) {
    const fixture = require('./' + file);
    const got = call(fixture, 'GET', page);
    assert.equal(got.status, 200, file + ' serves its page at ' + page);
    const csp = got.headers['Content-Security-Policy'] || '';
    assert.match(csp, /(?:^|; )font-src 'self'(?:;|$)/, file + ': font-src is self and nothing else');
    assert.match(csp, /(?:^|; )style-src 'self' 'unsafe-inline'(?:;|$)/, file + ': style-src names no other host');
    assert.doesNotMatch(csp, /googleapis|gstatic|https:/, file + ': no remote host in the policy');
    // the preload the real index carries survives the fixture's link stripping, and it points at a file the fixture serves
    const body = got.body.toString('utf8');
    assert.match(body, /<link rel="preload" href="Assets\/fonts\/Geist-Variable\.woff2" as="font" type="font\/woff2" crossorigin>/, file + ': the sans preload is kept');
    assert.doesNotMatch(body, /<link[^>]+href="https?:\/\/fonts\./, file + ': no remote font link in the served page');
  }
});

test('fixtures: no fixture source mentions Google Fonts in a comment, a policy, a regex or a log line', () => {
  for (const [file] of FIXTURES) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.doesNotMatch(src, /google\s*fonts|googleapis|gstatic/i, file);
  }
  const sync = fs.readFileSync(path.join(__dirname, 'sync-preview.cjs'), 'utf8');
  assert.match(sync, /self-hosted Geist fonts from\n\/\/ Assets\/fonts/, 'the header says where the fonts come from now');
  assert.match(sync, /html\.replace\(\/\\s\*<link\\s\+rel="stylesheet"\\s\+href="https\?:\\\/\\\/\[\^\\"\]\+"\[\^>\]\*>\\s\*\/gi, '\\n'\);/, 'every remote stylesheet is stripped, with no exception for one host');
});
