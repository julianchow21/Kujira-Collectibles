'use strict';
// kjrModalCtrl and the browser's history (v3.74). The controller pushes one history entry while any dialog is open, and when the last
// dialog closes it goes back one entry with history.back(). That is a navigation, so its popstate arrives a moment later. A close
// followed straight away by an open (the phone's More sheet, then Log Sale, Version history or Health check) used to meet that
// popstate with the new dialog on the stack, and the popstate handler closed it as if the user had pressed Back. The controller now
// notes the time of its own back() and its popstate listener lets that one pop through (goBack, selfPopAt). These tests drive the real
// controller from app.js against a small model of session history, run in the two ways browsers differ on where a back() goes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT } = require('./harness.js');

const appSrc = fs.readFileSync(ROOT + '/app.js', 'utf8');

// A session history, enough of it for the controller. entries[0] is the page itself. back() does not move at once: the browser does it
// a moment later, and the test says when (settle), which is the gap the bug lives in. Browsers differ on where a back() goes, so both
// are modelled:
//   'at call'  the entry is worked out when back() is called (Chromium, measured in the browser at 375px: with a dialog opened in
//              between, the pop lands on the page's own entry, two back, with the new dialog's entry still ahead of it)
//   'at run'   the entry is worked out when the traversal runs (the HTML spec's model: the pop lands on the old modal entry)
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
    forward() {},
    go() {},
  };
  app.sandbox.history = hist;
  // The browser does the traversals it was asked for, one popstate each. The listener may push (the controller's repair), so the
  // index is read live.
  const settle = () => {
    while (pending.length) {
      const p = pending.shift();
      const to = 'to' in p ? p.to : index + p.by;
      if (to < 0 || to >= entries.length || to === index) continue;
      index = to;
      app.sandbox.dispatchEvent({ type: 'popstate', state: entries[to].state });
    }
  };
  // The device's Back button: a traversal nothing in the app asked for.
  const userBack = () => { hist.back(); settle(); };
  return { hist, settle, userBack, pending, log, get index() { return index; }, get length() { return entries.length; } };
}
const count = (b, what) => b.log.filter((x) => x === what).length;
const overflow = (app) => app.document.body.style.overflow;
const MODES = ['at call', 'at run'];

