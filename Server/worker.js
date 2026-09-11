/**
 * Kujira Prices + CAS DB Proxy, reproducible server candidate
 * -------------------------------------------------------------
 * Price route:
 *   GET /ppt/cards?search=<name>&limit=3, exact-origin vendor proxy
 *
 * Authenticated sync:
 *   POST /sync/v2/pull
 *   POST /sync/v2/mutate
 *      Verifies the caller with Supabase Auth, then authorises the one
 *      configured owner before attaching the service-role credential to the
 *      protocol-2 RPC.
 *
 * Compatibility database reads:
 *   GET /db/rest/v1/<table>?<query>
 *      Exact-origin reads still require the verified owner. Authenticated
 *      compatibility reads remain available while old clients are retired.
 *
 * Direct database mutations:
 *   POST, PATCH and DELETE are always rejected with
 *      legacy_mutations_disabled, including while legacy flags are present.
 *      All application writes use /sync/v2/mutate and the transactional CAS RPC.
 *
 * Secrets:
 *   PPT_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_KEY,
 *   COLLECTIBLES_OWNER_USER_ID. Never log or return any of these values.
 *
 * Primary draft reviewed: Kujira Prices Worker v2 (3 Jun).js
 * Primary draft SHA-256: 816de318dd6c020c471abd3189f095c24881c0b7b759c05c49282bf2ea81559e
 */

const ALLOWED_ORIGIN = 'https://julianchow21.github.io';

// Tables the DB proxy will touch. Anything else is rejected.
const DB_TABLES = new Set([
  'singles', 'slabs', 'sales', 'etbs', 'booster_boxes', 'booster_packs',
  'ebay_purchases', 'trash', 'versions', 'market_prices'
]);
const DB_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const LEGACY_MUTATION_METHODS = new Set(['POST', 'PATCH', 'DELETE']);
const SYNC_PROTOCOL = 2;
const MAX_SYNC_BODY_BYTES = 2 * 1024 * 1024;

// Cache TTL for OK price responses (seconds). DB responses are never cached.
const CACHE_TTL_SECONDS = 21600;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // ── Authenticated sync protocol ───────────────────────────────
    if (url.pathname === '/sync/v2/pull') {
      return handleSync(request, env, 'pull');
    }
    if (url.pathname === '/sync/v2/mutate') {
      return handleSync(request, env, 'mutate');
    }

    // ── DB proxy ──────────────────────────────────────────────────
    if (url.pathname.startsWith('/db/rest/v1/')) {
      return handleDb(request, env, url);
    }

    // ── Price proxy (one exact GET route) ─────────────────────────
    if (!url.pathname.startsWith('/ppt/')) {
      return json({ error: 'unknown route' }, 404);
    }
    const priceOrigin = request.headers.get('Origin');
    if (!priceOrigin || priceOrigin !== ALLOWED_ORIGIN) {
      return json({ error: 'forbidden origin' }, 403);
    }
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    if (url.pathname !== '/ppt/cards') return json({ error: 'unknown route' }, 404);

    const priceKeys = [...url.searchParams.keys()];
    const validPriceQuery = priceKeys.length === 2
      && new Set(priceKeys).size === 2
      && url.searchParams.has('search')
      && url.searchParams.get('search').trim() !== ''
      && url.searchParams.get('limit') === '3';
    if (!validPriceQuery) return json({ error: 'invalid query' }, 400);

    const upstream = 'https://www.pokemonpricetracker.com/api/v2/cards' + url.search;
    const auth = 'Bearer ' + (env.PPT_KEY || '');

    const cache = caches.default;
    const cacheKey = new Request(upstream, { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) {
      const r = new Response(cached.body, cached);
      addCors(r); r.headers.set('X-Kujira-Cache', 'HIT');
      return r;
    }

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstream, {
        method: 'GET',
        headers: { 'Authorization': auth, 'Accept': 'application/json', 'User-Agent': 'KujiraCollectibles/1.0 (Cloudflare Worker)' },
        cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true }
      });
    } catch (err) {
      return json({ error: 'upstream fetch failed', detail: String(err) }, 502);
    }

    const body = await upstreamResp.arrayBuffer();
    const respHeaders = new Headers(upstreamResp.headers);
    respHeaders.set('Cache-Control', 'public, max-age=' + CACHE_TTL_SECONDS);
    Object.entries(corsHeaders()).forEach(([k, v]) => respHeaders.set(k, v));
    respHeaders.set('X-Kujira-Cache', 'MISS');
    const finalResp = new Response(body, { status: upstreamResp.status, statusText: upstreamResp.statusText, headers: respHeaders });

    if (upstreamResp.ok) {
      await cache.put(cacheKey, new Response(body, {
        status: upstreamResp.status,
        headers: { 'Content-Type': respHeaders.get('Content-Type') || 'application/json', 'Cache-Control': 'public, max-age=' + CACHE_TTL_SECONDS }
      }));
    }
    return finalResp;
  }
};

