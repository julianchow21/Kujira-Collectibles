'use strict';
// Suite 19: trash-lifecycle - sendToTrash, kjrDeleteRow, purgeExpiredTrash,
// restoreFromTrash.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, plain } = require('./harness.js');

const LOCALHOST_LOCATION = {
  protocol: 'http:', hostname: 'localhost', host: 'localhost:3800',
  href: 'http://localhost:3800/', origin: 'http://localhost:3800',
  pathname: '/', search: '',
};

test('trash-lifecycle: sendToTrash (localhost, local path) - entry shape and DB.trash push', async () => {
  const { ctx, grab } = await loadApp({ location: LOCALHOST_LOCATION });
  const item = { id: 's1', name: 'Test Card', costPrice: 10 };
  await ctx.sendToTrash('singles', item, 'manual');
  const { DB } = grab('DB');
  assert.strictEqual(DB.trash.length, 1);
  const entry = DB.trash[0];
  assert.match(entry.id, /^trash_/);
  assert.strictEqual(entry.data.originalTable, 'singles');
  assert.strictEqual(entry.data.originalId, 's1');
  assert.strictEqual(entry.data.reason, 'manual');
  assert.ok(entry.data.deletedAt);
  assert.strictEqual(entry.data.item.name, 'Test Card', 'full snapshot of the item is kept');
});

test('trash-lifecycle: sendToTrash does NOT itself remove the row from the source table (that is the caller\'s job, e.g. kjrDeleteRow)', async () => {
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    seed: { singles: [{ id: 's1', name: 'Still Here', status: 'Available' }] },
  });
  await ctx.sendToTrash('singles', { id: 's1', name: 'Still Here' }, 'manual');
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.length, 1, 'sendToTrash only writes the snapshot - it never touches DB.singles itself');
});

test('trash-lifecycle: sendToTrash on github.io with a failing cloud write queues a pending retry in localStorage', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp(); // default location = github.io
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/trash', { ok: false, status: 500, text: 'boom' });
  await ctx.sendToTrash('singles', { id: 's1', name: 'Test' }, 'manual');
  const pending = JSON.parse(localStorage.getItem('_kjrPendingTrashWrites') || '[]');
  assert.strictEqual(pending.length, 1, 'the failed cloud write is queued so the 30-day restore snapshot is never silently lost');
  assert.strictEqual(pending[0].data.originalId, 's1');
});

test('trash-lifecycle: sendToTrash on github.io with a SUCCESSFUL cloud write does not queue anything', async () => {
  const { ctx, fetchMock, localStorage } = await loadApp();
  fetchMock.calls.length = 0;
  fetchMock.route('/rest/v1/trash', { ok: true, json: {} });
  await ctx.sendToTrash('singles', { id: 's1', name: 'Test' }, 'manual');
  assert.strictEqual(localStorage.getItem('_kjrPendingTrashWrites'), null);
});

test('trash-lifecycle: kjrDeleteRow (confirmed) - the original row is REMOVED from its table and a matching trash entry appears, never hard-deleted', async () => {
  const { ctx, grab, settle } = await loadApp({
    location: LOCALHOST_LOCATION,
    seed: { singles: [{ id: 's1', name: 'To Delete', status: 'Available' }] },
  });
  ctx.confirm = () => true; // kjrConfirm's native-confirm fallback path (no real <dialog> in the stub DOM)
  await ctx.kjrDeleteRow('singles', 's1');
  await settle(); // kjrDeleteRow's background Promise.all([sendToTrash, sbDelete]) is fire-and-forget
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.find((r) => r.id === 's1'), undefined, 'removed from the live table');
  assert.strictEqual(DB.trash.length, 1, 'but recoverable from trash, not hard-deleted');
  assert.strictEqual(DB.trash[0].data.originalId, 's1');
  assert.strictEqual(DB.trash[0].data.originalTable, 'singles');
});

