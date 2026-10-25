'use strict';
// The phone's Collection switcher, and the bottom bar's Collection tab that goes with it. Since v3.73 the tab bar has one Collection tab that
// opens Singles, so Slabs, ETBs and Boxes & packs could only be found under More > Browse, and while you were on one of them the bar lit More,
// not Collection. A row at the top of the four Collection pages (600px and below) now walks between them, and the Collection tab lights for
// all four with More left unlit. This suite pins the markup (one nav, four buttons, the sidebar's words), the script (the current segment, the
// counts, the tab bar's holder, the row's scroll), and the stylesheet (phone only, 44px, the current segment filled and heavier, the ring,
// the contrast of every pair in both themes). The harness has no layout engine, so the widths at 375px and 320px, the overflow and the
// real scroll are checked in a browser, not here.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { loadApp, makeSeed, plain, ROOT } = require('./harness.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
const appSrc = fs.readFileSync(ROOT + '/app.js', 'utf8');
const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');

const single = (o) => Object.assign({}, makeSeed().singles[0], o);
const slab = (o) => Object.assign({
  id: 'slab_1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '12345678', rank: '',
  language: 'EN', costPrice: 520, marketPrice: 610, listPrice: '', dateListed: '3 Jul 2026', status: 'Available',
  notes: '', priceAlert: '', _updatedAt: new Date().toISOString(),
}, o);

// ── the markup ──────────────────────────────────────────────────────────────────────────────
const navAt = html.indexOf('<nav class="kjr-coll"');
const nav = html.slice(navAt, html.indexOf('</nav>', navAt) + '</nav>'.length);
// every segment: the inline handler a tap runs, the page it opens, its visible name, and the id its count is written into
const segments = [...nav.matchAll(/<button type="button" class="kjr-coll-btn" onclick="(showPage\('([A-Za-z]+)'\))">\s*<span class="kjr-coll-name">([^<]*)<\/span>\s*<span class="kjr-coll-count" id="([^"]+)"><\/span>\s*<\/button>/g)]
  .map(m => ({ onclick: m[1], page: m[2], name: m[3], countId: m[4] }));
