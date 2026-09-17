'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadApp, jsonResponse, syncSuccessResponse, syncPullResponse,
} = require('./harness.js');

const ROOT = path.resolve(__dirname, '..');
const LOCALHOST_LOCATION = {
  protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:3816',
  href: 'http://127.0.0.1:3816/', origin: 'http://127.0.0.1:3816',
  pathname: '/', search: '', reload() {}, assign() {}, replace() {},
};

function clearDiagnostics(ctx) {
  ctx._syncDiagnostics.failures = {};
  ctx._syncDiagnostics.successes = { read: null, write: null };
  ctx._syncDiagPersist();
  ctx._syncStatus = 'idle';
}

function snapshotlessMarker(id, token, extra) {
  return { table: 'singles', id, token, owner: 'older-tab', createdAt: 456, ...(extra || {}) };
}

function orphanPull(id, overrides) {
  return async url => {
    if (String(url).includes('/sync/v2/pull')) {
      return syncPullResponse({ ...(overrides || {}), singles: [], trash: [] }, [{
        table: 'singles', id, row_version: 3, deleted_at: '2026-09-04T00:00:00.000Z',
      }]);
    }
    throw new TypeError('offline');
  };
}

test('sync diagnostics: the indicator is a labelled button and input focus has one soft treatment', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<button id="sync-indicator"[^>]*aria-haspopup="dialog"[^>]*aria-controls="sync-diagnostics-overlay"[^>]*aria-expanded="false"/);
  assert.match(html, /<dialog class="overlay" id="sync-diagnostics-overlay"[^>]*aria-labelledby="sync-diagnostics-title"/);
});

