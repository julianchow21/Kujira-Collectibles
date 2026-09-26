/*
 * Dealer Desk production store.
 *
 * This module deliberately has no dependency on DB, markDirty, DealerDesk, or
 * the generic inventory cache.  It keeps only owner-scoped server snapshots,
 * candidate form drafts, and command envelopes which are waiting for an
 * authoritative server result.  The bearer is supplied by app.js through the
 * owner fetch facade and never reaches this module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(globalThis);
  else root.DealerStore = factory(root);
}(typeof globalThis !== 'undefined' ? globalThis : this, function createDealerStoreModule(root) {
  'use strict';

  const CLIENT_PROTOCOL = 2;
  const SCHEMA_VERSION = 1;
  const MAX_PAGE_SIZE = 50;
  const CACHE_PREFIX = 'kjr-dealer-production-v1:';
  const COMMAND_KEY_MARKER = ':command:';
  const DRAFT_KEY_MARKER = ':draft:';
  const COMMANDS = new Set([
    'create_candidate', 'update_candidate', 'add_evidence', 'create_plan',
    'approve_buy', 'acquire_copy', 'link_copy', 'set_asking',
    'prepare_listing', 'record_sale', 'settle_sale', 'record_non_sale',
    'review_outcome'
  ]);

  function clone(value) {
    if (value === undefined) return undefined;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  function now() { return new Date().toISOString(); }

  function errorResult(code, message, extra) {
    const err = new Error(message || code);
    err.code = code;
    if (extra && typeof extra === 'object') Object.assign(err, extra);
    return err;
  }

  function randomId() {
    try {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    } catch (_) {}
    const bytes = [];
    for (let index = 0; index < 16; index += 1) bytes.push(Math.floor(Math.random() * 256));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.map(value => value.toString(16).padStart(2, '0')).join('');
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
  }

  function storageFor(value) {
    if (value && typeof value.getItem === 'function' && typeof value.setItem === 'function') return value;
    try {
      if (root.localStorage && typeof root.localStorage.getItem === 'function') return root.localStorage;
    } catch (_) {}
    return null;
  }

  function contextFrom(value) {
    const context = value && typeof value === 'object' ? value : {};
    const userId = typeof context.userId === 'string' && context.userId
      ? context.userId
      : (typeof context.ownerId === 'string' && context.ownerId ? context.ownerId : null);
    const sessionId = typeof context.sessionId === 'string' && context.sessionId ? context.sessionId : null;
    const generation = Number.isSafeInteger(context.generation) ? context.generation : 0;
    const authenticated = context.authenticated === false ? false : (context.authenticated === true || !!userId);
    return {
      authenticated,
      userId,
      sessionId,
      generation,
      verified: context.verified !== false,
      offline: context.offline === true || (typeof navigator !== 'undefined' && navigator.onLine === false)
    };
  }

  function defaultOwnerContext() {
    try {
      if (typeof root.kjrOwnerContext === 'function') return root.kjrOwnerContext();
      if (root.kjrOwnerContext && typeof root.kjrOwnerContext === 'object') return root.kjrOwnerContext;
    } catch (_) {}
    return null;
  }

  function defaultPullRequest(input) {
    return {
      client_protocol: CLIENT_PROTOCOL,
      schema_version: SCHEMA_VERSION,
      cursor: input.cursor == null ? null : String(input.cursor),
      limit: Math.min(MAX_PAGE_SIZE, Math.max(1, Number(input.limit) || MAX_PAGE_SIZE)),
      candidateId: input.candidateId == null || input.candidateId === '' ? null : String(input.candidateId)
    };
  }

  function defaultCommandRequest(input) {
    return {
      client_protocol: CLIENT_PROTOCOL,
      schema_version: SCHEMA_VERSION,
      command_id: input.commandId,
      command: input.command,
      expected: clone(input.expectedVersions || {}),
      payload: clone(input.payload || {})
    };
  }

  function defaultTransport() {
    return {
      pull: function (request) {
        const ownerFetch = root.kjrDealerOwnerFetch;
        if (typeof ownerFetch !== 'function') return Promise.reject(errorResult('owner_transport_unavailable', 'Dealer Desk owner transport is unavailable, reload after signing in'));
        return ownerFetch({ endpoint: 'pull', body: request.body, signal: request.signal, generation: request.context.generation });
      },
      command: function (request) {
        const ownerFetch = root.kjrDealerOwnerFetch;
        if (typeof ownerFetch !== 'function') return Promise.reject(errorResult('owner_transport_unavailable', 'Dealer Desk owner transport is unavailable, reload after signing in'));
        return ownerFetch({ endpoint: 'command', body: request.body, signal: request.signal, generation: request.context.generation });
      }
    };
  }

  function responseBody(value) {
    if (!value || typeof value !== 'object') return value;
    if (value.body && typeof value.body === 'object') return value.body;
    return value;
  }

  function responseFailure(body, status) {
    const source = responseBody(body) || {};
    const failure = source.failure && typeof source.failure === 'object' ? source.failure : source.error;
    const code = (failure && (failure.code || failure.type)) || source.code || (status === 409 ? 'conflict' : null);
    if (source.ok === false || code) {
      const message = (failure && (failure.message || failure.detail)) || source.message || 'Dealer Desk command was rejected by the server';
      return errorResult(String(code || 'server_rejected'), String(message), {
        status: status || source.status,
        current: clone(source.current || source.current_version || source.currentVersion || null),
        attempted: clone(source.attempted || source.attempted_payload || null),
        body: clone(source)
      });
    }
    return null;
  }

  function uncertainFailureCode(code) {
    return ['sync_upstream_unavailable', 'sync_upstream_invalid', 'sync_upstream_error', 'schema_mismatch'].includes(String(code || ''));
  }

  function protocolOf(body) {
    const source = responseBody(body) || {};
    return source.client_protocol == null ? source.clientProtocol : source.client_protocol;
  }

  function schemaOf(body) {
    const source = responseBody(body) || {};
    return source.schema_version == null ? source.schemaVersion : source.schema_version;
  }

  function normalisePull(body, ownerId, candidateId) {
    const source = responseBody(body) || {};
    const failure = responseFailure(source);
    if (failure) throw failure;
    if (protocolOf(source) !== CLIENT_PROTOCOL || schemaOf(source) !== SCHEMA_VERSION) {
      throw errorResult('schema_mismatch', 'Dealer Desk data schema is unsupported, reload after the server is upgraded', {
        receivedProtocol: protocolOf(source), receivedSchema: schemaOf(source)
      });
    }
    if (source.owner_id && String(source.owner_id) !== String(ownerId)) throw errorResult('owner_forbidden', 'Dealer Desk returned data for another owner');
    const data = source.data && typeof source.data === 'object' ? source.data :
      (source.result && typeof source.result === 'object' ? source.result : source);
    const candidates = Array.isArray(data.candidates) ? data.candidates : [];
    const selected = data.selected == null
      ? (data.selected_candidate == null
        ? (data.selectedCandidate == null ? (data.candidate_detail == null ? data.candidateDetail : data.candidate_detail) : data.selectedCandidate)
        : data.selected_candidate)
      : data.selected;
    const selectedCandidateValue = selected && typeof selected === 'object' && selected.candidate && typeof selected.candidate === 'object'
      ? selected.candidate
      : selected;
    const selectedCandidate = selected == null && candidateId
      ? candidates.find(item => item && String(item.id) === String(candidateId)) || null
      : clone(selectedCandidateValue);
    const cursor = data.next_cursor == null ? (data.nextCursor == null ? null : data.nextCursor) : data.next_cursor;
    return {
      ownerId: ownerId,
      clientProtocol: CLIENT_PROTOCOL,
      schemaVersion: SCHEMA_VERSION,
      candidates: clone(candidates),
      selectedCandidate: selectedCandidate == null ? null : clone(selectedCandidate),
      selectedDetail: selected && typeof selected === 'object' && selected.candidate ? clone(selected) : null,
      canonicalRefs: Array.isArray(data.canonicalRefs) ? clone(data.canonicalRefs) : [],
      nextCursor: cursor == null || cursor === '' ? null : String(cursor),
      revisions: clone(data.revisions || {}) || {},
      fetchedAt: now()
    };
  }

  function commandResult(body) {
    const source = responseBody(body) || {};
    const failure = responseFailure(source);
    if (failure) throw failure;
    if (protocolOf(source) !== CLIENT_PROTOCOL || schemaOf(source) !== SCHEMA_VERSION) {
      throw errorResult('schema_mismatch', 'Dealer Desk command schema is unsupported, reload after the server is upgraded', {
        receivedProtocol: protocolOf(source), receivedSchema: schemaOf(source)
      });
    }
    const result = source.result && typeof source.result === 'object' ? source.result : source;
    const record = result.record || result.candidate || result.selected_candidate || result.selectedCandidate || null;
    return {
      ok: true,
      confirmed: true,
      status: 'confirmed',
      record: clone(record),
      candidate: clone(result.candidate || (record && record.id ? record : null)),
      revisions: clone(result.revisions || {}) || {},
      body: clone(source)
    };
  }

  function createStore(options) {
    const config = options && typeof options === 'object' ? options : {};
    const storage = storageFor(config.storage);
    const ownerContext = config.ownerContext || defaultOwnerContext;
    const transport = config.transport || defaultTransport();
    const buildPullRequest = config.buildPullRequest || defaultPullRequest;
    const buildCommandRequest = config.buildCommandRequest || defaultCommandRequest;
    const instanceId = randomId();
    const state = {
      ownerId: null,
      generation: null,
      sessionId: null,
      snapshot: null,
      stale: false,
      schemaKnown: false,
      schemaBlocked: null,
      drafts: {},
      pending: {},
      removedDrafts: new Map(),
      removedPending: new Map(),
      lastResult: null,
      active: new Map(),
      busyKeys: new Set(),
      listeners: new Set()
    };

    function notify() {
      const value = view();
      state.listeners.forEach(listener => {
        try { listener(value); } catch (_) {}
      });
    }

    function cacheKey(ownerId) { return CACHE_PREFIX + encodeURIComponent(String(ownerId)); }

    function indexedKey(ownerId, marker, id) {
      return cacheKey(ownerId) + marker + encodeURIComponent(String(id));
    }

    function storageKeys(prefix) {
      const keys = [];
      if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') return keys;
      for (let index = 0; index < storage.length; index += 1) {
        let key = null;
        try { key = storage.key(index); } catch (_) { key = null; }
        if (key && key.indexOf(prefix) === 0) keys.push(key);
      }
      return keys;
    }

    function readJson(key) {
      if (!storage) return null;
      try {
        const value = JSON.parse(storage.getItem(key) || 'null');
        return value && typeof value === 'object' ? value : null;
      } catch (_) { return null; }
    }

    function readOwnerCache(ownerId) {
      const value = readJson(cacheKey(ownerId));
      return value && value.owner_id === ownerId && value.schema_version === SCHEMA_VERSION ? value : null;
    }

    function readIndexed(ownerId, marker) {
      const entries = {};
      const prefix = cacheKey(ownerId) + marker;
      storageKeys(prefix).forEach(key => {
        const value = readJson(key);
        if (!value || value.owner_id !== ownerId || value.schema_version !== SCHEMA_VERSION) return;
        const id = value.id == null ? null : String(value.id);
        if (id) entries[id] = value.entry && typeof value.entry === 'object' ? value.entry : value;
      });
      return entries;
    }

    function mapValue(value) { return value && typeof value === 'object' ? value : {}; }

    function removalMap(value) {
      const output = {};
      Object.keys(mapValue(value)).forEach(id => {
        if (mapValue(value)[id]) output[id] = String(mapValue(value)[id]);
      });
      return output;
    }

    function mergeRemovalMaps(remote, local) {
      const merged = removalMap(remote);
      local.forEach((stamp, id) => {
        const value = String(stamp || '');
        if (!merged[id] || value > merged[id]) merged[id] = value;
      });
      return merged;
    }

    function stampOf(entry) {
      if (!entry || typeof entry !== 'object') return '';
      return String(entry.updatedAt || entry.updated_at || entry.lastAttemptAt || entry.createdAt || '');
    }

    function withoutDraftConflicts(draft) {
      if (!draft || typeof draft !== 'object') return draft;
      const value = clone(draft) || {};
      delete value.conflicts;
      return value;
    }

    function draftCoreEqual(left, right) {
      try { return JSON.stringify(withoutDraftConflicts(left)) === JSON.stringify(withoutDraftConflicts(right)); } catch (_) { return false; }
    }

    function conflictEntry(draft) {
      return withoutDraftConflicts(draft);
    }

    function mergeDraftRecord(local, remote) {
      if (!local) return clone(remote);
      if (!remote) return clone(local);
      if (draftCoreEqual(local, remote)) {
        const merged = clone(local) || {};
        const conflicts = [];
        (Array.isArray(remote.conflicts) ? remote.conflicts : []).forEach(item => conflicts.push(clone(item)));
        (Array.isArray(local.conflicts) ? local.conflicts : []).forEach(item => conflicts.push(clone(item)));
        if (conflicts.length) merged.conflicts = conflicts.slice(-8);
        return merged;
      }
      const localStamp = stampOf(local);
      const remoteStamp = stampOf(remote);
      const winner = localStamp >= remoteStamp ? clone(local) : clone(remote);
      const loser = localStamp >= remoteStamp ? remote : local;
      const conflicts = [];
      (Array.isArray(winner.conflicts) ? winner.conflicts : []).forEach(item => conflicts.push(clone(item)));
      (Array.isArray(loser.conflicts) ? loser.conflicts : []).forEach(item => conflicts.push(clone(item)));
      const losingCore = conflictEntry(loser);
      if (!conflicts.some(item => draftCoreEqual(item, losingCore))) conflicts.push(losingCore);
      winner.conflicts = conflicts.slice(-8);
      return winner;
    }

    function mergeEntryMaps(remote, local, removals) {
      const merged = {};
      Object.keys(mapValue(remote)).forEach(id => {
        const entry = mapValue(remote)[id];
        const removedAt = removals[id];
        if (!removedAt || stampOf(entry) > removedAt) merged[id] = clone(entry);
      });
      Object.keys(mapValue(local)).forEach(id => {
        const entry = mapValue(local)[id];
        const removedAt = removals[id];
        if (removedAt && stampOf(entry) <= removedAt) {
          delete merged[id];
          return;
        }
        merged[id] = clone(entry);
      });
      return merged;
    }

    function mergeDraftMaps(remote, local, removals) {
      const merged = {};
      Object.keys(mapValue(remote)).forEach(id => {
        const draft = mapValue(remote)[id];
        const removedAt = removals[id];
        if (!removedAt || stampOf(draft) > removedAt) merged[id] = clone(draft);
      });
      Object.keys(mapValue(local)).forEach(id => {
        const draft = mapValue(local)[id];
        const removedAt = removals[id];
        if (removedAt && stampOf(draft) <= removedAt) {
          delete merged[id];
          return;
        }
        merged[id] = mergeDraftRecord(draft, merged[id]);
      });
      return merged;
    }

    function writeIndexed(ownerId, marker, values) {
      if (!storage) return true;
      const prefix = cacheKey(ownerId) + marker;
      const keep = new Set(Object.keys(values || {}).map(id => indexedKey(ownerId, marker, id)));
      storageKeys(prefix).forEach(key => {
        if (!keep.has(key)) {
          try { storage.removeItem(key); } catch (_) { throw _; }
        }
      });
      Object.keys(values || {}).forEach(id => {
        const value = {
          owner_id: ownerId,
          schema_version: SCHEMA_VERSION,
          id,
          entry: clone(values[id])
        };
        storage.setItem(indexedKey(ownerId, marker, id), JSON.stringify(value));
      });
      return true;
    }

    function removeOwnerKeys(ownerId) {
      if (!storage || !ownerId) return;
      const prefix = cacheKey(ownerId);
      const cache = readOwnerCache(ownerId) || {};
      const commandIds = Object.keys(mapValue(cache.pending));
      const draftIds = Object.keys(mapValue(cache.drafts));
      const keys = [prefix]
        .concat(commandIds.map(id => indexedKey(ownerId, COMMAND_KEY_MARKER, id)))
        .concat(draftIds.map(id => indexedKey(ownerId, DRAFT_KEY_MARKER, id)))
        .concat(storageKeys(prefix + COMMAND_KEY_MARKER), storageKeys(prefix + DRAFT_KEY_MARKER));
      keys.forEach(key => { try { storage.removeItem(key); } catch (_) {} });
    }

    function persist() {
      // The browser production store must prove a durable envelope before a
      // financial command leaves the app. Node-only unit stores intentionally
      // omit storage, so they remain transport-testable without weakening the
      // browser path where document/localStorage are present.
      if (!state.ownerId) return false;
      if (!storage) return !(root && root.document);
      const ownerId = state.ownerId;
      const remote = readOwnerCache(ownerId) || {};
      const indexedPending = readIndexed(ownerId, COMMAND_KEY_MARKER);
      const indexedDrafts = readIndexed(ownerId, DRAFT_KEY_MARKER);
      const remotePending = Object.assign({}, mapValue(remote.pending), indexedPending);
      const remoteDrafts = Object.assign({}, mapValue(remote.drafts), indexedDrafts);
      const removedPending = mergeRemovalMaps(remote.removed_pending, state.removedPending);
      const removedDrafts = mergeRemovalMaps(remote.removed_drafts, state.removedDrafts);
      const mergedPending = mergeEntryMaps(remotePending, state.pending, removedPending);
      const mergedDrafts = mergeDraftMaps(remoteDrafts, state.drafts, removedDrafts);
      state.pending = mergedPending;
      state.drafts = mergedDrafts;
      const value = {
        owner_id: ownerId,
        schema_version: SCHEMA_VERSION,
        snapshot: clone(state.snapshot),
        stale: !!state.stale,
        schema_known: !!state.schemaKnown,
        drafts: clone(mergedDrafts) || {},
        pending: clone(mergedPending) || {},
        removed_drafts: removedDrafts,
        removed_pending: removedPending,
        updated_at: now()
      };
      try {
        // Indexed entries are the durable recovery records. The compatibility
        // owner cache is written after them, so a quota failure cannot release
        // a command to the network without a per-command copy first.
        writeIndexed(ownerId, COMMAND_KEY_MARKER, mergedPending);
        writeIndexed(ownerId, DRAFT_KEY_MARKER, mergedDrafts);
        storage.setItem(cacheKey(ownerId), JSON.stringify(value));
        return true;
      } catch (_) { return false; }
    }

    function load(ownerId) {
      if (!storage) return;
      const value = readOwnerCache(ownerId) || {};
      const indexedPending = readIndexed(ownerId, COMMAND_KEY_MARKER);
      const indexedDrafts = readIndexed(ownerId, DRAFT_KEY_MARKER);
      const hasOwnerData = !!readOwnerCache(ownerId) || Object.keys(indexedPending).length > 0 || Object.keys(indexedDrafts).length > 0;
      if (!hasOwnerData) return;
      state.removedPending = new Map(Object.entries(removalMap(value.removed_pending)));
      state.removedDrafts = new Map(Object.entries(removalMap(value.removed_drafts)));
      const removedPending = removalMap(value.removed_pending);
      const removedDrafts = removalMap(value.removed_drafts);
      state.snapshot = value.snapshot && typeof value.snapshot === 'object' ? value.snapshot : null;
      // A persisted snapshot has not been revalidated in this tab yet. Keep
      // it viewable, but label it stale until a successful pull confirms it.
      state.stale = !!state.snapshot;
      state.schemaKnown = value.schema_known === true && !!state.snapshot;
      state.drafts = mergeDraftMaps(Object.assign({}, mapValue(value.drafts), indexedDrafts), {}, removedDrafts);
      state.pending = mergeEntryMaps(Object.assign({}, mapValue(value.pending), indexedPending), {}, removedPending);
      let changed = false;
      Object.keys(state.pending).forEach(commandId => {
        const entry = state.pending[commandId];
        if (!entry || typeof entry !== 'object') return;
        // A persisted pending/in-flight envelope may have reached the server
        // before a tab closed. Treat both states as unknown so the same UUID
        // remains retryable after reload, never silently inventing a new one.
        if (entry.status === 'pending' || entry.status === 'in_flight') {
          entry.status = 'unknown';
          entry.failure = { code: 'unknown_after_reload', message: 'The previous tab closed before the server result was known' };
          entry.updatedAt = now();
          changed = true;
        }
      });
      if (changed) persist();
    }

    function readContext() {
      let raw;
      try { raw = typeof ownerContext === 'function' ? ownerContext() : ownerContext; } catch (_) { raw = null; }
      return contextFrom(raw);
    }

    function adopt(context) {
      if (!context.authenticated || !context.userId || context.verified === false) throw errorResult('owner_session_required', 'Dealer Desk needs a verified owner session');
      if (state.ownerId !== context.userId) {
        state.active.forEach(controller => { try { controller.abort(); } catch (_) {} });
        state.active.clear();
        state.ownerId = context.userId;
        state.snapshot = null;
        state.stale = false;
        state.schemaKnown = false;
        state.schemaBlocked = null;
        state.drafts = {};
        state.pending = {};
        state.removedDrafts = new Map();
        state.removedPending = new Map();
        load(context.userId);
      }
      state.generation = context.generation;
      state.sessionId = context.sessionId;
      return context;
    }

    function requireOwner() {
      const context = adopt(readContext());
      return context;
    }

    function stillCurrent(context) {
      const current = readContext();
      return current.authenticated && current.userId === context.userId && current.sessionId === context.sessionId && current.generation === context.generation && state.ownerId === context.userId;
    }

    function sameOwnerSession(context) {
      const current = readContext();
      return current.authenticated && current.userId === context.userId && current.sessionId === context.sessionId && state.ownerId === context.userId;
    }

    function view() {
      const context = readContext();
      const ownerVisible = !!state.ownerId && context.authenticated && context.userId === state.ownerId;
      return {
        ok: ownerVisible,
        ownerId: state.ownerId,
        stale: !!state.stale,
        online: !context.offline,
        schemaKnown: !!state.schemaKnown,
        schemaBlocked: state.schemaBlocked,
        snapshot: ownerVisible ? clone(state.snapshot) : null,
        drafts: ownerVisible ? (clone(state.drafts) || {}) : {},
        pending: ownerVisible ? (clone(state.pending) || {}) : {},
        lastResult: ownerVisible ? clone(state.lastResult) : null,
        unsyncedCount: Object.keys(state.drafts).length + Object.keys(state.pending).length
      };
    }

    async function invoke(kind, request, context) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      if (controller && request.signal) {
        try { request.signal.addEventListener('abort', () => controller.abort(), { once: true }); } catch (_) {}
      }
      const signal = controller ? controller.signal : request.signal;
      const activeKey = request.commandId || kind + ':' + Date.now();
      if (controller) state.active.set(activeKey, controller);
      try {
        if (typeof transport[kind] === 'function') return await transport[kind](Object.assign({}, request, { signal, context }));
        if (typeof transport.request === 'function') return await transport.request(Object.assign({}, request, { kind, signal, context }));
        throw errorResult('owner_transport_unavailable', 'Dealer Desk owner transport is unavailable, reload after signing in');
      } finally {
        if (controller) state.active.delete(activeKey);
      }
    }

    function busyResult() {
      return { ok: false, status: 'busy', code: 'busy', message: 'That Dealer Desk action is already saving' };
    }

    async function withBusyKey(key, operation) {
      const busyKey = String(key || 'command');
      if (state.busyKeys.has(busyKey)) return busyResult();
      state.busyKeys.add(busyKey);
      try { return await operation(); } finally { state.busyKeys.delete(busyKey); }
    }

    async function init() {
      requireOwner();
      return view();
    }

    async function pull(input) {
      const params = input && typeof input === 'object' ? input : {};
      const context = requireOwner();
      const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.limit) || MAX_PAGE_SIZE));
      if (context.offline) {
        state.stale = !!state.snapshot;
        persist();
        notify();
        return state.snapshot
          ? { ok: true, status: 'stale', code: 'offline_view', stale: true, snapshot: clone(state.snapshot) }
          : { ok: false, status: 'blocked_offline', code: 'offline_no_cache', message: 'Dealer Desk needs one online load before offline viewing is available' };
      }
      const body = buildPullRequest({
        cursor: params.cursor == null ? null : params.cursor,
        candidateId: params.candidateId == null ? null : params.candidateId,
        limit
      });
      let response;
      try {
        response = await invoke('pull', { endpoint: 'pull', body: clone(body), signal: params.signal }, context);
      } catch (cause) {
        if (!stillCurrent(context)) throw errorResult('owner_changed', 'The owner session changed while Dealer Desk was loading');
        if (context.offline && state.snapshot) {
          state.stale = true;
          persist();
          notify();
          return { ok: true, status: 'stale', code: 'offline_view', stale: true, snapshot: clone(state.snapshot) };
        }
        if (state.snapshot) {
          // navigator.onLine can remain true while the Worker, auth layer, or
          // network path is unavailable. Never leave an old snapshot looking
          // authoritative after an unsuccessful revalidation.
          state.stale = true;
          persist();
          notify();
        }
        throw cause && cause.code ? cause : errorResult('pull_failed', cause && cause.message || 'Dealer Desk records could not be loaded');
      }
      if (!stillCurrent(context)) throw errorResult('owner_changed', 'The owner session changed while Dealer Desk was loading');
      try {
        const snapshot = normalisePull(response, context.userId, params.candidateId);
        state.snapshot = snapshot;
        state.stale = false;
        state.schemaKnown = true;
        state.schemaBlocked = null;
        persist();
        notify();
        return { ok: true, status: 'confirmed', stale: false, snapshot: clone(snapshot) };
      } catch (cause) {
        if (cause && cause.code === 'schema_mismatch') state.schemaBlocked = cause.message;
        persist();
        notify();
        throw cause;
      }
    }

    function saveDraft(candidateId, fields, stage) {
      const context = requireOwner();
      const id = candidateId == null || candidateId === '' ? 'new' : String(candidateId);
      const updatedAt = now();
      state.removedDrafts.delete(id);
      const previous = state.drafts[id] && typeof state.drafts[id] === 'object' ? state.drafts[id] : null;
      const next = { ownerId: context.userId, fields: clone(fields || {}) || {}, stage: clone(stage || {}) || {}, updatedAt, sourceId: instanceId, localOnly: true };
      const retained = [];
      const addVariant = variant => {
        const candidate = withoutDraftConflicts(variant);
        if (!candidate || retained.some(item => draftCoreEqual(item, candidate))) return;
        retained.push(clone(candidate));
      };
      if (previous) {
        const previousCore = withoutDraftConflicts(previous);
        if (!draftCoreEqual(previousCore, next)) addVariant(previousCore);
        (Array.isArray(previous.conflicts) ? previous.conflicts : []).forEach(addVariant);
      }
      if (retained.length) next.conflicts = retained.slice(-8);
      state.drafts[id] = next;
      const durable = persist();
      notify();
      return durable
        ? { ok: true, status: 'draft_local', candidateId: id, draft: clone(state.drafts[id]) }
        : { ok: false, status: 'storage_blocked', code: 'storage_unavailable', candidateId: id, message: 'This local draft could not be saved. Free browser storage and try again.' };
    }

    function restoreDraft(candidateId, variantIndex) {
      const context = requireOwner();
      const id = candidateId == null || candidateId === '' ? 'new' : String(candidateId);
      const current = state.drafts[id] && typeof state.drafts[id] === 'object' ? state.drafts[id] : null;
      if (!current) return { ok: false, status: 'failed', code: 'draft_not_found', message: 'That local draft is no longer available.' };
      const alternates = Array.isArray(current.conflicts) ? current.conflicts : [];
      const index = Number(variantIndex);
      const chosen = Number.isInteger(index) && index >= 0 && index < alternates.length ? alternates[index] : current;
      const chosenCore = withoutDraftConflicts(chosen) || {};
      const variants = [];
      const addVariant = variant => {
        const candidate = withoutDraftConflicts(variant);
        if (!candidate || draftCoreEqual(candidate, chosenCore) || variants.some(item => draftCoreEqual(item, candidate))) return;
        variants.push(clone(candidate));
      };
      addVariant(current);
      alternates.forEach(addVariant);
      const next = Object.assign({}, chosenCore, {
        ownerId: context.userId,
        updatedAt: now(),
        sourceId: instanceId,
        localOnly: true,
        conflictChoice: Number.isInteger(index) && index >= 0 ? 'alternate' : 'current'
      });
      if (variants.length) next.conflicts = variants.slice(-8);
      state.removedDrafts.delete(id);
      state.drafts[id] = next;
      const durable = persist();
      notify();
      return durable
        ? { ok: true, status: 'draft_restored', candidateId: id, draft: clone(next) }
        : { ok: false, status: 'storage_blocked', code: 'storage_unavailable', candidateId: id, message: 'This draft choice could not be saved safely.' };
    }

    function clearDraft(candidateId) {
      requireOwner();
      const id = candidateId == null || candidateId === '' ? 'new' : String(candidateId);
      delete state.drafts[id];
      state.removedDrafts.set(id, now());
      persist();
      notify();
      return { ok: true };
    }

    function pendingEnvelope(commandId) { return commandId && state.pending[String(commandId)] ? state.pending[String(commandId)] : null; }

    function persistedUnsyncedCount(ownerId) {
      if (!storage || !ownerId) return 0;
      try {
        const value = readOwnerCache(ownerId) || {};
        const removedDrafts = removalMap(value.removed_drafts);
        const removedPending = removalMap(value.removed_pending);
        const drafts = mergeDraftMaps(Object.assign({}, mapValue(value.drafts), readIndexed(ownerId, DRAFT_KEY_MARKER)), {}, removedDrafts);
        const pending = mergeEntryMaps(Object.assign({}, mapValue(value.pending), readIndexed(ownerId, COMMAND_KEY_MARKER)), {}, removedPending);
        return Object.keys(drafts).length + Object.keys(pending).length;
      } catch (_) { return 0; }
    }

    async function sendEnvelope(entry, context) {
      if (entry.status === 'conflict') return { ok: false, status: 'conflict', code: 'conflict_review_required', message: 'Review the current server version before retrying this command', current: clone(entry.current), attempted: clone(entry.payload), commandId: entry.commandId };
      const priorStatus = entry.status;
      entry.status = 'in_flight';
      entry.attempts = (Number(entry.attempts) || 0) + 1;
      entry.lastAttemptAt = now();
      entry.updatedAt = entry.lastAttemptAt;
      state.pending[entry.commandId] = entry;
      if (!persist()) {
        entry.status = 'unknown';
        entry.failure = { code: 'storage_unavailable', message: 'Dealer Desk could not save the exact command envelope. Free browser storage before retrying.' };
        entry.updatedAt = now();
        state.pending[entry.commandId] = entry;
        notify();
        return { ok: false, status: 'storage_blocked', code: 'storage_unavailable', message: entry.failure.message, commandId: entry.commandId, attempted: clone(entry.payload) };
      }
      notify();
      let response;
      try {
        response = await invoke('command', { endpoint: 'command', body: clone(entry.wire), commandId: entry.commandId }, context);
      } catch (cause) {
        if (!stillCurrent(context) && !sameOwnerSession(context)) throw errorResult('owner_changed', 'The owner session changed while Dealer Desk was saving');
        entry.status = 'unknown';
        entry.failure = { code: sameOwnerSession(context) ? 'unknown_response' : 'owner_changed', message: cause && cause.message || 'The server response was not received' };
        entry.updatedAt = now();
        state.pending[entry.commandId] = entry;
        persist();
        notify();
        return { ok: false, status: 'unknown', code: 'unknown_response', message: 'The server response was not received. Retry the same command when online.', commandId: entry.commandId, payload: clone(entry.wire) };
      }
      if (!stillCurrent(context)) {
        if (!sameOwnerSession(context)) throw errorResult('owner_changed', 'The owner session changed while Dealer Desk was saving');
        entry.status = 'unknown';
        entry.failure = { code: 'unknown_response', message: 'The session refreshed before the server result could be trusted. Retry the same command.' };
        entry.updatedAt = now();
        state.pending[entry.commandId] = entry;
        persist();
        notify();
        return { ok: false, status: 'unknown', code: 'unknown_response', message: entry.failure.message, commandId: entry.commandId, payload: clone(entry.wire) };
      }
      try {
        const result = commandResult(response);
        delete state.pending[entry.commandId];
        state.removedPending.set(entry.commandId, now());
        state.lastResult = Object.assign({}, result, { commandId: entry.commandId, command: entry.command });
        if (!persist()) {
          state.removedPending.delete(entry.commandId);
          entry.status = 'unknown';
          entry.failure = { code: 'storage_unavailable', message: 'The server result was received, but the exact receipt could not be saved. Retry the same command after freeing browser storage.' };
          entry.updatedAt = now();
          state.pending[entry.commandId] = entry;
          persist();
          notify();
          return { ok: false, status: 'unknown', code: 'storage_unavailable', message: entry.failure.message, commandId: entry.commandId, payload: clone(entry.wire) };
        }
        notify();
        return Object.assign({}, result, { commandId: entry.commandId, command: entry.command });
      } catch (cause) {
        if (cause && cause.code === 'schema_mismatch') state.schemaBlocked = cause.message;
        const code = String(cause && cause.code || 'server_rejected');
        const conflict = code === 'conflict' || code === 'version_conflict' || code === 'expected_version_mismatch';
        const uncertain = uncertainFailureCode(code);
        entry.status = conflict ? 'conflict' : uncertain ? 'unknown' : 'failed';
        entry.failure = { code, message: cause && cause.message || 'Dealer Desk command was rejected' };
        entry.current = clone(cause && cause.current);
        entry.attempted = clone(cause && cause.attempted) || clone(entry.payload);
        entry.updatedAt = now();
        state.pending[entry.commandId] = entry;
        persist();
        notify();
        return {
          ok: false,
          status: conflict ? 'conflict' : uncertain ? 'unknown' : 'failed',
          code,
          message: entry.failure.message,
          current: clone(entry.current),
          attempted: clone(entry.attempted),
          commandId: entry.commandId
        };
      }
    }

    async function command(command, payload, options) {
      const params = options && typeof options === 'object' ? options : {};
      const context = requireOwner();
      if (!COMMANDS.has(String(command))) return { ok: false, status: 'failed', code: 'unsupported_command', message: 'Dealer Desk command is not supported' };
      if (context.offline) return { ok: false, status: 'blocked_offline', code: 'offline_write_blocked', message: 'This Dealer Desk action needs an online server confirmation. Your local draft is retained.' };
      if (state.schemaBlocked) return { ok: false, status: 'blocked_schema', code: 'schema_mismatch', message: state.schemaBlocked };
      if (!state.schemaKnown) return { ok: false, status: 'blocked_schema', code: 'schema_required', message: 'Load the current Dealer Desk records before saving a command' };
      const commandId = params.commandId || randomId();
      const busyKey = params.busyKey || String(command);
      const existing = pendingEnvelope(commandId);
      if (existing) {
        const requested = buildCommandRequest({ commandId, command: String(command), expectedVersions: params.expectedVersions || {}, payload: payload || {} });
        if (JSON.stringify(requested) !== JSON.stringify(existing.wire)) return { ok: false, status: 'failed', code: 'command_id_reuse', message: 'That command id is already bound to a different payload' };
        return withBusyKey(existing.busyKey || busyKey, () => sendEnvelope(existing, context));
      }
      if (state.busyKeys.has(String(busyKey))) return busyResult();
      if (Object.values(state.pending).some(entry => entry && entry.status === 'unknown')) {
        return { ok: false, status: 'blocked_unknown', code: 'unknown_command_pending', message: 'Reconcile the pending command with Retry same command or Review before starting another Dealer Desk action' };
      }
      const wire = buildCommandRequest({
        commandId,
        command: String(command),
        expectedVersions: params.expectedVersions || params.expected_versions || {},
        payload: clone(payload || {}) || {}
      });
      if (!wire || typeof wire !== 'object') return { ok: false, status: 'failed', code: 'command_builder_failed', message: 'Dealer Desk command could not be prepared' };
      const entry = {
        commandId,
        command: String(command),
        payload: clone(payload || {}) || {},
        expectedVersions: clone(params.expectedVersions || params.expected_versions || {}) || {},
        wire: clone(wire),
        status: 'pending',
        busyKey,
        attempts: 0,
        createdAt: now(),
        updatedAt: now(),
        ownerId: context.userId
      };
      state.pending[commandId] = entry;
      if (!persist()) {
        delete state.pending[commandId];
        notify();
        return { ok: false, status: 'storage_blocked', code: 'storage_unavailable', message: 'Dealer Desk could not save the exact command envelope. Free browser storage before saving a financial action.', commandId, attempted: clone(payload || {}) };
      }
      notify();
      return withBusyKey(busyKey, () => sendEnvelope(entry, context));
    }

    async function retry(commandId) {
      const context = requireOwner();
      const entry = pendingEnvelope(commandId);
      if (!entry) return { ok: false, status: 'failed', code: 'pending_not_found', message: 'That Dealer Desk command is no longer waiting' };
      if (entry.status !== 'unknown') return { ok: false, status: entry.status, code: entry.status === 'conflict' ? 'conflict_review_required' : 'retry_not_available', message: 'Review the current Dealer Desk result before retrying' };
      if (context.offline) return { ok: false, status: 'blocked_offline', code: 'offline_write_blocked', message: 'Reconnect before retrying this command' };
      return withBusyKey(entry.busyKey || entry.command, () => sendEnvelope(entry, context));
    }

    function dismissPending(commandId) {
      requireOwner();
      const entry = pendingEnvelope(commandId);
      if (!entry) return { ok: true };
      const id = String(commandId);
      delete state.pending[id];
      state.removedPending.set(id, now());
      const durable = persist();
      notify();
      return durable
        ? { ok: true, commandId: id }
        : { ok: false, status: 'storage_blocked', code: 'storage_unavailable', commandId: id, message: 'This pending command could not be cleared from browser storage.' };
    }

    function unsyncedCount() {
      const current = readContext();
      const liveCount = Object.keys(state.drafts).length + Object.keys(state.pending).length;
      if (!current.userId || (state.ownerId && state.ownerId !== current.userId)) return liveCount;
      return Math.max(liveCount, persistedUnsyncedCount(current.userId));
    }

    function suspendOwnerData() {
      // Session expiry is not a user-approved discard. Abort active requests,
      // retain exact envelopes for an explicit same-owner retry, and remove
      // the protected server snapshot from the live view until re-auth.
      state.active.forEach(controller => { try { controller.abort(); } catch (_) {} });
      state.active.clear();
      Object.keys(state.pending).forEach(commandId => {
        const entry = state.pending[commandId];
        if (entry && entry.status === 'in_flight') {
          entry.status = 'unknown';
          entry.failure = { code: 'session_expired', message: 'Session expired before the server response was received' };
          entry.updatedAt = now();
        }
      });
      state.snapshot = null;
      state.stale = false;
      state.schemaKnown = false;
      state.schemaBlocked = null;
      persist();
      notify();
      return { ok: true, unsyncedCount: unsyncedCount() };
    }

    function clearOwnerData(ownerIdOverride) {
      state.active.forEach(controller => { try { controller.abort(); } catch (_) {} });
      state.active.clear();
      const ownerToClear = ownerIdOverride || state.ownerId;
      if (storage && ownerToClear) {
        removeOwnerKeys(ownerToClear);
      }
      state.ownerId = null;
      state.generation = null;
      state.sessionId = null;
      state.snapshot = null;
      state.stale = false;
      state.schemaKnown = false;
      state.schemaBlocked = null;
      state.drafts = {};
      state.pending = {};
      state.removedDrafts = new Map();
      state.removedPending = new Map();
      state.lastResult = null;
      notify();
      return { ok: true };
    }

    function subscribe(listener) {
      if (typeof listener !== 'function') return function () {};
      state.listeners.add(listener);
      return function () { state.listeners.delete(listener); };
    }

    return {
      init,
      pull,
      saveDraft,
      restoreDraft,
      clearDraft,
      command,
      retry,
      dismissPending,
      clearOwnerData,
      suspendOwnerData,
      unsyncedCount,
      subscribe,
      view,
      constants: { CLIENT_PROTOCOL, SCHEMA_VERSION, MAX_PAGE_SIZE, COMMANDS: Array.from(COMMANDS) }
    };
  }

  const singleton = createStore({});
  singleton.create = createStore;
  singleton.CLIENT_PROTOCOL = CLIENT_PROTOCOL;
  singleton.SCHEMA_VERSION = SCHEMA_VERSION;
  singleton.MAX_PAGE_SIZE = MAX_PAGE_SIZE;
  return singleton;
}));
