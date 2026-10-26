'use strict';
// v3.96, the toast's class-reset timer is tracked. A dismissal (a tap on the toast, toastDismiss, or the toast's own time running out) hides the toast and 300 ms later,
// once the fade is over, takes its look away (toast-error, toast-warn, toast-info). That second timer was untracked, so a toast shown inside those 300 ms had its class
// removed under it: a toastInfo turned into the success look (the accent edge and bar) while its icon stayed the blue ℹ. Now toast() cancels the pending reset before it
// draws, and both dismissals set the one tracked timer (toastClassTimer), so:
//   - a toast shown within 300 ms of a tap, or of a timed dismissal, keeps its class for its whole life
//   - its own dismissal still clears the class after the fade, as before, and two dismissals leave one reset, not two
//   - a dismissal with no toast after it clears the class exactly as it did
// The real toast() runs against the harness's stub elements (loadApp({ realToast: true })), as tests/toast-info.test.js does. Nothing here reaches a real API.
process.env.TZ = 'Asia/Singapore';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, ROOT } = require('./harness.js');

const VARIANTS = ['toast-error', 'toast-warn', 'toast-info'];
// what the toast looks like right now, read off the elements toast() draws on
const look = (app) => {
  const t = app.document.getElementById('toast');
  const icon = app.document.getElementById('toast-icon');
  return { classes: VARIANTS.filter((c) => t.classList.contains(c)), shown: t.classList.contains('show'), icon: icon.textContent, colour: icon.style.color, msg: app.document.getElementById('toast-msg').textContent };
};
// the timers a call added
const added = (app, call) => {
  const before = new Set(app.timers.list().map((t) => t.id));
  call();
  return app.timers.list().filter((t) => !before.has(t.id)).sort((a, b) => a.delay - b.delay);
};
// the class resets pending right now: the 300 ms timers
const resets = (app) => app.timers.list().filter((t) => t.delay === 300);
// fire every pending class reset, and nothing else of the app's (its 5 and 8 second timers stay where they are)
const fireResets = (app) => app.timers.flush((t) => t.delay === 300);

// ── a toast inside the fade of the last one ─────────────────────────────────────────────────────────────────────────────────────────────

test('toast timer: a note shown within 300 ms of a tap on the last toast keeps its blue look, the stale reset is cancelled', async () => {
  const app = await loadApp({ realToast: true });
  app.ctx.toastInfo('Waiting 3 seconds', 3000);
  app.ctx.toastDismiss();
  assert.equal(resets(app).length, 1, 'the tap scheduled the reset');
  app.ctx.toastInfo('Fetching market price...', 3000);
  assert.deepEqual(look(app), { classes: ['toast-info'], shown: true, icon: 'ℹ', colour: 'var(--blue)', msg: 'Fetching market price...' });
  assert.equal(resets(app).length, 0, 'the earlier reset is gone, nothing is left to take the class away under the new toast');
  fireResets(app);
  assert.deepEqual(look(app), { classes: ['toast-info'], shown: true, icon: 'ℹ', colour: 'var(--blue)', msg: 'Fetching market price...' }, 'still the note, with its class and its icon agreeing');
});

test('toast timer: the same within 300 ms of a timed dismissal, for each of the three looks', async () => {
  const app = await loadApp({ realToast: true });
  const cases = [
    ['toast-error', () => app.ctx.toastError('Broke')],
    ['toast-warn', () => app.ctx.toast('⚠ Careful')],
    ['toast-info', () => app.ctx.toastInfo('Waiting')],
  ];
  for (const [cls, show] of cases) {
    const timed = added(app, () => app.ctx.toast('Saved', 1000)).find((t) => t.delay === 1000);
    assert.ok(timed, cls + ': the plain toast carries its dismiss time');
    app.timers.invoke(timed.id); // its time runs out
    assert.equal(look(app).shown, false, cls + ': hidden');
    assert.equal(resets(app).length, 1, cls + ': the timed dismissal scheduled the reset');
    show();
    assert.deepEqual(look(app).classes, [cls], cls + ': drawn');
    assert.equal(resets(app).length, 0, cls + ': the reset was cancelled by the new toast');
    fireResets(app);
    assert.deepEqual(look(app).classes, [cls], cls + ': kept');
    // the new toast's own tap still clears it after the fade
    app.ctx.toastDismiss();
    assert.deepEqual(look(app).classes, [cls], cls + ': still drawn while it fades');
    assert.equal(resets(app).length, 1, cls + ': one reset, its own');
    fireResets(app);
    assert.deepEqual(look(app).classes, [], cls + ': gone after the fade');
  }
});

// ── what did not change ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('toast timer: a toast dismissed with nothing after it loses its look after the fade, by a tap and by its own time, and two dismissals leave one reset', async () => {
  const app = await loadApp({ realToast: true });
  // a tap
  app.ctx.toastInfo('Waiting');
  app.ctx.toastDismiss();
  assert.deepEqual(look(app).classes, ['toast-info'], 'still drawn while it fades');
  assert.equal(look(app).shown, false);
  assert.equal(resets(app).length, 1);
  fireResets(app);
  assert.deepEqual(look(app).classes, []);
  // its own time
  const timed = added(app, () => app.ctx.toastError('Broke')).find((t) => t.delay === 6000);
  assert.ok(timed);
  app.timers.invoke(timed.id);
  assert.equal(look(app).shown, false);
  assert.deepEqual(look(app).classes, ['toast-error']);
  assert.equal(resets(app).length, 1);
  fireResets(app);
  assert.deepEqual(look(app).classes, []);
  // a second tap on a toast already fading schedules no second reset
  app.ctx.toast('⚠ Careful');
  app.ctx.toastDismiss();
  app.ctx.toastDismiss();
  assert.equal(resets(app).length, 1, 'one tracked timer, however often the toast is tapped');
  fireResets(app);
  assert.deepEqual(look(app).classes, []);
  // toast() itself adds its dismiss timer and nothing else, as before
  assert.deepEqual(added(app, () => app.ctx.toast('Saved')).map((t) => t.delay), [2800]);
  assert.deepEqual(added(app, () => app.ctx.toastInfo('Waiting', 3500)).map((t) => t.delay), [3500]);
});

// ── the code that does it ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

test('toast timer: one tracked timer, set by both dismissals, cancelled before each set and before toast() draws, and no untracked reset is left', () => {
  const src = fs.readFileSync(ROOT + '/app.js', 'utf8');
  assert.match(src, /^let toastClassTimer;$/m, 'declared once, beside toastTimer');
  const code = src.slice(src.indexOf('function toastDismiss()'), src.indexOf('function toastError('));
  assert.ok(code.length > 0);
  assert.equal((code.match(/toastClassTimer = setTimeout\(\(\) => t\.classList\.remove\('toast-error','toast-warn','toast-info'\), 300\);/g) || []).length, 2, 'the tap and the timed dismissal set it');
  assert.equal((code.match(/clearTimeout\(toastClassTimer\);/g) || []).length, 3, 'cleared before each set, and before toast() draws');
  assert.doesNotMatch(code, /\n\s*setTimeout\(\(\) => t\.classList\.remove\(/, 'no reset is scheduled without being kept');
  const draw = code.slice(code.indexOf('function toast('));
  assert.ok(draw.indexOf('clearTimeout(toastClassTimer);') < draw.indexOf("t.classList.remove('toast-error','toast-warn','toast-info');"), 'the cancel comes before the class is set');
});