test('sync diagnostics: technical text is bounded and redacts URLs, credentials and email addresses', async () => {
  const { ctx } = await loadApp({ authenticated: false });
  const input = 'POST https://example.test/rest/v1/singles?select=* Bearer super-secret-token '
    + '{"access_token":"abc123","refresh_token":"refresh-secret","email":"owner@example.test"} '
    + 'x'.repeat(400);
  const safe = ctx._syncDiagSafeText(input, 220);
  assert.ok(safe.length <= 220);
  assert.doesNotMatch(safe, /https?:\/\//i);
  assert.doesNotMatch(safe, /super-secret-token|abc123|refresh-secret|owner@example\.test/);
  assert.match(safe, /URL redacted/);
  assert.match(safe, /Bearer \[redacted\]/);
  assert.match(safe, /\[redacted\]/);
});

test('sync diagnostics: pending work is derived from dirty and recovery queues, with unreadable queues left unknown', async () => {
  const { ctx, localStorage } = await loadApp({
    localStorage: { pokeinv_dirty_v1: { singles: ['single_seed_1'] } },
  });
  localStorage.setItem('_kjrDeleteStateV2', JSON.stringify({
    schema: 2, revision: 'fixture',
    pending: [{ table: 'singles', id: 'delete-1', ts: 1 }], confirmed: [],
  }));
  localStorage.setItem('_kjrPendingTrashWrites', JSON.stringify([{
    id: 'trash-1', data: { originalTable: 'singles', originalId: 'trash-source' },
  }]));
  localStorage.setItem('_kjrMutationGroupV2:fixture', JSON.stringify({
    mutation_id: 'fixture', operations: [{ table: 'slabs', id: 'mutation-1' }],
  }));

  const pending = ctx._syncDiagPendingSnapshot();
  assert.equal(pending.byTable.singles.dirty, 1);
  assert.equal(pending.byTable.singles.delete, 1);
  assert.equal(pending.byTable.singles.trash, 1);
  assert.equal(pending.byTable.slabs.mutation, 1);
  assert.equal(pending.totals.dirty, 1);
  assert.equal(pending.totals.delete, 1);
  assert.equal(pending.totals.trash, 1);
  assert.equal(pending.totals.mutation, 1);
  assert.equal(pending.total, 4);

  localStorage.setItem('_kjrDeleteStateV2', '{not-json');
  const unreadable = ctx._syncDiagPendingSnapshot();
  assert.ok(unreadable.unknown.includes('delete recovery queue'));
  localStorage.setItem('_kjrDeleteStateV2', 'null');
  const nullDeleteState = ctx._syncDiagPendingSnapshot();
  assert.ok(nullDeleteState.unknown.includes('delete recovery queue'));
  localStorage.setItem('_kjrPendingTrashWrites', 'null');
  const nullTrashState = ctx._syncDiagPendingSnapshot();
  assert.ok(nullTrashState.unknown.includes('Trash recovery queue'));
});

test('sync diagnostics: malformed persisted dirty state is surfaced and retry fails closed before network', async () => {
  const { ctx, fetchMock } = await loadApp({
    localStorage: { pokeinv_dirty_v1: 'null' },
  });
  const pending = ctx._syncDiagPendingSnapshot();
  assert.ok(pending.unknown.includes('unsynced changes'));
  ctx.localStorage.setItem('pokeinv_dirty_v2:bad-marker', '{not-json');
  const markerPending = ctx._syncDiagPendingSnapshot();
  assert.ok(markerPending.unknown.includes('sync markers'));
  fetchMock.calls.length = 0;
  await ctx.retrySyncDiagnostics();
  assert.equal(fetchMock.calls.length, 0, 'unknown local recovery state blocks a cloud retry');
  assert.equal(ctx._syncStatus, 'error');
});

test('sync diagnostics: a repaired parseable empty state can clear its current warning, while ambiguous startup bytes stay blocked', async () => {
  const repaired = await loadApp({ localStorage: { pokeinv_dirty_v1: 'null' } });
  assert.ok(repaired.ctx._syncDiagPendingSnapshot().unknown.includes('unsynced changes'));
  repaired.localStorage.setItem('pokeinv_dirty_v1', '{}');
  assert.ok(!repaired.ctx._syncDiagPendingSnapshot().unknown.includes('unsynced changes'));
  repaired.fetchMock.route('/sync/v2/pull', () => syncPullResponse({}));
  await repaired.ctx.retrySyncDiagnostics();
  assert.ok(repaired.fetchMock.calls.some(call => String(call.url).includes('/sync/v2/pull')),
    'explicit retry proceeds only after current durable state validates');

  const ambiguous = await loadApp({ localStorage: { pokeinv_dirty_v1: '{not-json' } });
  assert.ok(ambiguous.ctx._syncDiagPendingSnapshot().unknown.includes('unsynced changes'));
  ambiguous.localStorage.setItem('pokeinv_dirty_v1', '{}');
  assert.ok(ambiguous.ctx._syncDiagPendingSnapshot().unknown.includes('unsynced changes'),
    'a startup parse failure remains blocked until reload because its lost bytes are unprovable');
});

test('sync diagnostics: post-start malformed nested dirty revisions stay unknown while empty token arrays remain valid', async () => {
  const { ctx, localStorage, fetchMock } = await loadApp({
    localStorage: { pokeinv_dirty_v1: { _revisions: { singles: {} } } },
  });
  localStorage.setItem('pokeinv_dirty_v1', JSON.stringify({ _revisions: { singles: { row_without_token: [] } } }));
  assert.ok(!ctx._syncDiagPendingSnapshot().unknown.includes('unsynced changes'),
    'an empty token array is a valid settled revision record');
  localStorage.setItem('pokeinv_dirty_v1', JSON.stringify({ _revisions: { singles: { malformed_row: 'not-an-array' } } }));
  assert.ok(ctx._syncDiagPendingSnapshot().unknown.includes('unsynced changes'),
    'a nested non-array token record is surfaced after startup');
  fetchMock.calls.length = 0;
  await ctx.retrySyncDiagnostics();
  assert.equal(fetchMock.calls.length, 0, 'malformed nested revision state blocks retry before network');
  assert.equal(ctx._syncStatus, 'error');
});

test('sync diagnostics: orphan cleanup rejects unknown marker fields and key-token mismatches without dropping dirty evidence', async () => {
  const cases = [
    { label: 'unknown field', token: 'older-tab:unknown-field', marker: id => snapshotlessMarker(id, 'older-tab:unknown-field', { rowSnapshot: '{recoverable}' }) },
    { label: 'key-token mismatch', token: 'older-tab:key-mismatch', marker: id => snapshotlessMarker(id, 'different-token') },
  ];
  for (const item of cases) {
    const id = 'orphan_' + item.label.replace(/[^a-z]+/g, '_');
    const markerKey = 'pokeinv_dirty_v2:' + item.token;
    const loaded = await loadApp({
      seed: null,
      fetch: orphanPull(id),
      localStorage: {
        [markerKey]: JSON.stringify(item.marker(id)),
        pokeinv_dirty_v1: JSON.stringify({ singles: [id], _revisions: { singles: { [id]: [item.token] } } }),
      },
    });
    assert.ok(loaded.localStorage.getItem(markerKey), item.label + ' marker remains durable');
    const legacy = JSON.parse(loaded.localStorage.getItem('pokeinv_dirty_v1'));
    assert.ok(legacy.singles.includes(id), item.label + ' legacy dirty id remains queued');
    assert.equal(loaded.grab('_dirty')._dirty.singles.has(id), true, item.label + ' in-memory dirty id remains queued');
  }
});

test('sync diagnostics: orphan cleanup retains a marker when pending or pre-pull local Trash still contains its recovery copy', async () => {
  const cases = [
    {
      label: 'pending Trash',
      localStorage: {
        _kjrPendingTrashWrites: [{ id: 'trash-pending', data: { originalTable: 'singles', originalId: 'orphan_pending_trash', item: { id: 'orphan_pending_trash' } } }],
      },
      seed: null,
    },
    {
      label: 'pre-pull DB Trash',
      localStorage: {
        _kjrLocalTrash: [{ id: 'trash-local', data: { originalTable: 'singles', originalId: 'orphan_pre_pull_trash', item: { id: 'orphan_pre_pull_trash' } } }],
      },
      seed: null,
    },
  ];
  for (const item of cases) {
    const id = item.label === 'pending Trash' ? 'orphan_pending_trash' : 'orphan_pre_pull_trash';
    const token = 'older-tab:' + id;
    const markerKey = 'pokeinv_dirty_v2:' + token;
    const loaded = await loadApp({
      seed: item.seed,
      fetch: orphanPull(id),
      localStorage: {
        ...item.localStorage,
        [markerKey]: JSON.stringify(snapshotlessMarker(id, token)),
        pokeinv_dirty_v1: JSON.stringify({ singles: [id], _revisions: { singles: { [id]: [token] } } }),
      },
    });
    assert.ok(loaded.localStorage.getItem(markerKey), item.label + ' marker remains durable');
    assert.ok(JSON.parse(loaded.localStorage.getItem('pokeinv_dirty_v1')).singles.includes(id),
      item.label + ' dirty evidence remains queued');
  }
});

test('sync diagnostics: a successful write on another row does not erase the retained write failure', async () => {
  const { ctx, fetchMock } = await loadApp();
  clearDiagnostics(ctx);
  const first = { type: 'upsert', table: 'singles', id: 'failed-row', expected_version: 0, data: { name: 'A' } };
  const second = { type: 'upsert', table: 'singles', id: 'healthy-row', expected_version: 0, data: { name: 'B' } };
  fetchMock.route('/sync/v2/mutate', [
    () => jsonResponse({ ok: false, code: 'temporary_failure' }, 500),
    (url, options) => syncSuccessResponse(options),
  ]);
  await assert.rejects(ctx._syncMutate([first], 'mutation-failed'));
  assert.equal(ctx._syncDiagnostics.failures.write.code, 'server_error');
  await ctx._syncMutate([second], 'mutation-healthy');
  assert.ok(ctx._syncDiagnostics.failures.write, 'the earlier failed operation remains visible');
  assert.ok(ctx._syncDiagnostics.successes.write, 'the later acknowledgement still records last confirmed write time');
});

test('sync diagnostics: a successful dirty flush keeps an earlier write failure, then manual retry clears it without changing write time', async () => {
  const row = { id: 'coordinator-row-b', name: 'Synthetic B', status: 'Available' };
  const { ctx, fetchMock, grab } = await loadApp({ seed: { singles: [row] } });
  clearDiagnostics(ctx);
  ctx._syncDiagRecordFailure('write', 'server_error', 'Synthetic earlier write failure');
  const earlierFailure = ctx._syncDiagnostics.failures.write;
  ctx.markDirty('singles', row.id);
  fetchMock.route('/sync/v2/mutate', (url, options) => syncSuccessResponse(options));
  await ctx._flushDirtyToSupabase();
  assert.strictEqual(ctx._syncDiagnostics.failures.write, earlierFailure, 'an unrelated dirty acknowledgement keeps the earlier failure');
  assert.equal(grab('_dirty')._dirty.singles.has(row.id), false, 'the acknowledged row drains normally');

  ctx._syncDiagnostics.successes.write = 123456;
  fetchMock.route('/sync/v2/pull', () => syncPullResponse({
    singles: [{ id: row.id, data: row, row_version: 1, updated_at: '2026-09-16T00:00:00.000Z' }],
  }));
  await ctx.retrySyncDiagnostics();
  assert.equal(ctx._syncDiagnostics.failures.write, undefined, 'a fresh pull with no remaining work clears the old failure');
  assert.equal(ctx._syncDiagnostics.successes.write, 123456, 'clearing a historical failure does not invent a write timestamp');
});

test('sync diagnostics: retry keeps separate read/write failures, then merges a confirmed pull and drains dirty work', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    seed: { singles: [{ id: 'single_seed_1', name: 'Local queued row', status: 'Available' }] },
    localStorage: { pokeinv_dirty_v1: { singles: ['single_seed_1'] } },
  });
  clearDiagnostics(ctx);
  fetchMock.calls.length = 0;
  fetchMock.route('/sync/v2/pull', [
    () => jsonResponse({ code: 'temporary_failure' }, 503),
    () => syncPullResponse({
      singles: [{ id: 'remote-fresh', data: { name: 'Fresh remote row', status: 'Available' }, row_version: 1, updated_at: '2026-09-16T00:00:00.000Z' }],
    }),
  ]);
  fetchMock.route('/sync/v2/mutate', [
    () => jsonResponse({ code: 'busy' }, 429),
    (url, options) => syncSuccessResponse(options),
  ]);

  await ctx.retrySyncDiagnostics();
  assert.equal(ctx._syncDiagnostics.failures.read.code, 'server_error');
  assert.equal(ctx._syncDiagnostics.failures.write.code, 'rate_limited');
  assert.notEqual(ctx._syncStatus, 'saving');
  assert.equal(grab('_dirty')._dirty.singles.has('single_seed_1'), true, 'the failed write remains queued');

  await ctx.retrySyncDiagnostics();
  assert.equal(ctx._syncDiagnostics.failures.read, undefined, 'a confirmed pull clears only the read failure');
  assert.equal(ctx._syncDiagnostics.failures.write, undefined, 'the successful flush clears the recovered write failure');
  assert.equal(grab('_dirty')._dirty.singles.has('single_seed_1'), false, 'the acknowledged dirty row is drained');
  assert.ok(grab('DB').DB.singles.some(row => row.id === 'remote-fresh'), 'the forced pull reaches the visible inventory');
  assert.notEqual(ctx._syncStatus, 'saving');
  assert.equal(ctx._syncDiagIndicatorState(ctx._syncStatus), 'ok');
});