for (const mode of MODES) {
  test('modal controller (' + mode + '): a dialog opened right after the last one closed survives the pop the close asked for, and a real Back still closes it', async () => {
    const app = await loadApp();
    const b = browser(app, mode);
    const ctrl = app.ctx.kjrModalCtrl;
    const first = app.document.getElementById('more-sheet-overlay');
    const next = app.document.getElementById('ver-overlay');
    ctrl.open(first);
    assert.equal(b.index, 1, 'one modal entry while a dialog is open');
    assert.equal(b.hist.state.kjrModal, 1);
    ctrl.close(first); // the click: the sheet closes ...
    ctrl.open(next); // ... and the next dialog opens in the same breath
    assert.equal(next.open, true);
    b.settle(); // the pop the close asked for now arrives
    assert.equal(next.open, true, 'the new dialog is still open');
    assert.equal(overflow(app), 'hidden', 'and still holds the scroll lock');
    assert.equal(b.hist.state && b.hist.state.kjrModal, 1, 'whichever entry the pop landed on, the page now sits on a modal entry');
    // Chromium lands on the page's own entry, so one entry is pushed to put a modal entry back, the spec's model lands on one already
    assert.equal(count(b, 'push'), mode === 'at call' ? 3 : 2, mode === 'at call' ? 'the first open, the second open, and the repair' : 'the first open and the second open, no repair');
    b.userBack(); // the real Back button
    assert.equal(next.open, false, 'closes it');
    assert.equal(overflow(app), '');
    assert.equal(b.index, 0, 'and the history is back on the page\'s own entry');
  });

  test('modal controller (' + mode + '): the More sheet\'s Log Sale, Version history and Health check all end with their dialog open', async () => {
    const flows = [
      ['Log Sale', (ctx) => ctx.openCmdBar('sell'), 'cmd-overlay'],
      ['Version history', (ctx) => ctx.openVerModal(), 'ver-overlay'],
      ['Health check', (ctx) => ctx.runHealthCheck(), 'health-overlay'],
    ];
    for (const [name, openIt, id] of flows) {
      const app = await loadApp();
      const b = browser(app, mode);
      const { ctx, document: doc } = app;
      ctx.openMoreSheet();
      const sheet = doc.getElementById('more-sheet-overlay');
      assert.equal(sheet.open, true, name + ': the sheet is open');
      // the same two calls the sheet's buttons make
      ctx.closeMoreSheet();
      openIt(ctx);
      b.settle();
      assert.equal(sheet.open, false, name + ': the sheet closed');
      assert.equal(doc.getElementById(id).open, true, name + ': its dialog is open once the pop has arrived');
      assert.equal(overflow(app), 'hidden', name);
      b.userBack();
      assert.equal(doc.getElementById(id).open, false, name + ': Back closes it');
      assert.equal(overflow(app), '', name);
      assert.equal(b.index, 0, name);
    }
  });

  test('modal controller (' + mode + '): a genuine Back with a dialog open closes it, runs its onClose once, and leaves the history on the page\'s entry', async () => {
    const app = await loadApp();
    const b = browser(app, mode);
    const ctrl = app.ctx.kjrModalCtrl;
    const dlg = app.document.getElementById('cmd-overlay');
    let closed = 0;
    ctrl.open(dlg, { onClose: () => closed++ });
    assert.equal(b.index, 1);
    b.userBack();
    assert.equal(dlg.open, false);
    assert.equal(closed, 1, 'the onClose hook runs on a Back close too');
    assert.equal(overflow(app), '');
    assert.equal(b.index, 0);
    assert.equal(count(b, 'back'), 1, 'closing from a popstate never asks for a second back()');
    // two dialogs stacked: one Back closes both, the controller's own teardown
    ctrl.open(app.document.getElementById('more-sheet-overlay'));
    ctrl.open(app.document.getElementById('ver-overlay'));
    assert.equal(count(b, 'push'), 2, 'one entry for the whole stack');
    b.userBack();
    assert.deepEqual([app.document.getElementById('more-sheet-overlay').open, app.document.getElementById('ver-overlay').open], [false, false]);
    assert.equal(overflow(app), '');
  });

  test('modal controller (' + mode + '): a self pop with nothing reopened leaves the stack empty, and the next open is a first open again', async () => {
    const app = await loadApp();
    const b = browser(app, mode);
    const ctrl = app.ctx.kjrModalCtrl;
    const a = app.document.getElementById('more-sheet-overlay');
    ctrl.open(a);
    ctrl.close(a);
    assert.equal(a.open, false);
    b.settle();
    assert.equal(a.open, false);
    assert.equal(overflow(app), '');
    assert.equal(b.index, 0);
    assert.equal(count(b, 'push'), 1, 'no repair push when nothing is open');
    // the pop was swallowed once and only once: opening again pushes, and a real Back closes
    const c = app.document.getElementById('ver-overlay');
    ctrl.open(c);
    assert.equal(count(b, 'push'), 2);
    b.userBack();
    assert.equal(c.open, false, 'the marker did not outlive its pop');
    assert.equal(overflow(app), '');
  });

  test('modal controller (' + mode + '): closeAll asks for one back, its pop is let through, and Esc and a tap on the backdrop still close', async () => {
    const app = await loadApp();
    const b = browser(app, mode);
    const ctrl = app.ctx.kjrModalCtrl;
    const doc = app.document;
    const x = doc.getElementById('more-sheet-overlay'), y = doc.getElementById('ver-overlay');
    ctrl.open(x);
    ctrl.open(y);
    ctrl.closeAll();
    assert.deepEqual([x.open, y.open], [false, false]);
    assert.equal(count(b, 'back'), 1, 'one back() for the whole stack');
    b.settle();
    assert.equal(overflow(app), '');
    // Esc is the dialog's cancel event, a tap on the backdrop is a click on the dialog itself (both go through the controller)
    const dlg = doc.getElementById('cmd-overlay');
    ctrl.open(dlg);
    dlg.dispatchEvent({ type: 'cancel', preventDefault() {} });
    assert.equal(dlg.open, false, 'Esc');
    b.settle();
    ctrl.open(dlg);
    dlg.dispatchEvent({ type: 'click', target: dlg });
    assert.equal(dlg.open, false, 'backdrop');
    b.settle();
    ctrl.open(dlg);
    dlg.dispatchEvent({ type: 'click', target: { id: 'a child' } });
    assert.equal(dlg.open, true, 'a tap inside the dialog does not');
    b.userBack();
    assert.equal(dlg.open, false);
    assert.equal(overflow(app), '');
    // and Esc, then straight away another dialog, is the same race as the sheet's buttons and gets the same answer
    const e1 = doc.getElementById('more-sheet-overlay'), e2 = doc.getElementById('ver-overlay');
    ctrl.open(e1);
    e1.dispatchEvent({ type: 'cancel', preventDefault() {} });
    ctrl.open(e2);
    b.settle();
    assert.equal(e2.open, true);
    b.userBack();
    assert.equal(e2.open, false);
  });
}

