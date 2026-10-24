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
// The harness hands out a stub for any id, and a browser answers null for an id that is not in the page. The older showPage wrapper in
// app.js lights "btb-" plus the page, and falls back to More when there is no such tab, so the fixture answers null for a tab that is not
// in the markup (there is no btb-slabs or btb-guide), as the browser does.
function phone(document) {
  const stubFor = document.getElementById.bind(document);
  document.getElementById = (id) => (/^btb-/.test(id) && !tabs.some(t => t.id === id) ? null : stubFor(id));
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
  // showPage's later wrapper repaints the bar after syncMoreActive, so the function is asked directly
  for (const [page, on] of [['slabs', false], ['etbs', false], ['boosterBoxes', false], ['boosterPacks', false], ['guide', true], ['reports', true], ['dashboard', false], ['inventory', false]]) {
    ctx.syncMoreActive(page);
    assert.equal(f.tab.more.classList.contains('active'), on, page + ': More ' + (on ? 'lights' : 'stays unlit'));
  }
  // a shell with no Collection tab (cut down, or an older cached one): the holder is not there to light, and More is still not the answer
  const real = document.getElementById;
  document.getElementById = (id) => (id === 'btb-inventory' ? null : real(id));
  ctx.showPage('slabs');
  assert.deepEqual(f.lit(f.bar), [], 'nothing lit');
  assert.equal(f.tab.more.getAttribute('aria-current'), null);
  document.getElementById = real;
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
  assert.equal(mentions, (phoneBlock.match(/kjr-coll/g) || []).length + (outside.match(/kjr-coll/g) || []).length + 1, 'plus the one Dealer preview line');
  assert.match(css, /html\.dealer-preview-only \.kjr-coll,\n/, 'the Dealer preview hides the nav chrome, and this is nav chrome');
  assert.equal((phoneBlock.match(/@media/g) || []).length, 1, 'no second query inside');
  // the phone query turns the row on with display:flex (specificity 0,1,0) and the [hidden] rule above it (0,2,0) still wins, so a page
  // with no segment shows no row
  assert.match(phoneBlock, /\.kjr-coll\{position:relative;display:flex;/);
});

test('css: the row is a --bg3 track that scrolls inside itself with no bar, and cannot widen the page', () => {
  const row = phoneBlock.match(/\n  \.kjr-coll\{([^}]*)\}/)[1];
  assert.match(row, /position:relative;display:flex;align-items:stretch;gap:2px;/, 'positioned so offsetLeft is measured from the row');
  assert.match(row, /margin:12px max\(12px,env\(safe-area-inset-right\)\) 0 max\(12px,env\(safe-area-inset-left\)\);/, 'the page gutter, and the notch in landscape');
  assert.match(row, /padding:2px;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none;/);
  assert.match(row, /background:var\(--bg3\);border:1px solid var\(--border2\);border-radius:var\(--radius\)$/, 'the look of .seg');
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
  assert.doesNotMatch(sectionRules, /100vw|position:fixed|position:sticky/, 'in the flow, under the sticky header');
  const tokens = new Set(sectionRules.match(/var\(--[\w-]+/g).map(v => v.slice(4)));
  assert.deepEqual([...tokens].sort(), ['--accent', '--accent-fg', '--bg3', '--border2', '--radius', '--text2', '--text3'], 'the tokens it reads, all existing ones');
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
