'use strict';
// Cert numbers in the mono face wherever a slab shows one, and the listing description back in the page face (open since redesign
// Step 1). The Slabs table and the card inspector already carried their own mono hooks (tests/card-art.test.js, tests/inspector.test.js),
// this pins the two places that were still in Geist: a slab tile's line under the name and the slab form's cert field. The harness has
// no layout engine, so the computed face is checked in a browser, here the rules and the hooks they rest on are pinned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, makeSeed, ROOT } = require('./harness.js');

const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const slab = (o) => Object.assign({
  id: 'slab_1', name: 'Umbreon VMAX 215/203', grader: 'PSA', grade: '10', certNo: '12345678', rank: '', type: 'slab',
  language: 'EN', costPrice: 520, marketPrice: 610, listPrice: '', dateListed: '3 Jul 2026', status: 'Available',
  notes: '', priceAlert: '', _updatedAt: new Date().toISOString(),
}, o);

test('cert mono: the mono rules for the table, the inspector, a slab tile and the slab form are all there, on the token', () => {
  assert.match(cssRules, /\n\.cert-no\{font-family:var\(--font-mono\)\}/, 'the Slabs table cert');
  assert.match(cssRules, /\n\.kjr-insp-mono\{font-family:var\(--font-mono\);/, 'the inspector cert');
  assert.match(cssRules, /\n\.kjr-tile:has\(\.kjr-slab\) \.kjr-tile-set\{font-family:var\(--font-mono\)\}/, 'a slab tile\'s grader, grade and cert line');
  assert.match(cssRules, /\n#msl-cert\{font-family:var\(--font-mono\)\}/, 'the slab form\'s cert field');
  // the field rules the id has to outrank are still the ones it was written against
  assert.match(cssRules, /input\.fi,select\.fi,textarea\.fi\{[^}]*font-family:inherit/);
  assert.match(cssRules, /\.kjr-modal \.fi\{[^}]*font-family:inherit/);
  // after both, so a later equal rule cannot take the face back
  assert.ok(cssRules.lastIndexOf('#msl-cert{font-family:var(--font-mono)}') > cssRules.indexOf('.kjr-modal .fi{'));
  assert.ok(cssRules.lastIndexOf('.kjr-tile:has(.kjr-slab) .kjr-tile-set{') > cssRules.indexOf('.kjr-tile-set,.kjr-tile-note{'));
});

test('cert mono: the slab form has its cert field with no face of its own in the markup, so the stylesheet decides', () => {
  const input = html.match(/<input[^>]*id="msl-cert"[^>]*>/);
  assert.ok(input, 'the field is there');
  assert.match(input[0], /class="fi"/);
  assert.doesNotMatch(input[0], /style=/, 'no inline face to beat');
});

test('cert mono: a slab tile draws a slab in its stage and the cert on the line under the name, a single tile does neither', async () => {
  const { ctx } = await loadApp({ seed: makeSeed({ slabs: [slab({ id: 's1', certNo: 'PSA-98765432109876543210' })] }) });
  const tile = ctx.kjrTileHtml(ctx.DB.slabs[0], 'slabs', false);
  assert.match(tile, /^<button type="button" class="kjr-tile"/);
  assert.match(tile, /<span class="kjr-tile-stage"><span class="kjr-slab" aria-hidden="true">/, 'the hook the mono rule rests on');
  assert.match(tile, /<span class="kjr-tile-set">PSA 10 · PSA-98765432109876543210<\/span>/);
  const single = ctx.kjrTileHtml(makeSeed().singles[0], 'singles', false);
  assert.doesNotMatch(single, /class="kjr-slab"/, 'a single keeps the page face on its set line');
});

test('listing description: the editable description box is in the page face, the JSON handoff boxes keep the mono face', () => {
  const desc = html.match(/<textarea id="lst-desc-box"[^>]*>/)[0];
  assert.match(desc, /font-family:var\(--font-sans\)/);
  assert.doesNotMatch(desc, /font-mono|monospace/);
  const title = html.match(/<textarea id="lst-title-box"[^>]*>/)[0];
  assert.match(title, /font-family:inherit/, 'the title box was already in the page face');
  assert.match(cssRules, /\.kjr-listing-packet-output\{font-family:var\(--font-mono\);/, 'the JSON packets stay mono, they are code');
});