for (const mode of MODES) {
  test('palette (' + mode + '): Add single, Add slab and a card in the narrow inspector sheet reuse the bar\'s history entry, Back closes what opened, and closing the bar first works too', async () => {
    const { makeSeed } = require('./harness.js');
    const seed = makeSeed({ singles: [Object.assign({}, makeSeed().singles[0], { id: 'pika', name: 'Pikachu 25' })] });
    const app = await loadApp({ seed });
    const b = browser(app, mode);
    const { ctx, document: doc } = app;
    const sheet = doc.getElementById('kjr-insp-sheet');
    // the harness's stub elements have no tag, openModal only goes through the controller for a <dialog>
    ['modal-single', 'modal-slab'].forEach((id) => { doc.getElementById(id).tagName = 'DIALOG'; });
    ctx.showPage = () => {};
    // the narrow window: the inspector is a dialog, opened through the controller like every other
    ctx.kjrInspect = (t, id, o) => { ctx.kjrModalCtrl.open(sheet, { trigger: o.trigger }); return true; };
    const cases = [
      ['Add single', 'add single', (r) => r.key === 'add-single', 'modal-single'],
      ['Add slab', 'add slab', (r) => r.key === 'add-slab', 'modal-slab'],
      ['a card (the inspector sheet)', 'pikachu', (r) => r.kind === 'card', 'kjr-insp-sheet'],
    ];
    for (const [name, query, is, id] of cases) {
      const pushes = count(b, 'push'), backs = count(b, 'back');
      ctx.openCmdBar('find');
      doc.getElementById('cmd-find-input').value = query;
      ctx.cmdFindSearch();
      ctx.cmdFindRun(Array.from(ctx.cmdFindResults).findIndex(is));
      b.settle();
      const target = doc.getElementById(id);
      assert.equal(target.open, true, name + ': open');
      assert.equal(doc.getElementById('cmd-overlay').open, false, name + ': the bar is closed');
      assert.equal(count(b, 'push') - pushes, 1, name + ': one history entry, the one the bar pushed');
      assert.equal(count(b, 'back') - backs, 0, name + ': no back() while a dialog is open, so no pop to race');
      b.userBack();
      assert.equal(target.open, false, name + ': Back closes it');
      assert.equal(overflow(app), '', name);
      assert.equal(b.index, 0, name);
    }
    // the order the packet first asked for (close the bar, then open) works as well now that the controller copes with it
    const form = doc.getElementById('modal-single');
    ctx.openCmdBar('find');
    ctx.closeCmdBar();
    ctx.openAddSingle();
    b.settle();
    assert.equal(form.open, true, 'close first, open second: still open once the pop has arrived');
    b.userBack();
    assert.equal(form.open, false);
    assert.equal(overflow(app), '');
  });
}

