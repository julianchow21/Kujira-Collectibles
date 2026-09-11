'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT, jsonResponse, syncPullResponse } = require('./harness.js');

const AUTH_STATES = [
  'kjr-auth-loading', 'kjr-auth-form', 'kjr-auth-sent', 'kjr-auth-error',
  'kjr-auth-expired', 'kjr-auth-recover-form', 'kjr-auth-recover-sent',
  'kjr-auth-recover-error', 'kjr-auth-recovery-form',
  'kjr-auth-recovery-expired', 'kjr-auth-recovery-error',
];

function authApp(options) {
  return loadApp({ seed: null, authenticated: false, authGate: true, ...(options || {}) });
}

function visibleState(document) {
  const gate = document.getElementById('kjr-auth-gate');
  if (gate && gate.hidden) return null;
  return AUTH_STATES.find(id => document.getElementById(id).hidden === false) || null;
}

function localValue(app, key) {
  return app.localStorage.getItem(key);
}

function localValues(app) {
  return Array.from(app.localStorage._store.values());
}

function assertNoSecret(app, secret) {
  assert.equal(localValues(app).some(value => String(value).includes(secret)), false);
}

function recoveryCallback(options) {
  const now = Math.floor(Date.now() / 1000);
  const values = {
    access_token: 'recovery-access-token',
    refresh_token: 'recovery-refresh-token',
    expires_at: String(now + 3600),
    type: 'recovery',
    ...(options || {}),
  };
  return new URLSearchParams(values).toString();
}

function routeDbFallback(fetchMock) {
  fetchMock.route('/db/rest/v1/', { status: 200, json: [] });
}

function routePull(fetchMock, response) {
  fetchMock.route('/sync/v2/pull', response || (() => syncPullResponse()));
}

function routeUser(fetchMock, userId) {
  fetchMock.route('/auth/v1/user', () => jsonResponse({ id: userId || 'owner-id' }));
}

function tokenBody(userId, expiresIn) {
  return {
    access_token: 'owner-access-token',
    refresh_token: 'owner-refresh-token',
    expires_in: expiresIn === undefined ? 3600 : expiresIn,
    user: { id: userId || 'owner-id' },
  };
}

async function bootRecovery(app, userId) {
  routeUser(app.fetchMock, userId || 'owner-id');
  app.sessionStorage.setItem('_kjrAuthCallback', recoveryCallback());
  const result = await app.ctx.kjrAuthBoot();
  await app.settle(3);
  return result;
}

test('auth-owner: password-first form uses native username and current-password fields', () => {
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  assert.match(html, /onsubmit="kjrSignIn\(event\)"/);
  assert.match(html, /id="kjr-auth-email"[^>]*autocomplete="username"/);
  assert.match(html, /id="kjr-auth-password"[^>]*autocomplete="current-password"/);
  assert.doesNotMatch(html, /id="kjr-auth-magic"/);
  assert.match(html, /Set or reset password/);
});

test('auth-owner: magic-link request forbids account creation for outstanding links', async () => {
  const { ctx, document, fetchMock } = await authApp();
  document.getElementById('kjr-auth-email').value = 'owner@example.test';
  fetchMock.calls.length = 0;
  fetchMock.route('/auth/v1/otp', { ok: true, status: 200, json: {} });
  await ctx.kjrRequestMagicLink({ preventDefault() {} });
  const call = fetchMock.calls.find(item => item.url.includes('/auth/v1/otp'));
  assert.ok(call);
  assert.deepEqual(JSON.parse(call.opts.body), { email: 'owner@example.test', create_user: false });
  assert.match(call.url, /redirect_to=https%3A%2F%2Fjulianchow21\.github\.io%2FKujira-Collectibles%2F/);
});

