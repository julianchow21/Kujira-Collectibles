import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const source = fs.readFileSync(new URL('../Server/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))).default;
const ENV = {
  SUPABASE_URL: 'https://synthetic.supabase.test',
  SUPABASE_ANON_KEY: 'synthetic-anon-key',
  SUPABASE_SERVICE_KEY: 'synthetic-service-key',
  COLLECTIBLES_OWNER_USER_ID: 'synthetic-owner'
};
const HEADERS = {
  Origin: 'https://julianchow21.github.io',
  Authorization: 'Bearer synthetic-user-token',
  'Content-Type': 'application/json'
};
const originalFetch = globalThis.fetch;

test.afterEach(() => { globalThis.fetch = originalFetch; });

function request(path, body, headers = HEADERS, method = 'POST') {
  return new Request('https://worker.example' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function mockFetch(calls, rpcResult = { ok: true, client_protocol: 2, schema_version: 1, candidates: [], nextCursor: null, selected: null, canonicalRefs: [] }) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: 'synthetic-owner' });
    return Response.json(rpcResult);
  };
}

test('Dealer Worker enforces schema, allowlists, owner injection and typed upstream failures', async () => {
  const calls = [];
  mockFetch(calls);

  let response = await worker.fetch(request('/sync/v2/dealer/pull', { client_protocol: 2 }), ENV);
  assert.equal(response.status, 428);
  assert.equal((await response.json()).code, 'schema_required');
  assert.equal(calls.length, 1);

  response = await worker.fetch(request('/sync/v2/dealer/pull', { client_protocol: 2, schema_version: 9 }), ENV);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'schema_mismatch');
  assert.equal(calls.length, 2);

  response = await worker.fetch(request('/sync/v2/dealer/pull', { client_protocol: 2, schema_version: 1, owner_user_id: 'forged' }), ENV);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_request');
  assert.equal(calls.length, 3);

  calls.length = 0;
  response = await worker.fetch(request('/sync/v2/dealer/pull', { client_protocol: 2, schema_version: 1, limit: 50, cursor: null, candidateId: 'candidate-1' }), ENV);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, ENV.SUPABASE_URL + '/rest/v1/rpc/collectibles_dealer_pull_v1');
  assert.equal(calls[1].init.headers.apikey, ENV.SUPABASE_SERVICE_KEY);
  const forwardedPull = JSON.parse(calls[1].init.body);
  assert.equal(forwardedPull.p_request.owner_user_id, 'synthetic-owner');
  assert.equal(forwardedPull.p_request.schema_version, 1);

  calls.length = 0;
  response = await worker.fetch(request('/sync/v2/dealer/command', {
    client_protocol: 2,
    schema_version: 1,
    command_id: '00000000-0000-4000-8000-000000000001',
    command: 'create_candidate',
    expected: {},
    payload: { candidateId: 'candidate-1', ownership: 'Business' }
  }), ENV);
  assert.equal(response.status, 200);
  const forwardedCommand = JSON.parse(calls[1].init.body);
  assert.equal(forwardedCommand.p_request.owner_user_id, 'synthetic-owner');

  calls.length = 0;
  mockFetch(calls, { ok: false, client_protocol: 2, schema_version: 1, code: 'version_conflict', conflicts: [] });
  response = await worker.fetch(request('/sync/v2/dealer/command', {
    client_protocol: 2,
    schema_version: 1,
    command_id: '00000000-0000-4000-8000-000000000002',
    command: 'update_candidate',
    expected: { candidate: 1 },
    payload: { candidateId: 'candidate-1', patch: { notes: 'stale' } }
  }), ENV);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, 'version_conflict');
});

test('Dealer Worker rejects invalid command transport before RPC and preserves auth boundary', async () => {
  const calls = [];
  mockFetch(calls);
  let response = await worker.fetch(request('/sync/v2/dealer/command', {
    client_protocol: 2,
    schema_version: 1,
    command_id: 'bad',
    command: 'delete_everything',
    expected: {},
    payload: {}
  }), ENV);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_command_id');
  assert.equal(calls.length, 1);

  globalThis.fetch = async url => {
    if (String(url).endsWith('/auth/v1/user')) return Response.json({ id: 'another-user' });
    throw new Error('RPC must not run for a wrong owner');
  };
  response = await worker.fetch(request('/sync/v2/dealer/pull', { client_protocol: 2, schema_version: 1 }), ENV);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'owner_forbidden');
});
