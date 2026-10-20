'use strict';
// Redesign Step 5 (v3.72): the card inspector. One panel (a side panel on wide windows, a sheet on narrow ones) shows a
// single or a slab. It is a read-and-launch surface: it never writes a row, every change goes through the function
// the list already uses. These tests pin the content (escaping, the estimate, the source wording, the 30-day line),
// the order behind "Card N of M", the redraw after data changes, the entry points, the keyboard and focus rules, the
// sheet host and that nothing is written or marked dirty. The harness has no real DOM, so the controller is driven
// with a small fake one (makeDom below), the same way tests/table-cleanup.test.js drives the row menu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, makeSeed, plain, ROOT } = require('./harness.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
const BASE = 'https://assets.tcgdex.net/en/swsh/swsh7/215';
const single = (o) => Object.assign({}, makeSeed().singles[0], o);
const slab = (o) => Object.assign({
  id: 'slab_1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '12345678', rank: '',
  language: 'EN', costPrice: 520, marketPrice: 610, listPrice: '', dateListed: '3 Jul 2026', status: 'Available',
  notes: '', priceAlert: '', _updatedAt: new Date().toISOString(),
}, o);
// Noon UTC on 11 Oct 2026: the same calendar day in every timezone from UTC-11 to UTC+11, so "today" is stable.
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const dayIso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString().slice(0, 10);
const hist = (pairs, source) => pairs.map(([n, price]) => ({ date: dayIso(n), price, unit: 'USD', source: source || 'TCGdex (TCGplayer)', confidence: 'high' }));
const idsIn = (markup) => [...markup.matchAll(/<tr data-id="([^"]*)"/g)].map(m => m[1]);
const tileIds = (markup) => [...markup.matchAll(/class="kjr-tile[^"]*" data-id="([^"]*)"/g)].map(m => m[1]);

// ── the fake DOM ────────────────────────────────────────────────────────────────────────────────────────
// Two hosts (the panel body and the sheet body) that keep the markup they were given, count their writes and parse
// out the controls (a button or link carrying data-insp-act, the title) so focus and clicks can be driven. A node
// is "connected" only while it is in the host's current markup, so a redraw disconnects the old controls.
function makeDom(app, opts) {
  opts = opts || {};
  const doc = app.document;
  const real = doc.getElementById.bind(doc);
  const hosts = {};
  const build = (id, liveId) => {
    const node = real(id);
    let markup = '', nodes = [];
    node.writes = 0;
    node.scrollTop = 0;
    Object.defineProperty(node, 'innerHTML', {
      configurable: true,
      get: () => markup,
      set: (v) => { markup = String(v); node.writes++; nodes = parse(markup, node); },
    });
    node._nodes = () => nodes;
    node.contains = (n) => !!n && (n === node || nodes.includes(n));
    node.querySelectorAll = (sel) => sel === '[data-insp-act]' ? nodes.filter(n => n._act) : [];
    node.querySelector = (sel) => sel === '#kjr-insp-title' ? (nodes.find(n => n.id === 'kjr-insp-title') || null) : (sel === '.kjr-more' ? (nodes.find(n => n._more) || null) : null);
    node.control = (act) => nodes.find(n => n._act === act) || null;
    node.html = () => markup;
    hosts[id] = node;
    const live = real(liveId);
    return node;
  };
  const parse = (markup, host) => {
    const out = [];
    const re = /<(button|a|h2)\b([^>]*)>/g;
    let m;
    while ((m = re.exec(markup))) {
      const attrs = m[2];
      const attr = (k) => { const mm = attrs.match(new RegExp('(?:^|\\s)' + k + '="([^"]*)"')); return mm ? mm[1] : null; };
      const act = attr('data-insp-act');
      out.push({
        tagName: m[1].toUpperCase(), id: attr('id') || '', _act: act, _more: /\bkjr-more\b/.test(attr('class') || ''),
        _inMenu: act === 'refresh' || act === 'delete', disabled: /\sdisabled(\s|$)/.test(attrs), _attrs: attrs, _host: host,
        getAttribute: (k) => attr(k),
        closest(sel) {
          if (sel === '[data-insp-act]') return this._act ? this : null;
          if (sel === '.kjr-more') return this._more ? this : null;
          if (sel === '.kjr-rowmenu') return this._inMenu ? this : null;
          return null;
        },
        focus() { doc.activeElement = this; },
        get isConnected() { return host._nodes().includes(this); },
      });
    }
    return out;
  };
  const panelBody = build('kjr-insp-body', 'kjr-insp-live');
  const sheetBody = build('kjr-insp-sheet-body', 'kjr-insp-sheet-live');
  const openDialogs = [];
  doc.getElementById = (id) => {
    if (id === 'kjr-insp-title') return panelBody.querySelector('#kjr-insp-title') || sheetBody.querySelector('#kjr-insp-title');
    return real(id);
  };
  doc.querySelector = () => null;
  doc.querySelectorAll = (sel) => sel === 'dialog[open]' ? openDialogs : [];
  doc.activeElement = null;
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(m);
  app.ctx.toastError = (m) => toasts.push('ERR ' + m);
  const trigger = { focusCount: 0, isConnected: true, focus() { this.focusCount++; doc.activeElement = this; } };
  const key = (k, target, extra) => Object.assign({ key: k, target: target || doc.activeElement, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }, extra || {});
  const narrow = (on) => { app.sandbox.matchMedia = (q) => ({ matches: !!on && /max-width: 900px/.test(q), media: q, addEventListener() {}, removeEventListener() {} }); };
  narrow(false);
  return { doc, panelBody, sheetBody, panel: real('kjr-inspector'), sheet: real('kjr-insp-sheet'), openDialogs, toasts, trigger, key, narrow, real };
}
// A fresh app with n singles named after their ids, in a known order (sorted by name), ready for the inspector.
async function appWith(seed, opts) {
  const app = await loadApp(Object.assign({ seed: makeSeed(seed) }, opts || {}));
  app.dom = makeDom(app);
  return app;
}
const three = () => ({ singles: [single({ id: 'a', name: 'Alpha 1' }), single({ id: 'b', name: 'Bravo 2' }), single({ id: 'c', name: 'Charlie 3' })] });

// ═══ the content ══════════════════════════════════════════════════════════════════════════════════════════
test('content: every value from the row is escaped, only http(s) links reach an href, and there is no "Held"', async () => {
  const { ctx } = await loadApp();
  const evil = single({
    id: 'x"><svg onload=1>', name: '<img src=x onerror=1> "q" & \'a\' 77/200', set: '<b>Set</b>', condition: '<i>NM</i>',
    language: '<EN>', notes: '<script>1</script>\nline 2', ebayUrl: 'javascript:alert(1)',
    carousellUrl: 'https://www.carousell.sg/p/x-1/?a=1&b="2"', listPrice: 20, costPrice: 10, marketPrice: 12,
    datePurchased: '<u>1 Jan</u>', priceHistory: [{ date: dayIso(1), price: 11, source: '<s>src</s>' }, { date: dayIso(0), price: 12, source: '<s>src</s>' }],
  });
  const out = ctx.kjrInspectHtml('singles', evil, { n: 1, total: 1, now: NOW });
  assert.doesNotMatch(out, /<img src=x|<script|<svg onload|<b>Set|<i>NM|<u>1 Jan|<s>src|<EN>/, 'no tag from a field survives');
  assert.doesNotMatch(out.replace(/"[^"]*"/g, '""'), /<[^>]*\son\w+=/i, 'no event handler attribute outside a quoted value');
  assert.match(out, /&lt;img src=x onerror=1&gt; &quot;q&quot; &amp; &#39;a&#39; 77\/200/);
  assert.match(out, /&lt;b&gt;Set&lt;\/b&gt;/);
  assert.match(out, /<dd class="kjr-insp-notes">&lt;script&gt;1&lt;\/script&gt;\nline 2<\/dd>/, 'notes keep their line break (white-space: pre-wrap), escaped');
  assert.doesNotMatch(out, /href="javascript/i, 'a javascript: link never reaches an href');
  assert.match(out, /href="https:\/\/www\.carousell\.sg\/p\/x-1\/\?a=1&amp;b=%222%22"/, 'a good link is normalised and escaped');
  assert.match(out, /Listed on eBay/, 'the chip still says the row has an eBay link');
  assert.doesNotMatch(out, /Open eBay listing/, 'but there is nothing safe to open');
  assert.doesNotMatch(out, /\bHeld\b|held/, 'the redesign dropped Held');
  assert.doesNotMatch(src(), /\bHeld\b/i, 'and the section has no Held row, label or comment');
});
function src() { return fs.readFileSync(ROOT + '/features.js', 'utf8').slice(fs.readFileSync(ROOT + '/features.js', 'utf8').indexOf('Card inspector (v3.72)'), fs.readFileSync(ROOT + '/features.js', 'utf8').indexOf('Launch intro (v3.25)')); }

test('content: market value, gain against cost with an arrow AND a sign, and the estimate when there is no market price', async () => {
  const { ctx } = await loadApp();
  const win = ctx.kjrInspectHtml('singles', single({ marketPrice: 130, costPrice: 100 }), { now: NOW });
  assert.match(win, /<div class="kjr-insp-vlabel">Market value<\/div><div class="kjr-insp-vnum">S\$130<\/div>/);
  assert.match(win, /<div class="kjr-insp-gain is-up"><div class="kjr-insp-gain-main"><span aria-hidden="true">▲<\/span> \+S\$30 · \+30\.0%<\/div><div class="kjr-insp-gain-sub">against S\$100 cost<\/div><\/div>/);
  const loss = ctx.kjrInspectHtml('singles', single({ marketPrice: 80, costPrice: 100 }), { now: NOW });
  assert.match(loss, /<div class="kjr-insp-gain is-down"><div class="kjr-insp-gain-main"><span aria-hidden="true">▼<\/span> -S\$20 · -20\.0%/);
  const flat = ctx.kjrInspectHtml('singles', single({ marketPrice: 100, costPrice: 100 }), { now: NOW });
  assert.match(flat, /<div class="kjr-insp-gain"><div class="kjr-insp-gain-main">S\$0 · 0%<\/div>/, 'flat has no arrow and no colour class');
  const est = ctx.kjrInspectHtml('singles', single({ marketPrice: '', costPrice: 50 }), { now: NOW });
  assert.match(est, /<div class="kjr-insp-vnum">~S\$50<\/div><div class="kjr-insp-vsub">Estimate, using cost<\/div>/);
  assert.doesNotMatch(est, /kjr-insp-gain/, 'an estimate from cost has no gain to show');
  const none = ctx.kjrInspectHtml('singles', single({ marketPrice: '', costPrice: '' }), { now: NOW });
  assert.match(none, /<div class="kjr-insp-vnum">-<\/div><div class="kjr-insp-vsub">No market price or cost yet<\/div>/);
  const many = ctx.kjrInspectHtml('singles', single({ qty: 3, marketPrice: 40, costPrice: 20, listPrice: 60 }), { now: NOW });
  assert.match(many, /<div class="kjr-insp-vsub">each, S\$120 for 3<\/div>/);
  assert.match(many, /<dt>Cost<\/dt><dd>S\$20 each<\/dd>/);
  assert.match(many, /<dt>Asking<\/dt><dd>S\$60 each<\/dd>/);
  assert.match(many, /<dt>Quantity<\/dt><dd>3<\/dd>/, 'Quantity shows only above one');
  assert.doesNotMatch(ctx.kjrInspectHtml('singles', single({ qty: 1 }), { now: NOW }), /<dt>Quantity<\/dt>/);
});

test('content: the source line says where the price came from and how long ago, for every source the app writes', async () => {
  const { ctx } = await loadApp();
  const line = (source, daysAgo, extra) => ctx.kjrInspectPriceLine('singles', single(Object.assign({ marketPrice: 10, priceHistory: [{ date: dayIso(daysAgo), price: 10, source }] }, extra || {})), NOW);
  assert.equal(line('TCGdex (TCGplayer)', 0), 'TCGplayer market via TCGdex · checked today');
  assert.equal(line('TCGdex (Cardmarket)', 1), 'Cardmarket trend via TCGdex · checked yesterday');
  assert.equal(line('manual', 3), 'Manual price · checked 3 days ago');
  assert.equal(line('PPT', 0), 'eBay sold average via PokemonPriceTracker · checked today');
  assert.equal(line('PPT (PSA 10)', 0), 'eBay sold average via PokemonPriceTracker · checked today');
  assert.equal(line('Some New Source', 0), 'Some New Source · checked today', 'an unknown source is shown as stored');
  assert.equal(line('', 0), 'Price source not recorded · checked today');
  assert.match(line('manual', 20), /^Manual price · checked 21 Sep 2026$/, 'older than a week is a plain date');
  // the latest entry in the array is the one described
  const two = single({ marketPrice: 10, priceHistory: [{ date: dayIso(9), price: 8, source: 'manual' }, { date: dayIso(0), price: 10, source: 'TCGdex (TCGplayer)' }] });
  assert.equal(ctx.kjrInspectPriceLine('singles', two, NOW), 'TCGplayer market via TCGdex · checked today');
  // no history at all
  assert.equal(ctx.kjrInspectPriceLine('singles', single({ language: 'JP', marketPrice: 90, priceHistory: [] }), NOW), 'Manual price, no free source for this language');
  assert.equal(ctx.kjrInspectPriceLine('singles', single({ language: 'JP', marketPrice: '', priceHistory: undefined }), NOW), 'Manual price, no free source for this language');
  assert.equal(ctx.kjrInspectPriceLine('singles', single({ marketPrice: 12 }), NOW), 'Manual price', 'a typed price with no record');
  assert.equal(ctx.kjrInspectPriceLine('singles', single({ marketPrice: '', name: 'Custom Card' }), NOW), 'Add or fix the card number for exact pricing');
  assert.equal(ctx.kjrInspectPriceLine('slabs', slab({ marketPrice: '' }), NOW), 'No market price checked yet');
  const sealed = ctx.kjrInspectHtml('singles', single({ language: 'JP', priceHistory: [] }), { now: NOW });
  assert.match(sealed, /Manual price, no free source for this language/);
});

test('content: the 30-day line uses the last 30 days only, one point a day, with a dashed cost line and a key', async () => {
  const { ctx } = await loadApp();
  const days = []; for (let n = 29; n >= 0; n--) days.push([n, 100 + (n % 5)]);
  const item = single({ costPrice: 90, marketPrice: 100, priceHistory: hist(days.concat([[40, 50]]).concat([[0, 111]])) }); // an old point and a second entry for today
  const s = ctx.kjrInspectSeries(item, NOW);
  assert.equal(s.points.length, 30, 'the 40 day old entry is dropped, the two entries for today are one point');
  assert.equal(s.points[s.points.length - 1].price, 111, 'a later entry for the same day wins');
  assert.ok(s.points.every((p, i, a) => i === 0 || a[i - 1].t < p.t), 'oldest first');
  const chart = ctx.kjrInspectChartHtml(item, NOW);
  assert.match(chart, /<svg class="kjr-insp-chart" viewBox="0 0 760 200" preserveAspectRatio="none" role="img" aria-label="Market price over the last 30 days, 30 readings, from S\$100 to S\$111, with your cost of S\$90 as a dashed line">/);
  assert.match(chart, /<path class="kjr-insp-costline" d="M8 [\d.]+ L752 [\d.]+" vector-effect="non-scaling-stroke"\/>/);
  assert.match(chart, /<path class="kjr-insp-line" d="M[\d. L]+" vector-effect="non-scaling-stroke"\/>/);
  assert.match(chart, /<span class="kjr-insp-key"><i class="m" aria-hidden="true"><\/i>Market<\/span><span class="kjr-insp-key"><i class="c" aria-hidden="true"><\/i>Cost S\$90<\/span>/);
  assert.doesNotMatch(chart, /NaN|Infinity|undefined/);
  const ys = [...chart.matchAll(/ L?(?:\d+(?:\.\d)?) (\d+(?:\.\d)?)(?= L| Z|")/g)].map(m => Number(m[1]));
  assert.ok(ys.every(y => y >= 0 && y <= 200), 'every point is inside the drawing');
});

test('content: fewer than two points is a one-line empty state, bad entries are ignored, a flat or lopsided series never breaks', async () => {
  const { ctx } = await loadApp();
  const empty = '<p class="kjr-insp-empty">Not enough price history yet</p>';
  assert.equal(ctx.kjrInspectChartHtml(single({ priceHistory: [] }), NOW), empty);
  assert.equal(ctx.kjrInspectChartHtml(single({ priceHistory: undefined }), NOW), empty);
  assert.equal(ctx.kjrInspectChartHtml(single({ priceHistory: hist([[2, 10]]) }), NOW), empty, 'one point');
  assert.equal(ctx.kjrInspectChartHtml(single({ priceHistory: hist([[40, 10], [35, 12]]) }), NOW), empty, 'two points, both too old');
  const junk = [null, 'x', {}, { date: 'not a date', price: 5 }, { date: dayIso(1), price: 'abc' }, { date: dayIso(1), price: 0 }, { date: dayIso(1), price: -3 },
    { date: dayIso(-9), price: 7 } /* more than a day in the future */];
  assert.equal(ctx.kjrInspectChartHtml(single({ priceHistory: junk }), NOW), empty);
  assert.equal(ctx.kjrInspectChartHtml(single({ priceHistory: junk.concat(hist([[5, 10], [1, 12]])) }), NOW).includes('2 readings'), true, 'good entries still count among bad ones');
  const flat = ctx.kjrInspectChartHtml(single({ costPrice: '', priceHistory: hist([[5, 10], [1, 10]]) }), NOW);
  assert.doesNotMatch(flat, /NaN|Infinity/, 'a flat line has a scale of its own');
  assert.doesNotMatch(flat, /costline/, 'no cost, no cost line');
  // a cost far outside the market range would flatten the line: it is named in the key and left off the drawing
  const low = ctx.kjrInspectChartHtml(single({ costPrice: 5, priceHistory: hist([[5, 100], [1, 104]]) }), NOW);
  assert.doesNotMatch(low, /costline/);
  assert.match(low, /Cost S\$5, below the scale/);
  const high = ctx.kjrInspectChartHtml(single({ costPrice: 900, priceHistory: hist([[5, 100], [1, 104]]) }), NOW);
  assert.match(high, /Cost S\$900, above the scale/);
  const near = ctx.kjrInspectChartHtml(single({ costPrice: 40, priceHistory: hist([[5, 100], [1, 104]]) }), NOW);
  assert.match(near, /costline/, 'within a factor of three of the market range, the cost joins the scale');
});

test('content: a slab shows grader, grade and cert in mono, Listed when it has no purchase date, and keeps the TAG link', async () => {
  const { ctx } = await loadApp();
  const psa = ctx.kjrInspectHtml('slabs', slab({ datePurchased: '3 Jul 2026', dateListed: '5 Jul 2026' }), { now: NOW });
  assert.match(psa, /<p class="kjr-insp-set"><span class="kjr-insp-mono">PSA 10 · 12345678<\/span><\/p>/);
  assert.match(psa, /<dt>Bought<\/dt><dd>3 Jul 2026<\/dd>/, 'datePurchased wins when a slab row has one');
  assert.doesNotMatch(psa, /<dt>Listed<\/dt>/);
  assert.match(psa, /<dt>Cert<\/dt><dd><span class="kjr-insp-mono">12345678<\/span><\/dd>/);
  assert.match(psa, /<span class="kjr-slab" aria-hidden="true"><span class="kjr-slab-label kjr-g-psa">/, 'the drawn slab, scaled up');
  assert.doesNotMatch(psa, /kjr-insp-card/, 'no single-card art on a slab');
  const listed = ctx.kjrInspectHtml('slabs', slab({ datePurchased: undefined, dateListed: '5 Jul 2026' }), { now: NOW });
  assert.match(listed, /<dt>Listed<\/dt><dd>5 Jul 2026<\/dd>/, 'no purchase date: Listed plus dateListed');
  assert.doesNotMatch(listed, /<dt>Bought<\/dt>/);
  const none = ctx.kjrInspectHtml('slabs', slab({ datePurchased: '', dateListed: '', certNo: '' }), { now: NOW });
  assert.match(none, /<dt>Bought<\/dt><dd class="is-empty">Not recorded<\/dd>/);
  assert.match(none, /<dt>Cert<\/dt><dd class="is-empty">Not recorded<\/dd>/);
  const tag = ctx.kjrInspectHtml('slabs', slab({ grader: 'TAG', grade: '10 Pristine', certNo: 'T 1/2' }), { now: NOW });
  assert.match(tag, /<a class="kjr-insp-mono" href="https:\/\/my\.taggrading\.com\/card\/T%201%2F2" target="_blank" rel="noopener noreferrer">T 1\/2 <span aria-hidden="true">↗<\/span><\/a>/);
  assert.match(tag, /TAG 10 ★ · T 1\/2/);
  assert.doesNotMatch(psa, /taggrading/, 'only TAG slabs link out');
  assert.doesNotMatch(psa, /<dt>Quantity<\/dt>|Condition/, 'slabs have no quantity or condition');
});

test('content: listing chips and the Asking suffix follow the link and the listing workspace status, and a sold card shows none', async () => {
  const { ctx } = await loadApp();
  const chips = (o) => [...ctx.kjrInspectHtml('singles', single(Object.assign({ listPrice: 50 }, o)), { now: NOW }).matchAll(/kjr-insp-chip has-dot listed">([^<]*)</g)].map(m => m[1]);
  const asking = (o) => ctx.kjrInspectHtml('singles', single(Object.assign({ listPrice: 50 }, o)), { now: NOW }).match(/<dt>Asking<\/dt><dd[^>]*>([^<]*)<\/dd>/)[1];
  assert.deepEqual(chips({}), []);
  assert.equal(asking({}), 'S$50');
  assert.deepEqual(chips({ carousellUrl: 'https://www.carousell.sg/p/x-1/' }), ['Listed on Carousell']);
  assert.equal(asking({ carousellUrl: 'https://www.carousell.sg/p/x-1/' }), 'S$50 on Carousell');
  assert.deepEqual(chips({ listingMeta: { listingStatus: 'listed' } }), ['Listed on Carousell'], 'the workspace says listed, no link needed');
  assert.deepEqual(chips({ listingMeta: { listingStatus: 'reserved' } }), ['Reserved on Carousell']);
  assert.deepEqual(chips({ listingMeta: { listingStatus: 'draft' } }), []);
  assert.deepEqual(chips({ carousellUrl: 'https://www.carousell.sg/p/x-1/', listingMeta: { listingStatus: 'removed' } }), [], 'a link to a listing that came down is not "Listed"');
  assert.deepEqual(chips({ ebayUrl: 'https://www.ebay.com/itm/1' }), ['Listed on eBay']);
  assert.equal(asking({ ebayUrl: 'https://www.ebay.com/itm/1' }), 'S$50', 'the suffix is Carousell only');
  assert.deepEqual(chips({ ebayUrl: 'https://www.ebay.com/itm/1', carousellUrl: 'https://www.carousell.sg/p/x-1/' }), ['Listed on Carousell', 'Listed on eBay']);
  assert.deepEqual(chips({ status: 'Sold', carousellUrl: 'https://www.carousell.sg/p/x-1/' }), [], 'a sold card is not listed');
  assert.equal(asking({ status: 'Sold', carousellUrl: 'https://www.carousell.sg/p/x-1/' }), 'S$50');
  assert.doesNotMatch(ctx.kjrInspectHtml('singles', single({ listingMeta: 'junk' }), { now: NOW }), /Listed on/, 'a malformed listingMeta is ignored');
});

test('content: chips (language, condition, Sealed, status) and the set line with the number in mono', async () => {
  const { ctx } = await loadApp();
  const out = ctx.kjrInspectHtml('singles', single({ name: 'Umbreon VMAX 215/203', set: 'Evolving Skies', language: 'jp', condition: 'Mint' }), { now: NOW });
  assert.match(out, /<div class="kjr-insp-chips"><span class="badge b-lang">JP<\/span><span class="kjr-insp-chip">Mint<\/span><span class="kjr-insp-chip has-dot stock">In stock<\/span><\/div>/);
  assert.match(out, /<p class="kjr-insp-set">Evolving Skies · <span class="kjr-insp-mono">215\/203<\/span><\/p>/);
  assert.match(out, /<h2 class="kjr-insp-title" id="kjr-insp-title" tabindex="-1">Umbreon VMAX 215\/203<\/h2>/);
  assert.match(ctx.kjrInspectHtml('singles', single({ language: '' }), { now: NOW }), /<span class="badge b-lang">EN<\/span>/, 'a blank language has always meant EN');
  assert.doesNotMatch(ctx.kjrInspectHtml('singles', single({ name: 'Pikachu', set: '' }), { now: NOW }), /kjr-insp-set/, 'no set and no number: no line');
  const sealed = ctx.kjrInspectHtml('singles', single({ name: 'Scarlet & Violet 151 Booster Box', set: 'SV 151', type: 'sealed' }), { now: NOW });
  assert.match(sealed, /<span class="kjr-insp-chip">Sealed<\/span>/);
  assert.match(sealed, /<p class="kjr-insp-set">SV 151<\/p>/, '"151" in a product name is not a card number');
  assert.equal(ctx.kjrInspectCardNumber('Umbreon VMAX 215/203'), '215/203');
  assert.equal(ctx.kjrInspectCardNumber('Mew ex SIR 232/091'), '232/091');
  assert.equal(ctx.kjrInspectCardNumber('Charizard ex 223'), '223');
  assert.equal(ctx.kjrInspectCardNumber('Pikachu'), '');
  const sold = ctx.kjrInspectHtml('singles', single({ status: 'Sold' }), { now: NOW });
  assert.match(sold, /<span class="kjr-insp-chip has-dot sold">Sold<\/span>/);
  assert.match(sold, /<div class="kjr-insp-stage is-sold"/);
});

test('content: the actions follow the status, the "…" reuses the row menu markup, and links open in a new tab safely', async () => {
  const { ctx } = await loadApp();
  const avail = ctx.kjrInspectHtml('singles', single({ ebayUrl: 'https://www.ebay.com/itm/1', carousellUrl: 'https://www.carousell.sg/p/x-1/' }), { now: NOW });
  assert.match(avail, /<button type="button" class="kjr-insp-primary" data-insp-act="status">Mark as sold<\/button>/);
  assert.deepEqual([...avail.matchAll(/class="kjr-insp-btn" data-insp-act="(\w+)">([^<]*)</g)].map(m => [m[1], m[2]]), [['listing', 'Generate listing'], ['edit', 'Edit']]);
  assert.match(avail, /<button type="button" class="kjr-more kjr-insp-more" data-insp-act="more" aria-label="More actions for Pikachu 25" aria-haspopup="menu" aria-expanded="false" title="More actions">/);
  assert.match(avail, /<div class="kjr-rowmenu" role="menu" aria-label="More actions for Pikachu 25" hidden>/);
  const items = [...avail.slice(avail.indexOf('class="kjr-rowmenu"')).matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map(m => m[1]);
  assert.deepEqual(items, ['Open eBay listing', 'Open Carousell listing', 'Refresh price', 'Delete']);
  assert.match(avail, /<a role="menuitem" href="https:\/\/www\.ebay\.com\/itm\/1" target="_blank" rel="noopener noreferrer">Open eBay listing<\/a>/);
  assert.match(avail, /class="kjr-rowmenu-sep" role="separator"><\/div><button type="button" role="menuitem" class="is-danger" data-insp-act="delete">Delete<\/button>/);
  assert.doesNotMatch(avail, /\son(click|change|input)=/i, 'no inline handler anywhere in the panel');
  const bare = ctx.kjrInspectHtml('singles', single({}), { now: NOW });
  assert.doesNotMatch(bare, /Open eBay listing|Open Carousell listing/, 'a link only when the row has one');
  const sold = ctx.kjrInspectHtml('singles', single({ status: 'Sold', ebayUrl: 'https://www.ebay.com/itm/1' }), { now: NOW });
  assert.match(sold, /data-insp-act="status">Mark as available<\/button>/);
  assert.doesNotMatch(sold, /Generate listing|Refresh price/, 'a sold card cannot be listed or repriced');
  assert.match(sold, /Open eBay listing/, 'the old listing can still be opened');
  assert.match(sold, /Delete/);
  const top = avail.slice(0, avail.indexOf('kjr-insp-stage'));
  assert.match(top, /aria-label="Previous card" title="Previous card \(Up arrow or K\)" disabled>/);
  assert.match(top, /aria-label="Next card" title="Next card \(Down arrow or J\)" disabled>/, 'a lone card has nothing to step to');
  assert.match(top, /aria-label="Close card details"/);
});

test('content: Refresh price is off in a local preview and for a single with no free source, with the reason in the title', async () => {
  const { ctx } = await loadApp();
  const live = single({ name: 'Charizard ex 223' });
  assert.deepEqual(plain(ctx.kjrInspectRefreshInfo('singles', live)), { ok: true, why: '' });
  assert.deepEqual(plain(ctx.kjrInspectRefreshInfo('slabs', slab({}))), { ok: true, why: '' }, 'slabs price through PPT');
  assert.equal(ctx.kjrInspectRefreshInfo('singles', single({ language: 'JP', name: 'Pikachu 25' })).why, 'Manual price, no free source for this language');
  assert.equal(ctx.kjrInspectRefreshInfo('singles', single({ name: 'Custom Card' })).why, 'Add or fix the card number for exact pricing');
  assert.equal(ctx.kjrInspectRefreshInfo('singles', single({ name: 'Custom Card', tcgdexId: 'sv03-223' })).ok, true, 'a TCGdex id makes it free-lane');
  const off = ctx.kjrInspectHtml('singles', single({ language: 'JP' }), { now: NOW });
  assert.match(off, /data-insp-act="refresh" aria-disabled="true" title="Manual price, no free source for this language">Refresh price</);
  ctx.location = Object.assign({}, ctx.location, { hostname: 'localhost', protocol: 'http:' });
  const local = ctx.kjrInspectRefreshInfo('singles', live);
  assert.equal(local.ok, false);
  assert.equal(local.why, 'Price refresh is disabled in local preview (sync off). Use the live site.');
  assert.equal(ctx.kjrInspectRefreshInfo('slabs', slab({})).ok, false, 'slabs too, a preview never prices');
  assert.match(ctx.kjrInspectHtml('singles', live, { now: NOW }), /data-insp-act="refresh" aria-disabled="true" title="Price refresh is disabled in local preview/);
});

test('art: a single shows the high image, the whale for no id, a miss or a failed load, and the late fill reads the size off the slot', async () => {
  const seed = makeSeed({ singles: [single({ id: 'u', name: 'Umbreon VMAX 215/203', tcgdexId: 'swsh7-215' })] });
  const { ctx } = await loadApp({ seed });
  const item = (o) => single(Object.assign({ id: 'u', name: 'Umbreon VMAX 215/203', tcgdexId: 'swsh7-215' }, o));
  const art = (o) => ctx.kjrInspectArtHtml('singles', item(o), false);
  // unknown base: a placeholder a lookup can fill, drawn at the large size
  assert.match(art(), /<span class="kjr-art kjr-insp-art kjr-art-ph" data-sz="h" data-need="1" data-ik="swsh7-215" data-lg="en" data-tcg="swsh7-215"><\/span>/);
  ctx.kjrRememberCardImage('swsh7-215', BASE, 'en');
  const hit = art();
  // v3.83: a picture not yet on screen starts in the loading look (shimmer, aria-busy), loads at once with high priority (the open panel is what it
  // is for, lazy there only waits for the sheet to slide in) and asks for CORS so sw.js can cache it
  assert.match(hit, /<span class="kjr-art kjr-insp-art kjr-art-loading" data-sz="h" aria-busy="true"><img class="kjr-card-img" src="https:\/\/assets\.tcgdex\.net\/en\/swsh\/swsh7\/215\/high\.webp" width="245" height="337" alt="" fetchpriority="high" decoding="async" referrerpolicy="no-referrer" draggable="false" crossorigin="anonymous"><\/span>/);
  assert.match(hit, /<span class="kjr-insp-sheen" aria-hidden="true"><\/span>/);
  assert.match(hit, /^<div class="kjr-insp-stage" aria-hidden="true"><div class="kjr-insp-card">/);
  // the late fill (kjrApplyArt) draws kjrImgTag(base, slot.data-sz): 'h' is the large image, 'c' and 't' are unchanged
  assert.match(ctx.kjrImgTag(BASE, 'h'), /src="[^"]*\/high\.webp" width="245" height="337"/);
  assert.match(ctx.kjrImgTag(BASE, 'c'), /src="[^"]*\/low\.webp" width="245" height="337"/);
  assert.match(ctx.kjrImgTag(BASE, 't'), /src="[^"]*\/low\.webp" width="28" height="39"/);
  // no id, and a fresh miss: the whale, nothing for a lookup to do. A Japanese single is the exception (v3.80): with a
  // card number in its name a lookup can find its card by the Japanese name, so its placeholder carries the row id for that lookup,
  // and without a number (or in another non-English language) it is the whale again
  assert.match(art({ tcgdexId: '' }), /<span class="kjr-art kjr-insp-art kjr-art-ph kjr-art-none" data-sz="h" role="img" aria-label="No image yet" title="No image yet"><\/span>/);
  assert.match(art({ tcgdexId: '', language: 'JP' }), /<span class="kjr-art kjr-insp-art kjr-art-ph" data-sz="h" data-need="1" data-ik="single:u" data-lg="ja" data-single="u"><\/span>/);
  assert.match(art({ tcgdexId: '', language: 'JP', name: 'Umbreon Custom Card' }), /kjr-art-ph kjr-art-none" data-sz="h" role="img" aria-label="No image yet" title="No image yet"><\/span>/);
  assert.match(art({ tcgdexId: '', language: 'CN' }), /kjr-art-ph kjr-art-none" data-sz="h" role="img" aria-label="No image yet" title="No image yet"><\/span>/);
  ctx.kjrRememberCardImageMiss('swsh7-218', 'en');
  assert.match(art({ tcgdexId: 'swsh7-218' }), /kjr-art-ph kjr-art-none" data-sz="h" role="img" aria-label="No image yet" title="No image yet"><\/span>/);
  // a high image that failed to load falls back to the small one, and when that fails too it is the placeholder
  ctx._kjrImgBroken[BASE + '/high.webp'] = true;
  assert.match(art(), /data-sz="c" aria-busy="true"><img class="kjr-card-img" src="[^"]*\/low\.webp"/);
  ctx._kjrImgBroken[BASE + '/low.webp'] = true;
  assert.match(art(), /kjr-art-ph kjr-art-none" data-sz="h" role="img" aria-label="Image could not load" title="Image could not load"><\/span>/, 'a failed picture says so, on a redraw too (v3.83)');
  assert.match(ctx.kjrInspectArtHtml('singles', item(), true), /^<div class="kjr-insp-stage is-sold"/, 'a sold card dims its art');
});

// ═══ the order ════════════════════════════════════════════════════════════════════════════════════════════
test('order: renderSingles keeps the ids it drew in the order it drew them, the inline Sold rows and the open section included', async () => {
  const seed = makeSeed({ singles: [single({ id: 'a', name: 'Alpha' }), single({ id: 'b', name: 'Bravo' }), single({ id: 's1', name: 'Sierra', status: 'Sold' }), single({ id: 'c', name: 'Charlie' })] });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSingles();
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), idsIn(document.getElementById('singles-body').innerHTML), 'the main section as drawn');
  assert.equal(ctx._kjrInspectOrder.singles.length, 3, 'the Sold row sits in the closed section, not in the order');
  document.getElementById('singles-sold-divider').dataset.open = '1';
  ctx.renderSingles();
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), idsIn(document.getElementById('singles-body').innerHTML).concat(idsIn(document.getElementById('singles-sold-body').innerHTML)), 'then the open section');
  assert.equal(ctx._kjrInspectOrder.singles[3], 's1');
  document.getElementById('singles-sold-divider').dataset.open = '0';
  document.getElementById('singles-status-filter').value = 'all';
  ctx.renderSingles();
  const all = idsIn(document.getElementById('singles-body').innerHTML);
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), all, 'status "all": available then Sold, inline');
  assert.equal(all.length, 4);
  document.getElementById('singles-status-filter').value = 'sold';
  document.getElementById('singles-sold-divider').dataset.open = '1';
  ctx.renderSingles();
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), ['s1', ...idsIn(document.getElementById('singles-sold-body').innerHTML)], 'status "sold": the Sold rows, then the Available ones while that section is open');
  ctx.sortState.singles = { col: 'name', dir: -1 };
  document.getElementById('singles-status-filter').value = '';
  document.getElementById('singles-sold-divider').dataset.open = '0';
  ctx.renderSingles();
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), ['c', 'b', 'a'], 'it follows the sort');
  document.getElementById('singles-search').value = 'bravo';
  ctx.renderSingles();
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), ['b'], 'and the filters');
});

test('order: the grid sets the same order as the list, and renderSlabs does the same for slabs', async () => {
  const seed = makeSeed({
    singles: [single({ id: 'a', name: 'A' }), single({ id: 'b', name: 'B' }), single({ id: 's1', name: 'S1', status: 'Sold' })],
    slabs: [slab({ id: 'p1', name: 'P1' }), slab({ id: 'p2', name: 'P2' }), slab({ id: 'p3', name: 'P3', status: 'Sold' })],
  });
  const { ctx, document } = await loadApp({ seed, localStorage: { kjr_view_singles: 'grid', kjr_view_slabs: 'grid' } });
  document.getElementById('singles-status-filter').value = 'all';
  ctx.renderSingles(); ctx.renderSlabs();
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), tileIds(document.getElementById('singles-grid').innerHTML), 'grid, status "all": main tiles then inline Sold tiles');
  assert.equal(ctx._kjrInspectOrder.singles.length, 3);
  assert.deepEqual(plain(ctx._kjrInspectOrder.slabs), ['p1', 'p2'], 'slabs: the Sold ones wait in the closed section');
  document.getElementById('slabs-sold-divider').dataset.open = '1';
  ctx.renderSlabs();
  assert.deepEqual(plain(ctx._kjrInspectOrder.slabs), ['p1', 'p2', 'p3'], 'and join the order when it is opened');
  assert.deepEqual(plain(ctx._kjrInspectOrder.slabs), tileIds(document.getElementById('slabs-grid').innerHTML).concat(tileIds(document.getElementById('slabs-grid-alt').innerHTML)));
});

test('stepping: "Card N of M", previous and next, disabled at the ends, and nothing beyond them', async () => {
  const app = await appWith(three());
  const { ctx } = app, { panelBody, trigger } = app.dom;
  ctx.renderSingles();
  assert.equal(ctx.kjrInspect('singles', 'b', { trigger }), true);
  const top = () => panelBody.html().slice(0, panelBody.html().indexOf('kjr-insp-stage'));
  assert.match(top(), /Card 2 of 3/);
  assert.doesNotMatch(top(), /disabled/, 'both ways are open in the middle');
  assert.equal(ctx.kjrInspectStep(1), true);
  assert.match(top(), /Card 3 of 3/);
  assert.match(top(), /aria-label="Next card"[^>]*disabled>/);
  assert.doesNotMatch(top(), /aria-label="Previous card"[^>]*disabled>/);
  assert.equal(ctx.kjrInspectStep(1), false, 'the end');
  assert.match(top(), /Card 3 of 3/);
  assert.equal(ctx.kjrInspectStep(-1), true);
  assert.equal(ctx.kjrInspectStep(-1), true);
  assert.match(top(), /Card 1 of 3/);
  assert.match(top(), /aria-label="Previous card"[^>]*disabled>/);
  assert.equal(ctx.kjrInspectStep(-1), false, 'the start');
  assert.equal(ctx._kjrInsp.id, 'a');
  assert.match(panelBody.html(), /id="kjr-insp-title" tabindex="-1">Alpha 1</);
  // the controls do the same through the delegated click
  ctx.kjrInspectOnClick({ target: panelBody.control('next') });
  assert.equal(ctx._kjrInsp.id, 'b');
  ctx.kjrInspectOnClick({ target: panelBody.control('prev') });
  assert.equal(ctx._kjrInsp.id, 'a');
  ctx.kjrInspectOnClick({ target: panelBody.control('prev') });
  assert.equal(ctx._kjrInsp.id, 'a', 'a click on a disabled control does nothing');
});

test('stepping: the Overview passes the tiles it drew, across singles and slabs, rows that are gone are dropped', async () => {
  const app = await appWith({ singles: [single({ id: 'a', name: 'A' })], slabs: [slab({ id: 'p1' }), slab({ id: 'p2', name: 'P2' })] });
  const { ctx } = app, { panelBody } = app.dom;
  ctx.kjrInspect('slabs', 'p1', { order: [{ table: 'singles', id: 'a' }, { table: 'slabs', id: 'p1' }, { table: 'slabs', id: 'gone' }, { table: 'slabs', id: 'p2' }, { table: 'bogus', id: 'x' }, null] });
  assert.match(panelBody.html(), /Card 2 of 3/, 'the missing row and the bogus entries are not counted');
  assert.equal(ctx.kjrInspectStep(-1), true);
  assert.equal(ctx._kjrInsp.table, 'singles');
  assert.match(panelBody.html(), /<h2[^>]*>A<\/h2>/, 'it moved to the single');
  assert.equal(ctx.kjrInspectStep(1), true);
  assert.equal(ctx.kjrInspectStep(1), true);
  assert.equal(ctx._kjrInsp.id, 'p2');
  assert.equal(ctx._kjrInsp.src, 'fixed');
  // an order that does not hold the card falls back to the card alone
  ctx.kjrInspect('slabs', 'p2', { order: ['a'] });
  assert.match(panelBody.html(), /Card 1 of 1/);
  // bare ids belong to the card's own table
  ctx.kjrInspect('slabs', 'p2', { order: ['p1', 'p2'] });
  assert.match(panelBody.html(), /Card 2 of 2/);
});

test('stepping: the order follows the list while the card is in it, and keeps its last shape once the card leaves it', async () => {
  const app = await appWith(three());
  const { ctx, document } = app, { panelBody } = app.dom;
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'b', {});
  assert.match(panelBody.html(), /Card 2 of 3/);
  ctx.sortState.singles = { col: 'name', dir: -1 }; // C B A
  ctx.renderSingles();
  assert.match(panelBody.html(), /Card 2 of 3/, 'b is still second');
  assert.equal(ctx.kjrInspectStep(1), true);
  assert.equal(ctx._kjrInsp.id, 'a', 'the order is the list, now reversed');
  ctx.sortState.singles = { col: 'name', dir: 1 };
  ctx.renderSingles();
  assert.match(panelBody.html(), /Card 1 of 3/, 'a is first again');
  ctx.DB.singles.find(r => r.id === 'a').status = 'Sold'; // a leaves the Available list
  ctx.renderSingles();
  assert.deepEqual(plain(ctx._kjrInspectOrder.singles), ['b', 'c']);
  assert.match(panelBody.html(), /Card 1 of 3/, 'the order it had, so stepping stays steady: a was first, b and c follow');
  assert.equal(ctx.kjrInspectStep(1), true);
  assert.equal(ctx._kjrInsp.id, 'b');
  assert.match(panelBody.html(), /Card 1 of 2/, 'b is in the list again, so the order is the list again, and the sold card is not in it');
  ctx.DB.singles = ctx.DB.singles.filter(r => r.id !== 'c');
  ctx.renderSingles();
  assert.match(panelBody.html(), /Card 1 of 1/, 'a deleted row is gone from it too');
  // a deleted row inside a kept order (the card is not in the list) is pruned
  ctx.kjrInspect('singles', 'a', { order: ['a', 'b', 'c'] });
  assert.match(panelBody.html(), /Card 1 of 2/, 'c no longer exists');
});

