'use strict';
// v3.76: light theme, hover and press contrast. The light --text3, --red and --amber are 4.31, 4.30 and 4.29:1 on --bg4, the hover fill
// of a .btn, a Chart Builder pill and a Sentry issue row, and a few other hover or press states put small text on a tint or dimmed it
// under 4.5:1. The fix is hover and press only and light only: the tokens, the dark theme and every resting state are untouched. Each
// pair below is computed from styles.css (the token blocks and the rules themselves), and the markup the text comes from is pinned next
// to it. The harness has no layout engine, a browser run with the hover rules forced on confirmed the same numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ROOT } = require('./harness.js');

const raw = fs.readFileSync(ROOT + '/styles.css', 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const features = fs.readFileSync(ROOT + '/features.js', 'utf8');

// ── the tokens ──
const blockText = (start) => css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
const darkText = blockText(css.indexOf(':root{'));
const lightText = blockText(css.indexOf('html.light{'));
const tokensOf = (text) => Object.fromEntries([...text.matchAll(/(--[\w-]+):([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
const dark = tokensOf(darkText);
const light = Object.assign({}, dark, tokensOf(lightText));
// var() resolved against a token map, fallbacks honoured
function resolve(value, map) {
  let v = String(value);
  for (let i = 0; i < 10 && /var\(/.test(v); i++) {
    v = v.replace(/var\((--[\w-]+)(?:,([^()]*))?\)/g, (m, name, fb) => (map[name] !== undefined ? map[name] : (fb !== undefined ? fb.trim() : m)));
  }
  return v;
}

// ── the rules: the declarations of the one rule written exactly as `selector{...}`, at the start of a rule ──
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp('(?:^|[\\n}])[ \\t]*' + esc + '\\{([^}]*)\\}'));
  assert.ok(m, 'rule not found: ' + selector);
  return Object.fromEntries(m[1].split(';').filter((d) => d.trim()).map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim(), d.slice(i + 1).trim()]; }));
}

// ── WCAG 2 contrast, with alpha and group opacity composited ──
const rgba = (c) => {
  c = String(c).trim();
  let m = c.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = c.match(/^rgba?\(([^)]+)\)$/);
  assert.ok(m, 'not a colour: ' + c);
  const p = m[1].split(',').map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
};
const over = (top, bottom) => { const t = rgba(top), b = rgba(bottom); const a = t[3]; return 'rgb(' + [0, 1, 2].map((i) => t[i] * a + b[i] * (1 - a)).join(',') + ')'; };
// a colour drawn at an opacity over what is under it
const fade = (colour, alpha, backdrop) => { const c = rgba(colour); return over('rgba(' + [c[0], c[1], c[2], alpha].join(',') + ')', backdrop); };
const lum = (c) => { const [r, g, b] = rgba(c).slice(0, 3).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]; return (hi + 0.05) / (lo + 0.05); };
function passes(what, fg, bg) {
  const r = ratio(fg, bg);
  assert.ok(r >= 4.5, what + ': ' + fg + ' on ' + bg + ' is ' + r.toFixed(2) + ':1');
  return r;
}

// the hover override and the token map a hovered .btn, Chart Builder pill or Sentry row hands to everything inside it
const HOVER = 'html.light :is(.btn,.cb-field-pill,.sentry-issue):hover';
const hoverDecl = rule(HOVER);
const inHover = Object.assign({}, light, { '--text3': resolve(hoverDecl['--text3'], light), '--red': resolve(hoverDecl['--red'], light) });

