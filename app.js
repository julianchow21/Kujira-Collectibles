/* Kujira Collectibles, core app (split from index.html, v3.12, 05/07/2026).
   Block 1: modal controller. Block 2: main app (DATA onward).
   Loads before features.js, one shared global scope, order matters. */
const kjrModalCtrl = (() => {
  const stack = [];
  let pushed = false;
  let popping = false;

  function syncScroll() {
    const sentryOpen = document.getElementById('sentry-drawer') &&
                       document.getElementById('sentry-drawer').classList.contains('open');
    document.body.style.overflow = (stack.length > 0 || sentryOpen) ? 'hidden' : '';
  }

  // opts is optional: { trigger, onClose }. onClose (if given) is stored per
  // dialog and invoked by close() on EVERY close path (explicit close/cancel
  // button, ESC/'cancel' event, backdrop click) so callers that need to run
  // logic on close (e.g. advancing a queue) get it regardless of how the
  // dialog was dismissed - previously ESC/backdrop bypassed any wrapper
  // function a caller used to close the dialog "properly" (FINDING B).
  function open(dialog, opts) {
    opts = opts || {};
    const trigger = opts.trigger || document.activeElement;
    // iOS WebKit can leave the visual viewport offset after the keyboard was
    // up, which renders top-layer <dialog> sheets displaced above the screen.
    // Blurring a still-focused text input before showModal() dismisses the
    // keyboard first, so the sheet opens against the settled viewport.
    if (trigger && trigger.matches && trigger.matches('input,select,textarea') && typeof trigger.blur === 'function') trigger.blur();
    stack.push({ dialog, trigger });
    dialog._kjrOnClose = (typeof opts.onClose === 'function') ? opts.onClose : null;
    dialog.dataset.dirty = '0'; // reset the unsaved-changes flag for this open cycle
    // Forms opted in via data-kjr-form get one delegated input/change listener
    // (attached once, lazily) that flips the dirty flag on any user edit.
    if (dialog.dataset.kjrForm === '1' && !dialog._kjrDirtyBound) {
      dialog._kjrDirtyBound = true;
      const markDirtyFn = () => { dialog.dataset.dirty = '1'; };
      dialog.addEventListener('input', markDirtyFn);
      dialog.addEventListener('change', markDirtyFn);
    }
    // Bind Esc + backdrop-click once per dialog. Native Esc fires 'cancel'
    // and would close the dialog directly - bypassing the dirty guard AND
    // leaving a stale stack entry - so intercept it and route through close().
    // Backdrop click: the dialog element itself is the full-viewport flex
    // wrapper, the .modal sits inside it, so a click landing on the dialog
    // node (not a descendant) is a backdrop click.
    if (!dialog._kjrCtlBound) {
      dialog._kjrCtlBound = true;
      dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(dialog); });
      dialog.addEventListener('click', (e) => { if (e.target === dialog) close(dialog); });
    }
    dialog.showModal();
    if (typeof trapFocus === 'function') trapFocus(dialog);
    if (!pushed) { history.pushState({ kjrModal: 1 }, ''); pushed = true; }
    syncScroll();
  }

  // Unsaved-changes guard: if the dialog is flagged dirty (data-dirty="1"),
  // ask for confirmation before actually closing. force=true skips the
  // prompt (used by save handlers, which clear the flag themselves anyway,
  // and by closeAll/popstate teardown paths that must not get stuck open).
  // Returns a Promise<boolean> - true if the dialog was closed.
  async function close(dialog, force) {
    const idx = stack.findIndex(s => s.dialog === dialog);
    if (idx === -1) return true;
    if (!force && dialog.dataset.dirty === '1' && typeof kjrConfirm === 'function') {
      const ok = await kjrConfirm('Discard unsaved changes?', { ok: 'Discard', danger: true });
      if (!ok) return false;
    }
    const entry = stack.splice(idx, 1)[0];
    dialog.dataset.dirty = '0';
    if (dialog.open) dialog.close();
    if (stack.length === 0 && pushed && !popping) { pushed = false; history.back(); }
    syncScroll();
    // Run the per-dialog onClose hook (if one was registered at open()) on
    // every close path - explicit button, ESC/'cancel', and backdrop click
    // all funnel through this one close() function. Reentry guard: a caller
    // whose own "proper close" wrapper both runs its own advance logic AND
    // calls ctrl.close() would otherwise double-fire; _kjrOnClose is cleared
    // before invoking so a second close() on the same dialog (or a hook that
    // itself calls close() again) is a no-op.
    const onClose = dialog._kjrOnClose;
    dialog._kjrOnClose = null;
    if (onClose) { try { onClose(); } catch(e) { console.error('[kjrModalCtrl] onClose hook failed:', e); } }
    if (entry.trigger && typeof entry.trigger.focus === 'function') {
      requestAnimationFrame(() => { try { entry.trigger.focus(); } catch(_){} });
    }
    return true;
  }

  function closeAll() {
    // Teardown path (nav away, ESC-stack unwind via popstate, etc.) - never
    // block on an unsaved-changes prompt here, just force-close everything.
    while (stack.length) close(stack[stack.length - 1].dialog, true);
  }

  // The back button (popstate) has already consumed the history entry by the
  // time this fires, so we can't "cancel" the navigation the way we can with
  // preventDefault() on the dialog's cancel event. Instead: if the top dialog
  // is dirty, immediately re-push a history entry (putting the back-button
  // state back the way it was) and run the confirm prompt; only actually
  // go back + close if the user confirms discarding the changes.
  window.addEventListener('popstate', () => {
    if (stack.length === 0) return;
    const top = stack[stack.length - 1].dialog;
    if (top.dataset.dirty === '1' && typeof kjrConfirm === 'function') {
      pushed = true;
      history.pushState({ kjrModal: 1 }, ''); // restore the entry the back-press just consumed
      kjrConfirm('Discard unsaved changes?', { ok: 'Discard', danger: true }).then(ok => {
        if (!ok) return; // stay open, history already restored above
        popping = true; closeAll(); popping = false;
        pushed = false;
        history.back(); // now actually leave the modal state
      });
      return;
    }
    popping = true; pushed = false; closeAll(); popping = false;
  });

  document.addEventListener('closeAllModals', () => {
    closeAll();
    try { if (typeof closeSentryPanel === 'function') closeSentryPanel(); } catch(_){}
    try { if (typeof closeNavDD === 'function') closeNavDD(); } catch(_){}
    document.querySelectorAll('.modal-overlay').forEach(el => { try { if (getComputedStyle(el).display !== 'none') el.remove(); } catch(_){} });
  });

  return { open, close, closeAll, syncScroll };
})();
// =========== DATA ===========
const STORAGE_KEY = 'pokeinventory_v3';
const LS_VERSION_KEY = 'pokeinventory_version'; // monotonic write counter

// =========== SUPABASE CONFIG ===========
// Two paths, chosen by USE_WORKER_DB:
//   false (default) - talk to Supabase directly with the anon key (legacy).
//   true            - route every /rest/v1 call through the Cloudflare Worker,
//                     which injects the service-role key server-side. The
//                     browser then carries NO database key, and RLS can deny
//                     the anon role outright.
// Flip to true ONLY AFTER: (1) the Worker /db route is deployed with the
// SUPABASE_URL + SUPABASE_SERVICE_KEY secrets, and (2) you have verified sync
// still works. THEN enable RLS deny-anon. See
// Docs/Worker DB Proxy Runbook v1 (3 Jun).md. Every DB call below uses
// SB_URL + '/rest/v1/...' + SB_HDR, so this switch reroutes all of them with
// no other code changes.
const USE_WORKER_DB    = true; // flipped 03/07/2026 - proxy verified by curl (200 + origin gate 403) before the flip
const SB_DIRECT_URL    = 'https://eywncywatxtlqtrvxjsi.supabase.co';
const SB_DB_PROXY_BASE = 'https://kujira-prices.julianchow21.workers.dev/db';
// Anon key - only sent on the legacy (USE_WORKER_DB=false) path. Remove it once
// the Worker path is verified and RLS denies anon (it will then be dead weight).
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImV5d25jeXdhdHh0bHF0cnZ4anNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg0MjE0NjEsImV4cCI6MjA5Mzk5NzQ2MX0.3fB6T38Ra22nFu7tNaWoYVgi0JtGxw9_fVwM1rQMYLc';
const SB_URL = USE_WORKER_DB ? SB_DB_PROXY_BASE : SB_DIRECT_URL;
const SB_HDR = USE_WORKER_DB
  ? { 'Content-Type': 'application/json' }
  : { 'Content-Type': 'application/json', 'apikey': SB_KEY, 'Authorization': 'Bearer ' + SB_KEY };

// ── KJR: table-name translator (Supabase ↔ DB key) ──────────────
const TABLE_TO_DB_KEY = {
  singles: 'singles', slabs: 'slabs', sales: 'sales',
  etbs: 'etbs', booster_boxes: 'boosterBoxes', booster_packs: 'boosterPacks',
  ebay_purchases: 'ebayPurchases'
};
const DB_KEY_TO_TABLE = Object.fromEntries(
  Object.entries(TABLE_TO_DB_KEY).map(([k,v]) => [v,k])
);
function _dbKey(tbl) { return TABLE_TO_DB_KEY[tbl] || tbl; }
function _tblName(key) { return DB_KEY_TO_TABLE[key] || key; }

// Canonical list of Supabase table names (snake_case, as sbDelete/sbUpsert
// expect) that sync to the cloud. Used by undoLast/redoLast/restoreVersion to
// diff which ids disappeared and delete them from Supabase too - otherwise a
// deletion undoes itself on the next load when the cloud row re-merges (B3).
const SYNCED_TABLES = ['singles', 'slabs', 'sales', 'etbs', 'booster_boxes', 'booster_packs', 'ebay_purchases'];


// ── Sync status indicator ─────────────────────────────────────
let _syncStatus = 'idle';
function setSyncStatus(s, msg) {
  _syncStatus = s;
  const el = document.getElementById('sync-indicator');
  if (!el) return;
  if (s === 'saving') { el.textContent = '⟳ Syncing...'; el.style.color = 'var(--text3)'; }
  else if (s === 'ok') { el.textContent = '✓ Synced'; el.style.color = 'var(--green)'; setTimeout(() => { if (_syncStatus === 'ok') el.textContent = ''; }, 3000); }
  else if (s === 'error') { el.textContent = '⚠ Sync failed - check connection'; el.style.color = 'var(--red)'; if (msg) console.error('Sync error:', msg); }
}

// ── Import progress bar ───────────────────────────────────────
function showSyncProgress(current, total, label) {
  let bar = document.getElementById('sync-progress-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'sync-progress-bar';
    bar.style.cssText = 'position:fixed;top:calc(56px + env(safe-area-inset-top));left:0;right:0;z-index:110;background:var(--bg2);border-bottom:1px solid var(--border);padding:10px 20px;display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--text2);box-shadow:0 4px 12px rgba(0,0,0,0.25)';
    document.body.appendChild(bar);
  }
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  bar.innerHTML = '<div style="display:flex;justify-content:space-between"><span>' + (label || 'Syncing to cloud…') + '</span><span style="color:var(--text3)">' + current + ' / ' + total + ' (' + pct + '%)</span></div>' +
    '<div style="height:4px;background:var(--bg3);border-radius:2px"><div style="height:4px;width:' + pct + '%;background:var(--accent);border-radius:2px;transition:width 0.2s"></div></div>';
}
function hideSyncProgress() {
  const bar = document.getElementById('sync-progress-bar');
  if (bar) { bar.style.opacity = '0'; bar.style.transition = 'opacity 0.4s'; setTimeout(() => bar.remove(), 400); }
}

// ── Supabase: BATCH upsert (single request for all records) ──
// Returns the single `updated_at` timestamp written for this batch (or null on
// the preview-guard / empty-input paths) so callers can stamp it back onto the
// in-memory rows - without this, DB rows keep their stale base _updatedAt and
// mergeTable later misreads the next local edit as a fake conflict (B1).
async function sbBatchUpsert(table, items) {
  if (isLocalhostPreview()) { return null; } // never write to prod from a local preview
  if (!items.length) return null;
  const ts = new Date().toISOString();
  const rows = items.map(item => {
    const { id, ...data } = item;
    return { id, data, updated_at: ts };
  });
  const r = await fetch(SB_URL + '/rest/v1/' + table + '?on_conflict=id', {
    method: 'POST',
    headers: { ...SB_HDR, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error('Batch upsert failed: ' + await r.text());
  return ts;
}

// ── Supabase: single upsert (for individual edits/adds) ──────
// Returns the `updated_at` timestamp written (or null if the preview guard
// skipped the write) - see sbBatchUpsert for why callers must stamp this back.
async function sbUpsert(table, id, data) {
  if (isLocalhostPreview()) { return null; } // never write to prod from a local preview
  try {
    const ts = new Date().toISOString();
    const r = await fetch(SB_URL + '/rest/v1/' + table + '?on_conflict=id', {
      method: 'POST',
      headers: { ...SB_HDR, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify({ id, data, updated_at: ts }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(await r.text());
    return ts;
  } catch(e) { setSyncStatus('error', e.message); throw e; }
}

// Persistent retry queue for cloud deletes that failed (network down,
// 5xx, intermittent error). Without this, an orphan row sits in Supabase
// and re-merges into local state on the next page load.
const PENDING_DEL_KEY = '_kjrPendingCloudDeletes';

function _queuePendingDelete(table, id) {
  try {
    const raw = localStorage.getItem(PENDING_DEL_KEY) || '[]';
    const list = JSON.parse(raw);
    if (!list.some(x => x.table === table && x.id === id)) {
      list.push({ table, id, ts: Date.now() });
      localStorage.setItem(PENDING_DEL_KEY, JSON.stringify(list));
    }
  } catch(e) { console.warn('queuePendingDelete failed:', e); }
}

async function flushPendingDeletes() {
  if (isLocalhostPreview()) { return; } // never write to prod from a local preview
  let list;
  try { list = JSON.parse(localStorage.getItem(PENDING_DEL_KEY) || '[]'); }
  catch { return; }
  if (!Array.isArray(list) || !list.length) return;
  const stillPending = [];
  for (const item of list) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/' + item.table + '?id=eq.' + encodeURIComponent(item.id), {
        method: 'DELETE', headers: SB_HDR, signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) throw new Error(await r.text());
    } catch(e) {
      // Drop items older than 7 days (we will never reclaim these - likely RLS / schema change)
      if (Date.now() - (item.ts || 0) < 7 * 86400 * 1000) stillPending.push(item);
    }
  }
  try { localStorage.setItem(PENDING_DEL_KEY, JSON.stringify(stillPending)); } catch {}
  const cleared = list.length - stillPending.length;
  if (cleared > 0) console.info('[Cloud] Cleared ' + cleared + ' pending delete(s) from previous session(s)');
}

// Persistent retry queue for TRASH writes that failed (offline, 5xx).
// Without this, an offline delete removes the row locally and (via the
// pending-delete queue) from the cloud, but the trash snapshot is never
// written, breaking the 30-day restore promise with no warning.
const PENDING_TRASH_KEY = '_kjrPendingTrashWrites';

function _queuePendingTrash(entry) {
  try {
    const raw = localStorage.getItem(PENDING_TRASH_KEY) || '[]';
    const list = JSON.parse(raw);
    if (!list.some(x => x.id === entry.id)) {
      list.push(entry);
      localStorage.setItem(PENDING_TRASH_KEY, JSON.stringify(list));
    }
  } catch(e) { console.warn('queuePendingTrash failed:', e); }
}

async function flushPendingTrash() {
  if (isLocalhostPreview()) { return; } // never write to prod from a local preview
  let list;
  try { list = JSON.parse(localStorage.getItem(PENDING_TRASH_KEY) || '[]'); }
  catch { return; }
  if (!Array.isArray(list) || !list.length) return;
  const stillPending = [];
  for (const entry of list) {
    try {
      const r = await fetch(SB_URL + '/rest/v1/trash', {
        method: 'POST',
        headers: { ...SB_HDR, 'Prefer': 'resolution=merge-duplicates' },
        body: JSON.stringify(entry),
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) throw new Error(await r.text());
    } catch(e) {
      // Keep retrying for the full 30-day trash retention window. Dropping
      // sooner would silently discard the only remaining copy of the item.
      const ts = new Date(entry.data?.deletedAt || entry.updated_at || 0).getTime();
      if (Date.now() - ts < 30 * 86400 * 1000) stillPending.push(entry);
      else console.warn('[Trash] dropping expired pending trash write:', entry.id, e.message);
    }
  }
  try { localStorage.setItem(PENDING_TRASH_KEY, JSON.stringify(stillPending)); } catch {}
  const cleared = list.length - stillPending.length;
  if (cleared > 0) console.info('[Trash] Flushed ' + cleared + ' pending trash write(s) from previous session(s)');
}

async function sbDelete(table, id) {
  if (isLocalhostPreview()) { return true; } // never write to prod from a local preview
  try {
    const r = await fetch(SB_URL + '/rest/v1/' + table + '?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE', headers: SB_HDR, signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(await r.text());
    return true;
  } catch(e) {
    setSyncStatus('error', e.message);
    // Queue for retry so the row does not linger in Supabase and re-merge later.
    _queuePendingDelete(table, id);
    return false;
  }
}

// Shared limit/offset pagination loop against a PostgREST table. PostgREST
// silently caps a single response at its max-rows setting (1000 by default),
// so any endpoint that used a single big `limit=N` (N > 1000) was silently
// truncating past that cap. Used by sbFetchAll, fetchTrash and the
// market_prices loader so none of them lose rows past 1000.
async function sbFetchPaged(table, query, safetyCap) {
  const PAGE = 1000;
  const cap = safetyCap || 50000;
  const all = [];
  for (let from = 0; ; from += PAGE) {
    const r = await fetch(SB_URL + '/rest/v1/' + table + '?' + query + '&limit=' + PAGE + '&offset=' + from, {
      headers: SB_HDR,
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    all.push(...rows);
    if (rows.length < PAGE) break;
    if (from >= cap) { console.warn('[Cloud] sbFetchPaged(' + table + ') stopped at ' + all.length + ' rows (safety cap)'); break; }
  }
  return all;
}

async function sbFetchAll(table) {
  // Paginate with limit/offset query params (not Range/Range-Unit headers) -
  // the Cloudflare Worker DB proxy (USE_WORKER_DB) does not forward Range
  // headers, which blocked flipping that flag. limit/offset works identically
  // against Supabase direct and through the Worker. id.asc tiebreak keeps page
  // boundaries stable if updated_at values collide.
  const all = await sbFetchPaged(table, 'select=id,data,updated_at&order=updated_at.desc,id.asc');
  return all.map(row => ({ id: row.id, ...row.data, _updatedAt: row.updated_at }));
}

// ── Write version counter to localStorage ────────────────────
function bumpLocalVersion() {
  const v = (parseInt(localStorage.getItem(LS_VERSION_KEY) || '0')) + 1;
  localStorage.setItem(LS_VERSION_KEY, String(v));
  localStorage.setItem(LS_VERSION_KEY + '_time', new Date().toISOString());
  return v;
}
function getLocalVersion() { return parseInt(localStorage.getItem(LS_VERSION_KEY) || '0'); }

// ── saveData: localStorage FIRST (instant), then cloud async ─
let _saveTimer = null;
// _dirty is persisted to localStorage so a failed sync isn't lost when the tab closes.
const DIRTY_LS_KEY = 'pokeinv_dirty_v1';
function _loadDirtyFromLS() {
  try {
    const raw = localStorage.getItem(DIRTY_LS_KEY);
    if (!raw) return { singles: new Set(), slabs: new Set(), sales: new Set(), etbs: new Set(), boosterBoxes: new Set(), boosterPacks: new Set(), ebayPurchases: new Set() };
    const obj = JSON.parse(raw);
    return {
      singles:        new Set(obj.singles        || []),
      slabs:          new Set(obj.slabs          || []),
      sales:          new Set(obj.sales          || []),
      etbs:           new Set(obj.etbs           || []),
      boosterBoxes:   new Set(obj.boosterBoxes   || []),
      boosterPacks:   new Set(obj.boosterPacks   || []),
      ebayPurchases:  new Set(obj.ebayPurchases  || []),
    };
  } catch(e) { return { singles: new Set(), slabs: new Set(), sales: new Set(), etbs: new Set(), boosterBoxes: new Set(), boosterPacks: new Set(), ebayPurchases: new Set() }; }
}
// Read-merge-write: union the in-memory dirty set with whatever is currently
// stored, so a concurrent tab's queued-but-not-yet-synced ids are never
// clobbered by this tab blindly overwriting the whole blob (B2, two-tab safety).
function _persistDirty() {
  try {
    const raw = localStorage.getItem(DIRTY_LS_KEY);
    const prev = raw ? JSON.parse(raw) : {};
    const keys = ['singles','slabs','sales','etbs','boosterBoxes','boosterPacks','ebayPurchases'];
    const merged = {};
    for (const k of keys) {
      const stored = Array.isArray(prev[k]) ? prev[k] : [];
      const mine = [..._dirty[k]];
      merged[k] = [...new Set([...stored, ...mine])];
    }
    localStorage.setItem(DIRTY_LS_KEY, JSON.stringify(merged));
  } catch(e) {}
}
const _dirty = _loadDirtyFromLS();
function markDirty(table, id) { if (_dirty[table]) { _dirty[table].add(id); _persistDirty(); } }

function saveData() {
  // 1. Write to localStorage immediately - this is the source of truth
  const payload = JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases });
  try {
    localStorage.setItem(STORAGE_KEY, payload);
    bumpLocalVersion();
  } catch(e) {
    // Quota hit. The version snapshots (full-DB backups) are by far the
    // heaviest thing in localStorage and are NOT critical - they're mirrored
    // to Supabase. Free them and retry so the live inventory always persists.
    console.warn('localStorage write failed, freeing version snapshots and retrying:', e);
    try {
      _evictVersionBlobsFromLS();
      localStorage.setItem(STORAGE_KEY, payload);
      bumpLocalVersion();
      console.info('[storage] reclaimed space from version snapshots - inventory saved');
    } catch(e2) {
      console.warn('localStorage still full after eviction:', e2);
      // Data is still in memory and will be flushed to Supabase by the debounce -
      // but a page refresh before that completes would lose the change.
      if (typeof toast === 'function') toast('⚠ Local storage full - data will only be saved to cloud. Avoid refreshing until the sync indicator turns green.', 6000, true);
    }
  }

  // 2. Debounce cloud write by 1s
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_flushDirtyToSupabase, 1000);
}

async function _flushDirtyToSupabase() {
  // In a local preview (file:// or localhost) every write is gated off so we
  // never touch prod. Bail BEFORE the loop - otherwise the skipped upserts read
  // as success and we'd clear the dirty flags, so the reload-merge would drop
  // the local-only rows (silent data loss). Leaving them dirty makes the merge
  // preserve them across refresh.
  if (isLocalhostPreview()) return;
  const tables = ['singles', 'slabs', 'sales', 'etbs', 'booster_boxes', 'booster_packs', 'ebay_purchases'];
  // Snapshot dirty IDs NOW before any await, so new mutations during upload stay dirty
  const toSync = [];
  for (const tbl of tables) {
    const key = _dbKey(tbl);
    const dirtyIds = new Set(_dirty[key]); // snapshot
    const dirtyItems = DB[key].filter(i => dirtyIds.has(i.id));
    if (dirtyItems.length) toSync.push({ tbl, key, items: dirtyItems, dirtyIds });
  }
  if (!toSync.length) return;
  setSyncStatus('saving');
  let anyError = false;
  let anyStamped = false;
  for (const { tbl, key, items, dirtyIds } of toSync) {
    try {
      // Chunk into 200-row batches to stay under Supabase body size limits.
      for (let i = 0; i < items.length; i += 200) {
        const chunk = items.slice(i, i + 200);
        const ts = await sbBatchUpsert(tbl, chunk);
        // Stamp the cloud timestamp back onto the in-memory rows so the next
        // mergeTable pass sees this edit's real base time, not the stale one -
        // otherwise a same-row edit right after sync reads as a fake conflict
        // and gets discarded on the next load (B1).
        if (ts) {
          const ids = new Set(chunk.map(r => r.id));
          for (const row of DB[key]) if (ids.has(row.id)) row._updatedAt = ts;
          anyStamped = true;
        }
      }
      // Only clear the IDs we successfully uploaded - new mutations since snapshot stay dirty
      dirtyIds.forEach(id => _dirty[key].delete(id));
    } catch(e) {
      anyError = true;
      setSyncStatus('error', e.message);
      console.error('Flush failed for ' + tbl + ':', e);
      // IDs remain in _dirty so next saveData() will retry them
    }
  }
  // Persist the stamped timestamps directly - NOT via the debounced saveData(),
  // which would re-arm _saveTimer and re-enter _flushDirtyToSupabase.
  if (anyStamped) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases })); } catch(e){}
  }
  _persistDirty();
  if (!anyError) setSyncStatus('ok');
  // Opportunistic: retry any deletes and trash writes that failed previously.
  // Trash first so the snapshot exists before its source row is deleted.
  flushPendingTrash().catch(e => console.warn('flushPendingTrash failed:', e))
    .then(() => flushPendingDeletes()).catch(e => console.warn('flushPendingDeletes failed:', e));
}

// ── saveAllToSupabase: batch upload everything (used after import) ──
async function saveAllToSupabase() {
  if (isLocalhostPreview()) { console.info('[Preview] sync off - saveAllToSupabase skipped'); return; }
  setSyncStatus('saving');
  const tables = ['singles', 'slabs', 'sales', 'etbs', 'booster_boxes', 'booster_packs', 'ebay_purchases'];
  // NOTE: DB is keyed by camelCase (see TABLE_TO_DB_KEY), so this must go
  // through _dbKey - indexing DB directly with the snake_case name (e.g.
  // DB['booster_boxes']) is undefined and throws on .length. Pre-existing bug,
  // fixed here because it sits directly on this function's only anchor line.
  const total = tables.reduce((s, t) => s + DB[_dbKey(t)].length, 0);
  let done = 0;
  let anyStamped = false;
  showSyncProgress(0, total, 'Uploading to cloud…');
  try {
    for (const tbl of tables) {
      const key = _dbKey(tbl);
      if (!DB[key].length) continue;
      // Chunk into batches of 200 to stay under Supabase body size limits
      const chunks = [];
      for (let i = 0; i < DB[key].length; i += 200) chunks.push(DB[key].slice(i, i + 200));
      for (const chunk of chunks) {
        const ts = await sbBatchUpsert(tbl, chunk);
        // Stamp back so a same-row edit right after this bulk sync doesn't
        // misread as a fake conflict on the next load (see A1 / B1).
        if (ts) {
          const ids = new Set(chunk.map(r => r.id));
          for (const row of DB[key]) if (ids.has(row.id)) row._updatedAt = ts;
          anyStamped = true;
        }
        done += chunk.length;
        showSyncProgress(done, total, 'Uploading ' + tbl + ' to cloud…');
      }
    }
    // Persist stamped timestamps directly, not via the debounced saveData().
    if (anyStamped) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases })); } catch(e){}
    }
    hideSyncProgress();
    setSyncStatus('ok');
    toast('All data synced to cloud ✓');
  } catch(e) {
    hideSyncProgress();
    setSyncStatus('error', e.message);
    toastError('Cloud sync failed - data saved locally. Try again when online.');
  }
}


// DB is populated async by initDB() called at bottom of page
let DB = { singles: [], slabs: [], sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [] };

function genId(prefix) { return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2,6); }

// ── Async DB init ────────────────────────────────────────────
// ── One-time data migration: backfill marketPrice from listPrice ──
// Runs every load but only patches records that genuinely have no marketPrice.
// Also normalises date fields to "D Mon YYYY" format.
function migrateData() {
  let dirty = false;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  function normDate(val) {
    if (!val) return val;
    // Already has a 4-digit year? leave it
    if (/\d{4}/.test(val)) return val;
    // Formats: "26 Aug", "Aug 26", "2024-08-26", etc
    let d = null;
    // Try "D Mon" or "Mon D"
    const m1 = val.match(/^(\d{1,2})\s+([A-Za-z]{3})$/);
    if (m1) { d = new Date(Date.now()); d.setMonth(months.indexOf(m1[2].charAt(0).toUpperCase()+m1[2].slice(1).toLowerCase())); d.setDate(parseInt(m1[1])); }
    const m2 = val.match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
    if (m2) { d = new Date(Date.now()); d.setMonth(months.indexOf(m2[1].charAt(0).toUpperCase()+m2[1].slice(1).toLowerCase())); d.setDate(parseInt(m2[2])); }
    if (d && !isNaN(d)) return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
    return val;
  }

  const currentYear = new Date().getFullYear();
  function addYear(val) {
    if (!val) return val;
    if (/\d{4}/.test(val)) return val;
    // e.g. "26 Aug" -> "26 Aug 2025" - assume current year
    const m = val.match(/^(\d{1,2})\s+([A-Za-z]{3})$/);
    if (m) return m[1] + ' ' + m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase() + ' ' + currentYear;
    return val;
  }

  DB.singles.forEach(i => {
    // Backfill marketPrice from listPrice if missing
    if ((i.marketPrice === '' || i.marketPrice === null || i.marketPrice === undefined) && i.listPrice) {
      i.marketPrice = String(i.listPrice);
      dirty = true;
    }
    // Normalise date
    const d = addYear(i.datePurchased);
    if (d && d !== i.datePurchased) { i.datePurchased = d; dirty = true; }
  });

  DB.slabs.forEach(i => {
    // Backfill marketPrice from listPrice if missing
    if ((i.marketPrice === '' || i.marketPrice === null || i.marketPrice === undefined) && i.listPrice) {
      i.marketPrice = String(i.listPrice);
      dirty = true;
    }
    // Normalise grader to uppercase so TAG cert links work
    if (i.grader && i.grader !== i.grader.toUpperCase()) {
      i.grader = i.grader.toUpperCase();
      dirty = true;
    }
    // Normalise date
    const d = addYear(i.dateListed);
    if (d && d !== i.dateListed) { i.dateListed = d; dirty = true; }
  });

  DB.sales.forEach(i => {
    const d = addYear(i.dateSold);
    if (d && d !== i.dateSold) { i.dateSold = d; dirty = true; }
  });

  if (dirty) {
    // Update localStorage only - no cloud re-upload triggered
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases })); bumpLocalVersion(); } catch(e) {}
    console.log('migrateData: patched records in local cache');
  }
}

// ── Ensure any date value typed by user includes a year ──
// Canonical month abbreviations + a flexible parser that accepts every format
// the app has historically stored ("23 aung 2025", "23 Aug 2025", "2025-05-19",
// "8/5/2026", typos like "aung"/"setp"/"febr"/"marc") and emits "D MMM YYYY".
const MONTHS_ABBR  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LOWER = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function _monthIdxFromString(str){
  if (!str) return -1;
  const s = str.toString().trim().toLowerCase();
  // Exact match
  let i = MONTHS_LOWER.indexOf(s.slice(0,3));
  if (i >= 0) return i;
  // Unambiguous prefix only - the candidate month name must start with the
  // full input token, and the token must be at least 3 chars. Accepts longer
  // spellings ("june", "sept") but rejects short/ambiguous fragments like
  // "ju" (jun or jul?) that used to silently resolve to whichever month
  // happened to come first in the array.
  if (s.length >= 3) {
    const cand = MONTHS_LOWER.find(m => m.startsWith(s));
    if (cand) return MONTHS_LOWER.indexOf(cand);
  }
  return -1;
}
function toDateMmmYyyy(val){
  if (val == null) return '';
  const s = String(val).trim();
  if (!s) return '';
  // 1. ISO: 2025-05-19 → "19 May 2025"
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const mi = parseInt(m[2],10) - 1;
    if (mi >= 0 && mi < 12) return parseInt(m[3],10) + ' ' + MONTHS_ABBR[mi] + ' ' + m[1];
  }
  // 2. "D MMM YYYY" or "D MMMM YYYY" or "D <typo> YYYY"
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m) {
    const mi = _monthIdxFromString(m[2]);
    if (mi >= 0) return parseInt(m[1],10) + ' ' + MONTHS_ABBR[mi] + ' ' + m[3];
  }
  // 3. "D MMM" (no year) - assume current year
  m = s.match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (m) {
    const mi = _monthIdxFromString(m[2]);
    if (mi >= 0) return parseInt(m[1],10) + ' ' + MONTHS_ABBR[mi] + ' ' + new Date().getFullYear();
  }
  // 4. "DD/MM/YYYY" or "D-M-YYYY" - assume DD/MM (international)
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) {
    const mi = parseInt(m[2],10) - 1;
    if (mi >= 0 && mi < 12) return parseInt(m[1],10) + ' ' + MONTHS_ABBR[mi] + ' ' + m[3];
  }
  // 5. "MMM YYYY" only → "1 MMM YYYY"
  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mi = _monthIdxFromString(m[1]);
    if (mi >= 0) return '1 ' + MONTHS_ABBR[mi] + ' ' + m[2];
  }
  // Couldn't parse - return original so user can correct it
  return s;
}
// Convert any stored date back to a millisecond timestamp for proper sorting.
function dateToMs(val){
  const s = toDateMmmYyyy(val);
  if (!s) return 0;
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return 0;
  const mi = _monthIdxFromString(m[2]);
  if (mi < 0) return 0;
  return new Date(parseInt(m[3],10), mi, parseInt(m[1],10)).getTime();
}

function formatDateInput(val) {
  // Wrap the strict normalizer so existing callers keep working.
  return toDateMmmYyyy(val);
}
// Convert any stored date ("D MMM YYYY" or ISO) → "YYYY-MM-DD" for <input type="date">.
// The modal stores dates as "D MMM YYYY"; the browser date picker needs ISO format.
function toIsoDateStr(val) {
  const s = toDateMmmYyyy(val);
  if (!s) return '';
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!m) return '';
  const mi = _monthIdxFromString(m[2]);
  if (mi < 0) return '';
  return m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
}

// =========== UNIFIED MANUAL-INPUT NORMALIZER ===========
// Every manual-entry path (Add Single modal, Add Slab modal, Add Sale modal,
// kjr modal for ETB/BB/Pack/eBay) routes its raw form values through this so
// the saved record matches the pre-existing table format. Without this each
// path stored slightly different shapes (date with no year, "$45.00" strings
// vs 45 numbers, "nm" vs "Near Mint" etc) and the renderers showed mismatched
// formatting.
function normalizeRecord(table, obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  // 1. Numbers - strip leading $/spaces, parseFloat, drop NaN
  const numKeys = ['costPrice','marketPrice','listPrice','unitPrice','totalPrice',
                   'totalCollected','shippingCost','profit','priceUsd','freightSgd','totalSgd','qty','priceAlert'];
  numKeys.forEach(k => {
    if (out[k] === '' || out[k] == null) return;
    const v = parseFloat(String(out[k]).replace(/[^0-9.\-]/g, ''));
    out[k] = isNaN(v) ? '' : (k === 'qty' ? Math.max(1, Math.round(v)) : v);
  });
  // 2. Dates - "D MMM YYYY"
  ['datePurchased','dateListed','dateSold','date','receivedAt'].forEach(k => {
    if (out[k]) out[k] = formatDateInput(out[k]);
  });
  // 3. Language → uppercase canonical EN/JP/CN/ID
  if (out.language) {
    const L = out.language.toString().trim().toUpperCase();
    out.language = ['EN','JP','CN','ID','KR'].includes(L) ? L : L;
  }
  // 4. Condition → canonical long form (matches the edit-modal <select>)
  if (out.condition && table !== 'etbs' && table !== 'boosterBoxes' && table !== 'boosterPacks') {
    const c = out.condition.toString().trim().toLowerCase();
    out.condition =
      (c === 'nm' || c.includes('near')) ? 'Near Mint' :
      (c === 'lp' || c.includes('lightly')) ? 'Lightly Played' :
      (c === 'mp' || c.includes('moderately')) ? 'Moderately Played' :
      (c === 'hp' || c.includes('heavily')) ? 'Heavily Played' :
      (c === 'damaged') ? 'Damaged' :
      (c === 'mint') ? 'Mint' :
      out.condition;
  }
  // 5. Grader + grade → canonical via _resolveGrader. Edits / new entries
  // get cleaned at save time so going forward the data is consistent.
  // Existing messy rows aren't touched here (the resolver handles them on
  // read), so we don't accidentally mutate hundreds of rows on every save.
  // Only runs for slab rows where the resolver can confidently extract.
  if (table === 'slabs' && typeof _resolveGrader === 'function') {
    const r = _resolveGrader(out.grader, out.grade);
    if (r.grader) out.grader = r.grader;
    if (r.grade)  out.grade  = r.grade;
  } else if (out.grader) {
    out.grader = out.grader.toString().trim().toUpperCase();
  }
  // 6. Status default
  if (table === 'singles' || table === 'slabs') {
    if (!out.status) out.status = 'Available';
  }
  // 7. Type default
  if (table === 'singles' && !out.type) out.type = 'raw';
  if (table === 'slabs') out.type = 'slab';
  // 8. Trim text fields
  ['name','set','product','buyer','notes','tracking','certNo','rank','tcgdexId'].forEach(k => {
    if (typeof out[k] === 'string') out[k] = out[k].trim();
  });
  return out;
}

// ── Cloud/local row merge, shared by every table (primary and secondary) ──
// Hoisted to module scope (was a const declared inside initDB's "cloud has
// data" if-block) so the secondary-table merge below (etbs/boosterBoxes/
// boosterPacks/ebayPurchases) genuinely reuses this, instead of a
// `typeof mergeTable === 'function'` check that was always false because the
// const was out of scope there - secondary tables were silently getting a
// simplified fallback with no conflict/Changelog handling (FINDING A1).
// No closure dependencies on anything block-local: only its own params plus
// module-level _persistDirty, toastError, clLog, _clDiff.
function mergeTable(cloudRows, localRows, dirtySet, tableKey) {
  // Guard against a 200-with-zero-rows response wiping local data (M5).
  // A genuinely empty cloud table is indistinguishable at the HTTP level
  // from a transient RLS/schema hiccup that also returns []. If local
  // has rows the cloud does not, trust local, mark it all dirty so it
  // re-uploads on the next flush, and warn once instead of silently
  // discarding the only copy.
  if ((!cloudRows || cloudRows.length === 0) && localRows && localRows.length > 0) {
    localRows.forEach(r => dirtySet && dirtySet.add(r.id));
    if (dirtySet) _persistDirty();
    const already = mergeTable._warned || (mergeTable._warned = new Set());
    if (!already.has(tableKey)) {
      already.add(tableKey);
      if (typeof toastError === 'function') toastError('Cloud returned no data for "' + tableKey + '" - kept your local copy and queued it to re-upload.');
      console.warn('[mergeTable] cloud empty for ' + tableKey + ', keeping ' + localRows.length + ' local row(s)');
    }
    return localRows;
  }
  if (!dirtySet || dirtySet.size === 0) return cloudRows;
  const byId = new Map(cloudRows.map(r => [r.id, r]));
  for (const id of [...dirtySet]) {
    const localRow = localRows.find(r => r.id === id);
    if (!localRow) continue;
    // Conflict check: _updatedAt on the local row is the cloud timestamp
    // its edit was based on (the server refreshes it on every fetch). If
    // the cloud copy is strictly newer, another device wrote after our
    // unsynced edit. Keep the newer cloud copy rather than silently
    // overwriting it on the next flush, and surface what was discarded.
    const cloudRow = byId.get(id);
    const cloudMs = cloudRow && cloudRow._updatedAt ? new Date(cloudRow._updatedAt).getTime() : 0;
    const baseMs  = localRow._updatedAt ? new Date(localRow._updatedAt).getTime() : 0;
    if (cloudRow && baseMs && cloudMs > baseMs) {
      dirtySet.delete(id);
      const label = localRow.name || localRow.product || id;
      const diff = (typeof _clDiff === 'function') ? _clDiff(tableKey, cloudRow, localRow) : '';
      if (typeof clLog === 'function') clLog('conflict', tableKey, label, 'kept newer cloud copy, discarded local edit: ' + (diff || 'no tracked-field differences'));
      if (typeof toastError === 'function') toastError('Sync conflict on "' + label + '": a newer edit from another device was kept. Details in Changelog.');
      continue;
    }
    byId.set(id, localRow);
  }
  _persistDirty();
  return [...byId.values()];
}

async function initDB() {
  const main = document.getElementById('main-content');

  // ── Always fetch from Supabase first - it is the source of truth ──
  // Show cached localStorage instantly while cloud loads (no count-based decisions)
  let shownLocal = false;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const local = JSON.parse(raw);
      if (local.singles?.length || local.slabs?.length || local.sales?.length) {
        DB.singles       = local.singles       || [];
        DB.slabs         = local.slabs         || [];
        DB.sales         = local.sales         || [];
        DB.etbs          = local.etbs          || [];
        DB.boosterBoxes  = local.boosterBoxes  || [];
        DB.boosterPacks  = local.boosterPacks  || [];
        DB.ebayPurchases = local.ebayPurchases || [];
        showPage('dashboard');
        shownLocal = true;
      }
    }
  } catch(e) {}

  if (!shownLocal) {
    if (main) main.innerHTML = '<div class="hig-loading"><div class="hig-spinner"></div><div class="hig-loading-text">Loading inventory from cloud…</div></div>';
  }

  setSyncStatus('saving');
  try {
    // Flush any deletes/trash writes that failed and got queued in a
    // previous session BEFORE fetching from cloud. If this ran after the
    // fetch/merge below, a row whose delete failed last session (still sat
    // in Supabase, unreachable at the time) would be fetched, merged back
    // into DB, and rendered - resurrecting a row the user already deleted
    // (FINDING A2). Trash first so the snapshot exists before its source
    // row is deleted. Awaited (not fire-and-forget) so the fetch below
    // genuinely runs after Supabase reflects the deletes.
    await flushPendingTrash().catch(e => console.warn('flushPendingTrash failed:', e));
    await flushPendingDeletes().catch(e => console.warn('flushPendingDeletes failed:', e));

    const [sbSingles, sbSlabs, sbSales] = await Promise.all([
      sbFetchAll('singles'), sbFetchAll('slabs'), sbFetchAll('sales')
    ]);

    if (sbSingles.length || sbSlabs.length || sbSales.length) {
      // ✅ Cloud has data - use it as the base, BUT preserve any local rows
      // that are still marked dirty (i.e. edited locally but not yet synced).
      // This closes a race: user opens app → quick-render from local → edits
      // card X → cloud fetch returns → cloud version of X would otherwise
      // overwrite the in-flight edit. With this merge, dirty IDs win.
      // mergeTable is now hoisted to module scope (above initDB) so the
      // secondary-table merge below shares this exact implementation.
      DB.singles = mergeTable(sbSingles, DB.singles, _dirty.singles, 'singles');
      DB.slabs   = mergeTable(sbSlabs,   DB.slabs,   _dirty.slabs,   'slabs');
      DB.sales   = mergeTable(sbSales,   DB.sales,   _dirty.sales,   'sales');
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases })); bumpLocalVersion(); } catch(e) {}
      setSyncStatus('ok');
      // Pending trash/delete retry now runs BEFORE the cloud fetch above
      // (see comment there) so it isn't repeated here.
      if (!shownLocal) showPage('dashboard');
      else { renderDashboard(); renderSingles(); renderSlabs(); renderSales(); }
    } else if (!shownLocal) {
      // Cloud is empty AND no local cache - this is a genuine first-ever run
      // Do NOT auto-seed from hardcoded data. Show empty state.
      // NOTE: etbs/boosterBoxes/boosterPacks/ebayPurchases are deliberately
      // NOT wiped here (M5/A4) - the secondary-tables fetch below now always
      // runs regardless of which branch the primary tables took, and a fresh
      // profile whose only cloud data is sealed products must still load it.
      DB.singles = []; DB.slabs = []; DB.sales = [];
      setSyncStatus('ok');
      showPage('dashboard');
      toast('Welcome! Add your first card to get started.');
    } else {
      // Cloud returned 0 but we have local - local might have unsync'd data, push it up
      setSyncStatus('ok');
      console.log('Cloud empty but local has data - pushing local up');
      await saveAllToSupabase();
    }

    // ── KJR sealed/secondary tables: ALWAYS fetch and merge, independent of ──
    // whether singles/slabs/sales had data (M5/A4). Previously this sat inside
    // the "primary tables non-empty" branch, so a fresh profile or device whose
    // only cloud data was sealed products (etbs/booster boxes/packs/eBay) never
    // loaded it. mergeTable is a module-level function (hoisted above initDB),
    // always in scope here, so these tables now get the same conflict/Changelog
    // handling as the primary tables (FINDING A1 - previously a
    // `typeof mergeTable === 'function'` check that was always false because
    // mergeTable used to be a block-local const, silently downgrading these
    // four tables to a simplified fallback with no conflict detection).
    try {
      const [sbEtbs, sbBb, sbBp, sbEbay] = await Promise.all([
        sbFetchAll('etbs').catch(()=>[]),
        sbFetchAll('booster_boxes').catch(()=>[]),
        sbFetchAll('booster_packs').catch(()=>[]),
        sbFetchAll('ebay_purchases').catch(()=>[])
      ]);
      DB.etbs          = mergeTable(sbEtbs, DB.etbs || [], _dirty.etbs, 'etbs');
      DB.boosterBoxes  = mergeTable(sbBb,   DB.boosterBoxes || [], _dirty.boosterBoxes, 'boosterBoxes');
      DB.boosterPacks  = mergeTable(sbBp,   DB.boosterPacks || [], _dirty.boosterPacks, 'boosterPacks');
      DB.ebayPurchases = mergeTable(sbEbay, DB.ebayPurchases || [], _dirty.ebayPurchases, 'ebayPurchases');
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases })); } catch(e){}
      if (typeof renderEtbs === 'function') renderEtbs();
      if (typeof renderBoosterBoxes === 'function') renderBoosterBoxes();
      if (typeof renderBoosterPacks === 'function') renderBoosterPacks();
      if (typeof renderEbayPurchases === 'function') renderEbayPurchases();
    } catch(e) { console.warn('KJR new-tables load failed:', e); }

    // ── One-time migration: run only if not already done ──
    if (!localStorage.getItem('pokeinv_migrated_v2')) {
      migrateData();
      localStorage.setItem('pokeinv_migrated_v2', '1');
    }

    // ── Session 1 migration: backfill fees=0 and channel='Carousell' on ──
    // existing sales that pre-date these fields. Runs once per device.
    if (!localStorage.getItem('pokeinv_migrated_v3')) {
      let n = 0;
      (DB.sales || []).forEach(s => {
        let changed = false;
        if (s.fees == null) { s.fees = 0; changed = true; }
        if (!s.channel)     { s.channel = 'Carousell'; changed = true; }
        if (changed) { markDirty('sales', s.id); n++; }
      });
      if (n > 0) { saveData(); console.info('[v3 migration] backfilled ' + n + ' sales'); }
      localStorage.setItem('pokeinv_migrated_v3', '1');
    }

    // ── Retry any dirty items persisted from a previous failed sync ──
    const dirtyCount = _dirty.singles.size + _dirty.slabs.size + _dirty.sales.size +
                       (_dirty.etbs?.size||0) + (_dirty.boosterBoxes?.size||0) +
                       (_dirty.boosterPacks?.size||0) + (_dirty.ebayPurchases?.size||0);
    if (dirtyCount > 0) {
      console.log('Retrying ' + dirtyCount + ' pending dirty items from previous session');
      setTimeout(() => _flushDirtyToSupabase(), 2000);
    }

  } catch(e) {
    setSyncStatus('error', 'Cloud unreachable - showing cached data');
    if (!shownLocal) {
      // Truly offline with no cache - show empty, don't load stale SEED
      DB.singles = []; DB.slabs = []; DB.sales = []; DB.etbs = []; DB.boosterBoxes = []; DB.boosterPacks = []; DB.ebayPurchases = [];
      showPage('dashboard');
      toastError('Could not reach cloud. Check your connection and refresh.');
    }
  }
}

// ── Two-tab safety net (B2) ───────────────────────────────────
// Merge an incoming table (from another tab's localStorage write) into this
// tab's in-memory DB, id-keyed, keeping whichever copy of each row is newer.
// This is deliberately simpler than initDB's mergeTable (no Changelog entry,
// no dirty-vs-cloud conflict semantics) because both sides here are just
// localStorage snapshots of the SAME source of truth, not cloud vs local.
function _rowTime(row) {
  const v = row && (row._updatedAt || row.updated);
  const t = v ? new Date(v).getTime() : 0;
  return isNaN(t) ? 0 : t;
}
function mergeIntoMemory(key, incomingRows) {
  if (!Array.isArray(incomingRows)) return;
  const mineById = new Map((DB[key] || []).map(r => [r.id, r]));
  for (const inRow of incomingRows) {
    const mine = mineById.get(inRow.id);
    if (!mine) { mineById.set(inRow.id, inRow); continue; }
    // Newer of the two wins. Rows still dirty in THIS tab (unsynced local
    // edits) are protected: only overwrite if the incoming copy is strictly
    // newer, never on a tie, so we don't discard an in-flight edit for free.
    if (_rowTime(inRow) > _rowTime(mine)) mineById.set(inRow.id, inRow);
  }
  DB[key] = [...mineById.values()];
}

let _kjrCrossTabToastPending = false;
function _kjrCrossTabToast() {
  if (_kjrCrossTabToastPending) return;
  _kjrCrossTabToastPending = true;
  setTimeout(() => {
    _kjrCrossTabToastPending = false;
    try { toast('Another tab updated the data - merged'); } catch(e){}
  }, 400); // debounce a burst of storage events into a single toast
}

// Fires whenever ANOTHER tab/window on the same origin writes localStorage.
// Without this, tab B's saveData() silently clobbers tab A's in-memory rows
// and dirty queue on A's next write, permanently losing A's offline edit (B2).
window.addEventListener('storage', (e) => {
  try {
    if (e.key === STORAGE_KEY && e.newValue) {
      const incoming = JSON.parse(e.newValue);
      const keys = ['singles','slabs','sales','etbs','boosterBoxes','boosterPacks','ebayPurchases'];
      for (const k of keys) mergeIntoMemory(k, incoming[k]);
      // Reload our own dirty set too - _persistDirty's read-merge-write means
      // the stored blob may now include ids the other tab queued.
      const reloaded = _loadDirtyFromLS();
      for (const k of keys) {
        if (!_dirty[k]) continue;
        for (const id of reloaded[k]) _dirty[k].add(id);
      }
      const name = document.querySelector('.page.active')?.id?.replace('page-', '');
      if (name && typeof showPage === 'function') showPage(name);
      _kjrCrossTabToast();
    }
  } catch(err) { console.warn('[storage listener] merge failed:', err); }
});


// =========== BULK SELECT ===========
const selectedIds = { singles: new Set(), slabs: new Set(), sales: new Set() };

function toggleRowSelect(table, id, checked) {
  if (checked) selectedIds[table].add(id);
  else selectedIds[table].delete(id);
  updateBulkBar(table);
}

function toggleSelectAll(table, checked) {
  // only affect currently visible rows
  const tbody = document.getElementById(
    table === 'singles' ? 'singles-body' : table === 'slabs' ? 'slabs-body' : 'sales-body'
  );
  tbody.querySelectorAll('tr[data-id]').forEach(row => {
    const id = row.dataset.id;
    if (checked) selectedIds[table].add(id);
    else selectedIds[table].delete(id);
    const cb = row.querySelector('.row-cb');
    if (cb) cb.checked = checked;
    row.classList.toggle('row-selected', checked);
  });
  updateBulkBar(table);
}

function selectAllVisible(table) {
  toggleSelectAll(table, true);
  const allCb = document.getElementById('cb-all-' + table);
  if (allCb) allCb.checked = true;
}

function clearSelection(table) {
  selectedIds[table].clear();
  const allCb = document.getElementById('cb-all-' + table);
  if (allCb) allCb.checked = false;
  if (table === 'singles') renderSingles();
  if (table === 'slabs') renderSlabs();
  if (table === 'sales') renderSales();
  updateBulkBar(table);
}

function updateBulkBar(table) {
  const count = selectedIds[table].size;
  const bar = document.getElementById('bulk-bar-' + table);
  const countEl = document.getElementById('bulk-count-' + table);
  if (!bar) return;
  bar.classList.toggle('show', count > 0);
  countEl.textContent = count + ' item' + (count !== 1 ? 's' : '') + ' selected';
  // sync header checkbox indeterminate state
  const allCb = document.getElementById('cb-all-' + table);
  if (allCb) {
    const tbody = document.getElementById(
      table === 'singles' ? 'singles-body' : table === 'slabs' ? 'slabs-body' : 'sales-body'
    );
    const total = tbody ? tbody.querySelectorAll('tr[data-id]').length : 0;
    allCb.indeterminate = count > 0 && count < total;
    allCb.checked = total > 0 && count >= total;
  }
}

async function deleteSelected(table) {
  const ids = selectedIds[table];
  if (ids.size === 0) return;
  const count = ids.size;
  if (!await kjrConfirm('Move ' + count + ' item' + (count !== 1 ? 's' : '') + ' to trash? Restore within 30 days from the Trash tab.', {ok:'Move to trash', danger:true})) return;

  // Check for linked sales across all selected items.
  const linkedSales = DB.sales.filter(s => ids.has(s.inventoryId) && s.inventoryTable === table);
  let voidLinkedSales = false;
  if (linkedSales.length) {
    voidLinkedSales = await kjrConfirm(
      linkedSales.length + ' sale record' + (linkedSales.length !== 1 ? 's are' : ' is') +
      ' linked to items in this selection.\n\nTrash sales too → also move those sale(s) to trash.\nKeep sales → keep the sale record(s).',
      {ok:'Trash sales too', cancel:'Keep sales'}
    );
  }

  snapshotForUndo();
  if (voidLinkedSales) {
    const linkedIds = new Set(linkedSales.map(s => s.id));
    DB.sales = DB.sales.filter(s => !linkedIds.has(s.id));
    linkedSales.forEach(s => {
      sendToTrash('sales', s, 'linked-item-bulk-deleted').catch(() => {});
      sbDelete('sales', s.id).catch(() => {});
      clLog('delete', 'sales', s.product, 'auto-trashed (linked item bulk-deleted)');
    });
    renderSales();
  }
  const itemsToTrash = DB[table].filter(i => ids.has(i.id));
  const idsCopy = new Set(ids);

  // ── Optimistic update: remove from UI immediately ──
  DB[table] = DB[table].filter(i => !ids.has(i.id));
  ids.clear();
  saveData();
  updateBulkBar(table);
  if (table === 'singles') renderSingles();
  if (table === 'slabs') renderSlabs();
  if (table === 'sales') renderSales();
  toast(count + ' moved to trash · view in 🗑 tab');
  // Audit: list the names + cost of every deleted row so the changelog
  // can answer "what did we just lose?" without diving into trash.
  // Cap the list at 20 names to keep entries readable; full set is in trash.
  const labelOf = (it) => (it.name || it.product || it.id || '?') +
                          (it.costPrice !== undefined && it.costPrice !== '' ? ' (S$' + it.costPrice + ')' : '');
  const sample = itemsToTrash.slice(0, 20).map(labelOf);
  const extraBulk = sample.join(' · ') + (itemsToTrash.length > sample.length ? ' · …+' + (itemsToTrash.length - sample.length) + ' more' : '');
  clLog('delete', table, count + ' items deleted (bulk)', extraBulk);

  // ── Background: batch trash + parallel Supabase deletes ──
  Promise.all([
    sendBatchToTrash(table, itemsToTrash, 'bulk'),
    ...itemsToTrash.map(item => sbDelete(table, item.id))
  ]).catch(e => {
    setSyncStatus('error', 'Delete sync failed: ' + e.message);
    console.error('Bulk delete background sync failed:', e);
  });
}

// =========== COLUMN VISIBILITY & ORDER ===========
const COL_DEFS = {
  singles: [
    { key: '_cb',           label: '',           locked: true },
    { key: 'name',          label: 'Card',       locked: true },
    { key: 'costPrice',     label: 'Cost' },
    { key: 'marketPrice',   label: 'Market' },
    { key: 'listPrice',     label: 'Carousell' },
    { key: 'language',      label: 'Lang' },
    { key: 'type',          label: 'Type' },
    { key: 'datePurchased', label: 'Date' },
    { key: 'actions',       label: 'Actions',    locked: true }
  ],
  slabs: [
    { key: '_cb',         label: '',                  locked: true },
    { key: 'name',        label: 'Card',              locked: true },
    { key: '_grade',      label: 'Grade' },
    { key: 'costPrice',   label: 'Cost' },
    { key: 'certNo',      label: 'Cert #' },
    { key: 'rank',        label: 'Rank' },
    { key: 'dateListed',  label: 'Date' },
    { key: 'language',    label: 'Lang' },
    { key: 'marketPrice', label: 'Market' },
    { key: 'listPrice',   label: 'Carousell' },
    { key: 'actions',     label: 'Actions',           locked: true }
  ],
  sales: [
    { key: '_cb',            label: '',          locked: true },
    { key: 'dateSold',       label: 'Date',      locked: true },
    { key: 'product',        label: 'Product',   locked: true },
    { key: 'buyer',          label: 'Buyer' },
    { key: 'costPrice',      label: 'Cost' },
    { key: 'totalCollected', label: 'Revenue' },
    { key: 'shippingCost',   label: 'Shipping' },
    { key: 'fees',           label: 'Fees' },
    { key: 'channel',        label: 'Channel' },
    { key: 'daysHeld',       label: 'Days Held' },
    { key: 'profit',         label: 'Profit' },
    { key: 'margin',         label: 'Margin' },
    { key: 'actions',        label: 'Actions',   locked: true }
  ]
};

// colOrder stores the current key order per table (persisted)
const colOrder = { singles: null, slabs: null, sales: null };

(function initColOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem('pokeinv_colorder') || '{}');
    ['singles','slabs','sales'].forEach(t => {
      const defaultKeys = COL_DEFS[t].map(c => c.key);
      const s = Array.isArray(saved[t]) ? saved[t] : null;
      if (!s) { colOrder[t] = defaultKeys; return; }
      // Gracefully merge across schema changes: keep saved positions for
      // keys that still exist, then append any new keys at the end. Drop
      // stale keys. Previously this required an exact-length+set match,
      // so adding a new column ANYWHERE in COL_DEFS silently wiped the
      // user's saved column order on next page load.
      const valid = s.filter(k => defaultKeys.includes(k));
      const missing = defaultKeys.filter(k => !valid.includes(k));
      colOrder[t] = [...valid, ...missing];
    });
  } catch(e) {
    ['singles','slabs','sales'].forEach(t => { colOrder[t] = COL_DEFS[t].map(c => c.key); });
  }
})();

// One-time migration: move Cost to sit between Grade and Cert # in slabs
(function(){
  const order = colOrder.slabs;
  if (!order) return;
  const gi = order.indexOf('_grade'), ci = order.indexOf('costPrice');
  if (gi < 0 || ci < 0 || ci === gi + 1) return;
  order.splice(ci, 1);
  order.splice(order.indexOf('_grade') + 1, 0, 'costPrice');
  try { localStorage.setItem('pokeinv_colorder', JSON.stringify(colOrder)); } catch(e){}
})();

function saveColOrder() {
  localStorage.setItem('pokeinv_colorder', JSON.stringify(colOrder));
}

function getOrderedDefs(table) {
  const order = colOrder[table];
  const defMap = {};
  COL_DEFS[table].forEach(c => defMap[c.key] = c);
  return order.map(k => defMap[k]).filter(Boolean);
}

// Load saved visibility or default all visible
const colVis = { singles: {}, slabs: {}, sales: {} };
(function initColVis() {
  try {
    const saved = JSON.parse(localStorage.getItem('pokeinv_colvis') || '{}');
    ['singles','slabs','sales'].forEach(t => {
      COL_DEFS[t].forEach(c => {
        colVis[t][c.key] = saved[t]?.[c.key] !== undefined ? saved[t][c.key] : true;
      });
    });
  } catch(e) {
    ['singles','slabs','sales'].forEach(t => COL_DEFS[t].forEach(c => colVis[t][c.key] = true));
    // Carousell Price hidden by default - togglable via column picker
    if (colVis.singles) colVis.singles.listPrice = false;
    if (colVis.slabs)   colVis.slabs.listPrice   = false;
  }
})();

function saveColVis() {
  localStorage.setItem('pokeinv_colvis', JSON.stringify(colVis));
}

function isColVisible(table, key) {
  return colVis[table][key] !== false;
}

function buildColMenus() {
  ['singles','slabs','sales'].forEach(table => {
    const dropdown = document.getElementById('ctd-' + table);
    const existing = dropdown.querySelectorAll('.col-toggle-item');
    existing.forEach(el => el.remove());
    const defs = getOrderedDefs(table);
    defs.forEach(col => {
      if (col.key === '_cb') return; // never show checkbox col in menu
      const visible = isColVisible(table, col.key);
      const item = document.createElement('div');
      item.className = 'col-toggle-item drag-item' + (visible ? ' checked' : '');
      item.dataset.key = col.key;
      item.draggable = !col.locked;
      item.innerHTML =
        '<span class="col-drag-handle">' + (col.locked ? '🔒' : '⠿') + '</span>' +
        '<input type="checkbox"' + (visible ? ' checked' : '') + (col.locked ? ' disabled' : '') + '> ' +
        '<span style="flex:1">' + col.label + '</span>' +
        (col.locked ? '' :
          '<button type="button" class="btn btn-ghost btn-sm col-order-btn" style="padding:2px 6px;font-size:11px" title="Move up" onclick="event.stopPropagation();moveColOrderStep(\'' + table + '\',\'' + col.key + '\',-1)">↑</button>' +
          '<button type="button" class="btn btn-ghost btn-sm col-order-btn" style="padding:2px 6px;font-size:11px" title="Move down" onclick="event.stopPropagation();moveColOrderStep(\'' + table + '\',\'' + col.key + '\',1)">↓</button>'
        );
      if (!col.locked) {
        item.querySelector('input').addEventListener('change', function(e) {
          e.stopPropagation();
          colVis[table][col.key] = this.checked;
          item.classList.toggle('checked', this.checked);
          saveColVis();
          applyColVisibility(table);
        });
        // drag reorder in menu
        item.addEventListener('dragstart', e => {
          e.dataTransfer.setData('text/plain', col.key);
          e.dataTransfer.effectAllowed = 'move';
        });
        item.addEventListener('dragover', e => {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          dropdown.querySelectorAll('.col-toggle-item').forEach(el => el.classList.remove('drag-over-item'));
          item.classList.add('drag-over-item');
        });
        item.addEventListener('dragleave', () => item.classList.remove('drag-over-item'));
        item.addEventListener('drop', e => {
          e.preventDefault();
          item.classList.remove('drag-over-item');
          const fromKey = e.dataTransfer.getData('text/plain');
          const toKey = col.key;
          if (fromKey === toKey) return;
          moveColOrder(table, fromKey, toKey);
        });
      }
      dropdown.appendChild(item);
    });
  });
}

function moveColOrder(table, fromKey, toKey) {
  const order = colOrder[table];
  const fromIdx = order.indexOf(fromKey);
  const toIdx   = order.indexOf(toKey);
  if (fromIdx < 0 || toIdx < 0) return;
  order.splice(fromIdx, 1);
  order.splice(toIdx, 0, fromKey);
  saveColOrder();
  // Reset thead flag so it gets reordered on next render
  const tableId = table === 'singles' ? 'singles-table' : table === 'slabs' ? 'slabs-table' : null;
  const tbl = tableId ? document.getElementById(tableId) : document.querySelector('#page-sales table');
  if (tbl) tbl._theadOrdered = false;
  buildColMenus();
  if (table === 'singles') renderSingles();
  else if (table === 'slabs') renderSlabs();
  else if (table === 'sales') renderSales();
}

// Tap-based reorder (no drag required) - moves a column one slot up or down
// by swapping it with its immediate neighbour in colOrder, then reuses the
// exact same reorder+persist path (moveColOrder) that the drag-and-drop
// handlers call, so both input methods stay in sync.
function moveColOrderStep(table, key, dir) {
  const order = colOrder[table];
  const idx = order.indexOf(key);
  if (idx < 0) return;
  const targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= order.length) return;
  const neighbourKey = order[targetIdx];
  moveColOrder(table, key, neighbourKey);
}

function applyColVisibility(table) {
  const defs = getOrderedDefs(table);
  const tableId = table === 'singles' ? 'singles-table' : table === 'slabs' ? 'slabs-table' : null;
  const tbl = tableId ? document.getElementById(tableId) : document.querySelector('#page-sales table');
  if (!tbl) return;
  // Use data-col-key to find and show/hide cells reliably
  COL_DEFS[table].forEach(col => {
    const visible = isColVisible(table, col.key);
    tbl.querySelectorAll('[data-col-key="' + col.key + '"]').forEach(cell => {
      cell.style.display = visible ? '' : 'none';
    });
  });
  // update checkbox states in menu
  const dropdown = document.getElementById('ctd-' + table);
  if (!dropdown) return;
  const items = dropdown.querySelectorAll('.col-toggle-item input');
  defs.filter(c => c.key !== '_cb').forEach((col, idx) => {
    if (items[idx]) items[idx].checked = isColVisible(table, col.key);
  });
}

function toggleColMenu(table) {
  const wrap = document.getElementById('ctw-' + table);
  const isOpen = wrap.classList.contains('open');
  // close all popovers (column menus + filter menus) so only one is open
  document.querySelectorAll('.col-toggle-wrap.open, .filters-wrap.open').forEach(w => w.classList.remove('open'));
  if (!isOpen) wrap.classList.add('open');
}

// ── Consolidated Filters popover (Language / Type / Status) ──────────
function toggleFiltersMenu(table) {
  const wrap = document.getElementById('fw-' + table);
  if (!wrap) return;
  const isOpen = wrap.classList.contains('open');
  document.querySelectorAll('.col-toggle-wrap.open, .filters-wrap.open').forEach(w => w.classList.remove('open'));
  if (!isOpen) { wrap.classList.add('open'); updateFiltersBadge(table); }
}

// Show a count of active filters on the Filters button (status 'available'
// is the default, so it doesn't count as an active filter).
function updateFiltersBadge(table) {
  const badge = document.getElementById('filters-badge-' + table);
  if (!badge) return;
  let n = 0;
  if (table === 'singles') {
    if ((document.getElementById('singles-lang') || {}).value) n++;
    if ((document.getElementById('singles-type') || {}).value) n++;
    const st = (document.getElementById('singles-status-filter') || {}).value;
    if (st && st !== 'available') n++;
  }
  badge.textContent = n ? String(n) : '';
}

function resetSinglesFilters() {
  const lang = document.getElementById('singles-lang');
  const type = document.getElementById('singles-type');
  const st   = document.getElementById('singles-status-filter');
  if (lang) lang.value = '';
  if (type) type.value = '';
  if (st)   st.value = 'available';
  // Dispatch change so the mobile segmented mirrors rebuild and the table re-renders.
  [lang, type, st].forEach(s => s && s.dispatchEvent(new Event('change', { bubbles: true })));
  updateFiltersBadge('singles');
}

function setAllCols(table, visible) {
  COL_DEFS[table].forEach(col => {
    if (!col.locked) colVis[table][col.key] = visible;
  });
  saveColVis();
  buildColMenus();
  applyColVisibility(table);
}

// Reorder DOM cells in every row to match colOrder
// Each cell must have data-col-key set at render time
function applyColOrder(table) {
  const order = colOrder[table];
  const tableId = table === 'singles' ? 'singles-table' : table === 'slabs' ? 'slabs-table' : null;
  const tbl = tableId ? document.getElementById(tableId) : document.querySelector('#page-sales table');
  if (!tbl) return;
  // Only reorder tbody rows - never touch thead (would steal focus from filter inputs)
  tbl.querySelectorAll('tbody tr').forEach(row => {
    const cells = Array.from(row.cells);
    if (cells.length === 0) return;
    const keyToCell = {};
    cells.forEach(cell => { const k = cell.dataset.colKey; if (k) keyToCell[k] = cell; });
    const currentOrder = cells.map(c => c.dataset.colKey).filter(Boolean);
    const desiredOrder = order.filter(k => keyToCell[k]);
    if (desiredOrder.every((k, i) => currentOrder[i] === k)) return;
    desiredOrder.forEach(k => row.appendChild(keyToCell[k]));
  });
  // Reorder thead only once on initial load (no inputs are focused yet)
  // Use a flag so we don't touch it again during typing
  if (!tbl._theadOrdered) {
    tbl.querySelectorAll('thead tr').forEach(row => {
      const cells = Array.from(row.cells);
      if (cells.length === 0) return;
      const keyToCell = {};
      cells.forEach(cell => { const k = cell.dataset.colKey; if (k) keyToCell[k] = cell; });
      const currentOrder = cells.map(c => c.dataset.colKey).filter(Boolean);
      const desiredOrder = order.filter(k => keyToCell[k]);
      if (desiredOrder.every((k, i) => currentOrder[i] === k)) return;
      desiredOrder.forEach(k => row.appendChild(keyToCell[k]));
    });
    tbl._theadOrdered = true;
  }
}

// Add drag-and-drop to table header cells
function attachHeaderDrag(table) {
  const tableId = table === 'singles' ? 'singles-table' : table === 'slabs' ? 'slabs-table' : null;
  const tbl = tableId ? document.getElementById(tableId) : document.querySelector('#page-sales table');
  if (!tbl) return;
  // Guard: only attach listeners once per table element to avoid duplicate events on re-navigation
  if (tbl._dragAttached) return;
  tbl._dragAttached = true;
  const headerRow = tbl.querySelector('thead tr:first-child');
  if (!headerRow) return;
  const defMap = {};
  COL_DEFS[table].forEach(c => defMap[c.key] = c);

  Array.from(headerRow.cells).forEach(th => {
    const key = th.dataset.colKey;
    if (!key) return;
    const def = defMap[key];
    if (!def || def.locked) return;
    th.classList.add('col-draggable');
    th.draggable = true;

    th.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', key);
      e.dataTransfer.effectAllowed = 'move';
    });
    th.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      headerRow.querySelectorAll('th').forEach(el => el.classList.remove('col-drag-over'));
      th.classList.add('col-drag-over');
    });
    th.addEventListener('dragleave', () => th.classList.remove('col-drag-over'));
    th.addEventListener('drop', e => {
      e.preventDefault();
      th.classList.remove('col-drag-over');
      const fromKey = e.dataTransfer.getData('text/plain');
      const toKey = key;
      if (fromKey === toKey) return;
      moveColOrder(table, fromKey, toKey);
    });
  });
}

// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  if (!e.target.closest('.col-toggle-wrap')) {
    document.querySelectorAll('.col-toggle-wrap.open').forEach(w => w.classList.remove('open'));
  }
  if (!e.target.closest('.filters-wrap')) {
    document.querySelectorAll('.filters-wrap.open').forEach(w => w.classList.remove('open'));
  }
});

// =========== SMART ADD ===========
let smartAddParsed = [];
let smartAddMode = null; // null | 'slab' | 'single' - biases the modal UI

function openSmartAdd(mode) {
  smartAddMode = (mode === 'slab' || mode === 'single') ? mode : null;
  document.getElementById('smart-add-input').value = '';
  document.getElementById('smart-add-preview').style.display = 'none';
  document.getElementById('smart-add-preview-list').innerHTML = '';
  document.getElementById('smart-add-count').textContent = '';
  document.getElementById('smart-add-save-btn').disabled = true;
  smartAddParsed = [];
  // Customise the modal chrome per mode so users coming from "Add Slab"
  // see slab-leading examples (and the title says "Add Slab"). Falls back
  // to the original generic copy when invoked from the existing "Smart
  // Add" button.
  const titleEl   = document.querySelector('#modal-smart-add h3');
  const helpEl    = document.getElementById('smart-add-help');
  const inputEl   = document.getElementById('smart-add-input');
  if (titleEl) {
    titleEl.textContent = smartAddMode === 'slab'   ? '✦ Add Slab (auto-parse)'
                        : smartAddMode === 'single' ? '✦ Add Single (auto-parse)'
                        : '✦ Smart Add';
  }
  if (helpEl) {
    if (smartAddMode === 'slab') {
      helpEl.innerHTML =
        '<strong style="color:var(--text)">Type or paste one slab per line.</strong> ' +
        'Grader + grade (PSA/TAG/CGC/BGS/ACE) auto-detect from the text.<br>' +
        '<strong style="color:var(--text)">Price = cost.</strong> Every <code style="color:var(--accent)">$X</code> is what you paid; Market &amp; Carousell are edited on the row later.<br>' +
        'Examples:<br>' +
        '<span style="color:var(--text3)">PSA 10 Charizard ex 223 EN #119569490 $850</span><br>' +
        '<span style="color:var(--text3)">TAG 9 Eevee 173 cert L6786028 rank 10th $81</span><br>' +
        '<span style="color:var(--text3)">CGC 9.5 Mew Promo $120</span><br>' +
        'Lines without a grader will be saved as raw singles instead - keep the modal type in mind.';
    } else if (smartAddMode === 'single') {
      helpEl.innerHTML =
        '<strong style="color:var(--text)">Type or paste one single per line.</strong> ' +
        '<strong style="color:var(--text)">Price = cost.</strong> Every <code style="color:var(--accent)">$X</code> is what you paid.<br>' +
        'Examples:<br>' +
        '<span style="color:var(--text3)">Eevee 173 EN NM $9</span><br>' +
        '<span style="color:var(--text3)">Charmander 44 sealed EN $30</span><br>' +
        '<span style="color:var(--text3)">Pikachu V JP NM x3 $15</span>';
    } else {
      // Generic Smart Add (the original help text).
      helpEl.innerHTML =
        '<strong style="color:var(--text)">Type or paste one item per line.</strong> The parser auto-detects slabs, sealed singles, and raw singles.<br>' +
        '<strong style="color:var(--text)">Price = cost.</strong> Every <code style="color:var(--accent)">$X</code> you enter is the cost price (what you paid). Market price and Carousell asking price are set later on the row itself - not at entry time.<br>' +
        'Examples:<br>' +
        '<span style="color:var(--text3)">Eevee 173 EN NM $9</span> → raw single, cost S$9<br>' +
        '<span style="color:var(--text3)">Charmander 44 sealed EN $30</span> → sealed single, cost S$30<br>' +
        '<span style="color:var(--text3)">Eevee 173 TAG 10 cert L6786028 rank 10th $81</span> → slab, cost S$81<br>' +
        '<span style="color:var(--text3)">PSA 9 Bulbasaur 143 #119569490 $77</span> → slab, cost S$77<br>' +
        'Supports: TAG/PSA/CGC grades, EN/JP/CN/ID languages, sealed keyword, qty (e.g. x3), cert numbers (#), ranks (1st/2nd…)';
    }
  }
  if (inputEl) {
    inputEl.placeholder = smartAddMode === 'slab'
      ? 'PSA 10 Charizard ex 223 EN #119569490 $850\nTAG 9 Eevee 173 cert L6786028 rank 10th $81\nCGC 9.5 Mew Promo $120'
      : smartAddMode === 'single'
        ? 'Eevee 173 EN NM $9\nCharmander 44 sealed EN $30\nPikachu V JP NM x3 $15'
        : 'Eevee 173 EN NM $9\nCharmander 44 sealed EN $30\nEevee 173 TAG 10 cert L6786028 rank 10th $81\nPSA 9 Bulbasaur 143 #119569490 $77';
  }
  openModal('modal-smart-add');
  setTimeout(() => inputEl && inputEl.focus(), 100);
}

function parseSmartLine(raw) {
  const line = raw.trim();
  if (!line) return null;

  let s = line;
  const result = { _raw: line, name: '', type: 'raw', language: 'EN', condition: 'NM',
    qty: 1, listPrice: 0, costPrice: '', marketPrice: '', set: '', notes: '',
    status: 'Available', grader: '', grade: '', certNo: '', rank: '', dateListed: '' };

  // ── Detect SLAB ──────────────────────────────────────────────
  // Require grade to be immediately adjacent to the grader (e.g. "PSA 9", "TAG 10")
  // This prevents card numbers like "223" or set codes like "sv9" being matched as grades
  const slabRx = /\b(TAG|PSA|CGC|ACE|BGS)\s+(10|9\.5|9|8\.5|8|7|6|5)\b/i;
  const slabM  = s.match(slabRx);

  if (slabM) {
    result.type   = 'slab';
    result.grader = slabM[1].toUpperCase();
    result.grade  = slabM[2];
    s = s.replace(slabM[0], '').trim();
    // Pristine modifier - TAG / CGC / BGS top-pop subgrade for 10s. PSA
    // does NOT use Pristine (Gem Mint 10 is their top). Detected via the
    // full word "Pristine" or trailing " P". Stored as a "PRISTINE" tag
    // in notes so the badge picks it up via _resolveGrader.
    if (['TAG','CGC','BGS'].includes(result.grader) && result.grade === '10') {
      const pristineRx = /\bpristine\b/i;
      const pBareRx    = /(?:^|\s)P(?=\s|$)/;
      if (pristineRx.test(s) || pBareRx.test(s)) {
        result.notes = ((result.notes||'') + ' PRISTINE').trim();
        s = s.replace(/\bpristine\b/gi, '').replace(/(?:^|\s)P(?=\s|$)/g, ' ').replace(/\s{2,}/g,' ').trim();
      }
    }
  } else {
    // Grader present but no adjacent grade - still flag as slab, grade unknown
    const graderOnlyRx = /\b(TAG|PSA|CGC|ACE|BGS)\b/i;
    const graderOnlyM  = s.match(graderOnlyRx);
    if (graderOnlyM) {
      result.type   = 'slab';
      result.grader = graderOnlyM[1].toUpperCase();
      s = s.replace(graderOnlyRx, '').trim();
    }
  }

  // ── Detect SEALED (singles only) ─────────────────────────────
  if (result.type !== 'slab' && /\bsealed\b/i.test(s)) {
    result.type = 'sealed';
    s = s.replace(/\bsealed\b/gi, '').trim();
  }

  // ── Cert number - three patterns, tried in order ─────────────
  //   (a) "#XXXXXXX" or "cert XXXXXXX"      - explicit
  //   (b) "L1234567" / "P12345678"           - letter-prefixed (CGC, TAG, etc.)
  //   (c) bare 7-10 digit run, slab-only    - PSA cert numbers are bare
  //
  // (c) is gated on slab context (grader detected) AND the digits must NOT
  // be immediately attached to a card-number style prefix (3-digit card no.
  // like "211" never trips this - min length 7). This catches inputs like
  // "Gothitelle 211 142641369 PSA 10" where the cert was silently left in
  // the name. Previously needed a manual edit after every PSA slab entry.
  let certM = s.match(/(?:#|cert\s+)([A-Z0-9]{4,14})/i);
  if (!certM) certM = s.match(/\b([A-Z]\d{6,12})\b/i);
  if (!certM && (result.type === 'slab' || result.grader)) {
    certM = s.match(/\b(\d{7,10})\b/);
  }
  if (certM) { result.certNo = certM[1]; s = s.replace(certM[0], '').trim(); }

  // ── Rank  1st / 2nd / 3rd / Nth ─────────────────────────────
  const rankM = s.match(/\b(\d{1,3}(?:st|nd|rd|th))\b/i);
  if (rankM) { result.rank = rankM[1]; s = s.replace(rankM[0], '').trim(); }

  // ── Language ─────────────────────────────────────────────────
  // Accepts abbreviations (EN, JP, CN...) and full/fuzzy names
  // (English, Japanese, Japan, Korean, Korea, Chinese, etc.).
  // Tried in priority order - longer/more specific patterns first.
  const LANG_FUZZY = [
    ['EN', /\b(EN|english|eng)\b/i],
    ['JP', /\b(JP|japanese|japan|jap|jpn)\b/i],
    ['CN', /\b(CN|chinese|china|zh|chn)\b/i],
    ['KR', /\b(KR|korean|korea|kor)\b/i],
    ['FR', /\b(FR|french|france)\b/i],
    ['DE', /\b(DE|german|germany|deutsch|deu)\b/i],
    ['IT', /\b(IT|italian|italy|ita)\b/i],
    ['ES', /\b(ES|spanish|spain)\b/i],
    ['PT', /\b(PT|portuguese|portugal|por)\b/i],
    ['ID', /\b(ID|indonesian|indonesia)\b/i],
    ['TH', /\b(TH|thai|thailand)\b/i],
    ['PL', /\b(PL|polish|poland)\b/i],
  ];
  let _langMatched = false;
  for (const [code, rx] of LANG_FUZZY) {
    const m = s.match(rx);
    if (m) { result.language = code; s = s.replace(m[0], '').replace(/\s{2,}/g,' ').trim(); _langMatched = true; break; }
  }
  if (!_langMatched) result.language = 'EN'; // default
  // Flag whether a language token was actually present in the text (vs the
  // EN default). Callers use this to avoid pre-filling a dropdown with a
  // default that would then override what the user types.
  result.languageExplicit = _langMatched;

  // ── Condition ────────────────────────────────────────────────
  const condM = s.match(/\b(mint|NM|near\s*mint|LP|lightly\s*played|MP|moderately\s*played|HP|heavily\s*played|damaged)\b/i);
  result.conditionExplicit = !!condM;
  if (condM) {
    const cm = condM[1].toLowerCase();
    result.condition = cm === 'nm' || cm.includes('near') ? 'Near Mint'
      : cm === 'lp' || cm.includes('lightly') ? 'Lightly Played'
      : cm === 'mp' || cm.includes('moderately') ? 'Moderately Played'
      : cm === 'hp' || cm.includes('heavily') ? 'Heavily Played'
      : cm === 'damaged' ? 'Damaged' : 'Mint';
    s = s.replace(condM[0], '').trim();
  }

  // ── Qty  x3 or 3x ────────────────────────────────────────────
  const qtyM = s.match(/\b(\d+)\s*x\b|\bx\s*(\d+)\b/i);
  if (qtyM) { result.qty = parseInt(qtyM[1]||qtyM[2]); s = s.replace(qtyM[0], '').trim(); }

  // ── Price  →  always costPrice ───────────────────────────────
  // Per product spec: every $ amount entered via Quick Entry / Smart Add
  // is the cost price (what the user paid). Carousell asking price and
  // market value are populated manually later via the inline columns on
  // the Singles / Slabs tabs - not at entry time. This avoids the prior
  // bug where bare "$X" was silently routed to listPrice + marketPrice,
  // inflating Total Market Value with the user's asking price.
  //
  // We strip optional "cost"/"paid"/etc. words for backwards compatibility
  // with old paste formats - they map to the same field anyway - and take
  // the FIRST $ amount that appears. Any additional $ amounts are dropped
  // silently (with a note in the parsed result so the preview can flag it).
  const priceTokens = [];
  const priceRx = /(?:cost|paid|bought|buy|list|ask|asking|carousell|market|mkt|worth|price|@)?\s*\$\s*([\d.]+)/gi;
  let pm;
  while ((pm = priceRx.exec(s)) !== null) {
    priceTokens.push({ value: parseFloat(pm[1]), full: pm[0] });
  }
  if (priceTokens.length) {
    result.costPrice = priceTokens[0].value;
    if (priceTokens.length > 1) {
      result._extraPrices = priceTokens.slice(1).map(t => t.value);
    }
    // Remove every matched $ token from the leftover so the name parser
    // doesn't pick up "$108" as part of the card name.
    priceTokens.forEach(t => { s = s.replace(t.full, ''); });
    s = s.replace(/\s{2,}/g, ' ').trim();
  }

  // ── Set code  sv3 / s12a / swsh / xy etc ─────────────────────
  const setM = s.match(/\b(sv\d+[a-z]?|s\d+[a-z]?|swsh\d*|xy\d*|sm\d*|bw\d*|dp\d*|promo)\b/i);
  if (setM) { result.set = setM[1]; s = s.replace(setM[0], '').trim(); }

  // ── Clean up leftover punctuation ────────────────────────────
  s = s.replace(/\s{2,}/g, ' ').replace(/^[\s\-–,]+|[\s\-–,]+$/g, '').trim();

  result.name = s || '(unnamed)';
  if (!result.name || result.name === '(unnamed)') result._error = 'Could not parse name';

  return result;
}

function previewSmartAdd() {
  const lines = document.getElementById('smart-add-input').value.split('\n');
  smartAddParsed = lines.map(parseSmartLine).filter(Boolean);

  const listEl = document.getElementById('smart-add-preview-list');
  const previewEl = document.getElementById('smart-add-preview');
  const countEl = document.getElementById('smart-add-count');
  const saveBtn = document.getElementById('smart-add-save-btn');

  if (smartAddParsed.length === 0) {
    previewEl.style.display = 'none';
    countEl.textContent = '';
    saveBtn.disabled = true;
    return;
  }

  previewEl.style.display = 'block';
  const valid = smartAddParsed.filter(p => !p._error);
  countEl.textContent = valid.length + ' item' + (valid.length !== 1 ? 's' : '') + ' ready to save';
  saveBtn.disabled = valid.length === 0;

  listEl.innerHTML = smartAddParsed.map((p, idx) => {
    if (p._error) {
      return '<div class="sa-item sa-error">' +
        '<span class="sa-badge sa-badge-error">ERR</span>' +
        '<div><div class="sa-name">' + esc(p._raw) + '</div>' +
        '<div class="sa-meta" style="color:var(--red)">' + esc(p._error) + '</div></div></div>';
    }
    const typeLabel = p.type === 'slab' ? 'SLAB' : p.type === 'sealed' ? 'SEALED' : 'RAW';
    const typeCls   = p.type === 'slab' ? 'slab' : p.type === 'sealed' ? 'sealed' : 'raw';
    let meta = [];
    if (p.type === 'slab') {
      meta.push(p.grader + ' ' + p.grade);
      if (p.certNo) meta.push('Cert: ' + p.certNo);
      if (p.rank)   meta.push('Rank: ' + p.rank);
    }
    meta.push(p.language);
    if (p.type !== 'slab') meta.push(p.condition);
    if (p.qty > 1) meta.push('Qty: ' + p.qty);
    if (p.set) meta.push('Set: ' + p.set);
    // Cost only - that's the entry-time field. Market & Carousell are
    // set later via the inline column editors on the Singles/Slabs tabs.
    if (p.costPrice !== '' && p.costPrice !== undefined) meta.push('<strong style="color:var(--text)">Cost: S$' + p.costPrice + '</strong>');
    // Heads-up if the user accidentally typed two $ amounts on one line.
    if (p._extraPrices && p._extraPrices.length) {
      meta.push('<span style="color:#f59e0b">⚠ ignored extra: ' + p._extraPrices.map(v => '$'+v).join(', ') + '</span>');
    }
    return '<div class="sa-item sa-' + typeCls + '">' +
      '<span class="sa-badge sa-badge-' + typeCls + '">' + typeLabel + '</span>' +
      '<div style="flex:1"><div class="sa-name">' + esc(p.name) + '</div>' +
      '<div class="sa-meta">' + meta.join(' · ') + '</div></div>' +
      '<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px;color:var(--text3)" onclick="removeSmartItem(' + idx + ')" title="Remove">✕</button>' +
      '</div>';
  }).join('');
}

function removeSmartItem(idx) {
  smartAddParsed.splice(idx, 1);
  // rebuild textarea to match
  document.getElementById('smart-add-input').value = smartAddParsed.map(p => p._raw).join('\n');
  previewSmartAdd();
}

function saveSmartAdd() {
  let addedSingles = 0, addedSlabs = 0;
  // Capture each newly-added row so we can log a one-line summary per row
  // instead of a single "N cards via Smart Add" entry. Per-row entries
  // make it possible to trace exactly what each item looked like at add
  // time when auditing the changelog months later.
  const addedSingleRecords = [];
  const addedSlabRecords   = [];
  snapshotForUndo();
  smartAddParsed.filter(p => !p._error).forEach(p => {
    if (p.type === 'slab') {
      const item = {
        id: genId('sl'), name: p.name, type: 'slab',
        grader: p.grader, grade: p.grade, certNo: p.certNo, rank: p.rank,
        listPrice: p.listPrice, costPrice: p.costPrice, marketPrice: p.marketPrice,
        dateListed: p.dateListed, status: p.status, notes: p.notes, priceHistory: []
      };
      DB.slabs.push(item);
      markDirty('slabs', item.id);
      if (typeof _pinRecentlyAdded === 'function') _pinRecentlyAdded('slabs', item.id);
      addedSlabs++;
      addedSlabRecords.push(item);
    } else {
      const qty = Math.max(1, parseInt(p.qty)||1);
      for (let q = 0; q < qty; q++) {
        const item = {
          id: genId('s'), name: p.name, set: p.set, language: p.language,
          type: p.type === 'sealed' ? 'sealed' : 'raw',
          condition: p.condition, qty: 1,
          listPrice: p.listPrice, costPrice: p.costPrice, marketPrice: p.marketPrice,
          status: p.status, notes: p.notes, priceHistory: []
        };
        DB.singles.push(item);
        markDirty('singles', item.id);
        if (typeof _pinRecentlyAdded === 'function') _pinRecentlyAdded('singles', item.id);
        addedSingles++;
        addedSingleRecords.push(item);
      }
    }
  });
  saveData();
  closeModal('modal-smart-add', true); // force: data is already saved, skip the unsaved-changes prompt
  renderSingles();
  renderSlabs();
  const parts = [];
  if (addedSingles) parts.push(addedSingles + ' single' + (addedSingles !== 1 ? 's' : ''));
  if (addedSlabs)   parts.push(addedSlabs + ' slab' + (addedSlabs !== 1 ? 's' : ''));
  toast('Added ' + parts.join(' + ') + '!');
  // Emit one changelog row per added record so each item is independently
  // auditable. Add a "batch" summary line at the end so the changelog also
  // shows the overall count.
  const batchTag = ' · via Smart Add';
  addedSingleRecords.forEach(rec => clLog('add', 'singles', rec.name, _clSummary('singles', rec) + batchTag));
  addedSlabRecords  .forEach(rec => clLog('add', 'slabs',   rec.name, _clSummary('slabs',   rec) + batchTag));
  if (addedSingles + addedSlabs > 1) {
    clLog('add', '', 'Smart Add batch', addedSingles + ' single(s) + ' + addedSlabs + ' slab(s) in one batch');
  }
}

// =========== COMMAND BAR ===========
let cmdMode = 'add';
let cmdSellCart = [];        // [{ id, _table, name, grader, grade, certNo, type, costPrice, availQty, qty, price }]
let cmdAddResultIdx = -1;
let cmdSellResultIdx = -1;
let cmdSellResults = [];

function openCmdBar(mode) {
  cmdMode = mode || 'add';
  setCmdMode(cmdMode);
  kjrModalCtrl.open(document.getElementById('cmd-overlay'));
  setTimeout(() => {
    const inp = cmdMode === 'sell' ? document.getElementById('cmd-sell-search') : document.getElementById('cmd-add-input');
    inp.focus();
  }, 50);
}

function closeCmdBar() {
  kjrModalCtrl.close(document.getElementById('cmd-overlay'));
  document.getElementById('cmd-add-input').value = '';
  document.getElementById('cmd-sell-search').value = '';
  document.getElementById('cmd-add-preview').innerHTML = '';
  document.getElementById('cmd-sell-preview').innerHTML = '';
  document.getElementById('cmd-sell-form').style.display = 'none';
  document.getElementById('cmd-sell-preview').style.display = '';
  cmdSellCart = [];
  cmdAddResultIdx = -1;
  cmdSellResultIdx = -1;
}

document.addEventListener('keydown', function(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'k') { e.preventDefault(); openCmdBar(); }
});

function setCmdMode(mode) {
  cmdMode = mode;
  document.getElementById('cmd-tab-add').classList.toggle('active', mode === 'add');
  document.getElementById('cmd-tab-sell').classList.toggle('active', mode === 'sell');
  document.getElementById('cmd-add-panel').style.display = mode === 'add' ? '' : 'none';
  document.getElementById('cmd-sell-panel').style.display = mode === 'sell' ? '' : 'none';
  document.getElementById('cmd-sell-form').style.display = 'none';
  document.getElementById('cmd-sell-preview').style.display = '';
  cmdSellCart = [];
  setTimeout(() => {
    const inp = mode === 'sell' ? document.getElementById('cmd-sell-search') : document.getElementById('cmd-add-input');
    inp.focus();
  }, 30);
}

// ── ADD MODE ──────────────────────────────────────────────────
function cmdAddPreview() {
  const val = document.getElementById('cmd-add-input').value.trim();
  const el = document.getElementById('cmd-add-preview');
  if (!val) { el.innerHTML = ''; return; }
  const parsed = parseSmartLine(val);
  if (!parsed || parsed._error) {
    el.innerHTML = '<div class="cmd-empty">Could not parse - try: <em>Charizard ex 223 EN $108 cost $80</em></div>';
    return;
  }
  const typeLabel = parsed.type === 'slab' ? 'SLAB' : parsed.type === 'sealed' ? 'SEALED' : 'RAW';
  const typeCls   = parsed.type === 'slab' ? 'b-slab' : parsed.type === 'sealed' ? 'b-sealed' : 'b-raw';
  let meta = [];
  if (parsed.type === 'slab') {
    meta.push(parsed.grader + ' ' + parsed.grade);
    if (parsed.certNo) meta.push('#' + parsed.certNo);
    if (parsed.rank) meta.push(parsed.rank);
  } else {
    meta.push(parsed.language, parsed.condition);
    if (parsed.qty > 1) meta.push('Qty ' + parsed.qty);
  }
  if (parsed.listPrice) meta.push('S$' + parsed.listPrice);
  if (parsed.costPrice !== '') meta.push('Cost S$' + parsed.costPrice);
  el.innerHTML =
    '<div class="cmd-section-label">Will be added to ' + (parsed.type === 'slab' ? 'Slabs' : 'Singles') + '</div>' +
    '<div class="cmd-result selected">' +
      '<div class="cmd-result-icon" style="background:var(--bg3)">📋</div>' +
      '<div class="cmd-result-main">' +
        '<div class="cmd-result-name">' + esc(parsed.name) + '</div>' +
        '<div class="cmd-result-meta">' + esc(meta.join(' · ')) + '</div>' +
      '</div>' +
      '<span class="cmd-result-badge badge ' + typeCls + '">' + typeLabel + '</span>' +
    '</div>' +
    '<div class="cmd-hint" style="border-top:none;padding-top:4px"><span style="color:var(--accent)">↵ Enter to save</span></div>';
}

function cmdAddKey(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const val = document.getElementById('cmd-add-input').value.trim();
    if (!val) return;
    const parsed = parseSmartLine(val);
    if (!parsed || parsed._error) { toast('Could not parse - check format'); return; }
    snapshotForUndo();
    if (parsed.type === 'slab') {
      const newId = genId('sl');
      const slabItem = { id: newId, name: parsed.name, type: 'slab',
        grader: parsed.grader, grade: parsed.grade, certNo: parsed.certNo, rank: parsed.rank,
        listPrice: parsed.listPrice, costPrice: parsed.costPrice, marketPrice: parsed.marketPrice,
        dateListed: parsed.dateListed, status: 'Available', notes: parsed.notes, priceHistory: [] };
      DB.slabs.push(slabItem);
      markDirty('slabs', newId);
      if (typeof _pinRecentlyAdded === 'function') _pinRecentlyAdded('slabs', newId);
      saveData(); renderSlabs();
      clLog('add', 'slabs', parsed.name, _clSummary('slabs', slabItem) + ' · via Quick Entry');
      toast('Slab added: ' + parsed.name);
    } else {
      const qty = Math.max(1, parseInt(parsed.qty)||1);
      const addedIds = [];
      for (let q = 0; q < qty; q++) {
        const newId = genId('s');
        const singleItem = { id: newId, name: parsed.name, set: parsed.set, language: parsed.language,
          type: parsed.type === 'sealed' ? 'sealed' : 'raw', condition: parsed.condition, qty: 1,
          listPrice: parsed.listPrice, costPrice: parsed.costPrice, marketPrice: parsed.marketPrice,
          status: 'Available', notes: parsed.notes, priceHistory: [] };
        DB.singles.push(singleItem);
        markDirty('singles', newId);
        if (typeof _pinRecentlyAdded === 'function') _pinRecentlyAdded('singles', newId);
        addedIds.push(newId);
      }
      // Log against a representative item - qty=N rows share the same
      // fields, so one summary suffices; we tag the count for traceability.
      const representativeSingle = DB.singles.find(i => i.id === addedIds[0]);
      saveData(); renderSingles();
      clLog('add', 'singles', parsed.name,
        _clSummary('singles', representativeSingle) +
        (qty > 1 ? ' · ×' + qty + ' rows (ids: ' + addedIds.slice(0,3).join(', ') + (qty > 3 ? '…' : '') + ')' : '') +
        ' · via Quick Entry');
      toast('Single added' + (qty > 1 ? ' ×' + qty + ' rows' : '') + ': ' + parsed.name);
    }
    document.getElementById('cmd-add-input').value = '';
    document.getElementById('cmd-add-preview').innerHTML = '';
    document.getElementById('cmd-add-input').focus();
  }
}

// ── SELL MODE ─────────────────────────────────────────────────
// Search is token-aware: every whitespace-separated chunk in the query
// has to match SOMETHING on the row. That way slab-style queries like
//   "PSA 10 Eevee"   /   "TAG 9 Charizard"   /   "Eevee TAG 10"
// match the slab even though the literal string isn't in `i.name` (the
// grader + grade live in their own fields). Previously only `name`
// and `certNo` were searched, so any query that included the grader
// or grade as words returned zero results and the user concluded the
// sell flow ignored slabs.
function cmdSellSearch() {
  const raw = document.getElementById('cmd-sell-search').value.toLowerCase().trim();
  const el = document.getElementById('cmd-sell-preview');
  if (!raw) { el.innerHTML = cmdSellCart.length ? '' : '<div class="cmd-empty">Type to search your inventory...</div>'; cmdSellResults = []; return; }
  const tokens = raw.split(/\s+/).filter(Boolean);

  // Build a single haystack string per row that includes every field a
  // user might search on. Cheap, predictable, and matches the rest of
  // the app's "universal search" behaviour.
  const haystackSingle = i => [i.name, i.set, i.language, i.condition, i.type, i.notes]
                                .filter(Boolean).join(' ').toLowerCase();
  const haystackSlab   = i => [i.name, i.set, i.grader, i.grade, i.certNo,
                                (i.grader && i.grade ? i.grader + ' ' + i.grade : ''),
                                (i.grader && i.grade ? i.grader + i.grade : ''),  // "psa10"
                                i.rank, i.notes]
                                .filter(Boolean).join(' ').toLowerCase();
  const allMatch = (hay) => tokens.every(t => hay.includes(t));

  const singles = DB.singles.filter(i => (i.status||'Available') !== 'Sold' && allMatch(haystackSingle(i)));
  const slabs   = DB.slabs  .filter(i => (i.status||'Available') !== 'Sold' && allMatch(haystackSlab(i)));
  const haystackSealed = i => [i.product, i.notes, i.status].filter(Boolean).join(' ').toLowerCase();
  const etbs    = (DB.etbs||[])         .filter(i => kjrIsActiveStatus('etbs', i.status)         && allMatch(haystackSealed(i)));
  const bbs     = (DB.boosterBoxes||[]) .filter(i => kjrIsActiveStatus('boosterBoxes', i.status) && allMatch(haystackSealed(i)));
  const bps     = (DB.boosterPacks||[]) .filter(i => kjrIsActiveStatus('boosterPacks', i.status) && allMatch(haystackSealed(i)));

  cmdSellResults = [
    ...slabs  .map(i => ({ ...i, _table: 'slabs' })),    // slabs first - usually highest value
    ...singles.map(i => ({ ...i, _table: 'singles' })),
    ...etbs   .map(i => ({ ...i, _table: 'etbs' })),
    ...bbs    .map(i => ({ ...i, _table: 'boosterBoxes' })),
    ...bps    .map(i => ({ ...i, _table: 'boosterPacks' })),
  ].slice(0, 15);

  if (cmdSellResults.length === 0) {
    el.innerHTML = '<div class="cmd-empty">No available inventory matches "' + esc(raw) + '"</div>';
    return;
  }

  cmdSellResultIdx = 0;
  renderCmdSellResults();
}

function renderCmdSellResults() {
  const el = document.getElementById('cmd-sell-preview');
  el.innerHTML = '<div class="cmd-section-label">Available Inventory</div>' +
    cmdSellResults.map((i, idx) => {
      const isSlab   = i._table === 'slabs';
      const isSealed = ['etbs','boosterBoxes','boosterPacks'].includes(i._table);
      const badge = isSlab
        ? graderGradeBadge(i.grader, i.grade, i.notes)
        : isSealed
          ? '<span class="badge b-sealed">Sealed</span>'
          : (i.type === 'sealed' ? '<span class="badge b-sealed">Sealed</span>' : '<span class="badge b-raw">Raw</span>');
      const meta = isSlab
        ? [(i.certNo ? '#' + i.certNo : ''), (i.rank||''), 'Cost: ' + (i.costPrice ? 'S$'+i.costPrice : '-')].filter(Boolean).join(' · ')
        : isSealed
          ? (i._table === 'boosterPacks'
              ? ['Qty: '+(i.qty||1)+' packs', 'Cost: S$'+(i.unitPrice||'-')+'/pack'].join(' · ')
              : ['Status: '+(i.status||''), 'Cost: S$'+(i.totalPrice||'-')].join(' · '))
          : [(i.language||''), (i.condition||''), 'Qty: '+(i.qty||1), 'Cost: '+(i.costPrice ? 'S$'+i.costPrice : '-')].join(' · ');
      // Show how many units are already staged. Singles match by group (any
      // copy of the same card), slabs and sealed items by their unique row id.
      const line = isSlab
        ? cmdSellCart.find(l => l._table === 'slabs' && l.id === i.id)
        : isSealed
          ? cmdSellCart.find(l => l._table === i._table && l.id === i.id)
          : cmdSellCart.find(l => l._table === 'singles' && l.groupKey === cmdSingleGroupKey(i));
      const inCart = line ? '<span class="cmd-result-incart">✓ ' + line.qty + ' in sale</span>' : '';
      const icon = isSlab ? '🏆' : isSealed ? '📦' : '🃏';
      return '<div class="cmd-result' + (idx === cmdSellResultIdx ? ' selected' : '') + '" onclick="cmdSellAddToCart(' + idx + ')">' +
        '<div class="cmd-result-icon" style="background:var(--bg3)">' + icon + '</div>' +
        '<div class="cmd-result-main">' +
          '<div class="cmd-result-name">' + esc(i.product || i.name || '-') + '</div>' +
          '<div class="cmd-result-meta">' + esc(meta) + '</div>' +
        '</div>' + inCart + badge +
      '</div>';
    }).join('');
}

function cmdSellKey(e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); cmdSellResultIdx = Math.min(cmdSellResultIdx + 1, cmdSellResults.length - 1); renderCmdSellResults(); }
  if (e.key === 'ArrowUp')   { e.preventDefault(); cmdSellResultIdx = Math.max(cmdSellResultIdx - 1, 0); renderCmdSellResults(); }
  if (e.key === 'Enter' && cmdSellResults.length > 0) { e.preventDefault(); cmdSellAddToCart(cmdSellResultIdx); }
}

// ── MULTI-ITEM SALE CART ──────────────────────────────────────
// A single card is usually stored as many separate inventory rows (one per
// purchase lot, each Qty 1, each a slightly different cost). For selling we
// treat functionally-identical available copies as ONE cart line so the qty
// stepper can climb to the full owned count. Slabs stay one row each (unique).
//
// `cmdSingleGroupKey` defines "functionally identical": same name, set,
// language, condition and type. Cost and purchase date are deliberately NOT
// part of the key - those are the things that differ across lots.
function cmdSingleGroupKey(i) {
  return [i.name||'', i.set||'', i.language||'', i.condition||'', i.type||'']
    .join('¦').toLowerCase().trim();
}

// Cost basis for selling `n` units from a grouped line. Consumes the most
// expensive lots first (the agreed allocation rule), so each sale reports the
// most conservative profit and the cheaper stock stays on the books.
function cmdLineCost(line, n) {
  const want = (n == null) ? line.qty : n;
  if (line._table === 'slabs' || !Array.isArray(line.lots)) {
    return (line.costPrice || 0) * want;
  }
  const units = [];
  line.lots.forEach(lot => { for (let u = 0; u < lot.availUnits; u++) units.push(lot.costPrice); });
  units.sort((a, b) => b - a);
  return units.slice(0, want).reduce((s, c) => s + c, 0);
}

// Add the inventory the user picked from search. Slabs add as a single unique
// row. Singles add (or bump) a grouped line covering every matching available
// lot, with the qty stepper capped at the total owned count.
function cmdSellAddToCart(idx) {
  const picked = cmdSellResults[idx];
  if (!picked) return;
  const isSlab = picked._table === 'slabs';

  if (isSlab) {
    const existing = cmdSellCart.find(l => l._table === 'slabs' && l.id === picked.id);
    if (existing) {
      toast('That slab is already in the sale');
    } else {
      cmdSellCart.push({
        id: picked.id, _table: 'slabs', name: picked.name || '',
        grader: picked.grader || '', grade: picked.grade || '', certNo: picked.certNo || '',
        notes: picked.notes || '',
        type: picked.type || '', costPrice: parseFloat(picked.costPrice) || 0,
        availQty: 1, qty: 1,
        // Default to YOUR asking (list) price so a one-tap confirm sells at the
        // price you set. If none is set, leave it blank (empty string) rather
        // than auto-filling a stale market estimate that fakes a huge loss.
        price: parseFloat(picked.listPrice) > 0 ? parseFloat(picked.listPrice) : ''
      });
    }
  } else if (picked._table === 'etbs' || picked._table === 'boosterBoxes') {
    const existing = cmdSellCart.find(l => l._table === picked._table && l.id === picked.id);
    if (existing) {
      toast('That item is already in the sale');
    } else {
      cmdSellCart.push({
        id: picked.id, _table: picked._table, name: picked.product || '',
        costPrice: parseFloat(picked.totalPrice) || 0,
        availQty: 1, qty: 1,
        price: parseFloat(picked.carousellPrice) > 0 ? parseFloat(picked.carousellPrice) : ''
      });
    }
  } else if (picked._table === 'boosterPacks') {
    const existing = cmdSellCart.find(l => l._table === 'boosterPacks' && l.id === picked.id);
    const availQty = Math.max(1, parseInt(picked.qty) || 1);
    if (existing) {
      existing.availQty = availQty;
      if (existing.qty >= availQty) { toast('Only ' + availQty + ' packs available'); return; }
      existing.qty += 1;
    } else {
      cmdSellCart.push({
        id: picked.id, _table: 'boosterPacks', name: picked.product || '',
        costPrice: parseFloat(picked.unitPrice) || 0,
        availQty, qty: 1,
        price: ''
      });
    }
  } else {
    const key = cmdSingleGroupKey(picked);
    const lots = DB.singles
      .filter(i => (i.status||'Available') !== 'Sold' && cmdSingleGroupKey(i) === key)
      .map(i => ({ id: i.id, costPrice: parseFloat(i.costPrice) || 0, availUnits: Math.max(1, parseInt(i.qty) || 1) }))
      .sort((a, b) => b.costPrice - a.costPrice);
    const availQty = lots.reduce((s, l) => s + l.availUnits, 0);
    const existing = cmdSellCart.find(l => l._table === 'singles' && l.groupKey === key);
    if (existing) {
      existing.lots = lots; existing.availQty = availQty;  // refresh in case inventory shifted
      if (existing.qty >= availQty) { toast('Only ' + availQty + ' available for that card'); return; }
      existing.qty += 1;
    } else {
      cmdSellCart.push({
        id: picked.id, _table: 'singles', groupKey: key, lots,
        name: picked.name || '', type: picked.type || '',
        costPrice: lots.length ? lots[0].costPrice : (parseFloat(picked.costPrice) || 0),
        availQty, qty: 1,
        price: parseFloat(picked.listPrice) > 0 ? parseFloat(picked.listPrice) : ''
      });
    }
  }
  // First item opens the form and seeds shared fields.
  const form = document.getElementById('cmd-sell-form');
  if (form.style.display === 'none' || !document.getElementById('cmd-sell-date').value) {
    form.style.display = '';
    document.getElementById('cmd-sell-date').value = new Date().toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'});
    if (cmdSellCart.length === 1) {
      document.getElementById('cmd-sell-buyer').value = '';
      document.getElementById('cmd-sell-ship').value = '';
      document.getElementById('cmd-sell-fees').value = '';
      document.getElementById('cmd-sell-channel').value = 'Carousell';
    }
  }
  renderCmdSellCart();
  renderCmdSellResults();
  // Keep the search box ready for the next item.
  const search = document.getElementById('cmd-sell-search');
  search.value = '';
  document.getElementById('cmd-sell-preview').innerHTML = '';
  cmdSellResults = [];
  setTimeout(() => search.focus(), 30);
}

function cmdSellSetQty(id, delta) {
  const line = cmdSellCart.find(l => l.id === id);
  if (!line) return;
  line.qty = Math.min(line.availQty, Math.max(1, line.qty + delta));
  renderCmdSellCart();
}

function cmdSellSetPrice(id, val) {
  const line = cmdSellCart.find(l => l.id === id);
  if (!line) return;
  // Keep blank distinct from an explicit 0 (a real giveaway/trade disposal) -
  // parseFloat(val) || 0 used to collapse both to the same value, which is
  // what let cmdConfirmSell wave through a cart with no price entered at all.
  const trimmed = (val == null) ? '' : String(val).trim();
  line.price = trimmed === '' ? '' : (parseFloat(trimmed) || 0);
  // Recompute totals only - don't rebuild the list (would drop input focus).
  cmdCalcProfit();
}

function cmdSellRemove(id) {
  cmdSellCart = cmdSellCart.filter(l => l.id !== id);
  if (cmdSellCart.length === 0) {
    cmdSellClearCart();
    return;
  }
  renderCmdSellCart();
  renderCmdSellResults();
}

function cmdSellClearCart() {
  cmdSellCart = [];
  document.getElementById('cmd-sell-form').style.display = 'none';
  document.getElementById('cmd-sell-preview').style.display = '';
  document.getElementById('cmd-sell-preview').innerHTML = '<div class="cmd-empty">Type to search your inventory...</div>';
  cmdSellResults = [];
  document.getElementById('cmd-sell-search').value = '';
  document.getElementById('cmd-sell-search').focus();
}

function renderCmdSellCart() {
  const list = document.getElementById('cmd-sell-cart-list');
  const countEl = document.getElementById('cmd-sell-cart-count');
  list.className = 'sell-cart-list';
  if (cmdSellCart.length === 0) {
    list.innerHTML = '<div class="sell-cart-empty">No items yet - search above to add.</div>';
    countEl.textContent = '';
  } else {
    const units = cmdSellCart.reduce((s, l) => s + l.qty, 0);
    countEl.textContent = '(' + units + ' unit' + (units === 1 ? '' : 's') + ')';
    list.innerHTML = cmdSellCart.map(l => {
      const isSlab   = l._table === 'slabs';
      const isSealed = ['etbs','boosterBoxes','boosterPacks'].includes(l._table);
      const badge = isSlab
        ? (typeof graderGradeBadge === 'function' ? graderGradeBadge(l.grader, l.grade, '') : '')
        : isSealed
          ? '<span class="badge b-sealed">Sealed</span>'
          : (l.type === 'sealed' ? '<span class="badge b-sealed">Sealed</span>' : '<span class="badge b-raw">Raw</span>');
      const isFixedQty = isSlab || l._table === 'etbs' || l._table === 'boosterBoxes';
      const qtyCtrl = isFixedQty
        ? '<span class="sell-cart-qty-fixed" title="Unique unit - one in sale">×1</span>'
        : '<div class="sell-qty">' +
            '<button onclick="cmdSellSetQty(\'' + l.id + '\',-1)"' + (l.qty <= 1 ? ' disabled' : '') + '>−</button>' +
            '<span>' + l.qty + '</span>' +
            '<button onclick="cmdSellSetQty(\'' + l.id + '\',1)"' + (l.qty >= l.availQty ? ' disabled' : '') + '>+</button>' +
          '</div>';
      const availNote = (!isSlab && l.availQty > 1) ? ' · ' + l.availQty + ' avail' : '';
      // Grouped multi-unit lines blend several lot costs, so show the total
      // allocated cost and the average per unit. Single units keep the /ea form.
      let costLabel;
      if (!isSlab && l.qty > 1) {
        const lineCost = cmdLineCost(l);
        costLabel = 'Cost S$' + lineCost.toFixed(0) + ' (avg S$' + (lineCost / l.qty).toFixed(2) + '/ea)';
      } else {
        costLabel = 'Cost S$' + cmdLineCost(l, 1).toFixed(0) + '/ea';
      }
      const priceVal = (l.price === '' || l.price === null || l.price === undefined) ? '' : l.price;
      return '<div class="sell-cart-line">' +
        '<div class="sell-cart-top">' +
          '<div class="sell-cart-name">' + esc(l.name || '-') + badge + '</div>' +
          '<button class="sell-cart-remove" onclick="cmdSellRemove(\'' + l.id + '\')" title="Remove from sale">✕</button>' +
        '</div>' +
        '<div class="sell-cart-bottom">' +
          '<span class="sell-cart-meta">' + costLabel + availNote + '</span>' +
          '<div class="sell-cart-controls">' +
            qtyCtrl +
            '<label class="sell-cart-price-field" title="What this item actually sold for, per item">' +
              '<span class="sell-cart-price-lbl">Sold</span>' +
              '<span class="sell-cart-price-cur">S$</span>' +
              '<input class="sell-cart-price" type="number" step="0.01" min="0" inputmode="decimal" value="' + priceVal + '" ' +
                'placeholder="0" aria-label="Sold price per item in S$" oninput="cmdSellSetPrice(\'' + l.id + '\',this.value)">' +
            '</label>' +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
  }
  cmdCalcProfit();
}

function cmdCalcProfit() {
  const ship = kjrNum(document.getElementById('cmd-sell-ship').value);
  const fees = kjrNum(document.getElementById('cmd-sell-fees').value);
  let totalCost = 0, totalRev = 0, units = 0;
  cmdSellCart.forEach(l => {
    totalCost += cmdLineCost(l);
    totalRev  += (l.price || 0) * l.qty;
    units     += l.qty;
  });
  const el = document.getElementById('cmd-sell-profit-preview');
  if (units === 0) { el.innerHTML = 'Add items to see totals'; return; }
  const profit = totalRev - totalCost - ship - fees;
  const margin = totalRev > 0 ? ((profit / totalRev) * 100).toFixed(0) + '%' : '-';
  const cls = profit >= 0 ? 'color:var(--green)' : 'color:var(--red)';
  el.innerHTML =
    '<span>Items: <strong>' + units + '</strong></span>' +
    '<span>Cost: <strong>S$' + totalCost.toFixed(0) + '</strong></span>' +
    '<span>Revenue: <strong>S$' + totalRev.toFixed(0) + '</strong></span>' +
    '<span>Shipping: <strong>S$' + ship.toFixed(0) + '</strong></span>' +
    (fees > 0 ? '<span>Fees: <strong>S$' + fees.toFixed(0) + '</strong></span>' : '') +
    '<span>Profit: <strong style="' + cls + '">' + (profit >= 0 ? '+' : '') + 'S$' + profit.toFixed(0) + '</strong></span>' +
    '<span>Margin: <strong>' + margin + '</strong></span>';
}

function cmdConfirmSell() {
  if (cmdSellCart.length === 0) { toast('Add at least one item to the sale'); return; }

  // A blank price entry stays blocked (still l.price === '' from add-to-cart
  // or cmdSellSetPrice), but an explicitly entered 0 is a real disposal
  // (giveaway/trade) and must be allowed through, even for the whole cart.
  if (cmdSellCart.some(l => l.price === '' || l.price === null || l.price === undefined)) {
    toast('Enter a sold price for the items'); return;
  }

  // Resolve every cart line into a flat list of per-unit sales, reading CURRENT
  // inventory so a row that changed under us can't cause a half-applied sale.
  // Grouped singles allocate their units across matching lots most-expensive-
  // first (the agreed cost-basis rule); slabs are one unique unit each.
  const planned = [];   // { name, productName, table, rowId, cost, price }
  for (const l of cmdSellCart) {
    if (l._table === 'slabs') {
      const row = DB.slabs.find(i => i.id === l.id && (i.status||'Available') !== 'Sold');
      if (!row) continue;
      const rg = (typeof _resolveGrader === 'function') ? _resolveGrader(l.grader, l.grade, l.notes) : null;
      const gradeLabel = (rg && rg.grader)
        ? (rg.grader + ' ' + rg.grade).trim()
        : [l.grader, l.grade].filter(Boolean).join(' ').trim();
      const productName = l.name + (gradeLabel ? ' ' + gradeLabel : '') + (l.certNo ? ' #' + l.certNo : '');
      const dateAcqSlab = toDateMmmYyyy(row.datePurchased || row.dateListed || row.date || '') || '';
      planned.push({ name: l.name, productName, table: 'slabs', rowId: row.id, cost: parseFloat(row.costPrice) || 0, price: l.price || 0, dateAcquired: dateAcqSlab });
    } else if (l._table === 'etbs' || l._table === 'boosterBoxes') {
      const row = DB[l._table].find(i => i.id === l.id && kjrIsActiveStatus(l._table, i.status||''));
      if (!row) continue;
      const dateAcqSealed = toDateMmmYyyy(row.date || '') || '';
      planned.push({ name: l.name, productName: l.name, table: l._table, rowId: row.id, cost: parseFloat(row.totalPrice) || 0, price: l.price || 0, dateAcquired: dateAcqSealed });
    } else if (l._table === 'boosterPacks') {
      const row = DB.boosterPacks.find(i => i.id === l.id && kjrIsActiveStatus('boosterPacks', i.status||''));
      if (!row) continue;
      const unitCost = parseFloat(row.unitPrice) || 0;
      const available = Math.max(1, parseInt(row.qty) || 1);
      const take = Math.min(l.qty, available);
      const dateAcqBp = toDateMmmYyyy(row.date || '') || '';
      for (let u = 0; u < take; u++) {
        planned.push({ name: l.name, productName: l.name, table: 'boosterPacks', rowId: row.id, cost: unitCost, price: l.price || 0, dateAcquired: dateAcqBp });
      }
    } else {
      const key = l.groupKey;
      const units = [];
      DB.singles
        .filter(i => (i.status||'Available') !== 'Sold' && cmdSingleGroupKey(i) === key)
        .forEach(i => {
          const c = parseFloat(i.costPrice) || 0;
          const n = Math.max(1, parseInt(i.qty) || 1);
          const da = toDateMmmYyyy(i.datePurchased || '') || '';
          for (let u = 0; u < n; u++) units.push({ id: i.id, cost: c, dateAcquired: da });
        });
      units.sort((a, b) => b.cost - a.cost);
      const take = Math.min(l.qty, units.length);
      for (let u = 0; u < take; u++) {
        planned.push({ name: l.name, productName: l.name, table: 'singles', rowId: units[u].id, cost: units[u].cost, price: l.price || 0, dateAcquired: units[u].dateAcquired });
      }
    }
  }
  if (planned.length === 0) { toast('Those items are no longer available'); return; }

  const ship    = kjrNum(document.getElementById('cmd-sell-ship').value);
  const fees    = kjrNum(document.getElementById('cmd-sell-fees').value);
  const channel = document.getElementById('cmd-sell-channel').value || 'Carousell';
  const buyer   = document.getElementById('cmd-sell-buyer').value;
  const dateSold = formatDateInput(document.getElementById('cmd-sell-date').value);

  // Total revenue drives the pro-rata shipping split across every unit.
  const totalUnits = planned.length;
  let totalRev = 0;
  planned.forEach(p => { totalRev += p.price; });
  // Blank entries are already blocked above, so an all-zero cart (explicit
  // S$0 disposals) is a legitimate sale here - only negative revenue blocks.
  if (totalRev < 0) { toast('Enter a sold price for the items'); return; }

  snapshotForUndo();

  const newSales = [];
  let shipAllocated = 0, feesAllocated = 0, unitsDone = 0, grandProfit = 0;
  const retireSingles = {};      // rowId -> units to retire
  const retireBoosterPacks = {}; // rowId -> units to retire

  planned.forEach(p => {
    unitsDone++;
    // Pro-rata shipping and fees by revenue share. Last unit absorbs rounding.
    let unitShip, unitFees;
    if (unitsDone === totalUnits) {
      unitShip = +(ship - shipAllocated).toFixed(2);
      unitFees = +(fees - feesAllocated).toFixed(2);
    } else {
      const share = totalRev > 0 ? (p.price / totalRev) : (1 / totalUnits);
      unitShip = +(ship * share).toFixed(2); shipAllocated += unitShip;
      unitFees = +(fees * share).toFixed(2); feesAllocated += unitFees;
    }
    const profit = p.price - p.cost - unitShip - unitFees;
    const margin = p.price > 0 ? ((profit / p.price) * 100).toFixed(0) + '%' : '-';
    grandProfit += profit;
    const daysHeld = _kjrDaysHeld(p.dateAcquired || '', dateSold);
    const saleId = genId('sale');
    newSales.push({
      id: saleId, dateSold, product: p.productName, buyer,
      costPrice: p.cost, totalCollected: p.price, shippingCost: unitShip,
      fees: unitFees, channel,
      dateAcquired: p.dateAcquired || '',
      ...(daysHeld !== null ? { daysHeld } : {}),
      profit, margin,
      inventoryId: p.rowId, inventoryTable: p.table
    });
    markDirty('sales', saleId);

    if (p.table === 'slabs') {
      const row = DB.slabs.find(i => i.id === p.rowId);
      if (row) { row.status = 'Sold'; markDirty('slabs', row.id); }
    } else if (p.table === 'etbs' || p.table === 'boosterBoxes') {
      const row = DB[p.table].find(i => i.id === p.rowId);
      if (row) { row.status = 'Sold'; markDirty(p.table, row.id); }
    } else if (p.table === 'boosterPacks') {
      retireBoosterPacks[p.rowId] = (retireBoosterPacks[p.rowId] || 0) + 1;
    } else {
      retireSingles[p.rowId] = (retireSingles[p.rowId] || 0) + 1;
    }
  });

  // Retire the consumed single lots - decrement qty, or mark Sold when emptied.
  Object.keys(retireSingles).forEach(rowId => {
    const row = DB.singles.find(i => i.id === rowId);
    if (!row) return;
    const remaining = (parseInt(row.qty) || 1) - retireSingles[rowId];
    if (remaining >= 1) row.qty = remaining;
    else row.status = 'Sold';
    markDirty('singles', row.id);
  });

  // Retire booster pack lots - decrement qty, or mark Sold when emptied.
  Object.keys(retireBoosterPacks).forEach(rowId => {
    const row = DB.boosterPacks.find(i => i.id === rowId);
    if (!row) return;
    const remaining = (parseInt(row.qty) || 1) - retireBoosterPacks[rowId];
    if (remaining >= 1) row.qty = remaining;
    else { row.qty = 0; row.status = 'Sold'; }
    markDirty('boosterPacks', row.id);
  });

  // Newest first, preserving cart order within this transaction.
  DB.sales.unshift(...newSales);
  saveData();

  // Refresh only the views that could have changed.
  if (planned.some(p => p.table === 'singles')) renderSingles();
  if (planned.some(p => p.table === 'slabs'))   renderSlabs();
  if (planned.some(p => p.table === 'etbs') && typeof renderEtbs === 'function') renderEtbs();
  if (planned.some(p => p.table === 'boosterBoxes') && typeof renderBoosterBoxes === 'function') renderBoosterBoxes();
  if (planned.some(p => p.table === 'boosterPacks') && typeof renderBoosterPacks === 'function') renderBoosterPacks();
  renderSales();
  renderDashboard();

  // Per-card summary for the changelog (name xN @ avg price).
  const byName = {};
  planned.forEach(p => {
    byName[p.name] = byName[p.name] || { n: 0, rev: 0 };
    byName[p.name].n++; byName[p.name].rev += p.price;
  });
  const itemSummary = Object.keys(byName)
    .map(n => n + ' x' + byName[n].n + ' @S$' + (byName[n].rev / byName[n].n).toFixed(0)).join(' | ');

  toast(totalUnits + ' item' + (totalUnits === 1 ? '' : 's') + ' sold - ' + (grandProfit >= 0 ? '+' : '') + 'S$' + grandProfit.toFixed(0) + ' profit');
  clLog('sell', 'sales',
    totalUnits + ' item' + (totalUnits === 1 ? '' : 's') + ' in one sale',
    'buyer=' + (buyer || '∅') + ' · revenue=S$' + totalRev.toFixed(0) + ' · ship=S$' + ship.toFixed(0) +
    (fees > 0 ? ' · fees=S$' + fees.toFixed(0) : '') +
    ' · channel=' + channel +
    ' · profit=S$' + grandProfit.toFixed(0) +
    ' · items: ' + itemSummary);
  closeCmdBar();
}

// =========== CHANGELOG ===========
const CL_KEY = 'pokeinv_changelog';
const CL_LIMIT = 500;

function clLog(action, table, detail, extra) {
  const log = clLoad();
  log.unshift({ id: 'cl_' + Date.now(), ts: Date.now(), action, table: table||'', detail: detail||'', extra: extra||'' });
  if (log.length > CL_LIMIT) log.splice(CL_LIMIT);
  try { localStorage.setItem(CL_KEY, JSON.stringify(log)); } catch(e) {}
}

function clLoad() {
  try { return JSON.parse(localStorage.getItem(CL_KEY) || '[]'); } catch(e) { return []; }
}

// ── Changelog helpers ────────────────────────────────────────
// Centralised diff + summary formatters so every mutation site can log
// "what was changed" without copy-pasting field lists. Keys are explicit
// per-table so we never accidentally log internal fields like priceHistory
// or _updatedAt. CURRENCY fields are formatted with S$, dates with their
// canonical "D MMM YYYY" format.
const CL_FIELDS_BY_TABLE = {
  singles:        ['name','set','language','type','condition','qty','costPrice','marketPrice','listPrice','datePurchased','status','notes','priceAlert','ebayUrl','carousellUrl'],
  slabs:          ['name','grader','grade','certNo','rank','language','set','costPrice','marketPrice','listPrice','dateListed','status','notes','priceAlert','ebayUrl','carousellUrl'],
  sales:          ['dateSold','product','buyer','costPrice','totalCollected','shippingCost','profit','margin','inventoryId','inventoryTable'],
  etbs:           ['product','status','totalPrice','marketPrice','condition','date','notes'],
  boosterBoxes:   ['product','status','unitPrice','qty','totalPrice','notes','date'],
  boosterPacks:   ['product','status','unitPrice','qty','totalPrice','notes','date'],
  ebayPurchases:  ['product','status','tracking','priceUsd','freightSgd','totalSgd','declared','targetTable','date','notes'],
};
const CL_CURRENCY_FIELDS = new Set([
  'costPrice','marketPrice','listPrice','totalCollected','shippingCost','profit',
  'totalPrice','unitPrice','priceUsd','freightSgd','totalSgd','priceAlert'
]);
function _clFmtVal(field, v) {
  if (v === '' || v == null || v === undefined) return '∅';
  const s = String(v);
  if (CL_CURRENCY_FIELDS.has(field) && !isNaN(parseFloat(v))) {
    return (field === 'priceUsd' ? 'US$' : 'S$') + parseFloat(v).toLocaleString('en-SG', { maximumFractionDigits: 0 });
  }
  return s.length > 60 ? s.slice(0,60) + '…' : s;
}
// Build a "field: from → to · field2: from → to" diff between two records.
// Returns '' if no tracked field changed (caller can decide to skip logging).
function _clDiff(table, before, after) {
  const keys = CL_FIELDS_BY_TABLE[table] || Object.keys(after || {});
  const parts = [];
  for (const k of keys) {
    const a = before ? before[k] : undefined;
    const b = after  ? after[k]  : undefined;
    // Treat '', null, undefined as equivalent for diff purposes (a blank
    // string and an unset field are the same to the user).
    const aN = (a === '' || a == null) ? '' : String(a);
    const bN = (b === '' || b == null) ? '' : String(b);
    if (aN !== bN) parts.push(k + ': ' + _clFmtVal(k, a) + ' → ' + _clFmtVal(k, b));
  }
  return parts.join(' · ');
}
// Build a "key=val · key2=val2" snapshot for ADD logs so the reviewer
// can see at a glance what was actually entered.
function _clSummary(table, item) {
  const keys = CL_FIELDS_BY_TABLE[table] || Object.keys(item || {});
  const parts = [];
  for (const k of keys) {
    const v = item ? item[k] : undefined;
    if (v === '' || v == null) continue;
    parts.push(k + '=' + _clFmtVal(k, v));
  }
  return parts.join(' · ');
}

async function clearChangelog() {
  if (!await kjrConfirm('Clear all changelog entries?', {ok:'Clear all', danger:true})) return;
  localStorage.removeItem(CL_KEY);
  renderChangelog();
  toast('Changelog cleared');
}

function renderChangelog() {
  const typeFilter  = document.getElementById('cl-filter-type')?.value  || '';
  const tableFilter = document.getElementById('cl-filter-table')?.value || '';
  let log = clLoad();
  if (typeFilter)  log = log.filter(e => e.action === typeFilter);
  if (tableFilter) log = log.filter(e => e.table  === tableFilter);
  document.getElementById('cl-count').textContent = log.length + ' entries';
  const dotCls      = { add:'cl-dot-add', edit:'cl-dot-edit', delete:'cl-dot-delete', sell:'cl-dot-sell', import:'cl-dot-import', restore:'cl-dot-add', complete:'cl-dot-sell', migrate:'cl-dot-import', snapshot:'cl-dot-import' };
  const actionLabel = { add:'Added', edit:'Edited', delete:'Deleted', sell:'Sale', import:'Import', restore:'Restored', complete:'Completed', migrate:'Migrated', snapshot:'Snapshot' };
  const tableLabel  = { singles:'Singles', slabs:'Slabs', sales:'Sales',
                        etbs:'ETBs', boosterBoxes:'Booster Boxes', boosterPacks:'Booster Packs',
                        ebayPurchases:'eBay Purchases', versions:'Versions', '':'' };
  const el = document.getElementById('cl-list');
  if (log.length === 0) {
    // Changelog is a <div> list, not a <table>, so it can't reuse
    // kjrInvEmptyRow's <tr> wrapper directly - same visual language
    // (.hig-empty), no CTA (there's nothing to "add" here per spec).
    const isFiltered = !!(typeFilter || tableFilter);
    el.innerHTML = isFiltered
      ? '<div class="hig-empty"><div class="hig-empty-icon">🔍</div><div class="hig-empty-title">No matches</div><div class="hig-empty-sub">Nothing matches the current filters. Clear them to see the full history.</div></div>'
      : '<div class="hig-empty"><div class="hig-empty-icon">📜</div><div class="hig-empty-title">No changes logged yet</div><div class="hig-empty-sub">Actions like adding cards, logging sales, and imports will appear here.</div></div>';
    return;
  }
  el.innerHTML = log.map(e => {
    const d = new Date(e.ts);
    const timeStr = d.toLocaleString('en-GB', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
    const tbl = tableLabel[e.table] || e.table;
    // Diff / summary lines can be long (multiple "field: from → to" parts
    // joined by · ). Render them on a separate row in a monospace tone so
    // they're scannable, and let them wrap rather than truncate.
    const detailEsc = esc(e.detail||'');
    const extraEsc  = esc(e.extra ||'');
    return '<div class="cl-item">' +
      '<div class="cl-dot ' + (dotCls[e.action]||'cl-dot-edit') + '"></div>' +
      '<div class="cl-body">' +
        '<div class="cl-action">' + (actionLabel[e.action]||e.action) + (tbl ? ' · <span style="color:var(--text3)">' + tbl + '</span>' : '') + '</div>' +
        '<div class="cl-detail">' + detailEsc + '</div>' +
        (extraEsc
          ? '<div class="cl-extra" style="font-size:11px;color:var(--text3);margin-top:3px;line-height:1.5;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;word-break:break-word">' + extraEsc + '</div>'
          : '') +
      '</div>' +
      '<div class="cl-time">' + timeStr + '</div>' +
    '</div>';
  }).join('');
}

const undoStack = [];
const redoStack = [];
const UNDO_LIMIT = 30;

// Cap the *total* serialized size of the undo stack so a large inventory
// (e.g. 5000 rows) doesn't blow past localStorage / memory limits.
const UNDO_BYTES_CAP = 4 * 1024 * 1024; // 4 MB combined
function snapshotForUndo() {
  const snap = JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases });
  undoStack.push(snap);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  // Drop oldest entries until we fit under the byte cap.
  let bytes = undoStack.reduce((s, j) => s + j.length, 0);
  while (bytes > UNDO_BYTES_CAP && undoStack.length > 1) {
    bytes -= undoStack.shift().length;
  }
  redoStack.length = 0; // clear redo on new action
}

function undoLast() {
  if (undoStack.length === 0) { toast('Nothing to undo'); return; }
  // Snapshot the *current* state into redo before mutating.
  const beforeUndo = { singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases };
  redoStack.push(JSON.stringify(beforeUndo));
  const prev = JSON.parse(undoStack.pop());
  // Capture id sets BEFORE applying the undo, so any row present now but
  // absent after can be deleted from Supabase too - otherwise the flush only
  // ever uploads rows that still exist, and the deleted-cloud row re-merges
  // back into local state on the next load, undoing the undo (B3).
  const _before = {};
  for (const tbl of SYNCED_TABLES) _before[tbl] = new Set((DB[_dbKey(tbl)] || []).map(r => r.id));
  // Diff old vs new so we only mark records that actually changed (or were
  // added/removed) as dirty, instead of re-uploading the entire DB.
  const diffIds = (oldArr, newArr) => {
    const oldMap = new Map(oldArr.map(r => [r.id, JSON.stringify(r)]));
    const newMap = new Map(newArr.map(r => [r.id, JSON.stringify(r)]));
    const ids = new Set();
    for (const [id, json] of newMap) if (oldMap.get(id) !== json) ids.add(id);
    for (const id of oldMap.keys()) if (!newMap.has(id)) ids.add(id); // deletions also need to sync
    return ids;
  };
  diffIds(beforeUndo.singles,        prev.singles       ).forEach(id => markDirty('singles', id));
  diffIds(beforeUndo.slabs,          prev.slabs         ).forEach(id => markDirty('slabs',   id));
  diffIds(beforeUndo.sales,          prev.sales         ).forEach(id => markDirty('sales',   id));
  diffIds(beforeUndo.etbs||[],       prev.etbs||[]      ).forEach(id => markDirty('etbs',           id));
  diffIds(beforeUndo.boosterBoxes||[], prev.boosterBoxes||[]).forEach(id => markDirty('boosterBoxes', id));
  diffIds(beforeUndo.boosterPacks||[], prev.boosterPacks||[]).forEach(id => markDirty('boosterPacks', id));
  diffIds(beforeUndo.ebayPurchases||[], prev.ebayPurchases||[]).forEach(id => markDirty('ebayPurchases', id));
  DB.singles       = prev.singles;
  DB.slabs         = prev.slabs;
  DB.sales         = prev.sales;
  DB.etbs          = prev.etbs          || DB.etbs;
  DB.boosterBoxes  = prev.boosterBoxes  || DB.boosterBoxes;
  DB.boosterPacks  = prev.boosterPacks  || DB.boosterPacks;
  DB.ebayPurchases = prev.ebayPurchases || DB.ebayPurchases;
  saveData();
  // Delete from Supabase any id that existed before the undo but not after -
  // routed directly through sbDelete (which already queues its own retries),
  // NOT through the dirty system, since a removed row has nothing to upload.
  for (const tbl of SYNCED_TABLES) {
    const now = new Set((DB[_dbKey(tbl)] || []).map(r => r.id));
    for (const id of _before[tbl]) if (!now.has(id)) sbDelete(tbl, id);
  }
  renderSingles(); renderSlabs(); renderSales();
  if (typeof renderEtbs === 'function') renderEtbs();
  if (typeof renderBoosterBoxes === 'function') renderBoosterBoxes();
  if (typeof renderBoosterPacks === 'function') renderBoosterPacks();
  if (typeof renderEbayPurchases === 'function') renderEbayPurchases();
  toast('Undone ↩');
}

function redoLast() {
  if (redoStack.length === 0) { toast('Nothing to redo'); return; }
  const beforeRedo = { singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases };
  undoStack.push(JSON.stringify(beforeRedo));
  const next = JSON.parse(redoStack.pop());
  // Same before/after id-diff as undoLast, so a redo that re-deletes a row
  // (e.g. redoing a delete that a prior undo had restored) removes it from
  // Supabase too instead of letting the cloud copy silently re-merge (B3).
  const _before = {};
  for (const tbl of SYNCED_TABLES) _before[tbl] = new Set((DB[_dbKey(tbl)] || []).map(r => r.id));
  // Same diff approach as undoLast - only sync records that changed.
  const diffIds = (oldArr, newArr) => {
    const oldMap = new Map(oldArr.map(r => [r.id, JSON.stringify(r)]));
    const newMap = new Map(newArr.map(r => [r.id, JSON.stringify(r)]));
    const ids = new Set();
    for (const [id, json] of newMap) if (oldMap.get(id) !== json) ids.add(id);
    for (const id of oldMap.keys()) if (!newMap.has(id)) ids.add(id);
    return ids;
  };
  diffIds(beforeRedo.singles,         next.singles        ).forEach(id => markDirty('singles', id));
  diffIds(beforeRedo.slabs,           next.slabs          ).forEach(id => markDirty('slabs',   id));
  diffIds(beforeRedo.sales,           next.sales          ).forEach(id => markDirty('sales',   id));
  diffIds(beforeRedo.etbs||[],        next.etbs||[]       ).forEach(id => markDirty('etbs',          id));
  diffIds(beforeRedo.boosterBoxes||[], next.boosterBoxes||[]).forEach(id => markDirty('boosterBoxes', id));
  diffIds(beforeRedo.boosterPacks||[], next.boosterPacks||[]).forEach(id => markDirty('boosterPacks', id));
  diffIds(beforeRedo.ebayPurchases||[], next.ebayPurchases||[]).forEach(id => markDirty('ebayPurchases', id));
  DB.singles       = next.singles;
  DB.slabs         = next.slabs;
  DB.sales         = next.sales;
  DB.etbs          = next.etbs          || DB.etbs;
  DB.boosterBoxes  = next.boosterBoxes  || DB.boosterBoxes;
  DB.boosterPacks  = next.boosterPacks  || DB.boosterPacks;
  DB.ebayPurchases = next.ebayPurchases || DB.ebayPurchases;
  saveData();
  for (const tbl of SYNCED_TABLES) {
    const now = new Set((DB[_dbKey(tbl)] || []).map(r => r.id));
    for (const id of _before[tbl]) if (!now.has(id)) sbDelete(tbl, id);
  }
  renderSingles(); renderSlabs(); renderSales();
  if (typeof renderEtbs === 'function') renderEtbs();
  if (typeof renderBoosterBoxes === 'function') renderBoosterBoxes();
  if (typeof renderBoosterPacks === 'function') renderBoosterPacks();
  if (typeof renderEbayPurchases === 'function') renderEbayPurchases();
  toast('Redone ↪');
}

// =========== VERSION HISTORY (Supabase-backed) ===========
// Versions are stored in Supabase 'versions' table so they persist across devices.
// localStorage is used only as a fast cache; Supabase is the source of truth.
const VER_KEY = 'pokeinv_versions';
let _versionsCache = null; // in-memory cache for this session

async function sbFetchVersions() {
  try {
    const r = await fetch(SB_URL + '/rest/v1/versions?select=id,data,updated_at&order=updated_at.desc&limit=50', { headers: SB_HDR, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(await r.text());
    const rows = await r.json();
    return rows.map(row => ({ id: row.id, ...row.data, _ts: new Date(row.updated_at).getTime() }));
  } catch(e) {
    console.warn('Could not fetch versions from Supabase:', e.message);
    // Fall back to localStorage cache
    try { return JSON.parse(localStorage.getItem(VER_KEY) || '[]'); } catch(e2) { return []; }
  }
}

// Returns true only on a confirmed cloud write, so callers (e.g. the version
// pruning step) can tell a real success from a swallowed failure and never
// delete anything after a save that didn't actually reach the cloud.
async function sbSaveVersion(ver) {
  if (isLocalhostPreview()) { return false; } // never write to prod from a local preview
  // ver = { id, name, ts, data (stringified snapshot) }
  const payload = { id: ver.id, data: { name: ver.name, ts: ver.ts, data: ver.data }, updated_at: new Date(ver.ts).toISOString() };
  try {
    const r = await fetch(SB_URL + '/rest/v1/versions?on_conflict=id', {
      method: 'POST',
      headers: { ...SB_HDR, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(await r.text());
    return true;
  } catch(e) {
    console.warn('Could not save version to Supabase:', e.message);
    // Still persisted in localStorage below
    return false;
  }
}

async function sbDeleteVersion(id) {
  if (isLocalhostPreview()) { return; } // never write to prod from a local preview
  try {
    const r = await fetch(SB_URL + '/rest/v1/versions?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE', headers: SB_HDR, signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(await r.text());
  } catch(e) { console.warn('Could not delete version from Supabase:', e.message); }
}

function loadVersions() {
  if (_versionsCache) return _versionsCache;
  try { return JSON.parse(localStorage.getItem(VER_KEY) || '[]'); } catch(e) { return []; }
}

// How many recent version snapshots keep their FULL data blob in localStorage.
// The rest store metadata only (name/date) and pull their data from Supabase
// on restore. A full snapshot is ~300-400KB, so keeping all 50 here would try
// to hold ~18MB and overflow the browser's ~5MB localStorage quota - that was
// the "Local storage full" cause. Supabase holds the complete history.
const VER_LS_KEEP_FULL = 2;
function _cacheVersions(versions) {
  _versionsCache = versions; // session cache keeps everything (full data) in memory
  const writeLite = (keepFull) => {
    const lite = versions.map((v, i) => {
      if (i < keepFull) return v;          // recent: keep full snapshot for offline restore
      const { data, ...meta } = v;          // older: drop the heavy blob, keep metadata
      return meta;
    });
    localStorage.setItem(VER_KEY, JSON.stringify(lite));
  };
  try {
    writeLite(VER_LS_KEEP_FULL);
  } catch(e) {
    // Even the trimmed list won't fit - fall back to metadata only (no blobs).
    try { writeLite(0); } catch(e2) { /* Supabase still has everything */ }
  }
}

// Strip every full-DB blob out of the cached versions in localStorage to
// reclaim space. Called when an inventory save hits the quota. Versions stay
// safe in Supabase; only the local offline copies of their data are dropped.
function _evictVersionBlobsFromLS() {
  try {
    const raw = localStorage.getItem(VER_KEY);
    if (raw) {
      const metaOnly = JSON.parse(raw).map(({ data, ...meta }) => meta);
      localStorage.setItem(VER_KEY, JSON.stringify(metaOnly));
    }
  } catch(e) {
    try { localStorage.removeItem(VER_KEY); } catch(_) {}
  }
  _versionsCache = null; // force a fresh load (with blobs) next time it's needed
}

async function saveVersion() {
  const nameInput = document.getElementById('ver-name-input');
  const name = (nameInput ? nameInput.value.trim() : '') ||
    'Version ' + new Date().toLocaleString('en-GB', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
  await _saveVersionWithName(name);
  if (nameInput) nameInput.value = '';
  renderVerList();
  toast('Version saved: ' + name + ' ✓');
}

// Lower-level helper used by both the manual Save Version button and the
// automatic daily snapshot. Skips the toast / input clear.
async function _saveVersionWithName(name){
  const ver = {
    id: 'v_' + Date.now(),
    name,
    ts: Date.now(),
    data: JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases })
  };
  const versions = loadVersions();
  versions.unshift(ver);
  if (versions.length > 50) versions.splice(50);
  _cacheVersions(versions);
  const cloudSaved = await sbSaveVersion(ver);
  if (cloudSaved) await _pruneCloudVersions();
  return ver;
}

// Keep the cloud `versions` table capped at the newest 50 rows. Only runs
// after a successful save (never on a failure path - a save that didn't
// reach the cloud must not trigger deletes there). Best-effort: any error
// here is logged and swallowed so a pruning hiccup never blocks the save
// the user actually asked for.
async function _pruneCloudVersions() {
  if (isLocalhostPreview()) return; // never write to prod from a local preview
  try {
    const r = await fetch(SB_URL + '/rest/v1/versions?select=id&order=updated_at.desc', {
      headers: { ...SB_HDR, 'Range-Unit': 'items', 'Range': '50-9999' }
    });
    if (!r.ok) return; // don't throw - pruning failure shouldn't surface as a save error
    const stale = await r.json();
    for (const row of stale) {
      await sbDeleteVersion(row.id);
    }
  } catch(e) {
    console.warn('Could not prune old cloud versions:', e.message);
  }
}

// ════════ DAILY AUTO-VERSION SNAPSHOTS ════════
// Once per calendar day, automatically saves a versioned snapshot named
// "Auto · YYYY-MM-DD". Uses localStorage to de-dupe so multiple tabs or
// reloads in the same day don't spam the versions list. Provides 30+
// days of point-in-time rollback with zero user effort.
const AUTO_VER_KEY = 'pokeinv_last_auto_version_date';
async function maybeRunDailyAutoVersion(){
  try {
    // Only run once we actually have data - empty-DB startup snapshots are
    // noise and could clobber a real snapshot on a different device that
    // synced first.
    const hasData = (DB.singles||[]).length || (DB.slabs||[]).length || (DB.sales||[]).length;
    if (!hasData) return;
    const today = new Date().toISOString().slice(0,10); // YYYY-MM-DD in UTC
    const last  = localStorage.getItem(AUTO_VER_KEY);
    if (last === today) return;
    const name = 'Auto · ' + today;
    await _saveVersionWithName(name);
    localStorage.setItem(AUTO_VER_KEY, today);
    // Quietly log it - no toast (the user didn't trigger this).
    if (typeof clLog === 'function') clLog('snapshot', 'versions', name, 'auto daily snapshot');
  } catch(e) { console.warn('Auto-version failed:', e); }
}
// Fire on load AND every 6 hours so a long-running tab still triggers.
document.addEventListener('DOMContentLoaded', () => setTimeout(maybeRunDailyAutoVersion, 3000));
setInterval(maybeRunDailyAutoVersion, 6 * 60 * 60 * 1000);

// One-time compaction on boot: older installs stored up to 50 full-DB version
// blobs (~18MB worth) in localStorage, which overflows the quota. Re-write the
// cached versions through _cacheVersions so only the recent few keep their blob.
document.addEventListener('DOMContentLoaded', () => {
  try {
    const raw = localStorage.getItem(VER_KEY);
    if (!raw) return;
    const vers = JSON.parse(raw);
    if (!Array.isArray(vers) || !vers.length) return;
    const withBlobs = vers.filter(v => v && v.data).length;
    if (withBlobs > VER_LS_KEEP_FULL) {
      _cacheVersions(vers); // trims to VER_LS_KEEP_FULL full blobs, frees space
      console.info('[storage] compacted ' + withBlobs + ' local version snapshots → ' + VER_LS_KEEP_FULL + ' full + metadata');
    }
  } catch(e) { /* non-fatal */ }
});

async function restoreVersion(id) {
  let versions = loadVersions();
  let ver = versions.find(v => v.id === id);
  // Missing entirely, OR present but its heavy snapshot blob was trimmed from
  // localStorage to save space - either way, fetch the full record from cloud.
  if (!ver || !ver.data) {
    versions = await sbFetchVersions();
    _cacheVersions(versions);
    ver = versions.find(v => v.id === id);
  }
  if (!ver) { toast('Version not found'); return; }
  if (!ver.data) { toast('⚠ This version\'s snapshot is only in the cloud and it could not be reached. Try again when online.'); return; }
  if (!await kjrConfirm('Restore "' + esc(ver.name) + '"? Current data will be overwritten (a backup version will be saved first).', {ok:'Restore'})) return;
  // Auto-save current state before restoring
  const backup = {
    id: 'v_' + Date.now(),
    name: 'Auto-backup before restore',
    ts: Date.now(),
    data: JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases })
  };
  versions.unshift(backup);
  _cacheVersions(versions);
  // Merge of wave 1 + wave 2: save the backup to the cloud (returns true on
  // confirmed success) and prune the cloud versions list to the newest 50,
  // AND capture id sets BEFORE applying the restore so any row present now
  // but absent in the restored snapshot gets deleted from Supabase too -
  // otherwise it re-merges back in on the next load and the restore doesn't
  // stick (B3).
  const backupCloudSaved = await sbSaveVersion(backup);
  if (backupCloudSaved) await _pruneCloudVersions();
  const _before = {};
  for (const tbl of SYNCED_TABLES) _before[tbl] = new Set((DB[_dbKey(tbl)] || []).map(r => r.id));
  // Apply the restored snapshot. Restore ALL seven tables that the snapshot
  // captures - previously only singles/slabs/sales were applied, so the other
  // four tables stayed at their current state and the version restore was lying.
  // The auto-backup above has already run at this point (that's fine, it's a
  // harmless extra save) - but a corrupt/truncated snapshot must not reach any
  // DB mutation below, so guard the parse and bail out cleanly.
  let restored;
  try {
    restored = JSON.parse(ver.data);
  } catch(e) {
    toast('⚠ This version\'s snapshot is unreadable - restore cancelled');
    return;
  }
  DB.singles       = restored.singles       || [];
  DB.slabs         = restored.slabs         || [];
  DB.sales         = restored.sales         || [];
  DB.etbs          = restored.etbs          || [];
  DB.boosterBoxes  = restored.boosterBoxes  || [];
  DB.boosterPacks  = restored.boosterPacks  || [];
  DB.ebayPurchases = restored.ebayPurchases || [];
  // Mark all dirty so restored state syncs to Supabase
  DB.singles.forEach(i       => markDirty('singles',       i.id));
  DB.slabs.forEach(i         => markDirty('slabs',         i.id));
  DB.sales.forEach(i         => markDirty('sales',         i.id));
  DB.etbs.forEach(i          => markDirty('etbs',          i.id));
  DB.boosterBoxes.forEach(i  => markDirty('boosterBoxes',  i.id));
  DB.boosterPacks.forEach(i  => markDirty('boosterPacks',  i.id));
  DB.ebayPurchases.forEach(i => markDirty('ebayPurchases', i.id));
  saveData();
  // Delete from Supabase any id that existed before the restore but is gone
  // afterwards - routed directly through sbDelete (its own retry queue),
  // NOT through the dirty system, since a removed row has nothing to upload.
  for (const tbl of SYNCED_TABLES) {
    const now = new Set((DB[_dbKey(tbl)] || []).map(r => r.id));
    for (const id of _before[tbl]) if (!now.has(id)) sbDelete(tbl, id);
  }
  renderSingles(); renderSlabs(); renderSales(); renderDashboard();
  if (typeof renderEtbs === 'function') renderEtbs();
  if (typeof renderBoosterBoxes === 'function') renderBoosterBoxes();
  if (typeof renderBoosterPacks === 'function') renderBoosterPacks();
  if (typeof renderEbayPurchases === 'function') renderEbayPurchases();
  renderVerList();
  toast('Restored: ' + ver.name);
}

async function deleteVersion(id) {
  const all = loadVersions();
  const target = all.find(v => v.id === id);
  const label = target ? ('"' + esc(target.name || 'Untitled') + '"') : 'this version';
  if (!await kjrConfirm('Permanently delete ' + label + '?\nThis cannot be undone.', {ok:'Delete', danger:true})) return;
  const versions = all.filter(v => v.id !== id);
  _cacheVersions(versions);
  renderVerList();
  await sbDeleteVersion(id);
  toast('Version deleted');
}

async function renderVerList() {
  const el = document.getElementById('ver-list');
  if (!el) return;
  // Show cached immediately, then refresh from Supabase
  const cached = loadVersions();
  _renderVerItems(el, cached);
  // Async refresh
  const fresh = await sbFetchVersions();
  if (fresh.length > 0 || cached.length === 0) {
    _cacheVersions(fresh);
    _renderVerItems(el, fresh);
  }
}

function _renderVerItems(el, versions) {
  if (versions.length === 0) {
    el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">No saved versions yet.<br>Save a version before making big changes.</div>';
    return;
  }
  el.innerHTML = versions.map(v => {
    const d = new Date(v.ts || v._ts || 0);
    const dateStr = d.toLocaleString('en-GB', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
    let counts = '';
    try {
      const parsed = JSON.parse(v.data);
      counts = parsed.singles.length + ' singles · ' + parsed.slabs.length + ' slabs · ' + parsed.sales.length + ' sales';
    } catch(e) {}
    return '<div class="ver-item">' +
      '<div class="ver-item-info">' +
        '<div class="ver-item-name">' + esc(v.name||'') + '</div>' +
        '<div class="ver-item-meta">' + dateStr + (counts ? ' · ' + counts : '') + '</div>' +
      '</div>' +
      '<div class="ver-item-actions">' +
        '<button class="btn btn-sm" onclick="restoreVersion(\'' + esc(v.id) + '\')">↩ Restore</button>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteVersion(\'' + esc(v.id) + '\')">✕</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function openVerModal() {
  kjrModalCtrl.open(document.getElementById('ver-overlay'));
  await renderVerList();
}

function closeVerModal() {
  kjrModalCtrl.close(document.getElementById('ver-overlay'));
}

document.addEventListener('keydown', function(e) {
  if (['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undoLast(); }
  if (mod && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) { e.preventDefault(); redoLast(); }
});

// =========== SOLD SECTION TOGGLE ===========
function toggleSoldSection(table) {
  const divider = document.getElementById(table + '-sold-divider');
  const soldBody = document.getElementById(table + '-sold-body');
  const isOpen = divider.dataset.open === '1';
  divider.dataset.open = isOpen ? '0' : '1';
  if (table === 'singles') renderSingles();
  if (table === 'slabs') renderSlabs();
}

// When the user marks an item as "Sold", multiple identical rows may exist
// (singles bought in lots, duplicate slabs). The collector wants the row with
// the HIGHER cost basis to be retired first - that minimises taxable profit
// and locks in the worst-case cost match. This helper picks the right copy.
function pickHigherCostDuplicate(table, item) {
  if (!item) return item;
  const arr = (DB[table] || []).filter(i => (i.status||'Available') === 'Available');
  let candidates;
  if (table === 'slabs') {
    // Slab "duplicate" = same name + grader + grade + cert (or same name+grader+grade
    // if no cert). Cert numbers are usually unique, so in practice this matches
    // a single row, but lots-of-the-same-cert is supported for completeness.
    candidates = arr.filter(i =>
      (i.name||'') === (item.name||'') &&
      (i.grader||'') === (item.grader||'') &&
      (i.grade||'') === (item.grade||'') &&
      ((i.certNo||'') === (item.certNo||'') || !i.certNo || !item.certNo)
    );
  } else {
    // Singles: same name + set + language + condition + type are dupes
    candidates = arr.filter(i =>
      (i.name||'') === (item.name||'') &&
      (i.set||'') === (item.set||'') &&
      (i.language||'') === (item.language||'') &&
      (i.condition||'') === (item.condition||'') &&
      (i.type||'') === (item.type||'')
    );
  }
  if (candidates.length <= 1) return item;
  // Pick the highest cost-price candidate (HIFO - minimises declared profit).
  // Tie-break by oldest holding (FIFO) so the changelog reports the
  // longest-held copy as the one sold. Uses dateToMs to compare chronologically
  // - a previous localeCompare on display-formatted strings ("13 May 2026")
  // sorted alphabetically, which put 13 May before 2 Jan.
  candidates.sort((a,b) => {
    const ca = parseFloat(a.costPrice)||0, cb = parseFloat(b.costPrice)||0;
    if (cb !== ca) return cb - ca;
    const ma = dateToMs(a.datePurchased || a.dateListed) || 0;
    const mb = dateToMs(b.datePurchased || b.dateListed) || 0;
    return ma - mb; // oldest first
  });
  return candidates[0];
}

// Best fair-market quote we have for a row: explicit marketPrice, else
// listPrice as a last resort. Used to pre-fill sell modals so the user
// doesn't have to type the obvious number every time.
function bestMarketFor(item) {
  const explicit = parseFloat(item.marketPrice);
  if (!isNaN(explicit) && explicit > 0) return explicit;
  const list = parseFloat(item.listPrice);
  if (!isNaN(list) && list > 0) return list;
  return '';
}

async function markStatus(table, id, status) {
  if (status === 'Sold') {
    // Open quick-sell modal instead of directly marking. Lock onto the
    // highest-cost duplicate so the right copy gets sold.
    const arr = DB[table];
    const clicked = arr.find(i => i.id === id);
    if (!clicked) return;
    const item = pickHigherCostDuplicate(table, clicked);
    const usingDup = item.id !== clicked.id;
    document.getElementById('qs-table').value = table;
    document.getElementById('qs-id').value = item.id;
    let displayName = item.name + (item.grader ? ' (' + item.grader + ' ' + item.grade + ')' : '');
    if (usingDup) displayName += '  · selling highest-cost copy (S$' + (parseFloat(item.costPrice)||0).toFixed(0) + ')';
    document.getElementById('qs-name').textContent = displayName;
    document.getElementById('qs-date').value = new Date().toISOString().slice(0,10);
    document.getElementById('qs-buyer').value = '';
    document.getElementById('qs-cost').value = item.costPrice || '';
    // Pre-fill the "Total Collected" with the best available market/list price
    // so the user can confirm with one Enter for a sale at fair value.
    document.getElementById('qs-total').value = bestMarketFor(item);
    document.getElementById('qs-ship').value = '0';
    document.getElementById('qs-fees').value = '0';
    document.getElementById('qs-channel').value = 'Carousell';
    calcQsProfit();
    openModal('modal-quick-sell');
    setTimeout(() => document.getElementById('qs-total').focus(), 100);
  } else {
    // Marking back to Available - if a linked Sale exists, ask whether to
    // also remove that sale, otherwise revenue & profit double-count
    // (slab is back in inventory AND credited to sales).
    const arr = DB[table];
    const item = arr.find(i => i.id === id);
    if (!item) return;
    const linked = DB.sales.filter(s => s.inventoryId === id && s.inventoryTable === table);
    let removeSales = false;
    if (linked.length) {
      removeSales = await kjrConfirm(
        'There ' + (linked.length === 1 ? 'is 1 sale' : 'are ' + linked.length + ' sales') +
        ' linked to this item.\n\nRemove sales → remove the linked sale(s) so revenue/profit aren\'t double-counted.\nKeep sales → keep the sale record(s) (you marked the item available without retracting the sale).',
        {ok:'Remove sales', cancel:'Keep sales'}
      );
    }
    snapshotForUndo();
    const prevStatus = item.status;
    item.status = status;
    markDirty(table, id);
    if (removeSales) {
      linked.forEach(s => {
        const idx = DB.sales.findIndex(x => x.id === s.id);
        if (idx >= 0) {
          DB.sales.splice(idx, 1);
          markDirty('sales', s.id);
          sbDelete('sales', s.id).catch(()=>{});
          clLog('delete', 'sales', s.product, 'auto-removed (item re-availed)');
        }
      });
      renderSales();
    }
    saveData();
    // Audit trail: log the status flip itself so the changelog reflects
    // the re-avail (was silently missing before).
    if (typeof clLog === 'function') {
      const label = item.name || item.product || item.title || id;
      clLog('edit', table, label, 'status: ' + (prevStatus || '∅') + ' → ' + status);
    }
    if (table === 'singles') renderSingles();
    if (table === 'slabs') renderSlabs();
    renderDashboard();
    toast(removeSales ? 'Re-availed · ' + linked.length + ' sale(s) removed' : 'Marked as Available');
  }
}

// Returns number of days between two "D MMM YYYY" date strings, or null if
// either date is missing or unparseable. Used by all sell flows to compute
// how long an item was held before sale.
function _kjrDaysHeld(dateAcquired, dateSold) {
  if (!dateAcquired || !dateSold) return null;
  const a = new Date(dateAcquired);
  const b = new Date(dateSold);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

function calcQsProfit() {
  const cost  = kjrNum(document.getElementById('qs-cost').value);
  const total = kjrNum(document.getElementById('qs-total').value);
  const ship  = kjrNum(document.getElementById('qs-ship').value);
  const fees  = kjrNum(document.getElementById('qs-fees').value);
  const profit = total - cost - ship - fees;
  const margin = total > 0 ? ((profit / total) * 100).toFixed(0) + '%' : '-';
  document.getElementById('qs-profit').value = fmtSigned(profit) + (total > 0 ? '  (' + margin + ' margin)' : '');
}

function confirmQuickSell() {
  const table = document.getElementById('qs-table').value;
  const id    = document.getElementById('qs-id').value;
  const totalRaw = document.getElementById('qs-total').value;
  const total = kjrNum(totalRaw);
  // Blank/whitespace stays blocked, but an explicitly entered 0 is a real
  // disposal (giveaway/trade) and must go through. Only the raw string can
  // tell blank apart from zero - kjrNum('') and kjrNum('0') both return 0.
  if (totalRaw == null || String(totalRaw).trim() === '') { toast('Enter the sold price'); return; }
  if (total < 0) { toast('Enter the sold price'); return; }

  snapshotForUndo();

  // Mark item as Sold, unless multiple units remain - then decrement qty
  // and keep it Available. Only the last unit flips status to Sold.
  const arr  = DB[table];
  const item = arr.find(i => i.id === id);
  if (!item) return;
  const curQty = parseInt(item.qty) || 1;
  let remainingQty = null;
  if (curQty > 1) {
    item.qty = curQty - 1;
    remainingQty = item.qty;
  } else {
    item.status = 'Sold';
  }

  // Create sales record
  const cost    = kjrNum(document.getElementById('qs-cost').value);
  const ship    = kjrNum(document.getElementById('qs-ship').value);
  const fees    = kjrNum(document.getElementById('qs-fees').value);
  const channel = document.getElementById('qs-channel').value || 'Carousell';
  const profit  = total - cost - ship - fees;
  const margin  = total > 0 ? ((profit/total)*100).toFixed(0) + '%' : '-';
  const dateSold = formatDateInput(document.getElementById('qs-date').value);
  const dateAcquired = toDateMmmYyyy(item.datePurchased || item.dateListed || item.date || '') || '';
  const daysHeld = _kjrDaysHeld(dateAcquired, dateSold);
  const saleRecord = {
    id: genId('sale'),
    dateSold,
    product: item.name + (item.grader ? ' ' + item.grader + ' ' + item.grade + (item.certNo ? ' #' + item.certNo : '') : ''),
    buyer: document.getElementById('qs-buyer').value,
    costPrice: cost,
    totalCollected: total,
    shippingCost: ship,
    fees,
    channel,
    dateAcquired,
    ...(daysHeld !== null ? { daysHeld } : {}),
    profit,
    margin,
    inventoryId: id,
    inventoryTable: table
  };
  DB.sales.unshift(saleRecord);
  markDirty(table, id);           // item status changed to Sold
  markDirty('sales', saleRecord.id); // new sale record
  saveData();
  closeModal('modal-quick-sell', true); // force: data is already saved, skip the unsaved-changes prompt
  if (table === 'singles') renderSingles();
  if (table === 'slabs') renderSlabs();
  renderSales();
  toast(remainingQty !== null ? ('Sold ✓ - ' + remainingQty + ' remaining - sale recorded in Sales tab') : 'Sold ✓ - sale recorded in Sales tab');
  clLog('sell', table, saleRecord.product,
    'cost=S$' + cost + ' · revenue=S$' + total + ' · ship=S$' + ship +
    (fees > 0 ? ' · fees=S$' + fees : '') +
    ' · profit=S$' + profit.toFixed(0) + ' · margin=' + margin +
    ' · channel=' + channel + ' · buyer=' + (saleRecord.buyer || '∅') +
    ' · held=' + (daysHeld !== null ? daysHeld + 'd' : '?') +
    ' · linked ' + table + '#' + id);
}

// ════════════════════ HEALTH CHECK ════════════════════
// Browser-side smoke test that validates accounting invariants and surfaces
// inconsistencies the user can fix before they corrupt the dataset further.
// Triggered manually from the topbar 💓 button. Returns a list of findings
// grouped as FAIL (must fix), WARN (review), INFO (FYI).
function runHealthCheck(){
  const findings = []; // { sev, area, message, fix?, details?: [{label, table?, id?}] }
  const F = (sev, area, message, fix, details) => findings.push({ sev, area, message, fix, details });
  const describe = (item, table) => {
    if (!item) return '(missing)';
    if (table === 'sales') return (item.product || 'sale') + ' · ' + (item.buyer || 'no buyer') + ' · ' + (toDateMmmYyyy(item.dateSold) || '');
    if (table === 'slabs') return (item.name || 'slab') + ' · ' + [item.grader, item.grade, item.certNo ? '#'+item.certNo : ''].filter(Boolean).join(' ');
    if (table === 'singles') return (item.name || 'card') + ' · ' + [item.set, item.language, item.condition].filter(Boolean).join(' ');
    if (table === 'ebayPurchases') return (item.product || 'purchase') + ' · ' + (item.tracking || 'no tracking') + ' · ' + (toDateMmmYyyy(item.date) || '');
    return item.product || item.name || item.id || '?';
  };

  // 1. Sales <-> inventory consistency
  const orphans = [], mismatched = [], dups = [];
  const seenSaleIds = new Map();
  (DB.sales || []).forEach(s => {
    if (seenSaleIds.has(s.id)) dups.push({ label: describe(s, 'sales'), table: 'sales', id: s.id });
    seenSaleIds.set(s.id, s);
    if (!s.inventoryId || !s.inventoryTable) { orphans.push({ label: describe(s, 'sales'), table: 'sales', id: s.id }); return; }
    const inv = (DB[s.inventoryTable] || []).find(i => i.id === s.inventoryId);
    if (!inv) {
      orphans.push({ label: describe(s, 'sales') + '  →  inv ' + s.inventoryId + ' missing', table: 'sales', id: s.id });
    } else if ((inv.status||'') !== 'Sold' && (inv.qty||1) === 1) {
      mismatched.push({ label: describe(s, 'sales') + '  ←→  ' + describe(inv, s.inventoryTable), table: 'sales', id: s.id });
    }
  });
  if (mismatched.length)
    F('fail', 'Sales', mismatched.length + ' sale(s) linked to items that are NOT marked Sold - revenue is double-counted.',
      'Open Sales tab, click the ↗ source button on affected rows, set the item status to Sold.', mismatched);
  if (orphans.length)
    F('warn', 'Sales', orphans.length + ' sale(s) reference no inventory item (manual entries or deleted).',
      'These are usually fine for manual sales without a tracked source, but the dashboard\'s Realised ROI can\'t use them for cost-basis math. Delete the sale if it was logged in error, or accept that it has no source.',
      orphans);
  if (dups.length)
    F('fail', 'Sales', dups.length + ' sale records share the same id (ID collision).',
      'Inspect the changelog for the timestamp; delete one duplicate.', dups);

  // 2. Negative or absurd prices
  const negCost = [], absurdMkt = [];
  ['singles','slabs'].forEach(t => {
    (DB[t] || []).forEach(i => {
      const c = parseFloat(i.costPrice), m = parseFloat(i.marketPrice);
      if (!isNaN(c) && c < 0) negCost.push({ label: describe(i, t) + ' · cost S$' + c, table: t, id: i.id });
      if (!isNaN(m) && !isNaN(c) && c > 0 && m > c * 50) absurdMkt.push({ label: describe(i, t) + ' · cost S$' + c.toFixed(0) + ' → market S$' + m.toFixed(0), table: t, id: i.id });
    });
  });
  if (negCost.length) F('fail', 'Pricing', negCost.length + ' item(s) have a negative cost price.', 'Search "<0" in the Singles/Slabs tab.', negCost);
  if (absurdMkt.length) F('warn', 'Pricing', absurdMkt.length + ' item(s) have a market price >50× cost (probable typo or wrong PPT match).', 'Verify by sorting Singles/Slabs by Market Price descending.', absurdMkt);

  // 3. eBay currency math
  const badEbay = [];
  const rate = (typeof _sgdRate === 'number' && _sgdRate > 0) ? _sgdRate : 1.27;
  (DB.ebayPurchases || []).forEach(r => {
    const stored = parseFloat(r.totalSgd) || 0;
    if (stored <= 0) return;
    const computed = (parseFloat(r.priceUsd)||0) * rate + (parseFloat(r.freightSgd)||0);
    if (computed > 0 && Math.abs(stored - computed) / computed > 0.02) {
      badEbay.push({ label: describe(r,'ebayPurchases') + ' · stored S$' + stored.toFixed(0) + ' vs computed S$' + computed.toFixed(0), table: 'ebayPurchases', id: r.id });
    }
  });
  if (badEbay.length)
    F('warn', 'eBay', badEbay.length + ' eBay row(s) have a stored SGD that drifts >2% from USD×rate + freight.',
      'Open each row - the breakdown line below "Total (SGD)" shows the live computation. Click ↺ to use auto-calc.', badEbay);

  // 4. Dashboard sum invariants
  const invCostSingles = (DB.singles||[]).filter(i => (i.status||'Available') === 'Available')
    .reduce((s,i) => s + (parseFloat(i.costPrice)||0) * (parseInt(i.qty)||1), 0);
  const invCostSlabs = (DB.slabs||[]).filter(i => (i.status||'Available') === 'Available')
    .reduce((s,i) => s + (parseFloat(i.costPrice)||0), 0);
  F('info', 'Dashboard', `Expected available cost basis - Singles: S$${invCostSingles.toFixed(0)} · Slabs: S$${invCostSlabs.toFixed(0)}.`, '');

  // 5. Sync queue health
  let dirtyTotal = 0;
  const dirtyDetails = [];
  if (typeof _dirty === 'object') {
    Object.entries(_dirty || {}).forEach(([table, set]) => {
      if (set && typeof set.size === 'number' && set.size > 0) {
        dirtyTotal += set.size;
        for (const id of set) {
          const item = (DB[table] || []).find(r => r.id === id);
          if (item) dirtyDetails.push({ label: '[' + table + '] ' + describe(item, table), table, id });
          else dirtyDetails.push({ label: '[' + table + '] ' + id + ' (deleted but pending)', table, id });
        }
      }
    });
  }
  if (dirtyTotal > 100)
    F('warn', 'Sync', dirtyTotal + ' dirty rows pending upload to Supabase - sync may be wedged.',
      'Check the Network tab for failed POSTs to supabase.co. If offline, no action needed.', dirtyDetails);
  else if (dirtyTotal === 0)
    F('info', 'Sync', 'No pending writes - local state matches last successful upload.', '');
  else
    F('info', 'Sync', dirtyTotal + ' dirty rows pending upload (normal during active editing).', '', dirtyDetails);

  // 6. Date format consistency
  const badDates = [];
  const checkDate = (val, item, table, field) => {
    if (!val) return;
    const canon = toDateMmmYyyy(val);
    if (canon !== val) badDates.push({ label: describe(item, table) + ' · ' + field + ': "' + val + '" → "' + canon + '"', table, id: item.id });
  };
  (DB.singles||[]).forEach(i => checkDate(i.datePurchased, i, 'singles', 'datePurchased'));
  (DB.slabs||[]).forEach(i => checkDate(i.dateListed, i, 'slabs', 'dateListed'));
  (DB.sales||[]).forEach(i => checkDate(i.dateSold, i, 'sales', 'dateSold'));
  (DB.ebayPurchases||[]).forEach(i => checkDate(i.date, i, 'ebayPurchases', 'date'));
  if (badDates.length)
    F('warn', 'Dates', badDates.length + ' row(s) have a non-canonical date format.',
      'Display works correctly via toDateMmmYyyy(); chronological sort uses dateToMs and also works. Click "Auto-fix dates" below to re-save them in canonical format.', badDates);

  // 7. Duplicate cert numbers on slabs
  const certs = new Map();
  (DB.slabs||[]).forEach(s => {
    if (!s.certNo) return;
    const k = (s.grader||'') + '#' + s.certNo;
    if (!certs.has(k)) certs.set(k, []);
    certs.get(k).push(s);
  });
  const dupCertList = [];
  certs.forEach((arr, k) => {
    if (arr.length > 1) arr.forEach(s => dupCertList.push({ label: k + ' · ' + describe(s, 'slabs'), table: 'slabs', id: s.id }));
  });
  if (dupCertList.length)
    F('fail', 'Slabs', dupCertList.length + ' rows share a cert # with another (each grader cert is globally unique).',
      'Search the cert # in Slabs to find conflicting rows; delete the wrong copy.', dupCertList);

  // 8. Empty cost basis on sold inventory
  const soldNoCost = [];
  ['singles','slabs'].forEach(t => {
    (DB[t]||[]).forEach(i => {
      if ((i.status||'') === 'Sold' && (!i.costPrice || parseFloat(i.costPrice) === 0))
        soldNoCost.push({ label: describe(i, t), table: t, id: i.id });
    });
  });
  if (soldNoCost.length)
    F('warn', 'P&L', soldNoCost.length + ' sold item(s) have no cost basis - profit math treats them as 100% margin.',
      'Edit each row and set the actual purchase cost.', soldNoCost);

  // 9. eBay freight backfill candidates
  const freightAlt = [];
  (DB.ebayPurchases || []).forEach(r => {
    if (parseFloat(r.freightSgd) > 0) return;
    if (_FREIGHT_ALT_KEYS && _FREIGHT_ALT_KEYS.some(k => r[k] != null && r[k] !== '' && parseFloat(r[k]) > 0)) {
      freightAlt.push({ label: describe(r,'ebayPurchases'), table: 'ebayPurchases', id: r.id });
    }
  });
  if (freightAlt.length)
    F('warn', 'eBay', freightAlt.length + ' eBay row(s) have freight stored under a legacy column (not freightSgd).',
      'Open the eBay tab - auto-backfill runs on render and will fix these next time you view the page.', freightAlt);

  // 10. Missing dateAcquired on sales that have an inventory link
  const missingDateAcq = [];
  (DB.sales || []).forEach(s => {
    if (s.dateAcquired) return;
    if (!s.inventoryId || !s.inventoryTable) return;
    missingDateAcq.push({ label: describe(s, 'sales'), table: 'sales', id: s.id });
  });
  if (missingDateAcq.length)
    F('info', 'Sales', missingDateAcq.length + ' sale(s) are missing dateAcquired (holding period unknown).',
      'Click "Backfill" to pull the acquisition date from the linked inventory row.', missingDateAcq);

  // Store the most-recent run so the modal can re-render after auto-fixes.
  window._lastHealthFindings = findings;
  _renderHealthResults(findings);
}

// Backfill dateAcquired + daysHeld for linked sales that are missing it.
function healthBackfillDateAcquired() {
  let n = 0;
  (DB.sales || []).forEach(s => {
    if (s.dateAcquired || !s.inventoryId || !s.inventoryTable) return;
    const srcRow = (DB[s.inventoryTable] || []).find(r => r.id === s.inventoryId);
    if (!srcRow) return;
    const da = toDateMmmYyyy(srcRow.datePurchased || srcRow.dateListed || srcRow.date || '') || '';
    if (!da) return;
    s.dateAcquired = da;
    const dh = _kjrDaysHeld(da, s.dateSold);
    if (dh !== null) s.daysHeld = dh;
    markDirty('sales', s.id);
    n++;
  });
  if (n > 0) { saveData(); toast('Backfilled dateAcquired on ' + n + ' sale(s)'); }
  else toast('Nothing to backfill');
  runHealthCheck();
}

// Bulk auto-fix: re-canonicalises every date field across the DB.
function healthFixDates(){
  let n = 0;
  const fix = (item, field, table) => {
    if (!item[field]) return;
    const canon = toDateMmmYyyy(item[field]);
    if (canon !== item[field]) { item[field] = canon; markDirty(table, item.id); n++; }
  };
  (DB.singles||[]).forEach(i => fix(i, 'datePurchased', 'singles'));
  (DB.slabs||[]).forEach(i => fix(i, 'dateListed', 'slabs'));
  (DB.sales||[]).forEach(i => fix(i, 'dateSold', 'sales'));
  (DB.ebayPurchases||[]).forEach(i => fix(i, 'date', 'ebayPurchases'));
  (DB.etbs||[]).forEach(i => fix(i, 'date', 'etbs'));
  (DB.boosterBoxes||[]).forEach(i => fix(i, 'date', 'boosterBoxes'));
  (DB.boosterPacks||[]).forEach(i => fix(i, 'date', 'boosterPacks'));
  saveData();
  toast('Canonicalised ' + n + ' date(s)');
  runHealthCheck();
}

// Navigate to a tab and focus the source row from a finding-detail click.
function healthGotoRow(table, id){
  // Close through the controller (not a bare remove) so the modal stack and
  // scroll lock are released before navigating; the close event removes it.
  const old = document.getElementById('health-overlay');
  if (old) { if (old.open) kjrModalCtrl.close(old, true); else old.remove(); }
  const navTo = table === 'singles' ? 'inventory' :
                table === 'slabs' ? 'slabs' :
                table === 'sales' ? 'sales' :
                table === 'ebayPurchases' ? 'ebay' :
                table === 'etbs' ? 'etbs' :
                table === 'boosterBoxes' ? 'boosterBoxes' :
                table === 'boosterPacks' ? 'boosterBoxes' : null;
  if (!navTo) return;
  showPage(navTo);
  // Try to highlight the row briefly.
  setTimeout(() => {
    const row = document.querySelector('tr[data-id="' + id + '"]');
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.style.transition = 'background 0.3s';
      const prev = row.style.background;
      row.style.background = 'var(--accent-soft)';
      setTimeout(() => { row.style.background = prev; }, 2000);
    }
  }, 200);
}

// Per-finding ignore list - stable fingerprint = severity + area + leading
// words of the message (so a finding that drops from "12 sale(s)…" to
// "8 sale(s)…" still matches and stays hidden). Persisted to localStorage
// so dismissals survive reloads.
const HEALTH_IGNORE_KEY = 'pokeinv_health_ignored';
function _healthFingerprint(f){
  const stem = (f.message||'').toLowerCase()
    .replace(/^\d+\s*/, '')                  // drop leading count
    .replace(/\b\d+\b/g, '#')                // collapse numerics
    .split('.')[0]                            // first sentence only
    .trim()
    .slice(0, 80);
  return f.sev + '|' + (f.area||'') + '|' + stem;
}
function _loadHealthIgnores(){
  try { return new Set(JSON.parse(localStorage.getItem(HEALTH_IGNORE_KEY)||'[]')); }
  catch(e) { return new Set(); }
}
function _saveHealthIgnores(set){
  try { localStorage.setItem(HEALTH_IGNORE_KEY, JSON.stringify([...set])); }
  catch(e) {}
}
function healthIgnoreFinding(fp){
  const set = _loadHealthIgnores();
  set.add(fp);
  _saveHealthIgnores(set);
  runHealthCheck(); // re-render without it
}
async function healthRestoreIgnored(){
  if (!await kjrConfirm('Restore all ignored findings? You\'ll see them again on the next run.', {ok:'Restore all'})) return;
  localStorage.removeItem(HEALTH_IGNORE_KEY);
  runHealthCheck();
}

function _renderHealthResults(findings){
  // The user has already accounted for any current warn-level issues (stock
  // was reconciled before porting), and individual findings can be dismissed
  // via the per-card Ignore button. Filter both here so the modal only shows
  // what the user actually needs to act on.
  const ignored = _loadHealthIgnores();
  const visibleFindings = findings.filter(f => f.sev !== 'warn' && !ignored.has(_healthFingerprint(f)));
  const fails = visibleFindings.filter(f => f.sev === 'fail');
  const infos = visibleFindings.filter(f => f.sev === 'info');
  // Track hidden counts purely for the footer chip - never rendered as
  // their own group.
  const hiddenWarnCount    = findings.filter(f => f.sev === 'warn').length;
  const hiddenIgnoredCount = findings.filter(f => f.sev !== 'warn' && ignored.has(_healthFingerprint(f))).length;
  const overall = fails.length > 0 ? 'red' : 'green';
  const overallText = fails.length > 0 ? 'Issues found - review below.' : 'All checks passed.';
  const overallIcon = overall === 'green' ? '✓' : '✕';
  const overallColor = overall === 'green' ? 'var(--green)' : 'var(--red)';

  // Toggle a finding's details panel open/closed.
  window._toggleHealthDetail = function(idx){
    const el = document.getElementById('health-detail-' + idx);
    const caret = document.getElementById('health-caret-' + idx);
    if (!el) return;
    const open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    if (caret) caret.textContent = open ? '▸' : '▾';
  };

  const renderDetails = (details, idx) => {
    if (!details || !details.length) return '';
    const MAX = 100;
    const shown = details.slice(0, MAX);
    return `<div id="health-detail-${idx}" style="display:none;margin-top:8px;background:var(--bg2);border:1px solid var(--border);border-radius:6px;max-height:240px;overflow-y:auto">
      ${shown.map(d => {
        const clickable = d.table && d.id;
        return `<div style="display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;line-height:1.4">
          <span style="flex:1;color:var(--text);word-break:break-word">${esc(d.label)}</span>
          ${clickable ? `<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 8px" onclick="healthGotoRow('${esc(d.table)}','${esc(d.id)}')">View ↗</button>` : ''}
        </div>`;
      }).join('')}
      ${details.length > MAX ? `<div style="padding:6px 10px;font-size:11px;color:var(--text3);text-align:center">…and ${details.length - MAX} more</div>` : ''}
    </div>`;
  };

  let cardIdx = 0;
  const renderGroup = (group, label, color) => {
    if (group.length === 0) return '';
    return `<div style="margin-top:16px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.6px;color:${color};margin-bottom:6px">${label} (${group.length})</div>` +
      group.map(f => {
        const idx = cardIdx++;
        const hasDetails = f.details && f.details.length > 0;
        // The "Auto-fix dates" finding gets an extra button.
        const isDateFinding = f.area === 'Dates' && f.details && f.details.length > 0;
        // The dateAcquired backfill finding gets its own button.
        const isDateAcqFinding = f.area === 'Sales' && f.message && f.message.includes('dateAcquired');
        const fp = _healthFingerprint(f).replace(/'/g, '&#39;');
        return `<div style="border:1px solid var(--border);border-left:3px solid ${color};border-radius:6px;padding:8px 10px;margin-bottom:6px;background:var(--bg3)">
          <div style="display:flex;align-items:flex-start;gap:8px">
            <div style="flex:1;min-width:0">
              <div style="font-size:11px;color:var(--text3);font-weight:600;margin-bottom:2px">${esc(f.area)}</div>
              <div style="font-size:13px;color:var(--text);line-height:1.5">${esc(f.message)}</div>
              ${f.fix ? `<div style="font-size:11px;color:var(--text2);margin-top:4px;line-height:1.5"><strong>Fix:</strong> ${esc(f.fix)}</div>` : ''}
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;align-items:flex-end">
              ${hasDetails ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px;white-space:nowrap" onclick="_toggleHealthDetail(${idx})">
                <span id="health-caret-${idx}">▸</span> ${f.details.length} item${f.details.length===1?'':'s'}
              </button>` : ''}
              <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px;color:var(--text3);white-space:nowrap" onclick="healthIgnoreFinding('${fp}')" title="Hide this finding from future runs">✕ Ignore</button>
            </div>
          </div>
          ${isDateFinding ? `<div style="margin-top:8px"><button class="btn btn-sm btn-primary" style="font-size:11px;padding:4px 10px" onclick="healthFixDates()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;vertical-align:-2px;margin-right:3px"><polygon points="13 2 3 14 11 14 10 22 21 10 13 10 13 2"/></svg>Auto-fix all dates</button></div>` : ''}
          ${isDateAcqFinding ? `<div style="margin-top:8px"><button class="btn btn-sm btn-primary" style="font-size:11px;padding:4px 10px" onclick="healthBackfillDateAcquired()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;vertical-align:-2px;margin-right:3px"><polygon points="13 2 3 14 11 14 10 22 21 10 13 10 13 2"/></svg>Backfill holding period</button></div>` : ''}
          ${renderDetails(f.details, idx)}
        </div>`;
      }).join('') + '</div>';
  };

  // Footer chip showing what was hidden + link to restore.
  const hiddenChips = [];
  if (hiddenWarnCount > 0)    hiddenChips.push(hiddenWarnCount + ' warn (always hidden)');
  if (hiddenIgnoredCount > 0) hiddenChips.push(hiddenIgnoredCount + ' ignored');
  const hiddenLine = hiddenChips.length
    ? `<div style="font-size:11px;color:var(--text3);margin-top:8px;padding:6px 10px;border-radius:6px;background:var(--bg3);display:flex;align-items:center;gap:8px">
        <span>${hiddenChips.join(' · ')} hidden from this view.</span>
        ${hiddenIgnoredCount > 0 ? '<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:2px 8px" onclick="healthRestoreIgnored()">↺ Restore ignored</button>' : ''}
       </div>`
    : '';

  let html = `<dialog id="health-overlay" class="overlay">
    <div class="modal" style="max-width:760px;max-height:85vh">
      <div class="modal-head">
        <h3 style="display:flex;align-items:center;gap:8px"><span style="color:${overallColor};font-size:18px">${overallIcon}</span> Data Health Check</h3>
        <button class="btn btn-ghost btn-sm" onclick="kjrModalCtrl.close(document.getElementById('health-overlay'), true)">✕</button>
      </div>
      <div class="modal-body">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-radius:8px;background:var(--bg3);border:1px solid var(--border)">
          <div>
            <div style="font-weight:600">${esc(overallText)}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">Run at ${new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})} · ${fails.length} fail · ${infos.length} info</div>
          </div>
          <div style="font-size:11px;color:var(--text3);text-align:right">
            ${(DB.singles||[]).length} singles · ${(DB.slabs||[]).length} slabs · ${(DB.sales||[]).length} sales<br>
            ${(DB.ebayPurchases||[]).length} ebay · ${(DB.etbs||[]).length} etbs · ${(DB.boosterBoxes||[]).length} boxes · ${(DB.boosterPacks||[]).length} packs
          </div>
        </div>
        ${(fails.length === 0 && infos.length === 0)
          ? `<div style="margin-top:16px;padding:16px;border:1px solid var(--green);border-radius:6px;background:var(--green-soft);color:var(--green);font-size:13px">✓ Nothing to act on right now.</div>`
          : ''}
        ${renderGroup(fails, '❌ Fail - fix before trusting totals', 'var(--red)')}
        ${renderGroup(infos, 'ℹ Info', 'var(--blue)')}
        ${hiddenLine}
      </div>
      <div class="modal-foot">
        <button class="btn" onclick="kjrModalCtrl.close(document.getElementById('health-overlay'), true)">Close</button>
        <button class="btn btn-primary" onclick="runHealthCheck()">⟳ Re-run</button>
      </div>
    </div>
  </dialog>`;
  // Close the previous instance through the controller first (Re-run reinjects
  // while the old dialog is still open) so the modal stack never holds a
  // detached node, then swap in the new one and open it properly - dialog +
  // kjrModalCtrl gives Esc, backdrop click, focus trap and scroll lock.
  const old = document.getElementById('health-overlay');
  if (old) { if (old.open && typeof kjrModalCtrl !== 'undefined') kjrModalCtrl.close(old, true); old.remove(); }
  document.body.insertAdjacentHTML('beforeend', html);
  const hEl = document.getElementById('health-overlay');
  hEl.addEventListener('close', () => hEl.remove(), { once: true });
  kjrModalCtrl.open(hEl);
}

// =========== NAV DROPDOWN ===========
function toggleNavDD(name, ev) {
  if (ev) { ev.stopPropagation(); ev.preventDefault(); }
  document.querySelectorAll('.nav-dd').forEach(d => {
    if (d.dataset.dd === name) d.classList.toggle('open');
    else d.classList.remove('open');
  });
}
function closeNavDD() {
  document.querySelectorAll('.nav-dd').forEach(d => d.classList.remove('open'));
}
document.addEventListener('click', e => {
  if (!e.target.closest('.nav-dd')) closeNavDD();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeNavDD(); });

// =========== SORT STATE ===========
const sortState = {
  singles: { col: null, dir: 1 },
  slabs:   { col: null, dir: 1 },
  sales:   { col: null, dir: 1 }
};

function sortTable(table, col) {
  const s = sortState[table];
  if (s.col === col) { s.dir *= -1; } else { s.col = col; s.dir = 1; }
  if (table === 'singles') renderSingles();
  if (table === 'slabs') renderSlabs();
  if (table === 'sales') renderSales();
}

function applySortHeaders(tableId, table) {
  const s = sortState[table];
  document.querySelectorAll('#' + tableId + ' thead tr:first-child th.sortable').forEach(th => {
    th.classList.remove('sort-asc','sort-desc');
    th.removeAttribute('aria-sort');
    if (th.getAttribute('onclick') && th.getAttribute('onclick').includes("'" + s.col + "'")) {
      const dir = s.dir === 1 ? 'sort-asc' : 'sort-desc';
      th.classList.add(dir);
      th.setAttribute('aria-sort', s.dir === 1 ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  });
}

// Date columns across the whole app - sort these chronologically via dateToMs
// instead of lexicographically, otherwise "31 Aug 2025" sorts after "30 Oct
// 2025" because '8' < 'O' is meaningless.
const _DATE_COLS = new Set(['dateSold','datePurchased','dateListed','date','receivedAt']);
// Pure-numeric columns where we want strict numeric ordering even when some
// rows have non-numeric junk (e.g. "-") in the cell.
const _NUM_COLS  = new Set(['costPrice','marketPrice','listPrice','qty','priceAlert',
                            'totalCollected','shippingCost','profit','margin',
                            'totalPrice','unitPrice','priceUsd','freightSgd','totalSgd',
                            'grade']);

// Default sort when the user hasn't picked a column.
// Singles and Slabs default to most-recently-added first.
// Sales defaults to most-recently-sold first.
const _DEFAULT_SORT_COL = { singles: 'datePurchased', slabs: 'dateListed', sales: 'dateSold' };

function sortItems(items, table) {
  const s = sortState[table];
  const col = s.col || _DEFAULT_SORT_COL[table];
  if (!col) return items;
  // Default direction is descending for all date-defaulted tables so the
  // most recent entries appear at the top without requiring a header click.
  const dir = s.col ? s.dir : -1;
  // Numbers/words containing leading digits should land at the BOTTOM when
  // sorting alphabetically (so "Charizard" comes before "100-card lot").
  const startsWithDigit = v => /^[\s$]*-?\d/.test(String(v||''));
  // Helper: effective market value. Sorting must use the same effective
  // number the user sees in the cell (explicit marketPrice, else cost as a
  // last resort), or unpriced rows get incorrectly pushed to the bottom and
  // the column appears not to sort.
  const effectiveMarket = (i) => {
    const m = parseFloat(i.marketPrice);
    if (!isNaN(m) && m > 0) return m;
    return NaN;
  };
  return [...items].sort((a, b) => {
    // Special-case marketPrice: use the effective value (manual override OR
    // cached lookup). All other columns read directly from the row.
    let av, bv;
    if (col === 'marketPrice') {
      av = effectiveMarket(a); bv = effectiveMarket(b);
      // For marketPrice, "empty" means truly no value anywhere - neither
      // a manual price nor a cached one. NaN here = no signal.
      const aEmpty = isNaN(av);
      const bEmpty = isNaN(bv);
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1;
      if (bEmpty) return -1;
      return (av - bv) * dir;
    }
    // Grade sort on slabs must use the resolved canonical grade, not the raw
    // field. Rows where the grade is stored in the grader field (e.g.
    // grader="PSA 10", grade="") have grade="" which parseFloat turns into NaN,
    // dumping those rows to the bottom regardless of their actual grade.
    if (col === 'grade' && table === 'slabs' && typeof _resolveGrader === 'function') {
      av = _resolveGrader(a.grader, a.grade).grade;
      bv = _resolveGrader(b.grader, b.grade).grade;
    } else {
      av = a[col]; bv = b[col];
    }
    // Null/empty values sort to the end regardless of direction so a click
    // doesn't bury real data under blanks.
    const aEmpty = (av == null || av === '');
    const bEmpty = (bv == null || bv === '');
    if (aEmpty && bEmpty) return 0;
    if (aEmpty) return 1;
    if (bEmpty) return -1;
    if (_DATE_COLS.has(col)) {
      const ma = dateToMs(av), mb = dateToMs(bv);
      if (ma === 0 && mb === 0) return 0;
      if (ma === 0) return 1; if (mb === 0) return -1;
      return (ma - mb) * dir;
    }
    if (_NUM_COLS.has(col)) {
      const an = parseFloat(av), bn = parseFloat(bv);
      if (isNaN(an) && isNaN(bn)) return 0;
      if (isNaN(an)) return 1; if (isNaN(bn)) return -1;
      return (an - bn) * dir;
    }
    // Text columns: push digit-prefixed names to the bottom on ascending sort,
    // then locale-compare with numeric option so "Mew 10" comes after "Mew 2".
    if (!s.col) {
      const ad = startsWithDigit(av), bd = startsWithDigit(bv);
      if (ad !== bd) return ad ? 1 : -1;
    }
    const an = parseFloat(av), bn = parseFloat(bv);
    if (!isNaN(an) && !isNaN(bn) && /^-?\d+(\.\d+)?$/.test(String(av).trim()) && /^-?\d+(\.\d+)?$/.test(String(bv).trim())) {
      return (an - bn) * dir;
    }
    return String(av).toLowerCase().localeCompare(String(bv).toLowerCase(), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
}

function colFilter(id) { return (document.getElementById(id)?.value||'').toLowerCase(); }

// Per-table filter input ids: search + column-filter boxes + dropdown selects.
// status defaults to 'available' (not counted as an active filter).
const _FILTER_INPUTS = {
  singles: { search:'singles-search', cols:['sf-name','sf-cost','sf-mkt','sf-list','sf-lang','sf-type','sf-date'],
             sels:['singles-lang','singles-type'], statusSel:'singles-status-filter' },
  slabs:   { search:'slabs-search', cols:['slbf-name','slbf-cost','slbf-mkt','slbf-list','slbf-grade','slbf-cert','slbf-rank','slbf-lang','slbf-date'],
             sels:['slabs-grader','slabs-grade'], statusSel:null },
  sales:   { search:'sales-search', cols:['slf-date','slf-product','slf-buyer'], sels:[], statusSel:null }
};
function _hasActiveFilters(table) {
  const cfg = _FILTER_INPUTS[table];
  if (!cfg) return false;
  if ((document.getElementById(cfg.search)?.value||'').trim()) return true;
  if (cfg.cols.some(id => (document.getElementById(id)?.value||'').trim())) return true;
  if (cfg.sels.some(id => (document.getElementById(id)?.value||'').trim())) return true;
  if (cfg.statusSel) { const v = document.getElementById(cfg.statusSel)?.value; if (v && v !== 'available') return true; }
  return false;
}
function updateClearFiltersBtn(table) {
  const btn = document.getElementById('clear-filters-' + table);
  if (btn) btn.style.display = _hasActiveFilters(table) ? '' : 'none';
}
function clearAllFilters(table) {
  const cfg = _FILTER_INPUTS[table];
  if (!cfg) return;
  const s = document.getElementById(cfg.search); if (s) s.value = '';
  cfg.cols.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  cfg.sels.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  if (cfg.statusSel) { const el = document.getElementById(cfg.statusSel); if (el) el.value = 'available'; }
  const render = table === 'singles' ? renderSingles : table === 'slabs' ? renderSlabs : renderSales;
  render();
}

// Inline-edit keyboard behaviour (delegated, survives re-renders):
//   • on focus: remember the original value so Escape can revert
//   • Enter: commit by blurring (fires the existing onchange)
//   • Escape: restore original value and blur without committing
document.addEventListener('focusin', e => {
  const el = e.target;
  if (el && el.classList && el.classList.contains('kjr-inline')) el.dataset.kjrOrig = el.value;
});
document.addEventListener('keydown', e => {
  const el = e.target;
  if (!el || !el.classList || !el.classList.contains('kjr-inline')) return;
  if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
  else if (e.key === 'Escape') {
    e.preventDefault();
    if (el.dataset.kjrOrig !== undefined) el.value = el.dataset.kjrOrig;
    el._kjrReverting = true;
    el.blur();
    el._kjrReverting = false;
  }
});

// =========== NAVIGATION ===========
let _kjrCurrentPage = null; // tracks the active tab so we only scroll-reset on an actual switch, never on a same-page re-render
function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn, .btb-item, .nav-dd-item').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.nav-dd').forEach(d => d.classList.remove('contains-active'));
  const pageEl = document.getElementById('page-' + name);
  if (pageEl) pageEl.classList.add('active');
  if (name !== _kjrCurrentPage) { window.scrollTo(0, 0); _kjrCurrentPage = name; }
  // Find the nav button or dropdown item whose onclick references this page
  // name and mark it (and its parent dropdown trigger) active.
  document.querySelectorAll('.nav-btn, .btb-item, .nav-dd-item').forEach(b => {
    const oc = b.getAttribute('onclick') || '';
    if (oc.indexOf("'" + name + "'") !== -1 || oc.indexOf('"' + name + '"') !== -1) {
      b.classList.add('active');
      const parentDD = b.closest('.nav-dd');
      if (parentDD) parentDD.classList.add('contains-active');
    }
  });
  if (name === 'inventory') { renderSingles(); applyColOrder('singles'); applyColVisibility('singles'); attachHeaderDrag('singles'); }
  if (name === 'slabs') { renderSlabs(); applyColOrder('slabs'); applyColVisibility('slabs'); attachHeaderDrag('slabs'); }
  if (name === 'sales') { renderSales(); applyColOrder('sales'); applyColVisibility('sales'); attachHeaderDrag('sales'); }
  if (name === 'dashboard') { renderDashboard(); setTimeout(() => { initCustomChartBuilder(); renderAllSavedCharts(); }, 150); }
  if (name === 'etbs'         && typeof renderEtbs === 'function')          renderEtbs();
  if (name === 'boosterBoxes' && typeof renderBoosterBoxes === 'function')  renderBoosterBoxes();
  if (name === 'boosterPacks' && typeof renderBoosterPacks === 'function')  renderBoosterPacks();
  if (name === 'ebay'         && typeof renderEbayPurchases === 'function') renderEbayPurchases();
  if (name === 'listing') populateListingSelect();
  if (name === 'changelog') renderChangelog();
  if (name === 'trash') { renderTrash(); purgeExpiredTrash(); }
  syncMoreActive(name);
}

// ── MORE SHEET (mobile nav hub) ──────────────────────────────
// Pages that live behind the bottom bar's "More" button rather than a
// dedicated tab. When one of these is active we light up the More item.
const MORE_PAGES = new Set(['listing','etbs','boosterBoxes','boosterPacks','import','changelog','trash','guide']);
function syncMoreActive(name) {
  const moreBtn = document.getElementById('btb-more');
  if (moreBtn) moreBtn.classList.toggle('active', MORE_PAGES.has(name));
  document.querySelectorAll('#more-sheet .sheet-item[data-page]').forEach(b =>
    b.classList.toggle('active', b.getAttribute('data-page') === name));
}
function openMoreSheet() { kjrApplyTableMode(); kjrModalCtrl.open(document.getElementById('more-sheet-overlay')); }
function closeMoreSheet() { kjrModalCtrl.close(document.getElementById('more-sheet-overlay')); }
function moreGo(page) { closeMoreSheet(); showPage(page); }

// ── Mobile UX: tap backdrop to close standard modals, and lift inputs above
// the on-screen keyboard when they receive focus. ──────────────
document.addEventListener('focusin', function(e) {
  if (!window.matchMedia('(max-width:768px)').matches) return;
  const t = e.target;
  if (t && t.matches && t.matches('input,select,textarea')) {
    // Wait for the keyboard to animate in, then centre the field.
    setTimeout(() => { try { t.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch(_){} }, 300);
  }
});

// iOS keyboard dismiss can leave the visual viewport reporting a stale offset,
// which is what displaces top-layer sheet dialogs upward off-screen. Re-anchor
// scroll once the viewport settles (debounced so it fires once, after resize noise stops).
if (window.visualViewport) {
  let _kjrVvT;
  window.visualViewport.addEventListener('resize', () => {
    clearTimeout(_kjrVvT);
    _kjrVvT = setTimeout(() => {
      const ae = document.activeElement;
      if (!ae || !ae.matches || !ae.matches('input,select,textarea')) window.scrollTo(window.scrollX, window.scrollY);
    }, 250);
  });
}

// ── Tier 5: card-view labelling + layout toggle ─────────────────
// The phone card view (CSS) shows each cell as "Label: value". The label is
// pulled from the matching <th> into a data-label attribute so it stays in
// sync with header renames and column changes. A MutationObserver re-labels
// whenever a tbody re-renders (innerHTML swap).
function kjrLabelCells(table) {
  const head = table.querySelector('thead');
  if (!head) return;
  const map = {};
  // First header row holds the human labels (the second row is filter inputs).
  head.querySelectorAll('tr:first-child th[data-col-key]').forEach(th => {
    const key = th.getAttribute('data-col-key');
    const txt = (th.textContent || '').trim();
    if (key && txt) map[key] = txt;
  });
  table.querySelectorAll('tbody td[data-col-key]').forEach(td => {
    const lbl = map[td.getAttribute('data-col-key')];
    if (lbl) td.setAttribute('data-label', lbl);
  });
}
function kjrInitCardLabels() {
  document.querySelectorAll('.page .tbl-wrap > table').forEach(table => {
    kjrLabelCells(table);
    table.querySelectorAll('tbody').forEach(tb => {
      new MutationObserver(() => kjrLabelCells(table)).observe(tb, { childList: true });
    });
  });
}
// Per-device override: force the classic table layout instead of cards.
const KJR_TABLEMODE_KEY = 'kjr_force_tables';
function kjrApplyTableMode() {
  const force = localStorage.getItem(KJR_TABLEMODE_KEY) === '1';
  document.body.classList.toggle('force-tables', force);
  const lbl = document.getElementById('more-layout-label');
  if (lbl) lbl.textContent = force ? 'Layout: Tables' : 'Layout: Cards';
}
function kjrToggleTableMode() {
  const force = localStorage.getItem(KJR_TABLEMODE_KEY) === '1';
  localStorage.setItem(KJR_TABLEMODE_KEY, force ? '0' : '1');
  kjrApplyTableMode();
}
// Tap a row's title cell to edit - only in the phone compact-table view, where
// the per-row action buttons are hidden. One delegated listener serves every
// tab by reusing the row's own Edit button (which already opens the correct
// modal), so there is no per-table wiring. No-ops on desktop and in full-table
// mode, and ignores taps on inputs / links inside the cell.
(function kjrInstallCompactTapEdit() {
  if (window._kjrTapEditInstalled) return;
  window._kjrTapEditInstalled = true;
  document.addEventListener('click', function (e) {
    if (!window.matchMedia || !matchMedia('(max-width:600px)').matches) return;
    if (document.body.classList.contains('force-tables')) return;
    const cell = e.target.closest('td[data-col-key="name"], td[data-col-key="product"]');
    if (!cell || !cell.closest('.page .tbl-wrap')) return;
    if (e.target.closest('input,button,a,select,textarea,label')) return;
    const tr = cell.closest('tr');
    if (!tr) return;
    const editBtn = [...tr.querySelectorAll('td[data-col-key="actions"] button')]
      .find(b => /edit/i.test(b.getAttribute('title') || '') || /edit/i.test(b.textContent || ''));
    if (editBtn) { e.preventDefault(); editBtn.click(); }
  });
})();
// Turn a short <select> into a mobile segmented control. The select stays as
// the value holder (hidden on mobile); the buttons proxy to it and fire the
// select's existing change handler, so no render logic changes.
function kjrSegmentize(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel || sel._segmentized) return;
  // A .seg may already exist from a deployed DOM snapshot ("Push to GitHub"
  // bakes the live DOM, but event listeners do NOT survive serialization, so
  // those baked-in buttons are dead and untappable). Remove the stale one and
  // rebuild it with working click handlers instead of bailing out.
  if (sel.nextElementSibling && sel.nextElementSibling.classList.contains('seg')) {
    sel.nextElementSibling.remove();
  }
  sel.classList.add('seg-source');
  const seg = document.createElement('div');
  seg.className = 'seg';
  seg.setAttribute('role', 'tablist');
  const build = () => {
    seg.innerHTML = '';
    [...sel.options].forEach(opt => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg-btn' + (opt.value === sel.value ? ' active' : '');
      b.textContent = opt.textContent;
      b.addEventListener('click', () => {
        if (sel.value === opt.value) return;
        sel.value = opt.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      seg.appendChild(b);
    });
  };
  build();
  sel.insertAdjacentElement('afterend', seg);
  sel.addEventListener('change', build); // keep buttons in sync with the select
  sel._segmentized = true;
}

// Wire up once the whole DOM is parsed - some tables (ETBs, Boxes, Packs,
// eBay) live further down the document than this script.
// ---- Touch tooltips ----------------------------------------------------
// On touch devices there is no hover, so the app's ~100 title="" hints never
// appear. This surfaces the title of a long-pressed element in a floating
// bubble. A normal tap is untouched, so buttons still fire as usual.
function kjrInitTouchTips() {
  if (!window.matchMedia || !matchMedia('(hover: none)').matches) return;
  if (kjrInitTouchTips._done) return;
  kjrInitTouchTips._done = true;

  let bubble = null, timer = null, startX = 0, startY = 0, swallow = false;

  function hide() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (bubble) { bubble.classList.remove('show'); }
  }
  function show(el, x, y) {
    const text = el.getAttribute('title');
    if (!text) return;
    if (!bubble) { bubble = document.createElement('div'); bubble.className = 'touch-tip'; document.body.appendChild(bubble); }
    bubble.textContent = text;
    bubble.classList.add('show');
    // Position above the press point, clamped to the viewport.
    const r = bubble.getBoundingClientRect();
    let left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8);
    let top = y - r.height - 14;
    if (top < 8) top = y + 18; // not enough room above → drop below
    bubble.style.left = left + 'px';
    bubble.style.top = top + 'px';
    swallow = true;
    setTimeout(() => bubble && bubble.classList.remove('show'), 3000);
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const el = e.target.closest('[title]');
    if (!el || !el.getAttribute('title')) return;
    startX = e.clientX; startY = e.clientY; swallow = false;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => show(el, startX, startY), 450);
  }, true);

  document.addEventListener('pointermove', (e) => {
    if (timer && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) {
      clearTimeout(timer); timer = null;
    }
  }, true);

  document.addEventListener('pointerup', () => { if (timer) { clearTimeout(timer); timer = null; } }, true);
  document.addEventListener('pointercancel', hide, true);

  // After a long-press, swallow the click that the browser fires so the
  // element's action does not also run (the user meant "inspect", not "tap").
  document.addEventListener('click', (e) => {
    if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); }
  }, true);

  // Tap elsewhere or scroll dismisses the bubble.
  document.addEventListener('scroll', hide, true);
}

function kjrInitMobileShell() {
  kjrInitCardLabels();
  kjrApplyTableMode();
  // Short, clearly-exclusive filters → segmented controls (≤4 options).
  // Note: dash-range stays a native dropdown - its 4 long labels ("Last 12
  // months" etc.) overflow a single-row segmented control on phones.
  ['singles-lang', 'singles-status-filter', 'singles-type', 'slabs-grader'].forEach(kjrSegmentize);
  kjrInitTouchTips();
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', kjrInitMobileShell);
} else {
  kjrInitMobileShell();
}

// =========== KPI / STAT TOOLTIPS (touch parity) ===========
// .metric-info and .metric-trust tooltips rely on :hover in CSS, which is
// unreachable on touch. Tap toggles an .open class (CSS mirrors :hover with
// .open), and a document-level click-away listener closes any open one.
function kjrToggleTooltip(btn, e) {
  if (e) e.stopPropagation();
  const wasOpen = btn.classList.contains('open');
  document.querySelectorAll('.metric-info.open,.metric-trust.open').forEach(b => { if (b !== btn) b.classList.remove('open'); });
  btn.classList.toggle('open', !wasOpen);
}
document.addEventListener('click', function(e) {
  if (e.target.closest && e.target.closest('.metric-info,.metric-trust')) return;
  document.querySelectorAll('.metric-info.open,.metric-trust.open').forEach(b => b.classList.remove('open'));
});

// =========== TOAST ===========
let toastTimer;
function toastDismiss() {
  const t = document.getElementById('toast');
  if (!t) return;
  clearTimeout(toastTimer);
  t.classList.remove('show');
  if (t.hidePopover && t.matches(':popover-open')) { try { t.hidePopover(); } catch(e){} }
  setTimeout(() => t.classList.remove('toast-error','toast-warn'), 300);
}
function toast(msg, dur=2800, isError=false) {
  const t    = document.getElementById('toast');
  if (!t) return;
  const icon = document.getElementById('toast-icon');
  const msgEl= document.getElementById('toast-msg');
  const bar  = document.getElementById('toast-bar');
  const isWarn = !isError && typeof msg === 'string' && msg.startsWith('⚠');
  // Strip leading warning glyph so it doesn't appear twice
  const displayMsg = isWarn ? msg.replace(/^⚠\s*/, '') : msg;
  t.classList.remove('toast-error','toast-warn');
  if (isError) {
    t.classList.add('toast-error');
    if (icon) { icon.textContent = '✕'; icon.style.color = 'var(--red)'; }
  } else if (isWarn) {
    t.classList.add('toast-warn');
    if (icon) { icon.textContent = '⚠'; icon.style.color = '#f59e0b'; }
  } else {
    if (icon) { icon.textContent = '✓'; icon.style.color = 'var(--accent)'; }
  }
  if (msgEl) msgEl.textContent = displayMsg;
  // Reset progress bar before animating
  if (bar) {
    bar.style.transition = 'none';
    bar.style.transform  = 'scaleX(1)';
  }
  t.classList.add('show');
  if (t.showPopover && !t.matches(':popover-open')) { try { t.showPopover(); } catch(e){} }
  clearTimeout(toastTimer);
  // Double-rAF lets the reset paint before the animation starts
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!bar) return;
    const d = isError ? 6000 : dur;
    bar.style.transition = 'transform ' + d + 'ms linear';
    bar.style.transform  = 'scaleX(0)';
  }));
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    if (t.hidePopover && t.matches(':popover-open')) { try { t.hidePopover(); } catch(e){} }
    setTimeout(() => t.classList.remove('toast-error','toast-warn'), 300);
  }, isError ? 6000 : dur);
}
function toastError(msg) { toast(msg, 6000, true); }

// =========== MODALS ===========
function openModal(id) {
  const el = document.getElementById(id);
  if (el && el.tagName === 'DIALOG') kjrModalCtrl.open(el);
  else if (el) el.classList.add('open');
}
// force=true skips the unsaved-changes prompt even if the dialog is dirty -
// pass it from save handlers, which have just persisted the data for real.
function closeModal(id, force) {
  const el = document.getElementById(id);
  if (el && el.tagName === 'DIALOG') kjrModalCtrl.close(el, force);
  else if (el) el.classList.remove('open');
}
document.querySelectorAll('.overlay').forEach(o => {
  if (o.tagName !== 'DIALOG') o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});

// =========== HELPERS ===========
function fmt(n, dec=0) {
  if (n === '' || n === null || n === undefined || isNaN(parseFloat(n))) return '-';
  return 'S$' + parseFloat(n).toFixed(dec);
}
// Format a signed currency amount as "+S$12" / "-S$12" / "S$0" (sign before currency symbol).
function fmtSigned(n, dec=0) {
  const v = parseFloat(n);
  if (isNaN(v)) return '-';
  const sign = v > 0 ? '+' : (v < 0 ? '-' : '');
  return sign + 'S$' + Math.abs(v).toFixed(dec);
}
// HTML-escape a value before inserting into innerHTML. Use everywhere user/Supabase
// strings are concatenated into HTML - prevents XSS via card names, notes, buyers, etc.
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function pnlHtml(cost, market) {
  const c = parseFloat(cost), m = parseFloat(market);
  if (isNaN(c) || isNaN(m) || !c || !m) return '<span style="color:var(--text3)">-</span>';
  const diff = m - c, pct = ((diff/c)*100).toFixed(0);
  const cls = diff >= 0 ? 'pos' : 'neg';
  const pctSign = diff > 0 ? '+' : (diff < 0 ? '-' : '');
  return '<span class="' + cls + '">' + fmtSigned(diff) + ' (' + pctSign + Math.abs(parseFloat(pct)) + '%)</span>';
}
function graderBadge(grader, grade, notes) {
  const g = (grader||'').toUpperCase();
  const cls = g === 'TAG' ? 'b-tag' : g === 'PSA' ? 'b-psa' : g === 'CGC' ? 'b-cgc' : 'b-slab';
  const pr = (notes||'').includes('PRISTINE') ? ' P' : '';
  return '<span class="badge ' + cls + '">' + g + ' ' + (grade||'').trim() + pr + '</span>';
}

// ═════════════ GRADER/GRADE RESOLVER ═════════════════════════════════
// Single source of truth for interpreting slab grader + grade values.
// Real-world data has the same logical "PSA 10" stored as ANY of:
//   { grader: "PSA",      grade: "10"      }   ← canonical
//   { grader: "psa",      grade: "10"      }
//   { grader: " PSA  ",   grade: "10 "     }
//   { grader: "PSA 10",   grade: ""        }   ← grader carries both
//   { grader: "",         grade: "PSA 10"  }   ← grade carries both
//   { grader: "PSA10",    grade: ""        }   ← no separator
//   { grader: "psa 10 pristine", grade: "" }   ← modifiers attached
// All of those should render the same red "PSA 10" badge and match the
// PSA grader filter. Every grader-aware code path must go through this
// resolver so the rules live in one place.
const _CANONICAL_GRADERS = ['PSA','CGC','TAG','ACE','BGS','SGC'];
function _resolveGrader(grader, grade, extraText) {
  // 1. Combine all signal sources. extraText is optional - pass `notes` or
  //    `name` to pick up Pristine markers stored outside grader/grade.
  const blob = ((grader||'').toString() + ' ' +
                (grade ||'').toString() + ' ' +
                (extraText||'').toString()).toUpperCase();
  // 2. Pick the first canonical grader code that appears anywhere in the blob.
  let canonGrader = '';
  for (const g of _CANONICAL_GRADERS) {
    if (new RegExp('\\b' + g + '\\b').test(blob) || blob.includes(g)) { canonGrader = g; break; }
  }
  // 3. Extract numeric grade - order matters so "10" wins over "1".
  const gradeM = blob.match(/\b(10\b|9\.5|9\b|8\.5|8\b|7\b|6\.5|6\b|5\.5|5\b|4\b|3\b|2\b|1\b)/);
  const canonGrade = gradeM ? gradeM[1] : '';
  // 4. Pristine modifier - awarded by TAG, CGC, and BGS as a top-tier
  //    subgrade on 10s. (PSA does NOT use "Pristine" - Gem Mint 10 is
  //    their top grade with no subgrade.) Recognise "Pristine" written
  //    out plus the common shorthand " P" / "P10" next to a TAG/CGC/BGS 10.
  //    Restricted to those graders + grade 10 to prevent false positives
  //    from a stray " P" in a card name like "Pikachu V".
  const PRISTINE_GRADERS = new Set(['TAG','CGC','BGS']);
  const isPristine =
    /\bPRISTINE\b/.test(blob) ||
    (PRISTINE_GRADERS.has(canonGrader) && canonGrade === '10' && /\bP\b/.test(blob));
  return {
    grader:   canonGrader,
    grade:    canonGrade,
    pristine: isPristine && PRISTINE_GRADERS.has(canonGrader) && canonGrade === '10',
    raw:      { grader, grade }
  };
}
function _graderClass(canonGrader) {
  if (canonGrader === 'TAG') return 'b-tag';
  if (canonGrader === 'PSA') return 'b-psa';
  if (canonGrader === 'CGC') return 'b-cgc';
  return 'b-slab';
}

function graderGradeBadge(grader, grade, notes) {
  // Pass notes as extraText so Pristine markers stored in notes are caught.
  const r = _resolveGrader(grader, grade, notes);
  // Pristine gets its OWN class (gold gradient). Otherwise use the standard
  // PSA/CGC/TAG colour. Pristine badges show a small ★ before the grade so
  // they're instantly distinguishable from regular PSA 10s in the table.
  const cls = r.pristine ? 'b-pristine' : _graderClass(r.grader);
  const displayGrader = r.grader || ((grader||'').toString().trim().toUpperCase()) || '?';
  const displayGrade  = r.grade  || ((grade ||'').toString().trim()) || '?';
  const pristineMark  = r.pristine ? ' ★' : '';
  const title         = r.pristine ? ' title="' + (r.grader || 'Slab') + ' Pristine 10 - top-pop subgrade"' : '';
  return '<span class="badge ' + cls + '"' + title + ' style="font-size:13px;font-weight:600;letter-spacing:0.2px;padding:3px 10px">' +
    displayGrader + ' ' + displayGrade + pristineMark + '</span>';
}

// =========== SINGLES ===========
function _parseHistDate(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return new Date(dateStr + 'T00:00:00');
  const now = new Date();
  let d = new Date(dateStr + ' ' + now.getFullYear());
  if (isNaN(d.getTime())) return null;
  if (d > now) d = new Date(dateStr + ' ' + (now.getFullYear() - 1));
  return isNaN(d.getTime()) ? null : d;
}

function _mktFreshDot(item) {
  const hist = Array.isArray(item.priceHistory) ? item.priceHistory : [];
  if (!hist.length || !item.marketPrice) return '';
  const last = hist[hist.length - 1];
  const d = _parseHistDate(last && last.date);
  // A 'low' confidence entry (PPT's base-name fallback fired, no card number
  // matched) is always shown amber regardless of age - the number could be
  // stale AND wrong, so age-based green never applies to a fuzzy match.
  const isLow = last && last.confidence === 'low';
  if (!d) return '<span style="width:6px;height:6px;border-radius:50%;background:#444;display:inline-block;margin-left:4px;vertical-align:middle;flex-shrink:0" title="Price age unknown"></span>';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const color = isLow ? '#f59e0b' : (days <= 30 ? '#22c55e' : days <= 90 ? '#f59e0b' : '#ef4444');
  const ago = days === 0 ? 'today' : days === 1 ? '1 day ago' : days + ' days ago';
  const sourceNote = last.source ? (' · ' + last.source) : '';
  const confNote = last.confidence ? (' · ' + last.confidence + ' confidence') : '';
  const lowNote = isLow ? ' · approx, fuzzy match' : '';
  return '<span style="width:6px;height:6px;border-radius:50%;background:' + color + ';display:inline-block;margin-left:4px;vertical-align:middle;flex-shrink:0;cursor:help" title="Refreshed ' + (last.date||'') + ' (' + ago + ')' + sourceNote + confNote + lowNote + '"></span>';
}

// Explain WHY a market cell is empty, for the <td title="..."> on an unpriced
// row. English-only auto-pricing (see _queueLaneFor): a non-EN raw single
// (JP/CN/ID/KR/...) is manual by product design, not a per-card data problem -
// distinct from an EN "unresolved" card, which the user CAN fix by adding
// the card number, fixing it, or setting a TCGdex ID override. Slabs are
// always PPT-lane regardless of language (they have a grader, TCGdex has no
// graded prices at all - the language rule doesn't apply to them), so a
// non-EN slab never gets the manual-language title, only raw singles do.
function _mktEmptyCellTitle(item) {
  if (item.marketPrice) return ''; // has a price, no explanation needed
  const isSlab = !!item.grader;
  const lang = (item.language||'EN').toString().trim().toUpperCase();
  const isEnglish = lang === 'EN' || lang === '';
  if (!isSlab && !isEnglish) return 'Manual price, no free source for this language';
  if (!isSlab && !item.tcgdexId) {
    const hasNameAndNumber = !!(_baseCardName(item.name) && _tcgdexNumber(item.name));
    if (!hasNameAndNumber || item._tcgdexMissDate) return 'Add or fix the card number for exact pricing';
  }
  return '';
}

// Returns a freshness dot for the Market Price KPI card, based on the oldest
// price refresh among all items that have one. Shows green/yellow/red.
function _statMktFreshDot(items) {
  let oldest = null;
  (items || []).forEach(i => {
    const hist = Array.isArray(i.priceHistory) ? i.priceHistory : [];
    if (!hist.length || !i.marketPrice) return;
    const d = _parseHistDate(hist[hist.length - 1]?.date);
    if (d && (!oldest || d < oldest)) oldest = d;
  });
  if (!oldest) return '';
  const days = Math.floor((Date.now() - oldest.getTime()) / 86400000);
  const color = days <= 30 ? '#22c55e' : days <= 90 ? '#f59e0b' : '#ef4444';
  const ago = days === 0 ? 'today' : days === 1 ? '1 day ago' : days + ' days ago';
  return '<span style="width:7px;height:7px;border-radius:50%;background:' + color + ';display:inline-block;margin-left:6px;vertical-align:middle;cursor:help" title="Oldest refresh: ' + ago + '"></span>';
}

// Shared inventory empty-state row. When the table is genuinely empty (no
// filter active) it shows a CTA to add the first card. When a filter hides
// everything, it shows a neutral "no matches" message with no CTA.
function kjrInvEmptyRow(opts) {
  const { colspan, filtered, icon, title, sub, ctaLabel, ctaAction } = opts;
  if (filtered) {
    return '<tr><td colspan="' + colspan + '">' +
      '<div class="hig-empty"><div class="hig-empty-icon">🔍</div>' +
      '<div class="hig-empty-title">No matches</div>' +
      '<div class="hig-empty-sub">Nothing matches the current search or filters. Clear them to see everything.</div>' +
      '</div></td></tr>';
  }
  return '<tr><td colspan="' + colspan + '">' +
    '<div class="hig-empty"><div class="hig-empty-icon">' + icon + '</div>' +
    '<div class="hig-empty-title">' + title + '</div>' +
    '<div class="hig-empty-sub">' + sub + '</div>' +
    '<div class="hig-empty-action"><button class="btn btn-primary" onclick="' + ctaAction + '">' + ctaLabel + '</button></div>' +
    '</div></td></tr>';
}

// Session-only dismiss for the unresolved-cards banner - a fresh page load
// (or hard refresh) shows it again, but re-rendering the table after any
// edit/filter change within the same session shouldn't keep re-surfacing it
// once the user has acknowledged it. Deliberately NOT persisted to
// localStorage: this is a transient nudge, not a permanent setting, and a
// newly-added unresolved card later in the session should still be visible
// next time the banner state is recomputed (sessionStorage would carry a
// stale dismiss across an unrelated reload of the same tab; the in-memory
// flag resets whenever the page reloads, which is exactly the desired reset
// point since fresh unresolved counts are worth re-surfacing then).
let _kjrUnresolvedBannerDismissed = false;
function _dismissUnresolvedBanner() {
  _kjrUnresolvedBannerDismissed = true;
  const el = document.getElementById('singles-unresolved-banner');
  if (el) el.classList.remove('show');
}
function _renderUnresolvedBanner() {
  const el = document.getElementById('singles-unresolved-banner');
  if (!el) return;
  const n = (typeof _kjrUnresolvedSingles === 'function') ? _kjrUnresolvedSingles().length : 0;
  if (n === 0 || _kjrUnresolvedBannerDismissed) { el.classList.remove('show'); return; }
  document.getElementById('singles-unresolved-text').textContent =
    n + ' card' + (n!==1?'s':'') + ' could not be matched automatically. Open a card and add its set code and number, or a TCGdex ID, for exact pricing.';
  el.classList.add('show');
}

function renderSingles() {
  _renderUnresolvedBanner();
  const q = (document.getElementById('singles-search').value||'').toLowerCase();
  const lang = document.getElementById('singles-lang').value;
  const type = document.getElementById('singles-type').value;
  const fName = colFilter('sf-name');
  const fLang = colFilter('sf-lang');
  const fType = colFilter('sf-type');
  const fDate = colFilter('sf-date');
  // Numeric column filters - use the value as-typed (not lowercased) so the
  // ">", "<", "-" comparator syntax survives. colFilter lowercases everything,
  // which would break ">100".
  const fCost = (document.getElementById('sf-cost')?.value || '').trim();
  const fMkt  = (document.getElementById('sf-mkt')?.value  || '').trim();
  const fList = (document.getElementById('sf-list')?.value || '').trim();

  const statusFilter = (document.getElementById('singles-status-filter')?.value) || 'available';

  const passesFilters = i => {
    if (lang && i.language !== lang) return false;
    if (type && i.type !== type) return false;
    // Universal search: text fields + numeric ranges + "raw", "near mint",
    // "psa 10", ">50", "may 2025", etc.
    if (q && !kjrMatchUniversal(q, i, 'singles')) return false;
    if (fName && !(i.name||'').toLowerCase().includes(fName)) return false;
    if (fLang && !(i.language||'').toLowerCase().includes(fLang)) return false;
    if (fType && !(i.type||'').toLowerCase().includes(fType)) return false;
    if (fDate && !kjrMatchDateFilter(fDate, i.datePurchased)) return false;
    if (fCost && !kjrMatchNumFilter(fCost, i.costPrice))   return false;
    if (fMkt  && !kjrMatchNumFilter(fMkt,  i.marketPrice)) return false;
    if (fList && !kjrMatchNumFilter(fList, i.listPrice))   return false;
    return true;
  };

  const isSt = s => (s||'Available');
  const available = _pinRecentsToTop(sortItems(DB.singles.filter(i => isSt(i.status) === 'Available' && passesFilters(i)), 'singles'), 'singles');
  const sold      = sortItems(DB.singles.filter(i => isSt(i.status) === 'Sold' && passesFilters(i)), 'singles');

  // Status filter drives which section is shown in main body vs collapsed
  const showAvailable = statusFilter === 'available' || statusFilter === 'all';
  const showSoldMain  = statusFilter === 'sold';
  const displayItems  = showSoldMain ? sold : available;
  const altItems      = showSoldMain ? available : sold;

  const totalCost   = available.reduce((s,i) => s + (parseFloat(i.costPrice)||0)*(parseInt(i.qty)||1), 0);
  const totalValue  = available.reduce((s,i) => s + (parseFloat(i.marketPrice)||0)*(parseInt(i.qty)||1), 0);
  const totalQty    = available.reduce((s,i) => s + (parseInt(i.qty)||1), 0);
  const unrealised  = totalValue - totalCost;

  // Info buttons removed - labels and values are self-explanatory at this point.
  function statCard(label, value, tooltip, cls) {
    return '<div class="inv-stat"' + (tooltip ? ' title="' + esc(tooltip) + '"' : '') + '>' +
      '<div class="inv-stat-label">' + label + '</div>' +
      '<div class="inv-stat-value' + (cls ? ' ' + cls : '') + '">' + value + '</div>' +
    '</div>';
  }

  // Raw vs Sealed split - used in the breakdown card below.
  const rawCount    = available.filter(i => i.type !== 'sealed').length;
  const sealedCount = available.filter(i => i.type === 'sealed').length;
  const splitTotal  = rawCount + sealedCount;
  const rawPct      = splitTotal > 0 ? Math.round((rawCount / splitTotal) * 100) : 0;
  const sealedPct   = 100 - rawPct;
  const splitCard   = splitTotal === 0
    ? statCard('Type Split', '-', 'No available singles to split')
    : `<div class="inv-stat" title="Raw vs Sealed split of available singles">
        <div class="inv-stat-label">Raw vs Sealed</div>
        <div class="inv-split-bar">
          ${rawCount > 0 ? `<div class="inv-split-raw" style="width:${rawPct}%" title="Raw · ${rawCount} (${rawPct}%)">${rawPct >= 35 ? 'Raw ' + rawPct + '%' : rawPct >= 10 ? rawPct + '%' : ''}</div>` : ''}
          ${sealedCount > 0 ? `<div class="inv-split-sealed" style="width:${sealedPct}%" title="Sealed · ${sealedCount} (${sealedPct}%)">${sealedPct >= 35 ? 'Sealed ' + sealedPct + '%' : sealedPct >= 10 ? sealedPct + '%' : ''}</div>` : ''}
        </div>
        <div class="inv-split-legend">
          <span><span class="inv-split-dot inv-split-dot-raw"></span>Raw ${rawCount}</span>
          <span><span class="inv-split-dot inv-split-dot-sealed"></span>Sealed ${sealedCount}</span>
        </div>
      </div>`;

  document.getElementById('singles-stats').innerHTML =
    statCard('Total Cost', 'S$' + Math.round(totalCost).toLocaleString('en-SG')) +
    statCard('Market Price', (totalValue > 0 ? 'S$' + Math.round(totalValue).toLocaleString('en-SG') : '-') + _statMktFreshDot(available)) +
    statCard('Available', available.length) +
    splitCard;

  applySortHeaders('singles-table', 'singles');

  function buildRow(i, isSold) {
    const mp = parseFloat(i.marketPrice)||0;
    const typeBadge = i.type === 'sealed' ? '<span class="badge b-sealed">Sealed</span>' : '<span class="badge b-raw">Raw</span>';
    const chk = selectedIds.singles.has(i.id);
    const soldBtn = isSold
      ? '<button class="btn btn-ghost btn-sm" style="color:var(--green);font-size:11px" onclick="markStatus(\'singles\',\'' + i.id + '\',\'Available\')" title="Mark Available">↩ Avail</button>'
      : '<button class="btn btn-ghost btn-sm" style="color:var(--text3);font-size:11px" onclick="markStatus(\'singles\',\'' + i.id + '\',\'Sold\')" title="Mark as Sold">✓ Sold</button>';
    const listBtn = !isSold
      ? '<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="openListingFor(\'singles\',\'' + i.id + '\')" title="Generate listing">📋</button>'
      : '';
    const alertIcon = i.priceAlert && parseFloat(i.marketPrice) >= parseFloat(i.priceAlert)
      ? '<span title="🔔 Price alert: target S$' + i.priceAlert + ' reached!" style="color:#f59e0b;cursor:default">🔔</span>' : '';
    const urlIcon = i.ebayUrl || i.carousellUrl
      ? '<span title="Listed on ' + (i.ebayUrl ? 'eBay ' : '') + (i.carousellUrl ? 'Carousell' : '') + '">🔗</span>' : '';
    // All user-controlled strings (name, language, datePurchased, etc.) are wrapped
    // in esc() before being concatenated into HTML, to defeat XSS via malicious values.
    const safeId = esc(i.id);
    const isRecent = typeof _isRecentlyAdded === 'function' && _isRecentlyAdded('singles', i.id);
    return '<tr data-id="' + safeId + '" class="' + (chk ? 'row-selected' : '') + (isSold ? ' sold-row' : '') + (isRecent ? ' recent-add' : '') + '">' +
      '<td data-col-key="_cb" class="cb-col"><input type="checkbox" class="row-cb" ' + (chk ? 'checked' : '') + ' aria-label="Select ' + esc(i.name||'row') + '" onchange="toggleRowSelect(\'singles\',\'' + safeId + '\',this.checked)"></td>' +
      '<td data-col-key="name" style="font-weight:500;max-width:220px;text-align:left"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(i.name||'') + '">' + esc(i.name||'-') + '</div></td>' +
      '<td data-col-key="costPrice" class="num"><input class="kjr-inline" style="width:72px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px" value="' + esc(i.costPrice ? '$' + Math.round(parseFloat(i.costPrice)) : '') + '" placeholder="-" onchange="updateField(\'singles\',\'' + safeId + '\',\'costPrice\',kjrMoneyStr(this.value))"></td>' +
      '<td data-col-key="marketPrice" class="num" style="white-space:nowrap"' + (_mktEmptyCellTitle(i) ? ' title="' + esc(_mktEmptyCellTitle(i)) + '"' : '') + '><input class="kjr-inline" style="width:72px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px" value="' + esc(i.marketPrice ? '$' + Math.round(parseFloat(i.marketPrice)) : '') + '" placeholder="-" onchange="updateField(\'singles\',\'' + safeId + '\',\'marketPrice\',kjrMoneyStr(this.value))">' + _mktFreshDot(i) + '</td>' +
      '<td data-col-key="listPrice" class="num"><input class="kjr-inline" style="width:72px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px" value="' + esc(i.listPrice ? '$' + Math.round(parseFloat(i.listPrice)) : '') + '" placeholder="-" onchange="updateField(\'singles\',\'' + safeId + '\',\'listPrice\',kjrMoneyStr(this.value))"></td>' +
      '<td data-col-key="language"><span class="badge" style="background:var(--bg3);border:1px solid var(--border)">' + esc(i.language||'-') + '</span></td>' +
      '<td data-col-key="type">' + typeBadge + '</td>' +
      '<td data-col-key="datePurchased" style="font-size:12px;color:var(--text2);white-space:nowrap">' + esc(toDateMmmYyyy(i.datePurchased)||'-') + '</td>' +

      '<td data-col-key="actions"><div style="display:flex;gap:4px;justify-content:center;align-items:center">' +
        alertIcon + urlIcon +
        soldBtn +
        listBtn +
        '<button class="btn btn-ghost btn-sm" onclick="openEditSingle(\'' + safeId + '\')" title="Edit">✎</button>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteItem(\'' + safeId + '\',\'singles\')" title="Delete">✕</button>' +
      '</div></td>' +
    '</tr>';
  }

  const tbody = document.getElementById('singles-body');
  tbody.innerHTML = displayItems.length === 0
    ? kjrInvEmptyRow({
        colspan: 12,
        filtered: DB.singles.length > 0,
        icon: '🃏',
        title: 'No singles yet',
        sub: 'Track your ungraded cards here. Add your first one to get started.',
        ctaLabel: '+ Add your first card',
        ctaAction: 'openAddSingle()'
      })
    : displayItems.map(i => buildRow(i, showSoldMain)).join('');

  // Secondary section (the "other" status) - always in the collapsible toggle
  const divider = document.getElementById('singles-sold-divider');
  const soldBody = document.getElementById('singles-sold-body');
  const soldOpen = divider.dataset.open === '1';
  const altLabel = showSoldMain ? 'Available' : 'Sold';
  const altCount = altItems.length;

  if (statusFilter !== 'all' && altCount > 0) {
    divider.style.display = '';
    document.getElementById('singles-sold-count').textContent = altCount;
    document.getElementById('singles-sold-toggle-label').textContent = soldOpen ? 'Hide ' + altLabel : 'Show ' + altLabel;
    document.getElementById('singles-sold-toggle-icon').textContent = soldOpen ? '▼' : '▶';
    soldBody.style.display = soldOpen ? '' : 'none';
    soldBody.innerHTML = soldOpen ? altItems.map(i => buildRow(i, !showSoldMain)).join('') : '';
  } else if (statusFilter === 'all') {
    // All mode: show both available then sold inline with no toggle
    divider.style.display = 'none';
    soldBody.style.display = 'none';
    soldBody.innerHTML = '';
    if (sold.length > 0) {
      tbody.innerHTML += sold.map(i => buildRow(i, true)).join('');
    }
  } else {
    divider.style.display = 'none';
    soldBody.style.display = 'none';
    soldBody.innerHTML = '';
  }

  applyColOrder('singles');
  applyColVisibility('singles');
  attachHeaderDrag('singles');
  if (typeof updateFiltersBadge === 'function') updateFiltersBadge('singles');
  updateClearFiltersBtn('singles');
}

function updateField(table, id, field, val) {
  snapshotForUndo();
  const arr = DB[table];
  const item = arr.find(i => i.id === id);
  if (!item) return;
  const prevVal = item[field];
  // No-op if the value is identical - avoid spurious changelog rows from
  // a click-out that didn't actually mutate anything.
  if (String(prevVal ?? '') === String(val ?? '')) return;
  item[field] = val;
  // Record price history whenever marketPrice is manually updated
  if (field === 'marketPrice' && val && !isNaN(parseFloat(val))) {
    if (!item.priceHistory) item.priceHistory = [];
    item.priceHistory.push({ date: new Date().toISOString().slice(0,10), price: parseFloat(val), source: 'manual' });
    if (item.priceHistory.length > PRICE_HISTORY_MAX) item.priceHistory = item.priceHistory.slice(-PRICE_HISTORY_MAX);
  }
  markDirty(table, id);
  saveData();
  // Audit trail: log every inline field edit so price/market/qty/etc.
  // changes are attributable. Without this, a price drop from manual edits
  // is invisible to the changelog - bad for decision-making accountability.
  if (typeof clLog === 'function') {
    const label = item.name || item.product || item.title || id;
    const fmt = v => (v === '' || v == null) ? '∅' : String(v);
    clLog('edit', table, label, field + ': ' + fmt(prevVal) + ' → ' + fmt(val));
  }
}

// =========== TRASH BIN ===========
// Items are soft-deleted: moved to Supabase 'trash' table with deleted_at timestamp.
// Auto-purge after 30 days; manual restore brings them back to original table.

async function sendToTrash(table, item, reason) {
  const trashEntry = {
    id: 'trash_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    data: {
      originalTable: table,
      originalId: item.id,
      item: item, // full snapshot
      reason: reason || 'manual',
      deletedAt: new Date().toISOString()
    },
    updated_at: new Date().toISOString()
  };
  if (isLocalhostPreview()) { return; } // never write to prod from a local preview
  try {
    const r = await fetch(SB_URL + '/rest/v1/trash', {
      method: 'POST',
      headers: { ...SB_HDR, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(trashEntry),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(await r.text());
  } catch(e) {
    console.warn('Trash write failed, queued for retry:', e);
    _queuePendingTrash(trashEntry); // keep the snapshot until the cloud write lands
  }
}

async function sendBatchToTrash(table, items, reason) {
  if (isLocalhostPreview()) { return; } // never write to prod from a local preview
  const rows = items.map(item => ({
    id: 'trash_' + Date.now() + '_' + Math.random().toString(36).slice(2,6) + '_' + item.id.slice(-4),
    data: { originalTable: table, originalId: item.id, item, reason: reason || 'bulk', deletedAt: new Date().toISOString() },
    updated_at: new Date().toISOString()
  }));
  try {
    const r = await fetch(SB_URL + '/rest/v1/trash', {
      method: 'POST', headers: { ...SB_HDR, 'Prefer': 'resolution=merge-duplicates' },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(await r.text());
  } catch(e) {
    console.warn('Batch trash failed, queued for retry:', e);
    rows.forEach(row => _queuePendingTrash(row));
  }
}

async function fetchTrash() {
  try {
    // Was a single limit=2000 request - PostgREST caps a single response at
    // 1000 rows regardless of the requested limit, so trash past the first
    // 1000 silently never loaded. Paginate the same way as sbFetchAll.
    return await sbFetchPaged('trash', 'select=id,data,updated_at&order=updated_at.desc', 30000);
  } catch(e) {
    console.warn('Fetch trash failed:', e);
    return [];
  }
}

async function hardDeleteTrashEntry(trashId) {
  if (isLocalhostPreview()) { return; } // never write to prod from a local preview
  try {
    const r = await fetch(SB_URL + '/rest/v1/trash?id=eq.' + encodeURIComponent(trashId), {
      method: 'DELETE', headers: SB_HDR, signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(await r.text());
  } catch(e) { console.warn('Hard delete failed:', e); }
}

async function restoreFromTrash(trashId) {
  const entries = await fetchTrash();
  const entry   = entries.find(e => e.id === trashId);
  if (!entry) { toastError('Trash entry not found'); return; }
  const { originalTable, item } = entry.data;
  // Saved-chart restoration is special - re-add to localStorage
  if (originalTable === 'savedChart') {
    const charts = loadSavedCharts();
    charts.push(item);
    persistSavedCharts(charts);
    if (typeof renderAllSavedCharts === 'function') renderAllSavedCharts();
  } else {
    // Inventory/sales - re-insert into DB and push to Supabase.
    // sbUpsert needs the snake_case table name (etbs / booster_boxes /
    // ebay_purchases / booster_packs); pass it through _tblName.
    if (!DB[originalTable]) { toastError('Unknown table: ' + originalTable); return; }
    // Guard against a double-click (or a retry after a prior failed cloud
    // push) re-inserting a row that's already back in DB - would duplicate it.
    const alreadyRestored = DB[originalTable].some(r => r.id === item.id);
    if (alreadyRestored) {
      await hardDeleteTrashEntry(trashId);
      toast('Already restored');
      renderTrash();
      return;
    }
    DB[originalTable].push(item);
    markDirty(originalTable, item.id);
    saveData();
    // sbUpsert re-throws on failure (network down, 5xx). If it does, don't
    // abort here - markDirty + saveData already queued this row for the next
    // dirty flush, so fall through to the local completion path (clear the
    // trash entry, refresh the list) and tell the user cloud sync will retry.
    let _ts = null;
    let _cloudFailed = false;
    try {
      const sbTable = (typeof _tblName === 'function') ? _tblName(originalTable) : originalTable;
      _ts = await sbUpsert(sbTable, item.id, (() => { const { id, ...d } = item; return d; })());
    } catch(e) {
      _cloudFailed = true;
      console.warn('Restore cloud push failed, will retry via dirty queue:', e);
    }
    // Stamp the cloud timestamp back so the next mergeTable pass doesn't treat
    // this restored row's stale base timestamp as a fake conflict (see A1).
    if (_ts) {
      const _row = DB[originalTable].find(r => r.id === item.id);
      if (_row) { _row._updatedAt = _ts; try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ singles: DB.singles, slabs: DB.slabs, sales: DB.sales, etbs: DB.etbs, boosterBoxes: DB.boosterBoxes, boosterPacks: DB.boosterPacks, ebayPurchases: DB.ebayPurchases })); } catch(e){} }
    }
    if (originalTable === 'singles') renderSingles();
    if (originalTable === 'slabs')   renderSlabs();
    if (originalTable === 'sales')   renderSales();
    if (originalTable === 'etbs'          && typeof renderEtbs === 'function')          renderEtbs();
    if (originalTable === 'boosterBoxes'  && typeof renderBoosterBoxes === 'function')  renderBoosterBoxes();
    if (originalTable === 'boosterPacks'  && typeof renderBoosterPacks === 'function')  renderBoosterPacks();
    if (originalTable === 'ebayPurchases' && typeof renderEbayPurchases === 'function') renderEbayPurchases();
    if (_cloudFailed) {
      await hardDeleteTrashEntry(trashId);
      const extra = _clSummary(originalTable, item) || 'restored from trash';
      clLog('restore', originalTable, item.name || item.product || item.title || item.id, extra);
      toast('Restored locally - cloud sync will retry');
      renderTrash();
      return;
    }
  }
  await hardDeleteTrashEntry(trashId);
  const restoreExtra = originalTable === 'savedChart'
    ? ('chart "' + (item.title || 'untitled') + '"')
    : (_clSummary(originalTable, item) || 'restored from trash');
  clLog('restore', originalTable, item.name || item.product || item.title || item.id, restoreExtra);
  toast('Restored ✓');
  renderTrash();
}

async function emptyTrash() {
  const entries = await fetchTrash();
  if (!entries.length) { toast('Trash is already empty'); return; }
  if (!await kjrConfirm('Permanently delete all ' + entries.length + ' items in trash? This cannot be undone.', {ok:'Delete all', danger:true})) return;
  try {
    const r = await fetch(SB_URL + '/rest/v1/trash?id=not.is.null', {
      method: 'DELETE', headers: SB_HDR, signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) throw new Error(await r.text());
    toast('Trash emptied');
    renderTrash();
  } catch(e) { toastError('Empty failed: ' + e.message); }
}

async function purgeExpiredTrash() {
  const entries = await fetchTrash();
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  for (const e of entries) {
    const deletedAt = new Date(e.data?.deletedAt || e.updated_at).getTime();
    if (deletedAt < thirtyDaysAgo) await hardDeleteTrashEntry(e.id);
  }
}

function renderTrash() {
  const list = document.getElementById('trash-list');
  const stats = document.getElementById('trash-stats');
  if (!list) return;
  list.innerHTML = '<div class="hig-loading"><div class="hig-spinner"></div><div class="hig-loading-text">Loading trash…</div></div>';

  fetchTrash().then(entries => {
    const filter = document.getElementById('trash-filter-type')?.value || '';
    const filtered = filter ? entries.filter(e => e.data?.originalTable === filter) : entries;
    if (stats) stats.textContent = filtered.length + ' deleted item' + (filtered.length !== 1 ? 's' : '') + ' · auto-purged after 30 days';

    if (!filtered.length) {
      list.innerHTML = '<div class="hig-empty"><div class="hig-empty-icon">🗑</div><div class="hig-empty-title">Trash is empty</div><div class="hig-empty-sub">Deleted items appear here for 30 days before being permanently removed.</div></div>';
      return;
    }

    list.innerHTML = filtered.map(e => {
      const d = e.data || {};
      const item = d.item || {};
      const name = item.name || item.product || item.title || '(unnamed)';
      const sub = (() => {
        if (d.originalTable === 'singles' || d.originalTable === 'slabs') {
          const parts = [];
          if (item.language) parts.push(item.language);
          if (item.grader)   parts.push(item.grader + ' ' + item.grade);
          if (item.costPrice) parts.push('Cost S$' + item.costPrice);
          return parts.join(' · ');
        }
        if (d.originalTable === 'sales') return 'Sold S$' + (item.totalCollected||0) + ' · profit S$' + (item.profit||0);
        if (d.originalTable === 'savedChart') return (item.xFields||[]).length + ' X fields · ' + (item.yFields||[]).length + ' Y fields';
        return '';
      })();
      const deletedAt = new Date(d.deletedAt || e.updated_at);
      const ago = (() => {
        const ms = Date.now() - deletedAt.getTime();
        const days = Math.floor(ms / 86400000);
        if (days === 0) return 'Today';
        if (days === 1) return 'Yesterday';
        if (days < 30) return days + 'd ago';
        return deletedAt.toLocaleDateString();
      })();
      const daysLeft = Math.max(0, 30 - Math.floor((Date.now() - deletedAt.getTime()) / 86400000));
      const tableLabels = { singles: 'Single', slabs: 'Slab', sales: 'Sale', savedChart: 'Saved Chart' };
      const tableBadge = tableLabels[d.originalTable] || d.originalTable || 'Item';

      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
            <span style="background:var(--bg3);border:1px solid var(--border2);border-radius:4px;padding:1px 6px;font-size:10px;color:var(--text2);font-weight:500">${tableBadge}</span>
            <span style="font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</span>
          </div>
          <div style="font-size:11px;color:var(--text3)">${esc(sub)}</div>
        </div>
        <div style="text-align:right;font-size:11px;color:var(--text3);min-width:90px">
          <div>${ago}</div>
          <div style="opacity:0.7">${daysLeft}d left</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm btn-primary" style="font-size:11px" onclick="restoreFromTrash('${esc(e.id)}')">↻ Restore</button>
          <button class="btn btn-sm" style="font-size:11px;color:var(--red)" onclick="(async()=>{ if(await kjrConfirm('Permanently delete this item? Cannot be undone.', {ok:'Delete forever', danger:true})) { await hardDeleteTrashEntry('${esc(e.id)}'); toast('Permanently deleted'); renderTrash(); } })()">✕ Delete forever</button>
        </div>
      </div>`;
    }).join('');
  });
}

// ── Hook deletions to send to trash ──

async function deleteItem(id, table) {
  const item = DB[table].find(i => i.id === id);
  if (!item) return;
  if (!await kjrConfirm('Move this item to trash? You can restore it within 30 days from the Trash tab.', {ok:'Move to trash', danger:true})) return;

  // If there are linked sales, offer to void them so they don't become orphans.
  const linkedSales = DB.sales.filter(s => s.inventoryId === id && s.inventoryTable === table);
  let voidLinkedSales = false;
  if (linkedSales.length) {
    voidLinkedSales = await kjrConfirm(
      'There ' + (linkedSales.length === 1 ? 'is 1 sale' : 'are ' + linkedSales.length + ' sales') +
      ' linked to this item.\n\nTrash sales too → also move the linked sale(s) to trash.\nKeep sales → keep the sale record(s).',
      {ok:'Trash sales too', cancel:'Keep sales'}
    );
  }

  snapshotForUndo();
  if (voidLinkedSales) {
    linkedSales.forEach(s => {
      DB.sales = DB.sales.filter(x => x.id !== s.id);
      sendToTrash('sales', s, 'linked-item-deleted').catch(() => {});
      sbDelete('sales', s.id).catch(() => {});
      clLog('delete', 'sales', s.product, 'auto-trashed (linked item deleted)');
    });
    renderSales();
  }

  // ── Optimistic update: remove from UI immediately ──
  DB[table] = DB[table].filter(i => i.id !== id);
  saveData();
  if (table === 'singles') renderSingles();
  if (table === 'slabs') renderSlabs();
  if (table === 'sales') renderSales();
  toast('Moved to trash · view in 🗑 tab');
  // Snapshot the row's full field set so the changelog records what was
  // moved to trash. If the trash auto-purges after 30d, the changelog
  // still has the audit trail of what existed.
  clLog('delete', table, item.name || item.product || id, _clSummary(table, item));

  // ── Background: write to trash + delete from Supabase ──
  Promise.all([
    sendToTrash(table, item, 'single'),
    sbDelete(table, id)
  ]).catch(e => {
    setSyncStatus('error', 'Delete sync failed: ' + e.message);
    console.error('Delete background sync failed:', e);
  });
}

function openAddSingle() {
  document.getElementById('ms-id').value = '';
  document.getElementById('modal-single-title').textContent = 'Add Single';
  ['ms-name','ms-set','ms-cost','ms-market','ms-list','ms-date','ms-notes','ms-alert','ms-ebay-url','ms-carousell-url','ms-tcgdexid'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('ms-qty').value = 1;
  document.getElementById('ms-lang').value = 'EN';
  document.getElementById('ms-type').value = 'raw';
  document.getElementById('ms-cond').value = 'Near Mint';
  document.getElementById('ms-status').value = 'Available';
  document.getElementById('ms-tcgdex-resolved').textContent = '';
  openModal('modal-single');
}

function openEditSingle(id) {
  const item = DB.singles.find(i => i.id === id);
  if (!item) return;
  document.getElementById('ms-id').value = id;
  document.getElementById('modal-single-title').textContent = 'Edit Single';
  document.getElementById('ms-name').value = item.name||'';
  document.getElementById('ms-set').value = item.set||'';
  document.getElementById('ms-lang').value = item.language||'EN';
  document.getElementById('ms-type').value = item.type||'raw';
  document.getElementById('ms-cond').value = item.condition||'Near Mint';
  document.getElementById('ms-qty').value = item.qty||1;
  document.getElementById('ms-cost').value = item.costPrice||'';
  document.getElementById('ms-list').value = item.listPrice||'';
  document.getElementById('ms-market').value = item.marketPrice||'';
  document.getElementById('ms-date').value = toIsoDateStr(item.datePurchased);
  document.getElementById('ms-status').value = item.status||'Available';
  document.getElementById('ms-notes').value = item.notes||'';
  document.getElementById('ms-alert').value = item.priceAlert||'';
  document.getElementById('ms-ebay-url').value = item.ebayUrl||'';
  document.getElementById('ms-carousell-url').value = item.carousellUrl||'';
  document.getElementById('ms-tcgdexid').value = item.tcgdexId||'';
  // Show the auto-resolved card name (if we have one) as a confirm check -
  // helps the user spot a mis-match without having to trust the id blindly.
  document.getElementById('ms-tcgdex-resolved').textContent = item._tcgdexResolvedName ? ('Resolved to: ' + item._tcgdexResolvedName) : '';
  openModal('modal-single');
}

// Wrap a save handler so the button disables + shows a brief loading label
// while it runs, preventing double-submit. Works for sync and async handlers.
async function kjrGuardSave(btn, fn) {
  if (!btn || btn.disabled) return;
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.style.opacity = '0.7';
  btn.style.cursor = 'wait';
  btn.innerHTML = '<span class="kjr-btn-spinner"></span> Saving…';
  try { await fn(); }
  finally {
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
    btn.innerHTML = label;
  }
}

function saveSingle() {
  const id = document.getElementById('ms-id').value;
  const name = document.getElementById('ms-name').value.trim();
  if (!name) { toast('Card name is required'); return; }
  snapshotForUndo();
  // Coerce numeric fields on save so downstream reducers never have to guess.
  // Empty strings stay empty so the UI can show '-' rather than '0'.
  const _cost   = document.getElementById('ms-cost').value;
  const _market = document.getElementById('ms-market').value;
  const item = {
    id: id || genId('s'),
    name, set: document.getElementById('ms-set').value,
    language: document.getElementById('ms-lang').value,
    type: document.getElementById('ms-type').value,
    condition: document.getElementById('ms-cond').value,
    qty: parseInt(document.getElementById('ms-qty').value)||1,
    listPrice: kjrNum(document.getElementById('ms-list').value),
    costPrice: _cost === '' ? '' : kjrNum(_cost),
    marketPrice: _market === '' ? '' : kjrNum(_market),
    datePurchased: formatDateInput(document.getElementById('ms-date').value),
    status: document.getElementById('ms-status').value,
    notes: document.getElementById('ms-notes').value,
    priceAlert: document.getElementById('ms-alert').value,
    ebayUrl: document.getElementById('ms-ebay-url').value,
    carousellUrl: document.getElementById('ms-carousell-url').value,
    tcgdexId: document.getElementById('ms-tcgdexid').value,
    priceHistory: []
  };
  // Run through the unified normalizer so manual input matches the table
  // format (dates → "D MMM YYYY", numbers → number, language UPPER, etc.).
  const norm = normalizeRecord('singles', item);
  let before = null;
  if (id) {
    const idx = DB.singles.findIndex(i => i.id === id);
    if (idx >= 0) {
      before = { ...DB.singles[idx] };
      norm.priceHistory = DB.singles[idx].priceHistory||[];
      // Keep the resolved-name confirm tooltip only while the id itself is
      // unchanged - a manual override to a different id invalidates the old
      // confirm name (it'll re-populate on the next successful fetch), and
      // clearing the field back to blank drops it too so a future auto-
      // resolve isn't shown against a stale label.
      if (norm.tcgdexId && norm.tcgdexId === before.tcgdexId) norm._tcgdexResolvedName = before._tcgdexResolvedName;
      DB.singles[idx] = norm;
    }
  } else {
    DB.singles.push(norm);
    if (typeof _pinRecentlyAdded === 'function') _pinRecentlyAdded('singles', norm.id);
  }
  markDirty('singles', norm.id);
  saveData(); closeModal('modal-single', true); renderSingles(); // force: already saved
  toast(id ? 'Updated!' : 'Added!');
  // Audit: full snapshot on add, field-level diff on edit.
  const extra = id ? (_clDiff('singles', before, norm) || 'no field changes') : _clSummary('singles', norm);
  clLog(id ? 'edit' : 'add', 'singles', norm.name, extra);
}

// =========== SLABS ===========
function renderSlabs() {
  const q = (document.getElementById('slabs-search').value||'').toLowerCase();
  const grader = document.getElementById('slabs-grader').value;
  const grade = document.getElementById('slabs-grade').value;
  const fName   = colFilter('slbf-name');
  const fGrade  = colFilter('slbf-grade');
  const fCert   = colFilter('slbf-cert');
  const fRank   = colFilter('slbf-rank');
  const fDate   = colFilter('slbf-date');
  const fLang   = colFilter('slbf-lang');
  // Numeric column filters - value as-typed (not lowercased) so comparator
  // syntax ">100" / "100-200" survives.
  const fCost = (document.getElementById('slbf-cost')?.value || '').trim();
  const fMkt  = (document.getElementById('slbf-mkt')?.value  || '').trim();
  const fList = (document.getElementById('slbf-list')?.value || '').trim();

  // Slab filter goes through the unified _resolveGrader so it sees the same
  // canonical PSA/CGC/TAG that the badge does. Without this, rows with
  // grader stored as "PSA 10" + empty grade (or vice versa) wouldn't match
  // the PSA dropdown filter. This was the root cause of "filtering by PSA
  // only yields 1 result" - most rows didn't have grader exactly === "PSA".
  const passesFilters = i => {
    if (grader || grade) {
      // Pass notes so Pristine markers stored there are picked up.
      const r = _resolveGrader(i.grader, i.grade, i.notes);
      if (grader && r.grader !== grader) return false;
      // Special "pristine" grade option in the dropdown filters to PSA
      // Pristine 10s only. Otherwise compare numeric grades directly.
      if (grade === 'pristine') {
        if (!r.pristine) return false;
      } else if (grade && r.grade !== grade) {
        return false;
      }
    }
    if (q && !kjrMatchUniversal(q, i, 'slabs')) return false;
    if (fName   && !(i.name||'').toLowerCase().includes(fName)) return false;
    // Grade column filter: matches grader name or grade value (e.g. "PSA", "10").
    if (fGrade) {
      const gradeCombo = ((i.grader||'') + ' ' + (i.grade||'')).toLowerCase();
      if (!gradeCombo.includes(fGrade)) return false;
    }
    // Cert # column filter: matches cert number only.
    if (fCert   && !(i.certNo||'').toLowerCase().includes(fCert)) return false;
    if (fRank   && !(i.rank||'').toLowerCase().includes(fRank)) return false;
    if (fDate   && !kjrMatchDateFilter(fDate, i.dateListed)) return false;
    if (fLang   && !(i.language||'').toLowerCase().includes(fLang)) return false;
    if (fCost   && !kjrMatchNumFilter(fCost, i.costPrice))   return false;
    if (fMkt    && !kjrMatchNumFilter(fMkt,  i.marketPrice)) return false;
    if (fList   && !kjrMatchNumFilter(fList, i.listPrice))   return false;
    return true;
  };

  const available = _pinRecentsToTop(sortItems(DB.slabs.filter(i => (i.status||'Available') === 'Available' && passesFilters(i)), 'slabs'), 'slabs');
  const sold      = sortItems(DB.slabs.filter(i => (i.status||'Available') === 'Sold' && passesFilters(i)), 'slabs');

  const totalCostSlabs  = available.reduce((s,i) => s + (parseFloat(i.costPrice)||0), 0);
  const totalValueSlabs = available.reduce((s,i) => s + (parseFloat(i.marketPrice)||0), 0);
  const unrealisedSlabs = totalValueSlabs - totalCostSlabs;

  function statCard(label, value, tooltip, cls) {
    return '<div class="inv-stat"' + (tooltip ? ' title="' + esc(tooltip) + '"' : '') + '>' +
      '<div class="inv-stat-label">' + label + '</div>' +
      '<div class="inv-stat-value' + (cls ? ' ' + cls : '') + '">' + value + '</div>' +
    '</div>';
  }

  // Grader split - PSA / CGC / TAG / Other. Use substring matching across the
  // grader AND grade fields so stored values like "PSA 10", "psa ", or even
  // a grade column with "PSA 10" stuffed into it all classify correctly.
  // Also falls back to the rendered badge (when graderGradeBadge embeds the
  // grader in the badge text) so visual matches the legend.
  // Use the unified _resolveGrader so the Grader Split card buckets rows the
  // exact same way the badge classifies them. Anything we can't classify
  // ends up in "Other".
  const _classifyGrader = (i) => _resolveGrader(i.grader, i.grade).grader || 'Other';
  const bucketCounts = available.reduce((acc, i) => {
    const b = _classifyGrader(i);
    acc[b] = (acc[b]||0) + 1;
    return acc;
  }, { PSA: 0, CGC: 0, TAG: 0, Other: 0 });
  const psaCount   = bucketCounts.PSA;
  const cgcCount   = bucketCounts.CGC;
  const tagCount   = bucketCounts.TAG;
  const otherCount = bucketCounts.Other;
  const splitTotal = available.length;
  const splitPct = n => splitTotal > 0 ? Math.round((n / splitTotal) * 100) : 0;
  const seg = (count, cls, label) => {
    if (!count) return '';
    const pct = splitPct(count);
    // Show full label only when there's room (≥30%). Between 10–30 show just
    // the %. Below 10 show nothing - legend below carries the name.
    const text = pct >= 30 ? label + ' ' + pct + '%' : pct >= 10 ? pct + '%' : '';
    return `<div class="inv-split-${cls}" style="width:${pct}%" title="${label} · ${count} (${pct}%)">${text}</div>`;
  };
  const splitCard = splitTotal === 0
    ? statCard('Grader Split', '-')
    : `<div class="inv-stat" title="PSA / CGC / TAG split of available slabs">
        <div class="inv-stat-label">Grader Split</div>
        <div class="inv-split-bar">
          ${seg(tagCount, 'tag', 'TAG')}
          ${seg(psaCount, 'psa', 'PSA')}
          ${seg(cgcCount, 'cgc', 'CGC')}
          ${seg(otherCount, 'other', 'Other')}
        </div>
        <div class="inv-split-legend">
          ${tagCount   ? '<span><span class="inv-split-dot inv-split-dot-tag"></span>TAG ' + tagCount + '</span>' : ''}
          ${psaCount   ? '<span><span class="inv-split-dot inv-split-dot-psa"></span>PSA ' + psaCount + '</span>' : ''}
          ${cgcCount   ? '<span><span class="inv-split-dot inv-split-dot-cgc"></span>CGC ' + cgcCount + '</span>' : ''}
          ${otherCount ? '<span><span class="inv-split-dot" style="background:var(--text3)"></span>Other ' + otherCount + '</span>' : ''}
        </div>
      </div>`;

  document.getElementById('slabs-stats').innerHTML =
    statCard('Total Cost', 'S$' + Math.round(totalCostSlabs).toLocaleString('en-SG')) +
    statCard('Market Price', (totalValueSlabs > 0 ? 'S$' + Math.round(totalValueSlabs).toLocaleString('en-SG') : '-') + _statMktFreshDot(available)) +
    statCard('Available', available.length) +
    splitCard;

  applySortHeaders('slabs-table', 'slabs');

  function buildRow(i, isSold) {
    const _gd = (i.grader || '').toString().trim().toUpperCase();
    const _gr = (i.grade  || '').toString().trim().toUpperCase();
    const _isTag = _gd === 'TAG' || _gr.startsWith('TAG');
    const tagUrl = (i.certNo && _isTag) ? 'https://my.taggrading.com/card/' + encodeURIComponent(i.certNo) : null;
    const chk = selectedIds.slabs.has(i.id);
    // Grade badge (separate column) + cert number (separate column with TAG link).
    const badge = graderGradeBadge(i.grader, i.grade, i.notes);
    const certText = i.certNo ? esc(i.certNo) : '-';
    const certHtml = tagUrl
      ? '<a href="' + esc(tagUrl) + '" target="_blank" style="text-decoration:none;color:var(--text2);font-size:12px;display:inline-flex;align-items:center;gap:2px">' + certText + ' <span style="color:var(--text3);font-size:10px">↗</span></a>'
      : '<span style="color:var(--text2);font-size:12px">' + certText + '</span>';
    const soldBtn = isSold
      ? '<button class="btn btn-ghost btn-sm" style="color:var(--green);font-size:11px" onclick="markStatus(\'slabs\',\'' + i.id + '\',\'Available\')" title="Mark Available">↩ Avail</button>'
      : '<button class="btn btn-ghost btn-sm" style="color:var(--text3);font-size:11px" onclick="markStatus(\'slabs\',\'' + i.id + '\',\'Sold\')" title="Mark as Sold">✓ Sold</button>';
    const listBtn = !isSold
      ? '<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="openListingFor(\'slabs\',\'' + i.id + '\')" title="Generate listing">📋</button>'
      : '';
    const alertIcon = i.priceAlert && parseFloat(i.marketPrice) >= parseFloat(i.priceAlert)
      ? '<span title="🔔 Price alert: target S$' + i.priceAlert + ' reached!" style="color:#f59e0b;cursor:default">🔔</span>' : '';
    const urlIcon = i.ebayUrl || i.carousellUrl
      ? '<span title="Listed on ' + (i.ebayUrl ? 'eBay ' : '') + (i.carousellUrl ? 'Carousell' : '') + '">🔗</span>' : '';
    const mp = parseFloat(i.marketPrice)||0;
    const mpDisplay = (i.marketPrice !== '' && i.marketPrice !== null && i.marketPrice !== undefined) ? ('$' + Math.round(parseFloat(i.marketPrice))) : '';
    const safeId = esc(i.id);
    const isRecent = typeof _isRecentlyAdded === 'function' && _isRecentlyAdded('slabs', i.id);
    return '<tr data-id="' + safeId + '" class="' + (chk ? 'row-selected' : '') + (isSold ? ' sold-row' : '') + (isRecent ? ' recent-add' : '') + '">' +
      '<td data-col-key="_cb" class="cb-col"><input type="checkbox" class="row-cb" ' + (chk ? 'checked' : '') + ' aria-label="Select ' + esc(i.name||'row') + '" onchange="toggleRowSelect(\'slabs\',\'' + safeId + '\',this.checked)"></td>' +
      '<td data-col-key="name" style="font-weight:500;max-width:200px;text-align:left"><div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="' + esc(i.name||'') + '">' + esc(i.name||'-') + '</div></td>' +
      '<td data-col-key="_grade" style="white-space:nowrap">' + badge + '</td>' +
      '<td data-col-key="certNo" style="white-space:nowrap">' + certHtml + '</td>' +
      '<td data-col-key="rank" style="font-size:12px;color:var(--text2)">' + esc(_ordinalRank(i.rank) || i.rank || '-') + '</td>' +
      '<td data-col-key="dateListed" style="font-size:12px;color:var(--text2);white-space:nowrap">' + esc(toDateMmmYyyy(i.dateListed)||'-') + '</td>' +
      '<td data-col-key="language"><span class="badge" style="background:var(--bg3);border:1px solid var(--border)">' + esc(i.language||'-') + '</span></td>' +
      '<td data-col-key="costPrice" class="num"><input class="kjr-inline" style="width:72px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px" value="' + esc(i.costPrice ? '$' + Math.round(parseFloat(i.costPrice)) : '') + '" placeholder="-" onchange="updateField(\'slabs\',\'' + safeId + '\',\'costPrice\',kjrMoneyStr(this.value))"></td>' +
      '<td data-col-key="marketPrice" class="num" style="white-space:nowrap"' + (_mktEmptyCellTitle(i) ? ' title="' + esc(_mktEmptyCellTitle(i)) + '"' : '') + '><input class="kjr-inline" style="width:72px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px" value="' + esc(mpDisplay) + '" placeholder="-" onchange="updateField(\'slabs\',\'' + safeId + '\',\'marketPrice\',kjrMoneyStr(this.value))">' + _mktFreshDot(i) + '</td>' +
      '<td data-col-key="listPrice" class="num"><input class="kjr-inline" style="width:80px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px" value="' + esc(i.listPrice ? '$' + Math.round(parseFloat(i.listPrice)) : '') + '" placeholder="-" onchange="updateField(\'slabs\',\'' + safeId + '\',\'listPrice\',kjrMoneyStr(this.value))"></td>' +
      '<td data-col-key="actions"><div style="display:flex;gap:4px;justify-content:center;align-items:center">' +
        alertIcon + urlIcon +
        soldBtn +
        listBtn +
        '<button class="btn btn-ghost btn-sm" onclick="openEditSlab(\'' + safeId + '\')" title="Edit">✎</button>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteItem(\'' + safeId + '\',\'slabs\')" title="Delete">✕</button>' +
      '</div></td>' +
    '</tr>';
  }

  const tbody = document.getElementById('slabs-body');
  tbody.innerHTML = available.length === 0
    ? kjrInvEmptyRow({
        colspan: 12,
        filtered: DB.slabs.length > 0,
        icon: '🏆',
        title: 'No slabs yet',
        sub: 'Track your graded cards (PSA, CGC, TAG) here. Add your first slab to get started.',
        ctaLabel: '+ Add your first card',
        ctaAction: 'openAddSlab()'
      })
    : available.map(i => buildRow(i, false)).join('');

  // Sold section
  const divider = document.getElementById('slabs-sold-divider');
  const soldBody = document.getElementById('slabs-sold-body');
  const soldOpen = divider.dataset.open === '1';

  if (sold.length > 0) {
    divider.style.display = '';
    document.getElementById('slabs-sold-count').textContent = sold.length;
    document.getElementById('slabs-sold-toggle-label').textContent = soldOpen ? 'Hide Sold' : 'Show Sold';
    document.getElementById('slabs-sold-toggle-icon').textContent = soldOpen ? '▼' : '▶';
    soldBody.style.display = soldOpen ? '' : 'none';
    soldBody.innerHTML = soldOpen ? sold.map(i => buildRow(i, true)).join('') : '';
  } else {
    divider.style.display = 'none';
    soldBody.style.display = 'none';
    soldBody.innerHTML = '';
  }

  applyColOrder('slabs');
  applyColVisibility('slabs');
  attachHeaderDrag('slabs');
  if (typeof updateFiltersBadge === 'function') updateFiltersBadge('slabs');
  updateClearFiltersBtn('slabs');
}

function openAddSlab() {
  document.getElementById('msl-id').value = '';
  document.getElementById('modal-slab-title').textContent = 'Add Slab';
  ['msl-name','msl-grade','msl-cert','msl-rank','msl-cost','msl-market','msl-list','msl-date','msl-notes','msl-alert','msl-ebay-url','msl-carousell-url','msl-tcgdexid'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('msl-grader').value = 'TAG';
  document.getElementById('msl-lang').value = 'EN';
  document.getElementById('msl-status').value = 'Available';
  document.getElementById('msl-tcgdex-resolved').textContent = '';
  openModal('modal-slab');
}

function openEditSlab(id) {
  const item = DB.slabs.find(i => i.id === id);
  if (!item) return;
  document.getElementById('msl-id').value = id;
  document.getElementById('modal-slab-title').textContent = 'Edit Slab';
  document.getElementById('msl-name').value = item.name||'';
  document.getElementById('msl-grader').value = item.grader||'TAG';
  document.getElementById('msl-grade').value = item.grade||'';
  document.getElementById('msl-lang').value = item.language||'EN';
  document.getElementById('msl-cert').value = item.certNo||'';
  document.getElementById('msl-rank').value = item.rank||'';
  document.getElementById('msl-cost').value = item.costPrice||'';
  document.getElementById('msl-list').value = item.listPrice||'';
  document.getElementById('msl-market').value = item.marketPrice||'';
  document.getElementById('msl-date').value = toIsoDateStr(item.dateListed);
  document.getElementById('msl-status').value = item.status||'Available';
  document.getElementById('msl-notes').value = item.notes||'';
  document.getElementById('msl-alert').value = item.priceAlert||'';
  document.getElementById('msl-ebay-url').value = item.ebayUrl||'';
  document.getElementById('msl-carousell-url').value = item.carousellUrl||'';
  document.getElementById('msl-tcgdexid').value = item.tcgdexId||'';
  // Slabs price via PPT (eBay graded), not TCGdex, so this rarely populates -
  // but a raw single that later got re-tagged as a slab could still carry
  // one, so still show the confirm name when present.
  document.getElementById('msl-tcgdex-resolved').textContent = item._tcgdexResolvedName ? ('Resolved to: ' + item._tcgdexResolvedName) : '';
  openModal('modal-slab');
}

function saveSlab() {
  const id = document.getElementById('msl-id').value;
  const name = document.getElementById('msl-name').value.trim();
  if (!name) { toast('Card name is required'); return; }
  snapshotForUndo();
  // Coerce numeric fields on save (see saveSingle comment).
  const _slCost   = document.getElementById('msl-cost').value;
  const _slMarket = document.getElementById('msl-market').value;
  const item = {
    id: id || genId('sl'),
    name, type: 'slab',
    grader: document.getElementById('msl-grader').value,
    grade: document.getElementById('msl-grade').value,
    language: document.getElementById('msl-lang').value,
    certNo: document.getElementById('msl-cert').value,
    rank: document.getElementById('msl-rank').value,
    listPrice: kjrNum(document.getElementById('msl-list').value),
    costPrice: _slCost === '' ? '' : kjrNum(_slCost),
    marketPrice: _slMarket === '' ? '' : kjrNum(_slMarket),
    dateListed: formatDateInput(document.getElementById('msl-date').value),
    status: document.getElementById('msl-status').value,
    notes: document.getElementById('msl-notes').value,
    priceAlert: document.getElementById('msl-alert').value,
    ebayUrl: document.getElementById('msl-ebay-url').value,
    carousellUrl: document.getElementById('msl-carousell-url').value,
    tcgdexId: document.getElementById('msl-tcgdexid').value,
    priceHistory: []
  };
  const norm = normalizeRecord('slabs', item);
  let beforeSlab = null;
  if (id) {
    const idx = DB.slabs.findIndex(i => i.id === id);
    if (idx >= 0) {
      beforeSlab = { ...DB.slabs[idx] };
      norm.priceHistory = DB.slabs[idx].priceHistory||[];
      // Same confirm-name carry-over rule as saveSingle.
      if (norm.tcgdexId && norm.tcgdexId === beforeSlab.tcgdexId) norm._tcgdexResolvedName = beforeSlab._tcgdexResolvedName;
      DB.slabs[idx] = norm;
    }
  } else {
    DB.slabs.push(norm);
    if (typeof _pinRecentlyAdded === 'function') _pinRecentlyAdded('slabs', norm.id);
  }
  markDirty('slabs', norm.id);
  saveData(); closeModal('modal-slab', true); renderSlabs(); // force: already saved
  toast(id ? 'Updated!' : 'Added!');
  const extraSlab = id ? (_clDiff('slabs', beforeSlab, norm) || 'no field changes') : _clSummary('slabs', norm);
  clLog(id ? 'edit' : 'add', 'slabs', norm.name, extraSlab);
}

// ── TAG 10 rank helper ──────────────────────────────────────────────
// Lists every available TAG grade-10 (and Pristine 10) slab that has a cert
// number, with a link to its grading page and an input for the Gem Mint rank.
// TAG's site is JS-rendered behind an authed API, so the number can't be
// auto-scraped reliably - this makes the manual read-and-enter fast instead.
function _tagRankEligible() {
  return (DB.slabs || []).filter(i => {
    if ((i.status || 'Available') !== 'Available') return false;
    if (!i.certNo) return false;
    const r = _resolveGrader(i.grader, i.grade, i.notes);
    return r.grader === 'TAG' && r.grade === '10'; // includes Pristine 10s
  }).sort((a, b) => {
    // Unfilled ranks first, then alphabetical, so you work top-down.
    const af = a.rank ? 1 : 0, bf = b.rank ? 1 : 0;
    if (af !== bf) return af - bf;
    return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
  });
}

function openTagRankHelper() {
  _renderTagRankList();
  openModal('modal-tag-ranks');
}

function _renderTagRankList() {
  const items = _tagRankEligible();
  const body = document.getElementById('tag-rank-body');
  const prog = document.getElementById('tag-rank-progress');
  if (!body) return;
  if (!items.length) {
    body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">No available TAG 10 slabs with a cert number.</div>';
    if (prog) prog.textContent = '';
    return;
  }
  const filled = items.filter(i => i.rank).length;
  if (prog) prog.textContent = filled + ' of ' + items.length + ' done';

  body.innerHTML = items.map(i => {
    const r = _resolveGrader(i.grader, i.grade, i.notes);
    const pris = r.pristine ? ' <span style="color:#f0b429">★ Pristine</span>' : '';
    const url = 'https://my.taggrading.com/card/' + encodeURIComponent(i.certNo);
    const safeId = kjrEscape(i.id);
    const lang = i.language ? ' · ' + kjrEscape(i.language) : '';
    // Display the rank as an ordinal (1 → 1st) so a value typed as a bare number
    // and a value stored as "1st" look identical. A filled box gets an accent
    // border so done rows are scannable at a glance.
    const ord = _ordinalRank(i.rank);
    const rankBorder = ord ? 'var(--accent)' : 'var(--border)';
    return '<div style="display:flex;align-items:center;gap:10px;padding:9px 4px;border-bottom:1px solid var(--border)">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:13px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + kjrEscape(i.name || '-') + pris + '</div>' +
        '<div style="font-size:11px;color:var(--text3)">#' + kjrEscape(i.certNo) + lang + '</div>' +
      '</div>' +
      '<a href="' + kjrEscape(url) + '" target="_blank" rel="noopener" class="btn btn-sm" style="font-size:11px;white-space:nowrap">Open TAG ↗</a>' +
      // Text input (not number) so the stored ordinal "1st" actually renders;
      // a number input shows blank for "1st", which made done cards look empty.
      '<input type="text" inputmode="numeric" placeholder="rank" value="' + kjrEscape(ord) + '" ' +
        'onchange="_setTagRank(\'' + safeId + '\', this)" ' +
        'style="width:74px;text-align:center;padding:6px 8px;background:var(--bg3);border:1px solid ' + rankBorder + ';border-radius:6px;color:var(--text);font-size:13px">' +
    '</div>';
  }).join('');
}

// Format a rank as an ordinal: 1→1st, 2→2nd, 3→3rd, 11→11th, 21→21st. Accepts a
// bare number or an existing ordinal string; returns '' for blank/invalid.
function _ordinalRank(v) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
  if (!n || n < 1) return '';
  const s = ['th', 'st', 'nd', 'rd'], m = n % 100;
  return n + (s[(m - 20) % 10] || s[m] || s[0]);
}

function _setTagRank(id, el) {
  // Store the ordinal form ("1st"), matching how rank is stored everywhere else
  // (parseSmartLine, Quick Entry). Blank clears it.
  const ord = _ordinalRank(el ? el.value : '');
  updateField('slabs', id, 'rank', ord);
  if (el) { el.value = ord; el.style.borderColor = ord ? 'var(--accent)' : 'var(--border)'; }
  // Update the progress counter without rebuilding (keeps focus/scroll), and
  // refresh the underlying slabs table so the Rank column reflects the change.
  const items = _tagRankEligible();
  const filled = items.filter(i => i.rank).length;
  const prog = document.getElementById('tag-rank-progress');
  if (prog) prog.textContent = filled + ' of ' + items.length + ' done';
  if (typeof renderSlabs === 'function') renderSlabs();
}

// =========== SALES ===========
function renderSales() {
  const q = (document.getElementById('sales-search').value||'').toLowerCase();
  const fDate    = colFilter('slf-date');
  const fProduct = colFilter('slf-product');
  const fBuyer   = colFilter('slf-buyer');

  let items = DB.sales.filter(i => {
    // Universal search across product / buyer / date / numeric (revenue,
    // profit, margin, cost). Supports "<-50" to find losses, "may 2026", etc.
    if (q && !kjrMatchUniversal(q, i, 'sales')) return false;
    if (fDate    && !kjrMatchDateFilter(fDate, i.dateSold)) return false;
    if (fProduct && !(i.product||'').toLowerCase().includes(fProduct)) return false;
    if (fBuyer   && !(i.buyer||'').toLowerCase().includes(fBuyer)) return false;
    return true;
  });

  items = _pinRecentsToTop(sortItems(items, 'sales'), 'sales');
  
  const totalRevenue = items.reduce((s,i) => s + (parseFloat(i.totalCollected)||0), 0);
  const totalCost    = items.reduce((s,i) => s + (parseFloat(i.costPrice)||0), 0);
  const totalProfit  = items.reduce((s,i) => s + (parseFloat(i.profit)||0), 0);
  const totalFees    = items.reduce((s,i) => s + (parseFloat(i.fees)||0), 0);
  const avgMargin    = totalRevenue > 0 ? ((totalProfit/totalRevenue)*100).toFixed(0) : 0;
  const profitCls    = totalProfit >= 0 ? 'pos' : 'neg';

  document.getElementById('sales-sub').textContent = '';
  const _sgd = n => Math.round(n).toLocaleString('en-SG');
  const profitDisplay = totalProfit >= 0 ? 'S$' + _sgd(totalProfit) : '-S$' + _sgd(Math.abs(totalProfit));
  document.getElementById('sales-metrics').innerHTML =
    '<div class="metric"><div class="metric-label">Total Profit</div><div class="metric-value ' + profitCls + '">' + profitDisplay + '</div></div>' +
    '<div class="metric"><div class="metric-label">Avg Margin</div><div class="metric-value ' + (avgMargin >= 0 ? 'pos' : 'neg') + '">' + avgMargin + '%</div></div>' +
    '<div class="metric"><div class="metric-label">Transactions</div><div class="metric-value">' + items.length + '</div></div>' +
    '<div class="metric"><div class="metric-label">Total Revenue</div><div class="metric-value">S$' + _sgd(totalRevenue) + '</div></div>' +
    '<div class="metric"><div class="metric-label">Total Cost</div><div class="metric-value">S$' + _sgd(totalCost) + '</div></div>' +
    (totalFees > 0 ? '<div class="metric"><div class="metric-label">Total Fees</div><div class="metric-value" style="color:var(--text2)">S$' + _sgd(totalFees) + '</div></div>' : '');
  
  const tbody = document.getElementById('sales-body');
  if (!items.length) {
    const _filtered = !!(q || fDate || fProduct || fBuyer);
    const _colCount = tbody.previousElementSibling ? tbody.previousElementSibling.querySelectorAll('th').length : 13;
    tbody.innerHTML = kjrInvEmptyRow({
      colspan: _colCount,
      filtered: _filtered,
      icon: '💰',
      title: 'No sales logged yet',
      sub: 'Record a sale from Quick Entry or the row-level Sell action and it shows up here.',
      ctaLabel: '+ Log a sale',
      ctaAction: "openCmdBar('sell')"
    });
    applyColOrder('sales');
    applyColVisibility('sales');
    attachHeaderDrag('sales');
    updateClearFiltersBtn('sales');
    return;
  }
  tbody.innerHTML = items.map(i => {
    const cls = (i.profit||0) >= 0 ? 'sale-profit-pos' : 'sale-profit-neg';
    const chk = selectedIds.sales.has(i.id);
    const product = i.product || '-';
    const isMulti = product.includes(' | ');
    const splitItems = isMulti ? product.split(' | ').map(p => p.trim()) : [];
    const totalCollected = parseFloat(i.totalCollected) || 0;
    // Build tooltip: for multi-item, show each item with its cost and % of total
    let tooltipLines;
    if (isMulti) {
      const costs = Array.isArray(i.itemCosts) && i.itemCosts.length === splitItems.length ? i.itemCosts : null;
      tooltipLines = splitItems.map((name, idx) => {
        if (costs) {
          const c = parseFloat(costs[idx]) || 0;
          return name + '  (cost S$' + c.toFixed(0) + ')';
        }
        return name;
      }).join('&#10;');
      if (costs) {
        const totalCost = costs.reduce((s, c) => s + (parseFloat(c) || 0), 0);
        tooltipLines += '&#10;─────────────&#10;Total cost: S$' + totalCost.toFixed(0);
      }
    } else {
      tooltipLines = product;
    }
    const multiDot = isMulti
      ? ' <span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:var(--bg3);border:1px solid var(--border2);font-size:9px;color:var(--text3);font-weight:600;vertical-align:middle;flex-shrink:0" title="' + splitItems.length + ' items">' + splitItems.length + '</span>'
      : '';
    const safeId = esc(i.id);
    const safeInvId = esc(i.inventoryId || '');
    const safeInvTbl = esc(i.inventoryTable || '');
    const isRecent = typeof _isRecentlyAdded === 'function' && _isRecentlyAdded('sales', i.id);
    return '<tr data-id="' + safeId + '" class="' + (chk ? 'row-selected' : '') + (isRecent ? ' recent-add' : '') + '">' +
      '<td data-col-key="_cb" class="cb-col"><input type="checkbox" class="row-cb" ' + (chk ? 'checked' : '') + ' aria-label="Select ' + esc(i.product||'row') + '" onchange="toggleRowSelect(\'sales\',\'' + safeId + '\',this.checked)"></td>' +
      '<td data-col-key="dateSold" style="font-size:12px;white-space:nowrap;color:var(--text2)">' + (toDateMmmYyyy(i.dateSold)||'-').replace(/ (\d{4})$/, '<span class="sales-yr"> $1</span>') + '</td>' +
      '<td data-col-key="product" style="max-width:220px;font-weight:500;text-align:left">' +
        '<div style="display:flex;align-items:center;gap:5px">' +
          '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;position:relative" class="sale-product-cell">' +
            '<span title="' + esc(tooltipLines) + '" style="cursor:default">' + esc(isMulti ? product.split(' | ')[0] + '…' : product) + '</span>' +
            (i.inventoryId ? ' <button class="btn btn-ghost btn-sm" style="font-size:10px;padding:1px 5px;vertical-align:middle" onclick="viewSourceItem(\'' + safeInvId + '\',\'' + safeInvTbl + '\')" title="View original inventory item">↗</button>' : '') +
          '</div>' +
          multiDot +
        '</div>' +
      '</td>' +
      '<td data-col-key="buyer" style="font-size:12px;color:var(--text2)">' + esc(i.buyer||'-') + '</td>' +
      '<td data-col-key="costPrice" class="num">' + fmt(i.costPrice) + '</td>' +
      '<td data-col-key="totalCollected" class="num" style="font-weight:500">' + fmt(i.totalCollected) + '</td>' +
      '<td data-col-key="shippingCost" class="num" style="color:var(--text3)">' + fmt(i.shippingCost) + '</td>' +
      '<td data-col-key="fees" class="num" style="color:var(--text3)">' + (parseFloat(i.fees) > 0 ? fmt(i.fees) : '-') + '</td>' +
      '<td data-col-key="channel" style="font-size:12px;color:var(--text2)">' + esc(i.channel || '-') + '</td>' +
      '<td data-col-key="daysHeld" class="num" style="color:var(--text3)">' + (i.daysHeld != null ? i.daysHeld + 'd' : '-') + '</td>' +
      '<td data-col-key="profit" class="num ' + cls + '" style="font-weight:600">' + fmtSigned(parseFloat(i.profit)||0) + '</td>' +
      '<td data-col-key="margin" class="num ' + cls + '">' + esc(i.margin||'-') + '</td>' +
      '<td data-col-key="actions" style="white-space:nowrap;text-align:center">' +
        '<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="openEditSale(\'' + safeId + '\')" title="Edit sale">✎</button>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--red);font-size:11px" onclick="deleteItem(\'' + safeId + '\',\'sales\')" title="Delete sale">✕</button>' +
      '</td>' +
    '</tr>';
  }).join('');
  applyColOrder('sales');
  applyColVisibility('sales');
  attachHeaderDrag('sales');
  updateClearFiltersBtn('sales');
}

function openAddSale() {
  document.getElementById('msa-id').value = '';
  ['msa-date','msa-product','msa-buyer','msa-cost','msa-total','msa-ship','msa-fees','msa-profit','msa-margin'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('msa-channel').value = 'Carousell';
  document.getElementById('msa-date').value = new Date().toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'});
  document.getElementById('msa-item-costs').style.display = 'none';
  document.getElementById('msa-cost-lbl-note').textContent = '';
  document.getElementById('msa-modal-title').textContent = 'Add Sale';
  openModal('modal-sale');
}

// Called when a sale is opened for editing - populate all fields including itemCosts
function openEditSale(id) {
  const item = DB.sales.find(s => s.id === id);
  if (!item) return;
  document.getElementById('msa-id').value = item.id;
  document.getElementById('msa-date').value = item.dateSold || '';
  document.getElementById('msa-product').value = item.product || '';
  document.getElementById('msa-buyer').value = item.buyer || '';
  document.getElementById('msa-cost').value = item.costPrice || '';
  document.getElementById('msa-total').value = item.totalCollected || '';
  document.getElementById('msa-ship').value = item.shippingCost || '';
  document.getElementById('msa-fees').value = item.fees || '';
  document.getElementById('msa-channel').value = item.channel || 'Carousell';
  document.getElementById('msa-profit').value = item.profit || '';
  document.getElementById('msa-margin').value = item.margin || '';
  msaOnProductChange(item.itemCosts || []);
  calcSaleProfit();
  document.getElementById('msa-modal-title').textContent = 'Edit Sale';
  openModal('modal-sale');
}

// Rebuild the per-item cost rows whenever the product field changes.
// Pass existingCosts[] to pre-fill values when editing.
function msaOnProductChange(existingCosts) {
  const product = document.getElementById('msa-product').value || '';
  const items = product.split(' | ').map(s => s.trim()).filter(Boolean);
  const isMulti = items.length > 1;
  const container = document.getElementById('msa-item-costs');
  const rowsEl = document.getElementById('msa-item-cost-rows');
  const lbl = document.getElementById('msa-cost-lbl-note');
  if (!isMulti) {
    container.style.display = 'none';
    lbl.textContent = '';
    return;
  }
  lbl.textContent = '(sum of per-item below)';
  container.style.display = '';
  const costs = Array.isArray(existingCosts) ? existingCosts : [];
  rowsEl.innerHTML = items.map((name, idx) => {
    const val = costs[idx] != null ? costs[idx] : '';
    return `<div style="display:flex;align-items:center;gap:8px">
      <div style="flex:1;font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(name)}">${esc(name)}</div>
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="font-size:12px;color:var(--text3)">S$</span>
        <input class="fi" type="number" step="0.01" min="0" placeholder="0" style="width:80px;padding:4px 8px;font-size:12px"
          value="${val}"
          oninput="msaRecalcItemCostTotal()"
          id="msa-ic-${idx}">
      </div>
    </div>`;
  }).join('');
  msaRecalcItemCostTotal();
}

// Sum per-item costs and push into the main cost field
function msaRecalcItemCostTotal() {
  const product = document.getElementById('msa-product').value || '';
  const items = product.split(' | ').map(s => s.trim()).filter(Boolean);
  let total = 0;
  items.forEach((_, idx) => {
    const el = document.getElementById('msa-ic-' + idx);
    total += el ? (parseFloat(el.value) || 0) : 0;
  });
  document.getElementById('msa-cost').value = total > 0 ? total.toFixed(2) : '';
  document.getElementById('msa-item-cost-sum').textContent = total > 0 ? 'Total: S$' + total.toFixed(2) : '';
  calcSaleProfit();
}

// Read per-item costs from the modal inputs
function msaReadItemCosts() {
  const product = document.getElementById('msa-product').value || '';
  const items = product.split(' | ').map(s => s.trim()).filter(Boolean);
  if (items.length <= 1) return null;
  return items.map((_, idx) => {
    const el = document.getElementById('msa-ic-' + idx);
    return el ? (parseFloat(el.value) || 0) : 0;
  });
}

function calcSaleProfit() {
  const cost  = kjrNum(document.getElementById('msa-cost').value);
  const total = kjrNum(document.getElementById('msa-total').value);
  const ship  = kjrNum(document.getElementById('msa-ship').value);
  const fees  = kjrNum(document.getElementById('msa-fees').value);
  const profit = total - cost - ship - fees;
  const margin = total > 0 ? ((profit/total)*100).toFixed(0) + '%' : '-';
  document.getElementById('msa-profit').value = (profit > 0 ? '+' : (profit < 0 ? '-' : '')) + Math.abs(profit).toFixed(0);
  document.getElementById('msa-margin').value = margin;
}

function saveSale() {
  const product = document.getElementById('msa-product').value.trim();
  if (!product) { toast('Product name required'); return; }
  snapshotForUndo();
  const cost    = kjrNum(document.getElementById('msa-cost').value);
  const total   = kjrNum(document.getElementById('msa-total').value);
  const ship    = kjrNum(document.getElementById('msa-ship').value);
  const fees    = kjrNum(document.getElementById('msa-fees').value);
  const channel = document.getElementById('msa-channel').value || 'Carousell';
  const profit  = total - cost - ship - fees;
  const margin  = total > 0 ? ((profit/total)*100).toFixed(0) + '%' : '-';
  const id = document.getElementById('msa-id').value;
  const itemCosts = msaReadItemCosts();
  const prevForLink = id ? DB.sales.find(s => s.id === id) : null;
  // Preserve dateAcquired/daysHeld from original sale on edit; try to backfill
  // from linked inventory row if missing.
  let dateAcquired = (prevForLink && prevForLink.dateAcquired) || '';
  let daysHeld = (prevForLink && prevForLink.daysHeld != null) ? prevForLink.daysHeld : null;
  if (!dateAcquired && prevForLink && prevForLink.inventoryId && prevForLink.inventoryTable) {
    const srcRow = (DB[prevForLink.inventoryTable] || []).find(r => r.id === prevForLink.inventoryId);
    if (srcRow) {
      dateAcquired = toDateMmmYyyy(srcRow.datePurchased || srcRow.dateListed || srcRow.date || '') || '';
      const ds = formatDateInput(document.getElementById('msa-date').value);
      daysHeld = _kjrDaysHeld(dateAcquired, ds);
    }
  }
  const item = {
    id: id || genId('sale'),
    dateSold: formatDateInput(document.getElementById('msa-date').value),
    product,
    buyer: document.getElementById('msa-buyer').value,
    costPrice: cost, totalCollected: total, shippingCost: ship,
    fees, channel,
    profit, margin,
    ...(dateAcquired ? { dateAcquired } : {}),
    ...(daysHeld !== null ? { daysHeld } : {}),
    ...(itemCosts ? { itemCosts } : {}),
    ...(prevForLink && prevForLink.inventoryId    ? { inventoryId:    prevForLink.inventoryId }    : {}),
    ...(prevForLink && prevForLink.inventoryTable ? { inventoryTable: prevForLink.inventoryTable } : {})
  };
  const norm = normalizeRecord('sales', item);
  let beforeSale = null;
  if (id) {
    const prev = DB.sales.find(s => s.id === id);
    if (prev) beforeSale = { ...prev };
    DB.sales = DB.sales.map(s => s.id === id ? norm : s);
  }
  else { DB.sales.unshift(norm); if (typeof _pinRecentlyAdded === 'function') _pinRecentlyAdded('sales', norm.id); }
  markDirty('sales', norm.id);
  saveData(); closeModal('modal-sale', true); renderSales(); // force: already saved
  toast(id ? 'Updated!' : 'Sale recorded!');
  const extraSale = id ? (_clDiff('sales', beforeSale, norm) || 'no field changes') : _clSummary('sales', norm);
  clLog(id ? 'edit' : 'sell', 'sales', product, extraSale);
}

// =========== DASHBOARD ===========
let dashCharts = {};
let aiChatHistory = [];

function getDateRange() {
  const sel = document.getElementById('dash-range');
  const val = sel ? sel.value : '12';
  if (val === 'all') return null;
  const months = parseInt(val);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff;
}

// ── Total Market Value breakdown viewer ──────────────────────────
// Opens a modal that lists every Singles / Slabs row currently contributing
// to "Total Market Value" - sorted by contribution DESC. Shows the source
// of each value (explicit marketPrice vs cost basis) so the user can audit
// the headline figure without digging through the per-tab tables.
function showMarketValueBreakdown() {
  const contribs = [];
  (DB.singles||[]).filter(i => (i.status||'Available') === 'Available').forEach(i => {
    const explicit = parseFloat(i.marketPrice);
    const qty      = parseInt(i.qty)||1;
    let unit = 0, source = '-';
    if (!isNaN(explicit) && explicit > 0)   { unit = explicit; source = 'marketPrice (manual or API)'; }
    if (unit > 0) {
      contribs.push({
        table: 'singles', name: i.name, meta: [i.set, i.language, i.condition].filter(Boolean).join(' · '),
        unit, qty, contrib: unit * qty, source
      });
    } else {
      // No live price - renderDashboard's getMkt() falls back to costPrice so
      // the headline isn't dragged to zero. Mirror that fallback here as a
      // labelled row, otherwise the modal total undercounts vs the headline.
      const costUnit = parseFloat(i.costPrice) || 0;
      if (costUnit > 0) contribs.push({
        table: 'singles', name: i.name, meta: [i.set, i.language, i.condition].filter(Boolean).join(' · '),
        unit: costUnit, qty, contrib: costUnit * qty, source: 'cost basis (unpriced)'
      });
    }
  });
  (DB.slabs||[]).filter(i => (i.status||'Available') === 'Available').forEach(i => {
    const explicit = parseFloat(i.marketPrice);
    let unit = 0, source = '-';
    if (!isNaN(explicit) && explicit > 0)   { unit = explicit; source = 'marketPrice (manual or API)'; }
    if (unit > 0) {
      contribs.push({
        table: 'slabs', name: i.name, meta: [i.grader, i.grade, i.certNo ? '#'+i.certNo : ''].filter(Boolean).join(' '),
        unit, qty: 1, contrib: unit, source
      });
    } else {
      const costUnit = parseFloat(i.costPrice) || 0;
      if (costUnit > 0) contribs.push({
        table: 'slabs', name: i.name, meta: [i.grader, i.grade, i.certNo ? '#'+i.certNo : ''].filter(Boolean).join(' '),
        unit: costUnit, qty: 1, contrib: costUnit, source: 'cost basis (unpriced)'
      });
    }
  });
  contribs.sort((a,b) => b.contrib - a.contrib);
  const total = contribs.reduce((s,c) => s + c.contrib, 0);
  const fmt = n => 'S$' + (Math.round(n*100)/100).toLocaleString('en-SG', { maximumFractionDigits: 2 });
  const rows = contribs.length === 0
    ? '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text3)">No rows have a Market Price set yet. Total Market Value is correctly 0.</td></tr>'
    : contribs.map(c =>
        '<tr>' +
          '<td><span class="badge ' + (c.table==='slabs'?'b-slab':'b-raw') + '">' + (c.table==='slabs'?'SLAB':'SINGLE') + '</span></td>' +
          '<td style="text-align:left">' + esc(c.name||'-') + (c.meta ? '<div style="font-size:11px;color:var(--text3);margin-top:2px">'+esc(c.meta)+'</div>' : '') + '</td>' +
          '<td class="num">' + fmt(c.unit) + '</td>' +
          '<td class="num">' + c.qty + '</td>' +
          '<td class="num"><strong>' + fmt(c.contrib) + '</strong></td>' +
          '<td style="font-size:11px;color:var(--text3)">' + esc(c.source) + '</td>' +
        '</tr>'
      ).join('');
  const existing = document.getElementById('mvbreakdown-modal');
  if (existing) existing.remove();
  const html =
    '<dialog id="mvbreakdown-modal" class="overlay">' +
      '<div class="modal" style="max-width:780px;width:95vw">' +
        '<div class="modal-head">' +
          '<h3>Total Market Value · breakdown</h3>' +
          '<button class="btn btn-ghost btn-sm" onclick="kjrModalCtrl.close(document.getElementById(\'mvbreakdown-modal\'), true)">✕</button>' +
        '</div>' +
        '<div class="modal-body" style="max-height:70vh;overflow-y:auto">' +
          '<div style="font-size:12px;color:var(--text2);margin-bottom:12px;line-height:1.6">' +
            'Every Available single + slab whose market price resolves to &gt; 0. Singles multiply by qty.' +
            ' Total here must equal the dashboard headline: <strong>' + fmt(total) + '</strong>.' +
            (contribs.length ? ' Sorted by contribution descending.' : '') +
          '</div>' +
          '<div class="tbl-wrap"><table style="width:100%;font-size:12px">' +
            '<thead><tr>' +
              '<th>Type</th><th style="text-align:left">Item</th>' +
              '<th class="num">Unit price</th><th class="num">Qty</th>' +
              '<th class="num">Contribution</th><th>Source</th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
            (contribs.length ? '<tfoot><tr style="border-top:2px solid var(--border2)">' +
              '<td colspan="4" style="padding-top:10px;text-align:right;font-weight:600">Total</td>' +
              '<td class="num" style="padding-top:10px;font-weight:700;font-size:14px">' + fmt(total) + '</td>' +
              '<td></td></tr></tfoot>' : '') +
          '</table></div>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<div style="font-size:11px;color:var(--text3);margin-right:auto">' + contribs.length + ' row' + (contribs.length===1?'':'s') + ' contributing</div>' +
          '<button class="btn" onclick="kjrModalCtrl.close(document.getElementById(\'mvbreakdown-modal\'), true)">Close</button>' +
        '</div>' +
      '</div>' +
    '</dialog>';
  document.body.insertAdjacentHTML('beforeend', html);
  // dialog + kjrModalCtrl: Esc, backdrop click, focus trap and scroll lock all
  // come from the controller (it binds cancel + backdrop-click on open), and
  // the node self-removes once closed since it is rebuilt on every open.
  const mvEl = document.getElementById('mvbreakdown-modal');
  mvEl.addEventListener('close', () => mvEl.remove(), { once: true });
  kjrModalCtrl.open(mvEl);
}

// Pure stat computations for the Dashboard - no DOM reads/writes, so this can
// be called from both renderDashboard() and the Excel export (exportXlsx())
// without touching the page. Extracted from renderDashboard() during the
// v3.15 Excel-export build; keep every value renderDashboard() destructures
// below in sync with what this returns, or the live Dashboard throws.
function computeDashboardStats() {
  // ── Inventory cost - Singles, Slabs, Sealed (ETBs + Booster Boxes + Packs)
  // Multiplies by qty where applicable. Slabs are always qty=1.
  const invCostSingles = DB.singles.filter(i => (i.status||'Available') === 'Available').reduce((s,i) => s + (parseFloat(i.costPrice)||0)*(parseInt(i.qty)||1), 0);
  const invCostSlabs   = DB.slabs.filter(i => (i.status||'Available') === 'Available').reduce((s,i) => s + (parseFloat(i.costPrice)||0), 0);

  // ── Sealed bucket = ETBs (In Stock) + Booster Boxes (Unopened) + Booster Packs (Sealed)
  const etbInStock = (DB.etbs || []).filter(r => /in\s*stock/i.test(r.status||''));
  const bbInStock  = (DB.boosterBoxes|| []).filter(r => /unopened/i.test(r.status||''));
  const bpInStock  = (DB.boosterPacks|| []).filter(r => /sealed/i.test(r.status||''));
  const invCostEtb = etbInStock.reduce((s,r) => s + (parseFloat(r.totalPrice)||0), 0);
  const invCostBb  = bbInStock.reduce((s,r) => s + (parseFloat(r.totalPrice)||0), 0);
  const invCostBp  = bpInStock.reduce((s,r) => s + (parseFloat(r.totalPrice)||0), 0);
  const invCostSealed = invCostEtb + invCostBb + invCostBp;
  // Grand total - what the collector has at cost across the whole portfolio.
  const totalInvCost = invCostSingles + invCostSlabs + invCostSealed;

  // ── Market value - Singles + Slabs ONLY (sealed inventory is priced
  // manually and isn't part of the auto-refresh freshness story; per
  // owner decision the headline "Total Market Value" stays scoped to
  // singles + slabs so it agrees with the "% priced · refreshed" chip
  // sitting underneath it. Sealed value is still computed for the
  // exposure breakdown card below.).
  // getMkt: explicit marketPrice, else cost so unpriced items don't drag the
  // headline towards zero. The freshness chip below still shows true live
  // coverage, and the sealed bucket already uses this same cost fallback.
  // (table arg kept for call-site compatibility; no longer used internally.)
  const getMkt = (i, table) => {
    const explicit = parseFloat(i.marketPrice);
    if (!isNaN(explicit) && explicit > 0) return explicit;
    return parseFloat(i.costPrice) || 0;
  };
  const mktSingles   = DB.singles.filter(i => (i.status||'Available') === 'Available').reduce((s,i) => s + getMkt(i, 'singles')*(parseInt(i.qty)||1), 0);
  const mktSlabs     = DB.slabs.filter(i => (i.status||'Available') === 'Available').reduce((s,i) => s + getMkt(i, 'slabs'), 0);
  // Sealed market value - used for the exposure breakdown card only.
  // Behavior: use real marketPrice when set. If unset, fall back to cost
  // (so an un-priced row doesn't read as zero exposure). Previously this
  // returned max(market, cost), which biased sealed P&L positive and hid
  // real drawdowns - a Booster Box trading below cost would still read flat.
  const sealedMkt = (rows) => rows.reduce((s,r) => {
    const m = parseFloat(r.marketPrice);
    if (!isNaN(m) && m > 0) return s + m;
    const c = parseFloat(r.totalPrice) || 0;
    return s + c;
  }, 0);
  const mktEtb = sealedMkt(etbInStock);
  const mktBb  = sealedMkt(bbInStock);
  const mktBp  = sealedMkt(bpInStock);
  const mktSealed = mktEtb + mktBb + mktBp;
  // Headline Total Market Value: Singles + Slabs only - matches the
  // freshness chip's scope. If the user has no marketPrice anywhere on
  // Singles/Slabs, this is correctly 0 (no more silent padding from
  // sealed cost basis).
  const totalMktValue = mktSingles + mktSlabs;
  // Unrealised P/L - headline market value less the cost basis actually
  // driving it (Singles + Slabs only, matching totalMktValue's scope).
  const unrealisedPL = totalMktValue - (invCostSingles + invCostSlabs);

  // ── Sales stats (filtered by date range) ──
  const cutoff = getDateRange();
  const filteredSales = cutoff
    ? DB.sales.filter(s => { const k = normaliseToMonthYear(s.dateSold); if (!k) return false; return new Date('1 ' + k) >= cutoff; })
    : DB.sales;

  const totalRevenue   = filteredSales.reduce((s,i) => s + (i.totalCollected||0), 0);
  const totalProfit    = filteredSales.reduce((s,i) => s + (i.profit||0), 0);
  const avgProfitPerTx = filteredSales.length > 0 ? (totalProfit / filteredSales.length) : 0;

  // KPI tiles are always lifetime - the range picker only filters the charts
  // below, never the four headline numbers (owner decision, 29/05/2026).
  const allTimeSales   = DB.sales;
  const allTimeRevenue = allTimeSales.reduce((s,i) => s + (i.totalCollected||0), 0);
  const allTimeProfit  = allTimeSales.reduce((s,i) => s + (i.profit||0), 0);
  // Realised ROI = Profit ÷ Cost basis of sold items × 100 (null when there's
  // nothing sold yet, so callers can render "-" instead of a false 0%).
  const roiPct = (allTimeSales.length === 0 || allTimeRevenue === 0)
    ? null
    : (allTimeProfit / Math.max(1, allTimeRevenue - allTimeProfit)) * 100;

  // ── Counts ──
  const singlesAvail = DB.singles.filter(i => (i.status||'Available') === 'Available').length;
  const singlesSold  = DB.singles.filter(i => (i.status||'Available') === 'Sold').length;
  const slabsAvail   = DB.slabs.filter(i => (i.status||'Available') === 'Available').length;
  const slabsSold    = DB.slabs.filter(i => (i.status||'Available') === 'Sold').length;
  const totalItems   = singlesAvail + slabsAvail;

  // Row 1 - KPIs (now full-portfolio: singles + slabs + sealed)
  const sealedItemCount = etbInStock.length + bbInStock.reduce((s,r)=>s+(parseInt(r.qty)||1),0) + bpInStock.reduce((s,r)=>s+(parseInt(r.qty)||1),0);
  const grandItemCount  = singlesAvail + slabsAvail + sealedItemCount;

  return {
    invCostSingles, invCostSlabs, etbInStock, bbInStock, bpInStock,
    invCostEtb, invCostBb, invCostBp, invCostSealed, totalInvCost,
    mktSingles, mktSlabs, mktEtb, mktBb, mktBp, mktSealed, totalMktValue, unrealisedPL,
    cutoff, filteredSales, totalRevenue, totalProfit, avgProfitPerTx,
    allTimeSales, allTimeRevenue, allTimeProfit, roiPct,
    singlesAvail, singlesSold, slabsAvail, slabsSold, totalItems,
    sealedItemCount, grandItemCount,
  };
}

function renderDashboard() {
  const {
    invCostSingles, invCostSlabs, etbInStock, bbInStock, bpInStock,
    invCostEtb, invCostBb, invCostBp, invCostSealed, totalInvCost,
    mktSingles, mktSlabs, mktEtb, mktBb, mktBp, mktSealed, totalMktValue, unrealisedPL,
    cutoff, filteredSales, totalRevenue, totalProfit, avgProfitPerTx,
    allTimeSales, allTimeRevenue, allTimeProfit, roiPct,
    singlesAvail, singlesSold, slabsAvail, slabsSold, totalItems,
    sealedItemCount, grandItemCount,
  } = computeDashboardStats();

  // Cards show just a centred label + value. The old sub-line is gone; any
  // useful detail now lives in the (i) tooltip. `trust` is optional: when
  // present it renders a persistent coloured dot beside the (i) that warns
  // about data trustability, with its coverage/freshness text shown on hover.
  function dashMetric(label, value, tooltip, cls, trust) {
    const trustDot = trust
      ? '<button class="metric-trust" type="button" aria-label="Data trust" onclick="kjrToggleTooltip(this,event)">' +
          '<span class="metric-trust-dot" style="background:' + trust.color + '"></span>' +
          '<span class="inv-stat-tooltip">' + trust.text + '</span>' +
        '</button>'
      : '';
    return '<div class="metric">' +
      trustDot +
      '<button class="metric-info" type="button" aria-label="Info" onclick="kjrToggleTooltip(this,event)">i<span class="inv-stat-tooltip">' + tooltip + '</span></button>' +
      '<div class="metric-label">' + label + '</div>' +
      '<div class="metric-value' + (cls ? ' ' + cls : '') + '">' + value + '</div>' +
    '</div>';
  }

  const rangeLabel = (document.getElementById('dash-range')?.options[document.getElementById('dash-range')?.selectedIndex]?.text || '');

  // sealedItemCount / grandItemCount now come from computeDashboardStats()
  // (destructured above) - was previously recomputed here (Row 1 KPIs).

  // ── Market-value data freshness ─────────────────────────────────────
  // Prices on Singles + Slabs come from the two-lane refresh queue (free
  // TCGdex for raw singles, PPT for slabs and TCGdex misses).
  // Sealed inventory uses manually entered marketPrice and isn't auto-
  // refreshed, so we exclude it from the freshness chip - that's the right
  // semantics for "0% priced" because the queue can't price sealed items.
  // Tell the user (1) what % of available singles+slabs have any price,
  // (2) how recent the latest batch is, (3) % refreshed in the last 7 days,
  // and (4) whether the auto-refresh queue is even running.
  const pricedItems = [];   // items with any market signal
  const allItems    = [];
  // collect: priced = has a live marketPrice. (table arg kept for call-site
  // compatibility; no longer used internally now the cache layer is gone.)
  const collect = (i, w, table) => {
    allItems.push({ item: i, weight: w });
    const m = parseFloat(i.marketPrice);
    if (!isNaN(m) && m > 0) pricedItems.push({ item: i, weight: w });
  };
  DB.singles.filter(i => (i.status||'Available') === 'Available').forEach(i => collect(i, parseInt(i.qty)||1, 'singles'));
  DB.slabs.filter(i => (i.status||'Available') === 'Available').forEach(i => collect(i, 1, 'slabs'));
  const pricedCount = pricedItems.length;
  const allCount    = allItems.length;
  const coveragePct = allCount > 0 ? Math.round((pricedCount / allCount) * 100) : 0;
  // Auto-refresh queue status - surface "queue not built" vs "queue running"
  // so the user knows whether the system is actually trying to price.
  const _queueState = (typeof loadQueue === 'function') ? loadQueue() : null;
  const _todayStr = new Date().toISOString().slice(0,10);
  const _queueToday = _queueState && _queueState.dayCreditsUsed?.[_todayStr] || 0;
  const _queueExists = !!_queueState;
  const _queueDone   = _queueState && _queueState.completed; // PPT lane only - see buildRefreshQueue/lane split
  // PPT/Search lane's remaining count. q.items only becomes PPT-lane-only
  // AFTER the first run of the day splices the tcgdex lane out (see
  // _runRefreshQueueBody) - filter by lane explicitly rather than assuming
  // that's already happened, or a freshly built unrun queue would count
  // tcgdex-lane cards as "PPT cards left" too (same class of bug fixed in
  // _renderQueueStatus's singlesTotal/singlesDone).
  const _queueLeft   = _queueState ? Math.max(0, _queueState.items.filter(i => i.lane === 'ppt').length - _queueState.cursor) : 0;
  // Free lane's own progress - persisted separately since its items don't
  // stay in q.items after a pass (see _runRefreshQueueBody).
  const _tcgdexTotal = _queueState?.lastTcgdexTotal || 0;
  const _tcgdexDone   = _queueState?.lastTcgdexDone  || 0;
  const _tcgdexRanToday = _queueState?.lastTcgdexPass === _todayStr;
  // Unresolved / manual-language counts for the tooltip - same definitions
  // as the Price API Settings panel (_kjrUnresolvedSingles / _kjrManualLangCards).
  const _unresolvedCount = (typeof _kjrUnresolvedSingles === 'function') ? _kjrUnresolvedSingles().length : 0;
  const _manualLangCount = (typeof _kjrManualLangCards === 'function') ? _kjrManualLangCards().length : 0;
  // A blocked/rate-limited price API stamps lastPausedReason. Surface it so a
  // stalled "5% priced" reads as "the vendor key is blocked" not "app broken".
  const _queuePaused = _queueState && _queueState.lastPausedReason;
  const _queueKeyBlocked = _queuePaused && /403|401|blocked|abuse|invalid|unauthor|key/i.test(_queuePaused);
  // Latest priceHistory entry across all priced items → "freshness".
  const sevenDaysAgo = Date.now() - 7*24*3600*1000;
  let latestTs = 0;
  let freshIn7d = 0;
  pricedItems.forEach(({ item }) => {
    const hist = Array.isArray(item.priceHistory) ? item.priceHistory : [];
    if (hist.length === 0) return;
    const last = hist[hist.length - 1];
    const ts = last && last.date ? new Date(last.date + 'T00:00:00').getTime() : 0;
    if (ts > latestTs) latestTs = ts;
    if (ts >= sevenDaysAgo) freshIn7d++;
  });
  const freshPct = pricedCount > 0 ? Math.round((freshIn7d / pricedCount) * 100) : 0;
  // Human-readable "X ago"
  const agoFromTs = (ts) => {
    if (!ts) return 'never';
    const days = Math.floor((Date.now() - ts) / (24*3600*1000));
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7)   return days + 'd ago';
    if (days < 30)  return Math.floor(days/7) + 'w ago';
    return Math.floor(days/30) + 'mo ago';
  };
  // Bucket colour: green = mostly fresh; amber = partially stale; red = stale or no data
  let freshClass = 'neg', freshLabel = 'stale';
  if (coveragePct >= 80 && freshPct >= 70) { freshClass = 'pos'; freshLabel = 'fresh'; }
  else if (coveragePct >= 50 && freshPct >= 30) { freshClass = ''; freshLabel = 'mixed'; }
  const freshSub = totalMktValue > 0
    ? coveragePct + '% covered · ' + freshPct + '% refreshed ≤7d · last ' + agoFromTs(latestTs)
    : 'No market prices set yet';
  // Tooltip explains the chip in full so the user can diagnose why
  // "refreshed never" if the queue is stalled. Two lanes now: Exact (TCGdex)
  // is free and runs a full pass once a day; Search (PPT) is capped at
  // DAILY_LIMIT/day and covers slabs plus any TCGdex miss - the per-lane
  // wording is built into _chipText/_laneNote below (kept as one flowing
  // sentence rather than a separate paragraph, since the tooltip span this
  // feeds renders as plain white-space:normal HTML - see the note there).
  // Appended (not a separate paragraph) to the trust-dot tooltip below -
  // that tooltip renders as a single raw HTML span with white-space:normal
  // (see dashMetric()/.inv-stat-tooltip in styles.css), so a literal "\n"
  // collapses to nothing visible. <br> is used instead where a line break
  // is genuinely wanted; these two are short enough to just flow as extra
  // clauses onto the existing one-line chip text.
  const _unresolvedDiag = _unresolvedCount > 0 ? (' · ' + _unresolvedCount + ' unresolved, add the card number for exact pricing') : '';
  const _manualLangDiag = _manualLangCount > 0 ? (' · ' + _manualLangCount + ' non-English card' + (_manualLangCount!==1?'s':'') + ' priced manually') : '';

  // Show coverage + queue status WHENEVER there is Singles/Slabs inventory
  // to price - even when nothing is priced yet (totalMktValue == 0). The
  // chip is most useful precisely in that "0% priced" state, because it
  // tells the user the auto-refresh is bootstrapping. Only suppress the
  // chip when there's no inventory at all on Singles/Slabs.
  const hasPriceableInventory = allCount > 0;
  // Colour rules:
  //   red    → has inventory but no queue + no manual prices (broken state)
  //   amber  → queue running OR partial coverage / partial freshness
  //   green  → ≥80% covered and ≥70% refreshed ≤7d
  let _chipClass = freshClass;
  if (_queuePaused) {
    _chipClass = 'neg'; // red - a blocked/paused price API needs attention
  } else if (hasPriceableInventory && pricedCount === 0 && (!_queueExists || latestTs === 0)) {
    _chipClass = ''; // amber - clearly "in progress" not "broken"
  } else if (hasPriceableInventory && totalMktValue > 0 && (!_queueExists || (!_queueDone && latestTs === 0))) {
    _chipClass = ''; // amber
  }
  const freshDot   = _chipClass === 'pos' ? 'var(--green)' : (_chipClass === 'neg' ? 'var(--red)' : 'var(--amber)');
  // Compact TCGdex-lane note appended to the one-line chip tooltip below.
  const _laneNote = ' · Exact (TCGdex): ' + (_tcgdexRanToday ? _tcgdexDone + '/' + _tcgdexTotal + ' today' : (_tcgdexTotal ? _tcgdexDone + '/' + _tcgdexTotal + ' last run' : 'pending'));
  const _chipText = (_queuePaused
    ? coveragePct + '% priced (' + pricedCount + '/' + allCount + ') · ' + (_queueKeyBlocked ? '⚠ price API key blocked' : '⏸ paused, will retry')
    : (!_queueExists
        ? coveragePct + '% priced (' + pricedCount + '/' + allCount + ') · auto-refresh starting'
        : (_queueDone
            ? coveragePct + '% priced (' + pricedCount + '/' + allCount + ') · Search (PPT) complete'
            : (latestTs === 0
                ? coveragePct + '% priced (' + pricedCount + '/' + allCount + ') · Search (PPT) ' + _queueToday + '/' + DAILY_LIMIT + ' today, ' + _queueLeft + ' left'
                : coveragePct + '% priced (' + pricedCount + '/' + allCount + ') · refreshed ' + agoFromTs(latestTs))))
    ) + (_queueExists ? _laneNote : '') + _unresolvedDiag + _manualLangDiag;
  // Drop the leading "+" on profit - the green colour already signals positive.
  const profitDisplay = allTimeSales.length === 0 ? '-'
    : (allTimeProfit >= 0 ? 'S$' + Math.round(allTimeProfit).toLocaleString('en-SG') : '-S$' + Math.abs(Math.round(allTimeProfit)).toLocaleString('en-SG'));
  // roiPct now comes from computeDashboardStats() (destructured above).
  const roiDisplay = roiPct == null ? '-' : Math.round(roiPct) + '%';
  // Trust dot for Total Market Value: the dot colour warns at a glance how
  // trustworthy the figure is (red = low coverage / stale), and the coverage +
  // freshness line (e.g. "5% priced (35/740) · refreshed yesterday") shows on
  // hover. Only shown when there is Singles/Slabs inventory to price.
  const trustMeta = hasPriceableInventory ? { color: freshDot, text: _chipText } : null;
  document.getElementById('dash-metrics-primary').innerHTML =
    dashMetric('Total Cost', 'S$' + Math.round(totalInvCost).toLocaleString('en-SG'),
      'Cost basis across Singles + Slabs + Sealed (ETBs / Booster Boxes / Packs in stock). ' + grandItemCount + ' units in stock.') +
    dashMetric('Total Market Value',
      (totalMktValue > 0 ? 'S$' + Math.round(totalMktValue).toLocaleString('en-SG') : '-') +
        // Tiny "view breakdown" affordance - clicking it lists every
        // Singles/Slabs row currently contributing to this figure, so the
        // user can trace S$X back to the exact items that produced it.
        ' <button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 6px;vertical-align:middle;margin-left:4px;color:var(--text3)" onclick="showMarketValueBreakdown()" title="See which rows make up this total">⋯</button>',
      'Estimated value of Available Singles + Slabs: live market price where we have one, your cost price for items not yet priced. The coloured dot warns how trustworthy this number is right now (hover it for live coverage). Sealed inventory is shown separately in the breakdown card. Click the ⋯ button to see every row contributing to this total.',
      '',
      trustMeta) +
    dashMetric('All-time Profit', profitDisplay,
      'Sum of profit across every sale you have ever logged (' + allTimeSales.length + (allTimeSales.length === 1 ? ' sale' : ' sales') + '). Not affected by the range picker.',
      allTimeProfit >= 0 ? 'pos' : 'neg') +
    dashMetric('Realised ROI', roiDisplay,
      'Realised ROI = Profit ÷ Cost basis of sold items × 100. Tells you the multiplier on the money you actually put in. If you bought S$56 of cards and sold them for S$100, profit is S$44 and ROI is 78%.' + (allTimeSales.length === 0 ? ' No sales logged yet.' : ''),
      (roiPct ?? 0) >= 0 ? 'pos' : 'neg');

  // Toggle handler for the Sealed sub-rows dropdown.
  window._toggleExposureSub = function(key){
    const sub = document.getElementById('exp-sub-' + key);
    const caret = document.getElementById('exp-caret-' + key);
    if (!sub) return;
    const open = sub.style.display !== 'none';
    sub.style.display = open ? 'none' : 'block';
    if (caret) caret.style.transform = open ? '' : 'rotate(90deg)';
  };

  // ── Capital Exposure + Inventory (merged) ──────────────────────────
  // One card: stacked bar showing % $ in Singles / Slabs / Sealed, plus a
  // detail row per segment with count, $, and % of capital. Sealed is
  // expanded into its three sub-tables (ETBs / Booster Boxes / Packs) so the
  // user can see the breakdown without leaving the dashboard.
  const expBody  = document.getElementById('dash-exposure-body');
  const expTotal = document.getElementById('dash-exposure-total');
  if (expBody) {
    if (totalInvCost <= 0) {
      expBody.innerHTML = '<div class="exp-empty">Add some inventory to see exposure breakdown.</div>';
      if (expTotal) expTotal.textContent = '';
    } else {
      const sealedCount = etbInStock.length + bbInStock.length + bpInStock.length;
      const segments = [
        { key:'singles', label:'Singles', count: singlesAvail, amt: invCostSingles, cls: 'exp-seg-singles', color: 'color-mix(in srgb,var(--cat1) 82%,black)' },
        { key:'slabs',   label:'Slabs',   count: slabsAvail,   amt: invCostSlabs,   cls: 'exp-seg-slabs',   color: 'color-mix(in srgb,var(--cat2) 90%,black)' },
        { key:'sealed',  label:'Sealed',  count: sealedCount,  amt: invCostSealed,  cls: 'exp-seg-sealed',  color: 'color-mix(in srgb,var(--cat3) 65%,black)',
          // Per-sub-table breakdown rendered as a collapsible dropdown under
          // the Sealed row. Uses the same "Label $amount (N units)" pattern.
          subRows: [
            { label:'ETBs',          count: etbInStock.length, amt: invCostEtb },
            { label:'Booster Boxes', count: bbInStock.length,  amt: invCostBb },
            { label:'Booster Packs', count: bpInStock.length,  amt: invCostBp },
          ] },
      ];
      const visible = segments.filter(s => s.amt > 0);
      const barHtml = visible.map(s => {
        const p = (s.amt / totalInvCost) * 100;
        const label = p >= 9 ? (s.label + ' ' + Math.round(p) + '%') : '';
        return `<div class="exp-seg ${s.cls}" style="width:${p.toFixed(2)}%" title="${s.label} · S$${Math.round(s.amt)} (${s.count} units · ${Math.round(p)}%)">${label}</div>`;
      }).join('');
      // Detail rows: "Singles $8730 (634 units)" - % is already shown in the
      // bar above so we don't repeat it here. Sealed has a collapsible
      // dropdown showing the ETB / Booster Box / Pack sub-totals.
      const detailHtml = segments.map(s => {
        const hasSub = Array.isArray(s.subRows) && s.subRows.length > 0;
        const caret = hasSub
          ? `<span id="exp-caret-${s.key}" style="color:var(--accent);font-size:18px;font-weight:700;width:18px;display:inline-block;text-align:center;line-height:1;transition:transform 0.15s">▸</span>`
          : '<span style="width:18px;display:inline-block"></span>';
        const clickAttr = hasSub ? `onclick="_toggleExposureSub('${s.key}')" style="cursor:pointer"` : 'style="cursor:default"';
        const mainRow = `<div class="exp-row" ${clickAttr}>
          ${caret}
          <span class="exp-legend-dot" style="background:${s.color}"></span>
          <span class="exp-main-label">${s.label} <span class="exp-amt">S$${Math.round(s.amt).toLocaleString('en-SG')}</span> <span style="color:var(--text3);font-weight:400">(${s.count} units)</span></span>
        </div>`;
        const subHtml = hasSub
          ? `<div id="exp-sub-${s.key}" class="exp-sub" style="display:none">
              ${s.subRows.map(r => `<div class="exp-sub-row">
                <span style="color:var(--text2)">${r.label}</span>
                <span style="color:var(--text);font-weight:500">S$${Math.round(r.amt).toLocaleString('en-SG')}</span>
                <span style="color:var(--text3);font-size:12px">(${r.count} units)</span>
              </div>`).join('')}
            </div>`
          : '';
        return mainRow + subHtml;
      }).join('');
      expBody.innerHTML = `<div class="exp-bar">${barHtml}</div>
        <div style="margin-top:16px">${detailHtml}</div>`;
      if (expTotal) expTotal.textContent = '';
    }
  }

  // Destroy any leftover chart instances
  Object.values(dashCharts).forEach(c => { try { c.destroy && c.destroy(); } catch(e) {} });
  dashCharts = {};

  // Init AI analyst quick chips
  initAiAnalyst();
}

// =========== AI ANALYST ===========
// Each chip = { icon, label (shown on the pill), prompt (sent to AI) }.
// Labels are short & action-oriented; prompts are full questions with
// concrete asks so the AI returns specific numbers / lists rather than
// generic fluff.
const AI_QUICK_PROMPTS = [
  { icon: '📈', label: 'Top 5 winners',        prompt: 'List my top 5 cards by unrealised gain (market price minus cost price), with the gain amount and % return for each. Format as a numbered list.' },
  { icon: '📉', label: 'Underwater cards',     prompt: 'List every card where market price is below cost price. For each show the loss in S$ and % drop. Sort by largest loss first.' },
  { icon: '💰', label: 'Best sales',            prompt: 'Show my top 5 most profitable sales of all time, with product, sold price, profit, and margin %.' },
  { icon: '🌏', label: 'EN vs JP exposure',    prompt: 'Compare my capital deployed in English vs Japanese cards. Show absolute S$ in each, % split, and average margin if there are sales in each.' },
  { icon: '🎴', label: 'Top Pokémon',           prompt: 'Which Pokémon characters have I invested the most capital in? Top 8 by total cost basis across all my singles and slabs.' },
  { icon: '🏆', label: 'Slabs vs Raw',         prompt: 'Compare slabs vs raw singles: how much capital in each, average margin on sales, and which has performed better overall?' },
  { icon: '⚠️', label: 'Missing prices',       prompt: 'How many available cards have no market price set? List up to 10 of them by cost price descending.' },
  { icon: '📊', label: 'Margin trend',          prompt: 'What is my average profit margin across all sales? Has it improved over time? Show monthly averages if there is enough data.' },
  { icon: '🏪', label: 'By channel',            prompt: 'Break down my sales by channel (Carousell, eBay, In person, etc). Show revenue, net profit, margin %, and sale count for each channel.' },
  { icon: '⏱', label: 'Holding speed',          prompt: 'What is my average days-held across all sold items? Break it down by category (Singles, Slabs, Sealed) if possible. Which cards took the longest to sell?' },
];

function initAiAnalyst() {
  const chips = document.getElementById('ai-quick-chips');
  // Update the subline to show which provider is actually active right now
  // (e.g. "Using Gemini - free" vs "No key - click 🔑 to add one").
  const sub = document.getElementById('ai-panel-subline');
  if (sub && typeof _resolveAIProvider === 'function') {
    const p = _resolveAIProvider();
    const labels = { gemini: 'Google Gemini (free)', groq: 'Groq Llama-3 (free)', openrouter: 'OpenRouter', anthropic: 'Anthropic Claude' };
    sub.textContent = p
      ? 'Using ' + (labels[p] || p) + ' · Ask anything about your cards'
      : 'No AI key set - click 🔑 in topbar (Gemini and Groq are free)';
    sub.style.color = p ? 'var(--text3)' : 'var(--amber)';
  }
  if (!chips || chips.dataset.init) return;
  chips.dataset.init = '1';
  // Build the pills as DOM nodes (rather than innerHTML with onclick="…") so
  // we can safely attach handlers without worrying about quote escaping inside
  // the prompt string. The old `onclick="sendAiPrompt(' + JSON.stringify(p) + ')"`
  // produced invalid HTML when the JSON contained double quotes, so clicks
  // never fired.
  chips.innerHTML = '';
  AI_QUICK_PROMPTS.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'ai-chip-pill';
    btn.innerHTML = '<span class="ai-chip-icon">' + p.icon + '</span><span>' + esc(p.label) + '</span>';
    btn.title = p.prompt;
    btn.addEventListener('click', () => sendAiPrompt(p.prompt));
    chips.appendChild(btn);
  });
}

function toggleAiPanel() {
  const body = document.getElementById('ai-analyst-body');
  const icon = document.getElementById('ai-panel-toggle-icon');
  const hidden = body.style.display === 'none';
  body.style.display = hidden ? '' : 'none';
  icon.textContent = hidden ? '▲ Hide' : '▼ Show';
}

function clearAiChat() {
  aiChatHistory = [];
  const histEl = document.getElementById('ai-chat-history');
  const vizArea = document.getElementById('ai-viz-area');
  const vizContent = document.getElementById('ai-viz-content');
  if (histEl) histEl.innerHTML = '';
  if (vizArea) vizArea.style.display = 'none';
  if (vizContent) vizContent.innerHTML = '';
}

// Always start with a clean UI on page load. The "Push to GitHub Pages"
// feature serialises the live DOM via `document.documentElement.outerHTML`,
// so ANY transient overlay / modal / dropdown / chat that was visible at
// push time gets baked into the published HTML and re-appears on next load.
// This sweep scrubs every known ephemeral piece so each session starts fresh.
function _resetEphemeralUi(){
  try { clearAiChat(); } catch(e) {}
  // AI Portfolio Analyst is opt-in: start every session collapsed, regardless
  // of whatever open/closed state got baked into a published GitHub snapshot.
  const aiBody = document.getElementById('ai-analyst-body');
  const aiIcon = document.getElementById('ai-panel-toggle-icon');
  if (aiBody) aiBody.style.display = 'none';
  if (aiIcon) aiIcon.textContent = '▼ Show';
  // GitHub push modal
  const gh = document.getElementById('gh-modal-overlay');
  if (gh) gh.style.display = 'none';
  // API settings modal (re-injected each time it's opened, so just remove)
  const apiM = document.getElementById('api-key-modal');
  if (apiM) apiM.remove();
  // Health-check overlay (also re-injected on every open)
  const health = document.getElementById('health-overlay');
  if (health) health.remove();
  // Close every dialog-based modal via the controller
  kjrModalCtrl.closeAll();
  // Generic .overlay containers (modal-single / modal-slab / modal-sale /
  // modal-quick-sell / etc.)
  document.querySelectorAll('.overlay').forEach(o => { if (o.tagName === 'DIALOG') { if (o.open) o.close(); } else o.classList.remove('open'); });
  // Any open nav dropdowns
  document.querySelectorAll('.nav-dd').forEach(d => d.classList.remove('open'));
  // Bulk-select bars
  document.querySelectorAll('.bulk-bar').forEach(b => b.classList.remove('show'));
  // Column-visibility dropdowns
  document.querySelectorAll('.col-toggle-wrap').forEach(w => w.classList.remove('open'));
  // Reset the GitHub push button text if it was stuck on "Pushing…"
  const ghBtn = document.querySelector('#gh-modal-overlay button[onclick*="pushToGithub"]');
  if (ghBtn && /pushing/i.test(ghBtn.textContent)) {
    ghBtn.textContent = '🚀 Push to GitHub';
    ghBtn.disabled = false;
  }
  // Clear any "Pushing…" status text
  const ghStatus = document.getElementById('gh-status');
  if (ghStatus && /pushing|encoding/i.test(ghStatus.textContent || '')) ghStatus.textContent = '';
}
document.addEventListener('DOMContentLoaded', _resetEphemeralUi);

// Serialise the page for GitHub Pages push, BUT clone first and strip every
// transient UI element so the deployed HTML never starts with a stale modal
// open, a half-typed chat message, or a "Pushing…" button frozen in time.
function _buildCleanPushHtml(){
  // Clone the whole document; mutations on the clone don't touch the live UI.
  const clone = document.documentElement.cloneNode(true);
  const $ = sel => clone.querySelectorAll(sel);
  const $1 = sel => clone.querySelector(sel);
  // Close every overlay-style modal
  $('.overlay, .ver-overlay, .nav-dd').forEach(el => { if (el.tagName === 'DIALOG') el.removeAttribute('open'); else el.classList.remove('open'); });
  $('dialog[open]').forEach(el => el.removeAttribute('open'));
  // Hide the GitHub push modal (style-driven instead of class)
  const gh = $1('#gh-modal-overlay'); if (gh) gh.style.display = 'none';
  // Strip injected-on-open modals entirely
  ['#api-key-modal', '#health-overlay'].forEach(s => { const el = $1(s); if (el) el.remove(); });
  // Wipe AI chat & visualisation panels - these can carry sensitive data
  const aiHist = $1('#ai-chat-history'); if (aiHist) aiHist.innerHTML = '';
  const aiViz  = $1('#ai-viz-area');     if (aiViz)  aiViz.style.display = 'none';
  const aiVizC = $1('#ai-viz-content');  if (aiVizC) aiVizC.innerHTML = '';
  const aiInp  = $1('#ai-chat-input');   if (aiInp)  aiInp.value = '';
  // Bulk-select bars + selection state
  $('.bulk-bar').forEach(b => b.classList.remove('show'));
  $('input.row-cb').forEach(cb => { cb.checked = false; });
  $('tr.row-selected').forEach(tr => tr.classList.remove('row-selected'));
  // Column-visibility dropdowns
  $('.col-toggle-wrap').forEach(w => w.classList.remove('open'));
  // Sold-section toggles back to collapsed
  $('#singles-sold-divider, #slabs-sold-divider').forEach(d => { d.style.display = 'none'; });
  $('#singles-sold-body, #slabs-sold-body').forEach(b => { b.style.display = 'none'; });
  // Search & filter inputs - drop any typed value so the deployed page loads
  // unfiltered.
  $('input.search-input, input.col-filter, input.fi').forEach(inp => {
    // Skip the API-key inputs (those are inside #api-key-modal which is
    // already removed above; this is just defensive).
    if (inp.closest('#api-key-modal')) return;
    inp.value = '';
    inp.removeAttribute('value');
  });
  // GitHub push button - reset if it was stuck on "Pushing…"
  clone.querySelectorAll('button').forEach(btn => {
    if (/pushing|encoding/i.test(btn.textContent||'')) {
      btn.textContent = '🚀 Push to GitHub';
      btn.disabled = false;
    }
  });
  // Status text inside the GH modal
  const ghStatus = $1('#gh-status'); if (ghStatus) ghStatus.innerHTML = '';
  // Toast (could be mid-fade)
  const toastEl = $1('#toast'); if (toastEl) { toastEl.classList.remove('show','toast-error','toast-warn'); const tm = $1('#toast-msg'); if (tm) tm.textContent = ''; }
  // Sync indicator chip
  const sync = $1('#sync-indicator'); if (sync) sync.textContent = '';
  // Build the final string. We can't take .outerHTML of an HTMLElement and
  // get the doctype, so prepend it manually.
  return '<!DOCTYPE html>\n' + clone.outerHTML;
}

function sendAiPrompt(prompt) {
  document.getElementById('ai-chat-input').value = prompt;
  sendAiAnalyst();
}

function appendAiMessage(role, html) {
  const el = document.getElementById('ai-chat-history');
  const isUser = role === 'user';
  const div = document.createElement('div');
  div.style.cssText = 'display:flex;gap:8px;align-items:flex-start;' + (isUser ? 'flex-direction:row-reverse' : '');
  div.innerHTML =
    '<div style="width:28px;height:28px;border-radius:50%;background:' + (isUser ? 'var(--accent)' : 'var(--bg3)') + ';display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">' + (isUser ? '👤' : '🤖') + '</div>' +
    '<div style="background:' + (isUser ? 'var(--accent)22' : 'var(--bg2)') + ';border:1px solid var(--border);border-radius:10px;padding:10px 16px;font-size:13px;line-height:1.6;max-width:85%;word-break:break-word">' + html + '</div>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}

// Typing indicator row while the assistant is thinking. Removed once a reply
// (or error) arrives.
function showAiTyping() {
  const el = document.getElementById('ai-chat-history');
  if (!el || document.getElementById('ai-typing-row')) return;
  const div = document.createElement('div');
  div.id = 'ai-typing-row';
  div.style.cssText = 'display:flex;gap:8px;align-items:flex-start';
  div.innerHTML =
    '<div style="width:28px;height:28px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0">🤖</div>' +
    '<div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:12px 16px"><span class="ai-typing"><i></i><i></i><i></i></span></div>';
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function hideAiTyping() { document.getElementById('ai-typing-row')?.remove(); }

// Build a slim portfolio snapshot for the AI. Free models (Gemini Flash,
// Groq Llama-3 8B, OpenRouter free tier) have small context windows - we
// trim each table to its most relevant rows and drop fields the analyst
// rarely needs (id, priceHistory, urls, raw timestamps).
//
// IMPORTANT - every row carries explicit pre-computed ratios so the model
// doesn't have to guess the formula:
//   • roi_on_cost_pct  = (profit or unrealised P&L) ÷ cost × 100
//   • gross_margin_pct = profit ÷ revenue × 100  (sales only)
// Previously sales went through with `margin` as a free-form string ("73%")
// and the model would routinely re-compute it as profit/cost (e.g. 269%),
// or rank by profit while ignoring high-ROI rows. With explicit ratios the
// model can answer top-ROI / top-margin questions without inventing math.
function _buildAnalystSnapshot(){
  const round = n => Math.round((parseFloat(n)||0));
  const num   = n => parseFloat(n)||0;
  const r1    = n => Math.round(n*10)/10;
  const trim  = (str, max) => str && str.length > max ? str.slice(0, max) : str;
  const singlesAll = (DB.singles||[]).filter(i => (i.status||'Available') === 'Available');
  const slabsAll   = (DB.slabs||[])  .filter(i => (i.status||'Available') === 'Available');
  const salesAll   = (DB.sales||[]);
  const etbsAll    = (DB.etbs||[])   .filter(r => /in\s*stock/i.test(r.status||''));
  const bbAll      = (DB.boosterBoxes||[]).filter(r => /unopened|reserved/i.test(r.status||''));
  const bpAll      = (DB.boosterPacks||[]).filter(r => /sealed|reserved/i.test(r.status||''));

  // Per-row ROI for held inventory = (market − cost) ÷ cost × 100.
  const inventoryRoi = (cost, market) => {
    const c = num(cost); const m = num(market);
    if (c <= 0) return null; // unknown ROI - protects against /0
    return r1(((m - c) / c) * 100);
  };
  // Per-row ROI / gross margin for sales - exposed separately so the model
  // can answer either question correctly.
  const saleRoi = (cost, profit) => {
    const c = num(cost);
    if (c <= 0) return null;
    return r1((num(profit) / c) * 100);
  };
  const saleGM = (revenue, profit) => {
    const r = num(revenue);
    if (r <= 0) return null;
    return r1((num(profit) / r) * 100);
  };

  // Keep ALL slabs and ALL sales in the payload (typical portfolios have
  // ~100s of these - well within any free-tier context window after the
  // field-trim pass). For singles, sort by market value and keep top 200
  // so high-ROI singles in the long tail aren't silently dropped.
  // Previously slabs were sorted by market value and capped at 100, which
  // meant a high-ROI but low-priced slab (e.g. an Eevee TAG 10 bought
  // cheap) could fall out of the AI's view entirely.
  const bySgdValue = arr => [...arr].sort((a,b) => num(b.marketPrice||b.totalPrice) - num(a.marketPrice||a.totalPrice));
  const TOP = { singles: 200, sealed: 60 };

  const singles = bySgdValue(singlesAll).slice(0, TOP.singles).map(i => ({
    name: trim(i.name, 60), set: i.set, language: i.language, type: i.type,
    qty: parseInt(i.qty)||1, condition: i.condition,
    cost_sgd:        round(i.costPrice),
    market_sgd:      round(i.marketPrice),
    unrealised_pnl_sgd: round(num(i.marketPrice) - num(i.costPrice)),
    roi_on_cost_pct: inventoryRoi(i.costPrice, i.marketPrice)
  }));
  // Slabs: include EVERY available slab; sort by ROI descending so the AI
  // sees high-ROI items first in the payload.
  const slabs = slabsAll.map(i => ({
    name: trim(i.name, 60), grader: i.grader, grade: i.grade,
    cert: i.certNo,
    cost_sgd:        round(i.costPrice),
    market_sgd:      round(i.marketPrice),
    unrealised_pnl_sgd: round(num(i.marketPrice) - num(i.costPrice)),
    roi_on_cost_pct: inventoryRoi(i.costPrice, i.marketPrice)
  })).sort((a,b) => (b.roi_on_cost_pct ?? -Infinity) - (a.roi_on_cost_pct ?? -Infinity));
  // Sales: include ALL, sorted by profit DESC so the top of the array is
  // the top-profit row. Stripped of free-form `margin`; replaced with
  // explicit `gross_margin_pct` and `roi_on_cost_pct`.
  const sales = [...salesAll].sort((a,b) => num(b.profit) - num(a.profit)).map(s => ({
    product: trim(s.product, 60), date: s.dateSold, buyer: s.buyer,
    cost_sgd:           round(s.costPrice),
    revenue_sgd:        round(s.totalCollected),
    profit_sgd:         round(s.profit),
    gross_margin_pct:   saleGM(s.totalCollected, s.profit),
    roi_on_cost_pct:    saleRoi(s.costPrice, s.profit)
  }));
  const sealed = [
    ...bySgdValue(etbsAll).slice(0, TOP.sealed).map(r => ({ type:'ETB', name: trim(r.product,60), qty: parseInt(r.qty)||1, cost_sgd: round(r.totalPrice), market_sgd: round(r.marketPrice||r.totalPrice), roi_on_cost_pct: inventoryRoi(r.totalPrice, r.marketPrice||r.totalPrice) })),
    ...bySgdValue(bbAll).slice(0, TOP.sealed).map(r => ({ type:'Booster Box', name: trim(r.product,60), qty: parseInt(r.qty)||1, cost_sgd: round(r.totalPrice), market_sgd: round(r.marketPrice||r.totalPrice), roi_on_cost_pct: inventoryRoi(r.totalPrice, r.marketPrice||r.totalPrice) })),
    ...bySgdValue(bpAll).slice(0, TOP.sealed).map(r => ({ type:'Booster Pack', name: trim(r.product,60), qty: parseInt(r.qty)||1, cost_sgd: round(r.totalPrice), market_sgd: round(r.marketPrice||r.totalPrice), roi_on_cost_pct: inventoryRoi(r.totalPrice, r.marketPrice||r.totalPrice) })),
  ];
  // Totals computed from the FULL dataset, not the top-N slice
  const sumCost   = arr => arr.reduce((s,i) => s + (num(i.costPrice||i.totalPrice) * (parseInt(i.qty)||1)), 0);
  const sumMarket = arr => arr.reduce((s,i) => s + (num(i.marketPrice||i.totalPrice) * (parseInt(i.qty)||1)), 0);
  const sumProfit = arr => arr.reduce((s,i) => s + num(i.profit), 0);
  const sumRevenue= arr => arr.reduce((s,i) => s + num(i.totalCollected), 0);
  const totalRealisedCost   = sumCost(salesAll);
  const totalRealisedProfit = sumProfit(salesAll);
  const totals = {
    singles_count: singlesAll.length,
    slabs_count:   slabsAll.length,
    sealed_count:  etbsAll.length + bbAll.length + bpAll.length,
    sales_count:   salesAll.length,
    cost_singles_sgd: round(sumCost(singlesAll)),
    cost_slabs_sgd:   round(sumCost(slabsAll)),
    cost_sealed_sgd:  round(sumCost(etbsAll) + sumCost(bbAll) + sumCost(bpAll)),
    market_singles_sgd: round(sumMarket(singlesAll)),
    market_slabs_sgd:   round(sumMarket(slabsAll)),
    realised_revenue_sgd: round(sumRevenue(salesAll)),
    realised_profit_sgd:  round(totalRealisedProfit),
    realised_roi_on_cost_pct: totalRealisedCost > 0 ? r1((totalRealisedProfit/totalRealisedCost)*100) : null,
    realised_gross_margin_pct: sumRevenue(salesAll) > 0 ? r1((totalRealisedProfit/sumRevenue(salesAll))*100) : null
  };
  return { totals, singles, slabs, sealed, sales,
    _meta: {
      singles_truncated_to_top_n: TOP.singles,
      singles_full_count: singlesAll.length,
      slabs_fully_included: true,
      sales_fully_included: true,
      sealed_truncated_to_top_n_per_type: TOP.sealed,
      sealed_total_rows: etbsAll.length + bbAll.length + bpAll.length,
      glossary: {
        roi_on_cost_pct:   'Profit / Cost x 100. ROI from the buyer\'s point of view. Held inventory uses (Market − Cost). Sales use realised profit.',
        gross_margin_pct:  'Profit / Revenue x 100. The fraction of the sale price that is profit. Sales only.',
        unrealised_pnl_sgd:'Market value minus cost on a still-held item.'
      }
    } };
}

async function sendAiAnalyst() {
  const input = document.getElementById('ai-chat-input');
  const question = input.value.trim();
  if (!question) return;
  input.value = '';

  const btn = document.getElementById('ai-send-btn');
  btn.disabled = true;
  btn.textContent = '…';

  appendAiMessage('user', esc(question));

  // Diagnostics: which provider, payload size? Surfaced in the panel
  // subline so the user can see what's happening if responses don't appear.
  const provider = (typeof _resolveAIProvider === 'function') ? _resolveAIProvider() : null;
  const sublineEl = document.getElementById('ai-panel-subline');
  if (!provider) {
    appendAiMessage('assistant', '⚠ No AI key configured. Click 🔑 in the top bar - Gemini is free.');
    btn.disabled = false; btn.textContent = 'Ask →';
    return;
  }

  showAiTyping();

  const snapshot = _buildAnalystSnapshot();
  const snapJson = JSON.stringify(snapshot);
  if (sublineEl) sublineEl.textContent = 'Using ' + provider + ' · sending ' + Math.round(snapJson.length/1024) + 'KB of portfolio data';

  // Tight, instruction-led system prompt. Use raw counts (not "the data"
  // generic phrasing) so free models actually use the numbers.
  const systemPrompt = [
    'You are a Pokémon TCG portfolio analyst for Kujira Collectibles, a Singapore-based reseller.',
    'Reference the JSON portfolio data provided BELOW. Use exact numbers from it - do not invent or generalise.',
    'Always use Singapore Dollars (S$) and whole numbers.',
    'Be concise: give the answer, then 1-3 supporting bullet points if helpful.',
    'If the data does not contain what the user is asking about, say so clearly - do not guess.',
    '',
    'FIELD DEFINITIONS - use these exact fields, do NOT re-compute ratios from cost/revenue/profit:',
    '  • roi_on_cost_pct  = Profit ÷ Cost × 100 (use this when the user asks for ROI or "return on investment")',
    '  • gross_margin_pct = Profit ÷ Revenue × 100 (use this when the user asks for "margin %" on a sale)',
    '  • unrealised_pnl_sgd = Market − Cost for held inventory',
    '',
    'RANKING RULES:',
    '  • "Most profitable sale" → sort by profit_sgd DESC.',
    '  • "Highest margin" → sort by gross_margin_pct DESC (NOT roi_on_cost_pct).',
    '  • "Highest ROI" or "best ROI investment" → sort by roi_on_cost_pct DESC. Search ALL slabs in the array (the array is already pre-sorted by ROI DESC), and ALL sales.',
    '  • Do not arithmetic-derive margin from cost/profit - use the pre-computed gross_margin_pct.',
    '  • When asked for "top N", list exactly N rows from the appropriate pre-sorted source.',
    '',
    'If the user asks for a chart/visualisation, end your reply with a JSON block in EXACTLY this format:',
    '<CHART>{"type":"bar|line|doughnut|pie","title":"…","labels":["A","B"],"data":[1,2]}</CHART>',
    '',
    'PORTFOLIO DATA (slabs & sales are COMPLETE; singles & sealed are truncated - see _meta):',
    snapJson,
    '',
    'USER QUESTION: ' + question
  ].join('\n');

  // Track the conversation for multi-turn. All providers see a single
  // user-role message that includes the recent history (since not every
  // provider supports proper turn-based messages from the browser).
  aiChatHistory.push({ role: 'user', content: question });
  const recent = aiChatHistory.slice(-7, -1); // last 3 exchanges
  const finalPrompt = recent.length === 0
    ? systemPrompt
    : systemPrompt + '\n\nRECENT CONVERSATION (for context only - the new question is above):\n' +
      recent.map(m => (m.role === 'user' ? 'User: ' : 'You: ') + m.content).join('\n');

  try {
    const result = await callAI(finalPrompt, false);
    hideAiTyping();
    if (!result || result.startsWith('Error') || result.includes('AI features need')) {
      appendAiMessage('assistant', '⚠ ' + esc(result || 'Empty response - check 🔑 settings or try again'));
      btn.disabled = false; btn.textContent = 'Ask →';
      return;
    }
    const chartMatch = result.match(/<CHART>([\s\S]*?)<\/CHART>/);
    const textReply = result.replace(/<CHART>[\s\S]*?<\/CHART>/g, '').trim();
    aiChatHistory.push({ role: 'assistant', content: textReply });
    const safeReply = esc(textReply).replace(/\n/g, '<br>').replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    appendAiMessage('assistant', safeReply);
    if (chartMatch) {
      try {
        const chartData = JSON.parse(chartMatch[1].trim());
        renderAiChart(chartData);
      } catch(e) {}
    }
  } catch(e) {
    hideAiTyping();
    appendAiMessage('assistant', '⚠ Error: ' + esc(e.message));
  }

  hideAiTyping();
  btn.disabled = false;
  btn.textContent = 'Ask →';
}

function renderAiChart(cd) {
  const area = document.getElementById('ai-viz-area');
  const content = document.getElementById('ai-viz-content');
  area.style.display = '';
  content.innerHTML = '<canvas id="ai-chart" style="max-height:280px"></canvas>';
  if (dashCharts.aiChart) { try { dashCharts.aiChart.destroy(); } catch(e) {} }
  const palette = ['#a78bfa','#2dd4bf','#f59e0b','#f87171','#60a5fa','#34d399','#fb923c','#c084fc','#38bdf8','#4ade80'];
  const colors = cd.colors?.length ? cd.colors : cd.labels.map((_,i) => palette[i%palette.length]);
  const ctx = document.getElementById('ai-chart').getContext('2d');
  // Read theme tokens at call time (same pattern as _drawSavedChart) so axis
  // and grid colours follow the active theme instead of a hardcoded dark palette.
  const _cs = getComputedStyle(document.documentElement);
  const textColor  = _cs.getPropertyValue('--text2').trim() || '#ccc';
  const axisColor  = _cs.getPropertyValue('--text3').trim() || '#666';
  const gridColor  = _cs.getPropertyValue('--border').trim() || '#2a2a2a';
  dashCharts.aiChart = new Chart(ctx, {
    type: cd.type || 'bar',
    data: {
      labels: cd.labels,
      datasets: [{ label: cd.title, data: cd.data, backgroundColor: colors.map(c => c + '55'), borderColor: colors, borderWidth: 1.5, borderRadius: cd.type === 'bar' ? 4 : 0, fill: cd.type === 'line' }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: cd.type === 'doughnut' || cd.type === 'pie', position: 'bottom', labels: { color: axisColor, font: {size:11}, padding:10, usePointStyle:true} },
        title: { display: !!cd.title, text: cd.title, color: textColor, font: {size:13} }
      },
      scales: cd.type === 'doughnut' || cd.type === 'pie' ? {} : {
        x: { ticks: { color: axisColor, font:{size:11} }, grid: {display:false} },
        y: { ticks: { color: axisColor, font:{size:11}, callback: v => typeof v === 'number' ? 'S$'+v : v }, grid: {color:gridColor} }
      }
    }
  });
  area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// expose normaliseToMonthYear globally (used by dashboard)
function normaliseToMonthYear(raw) {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  const m1 = s.match(/^(\w{3,9})\s+(\d{4})$/i); if (m1) return m1[1].slice(0,3) + ' ' + m1[2];
  const m2 = s.match(/\d{1,2}\s+(\w{3,9})\s+(\d{4})/i); if (m2) return m2[1].slice(0,3) + ' ' + m2[2];
  const m3 = s.match(/^(\d{4})-(\d{2})-\d{2}/); if (m3) { const d = new Date(s+'T00:00:00'); if (!isNaN(d)) return d.toLocaleString('en-GB',{month:'short'})+' '+d.getFullYear(); }
  // Always parse as DD/MM/YYYY (en-GB / SG convention - per owner preference).
  // The old m5 (MM/DD) branch was unreachable because m4 always matched first.
  // For US-style imports, transform the file before paste rather than guess here.
  const m4 = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m4) {
    const day = parseInt(m4[1], 10), mon = parseInt(m4[2], 10);
    if (mon > 12 && day <= 12) {
      console.warn('[normaliseToMonthYear] "' + s + '" looks like MM/DD/YYYY but we parse DD/MM/YYYY. Treating as month=' + day + ', day=' + mon + '.');
    }
    const d = new Date(m4[3]+'-'+m4[2].padStart(2,'0')+'-'+m4[1].padStart(2,'0'));
    if (!isNaN(d)) return d.toLocaleString('en-GB',{month:'short'})+' '+d.getFullYear();
  }
  return null;
}

// =========== LISTING GENERATOR ===========
// ── Navigate to Listing tab pre-filled for a specific item ──
function lstGoBack() {
  const backId = window._listingFromId;
  if (window._listingFromPage) {
    showPage(window._listingFromPage);
    window._listingFromPage = null;
  }
  const btn = document.getElementById('lst-back-btn');
  if (btn) btn.style.display = 'none';
  // Drop the user back on the row they came from, with a brief outline so they
  // can re-orient after the page shuffles around. Mirrors viewSourceItem().
  if (backId) {
    window._listingFromId = null;
    setTimeout(() => {
      const sel = '[data-id="' + backId.replace(/"/g, '\\"') + '"]';
      const el = document.querySelector('.page.active ' + sel);
      if (el) {
        el.scrollIntoView({ behavior:'smooth', block:'center' });
        el.style.transition = 'outline-color 0.4s ease-out';
        el.style.outline = '2px solid var(--accent)';
        el.style.outlineOffset = '-2px';
        setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 2200);
      }
    }, 280);
  }
}

function openListingFor(table, id) {
  const cur = document.querySelector('.page.active')?.id?.replace('page-','');
  if (cur && cur !== 'listing') {
    window._listingFromPage = cur;
    window._listingFromId = id; // so Back can re-find and flash this row
    setTimeout(() => {
      const btn = document.getElementById('lst-back-btn');
      if (btn) btn.style.display = '';
    }, 0);
  }
  showPage('listing');
  populateListingSelect();
  const sel = document.getElementById('lst-item');
  const target = table + ':' + id;
  for (let opt of sel.options) {
    if (opt.value === target) { opt.selected = true; break; }
  }
  // Show the selected item as a compact chip. The formatted, copyable title
  // lives in the Title box below - echoing it back into the search field too
  // produced an on-screen duplicate, so we clear the search instead.
  const item = (DB[table] || []).find(i => i.id === id);
  if (item) {
    const plain = (item.name || item.product || '')
      .replace(/\s*[\(\[]\s*sealed\s*[\)\]]/ig, '').replace(/\s{2,}/g, ' ').trim();
    const searchEl = document.getElementById('lst-search');
    if (searchEl) searchEl.value = '';
    const lbl = document.getElementById('lst-selected-label');
    if (lbl) { lbl.style.display = ''; lbl.textContent = '✓ Selected: ' + plain; }
    const resEl = document.getElementById('lst-search-results');
    if (resEl) resEl.style.display = 'none';
  }
  // Pre-fill at 130% of market price (the user-requested markup), with
  // graceful fallbacks: marketPrice → listPrice → blank.
  if (item) {
    let market = parseFloat(item.marketPrice);
    if (isNaN(market) || market <= 0) market = parseFloat(item.listPrice) || 0;
    document.getElementById('lst-market').value = market > 0 ? 'S$' + Math.round(market) : '-';
    document.getElementById('lst-price').value = market > 0 ? Math.round(market * 1.30) : '';
  }
  // Build the fresh title + description for the newly selected item.
  rebuildListing();
}

// Current dropdown results + the highlighted row, so ↑/↓/Enter can drive the
// listing search the same way Quick Entry's sell search does.
let _lstHits = [];
let _lstHitIdx = 0;

function lstSearchItems(q) {
  const res = document.getElementById('lst-search-results');
  if (!res) return;
  if (!q || q.length < 1) { res.style.display = 'none'; _lstHits = []; return; }
  const avail = arr => (arr||[]).filter(i => (i.status||'Available') === 'Available');
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);

  // Token-aware matching across every field a user might type - mirrors Quick
  // Entry's sell search (renderCmdSellResults) so a slab query like
  // "PSA 10 Eevee" matches even though grader/grade live in their own fields,
  // not in `name`. Every whitespace chunk must match something on the row.
  const haySingle  = i => [i.name, i.set, i.language, i.condition, i.type, i.notes].filter(Boolean).join(' ').toLowerCase();
  const haySlab    = i => [i.name, i.set, i.grader, i.grade, i.certNo,
                           (i.grader && i.grade ? i.grader + ' ' + i.grade : ''),
                           (i.grader && i.grade ? i.grader + i.grade : ''), // "psa10"
                           i.rank, i.notes].filter(Boolean).join(' ').toLowerCase();
  const haySealed  = i => [i.product, i.notes].filter(Boolean).join(' ').toLowerCase();
  const allMatch   = hay => tokens.every(t => hay.includes(t));

  // Slabs first - usually highest value, same ordering as Quick Entry.
  _lstHits = [
    ...avail(DB.slabs).filter(i => allMatch(haySlab(i))).map(i => ({ src:'slabs', data:i })),
    ...avail(DB.singles).filter(i => allMatch(haySingle(i))).map(i => ({ src:'singles', data:i })),
    ...(DB.etbs||[]).filter(r=>/in\s*stock/i.test(r.status||'') && allMatch(haySealed(r))).map(i=>({src:'etbs',data:i})),
    ...(DB.boosterBoxes||[]).filter(r=>/unopened/i.test(r.status||'') && allMatch(haySealed(r))).map(i=>({src:'boosterBoxes',data:i})),
  ].slice(0, 12);
  _lstHitIdx = 0;

  if (!_lstHits.length) { res.innerHTML = '<div class="cmd-empty" style="padding:16px">No matches</div>'; res.style.display = 'block'; return; }
  _renderLstResults();
  res.style.display = 'block';
}

function _renderLstResults() {
  const res = document.getElementById('lst-search-results');
  if (!res) return;
  res.innerHTML = _lstHits.map((h, idx) => {
    const i = h.data, src = h.src;
    const isSlab = src === 'slabs' || i.type === 'slab';
    let icon, badge, meta;
    if (isSlab) {
      icon  = '🏆';
      badge = graderGradeBadge(i.grader, i.grade, i.notes);
      meta  = [(i.certNo ? '#' + i.certNo : ''), (i.rank||''), (i.set||'')].filter(Boolean).join(' · ') || 'Graded slab';
    } else if (src === 'etbs' || src === 'boosterBoxes' || i.type === 'sealed') {
      icon  = '📦';
      const label = src === 'etbs' ? 'ETB' : src === 'boosterBoxes' ? 'Box' : 'Sealed';
      badge = '<span class="badge b-sealed">' + label + '</span>';
      meta  = (i.set||'') || 'Sealed product';
    } else {
      icon  = '🃏';
      badge = '<span class="badge b-raw">Raw</span>';
      meta  = [(i.language||''), (i.condition||''), (i.set||'')].filter(Boolean).join(' · ') || 'Raw single';
    }
    const name = i.name || i.product || '-';
    return '<div class="cmd-result' + (idx === _lstHitIdx ? ' selected' : '') + '" data-idx="' + idx + '" onclick="lstSelectItem(\'' + kjrEscape(src) + '\',\'' + kjrEscape(i.id) + '\')">' +
      '<div class="cmd-result-icon" style="background:var(--bg3)">' + icon + '</div>' +
      '<div class="cmd-result-main">' +
        '<div class="cmd-result-name">' + kjrEscape(name) + '</div>' +
        '<div class="cmd-result-meta">' + kjrEscape(meta) + '</div>' +
      '</div>' + badge +
    '</div>';
  }).join('');
}

// ↑/↓ to move the highlight, Enter to pick it, Esc to close. Keeps the active
// row scrolled into view so long result lists are fully reachable by keyboard.
function lstSearchKey(e) {
  const res = document.getElementById('lst-search-results');
  if (!res || res.style.display === 'none' || !_lstHits.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _lstHitIdx = Math.min(_lstHitIdx + 1, _lstHits.length - 1);
    _renderLstResults(); _scrollLstIntoView();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _lstHitIdx = Math.max(_lstHitIdx - 1, 0);
    _renderLstResults(); _scrollLstIntoView();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    const h = _lstHits[_lstHitIdx];
    if (h) lstSelectItem(h.src, h.data.id);
  } else if (e.key === 'Escape') {
    res.style.display = 'none';
  }
}

function _scrollLstIntoView() {
  const el = document.querySelector('#lst-search-results .cmd-result.selected');
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function lstSelectItem(src, id) {
  // openListingFor owns all post-selection state: it populates the hidden
  // select, pre-fills price/market, shows the selected chip, and builds the
  // Title + Description boxes. We just close the dropdown and hand off.
  const res = document.getElementById('lst-search-results');
  if (res) res.style.display = 'none';
  openListingFor(src, id);
}

// Triggered by the item-select onchange - same pre-fill flow as openListingFor.
function onListingItemChanged(){
  const val = document.getElementById('lst-item').value;
  if (!val) {
    document.getElementById('lst-market').value = '';
    document.getElementById('lst-price').value = '';
    document.getElementById('lst-text').innerHTML = '<em style="color:var(--text3)">Select an item to build a listing.</em>';
    return;
  }
  const [src, id] = val.split(':');
  openListingFor(src, id);
}

// =========== EXTERNAL PRICE APIS ===========
// PokemonPriceTracker (PPT) is the eBay-graded-sold source for slabs (and the
// fallback for any raw single TCGdex can't price). All PPT calls route
// through a Cloudflare Worker proxy that holds the API key server-side -
// browsers can't reach PPT directly (CORS preflight blocked); the proxy adds
// Authorization + permissive CORS headers.
// See Docs/Worker Deploy Guide v1 (18 May).md for the Worker setup.

const PPT_KEY_STORAGE  = 'pokeinv_ppt_apikey';

// Cloudflare Worker proxy. The Worker holds the real keys as secrets - the
// browser never sees them. Setting this to a falsy value falls back to the
// direct (CORS-blocked) call, which is useful for local-file testing only.
const PRICE_PROXY_BASE = 'https://kujira-prices.julianchow21.workers.dev';

// =========== TCGDEX (raw singles, browser-direct, free, no key) ===========
// Free, no API key, CORS-open - called straight from the browser, no Worker
// hop needed. Used for raw singles only (TCGdex has no graded/eBay prices,
// slabs stay on PPT). Verified live 07/07/2026: resolve-by-name+number then
// fetch-by-id, see fetchPriceFromTcgdex below for the price-picking rule.
const TCGDEX_BASE = 'https://api.tcgdex.net/v2';

// Map the item's stored language tag to a TCGdex language path segment.
// Blank/unknown defaults to English - most of the collection is EN and an
// empty language field has always meant EN elsewhere in this file.
function _tcgdexLang(language) {
  const L = (language || '').toString().trim().toUpperCase();
  if (L === 'JP') return 'ja';
  if (L === 'CN') return 'zh-tw'; // zh-cn returns empty; zh-tw is metadata-only too (no free CN pricing) but keeps card names resolvable
  return 'en';
}

// Set-name token → TCGdex set id, for the multi-candidate disambiguation in
// resolveTcgdexId below. Only unambiguous phrases are listed - a bare word
// that TCGdex itself splits across several sets (e.g. "Neo" → Neo Genesis/
// Discovery/Revelation/Destiny, "Gym" → Gym Heroes/Challenge, "Legendary" →
// Legendary Collection/Treasures, "Base" → Base Set/Base Set 2) is
// deliberately left OUT so it can never resolve to the wrong one of several
// candidates that all happen to match "contains Neo" - the full two-word
// set name is required for those instead, matching TCGdex's own set list
// (verified live against GET /en/sets 08/07/2026). Checked longest-phrase-
// first by the caller so "Team Rocket Returns" never gets short-circuited
// by the shorter "Team Rocket" entry. Extend this table as more ambiguous
// cards surface - it only needs entries for sets that actually cause a
// multi-candidate TCGdex result in practice.
const _TCGDEX_SET_TOKENS = [
  ['team rocket returns', 'ex7'],
  ['team rocket', 'base5'],
  ['jungle', 'base2'],
  ['fossil', 'base3'],
  ['base set 2', 'base4'],
  ['base set', 'base1'],
  ['neo genesis', 'neo1'],
  ['neo discovery', 'neo2'],
  ['neo revelation', 'neo3'],
  ['neo destiny', 'neo4'],
  ['gym heroes', 'gym1'],
  ['gym challenge', 'gym2'],
  ['legendary collection', 'lc'],
  ['legendary treasures', 'bw11'],
  ['expedition', 'ecard1'],
  ['aquapolis', 'ecard2'],
  ['skyridge', 'ecard3']
];

// Given a card's free-text name and a list of TCGdex candidates (each
// {id: "<setId>-<localId>", ...}), find the ONE candidate whose set id
// matches a set-name token present in the name. Returns that candidate, or
// null if zero or more-than-one candidates match (still ambiguous - never
// guess). Case-insensitive; checks _TCGDEX_SET_TOKENS in its declared
// (longest-phrase-first) order so a multi-word set name is matched before a
// shorter one that's a substring of it.
function _disambiguateBySetName(name, candidates) {
  const lowerName = String(name || '').toLowerCase();
  for (const [token, setId] of _TCGDEX_SET_TOKENS) {
    if (!lowerName.includes(token)) continue;
    const matches = candidates.filter(c => c && typeof c.id === 'string' && c.id.startsWith(setId + '-'));
    if (matches.length === 1) return matches[0]; // exactly one candidate in this set - confident
    // 0 or 2+ matches for this token - fall through and try the next token
    // (rare, but a name could mention two set words); if nothing yields a
    // single match the caller's null return keeps the card unresolved.
  }
  return null;
}

// Resolve an item to a TCGdex card id ("setcode-number", e.g. "sv03-223").
// Auto-accept ONLY when the query returns exactly one candidate outright, OR
// when it returns several and the card's stored name mentions a set the
// candidates disambiguate to exactly one of (_disambiguateBySetName above,
// e.g. "Gyarados 21" alone is ambiguous across 3 sets, but "Gyarados 21
// Jungle" isn't) - this is the data-safety guard that keeps a wrong guess
// from ever being silently priced, it just moves the "exactly one" test to
// after a set-name filter instead of skipping straight to unresolved. Zero
// results, or several results that still don't disambiguate to one, return
// null (unresolved), the caller falls back to PPT. Caches the resolved id
// (+ matched name) onto the item so repeat lookups skip the resolve
// round-trip. Does not touch item.name itself - the stored name (set words,
// "RH", "(Sealed)" etc.) is read-only input here, never rewritten.
async function resolveTcgdexId(item) {
  if (item.tcgdexId) return item.tcgdexId;
  const name = _baseCardName(item.name);
  const num  = _tcgdexNumber(item.name);
  if (!name || !num) return null; // nothing to resolve against
  const lang = _tcgdexLang(item.language);
  try {
    const url = TCGDEX_BASE + '/' + lang + '/cards?name=' + encodeURIComponent(name) + '&localId=' + encodeURIComponent(num);
    const r = await fetch(url);
    if (!r.ok) return null; // transport failure - treat as unresolved, PPT fallback picks it up
    const data = await r.json();
    if (!Array.isArray(data) || !data.length) return null; // zero results - unresolved, never guess
    let card = data.length === 1 ? data[0] : _disambiguateBySetName(item.name, data);
    if (!card) return null; // several candidates and the set name didn't narrow it to one - still ambiguous
    if (!card.id) return null;
    item.tcgdexId = card.id;
    if (card.name) item._tcgdexResolvedName = card.name; // for a confirm tooltip in the edit modal
    return card.id;
  } catch (e) { return null; } // network error - unresolved, not a thrown exception
}

// Does the card's stored name mark it as a reverse-holo printing? Checked
// case-insensitively against a few common shorthands collectors use in a
// catalogued name - "RH" at a token boundary (start, or preceded by a
// non-letter like space/'('/'-'/'/', and NOT followed by more letters, so
// "Rhydon"/"Rhyhorn"/"Rhyperior" don't false-hit on the "Rh" prefix),
// "reverse", "rev holo"/"rev-holo"/"revholo". Read-only: this never
// rewrites item.name, it only steers which TCGplayer variant price
// fetchPriceFromTcgdex prefers below.
function _isReverseHoloName(name) {
  return /(?:^|[^a-z])rh(?![a-z])|reverse|rev[\s-]?holo/i.test(String(name || ''));
}

// Fetch a raw single's market price from TCGdex. Price source by language
// (verified live 07/07/2026):
//   EN → pricing.tcgplayer.{holofoil|normal|reverse-holofoil}.marketPrice USD
//        (precedence: holofoil, then normal, then reverse-holofoil, UNLESS
//        the card's name marks it reverse-holo - _isReverseHoloName above -
//        in which case reverse-holofoil is tried FIRST, before falling back
//        to the normal holofoil→normal→reverse-holofoil order if the
//        pricing block doesn't actually have a reverse-holofoil entry),
//        fallback pricing.cardmarket.avg EUR if tcgplayer is absent
//   JP/CN → pricing.cardmarket.avg EUR (tcgplayer is always null for JP;
//           CN has no free price source at all on either vendor)
// Cheaper commons sometimes carry no pricing block at all - that's a clean
// miss, never a fabricated number. Any unexpected response shape is also
// treated as "not found" rather than thrown, so a malformed/unknown payload
// falls through to PPT instead of crashing the caller.
async function fetchPriceFromTcgdex(item) {
  try {
    const id = await resolveTcgdexId(item);
    if (!id) return { error: 'not found' };
    const lang = _tcgdexLang(item.language);
    const r = await fetch(TCGDEX_BASE + '/' + lang + '/cards/' + encodeURIComponent(id));
    if (r.status === 404) return { error: 'not found' };
    if (!r.ok) return { error: 'HTTP ' + r.status };
    const data = await r.json();
    if (!data || !data.pricing) return { error: 'not found' };
    const pricing = data.pricing;

    const isJpCn = lang === 'ja' || lang === 'zh-tw';
    if (!isJpCn) {
      // EN: TCGplayer USD first. Normal precedence is holofoil → normal →
      // reverse-holofoil; a name flagged reverse-holo swaps in
      // reverse-holofoil ahead of that chain, but only when the pricing
      // block actually carries one - it's never invented, and a card
      // without a genuine reverse-holo print just falls through to the
      // same normal precedence as before.
      const tp = pricing.tcgplayer;
      const isRH = _isReverseHoloName(item.name);
      const variant = tp && (isRH && tp['reverse-holofoil']
        ? tp['reverse-holofoil']
        : (tp.holofoil || tp.normal || tp['reverse-holofoil']));
      const marketUsd = variant && typeof variant.marketPrice === 'number' ? variant.marketPrice : null;
      if (marketUsd && marketUsd > 0) {
        return { priceUsd: marketUsd, unit: 'USD', source: 'TCGdex (TCGplayer)', confidence: 'high', creditsUsed: 0 };
      }
      // Fallback: Cardmarket EUR when TCGplayer has nothing.
      const cmAvg = pricing.cardmarket && typeof pricing.cardmarket.avg === 'number' ? pricing.cardmarket.avg : null;
      if (cmAvg && cmAvg > 0) {
        return { priceEur: cmAvg, unit: 'EUR', source: 'TCGdex (Cardmarket)', confidence: 'high', creditsUsed: 0 };
      }
      return { error: 'not found' };
    } else {
      // JP/CN: Cardmarket EUR only (tcgplayer is null for JP; CN has neither).
      const cmAvg = pricing.cardmarket && typeof pricing.cardmarket.avg === 'number' ? pricing.cardmarket.avg : null;
      if (cmAvg && cmAvg > 0) {
        return { priceEur: cmAvg, unit: 'EUR', source: 'TCGdex (Cardmarket)', confidence: 'high', creditsUsed: 0 };
      }
      return { error: 'not found' };
    }
  } catch (e) { return { error: 'not found' }; } // never throw - unknown shape/network error is a clean miss
}

(function() {
  // Pre-populate localStorage for backward compat - but the proxy is the
  // authoritative path now, and the proxy uses Cloudflare-side secrets, not
  // these values. Once you fully cut over, you can delete this literal.
  if (!localStorage.getItem(PPT_KEY_STORAGE))  localStorage.setItem(PPT_KEY_STORAGE,  '');
  if (!window._kjrKeyWarnShown && !PRICE_PROXY_BASE) {
    console.warn('[Kujira] Price-API keys are baked into source. See TODO comment above. Rotate + proxy via Cloudflare Worker before public deploy.');
    window._kjrKeyWarnShown = true;
  }
})();

// Single key source now (PPT). The `which` param is kept for call-site
// compatibility rather than collapsing every caller to a no-arg call.
function getApiKey(which) {
  return localStorage.getItem(PPT_KEY_STORAGE) || '';
}
function setApiKey(which, val) {
  localStorage.setItem(PPT_KEY_STORAGE, val.trim());
}

function openApiSettings() {
  const ppt = getApiKey('ppt');
  const anth = getAnthropicKey();
  // Remove any existing instance first
  document.getElementById('api-key-modal')?.remove();
  const html = `
    <div id="api-key-modal" style="position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px">
      <div style="background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius-lg,12px);width:100%;max-width:520px;max-height:90vh;overflow-y:auto;box-shadow:var(--shadow-lg)">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid var(--border)">
          <h3 style="font-size:15px;font-weight:600;margin:0">🔑 Price API Settings</h3>
          <button onclick="window._closeApiSettings&&window._closeApiSettings()" style="background:none;border:none;color:var(--text3);font-size:18px;cursor:pointer;line-height:1;padding:2px 6px" aria-label="Close">&times;</button>
        </div>
        <div style="padding:20px;display:flex;flex-direction:column;gap:16px">

          <div style="font-size:12px;color:var(--text3);line-height:1.6;padding:10px;background:var(--bg3);border-radius:8px">
            Raw singles are priced free from <strong style="color:var(--text)">TCGplayer</strong> / <strong style="color:var(--text)">Cardmarket</strong> via <strong style="color:var(--text)">TCGdex</strong>, matched by card number and language - no key needed. Slabs are priced from real eBay sold data via <strong style="color:var(--text)">PokemonPriceTracker</strong>, ${DAILY_LIMIT} lookups a day. Both convert to SGD automatically, refreshed daily.
          </div>

          <div>
            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.6px;font-weight:600;margin-bottom:6px">PokemonPriceTracker API Key</div>
            <input type="password" id="ppt-key-input" class="fi" placeholder="pokeprice_free_..." value="${ppt}" style="font-family:monospace;font-size:12px">
            <div style="font-size:11px;color:var(--text3);margin-top:4px">
              <a href="https://www.pokemonpricetracker.com/api" target="_blank" style="color:var(--accent)">pokemonpricetracker.com/api</a> - 100 free lookups/day
            </div>
          </div>

          <div style="border-top:1px solid var(--border);padding-top:16px">
            <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">🤖 AI Analyst &amp; Import</div>
            <div style="font-size:11px;color:var(--text3);margin-bottom:10px;line-height:1.6">Pick any one provider. Free options work great for casual analysis. Keys stored only in this browser.</div>

            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.6px;font-weight:600;margin-bottom:6px">Preferred Provider</div>
            <select id="ai-provider-select" class="fi" style="margin-bottom:16px">
              <option value="auto" ${getAIProvider()==='auto'?'selected':''}>Auto - pick best free key available</option>
              <option value="gemini" ${getAIProvider()==='gemini'?'selected':''}>Google Gemini (free · recommended)</option>
              <option value="groq" ${getAIProvider()==='groq'?'selected':''}>Groq Llama-3 (free · fastest)</option>
              <option value="openrouter" ${getAIProvider()==='openrouter'?'selected':''}>OpenRouter (free tier + paid)</option>
              <option value="anthropic" ${getAIProvider()==='anthropic'?'selected':''}>Anthropic Claude (paid)</option>
            </select>

            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.6px;font-weight:600;margin-bottom:6px">
              Google Gemini Key <span style="color:var(--green);text-transform:none;letter-spacing:0;font-weight:400">- free, 15 req/min</span>
            </div>
            <input type="password" id="gemini-key-input" class="fi" placeholder="AIzaSy..." value="${getGeminiKey()}" style="font-family:monospace;font-size:12px">
            <div style="font-size:11px;color:var(--text3);margin-top:4px;margin-bottom:12px">
              Get one at <a href="https://aistudio.google.com/app/apikey" target="_blank" style="color:var(--accent)">aistudio.google.com/app/apikey</a> - no credit card required.
            </div>

            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.6px;font-weight:600;margin-bottom:6px">
              Groq Key <span style="color:var(--green);text-transform:none;letter-spacing:0;font-weight:400">- free, 30 req/min, ultra fast</span>
            </div>
            <input type="password" id="groq-key-input" class="fi" placeholder="gsk_..." value="${getGroqKey()}" style="font-family:monospace;font-size:12px">
            <div style="font-size:11px;color:var(--text3);margin-top:4px;margin-bottom:12px">
              Get one at <a href="https://console.groq.com/keys" target="_blank" style="color:var(--accent)">console.groq.com/keys</a>.
            </div>

            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.6px;font-weight:600;margin-bottom:6px">
              OpenRouter Key <span style="color:var(--text3);text-transform:none;letter-spacing:0;font-weight:400">- free tier + paid models</span>
            </div>
            <input type="password" id="openrouter-key-input" class="fi" placeholder="sk-or-..." value="${getOpenRouterKey()}" style="font-family:monospace;font-size:12px">
            <div style="font-size:11px;color:var(--text3);margin-top:4px;margin-bottom:12px">
              Get one at <a href="https://openrouter.ai/keys" target="_blank" style="color:var(--accent)">openrouter.ai/keys</a>.
            </div>

            <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.6px;font-weight:600;margin-bottom:6px">
              Anthropic Key <span style="color:var(--amber);text-transform:none;letter-spacing:0;font-weight:400">- paid, best quality</span>
            </div>
            <input type="password" id="anthropic-key-input" class="fi" placeholder="sk-ant-..." value="${anth}" style="font-family:monospace;font-size:12px">
            <div style="font-size:11px;color:var(--amber);margin-top:6px;line-height:1.5">
              ⚠ Keys are stored in your browser only. For production, proxy AI calls through a backend you control.
            </div>
          </div>

          <div style="display:flex;gap:8px">
            <button class="btn btn-primary btn-sm" onclick="saveApiKeys()">Save Keys</button>
            <button class="btn btn-sm" onclick="testApiKeys()">Test Keys</button>
          </div>
          <div id="api-key-status" style="font-size:12px;min-height:16px"></div>

          <!-- Queue panel -->
          <div style="border-top:1px solid var(--border);padding-top:16px">
            <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px">📅 Scheduled Refresh Queue</div>
            <div style="font-size:11px;color:var(--text3);line-height:1.7;margin-bottom:12px;padding:10px;background:var(--bg3);border-radius:8px">
              <strong style="color:var(--text)">Exact (TCGdex):</strong> free, unthrottled, runs a full pass on every raw single once a day<br>
              <strong style="color:var(--text)">Search (PPT):</strong> slabs, plus any TCGdex miss, high cost → low, capped at ${DAILY_LIMIT}/day<br>
              <strong style="color:var(--text)">Deduplication:</strong> Same card name = fetch once, copy to all duplicates<br>
              <strong style="color:var(--text)">Auto-runs</strong> when you open the app
            </div>
            <div id="queue-status-panel" style="margin-bottom:12px"></div>
            <button class="btn btn-sm" onclick="startFreshQueue()" style="width:100%;justify-content:center">
              🔄 Build / Rebuild Refresh Queue
            </button>
          </div>

          <div style="display:flex;justify-content:flex-end;border-top:1px solid var(--border);padding-top:16px">
            <button class="btn btn-sm" onclick="window._closeApiSettings&&window._closeApiSettings()">Close</button>
          </div>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
  setTimeout(_renderQueueStatus, 50);
  const modal = document.getElementById('api-key-modal');
  // Body scroll lock while open, restored on close.
  const _prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const closeModal = () => {
    document.removeEventListener('keydown', onKey);
    document.body.style.overflow = _prevOverflow;
    modal.remove();
  };
  window._closeApiSettings = closeModal;
  // ESC-to-close (this overlay is a plain div, not a native <dialog>).
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } };
  document.addEventListener('keydown', onKey);
  // Close on backdrop click
  modal.addEventListener('click', function(e) { if (e.target === this) closeModal(); });
  trapFocus(modal);
  setTimeout(() => modal.querySelector('input,button,select')?.focus(), 30);
}

function saveApiKeys() {
  setApiKey('ppt', document.getElementById('ppt-key-input').value);
  const anthEl = document.getElementById('anthropic-key-input');
  if (anthEl) setAnthropicKey(anthEl.value);
  const geminiEl = document.getElementById('gemini-key-input');
  if (geminiEl) setGeminiKey(geminiEl.value);
  const groqEl = document.getElementById('groq-key-input');
  if (groqEl) setGroqKey(groqEl.value);
  const orEl = document.getElementById('openrouter-key-input');
  if (orEl) setOpenRouterKey(orEl.value);
  const provEl = document.getElementById('ai-provider-select');
  if (provEl) setAIProvider(provEl.value);
  const active = _resolveAIProvider();
  document.getElementById('api-key-status').innerHTML = '<span style="color:var(--green)">✓ Saved' + (active ? ' · using ' + active : '') + '</span>';
  toast('API keys saved' + (active ? ' (using ' + active + ')' : ''));
}

async function testApiKeys() {
  const status = document.getElementById('api-key-status');
  status.innerHTML = '<span style="color:var(--text3)">Testing...</span>';
  // Save first so test uses what's in the inputs
  setApiKey('ppt', document.getElementById('ppt-key-input').value);
  // Test with a known-resolvable EN card (Charizard ex 223/197, sv03-223).
  const result = await fetchMarketPrice({ name: 'Charizard ex 223/197', grader: null, grade: null, language: 'EN' });
  let html = '';
  if (result.maxUsd || result.maxEur) {
    const usdPart = result.maxUsd ? 'US$' + Math.round(result.maxUsd) : 'EUR' + result.maxEur.toFixed(2);
    html += '<div>✓ <strong>TCGdex:</strong> ' + usdPart + ' → S$' + Math.round(result.maxSgd) + ' (' + result.source + ')</div>';
  } else {
    html += '<div style="color:var(--red)">✗ TCGdex: ' + (result.tcgdexError || 'no result') + '</div>';
  }
  if (result.source && /^PPT/.test(result.source)) html += '<div style="font-size:11px;color:var(--text3)">(TCGdex missed, PPT fallback served this test)</div>';
  else html += '<div style="color:var(--red)">✗ PokemonPriceTracker (slab fallback): ' + (result.pptError || 'not tried - TCGdex succeeded') + '</div>';
  status.innerHTML = html;
}

// ── Token-overlap similarity (Jaccard, 0–1). Cheap, no deps.
function _nameSimilarity(a, b) {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const A = new Set(norm(a)), B = new Set(norm(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; A.forEach(t => { if (B.has(t)) inter++; });
  return inter / (A.size + B.size - inter);
}

// Card-type suffixes (ex/GX/V/VMAX/VSTAR) are never mistaken for a card
// number by either function below - PPT and TCGdex both catalogue these as
// part of the name, not the number.
const _TYPE_SUFFIX = /^(ex|gx|v|vmax|vstar|vunion|break|prime|legend|lvx|lv)$/i;

// The shape of a card-number token, wherever it sits in the free-text name:
// an optional 0-5 letter set-code prefix (SWSH/SVP/TG/GG/XY/promo codes...),
// 1-5 digits, an optional single trailing letter (variant suffix, e.g. the
// "a" in "67a"). Shared by _tcgdexNumber (which reads the match) and
// _baseCardName (which just needs to know where to cut) so the two can never
// disagree about which token is "the number".
const _NUM_TOKEN = /^([A-Za-z]{0,5})(\d{1,5})([A-Za-z]?)$/;

// Scan a free-text card name for the first token that looks like a card
// number, ANYWHERE after the leading Pokemon-name token (never token 0 -
// that's the name, not the number). Strips "()" wrapping (a parenthetical
// aside like "(Sealed)") and a trailing "/total" fraction before testing
// each token, and skips ex/GX/V/VMAX/... type suffixes so they never
// misfire as the number. Returns { index, value } for the matched token, or
// null if nothing in the name looks like a card number.
function _findNumToken(tokens) {
  for (let i = 1; i < tokens.length; i++) {
    let tok = tokens[i].replace(/^[(]+|[)]+$/g, '');
    if (!tok) continue;
    tok = tok.split('/')[0];
    if (!tok || _TYPE_SUFFIX.test(tok)) continue;
    const m = tok.match(_NUM_TOKEN);
    if (m) return { index: i, prefix: m[1], digits: m[2], suffix: m[3] };
  }
  return null;
}

// ── Broaden a card name for a fallback search ──
// Strips the card-number token (found anywhere via _findNumToken, not just
// trailing) and everything from it onward, so a search that returned zero
// results (PPT indexes by name, with number/set as separate fields) can be
// retried with just the catalogued name, and so resolveTcgdexId's name+number
// query below has a clean name half. "Gardevoir ex 93" → "Gardevoir ex";
// "Zapdos 42 RH" → "Zapdos"; "Riolu 10 (Pokemon Centre) (Sealed)" → "Riolu".
// Falls back to the whole trimmed name when no number token is found (e.g.
// "Umbreon Custom Card"), never returns an empty string for a non-empty name.
function _baseCardName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const tokens = raw.split(/\s+/).filter(Boolean);
  const hit = _findNumToken(tokens);
  return hit ? tokens.slice(0, hit.index).join(' ') : raw;
}

// Numeric card-number tokens in a string, leading zeros stripped, as a Set.
// Used to score an exact card-number match in _pickBestMatch.
function _cardNumberTokens(str) {
  const out = new Set();
  (String(str || '').match(/\d{1,5}/g) || []).forEach(n => out.add(n.replace(/^0+(?=\d)/, '')));
  return out;
}

// Extract the TCGdex set number (their "localId") from a free-text card
// name, for the resolve query. Reads the token _findNumToken locates -
// anywhere in the name, not just the trailing token, so "Zapdos 42 RH" and
// "Riolu 10 (Pokemon Centre) (Sealed)" resolve exactly like "Eevee 173" did.
// Two shapes: plain numeric ("223/197" → "223") and alpha-prefixed (promos,
// Trainer/Galarian Gallery etc, "TG11/TG30" → "TG11", "SWSH291" → "SWSH291").
// Alpha prefix is preserved verbatim (case + digit count), TCGdex's own
// localId is exact-match including zero-padding (verified live: "TG3" 404s,
// "TG03" resolves) - we don't guess at padding, just pass through what's
// actually in the name.
function _tcgdexNumber(name) {
  const tokens = String(name || '').trim().split(/\s+/).filter(Boolean);
  const hit = _findNumToken(tokens);
  return hit ? (hit.prefix + hit.digits + hit.suffix).toUpperCase() : '';
}

// Pick the highest-similarity card from a results list. Returns null if no
// candidate clears the floor - caller should surface "no name match" to the
// user. _SIM_FLOOR is intentionally lenient (0.2) because card names get
// noisy (set codes, language tags) and we'd rather show a slightly-off match
// than block everything; bump to 0.35 if false positives surface.
const _SIM_FLOOR = 0.2;
function _pickBestMatch(results, query, languageHint) {
  if (!Array.isArray(results) || !results.length) return null;
  // languageHint is a lowercased language word ('japanese', 'chinese', etc.)
  // or '' for EN. When set, candidates whose set/name/region mention that
  // language get a similarity bonus so JP cards aren't outranked by EN prints
  // that happen to share a card number ("Poliwhirl 176" - same number in
  // multiple sets/languages). This is what keeps EN and JP pricing distinct.
  const wantLang = (languageHint || '').toLowerCase();
  // Card number is the strongest disambiguator. When the search has been
  // broadened to a base name (e.g. "Squirtle" for "Squirtle 1 CLK"), PPT
  // returns every Squirtle; the number is what tells #1 from #63. We score it
  // explicitly rather than leaving it as one Jaccard token among many.
  const queryNums = _cardNumberTokens(query);
  let best = null, bestScore = -1;
  for (const c of results) {
    const candidateText = [c.name, c.setName, c.set?.name, c.number].filter(Boolean).join(' ');
    let score = _nameSimilarity(query, candidateText);

    // Card-number match - dominant signal.
    if (queryNums.size) {
      const cNums = _cardNumberTokens(c.number);
      if (cNums.size) {
        const hit = [...cNums].some(n => queryNums.has(n));
        score += hit ? 0.4 : -0.25; // right print vs a different-numbered card
      }
    }

    // Language match - checks structured fields (language/region/variant)
    // first, then the combined text blob. A non-EN candidate is penalised on
    // an EN-default search so the English print wins, and vice versa.
    const langBlob = [c.language, c.region, c.variant, candidateText].filter(Boolean).join(' ').toLowerCase();
    const NON_EN = /(japanese|chinese|korean|indonesian|jpn|jp\b|kor\b|chn\b)/;
    if (wantLang) {
      if (langBlob.includes(wantLang)) score += 0.3;
      else if (NON_EN.test(langBlob)) score -= 0.15; // wrong non-EN language
    } else if (NON_EN.test(langBlob)) {
      score -= 0.3; // EN wanted, candidate is non-EN
    }

    if (score > bestScore) { best = c; bestScore = score; }
  }
  return bestScore >= _SIM_FLOOR ? best : null;
}

// ── PokemonPriceTracker: fetch single card USD price ──
// Returns { priceUsd, source, cardName, _ppt_requests } on success, or
// { error, _ppt_requests } on failure. _ppt_requests is the count of PPT
// responses that actually returned data (HTTP 2xx) - the queue bills these
// against the daily limit so the fallback search can't silently overrun it.
// Transport failures (non-2xx) count 0: PPT either refused (429/403) or
// crashed (5xx), and we retry tomorrow.
async function fetchPriceFromPPT(name, grader, grade, language) {
  try {
    // Bias the search toward the right language printing. PPT's index is
    // EN-default, so a bare "Poliwhirl 176" search returns the EN print
    // even when the user owns the JP card. Adding "japanese" / "chinese" /
    // "korean" to the query (and to the fuzzy-match candidate string)
    // pulls the right printing's pricing. This is half of language-specific
    // pricing; the other half is _pickBestMatch's language bonus.
    const lang = (language||'').toString().trim().toUpperCase();
    const langWord = lang === 'JP' ? 'japanese' : lang === 'CN' ? 'chinese' : lang === 'KR' ? 'korean' : lang === 'ID' ? 'indonesian' : '';

    let reqCount = 0;
    // One PPT search + fuzzy pick. Candidates are always scored against the
    // FULL original `name` (number + set code included) via _pickBestMatch,
    // so broadening the *search query* never loses precision in the *pick*.
    // Returns { card } | { empty:true } | { transport:'HTTP nnn' }.
    async function search(query, limit) {
      // Route through Cloudflare Worker when configured - Worker holds the
      // key server-side and returns CORS headers the browser will accept.
      // Direct calls still 4xx on preflight from any browser origin, so the
      // proxy is the only working path.
      const url = PRICE_PROXY_BASE
        ? PRICE_PROXY_BASE + '/ppt/cards?search=' + encodeURIComponent(query) + '&limit=' + limit
        : 'https://www.pokemonpricetracker.com/api/v2/cards?search=' + encodeURIComponent(query) + '&limit=' + limit;
      const headers = PRICE_PROXY_BASE ? {} : { 'Authorization': 'Bearer ' + (getApiKey('ppt') || '') };
      const r = await fetch(url, { headers });
      if (!r.ok) return { transport: 'HTTP ' + r.status }; // refused/crashed - don't bill, don't fall back
      reqCount++;
      const data = await r.json();
      if (!data.data || !data.data.length) return { empty: true };
      const card = _pickBestMatch(data.data, name, langWord);
      return card ? { card } : { empty: true };
    }

    // Primary: full name as-is (+ language word). Preserves matches that
    // already work, e.g. "Eevee 173", where the trailing number is part of
    // PPT's catalogued name.
    const primaryQ = langWord ? (name + ' ' + langWord) : name;
    let res = await search(primaryQ, 5);
    if (res.transport) return { error: res.transport, _ppt_requests: 0 };

    // Fallback - ONLY when the primary returned zero usable results (never on
    // a transport error, which would hammer a rate-limited key). Broaden to
    // the base card name with trailing number/set-code tokens stripped, and
    // widen the limit so the right numbered print is in range.
    // "Gardevoir ex 93" → search "Gardevoir ex"; "Squirtle 1 CLK" → "Squirtle".
    // The number/set-code still drive the pick via _pickBestMatch's number
    // bonus, so the broader search doesn't cost precision. usedFallback is
    // surfaced to the caller (fetchMarketPrice) so it can mark the result
    // 'medium' confidence (card-number matched) vs 'low' (base-name guess).
    let usedFallback = false;
    if (res.empty) {
      const base = _baseCardName(name);
      if (base && base.toLowerCase() !== String(name).trim().toLowerCase()) {
        const fbQ = langWord ? (base + ' ' + langWord) : base;
        const res2 = await search(fbQ, 10);
        if (res2.transport) return { error: res2.transport, _ppt_requests: reqCount };
        if (res2.card) { res = res2; usedFallback = true; }
      }
    }
    if (!res.card) return { error: 'no match', _ppt_requests: reqCount, usedFallback };
    const card = res.card;

    let priceUsd = null;
    let priceSource = 'PPT';
    if (grader && grade) {
      // Grader-specific price ONLY. Previously fell through to the PSA price
      // for any grader, which inflated TAG/CGC/ACE valuations (TAG 10 ~60–70%
      // of PSA 10). We now surface a miss to the caller instead of silently
      // substituting a different grader's number.
      const gradeKey = grader.toLowerCase() + grade.replace('.','');  // e.g. psa10
      priceUsd = card.ebay?.[gradeKey]?.avg;
      if (priceUsd) priceSource = 'PPT (' + grader.toUpperCase() + ' ' + grade + ')';
    }
    if (!priceUsd && !(grader && grade)) {
      // No grader requested → NM market price is fine.
      priceUsd = card.prices?.market || card.prices?.NEAR_MINT?.avg || card.tcgplayer?.NEAR_MINT?.avg || card.ebay?.NEAR_MINT?.avg;
    }
    if (!priceUsd) return { error: grader ? 'no ' + grader + ' ' + grade + ' price' : 'no price data', _ppt_requests: reqCount, usedFallback };
    return { priceUsd, source: priceSource, cardName: card.name, _ppt_requests: reqCount, usedFallback };
  } catch(e) { return { error: e.message, _ppt_requests: 0, usedFallback: false }; }
}

// ── Router: TCGdex first for raw singles, PPT for slabs and TCGdex misses ──
// Takes one descriptor { name, grader, grade, language, tcgdexId, tcgdexOnly }
// so every caller passes the same shape regardless of which lane ends up
// serving it.
//   RAW  (no grader): try TCGdex first (exact id match, free, high
//        confidence). A "not found" or no-price result falls through to PPT -
//        UNLESS tcgdexOnly is set, in which case it's a clean unpriced miss,
//        zero PPT calls, zero credits. tcgdexOnly is set by the free-lane
//        queue runner (_runTcgdexLane) - that lane must NEVER trigger a real
//        (billed) PPT request, or it silently overruns PPT's daily/rate-limit
//        envelope every time TCGdex misses (verified: this is what tripped
//        PPT into a 403 before the English-only rework - _runTcgdexLane was
//        calling this router unrestricted and discarding creditsUsed).
//   SLAB (has grader): PPT's eBay graded lane, unchanged behaviour - TCGdex
//        has no graded prices at all. tcgdexOnly has no effect here.
// Returns { maxUsd|maxEur, maxSgd, source, confidence, creditsUsed,
//   tcgdexError, pptError, resolvedTcgdexId, resolvedCardName }. classifyResult/
// tallyErrors (in the refresh queue) read the tcgdexError/pptError pair with
// the NON_ATTEMPT sentinel-stripping rule below - keep that intact whenever
// this shape changes.
async function fetchMarketPrice(descriptor) {
  const { name, grader, grade, language, tcgdexId, tcgdexOnly } = descriptor || {};
  const isSlab = !!(grader && grade);

  if (!isSlab) {
    // RAW lane: TCGdex first. Build a minimal item-shaped object so the
    // Phase 2 helpers (which read/write item.tcgdexId, item.name,
    // item.language) can run without needing the caller's live DB row -
    // the resolved id/name are handed back in the result for the caller to
    // persist onto its own item, keeping this router side-effect-free on
    // objects it doesn't own.
    const pseudoItem = { name, language, tcgdexId };
    const tcgdexRes = await fetchPriceFromTcgdex(pseudoItem);
    if (!tcgdexRes.error) {
      const rate = tcgdexRes.unit === 'EUR' ? await getEurSgdRate() : await getSgdRate();
      const maxUsd = tcgdexRes.unit === 'USD' ? tcgdexRes.priceUsd : null;
      const maxEur = tcgdexRes.unit === 'EUR' ? tcgdexRes.priceEur : null;
      const maxSgd = tcgdexRes.unit === 'USD' ? tcgdexRes.priceUsd * rate : tcgdexRes.priceEur * rate;
      return {
        maxUsd, maxEur, maxSgd,
        source: tcgdexRes.source,
        confidence: tcgdexRes.confidence,
        creditsUsed: 0,
        tcgdexError: null,
        pptError: 'not applicable', // PPT was never tried - RAW lane succeeded on TCGdex
        resolvedTcgdexId: pseudoItem.tcgdexId || null,
        resolvedCardName: pseudoItem._tcgdexResolvedName || null,
        sgdRate: rate
      };
    }
    if (tcgdexOnly) {
      // Free-lane caller: TCGdex missed and PPT must NOT be tried. Return a
      // clean unpriced result - zero PPT calls, zero credits, card stays
      // flagged unresolved/unpriced until fixed or re-tried.
      return {
        maxUsd: null, maxEur: null, maxSgd: null,
        source: null, confidence: 'none',
        creditsUsed: 0,
        tcgdexError: tcgdexRes.error,
        pptError: 'not applicable', // PPT deliberately never tried - tcgdexOnly
        resolvedTcgdexId: pseudoItem.tcgdexId || null,
        resolvedCardName: pseudoItem._tcgdexResolvedName || null,
        sgdRate: null
      };
    }
    // TCGdex missed (unresolved, no price, or transport failure) - fall
    // through to PPT exactly like the SLAB lane below, just without a grader.
    const pptRes = await fetchPriceFromPPT(name, null, null, language);
    const rate = await getSgdRate();
    if (pptRes.priceUsd) {
      return {
        maxUsd: pptRes.priceUsd, maxEur: null, maxSgd: pptRes.priceUsd * rate,
        source: pptRes.source,
        // medium when the card-number-bearing primary search matched, low
        // when only the base-name fallback fired (a looser guess).
        confidence: pptRes.usedFallback ? 'low' : 'medium',
        creditsUsed: pptRes._ppt_requests || 0,
        tcgdexError: tcgdexRes.error,
        pptError: null,
        resolvedTcgdexId: pseudoItem.tcgdexId || null,
        resolvedCardName: pseudoItem._tcgdexResolvedName || null,
        sgdRate: rate
      };
    }
    return {
      maxUsd: null, maxEur: null, maxSgd: null,
      source: null, confidence: 'none',
      creditsUsed: pptRes._ppt_requests || 0,
      tcgdexError: tcgdexRes.error,
      pptError: pptRes.error,
      resolvedTcgdexId: pseudoItem.tcgdexId || null,
      resolvedCardName: pseudoItem._tcgdexResolvedName || null,
      sgdRate: rate
    };
  }

  // SLAB lane: PPT eBay graded price only, TCGdex has no graded data at all.
  const pptRes = await fetchPriceFromPPT(name, grader, grade, language);
  const rate = await getSgdRate();
  if (pptRes.priceUsd) {
    return {
      maxUsd: pptRes.priceUsd, maxEur: null, maxSgd: pptRes.priceUsd * rate,
      source: pptRes.source,
      confidence: pptRes.usedFallback ? 'low' : 'medium',
      creditsUsed: pptRes._ppt_requests || 0,
      tcgdexError: 'not applicable', // TCGdex never applies to graded slabs
      pptError: null,
      resolvedTcgdexId: null, resolvedCardName: null,
      sgdRate: rate
    };
  }
  return {
    maxUsd: null, maxEur: null, maxSgd: null,
    source: null, confidence: 'none',
    creditsUsed: pptRes._ppt_requests || 0,
    tcgdexError: 'not applicable',
    pptError: pptRes.error,
    resolvedTcgdexId: null, resolvedCardName: null,
    sgdRate: rate
  };
}

// ── Refresh single price using real APIs (fallback to AI if no keys) ──
async function refreshPrice(id, table) {
  const item = DB[table].find(i => i.id === id);
  if (!item) return;
  // TCGdex needs no key (free, CORS-open); PPT does. Only block when neither
  // path can possibly work - a raw single can still price via TCGdex alone.
  const hasKeys = getApiKey('ppt');
  const isRaw = item.type !== 'slab';
  if (!hasKeys && !isRaw) {
    toast('Add API keys first - click 🔑 in top bar');
    return;
  }
  toast('Fetching market price...');
  const grader = item.type === 'slab' ? (item.grader||null) : null;
  const grade  = item.type === 'slab' ? (item.grade||null) : null;
  const r = await fetchMarketPrice({ name: item.name, grader, grade, language: item.language||null, tcgdexId: item.tcgdexId||null });
  // Persist a freshly-resolved TCGdex id (and matched name) even when this
  // call itself missed - so the NEXT refresh skips the resolve round-trip.
  if (r.resolvedTcgdexId && !item.tcgdexId) {
    item.tcgdexId = r.resolvedTcgdexId;
    if (r.resolvedCardName) item._tcgdexResolvedName = r.resolvedCardName;
  }
  if (r.maxSgd) {
    item.marketPrice = r.maxSgd.toFixed(0);
    if (!item.priceHistory) item.priceHistory = [];
    item.priceHistory.push({
      date: new Date().toISOString().slice(0,10),
      price: r.maxSgd,
      unit: r.maxUsd ? 'USD' : 'EUR',
      source: r.source,
      confidence: r.confidence
    });
    if (item.priceHistory.length > PRICE_HISTORY_MAX) item.priceHistory = item.priceHistory.slice(-PRICE_HISTORY_MAX);
    markDirty(table, id);
    saveData();
    if (table === 'singles') renderSingles();
    if (table === 'slabs') renderSlabs();
    toast('Updated S$' + r.maxSgd.toFixed(0) + ' (' + r.source + ')');
  } else {
    markDirty(table, id); // a resolved tcgdexId may still need to sync even on a miss
    saveData();
    toastError('No price found · TCGdex: ' + (r.tcgdexError||'?') + ' · PPT: ' + (r.pptError||'?'));
  }
}

// =========== SMART REFRESH QUEUE ===========
// Priority order:
//   1. All slabs (by costPrice desc)
//   2. All singles (by costPrice desc, top 100 first each day)
// Deduplication: fetch once per unique card name+grader+grade combo,
//   copy the result to all other rows with the same name.
// Daily limit: 100 lookups max (each unique fetch = 1 credit).
// Queue state persists in localStorage - resumes automatically next day.

const QUEUE_KEY       = 'pokeinv_refresh_queue';
const QUEUE_DATE_KEY  = 'pokeinv_refresh_queue_date';
// PRICE_HISTORY_MAX - each item's priceHistory array is capped to this many
// entries to keep localStorage well under quota across the whole inventory.
// 365 covers a year of daily refreshes per card.
const PRICE_HISTORY_MAX = 365;
// DAILY_LIMIT - capped to PPT free-plan's safe envelope. Hitting 100/day at
// 1.1s spacing tripped their abuse detector (50 429s in 5min = key block for
// 24h). 30/day with 6s spacing is well under the free-plan rate limit and
// matches PPT's "30 data points/day" hint. Upgrade PPT plan → bump this.
const DAILY_LIMIT     = 30;
// REQUEST_GAP_MS - pause between requests inside a batch. PPT's free plan
// rate-limits individual requests; spacing them out prevents 429s entirely.
const REQUEST_GAP_MS  = 6000;
// Bump whenever a change to buildRefreshQueue/_queueLaneFor/the tcgdex lane's
// per-card fields would leave an already-persisted queue in a stale or
// inconsistent shape (new lane values, new per-item fields the runner now
// depends on, changed lane-routing rules). loadQueue() below discards and
// silently rebuilds on a mismatch, rather than resuming a queue built under
// the old rules - this is the fix for a real production incident: the
// English-only rework changed _queueLaneFor's routing (JP no longer gets a
// tcgdex lane) and added the _tcgdexMissDate self-heal field, but a queue
// built by the OLD v3.13 code had already stamped a bad lastTcgdexPass after
// a run that only priced ~2 cards - every subsequent auto run silently
// no-op'd forever because the stale stamp matched "today" and the old
// whole-lane skip gate trusted it blindly. Bumping this version for the fix
// forces every existing user's stale queue to discard and rebuild fresh on
// their next load, recovering them without any manual "Rebuild Queue" click.
const QUEUE_SCHEMA_VERSION = 2;

// Discards and returns null for a queue built under an old schema version
// (or with no version stamp at all, i.e. any queue from before this constant
// existed) - see QUEUE_SCHEMA_VERSION above for why this matters. The caller
// (runRefreshQueue) treats a null return exactly like "no queue yet" and
// silently builds a fresh one, so this recovery is invisible to the user
// beyond a one-off rebuild (their progress-so-far, which lives on the actual
// DB rows' marketPrice/priceHistory, is never touched - only the queue's own
// bookkeeping is discarded).
function loadQueue() {
  let q;
  try { q = JSON.parse(localStorage.getItem(QUEUE_KEY) || 'null'); } catch(e) { return null; }
  if (!q) return null;
  if (q.schemaVersion !== QUEUE_SCHEMA_VERSION) {
    localStorage.removeItem(QUEUE_KEY);
    return null;
  }
  return q;
}
function saveQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch(e) {} }
function clearQueue() { localStorage.removeItem(QUEUE_KEY); localStorage.removeItem(QUEUE_DATE_KEY); }

// Which lane will price this queue item? Slabs (graded) never have a TCGdex
// price at all, so they're always 'ppt' (their PokemonPriceTracker graded
// lane, unaffected by the language rule below). A raw single goes to the
// free 'tcgdex' lane only when it's BOTH resolvable there (a name + card
// number we can extract, resolveTcgdexId needs both) AND English/blank -
// English-only auto-pricing is a deliberate product decision (owner call),
// not a data-availability one: TCGdex's JP/CN pricing exists but is not
// free-tier-safe to hammer at scale, so non-EN raw singles never
// enter ANY auto-pricing lane (no tcgdex, no ppt) - they stay fully manual,
// costing zero API calls of either kind. An EN/blank single with NO
// extractable card number is ALSO 'manual', not a PPT fallback - fuzzy
// name-only PPT search is the inaccurate matching this rework moved away
// from, and a numberless EN name is often a custom/joke card with no real
// market at all ("Umbreon Custom Card"), so sending it to PPT would waste
// the 30/day slab budget on an unmatchable search. After this rule the
// 'ppt' lane contains ONLY slabs - every raw single is either 'tcgdex' or
// 'manual'. A numberless EN card is still surfaced to the user though (see
// _kjrUnresolvedSingles), since adding a card number is a real fix that
// moves it into the tcgdex lane.
function _queueLaneFor(item) {
  if (item.grader) return 'ppt'; // slab - TCGdex has no graded prices, language rule doesn't apply
  const lang = (item.language || 'EN').toString().trim().toUpperCase();
  const isEnglish = lang === 'EN' || lang === '';
  if (!isEnglish) return 'manual'; // JP/CN/ID/KR/anything non-EN - never auto-priced, zero API calls
  if (item.tcgdexId) return 'tcgdex'; // already resolved, skip straight to the free lane
  const hasNameAndNumber = !!(_baseCardName(item.name) && _tcgdexNumber(item.name));
  return hasNameAndNumber ? 'tcgdex' : 'manual'; // no number - manual, not a PPT fuzzy-search fallback
}

// Build a fresh queue from current DB state
function buildRefreshQueue() {
  // Slabs: sorted by costPrice desc. Carry language so the API search can
  // disambiguate JP/CN/KR/ID printings from the EN default. Without this a
  // "Poliwhirl 176 JP" lookup returned EN-print pricing.
  const slabs = DB.slabs
    .filter(i => (i.status||'Available') === 'Available')
    .sort((a,b) => (parseFloat(b.costPrice)||0) - (parseFloat(a.costPrice)||0))
    .map(i => ({ id: i.id, table: 'slabs', name: i.name, grader: i.grader||null, grade: i.grade||null, language: i.language||null, tcgdexId: i.tcgdexId||null, costPrice: parseFloat(i.costPrice)||0 }));

  // Singles: sorted by costPrice desc
  const singles = DB.singles
    .filter(i => (i.status||'Available') === 'Available')
    .sort((a,b) => (parseFloat(b.costPrice)||0) - (parseFloat(a.costPrice)||0))
    .map(i => ({ id: i.id, table: 'singles', name: i.name, grader: null, grade: null, language: i.language||null, tcgdexId: i.tcgdexId||null, costPrice: parseFloat(i.costPrice)||0 }));

  // Combine: slabs first, then singles
  const all = [...slabs, ...singles];

  // Deduplicate: build a map of uniqueKey → list of item IDs that share the
  // same name+language(+grade). Only the FIRST occurrence gets fetched; the
  // rest are "copy targets" that receive the same price.
  // Language is part of the key: an EN Charmander and a JP Charmander are
  // different cards with different market prices, so they must fetch and price
  // separately. Without language in the key they collapsed into one lookup and
  // shared a single (wrong for one of them) price. Untagged cards default to
  // EN so they still dedupe together.
  const seen = new Map(); // uniqueKey → id of the primary (first) item
  const queue = [];
  for (const item of all) {
    const key = item.name.trim().toLowerCase() +
      '|' + (item.language ? item.language.toString().toUpperCase() : 'EN') +
      (item.grader ? '|' + item.grader.toLowerCase() : '') +
      (item.grade  ? '|' + item.grade  : '');
    if (!seen.has(key)) {
      seen.set(key, item.id);
      queue.push({ ...item, isPrimary: true, copyTargets: [], uniqueKey: key, lane: _queueLaneFor(item) });
    } else {
      // Find the primary entry and add this as a copy target
      const primary = queue.find(q => q.id === seen.get(key));
      if (primary) primary.copyTargets.push({ id: item.id, table: item.table });
    }
  }

  // Two-lane ordering: free TCGdex singles first (unthrottled, run the whole
  // lane every pass), then the capped PPT lane - slabs by cost desc, then
  // PPT-bound singles by cost desc. Each sub-group already arrived cost-desc
  // from the slabs/singles builders above, so a stable sort by lane preserves
  // that ordering within each bucket.
  const tcgdexItems = queue.filter(i => i.lane === 'tcgdex');
  const pptSlabItems = queue.filter(i => i.lane === 'ppt' && i.table === 'slabs');
  const pptSingleItems = queue.filter(i => i.lane === 'ppt' && i.table === 'singles');
  const ordered = [...tcgdexItems, ...pptSlabItems, ...pptSingleItems];

  return {
    schemaVersion: QUEUE_SCHEMA_VERSION, // loadQueue() discards+rebuilds on a mismatch - see the constant's comment
    items: ordered,        // only primaries, each with copyTargets[]
    cursor: 0,             // index of next PPT-lane item to fetch (tcgdex lane runs independently, see _runRefreshQueueBody)
    totalItems: ordered.length,
    totalRows: all.length, // including duplicates
    createdAt: new Date().toISOString(),
    doneToday: 0,
    dayCreditsUsed: {},    // { 'YYYY-MM-DD': N }
    lastTcgdexPass: null,  // 'YYYY-MM-DD' of the last completed free-lane pass, for auto-run polite caching
    completed: false
  };
}

function getQueueStatus() {
  const q = loadQueue();
  if (!q) return null;
  const today = new Date().toISOString().slice(0,10);
  const usedToday = q.dayCreditsUsed?.[today] || 0;
  const remaining = q.items.length - q.cursor;
  const daysLeft  = Math.ceil(remaining / DAILY_LIMIT);
  return { q, usedToday, remaining, daysLeft, today };
}

// Apply a fetched price to a primary item and all its copy targets
function applyPriceToGroup(primaryId, primaryTable, copyTargets, priceSgd, unit, source, confidence, resolvedTcgdexId) {
  const today = new Date().toISOString().slice(0,10);
  const histEntry = { date: today, price: priceSgd, unit, source, confidence };

  const applyToItem = (id, table) => {
    const item = DB[table]?.find(i => i.id === id);
    if (!item) return;
    item.marketPrice = priceSgd.toFixed(0);
    if (!item.priceHistory) item.priceHistory = [];
    item.priceHistory.push(histEntry);
    if (item.priceHistory.length > PRICE_HISTORY_MAX) item.priceHistory = item.priceHistory.slice(-PRICE_HISTORY_MAX);
    // Copy targets are exact duplicates of the same card - the resolved
    // TCGdex id applies to them too, so a future refresh of one of the
    // copies (e.g. after a manual split) skips the resolve round-trip.
    if (resolvedTcgdexId && !item.tcgdexId) item.tcgdexId = resolvedTcgdexId;
    markDirty(table, id);
    if (item.priceAlert && priceSgd >= parseFloat(item.priceAlert) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      new Notification('🔔 ' + item.name, { body: 'S$' + priceSgd.toFixed(0) + ' hit alert S$' + item.priceAlert });
    }
  };

  applyToItem(primaryId, primaryTable);
  (copyTargets || []).forEach(t => applyToItem(t.id, t.table));
  saveData();
}

// A local dev preview must never hit the production price worker - it burns
// the user's real PPT daily quota and, because the worker only allows the
// github.io origin, every request fails CORS anyway. Guard at the source.
function isLocalhostPreview() {
  try {
    if (location.protocol === 'file:') return true;
    const h = location.hostname || '';
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || /\.local$/.test(h);
  } catch (e) { return false; }
}

// Run today's batch - called on page load and manually from settings
let _queueRunning = false;
async function runRefreshQueue(manual = false) {
  if (_queueRunning) { if (manual) toast('Queue already running...'); return; }
  if (isLocalhostPreview()) {
    if (manual) toast('Price refresh is disabled in local preview (sync off). Use the live site.');
    return;
  }
  // When the Cloudflare Worker proxy is configured it holds the keys
  // server-side, so the local localStorage key check is unnecessary (and
  // misleading - could fail even when the Worker has valid keys). Only
  // require a local key when proxy is disabled.
  if (!PRICE_PROXY_BASE) {
    const hasKeys = getApiKey('ppt');
    if (!hasKeys) { if (manual) { toast('Add API keys first'); openApiSettings(); } return; }
  }
  // Clear yesterday's "paused" sticky state on every manual run so the
  // user can re-trigger after a config change (e.g. wiring up the Worker)
  // without waiting until tomorrow. Without this, the dashboard chip would
  // still read "paused: Failed to fetch - retrying tomorrow" even after a
  // successful run.
  if (manual) {
    const existing = loadQueue();
    if (existing && existing.lastPausedReason) {
      existing.lastPausedReason = null;
      saveQueue(existing);
    }
  }

  let q = loadQueue();
  // First-load auto-bootstrap: if the user has never clicked "Build Queue"
  // but has inventory + API keys, build a queue silently on their behalf so
  // the daily auto-refresh actually runs. Previously the auto-refresh
  // (line ~8228) would silently no-op when loadQueue() returned null,
  // leaving the freshness chip stuck on "refreshed never" forever even
  // though the system was supposedly auto-updating.
  if (!q) {
    const hasInventory = (DB.singles?.length || 0) + (DB.slabs?.length || 0) > 0;
    if (!hasInventory) {
      if (manual) toast('No inventory yet - add some Singles or Slabs first');
      return;
    }
    q = buildRefreshQueue();
    saveQueue(q);
    if (manual) toast('Built queue: ' + q.totalItems + ' unique cards · starting first batch');
  }
  const today = new Date().toISOString().slice(0,10);

  // If the queue is complete but inventory has changed since (new items
  // added), rebuild it automatically so the auto-refresh keeps pricing
  // freshly added rows instead of stalling forever.
  if (q.completed) {
    const currentRowCount = (DB.singles?.filter(i=>(i.status||'Available')==='Available').length || 0)
                          + (DB.slabs  ?.filter(i=>(i.status||'Available')==='Available').length || 0);
    if (currentRowCount > q.totalRows) {
      q = buildRefreshQueue();
      saveQueue(q);
      if (manual) toast('Inventory grew - rebuilt queue (' + q.totalItems + ' cards)');
    } else if (manual || _tcgdexLaneHasWork(q, today)) {
      // The PPT lane is fully drained and there's nothing new to add it to,
      // but the free TCGdex lane still gets its own daily pass - it doesn't
      // compete for PPT credits, so "queue complete" for PPT shouldn't mean
      // "stop pricing the free lane too". Self-heal: check actual per-card
      // work remaining (_tcgdexLaneHasWork), not just whether the stamp says
      // today - an interrupted pass can leave cards unattempted even though
      // lastTcgdexPass already matches today, and this must still re-enter on
      // the next auto (page-load) run to finish them, not wait for tomorrow.
      // Manual "run now" always re-enters regardless.
      _queueRunning = true;
      try {
        await _runRefreshQueueBody(q, 0, manual, today, q.dayCreditsUsed?.[today] || 0);
      } finally {
        _queueRunning = false;
        hideSyncProgress();
      }
      return;
    } else {
      if (manual) toast('Queue complete - reset to start a new cycle');
      return;
    }
  }

  const usedToday = q.dayCreditsUsed?.[today] || 0;
  const creditsLeft = DAILY_LIMIT - usedToday;

  if (creditsLeft <= 0) {
    // PPT's daily budget is spent, but TCGdex is free and independent of it -
    // still give the tcgdex lane its pass instead of returning early and
    // starving it every time PPT happens to be capped out for the day.
    // _runRefreshQueueBody's own empty-ppt-batch branch handles the manual
    // toast (it already distinguishes "genuinely complete" from "just capped
    // for today" and reports the tcgdex outcome), so nothing further to do
    // here beyond the run itself.
    _queueRunning = true;
    try {
      await _runRefreshQueueBody(q, 0, manual, today, usedToday);
    } finally {
      _queueRunning = false;
      hideSyncProgress();
    }
    return;
  }

  _queueRunning = true;
  // Everything from here on is wrapped in try/finally so a thrown error
  // (network blip, a bug in classifyResult, whatever) can never leave
  // _queueRunning stuck true forever - that would permanently block every
  // future run (manual or auto) with "Queue already running...". The
  // existing normal-path resets of _queueRunning/hideSyncProgress are left
  // in place further down; calling them again from finally is a harmless
  // no-op (hideSyncProgress no-ops if the bar is already gone, and setting
  // a boolean to its current value does nothing).
  try {
    await _runRefreshQueueBody(q, creditsLeft, manual, today, usedToday);
  } finally {
    _queueRunning = false;
    hideSyncProgress();
  }
}

// TCGDEX_GAP_MS - TCGdex is free and unthrottled (no documented rate limit),
// but a small gap is still polite to their infra and avoids hammering it in
// a tight loop. Nowhere near PPT's 6s spacing since there's no abuse
// detector to trip here.
const TCGDEX_GAP_MS = 250;

// Shared per-card "is this tcgdex-lane item done for today" predicate - a
// card counts as done once its live DB row carries a price fetched today
// (checked via priceHistory, not the queue's own stale copy, so a card
// priced earlier in an interrupted-then-resumed pass is correctly recognised
// as done). Used by both _runTcgdexLane (to build today's todo list) and
// _tcgdexLaneHasWork (the outer runRefreshQueue gate, so an auto run on page
// load can tell "genuinely nothing left today" apart from "stamp says today
// but an interrupted pass left cards unattempted").
function _tcgdexPricedToday(item, today) {
  const row = DB[item.table]?.find(i => i.id === item.id);
  if (!row || !row.marketPrice) return false;
  const hist = Array.isArray(row.priceHistory) ? row.priceHistory : [];
  const last = hist[hist.length - 1];
  return !!(last && last.date === today);
}

// True when at least one tcgdex-lane item still needs an attempt today (not
// yet priced today, and didn't already miss today). Lets the outer
// runRefreshQueue gate distinguish "lastTcgdexPass stamp says today but an
// interrupted pass left cards unattempted" (self-heal: still has work, must
// re-enter even on an auto/page-load run) from "genuinely fully done today"
// (no work, safe to skip until tomorrow).
function _tcgdexLaneHasWork(q, today) {
  return q.items.some(i => i.lane === 'tcgdex' && !_tcgdexPricedToday(i, today) && i._tcgdexMissDate !== today);
}

// Free-lane pass: every TCGdex-lane item that still needs an attempt today,
// in one go, no credit accounting (TCGdex is free, tcgdexOnly:true on the
// fetchMarketPrice call below means this lane NEVER triggers a PPT request -
// see fetchMarketPrice's tcgdexOnly branch). Runs BEFORE the PPT lane and is
// entirely decoupled from its cap/pause logic, so a PPT hard-block or
// daily-limit hit never stops TCGdex items from running - the two lanes only
// share the same queue array and the same "advance past resolved items"
// bookkeeping.
//
// Self-heal, per-card (not per-lane): the old version stamped
// q.lastTcgdexPass=today after the loop REGARDLESS of outcome and the auto
// run skipped the WHOLE lane once that stamp matched today - so an
// interrupted pass (tab closed mid-loop, page reload) that had priced only a
// couple of cards would stamp "done for today" and go silent on the rest
// until tomorrow. Now each card is judged individually every time this runs
// (via _tcgdexPricedToday):
//   - SKIP a card only if (a) it already has a fresh (today's) price on its
//     live DB row, or (b) it already missed today (item._tcgdexMissDate ===
//     today, a per-card marker so a known miss isn't re-requested more than
//     once per day).
//   - PROCESS everything else: never-attempted cards (including ones added
//     mid-pass or left over from an interrupted run) get tried every time
//     this lane runs, auto or manual, until they're priced or miss today.
// Once every resolvable EN card is priced (or missed) for today, a re-run
// finds nothing left to skip-check-fail on and the lane idles near-instantly
// (all skip, zero fetches) - so re-running is always safe and cheap.
async function _runTcgdexLane(q, manual, today) {
  const laneItems = q.items.filter(i => i.lane === 'tcgdex');
  // Manual "run now" always retries known misses too (e.g. the user just
  // fixed a card's number and wants it re-attempted immediately, not
  // deferred until tomorrow's pass) - clear today's miss markers first so
  // the todo filter below picks them back up. Auto (page-load) runs leave
  // the markers alone: a known miss stays deferred to tomorrow, only
  // genuinely never-attempted cards self-heal on an auto run.
  // _tcgdexMissDate is stamped on the queue item (for the skip/todo logic
  // above) AND mirrored onto the live DB row (for _kjrUnresolvedSingles /
  // the unresolved banner, which read DB.singles directly and have no
  // reason to know the queue's internal shape) - same pattern as tcgdexId
  // already being written to both places. Missing this mirror would leave
  // _kjrUnresolvedSingles blind to "had a number, TCGdex found no unique
  // match today" and only ever catch "no number at all".
  const setMissDate = (item, val) => {
    item._tcgdexMissDate = val;
    const row = DB[item.table]?.find(i => i.id === item.id);
    if (row) row._tcgdexMissDate = val;
  };
  if (manual) laneItems.forEach(item => { if (item._tcgdexMissDate === today) setMissDate(item, null); });
  const todo = laneItems.filter(item => !_tcgdexPricedToday(item, today) && item._tcgdexMissDate !== today);
  let done = 0, failedData = 0, skipped = laneItems.length - todo.length;
  const errorTally = {};
  for (let i = 0; i < todo.length; i++) {
    const item = todo[i];
    showSyncProgress(i, todo.length, 'Exact (TCGdex): ' + (i+1) + '/' + todo.length);
    const r = await fetchMarketPrice({ name: item.name, grader: null, grade: null, language: item.language, tcgdexId: item.tcgdexId||null, tcgdexOnly: true });
    if (r.resolvedTcgdexId && !item.tcgdexId) item.tcgdexId = r.resolvedTcgdexId;
    if (r.maxSgd) {
      applyPriceToGroup(item.id, item.table, item.copyTargets, r.maxSgd, r.maxUsd ? 'USD' : 'EUR', r.source, r.confidence, r.resolvedTcgdexId);
      setMissDate(item, null); // clear any stale miss marker now it's priced
      done++;
    } else {
      // A TCGdex-lane miss (unresolved name/number, or a genuine no-price
      // common) is a data outcome, never a credit-burning transport retry -
      // TCGdex costs nothing, so there's no budget to protect by deferring
      // it. Stamp today's date so this same card isn't re-requested again
      // today (self-heal only retries NEW/unattempted cards within a day;
      // a known miss waits for tomorrow's pass, or the user fixing the card
      // triggers a manual re-run which always re-attempts everything).
      setMissDate(item, today);
      failedData++;
      if (r.tcgdexError) errorTally[r.tcgdexError] = (errorTally[r.tcgdexError]||0) + 1;
    }
    saveData();
    if (i < todo.length - 1) await new Promise(res => setTimeout(res, TCGDEX_GAP_MS));
  }
  q.lastTcgdexPass = today;
  // ran:true whenever there was lane work to consider (even if every card was
  // skipped) so the caller still reports/persists an outcome for the status
  // panel - "ran but nothing to do" is a real, reportable state, distinct
  // from "no tcgdex-lane items exist at all" (laneItems.length === 0).
  return { done, failedData, skipped, ran: laneItems.length > 0, errorTally, total: laneItems.length };
}

async function _runRefreshQueueBody(q, creditsLeft, manual, today, usedToday) {
  // Free lane first, full pass, decoupled from PPT's cap/pause below. Every
  // tcgdex-lane item gets a definitive outcome this pass (priced, or a clean
  // "no price" data miss - TCGdex is free, so there's no transport-failure/
  // retry-tomorrow concept to preserve for it). Once run, splice the whole
  // lane out of q.items: it isn't part of the PPT cursor's retry bookkeeping,
  // and buildRefreshQueue re-derives fresh tcgdex-lane items on every rebuild
  // anyway, so nothing is lost by not keeping them parked in the array.
  // q.cursor is adjusted by however many already-passed items sat before it,
  // so PPT-lane progress made on earlier runs today is preserved exactly.
  const tcgdexResult = await _runTcgdexLane(q, manual, today);
  if (tcgdexResult.ran) {
    // Stash the outcome on the queue itself before splicing the lane's items
    // out of q.items below - the status panel and dashboard chip read these
    // persisted counts (they can't just count q.items after a run, since the
    // whole tcgdex lane is gone from that array by the time they render).
    q.lastTcgdexTotal = tcgdexResult.total;
    q.lastTcgdexDone  = tcgdexResult.done;
    const beforeCursor = q.items.slice(0, q.cursor).filter(i => i.lane === 'tcgdex').length;
    q.items = q.items.filter(i => i.lane !== 'tcgdex');
    q.cursor = Math.max(0, q.cursor - beforeCursor);
    q.totalItems = q.items.length;
  }
  saveQueue(q); // persist lastTcgdexPass + splice + any resolved tcgdexId/prices immediately

  // PPT lane: unchanged cursor/credit mechanics - q.items is now purely the
  // ppt-lane array (slabs, then PPT-bound singles), so no other change needed
  // to the batch-slice/tail-rebuild logic below.
  // NOTE: an empty batch here has two different causes that must NOT be
  // conflated - (a) q.cursor has genuinely walked past every ppt-lane item
  // (real completion), vs (b) creditsLeft is 0 because today's PPT budget is
  // already spent but ppt-lane items remain (called with creditsLeft=0 so
  // the free tcgdex lane above still gets to run). Only (a) is "complete";
  // marking (b) complete would wrongly stop future PPT runs today AND
  // tomorrow until a manual rebuild, because q.completed short-circuits
  // runRefreshQueue before it ever reaches this function.
  const batch = q.items.slice(q.cursor, q.cursor + creditsLeft);
  if (!batch.length) {
    const pptLaneExhausted = q.cursor >= q.items.length; // (a) - genuinely nothing left
    if (pptLaneExhausted) q.completed = true;
    saveQueue(q);
    // The free lane may have priced cards even when the PPT lane has nothing
    // left to do today (either cause), so re-render + report its outcome
    // rather than going silent just because the capped lane is empty.
    if (tcgdexResult.ran && (tcgdexResult.done || tcgdexResult.failedData)) { renderSingles(); renderSlabs(); }
    const tcgdexNote = tcgdexResult.ran ? ' · Exact (TCGdex): ' + tcgdexResult.done + '/' + tcgdexResult.total + ' priced' : '';
    if (manual) {
      if (pptLaneExhausted) toast('All cards refreshed!' + tcgdexNote + ' Reset queue to start a new cycle.');
      else toast('PPT daily limit reached.' + tcgdexNote + ' PPT resumes tomorrow.');
    }
    return;
  }

  // Track outcome per item so we can:
  //   • count data failures (no match for that card) separately from
  //     transport failures (HTTP 4xx/5xx, rate-limit, network) - only the
  //     former should burn the cursor + a daily credit; the latter should
  //     be retried.
  //   • surface the dominant error to the user so they know whether to
  //     check their key, wait for tomorrow, or correct the card name.
  //   • auto-pause after a run of consecutive transport failures so we
  //     don't grind through the whole queue when the API is down.
  let done = 0, failedData = 0, failedTransport = 0, copied = 0;
  let consecTransport = 0;
  let creditsSpent = 0;         // real PPT data-returning requests billed today (a fallback card can cost 2)
  const errorTally = {};        // { 'HTTP 429': 17, 'no match': 3 ... }
  const advancedItems = [];     // items whose cursor position we'll commit
  const retryItems    = [];     // items kept for tomorrow (transport-failed)
  const TRANSPORT_FAIL_PAUSE = 5; // pause after 5 in a row
  const total = batch.length;
  let pausedReason = null;

  // Classify a fetchMarketPrice() result:
  //   'ok'        → priced
  //   'data'      → both sources said "no match" or "no price data"  (burn credit, advance)
  //   'transport' → HTTP error, rate limit, network failure          (don't burn credit, retry)
  // Sentinels from sources that never actually attempted a request: a
  // disabled/no-key source, OR a lane where that source flatly doesn't apply
  // - TCGdex is never tried for slabs, PPT is never consulted again once
  // TCGdex already succeeded. Shared by classifyResult AND tallyErrors - the
  // tally once included them, so the toast read "2 failed (2× disabled, 1×
  // no match)" with the real trigger (a 429) pushed out of the top-2 by
  // sentinel noise. CRITICAL: 'not applicable' must stay in this list, or a
  // slab's "TCGdex never tried" sentinel poisons the every(isTransport)
  // check below exactly like the old 'disabled' bug.
  const NON_ATTEMPT = /^(disabled|no api key|not applicable)$/i;
  function classifyResult(r) {
    if (r.maxSgd) return 'ok';
    // Drop non-attempt sentinels. If we don't, a disabled source's "disabled"
    // string poisons the every(isTransport) check below: a real PPT "HTTP 403"
    // (key blocked) paired with "disabled" would look like a mixed result and
    // be miscounted as a permanent "data" miss - burning a credit, advancing
    // the cursor (card skipped forever), and skipping the hard-block pause.
    // Only errors from sources that tried count.
    const errs = [r.pptError, r.tcgdexError].filter(e => e && !NON_ATTEMPT.test(e));
    if (!errs.length) return 'data'; // no real attempt errors - treat as data
    const isTransport = e => /^HTTP \d/i.test(e) || /network|fetch|failed|aborted|timeout|cors|rate.?limit|429|403|blocked|abuse/i.test(e);
    if (errs.every(isTransport)) return 'transport';
    return 'data'; // at least one source returned a meaningful "no match"
  }
  function tallyErrors(r) {
    [r.pptError, r.tcgdexError].filter(e => e && !NON_ATTEMPT.test(e)).forEach(e => {
      errorTally[e] = (errorTally[e] || 0) + 1;
    });
  }

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i];
    showSyncProgress(done + failedData + failedTransport, total,
      'Queue: ' + (q.cursor + done + failedData + failedTransport + 1) + '/' + q.totalItems +
      ' · Day credit ' + Math.min(usedToday + creditsSpent + 1, DAILY_LIMIT) + '/' + DAILY_LIMIT);

    const r = await fetchMarketPrice({ name: item.name, grader: item.grader, grade: item.grade, language: item.language, tcgdexId: item.tcgdexId||null });
    creditsSpent += r.creditsUsed || 0; // bill real PPT requests, not cards
    // Persist a freshly-resolved id on the queue's own item copy so a
    // requeue (retry/tomorrow) skips the resolve round-trip next time.
    if (r.resolvedTcgdexId && !item.tcgdexId) item.tcgdexId = r.resolvedTcgdexId;
    const kind = classifyResult(r);
    if (kind === 'ok') {
      applyPriceToGroup(item.id, item.table, item.copyTargets, r.maxSgd, r.maxUsd ? 'USD' : 'EUR', r.source, r.confidence, r.resolvedTcgdexId);
      copied += item.copyTargets?.length || 0;
      done++;
      consecTransport = 0;
      advancedItems.push(item);
    } else if (kind === 'data') {
      failedData++;
      consecTransport = 0;
      tallyErrors(r);
      advancedItems.push(item); // burn the credit + advance cursor - name is wrong
    } else { // transport
      failedTransport++;
      consecTransport++;
      tallyErrors(r);
      retryItems.push(item);    // keep in queue for tomorrow
      // Hard-pause on 403/429 the FIRST time we see one. PPT's free plan
      // auto-blocks the key after accumulating 50 429s in 5 minutes - and
      // the block lasts 24h. Burning more requests against a blocked key
      // only deepens the block. Previously we waited for 5 consecutive
      // failures, which was 5× too many on the way to a 24h lockout.
      const isHardBlock = [r.pptError, r.tcgdexError].some(e => /403|429|blocked|abuse/i.test(e || ''));
      if (isHardBlock || consecTransport >= TRANSPORT_FAIL_PAUSE) {
        const top = Object.entries(errorTally).sort((a,b) => b[1]-a[1])[0];
        // Carry the actual refusal (e.g. "HTTP 429") into the reason. The old
        // blanket "rate-limited / key blocked" claimed a key problem on every
        // single transient 429 - and the settings pill keys off /403|blocked/
        // in this string, so a 429 must NOT say "blocked". A one-off 429 pause
        // is the protection working, not a broken key (verified: the key
        // answered 200 OK the morning after such a pause).
        const trigger = [r.pptError, r.tcgdexError].find(e => /403|429|blocked|abuse/i.test(e || '')) || 'rate limit';
        pausedReason = isHardBlock ? 'PPT refused (' + trigger.slice(0, 40) + ')' : (top ? top[0] : 'transport');
        // Move remaining (unfetched) items into retryItems so they aren't
        // dropped from the queue.
        for (let j = i + 1; j < batch.length; j++) retryItems.push(batch[j]);
        break;
      }
    }
    saveData();
    // Stop once today's real PPT request budget is spent. A fallback search
    // makes a card cost 2 requests, so the card count (batch size) isn't the
    // ceiling - actual requests are. Remaining cards stay queued for tomorrow.
    if (i < batch.length - 1 && usedToday + creditsSpent >= DAILY_LIMIT) {
      for (let j = i + 1; j < batch.length; j++) retryItems.push(batch[j]);
      break;
    }
    await new Promise(res => setTimeout(res, REQUEST_GAP_MS)); // respect PPT free-plan rate limit
  }

  // Rebuild the queue tail: items we advanced past + items we kept for
  // retry stay; everything *after* the batch stays where it was.
  // q.items[0..cursor]                                = already processed (untouched)
  // q.items[cursor .. cursor+batch.length] (batch)    = replaced by advancedItems then retryItems
  // q.items[cursor+batch.length .. end]               = untouched
  const head = q.items.slice(0, q.cursor);
  const tail = q.items.slice(q.cursor + batch.length);
  q.items = [...head, ...advancedItems, ...retryItems, ...tail];
  q.cursor = q.cursor + advancedItems.length; // only advance past items we accept as "done for now"
  q.totalItems = q.items.length;
  if (!q.dayCreditsUsed) q.dayCreditsUsed = {};
  // Bill the real PPT requests made (creditsSpent), not the card count. A card
  // that needed the fallback search consumed 2 requests; a transport failure
  // consumed 0 (PPT refused with 429/403 or crashed with 5xx - not metered,
  // and we retry tomorrow anyway). Counting cards would under-bill fallbacks
  // and risk silently overrunning PPT's free-plan daily limit.
  q.dayCreditsUsed[today] = (q.dayCreditsUsed[today] || 0) + creditsSpent;
  if (q.cursor >= q.items.length) q.completed = true;
  // Stamp the last error reason so the dashboard / settings panel can
  // surface it instead of just "100 failed".
  q.lastErrorTally  = errorTally;
  q.lastRunAt       = new Date().toISOString();
  q.lastPausedReason = pausedReason;
  saveQueue(q);

  hideSyncProgress();
  _queueRunning = false;

  // Re-render affected tables
  renderSingles();
  renderSlabs();

  // Build the toast - surface the dominant error so the user understands
  // *why* nothing was priced. Previously the message was just
  // "Queue: 0 fetched, 100 failed" with no diagnostic value.
  const failedTotal = failedData + failedTransport;
  const errSummary  = Object.entries(errorTally).sort((a,b) => b[1]-a[1]).slice(0,2)
                            .map(([err,n]) => n + '× ' + err).join(', ');
  const diagHint =
      pausedReason                          ? ' · ⏸ paused: ' + pausedReason + ' - retrying tomorrow'
    : failedTransport >= 5 && done === 0    ? ' · API looks down - check 🔑 keys'
    : /401|403|invalid|unauthor/i.test(errSummary)
                                            ? ' · ⚠ key invalid - check 🔑 settings'
    : /429|rate/i.test(errSummary)          ? ' · ⏰ rate-limited - slows down'
    : '';
  const tcgdexNote = tcgdexResult.ran
    ? ' · Exact (TCGdex): ' + tcgdexResult.done + '/' + tcgdexResult.total + ' priced'
    : '';
  const msg = 'Queue: ' + done + ' fetched' + tcgdexNote +
    (copied ? ', ' + copied + ' copies updated' : '') +
    (failedTotal ? ', ' + failedTotal + ' failed' + (errSummary ? ' (' + errSummary + ')' : '') : '') +
    diagHint +
    (q.completed ? ' · ✅ Complete!' : ' · ' + (q.items.length - q.cursor) + ' remaining' +
                                       (retryItems.length ? ' (' + retryItems.length + ' kept for retry)' : ''));
  toast(msg, 7000);

  // Refresh settings panel if open
  if (document.getElementById('api-key-modal')) _renderQueueStatus();
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
}

// Raw singles that are Available and in a manual-only language (anything
// non-English: JP/CN/ID/KR/...) - separate from "unresolved" below because
// there's no fix available on the pricing side at all, by product design
// (English-only auto-pricing, see _queueLaneFor) rather than a per-card data
// problem. Named for what it actually checks now (every non-EN language,
// matching _queueLaneFor's 'manual' lane exactly) - was briefly
// "_kjrChineseUnpriceable" mid-rework when the check was CN-only, renamed
// once it broadened so a JP/ID/KR card never surfaces as "Chinese" in the UI.
function _kjrManualLangCards() {
  return (DB.singles || []).filter(i => {
    if ((i.status||'Available') !== 'Available') return false;
    const lang = (i.language||'EN').toString().trim().toUpperCase();
    return lang !== 'EN' && lang !== '';
  });
}

// Raw singles that are Available, English (or blank, which defaults to EN -
// see _queueLaneFor), but could not be auto-priced: either no extractable
// name+number to resolve a TCGdex id at all, or a number WAS extracted but
// today's TCGdex lookup found no unique match (_tcgdexMissDate stamped by
// _runTcgdexLane's self-heal loop, cleared automatically once the card is
// priced or the date rolls over). Never counts JP/CN/ID/KR cards - those are
// manual by design (_kjrManualLangCards above), not "unresolved". Mirrors
// _queueLaneFor's resolvability check for the no-number case.
function _kjrUnresolvedSingles() {
  return (DB.singles || []).filter(i => {
    if ((i.status||'Available') !== 'Available') return false;
    if (i.tcgdexId) return false; // already resolved
    const lang = (i.language||'EN').toString().trim().toUpperCase();
    if (lang !== 'EN' && lang !== '') return false; // manual language, not "fixable" by adding a number
    if (i._tcgdexMissDate) return true; // had a number, TCGdex tried today and found no unique match
    return !(_baseCardName(i.name) && _tcgdexNumber(i.name));
  });
}

function _renderQueueStatus() {
  const el = document.getElementById('queue-status-panel');
  if (!el) return;
  const s = getQueueStatus();
  if (!s) {
    el.innerHTML = '<div style="color:var(--text3);font-size:12px">No queue built yet.</div>';
    return;
  }
  const { q, usedToday, remaining, daysLeft, today } = s;
  // q.items only becomes PPT-lane-only AFTER the first run of the day (the
  // tcgdex lane is spliced out post-pass, see _runRefreshQueueBody) - a
  // freshly built queue that has never run yet still has BOTH lanes mixed
  // together in q.items. Slabs are always lane==='ppt' (no tcgdex-eligible
  // slab exists), so filtering by table==='slabs' alone is always safe. A
  // single can be EITHER lane though, so "Singles (PPT)" must also require
  // lane==='ppt' or it would double-count a tcgdex-lane single as PPT work
  // before the first splice ever happens (verified live: a freshly built
  // queue with 1 tcgdex single + 1 ppt single showed "Singles (PPT): 0/2"
  // instead of the correct 0/1).
  const pct = q.totalItems > 0 ? Math.round((q.cursor / q.totalItems) * 100) : 100;
  const slabsDone   = q.items.slice(0, q.cursor).filter(i => i.table === 'slabs').length;
  const slabsTotal  = q.items.filter(i => i.table === 'slabs').length;
  const singlesDone = q.items.slice(0, q.cursor).filter(i => i.table === 'singles' && i.lane === 'ppt').length;
  const singlesTotal= q.items.filter(i => i.table === 'singles' && i.lane === 'ppt').length;
  const tcgdexTotal = q.lastTcgdexTotal || 0;
  const tcgdexDone  = q.lastTcgdexDone  || 0;
  const tcgdexRanToday = q.lastTcgdexPass === today;

  const unresolvedCount = _kjrUnresolvedSingles().length;
  const manualLangCount = _kjrManualLangCards().length;

  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:12px">
      <span style="font-weight:600">${q.completed ? '✅ PPT lane complete' : 'In progress'}</span>
      <span style="color:var(--text3)">${q.totalRows} total rows</span>
    </div>
    <div style="height:6px;background:var(--bg3);border-radius:3px;margin-bottom:10px">
      <div style="height:6px;width:${pct}%;background:var(--accent);border-radius:3px;transition:width 0.3s"></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px;margin-bottom:10px">
      <div style="padding:8px;background:var(--bg3);border-radius:6px" title="Raw singles priced free via TCGdex (TCGplayer/Cardmarket), matched by card number and language. Runs a full pass once a day.">
        <div style="color:var(--text3);margin-bottom:2px">Exact (TCGdex)</div>
        <div style="font-weight:600">${tcgdexRanToday ? tcgdexDone + '/' + tcgdexTotal + ' today' : (tcgdexTotal ? tcgdexDone + '/' + tcgdexTotal + ' (last run)' : 'not run yet')}</div>
      </div>
      <div style="padding:8px;background:var(--bg3);border-radius:6px" title="Slabs (always) and TCGdex misses, priced via PokemonPriceTracker eBay sold data. Capped at ${DAILY_LIMIT}/day.">
        <div style="color:var(--text3);margin-bottom:2px">Search (PPT)</div>
        <div style="font-weight:600">${usedToday}/${DAILY_LIMIT} credits</div>
      </div>
      <div style="padding:8px;background:var(--bg3);border-radius:6px">
        <div style="color:var(--text3);margin-bottom:2px">Slabs (PPT)</div>
        <div style="font-weight:600">${slabsDone}/${slabsTotal} done</div>
      </div>
      <div style="padding:8px;background:var(--bg3);border-radius:6px">
        <div style="color:var(--text3);margin-bottom:2px">Singles (PPT)</div>
        <div style="font-weight:600">${singlesDone}/${singlesTotal} done</div>
      </div>
      <div style="padding:8px;background:var(--bg3);border-radius:6px;grid-column:1 / -1">
        <div style="color:var(--text3);margin-bottom:2px">Est. days remaining (PPT lane)</div>
        <div style="font-weight:600">${q.completed ? '0' : daysLeft}</div>
      </div>
    </div>
    ${(unresolvedCount > 0 || manualLangCount > 0) ? `<div style="font-size:11px;color:var(--amber);background:var(--amber-soft);border:1px solid var(--amber);border-radius:6px;padding:8px 10px;margin-bottom:10px;line-height:1.5">
      ${unresolvedCount > 0 ? unresolvedCount + ' card' + (unresolvedCount!==1?'s':'') + ' unresolved, add the card number for exact pricing.' : ''}
      ${unresolvedCount > 0 && manualLangCount > 0 ? '<br>' : ''}
      ${manualLangCount > 0 ? manualLangCount + ' non-English card' + (manualLangCount!==1?'s':'') + ' priced manually, no free source for that language.' : ''}
    </div>` : ''}
    <div style="font-size:11px;color:var(--text3);margin-bottom:10px">
      Queue built ${new Date(q.createdAt).toLocaleDateString()} ·
      ${q.items.filter(i=>i.copyTargets?.length).length} cards will copy price to duplicates
    </div>
    ${(() => {
      // Diagnostic banner: surface the last run's dominant error so the
      // user knows whether to fix their key, wait for the API, or correct
      // a card name. Previously "100 failed" was a black box.
      if (!q.lastErrorTally || !Object.keys(q.lastErrorTally).length) return '';
      const top = Object.entries(q.lastErrorTally).sort((a,b) => b[1]-a[1]).slice(0,3);
      const total = top.reduce((s,[,n]) => s+n, 0);
      const dominant = top[0][0];
      let advice = '';
      if (/401|403|invalid|unauthor/i.test(dominant))     advice = 'Likely cause: API key invalid or expired. Open 🔑 Price API Settings and re-test.';
      else if (/429|rate/i.test(dominant))                advice = 'Likely cause: rate-limited by the vendor. The queue will retry these tomorrow automatically.';
      else if (/HTTP 5\d\d/.test(dominant))               advice = 'Likely cause: vendor API is down. The queue will retry these tomorrow.';
      else if (/no match|no price/i.test(dominant))       advice = 'Likely cause: card name doesn\'t match the vendor\'s catalogue. Try renaming the card on the Singles/Slabs tab and run again.';
      else if (/network|fetch|aborted|timeout|cors/i.test(dominant)) advice = 'Likely cause: your network blocked the request (Wi-Fi, VPN, browser extension). Items kept for retry.';
      return `<div style="font-size:11px;color:#f59e0b;background:#f59e0b14;border:1px solid #f59e0b40;border-radius:6px;padding:8px 10px;margin-bottom:10px;line-height:1.5">
        <strong>Last run had ${total} failure${total!==1?'s':''}.</strong>
        ${top.map(([e,n]) => '<span style="color:var(--text)">' + n + '×</span> ' + e).join(' · ')}
        ${q.lastPausedReason ? '<br><strong>Auto-paused</strong> after 5 consecutive ' + q.lastPausedReason + ' errors - remaining items kept in queue.' : ''}
        ${advice ? '<br>' + advice : ''}
      </div>`;
    })()}
    ${(() => {
      // Manual run stays enabled while EITHER lane has work: PPT (cursor not
      // at the end, or credits are available) OR TCGdex (manual always
      // re-runs it regardless of lastTcgdexPass, so it's only truly out of
      // work when the PPT lane is complete AND there are zero TCGdex-lane-
      // eligible cards - i.e. a fresh empty/all-CN/all-slabs collection).
      const pptHasWork = !q.completed || usedToday < DAILY_LIMIT;
      const nothingLeft = q.completed && tcgdexTotal === 0;
      return `<div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="runRefreshQueue(true)" ${nothingLeft?'disabled':''}>
        ▶ Run Today's Batch
      </button>
      <button class="btn btn-sm" onclick="startFreshQueue()">↺ Rebuild Queue</button>
      <button class="btn btn-sm" style="color:var(--red)" onclick="(async()=>{ if(await kjrConfirm('Clear queue?', {ok:'Clear', danger:true})){clearQueue();_renderQueueStatus();} })()">✕ Clear</button>
    </div>`;
    })()}
    ${usedToday >= DAILY_LIMIT ? '<div style="font-size:11px;color:#f59e0b;margin-top:8px">⏰ PPT daily limit reached - Search lane resumes tomorrow (Exact/TCGdex lane is unaffected)</div>' : ''}
    ${q.completed ? '<div style="font-size:11px;color:var(--green);margin-top:8px">✅ PPT lane fully refreshed. Rebuild queue to start next cycle.</div>' : ''}
  `;
}

async function startFreshQueue() {
  // A refresh pass in flight saves the queue via saveQueue() at multiple
  // points as it progresses (raw last-write-wins). Rebuilding here while
  // that's running would get silently clobbered by the next in-flight save.
  if (_queueRunning) { toast('A refresh pass is already running - wait for it to finish first'); return; }
  if (!await kjrConfirm('Build a new refresh queue from your current inventory? This resets all progress.', {ok:'Rebuild queue'})) return;
  const q = buildRefreshQueue();
  saveQueue(q);
  _renderQueueStatus();
  const tcgdexCount = q.items.filter(i=>i.lane==='tcgdex').length;
  const pptCount = q.items.filter(i=>i.lane==='ppt').length;
  toast('Queue built: ' + q.totalItems + ' unique cards (' + q.totalRows + ' rows) · Exact (TCGdex): ' + tcgdexCount + ' · Search (PPT): ' + pptCount);
}

// Old bulkRefreshPrices kept for per-table manual use (bypasses queue).
// Mirrors the queue runner's error handling: auto-pauses on consecutive
// transport failures so we don't grind through all items when the API is
// down, and surfaces the dominant error in the toast.
let _bulkRefreshRunning = false;
async function bulkRefreshPrices(table) {
  if (_bulkRefreshRunning) { toast('Refresh already running...'); return; }
  // TCGdex needs no key; only block when the table can't reach ANY free
  // lane - a slab table has no TCGdex-free option, so it still needs PPT.
  const hasKeys = getApiKey('ppt');
  if (!hasKeys && table === 'slabs') { toast('Add API keys first - click 🔑 in top bar'); openApiSettings(); return; }
  const items = DB[table].filter(i => (i.status||'Available') === 'Available');
  if (!items.length) { toast('No available items to refresh'); return; }
  if (!await kjrConfirm('Manually refresh all ' + items.length + ' ' + esc(table) + ' now? This uses API credits outside the queue. Use the queue for scheduled refreshes.', {ok:'Refresh now'})) return;
  _bulkRefreshRunning = true;
  let done = 0, failedData = 0, failedTransport = 0, consecTransport = 0;
  const errorTally = {};
  let aborted = false;
  // Same NON_ATTEMPT sentinel-stripping as the queue's classifyResult -
  // 'not applicable'/'disabled' must not poison the transport check, or a
  // slab (TCGdex never tried) or a TCGdex-hit raw single (PPT never tried)
  // gets miscounted as a real data failure.
  const NON_ATTEMPT = /^(disabled|no api key|not applicable)$/i;
  const isTransport = e => /^HTTP \d/i.test(e) || /network|fetch|failed|aborted|timeout|cors|rate.?limit|429|403|blocked|abuse/i.test(e);
  for (const item of items) {
    showSyncProgress(done + failedData + failedTransport, items.length, 'Refreshing ' + table + '…');
    const r = await fetchMarketPrice({ name: item.name, grader: item.grader||null, grade: item.grade||null, language: item.language||null, tcgdexId: item.tcgdexId||null });
    if (r.resolvedTcgdexId && !item.tcgdexId) {
      item.tcgdexId = r.resolvedTcgdexId;
      if (r.resolvedCardName) item._tcgdexResolvedName = r.resolvedCardName;
    }
    if (r.maxSgd) {
      item.marketPrice = r.maxSgd.toFixed(0);
      if (!item.priceHistory) item.priceHistory = [];
      item.priceHistory.push({ date: new Date().toISOString().slice(0,10), price: r.maxSgd, unit: r.maxUsd ? 'USD' : 'EUR', source: r.source, confidence: r.confidence });
      if (item.priceHistory.length > PRICE_HISTORY_MAX) item.priceHistory = item.priceHistory.slice(-PRICE_HISTORY_MAX);
      if (item.priceAlert && r.maxSgd >= parseFloat(item.priceAlert) && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification('🔔 ' + item.name, { body: 'S$' + r.maxSgd.toFixed(0) + ' hit alert S$' + item.priceAlert });
      }
      markDirty(table, item.id);
      done++;
      consecTransport = 0;
    } else {
      const errs = [r.pptError, r.tcgdexError].filter(e => e && !NON_ATTEMPT.test(e));
      errs.forEach(e => { errorTally[e] = (errorTally[e]||0) + 1; });
      const transport = errs.length && errs.every(isTransport);
      if (transport) { failedTransport++; consecTransport++; }
      else            { failedData++;       consecTransport = 0; }
      markDirty(table, item.id); // a resolved tcgdexId may still need to sync even on a miss
      // Auto-pause if the API is clearly unhappy - saves time and credits.
      if (consecTransport >= 5) { aborted = true; break; }
    }
    saveData();
    await new Promise(r => setTimeout(r, 1100));
  }
  hideSyncProgress();
  _bulkRefreshRunning = false;
  if (table === 'singles') renderSingles();
  if (table === 'slabs') renderSlabs();
  const failedTotal = failedData + failedTransport;
  const errSummary  = Object.entries(errorTally).sort((a,b) => b[1]-a[1]).slice(0,2)
                            .map(([err,n]) => n + '× ' + err).join(', ');
  const dominant = Object.keys(errorTally).sort((a,b) => errorTally[b]-errorTally[a])[0] || '';
  const advice =
      /401|403|invalid|unauthor/i.test(dominant)            ? ' · ⚠ key invalid - open 🔑 settings'
    : /429|rate/i.test(dominant)                             ? ' · ⏰ rate-limited'
    : /HTTP 5\d\d/.test(dominant)                            ? ' · vendor API down'
    : /no match|no price/i.test(dominant)                    ? ' · names don\'t match catalogue'
    : /network|fetch|aborted|timeout|cors/i.test(dominant)   ? ' · network blocked'
    : '';
  const tail = aborted ? ' · ⏸ auto-paused after 5 failures in a row' : '';
  toast('Done: ' + done + ' updated' + (failedTotal ? ', ' + failedTotal + ' failed' + (errSummary ? ' (' + errSummary + ')' : '') : '') + advice + tail, 7000);
  if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
}

// Format an item's title for the listing - slabs lead with grader+grade,
// followed by card name (number kept intact, e.g. "Feraligatr 201"), then
// the cert number prefixed with #. Raw cards lead with name then language.
// Sealed lead with name + a "[Sealed]" tag.
function _listingTitleFor(item, src){
  // Strip any "(Sealed)" / "[Sealed]" already baked into the stored name so the
  // tag isn't doubled (some rows are literally named e.g. "Eevee 173 (Sealed)").
  const cleanName = ((item.name || item.product || '?')
    .replace(/\s*[\(\[]\s*sealed\s*[\)\]]/ig, '').replace(/\s{2,}/g, ' ').trim()) || '?';

  if (src === 'slabs' || item.type === 'slab') {
    // Normalise grader/grade even when stored combined (e.g. grade="TAG 10").
    const r  = _resolveGrader(item.grader, item.grade, item.notes);
    const g  = r.grader || (item.grader || '').toString().trim().toUpperCase();
    const gr = r.grade  || (item.grade  || '').toString().trim();
    const lead = [g, gr].filter(Boolean).join(' ');
    const cert = item.certNo ? ' #' + item.certNo : '';
    return (lead ? '[' + lead + '] ' : '') + cleanName + cert;
  }
  if (item.type === 'sealed') {
    return '[Sealed] ' + cleanName;
  }
  return cleanName; // raw single - name only
}

function populateListingSelect() {
  const sel = document.getElementById('lst-item');
  if (!sel) return;
  // Only available items - sold rows shouldn't appear in the listing picker.
  const avail = arr => (arr || []).filter(i => (i.status||'Available') === 'Available');
  const allItems = [
    ...avail(DB.singles).map(i => ({ id: i.id, label: _listingTitleFor(i, 'singles'), data: i, src: 'singles' })),
    ...avail(DB.slabs).map(i => ({ id: i.id, label: _listingTitleFor(i, 'slabs'),   data: i, src: 'slabs' })),
    ...(DB.etbs||[]).filter(r => /in\s*stock/i.test(r.status||'')).map(i => ({ id: i.id, label: (i.product||'ETB') + ' [ETB]', data: i, src: 'etbs' })),
    ...(DB.boosterBoxes||[]).filter(r => /unopened/i.test(r.status||'')).map(i => ({ id: i.id, label: (i.product||'Booster Box') + ' [Booster Box]', data: i, src: 'boosterBoxes' })),
    ...(DB.boosterPacks||[]).filter(r => /sealed/i.test(r.status||'')).map(i => ({ id: i.id, label: (i.product||'Pack') + ' [Booster Pack]', data: i, src: 'boosterPacks' })),
  ].sort((a,b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()));
  sel.innerHTML = '<option value="">- choose an item -</option>' +
    allItems.map(i => '<option value="' + esc(i.src + ':' + i.id) + '">' + esc(i.label) + '</option>').join('');
}

let listingText = '';

// Auto-comment templates keyed by item kind. The "type" of an item drives the
// description so a Carousell buyer instantly knows what they're getting.
function _autoCommentFor(item, src){
  // Applies to every listing.
  const general = 'Tracked mail +$3, Collection at 390034 6pm-8pm';

  // SLAB - grade is in the title; body just carries the general line.
  if (src === 'slabs' || item.type === 'slab') {
    return [ general ];
  }
  // SEALED PRODUCTS - ETB / Booster Box / Booster Pack.
  if (src === 'etbs' || src === 'boosterBoxes' || src === 'boosterPacks') {
    return [ 'Brand new, factory sealed.', general ];
  }
  // SINGLES - raw or sealed single.
  return [
    'You will get the exact card in this listing.',
    general,
  ];
}

function _hashtagsFor(item, src){
  let tags;
  if (src === 'slabs' || item.type === 'slab') {
    tags = ['#PSA', '#TAG', '#pokemon'];
  } else if (src === 'etbs' || src === 'boosterBoxes' || src === 'boosterPacks') {
    tags = ['#pokemon', '#tcg', '#sealed'];
  } else {
    // Singles - raw or sealed single.
    tags = ['#pokemon', '#tcg', '#psa'];
  }

  // Pokémon name tag - first word of the card name (e.g. "Eevee 173" → #eevee).
  const first = ((item.name || item.product || '').split(/\s+/)[0] || '')
    .toLowerCase().replace(/[^a-z0-9]/g,'');
  if (first.length > 2) tags.push('#' + first);

  return [...new Set(tags)].join(' ');
}

// Build the listing deterministically - no AI required. AI can optionally
// rewrite the description via "Enhance with AI" button later.
function buildListing(item, src, priceListed, userComments){
  const title = _listingTitleFor(item, src);
  const priceLine = priceListed > 0 ? 'S$' + Math.round(priceListed) : '';
  const auto = _autoCommentFor(item, src);
  const tags = _hashtagsFor(item, src);
  const extra = (userComments || '').trim();
  const lines = [];
  lines.push('=== TITLE ===');
  lines.push(title);
  lines.push('');
  lines.push('=== PRICE ===');
  lines.push(priceLine || '(set a Price Listed)');
  lines.push('');
  lines.push('=== DESCRIPTION ===');
  auto.forEach(l => lines.push(l));
  if (extra) {
    lines.push('');
    lines.push(extra);
  }
  lines.push('');
  lines.push(tags);
  return lines.join('\n');
}

// The "rebuild" button - also runs automatically when the user edits the
// Price Listed or Comments field. Produces a deterministic listing the
// user can copy with one click; no AI key needed.
function rebuildListing(){
  const val = document.getElementById('lst-item').value;
  const textEl = document.getElementById('lst-text');
  const outputWrap = document.getElementById('lst-output');
  const status = document.getElementById('lst-status');
  status.textContent = '';
  if (!val) {
    if (outputWrap) outputWrap.style.display = 'none';
    listingText = '';
    return;
  }
  const [src, id] = val.split(':');
  const item = (DB[src] || []).find(i => i.id === id);
  if (!item) { listingText = ''; return; }
  const price = kjrNum(document.getElementById('lst-price').value);
  listingText = buildListing(item, src, price, '');
  if (textEl) textEl.textContent = listingText;
  // Populate the editable output fields
  const lines = listingText.split('\n');
  const titleIdx = lines.findIndex(l => l.trim() === '=== TITLE ===');
  const descIdx  = lines.findIndex(l => l.trim() === '=== DESCRIPTION ===');
  const titleText = titleIdx >= 0 ? (lines[titleIdx + 1] || '').trim() : '';
  const descText  = descIdx  >= 0 ? lines.slice(descIdx + 1).join('\n').trim() : '';
  const titleBox = document.getElementById('lst-title-box');
  const descBox  = document.getElementById('lst-desc-box');
  // Show the wrapper first so scrollHeight is measurable for auto-grow.
  if (outputWrap) outputWrap.style.display = '';
  if (titleBox) { titleBox.value = titleText; autoGrowLst(titleBox); }
  if (descBox)  { descBox.value  = descText;  autoGrowLst(descBox); }
  status.textContent = 'Built ' + new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}

// Grow a listing textarea to fit its content so there's no wasted whitespace
// and no inner scrollbar - what you see is exactly what you'll copy.
function autoGrowLst(el){
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// Backwards-compat - the inline ✨ button in row actions still calls this.
async function generateListing(){ rebuildListing(); }

// Optional AI polish - rewrites the description in a friendlier voice. Uses
// whatever AI provider the user has configured (free Gemini works fine).
async function enhanceListingWithAI(){
  const val = document.getElementById('lst-item').value;
  if (!val) { toast && toast('Select an item first'); return; }
  const descBox = document.getElementById('lst-desc-box');
  if (!descBox) return;
  if (!descBox.value.trim()) rebuildListing();
  const status = document.getElementById('lst-status');
  const btn = document.getElementById('lst-ai-btn');
  const btnLabel = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.style.opacity = '0.7'; btn.style.cursor = 'wait'; btn.innerHTML = '<span class="kjr-btn-spinner"></span> Enhancing…'; }
  status.textContent = 'AI enhancing…';
  descBox.style.opacity = 0.6;
  // Rewrite only the description; the hashtag lines must survive untouched.
  const prompt = 'Rewrite this Carousell listing DESCRIPTION for a Singapore buyer in friendly, casual SG English. Keep it concise. Keep every hashtag exactly as written, on their own line at the end. Do not add a title or price. Output only the description text.\n\nDescription:\n\n' + descBox.value;
  try {
    const result = await callAI(prompt, false);
    if (result && !result.startsWith('Error') && !result.includes('AI features need')) {
      descBox.value = result.trim();
      autoGrowLst(descBox);
      status.textContent = 'AI-enhanced · ' + new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
    } else {
      status.textContent = result || 'AI not available - using template';
    }
  } catch(e) {
    status.textContent = 'AI failed: ' + e.message;
  } finally {
    descBox.style.opacity = 1;
    if (btn) { btn.disabled = false; btn.style.opacity = ''; btn.style.cursor = ''; btn.innerHTML = btnLabel; }
  }
}

function viewSourceItem(id, table) {
  const page = table === 'singles' ? 'inventory' : 'slabs';
  showPage(page);

  // A sale almost always links to a SOLD item, and sold rows live in the
  // collapsed "Sold" section (a separate tbody), not the visible list. Reveal
  // them first so the row actually exists in the DOM before we look for it.
  if (table === 'singles') {
    // Singles hide/show by a status dropdown; 'all' renders available + sold inline.
    const sf = document.getElementById('singles-status-filter');
    if (sf && sf.value !== 'all' && sf.value !== 'sold') sf.value = 'all';
    if (typeof renderSingles === 'function') renderSingles();
  } else {
    // Slabs keep sold rows in a collapsible section - force it open.
    const divider = document.getElementById('slabs-sold-divider');
    if (divider) divider.dataset.open = '1';
    if (typeof renderSlabs === 'function') renderSlabs();
  }

  setTimeout(() => {
    // Escape the id for use inside a CSS attribute selector.
    const sel = '[data-id="' + (id || '').replace(/"/g, '\\"') + '"]';
    // Look in BOTH the available and the sold tbodies for this table.
    const bodyIds = table === 'singles'
      ? ['singles-body', 'singles-sold-body']
      : ['slabs-body', 'slabs-sold-body'];
    let el = null;
    for (const bid of bodyIds) {
      const root = document.getElementById(bid);
      const found = root ? root.querySelector(sel) : null;
      if (found) { el = found; break; }
    }
    if (el) {
      el.scrollIntoView({behavior:'smooth', block:'center'});
      el.style.outline = '2px solid var(--accent)';
      el.style.outlineOffset = '-2px';
      setTimeout(() => { el.style.outline = ''; el.style.outlineOffset = ''; }, 2500);
    } else {
      toast('Source item not found (may have been deleted)');
    }
  }, 320);
}

function copyLstSection(section) {
  // Copy exactly what's in the (editable) field, so any inline tweaks are kept.
  const el = document.getElementById(section === 'title' ? 'lst-title-box' : 'lst-desc-box');
  const text = (el && el.value || '').trim();
  if (!text) { toast && toast('Build a listing first'); return; }
  const ok = () => toast && toast('✓ Copied');
  const fallback = () => { try { const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText='position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); ok(); } catch(e) { toast && toast('Copy failed'); } };
  navigator.clipboard ? navigator.clipboard.writeText(text).then(ok).catch(fallback) : fallback();
}

function copyListing() {
  if (!listingText) { toast && toast('Nothing to copy - build a listing first'); return; }
  // Modern clipboard API (HTTPS only); fall back to a hidden textarea so
  // copying still works on local file:// pages or older browsers.
  const ok = () => { toast && toast('✓ Copied to clipboard'); };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = listingText;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      ok();
    } catch(e) {
      toast && toast('Copy failed - manual copy: open the listing and Ctrl+C');
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(listingText).then(ok).catch(fallback);
  } else {
    fallback();
  }
}

async function searchEbay() {
  const q = document.getElementById('ebay-query').value.trim();
  if (!q) { toast('Enter a search query'); return; }
  const outEl = document.getElementById('ebay-out');
  outEl.style.display = 'block';
  outEl.innerHTML = '<span class="ai-status">Searching…</span>';

  // TCGdex needs no key at all (free, CORS-open), so this always has a real
  // source to try - raw singles resolve via TCGdex first, falling back to
  // PPT (client key OR Worker proxy) on a TCGdex miss. The AI-estimate
  // fallback this function used to have when neither source was configured
  // is gone: it became unreachable once TCGdex removed the "no source at
  // all" case entirely (Market Price rework, Phase 6 UI-honesty pass).
  outEl.innerHTML = '<span class="ai-status">Fetching from TCGdex + PokemonPriceTracker...</span>';
  let r;
  try {
    r = await fetchMarketPrice({ name: q, grader: null, grade: null, language: null });
  } catch(err) {
    outEl.innerHTML = '<div style="color:var(--red)">Price lookup threw: ' + esc(err.message || String(err)) + '<br><span style="font-size:11px;color:var(--text3)">This usually means the price API is unreachable from your browser (CORS, network, or rate limit). Click 🔑 to rotate the keys.</span></div>';
    return;
  }
  if (r.maxSgd) {
    const rateNote = 'Rate: ' + (r.maxUsd ? 'US$1 = S$' : 'EUR1 = S$') + r.sgdRate.toFixed(4);
    const usdOrEur = r.maxUsd ? 'US$' + Math.round(r.maxUsd) : 'EUR' + r.maxEur.toFixed(2);
    outEl.innerHTML = `
      <div style="font-size:11px;color:var(--text3);margin-bottom:10px">📈 ${rateNote} (live)</div>
      <div style="padding:10px;background:var(--accent-soft);border:1px solid var(--accent);border-radius:6px">
        <div style="font-size:11px;color:var(--accent);text-transform:uppercase;letter-spacing:0.5px">Market Price (${esc(r.source||'')})</div>
        <div style="font-size:24px;font-weight:600;margin-top:4px">S$${r.maxSgd.toFixed(0)}</div>
        <div style="font-size:12px;color:var(--text2);margin-top:4px">${usdOrEur} · Confidence: ${r.confidence}</div>
        ${r.confidence === 'low' ? '<div style="font-size:11px;color:#f59e0b;margin-top:6px">⚠ Low confidence - card matched on name only, manually verify</div>' : ''}
      </div>`;
  } else if (/HTTP 429/.test(r.pptError || '')) {
    // PPT free tier is 100 lookups/day and resets at 00:00 UTC (08:00 SGT).
    outEl.innerHTML = '<div style="padding:10px;background:var(--amber-soft);border:1px solid var(--amber);border-radius:6px;color:var(--amber);font-size:13px">' +
      '<strong>⏳ Daily price-lookup limit reached</strong>' +
      '<div style="margin-top:6px;font-size:12px;color:var(--text2)">' +
        'PokemonPriceTracker allows 100 lookups per day on the free tier, and that is used up. It resets at 08:00 SGT (midnight UTC).' +
      '</div>' +
      '<div style="margin-top:8px;font-size:11px;color:var(--text3)">' +
        'Try again after the reset, or add the card number so TCGdex can price it for free instead.' +
      '</div>' +
      '</div>';
  } else {
    outEl.innerHTML = '<div style="padding:10px;background:var(--red-soft);border:1px solid var(--red);border-radius:6px;color:var(--red);font-size:13px">' +
      '<strong>No price found for "' + esc(q) + '"</strong>' +
      '<div style="margin-top:6px;font-size:11px;color:var(--text2)">' +
        'TCGdex: ' + esc(r.tcgdexError||'no result') + '<br>' +
        'PPT: ' + esc(r.pptError||'no result') +
      '</div>' +
      '<div style="margin-top:8px;font-size:11px;color:var(--text3)">' +
        'Try a simpler query (e.g. just the card name plus its number).' +
      '</div>' +
      '</div>';
  }
}

// =========== SGD/USD EXCHANGE RATE (dynamic, cached daily) ===========
let _sgdRate = null; // SGD per 1 USD  e.g. 1.35 means $1 USD = S$1.35

async function getSgdRate() {
  const cacheKey = 'pokeinv_fxrate';
  const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey)); } catch(e) { return null; } })();
  const today = new Date().toISOString().slice(0, 10);

  // Return today's cached rate immediately
  if (cached && cached.date === today && cached.rate) {
    _sgdRate = cached.rate;
    return cached.rate;
  }

  // Try three independent free FX sources in sequence
  const sources = [
    async () => {
      const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=SGD', { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      return d.rates?.SGD;
    },
    async () => {
      const r = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      return d.rates?.SGD;
    },
    async () => {
      const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json', { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      return d.usd?.sgd;
    }
  ];

  for (const source of sources) {
    try {
      const rate = await source();
      // Sanity band: USD/SGD has been between ~1.2 and ~1.5 for decades.
      // Use a wide guard (0.5–5) so we accept stressed-market rates instead of
      // silently falling back to a stale hardcoded 1.27.
      if (rate && typeof rate === 'number' && rate > 0.5 && rate < 5) {
        _sgdRate = rate;
        localStorage.setItem(cacheKey, JSON.stringify({ date: today, rate }));
        return rate;
      }
    } catch(e) { /* try next */ }
  }

  // All sources failed - use stale cache if available (no warning, still valid data)
  if (cached && cached.rate) {
    _sgdRate = cached.rate;
    console.warn('All FX sources failed - using stale cached rate:', cached.rate, 'from', cached.date);
    const el = document.getElementById('fx-rate-display');
    if (el) el.textContent = 'US$1 = S$' + cached.rate.toFixed(4) + ' (cached ' + cached.date + ')';
    return cached.rate;
  }

  // Absolute last resort - hardcoded
  const FALLBACK_RATE = 1.27;
  _sgdRate = FALLBACK_RATE;
  setTimeout(() => {
    const el = document.getElementById('fx-rate-display');
    if (el) { el.textContent = 'US$1 = S$' + FALLBACK_RATE + ' (hardcoded)'; el.style.color = 'var(--red)'; }
    toastError('⚠ All FX rate sources failed - using hardcoded S$' + FALLBACK_RATE + '. Update manually if needed.');
  }, 100);
  return FALLBACK_RATE;
}

// Initialise rate on page load (non-blocking)
getSgdRate().then(rate => {
  const el = document.getElementById('fx-rate-display');
  if (el) el.textContent = 'US$1 = S$' + rate.toFixed(4) + ' (live)';
});

function usdToSgd(usd) {
  return usd * (_sgdRate || 1.27);
}

// ── EUR/SGD rate (Cardmarket prices are EUR) - same daily-cache waterfall
// as getSgdRate, direct EUR base rather than a USD cross-rate so a single
// source outage on one leg can't compound into a worse error on the other.
let _eurSgdRate = null; // SGD per 1 EUR
const FALLBACK_EUR_RATE = 1.45; // approx EUR/SGD, last-resort only

async function getEurSgdRate() {
  const cacheKey = 'pokeinv_fxrate_eur';
  const cached = (() => { try { return JSON.parse(localStorage.getItem(cacheKey)); } catch(e) { return null; } })();
  const today = new Date().toISOString().slice(0, 10);

  if (cached && cached.date === today && cached.rate) {
    _eurSgdRate = cached.rate;
    return cached.rate;
  }

  const sources = [
    async () => {
      const r = await fetch('https://api.frankfurter.app/latest?from=EUR&to=SGD', { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      return d.rates?.SGD;
    },
    async () => {
      const r = await fetch('https://open.er-api.com/v6/latest/EUR', { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      return d.rates?.SGD;
    },
    async () => {
      const r = await fetch('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/eur.json', { signal: AbortSignal.timeout(4000) });
      const d = await r.json();
      return d.eur?.sgd;
    }
  ];

  for (const source of sources) {
    try {
      const rate = await source();
      // Sanity band: EUR/SGD has sat roughly 1.3-1.7 for years - wide guard
      // so a stressed-market rate is accepted rather than silently discarded.
      if (rate && typeof rate === 'number' && rate > 1.0 && rate < 2.5) {
        _eurSgdRate = rate;
        localStorage.setItem(cacheKey, JSON.stringify({ date: today, rate }));
        return rate;
      }
    } catch(e) { /* try next */ }
  }

  if (cached && cached.rate) {
    _eurSgdRate = cached.rate;
    console.warn('All EUR/SGD FX sources failed - using stale cached rate:', cached.rate, 'from', cached.date);
    return cached.rate;
  }

  _eurSgdRate = FALLBACK_EUR_RATE;
  console.warn('All EUR/SGD FX sources failed - using hardcoded fallback:', FALLBACK_EUR_RATE);
  return FALLBACK_EUR_RATE;
}

function eurToSgd(eur) {
  return eur * (_eurSgdRate || FALLBACK_EUR_RATE);
}

// =========== AI API ===========
// Anthropic's API requires x-api-key + anthropic-version. We also gate the
// call on a user-supplied key from localStorage so the public HTML doesn't
// embed a secret. If no key is set, return a friendly message instead of 401.
// NOTE: putting an Anthropic key in client HTML still exposes it to anyone who
//       can read the page. For a real deployment, proxy this through a tiny
//       backend you control instead of using the in-browser key.
// ════════════════════ AI PROVIDERS ════════════════════
// Three options, in order of cost/effort:
//   1. Google Gemini      - FREE (15 req/min, 1500 req/day on flash). Direct
//                            browser CORS. Recommended for casual use.
//   2. Groq                - FREE (30 req/min) on Llama-3 / Mixtral. Very fast
//                            inference. Limit: 14400 tokens/min.
//   3. OpenRouter         - FREE tier on `meta-llama/llama-3.1-8b-instruct:free`,
//                            etc. Pay-as-you-go for premium models.
//   4. Anthropic Claude   - paid (still supported for users with a key).
//
// The first non-empty key in the order the user prefers (chosen in settings)
// determines which provider is used. Each provider speaks a different API; this
// module abstracts them behind a single `callAI(prompt, webSearch?)` function.
const ANTHROPIC_KEY_LS  = 'pokeinv_anthropic_key';
const GEMINI_KEY_LS     = 'pokeinv_gemini_key';
const GROQ_KEY_LS       = 'pokeinv_groq_key';
const OPENROUTER_KEY_LS = 'pokeinv_openrouter_key';
const AI_PROVIDER_LS    = 'pokeinv_ai_provider'; // 'auto' | 'anthropic' | 'gemini' | 'groq' | 'openrouter'

function getAnthropicKey()   { return localStorage.getItem(ANTHROPIC_KEY_LS) || ''; }
function setAnthropicKey(k)  { localStorage.setItem(ANTHROPIC_KEY_LS, (k||'').trim()); }
function getGeminiKey()      { return localStorage.getItem(GEMINI_KEY_LS) || ''; }
function setGeminiKey(k)     { localStorage.setItem(GEMINI_KEY_LS, (k||'').trim()); }
function getGroqKey()        { return localStorage.getItem(GROQ_KEY_LS) || ''; }
function setGroqKey(k)       { localStorage.setItem(GROQ_KEY_LS, (k||'').trim()); }
function getOpenRouterKey()  { return localStorage.getItem(OPENROUTER_KEY_LS) || ''; }
function setOpenRouterKey(k) { localStorage.setItem(OPENROUTER_KEY_LS, (k||'').trim()); }
function getAIProvider()     { return localStorage.getItem(AI_PROVIDER_LS) || 'auto'; }
function setAIProvider(p)    { localStorage.setItem(AI_PROVIDER_LS, p); }

// Resolve which provider to actually use right now: explicit choice if a key
// is set; otherwise auto-pick the cheapest available.
function _resolveAIProvider(){
  const chosen = getAIProvider();
  const have = {
    anthropic:  !!getAnthropicKey(),
    gemini:     !!getGeminiKey(),
    groq:       !!getGroqKey(),
    openrouter: !!getOpenRouterKey()
  };
  if (chosen !== 'auto' && have[chosen]) return chosen;
  // Auto order: free tiers first (Gemini → Groq → OpenRouter), Anthropic last.
  if (have.gemini)     return 'gemini';
  if (have.groq)       return 'groq';
  if (have.openrouter) return 'openrouter';
  if (have.anthropic)  return 'anthropic';
  return null;
}

async function callAI(prompt, webSearch) {
  const provider = _resolveAIProvider();
  if (!provider) {
    return [
      'AI features need an API key. Three FREE options + one paid:',
      '',
      '• Google Gemini   - FREE  (recommended - 15 req/min, 1500/day)',
      '    Get key: https://aistudio.google.com/app/apikey',
      '• Groq             - FREE  (30 req/min, very fast Llama-3)',
      '    Get key: https://console.groq.com/keys',
      '• OpenRouter      - FREE tier  + paid models',
      '    Get key: https://openrouter.ai/keys',
      '• Anthropic Claude - paid  (best quality, $3/M tokens)',
      '    Get key: https://console.anthropic.com',
      '',
      'Click 🔑 in the top bar and paste any one of them. Your key is stored only in this browser.'
    ].join('\n');
  }
  try {
    if (provider === 'anthropic') {
      // 8192 output tokens: the old 1000 cap silently truncated long answers
      // ("list every card...") mid-sentence with no error - looked like a hang.
      const body = { model: 'claude-sonnet-5', max_tokens: 8192, messages: [{ role: 'user', content: prompt }] };
      if (webSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': getAnthropicKey(),
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000)
      });
      const d = await r.json();
      if (!r.ok) return 'Error (Anthropic): ' + (d.error?.message || r.status);
      let txt = d.content.map(b => b.type === 'text' ? b.text : '').join('\n').trim();
      if (txt && d.stop_reason === 'max_tokens') txt += '\n\n⚠ Answer hit the length cap - ask a narrower question (e.g. "top 20 by loss") for the rest.';
      return txt;
    }
    if (provider === 'gemini') {
      // Google rotates model names; the "-latest" alias was retired May 2025.
      // Try a chain of current free-tier models so the call survives the next
      // rotation without a code change. First success wins.
      const candidates = [
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash',
        'gemini-flash-latest',
        'gemini-pro-latest'
      ];
      const key = getGeminiKey();
      // 8192 output tokens: the old 1024 cap silently truncated long answers
      // mid-sentence (finishReason MAX_TOKENS was ignored) - looked like a hang.
      const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 8192 } };
      let lastErr = null;
      for (const model of candidates) {
        try {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
          const r = await fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90000) });
          const d = await r.json();
          if (!r.ok) {
            // 404 / not-found = try the next model. Auth/quota errors = stop.
            const msg = d.error?.message || ('HTTP ' + r.status);
            if (r.status === 404 || /not found|not supported|does not exist/i.test(msg)) {
              lastErr = msg;
              continue;
            }
            return 'Error (Gemini): ' + msg;
          }
          let txt = d.candidates?.[0]?.content?.parts?.map(p => p.text||'').join('').trim();
          if (txt && d.candidates?.[0]?.finishReason === 'MAX_TOKENS') txt += '\n\n⚠ Answer hit the length cap - ask a narrower question (e.g. "top 20 by loss") for the rest.';
          return txt || 'Empty response from Gemini.';
        } catch(e) {
          // A timeout on a working model means the request is slow, not that the
          // model is missing - don't burn 4 more slow attempts down the chain.
          if (e.name === 'TimeoutError') return 'Error (Gemini): request timed out after 90s. Try a narrower question.';
          lastErr = e.message;
        }
      }
      return 'Error (Gemini): no working model. Last error: ' + (lastErr || 'unknown') +
             '. Run "ListModels" at https://ai.google.dev/api/models to see what your key has access to.';
    }
    if (provider === 'groq') {
      // Groq is OpenAI-compatible. Llama-3.1 8B is fast and free-tier eligible.
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+getGroqKey() },
        body: JSON.stringify({ model:'llama-3.1-8b-instant', max_tokens:4096, messages:[{role:'user', content: prompt}] }),
        signal: AbortSignal.timeout(90000)
      });
      const d = await r.json();
      if (!r.ok) return 'Error (Groq): ' + (d.error?.message || r.status);
      let txt = d.choices?.[0]?.message?.content?.trim();
      if (txt && d.choices?.[0]?.finish_reason === 'length') txt += '\n\n⚠ Answer hit the length cap - ask a narrower question (e.g. "top 20 by loss") for the rest.';
      return txt || 'Empty response from Groq.';
    }
    if (provider === 'openrouter') {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method:'POST',
        headers:{
          'Content-Type':'application/json',
          'Authorization':'Bearer '+getOpenRouterKey(),
          'HTTP-Referer': location.origin,
          'X-Title': 'Kujira Collectibles'
        },
        body: JSON.stringify({
          model:'meta-llama/llama-3.1-8b-instruct:free',
          max_tokens:4096,
          messages:[{role:'user', content: prompt}]
        }),
        signal: AbortSignal.timeout(90000)
      });
      const d = await r.json();
      if (!r.ok) return 'Error (OpenRouter): ' + (d.error?.message || r.status);
      let txt = d.choices?.[0]?.message?.content?.trim();
      if (txt && d.choices?.[0]?.finish_reason === 'length') txt += '\n\n⚠ Answer hit the length cap - ask a narrower question (e.g. "top 20 by loss") for the rest.';
      return txt || 'Empty response from OpenRouter.';
    }
  } catch(e) { return 'Error: ' + e.message; }
  return 'No provider available.';
}

// =========== IMPORT ===========
async function importData() {
  const raw = document.getElementById('import-data').value.trim();
  if (!raw) { toast('No data to import'); return; }
  const type = document.getElementById('import-type').value;
  const mode = document.getElementById('import-mode').value;
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) { toast('Need header row + at least 1 data row'); return; }

  // Normalise header: lowercase, strip non-alphanumeric
  const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/[^a-z0-9]/g,''));

  // Order matters - more specific patterns first to avoid false matches
  const HM = [
    { field:'status',         match: h => h === 'status' },
    { field:'name',           match: h => ['name','product','card','pokemon'].some(v => h === v) || h.startsWith('product') },
    { field:'set',            match: h => h === 'set' || h === 'expansion' || h === 'setname' || h === 'series' },
    { field:'language',       match: h => h === 'language' || h === 'lang' },
    // listPrice (carousellPrice) = the price you list on Carousell - kept separate from costPrice (what you paid)
    { field:'listPrice',      match: h => h === 'listprice' || h === 'carousellprice' || h === 'carousell' || h === 'askingprice' || h === 'sellingprice' || h === 'salesprice' },
    { field:'datePurchased',  match: h => h === 'date' || h === 'datepurchased' || h === 'purchasedate' || h === 'dateacquired' || h === 'acquired' },
    { field:'dateListed',     match: h => h === 'datelisted' || h === 'listed' },
    { field:'_ignore',        match: h => h.startsWith('datelistedprice') || h.startsWith('datelistedand') },
    { field:'dateSold',       match: h => h === 'datesold' || h === 'sold' },
    // costPrice = what YOU paid to acquire the card (purchase price / COGS)
    { field:'costPrice',      match: h => ['costprice','cost','buyprice','paid','cogs','purchaseprice','unitprice'].some(v => h === v) },
    { field:'marketPrice',    match: h => ['marketprice','market','currentprice','value'].some(v => h === v) },
    { field:'grader',         match: h => h === 'grader' || h === 'gradingcompany' },
    { field:'grade',          match: h => h === 'grade' || h === 'score' },
    { field:'certNo',         match: h => h === 'certno' || h === 'cert' || h === 'certificate' || h === 'slabno' || h === 'certno' },
    { field:'rank',           match: h => h === 'rank' || h === 'poprank' },
    { field:'qty',            match: h => h === 'qty' || h === 'quantity' || h === 'count' || h === 'stock' },
    { field:'condition',      match: h => h === 'condition' || h === 'cond' },
    { field:'type',           match: h => h === 'type' || h === 'category' || h === 'format' },
    // Without this rule the generic "keep raw header name" fallback below
    // would store the export's lowercased "tcgdexid" header verbatim, but
    // every reader in the app expects the camelCase item.tcgdexId - a silent
    // field-name mismatch that would make a re-imported override vanish.
    { field:'tcgdexId',       match: h => h === 'tcgdexid' },
    { field:'notes',          match: h => h === 'notes' || h === 'note' || h === 'comment' || h === 'remarks' || h === 'copypasteto' || h === 'copypastetocarousell' || h === 'carousell' || h.startsWith('httpsmytaggrading') || h.startsWith('httpsmy') },
    { field:'buyer',          match: h => h === 'buyer' || h === 'customer' },
    { field:'totalCollected', match: h => ['totalcollected','total','revenue','soldprice','totalpricecollected'].some(v => h === v) },
    { field:'shippingCost',   match: h => h === 'shippingcost' || h === 'shipping' || h === 'postage' },
    { field:'profit',         match: h => h === 'profit' },
    { field:'margin',         match: h => h === 'margin' || h === 'profitmargin' },
    { field:'_ignore',        match: h => h.startsWith('column') || h === '' },
  ];

  function mapH(h) {
    for (const { field, match } of HM) {
      if (match(h)) return field;
    }
    return h; // keep raw header name as fallback
  }

  function cleanPrice(v) {
    return parseFloat(String(v||'0').replace(/[$,\s]/g,'')) || 0;
  }

  function cleanLang(v) {
    const u = (v||'').trim().toUpperCase();
    return ['EN','JP','CN','ID'].includes(u) ? u : (u || 'EN');
  }

  function detectType(name, typeVal) {
    if (typeVal) {
      const t = typeVal.toLowerCase();
      if (t.includes('slab') || t.includes('graded')) return 'slab';
      if (t.includes('sealed')) return 'sealed';
      return 'raw';
    }
    if (/\bsealed\b/i.test(name)) return 'sealed';
    return 'raw';
  }

  const fields = headers.map(mapH);
  let count = 0, skipped = 0;
  let newItems = [];
  const skippedRows = []; // collect raw content of skipped rows

  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split('\t').map(v => v.trim().replace(/^"|"$/g,''));
    const obj = { id: genId(type === 'sales' ? 'sale' : type === 'slabs' ? 'sl' : 's'), priceHistory: [] };
    fields.forEach((f, idx) => { if (f !== '_ignore' && vals[idx] !== undefined && vals[idx] !== '') obj[f] = vals[idx]; });

    if (type === 'singles' && !obj.name) { skipped++; skippedRows.push({ lineNum: i + 1, raw: lines[i] }); continue; }
    if (type === 'slabs'   && !obj.name) { skipped++; skippedRows.push({ lineNum: i + 1, raw: lines[i] }); continue; }
    if (type === 'sales'   && !obj.product && !obj.name) { skipped++; skippedRows.push({ lineNum: i + 1, raw: lines[i] }); continue; }

    if (type === 'singles') {
      obj.language  = cleanLang(obj.language);
      // costPrice = what you paid. listPrice/carousellPrice = your Carousell listing price. Keep both.
      obj.costPrice   = obj.costPrice ? cleanPrice(obj.costPrice) : '';
      obj.listPrice   = obj.listPrice ? cleanPrice(obj.listPrice) : 0;
      obj.marketPrice = obj.marketPrice ? String(cleanPrice(obj.marketPrice)) : '';
      // date fallback: accept datePurchased, dateListed, or any leftover 'date' key
      if (!obj.datePurchased) obj.datePurchased = obj.dateListed || obj.date || '';
      delete obj.dateListed; delete obj.date;
      obj.type      = detectType(obj.name, obj.type);
      // Normalise shorthand to long form so the edit-modal <select> matches on load.
      const _rawCond = (obj.condition || 'Near Mint').toString().trim();
      obj.condition = (_rawCond.toUpperCase() === 'NM') ? 'Near Mint' : _rawCond;
      obj.qty       = parseInt(obj.qty) || 1;
      obj.status    = obj.status || 'Available';
      newItems.push(obj);

    } else if (type === 'slabs') {
      obj.type = 'slab';
      // Normalise grader to uppercase so cert links work (TAG, PSA, CGC etc.)
      if (obj.grader) obj.grader = obj.grader.toString().trim().toUpperCase();
      if (obj.grade)  obj.grade  = obj.grade.toString().trim();
      // costPrice = what you paid. Keep carousellPrice (listPrice) separate.
      obj.costPrice   = obj.costPrice ? cleanPrice(obj.costPrice) : (obj.unitPrice ? cleanPrice(obj.unitPrice) : '');
      obj.listPrice   = obj.listPrice ? cleanPrice(obj.listPrice) : 0;
      obj.marketPrice = obj.marketPrice ? String(cleanPrice(obj.marketPrice)) : '';
      delete obj.unitPrice;
      // date fallback: accept dateListed or datePurchased (generic 'Date' column)
      if (!obj.dateListed) obj.dateListed = obj.datePurchased || obj.date || '';
      delete obj.datePurchased; delete obj.date;
      obj.status    = obj.status || 'Available';
      newItems.push(obj);

    } else {
      if (obj.name && !obj.product) obj.product = obj.name;
      obj.costPrice      = cleanPrice(obj.costPrice);
      obj.totalCollected = cleanPrice(obj.totalCollected);
      obj.shippingCost   = cleanPrice(obj.shippingCost);
      if (!obj.profit) obj.profit = obj.totalCollected - obj.costPrice - obj.shippingCost;
      else obj.profit = cleanPrice(obj.profit);
      // Guard against NaN before computing margin - totalCollected or profit
      // may be NaN if the source row had empty/invalid values.
      if (!obj.margin && obj.totalCollected > 0 && !isNaN(obj.profit))
        obj.margin = ((obj.profit / obj.totalCollected) * 100).toFixed(0) + '%';
      newItems.push(obj);
    }
    count++;
  }

  // ── Duplicate detection (append mode only) ───────────────────
  let dupCount = 0;
  if (mode === 'append') {
    const existing = type === 'sales' ? DB.sales : DB[type];
    newItems = newItems.filter(item => {
      if (type === 'slabs' && item.certNo) {
        // Slabs: cert number is globally unique - skip exact cert matches only
        const isDup = existing.some(e => e.certNo && e.certNo.trim().toLowerCase() === item.certNo.trim().toLowerCase());
        if (isDup) { dupCount++; return false; }
      }
      // Singles and sales: allow duplicates (same card can appear multiple times)
      return true;
    });
    // No confirm dialog - just proceed silently
  }

  if (!newItems.length) { toast('Nothing to import - all rows were skipped or duplicates'); return; }

  // ── Preview / confirm step (both modes) ──────────────────────
  // Show up to 10 parsed rows plus the total count. Nothing is written until
  // the user confirms. Cancel writes nothing.
  const _previewCols = (type === 'sales')
    ? [['product','Name'], ['buyer','Buyer'], ['totalCollected','Total'], ['profit','Profit']]
    : [['name','Name'], ['set','Set'], ['costPrice','Cost'], ['marketPrice','Market']];
  const _previewRows = newItems.slice(0, 10).map(it => {
    const cells = _previewCols.map(([k]) => '<td style="padding:4px 8px;border-bottom:1px solid var(--border);white-space:nowrap;max-width:140px;overflow:hidden;text-overflow:ellipsis">' + esc(it[k] != null && it[k] !== '' ? it[k] : '-') + '</td>').join('');
    return '<tr>' + cells + '</tr>';
  }).join('');
  const _previewHead = _previewCols.map(([,label]) => '<th style="padding:4px 8px;text-align:left;color:var(--text3);font-size:11px;text-transform:uppercase;letter-spacing:0.4px;border-bottom:1px solid var(--border2)">' + label + '</th>').join('');
  const existingArrForPreview = (type === 'sales' ? DB.sales : DB[type]);
  const _modeNote = (mode === 'replace' && existingArrForPreview.length)
    ? '<div style="margin-top:10px;font-size:12px;color:var(--amber)">⚠ Replace mode: this removes all ' + existingArrForPreview.length + ' existing ' + esc(type) + ' record' + (existingArrForPreview.length===1?'':'s') + ' first (cloud rows included). Undo with Ctrl+Z.</div>'
    : '<div style="margin-top:10px;font-size:12px;color:var(--text3)">Append mode: rows are added to your existing ' + esc(type) + '.</div>';
  const _previewHtml =
    '<div style="font-size:13px;margin-bottom:10px">Importing <strong>' + newItems.length + '</strong> ' + esc(type) + ' row' + (newItems.length===1?'':'s') +
    (dupCount ? ' <span style="color:var(--text3)">(' + dupCount + ' duplicate' + (dupCount===1?'':'s') + ' skipped)</span>' : '') + '</div>' +
    '<div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius)"><table style="width:100%;min-width:0;border-collapse:collapse;font-size:12px"><thead><tr>' + _previewHead + '</tr></thead><tbody>' + _previewRows + '</tbody></table></div>' +
    (newItems.length > 10 ? '<div style="margin-top:6px;font-size:11px;color:var(--text3)">Showing first 10 of ' + newItems.length + ' rows.</div>' : '') +
    _modeNote;
  if (!await kjrConfirm(_previewHtml, {ok:'Import ' + newItems.length + ' row' + (newItems.length===1?'':'s'), danger: (mode === 'replace' && existingArrForPreview.length > 0)})) {
    toast('Import cancelled');
    return;
  }

  const _importBtn = document.getElementById('import-btn');
  const _importBtnLabel = _importBtn ? _importBtn.innerHTML : '';
  if (_importBtn) { _importBtn.disabled = true; _importBtn.style.opacity = '0.7'; _importBtn.style.cursor = 'wait'; _importBtn.innerHTML = '<span class="kjr-btn-spinner"></span> Importing…'; }
  try {

  if (mode === 'replace') {
    const existingArr = (type === 'sales' ? DB.sales : DB[type]);
    snapshotForUndo();
    // Capture the old IDs so we can DELETE them from Supabase - otherwise
    // "Replace" leaves orphan rows in the cloud and on the next page load
    // those orphans merge back in, silently un-doing the replacement.
    const sbTable = (typeof _tblName === 'function') ? _tblName(type === 'sales' ? 'sales' : type) : (type === 'sales' ? 'sales' : type);
    const oldIds = existingArr.map(r => r.id);
    // Await all deletes before overwriting local state. If any fail, warn the
    // user - orphaned cloud rows would otherwise merge back on next load.
    if (typeof sbDelete === 'function' && oldIds.length) {
      // sbDelete returns false on failure and auto-queues the ID for retry on
      // next sync, so orphans cannot linger in Supabase across sessions.
      const delResults = await Promise.all(oldIds.map(id => sbDelete(sbTable, id)));
      const failCount = delResults.filter(r => r === false).length;
      if (failCount > 0) toast('⚠ ' + failCount + ' old record(s) queued for retry - they will be removed once cloud connection recovers.', 5000, true);
    }
    DB[type === 'sales' ? 'sales' : type] = newItems;
  }
  else {
    snapshotForUndo();
    const arr = type === 'sales' ? DB.sales : DB[type];
    newItems.forEach(item => arr.push(item));
  }

  saveData();
  if (type === 'singles') renderSingles();
  if (type === 'slabs')   renderSlabs();
  if (type === 'sales')   renderSales();
  const el = document.getElementById('import-result');
  el.style.display = 'block';
  el.style.color = 'var(--green)';
  let resultHtml = '<span style="color:var(--green)">✓ Imported ' + count + ' records' + (skipped ? ' · <span style="color:var(--amber)">' + skipped + ' skipped</span>' : '') + '</span>';
  if (skippedRows.length > 0) {
    const rowsHtml = skippedRows.map(r =>
      '<div class="skipped-row-item"><span class="skipped-row-num">Row ' + r.lineNum + '</span>' +
      r.raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>'
    ).join('');
    resultHtml += '<div class="skipped-box">' +
      '<button class="skipped-toggle" onclick="this.nextElementSibling.classList.toggle(\'open\');this.textContent=this.nextElementSibling.classList.contains(\'open\')?\'▼ Hide ' + skipped + ' skipped rows\':\'▶ Show ' + skipped + ' skipped rows - click to review\'">▶ Show ' + skipped + ' skipped rows - click to review</button>' +
      '<div class="skipped-rows">' + rowsHtml + '</div>' +
      '</div>';
  }
  el.innerHTML = resultHtml + (dupCount > 0 ? ' · <span style="color:var(--text3)">' + dupCount + ' duplicates skipped</span>' : '');
  toast('Imported ' + count + ' records!');
  // Mark imported items dirty; let the debounced flush push only those rows.
  // (Previously this called saveAllToSupabase() which re-uploaded the entire DB.)
  newItems.forEach(item => markDirty(type === 'sales' ? 'sales' : type, item.id));
  // For replace-mode we already wiped the table locally, but Supabase still has
  // the old rows - kick off a one-shot full sync so deletes propagate. Awaited
  // so a failed sync is surfaced (was fire-and-forget).
  if (mode === 'replace') {
    try {
      await saveAllToSupabase();
    } catch(e) {
      console.error('saveAllToSupabase failed after replace-mode import:', e);
      if (typeof toast === 'function') toast('⚠ Cloud sync failed - local data saved. Refresh to retry.');
    }
  } else {
    _flushDirtyToSupabase();
  }
  clLog('import', type, count + ' records imported' + (skipped ? ', ' + skipped + ' skipped' : ''));
  } finally {
    if (_importBtn) { _importBtn.disabled = false; _importBtn.style.opacity = ''; _importBtn.style.cursor = ''; _importBtn.innerHTML = _importBtnLabel; }
  }
}

async function importWithAI() {
  const raw = document.getElementById('import-data').value.trim();
  const type = document.getElementById('import-type').value;
  if (!raw) { toast('Paste data first'); return; }
  const el = document.getElementById('import-result');
  el.style.display = 'block';
  el.style.color = 'var(--text2)';
  el.textContent = 'AI is mapping your columns...';
  // Field hints by type. snake_case types route through importNewType after
  // serialisation so the AI output must match the same field names that path
  // expects (e.g. 'priceUsd' for eBay, 'totalPrice' for sealed products).
  const FIELDS_BY_TYPE = {
    singles:        'name,set,language,type(raw/slab/sealed),condition,qty,carousellPrice,costPrice,marketPrice,status,notes',
    slabs:          'name,grader,grade,certNo,rank,carousellPrice,costPrice,marketPrice,dateListed,status,notes',
    sales:          'dateSold,product,buyer,costPrice,totalCollected,shippingCost,profit,margin',
    etbs:           'date,product,status,unitPrice,qty,totalPrice,marketPrice,notes',
    booster_boxes:  'date,product,status,unitPrice,qty,totalPrice,marketPrice,notes',
    booster_packs:  'date,product,status,unitPrice,qty,totalPrice,marketPrice,notes',
    ebay_purchases: 'date,product,status,tracking,declared,priceUsd,freightSgd,totalSgd,targetTable',
  };
  const fields = FIELDS_BY_TYPE[type] || FIELDS_BY_TYPE.singles;
  // 3,000-char cap removed - send the whole paste. callAI handles truncation
  // server-side if it needs to.
  const result = await callAI('Map this tabular data to fields: ' + fields + '.\nReturn ONLY a JSON array. Each row = one object. No markdown, no extra text.\n\nData:\n' + raw, false);
  let items;
  try {
    items = JSON.parse(result.replace(/```json|```/g,'').trim());
    if (!Array.isArray(items)) throw new Error('AI did not return an array');
  } catch(e) {
    el.style.color = 'var(--red)';
    el.textContent = 'AI could not parse. Try standard import.';
    return;
  }
  if (!items.length) {
    el.style.color = 'var(--amber)';
    el.textContent = 'AI returned 0 rows.';
    return;
  }
  // Re-serialise as TSV and route through the regular import pipeline so
  // markDirty / clLog / normalization / snake_case mapping / numeric cleaning
  // / Replace-mode cloud cleanup are all inherited from one code path.
  const headers = Object.keys(items.reduce((acc, it) => { Object.keys(it||{}).forEach(k => acc[k]=1); return acc; }, {}));
  const tsv = [headers.join('\t'), ...items.map(it => headers.map(h => (it[h]==null?'':String(it[h])).replace(/[\t\n]/g,' ')).join('\t'))].join('\n');
  const ta = document.getElementById('import-data');
  const originalPaste = ta.value;
  ta.value = tsv;
  try {
    if (typeof window.importData !== 'function') throw new Error('importData not available');
    await window.importData();
    el.style.color = 'var(--green)';
    el.textContent = '✓ AI mapped ' + items.length + ' rows and routed through the standard importer.';
  } catch(e) {
    el.style.color = 'var(--red)';
    el.textContent = 'AI import failed during write: ' + (e && e.message ? e.message : 'unknown error');
  } finally {
    ta.value = originalPaste;
  }
}

// =========== EXPORT ===========
function exportCSV(type) {
  let data, filename, fields;
  if (type === 'singles') {
    data = DB.singles; filename = 'singles.csv';
    // Include datePurchased / priceAlert / ebayUrl / carousellUrl so a CSV
    // round-trip preserves alerts and listing links. tcgdexId round-trips
    // the resolved/overridden card id so a re-import skips the resolve step.
    fields = ['id','name','set','language','type','condition','qty','listPrice','costPrice','marketPrice','status','datePurchased','priceAlert','ebayUrl','carousellUrl','tcgdexId','notes'];
  } else if (type === 'slabs') {
    data = DB.slabs; filename = 'slabs.csv';
    fields = ['id','name','grader','grade','certNo','rank','listPrice','costPrice','marketPrice','dateListed','status','priceAlert','ebayUrl','carousellUrl','tcgdexId','notes'];
  } else {
    data = DB.sales; filename = 'sales.csv';
    // Keep inventoryId/inventoryTable so the "↗ source" link survives an
    // export → import round-trip.
    fields = ['id','dateSold','product','buyer','costPrice','totalCollected','shippingCost','profit','margin','inventoryId','inventoryTable'];
  }
  const rows = [fields.join(',')];
  // ?? not || - a genuine 0 (e.g. costPrice/shippingCost) or false is a real
  // value and must round-trip, only null/undefined should export as empty.
  data.forEach(item => rows.push(fields.map(f => JSON.stringify(item[f] ?? '')).join(',')));
  dl(filename, rows.join('\n'), 'text/csv');
}

function exportAllJSON() {
  // Full backup - include every collection tab the app tracks. Previously
  // skipped etbs / boosterBoxes / boosterPacks / ebayPurchases, which made
  // "Full Backup" silently incomplete.
  dl('pokeinventory_backup.json', JSON.stringify({
    singles: DB.singles,
    slabs: DB.slabs,
    sales: DB.sales,
    etbs: DB.etbs || [],
    boosterBoxes: DB.boosterBoxes || [],
    boosterPacks: DB.boosterPacks || [],
    ebayPurchases: DB.ebayPurchases || [],
    _exportedAt: new Date().toISOString(),
    _schemaVersion: 2
  }, null, 2), 'application/json');
  toast('Backup exported!');
}

function dl(name, content, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], {type}));
  a.download = name; a.click();
  toast('Downloaded ' + name);
}

// =========== THEME ===========
(function initTheme() {
  const saved = localStorage.getItem('pokeinv_theme');
  applyTheme(saved === 'light' ? 'light' : 'dark');
})();

function applyTheme(mode) {
  const isLight = mode === 'light';
  if (isLight) {
    document.documentElement.classList.add('light');
    document.getElementById('theme-icon-dark').style.display = 'none';
    document.getElementById('theme-icon-light').style.display = '';
  } else {
    document.documentElement.classList.remove('light');
    document.getElementById('theme-icon-dark').style.display = '';
    document.getElementById('theme-icon-light').style.display = 'none';
  }
  // Keep the browser chrome (status bar / task switcher) in step with the
  // active theme. Light hex is the actual html.light --bg token (v3.0
  // palette, #F6F4EE); dark matches the static <meta> default (#0f0f0f).
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.content = isLight ? '#F6F4EE' : '#0f0f0f';
}

function toggleTheme() {
  const isLight = document.documentElement.classList.contains('light');
  const next = isLight ? 'dark' : 'light';
  localStorage.setItem('pokeinv_theme', next);
  applyTheme(next);
}

// =========== RESET VIEW ===========
function resetCurrentView() {
  // figure out which page is active
  const active = document.querySelector('.page.active');
  if (!active) return;
  const id = active.id; // e.g. 'page-inventory'

  // clearAllFilters already covers every column filter, the search box and
  // the status select for tables in _FILTER_INPUTS (singles/slabs/sales) and
  // re-renders - previously this duplicated a partial, easy-to-miss subset
  // of those fields by hand (e.g. cost/market/list/date filters weren't
  // cleared at all on Singles/Slabs).
  if (id === 'page-inventory') {
    sortState.singles = { col: null, dir: 1 };
    clearAllFilters('singles');
  } else if (id === 'page-slabs') {
    sortState.slabs = { col: null, dir: 1 };
    clearAllFilters('slabs');
  } else if (id === 'page-sales') {
    sortState.sales = { col: null, dir: 1 };
    clearAllFilters('sales');
  } else if (id === 'page-dashboard') {
    renderDashboard();
  }
  toast('View reset');
}

// =========== INIT ===========
// One-time migration: clear all market prices.
// Defensive variant: refuses to run against a populated DB unless the flag
// has been explicitly bumped. This prevents an accidental flag-rename or a
// localStorage wipe in private mode from silently zeroing every market price.
(function clearMarketPrices() {
  const flag = 'pokeinv_mkt_cleared_v1';
  if (localStorage.getItem(flag)) return;
  // If DB has rows already, skip the migration - it's only meant to fire on
  // the very first load before any inventory exists.
  if ((DB.singles||[]).length || (DB.slabs||[]).length) {
    localStorage.setItem(flag, '1');
    return;
  }
  localStorage.setItem(flag, '1');
})();

// One-time cleanup: the orphaned market_prices cache (window._priceLookup,
// persisted at 'kjr_price_cache') has been removed - it read a Supabase
// table that was never written by any code, so it only ever served 10 stale
// hand-seeded rows. Drop any local copy so it can't linger or confuse a
// future debugging session.
try { localStorage.removeItem('kjr_price_cache'); } catch(e){}

// Slabs column-order reset - REMOVED. This was a one-time migration to
// put "grade" before "name" after a schema change, but it was never gated
// by a flag, so it ran on every page load and silently wiped any column
// reordering the user did on the Slabs tab. The user's drag-to-reorder
// preferences are now respected across refreshes.

// =========== CUSTOM CHART BUILDER (multi-axis) ===========
// `tables` is permissive: most inventory fields are available across every
// inventory source so the user can switch between Singles/Slabs/Sealed
// without losing pills. Sealed sources use `totalPrice` instead of
// `costPrice` - the costPrice getter falls back to totalPrice for those rows.
const _INV_SOURCES    = ['singles','slabs','etbs','boosterBoxes','boosterPacks','all_inventory','everything'];
const _SEALED_SOURCES = ['etbs','boosterBoxes','boosterPacks','all_inventory','everything'];
const CB_FIELDS = {
  // Dimensions - group by
  pokeName:     { label: 'Pokémon Name',      icon: '🃏', type: 'dim',  tables: [..._INV_SOURCES, 'sales','ebay'], get: i => ((i.name||i.product||'?').toString()).split(' ')[0] },
  fullName:     { label: 'Full Card Name',     icon: '🃏', type: 'dim',  tables: [..._INV_SOURCES, 'sales','ebay'], get: i => i.name || i.product || '?' },
  language:     { label: 'Language',           icon: '🌐', type: 'dim',  tables: _INV_SOURCES,                       get: i => i.language||'?' },
  cardType:     { label: 'Card Type',          icon: '📦', type: 'dim',  tables: ['singles','all_inventory','everything'], get: i => i.type||'raw' },
  condition:    { label: 'Condition',          icon: '⭐', type: 'dim',  tables: ['singles','etbs','all_inventory','everything'], get: i => i.condition||'?' },
  set:          { label: 'Set',                icon: '📋', type: 'dim',  tables: ['singles','slabs','all_inventory','everything'], get: i => i.set||'?' },
  graderGrade:  { label: 'Grader + Grade',      icon: '🏷', type: 'dim',  tables: ['slabs','all_inventory','everything'], get: i => ((i.grader||'') + ' ' + (i.grade||'')).trim() || '?' },
  grade:        { label: 'Grade',              icon: '🔢', type: 'dim',  tables: ['slabs','all_inventory','everything'], get: i => i.grade||'?' },
  status:       { label: 'Status',             icon: '📌', type: 'dim',  tables: [..._INV_SOURCES, 'sales','ebay'],  get: i => i.status||'Available' },
  monthBought:  { label: 'Month Acquired',     icon: '📅', type: 'dim',  tables: [..._INV_SOURCES, 'ebay'],          get: i => normaliseToMonthYear(i.datePurchased || i.dateListed || i.date) || '?' },
  dateSold:     { label: 'Month Sold',         icon: '📅', type: 'dim',  tables: ['sales','everything'],             get: s => normaliseToMonthYear(s.dateSold)||'?' },
  buyer:        { label: 'Buyer',              icon: '👤', type: 'dim',  tables: ['sales','everything'],             get: s => s.buyer||'?' },
  saleProduct:  { label: 'Product (Pokémon)',  icon: '🃏', type: 'dim',  tables: ['sales','everything'],             get: s => (s.product||'?').split(' ')[0] },
  // Sealed-specific dimensions
  sealedProduct: { label: 'Product',           icon: '📦', type: 'dim',  tables: _SEALED_SOURCES,                    get: i => i.product || '?' },
  // eBay-specific dimensions
  ebayStatus:    { label: 'eBay Status',       icon: '📦', type: 'dim',  tables: ['ebay','everything'],              get: r => r.status||'?' },
  ebayDeclared:  { label: 'Declared?',         icon: '✅', type: 'dim',  tables: ['ebay','everything'],              get: r => r.declared||'?' },
  ebayTarget:    { label: 'Target Inventory',  icon: '🎯', type: 'dim',  tables: ['ebay','everything'],              get: r => r.targetTable||'?' },

  // Measures - `agg` defaults to 'sum'; use 'avg' for ratios. `weighted` ×
  // qty for singles / packs / boxes so multi-qty rows contribute their full
  // value to grouped totals.
  // `unit` controls axis/tooltip/summary formatting:
  //   'sgd'   → "S$1,234"     (default for cost / market / P&L)
  //   'usd'   → "US$1,234"
  //   'pct'   → "25%"
  //   'count' → "5"           (no currency prefix)
  // costPrice falls back to totalPrice so sealed sources work without their
  // own bespoke measure.
  costPrice:    { label: 'Cost Price (S$)',    icon: '💵', type: 'meas', agg: 'sum', weighted: true, unit:'sgd',   tables: _INV_SOURCES,
                  get: i => parseFloat(i.costPrice ?? i.totalPrice)||0 },
  marketPrice:  { label: 'Market Price (S$)',  icon: '📈', type: 'meas', agg: 'sum', weighted: true, unit:'sgd',   tables: _INV_SOURCES,
                  get: i => parseFloat(i.marketPrice ?? i.totalPrice)||0 },
  pnl:          { label: 'Unrealised P&L',     icon: '💹', type: 'meas', agg: 'sum', weighted: true, unit:'sgd',   tables: _INV_SOURCES,
                  get: i => (parseFloat(i.marketPrice ?? i.totalPrice)||0) - (parseFloat(i.costPrice ?? i.totalPrice)||0) },
  itemCount:    { label: 'Item Count',         icon: '🔢', type: 'meas', agg: 'sum', weighted: true, unit:'count', tables: _INV_SOURCES,
                  get: () => 1 },
  revenue:      { label: 'Revenue (S$)',       icon: '💰', type: 'meas', agg: 'sum', unit:'sgd',   tables: ['sales','everything'],  get: s => parseFloat(s.totalCollected)||0 },
  profit:       { label: 'Profit (S$)',        icon: '📊', type: 'meas', agg: 'sum', unit:'sgd',   tables: ['sales','everything'],  get: s => parseFloat(s.profit)||0 },
  marginPct:    { label: 'Margin % (avg)',     icon: '📉', type: 'meas', agg: 'avg', unit:'pct',   tables: ['sales','everything'],  get: s => parseFloat(s.margin)||0 },
  ebayUsd:      { label: 'USD Spent',          icon: '💵', type: 'meas', agg: 'sum', unit:'usd',   tables: ['ebay','everything'],  get: r => parseFloat(r.priceUsd)||0 },
  ebayFreight:  { label: 'Freight (SGD)',      icon: '🚚', type: 'meas', agg: 'sum', unit:'sgd',   tables: ['ebay','everything'],  get: r => parseFloat(r.freightSgd)||0 },
  ebayTotalSgd: { label: 'Total SGD',          icon: '💰', type: 'meas', agg: 'sum', unit:'sgd',   tables: ['ebay','everything'],  get: r => parseFloat(r.totalSgd)||0 },
  costSold:     { label: 'Cost of Sale (S$)',  icon: '💵', type: 'meas', agg: 'sum', unit:'sgd',   tables: ['sales'],                          get: s => parseFloat(s.costPrice)||0 },
  saleCount:    { label: 'Sale Count',         icon: '🔢', type: 'meas', agg: 'sum', unit:'count', tables: ['sales'],                          get: () => 1 },
  fees:         { label: 'Fees (S$)',          icon: '💸', type: 'meas', agg: 'sum', unit:'sgd',   tables: ['sales','everything'],             get: s => parseFloat(s.fees)||0 },
  daysHeld:     { label: 'Days Held (avg)',    icon: '📆', type: 'meas', agg: 'avg', unit:'count', tables: ['sales','everything'],             get: s => parseFloat(s.daysHeld)||0 },
  channel:      { label: 'Channel',            icon: '🏪', type: 'dim',  tables: ['sales','everything'],                                       get: s => s.channel || 'Carousell' },
};

// Format a measure value according to its unit. Centralised so axis labels,
// tooltips, and summary stats all stay consistent.
function _cbFmtMeasure(val, fieldKey) {
  const f = CB_FIELDS[fieldKey];
  const n = (typeof val === 'number' && isFinite(val)) ? val : 0;
  const u = (f && f.unit) || 'sgd';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  const fmt0 = (v) => v.toLocaleString('en-SG', { maximumFractionDigits: 0 });
  const fmt1 = (v) => v.toLocaleString('en-SG', { maximumFractionDigits: 1 });
  if (u === 'pct')   return sign + fmt1(abs) + '%';
  if (u === 'count') return sign + fmt0(abs);
  if (u === 'usd')   return sign + 'US$' + fmt0(abs);
  return sign + 'S$' + fmt0(abs);
}
// Short axis-tick formatter - same units but uses k/M suffix above 1000 so the
// y-axis stays legible on busy charts.
function _cbFmtAxis(val, fieldKey) {
  const f = CB_FIELDS[fieldKey];
  const u = (f && f.unit) || 'sgd';
  const n = (typeof val === 'number' && isFinite(val)) ? val : 0;
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  let body;
  if (abs >= 1_000_000) body = (abs/1_000_000).toFixed(1).replace(/\.0$/,'') + 'M';
  else if (abs >= 1000) body = (abs/1000).toFixed(1).replace(/\.0$/,'') + 'k';
  else                  body = (u === 'pct' ? abs.toFixed(abs<10?1:0) : Math.round(abs).toString());
  if (u === 'pct')   return sign + body + '%';
  if (u === 'count') return sign + body;
  if (u === 'usd')   return sign + 'US$' + body;
  return sign + 'S$' + body;
}

// State: arrays of field keys (multi-axis). Persist across reloads so the
// builder picks up where the user left off (without persistence the builder
// silently resets after a refresh, which was confusing during long analysis
// sessions).
const CB_STATE_KEY = 'pokeinv_cb_state_v1';
function _loadCbState() {
  try {
    const raw = JSON.parse(localStorage.getItem(CB_STATE_KEY) || 'null');
    if (raw && Array.isArray(raw.x) && Array.isArray(raw.y)) {
      return { x: raw.x.filter(k => CB_FIELDS[k]), y: raw.y.filter(k => CB_FIELDS[k]), customItems: null };
    }
  } catch(e) {}
  return { x: [], y: [], customItems: null };
}
function _saveCbState() {
  try { localStorage.setItem(CB_STATE_KEY, JSON.stringify(cbState)); } catch(e) {}
}
let cbState = _loadCbState();
let _cbChart = null;
const CB_PALETTE = ['#a78bfa','#2dd4bf','#f59e0b','#f87171','#60a5fa','#34d399','#fb923c','#c084fc','#38bdf8','#4ade80','#facc15','#e879f9'];

function cbFilterPalette(q) {
  document.querySelectorAll('#cb-field-palette .cb-field-pill').forEach(el => {
    el.style.display = q && !el.dataset.label.toLowerCase().includes(q.toLowerCase()) ? 'none' : '';
  });
}

function cbSourceChanged() {
  cbState.customItems = null;
  const pickerWrap = document.getElementById('cb-picker-wrap');
  if (pickerWrap) pickerWrap.style.display = 'none';
  renderCbChips('x'); renderCbChips('y');
  initCustomChartBuilder();
  renderCustomChart();
}

// ── Pill order persistence ──
const CB_ORDER_KEY = 'pokeinv_cb_pill_order';

function savePillOrder(src, type, order) {
  try {
    const all = JSON.parse(localStorage.getItem(CB_ORDER_KEY) || '{}');
    if (!all[src]) all[src] = {};
    all[src][type] = order;
    localStorage.setItem(CB_ORDER_KEY, JSON.stringify(all));
  } catch(e) {}
}

function loadPillOrder(src, type, defaultKeys) {
  try {
    const all = JSON.parse(localStorage.getItem(CB_ORDER_KEY) || '{}');
    const saved = all[src]?.[type];
    if (!saved) return defaultKeys;
    // Merge: saved order first (for keys still valid), then any new keys appended
    const validSaved = saved.filter(k => defaultKeys.includes(k));
    const newKeys    = defaultKeys.filter(k => !validSaved.includes(k));
    return [...validSaved, ...newKeys];
  } catch(e) { return defaultKeys; }
}

const CB_PINNED_FIELDS_KEY = 'pokeinv_cb_pinned_fields_v1';

function _cbGetPinnedFields() {
  try {
    const raw = JSON.parse(localStorage.getItem(CB_PINNED_FIELDS_KEY) || 'null');
    if (raw && Array.isArray(raw.dim) && Array.isArray(raw.meas)) return raw;
  } catch(e) {}
  return {
    dim:  ['pokeName','fullName','language','set','condition'],
    meas: ['costPrice','marketPrice','pnl','itemCount','profit']
  };
}

function _cbSavePinnedFields(pinned) {
  try { localStorage.setItem(CB_PINNED_FIELDS_KEY, JSON.stringify(pinned)); } catch(e) {}
}

function _cbOpenFieldPicker(type) {
  const panel = document.getElementById('cb-field-cfg-' + type);
  if (!panel) return;
  if (panel.style.display !== 'none') { panel.style.display = 'none'; return; }

  const pinned = _cbGetPinnedFields();
  const src = document.getElementById('cb-source')?.value || 'all_inventory';
  const allFields = Object.entries(CB_FIELDS)
    .filter(([,f]) => f.type === type)
    .filter(([,f]) => Array.isArray(f.tables) && f.tables.includes(src));

  const currentSet = new Set(pinned[type]);
  const checkedCount = allFields.filter(([k]) => currentSet.has(k)).length;
  panel.innerHTML = allFields.map(([k, f]) => {
    const chk = currentSet.has(k);
    const dis = (!chk && checkedCount >= 5) ? ' disabled' : '';
    return `<label style="display:flex;align-items:center;gap:5px;font-size:11px;padding:3px 4px;cursor:pointer">` +
      `<input type="checkbox" value="${k}"${chk ? ' checked' : ''}${dis} onchange="_cbPickerEnforce('${type}')"> ` +
      `${f.icon} ${f.label}</label>`;
  }).join('') +
  `<div style="font-size:10px;color:var(--text3);margin-top:4px">Pick up to 5</div>` +
  `<button class="btn btn-primary btn-sm" onclick="_cbApplyFieldPicker('${type}')" style="font-size:10px;margin-top:6px;width:100%">Apply</button>`;
  panel.style.display = 'block';
}

function _cbPickerEnforce(type) {
  const panel = document.getElementById('cb-field-cfg-' + type);
  if (!panel) return;
  const checked = [...panel.querySelectorAll('input[type=checkbox]:checked')];
  if (checked.length >= 5) {
    panel.querySelectorAll('input[type=checkbox]:not(:checked)').forEach(el => { el.disabled = true; });
  } else {
    panel.querySelectorAll('input[type=checkbox]').forEach(el => { if (!el.checked) el.disabled = false; });
  }
}

function _cbApplyFieldPicker(type) {
  const panel = document.getElementById('cb-field-cfg-' + type);
  if (!panel) return;
  const selected = [...panel.querySelectorAll('input[type=checkbox]:checked')].map(el => el.value);
  if (!selected.length) { toast('Select at least one field'); return; }
  const pinned = _cbGetPinnedFields();
  pinned[type] = selected;
  _cbSavePinnedFields(pinned);
  panel.style.display = 'none';
  initCustomChartBuilder();
}

function initCustomChartBuilder() {
  const palette = document.getElementById('cb-field-palette');
  if (!palette) return;
  const src = document.getElementById('cb-source')?.value || 'all_inventory';
  palette.innerHTML = '';

  // Show a field iff its `tables` list contains the current source. The
  // 'all_inventory' source acts as the umbrella for every inventory table
  // (singles + slabs + etbs + boosterBoxes + boosterPacks). Previously this
  // hard-coded ['singles','slabs','all_inventory'] regardless of `src`, which
  // meant choosing eBay / ETBs / Booster Boxes still showed the singles/slabs
  // field palette and hid the source-specific fields (USD Spent, eBay Status,
  // Product etc.) - the chart-builder was unusable on those sources.
  function relevant([,f]) {
    return Array.isArray(f.tables) && f.tables.includes(src);
  }

  const allDims  = Object.entries(CB_FIELDS).filter(([,f]) => f.type === 'dim').filter(relevant);
  const allMeass = Object.entries(CB_FIELDS).filter(([,f]) => f.type === 'meas').filter(relevant);

  // Apply saved order
  const dimKeys  = loadPillOrder(src, 'dim',  allDims.map(([k]) => k));
  const measKeys = loadPillOrder(src, 'meas', allMeass.map(([k]) => k));

  function sortByOrder(entries, order) {
    return order.map(k => entries.find(([ek]) => ek === k)).filter(Boolean);
  }

  const pinnedFields = _cbGetPinnedFields();
  // Filter to pinned fields only; if none match for this source, fall back to first 5
  function applyPinned(entries, pinnedKeys) {
    const pinSet = new Set(pinnedKeys);
    const filtered = entries.filter(([k]) => pinSet.has(k));
    return filtered.length ? filtered : entries.slice(0, 5);
  }

  const dims  = applyPinned(sortByOrder(allDims,  dimKeys),  pinnedFields.dim);
  const meass = applyPinned(sortByOrder(allMeass, measKeys), pinnedFields.meas);

  [['dim', 'Dimensions (Group by)', dims], ['meas', 'Measures (Values)', meass]].forEach(([type, heading, fields]) => {
    if (!fields.length) return;

    const hd = document.createElement('div');
    hd.style.cssText = 'font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-top:10px;margin-bottom:4px;display:flex;align-items:center;gap:6px';
    hd.innerHTML = heading;
    palette.appendChild(hd);

    // Droppable section container
    const section = document.createElement('div');
    section.dataset.section = type;
    section.dataset.src = src;
    section.style.cssText = 'display:flex;flex-direction:column;gap:5px';
    section.addEventListener('dragover', e => {
      e.preventDefault();
      const dragging = palette.querySelector('.cb-pill-dragging');
      if (!dragging || dragging.dataset.section !== type) return;
      const target = e.target.closest('.cb-field-pill[data-section]');
      if (target && target !== dragging && target.dataset.section === type) {
        const rect = target.getBoundingClientRect();
        const after = e.clientY > rect.top + rect.height / 2;
        if (after) target.after(dragging);
        else target.before(dragging);
      }
    });
    section.addEventListener('dragend', () => {
      palette.querySelectorAll('.cb-field-pill[data-section="' + type + '"]').forEach(el => el.classList.remove('cb-pill-dragging'));
      // Save new order
      const newOrder = [...section.querySelectorAll('.cb-field-pill[data-section]')].map(el => el.dataset.field);
      savePillOrder(src, type, newOrder);
    });

    fields.forEach(([key, f]) => {
      const pill = document.createElement('div');
      pill.className = 'cb-field-pill';
      pill.draggable = true;
      pill.dataset.field = key;
      pill.dataset.label = f.label;
      pill.dataset.section = type; // marks it as a reorder drag, not a drop-to-axis drag
      pill.innerHTML = `<span class="pill-icon" style="cursor:grab;opacity:0.5;font-size:11px;margin-right:2px">⠿</span><span class="pill-icon">${f.icon}</span><span>${f.label}</span><span class="pill-type">${type === 'dim' ? 'Group' : 'Value'}</span>`;

      let _dragToAxis = false;
      pill.addEventListener('dragstart', e => {
        // Determine intent: if dragging out of section container → axis drop
        // We set both data keys; the section dragover only reorders same-type
        e.dataTransfer.setData('text/plain', key);          // for axis drop zones
        e.dataTransfer.setData('cb-reorder', type);         // for section reorder
        e.dataTransfer.effectAllowed = 'copyMove';
        pill.classList.add('cb-pill-dragging');
        setTimeout(() => { _dragToAxis = true; }, 0);
      });
      pill.addEventListener('dragend', () => {
        pill.classList.remove('cb-pill-dragging');
      });
      // Tap / click to add (the only path that works on touch). A real drag
      // does not emit a click, so this never double-fires after a drag.
      pill.addEventListener('click', () => cbAssignField(key));

      section.appendChild(pill);
    });

    palette.appendChild(section);

    // Configure link + hidden picker panel
    const cfgLink = document.createElement('div');
    cfgLink.style.cssText = 'font-size:10px;color:var(--accent);cursor:pointer;padding:2px 2px 2px 0;text-align:right;margin-top:2px';
    cfgLink.innerHTML = '⚙ Configure';
    cfgLink.onclick = () => _cbOpenFieldPicker(type);
    palette.appendChild(cfgLink);

    const cfgPanel = document.createElement('div');
    cfgPanel.id = 'cb-field-cfg-' + type;
    cfgPanel.style.cssText = 'display:none;background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:8px;margin-top:4px';
    palette.appendChild(cfgPanel);
  });

  // Restore axis chips and re-render the chart from persisted cbState. This
  // makes the builder pick up where the user left off after a page reload.
  // (Was missing - the palette would build but the axes always rendered
  // empty even when cbState had been loaded from localStorage.)
  if (Array.isArray(cbState.x) && Array.isArray(cbState.y) &&
      (cbState.x.length || cbState.y.length)) {
    renderCbChips('x');
    renderCbChips('y');
    renderCustomChart();
  }
}

function cbDragOver(e)  { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }
function cbDragLeave(e) { e.currentTarget.classList.remove('drag-over'); }

function cbDrop(e, axis) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  const key = e.dataTransfer.getData('text/plain');
  if (!CB_FIELDS[key]) return;
  const f = CB_FIELDS[key];
  // Enforce type: X accepts dimensions only, Y accepts measures only.
  // Previously a measure could be dropped on X (collapsing every numeric
  // value into a unique bucket - useless) and a dim could be dropped on Y
  // (NaN aggregation). Block the wrong-axis drop and show a toast.
  if (axis === 'x' && f.type !== 'dim') {
    if (typeof toast === 'function') toast('“' + f.label + '” is a measure - drop it on Y');
    return;
  }
  if (axis === 'y' && f.type !== 'meas') {
    if (typeof toast === 'function') toast('“' + f.label + '” is a dimension - drop it on X');
    return;
  }
  _cbCommitField(key, axis);
}

// Shared tail for both drag-drop and tap-to-add: soft-warn on a cross-source
// field, then push it onto the axis and re-render. Allows cross-table builds
// (the bar may be empty) but explains why.
function _cbCommitField(key, axis) {
  const f = CB_FIELDS[key];
  if (!f) return;
  const src = document.getElementById('cb-source')?.value || 'all_inventory';
  if (Array.isArray(f.tables) && !f.tables.includes(src) && typeof toast === 'function') {
    toast('Note: “' + f.label + '” isn’t in the current source - values may be empty');
  }
  if (!cbState[axis].includes(key)) {
    cbState[axis].push(key);
    cbState.customItems = null;
    _saveCbState();
    renderCbChips(axis);
    renderCustomChart();
  }
}

// Tap / click a field to add it. Drag-and-drop does not fire on touch screens,
// so this is the only way the builder works on phones. The axis is implied by
// the field type - dimensions can only group (X), measures can only aggregate
// (Y) - so no axis picker is needed.
function cbAssignField(key) {
  const f = CB_FIELDS[key];
  if (!f) return;
  _cbCommitField(key, f.type === 'dim' ? 'x' : 'y');
}

function cbRemove(axis, key) {
  cbState[axis] = cbState[axis].filter(k => k !== key);
  cbState.customItems = null;
  _saveCbState();
  renderCbChips(axis);
  renderCustomChart();
}

function cbTopNChanged() {
  cbState.customItems = null;
  const pickerWrap = document.getElementById('cb-picker-wrap');
  if (pickerWrap) pickerWrap.style.display = 'none';
  renderCustomChart();
}

function toggleCbItemPicker() {
  const wrap = document.getElementById('cb-picker-wrap');
  if (!wrap) return;
  if (wrap.style.display !== 'none') { wrap.style.display = 'none'; return; }

  const items = getChartBuilderData();
  const sort  = document.getElementById('cb-sort')?.value || 'desc';
  const src   = document.getElementById('cb-source')?.value || 'all_inventory';
  const allEntries = _cbAggregate(items, cbState.x, cbState.y, src, sort, 'all');

  // Pre-check: either the current customItems selection, or the top-N items.
  const topN = document.getElementById('cb-topn')?.value || 'all';
  const defaultShown = topN !== 'all'
    ? new Set(allEntries.slice(0, parseInt(topN)).map(([k]) => k))
    : new Set(allEntries.map(([k]) => k));
  const currentSet = cbState.customItems ? new Set(cbState.customItems) : defaultShown;

  const list = document.getElementById('cb-picker-list');
  list.innerHTML = allEntries.map(([k]) => {
    const label = k.length > 26 ? k.slice(0, 26) + '…' : k;
    const checked = currentSet.has(k) ? 'checked' : '';
    return `<label style="display:flex;align-items:center;gap:5px;font-size:11px;padding:3px 6px;background:var(--bg);border-radius:4px;cursor:pointer;white-space:nowrap">` +
      `<input type="checkbox" value="${kjrEscape(k)}" ${checked}> ${kjrEscape(label)}</label>`;
  }).join('');
  wrap.style.display = 'block';
}

function applyCbItemPicker() {
  const checked = [...document.querySelectorAll('#cb-picker-list input[type=checkbox]:checked')].map(el => el.value);
  cbState.customItems = checked.length ? checked : null;
  document.getElementById('cb-picker-wrap').style.display = 'none';
  renderCustomChart();
}

function cbPickerSelectAll(val) {
  document.querySelectorAll('#cb-picker-list input[type=checkbox]').forEach(el => { el.checked = val; });
}

function renderCbChips(axis) {
  const chipsEl      = document.getElementById('cb-' + axis + '-chips');
  const placeholder  = document.getElementById('cb-' + axis + '-placeholder');
  if (!chipsEl) return;
  chipsEl.innerHTML = cbState[axis].map(key => {
    const f = CB_FIELDS[key] || { icon: '⚠️', label: key };
    return `<span class="cb-axis-chip">${f.icon} ${f.label}<button onclick="cbRemove('${axis}','${key}')" title="Remove">×</button></span>`;
  }).join('');
  if (placeholder) placeholder.style.display = cbState[axis].length ? 'none' : '';
}

function resetCustomChart() {
  cbState = { x: [], y: [], customItems: null };
  _saveCbState();
  renderCbChips('x'); renderCbChips('y');
  const kwEl = document.getElementById('cb-kw-filter');
  if (kwEl) kwEl.value = '';
  if (_cbChart) { _cbChart.destroy(); _cbChart = null; }
  document.getElementById('cb-chart-wrap').style.display = 'none';
  document.getElementById('cb-empty-state').style.display = 'flex';
  document.getElementById('cb-summary').innerHTML = '';
  const pickBtn = document.getElementById('cb-pick-btn');
  if (pickBtn) pickBtn.style.display = 'none';
  const pickerWrap = document.getElementById('cb-picker-wrap');
  if (pickerWrap) pickerWrap.style.display = 'none';
}

// Centralised "what's active inventory" - uses kjrIsActiveStatus so the chart
// builder, dashboard, and per-tab tables all agree (previously the chart used
// ad-hoc regex that excluded "Reserved" booster boxes/packs, silently
// understating sealed inventory).
function _cbActive(table, row) {
  if (table === 'singles' || table === 'slabs') return (row.status||'Available') === 'Available';
  if (typeof kjrIsActiveStatus === 'function') return kjrIsActiveStatus(table, row.status);
  return true;
}

// Shared: resolve {source, kwFilter} → items[] for both live + saved charts.
function _cbItemsForSource(src, kw) {
  let items = [];
  const singlesAvail = (DB.singles||[]).filter(i => _cbActive('singles', i));
  const slabsAvail   = (DB.slabs||[])  .filter(i => _cbActive('slabs', i));
  const etbsActive   = (DB.etbs||[])   .filter(r => _cbActive('etbs', r));
  const bbActive     = (DB.boosterBoxes||[]).filter(r => _cbActive('boosterBoxes', r));
  const bpActive     = (DB.boosterPacks||[]).filter(r => _cbActive('boosterPacks', r));
  if (src === 'singles')              items = singlesAvail;
  else if (src === 'slabs')           items = slabsAvail;
  else if (src === 'etbs')            items = etbsActive;
  else if (src === 'boosterBoxes')    items = bbActive;
  else if (src === 'boosterPacks')    items = bpActive;
  else if (src === 'ebay')            items = (DB.ebayPurchases || []).slice();
  else if (src === 'sales')           items = (DB.sales || []).slice();
  else /* all_inventory / everything */ items = [...singlesAvail, ...slabsAvail, ...etbsActive, ...bbActive, ...bpActive];
  const term = (kw||'').toLowerCase().trim();
  if (term) items = items.filter(i => ((i.name||i.product||i.title||'') + '').toLowerCase().includes(term));
  return items;
}

function getChartBuilderData() {
  const src = document.getElementById('cb-source')?.value || 'all_inventory';
  const kw  = document.getElementById('cb-kw-filter')?.value || '';
  return _cbItemsForSource(src, kw);
}

// Shared aggregator - used by both the live builder and saved charts so that
// the same {source, xFields, yFields} config always produces the SAME numbers.
// Previously _drawSavedChart did a naive sum that ignored agg='avg' and
// weighted=true, so saved charts disagreed with the live chart on the same
// configuration. That made saved charts unsafe to rely on.
function _cbAggregate(items, xFields, yFields, source, sort, topN) {
  const weightedSourceOk = ['singles','slabs','etbs','boosterBoxes','boosterPacks','all_inventory','everything'].includes(source);
  const getXKey = item => xFields.map(k => {
    const f = CB_FIELDS[k];
    if (!f) return '?';
    const v = f.get(item);
    return (v === undefined || v === null || v === '') ? '?' : String(v);
  }).join(' · ');

  const grouped = {}; // grouped[xKey][yKey] = { sum, n, weightedSum, weight }
  items.forEach(item => {
    const xKey = getXKey(item);
    if (!grouped[xKey]) {
      grouped[xKey] = {};
      yFields.forEach(k => grouped[xKey][k] = { sum: 0, n: 0, weightedSum: 0, weight: 0 });
    }
    yFields.forEach(k => {
      const f = CB_FIELDS[k];
      if (!f) return;
      const v = parseFloat(f.get(item)) || 0;
      const w = (weightedSourceOk && f.weighted) ? (parseInt(item.qty)||1) : 1;
      grouped[xKey][k].sum += v;
      grouped[xKey][k].n   += 1;
      grouped[xKey][k].weightedSum += v * w;
      grouped[xKey][k].weight      += w;
    });
  });

  // Resolve each cell to a scalar per the field's agg.
  Object.keys(grouped).forEach(xKey => {
    yFields.forEach(k => {
      const f = CB_FIELDS[k];
      const cell = grouped[xKey][k];
      if (!f)            grouped[xKey][k] = 0;
      else if (f.agg === 'avg')      grouped[xKey][k] = cell.n > 0 ? cell.sum / cell.n : 0;
      else if (f.weighted)            grouped[xKey][k] = cell.weightedSum;
      else                            grouped[xKey][k] = cell.sum;
    });
  });

  const firstY = yFields[0];
  let entries = Object.entries(grouped);
  if (sort === 'desc')      entries.sort((a,b) => (b[1][firstY]||0) - (a[1][firstY]||0));
  else if (sort === 'asc')  entries.sort((a,b) => (a[1][firstY]||0) - (b[1][firstY]||0));
  else                       entries.sort((a,b) => a[0].localeCompare(b[0]));
  if (topN && topN !== 'all') {
    const n = parseInt(topN);
    if (n > 0) entries = entries.slice(0, n);
  }
  return entries;
}

function renderCustomChart() {
  if (!cbState.x.length || !cbState.y.length) {
    document.getElementById('cb-chart-wrap').style.display = 'none';
    const empty = document.getElementById('cb-empty-state');
    empty.style.display = 'flex';
    // Restore the default prompt (may have been replaced by an alternate
    // empty-state message lower down).
    empty.innerHTML = '<svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="opacity:0.12"><rect x="4" y="30" width="12" height="18" rx="2" fill="currentColor"/><rect x="20" y="18" width="12" height="30" rx="2" fill="currentColor"/><rect x="36" y="6" width="12" height="42" rx="2" fill="currentColor"/></svg>';
    // Reset the summary line + destroy any leftover Chart instance -
    // otherwise stale "N groups · M items" persists after pills are cleared.
    const sumEl = document.getElementById('cb-summary');
    if (sumEl) sumEl.innerHTML = '';
    if (_cbChart) { try { _cbChart.destroy(); } catch(e) {} _cbChart = null; }
    const saveBtn = document.getElementById('cb-save-btn');
    if (saveBtn) saveBtn.disabled = true;
    return;
  }

  const items  = getChartBuilderData();
  const topN   = document.getElementById('cb-topn')?.value || 'all';
  const sort   = document.getElementById('cb-sort')?.value || 'desc';
  const ctype  = document.getElementById('cb-chart-type')?.value || 'bar';
  const dual   = document.getElementById('cb-dual-axis')?.checked || false;
  const src    = document.getElementById('cb-source')?.value || 'all_inventory';

  // If the current pill set + filter yields no rows at all, show an empty
  // state instead of rendering a chart with stale data.
  if (items.length === 0) {
    document.getElementById('cb-chart-wrap').style.display = 'none';
    const empty = document.getElementById('cb-empty-state');
    empty.style.display = 'flex';
    empty.innerHTML = '<svg width="52" height="52" viewBox="0 0 52 52" fill="none" style="opacity:0.12"><rect x="4" y="30" width="12" height="18" rx="2" fill="currentColor"/><rect x="20" y="18" width="12" height="30" rx="2" fill="currentColor"/><rect x="36" y="6" width="12" height="42" rx="2" fill="currentColor"/></svg>' +
      '<div style="font-size:13px;margin-top:8px">No data matches the current source &amp; filter</div>' +
      '<div style="font-size:11px;opacity:0.7">Clear the Filter field or pick a different Source</div>';
    const sumEl = document.getElementById('cb-summary');
    if (sumEl) sumEl.innerHTML = '';
    if (_cbChart) { try { _cbChart.destroy(); } catch(e) {} _cbChart = null; }
    return;
  }

  // Warn if every X-dimension chosen is irrelevant for this source - would
  // collapse the whole dataset into a single "?" bucket otherwise.
  const xKeysIrrelevant = cbState.x.filter(k => {
    const f = CB_FIELDS[k];
    return f && Array.isArray(f.tables) && !f.tables.includes(src);
  });
  const yKeysIrrelevant = cbState.y.filter(k => {
    const f = CB_FIELDS[k];
    return f && Array.isArray(f.tables) && !f.tables.includes(src);
  });

  // Aggregate via the shared helper so the live chart and any saved-chart
  // card with the same config produce identical numbers.
  let entries = _cbAggregate(items, cbState.x, cbState.y, src, sort, topN);

  // If the user has manually chosen items via the picker, filter to those.
  if (cbState.customItems && cbState.customItems.length) {
    const allowed = new Set(cbState.customItems);
    const filtered = entries.filter(([k]) => allowed.has(k));
    if (filtered.length) entries = filtered;
  }

  // Show/hide the Choose button once a chart is built.
  const pickBtn = document.getElementById('cb-pick-btn');
  if (pickBtn) pickBtn.style.display = entries.length ? '' : 'none';

  const labels  = entries.map(([k]) => k.length > 28 ? k.slice(0,28)+'…' : k);
  const isRound = ctype === 'doughnut' || ctype === 'pie';

  // One dataset per Y field
  const datasets = cbState.y.map((yKey, yi) => {
    const f      = CB_FIELDS[yKey];
    const color  = CB_PALETTE[yi % CB_PALETTE.length];
    const values = entries.map(([,v]) => parseFloat((v[yKey]||0).toFixed(2)));
    const ds = {
      label: f.label,
      data: values,
      backgroundColor: isRound ? entries.map((_,i) => CB_PALETTE[i % CB_PALETTE.length]) : color + '55',
      borderColor: isRound ? '#161616' : color,
      borderWidth: isRound ? 2 : 1.5,
      borderRadius: ctype === 'bar' ? 4 : 0,
      fill: ctype === 'line',
      tension: 0.3,
      pointRadius: ctype === 'line' ? 4 : 0,
    };
    // Dual axis: second dataset uses yAxisID: 'y2'
    if (dual && yi === 1) ds.yAxisID = 'y2';
    return ds;
  });

  document.getElementById('cb-empty-state').style.display = 'none';
  document.getElementById('cb-chart-wrap').style.display = 'block';
  if (_cbChart) { _cbChart.destroy(); _cbChart = null; }

  const ctx = document.getElementById('customChart').getContext('2d');
  const _cs = getComputedStyle(document.documentElement);
  const axisColor = _cs.getPropertyValue('--text3').trim() || '#666';
  const gridColor = _cs.getPropertyValue('--border').trim() || '#2a2a2a';

  // Per-measure tick formatters - previously every axis showed "S$" even when
  // the measure was Item Count, Sale Count, Margin %, or USD-denominated.
  const yKey1 = cbState.y[0];
  const yKey2 = cbState.y[1];
  const scales = isRound ? {} : {
    x: { ticks: { color: axisColor, font:{size:10}, maxRotation:40 }, grid:{display:false} },
    y: { ticks: { color: axisColor, font:{size:10}, callback: v => _cbFmtAxis(v, yKey1) }, grid:{color:gridColor}, title:{display:true,text:CB_FIELDS[yKey1]?.label||'',color:axisColor,font:{size:10}} }
  };
  if (dual && cbState.y.length > 1) {
    scales.y2 = {
      position: 'right', grid:{display:false},
      ticks: { color: CB_PALETTE[1], font:{size:10}, callback: v => _cbFmtAxis(v, yKey2) },
      title: { display:true, text:CB_FIELDS[yKey2]?.label||'', color:CB_PALETTE[1], font:{size:10} }
    };
  }

  _cbChart = new Chart(ctx, {
    type: ctype,
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 350 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: datasets.length > 1 || isRound,
          position: isRound ? 'bottom' : 'top',
          labels: { color:'#999', font:{size:11}, padding:12, usePointStyle:true}
        },
        tooltip: {
          callbacks: {
            // Per-dataset unit formatting (S$, US$, %, or count) - previously
            // hardcoded S$ for every measure even when it wasn't currency.
            label: tctx => {
              const yKey = cbState.y[tctx.datasetIndex] || cbState.y[0];
              const raw  = (tctx.parsed && typeof tctx.parsed.y === 'number') ? tctx.parsed.y : tctx.parsed;
              return ' ' + tctx.dataset.label + ': ' + _cbFmtMeasure(raw, yKey);
            }
          }
        }
      },
      scales
    }
  });

  // Summary stats per Y measure - formatted per-measure unit so Margin %
  // shows "23%" not "S$23" and Item Count shows "5" not "S$5".
  // For averaged measures, total is meaningless; show "Avg" of the group
  // averages instead (we still report Min/Max as group extremes).
  const summaryParts = cbState.y.map(yKey => {
    const f       = CB_FIELDS[yKey] || { label: yKey };
    const vals    = entries.map(([,v]) => Number(v[yKey])||0);
    const total   = vals.reduce((s,v) => s+v, 0);
    const avg     = vals.length ? total/vals.length : 0;
    const max     = vals.length ? Math.max(...vals) : 0;
    const min     = vals.length ? Math.min(...vals) : 0;
    const color   = CB_PALETTE[cbState.y.indexOf(yKey)];
    const fmt     = (v) => _cbFmtMeasure(v, yKey);
    const isAvg   = f.agg === 'avg';
    return `<span><strong style="color:${color}">${f.label}</strong>` +
           (isAvg ? '' : ` · Total: ${fmt(total)}`) +
           ` · Avg: ${fmt(avg)} · Min: ${fmt(min)} · Max: ${fmt(max)}</span>`;
  });
  // Render warnings (irrelevant pills for this source) inline above the chart.
  const warnings = [];
  if (xKeysIrrelevant.length) warnings.push('⚠ X pill(s) not in source: ' + xKeysIrrelevant.map(k => CB_FIELDS[k]?.label || k).join(', '));
  if (yKeysIrrelevant.length) warnings.push('⚠ Y pill(s) not in source: ' + yKeysIrrelevant.map(k => CB_FIELDS[k]?.label || k).join(', '));
  document.getElementById('cb-summary').innerHTML =
    `<span style="color:var(--text3)">${entries.length} groups · ${items.length} items</span>` +
    summaryParts.join('') +
    (warnings.length ? `<span style="color:#f59e0b">${warnings.join(' · ')}</span>` : '');

  // Enable the save button once a chart is rendered
  const saveBtn = document.getElementById('cb-save-btn');
  if (saveBtn) saveBtn.disabled = false;
}

// =========== SAVED CUSTOM CHARTS ===========
const SAVED_CHARTS_KEY = 'pokeinv_saved_charts';

function loadSavedCharts() {
  try { return JSON.parse(localStorage.getItem(SAVED_CHARTS_KEY) || '[]'); } catch(e) { return []; }
}
function persistSavedCharts(charts) {
  try { localStorage.setItem(SAVED_CHARTS_KEY, JSON.stringify(charts)); } catch(e) {}
}

function saveChartToDashboard() {
  if (!cbState.x.length || !cbState.y.length) { toast('Build a chart first'); return; }

  const title = prompt('Name this chart:', cbState.x.map(k => CB_FIELDS[k]?.label).join(' + ') + ' vs ' + cbState.y.map(k => CB_FIELDS[k]?.label).join(' + '));
  if (title === null) return; // cancelled

  const config = {
    id: 'sc_' + Date.now(),
    title: title || 'Custom Chart',
    xFields:   [...cbState.x],
    yFields:   [...cbState.y],
    source:    document.getElementById('cb-source')?.value || 'all_inventory',
    topN:      document.getElementById('cb-topn')?.value || '10',
    sort:      document.getElementById('cb-sort')?.value || 'desc',
    chartType: document.getElementById('cb-chart-type')?.value || 'bar',
    dualAxis:  document.getElementById('cb-dual-axis')?.checked || false,
    kwFilter:  document.getElementById('cb-kw-filter')?.value || '',
    savedAt:   new Date().toISOString()
  };

  const charts = loadSavedCharts();
  charts.push(config);
  persistSavedCharts(charts);
  renderAllSavedCharts();
  toast('Chart added to dashboard ✓');
}

// Keep keyboard focus within an open modal: Tab/Shift-Tab cycle its focusable
// children instead of escaping to the page behind. Re-binds cleanly on each call.
function trapFocus(el) {
  if (!el) return;
  const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  if (el._kjrTrapHandler) el.removeEventListener('keydown', el._kjrTrapHandler);
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const nodes = Array.from(el.querySelectorAll(sel)).filter(n => n.offsetParent !== null || n === document.activeElement);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  el._kjrTrapHandler = handler;
  el.addEventListener('keydown', handler);
}

// Promise-based confirm backed by the single styled <dialog id="kjr-confirm-dialog">.
// Resolves true on OK, false on Cancel / ESC / backdrop. msg may contain HTML, so
// callers must escape any user/Supabase strings with esc() before interpolating.
// opts: { ok, cancel, danger } - danger styles the OK button red for destructive actions.
function kjrConfirm(msg, opts) {
  opts = opts || {};
  const dlg = document.getElementById('kjr-confirm-dialog');
  if (!dlg || typeof dlg.showModal !== 'function') {
    return Promise.resolve(window.confirm(String(msg).replace(/<[^>]+>/g, '')));
  }
  const msgEl = document.getElementById('kjr-confirm-msg');
  const okBtn = document.getElementById('kjr-confirm-ok');
  const cancelBtn = document.getElementById('kjr-confirm-cancel');
  msgEl.innerHTML = msg;
  okBtn.textContent = opts.ok || 'OK';
  cancelBtn.textContent = opts.cancel || 'Cancel';
  okBtn.classList.toggle('btn-primary', !opts.danger);
  okBtn.style.background = opts.danger ? 'var(--red)' : '';
  okBtn.style.color = opts.danger ? '#fff' : '';
  okBtn.style.borderColor = opts.danger ? 'var(--red)' : '';

  return new Promise(resolve => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      dlg.removeEventListener('close', onClose);
      dlg.removeEventListener('click', onBackdrop);
      if (dlg.open) dlg.close();
      resolve(val);
    };
    const onClose = () => finish(false);
    const onBackdrop = (e) => { if (e.target === dlg) finish(false); };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    dlg.addEventListener('close', onClose);
    dlg.addEventListener('click', onBackdrop);
    dlg.showModal();
    trapFocus(dlg);
    okBtn.focus();
  });
}

async function deleteSavedChart(id) {
  const charts = loadSavedCharts();
  const config = charts.find(c => c.id === id);
  if (!config) return;

  // Guard: pinned charts can't be deleted
  if (config.pinned) { toast('📌 This chart is pinned - unpin it first to delete'); return; }

  if (!await kjrConfirm('Delete <strong>' + esc(config.title||'this chart') + '</strong>?<br><span style="font-size:11px;color:var(--text3)">Moved to trash, recoverable within 30 days.</span>', {ok:'Delete', danger:true})) return;

  // Send to trash for 30-day recovery
  await sendToTrash('savedChart', config, 'manual');

  // Remove from DOM and storage immediately
  const remaining = charts.filter(c => c.id !== id);
  persistSavedCharts(remaining);
  if (window._savedChartInstances?.[id]) {
    try { window._savedChartInstances[id].destroy(); } catch(e) {}
    delete window._savedChartInstances[id];
  }
  document.getElementById('sc-wrap-' + id)?.remove();

  // Show undo toast for 5 seconds (immediate undo)
  let undone = false;
  let undoTimer = null;
  toast('"' + (config.title||'Chart') + '" moved to trash', 5000);
  // Append an Undo button inside the message span (safe - config.title is escaped above via textContent first)
  const _msgEl = document.getElementById('toast-msg');
  if (_msgEl) _msgEl.insertAdjacentHTML('beforeend', ' &nbsp;<button onclick="(function(){window._undoDeleteChart&&window._undoDeleteChart()})()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:2px 8px;font-size:12px;cursor:pointer;vertical-align:middle">Undo</button>');
  clearTimeout(window._toastTimer);

  window._undoDeleteChart = function() {
    if (undone) return;
    undone = true;
    clearTimeout(undoTimer);
    const current = loadSavedCharts();
    const idx = charts.findIndex(c => c.id === id);
    current.splice(idx, 0, config);
    persistSavedCharts(current);
    _renderOneSavedChart(config);
    const container = document.getElementById('saved-charts-container');
    const saved = loadSavedCharts();
    saved.forEach(c => {
      const el = document.getElementById('sc-wrap-' + c.id);
      if (el) container.appendChild(el);
    });
    _drawSavedChart(config);
    toast('Chart restored ✓');
  };

  undoTimer = setTimeout(() => {
    if (!undone) {
      window._undoDeleteChart = null;
      const _t = document.getElementById('toast');
      if (_t) {
        _t.classList.remove('show','toast-error','toast-warn');
        if (_t.hidePopover && _t.matches(':popover-open')) { try { _t.hidePopover(); } catch(e){} }
        const _tMsg = document.getElementById('toast-msg');
        if (_tMsg) _tMsg.textContent = '';
      }
    }
  }, 5000);
}

function renderAllSavedCharts() {
  const charts = loadSavedCharts();
  const container = document.getElementById('saved-charts-container');
  if (!container) return;

  // Remove any cards no longer in saved list
  const existingIds = new Set(charts.map(c => c.id));
  container.querySelectorAll('.saved-chart-card').forEach(el => {
    if (!existingIds.has(el.dataset.id)) el.remove();
  });

  charts.forEach(config => {
    // Skip if card already rendered
    if (document.getElementById('sc-wrap-' + config.id)) return;
    _renderOneSavedChart(config);
  });
}

function togglePinChart(id) {
  const charts = loadSavedCharts();
  const config = charts.find(c => c.id === id);
  if (!config) return;
  config.pinned = !config.pinned;
  persistSavedCharts(charts);
  // Re-render just this card in place
  document.getElementById('sc-wrap-' + id)?.remove();
  _renderOneSavedChart(config);
  // Re-sort DOM order to match saved order
  const container = document.getElementById('saved-charts-container');
  loadSavedCharts().forEach(c => {
    const el = document.getElementById('sc-wrap-' + c.id);
    if (el) container.appendChild(el);
  });
  toast(config.pinned ? '📌 Chart pinned - protected from delete' : 'Chart unpinned');
}

async function deleteAllSavedCharts() {
  const charts = loadSavedCharts();
  const deletable = charts.filter(c => !c.pinned);
  const pinned    = charts.filter(c => c.pinned);
  if (!deletable.length) {
    if (pinned.length) toast('Nothing to delete - all ' + pinned.length + ' charts are pinned');
    else toast('No saved charts to delete');
    return;
  }
  const msg = pinned.length
    ? `Move ${deletable.length} unpinned chart${deletable.length!==1?'s':''} to trash? ${pinned.length} pinned chart${pinned.length!==1?'s':''} will be kept.`
    : `Move all ${deletable.length} saved chart${deletable.length!==1?'s':''} to trash? Restore within 30 days from the Trash tab.`;
  if (!await kjrConfirm(msg, {ok:'Move to trash', danger:true})) return;

  // Batch send to trash
  for (const c of deletable) {
    await sendToTrash('savedChart', c, 'bulk');
  }
  // Keep only pinned in localStorage
  persistSavedCharts(pinned);
  // Destroy instances and remove DOM nodes for deletable charts
  for (const c of deletable) {
    if (window._savedChartInstances?.[c.id]) {
      try { window._savedChartInstances[c.id].destroy(); } catch(e) {}
      delete window._savedChartInstances[c.id];
    }
    document.getElementById('sc-wrap-' + c.id)?.remove();
  }
  toast(deletable.length + ' chart' + (deletable.length!==1?'s':'') + ' moved to trash' + (pinned.length ? ' · ' + pinned.length + ' pinned kept' : ''));
}

function _renderOneSavedChart(config) {
  const container = document.getElementById('saved-charts-container');
  if (!container) return;

  const wrap = document.createElement('div');
  wrap.className = 'saved-chart-card';
  wrap.dataset.id = config.id;
  wrap.id = 'sc-wrap-' + config.id;

  // Build description tags
  const xLabels = config.xFields.map(k => CB_FIELDS[k]?.label || k).join(' · ');
  const yLabels = config.yFields.map(k => CB_FIELDS[k]?.label || k).join(' · ');
  // Include every source the chart-builder actually exposes; previously this
  // mapped only 4 sources, so saved charts built from ETB/BoosterBox/
  // BoosterPack/eBay rendered their source as the raw key in the meta line.
  const sourceLabelMap = {
    singles:'Singles', slabs:'Slabs', etbs:'ETBs',
    boosterBoxes:'Booster Boxes', boosterPacks:'Booster Packs',
    ebay:'eBay Purchases', sales:'Sales', all_inventory:'All Inventory'
  };
  const meta = [
    sourceLabelMap[config.source] || config.source,
    config.kwFilter ? `Filter: "${config.kwFilter}"` : null,
    'Top ' + config.topN,
    config.chartType.charAt(0).toUpperCase() + config.chartType.slice(1)
  ].filter(Boolean).join('  ·  ');

  wrap.innerHTML = `
    <div class="card">
      <div class="card-head" style="flex-direction:column;align-items:flex-start;gap:4px">
        <div style="display:flex;justify-content:space-between;width:100%;align-items:center">
          <h3 style="font-size:14px;display:flex;align-items:center;gap:6px">
            ${config.pinned ? '<span title="Pinned - protected from delete" style="color:#f59e0b;font-size:13px">📌</span>' : ''}
            ${config.title}
          </h3>
          <div style="display:flex;gap:6px;align-items:center">
            <button class="btn btn-sm" style="font-size:10px" onclick="togglePinChart('${config.id}')" title="${config.pinned ? 'Unpin (allow deletion)' : 'Pin (protect from delete)'}">${config.pinned ? '📌 Pinned' : '📍 Pin'}</button>
            <button class="btn btn-sm" style="font-size:10px" onclick="_refreshSavedChart('${config.id}')">⟳ Refresh data</button>
            ${config.pinned ? '' : `<button onclick="deleteSavedChart('${config.id}')" title="Delete chart" style="background:transparent;border:none;color:var(--text3);font-size:14px;line-height:1;padding:2px 6px;cursor:pointer;border-radius:4px;transition:color 0.15s,background 0.15s" onmouseover="this.style.color='var(--red)';this.style.background='rgba(239,68,68,0.08)'" onmouseout="this.style.color='var(--text3)';this.style.background='transparent'">×</button>`}
          </div>
        </div>
        <div style="font-size:11px;color:var(--text3)">X: ${xLabels} &nbsp;·&nbsp; Y: ${yLabels}</div>
        <div style="font-size:10px;color:var(--text3);opacity:0.7">${meta}</div>
      </div>
      <div class="card-body" style="padding:12px 18px">
        <div style="height:260px"><canvas id="sc-canvas-${config.id}"></canvas></div>
        <div id="sc-summary-${config.id}" style="font-size:11px;color:var(--text3);margin-top:8px;display:flex;gap:16px;flex-wrap:wrap"></div>
      </div>
    </div>
    ${config.pinned
      ? '<div style="text-align:center;font-size:10px;color:var(--text3);padding:6px;border-top:1px solid var(--border);opacity:0.6">📌 Pinned · unpin to delete</div>'
      : ''}`;

  container.appendChild(wrap);
  _drawSavedChart(config);
}

function _drawSavedChart(config) {
  if (!window._savedChartInstances) window._savedChartInstances = {};

  // Destroy old instance
  if (window._savedChartInstances[config.id]) {
    try { window._savedChartInstances[config.id].destroy(); } catch(e) {}
    delete window._savedChartInstances[config.id];
  }

  const canvas = document.getElementById('sc-canvas-' + config.id);
  if (!canvas) return;

  // Use the SAME pipeline as the live builder so a saved chart and the live
  // chart with the same config produce identical numbers. Previously this
  // function:
  //   • Only knew 4 sources (singles/slabs/sales/all_inventory) - ETBs,
  //     Booster Boxes, Booster Packs, eBay all silently fell through to
  //     all_inventory, so a chart saved on ETBs rendered the wrong source.
  //   • Always summed values (ignored agg='avg') - Margin %, Item-Count
  //     averages, etc. were aggregated incorrectly.
  //   • Did not weight by qty - a single with qty=5 contributed 1× not 5×
  //     to the bar height, under-reporting multi-qty inventory.
  const src     = config.source;
  const items   = _cbItemsForSource(src, config.kwFilter || '');
  const entries = _cbAggregate(items, config.xFields, config.yFields, src, config.sort, config.topN);

  const labels  = entries.map(([k]) => k.length > 28 ? k.slice(0,28)+'…' : k);
  const isRound = config.chartType === 'doughnut' || config.chartType === 'pie';
  const pal     = CB_PALETTE;

  // Read theme tokens once up top so both the dataset border (doughnut/pie
  // slice separator) and the axis/grid/legend options below can use them.
  const _cs = getComputedStyle(document.documentElement);
  const axisColor = _cs.getPropertyValue('--text3').trim() || '#666';
  const gridColor = _cs.getPropertyValue('--border').trim() || '#2a2a2a';
  const legendColor = _cs.getPropertyValue('--text2').trim() || '#999';
  const cardBgColor = _cs.getPropertyValue('--bg2').trim() || '#161616';

  const datasets = config.yFields.map((yKey, yi) => {
    const f     = CB_FIELDS[yKey];
    const color = pal[yi % pal.length];
    const vals  = entries.map(([,v]) => parseFloat((v[yKey]||0).toFixed(2)));
    const ds = {
      label: f?.label || yKey,
      data: vals,
      backgroundColor: isRound ? entries.map((_,i) => pal[i%pal.length]) : color+'55',
      borderColor: isRound ? cardBgColor : color,
      borderWidth: isRound ? 2 : 1.5,
      borderRadius: config.chartType === 'bar' ? 4 : 0,
      fill: config.chartType === 'line',
      tension: 0.3,
      pointRadius: config.chartType === 'line' ? 4 : 0,
    };
    if (config.dualAxis && yi === 1) ds.yAxisID = 'y2';
    return ds;
  });
  const yKey1 = config.yFields[0];
  const yKey2 = config.yFields[1];
  const scales = isRound ? {} : {
    x: { ticks:{color:axisColor,font:{size:10},maxRotation:40}, grid:{display:false} },
    y: { ticks:{color:axisColor,font:{size:10},callback:v=>_cbFmtAxis(v, yKey1)}, grid:{color:gridColor}, title:{display:true,text:CB_FIELDS[yKey1]?.label||'',color:axisColor,font:{size:10}} }
  };
  if (config.dualAxis && config.yFields.length > 1) {
    scales.y2 = { position:'right', grid:{display:false}, ticks:{color:pal[1],font:{size:10},callback:v=>_cbFmtAxis(v, yKey2)}, title:{display:true,text:CB_FIELDS[yKey2]?.label||'',color:pal[1],font:{size:10}} };
  }

  window._savedChartInstances[config.id] = new Chart(canvas.getContext('2d'), {
    type: config.chartType,
    data: { labels, datasets },
    options: {
      responsive:true, maintainAspectRatio:false, animation:{duration:350},
      interaction:{mode:'index',intersect:false},
      plugins: {
        legend:{display:datasets.length>1||isRound,position:isRound?'bottom':'top',labels:{color:legendColor,font:{size:11},padding:12,usePointStyle:true}},
        tooltip:{callbacks:{label:tctx=>{
          const yKey = config.yFields[tctx.datasetIndex] || config.yFields[0];
          const raw  = (tctx.parsed && typeof tctx.parsed.y === 'number') ? tctx.parsed.y : tctx.parsed;
          return ' ' + tctx.dataset.label + ': ' + _cbFmtMeasure(raw, yKey);
        }}}
      },
      scales
    }
  });

  // Summary - unit-aware per measure; suppresses misleading "Total" when the
  // measure is an average (e.g. Margin %).
  const summaryEl = document.getElementById('sc-summary-' + config.id);
  if (summaryEl) {
    const parts = config.yFields.map((yKey,yi) => {
      const f     = CB_FIELDS[yKey] || { label: yKey };
      const vals  = entries.map(([,v]) => Number(v[yKey])||0);
      const tot   = vals.reduce((s,v)=>s+v,0);
      const avg   = vals.length ? tot/vals.length : 0;
      const max   = vals.length ? Math.max(...vals) : 0;
      const min   = vals.length ? Math.min(...vals) : 0;
      const isAvg = f.agg === 'avg';
      const fmt   = (v) => _cbFmtMeasure(v, yKey);
      return `<span><strong style="color:${pal[yi%pal.length]}">${f.label}</strong>` +
             (isAvg ? '' : ` · Total: ${fmt(tot)}`) +
             ` · Avg: ${fmt(avg)} · Min: ${fmt(min)} · Max: ${fmt(max)}</span>`;
    });
    summaryEl.innerHTML = `<span style="color:var(--text3)">${entries.length} groups · ${items.length} items</span>` + parts.join('');
  }
}

function _refreshSavedChart(id) {
  const config = loadSavedCharts().find(c => c.id === id);
  if (config) { _drawSavedChart(config); toast('Chart refreshed with latest data'); }
}

// =========== DASHBOARD DRAG-TO-REORDER ===========
const DASH_ORDER_KEY = 'pokeinv_dash_order';
let _dashDragSrc = null;

function saveDashOrder() {
  const order = Array.from(document.querySelectorAll('.dash-card-wrap')).map(el => el.id);
  try { localStorage.setItem(DASH_ORDER_KEY, JSON.stringify(order)); } catch(e) {}
}

function restoreDashOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(DASH_ORDER_KEY) || 'null');
    if (!saved || !saved.length) return;
    // Rebuild grid by moving cards into their saved order
    // Find all rows and flatten all cards in order
    const container = document.getElementById('dash-grid-container');
    if (!container) return;
    const allRows   = Array.from(container.querySelectorAll('.dash-grid'));
    const allCards  = Array.from(container.querySelectorAll('.dash-card-wrap'));
    const cardMap   = {};
    allCards.forEach(c => cardMap[c.id] = c);

    // Re-insert cards in saved order across rows (2 per row)
    let ri = 0;
    for (let i = 0; i < saved.length; i += 2) {
      const row = allRows[ri++];
      if (!row) break;
      row.innerHTML = '';
      [saved[i], saved[i+1]].forEach(id => { if (id && cardMap[id]) row.appendChild(cardMap[id]); });
    }
  } catch(e) {}
}

function initDashboardDrag() {
  document.querySelectorAll('.dash-card-wrap').forEach(card => {
    card.addEventListener('dragstart', e => {
      _dashDragSrc = card;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.id);
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.dash-card-wrap').forEach(c => c.classList.remove('drag-target'));
      saveDashOrder();
    });
    card.addEventListener('dragover', e => {
      e.preventDefault();
      if (card !== _dashDragSrc) {
        document.querySelectorAll('.dash-card-wrap').forEach(c => c.classList.remove('drag-target'));
        card.classList.add('drag-target');
      }
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-target'));
    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drag-target');
      if (!_dashDragSrc || _dashDragSrc === card) return;
      // Swap the two cards in the DOM
      const srcParent  = _dashDragSrc.parentNode;
      const tgtParent  = card.parentNode;
      const srcNext    = _dashDragSrc.nextSibling;
      const tgtNext    = card.nextSibling;
      if (srcNext === card) {
        srcParent.insertBefore(card, _dashDragSrc);
      } else if (tgtNext === _dashDragSrc) {
        tgtParent.insertBefore(_dashDragSrc, card);
      } else {
        srcParent.insertBefore(card, srcNext);
        tgtParent.insertBefore(_dashDragSrc, tgtNext);
      }
      saveDashOrder();
    });
  });
}
(function() {
  const _orig = window.showPage;
  window.showPage = function(id) {
    if (_orig) _orig(id);
    document.querySelectorAll('.btb-item').forEach(b => b.classList.remove('active'));
    const btb = document.getElementById('btb-' + id);
    if (btb) btb.classList.add('active');
    // Pages without a dedicated tab live under "More" - light that up instead.
    else if (typeof MORE_PAGES !== 'undefined' && MORE_PAGES.has(id)) {
      const more = document.getElementById('btb-more');
      if (more) more.classList.add('active');
    }
  };
})();

// ── HIG: Update "Last updated" timestamp when dashboard renders ──
(function() {
  const _orig = window.renderDashboard;
  window.renderDashboard = function() {
    if (_orig) _orig();
    const el = document.getElementById('dash-last-updated');
    if (el) el.textContent = 'Updated ' + new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
  };
})();

// ── HIG: Auto-detect import type from pasted content ──
let _detectedImportType = null;
function autoDetectImportType() {
  const raw = (document.getElementById('import-data').value || '');
  const banner = document.getElementById('import-detect-banner');
  const label  = document.getElementById('import-detect-text');
  if (!raw.trim()) { banner.classList.remove('show'); return; }
  // Only inspect the *header* row. Scanning the entire body produced false
  // positives - e.g. a single's notes mentioning "PSA 9 case cracked" would
  // flip detection to Slabs.
  const header = raw.split('\n')[0].toLowerCase();
  let detected = null;
  if (/cert|certno|psa|cgc|tag grade|grader|\bgrade\b/.test(header)) detected = 'slabs';
  else if (/buyer|revenue|sold for|\bprofit\b|\bmargin\b|\bshipping\b/.test(header)) detected = 'sales';
  else if (/etb|elite trainer|\bbox\b|booster/.test(header)) detected = 'singles'; // fallback when user manually selects type
  else if (/name|card|set|language|condition|qty/.test(header)) detected = 'singles';
  if (detected) {
    _detectedImportType = detected;
    const labels = { singles: 'Singles / Raw', slabs: 'Slabs / Graded', sales: 'Sales History' };
    label.textContent = 'Detected type: ' + (labels[detected] || detected);
    banner.classList.add('show');
  } else { banner.classList.remove('show'); }
}
function applyDetectedType() {
  if (_detectedImportType) {
    document.getElementById('import-type').value = _detectedImportType;
    document.getElementById('import-detect-banner').classList.remove('show');
    toast('Import type set to: ' + _detectedImportType);
  }
}

// ── HIG: Sales sub loading spinner on page switch ──
(function() {
  const _orig = window.showPage;
  window.showPage = function(id) {
    if (_orig) _orig(id);
    // Sales subline removed - the stat cards convey all the info.
    if (id === 'sales') { /* no-op */ }
  };
})();

buildColMenus();
// Restore saved dashboard card order
restoreDashOrder();
// Kick off async DB load from Supabase, then render
initDB();
// Auto-purge trash items older than 30 days (runs in background)
setTimeout(() => { if (typeof purgeExpiredTrash === 'function') purgeExpiredTrash(); }, 5000);
// Auto-run refresh queue (if today's credits not exhausted)
setTimeout(() => { runRefreshQueue(false); }, 8000); // wait 8s for DB to fully load
