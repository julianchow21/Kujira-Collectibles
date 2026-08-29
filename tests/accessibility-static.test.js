const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('index.html', 'utf8');

test('static accessibility controls and modal labels', () => {
  assert.match(html, /<button type="button" id="ai-panel-toggle"[^>]*aria-controls="ai-analyst-body"[^>]*aria-expanded="false"/);
  assert.match(html, /id="ai-chat-input"[^>]*aria-label="Ask AI Portfolio Analyst"/);
  assert.match(html, /onclick="clearAiChat\(\)"[^>]*aria-label="Clear chat"/);
  assert.match(html, /aria-label="Close Sentry errors"[^>]*onclick="closeSentryPanel\(\)"/);
  for (const prefix of ['ms', 'msl']) {
    const section = html.match(new RegExp(`<dialog class="overlay" id="modal-${prefix === 'ms' ? 'single' : 'slab'}"[\\s\\S]*?<\\/dialog>`))[0];
    const labels = [...section.matchAll(/<label class="lbl"([^>]*)>/g)];
    assert.ok(labels.length > 0);
    for (const match of labels) {
      const forMatch = match[1].match(/\bfor="([^"]+)"/);
      assert.ok(forMatch && forMatch[1], 'every visible modal label must have a non-empty for');
      assert.match(section, new RegExp(`<(?:input|select|textarea)[^>]*id="${forMatch[1]}"`));
    }
  }
});
