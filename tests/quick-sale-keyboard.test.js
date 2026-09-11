'use strict';

// Focused coverage for the Command Bar's Quick Sale result surface. The
// harness executes the real app.js in a browser shim, so these assertions
// inspect the markup the renderer produces and drive the real search/key
// handlers without needing production data or network access.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, ROOT } = require('./harness.js');

const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function availableSingles() {
  return [
    {
      id: 'keyboard-long',
      name: 'A Very Long Eevee Card Name That Must Stay Usable When It Overflows The Result Row',
      set: 'Base Set', language: 'EN', condition: 'Near Mint', type: 'raw',
      qty: 3, costPrice: 10, listPrice: 25, status: 'Available',
      datePurchased: '1 Jan 2025',
    },
    {
      id: 'keyboard-second',
      name: 'Eevee VMAX', set: 'Base Set', language: 'EN', condition: 'Near Mint', type: 'raw',
      qty: 1, costPrice: 20, listPrice: 40, status: 'Available',
      datePurchased: '1 Jan 2025',
    },
  ];
}

function buttonTags(markup) {
  return [...markup.matchAll(/<button\b[^>]*>/g)].map(match => match[0]);
}

test('quick sale: search markup is a labelled list of native buttons', async () => {
  assert.match(INDEX_HTML, /<input[^>]*id="cmd-sell-search"[^>]*type="search"/);
  assert.doesNotMatch(INDEX_HTML, /<input[^>]*id="cmd-sell-search"[^>]*role="combobox"/);
  assert.match(INDEX_HTML, /<div class="cmd-preview" id="cmd-sell-preview" role="list" aria-labelledby="cmd-sell-results-label"><\/div>/);

  const loaded = await loadApp({ seed: { singles: availableSingles(), sales: [] } });
  loaded.ctx.cmdSellResults = availableSingles().map(item => ({ ...item, _table: 'singles' }));
  loaded.ctx.cmdSellResultIdx = 0;
  loaded.ctx.renderCmdSellResults();

  const markup = loaded.document.getElementById('cmd-sell-preview').innerHTML;
  assert.strictEqual((markup.match(/<div role="listitem">/g) || []).length, 2);
  const buttons = buttonTags(markup);
  assert.strictEqual(buttons.length, 2);
  buttons.forEach((tag, idx) => {
    assert.match(tag, /\btype="button"/);
    assert.match(tag, new RegExp('\\bid="cmd-sell-option-' + idx + '"'));
    assert.doesNotMatch(tag, /\b(?:role|tabindex|aria-selected)=/);
    assert.strictEqual((tag.match(/\bonclick=/g) || []).length, 1, 'one activation handler');
    assert.doesNotMatch(tag, /\bon(?:keydown|keyup|keypress)=/);
  });
  assert.match(markup, /A Very Long Eevee Card Name/);
  assert.match(markup, /cmdSellAddToCart\(0\)/);
});

test('quick sale: search keeps typed spaces, handles empty results, and renders long matches', async () => {
  const loaded = await loadApp({ seed: { singles: availableSingles(), sales: [] } });
  const input = loaded.document.getElementById('cmd-sell-search');

  input.value = '  Eevee   VMAX  ';
  loaded.ctx.cmdSellSearch();
  assert.strictEqual(input.value, '  Eevee   VMAX  ', 'searching must not rewrite the user\'s spaces');
  assert.strictEqual(loaded.ctx.cmdSellResults.length, 1);
  assert.match(loaded.document.getElementById('cmd-sell-preview').innerHTML, /Eevee VMAX/);
  assert.strictEqual(loaded.document.getElementById('cmd-sell-preview').hidden, false);
  assert.strictEqual(loaded.document.getElementById('cmd-sell-status').hidden, true);

  input.value = 'no card with this name';
  loaded.ctx.cmdSellSearch();
  assert.strictEqual(loaded.ctx.cmdSellResults.length, 0);
  assert.strictEqual(input.getAttribute('aria-activedescendant'), null);
  assert.strictEqual(loaded.document.getElementById('cmd-sell-preview').hidden, true);
  assert.strictEqual(loaded.document.getElementById('cmd-sell-status').hidden, false);
  assert.match(loaded.document.getElementById('cmd-sell-status').textContent, /No available inventory matches/);

  input.value = 'long eevee card';
  loaded.ctx.cmdSellSearch();
  assert.strictEqual(loaded.ctx.cmdSellResults.length, 1);
  assert.match(loaded.document.getElementById('cmd-sell-preview').innerHTML,
    /A Very Long Eevee Card Name That Must Stay Usable/);
});