test('auth-owner: password sign-in validates owner, pulls before persistence, and clears password', async () => {
  const app = await authApp();
  routeDbFallback(app.fetchMock);
  app.fetchMock.route('/auth/v1/token?grant_type=password', () => jsonResponse(tokenBody()));
  routeUser(app.fetchMock, 'owner-id');
  let releasePull;
  app.fetchMock.route('/sync/v2/pull', () => new Promise(resolve => { releasePull = resolve; }));

  const email = app.document.getElementById('kjr-auth-email');
  const password = app.document.getElementById('kjr-auth-password');
  email.value = 'owner@example.test';
  password.value = 'correct horse battery staple';
  const signIn = app.ctx.kjrSignIn({ preventDefault() {} });
  await app.settle(4);
  assert.equal(typeof releasePull, 'function');
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);
  assert.equal(localValue(app, '_kjrOwnerVerifiedV1'), null);
  assert.equal(app.document.getElementById('kjr-auth-gate').hidden, false);

  releasePull(syncPullResponse({ singles: [{ id: 'owner-row', data: { name: 'Owner row' }, row_version: 1, updated_at: '2026-09-10T00:00:00.000Z' }] }));
  await signIn;
  await app.settle(5);

  const saved = JSON.parse(localValue(app, '_kjrOwnerSessionV1'));
  const marker = JSON.parse(localValue(app, '_kjrOwnerVerifiedV1'));
  assert.equal(saved.user_id, 'owner-id');
  assert.equal(marker.user_id, 'owner-id');
  assert.equal(marker.session_id, saved.session_id);
  assert.equal(app.document.getElementById('kjr-auth-gate').hidden, true);
  assert.equal(password.value, '');
  assertNoSecret(app, 'correct horse battery staple');

  const relevant = app.fetchMock.calls.filter(call =>
    call.url.includes('/auth/v1/token?grant_type=password') ||
    call.url.includes('/auth/v1/user') ||
    call.url.includes('/sync/v2/pull'));
  assert.deepEqual(relevant.map(call => [call.opts && call.opts.method || 'GET', call.url.split('/').slice(-1)[0].split('?')[0]]), [
    ['POST', 'token'], ['GET', 'user'], ['POST', 'pull'],
  ]);
});

test('auth-owner: invalid credentials show a generic error and leave no session', async () => {
  const app = await authApp();
  app.fetchMock.route('/auth/v1/token?grant_type=password', jsonResponse({ error: 'invalid_grant' }, 400));
  app.document.getElementById('kjr-auth-email').value = 'owner@example.test';
  app.document.getElementById('kjr-auth-password').value = 'wrong-password';
  await app.ctx.kjrSignIn({ preventDefault() {} });
  assert.equal(visibleState(app.document), 'kjr-auth-error');
  assert.match(app.document.getElementById('kjr-auth-error-copy').textContent, /email and password/);
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);
  assert.equal(localValue(app, '_kjrOwnerVerifiedV1'), null);
  assert.equal(app.document.getElementById('kjr-auth-password').value, '');
  assert.equal(app.fetchMock.calls.some(call => call.url.includes('/auth/v1/user')), false);
  assert.equal(app.fetchMock.calls.some(call => call.url.includes('/sync/v2/pull')), false);
});

test('auth-owner: malformed password token body is rejected without a default expiry', async () => {
  const cases = [
    { access_token: 'a', refresh_token: 'r', user: { id: 'owner-id' } },
    { access_token: 'a', refresh_token: 'r', expires_in: 0, user: { id: 'owner-id' } },
    { access_token: 'a', refresh_token: 'r', expires_in: 3600, user: { id: ' ' } },
    { access_token: 'a', refresh_token: 'r', expires_in: 3600 },
  ];
  for (const body of cases) {
    const app = await authApp();
    app.fetchMock.route('/auth/v1/token?grant_type=password', jsonResponse(body));
    app.document.getElementById('kjr-auth-email').value = 'owner@example.test';
    app.document.getElementById('kjr-auth-password').value = 'candidate-secret';
    await app.ctx.kjrSignIn({ preventDefault() {} });
    assert.equal(visibleState(app.document), 'kjr-auth-error');
    assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);
    assert.equal(localValue(app, '_kjrOwnerVerifiedV1'), null);
    assert.equal(app.fetchMock.calls.some(call => call.url.includes('/auth/v1/user')), false);
    assert.equal(app.fetchMock.calls.some(call => call.url.includes('/sync/v2/pull')), false);
    assertNoSecret(app, 'candidate-secret');
  }
});

