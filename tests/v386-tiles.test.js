'use strict';
// v3.86 tiles: the gain label (the S$ gain always, the percentage from S$10 of cost), the honest Manual price note, the price age
// line, the count on a grouped holding's tile and the PriceCharting link in the card inspector's "…" menu. All pure builders, so the
// checks run on the markup strings with a fixed clock passed in, and nothing here needs a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, makeSeed, plain, ROOT } = require('./harness.js');

// Noon UTC on 11 Oct 2026: the same calendar day in every timezone from UTC-11 to UTC+11, so "today" is stable.
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const dayIso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString().slice(0, 10);
const single = (o) => Object.assign({}, makeSeed().singles[0], o);
const slab = (o) => Object.assign({
  id: 'slab_1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '', language: 'EN',
  costPrice: 520, marketPrice: 610, listPrice: '', status: 'Available',
}, o);
// A price looked up `days` days ago, the way the price code leaves it: a dated history entry, the stored price equal to it.
const looked = (days, price, source) => ({
  marketPrice: price,
  priceHistory: [{ date: dayIso(days), price, unit: 'USD', source: source || 'TCGdex (TCGplayer)', confidence: 'high' }],
});
const BASE = 'https://www.pricecharting.com/search-products?type=prices&q=';

// ── The gain label ──────────────────────────────────────────────────────────────────────────────────────

test('gain label: the S$ gain always shows, the percentage only when the cost is S$10 or more', async () => {
  const { ctx } = await loadApp();
  const p = (market, cost) => plain(ctx.kjrTilePct(market, cost));
  assert.deepEqual(p(645, 2), { cls: 'pos', text: '▲ +S$643' }, 'bought for S$2: the gain alone, no +32150%');
  assert.deepEqual(p(60, 48), { cls: 'pos', text: '▲ +S$12 · +25.0%' }, 'S$10 or more: the gain, then the percentage');
  assert.deepEqual(p(11, 10), { cls: 'pos', text: '▲ +S$1 · +10.0%' }, 'a cost of exactly S$10 shows the percentage');
  assert.deepEqual(p(11, 9.99), { cls: 'pos', text: '▲ +S$1' }, 'and 9.99 does not');
  assert.deepEqual(p(4, 8), { cls: 'neg', text: '▼ -S$4' }, 'a loss on a cheap card');
  assert.deepEqual(p(75, 100), { cls: 'neg', text: '▼ -S$25 · -25.0%' }, 'a loss on a dearer one');
  assert.deepEqual(p(1380, 10), { cls: 'pos', text: '▲ +S$1,370 · +13700%' }, 'thousands separators, and 100% or more drops the decimal');
  assert.deepEqual(p(9.3, 9), { cls: 'pos', text: '▲ +<S$1' }, 'a gain under half a dollar reads <S$1, like every other S$ here');
  assert.deepEqual(p(5, 5), { cls: '', text: 'S$0' }, 'flat on a cheap card');
  assert.deepEqual(p(50, 50), { cls: '', text: '0%' }, 'flat on S$10 or more, as before');
  assert.deepEqual(p(10, 10), { cls: '', text: '0%' });
  assert.deepEqual(p(10.001, 10), { cls: '', text: '0%' }, 'a change that rounds to 0.0% is flat');
  for (const [m, c] of [[0, 5], [5, 0], ['', 5], [5, ''], [NaN, 5], [5, NaN], [Infinity, 5], [5, Infinity], [-3, 5], ['abc', 5], [null, 5], [undefined, 5]]) {
    assert.equal(ctx.kjrTilePct(m, c), null, 'no market price or no cost: ' + String(m) + ', ' + String(c));
  }
  assert.deepEqual(Object.keys(ctx.kjrTilePct(60, 48)).sort(), ['cls', 'text'], 'still { cls, text }');
});

test('gain label: the percentage alone is still there for the Overview movers, whose rows carry the S$ totals', async () => {
  const { ctx } = await loadApp();
  assert.deepEqual(plain(ctx.kjrGainPct(645, 2)), { cls: 'pos', text: '▲ +32150%' });
  assert.deepEqual(plain(ctx.kjrGainPct(60, 48)), { cls: 'pos', text: '▲ +25.0%' });
  assert.deepEqual(plain(ctx.kjrGainPct(5, 5)), { cls: '', text: '0%' });
  assert.equal(ctx.kjrGainPct(0, 5), null);
  assert.deepEqual(plain(ctx._kjrOvPct(60, 48)), { cls: 'pos', text: '▲ +25.0%' }, 'the movers rows use it, not the tile label');
  assert.deepEqual(plain(ctx._kjrOvPct(645, 2)), { cls: 'pos', text: '▲ +32150%' });
});