// ═══ redrawing from the data ══════════════════════════════════════════════════════════════════════════
test('redraw: a list redraw after an edit updates the panel by id, and an unchanged card leaves the page alone', async () => {
  const app = await appWith(three());
  const { ctx } = app, { panelBody } = app.dom;
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'b', {});
  const writes = panelBody.writes;
  ctx.renderSingles();
  ctx.renderSingles();
  assert.equal(panelBody.writes, writes, 'same markup, no write: focus, scroll and the image stay');
  const edited = Object.assign({}, ctx.DB.singles.find(r => r.id === 'b'), { name: 'Bravo Renamed 2', marketPrice: 99, costPrice: 50 });
  ctx.DB.singles[ctx.DB.singles.findIndex(r => r.id === 'b')] = edited; // an edit replaces the row object, the id stays
  ctx.renderSingles();
  assert.equal(panelBody.writes, writes + 1);
  assert.match(panelBody.html(), /Bravo Renamed 2/);
  assert.match(panelBody.html(), /<div class="kjr-insp-vnum">S\$99<\/div>/);
  assert.match(panelBody.html(), /Card 2 of 3/);
  // a dialog closing (an edit saved, a sale confirmed) redraws too
  edited.marketPrice = 120;
  ctx.kjrInspectOnDialogClose({ target: { id: 'modal-single' } });
  assert.match(panelBody.html(), /S\$120/);
  // and the Overview redraw keeps the highlight
  assert.equal(typeof ctx.kjrInspectMark, 'function');
});