test('auth-owner: Worker owner denial never opens collection or persists a session', async () => {
  const app = await authApp();
  routeDbFallback(app.fetchMock);
  app.fetchMock.route('/auth/v1/token?grant_type=password', () => jsonResponse(tokenBody()));
  routeUser(app.fetchMock, 'owner-id');
  app.fetchMock.route('/sync/v2/pull', jsonResponse({ error: 'forbidden' }, 403));
  app.document.getElementById('kjr-auth-email').value = 'other@example.test';
  app.document.getElementById('kjr-auth-password').value = 'candidate-secret';
  await app.ctx.kjrSignIn({ preventDefault() {} });
  assert.equal(visibleState(app.document), 'kjr-auth-expired');
  assert.equal(app.document.getElementById('kjr-auth-gate').hidden, false);
  assert.equal(app.grab('_kjrAuthSession')._kjrAuthSession, null);
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);
  assert.equal(localValue(app, '_kjrOwnerVerifiedV1'), null);
  assert.equal(app.grab('DB').DB.singles.length, 0);
  assertNoSecret(app, 'candidate-secret');
});

test('auth-owner: duplicate sign-in is ignored and cancellation invalidates the late token response', async () => {
  const app = await authApp();
  let release;
  app.fetchMock.route('/auth/v1/token?grant_type=password', () => new Promise(resolve => { release = resolve; }));
  app.document.getElementById('kjr-auth-email').value = 'owner@example.test';
  app.document.getElementById('kjr-auth-password').value = 'late-secret';
  const first = app.ctx.kjrSignIn({ preventDefault() {} });
  const second = app.ctx.kjrSignIn({ preventDefault() {} });
  await second;
  assert.equal(app.fetchMock.calls.filter(call => call.url.includes('/auth/v1/token?grant_type=password')).length, 1);
  app.ctx.kjrCancelAuthFlow({ preventDefault() {} });
  release(jsonResponse(tokenBody()));
  await first;
  await app.settle(3);
  assert.equal(visibleState(app.document), 'kjr-auth-form');
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);
  assert.equal(localValue(app, '_kjrOwnerVerifiedV1'), null);
  assert.equal(app.document.getElementById('kjr-auth-password').value, '');
  assert.equal(app.fetchMock.calls.some(call => call.url.includes('/auth/v1/user')), false);
  assert.equal(app.fetchMock.calls.some(call => call.url.includes('/sync/v2/pull')), false);
});

test('auth-owner: reset request sends the exact redirect and has a distinct transport error state', async () => {
  const app = await authApp();
  app.ctx.kjrShowPasswordRecovery();
  app.document.getElementById('kjr-auth-recover-email').value = 'owner@example.test';
  app.fetchMock.route('/auth/v1/recover', jsonResponse({}));
  await app.ctx.kjrRequestPasswordReset({ preventDefault() {} });
  const call = app.fetchMock.calls.find(item => item.url.includes('/auth/v1/recover'));
  assert.ok(call);
  assert.deepEqual(JSON.parse(call.opts.body), { email: 'owner@example.test' });
  assert.match(call.url, /redirect_to=https%3A%2F%2Fjulianchow21\.github\.io%2FKujira-Collectibles%2F/);
  assert.equal(visibleState(app.document), 'kjr-auth-recover-sent');

  const failed = await authApp();
  failed.ctx.kjrShowPasswordRecovery();
  failed.document.getElementById('kjr-auth-recover-email').value = 'owner@example.test';
  failed.fetchMock.reject('/auth/v1/recover', new TypeError('offline'));
  await failed.ctx.kjrRequestPasswordReset({ preventDefault() {} });
  assert.equal(visibleState(failed.document), 'kjr-auth-recover-error');
  assert.match(failed.document.getElementById('kjr-auth-recover-error-copy').textContent, /password email could not be sent/);
});

