'use strict';
// A clock a test can move, for the pricing days (v3.85). The app reads the real clock through `new Date()` and `Date.now()`, so the
// sandbox's Date is replaced by a subclass that answers the faked instant (the same technique tests/modal-controller.test.js uses). The
// time zone is a property of the Node process, not of the sandbox: the test file sets process.env.TZ itself, before it first reads a date.
//
//   const clock = setClock(app, '2026-10-21T15:30:00Z');   // 23:30 in Singapore on 21/10/2026
//   clock.set('2026-10-21T23:30:00Z');                      // 07:30 in Singapore on 22/10/2026
//   clock.add(60 * 1000);
//
// Only code that runs after setClock sees the new clock. Objects the app built before it keep their own timestamps.
function setClock(app, iso) {
  const RealDate = app.__realDate || (app.__realDate = app.ctx.Date);
  const state = { now: new RealDate(iso).getTime() };
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(state.now); else super(...args); }
    static now() { return state.now; }
  }
  app.sandbox.Date = FakeDate;
  return {
    set(next) { state.now = new RealDate(next).getTime(); },
    add(ms) { state.now += ms; },
    get now() { return state.now; },
  };
}

// 'YYYY-MM-DD' of an instant in the process's local zone (the free lane's day) and in UTC (the PPT lane's day and the price history's)
function localDayOf(instant) {
  const d = new Date(instant);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function utcDayOf(instant) { return new Date(instant).toISOString().slice(0, 10); }

module.exports = { setClock, localDayOf, utcDayOf };