test('gain label: it reaches the tile, is escaped, and the spoken form has words and no signs', async () => {
  const { ctx } = await loadApp();
  const tile = (o) => ctx.kjrTileHtml(single(o), 'singles', false, { now: NOW });
  assert.match(tile({ costPrice: 2, marketPrice: 645 }), /<span class="kjr-tile-pct pos">▲ \+S\$643<\/span>/);
  assert.match(tile({ costPrice: 48, marketPrice: 60 }), /<span class="kjr-tile-pct pos">▲ \+S\$12 · \+25\.0%<\/span>/);
  assert.match(tile({ costPrice: 8, marketPrice: 4 }), /<span class="kjr-tile-pct neg">▼ -S\$4<\/span>/);
  const small = tile({ costPrice: 9, marketPrice: 9.3 });
  assert.match(small, /<span class="kjr-tile-pct pos">▲ \+&lt;S\$1<\/span>/, 'the < is escaped, it would open a tag');
  assert.doesNotMatch(small, /\+<S\$1/);
  const spoken = (cls, text) => ctx.kjrTilePctSpoken({ cls, text });
  assert.equal(spoken('pos', '▲ +S$12 · +25.0%'), 'up S$12, 25.0%');
  assert.equal(spoken('pos', '▲ +S$643'), 'up S$643');
  assert.equal(spoken('neg', '▼ -S$4'), 'down S$4');
  assert.equal(spoken('neg', '▼ -S$25 · -25.0%'), 'down S$25, 25.0%');
  assert.equal(spoken('pos', '▲ +<S$1'), 'up under S$1');
  assert.equal(spoken('', 'S$0'), '', 'a flat card is neither up nor down');
  assert.equal(ctx.kjrTilePctSpoken(null), '');
});

test('gain label: the card inspector shows the S$ gain always and the percentage from S$10 of cost, a flat card keeps its wording', async () => {
  const { ctx } = await loadApp();
  const main = (o) => {
    const m = ctx.kjrInspectHtml('singles', single(o), { now: NOW }).match(/<div class="kjr-insp-gain-main">(.*?)<\/div>/);
    return m && m[1].replace(/<[^>]+>/g, '');
  };
  assert.equal(main({ costPrice: 100, marketPrice: 130 }), '▲ +S$30 · +30.0%');
  assert.equal(main({ costPrice: 100, marketPrice: 80 }), '▼ -S$20 · -20.0%');
  assert.equal(main({ costPrice: 2, marketPrice: 645 }), '▲ +S$643', 'bought for S$2: no percentage');
  assert.equal(main({ costPrice: 8, marketPrice: 4 }), '▼ -S$4');
  assert.equal(main({ costPrice: 100, marketPrice: 100 }), 'S$0 · 0%');
  assert.equal(main({ costPrice: 5, marketPrice: 5 }), 'S$0');
  assert.equal(main({ costPrice: 5, marketPrice: '' }), null, 'an estimate from cost has no gain line');
});