test('auth-owner: recovery callback is ephemeral and reload cannot bypass the password form', async () => {
  const app = await authApp({
    localStorage: {
      _kjrOwnerSessionV1: { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 4102444800, user_id: 'owner-id', session_id: 'old-session' },
      _kjrOwnerVerifiedV1: { user_id: 'owner-id', session_id: 'old-session' },
    },
  });
  const boot = await bootRecovery(app, 'owner-id');
  assert.equal(boot, false);
  assert.equal(visibleState(app.document), 'kjr-auth-recovery-form');
  assert.ok(app.grab('_kjrRecoverySession')._kjrRecoverySession);
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);
  assert.equal(localValue(app, '_kjrOwnerVerifiedV1'), null);
  assert.equal(app.sessionStorage.getItem('_kjrAuthCallback'), null);
  assert.equal(app.document.getElementById('kjr-auth-gate').hidden, false);

  const reloaded = await authApp({ localStorage: Object.fromEntries(app.localStorage._store) });
  assert.equal(visibleState(reloaded.document), 'kjr-auth-form');
  assert.equal(reloaded.grab('_kjrRecoverySession')._kjrRecoverySession, null);
  assert.equal(reloaded.document.getElementById('kjr-auth-gate').hidden, false);
  assert.equal(reloaded.fetchMock.calls.some(call => call.url.includes('/auth/v1/user')), false);
});

test('auth-owner: recovery owner check runs before password update and persistence', async () => {
  const app = await authApp();
  await bootRecovery(app, 'owner-id');
  app.fetchMock.calls.length = 0;
  routeDbFallback(app.fetchMock);
  app.fetchMock.route('/auth/v1/user', () => jsonResponse({ id: 'owner-id' }));
  routePull(app.fetchMock);
  app.fetchMock.route('/db/rest/v1/singles?select=id&limit=0', jsonResponse([]));
  app.document.getElementById('kjr-auth-new-password').value = 'new-password-value';
  app.document.getElementById('kjr-auth-confirm-password').value = 'new-password-value';
  await app.ctx.kjrSubmitNewPassword({ preventDefault() {} });
  await app.settle(5);

  const relevant = app.fetchMock.calls.filter(call =>
    call.url.includes('/db/rest/v1/singles?select=id&limit=0') ||
    call.url.includes('/auth/v1/user') || call.url.includes('/sync/v2/pull'));
  assert.equal(relevant[0].opts.method, 'GET');
  assert.match(relevant[0].url, /select=id&limit=0/);
  assert.equal(relevant[1].opts.method, 'PUT');
  assert.equal(JSON.parse(relevant[1].opts.body).password, 'new-password-value');
  assert.equal(relevant[2].opts.method || 'GET', 'GET');
  assert.equal(relevant[3].opts.method, 'POST');
  assert.equal(visibleState(app.document), null);
  assert.equal(app.document.getElementById('kjr-auth-gate').hidden, true);
  const saved = JSON.parse(localValue(app, '_kjrOwnerSessionV1'));
  assert.equal(saved.user_id, 'owner-id');
  assert.equal(app.grab('_kjrRecoverySession')._kjrRecoverySession, null);
  assert.equal(app.document.getElementById('kjr-auth-new-password').value, '');
  assert.equal(app.document.getElementById('kjr-auth-confirm-password').value, '');
  assertNoSecret(app, 'new-password-value');
});

test('auth-owner: recovery owner denial blocks PUT and clears transient auth state', async () => {
  const app = await authApp();
  await bootRecovery(app, 'other-id');
  app.fetchMock.calls.length = 0;
  app.fetchMock.route('/db/rest/v1/singles?select=id&limit=0', jsonResponse({ error: 'forbidden' }, 403));
  app.document.getElementById('kjr-auth-new-password').value = 'new-password-value';
  app.document.getElementById('kjr-auth-confirm-password').value = 'new-password-value';
  await app.ctx.kjrSubmitNewPassword({ preventDefault() {} });
  assert.equal(visibleState(app.document), 'kjr-auth-error');
  assert.equal(app.fetchMock.calls.some(call => call.opts && call.opts.method === 'PUT'), false);
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);
  assert.equal(localValue(app, '_kjrOwnerVerifiedV1'), null);
  assert.equal(app.grab('_kjrRecoverySession')._kjrRecoverySession, null);
  assertNoSecret(app, 'new-password-value');
});