test('redraw: a card that became Sold is drawn as Sold, and one that is gone closes the panel with a note', async () => {
  const app = await appWith(three());
  const { ctx, document } = app, { panelBody, toasts, trigger } = app.dom;
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'b', { trigger });
  ctx.DB.singles.find(r => r.id === 'b').status = 'Sold';
  ctx.renderSingles();
  assert.ok(ctx._kjrInsp, 'still open');
  assert.match(panelBody.html(), /kjr-insp-chip has-dot sold">Sold</);
  assert.match(panelBody.html(), /data-insp-act="status">Mark as available</);
  assert.doesNotMatch(panelBody.html(), /Generate listing/);
  assert.match(panelBody.html(), /Card 2 of 3/);
  ctx.DB.singles = ctx.DB.singles.filter(r => r.id !== 'b');
  ctx.renderSingles();
  assert.equal(ctx._kjrInsp, null, 'closed');
  assert.equal(app.dom.panel.hidden, true);
  assert.equal(document.body.classList.contains('kjr-insp-open'), false);
  assert.deepEqual(toasts, ['That card is no longer in your collection']);
  assert.equal(panelBody.html(), '', 'the panel is emptied');
  // the panel's own Delete flags it, so the removal closes it without that note
  ctx.kjrInspect('singles', 'c', { trigger });
  ctx._kjrInsp.deleting = { table: 'singles', id: 'c' };
  ctx.DB.singles = ctx.DB.singles.filter(r => r.id !== 'c');
  ctx.renderSingles();
  assert.equal(ctx._kjrInsp, null);
  assert.deepEqual(toasts, ['That card is no longer in your collection'], 'no second note');
  // a stale id opens nothing and says so
  assert.equal(ctx.kjrInspect('singles', 'nope', {}), false);
  assert.equal(toasts.length, 2);
  assert.equal(ctx.kjrInspect('sales', 'x', {}), false, 'only singles and slabs');
});