test('light contrast: the light --text3 and --amber are the Step 1 values again, and the dark block is exactly as it was', () => {
  assert.equal(light['--text3'], '#6B6B76');
  assert.equal(light['--amber'], '#946200');
  assert.equal((lightText.match(/--text3:/g) || []).length, 1);
  assert.equal((lightText.match(/--amber:/g) || []).length, 1);
  assert.doesNotMatch(raw, /Hover contrast \(v3\.76\)|#676772|#8F5E00/i, 'the token change this replaces is gone, comment and values');
  // the dark tokens as a whole, whitespace aside: any change to that block is a decision, so it moves this fingerprint on purpose
  const fp = crypto.createHash('sha256').update(darkText.replace(/\s+/g, '')).digest('hex');
  assert.equal(fp, '640fc536c5cde09dd57a69264631a3b80b415e2990ac139ca30a0b37086aee8b', 'the dark :root block is unchanged');
  for (const [k, v] of Object.entries({ '--text2': '#B4B4BE', '--text3': '#8C8C97', '--red': '#FB7185', '--red2': '#E5485F', '--amber': '#F5C25B', '--bg3': '#1B1B21', '--bg4': '#24242B' })) assert.equal(dark[k], v, 'dark ' + k);
});

test('light contrast: every new rule is light only and hover or press only, tokens only, and the rules both themes share are as they were', () => {
  const at = css.indexOf(HOVER + '{');
  assert.ok(at > css.indexOf('#msl-cert{'), 'the block is the last one in the file, after every rule it overrides');
  const block = css.slice(at);
  const selectors = [...block.matchAll(/(?:^|[\n}])\s*([^{}@\n][^{}]*)\{/g)].map((m) => m[1].trim());
  assert.equal(selectors.length, 8);
  for (const s of selectors) {
    for (const part of s.split(/,(?![^(]*\))/)) {
      assert.match(part.trim(), /^html\.light /, 'light only: ' + part);
      assert.match(part, /:hover|:active/, 'hover or press only: ' + part);
    }
  }
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no literal colour, tokens only');
  assert.equal((block.match(/@media/g) || []).length, 1);
  assert.match(block, /@media \(max-width: 600px\)\{/, 'written with spaces, like every later section');
  // the shared rules, so the dark theme keeps its hovers exactly
  assert.deepEqual(rule('.btn:hover'), { background: 'var(--bg4)', 'border-color': 'var(--border2)' });
  assert.deepEqual(rule('.skipped-toggle:hover'), { background: 'var(--bg4)' });
  assert.deepEqual(rule('.sentry-issue:hover'), { 'border-color': 'var(--border2)', background: 'var(--bg4)' });
  assert.deepEqual(rule('.sell-cart-remove:hover'), { background: 'rgba(239,68,68,0.12)', color: 'var(--red)' });
  assert.deepEqual(rule('.dealer-production-card:hover,.dealer-production-card.selected'), { 'border-color': 'var(--accent)', background: 'var(--accent-glow)' });
  assert.deepEqual(rule('tr.sold-row:hover td'), { opacity: '0.8' });
  assert.deepEqual(rule('.cb-field-pill:active'), { cursor: 'grabbing', opacity: '0.7' });
  assert.deepEqual(rule('body:not(.force-tables) #kjr-ebay-table .eb-meta-decl-pill:active'), { opacity: '0.7' });
  // resting states, untouched (their own contrast is a separate decision)
  assert.deepEqual(rule('tr.sold-row td'), { opacity: '0.55' });
  assert.match(css, /\.kjr-hold-row\.is-inspected\{background:var\(--accent-soft\);/);
});

test('light contrast: a hovered .btn, Chart Builder pill and Sentry row read their grey as --text2 and their red as --red2, 4.5:1 or better on --bg4', () => {
  assert.deepEqual(hoverDecl, { '--text3': 'var(--text2)', '--red': 'var(--red2)' });
  const btnFill = resolve(rule('.btn:hover').background, light);
  assert.equal(btnFill, light['--bg4']);
  // why: on --bg4 the plain tokens are under 4.5
  assert.ok(ratio(light['--text3'], btnFill) < 4.5 && ratio(light['--red'], btnFill) < 4.5);
  // the .btn controls that colour their own text with those tokens, inline
  const inline = (token) => [...html.matchAll(new RegExp('<button class="btn btn-sm"[^>]*style="[^"]*color:var\\(--' + token + '\\)', 'g'))].length;
  assert.ok(inline('text3') >= 3, 'Reports reset, Chart Builder select all and none, AI clear chat');
  assert.ok(inline('red') >= 2, 'the red text buttons in the modals');
  passes('.btn:hover, its own text', resolve(rule('.btn').color, light), btnFill);
  passes('.btn:hover, inline --text3', resolve('var(--text3)', inHover), btnFill);
  passes('.btn:hover, inline --red', resolve('var(--red)', inHover), btnFill);
  // the Chart Builder pill and its Group or Value tag
  const pill = rule('.cb-field-pill:hover');
  const pillFill = resolve(pill.background, light);
  passes('.cb-field-pill:hover, label', resolve(pill.color, light), pillFill);
  assert.equal(rule('.cb-field-pill .pill-type').color, 'var(--text3)');
  passes('.cb-field-pill:hover .pill-type', resolve(rule('.cb-field-pill .pill-type').color, inHover), pillFill);
  // the Sentry issue row: its inline lines and the level colours that come from tokens
  const rowFill = resolve(rule('.sentry-issue:hover').background, light);
  const rowAt = features.indexOf('<a class="sentry-issue"');
  assert.ok(rowAt > 0);
  const row = features.slice(rowAt, rowAt + 1800);
  assert.match(row, /color:var\(--text\);/);
  assert.match(row, /font-size:11px;color:var\(--text3\)/);
  const levels = features.match(/var levelColor = \{([^}]*)\}/);
  assert.ok(levels, 'the level colour map');
  const tokenLevels = [...levels[1].matchAll(/(\w+): '(var\(--[\w-]+\))'/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(tokenLevels.map((l) => l[0]), ['error', 'info', 'debug']);
  for (const [, v] of [['text', 'var(--text)'], ['text3', 'var(--text3)']].concat(tokenLevels)) passes('.sentry-issue:hover, ' + v, resolve(v, inHover), rowFill);
});

test('light contrast: the amber controls hover onto the amber soft fill and the quick sale remove button onto the red soft fill', () => {
  const amber = rule('html.light #singles-unresolved-filter-chip:hover,html.light .skipped-toggle:hover');
  assert.deepEqual(amber, { background: 'var(--amber-soft)' });
  const fill = resolve(amber.background, light);
  assert.ok(ratio(light['--amber'], resolve(rule('.skipped-toggle:hover').background, light)) < 4.5, 'why: amber on --bg4');
  assert.equal(rule('.skipped-toggle').color, 'var(--amber)');
  passes('.skipped-toggle:hover', resolve(rule('.skipped-toggle').color, light), fill);
  assert.match(html, /<button class="btn btn-sm" id="singles-unresolved-filter-chip" style="display:none;color:var\(--amber\);border-color:var\(--amber\)"/);
  passes('#singles-unresolved-filter-chip:hover', resolve('var(--amber)', inHover), fill);
  // the remove button sits on a cart line, the old hover was a 12% red over it
  const remove = rule('html.light .sell-cart-remove:hover');
  assert.deepEqual(remove, { background: 'var(--red-soft)' });
  const line = resolve(rule('.sell-cart-line').background, light);
  assert.ok(ratio(resolve('var(--red)', light), over(rule('.sell-cart-remove:hover').background, line)) < 4.5, 'why: red on the 12% red tint');
  passes('.sell-cart-remove:hover', resolve(rule('.sell-cart-remove:hover').color, light), resolve(remove.background, light));
});

test('light contrast: a hovered dealer card keeps every line at 4.5:1 on its accent tint over the list', () => {
  const tint = resolve(rule('.dealer-production-card:hover,.dealer-production-card.selected').background, light);
  const list = resolve(rule('.dealer-production-list,.dealer-production-section,.dealer-production-pending').background, light);
  const fill = over(tint, list);
  assert.ok(ratio(resolve(rule('.dealer-production-card span,.dealer-production-card small').color, light), fill) < 4.5, 'why: --text3 on the tint');
  passes('dealer card, name', resolve(rule('.dealer-production-card strong').color, light), fill);
  passes('dealer card, its own text', resolve(rule('.dealer-production-card').color, light), fill);
  passes('dealer card:hover, status and set', resolve(rule('html.light .dealer-production-card:hover :is(span,small)').color, light), fill);
});

test('light contrast: a sold row is at full strength under the pointer or a press, its cells and the phone table\'s row alike, so every cell colour clears 4.5:1', () => {
  // the cells dim in every layout, the phone table dims the row too, so both lift
  assert.deepEqual(rule('html.light tr.sold-row:is(:hover,:active) td'), { opacity: '1' });
  assert.deepEqual(rule('html.light body:not(.force-tables) .page .tbl-wrap>table>tbody>tr.sold-row:is(:hover,:active)'), { opacity: '1' });
  assert.deepEqual(rule('body:not(.force-tables) .page .tbl-wrap>table>tbody>tr.sold-row'), { opacity: '0.55' }, 'the phone table row dims at rest, as before');
  // the fill under the pointer, and under a tap on a touch screen
  const fill = resolve(rule('tbody tr:hover td').background, light);
  assert.equal(resolve(rule('body:not(.force-tables) .tbl-wrap>table>tbody>tr:active>td').background, light), fill);
  // why: at the old 0.8 the row's text and its fill both fade over the card under them
  const card = light['--bg2'];
  assert.ok(ratio(fade(light['--text2'], 0.8, card), fade(fill, 0.8, card)) < 4.5);
  for (const t of ['--text', '--text2', '--text3', '--green', '--red', '--amber', '--blue']) passes('tr.sold-row:hover, ' + t, light[t], fill);
});

test('light contrast: the two pills that dimmed while pressed keep their strength on a --bg3 fill', () => {
  const pill = rule('html.light .cb-field-pill:active');
  assert.deepEqual(pill, { opacity: '1', background: 'var(--bg3)' });
  const fill = resolve(pill.background, light);
  // a mouse press is a hover too, a touch press is not
  passes('.cb-field-pill:active, mouse, label', resolve(rule('.cb-field-pill:hover').color, light), fill);
  passes('.cb-field-pill:active, mouse, tag', resolve('var(--text3)', inHover), fill);
  passes('.cb-field-pill:active, touch, label', resolve(rule('.cb-field-pill').color, light), fill);
  passes('.cb-field-pill:active, touch, tag', resolve('var(--text3)', light), fill);
  const decl = rule('html.light body:not(.force-tables) #kjr-ebay-table .eb-meta-decl-pill:active');
  assert.deepEqual(decl, { opacity: '1', background: 'var(--bg3)' });
  // the colours the eBay row gives the Declared pill
  const m = features.match(/const declCol = declVal === 'No' \? '(var\(--[\w-]+\))' : \(declVal === 'Yes' \? '(var\(--[\w-]+\))' : '(var\(--[\w-]+\))'\);/);
  assert.ok(m, 'the Declared colours');
  for (const v of m.slice(1)) passes('.eb-meta-decl-pill:active, ' + v, resolve(v, light), resolve(decl.background, light));
});