test('trash-lifecycle: kjrDeleteRow (cancelled) - nothing happens when confirm resolves false', async () => {
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    seed: { singles: [{ id: 's1', name: 'Keep Me', status: 'Available' }] },
  });
  // Default confirm() shim already resolves false - the harness's deliberate default.
  await ctx.kjrDeleteRow('singles', 's1');
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.length, 1, 'row survives - the delete was never confirmed');
  assert.strictEqual(DB.trash.length, 0);
});

test('trash-lifecycle: purgeExpiredTrash - purges entries older than 30 days, keeps fresh ones (localhost, local DB.trash)', async () => {
  const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
  const freshDate = new Date().toISOString();
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: {
      _kjrLocalTrash: JSON.stringify([
        { id: 'trash_old', data: { originalTable: 'singles', originalId: 'old1', item: {}, deletedAt: oldDate }, updated_at: oldDate },
        { id: 'trash_fresh', data: { originalTable: 'singles', originalId: 'fresh1', item: {}, deletedAt: freshDate }, updated_at: freshDate },
      ]),
    },
  });
  await ctx.purgeExpiredTrash();
  const { DB } = grab('DB');
  const ids = plain(DB.trash).map((e) => e.id);
  assert.deepStrictEqual(ids, ['trash_fresh'], 'the 40-day-old entry is purged, the fresh one survives');
});

test('trash-lifecycle: the app itself schedules purgeExpiredTrash as a captured ~5s timeout at load - invoking it drives the same purge', async () => {
  const oldDate = new Date(Date.now() - 40 * 86400000).toISOString();
  const { timers, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: {
      _kjrLocalTrash: JSON.stringify([
        { id: 'trash_old', data: { originalTable: 'singles', originalId: 'old1', item: {}, deletedAt: oldDate }, updated_at: oldDate },
      ]),
    },
  });
  const captured = timers.list().find((t) => t.type === 'timeout' && t.delay === 5000);
  assert.ok(captured, 'app.js registers a 5000ms setTimeout for purgeExpiredTrash at load, never auto-firing in the harness');
  timers.invoke(captured.id);
  await new Promise((r) => setImmediate(r)); // let the now-invoked async purgeExpiredTrash settle
  await new Promise((r) => setImmediate(r));
  const { DB } = grab('DB');
  assert.strictEqual(DB.trash.length, 0, 'driving the captured callback purged the stale entry exactly like calling purgeExpiredTrash() directly');
});

test('trash-lifecycle: restoreFromTrash - the row returns to its original table and the trash entry is cleared', async () => {
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    localStorage: {
      _kjrLocalTrash: JSON.stringify([
        { id: 'trash_1', data: { originalTable: 'singles', originalId: 's1', item: { id: 's1', name: 'Restored Card', status: 'Available' }, deletedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
      ]),
    },
  });
  await ctx.restoreFromTrash('trash_1');
  const { DB } = grab('DB');
  assert.ok(DB.singles.some((r) => r.id === 's1' && r.name === 'Restored Card'), 'row is back in DB.singles');
  assert.strictEqual(DB.trash.length, 0, 'the trash entry is gone after a successful restore');
});

test('trash-lifecycle: restoreFromTrash - restoring an id already back in the table is a safe no-op (does not duplicate)', async () => {
  const { ctx, grab } = await loadApp({
    location: LOCALHOST_LOCATION,
    seed: { singles: [{ id: 's1', name: 'Already Here', status: 'Available' }] },
    localStorage: {
      _kjrLocalTrash: JSON.stringify([
        { id: 'trash_1', data: { originalTable: 'singles', originalId: 's1', item: { id: 's1', name: 'Stale Snapshot' }, deletedAt: new Date().toISOString() }, updated_at: new Date().toISOString() },
      ]),
    },
  });
  await ctx.restoreFromTrash('trash_1');
  const { DB } = grab('DB');
  assert.strictEqual(DB.singles.filter((r) => r.id === 's1').length, 1, 'no duplicate row created');
  assert.strictEqual(DB.trash.length, 0, 'the trash entry is still cleared even on the already-restored guard path');
});