test('gain label: the inspector S$ gain is kjrInspectMoney\'s own figure, the tiles stay whole dollars, and the percentage joins only from S$10 of cost', async () => {
  const { ctx } = await loadApp();
  const main = (o) => {
    const m = ctx.kjrInspectHtml('singles', single(o), { now: NOW }).match(/<div class="kjr-insp-gain-main">(.*?)<\/div>/);
    return m && m[1].replace(/<[^>]+>/g, '');
  };
  const tile = (o) => (ctx.kjrTileHtml(single(o), 'singles', false, { now: NOW }).match(/<span class="kjr-tile-pct [a-z]*">([^<]*)<\/span>/) || [])[1];
  // as shipped kjrInspectMoney rounds to whole dollars, so on S$0.10 -> S$1.20 the inspector and the tile read the same S$ figure
  assert.equal(main({ costPrice: 0.1, marketPrice: 1.2 }), '▲ +S$1');
  assert.equal(tile({ costPrice: 0.1, marketPrice: 1.2 }), '▲ +S$1');
  // the inspector takes its amount from kjrInspectMoney whatever that prints, here with cents; the tile and the Holdings row do not follow it
  ctx.kjrInspectMoney = (v) => { const n = parseFloat(v); return isFinite(n) && n >= 0 ? 'S$' + n.toFixed(2) : ''; };
  assert.equal(main({ costPrice: 0.1, marketPrice: 1.2 }), '▲ +S$1.10', 'cost under S$10: the amount alone');
  assert.equal(main({ costPrice: 8, marketPrice: 6.5 }), '▼ -S$1.50');
  assert.equal(main({ costPrice: 10, marketPrice: 11.25 }), '▲ +S$1.25 · +12.5%', 'from S$10 of cost the percentage follows');
  assert.equal(main({ costPrice: 12, marketPrice: 10.5 }), '▼ -S$1.50 · -12.5%');
  assert.equal(main({ costPrice: 1000, marketPrice: 2500 }), '▲ +S$1500.00 · +150%', 'and a gain of 100% or more drops its decimal');
  assert.equal(main({ costPrice: 5, marketPrice: 5 }), 'S$0', 'a flat card keeps its wording');
  assert.equal(main({ costPrice: 50, marketPrice: 50 }), 'S$0 · 0%');
  assert.equal(tile({ costPrice: 0.1, marketPrice: 1.2 }), '▲ +S$1', 'the tile is still whole dollars');
  assert.equal(tile({ costPrice: 10, marketPrice: 11.25 }), '▲ +S$1 · +12.5%');
  assert.match(ctx.kjrHoldRowHtml(single({ costPrice: 10, marketPrice: 11.25 }), 'singles', false), /<span class="kjr-hold-pct pos">▲ \+S\$1 · \+12\.5%<\/span>/, 'nor the Holdings row');
});

test('gain label: the tile percentage never wraps mid-label (nowrap, clipped to the tile)', () => {
  const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
  const rule = css.match(/\.kjr-tile-pct\{([^}]*)\}/);
  assert.ok(rule, 'the rule exists');
  assert.match(rule[1], /white-space:nowrap/);
  assert.match(rule[1], /max-width:100%/);
  assert.match(rule[1], /overflow:hidden/);
  assert.match(css, /\.kjr-tile-val\{display:flex;flex-wrap:wrap;/, 'and the label still wraps under the price as a whole');
});

// ── Manual price, honestly ──────────────────────────────────────────────────────────────────────────────

test('manual price: a custom card, or a real price with no history, a manual entry or an entry that disagrees with it', async () => {
  const { ctx } = await loadApp();
  const m = (o, base) => ctx.kjrPriceIsManual(Object.assign({}, base || single({}), o));
  // true
  assert.equal(m({ customCard: true, marketPrice: '', priceHistory: [] }), true, 'a custom card is priced by hand on purpose, even with no price yet');
  assert.equal(m({ customCard: true, ...looked(2, 30) }), true, 'whatever its history says');
  assert.equal(m({ marketPrice: 30, priceHistory: [] }), true, 'a price and no history entry was typed in');
  assert.equal(m({ marketPrice: 30, priceHistory: undefined }), true);
  assert.equal(m({ marketPrice: '30', priceHistory: [null] }), true, 'an entry that is not an entry is no entry');
  assert.equal(m({ marketPrice: 30, priceHistory: [{ date: dayIso(1), price: 30, source: 'manual' }] }), true);
  assert.equal(m({ marketPrice: 30, priceHistory: [{ date: dayIso(1), price: 30, source: ' Manual ' }] }), true, 'any case, spaces aside');
  assert.equal(m({ marketPrice: 30, priceHistory: [{ date: dayIso(9), price: 20, source: 'TCGdex (TCGplayer)' }, { date: dayIso(1), price: 30, source: 'MANUAL' }] }), true, 'the LAST entry counts');
  assert.equal(m({ marketPrice: 42, priceHistory: [{ date: dayIso(5), price: 30, source: 'TCGdex (TCGplayer)' }] }), true, 'the stored price is not the one the entry wrote');
  assert.equal(m({ marketPrice: 18, priceHistory: [{ date: dayIso(5), price: 30, source: 'PPT (PSA 10)' }] }), true);
  // false
  assert.equal(m(looked(2, 30)), false, 'a looked-up price');
  assert.equal(m({ marketPrice: 30.9, priceHistory: [{ date: dayIso(2), price: 30, source: 'TCGdex (TCGplayer)' }] }), false, 'within S$1.01 of the entry');
  assert.equal(m({ marketPrice: 31, priceHistory: [{ date: dayIso(2), price: 30, source: 'TCGdex (TCGplayer)' }] }), false, 'S$1 apart is still the entry');
  assert.equal(m({ marketPrice: 31.05, priceHistory: [{ date: dayIso(2), price: 30, source: 'TCGdex (TCGplayer)' }] }), true, 'and more than 1.01 apart is not');
  assert.equal(m({ marketPrice: 30, priceHistory: [{ date: dayIso(9), price: 20, source: 'manual' }, { date: dayIso(1), price: 30, source: 'TCGdex (TCGplayer)' }] }), false, 'a lookup after a manual entry is a lookup');
  assert.equal(m({ marketPrice: 30, priceHistory: [{ date: dayIso(1), source: 'TCGdex (TCGplayer)' }] }), false, 'an entry with no readable price can not disagree, it is taken as the writer');
  assert.equal(m({ marketPrice: '', priceHistory: [] }), false, 'a blank price is nothing, so nothing manual');
  assert.equal(m({ marketPrice: 0, priceHistory: [] }), false);
  assert.equal(m({ marketPrice: 'n/a', priceHistory: [] }), false);
  assert.equal(m({ marketPrice: -5, priceHistory: [] }), false);
  assert.equal(m({ customCard: 'true', marketPrice: '', priceHistory: [] }), false, 'the flag is strictly true, as everywhere else');
  assert.equal(ctx.kjrPriceIsManual(null), false);
  assert.equal(ctx.kjrPriceIsManual(undefined), false);
  assert.equal(ctx.kjrPriceIsManual('x'), false);
});