test('auth-owner: recovery mismatch and transient verification preserve only the in-memory token for retry', async () => {
  const mismatch = await authApp();
  await bootRecovery(mismatch, 'owner-id');
  mismatch.document.getElementById('kjr-auth-new-password').value = 'one-password';
  mismatch.document.getElementById('kjr-auth-confirm-password').value = 'other-password';
  await mismatch.ctx.kjrSubmitNewPassword({ preventDefault() {} });
  assert.equal(visibleState(mismatch.document), 'kjr-auth-recovery-error');
  assert.ok(mismatch.grab('_kjrRecoverySession')._kjrRecoverySession);
  assert.equal(mismatch.document.getElementById('kjr-auth-new-password').value, '');
  assert.equal(mismatch.document.getElementById('kjr-auth-confirm-password').value, '');
  mismatch.ctx.kjrRetryRecovery();
  assert.equal(visibleState(mismatch.document), 'kjr-auth-recovery-form');

  const transient = await authApp();
  await bootRecovery(transient, 'owner-id');
  transient.fetchMock.reject('/db/rest/v1/singles?select=id&limit=0', new TypeError('offline'));
  transient.document.getElementById('kjr-auth-new-password').value = 'new-password-value';
  transient.document.getElementById('kjr-auth-confirm-password').value = 'new-password-value';
  await transient.ctx.kjrSubmitNewPassword({ preventDefault() {} });
  assert.equal(visibleState(transient.document), 'kjr-auth-recovery-error');
  assert.ok(transient.grab('_kjrRecoverySession')._kjrRecoverySession);
  assert.equal(transient.fetchMock.calls.some(call => call.opts && call.opts.method === 'PUT'), false);
  transient.ctx.kjrRetryRecovery();
  assert.equal(visibleState(transient.document), 'kjr-auth-recovery-form');
  assertNoSecret(transient, 'new-password-value');

  const updateFailure = await authApp();
  await bootRecovery(updateFailure, 'owner-id');
  routeDbFallback(updateFailure.fetchMock);
  updateFailure.fetchMock.route('/db/rest/v1/singles?select=id&limit=0', jsonResponse([]));
  updateFailure.fetchMock.route('/auth/v1/user', (_, options) =>
    options && options.method === 'PUT' ? jsonResponse({ error: 'temporary' }, 503) : jsonResponse({ id: 'owner-id' }));
  updateFailure.document.getElementById('kjr-auth-new-password').value = 'new-password-value';
  updateFailure.document.getElementById('kjr-auth-confirm-password').value = 'new-password-value';
  await updateFailure.ctx.kjrSubmitNewPassword({ preventDefault() {} });
  assert.equal(visibleState(updateFailure.document), 'kjr-auth-recovery-error');
  assert.ok(updateFailure.grab('_kjrRecoverySession')._kjrRecoverySession);
  assert.equal(localValue(updateFailure, '_kjrOwnerSessionV1'), null);
  assert.equal(localValue(updateFailure, '_kjrOwnerVerifiedV1'), null);
  assertNoSecret(updateFailure, 'new-password-value');
});

test('auth-owner: expired recovery callback clears an old owner marker without validating bearer', async () => {
  const app = await authApp({
    localStorage: {
      _kjrOwnerSessionV1: { access_token: 'old-access', refresh_token: 'old-refresh', expires_at: 4102444800, user_id: 'owner-id', session_id: 'old-session' },
      _kjrOwnerVerifiedV1: { user_id: 'owner-id', session_id: 'old-session' },
    },
  });
  app.fetchMock.calls.length = 0;
  app.sessionStorage.setItem('_kjrAuthCallback', recoveryCallback({ expires_at: String(Math.floor(Date.now() / 1000) - 1) }));
  const boot = await app.ctx.kjrAuthBoot();
  assert.equal(boot, false);
  assert.equal(visibleState(app.document), 'kjr-auth-recovery-expired');
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);
  assert.equal(localValue(app, '_kjrOwnerVerifiedV1'), null);
  assert.equal(app.fetchMock.calls.some(call => call.url.includes('/auth/v1/user')), false);
});

