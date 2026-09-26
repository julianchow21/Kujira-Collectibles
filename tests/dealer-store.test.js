'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const DealerStore = require('../dealer-store.js');

class MemoryStorage {
  constructor() { this.values = new Map(); }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
  key(index) { return Array.from(this.values.keys())[index] || null; }
  get length() { return this.values.size; }
}

class FailingStorage extends MemoryStorage {
  setItem() { throw new Error('storage quota full'); }
}

function ownerContext(overrides) {
  return Object.assign({
    authenticated: true,
    verified: true,
    userId: 'owner-1',
    sessionId: 'session-1',
    generation: 1,
    offline: false
  }, overrides || {});
}

function pullBody(overrides) {
  return Object.assign({
    ok: true,
    client_protocol: 2,
    schema_version: 1,
    candidates: [{ id: 'candidate-1', name: 'Long text candidate', version: 3 }],
    selected_candidate: { id: 'candidate-1', name: 'Long text candidate', version: 3 },
    next_cursor: null,
    revisions: { 'candidate-1': 3 }
  }, overrides || {});
}

function commandBody(overrides) {
  return Object.assign({
    ok: true,
    client_protocol: 2,
    schema_version: 1,
    result: { candidate: { id: 'candidate-1', version: 4 }, revisions: { 'candidate-1': 4 } }
  }, overrides || {});
}

function makeStore(transport, context, storage) {
  return DealerStore.create({
    transport,
    ownerContext: () => context,
    storage: storage || new MemoryStorage()
  });
}

test('production store gates writes on a verified schema and keeps authoritative data separate', async () => {
  const context = ownerContext();
  const calls = [];
  const store = makeStore({
    pull: async request => { calls.push(request); return pullBody(); },
    command: async request => commandBody()
  }, context);

  const before = await store.init();
  assert.equal(before.snapshot, null);
  const blocked = await store.command('create_candidate', { candidate: { name: 'Draft' } });
  assert.equal(blocked.code, 'schema_required');
  const loaded = await store.pull({ limit: 500 });
  assert.equal(loaded.snapshot.candidates.length, 1);
  assert.equal(calls[0].body.limit, 50);
  const confirmed = await store.command('update_candidate', { candidateId: 'candidate-1', candidate: { name: 'Updated' } }, { expectedVersions: { candidate: 3 } });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.confirmed, true);
  assert.deepEqual(store.view().pending, {});
});

test('offline viewing uses a stale server cache and retains only visible local drafts', async () => {
  const storage = new MemoryStorage();
  const context = ownerContext();
  const online = makeStore({ pull: async () => pullBody(), command: async () => commandBody() }, context, storage);
  await online.pull();
  online.saveDraft('new', { name: 'Unsubmitted candidate' });

  context.offline = true;
  const offline = makeStore({
    pull: async () => { throw new Error('network must not be called'); },
    command: async () => { throw new Error('network must not be called'); }
  }, context, storage);
  await offline.init();
  const stale = await offline.pull({ limit: 50 });
  assert.equal(stale.code, 'offline_view');
  assert.equal(stale.stale, true);
  assert.equal(offline.view().drafts.new.fields.name, 'Unsubmitted candidate');
  const blocked = await offline.command('create_candidate', { candidate: { name: 'Unsubmitted candidate' } });
  assert.equal(blocked.code, 'offline_write_blocked');
  assert.match(blocked.message, /local draft is retained/);
});

test('persisted snapshots stay stale until revalidated and failed pulls mark cached data stale', async () => {
  const storage = new MemoryStorage();
  const context = ownerContext();
  const online = makeStore({ pull: async () => pullBody(), command: async () => commandBody() }, context, storage);
  await online.pull();
  const persisted = JSON.parse(storage.getItem('kjr-dealer-production-v1:owner-1'));
  assert.equal(persisted.stale, false);

  const reloaded = makeStore({
    pull: async () => { throw new Error('Worker unavailable'); },
    command: async () => commandBody()
  }, context, storage);
  await reloaded.init();
  assert.equal(reloaded.view().stale, true);
  await assert.rejects(() => reloaded.pull(), error => error.code === 'pull_failed');
  assert.equal(reloaded.view().stale, true);
  const afterFailure = JSON.parse(storage.getItem('kjr-dealer-production-v1:owner-1'));
  assert.equal(afterFailure.stale, true);
});

