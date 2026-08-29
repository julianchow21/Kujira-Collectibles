'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

function openingTagById(markup, id) {
  const tags = markup.match(/<(?:button|input|select|label|div)\b[^>]*>/g) || [];
  return tags.find(tag => new RegExp('\\bid="' + id + '"').test(tag)) || null;
}

function attribute(tag, name) {
  const match = tag && tag.match(new RegExp('\\b' + name + '="([^"]*)"'));
  return match ? match[1] : null;
}

function makeNavigationFixture(document) {
  const controls = {
    desktopDashboard: document.getElementById('desktop-dashboard'),
    desktopInventory: document.getElementById('desktop-inventory'),
    desktopMore: document.getElementById('desktop-more'),
    bottomDashboard: document.getElementById('bottom-dashboard'),
    bottomInventory: document.getElementById('bottom-inventory'),
    bottomMore: document.getElementById('btb-more'),
    dropdownGuide: document.getElementById('dropdown-guide'),
    sheetGuide: document.getElementById('sheet-guide'),
    staleSheet: document.getElementById('sheet-stale'),
  };
  controls.desktopDashboard.setAttribute('onclick', "showPage('dashboard')");
  controls.desktopInventory.setAttribute('onclick', "showPage('inventory')");
  controls.desktopMore.setAttribute('onclick', "toggleNavDD('more', event)");
  controls.desktopMore.classList.add('nav-dd-trigger');
  controls.bottomDashboard.setAttribute('onclick', "showPage('dashboard')");
  controls.bottomInventory.setAttribute('onclick', "showPage('inventory')");
  controls.bottomMore.setAttribute('onclick', 'openMoreSheet()');
  controls.dropdownGuide.setAttribute('onclick', "showPage('guide');closeNavDD()");
  controls.sheetGuide.setAttribute('onclick', "moreGo('guide')");
  controls.sheetGuide.setAttribute('data-page', 'guide');
  controls.staleSheet.setAttribute('data-page', 'trash');
  Object.values(controls).forEach(control => control.setAttribute('aria-current', 'page'));

  const desktopMoreParent = document.getElementById('desktop-more-parent');
  controls.desktopMore.closest = selector => selector === '.nav-dd' ? desktopMoreParent : null;
  controls.dropdownGuide.closest = selector => selector === '.nav-dd' ? desktopMoreParent : null;
  document.querySelectorAll = selector => {
    if (selector === '.page') return [];
    if (selector === '.nav-btn') return [controls.desktopDashboard, controls.desktopInventory, controls.desktopMore];
    if (selector === '.btb-item') return [controls.bottomDashboard, controls.bottomInventory, controls.bottomMore];
    if (selector === '.nav-dd-item') return [controls.dropdownGuide];
    if (selector === '#more-sheet .sheet-item[data-page]') return [controls.sheetGuide, controls.staleSheet];
    if (selector === '.nav-dd') return [desktopMoreParent];
    return [];
  };
  return controls;
}

test('runtime accessibility: AI panel toggle keeps aria-expanded aligned with its visible state', async () => {
  const { ctx, document } = await loadApp();
  const panel = document.getElementById('ai-analyst-body');
  const toggle = document.getElementById('ai-panel-toggle');

  panel.style.display = 'none';
  ctx.initAiAnalyst();
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false', 'initially collapsed panel reports false');

  ctx.toggleAiPanel();
  assert.strictEqual(panel.style.display, '');
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true', 'opened panel reports true');

  ctx.toggleAiPanel();
  assert.strictEqual(panel.style.display, 'none');
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false', 'closed panel reports false');
});

test('runtime accessibility: normal pages have one current control in each persistent navigation region', async () => {
  const { ctx, document } = await loadApp();
  const controls = makeNavigationFixture(document);
  ctx.showPage('inventory');

  assert.strictEqual(controls.desktopInventory.getAttribute('aria-current'), 'page');
  assert.strictEqual(controls.bottomInventory.getAttribute('aria-current'), 'page');
  assert.deepStrictEqual(
    [controls.desktopDashboard, controls.desktopInventory, controls.desktopMore].filter(b => b.getAttribute('aria-current') === 'page'),
    [controls.desktopInventory],
    'desktop navigation has exactly one current item'
  );
  assert.deepStrictEqual(
    [controls.bottomDashboard, controls.bottomInventory, controls.bottomMore].filter(b => b.getAttribute('aria-current') === 'page'),
    [controls.bottomInventory],
    'bottom navigation has exactly one current item'
  );
  assert.strictEqual(controls.staleSheet.getAttribute('aria-current'), null, 'stale menu state is removed');
});