test('redraw: the highlight is is-inspected, separate from the bulk row-selected, cleared when closed, reapplied after a redraw', async () => {
  const app = await appWith(three());
  const ctx = app.ctx, doc = app.document;
  const mkRow = (id) => { const r = doc.createElement('tr'); r.setAttribute('data-id', id); return r; };
  const rows = { a: mkRow('a'), b: mkRow('b'), c: mkRow('c') };
  const real = doc.getElementById;
  const zone = real('singles-body');
  zone.querySelectorAll = (sel) => sel === '[data-id]' ? Object.values(rows) : [];
  rows.c.classList.add('row-selected');
  doc.querySelectorAll = (sel) => sel === '.is-inspected' ? Object.values(rows).filter(r => r.classList.contains('is-inspected')) : [];
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'b', {});
  assert.deepEqual(Object.entries(rows).filter(([, r]) => r.classList.contains('is-inspected')).map(([k]) => k), ['b']);
  assert.equal(rows.c.classList.contains('row-selected'), true, 'the bulk selection is untouched');
  ctx.kjrInspectStep(1);
  assert.deepEqual(Object.entries(rows).filter(([, r]) => r.classList.contains('is-inspected')).map(([k]) => k), ['c'], 'it moves with the card');
  // a redraw replaces every row: the class is gone with them and is put back by data-id
  Object.keys(rows).forEach(k => { rows[k] = mkRow(k); });
  ctx.renderSingles();
  assert.deepEqual(Object.entries(rows).filter(([, r]) => r.classList.contains('is-inspected')).map(([k]) => k), ['c']);
  ctx.kjrInspectClose();
  assert.deepEqual(Object.entries(rows).filter(([, r]) => r.classList.contains('is-inspected')).map(([k]) => k), []);
  // the same for an Overview tile (the tile inside the wrapper) and a mover (the button itself)
  const tile = doc.createElement('button'); const wrap = doc.createElement('div');
  wrap.setAttribute('data-ov-act', 'edit'); wrap.setAttribute('data-table', 'singles'); wrap.setAttribute('data-id', 'a'); wrap.querySelector = (s) => s === '.kjr-tile' ? tile : null;
  const mover = doc.createElement('button'); mover.setAttribute('data-ov-act', 'edit'); mover.setAttribute('data-table', 'singles'); mover.setAttribute('data-id', 'a'); mover.querySelector = () => null;
  const other = doc.createElement('button'); other.setAttribute('data-ov-act', 'edit'); other.setAttribute('data-table', 'slabs'); other.setAttribute('data-id', 'a'); other.querySelector = () => null;
  real('dash-top').querySelectorAll = (s) => s === '[data-ov-act="edit"]' ? [wrap, other] : [];
  real('dash-movers').querySelectorAll = (s) => s === '[data-ov-act="edit"]' ? [mover] : [];
  doc.querySelectorAll = (sel) => sel === '.is-inspected' ? [tile, mover, other, ...Object.values(rows)].filter(r => r.classList.contains('is-inspected')) : [];
  ctx.kjrInspect('singles', 'a', {});
  assert.equal(tile.classList.contains('is-inspected'), true);
  assert.equal(wrap.classList.contains('is-inspected'), false, 'the tile carries it, not its wrapper');
  assert.equal(mover.classList.contains('is-inspected'), true);
  assert.equal(other.classList.contains('is-inspected'), false, 'same id in another table is not it');
});