test('unknown response retries the exact durable UUID and payload', async () => {
  const context = ownerContext();
  const requests = [];
  let first = true;
  const store = makeStore({
    pull: async () => pullBody(),
    command: async request => {
      requests.push(JSON.parse(JSON.stringify(request.body)));
      if (first) { first = false; throw new Error('connection dropped after request'); }
      return commandBody();
    }
  }, context);
  await store.pull();
  const firstResult = await store.command('update_candidate', { candidateId: 'candidate-1', candidate: { name: 'Retry me' } }, {
    commandId: '00000000-0000-4000-8000-000000000001',
    expectedVersions: { candidate: 3 }
  });
  assert.equal(firstResult.code, 'unknown_response');
  assert.equal(store.view().pending[firstResult.commandId].status, 'unknown');
  const retryResult = await store.retry(firstResult.commandId);
  assert.equal(retryResult.ok, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[1].command_id, firstResult.commandId);
  assert.deepEqual(store.view().pending, {});
});

test('reload converts persisted pending and in-flight envelopes to unknown', async () => {
  const context = ownerContext();
  const storage = new MemoryStorage();
  storage.setItem('kjr-dealer-production-v1:owner-1', JSON.stringify({
    owner_id: 'owner-1', schema_version: 1, schema_known: true,
    snapshot: { candidates: [], nextCursor: null }, stale: false, drafts: {},
    pending: {
      '00000000-0000-4000-8000-000000000111': { commandId: '00000000-0000-4000-8000-000000000111', command: 'update_candidate', status: 'in_flight', wire: { command_id: '00000000-0000-4000-8000-000000000111' }, payload: { candidateId: 'candidate-1' } },
      '00000000-0000-4000-8000-000000000112': { commandId: '00000000-0000-4000-8000-000000000112', command: 'update_candidate', status: 'pending', wire: { command_id: '00000000-0000-4000-8000-000000000112' }, payload: { candidateId: 'candidate-1' } }
    }
  }));
  const requests = [];
  const store = makeStore({
    pull: async () => pullBody(),
    command: async request => { requests.push(request.body.command_id); return commandBody(); }
  }, context, storage);
  await store.init();
  assert.equal(store.view().pending['00000000-0000-4000-8000-000000000111'].status, 'unknown');
  assert.equal(store.view().pending['00000000-0000-4000-8000-000000000112'].status, 'unknown');
  const retried = await store.retry('00000000-0000-4000-8000-000000000111');
  assert.equal(retried.ok, true);
  assert.deepEqual(requests, ['00000000-0000-4000-8000-000000000111']);
});

test('same-owner generation change retains the exact command as unknown for retry', async () => {
  const context = ownerContext();
  let release;
  let calls = 0;
  const store = makeStore({
    pull: async () => pullBody(),
    command: async () => {
      calls += 1;
      if (calls === 1) return new Promise(resolve => { release = resolve; });
      return commandBody();
    }
  }, context);
  await store.pull();
  const command = store.command('update_candidate', { candidateId: 'candidate-1', patch: { notes: 'refresh safely' } }, { commandId: '00000000-0000-4000-8000-000000000113' });
  context.generation = 2;
  release(commandBody());
  const first = await command;
  assert.equal(first.status, 'unknown');
  assert.equal(store.view().pending[first.commandId].status, 'unknown');
  assert.equal((await store.retry(first.commandId)).ok, true);
  assert.equal(calls, 2);
});

test('uncertain upstream responses stay retryable with the same command id', async () => {
  const context = ownerContext();
  let first = true;
  const calls = [];
  const store = makeStore({
    pull: async () => pullBody(),
    command: async request => {
      calls.push(request.body.command_id);
      if (first) {
        first = false;
        return { ok: false, client_protocol: 2, schema_version: 1, error: { code: 'sync_upstream_unavailable', message: 'RPC result unavailable' } };
      }
      return commandBody();
    }
  }, context);
  await store.pull();
  const firstResult = await store.command('update_candidate', { candidateId: 'candidate-1', patch: { notes: 'uncertain' } }, { commandId: '00000000-0000-4000-8000-000000000114' });
  assert.equal(firstResult.status, 'unknown');
  assert.equal((await store.retry(firstResult.commandId)).ok, true);
  assert.deepEqual(calls, [firstResult.commandId, firstResult.commandId]);
});