test('sync diagnostics: HTTP response classes remain distinguishable without exposing response bodies', async () => {
  const { ctx } = await loadApp({ authenticated: false });
  assert.equal(ctx._syncDiagCode(ctx._syncDiagResponseFailure(400, { code: 'untrusted_detail' })), 'sync_request_failed');
  assert.equal(ctx._syncDiagCode(ctx._syncDiagResponseFailure(429, { code: 'rate_limited' })), 'rate_limited');
  assert.equal(ctx._syncDiagCode(ctx._syncDiagResponseFailure(503, { code: 'untrusted_detail' })), 'server_error');
  assert.equal(ctx._syncDiagCode(ctx._syncDiagResponseFailure(400, { code: 'server_error' })), 'sync_request_failed');
  assert.equal(ctx._syncDiagCode(ctx._syncDiagResponseFailure(503, { code: 'sync_request_failed' })), 'server_error');
  assert.doesNotMatch(ctx._syncDiagResponseFailure(400, { code: 'Bearer secret-value' }), /secret-value/);
});

test('sync diagnostics: preview retry does not contact the cloud or clear dirty flags', async () => {
  const { ctx, fetchMock, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: { pokeinv_dirty_v1: { singles: ['single_seed_1'] } },
  });
  fetchMock.calls.length = 0;
  await ctx.retrySyncDiagnostics();
  assert.equal(fetchMock.calls.length, 0);
  assert.equal(grab('_dirty')._dirty.singles.has('single_seed_1'), true);
  assert.equal(ctx._syncDiagnostics.failures.read.code, 'preview_disabled');
  assert.notEqual(ctx._syncStatus, 'saving');
});