test('manual price: it follows the price, not the language or the table', async () => {
  const { ctx } = await loadApp();
  const notes = (item, table) => [...ctx.kjrTileHtml(item, table || 'singles', false, { now: NOW }).matchAll(/<span class="kjr-tile-note">([^<]*)<\/span>/g)].map(x => x[1]);
  assert.deepEqual(notes(single({ marketPrice: 30, priceHistory: [] })), ['Manual price'], 'an English card with a typed price');
  assert.deepEqual(notes(single({ language: 'JP', marketPrice: 30, priceHistory: [] })), ['Manual price'], 'a Japanese card with a typed price');
  assert.deepEqual(notes(single({ language: 'JP', ...looked(3, 30, 'PPT (Japanese)') })), ['Checked 3 days ago'], 'a Japanese card a lane priced is not manual any more');
  assert.deepEqual(notes(single({ language: 'KR', ...looked(3, 30, 'PPT') })), ['Checked 3 days ago'], 'nor is any non-English card whose price came from a lookup');
  assert.deepEqual(notes(slab({ marketPrice: 610 }), 'slabs'), ['Manual price'], 'a slab with a typed price now says so');
  assert.deepEqual(notes(slab({ ...looked(8, 610, 'PPT (PSA 10)') }), 'slabs'), ['Checked 8 days ago'], 'a slab the lane priced says its age');
  assert.deepEqual(notes(single({ ...looked(2, 30), marketPrice: 45 })), ['Manual price'], 'a price edited by hand after the lookup');
  assert.deepEqual(notes(single({ customCard: true, ...looked(2, 30) })), ['Manual price'], 'a custom card');
  assert.deepEqual(notes(single({ customCard: true, marketPrice: '', costPrice: 12 })), [''], 'a custom card with no price yet is an estimate from cost, which has no note');
});

// ── The price age line ──────────────────────────────────────────────────────────────────────────────────

test('age line: today, yesterday, days, weeks from 14 days, months from 60', async () => {
  const { ctx } = await loadApp();
  const days = [0, 1, 2, 5, 13, 14, 20, 27, 28, 59, 60, 89, 90, 365];
  assert.deepEqual(days.map(d => ctx.kjrAgeWords(d)), [
    'today', 'yesterday', '2 days ago', '5 days ago', '13 days ago', '2 weeks ago', '2 weeks ago', '3 weeks ago', '4 weeks ago', '8 weeks ago',
    '2 months ago', '2 months ago', '3 months ago', '12 months ago',
  ]);
  assert.equal(ctx.kjrAgeWords(NaN), '');
  assert.equal(ctx.kjrAgeWords('soon'), '');
  assert.equal(ctx.kjrAgeWords(undefined), '');
  assert.equal(ctx.kjrAgeWords(-3), 'today', 'a date ahead of today reads as today, as kjrCheckedDays does');
  assert.equal(ctx.kjrAgeWords('5'), '5 days ago');
});

