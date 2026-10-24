'use strict';
// Redesign Step 6b (v3.74): the ⌘K palette, the Search tab of the Quick Entry bar (#cmd-overlay). It finds a card (a single or
// a slab) or runs an action, and the Add Inventory and Log Sale tabs keep working exactly as they did. The harness has no layout
// engine and its document answers every id with a stub, so these tests drive the real handlers (cmdFindSearch, cmdFindKey,
// cmdFindRun, cmdShortcutKey, openCmdBar) and read what they wrote, the way tests/quick-sale-keyboard.test.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, makeSeed, ROOT } = require('./harness.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
const appSrc = fs.readFileSync(ROOT + '/app.js', 'utf8');
const LOCALHOST = {
  protocol: 'http:', hostname: 'localhost', host: 'localhost:3800', href: 'http://localhost:3800/',
  origin: 'http://localhost:3800', pathname: '/', search: '',
};

const single = (o) => Object.assign({}, makeSeed().singles[0], o);
const slab = (o) => Object.assign({
  id: 'slab_1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '12345678', rank: '',
  language: 'EN', costPrice: 520, marketPrice: 610, listPrice: '', dateListed: '3 Jul 2026', status: 'Available',
  notes: '', priceAlert: '', _updatedAt: new Date().toISOString(),
}, o);

// A fresh app with the page's "something is open" probes answering no. The stub document says yes to every selector by default
// (querySelector returns a stub), which would read as an open row menu or nav dropdown and block the shortcut, so each test starts
// from an empty page and adds the one thing it wants to be there.
async function env(seed, opts) {
  const app = await loadApp(Object.assign({ seed: makeSeed(seed) }, opts || {}));
  const doc = app.document;
  const dialogs = [];
  const present = new Set();
  doc.querySelector = (sel) => (present.has(sel) ? { id: 'present', tagName: 'DIV' } : null);
  doc.querySelectorAll = (sel) => (sel === 'dialog[open]' ? dialogs : []);
  doc.activeElement = null;
  const input = doc.getElementById('cmd-find-input');
  const key = (k, extra) => Object.assign({ key: k, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }, extra || {});
  // arrays made inside the sandbox have the sandbox's Array prototype, so they are copied out before they are compared
  const results = () => Array.from(app.ctx.cmdFindResults);
  const search = (text) => { input.value = text; app.ctx.cmdFindSearch(); return results(); };
  const ids = () => results().map((r) => (r.kind === 'card' ? r.table + ':' + r.item.id : r.key));
  const listHtml = () => doc.getElementById('cmd-find-list').innerHTML;
  return Object.assign(app, { dialogs, present, input, key, search, ids, results, listHtml, doc });
}
const FIXTURE = () => ({
  singles: [
    single({ id: 'a1', name: 'Pikachu 25', set: 'Base Set', language: 'EN', condition: 'Near Mint', marketPrice: 30, costPrice: 10, notes: 'from the gengar box' }),
    single({ id: 'a2', name: 'Raichu 26', set: 'Base Set', language: 'JP', condition: 'Lightly Played', marketPrice: 12, costPrice: 4 }),
    single({ id: 'a3', name: 'Pikachu VMAX', set: 'Vivid Voltage', language: 'EN', marketPrice: 60, costPrice: 20, status: 'Sold' }),
    single({ id: 'a4', name: 'Charizard ex 223', set: 'Obsidian Flames', language: 'EN', marketPrice: 0, costPrice: 80 }),
  ],
  slabs: [
    slab({ id: 's1', name: 'Pikachu 25', grader: 'PSA', grade: '10', certNo: '98765432', marketPrice: 400, notes: 'sweet one' }),
    slab({ id: 's2', name: 'Umbreon VMAX 215/203', grader: 'CGC', grade: '9.5', certNo: '4012345', marketPrice: 250 }),
    slab({ id: 's3', name: 'Eevee 173', grader: 'TAG', grade: '10', certNo: 'L6786028', marketPrice: 100, status: 'Sold' }),
  ],
});

// ── the markup ──────────────────────────────────────────────────────────────────────────────
const dialogHtml = html.slice(html.indexOf('<dialog class="cmd-overlay" id="cmd-overlay">'), html.indexOf('<!-- SMART ADD MODAL -->'));

