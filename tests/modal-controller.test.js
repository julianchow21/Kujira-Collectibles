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
const { loadApp, plain, ROOT } = require('./harness.js');

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

// ── a dirty form, Esc, and a dialog the browser shuts by itself (v3.84) ──────────────────────────────────────────────────────────────
// Chromium fires Esc's 'cancel' with cancelable:false when the page has had no recent tap or key press (and for a second Esc in a row),
// so preventDefault changes nothing: the handlers run, then the browser shuts the dialog itself. On a dirty form that used to leave the
// Discard prompt up over a dead dialog: Keep editing could not bring the form back, and its stack entry, the scroll lock and the history
// entry stayed behind. features.js also bound a second cancel and click handler on every dialog, so one Esc asked the question twice.
// nativeEsc is that browser: the handlers run first, then the default action shuts the dialog and its 'close' event follows. The stub
// dialogs send 'close' at once when they are closed, the browser sends it a moment later, so a test that needs the gap holds it back.
function nativeEsc(dlg) {
  dlg.dispatchEvent({ type: 'cancel', cancelable: false, preventDefault() {} });
  dlg.open = false;
  dlg.dispatchEvent({ type: 'close' });
}
// A kjrConfirm the test answers by hand: answer(true) is Discard, answer(false) is Keep editing. asked collects every question put.
function handAnswered(ctx) {
  const h = { asked: [], answer: null };
  ctx.kjrConfirm = (msg, opts) => { h.asked.push({ msg, opts }); return new Promise((resolve) => { h.answer = resolve; }); };
  return h;
}

test('modal controller: one dismiss of a dirty form asks the Discard question once, whoever asks and however many ask while it is up', async () => {
  const app = await loadApp();
  const b = browser(app, 'at call');
  const { ctx, document: doc } = app;
  const form = doc.getElementById('modal-single');
  const h = handAnswered(ctx);
  ctx.kjrModalCtrl.open(form);
  form.dataset.dirty = '1';
  const bound = (type) => (form._listeners.get(type) || []).length;
  assert.equal(bound('cancel'), 1, 'Esc has one handler on a dialog, the controller\'s');
  assert.equal(bound('click'), 1, 'so has a tap on the backdrop');
  assert.equal(bound('close'), 1, 'and the close event, for a dialog the browser shuts');
  form.dispatchEvent({ type: 'cancel', preventDefault() {} }); // Esc
  assert.equal(h.asked.length, 1, 'Esc asks once');
  assert.equal(h.asked[0].msg, 'Discard unsaved changes?');
  assert.deepEqual(plain(h.asked[0].opts), { ok: 'Discard', danger: true });
  form.dispatchEvent({ type: 'click', target: form }); // a tap on the backdrop while the question is up
  ctx.kjrModalCtrl.close(form); // and a script closing it too
  assert.equal(h.asked.length, 1, 'a second ask while the question is up shares it, no second prompt on top of the first');
  h.answer(false);
  await app.settle();
  assert.equal(form.open, true, 'Keep editing leaves it open');
  assert.equal(form.dataset.dirty, '1', 'with its unsaved-changes flag');
  form.dispatchEvent({ type: 'cancel', preventDefault() {} }); // a fresh dismiss after the answer is a fresh question
  assert.equal(h.asked.length, 2);
  h.answer(true);
  await app.settle();
  assert.equal(form.open, false, 'Discard closes it');
  assert.equal(overflow(app), '');
  b.settle();
  assert.equal(b.index, 0, 'and gives its history entry back');
});

