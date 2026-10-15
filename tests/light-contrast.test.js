'use strict';
// v3.76: light theme, hover and press contrast. The light --text3, --red and --amber are 4.31, 4.30 and 4.29:1 on --bg4, the hover fill
// of a .btn, a Chart Builder pill and a Sentry issue row, and a few other hover or press states put small text on a tint or dimmed it
// under 4.5:1. The fix is hover and press only and light only: the tokens, the dark theme and every resting state are untouched. Each
// pair below is computed from styles.css (the token blocks and the rules themselves), and the markup the text comes from is pinned next
// to it. The harness has no layout engine, a browser run with the hover rules forced on confirmed the same numbers.
// v3.78: the same pass over the light RESTING states that were left. A selected dealer card (its status and set lines were --text3 on the
// accent glow, 3.60:1), the Sentry level pills (fatal and warning were the hex #ff4444 and #f59e0b, 3.02:1 and 1.90:1 on the --bg3 row) and
// a Sold row (every cell at 55% opacity). Light only again, the dark theme is as it was apart from five new level tokens. The hover and
// press block is still the last one in the file, so the resting block sits above it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { ROOT } = require('./harness.js');

const raw = fs.readFileSync(ROOT + '/styles.css', 'utf8');
const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const features = fs.readFileSync(ROOT + '/features.js', 'utf8');
const dealerUi = fs.readFileSync(ROOT + '/dealer-production-ui.js', 'utf8');

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
// A custom property is substituted where it is DECLARED, and a child inherits the value its parent computed, not the var() text. So a
// token that points at --red, declared at the root, keeps the root's red inside an element that sets its own --red. computed(parent,
// declared) is the map an element hands down: its declarations resolved against its own cascade, everything else as the parent had it.
function computed(parent, declared) {
  const specified = Object.assign({}, parent, declared);
  const out = Object.assign({}, parent);
  for (const [name, value] of Object.entries(declared)) out[name] = resolve(value, specified);
  return out;
}

// ── the rules: the declarations of the one rule written exactly as `selector{...}`, at the start of a rule ──
function rule(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp('(?:^|[\\n}])[ \\t]*' + esc + '\\{([^}]*)\\}'));
  assert.ok(m, 'rule not found: ' + selector);
  return Object.fromEntries(m[1].split(';').filter((d) => d.trim()).map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim(), d.slice(i + 1).trim()]; }));
}

