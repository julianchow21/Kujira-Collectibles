'use strict';
// Redesign Step 6b (v3.74): polish and leftovers. The wording that named a key emoji, the BGS and CGC dots, self-hosted Geist, the
// dead tooltip code, the Chart Builder icons, the room Needs attention gets, the focus after a delete, the phone sort, the holo
// shine and the rail's long-press labels. (The ⌘K palette has its own suite, tests/palette.test.js, and the version move is in
// tests/navigation.test.js.) The harness has no layout engine and a stub document, so each feature is driven through its own
// functions with a small fake DOM where it needs one, the way tests/inspector.test.js drives the card inspector.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, makeSeed, plain, ROOT } = require('./harness.js');

const read = (f) => fs.readFileSync(ROOT + '/' + f, 'utf8');
const html = read('index.html');
const css = read('styles.css');
const appSrc = read('app.js');
const features = read('features.js');
const sw = read('sw.js');
const single = (o) => Object.assign({}, makeSeed().singles[0], o);
const slab = (o) => Object.assign({
  id: 'slab_1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '12345678', rank: '', type: 'slab',
  language: 'EN', costPrice: 520, marketPrice: 610, listPrice: '', dateListed: '3 Jul 2026', status: 'Available',
  notes: '', priceAlert: '', _updatedAt: new Date().toISOString(),
}, o);
// the Step 6b section of the stylesheet, comments stripped, and the whole file without comments
const SECTION_AT = css.indexOf('/* ═══════════ Polish and leftovers (redesign Step 6b, v3.74)');
const section = css.slice(SECTION_AT).replace(/\/\*[\s\S]*?\*\//g, '');
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokenBlock = (start) => cssRules.slice(cssRules.indexOf('{', start) + 1, cssRules.indexOf('\n}', start));
const darkTokens = tokenBlock(cssRules.indexOf(':root{'));
const lightTokens = tokenBlock(cssRules.indexOf('html.light{'));
const token = (block, name) => { const m = block.match(new RegExp('--' + name + ':(#[0-9A-Fa-f]{6})\\b')); return m && m[1]; };

// WCAG 2 contrast
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => { const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]; return (hi + 0.05) / (lo + 0.05); };