test('modal controller: the controller is the only code that binds Esc (cancel) on a dialog, features.js and the Dealer Desk scripts do not', () => {
  const bindings = (src) => (src.match(/addEventListener\(\s*['"]cancel['"]/g) || []).length;
  const read = (f) => fs.readFileSync(ROOT + '/' + f, 'utf8');
  assert.equal(bindings(appSrc), 1, 'app.js: the controller\'s, in open()');
  const features = read('features.js');
  assert.equal(bindings(features), 0, 'features.js bound a second pair on every dialog in the page, so one Esc on a dirty form asked twice');
  assert.doesNotMatch(features, /querySelectorAll\(\s*['"]dialog\[id\]['"]\s*\)/, 'no blanket binding over every dialog');
  for (const f of ['dealer-money.js', 'dealer-desk.js', 'dealer-ui.js', 'dealer-store.js', 'dealer-production-ui.js']) assert.equal(bindings(read(f)), 0, f);
  // the Discard prompt's own dialog is not one the controller opens, so a handler that calls preventDefault on its Esc would leave it unable to close
  assert.equal((appSrc.match(/kjr-confirm-dialog/g) || []).length > 0, true);
  const ctrlSrc = appSrc.slice(appSrc.indexOf('const kjrModalCtrl = (() => {'), appSrc.indexOf('// =========== DATA ==========='));
  assert.equal((ctrlSrc.match(/addEventListener\('close'/g) || []).length, 1, 'one close listener in open(), bound with the other two');
});

for (const mode of MODES) {
  test('modal controller (' + mode + '): Esc the browser acts on anyway shuts a dirty form, and the prompt decides: Keep editing brings the form back with its data and its focus, Discard finishes the close', async () => {
    for (const keep of [true, false]) {
      const app = await loadApp();
      const b = browser(app, mode);
      const { ctx, document: doc } = app;
      const ctrl = ctx.kjrModalCtrl;
      const form = doc.getElementById('modal-single');
      const state = { focused: 0, hook: 0, shows: 0 };
      const field = { value: 'Typed Card 99', isConnected: true, focus() { state.focused++; } };
      form.contains = (el) => el === field;
      const realShow = form.showModal;
      form.showModal = function () { state.shows++; return realShow.call(this); };
      const h = handAnswered(ctx);
      ctrl.open(form, { onClose: () => state.hook++ });
      form.dataset.dirty = '1';
      doc.activeElement = field; // the person is in a field when Esc is pressed
      nativeEsc(form);
      const tag = mode + ', ' + (keep ? 'keep editing' : 'discard') + ': ';
      assert.equal(h.asked.length, 1, tag + 'one prompt');
      assert.equal(form.open, false, tag + 'the browser shut it, so it waits for the answer rather than covering the prompt');
      assert.equal(overflow(app), 'hidden', tag + 'the scroll lock is still held for it');
      assert.equal(state.hook, 0, tag + 'nothing has been closed yet');
      doc.activeElement = null; // the prompt took focus
      h.answer(!keep); // the prompt says true for Discard
      await app.settle();
      if (keep) {
        assert.equal(form.open, true, tag + 'the form is back');
        assert.equal(state.shows, 2, tag + 'shown again once, after the answer (the first show was the open)');
        assert.equal(form.dataset.dirty, '1', tag + 'still unsaved');
        assert.equal(field.value, 'Typed Card 99', tag + 'the typed value was never touched');
        assert.equal(state.focused, 1, tag + 'focus goes back to the field it was in');
        assert.equal(overflow(app), 'hidden', tag + 'the page stays locked behind it');
        assert.equal(state.hook, 0, tag + 'not closed, so no onClose hook');
        assert.equal(b.index, 1, tag + 'its history entry was never given up');
        // a live dialog again: the next Esc asks again and Discard then closes it for good
        nativeEsc(form);
        assert.equal(h.asked.length, 2, tag + 'asked again');
        h.answer(true);
        await app.settle();
        assert.equal(form.open, false, tag + 'second time Discard');
        assert.equal(state.hook, 1);
        assert.equal(overflow(app), '');
        b.settle();
        assert.equal(b.index, 0);
        assert.equal(count(b, 'back'), 1, tag + 'one back() for the whole thing');
      } else {
        assert.equal(form.open, false, tag + 'Discard: it stays closed');
        assert.equal(state.shows, 1, tag + 'and is never shown again');
        assert.equal(state.hook, 1, tag + 'its onClose hook ran');
        assert.equal(form.dataset.dirty, '0');
        assert.equal(overflow(app), '', tag + 'the scroll is unlocked');
        assert.equal(count(b, 'back'), 1, tag + 'its history entry was given back');
        b.settle();
        assert.equal(b.index, 0);
      }
    }
  });
}

test('modal controller: a dirty form the browser shuts with no prompt up comes back at once, and one that cannot come back is torn down, once, never retried', async () => {
  const app = await loadApp();
  const b = browser(app, 'at call');
  const { ctx, document: doc } = app;
  const ctrl = ctx.kjrModalCtrl;
  const h = handAnswered(ctx);
  const form = doc.getElementById('modal-single');
  ctrl.open(form);
  form.dataset.dirty = '1';
  form.open = false; // shut by something nothing asked about
  form.dispatchEvent({ type: 'close' });
  assert.equal(form.open, true, 'never dropped silently: it is shown again');
  assert.equal(form.dataset.dirty, '1');
  assert.equal(h.asked.length, 0, 'with no question, nobody asked for a close');
  assert.equal(overflow(app), 'hidden');
  assert.equal(b.index, 1);
  form.dispatchEvent({ type: 'close' }); // a close event for a form that is open (a late one) is nothing
  assert.equal(form.open, true);

  // a dialog the page took away cannot be shown: one attempt, then the ordinary teardown so the page is not locked behind nothing
  const gone = await loadApp();
  const b2 = browser(gone, 'at call');
  const dlg = gone.document.getElementById('modal-slab');
  gone.ctx.kjrModalCtrl.open(dlg);
  dlg.dataset.dirty = '1';
  let tries = 0, hooks = 0;
  dlg._kjrOnClose = () => hooks++;
  dlg.showModal = () => { tries++; throw new Error('InvalidStateError'); };
  dlg.open = false;
  dlg.dispatchEvent({ type: 'close' });
  assert.equal(tries, 1, 'one attempt, no retry');
  assert.equal(overflow(gone), '', 'the page is unlocked');
  assert.equal(hooks, 1, 'and its onClose hook ran');
  assert.ok(gone.consoleErrors.some((m) => /could not bring a dialog back/.test(m)), 'the failure is on the console, not silent');
  assert.equal(count(b2, 'back'), 1);
  // Keep editing for a dialog that cannot come back ends the same way, and still says the dialog was not kept open by the question
  const third = await loadApp();
  browser(third, 'at call');
  const d3 = third.document.getElementById('modal-quick-sell');
  const h3 = handAnswered(third.ctx);
  third.ctx.kjrModalCtrl.open(d3);
  d3.dataset.dirty = '1';
  d3.showModal = () => { throw new Error('InvalidStateError'); };
  nativeEsc(d3);
  h3.answer(false);
  await third.settle();
  assert.equal(overflow(third), '', 'Keep editing on a dialog that cannot return does not leave the page locked');
  assert.equal(d3.open, false);
});

for (const mode of MODES) {
  test('modal controller (' + mode + '): a clean dialog the browser shuts by itself gets the ordinary teardown, stack, scroll lock, history and onClose hook, once', async () => {
    const app = await loadApp();
    const b = browser(app, mode);
    const { ctx, document: doc } = app;
    const ctrl = ctx.kjrModalCtrl;
    const dlg = doc.getElementById('cmd-overlay');
    let closed = 0;
    ctrl.open(dlg, { onClose: () => closed++ });
    assert.equal(overflow(app), 'hidden');
    assert.equal(b.index, 1);
    dlg.open = false; // the browser did it
    dlg.dispatchEvent({ type: 'close' });
    assert.equal(overflow(app), '', mode + ': the scroll lock is gone');
    assert.equal(closed, 1, mode + ': its onClose hook ran');
    assert.equal(count(b, 'back'), 1, mode + ': its history entry is given back');
    b.settle();
    assert.equal(b.index, 0);
    dlg.dispatchEvent({ type: 'close' }); // a second close event finds nothing left to do
    assert.equal(closed, 1);
    assert.equal(count(b, 'back'), 1);
    // the controller's own close is still one teardown (the stub sends 'close' at once, the entry is already off the stack by then)
    ctrl.open(dlg, { onClose: () => closed++ });
    await ctrl.close(dlg);
    assert.equal(closed, 2);
    assert.equal(count(b, 'back'), 2);
    b.settle();
    assert.equal(overflow(app), '');
    assert.equal(b.index, 0);
  });
}

test('modal controller: a dialog shut while another sits above it takes only its own entry, the scroll lock stays for the one still open', async () => {
  const app = await loadApp();
  const b = browser(app, 'at call');
  const { ctx, document: doc } = app;
  const ctrl = ctx.kjrModalCtrl;
  const lower = doc.getElementById('more-sheet-overlay'), upper = doc.getElementById('ver-overlay');
  ctrl.open(lower);
  ctrl.open(upper);
  lower.open = false;
  lower.dispatchEvent({ type: 'close' });
  assert.equal(upper.open, true);
  assert.equal(overflow(app), 'hidden', 'one dialog is still open');
  assert.equal(count(b, 'back'), 0, 'and the history entry is still its');
  upper.open = false;
  upper.dispatchEvent({ type: 'close' });
  assert.equal(overflow(app), '');
  assert.equal(count(b, 'back'), 1);
});

test('modal controller: the entry a prompt is about is found again once it is answered, so a dialog closing meanwhile cannot take its place', async () => {
  const app = await loadApp();
  browser(app, 'at call');
  const { ctx, document: doc } = app;
  const ctrl = ctx.kjrModalCtrl;
  const under = doc.getElementById('more-sheet-overlay'), form = doc.getElementById('modal-single');
  const h = handAnswered(ctx);
  ctrl.open(under);
  ctrl.open(form);
  form.dataset.dirty = '1';
  const closing = ctrl.close(form); // the prompt is up
  await ctrl.close(under, true); // the dialog beneath goes meanwhile (a Back press, closeAll, a script)
  h.answer(true);
  assert.equal(await closing, true, 'it closes (the old code looked the entry up by the index it had before the prompt, found nothing and threw)');
  assert.equal(form.open, false);
  assert.equal(overflow(app), '');
  // and a prompt about a dialog that something else closed while it was up is not an error either
  const again = doc.getElementById('modal-slab');
  ctrl.open(again);
  again.dataset.dirty = '1';
  const second = ctrl.close(again);
  await ctrl.close(again, true);
  h.answer(true);
  assert.equal(await second, true);
  assert.equal(overflow(app), '');
});

test('modal controller: the close event of a dialog the controller itself shut, arriving after it was opened again, tears nothing down', async () => {
  const app = await loadApp();
  const b = browser(app, 'at call');
  const { ctx, document: doc } = app;
  const ctrl = ctx.kjrModalCtrl;
  const dlg = doc.getElementById('cmd-overlay');
  const late = [];
  dlg.close = function () { this.open = false; late.push(() => this.dispatchEvent({ type: 'close' })); }; // the browser sends 'close' a moment later
  ctrl.open(dlg);
  ctrl.close(dlg);
  ctrl.open(dlg); // closed and opened again in the same breath
  assert.equal(dlg.open, true);
  late.forEach((send) => send()); // the first close's event arrives now
  assert.equal(dlg.open, true, 'still open');
  assert.equal(overflow(app), 'hidden', 'still locked');
  b.settle();
  b.userBack();
  assert.equal(dlg.open, false, 'a real Back still closes it');
  assert.equal(overflow(app), '');
});

test('css: Version History clips like the five other dialog wrappers, and nothing in it can be wider than the dialog (v3.84)', () => {
  const css = fs.readFileSync(ROOT + '/styles.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const bodies = (sel) => [...css.matchAll(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}', 'g'))].map((m) => m[1]);
  const wrappers = ['dialog.overlay', 'dialog.sheet-overlay', 'dialog.kjr-modal-back', 'dialog.kjr-confirm-back', 'dialog.kjr-complete-back', 'dialog.ver-overlay'];
  for (const sel of wrappers) {
    assert.ok(bodies(sel).some((b) => /overflow:hidden;overflow:clip/.test(b)), sel + ' clips: a modal dialog scrolls itself by default, and the list inside is what should scroll');
  }
  // the foot's input has a width of its own (20 characters), so without min-width:0 it pushed Save Version 40px out of the box at 320
  assert.ok(bodies('.ver-foot input').some((b) => /flex:1;min-width:0;/.test(b)), 'the input shrinks');
  assert.ok(bodies('.ver-item-info').some((b) => /flex:1;min-width:0/.test(b)), 'a version\'s text can be narrower than its longest word');
  assert.ok(bodies('.ver-item-name').some((b) => /overflow-wrap:anywhere/.test(b)), 'a long name wraps');
  assert.ok(bodies('.ver-item-meta').some((b) => /overflow-wrap:anywhere/.test(b)), 'so does the line under it');
  assert.ok(bodies('.ver-list').some((b) => /overflow-y:auto/.test(b) && /flex:1/.test(b)), 'the list is the thing that scrolls');
});
