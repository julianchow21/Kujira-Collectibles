/* Kujira Collectibles, appended features (split from index.html, v3.12, 05/07/2026).
   Ten blocks in original document order: import installer, shared helpers, Booster Packs,
   market read, guide renderer, Sentry errors panel. Loads after app.js. */
// Register the service worker. Allowed on https + localhost; scoped to this
// app folder. Network-first HTML means a new deploy still shows immediately.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW register failed:', err));
  });
}
(function() {
  let _kjrShellBaseline = null;
  let _kjrShellLastCheck = 0;
  const KJR_SHELL_CHECK_MS = 30 * 60 * 1000; // throttle: at most once per 30 min

  function kjrEnsureUpdatePill() {
    let pill = document.getElementById('kjr-update-pill');
    if (pill) return pill;
    pill = document.createElement('div');
    pill.id = 'kjr-update-pill';
    pill.setAttribute('role', 'status');
    pill.innerHTML = '<span>Update ready, tap to reload</span>' +
      '<button id="kjr-update-pill-close" type="button" aria-label="Dismiss">✕</button>';
    pill.addEventListener('click', (e) => {
      if (e.target.id === 'kjr-update-pill-close') { e.stopPropagation(); pill.classList.remove('show'); return; }
      location.reload();
    });
    document.body.appendChild(pill);
    return pill;
  }

  async function kjrCheckShellVersion() {
    try {
      const res = await fetch('./index.html', { method: 'HEAD', cache: 'no-store' });
      if (!res.ok) return; // silent no-op, e.g. offline
      const stamp = res.headers.get('ETag') || res.headers.get('Last-Modified');
      if (!stamp) return; // silent no-op, server doesn't expose either header
      if (_kjrShellBaseline === null) { _kjrShellBaseline = stamp; return; } // first probe just sets the baseline
      if (stamp !== _kjrShellBaseline) kjrEnsureUpdatePill().classList.add('show');
    } catch (_) {
      // offline or blocked - say nothing, this is a background probe
    }
  }

  function kjrMaybeCheckShellVersion() {
    const now = Date.now();
    if (now - _kjrShellLastCheck < KJR_SHELL_CHECK_MS) return;
    _kjrShellLastCheck = now;
    kjrCheckShellVersion();
  }

  window.addEventListener('load', kjrMaybeCheckShellVersion);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') kjrMaybeCheckShellVersion();
  });
})();
(function(){
  // Don't double-install
  if (window._kjrImportInstalled) return;
  window._kjrImportInstalled = true;

  // Field aliases per table - each entry tries the listed normalized header keys.
  const KJR_IMPORT_SCHEMAS = {
    etbs: {
      dbKey: 'etbs',
      idPrefix: 'etb',
      fields: [
        { out:'status',     aliases:['status'] },
        { out:'product',    aliases:['product','name','card'] },
        { out:'totalPrice', aliases:['totalprice','total','price','totalpricesgd','totalprice$','totalpricesgd'] },
        { out:'condition',  aliases:['condition','cond'] },
        { out:'date',       aliases:['date','datepurchased','purchasedate'] },
      ],
      defaults: { status: 'In Stock', condition: 'Mint' },
    },
    booster_packs: {
      dbKey: 'boosterPacks',
      idPrefix: 'bp',
      fields: [
        { out:'date',       aliases:['date','datepurchased'] },
        { out:'product',    aliases:['product','name'] },
        { out:'unitPrice',  aliases:['unitprice','unit','priceeach','pricepack'] },
        { out:'qty',        aliases:['qty','quantity','count'] },
        { out:'totalPrice', aliases:['totalprice','total','totalpricesgd'] },
        { out:'status',     aliases:['status'] },
        { out:'notes',      aliases:['notes','note','remarks'] },
      ],
      defaults: { status: 'Sealed', qty: '1' },
    },
    booster_boxes: {
      dbKey: 'boosterBoxes',
      idPrefix: 'bb',
      fields: [
        { out:'date',       aliases:['date','datepurchased'] },
        { out:'product',    aliases:['product','name'] },
        { out:'unitPrice',  aliases:['unitprice','unit','priceeach'] },
        { out:'qty',        aliases:['qty','quantity','count'] },
        { out:'totalPrice', aliases:['totalprice','total','totalpricesgd'] },
        { out:'status',     aliases:['status'] },
        { out:'notes',      aliases:['notes','note','remarks'] },
      ],
      defaults: { status: 'Unopened Stock', qty: '1' },
    },
    ebay_purchases: {
      dbKey: 'ebayPurchases',
      idPrefix: 'eb',
      fields: [
        { out:'date',        aliases:['date','column1','datepurchased','purchasedate','column'] },
        { out:'status',      aliases:['status'] },
        { out:'tracking',    aliases:['tracking','buyandshipstatustracking','trackingnumber','trackingno'] },
        { out:'declared',    aliases:['declared','declaredonbuyandship','declaration'] },
        { out:'product',     aliases:['product','name','card'] },
        // priceUsd MUST be unambiguously USD - a generic "price" column might
        // be SGD on a Singapore-side spreadsheet and would mis-bucket the
        // currency. freightSgd MUST be unambiguously freight/shipping - a
        // generic "cost" column often means the card cost, not the shipping
        // surcharge.
        { out:'priceUsd',    aliases:['priceusd','priceusd$','usd','priceus','pricedollars','itemprice','itemcost','ebayprice','price$us'] },
        // Greatly-expanded freight aliases - captures the common variants of
        // Buyandship's shipping/handling column ("Cost (Buyandship)",
        // "Buyandship Freight", "BSh Shipping", "BS Cost", "Freight (SGD)" etc).
        { out:'freightSgd',  aliases:[
            'freightsgd','freight','shipping','shippingsgd','shippingfee','shippingfees','ship',
            'costbuyandship','buyandship','buyandshipfreight','buyandshipcost','buyandshipshipping',
            'bsh','bshfreight','bshcost','bshshipping','bs','bsfreight','bscost',
            'freightsg','freightcost','handling','handlingfee','postage','postagesgd','shippingcost','freightprice'
        ] },
        { out:'totalSgd',    aliases:['totalsgd','totalpricesgd','totalsgd$','totalcost','totalcostsgd','allin','allinsgd','totalprice','grandtotal','grandtotalsgd'] },
        { out:'targetTable', aliases:['targettable','target','goesto'] },
        { out:'receivedAt',  aliases:['receivedat','received'] },
      ],
      defaults: { status: 'Ordered', declared: 'Yes' },
    },
  };

  function normH(h){ return String(h||'').trim().toLowerCase().replace(/[^a-z0-9]/g,''); }
  function kjrGenId(p){ return p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8); }

  function parsePastedTable(raw){
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length < 2) return null;
    const headers = lines[0].split('\t').map(normH);
    const rows = lines.slice(1).map(l => l.split('\t').map(v => v.trim().replace(/^"|"$/g,'')));
    return { headers, rows };
  }

  function mapFields(schema, headers){
    // For each schema field, find the column index that matches any alias.
    return schema.fields.map(f => {
      const idx = headers.findIndex(h => f.aliases.includes(h));
      return { ...f, idx };
    });
  }

  async function importNewType(type){
    const raw = document.getElementById('import-data').value.trim();
    if (!raw) { toast('No data to import'); return; }
    const parsed = parsePastedTable(raw);
    if (!parsed) { toast('Need header row + at least 1 data row'); return; }
    const schema = KJR_IMPORT_SCHEMAS[type];
    if (!schema) { toast('Unknown type: ' + type); return; }
    const mapping = mapFields(schema, parsed.headers);

    const mode = document.getElementById('import-mode').value;
    const newItems = [];
    const skipped = [];

    // Numeric fields that should be stored as numbers (not "$10.00" strings)
    // so downstream maths and Supabase types stay consistent.
    const NUMERIC = new Set(['totalPrice','unitPrice','priceUsd','freightSgd','totalSgd','qty','marketPrice']);
    const cleanNum = v => {
      const x = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
      return isNaN(x) ? '' : x;
    };
    parsed.rows.forEach((vals, i) => {
      const obj = { id: kjrGenId(schema.idPrefix), ...schema.defaults };
      mapping.forEach(m => {
        if (m.idx >= 0 && vals[m.idx] !== undefined && vals[m.idx] !== '') {
          obj[m.out] = NUMERIC.has(m.out) ? cleanNum(vals[m.idx]) : vals[m.idx];
        }
      });
      // require product/name to keep a row
      if (!obj.product) {
        skipped.push({ lineNum: i + 2, raw: parsed.rows[i].join('\t') });
        return;
      }
      newItems.push(obj);
    });

    if (!newItems.length) {
      toast('Nothing imported (no rows with a product name)');
      return;
    }

    snapshotForUndo && snapshotForUndo();
    const arr = DB[schema.dbKey] = DB[schema.dbKey] || [];
    if (mode === 'replace') {
      if (arr.length && !await kjrConfirm('Replace all ' + arr.length + ' existing ' + esc(type) + ' rows with ' + newItems.length + ' imported? Use Undo (Ctrl+Z) if you change your mind.\n\nCloud-stored rows that no longer exist locally will also be deleted from Supabase.', {ok:'Replace', danger:true})) {
        toast('Import cancelled');
        return;
      }
      // Delete the old IDs in Supabase too - otherwise the cloud keeps the
      // orphans and they merge back in on next load. Awaited (not
      // fire-and-forget) so a failed delete cannot silently resurrect: sbDelete
      // already catches network/HTTP failures internally and queues them onto
      // the pending-delete retry queue (PENDING_DEL_KEY / flushPendingDeletes),
      // but the caller still needs to wait for that to happen and warn the
      // user, otherwise the row keeps existing in Supabase this entire session
      // and the finding's resurrection risk is unchanged (FINDING A2).
      const sbTable = (typeof _tblName === 'function') ? _tblName(schema.dbKey) : schema.dbKey;
      if (typeof sbDelete === 'function') {
        const results = await Promise.allSettled(arr.map(r => sbDelete(sbTable, r.id)));
        const failCount = results.filter(res => res.status === 'rejected' || res.value === false).length;
        if (failCount > 0 && typeof toastError === 'function') {
          toastError(failCount + ' cloud delete(s) failed and were queued to retry automatically - they will not reappear.');
        }
      }
      DB[schema.dbKey] = newItems;
    } else {
      newItems.forEach(it => arr.push(it));
    }
    newItems.forEach(it => markDirty(schema.dbKey, it.id));
    saveData();

    // Re-render the relevant tab. (Previously booster_packs was missing here,
    // so a pack import succeeded silently but the table wasn't refreshed.)
    if (type === 'etbs') renderEtbs();
    else if (type === 'booster_boxes') renderBoosterBoxes();
    else if (type === 'booster_packs' && typeof renderBoosterPacks === 'function') renderBoosterPacks();
    else if (type === 'ebay_purchases') renderEbayPurchases();
    if (typeof clLog === 'function') clLog('import', schema.dbKey, type, newItems.length + ' rows · mode=' + mode);

    // Update result banner (same UI affordance the original importData uses)
    const el = document.getElementById('import-result');
    el.style.display = 'block';
    el.style.color = 'var(--green)';
    let h = '<span style="color:var(--green)">✓ Imported ' + newItems.length + ' ' + type + ' records' + (skipped.length ? ' · <span style="color:var(--amber)">' + skipped.length + ' skipped (no product)</span>' : '') + '</span>';
    if (skipped.length) {
      const rowsHtml = skipped.map(r =>
        '<div class="skipped-row-item"><span class="skipped-row-num">Row ' + r.lineNum + '</span>' +
        r.raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>'
      ).join('');
      h += '<div class="skipped-box"><button class="skipped-toggle" onclick="this.nextElementSibling.classList.toggle(\'open\')">▶ Show ' + skipped.length + ' skipped rows</button>' +
           '<div class="skipped-rows">' + rowsHtml + '</div></div>';
    }
    el.innerHTML = h;

    toast('Imported ' + newItems.length + ' ' + type + ' records!');
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
    clLog && clLog('import', type, newItems.length + ' records imported via paste');
  }

  // Wrap the original importData so the old behavior is untouched.
  const _orig = window.importData;
  window.importData = function(){
    const type = document.getElementById('import-type').value;
    if (KJR_IMPORT_SCHEMAS[type]) return importNewType(type);
    return _orig.apply(this, arguments);
  };
})();
document.querySelectorAll('dialog[id]').forEach(dlg => {
  dlg.addEventListener('cancel', e => { e.preventDefault(); kjrModalCtrl.close(dlg); });
  dlg.addEventListener('click', e => { if (e.target === dlg) kjrModalCtrl.close(dlg); });
});
// ═════════════ Shared helpers ═════════════
function kjrId(p){ return p + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,8); }
function kjrEscape(s){ return esc(s); } // alias, esc() in the HELPERS section is the single escaping implementation
// kjrNum - robust numeric parser. Strips $, commas, spaces and any other
// formatting before parseFloat. Returns 0 for empty / invalid input.
// Critical because parseFloat("1,250") returns 1 (stops at the comma) -
// pasting a comma-formatted value used to silently truncate the price.
function kjrNum(n){
  if (n == null || n === '') return 0;
  if (typeof n === 'number') return isFinite(n) ? n : 0;
  const x = parseFloat(String(n).replace(/[^0-9.\-]/g, ''));
  return isNaN(x) ? 0 : x;
}
// kjrMoneyStr - same sanitisation as kjrNum but returns a clean numeric
// STRING (or '' for empty) for storage in DB fields that round-trip as text.
function kjrMoneyStr(val){
  if (val == null || val === '') return '';
  const cleaned = String(val).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return '';
  const n = parseFloat(cleaned);
  return isNaN(n) ? '' : String(n);
}
// Whole-number currency display by default (the app standardised on whole
// numbers everywhere - cents are noise for a collectibles tracker).
function kjrFmt(n){ const x=kjrNum(n); return x===0?'':'S$'+Math.round(x).toLocaleString('en-SG'); }
function fmtUsd(n){ const x=kjrNum(n); return x===0?'':'US$'+Math.round(x).toLocaleString('en-SG'); }
function kjrPill(s){
  const c = (s||'').toLowerCase(); const v = kjrEscape(s);
  if (c.includes('sold'))                         return '<span class="kjr-status-pill kjr-pill-sold">'+v+'</span>';
  if (c.includes('trad'))                         return '<span class="kjr-status-pill kjr-pill-traded">'+v+'</span>';
  if (c.includes('cancel'))                       return '<span class="kjr-status-pill kjr-pill-pending">'+v+'</span>';
  if (c.includes('receiv') || c.includes('complete')) return '<span class="kjr-status-pill kjr-pill-received">'+v+'</span>';
  if (c.includes('ship') || c.includes('buyandship') || c.includes('order') || c.includes('pend'))
                                                  return '<span class="kjr-status-pill kjr-pill-pending">'+v+'</span>';
  return '<span class="kjr-status-pill kjr-pill-stock">'+v+'</span>';
}
function kjrStatCard(label, value, tooltip){
  // Info buttons removed; tooltip now lives on the card itself (native title).
  const titleAttr = tooltip ? ' title="' + kjrEscape(tooltip) + '"' : '';
  return '<div class="inv-stat"' + titleAttr + '><div class="inv-stat-label">'+kjrEscape(label)+'</div><div class="inv-stat-value">'+value+'</div></div>';
}