test('storage failure blocks financial transport before sending and preserves a recoverable error', async () => {
  const context = ownerContext();
  const storage = new FailingStorage();
  let sent = 0;
  const store = makeStore({
    pull: async () => pullBody(),
    command: async () => { sent += 1; return commandBody(); }
  }, context, storage);
  await store.pull();
  const result = await store.command('settle_sale', { outcomeId: 'outcome-1', proceeds: '100' }, { commandId: '00000000-0000-4000-8000-000000000115' });
  assert.equal(result.code, 'storage_unavailable');
  assert.equal(result.status, 'storage_blocked');
  assert.equal(sent, 0);
  assert.equal(store.view().pending[result.commandId], undefined);
});

test('schema mismatch blocks writes and version conflicts retain attempted payload plus current server version', async () => {
  const context = ownerContext();
  const schemaStore = makeStore({ pull: async () => pullBody({ schema_version: 7 }), command: async () => commandBody() }, context);
  await assert.rejects(() => schemaStore.pull(), error => error.code === 'schema_mismatch');
  const schemaBlocked = await schemaStore.command('create_candidate', { candidate: { name: 'blocked' } });
  assert.equal(schemaBlocked.code, 'schema_mismatch');

  const conflictStore = makeStore({
    pull: async () => pullBody(),
    command: async () => ({ ok: false, client_protocol: 2, schema_version: 1, error: { code: 'version_conflict', message: 'Current version changed' }, current: { id: 'candidate-1', version: 9 } })
  }, context);
  await conflictStore.pull();
  const result = await conflictStore.command('update_candidate', { candidateId: 'candidate-1', candidate: { name: 'Attempted' } }, { expectedVersions: { candidate: 3 }, commandId: '00000000-0000-4000-8000-000000000002' });
  assert.equal(result.status, 'conflict');
  const pending = conflictStore.view().pending[result.commandId];
  assert.equal(pending.status, 'conflict');
  assert.equal(pending.current.version, 9);
  assert.equal(pending.attempted.candidate.name, 'Attempted');
  const retry = await conflictStore.retry(result.commandId);
  assert.equal(retry.code, 'conflict_review_required');
});

test('pagination is bounded and late responses from an old owner are ignored', async () => {
  const context = ownerContext();
  let request;
  const longName = 'x'.repeat(12000);
  const store = makeStore({
    pull: async value => { request = value; return pullBody({ candidates: [{ id: 'long', name: longName }], selected_candidate: null, next_cursor: 'cursor-2' }); },
    command: async () => commandBody()
  }, context);
  const page = await store.pull({ cursor: 'cursor-1', limit: 1000 });
  assert.equal(request.body.limit, 50);
  assert.equal(request.body.cursor, 'cursor-1');
  assert.equal(page.snapshot.candidates[0].name.length, 12000);

  let resolve;
  const delayed = makeStore({
    pull: () => new Promise(r => { resolve = r; }),
    command: async () => commandBody()
  }, context);
  const pending = delayed.pull();
  context.userId = 'owner-2';
  context.sessionId = 'session-2';
  context.generation = 2;
  resolve(pullBody());
  await assert.rejects(() => pending, error => error.code === 'owner_changed');
  assert.equal(delayed.view().snapshot, null);
});

test('explicit owner clear removes cache, drafts, and pending envelopes', async () => {
  const storage = new MemoryStorage();
  const context = ownerContext();
  const store = makeStore({ pull: async () => pullBody(), command: async () => { throw new Error('unknown'); } }, context, storage);
  await store.pull();
  store.saveDraft('new', { name: 'clear me' });
  await store.command('update_candidate', { candidateId: 'candidate-1', candidate: { name: 'clear me' } });
  assert.ok(store.unsyncedCount() >= 2);
  store.clearOwnerData();
  assert.equal(store.unsyncedCount(), 0);
  assert.equal(store.view().snapshot, null);
  assert.equal(storage.values.size, 0);
});

