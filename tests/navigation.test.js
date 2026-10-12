'use strict';
// Redesign Step 6a (v3.73): the navigation shell and the phone layout.
// One .topbar element is a fixed sidebar (1280px and wider), a 64px icon rail (601px to 1279px) and the sticky phone header
// (600px and below), the bottom tab bar is the phone's other half, and Singles and Slabs get Holdings rows on a phone.
// This suite pins the markup (every page reachable, the tab bar's shape, the sync status button), the script (sidebar counts,
// the relative time, the indicator's words per state, the Holdings rows and their one delegated click) and the stylesheet
// (tokens only, the three layouts, the offsets, no backdrop-filter on the shell). The harness has no layout engine, so
// widths and overflow are checked in a browser, not here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, makeSeed, plain, ROOT } = require('./harness.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
const features = fs.readFileSync(ROOT + '/features.js', 'utf8');

const single = (o) => Object.assign({}, makeSeed().singles[0], o);
const slab = (o) => Object.assign({
  id: 'slab_1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '12345678', rank: '',
  language: 'EN', costPrice: 520, marketPrice: 610, listPrice: '', dateListed: '3 Jul 2026', status: 'Available',
  notes: '', priceAlert: '', _updatedAt: new Date().toISOString(),
}, o);
const BASE = 'https://assets.tcgdex.net/en/swsh/swsh7/215';

// ── the markup ──────────────────────────────────────────────────────────────────────────────
// the logo is an 85KB data URI, left out so a failing assertion stays readable
const topbar = html.slice(html.indexOf('<div class="topbar">'), html.indexOf('<div class="main">')).replace(/src="data:image\/png;base64,[^"]*"/, 'src="data:image/png;base64,..."');
const navHtml = topbar.slice(topbar.indexOf('<nav class="nav"'), topbar.indexOf('</nav>'));
// every nav-btn: its label, the page its inline handler opens, its visible text
const navItems = [...navHtml.matchAll(/<button class="nav-btn( active)?" aria-label="([^"]*)" onclick="showPage\('([A-Za-z]+)'\)">([\s\S]*?)<\/button>/g)]
  .map(m => ({ label: m[2], page: m[3], active: !!m[1], text: (m[4].match(/<span>([^<]*)<\/span>/) || [])[1] }));
