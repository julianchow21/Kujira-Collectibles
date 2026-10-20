'use strict';
// v3.85: kjrConfirm is re-entrant. There is one confirm dialog (#kjr-confirm-dialog), and the Back button's popstate handler calls
// kjrConfirm directly, so Back pressed while a Discard prompt was open (put there by Esc or a tap on the backdrop) put a second prompt
// on top: the first one's handlers were overwritten and its promise never settled. Now a second ask of the SAME question while a prompt
// is up shares that prompt and its one answer, and an ask of a DIFFERENT question is answered "no" at once and leaves the prompt alone.
// These tests run the real kjrConfirm against a confirm dialog the stub can open (the harness leaves it unable to, so that kjrConfirm
// falls back to window.confirm), and the real controller against a model of session history (the same one tests/modal-controller.test.js
// drives).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT } = require('./harness.js');

const appSrc = fs.readFileSync(ROOT + '/app.js', 'utf8');

// A session history, enough of it for the controller (see tests/modal-controller.test.js, this is the same model). entries[0] is the page.
// back() moves nothing until the test says settle(), then each traversal fires one popstate.
function browser(app, mode) {
  const entries = [{ state: null }];
  let index = 0;
  const pending = [];
  const log = [];
  const hist = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(state) { entries.length = index + 1; entries.push({ state }); index++; log.push('push'); },
    replaceState(state) { entries[index].state = state; },
    back() { pending.push(mode === 'at call' ? { to: index - 1 } : { by: -1 }); log.push('back'); },
    forward() {}, go() {},
  };
  app.sandbox.history = hist;
  const settle = () => {
    while (pending.length) {
      const p = pending.shift();
      const to = 'to' in p ? p.to : index + p.by;
      if (to < 0 || to >= entries.length || to === index) continue;
      index = to;
      app.sandbox.dispatchEvent({ type: 'popstate', state: entries[to].state });
    }
  };
  const userBack = () => { hist.back(); settle(); };
  return { hist, settle, userBack, log, get index() { return index; }, get length() { return entries.length; } };
}
const count = (b, what) => b.log.filter((x) => x === what).length;
const MODES = ['at call', 'at run'];

// Give the stub confirm dialog the showModal and close a real <dialog> has, and count how many times it was shown.
function realConfirm(app) {
  const doc = app.document;
  const dlg = doc.getElementById('kjr-confirm-dialog');
  const c = { dlg, shows: 0, closes: 0, ok: doc.getElementById('kjr-confirm-ok'), cancel: doc.getElementById('kjr-confirm-cancel'), msg: doc.getElementById('kjr-confirm-msg') };
  dlg.showModal = function () { c.shows++; this.open = true; };
  dlg.close = function () { c.closes++; this.open = false; this.dispatchEvent({ type: 'close' }); };
  c.clickOk = () => c.ok.onclick();
  c.clickCancel = () => c.cancel.onclick();
  c.tapBackdrop = () => dlg.dispatchEvent({ type: 'click', target: dlg });
  return c;
}
const DISCARD = ['Discard unsaved changes?', { ok: 'Discard', danger: true }];

// ── kjrConfirm on its own ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('kjrConfirm: the same question asked while it is up is the same prompt and the same answer, shown once', async () => {
  const app = await loadApp();
  const c = realConfirm(app);
  const first = app.ctx.kjrConfirm(...DISCARD);
  const second = app.ctx.kjrConfirm(...DISCARD);
  assert.equal(second, first, 'the very same promise');
  assert.equal(c.shows, 1, 'one dialog, shown once');
  assert.equal(c.msg.innerHTML, 'Discard unsaved changes?');
  assert.equal(c.ok.textContent, 'Discard');
  assert.equal(c.dlg.open, true);
  c.clickOk();
  assert.deepEqual([await first, await second], [true, true], 'one click, one answer for both askers');
  assert.equal(c.dlg.open, false);
  assert.equal(c.closes, 1);
  assert.equal(c.ok.onclick, null, 'and the handlers are released');
});