test('age line: a looked-up price shows "Checked ..." on the tile, the asking line stays the next line', async () => {
  const { ctx } = await loadApp();
  const notes = (item, table) => [...ctx.kjrTileHtml(item, table || 'singles', false, { now: NOW }).matchAll(/<span class="kjr-tile-note">([^<]*)<\/span>/g)].map(x => x[1]);
  const at = (d) => notes(single({ ...looked(d, 30) }))[0];
  assert.deepEqual([0, 1, 5, 20, 90].map(at), ['Checked today', 'Checked yesterday', 'Checked 5 days ago', 'Checked 2 weeks ago', 'Checked 3 months ago']);
  assert.deepEqual(notes(single({ ...looked(5, 30), listPrice: 40 })), ['Checked 5 days ago', 'Asking S$40']);
  assert.deepEqual(notes(single({ ...looked(5, 30), qty: 3, listPrice: 40 })), ['Checked 5 days ago', 'Asking S$40 each']);
  assert.deepEqual(notes(single({ marketPrice: 30, priceHistory: [], listPrice: 40 })), ['Manual price', 'Asking S$40'], 'a manual price keeps its note and the asking line');
  // the re-check marker counts, like everywhere else the age is read: an old entry re-checked yesterday says yesterday
  assert.deepEqual(notes(single({ ...looked(40, 30), _tcgdexPricedDate: dayIso(1) })), ['Checked yesterday']);
  // no age for an estimate from cost, for no price at all, or for a date that can not be read: the row stays, empty
  assert.deepEqual(notes(single({ marketPrice: '', costPrice: 12, priceHistory: [] })), ['']);
  assert.deepEqual(notes(single({ marketPrice: '', costPrice: '', priceHistory: [] })), ['']);
  assert.deepEqual(notes(single({ marketPrice: 30, priceHistory: [{ date: 'garbage', price: 30, source: 'TCGdex (TCGplayer)' }] })), [''], 'no date, no claim');
  // the real clock is used when no opts.now is given
  const today = new Date().toISOString().slice(0, 10);
  const live = [...ctx.kjrTileHtml(single({ marketPrice: 30, priceHistory: [{ date: today, price: 30, source: 'TCGdex (TCGplayer)' }] }), 'singles', false).matchAll(/<span class="kjr-tile-note">([^<]*)<\/span>/g)].map(x => x[1]);
  assert.deepEqual(live, ['Checked today']);
});

// ── The count on a grouped holding ──────────────────────────────────────────────────────────────────────

test('tile count: opts.count replaces the quantity on the badge only, and every other caller is unchanged', async () => {
  const { ctx } = await loadApp();
  const badge = (html) => (html.match(/<span class="kjr-tile-qty">([^<]*)<\/span>/) || [])[1];
  const row = single({ qty: 4, listPrice: 18, ...looked(2, 30) });
  assert.equal(badge(ctx.kjrTileHtml(row, 'singles', false)), '×4', 'three arguments: the row quantity');
  assert.equal(badge(ctx.kjrTileHtml(row, 'singles', false, {})), '×4');
  assert.equal(badge(ctx.kjrTileHtml(row, 'singles', false, { count: 2 })), '×2');
  assert.equal(badge(ctx.kjrTileHtml(single({ qty: 1 }), 'singles', false, { count: 3 })), '×3', 'a group of single rows');
  assert.equal(badge(ctx.kjrTileHtml(row, 'singles', false, { count: 1 })), undefined, 'a count of one shows no badge');
  assert.equal(badge(ctx.kjrTileHtml(slab({}), 'slabs', false, { count: 2 })), '×2', 'a pair of slabs');
  assert.equal(badge(ctx.kjrTileHtml(slab({}), 'slabs', false)), undefined);
  for (const junk of [0, -2, NaN, 'x', null, undefined]) {
    assert.equal(badge(ctx.kjrTileHtml(row, 'singles', false, { count: junk })), '×4', 'a count that is not a positive number falls back to the quantity: ' + String(junk));
  }
  assert.match(ctx.kjrTileHtml(row, 'singles', false, { count: 2 }), /Asking S\$18 each/, 'the asking line still reads the row\'s own quantity');
});

