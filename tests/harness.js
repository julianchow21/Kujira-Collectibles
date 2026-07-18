'use strict';
// Test harness for the Kujira Collectibles PWA (characterisation suite, tests-only round).
// Builds a sandboxed vm context, evals the REAL app.js then features.js into it (unmodified),
// and exposes enough browser shim + fetch/timer control for node:test to drive the app headlessly.
//
// IMPORTANT vm fact (confirmed empirically + by coordinator): top-level `let`/`const`/`class` in a
// script run via vm.runInContext do NOT become properties of the sandbox object - only top-level
// `var` and function declarations do. `let`/`const` bindings live in the context's shared global
// lexical scope, visible to LATER scripts run in the SAME context (so features.js sees app.js's
// `let DB` naturally, mirroring the browser), and readable from outside only by evaluating an
// expression in that context. `ctx` below is a Proxy that does this transparently on property
// access/assignment, so `ctx.DB`, `ctx.mergeTable`, `ctx.sortState.singles.col = 'name'` all work
// as if DB/sortState/etc were plain properties. `grab(...names)` is also exposed for tests that
// prefer destructuring several lexical bindings at once.

const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP_JS_PATH = path.join(ROOT, 'app.js');
const FEATURES_JS_PATH = path.join(ROOT, 'features.js');

const APP_SRC = fs.readFileSync(APP_JS_PATH, 'utf8');
const FEATURES_SRC = fs.readFileSync(FEATURES_JS_PATH, 'utf8');

// ---------------------------------------------------------------------------
// localStorage shim (Map-backed, synchronous, matches the Web Storage API
// surface the app actually calls: getItem/setItem/removeItem/clear/key/length)
// ---------------------------------------------------------------------------
function createLocalStorage() {
  const store = new Map();
  return {
    getItem(key) { return store.has(String(key)) ? store.get(String(key)) : null; },
    setItem(key, value) { store.set(String(key), String(value)); },
    removeItem(key) { store.delete(String(key)); },
    clear() { store.clear(); },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    get length() { return store.size; },
    _store: store, // test-convenience escape hatch, not part of the real API
  };
}

// ---------------------------------------------------------------------------
// Minimal permissive DOM
// ---------------------------------------------------------------------------
function createClassList(initial) {
  const set = new Set(initial || []);
  return {
    add(...cls) { cls.forEach(c => c != null && set.add(String(c))); },
    remove(...cls) { cls.forEach(c => set.delete(String(c))); },
    toggle(c, force) {
      if (force === true) { set.add(c); return true; }
      if (force === false) { set.delete(c); return false; }
      if (set.has(c)) { set.delete(c); return false; }
      set.add(c); return true;
    },
    contains(c) { return set.has(String(c)); },
    item(i) { return Array.from(set)[i] ?? null; },
    toString() { return Array.from(set).join(' '); },
    get length() { return set.size; },
  };
}

function makeStubElement(tagHint, opts) {
  opts = opts || {};
  const el = {
    tagName: (tagHint || '').toUpperCase(),
    id: '',
    innerHTML: '', textContent: '', value: '',
    style: {},
    dataset: {},
    children: [],
    cells: [], // <tr>.cells - a stub row/table always reports zero cells, so header-drag-attach loops no-op harmlessly
    rows: [],
    options: [],
    selectedIndex: -1,
    checked: false,
    disabled: false,
    open: false,
    classList: createClassList(),
    _attrs: {},
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = this._listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    dispatchEvent(evt) {
      const arr = this._listeners.get(evt && evt.type) || [];
      arr.slice().forEach(fn => { try { fn.call(el, evt); } catch (e) { /* one listener throwing must not block others */ } });
      return true;
    },
    appendChild(child) { this.children.push(child); return child; },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); return child; },
    insertBefore(child) { this.children.push(child); return child; },
    insertAdjacentHTML(pos, html) { this._lastInsertedHTML = html; },
    insertAdjacentElement(pos, child) { this.children.push(child); return child; },
    querySelector() { return makeStubElement(); },
    querySelectorAll() { return []; },
    setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this.id = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
    removeAttribute(k) { delete this._attrs[k]; },
    focus() {}, blur() {}, click() {}, select() {}, scrollIntoView() {},
    closest() { return null; },
    remove() {},
    before() {}, after() {}, replaceWith() {},
    cloneNode() { return makeStubElement(el.tagName); },
    contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 }; },
    matches() { return false; },
    className: '',
    nextElementSibling: null,
    previousElementSibling: null,
    parentElement: null,
    parentNode: null,
  };
  // showModal/close: included by default (kjrModalCtrl.open() calls
  // dialog.showModal() UNCONDITIONALLY, e.g. from runHealthCheck's results
  // dialog - without it that throws). Deliberately OMITTED for exactly
  // 'kjr-confirm-dialog' (see getElementById below): kjrConfirm (app.js
  // ~10629) feature-detects `typeof dlg.showModal === 'function'` and falls
  // back to window.confirm() when it's missing - that fallback is how
  // confirm-gated flows stay dormant/false by default per the harness spec.
  // Giving THAT ONE dialog a working showModal would make kjrConfirm take
  // the real modal branch instead, returning a Promise that only resolves on
  // a button click or dialog 'close'/'cancel' event we never fire - i.e.
  // every `await kjrConfirm(...)` call would hang the test forever.
  if (!opts.noDialog) {
    el.showModal = function () { this.open = true; };
    el.close = function () { this.open = false; this.dispatchEvent({ type: 'close' }); };
  }
  return el;
}