test('sync diagnostics: a Trash-only recovery queue explains that normal retry cannot resolve it', async () => {
  const { ctx, fetchMock, localStorage, document } = await loadApp({
    localStorage: {
      _kjrPendingTrashWrites: [{
        id: 'trash-only-1',
        data: { originalTable: 'singles', originalId: 'single_seed_1', item: { id: 'single_seed_1' } },
      }],
    },
  });
  clearDiagnostics(ctx);
  ctx._syncDiagRenderBody();
  const problem = ctx._syncDiagProblem(ctx._syncDiagPendingSnapshot());
  assert.equal(problem.retryDisabled, true);
  assert.match(problem.title, /Recovery snapshot needs review/);
  assert.match(problem.remedy, /Automatic retry cannot resolve it/);
  assert.equal(document.getElementById('sync-diagnostics-retry').disabled, true);
  fetchMock.calls.length = 0;
  await ctx.retrySyncDiagnostics();
  assert.equal(fetchMock.calls.length, 0, 'an unretryable Trash-only queue must not trigger a cloud request');
});

test('health: warnings remain visible and the headline cannot claim all checks passed', async () => {
  const { ctx, document } = await loadApp();
  ctx._renderHealthResults([
    { sev: 'warn', area: 'Sync', message: 'Sync pending: 2 rows awaiting upload.', fix: 'Retry when online.', details: [{ label: '[singles] Pending row', table: 'singles', id: 'pending-1' }] },
    { sev: 'warn', area: 'Dates', message: '1 row has a non-canonical date format.', fix: 'Review the date.', details: [] },
    { sev: 'info', area: 'Dashboard', message: 'Expected available cost basis.', fix: '', details: [] },
  ]);
  const html = document.body._lastInsertedHTML || '';
  assert.match(html, /Warnings to review\./);
  assert.match(html, /Warning - review before relying on totals/);
  assert.match(html, /Sync pending: 2 rows awaiting upload/);
  assert.doesNotMatch(html, /All checks passed\./);
  assert.doesNotMatch(html, /always hidden/);
  assert.match(html, /aria-expanded="false" aria-controls="health-detail-0"/);
  assert.doesNotMatch(html, /onclick="healthGotoRow/);
  assert.doesNotMatch(html, /onclick="healthIgnoreFinding/);
});

test('health: an open check re-renders in place without replacing the modal', async () => {
  const { ctx, document } = await loadApp();
  const overlay = document.getElementById('health-overlay');
  let showCalls = 0;
  let closeCalls = 0;
  const showModal = overlay.showModal;
  const close = overlay.close;
  overlay.showModal = function () { showCalls++; return showModal.call(this); };
  overlay.close = function () { closeCalls++; return close.call(this); };

  ctx._renderHealthResults([
    { sev: 'warn', area: 'Sync', message: 'First health result', fix: '', details: [] },
  ]);
  assert.equal(overlay.open, true);
  assert.equal(showCalls, 1);
  assert.equal(closeCalls, 0);
  const firstHtml = overlay.innerHTML;

  ctx._renderHealthResults([
    { sev: 'warn', area: 'Sync', message: 'Second health result', fix: '', details: [] },
  ]);
  assert.strictEqual(document.getElementById('health-overlay'), overlay);
  assert.equal(overlay.open, true);
  assert.equal(showCalls, 1, 'a re-run does not reopen the native dialog');
  assert.equal(closeCalls, 0, 'a re-run does not close the native dialog');
  assert.notEqual(overlay.innerHTML, firstHtml);
  assert.match(overlay.innerHTML, /Second health result/);
});

test('health: data-derived actions use literal datasets and safe row lookup', async () => {
  const { ctx, document, timers } = await loadApp();
  const overlay = document.getElementById('health-overlay');
  overlay.open = true;
  const dangerousTable = "singles');window.__healthPwned=1;//";
  const dangerousId = "row');window.__healthPwned=2;//<script>";
  const finding = {
    sev: 'warn', area: "Sync');window.__healthPwned=4;//", message: "Ignore me');window.__healthPwned=3;//", fix: '',
    details: [
      { label: 'Supported route', table: 'singles', id: dangerousId },
      { label: 'Script-like route', table: dangerousTable, id: dangerousId },
    ],
  };
  const viewButtons = [1, 2].map(() => document.createElement('button'));
  viewButtons[0].dataset.healthTable = 'singles';
  viewButtons[0].dataset.healthId = dangerousId;
  viewButtons[1].dataset.healthTable = dangerousTable;
  viewButtons[1].dataset.healthId = dangerousId;
  const ignoreButton = document.createElement('button');
  ignoreButton.dataset.healthFingerprint = ctx._healthFingerprint(finding);
  overlay.querySelectorAll = selector => {
    if (selector === '[data-health-view="1"]') return viewButtons;
    if (selector === '[data-health-ignore="1"]') return [ignoreButton];
    return [];
  };
  const routes = [];
  const ignored = [];
  const originalHealthGotoRow = ctx.healthGotoRow;
  ctx.healthGotoRow = (...args) => routes.push(args);
  ctx.healthIgnoreFinding = fp => ignored.push(fp);

  ctx._renderHealthResults([finding]);
  const html = overlay.innerHTML;
  assert.doesNotMatch(html, /onclick="healthGotoRow/);
  assert.doesNotMatch(html, /onclick="healthIgnoreFinding/);
  assert.match(html, /data-health-view="1"/);
  assert.match(html, /data-health-ignore="1"/);
  viewButtons[0].dispatchEvent({ type: 'click' });
  viewButtons[1].dispatchEvent({ type: 'click' });
  ignoreButton.dispatchEvent({ type: 'click' });
  assert.deepEqual(routes, [['singles', dangerousId], [dangerousTable, dangerousId]]);
  assert.deepEqual(ignored, [ctx._healthFingerprint(finding)]);

  const row = document.createElement('tr');
  row.setAttribute('data-id', dangerousId);
  const queried = [];
  document.querySelectorAll = selector => {
    queried.push(selector);
    return selector === 'tr[data-id]' ? [row] : [];
  };
  ctx.healthGotoRow = originalHealthGotoRow;
  ctx.showPage = () => {};
  ctx.healthGotoRow('singles', dangerousId);
  timers.flush(entry => entry.delay === 200);
  assert.deepEqual(queried, ['tr[data-id]']);
  assert.equal(row.style.background, 'var(--accent-soft)');
});

test('health: unresolved snapshotless markers are a review warning', async () => {
  const id = 'health_snapshotless_row';
  const token = 'old-tab:health-review';
  const { ctx } = await loadApp({
    seed: null,
    localStorage: {
      ['pokeinv_dirty_v2:' + token]: JSON.stringify({ table: 'singles', id, token, owner: 'old-tab', createdAt: 791 }),
      pokeinv_dirty_v1: JSON.stringify({ singles: [id], _revisions: { singles: { [id]: [token] } } }),
    },
  });
  ctx.runHealthCheck();
  const finding = ctx._lastHealthFindings.find(item => item.area === 'Sync' && item.message.includes('no saved row snapshot'));
  assert.ok(finding, 'the marker is visible in Health for review');
  assert.equal(finding.sev, 'warn');
});

test('sync diagnostics: a signed-out retry explains the sign-in guard without contacting the cloud', async () => {
  const { ctx, fetchMock } = await loadApp({ authenticated: false });
  fetchMock.calls.length = 0;
  await ctx.retrySyncDiagnostics();
  assert.equal(fetchMock.calls.length, 0);
  assert.equal(ctx._syncDiagnostics.failures.read.code, 'owner_session_required');
  assert.match(ctx._syncDiagProblem(ctx._syncDiagPendingSnapshot()).reason, /not signed in/i);
});