async function handleDb(request, env, url) {
  if (!DB_METHODS.has(request.method)) return json({ error: 'method not allowed' }, 405);

  // Compatibility flags never bypass the owner check. This keeps every
  // service-role database request behind Supabase Auth, including GET reads.
  const authError = await authoriseOwner(request, env);
  if (authError) return authError;
  if (LEGACY_MUTATION_METHODS.has(request.method)) {
    return json({ ok: false, code: 'legacy_mutations_disabled' }, 403);
  }

  // Path after /db → /rest/v1/<table>... . Whitelist the table.
  const rest = url.pathname.slice('/db'.length); // "/rest/v1/singles"
  const m = rest.match(/^\/rest\/v1\/([a-z0-9_]+)$/i);
  if (!m || !DB_TABLES.has(m[1])) return json({ error: 'table not allowed' }, 403);

  const target = env.SUPABASE_URL.replace(/\/$/, '') + rest + url.search;
  const headers = {
    'apikey': env.SUPABASE_SERVICE_KEY,
    'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
    'Content-Type': request.headers.get('Content-Type') || 'application/json'
  };
  const prefer = request.headers.get('Prefer');
  if (prefer) headers['Prefer'] = prefer;

  const init = { method: request.method, headers };
  // Direct POST/PATCH/DELETE mutations are denied above. This branch remains
  // GET-only for the compatibility read path and cannot forward a caller body.

  let resp;
  try {
    resp = await fetch(target, init);
  } catch (err) {
    return json({ error: 'supabase fetch failed', detail: String(err) }, 502);
  }
  const body = await resp.arrayBuffer();
  const h = new Headers(resp.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => h.set(k, v));
  h.set('Cache-Control', 'no-store'); // never cache data
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers: h });
}

async function handleSync(request, env, action) {
  if (request.method !== 'POST') return json({ ok: false, code: 'method_not_allowed' }, 405);

  const authError = await authoriseOwner(request, env);
  if (authError) return authError;

  const lengthHeader = request.headers.get('Content-Length');
  if (lengthHeader && Number(lengthHeader) > MAX_SYNC_BODY_BYTES) {
    return json({ ok: false, code: 'request_too_large' }, 413);
  }

  let raw, payload;
  try {
    raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_SYNC_BODY_BYTES) {
      return json({ ok: false, code: 'request_too_large' }, 413);
    }
    payload = JSON.parse(raw);
  } catch (_) {
    return json({ ok: false, code: 'invalid_json' }, 400);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return json({ ok: false, code: 'invalid_request' }, 400);
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'client_protocol')) {
    return json({ ok: false, code: 'protocol_required' }, 428);
  }
  if (payload.client_protocol !== SYNC_PROTOCOL) {
    return json({ ok: false, code: 'protocol_mismatch', server_protocol: SYNC_PROTOCOL }, 428);
  }
  if (action === 'pull' && Object.keys(payload).some(key => key !== 'client_protocol')) {
    return json({ ok: false, code: 'invalid_request' }, 400);
  }

  const rpcName = action === 'pull' ? 'collectibles_pull_v2' : 'collectibles_mutate_v2';
  const rpcBody = action === 'pull'
    ? { p_client_protocol: payload.client_protocol }
    : { p_request: payload };
  const target = env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/' + rpcName;
  let upstream;
  try {
    upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SERVICE_KEY,
        'Authorization': 'Bearer ' + env.SUPABASE_SERVICE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(rpcBody)
    });
  } catch (_) {
    return json({ ok: false, code: 'sync_upstream_unavailable' }, 502);
  }

  let result;
  try { result = await upstream.json(); }
  catch (_) { return json({ ok: false, code: 'sync_upstream_invalid' }, 502); }

  if (!upstream.ok) {
    return json({ ok: false, code: 'sync_upstream_error' }, upstream.status >= 500 ? 502 : 500);
  }
  return json(result, syncStatus(result));
}

async function authoriseOwner(request, env) {
  const originError = requireExactOrigin(request);
  if (originError) return originError;
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return json({ ok: false, code: 'authentication_required' }, 401);

  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY ||
      !env.SUPABASE_SERVICE_KEY || !env.COLLECTIBLES_OWNER_USER_ID) {
    return json({ ok: false, code: 'db_proxy_not_configured' }, 500);
  }

  let response;
  try {
    response = await fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/auth/v1/user', {
      method: 'GET',
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + match[1]
      }
    });
  } catch (_) {
    return json({ ok: false, code: 'auth_upstream_unavailable' }, 502);
  }
  if (response.status === 401 || response.status === 403) {
    return json({ ok: false, code: 'invalid_token' }, 401);
  }
  if (!response.ok) return json({ ok: false, code: 'auth_upstream_error' }, 502);

  let user;
  try { user = await response.json(); }
  catch (_) { return json({ ok: false, code: 'auth_upstream_invalid' }, 502); }
  if (!user || typeof user.id !== 'string') {
    return json({ ok: false, code: 'invalid_token' }, 401);
  }
  if (user.id !== env.COLLECTIBLES_OWNER_USER_ID) {
    return json({ ok: false, code: 'owner_forbidden' }, 403);
  }
  return null;
}

function requireExactOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== ALLOWED_ORIGIN) {
    return json({ ok: false, code: 'forbidden_origin' }, 403);
  }
  return null;
}

function syncStatus(result) {
  if (!result || result.ok !== false) return 200;
  if (result.code === 'version_conflict' || result.code === 'mutation_id_reused' || result.code === 'state_conflict') return 409;
  if (result.code === 'missing_expected_version' || result.code === 'protocol_required' || result.code === 'protocol_mismatch') return 428;
  return 400;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey, Prefer',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
function addCors(r) { const h = corsHeaders(); for (const k in h) r.headers.set(k, h[k]); }
function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}