test('kjrConfirm: Cancel, a tap on the backdrop and Esc each answer every sharer "no"', async () => {
  for (const how of ['cancel', 'backdrop', 'esc']) {
    const app = await loadApp();
    const c = realConfirm(app);
    const a = app.ctx.kjrConfirm(...DISCARD), b = app.ctx.kjrConfirm(...DISCARD);
    if (how === 'cancel') c.clickCancel();
    else if (how === 'backdrop') c.tapBackdrop();
    else { c.dlg.open = false; c.dlg.dispatchEvent({ type: 'close' }); } // Esc: the browser shuts it and sends close
    assert.deepEqual([await a, await b], [false, false], how);
    assert.equal(c.shows, 1);
  }
});

test('kjrConfirm: a different question while one is up is answered "no" at once and does not touch the prompt on screen', async () => {
  const app = await loadApp();
  const c = realConfirm(app);
  const discard = app.ctx.kjrConfirm(...DISCARD);
  let deleted = false;
  const asked = app.ctx.kjrConfirm('Permanently delete 3 items?', { ok: 'Delete', danger: true });
  assert.notEqual(asked, discard);
  assert.equal(await asked, false, 'refused, not queued and not shared: the Discard click must never confirm a delete');
  if (await asked) deleted = true;
  assert.equal(deleted, false);
  assert.equal(c.shows, 1, 'no second dialog');
  assert.equal(c.msg.innerHTML, 'Discard unsaved changes?', 'the text on screen is still the first question');
  assert.equal(c.ok.textContent, 'Discard');
  c.clickOk();
  assert.equal(await discard, true, 'and the first prompt\'s answer is its own');
  assert.equal(deleted, false);
});

test('kjrConfirm: the same words with other buttons are another question', async () => {
  const app = await loadApp();
  const c = realConfirm(app);
  const a = app.ctx.kjrConfirm('Clear it?', { ok: 'Clear', danger: true });
  assert.equal(await app.ctx.kjrConfirm('Clear it?', { ok: 'Clear' }), false, 'not styled as dangerous');
  assert.equal(await app.ctx.kjrConfirm('Clear it?', { ok: 'Keep', danger: true }), false, 'another OK label');
  assert.equal(await app.ctx.kjrConfirm('Clear it?', { ok: 'Clear', cancel: 'Stop', danger: true }), false, 'another Cancel label');
  assert.equal(app.ctx.kjrConfirm('Clear it?', { ok: 'Clear', danger: true, ignored: 1 }), a, 'an option it does not read changes nothing');
  assert.equal(c.shows, 1);
  c.clickCancel();
  assert.equal(await a, false);
});

test('kjrConfirm: once a prompt is answered the next ask is a fresh prompt, never the settled answer', async () => {
  const app = await loadApp();
  const c = realConfirm(app);
  const a = app.ctx.kjrConfirm(...DISCARD);
  c.clickOk();
  const b = app.ctx.kjrConfirm(...DISCARD); // in the same breath, before the first answer has been read
  assert.notEqual(b, a, 'a new prompt');
  assert.equal(c.shows, 2);
  assert.equal(c.dlg.open, true);
  assert.equal(await a, true);
  c.clickCancel();
  assert.equal(await b, false, 'with its own answer');
  const d = app.ctx.kjrConfirm('Something else?', { ok: 'Go' });
  assert.equal(c.msg.innerHTML, 'Something else?');
  assert.equal(c.ok.textContent, 'Go');
  c.clickOk();
  assert.equal(await d, true);
});

test('kjrConfirm: a prompt whose dialog was shut without a close event is settled as "no" and replaced, so confirms keep working', async () => {
  const app = await loadApp();
  const c = realConfirm(app);
  const lost = app.ctx.kjrConfirm('First?', { ok: 'Yes' });
  c.dlg.open = false; // something shut it and no close event reached us
  const next = app.ctx.kjrConfirm('Second?', { ok: 'Yes' });
  assert.equal(await lost, false, 'the lost prompt is settled, not left hanging');
  assert.equal(c.shows, 2);
  assert.equal(c.msg.innerHTML, 'Second?');
  c.clickOk();
  assert.equal(await next, true, 'and the new one is a working prompt');
});

test('kjrConfirm: with no confirm dialog to open it still asks the browser\'s own, as before', async () => {
  const app = await loadApp();
  const seen = [];
  app.sandbox.confirm = (m) => { seen.push(m); return true; };
  assert.equal(await app.ctx.kjrConfirm('Remove <b>this</b>?', { ok: 'Remove' }), true);
  assert.deepEqual(seen, ['Remove this?']);
  const again = await Promise.all([app.ctx.kjrConfirm('A?'), app.ctx.kjrConfirm('B?')]);
  assert.deepEqual(again, [true, true], 'the native prompt blocks, so two asks are two prompts one after the other, as they were');
});

