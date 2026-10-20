import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

globalThis.caches = {
  default: {
    match: async () => null,
    put: async () => {}
  }
};

const source = fs.readFileSync(
  new URL('../Server/worker.js', import.meta.url),
  'utf8'
);
const worker = (await import(
  'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
)).default;

const TEST_ANON_KEY = 'synthetic-anon-key';
const TEST_SERVICE_KEY = 'synthetic-service-key';
const ENV = {
  SUPABASE_URL: 'https://synthetic.supabase.test',
  SUPABASE_ANON_KEY: TEST_ANON_KEY,
  SUPABASE_SERVICE_KEY: TEST_SERVICE_KEY,
  COLLECTIBLES_OWNER_USER_ID: 'synthetic-owner'
};
const OWNER_HEADERS = {
  Origin: 'https://julianchow21.github.io',
  Authorization: 'Bearer synthetic-user-token',
  'Content-Type': 'application/json'
};
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

function request(path, body, headers = OWNER_HEADERS, method = 'POST') {
  return new Request('https://worker.example' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function rawRequest(path, body, headers = OWNER_HEADERS, method = 'POST') {
  return new Request('https://worker.example' + path, {
    method,
    headers,
    body
  });
}

function ownerFetch(calls, rpcResult = {
  ok: true,
  client_protocol: 2,
  tables: {},
  tombstones: []
}) {
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/v1/user')) {
      return Response.json({ id: 'synthetic-owner' });
    }
    return Response.json(rpcResult);
  };
}

test('sync authenticates the owner before attaching the service role', async () => {
  const calls = [];
  globalThis.fetch = async () => {
    throw new Error('fetch must not run before origin and bearer checks');
  };

  let response = await worker.fetch(request(
    '/sync/v2/pull',
    { client_protocol: 2 },
    { 'Content-Type': 'application/json' }
  ), ENV);
  assert.equal(response.status, 403);

  response = await worker.fetch(request(
    '/sync/v2/pull',
    { client_protocol: 2 },
    { Origin: 'https://julianchow21.github.io', 'Content-Type': 'application/json' }
  ), ENV);
  assert.equal(response.status, 401);

  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json({ id: 'another-user' });
  };
  response = await worker.fetch(request('/sync/v2/pull', { client_protocol: 2 }), ENV);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'owner_forbidden');
  assert.equal(calls.length, 1);

  calls.length = 0;
  ownerFetch(calls);
  response = await worker.fetch(request('/sync/v2/pull', { client_protocol: 2 }), ENV);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.apikey, TEST_ANON_KEY);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-user-token');
  assert.equal(calls[0].init.headers['x-service-key'], undefined);
  assert.equal(calls[1].init.headers.apikey, TEST_SERVICE_KEY);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ' + TEST_SERVICE_KEY);
  assert.deepEqual(JSON.parse(calls[1].init.body), { p_client_protocol: 2 });
});

test('sync validates JSON and protocol before calling the RPC', async () => {
  const calls = [];
  ownerFetch(calls);

  let response = await worker.fetch(request('/sync/v2/pull', {}), ENV);
  assert.equal(response.status, 428);
  assert.equal(calls.length, 1);

  calls.length = 0;
  response = await worker.fetch(rawRequest(
    '/sync/v2/mutate',
    '{not-json}',
    OWNER_HEADERS
  ), ENV);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_json');
  assert.equal(calls.length, 1);

  calls.length = 0;
  response = await worker.fetch(request('/sync/v2/pull', {
    client_protocol: 2,
    extra: true
  }), ENV);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_request');
  assert.equal(calls.length, 1);

  calls.length = 0;
  response = await worker.fetch(request('/sync/v2/mutate', {
    client_protocol: 1,
    mutation_id: '00000000-0000-4000-8000-000000000001',
    operations: []
  }), ENV);
  assert.equal(response.status, 428);
  assert.equal((await response.json()).code, 'protocol_mismatch');
  assert.equal(calls.length, 1);

  calls.length = 0;
  const oversized = 'x'.repeat(2 * 1024 * 1024 + 1);
  response = await worker.fetch(rawRequest('/sync/v2/mutate', oversized, OWNER_HEADERS), ENV);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, 'request_too_large');
  assert.equal(calls.length, 1);
});

