'use strict';
// Suite 3: escaping-formatting - esc/kjrEscape, fmt/fmtSigned, pnlHtml,
// kjrNum/kjrMoneyStr/kjrFmt/fmtUsd, kjrPill, kjrInvEmptyRow.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

test('escaping: esc() escapes & < > " \' and leaves commas alone', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.esc('&'), '&amp;');
  assert.strictEqual(ctx.esc('<'), '&lt;');
  assert.strictEqual(ctx.esc('>'), '&gt;');
  assert.strictEqual(ctx.esc('"'), '&quot;');
  assert.strictEqual(ctx.esc("'"), '&#39;');
  assert.strictEqual(ctx.esc('a, b, c'), 'a, b, c');
  assert.strictEqual(ctx.esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
});

test('escaping: esc() handles non-string input without throwing', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.esc(null), '');
  assert.strictEqual(ctx.esc(undefined), '');
  assert.strictEqual(ctx.esc(123), '123');
  assert.strictEqual(ctx.esc(0), '0', 'falsy-but-defined number must NOT collapse to empty string');
  assert.strictEqual(ctx.esc(true), 'true');
});

test('escaping: kjrEscape is an alias of esc (identical output)', async () => {
  const { ctx } = await loadApp();
  const sample = '<b>&"\'</b>';
  assert.strictEqual(ctx.kjrEscape(sample), ctx.esc(sample));
});

test('formatting: fmt() - NaN/empty -> "-", whole numbers, decimal places', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.fmt(NaN), '-');
  assert.strictEqual(ctx.fmt(''), '-');
  assert.strictEqual(ctx.fmt(null), '-');
  assert.strictEqual(ctx.fmt(undefined), '-');
  assert.strictEqual(ctx.fmt('not a number'), '-');
  assert.strictEqual(ctx.fmt(45), 'S$45');
  assert.strictEqual(ctx.fmt(45.678, 2), 'S$45.68');
  assert.strictEqual(ctx.fmt(-12), 'S$-12', 'fmt does not add its own sign handling - that is fmtSigned\'s job');
});

test('formatting: fmtSigned() - NaN -> "-", explicit +/- sign, decimals', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.fmtSigned(NaN), '-');
  assert.strictEqual(ctx.fmtSigned('garbage'), '-');
  assert.strictEqual(ctx.fmtSigned(12), '+S$12');
  assert.strictEqual(ctx.fmtSigned(-12), '-S$12');
  assert.strictEqual(ctx.fmtSigned(0), 'S$0', 'zero gets no sign prefix');
  assert.strictEqual(ctx.fmtSigned(12.345, 2), '+S$12.35');
});

test('formatting: pnlHtml() - dash for missing/zero cost or market, coloured span otherwise', async () => {
  const { ctx } = await loadApp();
  assert.match(ctx.pnlHtml(NaN, 100), /text3/);
  assert.match(ctx.pnlHtml(100, NaN), /text3/);
  assert.match(ctx.pnlHtml(0, 100), /text3/, 'zero cost is falsy -> treated as missing, not a division-by-zero crash');
  assert.match(ctx.pnlHtml(100, 0), /text3/);
  const gain = ctx.pnlHtml(100, 150); // +50 (+50%)
  assert.match(gain, /class="pos"/);
  assert.match(gain, /\+S\$50/);
  assert.match(gain, /\+50%/);
  const loss = ctx.pnlHtml(100, 50); // -50 (-50%)
  assert.match(loss, /class="neg"/);
  assert.match(loss, /-S\$50/);
  assert.match(loss, /-50%/);
});

test('formatting: features.js kjrNum() - robust numeric parser, strips $/commas, 0 for junk', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrNum(null), 0);
  assert.strictEqual(ctx.kjrNum(''), 0);
  assert.strictEqual(ctx.kjrNum(5), 5);
  assert.strictEqual(ctx.kjrNum('5'), 5);
  assert.strictEqual(ctx.kjrNum('$1,250.50'), 1250.5, 'comma-formatted currency must not truncate at the comma');
  assert.strictEqual(ctx.kjrNum('garbage'), 0);
  assert.strictEqual(ctx.kjrNum(Infinity), 0, 'non-finite number input still returns 0');
});