// ══ 3a. the key emoji ═══════════════════════════════════════════════════════════════════════════
test('wording: no key emoji is left in app.js, and every price API message names Settings, then API settings', async () => {
  assert.doesNotMatch(appSrc, /🔑/, 'not in any string, comment or template');
  assert.doesNotMatch(features + html, /🔑/);
  assert.doesNotMatch(appSrc, /click\s+[^'"\n]*\s+in top bar|in the top bar/i, 'and no message points at a top bar key that is not there');
  // the toasts, run for real
  const { ctx, document } = await loadApp({ seed: makeSeed({ singles: [], slabs: [slab({ id: 's1' })] }) });
  const said = [];
  ctx.toast = (m) => said.push(String(m));
  ctx.openApiSettings = () => {};
  // refreshPrice and bulkRefreshPrices follow the refresh queue since v3.75 (tests/refresh-price.test.js): the Worker holds the PPT key, so a
  // slab is not stopped for a missing local one. Only with the proxy off do they ask, that half runs for real in
  // tests/refresh-price-noproxy.test.js, so here the wording is pinned where each message lives. Declining the confirm ends the bulk run
  // before any request.
  ctx.kjrConfirm = async () => false;
  await ctx.bulkRefreshPrices('slabs');
  await ctx.refreshPrice('s1', 'slabs');
  assert.ok(!said.includes('Add API keys first: open Settings, then API settings'), 'a slab is not blocked on a missing local key: ' + JSON.stringify(said));
  assert.match(appSrc, /async function refreshPrice[\s\S]*?toast\('Add API keys first: open Settings, then API settings'\)/);
  assert.match(appSrc, /async function bulkRefreshPrices[\s\S]*?toast\('Add API keys first: open Settings, then API settings'\); openApiSettings\(\)/);
  said.length = 0;
  // the status lines and the advice
  assert.match(appSrc, /' · API looks down - check your keys in Settings, then API settings'/);
  assert.match(appSrc, /' · ⚠ key invalid - check Settings, then API settings'/);
  assert.match(appSrc, /' · ⚠ key invalid - open Settings, then API settings'/);
  assert.match(appSrc, /Likely cause: API key invalid or expired\. Open Settings, then API settings, and re-test\./);
  assert.match(appSrc, /Open Settings, then API settings, to check or replace the keys\./);
  // the settings box is headed "Price API settings", sentence case, no emoji
  const realOpen = ctx.openApiSettings;
  const fresh = await loadApp();
  fresh.ctx.openApiSettings();
  const box = fresh.document.body._lastInsertedHTML;
  assert.match(box, /<h3 style="font-size:15px;font-weight:600;margin:0">Price API settings<\/h3>/);
  assert.doesNotMatch(box, /Price API Settings/);
  void realOpen; void document;
});

// ══ 3b and 3c. the dots on the grader chips ═════════════════════════════════════════════════════
test('BGS: a plain BGS badge carries data-grader="bgs", a pristine BGS and every other grader do not, and the class mapping is untouched', async () => {
  const { ctx } = await loadApp();
  const bgs = ctx.graderGradeBadge('BGS', '9.5');
  assert.equal(bgs, '<span class="badge b-slab" data-grader="bgs" style="font-size:13px;font-weight:600;letter-spacing:0.2px;padding:3px 10px">BGS 9.5</span>');
  assert.match(ctx.graderGradeBadge('bgs', '9'), /^<span class="badge b-slab" data-grader="bgs"/, 'any spelling the resolver reads as BGS');
  assert.match(ctx.graderGradeBadge('BGS 8.5', ''), /data-grader="bgs"/);
  const pristine = ctx.graderGradeBadge('BGS', '10', 'Pristine');
  assert.match(pristine, /class="badge b-pristine"/);
  assert.doesNotMatch(pristine, /data-grader/, 'it keeps b-pristine and its own gold');
  assert.doesNotMatch(ctx.graderGradeBadge('BGS Black Label', '10'), /data-grader/);
  // PSA is byte for byte what table-cleanup.test.js pins, and CGC, TAG and the unknown ones carry nothing new
  assert.equal(ctx.graderGradeBadge('PSA', '10'), '<span class="badge b-psa" style="font-size:13px;font-weight:600;letter-spacing:0.2px;padding:3px 10px">PSA 10</span>');
  assert.doesNotMatch(ctx.graderGradeBadge('CGC', '9.5'), /data-grader/);
  assert.doesNotMatch(ctx.graderGradeBadge('TAG', '10'), /data-grader/);
  assert.doesNotMatch(ctx.graderGradeBadge('ACE', '10'), /data-grader/);
  assert.doesNotMatch(ctx.graderGradeBadge('', ''), /data-grader/);
  assert.equal(ctx._graderClass('BGS'), 'b-slab', 'the mapping the grader tests pin');
  assert.equal(ctx._graderClass('CGC'), 'b-cgc');
  // and the rule that reads the attribute
  assert.match(cssRules, /\.badge\.b-slab\[data-grader="bgs"\]\{--kjr-dot:var\(--grader-bgs\)\}/);
  assert.match(cssRules, /\.badge\.b-slab\{--kjr-dot:var\(--text3\)\}/, 'the generic slab rule stays');
  assert.match(cssRules, /\.badge\.b-psa\{--kjr-dot:var\(--grader-psa\)\}[\s\S]*\.badge\.b-cgc\{--kjr-dot:var\(--grader-cgc\)\}[\s\S]*\.badge\.b-tag\{--kjr-dot:var\(--text\)\}/, 'the pinned PSA, CGC and TAG rules stay');
});

test('dots: every grader dot is at least 3:1 on its chip and on the surface in both themes, and the two new tokens are pinned', () => {
  const dark = { bg3: token(darkTokens, 'bg3'), bg2: token(darkTokens, 'bg2') };
  const light = { bg3: token(lightTokens, 'bg3'), bg2: token(lightTokens, 'bg2') };
  assert.deepEqual([dark.bg3, dark.bg2, light.bg3, light.bg2], ['#1B1B21', '#131317', '#F1F1F3', '#FFFFFF']);
  const psa = token(darkTokens, 'grader-psa'), cgc = token(darkTokens, 'grader-cgc'), bgs = token(darkTokens, 'grader-bgs');
  const cgcDot = token(darkTokens, 'grader-cgc-dot'), bgsDotLight = token(lightTokens, 'grader-bgs-dot');
  assert.equal(cgcDot, '#4F7FE8', 'the dark-only CGC dot');
  assert.equal(bgsDotLight, '#A67C00', 'the light-only BGS dot');
  assert.equal(cgc, '#2459D6', 'the brand blue is untouched (the drawn slab label and white text sit on it)');
  assert.equal(bgs, '#C9A227');
  // why the dark CGC dot exists
  assert.ok(ratio(cgc, dark.bg3) < 3, 'the brand blue is under 3:1 on the dark chip (' + ratio(cgc, dark.bg3).toFixed(2) + ')');
  // dark: PSA, the new CGC dot and BGS gold; light: the brand CGC blue, PSA's light token and the deeper BGS gold
  for (const [name, c] of [['PSA', psa], ['CGC dot', cgcDot], ['BGS', bgs]]) {
    assert.ok(ratio(c, dark.bg3) >= 3, 'dark ' + name + ' on the chip: ' + ratio(c, dark.bg3).toFixed(2));
    assert.ok(ratio(c, dark.bg2) >= 3, 'dark ' + name + ' on the surface: ' + ratio(c, dark.bg2).toFixed(2));
  }
  for (const [name, c] of [['PSA', psa], ['CGC', cgc], ['BGS dot', bgsDotLight]]) {
    assert.ok(ratio(c, light.bg3) >= 3, 'light ' + name + ' on the chip: ' + ratio(c, light.bg3).toFixed(2));
    assert.ok(ratio(c, light.bg2) >= 3, 'light ' + name + ' on the surface: ' + ratio(c, light.bg2).toFixed(2));
  }
  assert.ok(ratio(token(darkTokens, 'bg3'), '#000000') > 0);
  // the BGS gold is under 3:1 on the light chip, which is why light has a token of its own
  assert.ok(ratio(bgs, light.bg3) < 3, 'gold on the light chip: ' + ratio(bgs, light.bg3).toFixed(2));
  // the rules that choose the dot: dark-only for CGC, light-only for BGS, after the pinned base rules
  assert.match(cssRules, /html:not\(\.light\) \.badge\.b-cgc\{--kjr-dot:var\(--grader-cgc-dot\)\}/);
  assert.match(cssRules, /html\.light \.badge\.b-slab\[data-grader="bgs"\]\{--kjr-dot:var\(--grader-bgs-dot\)\}/);
  assert.ok(cssRules.indexOf('.badge.b-cgc{--kjr-dot:var(--grader-cgc)}') < cssRules.indexOf('html:not(.light) .badge.b-cgc{'), 'the override comes after the pinned rule');
  assert.equal((cssRules.match(/--grader-cgc-dot:/g) || []).length, 1, 'defined once, in the dark block');
  assert.equal((cssRules.match(/--grader-bgs-dot:/g) || []).length, 1, 'defined once, in the light block');
});

// ══ 3d. Geist, self-hosted ══════════════════════════════════════════════════════════════════════
test('fonts: the two variable woff2 files and the licence are in Assets/fonts, intact, at the sizes the package lists', () => {
  const geist = fs.readFileSync(ROOT + '/Assets/fonts/Geist-Variable.woff2');
  const mono = fs.readFileSync(ROOT + '/Assets/fonts/GeistMono-Variable.woff2');
  assert.equal(geist.length, 69652);
  assert.equal(mono.length, 71368);
  assert.equal(geist.subarray(0, 4).toString('latin1'), 'wOF2', 'a woff2 file');
  assert.equal(mono.subarray(0, 4).toString('latin1'), 'wOF2');
  const ofl = read('Assets/fonts/OFL.txt');
  assert.equal(Buffer.byteLength(ofl), 4368);
  assert.match(ofl, /Copyright \(c\) 2023 Vercel/);
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.deepEqual(fs.readdirSync(ROOT + '/Assets/fonts').sort(), ['Geist-Variable.woff2', 'GeistMono-Variable.woff2', 'OFL.txt'], 'nothing else was downloaded');
});

test('fonts: the @font-face rules sit at the top of styles.css, swap, a declared weight range, local relative urls, and nothing else loads fonts from another origin', () => {
  const head = css.slice(0, css.indexOf('*{box-sizing:border-box'));
  assert.match(head, /@font-face\{font-family:'Geist';font-style:normal;font-weight:400 700;font-display:swap;src:url\('Assets\/fonts\/Geist-Variable\.woff2'\) format\('woff2'\)\}/);
  assert.match(head, /@font-face\{font-family:'Geist Mono';font-style:normal;font-weight:400 500;font-display:swap;src:url\('Assets\/fonts\/GeistMono-Variable\.woff2'\) format\('woff2'\)\}/);
  assert.equal((css.match(/@font-face/g) || []).length, 2);
  assert.match(css, /--font-sans:'Geist',-apple-system,/);
  assert.match(css, /--font-mono:'Geist Mono',ui-monospace,/);
  for (const [name, src] of [['index.html', html], ['styles.css', css], ['sw.js', sw], ['app.js', appSrc], ['features.js', features]]) {
    assert.doesNotMatch(src, /fonts\.googleapis\.com|fonts\.gstatic\.com/, name + ' has no Google Fonts origin');
  }
  assert.doesNotMatch(html, /rel="preconnect"/, 'and no preconnect left');
  assert.doesNotMatch(html, /<link[^>]+href="https?:\/\/fonts/);
  // the sans is preloaded, and only the sans, ahead of the stylesheet
  const links = [...html.matchAll(/<link rel="preload"[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(links, ['<link rel="preload" href="Assets/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossorigin>']);
  assert.ok(html.indexOf('rel="preload"') < html.indexOf('<link rel="stylesheet" href="styles.css?v='));
  // and the worker caches both, on the one CORE line
  const core = sw.match(/^const CORE = \[.*\];$/m);
  assert.ok(core, 'CORE is one line');
  assert.match(core[0], /'\.\/Assets\/fonts\/Geist-Variable\.woff2', '\.\/Assets\/fonts\/GeistMono-Variable\.woff2'/);
  assert.equal((sw.match(/const CORE = \[/g) || []).length, 1);
  assert.match(sw, /'\.\/Assets\/lib\/three\.module\.js\?v=3\.31'/, 'the vendored library keeps its version');
  // the preview fixtures strip http links, the relative preload and the file survive that
  assert.doesNotMatch(html, /<link[^>]+href="https?:\/\/[^"]*"[^>]*>/, 'no external link element at all');
});

// ══ 3e. the dead tooltip code ═══════════════════════════════════════════════════════════════════
test('dead code: kjrToggleTooltip, its click-away listener and the metric and stat info CSS are gone, and what shared their rules is intact', () => {
  for (const [name, src] of [['app.js', appSrc], ['features.js', features], ['index.html', html], ['styles.css', css]]) {
    assert.doesNotMatch(src, /kjrToggleTooltip|metric-info|metric-trust|inv-stat-info|inv-stat-tooltip/, name);
  }
  // the coarse-pointer hit areas for the controls that remain
  assert.match(cssRules, /\.eb-tl-dot,\.sell-qty button,\.sell-cart-remove\{position:relative\}\s*\.eb-tl-dot::after,\.sell-qty button::after,\.sell-cart-remove::after\{\s*content:"";position:absolute;inset:-12px;\s*\}/);
  assert.match(cssRules, /\.inv-stat-label\{[^}]*\}\s*\.inv-stat-value\{/, 'the stat label and value rules next to the removed ones stay');
  assert.match(cssRules, /\.metric\{position:relative\}/, 'the Sales summary tile');
  assert.match(cssRules, /#toast:popover-open\{display:block\}\s*\/?\s*:is\(\.btn/, 'the rules around the last removal');
});

// ══ 3f. Chart Builder icons ═════════════════════════════════════════════════════════════════════
test('Chart Builder: every field names an inline stroke icon, no emoji is left on a field, and the picker, the pill and the chip draw the SVG', async () => {
  const { ctx, document } = await loadApp();
  const fields = Object.entries(ctx.CB_FIELDS);
  assert.ok(fields.length >= 30);
  const keys = Object.keys(ctx.CB_ICON_PATHS);
  for (const [k, f] of fields) {
    assert.ok(keys.includes(f.icon), k + ' names a drawn icon (' + f.icon + ')');
    assert.match(f.icon, /^[a-z]+$/, k + ': a key, not an emoji');
  }
  assert.ok(new Set(fields.map(([, f]) => f.icon)).size >= 15, 'a glyph per kind, shared inside a kind');
  assert.equal(fields.find(([k]) => k === 'pokeName')[1].icon, fields.find(([k]) => k === 'fullName')[1].icon, 'the two name fields share one');
  const svg = ctx.cbIconHtml('card');
  assert.match(svg, /^<svg class="cb-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1\.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">.+<\/svg>$/);
  assert.equal(ctx.cbIconHtml('nope'), ctx.cbIconHtml('warn'), 'an unknown key draws the warning glyph');
  assert.equal(ctx.cbIconHtml('constructor'), ctx.cbIconHtml('warn'), 'and not an inherited property');
  for (const k of keys) assert.match(ctx.cbIconHtml(k), /<svg[^>]+aria-hidden="true">.+<\/svg>$/);
  // the three uses
  assert.equal((appSrc.match(/cbIconHtml\(f\.icon\)/g) || []).length, 3, 'picker label, pill and axis chip');
  assert.match(appSrc, /`\$\{cbIconHtml\(f\.icon\)\} \$\{f\.label\}<\/label>`/);
  assert.match(appSrc, /<span class="pill-icon">\$\{cbIconHtml\(f\.icon\)\}<\/span>/);
  assert.match(appSrc, /<span class="cb-axis-chip">\$\{cbIconHtml\(f\.icon\)\} \$\{f\.label\}<button/);
  assert.match(appSrc, /\{ icon: 'warn', label: key \}/);
  // run the picker and the chips for real
  const panel = document.getElementById('cb-field-cfg-dim');
  panel.style.display = 'none';
  ctx._cbOpenFieldPicker('dim');
  assert.match(panel.innerHTML, /<svg class="cb-ico"/);
  assert.doesNotMatch(panel.innerHTML, /[\u{1F000}-\u{1FAFF}✅⭐]/u, 'no emoji in the picker');
  assert.equal((panel.innerHTML.match(/<svg class="cb-ico"/g) || []).length, (panel.innerHTML.match(/<label /g) || []).length, 'one icon per field');
  ctx.cbState = { x: ['language', 'madeUpKey'], y: [], customItems: null };
  ctx.renderCbChips('x');
  const chips = document.getElementById('cb-x-chips').innerHTML;
  assert.equal((chips.match(/<svg class="cb-ico"/g) || []).length, 2);
  assert.doesNotMatch(chips, /⚠/);
  // the one drag handle stays the glyph it was
  assert.match(appSrc, /<span class="pill-icon" style="cursor:grab;opacity:0\.5;font-size:11px;margin-right:2px">⠿<\/span>/);
  assert.match(cssRules, /\.cb-ico\{flex:none;width:16px;height:16px;vertical-align:-3px\}/);
});

// ══ 3g. Needs attention ═════════════════════════════════════════════════════════════════════════
test('Needs attention: .ov is a size container, below 1120px of page the band takes its own row, and nothing changes on a phone or in the one-row layout', () => {
  assert.match(section, /\.ov\{container-name:ov;container-type:inline-size\}/);
  assert.match(section, /@media \(min-width: 601px\) \{\s*@container ov \(max-width: 1120px\) \{\s*\.ov-stats\{flex-wrap:wrap\}\s*\.ov-stat:last-child\{flex:1 0 100%;margin-top:16px;padding:16px 0 0 24px;border-left:0;border-top:1px solid var\(--border\)\}\s*\.ov-att-item\{flex-direction:row;flex-wrap:wrap;align-items:baseline;gap:0 12px\}\s*\}\s*\}/);
  assert.match(section, /@media \(min-width: 601px\) and \(max-width: 900px\) \{\s*\.ov-stat:last-child\{padding-left:0\}\s*\}/, 'stacked: the row starts at the card\'s edge');
  assert.ok(section.indexOf('@container ov') < section.indexOf('(max-width: 900px)'), 'the stacked override comes after the rule it overrides');
  // the existing hero rules the band builds on are the ones the Overview suite pins
  assert.match(css, /\.ov-hero\{display:flex;align-items:stretch;padding:24px;/);
  assert.match(css, /\.ov-stats\{flex:3 1 540px;min-width:0;display:flex\}/);
  assert.match(css, /\.ov-stat\{flex:1 1 180px;min-width:0;padding:0 24px;border-left:1px solid var\(--border\)\}/);
  // the phone grid layout is outside the new rules (they start at 601px)
  assert.match(css, /@media\(max-width:600px\)\{[\s\S]*?\.ov-stats\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.equal((section.match(/@container/g) || []).length, 1);
});

// ══ 3h. focus after a delete ════════════════════════════════════════════════════════════════════
// A page with a fake list view. The view that is "on screen" answers its zones, the others answer nothing (no client rects).
async function deleteEnv(ids, view, table) {
  table = table || 'singles';
  const seed = table === 'singles' ? { singles: ids.map((id) => single({ id, name: 'Card ' + id })) } : { slabs: ids.map((id) => slab({ id, name: 'Slab ' + id })) };
  const app = await loadApp({ seed: makeSeed(seed) });
  const doc = app.document;
  doc.activeElement = null;
  const real = doc.getElementById.bind(doc);
  const focusLog = [];
  const make = (id, kind) => {
    const el = {
      tagName: kind === 'tr' ? 'TR' : 'BUTTON', isConnected: true, className: kind,
      getClientRects: () => [{}],
      getAttribute: (k) => (k === 'data-id' ? id : null),
      focus() { doc.activeElement = this; focusLog.push(kind + ':' + id); },
      closest: (sel) => (sel === '.page' ? { id: 'page' } : null),
    };
    if (kind === 'tr') {
      const btn = { tagName: 'BUTTON', className: 'kjr-name-btn', isConnected: true, getClientRects: () => [{}], getAttribute: () => null, focus() { doc.activeElement = this; focusLog.push('name:' + id); }, closest: () => ({ id: 'page' }) };
      el.querySelector = (sel) => (sel === '.kjr-name-btn' ? btn : null);
    } else {
      el.querySelector = () => null;
    }
    return el;
  };
  const kindOf = { table: ['singles-body', 'slabs-body'], grid: ['singles-grid', 'slabs-grid'], phone: ['singles-cards', 'slabs-cards'] };
  const zoneIds = ['body', 'sold-body', 'grid', 'grid-alt', 'cards', 'sold-cards'].map((z) => table + '-' + z);
  const order = () => Array.from(app.ctx._kjrInspectOrder[table]);
  zoneIds.forEach((zid) => {
    const z = real(zid);
    const showing = kindOf[view].includes(zid);
    z.querySelectorAll = (sel) => (showing && sel === '[data-id]' ? order().map((id) => make(id, view === 'table' ? 'tr' : view === 'grid' ? 'tile' : 'row')) : []);
  });
  const page = real(table === 'singles' ? 'page-inventory' : 'page-slabs');
  page.classList.add('active');
  const heading = { className: 'section-title', tagName: 'DIV', isConnected: true, _attrs: {}, hasAttribute(k) { return k in this._attrs; }, setAttribute(k, v) { this._attrs[k] = v; }, focus() { doc.activeElement = this; focusLog.push('heading'); } };
  page.querySelector = (sel) => (sel === '.section-title' ? heading : null);
  app.ctx.confirm = () => true;
  app.ctx.toast = () => {};
  if (table === 'singles') app.ctx.renderSingles(); else app.ctx.renderSlabs();
  const runFrames = () => { const fns = [...app.rafState.calls.values()]; app.rafState.calls.clear(); fns.forEach((f) => f()); };
  return Object.assign(app, { focusLog, heading, doc, order, runFrames, page });
}

test('delete focus: the row that takes the deleted row\'s place gets focus in the table, the one before it when the last row went', async () => {
  const e = await deleteEnv(['a', 'b', 'c', 'd'], 'table');
  assert.deepEqual(e.order(), ['a', 'b', 'c', 'd']);
  await e.ctx.deleteItem('b', 'singles');
  assert.deepEqual(e.order(), ['a', 'c', 'd']);
  assert.deepEqual(e.focusLog, ['name:c'], 'same position, the card name button of the next row');
  e.focusLog.length = 0;
  await e.ctx.deleteItem('d', 'singles');
  assert.deepEqual(e.focusLog, ['name:c'], 'the last row went, so the one before it');
  e.focusLog.length = 0;
  await e.ctx.deleteItem('a', 'singles');
  assert.deepEqual(e.focusLog, ['name:c'], 'the first row went, the one now first');
});

test('delete focus: the tile in the grid and the Holdings row on a phone, never a view that is not showing', async () => {
  const grid = await deleteEnv(['a', 'b', 'c'], 'grid');
  await grid.ctx.deleteItem('a', 'singles');
  assert.deepEqual(grid.focusLog, ['tile:b']);
  const phone = await deleteEnv(['a', 'b', 'c'], 'phone');
  await phone.ctx.deleteItem('b', 'singles');
  assert.deepEqual(phone.focusLog, ['row:c']);
  // slabs too, the same way
  const slabs = await deleteEnv(['p1', 'p2', 'p3'], 'table', 'slabs');
  await slabs.ctx.deleteItem('p3', 'slabs');
  assert.deepEqual(slabs.focusLog, ['name:p2']);
  // a hidden control (no client rects) is passed over for the one after it
  const hidden = await deleteEnv(['a', 'b', 'c', 'd'], 'table');
  const ctlAt = hidden.doc.getElementById('singles-body').querySelectorAll;
  hidden.doc.getElementById('singles-body').querySelectorAll = (sel) => ctlAt(sel).map((row) => {
    if (row.getAttribute('data-id') === 'c') { const btn = row.querySelector('.kjr-name-btn'); btn.getClientRects = () => []; }
    return row;
  });
  await hidden.ctx.deleteItem('b', 'singles');
  assert.deepEqual(hidden.focusLog, ['name:a'], 'c is hidden, so it falls back to the row before');
});

test('delete focus: an empty list sends focus to the page heading, which has tabindex -1 and no ring', async () => {
  const e = await deleteEnv(['only'], 'table');
  await e.ctx.deleteItem('only', 'singles');
  assert.deepEqual(e.order(), []);
  assert.deepEqual(e.focusLog, ['heading']);
  assert.equal(e.heading._attrs.tabindex, '-1', 'made focusable on the spot if the markup somehow lacks it');
  assert.match(html, /<div class="section-title" tabindex="-1">Singles Inventory<\/div>/);
  assert.match(html, /<div class="section-title" tabindex="-1">Graded Slabs<\/div>/);
  assert.match(section, /\.section-title:focus,\.section-title:focus-visible\{outline:none\}/);
  const s = await deleteEnv(['p1'], 'phone', 'slabs');
  await s.ctx.deleteItem('p1', 'slabs');
  assert.deepEqual(s.focusLog, ['heading']);
});

test('delete focus: a cancelled delete, a page that is not showing and a row that is not in the list change nothing', async () => {
  const e = await deleteEnv(['a', 'b', 'c'], 'table');
  e.ctx.confirm = () => false;
  await e.ctx.deleteItem('b', 'singles');
  assert.deepEqual(e.order(), ['a', 'b', 'c']);
  assert.deepEqual(e.focusLog, [], 'cancelled: today\'s behaviour');
  assert.equal(e.rafState.calls.size, 0);
  e.ctx.confirm = () => true;
  // the Singles page is not the one showing (a delete from the inspector opened on the Overview)
  e.page.classList.remove('active');
  await e.ctx.deleteItem('b', 'singles');
  assert.deepEqual(e.focusLog, []);
  // plans are made only for a showing page and a row in the order
  e.page.classList.add('active');
  assert.equal(e.ctx.kjrDeleteFocusPlan('singles', 'not-there'), null);
  assert.equal(e.ctx.kjrDeleteFocusPlan('sales', 'a'), null);
  assert.equal(e.ctx.kjrDeleteFocusPlan('etbs', 'a'), null);
  assert.deepEqual(plain(e.ctx.kjrDeleteFocusPlan('singles', 'a')), { table: 'singles', at: 0 });
  assert.equal(e.ctx.kjrDeleteFocusRestore(null), false);
  // the data path is the same: the row is gone from the data, the trash and the changelog as before (deleteItem's own suites pin that)
  assert.equal(e.ctx.DB.singles.some((r) => r.id === 'a'), true);
  const body = appSrc.slice(appSrc.indexOf('async function deleteItem(id, table)'), appSrc.indexOf('// Modal edits are full-row replacements'));
  assert.match(body, /const focusPlan = typeof kjrDeleteFocusPlan === 'function' \? kjrDeleteFocusPlan\(table, id\) : null;\n  DB\[table\] = DB\[table\]\.filter\(i => i\.id !== id\);\n  saveData\(\);/, 'the plan is read just before the removal');
  assert.match(body, /if \(table === 'sales'\) renderSales\(\);\n  if \(focusPlan && typeof kjrDeleteFocusRestore === 'function'\) kjrDeleteFocusRestore\(focusPlan\);\n  toast\('Moved to trash/, 'and the focus is restored right after the redraw');
  const focusSrc = features.slice(features.indexOf('function kjrDeleteFocusPlan'), features.indexOf('// ── Phone sort.'));
  assert.doesNotMatch(focusSrc, /markDirty\(|saveData\(|saveAllToSupabase\(|snapshotForUndo\(|DB\.(singles|slabs)\s*=[^=]|localStorage\.setItem|fetch\(/, 'reads and focuses only');
});

test('delete focus: a frame later it puts focus back where it was lost (the inspector sheet gives it to its trigger), and leaves a focus that moved on', async () => {
  const e = await deleteEnv(['a', 'b', 'c'], 'table');
  await e.ctx.deleteItem('a', 'singles');
  assert.deepEqual(e.focusLog, ['name:b']);
  const target = e.doc.activeElement;
  // the controller focused another row's button: lost, so the target gets it again
  const stolen = { tagName: 'BUTTON', closest: (sel) => (sel === '.page' ? { id: 'page-inventory' } : null), focus() {} };
  e.doc.activeElement = stolen;
  e.focusLog.length = 0;
  e.runFrames();
  assert.deepEqual(e.focusLog, ['name:b']);
  // focus on the body is lost as well
  const again = await deleteEnv(['a', 'b'], 'table');
  await again.ctx.deleteItem('a', 'singles');
  again.doc.activeElement = again.doc.body;
  again.focusLog.length = 0;
  again.runFrames();
  assert.deepEqual(again.focusLog, ['name:b']);
  // a dialog has focus (the confirm box of a second action): not lost
  const dlg = await deleteEnv(['a', 'b'], 'table');
  await dlg.ctx.deleteItem('a', 'singles');
  dlg.doc.activeElement = { tagName: 'BUTTON', closest: () => null, focus() {} };
  dlg.focusLog.length = 0;
  dlg.runFrames();
  assert.deepEqual(dlg.focusLog, []);
  // already there: nothing to do
  const same = await deleteEnv(['a', 'b'], 'table');
  await same.ctx.deleteItem('a', 'singles');
  same.focusLog.length = 0;
  same.runFrames();
  assert.deepEqual(same.focusLog, []);
  void target;
});

// ══ 3h (bulk). focus after a bulk delete ════════════════════════════════════════════════════════
// deleteSelected follows the single delete's rule: the first deleted row's position in the drawn order, then the row that took
// it, else the one before it, else the heading. Its button sits in the bulk bar, which hides once nothing is selected, so focus
// is never left on a control that is no longer shown. The bar is a stub that answers contains() for its own buttons.
function bulkBar(e, table) {
  const bar = e.doc.getElementById('bulk-bar-' + table);
  const button = (name) => ({ tagName: 'BUTTON', isConnected: true, name, focus() { e.doc.activeElement = this; e.focusLog.push('bar:' + name); }, closest: (sel) => (sel === '.page' ? { id: 'page' } : null) });
  const del = button('delete');
  const clear = button('clear');
  bar.contains = (el) => el === del || el === clear;
  return { bar, del, clear };
}
const select = (e, table, ids) => { ids.forEach((id) => e.ctx.selectedIds[table].add(id)); e.ctx.updateBulkBar(table); };

test('bulk delete focus: the first row kept at or after the first deleted position gets focus, else the one before it, else the heading', async () => {
  const e = await deleteEnv(['a', 'b', 'c', 'd', 'e'], 'table');
  const { bar, del } = bulkBar(e, 'singles');
  select(e, 'singles', ['b', 'd', 'e']);
  assert.equal(bar.classList.contains('show'), true);
  e.doc.activeElement = del;
  await e.ctx.deleteSelected('singles');
  assert.deepEqual(e.order(), ['a', 'c']);
  assert.deepEqual(e.focusLog, ['name:c'], 'b was the first to go and c took its place');
  assert.equal(bar.classList.contains('show'), false, 'the bar hid');
  assert.notEqual(e.doc.activeElement, del, 'and focus left its Delete button');
  assert.equal(e.ctx.selectedIds.singles.size, 0);
  // the selection ran to the end of the list: the row before the first deleted one
  e.focusLog.length = 0;
  select(e, 'singles', ['c']);
  e.doc.activeElement = del;
  await e.ctx.deleteSelected('singles');
  assert.deepEqual(e.order(), ['a']);
  assert.deepEqual(e.focusLog, ['name:a']);
  // every row: the page heading, made focusable on the spot
  e.focusLog.length = 0;
  select(e, 'singles', ['a']);
  e.doc.activeElement = del;
  await e.ctx.deleteSelected('singles');
  assert.deepEqual(e.order(), []);
  assert.deepEqual(e.focusLog, ['heading']);
  assert.equal(e.heading._attrs.tabindex, '-1');
  // Slabs the same way, and the Holdings rows on a phone
  const s = await deleteEnv(['p1', 'p2', 'p3', 'p4'], 'table', 'slabs');
  select(s, 'slabs', ['p2', 'p3']);
  await s.ctx.deleteSelected('slabs');
  assert.deepEqual(s.focusLog, ['name:p4']);
  const phone = await deleteEnv(['a', 'b', 'c'], 'phone');
  select(phone, 'singles', ['a', 'c']);
  await phone.ctx.deleteSelected('singles');
  assert.deepEqual(phone.focusLog, ['row:b']);
});

test('bulk delete focus: a selection with no row in the drawn list goes to the heading, a cancelled or failed delete leaves focus on the button', async () => {
  const e = await deleteEnv(['a', 'b', 'c'], 'table');
  const { del } = bulkBar(e, 'singles');
  // a selected row that the list does not show (filtered out of view since it was ticked)
  e.ctx.DB.singles.push(single({ id: 'z', name: 'Card z' }));
  select(e, 'singles', ['z']);
  e.doc.activeElement = del;
  await e.ctx.deleteSelected('singles');
  assert.equal(e.ctx.DB.singles.some((r) => r.id === 'z'), false);
  assert.deepEqual(e.order(), ['a', 'b', 'c']);
  assert.deepEqual(e.focusLog, ['heading']);
  assert.deepEqual(plain(e.ctx.kjrBulkDeleteFocusPlan('singles', new Set(['z']))), { table: 'singles', at: -1 }, 'planned as the heading');
  // cancelled: the bar stays, so does focus
  e.focusLog.length = 0;
  select(e, 'singles', ['b']);
  e.ctx.confirm = () => false;
  e.doc.activeElement = del;
  await e.ctx.deleteSelected('singles');
  assert.deepEqual(e.order(), ['a', 'b', 'c']);
  assert.deepEqual(e.focusLog, []);
  assert.equal(e.doc.activeElement, del);
  // the Trash copies could not be made: nothing was removed, the bar and focus stay
  e.ctx.confirm = () => true;
  e.ctx.sendBatchToTrash = async () => false;
  await e.ctx.deleteSelected('singles');
  assert.deepEqual(e.order(), ['a', 'b', 'c']);
  assert.deepEqual(e.focusLog, []);
  assert.equal(e.doc.activeElement, del);
  // plans: Singles and Slabs only, a showing page only, the first deleted position in the drawn order
  assert.equal(e.ctx.kjrBulkDeleteFocusPlan('sales', new Set(['a'])), null);
  assert.deepEqual(plain(e.ctx.kjrBulkDeleteFocusPlan('singles', new Set(['c', 'b']))), { table: 'singles', at: 1 });
  e.page.classList.remove('active');
  assert.equal(e.ctx.kjrBulkDeleteFocusPlan('singles', new Set(['b'])), null);
  const body = appSrc.slice(appSrc.indexOf('async function deleteSelected(table)'), appSrc.indexOf('// =========== COLUMN VISIBILITY & ORDER'));
  assert.match(body, /const focusPlan = typeof kjrBulkDeleteFocusPlan === 'function' \? kjrBulkDeleteFocusPlan\(table, ids\) : null;\n  DB\[table\] = DB\[table\]\.filter\(i => !ids\.has\(i\.id\)\);\n  ids\.clear\(\);/, 'the plan is read just before the rows go');
  assert.match(body, /if \(table === 'sales'\) renderSales\(\);\n  if \(focusPlan && typeof kjrDeleteFocusRestore === 'function'\) kjrDeleteFocusRestore\(focusPlan\);\n  if \(typeof kjrBulkBarFocusRescue === 'function'\) kjrBulkBarFocusRescue\(table\);\n  toast\(count \+ ' moved to trash/, 'and focus is placed right after the redraw');
});

test('bulk bar focus: Delete selected on Sales and Clear anywhere hand focus to the page heading, focus outside the bar is left alone', async () => {
  const app = await loadApp({ seed: makeSeed({ sales: ['x1', 'x2', 'x3'].map((id, n) => ({ id, dateSold: '1 Oct 2026', product: 'Product ' + n, buyer: '', costPrice: 10, totalCollected: 15, shippingCost: 0, fees: 0, channel: 'Carousell', profit: 5 })) }) });
  const doc = app.document;
  const focusLog = [];
  const e = { ctx: app.ctx, doc, focusLog };
  const { bar, del, clear } = bulkBar(e, 'sales');
  const page = doc.getElementById('page-sales');
  page.classList.add('active');
  const heading = { className: 'section-title', tagName: 'DIV', isConnected: true, _attrs: {}, hasAttribute(k) { return k in this._attrs; }, setAttribute(k, v) { this._attrs[k] = v; }, focus() { doc.activeElement = this; focusLog.push('heading'); } };
  page.querySelector = (sel) => (sel === '.section-title' ? heading : null);
  app.ctx.confirm = () => true;
  app.ctx.toast = () => {};
  select(e, 'sales', ['x1', 'x2']);
  doc.activeElement = del;
  await app.ctx.deleteSelected('sales');
  assert.deepEqual(plain(app.ctx.DB.sales.map((r) => r.id)), ['x3']);
  assert.equal(bar.classList.contains('show'), false);
  assert.deepEqual(focusLog, ['heading'], 'Sales has no row rule, so the heading, never the hidden button');
  assert.equal(heading._attrs.tabindex, '-1', 'the Sales heading is made focusable on the spot');
  // Clear hides the bar too
  focusLog.length = 0;
  select(e, 'sales', ['x3']);
  doc.activeElement = clear;
  app.ctx.clearSelection('sales');
  assert.equal(bar.classList.contains('show'), false);
  assert.deepEqual(focusLog, ['heading']);
  // a box ticked off by hand hides the bar with focus on the box: not the bar's business
  focusLog.length = 0;
  const box = { tagName: 'INPUT', focus() {} };
  select(e, 'sales', ['x3']);
  doc.activeElement = box;
  app.ctx.toggleRowSelect('sales', 'x3', false);
  assert.equal(bar.classList.contains('show'), false);
  assert.equal(app.ctx.kjrBulkBarFocusRescue('sales'), false);
  assert.deepEqual(focusLog, []);
  assert.equal(doc.activeElement, box);
  // a bar that still shows keeps its focus
  select(e, 'sales', ['x3']);
  doc.activeElement = clear;
  assert.equal(app.ctx.kjrBulkBarFocusRescue('sales'), false);
  assert.equal(doc.activeElement, clear);
  const rescueSrc = features.slice(features.indexOf('function kjrBulkBarFocusRescue'), features.indexOf('// ── Phone sort.'));
  assert.doesNotMatch(rescueSrc, /markDirty\(|saveData\(|saveAllToSupabase\(|snapshotForUndo\(|DB\.(singles|slabs|sales)\s*=[^=]|localStorage\.setItem|fetch\(/, 'reads and focuses only');
  const clearSrc = appSrc.slice(appSrc.indexOf('function clearSelection(table)'), appSrc.indexOf('function updateBulkBar(table)'));
  assert.match(clearSrc, /updateBulkBar\(table\);\n[^\n]*\n?  if \(typeof kjrBulkBarFocusRescue === 'function'\) kjrBulkBarFocusRescue\(table\);\n\}/);
});

// ══ 3h (bulk, eBay). the eBay bar hands focus to its heading too (v3.78) ═════════════════════════════════
// Clear and Move to next status both end with the selection empty, so the bar hides while keyboard focus sits on the button that was
// pressed. kjrBulkBarFocusRescue knew Singles, Slabs and Sales; the eBay bar (bulk-bar-ebay, page-ebay) was not in KJR_BULK_PAGES, so focus
// was left on a control that is no longer shown. The eBay path stands aside for an open dialog, and Move to next status can open the
// completion modal (kjrOpenCompleteModal), so the rescue runs before that, after the redraw, and the modal's own focus wins from there.
async function ebayBarEnv(rows) {
  const app = await loadApp({ seed: makeSeed({ singles: [], ebayPurchases: rows }) });
  const doc = app.document;
  const focusLog = [];
  const bar = doc.getElementById('bulk-bar-ebay');
  const button = (name) => ({ tagName: 'BUTTON', isConnected: true, name, focus() { doc.activeElement = this; focusLog.push('bar:' + name); }, closest: (sel) => (sel === '.page' ? { id: 'page' } : null) });
  const clear = button('clear');
  const advance = button('advance');
  bar.contains = (el) => el === clear || el === advance;
  const page = doc.getElementById('page-ebay');
  page.classList.add('active');
  const heading = { className: 'section-title', tagName: 'DIV', isConnected: true, _attrs: {}, hasAttribute(k) { return k in this._attrs; }, setAttribute(k, v) { this._attrs[k] = v; }, focus() { doc.activeElement = this; focusLog.push('heading'); } };
  page.querySelector = (sel) => (sel === '.section-title' ? heading : null);
  // the stub document answers every selector with an element, so the open dialog is modelled: the completion dialog, once it is open
  const completion = doc.getElementById('kjr-complete-back');
  doc.querySelector = (sel) => (sel === 'dialog[open]' && completion.open ? completion : null);
  app.ctx.toast = () => {};
  const runFrames = () => { const fns = [...app.rafState.calls.values()]; app.rafState.calls.clear(); fns.forEach((f) => f()); };
  return Object.assign(app, { doc, focusLog, bar, clear, advance, heading, page, completion, runFrames });
}
const ebayRow = (id, status) => ({ id, product: 'Synthetic card ' + id, status, priceUsd: 10, freightSgd: 2, totalSgd: 20, lastUpdated: 1 });
const ebayStatuses = (e) => plain(e.ctx.DB.ebayPurchases.map((r) => r.status));

test('eBay bulk bar focus: Clear, with focus on the Clear button, hands focus to the eBay section title', async () => {
  const e = await ebayBarEnv([ebayRow('e1', 'Paid'), ebayRow('e2', 'At Buyandship')]);
  e.ctx.kjrEbayToggleRow('e1', true);
  e.ctx.kjrEbayToggleRow('e2', true);
  assert.equal(e.bar.classList.contains('show'), true, 'the bar shows while rows are selected');
  e.doc.activeElement = e.clear;
  e.ctx.kjrEbayClearSelection();
  assert.equal(e.bar.classList.contains('show'), false, 'the bar hid');
  assert.deepEqual(e.focusLog, ['heading'], 'focus went to the heading, not left on the hidden Clear button');
  assert.equal(e.heading._attrs.tabindex, '-1', 'made focusable on the spot (the markup has no tabindex on this title)');
  assert.equal(e.doc.activeElement, e.heading);
  assert.equal(e.ctx._kjrEbaySel.size, 0);
  assert.deepEqual(ebayStatuses(e), ['Paid', 'At Buyandship'], 'Clear changes no row');
});

test('eBay bulk bar focus: Move to next status, with no dialog opened, hands focus to the eBay section title too', async () => {
  const e = await ebayBarEnv([ebayRow('e1', 'Paid'), ebayRow('e2', 'At Buyandship')]);
  e.ctx.kjrEbayToggleRow('e1', true);
  e.ctx.kjrEbayToggleRow('e2', true);
  e.doc.activeElement = e.advance;
  e.ctx.kjrEbayBulkAdvanceSelected();
  assert.deepEqual(ebayStatuses(e), ['Shipping to Buyandship', 'Ready to Consolidate'], 'each row moved one step');
  assert.equal(e.bar.classList.contains('show'), false);
  assert.equal(e.completion.open, false, 'no dialog opened');
  assert.deepEqual(e.focusLog, ['heading']);
  assert.equal(e.doc.activeElement, e.heading);
});

test('eBay bulk bar focus: a row ticked off by hand, a bar that still shows and an open dialog all leave focus where it is', async () => {
  const e = await ebayBarEnv([ebayRow('e1', 'Paid'), ebayRow('e2', 'Paid')]);
  // focus on the row's own box when the last tick goes: not the bar's business
  const box = { tagName: 'INPUT', focus() {} };
  e.ctx.kjrEbayToggleRow('e1', true);
  e.doc.activeElement = box;
  e.ctx.kjrEbayToggleRow('e1', false);
  assert.equal(e.bar.classList.contains('show'), false);
  assert.equal(e.ctx.kjrBulkBarFocusRescue('ebay'), false);
  assert.deepEqual(e.focusLog, []);
  assert.equal(e.doc.activeElement, box);
  // the bar still shows (a second row is selected): its button keeps focus
  e.ctx.kjrEbayToggleRow('e1', true);
  e.ctx.kjrEbayToggleRow('e2', true);
  e.doc.activeElement = e.clear;
  assert.equal(e.ctx.kjrBulkBarFocusRescue('ebay'), false);
  assert.equal(e.doc.activeElement, e.clear);
  // a dialog is open when the bar empties: the dialog owns focus, so the eBay path does not touch it
  e.completion.open = true;
  const inDialog = { tagName: 'BUTTON', focus() { e.doc.activeElement = this; e.focusLog.push('dialog'); } };
  e.ctx._kjrEbaySel.clear();
  e.ctx._kjrEbayUpdateBulkBar();
  e.doc.activeElement = inDialog;
  assert.equal(e.ctx._kjrEbayBulkBarFocus(), false);
  e.doc.activeElement = e.clear;
  assert.equal(e.ctx._kjrEbayBulkBarFocus(), false, 'even with focus on the hidden button, while a dialog is open');
  assert.deepEqual(e.focusLog, []);
  assert.equal(e.doc.activeElement, e.clear);
  // the same call without the dialog does hand it over
  e.completion.open = false;
  assert.equal(e.ctx._kjrEbayBulkBarFocus(), true);
  assert.deepEqual(e.focusLog, ['heading']);
});

test('eBay bulk bar focus: when Move to next status opens the completion modal, focus goes to the heading first and the modal gets it back to the heading on close', async () => {
  const e = await ebayBarEnv([ebayRow('e1', 'Shipping to Singapore'), ebayRow('e2', 'Paid')]);
  e.ctx.kjrEbayToggleRow('e1', true);
  e.ctx.kjrEbayToggleRow('e2', true);
  e.doc.activeElement = e.advance;
  e.ctx.kjrEbayBulkAdvanceSelected();
  assert.deepEqual(ebayStatuses(e), ['Shipping to Singapore', 'Shipping to Buyandship'], 'e1 waits for its confirmation, e2 moved');
  assert.equal(e.completion.open, true, 'the completion modal opened for e1');
  assert.deepEqual(e.focusLog, ['heading'], 'the button was not left holding focus, and nothing fought the modal for it');
  // the modal was opened from the heading, so closing it hands focus back to a control that is on screen, not to the hidden button
  e.focusLog.length = 0;
  e.ctx.kjrCloseCompleteModal();
  e.runFrames();
  assert.equal(e.completion.open, false);
  assert.deepEqual(e.focusLog, ['heading']);
  assert.equal(e.doc.activeElement, e.heading);
});

test('eBay bulk bar focus: the wiring is the heading of #page-ebay, called after the bar updates, and it reads and focuses only', () => {
  assert.match(features, /var KJR_BULK_PAGES = \{ singles: 'page-inventory', slabs: 'page-slabs', sales: 'page-sales', ebay: 'page-ebay' \};/);
  assert.match(html, /<div id="page-ebay" class="page">\s*<div class="section-title">eBay Purchases<\/div>/, 'the first .section-title in the page is the heading');
  assert.match(html, /<div class="bulk-bar" id="bulk-bar-ebay">/);
  const clearSrc = features.slice(features.indexOf('function kjrEbayClearSelection()'), features.indexOf('function _kjrEbayUpdateBulkBar()'));
  assert.match(clearSrc, /_kjrEbayUpdateBulkBar\(\);\n[^\n]*\n  _kjrEbayBulkBarFocus\(\);\n\}/);
  const advanceSrc = features.slice(features.indexOf('function kjrEbayBulkAdvance(ids)'), features.indexOf('// Open the confirmation modal for one row.'));
  assert.match(advanceSrc, /renderEbayPurchases\(\);\n[^\n]*\n[^\n]*\n  _kjrEbayBulkBarFocus\(\);\n/);
  assert.ok(advanceSrc.indexOf('_kjrEbayBulkBarFocus();') < advanceSrc.indexOf('kjrOpenCompleteModal('), 'before the completion modal opens, so the modal returns focus to the heading');
  const wrapper = features.slice(features.indexOf('function _kjrEbayBulkBarFocus()'), features.indexOf('function kjrEbayBulkAdvanceSelected()'));
  assert.match(wrapper, /document\.querySelector\('dialog\[open\]'\)/);
  assert.match(wrapper, /return kjrBulkBarFocusRescue\('ebay'\);/);
  assert.doesNotMatch(wrapper, /markDirty\(|saveData\(|saveAllToSupabase\(|snapshotForUndo\(|DB\.[a-zA-Z]+\s*=[^=]|localStorage\.setItem|fetch\(/, 'reads and focuses only');
});

// ══ 3i. a linked row is shown where it is on screen ═════════════════════════════════════════════
// The Dealer Desk's "Open linked Singles/Slabs copy" runs viewSourceItem (app.js), its Sales link and its fallback run
// focusCoreRow (dealer-production-ui.js). Both outline the row for 2.5 seconds after scrolling it to the middle. In the grid the
// row is a tile, on a phone a Holdings row, and the table body can still hold the rows the list drew before the grid was picked
// (hidden, no client rects). A fake page per view: each zone answers [data-id] with its own element, visible or not.
function linkEl(log, id, kind, visible) {
  return {
    tagName: kind === 'tile' ? 'BUTTON' : (kind === 'tr' ? 'TR' : 'DIV'), kind, style: {},
    classList: { contains: (c) => (c === 'kjr-tile' && kind === 'tile') },
    getAttribute: (k) => (k === 'data-id' ? id : null),
    getClientRects: () => (visible ? [{}] : []),
    scrollIntoView(opts) { log.push({ id, kind, behavior: opts && opts.behavior, block: opts && opts.block }); },
  };
}
function linkZones(app, zones) {
  // zones: { zoneId: [el, ...] }. Every other zone of the three tables answers nothing.
  const ids = ['body', 'sold-body', 'grid', 'grid-alt', 'cards', 'sold-cards'].flatMap((z) => ['singles-' + z, 'slabs-' + z]).concat(['sales-body']);
  ids.forEach((zid) => {
    const z = app.document.getElementById(zid);
    const els = zones[zid] || [];
    z.querySelectorAll = (sel) => (sel === '[data-id]' ? els : []);
    z.querySelector = (sel) => els.find((el) => sel === '[data-id="' + el.getAttribute('data-id') + '"]') || null;
  });
}
const newTimers = (app, before, delay) => app.timers.list().filter((t) => !before.has(t.id) && t.delay === delay);
const reduceMotion = (app) => { app.sandbox.matchMedia = (q) => ({ matches: /prefers-reduced-motion: reduce/.test(q), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }); };

test('linked row: viewSourceItem outlines the tile in the grid, never a hidden table row the list left behind, and lets go after 2.5 seconds', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'x', name: 'Card x' })] }), localStorage: { kjr_view_singles: 'grid' } });
  const log = [];
  const stale = linkEl(log, 'x', 'tr', false);
  const tile = linkEl(log, 'x', 'tile', true);
  linkZones(app, { 'singles-body': [stale], 'singles-grid': [tile] });
  const before = new Set(app.timers.list().map((t) => t.id));
  app.ctx.viewSourceItem('x', 'singles');
  const wait = newTimers(app, before, 320);
  assert.equal(wait.length, 1, 'one look, 320ms after the page is drawn');
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(m);
  const beforeFlash = new Set(app.timers.list().map((t) => t.id));
  app.timers.invoke(wait[0].id);
  assert.equal(tile.style.outline, '2px solid var(--accent)', 'the tile on screen is outlined');
  assert.equal(tile.style.outlineOffset, '2px', 'outside the tile, where its card stage cannot paint over it');
  assert.equal(stale.style.outline, undefined, 'the hidden table row is left alone');
  assert.deepEqual(log, [{ id: 'x', kind: 'tile', behavior: 'smooth', block: 'center' }]);
  assert.deepEqual(toasts, []);
  const clear = newTimers(app, beforeFlash, 2500);
  assert.equal(clear.length, 1, 'the same 2.5 seconds as the list');
  app.timers.invoke(clear[0].id);
  assert.equal(tile.style.outline, '');
  assert.equal(tile.style.outlineOffset, '');
});

test('linked row: the list row and the phone Holdings row keep the list outline, reduced motion scrolls without animation, and a row not on screen says so', async () => {
  const app = await loadApp({ seed: makeSeed({ slabs: [slab({ id: 'p1' })] }) });
  const log = [];
  const row = linkEl(log, 'p1', 'tr', true);
  linkZones(app, { 'slabs-body': [row] });
  reduceMotion(app);
  let before = new Set(app.timers.list().map((t) => t.id));
  app.ctx.viewSourceItem('p1', 'slabs');
  app.timers.invoke(newTimers(app, before, 320)[0].id);
  assert.equal(row.style.outline, '2px solid var(--accent)');
  assert.equal(row.style.outlineOffset, '-2px', 'a table row keeps the inset outline it always had');
  assert.deepEqual(log, [{ id: 'p1', kind: 'tr', behavior: 'auto', block: 'center' }], 'reduced motion: no smooth scroll');
  // a phone: the table is hidden, the Holdings row is what shows
  const phone = await loadApp({ seed: makeSeed({ singles: [single({ id: 'x', name: 'Card x' })] }) });
  const plog = [];
  const hiddenRow = linkEl(plog, 'x', 'tr', false);
  const holding = linkEl(plog, 'x', 'row', true);
  linkZones(phone, { 'singles-body': [hiddenRow], 'singles-cards': [holding] });
  before = new Set(phone.timers.list().map((t) => t.id));
  phone.ctx.viewSourceItem('x', 'singles');
  phone.timers.invoke(newTimers(phone, before, 320)[0].id);
  assert.equal(holding.style.outline, '2px solid var(--accent)');
  assert.equal(holding.style.outlineOffset, '-2px');
  assert.equal(hiddenRow.style.outline, undefined);
  assert.deepEqual(plog, [{ id: 'x', kind: 'row', behavior: 'smooth', block: 'center' }]);
  // drawn nowhere that shows (deleted, or filtered out): the toast, and nothing is outlined
  const gone = await loadApp({ seed: makeSeed({ singles: [single({ id: 'x', name: 'Card x' })] }) });
  const glog = [];
  const ghost = linkEl(glog, 'x', 'tr', false);
  linkZones(gone, { 'singles-body': [ghost] });
  const toasts = [];
  gone.ctx.toast = (m) => toasts.push(m);
  before = new Set(gone.timers.list().map((t) => t.id));
  gone.ctx.viewSourceItem('x', 'singles');
  gone.timers.invoke(newTimers(gone, before, 320)[0].id);
  assert.deepEqual(toasts, ['Source item not found (may have been deleted)']);
  assert.equal(ghost.style.outline, undefined);
  assert.deepEqual(glog, []);
  // a second flash on the same row before the first one let go keeps its own 2.5 seconds
  const again = await loadApp();
  const el = linkEl([], 'q', 'tr', true);
  let t0 = new Set(again.timers.list().map((t) => t.id));
  again.ctx.kjrFlashRow(el);
  const first = newTimers(again, t0, 2500);
  t0 = new Set(again.timers.list().map((t) => t.id));
  again.ctx.kjrFlashRow(el);
  assert.equal(again.timers.list().some((t) => t.id === first[0].id), false, 'the first timer is dropped');
  assert.equal(newTimers(again, t0, 2500).length, 1);
  assert.equal(again.ctx.kjrFlashRow(null), false);
  const flashSrc = features.slice(features.indexOf('function kjrRowOnScreen'), features.indexOf('// ── Phone sort.'));
  assert.doesNotMatch(flashSrc, /markDirty\(|saveData\(|saveAllToSupabase\(|snapshotForUndo\(|DB\.(singles|slabs|sales)\s*=[^=]|localStorage\.setItem|fetch\(|\.focus\(/, 'reads, scrolls and styles only, and moves no focus (the list never did)');
});

test('linked row: the Dealer Desk click handler outlines the grid tile and the Sales row through focusCoreRow, with no smooth scroll under reduced motion', async () => {
  const vm = require('node:vm');
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'x', name: 'Card x' })], sales: [{ id: 'y', dateSold: '1 Oct 2026', product: 'Product y', buyer: '', costPrice: 10, totalCollected: 15, shippingCost: 0, fees: 0, channel: 'Carousell', profit: 5 }] }), localStorage: { kjr_view_singles: 'grid' } });
  vm.runInContext(read('dealer-production-ui.js'), app.sandbox, { filename: 'dealer-production-ui.js' });
  const handlers = {};
  const root = { innerHTML: '', addEventListener(type, fn) { handlers[type] = fn; }, contains: () => true, querySelector: () => null, querySelectorAll: () => [] };
  // mount binds the click handler at once, its async tail stops on the stub store and draws the owner gate
  app.ctx.DealerProductionUI.createController({ root, store: { view: () => null } }).mount();
  await app.settle();
  assert.equal(typeof handlers.click, 'function');
  // in the app viewSourceItem takes the Singles and Slabs links, so null it to reach focusCoreRow, the path the Sales link takes
  app.sandbox.viewSourceItem = null;
  const log = [];
  const stale = linkEl(log, 'x', 'tr', false);
  const tile = linkEl(log, 'x', 'tile', true);
  const saleRow = linkEl(log, 'y', 'tr', true);
  linkZones(app, { 'singles-body': [stale], 'singles-grid': [tile], 'sales-body': [saleRow] });
  const link = (page, table, id) => ({ target: { getAttribute: (k) => ({ 'data-navigate-page': page, 'data-ref-table': table, 'data-ref-id': id })[k] || null, hasAttribute: (k) => k === 'data-navigate-page', closest() { return this; } }, preventDefault() {} });
  let before = new Set(app.timers.list().map((t) => t.id));
  await handlers.click(link('inventory', 'singles', 'x'));
  let wait = newTimers(app, before, 320);
  assert.equal(wait.length, 1);
  app.timers.invoke(wait[0].id);
  assert.equal(tile.style.outline, '2px solid var(--accent)', 'the grid tile, not the hidden table row');
  assert.equal(tile.style.outlineOffset, '2px');
  assert.equal(stale.style.outline, undefined);
  assert.deepEqual(log, [{ id: 'x', kind: 'tile', behavior: 'smooth', block: 'center' }]);
  // the Sales link, with reduced motion
  reduceMotion(app);
  log.length = 0;
  before = new Set(app.timers.list().map((t) => t.id));
  await handlers.click(link('sales', 'sales', 'y'));
  wait = newTimers(app, before, 320);
  app.timers.invoke(wait[0].id);
  assert.equal(saleRow.style.outline, '2px solid var(--accent)');
  assert.equal(saleRow.style.outlineOffset, '-2px');
  assert.deepEqual(log, [{ id: 'y', kind: 'tr', behavior: 'auto', block: 'center' }]);
  // a link with no id does nothing at all
  before = new Set(app.timers.list().map((t) => t.id));
  await handlers.click(link('sales', 'sales', ''));
  assert.equal(newTimers(app, before, 320).length, 0);
});

// ══ 4a. the phone sort ══════════════════════════════════════════════════════════════════════════
function fakeSelect(app, table) {
  const options = [];
  const mk = (value, text) => ({ value, textContent: text, disabled: false, remove() { const i = options.indexOf(this); if (i >= 0) options.splice(i, 1); } });
  const sel = { id: table + '-sort', options, value: 'recent', appendChild(o) { options.push(o); return o; } };
  ['recent', 'value-desc', 'value-asc', 'cost-desc', 'name-asc', 'date-desc'].forEach((v) => options.push(mk(v, v)));
  const real = app.document.getElementById.bind(app.document);
  const prev = app.document.getElementById;
  app.document.getElementById = (id) => (id === table + '-sort' ? sel : (prev === real ? real(id) : prev(id)));
  app.document.createElement = (tag) => (tag === 'option' ? mk('', '') : { tagName: String(tag).toUpperCase() });
  return sel;
}

test('phone sort: the select is a labelled, 44px control above the Holdings rows on Singles and Slabs, with the six options, and shown only with the rows', () => {
  for (const [t, label] of [['singles', 'Date bought, newest first'], ['slabs', 'Date listed, newest first']]) {
    const box = html.match(new RegExp('<div class="kjr-hold-sort" id="' + t + '-hold-sort">[\\s\\S]*?</select>\\s*</div>'))[0];
    assert.match(box, new RegExp('<label class="kjr-hold-sort-lbl" for="' + t + '-sort">Sort</label>'));
    assert.match(box, new RegExp('<select class="fi" id="' + t + '-sort" onchange="kjrHoldSortSet\\(\'' + t + '\', this\\.value\\)">'));
    assert.deepEqual([...box.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]),
      [['recent', 'Recently added'], ['value-desc', 'Value high to low'], ['value-asc', 'Value low to high'], ['cost-desc', 'Cost high to low'], ['name-asc', 'Name A to Z'], ['date-desc', label]]);
    const page = html.slice(html.indexOf('<div id="page-' + (t === 'singles' ? 'inventory' : 'slabs') + '"'));
    assert.ok(page.indexOf('id="' + t + '-hold-sort"') > page.indexOf('<table id="' + t + '-table">'), 'after the table');
    assert.ok(page.indexOf('id="' + t + '-hold-sort"') < page.indexOf('id="' + t + '-hold-wrap"'), 'and above the Holdings rows');
  }
  assert.match(section, /\.kjr-hold-sort\{display:none;align-items:center;gap:10px;margin:0 0 8px\}/);
  assert.match(section, /\.kjr-hold-sort select\.fi\{[^}]*min-height:44px\}/);
  assert.match(section, /@media \(max-width: 600px\) \{\s*body:not\(\.force-tables\) \.page\.kjr-hold-on \.kjr-hold-sort\{display:flex\}\s*\}/, 'the same condition that shows the rows');
});

test('phone sort: choosing an option sets sortState column and direction directly and redraws, and anything else changes nothing', async () => {
  const app = await loadApp();
  const { ctx } = app;
  const drew = [];
  ctx.renderSingles = () => drew.push('singles');
  ctx.renderSlabs = () => drew.push('slabs');
  const state = (t) => ({ col: ctx.sortState[t].col, dir: ctx.sortState[t].dir });
  const expectS = { recent: [null, 1], 'value-desc': ['marketPrice', -1], 'value-asc': ['marketPrice', 1], 'cost-desc': ['costPrice', -1], 'name-asc': ['name', 1], 'date-desc': ['datePurchased', -1] };
  for (const [v, [col, dir]] of Object.entries(expectS)) {
    assert.equal(ctx.kjrHoldSortSet('singles', v), true, v);
    assert.deepEqual(state('singles'), { col, dir }, 'singles ' + v);
  }
  assert.deepEqual(drew, new Array(6).fill('singles'));
  drew.length = 0;
  ctx.kjrHoldSortSet('slabs', 'date-desc');
  assert.deepEqual(state('slabs'), { col: 'dateListed', dir: -1 }, 'the slab date column is dateListed');
  assert.deepEqual(drew, ['slabs']);
  // newest first is a descending date, and "recent" is the creation order (no column)
  ctx.kjrHoldSortSet('singles', 'recent');
  assert.equal(ctx.sortState.singles.col, null);
  drew.length = 0;
  for (const bad of ['custom', '', 'nope', undefined, '__proto__']) assert.equal(ctx.kjrHoldSortSet('singles', bad), false, String(bad));
  assert.equal(ctx.kjrHoldSortSet('sales', 'recent'), false, 'only the two lists');
  assert.equal(ctx.kjrHoldSortSet('etbs', 'recent'), false);
  assert.deepEqual(drew, [], 'no redraw');
  assert.deepEqual(state('singles'), { col: null, dir: 1 });
  // the labels per table
  assert.equal(plain(ctx.kjrHoldSortOptions('singles')).find((o) => o.value === 'date-desc').label, 'Date bought, newest first');
  assert.equal(plain(ctx.kjrHoldSortOptions('slabs')).find((o) => o.value === 'date-desc').label, 'Date listed, newest first');
});

test('phone sort: the select shows what the desktop headers last set, as the option that fits or as a disabled Custom entry that goes again when one fits', async () => {
  const app = await loadApp();
  const { ctx } = app;
  const sel = fakeSelect(app, 'singles');
  const set = (col, dir) => { ctx.sortState.singles.col = col; ctx.sortState.singles.dir = dir; };
  const show = () => { assert.equal(ctx.kjrHoldSortSync('singles'), true); return [sel.value, sel.options.length, sel.options.filter((o) => o.value === 'custom').map((o) => o.disabled + ':' + o.textContent)]; };
  set(null, 1);
  assert.deepEqual(show(), ['recent', 6, []]);
  set('marketPrice', -1);
  assert.deepEqual(show(), ['value-desc', 6, []]);
  set('marketPrice', 1);
  assert.deepEqual(show(), ['value-asc', 6, []]);
  set('datePurchased', -1);
  assert.deepEqual(show(), ['date-desc', 6, []]);
  // a header sort with no option, or the other way round: Custom, one entry, disabled
  set('language', 1);
  assert.deepEqual(show(), ['custom', 7, ['true:Custom']]);
  set('costPrice', 1);
  assert.deepEqual(show(), ['custom', 7, ['true:Custom']], 'not a second one');
  set('name', -1);
  assert.deepEqual(show(), ['custom', 7, ['true:Custom']]);
  set('costPrice', -1);
  assert.deepEqual(show(), ['cost-desc', 6, []], 'an option fits again, Custom goes');
  // a stale direction value is read as ascending, not a crash
  set('name', 7);
  assert.equal(ctx.kjrHoldSortValue('singles'), 'name-asc');
  // no select on the page: nothing to do
  const bare = await loadApp();
  bare.document.getElementById = () => null;
  assert.equal(bare.ctx.kjrHoldSortSync('singles'), false);
  // slabs map their own date column
  ctx.sortState.slabs.col = 'dateListed'; ctx.sortState.slabs.dir = -1;
  assert.equal(ctx.kjrHoldSortValue('slabs'), 'date-desc');
  ctx.sortState.slabs.col = 'datePurchased';
  assert.equal(ctx.kjrHoldSortValue('slabs'), 'custom');
});

test('phone sort: every Holdings redraw puts the select in step (the desktop headers can change the sort while the phone layout is up)', async () => {
  const app = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a' }), single({ id: 'b', name: 'Other' })] }) });
  const { ctx } = app;
  const sel = fakeSelect(app, 'singles');
  ctx.kjrHoldOn = () => true;
  ctx.sortState.singles.col = 'costPrice';
  ctx.sortState.singles.dir = -1;
  ctx.renderSingles();
  assert.equal(sel.value, 'cost-desc');
  ctx.sortTable('singles', 'language'); // what a header click does
  assert.equal(sel.value, 'custom');
  ctx.kjrHoldOn = () => false; // a wider window draws no rows and does not touch the select
  ctx.sortState.singles.col = null;
  ctx.renderSingles();
  assert.equal(sel.value, 'custom');
  assert.match(features, /kjrHoldFocusBack\(key, list, alt\);\n  if \(typeof kjrHoldSortSync === 'function'\) kjrHoldSortSync\(table\);/);
});

// ══ 2. holo shine ═══════════════════════════════════════════════════════════════════════════════
function holoEnv(app) {
  const { ctx, sandbox, document: doc } = app;
  const mq = { hover: true, reduced: false };
  sandbox.matchMedia = (q) => ({ matches: q === '(hover: hover) and (pointer: fine)' ? mq.hover : (q === '(prefers-reduced-motion: reduce)' ? mq.reduced : false), media: q, addEventListener() {}, removeEventListener() {} });
  const hosts = {};
  ['dash-top', 'kjr-insp-body', 'kjr-insp-sheet-body'].forEach((id) => { hosts[id] = doc.getElementById(id); hosts[id]._listeners = new Map(); hosts[id]._kjrHoloOn = false; });
  const classes = () => { const set = new Set(); return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), has: set }; };
  const mkArt = () => ({ classList: classes(), style: { props: {}, willChange: '', setProperty(k, v) { this.props[k] = v; }, removeProperty(k) { delete this.props[k]; } } });
  const mkStage = (art, rect) => ({ querySelector: () => art, getBoundingClientRect: () => rect || { left: 100, top: 50, width: 200, height: 300 } });
  const move = (stage, x, y, extra) => ({ type: 'pointermove', pointerType: 'mouse', clientX: x, clientY: y, target: { closest: (sel) => (/kjr-tile-stage|kjr-insp-stage/.test(sel) ? stage : null) }, ...(extra || {}) });
  const frames = () => { const fns = [...app.rafState.calls.values()]; app.rafState.calls.clear(); fns.forEach((f) => f()); return fns.length; };
  return { mq, hosts, mkArt, mkStage, move, frames, ctx };
}

test('holo: listeners attach to the three hosts only with a hover and a fine pointer and no reduced motion, and follow the media queries', async () => {
  const app = await loadApp();
  const h = holoEnv(app);
  const count = (id, t) => (h.hosts[id]._listeners.get(t) || []).length;
  // in the harness nothing matches at load, so nothing was attached
  assert.equal(h.ctx.kjrHoloWanted(), true, 'with the stub says hover');
  h.mq.hover = false;
  assert.equal(h.ctx.kjrHoloSync(), false);
  for (const id of Object.keys(h.hosts)) assert.equal(count(id, 'pointermove') + count(id, 'pointerleave'), 0, id + ': nothing without a hover');
  h.mq.hover = true; h.mq.reduced = true;
  assert.equal(h.ctx.kjrHoloSync(), false);
  for (const id of Object.keys(h.hosts)) assert.equal(count(id, 'pointermove'), 0, id + ': nothing under reduced motion');
  h.mq.reduced = false;
  assert.equal(h.ctx.kjrHoloSync(), true);
  for (const id of Object.keys(h.hosts)) assert.deepEqual([count(id, 'pointermove'), count(id, 'pointerleave')], [1, 1], id + ': one of each');
  h.ctx.kjrHoloSync();
  for (const id of Object.keys(h.hosts)) assert.deepEqual([count(id, 'pointermove'), count(id, 'pointerleave')], [1, 1], id + ': a second sync does not stack');
  // reduced motion switched on while it runs: detached again
  h.mq.reduced = true;
  h.ctx.kjrHoloSync();
  for (const id of Object.keys(h.hosts)) assert.deepEqual([count(id, 'pointermove'), count(id, 'pointerleave')], [0, 0], id);
  assert.deepEqual(plain(h.ctx.KJR_HOLO_HOSTS), ['dash-top', 'kjr-insp-body', 'kjr-insp-sheet-body'], 'the Overview tiles and the two inspector hosts, nothing else');
  // both queries are watched
  assert.match(features, /\[KJR_HOLO_FINE_MQ, KJR_HOLO_REDUCED_MQ\]\.forEach\(function \(q\) \{/);
  assert.match(features, /mq\.addEventListener\('change', kjrHoloSync\)/);
});

test('holo: a move writes the pointer and the lean on the art once a frame, within 6 degrees either way, and clamps outside the stage', async () => {
  const app = await loadApp();
  const h = holoEnv(app);
  h.ctx.kjrHoloSync();
  const art = h.mkArt();
  const stage = h.mkStage(art);
  h.ctx.kjrHoloMove(h.move(stage, 150, 125)); // a quarter in from the left, a quarter down
  h.ctx.kjrHoloMove(h.move(stage, 150, 125));
  assert.equal(h.frames(), 1, 'two moves, one frame');
  assert.deepEqual(plain(art.style.props), { '--kjr-hx': '25%', '--kjr-hy': '25%', '--kjr-ry': '-3deg', '--kjr-rx': '3deg' });
  assert.equal(art.classList.contains('is-holo'), true);
  assert.equal(art.style.willChange, 'transform', 'only while the pointer is on it');
  // the centre is flat, the corners are the limit
  h.ctx.kjrHoloMove(h.move(stage, 200, 200));
  h.frames();
  assert.deepEqual([art.style.props['--kjr-hx'], art.style.props['--kjr-ry'], art.style.props['--kjr-rx']], ['50%', '0deg', '0deg']);
  h.ctx.kjrHoloMove(h.move(stage, 300, 350));
  h.frames();
  assert.deepEqual([art.style.props['--kjr-ry'], art.style.props['--kjr-rx']], ['6deg', '-6deg']);
  for (const [x, y] of [[-5000, -5000], [9000, 9000], [100, 50], [300, 50], [100, 350]]) {
    h.ctx.kjrHoloMove(h.move(stage, x, y));
    h.frames();
    const ry = parseFloat(art.style.props['--kjr-ry']), rx = parseFloat(art.style.props['--kjr-rx']);
    const hx = parseFloat(art.style.props['--kjr-hx']), hy = parseFloat(art.style.props['--kjr-hy']);
    assert.ok(Math.abs(ry) <= 6 && Math.abs(rx) <= 6, 'within 6 degrees at ' + x + ',' + y);
    assert.ok(hx >= 0 && hx <= 100 && hy >= 0 && hy <= 100, 'the pointer stays in 0 to 100% at ' + x + ',' + y);
  }
  // a stage with no size draws nothing, a frame after the pointer left draws nothing
  const flat = h.mkStage(h.mkArt(), { left: 0, top: 0, width: 0, height: 0 });
  h.ctx.kjrHoloMove(h.move(flat, 5, 5));
  assert.doesNotThrow(() => h.frames());
  assert.equal(h.ctx.KJR_HOLO_TILT, 6);
});

test('holo: leaving the stage eases it back (the lean goes, the class goes, will-change goes after the ease), a finger and a stray target do nothing, and the next card releases the last', async () => {
  const app = await loadApp();
  const h = holoEnv(app);
  h.ctx.kjrHoloSync();
  const art = h.mkArt(), stage = h.mkStage(art);
  h.ctx.kjrHoloMove(h.move(stage, 150, 125));
  h.frames();
  // leaving some other element is not leaving the stage
  h.ctx.kjrHoloLeave({ target: art, currentTarget: h.hosts['dash-top'] });
  assert.equal(art.classList.contains('is-holo'), true, 'the art inside the stage is still the same card');
  h.ctx.kjrHoloLeave({ target: stage, currentTarget: h.hosts['dash-top'] });
  assert.equal(art.classList.contains('is-holo'), false);
  assert.equal(art.style.props['--kjr-rx'], undefined);
  assert.equal(art.style.props['--kjr-ry'], undefined);
  assert.equal(art.style.willChange, 'transform', 'kept while it eases back');
  app.timers.flush((t) => t.delay === 320);
  assert.equal(art.style.willChange, '', 'and then released');
  // the host itself being left ends it too
  h.ctx.kjrHoloMove(h.move(stage, 150, 125));
  h.ctx.kjrHoloLeave({ target: h.hosts['dash-top'], currentTarget: h.hosts['dash-top'] });
  assert.equal(art.classList.contains('is-holo'), false);
  // a frame that was waiting when the pointer left draws nothing
  h.ctx.kjrHoloMove(h.move(stage, 150, 125));
  h.ctx.kjrHoloLeave({ target: stage, currentTarget: h.hosts['dash-top'] });
  assert.equal(h.frames(), 0, 'the pending frame was cancelled');
  // a finger has no hover
  const touch = h.mkArt();
  h.ctx.kjrHoloMove(h.move(h.mkStage(touch), 150, 125, { pointerType: 'touch' }));
  assert.equal(touch.classList.contains('is-holo'), false);
  assert.equal(h.frames(), 0);
  // the pointer over something that is not a stage releases
  h.ctx.kjrHoloMove(h.move(stage, 150, 125));
  h.ctx.kjrHoloMove({ type: 'pointermove', pointerType: 'mouse', clientX: 1, clientY: 1, target: { closest: () => null } });
  assert.equal(art.classList.contains('is-holo'), false);
  // moving to the next card releases the first and takes the second
  const art2 = h.mkArt();
  h.ctx.kjrHoloMove(h.move(stage, 150, 125));
  h.ctx.kjrHoloMove(h.move(h.mkStage(art2), 150, 125));
  assert.equal(art.classList.contains('is-holo'), false);
  assert.equal(art2.classList.contains('is-holo'), true);
  assert.equal(art2.style.willChange, 'transform');
  // a stage with no art in it is nothing to light
  h.ctx.kjrHoloMove(h.move({ querySelector: () => null, getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10 }) }, 5, 5));
  assert.equal(art2.classList.contains('is-holo'), false);
  // the selectors name only the Overview tile stage and the inspector stage, so a grid tile or a list row never lights
  assert.equal(h.ctx.KJR_HOLO_STAGE, '.kjr-tile-stage, .kjr-insp-stage');
  assert.equal(h.ctx.KJR_HOLO_ART, '.kjr-tile-art, .kjr-slab, .kjr-insp-card');
  assert.deepEqual(plain(h.ctx.KJR_HOLO_HOSTS).includes('singles-grid'), false);
});

test('holo: the look is declared only inside hover, fine pointer and no reduced motion, on the Overview tiles and the inspector art, with the resting pose kept and no will-change in the file', () => {
  const holo = section.slice(section.indexOf('@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {'));
  assert.ok(holo.startsWith('@media (hover: hover) and (pointer: fine) and (prefers-reduced-motion: no-preference) {'));
  const block = holo.slice(0, holo.indexOf('\n}\n') + 3);
  // everything that draws or moves is in that block, and the selectors are only the tiles under #dash-top's .ov-top and the inspector art
  const selectors = [...block.matchAll(/^\s+([^{}\n]+)\{/gm)].map((m) => m[1].trim()).join(',').split(',').map((s) => s.trim());
  for (const sel of selectors) assert.match(sel, /^(\.ov-top |\.kjr-insp-card|\.kjr-insp-slabwrap )/, sel);
  assert.doesNotMatch(block, /\.kjr-grid|\.kjr-hold|#singles|#slabs|\.kjr-tile\s*\{/, 'not the grid views, not the Holdings rows');
  assert.match(block, /::before\{content:"";position:absolute;inset:0;z-index:2;border-radius:inherit;pointer-events:none;opacity:0;mix-blend-mode:overlay;/);
  assert.match(block, /color-mix\(in srgb,var\(--grader-fg-light\) 55%,transparent\)/, 'a white glare from a token, the same in both themes');
  assert.match(block, /isolation:isolate/);
  assert.match(block, /\.is-holo::before\{opacity:1\}|\.is-holo::before,/);
  // the lean sits on top of what is already there
  assert.match(block, /\.ov-top \.kjr-tile:hover \.kjr-tile-art,\.ov-top \.kjr-tile:hover \.kjr-slab\{transform:translateY\(-4px\) perspective\(700px\) rotateX\(var\(--kjr-rx,0deg\)\) rotateY\(var\(--kjr-ry,0deg\)\)\}/, 'the 4px lift stays');
  assert.match(block, /\.kjr-insp-card\{transform:perspective\(900px\) rotateY\(calc\(-8deg \+ var\(--kjr-ry,0deg\)\)\) rotateX\(calc\(3deg \+ var\(--kjr-rx,0deg\)\)\);transition:transform 0\.16s ease-out\}/, 'the resting pose plus the lean');
  assert.match(block, /\.kjr-insp-slabwrap \.kjr-slab\{transform:perspective\(900px\) rotateX\(var\(--kjr-rx,0deg\)\) rotateY\(var\(--kjr-ry,0deg\)\)\}/);
  assert.doesNotMatch(block, /#inspector|kjr-inspector/, 'the panel itself is never transformed');
  // the pinned resting pose and the reduced-motion pins are untouched
  assert.match(cssRules, /\.kjr-insp-card\{position:relative;width:50%;aspect-ratio:63\/88;[^}]*transform:perspective\(900px\) rotateY\(-8deg\) rotateX\(3deg\)\}/);
  assert.match(cssRules, /@media\(prefers-reduced-motion:reduce\)\{\s*#kjr-inspector,\.kjr-insp-sheet,\.kjr-insp-ib,\.kjr-insp-primary,\.kjr-insp-btn\{transition:none\}\s*\.kjr-insp-sheen\{display:none\}\s*\.kjr-insp-card\{transform:none\}/);
  // and under reduced motion or a coarse pointer the sheen layer is switched off again, in so many words
  assert.match(section, /@media \(prefers-reduced-motion: reduce\), \(pointer: coarse\) \{\s*\.ov-top \.kjr-tile-art::before,\.ov-top \.kjr-slab::before,\.kjr-insp-card::before,\.kjr-insp-slabwrap \.kjr-slab::before\{content:none\}\s*\}/);
  const sinceInspector = css.slice(css.indexOf('/* ═══════════ Card inspector (redesign Step 5, v3.72)')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(sinceInspector, /will-change/, 'the compositing hint is set from script only (the inspector and shell suites pin the same for their sections)');
  assert.match(features, /art\.style\.willChange = 'transform'/);
  assert.match(features, /art\.style\.willChange = ''/);
  // the inspector stage markup the inspector suite pins is untouched
  const art = features.slice(features.indexOf('function kjrInspectArtHtml'), features.indexOf('// The whole panel for one row.'));
  assert.match(art, /<div class="kjr-insp-card">' \+ kjrArtSlot\(st, sz, 'kjr-insp-art'\) \+ '<span class="kjr-insp-sheen" aria-hidden="true"><\/span><\/div>/);
});

// ══ 4b. the rail's long-press labels ════════════════════════════════════════════════════════════
// the long-press and label timers (450ms and 2500ms), apart from whatever the app scheduled at load
const touchTimers = (app) => app.timers.list().filter((x) => x.delay === 450 || x.delay === 2500).map((x) => x.delay);
function touchEnv(app, over) {
  const { ctx, sandbox, document: doc } = app;
  const mq = { none: true };
  sandbox.matchMedia = (q) => ({ matches: q === '(hover: none)' ? mq.none : false, media: q, addEventListener() {}, removeEventListener() {} });
  ctx.kjrRailActive = () => (over && over.rail === false ? false : true);
  const listeners = {};
  const shell = { addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); }, contains: (n) => !!(n && n.inShell) };
  const docL = {};
  doc.addEventListener = (t, fn) => { (docL[t] = docL[t] || []).push(fn); };
  const log = [];
  const show = (el) => log.push('show:' + el.id);
  const hide = () => log.push('hide');
  const controlOf = (e) => (e.target && e.target.isControl ? e.target : null);
  ctx.kjrNavTouchTips(shell, show, hide, controlOf);
  const fire = (t, ev) => { (listeners[t] || []).forEach((fn) => fn(ev)); };
  const fireDoc = (t, ev) => { (docL[t] || []).forEach((fn) => fn(ev)); };
  const control = (id) => ({ id, isControl: true, inShell: true });
  const down = (el, extra) => ({ type: 'pointerdown', pointerType: 'touch', clientX: 10, clientY: 10, target: el, ...(extra || {}) });
  const click = () => ({ type: 'click', defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
  return { mq, listeners, docL, log, fire, fireDoc, control, down, click, timers: app.timers };
}

test('rail touch labels: a long press (450ms) shows the label, hides after 2.5 seconds, and the click that ends it is swallowed so it does not navigate', async () => {
  const app = await loadApp();
  const t = touchEnv(app);
  const nav = t.control('nav-slabs');
  t.fire('pointerdown', t.down(nav));
  assert.deepEqual(touchTimers(app), [450], 'a 450ms timer, nothing shown yet');
  assert.deepEqual(t.log.filter((x) => x.startsWith('show')), []);
  app.timers.flush((x) => x.delay === 450);
  assert.deepEqual(t.log.filter((x) => x.startsWith('show')), ['show:nav-slabs']);
  t.fire('pointerup', { type: 'pointerup' });
  const c = t.click();
  t.fire('click', c);
  assert.equal(c.defaultPrevented, true, 'the click does not navigate');
  assert.equal(c.stopped, true, 'and stops at once, ahead of the listener that hides the bubble, so the label stays');
  const c2 = t.click();
  t.fire('click', c2);
  assert.equal(c2.defaultPrevented, false, 'only the one click is swallowed');
  const before = t.log.filter((x) => x === 'hide').length;
  app.timers.flush((x) => x.delay === 2500);
  assert.equal(t.log.filter((x) => x === 'hide').length, before + 1, 'hidden after about 2.5 seconds');
  assert.deepEqual(touchTimers(app), []);
});

test('rail touch labels: a short tap, a scroll, a mouse and a window with no rail are left alone, and the next touch puts a label away', async () => {
  const app = await loadApp();
  const t = touchEnv(app);
  const nav = t.control('nav-sales');
  // a short tap: the timer is cancelled, nothing shows, the click goes through
  t.fire('pointerdown', t.down(nav));
  t.fire('pointerup', { type: 'pointerup' });
  assert.deepEqual(touchTimers(app), []);
  const tap = t.click();
  t.fire('click', tap);
  assert.deepEqual([tap.defaultPrevented, tap.stopped], [false, false], 'a tap still navigates');
  assert.deepEqual(t.log.filter((x) => x.startsWith('show')), []);
  // a finger that moves more than 10px is scrolling the nav
  t.fire('pointerdown', t.down(nav, { clientX: 10, clientY: 10 }));
  t.fire('pointermove', { type: 'pointermove', clientX: 12, clientY: 14 });
  assert.equal(touchTimers(app).length, 1, 'a small wobble keeps it');
  t.fire('pointermove', { type: 'pointermove', clientX: 10, clientY: 40 });
  assert.deepEqual(touchTimers(app), [], 'a scroll cancels it');
  t.fire('pointercancel', { type: 'pointercancel' });
  // a mouse never starts it
  t.fire('pointerdown', t.down(nav, { pointerType: 'mouse' }));
  assert.deepEqual(touchTimers(app), []);
  // a pointer that is not touch-only (hover is there) is the pointer's tooltip, not this
  t.mq.none = false;
  t.fire('pointerdown', t.down(nav));
  assert.deepEqual(touchTimers(app), []);
  t.mq.none = true;
  // not on a control: nothing
  t.fire('pointerdown', t.down({ id: 'plain', inShell: true }));
  assert.deepEqual(touchTimers(app), []);
  // the next touch hides a label that is up, on the rail or off it
  t.fire('pointerdown', t.down(nav));
  app.timers.flush((x) => x.delay === 450);
  t.log.length = 0;
  t.fire('pointerdown', t.down({ id: 'plain', inShell: true }));
  assert.deepEqual(t.log, ['hide']);
  t.fire('pointerup', { type: 'pointerup' });
  t.fire('pointerdown', t.down(nav));
  app.timers.flush((x) => x.delay === 450);
  t.log.length = 0;
  t.fireDoc('pointerdown', { type: 'pointerdown', pointerType: 'touch', target: { inShell: false } });
  assert.deepEqual(t.log, ['hide'], 'a touch outside the rail');
  // a swallowed click does not survive into the next gesture
  t.fire('pointerup', { type: 'pointerup' });
  t.fire('pointerdown', t.down(nav));
  app.timers.flush((x) => x.delay === 450);
  t.fire('pointerup', { type: 'pointerup' });
  t.fire('pointerdown', t.down({ id: 'plain', inShell: true })); // a new gesture, the long press never produced a click (some browsers do not)
  const later = t.click();
  t.fire('click', later);
  assert.equal(later.defaultPrevented, false);
  // no rail showing (a phone has its header and tab bar): nothing
  const phone = await loadApp();
  const p = touchEnv(phone, { rail: false });
  p.fire('pointerdown', p.down(p.control('x')));
  assert.deepEqual(touchTimers(phone), []);
  // the context menu a long press can raise is suppressed on a touch-only rail, and a mouse right-click keeps its menu
  const ctxApp = await loadApp();
  const q = touchEnv(ctxApp);
  let prevented = 0;
  q.fire('contextmenu', { target: q.control('a'), preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  q.mq.none = false;
  q.fire('contextmenu', { target: q.control('a'), preventDefault() { prevented++; } });
  assert.equal(prevented, 1, 'a mouse right-click on the rail is untouched');
});

test('rail touch labels: it is wired beside the rail tooltip ahead of the click listener that hides it, the pinned tooltip lines are intact, and titled rail controls do not get a second bubble', async () => {
  const src = features.slice(features.indexOf('function kjrNavTipInstall()'), features.indexOf('// ── Phone Holdings rows.'));
  assert.ok(src.indexOf('kjrNavTouchTips(shell, show, hide, controlOf);') > 0);
  assert.ok(src.indexOf('kjrNavTouchTips(shell, show, hide, controlOf);') < src.indexOf("shell.addEventListener('click', hide, true);"), 'registered first, so its stopImmediatePropagation reaches the click first');
  // the lines tests/navigation.test.js pins are still there
  for (const line of ["tip.setAttribute('role', 'tooltip')", "tip.setAttribute('aria-hidden', 'true')", 'document.body.appendChild(tip)', "el.removeAttribute('title')", "lifted.el.setAttribute('title', lifted.title)", "shell.addEventListener('click', hide, true)", "shell.addEventListener('focusin'", ':focus-visible', "e.key === 'Escape'"]) assert.ok(src.includes(line), line);
  assert.match(css, /\.kjr-tip\{position:fixed;z-index:9000;/);
  assert.match(section, /@media \(hover: none\) \{\s*\.topbar \.nav-btn,\.topbar \.kjr-side-search,\.topbar \.kjr-side-add,\.topbar \.logo,\.topbar #sync-indicator,\.topbar #settings-btn\{-webkit-touch-callout:none;-webkit-user-select:none;user-select:none\}\s*\}/);
  // app.js's own long-press bubble (it reads [title]) steps aside for the rail, where Settings and the sync button carry titles
  const app = await loadApp();
  const { ctx, sandbox, document: doc } = app;
  const docL = {};
  doc.addEventListener = (t, fn) => { (docL[t] = docL[t] || []).push(fn); };
  sandbox.matchMedia = (q) => ({ matches: q === '(hover: none)', media: q, addEventListener() {}, removeEventListener() {} });
  ctx.kjrInitTouchTips();
  assert.ok(docL.pointerdown && docL.pointerdown.length === 1, 'the existing bubble listens');
  const titled = (inShell) => ({ getAttribute: () => 'Settings', closest: (s) => (s === '.topbar' ? (inShell ? { id: 'shell' } : null) : null) });
  const press = (el) => docL.pointerdown[0]({ pointerType: 'touch', clientX: 5, clientY: 5, target: { closest: () => el } });
  ctx.kjrRailActive = () => true;
  press(titled(true));
  assert.deepEqual(touchTimers(app), [], 'a titled rail control: no second bubble');
  press(titled(false));
  assert.deepEqual(touchTimers(app), [450], 'a titled control elsewhere still gets it');
  app.timers.flush((x) => x.delay === 450);
  ctx.kjrRailActive = () => false;
  press(titled(true));
  assert.deepEqual(touchTimers(app), [450], 'and on a phone (no rail) the header buttons keep it too');
});