test('CAS status codes and upstream failures remain stable', async () => {
  const calls = [];
  ownerFetch(calls, { ok: false, code: 'version_conflict', conflicts: [] });
  let response = await worker.fetch(request('/sync/v2/mutate', {
    client_protocol: 2,
    mutation_id: '00000000-0000-4000-8000-000000000002',
    operations: []
  }), ENV);
  assert.equal(response.status, 409);

  calls.length = 0;
  ownerFetch(calls, { ok: false, code: 'missing_expected_version' });
  response = await worker.fetch(request('/sync/v2/mutate', {
    client_protocol: 2,
    mutation_id: '00000000-0000-4000-8000-000000000003',
    operations: []
  }), ENV);
  assert.equal(response.status, 428);

  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/auth/v1/user')) {
      return Response.json({ id: 'synthetic-owner' });
    }
    return Response.json({ error: 'upstream' }, { status: 500 });
  };
  response = await worker.fetch(request('/sync/v2/pull', { client_protocol: 2 }), ENV);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).code, 'sync_upstream_error');
});

test('legacy flags never bypass owner auth, owner compatibility reads work', async () => {
  const calls = [];
  const legacyEnv = { ...ENV, ALLOW_LEGACY_DB: 'true' };
  const staleMutationEnv = { ...ENV, ALLOW_LEGACY_DB_MUTATIONS: 'true' };
  const exactOriginNoBearer = {
    Origin: 'https://julianchow21.github.io',
    'Content-Type': 'application/json'
  };

  // A legacy read flag must not turn an Origin-only request into a
  // service-role query. Authentication fails before fetch is called.
  let response = await worker.fetch(request(
    '/db/rest/v1/versions?select=id',
    undefined,
    exactOriginNoBearer,
    'GET'
  ), legacyEnv);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'authentication_required');
  assert.equal(calls.length, 0);

  // A stale mutation flag must not bypass authentication either.
  response = await worker.fetch(request(
    '/db/rest/v1/versions',
    { id: 'forbidden', data: {} },
    exactOriginNoBearer,
    'POST'
  ), staleMutationEnv);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, 'authentication_required');
  assert.equal(calls.length, 0);

  // An authenticated but different user is rejected before the service-role
  // request. The single call below is the Supabase Auth verification only.
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json({ id: 'another-user' });
  };
  const wrongOwnerHeaders = {
    ...OWNER_HEADERS,
    Authorization: 'Bearer synthetic-other-user-token'
  };
  response = await worker.fetch(request(
    '/db/rest/v1/versions?select=id',
    undefined,
    wrongOwnerHeaders,
    'GET'
  ), legacyEnv);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'owner_forbidden');
  assert.equal(calls.length, 1);

  calls.length = 0;
  response = await worker.fetch(request(
    '/db/rest/v1/versions',
    { id: 'forbidden', data: {} },
    wrongOwnerHeaders,
    'POST'
  ), staleMutationEnv);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'owner_forbidden');
  assert.equal(calls.length, 1);

  // The configured owner can still use the compatibility GET path. The
  // service-role credential is attached only to the second, upstream call.
  calls.length = 0;
  ownerFetch(calls, []);
  response = await worker.fetch(request(
    '/db/rest/v1/versions?select=id',
    undefined,
    OWNER_HEADERS,
    'GET'
  ), legacyEnv);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, ENV.SUPABASE_URL + '/auth/v1/user');
  assert.equal(calls[1].init.headers.apikey, TEST_SERVICE_KEY);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ' + TEST_SERVICE_KEY);

  for (const method of ['POST', 'PATCH', 'DELETE']) {
    calls.length = 0;
    ownerFetch(calls, []);
    response = await worker.fetch(request(
      '/db/rest/v1/versions',
      method === 'DELETE' ? undefined : { id: 'forbidden', data: {} },
      OWNER_HEADERS,
      method
    ), legacyEnv);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'legacy_mutations_disabled');
    assert.equal(calls.length, 1);
  }

  // Exact Origin remains a separate gate for forged requests.
  calls.length = 0;
  response = await worker.fetch(request(
    '/db/rest/v1/versions',
    undefined,
    { Origin: 'https://attacker.example' },
    'GET'
  ), legacyEnv);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'forbidden_origin');
  assert.equal(calls.length, 0);
});