test('kjrConfirm: the guard is one block in front of the dialog work and nothing else in the function changed shape', () => {
  const fn = appSrc.slice(appSrc.indexOf('function kjrConfirm(msg, opts) {'), appSrc.indexOf('async function deleteSavedChart('));
  assert.equal((fn.match(/dlg\.showModal\(\)/g) || []).length, 1, 'one showModal, so one dialog');
  assert.ok(fn.indexOf('kjrConfirm._open') < fn.indexOf("msgEl.innerHTML = msg;"), 'the shared prompt is returned before the dialog\'s text or buttons are touched');
  assert.equal((fn.match(/kjrConfirm\._open = /g) || []).length, 2, 'set when a prompt opens, cleared when it settles');
});

// ── Back while a Discard prompt is open ───────────────────────────────────────────────────────────────────────────────────────────────

async function dirtyForm(mode) {
  const app = await loadApp();
  const b = browser(app, mode);
  const c = realConfirm(app);
  const form = app.document.getElementById('modal-single');
  app.ctx.kjrModalCtrl.open(form);
  form.dataset.dirty = '1';
  const esc = () => form.dispatchEvent({ type: 'cancel', preventDefault() {} });
  return { app, b, c, form, esc, overflow: () => app.document.body.style.overflow };
}

for (const mode of MODES) {
  test('Back while the Esc Discard prompt is open (' + mode + '): one prompt, Keep editing leaves the form open with its changes and the history as it was', async () => {
    const { app, b, c, form, esc, overflow } = await dirtyForm(mode);
    assert.equal(b.index, 1);
    esc();
    assert.equal(c.shows, 1);
    b.userBack();
    await app.settle();
    assert.equal(c.shows, 1, 'Back put no second prompt on top');
    assert.equal(c.dlg.open, true, 'the one prompt is still up');
    assert.equal(b.hist.state && b.hist.state.kjrModal, 1, 'the entry Back used up is put back');
    c.clickCancel();
    await app.settle();
    assert.equal(form.open, true, 'Keep editing: the form is still there');
    assert.equal(form.dataset.dirty, '1', 'with its unsaved flag, nothing was dropped');
    assert.equal(overflow(), 'hidden');
    assert.equal(count(b, 'back'), 1, 'only the user\'s own Back, the app asked for none');
    assert.equal(b.index, 1, 'and the page sits on a modal entry again');
    // and the form still closes the ordinary way afterwards
    esc();
    c.clickOk();
    await app.settle();
    assert.equal(form.open, false);
    b.settle();
    assert.equal(b.index, 0);
  });

  test('Back while the Esc Discard prompt is open (' + mode + '): Discard closes the form once and asks the history for exactly one back()', async () => {
    const { app, b, c, form, esc, overflow } = await dirtyForm(mode);
    esc();
    b.userBack();
    await app.settle();
    const backsBefore = count(b, 'back');
    assert.equal(c.shows, 1);
    c.clickOk();
    await app.settle();
    assert.equal(form.open, false, 'Discard closes it');
    assert.equal(overflow(), '');
    assert.equal(count(b, 'back') - backsBefore, 1, 'one back() to give the modal entry up, not two (a second would leave the page)');
    b.settle();
    assert.equal(b.index, 0, 'the history is on the page\'s own entry, not before it');
    assert.equal(count(b, 'back'), 2, 'the user\'s Back and the one the app asked for');
  });

  test('Esc while the Back Discard prompt is open (' + mode + '): the same one prompt, Discard closes once with one back()', async () => {
    const { app, b, c, form, esc, overflow } = await dirtyForm(mode);
    b.userBack(); // Back first: its handler puts the question
    await app.settle();
    assert.equal(c.shows, 1);
    esc(); // then Esc, while it is up
    assert.equal(c.shows, 1, 'Esc shares the prompt Back opened');
    const backsBefore = count(b, 'back');
    c.clickOk();
    await app.settle();
    assert.equal(form.open, false);
    assert.equal(overflow(), '');
    assert.equal(count(b, 'back') - backsBefore, 1);
    b.settle();
    assert.equal(b.index, 0);
  });

  test('Back pressed twice while the prompt is up (' + mode + '): still one prompt, Keep editing leaves exactly one modal entry, Discard exactly one back()', async () => {
    for (const keep of [true, false]) {
      const { app, b, c, form, overflow } = await dirtyForm(mode);
      b.userBack();
      await app.settle();
      b.userBack();
      await app.settle();
      assert.equal(c.shows, 1, 'one prompt for two Backs');
      assert.equal(b.length, 2, 'the history is the page and one modal entry, not a growing pile');
      assert.equal(b.index, 1);
      const before = count(b, 'back');
      if (keep) {
        c.clickCancel();
        await app.settle();
        assert.equal(form.open, true);
        assert.equal(form.dataset.dirty, '1');
        assert.equal(count(b, 'back'), before, 'no back() asked');
        assert.equal(b.index, 1);
      } else {
        c.clickOk();
        await app.settle();
        assert.equal(form.open, false);
        assert.equal(overflow(), '');
        assert.equal(count(b, 'back') - before, 1);
        b.settle();
        assert.equal(b.index, 0);
      }
    }
  });

  test('Back while a different prompt is open (' + mode + '): the Discard question is not stacked on it, the form is kept, and the open prompt still works', async () => {
    const { app, b, c, form } = await dirtyForm(mode);
    const del = app.ctx.kjrConfirm('Permanently delete this item? Cannot be undone.', { ok: 'Delete forever', danger: true });
    assert.equal(c.shows, 1);
    b.userBack();
    await app.settle();
    assert.equal(c.shows, 1, 'no second dialog');
    assert.equal(c.msg.innerHTML, 'Permanently delete this item? Cannot be undone.', 'the prompt on screen is the delete one, unchanged');
    assert.equal(form.open, true, 'Back could not ask its question, so the form stays: nothing is discarded unasked');
    assert.equal(form.dataset.dirty, '1');
    assert.equal(b.hist.state && b.hist.state.kjrModal, 1, 'and the entry Back used up was put back');
    c.clickOk();
    assert.equal(await del, true, 'the delete prompt\'s own answer is its own');
    await app.settle();
    assert.equal(form.open, true, 'answering it discarded nothing');
    assert.equal(count(b, 'back'), 1, 'only the user\'s Back');
  });

  test('the dialogs are closed another way while the Back prompt is up (' + mode + '): the answer afterwards asks for no second back()', async () => {
    const { app, b, c, form } = await dirtyForm(mode);
    b.userBack();
    await app.settle();
    assert.equal(c.shows, 1);
    app.ctx.kjrModalCtrl.closeAll(); // a script tears every dialog down (force) and gives the history entry back
    assert.equal(form.open, false);
    const backs = count(b, 'back');
    assert.equal(backs, 2, 'the user\'s Back and the teardown\'s');
    c.clickOk(); // the prompt that was up is answered afterwards
    await app.settle();
    assert.equal(count(b, 'back'), backs, 'there was nothing left to close, so no third back() that would leave the page');
    b.settle();
    assert.equal(b.index, 0);
  });
}

