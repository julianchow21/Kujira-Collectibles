'use strict';
// v3.93, the pacing toast ("Waiting N seconds to keep within the Free plan's pace", _kjrPptPace) was drawn with the tick, which reads as done. toast() has a
// neutral variant now, toastInfo: the info icon in blue, with a blue edge and bar (class toast-info), where the tick and the accent edge are. It keeps the dismiss
// time it is given (it is no error), the words carry the message and the icon shape and colour are only a second cue, and only the pacing toast uses it.
// Every other suite replaces toast with a recorder. This one runs the REAL toast against the harness's stub elements and reads what it drew, so the ordinary
// variants are pinned here too: the neutral one must not move them.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT } = require('./harness.js');
const { setClock } = require('./clock.js');

const VARIANTS = ['toast-error', 'toast-warn', 'toast-info'];
// what the toast looks like right now, read off the elements toast() draws on
const look = (app) => {
  const t = app.document.getElementById('toast');
  const icon = app.document.getElementById('toast-icon');
  return { classes: VARIANTS.filter((c) => t.classList.contains(c)), shown: t.classList.contains('show'), icon: icon.textContent, colour: icon.style.color, msg: app.document.getElementById('toast-msg').textContent };
};
// the timers a call added: the toast's own dismiss timer is the one that carries the dismiss time
const added = (app, call) => {
  const before = new Set(app.timers.list().map((t) => t.id));
  call();
  return app.timers.list().filter((t) => !before.has(t.id)).sort((a, b) => a.delay - b.delay);
};
const delays = (timers) => timers.map((t) => t.delay);

// ── the ordinary variants are as they were ──────────────────────────────────────────────────────────────────────────────────────────────

test('toast: ordinary calls look exactly as they did, the tick on the accent, the cross on red for an error, the warning for a leading warning glyph', async () => {
  const app = await loadApp({ realToast: true });
  // plain: the tick, the accent, 2.8 seconds unless asked for another time
  assert.deepEqual(delays(added(app, () => app.ctx.toast('Saved'))), [2800]);
  assert.deepEqual(look(app), { classes: [], shown: true, icon: '✓', colour: 'var(--accent)', msg: 'Saved' });
  assert.deepEqual(delays(added(app, () => app.ctx.toast('Saved', 4000))), [4000], 'the dismiss time asked for');
  // an error, by the flag and by the helper: the cross, red, and six seconds whatever was asked
  assert.deepEqual(delays(added(app, () => app.ctx.toast('Broke', 1000, true))), [6000]);
  assert.deepEqual(look(app), { classes: ['toast-error'], shown: true, icon: '✕', colour: 'var(--red)', msg: 'Broke' });
  assert.deepEqual(delays(added(app, () => app.ctx.toastError('Broke too'))), [6000]);
  assert.deepEqual(look(app), { classes: ['toast-error'], shown: true, icon: '✕', colour: 'var(--red)', msg: 'Broke too' });
  // a warning: a leading glyph picks it, and the glyph is not shown twice
  assert.deepEqual(delays(added(app, () => app.ctx.toast('⚠ Careful', 5000))), [5000]);
  assert.deepEqual(look(app), { classes: ['toast-warn'], shown: true, icon: '⚠', colour: '#f59e0b', msg: 'Careful' });
  // the data-integrity throttle's toast is a warning that is also an error flag: still the error look
  app.ctx.toast('⚠ Not saved', 6000, true);
  assert.deepEqual(look(app), { classes: ['toast-error'], shown: true, icon: '✕', colour: 'var(--red)', msg: '⚠ Not saved' });
  // a message that merely mentions info is a plain message
  app.ctx.toast('Info saved');
  assert.deepEqual(look(app), { classes: [], shown: true, icon: '✓', colour: 'var(--accent)', msg: 'Info saved' });
});