// ═══ the entry points ═════════════════════════════════════════════════════════════════════════════════
function rowEvent(o) {
  o = o || {};
  const nameBtn = { classList: { contains: (c) => c === 'kjr-name-btn' } };
  const tr = { getAttribute: (k) => k === 'data-id' ? (o.id === undefined ? 'a' : o.id) : null, querySelector: (s) => s === '.kjr-name-btn' ? nameBtn : null };
  const td = { getAttribute: (k) => k === 'data-col-key' ? (o.col || 'marketPrice') : null };
  const control = o.control === 'name' ? nameBtn : (o.control ? { classList: { contains: () => false }, tagName: o.control } : null);
  const target = { closest: (sel) => sel.startsWith('input,select') ? control : (sel === 'td' ? td : (sel === 'tr' ? tr : null)) };
  return { evt: Object.assign({ target }, o.mods || {}), tr, nameBtn };
}
test('row click: opens the inspector with the row id and the name button as trigger, and leaves controls, the checkbox and actions cells and selections alone', async () => {
  const app = await appWith(three());
  const { ctx } = app;
  const calls = [];
  ctx.kjrInspect = (table, id, opts) => { calls.push([table, id, opts && opts.trigger]); return true; };
  let r = rowEvent({ col: 'datePurchased' });
  assert.equal(ctx.kjrRowClick('singles', r.evt), true);
  assert.deepEqual(calls[0].slice(0, 2), ['singles', 'a']);
  assert.equal(calls[0][2], r.nameBtn, 'focus will return to the name button');
  calls.length = 0;
  for (const control of ['INPUT', 'BUTTON', 'A', 'SELECT', 'LABEL', 'TEXTAREA']) {
    assert.equal(ctx.kjrRowClick('singles', rowEvent({ control }).evt), false, 'a click on ' + control + ' is its own');
  }
  assert.equal(ctx.kjrRowClick('singles', rowEvent({ col: '_cb' }).evt), false, 'the checkbox cell');
  assert.equal(ctx.kjrRowClick('singles', rowEvent({ col: 'actions' }).evt), false, 'the actions cell (the "…" and its menu)');
  assert.equal(ctx.kjrRowClick('singles', rowEvent({ id: '' }).evt), false, 'the empty-state row has no id');
  assert.equal(ctx.kjrRowClick('singles', rowEvent({ id: 'missing' }).evt), false, 'a row that is not in the data');
  for (const mod of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey']) assert.equal(ctx.kjrRowClick('singles', rowEvent({ mods: { [mod]: true } }).evt), false, mod + ' is for the browser');
  assert.equal(ctx.kjrRowClick('singles', null), false);
  assert.equal(ctx.kjrRowClick('singles', { target: {} }), false);
  assert.deepEqual(calls, [], 'none of those opened it');
  // the name button is the one control that does open it (Enter and Space click it)
  assert.equal(ctx.kjrRowClick('singles', rowEvent({ control: 'name' }).evt), true);
  // a text selection (a drag across the row) is not a click on it
  app.sandbox.getSelection = () => ({ isCollapsed: false, toString: () => 'Alpha' });
  assert.equal(ctx.kjrRowClick('singles', rowEvent().evt), false);
  app.sandbox.getSelection = () => ({ isCollapsed: true, toString: () => '' });
  assert.equal(ctx.kjrRowClick('singles', rowEvent().evt), true, 'a collapsed selection is fine');
  // a phone in the compact card view is kjrCompactTapClick's, so one tap never opens it twice
  app.sandbox.matchMedia = (q) => ({ matches: /max-width:600px/.test(q), addEventListener() {} });
  calls.length = 0;
  assert.equal(ctx.kjrRowClick('singles', rowEvent().evt), false);
  assert.deepEqual(calls, []);
});

test('row click: one delegated listener per tbody, the same for Singles and Slabs, none per row, and it survives a redraw', async () => {
  const { ctx, document } = await loadApp({ seed: makeSeed({ singles: [single({ id: 'a' }), single({ id: 'b' })], slabs: [slab({ id: 'p' })] }) });
  for (const id of ['singles-body', 'singles-sold-body', 'slabs-body', 'slabs-sold-body']) {
    assert.equal(document.getElementById(id)._listeners.get('click').length, 1, id + ' has exactly one click listener');
  }
  ctx.renderSingles(); ctx.renderSingles(); ctx.renderSlabs();
  assert.equal(document.getElementById('singles-body')._listeners.get('click').length, 1, 'a redraw does not stack listeners');
  assert.equal(document.getElementById('slabs-body')._listeners.get('click').length, 1);
  const calls = [];
  ctx.kjrInspect = (table, id) => { calls.push([table, id]); return true; };
  document.getElementById('slabs-body')._listeners.get('click')[0](rowEvent({ id: 'p' }).evt);
  document.getElementById('singles-sold-body')._listeners.get('click')[0](rowEvent({ id: 'b' }).evt);
  assert.deepEqual(calls, [['slabs', 'p'], ['singles', 'b']], 'each tbody knows its table');
  assert.equal(ctx.kjrInspectBindRows(), undefined);
  assert.equal(document.getElementById('singles-body')._listeners.get('click').length, 1, 'binding again is a no-op');
});

test('row markup: the card name is a button with no handler of its own, in Singles and Slabs, and the Edit button stays in the actions cell', async () => {
  const seed = makeSeed({ singles: [single({ id: 's1', name: 'Pika "Q" <b>' })], slabs: [slab({ id: 'p1', name: 'Slab <i>' })] });
  const { ctx, document } = await loadApp({ seed });
  ctx.renderSingles(); ctx.renderSlabs();
  for (const [body, name] of [['singles-body', 'Pika &quot;Q&quot; &lt;b&gt;'], ['slabs-body', 'Slab &lt;i&gt;']]) {
    const row = document.getElementById(body).innerHTML;
    assert.match(row, new RegExp('<div class="kjr-name-body"><button type="button" class="kjr-name-btn" title="' + name + '" aria-label="Open details for ' + name + '">' + name + '</button>'));
    assert.doesNotMatch(row.match(/<button type="button" class="kjr-name-btn"[^>]*>/)[0], /onclick/, 'no inline handler on the name');
    assert.doesNotMatch(row, /kjr-single-name|openEditSingle\(this/, 'the old phone-only edit button is gone');
    assert.match(row, /role="menuitem" title="Edit" onclick="openEdit(Single|Slab)\(/, 'Edit stays in the "…" menu, where tap-to-edit finds it on other tables');
  }
  assert.match(ctx.kjrNameBtnHtml({ name: '' }), />-<\/button>/);
});

test('phone tap: a Singles or Slabs name opens the inspector sheet, every other table still clicks its Edit button, controls are left alone', async () => {
  const app = await appWith(three());
  const { ctx } = app;
  app.sandbox.matchMedia = (q) => ({ matches: /max-width:600px/.test(q), addEventListener() {} });
  const calls = [];
  ctx.kjrInspect = (table, id, opts) => { calls.push([table, id, opts && opts.trigger]); return true; };
  const tapped = [];
  const nameBtn = { classList: { contains: (c) => c === 'kjr-name-btn' } };
  const editBtn = { getAttribute: (k) => k === 'title' ? 'Edit' : '', textContent: 'Edit', click: () => tapped.push('edit') };
  const make = (o) => {
    const tr = { getAttribute: (k) => k === 'data-id' ? o.id : null, querySelector: (s) => s === '.kjr-name-btn' ? nameBtn : null, querySelectorAll: (s) => s === 'td[data-col-key="actions"] button' ? [editBtn] : [] };
    const cell = { closest: (s) => s === '.page .tbl-wrap' ? {} : (s === 'tr' ? tr : (s === '#page-inventory' ? (o.page === 'singles' ? {} : null) : (s === '#page-slabs' ? (o.page === 'slabs' ? {} : null) : null))) };
    const target = { closest: (s) => s.startsWith('td[') ? cell : (s.startsWith('input,button') ? (o.control || null) : null) };
    return { target, preventDefault() { this.prevented = true; } };
  };
  let e = make({ id: 'b', page: 'singles' });
  ctx.kjrCompactTapClick(e);
  assert.deepEqual(calls[0].slice(0, 2), ['singles', 'b']);
  assert.equal(calls[0][2], nameBtn);
  assert.equal(e.prevented, true);
  assert.deepEqual(tapped, [], 'the hidden Edit button is not clicked for Singles');
  ctx.kjrCompactTapClick(make({ id: 'x', page: 'slabs' })); // no such slab: falls through to Edit
  assert.deepEqual(tapped, ['edit'], 'a row that is not in the data keeps the old behaviour');
  ctx.DB.slabs.push(slab({ id: 'p9' }));
  ctx.kjrCompactTapClick(make({ id: 'p9', page: 'slabs' }));
  assert.deepEqual(calls[1].slice(0, 2), ['slabs', 'p9']);
  tapped.length = 0;
  ctx.kjrCompactTapClick(make({ id: 'sale1', page: 'sales' }));
  assert.deepEqual(tapped, ['edit'], 'Sales, Sealed and the rest keep tap-to-edit');
  assert.equal(calls.length, 2);
  // controls inside the cell are not taps on the name, but the name button is
  ctx.kjrCompactTapClick(make({ id: 'a', page: 'singles', control: { classList: { contains: () => false } } }));
  assert.equal(calls.length, 2);
  ctx.kjrCompactTapClick(make({ id: 'a', page: 'singles', control: nameBtn }));
  assert.equal(calls.length, 3, 'the name button tap goes through');
  // not in the compact view: nothing here (the row listener has it)
  app.sandbox.matchMedia = () => ({ matches: false, addEventListener() {} });
  ctx.kjrCompactTapClick(make({ id: 'a', page: 'singles' }));
  assert.equal(calls.length, 3);
  app.sandbox.matchMedia = (q) => ({ matches: /max-width:600px/.test(q), addEventListener() {} });
  app.document.body.classList.add('force-tables');
  ctx.kjrCompactTapClick(make({ id: 'a', page: 'singles' }));
  assert.equal(calls.length, 3, 'and not in full-table mode');
});

test('entry points: a grid tile and an Overview tile call kjrInspect, the Overview with the list it was clicked in', async () => {
  const app = await appWith({ singles: [single({ id: 'one' })], slabs: [slab({ id: 'two' })] });
  const { ctx } = app;
  const calls = [];
  ctx.kjrInspect = (table, id, opts) => { calls.push({ table, id, opts: plain(opts && opts.order), trigger: opts && opts.trigger }); return true; };
  const mk = (table, id, extra) => {
    const holder = Object.assign({ tagName: 'DIV', getAttribute: (k) => ({ 'data-ov-act': 'edit', 'data-table': table, 'data-id': id })[k] || null }, extra || {});
    return { target: { closest: () => holder } };
  };
  const item = (table, id) => ({ getAttribute: (k) => ({ 'data-table': table, 'data-id': id })[k] });
  const inner = { tagName: 'BUTTON' };
  const list = { querySelectorAll: (s) => s === '[data-ov-act="edit"]' ? [item('singles', 'one'), item('slabs', 'two')] : [] };
  ctx._kjrOvClick(mk('singles', 'one', { closest: (s) => s === '#dash-top, #dash-movers' ? list : null, querySelector: (s) => s === 'button' ? inner : null }));
  assert.deepEqual(calls[0].opts, [{ table: 'singles', id: 'one' }, { table: 'slabs', id: 'two' }], 'the tiles of that list, in the order drawn');
  assert.equal(calls[0].trigger, inner, 'the tile button takes focus back');
  ctx._kjrOvClick(mk('slabs', 'two')); // a holder that cannot say which list it is in
  assert.equal(calls[1].opts, undefined, 'no list: kjrInspect uses the table\'s own order');
  assert.equal(calls[1].table, 'slabs');
  ctx.kjrInspect = undefined; // features.js missing or failed: the Overview still opens something useful
  const edits = [];
  ctx.openEditSingle = (id) => edits.push(['single', id]);
  ctx.openEditSlab = (id) => edits.push(['slab', id]);
  ctx._kjrOvClick(mk('singles', 'one'));
  ctx._kjrOvClick(mk('slabs', 'two'));
  assert.deepEqual(edits, [['single', 'one'], ['slab', 'two']]);
});

// ═══ keyboard and focus ═══════════════════════════════════════════════════════════════════════════════
test('desktop: focus moves to the title on open and Esc closes the panel and puts focus back on the trigger', async () => {
  const app = await appWith(three());
  const { ctx, document } = app, { panelBody, panel, trigger, key } = app.dom;
  ctx.renderSingles();
  assert.equal(ctx.kjrInspect('singles', 'b', { trigger }), true);
  assert.equal(panel.hidden, false);
  assert.equal(document.body.classList.contains('kjr-insp-open'), true, 'the page makes room for it (styles.css, 1280px and wider)');
  assert.equal(document.activeElement, panelBody.querySelector('#kjr-insp-title'), 'focus is on the title');
  assert.equal(ctx._kjrInsp.mode, 'panel');
  const esc = key('Escape');
  ctx.kjrInspectOnKey(esc);
  assert.equal(esc.defaultPrevented, true);
  assert.equal(ctx._kjrInsp, null);
  assert.equal(panel.hidden, true);
  assert.equal(document.body.classList.contains('kjr-insp-open'), false);
  assert.equal(document.activeElement, trigger, 'back on what opened it');
  assert.equal(trigger.focusCount, 1);
  const again = key('Escape');
  ctx.kjrInspectOnKey(again);
  assert.equal(again.defaultPrevented, false, 'closed: Esc is left alone');
});

test('desktop: Esc and the arrow keys leave a dialog, the row menu, a nav dropdown, a form field and modified keys alone', async () => {
  const app = await appWith(three());
  const { ctx, document } = app, { trigger, key, openDialogs } = app.dom;
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'a', { trigger });
  const fired = (k, extra) => { const e = key(k, undefined, extra); ctx.kjrInspectOnKey(e); return e.defaultPrevented; };
  openDialogs.push({ id: 'modal-single' });
  assert.equal(fired('Escape'), false, 'a dialog is open: its own Esc closes it');
  assert.equal(fired('ArrowDown'), false);
  assert.equal(ctx._kjrInsp.id, 'a');
  openDialogs.length = 0;
  ctx._kjrRowMenu = { btn: { isConnected: true }, menu: {} };
  assert.equal(fired('Escape'), false, 'the "…" menu closes itself first');
  assert.equal(fired('ArrowDown'), false);
  ctx._kjrRowMenu = null;
  document.querySelector = (sel) => sel === '.nav-dd.open' ? {} : null;
  assert.equal(fired('Escape'), false, 'a nav dropdown is open');
  document.querySelector = () => null;
  for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
    const e = key('Escape', { tagName: tag }); ctx.kjrInspectOnKey(e);
    assert.equal(e.defaultPrevented, false, 'typing in a ' + tag);
    const d = key('ArrowDown', { tagName: tag }); ctx.kjrInspectOnKey(d);
    assert.equal(ctx._kjrInsp.id, 'a');
  }
  const editable = key('j', { tagName: 'DIV', isContentEditable: true }); ctx.kjrInspectOnKey(editable);
  assert.equal(ctx._kjrInsp.id, 'a');
  for (const mod of ['ctrlKey', 'metaKey', 'altKey']) assert.equal(fired('Escape', { [mod]: true }), false, mod);
  assert.equal(fired('ArrowDown', { metaKey: true }), false);
  assert.equal(fired('a'), false, 'other keys are not ours');
  const more = { tagName: 'BUTTON', closest: (s) => s === '.kjr-more' ? {} : null };
  const onMore = key('ArrowDown', more); ctx.kjrInspectOnKey(onMore);
  assert.equal(onMore.defaultPrevented, false, 'ArrowDown on the "…" opens its menu, it does not step');
  assert.equal(ctx._kjrInsp.id, 'a');
  const handled = key('Escape'); handled.defaultPrevented = true; ctx.kjrInspectOnKey(handled);
  assert.ok(ctx._kjrInsp, 'a key something else already used is not ours');
  const drawer = document.getElementById('sentry-drawer'); drawer.classList.add('open');
  assert.equal(fired('Escape'), false, 'the Sentry drawer');
  drawer.classList.remove('open');
  assert.equal(fired('Escape'), true, 'and with nothing else in the way it closes');
});

test('desktop: Down, Up, j and k step through the order, stop at the ends and keep focus on the control that had it', async () => {
  const app = await appWith(three());
  const { ctx, document } = app, { panelBody, trigger, key } = app.dom;
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'a', { trigger });
  const press = (k) => { const e = key(k); ctx.kjrInspectOnKey(e); return e.defaultPrevented; };
  assert.equal(press('ArrowDown'), true);
  assert.equal(ctx._kjrInsp.id, 'b');
  assert.equal(press('j'), true);
  assert.equal(ctx._kjrInsp.id, 'c');
  assert.equal(press('ArrowDown'), true, 'the key is ours even at the end, so the page does not scroll under it');
  assert.equal(ctx._kjrInsp.id, 'c');
  assert.equal(press('ArrowUp'), true);
  assert.equal(press('k'), true);
  assert.equal(ctx._kjrInsp.id, 'a');
  // focus: the redraw replaces every control, the one that had focus gets it back, by what it does
  const next = panelBody.control('next');
  next.focus();
  assert.equal(document.activeElement, next);
  ctx.kjrInspectStep(1);
  const nextNow = panelBody.control('next');
  assert.notEqual(nextNow, next, 'a new control');
  assert.equal(next.isConnected, false, 'the old one left the page');
  assert.equal(document.activeElement, nextNow, 'focus is on the new Next');
  ctx.kjrInspectStep(1); // the end: Next is disabled, so its neighbour Previous takes focus
  assert.equal(panelBody.control('next').disabled, true);
  assert.equal(document.activeElement, panelBody.control('prev'));
  // a change from the data keeps focus too (Mark as sold becomes Mark as available)
  panelBody.control('status').focus();
  ctx.DB.singles.find(r => r.id === 'c').status = 'Sold';
  ctx.renderSingles();
  assert.match(panelBody.html(), /Mark as available/);
  assert.equal(document.activeElement, panelBody.control('status'), 'still on the primary action');
});

