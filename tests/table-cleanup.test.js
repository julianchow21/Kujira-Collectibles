'use strict';
// Redesign Step 4 (v3.71): table cleanup. Column filters behind a switch, one "…" menu per Singles and Slabs
// row, quiet tags and status dots, the summary strip and the Singles language chips. None of it may change
// what a row is matched on, what an action does, or what is written to the data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, makeSeed, createLocalStorage, plain, ROOT } = require('./harness.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
const single = (o) => Object.assign({}, makeSeed().singles[0], o);
const slab = (o) => Object.assign({
  id: 'slab_1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '12345678', rank: '',
  language: 'EN', costPrice: 900, marketPrice: 1380, listPrice: '', dateListed: '3 Jul 2026', status: 'Available',
  notes: '', priceAlert: '', _updatedAt: new Date().toISOString(),
}, o);
const TABLES = ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebay'];
const TABLE_IDS = { singles: 'singles-table', slabs: 'slabs-table', sales: 'sales-table', etbs: 'kjr-etb-table', boosterBoxes: 'kjr-bb-table', boosterPacks: 'kjr-bp-table', ebay: 'kjr-ebay-table' };

// ── column filters ───────────────────────────────────────────────────────────────────────────
test('column filters: the helper lists every input of each filter row in index.html, and the Step 2 id lists agree', async () => {
  const { ctx } = await loadApp();
  for (const table of TABLES) {
    const start = html.indexOf('<table id="' + TABLE_IDS[table] + '"');
    assert.ok(start > 0, table + ' has its table id');
    const head = html.slice(start, html.indexOf('</thead>', start));
    const row = head.slice(head.indexOf('<tr class="filter-row">'));
    const inRow = [...row.matchAll(/<(?:input|select) class="col-filter"(?:[^>"]|"[^"]*")*?\bid="([^"]+)"/g)].map(m => m[1]).sort();
    assert.ok(inRow.length >= 6, table + ' has its column filters');
    assert.deepEqual([...ctx.KJR_COLFILTERS[table].ids].sort(), inRow, table + ': same ids as the markup');
  }
  const fi = plain(ctx._FILTER_INPUTS);
  for (const table of ['singles', 'slabs', 'sales']) {
    for (const id of fi[table].cols.concat(table === 'sales' ? fi[table].sels : [])) {
      assert.ok(ctx.KJR_COLFILTERS[table].ids.includes(id), table + ' clear-all id is counted: ' + id);
    }
  }
});

test('column filters: off by default on all seven tables, nothing is written until the choice is made', async () => {
  const { ctx, document, localStorage } = await loadApp();
  for (const table of TABLES) {
    assert.equal(ctx.kjrColFiltersPref(table), false, table);
    assert.equal(ctx.kjrColFiltersSync(table), false, table);
    assert.equal(document.getElementById(TABLE_IDS[table]).classList.contains('cf-on'), false, table + ' has no .cf-on');
    assert.equal(localStorage.getItem('kjr_colfilters_' + table), null, table + ' wrote nothing');
  }
  assert.equal(ctx.kjrColFiltersPref('not-a-table'), false);
  assert.equal(ctx.kjrColFiltersShow('not-a-table', true), false, 'an unknown table is refused');
  assert.equal(localStorage.getItem('kjr_colfilters_not-a-table'), null);
});

test('column filters: the switch stores the preference per table and the class follows it', async () => {
  const { ctx, document, localStorage } = await loadApp();
  assert.equal(ctx.kjrColFiltersShow('singles', true), true);
  assert.equal(localStorage.getItem('kjr_colfilters_singles'), '1');
  assert.equal(document.getElementById('singles-table').classList.contains('cf-on'), true);
  assert.equal(document.getElementById('cf-switch-singles').checked, true, 'the switch shows the state');
  assert.equal(document.getElementById('slabs-table').classList.contains('cf-on'), false, 'other tables are untouched');
  assert.equal(ctx.kjrColFiltersShow('singles', false), false);
  assert.equal(localStorage.getItem('kjr_colfilters_singles'), '0');
  assert.equal(document.getElementById('singles-table').classList.contains('cf-on'), false);
  assert.equal(document.getElementById('cf-switch-singles').checked, false);
  // the toolbar toggle (Sealed tables, eBay) flips it and reports aria-pressed
  assert.equal(ctx.kjrColFiltersToggle('etbs'), true);
  assert.equal(document.getElementById('cf-toggle-etbs').getAttribute('aria-pressed'), 'true');
  assert.equal(localStorage.getItem('kjr_colfilters_etbs'), '1');
  assert.equal(ctx.kjrColFiltersToggle('etbs'), false);
  assert.equal(document.getElementById('cf-toggle-etbs').getAttribute('aria-pressed'), 'false');
});

test('column filters: a saved preference is applied to the table when the app loads', async () => {
  const { ctx, document } = await loadApp({ localStorage: { kjr_colfilters_ebay: '1', kjr_colfilters_slabs: '1', kjr_colfilters_sales: '0' } });
  assert.equal(document.getElementById('kjr-ebay-table').classList.contains('cf-on'), true);
  assert.equal(document.getElementById('cf-toggle-ebay').getAttribute('aria-pressed'), 'true');
  assert.equal(document.getElementById('slabs-table').classList.contains('cf-on'), true);
  assert.equal(document.getElementById('sales-table').classList.contains('cf-on'), false);
  assert.equal(document.getElementById('singles-table').classList.contains('cf-on'), false);
  assert.equal(ctx.kjrColFiltersPref('ebay'), true);
});

test('column filters: a row that holds a typed filter stays visible whatever the preference, and its control says why', async () => {
  const { ctx, document } = await loadApp();
  const tbl = document.getElementById('singles-table');
  const sw = document.getElementById('cf-switch-singles');
  document.getElementById('sf-cost').value = '>50';
  assert.equal(ctx.kjrColFiltersSync('singles'), true, 'shown with the preference off');
  assert.equal(tbl.classList.contains('cf-on'), true);
  assert.equal(sw.checked, true);
  assert.equal(sw.disabled, true, 'locked on while a filter is in use');
  assert.match(document.getElementById('cf-hint-singles').textContent, /filter is in use/);
  // the toggle button cannot hide it either
  document.getElementById('kjr-etb-cf-product').value = 'elite';
  assert.equal(ctx.kjrColFiltersToggle('etbs'), true);
  assert.equal(ctx.kjrColFiltersPref('etbs'), false, 'the preference was not touched');
  assert.equal(document.getElementById('cf-toggle-etbs').getAttribute('aria-disabled'), 'true');
  // clearing the filter lets the preference decide again
  document.getElementById('sf-cost').value = '';
  assert.equal(ctx.kjrColFiltersSync('singles'), false);
  assert.equal(tbl.classList.contains('cf-on'), false);
  assert.equal(sw.disabled, false);
  assert.equal(sw.checked, false);
  assert.equal(document.getElementById('cf-hint-singles').textContent, ctx.KJR_CF_HINT);
  // whitespace is not a filter, and "All" on the Sales channel select is not one either
  document.getElementById('sf-name').value = '   ';
  document.getElementById('slf-channel').value = '';
  assert.equal(ctx.kjrColFilterCount('singles'), 0);
  assert.equal(ctx.kjrColFilterCount('sales'), 0);
  document.getElementById('slf-channel').value = 'eBay';
  assert.equal(ctx.kjrColFilterCount('sales'), 1);
  assert.equal(ctx.kjrColFiltersSync('sales'), true);
});

test('column filters: with storage blocked the choice still holds for the session and nothing throws', async () => {
  const storage = createLocalStorage();
  const realSet = storage.setItem;
  storage.setItem = (k, v) => { if (String(k).startsWith('kjr_colfilters_')) throw new Error('blocked'); return realSet.call(storage, k, v); };
  const { ctx, document } = await loadApp({ storage });
  assert.equal(ctx.kjrColFiltersShow('slabs', true), true);
  assert.equal(ctx.kjrColFiltersPref('slabs'), true);
  assert.equal(document.getElementById('slabs-table').classList.contains('cf-on'), true);
  assert.equal(ctx.kjrColFiltersShow('slabs', false), false);
  assert.equal(ctx.kjrColFiltersPref('slabs'), false);
});

test('column filters: the Filters badge counts typed column filters on top of the dropdowns, and clearing one removes it', async () => {
  const { ctx, document } = await loadApp();
  const badge = id => document.getElementById('filters-badge-' + id).textContent;
  ctx.updateFiltersBadge('singles');
  assert.equal(badge('singles'), '', 'the status default (available) is not a filter');
  document.getElementById('singles-lang').value = 'JP';
  document.getElementById('sf-name').value = 'pika';
  document.getElementById('sf-cost').value = '>50';
  ctx.updateFiltersBadge('singles');
  assert.equal(badge('singles'), '3', 'a dropdown plus two column filters');
  document.getElementById('sf-cost').value = '';
  ctx.updateFiltersBadge('singles');
  assert.equal(badge('singles'), '2');
  // tables with no dropdowns still get a count (Sales), and the sealed tables and eBay too
  document.getElementById('slf-profit').value = '<0';
  ctx.updateFiltersBadge('sales');
  assert.equal(badge('sales'), '1');
  document.getElementById('kjr-ebay-cf-usd').value = '>20';
  document.getElementById('kjr-ebay-status').value = 'Paid';
  ctx.updateFiltersBadge('ebay');
  assert.equal(badge('ebay'), '2');
  // updating the badge also brings the row back in step
  assert.equal(document.getElementById('sales-table').classList.contains('cf-on'), true);
  document.getElementById('slf-profit').value = '';
  ctx.updateFiltersBadge('sales');
  assert.equal(badge('sales'), '');
  assert.equal(document.getElementById('sales-table').classList.contains('cf-on'), false);
});

test('column filters: Clear all still empties every column filter, and every render ends by syncing the row', async () => {
  const seed = makeSeed({ singles: [single({ id: 'a', name: 'Pikachu 25', costPrice: 80 }), single({ id: 'b', name: 'Mew 1', costPrice: 5 })] });
  const { ctx, document } = await loadApp({ seed });
  document.getElementById('sf-cost').value = '>50';
  ctx.renderSingles();
  assert.equal(document.getElementById('filters-badge-singles').textContent, '1');
  assert.equal(document.getElementById('singles-table').classList.contains('cf-on'), true, 'rendering with a filter shows the row');
  assert.equal(document.getElementById('clear-filters-singles').style.display, '', 'the clear button counts column filters as before');
  ctx.clearAllFilters('singles');
  assert.equal(document.getElementById('sf-cost').value, '');
  assert.equal(document.getElementById('filters-badge-singles').textContent, '');
  assert.equal(document.getElementById('singles-table').classList.contains('cf-on'), false);
});

test('column filters: the markup carries a switch in the Singles, Slabs and Sales popovers and a toggle on the other four, and the CSS hides the row', () => {
  for (const t of ['singles', 'slabs', 'sales']) {
    assert.match(html, new RegExp('<input type="checkbox" role="switch" id="cf-switch-' + t + '"[^>]*onchange="kjrColFiltersShow\\(\'' + t + '\',this\\.checked\\)"'));
    assert.match(html, new RegExp('<label class="kjr-switch" for="cf-switch-' + t + '">'));
    assert.match(html, new RegExp('<div class="filters-dropdown" id="fd-' + t + '">\\s*<div class="filters-row filters-switch">'), t + ': the switch is the first row of its popover');
  }
  assert.match(html, /id="filters-badge-sales"/, 'Sales gets a Filters popover with a badge');
  assert.match(html, /<table id="sales-table">/);
  for (const t of ['etbs', 'boosterBoxes', 'boosterPacks', 'ebay']) {
    assert.match(html, new RegExp('<button type="button" class="btn btn-sm kjr-cf-toggle" id="cf-toggle-' + t + '" aria-pressed="false" onclick="kjrColFiltersToggle\\(\'' + t + '\'\\)"'));
  }
  assert.match(css, /\.tbl-wrap thead tr\.filter-row\{display:none\}/);
  assert.match(css, /\.tbl-wrap table\.cf-on thead tr\.filter-row\{display:table-row\}/);
  // the phone rule that hides the row is untouched, and more specific than the show rule
  assert.match(css, /body:not\(\.force-tables\) \.page \.tbl-wrap>table>thead>tr:nth-child\(2\)\{display:none\}/);
  assert.match(css, /body:not\(\.force-tables\) \.kjr-cf-toggle,\s*body:not\(\.force-tables\) \.filters-switch,\s*body:not\(\.force-tables\) #fw-sales\{display:none\}/);
});

// ── row menu: markup ──────────────────────────────────────────────────────────────────────────
function actionsCell(rowHtml) {
  const i = rowHtml.indexOf('<td data-col-key="actions">');
  return rowHtml.slice(i, rowHtml.indexOf('</td>', i) + 5);
}
const buttonsIn = (cell) => [...cell.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map(m => ({ attrs: m[1], text: m[2].replace(/<[^>]*>/g, '').trim() }));

test('row menu: a Singles row has one "…" button and a hidden menu holding Mark as sold, Generate listing, Edit and Delete', async () => {
  const seed = makeSeed({ singles: [single({ id: 'a1', name: 'Pikachu "Quoted" <b>', priceAlert: 5, marketPrice: 9, carousellUrl: 'https://x.invalid/1' })] });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSingles();
  const row = document.getElementById('singles-body').innerHTML;
  const cell = actionsCell(row);
  assert.equal((cell.match(/data-col-key=/g) || []).length, 1, 'no extra data-col-key');
  assert.match(cell, /<td data-col-key="actions"><div class="kjr-actions">/);
  assert.match(cell, /<span title="🔔 Price alert: target S\$5 reached!"/, 'the alert indicator stays');
  assert.match(cell, /<span title="Listed on Carousell">🔗<\/span>/, 'the link indicator stays');
  assert.match(cell, /<button type="button" class="kjr-more" aria-label="More actions for Pikachu &quot;Quoted&quot; &lt;b&gt;" aria-haspopup="menu" aria-expanded="false" title="More actions">/);
  assert.doesNotMatch(cell.match(/<button type="button" class="kjr-more"[^>]*>/)[0], /onclick/, 'nothing inline on the "…" itself');
  assert.match(cell, /<div class="kjr-rowmenu" role="menu" aria-label="Actions for Pikachu &quot;Quoted&quot; &lt;b&gt;" hidden>/);
  const items = [...cell.matchAll(/<button type="button" role="menuitem"([^>]*)>([^<]*)<\/button>/g)];
  assert.deepEqual(items.map(m => m[2]), ['Mark as sold', 'Generate listing', 'Edit', 'Delete']);
  assert.match(items[0][1], /onclick="markStatus\('singles',&quot;a1&quot;,'Sold'\)"/);
  assert.match(items[1][1], /onclick="openListingFor\('singles',&quot;a1&quot;\)"/);
  assert.match(items[2][1], /title="Edit" onclick="openEditSingle\(&quot;a1&quot;\)"/);
  assert.match(items[3][1], /class="is-danger" onclick="deleteItem\(&quot;a1&quot;,'singles'\)"/);
  assert.match(cell, /<div class="kjr-rowmenu-sep" role="separator"><\/div>/, 'a hairline sits above Delete');
  // none of the old row buttons are left
  assert.doesNotMatch(cell, /✓ Sold|↩ Avail|📋|✎|✕|color:var\(--red\)/);
});

test('row menu: a Sold Singles row offers Mark as available and no listing, and a Slabs row uses the slab editor', async () => {
  const seed = makeSeed({
    singles: [single({ id: 's9', name: 'Sold card', status: 'Sold' })],
    slabs: [slab({ id: 'p1' }), slab({ id: 'p2', status: 'Sold' })],
  });
  const { ctx, document } = await loadApp({ seed });
  document.getElementById('singles-sold-divider').dataset.open = '1';
  document.getElementById('slabs-sold-divider').dataset.open = '1';
  ctx.renderSingles(); ctx.renderSlabs();
  const sold = actionsCell(document.getElementById('singles-sold-body').innerHTML);
  assert.deepEqual([...sold.matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map(m => m[1]), ['Mark as available', 'Edit', 'Delete']);
  assert.match(sold, /markStatus\('singles',&quot;s9&quot;,'Available'\)/);
  const slabs = actionsCell(document.getElementById('slabs-body').innerHTML);
  assert.match(slabs, /openEditSlab\(&quot;p1&quot;\)/);
  assert.match(slabs, /deleteItem\(&quot;p1&quot;,'slabs'\)/);
  assert.match(slabs, /openListingFor\('slabs',&quot;p1&quot;\)/);
  assert.equal((slabs.match(/data-col-key=/g) || []).length, 1);
  const soldSlab = actionsCell(document.getElementById('slabs-sold-body').innerHTML);
  assert.match(soldSlab, /markStatus\('slabs',&quot;p2&quot;,'Available'\)/);
  assert.doesNotMatch(soldSlab, /openListingFor/);
});

test('row menu: the phone tap-to-edit still finds an Edit button in the actions cell, the "…" never matches first', async () => {
  const seed = makeSeed({ singles: [single({ id: 'e1', name: 'Edited Pikachu' })], slabs: [slab({ id: 'e2', name: 'Edit Promo Slab' })] });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSingles(); ctx.renderSlabs();
  for (const [body, handler] of [['singles-body', 'openEditSingle'], ['slabs-body', 'openEditSlab']]) {
    const cell = actionsCell(document.getElementById(body).innerHTML);
    // the same test kjrInstallCompactTapEdit runs: title or text matches /edit/i, first button wins
    const match = buttonsIn(cell).find(b => /edit/i.test((b.attrs.match(/\btitle="([^"]*)"/) || [])[1] || '') || /edit/i.test(b.text));
    assert.ok(match, body + ' has an Edit button in the actions cell');
    assert.equal(match.text, 'Edit');
    assert.match(match.attrs, new RegExp('onclick="' + handler + '\\('));
  }
});

test('row menu: the menu is built by one shared function and a re-render leaves one menu per row, never a second copy', async () => {
  const seed = makeSeed({ singles: [single({ id: 'a' }), single({ id: 'b' })] });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSingles(); ctx.renderSingles();
  const body = document.getElementById('singles-body').innerHTML;
  assert.equal((body.match(/class="kjr-rowmenu"/g) || []).length, 2);
  assert.equal((body.match(/class="kjr-more"/g) || []).length, 2);
  assert.equal(typeof ctx.kjrRowMenuHtml, 'function');
});

// ── row menu: the controller, driven with a small fake DOM ─────────────────────────────────────
function fakeDom(app) {
  const doc = app.document;
  const matches = (n, sel) => sel === '[role="menuitem"]' ? n._attrs.role === 'menuitem' : (sel[0] === '.' && n.classes.has(sel.slice(1)));
  const make = (tag, o) => {
    o = o || {};
    const n = {
      tag, parentNode: null, nextElementSibling: null, children: [], _attrs: {}, classes: new Set(o.classes || []),
      style: {}, hidden: !!o.hidden, isConnected: true, rect: o.rect || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
      offsetWidth: o.w || 0, offsetHeight: o.h || 0, focusCount: 0,
      classList: { contains: c => n.classes.has(c), add: c => n.classes.add(c), remove: c => n.classes.delete(c), toggle: (c, f) => { const on = f === undefined ? !n.classes.has(c) : !!f; if (on) n.classes.add(c); else n.classes.delete(c); return on; } },
      setAttribute(k, v) { n._attrs[k] = String(v); }, getAttribute(k) { return k in n._attrs ? n._attrs[k] : null; },
      getBoundingClientRect() { return n.rect; },
      querySelectorAll(sel) { return n.children.filter(c => matches(c, sel)); },
      closest(sel) { for (let e = n; e; e = e.parentNode) if (matches(e, sel)) return e; return null; },
      focus() { n.focusCount++; doc.activeElement = n; },
    };
    return n;
  };
  // one row: a "…" button, then its menu with four items and a separator, inside a cell
  const row = (name, rect) => {
    const cell = make('div');
    const btn = make('button', { classes: ['kjr-more'], rect });
    btn.setAttribute('aria-expanded', 'false');
    const menu = make('div', { classes: ['kjr-rowmenu'], hidden: true, w: 184, h: 160 });
    const items = ['Mark as sold', 'Generate listing', 'Edit', 'Delete'].map(t => { const b = make('button'); b.setAttribute('role', 'menuitem'); b.text = t; b.parentNode = menu; menu.children.push(b); return b; });
    const sep = make('div'); sep.setAttribute('role', 'separator'); sep.parentNode = menu; menu.children.splice(3, 0, sep);
    btn.parentNode = cell; menu.parentNode = cell; cell.children.push(btn, menu); btn.nextElementSibling = menu;
    return { cell, btn, menu, items, sep, name };
  };
  const key = (k, target, extra) => Object.assign({ key: k, target, defaulted: false, preventDefault() { this.defaulted = true; } }, extra || {});
  return { make, row, key, doc };
}
const roomy = (app) => { app.sandbox.innerHeight = 800; app.sandbox.innerWidth = 1200; };

test('row menu controller: click opens under the button, right edges aligned, first item focused, aria-expanded set', async () => {
  const app = await loadApp(); roomy(app);
  const dom = fakeDom(app);
  const r = dom.row('A', { top: 100, left: 1100, right: 1136, bottom: 136, width: 36, height: 36 });
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  assert.equal(r.menu.hidden, false);
  assert.equal(r.btn.getAttribute('aria-expanded'), 'true');
  assert.equal(r.menu.style.top, '140px', '4px under the button');
  assert.equal(r.menu.style.left, (1136 - 184) + 'px', 'right edges line up');
  assert.equal(r.menu.getAttribute('data-place'), 'down');
  assert.equal(app.document.activeElement, r.items[0], 'the first item takes focus');
  assert.equal(r.menu.style.visibility, '', 'it was only hidden while it was measured');
  assert.equal(app.ctx._kjrRowMenu.btn, r.btn);
});

test('row menu controller: flips up near the bottom of the viewport, clamps to the sides, and clears the phone tab bar', async () => {
  const app = await loadApp(); roomy(app);
  const dom = fakeDom(app);
  const low = dom.row('low', { top: 760, left: 1100, right: 1136, bottom: 796, width: 36, height: 36 });
  app.ctx.kjrRowMenuOnClick({ target: low.btn });
  assert.equal(low.menu.getAttribute('data-place'), 'up');
  assert.equal(low.menu.style.top, (760 - 4 - 160) + 'px', 'the menu ends 4px above the button');
  app.ctx.kjrRowMenuClose(false);
  assert.equal(low.menu.style.top, '', 'closing clears the position');
  const left = dom.row('left', { top: 100, left: 4, right: 40, bottom: 136, width: 36, height: 36 });
  app.ctx.kjrRowMenuOnClick({ target: left.btn });
  assert.equal(left.menu.style.left, '8px', 'never past the left edge');
  app.ctx.kjrRowMenuClose(false);
  // a bottom tab bar covering the lowest 56px counts as the floor
  app.document.querySelector = (sel) => sel === '.bottom-tab-bar' ? { getBoundingClientRect: () => ({ top: 744, height: 56 }) } : null;
  const mid = dom.row('mid', { top: 600, left: 1100, right: 1136, bottom: 636, width: 36, height: 36 });
  app.ctx.kjrRowMenuOnClick({ target: mid.btn });
  assert.equal(mid.menu.getAttribute('data-place'), 'up', '636 + 4 + 160 would run behind the bar at 744');
  // no room above or below: it stays inside the viewport
  app.ctx.kjrRowMenuClose(false);
  app.sandbox.innerHeight = 150;
  const tiny = dom.row('tiny', { top: 60, left: 600, right: 636, bottom: 96, width: 36, height: 36 });
  app.document.querySelector = () => null;
  app.ctx.kjrRowMenuOnClick({ target: tiny.btn });
  assert.equal(tiny.menu.style.top, '8px');
});

test('row menu controller: one menu at a time, and the same button closes it with focus back on the button', async () => {
  const app = await loadApp(); roomy(app);
  const dom = fakeDom(app);
  const a = dom.row('A', { top: 100, left: 1100, right: 1136, bottom: 136 });
  const b = dom.row('B', { top: 200, left: 1100, right: 1136, bottom: 236 });
  app.ctx.kjrRowMenuOnClick({ target: a.btn });
  app.ctx.kjrRowMenuOnClick({ target: b.btn });
  assert.equal(a.menu.hidden, true, 'A closed when B opened');
  assert.equal(a.btn.getAttribute('aria-expanded'), 'false');
  assert.equal(b.menu.hidden, false);
  assert.equal(b.btn.getAttribute('aria-expanded'), 'true');
  app.ctx.kjrRowMenuOnClick({ target: b.btn });
  assert.equal(b.menu.hidden, true);
  assert.equal(app.document.activeElement, b.btn, 'closing from the button leaves focus on it');
  assert.equal(app.ctx._kjrRowMenu, null);
});

test('row menu controller: opening closes the Filters, Columns and nav popovers, and opening a nav menu closes the row menu', async () => {
  const app = await loadApp(); roomy(app);
  const dom = fakeDom(app);
  const popover = dom.make('div', { classes: ['filters-wrap', 'open'] });
  const colMenu = dom.make('div', { classes: ['col-toggle-wrap', 'open'] });
  const nav = dom.make('div', { classes: ['nav-dd', 'open'] });
  app.document.querySelectorAll = (sel) => /filters-wrap|col-toggle-wrap/.test(sel) ? [popover, colMenu] : (sel === '.nav-dd' ? [nav] : []);
  const r = dom.row('A', { top: 100, left: 1100, right: 1136, bottom: 136 });
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  assert.equal(popover.classList.contains('open'), false, 'Filters closed');
  assert.equal(colMenu.classList.contains('open'), false, 'Columns closed');
  assert.equal(nav.classList.contains('open'), false, 'nav dropdown closed');
  assert.equal(r.menu.hidden, false);
  // the nav button stops its click from reaching the document, so toggleNavDD tells the row menu itself
  nav.classList.add('open');
  app.document.querySelectorAll = (sel) => sel === '.nav-dd' ? [Object.assign(nav, { dataset: { dd: 'more' } })] : [];
  app.ctx.toggleNavDD('more', { stopPropagation() {}, preventDefault() {} });
  assert.equal(r.menu.hidden, true);
  assert.equal(app.ctx._kjrRowMenu, null);
});

test('row menu controller: an outside click, a click on an item, a scroll that moved the button and a resize all close it, padding clicks do not', async () => {
  const app = await loadApp(); roomy(app);
  const dom = fakeDom(app);
  const r = dom.row('A', { top: 100, left: 1100, right: 1136, bottom: 136 });
  const elsewhere = dom.make('div');
  const outside = () => { app.ctx.kjrRowMenuOnClick({ target: elsewhere }); };
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  app.document.activeElement = r.items[2];
  outside();
  assert.equal(r.menu.hidden, true, 'outside click');
  assert.equal(app.document.activeElement, r.items[2], 'an outside click does not steal focus');
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  app.ctx.kjrRowMenuOnClick({ target: r.sep });
  app.ctx.kjrRowMenuOnClick({ target: r.menu });
  assert.equal(r.menu.hidden, false, 'a click on the divider or the padding leaves it open');
  app.document.activeElement = r.items[1];
  app.ctx.kjrRowMenuOnClick({ target: r.items[1] });
  assert.equal(r.menu.hidden, true, 'choosing an item closes it (the item\'s own inline handler does the work)');
  assert.equal(app.document.activeElement, r.btn, 'and puts focus back on the "…", so a dialog the item opens remembers a visible button');
  // scroll: closes only when the button has moved
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  app.ctx.kjrRowMenuOnScroll({ target: app.document });
  assert.equal(r.menu.hidden, false, 'a scroll that left the button where it was does not close it');
  r.btn.rect = { top: 60, left: 1100, right: 1136, bottom: 96 };
  app.ctx.kjrRowMenuOnScroll({ target: app.document });
  assert.equal(r.menu.hidden, true, 'the button moved');
  // resize
  r.btn.rect = { top: 100, left: 1100, right: 1136, bottom: 136 };
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  app.sandbox.dispatchEvent({ type: 'resize' });
  assert.equal(r.menu.hidden, true, 'a resize closes it');
});

test('row menu controller: the click listener is on the capture phase, so the menu is closed before the item\'s own handler opens a dialog', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  assert.match(src, /document\.addEventListener\('click', kjrRowMenuOnClick, true\);/);
  assert.match(src, /document\.addEventListener\('keydown', kjrRowMenuOnKey\);/);
  assert.match(src, /document\.addEventListener\('scroll', kjrRowMenuOnScroll, true\);/);
  assert.match(src, /window\.addEventListener\('resize', function \(\) \{ kjrRowMenuClose\(false\); \}\);/);
});

test('row menu controller: Esc closes and returns focus to the "…", Tab closes with focus on the button and no preventDefault', async () => {
  const app = await loadApp(); roomy(app);
  const dom = fakeDom(app);
  const r = dom.row('A', { top: 100, left: 1100, right: 1136, bottom: 136 });
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  app.document.activeElement = r.items[2];
  const esc = dom.key('Escape', r.items[2]);
  app.ctx.kjrRowMenuOnKey(esc);
  assert.equal(r.menu.hidden, true);
  assert.equal(r.btn.getAttribute('aria-expanded'), 'false');
  assert.equal(app.document.activeElement, r.btn, 'focus returns to the "…"');
  assert.equal(esc.defaulted, true);
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  app.document.activeElement = r.items[1];
  const tab = dom.key('Tab', r.items[1]);
  app.ctx.kjrRowMenuOnKey(tab);
  assert.equal(r.menu.hidden, true);
  assert.equal(app.document.activeElement, r.btn, 'Tab carries on from the button');
  assert.equal(tab.defaulted, false, 'the browser still moves focus');
  // keys while nothing is open do nothing
  const stray = dom.key('Escape', r.btn);
  app.ctx.kjrRowMenuOnKey(stray);
  assert.equal(stray.defaulted, false);
});

test('row menu controller: Arrow Up and Down wrap, Home and End jump, and the arrows open a closed menu on its first or last item', async () => {
  const app = await loadApp(); roomy(app);
  const dom = fakeDom(app);
  const r = dom.row('A', { top: 100, left: 1100, right: 1136, bottom: 136 });
  const items = r.items; // Mark as sold, Generate listing, Edit, Delete (the divider is not an item)
  const press = (k) => { const e = dom.key(k, app.document.activeElement); app.ctx.kjrRowMenuOnKey(e); return e; };
  const down = dom.key('ArrowDown', r.btn);
  app.ctx.kjrRowMenuOnKey(down);
  assert.equal(down.defaulted, true);
  assert.equal(r.menu.hidden, false, 'Arrow Down on the button opens it');
  assert.equal(app.document.activeElement, items[0]);
  press('ArrowDown'); assert.equal(app.document.activeElement, items[1]);
  press('ArrowDown'); press('ArrowDown'); assert.equal(app.document.activeElement, items[3]);
  press('ArrowDown'); assert.equal(app.document.activeElement, items[0], 'wraps to the top');
  press('ArrowUp'); assert.equal(app.document.activeElement, items[3], 'wraps to the bottom');
  press('Home'); assert.equal(app.document.activeElement, items[0]);
  press('End'); assert.equal(app.document.activeElement, items[3]);
  const other = press('a'); assert.equal(other.defaulted, false, 'other keys are left alone');
  app.ctx.kjrRowMenuClose(false);
  app.ctx.kjrRowMenuOnKey(dom.key('ArrowUp', r.btn));
  assert.equal(app.document.activeElement, items[3], 'Arrow Up on the button opens it on the last item');
});

test('row menu controller: a re-render closes an open menu cleanly, and a menu whose button left the page is dropped', async () => {
  const seed = makeSeed({ singles: [single({ id: 'a' })], slabs: [slab({ id: 'p' })] });
  const app = await loadApp({ seed }); roomy(app);
  const dom = fakeDom(app);
  const r = dom.row('A', { top: 100, left: 1100, right: 1136, bottom: 136 });
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  assert.equal(r.menu.hidden, false);
  app.ctx.renderSingles();
  assert.equal(r.menu.hidden, true, 'renderSingles closed it');
  assert.equal(r.btn.getAttribute('aria-expanded'), 'false');
  assert.equal(app.ctx._kjrRowMenu, null);
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  app.ctx.renderSlabs();
  assert.equal(r.menu.hidden, true, 'renderSlabs closed it');
  // a table that was rebuilt some other way: the button is gone, the next event just clears the state
  app.ctx.kjrRowMenuOnClick({ target: r.btn });
  r.btn.isConnected = false;
  assert.doesNotThrow(() => app.ctx.kjrRowMenuOnClick({ target: dom.make('div') }));
  assert.equal(app.ctx._kjrRowMenu, null);
  assert.doesNotThrow(() => app.ctx.kjrRowMenuOnKey(dom.key('Escape', dom.make('div'))));
});

// ── language chips ────────────────────────────────────────────────────────────────────────────
const lang = (code, o) => single(Object.assign({ language: code }, o));
function chipsOf(document) {
  const htmlStr = document.getElementById('singles-lang-chips').innerHTML;
  return [...htmlStr.matchAll(/<button type="button" class="kjr-chip" data-lang="([^"]*)" aria-pressed="(true|false)"><span>([^<]*)<\/span><span class="kjr-chip-n">(\d+)<\/span><\/button>/g)]
    .map(m => ({ code: m[1], on: m[2] === 'true', label: m[3], n: Number(m[4]) }));
}

test('language chips: "All N" and one chip per language in the data, counted against every other filter', async () => {
  const seed = makeSeed({ singles: [
    lang('EN', { id: '1', name: 'Pikachu', type: 'raw' }), lang('EN', { id: '2', name: 'Mew', type: 'raw' }),
    lang('EN', { id: '3', name: 'Booster Bundle', type: 'sealed' }), lang('JP', { id: '4', name: 'Pikachu JP', type: 'raw' }),
    lang('CN', { id: '5', name: 'Mewtwo CN', type: 'raw' }), lang('EN', { id: '6', name: 'Sold one', status: 'Sold' }),
  ] });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSingles();
  let chips = chipsOf(document);
  assert.deepEqual(chips.map(c => [c.code, c.label, c.n, c.on]), [['', 'All', 5, true], ['EN', 'English', 3, false], ['JP', 'Japanese', 1, false], ['CN', 'Chinese', 1, false]],
    'Available rows only (the sold one is not in Showing), Indonesian is not in the data so it has no chip');
  assert.equal(document.getElementById('singles-lang-chips').hidden, false);
  // the search narrows every count
  document.getElementById('singles-search').value = 'pikachu';
  ctx.renderSingles();
  assert.deepEqual(chipsOf(document).map(c => [c.code, c.n]), [['', 2], ['EN', 1], ['JP', 1], ['CN', 0]], 'a language with no match keeps its chip at 0');
  document.getElementById('singles-search').value = '';
  // the Type dropdown too
  document.getElementById('singles-type').value = 'sealed';
  ctx.renderSingles();
  assert.deepEqual(chipsOf(document).map(c => [c.code, c.n]), [['', 1], ['EN', 1], ['JP', 0], ['CN', 0]]);
  document.getElementById('singles-type').value = '';
  // a column filter too
  document.getElementById('sf-name').value = 'mew';
  ctx.renderSingles();
  assert.deepEqual(chipsOf(document).map(c => [c.code, c.n]), [['', 2], ['EN', 1], ['JP', 0], ['CN', 1]]);
  document.getElementById('sf-name').value = '';
  // Status: Sold counts the sold rows, All counts both
  document.getElementById('singles-status-filter').value = 'sold';
  ctx.renderSingles();
  assert.deepEqual(chipsOf(document).map(c => [c.code, c.n]), [['', 1], ['EN', 1], ['JP', 0], ['CN', 0]]);
  document.getElementById('singles-status-filter').value = 'all';
  ctx.renderSingles();
  assert.deepEqual(chipsOf(document).map(c => [c.code, c.n]), [['', 6], ['EN', 3 + 1], ['JP', 1], ['CN', 1]]);
});

test('language chips: the chip for the picked language is pressed, the counts ignore that pick, and the table still filters by it', async () => {
  const seed = makeSeed({ singles: [lang('EN', { id: '1' }), lang('JP', { id: '2', name: 'Eevee JP' }), lang('JP', { id: '3', name: 'Mewtwo JP' })] });
  const { ctx, document } = await loadApp({ seed });
  document.getElementById('singles-lang').value = 'JP';
  ctx.renderSingles();
  const chips = chipsOf(document);
  assert.deepEqual(chips.map(c => [c.code, c.on, c.n]), [['', false, 3], ['EN', false, 1], ['JP', true, 2]], 'All still says 3: counts ignore the language pick');
  const rows = document.getElementById('singles-body').innerHTML;
  assert.equal((rows.match(/<tr data-id="/g) || []).length, 2, 'the rows are still filtered by the select');
  // a picked language that has vanished from the data keeps a chip so it can be un-picked
  document.getElementById('singles-lang').value = 'ID';
  ctx.renderSingles();
  assert.deepEqual(chipsOf(document).map(c => [c.code, c.on, c.n]), [['', false, 3], ['EN', false, 1], ['JP', false, 2], ['ID', true, 0]]);
});

test('language chips: a click sets #singles-lang and fires a bubbling change, so the render and the phone mirror follow the select', async () => {
  const seed = makeSeed({ singles: [lang('EN', { id: '1' }), lang('JP', { id: '2' })] });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSingles();
  const sel = document.getElementById('singles-lang');
  const events = [];
  sel.addEventListener('change', (e) => events.push([e.type, e.bubbles, sel.value]));
  const click = (code) => ctx.kjrLangChipClick({ target: { closest: () => ({ getAttribute: (k) => (k === 'data-lang' ? code : null) }) } });
  assert.equal(click('JP'), true);
  assert.equal(sel.value, 'JP');
  assert.deepEqual(plain(events), [['change', true, 'JP']]);
  // the inline onchange="renderSingles()" is what redraws, so do the same here
  ctx.renderSingles();
  assert.deepEqual(chipsOf(document).map(c => [c.code, c.on]), [['', false], ['EN', false], ['JP', true]]);
  assert.equal(click('JP'), false, 'the pressed chip again changes nothing');
  assert.equal(events.length, 1);
  assert.equal(click(''), true);
  assert.equal(sel.value, '');
  assert.equal(events.length, 2);
  assert.equal(ctx.kjrLangChipClick({ target: { closest: () => null } }), false, 'a click beside a chip does nothing');
  // the select drives it the other way round: a change in the Filters popover redraws the chips
  sel.value = 'EN';
  ctx.renderSingles();
  assert.deepEqual(chipsOf(document).map(c => [c.code, c.on]), [['', false], ['EN', true], ['JP', false]]);
  assert.equal(document.getElementById('filters-badge-singles').textContent, '1', 'and the badge counts it');
  assert.equal(document.getElementById('singles-lang-chips')._kjrBound, true);
  assert.equal(document.getElementById('singles-lang-chips')._listeners.get('click').length, 1, 'one listener, however often it is redrawn');
});

test('language chips: the row is hidden while there are no singles, the markup is real buttons, and the pure helper copes with odd input', async () => {
  const { ctx, document } = await loadApp({ seed: makeSeed({ singles: [], slabs: [slab({})] }) });
  ctx.renderSingles();
  assert.equal(document.getElementById('singles-lang-chips').hidden, true);
  assert.equal(document.getElementById('singles-lang-chips').innerHTML, '');
  assert.match(html, /<div class="kjr-chips" id="singles-lang-chips" role="group" aria-label="Language" hidden><\/div>/);
  const d = ctx.kjrLangChipData([{ language: '__proto__', status: 'Available' }, null, { language: 'EN' }, { language: 'JP', status: 'Reserved' }], () => true, 'available', '');
  assert.equal(d.all, 2, 'rows with no status are Available, a Reserved row is in neither list');
  assert.deepEqual(plain(d.chips).map(c => c.code), ['EN', 'JP'], 'JP is in the data, its only row is just not shown');
  assert.deepEqual(plain(ctx.kjrLangChipData(undefined, () => true, 'all', '')), { empty: true, all: 0, allOn: true, chips: [] });
  assert.match(ctx.kjrLangChipsHtml({ all: 3, allOn: true, chips: [{ code: 'EN', label: 'English', count: 2, on: false }] }), /^<button type="button" class="kjr-chip" data-lang="" aria-pressed="true"><span>All<\/span><span class="kjr-chip-n">3<\/span><\/button><button type="button" class="kjr-chip" data-lang="EN" aria-pressed="false">/);
  assert.match(css, /@media\(max-width:600px\)\{\.kjr-chips\{display:none\}\}/, 'phones use the segmented control in the Filters popover');
});

// ── summary strip ─────────────────────────────────────────────────────────────────────────────
const cellText = (strip, key) => (strip.match(new RegExp('data-strip="' + key + '"><div class="inv-strip-label"[^>]*>[\\s\\S]*?<\\/div><div class="inv-strip-value([^"]*)">([\\s\\S]*?)<\\/div><\\/div>')) || [])
  .slice(1).map((s, i) => i === 1 ? s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() : s.trim());

test('summary strip: Market value, Cost basis, Unrealised and Showing, with the arrow and sign in the Overview format', async () => {
  const { ctx } = await loadApp();
  const gain = ctx.kjrSummaryStripHtml({ label: 'Singles summary', rows: 12, units: 16, cost: 1000, value: 1500, fresh: '<i class="dot"></i>' });
  assert.match(gain, /^<div class="inv-strip" role="group" aria-label="Singles summary">/);
  assert.deepEqual(cellText(gain, 'value'), ['', 'S$1,500']);
  assert.match(gain, /data-strip="value"><div class="inv-strip-label" title="[^"]+">Market value<i class="dot"><\/i><\/div>/, 'the price age dot sits beside the label');
  assert.deepEqual(cellText(gain, 'cost'), ['', 'S$1,000']);
  assert.deepEqual(cellText(gain, 'gain'), ['pos', '▲ +S$500 · +50.0%']);
  assert.match(gain, /<span aria-hidden="true">▲<\/span> \+S\$500/);
  assert.deepEqual(cellText(gain, 'showing'), ['', '12 cards · 16 units']);
  const loss = ctx.kjrSummaryStripHtml({ rows: 1, units: 1, cost: 200, value: 150 });
  assert.deepEqual(cellText(loss, 'gain'), ['neg', '▼ -S$50 · -25.0%']);
  assert.deepEqual(cellText(loss, 'showing'), ['', '1 card · 1 unit']);
  const big = ctx.kjrSummaryStripHtml({ rows: 3, units: 3, cost: 100, value: 1234 });
  assert.deepEqual(cellText(big, 'gain'), ['pos', '▲ +S$1,134 · +1134%'], 'three digit percentages drop the decimal, like the Overview chip');
  const flat = ctx.kjrSummaryStripHtml({ rows: 2, units: 2, cost: 100, value: 100 });
  assert.deepEqual(cellText(flat, 'gain'), ['', 'S$0 · 0%'], 'no arrow and no colour for nothing');
  const noCost = ctx.kjrSummaryStripHtml({ rows: 2, units: 2, cost: 0, value: 75 });
  assert.deepEqual(cellText(noCost, 'gain'), ['pos', '▲ +S$75'], 'no cost, no percentage');
  const slabs = ctx.kjrSummaryStripHtml({ rows: 4, cost: 10, value: 12 });
  assert.deepEqual(cellText(slabs, 'showing'), ['', '4 slabs']);
  assert.deepEqual(cellText(ctx.kjrSummaryStripHtml({ rows: 1, cost: 10, value: 12 }), 'showing'), ['', '1 slab']);
  const empty = ctx.kjrSummaryStripHtml({ label: '<x>', rows: 0, units: 0, cost: 0, value: 0 });
  assert.deepEqual(cellText(empty, 'value'), ['', '-']);
  assert.deepEqual(cellText(empty, 'cost'), ['', '-']);
  assert.deepEqual(cellText(empty, 'gain'), ['', '-']);
  assert.deepEqual(cellText(empty, 'showing'), ['', '0 cards · 0 units']);
  assert.match(empty, /aria-label="&lt;x&gt;"/, 'the label is escaped');
  assert.doesNotThrow(() => ctx.kjrSummaryStripHtml());
});

test('summary strip: Singles figures follow the filters, count Available rows only, and use quantity', async () => {
  const seed = makeSeed({ singles: [
    single({ id: '1', name: 'Pikachu A', qty: 2, costPrice: 10, marketPrice: 20 }),
    single({ id: '2', name: 'Mew B', qty: 1, costPrice: 30, marketPrice: 25, language: 'JP' }),
    single({ id: '3', name: 'Sold C', qty: 5, costPrice: 99, marketPrice: 99, status: 'Sold' }),
    single({ id: '4', name: 'Unpriced D', qty: 1, costPrice: 8, marketPrice: '' }),
  ] });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSingles();
  const strip = () => document.getElementById('singles-stats').innerHTML;
  // Pikachu 2 x 20 = 40, Mew 25, Unpriced counts at cost 8 (an estimate): 73. Cost 20 + 30 + 8 = 58.
  assert.deepEqual(cellText(strip(), 'value'), ['', 'S$73']);
  assert.deepEqual(cellText(strip(), 'cost'), ['', 'S$58']);
  assert.deepEqual(cellText(strip(), 'gain'), ['pos', '▲ +S$15 · +25.9%']);
  assert.deepEqual(cellText(strip(), 'showing'), ['', '3 cards · 4 units']);
  document.getElementById('singles-search').value = 'pikachu';
  ctx.renderSingles();
  assert.deepEqual(cellText(strip(), 'value'), ['', 'S$40']);
  assert.deepEqual(cellText(strip(), 'cost'), ['', 'S$20']);
  assert.deepEqual(cellText(strip(), 'gain'), ['pos', '▲ +S$20 · +100%']);
  assert.deepEqual(cellText(strip(), 'showing'), ['', '1 card · 2 units']);
  document.getElementById('singles-search').value = '';
  document.getElementById('singles-lang').value = 'JP';
  ctx.renderSingles();
  assert.deepEqual(cellText(strip(), 'value'), ['', 'S$25']);
  assert.deepEqual(cellText(strip(), 'gain'), ['neg', '▼ -S$5 · -16.7%']);
  assert.deepEqual(cellText(strip(), 'showing'), ['', '1 card · 1 unit']);
  document.getElementById('singles-lang').value = '';
  document.getElementById('sf-cost').value = '>25';
  ctx.renderSingles();
  assert.deepEqual(cellText(strip(), 'showing'), ['', '1 card · 1 unit'], 'a column filter narrows it too');
  document.getElementById('sf-cost').value = '';
  document.getElementById('singles-search').value = 'no such card';
  ctx.renderSingles();
  assert.deepEqual(cellText(strip(), 'gain'), ['', '-'], 'nothing shown, nothing to report');
  assert.deepEqual(cellText(strip(), 'showing'), ['', '0 cards · 0 units']);
  assert.doesNotMatch(strip(), /inv-stat|inv-split|Raw vs Sealed/, 'the old tiles and the split are gone');
});

test('summary strip: Grid view draws it too, and Slabs shows slab counts with no grader split', async () => {
  const seed = makeSeed({ singles: [single({ id: '1', costPrice: 10, marketPrice: 30 })], slabs: [slab({ id: 'p1', costPrice: 100, marketPrice: 150 }), slab({ id: 'p2', grader: 'CGC', grade: '9', costPrice: 50, marketPrice: 40 }), slab({ id: 'p3', status: 'Sold' })] });
  const { ctx, document } = await loadApp({ seed, localStorage: { kjr_view_singles: 'grid', kjr_view_slabs: 'grid' } });
  ctx.renderSingles(); ctx.renderSlabs();
  assert.equal(document.getElementById('page-inventory').classList.contains('kjr-view-grid'), true, 'Singles is in Grid view');
  assert.deepEqual(cellText(document.getElementById('singles-stats').innerHTML, 'gain'), ['pos', '▲ +S$20 · +200%']);
  const s = document.getElementById('slabs-stats').innerHTML;
  assert.deepEqual(cellText(s, 'value'), ['', 'S$190']);
  assert.deepEqual(cellText(s, 'cost'), ['', 'S$150']);
  assert.deepEqual(cellText(s, 'gain'), ['pos', '▲ +S$40 · +26.7%']);
  assert.deepEqual(cellText(s, 'showing'), ['', '2 slabs'], 'the sold slab is not counted');
  assert.match(s, /aria-label="Slabs summary"/);
  assert.doesNotMatch(s, /Grader Split|inv-split|inv-stat"/);
  document.getElementById('slabs-search').value = 'umbreon';
  ctx.renderSlabs();
  assert.deepEqual(cellText(document.getElementById('slabs-stats').innerHTML, 'showing'), ['', '2 slabs']);
  document.getElementById('slabs-grader').value = 'CGC';
  ctx.renderSlabs();
  assert.deepEqual(cellText(document.getElementById('slabs-stats').innerHTML, 'showing'), ['', '1 slab'], 'the Filters dropdowns narrow it');
  assert.match(html, /<div class="inv-strip-host" id="singles-stats"><\/div>/);
  assert.match(html, /<div class="inv-strip-host" id="slabs-stats"><\/div>/);
});

// ── quiet tags, status dots and neutral deletes ───────────────────────────────────────────────
test('quiet tags: the language tag has no inline fill or border, the badge function output is unchanged', async () => {
  const seed = makeSeed({ singles: [single({ id: '1', language: 'JP' })], slabs: [slab({ id: 'p1', language: 'CN' })] });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSingles(); ctx.renderSlabs();
  const s = document.getElementById('singles-body').innerHTML;
  const p = document.getElementById('slabs-body').innerHTML;
  assert.match(s, /<td data-col-key="language"><span class="badge b-lang">JP<\/span><\/td>/);
  assert.match(p, /<td data-col-key="language"><span class="badge b-lang">CN<\/span><\/td>/);
  assert.match(s, /<span class="badge b-raw">Raw<\/span>/, 'the type badge keeps its class');
  assert.doesNotMatch(s + p, /class="badge[^"]*" style="background:var\(--bg3\)/);
  assert.match(ctx.graderGradeBadge('PSA', '10'), /^<span class="badge b-psa" style="font-size:13px;font-weight:600;letter-spacing:0.2px;padding:3px 10px">PSA 10<\/span>$/);
  assert.match(ctx.graderGradeBadge('TAG', '10', 'Pristine'), /class="badge b-pristine"/);
  assert.match(ctx.kjrPill('In Stock'), /^<span class="kjr-status-pill kjr-pill-stock">In Stock<\/span>$/);
});

test('quiet tags: the CSS is outline tags, one neutral grader chip with a dot, and status as a dot and a word', () => {
  assert.match(css, /\.b-lang,\.b-raw,\.b-sealed\{background:transparent;color:var\(--text2\);border:1px solid var\(--border2\);border-radius:6px;/);
  assert.match(css, /\.b-lang\{font-family:var\(--font-mono\);font-weight:400\}/);
  assert.match(css, /\.b-raw,\.b-sealed\{font-family:var\(--font-sans\);font-weight:500\}/);
  assert.match(css, /\.badge\.b-psa,\.badge\.b-cgc,\.badge\.b-tag,\.badge\.b-slab,\.badge\.b-pristine\{gap:6px;background:var\(--bg3\);color:var\(--text\);border:1px solid var\(--border2\);box-shadow:none\}/);
  assert.match(css, /::before\{content:"";flex:none;width:8px;height:8px;border-radius:50%;background:var\(--kjr-dot,var\(--text3\)\)\}/);
  assert.match(css, /\.badge\.b-psa\{--kjr-dot:var\(--grader-psa\)\}/);
  assert.match(css, /\.badge\.b-cgc\{--kjr-dot:var\(--grader-cgc\)\}/);
  assert.match(css, /\.badge\.b-tag\{--kjr-dot:var\(--text\)\}/);
  assert.match(css, /\.badge\.b-slab\{--kjr-dot:var\(--text3\)\}/);
  assert.match(css, /\.badge\.b-pristine\{--kjr-dot:var\(--b-pristine-fg\);border-color:var\(--b-pristine-bd\)\}/, 'Pristine keeps a gold dot and a gold hairline');
  assert.match(css, /\.kjr-status-pill\{display:inline-flex;align-items:center;gap:6px;padding:0;border:0;border-radius:0;background:transparent;color:var\(--text2\)/);
  assert.match(css, /\.kjr-status-pill::before\{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var\(--kjr-pill-dot,var\(--text3\)\)\}/);
  for (const k of ['stock', 'sold', 'traded', 'pending', 'received']) {
    assert.match(css, new RegExp('\\.kjr-pill-' + k + '\\{--kjr-pill-dot:var\\(--pill-' + k + '-fg\\)\\}'));
    assert.doesNotMatch(css, new RegExp('\\.kjr-pill-' + k + '\\{background'), 'no fill on the ' + k + ' pill any more');
  }
});

test('neutral delete: the Sales, Sealed and eBay row deletes carry .kjr-del-x and no inline red, the rule goes red on hover and focus', async () => {
  const seed = makeSeed({
    sales: [{ id: 'sa1', dateSold: '1 Jan 2025', product: 'Sold card', buyer: 'b', costPrice: 5, totalCollected: 9, shippingCost: 1, fees: 0, channel: 'eBay', daysHeld: 3, profit: 3, margin: '30%' }],
    etbs: [{ id: 'e1', product: 'ETB', totalPrice: 50, status: 'In Stock', condition: 'Mint', date: '2026-01-01' }],
    boosterBoxes: [{ id: 'b1', product: 'Box', unitPrice: 100, qty: 1, totalPrice: 100, status: 'Unopened Stock', date: '2026-01-01' }],
    boosterPacks: [{ id: 'k1', product: 'Pack', unitPrice: 5, qty: 2, totalPrice: 10, status: 'Sealed', date: '2026-01-01' }],
    ebayPurchases: [{ id: 'x1', date: '2026-01-01', product: 'Buy', status: 'Paid', priceUsd: 10, freightSgd: 1, totalSgd: 14 }],
  });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSales(); ctx.renderEtbs(); ctx.renderBoosterBoxes(); ctx.renderBoosterPacks(); ctx.renderEbayPurchases();
  for (const [body, handler] of [['sales-body', 'deleteItem('], ['kjr-etb-body', "kjrDeleteRow('etbs'"], ['kjr-bb-body', "kjrDeleteRow('boosterBoxes'"], ['kjr-bp-body', "kjrDeleteRow('boosterPacks'"], ['kjr-ebay-body', "kjrDeleteRow('ebayPurchases'"]]) {
    const out = document.getElementById(body).innerHTML;
    const del = out.match(new RegExp('<button[^>]*onclick="' + handler.replace(/[()]/g, '\\$&') + '[^>]*>[^<]*</button>'));
    assert.ok(del, body + ' has its delete button');
    assert.match(del[0], /class="btn btn-ghost btn-sm kjr-del-x"/, body);
    assert.doesNotMatch(del[0], /color:var\(--red\)/, body + ': no inline red');
    assert.match(del[0], /title="Delete/, body + ': a hint for the neutral cross');
  }
  assert.match(css, /\.kjr-del-x\{color:var\(--text3\)\}\s*\.kjr-del-x:hover,\.kjr-del-x:focus-visible\{color:var\(--red\)\}/);
});

test('step 4 CSS: the "…" is half strength on a mouse and full on touch, the menu is fixed above the popovers, and Sold rows do not dim it', () => {
  assert.match(css, /\.kjr-more\{[^}]*width:36px;height:36px;[^}]*opacity:0\.55;/);
  assert.match(css, /tr:hover \.kjr-more,tr:focus-within \.kjr-more,\.kjr-more:focus-visible,\.kjr-more\[aria-expanded="true"\]\{opacity:1\}/);
  assert.match(css, /@media\(pointer:coarse\)\{\.kjr-more\{opacity:1;width:44px;height:44px\}\}/);
  assert.match(css, /\.kjr-rowmenu\{position:fixed;z-index:170;/);
  assert.match(css, /\.kjr-rowmenu\[hidden\]\{display:none\}/);
  assert.match(css, /\.kjr-rowmenu \.is-danger\{color:var\(--red\)\}/);
  assert.match(css, /#page-inventory tr\.sold-row td\[data-col-key="actions"\],\s*#page-slabs tr\.sold-row td\[data-col-key="actions"\]\{opacity:1\}/);
  assert.match(css, /@media\(pointer:coarse\)\{\.kjr-rowmenu \[role="menuitem"\]\{min-height:44px\}\}/);
  assert.match(css, /@media\(max-width:1100px\)\{\s*\.inv-strip\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/, 'the strip is 2x2 on narrow windows');
  assert.match(css, /@media\(max-width:600px\)\{\s*\.inv-strip-cell\{padding:12px 14px\}/);
});