test('wire bodies match the Worker and SQL Dealer contract', async () => {
  const context = ownerContext();
  const seen = { pull: null, command: null };
  const store = makeStore({
    pull: async request => { seen.pull = JSON.parse(JSON.stringify(request.body)); return pullBody(); },
    command: async request => { seen.command = JSON.parse(JSON.stringify(request.body)); return commandBody(); }
  }, context);

  await store.pull({ cursor: '12', candidateId: 'candidate-1', limit: 500 });
  assert.deepEqual(Object.keys(seen.pull).sort(), ['candidateId', 'client_protocol', 'cursor', 'limit', 'schema_version']);
  assert.equal(seen.pull.client_protocol, 2);
  assert.equal(seen.pull.schema_version, 1);
  assert.equal(seen.pull.limit, 50);
  assert.equal(seen.pull.candidateId, 'candidate-1');
  assert.equal(seen.pull.candidate_id, undefined);

  await store.command('update_candidate', { candidateId: 'candidate-1', patch: { notes: 'contract check' } }, {
    commandId: '00000000-0000-4000-8000-000000000099',
    expectedVersions: { candidate: 3 }
  });
  assert.deepEqual(Object.keys(seen.command).sort(), ['client_protocol', 'command', 'command_id', 'expected', 'payload', 'schema_version']);
  assert.equal(seen.command.client_protocol, 2);
  assert.equal(seen.command.schema_version, 1);
  assert.equal(seen.command.command_id, '00000000-0000-4000-8000-000000000099');
  assert.deepEqual(seen.command.expected, { candidate: 3 });
  assert.deepEqual(seen.command.payload, { candidateId: 'candidate-1', patch: { notes: 'contract check' } });
  assert.equal(seen.command.expected_versions, undefined);
});

test('store command lock prevents concurrent duplicate actions', async () => {
  const context = ownerContext();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const store = makeStore({
    pull: async () => pullBody(),
    command: async () => { await gate; return commandBody(); }
  }, context);
  await store.pull();
  const first = store.command('update_candidate', { candidateId: 'candidate-1', patch: { notes: 'one' } }, { expectedVersions: { candidate: 3 }, busyKey: 'candidate-save' });
  const second = await store.command('update_candidate', { candidateId: 'candidate-1', patch: { notes: 'two' } }, { expectedVersions: { candidate: 3 }, busyKey: 'candidate-save' });
  assert.equal(second.code, 'busy');
  assert.equal(Object.keys(store.view().pending).length, 1);
  release();
  assert.equal((await first).ok, true);
});

test('same-owner store instances merge per-command envelopes and retain draft conflicts', async () => {
  const storage = new MemoryStorage();
  const contextA = ownerContext();
  const contextB = ownerContext();
  const transport = {
    pull: async () => pullBody(),
    command: async () => { await Promise.resolve(); throw new Error('response lost'); }
  };
  const first = makeStore(transport, contextA, storage);
  const second = makeStore(transport, contextB, storage);
  await first.pull();
  await second.init();

  const firstPending = first.command('update_candidate', { candidateId: 'candidate-1', patch: { notes: 'tab A' } }, {
    commandId: '00000000-0000-4000-8000-000000000201', expectedVersions: { candidate: 3 }
  });
  const secondPending = second.command('set_asking', { candidateId: 'candidate-1', askingAmount: '125' }, {
    commandId: '00000000-0000-4000-8000-000000000202', expectedVersions: { candidate: 3 }
  });
  const results = await Promise.all([firstPending, secondPending]);
  assert.deepEqual(results.map(result => result.status).sort(), ['unknown', 'unknown']);

  first.saveDraft('candidate-1', { name: 'Draft from tab A' }, { stage: 2 });
  second.saveDraft('candidate-1', { name: 'Draft from tab B' }, { stage: 3 });

  const recovered = makeStore({ pull: async () => pullBody(), command: async () => commandBody() }, ownerContext(), storage);
  await recovered.init();
  const recoveredView = recovered.view();
  assert.equal(recoveredView.pending['00000000-0000-4000-8000-000000000201'].status, 'unknown');
  assert.equal(recoveredView.pending['00000000-0000-4000-8000-000000000202'].status, 'unknown');
  assert.equal(recoveredView.drafts['candidate-1'].localOnly, true);
  assert.ok(Array.isArray(recoveredView.drafts['candidate-1'].conflicts));
  const draftNames = [recoveredView.drafts['candidate-1'].fields.name]
    .concat(recoveredView.drafts['candidate-1'].conflicts.map(conflict => conflict.fields && conflict.fields.name));
  assert.ok(draftNames.includes('Draft from tab A'));
  assert.ok(draftNames.includes('Draft from tab B'));

  assert.equal(recovered.dismissPending('00000000-0000-4000-8000-000000000201').ok, true);
  const afterDismiss = makeStore({ pull: async () => pullBody(), command: async () => commandBody() }, ownerContext(), storage);
  await afterDismiss.init();
  assert.equal(afterDismiss.view().pending['00000000-0000-4000-8000-000000000201'], undefined);
  assert.equal(afterDismiss.view().pending['00000000-0000-4000-8000-000000000202'].status, 'unknown');
});