test('quick sale: Arrow navigation still selects, Enter activates once, and Space stays native', async () => {
  const loaded = await loadApp({ seed: { singles: availableSingles(), sales: [] } });
  const input = loaded.document.getElementById('cmd-sell-search');
  const activations = [];
  const originalAddToCart = loaded.ctx.cmdSellAddToCart;
  loaded.ctx.cmdSellAddToCart = (idx) => activations.push(idx);

  try {
    input.value = 'eevee';
    loaded.ctx.cmdSellSearch();
    assert.strictEqual(loaded.ctx.cmdSellResults.length, 2);
    assert.strictEqual(loaded.ctx.cmdSellResultIdx, 0);

    const down = { key: 'ArrowDown', preventDefault() { this.prevented = true; } };
    loaded.ctx.cmdSellKey(down);
    assert.strictEqual(down.prevented, true);
    assert.strictEqual(loaded.ctx.cmdSellResultIdx, 1);
    let markup = loaded.document.getElementById('cmd-sell-preview').innerHTML;
    assert.match(markup, /id="cmd-sell-option-1" class="cmd-result selected"/);
    assert.doesNotMatch(markup, /id="cmd-sell-option-0" class="cmd-result selected"/);

    const enter = { key: 'Enter', preventDefault() { this.prevented = true; } };
    loaded.ctx.cmdSellKey(enter);
    assert.strictEqual(enter.prevented, true);
    assert.deepStrictEqual(activations, [1], 'search Enter selects the highlighted row once');

    const space = { key: ' ', preventDefault() { this.prevented = true; } };
    loaded.ctx.cmdSellKey(space);
    assert.strictEqual(space.prevented, undefined, 'Space is left to native button activation');
    assert.deepStrictEqual(activations, [1]);

    const up = { key: 'ArrowUp', preventDefault() { this.prevented = true; } };
    loaded.ctx.cmdSellKey(up);
    assert.strictEqual(up.prevented, true);
    assert.strictEqual(loaded.ctx.cmdSellResultIdx, 0);
    markup = loaded.document.getElementById('cmd-sell-preview').innerHTML;
    assert.match(markup, /id="cmd-sell-option-0" class="cmd-result selected"/);
  } finally {
    loaded.ctx.cmdSellAddToCart = originalAddToCart;
  }
});

test('quick sale: selected result keeps grouped quantity and in-sale rendering', async () => {
  const loaded = await loadApp({ seed: { singles: availableSingles(), sales: [] } });
  const item = { ...availableSingles()[0], _table: 'singles' };
  loaded.ctx.cmdSellResults = [item];
  loaded.ctx.cmdSellResultIdx = 0;
  loaded.ctx.cmdSellAddToCart(0);

  assert.strictEqual(loaded.ctx.cmdSellCart.length, 1);
  assert.strictEqual(loaded.ctx.cmdSellCart[0].qty, 1);
  assert.strictEqual(loaded.ctx.cmdSellCart[0].availQty, 3);

  loaded.ctx.cmdSellResults = [item];
  loaded.ctx.cmdSellResultIdx = 0;
  loaded.ctx.renderCmdSellResults();
  assert.match(loaded.document.getElementById('cmd-sell-preview').innerHTML, /✓ 1 in sale/);
});