function createDocument() {
  const byId = new Map();
  const doc = {
    _byId: byId,
    getElementById(id) {
      const key = String(id);
      if (!byId.has(key)) {
        // 'kjr-confirm-dialog' is the one deliberate exception - see the
        // showModal/close comment in makeStubElement for why.
        const el = makeStubElement('', { noDialog: key === 'kjr-confirm-dialog' });
        el.id = key;
        byId.set(key, el);
      }
      return byId.get(key);
    },
    createElement(tag) { return makeStubElement(tag); },
    querySelector() { return makeStubElement(); },
    querySelectorAll() { return []; },
    addEventListener() {}, // capture-only no-op, tests never dispatch document-level events
    removeEventListener() {},
    dispatchEvent() { return true; },
    visibilityState: 'visible',
  };
  doc.body = makeStubElement('body'); doc.body.id = 'body';
  doc.head = makeStubElement('head'); doc.head.id = 'head';
  doc.documentElement = makeStubElement('html'); doc.documentElement.id = 'html';
  return doc;
}

// ---------------------------------------------------------------------------
// Timer capture: setTimeout/setInterval RECORD {delay, fn} but never fire on
// their own. Tests can flush() or invoke(id) a captured callback deliberately.
// ---------------------------------------------------------------------------
function createTimerSystem() {
  let nextId = 1;
  const pending = new Map(); // id -> { type, fn, delay, cleared }

  function setTimeoutShim(fn, delay, ...args) {
    const id = nextId++;
    pending.set(id, { type: 'timeout', fn: () => fn(...args), delay: delay || 0 });
    return id;
  }
  function clearTimeoutShim(id) { pending.delete(id); }
  function setIntervalShim(fn, delay, ...args) {
    const id = nextId++;
    pending.set(id, { type: 'interval', fn: () => fn(...args), delay: delay || 0 });
    return id;
  }
  function clearIntervalShim(id) { pending.delete(id); }

  function list() {
    return Array.from(pending.entries()).map(([id, e]) => ({ id, type: e.type, delay: e.delay }));
  }
  // Invoke + clear (timeouts) every currently-pending callback matching filter.
  // One pass only - a callback that itself schedules a new timer will NOT be
  // auto-chased; call flush() again (or in a loop) if that's needed.
  function flush(filter) {
    let n = 0;
    for (const [id, e] of Array.from(pending.entries())) {
      if (filter && !filter(e)) continue;
      if (e.type === 'timeout') pending.delete(id);
      try { e.fn(); } catch (err) { console.error('[harness timer flush] callback threw:', err); }
      n++;
    }
    return n;
  }
  function invoke(id) {
    const e = pending.get(id);
    if (!e) return false;
    if (e.type === 'timeout') pending.delete(id);
    e.fn();
    return true;
  }
  return { setTimeoutShim, clearTimeoutShim, setIntervalShim, clearIntervalShim, list, flush, invoke, pending };
}