// ── specificity of the simple selectors in this file, [ids, classes and attributes and pseudo-classes, types] ──
// :is and :not count as their most specific argument, :where as nothing, a pseudo-element as a type.
const addSpec = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const cmpSpec = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
function specificity(selector) {
  let total = [0, 0, 0];
  let rest = selector.replace(/:(is|not|where)\(((?:[^()]|\([^()]*\))*)\)/g, (m, fn, args) => {
    if (fn !== 'where') total = addSpec(total, args.split(/,(?![^(]*\))/).map((a) => specificity(a.trim())).reduce((a, b) => (cmpSpec(a, b) >= 0 ? a : b)));
    return ' ';
  });
  const count = (re) => { const n = (rest.match(re) || []).length; rest = rest.replace(re, ' '); return n; };
  total[1] += count(/\[[^\]]*\]/g);
  total[0] += count(/#[\w-]+/g);
  total[1] += count(/\.[\w-]+/g);
  total[2] += count(/::[\w-]+/g);
  total[1] += count(/:[\w-]+/g);
  total[2] += rest.split(/[\s>+~]+/).filter((t) => t && t !== '*').length;
  return total;
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
// the Sentry row, on the page and under the pointer: its own declarations resolved where they are declared (see computed above)
const SENTRY_HOVER = 'html.light .sentry-issue:hover';
const rootLight = computed({}, light);
const rootDark = computed({}, dark);
const rowHover = computed(rootLight, Object.assign({}, hoverDecl, rule(SENTRY_HOVER)));

test('light contrast: the light --text3 and --amber are the Step 1 values again, and the dark block is exactly as it was apart from the five Sentry level tokens', () => {
  assert.equal(light['--text3'], '#6B6B76');
  assert.equal(light['--amber'], '#946200');
  assert.equal((lightText.match(/--text3:/g) || []).length, 1);
  assert.equal((lightText.match(/--amber:/g) || []).length, 1);
  assert.doesNotMatch(raw, /Hover contrast \(v3\.76\)|#676772|#8F5E00/i, 'the token change this replaces is gone, comment and values');
  // the dark tokens as a whole, whitespace aside: any change to that block is a decision, so it moves this fingerprint on purpose.
  // v3.78 made one: the five --lvl-* Sentry level colours, on one line, the colours the drawer's pills already had. The fingerprint is
  // of the block without that line, so it is still the v3.76 one, and the line is pinned on its own.
  const lvlLine = darkText.match(/\n[ \t]*--lvl-error:[^\n]*/);
  assert.ok(lvlLine, 'the level tokens are one line of the dark block');
  assert.deepEqual(tokensOf(lvlLine[0]), { '--lvl-error': 'var(--red)', '--lvl-fatal': '#ff4444', '--lvl-warning': '#f59e0b', '--lvl-info': 'var(--accent)', '--lvl-debug': 'var(--text3)' });
  const fp = crypto.createHash('sha256').update(darkText.replace(lvlLine[0], '').replace(/\s+/g, '')).digest('hex');
  assert.equal(fp, '640fc536c5cde09dd57a69264631a3b80b415e2990ac139ca30a0b37086aee8b', 'the dark :root block is unchanged');
  for (const [k, v] of Object.entries({ '--text2': '#B4B4BE', '--text3': '#8C8C97', '--red': '#FB7185', '--red2': '#E5485F', '--amber': '#F5C25B', '--bg3': '#1B1B21', '--bg4': '#24242B' })) assert.equal(dark[k], v, 'dark ' + k);
  // the light additions: the two level overrides and the one new colour, the deeper amber for the hovered Sentry row
  assert.equal(light['--lvl-fatal'], 'var(--red)');
  assert.equal(light['--lvl-warning'], 'var(--amber)');
  assert.equal(light['--amber2'], '#855800');
  assert.equal(dark['--amber2'], undefined, 'the deeper amber is a light token only');
  for (const k of ['--lvl-error', '--lvl-info', '--lvl-debug']) assert.equal(light[k], dark[k], k + ' is not overridden in light');
});

test('light contrast: every new rule is light only and hover or press only, tokens only, and the rules both themes share are as they were', () => {
  const at = css.indexOf(HOVER + '{');
  assert.ok(at > css.indexOf('#msl-cert{'), 'the block is the last one in the file, after every rule it overrides');
  const block = css.slice(at);
  const selectors = [...block.matchAll(/(?:^|[\n}])\s*([^{}@\n][^{}]*)\{/g)].map((m) => m[1].trim());
  assert.equal(selectors.length, 9);
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
  // the dark resting states are untouched (v3.78 changes the light ones, in the block above this one, and the tests below pin them)
  assert.deepEqual(rule('tr.sold-row td'), { opacity: '0.55' });
  assert.deepEqual(rule('body:not(.force-tables) .page .tbl-wrap>table>tbody>tr.sold-row'), { opacity: '0.55' });
  assert.match(css, /\.kjr-hold-row\.is-inspected\{background:var\(--accent-soft\);/);
  // the resting block is above it, light only, and every declaration in it is a token or a number
  const restAt = css.indexOf('html.light .dealer-production-card.selected :is(span,small){');
  assert.ok(restAt > css.indexOf('#msl-cert{') && restAt < at, 'the resting rules sit between the last older rule and the hover block');
  const rest = css.slice(restAt, at);
  const restSelectors = [...rest.matchAll(/(?:^|[\n}])\s*([^{}@\n][^{}]*)\{/g)].map((m) => m[1].trim());
  assert.equal(restSelectors.length, 3);
  for (const s of restSelectors) assert.match(s, /^html\.light /, 'light only: ' + s);
  assert.doesNotMatch(rest, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no literal colour, tokens only');
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
  // the Sentry issue row: its inline lines (the level pill has its own test below, its colour is a token resolved at the row)
  const rowFill = resolve(rule('.sentry-issue:hover').background, light);
  const rowAt = features.indexOf('<a class="sentry-issue"');
  assert.ok(rowAt > 0);
  const row = features.slice(rowAt, rowAt + 1800);
  assert.match(row, /color:var\(--text\);/);
  assert.match(row, /font-size:11px;color:var\(--text3\)/);
  for (const [, v] of [['text', 'var(--text)'], ['text3', 'var(--text3)']]) passes('.sentry-issue:hover, ' + v, resolve(v, rowHover), rowFill);
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
  assert.deepEqual(rule('body:not(.force-tables) .page .tbl-wrap>table>tbody>tr.sold-row'), { opacity: '0.55' }, 'the phone table row dims at rest in dark, as before');
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

// ═══ v3.78: the resting states ═══

test('light contrast (v3.78): a selected dealer card at rest keeps every line at 4.5:1 on the accent glow, over its list and over --bg3, the worst base', () => {
  const glow = rule('.dealer-production-card:hover,.dealer-production-card.selected');
  assert.equal(glow.background, 'var(--accent-glow)');
  const tint = resolve(glow.background, light);
  assert.equal(tint, 'rgba(91,75,209,0.25)');
  // the rule: the status and set lines are --text2 on a selected card, and it outranks the --text3 rule they had
  const rest = rule('html.light .dealer-production-card.selected :is(span,small)');
  assert.deepEqual(rest, { color: 'var(--text2)' });
  const base = rule('.dealer-production-card span,.dealer-production-card small');
  assert.equal(base.color, 'var(--text3)');
  assert.ok(cmpSpec(specificity('html.light .dealer-production-card.selected :is(span,small)'), specificity('.dealer-production-card span')) > 0, 'it outranks the base rule whatever the order');
  assert.deepEqual(specificity('html.light .dealer-production-card.selected :is(span,small)'), [0, 3, 2]);
  // the card holds a name, a status and a set line and no other text, so those are all the pairs there are
  const card = dealerUi.match(/class="dealer-production-card'[\s\S]*?<\/button>'/);
  assert.ok(card, 'the card markup');
  assert.deepEqual([...card[0].matchAll(/<(strong|span|small|div|p|h\d|a|em|b|i)\b/g)].map((m) => m[1]), ['strong', 'span', 'small']);
  const list = resolve(rule('.dealer-production-list,.dealer-production-section,.dealer-production-pending').background, light);
  for (const [where, backdrop] of [['over the list', list], ['over --bg3', light['--bg3']]]) {
    const fill = over(tint, backdrop);
    assert.ok(ratio(resolve(base.color, light), fill) < 4.5, 'why, ' + where + ': --text3 on the glow');
    passes('selected card, ' + where + ', name', resolve(rule('.dealer-production-card strong').color, light), fill);
    passes('selected card, ' + where + ', its own text', resolve(rule('.dealer-production-card').color, light), fill);
    passes('selected card, ' + where + ', status and set', resolve(rest.color, light), fill);
  }
  // dark is not touched: a selected card there still takes the --text3 rule
  assert.doesNotMatch(css, /(?:^|[\n}])\s*\.dealer-production-card\.selected :is\(span,small\)\{/);
});

test('light contrast (v3.78): the Sentry level pills are tokens, and every level reads 4.5:1 on the row at rest (--bg3) and under the pointer (--bg4)', () => {
  const levels = features.match(/var levelColor = \{([^}]*)\}/);
  assert.ok(levels, 'the level colour map');
  const map = Object.fromEntries([...levels[1].matchAll(/(\w+): '([^']+)'/g)].map((m) => [m[1], m[2]]));
  assert.deepEqual(map, { error: 'var(--lvl-error)', fatal: 'var(--lvl-fatal)', warning: 'var(--lvl-warning)', info: 'var(--lvl-info)', debug: 'var(--lvl-debug)' });
  assert.doesNotMatch(levels[1], /#[0-9a-fA-F]{3,8}\b/, 'no literal colour is left in the map');
  assert.match(features, /var col = levelColor\[issue\.level\] \|\| 'var\(--text3\)'/, 'an unknown level still falls back to a token');
  // the pill is a span inside the row, coloured by that map
  const rowAt = features.indexOf('<a class="sentry-issue"');
  assert.match(features.slice(rowAt, rowAt + 900), /<span style="color:' \+ col \+ ';font-size:10px;font-weight:700;text-transform:uppercase/);
  // why: the two hex colours it had, on the row at rest
  const rowFill = light['--bg3'];
  assert.equal(resolve(rule('.sentry-issue').background, light), rowFill);
  assert.ok(ratio('#ff4444', rowFill) < 4.5 && ratio('#f59e0b', rowFill) < 4.5);
  assert.equal(ratio('#ff4444', rowFill).toFixed(2), '3.02');
  assert.equal(ratio('#f59e0b', rowFill).toFixed(2), '1.90');
  // light at rest: the colour each level resolves to where the pill is
  for (const level of Object.keys(map)) passes('sentry pill at rest, ' + level, resolve(map[level], rootLight), rowFill);
  // dark keeps exactly the colours it had
  assert.deepEqual(Object.fromEntries(Object.entries(map).map(([k, v]) => [k, resolve(v, rootDark)])),
    { error: dark['--red'], fatal: '#ff4444', warning: '#f59e0b', info: dark['--accent'], debug: dark['--text3'] });
  // under the pointer the row is --bg4. The level tokens are resolved at the root, so the --red and --text3 swap the hovered row makes for
  // its own text never reaches them (the swap alone leaves fatal and warning under 4.5), and the hovered row declares the levels itself.
  const hoverFill = resolve(rule('.sentry-issue:hover').background, light);
  assert.equal(hoverFill, light['--bg4']);
  const swapOnly = computed(rootLight, hoverDecl);
  assert.ok(ratio(resolve(map.fatal, swapOnly), hoverFill) < 4.5, 'why: fatal, with only the --red swap');
  assert.ok(ratio(resolve(map.warning, swapOnly), hoverFill) < 4.5, 'why: warning, with only the --red swap');
  assert.ok(ratio(resolve(map.debug, swapOnly), hoverFill) < 4.5, 'why: debug, with only the --text3 swap');
  assert.deepEqual(rule(SENTRY_HOVER), { '--lvl-error': 'var(--red2)', '--lvl-fatal': 'var(--red2)', '--lvl-warning': 'var(--amber2)', '--lvl-debug': 'var(--text2)' });
  for (const level of Object.keys(map)) passes('sentry pill hovered, ' + level, resolve(map[level], rowHover), hoverFill);
});

test('light contrast (v3.78): a Sold row at rest keeps its full strength and steps its plain text down to --text2, so every colour in it clears 4.5:1 and the text 7:1', () => {
  // dark dims, light does not: the dark rules are as they were, the light ones are new and outrank them
  const lightCell = rule('html.light tr.sold-row td');
  assert.deepEqual(lightCell, { opacity: '1', color: 'var(--text2)' });
  assert.deepEqual(rule('tr.sold-row td'), { opacity: '0.55' });
  const lightRow = rule('html.light body:not(.force-tables) .page .tbl-wrap>table>tbody>tr.sold-row');
  assert.deepEqual(lightRow, { opacity: '1' });
  assert.match(css, /@media \(max-width: 600px\)\{\s*html\.light body:not\(\.force-tables\) \.page \.tbl-wrap>table>tbody>tr\.sold-row\{opacity:1\}\s*\}/, 'the phone row, in the phone layout only');
  assert.match(raw, /@media\(max-width:600px\)\{[\s\S]*?body:not\(\.force-tables\) \.page \.tbl-wrap>table>tbody>tr\.sold-row\{opacity:0\.55\}/, 'the phone row it lifts is in that layout too');
  const cellSpec = specificity('html.light tr.sold-row td');
  assert.deepEqual(cellSpec, [0, 2, 3]);
  for (const older of ['tr.sold-row td', 'tr.sold-row:hover td']) assert.ok(cmpSpec(cellSpec, specificity(older)) > 0, 'the light cell rule outranks ' + older);
  const rowSpec = specificity('html.light body:not(.force-tables) .page .tbl-wrap>table>tbody>tr.sold-row');
  assert.ok(cmpSpec(rowSpec, specificity('body:not(.force-tables) .page .tbl-wrap>table>tbody>tr.sold-row')) > 0, 'and so does the light row rule');
  // the hover and press rules above it still lift to 1 and still outrank it, and the Actions cell keeps its own exemption
  assert.deepEqual(rule('html.light tr.sold-row:is(:hover,:active) td'), { opacity: '1' });
  assert.ok(cmpSpec(specificity('html.light tr.sold-row:is(:hover,:active) td'), cellSpec) > 0);
  const exempt = rule('#page-inventory tr.sold-row td[data-col-key="actions"],\n#page-slabs tr.sold-row td[data-col-key="actions"]');
  assert.deepEqual(exempt, { opacity: '1' });
  assert.ok(cmpSpec(specificity('#page-inventory tr.sold-row td[data-col-key="actions"]'), cellSpec) > 0, 'the exemption outranks the light rule too');
  assert.deepEqual(rule('#page-inventory tr.sold-row td[data-col-key="actions"] .kjr-actions>span,\n#page-slabs tr.sold-row td[data-col-key="actions"] .kjr-actions>span'), { opacity: '0.55' }, 'the dimmed indicators are as they were');
  // the numbers, on the card the row sits on (no cell paints a fill at rest, so the card is the backdrop)
  const card = resolve(rule('.card').background, light);
  assert.equal(card, light['--bg2']);
  assert.ok(ratio(resolve(lightCell.color, light), card) >= 7, 'plain text: ' + ratio(resolve(lightCell.color, light), card).toFixed(2));
  const tokens = ['--text2', '--text3', '--green', '--red', '--amber', '--blue'];
  for (const t of tokens) {
    passes('sold row at rest, ' + t, light[t], card);
    // why: at the old 55% the same colours, composited over the card, were under 4.5 (and the phone row dimmed on top of that)
    if (t !== '--blue') assert.ok(ratio(fade(light[t], 0.55, card), card) < 4.5, 'why: ' + t + ' at 55%');
  }
  assert.ok(ratio(fade(light['--text2'], 0.55 * 0.55, card), card) < ratio(fade(light['--text2'], 0.55, card), card), 'on a phone the row and its cells dimmed together');
});