test('toast: an ordinary toast after a neutral one leaves nothing of it behind, and a dismissal clears the class', async () => {
  const app = await loadApp({ realToast: true });
  app.ctx.toastInfo('Waiting 3 seconds', 3000);
  app.ctx.toast('Saved');
  assert.deepEqual(look(app), { classes: [], shown: true, icon: '✓', colour: 'var(--accent)', msg: 'Saved' });
  app.ctx.toastInfo('Waiting');
  app.ctx.toastError('Broke');
  assert.deepEqual(look(app), { classes: ['toast-error'], shown: true, icon: '✕', colour: 'var(--red)', msg: 'Broke' }, 'an error after a neutral note is only an error');
  app.ctx.toastInfo('Waiting');
  app.ctx.toast('⚠ Careful');
  assert.deepEqual(look(app), { classes: ['toast-warn'], shown: true, icon: '⚠', colour: '#f59e0b', msg: 'Careful' }, 'and so is a warning');
  // a click on the toast: it fades for 300ms and the class goes with the fade
  const info = added(app, () => app.ctx.toastInfo('Waiting'));
  app.ctx.toastDismiss();
  assert.equal(look(app).shown, false);
  assert.deepEqual(look(app).classes, ['toast-info'], 'still drawn while it fades');
  const fade = app.timers.list().filter((t) => t.delay === 300).pop();
  assert.ok(fade, 'the clean-up is scheduled');
  app.timers.invoke(fade.id);
  assert.deepEqual(look(app).classes, [], 'gone after it');
  // the timed dismissal does the same: it hides the toast, then clears the class
  const timed = added(app, () => app.ctx.toastInfo('Waiting', 3000)).find((t) => t.delay === 3000);
  assert.ok(timed && info);
  app.timers.invoke(timed.id);
  assert.equal(look(app).shown, false);
  const fade2 = app.timers.list().filter((t) => t.delay === 300).pop();
  app.timers.invoke(fade2.id);
  assert.deepEqual(look(app).classes, []);
});

// ── the neutral variant ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('toast: toastInfo draws the neutral variant, the info icon in blue with a blue edge, and keeps the dismiss time it is given', async () => {
  const app = await loadApp({ realToast: true });
  assert.deepEqual(delays(added(app, () => app.ctx.toastInfo('Waiting 3 seconds', 3500))), [3500], 'no longer than asked: it is no error');
  assert.deepEqual(look(app), { classes: ['toast-info'], shown: true, icon: 'ℹ', colour: 'var(--blue)', msg: 'Waiting 3 seconds' });
  assert.deepEqual(delays(added(app, () => app.ctx.toastInfo('Waiting'))), [2800], 'the usual time when none is asked');
  assert.notEqual(look(app).icon, '✓', 'it is not the tick, which reads as done');
  assert.equal(look(app).msg, 'Waiting', 'and the words are the message');
  // it travels in the third place of toast(), which is where the intro's deferral queue (features.js) carries it too
  const seen = [];
  const real = app.ctx.toast;
  app.ctx.toast = (...a) => { seen.push(a); return real(...a); };
  app.ctx.toastInfo('Hello', 3000);
  assert.deepEqual(seen, [['Hello', 3000, 'info']]);
  // a leading warning glyph does not turn it into a warning: the neutral look was asked for
  app.ctx.toast = real;
  app.ctx.toastInfo('⚠ Hello');
  assert.deepEqual(look(app).classes, ['toast-info']);
});