test('normal DB mode authenticates reads and denies direct table writes', async () => {
  const calls = [];
  ownerFetch(calls, []);
  let response = await worker.fetch(request(
    '/db/rest/v1/singles',
    undefined,
    { Origin: 'https://julianchow21.github.io' },
    'GET'
  ), ENV);
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);

  calls.length = 0;
  ownerFetch(calls, []);
  response = await worker.fetch(request(
    '/db/rest/v1/singles?select=id',
    undefined,
    OWNER_HEADERS,
    'GET'
  ), ENV);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);

  for (const method of ['POST', 'PATCH', 'DELETE']) {
    calls.length = 0;
    ownerFetch(calls, []);
    response = await worker.fetch(request(
      '/db/rest/v1/singles',
      method === 'DELETE' ? undefined : { id: 'forbidden', data: {} },
      OWNER_HEADERS,
      method
    ), ENV);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'legacy_mutations_disabled');
    assert.equal(calls.length, 1);
  }

  calls.length = 0;
  ownerFetch(calls, []);
  response = await worker.fetch(new Request(
    'https://worker.example/db/rest/v1/rpc/collectibles_mutate_v2',
    { headers: OWNER_HEADERS }
  ), ENV);
  assert.equal(response.status, 403);
  assert.equal(calls.length, 1);

  calls.length = 0;
  ownerFetch(calls, []);
  response = await worker.fetch(request(
    '/db/rest/v1/singles',
    { id: 'forbidden', data: {} },
    OWNER_HEADERS,
    'POST'
  ), { ...ENV, ALLOW_LEGACY_DB_MUTATIONS: 'true' });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, 'legacy_mutations_disabled');
  assert.equal(calls.length, 1);
});

test('database path and method allowlists fail closed', async () => {
  const calls = [];
  ownerFetch(calls, []);
  let response = await worker.fetch(request(
    '/db/rest/v1/not-allowed',
    undefined,
    OWNER_HEADERS,
    'GET'
  ), ENV);
  assert.equal(response.status, 403);
  assert.equal(calls.length, 1);

  calls.length = 0;
  response = await worker.fetch(request(
    '/db/rest/v1/singles/',
    undefined,
    OWNER_HEADERS,
    'GET'
  ), ENV);
  assert.equal(response.status, 403);
  assert.equal(calls.length, 1);

  calls.length = 0;
  response = await worker.fetch(request(
    '/db/rest/v1/singles',
    undefined,
    OWNER_HEADERS,
    'PUT'
  ), ENV);
  assert.equal(response.status, 405);
  assert.equal(calls.length, 0);
});

test('price proxy accepts only the exact narrow route', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: [] });
  };
  const priceEnv = { PPT_KEY: 'synthetic-price-key' };
  const priceHeaders = { Origin: 'https://julianchow21.github.io' };

  let response = await worker.fetch(new Request(
    'https://worker.example/ppt/cards?search=Charizard&limit=3',
    { method: 'OPTIONS' }
  ), priceEnv);
  assert.equal(response.status, 204);

  response = await worker.fetch(new Request(
    'https://worker.example/ppt/cards?search=Charizard&limit=3'
  ), priceEnv);
  assert.equal(response.status, 403);

  response = await worker.fetch(new Request(
    'https://worker.example/ppt/cards?search=Charizard&limit=3',
    { headers: { Origin: 'https://attacker.example' } }
  ), priceEnv);
  assert.equal(response.status, 403);

  response = await worker.fetch(new Request(
    'https://worker.example/ppt/cards?search=Charizard&limit=3',
    { method: 'POST', headers: priceHeaders }
  ), priceEnv);
  assert.equal(response.status, 405);

  response = await worker.fetch(new Request(
    'https://worker.example/ppt/sets?search=Charizard&limit=3',
    { headers: priceHeaders }
  ), priceEnv);
  assert.equal(response.status, 404);

  response = await worker.fetch(new Request(
    'https://worker.example/ppt/cards?search=Charizard&limit=4',
    { headers: priceHeaders }
  ), priceEnv);
  assert.equal(response.status, 400);

  response = await worker.fetch(new Request(
    'https://worker.example/ppt/cards?search=Charizard&limit=3&extra=1',
    { headers: priceHeaders }
  ), priceEnv);
  assert.equal(response.status, 400);

  response = await worker.fetch(new Request(
    'https://worker.example/ppt/cards?search=Charizard&search=Pikachu&limit=3',
    { headers: priceHeaders }
  ), priceEnv);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);

  response = await worker.fetch(new Request(
    'https://worker.example/ppt/cards?search=Charizard&limit=3',
    { headers: priceHeaders }
  ), priceEnv);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://www.pokemonpricetracker.com/api/v2/cards?search=Charizard&limit=3'
  );
  assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-price-key');
});