test('desktop: moving the panel to another card announces it, resets scroll, and re-clicking a card reuses the open panel', async () => {
  const app = await appWith(three());
  const ctx = app.ctx, { real, panelBody, trigger } = app.dom;
  ctx.kjrInspect('singles', 'a', { trigger });
  assert.equal(real('kjr-insp-live').textContent, 'Card 1 of 1, Alpha 1');
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'a', { trigger });
  panelBody.scrollTop = 240;
  ctx.kjrInspect('singles', 'b', { trigger: { isConnected: true, focus() {} } });
  assert.equal(real('kjr-insp-live').textContent, 'Card 2 of 3, Bravo 2');
  assert.equal(panelBody.scrollTop, 0, 'a different card starts at the top');
  panelBody.scrollTop = 240;
  ctx.DB.singles.find(r => r.id === 'b').marketPrice = 77;
  ctx.renderSingles();
  assert.equal(panelBody.scrollTop, 240, 'the same card redrawn keeps its scroll position');
  assert.equal(real('kjr-insp-live').textContent, 'Card 2 of 3, Bravo 2', 'and is not announced again');
  const opens = []; app.dom.sheet.showModal = () => opens.push('sheet');
  ctx.kjrInspect('singles', 'c', {});
  assert.deepEqual(opens, [], 'moving to another card never re-opens a host');
  assert.equal(ctx._kjrInsp.id, 'c');
});

test('desktop: another page closes the panel, the same page keeps it, and a dialog closing redraws it and gives focus back to the control', async () => {
  const app = await appWith(three());
  const { ctx, document } = app, { panelBody, trigger } = app.dom;
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'b', { trigger });
  assert.equal(ctx._kjrInsp.page, 'inventory');
  ctx.kjrInspectOnPage('inventory');
  assert.ok(ctx._kjrInsp, 'the same page keeps it');
  ctx.kjrInspectOnPage('slabs');
  assert.equal(ctx._kjrInsp, null, 'another page closes it');
  assert.equal(trigger.focusCount, 0, 'without pulling focus to a row on a page that just went away');
  // opened from the Overview, the page is the Overview's
  document.querySelector = (sel) => sel === '.page.active' ? { id: 'page-dashboard' } : null;
  ctx.kjrInspect('singles', 'a', {});
  assert.equal(ctx._kjrInsp.page, 'dashboard');
  ctx.kjrInspectOnPage('dashboard');
  assert.ok(ctx._kjrInsp);
  ctx.kjrInspectOnPage('inventory');
  assert.equal(ctx._kjrInsp, null);
  document.querySelector = () => null;
  // a dialog opened from the panel hands focus back to a trigger the redraw replaced: focus is lost until the settle step
  ctx.kjrInspect('singles', 'b', { trigger });
  const edit = panelBody.control('edit');
  edit.focus();
  ctx.kjrInspectOnFocusIn({ target: edit }); // the document-level focusin listener, not wired in the harness
  assert.equal(ctx._kjrInsp.focusKey, 'edit');
  assert.equal(ctx._kjrInsp.zone, 'insp');
  document.activeElement = null; // the dialog closed and its trigger had already been replaced
  ctx.DB.singles.find(r => r.id === 'b').name = 'Renamed';
  ctx.kjrInspectOnDialogClose({ target: { id: 'modal-single' } });
  const flush = () => { const calls = [...app.rafState.calls.values()]; app.rafState.calls.clear(); calls.forEach(f => f()); };
  flush(); flush();
  assert.equal(document.activeElement, panelBody.control('edit'), 'back on Edit');
  // but focus that landed somewhere real is not taken
  document.activeElement = trigger;
  ctx.kjrInspectOnDialogClose({ target: { id: 'modal-single' } });
  flush(); flush();
  assert.equal(document.activeElement, trigger);
  // focus on the page side (the user went back to the list) is not stolen either
  ctx.kjrInspectOnFocusIn({ target: { closest: () => null } });
  assert.equal(ctx._kjrInsp.zone, 'page');
  document.activeElement = null;
  ctx.kjrInspectOnDialogClose({ target: { id: 'modal-single' } });
  flush(); flush();
  assert.equal(document.activeElement, null);
});

