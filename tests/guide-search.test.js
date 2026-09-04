'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT } = require('./harness.js');

test('guide search status: no-result guidance appears only while it is needed', async () => {
  const { ctx, document } = await loadApp();
  const status = document.getElementById('guide-search-status');
  const content = document.getElementById('guide-content');
  let nodes = [];
  ctx.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  content.querySelectorAll = () => [];
  document.createTreeWalker = () => ({ nextNode: () => nodes.shift() || null });
  document.createTextNode = text => ({ textContent: text });
  document.createDocumentFragment = () => ({ appendChild() {} });

  ctx.kjrGuideSearch('does not exist');
  assert.strictEqual(status.hidden, false);
  assert.strictEqual(status.textContent, 'No guide results. Clear the search to view the full guide.');

  ctx.kjrGuideSearch('');
  assert.strictEqual(status.hidden, true);
  assert.strictEqual(status.textContent, '');

  nodes = [{
    nodeValue: 'Guide content',
    parentNode: { tagName: 'P', replaceChild() {} },
  }];
  ctx.kjrGuideSearch('guide');
  assert.strictEqual(status.hidden, true);
  assert.strictEqual(status.textContent, '');
});

test('guide search: empty queries clear status, and matched queries clear a previous no-result state', () => {
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  const src = fs.readFileSync(ROOT + '/features.js', 'utf8');
  assert.match(html, /id="guide-search-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(src, /if \(!q\) \{\s*window\._kjrSetGuideSearchStatus\(false\);\s*return;/);
  assert.match(src, /if \(firstMatch\) firstMatch\.scrollIntoView\([\s\S]*?window\._kjrSetGuideSearchStatus\(!firstMatch\);/);
  const guideSearch = src.match(/window\.kjrGuideSearch = function\(query\) \{[\s\S]*?\n  \};/)[0];
  assert.doesNotMatch(guideSearch, /content\.style\.display\s*=/, 'search status must not hide guide content');
});