test('toast: the pacing toast is the neutral one, a hand action held back for the vendor\'s pace says so with the info icon and not the tick', async () => {
  const app = await loadApp({ pace: true, realToast: true }); // the real gate and the page's own toast
  const clock = setClock(app, '2026-10-25T04:00:00Z');
  const seen = [];
  const real = app.ctx.toast;
  app.ctx.toast = (...a) => { seen.push(a); return real(...a); }; // the real toast, watched
  app.ctx._kjrLookupsOpen = 1;              // a hand lookup is in flight, which is what makes the gate say why it waits
  app.ctx._kjrPptLastAt = clock.now - 4500; // a request went out 4.5 seconds ago: 1.5 seconds of the Free plan's 6 are left
  let gate;
  const timers = added(app, () => { gate = app.ctx._kjrPptPace(); });
  const words = 'Waiting 2 seconds to keep within the Free plan\'s pace';
  assert.deepEqual(look(app), { classes: ['toast-info'], shown: true, icon: 'ℹ', colour: 'var(--blue)', msg: words });
  assert.deepEqual(seen, [[words, 2800, 'info']], 'one toast, through toastInfo');
  assert.deepEqual(delays(timers), [1500, 2800], 'the gate sleeps the 1.5 seconds and the toast stays its 2.8 second floor, not an error\'s six');
  // the gate then finishes
  clock.add(1500);
  app.timers.invoke(timers.find((t) => t.delay === 1500).id);
  await gate;
  assert.equal(seen.length, 1, 'and said it once');
  app.ctx._kjrLookupsOpen = 0;
  // with no hand action in flight (a pass) the gate waits in silence, as it always did
  app.ctx._kjrPptLastAt = clock.now - 4500;
  seen.length = 0;
  const quiet = added(app, () => { gate = app.ctx._kjrPptPace(); });
  assert.deepEqual(seen, []);
  clock.add(1500);
  app.timers.invoke(quiet.find((t) => t.delay === 1500).id);
  await gate;
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('toast: toastInfo has one caller, the pacing gate, every place that clears a toast variant clears all three, and the CSS draws it from existing tokens in both themes', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const callers = [];
  for (let i = code.indexOf('toastInfo('); i >= 0; i = code.indexOf('toastInfo(', i + 1)) {
    if (/function\s+$/.test(code.slice(Math.max(0, i - 12), i))) continue; // the declaration
    const from = Math.max(code.lastIndexOf('\nasync function ', i), code.lastIndexOf('\nfunction ', i));
    callers.push(code.slice(from).match(/^\n(?:async )?function (\w+)/)[1]);
  }
  assert.deepEqual(callers, ['_kjrPptPace']);
  for (const file of ['features.js', 'dealer-money.js', 'dealer-desk.js', 'dealer-ui.js', 'dealer-store.js', 'dealer-production-ui.js']) {
    assert.doesNotMatch(fs.readFileSync(ROOT + '/' + file, 'utf8'), /toastInfo\(/, file + ' never uses it');
  }
  const pace = code.slice(code.indexOf('async function _kjrPptPace('), code.indexOf('function _kjrPptStamp('));
  assert.doesNotMatch(pace, /[^\w]toast\(/, 'the gate no longer draws its note with the tick');
  assert.equal((src.match(/'toast-error','toast-warn','toast-info'/g) || []).length, 4, 'the four places that clear the variant classes');
  assert.doesNotMatch(src, /'toast-error','toast-warn'(?!,'toast-info')/, 'and none of them forgets the third');
  // the reply of the intro's deferral queue spaces the toasts it replays by their own dismiss time, and the neutral one is no error
  assert.match(fs.readFileSync(ROOT + '/features.js', 'utf8'), /delay \+= \(args\[2\] && args\[2\] !== 'info'\) \? 6000 : \(typeof args\[1\] === 'number' \? args\[1\] : 2800\);/);
  const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');
  assert.match(css, /#toast\.toast-warn #toast-bar\{background:var\(--amber\)\}\s*#toast\.toast-info\{border-left-color:var\(--blue\)\}\s*#toast\.toast-info #toast-bar\{background:var\(--blue\)\}/, 'after the warning, same shape');
  assert.ok((css.match(/--blue:#[0-9A-Fa-f]{6};/g) || []).length >= 2, 'and the token exists in the dark theme and the light one');
  assert.doesNotMatch(css.slice(css.indexOf('#toast.toast-info{'), css.indexOf('#toast.toast-info #toast-bar{') + 80), /#[0-9A-Fa-f]{3,6}\b|rgb/, 'with no colour of its own');
});

test('toast: the neutral wording the pacing gate uses is plain British English with no dash bar and no semicolon', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  const at = src.indexOf("toastInfo('Waiting '");
  assert.ok(at > 0);
  const line = src.slice(at, src.indexOf('\n', at));
  assert.doesNotMatch(line.slice(0, line.indexOf(', Math.min')), new RegExp('[' + String.fromCharCode(0x2014, 0x2015) + ';]'));
});