// ═══ the sheet ═══════════════════════════════════════════════════════════════════════════════════════
test('sheet: at 900px or narrower the same content opens through kjrModalCtrl, and Esc, Back and a tap outside all clear the state', async () => {
  const app = await appWith(three());
  const { ctx, document } = app, { sheet, sheetBody, panel, panelBody, trigger, narrow, key } = app.dom;
  narrow(true);
  ctx.renderSingles();
  assert.equal(ctx.kjrInspect('singles', 'b', { trigger }), true);
  assert.equal(ctx._kjrInsp.mode, 'sheet');
  assert.equal(sheet.open, true, 'a modal dialog');
  assert.equal(typeof sheet._kjrOnClose, 'function', 'closed through the controller, so every path runs our hook');
  assert.equal(document.body.style.overflow, 'hidden', 'scroll lock from the controller');
  assert.match(sheetBody.html(), /Card 2 of 3/);
  assert.equal(panelBody.html(), '', 'only one host holds content');
  assert.equal(panel.hidden !== false, true);
  assert.equal(document.body.classList.contains('kjr-insp-open'), false, 'no split view for the sheet');
  assert.equal(document.activeElement, sheetBody.querySelector('#kjr-insp-title'));
  // Esc belongs to the dialog's own handler in the sheet
  const esc = key('Escape'); ctx.kjrInspectOnKey(esc);
  assert.equal(esc.defaultPrevented, false);
  assert.ok(ctx._kjrInsp);
  // the controller's cancel handler (Esc, then the Back button's popstate close and the backdrop click go the same way)
  sheet._listeners.get('cancel')[0]({ preventDefault() {} });
  assert.equal(ctx._kjrInsp, null);
  assert.equal(sheet.open, false);
  assert.equal(sheetBody.html(), '');
  assert.equal(document.body.style.overflow, '', 'scroll lock released');
  // close() from our side closes the dialog too
  ctx.kjrInspect('singles', 'c', { trigger });
  assert.equal(sheet.open, true);
  ctx.kjrInspectClose();
  assert.equal(sheet.open, false);
  assert.equal(ctx._kjrInsp, null);
  // the Back button: the controller closes the dialog and runs the hook
  ctx.kjrInspect('singles', 'a', { trigger });
  sheet._kjrOnClose();
  assert.equal(ctx._kjrInsp, null);
  // the arrow keys step in the sheet too, unless another dialog is on top of it
  ctx.kjrInspect('singles', 'a', { trigger });
  app.dom.openDialogs.push({ id: 'kjr-insp-sheet' });
  const down = key('ArrowDown'); ctx.kjrInspectOnKey(down);
  assert.equal(ctx._kjrInsp.id, 'b', 'our own sheet being open is not "a dialog is open"');
  app.dom.openDialogs.push({ id: 'modal-single' });
  const blocked = key('ArrowDown'); ctx.kjrInspectOnKey(blocked);
  assert.equal(ctx._kjrInsp.id, 'b');
});

test('sheet: Edit stacks its dialog over the sheet, the sheet redraws when it closes, and a resize across 900px moves the card between hosts', async () => {
  const app = await appWith(three());
  const { ctx } = app, { sheet, sheetBody, panel, panelBody, trigger, narrow } = app.dom;
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'b', { trigger }); // panel
  assert.equal(panelBody.html().includes('Card 2 of 3'), true);
  narrow(true);
  ctx.kjrInspectRehost();
  assert.equal(ctx._kjrInsp.mode, 'sheet');
  assert.equal(sheet.open, true);
  assert.equal(panel.hidden, true);
  assert.equal(panelBody.html(), '', 'the panel is emptied');
  assert.match(sheetBody.html(), /Card 2 of 3/, 'same card, same order');
  assert.equal(app.document.body.classList.contains('kjr-insp-open'), false);
  assert.ok(ctx._kjrInsp, 'a rehost is not a close');
  narrow(false);
  ctx.kjrInspectRehost();
  assert.equal(ctx._kjrInsp.mode, 'panel');
  assert.equal(sheet.open, false);
  assert.equal(sheetBody.html(), '');
  assert.equal(panel.hidden, false);
  assert.match(panelBody.html(), /Card 2 of 3/);
  assert.equal(app.document.body.classList.contains('kjr-insp-open'), true);
  ctx.kjrInspectRehost(); // nothing to do
  assert.equal(ctx._kjrInsp.mode, 'panel');
  // a click that opens a card while the window is narrow but the panel is the open host moves the host first
  narrow(true);
  ctx.kjrInspect('singles', 'c', {});
  assert.equal(ctx._kjrInsp.mode, 'sheet');
  assert.equal(ctx._kjrInsp.id, 'c');
  // the sheet markup is one body, the panel another, and the redraw after a dialog close targets whichever is open
  ctx.DB.singles.find(r => r.id === 'c').name = 'Charlie Renamed';
  ctx.kjrInspectOnDialogClose({ target: { id: 'modal-single' } });
  assert.match(sheetBody.html(), /Charlie Renamed/);
  ctx.kjrInspectOnDialogClose({ target: { id: 'kjr-insp-sheet' } }); // our own sheet closing is handled by its hook, not here
  assert.ok(ctx._kjrInsp);
});

// ═══ the actions ═════════════════════════════════════════════════════════════════════════════════════
test('actions: each control hands over to the function the list already uses, with the row\'s own id', async () => {
  const app = await appWith({ singles: [single({ id: 7, name: 'Numeric Id' }), single({ id: 'b', name: 'B', status: 'Sold' })], slabs: [slab({ id: 'p1' })] });
  const { ctx } = app, { panelBody, trigger } = app.dom;
  const calls = [];
  ctx.markStatus = (...a) => { calls.push(['status', ...a]); return Promise.resolve(); };
  ctx.openEditSingle = (...a) => calls.push(['editSingle', ...a]);
  ctx.openEditSlab = (...a) => calls.push(['editSlab', ...a]);
  ctx.openListingFor = (...a) => calls.push(['listing', ...a, ctx._kjrInsp === null ? 'closed-first' : 'open']);
  const click = (act) => ctx.kjrInspectOnClick({ target: panelBody.control(act) });
  ctx.kjrInspect('singles', '7', { trigger });
  click('status');
  click('edit');
  assert.deepEqual(calls, [['status', 'singles', 7, 'Sold'], ['editSingle', 7]], 'the id keeps the type it has in the data (a number, not "7")');
  calls.length = 0;
  click('listing');
  assert.deepEqual(calls, [['listing', 'singles', 7, 'closed-first']], 'the workspace is another page: the panel closes first');
  assert.equal(ctx._kjrInsp, null);
  ctx.kjrInspect('singles', 'b', { trigger });
  calls.length = 0;
  click('status');
  assert.deepEqual(calls, [['status', 'singles', 'b', 'Available']], 'a sold card goes back to Available');
  assert.equal(panelBody.control('listing'), null, 'and has no listing action');
  ctx.kjrInspect('slabs', 'p1', { trigger });
  calls.length = 0;
  click('edit');
  click('status');
  assert.deepEqual(calls, [['editSlab', 'p1'], ['status', 'slabs', 'p1', 'Sold']]);
  click('close');
  assert.equal(ctx._kjrInsp, null);
  // the "…" and a click on nothing do nothing here, the row menu controller owns the "…"
  ctx.kjrInspect('singles', 'b', { trigger });
  calls.length = 0;
  click('more');
  ctx.kjrInspectOnClick({ target: { closest: () => null } });
  ctx.kjrInspectOnClick(null);
  assert.deepEqual(calls, []);
  // an action that throws is reported, never left to break the page
  ctx.openEditSingle = () => { throw new Error('boom'); };
  const warn = []; app.dom.toasts.length = 0;
  click('edit');
  assert.deepEqual(app.dom.toasts, ['ERR That did not complete. Try again.']);
  ctx.markStatus = () => Promise.reject(new Error('later'));
  click('status');
  await app.settle();
  assert.ok(app.dom.toasts.includes('ERR That did not complete. Try again.'));
  assert.equal(app.consoleErrors.length >= 2, true, 'and logged');
});

test('actions: Delete closes the panel once the card is gone, stays open when cancelled, and never says "no longer in your collection" for its own delete', async () => {
  const app = await appWith(three());
  const { ctx } = app, { panelBody, trigger, toasts } = app.dom;
  ctx.renderSingles();
  ctx.kjrInspect('singles', 'b', { trigger });
  let finish;
  const calls = [];
  ctx.deleteItem = (id, table) => { calls.push([id, table]); return new Promise(res => { finish = res; }); };
  ctx.kjrInspectOnClick({ target: panelBody.control('delete') });
  assert.deepEqual(calls, [['b', 'singles']], 'deleteItem(id, table), the same call the row menu makes');
  assert.deepEqual(plain(ctx._kjrInsp.deleting), { table: 'singles', id: 'b' });
  assert.ok(ctx._kjrInsp, 'open while the confirm is up');
  finish(); // cancelled: the row is still there
  await app.settle();
  assert.ok(ctx._kjrInsp, 'still open');
  assert.equal(ctx._kjrInsp.deleting, null, 'the flag is cleared');
  // confirmed: the row leaves the data and the list redraws before deleteItem resolves
  ctx.deleteItem = (id, table) => new Promise(res => { setTimeout(() => {}, 0); ctx.DB.singles = ctx.DB.singles.filter(r => r.id !== id); ctx.renderSingles(); res(); });
  ctx.kjrInspectOnClick({ target: panelBody.control('delete') });
  await app.settle();
  assert.equal(ctx._kjrInsp, null, 'closed');
  assert.deepEqual(toasts, [], 'silently: deleteItem has its own "Moved to trash" note');
  assert.equal(ctx.DB.singles.some(r => r.id === 'b'), false);
  // a delete that rejects is reported and the flag does not stick
  ctx.kjrInspect('singles', 'a', { trigger });
  ctx.deleteItem = () => Promise.reject(new Error('nope'));
  ctx.kjrInspectOnClick({ target: panelBody.control('delete') });
  await app.settle();
  assert.deepEqual(toasts, ['ERR That did not complete. Try again.']);
  assert.equal(ctx._kjrInsp.deleting, null);
});