// v3.76: slabs read their graded price from card.ebay[grade].avg, which the vendor only returns with includeEbay=true. The route
// allows that one flag, once, with that one value, and still refuses everything else before any vendor call.
test('price proxy forwards includeEbay=true only, once, and refuses every other extra parameter or value', async () => {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json({ data: [] });
  };
  const priceEnv = { PPT_KEY: 'synthetic-price-key' };
  const priceHeaders = { Origin: 'https://julianchow21.github.io' };
  const ask = (query) => worker.fetch(new Request('https://worker.example/ppt/cards?' + query, { headers: priceHeaders }), priceEnv);
  const UPSTREAM = 'https://www.pokemonpricetracker.com/api/v2/cards?';

  // the flag, in either position: forwarded exactly as sent, with the key still on the server side
  let response = await ask('search=Charizard&limit=3&includeEbay=true');
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, UPSTREAM + 'search=Charizard&limit=3&includeEbay=true');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer synthetic-price-key');
  response = await ask('includeEbay=true&search=Charizard%204%2F102&limit=3');
  assert.equal(response.status, 200);
  assert.equal(calls[1].url, UPSTREAM + 'includeEbay=true&search=Charizard%204%2F102&limit=3');

  // v3.85: language=japanese, alone or with the eBay flag, is forwarded exactly as sent
  response = await ask('search=Pikachu%20025&limit=3&language=japanese');
  assert.equal(response.status, 200);
  assert.equal(calls[2].url, UPSTREAM + 'search=Pikachu%20025&limit=3&language=japanese');
  response = await ask('search=Pikachu&limit=3&includeEbay=true&language=japanese');
  assert.equal(response.status, 200);
  assert.equal(calls[3].url, UPSTREAM + 'search=Pikachu&limit=3&includeEbay=true&language=japanese');
  calls.splice(2);

  // the plain two-parameter shape every released client sends is unchanged
  response = await ask('search=Charizard&limit=3');
  assert.equal(response.status, 200);
  assert.equal(calls[2].url, UPSTREAM + 'search=Charizard&limit=3');

  // a listed flag with any other value, spelled or encoded another way, is refused
  const before = calls.length;
  for (const bad of [
    'includeEbay=false', 'includeEbay=1', 'includeEbay=TRUE', 'includeEbay=True', 'includeEbay=', 'includeEbay',
    'includeEbay=%20true', 'includeEbay=true%20', 'includeEbay=truee', 'includeEbay=true%0A', 'includeEbay=yes',
    'includeEbay=true&includeEbay=true', 'includeEbay=true&includeEbay=false', 'includeEbay=false&includeEbay=true',
    'includeebay=true', 'INCLUDEEBAY=true',
    'language=english', 'language=Japanese', 'language=JAPANESE', 'language=', 'language', 'language=japanese%20',
    'language=jp', 'language=japanese&language=japanese', 'Language=japanese'
  ]) {
    response = await ask('search=Charizard&limit=3&' + bad);
    assert.equal(response.status, 400, bad + ' must be refused');
    assert.deepEqual(await response.json(), { error: 'invalid query' }, bad);
  }
  // every other vendor flag, and the keys a plain object would answer for, are refused as before
  for (const bad of [
    'includeHistory=true', 'includeBoth=true', 'days=30', 'set=Base', 'fetchAllInSet=true', 'tcgPlayerId=1',
    'sortBy=price', 'maxDataPoints=730', 'extra=1', '__proto__=true', 'constructor=true', 'toString=true', 'hasOwnProperty=true',
    'includeEbay=true&includeHistory=true', 'includeEbay=true&days=30', 'includeEbay=true&extra=1'
  ]) {
    response = await ask('search=Charizard&limit=3&' + bad);
    assert.equal(response.status, 400, bad + ' must be refused');
  }
  // the two required parameters still decide, with or without the flag
  for (const bad of [
    'limit=3&includeEbay=true', 'search=&limit=3&includeEbay=true', 'search=%20&limit=3&includeEbay=true',
    'search=Charizard&includeEbay=true', 'search=Charizard&limit=4&includeEbay=true', 'search=Charizard&limit=03&includeEbay=true',
    'search=Charizard&search=Pikachu&limit=3&includeEbay=true', 'search=Charizard&limit=3&limit=3&includeEbay=true'
  ]) {
    response = await ask(bad);
    assert.equal(response.status, 400, bad + ' must be refused');
  }
  assert.equal(calls.length, before, 'nothing refused ever reached the vendor');

  // origin and method are still checked first
  response = await worker.fetch(new Request('https://worker.example/ppt/cards?search=Charizard&limit=3&includeEbay=true', { headers: { Origin: 'https://attacker.example' } }), priceEnv);
  assert.equal(response.status, 403);
  response = await worker.fetch(new Request('https://worker.example/ppt/cards?search=Charizard&limit=3&includeEbay=true', { method: 'POST', headers: priceHeaders }), priceEnv);
  assert.equal(response.status, 405);
  assert.equal(calls.length, before);
});