test('Back with a clean dialog is unchanged: it closes with no prompt at all', async () => {
  for (const mode of MODES) {
    const app = await loadApp();
    const b = browser(app, mode);
    const c = realConfirm(app);
    const form = app.document.getElementById('modal-single');
    app.ctx.kjrModalCtrl.open(form);
    b.userBack();
    await app.settle();
    assert.equal(c.shows, 0);
    assert.equal(form.open, false);
    assert.equal(b.index, 0);
    assert.equal(count(b, 'back'), 1, 'only the user\'s own');
  }
});

test('the popstate handler\'s guard is one line and reads the stack and the pushed flag', () => {
  const ctrlSrc = appSrc.slice(appSrc.indexOf('const kjrModalCtrl = (() => {'), appSrc.indexOf('// =========== DATA ===========')).replace(/\/\/[^\n]*/g, '');
  assert.equal((ctrlSrc.match(/if \(stack\.length === 0 && !pushed\) return;/g) || []).length, 1);
  assert.equal((ctrlSrc.match(/history\.back\(\)/g) || []).length, 1, 'still one history.back() in the controller, inside goBack');
  assert.equal((ctrlSrc.match(/goBack\(\)/g) || []).length, 3, 'and still three goBack() texts: the definition, close() and the unsaved-changes path');
});