test('draft conflict choices restore an alternate while retaining every owner-scoped variant', async () => {
  const storage = new MemoryStorage();
  const first = makeStore({ pull: async () => pullBody(), command: async () => commandBody() }, ownerContext(), storage);
  const second = makeStore({ pull: async () => pullBody(), command: async () => commandBody() }, ownerContext(), storage);
  await first.pull();
  await second.init();
  first.saveDraft('candidate-1', { name: 'Current tab draft' }, { expectedSaleAmount: '20' });
  second.saveDraft('candidate-1', { name: 'Alternate tab draft' }, { expectedSaleAmount: '30' });

  const recovered = makeStore({ pull: async () => pullBody(), command: async () => commandBody() }, ownerContext(), storage);
  await recovered.init();
  const before = recovered.view().drafts['candidate-1'];
  assert.ok(Array.isArray(before.conflicts));
  const alternateIndex = before.conflicts.findIndex(item => item.fields && item.fields.name === 'Current tab draft');
  assert.ok(alternateIndex >= 0);
  const restored = recovered.restoreDraft('candidate-1', alternateIndex);
  assert.equal(restored.ok, true);
  assert.equal(recovered.view().drafts['candidate-1'].fields.name, 'Current tab draft');
  const names = [recovered.view().drafts['candidate-1'].fields.name]
    .concat(recovered.view().drafts['candidate-1'].conflicts.map(item => item.fields && item.fields.name));
  assert.ok(names.includes('Current tab draft'));
  assert.ok(names.includes('Alternate tab draft'));
  assert.equal(recovered.view().drafts['candidate-1'].conflictChoice, 'alternate');
});

test('session expiry hides protected records but preserves same-owner drafts and receipts for re-auth', async () => {
  const storage = new MemoryStorage();
  const context = ownerContext();
  const store = makeStore({ pull: async () => pullBody(), command: async () => { throw new Error('response lost'); } }, context, storage);
  await store.pull();
  store.saveDraft('new', { name: 'Recoverable draft' });
  const pending = await store.command('update_candidate', { candidateId: 'candidate-1', patch: { notes: 'retain receipt' } }, {
    commandId: '00000000-0000-4000-8000-000000000088', expectedVersions: { candidate: 3 }
  });
  assert.equal(pending.status, 'unknown');
  store.suspendOwnerData();
  context.authenticated = false;
  assert.equal(store.view().snapshot, null);
  assert.deepEqual(store.view().drafts, {});

  context.authenticated = true;
  context.generation = 2;
  context.sessionId = 'session-2';
  await store.init();
  assert.equal(store.view().drafts.new.fields.name, 'Recoverable draft');
  assert.equal(store.view().pending['00000000-0000-4000-8000-000000000088'].status, 'unknown');
  assert.equal(store.view().schemaKnown, false);
});