test('auth-owner: stale recovery callback cannot overwrite a newer cancelled sign-in', async () => {
  const app = await authApp();
  app.sessionStorage.setItem('_kjrAuthCallback', recoveryCallback());
  let releaseOldValidation;
  let userCalls = 0;
  app.fetchMock.route('/auth/v1/user', () => {
    userCalls += 1;
    if (userCalls === 1) return new Promise(resolve => { releaseOldValidation = resolve; });
    return jsonResponse({ id: 'owner-id' });
  });
  const oldBoot = app.ctx.kjrAuthBoot();
  await app.settle(3);
  assert.equal(typeof releaseOldValidation, 'function');

  app.ctx.kjrCancelAuthFlow({ preventDefault() {} });
  routeDbFallback(app.fetchMock);
  app.fetchMock.route('/auth/v1/token?grant_type=password', () => jsonResponse(tokenBody()));
  routePull(app.fetchMock);
  app.document.getElementById('kjr-auth-email').value = 'owner@example.test';
  app.document.getElementById('kjr-auth-password').value = 'new-signin-secret';
  const newSignIn = app.ctx.kjrSignIn({ preventDefault() {} });
  await newSignIn;
  assert.equal(app.document.getElementById('kjr-auth-gate').hidden, true);
  const persistedBeforeOldResponse = localValue(app, '_kjrOwnerSessionV1');
  assert.ok(persistedBeforeOldResponse);

  releaseOldValidation(jsonResponse({ id: 'other-id' }));
  await oldBoot;
  await app.settle(3);
  assert.equal(app.document.getElementById('kjr-auth-gate').hidden, true);
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), persistedBeforeOldResponse);
  assert.equal(visibleState(app.document), null);
  assertNoSecret(app, 'new-signin-secret');
});

test('auth-owner: malformed and replayed callbacks are consumed without bearer persistence', async () => {
  const app = await authApp();
  app.sessionStorage.setItem('_kjrAuthCallback', 'access_token=a&expires_in=3600&type=recovery');
  assert.equal(app.ctx._kjrSessionFromCallback(), null);
  assert.equal(app.sessionStorage.getItem('_kjrAuthCallback'), null);
  assert.equal(app.grab('_kjrAuthCallbackFailed')._kjrAuthCallbackFailed, true);
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);

  app.sessionStorage.setItem('_kjrAuthCallback', 'access_token=a&refresh_token=r&expires_in=3600&type=magiclink');
  const magic = app.ctx._kjrSessionFromCallback();
  assert.equal(magic.access_token, 'a');
  assert.equal(app.sessionStorage.getItem('_kjrAuthCallback'), null);
  assert.equal(app.ctx._kjrSessionFromCallback(), null);

  app.sessionStorage.setItem('_kjrAuthCallback', recoveryCallback());
  const recovery = app.ctx._kjrSessionFromCallback();
  assert.equal(recovery.access_token, 'recovery-access-token');
  assert.equal(app.sessionStorage.getItem('_kjrAuthCallback'), null);
  assert.equal(localValue(app, '_kjrOwnerSessionV1'), null);
  assert.equal(localValue(app, '_kjrOwnerVerifiedV1'), null);

  const storageFailure = await authApp();
  const raw = recoveryCallback();
  storageFailure.sessionStorage.setItem('_kjrAuthCallback', raw);
  storageFailure.sessionStorage.removeItem = () => { throw new Error('storage blocked'); };
  assert.ok(storageFailure.ctx._kjrSessionFromCallback());
  assert.equal(storageFailure.ctx._kjrSessionFromCallback(), null);
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

test('auth-owner: callback accepts legacy magiclink and recovery types, then consumes each once', async () => {
  const app = await authApp();
  app.sessionStorage.setItem('_kjrAuthCallback', 'access_token=a&refresh_token=r&expires_in=3600&type=magiclink');
  const magic = app.ctx._kjrSessionFromCallback();
  assert.equal(magic.access_token, 'a');
  assert.equal(app.sessionStorage.getItem('_kjrAuthCallback'), null);
  app.sessionStorage.setItem('_kjrAuthCallback', recoveryCallback());
  const recovery = app.ctx._kjrSessionFromCallback();
  assert.equal(recovery.access_token, 'recovery-access-token');
  assert.equal(app.sessionStorage.getItem('_kjrAuthCallback'), null);
  assert.equal(app.ctx._kjrSessionFromCallback(), null);
});