test('markup: Search is the first tab, its panel is an editable combobox over a labelled listbox, and the Add and Sell tabs, panels and ids are as they were', () => {
  const tabs = [...dialogHtml.matchAll(/<button class="cmd-mode-tab[^"]*" id="(cmd-tab-[a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['cmd-tab-find', 'cmd-tab-add', 'cmd-tab-sell'], 'Search first, then the two that were there');
  assert.match(dialogHtml, /id="cmd-tab-find" aria-pressed="false" onclick="setCmdMode\('find'\)">[\s\S]*?Search<\/button>/);
  assert.match(dialogHtml, /<button class="cmd-mode-tab active" id="cmd-tab-add" onclick="setCmdMode\('add'\)">＋ Add Inventory<\/button>/);
  assert.match(dialogHtml, /<button class="cmd-mode-tab" id="cmd-tab-sell" onclick="setCmdMode\('sell'\)">/);
  const input = dialogHtml.match(/<input class="cmd-input" id="cmd-find-input"[^>]*>/)[0];
  assert.match(input, /\brole="combobox"/);
  assert.match(input, /\baria-expanded="false"/);
  assert.match(input, /\baria-controls="cmd-find-list"/);
  assert.match(input, /\baria-autocomplete="list"/);
  assert.match(input, /\baria-label="Search cards and actions"/);
  assert.match(input, /\boninput="cmdFindSearch\(\)"/);
  assert.match(input, /\bonkeydown="cmdFindKey\(event\)"/);
  assert.doesNotMatch(input, /aria-activedescendant/, 'it is set while there is an active option, not before');
  assert.match(dialogHtml, /<div class="cmd-preview" id="cmd-find-list" role="listbox" aria-label="Search results" hidden><\/div>/);
  assert.match(dialogHtml, /<div id="cmd-find-status" class="cmd-empty" role="status" hidden><\/div>/);
  assert.match(dialogHtml, /<span class="sr-only" id="cmd-find-live" role="status" aria-live="polite"><\/span>/);
  assert.match(dialogHtml, /<div id="cmd-find-panel" style="display:none">/);
  // the other two panels keep their ids and their inputs
  for (const id of ['cmd-add-panel', 'cmd-sell-panel', 'cmd-add-input', 'cmd-add-preview', 'cmd-sell-search', 'cmd-sell-preview', 'cmd-sell-status', 'cmd-sell-form', 'cmd-sell-cart-list']) {
    assert.ok(dialogHtml.includes('id="' + id + '"'), id);
  }
  assert.match(dialogHtml, /<input class="cmd-input" id="cmd-sell-search" type="search"/, 'Quick Sale keeps its plain search field');
  assert.doesNotMatch(dialogHtml.slice(dialogHtml.indexOf('id="cmd-sell-search"')), /^[^>]*role="combobox"/);
  const ids = [...html.matchAll(/\sid="(cmd-[^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate cmd- id');
});

test('openers: the sidebar and phone Search open the palette, Add and the tab bar plus keep opening Add Inventory, Log Sale still opens Sell', () => {
  assert.match(html, /<button type="button" class="kjr-side-search" onclick="openCmdBar\('find'\)" aria-label="Search" aria-keyshortcuts="Control\+K Meta\+K">/);
  assert.match(html, /<button type="button" class="kjr-side-add" onclick="openCmdBar\(\)" aria-label="Add">/);
  assert.match(html, /<button class="btb-add" type="button" aria-label="Add" onclick="openCmdBar\(\)">/);
  assert.match(html, /<button class="sheet-item" onclick="closeMoreSheet\(\);openCmdBar\('sell'\)">/);
  assert.equal((html.match(/openCmdBar\('find'\)/g) || []).length, 1, 'one opener asks for Search, the phone header button is that same element');
  assert.match(appSrc, /cmdMode = mode === 'find' \|\| mode === 'sell' \? mode : 'add';/, 'no argument means Add Inventory');
});

// ── the cards ───────────────────────────────────────────────────────────────────────────────
test('cards: every word must match, in any case, over a single\'s name, set, language, condition and notes', async () => {
  const e = await env(FIXTURE());
  assert.deepEqual(e.search('pika').filter((r) => r.kind === 'card').map((r) => r.item.id).sort(), ['a1', 'a3', 's1']);
  assert.deepEqual(e.ids().filter((x) => x.startsWith('singles:') || x.startsWith('slabs:')).sort(), ['singles:a1', 'singles:a3', 'slabs:s1']);
  assert.deepEqual(e.search('PIKACHU base').map((r) => r.item.id), ['a1'], 'two words, both must match, upper case is fine');
  assert.deepEqual(e.search('base jp').map((r) => r.item.id), ['a2'], 'language is searched');
  assert.deepEqual(e.search('lightly played').map((r) => r.item.id), ['a2'], 'and condition');
  assert.deepEqual(e.search('vivid').map((r) => r.item.id), ['a3'], 'and set');
  assert.deepEqual(e.search('gengar').map((r) => r.item.id), ['a1'], 'and notes');
  assert.deepEqual(e.search('pika zzz').filter((r) => r.kind === 'card'), [], 'a word that matches nothing removes the card');
  assert.deepEqual(e.search('  Pikachu   25  ').map((r) => r.item.id).sort(), ['a1', 's1'], 'spaces around and between words do not matter');
});

test('cards: a slab is found by its grader, grade, "grader grade" (glued too), cert number and notes', async () => {
  const e = await env(FIXTURE());
  const cards = (q) => e.search(q).filter((r) => r.kind === 'card').map((r) => r.table + ':' + r.item.id).sort();
  assert.deepEqual(cards('psa'), ['slabs:s1']);
  assert.deepEqual(cards('cgc 9.5'), ['slabs:s2']);
  assert.deepEqual(cards('psa 10'), ['slabs:s1']);
  assert.deepEqual(cards('psa10'), ['slabs:s1'], 'the glued form people type');
  assert.deepEqual(cards('98765432'), ['slabs:s1'], 'cert number');
  assert.deepEqual(cards('l6786028'), ['slabs:s3'], 'cert numbers match in any case');
  assert.deepEqual(cards('sweet'), ['slabs:s1'], 'notes');
  assert.deepEqual(cards('tag 10 eevee'), ['slabs:s3']);
  assert.deepEqual(cards('umbreon cgc'), ['slabs:s2']);
});

test('cards: available ones come before sold ones, then a name that starts with the query, then value, and no more than 8 are shown', async () => {
  const many = [];
  for (let i = 1; i <= 10; i++) many.push(single({ id: 'm' + i, name: 'Mew ' + i, set: 'Set ' + i, marketPrice: i * 10, costPrice: 1 }));
  many.push(single({ id: 'sold-hi', name: 'Mew Sold', status: 'Sold', marketPrice: 999 }));
  many.push(single({ id: 'later', name: 'Super Mew', marketPrice: 500 }));
  const e = await env({ singles: many, slabs: [] });
  const r = e.search('mew');
  const cards = r.filter((x) => x.kind === 'card');
  assert.equal(cards.length, 8, 'the cap');
  assert.equal(cards.some((c) => c.sold), false, 'with 11 available matches, the sold one does not make the 8');
  assert.deepEqual(cards.map((c) => c.item.id), ['m10', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3'], 'names that start with the query, highest value first, and the "Super Mew" that only contains it after them');
  assert.match(e.listHtml(), /Showing the first 8 of 12 matches, keep typing to narrow them/, 'a capped list says so');
  // sold rows are included, after every available one, even when they are worth more or start with the query
  const few = await env({ singles: [single({ id: 'x1', name: 'Mew A', marketPrice: 5 }), single({ id: 'x2', name: 'Mew B', status: 'Sold', marketPrice: 900 }), single({ id: 'x3', name: 'Zed Mew', marketPrice: 1 })], slabs: [] });
  assert.deepEqual(few.search('mew').map((c) => c.item.id), ['x1', 'x3', 'x2']);
  assert.equal(few.search('mew').find((c) => c.item.id === 'x2').sold, true);
  assert.doesNotMatch(few.listHtml(), /Showing the first/, 'not capped, nothing to say');
  // the order is steady: the same query twice gives the same list, ties fall back to name then id
  const tie = await env({ singles: [single({ id: 'b', name: 'Tie', marketPrice: 5 }), single({ id: 'a', name: 'Tie', marketPrice: 5 })], slabs: [] });
  assert.deepEqual(tie.search('tie').map((c) => c.item.id), ['a', 'b']);
});

test('cards: a card option has a thumbnail, its name, a set and language line (a slab, its grader and grade), "Sold" in words, and its value with ~ for an estimate', async () => {
  const e = await env(FIXTURE());
  e.search('pikachu');
  const markup = e.listHtml();
  assert.match(markup, /<div role="group" aria-labelledby="cmd-find-g-cards"><div class="cmd-section-label" id="cmd-find-g-cards" role="presentation">Cards<\/div>/);
  const opt = (id) => markup.match(new RegExp('<div role="option" id="cmd-find-opt-\\d+"[^>]*data-id="' + id + '"[^>]*>[\\s\\S]*?</div>(?=<div role="option"|<div class="cmd-find-more"|</div>)'))[0];
  const a1 = opt('a1');
  assert.match(a1, /class="kjr-art kjr-thumb[^"]*"/, 'kjrThumbHtml');
  assert.match(a1, /<span class="cmd-result-name">Pikachu 25<\/span><span class="cmd-result-meta">Base Set · EN<\/span>/);
  assert.match(a1, /<span class="cmd-find-val">S\$30<\/span>/);
  const a3 = opt('a3');
  assert.match(a3, /<span class="cmd-result-meta">Vivid Voltage · EN · Sold<\/span>/, 'Sold is a word, not only a dimmed thumbnail');
  assert.match(a3, /class="cmd-result[^"]* is-sold"/);
  const s1 = opt('s1');
  assert.match(s1, /kjr-thumb-slab kjr-g-psa/, 'a slab draws its grader bar');
  assert.match(s1, /<span class="cmd-result-meta">PSA 10<\/span>/);
  assert.match(s1, /<span class="cmd-find-val">S\$400<\/span>/);
  // no market price: the cost stands in, and the tilde says so; nothing at all shows a dash
  const est = await env({ singles: [single({ id: 'e1', name: 'Estimate Card', marketPrice: 0, costPrice: 80 }), single({ id: 'e2', name: 'Estimate None', marketPrice: 0, costPrice: 0 })], slabs: [] });
  est.search('estimate');
  assert.match(est.listHtml(), /data-id="e1"[\s\S]*?<span class="cmd-find-val">~S\$80<\/span>/);
  assert.match(est.listHtml(), /data-id="e2"[\s\S]*?<span class="cmd-find-val">-<\/span>/);
  // every card option names its table and id, for the Enter that follows
  assert.match(a1, /data-kind="card" data-table="singles" data-id="a1"/);
  assert.match(s1, /data-kind="card" data-table="slabs" data-id="s1"/);
});

test('cards: every string from a row is escaped, in the name, the set, the id and the "nothing matches" line', async () => {
  const evil = single({ id: 'x"><img src=x onerror=1>', name: '<img src=x onerror=1> & "q"', set: '<b>Set</b>', language: '<EN>', marketPrice: 9 });
  const e = await env({ singles: [evil], slabs: [slab({ id: 'y', name: '<svg onload=1>', grader: '<PSA>', grade: '10', certNo: 'z' })] });
  e.search('img');
  const markup = e.listHtml();
  assert.doesNotMatch(markup, /<img src=x|<b>Set|<svg onload|<PSA>|<EN>/, 'no tag from a field survives');
  assert.match(markup, /&lt;img src=x onerror=1&gt; &amp; &quot;q&quot;/);
  assert.match(markup, /data-id="x&quot;&gt;&lt;img src=x onerror=1&gt;"/);
  assert.doesNotMatch(markup.replace(/"[^"]*"/g, '""'), /<[^>]*\son\w+=[^"]/, 'no handler outside the two the options carry');
  e.search('svg');
  assert.doesNotMatch(e.listHtml(), /<svg onload/);
  // what was typed is shown back in the empty state, as text
  e.search('<b>nope</b>');
  const status = e.doc.getElementById('cmd-find-status');
  assert.equal(status.textContent, 'No cards or actions match "<b>nope</b>"');
  assert.equal(status.hidden, false);
});

// ── the actions ─────────────────────────────────────────────────────────────────────────────
test('actions: with nothing typed only the four core actions show, then a Go to for each of the 14 sidebar pages in sidebar order', async () => {
  const e = await env(FIXTURE());
  const r = e.search('');
  assert.deepEqual(r.map((x) => x.kind), new Array(18).fill('action'), 'no cards without a query');
  assert.deepEqual(e.ids(), ['add-single', 'add-slab', 'quick-entry', 'quick-sale',
    'go-dashboard', 'go-inventory', 'go-slabs', 'go-etbs', 'go-boosterBoxes', 'go-listing', 'go-ebay', 'go-sales', 'go-dealerProduction', 'go-reports', 'go-import', 'go-changelog', 'go-trash', 'go-guide']);
  assert.deepEqual(r.slice(0, 4).map((x) => x.label), ['Add single', 'Add slab', 'Quick entry', 'Quick sale']);
  assert.deepEqual(r.slice(4).map((x) => x.label), ['Go to Overview', 'Go to Singles', 'Go to Slabs', 'Go to ETBs', 'Go to Boxes & packs', 'Go to Listings', 'Go to eBay', 'Go to Sales', 'Go to Dealer Desk', 'Go to Reports', 'Go to Import', 'Go to History', 'Go to Trash', 'Go to Guide']);
  assert.deepEqual(r.slice(4).map((x) => x.page), ['dashboard', 'inventory', 'slabs', 'etbs', 'boosterBoxes', 'listing', 'ebay', 'sales', 'dealerProduction', 'reports', 'import', 'changelog', 'trash', 'guide'], 'the ids showPage takes, the same 14 the sidebar items call');
  const markup = e.listHtml();
  assert.doesNotMatch(markup, /id="cmd-find-g-cards"/, 'no empty Cards group');
  assert.match(markup, /id="cmd-find-g-actions" role="presentation">Actions<\/div>/);
  assert.match(markup, /Go to Boxes &amp; packs/, 'the ampersand is escaped');
  assert.equal((markup.match(/role="option"/g) || []).length, 18);
  assert.match(markup, /id="cmd-find-opt-0" class="cmd-result selected" aria-selected="true"/, 'the first is active');
  assert.equal(e.input.getAttribute('aria-activedescendant'), 'cmd-find-opt-0');
  assert.equal(e.input.getAttribute('aria-expanded'), 'true');
  // the 14 pages are the 14 sidebar items
  const sidebar = [...html.slice(html.indexOf('<nav class="nav"'), html.indexOf('</nav>')).matchAll(/onclick="showPage\('([A-Za-z]+)'\)"/g)].map((m) => m[1]);
  assert.deepEqual(r.slice(4).map((x) => x.page), sidebar);
});

test('actions: a query keeps the actions whose label or keywords match every word, after the cards, in a labelled group of their own', async () => {
  const e = await env(FIXTURE());
  e.search('slab');
  assert.deepEqual(e.ids().filter((id) => !id.includes(':')), ['add-slab', 'go-slabs']);
  e.search('add');
  assert.deepEqual(e.ids().filter((id) => !id.includes(':')), ['add-single', 'add-slab', 'quick-entry']);
  e.search('go to s');
  assert.ok(e.ids().includes('go-sales') && e.ids().includes('go-inventory') && !e.ids().includes('add-single'));
  e.search('sell');
  assert.ok(e.ids().includes('quick-sale'), 'a keyword finds Quick sale');
  e.search('pikachu');
  assert.equal(e.ids().filter((id) => !id.includes(':')).length, 0, 'no action matches a card name');
  assert.doesNotMatch(e.listHtml(), /id="cmd-find-g-actions"/, 'so no Actions group');
  e.search('base set');
  const idx = e.ids();
  assert.ok(idx.every((id) => id.includes(':')), 'only cards here');
  // cards first, then actions
  e.search('charizard slab');
  const kinds = e.results().map((r) => r.kind);
  assert.equal(kinds.join('|'), [...kinds].sort((a, b) => (a === b ? 0 : a === 'card' ? -1 : 1)).join('|'), 'every card before every action');
});

test('empty state: no cards and no actions is a designed line, the list is hidden, the combobox says it is collapsed, and a new query brings it back', async () => {
  const e = await env(FIXTURE());
  e.search('qqqq');
  assert.deepEqual(e.ids(), []);
  assert.equal(e.doc.getElementById('cmd-find-status').textContent, 'No cards or actions match "qqqq"');
  assert.equal(e.doc.getElementById('cmd-find-status').hidden, false);
  assert.equal(e.doc.getElementById('cmd-find-list').hidden, true);
  assert.equal(e.doc.getElementById('cmd-find-list').innerHTML, '');
  assert.equal(e.input.getAttribute('aria-expanded'), 'false');
  assert.equal(e.input.getAttribute('aria-activedescendant'), null);
  assert.equal(e.doc.getElementById('cmd-find-live').textContent, '', 'the status line is the live one here, no second announcement');
  // Enter and the arrows do nothing with no options, and never throw
  e.ctx.cmdFindKey(e.key('Enter'));
  e.ctx.cmdFindKey(e.key('ArrowDown'));
  assert.equal(e.ctx.cmdFindIdx, -1);
  // a long query is cut in the line, not in the box
  e.search('x'.repeat(80));
  assert.equal(e.doc.getElementById('cmd-find-status').textContent, 'No cards or actions match "' + 'x'.repeat(40) + '…"');
  // back to something: shown again, announced with a count
  e.search('pikachu');
  assert.equal(e.doc.getElementById('cmd-find-status').hidden, true);
  assert.equal(e.doc.getElementById('cmd-find-list').hidden, false);
  assert.equal(e.doc.getElementById('cmd-find-live').textContent, '3 results');
  e.search('charizard ex');
  assert.equal(e.doc.getElementById('cmd-find-live').textContent, '1 result');
});

// ── the keyboard in the box ─────────────────────────────────────────────────────────────────
test('keyboard: ArrowDown and ArrowUp move the active option and wrap, Home and End jump, aria-activedescendant and aria-selected follow', async () => {
  const e = await env(FIXTURE());
  e.search('pikachu'); // three cards, nothing else matches
  assert.equal(e.ctx.cmdFindResults.length, 3);
  const active = () => e.listHtml().match(/id="cmd-find-opt-(\d+)" class="cmd-result selected[^"]*" aria-selected="true"/)[1];
  assert.equal(active(), '0');
  const press = (k) => { const ev = e.key(k); e.ctx.cmdFindKey(ev); return ev; };
  assert.equal(press('ArrowDown').defaultPrevented, true);
  assert.equal(e.ctx.cmdFindIdx, 1);
  assert.equal(active(), '1');
  assert.equal(e.input.getAttribute('aria-activedescendant'), 'cmd-find-opt-1');
  press('ArrowDown'); press('ArrowDown');
  assert.equal(e.ctx.cmdFindIdx, 0, 'past the last wraps to the first');
  press('ArrowUp');
  assert.equal(e.ctx.cmdFindIdx, 2, 'before the first wraps to the last');
  assert.equal(e.input.getAttribute('aria-activedescendant'), 'cmd-find-opt-2');
  press('Home');
  assert.equal(e.ctx.cmdFindIdx, 0);
  press('End');
  assert.equal(e.ctx.cmdFindIdx, 2);
  assert.equal((e.listHtml().match(/aria-selected="true"/g) || []).length, 1, 'exactly one is selected');
  assert.equal((e.listHtml().match(/aria-selected="false"/g) || []).length, 2);
  // a key that is not ours is left alone, and so is a keystroke while an IME is composing
  assert.equal(press('a').defaultPrevented, false);
  const composing = e.key('ArrowDown', { isComposing: true });
  e.ctx.cmdFindKey(composing);
  assert.equal(composing.defaultPrevented, false);
  assert.equal(e.ctx.cmdFindIdx, 2);
  // typing again starts from the first option
  e.search('pika');
  assert.equal(e.ctx.cmdFindIdx, 0);
});

test('keyboard: when the option nodes exist the active one moves without redrawing the list (no thumbnail reloads), and scrolls into view', async () => {
  const e = await env(FIXTURE());
  e.search('pikachu');
  const nodes = [0, 1, 2].map((i) => {
    const classes = new Set(i === 0 ? ['cmd-result', 'selected'] : ['cmd-result']);
    return { attrs: { 'aria-selected': i === 0 ? 'true' : 'false' }, scrolled: 0, classList: { toggle(c, on) { if (on) classes.add(c); else classes.delete(c); }, has: (c) => classes.has(c) },
      setAttribute(k, v) { this.attrs[k] = v; }, scrollIntoView(o) { this.scrolled++; this.opts = o; } };
  });
  const list = e.doc.getElementById('cmd-find-list');
  const before = list.innerHTML;
  list.querySelectorAll = (sel) => (sel === '[role="option"]' ? nodes : []);
  e.ctx.cmdFindKey(e.key('ArrowDown'));
  assert.equal(list.innerHTML, before, 'the markup is untouched');
  assert.deepEqual(nodes.map((n) => n.attrs['aria-selected']), ['false', 'true', 'false']);
  assert.deepEqual(nodes.map((n) => n.classList.has('selected')), [false, true, false]);
  assert.equal(nodes[1].scrolled, 1);
  assert.equal(JSON.stringify(nodes[1].opts), '{"block":"nearest"}');
  assert.equal(e.input.getAttribute('aria-activedescendant'), 'cmd-find-opt-1');
});

// ── running an option ───────────────────────────────────────────────────────────────────────
test('Enter on a card opens the page and then the inspector for that card, with the opener as where focus goes back, and closes the bar once it is up', async () => {
  const e = await env(FIXTURE());
  const calls = [];
  e.ctx.showPage = (p) => calls.push(['showPage', p]);
  e.ctx.kjrInspect = (t, id, o) => { calls.push(['kjrInspect', t, id, o]); return true; };
  e.ctx.closeCmdBar = () => calls.push(['closeCmdBar']);
  const opener = { id: 'opener', isConnected: true, focus() {}, getClientRects: () => [{}] };
  e.doc.activeElement = opener;
  e.ctx.openCmdBar('find');
  e.search('pikachu 25');
  const slabIdx = e.ctx.cmdFindResults.findIndex((r) => r.table === 'slabs');
  const singleIdx = e.ctx.cmdFindResults.findIndex((r) => r.table === 'singles');
  assert.ok(slabIdx >= 0 && singleIdx >= 0);
  e.ctx.cmdFindIdx = singleIdx;
  e.ctx.cmdFindKey(e.key('Enter'));
  assert.deepEqual(calls.map((c) => c[0]), ['showPage', 'kjrInspect', 'closeCmdBar'], 'the page, then the card, then the bar');
  assert.deepEqual(calls[0], ['showPage', 'inventory']);
  assert.equal(calls[1][1], 'singles');
  assert.equal(calls[1][2], 'a1');
  assert.equal(calls[1][3].trigger, opener, 'focus goes back to what had it before the palette opened');
  // a slab goes to the Slabs page
  calls.length = 0;
  e.ctx.cmdFindRun(slabIdx);
  assert.deepEqual(calls[0], ['showPage', 'slabs']);
  assert.deepEqual([calls[1][1], calls[1][2]], ['slabs', 's1']);
  // a click runs the same option the Enter would
  calls.length = 0;
  assert.match(e.listHtml(), new RegExp('id="cmd-find-opt-' + singleIdx + '"[^>]*onclick="cmdFindRun\\(' + singleIdx + '\\)"'));
  assert.match(e.listHtml(), /onmousedown="event\.preventDefault\(\)"/, 'a press does not take focus out of the box');
});

test('Enter on a card with nothing focused beforehand hands the inspector the sidebar item for the card\'s page', async () => {
  const e = await env(FIXTURE());
  const navSingles = { id: 'nav-singles', isConnected: true, focus() {}, getAttribute: (k) => (k === 'onclick' ? "showPage('inventory')" : null), getClientRects: () => [{}] };
  const navSlabs = { id: 'nav-slabs', isConnected: true, focus() {}, getAttribute: (k) => (k === 'onclick' ? "showPage('slabs')" : null), getClientRects: () => [{}] };
  const hiddenSingles = { id: 'hidden', isConnected: true, focus() {}, getAttribute: (k) => (k === 'onclick' ? "showPage('inventory')" : null), getClientRects: () => [] };
  e.doc.querySelectorAll = (sel) => (sel === '.nav-btn, .btb-item' ? [hiddenSingles, navSingles, navSlabs] : (sel === 'dialog[open]' ? [] : []));
  const trig = [];
  e.ctx.showPage = () => {};
  e.ctx.kjrInspect = (t, id, o) => { trig.push(o.trigger && o.trigger.id); return true; };
  e.ctx.closeCmdBar = () => {};
  e.search('pikachu 25');
  e.ctx.cmdFindRun(e.ctx.cmdFindResults.findIndex((r) => r.table === 'singles'));
  e.ctx.cmdFindRun(e.ctx.cmdFindResults.findIndex((r) => r.table === 'slabs'));
  assert.deepEqual(trig, ['nav-singles', 'nav-slabs'], 'the visible item for each page, a hidden one (the phone has no sidebar) is passed over');
  // nothing usable at all: no trigger, and kjrInspect falls back to whatever has focus
  e.doc.querySelectorAll = () => [];
  trig.length = 0;
  e.ctx.kjrInspect = (t, id, o) => { trig.push(Object.keys(o).length); return true; };
  e.ctx.cmdFindRun(e.ctx.cmdFindResults.findIndex((r) => r.table === 'singles'));
  assert.deepEqual(trig, [0]);
});

// v3.88: the phone's Collection tab holds Slabs, ETBs and Boxes & packs (TAB_HELD_BY), so More does not light for them, and a slab card
// found in the palette used to hand focus back to More, a tab that is not lit for it. It goes to the tab that holds the page now.
test('the inspector\'s way back for a page the Collection tab holds is that tab on a phone, and More only for a page no tab holds', async () => {
  const e = await env(FIXTURE());
  const item = (id, onclick, shown) => ({ id, isConnected: true, focus() {}, getAttribute: (k) => (k === 'onclick' ? onclick : null), getClientRects: () => (shown === false ? [] : [{}]) });
  const dashboard = item('btb-dashboard', "showPage('dashboard')");
  const collection = item('btb-inventory', "showPage('inventory')");
  const sales = item('btb-sales', "showPage('sales')");
  const more = item('btb-more', 'openMoreSheet()');
  // a phone: the sidebar is not on screen (no client rects), the bar has four tabs and More has no onclick naming a page
  const sidebar = [item('nav-singles', "showPage('inventory')", false), item('nav-slabs', "showPage('slabs')", false), item('nav-etbs', "showPage('etbs')", false)];
  const bar = [dashboard, collection, sales, more];
  e.doc.querySelectorAll = (sel) => (sel === '.nav-btn, .btb-item' ? sidebar.concat(bar) : []);
  const realGet = e.doc.getElementById.bind(e.doc);
  e.doc.getElementById = (id) => (id === 'btb-more' ? more : realGet(id));
  e.ctx._cmdOpener = null;
  const id = (el) => (el ? el.id : null);
  for (const page of ['slabs', 'etbs', 'boosterBoxes', 'boosterPacks']) assert.equal(id(e.ctx._cmdFindTrigger(page)), 'btb-inventory', page + ': the Collection tab, which showPage lights for it');
  assert.equal(id(e.ctx._cmdFindTrigger('inventory')), 'btb-inventory', 'Singles: its own tab, as before');
  assert.equal(id(e.ctx._cmdFindTrigger('dashboard')), 'btb-dashboard');
  assert.equal(id(e.ctx._cmdFindTrigger('sales')), 'btb-sales');
  for (const page of ['guide', 'ebay', 'listing', 'reports', 'import', 'changelog', 'trash']) assert.equal(id(e.ctx._cmdFindTrigger(page)), 'btb-more', page + ': no tab holds it, More reaches it');
  assert.equal(e.ctx._cmdFindTrigger('nowhere'), null, 'a name that is no page has no way back');

  // it is read from TAB_HELD_BY, not from a list of its own: point Slabs at Sales and the answer follows
  const held = e.ctx.TAB_HELD_BY.slabs;
  e.ctx.TAB_HELD_BY.slabs = 'sales';
  assert.equal(id(e.ctx._cmdFindTrigger('slabs')), 'btb-sales');
  e.ctx.TAB_HELD_BY.slabs = held;
  assert.equal(id(e.ctx._cmdFindTrigger('slabs')), 'btb-inventory');

  // a shell with no Collection tab: More is not the answer for a page More does not light for
  bar.splice(bar.indexOf(collection), 1);
  assert.equal(e.ctx._cmdFindTrigger('slabs'), null, 'nothing, and kjrInspect falls back to whatever has focus');
  assert.equal(id(e.ctx._cmdFindTrigger('guide')), 'btb-more', 'while a page only More reaches still gets it');
  bar.splice(1, 0, collection);

  // the order is unchanged above it: what had focus before the bar opened, then the page's own visible item (a tablet's rail, a desktop's sidebar)
  const rail = item('rail-slabs', "showPage('slabs')");
  sidebar.push(rail);
  assert.equal(id(e.ctx._cmdFindTrigger('slabs')), 'rail-slabs', 'the page\'s own item beats the tab that holds it');
  const opener = item('opener', null);
  e.ctx._cmdOpener = opener;
  assert.equal(e.ctx._cmdFindTrigger('slabs'), opener, 'and what had focus before the bar opened beats both');
  e.ctx._cmdOpener = null;
  sidebar.pop();

  // end to end: Enter on a slab hands kjrInspect the Collection tab as the trigger
  const trig = [];
  e.ctx.showPage = () => {};
  e.ctx.kjrInspect = (t, cardId, o) => { trig.push([t, id(o.trigger)]); return true; };
  e.ctx.closeCmdBar = () => {};
  e.search('pikachu 25');
  e.ctx.cmdFindRun(e.ctx.cmdFindResults.findIndex((r) => r.table === 'slabs'));
  e.ctx.cmdFindRun(e.ctx.cmdFindResults.findIndex((r) => r.table === 'singles'));
  assert.deepEqual(trig, [['slabs', 'btb-inventory'], ['singles', 'btb-inventory']]);
});

test('Enter on a card: the bar closes after the card is up, not before, so the modal stack never empties and the bar\'s history entry is reused', async () => {
  // the order is a choice for fewer history moves (a narrow window opens the inspector as a dialog): pin it, with the reason
  const body = appSrc.slice(appSrc.indexOf('function _cmdFindOpenCard(r)'), appSrc.indexOf('// ── ADD MODE'));
  const i = (s) => body.indexOf(s);
  assert.ok(i('showPage(page)') > 0 && i('showPage(page)') < i('kjrInspect(table') && i('kjrInspect(table') < i('closeCmdBar()'), 'showPage, kjrInspect, then closeCmdBar');
  assert.match(body, /the modal stack never empties/);
  assert.match(body, /closing the bar first\n\s+\/\/ would work too/, 'the controller copes with either order now (tests/modal-controller.test.js)');
  // and the same for the two forms
  const run = appSrc.slice(appSrc.indexOf('function cmdFindRun(idx)'), appSrc.indexOf('function _cmdFindOpenCard(r)'));
  assert.match(run, /openAddSingle\(opts\); closeCmdBar\(\)/);
  assert.match(run, /openAddSlab\(opts\); closeCmdBar\(\)/);
  // after the bar has closed, focus goes to the inspector's title a frame later (the controller restores the opener a frame after a close)
  const e = await env(FIXTURE());
  const focused = [];
  e.ctx.showPage = () => {};
  e.ctx.kjrInspect = () => true;
  e.ctx.closeCmdBar = () => {};
  e.ctx.kjrInspectFocusTitle = () => focused.push('title');
  e.ctx._kjrInsp = { table: 'singles' };
  e.search('pikachu 25');
  const before = [...e.rafState.calls.keys()].length;
  e.ctx.cmdFindRun(0);
  assert.equal(e.rafState.calls.size, before + 1, 'one frame callback');
  [...e.rafState.calls.values()].forEach((fn) => fn());
  assert.deepEqual(focused, ['title']);
  // an inspector that did not open leaves focus alone
  focused.length = 0;
  e.ctx.kjrInspect = () => false;
  e.rafState.calls.clear();
  e.ctx.cmdFindRun(0);
  assert.equal(e.rafState.calls.size, 0);
});

test('actions run: Add single and Add slab open their form and then close the bar, Go to closes the bar and then shows the page, Quick entry and Quick sale switch tab', async () => {
  const e = await env(FIXTURE());
  const calls = [];
  e.ctx.openAddSingle = (o) => calls.push(['openAddSingle', o]);
  e.ctx.openAddSlab = (o) => calls.push(['openAddSlab', o]);
  e.ctx.closeCmdBar = () => calls.push(['closeCmdBar']);
  e.ctx.showPage = (p) => calls.push(['showPage', p]);
  e.ctx.setCmdMode = (m) => calls.push(['setCmdMode', m]);
  const opener = { id: 'o', isConnected: true, focus() {} };
  e.doc.activeElement = opener;
  e.ctx.openCmdBar('find');
  e.ctx.setCmdMode = (m) => calls.push(['setCmdMode', m]); // openCmdBar called the real one, from here the stub counts
  e.search('');
  const run = (key) => { calls.length = 0; e.ctx.cmdFindRun(e.ctx.cmdFindResults.findIndex((r) => r.key === key)); return calls.map((c) => c.slice()); };
  const single1 = run('add-single');
  assert.deepEqual(single1.map((c) => c[0]), ['openAddSingle', 'closeCmdBar'], 'the form first, then the bar goes');
  assert.equal(single1[0][1].trigger, opener, 'and the form hands focus back to what opened the bar');
  assert.deepEqual(run('add-slab').map((c) => c[0]), ['openAddSlab', 'closeCmdBar']);
  assert.deepEqual(run('go-reports'), [['closeCmdBar'], ['showPage', 'reports']]);
  assert.deepEqual(run('go-boosterBoxes'), [['closeCmdBar'], ['showPage', 'boosterBoxes']]);
  assert.deepEqual(run('quick-entry'), [['setCmdMode', 'add']], 'the bar stays open, on the Add tab');
  assert.deepEqual(run('quick-sale'), [['setCmdMode', 'sell']]);
  // an index that is not on screen does nothing
  calls.length = 0;
  e.ctx.cmdFindRun(99);
  e.ctx.cmdFindRun(-1);
  assert.deepEqual(calls, []);
});

test('the forms take the palette\'s opener as their trigger: openModal passes its options to the controller and the two Add forms pass theirs on', () => {
  assert.match(appSrc, /function openModal\(id, opts\) \{\n  const el = document\.getElementById\(id\);\n  if \(el && el\.tagName === 'DIALOG'\) kjrModalCtrl\.open\(el, opts\);/);
  assert.match(appSrc, /function openAddSingle\(opts\) \{[\s\S]*?openModal\('modal-single', opts\);\n\}/);
  assert.match(appSrc, /function openAddSlab\(opts\) \{[\s\S]*?openModal\('modal-slab', opts\);\n\}/);
});

// ── opening and closing ─────────────────────────────────────────────────────────────────────
test('open: ⌘K opens Search, a second open only switches mode (one entry on the modal stack), and the opener is the controller\'s trigger', async () => {
  const e = await env(FIXTURE());
  const dlg = e.doc.getElementById('cmd-overlay');
  const opens = [];
  const realOpen = e.ctx.kjrModalCtrl.open;
  e.ctx.kjrModalCtrl.open = (d, o) => { opens.push(o); return realOpen(d, o); };
  const opener = { id: 'btn', isConnected: true, focus() {} };
  e.doc.activeElement = opener;
  e.ctx.openCmdBar('find');
  assert.equal(dlg.open, true);
  assert.equal(e.ctx.cmdMode, 'find');
  assert.equal(opens.length, 1);
  assert.equal(opens[0].trigger, opener);
  assert.equal(typeof opens[0].onClose, 'function', 'the Search box is cleared on every close path');
  e.ctx.openCmdBar('find');
  e.ctx.openCmdBar('add');
  e.ctx.openCmdBar('sell');
  e.ctx.openCmdBar();
  assert.equal(opens.length, 1, 'no second open, so no second stack entry');
  assert.equal(e.ctx.cmdMode, 'add', 'but the mode did switch (no argument is Add Inventory)');
  // closing it once leaves the controller with nothing, a later open is a first open again
  e.ctx.closeCmdBar();
  assert.equal(dlg.open, false);
  e.ctx.openCmdBar('sell');
  assert.equal(opens.length, 2);
  assert.equal(e.ctx.cmdMode, 'sell');
  // the three tabs and panels follow the mode, and a tab says so with aria-pressed as well as with its look
  const state = () => ['find', 'add', 'sell'].map((m) => [e.doc.getElementById('cmd-tab-' + m).classList.contains('active'), e.doc.getElementById('cmd-tab-' + m).getAttribute('aria-pressed'), e.doc.getElementById('cmd-' + m + '-panel').style.display]);
  assert.deepEqual(state(), [[false, 'false', 'none'], [false, 'false', 'none'], [true, 'true', '']]);
  e.ctx.setCmdMode('find');
  assert.deepEqual(state(), [[true, 'true', ''], [false, 'false', 'none'], [false, 'false', 'none']]);
  e.ctx.setCmdMode('add');
  assert.deepEqual(state(), [[false, 'false', 'none'], [true, 'true', ''], [false, 'false', 'none']]);
});

test('open: with nothing focused the control that was clicked is the opener (Safari does not focus a button), and a field or the page body is not', async () => {
  const e = await env(FIXTURE());
  const opens = [];
  const realOpen = e.ctx.kjrModalCtrl.open;
  e.ctx.kjrModalCtrl.open = (d, o) => { opens.push(o.trigger); return realOpen(d, o); };
  const clicked = { id: 'search-btn', isConnected: true, focus() {} };
  e.sandbox.event = { currentTarget: clicked };
  e.doc.activeElement = e.doc.body;
  e.ctx.openCmdBar('find');
  assert.equal(opens[0], clicked);
  e.ctx.closeCmdBar();
  // a stale or disconnected control is not used
  e.sandbox.event = { currentTarget: { isConnected: false, focus() {} } };
  e.ctx.openCmdBar('find');
  assert.equal(opens[1], undefined, 'the controller then falls back to document.activeElement itself');
  delete e.sandbox.event;
});

test('close: Esc, a tap on the backdrop and closeCmdBar all clear the Search box and its results, and leave the Add draft as each already did', async () => {
  const e = await env(FIXTURE());
  const dlg = e.doc.getElementById('cmd-overlay');
  const addInput = e.doc.getElementById('cmd-add-input');
  const cleared = () => ({ value: e.input.value, results: e.ctx.cmdFindResults.length, idx: e.ctx.cmdFindIdx, list: e.doc.getElementById('cmd-find-list').innerHTML, expanded: e.input.getAttribute('aria-expanded'), ad: e.input.getAttribute('aria-activedescendant'), listHidden: e.doc.getElementById('cmd-find-list').hidden, status: e.doc.getElementById('cmd-find-status').textContent });
  const empty = { value: '', results: 0, idx: -1, list: '', expanded: 'false', ad: null, listHidden: true, status: '' };
  for (const how of ['esc', 'backdrop', 'closeCmdBar']) {
    e.ctx.openCmdBar('find');
    e.search('pikachu');
    addInput.value = 'a draft line';
    assert.ok(e.ctx.cmdFindResults.length > 0);
    if (how === 'esc') dlg.dispatchEvent({ type: 'cancel', preventDefault() {} });
    else if (how === 'backdrop') dlg.dispatchEvent({ type: 'click', target: dlg });
    else e.ctx.closeCmdBar();
    assert.equal(dlg.open, false, how + ': closed');
    assert.deepEqual(cleared(), empty, how + ': Search is back to nothing');
    // Add keeps its own rule: Esc and a backdrop tap leave the draft, closeCmdBar (after a save or a sale) clears it
    assert.equal(addInput.value, how === 'closeCmdBar' ? '' : 'a draft line', how + ': the Add draft');
    addInput.value = '';
  }
  // reopened, it is the default list again
  e.ctx.openCmdBar('find');
  assert.equal(e.ctx.cmdFindResults.length, 18);
  assert.equal(e.input.value, '');
});

test('Dealer preview guard: the palette does not open there, by the button or by the key', async () => {
  const e = await env(FIXTURE(), { location: LOCALHOST });
  e.sandbox.__KJR_DEALER_PREVIEW__ = true;
  e.sandbox.__KJR_DEALER_PREVIEW_RESTRICT_NAV__ = true;
  const dlg = e.doc.getElementById('cmd-overlay');
  e.ctx.openCmdBar('find');
  assert.equal(dlg.open, false);
  const ev = e.key('k', { ctrlKey: true });
  e.ctx.cmdShortcutKey(ev);
  assert.equal(dlg.open, false);
  assert.equal(ev.defaultPrevented, true, 'the browser\'s own Ctrl+K stays suppressed, as before');
  e.sandbox.__KJR_DEALER_PREVIEW__ = false;
  e.ctx.cmdShortcutKey(e.key('k', { ctrlKey: true }));
  assert.equal(dlg.open, true, 'and it opens as soon as the guard is off');
});

// ── Ctrl+K and Cmd+K ────────────────────────────────────────────────────────────────────────
test('shortcut: Ctrl+K and Cmd+K open Search in any case, and only for those keys', async () => {
  const e = await env(FIXTURE());
  const dlg = e.doc.getElementById('cmd-overlay');
  const press = (k, extra) => { const ev = e.key(k, extra); e.ctx.cmdShortcutKey(ev); const opened = dlg.open; if (opened) e.ctx.closeCmdBar(); return { opened, prevented: ev.defaultPrevented }; };
  assert.deepEqual(press('k', { ctrlKey: true }), { opened: true, prevented: true });
  assert.deepEqual(press('k', { metaKey: true }), { opened: true, prevented: true });
  assert.deepEqual(press('K', { ctrlKey: true }), { opened: true, prevented: true }, 'Caps Lock or Shift');
  assert.deepEqual(press('K', { metaKey: true, shiftKey: true }), { opened: true, prevented: true });
  assert.deepEqual(press('k', {}), { opened: false, prevented: false }, 'a plain k is typing');
  assert.deepEqual(press('j', { ctrlKey: true }), { opened: false, prevented: false });
  assert.deepEqual(press('k', { ctrlKey: true, altKey: true }), { opened: false, prevented: false });
  assert.deepEqual(press('k', { ctrlKey: true, isComposing: true }), { opened: false, prevented: false });
  assert.equal(press('k', { ctrlKey: true, defaultPrevented: true }).opened, false, 'something else already took it');
  assert.equal(e.ctx.cmdFindResults.length, 0, 'closed again, nothing left in the box');
  e.ctx.cmdShortcutKey(e.key('k', { ctrlKey: true }));
  assert.equal(e.ctx.cmdMode, 'find', 'the shortcut asks for Search, not Add Inventory');
  assert.equal(e.ctx.cmdFindResults.length, 18, 'and the default list is up');
  assert.match(appSrc, /document\.addEventListener\('keydown', cmdShortcutKey\);/);
});

test('shortcut: it does nothing while focus is in an input, a textarea, a select or an editable region, and does not take the key from them', async () => {
  const e = await env(FIXTURE());
  const dlg = e.doc.getElementById('cmd-overlay');
  const fields = [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }];
  for (const field of fields) {
    for (const where of ['target', 'activeElement']) {
      e.doc.activeElement = where === 'activeElement' ? field : null;
      const ev = e.key('k', { ctrlKey: true, target: where === 'target' ? field : null });
      e.ctx.cmdShortcutKey(ev);
      assert.equal(dlg.open, false, field.tagName + ' as ' + where);
      assert.equal(ev.defaultPrevented, false, 'the field keeps its Ctrl+K');
    }
  }
  e.doc.activeElement = { tagName: 'BUTTON' };
  e.ctx.cmdShortcutKey(e.key('k', { ctrlKey: true, target: { tagName: 'BUTTON' } }));
  assert.equal(dlg.open, true, 'a button is not a field');
});

test('shortcut: it does nothing while a dialog, the API settings overlay, a row menu or a nav dropdown is up, or before sign-in', async () => {
  const cases = [
    ['an open dialog (the inspector sheet, a form, the confirm box or this bar)', (e) => e.dialogs.push({ id: 'modal-single' })],
    ['the API settings overlay', (e) => e.present.add('#api-key-modal')],
    ['an open nav dropdown (Settings)', (e) => e.present.add('.nav-dd.open')],
    ['an open row menu', (e) => { e.ctx.kjrRowMenuCurrent = () => ({ menu: {}, btn: {} }); }],
    ['the sign-in gate', (e) => e.doc.documentElement.classList.add('auth-gated')],
  ];
  for (const [what, setup] of cases) {
    const e = await env(FIXTURE());
    setup(e);
    const ev = e.key('k', { ctrlKey: true });
    e.ctx.cmdShortcutKey(ev);
    assert.equal(e.doc.getElementById('cmd-overlay').open, false, what);
    assert.equal(ev.defaultPrevented, false, what + ': and the key is left alone');
  }
  // the bar itself is a dialog[open], so a second press while it is open does nothing (and so cannot stack a second entry)
  const e = await env(FIXTURE());
  const dlg = e.doc.getElementById('cmd-overlay');
  e.ctx.cmdShortcutKey(e.key('k', { ctrlKey: true }));
  e.dialogs.push(dlg);
  const opens = [];
  const realOpen = e.ctx.kjrModalCtrl.open;
  e.ctx.kjrModalCtrl.open = (d, o) => { opens.push(1); return realOpen(d, o); };
  e.ctx.cmdShortcutKey(e.key('k', { ctrlKey: true }));
  assert.equal(opens.length, 0);
});

// ── the stylesheet ──────────────────────────────────────────────────────────────────────────
test('css: the palette rows are the existing result rows, the active one carries a bar as well as a tint, and the Step 6b section is last, tokens only, spaced media queries', () => {
  const start = css.indexOf('/* ═══════════ Polish and leftovers (redesign Step 6b, v3.74)');
  assert.ok(start > 0 && css.indexOf('Navigation shell (redesign Step 6a') < start, 'new and last in the file');
  const rules = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /#[0-9a-fA-F]{3,8}\b(?![-\w])/, 'no hex colour, tokens only');
  assert.doesNotMatch(rules.replace(/rgba?\(0,0,0/g, ''), /rgba?\(/, 'and no colour function with a literal');
  assert.doesNotMatch(rules, /@media\(/, 'the compact media form is for the older sections');
  assert.doesNotMatch(rules, /will-change|backdrop-filter/);
  assert.match(rules, /#cmd-find-list \.cmd-result\[aria-selected="true"\]\{box-shadow:inset 2px 0 0 var\(--accent\)\}/, 'a bar, so the active option is not colour alone');
  assert.match(rules, /\.cmd-find-val\{[^}]*font-variant-numeric:tabular-nums/);
  assert.match(rules, /\.cmd-result\.is-sold \.kjr-thumb\{opacity:0\.55\}/);
  assert.equal(css.lastIndexOf('@media(max-width:900px){') < start, true, 'overview.test.js finds the Overview\'s 900px block with lastIndexOf on the compact form');
  assert.match(css, /\.cmd-result:hover,\.cmd-result\.selected\{background:var\(--bg3\)\}/, 'the tint is the rule Quick Sale already uses');
});

// ── the thumbnails (v3.84) ──────────────────────────────────────────────────────────────────
// The rows' thumbnails are card art slots like the ones on the pages. A card with no art known yet is drawn as a plain frame that carries
// what a lookup needs (data-need), and what turns it into the shimmer, the picture or the whale is the art observer watching it. The
// palette never handed its list to it, so those rows stayed bare frames for ever. The stub list has no HTML parser, so its art slots are
// read back out of the markup the render wrote, one fake element per slot, made again for every render the way innerHTML does.
const ART_BASE = 'https://assets.tcgdex.net/en/swsh/swsh7/215';
const FAIL = 'Image could not load';
function fakeSlots(htmlText) {
  return [...String(htmlText).matchAll(/<span class="(kjr-art [^"]*)"((?: [a-z-]+="[^"]*")*)><\/span>/g)].map((m) => {
    const cls = new Set(m[1].split(' '));
    const at = {};
    for (const a of m[2].matchAll(/ ([a-z-]+)="([^"]*)"/g)) at[a[1]] = a[2];
    const slot = {
      _kjrVis: true, isConnected: true, cls, at, inserted: [],
      classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), contains: (c) => cls.has(c) },
      getAttribute: (k) => (k in at ? at[k] : null), hasAttribute: (k) => k in at,
      setAttribute: (k, v) => { at[k] = String(v); }, removeAttribute: (k) => { delete at[k]; },
      insertAdjacentHTML(pos, h) { slot.inserted.push(h); }, querySelector: () => null,
    };
    return slot;
  });
}
async function drainQueue(app) {
  for (let n = 0; n < 8; n++) {
    await app.settle(20);
    const id = app.ctx._kjrImgQ.timer;
    if (!id) break;
    app.ctx._kjrImgQ.lastStart -= 1000;
    app.timers.invoke(id);
  }
  await app.settle(20);
}
const lookLoading = (s) => s.cls.has('kjr-art-loading') && s.at['aria-busy'] === 'true' && !s.cls.has('kjr-art-none') && !('role' in s.at);
const lookWhale = (s, label) => s.cls.has('kjr-art-none') && s.at.role === 'img' && s.at['aria-label'] === label && !s.cls.has('kjr-art-loading') && !('aria-busy' in s.at);

test('thumbnails: every render of the results hands its art slots to the observer, each lookup shimmers and ends in the picture or the whale, and typing never queues a card twice', async () => {
  const e = await env({
    singles: [
      single({ id: 'u1', name: 'Umbreon VMAX 215/203', tcgdexId: 'swsh7-215', notes: 'art' }),  // a lookup finds it
      single({ id: 'r1', name: 'Rayquaza VMAX 218/203', tcgdexId: 'swsh7-218', notes: 'art' }), // a lookup fails
      single({ id: 'm1', name: 'Mew 8', tcgdexId: '', notes: 'art' }),                         // no id: the whale at once, nothing to look up
    ],
    slabs: [],
  });
  const { ctx, doc } = e;
  const list = doc.getElementById('cmd-find-list');
  let markup = '', slots = [], renders = 0;
  Object.defineProperty(list, 'innerHTML', {
    configurable: true,
    get() { return markup; },
    set(v) { slots.forEach((s) => { s.isConnected = false; }); markup = v; slots = fakeSlots(v); renders++; },
  });
  list.querySelectorAll = (sel) => (sel === '.kjr-art[data-need]' ? slots.filter((s) => s.hasAttribute('data-need')) : []);
  const otherAll = doc.querySelectorAll;
  doc.querySelectorAll = (sel) => (sel === '.kjr-art[data-need]' ? slots.filter((s) => s.hasAttribute('data-need')) : otherAll(sel));
  const made = [];
  ctx.IntersectionObserver = class {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.watched = []; this.dropped = 0; made.push(this); }
    observe(el) { this.watched.push(el); } unobserve() {} disconnect() { this.dropped++; this.watched = []; }
  };
  e.fetchMock.route('/cards/swsh7-215', { json: { image: ART_BASE } });
  e.fetchMock.reject('/cards/swsh7-218');
  const slotOf = (k) => slots.find((s) => s.getAttribute('data-ik') === k);
  const cardFetches = () => e.fetchMock.calls.filter((c) => /\/cards\/swsh7-/.test(c.url)).length;
  const onScreen = () => made[0].cb(made[0].watched.map((target) => ({ target, isIntersecting: true })), made[0]);

  e.search('art');
  assert.equal(made.length, 1, 'one observer');
  assert.equal(ctx._kjrImgIO.palette, made[0], 'it is the palette\'s own, the observers of the pages are left alone');
  assert.equal(made[0].opts.rootMargin, '240px 0px');
  assert.deepEqual(made[0].watched.map((s) => s.getAttribute('data-ik')).sort(), ['swsh7-215', 'swsh7-218'], 'the two slots a lookup could fill are watched, the whale is not');
  assert.ok(lookWhale(slotOf('swsh7-215') ? fakeSlots(markup).find((s) => !s.hasAttribute('data-need')) : null, 'No image yet'), 'the card with no id is the whale from the first draw');
  assert.equal(slotOf('swsh7-215').cls.has('kjr-art-loading'), false, 'a watched slot is the plain frame until it is on screen and a lookup is queued');
  onScreen();
  assert.ok(lookLoading(slotOf('swsh7-215')) && lookLoading(slotOf('swsh7-218')), 'queued: both shimmer');
  assert.deepEqual(Object.keys(ctx._kjrImgQ.byKey).sort(), ['swsh7-215', 'swsh7-218']);

  // typing: every key press draws the list again, each new slot is watched, none queues a second lookup
  for (const q of ['ar', 'a', 'ar', 'art']) { e.search(q); onScreen(); }
  assert.equal(renders, 5, 'five draws');
  assert.equal(made.length, 1, 'still the one observer, its watch started afresh each time');
  assert.equal(made[0].dropped, 4, 'the old watch is dropped before each new one');
  assert.deepEqual(Object.keys(ctx._kjrImgQ.byKey).sort(), ['swsh7-215', 'swsh7-218'], 'one job per card, however many key presses');
  assert.ok(ctx._kjrImgQ.jobs.length + ctx._kjrImgQ.active <= 2);
  assert.equal(cardFetches() <= 1, true, 'and the second job waits for its gap, the first has asked once');
  assert.ok(lookLoading(slotOf('swsh7-215')) && lookLoading(slotOf('swsh7-218')), 'the slots drawn last shimmer too (they joined the queued jobs)');

  await drainQueue(e);
  assert.equal(cardFetches(), 2, 'five draws, two cards, two requests');
  const found = slotOf('swsh7-215');
  assert.equal(found.hasAttribute('data-need'), false, 'the answer drew the picture into the slot on the page now');
  assert.match(found.inserted.join(''), /src="https:\/\/assets\.tcgdex\.net\/en\/swsh\/swsh7\/215\/low\.webp"/);
  assert.ok(lookLoading(found), 'its picture is on the way (the load event ends the shimmer)');
  assert.ok(lookWhale(slotOf('swsh7-218'), FAIL), 'the failed one ends as the whale, worded as a failure');
  assert.equal(ctx.kjrCardImageBase('swsh7-215'), ART_BASE, 'and the base is kept for the next draw');

  // the next key press: the found card is a picture from the start, the failed one is the whale at once and asks nothing (it is cooling down)
  e.search('art');
  onScreen();
  assert.match(e.listHtml(), /<img class="kjr-card-img" src="https:\/\/assets\.tcgdex\.net\/en\/swsh\/swsh7\/215\/low\.webp"/);
  assert.ok(lookWhale(slotOf('swsh7-218'), FAIL));
  assert.equal(cardFetches(), 2, 'no new request');
  assert.equal(Object.keys(ctx._kjrImgQ.byKey).length, 0);

  // nothing but actions: nothing to watch, and the last watch is let go
  const before = made[0].dropped;
  e.search('');
  assert.equal(made[0].watched.length, 0);
  assert.equal(made[0].dropped, before + 1);
});

test('thumbnails: the render ends by watching the list under the name "palette", on every path that draws it, and an empty list watches nothing', async () => {
  const e = await env(FIXTURE());
  const calls = [];
  e.ctx.kjrObserveCardImages = (root, table) => { calls.push([root, table]); return 0; };
  const list = e.doc.getElementById('cmd-find-list');
  e.search('pika');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], list);
  assert.equal(calls[0][1], 'palette');
  e.search('');
  assert.equal(calls.length, 2, 'an empty search is a draw too: the last watch is let go');
  // the arrow keys move the active option without a redraw (the option nodes are there to touch), so nothing is watched again
  e.search('pika');
  const n = calls.length;
  const nodes = e.results().map((r, i) => ({ attrs: {}, classList: { toggle() {} }, setAttribute(k, v) { this.attrs[k] = v; }, scrollIntoView() {} }));
  list.querySelectorAll = (sel) => (sel === '[role="option"]' ? nodes : []);
  e.ctx.cmdFindKey(e.key('ArrowDown'));
  assert.equal(calls.length, n);
  // and without the nodes the key falls back to a redraw, which watches like any other
  list.querySelectorAll = () => [];
  e.ctx.cmdFindKey(e.key('ArrowDown'));
  assert.equal(calls.length, n + 1);
  // a page without the art code (the observer is a feature of the later script) still draws the list
  const bare = await env(FIXTURE());
  bare.ctx.kjrObserveCardImages = undefined;
  assert.doesNotThrow(() => bare.search('pika'));
  assert.ok(bare.results().length > 0);
});