const PAGES = ['inventory', 'slabs', 'etbs', 'boosterBoxes'];
const sidebar = html.slice(html.indexOf('<nav class="nav"'), html.indexOf('</nav>'));
const sidebarLabel = (page) => (sidebar.match(new RegExp('<button class="nav-btn[^"]*" aria-label="([^"]*)" onclick="showPage\\(\'' + page + '\'\\)">')) || [])[1];
const tabBar = html.slice(html.indexOf('<div class="bottom-tab-bar"'), html.indexOf('<!-- MORE SHEET'));
const tabs = [...tabBar.matchAll(/<button class="btb-item[^"]*" id="(btb-[a-z]+)" onclick="([^"]*)">/g)].map(m => ({ id: m[1], onclick: m[2] }));
const pageIds = [...html.matchAll(/<div id="page-([A-Za-z]+)" class="page/g)].map(m => m[1]);

test('markup: one labelled nav of four real buttons, ordered and named like the sidebar items, hidden on first paint and holding no state', () => {
  assert.equal((html.match(/<nav class="kjr-coll"/g) || []).length, 1, 'one element for all four pages, not a copy in each');
  assert.match(nav, /^<nav class="kjr-coll" id="kjr-coll" aria-label="Collection" hidden>/);
  assert.deepEqual(segments.map(s => [s.name, s.page]), [['Singles', 'inventory'], ['Slabs', 'slabs'], ['ETBs', 'etbs'], ['Boxes &amp; packs', 'boosterBoxes']]);
  assert.equal((nav.match(/<button\b/g) || []).length, 4, 'four controls and nothing else');
  assert.equal((nav.match(/<button type="button" /g) || []).length, 4, 'real buttons that never submit a form');
  for (const s of segments) {
    assert.equal(s.name, sidebarLabel(s.page), s.page + ': the sidebar says the same word');
    assert.equal((html.match(new RegExp('id="' + s.countId + '"', 'g')) || []).length, 1, s.countId + ' is unique');
    assert.equal(s.countId, 'kjr-coll-count-' + s.page);
    assert.ok(pageIds.includes(s.page), s.page + ' is a page that exists');
  }
  assert.doesNotMatch(nav.slice(nav.indexOf('<button')), /aria-label/, 'the visible words are the names');
  assert.doesNotMatch(nav, /aria-current|\sactive\b/, 'nothing is current until showPage says so');
  assert.doesNotMatch(nav, /\son(?!click=)\w+=/, 'the tap is the only handler');
});

test('markup: it sits at body level between the shell and .main, so it is neither in the sidebar nor in a page', () => {
  const shellAt = html.indexOf('<div class="topbar">');
  assert.ok(shellAt < navAt && navAt < html.indexOf('<div class="main">'));
  const before = html.slice(shellAt, navAt);
  assert.equal((before.match(/<div\b/g) || []).length, (before.match(/<\/div>/g) || []).length, 'the shell has closed by then');
  assert.equal((html.slice(0, navAt).match(/<nav class="nav"/g) || []).length, 1, 'and the sidebar nav is the one before it');
  assert.equal(sidebar.includes('kjr-coll'), false);
  assert.ok(html.lastIndexOf('<!-- COLLECTION SWITCHER', navAt) > shellAt, 'the comment that ends the shell for tests/navigation.test.js comes first');
});

// ── the phone, as showPage sees it ───────────────────────────────────────────────────────────
// Stub elements for the four segments, the bottom bar (with its real ids and handlers, read from the markup), the page containers and one
// More sheet Browse item. showPage reads them with querySelectorAll, so the fixture answers for the selectors it uses and nothing else.
// The bar is found by its onclick handlers and never by an id made from the page name (the older wrapper that did is gone, v3.88), so the
// harness's stub for any id needs no special case here.
function phone(document) {
  const stub = (id, onclick) => { const el = document.getElementById(id); if (onclick) el.setAttribute('onclick', onclick); return el; };
  const row = stub('kjr-coll');
  row.hidden = true;
  const segs = segments.map(s => stub('seg-' + s.page, s.onclick));
  const bar = tabs.map(t => stub(t.id, t.onclick));
  const pages = pageIds.map(p => stub('page-' + p));
  const sheet = [stub('sheet-slabs', "moreGo('slabs')")];
  sheet[0].setAttribute('data-page', 'slabs');
  document.querySelectorAll = (selector) => {
    if (selector === '.page') return pages;
    if (selector === '.btb-item') return bar;
    if (selector === '#kjr-coll .kjr-coll-btn') return segs;
    if (selector === '#more-sheet .sheet-item[data-page]') return sheet;
    return [];
  };
  const byPage = Object.fromEntries(PAGES.map((p, i) => [p, segs[i]]));
  const tab = Object.fromEntries(bar.map(b => [b.id.slice(4), b]));
  const current = (list) => list.filter(b => b.getAttribute('aria-current') === 'page');
  const lit = (list) => list.filter(b => b.classList.contains('active'));
  return { row, segs, byPage, bar, tab, pages, sheet, current, lit };
}

test('switcher: on each of the four pages its own segment is current (aria-current and the active class), the other three are not, and the row shows', async () => {
  const { ctx, document } = await loadApp();
  const f = phone(document);
  for (const s of segments) {
    ctx.showPage(s.page);
    assert.deepEqual(f.current(f.segs), [f.byPage[s.page]], s.page + ': one current segment, its own');
    assert.deepEqual(f.lit(f.segs), [f.byPage[s.page]], s.page + ': and the class the other nav controls use');
    assert.equal(f.row.hidden, false, s.page + ': the row shows');
  }
  // Booster Packs has no page of its own, the page that holds it (Boxes & packs) is the segment
  ctx.showPage('boosterPacks');
  assert.deepEqual(f.current(f.segs), [f.byPage.boosterBoxes]);
  assert.equal(f.row.hidden, false);
});

test('switcher: on every other page nothing is current and the row is hidden, and it comes back when you return', async () => {
  const { ctx, document } = await loadApp();
  const f = phone(document);
  ctx.showPage('slabs');
  assert.equal(f.row.hidden, false);
  for (const page of ['dashboard', 'sales', 'ebay', 'guide']) {
    ctx.showPage(page);
    assert.deepEqual(f.current(f.segs), [], page + ': no segment is current');
    assert.deepEqual(f.lit(f.segs), []);
    assert.equal(f.row.hidden, true, page + ': the row is hidden');
    ctx.showPage('etbs');
    assert.deepEqual(f.current(f.segs), [f.byPage.etbs], 'back on ETBs after ' + page);
    assert.equal(f.row.hidden, false);
  }
  ctx.syncCollSwitch([]);
  assert.equal(f.row.hidden, true, 'a row with no segment to mark is hidden, not left empty on show');
});

test('switcher: a tap runs the segment\'s inline handler, which is showPage for its page, and the page changes', async () => {
  const { ctx, sandbox, document } = await loadApp();
  const f = phone(document);
  assert.deepEqual(segments.map(s => s.onclick), PAGES.map(p => "showPage('" + p + "')"), 'every handler is showPage, no new routing');
  for (const s of segments) {
    vm.runInContext(s.onclick, sandbox, { filename: '<tap ' + s.page + '>' });
    assert.equal(ctx._kjrCurrentPage, s.page, s.page + ': the app is on that page');
    assert.deepEqual(f.pages.filter(p => p.classList.contains('active')).map(p => p.id), ['page-' + s.page], s.page + ': it is the one visible page');
    assert.deepEqual(f.current(f.segs), [f.byPage[s.page]], s.page + ': and its segment is the current one');
  }
});

// ── the bottom bar ───────────────────────────────────────────────────────────────────────────
test('tab bar: Collection is current on Singles, Slabs, ETBs, Boxes & packs and Booster Packs, and More is not', async () => {
  const { ctx, document } = await loadApp();
  const f = phone(document);
  for (const page of ['inventory', 'slabs', 'etbs', 'boosterBoxes', 'boosterPacks']) {
    ctx.showPage(page);
    assert.deepEqual(f.current(f.bar), [f.tab.inventory], page + ': aria-current on Collection alone');
    assert.deepEqual(f.lit(f.bar), [f.tab.inventory], page + ': and the active class on Collection alone');
    assert.equal(f.tab.more.getAttribute('aria-current'), null, page + ': More has no aria-current');
    assert.equal(f.tab.more.classList.contains('active'), false, page + ': and does not light');
  }
});

test('tab bar: the other tabs behave as before, More still lights for the pages only it reaches, and the Browse items stay in the sheet', async () => {
  const { ctx, document } = await loadApp();
  const f = phone(document);
  // Reports and Trash draw charts and fetch, so this test leaves them out
  const own = { dashboard: 'dashboard', sales: 'sales', guide: 'more', ebay: 'more', import: 'more' };
  for (const [page, tab] of Object.entries(own)) {
    ctx.showPage(page);
    assert.deepEqual(f.current(f.bar), [f.tab[tab]], page + ': its own tab');
    assert.deepEqual(f.lit(f.bar), [f.tab[tab]], page + ': and the class');
  }
  // switching between a held page and a More page hands the light over each way, and nothing is left on
  ctx.showPage('slabs');
  assert.deepEqual(f.lit(f.bar), [f.tab.inventory]);
  ctx.showPage('guide');
  assert.deepEqual(f.lit(f.bar), [f.tab.more]);
  assert.equal(f.tab.inventory.getAttribute('aria-current'), null);
  ctx.showPage('boosterBoxes');
  assert.deepEqual(f.lit(f.bar), [f.tab.inventory]);
  assert.equal(f.tab.more.getAttribute('aria-current'), null);
  // the More sheet keeps its Browse items, and its own item for the page is still marked while the More tab is not
  for (const p of ['slabs', 'etbs', 'boosterBoxes']) assert.match(html, new RegExp('<button class="sheet-item" data-page="' + p + '" onclick="moreGo\\(\'' + p + '\'\\)">'), p + ' is still under Browse');
  ctx.showPage('slabs');
  assert.equal(f.sheet[0].getAttribute('aria-current'), 'page', 'the sheet item for Slabs is current');
  assert.equal(f.tab.more.classList.contains('active'), false, 'while the More tab is not');
});

test('tab bar: the holder table and the rule that uses it', async () => {
  const { ctx } = await loadApp();
  assert.deepEqual(plain(ctx.TAB_HELD_BY), { slabs: 'inventory', etbs: 'inventory', boosterBoxes: 'inventory', boosterPacks: 'inventory' });
  const tabPages = tabs.map(t => (t.onclick.match(/showPage\('([A-Za-z]+)'\)/) || [])[1]).filter(Boolean);
  assert.ok(tabPages.includes('inventory'), 'the holder has a tab of its own to light');
  for (const page of Object.keys(ctx.TAB_HELD_BY)) {
    assert.ok(ctx.MORE_PAGES.has(page), page + ' is still one More reaches (the sheet lists it, the palette falls back to More for it)');
    assert.equal(ctx.moreLights(page), false, page + ': but More does not light');
  }
  for (const page of ['guide', 'ebay', 'listing', 'reports', 'import', 'changelog', 'trash', 'dealerProduction', 'dealer']) assert.equal(ctx.moreLights(page), true, page);
  for (const page of ['dashboard', 'inventory', 'sales']) assert.equal(ctx.moreLights(page), false, page + ' has a tab of its own');
});

test('tab bar: syncMoreActive follows the same rule, and a page nothing holds lights no tab at all rather than falling back to More', async () => {
  const { ctx, document } = await loadApp();
  const f = phone(document);
  for (const [page, on] of [['slabs', false], ['etbs', false], ['boosterBoxes', false], ['boosterPacks', false], ['guide', true], ['reports', true], ['dashboard', false], ['inventory', false]]) {
    ctx.syncMoreActive(page);
    assert.equal(f.tab.more.classList.contains('active'), on, page + ': More ' + (on ? 'lights' : 'stays unlit'));
  }
  // showPage reaches the same answers by itself, there is no repaint of the bar after it (v3.88)
  for (const [page, on] of [['slabs', false], ['etbs', false], ['boosterBoxes', false], ['boosterPacks', false], ['guide', true], ['dashboard', false], ['inventory', false]]) {
    ctx.showPage(page);
    assert.equal(f.tab.more.classList.contains('active'), on, page + ': showPage, More ' + (on ? 'lights' : 'stays unlit'));
    assert.equal(f.tab.more.getAttribute('aria-current') === 'page', on, page + ': and aria-current agrees');
  }
  // a shell with no Collection tab (cut down, or an older cached one): the holder is not there to light, and More is still not the answer
  ctx.showPage('guide');
  const real = document.querySelectorAll;
  document.querySelectorAll = (selector) => (selector === '.btb-item' ? f.bar.filter(b => b !== f.tab.inventory) : real(selector));
  ctx.showPage('slabs');
  assert.deepEqual(f.lit(f.bar), [], 'nothing lit');
  assert.equal(f.tab.more.getAttribute('aria-current'), null);
  document.querySelectorAll = real;
});

// v3.88: app.js used to end with a second showPage wrapper that cleared .btb-item and lit "btb-" plus the page again, after the core had
// marked the bar (showPage with TAB_HELD_BY and moreLights, then syncMoreActive). It did the same work a second way, by element id where the
// core reads each tab's handler, so it is gone. The bar's state is the core's alone.
test('tab bar: showPage alone lights the bar, one tab at most, and the class and aria-current always agree', async () => {
  const { ctx, document } = await loadApp();
  const f = phone(document);
  // Reports and Trash draw charts and fetch, so this test leaves them out
  const expect = {
    dashboard: 'dashboard', inventory: 'inventory', sales: 'sales',
    slabs: 'inventory', etbs: 'inventory', boosterBoxes: 'inventory', boosterPacks: 'inventory',
    guide: 'more', ebay: 'more', import: 'more', listing: 'more', changelog: 'more',
    // a name that is no page lights nothing, even when a tab's id would fit it: the wrapper lit More for 'more'
    more: null, nothing: null, add: null, '': null,
  };
  for (const [page, tab] of Object.entries(expect)) {
    ctx.showPage(page);
    const want = tab ? [f.tab[tab]] : [];
    assert.deepEqual(f.lit(f.bar), want, JSON.stringify(page) + ': the class');
    assert.deepEqual(f.current(f.bar), want, JSON.stringify(page) + ': and aria-current, the same tab');
  }
  // going round twice, in the other order, leaves nothing behind
  for (const page of Object.keys(expect).reverse()) {
    ctx.showPage(page);
    assert.ok(f.lit(f.bar).length <= 1, JSON.stringify(page) + ': at most one tab is lit');
    assert.deepEqual(f.lit(f.bar), f.current(f.bar));
  }
  // the source: the bar is read once, by showPage, and nothing wraps showPage to touch it again
  const reads = appSrc.match(/querySelectorAll\('\.btb-item'\)/g) || [];
  assert.equal(reads.length, 1, 'one place reads the bar');
  assert.doesNotMatch(appSrc, /getElementById\('btb-' \+/, 'no tab is looked up by an id made from a page name');
  assert.doesNotMatch(appSrc.slice(appSrc.indexOf('function _refreshSavedChart(id)')), /\.btb-item|btb-more/, 'and the end of the file, where the wrappers were, holds none of it');
});

// ── the counts ───────────────────────────────────────────────────────────────────────────────
test('counts: each segment shows the sidebar\'s number for its place, drawn once at boot, and both come from the one read', async () => {
  const seed = makeSeed({
    singles: [single({ id: 'a' }), single({ id: 'b', status: '' }), single({ id: 'c', status: undefined }), single({ id: 'd', status: 'Sold' }), single({ id: 'e', status: 'Reserved' })],
    slabs: [slab({ id: 'p1' }), slab({ id: 'p2', status: 'Sold' }), slab({ id: 'p3', status: '' })],
    etbs: [{ id: 'e1', status: 'In Stock' }, { id: 'e2', status: 'Sold' }, { id: 'e3', status: 'Traded' }],
    boosterBoxes: [{ id: 'b1', status: 'Unopened Stock' }, { id: 'b2', status: 'Reserved' }, { id: 'b3', status: 'Opened' }],
    boosterPacks: [{ id: 'k1', status: 'Sealed' }, { id: 'k2', status: 'Opened' }, { id: 'k3', status: 'Sold' }],
  });
  const { ctx, document } = await loadApp({ seed });
  const text = (id) => document.getElementById(id).textContent;
  assert.deepEqual(segments.map(s => text(s.countId)), ['3', '2', '1', '3'], 'drawn when features.js loaded, before any page change');
  assert.deepEqual(plain(ctx.kjrNavCountsRefresh()), { singles: 3, slabs: 2, etbs: 1, boxes: 3 });
  for (const s of segments) assert.equal(text(s.countId), text('nav-count-' + s.page), s.page + ': the same text as the sidebar');
  // one source: whatever kjrNavCounts answers is what both show, so the switcher has no count of its own
  ctx.kjrNavCounts = () => ({ singles: 11, slabs: 22, etbs: 33, boxes: 44 });
  ctx.kjrNavCountsRefresh();
  assert.deepEqual(segments.map(s => text(s.countId)), ['11', '22', '33', '44']);
  assert.deepEqual(PAGES.map(p => text('nav-count-' + p)), ['11', '22', '33', '44']);
});

test('counts: a big number gets thousands separators and an empty place says 0, in the switcher as in the sidebar', async () => {
  const many = Array.from({ length: 1234 }, (_, n) => single({ id: 's' + n }));
  const { ctx, document } = await loadApp({ seed: makeSeed({ singles: many, slabs: [] }) });
  ctx.kjrNavCountsRefresh();
  assert.equal(document.getElementById('kjr-coll-count-inventory').textContent, '1,234');
  assert.equal(document.getElementById('kjr-coll-count-slabs').textContent, '0');
  assert.equal(document.getElementById('nav-count-inventory').textContent, '1,234');
});

test('counts: they follow every render the sidebar counts follow, and a row added after boot shows in both', async () => {
  const { ctx, document } = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a' })] }) });
  const cases = [['renderSingles', 'inventory'], ['renderSlabs', 'slabs'], ['renderEtbs', 'etbs'], ['renderBoosterBoxes', 'boosterBoxes'], ['renderBoosterPacks', 'boosterBoxes'], ['renderDashboard', 'inventory']];
  for (const [fn, page] of cases) {
    const el = document.getElementById('kjr-coll-count-' + page);
    el.textContent = 'stale';
    ctx[fn]();
    assert.notEqual(el.textContent, 'stale', fn + ' redraws the switcher count');
    assert.equal(el.textContent, document.getElementById('nav-count-' + page).textContent, fn + ': and it agrees with the sidebar');
  }
  const el = document.getElementById('kjr-coll-count-slabs');
  el.textContent = 'stale';
  ctx.showPage('trash');
  assert.notEqual(el.textContent, 'stale', 'and a page change does');
  ctx.DB.slabs.push(slab({ id: 'late' }));
  ctx.renderSlabs();
  assert.equal(document.getElementById('kjr-coll-count-slabs').textContent, '1');
  assert.equal(document.getElementById('nav-count-slabs').textContent, '1');
});

// ── the row's scroll ─────────────────────────────────────────────────────────────────────────
test('scroll: a row wider than its box centres the current segment and moves the row only, and a row that fits is left alone', async () => {
  const { ctx, document } = await loadApp();
  const f = phone(document);
  const pageMoves = [];
  ctx.scrollTo = (...args) => pageMoves.push(['scrollTo', args.join()]);
  for (const el of [f.row, ...f.segs]) el.scrollIntoView = () => pageMoves.push(['scrollIntoView']);
  f.row.clientWidth = 300; f.row.scrollWidth = 520;
  f.segs.forEach((b, i) => { b.offsetLeft = 2 + i * 128; b.offsetWidth = 126; });
  ctx.showPage('boosterBoxes'); // offsetLeft 386, 126 wide, in a box 300 wide: 386 - (300 - 126) / 2
  assert.equal(f.row.scrollLeft, 299);
  ctx.showPage('slabs'); // 130 - 87
  assert.equal(f.row.scrollLeft, 43);
  ctx.showPage('dashboard'); // hidden: the row is not touched
  assert.equal(f.row.scrollLeft, 43);
  // it fits (scrollWidth is not wider than the box): no write at all
  f.row.scrollWidth = 300; f.row.scrollLeft = 7;
  ctx.showPage('etbs');
  assert.equal(f.row.scrollLeft, 7);
  // not laid out (display:none from 601px, or a stub with no metrics): no write, and no throw
  delete f.row.scrollWidth; delete f.row.clientWidth;
  ctx.showPage('inventory');
  assert.equal(f.row.scrollLeft, 7);
  assert.deepEqual([...new Set(pageMoves.map(m => m.join(':')))], ['scrollTo:0,0'], 'the page only ever went to the top, as showPage does on a page change, and the row never scrolled it');
  const fn = appSrc.match(/function syncCollSwitch\([\s\S]*?\n\}/)[0];
  assert.match(fn, /nav\.scrollLeft = /);
  assert.doesNotMatch(fn, /scrollIntoView|scrollTo\(|scrollBy\(/, 'the row is moved by its own scrollLeft, which cannot move the page');
});

// ── the stylesheet ───────────────────────────────────────────────────────────────────────────
const sectionAt = css.indexOf('/* ── Collection switcher, 600px and below');
const section = css.slice(sectionAt, css.indexOf('/* ── Phone Holdings rows'));
const sectionRules = section.replace(/\/\*[\s\S]*?\*\//g, '').trim();
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
const PHONE = '@media (max-width: 600px){';
const phoneBlock = blockOf(sectionRules, PHONE);
const outside = sectionRules.slice(0, sectionRules.indexOf(PHONE)).trim();

test('css: from 601px it is display:none and nothing else styles it, so the sidebar and the rail are as they were', () => {
  assert.ok(sectionAt > css.indexOf('/* ═══════════ Navigation shell (redesign Step 6a, v3.73)'), 'in the shell section, with the other phone navigation');
  assert.ok(sectionAt > css.indexOf('/* ── Bottom tab bar, 600px and below ── */'), 'after the tab bar it goes with');
  // outside the phone query there are exactly two rules: hidden, and hidden stays hidden whatever the query turns on
  assert.equal(outside, '.kjr-coll{display:none}\n.kjr-coll[hidden]{display:none}');
  assert.equal(sectionRules, outside + '\n' + phoneBlock, 'and the phone query is the rest of the section');
  // every rule that mentions the switcher is in that query, or is the Dealer preview hiding it, in the whole stylesheet
  const mentions = (rules.match(/kjr-coll/g) || []).length;
  assert.equal(mentions, (phoneBlock.match(/kjr-coll/g) || []).length + (outside.match(/kjr-coll/g) || []).length + 2, 'plus the Dealer preview line and the import progress bar\'s :has() (v3.90)');
  // the second is the progress bar asking whether the switcher is showing, to start under it. It reads the switcher and styles nothing of it
  assert.ok(rules.includes('body:has(#kjr-coll:not([hidden])) .kjr-sync-bar{top:calc(var(--kjr-top-off) + 62px)}'));
  assert.match(css, /html\.dealer-preview-only \.kjr-coll,\n/, 'the Dealer preview hides the nav chrome, and this is nav chrome');
  assert.equal((phoneBlock.match(/@media/g) || []).length, 1, 'no second query inside');
  // the phone query turns the row on with display:flex (specificity 0,1,0) and the [hidden] rule above it (0,2,0) still wins, so a page
  // with no segment shows no row
  assert.match(phoneBlock, /\.kjr-coll\{position:sticky;top:var\(--kjr-top-off\);z-index:90;display:flex;/);
});

test('css: the row is a --bg3 track that scrolls inside itself with no bar, and cannot widen the page', () => {
  const row = phoneBlock.match(/\n  \.kjr-coll\{([^}]*)\}/)[1];
  assert.match(row, /position:sticky;top:var\(--kjr-top-off\);z-index:90;display:flex;align-items:stretch;gap:2px;/, 'pinned, and still a positioned box, so offsetLeft is measured from the row');
  assert.match(row, /margin:12px max\(12px,env\(safe-area-inset-right\)\) 0 max\(12px,env\(safe-area-inset-left\)\);/, 'the page gutter, and the notch in landscape');
  assert.match(row, /padding:2px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none;/);
  assert.match(row, /background:var\(--bg3\);border:1px solid var\(--border2\);border-radius:var\(--radius\);box-shadow:0 0 0 12px var\(--bg\);clip-path:inset\(-12px -12px 0\)$/, 'the look of .seg, and the page-coloured backing, cut at the row\'s bottom edge (v3.90)');
  assert.doesNotMatch(row, /(^|;)(width|min-width|max-width|flex-wrap)\s*:/, 'a block-level flex box fills the gutters and no more');
  assert.match(phoneBlock, /\.kjr-coll::-webkit-scrollbar\{display:none\}/);
});

test('css: a segment is 44px tall, never shrinks below its words, shows the name over the count, and the current one is filled and heavier', () => {
  const btn = phoneBlock.match(/\n  \.kjr-coll-btn\{([^}]*)\}/)[1];
  assert.match(btn, /min-height:44px;/);
  assert.match(btn, /flex:1 0 auto;/, 'shares what is left, never shrinks');
  assert.match(btn, /flex-direction:column;align-items:center;justify-content:center;/, 'the name over the count');
  assert.match(btn, /white-space:nowrap;/, '"Boxes & packs" stays on one line');
  assert.match(btn, /border:0;border-radius:calc\(var\(--radius\) - 2px\);background:transparent;color:var\(--text2\);/);
  assert.match(btn, /font-size:13px;font-weight:500;/);
  const on = phoneBlock.match(/\n  \.kjr-coll-btn\[aria-current="page"\]\{([^}]*)\}/)[1];
  assert.equal(on, 'background:var(--accent);color:var(--accent-fg);font-weight:600', 'a fill and a heavier weight, not colour alone');
  const weight = (decl) => +decl.match(/font-weight:(\d+)/)[1];
  assert.ok(weight(on) > weight(btn), 'the weight really is heavier than the rest');
  // the count: tabular, quiet, gone while empty, and the current segment's count reads in its own text colour
  assert.match(phoneBlock, /\.kjr-coll-count\{font-size:12px;font-weight:400;line-height:14px;color:var\(--text3\);font-variant-numeric:tabular-nums\}/);
  assert.match(phoneBlock, /\.kjr-coll-count:empty\{display:none\}/);
  assert.match(phoneBlock, /\.kjr-coll-btn\[aria-current="page"\] \.kjr-coll-count\{color:inherit\}/);
});

test('css: a keyboard ring on every segment, inset because the row clips an outer one, in a colour that shows on the current fill too', () => {
  assert.match(phoneBlock, /\.kjr-coll-btn:focus-visible\{outline:2px solid var\(--accent\);outline-offset:-2px\}/, 'the 2px accent ring the app uses');
  assert.match(phoneBlock, /\.kjr-coll-btn\[aria-current="page"\]:focus-visible\{outline-color:var\(--accent-fg\)\}/);
  assert.doesNotMatch(phoneBlock, /outline:\s*(none|0)|outline-width:\s*0/, 'never switched off');
});

test('css: tokens only, spaced media queries, no motion to switch off, and nothing that scrolls the page sideways', () => {
  assert.doesNotMatch(sectionRules, /#[0-9a-fA-F]{3,8}\b(?![-\w])/, 'no hex colour');
  assert.doesNotMatch(sectionRules.replace(/rgba?\(0,0,0/g, ''), /rgba?\(/, 'no colour function with a literal');
  assert.doesNotMatch(sectionRules, /@media\(/, 'the compact form is for the older sections, overview.test.js finds its blocks with lastIndexOf on it');
  assert.doesNotMatch(sectionRules, /transition|animation|transform|will-change|backdrop-filter/, 'no motion, so the reduced-motion block has nothing to add');
  assert.doesNotMatch(sectionRules, /100vw|position:fixed/, 'nothing fixed, and nothing sized by the viewport');
  assert.equal((sectionRules.match(/position:sticky/g) || []).length, 1, 'one sticky thing in the section, the row itself (v3.88)');
  const tokens = new Set(sectionRules.match(/var\(--[\w-]+/g).map(v => v.slice(4)));
  assert.deepEqual([...tokens].sort(), ['--accent', '--accent-fg', '--bg', '--bg3', '--border2', '--kjr-top-off', '--radius', '--text2', '--text3'], 'the tokens it reads, all existing ones (--kjr-top-off is the shell\'s own offset)');
});

// ── contrast, both themes ────────────────────────────────────────────────────────────────────
const tokenBlock = (start) => rules.slice(rules.indexOf('{', start) + 1, rules.indexOf('\n}', start));
const tokensOf = (text) => Object.fromEntries([...text.matchAll(/(--[\w-]+):\s*(#[0-9A-Fa-f]{6})\s*;/g)].map(m => [m[1], m[2]]));
const dark = tokensOf(tokenBlock(rules.indexOf(':root{')));
const light = Object.assign({}, dark, tokensOf(tokenBlock(rules.indexOf('html.light{'))));
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

test('contrast: the name and the count clear 4.5:1 on the track, the current segment clears it on its fill, and the ring clears 3:1, in both themes', () => {
  for (const [theme, t] of [['dark', dark], ['light', light]]) {
    for (const k of ['--bg', '--bg3', '--text2', '--text3', '--accent', '--accent-fg']) assert.ok(t[k], theme + ' ' + k + ' resolves to a hex colour');
    const pair = (fg, bg, min, what) => assert.ok(contrast(t[fg], t[bg]) >= min, theme + ' ' + what + ': ' + contrast(t[fg], t[bg]).toFixed(2) + ':1');
    pair('--text2', '--bg3', 4.5, 'name on the track');
    pair('--text3', '--bg3', 4.5, 'count on the track');
    pair('--accent-fg', '--accent', 4.5, 'current name and count on the accent fill');
    pair('--accent', '--bg3', 3, 'ring on the track');
    pair('--accent-fg', '--accent', 3, 'ring inside the current fill');
    pair('--accent', '--bg', 3, 'the current fill against the page, so the segment is a shape too');
  }
});

// ── pinned under the header (v3.88) ──────────────────────────────────────────────────────────
// Until v3.88 the row stayed in the flow, so it scrolled away with the top of the page. Now it is sticky at the height the phone header takes. The
// harness has no layout engine, so these pin the stylesheet and the arithmetic. That the row meets the header at the first pixel (its
// 12px margin is spent as it sticks), over the page at every scroll, in dark and light, and clear of a notch, is checked in a browser.
const phoneRule = (selector) => {
  const at = rules.indexOf('@media (max-width: 600px){\n  ' + selector + '{');
  assert.ok(at >= 0, 'phone rule not found: ' + selector);
  return rules.slice(rules.indexOf('{', at + 30) + 1, rules.indexOf('}', at));
};

test('pinned: the row is sticky at the header\'s own height, so it sits directly under the header and a notch is cleared the way it is for the header', () => {
  const row = phoneBlock.match(/\n  \.kjr-coll\{([^}]*)\}/)[1];
  assert.match(row, /position:sticky;top:var\(--kjr-top-off\);/);
  assert.doesNotMatch(row, /(^|;)top:(?!var\(--kjr-top-off\))/, 'no second top, and no px value of its own');
  // the offset the row sticks at and the header's height are the same expression, so the row meets the header with no gap and no overlap
  const topOff = rules.match(/@media \(max-width: 600px\)\{\s*:root\{[^}]*--kjr-top-off:(calc\(56px \+ env\(safe-area-inset-top\)\))/)[1];
  const header = phoneRule('.topbar').match(/(?:^|;)height:(calc\(56px \+ env\(safe-area-inset-top\)\))/)[1];
  assert.equal(topOff, header, 'the offset is the header\'s height, safe-area inset and all');
  assert.match(phoneRule('.topbar'), /position:sticky;top:0;/, 'and the header is the sticky box the row meets');
  assert.match(rules, /\.topbar\{position:fixed;top:0;bottom:0;left:0;z-index:100;box-sizing:border-box;/, 'the height is the border box, the inset is inside it');
  assert.match(phoneRule('.topbar'), /padding:env\(safe-area-inset-top\) /, 'with the inset as the header\'s own top padding');
});

test('pinned: it sits over the table heads and under the header, and the page popovers sit over it', () => {
  const zOf = (selector) => +rules.match(new RegExp(selector.replace(/[.[\]()+*?^$|{}\\]/g, '\\$&') + '\\{[^}]*z-index:(\\d+)'))[1];
  const row = +phoneBlock.match(/\.kjr-coll\{[^}]*z-index:(\d+)/)[1];
  assert.ok(row > zOf('.tbl-wrap thead'), 'over the sticky table head (' + zOf('.tbl-wrap thead') + '), which would otherwise paint across it');
  assert.ok(row < zOf('.topbar'), 'under the header (' + zOf('.topbar') + '), so its Settings menu opens over the row');
  assert.ok(row < zOf('.col-toggle-dropdown') && row < zOf('.filters-dropdown'), 'the Columns and Filters popovers stay over it');
  assert.ok(row < zOf('.kjr-rowmenu') && row < zOf('.bottom-tab-bar') && row < zOf('.overlay'), 'and so do the row menu, the tab bar and the dialogs');
});

test('pinned: it is opaque in both themes, the track and the backing are solid tokens, and the backing reaches the screen edges (v3.90: and no longer the strip under the row)', () => {
  for (const [theme, t] of [['dark', dark], ['light', light]]) {
    for (const k of ['--bg', '--bg3']) assert.match(t[k], /^#[0-9A-Fa-f]{6}$/, theme + ' ' + k + ' is a solid six-digit colour, no alpha');
  }
  const row = phoneBlock.match(/\n  \.kjr-coll\{([^}]*)\}/)[1];
  assert.match(row, /background:var\(--bg3\);/, 'the track is --bg3, not a translucent fill');
  assert.doesNotMatch(row, /opacity|rgba|backdrop-filter|transparent/, 'nothing that lets the page through');
  const gutter = +row.match(/margin:(\d+)px /)[1];
  const spread = +row.match(/box-shadow:0 0 0 (\d+)px var\(--bg\)/)[1];
  assert.equal(spread, gutter, 'the backing is as wide as the gutter, so it fills it to the screen edge on both sides (Holdings rows are 8px wider than the gutter)');
  assert.match(rules, /body\{font-family:var\(--font-sans\);[^}]*background:var\(--bg\);/, 'the backing is the page colour, so at rest it is not seen');
  assert.ok(/@media\(max-width:700px\)\{\s*\.main\{padding:12px;/.test(rules), 'the page content that slides under it starts 12px in from the edges, the width of the backing, as .main pads at this width');
  // the clip is as wide as the backing on the top and the two sides, so it cuts none of the backing the gutters need
  const clip = row.match(/clip-path:inset\(-(\d+)px -(\d+)px 0\)/);
  assert.ok(clip, 'the row clips its own shadow');
  assert.deepEqual([+clip[1], +clip[2]], [spread, spread], 'the top and the sides keep all of the backing, only the bottom is cut');
});

// ── the backing stops at the row (v3.90) ─────────────────────────────────────────────────────
// Until v3.90 the 12px shadow went all the way round, so under the pinned row it was a 12px strip of --bg that hid the top of whatever was scrolled
// up beneath it (the summary strip's edge, a row's first 12px) and let a tap fall through to the card hidden behind it: at 150px of scroll,
// elementFromPoint under the strip answered the summary label behind it. At rest nothing sat under it, .main starts 12px below the row, which is
// why the strip was never seen on a fresh page. The harness has no layout engine, so this pins the stylesheet, and the pixels were checked in a
// browser (the strip's bottom edge and a tap just under the row, at rest and at 150px of scroll).
test('backing: the shadow is cut at the row\'s bottom edge, so no strip of --bg sits under the pinned row for content to hide in', () => {
  const row = phoneBlock.match(/\n  \.kjr-coll\{([^}]*)\}/)[1];
  // inset(top right bottom left): a negative value reaches out of the border box, 0 stops exactly at it, so the bottom is the row's own edge
  assert.match(row, /clip-path:inset\(-12px -12px 0\)(;|$)/);
  assert.equal((row.match(/box-shadow:/g) || []).length, 1, 'one shadow, no second one that reaches below the row');
  assert.match(row, /box-shadow:0 0 0 12px var\(--bg\)/, 'centred on the row, not offset down');
  assert.doesNotMatch(row, /margin-bottom/, 'and no spacer under the row to push the page about: the layout of the four pages is as it was');
  // the shadow's corner arc is concentric with the row's own and 12px larger, so what the clip leaves is the backing at the top and the sides, and
  // the corners inside the row's box still read as page colour. Nothing of the row itself is clipped: the clip is never tighter than its box
  assert.match(row, /border-radius:var\(--radius\)/);
  assert.doesNotMatch(row, /clip-path:inset\(0/);
  assert.doesNotMatch(row, /clip-path:(?!inset)/, 'a plain inset, no path or shape that could cut the row');
});

test('pinned: nothing else is pinned to the top of the page at 600px and below, so there is no other top to move', () => {
  const stickyTops = [...rules.matchAll(/([^{}]+)\{([^{}]*position:sticky[^{}]*)\}/g)]
    .filter(m => /(^|;)top:/.test(m[2])).map(m => m[1].replace(/\s+/g, ' ').trim());
  assert.deepEqual(stickyTops, ['.tbl-wrap thead', '.modal-head', '.guide-toc', '.dealer-production-list', '.kjr-insp-top', '.topbar', '.kjr-coll'],
    'a new sticky top must say how it clears the row, add it here when it does');
  // a table head sticks inside its own wrap: from 1001px the wrap stops being a scroller (and the row is hidden from 601px), below it the wrap is one
  // (overflow-x makes overflow-y auto), and a wrap does not scroll up and down, so its head never meets the row
  assert.match(rules, /\.tbl-wrap\{overflow-x:auto\}/);
  assert.match(rules, /@media\(min-width:1001px\)\{\.tbl-wrap\{overflow-x:visible\}\}/);
  assert.match(rules, /@media\(max-width:1000px\)\{\.tbl-wrap thead\{top:0\}\}/);
  assert.match(rules, /body:not\(\.force-tables\) \.page \.tbl-wrap\{overflow-x:hidden\}/, 'the phone card view keeps it a scroller too');
  // the rest are on pages the row is not on (Guide, Dealer), in dialogs, or in the card inspector, which is a full-height sheet at 900px and below
  assert.match(rules, /@media \(max-width: 900px\)\{\s*#kjr-inspector\{display:none!important\}/);
});

test('pinned: a row or tile scrolled into view clears the header, the row and 16px of air, and 600px and below is the only place that changes', () => {
  const seg = +phoneBlock.match(/\.kjr-coll-btn\{[^}]*min-height:(\d+)px/)[1];
  const pad = +phoneBlock.match(/\.kjr-coll\{[^}]*padding:(\d+)px/)[1];
  const border = +phoneBlock.match(/\.kjr-coll\{[^}]*border:(\d+)px solid/)[1];
  // v3.90: the backing no longer reaches below the row (clip-path), so it is no part of the clearance: it was 12px of the 78
  assert.match(phoneBlock, /clip-path:inset\(-12px -12px 0\)/);
  const clear = seg + 2 * pad + 2 * border + 16;
  assert.equal(clear, 66, 'the segment (44) and the track\'s padding (2) and border (1) on both sides make the 50px row, then 16px of air');
  const want = 'calc(var(--kjr-top-off) + ' + clear + 'px)';
  assert.ok(phoneBlock.includes('.kjr-tile.is-inspected,#page-inventory tbody tr.is-inspected,#page-slabs tbody tr.is-inspected{scroll-margin-top:' + want + '}'), 'grid tiles and table rows, the phone only');
  assert.ok(rules.includes('.kjr-hold-row.is-inspected{background:var(--accent-soft);scroll-margin:' + want + ' 0 '), 'the Holdings rows');
  // everywhere wider is as it was: the 120px margins stay, and the Holdings rows only exist on a phone
  assert.ok(rules.includes('#page-inventory tbody tr.is-inspected,#page-slabs tbody tr.is-inspected{scroll-margin:120px 0 32px}'));
  assert.ok(rules.includes('.kjr-tile.is-inspected{scroll-margin:120px 0 32px}'));
});