// ═════════════ Sort state ═════════════
const _kjrSort = { etbs:{k:null,dir:1}, boosterBoxes:{k:null,dir:1}, ebayPurchases:{k:null,dir:1} };
function kjrSort(dbKey, k){
  const s = _kjrSort[dbKey];
  s.dir = (s.k === k) ? -s.dir : 1;
  s.k = k;
  if (dbKey === 'etbs') renderEtbs();
  else if (dbKey === 'boosterBoxes') renderBoosterBoxes();
  else if (dbKey === 'ebayPurchases') renderEbayPurchases();
}
// Default A→Z sort key for the kjr-style tabs.
const _KJR_DEFAULT_SORT = { etbs: 'product', boosterBoxes: 'product', boosterPacks: 'product', ebayPurchases: '_pipeline' };
function kjrApplySort(rows, dbKey){
  const s = _kjrSort[dbKey];
  const key = s.k || _KJR_DEFAULT_SORT[dbKey];
  if (!key) return rows;
  // ebayPurchases default: date DESC (newest purchase at top) so pushing a
  // pipeline status never rearranges rows.
  if (!s.k && dbKey === 'ebayPurchases') {
    return [...rows].sort((a, b) => (dateToMs(b.date) || 0) - (dateToMs(a.date) || 0));
  }
  const dir = s.k ? s.dir : 1;
  const DATE_KEYS = new Set(['date','dateListed','datePurchased','dateSold','receivedAt']);
  const NUM_KEYS  = new Set(['costPrice','marketPrice','listPrice','unitPrice','totalPrice',
                             'qty','priceUsd','freightSgd','totalSgd','grade']);
  const isDate = DATE_KEYS.has(key);
  const isNum  = NUM_KEYS.has(key);
  const startsWithDigit = v => /^[\s$]*-?\d/.test(String(v||''));
  return [...rows].sort((a,b)=>{
    const va = a[key], vb = b[key];
    const aE = (va == null || va === ''), bE = (vb == null || vb === '');
    if (aE && bE) return 0;
    if (aE) return 1; if (bE) return -1;
    if (isDate) {
      const ma = dateToMs(va), mb = dateToMs(vb);
      if (ma === 0 && mb === 0) return 0;
      if (ma === 0) return 1; if (mb === 0) return -1;
      return (ma - mb) * dir;
    }
    if (isNum) {
      const an = parseFloat(va), bn = parseFloat(vb);
      if (isNaN(an) && isNaN(bn)) return 0;
      if (isNaN(an)) return 1; if (isNaN(bn)) return -1;
      return (an - bn) * dir;
    }
    if (!s.k) {
      const ad = startsWithDigit(va), bd = startsWithDigit(vb);
      if (ad !== bd) return ad ? 1 : -1;
    }
    const an = parseFloat(va), bn = parseFloat(vb);
    if (!isNaN(an) && !isNaN(bn) && /^-?\d+(\.\d+)?$/.test(String(va).trim()) && /^-?\d+(\.\d+)?$/.test(String(vb).trim())) {
      return (an - bn) * dir;
    }
    return String(va).toLowerCase().localeCompare(String(vb).toLowerCase(), undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
}
function kjrMatchSearch(needle, ...vals){
  if (!needle) return true;
  const n = needle.toLowerCase();
  return vals.some(v => String(v||'').toLowerCase().includes(n));
}

// ─── UNIVERSAL SEARCH ─────────────────────────────────────────────────
// Multi-token "AND" search across every meaningful field in a row.
// Supports:
//   "raw" / "psa 10" / "english"        - text fields
//   "50"  / "50.5"                       - any numeric field within ±$1
//   ">50" / "<100" / ">=20"              - numeric comparators on price fields
//   "may"  / "2025"                      - date fields
//   "in stock" / "received"              - status fields
//   "raw 50"                             - multi-token (BOTH must match)
const _SEARCH_FIELDS = {
  singles:        ['name','set','language','type','condition','status','notes','datePurchased'],
  slabs:          ['name','grader','grade','certNo','rank','language','status','notes','dateListed'],
  sales:          ['product','buyer','dateSold','margin'],
  etbs:           ['product','status','condition','date','notes'],
  boosterBoxes:   ['product','status','date','notes'],
  boosterPacks:   ['product','status','date','notes'],
  ebayPurchases:  ['product','status','tracking','declared','date','targetTable']
};
const _SEARCH_NUMS = {
  singles:        ['costPrice','marketPrice','listPrice','qty','priceAlert'],
  slabs:          ['costPrice','marketPrice','listPrice','priceAlert','grade'],
  sales:          ['costPrice','totalCollected','shippingCost','profit'],
  etbs:           ['totalPrice','marketPrice'],
  boosterBoxes:   ['unitPrice','totalPrice','marketPrice','qty'],
  boosterPacks:   ['unitPrice','totalPrice','marketPrice','qty'],
  ebayPurchases:  ['priceUsd','freightSgd','totalSgd']
};
const _DATE_FIELDS = new Set(['date','dateListed','datePurchased','dateSold','receivedAt']);

function _matchOneToken(token, row, table){
  if (!token) return true;
  const t = token.trim().toLowerCase();
  if (!t) return true;
  // Comparator on numeric fields:  >50, <100, >=20, <=10
  const cmp = t.match(/^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (cmp) {
    const op = cmp[1], v = parseFloat(cmp[2]);
    const nums = _SEARCH_NUMS[table] || [];
    return nums.some(k => {
      const x = parseFloat(row[k]);
      if (isNaN(x)) return false;
      if (op === '>')  return x >  v;
      if (op === '<')  return x <  v;
      if (op === '>=') return x >= v;
      if (op === '<=') return x <= v;
      return false;
    });
  }
  // Pure numeric: match ±$1 on any numeric field, OR exact for qty/grade
  if (/^-?\d+(?:\.\d+)?$/.test(t)) {
    const v = parseFloat(t);
    const nums = _SEARCH_NUMS[table] || [];
    if (nums.some(k => {
      const x = parseFloat(row[k]);
      return !isNaN(x) && Math.abs(x - v) < 1.0;
    })) return true;
    // Also try as a date day-of-month (matches "19" against any date col)
    const dateF = (_SEARCH_FIELDS[table] || []).filter(f => _DATE_FIELDS.has(f));
    if (dateF.some(f => kjrMatchDateFilter(t, row[f]))) return true;
    return false;
  }
  // Date-ish queries (e.g. "may", "2025", "may 2025", "5/2025")
  const looksLikeDate = /^([a-z]{3,9}|\d{4}|\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?)$|^([a-z]{3,9}\s+\d{4})$/i.test(t);
  if (looksLikeDate) {
    const dateF = (_SEARCH_FIELDS[table] || []).filter(f => _DATE_FIELDS.has(f));
    if (dateF.some(f => kjrMatchDateFilter(t, row[f]))) return true;
    // Don't `return false` here - still allow text fields to match e.g. "may"
    // against a card name.
  }
  // Text fields: substring match on lowercased field value.
  const text = (_SEARCH_FIELDS[table] || []);
  for (const k of text) {
    if (String(row[k]||'').toLowerCase().includes(t)) return true;
  }
  return false;
}

// ── Per-column numeric filter. Supports:
//   ""          → match all (filter empty)
//   "100"       → exact-ish: |val - 100| < 1
//   ">100"      → greater-than (also >=, <, <=)
//   "100-200"   → inclusive range
//   "$100"      → leading $ stripped automatically
// Designed for the Cost / Market / List column filter inputs in inventory
// tables. Returns true if the row's numeric value matches the filter.
function kjrMatchNumFilter(filter, val){
  const f = String(filter == null ? '' : filter).trim().replace(/^\$+/, '');
  if (!f) return true;
  const x = parseFloat(val);
  if (isNaN(x)) return false; // empty market price ≠ matches any filter
  // Range: 100-200 (inclusive)
  const r = f.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$/);
  if (r) {
    const a = parseFloat(r[1]), b = parseFloat(r[2]);
    const lo = Math.min(a,b), hi = Math.max(a,b);
    return x >= lo && x <= hi;
  }
  // Comparator: >100, >=100, <100, <=100
  const c = f.match(/^(>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (c) {
    const op = c[1], v = parseFloat(c[2]);
    if (op === '>')  return x >  v;
    if (op === '<')  return x <  v;
    if (op === '>=') return x >= v;
    if (op === '<=') return x <= v;
  }
  // Bare number: ±$1 (matches the universal-search behaviour, so users get
  // consistent "feels close" matching across both filter surfaces).
  const v = parseFloat(f);
  if (isNaN(v)) return false;
  return Math.abs(x - v) < 1.0;
}

function kjrMatchUniversal(query, row, table){
  if (!query) return true;
  const tokens = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  // Try whole-string match first (handles "in stock" / "near mint" / "psa 10"
  // as a single phrase, not two AND'd tokens).
  if (_matchOneToken(query, row, table)) return true;
  return tokens.every(tok => _matchOneToken(tok, row, table));
}
function kjrMatchFilter(filter, val){
  if (!filter) return true;
  return String(val||'').toLowerCase().includes(filter.toLowerCase());
}
// Date-aware filter: searches a normalised "D MMM YYYY" representation so
// typing "May" / "2025" / "19 May" / "May 2025" / "5/2025" all work, instead
// of dumb substring matching against whatever raw format the row stored.
function kjrMatchDateFilter(filter, val){
  if (!filter) return true;
  const f = filter.toString().trim().toLowerCase();
  if (!f) return true;
  const canon = toDateMmmYyyy(val).toLowerCase();      // "19 may 2025"
  if (canon.includes(f)) return true;
  // Full month name → 3-letter abbreviation ("august" → "aug", "feb." → "feb").
  // _monthIdxFromString fuzzy-matches typos too.
  const monthIdx = typeof _monthIdxFromString === 'function' ? _monthIdxFromString(f) : -1;
  if (monthIdx >= 0 && canon.includes(MONTHS_LOWER[monthIdx])) return true;
  // "august 2025" / "august-2025" → "aug 2025"
  let m = f.match(/^([a-z]+)[\s\-]+(\d{4})$/);
  if (m) {
    const mi = typeof _monthIdxFromString === 'function' ? _monthIdxFromString(m[1]) : -1;
    if (mi >= 0 && canon.includes(MONTHS_LOWER[mi] + ' ' + m[2])) return true;
  }
  // "5/2025" or "05-2025" → "may 2025"
  m = f.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const mi = parseInt(m[1],10) - 1;
    if (mi >= 0 && mi < 12) return canon.includes(MONTHS_LOWER[mi] + ' ' + m[2]);
  }
  // Numeric month/day. "05" without a year → "may"; or day-of-month.
  m = f.match(/^(\d{1,2})$/);
  if (m) {
    const n = parseInt(m[1],10);
    if (n >= 1 && n <= 12 && canon.includes(MONTHS_LOWER[n-1])) return true;
    if (canon.startsWith(n + ' ')) return true;
  }
  // Year-only: "2025"
  if (/^\d{4}$/.test(f) && canon.endsWith(' ' + f)) return true;
  return false;
}
function _v(id){ const el = document.getElementById(id); return el ? el.value.trim() : ''; }

// ═════════════ Modal CRUD ═════════════
let _kjrModalCtx = null;
function kjrOpenModal(ctx){
  _kjrModalCtx = ctx;
  document.getElementById('kjr-modal-title').textContent = (ctx.isNew?'Add ':'Edit ') + ctx.singular;
  document.getElementById('kjr-modal-fields').innerHTML = ctx.fields.map(f => {
    const v = f.type === 'date' ? toIsoDateStr(ctx.item[f.key] || '') : (ctx.item[f.key] || '');
    if (f.type === 'select') {
      return '<label class="lbl">'+kjrEscape(f.label)+'</label><select class="fi" data-k="'+f.key+'">' +
        f.options.map(o => '<option value="'+kjrEscape(o)+'"'+(o===v?' selected':'')+'>'+kjrEscape(o||'-')+'</option>').join('') +
        '</select>';
    }
    if (f.type === 'textarea') {
      return '<label class="lbl">'+kjrEscape(f.label)+'</label><textarea class="fi" data-k="'+f.key+'" rows="2">'+kjrEscape(v)+'</textarea>';
    }
    return '<label class="lbl">'+kjrEscape(f.label)+'</label><input class="fi" data-k="'+f.key+'" type="'+(f.type||'text')+'" value="'+kjrEscape(v)+'">';
  }).join('');
  kjrModalCtrl.open(document.getElementById('kjr-modal-back'));
}
function kjrCloseModal(){ kjrModalCtrl.close(document.getElementById('kjr-modal-back')); _kjrModalCtx = null; }
function kjrSaveModal(){
  if (!_kjrModalCtx) return;
  const { dbKey, item, isNew, after } = _kjrModalCtx;
  // Snapshot for undo BEFORE mutating so Ctrl-Z can recover edits to
  // ETBs / Booster Boxes / Booster Packs / eBay rows (was missing - only
  // add-paths got undo coverage, edits did not).
  if (typeof snapshotForUndo === 'function') snapshotForUndo();
  // Resolve to the actual DB row for edits (the row's JSON was inlined into the
  // onclick handler, so `item` is a *clone*, not a reference). Without this,
  // edits to ETBs / Booster Boxes / eBay Purchases silently no-op.
  const target = isNew ? item : (DB[dbKey].find(r => r.id === item.id) || item);
  // Snapshot the row BEFORE we mutate so we can diff against it for the
  // changelog entry. (Was logging an empty extra string before.)
  const beforeKjr = isNew ? null : { ...target };
  document.querySelectorAll('#kjr-modal-fields [data-k]').forEach(el => { target[el.dataset.k] = el.value.trim(); });
  // Run through the unified normalizer so manual entries match table format
  // (numbers stored as numbers, dates as "D MMM YYYY", grader uppercase…).
  if (typeof normalizeRecord === 'function') {
    const norm = normalizeRecord(dbKey, target);
    Object.assign(target, norm);
  }
  // For eBay rows, also persist the live SGD computation if the user didn't
  // manually override - keeps the table totalSgd in sync with USD×rate+freight.
  // A manual override is persisted onto the row itself (totalSgdManual) so
  // later inline edits (freight/price) know not to clobber it - see
  // kjrEbayInlineEdit, which is the only other totalSgd write path.
  if (dbKey === 'ebayPurchases' && typeof kjrEbayComputeSgd === 'function') {
    const userSetSgd = !!_kjrEbUserEditedSgd;
    if (userSetSgd) {
      target.totalSgdManual = true;
    } else {
      target.totalSgdManual = false; // explicit "use auto-calc" reset clears any prior manual flag
      const c = kjrEbayComputeSgd(target.priceUsd, target.freightSgd, '');
      if (c.computed > 0) target.totalSgd = c.computed;
    }
  }
  if (isNew) {
    DB[dbKey].push(target);
    if (typeof _pinRecentlyAdded === 'function') _pinRecentlyAdded(dbKey, target.id);
  }
  markDirty(dbKey, target.id);
  saveData();
  const extraKjr = isNew
    ? _clSummary(dbKey, target)
    : (_clDiff(dbKey, beforeKjr, target) || 'no field changes');
  clLog(isNew ? 'add' : 'edit', dbKey, target.product || target.name || target.id, extraKjr);
  kjrCloseModal();
  if (after) after();
}
async function kjrDeleteRow(dbKey, id){
  const idx = DB[dbKey].findIndex(r => r.id === id);
  if (idx < 0) return;
  const row = DB[dbKey][idx];
  const label = row.product || row.name || row.tracking || id;
  // Unified deletion: ETB / Booster Box / Booster Pack / eBay rows now go to
  // Trash like Singles/Slabs/Sales. Recoverable from the Trash tab for 30
  // days; previously was a hard delete only recoverable via Ctrl-Z before
  // the next reload.
  if (!await kjrConfirm('Move "' + esc(label) + '" to trash? You can restore it within 30 days from the Trash tab.', {ok:'Move to trash', danger:true})) return;
  snapshotForUndo && snapshotForUndo();
  const deletedSnapshot = { ...row };
  DB[dbKey].splice(idx, 1);
  _dirty[dbKey] && _dirty[dbKey].delete(id);
  saveData();
  if (dbKey === 'etbs') renderEtbs();
  else if (dbKey === 'boosterBoxes') renderBoosterBoxes();
  else if (dbKey === 'boosterPacks' && typeof renderBoosterPacks === 'function') renderBoosterPacks();
  else if (dbKey === 'ebayPurchases') renderEbayPurchases();
  if (typeof renderDashboard === 'function') renderDashboard();
  if (typeof clLog === 'function') clLog('delete', dbKey, label, _clSummary(dbKey, deletedSnapshot));
  if (typeof toast === 'function') toast('Moved to trash · view in 🗑 tab');
  // Background: write to trash + delete from Supabase. sendToTrash stores
  // originalTable=dbKey which restoreFromTrash already handles via _tblName.
  const sbTable = (typeof _tblName === 'function') ? _tblName(dbKey) : dbKey;
  Promise.all([
    (typeof sendToTrash === 'function') ? sendToTrash(dbKey, deletedSnapshot, 'single') : Promise.resolve(),
    (typeof sbDelete    === 'function') ? sbDelete(sbTable, id)                          : Promise.resolve()
  ]).catch(e => {
    if (typeof setSyncStatus === 'function') setSyncStatus('error', 'Delete sync failed: ' + (e && e.message || e));
    console.error('kjrDeleteRow background sync failed:', e);
  });
}

// ═════════════ Export TSV (consistent with the Import format) ═════════════
function kjrExportTsv(dbKey){
  const rows = DB[dbKey] || [];
  if (!rows.length) { toast && toast('Nothing to export'); return; }
  const cols = rows.reduce((set, r) => { Object.keys(r).forEach(k => k !== 'id' && set.add(k)); return set; }, new Set());
  const colList = [...cols];
  const lines = [colList.join('\t')];
  rows.forEach(r => lines.push(colList.map(c => String(r[c]==null?'':r[c]).replace(/[\t\n]/g, ' ')).join('\t')));
  const blob = new Blob([lines.join('\n')], { type: 'text/tab-separated-values' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = dbKey + '_' + new Date().toISOString().slice(0,10) + '.tsv';
  a.click(); URL.revokeObjectURL(url);
}

// ═════════════ ETBs ═════════════
const KJR_ETB_FIELDS = [
  { key:'status',      label:'Status',       type:'select', options:['In Stock','Sold','Traded'] },
  { key:'product',     label:'Product',      type:'text' },
  { key:'totalPrice',  label:'Cost Price',   type:'number' },
  { key:'marketPrice', label:'Market Price', type:'number' },
  { key:'condition',   label:'Condition',    type:'select', options:['Mint','Dented','Damaged','Sealed'] },
  { key:'date',        label:'Date',         type:'date' },
];
function kjrOpenEtbModal(idOrItem){
  const isNew = !idOrItem;
  // Edit buttons pass the row id (not the row JSON, which broke on fields
  // containing '&#39;' when inlined into an onclick attribute) - resolve to
  // the live DB record here. A plain object is still accepted defensively.
  let item;
  if (isNew) item = { id: kjrId('etb'), status:'In Stock', condition:'Mint', date:new Date().toISOString().slice(0,10) };
  else if (typeof idOrItem === 'string') item = (DB.etbs || []).find(r => r.id === idOrItem) || { id: idOrItem };
  else item = idOrItem;
  kjrOpenModal({ dbKey:'etbs', singular:'ETB', fields:KJR_ETB_FIELDS, item, isNew, after:renderEtbs });
}
// Shared helpers for kjr Available/Sold sectioning so every kjr-style tab
// (ETBs / Booster Boxes / Booster Packs / eBay) renders with the same
// Available-first → collapsed "Sold" section UX as Singles / Slabs.
const _kjrSoldOpen = {}; // { etbs:true, boosterBoxes:false, ... }
function kjrIsActiveStatus(table, status){
  const s = (status||'').toLowerCase();
  if (table === 'etbs')          return s === 'in stock';
  if (table === 'boosterBoxes')  return /unopened|reserved/.test(s);
  if (table === 'boosterPacks')  return /sealed|reserved/.test(s);
  // eBay "active" = anywhere along the pipeline EXCEPT the terminal states
  // Completed (already delivered/pushed) and Cancelled. "Received" (exact,
  // legacy pre-migration value) is also terminal, but only an EXACT match -
  // "Partially Received" is still mid-pipeline and must stay active, so this
  // must NOT be a bare substring test against "received".
  if (table === 'ebayPurchases') return !/^completed$|^cancelled$|^received$/.test(s);
  return s !== 'sold' && s !== 'traded';
}
function kjrToggleSoldSection(table){
  _kjrSoldOpen[table] = !_kjrSoldOpen[table];
  if (table === 'etbs') renderEtbs();
  else if (table === 'boosterBoxes') renderBoosterBoxes();
  else if (table === 'boosterPacks') renderBoosterPacks();
  else if (table === 'ebayPurchases') renderEbayPurchases();
}
function kjrSoldToggleRow(table, soldCount, colspan){
  if (soldCount === 0) return '';
  const open = !!_kjrSoldOpen[table];
  const label = table === 'ebayPurchases' ? 'Completed' : 'Sold / Traded';
  return `<tr class="kjr-sold-divider"><td colspan="${colspan}" style="padding:0">
    <button class="sold-section-toggle" onclick="kjrToggleSoldSection('${table}')">
      <span>${open ? '▼' : '▶'}</span><span>${open ? 'Hide' : 'Show'} ${label}</span>
      <span class="sold-count-badge">${soldCount}</span>
    </button>
  </td></tr>`;
}

function renderEtbs(){
  const rows = DB.etbs || [];
  const q = _v('kjr-etb-search'), statF = _v('kjr-etb-status'), condF = _v('kjr-etb-cond');
  const cfProd = _v('kjr-etb-cf-product'), cfCond = _v('kjr-etb-cf-cond'), cfDate = _v('kjr-etb-cf-date');
  // Numeric col filters - value as-typed; kjrMatchNumFilter handles the syntax.
  const cfCost = _v('kjr-etb-cf-cost'), cfMkt = _v('kjr-etb-cf-mkt'), cfList = _v('kjr-etb-cf-list');
  const filtered = rows.filter(r =>
    kjrMatchUniversal(q, r, 'etbs') &&
    (!statF || r.status === statF) && (!condF || r.condition === condF) &&
    kjrMatchFilter(cfProd, r.product) && kjrMatchFilter(cfCond, r.condition) && kjrMatchDateFilter(cfDate, r.date) &&
    kjrMatchNumFilter(cfCost, r.totalPrice) && kjrMatchNumFilter(cfMkt, r.marketPrice) && kjrMatchNumFilter(cfList, r.carousellPrice)
  );
  // Default sort: alphabetical A→Z by product. User-picked column sort
  // takes over via kjrApplySort which honours the _DEFAULT_SORT key when
  // _kjrSort.etbs.k is null.
  const sortFn = (list) => kjrApplySort(list, 'etbs');
  // Split into active (In Stock) and inactive (Sold / Traded) so we render
  // the same Available-first → collapsed Sold layout as Singles/Slabs.
  const inStock = _pinRecentsToTop(sortFn(filtered.filter(r => kjrIsActiveStatus('etbs', r.status))), 'etbs');
  const inactive = sortFn(filtered.filter(r => !kjrIsActiveStatus('etbs', r.status)));

  // Stats use only In Stock so sold/traded don't inflate exposure totals.
  const totalCost   = inStock.reduce((s,r) => s + kjrNum(r.totalPrice), 0);
  // Market Value must never substitute cost when marketPrice is unset (Julian:
  // "leave it blank and not corrupt the data by giving the cost price"). Sum
  // over priced rows only, matching the zero-fallback convention renderSingles
  // uses for its own Market Price stat card.
  const pricedEtbs  = inStock.filter(r => kjrNum(r.marketPrice) > 0);
  const totalMarket = pricedEtbs.reduce((s,r) => s + kjrNum(r.marketPrice), 0);
  // Profit compares priced rows' own market against their own cost only - never
  // partial market against full cost across the whole In-Stock set.
  const pricedCost  = pricedEtbs.reduce((s,r) => s + kjrNum(r.totalPrice), 0);
  const profit      = totalMarket - pricedCost;
  const profitSign  = profit >= 0 ? '+' : '';
  const pricedCaption = inStock.length > 0 && pricedEtbs.length < inStock.length
    ? '<div style="font-size:10px;color:var(--text3);margin-top:2px">' + pricedEtbs.length + ' of ' + inStock.length + ' priced</div>' : '';
  // Condition split - Mint vs everything else
  const cnd = c => (c||'').toString().trim().toLowerCase();
  const mintCount = inStock.filter(r => cnd(r.condition) === 'mint').length;
  const otherCnd  = inStock.length - mintCount;
  const condPct = n => inStock.length > 0 ? Math.round((n / inStock.length) * 100) : 0;
  const condCard = inStock.length === 0
    ? kjrStatCard('Condition Split', '-')
    : `<div class="inv-stat" title="Mint vs other conditions among In-Stock ETBs">
        <div class="inv-stat-label">Condition Split</div>
        <div class="inv-split-bar">
          ${mintCount ? `<div class="inv-split-raw" style="width:${condPct(mintCount)}%" title="Mint · ${mintCount} (${condPct(mintCount)}%)">${condPct(mintCount) >= 30 ? 'Mint ' + condPct(mintCount) + '%' : condPct(mintCount) >= 10 ? condPct(mintCount) + '%' : ''}</div>` : ''}
          ${otherCnd  ? `<div class="inv-split-sealed" style="width:${condPct(otherCnd)}%" title="Other · ${otherCnd} (${condPct(otherCnd)}%)">${condPct(otherCnd) >= 30 ? 'Other ' + condPct(otherCnd) + '%' : condPct(otherCnd) >= 10 ? condPct(otherCnd) + '%' : ''}</div>` : ''}
        </div>
        <div class="inv-split-legend">
          <span><span class="inv-split-dot inv-split-dot-raw"></span>Mint ${mintCount}</span>
          <span><span class="inv-split-dot inv-split-dot-sealed"></span>Other ${otherCnd}</span>
        </div>
      </div>`;
  document.getElementById('kjr-etb-stats').innerHTML =
    kjrStatCard('Total Cost',   kjrFmt(totalCost) || 'S$0') +
    kjrStatCard('Market Value', (pricedEtbs.length > 0 ? kjrFmt(totalMarket) || 'S$0' : '-') + pricedCaption) +
    kjrStatCard('Available',    inStock.length) +
    condCard;

  const rowHtml = (r, sold) => '<tr' + (sold ? ' class="sold-row"' : '') + '>' +
    '<td data-col-key="status">'+kjrPill(r.status)+'</td>' +
    '<td data-col-key="product" style="text-align:left">'+kjrEscape(r.product)+'</td>' +
    '<td data-col-key="totalPrice" class="num">'+kjrFmt(r.totalPrice)+'</td>' +
    // Inline-editable market price. Blur or Enter writes through updateField,
    // which routes through markDirty + price-history + cloud sync. Same UX as
    // the Singles/Slabs tabs.
    '<td data-col-key="marketPrice" class="num"><input class="kjr-inline" style="width:80px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px;text-align:right" value="'+kjrEscape(kjrNum(r.marketPrice) > 0 ? '$'+Math.round(kjrNum(r.marketPrice)) : '')+'" placeholder="-" onchange="updateField(\'etbs\',\''+kjrEscape(r.id)+'\',\'marketPrice\',kjrMoneyStr(this.value))"></td>' +
    '<td data-col-key="carousellPrice" class="num"><input class="kjr-inline" style="width:80px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px;text-align:right" value="'+kjrEscape(kjrNum(r.carousellPrice) > 0 ? '$'+Math.round(kjrNum(r.carousellPrice)) : '')+'" placeholder="-" onchange="updateField(\'etbs\',\''+kjrEscape(r.id)+'\',\'carousellPrice\',kjrMoneyStr(this.value))"></td>' +
    '<td data-col-key="condition">'+kjrEscape(r.condition||'')+'</td>' +
    '<td data-col-key="date">'+kjrEscape(toDateMmmYyyy(r.date)||'')+'</td>' +
    '<td data-col-key="actions"><span class="kjr-row-actions">' +
      '<button class="btn btn-ghost btn-sm" onclick="kjrOpenEtbModal(\''+kjrEscape(r.id)+'\')">Edit</button>' +
      '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="kjrDeleteRow(\'etbs\',\''+kjrEscape(r.id)+'\')">×</button>' +
    '</span></td>' +
    '</tr>';

  let body = inStock.map(r => rowHtml(r, false)).join('');
  if (inStock.length === 0 && inactive.length === 0) {
    body = kjrInvEmptyRow(rows.length > 0
      ? { colspan: 8, filtered: true }
      : { colspan: 8, filtered: false, icon: '📦', title: 'No ETBs yet',
          sub: 'Track Elite Trainer Boxes here, cost, market and Carousell price side by side.',
          ctaLabel: '+ Add ETB', ctaAction: 'kjrOpenEtbModal()' });
  } else if (inStock.length === 0) {
    body = '<tr><td colspan="8" style="color:var(--text3);padding:18px;text-align:center">No In-Stock ETBs.</td></tr>';
  }
  body += kjrSoldToggleRow('etbs', inactive.length, 8);
  if (_kjrSoldOpen.etbs) body += inactive.map(r => rowHtml(r, true)).join('');
  document.getElementById('kjr-etb-body').innerHTML = body;
  // Apply saved column order + wire header drag for this table
  if (typeof _kjrColApply === 'function')  _kjrColApply('etbs');
  if (typeof _kjrColAttach === 'function') _kjrColAttach('etbs');
}

// ═════════════ Booster Boxes ═════════════
const KJR_BB_FIELDS = [
  { key:'date',       label:'Date',         type:'date' },
  { key:'product',    label:'Product',      type:'text' },
  { key:'unitPrice',  label:'Unit Price',   type:'number' },
  { key:'qty',        label:'Quantity',     type:'number' },
  { key:'totalPrice', label:'Total Price',  type:'number' },
  { key:'status',     label:'Status',       type:'select', options:['Unopened Stock','Opened','Sold','Reserved'] },
  { key:'notes',      label:'Notes',        type:'textarea' },
];
function kjrOpenBbModal(idOrItem){
  const isNew = !idOrItem;
  // Edit buttons pass the row id (not the row JSON, which broke on fields
  // containing '&#39;' when inlined into an onclick attribute) - resolve to
  // the live DB record here. A plain object is still accepted defensively.
  let item;
  if (isNew) item = { id: kjrId('bb'), status:'Unopened Stock', date:new Date().toISOString().slice(0,10), qty:1 };
  else if (typeof idOrItem === 'string') item = (DB.boosterBoxes || []).find(r => r.id === idOrItem) || { id: idOrItem };
  else item = idOrItem;
  kjrOpenModal({ dbKey:'boosterBoxes', singular:'Booster Box', fields:KJR_BB_FIELDS, item, isNew, after:renderBoosterBoxes });
}
function renderBoosterBoxes(){
  const rows = DB.boosterBoxes || [];
  const q = _v('kjr-bb-search'), statF = _v('kjr-bb-status');
  const cfDate = _v('kjr-bb-cf-date'), cfProd = _v('kjr-bb-cf-product'), cfNotes = _v('kjr-bb-cf-notes');
  const cfUnit = _v('kjr-bb-cf-unit'), cfQty = _v('kjr-bb-cf-qty'), cfTotal = _v('kjr-bb-cf-total');
  const cfMkt  = _v('kjr-bb-cf-mkt'),  cfList = _v('kjr-bb-cf-list');
  const filtered = rows.filter(r =>
    kjrMatchUniversal(q, r, 'boosterBoxes') &&
    (!statF || r.status === statF) &&
    kjrMatchDateFilter(cfDate, r.date) && kjrMatchFilter(cfProd, r.product) && kjrMatchFilter(cfNotes, r.notes) &&
    kjrMatchNumFilter(cfUnit, r.unitPrice) && kjrMatchNumFilter(cfQty, r.qty) && kjrMatchNumFilter(cfTotal, r.totalPrice) &&
    kjrMatchNumFilter(cfMkt, r.marketPrice) && kjrMatchNumFilter(cfList, r.carousellPrice)
  );
  const sorted = kjrApplySort(filtered, 'boosterBoxes');
  // Active = Unopened Stock / Reserved (still on hand). Inactive = Opened / Sold.
  const active   = _pinRecentsToTop(sorted.filter(r => kjrIsActiveStatus('boosterBoxes', r.status)), 'boosterBoxes');
  const inactive = sorted.filter(r => !kjrIsActiveStatus('boosterBoxes', r.status));
  const stock = active.filter(r => /unopened/.test((r.status||'').toLowerCase()));
  const sealedVal = stock.reduce((s,r) => s + kjrNum(r.totalPrice), 0);
  const totalQty  = stock.reduce((s,r) => s + (kjrNum(r.qty)||1), 0);
  // Unopened vs Opened/Sold split within the active filter
  const opened = active.filter(r => !/unopened/.test((r.status||'').toLowerCase())).length;
  const splitTotal = stock.length + opened;
  const sealedPct = splitTotal > 0 ? Math.round((stock.length / splitTotal) * 100) : 0;
  const openedPct = 100 - sealedPct;
  const splitCard = splitTotal === 0
    ? kjrStatCard('Status Split', '-')
    : `<div class="inv-stat" title="Sealed vs Opened split among current Booster Box rows">
        <div class="inv-stat-label">Status Split</div>
        <div class="inv-split-bar">
          ${stock.length ? `<div class="inv-split-raw" style="width:${sealedPct}%" title="Sealed · ${stock.length} (${sealedPct}%)">${sealedPct >= 30 ? 'Sealed ' + sealedPct + '%' : sealedPct >= 10 ? sealedPct + '%' : ''}</div>` : ''}
          ${opened      ? `<div class="inv-split-sealed" style="width:${openedPct}%" title="Opened/Other · ${opened} (${openedPct}%)">${openedPct >= 30 ? 'Other ' + openedPct + '%' : openedPct >= 10 ? openedPct + '%' : ''}</div>` : ''}
        </div>
        <div class="inv-split-legend">
          <span><span class="inv-split-dot inv-split-dot-raw"></span>Sealed ${stock.length}</span>
          <span><span class="inv-split-dot inv-split-dot-sealed"></span>Other ${opened}</span>
        </div>
      </div>`;
  document.getElementById('kjr-bb-stats').innerHTML =
    kjrStatCard('Total Cost', kjrFmt(sealedVal) || 'S$0') +
    kjrStatCard('Sealed Units', totalQty.toString()) +
    kjrStatCard('Unopened Lots', stock.length) +
    splitCard;
  const rowHtml = (r, sold) => '<tr' + (sold ? ' class="sold-row"' : '') + '>' +
    '<td data-col-key="date">'+kjrEscape(toDateMmmYyyy(r.date)||'')+'</td>' +
    '<td data-col-key="product" style="text-align:left">'+kjrEscape(r.product||'')+'</td>' +
    '<td data-col-key="unitPrice" class="num">'+kjrFmt(r.unitPrice)+'</td>' +
    '<td data-col-key="qty" class="num">'+kjrEscape(r.qty||'')+'</td>' +
    '<td data-col-key="totalPrice" class="num">'+kjrFmt(r.totalPrice)+'</td>' +
    // Inline market + carousell price - same UX as Singles/Slabs/ETBs.
    '<td data-col-key="marketPrice" class="num"><input class="kjr-inline" style="width:80px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px;text-align:right" value="'+kjrEscape(kjrNum(r.marketPrice) > 0 ? '$'+Math.round(kjrNum(r.marketPrice)) : '')+'" placeholder="-" onchange="updateField(\'boosterBoxes\',\''+kjrEscape(r.id)+'\',\'marketPrice\',kjrMoneyStr(this.value))"></td>' +
    '<td data-col-key="carousellPrice" class="num"><input class="kjr-inline" style="width:80px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px;text-align:right" value="'+kjrEscape(kjrNum(r.carousellPrice) > 0 ? '$'+Math.round(kjrNum(r.carousellPrice)) : '')+'" placeholder="-" onchange="updateField(\'boosterBoxes\',\''+kjrEscape(r.id)+'\',\'carousellPrice\',kjrMoneyStr(this.value))"></td>' +
    '<td data-col-key="status">'+kjrPill(r.status)+'</td>' +
    '<td data-col-key="notes" style="text-align:left;color:var(--text2);font-size:12px">'+kjrEscape(r.notes||'')+'</td>' +
    '<td data-col-key="actions"><span class="kjr-row-actions">' +
      '<button class="btn btn-ghost btn-sm" onclick="kjrOpenBbModal(\''+kjrEscape(r.id)+'\')">Edit</button>' +
      '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="kjrDeleteRow(\'boosterBoxes\',\''+kjrEscape(r.id)+'\')">×</button>' +
    '</span></td>' +
    '</tr>';
  let body = active.map(r => rowHtml(r, false)).join('');
  if (active.length === 0 && inactive.length === 0) {
    body = kjrInvEmptyRow(rows.length > 0
      ? { colspan: 10, filtered: true }
      : { colspan: 10, filtered: false, icon: '📦', title: 'No Booster Boxes yet',
          sub: 'Track sealed Booster Boxes here, cost, market and Carousell price side by side.',
          ctaLabel: '+ Add Booster Box', ctaAction: 'kjrOpenBbModal()' });
  } else if (active.length === 0) {
    body = '<tr><td colspan="10" style="color:var(--text3);padding:18px;text-align:center">No unopened booster boxes.</td></tr>';
  }
  body += kjrSoldToggleRow('boosterBoxes', inactive.length, 10);
  if (_kjrSoldOpen.boosterBoxes) body += inactive.map(r => rowHtml(r, true)).join('');
  document.getElementById('kjr-bb-body').innerHTML = body;
  if (typeof _kjrColApply === 'function')  _kjrColApply('boosterBoxes');
  if (typeof _kjrColAttach === 'function') _kjrColAttach('boosterBoxes');
}

// ═════════════ eBay Purchases ═════════════
// eBay purchase pipeline - the END state is "Completed" which triggers a
// confirmation modal to push the row(s) into inventory. "Cancelled" is a
// terminal off-pipeline state.
const KJR_EBAY_STATUSES = ['Paid','Shipping to Buyandship','At Buyandship','Ready to Consolidate','Shipping to Singapore','Completed','Cancelled'];
// Order used for "Move to next status" - Cancelled is excluded (terminal).
const KJR_EBAY_PIPELINE = ['Paid','Shipping to Buyandship','At Buyandship','Ready to Consolidate','Shipping to Singapore','Completed'];

// One-time migration: bring legacy status values into the new pipeline.
// Old "Ordered" → "Paid" (the buyer paid; eBay considers it ordered).
// Old "Received" → "Completed" + _historical so the row won't trigger the
// inventory-push modal (these are already in the inventory tables).
(function migrateEbayStatuses(){
  const flag = 'pokeinv_ebay_status_migration_v1';
  if (localStorage.getItem(flag)) return;
  let changed = 0;
  (DB.ebayPurchases || []).forEach(r => {
    // Case-insensitive exact match so legacy imports like "received" or
    // "COMPLETED" (not just the exact-cased "Received"/"Completed") are
    // caught too - matches kjrIsActiveStatus's own case-insensitive check.
    if (/^ordered$/i.test(r.status || '')) { r.status = 'Paid'; markDirty('ebayPurchases', r.id); changed++; }
    if (/^received$/i.test(r.status || '') || /^completed$/i.test(r.status || '')) {
      // Existing rows already classified as completed/received are historical
      // - already counted in inventory. Mark them so the completion modal
      // doesn't re-prompt for them, and standardise on "Completed".
      r.status = 'Completed';
      r._historical = true;
      markDirty('ebayPurchases', r.id);
      changed++;
    }
  });
  if (changed) saveData();
  localStorage.setItem(flag, '1');
})();

// Compute Total SGD = USD × current rate + Freight SGD.
// `totalSgdOverride` (manual entry that differs from the auto value) is
// honoured if the user typed a number themselves.
function kjrEbayComputeSgd(priceUsd, freightSgd, overrideSgd){
  const usd = kjrNum(priceUsd);
  const frt = kjrNum(freightSgd);
  const rate = (typeof _sgdRate === 'number' && _sgdRate > 0) ? _sgdRate : 1.27;
  const computed = +(usd * rate + frt).toFixed(2);
  if (overrideSgd !== '' && overrideSgd != null && !isNaN(parseFloat(overrideSgd))) {
    return { computed, used: parseFloat(overrideSgd), rate, overridden: true };
  }
  return { computed, used: computed, rate, overridden: false };
}

// Legacy data may have stored Buyandship freight under a different key name
// (e.g. `freight`, `shippingFee`, `buyandship`, `bshFreight`, …) because the
// CSV they imported from used those headers. This scan moves any such value
// into the canonical `freightSgd` field so the table actually shows it.
const _FREIGHT_ALT_KEYS = [
  'freight','shipping','shippingFee','shippingFees','shippingCost','shippingSgd',
  'buyandship','buyandshipFreight','buyandshipCost','buyandshipShipping',
  'bsh','bshFreight','bshCost','bshShipping','bs','bsFreight','bsCost',
  'freightSg','freightCost','handling','handlingFee','postage','postageSgd',
  'cost','costbuyandship','costBuyandship','freightprice','freightPrice'
];
function kjrEbayBackfillFreight(){
  let changed = 0;
  (DB.ebayPurchases || []).forEach(r => {
    if (kjrNum(r.freightSgd) > 0) return; // already populated, skip
    for (const k of _FREIGHT_ALT_KEYS) {
      if (r[k] != null && r[k] !== '' && kjrNum(r[k]) > 0) {
        r.freightSgd = kjrNum(r[k]);
        markDirty('ebayPurchases', r.id);
        changed++;
        break;
      }
    }
  });
  if (changed && typeof saveData === 'function') saveData();
  return changed;
}

// Backfill: for any existing eBay row missing totalSgd, fill it from
// USD × rate + freight. Doesn't mark dirty unless something actually changes.
function kjrEbayBackfillTotals(){
  let changed = 0;
  (DB.ebayPurchases || []).forEach(r => {
    if ((r.totalSgd === '' || r.totalSgd == null || kjrNum(r.totalSgd) === 0) && (kjrNum(r.priceUsd) > 0 || kjrNum(r.freightSgd) > 0)) {
      const calc = kjrEbayComputeSgd(r.priceUsd, r.freightSgd, '');
      r.totalSgd = calc.computed;
      markDirty('ebayPurchases', r.id);
      changed++;
    }
  });
  if (changed) { saveData(); if (typeof toast === 'function') toast('Backfilled SGD totals on ' + changed + ' row(s)'); }
  return changed;
}

// ── Date helpers for the eBay edit modal ─────────────────────────────────
// Records are normalised to "D MMM YYYY" by normalizeRecord (e.g. "16 May 2026"),
// but <input type="date"> only renders ISO "YYYY-MM-DD". Without this round-trip
// the date field appears blank every time you re-open the edit modal.
function _kjrDateToIso(val){
  if (!val) return '';
  const s = String(val).trim();
  if (!s) return '';
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(s)) {
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    return m[1] + '-' + String(+m[2]).padStart(2,'0') + '-' + String(+m[3]).padStart(2,'0');
  }
  const m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (m && typeof _monthIdxFromString === 'function') {
    const mi = _monthIdxFromString(m[2]);
    if (mi >= 0) return m[3] + '-' + String(mi+1).padStart(2,'0') + '-' + String(+m[1]).padStart(2,'0');
  }
  return '';
}

// ── Auto-detect target inventory table from product string ───────────────
// Mirrors Quick Entry: parseSmartLine handles slab vs single, and we layer
// ETB / Booster Box / Pack keyword detection on top. Used by both the eBay
// modal's product input (auto-set "When received, push into…") and the
// kjrOpenCompleteModal pre-population step.
function kjrDetectTargetTable(productStr){
  const s = String(productStr || '').trim();
  if (!s) return '';
  // Sealed product keywords win over single-card detection. Order matters:
  // "booster pack" must beat "pack" inside "package", etc.
  if (/\betb\b|elite\s*trainer\s*box/i.test(s)) return 'etbs';
  if (/\bbooster\s*box\b/i.test(s))             return 'boosterBoxes';
  if (/\bbooster\s*pack\b/i.test(s))            return 'boosterPacks';
  if (typeof parseSmartLine === 'function') {
    const parsed = parseSmartLine(s);
    if (parsed && parsed.type === 'slab') return 'slabs';
  }
  return 'singles';
}

// ── Multi-item product parser ────────────────────────────────────────────
// Splits a Product string like "Jirachi XY67a $82.95 and Gyarados 21 $20"
// or a newline-separated list into individual {name, usdPrice} items.
// Returns [] when only 0–1 items have a $ amount (we treat that as a
// single-item transaction - no proportional splitting needed).
function kjrParseMultiItemProduct(text){
  const raw = String(text || '').trim();
  if (!raw) return [];
  const chunks = raw
    .split(/\s+and\s+|\s*[,;]\s*|\s*\+\s*|\s*\/\s*|\n+/i)
    .map(c => c.trim())
    .filter(Boolean);
  if (chunks.length < 2) return [];
  const items = chunks.map(chunk => {
    // Prefer a trailing $ amount; fall back to the first $ anywhere in the chunk.
    let m = chunk.match(/\$\s*([\d]+(?:\.\d{1,2})?)\s*(?:usd)?\s*$/i);
    if (!m) m = chunk.match(/\$\s*([\d]+(?:\.\d{1,2})?)/);
    let usdPrice = 0, name = chunk;
    if (m) {
      usdPrice = parseFloat(m[1]) || 0;
      name = chunk.slice(0, m.index).trim() + ' ' + chunk.slice(m.index + m[0].length).trim();
      name = name.replace(/[\s\-–,]+$/g,'').replace(/^[\s\-–,]+/g,'').trim();
    }
    return { name, usdPrice };
  });
  // Multi-item detection requires ≥2 chunks with an explicit USD price.
  if (items.filter(i => i.usdPrice > 0).length < 2) return [];
  return items;
}

function kjrOpenEbayModal(idOrItem){
  const isNew = !idOrItem;
  // Edit buttons pass the row id (not the row JSON, which broke on fields
  // containing '&#39;' when inlined into an onclick attribute). A plain
  // object is still accepted defensively (e.g. any future caller).
  let item;
  if (isNew) item = { id: kjrId('eb'), status:'Paid', date:new Date().toISOString().slice(0,10), declared:'No' };
  else if (typeof idOrItem === 'string') item = { id: idOrItem };
  else item = idOrItem;
  // Resolve to the live DB record on edit so changes persist.
  const target = isNew ? item : (DB.ebayPurchases.find(r => r.id === item.id) || item);
  _kjrModalCtx = { dbKey:'ebayPurchases', singular:'Purchase', item: target, isNew, after: renderEbayPurchases };
  document.getElementById('kjr-modal-title').textContent = (isNew ? 'Add ' : 'Edit ') + 'Purchase';
  const rate = (typeof _sgdRate === 'number' && _sgdRate > 0) ? _sgdRate.toFixed(4) : '1.2700';
  const statusOpts = KJR_EBAY_STATUSES.map(s => `<option value="${s}" ${s===(target.status||'')?'selected':''}>${s}</option>`).join('');
  const declaredOpts = ['','Yes','No','N/A'].map(s => `<option value="${s}" ${s===(target.declared||'')?'selected':''}>${s||'-'}</option>`).join('');
  const targetLabels = { '':'', singles:'Singles', slabs:'Slabs', etbs:'ETBs', boosterBoxes:'Booster Boxes', boosterPacks:'Booster Packs' };
  const targetOpts = Object.keys(targetLabels).map(s => `<option value="${s}" ${s===(target.targetTable||'')?'selected':''}>${targetLabels[s]}</option>`).join('');
  // Track whether the user has manually picked a target. Once they have,
  // auto-detection stops fighting them.
  _kjrEbUserPickedTarget = !!(target.targetTable);
  // Convert stored "D MMM YYYY" → "YYYY-MM-DD" so the date input populates.
  const dateIso = _kjrDateToIso(target.date) || new Date().toISOString().slice(0,10);
  // Field blocks. Status and Freight only show when editing an existing
  // purchase - a new purchase sets status via the pipeline and freight inline
  // in the table, so the Add form stays to the essentials.
  const fDate = `
      <div class="form-group">
        <label class="lbl">Date</label>
        <input class="fi" data-k="date" type="date" value="${kjrEscape(dateIso)}">
      </div>`;
  const fStatus = `
      <div class="form-group">
        <label class="lbl">Status</label>
        <select class="fi" data-k="status">${statusOpts}</select>
      </div>`;
  const fProduct = `
      <div class="form-group full">
        <label class="lbl">Product <span style="font-weight:400;color:var(--text3);font-size:10px;text-transform:none;letter-spacing:0">Separate with "and", or add line spacing per card</span></label>
        <textarea class="fi" data-k="product" id="kjr-eb-product" rows="2" placeholder="Card Name" oninput="kjrEbayAutoTarget()" style="resize:vertical;min-height:38px;font-family:inherit">${kjrEscape(target.product||'')}</textarea>
      </div>`;
  const fTracking = `
      <div class="form-group">
        <label class="lbl">Tracking #</label>
        <input class="fi" data-k="tracking" type="text" value="${kjrEscape(target.tracking||'')}">
      </div>`;
  const fDeclared = `
      <div class="form-group">
        <label class="lbl">Declared on Buyandship?</label>
        <select class="fi" data-k="declared">${declaredOpts}</select>
      </div>`;
  const fPriceUsd = `
      <div class="form-group">
        <label class="lbl">Price (USD)</label>
        <input class="fi" data-k="priceUsd" id="kjr-eb-usd" type="number" step="0.01" min="0" inputmode="decimal" value="${kjrEscape(target.priceUsd||'')}" placeholder="0.00" oninput="kjrEbayRecalc()">
      </div>`;
  const fFreight = `
      <div class="form-group">
        <label class="lbl">Buyandship Freight (SGD)</label>
        <input class="fi" data-k="freightSgd" id="kjr-eb-frt" type="number" step="0.01" min="0" inputmode="decimal" value="${kjrEscape(target.freightSgd||'')}" placeholder="0.00" oninput="kjrEbayRecalc()">
      </div>`;
  const fTotal = `
      <div class="form-group full">
        <label class="lbl" style="display:flex;align-items:center;gap:8px">
          Total (SGD)
          <span id="kjr-eb-rate-chip" style="font-size:10px;font-weight:500;color:var(--text3);text-transform:none;letter-spacing:0">USD:SGD ${rate}</span>
          <a id="kjr-eb-reset" style="font-size:10px;color:var(--accent);cursor:pointer;text-transform:none;letter-spacing:0;display:none;margin-left:auto" onclick="kjrEbayResetTotal()">↺ use auto-calc</a>
        </label>
        <input class="fi" data-k="totalSgd" id="kjr-eb-sgd" type="number" step="0.01" min="0" inputmode="decimal" value="${kjrEscape(target.totalSgd||'')}" oninput="kjrEbayUserEditedSgd()">
      </div>`;
  const fPush = `
      <div class="form-group full">
        <label class="lbl">When received, push into <span id="kjr-eb-target-hint" style="font-weight:400;color:var(--text3);font-size:10px;text-transform:none;letter-spacing:0"></span></label>
        <select class="fi" data-k="targetTable" id="kjr-eb-target" onchange="kjrEbayUserPickedTarget()">${targetOpts}</select>
      </div>`;
  const fields = isNew
    ? fDate + fDeclared + fProduct + fTracking + fPriceUsd + fTotal + fPush
    : fDate + fStatus + fProduct + fTracking + fDeclared + fPriceUsd + fFreight + fTotal + fPush;
  document.getElementById('kjr-modal-fields').innerHTML = `<div class="form-grid">${fields}</div>`;
  kjrModalCtrl.open(document.getElementById('kjr-modal-back'));
  // Prefer the persisted per-row flag (set by this fix's save path onward) so
  // an unrelated edit (date, tracking, status...) doesn't silently re-stamp
  // totalSgdManual on a row whose total was only ever auto-computed. Rows
  // saved before this change carry no totalSgdManual, so they fall back to
  // the old presence-of-total heuristic to preserve their existing behaviour.
  _kjrEbUserEditedSgd = (target.totalSgdManual !== undefined) ? !!target.totalSgdManual : !!(target.totalSgd && target.totalSgd !== '');
  kjrEbayRecalc(); // initial render of breakdown
  // Run auto-detection once on open so a freshly-typed (or pre-filled) product
  // populates the target field. Respects an existing user pick (above flag).
  kjrEbayAutoTarget();
}

// Track whether the user has manually overridden the auto-computed SGD total.
let _kjrEbUserEditedSgd = false;
// Track whether the user has manually picked a target inventory table. Once
// they have, auto-detect stops overwriting their choice on every keystroke.
let _kjrEbUserPickedTarget = false;
function kjrEbayUserPickedTarget(){ _kjrEbUserPickedTarget = true; }
function kjrEbayAutoTarget(){
  if (_kjrEbUserPickedTarget) return;
  const prodEl = document.getElementById('kjr-eb-product');
  const tgtEl  = document.getElementById('kjr-eb-target');
  const hintEl = document.getElementById('kjr-eb-target-hint');
  if (!prodEl || !tgtEl) return;
  const productStr = prodEl.value || '';
  // Multi-item lines route to a mixed bag - the per-item table is decided
  // later in the complete modal, so we just flag the user and clear the
  // top-level target.
  const multi = kjrParseMultiItemProduct(productStr);
  if (multi.length >= 2) {
    tgtEl.value = '';
    if (hintEl) hintEl.textContent = '- ' + multi.length + ' items detected, target set per-item on push-to-complete';
    return;
  }
  // Never clobber an existing non-empty selection (auto-detected earlier, or
  // picked by the user without triggering onchange e.g. programmatically) -
  // only auto-fill while the field is still blank.
  if (tgtEl.value) return;
  const detected = kjrDetectTargetTable(productStr);
  if (detected) {
    tgtEl.value = detected;
    if (hintEl) hintEl.textContent = '- auto-detected from product';
  }
}
function kjrEbayUserEditedSgd(){
  _kjrEbUserEditedSgd = true;
  document.getElementById('kjr-eb-reset').style.display = 'inline';
  kjrEbayRecalc();
}
function kjrEbayResetTotal(){
  _kjrEbUserEditedSgd = false;
  document.getElementById('kjr-eb-sgd').value = '';
  document.getElementById('kjr-eb-reset').style.display = 'none';
  kjrEbayRecalc();
}
function kjrEbayRecalc(){
  const usdEl = document.getElementById('kjr-eb-usd');
  const frtEl = document.getElementById('kjr-eb-frt');
  const sgdEl = document.getElementById('kjr-eb-sgd');
  const bdEl  = document.getElementById('kjr-eb-breakdown');
  if (!usdEl || !sgdEl) return;
  const frtVal = frtEl ? frtEl.value : '';
  const calc = kjrEbayComputeSgd(usdEl.value, frtVal, '');
  if (!_kjrEbUserEditedSgd) {
    sgdEl.value = calc.computed > 0 ? Math.round(calc.computed) : '';
  }
  const usd = kjrNum(usdEl.value), frt = kjrNum(frtVal);
  const usdInSgd = +(usd * calc.rate).toFixed(2);
  if (bdEl) bdEl.innerHTML =
    `US$${Math.round(usd)} × ${calc.rate.toFixed(4)} = S$${Math.round(usdInSgd)}` +
    `  +  S$${Math.round(frt)} freight` +
    `  =  <strong style="color:var(--text)">S$${Math.round(calc.computed)}</strong>` +
    (_kjrEbUserEditedSgd ? '<br><span style="color:var(--amber)">⚠ Total SGD manually overridden - click ↺ to revert.</span>' : '');
}
function renderEbayPurchases(){
  // Auto-backfill any rows missing totalSgd before computing stats so the
  // "SGD All-In" total is correct even for legacy data.
  kjrEbayBackfillTotals();
  kjrEbayBackfillFreight && kjrEbayBackfillFreight();
  const rows = DB.ebayPurchases || [];
  const q = _v('kjr-ebay-search'), statF = _v('kjr-ebay-status');
  const cfDate = _v('kjr-ebay-cf-date'), cfTrack = _v('kjr-ebay-cf-tracking'), cfProd = _v('kjr-ebay-cf-product');
  const cfUsd = _v('kjr-ebay-cf-usd'), cfFreight = _v('kjr-ebay-cf-freight'), cfSgd = _v('kjr-ebay-cf-sgd');
  const filtered = rows.filter(r =>
    kjrMatchUniversal(q, r, 'ebayPurchases') &&
    (!statF || r.status === statF) &&
    kjrMatchDateFilter(cfDate, r.date) && kjrMatchFilter(cfTrack, r.tracking) && kjrMatchFilter(cfProd, r.product) &&
    kjrMatchNumFilter(cfUsd, r.priceUsd) && kjrMatchNumFilter(cfFreight, r.freightSgd) && kjrMatchNumFilter(cfSgd, r.totalSgd)
  );
  const sorted = kjrApplySort(filtered, 'ebayPurchases');
  // Stat cards are deliberately GLOBAL - they summarise the whole pipeline,
  // not just what the search/column filters currently narrow the table to.
  // Both "Transit Exposure" and "Shipment Count" and the pipeline breakdown
  // below all derive from this same unfiltered active set so the cards never
  // disagree with each other while the user is filtering the table.
  const allActive = (DB.ebayPurchases || []).filter(r => !['Completed','Cancelled'].includes(r.status));
  // Resolve each row's effective SGD total - uses stored value if present,
  // otherwise the computed USD×rate + freight fallback.
  const effectiveSgd = r => kjrNum(r.totalSgd) > 0 ? kjrNum(r.totalSgd) : kjrEbayComputeSgd(r.priceUsd, r.freightSgd, '').computed;
  const sgdInTransitGlobal = allActive.reduce((s,r) => s + effectiveSgd(r), 0);
  // Pipeline breakdown card - one row per active stage, with a dot indicator
  const ACTIVE_STAGES = KJR_EBAY_PIPELINE.filter(s => s !== 'Completed');
  const SHORT_LABELS = {'Paid':'Paid','Shipping to Buyandship':'→ BaS','At Buyandship':'At BaS','Ready to Consolidate':'Consol.','Shipping to Singapore':'→ SG','Completed':'Done'};
  const pipelineSteps = ACTIVE_STAGES.map((step, i) => {
    const cnt = allActive.filter(r => r.status === step).length;
    const active = cnt > 0;
    const bg    = active ? 'var(--accent)' : 'transparent';
    const border= active ? 'var(--accent)' : 'var(--border2)';
    const txtCol= active ? '#fff' : 'var(--text3)';
    const conn  = i > 0 ? `<div style="flex:1;height:2px;background:${allActive.filter(r=>KJR_EBAY_PIPELINE.indexOf(r.status)>=i).length>0&&allActive.filter(r=>KJR_EBAY_PIPELINE.indexOf(r.status)>=i-1).length>0?'var(--accent)':'var(--border2)'};margin-bottom:18px;min-width:6px"></div>` : '';
    const dot   = `<div style="width:24px;height:24px;border-radius:50%;background:${bg};border:2px solid ${border};color:${txtCol};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0">${active ? cnt : ''}</div>`;
    const lbl   = `<div style="font-size:11px;color:${active?'var(--text2)':'var(--text3)'};text-align:center;white-space:nowrap;margin-top:4px;font-weight:${active?600:400}">${SHORT_LABELS[step]||step}</div>`;
    return conn + `<div style="display:flex;flex-direction:column;align-items:center;flex-shrink:0">${dot}${lbl}</div>`;
  }).join('');
  const pipelineCard = `<div class="inv-stat" style="min-width:280px"><div class="inv-stat-label" style="margin-bottom:10px">Pipeline</div><div style="display:flex;align-items:center;width:100%">${pipelineSteps || '<div style="color:var(--text3);font-size:11px">All clear</div>'}</div></div>`;
  document.getElementById('kjr-ebay-stats').innerHTML =
    kjrStatCard('Transit Exposure', 'S$'+Math.round(sgdInTransitGlobal), 'Total SGD value of shipments not yet Completed or Cancelled') +
    kjrStatCard('Shipment Count', allActive.length, 'Number of shipments not yet Completed or Cancelled') +
    pipelineCard;
  const active   = _pinRecentsToTop(sorted.filter(r => kjrIsActiveStatus('ebayPurchases', r.status)), 'ebayPurchases');
  const inactive = sorted.filter(r => !kjrIsActiveStatus('ebayPurchases', r.status));
  const rowHtml = (r, sold) => {
    const isCompleted = (r.status||'').toLowerCase() === 'completed';
    const isCancelled = (r.status||'').toLowerCase() === 'cancelled';
    // Status is advanced by clicking the pipeline dots below - no per-row
    // push button in the Actions column.

    // ── Pipeline timeline component ──
    // Six little dots, one per status. Filled & teal up to and including the
    // current step; outline for everything ahead. Click any dot to jump the
    // row directly to that status (faster than the bulk button for one-offs).
    const curIdx = kjrEbayPipelineIndex(r.status);
    // Price pill rides the right edge of the status-label row (mobile only -
    // see .eb-tl-price / .eb-tl-labelrow CSS). Desktop already has its own
    // priceUsd column, so this is purely a mobile-card affordance.
    const priceSpan = kjrNum(r.priceUsd) > 0 ? '<span class="eb-tl-price">US$' + Math.round(kjrNum(r.priceUsd)) + '</span>' : '';
    const timeline = isCancelled
      ? '<div class="eb-tl-cancel">- Cancelled -</div>'
      : '<div class="eb-tl" title="Click any step to jump this row directly to it">' +
        KJR_EBAY_PIPELINE.map((step, i) => {
          const cls = i < curIdx ? 'eb-tl-done' : (i === curIdx ? 'eb-tl-now' : 'eb-tl-todo');
          const conn = i > 0 ? '<span class="eb-tl-conn ' + (i <= curIdx ? 'eb-tl-conn-done' : '') + '"></span>' : '';
          return conn +
            '<button class="eb-tl-dot ' + cls + '" onclick="kjrEbaySetStatus(\''+kjrEscape(r.id)+'\',\''+step.replace(/'/g,"\\'")+'\')" title="' + step + '">' +
              (i === curIdx ? '●' : (i < curIdx ? '✓' : '')) +
            '</button>';
        }).join('') +
        '</div><div class="eb-tl-labelrow"><div class="eb-tl-label">' + kjrEscape(r.status || 'Unknown') + '</div>' + priceSpan + '</div>';

    const storedSgd = kjrNum(r.totalSgd);
    const sgdCell = storedSgd > 0
      ? '<td class="num" data-col-key="totalSgd">' + kjrFmt(r.totalSgd) + '</td>'
      : (kjrNum(r.priceUsd) > 0 || kjrNum(r.freightSgd) > 0
          ? '<td class="num" data-col-key="totalSgd" style="color:var(--text3)" title="Auto: USD×rate + freight (saved on edit)">~$' + Math.round(kjrEbayComputeSgd(r.priceUsd, r.freightSgd, '').computed) + '</td>'
          : '<td class="num" data-col-key="totalSgd">-</td>');

    // Last Updated cell - manual-sync indicator. Renders "5d ago" with a
    // tooltip showing the absolute time, and an amber dot when older than
    // 3 days so stale rows visually flag themselves.
    const updatedCell = (() => {
      const ts = r.lastUpdated || 0;
      if (!ts) return '<td class="num" data-col-key="lastUpdated" style="color:var(--text3);font-size:11px" title="Never synced">never</td>';
      const ms = Date.now() - ts;
      const days = Math.floor(ms / 86400000);
      const hours = Math.floor(ms / 3600000);
      let label;
      if (days >= 1) label = days + 'd ago';
      else if (hours >= 1) label = hours + 'h ago';
      else label = Math.max(1, Math.floor(ms/60000)) + 'm ago';
      const stale = days >= 3 && !isCompleted && !isCancelled;
      const dot = stale ? '<span style="color:var(--amber);margin-right:3px">●</span>' : '';
      const abs = new Date(ts).toLocaleString('en-GB',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
      return '<td class="num" data-col-key="lastUpdated" style="font-size:11px;color:' + (stale ? 'var(--amber)' : 'var(--text3)') + '" title="Last sync: ' + abs + (stale ? ' - older than 3 days, consider re-checking Buyandship' : '') + '">' + dot + label + '</td>';
    })();

    // Declared on Buyandship cell - clickable to cycle Yes → No → N/A → Yes.
    const declVal = (r.declared || '').trim();
    const declCol = declVal === 'No' ? 'var(--amber)' : (declVal === 'Yes' ? 'var(--text2)' : 'var(--text3)');
    const declaredCell = '<td data-col-key="declared" style="text-align:center;font-size:11px;color:' + declCol + ';cursor:pointer" title="Click to toggle declared status" onclick="kjrToggleDeclared(\'' + kjrEscape(r.id) + '\')">' + kjrEscape(declVal || '-') + '</td>';

    const isSel = _kjrEbaySel.has(r.id);
    return '<tr data-id="' + kjrEscape(r.id) + '"' + (sold ? ' class="sold-row"' : '') + (isSel ? ' style="background:var(--accent-soft)"' : '') + '>' +
      '<td data-col-key="_cb" class="cb-col"><input type="checkbox" class="row-cb" ' + (isSel ? 'checked' : '') + ' onchange="kjrEbayToggleRow(\''+kjrEscape(r.id)+'\',this.checked)"></td>' +
      '<td data-col-key="date">'+kjrEscape(toDateMmmYyyy(r.date)||'')+'</td>' +
      '<td data-col-key="product">' +
        kjrEscape(r.product||'') +
        '<div class="eb-mobile-meta">' +
          (r.tracking ? '<button class="eb-meta-track-chip" onclick="kjrCopyTracking(this,\''+kjrEscape(r.tracking).replace(/'/g,'&#39;')+'\')" title="Copy: '+kjrEscape(r.tracking)+'">#'+kjrEscape(String(r.tracking).slice(-4))+'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" style="opacity:0.6;margin-left:2px;flex-shrink:0"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' : '') +
          '<button class="eb-meta-decl-pill" style="color:'+declCol+';border-color:'+(declVal==='No'?'var(--amber)':declVal==='Yes'?'var(--green)':'var(--border)')+'" onclick="kjrToggleDeclared(\''+kjrEscape(r.id)+'\')">'+kjrEscape(declVal||'-')+'</button>' +
        '</div>' +
      '</td>' +
      '<td data-col-key="status" style="min-width:260px">'+timeline+'</td>' +
      '<td class="num" data-col-key="tracking" style="font-size:11px;color:var(--text3)">' + (r.tracking ? '<span style="display:inline-flex;align-items:center;gap:4px;white-space:nowrap">' + kjrEscape(r.tracking) + '<button class="btn-copy-track" onclick="kjrCopyTracking(this,\''+kjrEscape(r.tracking).replace(/'/g,'&#39;')+'\')" title="Copy tracking number"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button></span>' : '') + '</td>' +
      declaredCell +
      '<td class="num" data-col-key="priceUsd">'+fmtUsd(r.priceUsd)+'</td>' +
      '<td class="num" data-col-key="freightSgd">' +
        '<input class="kjr-inline-input" type="number" step="0.01" min="0" value="' + (kjrNum(r.freightSgd) > 0 ? Math.round(kjrNum(r.freightSgd)) : '') + '" placeholder="-" onchange="kjrEbayInlineEdit(\''+kjrEscape(r.id)+'\',\'freightSgd\',this.value)">' +
      '</td>' +
      sgdCell +
      updatedCell +
      '<td data-col-key="actions" style="white-space:nowrap"><span class="kjr-row-actions" style="display:inline-flex;align-items:center;gap:4px">' +
        '<button class="btn btn-ghost btn-sm" onclick="kjrOpenEbayModal(\''+kjrEscape(r.id)+'\')">Edit</button>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="kjrDeleteRow(\'ebayPurchases\',\''+kjrEscape(r.id)+'\')">×</button>' +
      '</span></td>' +
      '</tr>';
  };
  let body = active.map(r => rowHtml(r, false)).join('');
  if (active.length === 0 && inactive.length === 0) {
    body = kjrInvEmptyRow(rows.length > 0
      ? { colspan: 11, filtered: true }
      : { colspan: 11, filtered: false, icon: '📮', title: 'No eBay purchases yet',
          sub: 'Track eBay buys through the Buyandship pipeline, from Paid to Completed.',
          ctaLabel: '+ Add Purchase', ctaAction: 'kjrOpenEbayModal()' });
  } else if (active.length === 0) {
    body = '<tr><td colspan="11" style="color:var(--text3);padding:18px;text-align:center">Nothing in transit - all received or cancelled.</td></tr>';
  }
  body += kjrSoldToggleRow('ebayPurchases', inactive.length, 11);
  if (_kjrSoldOpen.ebayPurchases) body += inactive.map(r => rowHtml(r, true)).join('');
  document.getElementById('kjr-ebay-body').innerHTML = body;
  _kjrEbayUpdateBulkBar();
  _kjrApplyEbayColVisibility();
  if (typeof _kjrApplyEbayColOrder === 'function') _kjrApplyEbayColOrder();
  if (typeof _kjrEbayAttachHeaderDrag === 'function') _kjrEbayAttachHeaderDrag();
}

function kjrCopyTracking(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.5" width="13" height="13"><polyline points="20 6 9 17 4 12"/></svg>';
    setTimeout(() => { btn.innerHTML = orig; }, 1200);
    toast('Tracking number copied');
  });
}

function kjrToggleDeclared(id) {
  const row = (DB.ebayPurchases || []).find(r => r.id === id);
  if (!row) return;
  const cycle = { '': 'Yes', 'Yes': 'No', 'No': 'Yes', 'N/A': 'Yes' };
  const next = cycle[(row.declared || '')] || 'Yes';
  updateField('ebayPurchases', id, 'declared', next);
  renderEbayPurchases();
}

// ═════════════ eBay pipeline timeline (status dots) ═════════════
// Pure helpers used by the row builder. CSS lives in a one-shot style tag
// below so the visual matches the rest of the kjr-table look.
(function _injectEbayTimelineCss(){
  if (document.getElementById('eb-tl-style')) return;
  const s = document.createElement('style');
  s.id = 'eb-tl-style';
  s.textContent = `
    .eb-tl{display:inline-flex;align-items:center;gap:0}
    .eb-tl-dot{width:18px;height:18px;border-radius:50%;border:1.5px solid var(--border2);background:var(--bg2);color:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font-size:10px;line-height:1;padding:0;transition:transform 0.1s,background 0.15s,border-color 0.15s,color 0.15s}
    .eb-tl-dot:hover{transform:scale(1.18)}
    .eb-tl-dot.eb-tl-done{background:var(--accent);border-color:var(--accent);color:#fff}
    .eb-tl-dot.eb-tl-now{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
    .eb-tl-dot.eb-tl-todo{background:var(--bg3);border-color:var(--border2);color:transparent}
    .eb-tl-conn{display:inline-block;width:14px;height:2px;background:var(--border2);margin:0}
    .eb-tl-conn-done{background:var(--accent)}
    .eb-tl-label{font-size:10px;color:var(--text3);text-align:center;margin-top:3px;text-transform:none;font-weight:500;letter-spacing:0}
    .eb-tl-cancel{font-size:11px;color:var(--text3);font-style:italic;text-align:center}
    .btn-copy-track{background:none;border:none;cursor:pointer;padding:0 0 0 4px;font-size:12px;opacity:0.5;vertical-align:middle;line-height:1;transition:opacity 0.12s}
    .btn-copy-track:hover{opacity:1}
  `;
  document.head.appendChild(s);
})();

// Set a row's status to ANY pipeline step. Hitting "Completed" still opens
// the confirmation modal (no auto-push). Bumps lastUpdated so the freshness
// chip stays accurate.
function kjrEbaySetStatus(id, newStatus){
  const p = (DB.ebayPurchases||[]).find(r => r.id === id);
  if (!p) return;
  if (newStatus === 'Completed') return kjrOpenCompleteModal(id);
  p.status = newStatus;
  p.lastUpdated = Date.now();
  markDirty('ebayPurchases', p.id);
  saveData();
  renderEbayPurchases();
  toast && toast('Status: ' + newStatus);
}

// Recovery action for rows with unrecognised status values (e.g. legacy
// imports that didn't get migrated). Drops them back to the start of the
// pipeline so the user can advance from there.
async function kjrEbayResetToPaid(id){
  const p = (DB.ebayPurchases||[]).find(r => r.id === id);
  if (!p) return;
  if (!await kjrConfirm('Reset "'+ esc(p.product||p.tracking||p.id) +'" to "Paid"?\n\nIts current status "'+ esc(p.status||'(blank)') +'" isn\'t in the pipeline.', {ok:'Reset to Paid'})) return;
  p.status = 'Paid';
  p.lastUpdated = Date.now();
  markDirty('ebayPurchases', p.id);
  saveData();
  renderEbayPurchases();
}

// ═════════════ eBay inline edit / bulk select / column toggle ═════════════

// Set of selected eBay row IDs (lives only in memory; no need to persist).
const _kjrEbaySel = new Set();
function kjrEbayToggleRow(id, checked){
  if (checked) _kjrEbaySel.add(id); else _kjrEbaySel.delete(id);
  _kjrEbayUpdateBulkBar();
  document.querySelectorAll('#kjr-ebay-body tr[data-id="'+id+'"]').forEach(tr => {
    tr.style.background = checked ? 'var(--accent-soft)' : '';
  });
}
function kjrEbayToggleAll(checked){
  document.querySelectorAll('#kjr-ebay-body tr[data-id]').forEach(tr => {
    const id = tr.dataset.id;
    if (!id) return;
    if (checked) _kjrEbaySel.add(id); else _kjrEbaySel.delete(id);
    const cb = tr.querySelector('input.row-cb');
    if (cb) cb.checked = checked;
    tr.style.background = checked ? 'var(--accent-soft)' : '';
  });
  _kjrEbayUpdateBulkBar();
}
function kjrEbaySelectAllVisible(){ kjrEbayToggleAll(true); }
function kjrEbayClearSelection(){
  _kjrEbaySel.clear();
  const ck = document.getElementById('cb-all-ebay');
  if (ck) ck.checked = false;
  document.querySelectorAll('#kjr-ebay-body tr[data-id]').forEach(tr => {
    const cb = tr.querySelector('input.row-cb');
    if (cb) cb.checked = false;
    tr.style.background = '';
  });
  _kjrEbayUpdateBulkBar();
}
function _kjrEbayUpdateBulkBar(){
  const bar = document.getElementById('bulk-bar-ebay');
  const count = document.getElementById('bulk-count-ebay');
  if (!bar || !count) return;
  if (_kjrEbaySel.size > 0) { bar.classList.add('show'); count.textContent = _kjrEbaySel.size + ' selected'; }
  else { bar.classList.remove('show'); }
}
function kjrEbayBulkAdvanceSelected(){
  if (_kjrEbaySel.size === 0) { toast && toast('Nothing selected'); return; }
  const ids = [..._kjrEbaySel];
  _kjrEbaySel.clear();
  kjrEbayBulkAdvance(ids);
}

// Inline editing on the freight column. Saves immediately, marks dirty for
// cloud sync, recomputes the total SGD (so the next cell updates on next
// render), then re-renders the table.
function kjrEbayInlineEdit(id, field, value){
  const p = (DB.ebayPurchases || []).find(r => r.id === id);
  if (!p) return;
  const v = parseFloat(value);
  p[field] = isNaN(v) ? '' : v;
  // If the user is editing the total SGD field directly inline, that's an
  // explicit manual override - flag it so freight/price edits stop clobbering it.
  if (field === 'totalSgd') p.totalSgdManual = true;
  // Auto-recompute totalSgd from priceUsd + new freight, but never when the
  // user has set totalSgd manually (modal or inline), and never from a blank
  // freight (parseFloat('') is NaN, which would otherwise wipe the total).
  if (field === 'freightSgd' && !p.totalSgdManual && value !== '' && typeof kjrEbayComputeSgd === 'function') {
    const c = kjrEbayComputeSgd(p.priceUsd, p.freightSgd, '');
    if (c.computed > 0) p.totalSgd = c.computed;
  }
  p.lastUpdated = Date.now();
  markDirty('ebayPurchases', p.id);
  saveData();
  renderEbayPurchases();
}

// Column visibility - persisted to localStorage so it survives reloads.
const EBAY_COL_KEY = 'pokeinv_ebay_col_vis';
const EBAY_COL_LABELS = {
  date: 'Date', product: 'Product', status: 'Pipeline', tracking: 'Tracking',
  declared: 'Declared', priceUsd: 'USD', freightSgd: 'Freight', totalSgd: 'SGD All-In',
  lastUpdated: 'Updated', actions: 'Actions'
};
function _kjrEbayLoadColVis(){
  try { return Object.assign({}, JSON.parse(localStorage.getItem(EBAY_COL_KEY) || '{}')); } catch(e) { return {}; }
}
function _kjrEbaySaveColVis(map){
  try { localStorage.setItem(EBAY_COL_KEY, JSON.stringify(map)); } catch(e) {}
}
function _kjrApplyEbayColVisibility(){
  const vis = _kjrEbayLoadColVis();
  // _cb and actions are always visible. Apply hidden state to every cell.
  Object.keys(EBAY_COL_LABELS).forEach(key => {
    if (key === 'actions') return;
    const hide = vis[key] === false;
    document.querySelectorAll('#kjr-ebay-table [data-col-key="'+key+'"]').forEach(el => {
      el.style.display = hide ? 'none' : '';
    });
  });
}
function _kjrEbayBuildColMenu(){
  const dd = document.getElementById('ctd-ebay');
  if (!dd) return;
  const vis = _kjrEbayLoadColVis();
  const order = _kjrEbayLoadColOrder();
  // Render in the persisted order (not object-declaration order) so the ↑/↓
  // buttons and on-screen order agree; _cb and actions aren't toggleable here.
  const keys = order.filter(k => k !== 'actions' && k !== '_cb' && EBAY_COL_LABELS[k]);
  dd.innerHTML = keys.map((key, i) => {
    const label = EBAY_COL_LABELS[key];
    const shown = vis[key] !== false;
    return '<label class="col-toggle-item' + (shown ? ' checked' : '') + '">' +
      '<input type="checkbox" ' + (shown ? 'checked' : '') + ' onchange="kjrEbaySetColVisible(\''+key+'\',this.checked)">' +
      '<span style="flex:1">'+label+'</span>' +
      '<button type="button" class="btn btn-ghost btn-sm col-order-btn" style="padding:2px 6px;font-size:11px" title="Move up" onclick="event.stopPropagation();kjrEbayColMoveStep(\''+key+'\',-1)"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
      '<button type="button" class="btn btn-ghost btn-sm col-order-btn" style="padding:2px 6px;font-size:11px" title="Move down" onclick="event.stopPropagation();kjrEbayColMoveStep(\''+key+'\',1)"' + (i === keys.length-1 ? ' disabled' : '') + '>↓</button>' +
      '</label>';
  }).join('');
}
function kjrEbayToggleColMenu(){
  const wrap = document.getElementById('ctw-ebay');
  if (!wrap) return;
  // Close other column menus
  document.querySelectorAll('.col-toggle-wrap.open').forEach(w => { if (w !== wrap) w.classList.remove('open'); });
  wrap.classList.toggle('open');
  if (wrap.classList.contains('open')) _kjrEbayBuildColMenu();
}
kjrEbayToggleColMenu._rebuild = _kjrEbayBuildColMenu;
function kjrEbaySetColVisible(key, visible){
  const vis = _kjrEbayLoadColVis();
  vis[key] = !!visible;
  _kjrEbaySaveColVis(vis);
  _kjrApplyEbayColVisibility();
}
document.addEventListener('click', e => {
  if (!e.target.closest('#ctw-ebay')) {
    const w = document.getElementById('ctw-ebay');
    if (w) w.classList.remove('open');
  }
});

// ── Generic kjr-table column ORDER (drag-to-reorder) ───────────────────
// Used by ETBs / Booster Boxes / Booster Packs. Each table is referenced
// by its dbKey ('etbs' / 'boosterBoxes' / 'boosterPacks') and has:
//   • a <table id="…"> whose thead + tbody cells carry data-col-key="…"
//   • a default ordered list of keys (must match the keys in the markup)
//   • a set of locked keys that can't be reordered
// The order survives reloads via localStorage.
const _KJR_GENERIC_TABLES = {
  etbs:         { tableId: 'kjr-etb-table', lsKey: 'pokeinv_etbs_col_order',
                  defaultOrder: ['status','product','totalPrice','marketPrice','carousellPrice','condition','date','actions'],
                  locked: new Set(['actions']) },
  boosterBoxes: { tableId: 'kjr-bb-table',  lsKey: 'pokeinv_bb_col_order',
                  defaultOrder: ['date','product','unitPrice','qty','totalPrice','marketPrice','carousellPrice','status','notes','actions'],
                  locked: new Set(['actions']) },
  boosterPacks: { tableId: 'kjr-bp-table',  lsKey: 'pokeinv_bp_col_order',
                  defaultOrder: ['date','product','unitPrice','qty','totalPrice','status','notes','actions'],
                  locked: new Set(['actions']) },
};
function _kjrColLoad(tbl){
  const cfg = _KJR_GENERIC_TABLES[tbl]; if (!cfg) return [];
  try {
    const saved = JSON.parse(localStorage.getItem(cfg.lsKey) || 'null');
    if (!Array.isArray(saved)) return [...cfg.defaultOrder];
    // Graceful merge across schema changes (see initColOrder fix).
    const valid   = saved.filter(k => cfg.defaultOrder.includes(k));
    const missing = cfg.defaultOrder.filter(k => !valid.includes(k));
    return [...valid, ...missing];
  } catch(e) { return [...cfg.defaultOrder]; }
}
function _kjrColSave(tbl, order){
  const cfg = _KJR_GENERIC_TABLES[tbl]; if (!cfg) return;
  try { localStorage.setItem(cfg.lsKey, JSON.stringify(order)); } catch(e) {}
}
function _kjrColApply(tbl){
  const cfg = _KJR_GENERIC_TABLES[tbl]; if (!cfg) return;
  const tableEl = document.getElementById(cfg.tableId); if (!tableEl) return;
  const order = _kjrColLoad(tbl);
  tableEl.querySelectorAll('thead tr, tbody tr').forEach(row => {
    const cells = Array.from(row.cells);
    if (!cells.length) return;
    const byKey = {};
    cells.forEach(c => { if (c.dataset.colKey) byKey[c.dataset.colKey] = c; });
    const desired = order.filter(k => byKey[k]);
    if (!desired.length) return;
    // Skip if already in the right order (avoid disturbing focused inputs).
    const cur = cells.map(c => c.dataset.colKey).filter(k => order.includes(k));
    if (desired.join(',') === cur.join(',')) return;
    desired.forEach(k => row.appendChild(byKey[k]));
  });
}
// Reorder + persist for the generic kjr tables (ETB/BB/BP). Shared by the
// header drag-drop path and the tap up/down buttons in the Columns menu.
function _kjrColMove(tbl, fromKey, toKey){
  const cfg = _KJR_GENERIC_TABLES[tbl]; if (!cfg) return;
  if (fromKey === toKey || cfg.locked.has(fromKey) || cfg.locked.has(toKey)) return;
  const order = _kjrColLoad(tbl);
  const fi = order.indexOf(fromKey);
  if (fi < 0) return;
  order.splice(fi, 1);
  const ti = order.indexOf(toKey);
  if (ti < 0) return;
  order.splice(ti, 0, fromKey);
  _kjrColSave(tbl, order);
  _kjrColApply(tbl);
}
// Tap-based one-slot move, for touch users who can't drag. dir is -1 (up/left)
// or +1 (down/right) in column order.
function kjrColMoveStep(tbl, key, dir){
  // Splice the order directly rather than delegating to _kjrColMove: that
  // helper inserts BEFORE its target, which makes "move down one" a no-op
  // (remove key, insert before the element that just shifted into its slot).
  const cfg = _KJR_GENERIC_TABLES[tbl]; if (!cfg || cfg.locked.has(key)) return;
  const order = _kjrColLoad(tbl);
  const idx = order.indexOf(key);
  const t = idx + dir;
  if (idx < 0 || t < 0 || t >= order.length) return;
  if (cfg.locked.has(order[t])) return; // never hop across a locked column (actions stays last)
  order.splice(idx, 1);
  order.splice(t, 0, key);
  _kjrColSave(tbl, order);
  _kjrColApply(tbl);
  // Refresh the open Columns menu (if any) so the new order is reflected.
  if (typeof _kjrColBuildMenu === 'function') _kjrColBuildMenu(tbl);
}

// Columns dropdown for the generic kjr tables (ETBs / Booster Boxes / Packs).
// Reorder-only: visibility is handled by the responsive tiers, so unlike the
// Singles/Slabs/Sales menu there are no checkboxes, just up/down movers.
// Labels come from the live thead so they can never drift from the markup.
// Touch-first: this is the tap fallback the header drag-and-drop lacks.
function _kjrColBuildMenu(tbl){
  const cfg = _KJR_GENERIC_TABLES[tbl]; if (!cfg) return;
  const dd = document.getElementById('kjr-ctd-' + tbl); if (!dd) return;
  const tableEl = document.getElementById(cfg.tableId); if (!tableEl) return;
  const labels = {};
  // First header row only - the filter row beneath it also carries
  // data-col-key cells (for reorder alignment) but has no label text.
  tableEl.querySelectorAll('thead tr:first-child th[data-col-key]').forEach(th => { labels[th.dataset.colKey] = th.textContent.trim() || th.dataset.colKey; });
  const order = _kjrColLoad(tbl);
  dd.innerHTML = order.map(key => {
    const locked = cfg.locked.has(key);
    return '<div class="col-toggle-item">' +
      '<span style="flex:1">' + kjrEscape(labels[key] || key) + '</span>' +
      (locked ? '<span style="font-size:11px;color:var(--text3)">fixed</span>' :
        '<button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" title="Move up" onclick="event.stopPropagation();kjrColMoveStep(\'' + tbl + '\',\'' + key + '\',-1)">↑</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" style="padding:2px 8px;font-size:11px" title="Move down" onclick="event.stopPropagation();kjrColMoveStep(\'' + tbl + '\',\'' + key + '\',1)">↓</button>') +
      '</div>';
  }).join('');
}
function kjrToggleColMenu(tbl){
  const wrap = document.getElementById('kjr-ctw-' + tbl); if (!wrap) return;
  const opening = !wrap.classList.contains('open');
  document.querySelectorAll('.col-toggle-wrap.open').forEach(w => w.classList.remove('open'));
  if (opening) { _kjrColBuildMenu(tbl); wrap.classList.add('open'); }
}
function _kjrColAttach(tbl){
  const cfg = _KJR_GENERIC_TABLES[tbl]; if (!cfg) return;
  const tableEl = document.getElementById(cfg.tableId); if (!tableEl) return;
  const headerRow = tableEl.querySelector('thead tr:first-child');
  if (!headerRow) return;
  Array.from(headerRow.cells).forEach(th => {
    const key = th.dataset.colKey;
    if (!key || cfg.locked.has(key)) return;
    if (th._kjrColWired) return;
    th._kjrColWired = true;
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
      headerRow.querySelectorAll('th').forEach(el => el.classList.remove('col-drag-over'));
      const fromKey = e.dataTransfer.getData('text/plain');
      const toKey = th.dataset.colKey;
      _kjrColMove(tbl, fromKey, toKey);
    });
  });
}

// ── eBay column ORDER (drag-to-reorder) ────────────────────────────────
const EBAY_COL_ORDER_KEY = 'pokeinv_ebay_col_order';
const EBAY_DEFAULT_COL_ORDER = ['_cb','date','product','status','tracking','declared','priceUsd','freightSgd','totalSgd','lastUpdated','actions'];
function _kjrEbayLoadColOrder(){
  try {
    const saved = JSON.parse(localStorage.getItem(EBAY_COL_ORDER_KEY) || 'null');
    if (!Array.isArray(saved)) return [...EBAY_DEFAULT_COL_ORDER];
    // Same graceful merge as singles/slabs/sales: keep saved positions for
    // known keys, append any new ones at the end, drop stale ones. Avoids
    // wiping the user's saved order whenever a column is added to the
    // table (was an exact-superset check before).
    const valid   = saved.filter(k => EBAY_DEFAULT_COL_ORDER.includes(k));
    const missing = EBAY_DEFAULT_COL_ORDER.filter(k => !valid.includes(k));
    return [...valid, ...missing];
  } catch(e) {}
  return [...EBAY_DEFAULT_COL_ORDER];
}
function _kjrEbaySaveColOrder(order){
  try { localStorage.setItem(EBAY_COL_ORDER_KEY, JSON.stringify(order)); } catch(e) {}
}
function _kjrApplyEbayColOrder(){
  const tbl = document.getElementById('kjr-ebay-table');
  if (!tbl) return;
  const order = _kjrEbayLoadColOrder();
  tbl.querySelectorAll('thead tr, tbody tr').forEach(row => {
    const cells = Array.from(row.cells);
    if (!cells.length) return;
    const byKey = {};
    cells.forEach(c => { if (c.dataset.colKey) byKey[c.dataset.colKey] = c; });
    const ordered = order.filter(k => byKey[k]);
    // Only reorder if there's actual difference to avoid disrupting focused inputs
    const cur = cells.map(c => c.dataset.colKey).filter(k => order.includes(k));
    if (ordered.join(',') === cur.join(',')) return;
    ordered.forEach(k => row.appendChild(byKey[k]));
  });
}
// Reorder + persist for the eBay table. Shared by the header drag-drop path
// and the tap up/down buttons in the Columns menu.
function _kjrEbayColMove(fromKey, toKey){
  if (fromKey === toKey) return;
  const order = _kjrEbayLoadColOrder();
  const fi = order.indexOf(fromKey), ti = order.indexOf(toKey);
  if (fi < 0 || ti < 0) return;
  order.splice(fi, 1);
  const newTi = order.indexOf(toKey);
  order.splice(newTi, 0, fromKey);
  _kjrEbaySaveColOrder(order);
  _kjrApplyEbayColOrder();
}
// Tap-based one-slot move for touch users. dir is -1 (left/up) or +1 (right/down).
function kjrEbayColMoveStep(key, dir){
  const order = _kjrEbayLoadColOrder();
  const idx = order.indexOf(key);
  if (idx < 0) return;
  const targetIdx = idx + dir;
  if (targetIdx < 0 || targetIdx >= order.length) return;
  _kjrEbayColMove(key, order[targetIdx]);
  kjrEbayToggleColMenu._rebuild && kjrEbayToggleColMenu._rebuild();
}
function _kjrEbayAttachHeaderDrag(){
  const tbl = document.getElementById('kjr-ebay-table');
  if (!tbl) return;
  const headerRow = tbl.querySelector('thead tr:first-child');
  if (!headerRow) return;
  const LOCKED = new Set(['_cb','status','actions']);
  Array.from(headerRow.cells).forEach(th => {
    const key = th.dataset.colKey;
    if (!key || LOCKED.has(key)) return;
    // Skip if already wired (avoid duplicate listeners on re-render)
    if (th._ebayDragWired) return;
    th._ebayDragWired = true;
    th.classList.add('col-draggable');
    th.draggable = true;
    th.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', th.dataset.colKey);
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
      headerRow.querySelectorAll('th').forEach(el => el.classList.remove('col-drag-over'));
      const fromKey = e.dataTransfer.getData('text/plain');
      const toKey = th.dataset.colKey;
      _kjrEbayColMove(fromKey, toKey);
    });
  });
}

// CSS for the inline input - matches Singles/Slabs price inputs.
(function _kjrInjectInlineCss(){
  if (document.getElementById('kjr-inline-style')) return;
  const s = document.createElement('style');
  s.id = 'kjr-inline-style';
  s.textContent = '.kjr-inline-input{width:70px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px;text-align:center;padding:2px 4px;border-radius:3px}.kjr-inline-input:focus{outline:none;background:var(--bg3);border:1px solid var(--accent)}.kjr-inline-input::-webkit-outer-spin-button,.kjr-inline-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}.kjr-inline-input[type=number]{-moz-appearance:textfield}';
  document.head.appendChild(s);
})();

// ═════════════ Recently-added pinning (cross-table) ═════════════
// When a row is added (Quick Entry, Add Card, Add Slab, eBay completion…),
// pin it to the top of its table until the next page load. Survives
// re-renders within the same session via in-memory Set.
const _kjrRecentAdds = { singles: new Set(), slabs: new Set(), sales: new Set(),
                         etbs: new Set(), boosterBoxes: new Set(),
                         boosterPacks: new Set(), ebayPurchases: new Set() };
function _pinRecentlyAdded(table, id){
  if (_kjrRecentAdds[table]) _kjrRecentAdds[table].add(id);
}
function _isRecentlyAdded(table, id){
  return _kjrRecentAdds[table] && _kjrRecentAdds[table].has(id);
}
// Helper: reorder a sorted list so recently-added rows float to the top.
function _pinRecentsToTop(items, table){
  if (!_kjrRecentAdds[table] || _kjrRecentAdds[table].size === 0) return items;
  const recent = [], rest = [];
  items.forEach(i => { (_kjrRecentAdds[table].has(i.id) ? recent : rest).push(i); });
  return [...recent, ...rest];
}

// ═════════════ eBay completion confirmation modal ═════════════
// Each eBay row represents one purchase, but a real-world transaction can
// involve multiple physical items (e.g. 1 raw + 1 PSA 10 slab in one
// Buyandship consolidation). When the user advances a row to "Completed",
// we open this modal to let them split the cost across 1..N inventory
// items. Nothing pushes to inventory without explicit confirmation.

// Holds the row being completed + the pending split items. Single-row mode
// for now; bulk completion calls this once per row.
let _kjrCompleteCtx = null;

function kjrEbayPipelineIndex(status){
  return KJR_EBAY_PIPELINE.indexOf(status);
}
function kjrEbayNextStatus(status){
  const i = kjrEbayPipelineIndex(status);
  if (i < 0 || i >= KJR_EBAY_PIPELINE.length - 1) return null; // already terminal
  return KJR_EBAY_PIPELINE[i+1];
}

// Entry point used by inline buttons & bulk action. If the row is not yet at
// "Completed", just advance to the next status in the pipeline. If advancing
// would land on "Completed", open the confirmation modal first.
function kjrEbayAdvance(id){
  const p = DB.ebayPurchases.find(r => r.id === id);
  if (!p) return;
  const next = kjrEbayNextStatus(p.status);
  if (!next) { toast && toast('Row already at end of pipeline'); return; }
  if (next === 'Completed') return kjrOpenCompleteModal(id);
  p.status = next;
  p.lastUpdated = Date.now();
  markDirty('ebayPurchases', p.id);
  saveData();
  renderEbayPurchases();
  toast && toast('Moved → ' + next);
}

// Bulk: advance every selected row by ONE step. Rows whose next step is
// "Completed" are queued for the confirmation modal (one at a time).
let _kjrCompleteQueue = [];
function kjrEbayBulkAdvance(ids){
  if (!ids || !ids.length) return;
  let pipelineMoved = 0;
  const completeIds = [];
  ids.forEach(id => {
    const p = DB.ebayPurchases.find(r => r.id === id);
    if (!p) return;
    const next = kjrEbayNextStatus(p.status);
    if (!next) return; // terminal - skip
    if (next === 'Completed') { completeIds.push(id); return; }
    p.status = next;
    p.lastUpdated = Date.now();
    markDirty('ebayPurchases', p.id);
    pipelineMoved++;
  });
  if (pipelineMoved) saveData();
  renderEbayPurchases();
  if (pipelineMoved) toast && toast('Advanced ' + pipelineMoved + ' row(s)');
  // Drain the completion queue one row at a time.
  _kjrCompleteQueue = completeIds.slice();
  if (_kjrCompleteQueue.length) kjrOpenCompleteModal(_kjrCompleteQueue.shift());
}

// Open the confirmation modal for one row. The modal:
//   • shows the eBay row's metadata (product, tracking, total SGD)
//   • lets the user split the total cost across 1..N inventory items
//   • each item picks a target table (singles/slabs/etbs/bb/packs) and a name
//   • on confirm, pushes every item into the chosen tables, marks the row
//     Completed and saves.
function kjrOpenCompleteModal(id){
  const p = DB.ebayPurchases.find(r => r.id === id);
  if (!p) { toast && toast('Row not found'); return; }
  // Authoritative SGD cost for this transaction
  const sgdCost = kjrNum(p.totalSgd) || (usdToSgd(kjrNum(p.priceUsd)) + kjrNum(p.freightSgd));
  const productRaw = p.product || '';

  // ── Multi-item detection ────────────────────────────────────────────────
  // If the Product field contains multiple items with USD prices (e.g.
  // "Jirachi XY67a $82.95 and Gyarados 21 $20"), split the SGD total across
  // them proportionally to the per-item USD prices so freight is shared
  // fairly. Each item gets its own auto-detected target table.
  const multi = (typeof kjrParseMultiItemProduct === 'function') ? kjrParseMultiItemProduct(productRaw) : [];
  let items;
  if (multi.length >= 2) {
    const totalUsd = multi.reduce((s,i) => s + (i.usdPrice || 0), 0);
    // First pass: proportional SGD costs based on USD share.
    items = multi.map(it => ({
      table: (typeof kjrDetectTargetTable === 'function') ? kjrDetectTargetTable(it.name) : 'singles',
      name:  it.name,
      cost:  totalUsd > 0
        ? +((it.usdPrice / totalUsd) * sgdCost).toFixed(2)
        : +(sgdCost / multi.length).toFixed(2)
    }));
    // Second pass: any rounding drift (e.g. two 0.33 splits of 1.00 leaving
    // 0.01 unallocated) collapses into the final item so the allocation
    // sums to sgdCost exactly. Without this the over/under warning fires on
    // every multi-item transaction.
    const allocOther = items.slice(0, -1).reduce((s,r) => s + r.cost, 0);
    items[items.length - 1].cost = +(sgdCost - allocOther).toFixed(2);
  } else {
    // Single-item path - smart-parse the product line so slab metadata
    // (grader / grade / cert#) and singles metadata (language / condition /
    // set) auto-fill on push-to-inventory. Without this the entire raw
    // string lands in the Card column (the original Serperior bug).
    const parsed = (typeof parseSmartLine === 'function') ? parseSmartLine(productRaw) : null;
    let initTable = p.targetTable;
    if (!initTable) {
      initTable = (typeof kjrDetectTargetTable === 'function')
        ? kjrDetectTargetTable(productRaw)
        : ((parsed && parsed.type === 'slab') ? 'slabs' : 'singles');
    }
    items = [{
      table:    initTable,
      name:     productRaw,
      cost:     +sgdCost.toFixed(2),
      // Pre-fill language/condition ONLY when actually found in the text.
      // Pre-filling the EN default would override a language the user later
      // types into the name. Empty = "Auto", which keeps name-syncing alive.
      language: ((initTable === 'singles' || initTable === 'slabs') && parsed && parsed.languageExplicit) ? parsed.language : '',
      condition: (initTable === 'singles' && parsed && parsed.conditionExplicit) ? parsed.condition : '',
    }];
  }

  _kjrCompleteCtx = { rowId: id, sgdCost, items };
  _renderCompleteModal();
  // The queue-advance logic runs as kjrModalCtrl's onClose hook, so ESC,
  // backdrop click AND the explicit close/cancel button (which all route
  // through kjrModalCtrl.close()) advance the bulk-complete queue identically
  // (FINDING B). Previously ESC/backdrop bypassed kjrCloseCompleteModal
  // entirely (it was only wired to the explicit button's onclick), silently
  // abandoning the rest of the batch. The hook is the single source of the
  // advance - kjrModalCtrl.close() clears it before invoking, so there is no
  // double-advance risk even though the button's onclick also calls close().
  kjrModalCtrl.open(document.getElementById('kjr-complete-back'), { onClose: _kjrAdvanceCompleteQueue });
}

// Single source of truth for what happens when the complete modal closes,
// by whatever path (button, ESC, backdrop). Registered as kjrModalCtrl's
// onClose hook in kjrOpenCompleteModal - do not call this directly from
// anywhere except that hook, or the queue could double-advance.
function _kjrAdvanceCompleteQueue(){
  _kjrCompleteCtx = null;
  // If a bulk-complete queue is in progress, continue with the next pending row.
  if (_kjrCompleteQueue.length) {
    const next = _kjrCompleteQueue.shift();
    setTimeout(() => kjrOpenCompleteModal(next), 50);
  }
}

// Explicit close/cancel entry point (button onclick in index.html, and the
// post-push-to-inventory success path). Just closes the dialog - the actual
// queue-advance happens once, via the onClose hook above, no matter how the
// dialog ends up closing.
function kjrCloseCompleteModal(){
  const back = document.getElementById('kjr-complete-back');
  if (back) kjrModalCtrl.close(back);
  else _kjrAdvanceCompleteQueue(); // dialog missing from DOM - hook never fires, advance manually
}

function kjrCompleteAddItem(){
  if (!_kjrCompleteCtx) return;
  // Default new item gets the remaining unallocated cost
  const allocated = _kjrCompleteCtx.items.reduce((s,i) => s + (parseFloat(i.cost)||0), 0);
  const remaining = Math.max(0, +(_kjrCompleteCtx.sgdCost - allocated).toFixed(2));
  _kjrCompleteCtx.items.push({ table:'singles', name:'', cost: remaining });
  _renderCompleteModal();
}
function kjrCompleteRemoveItem(idx){
  if (!_kjrCompleteCtx) return;
  _kjrCompleteCtx.items.splice(idx, 1);
  if (_kjrCompleteCtx.items.length === 0) {
    _kjrCompleteCtx.items.push({ table:'singles', name:'', cost: _kjrCompleteCtx.sgdCost });
  }
  _renderCompleteModal();
}
function kjrCompleteUpdateField(idx, field, value){
  if (!_kjrCompleteCtx) return;
  const it = _kjrCompleteCtx.items[idx];
  it[field] = field === 'cost' ? (parseFloat(value)||0) : value;
  _renderCompleteSummary();
  // Changing the Type shows/hides the Language + Condition fields, so the
  // whole item block has to be rebuilt - a preview refresh alone isn't enough.
  if (field === 'table') { _renderCompleteModal(); return; }
  if (field === 'name') {
    // Auto-sync the Language (and Condition for singles) dropdowns from words
    // typed in the name - e.g. typing "japanese" flips Language to JP. Only
    // when the user hasn't manually overridden that dropdown.
    if (typeof parseSmartLine === 'function') {
      const parsed = parseSmartLine(String(value||''));
      if (parsed) {
        if ((it.table === 'singles' || it.table === 'slabs') && parsed.languageExplicit && !it._langUserSet) {
          it.language = parsed.language;
          const sel = document.getElementById('kjr-complete-lang-' + idx);
          if (sel) sel.value = it.language;
        }
        if (it.table === 'singles' && parsed.conditionExplicit && !it._condUserSet) {
          it.condition = parsed.condition;
          const csel = document.getElementById('kjr-complete-cond-' + idx);
          if (csel) csel.value = it.condition;
        }
      }
    }
    _renderCompletePreview(idx);
  }
}

// Manual dropdown picks - flag as user-set so name-typing stops overriding.
// Picking "Auto" (empty) re-enables auto-sync from the name.
function kjrCompleteSetLang(idx, value){
  const it = _kjrCompleteCtx && _kjrCompleteCtx.items[idx];
  if (!it) return;
  it.language = value;
  it._langUserSet = (value !== '');
  _renderCompletePreview(idx);
}
function kjrCompleteSetCond(idx, value){
  const it = _kjrCompleteCtx && _kjrCompleteCtx.items[idx];
  if (!it) return;
  it.condition = value;
  it._condUserSet = (value !== '');
  _renderCompletePreview(idx);
}

// Render a one-line preview under each item's Name input showing exactly
// which fields parseSmartLine will populate on save. Mirrors the chip that
// appears in the Quick Entry bar so the user can verify before confirming.
function _renderCompletePreview(idx){
  if (!_kjrCompleteCtx) return;
  const el = document.getElementById('kjr-complete-preview-' + idx);
  if (!el) return;
  const it = _kjrCompleteCtx.items[idx];
  const raw = String(it.name || '').trim();
  if (!raw || typeof parseSmartLine !== 'function') { el.innerHTML = ''; return; }
  const parsed = parseSmartLine(raw);
  if (!parsed) { el.innerHTML = ''; return; }
  const chips = [];
  // Always show the cleaned name first so the user sees what will land in
  // the Card column.
  chips.push('<span style="color:var(--text)">' + kjrEscape(parsed.name || raw) + '</span>');
  if (it.table === 'slabs') {
    if (parsed.grader) chips.push(kjrEscape(parsed.grader) + (parsed.grade ? ' ' + kjrEscape(parsed.grade) : ''));
    const slabLang = it.language || parsed.language;
    if (slabLang)      chips.push(kjrEscape(slabLang));
    if (parsed.certNo) chips.push('#' + kjrEscape(parsed.certNo));
    if (parsed.rank)   chips.push(kjrEscape(parsed.rank));
  } else if (it.table === 'singles') {
    const sLang = it.language || parsed.language;
    const sCond = it.condition || parsed.condition;
    if (sLang)            chips.push(kjrEscape(sLang));
    if (sCond)            chips.push(kjrEscape(sCond));
    if (parsed.set)       chips.push(kjrEscape(parsed.set));
  }
  if (chips.length <= 1) { el.innerHTML = ''; return; }
  el.innerHTML = '<span style="color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-right:6px">Will save as</span>' +
    chips.join('<span style="color:var(--text3);margin:0 6px">·</span>');
}

function _renderCompleteSummary(){
  if (!_kjrCompleteCtx) return;
  const allocated = _kjrCompleteCtx.items.reduce((s,i) => s + (parseFloat(i.cost)||0), 0);
  const diff = +(allocated - _kjrCompleteCtx.sgdCost).toFixed(2);
  const el = document.getElementById('kjr-complete-summary');
  if (!el) return;
  let cls = 'pos', msg = '✓ Allocation matches transaction total';
  if (Math.abs(diff) > 0.5) {
    cls = diff > 0 ? 'neg' : 'amber';
    msg = (diff > 0 ? 'Over by S$' : 'Under by S$') + Math.abs(diff).toFixed(0) +
          ' - adjust amounts so they sum to S$' + Math.round(_kjrCompleteCtx.sgdCost);
  }
  el.className = 'kjr-complete-summary ' + cls;
  el.textContent = 'Total: S$' + Math.round(allocated) + ' of S$' + Math.round(_kjrCompleteCtx.sgdCost) + '  ·  ' + msg;
}

function _renderCompleteModal(){
  const p = DB.ebayPurchases.find(r => r.id === _kjrCompleteCtx.rowId);
  if (!p) return;
  const ctx = _kjrCompleteCtx;
  const TARGETS = [
    ['singles',      'Single'],
    ['slabs',        'Slab'],
    ['etbs',         'ETB'],
    ['boosterBoxes', 'Booster Box'],
    ['boosterPacks', 'Booster Pack'],
  ];
  const targetOpts = (sel) => TARGETS.map(([v,l]) => `<option value="${v}" ${v===sel?'selected':''}>${l}</option>`).join('');
  const LANGS = ['EN','JP','CN','KR','FR','DE','IT','ES','PT','TH'];
  const CONDS = ['Near Mint','Lightly Played','Moderately Played','Heavily Played','Damaged','Mint'];
  const langOpts = (sel) => `<option value="">Auto</option>` + LANGS.map(l => `<option value="${l}" ${l===sel?'selected':''}>${l}</option>`).join('');
  const condOpts = (sel) => `<option value="">Auto (Near Mint)</option>` + CONDS.map(c => `<option value="${c}" ${c===sel?'selected':''}>${c}</option>`).join('');

  const itemsHtml = ctx.items.map((it, idx) => `
    <div class="kjr-complete-item">
      <div class="kjr-complete-item-num">${idx+1}</div>
      <div class="kjr-complete-item-fields">
        <div class="form-grid" style="margin-bottom:0">
          <div class="form-group">
            <label class="lbl">Type</label>
            <select class="fi" onchange="kjrCompleteUpdateField(${idx}, 'table', this.value)">${targetOpts(it.table)}</select>
          </div>
          <div class="form-group">
            <label class="lbl">Cost (SGD)</label>
            <input class="fi" type="number" min="0" step="0.01" value="${it.cost}" oninput="kjrCompleteUpdateField(${idx}, 'cost', this.value)">
          </div>
          ${(it.table === 'singles' || it.table === 'slabs') ? `
          <div class="form-group">
            <label class="lbl">Language</label>
            <select class="fi" id="kjr-complete-lang-${idx}" onchange="kjrCompleteSetLang(${idx}, this.value)">${langOpts(it.language||'')}</select>
          </div>
          ` : ''}
          ${it.table === 'singles' ? `
          <div class="form-group">
            <label class="lbl">Condition</label>
            <select class="fi" id="kjr-complete-cond-${idx}" onchange="kjrCompleteSetCond(${idx}, this.value)">${condOpts(it.condition||'')}</select>
          </div>
          ` : ''}
          <div class="form-group full">
            <label class="lbl">Name / Product</label>
            <input class="fi" type="text" value="${kjrEscape(it.name)}" oninput="kjrCompleteUpdateField(${idx}, 'name', this.value)" placeholder="e.g. Charizard ex 223 · PSA 10 #12345 · Surging Sparks ETB">
            <div id="kjr-complete-preview-${idx}" style="margin-top:6px;font-size:11px;line-height:1.5"></div>
          </div>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="kjrCompleteRemoveItem(${idx})" title="Remove">×</button>
    </div>
  `).join('');
  document.getElementById('kjr-complete-body').innerHTML = `
    <div class="kjr-complete-header">
      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-bottom:6px">Transaction</div>
      <div style="font-size:13px;color:var(--text);line-height:1.6">
        <strong>${kjrEscape(p.product || '(no product)')}</strong><br>
        <span style="color:var(--text3);font-size:11px">
          ${kjrEscape(p.tracking || 'no tracking')} · ${kjrEscape(toDateMmmYyyy(p.date)||'')} · Total <strong style="color:var(--text)">S$${Math.round(ctx.sgdCost)}</strong>
        </span>
      </div>
    </div>
    <div style="margin-top:16px;display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.5px;font-weight:600">Items to push into inventory</div>
      <button class="btn btn-sm" onclick="kjrCompleteAddItem()">+ Add another item</button>
    </div>
    <div class="kjr-complete-items">${itemsHtml}</div>
    <div id="kjr-complete-summary" class="kjr-complete-summary"></div>
  `;
  _renderCompleteSummary();
  // Seed the parsed-preview chip for every item now that the DOM exists.
  ctx.items.forEach((_, i) => _renderCompletePreview(i));
}

async function kjrConfirmCompletion(){
  if (!_kjrCompleteCtx) return;
  const ctx = _kjrCompleteCtx;
  const p = DB.ebayPurchases.find(r => r.id === ctx.rowId);
  if (!p) { toast && toast('Row not found'); return; }
  // Validate: every item needs a name, total should be in the same ballpark
  for (const it of ctx.items) {
    if (!String(it.name||'').trim()) { toast && toast('Every item needs a name'); return; }
  }
  const allocated = ctx.items.reduce((s,i) => s + (parseFloat(i.cost)||0), 0);
  if (Math.abs(allocated - ctx.sgdCost) > 0.5) {
    if (!await kjrConfirm('Allocated S$' + Math.round(allocated) + ' but transaction total is S$' + Math.round(ctx.sgdCost) + '. Continue anyway?', {ok:'Continue'})) return;
  }
  const today = new Date().toISOString().slice(0,10);
  const norm = (table, raw) => (typeof normalizeRecord === 'function') ? normalizeRecord(table, raw) : raw;
  const newIds = [];
  ctx.items.forEach(it => {
    const cost = parseFloat(it.cost)||0;
    const rawName = String(it.name).trim();
    const note = '';
    // Reuse the Quick Entry parser so a raw eBay product line like
    // "Serperior ex 164 tag 10 Z4006099" is split into clean name + grader +
    // grade + cert# (slab) or name + language + condition + set (single).
    // Without this, the entire raw line lands in the Card column. Only the
    // singles/slabs paths benefit - ETB / booster boxes / packs use the
    // product string verbatim.
    const parsed = (typeof parseSmartLine === 'function') ? parseSmartLine(rawName) : null;
    const cleanName = (parsed && parsed.name && parsed.name !== '(unnamed)') ? parsed.name : rawName;
    if (it.table === 'singles') {
      // Explicit fields typed in the modal win; parseSmartLine fills the rest.
      const lang = it.language || (parsed && parsed.language) || 'EN';
      const cond = it.condition || (parsed && parsed.condition) || 'Near Mint';
      const typ  = (parsed && parsed.type === 'slab') ? 'raw' : ((parsed && parsed.type) || 'raw');
      const item = norm('singles', {
        id: kjrId('s'),
        name: cleanName,
        language: lang,
        type: typ,
        condition: cond,
        set: (parsed && parsed.set) || '',
        status: 'Available',
        costPrice: cost,
        datePurchased: today,
        notes: note,
        priceHistory: []
      });
      DB.singles.push(item); markDirty('singles', item.id); newIds.push({table:'singles', id:item.id});
    } else if (it.table === 'slabs') {
      // Explicit language typed in the modal wins; parseSmartLine fills the rest.
      const lang = it.language || (parsed && parsed.language) || 'EN';
      const item = norm('slabs', {
        id: kjrId('sl'),
        name: cleanName,
        type: 'slab',
        language: lang,
        grader: (parsed && parsed.grader) || '',
        grade:  (parsed && parsed.grade)  || '',
        certNo: (parsed && parsed.certNo) || '',
        rank:   (parsed && parsed.rank)   || '',
        status: 'Available',
        costPrice: cost,
        dateListed: today,
        notes: note,
        priceHistory: []
      });
      DB.slabs.push(item); markDirty('slabs', item.id); newIds.push({table:'slabs', id:item.id});
    } else if (it.table === 'etbs') {
      const item = norm('etbs', { id: kjrId('etb'), product: cleanName, status:'In Stock', totalPrice: cost, condition:'Mint', date: today });
      DB.etbs = DB.etbs || []; DB.etbs.push(item); markDirty('etbs', item.id); newIds.push({table:'etbs', id:item.id});
    } else if (it.table === 'boosterBoxes') {
      const item = norm('boosterBoxes', { id: kjrId('bb'), product: cleanName, status:'Unopened Stock', qty:1, unitPrice: cost, totalPrice: cost, date: today, notes: note });
      DB.boosterBoxes = DB.boosterBoxes || []; DB.boosterBoxes.push(item); markDirty('boosterBoxes', item.id); newIds.push({table:'boosterBoxes', id:item.id});
    } else if (it.table === 'boosterPacks') {
      const item = norm('boosterPacks', { id: kjrId('bp'), product: cleanName, status:'Sealed', qty:1, unitPrice: cost, totalPrice: cost, date: today, notes: note });
      DB.boosterPacks = DB.boosterPacks || []; DB.boosterPacks.push(item); markDirty('boosterPacks', item.id); newIds.push({table:'boosterPacks', id:item.id});
    }
  });
  // Mark the eBay row Completed
  p.status = 'Completed';
  p.completedAt = today;
  p.lastUpdated = Date.now();
  p._linkedInventory = newIds; // audit trail for future debugging
  markDirty('ebayPurchases', p.id);
  saveData();
  // Notify the recent-add pinning helper so new rows surface at the top of
  // their tables.
  newIds.forEach(({table, id}) => { try { _pinRecentlyAdded(table, id); } catch(e) {} });
  // Refresh every affected tab
  renderEbayPurchases();
  if (typeof renderSingles === 'function')        renderSingles();
  if (typeof renderSlabs === 'function')          renderSlabs();
  if (typeof renderEtbs === 'function')           renderEtbs();
  if (typeof renderBoosterBoxes === 'function')   renderBoosterBoxes();
  if (typeof renderBoosterPacks === 'function')   renderBoosterPacks();
  if (typeof renderDashboard === 'function')      renderDashboard();
  clLog && clLog('complete', 'ebayPurchases', p.product||p.tracking||p.id, '→ ' + newIds.length + ' item(s) into inventory');
  toast && toast('Pushed ' + newIds.length + ' item(s) into inventory');
  kjrCloseCompleteModal();
}

// Legacy entry point kept for any cached HTML out there (the inline "Mark
// Received" buttons in the rendered rows). Aliased to the new pipeline.
function kjrMarkReceived(id){ return kjrEbayAdvance(id); }
function kjrMarkCompleted(id){ return kjrOpenCompleteModal(id); }

// ═════════════ Hook into showPage so renders fire ═════════════
(function(){
  if (window._kjrShowPageWrappedV2) return;
  window._kjrShowPageWrappedV2 = true;
  const orig = window.showPage;
  window.showPage = function(name){
    orig.apply(this, arguments);
    if (name === 'etbs') renderEtbs();
    else if (name === 'boosterBoxes') renderBoosterBoxes();
    else if (name === 'ebay') renderEbayPurchases();
  };
  document.addEventListener('DOMContentLoaded', () => setTimeout(() => {
    try { renderEtbs(); renderBoosterBoxes(); renderEbayPurchases(); } catch(e) {}
  }, 1500));
})();
// ═════════════ Booster Packs ═════════════
// Sort state for the new key
_kjrSort.boosterPacks = { k:null, dir:1 };

const KJR_BP_FIELDS = [
  { key:'date',       label:'Date',         type:'date' },
  { key:'product',    label:'Product',      type:'text' },
  { key:'unitPrice',  label:'Unit Price',   type:'number' },
  { key:'qty',        label:'Quantity',     type:'number' },
  { key:'totalPrice', label:'Total Price',  type:'number' },
  { key:'status',     label:'Status',       type:'select', options:['Sealed','Opened','Sold','Reserved'] },
  { key:'notes',      label:'Notes',        type:'textarea' },
];
function kjrOpenBpModal(idOrItem){
  const isNew = !idOrItem;
  // Edit buttons pass the row id (not the row JSON, which broke on fields
  // containing '&#39;' when inlined into an onclick attribute) - resolve to
  // the live DB record here. A plain object is still accepted defensively.
  let item;
  if (isNew) item = { id: kjrId('bp'), status:'Sealed', date:new Date().toISOString().slice(0,10), qty:1 };
  else if (typeof idOrItem === 'string') item = (DB.boosterPacks || []).find(r => r.id === idOrItem) || { id: idOrItem };
  else item = idOrItem;
  kjrOpenModal({ dbKey:'boosterPacks', singular:'Booster Pack', fields:KJR_BP_FIELDS, item, isNew, after:renderBoosterPacks });
}
function renderBoosterPacks(){
  const rows = DB.boosterPacks || [];
  const q = _v('kjr-bp-search'), statF = _v('kjr-bp-status');
  const cfDate = _v('kjr-bp-cf-date'), cfProd = _v('kjr-bp-cf-product'), cfNotes = _v('kjr-bp-cf-notes');
  const cfUnit = _v('kjr-bp-cf-unit'), cfQty = _v('kjr-bp-cf-qty'), cfTotal = _v('kjr-bp-cf-total');
  const cfMkt = _v('kjr-bp-cf-mkt'), cfList = _v('kjr-bp-cf-list');
  const filtered = rows.filter(r =>
    kjrMatchUniversal(q, r, 'boosterPacks') &&
    (!statF || r.status === statF) &&
    kjrMatchDateFilter(cfDate, r.date) && kjrMatchFilter(cfProd, r.product) && kjrMatchFilter(cfNotes, r.notes) &&
    kjrMatchNumFilter(cfUnit, r.unitPrice) && kjrMatchNumFilter(cfQty, r.qty) && kjrMatchNumFilter(cfTotal, r.totalPrice) &&
    kjrMatchNumFilter(cfMkt, r.marketPrice) && kjrMatchNumFilter(cfList, r.carousellPrice)
  );
  const sorted = kjrApplySort(filtered, 'boosterPacks');
  const active   = _pinRecentsToTop(sorted.filter(r => kjrIsActiveStatus('boosterPacks', r.status)), 'boosterPacks');
  const inactive = sorted.filter(r => !kjrIsActiveStatus('boosterPacks', r.status));
  const sealed = active.filter(r => /sealed/.test((r.status||'').toLowerCase()));
  const totalPacks = sealed.reduce((s,r) => s + (kjrNum(r.qty)||1), 0);
  const sealedVal  = sealed.reduce((s,r) => s + kjrNum(r.totalPrice), 0);
  document.getElementById('kjr-bp-stats').innerHTML =
    kjrStatCard('Sealed Lots', sealed.length, 'Status = Sealed') +
    kjrStatCard('Sealed Packs', totalPacks.toString(), 'Sum of qty for Sealed rows') +
    kjrStatCard('Sealed Value', kjrFmt(sealedVal) || 'S$0', 'Sum of totalPrice for Sealed rows');
  const rowHtml = (r, sold) => '<tr' + (sold ? ' class="sold-row"' : '') + '>' +
    '<td data-col-key="date">'+kjrEscape(toDateMmmYyyy(r.date)||'')+'</td>' +
    '<td data-col-key="product" style="text-align:left">'+kjrEscape(r.product||'')+'</td>' +
    '<td data-col-key="unitPrice" class="num">'+kjrFmt(r.unitPrice)+'</td>' +
    '<td data-col-key="qty" class="num">'+kjrEscape(r.qty||'')+'</td>' +
    '<td data-col-key="totalPrice" class="num">'+kjrFmt(r.totalPrice)+'</td>' +
    // Inline market + carousell price - same UX as Singles/Slabs/Booster Boxes.
    '<td data-col-key="marketPrice" class="num"><input class="kjr-inline" style="width:80px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px;text-align:right" value="'+kjrEscape(kjrNum(r.marketPrice) > 0 ? '$'+Math.round(kjrNum(r.marketPrice)) : '')+'" placeholder="-" onchange="updateField(\'boosterPacks\',\''+kjrEscape(r.id)+'\',\'marketPrice\',kjrMoneyStr(this.value))"></td>' +
    '<td data-col-key="carousellPrice" class="num"><input class="kjr-inline" style="width:80px;background:transparent;border:none;color:var(--text);font-family:monospace;font-size:12px;text-align:right" value="'+kjrEscape(kjrNum(r.carousellPrice) > 0 ? '$'+Math.round(kjrNum(r.carousellPrice)) : '')+'" placeholder="-" onchange="updateField(\'boosterPacks\',\''+kjrEscape(r.id)+'\',\'carousellPrice\',kjrMoneyStr(this.value))"></td>' +
    '<td data-col-key="status">'+kjrPill(r.status)+'</td>' +
    '<td data-col-key="notes" style="text-align:left;color:var(--text2);font-size:12px">'+kjrEscape(r.notes||'')+'</td>' +
    '<td data-col-key="actions"><span class="kjr-row-actions">' +
      '<button class="btn btn-ghost btn-sm" onclick="kjrOpenBpModal(\''+kjrEscape(r.id)+'\')">Edit</button>' +
      '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="kjrDeleteRow(\'boosterPacks\',\''+kjrEscape(r.id)+'\')">×</button>' +
    '</span></td>' +
    '</tr>';
  let body = active.map(r => rowHtml(r, false)).join('');
  if (active.length === 0 && inactive.length === 0) {
    body = kjrInvEmptyRow(rows.length > 0
      ? { colspan: 10, filtered: true }
      : { colspan: 10, filtered: false, icon: '📦', title: 'No Booster Packs yet',
          sub: 'Track sealed Booster Packs here, cost, market and Carousell price side by side.',
          ctaLabel: '+ Add Pack', ctaAction: 'kjrOpenBpModal()' });
  } else if (active.length === 0) {
    body = '<tr><td colspan="10" style="color:var(--text3);padding:18px;text-align:center">No sealed booster packs.</td></tr>';
  }
  body += kjrSoldToggleRow('boosterPacks', inactive.length, 10);
  if (_kjrSoldOpen.boosterPacks) body += inactive.map(r => rowHtml(r, true)).join('');
  document.getElementById('kjr-bp-body').innerHTML = body;
  if (typeof _kjrColApply === 'function')  _kjrColApply('boosterPacks');
  if (typeof _kjrColAttach === 'function') _kjrColAttach('boosterPacks');
}

// ═════════════ Hook into showPage ═════════════
(function(){
  const orig = window.showPage;
  window.showPage = function(name){
    orig.apply(this, arguments);
    if (name === 'boosterPacks') renderBoosterPacks();
  };
})();

// ═════════════ Auto-migrate BP rows out of Booster Boxes (one-time) ═════
async function kjrMigrateBoxesToPacks(){
  if (localStorage.getItem('kjr_packs_migrated_v1') === '1') return;
  const boxes = DB.boosterBoxes || [];
  // BP marker = word-boundary BP, or name contains "pack" but not "package/packed/packing/backpack"
  const isPack = (name) => {
    const s = String(name||'');
    if (/\bBP\b/.test(s)) return true;
    if (/pack/i.test(s) && !/package|packed|packing|backpack/i.test(s)) return true;
    return false;
  };
  const toMove = boxes.filter(b => isPack(b.product || b.name));
  if (!toMove.length) { localStorage.setItem('kjr_packs_migrated_v1', '1'); return; }

  if (!await kjrConfirm('Found ' + toMove.length + ' row' + (toMove.length===1?'':'s') + ' in Booster Boxes that look like Packs (name contains "BP" or "pack"). Move them to the new Booster Packs tab?', {ok:'Move to Packs'})) {
    localStorage.setItem('kjr_packs_migrated_v1', 'skipped');
    return;
  }

  // Move locally
  DB.boosterPacks = DB.boosterPacks || [];
  toMove.forEach(b => {
    DB.boosterPacks.push({ ...b, status: b.status === 'Unopened Stock' ? 'Sealed' : b.status });
    markDirty('boosterPacks', b.id);
  });
  // Remove from boxes locally
  DB.boosterBoxes = boxes.filter(b => !isPack(b.product || b.name));

  // Sync: delete from booster_boxes in cloud, upsert into booster_packs
  let dErr = 0, uErr = 0;
  for (const b of toMove) {
    try { await sbDelete('booster_boxes', b.id); } catch(e) { dErr++; console.error(e); }
  }
  saveData();
  if (typeof toast === 'function') {
    toast('Migrated ' + toMove.length + ' pack rows.' + (dErr ? ' (' + dErr + ' delete errors - see console)' : ''));
  }
  localStorage.setItem('kjr_packs_migrated_v1', '1');
  renderBoosterPacks();
  renderBoosterBoxes();
}

// ═════════════ One-time: re-parse slab names that still carry grader/grade ═════════════
// Backfill for legacy slab rows that were pushed into inventory from the eBay
// pipeline BEFORE kjrConfirmCompletion learned to call parseSmartLine. Those
// rows look like: name="Serperior ex 164 tag 10 Z4006099" with grader / grade /
// certNo all blank. We detect them by re-running the slab regex against the
// stored name; if it still matches, parseSmartLine gives us the split.
//
// Safety guards (so we never clobber correctly-entered rows):
//   • Only touches slabs whose CURRENT name still matches the grader+grade rx.
//   • Only fills grader/grade/certNo/rank if those fields are currently empty
//     - never overrides values the user already typed.
//   • Skips rows where the parser would produce an unnamed leftover.
//   • Confirms with the user before mutating, with a preview of the changes.
async function kjrReparseSlabNames(){
  if (localStorage.getItem('kjr_slab_reparse_v1') === '1') return;
  if (typeof parseSmartLine !== 'function') return;
  const slabs = DB.slabs || [];
  const slabRx = /\b(TAG|PSA|CGC|ACE|BGS)\s+(10|9\.5|9|8\.5|8|7|6|5)\b/i;
  const toFix = [];
  slabs.forEach(row => {
    const name = String(row.name || '');
    if (!slabRx.test(name)) return;            // grader+grade not in name
    const parsed = parseSmartLine(name);
    if (!parsed || !parsed.grader) return;     // couldn't extract grader
    if (!parsed.name || parsed.name === '(unnamed)') return;
    if (parsed.name === name) return;          // nothing to strip
    toFix.push({ row, parsed });
  });
  if (!toFix.length) { localStorage.setItem('kjr_slab_reparse_v1', '1'); return; }

  const preview = toFix.slice(0, 6).map(({row, parsed}) => {
    const tail = (parsed.grader || '') + (parsed.grade ? ' ' + parsed.grade : '') +
                 (parsed.certNo ? ' #' + parsed.certNo : '') +
                 (parsed.rank ? ' · ' + parsed.rank : '');
    return '• "' + esc(row.name) + '"\n     → "' + esc(parsed.name) + '"  +  ' + esc(tail);
  }).join('\n');
  const more = toFix.length > 6 ? '\n…and ' + (toFix.length - 6) + ' more' : '';
  if (!await kjrConfirm(
    'Found ' + toFix.length + ' slab row' + (toFix.length === 1 ? '' : 's') +
    ' with grader / grade / cert# still inside the name field.\n\n' +
    'Auto-split them into the proper columns?\n\n' + preview + more,
    {ok:'Auto-split'}
  )) {
    localStorage.setItem('kjr_slab_reparse_v1', 'skipped');
    return;
  }

  toFix.forEach(({row, parsed}) => {
    row.name = parsed.name;
    // Only fill blanks - never overwrite values the user may have set by hand.
    if (!row.grader) row.grader = parsed.grader || '';
    if (!row.grade)  row.grade  = parsed.grade  || '';
    if (!row.certNo) row.certNo = parsed.certNo || '';
    if (!row.rank)   row.rank   = parsed.rank   || '';
    markDirty('slabs', row.id);
  });
  saveData();
  if (typeof toast === 'function') toast('Re-parsed ' + toFix.length + ' slab row' + (toFix.length === 1 ? '' : 's') + '.');
  if (typeof clLog === 'function') clLog('migrate', 'slabs', 'reparsed ' + toFix.length + ' name(s)');
  localStorage.setItem('kjr_slab_reparse_v1', '1');
  if (typeof renderSlabs === 'function') renderSlabs();
}

document.addEventListener('DOMContentLoaded', () => {
  // wait until cloud load is done before migrating (gives initDB ~2s)
  setTimeout(() => { kjrMigrateBoxesToPacks().catch(e => console.error('migrate err', e)); }, 2500);
  // Slab re-parse runs a hair later so the Boxes→Packs prompt isn't stacked on top.
  setTimeout(() => { kjrReparseSlabNames().catch(e => console.error('slab reparse err', e)); }, 3500);
  setTimeout(() => { try { renderBoosterPacks(); } catch(e) {} }, 1500);
});
// ═════════════ Combined Boxes + Packs stats ═════════════
(function(){
  if (window._kjrBbBpStatsInstalled) return;
  window._kjrBbBpStatsInstalled = true;

  function renderBbBpStats(){
    const boxes = DB.boosterBoxes || [];
    const packs = DB.boosterPacks || [];
    const sealedBoxes = boxes.filter(r => (r.status||'').toLowerCase().includes('unopened'));
    const sealedPacks = packs.filter(r => (r.status||'').toLowerCase().includes('sealed'));
    const boxUnits  = sealedBoxes.reduce((s,r) => s + kjrNum(r.qty), 0);
    const packUnits = sealedPacks.reduce((s,r) => s + kjrNum(r.qty), 0);
    const boxVal    = sealedBoxes.reduce((s,r) => s + kjrNum(r.totalPrice), 0);
    const packVal   = sealedPacks.reduce((s,r) => s + kjrNum(r.totalPrice), 0);
    const el = document.getElementById('kjr-bbbp-stats');
    if (!el) return;
    el.innerHTML =
      kjrStatCard('Total Sealed', kjrFmt(boxVal+packVal) || 'S$0', 'Combined value of sealed boxes + sealed packs') +
      kjrStatCard('Sealed Boxes', boxUnits.toString(),  'Sum of qty across Unopened box rows') +
      kjrStatCard('Sealed Packs', packUnits.toString(), 'Sum of qty across Sealed pack rows');
    // little count badges next to each section header
    const bbBadge = document.getElementById('kjr-bb-count-badge');
    const bpBadge = document.getElementById('kjr-bp-count-badge');
    if (bbBadge) bbBadge.textContent = boxes.length + ' row' + (boxes.length===1?'':'s');
    if (bpBadge) bpBadge.textContent = packs.length + ' row' + (packs.length===1?'':'s');
  }
  window.renderBbBpStats = renderBbBpStats;

  // Wrap each render so the combined banner stays in sync.
  const origBB = window.renderBoosterBoxes;
  if (origBB) window.renderBoosterBoxes = function(){ const r = origBB.apply(this, arguments); renderBbBpStats(); return r; };
  const origBP = window.renderBoosterPacks;
  if (origBP) window.renderBoosterPacks = function(){ const r = origBP.apply(this, arguments); renderBbBpStats(); return r; };

  // Route old boosterPacks showPage calls to the unified boosterBoxes tab.
  const origShow = window.showPage;
  if (origShow) {
    window.showPage = function(name){
      const target = (name === 'boosterPacks') ? 'boosterBoxes' : name;
      return origShow.call(this, target);
    };
  }

  // Wipe the per-section stats containers that may still exist (the old
  // renderers set innerHTML on these; both now point at the same combined banner).
  document.addEventListener('DOMContentLoaded', () => {
    // Replace old IDs so any leftover writes go to a benign hidden element.
    ['kjr-bb-stats','kjr-bp-stats'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    setTimeout(() => { try { renderBoosterBoxes && renderBoosterBoxes(); renderBoosterPacks && renderBoosterPacks(); } catch(e) {} }, 1500);
  });
})();
// ── USER GUIDE renderer ──────────────────────────────────────────────────────
(function() {
  let _rendered = false;
  let _slugify = function(s) {
    return String(s).toLowerCase()
      .replace(/[^a-z0-9\s\-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .substring(0, 80);
  };

  window.kjrGuideRender = function() {
    if (_rendered) return;
    if (typeof marked === 'undefined') {
      document.getElementById('guide-content').innerHTML = '<div class="guide-empty">Markdown library failed to load. Refresh the page.</div>';
      return;
    }
    const src = document.getElementById('guide-source');
    if (!src) return;
    const md = src.textContent.trim();
    // Configure marked: GFM, no embedded HTML risk because content is trusted (we wrote it)
    marked.setOptions({ gfm: true, breaks: false, headerIds: false, mangle: false });
    const html = marked.parse(md);
    const content = document.getElementById('guide-content');
    content.innerHTML = html;

    // Add IDs to h2/h3 headings for TOC links
    const tocItems = [];
    content.querySelectorAll('h2, h3').forEach(h => {
      const id = _slugify(h.textContent);
      h.id = id;
      tocItems.push({ level: h.tagName.toLowerCase(), text: h.textContent, id: id });
    });

    // Build TOC
    const tocHtml = tocItems.map(it =>
      '<a href="#' + it.id + '" class="toc-' + it.level + '" onclick="kjrGuideJump(\'' + it.id + '\');return false">' + it.text + '</a>'
    ).join('');
    document.getElementById('guide-toc-list').innerHTML = tocHtml;

    _rendered = true;
  };

  window.kjrGuideJump = function(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Mark active
    document.querySelectorAll('.guide-toc a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
    // On mobile, close the toc after jump
    if (window.matchMedia('(max-width:900px)').matches) {
      document.querySelector('.guide-toc')?.classList.remove('mobile-open');
    }
  };

  window.kjrGuideSearch = function(query) {
    const q = (query || '').trim().toLowerCase();
    const content = document.getElementById('guide-content');
    if (!content) return;
    // Remove any existing highlights
    content.querySelectorAll('mark.guide-hl').forEach(m => {
      const p = m.parentNode; p.replaceChild(document.createTextNode(m.textContent), m); p.normalize();
    });
    if (!q) return;
    // Walk text nodes, wrap matches
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.nodeValue.trim() && n.parentNode.tagName !== 'SCRIPT' && n.parentNode.tagName !== 'STYLE') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
    });
    const nodes = [];
    let n; while (n = walker.nextNode()) nodes.push(n);
    let firstMatch = null;
    nodes.forEach(node => {
      const text = node.nodeValue;
      const idx = text.toLowerCase().indexOf(q);
      if (idx < 0) return;
      const before = text.substring(0, idx);
      const match  = text.substring(idx, idx + q.length);
      const after  = text.substring(idx + q.length);
      const frag = document.createDocumentFragment();
      if (before) frag.appendChild(document.createTextNode(before));
      const m = document.createElement('mark');
      m.className = 'guide-hl';
      m.style.cssText = 'background:#f59e0b;color:#000;padding:0 2px;border-radius:2px';
      m.textContent = match;
      frag.appendChild(m);
      if (!firstMatch) firstMatch = m;
      if (after) frag.appendChild(document.createTextNode(after));
      node.parentNode.replaceChild(frag, node);
    });
    if (firstMatch) firstMatch.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Hook showPage so the guide renders the first time you open it
  const _origShow = window.showPage;
  window.showPage = function(id) {
    if (_origShow) _origShow(id);
    if (id === 'guide' && !_rendered) {
      // Defer to next frame so the page is visible before we render (gives "Loading..." a chance)
      requestAnimationFrame(kjrGuideRender);
    }
  };
})();
// ── SENTRY ERRORS PANEL ──────────────────────────────────────────────────────
(function() {
  var SENTRY_PROJECT_ID = '4511426243723264';
  var SENTRY_BASE = 'https://sentry.io/api/0';

  function relTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var s = Math.floor(diff / 1000);
    if (s < 60)    return 'just now';
    if (s < 3600)  return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  var _orgSlug = null; // cached after first fetch

  window.openSentryPanel = function() {
    document.getElementById('sentry-drawer').classList.add('open');
    document.getElementById('sentry-drawer-overlay').classList.add('open');
    kjrModalCtrl.syncScroll();
    kjrSentryLoad();
  };

  window.closeSentryPanel = function() {
    document.getElementById('sentry-drawer').classList.remove('open');
    document.getElementById('sentry-drawer-overlay').classList.remove('open');
    kjrModalCtrl.syncScroll();
  };

  window.kjrSentryLoad = async function() {
    var body = document.getElementById('sentry-issues-body');
    var token = localStorage.getItem('_sentryToken');

    if (!token) {
      body.innerHTML =
        '<div class="sentry-auth">' +
          '<p style="margin-bottom:6px">Connect your Sentry account to view errors here.</p>' +
          '<p style="font-size:11px;color:var(--text3);margin-bottom:12px;line-height:1.6">Generate an auth token at <a href="https://sentry.io/settings/account/api/auth-tokens/" target="_blank" style="color:var(--accent)">sentry.io → Auth Tokens</a> with <strong style="color:var(--text)">project:read</strong> and <strong style="color:var(--text)">org:read</strong> scopes.</p>' +
          '<div style="display:flex;gap:8px">' +
            '<input id="sentry-token-input" type="password" class="fi" placeholder="sntrys_..." style="flex:1;font-size:12px;font-family:monospace">' +
            '<button class="btn btn-primary btn-sm" onclick="kjrSentrySaveToken()">Connect</button>' +
          '</div>' +
        '</div>';
      return;
    }

    body.innerHTML = '<div class="sentry-empty" style="color:var(--text3)">Loading…</div>';

    try {
      // Discover org slug if not cached
      if (!_orgSlug) {
        var orgsRes = await fetch(SENTRY_BASE + '/organizations/?member=1', {
          headers: { 'Authorization': 'Bearer ' + token }
        });
        if (orgsRes.status === 401) {
          localStorage.removeItem('_sentryToken');
          body.innerHTML = '<div class="sentry-empty" style="color:var(--red)">Token invalid or expired. <button onclick="kjrSentryLoad()" class="btn btn-sm" style="margin-top:8px">Re-enter token</button></div>';
          return;
        }
        var orgs = await orgsRes.json();
        if (!orgs.length) { body.innerHTML = '<div class="sentry-empty">No organisations found.</div>'; return; }
        _orgSlug = orgs[0].slug;
        var footerOrg = document.getElementById('sentry-footer-org');
        if (footerOrg) footerOrg.textContent = orgs[0].name;
      }

      var issuesRes = await fetch(
        SENTRY_BASE + '/organizations/' + _orgSlug + '/issues/?project=' + SENTRY_PROJECT_ID +
        '&query=is:unresolved&limit=25&sort=date',
        { headers: { 'Authorization': 'Bearer ' + token } }
      );
      var issues = await issuesRes.json();

      if (!Array.isArray(issues) || !issues.length) {
        body.innerHTML = '<div class="sentry-empty">✓ No unresolved issues</div>';
        var badge = document.getElementById('sentry-badge');
        if (badge) badge.style.display = 'none';
        return;
      }

      // Update header badge
      var badge = document.getElementById('sentry-badge');
      if (badge) {
        badge.textContent = issues.length > 99 ? '99+' : issues.length;
        badge.style.display = 'flex';
      }

      var levelColor = { error: 'var(--red)', fatal: '#ff4444', warning: '#f59e0b', info: 'var(--accent)', debug: 'var(--text3)' };
      body.innerHTML = issues.map(function(issue) {
        var col = levelColor[issue.level] || 'var(--text3)';
        return '<div class="sentry-issue" onclick="window.open(\'' + issue.permalink + '\',\'_blank\')" title="Open in Sentry">' +
          '<div style="display:flex;align-items:flex-start;gap:8px">' +
            '<span style="color:' + col + ';font-size:10px;font-weight:700;text-transform:uppercase;flex-shrink:0;margin-top:3px;min-width:36px">' + kjrEscape(issue.level) + '</span>' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-size:12px;font-weight:500;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + kjrEscape(issue.title) + '</div>' +
              (issue.culprit ? '<div style="font-size:11px;color:var(--text3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px">' + kjrEscape(issue.culprit) + '</div>' : '') +
            '</div>' +
          '</div>' +
          '<div style="display:flex;justify-content:space-between;margin-top:8px;font-size:11px;color:var(--text3)">' +
            '<span>×' + Number(issue.count).toLocaleString() + ' events</span>' +
            '<span>' + relTime(issue.lastSeen) + '</span>' +
          '</div>' +
        '</div>';
      }).join('');

    } catch(e) {
      body.innerHTML = '<div class="sentry-empty" style="color:var(--red)">Failed to load: ' + kjrEscape(e.message) + '</div>';
    }
  };

  window.kjrSentrySaveToken = function() {
    var val = (document.getElementById('sentry-token-input') || {}).value;
    if (!val || !val.trim()) return;
    localStorage.setItem('_sentryToken', val.trim());
    _orgSlug = null;
    kjrSentryLoad();
  };

  window.kjrSentryDisconnect = async function() {
    if (!await kjrConfirm('Remove stored Sentry token?', {ok:'Disconnect', danger:true})) return;
    localStorage.removeItem('_sentryToken');
    _orgSlug = null;
    var badge = document.getElementById('sentry-badge');
    if (badge) badge.style.display = 'none';
    kjrSentryLoad();
  };

  // Close on Escape
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && document.getElementById('sentry-drawer').classList.contains('open')) {
      closeSentryPanel();
    }
  });
})();

// =========== EXCEL EXPORT (v3.15) ===========
// One workbook, one sheet per data tab, house-formatted (Lexend, bold+frozen+
// filtered headers, SGD/USD currency, dd/mm/yyyy dates, right-aligned numbers).
// READ-ONLY: this module only ever reads DB.* - it never mutates a row, never
// calls markDirty/saveAllToSupabase. Sale rows are copied (Object.assign) before
// the margin field is replaced, so the live DB.sales array is untouched.

// ── Lazy-load ExcelJS on first use, cache the promise so a second click
// doesn't re-inject the script. Never throws past this - a failed load
// toasts and the caller aborts.
let _kjrExcelJsPromise = null;
function _kjrLoadExcelJs() {
  if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if (_kjrExcelJsPromise) return _kjrExcelJsPromise;
  _kjrExcelJsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    s.onload = () => {
      if (window.ExcelJS) resolve(window.ExcelJS);
      else reject(new Error('ExcelJS did not initialise'));
    };
    s.onerror = () => reject(new Error('Failed to load ExcelJS from CDN'));
    document.head.appendChild(s);
  }).catch(err => {
    _kjrExcelJsPromise = null; // allow a retry on the next click
    throw err;
  });
  return _kjrExcelJsPromise;
}

// ── Header label overrides - camelCase key → house label where a plain
// title-case split would read wrong (acronyms, currency-tagged fields, etc).
const _KJR_XLSX_LABEL_OVERRIDES = {
  ebayUrl: 'eBay URL', carousellUrl: 'Carousell URL', certNo: 'Cert No',
  priceUsd: 'Price (US$)', freightSgd: 'Freight (S$)', totalSgd: 'Total (S$)',
  inventoryId: 'Inventory ID', inventoryTable: 'Inventory Table',
  targetTable: 'Target Table', priceAlert: 'Price Alert',
  id: 'ID', qty: 'Qty',
  // Sales sheet's computed replacement for the raw `margin` string field -
  // header must read "Margin", not the internal key name.
  marginFraction: 'Margin',
};
// camelCase / snake_case key → "Title Case" label, honouring the override map.
function _kjrXlsxLabel(key) {
  if (_KJR_XLSX_LABEL_OVERRIDES[key]) return _KJR_XLSX_LABEL_OVERRIDES[key];
  const spaced = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return spaced.replace(/\w\S*/g, w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// ── Column format buckets, matched by field key.
// NOTE: `declared` is deliberately NOT in this set even though an earlier
// spec listed it as currency - it's actually the eBay pipeline's "declared on
// customs form" Yes/No/N/A flag (see kjrOpenEbayModal's declaredOpts / the
// declared-cycle toggle in renderEbayPurchases), not a money amount anywhere
// in the data model. Formatting it as "S$"#,##0.00 would silently turn "Yes"
// into "S$0.00" in the export. It's left as plain text (the default bucket).
const _KJR_XLSX_SGD_KEYS = new Set(['listPrice','costPrice','marketPrice','totalCollected','shippingCost','profit','fees','totalPrice','unitPrice','freightSgd','totalSgd']);
const _KJR_XLSX_USD_KEYS = new Set(['priceUsd']);
const _KJR_XLSX_DATE_KEYS = new Set(['datePurchased','dateListed','dateSold','date']);
const _KJR_XLSX_INT_KEYS = new Set(['qty','grade']);
const _KJR_XLSX_PCT_KEYS = new Set(['marginFraction','roiPct']);

// Parse a stored date value into a real Date for Excel, via the app's own
// date helpers (dateToMs handles the canonical "D MMM YYYY" form and common
// input variants). Falls back to toDateMmmYyyy→Date, then null for anything
// genuinely unparseable so the cell stays blank rather than showing "Invalid Date".
function _kjrXlsxParseDate(val) {
  if (val == null || val === '') return null;
  const ms = dateToMs(val);
  if (ms) return new Date(ms);
  const alt = new Date(toDateMmmYyyy(val));
  if (!isNaN(alt.getTime())) return alt;
  return null;
}

// Apply per-column number format + alignment, then set the header row's own
// style AFTER (assigning ws.getColumn(n).font/alignment/numFmt clobbers the
// header cell in that column, since a column-level style applies to every
// cell in the column including row 1 - so header bold/fill must be re-applied
// last, and its numFmt cleared back to General or the header text can round-trip
// through a numeric format on reopen).
function _kjrXlsxFormatSheet(ws, keys) {
  const lexendFont = { name: 'Lexend', size: 11 };
  keys.forEach((key, idx) => {
    const col = ws.getColumn(idx + 1);
    col.font = lexendFont;
    if (_KJR_XLSX_SGD_KEYS.has(key)) {
      col.numFmt = '"S$"#,##0.00';
      col.alignment = { horizontal: 'right' };
    } else if (_KJR_XLSX_USD_KEYS.has(key)) {
      col.numFmt = '"US$"#,##0.00';
      col.alignment = { horizontal: 'right' };
    } else if (_KJR_XLSX_PCT_KEYS.has(key)) {
      col.numFmt = '0.0%';
      col.alignment = { horizontal: 'right' };
    } else if (_KJR_XLSX_DATE_KEYS.has(key)) {
      col.numFmt = 'dd/mm/yyyy';
      col.alignment = { horizontal: 'left' };
    } else if (_KJR_XLSX_INT_KEYS.has(key)) {
      // grade can be a half-step (PSA/CGC 9.5) - don't round it to an int
      col.numFmt = (key === 'grade') ? '0.#' : '0';
      col.alignment = { horizontal: 'right' };
    } else {
      col.alignment = { horizontal: 'left' };
    }
    // Auto-size, capped so one long note/URL doesn't blow the sheet out.
    const headerLen = _kjrXlsxLabel(key).length;
    let maxLen = headerLen;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cell = row.getCell(idx + 1);
      const v = cell.value;
      const len = (v == null) ? 0 : (v instanceof Date ? 10 : String(v.text != null ? v.text : v).length);
      if (len > maxLen) maxLen = len;
    });
    col.width = Math.min(Math.max(maxLen + 2, 10), 40);
  });
  // Re-assert header row style AFTER the per-column pass above, which
  // clobbers row 1 (see comment above _kjrXlsxFormatSheet).
  const header = ws.getRow(1);
  header.eachCell(cell => {
    cell.font = { name: 'Lexend', size: 11, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    cell.numFmt = 'General';
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: keys.length } };
}

// Build one sheet from an array of {key,label} column defs and an array of
// plain row objects. Always writes the header row, even for an empty dataset.
function _kjrXlsxAddSheet(workbook, sheetName, columns, rows) {
  const ws = workbook.addWorksheet(sheetName);
  ws.columns = columns.map(c => ({ header: c.label, key: c.key }));
  rows.forEach(r => {
    const rowData = {};
    columns.forEach(c => {
      let v = r[c.key];
      if (_KJR_XLSX_DATE_KEYS.has(c.key)) {
        rowData[c.key] = _kjrXlsxParseDate(v); // null → genuinely blank cell
      } else if (_KJR_XLSX_PCT_KEYS.has(c.key)) {
        rowData[c.key] = (v == null || v === '') ? null : Number(v);
      } else if (_KJR_XLSX_SGD_KEYS.has(c.key) || _KJR_XLSX_USD_KEYS.has(c.key) || _KJR_XLSX_INT_KEYS.has(c.key)) {
        rowData[c.key] = (v == null || v === '') ? null : (Number(v) || 0);
      } else {
        rowData[c.key] = (v == null) ? '' : v;
      }
    });
    ws.addRow(rowData);
  });
  _kjrXlsxFormatSheet(ws, columns.map(c => c.key));
  return ws;
}

// ── Column defs per sheet, built from {key,label} pairs so _kjrXlsxAddSheet
// stays generic. Cross-checked against the current exportCSV()/KJR_*_FIELDS
// field lists (v3.15 - post pricing-rework): Singles/Slabs additionally carry
// tcgdexId (the resolved TCGdex card id, added by the Market Price rework) -
// kept in the export so a re-import can skip the resolve step, same reason
// exportCSV() already includes it.
function _kjrXlsxCols(keys) { return keys.map(key => ({ key, label: _kjrXlsxLabel(key) })); }

const _KJR_XLSX_SINGLES_KEYS = ['id','name','set','language','type','condition','qty','listPrice','costPrice','marketPrice','status','datePurchased','priceAlert','ebayUrl','carousellUrl','tcgdexId','notes'];
const _KJR_XLSX_SLABS_KEYS   = ['id','name','grader','grade','certNo','rank','listPrice','costPrice','marketPrice','dateListed','status','priceAlert','ebayUrl','carousellUrl','tcgdexId','notes'];
const _KJR_XLSX_SALES_KEYS   = ['id','dateSold','product','buyer','costPrice','totalCollected','shippingCost','profit','marginFraction','inventoryId','inventoryTable','fees'];
const _KJR_XLSX_EBAY_FALLBACK_KEYS = ['id','date','status','product','tracking','declared','priceUsd','freightSgd','totalSgd','targetTable'];

// eBay pipeline sheet uses the union of keys actually present across every
// row (rows are a grab-bag of manually-added + AI-imported purchases with
// varying fields), with id/date/status/product floated to the front so the
// sheet reads the same way the in-app table does. Falls back to a fixed key
// list when the array is empty, so the sheet still gets a sensible header row.
function _kjrXlsxEbayKeys(rows) {
  if (!rows.length) return _KJR_XLSX_EBAY_FALLBACK_KEYS.slice();
  const front = ['id', 'date', 'status', 'product'];
  const seen = new Set(front);
  const rest = [];
  rows.forEach(r => {
    Object.keys(r).forEach(k => {
      if (!seen.has(k)) { seen.add(k); rest.push(k); }
    });
  });
  return front.concat(rest);
}

// Sales sheet: replace the raw `margin` string (e.g. "45%") with a computed
// fraction so Excel can format/sort it as a real percentage. Row is a copy
// (Object.assign) - the live DB.sales objects are never touched.
function _kjrXlsxSalesRows() {
  return (DB.sales || []).map(s => {
    const totalCollected = parseFloat(s.totalCollected) || 0;
    const profit = parseFloat(s.profit);
    const marginFraction = totalCollected > 0 && !isNaN(profit) ? (profit / totalCollected) : null;
    return Object.assign({}, s, { marginFraction });
  });
}

// Summary sheet - destructures computeDashboardStats() (app.js) so it never
// duplicates Dashboard maths. Currency rows use the SGD format, ROI and the
// export timestamp are their own rows since they don't share a format bucket
// with anything else on this sheet.
function _kjrXlsxAddSummarySheet(workbook) {
  const stats = computeDashboardStats();
  const ws = workbook.addWorksheet('Summary');
  ws.columns = [
    { header: 'Metric', key: 'metric' },
    { header: 'Value', key: 'value' },
  ];
  const currencyRows = [
    ['Total Cost Basis', stats.totalInvCost],
    ['Total Market Value (Singles + Slabs)', stats.totalMktValue],
    ['Unrealised P/L (Singles + Slabs)', stats.unrealisedPL],
    ['Realised Profit (All-Time)', stats.allTimeProfit],
  ];
  const integerRows = [
    ['Singles Available', stats.singlesAvail],
    ['Singles Sold', stats.singlesSold],
    ['Slabs Available', stats.slabsAvail],
    ['Slabs Sold', stats.slabsSold],
    ['Sealed Items In Stock', stats.sealedItemCount],
    ['Grand Total Items', stats.grandItemCount],
  ];
  currencyRows.forEach(([metric, value]) => {
    const row = ws.addRow({ metric, value });
    const cell = row.getCell(2);
    cell.numFmt = '"S$"#,##0.00';
    cell.alignment = { horizontal: 'right' };
  });
  {
    const row = ws.addRow({ metric: 'Realised ROI', value: stats.roiPct == null ? null : stats.roiPct / 100 });
    const cell = row.getCell(2);
    cell.numFmt = '0.0%';
    cell.alignment = { horizontal: 'right' };
  }
  integerRows.forEach(([metric, value]) => {
    const row = ws.addRow({ metric, value });
    const cell = row.getCell(2);
    cell.numFmt = '0';
    cell.alignment = { horizontal: 'right' };
  });
  ws.addRow({ metric: 'Export Generated At', value: new Date().toLocaleString('en-SG') });
  // Metric column left-aligned text, value column already set per-row above -
  // apply the header/frozen/filter/font pass without the SGD/date/int auto-
  // detection (this sheet's formats are set explicitly per row, not by key).
  ws.getColumn(1).font = { name: 'Lexend', size: 11 };
  ws.getColumn(1).alignment = { horizontal: 'left' };
  ws.getColumn(2).font = { name: 'Lexend', size: 11 };
  let maxLen = 'Metric'.length;
  ws.eachRow({ includeEmpty: false }, row => {
    const v = row.getCell(1).value;
    if (v && String(v).length > maxLen) maxLen = String(v).length;
  });
  ws.getColumn(1).width = Math.min(maxLen + 2, 40);
  ws.getColumn(2).width = 24;
  const header = ws.getRow(1);
  header.eachCell(cell => {
    cell.font = { name: 'Lexend', size: 11, bold: true };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E8E8' } };
    cell.numFmt = 'General';
  });
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 2 } };
  return ws;
}

// ── Entrypoint. Reads all live rows straight off DB.* (already trash-free -
// soft-deletes live in DB.trash, a separate table), builds one workbook with
// the 8 sheets in a fixed order, and downloads it. Never mutates DB, never
// calls markDirty/saveAllToSupabase - this is a read-only reporting export.
async function exportXlsx() {
  try {
    const ExcelJS = await _kjrLoadExcelJs();
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Kujira Collectibles';
    workbook.created = new Date();

    _kjrXlsxAddSummarySheet(workbook);
    _kjrXlsxAddSheet(workbook, 'Singles', _kjrXlsxCols(_KJR_XLSX_SINGLES_KEYS), DB.singles || []);
    _kjrXlsxAddSheet(workbook, 'Slabs', _kjrXlsxCols(_KJR_XLSX_SLABS_KEYS), DB.slabs || []);
    _kjrXlsxAddSheet(workbook, 'Sales', _kjrXlsxCols(_KJR_XLSX_SALES_KEYS), _kjrXlsxSalesRows());
    {
      const ebayRows = DB.ebayPurchases || [];
      _kjrXlsxAddSheet(workbook, 'eBay pipeline', _kjrXlsxCols(_kjrXlsxEbayKeys(ebayRows)), ebayRows);
    }
    _kjrXlsxAddSheet(workbook, 'ETBs', KJR_ETB_FIELDS.map(f => ({ key: f.key, label: f.label })), DB.etbs || []);
    _kjrXlsxAddSheet(workbook, 'Booster Boxes', KJR_BB_FIELDS.map(f => ({ key: f.key, label: f.label })), DB.boosterBoxes || []);
    _kjrXlsxAddSheet(workbook, 'Booster Packs', KJR_BP_FIELDS.map(f => ({ key: f.key, label: f.label })), DB.boosterPacks || []);

    const buffer = await workbook.xlsx.writeBuffer();
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = now.getFullYear();
    dl(`Collectibles Export ${dd}-${mm}-${yyyy}.xlsx`, buffer, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  } catch (e) {
    toastError('Excel export failed: ' + (e && e.message ? e.message : e));
  }
}

/* ===== Launch intro (v3.25) =====
   Self-contained IIFE, does not touch app.js. Plays a Three.js booster-pack
   rip on every launch while initDB() and cloud sync run behind it (never
   blocks the app). The #intro div and its critical inline style (index.html)
   plus the CSS in styles.css are the fallback greeting on their own -
   everything below is a progressive enhancement over that, and any failure
   here just falls back to the CSS layer already on screen.
   Choreography: a procedural Kujira booster pack (brand-toned canvas
   textures, never a real Pokemon pack design) floats centre frame, bobs and
   tilts to the pointer, then squeezes as if gripped (anticipation). Its
   crimped top strip tears off with a burst of foil motes and the body
   drops/fades (rip). Six cards launch out of the pack mouth on staggered
   tumbling arcs, two or three passing close by the camera, and settle around
   the frame (burst). The pool is the union of FEATURED_CARDS and any DB
   record with a tcgdexId (deduped), Fisher-Yates shuffled every load so the
   draw is different every reload - a smaller pool pads with procedural holo
   backs. The most valuable of the six drawn cards is always placed last so
   it eases to centre, holds at a readable scale with a glow pulse, while the
   other five drift softly around it (hit). Everything then fades into the
   fog around the same whale-icon outro as before (icon alone, 70% of frame
   width, camera frozen throughout - it never moves in this composition -
   no text), then the overlay dissolves into the app.
   Kill-switch order: settings toggle off, prefers-reduced-motion, no WebGL,
   three.js import failure. A kill-switched run shows the CSS greeting (the
   whale icon fades in for this path only) for about 1.2s then dissolves.
   First paint is decoupled from the network (redesigned v3.30): the six card
   picks are chosen SYNCHRONOUSLY from the local draw pool (ids, prices, the hit
   slot - all known without a fetch), the scene renders its first frame with all
   six cards showing the procedural holo back, and the real card art is fetched
   in the background AFTER rendering has started. Each card cross-fades from its
   holo-back placeholder to its real texture the instant that card's OWN fetch
   resolves, whenever that happens relative to the choreography (before, during,
   or after its reveal beat). A card whose fetch never resolves (slow network,
   TCGdex down) simply keeps its holo back for the whole run - it never blocks
   the scene from existing. The only hard prerequisite for first paint is the
   three.js import itself (you cannot render WebGL without the library) plus the
   whale mark, which is same-origin and SW-precached (a bounded local load, not
   external API latency). Uncontrolled TCGdex latency can no longer delay first
   paint or block the app, which was the whole v3.28/v3.29 failure class.
   Hard ceiling (v3.30): a 5s bootstrap deadline force-removes a hung load before
   the scene even starts - now covering ONLY the local three.js import plus the
   synchronous scene build plus the precached whale, no external fetch, so it is
   comfortably slack. Once the scene is running a per-frame heartbeat watchdog
   takes over (unchanged from v3.29), re-armed at the top of every rendered frame
   with one fixed 3s allowance, so as long as the WebGL loop is genuinely still
   producing frames - any pace, even very slow under real main-thread contention
   (concurrent sync/pricing/table work sharing the thread) - it is never killed;
   only a run with NO rendered frame for the whole window is truly stuck. An
   absolute 31s page-load backstop still applies regardless. Pointer movement
   only ever tilts the pack during the anticipation beat, never touches pacing.
   Only a click/tap/keydown ends the intro early, compressing straight to
   the icon fade-in (no pack physics on the skip path) plus a brief hold and
   a short dissolve tail. During the CSS-only phase or asset loading (no
   scene yet) a skip is a flat ~260ms dissolve, same as before.
   Debug: window.__introDebug.info() (safe before and after teardown) and
   .iconFit() for the outro QA probe. info().drawnCards is the six card ids
   drawn this run (last = the hit), proof of the per-load randomisation. */
(function () {
  var INTRO_KEY = 'kujira_intro_enabled';
  var CARD_DRAW_COUNT = 6;
  var ANTICIPATION_DURATION = 1.2; // pack floats, bobs, tilts, then squeezes as if gripped
  var RIP_DURATION = 0.8;          // crimp strip tears away, foil burst, pack body drops/fades
  var BURST_DURATION = 2.2;        // six cards launch, staggered ~0.35s apart, tumble and settle
  var HIT_HOLD_DURATION = 1.0;     // the most valuable card eases to centre and holds
  var T_ANT_END = ANTICIPATION_DURATION;
  var T_RIP_END = T_ANT_END + RIP_DURATION;
  var T_BURST_END = T_RIP_END + BURST_DURATION;
  var PACK_DURATION = T_BURST_END + HIT_HOLD_DURATION; // outro begins here (~5.2s), single source of truth
  var CARD_STAGGER = 0.35;
  // Burst-energy fix (v3.25 round 2): the pack body used to vanish the instant burst began (before
  // even the first card had visibly launched), so the cards read as appearing from nothing. It now
  // stays visible, tilting and dropping, at least through the 4th card's launch (3*CARD_STAGGER) plus
  // a bit more margin, then fades quickly rather than lingering stale into the hit beat.
  var PACK_BODY_HOLD_UNTIL = 4 * CARD_STAGGER; // seconds after T_RIP_END
  var PACK_BODY_FADE_TAIL = 0.4;
  var CARD_FLIGHT_DURATION = 1.05;
  var REVEAL_FADE = 0.45;          // seconds to cross-fade a card's real texture in over its holo-back placeholder once its own background fetch resolves
  var HIT_EASE_DURATION = 0.4;     // of the HIT_HOLD_DURATION budget, the rest is pure hold+pulse
  var FOIL_LIFE = 0.6;
  var OUTRO_FADE_DURATION = 1.2;   // natural: everything eases to nothing as the icon fades in
  var OUTRO_HOLD_DURATION = 0.9;   // natural hold on the icon before the overlay dissolve
  var OUTRO_FADE_ACCEL = 0.25;     // compressed icon fade-in for a click-triggered skip
  var OUTRO_HOLD_ACCEL = 0.1;      // compressed hold for a click-triggered skip
  var ICON_DEPTH = 7;              // world units ahead of the frozen camera the outro icon plane sits at
  var ICON_TARGET_FRAC = 0.7;      // target on-screen width as a fraction of frame width (spec: 65-75%) -
  // solved directly from ICON_DEPTH + the camera's vertical FOV/aspect, so the frame fraction holds across
  // desktop and mobile without a separate aspect-scale correction (kept from v3.24).
  var CAMERA_Z = 8;                // camera position is fixed for the whole run - nothing moves it, ever
  var PACK_Z = -1;                 // world z the pack floats at (9 units ahead of the fixed camera)
  var HIT_Z = -1;                  // world z the hit card settles at, same depth as the pack
  var PACK_TARGET_FRAC_W = 0.29;   // pack on-screen WIDTH as a fraction of frame width (spec: 28-30%),
  // solved directly against the camera's aspect (same trick as ICON_TARGET_FRAC below) so it holds
  // across desktop and mobile rather than an approximate height-based fraction (v3.25 round 2 fix -
  // the old height-based PACK_TARGET_FRAC_H of 0.28 actually resolved to only ~13% of frame width at
  // desktop's 16:10 aspect, reading as a small pouch rather than a pack worth ripping).
  var HIT_TARGET_FRAC_H = 0.37;    // hit card on-screen height as a fraction of frame height (spec: 35-40%)
  var FOG_NEAR_TARGET = 0.6;  // outro: fog near/far ease toward these tighter distances as the world dissolves
  var FOG_FAR_TARGET = 6;     // (icon material itself is fog:false, so it stays clear while the field is swallowed)
  var KILLSWITCH_FADE_MS = 1200;
  var DISSOLVE_MS = 260;          // flat dissolve (CSS-phase/asset-loading skip, and the natural outro's tail)
  var ACCEL_DISSOLVE_MS = 150;    // tail after an accelerated (click-triggered) outro - nominal sum with the two
  // constants above is 500ms, tuned down from v3.24's 750ms total so real setTimeout/rAF scheduling overhead
  // (observed ~100-140ms across two chained timers in QA) still lands the whole skip inside the spec's 500-650ms.
  // Ceiling scope (v3.30): with the card fetches removed from the pre-first-paint path (they now run in
  // the background and each card cross-fades in on its own resolve - see kjrIntroDrawSlots / the reveal
  // pass in tick), the bootstrap deadline no longer has to budget for any external TCGdex round trip. It
  // now covers ONLY the local three.js dynamic import, the synchronous scene build, and the same-origin
  // SW-precached whale load - all bounded, none network-external - so 5000ms is comfortably slack rather
  // than the tight race it was when a cold ~2.2s asset fetch (times up to twelve, in parallel but still
  // sharing the connection) sat inside this same window. Kept at 5000 deliberately: dropping it lower
  // would only risk killing a legitimately slow FIRST-visit import of the ~600KB vendored three.module.js
  // on a cold cache over slow mobile, for no gain now that uncontrolled API latency is out of this gate.
  var BOOTSTRAP_CEILING_MS = 5000;  // page-load-anchored: force-remove only if the scene never starts (hung import, dead build)
  // Watchdog redesign (v3.29): v3.28's rolling PER-PHASE watchdog (a fresh deadline sized off each
  // phase's own nominal duration, re-armed only at phase transitions) still assumed contention was
  // bounded within a single phase's floor. A real live-site run (~750 rows, concurrent Supabase sync,
  // TCGdex pricing queue, dashboard chart + large-table render, all sharing the main thread with the
  // intro's own WebGL work) blew through the FIRST phase's floor before a single transition ever fired -
  // a fixed per-phase time budget is the wrong tool for an unknown, potentially sustained contention
  // duration. Replaced with a per-frame HEARTBEAT (see kjrIntroArmWatchdog/HEARTBEAT_WINDOW_MS below):
  // re-armed at the top of every tick() frame with one fixed allowance, so a run that is still genuinely
  // rendering - at any pace - can never be killed; only a loop that renders NO frame at all for the
  // whole window is truly stuck.
  var HEARTBEAT_WINDOW_MS = 3000; // per-frame heartbeat allowance. Comfortably longer than any plausible
  // single main-thread stall (contention shows up as a "few hundred ms" synchronous block between
  // frames, per the real failure this fixes) so a merely-slow run always gets re-armed well before this
  // fires, while still catching a genuinely dead rAF loop within a few seconds rather than tens of them.
  var ABSOLUTE_BACKSTOP_MS = 31000; // page-load-anchored, unconditional, last resort. Re-derived v3.30 and
  // deliberately LEFT generous: the per-frame heartbeat is the real guard against main-thread contention
  // now, not this backstop, and the whole escalation was about contention truncating a healthy run - so
  // tightening this would re-introduce exactly the truncation risk we are trying to kill, for no benefit.
  // Bootstrap worst-case (5000, now a bounded local-only gate) + a natural-sequence duration under
  // SUSTAINED heavy real-device contention (23000: the ~7.6s ideal-conditions choreography - PACK_DURATION
  // 5.2s + outro fade/hold 2.1s + dissolve - tripled, grounded in the real v3.28 failure where a single
  // 1.2s phase alone absorbed 3.5s+ of zero-frame stall under genuine contention) + one heartbeat window's
  // grace (3000). This must never be the thing that fires under normal heavy load, only a true last-resort
  // net for an adversarial pile-up or a broken rAF clock.

  // Rest positions for the five non-hit cards, as FRACTIONS of the frame's
  // half-width/half-height at that card's own depth (never raw world units)
  // - the trap this avoids: a fixed x/y tuned at desktop's 16:10 reads fine
  // there but pushes cards off-frame on an iPhone's narrow portrait aspect.
  // Resolved to world units once at scene build against the actual aspect.
  var REST_FRACS = [
    { xf: -0.62, yf: 0.42, z: 1.4 },
    { xf: 0.66, yf: 0.32, z: 2.0 },
    { xf: -0.55, yf: -0.5, z: 0.7 },
    { xf: 0.58, yf: -0.42, z: 1.6 },
    { xf: 0.08, yf: 0.66, z: 2.3 },
    { xf: 0.08, yf: -0.1, z: 1.8 } // index 5 (the hit card) pre-hit rest, near centre-low
  ];
  var CLOSE_INDICES = [1, 3, 4]; // these arc closer to camera mid-flight ("passing close by the camera")
  var CARD_ORBIT_SCALE = 1.3;    // world-unit scale for the five non-hit cards (perspective handles their relative size by depth)

  var introState = 'idle';
  var introKillSwitch = null;
  var _renderer = null, _scene = null, _camera = null, _raf = null;
  var _introTimers = [];
  var _introObjectUrls = [];
  var _onPointerMove = null, _onResize = null;
  var _ending = false;
  var _removed = false;
  var _outroActive = false;
  var _accelerated = false;
  var _outroStart = 0;
  var _introRealCardCount = 0;   // of the six drawn, how many are real cards (a fetch will be attempted), vs procedural padding
  var _introResolvedCardCount = 0; // of the real cards, how many have had their texture fetch resolve and cross-fade in (climbs over the run - progressive-upgrade proof)
  var _introFeaturedCardCount = 0; // of the above, how many came from the fixed FEATURED_CARDS showcase
  var _introDrawnIds = [];       // the six drawn card ids, launch order, last = the hit - randomisation proof
  var _introDrawnPrices = [];    // parallel prices - QA proof the last slot is always the max of the six
  var _introCeilingHit = false;  // true only if HARD_CEILING force-removed the intro rather than a natural/skip dissolve
  var _introIconMesh = null, _introTHREE = null; // exposed to __introDebug.iconFit
  var _introHitCardMesh = null; // exposed to __introDebug.hitFit
  var _introPhaseLog = []; // {state, tMs} per phase transition, scene-relative - QA proof of the actual choreography timing
  var _watchdogTimerId = null;    // the one live rolling watchdog timer, cleared and re-armed at each phase transition
  var _introWatchdogArmCount = 0; // v3.29: now one arm per rendered frame (per-frame heartbeat), so this
  // is roughly frames-rendered * heartbeat-rearms-elsewhere (scene-build arm + skip/dissolve arms are
  // rare extras) - large numbers (dozens to hundreds) are healthy proof the loop kept ticking, not a bug
  var _introStartTime = 0; // performance.now() at kjrIntroMain start - HARD_CEILING and debug info only
  var _sceneStartTime = 0; // performance.now() at the first tick() call - the choreography (anticipation/
  // rip/burst/hit/outro) is measured from HERE, not from page load. Since v3.30 no card fetch is awaited
  // before the first frame (they stream in the background), so this now lands close to page load, but the
  // scene-relative anchor is still correct: it is the moment the first frame actually rendered, whatever the
  // local import/build cost was, so a slow three.js import can never shift the choreography's own timeline.
  var _kjrToastQueue = [];       // queued [msg, dur, isError] while the intro owns the top layer
  var _kjrOrigToast = null;      // the real app.js toast(), captured while intercepted
  var _kjrToastIntercepted = false;

  // ── Toast interception (v3.24, unchanged in v3.25). app.js's #toast is a
  // top-layer popover, it paints above the intro's z-index regardless, so a
  // sync-conflict toast firing mid-boot would show over the overlay.
  // toast/toastError are top-level `function` declarations in app.js (not
  // const), so both files sharing one global scope means reassigning the
  // identifier here is a real, reassignable global rebind, not a shadow -
  // every bare `toast(...)` call anywhere (including toastError's internal
  // call) resolves through it. Deferral, not suppression: nothing is
  // swallowed, it replays the instant the intro tears down. Installed only
  // once kjrIntroMain commits to eventually tearing down (after the "markup
  // missing" bail-out), so an early return there can never leave toast
  // permanently intercepted. ──
  function kjrIntroInterceptToast() {
    if (_kjrToastIntercepted || typeof toast !== 'function') return;
    _kjrOrigToast = toast;
    _kjrToastIntercepted = true;
    window.toast = function (msg, dur, isError) {
      _kjrToastQueue.push([msg, dur, isError]);
      if (_kjrToastQueue.length > 3) _kjrToastQueue.shift(); // newest 3 only, oldest dropped
    };
  }
  function kjrIntroReplayToasts() {
    if (!_kjrToastIntercepted) return;
    var orig = _kjrOrigToast;
    window.toast = orig; // restore first - replayed calls, and any new ones, hit the real toast again
    _kjrToastIntercepted = false;
    _kjrOrigToast = null;
    var queued = _kjrToastQueue.slice();
    _kjrToastQueue.length = 0;
    if (typeof orig !== 'function' || !queued.length) return;
    var delay = 0;
    queued.forEach(function (args) {
      if (delay === 0) orig(args[0], args[1], args[2]);
      else setTimeout(function () { orig(args[0], args[1], args[2]); }, delay);
      delay += args[2] ? 6000 : (typeof args[1] === 'number' ? args[1] : 2800); // mirrors toast()'s own dismiss timing
    });
  }

  // ── Settings toggle (index.html onclick="kjrToggleIntroSetting()") ──
  function kjrIntroEnabled() {
    try { return localStorage.getItem(INTRO_KEY) === 'true'; } catch (e) { return false; }
  }
  function kjrApplyIntroToggleIcon(enabled) {
    var on = document.getElementById('intro-icon-on');
    var off = document.getElementById('intro-icon-off');
    if (on) on.style.display = enabled ? '' : 'none';
    if (off) off.style.display = enabled ? 'none' : '';
  }
  window.kjrToggleIntroSetting = function () {
    var next = !kjrIntroEnabled();
    try { localStorage.setItem(INTRO_KEY, next ? 'true' : 'false'); } catch (e) { /* private mode - setting just won't persist */ }
    kjrApplyIntroToggleIcon(next);
  };
  kjrApplyIntroToggleIcon(kjrIntroEnabled());

  // ── Debug hook, always safe to call ──
  window.__introDebug = {
    get state() { return introState; },
    info: function () {
      return {
        state: introState,
        killSwitch: introKillSwitch,
        drawnCards: _introDrawnIds.slice(),
        drawnPrices: _introDrawnPrices.slice(),
        phaseLog: _introPhaseLog.slice(),
        ceilingHit: _introCeilingHit,
        watchdogArmCount: _introWatchdogArmCount,
        sceneStartTime: _sceneStartTime || null,
        outro: _outroActive,
        accelerated: _accelerated,
        realCards: _introRealCardCount,
        resolvedCards: _introResolvedCardCount,
        featuredCards: _introFeaturedCardCount,
        introStartTime: _introStartTime || null,
        cameraZ: _camera ? _camera.position.z : null,
        drawCalls: _renderer ? _renderer.info.render.calls : 0,
        geometries: _renderer ? _renderer.info.memory.geometries : 0,
        textures: _renderer ? _renderer.info.memory.textures : 0,
        removed: _removed
      };
    },
    // QA probe: projects the outro icon plane through the camera to measure its actual
    // on-screen pixel size and position, for the "65-75% of frame width, centred" spec.
    iconFit: function () {
      if (!_camera || !_renderer || !_introTHREE) return null;
      var w = _renderer.domElement.clientWidth, h = _renderer.domElement.clientHeight;
      var icon = kjrIntroProjectBox(_introTHREE, _camera, w, h, _introIconMesh);
      return {
        canvasW: w, canvasH: h, icon: icon,
        iconWidthFrac: icon ? icon.widthPx / w : null,
        iconCenterXFrac: icon ? icon.centerXPx / w : null,
        iconCenterYFrac: icon ? icon.centerYPx / h : null
      };
    },
    // QA probe: same projection for the hit card, for the "35-40% of frame height, centred" spec.
    hitFit: function () {
      if (!_camera || !_renderer || !_introTHREE) return null;
      var w = _renderer.domElement.clientWidth, h = _renderer.domElement.clientHeight;
      var card = kjrIntroProjectBox(_introTHREE, _camera, w, h, _introHitCardMesh);
      return {
        canvasW: w, canvasH: h, card: card,
        cardHeightFrac: card ? card.heightPx / h : null,
        cardCenterXFrac: card ? card.centerXPx / w : null,
        cardCenterYFrac: card ? card.centerYPx / h : null
      };
    }
  };
  // Shared by iconFit/hitFit: projects a plane mesh's geometry corners through the
  // camera to measure its actual on-screen pixel box (scale-aware via matrixWorld).
  function kjrIntroProjectBox(T, camera, w, h, mesh) {
    if (!mesh) return null;
    var hw = mesh.geometry.parameters.width / 2, hh = mesh.geometry.parameters.height / 2;
    var pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(function (p) {
      var v = new T.Vector3(p[0], p[1], 0).applyMatrix4(mesh.matrixWorld).project(camera);
      var px = (v.x * 0.5 + 0.5) * w, py = (1 - (v.y * 0.5 + 0.5)) * h;
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    });
    return { widthPx: maxX - minX, heightPx: maxY - minY, centerXPx: (minX + maxX) / 2, centerYPx: (minY + maxY) / 2 };
  }

  // ── DB access, for the pack draw pool (real TCGdex scans). DB is declared
  // `let DB = {...}` at the top level of app.js - a classic-script top-level
  // `let` is visible to features.js as the bare identifier (both scripts
  // share one global lexical scope) but is NOT a property of window.
  // window.DB is attempted first per spec, the bare identifier is the real
  // path that actually finds data today. ──
  function kjrIntroDB() {
    if (window.DB && (window.DB.singles || window.DB.slabs)) return window.DB;
    try { if (typeof DB !== 'undefined' && DB) return DB; } catch (e) { /* DB not declared yet - fall through */ }
    return null;
  }

  // ── Featured showcase: Julian's named pieces, pinned to real TCGdex ids
  // resolved ahead of time against the live API (see the v3.21 packet report
  // for the resolution table). Always in the draw pool, English region
  // (every id below is an English print), price treated as high so a
  // featured card always outranks a DB record for the "hit" beat. ──
  var FEATURED_CARDS = [
    'svp-044',    // Charmander, SVP Black Star Promo
    'xyp-XY67a',  // Jirachi, XY Black Star Promo
    'svp-131',    // Kingdra ex, SVP Black Star Promo
    'sv04.5-232', // Mew ex, Paldean Fates, Special Illustration Rare (community nickname "Bubble Mew" - see packet report)
    'xyp-XY121',  // Charizard EX, XY Black Star Promo
    'xyp-XY122',  // Blastoise EX, XY Black Star Promo
    'xyp-XY123',  // Venusaur EX, XY Black Star Promo (same XY1xx promo run as the two above)
    'smp-SM210',  // Moltres & Zapdos & Articuno GX, SM Black Star Promo (stained-glass tag team)
    'sv07-148',   // Squirtle, Stellar Crown, Illustration Rare
    'sv07-143'    // Bulbasaur, Stellar Crown, Illustration Rare
  ];

  // ── Draw pool: union of FEATURED_CARDS and any DB record with a non-empty
  // tcgdexId, deduped by id. Fisher-Yates shuffled every load - this is what
  // makes every reload a different pack. Six are drawn from a random slice
  // of the shuffled order (buffered above six for fetch failures), and
  // whichever of the six has the highest price is moved to the last (hit)
  // slot. Featured cards carry Infinity so they always count as "high". ──
  function kjrIntroBuildDrawPool() {
    var seen = {};
    var pool = [];
    FEATURED_CARDS.forEach(function (id) {
      if (seen[id]) return;
      seen[id] = 1;
      pool.push({ id: id, source: 'featured', price: Infinity });
    });
    var db = kjrIntroDB();
    var dbRecords = [].concat((db && db.singles) || [], (db && db.slabs) || []);
    dbRecords.forEach(function (r) {
      if (!r || !r.tcgdexId || seen[r.tcgdexId]) return;
      seen[r.tcgdexId] = 1;
      pool.push({ id: r.tcgdexId, source: 'db', price: parseFloat(r.marketPrice) || 0, rec: r });
    });
    return pool;
  }
  function kjrShuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  // Draw the six slots SYNCHRONOUSLY - no network (v3.30). The pool entries already carry everything the
  // choreography needs to start: id, price, featured flag. The hit (most valuable, launches last) is
  // decided here from those local prices, so it is fixed the instant the scene builds and never depends on
  // whether any art fetch wins its race - a card whose fetch is slow or fails just shows its holo back. The
  // Fisher-Yates shuffle over the union pool then taking the first six is what keeps every reload different.
  function kjrIntroDrawSlots() {
    var pool = kjrShuffle(kjrIntroBuildDrawPool());
    var slots = pool.slice(0, CARD_DRAW_COUNT).map(function (entry) {
      return { id: entry.id, price: entry.price, featured: entry.source === 'featured', procedural: false, entry: entry };
    });
    var procCounter = 0;
    while (slots.length < CARD_DRAW_COUNT) {
      slots.push({ id: 'proc-' + (procCounter++), price: -Infinity, featured: false, procedural: true, entry: null });
    }
    var hitIdx = 0;
    for (var k = 1; k < slots.length; k++) if (slots[k].price > slots[hitIdx].price) hitIdx = k;
    var hit = slots.splice(hitIdx, 1)[0];
    slots.push(hit); // the most valuable of the six always launches last (the hit beat)
    return slots;
  }
  // Fetch a single slot's real card texture in the BACKGROUND, after the scene is already rendering. Runs
  // once per real slot, fully independent of the others - it resolves to a texture (which tick() then
  // cross-fades in over that card's holo back) or to null (the card keeps its holo back for the whole run).
  // No round trip here can ever gate first paint or block the app: the scene already exists before this
  // is even called.
  async function kjrIntroFetchSlotTexture(THREE, slot) {
    var entry = slot.entry;
    if (!entry) return null;
    var lang = entry.source === 'db' && typeof _tcgdexLang === 'function' ? _tcgdexLang(entry.rec.language) : 'en';
    var res = await fetch('https://api.tcgdex.net/v2/' + encodeURIComponent(lang) + '/cards/' + encodeURIComponent(entry.id));
    if (!res.ok) return null;
    var data = await res.json();
    if (!data || !data.image) return null;
    var objUrl = await kjrIntroCachedImage(data.image + '/high.webp');
    var tex = await kjrIntroLoadTexture(THREE, objUrl);
    return tex || null;
  }

  // ── Brand asset: whale mark alone (same-origin, already SW-precached, no
  // need for the intro-art cache bucket). No wordmark, no text anywhere in
  // the WebGL scene - the icon carries the whole brand beat. Its loaded
  // Image is also reused to draw the pack front's whale mark below. ──
  async function kjrIntroBuildBrand(THREE) {
    return kjrIntroLoadTexture(THREE, './Assets/whale-icon.png');
  }

  // ── Every remote image goes through this cache bucket (match first, put
  // after fetch), never image data in localStorage. ──
  async function kjrIntroCachedImage(url) {
    try {
      var cache = await caches.open('kujira-intro-art');
      var res = await cache.match(url);
      if (!res) {
        var fresh = await fetch(url, { mode: 'cors' });
        if (!fresh || !fresh.ok) return null;
        await cache.put(url, fresh.clone());
        res = fresh;
      }
      var blob = await res.blob();
      var objUrl = URL.createObjectURL(blob);
      _introObjectUrls.push(objUrl);
      return objUrl;
    } catch (e) { return null; }
  }
  function kjrIntroLoadTexture(THREE, objectUrl) {
    return new Promise(function (resolve) {
      if (!objectUrl) { resolve(null); return; }
      var img = new Image();
      img.onload = function () {
        try {
          var tex = new THREE.Texture(img);
          if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
          tex.needsUpdate = true;
          resolve(tex);
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = objectUrl;
    });
  }

  function kjrIntroHasWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  // ── Procedural assets (brand-toned, never the official card back or pack design) ──
  function kjrIntroCardBackTexture(THREE) {
    var w = 256, h = 358;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#241E42'); grad.addColorStop(0.5, '#3A2F6E'); grad.addColorStop(1, '#2E2752');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(139,124,240,0.12)'; ctx.lineWidth = 10;
    for (var i = -h; i < w + h; i += 26) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    var r = 22;
    ctx.strokeStyle = 'rgba(234,231,245,0.5)'; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(r, 3); ctx.arcTo(w - 3, 3, w - 3, h - 3, r); ctx.arcTo(w - 3, h - 3, 3, h - 3, r);
    ctx.arcTo(3, h - 3, 3, 3, r); ctx.arcTo(3, 3, w - 3, 3, r); ctx.closePath(); ctx.stroke();
    ctx.fillStyle = 'rgba(234,231,245,0.85)';
    ctx.font = '700 26px Lexend, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('K', w / 2, h / 2);
    return new THREE.CanvasTexture(c);
  }
  // Pack front: brand gradient, a static faint diagonal foil texture baked in (the genuinely moving
  // sweep is a separate overlay layer, see kjrIntroPackSweepTexture below), whale mark large and
  // centred (drawn from the already-loaded outro icon Image, never re-fetched), a keyline border plus
  // a soft rim highlight - never a real Pokemon pack design.
  function kjrIntroPackFrontTexture(THREE, whaleImg) {
    var w = 512, h = 712;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#12101F'); grad.addColorStop(1, '#2E2752');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(139,124,240,0.1)'; ctx.lineWidth = 20;
    for (var i = -h; i < w + h; i += 64) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = 'rgba(139,124,240,0.55)'; ctx.lineWidth = 8;
    ctx.strokeRect(14, 14, w - 28, h - 28);
    // Subtle rim highlight, just inside the keyline - a soft pale edge with a little glow so the
    // dark pack silhouette separates from the dark scene background instead of reading as a flat void.
    ctx.save();
    ctx.shadowColor = 'rgba(234,231,245,0.4)'; ctx.shadowBlur = 20;
    ctx.strokeStyle = 'rgba(234,231,245,0.3)'; ctx.lineWidth = 3;
    ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.restore();
    if (whaleImg) {
      try {
        var iw = w * 0.62, ih = iw * (whaleImg.height / whaleImg.width || 1);
        ctx.save();
        ctx.shadowColor = 'rgba(139,124,240,0.65)'; ctx.shadowBlur = 34;
        ctx.drawImage(whaleImg, (w - iw) / 2, (h - ih) / 2, iw, ih);
        ctx.restore();
      } catch (e) { /* whale mark just skipped, gradient/sheen still reads */ }
    }
    return new THREE.CanvasTexture(c);
  }
  function kjrIntroPackBackTexture(THREE) {
    var w = 512, h = 712;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#12101F'); grad.addColorStop(1, '#241E42');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = 'rgba(139,124,240,0.08)'; ctx.lineWidth = 20;
    for (var i = -h; i < w + h; i += 44) {
      ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + h, h); ctx.stroke();
    }
    return new THREE.CanvasTexture(c);
  }
  // Moving holo sweep, layered separately in front of the static branded front face (v3.25 round 2
  // fix - an earlier attempt animated the offset of the WHOLE baked front texture, which dragged the
  // whale mark and border along with it and wrapped into a visible duplicate, a real bug caught in
  // this round's own QA screenshots). A single soft diagonal band on an otherwise transparent canvas,
  // repeat-wrapped and offset-animated in tick(), reads as one clean sheen passing over the pack.
  function kjrIntroPackSweepTexture(THREE) {
    var s = 128;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var ctx = c.getContext('2d');
    var grad = ctx.createLinearGradient(0, 0, s, s);
    grad.addColorStop(0, 'rgba(139,124,240,0)');
    grad.addColorStop(0.36, 'rgba(139,124,240,0)');
    grad.addColorStop(0.5, 'rgba(180,168,240,0.4)');
    grad.addColorStop(0.64, 'rgba(139,124,240,0)');
    grad.addColorStop(1, 'rgba(139,124,240,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(c);
  }
  function kjrIntroCrimpTexture(THREE) {
    var w = 512, h = 96;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#1c1730'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(139,124,240,0.5)';
    var toothW = 22;
    for (var x = 0; x < w; x += toothW * 2) {
      ctx.beginPath();
      ctx.moveTo(x, h); ctx.lineTo(x + toothW / 2, 0); ctx.lineTo(x + toothW, h);
      ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(234,231,245,0.4)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, h - 3); ctx.lineTo(w, h - 3); ctx.stroke();
    return new THREE.CanvasTexture(c);
  }
  function kjrIntroMoteTexture(THREE) {
    var s = 64;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.4, 'rgba(200,190,255,0.6)'); g.addColorStop(1, 'rgba(139,124,240,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(c);
  }
  function kjrIntroGlowTexture(THREE) {
    var s = 128;
    var c = document.createElement('canvas');
    c.width = c.height = s;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(139,124,240,0.55)'); g.addColorStop(1, 'rgba(139,124,240,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(c);
  }

  function kjrEaseOutCubic(p) { var q = 1 - p; return 1 - q * q * q; }
  function kjrLerp(a, b, k) { return a + (b - a) * k; }
  function kjrClamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  // ── Per-frame heartbeat watchdog (v3.29). One reusable helper. Armed once before the first frame
  // (covers the scene-build-to-first-frame gap) then re-armed at the TOP of every single tick() frame
  // thereafter, with the same fixed HEARTBEAT_WINDOW_MS allowance every time - not sized off any phase's
  // duration, because a phase's OWN nominal length says nothing about how long real-device contention
  // might delay it. As long as tick() keeps getting called, at any pace, the deadline never arrives; only
  // a loop that stops rendering entirely for the whole window gets caught. Fires the exact same
  // kjrIntroForceRemove teardown path as the old fixed ceiling. ──
  function kjrIntroArmWatchdog(ms) {
    if (_watchdogTimerId) clearTimeout(_watchdogTimerId);
    _watchdogTimerId = setTimeout(function () { _introCeilingHit = true; kjrIntroForceRemove(); }, ms);
    _introTimers.push(_watchdogTimerId);
    _introWatchdogArmCount++;
  }

  // ── Scene build + animate + icon outro. Throws bubble to kjrIntroMain's catch. ──
  async function kjrIntroBuildScene(THREE, stageEl) {
    _introTHREE = THREE; // for __introDebug.iconFit's on-screen projection
    var coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);

    // Card picks are synchronous and local (v3.30) - no fetch, so the scene can build and paint its first
    // frame immediately. Only the whale mark is awaited, and it is same-origin + SW-precached (a bounded
    // local load, not external API latency). The six real card textures are fetched in the background below.
    var drawnSlots = kjrIntroDrawSlots();
    // Guard: a pool smaller than six pads procedural rather than crash (never happens with 10 featured, kept for safety).
    while (drawnSlots.length < CARD_DRAW_COUNT) drawnSlots.push({ id: 'proc-fallback-' + drawnSlots.length, price: -Infinity, featured: false, procedural: true, entry: null });
    _introDrawnIds = drawnSlots.map(function (d) { return d.id; });
    _introDrawnPrices = drawnSlots.map(function (d) { return d.price; }); // QA proof the hit (last slot) is always the max
    _introRealCardCount = drawnSlots.filter(function (d) { return !d.procedural; }).length;
    _introFeaturedCardCount = drawnSlots.filter(function (d) { return d.featured; }).length;

    var whaleTex = await kjrIntroBuildBrand(THREE).catch(function () { return null; });

    if (_ending) return; // user skipped while the whale was loading - do not build anything else

    var scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x12101F, 5, 16);
    var camera = new THREE.PerspectiveCamera(55, Math.max(1, stageEl.clientWidth) / Math.max(1, stageEl.clientHeight), 0.1, 100);
    camera.position.set(0, 0, CAMERA_Z); // fixed for the whole run - the pack and cards move, the camera never does
    var renderer = new THREE.WebGLRenderer({ antialias: !coarsePointer, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.setSize(stageEl.clientWidth, stageEl.clientHeight);
    stageEl.appendChild(renderer.domElement);
    _renderer = renderer; _scene = scene; _camera = camera;

    var vFovRad = camera.fov * Math.PI / 180;
    function kjrWorldHalfH(z) { return (CAMERA_Z - z) * Math.tan(vFovRad / 2); }
    function kjrWorldHeightForFrac(frac, z) { return frac * 2 * kjrWorldHalfH(z); }

    // Motes: ambient background dust, unrelated to the pack choreography, kept throughout.
    var moteCount = coarsePointer ? 300 : 600;
    var positions = new Float32Array(moteCount * 3);
    for (var mi = 0; mi < moteCount; mi++) {
      positions[mi * 3] = (Math.random() - 0.5) * 22;
      positions[mi * 3 + 1] = (Math.random() - 0.5) * 14;
      positions[mi * 3 + 2] = 4 - Math.random() * 26;
    }
    var moteGeo = new THREE.BufferGeometry();
    moteGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var moteMat = new THREE.PointsMaterial({ size: 0.13, map: kjrIntroMoteTexture(THREE), transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false, color: 0x8B7CF0, sizeAttenuation: true });
    var motes = new THREE.Points(moteGeo, moteMat);
    scene.add(motes);

    // The pack: puffed box (front/back canvas textures, plain side colour), plus a
    // separate crimped top-strip plane that detaches and rips away independently.
    var whaleImg = whaleTex && whaleTex.image;
    var packFrontTex = kjrIntroPackFrontTexture(THREE, whaleImg);
    var packBackTex = kjrIntroPackBackTexture(THREE);
    // Width-first sizing (PACK_TARGET_FRAC_W), height derived from the pack's own portrait ratio -
    // aspect-scaled via kjrWorldHalfH so the 28-30% frame-width target holds on desktop and mobile alike.
    var packWidth = PACK_TARGET_FRAC_W * 2 * kjrWorldHalfH(PACK_Z) * camera.aspect;
    var packHeight = packWidth / 0.72;
    var packDepth = packHeight * 0.14;
    // fog:false on every pack-body material - v3.25 round 2 fix. The scene fog colour (0x12101F) is
    // literally the pack front texture's own top gradient stop, so at the pack's fogged depth the
    // default fog:true blend was flattening it toward its own darkest tone - the root cause of the
    // "washed-out grey pouch" defect. The outro icon plane already uses this same fog:false trick.
    var sideMat = new THREE.MeshBasicMaterial({ color: 0x1c1730, transparent: true, opacity: 1, fog: false });
    var frontMat = new THREE.MeshBasicMaterial({ map: packFrontTex, transparent: true, opacity: 1, fog: false });
    var backMat = new THREE.MeshBasicMaterial({ map: packBackTex, transparent: true, opacity: 1, fog: false });
    var packBody = new THREE.Mesh(new THREE.BoxGeometry(packWidth, packHeight, packDepth), [sideMat, sideMat, sideMat, sideMat, frontMat, backMat]);
    var packGroup = new THREE.Group();
    packGroup.position.set(0, 0, PACK_Z);
    packGroup.add(packBody);

    // Moving holo sweep overlay - a separate plane just in front of the front face, child of packBody
    // so it inherits the squeeze/tilt/drop for free. Only this texture's offset animates (see tick()).
    var sweepTex = kjrIntroPackSweepTexture(THREE);
    sweepTex.wrapS = THREE.RepeatWrapping;
    var sweepMat = new THREE.MeshBasicMaterial({ map: sweepTex, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    var sweepMesh = new THREE.Mesh(new THREE.PlaneGeometry(packWidth, packHeight), sweepMat);
    sweepMesh.position.set(0, 0, packDepth / 2 + 0.004);
    packBody.add(sweepMesh);

    var crimpHeight = packHeight * 0.16;
    var crimpMat = new THREE.MeshBasicMaterial({ map: kjrIntroCrimpTexture(THREE), transparent: true, opacity: 1, side: THREE.FrontSide, depthWrite: false, fog: false });
    var crimpMesh = new THREE.Mesh(new THREE.PlaneGeometry(packWidth * 1.03, crimpHeight), crimpMat);
    crimpMesh.position.set(0, packHeight / 2 - crimpHeight / 2, packDepth / 2 + 0.01);
    packGroup.add(crimpMesh);
    scene.add(packGroup);

    // Foil burst at the tear line: a small JS-driven Points system, dormant (opacity 0)
    // until the rip triggers it once, then eases out over FOIL_LIFE.
    var foilCount = 70;
    var foilPos = new Float32Array(foilCount * 3);
    var foilVel = new Float32Array(foilCount * 3);
    var foilGeo = new THREE.BufferGeometry();
    foilGeo.setAttribute('position', new THREE.BufferAttribute(foilPos, 3));
    var foilMat = new THREE.PointsMaterial({ size: 0.05, map: kjrIntroMoteTexture(THREE), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, color: 0xEAE7F5, sizeAttenuation: true });
    var foilMotes = new THREE.Points(foilGeo, foilMat);
    scene.add(foilMotes);
    var foilTriggered = false, foilStartT = 0;
    // Re-triggerable burst (v3.25 round 2 burst-energy fix): called once on the rip tear and again on
    // each card's launch, resetting the shared buffer each time so the mote burst persists through the
    // whole burst beat as a series of small energetic puffs timed with the staggered launches, rather
    // than one burst that fades out long before the last cards fly.
    function kjrIntroFoilBurst(originY, originZ, intensity, tNow) {
      foilTriggered = true; foilStartT = tNow;
      for (var fi = 0; fi < foilCount; fi++) {
        foilPos[fi * 3] = (Math.random() - 0.5) * packWidth;
        foilPos[fi * 3 + 1] = originY;
        foilPos[fi * 3 + 2] = originZ;
        foilVel[fi * 3] = (Math.random() - 0.5) * 2.4 * intensity;
        foilVel[fi * 3 + 1] = (0.6 + Math.random() * 1.8) * intensity;
        foilVel[fi * 3 + 2] = (0.4 + Math.random() * 1.2) * intensity;
      }
      foilGeo.attributes.position.needsUpdate = true;
      foilMat.opacity = 1;
    }

    // Six cards drawn this load, resolved to world rest positions (fractional, see REST_FRACS).
    var cardGeo = new THREE.PlaneGeometry(1, 1.4);
    var cardBackTex = kjrIntroCardBackTexture(THREE);
    var hitTargetScale = kjrWorldHeightForFrac(HIT_TARGET_FRAC_H, HIT_Z) / 1.4;
    var glowTex = kjrIntroGlowTexture(THREE);
    var cards = [];
    for (var ci = 0; ci < CARD_DRAW_COUNT; ci++) {
      var slot = drawnSlots[ci];
      // Base layer is ALWAYS the procedural holo back - what the card shows before, or forever without, its
      // real art. Its real front is a separate overlay child (below), cross-faded in only once this card's
      // own background fetch resolves.
      var mat = new THREE.MeshBasicMaterial({ map: cardBackTex, transparent: true, opacity: 0, side: THREE.FrontSide, depthWrite: false, fog: true });
      var mesh = new THREE.Mesh(cardGeo, mat);
      scene.add(mesh);
      // Real-texture overlay: same plane a hair in front, child of the base so it inherits every flight /
      // settle / hit / outro transform for free. Hidden until this card's fetch lands (see reveal pass in tick).
      var frontMat = new THREE.MeshBasicMaterial({ map: cardBackTex, transparent: true, opacity: 0, side: THREE.FrontSide, depthWrite: false, fog: true });
      var frontMesh = new THREE.Mesh(cardGeo, frontMat);
      frontMesh.position.z = 0.002;
      frontMesh.visible = false;
      mesh.add(frontMesh);
      var rf = REST_FRACS[ci];
      cards.push({
        mesh: mesh, mat: mat, slot: slot,
        frontMesh: frontMesh, frontMat: frontMat, realReady: false, revealP: 0,
        isHit: ci === CARD_DRAW_COUNT - 1,
        launchAt: T_RIP_END + ci * CARD_STAGGER,
        startPos: { x: (ci - 2.5) * 0.15, y: packHeight * 0.32, z: PACK_Z + packDepth * 0.6 },
        restPos: { x: rf.xf * kjrWorldHalfH(rf.z) * camera.aspect, y: rf.yf * kjrWorldHalfH(rf.z), z: rf.z },
        closeHump: CLOSE_INDICES.indexOf(ci) !== -1 ? 1.6 : 0,
        arcLift: 0.9 + Math.random() * 0.4,
        spinY: (Math.random() * 2 + 2) * (Math.random() < 0.5 ? -1 : 1),
        spinX: (Math.random() - 0.5) * 2, spinZ: (Math.random() - 0.5) * 2,
        finalTilt: { x: (Math.random() - 0.5) * 0.2, y: (Math.random() - 0.5) * 0.25, z: (Math.random() - 0.5) * 0.15 },
        bobPhase: Math.random() * Math.PI * 2,
        settled: false,
        foilBurstDone: false // triggers a small mote puff the instant this card launches
      });
    }
    var hitCard = cards[CARD_DRAW_COUNT - 1];
    _introHitCardMesh = hitCard.mesh; // exposed to __introDebug.hitFit
    var hitGlowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x8B7CF0, opacity: 0 });
    var hitGlow = new THREE.Sprite(hitGlowMat);
    scene.add(hitGlow);

    // Outro icon: the whale mark alone, built now (texture already loaded) but sized
    // and positioned only once the outro begins (see kjrIntroBeginOutro/tick below).
    var introIconMesh = null, introIconMat = null, introIconGlow = null, introIconGlowMat = null, iconAspect = 1;
    if (whaleTex) {
      iconAspect = (whaleTex.image && whaleTex.image.width && whaleTex.image.height) ? whaleTex.image.width / whaleTex.image.height : 1;
      introIconMat = new THREE.MeshBasicMaterial({ map: whaleTex, transparent: true, depthWrite: false, fog: false, opacity: 0 });
      introIconMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1 / iconAspect), introIconMat);
      scene.add(introIconMesh);
      introIconGlowMat = new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0x8B7CF0, opacity: 0, fog: false });
      introIconGlow = new THREE.Sprite(introIconGlowMat);
      scene.add(introIconGlow);
      _introIconMesh = introIconMesh; // exposed to __introDebug.iconFit
    }

    // ── Animate ──
    var lastT = 0;
    var pointerTX = 0, pointerTY = 0, pointerX = 0, pointerY = 0;
    var canvasFadedIn = false;
    var fogNear0 = scene.fog.near, fogFar0 = scene.fog.far;
    var outroCaptured = false;
    var holdEntered = false;
    var ripTriggered = false, packHidden = false, burstEntered = false;
    var hitCaptured = false, hitStartT = 0;
    var hitStartPos = null, hitStartRot = null, hitStartScale = 1;

    // Pointer movement only ever tilts the pack during anticipation (parallax), it
    // never reaches pacing/timing - only a click (kjrIntroSkip) can affect that, via
    // kjrIntroBeginOutro. Once the outro begins nothing is pointer-driven any more.
    function onPointerMove(e) {
      if (coarsePointer) return;
      pointerTX = (e.clientX / window.innerWidth) * 2 - 1;
      pointerTY = (e.clientY / window.innerHeight) * 2 - 1;
    }
    function onResize() {
      if (!_renderer || !_camera) return;
      var w = stageEl.clientWidth, h = stageEl.clientHeight;
      if (!w || !h) return;
      _camera.aspect = w / h;
      _camera.updateProjectionMatrix();
      _renderer.setSize(w, h);
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('resize', onResize);
    _onPointerMove = onPointerMove;
    _onResize = onResize;

    function kjrUpdateCardFlight(card, t) {
      var p = kjrClamp01((t - card.launchAt) / CARD_FLIGHT_DURATION);
      if (t < card.launchAt) { card.mat.opacity = 0; return; }
      var ease = kjrEaseOutCubic(p);
      var rotFactor = 1 - ease;
      card.mesh.position.set(
        kjrLerp(card.startPos.x, card.restPos.x, ease),
        kjrLerp(card.startPos.y, card.restPos.y, ease) + card.arcLift * Math.sin(p * Math.PI),
        kjrLerp(card.startPos.z, card.restPos.z, ease) + card.closeHump * Math.sin(p * Math.PI)
      );
      card.mesh.rotation.set(
        card.finalTilt.x * ease + Math.sin(p * Math.PI * card.spinX * 2) * rotFactor * 1.1,
        card.finalTilt.y * ease + card.spinY * Math.PI * 2 * rotFactor,
        card.finalTilt.z * ease + Math.sin(p * Math.PI * card.spinZ * 2) * rotFactor
      );
      var pop = CARD_ORBIT_SCALE * (0.6 + 0.4 * Math.min(1, p / 0.15));
      card.mesh.scale.set(pop, pop, 1);
      card.mat.opacity = Math.min(1, p / 0.2);
      if (p >= 1 && !card.settled) card.settled = true;
      if (card.settled) {
        card.mesh.position.x = card.restPos.x + Math.sin(t * 0.5 + card.bobPhase) * 0.05;
        card.mesh.position.y = card.restPos.y + Math.sin(t * 0.9 + card.bobPhase) * 0.08;
        card.mesh.rotation.z = card.finalTilt.z + Math.sin(t * 0.6 + card.bobPhase) * 0.03;
      }
    }

    function tick() {
      _raf = requestAnimationFrame(tick);
      kjrIntroArmWatchdog(HEARTBEAT_WINDOW_MS); // heartbeat: this frame actually ran, so re-arm fresh regardless of pace
      try {
        var t = (performance.now() - _sceneStartTime) / 1000; // seconds since the scene actually started rendering
        var dt = Math.min(0.05, Math.max(0, t - lastT)); lastT = t;
        if (!_introPhaseLog.length || _introPhaseLog[_introPhaseLog.length - 1].state !== introState) {
          _introPhaseLog.push({ state: introState, tMs: Math.round(t * 1000) });
        }

        if (coarsePointer) {
          pointerX = Math.sin(t * 0.3) * 0.4;
          pointerY = Math.cos(t * 0.24) * 0.2;
        } else {
          pointerX += (pointerTX - pointerX) * 0.04;
          pointerY += (pointerTY - pointerY) * 0.04;
        }
        if (!_outroActive && t >= PACK_DURATION) kjrIntroBeginOutro(false);
        if (!packHidden) sweepTex.offset.x = (sweepTex.offset.x + dt * 0.35) % 1; // moving holo sweep while the pack is onscreen

        if (_outroActive) {
          if (!outroCaptured) {
            outroCaptured = true;
            if (introIconMesh) {
              var vFov = camera.fov * Math.PI / 180;
              var halfH = ICON_DEPTH * Math.tan(vFov / 2);
              var halfW = halfH * camera.aspect;
              var iconW = ICON_TARGET_FRAC * 2 * halfW;
              var iconH = iconW / iconAspect;
              introIconMesh.scale.set(iconW, iconH, 1);
              introIconMesh.position.set(camera.position.x, camera.position.y, camera.position.z - ICON_DEPTH);
              introIconGlow.scale.set(iconW * 1.7, iconH * 1.7, 1);
              introIconGlow.position.set(camera.position.x, camera.position.y, camera.position.z - ICON_DEPTH - 0.05);
            }
          }
          var fadeDur = _accelerated ? OUTRO_FADE_ACCEL : OUTRO_FADE_DURATION;
          var holdDur = _accelerated ? OUTRO_HOLD_ACCEL : OUTRO_HOLD_DURATION;
          var elapsed = t - _outroStart;

          var fadeK = Math.min(1, elapsed / fadeDur);
          fadeK = fadeK * fadeK * (3 - 2 * fadeK);
          var worldOpacity = 1 - fadeK;
          if (packGroup.visible) { frontMat.opacity = backMat.opacity = sideMat.opacity = worldOpacity; sweepMat.opacity = 0.35 * worldOpacity; }
          if (crimpMesh.visible) { crimpMat.opacity = worldOpacity; }
          cards.forEach(function (c) { c.mat.opacity = worldOpacity; });
          hitGlowMat.opacity = Math.min(hitGlowMat.opacity, worldOpacity);
          foilMat.opacity = Math.min(foilMat.opacity, worldOpacity);
          moteMat.opacity = 0.75 * worldOpacity;
          scene.fog.near = fogNear0 + (FOG_NEAR_TARGET - fogNear0) * fadeK;
          scene.fog.far = fogFar0 + (FOG_FAR_TARGET - fogFar0) * fadeK;

          if (introIconMat) { introIconMat.opacity = fadeK; introIconGlowMat.opacity = fadeK * 0.5; }

          var holdK = Math.max(0, Math.min(1, (elapsed - fadeDur) / holdDur));
          if (holdK > 0 && !holdEntered) { holdEntered = true; } // entering outro hold (heartbeat above already covers this)
          if (!_accelerated) introState = holdK > 0 ? 'holding' : 'outro'; // debug/test visibility - accelerated stays 'skipped'
        } else {
          if (t < T_ANT_END) {
            introState = 'anticipation';
            var bobY = Math.sin(t * 1.3) * 0.08;
            var tiltX = pointerY * 0.06, tiltY = pointerX * 0.09;
            var squeezeWindow = kjrClamp01((t - 0.7) / 0.5);
            var squeeze = squeezeWindow * Math.sin(t * 38) * 0.028;
            packGroup.position.set(0, bobY, PACK_Z);
            packGroup.rotation.set(tiltX, tiltY, 0);
            packBody.scale.set(1 - squeeze, 1 + squeeze * 0.6, 1);
          } else if (t < T_RIP_END) {
            introState = 'rip';
            if (!ripTriggered) {
              ripTriggered = true;
              scene.attach(crimpMesh); // detaches from packGroup, preserving its current world transform
              var tearY = crimpMesh.position.y;
              kjrIntroFoilBurst(tearY, PACK_Z + packDepth, 1, t);
            }
            var ripP = (t - T_ANT_END) / RIP_DURATION;
            crimpMesh.position.y += 1.6 * dt;
            crimpMesh.position.z += 1.0 * dt;
            crimpMesh.rotation.x += 2.2 * dt;
            crimpMat.opacity = 1 - ripP;
            packGroup.position.y -= 0.5 * dt;
            // Pack body itself stays fully visible through the rip (only the crimp strip fades here) -
            // it keeps tilting/dropping and only fades once enough cards have burst out, below.
          } else {
            if (!burstEntered) { burstEntered = true; } // entering burst (heartbeat above already covers this)
            if (t < T_RIP_END + PACK_BODY_HOLD_UNTIL + PACK_BODY_FADE_TAIL) {
              // still onscreen: keep tilting and dropping so the cards read as bursting out of the
              // pack, not appearing from nothing (v3.25 round 2 burst-energy fix)
              packGroup.position.y -= 0.35 * dt;
              packGroup.rotation.x += 0.5 * dt;
              packGroup.rotation.z += 0.25 * dt;
              var bodyFadeP = kjrClamp01((t - (T_RIP_END + PACK_BODY_HOLD_UNTIL)) / PACK_BODY_FADE_TAIL);
              frontMat.opacity = backMat.opacity = sideMat.opacity = 1 - bodyFadeP;
              sweepMat.opacity = 0.35 * (1 - bodyFadeP);
            } else if (!packHidden) {
              packHidden = true; packGroup.visible = false; crimpMesh.visible = false;
            }
            if (t < T_BURST_END) introState = 'burst'; else introState = 'hit';

            if (!hitCaptured && t >= T_BURST_END) {
              hitCaptured = true; hitStartT = t; // entering hit (heartbeat above already covers this)
              hitStartPos = hitCard.mesh.position.clone();
              hitStartRot = hitCard.mesh.rotation.clone();
              hitStartScale = hitCard.mesh.scale.x;
            }
            for (var i = 0; i < cards.length; i++) {
              var card = cards[i];
              if (!card.foilBurstDone && t >= card.launchAt) {
                card.foilBurstDone = true;
                kjrIntroFoilBurst(card.startPos.y, card.startPos.z, 0.65, t); // a mote puff per launch keeps the burst feeling alive throughout, not just at the rip
              }
              if (card.isHit && hitCaptured) {
                var p2 = kjrClamp01((t - hitStartT) / HIT_EASE_DURATION);
                var e2 = kjrEaseOutCubic(p2);
                card.mesh.position.set(
                  kjrLerp(hitStartPos.x, 0, e2), kjrLerp(hitStartPos.y, 0, e2), kjrLerp(hitStartPos.z, HIT_Z, e2)
                );
                card.mesh.rotation.set(
                  kjrLerp(hitStartRot.x, 0, e2), kjrLerp(hitStartRot.y, 0, e2), kjrLerp(hitStartRot.z, 0, e2)
                );
                var hs = kjrLerp(hitStartScale, hitTargetScale, e2);
                card.mesh.scale.set(hs, hs, 1);
                card.mat.opacity = 1;
                hitGlow.position.copy(card.mesh.position);
                hitGlow.scale.set(hs * 1.9, hs * 1.9 * 1.4, 1);
                if (p2 >= 1) {
                  hitGlowMat.opacity = 0.4 + Math.sin((t - hitStartT) * 3) * 0.15;
                } else {
                  hitGlowMat.opacity = e2 * 0.5;
                }
              } else {
                kjrUpdateCardFlight(card, t);
              }
            }
          }
        }

        // Foil decay/motion, unconditional so it keeps running across rip/burst/hit (previously nested
        // only inside the rip branch, which silently froze the motes the instant burst began - the
        // root cause of the "empty, no particles" burst defect). Skipped once the outro's own fade
        // takes over foilMat.opacity via the min() blend above.
        if (!_outroActive && foilTriggered) {
          var foilElapsed = t - foilStartT;
          if (foilElapsed < FOIL_LIFE) {
            var fpos = foilGeo.attributes.position.array;
            for (var pi = 0; pi < foilCount; pi++) {
              fpos[pi * 3] += foilVel[pi * 3] * dt;
              fpos[pi * 3 + 1] += foilVel[pi * 3 + 1] * dt;
              foilVel[pi * 3 + 1] -= 0.8 * dt; // gentle gravity, foil arcs then settles
              fpos[pi * 3 + 2] += foilVel[pi * 3 + 2] * dt;
            }
            foilGeo.attributes.position.needsUpdate = true;
            foilMat.opacity = 1 - (foilElapsed / FOIL_LIFE);
          } else {
            foilMat.opacity = 0;
          }
        }

        // Progressive real-texture reveal (v3.30): each overlay tracks its own card's base opacity, so the
        // cross-fade respects that card's flight fade-in and the outro fade-out, and eases in over REVEAL_FADE
        // from the moment its background fetch resolved - whenever in the choreography that happens to land.
        for (var rvi = 0; rvi < cards.length; rvi++) {
          var rvc = cards[rvi];
          if (!rvc.frontMesh.visible) continue;
          if (rvc.realReady && rvc.revealP < 1) rvc.revealP = kjrClamp01(rvc.revealP + dt / REVEAL_FADE);
          rvc.frontMat.opacity = rvc.mat.opacity * rvc.revealP;
        }

        renderer.render(scene, camera);
        if (!canvasFadedIn) {
          canvasFadedIn = true;
          renderer.domElement.classList.add('kjr-in'); // #intro-word stays hidden throughout a scene run - it's kill-switch-only now
        }
      } catch (e) {
        kjrIntroForceRemove(e);
      }
    }
    // Kick off the six real-card fetches in the BACKGROUND, now that the scene is fully built and about to
    // render (v3.30). Each resolves independently; the winning texture is stashed on its card and the reveal
    // pass in tick() cross-fades it in over the holo back. A fetch that fails or never returns just leaves the
    // holo back in place. This runs AFTER the whole scene exists, so no round trip here can delay first paint.
    cards.forEach(function (card) {
      if (!card.slot || card.slot.procedural) return;
      kjrIntroFetchSlotTexture(THREE, card.slot).then(function (tex) {
        if (!tex) return;
        if (_removed) { try { tex.dispose(); } catch (e) {} return; } // resolved after teardown - dispose the orphan, do not touch a torn-down scene
        card.frontMat.map = tex;
        card.frontMat.needsUpdate = true;
        card.frontMesh.visible = true;
        card.realReady = true; // tick() eases revealP 0 -> 1 from here
        _introResolvedCardCount++;
      }).catch(function () { /* card keeps its holo back for the rest of the run */ });
    });

    introState = 'scene';
    _sceneStartTime = performance.now();
    // Per-frame heartbeat takes over from here (v3.29) - one initial arm now covers the scene-build-to
    // -first-frame gap (tick() hasn't run yet to re-arm itself), then tick() re-arms fresh at the top of
    // every subsequent frame for the rest of the run (see kjrIntroArmWatchdog).
    kjrIntroArmWatchdog(HEARTBEAT_WINDOW_MS);
    tick();
  }

  // Begins the icon outro, natural or accelerated (compressed). Idempotent via
  // _outroActive - a click during an already-active outro (natural or a prior
  // click) is a no-op here, the teardown it already scheduled is imminent either way.
  function kjrIntroBeginOutro(accelerated) {
    if (_outroActive) return;
    _outroActive = true;
    _accelerated = accelerated;
    introState = accelerated ? 'skipped' : 'outro';
    _outroStart = (performance.now() - _sceneStartTime) / 1000;
    var fadeDur = accelerated ? OUTRO_FADE_ACCEL : OUTRO_FADE_DURATION;
    var holdDur = accelerated ? OUTRO_HOLD_ACCEL : OUTRO_HOLD_DURATION;
    var tailMs = accelerated ? ACCEL_DISSOLVE_MS : DISSOLVE_MS;
    // entering the outro fade - tick() is still running and re-arming the heartbeat every frame, no
    // separate arm needed here
    _introTimers.push(setTimeout(function () { kjrIntroDissolve(tailMs); }, (fadeDur + holdDur) * 1000));
  }

  function kjrIntroSkip() {
    // _outroActive guards a second click/key during the accelerated outro (kjrIntroBeginOutro
    // already sets it synchronously) - deliberately NOT setting _ending here, that belongs to
    // kjrIntroDissolve alone, or its deferred call from kjrIntroBeginOutro would find _ending
    // already true and silently no-op, and teardown would never fire.
    if (_ending || _outroActive) return;
    introState = 'skipped';
    if (_scene && _camera) {
      kjrIntroBeginOutro(true); // compressed icon fade + brief hold, then a short dissolve tail - no pack physics on this path
    } else {
      kjrIntroDissolve(); // CSS-only phase or asset loading - no scene yet, flat ~260ms fade
    }
  }

  function kjrIntroDissolve(ms) {
    if (_ending) return;
    _ending = true;
    // starting the dissolve - if a scene is running tick()'s own heartbeat still covers it; if no scene
    // exists yet (kill-switch/skip-before-scene path) the setTimeout below is a short, self-sufficient
    // safety net on its own
    var el = document.getElementById('intro');
    if (el) el.classList.add('kjr-intro-out');
    _introTimers.push(setTimeout(kjrIntroTeardown, ms || DISSOLVE_MS));
  }

  // #intro-word (the whale icon, no text) is hidden by default (styles.css) -
  // the scene carries its own brand beat now. Only the four kill-switch paths
  // below call this, so the CSS fallback greeting still reads on every one of them.
  function kjrIntroShowWord() {
    var el = document.getElementById('intro-word');
    if (el) el.classList.add('kjr-intro-word-show');
  }

  function kjrIntroForceRemove(err) {
    if (err) { try { console.warn('[intro] stopped:', err); } catch (e2) {} }
    _ending = true;
    kjrIntroTeardown();
  }

  function kjrIntroTeardown() {
    if (_removed) return;
    _removed = true;
    try {
      introState = 'done';
      _introTimers.forEach(function (id) { clearTimeout(id); });
      _introTimers.length = 0;
      if (_raf) { cancelAnimationFrame(_raf); _raf = null; }
      if (_onPointerMove) { window.removeEventListener('pointermove', _onPointerMove); _onPointerMove = null; }
      if (_onResize) { window.removeEventListener('resize', _onResize); _onResize = null; }
      window.removeEventListener('pointerdown', kjrIntroSkip);
      window.removeEventListener('keydown', kjrIntroSkip);
      try {
        if (_scene) {
          _scene.traverse(function (obj) {
            if (obj.isInstancedMesh && typeof obj.dispose === 'function') obj.dispose(); // frees the per-instance matrix buffer
            if (obj.geometry) obj.geometry.dispose();
            if (obj.material) {
              var mats = Array.isArray(obj.material) ? obj.material : [obj.material];
              mats.forEach(function (m) { if (m.map) m.map.dispose(); m.dispose(); });
            }
          });
        }
        if (_renderer) {
          _renderer.dispose();
          if (_renderer.forceContextLoss) _renderer.forceContextLoss();
          if (_renderer.domElement && _renderer.domElement.parentNode) _renderer.domElement.parentNode.removeChild(_renderer.domElement);
        }
      } catch (e3) { /* best-effort disposal, never block removal */ }
      _introObjectUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e4) {} });
      _introObjectUrls.length = 0;
      var el = document.getElementById('intro');
      if (el && el.parentNode) el.parentNode.removeChild(el);
      _scene = null; _camera = null; _renderer = null;
      _introIconMesh = null; _introHitCardMesh = null; _introTHREE = null;
    } finally {
      // Restore toast()/toastError() and replay anything queued during the
      // intro, in order, through the app's real toast mechanism - runs on
      // every exit path (natural, skip, kill-switch, hard ceiling, error),
      // exactly once, even if the block above throws.
      kjrIntroReplayToasts();
    }
  }

  async function kjrIntroMain() {
    _introStartTime = performance.now();
    var introEl = document.getElementById('intro');
    if (!introEl) return; // markup missing - nothing to control
    var stageEl = document.getElementById('intro-stage');

    kjrIntroInterceptToast(); // every path below now funnels to kjrIntroTeardown, safe to intercept from here
    introState = 'css';
    window.addEventListener('pointerdown', kjrIntroSkip, { passive: true });
    window.addEventListener('keydown', kjrIntroSkip);
    // Bootstrap deadline: only fires if the scene never starts rendering (kjrIntroBuildScene sets
    // _sceneStartTime on its first tick and installs the real ceiling itself from there).
    _introTimers.push(setTimeout(function () {
      if (_sceneStartTime) return; // scene is already running, the re-anchored ceiling below owns this now
      _introCeilingHit = true; kjrIntroForceRemove();
    }, BOOTSTRAP_CEILING_MS));
    // Unconditional last-resort backstop, independent of the above two - always page-load-anchored.
    _introTimers.push(setTimeout(function () { _introCeilingHit = true; kjrIntroForceRemove(); }, ABSOLUTE_BACKSTOP_MS));

    if (!kjrIntroEnabled()) { introKillSwitch = 'settings-off'; kjrIntroShowWord(); _introTimers.push(setTimeout(kjrIntroDissolve, KILLSWITCH_FADE_MS)); return; }
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) { introKillSwitch = 'reduced-motion'; kjrIntroShowWord(); _introTimers.push(setTimeout(kjrIntroDissolve, KILLSWITCH_FADE_MS)); return; }
    if (!kjrIntroHasWebGL()) { introKillSwitch = 'no-webgl'; kjrIntroShowWord(); _introTimers.push(setTimeout(kjrIntroDissolve, KILLSWITCH_FADE_MS)); return; }

    var THREE;
    try {
      THREE = await import('./Assets/lib/three.module.js?v=3.31');
    } catch (e) {
      introKillSwitch = 'import-failed';
      kjrIntroShowWord();
      _introTimers.push(setTimeout(kjrIntroDissolve, KILLSWITCH_FADE_MS));
      return;
    }
    if (_ending) return; // skipped during the import

    await kjrIntroBuildScene(THREE, stageEl);
  }

  kjrIntroMain().catch(function (e) { introKillSwitch = introKillSwitch || 'error'; kjrIntroForceRemove(e); });
})();
