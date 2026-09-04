'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT } = require('./harness.js');

function memoryStorage(seed) {
  const values = new Map(Object.entries(seed || {}));
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}

test('auth-owner: pre-paint gate sanitises token and error callback fragments from browser history', () => {
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  assert.match(html, /document\.documentElement\.classList\.add\('auth-gated'\)/);
  assert.match(html, /access_token\|error\|error_description/);
  assert.match(html, /sessionStorage\.setItem\('_kjrAuthCallback',h\)/);
  assert.match(html, /history\.replaceState\(null,'',location\.pathname\+location\.search\)/);
});

test('auth-owner: magic-link request forbids account creation', async () => {
  const { ctx, document, fetchMock } = await loadApp();
  document.getElementById('kjr-auth-email').value = 'owner@example.test';
  fetchMock.calls.length = 0;
  fetchMock.route('/auth/v1/otp', { ok: true, status: 200, json: {} });
  await ctx.kjrRequestMagicLink({ preventDefault() {} });
  const body = JSON.parse(fetchMock.calls.find(call => call.url.includes('/auth/v1/otp')).opts.body);
  assert.deepStrictEqual(body, { email: 'owner@example.test', create_user: false });
});

test('auth-owner: refresh is single-flight and local-scope logout clears owner data', async () => {
  const { ctx, fetchMock, grab } = await loadApp();
  const expired = { access_token: 'old', refresh_token: 'refresh', expires_at: 1 };
  let release;
  fetchMock.calls.length = 0;
  fetchMock.route('/auth/v1/token', () => new Promise(resolve => { release = resolve; }));
  const first = ctx._kjrRefreshSession(expired);
  const second = ctx._kjrRefreshSession(expired);
  assert.strictEqual(first, second);
  assert.strictEqual(fetchMock.calls.filter(call => call.url.includes('/auth/v1/token')).length, 1);
  release({ ok: true, status: 200, json: async () => ({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 }) });
  await first;

  ctx._kjrSaveSession({ access_token: 'new', refresh_token: 'new-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600 });
  fetchMock.route('/auth/v1/logout?scope=local', { ok: true, status: 204, json: {} });
  await ctx.kjrSignOut();
  assert.ok(fetchMock.calls.some(call => call.url.includes('/auth/v1/logout?scope=local')));
  assert.strictEqual(grab('_kjrAuthSession')._kjrAuthSession, null);
  assert.strictEqual(grab('DB').DB.singles.length, 0);
});

test('auth-owner: callback is consumed once and requires magiclink type', async () => {
  const { ctx, sandbox } = await loadApp();
  sandbox.sessionStorage = memoryStorage({ _kjrAuthCallback: 'access_token=a&refresh_token=r&expires_in=3600&type=magiclink' });
  const session = ctx._kjrSessionFromCallback();
  assert.strictEqual(session.access_token, 'a');
  assert.strictEqual(sandbox.sessionStorage.getItem('_kjrAuthCallback'), null);
  sandbox.sessionStorage.setItem('_kjrAuthCallback', 'access_token=a&refresh_token=r&type=recovery');
  assert.strictEqual(ctx._kjrSessionFromCallback(), null);
});