test('runtime accessibility: grouped More pages mark both persistent More controls and exact menu items only when present', async () => {
  const { ctx, document } = await loadApp();
  const controls = makeNavigationFixture(document);
  ctx.showPage('boosterPacks');

  assert.strictEqual(controls.desktopMore.getAttribute('aria-current'), 'page');
  assert.strictEqual(controls.bottomMore.getAttribute('aria-current'), 'page');
  assert.strictEqual(controls.dropdownGuide.getAttribute('aria-current'), null, 'Booster Packs has no desktop child item');
  assert.strictEqual(controls.sheetGuide.getAttribute('aria-current'), null, 'Booster Packs has no sheet item');
  assert.strictEqual(controls.desktopInventory.getAttribute('aria-current'), null, 'normal-page state is cleared');

  ctx.showPage('guide');
  assert.strictEqual(controls.desktopMore.getAttribute('aria-current'), 'page');
  assert.strictEqual(controls.bottomMore.getAttribute('aria-current'), 'page');
  assert.strictEqual(controls.dropdownGuide.getAttribute('aria-current'), 'page');
  assert.strictEqual(controls.sheetGuide.getAttribute('aria-current'), 'page');
  assert.strictEqual(controls.staleSheet.getAttribute('aria-current'), null, 'only the exact sheet page is current');
});

test('runtime accessibility: Sealed exposure disclosure is a native labelled control with synced state', async () => {
  const { ctx, document } = await loadApp({
    seed: { etbs: [{ id: 'etb-1', status: 'In Stock', totalPrice: 50, marketPrice: 60 }] },
  });

  ctx.renderDashboard();
  const markup = document.getElementById('dash-exposure-body').innerHTML;
  const toggleTag = openingTagById(markup, 'exp-toggle-sealed');
  const subRowsTag = openingTagById(markup, 'exp-sub-sealed');
  assert.ok(toggleTag && toggleTag.startsWith('<button'), 'Sealed disclosure is a native button');
  assert.strictEqual(attribute(toggleTag, 'type'), 'button');
  assert.strictEqual(attribute(toggleTag, 'aria-controls'), 'exp-sub-sealed');
  assert.strictEqual(attribute(toggleTag, 'aria-expanded'), 'false');
  assert.ok(subRowsTag && subRowsTag.startsWith('<div'), 'the controlled target is rendered');
  assert.match(subRowsTag, /\bclass="exp-sub"/);

  const subRows = document.getElementById('exp-sub-sealed');
  const toggle = document.getElementById('exp-toggle-sealed');
  subRows.style.display = 'none';
  toggle.setAttribute('aria-expanded', 'false');

  ctx._toggleExposureSub('sealed');
  assert.strictEqual(subRows.style.display, 'block');
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'true');

  ctx._toggleExposureSub('sealed');
  assert.strictEqual(subRows.style.display, 'none');
  assert.strictEqual(toggle.getAttribute('aria-expanded'), 'false');
});

test('runtime accessibility: each generated API Settings input has an associated label', async () => {
  const { ctx, document } = await loadApp();
  ctx.openApiSettings();
  const markup = document.body._lastInsertedHTML;

  for (const id of ['ppt-key-input', 'ai-provider-select', 'gemini-key-input', 'groq-key-input', 'openrouter-key-input', 'anthropic-key-input']) {
    const controlTag = openingTagById(markup, id);
    const labelTags = (markup.match(/<label\b[^>]*>/g) || []).filter(tag => attribute(tag, 'for') === id);
    assert.ok(controlTag && /^(<input|<select)/.test(controlTag), id + ' is a generated form control');
    assert.strictEqual(labelTags.length, 1, id + ' has exactly one associated generated label');
    assert.strictEqual(attribute(labelTags[0], 'for'), attribute(controlTag, 'id'));
  }
});