test('actions: Refresh price calls refreshPrice once, explains itself when it is off, and never prices a manual single', async () => {
  const app = await appWith({ singles: [single({ id: 'a', name: 'Charizard ex 223' }), single({ id: 'j', name: 'Pikachu 25', language: 'JP' })] });
  const { ctx } = app, { panelBody, trigger, toasts } = app.dom;
  const calls = [];
  let release;
  ctx.refreshPrice = (id, table) => { calls.push([id, table]); return new Promise(res => { release = res; }); };
  ctx.kjrInspect('singles', 'a', { trigger });
  ctx.kjrInspectOnClick({ target: panelBody.control('refresh') });
  ctx.kjrInspectOnClick({ target: panelBody.control('refresh') }); // a second click while it runs
  assert.deepEqual(calls, [['a', 'singles']], 'one request');
  release();
  await app.settle();
  ctx.kjrInspectOnClick({ target: panelBody.control('refresh') });
  assert.equal(calls.length, 2, 'free again once it finished');
  release(); await app.settle();
  // a manual-price single: the control is aria-disabled and says why instead of calling out
  calls.length = 0;
  ctx.kjrInspect('singles', 'j', { trigger });
  const jp = panelBody.control('refresh');
  assert.match(jp._attrs, /aria-disabled="true"/);
  ctx.kjrInspectOnClick({ target: jp });
  assert.deepEqual(calls, []);
  assert.deepEqual(toasts, ['Manual price, no free source for this language']);
  // and the same guard sits behind the click, not only behind the markup
  toasts.length = 0;
  ctx.location = Object.assign({}, ctx.location, { hostname: '127.0.0.1', protocol: 'http:' });
  ctx.kjrInspect('singles', 'a', { trigger });
  ctx.kjrInspectAct('refresh', ctx._kjrInsp, ctx.DB.singles.find(r => r.id === 'a'));
  assert.deepEqual(calls, []);
  assert.deepEqual(toasts, ['Price refresh is disabled in local preview (sync off). Use the live site.']);
});

// ═══ nothing is written ══════════════════════════════════════════════════════════════════════════════
test('no writes: opening, stepping, redrawing, the highlight and closing never touch the data, the stored payload or the sync queue', async () => {
  const app = await appWith({
    singles: [single({ id: 'a', name: 'A', priceHistory: hist([[5, 10], [1, 12]]) }), single({ id: 'b', name: 'B', status: 'Sold' }), single({ id: 'c', name: 'C', language: 'JP' })],
    slabs: [slab({ id: 'p1' })],
  });
  const { ctx, localStorage, fetchMock } = app, { trigger } = app.dom;
  ctx.renderSingles(); ctx.renderSlabs();
  const counts = { markDirty: 0, saveData: 0, snapshot: 0, log: 0 };
  for (const [name, key] of [['markDirty', 'markDirty'], ['saveData', 'saveData'], ['snapshotForUndo', 'snapshot'], ['clLog', 'log']]) {
    const real = ctx[name]; ctx[name] = (...a) => { counts[key]++; return real(...a); };
  }
  const before = { db: JSON.stringify(plain(ctx.DB)), store: localStorage.getItem('pokeinventory_v3'), keys: localStorage._store.size, dirty: JSON.stringify([...(ctx._dirty && ctx._dirty.singles || [])]) };
  const fetches = fetchMock.calls.length;
  ctx.kjrInspect('singles', 'a', { trigger });
  ctx.kjrInspectStep(1); ctx.kjrInspectStep(1); ctx.kjrInspectStep(-1);
  ctx.renderSingles(); ctx.renderSlabs();
  ctx.kjrInspectOnDialogClose({ target: { id: 'modal-single' } });
  ctx.kjrInspect('slabs', 'p1', { order: [{ table: 'singles', id: 'a' }, { table: 'slabs', id: 'p1' }] });
  ctx.kjrInspectStep(-1);
  ctx.kjrInspectMark();
  ctx.kjrInspectClose();
  app.dom.narrow(true);
  ctx.kjrInspect('singles', 'c', { trigger });
  ctx.kjrInspectClose();
  assert.equal(JSON.stringify(plain(ctx.DB)), before.db, 'the data is the same bytes');
  assert.equal(localStorage.getItem('pokeinventory_v3'), before.store, 'so is the stored payload');
  assert.equal(localStorage._store.size, before.keys, 'no new storage key');
  assert.deepEqual(counts, { markDirty: 0, saveData: 0, snapshot: 0, log: 0 }, 'no markDirty, no save, no undo snapshot, no changelog entry');
  assert.equal(fetchMock.calls.length, fetches, 'and it never fetches');
  assert.equal(JSON.stringify([...(ctx._dirty && ctx._dirty.singles || [])]), before.dirty, 'nothing queued for sync');
  const body = src();
  assert.doesNotMatch(body, /\bmarkDirty\(|\bsaveData\(|\bsaveAllToSupabase\(|snapshotForUndo\(|\.push\(\s*\{[^}]*priceHistory|DB\.(singles|slabs)\s*=[^=]/, 'the section has no write call');
  assert.doesNotMatch(body, /localStorage\.setItem|fetch\(/, 'and no storage or network call of its own');
});

// ═══ the page: markup and CSS ═══════════════════════════════════════════════════════════════════════
test('markup: one aside and one dialog at body level, labelled by the title, with no inline handler', () => {
  const block = html.slice(html.indexOf('<!-- CARD INSPECTOR (v3.72)'), html.indexOf('<!-- ═══════════════════════════════════════════════════════════\n     STALE-SHELL'));
  assert.ok(block.length > 300 && block.length < 1500);
  assert.match(block, /<aside id="kjr-inspector" class="kjr-insp" aria-labelledby="kjr-insp-title" hidden>/);
  assert.match(block, /<dialog class="sheet-overlay kjr-insp-overlay" id="kjr-insp-sheet" aria-labelledby="kjr-insp-title">/);
  assert.match(block, /<div class="sr-only" id="kjr-insp-live" role="status" aria-live="polite" aria-atomic="true"><\/div>/);
  assert.match(block, /<div class="kjr-insp-scroll" id="kjr-insp-body"><\/div>/);
  assert.match(block, /<div class="kjr-insp-scroll" id="kjr-insp-sheet-body"><\/div>/);
  assert.doesNotMatch(block, /\son\w+=/i, 'no inline handler');
  // body level: not inside a page or the .main wrapper
  const before = html.slice(0, html.indexOf('<aside id="kjr-inspector"'));
  assert.equal((before.match(/<div class="main">/g) || []).length - (before.match(/<\/div>\s*<!-- end main/g) || []).length >= 0, true);
  assert.ok(before.lastIndexOf('<div class="bottom-tab-bar"') > before.lastIndexOf('<div id="page-trash"'), 'after the pages and the tab bar');
  assert.equal((html.match(/id="kjr-insp-title"/g) || []).length, 0, 'the title id exists only in the drawn content, so it stays unique');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
  for (const id of ['kjr-inspector', 'kjr-insp-live', 'kjr-insp-body', 'kjr-insp-sheet', 'kjr-insp-sheet-live', 'kjr-insp-sheet-body']) assert.equal(ids.filter(x => x === id).length, 1, id + ' is unique');
});

test('css: the Step 5 section uses tokens only, sets the panel geometry from the packet, and keeps the "…" menu out of a transformed box', () => {
  const start = css.indexOf('/* ═══════════ Card inspector (redesign Step 5, v3.72)');
  assert.ok(start > 0 && css.indexOf('Table cleanup (redesign Step 4') < start, 'new and last in the file');
  const sec = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, ''); // rules only, the comments explain themselves
  assert.doesNotMatch(sec, /#[0-9a-fA-F]{3,8}\b(?![-\w])/, 'no hex colour, tokens only');
  assert.doesNotMatch(sec.replace(/rgba?\(0,0,0/g, ''), /rgba?\(/, 'and no colour function with a literal');
  const panel = sec.match(/#kjr-inspector\{([^}]*)\}/)[1];
  // v3.73: there is no top bar any more (a sidebar or a rail sits beside the page), so the panel starts at the top of the window
  assert.match(panel, /position:fixed;top:env\(safe-area-inset-top\);right:0;bottom:0;z-index:120;/);
  assert.match(panel, /width:min\(440px,100vw\)/);
  assert.match(panel, /background:var\(--bg2\)/);
  assert.match(panel, /border-left:1px solid var\(--border\)/);
  assert.match(panel, /box-shadow:var\(--shadow-lg\)/);
  assert.doesNotMatch(panel, /(?:^|;)transform:/, 'no transform at rest: a fixed menu inside would become relative to it');
  assert.doesNotMatch(sec, /will-change/);
  assert.match(sec, /@starting-style\{#kjr-inspector:not\(\[hidden\]\)\{transform:translateX\(24px\);opacity:0\}\}/);
  assert.match(sec, /#kjr-inspector\[hidden\]\{display:none\}/);
  // v3.73: the page sits to the right of the sidebar, so the margin a 1400px page leaves on the right is measured from the width
  // the sidebar leaves it (--kjr-side-w), not from the whole window
  assert.match(sec, /@media\(min-width:1280px\)\{\s*body\.kjr-insp-open \.main:has\(\.page\.active\)\{padding-right:max\(24px,calc\(456px - max\(0px,\(100vw - var\(--kjr-side-w\) - 1400px\) \/ 2\)\)\)\}/, 'from 1280px the page makes room: the panel plus 16px, less the margin a 1400px page already leaves beside the sidebar');
  const sheet = sec.match(/\.kjr-insp-sheet\{([^}]*)\}/)[1];
  assert.match(sheet, /max-height:calc\(100dvh - env\(safe-area-inset-top\)\)/);
  assert.match(sheet, /border-radius:20px 20px 0 0/);
  assert.doesNotMatch(sheet, /(?:^|;)transform:/);
  assert.match(sec, /\.kjr-insp-sheet \.sheet-handle\{/, 'the top handle');
  assert.match(sec, /\.kjr-insp-scroll\{[^}]*padding:0 24px calc\(24px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(sec, /\.kjr-insp-stage\{[^}]*aspect-ratio:1\/0\.92/);
  assert.match(sec, /\.kjr-insp-card\{[^}]*width:50%;aspect-ratio:63\/88/);
  assert.match(sec, /\.kjr-insp-title\{[^}]*font-size:24px;line-height:30px;font-weight:600/);
  assert.match(sec, /\.kjr-insp-vnum\{[^}]*font-size:32px;line-height:38px;font-weight:600/);
  assert.match(sec, /\.kjr-insp-value\{[^}]*background:var\(--bg\)/, 'the inset panel is --bg');
  assert.match(sec, /\.kjr-insp-line\{[^}]*stroke:var\(--accent\)/);
  assert.match(sec, /\.kjr-insp-costline\{[^}]*stroke-dasharray:4 4/);
  assert.match(sec, /tr\.is-inspected>td,#page-slabs tbody tr\.is-inspected>td\{background:var\(--accent-soft\);box-shadow:inset 0 1px 0 var\(--b-slab-bd\)/, 'accent-soft plus a 1px ring');
  assert.match(sec, /\.kjr-tile\.is-inspected \.kjr-tile-stage\{background:var\(--accent-soft\);border-color:var\(--b-slab-bd\)/);
  assert.doesNotMatch(sec, /row-selected/, 'separate from the bulk selection');
  assert.match(sec, /@media\(prefers-reduced-motion:reduce\)\{[^}]*\}\s*\.kjr-insp-sheen\{display:none\}|\.kjr-insp-sheen\{display:none\}/, 'no sheen under reduced motion');
  assert.match(sec.slice(sec.indexOf('@media(prefers-reduced-motion:reduce)')), /\.kjr-insp-card\{transform:none\}/);
  assert.match(sec, /@media\(pointer:coarse\)\{\s*\.kjr-insp-ib\{width:44px;height:44px\}/);
  assert.match(sec, /\.kjr-insp-ib\{[^}]*width:36px;height:36px/, '36px on a fine pointer');
  assert.match(sec, /@media \(max-width: 900px\)\{\s*#kjr-inspector\{display:none!important\}/, 'a narrow window never shows the panel');
  assert.equal(css.lastIndexOf('@media(max-width:900px){') < start, true, 'tests/overview.test.js finds the Overview\'s 900px block with lastIndexOf on the compact form, so this section writes its own with spaces');
  assert.match(sec, /\.kjr-name-btn\{[^}]*background:transparent;color:inherit;font:inherit/);
  assert.doesNotMatch(css, /kjr-single-name/, 'the retired phone-only name button is gone from the stylesheet');
  assert.match(sec, /body\.kjr-insp-open #toast\{right:464px\}/, 'the toast steps left of the panel');
});