test('formatting: features.js kjrMoneyStr() - clean numeric STRING for storage, "" for junk', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrMoneyStr(null), '');
  assert.strictEqual(ctx.kjrMoneyStr(''), '');
  assert.strictEqual(ctx.kjrMoneyStr('$1,250.50'), '1250.5');
  assert.strictEqual(ctx.kjrMoneyStr('-'), '');
  assert.strictEqual(ctx.kjrMoneyStr('.'), '');
  assert.strictEqual(ctx.kjrMoneyStr(45), '45');
});

test('formatting: features.js kjrFmt()/fmtUsd() - whole-number currency, "" for zero', async () => {
  const { ctx } = await loadApp();
  assert.strictEqual(ctx.kjrFmt(45.6), 'S$46', 'rounds to nearest whole number');
  assert.strictEqual(ctx.kjrFmt(0), '', 'zero renders as empty string, not "S$0"');
  assert.strictEqual(ctx.kjrFmt(1250), 'S$1,250', 'thousands separator via en-SG locale');
  assert.strictEqual(ctx.fmtUsd(45.6), 'US$46');
  assert.strictEqual(ctx.fmtUsd(0), '');
});

test('formatting: SUSPECT - kjrFmt(0) and fmtUsd(0) are indistinguishable from a genuinely empty/unset price', async () => {
  const { ctx } = await loadApp();
  // A real free/zero-cost item (e.g. a promo card that cost literally S$0) and
  // an unset price both render as the empty string - the UI cannot tell them
  // apart from the formatted output alone. Severity: cosmetic (display only,
  // the underlying stored value is unaffected).
  assert.strictEqual(ctx.kjrFmt(0), ctx.kjrFmt(''));
  assert.strictEqual(ctx.kjrFmt(0), ctx.kjrFmt(null));
});

test('formatting: kjrPill() escapes its input and classifies by keyword', async () => {
  const { ctx } = await loadApp();
  const xss = ctx.kjrPill('<b>Sold</b>');
  assert.match(xss, /kjr-pill-sold/);
  assert.doesNotMatch(xss, /<b>/, 'raw HTML in the status string must be escaped, not injected verbatim');
  assert.match(xss, /&lt;b&gt;/);
  assert.match(ctx.kjrPill('In Stock'), /kjr-pill-stock/);
  assert.match(ctx.kjrPill('Shipping to Buyandship'), /kjr-pill-pending/);
  assert.match(ctx.kjrPill('Completed'), /kjr-pill-received/);
  assert.match(ctx.kjrPill('Traded'), /kjr-pill-traded/);
});

test('formatting: SUSPECT - kjrPill("Cancelled") gets the same amber "pending" class as an in-progress step', async () => {
  const { ctx } = await loadApp();
  // The classifier checks c.includes('cancel') THIRD, mapping it to
  // 'kjr-pill-pending' - the same class as "Shipping to Buyandship" or
  // "Ordered" (checked later via the ship/order/pend branch, but 'cancel'
  // hits first with the identical class name anyway). A cancelled purchase
  // is visually identical to a normal mid-pipeline step, with no distinct
  // (e.g. red/grey "terminal, nothing happening") styling. Severity:
  // cosmetic - a collector scanning the eBay tab by colour alone cannot
  // distinguish "still in flight" from "cancelled, dead" at a glance.
  const html = ctx.kjrPill('Cancelled');
  assert.match(html, /kjr-pill-pending/);
  assert.doesNotMatch(html, /kjr-pill-(sold|traded|received|stock)/);
});

test('formatting: kjrInvEmptyRow() - filtered vs genuinely-empty message shapes', async () => {
  const { ctx } = await loadApp();
  const filtered = ctx.kjrInvEmptyRow({ colspan: 5, filtered: true });
  assert.match(filtered, /No matches/);
  assert.doesNotMatch(filtered, /btn-primary/, 'a filtered-empty state has no add-first-item CTA');

  const empty = ctx.kjrInvEmptyRow({
    colspan: 5, filtered: false, icon: '🎴', title: 'No cards yet', sub: 'Add your first card',
    ctaLabel: 'Add card', ctaAction: 'openAddSingle()',
  });
  assert.match(empty, /No cards yet/);
  assert.match(empty, /Add your first card/);
  assert.match(empty, /Add card/);
  assert.match(empty, /openAddSingle\(\)/);
  assert.match(empty, /colspan="5"/);
});
