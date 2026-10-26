'use strict';
// The build every suite expects, written once. A ship edits VERSION, BADGE_DATE and CACHE below in the same edit as the badge, the eight ?v= tags, the Sentry release and
// sw.js (CLAUDE.md, ship rule), and nowhere else in tests/. Four suites pin a build detail and read it from here: navigation.test.js (the page: badge, Sentry release,
// the eight tags), sw-update.test.js (the worker: CACHE and the precached URLs), dealer-ui.test.js (the Sentry release) and dealer-production-preview.test.js (the
// fixture serves the current tag). A bump that forgets this file fails them all, and a bump that forgets the page or the worker fails the suite that reads that file.
// qc.sh and misc-consistency.test.js read the badge off the page instead and check the tags and the release against it, they need no edit.
const VERSION = '3.97';
const BADGE_DATE = '26 Oct';
const CACHE = 'kujira-v100';

// the eight assets index.html loads with a ?v= tag, in the order it lists them, and the order sw.js precaches them in. The vendored three.js keeps its own version
const ASSETS = Object.freeze(['styles.css', 'app.js', 'features.js', 'dealer-money.js', 'dealer-desk.js', 'dealer-ui.js', 'dealer-store.js', 'dealer-production-ui.js']);

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = Object.freeze({
  VERSION,
  BADGE_DATE,
  CACHE,
  ASSETS,
  BADGE: 'v' + VERSION + ' (' + BADGE_DATE + ')', // what #app-ver shows
  RELEASE: 'kujira-collectibles@' + VERSION,       // the Sentry release string
  tag: (asset) => asset + '?v=' + VERSION,         // an asset's cache-busting URL
  escapeRegExp,
});