test('modal controller: a marker older than the window does not swallow a real Back, and one inside it is the controller\'s own pop', async () => {
  for (const mode of MODES) {
    const app = await loadApp();
    const b = browser(app, mode);
    const RealDate = app.ctx.Date;
    let now = RealDate.now();
    class FakeDate extends RealDate { static now() { return now; } }
    app.sandbox.Date = FakeDate;
    const ctrl = app.ctx.kjrModalCtrl;
    const doc = app.document;
    const a = doc.getElementById('more-sheet-overlay'), c = doc.getElementById('ver-overlay'), d = doc.getElementById('cmd-overlay');
    // a back() whose pop never arrives (the browser had nowhere to go), then a long while, then a dialog and a genuine Back
    ctrl.open(a);
    ctrl.close(a);
    b.pending.length = 0;
    now += 1500;
    ctrl.open(c);
    b.userBack();
    assert.equal(c.open, false, mode + ': a stale marker did not swallow the real Back');
    assert.equal(overflow(app), '');
    // the same, inside the window: the pop cannot be told from the controller's own, so it is let through (this is the design)
    ctrl.open(a);
    ctrl.close(a);
    b.pending.length = 0;
    now += 500;
    ctrl.open(d);
    b.userBack();
    assert.equal(d.open, true, mode + ': inside the window the pop is taken as the controller\'s own');
    // and it is one pop only: the next Back is real
    b.userBack();
    assert.equal(d.open, false, mode + ': the one after it closes the dialog');
    assert.equal(RealDate.now() > 0, true);
  }
});

test('modal controller: the unsaved-changes guard is unchanged (Back asks, keep editing stays open, Discard closes) and its own back() is marked as well', async () => {
  for (const mode of MODES) {
    const app = await loadApp();
    const b = browser(app, mode);
    const { ctx, document: doc } = app;
    const ctrl = ctx.kjrModalCtrl;
    const form = doc.getElementById('modal-single');
    const asked = [];
    ctx.kjrConfirm = async (msg) => { asked.push(msg); return answer; };
    let answer = false;
    ctrl.open(form);
    form.dataset.dirty = '1'; // an edit
    b.userBack();
    await app.settle();
    assert.deepEqual(asked, ['Discard unsaved changes?'], mode + ': the Back press asks first');
    assert.equal(form.open, true, mode + ': keep editing leaves it open');
    assert.equal(b.hist.state && b.hist.state.kjrModal, 1, mode + ': and the entry the Back press used up is pushed again');
    // discard: it closes, and its back() is marked, so a dialog opened right after it is not closed by the pop
    answer = true;
    b.userBack();
    await app.settle();
    assert.equal(form.open, false, mode + ': Discard closes it');
    const next = doc.getElementById('ver-overlay');
    ctrl.open(next);
    b.settle();
    assert.equal(next.open, true, mode + ': the pop from the Discard back() did not close the dialog opened after it');
    b.userBack();
    assert.equal(next.open, false, mode + ': a real Back does');
    assert.equal(overflow(app), '');
  }
});

test('modal controller: one history.back() in the controller, inside goBack, and the popstate listener reads the marker first', () => {
  // the controller's code, comments left out (they talk about history.back() too)
  const ctrlSrc = appSrc.slice(appSrc.indexOf('const kjrModalCtrl = (() => {'), appSrc.indexOf('// =========== DATA ===========')).replace(/\/\/[^\n]*/g, '');
  assert.equal((ctrlSrc.match(/history\.back\(\)/g) || []).length, 1, 'every back() the controller asks for goes through goBack');
  assert.match(ctrlSrc, /function goBack\(\) \{\n    selfPopAt = Date\.now\(\);\n    history\.back\(\);\n  \}/);
  assert.equal((ctrlSrc.match(/goBack\(\)/g) || []).length, 3, 'the definition, close(), and the unsaved-changes path');
  assert.match(ctrlSrc, /const SELF_POP_WINDOW_MS = 1000;/);
  const listener = ctrlSrc.slice(ctrlSrc.indexOf("window.addEventListener('popstate'"));
  assert.ok(listener.indexOf('if (selfPopAt)') > 0 && listener.indexOf('if (selfPopAt)') < listener.indexOf('if (stack.length === 0) return;'), 'the marker is checked before anything is closed');
  assert.match(listener, /if \(!\(history\.state && history\.state\.kjrModal\)\) history\.pushState\(\{ kjrModal: 1 \}, ''\);/);
});
