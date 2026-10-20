'use strict';
// The band at the top of the phone (21/10/2026): Julian saw the Overview header "shaded, as if misaligned" on an installed iPhone PWA in the dark theme.
// The page goes under the status bar there (apple-mobile-web-app-status-bar-style is black-translucent, viewport-fit=cover), so whatever the page paints
// in the top 59px or so is what the strip is. The audit found one colour, --bg, from the top of the screen to the hairline under the header, in the
// pane and in the stylesheet. Nothing here changes it. These tests pin that audit, so a token change that leaves the meta, the manifest or the header
// behind fails here instead of showing up as a band on a phone. The tests read the files as text, the harness has no layout engine.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { ROOT } = require('./harness.js');

const read = (f) => fs.readFileSync(ROOT + '/' + f, 'utf8');
const html = read('index.html');
const css = read('styles.css');
const appSrc = read('app.js');
const manifest = JSON.parse(read('Assets/manifest.webmanifest'));
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
const tokenIn = (block, name) => { const m = block.match(new RegExp('--' + name + ':(#[0-9A-Fa-f]{6})\\b')); return m && m[1].toUpperCase(); };
const darkBlock = bare.slice(bare.indexOf(':root{'), bare.indexOf('html.light{'));
const lightBlock = bare.slice(bare.indexOf('html.light{'), bare.indexOf('\n}', bare.indexOf('html.light{')));
const DARK = tokenIn(darkBlock, 'bg');
const LIGHT = tokenIn(lightBlock, 'bg');

test('header band: the theme-color meta, the manifest and the theme switch all agree with the page colour, dark and light', () => {
  assert.equal(DARK, '#0B0B0E');
  assert.equal(LIGHT, '#F6F6F7');
  assert.match(html, /<meta name="theme-color" content="#0B0B0E">/, 'the static meta is the dark page colour');
  assert.equal(String(manifest.theme_color).toUpperCase(), DARK);
  assert.equal(String(manifest.background_color).toUpperCase(), DARK, 'the launch background is the page colour too');
  // applyTheme keeps the meta in step: the light hex is the light --bg, the dark hex the dark one
  assert.match(appSrc, /themeMeta\.content = isLight \? '#F6F6F7' : '#0B0B0E';/);
  // the sidebar, rail and tab bar sit one step above the ground on purpose, the phone header does not: it is --bg itself
  assert.notEqual(tokenIn(darkBlock, 'sidebar'), DARK);
});

test('header band: the page goes under the status bar, so the page must paint the strip: the status bar style, viewport-fit and the safe-area padding', () => {
  assert.match(html, /<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">/);
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
  const phone = bare.match(/@media \(max-width: 600px\)\{\s*\.topbar\{([^}]*)\}/);
  assert.ok(phone, 'the phone header rule');
  const decl = Object.fromEntries(phone[1].split(';').filter(Boolean).map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]));
  assert.equal(decl.position, 'sticky');
  assert.equal(decl.top, '0');
  assert.equal(decl.background, 'var(--bg)', 'the header is the page colour, solid');
  assert.equal(decl.height, 'calc(56px + env(safe-area-inset-top))', 'it includes the strip under the status bar');
  assert.match(decl.padding, /^env\(safe-area-inset-top\) /, 'and pads its own content below it');
  assert.equal(decl['border-bottom'], '1px solid var(--border)', 'the hairline is the only edge');
  for (const k of ['background-image', 'backdrop-filter', 'filter', 'opacity', 'box-shadow']) assert.equal(decl[k], undefined, 'nothing translucent or tinted on the header: ' + k);
  // and the page behind it is the same token, with no gradient on the root
  assert.match(bare, /\nbody\{[^}]*background:var\(--bg\);/);
  assert.doesNotMatch(bare.match(/\nbody\{[^}]*\}/)[0], /gradient/);
  assert.doesNotMatch(bare.match(/\nhtml\{[^}]*\}/)[0], /background/);
});

test('header band: the only rules that paint the strip are the phone header, the light scrim and the dark strip beside the rail', () => {
  const painters = [...bare.matchAll(/([^{}\n]*body::before)\{([^}]*)\}/g)].map((m) => m[1].trim());
  assert.deepEqual(painters, ['html.light body::before', 'html:not(.light) body::before']);
  // the light scrim (a dark slate over a light header, because the status bar text is white) is the one deliberate second colour
  assert.match(bare, /html\.light body::before\{[^}]*background:rgba\(20,25,40,\.85\)/);
  // the dark strip starts at 601px, where the shell is a rail or a sidebar: on a phone the header already is the strip
  const dark = bare.indexOf('html:not(.light) body::before');
  assert.match(bare.slice(bare.lastIndexOf('@media', dark), dark + 200), /^@media \(min-width: 601px\)\{\s*html:not\(\.light\) body::before\{[^}]*background:var\(--bg\)/);
  // the one other thing that covers the whole screen at launch is the intro, and it is gone before the Overview is used
  assert.match(bare, /#intro\{position:fixed;inset:0;z-index:100000;background:linear-gradient\(160deg,#0B0B0E 0%,#1B1B21 100%\)/);
  assert.match(bare, /#kjr-auth-gate\{position:fixed;inset:0;z-index:200000;[^}]*background:var\(--bg,#0B0B0E\)/, 'the sign-in gate is the same near-black');
});