const pageIds = [...html.matchAll(/<div id="page-([A-Za-z]+)" class="page/g)].map(m => m[1]);
const tabBar = html.slice(html.indexOf('<div class="bottom-tab-bar"'), html.indexOf('<!-- MORE SHEET'));
const sheetPages = [...html.slice(html.indexOf('<dialog class="sheet-overlay" id="more-sheet-overlay">')).matchAll(/<button class="sheet-item" data-page="([A-Za-z]+)" onclick="moreGo\('([A-Za-z]+)'\)">/g)];

test('sidebar: the topbar element stays before .main, with the logo, the search and Add, the nav and the footer in that order', () => {
  assert.ok(topbar.startsWith('<div class="topbar">') && topbar.length > 1000);
  assert.equal((html.match(/<div class="topbar">/g) || []).length, 1, 'one shell element');
  const at = (s) => topbar.indexOf(s);
  assert.ok(at('class="logo"') < at('class="kjr-side-actions"') && at('class="kjr-side-actions"') < at('<nav class="nav"') && at('<nav class="nav"') < at('class="topbar-actions"'));
  assert.match(topbar, /<button class="logo" type="button" onclick="showPage\('dashboard'\)" aria-label="Open overview">/);
  assert.match(topbar, /<span class="logo-title">Kujira<\/span>\s*<span class="logo-sub">Collectibles<\/span>/);
  assert.match(topbar, /<button type="button" class="kjr-side-search" onclick="openCmdBar\('find'\)" aria-label="Search" aria-keyshortcuts="Control\+K Meta\+K">[\s\S]*?<span class="kjr-side-label">Search<\/span>\s*<kbd class="kjr-kbd" aria-hidden="true">⌘K<\/kbd>/);
  assert.match(topbar, /<button type="button" class="kjr-side-add" onclick="openCmdBar\(\)" aria-label="Add">[\s\S]*?<span class="kjr-side-label">Add<\/span>/);
  assert.doesNotMatch(topbar, /btn btn-primary btn-sm|Quick add \/ log sale/, 'the old Quick Entry button is gone');
  assert.doesNotMatch(topbar, /nav-dd-trigger|data-dd="more"|toggleNavDD\('more'/, 'and so is the More dropdown');
  assert.ok(html.indexOf('<div class="topbar">') < html.indexOf('<div class="main">'));
});

test('sidebar: every item is a button with an aria-label equal to its visible label and an inline showPage handler', () => {
  assert.deepEqual(navItems.map(i => [i.label, i.page]), [
    ['Overview', 'dashboard'],
    ['Singles', 'inventory'], ['Slabs', 'slabs'], ['ETBs', 'etbs'], ['Boxes &amp; packs', 'boosterBoxes'],
    ['Listings', 'listing'], ['eBay', 'ebay'], ['Sales', 'sales'], ['Dealer Desk', 'dealerProduction'],
    ['Reports', 'reports'], ['Import', 'import'], ['History', 'changelog'], ['Trash', 'trash'], ['Guide', 'guide'],
  ]);
  for (const i of navItems) assert.equal(i.text, i.label, i.label + ': the span says what the aria-label says');
  assert.deepEqual(navItems.filter(i => i.active).map(i => i.page), ['dashboard'], 'Overview is current on first paint');
  assert.match(navHtml, /<button class="nav-btn active" aria-label="Overview" onclick="showPage\('dashboard'\)">/, 'the pinned form');
  // every item has an 18px-stroke icon from the redesign set, hidden from assistive tech
  const icons = [...navHtml.matchAll(/<button class="nav-btn[^"]*"[^>]*>\s*<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">/g)];
  assert.equal(icons.length, navItems.length);
  // three labelled groups, in the order of the design: Collection, Selling, Workspace
  assert.deepEqual([...navHtml.matchAll(/<div class="kjr-nav-label" id="(nav-g-[a-z]+)">([^<]*)<\/div>/g)].map(m => [m[1], m[2]]),
    [['nav-g-collection', 'Collection'], ['nav-g-selling', 'Selling'], ['nav-g-workspace', 'Workspace']]);
  assert.equal((navHtml.match(/role="group" aria-labelledby="nav-g-/g) || []).length, 3);
  // counts only on the four Collection items
  assert.deepEqual([...navHtml.matchAll(/<span class="kjr-nav-count" id="([^"]+)"><\/span>/g)].map(m => m[1]),
    ['nav-count-inventory', 'nav-count-slabs', 'nav-count-etbs', 'nav-count-boosterBoxes']);
  assert.match(navHtml, /<nav class="nav" aria-label="Main">/);
});

test('every page is reachable from the sidebar, and the phone reaches every page the tab bar has no tab for through More', async () => {
  const { ctx } = await loadApp();
  const sidebar = navItems.map(i => i.page);
  // "dealer" is the loopback fixture's page, showPage rewrites it to dealerProduction outside that fixture
  assert.deepEqual([...pageIds].filter(p => p !== 'dealer').sort(), [...sidebar].sort(), 'every page has exactly one sidebar item');
  const tabPages = [...tabBar.matchAll(/<button class="btb-item[^"]*" id="btb-([A-Za-z]+)" onclick="showPage\('([A-Za-z]+)'\)">/g)].map(m => { assert.equal(m[1], m[2]); return m[1]; });
  assert.deepEqual(tabPages, ['dashboard', 'inventory', 'sales']);
  const sheet = sheetPages.map(m => { assert.equal(m[1], m[2], 'the data-page and the handler agree'); return m[1]; });
  assert.deepEqual([...sheet].sort(), sidebar.filter(p => !tabPages.includes(p)).sort(), 'the More sheet holds every page the tab bar does not');
  assert.deepEqual(sheet, ['slabs', 'etbs', 'boosterBoxes', 'listing', 'ebay', 'dealerProduction', 'reports', 'import', 'changelog', 'trash', 'guide']);
  for (const p of sheet) assert.ok(ctx.MORE_PAGES.has(p), p + ' is in MORE_PAGES, so the More tab lights for it');
  for (const p of tabPages) assert.equal(ctx.MORE_PAGES.has(p), false, p + ' has its own tab');
  for (const p of ['dealer', 'boosterPacks']) assert.ok(ctx.MORE_PAGES.has(p), p + ' (no page of its own to open from the sheet) still lights More');
  assert.match(html, /<button class="sheet-item" data-page="reports" onclick="moreGo\('reports'\)">/, 'the pinned Reports markup');
  assert.match(html, /<span id="more-layout-label">Layout: Cards<\/span>/, 'and the Layout toggle is still in Tools');
});

test('tab bar: four tabs and one raised Add in the middle, the Add is not a tab', () => {
  assert.match(tabBar, /^<div class="bottom-tab-bar" id="bottom-tab-bar" role="navigation" aria-label="Main">/);
  assert.equal((tabBar.match(/class="btb-item/g) || []).length, 4, 'exactly four .btb-item');
  assert.equal((tabBar.match(/class="btb-add"/g) || []).length, 1, 'and one .btb-add');
  const order = [...tabBar.matchAll(/class="(btb-item(?: active)?|btb-add)"(?: id="([^"]+)")?/g)].map(m => m[2] || m[1]);
  assert.deepEqual(order, ['btb-dashboard', 'btb-inventory', 'btb-add', 'btb-sales', 'btb-more']);
  assert.match(tabBar, /<button class="btb-add" type="button" aria-label="Add" onclick="openCmdBar\(\)">/);
  assert.doesNotMatch(tabBar.match(/<button class="btb-add"[^>]*>/)[0], /btb-item/, 'the Add never takes the active state');
  assert.match(tabBar, /id="btb-inventory" onclick="showPage\('inventory'\)">[\s\S]*?<\/svg>\s*Collection\s*<\/button>/, 'Collection is Singles');
  assert.match(tabBar, /id="btb-more" onclick="openMoreSheet\(\)">/);
  assert.match(tabBar, /id="btb-dashboard" onclick="showPage\('dashboard'\)">[\s\S]*?<\/svg>\s*Overview\s*<\/button>/, 'the pinned Overview form');
  assert.doesNotMatch(tabBar, /btb-slabs|btb-ebay/, 'Slabs and eBay moved into More');
  assert.match(tabBar.match(/<button class="btb-add"[\s\S]*?<\/button>/)[0], /stroke-width="2\.4"/, 'the plus is drawn at 2.4');
});

test('footer: the sync button keeps its attributes in order, is never hidden, and holds the dot, both lines and the build version', () => {
  const btn = topbar.match(/<button id="sync-indicator"[^>]*>/)[0];
  assert.match(btn, /^<button id="sync-indicator" type="button" onclick="openSyncDiagnostics\(\)" aria-label="Cloud sync status" aria-haspopup="dialog" aria-controls="sync-diagnostics-overlay" aria-expanded="false"/);
  assert.doesNotMatch(btn, /\shidden\b|aria-live/, 'never hidden on desktop, and no live region on a control that changes every minute');
  const inner = topbar.slice(topbar.indexOf(btn), topbar.indexOf('</button>', topbar.indexOf(btn)));
  assert.match(inner, /<span class="kjr-sync-dot" aria-hidden="true"><\/span>/);
  assert.match(inner, /<span class="kjr-sync-line1" id="sync-label">Not synced yet<\/span>/);
  assert.match(inner, /<span class="kjr-sync-line2"><span id="sync-ago"><\/span><span id="app-ver" title="[^"]*">v3\.74 \(12 Oct\)<\/span><\/span>/);
  assert.match(topbar, /<span class="sr-only" id="sync-live" role="status"><\/span>/, 'a change of state is announced from here');
  // the badge is one line with the shape qc.sh and misc-consistency parse, and there is one of it
  const line = html.split('\n').filter(l => l.includes('id="app-ver"'));
  assert.equal(line.length, 1);
  assert.match(line[0], /id="app-ver"[^>]*>v3\.74 \(12 Oct\)<\/span>/);
  assert.doesNotMatch(line[0].match(/<span id="app-ver"[^>]*>/)[0], /style=/, 'no inline style, the stylesheet sizes it');
});

test('footer: Settings keeps its name, points at a hidden status text, carries a decorative mirror dot, and its menu opens with Sync status', () => {
  const settings = topbar.match(/<button class="icon-btn"[^>]*id="settings-btn">[\s\S]*?<\/button>/)[0];
  assert.match(settings, /aria-label="Settings"/, 'overview.test.js pins the name');
  assert.match(settings, /aria-describedby="settings-sync-status"/);
  assert.match(settings, /title="Settings"/);
  assert.match(settings, /<span class="kjr-sync-dot kjr-sync-mirror" aria-hidden="true"><\/span>/);
  assert.match(topbar, /<span class="sr-only" id="settings-sync-status">Sync status: not synced yet<\/span>/);
  const menu = topbar.slice(topbar.indexOf('<div class="nav-dd-menu dd-right">'));
  assert.match(menu, /^<div class="nav-dd-menu dd-right">\s*<button class="nav-dd-item kjr-dd-sync" id="settings-sync-item" type="button" onclick="kjrOpenSyncStatus\(\)">/, 'Sync status is the first item');
  assert.match(menu, /<span class="kjr-dd-sync-sub" id="settings-sync-state">Not synced yet<\/span>/);
  assert.ok(menu.indexOf('settings-sync-item') < menu.indexOf('API settings'));
  for (const text of ['API settings', 'Version history', 'Health check', 'Error log', 'Reset view', 'Toggle theme', 'Launch intro', 'Sign out']) assert.match(menu, new RegExp(text), text + ' is still in the menu');
});

test('Holdings containers: one pair per list inside the page, ahead of the grid, empty in the markup', () => {
  for (const [id, page] of [['singles', 'page-inventory'], ['slabs', 'page-slabs']]) {
    const pageHtml = html.slice(html.indexOf('<div id="' + page + '"'));
    const wrap = pageHtml.match(new RegExp('<div class="kjr-hold-wrap" id="' + id + '-hold-wrap">\\s*<div class="kjr-hold" id="' + id + '-cards" role="group" aria-label="[^"]*"></div>\\s*<div class="kjr-hold-alt" id="' + id + '-sold-cards"></div>\\s*</div>'));
    assert.ok(wrap, id + ': wrap, list and sold containers');
    assert.ok(pageHtml.indexOf('id="' + id + '-hold-wrap"') < pageHtml.indexOf('id="' + id + '-grid-wrap"'));
    assert.ok(pageHtml.indexOf('<table id="' + id + '-table">') < pageHtml.indexOf('id="' + id + '-hold-wrap"'), 'the table is untouched and comes first');
  }
});

// ── the sidebar counts ──────────────────────────────────────────────────────────────────────────
test('counts: Singles and Slabs count Available rows (no status is Available), the Sealed tables their own on-hand rows, Boxes & packs both', async () => {
  const seed = makeSeed({
    singles: [single({ id: 'a' }), single({ id: 'b', status: '' }), single({ id: 'c', status: undefined }), single({ id: 'd', status: 'Sold' }), single({ id: 'e', status: 'Reserved' })],
    slabs: [slab({ id: 'p1' }), slab({ id: 'p2', status: 'Sold' }), slab({ id: 'p3', status: '' })],
    etbs: [{ id: 'e1', status: 'In Stock' }, { id: 'e2', status: 'Sold' }, { id: 'e3', status: 'Traded' }],
    boosterBoxes: [{ id: 'b1', status: 'Unopened Stock' }, { id: 'b2', status: 'Reserved' }, { id: 'b3', status: 'Opened' }],
    boosterPacks: [{ id: 'k1', status: 'Sealed' }, { id: 'k2', status: 'Opened' }, { id: 'k3', status: 'Sold' }],
  });
  const { ctx, document } = await loadApp({ seed });
  const counts = plain(ctx.kjrNavCountsRefresh());
  assert.deepEqual(counts, { singles: 3, slabs: 2, etbs: 1, boxes: 3 }, 'boxes: 2 boxes on hand and 1 sealed pack');
  const text = (id) => document.getElementById(id).textContent;
  assert.equal(text('nav-count-inventory'), '3');
  assert.equal(text('nav-count-slabs'), '2');
  assert.equal(text('nav-count-etbs'), '1');
  assert.equal(text('nav-count-boosterBoxes'), '3');
});

test('counts: a big number gets thousands separators, empty tables say 0, and bad data never throws into a render', async () => {
  const many = Array.from({ length: 1234 }, (_, n) => single({ id: 's' + n }));
  const { ctx, document } = await loadApp({ seed: makeSeed({ singles: many, slabs: [] }) });
  ctx.kjrNavCountsRefresh();
  assert.equal(document.getElementById('nav-count-inventory').textContent, '1,234');
  assert.equal(document.getElementById('nav-count-slabs').textContent, '0');
  assert.deepEqual(plain(ctx.kjrNavCounts({ singles: [null, undefined, 5, { status: 'Available' }], slabs: 'nope', etbs: null })), { singles: 1, slabs: 0, etbs: 0, boxes: 0 });
  assert.deepEqual(plain(ctx.kjrNavCounts({})), { singles: 0, slabs: 0, etbs: 0, boxes: 0 });
  ctx.kjrNavCounts = () => { throw new Error('boom'); };
  assert.equal(ctx.kjrNavCountsRefresh(), null, 'a failure is swallowed, the page render carries on');
});

test('counts: they follow the renders (Singles, Slabs, the Sealed pages, the Overview, a page change) and are drawn once at boot', async () => {
  const { ctx, document } = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a' })] }) });
  assert.equal(document.getElementById('nav-count-inventory').textContent, '1', 'drawn once features.js loaded, the first renders ran before it');
  const cases = [['renderSingles', 'nav-count-inventory'], ['renderSlabs', 'nav-count-slabs'], ['renderEtbs', 'nav-count-etbs'], ['renderBoosterBoxes', 'nav-count-boosterBoxes'], ['renderBoosterPacks', 'nav-count-boosterBoxes'], ['renderDashboard', 'nav-count-inventory']];
  for (const [fn, id] of cases) {
    const el = document.getElementById(id);
    el.textContent = 'stale';
    ctx[fn]();
    assert.notEqual(el.textContent, 'stale', fn + ' redraws the counts');
  }
  const el = document.getElementById('nav-count-slabs');
  el.textContent = 'stale';
  ctx.showPage('trash');
  assert.notEqual(el.textContent, 'stale', 'and so does changing page');
});

// ── the sync status ─────────────────────────────────────────────────────────────────────────────
function resetSync(ctx) {
  ctx._syncDiagnostics.failures = {};
  ctx._syncDiagnostics.successes = { read: null, write: null };
  ctx._syncDiagnostics.retryReview = null;
  ctx._syncStatus = 'idle';
  ctx._syncDiagPendingSnapshot = () => ({ unknown: [], total: 0 });
}

test('relative time: just now, N min ago, N h ago, then the date as DD/MM/YYYY in Singapore time, and nothing for no stamp', async () => {
  const { ctx } = await loadApp();
  const NOW = Date.UTC(2026, 9, 12, 4, 0, 0); // 12/10/2026 12:00 in Singapore
  const ago = (ms) => ctx._syncDiagAgoText(NOW - ms, NOW);
  assert.equal(ago(0), 'just now');
  assert.equal(ago(59 * 1000), 'just now');
  assert.equal(ago(-30 * 1000), 'just now', 'a stamp a little ahead of this clock');
  assert.equal(ago(60 * 1000), '1 min ago');
  assert.equal(ago(2 * 60000 + 59000), '2 min ago');
  assert.equal(ago(59 * 60000), '59 min ago');
  assert.equal(ago(60 * 60000), '1 h ago');
  assert.equal(ago(23 * 3600000 + 59 * 60000), '23 h ago');
  assert.equal(ago(24 * 3600000), '11/10/2026', 'a day or more is a date, not "1 d ago"');
  assert.equal(ago(40 * 86400000), '02/09/2026');
  for (const bad of [0, -1, null, undefined, NaN, '5', {}, Infinity]) assert.equal(ctx._syncDiagAgoText(bad, NOW), '', 'no stamp: ' + String(bad));
  assert.match(ctx._syncDiagAgoText(Date.now() - 5 * 60000), /^5 min ago$/, 'the clock is Date.now() when no "now" is given');
});

test('relative time: the newest of the confirmed read and write is the one shown', async () => {
  const { ctx } = await loadApp();
  resetSync(ctx);
  assert.equal(ctx._syncDiagLatestSuccess(), 0);
  ctx._syncDiagnostics.successes = { read: 1000, write: null };
  assert.equal(ctx._syncDiagLatestSuccess(), 1000);
  ctx._syncDiagnostics.successes = { read: 1000, write: 5000 };
  assert.equal(ctx._syncDiagLatestSuccess(), 5000);
  ctx._syncDiagnostics.successes = { read: 9000, write: 5000 };
  assert.equal(ctx._syncDiagLatestSuccess(), 9000);
  ctx._syncDiagnostics.successes = { read: 'x', write: NaN };
  assert.equal(ctx._syncDiagLatestSuccess(), 0, 'a bad value is no value');
});

test('indicator: the words per state, the dot colour hook, the name and the tooltip', async () => {
  const { ctx, document } = await loadApp();
  const shell = document.getElementById('topbar-fixture');
  const btn = document.getElementById('sync-indicator');
  btn.closest = (sel) => sel === '.topbar' ? shell : null;
  const text = (id) => document.getElementById(id).textContent;
  const render = () => { ctx._syncDiagRenderIndicator(); return { label: text('sync-label'), ago: text('sync-ago'), aria: btn.getAttribute('aria-label'), tip: btn.getAttribute('data-tip'), state: btn.dataset.state, sync: shell.dataset.sync, title: btn.title, hidden: btn.hidden }; };

  // idle: nothing confirmed yet. The button is NOT hidden any more and says so in words
  resetSync(ctx);
  assert.deepEqual(render(), { label: 'Not synced yet', ago: '', aria: 'Not synced yet, open diagnostics', tip: 'Not synced yet', state: 'idle', sync: 'idle', title: 'Cloud sync status', hidden: false });

  // saving
  ctx._syncStatus = 'saving';
  assert.deepEqual(render(), { label: 'Syncing…', ago: '', aria: 'Syncing…, open diagnostics', tip: 'Syncing…', state: 'saving', sync: 'saving', title: 'Cloud sync status', hidden: false });

  // ok, two minutes after a confirmed read
  ctx._syncStatus = 'idle';
  ctx._syncDiagnostics.successes = { read: Date.now() - 2 * 60000, write: null };
  assert.deepEqual(render(), { label: 'Synced', ago: '2 min ago · ', aria: 'Synced 2 min ago, open diagnostics', tip: 'Synced · 2 min ago', state: 'ok', sync: 'ok', title: 'Open cloud sync diagnostics', hidden: false });

  // pending work needs attention
  ctx._syncDiagPendingSnapshot = () => ({ unknown: [], total: 2 });
  let r = render();
  assert.equal(r.label, 'Sync pending');
  assert.equal(r.state, 'pending');
  assert.equal(r.aria, 'Sync pending, last synced 2 min ago, open diagnostics');
  assert.equal(r.title, 'Pending work needs attention');

  // error: red dot and the words "Sync error", still the way into the diagnostics
  ctx._syncDiagPendingSnapshot = () => ({ unknown: [], total: 0 });
  ctx._syncDiagnostics.failures = { read: { at: Date.now(), code: 'network', detail: 'offline' } };
  r = render();
  assert.equal(r.label, 'Sync error');
  assert.equal(r.state, 'error');
  assert.equal(r.sync, 'error');
  assert.equal(r.aria, 'Sync error, last synced 2 min ago, open diagnostics');
  assert.equal(r.title, 'Open cloud sync diagnostics');
  assert.equal(r.hidden, false);

  // the four words are exactly the design's
  assert.deepEqual(['saving', 'ok', 'pending', 'error', 'idle'].map(s => ctx._syncDiagStatusCopy(s)), ['Syncing…', 'Synced', 'Sync pending', 'Sync error', 'Not synced yet']);
  assert.equal(ctx._syncDiagStatusCopy('nonsense'), '');
});

test('indicator: the phone gets the same words on the Settings button, its hidden status text and the menu item, and a stable name', async () => {
  const { ctx, document } = await loadApp();
  resetSync(ctx);
  ctx._syncDiagnostics.successes = { read: Date.now() - 5 * 60000, write: null };
  ctx._syncDiagRenderIndicator();
  const settings = document.getElementById('settings-btn');
  assert.equal(settings.title, 'Settings · Synced 5 min ago');
  assert.equal(document.getElementById('settings-sync-status').textContent, 'Sync status: Synced 5 min ago');
  assert.equal(document.getElementById('settings-sync-state').textContent, 'Synced 5 min ago');
  ctx._syncDiagnostics.failures = { write: { at: Date.now(), code: 'x', detail: 'y' } };
  ctx._syncDiagRenderIndicator();
  assert.equal(settings.title, 'Settings · Sync error, last synced 5 min ago');
});

test('indicator: a change of state is announced, a page load and the minute tick are not', async () => {
  const { ctx, document } = await loadApp();
  resetSync(ctx);
  ctx._syncDiagAnnounced = null;
  const live = document.getElementById('sync-live');
  live.textContent = '';
  ctx._syncDiagRenderIndicator();
  assert.equal(live.textContent, '', 'the first draw is the baseline');
  ctx._syncDiagnostics.successes = { read: Date.now() - 60000, write: null };
  ctx._syncDiagRenderIndicator();
  assert.equal(live.textContent, 'Synced 1 min ago', 'idle to ok says so');
  live.textContent = '';
  ctx._syncDiagnostics.successes = { read: Date.now() - 3 * 60000, write: null };
  ctx._syncDiagRenderIndicator();
  assert.equal(live.textContent, '', 'the same state a few minutes later says nothing');
  ctx._syncDiagnostics.failures = { read: { at: Date.now(), code: 'x', detail: 'y' } };
  ctx._syncDiagRenderIndicator();
  assert.equal(live.textContent, 'Sync error, last synced 3 min ago');
});

test('indicator: one 60 second interval for the life of the page, however often it is drawn', async () => {
  const { ctx, timers } = await loadApp();
  for (let n = 0; n < 5; n++) ctx._syncDiagRenderIndicator();
  const ticks = timers.list().filter(t => t.type === 'interval' && t.delay === 60000);
  assert.equal(ticks.length, 1);
  // running the tick redraws and does not throw, and does not add another interval
  ctx._syncDiagnostics.successes = { read: Date.now() - 4 * 60000, write: null };
  timers.invoke(ticks[0].id);
  assert.equal(timers.list().filter(t => t.type === 'interval' && t.delay === 60000).length, 1);
});

test('indicator: it only changes presentation, it never writes the diagnostics or the data', async () => {
  const { ctx, localStorage } = await loadApp();
  const before = JSON.stringify(plain(ctx._syncDiagnostics));
  const store = localStorage.getItem('pokeinventory_v3');
  const keys = localStorage._store.size;
  for (let n = 0; n < 3; n++) ctx._syncDiagRenderIndicator();
  assert.equal(JSON.stringify(plain(ctx._syncDiagnostics)), before);
  assert.equal(localStorage.getItem('pokeinventory_v3'), store);
  assert.equal(localStorage._store.size, keys);
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const body = src.slice(src.indexOf('function _syncDiagRenderIndicator()'), src.indexOf('function _syncDiagSetSettledStatus()'));
  assert.doesNotMatch(body, /_syncDiagPersist|saveData|markDirty|fetch\(|localStorage|_syncDiagnostics\.[a-z]+\s*=[^=]/);
});

test('Sync status menu item: closes the menu, puts focus on Settings (where the dialog gives it back) and opens the diagnostics', async () => {
  const { ctx, document } = await loadApp();
  const order = [];
  const settings = document.getElementById('settings-btn');
  settings.focus = () => order.push('focus');
  ctx.closeNavDD = () => order.push('close');
  ctx.openSyncDiagnostics = () => order.push('open');
  ctx.kjrOpenSyncStatus();
  assert.deepEqual(order, ['close', 'focus', 'open']);
});

test('the sync progress bar sits beside the sidebar and under the phone header, through the shell variables', async () => {
  const { ctx, document } = await loadApp();
  const bar = { style: {} };
  const real = document.getElementById.bind(document);
  document.getElementById = (id) => id === 'sync-progress-bar' ? null : real(id); // none drawn yet, so it creates one
  document.createElement = () => bar;
  document.body.appendChild = () => {};
  ctx.showSyncProgress(1, 4, 'Importing');
  assert.match(bar.style.cssText, /position:fixed;top:var\(--kjr-top-off,0px\);left:var\(--kjr-side-w,0px\);right:0;z-index:110;/);
  assert.doesNotMatch(bar.style.cssText, /56px/);
});

// ── the Holdings rows ───────────────────────────────────────────────────────────────────────────
test('Holdings row: a button with the art, the name, the set and language, the value and the gain, and no inline handler', async () => {
  const { ctx } = await loadApp();
  ctx.kjrRememberCardImage('swsh7-215', BASE, 'en');
  const row = ctx.kjrHoldRowHtml(single({ id: 'u1', name: 'Umbreon VMAX 215/203', set: 'Evolving Skies', language: 'EN', tcgdexId: 'swsh7-215', costPrice: 100, marketPrice: 150 }), 'singles', false);
  assert.match(row, /^<button type="button" class="kjr-hold-row" data-table="singles" data-id="u1" aria-label="[^"]*">/);
  assert.match(row, /<span class="kjr-art kjr-thumb" data-sz="t"><img class="kjr-card-img" src="https:\/\/assets\.tcgdex\.net\/en\/swsh\/swsh7\/215\/low\.webp"/, 'the thumbnail is kjrThumbHtml');
  assert.match(row, /<span class="kjr-hold-name">Umbreon VMAX 215\/203<\/span>/);
  assert.match(row, /<span class="kjr-hold-sub">Evolving Skies · <span class="kjr-hold-lang">EN<\/span><\/span>/, 'set · language, the language tag is the mono one');
  assert.match(row, /<span class="kjr-hold-price">S\$150<\/span>/);
  assert.match(row, /<span class="kjr-hold-pct pos">▲ \+50\.0%<\/span>/, 'the arrow and the sign, not colour alone');
  assert.match(row, /aria-label="Umbreon VMAX 215\/203, Evolving Skies · EN, S\$150, up 50\.0%"/);
  assert.doesNotMatch(row, /\son\w+=/i, 'no inline handler on the row, the container has the one listener');
  assert.match(row, /<\/button>$/);
});

test('Holdings row: a loss is down with its sign, a flat card says 0%, an estimate gets ~ and no gain, an unpriced card gets a dash', async () => {
  const { ctx } = await loadApp();
  const up = (o) => ctx.kjrHoldRowHtml(single(o), 'singles', false);
  const loss = up({ id: 'l', costPrice: 100, marketPrice: 75 });
  assert.match(loss, /<span class="kjr-hold-price">S\$75<\/span>/);
  assert.match(loss, /<span class="kjr-hold-pct neg">▼ -25\.0%<\/span>/);
  assert.match(loss, /S\$75, down 25\.0%"/);
  const flat = up({ id: 'f', costPrice: 50, marketPrice: 50 });
  assert.match(flat, /<span class="kjr-hold-pct ">0%<\/span>/);
  assert.doesNotMatch(flat, /up |down /, 'a flat card is neither');
  const est = up({ id: 'e', costPrice: 15, marketPrice: '' });
  assert.match(est, /<span class="kjr-hold-price">~S\$15<\/span>/, 'estimated from cost, marked with ~');
  assert.doesNotMatch(est, /kjr-hold-pct/, 'an estimate from cost has no gain to show');
  assert.match(est, /estimated S\$15"/);
  const none = up({ id: 'n', costPrice: 0, marketPrice: '' });
  assert.match(none, /<span class="kjr-hold-price">-<\/span>/);
  assert.doesNotMatch(none, /kjr-hold-pct/);
  assert.match(none, /, no price"/);
  const big = up({ id: 'b', costPrice: 10, marketPrice: 1380 });
  assert.match(big, /S\$1,380/, 'thousands separators');
  assert.match(big, /▲ \+13700%/, 'a gain of 100% or more is a whole number');
});

test('Holdings row: language blank means EN, a Japanese card says JP, a lot says its quantity, a sold row says Sold in words', async () => {
  const { ctx } = await loadApp();
  const sub = (o, table, sold) => { const h = ctx.kjrHoldRowHtml(o, table || 'singles', !!sold); return h.match(/<span class="kjr-hold-sub">([\s\S]*?)<\/span><\/span><span class="kjr-hold-val">/)[1]; };
  assert.equal(sub(single({ language: '', set: 'Base Set' })), 'Base Set · <span class="kjr-hold-lang">EN</span>');
  assert.equal(sub(single({ language: 'jp', set: 'Lost Origin' })), 'Lost Origin · <span class="kjr-hold-lang">JP</span>');
  assert.equal(sub(single({ set: '', language: 'EN' })), '<span class="kjr-hold-lang">EN</span>', 'no set, no dangling dot');
  assert.equal(sub(single({ set: 'Base Set', qty: 6 })), 'Base Set · <span class="kjr-hold-lang">EN</span> · ×6');
  assert.equal(sub(single({ set: 'Base Set', qty: '3' })), 'Base Set · <span class="kjr-hold-lang">EN</span> · ×3', 'a stored string quantity');
  assert.equal(sub(single({ set: 'Base Set', qty: 0 })), 'Base Set · <span class="kjr-hold-lang">EN</span>', 'zero or junk is one card');
  const sold = ctx.kjrHoldRowHtml(single({ id: 'x', set: 'Base Set', status: 'Sold' }), 'singles', true);
  assert.match(sold, /^<button type="button" class="kjr-hold-row is-sold"/);
  assert.match(sold, /<span class="kjr-hold-sub">Base Set · <span class="kjr-hold-lang">EN<\/span> · Sold<\/span>/);
  assert.match(sold, /aria-label="Pikachu 25, Base Set · EN · Sold, S\$15, up 50\.0%"/, 'and the accessible name says it too');
});

test('Holdings row: a slab shows grader and grade as plain text, TAG and pristine and unknown graders read right, and it uses the slab thumbnail', async () => {
  const { ctx } = await loadApp();
  const sub = (o) => ctx.kjrHoldRowHtml(slab(o), 'slabs', false).match(/<span class="kjr-hold-sub">([\s\S]*?)<\/span><\/span><span class="kjr-hold-val">/)[1];
  assert.equal(sub({ grader: 'PSA', grade: '10' }), 'PSA 10');
  assert.equal(sub({ grader: 'CGC', grade: '9.5' }), 'CGC 9.5');
  assert.equal(sub({ grader: 'BGS', grade: '9.5' }), 'BGS 9.5');
  assert.equal(sub({ grader: 'TAG', grade: '10 Pristine' }), 'TAG 10 ★');
  assert.equal(sub({ grader: '', grade: '' }), '? ?');
  const row = ctx.kjrHoldRowHtml(slab({ id: 'p1', grader: 'PSA', grade: '10' }), 'slabs', false);
  assert.match(row, /data-table="slabs" data-id="p1"/);
  assert.match(row, /class="kjr-art kjr-thumb kjr-thumb-slab kjr-g-psa/, 'the grader bar thumbnail');
  assert.doesNotMatch(row, /kjr-hold-lang/, 'a slab has no language tag in the sub line');
  assert.match(row, /aria-label="Umbreon VMAX 215\/203, PSA 10, S\$610, up 17\.3%"/);
});

test('Holdings row: everything that comes from the row is escaped, odd ids survive in the attribute', async () => {
  const { ctx } = await loadApp();
  const evil = single({ id: 'x"><img src=x onerror=1>', name: '<img src=x onerror=1> "q" & \'a\'', set: '<b>Set</b>', language: '<EN>' });
  const row = ctx.kjrHoldRowHtml(evil, 'singles', false);
  assert.doesNotMatch(row, /<img src=x|<b>Set|<EN>/, 'no tag from a field survives');
  assert.doesNotMatch(row.replace(/"[^"]*"/g, '""'), /<[^>]*\son\w+=/i, 'no event handler attribute outside a quoted value');
  assert.match(row, /&lt;img src=x onerror=1&gt; &quot;q&quot; &amp; &#39;a&#39;/);
  const raw = row.match(/data-id="([^"]*)"/)[1];
  const decoded = raw.replace(/&(amp|lt|gt|quot|#39);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[n]));
  assert.equal(decoded, evil.id, 'the id round-trips');
  assert.equal(ctx.kjrHoldRowHtml(single({ name: '' }), 'singles', false).includes('<span class="kjr-hold-name">-</span>'), true, 'a blank name is a dash');
});

// the phone list view, driven the way a phone runs it: the compact media query on, Tables layout off
function phone(app, on) {
  app.sandbox.matchMedia = (q) => ({ matches: !!on && /max-width:600px/.test(q), media: q, addEventListener() {}, removeEventListener() {} });
}
const rowIds = (markup) => [...markup.matchAll(/class="kjr-hold-row[^"]*" data-table="[a-z]+" data-id="([^"]*)"/g)].map(m => m[1]);

test('Holdings: nothing is built on a desktop or in the Tables layout, the rows are built (and the table hidden by the page class) on a phone', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a', name: 'Alpha 1' }), single({ id: 'b', name: 'Bravo 2' })], slabs: [slab({ id: 'p' })] }) });
  const { ctx, document } = app;
  const list = document.getElementById('singles-cards');
  const page = document.getElementById('page-inventory');
  phone(app, false);
  ctx.renderSingles();
  assert.equal(list.innerHTML, '', 'a desktop pays nothing');
  assert.equal(page.classList.contains('kjr-hold-on'), false);
  assert.ok(document.getElementById('singles-body').innerHTML.includes('data-id="a"'), 'the table is still built');

  phone(app, true);
  ctx.renderSingles();
  assert.deepEqual(rowIds(list.innerHTML).sort(), ['a', 'b']);
  assert.equal(page.classList.contains('kjr-hold-on'), true);
  assert.ok(document.getElementById('singles-body').innerHTML.includes('data-id="a"'), 'the table DOM is untouched underneath');

  document.body.classList.add('force-tables');
  ctx.renderSingles();
  assert.equal(list.innerHTML, '', 'the Tables layout gives the table back');
  assert.equal(page.classList.contains('kjr-hold-on'), false);
  document.body.classList.remove('force-tables');

  ctx.renderSlabs();
  assert.deepEqual(rowIds(document.getElementById('slabs-cards').innerHTML), ['p']);
  assert.equal(document.getElementById('page-slabs').classList.contains('kjr-hold-on'), true);
});

test('Holdings: the Grid view keeps the grid on a phone, switching back draws the rows again', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a' })] }), localStorage: { kjr_view_singles: 'grid' } });
  const { ctx, document } = app;
  phone(app, true);
  ctx.renderSingles();
  assert.equal(document.getElementById('singles-cards').innerHTML, '');
  assert.equal(document.getElementById('page-inventory').classList.contains('kjr-hold-on'), false);
  assert.ok(document.getElementById('singles-grid').innerHTML.includes('kjr-tile'), 'the tiles are drawn');
  ctx.kjrSetView('singles', 'list');
  assert.deepEqual(rowIds(document.getElementById('singles-cards').innerHTML), ['a']);
});

test('Holdings: the rows are the table\'s rows in the table\'s order, which is the order the inspector steps through, for every status filter', async () => {
  const seed = makeSeed({
    singles: [single({ id: 'a', name: 'Alpha 1' }), single({ id: 'b', name: 'Bravo 2', status: 'Sold' }), single({ id: 'c', name: 'Charlie 3' }), single({ id: 'd', name: 'Delta 4', status: 'Sold' })],
  });
  const app = await loadApp({ seed });
  const { ctx, document } = app;
  phone(app, true);
  const inTable = () => [...document.getElementById('singles-body').innerHTML.matchAll(/<tr data-id="([^"]*)"/g)].map(m => m[1]);
  const status = document.getElementById('singles-status-filter');
  const divider = document.getElementById('singles-sold-divider');
  const main = () => rowIds(document.getElementById('singles-cards').innerHTML);
  const soldBox = () => document.getElementById('singles-sold-cards').innerHTML;

  status.value = 'available';
  ctx.renderSingles();
  assert.deepEqual(main(), inTable());
  assert.deepEqual(main().length, 2);
  assert.match(soldBox(), /<button type="button" class="sold-section-toggle" data-kjr-act="alt" aria-expanded="false"><span aria-hidden="true">▶<\/span><span>Show Sold<\/span><span class="sold-count-badge">2<\/span><\/button>$/, 'the collapsed Sold section is a toggle with its count');
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), main());

  divider.dataset.open = '1';
  ctx.renderSingles();
  assert.match(soldBox(), /aria-expanded="true"><span aria-hidden="true">▼<\/span><span>Hide Sold<\/span>/);
  const open = rowIds(soldBox());
  assert.equal(open.length, 2);
  assert.match(soldBox(), /class="kjr-hold-row is-sold"/, 'the Sold rows are dimmed and say so');
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), main().concat(open), '"Card N of M" follows what is on screen');
  assert.deepEqual(main().concat(open), inTable().concat([...document.getElementById('singles-sold-body').innerHTML.matchAll(/<tr data-id="([^"]*)"/g)].map(m => m[1])));

  status.value = 'all';
  ctx.renderSingles();
  assert.equal(soldBox(), '', 'status "all" shows the Sold rows inline, no toggle');
  assert.deepEqual(main(), inTable());
  assert.equal(main().length, 4);
  assert.match(document.getElementById('singles-cards').innerHTML, /kjr-hold-row is-sold/);
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), main());

  status.value = 'sold';
  divider.dataset.open = '0';
  ctx.renderSingles();
  assert.equal(main().length, 2);
  assert.ok(main().every(id => ['b', 'd'].includes(id)));
  assert.match(soldBox(), /Show Available/);
});

test('Holdings: search and filters narrow the rows exactly as they narrow the table, and an empty list says what the table says', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a', name: 'Alpha 1' }), single({ id: 'b', name: 'Bravo 2' })] }) });
  const { ctx, document } = app;
  phone(app, true);
  document.getElementById('singles-search').value = 'bravo';
  ctx.renderSingles();
  assert.deepEqual(rowIds(document.getElementById('singles-cards').innerHTML), ['b']);
  document.getElementById('singles-search').value = 'no card is called this';
  ctx.renderSingles();
  const empty = document.getElementById('singles-cards').innerHTML;
  assert.match(empty, /No matches/);
  assert.match(empty, /Nothing matches the current search or filters\. Clear them to see everything\./);
  assert.doesNotMatch(empty, /btn-primary|onclick/, 'no add button in a filtered-empty state');
  document.getElementById('singles-search').value = '';
  ctx.DB.singles = [];
  ctx.renderSingles();
  const none = document.getElementById('singles-cards').innerHTML;
  assert.match(none, /No singles yet/);
  assert.match(none, /Add your first one to get started\./);
  assert.match(none, /<button type="button" class="btn btn-primary" data-kjr-act="add">\+ Add your first card<\/button>/);
  assert.doesNotMatch(none, /\sonclick=/, 'the button is wired by the container\'s one delegated listener');
  assert.equal(document.getElementById('page-inventory').classList.contains('kjr-hold-on'), true, 'the empty state replaces the table too');
});

test('Holdings: one delegated click per container opens the card inspector with the row as the trigger, and the Sold toggle and Add button work too', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a' })], slabs: [slab({ id: 'p' })] }) });
  const { ctx, document } = app;
  for (const id of ['singles-cards', 'singles-sold-cards', 'slabs-cards', 'slabs-sold-cards']) {
    assert.equal(document.getElementById(id)._listeners.get('click').length, 1, id + ' has exactly one click listener');
  }
  phone(app, true);
  ctx.renderSingles(); ctx.renderSlabs(); ctx.renderSingles();
  assert.equal(document.getElementById('singles-cards')._listeners.get('click').length, 1, 'a redraw does not stack listeners');
  ctx.kjrInspectBindRows();
  assert.equal(document.getElementById('slabs-cards')._listeners.get('click').length, 1, 'binding again is a no-op');

  const calls = [];
  ctx.kjrInspect = (table, id, opts) => { calls.push(['inspect', table, id, opts && opts.trigger]); return true; };
  ctx.toggleSoldSection = (t) => calls.push(['toggle', t]);
  ctx.openAddSingle = () => calls.push(['add-single']);
  ctx.openAddSlab = () => calls.push(['add-slab']);
  const el = (attrs) => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null) });
  const hit = (target) => ({ target: { closest: () => target } });
  const rowEl = el({ 'data-id': 'a' }); const slabEl = el({ 'data-id': 'p' });
  document.getElementById('singles-cards')._listeners.get('click')[0](hit(rowEl));
  document.getElementById('slabs-cards')._listeners.get('click')[0](hit(slabEl));
  document.getElementById('singles-sold-cards')._listeners.get('click')[0](hit(el({ 'data-kjr-act': 'alt' })));
  document.getElementById('singles-cards')._listeners.get('click')[0](hit(el({ 'data-kjr-act': 'add' })));
  document.getElementById('slabs-cards')._listeners.get('click')[0](hit(el({ 'data-kjr-act': 'add' })));
  document.getElementById('singles-cards')._listeners.get('click')[0]({ target: { closest: () => null } }); // a tap on empty space
  document.getElementById('singles-cards')._listeners.get('click')[0](hit(el({}))); // no id, no action
  assert.deepEqual(calls, [['inspect', 'singles', 'a', rowEl], ['inspect', 'slabs', 'p', slabEl], ['toggle', 'singles'], ['add-single'], ['add-slab']]);
  assert.equal(ctx.kjrHoldClick('singles', null), false);
  assert.equal(ctx.kjrHoldClick('singles', { target: {} }), false);
});

test('Holdings: the inspector highlights the row, finds it again for focus, and the zones list both containers', async () => {
  const { ctx } = await loadApp();
  for (const [t, ids] of [['singles', ['singles-cards', 'singles-sold-cards']], ['slabs', ['slabs-cards', 'slabs-sold-cards']]]) {
    for (const id of ids) assert.ok(ctx.KJR_INSP_ZONES[t].includes(id), t + ' zones include ' + id);
    for (const id of [t + '-body', t + '-sold-body', t + '-grid', t + '-grid-alt']) assert.ok(ctx.KJR_INSP_ZONES[t].includes(id), 'and still ' + id);
  }
  // focus returns to a row button: the row is its own focus target, there is no nested name button
  const src = features.slice(features.indexOf('function kjrInspectFocusBack'), features.indexOf('// Opens the inspector on a row'));
  assert.match(src, /els\[j\]\.tagName === 'BUTTON' \? els\[j\] : null/);
});

test('Holdings: the redraw keeps keyboard focus on the same row or the Sold toggle', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a', name: 'Alpha 1' }), single({ id: 'b', name: 'Bravo 2' })] }) });
  const { ctx, document } = app;
  phone(app, true);
  ctx.renderSingles();
  const focused = [];
  const list = document.getElementById('singles-cards');
  const makeEl = (key, attr) => ({ getAttribute: (k) => (k === attr ? key : null), focus: () => focused.push(key) });
  const rowA = makeEl('a', 'data-id');
  const rowB = makeEl('b', 'data-id');
  list.contains = (n) => n === rowA || n === rowB;
  list.querySelectorAll = (sel) => sel === '[data-id], [data-kjr-act]' ? [rowA, rowB] : [];
  document.activeElement = rowB;
  ctx.renderSingles();
  assert.deepEqual(focused, ['b'], 'the focused row is focused again after the list is redrawn');
  focused.length = 0;
  document.activeElement = { getAttribute: () => null, nodeType: 1 };
  ctx.renderSingles();
  assert.deepEqual(focused, [], 'focus somewhere else is left alone');
});

test('Holdings: the layout switch and the 600px query redraw the page that is showing and empty the other', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a' })], slabs: [slab({ id: 'p' })] }) });
  const { ctx, document, localStorage } = app;
  const drawn = [];
  ctx.renderSingles = () => drawn.push('singles');
  ctx.renderSlabs = () => drawn.push('slabs');
  document.getElementById('page-inventory').classList.add('active');
  phone(app, true);
  ctx.kjrHoldRefresh();
  assert.deepEqual(drawn, ['singles'], 'only the page that is showing is redrawn');
  drawn.length = 0;
  document.getElementById('singles-cards').innerHTML = '<x>';
  document.getElementById('slabs-cards').innerHTML = '<y>';
  document.getElementById('page-slabs').classList.add('kjr-hold-on');
  phone(app, false);
  ctx.kjrHoldRefresh();
  assert.deepEqual(drawn, [], 'wider than a phone: nothing to redraw');
  assert.equal(document.getElementById('singles-cards').innerHTML, '');
  assert.equal(document.getElementById('slabs-cards').innerHTML, '');
  assert.equal(document.getElementById('page-slabs').classList.contains('kjr-hold-on'), false);
  // the More sheet's Layout switch calls it
  phone(app, true);
  ctx.kjrToggleTableMode();
  assert.equal(localStorage.getItem('kjr_force_tables'), '1');
  assert.equal(document.body.classList.contains('force-tables'), true);
  assert.deepEqual(drawn, [], 'in Tables layout the rows are cleared, not drawn');
  ctx.kjrToggleTableMode();
  assert.deepEqual(drawn, ['singles'], 'back to the phone layout the page is redrawn');
  // and the media query is listened to once, at load
  assert.match(features, /window\.matchMedia && window\.matchMedia\('\(max-width:600px\)'\)/);
});

test('Holdings: building the rows writes nothing, marks nothing dirty and never fetches', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a', tcgdexId: 'swsh7-215' })], slabs: [slab({ id: 'p' })] }) });
  const { ctx, localStorage, fetchMock } = app;
  phone(app, true);
  const before = { db: JSON.stringify(plain(ctx.DB)), store: localStorage.getItem('pokeinventory_v3'), keys: localStorage._store.size, dirty: JSON.stringify(plain(ctx._dirty || {})) };
  const fetches = fetchMock.calls.length;
  ctx.renderSingles(); ctx.renderSlabs();
  ctx.kjrHoldRowHtml(ctx.DB.singles[0], 'singles', false);
  assert.equal(JSON.stringify(plain(ctx.DB)), before.db);
  assert.equal(localStorage.getItem('pokeinventory_v3'), before.store);
  assert.equal(localStorage._store.size, before.keys);
  assert.equal(JSON.stringify(plain(ctx._dirty || {})), before.dirty);
  assert.equal(fetchMock.calls.length, fetches);
  const sec = features.slice(features.indexOf('Navigation shell and phone Holdings (v3.73)'), features.indexOf('Card inspector (v3.72)'));
  assert.ok(sec.length > 3000);
  assert.doesNotMatch(sec, /\bmarkDirty\(|\bsaveData\(|\bsaveAllToSupabase\(|snapshotForUndo\(|localStorage\.setItem|\bfetch\(|DB\.(singles|slabs)\s*=[^=]/, 'the section has no write call');
});

// ── the rail's tooltips ─────────────────────────────────────────────────────────────────────────
test('rail tooltip: the text is the data-tip or the aria-label, plus the count on a nav item', async () => {
  const { ctx } = await loadApp();
  const el = (attrs, count) => ({ getAttribute: (k) => (k in attrs ? attrs[k] : null), querySelector: (s) => s === '.kjr-nav-count' && count !== undefined ? { textContent: count } : null });
  assert.equal(ctx.kjrNavTipText(el({ 'aria-label': 'Singles' }, '9')), 'Singles · 9');
  assert.equal(ctx.kjrNavTipText(el({ 'aria-label': 'Singles' }, '')), 'Singles', 'an empty count adds nothing');
  assert.equal(ctx.kjrNavTipText(el({ 'aria-label': 'Boxes &amp; packs' })), 'Boxes &amp; packs', 'the DOM unescapes it before the browser sees it');
  assert.equal(ctx.kjrNavTipText(el({ 'aria-label': 'Cloud sync status, open diagnostics', 'data-tip': 'Synced · 2 min ago' })), 'Synced · 2 min ago', 'the sync button says its state, not its instruction');
  assert.equal(ctx.kjrNavTipText(el({})), '');
  assert.equal(ctx.kjrNavTipText(null), '');
  assert.equal(ctx.kjrNavTipText({}), '');
});

test('rail tooltip: the rail is 601px to 1279px, and 1280px to 1599px while the card inspector is open', async () => {
  const app = await loadApp();
  const { ctx, document } = app;
  const only = (...ranges) => { app.sandbox.matchMedia = (q) => ({ matches: ranges.includes(q), media: q, addEventListener() {} }); };
  assert.equal(ctx.kjrRailActive(), false, 'the harness matches nothing');
  only(ctx.KJR_RAIL_MQ);
  assert.equal(ctx.kjrRailActive(), true);
  only(ctx.KJR_RAIL_SPLIT_MQ);
  assert.equal(ctx.kjrRailActive(), false, 'the sidebar is a sidebar until the inspector opens');
  document.body.classList.add('kjr-insp-open');
  assert.equal(ctx.kjrRailActive(), true);
  document.body.classList.remove('kjr-insp-open');
  assert.equal(ctx.KJR_RAIL_MQ, '(min-width: 601px) and (max-width: 1279px)');
  assert.equal(ctx.KJR_RAIL_SPLIT_MQ, '(min-width: 1280px) and (max-width: 1599px)');
});

test('rail tooltip: one fixed element that is not a child of the scrolling nav, hidden from assistive tech, and native titles are lifted while it shows', () => {
  const src = features.slice(features.indexOf('function kjrNavTipInstall()'), features.indexOf('// ── Phone Holdings rows.'));
  assert.match(src, /tip\.setAttribute\('role', 'tooltip'\)/);
  assert.match(src, /tip\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(src, /document\.body\.appendChild\(tip\)/);
  assert.match(src, /el\.removeAttribute\('title'\)/);
  assert.match(src, /lifted\.el\.setAttribute\('title', lifted\.title\)/);
  assert.match(src, /shell\.addEventListener\('click', hide, true\)/, 'capture: Settings stops its click from bubbling');
  assert.match(src, /shell\.addEventListener\('focusin'/, 'keyboard focus shows it too');
  assert.match(src, /:focus-visible/, 'but a mouse click does not leave it behind');
  assert.match(src, /e\.key === 'Escape'/);
  assert.match(css, /\.kjr-tip\{position:fixed;z-index:9000;/);
});

// ── the stylesheet ──────────────────────────────────────────────────────────────────────────────
const shellStart = css.indexOf('/* ═══════════ Navigation shell (redesign Step 6a, v3.73)');
const shell = css.slice(shellStart);
const shellRules = shell.replace(/\/\*[\s\S]*?\*\//g, '');

test('css: the shell section is new and last, tokens only, and every media query in it is written with spaces', () => {
  assert.ok(shellStart > 0 && css.indexOf('Card inspector (redesign Step 5, v3.72)') < shellStart, 'after the inspector section, last in the file');
  assert.doesNotMatch(shellRules, /#[0-9a-fA-F]{3,8}\b(?![-\w])/, 'no hex colour');
  assert.doesNotMatch(shellRules.replace(/rgba?\(0,0,0/g, ''), /rgba?\(/, 'no colour function with a literal');
  assert.doesNotMatch(shellRules, /@media\(/, 'the compact form is for the older sections, overview.test.js finds its blocks with lastIndexOf on it');
  assert.doesNotMatch(shellRules, /will-change|row-selected/);
  assert.equal(css.lastIndexOf('@media(max-width:900px){') < shellStart, true);
});

test('css: the --sidebar token exists in both themes, one step above the ground', () => {
  assert.match(css, /:root\{[\s\S]*?--sidebar:#0E0E12;/);
  assert.match(css, /html\.light\{[\s\S]*?--sidebar:#FBFBFC;/);
  assert.equal((css.match(/--sidebar:#/g) || []).length, 2);
});

test('css: the shell geometry variables are 232px, 64px and 0, and the page is padded by them', () => {
  assert.match(css, /--kjr-side-w:calc\(232px \+ env\(safe-area-inset-left\)\);--kjr-top-off:env\(safe-area-inset-top\);--kjr-tab-h:60px;--kjr-tab-lift:14px;/);
  assert.match(shellRules, /@media \(min-width: 601px\) and \(max-width: 1279px\)\{\s*:root\{--kjr-side-w:calc\(64px \+ env\(safe-area-inset-left\)\)\}/);
  assert.match(shellRules, /@media \(max-width: 600px\)\{\s*:root\{--kjr-side-w:0px;--kjr-top-off:calc\(56px \+ env\(safe-area-inset-top\)\)\}/);
  assert.match(shellRules, /body\{padding-left:var\(--kjr-side-w\)\}/);
  assert.match(shellRules, /@media \(min-width: 1280px\)\{\s*\.topbar\{width:var\(--kjr-side-w\);/);
  assert.match(shellRules, /@media \(min-width: 601px\) and \(max-width: 1279px\)\{\s*\.topbar\{width:var\(--kjr-side-w\);align-items:center;/);
});

test('css: the shell has no backdrop-filter, the old top bar rules are gone, and the sidebar is a fixed full-height column on the sidebar token', () => {
  assert.doesNotMatch(css, /\.topbar\{[^}]*backdrop-filter/);
  assert.doesNotMatch(css, /\.topbar[^{]*\{[^}]*(?:-webkit-)?backdrop-filter/);
  assert.doesNotMatch(css, /\.topbar\{background:var\(--bg2\);background:color-mix/, 'the translucent top bar is gone');
  assert.doesNotMatch(css, /\.nav-dd-trigger|\.nav-dd-caret|contains-active/, 'and the More dropdown\'s styles');
  assert.doesNotMatch(css, /\.nav-btn span\{display:none\}/, 'the old label-hiding rules');
  assert.match(shellRules, /\.topbar\{position:fixed;top:0;bottom:0;left:0;z-index:100;box-sizing:border-box;display:flex;flex-direction:column;background:var\(--sidebar\);border-right:1px solid var\(--border\)\}/);
  assert.doesNotMatch(css.slice(0, shellStart), /bottom-tab-bar\{[^}]*backdrop-filter/, 'nor on the tab bar');
  assert.doesNotMatch(shellRules, /backdrop-filter/);
});

test('css: items are 40px with 18px icons, the active item is an accent-soft pill with an accent icon, hover is a surface token', () => {
  assert.match(shellRules, /\.nav-btn\{[^}]*height:40px;[^}]*padding:0 10px;[^}]*border-radius:10px;[^}]*color:var\(--text2\);[^}]*font-size:14px;font-weight:500;/);
  assert.match(shellRules, /\.nav-btn\{[^}]*gap:10px;/);
  assert.match(shellRules, /\.nav-btn svg\{flex:none;width:18px;height:18px\}/);
  assert.match(shellRules, /\.nav-btn:hover\{background:var\(--bg3\);color:var\(--text\)\}/);
  assert.match(shellRules, /\.nav-btn\.active\{background:var\(--accent-soft\);color:var\(--text\)\}/);
  assert.match(shellRules, /\.nav-btn\.active svg\{color:var\(--accent\)\}/);
  assert.match(shellRules, /\.kjr-nav-label\{[^}]*font-size:12px;font-weight:500;[^}]*color:var\(--text3\)\}/);
  assert.match(shellRules, /\.kjr-nav-count\{[^}]*font-size:12px;[^}]*color:var\(--text3\);font-variant-numeric:tabular-nums\}/);
  assert.match(shellRules, /\.logo-whale\{flex:none;width:40px;height:40px;object-fit:contain\}/);
  assert.match(shellRules, /\.logo-title\{font-size:15px;font-weight:600;/);
  assert.match(shellRules, /\.logo-sub\{font-size:12px;font-weight:400;color:var\(--text3\)\}/);
  assert.match(shellRules, /\.kjr-side-search\{[^}]*height:40px;[^}]*background:var\(--bg2\)/);
  assert.match(shellRules, /\.kjr-side-add\{[^}]*height:40px;[^}]*background:var\(--accent\);color:var\(--accent-fg\)/);
});

test('css: the nav scrolls on its own and the footer stays, the footer is a card, and the dot colours come from data-sync', () => {
  assert.match(shellRules, /\.nav\{display:flex;flex-direction:column;gap:18px;flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;/);
  assert.match(shellRules, /\.topbar-actions\{display:flex;align-items:center;gap:4px;flex:none;margin:0;padding:8px 6px 8px 10px;border:1px solid var\(--border\);border-radius:12px;background:var\(--bg2\)\}/);
  assert.match(shellRules, /\.topbar\[data-sync="ok"\]\{--kjr-dot:var\(--green\);--kjr-ring:var\(--green-soft\)\}/);
  assert.match(shellRules, /\.topbar\[data-sync="saving"\],\.topbar\[data-sync="pending"\]\{--kjr-dot:var\(--amber\);--kjr-ring:var\(--amber-soft\)\}/);
  assert.match(shellRules, /\.topbar\[data-sync="error"\]\{--kjr-dot:var\(--red\);--kjr-ring:var\(--red-soft\)\}/);
  assert.match(shellRules, /\.kjr-sync-dot\{flex:none;width:8px;height:8px;border-radius:50%;background:var\(--kjr-dot,var\(--text3\)\);box-shadow:0 0 0 3px var\(--kjr-ring,var\(--bg3\)\)\}/, 'idle is grey, with a 3px soft ring');
  assert.match(shellRules, /\.topbar\[data-sync="error"\] \.kjr-sync-line1\{color:var\(--red\)\}/);
  assert.match(shellRules, /\.topbar\[data-sync="error"\] #sync-indicator:hover/, 'an error reads as clickable on hover and focus');
  assert.match(shellRules, /\.topbar #settings-btn\{position:relative;flex:none;width:36px;height:36px;/);
  assert.match(shellRules, /\.topbar \.nav-dd-menu\.dd-right\{top:auto;bottom:calc\(100% \+ 17px\);left:auto;right:-9px\}/, 'the menu opens upward from the sidebar footer');
  assert.match(shellRules, /\.topbar \.nav-dd-menu\.dd-right\{min-width:208px;max-height:calc\(100vh - 96px\);overflow-y:auto;/, 'and scrolls inside itself when the window is short');
});

test('css: the rail is 64px with centred items, labels, counts and footer text hidden, group labels as separators, and a menu that opens to the right', () => {
  const rail = shellRules.slice(shellRules.indexOf('@media (min-width: 601px) and (max-width: 1279px){\n  .topbar'), shellRules.indexOf('@media (min-width: 1280px) and (max-width: 1599px)'));
  assert.match(rail, /\.nav-btn\{justify-content:center;width:max\(40px,var\(--kjr-item\)\);height:var\(--kjr-item\);padding:0\}/, 'at least 40px wide, square once the item is taller');
  assert.match(rail, /\.nav-btn>span\{display:none\}/, 'the label span and the count span');
  assert.match(rail, /\.logo-name\{display:none\}/);
  assert.match(rail, /\.kjr-side-label,\.kjr-kbd\{display:none\}/);
  assert.match(rail, /\.kjr-sync-text\{display:none\}/);
  assert.match(rail, /\.kjr-nav-label\{width:24px;height:1px;[^}]*background:var\(--border2\);font-size:0;/, 'a thin separator, the words stay for assistive tech');
  assert.match(rail, /\.topbar \.nav-dd-menu\.dd-right\{top:auto;bottom:-6px;left:calc\(100% \+ 18px\);right:auto;max-height:calc\(100vh - 16px\)\}/, 'beside the rail it has the whole window height to scroll in');
  assert.match(rail, /\.nav\{[^}]*scrollbar-width:none\}/);
});

test('css: the rail also stands in for the sidebar from 1280px to 1599px while the inspector is open, as the same rules behind body.kjr-insp-open', () => {
  const rail = shellRules.slice(shellRules.indexOf('@media (min-width: 601px) and (max-width: 1279px){\n  .topbar'), shellRules.indexOf('@media (min-width: 1280px) and (max-width: 1599px)'));
  const splitStart = shellRules.indexOf('@media (min-width: 1280px) and (max-width: 1599px){');
  const splitBlock = shellRules.slice(splitStart, shellRules.indexOf('@media (max-width: 600px){\n  .topbar{position:sticky'));
  assert.match(splitBlock, /^@media \(min-width: 1280px\) and \(max-width: 1599px\)\{\s*body\.kjr-insp-open\{--kjr-side-w:calc\(64px \+ env\(safe-area-inset-left\)\)\}/);
  const railRules = rail.split('\n').filter(l => /^  \S.*\}$/.test(l)).map(l => l.trim());
  const splitRules = splitBlock.split('\n').filter(l => /^  body\.kjr-insp-open [^{]*\{.*\}$/.test(l)).map(l => l.trim());
  assert.equal(splitRules.length, railRules.length, 'every rail rule has its twin');
  const prefix = (rule) => { const i = rule.indexOf('{'); return rule.slice(0, i).split(',').map(s => 'body.kjr-insp-open ' + s).join(',') + rule.slice(i); };
  assert.deepEqual(splitRules, railRules.map(prefix), 'the two blocks are the same rules, keep them in step');
});

// ── the nav's height budget ─────────────────────────────────────────────────────────────────────
// Every layout sets --kjr-k: the sum of everything in the shell that is not one of the 14 items, plus 2px so rounding never starts a
// scroll. An item is the rest of the window over 14, never under 32px. --kjr-k is a hand-kept number, so these tests rebuild it from
// the sizes each layout declares. Change a padding, a gap or a control height without moving --kjr-k and one of them fails, instead
// of Trash and Guide sliding below the fold in a window nobody tried. The harness has no layout engine: a browser run confirmed the
// sums (no overflow from 700px tall up, sidebar and rail).
const blockOf = (text, start) => {
  const from = text.indexOf(start);
  assert.ok(from >= 0, 'block not found: ' + start);
  let depth = 0;
  for (let i = text.indexOf('{', from); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  throw new Error('unclosed block: ' + start);
};
const sidebarAt = blockOf(shellRules, '@media (min-width: 1280px){\n  .topbar{width');
const stepTall = blockOf(shellRules, '@media (min-width: 1280px) and (max-height: 980px){');
const stepMid = blockOf(shellRules, '@media (min-width: 1280px) and (max-height: 850px){');
const stepShort = blockOf(shellRules, '@media (min-width: 1280px) and (max-height: 799px){');
const railAt = blockOf(shellRules, '@media (min-width: 601px) and (max-width: 1279px){\n  .topbar{width');
const MARGIN = 2;
const FLOOR = 32;
const maxHeightOf = (block) => +/max-height: (\d+)px/.exec(block)[1];
// parts: [what, px, the block that declares it, a pattern that proves the block declares it]
function budget(where, parts, declared) {
  for (const [what, , block, re] of parts) assert.match(block, re, where + ': ' + what);
  const total = parts.reduce((a, p) => a + p[1], 0);
  if (declared !== null) assert.equal(declared, total + MARGIN, where + ': --kjr-k is the fixed parts, ' + total + 'px, plus ' + MARGIN + 'px');
  return total;
}
const kOf = (block) => +/--kjr-k:(\d+)px/.exec(block)[1];
// the parts the sidebar steps share
const SB_LOGO = ['the logo, the 40px mark', 40, shellRules, /\.logo-whale\{flex:none;width:40px;height:40px;/];
const SB_GROUP_GAPS = ['13 gaps of 2px, between a group name and its items and between items', 13 * 2, shellRules, /\.kjr-nav-group\{display:flex;flex-direction:column;gap:2px\}/];
const SB_GAP_BETWEEN = ['the gap between Search and Add', 8, shellRules, /\.kjr-side-actions\{display:flex;flex:none;flex-direction:column;gap:8px\}/];
// 2px border, 16px padding, and the three 16px lines a sync status takes when the build version wraps under the time
const SB_FOOTER = ['the footer card at its tallest', 2 + 16 + 16 + 16 + 16, shellRules, /\.topbar-actions\{[^}]*padding:8px 6px 8px 10px;border:1px solid var\(--border\);[^}]*\}[\s\S]*\.kjr-sync-line1\{[^}]*line-height:16px;[\s\S]*\.kjr-sync-line2\{[^}]*flex-wrap:wrap;[^}]*line-height:16px;/];
const SB_PAD_BOTTOM = ['bottom padding', 12, sidebarAt, /padding-bottom:calc\(12px \+ env\(safe-area-inset-bottom\)\)\}/];

test('nav budget: the markup the sums rest on, four sections in the shell, 14 items, three group names, groups of 1, 5, 5 and 6 children', () => {
  assert.equal((topbar.match(/^ {2}<(?:button|div|nav)\b/gm) || []).length, 4, 'logo, Search and Add, nav, footer: three gaps');
  assert.equal(navItems.length, 14);
  assert.equal((navHtml.match(/class="kjr-nav-label"/g) || []).length, 3);
  const children = navHtml.split('<div class="kjr-nav-group"').slice(1).map(g => (g.match(/class="nav-btn[ "]/g) || []).length + (g.match(/class="kjr-nav-label"/g) || []).length);
  assert.deepEqual(children, [1, 5, 5, 6], 'so 0 + 4 + 4 + 5 = 13 gaps inside the groups');
});

test('nav budget: an item is the rest of the window over 14, 32px at the least, on dvh with a vh fallback, and a touch screen counts its taller Settings button', () => {
  assert.match(shellRules, /:root\{--kjr-vh:100vh;--kjr-touch:0px\}\s*@supports \(height: 100dvh\)\{\s*:root\{--kjr-vh:100dvh\}\s*\}\s*@media \(pointer: coarse\)\{\s*:root\{--kjr-touch:8px\}\s*\}/);
  assert.match(shellRules, /\.topbar\{--kjr-k:0px;--kjr-item-max:40px;--kjr-item:clamp\(32px,calc\(\(var\(--kjr-vh\) - var\(--kjr-k\) - env\(safe-area-inset-top\) - env\(safe-area-inset-bottom\)\) \/ 14\),var\(--kjr-item-max\)\)\}/);
  assert.match(css, /@media\(pointer:coarse\)\{\s*\.icon-btn\{min-width:44px;min-height:44px\}/, 'the global rule that makes Settings 44px, 8px over its 36px');
  assert.match(shellRules, /\.topbar #settings-btn\{position:relative;flex:none;width:36px;height:36px;/);
  assert.match(railAt, /--kjr-k:calc\(\d+px \+ var\(--kjr-touch\)\);--kjr-item-max:44px\}/, 'the rail counts the touch Settings button and may reach 44px');
  assert.doesNotMatch(shellRules.replace(/\.topbar\{--kjr-k:0px[^}]*\}/, ''), /--kjr-item:/, 'one formula, every layout only sets --kjr-k and --kjr-item-max');
  for (const block of [stepTall, stepMid, stepShort]) assert.match(block, /--kjr-k:\d+px/);
  // the items follow the formula wherever the sidebar steps in (the tallest sidebar keeps its plain 40px)
  assert.match(stepTall, /\.nav-btn\{height:var\(--kjr-item\)\}/);
  assert.doesNotMatch(stepMid + stepShort, /\.nav-btn\{/);
});

test('nav budget, rail: 246px of fixed parts around the 14 items, so they all fit from 700px tall, 32px each at the least and 44px from 864px', () => {
  const total = budget('rail', [
    ['top padding', 8, railAt, /\.topbar\{[^}]*padding:8px 0;padding-top:calc\(8px \+ env\(safe-area-inset-top\)\);padding-left:env\(safe-area-inset-left\);/],
    ['bottom padding', 8, railAt, /padding-bottom:calc\(8px \+ env\(safe-area-inset-bottom\)\);--kjr-k:/],
    ['three gaps between the four sections', 3 * 8, railAt, /\.topbar\{[^}]*align-items:center;gap:8px;/],
    ['the logo', 40, railAt, /\.logo\{justify-content:center;width:40px;height:40px;padding:0\}/],
    ['Search and Add', 36 + 36, railAt, /\.kjr-side-search,\.kjr-side-add\{justify-content:center;width:36px;height:36px;padding:0\}/],
    ['the gap between them', 6, railAt, /\.kjr-side-actions\{gap:6px\}/],
    ['three separators, 1px with 4px above and 3px below', 3 * (1 + 4 + 3), railAt, /\.kjr-nav-label\{width:24px;height:1px;margin:4px 0 3px;padding:0;/],
    ['no gaps in the nav or in its groups', 0, railAt, /\.nav\{align-items:center;align-self:stretch;gap:0;[^}]*\}[\s\S]*\.kjr-nav-group\{align-items:center;align-self:stretch;gap:0\}/],
    ['the sync button', 28, railAt, /#sync-indicator\{[^}]*width:36px;height:28px;/],
    ['no gap in the footer', 0, railAt, /\.topbar-actions\{flex-direction:column;gap:0;/],
    ['Settings', 36, shellRules, /\.topbar #settings-btn\{position:relative;flex:none;width:36px;height:36px;/],
  ], +/--kjr-k:calc\((\d+)px \+ var\(--kjr-touch\)\)/.exec(railAt)[1]);
  assert.equal(total, 246);
  assert.ok(total + MARGIN + 14 * FLOOR <= 700, 'all 14 at 32px fit in a 700px window');
  assert.equal(total + MARGIN + 14 * 44, 864, 'and 44px items from 864px tall');
});

test('nav budget, sidebar: four steps by window height, each fits down to the next step, so the nav is never longer than its box from 700px tall', () => {
  const parts = {
    airy: [
      ['top padding', 20, sidebarAt, /\.topbar\{[^}]*padding:20px 12px 12px;padding-top:calc\(20px \+ env\(safe-area-inset-top\)\);/],
      SB_PAD_BOTTOM,
      ['three gaps between the four sections', 3 * 16, sidebarAt, /\.topbar\{width:var\(--kjr-side-w\);gap:16px;/],
      SB_LOGO,
      ['Search and Add', 40 + 40, shellRules, /\.kjr-side-search\{[^}]*height:40px;[\s\S]*\.kjr-side-add\{[^}]*height:40px;/],
      SB_GAP_BETWEEN,
      ['three group names, 16px lines with 4px below', 3 * (16 + 4), shellRules, /\.kjr-nav-label\{padding:0 10px 4px;font-size:12px;font-weight:500;line-height:16px;/],
      SB_GROUP_GAPS,
      ['three gaps between the groups', 3 * 18, shellRules, /\.nav\{display:flex;flex-direction:column;gap:18px;/],
      SB_FOOTER,
    ],
    tall: [
      ['top padding', 20, sidebarAt, /padding-top:calc\(20px \+ env\(safe-area-inset-top\)\);/],
      SB_PAD_BOTTOM,
      ['three gaps between the four sections', 3 * 14, stepTall, /\.topbar\{gap:14px;--kjr-k:\d+px\}/],
      SB_LOGO,
      ['Search and Add', 40 + 40, shellRules, /\.kjr-side-search\{[^}]*height:40px;[\s\S]*\.kjr-side-add\{[^}]*height:40px;/],
      SB_GAP_BETWEEN,
      ['three group names, 16px lines with 4px below', 3 * (16 + 4), shellRules, /\.kjr-nav-label\{padding:0 10px 4px;/],
      SB_GROUP_GAPS,
      ['three gaps between the groups', 3 * 14, stepTall, /\.nav\{gap:14px\}/],
      SB_FOOTER,
    ],
    mid: [
      ['top padding', 12, stepMid, /\.topbar\{gap:10px;padding-top:calc\(12px \+ env\(safe-area-inset-top\)\);--kjr-k:\d+px\}/],
      SB_PAD_BOTTOM,
      ['three gaps between the four sections', 3 * 10, stepMid, /\.topbar\{gap:10px;/],
      SB_LOGO,
      ['Search and Add', 36 + 36, stepMid, /\.kjr-side-search,\.kjr-side-add\{height:36px\}/],
      SB_GAP_BETWEEN,
      ['three group names, 16px lines with 2px below', 3 * (16 + 2), stepMid, /\.kjr-nav-label\{padding-bottom:2px\}/],
      SB_GROUP_GAPS,
      ['three gaps between the groups', 3 * 10, stepMid, /\.nav\{gap:10px\}/],
      SB_FOOTER,
    ],
    short: [
      ['top padding', 10, stepShort, /\.topbar\{gap:8px;padding-top:calc\(10px \+ env\(safe-area-inset-top\)\);/],
      ['bottom padding', 10, stepShort, /padding-bottom:calc\(10px \+ env\(safe-area-inset-bottom\)\);--kjr-k:\d+px\}/],
      ['three gaps between the four sections', 3 * 8, stepShort, /\.topbar\{gap:8px;/],
      ['the logo, the 36px name block (two 18px lines) is taller than the 34px mark', Math.max(34, 2 * 18), stepShort, /\.logo-whale\{width:34px;height:34px\}/],
      ['Search and Add', 32 + 32, stepShort, /\.kjr-side-search,\.kjr-side-add\{height:32px\}/],
      ['the gap between them', 6, stepShort, /\.kjr-side-actions\{gap:6px\}/],
      ['three separators, 1px with 4px above and 3px below', 3 * (1 + 4 + 3), stepShort, /\.kjr-nav-label\{height:1px;margin:4px 8px 3px;padding:0;overflow:hidden;background:var\(--border2\);font-size:0;line-height:0;color:transparent\}/],
      ['no gaps in the nav or in its groups', 0, stepShort, /\.nav,\.kjr-nav-group\{gap:0\}/],
      SB_FOOTER,
    ],
  };
  assert.match(shellRules, /\.logo-name\{display:flex;flex-direction:column;min-width:0;line-height:18px;/);
  const airy = budget('sidebar above 980px', parts.airy, null);
  const tall = budget('sidebar to 980px', parts.tall, kOf(stepTall));
  const mid = budget('sidebar to 850px', parts.mid, kOf(stepMid));
  const short = budget('sidebar to 799px', parts.short, kOf(stepShort));
  assert.deepEqual([airy, tall, mid, short], [414, 396, 350, 240]);
  // each step must fit from the top of its own range down to where the next step takes over, with the items at their floor
  assert.ok(airy + 14 * 40 <= maxHeightOf(stepTall) + 1, 'the airy sidebar, 40px items, fits from 981px tall');
  assert.ok(kOf(stepTall) + 14 * FLOOR <= maxHeightOf(stepMid) + 1, 'the first step fits down to 851px');
  assert.ok(kOf(stepMid) + 14 * FLOOR <= maxHeightOf(stepShort) + 1, 'the second keeps the group names down to 800px');
  assert.ok(kOf(stepShort) + 14 * FLOOR <= 700, 'the third fits at 700px, with separators in place of the group names');
  assert.deepEqual([maxHeightOf(stepTall), maxHeightOf(stepMid), maxHeightOf(stepShort)], [980, 850, 799]);
});

test('css: a nav that has to scroll shows a shadow on the edge with more to see, from tokens, as its own background', () => {
  const rule = (shellRules.match(/\n\.nav\{--kjr-shade:[^\n]*\}/) || [''])[0];
  assert.ok(rule, 'one rule');
  assert.match(rule, /--kjr-shade:color-mix\(in srgb,var\(--text\) 18%,transparent\);/);
  assert.match(rule, /background-image:linear-gradient\(var\(--sidebar\) 30%,transparent\),linear-gradient\(transparent,var\(--sidebar\) 70%\),radial-gradient\(farthest-side at 50% 0,var\(--kjr-shade\),transparent\),radial-gradient\(farthest-side at 50% 100%,var\(--kjr-shade\),transparent\);/, 'two covers in the sidebar colour, two shadows');
  assert.match(rule, /background-position:0 0,0 100%,0 0,0 100%;background-size:100% 28px,100% 28px,100% 12px,100% 12px;/, 'the covers are taller than the shadows they hide');
  assert.match(rule, /background-attachment:local,local,scroll,scroll\}$/, 'the covers move with the items, the shadows stay with the box');
  assert.doesNotMatch(rule, /filter|rgba?\(|#[0-9a-fA-F]{3,8}\b/);
  assert.match(shellRules, /\.nav\{display:flex;flex-direction:column;gap:18px;flex:1 1 auto;min-height:0;overflow-x:hidden;overflow-y:auto;/, 'it is the nav that scrolls, the footer stays');
});

test('css: the Sentry drawer carries its shadow only while it is open, so a closed one leaves no grey strip at the right edge', () => {
  const closed = (css.match(/\n#sentry-drawer\{[^\n]*\}/) || [''])[0];
  const open = (css.match(/\n#sentry-drawer\.open\{[^\n]*\}/) || [''])[0];
  assert.ok(closed && open);
  assert.equal((css.match(/\n#sentry-drawer\{/g) || []).length, 1, 'no second base rule putting a shadow back');
  assert.match(closed, /transform:translateX\(100%\)/);
  assert.doesNotMatch(closed, /box-shadow:/, 'no shadow while it waits off screen');
  assert.match(closed, /transition:transform 0\.28s cubic-bezier\(0\.4,0,0\.2,1\),box-shadow 0\.28s cubic-bezier\(0\.4,0,0\.2,1\)\}$/, 'the shadow eases in and out with the slide');
  assert.match(open, /^\n#sentry-drawer\.open\{transform:translateX\(0\);box-shadow:-8px 0 32px rgba\(0,0,0,0\.4\)\}$/);
  assert.match(features, /document\.getElementById\('sentry-drawer'\)\.classList\.add\('open'\)/, 'the class the rule waits for is the one the panel adds');
  assert.match(css, /#sentry-drawer\{transition:none!important\}/, 'reduced motion still switches it off');
});

test('css: the phone header is a sticky 56px row with round 44px buttons and the status dot on Settings', () => {
  const ph = shellRules.slice(shellRules.indexOf('@media (max-width: 600px){\n  .topbar{position:sticky'), shellRules.indexOf('.btb-item{flex:1 1 0'));
  assert.match(ph, /\.topbar\{position:sticky;top:0;bottom:auto;left:auto;flex-direction:row;align-items:center;gap:8px;height:calc\(56px \+ env\(safe-area-inset-top\)\);/);
  assert.match(ph, /background:var\(--bg\);border-right:0;border-bottom:1px solid var\(--border\)\}/, 'solid, sticky and without a backdrop');
  assert.match(ph, /\.logo-whale\{width:34px;height:34px\}/);
  assert.match(ph, /\.logo-title\{font-size:17px\}/);
  assert.match(ph, /\.logo-sub\{display:none\}/, '"Collectibles" is hidden');
  assert.match(ph, /\.nav,\.kjr-side-add,#sync-indicator\{display:none\}/, 'nav, Add and the footer text are hidden');
  assert.match(ph, /\.kjr-side-search\{[^}]*width:44px;height:44px;[^}]*border-radius:50%/);
  assert.match(ph, /\.topbar #settings-btn\{width:44px;height:44px;[^}]*border-radius:50%/);
  assert.match(ph, /\.kjr-sync-dot\.kjr-sync-mirror\{display:block;position:absolute;/);
  assert.match(ph, /\.kjr-dd-sync\{display:flex\}/, 'the Sync status menu item is phone only');
  assert.match(shellRules, /\.kjr-sync-mirror\{display:none\}\n\.kjr-dd-sync\{display:none\}/);
});

test('css: the tab bar is 60px plus the safe area, 11px labels, 22px icons, 44px targets, and a 54px raised accent Add with a ground ring', () => {
  assert.match(css, /\.bottom-tab-bar\{display:none\}/);
  assert.match(shellRules, /\.btb-item\{flex:1 1 0;min-width:0;min-height:44px;[^}]*font-size:11px;font-weight:500;/);
  assert.match(shellRules, /\.btb-item svg\{flex:none;width:22px;height:22px\}/);
  assert.match(shellRules, /\.btb-item\.active\{color:var\(--accent\);font-weight:600\}/, 'accent text and a heavier weight, and aria-current is set by showPage');
  assert.match(shellRules, /\.btb-add\{[^}]*width:54px;height:54px;margin:calc\(var\(--kjr-tab-lift\) \* -1\) 10px 0;[^}]*border-radius:50%;background:var\(--accent\);color:var\(--accent-fg\);box-shadow:0 0 0 5px var\(--bg\),0 8px 24px var\(--accent-glow\)/);
  assert.match(shellRules, /@media \(max-width: 600px\)\{\s*\.bottom-tab-bar\{display:block;position:fixed;left:0;right:0;bottom:0;z-index:150;padding:0 env\(safe-area-inset-right\) env\(safe-area-inset-bottom\) env\(safe-area-inset-left\);background:var\(--sidebar\);border-top:1px solid var\(--border\)\}/);
  assert.match(shellRules, /\.bottom-tab-bar \.btb-inner\{display:flex;align-items:stretch;height:var\(--kjr-tab-h\)\}/);
  assert.match(shellRules, /body\{padding-bottom:calc\(var\(--kjr-tab-h\) \+ var\(--kjr-tab-lift\) \+ env\(safe-area-inset-bottom\) \+ 16px\)\}/);
});

test('css: the toast and the update pill clear the tab bar and its raised Add on a phone, and the rail on a tablet', () => {
  assert.match(css, /@media\(max-width:768px\)\{#toast\{bottom:calc\(12px \+ env\(safe-area-inset-bottom\)\);right:12px;left:calc\(var\(--kjr-side-w\) \+ 12px\);/);
  assert.match(css, /@media \(max-width: 600px\)\{#toast\{bottom:calc\(var\(--kjr-tab-h\) \+ var\(--kjr-tab-lift\) \+ env\(safe-area-inset-bottom\) \+ 12px\)\}\}/);
  assert.match(css, /@media\(max-width:768px\)\{#kjr-update-pill\{left:calc\(var\(--kjr-side-w\) \+ 12px\);right:12px;bottom:calc\(12px \+ env\(safe-area-inset-bottom\)\);/);
  assert.match(css, /@media \(max-width: 600px\)\{#kjr-update-pill\{bottom:calc\(var\(--kjr-tab-h\) \+ var\(--kjr-tab-lift\) \+ env\(safe-area-inset-bottom\) \+ 8px\)\}\}/);
  assert.match(css, /#kjr-update-pill\{[^}]*z-index:149/, 'the pin sw-auth.test.js reads');
});

test('css: with the top bar gone the sticky offsets are zero on desktop and the phone header on a phone', () => {
  assert.match(css, /\.tbl-wrap thead\{position:sticky;top:env\(safe-area-inset-top\);z-index:5;/);
  assert.match(css, /@media\(max-width:1000px\)\{\.tbl-wrap thead\{top:0\}\}/);
  assert.match(css, /#kjr-inspector\{position:fixed;top:env\(safe-area-inset-top\);right:0;bottom:0;z-index:120;/);
  assert.match(css, /\.dealer-production-list\{position:sticky;top:calc\(var\(--kjr-top-off\) \+ 12px\);max-height:calc\(100vh - 24px - var\(--kjr-top-off\)\);/);
  assert.match(css, /\.guide-toc\{position:sticky;top:calc\(var\(--kjr-top-off\) \+ 24px\);max-height:calc\(100vh - var\(--kjr-top-off\) - 48px\);/);
  assert.equal((css.match(/scroll-margin-top:calc\(var\(--kjr-top-off\) \+ 24px\)/g) || []).length, 2, 'the guide headings');
  // the only places that still know the phone header is 56px: the variable and the header itself
  assert.equal((css.match(/calc\(56px \+ env\(safe-area-inset-top\)\)/g) || []).length, 2, '--kjr-top-off and the header height');
  assert.doesNotMatch(css, /top:calc\(56px/);
  assert.match(css, /body\.kjr-insp-open \.main:has\(\.page\.active\)\{padding-right:max\(24px,calc\(456px - max\(0px,\(100vw - var\(--kjr-side-w\) - 1400px\) \/ 2\)\)\)\}/, 'the split view measures from the width the sidebar leaves');
});

test('css: the Dealer preview hides the new search, Add, nav, footer and tab bar the way it hid the old ones', () => {
  const rules = css.slice(css.indexOf('html.dealer-preview-only .topbar .nav,'), css.indexOf('{display:none!important}', css.indexOf('html.dealer-preview-only .topbar .nav,')));
  for (const sel of ['.topbar .nav', '.topbar .kjr-side-actions', '.topbar-actions', '.bottom-tab-bar']) assert.ok(rules.includes('html.dealer-preview-only ' + sel + ','), sel);
});

test('css: the Holdings rows are 60px buttons with a 32px 63/88 thumbnail, 12px sub line, tabular value and gain, and the table hides only when they are drawn', () => {
  assert.match(shellRules, /\.kjr-hold-wrap\{display:none\}/);
  assert.match(shellRules, /\.kjr-hold-row\{[^}]*align-items:center;gap:12px;[^}]*min-height:60px;[^}]*border-bottom:1px solid var\(--border\);[^}]*content-visibility:auto;contain-intrinsic-size:auto 60px;/);
  assert.match(shellRules, /\.kjr-hold-row \.kjr-thumb\{width:32px;height:auto;aspect-ratio:63\/88;border-radius:4px\}/);
  assert.match(shellRules, /\.kjr-hold-name\{[^}]*font-weight:500;[^}]*text-overflow:ellipsis\}/, 'long names are cut with an ellipsis');
  assert.match(shellRules, /\.kjr-hold-sub\{[^}]*font-size:12px;[^}]*color:var\(--text3\);/);
  assert.match(shellRules, /\.kjr-hold-lang\{font-family:var\(--font-mono\)\}/);
  assert.match(shellRules, /\.kjr-hold-price\{font-weight:600;[^}]*font-variant-numeric:tabular-nums\}/);
  assert.match(shellRules, /\.kjr-hold-pct\{font-size:12px;font-weight:600;/);
  assert.match(shellRules, /\.kjr-hold-row\.is-inspected\{background:var\(--accent-soft\);scroll-margin:calc\(var\(--kjr-top-off\) \+ 16px\) 0 calc\(var\(--kjr-tab-h\) \+ var\(--kjr-tab-lift\) \+ env\(safe-area-inset-bottom\) \+ 16px\)\}/, 'a step that scrolls the row into view keeps it clear of the header and the tab bar');
  assert.match(shellRules, /@media \(max-width: 600px\)\{\s*body:not\(\.force-tables\) \.page\.kjr-hold-on>\.card\{display:none\}\s*body:not\(\.force-tables\) \.page\.kjr-hold-on \.kjr-hold-wrap\{display:block\}/);
});

test('css: motion is 160ms ease-out and is switched off for reduced motion', () => {
  for (const sel of ['.nav-btn{', '.kjr-side-search{', '.kjr-side-add{', '.btb-item{', '.kjr-hold-row{']) {
    const rule = shellRules.slice(shellRules.indexOf(sel), shellRules.indexOf('}', shellRules.indexOf(sel)));
    assert.match(rule, /transition:[^;}]*0\.16s ease-out/, sel);
  }
  assert.match(shellRules, /@media \(prefers-reduced-motion: reduce\)\{\s*\.nav-btn,\.kjr-side-search,\.kjr-side-add,\.topbar #settings-btn,#sync-indicator,\.btb-item,\.btb-add,\.kjr-hold-row,\.kjr-tip\{transition:none\}\s*\.btb-add:active\{transform:none\}/);
});

// ── the version ─────────────────────────────────────────────────────────────────────────────────
test('v3.74: the badge, the Sentry release, the asset tags and the service worker move together', () => {
  const sw = fs.readFileSync(ROOT + '/sw.js', 'utf8');
  assert.match(html, /release:\s*'kujira-collectibles@3\.74'/);
  assert.match(html, /<link rel="stylesheet" href="styles\.css\?v=3\.74">/);
  for (const f of ['app.js', 'features.js', 'dealer-money.js', 'dealer-desk.js', 'dealer-ui.js', 'dealer-store.js', 'dealer-production-ui.js']) {
    assert.ok(html.includes('<script src="' + f + '?v=3.74"></script>'), f);
    assert.ok(sw.includes("'./" + f + "?v=3.74'"), 'sw ' + f);
  }
  assert.match(sw, /const CACHE = 'kujira-v77'/);
  assert.match(sw, /'\.\/Assets\/lib\/three\.module\.js\?v=3\.31'/, 'the vendored library keeps its own version');
});