// ---------------------------------------------------------------------------
// fetch mock: routes by URL substring (or a predicate) to a queue of canned
// responses; records every call as {url, opts}. Default (no route matched)
// rejects with TypeError('offline') - matches an offline-by-default sandbox.
// ---------------------------------------------------------------------------
function createFetchMock() {
  const calls = [];
  const routes = [];
  let defaultImpl = async () => { throw new TypeError('offline'); };

  function toResponder(spec) {
    if (typeof spec === 'function') return spec;
    const { status = 200, ok, body, json, text, headers = {} } = spec || {};
    const okResolved = ok !== undefined ? ok : (status >= 200 && status < 300);
    return async () => ({
      ok: okResolved,
      status,
      headers: { get: (k) => (headers[k] ?? headers[String(k).toLowerCase()] ?? null) },
      json: async () => (json !== undefined ? json : JSON.parse(body !== undefined ? body : '{}')),
      text: async () => (text !== undefined ? text : (body !== undefined ? String(body) : JSON.stringify(json !== undefined ? json : {}))),
    });
  }

  const api = {
    calls,
    // matcher: string (substring match) or function(url)=>bool
    // responses: single spec, or array consumed in order (sticks on the last)
    route(matcher, responses) {
      const list = Array.isArray(responses) ? responses.slice() : [responses];
      routes.unshift({ // unshift: most-recently-added route wins on overlapping matchers
        match: typeof matcher === 'function' ? matcher : (url) => url.includes(matcher),
        queue: list.map(toResponder),
      });
      return api;
    },
    // Route that always rejects (transport failure), e.g. offline/CORS/5xx-as-network-error.
    reject(matcher, err) {
      return api.route(matcher, async () => { throw (err || new TypeError('mock fetch failure')); });
    },
    setDefault(fn) { defaultImpl = fn; return api; },
    reset() { routes.length = 0; calls.length = 0; defaultImpl = async () => { throw new TypeError('offline'); }; },
    async handle(url, opts) {
      const u = String(url);
      calls.push({ url: u, opts });
      for (const r of routes) {
        if (r.match(u)) {
          const next = r.queue.length > 1 ? r.queue.shift() : r.queue[0];
          if (!next) break;
          return next(u, opts);
        }
      }
      return defaultImpl(u, opts);
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// makeSeed: fills sensible defaults for the 7 synced tables. At least one row
// in singles/slabs/sales is required to pass initDB's local-fast-path gate
// (app.js ~896) - the default single below satisfies that on its own.
// ---------------------------------------------------------------------------
function makeSeed(overrides) {
  overrides = overrides || {};
  const defaultSingle = {
    id: 'single_seed_1', name: 'Pikachu 25', set: 'Base Set', language: 'EN', type: 'raw',
    condition: 'Near Mint', qty: 1, costPrice: 10, marketPrice: 15, listPrice: '',
    datePurchased: '1 Jan 2025', status: 'Available', notes: '', priceAlert: '',
    tcgdexId: '', _updatedAt: new Date().toISOString(),
  };
  const base = {
    singles: [defaultSingle],
    slabs: [], sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [],
  };
  return Object.assign(base, overrides);
}

// ---------------------------------------------------------------------------
// settle(): let pending microtask/macrotask chains inside the sandbox drain,
// using REAL timers OUTSIDE the sandbox (the sandbox's own setTimeout never
// fires on its own - see createTimerSystem above).
// ---------------------------------------------------------------------------
function settle(rounds) {
  rounds = rounds || 15;
  return (async () => {
    for (let i = 0; i < rounds; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  })();
}

function safeStringify(x) {
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch (e) { return String(x); }
}

// Cross-realm-safe "is this a Date". Objects created INSIDE the vm sandbox
// are instances of THAT context's own Date constructor, not the outer Node
// realm's - `x instanceof Date` from a test file is always false for them
// even though .getTime()/.getFullYear()/etc all work fine (same underlying
// engine, just a different global per-realm identity). Object.prototype.toString
// reads the internal [[Class]] slot, which is realm-agnostic.
function isDate(x) {
  return Object.prototype.toString.call(x) === '[object Date]';
}

// Cross-realm-safe deep value copy: recursively rebuilds plain
// objects/arrays using the OUTER (test) realm's Object/Array constructors.
// Needed because assert.deepStrictEqual checks prototype identity, and any
// object literal returned by code running inside the vm sandbox has the
// SANDBOX's Object.prototype, not the outer realm's - deepStrictEqual(sandboxObj,
// {a:1}) fails even when every enumerable property is identical. plain(x)
// strips that mismatch so structural comparisons work as expected. Dates are
// converted to their ISO string (compare those explicitly if you need a Date).
function plain(x) {
  if (x === null || typeof x !== 'object') return x;
  if (isDate(x)) return isNaN(x.getTime()) ? 'Invalid Date' : x.toISOString();
  // Set/Map: Object.keys() on either is always [] (entries aren't own
  // enumerable properties), so without this they'd silently flatten to {}.
  // The iterable protocol itself IS realm-agnostic, so spreading a foreign
  // Set/Map's entries here (in the outer realm) is safe.
  if (Object.prototype.toString.call(x) === '[object Set]') return Array.from(x, plain);
  if (Object.prototype.toString.call(x) === '[object Map]') return Array.from(x, ([k, v]) => [plain(k), plain(v)]);
  if (Array.isArray(x)) {
    // Deliberately NOT x.map(plain): Array.prototype.map on a foreign-realm
    // array uses ArraySpeciesCreate, which builds the result with THAT
    // array's own (foreign) Array constructor - so the output would still
    // be a foreign array, and deepStrictEqual against an outer-realm literal
    // would keep failing. Push into a genuine outer-realm array explicitly.
    const out = [];
    for (let i = 0; i < x.length; i++) out.push(plain(x[i]));
    return out;
  }
  const out = {};
  for (const k of Object.keys(x)) out[k] = plain(x[k]);
  return out;
}

// ---------------------------------------------------------------------------
// loadApp(opts): the main factory. Returns a fresh sandboxed app instance.
// ---------------------------------------------------------------------------
async function loadApp(opts) {
  opts = opts || {};

  const localStorage = createLocalStorage();

  // Seed localStorage BEFORE eval (app.js hydrates DB synchronously from this
  // during its own top-level initDB() call, before the first await).
  if (opts.seed !== null) {
    const seedObj = makeSeed(opts.seed);
    localStorage.setItem('pokeinventory_v3', JSON.stringify(seedObj));
  }
  if (opts.localStorage) {
    for (const [k, v] of Object.entries(opts.localStorage)) {
      localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
  }

  const document = createDocument();
  const timers = createTimerSystem();
  const fetchMock = createFetchMock();
  if (typeof opts.fetch === 'function') fetchMock.setDefault(opts.fetch);

  const consoleWarnings = [];
  const consoleErrors = [];
  const realConsole = console;

  const defaultLocation = {
    protocol: 'https:', hostname: 'julianchow21.github.io', host: 'julianchow21.github.io',
    href: 'https://julianchow21.github.io/Kujira-Collectibles/', origin: 'https://julianchow21.github.io',
    pathname: '/Kujira-Collectibles/', search: '',
    reload() {}, assign() {}, replace() {},
  };
  const location = Object.assign({}, defaultLocation, opts.location || {});

  const rafState = { nextId: 1, calls: new Map() };

  const sandbox = {
    document,
    localStorage,
    navigator: { onLine: true, clipboard: {}, userAgent: 'test' }, // NO serviceWorker key by design
    location,
    history: { state: null, length: 1, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
    matchMedia: (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    requestAnimationFrame: (fn) => { const id = rafState.nextId++; rafState.calls.set(id, fn); return id; },
    cancelAnimationFrame: (id) => { rafState.calls.delete(id); },
    confirm: () => false,
    alert: () => {},
    prompt: () => null,
    scrollTo: () => {},
    scrollBy: () => {},
    open: () => null, // window.open (never actually invoked by app code today, cheap safety net)
    print: () => {},
    setTimeout: timers.setTimeoutShim,
    clearTimeout: timers.clearTimeoutShim,
    setInterval: timers.setIntervalShim,
    clearInterval: timers.clearIntervalShim,
    queueMicrotask: (fn) => queueMicrotask(fn), // real, per spec
    fetch: (url, fetchOpts) => fetchMock.handle(url, fetchOpts),
    URL, Blob, crypto, AbortSignal, performance, structuredClone, // real Node built-ins, safe to share (stateless/side-effect-contained)
    caches: { open: async () => ({ match: async () => undefined, put: async () => {} }) },
    Chart: class ChartStub {
      constructor(ctx, config) { this.ctx = ctx; this.config = config; ChartStub.instances.push(this); }
      destroy() {} update() {} resize() {}
      static register() {}
    },
    marked: { parse: (s) => s },
    Event: class EventShim {
      constructor(type, o) { this.type = type; this.bubbles = !!(o && o.bubbles); this.cancelable = !!(o && o.cancelable); this.defaultPrevented = false; }
      preventDefault() { this.defaultPrevented = true; }
      stopPropagation() {}
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    console: {
      log: (...a) => realConsole.log('[app]', ...a),
      info: (...a) => realConsole.info('[app]', ...a),
      debug: (...a) => realConsole.debug('[app]', ...a),
      warn: (...a) => { consoleWarnings.push(a.map(safeStringify).join(' ')); realConsole.warn('[app]', ...a); },
      error: (...a) => { consoleErrors.push(a.map(safeStringify).join(' ')); realConsole.error('[app]', ...a); },
    },
  };
  sandbox.Chart.instances = [];
  sandbox.CustomEvent = class CustomEventShim extends sandbox.Event {
    constructor(type, o) { super(type, o); this.detail = o && o.detail; }
  };

  // window/self/globalThis all alias the sandbox itself (standard browser
  // circularity). window.addEventListener('popstate'|'load'|'storage', ...)
  // and document.addEventListener(...) are both real call sites at load time
  // (kjrModalCtrl's popstate listener, the two-tab storage-sync listener, the
  // update-pill's window 'load' listener) - capture-only, never dispatched.
  const windowListeners = new Map();
  sandbox.addEventListener = function (type, fn) {
    if (!windowListeners.has(type)) windowListeners.set(type, []);
    windowListeners.get(type).push(fn);
  };
  sandbox.removeEventListener = function (type, fn) {
    const arr = windowListeners.get(type);
    if (!arr) return;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
  sandbox.dispatchEvent = function (evt) {
    const arr = windowListeners.get(evt && evt.type) || [];
    arr.slice().forEach(fn => { try { fn.call(sandbox, evt); } catch (e) { /* one listener throwing must not block others */ } });
    return true;
  };

  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);

  const evalErrors = [];
  try {
    vm.runInContext(APP_SRC, sandbox, { filename: 'app.js' });
  } catch (e) {
    evalErrors.push({ file: 'app.js', error: e });
    throw Object.assign(new Error('app.js failed to eval: ' + (e && e.stack || e)), { cause: e });
  }
  try {
    vm.runInContext(FEATURES_SRC, sandbox, { filename: 'features.js' });
  } catch (e) {
    evalErrors.push({ file: 'features.js', error: e });
    throw Object.assign(new Error('features.js failed to eval: ' + (e && e.stack || e)), { cause: e });
  }

  // Let initDB()'s internal await chain (flushPendingTrash -> flushPendingDeletes
  // -> Promise.all([sbFetchAll...]) -> mergeTable -> ... ) and the top-level
  // getSgdRate().then(...) settle before handing back control.
  await settle();

  // grab(...names): read one or more top-level let/const/class bindings from
  // the shared context lexical scope (see file header). Returns a plain object.
  function grab(...names) {
    const expr = '({' + names.map(n => JSON.stringify(n) + ':(typeof ' + n + "==='undefined'?undefined:" + n + ')').join(',') + '})';
    return vm.runInContext(expr, sandbox, { filename: '<grab>' });
  }

  // ctx: transparent proxy over the sandbox global object. Own properties
  // (var/function declarations - the majority of the app) are read/written
  // directly. Anything else falls back to evaluating the bare identifier in
  // the shared context lexical scope, which is how top-level let/const/class
  // (DB, sortState, _dirty, _sgdRate, TABLE_TO_DB_KEY, QUEUE_SCHEMA_VERSION,
  // cmdSellCart, ...) are reached. Confirmed empirically: this returns the
  // SAME live object references the running app mutates (single V8 isolate,
  // no structured-clone boundary), so `ctx.DB.singles.push(...)` etc. and
  // `ctx.sortState.singles.col = 'name'` both work exactly as expected.
  const ctx = new Proxy(sandbox, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      try { return vm.runInContext(String(prop), sandbox, { filename: '<ctx-get>' }); }
      catch (e) { return undefined; }
    },
    set(target, prop, value) {
      if (typeof prop === 'symbol' || Reflect.has(target, prop)) return Reflect.set(target, prop, value);
      target.__ctxTmp__ = value;
      try { vm.runInContext(String(prop) + ' = globalThis.__ctxTmp__;', sandbox, { filename: '<ctx-set>' }); }
      finally { delete target.__ctxTmp__; }
      return true;
    },
  });

  return {
    ctx,
    sandbox,
    document,
    localStorage,
    fetchMock,
    timers,
    consoleWarnings,
    consoleErrors,
    settle,
    grab,
    rafState,
  };
}

module.exports = { loadApp, makeSeed, createFetchMock, ROOT, isDate, plain };