// ── PriceCharting ───────────────────────────────────────────────────────────────────────────────────────

test('PriceCharting link: the card name, plus japanese or chinese, percent-encoded', async () => {
  const { ctx } = await loadApp();
  const url = (o) => ctx.kjrPriceChartingUrl(single(o));
  assert.equal(url({ name: 'Charizard ex 199/165', language: 'EN' }), BASE + 'Charizard%20ex%20199%2F165');
  assert.equal(url({ name: 'Charizard ex 199/165', language: 'JP' }), BASE + 'Charizard%20ex%20199%2F165%20japanese');
  assert.equal(url({ name: 'Pikachu', language: 'jp' }), BASE + 'Pikachu%20japanese', 'any case');
  for (const language of ['CN', 'ZH', 'zh']) assert.equal(url({ name: 'Pikachu', language }), BASE + 'Pikachu%20chinese', language);
  for (const language of ['KR', 'ID', '', undefined, null]) assert.equal(url({ name: 'Pikachu', language }), BASE + 'Pikachu', 'no word for ' + String(language));
  assert.equal(url({ name: 'A&B #1 "x" <y>' }), BASE + 'A%26B%20%231%20%22x%22%20%3Cy%3E', 'a name can not leave the q parameter');
  assert.equal(url({ name: '  Pikachu  ' }), BASE + 'Pikachu', 'surrounding spaces are not part of the search');
  assert.equal(url({ name: '   ' }), '', 'no name, no link');
  assert.equal(url({ name: '' }), '');
  assert.equal(url({ name: undefined }), '');
  assert.equal(ctx.kjrPriceChartingUrl(null), '');
  assert.equal(ctx.kjrPriceChartingUrl(slab({ name: 'Umbreon VMAX 215/203' })), BASE + 'Umbreon%20VMAX%20215%2F203', 'a slab by its name');
});

test('PriceCharting link: Check on PriceCharting is a new-tab link in the inspector "…" menu of singles and slabs, escaped for the attribute', async () => {
  const { ctx } = await loadApp();
  const link = (table, item) => {
    const m = ctx.kjrInspectHtml(table, item, { now: NOW }).match(/<a role="menuitem" href="([^"]*)" target="_blank" rel="noopener noreferrer">Check on PriceCharting<\/a>/);
    return m && m[1];
  };
  assert.equal(link('singles', single({ name: 'Charizard ex 199/165' })), 'https://www.pricecharting.com/search-products?type=prices&amp;q=Charizard%20ex%20199%2F165', 'the & is escaped in the attribute');
  assert.equal(link('singles', single({ name: 'Charizard ex 199/165', language: 'JP' })), 'https://www.pricecharting.com/search-products?type=prices&amp;q=Charizard%20ex%20199%2F165%20japanese');
  assert.equal(link('singles', single({ name: 'Pikachu', language: 'CN' })), 'https://www.pricecharting.com/search-products?type=prices&amp;q=Pikachu%20chinese');
  assert.equal(link('slabs', slab({ name: 'Umbreon VMAX 215/203' })), 'https://www.pricecharting.com/search-products?type=prices&amp;q=Umbreon%20VMAX%20215%2F203');
  assert.equal(link('singles', single({ name: 'Pikachu', status: 'Sold' })), 'https://www.pricecharting.com/search-products?type=prices&amp;q=Pikachu', 'a sold card can still be looked up');
  assert.equal(link('singles', single({ name: '' })), null, 'a row with no name has no link');
  const evil = link('singles', single({ name: '"><img src=x onerror=1> \'q\'' }));
  assert.ok(evil && !/["'<>]/.test(evil.replace(/&amp;/g, '&')), 'a name can not break out of the attribute: ' + evil);
  const html = ctx.kjrInspectHtml('singles', single({ name: 'Charizard' }), { now: NOW });
  const items = [...html.slice(html.indexOf('class="kjr-rowmenu"')).matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map(m => m[1]);
  assert.deepEqual(items, ['Check on PriceCharting', 'Refresh price', 'Delete'], 'after any listing links, before Refresh price');
});
