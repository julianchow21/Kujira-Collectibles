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

// v3.73: the desktop is a sidebar of exact items (the More dropdown is retired), the phone has a tab bar with a More tab and the
// More sheet. The fixture has five sidebar items, the three tab-bar items that matter and the sheet entries for Guide and a stale one.
function makeNavigationFixture(document) {
  const controls = {
    sidebarDashboard: document.getElementById('sidebar-dashboard'),
    sidebarInventory: document.getElementById('sidebar-inventory'),
    sidebarSlabs: document.getElementById('sidebar-slabs'),
    sidebarBoxes: document.getElementById('sidebar-boxes'),
    sidebarGuide: document.getElementById('sidebar-guide'),
    bottomDashboard: document.getElementById('bottom-dashboard'),
    bottomInventory: document.getElementById('bottom-inventory'),
    bottomMore: document.getElementById('btb-more'),
    sheetGuide: document.getElementById('sheet-guide'),
    staleSheet: document.getElementById('sheet-stale'),
  };
  controls.sidebarDashboard.setAttribute('onclick', "showPage('dashboard')");
  controls.sidebarInventory.setAttribute('onclick', "showPage('inventory')");
  controls.sidebarSlabs.setAttribute('onclick', "showPage('slabs')");
  controls.sidebarBoxes.setAttribute('onclick', "showPage('boosterBoxes')");
  controls.sidebarGuide.setAttribute('onclick', "showPage('guide')");
  controls.bottomDashboard.setAttribute('onclick', "showPage('dashboard')");
  controls.bottomInventory.setAttribute('onclick', "showPage('inventory')");
  controls.bottomMore.setAttribute('onclick', 'openMoreSheet()');
  controls.sheetGuide.setAttribute('onclick', "moreGo('guide')");
  controls.sheetGuide.setAttribute('data-page', 'guide');
  controls.staleSheet.setAttribute('data-page', 'trash');
  Object.values(controls).forEach(control => control.setAttribute('aria-current', 'page'));

  document.querySelectorAll = selector => {
    if (selector === '.page') return [];
    if (selector === '.nav-btn') return [controls.sidebarDashboard, controls.sidebarInventory, controls.sidebarSlabs, controls.sidebarBoxes, controls.sidebarGuide];
    if (selector === '.btb-item') return [controls.bottomDashboard, controls.bottomInventory, controls.bottomMore];
    if (selector === '.nav-dd-item') return [];
    if (selector === '#more-sheet .sheet-item[data-page]') return [controls.sheetGuide, controls.staleSheet];
    return [];
  };
  const sidebar = [controls.sidebarDashboard, controls.sidebarInventory, controls.sidebarSlabs, controls.sidebarBoxes, controls.sidebarGuide];
  const bottom = [controls.bottomDashboard, controls.bottomInventory, controls.bottomMore];
  const current = list => list.filter(b => b.getAttribute('aria-current') === 'page');
  return { ...controls, sidebar, bottom, current };
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

  assert.strictEqual(controls.sidebarInventory.getAttribute('aria-current'), 'page');
  assert.strictEqual(controls.bottomInventory.getAttribute('aria-current'), 'page');
  assert.deepStrictEqual(controls.current(controls.sidebar), [controls.sidebarInventory], 'the sidebar has exactly one current item');
  assert.deepStrictEqual(controls.current(controls.bottom), [controls.bottomInventory], 'the tab bar has exactly one current item');
  assert.strictEqual(controls.staleSheet.getAttribute('aria-current'), null, 'stale menu state is removed');
});

test('runtime accessibility: the sidebar lights the exact item for every page, the tab bar lights Collection for the Collection pages and More for a page it has no tab for', async () => {
  const { ctx, document } = await loadApp();
  const controls = makeNavigationFixture(document);

  // Slabs has a sidebar item and no tab of its own: the Collection tab holds it on the phone, and More does not light for it
  ctx.showPage('slabs');
  assert.deepStrictEqual(controls.current(controls.sidebar), [controls.sidebarSlabs], 'the exact sidebar item, MORE_PAGES or not');
  assert.deepStrictEqual(controls.current(controls.bottom), [controls.bottomInventory], 'Slabs is held by the Collection tab on the phone');
  assert.strictEqual(controls.bottomMore.getAttribute('aria-current'), null, 'and More lets go of it');

  // Booster Packs has no item of its own, the item that holds it (Boxes & packs) is current, and the Collection tab holds it too
  ctx.showPage('boosterPacks');
  assert.deepStrictEqual(controls.current(controls.sidebar), [controls.sidebarBoxes]);
  assert.deepStrictEqual(controls.current(controls.bottom), [controls.bottomInventory]);
  assert.strictEqual(controls.sheetGuide.getAttribute('aria-current'), null, 'Booster Packs has no sheet item');
  ctx.showPage('boosterBoxes');
  assert.deepStrictEqual(controls.current(controls.sidebar), [controls.sidebarBoxes]);
  assert.deepStrictEqual(controls.current(controls.bottom), [controls.bottomInventory]);

  // Guide: its sidebar item, the More tab and its sheet entry, and only the exact sheet page
  ctx.showPage('guide');
  assert.deepStrictEqual(controls.current(controls.sidebar), [controls.sidebarGuide]);
  assert.deepStrictEqual(controls.current(controls.bottom), [controls.bottomMore]);
  assert.strictEqual(controls.sheetGuide.getAttribute('aria-current'), 'page');
  assert.strictEqual(controls.staleSheet.getAttribute('aria-current'), null, 'only the exact sheet page is current');

  // back to a page with a tab: More lets go and the sidebar follows
  ctx.showPage('dashboard');
  assert.deepStrictEqual(controls.current(controls.sidebar), [controls.sidebarDashboard]);
  assert.deepStrictEqual(controls.current(controls.bottom), [controls.bottomDashboard]);
  assert.strictEqual(controls.sheetGuide.getAttribute('aria-current'), null);
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
