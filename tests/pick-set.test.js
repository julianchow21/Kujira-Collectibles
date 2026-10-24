'use strict';
// v3.86: pick the set. The Unmatched cards sheet shows, for an English card that has a card number and no unique TCGdex match, every
// card TCGdex lists for that name and number, and one tap on the right one saves it. fetch is stubbed (tests/harness.js), nothing here
// reaches TCGdex, and the preview fixture's CSP blocks it anyway, so the browser side of this is the coordinator's to look at.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadApp, plain, jsonResponse, syncRequest, syncSuccessResponse, syncOperations, ROOT } = require('./harness.js');

const css = fs.readFileSync(ROOT + '/styles.css', 'utf8');

const single = (id, name, extra) => Object.assign({
  id, name, set: '', language: 'EN', type: 'raw', condition: 'Near Mint', qty: 1, costPrice: 10, marketPrice: '',
  listPrice: '', datePurchased: '1 Sep 2026', status: 'Available', notes: '', priceAlert: '', tcgdexId: '', priceHistory: [],
}, extra || {});
// a number TCGdex looked up and could not narrow to one card: the card is on the unmatched list
const MISS = { _tcgdexMissDate: '2026-10-01' };
const rowOf = (ctx, id) => ctx.DB.singles.find((r) => r.id === id);
const clickOf = (attrs) => {
  const holder = { getAttribute: (name) => (name in attrs ? attrs[name] : null) };
  return { type: 'click', target: { closest: () => holder } };
};

// What GET /en/cards?name=Pikachu&localId=25 returned live on 24/10/2026 (the id, localId, name and image fields as TCGdex sends them):
// localId is a "contains" filter, so 225 and 259 come back with the 25s and the padded 025s, and some cards carry no image.
const PIKACHU_25 = [
  { id: 'A2a-025', localId: '025', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/tcgp/A2a/025' },
  { id: '2021swsh-25', localId: '25', name: 'Pikachu' },
  { id: '30th-025', localId: '025', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/me/30th/025' },
  { id: 'basep-25', localId: '25', name: 'Flying Pikachu', image: 'https://assets.tcgdex.net/en/base/basep/25' },
  { id: 'A1a-025', localId: '025', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/tcgp/A1a/025' },
  { id: 'sv03.5-025', localId: '025', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/sv/sv03.5/025' },
  { id: 'svp-225', localId: '225', name: 'Pikachu' },
  { id: 'A1-259', localId: '259', name: 'Pikachu ex', image: 'https://assets.tcgdex.net/en/tcgp/A1/259' },
];
const SETS = [
  { id: 'sv03.5', name: '151', cardCount: { total: 207 } },
  { id: 'A2a', name: 'Triumphant Light' },
  { id: 'basep', name: 'Wizards Black Star Promos' },
  { id: '30th', name: 'Celebrations' },
];
const PIKACHU_EXPECTED = [
  { id: '2021swsh-25', localId: '25', name: 'Pikachu', image: '', setId: '2021swsh', setName: '' },
  { id: '30th-025', localId: '025', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/me/30th/025', setId: '30th', setName: 'Celebrations' },
  { id: 'basep-25', localId: '25', name: 'Flying Pikachu', image: 'https://assets.tcgdex.net/en/base/basep/25', setId: 'basep', setName: 'Wizards Black Star Promos' },
  { id: 'sv03.5-025', localId: '025', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/sv/sv03.5/025', setId: 'sv03.5', setName: '151' },
];

async function setup(rows, opts) {
  const app = await loadApp(Object.assign({ seed: { singles: rows } }, opts || {}));
  const toasts = [];
  app.ctx.toast = (m) => toasts.push(String(m));
  app.ctx.toastError = (m) => toasts.push('ERR ' + String(m));
  app.toasts = toasts;
  app.fetchMock.calls.length = 0; // the boot fetches are not part of the test
  app.searches = () => app.fetchMock.calls.filter((c) => c.url.includes('/cards?name='));
  app.setsRequests = () => app.fetchMock.calls.filter((c) => /\/sets$/.test(c.url));
  app.route = (list, sets) => {
    app.fetchMock.route('/en/cards?name=Pikachu&localId=25', () => jsonResponse(list || PIKACHU_25));
    app.fetchMock.route('/en/sets', () => jsonResponse(sets || SETS));
    return app;
  };
  app.body = () => app.document.getElementById('kjr-custom-body').innerHTML;
  return app;
}

// ── the candidates ──────────────────────────────────────────────────────────────────────────────────────────

test('candidates: the same search as the resolver, cut to the typed number, with the set read off the id and named from the set list', async () => {
  const app = await setup([single('p1', 'Pikachu 25', MISS)]);
  app.route();
  const list = await app.ctx.kjrTcgdexCandidates(rowOf(app.ctx, 'p1'));
  assert.deepStrictEqual(plain(list), PIKACHU_EXPECTED, 'TCGdex order kept; 225 and 259 are not number 25; the padded 025 is; the Pocket cards A2a-025 and A1a-025 are not offered');
  assert.deepStrictEqual(app.searches().map((c) => c.url), ['https://api.tcgdex.net/v2/en/cards?name=Pikachu&localId=25']);
  assert.equal(app.setsRequests().length, 1, 'the set list is asked once, for the names');
  // the resolver asks for the very same URL, name and number taken from the row the same way
  app.fetchMock.calls.length = 0;
  await app.ctx.resolveTcgdexId(single('p2', 'Pikachu 25'));
  assert.deepStrictEqual(app.searches().map((c) => c.url), ['https://api.tcgdex.net/v2/en/cards?name=Pikachu&localId=25']);
  assert.equal(rowOf(app.ctx, 'p1').tcgdexId, '', 'and kjrTcgdexCandidates writes nothing to the row');
  assert.equal(rowOf(app.ctx, 'p1')._tcgdexMissDate, '2026-10-01');
});

test('candidates: setName comes from the cached 30 day set list without a request, and an image off the TCGdex host is dropped', async () => {
  const app = await setup([single('p1', 'Pikachu 25', MISS)]);
  app.localStorage.setItem('kjr_tcgdex_sets_v1:en', JSON.stringify({ v: 1, t: Date.now(), list: [{ id: 'sv03.5', name: '151' }] }));
  app.fetchMock.route('/en/cards?name=Pikachu&localId=25', () => jsonResponse([
    { id: 'sv03.5-025', localId: '025', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/sv/sv03.5/025' },
    { id: 'evil-25', localId: '25', name: 'Pikachu', image: 'https://evil.example/x/25' },
    { id: 'sv03.5-025', localId: '025', name: 'Pikachu duplicate' },
    { id: '', localId: '25' }, { localId: '25' }, null, 'junk',
  ]));
  const list = plain(await app.ctx.kjrTcgdexCandidates(rowOf(app.ctx, 'p1')));
  assert.equal(app.setsRequests().length, 0, 'the cached list serves, no request');
  assert.deepStrictEqual(list.map((c) => [c.id, c.setId, c.setName, c.image]), [
    ['sv03.5-025', 'sv03.5', '151', 'https://assets.tcgdex.net/en/sv/sv03.5/025'],
    ['evil-25', 'evil', '', ''],
  ], 'one row per id, junk dropped, a foreign image base is no image');
});

test('candidates: no set list is no reason to fail, and a set id with no dash has no set id', async () => {
  const app = await setup([single('p1', 'Pikachu 25', MISS)]);
  app.fetchMock.route('/en/cards?name=Pikachu&localId=25', () => jsonResponse([{ id: 'sv03.5-025', localId: '025', name: 'Pikachu' }, { id: 'nodash', localId: '25', name: 'Pikachu' }]));
  app.fetchMock.reject('/en/sets', new TypeError('offline'));
  const list = plain(await app.ctx.kjrTcgdexCandidates(rowOf(app.ctx, 'p1')));
  assert.deepStrictEqual(list.map((c) => [c.id, c.setId, c.setName]), [['sv03.5-025', 'sv03.5', ''], ['nodash', '', '']]);
});

test('candidates: a typed number compares as a number, a promo number only exactly, and the list is capped', async () => {
  const app = await setup([single('a', 'Mew 6', MISS), single('b', 'Pikachu TG11', MISS), single('c', 'Eevee 1', MISS)]);
  app.fetchMock.route('/en/sets', () => jsonResponse(SETS));
  app.fetchMock.route('name=Mew&localId=6', () => jsonResponse([{ id: 'x-006', localId: '006', name: 'Mew' }, { id: 'x-6', localId: '6', name: 'Mew' }, { id: 'x-16', localId: '16', name: 'Mew' }]));
  app.fetchMock.route('name=Pikachu&localId=TG11', () => jsonResponse([{ id: 'y-TG11', localId: 'TG11', name: 'Pikachu' }, { id: 'y-TG111', localId: 'TG111', name: 'Pikachu' }, { id: 'y-tg11', localId: 'tg11', name: 'Pikachu' }]));
  app.fetchMock.route('name=Eevee&localId=1', () => jsonResponse(Array.from({ length: 90 }, (_, i) => ({ id: 's' + i + '-001', localId: '001', name: 'Eevee' }))));
  assert.deepStrictEqual(plain(await app.ctx.kjrTcgdexCandidates(rowOf(app.ctx, 'a'))).map((c) => c.id), ['x-006', 'x-6'], '6 is 006, not 16');
  assert.deepStrictEqual(plain(await app.ctx.kjrTcgdexCandidates(rowOf(app.ctx, 'b'))).map((c) => c.id), ['y-TG11', 'y-tg11'], 'TG11 never takes TG111');
  assert.equal((await app.ctx.kjrTcgdexCandidates(rowOf(app.ctx, 'c'))).length, 60, 'at most 60');
});

test('candidates: 0 cards is an empty list, a 404 too, and a row with no name or number asks nothing', async () => {
  const app = await setup([single('p1', 'Pikachu 25', MISS), single('n1', 'Pikachu')]);
  app.fetchMock.route('/en/cards?name=Pikachu&localId=25', [{ status: 200, json: [] }, { status: 404, json: {} }, { status: 200, json: [{ id: 'svp-225', localId: '225', name: 'Pikachu' }] }]);
  const p1 = rowOf(app.ctx, 'p1');
  assert.deepStrictEqual(plain(await app.ctx.kjrTcgdexCandidates(p1)), [], 'an empty list');
  assert.deepStrictEqual(plain(await app.ctx.kjrTcgdexCandidates(p1)), [], 'a 404');
  assert.deepStrictEqual(plain(await app.ctx.kjrTcgdexCandidates(p1)), [], 'only other numbers');
  assert.equal(app.setsRequests().length, 0, 'no card to name, no set list asked');
  app.fetchMock.calls.length = 0;
  assert.deepStrictEqual(plain(await app.ctx.kjrTcgdexCandidates(rowOf(app.ctx, 'n1'))), []);
  assert.deepStrictEqual(plain(await app.ctx.kjrTcgdexCandidates(null)), []);
  assert.equal(app.fetchMock.calls.length, 0, 'no request');
});

test('candidates: a request that got no usable answer REJECTS and writes nothing, so no miss is stamped', async () => {
  const app = await setup([single('p1', 'Pikachu 25', { _tcgdexMissDate: '2026-10-01' }), single('p2', 'Pikachu 25')]);
  const p1 = rowOf(app.ctx, 'p1');
  const before = JSON.stringify(app.ctx.DB.singles);
  for (const [why, spec] of [['offline', null], ['a 500', { status: 500, json: {} }], ['a 403', { status: 403, json: {} }], ['a 429', { status: 429, json: {} }], ['not a list', { status: 200, json: { error: 'gateway' } }]]) {
    app.fetchMock.reset();
    if (spec) app.fetchMock.route('/en/cards?name=Pikachu&localId=25', spec);
    await assert.rejects(() => app.ctx.kjrTcgdexCandidates(p1), undefined, why);
  }
  assert.equal(JSON.stringify(app.ctx.DB.singles), before, 'no row changed, no marker written');
  assert.equal(p1._tcgdexMissDate, '2026-10-01');
  assert.equal(rowOf(app.ctx, 'p2')._tcgdexMissDate, undefined);
});

test('candidates: Pokémon TCG Pocket cards (digital only) are left out, by set id or by image path', async () => {
  const app = await setup([single('q1', 'Pikachu 1', MISS)]);
  const mk = (id, extra) => Object.assign({ id, localId: '001', name: 'Pikachu' }, extra || {});
  const bySetId = ['A1-001', 'A1a-001', 'A2-001', 'A2a-001', 'A3b-001', 'A10-001', 'a1-001', 'P-A-001', 'p-a-001'];
  const physical = ['sv03.5-001', 'base2-001', 'A-001', 'AB1-001', 'A1ab-001', 'P-B-001', 'xy1-001', '2021swsh-001'];
  app.fetchMock.route('/en/sets', () => jsonResponse(SETS));
  app.fetchMock.route('/en/cards?name=Pikachu&localId=1', () => jsonResponse([].concat(
    bySetId.map((id) => mk(id)), // no image at all: the set id says Pocket
    [mk('A3-001', { image: 'https://evil.example/x/001' })], // a foreign image does not save a Pocket set id
    [mk('B1-001', { image: 'https://assets.tcgdex.net/en/tcgp/B1/001' })], // a later series, caught by its image path
    [mk('base1-001', { image: 'https://assets.tcgdex.net/en/TCGP/base1/001' })], // a set id that looks physical, an image that says Pocket (any case)
    physical.map((id) => mk(id, { image: 'https://assets.tcgdex.net/en/x/' + id })),
  )));
  const list = plain(await app.ctx.kjrTcgdexCandidates(rowOf(app.ctx, 'q1')));
  assert.deepStrictEqual(list.map((c) => c.id), physical, 'only the physical sets are left, in TCGdex order');
  assert.deepStrictEqual(list.map((c) => c.setId), ['sv03.5', 'base2', 'A', 'AB1', 'A1ab', 'P-B', 'xy1', '2021swsh']);
});

test('candidates: Pocket cards are dropped before the cap and before the set list, so they cost the picker nothing', async () => {
  const mk = (id) => ({ id, localId: '001', name: 'Pikachu' });
  const app = await setup([single('q1', 'Pikachu 1', MISS)]);
  const crowd = Array.from({ length: 70 }, (_, i) => mk('A' + (i + 1) + '-001')).concat([mk('sv03.5-001')]);
  app.fetchMock.route('/en/sets', () => jsonResponse(SETS));
  app.fetchMock.route('/en/cards?name=Pikachu&localId=1', () => jsonResponse(crowd));
  assert.deepStrictEqual(plain(await app.ctx.kjrTcgdexCandidates(rowOf(app.ctx, 'q1'))).map((c) => c.id), ['sv03.5-001'], '70 Pocket cards ahead of it do not fill the 60 places');
  const only = await setup([single('q1', 'Pikachu 1', MISS)]);
  only.fetchMock.route('/en/sets', () => jsonResponse(SETS));
  only.fetchMock.route('/en/cards?name=Pikachu&localId=1', () => jsonResponse(crowd.slice(0, 70)));
  assert.deepStrictEqual(plain(await only.ctx.kjrTcgdexCandidates(rowOf(only.ctx, 'q1'))), [], 'nothing but Pocket cards is no candidates');
  assert.equal(only.setsRequests().length, 0, 'and no set list is asked for');
  // in the sheet that reads as no card found
  only.ctx.kjrCustomReviewOpen();
  await only.settle();
  assert.match(only.body(), /<div class="kjr-cr-status">No card found for this name and number<\/div>/);
});

// ── resolveTcgdexId, as before ──────────────────────────────────────────────────────────────────────────────────

test('resolver: unchanged. One card is taken, several need a set name in the name, nothing else is guessed, and a failure is "could not tell"', async () => {
  const app = await setup([single('d1', 'Dummy')]);
  const { ctx, fetchMock } = app;
  const row = (name, extra) => Object.assign({ id: 'r', name, language: 'EN' }, extra || {});
  const ask = async (item, list, opts) => { fetchMock.reset(); fetchMock.route('/cards?name=', () => jsonResponse(list)); return ctx.resolveTcgdexId(item, opts); };

  const one = row('Pikachu 25');
  assert.equal(await ask(one, [{ id: 'base1-25', name: 'Pikachu' }]), 'base1-25');
  assert.equal(one.tcgdexId, 'base1-25');
  assert.equal(one._tcgdexResolvedName, 'Pikachu');
  assert.equal(fetchMock.calls[0].url, 'https://api.tcgdex.net/v2/en/cards?name=Pikachu&localId=25');
  assert.equal(fetchMock.calls[0].opts, undefined, 'no timeout asked for, none passed: the call is exactly as it was');

  const jungle = row('Gyarados 21 Jungle');
  assert.equal(await ask(jungle, [{ id: 'base2-21' }, { id: 'neo1-21' }, { id: 'base3-21' }]), 'base2-21', 'several, one in the set the name says');
  const vague = row('Gyarados 21');
  assert.equal(await ask(vague, [{ id: 'base2-21' }, { id: 'neo1-21' }]), null, 'several and no set named: still unresolved');
  assert.equal(vague.tcgdexId, undefined);
  assert.equal(await ask(row('Pikachu 25'), []), null, 'no card');
  assert.equal(await ask(row('Pikachu 25'), [{ name: 'no id' }]), null, 'a card with no id');
  const pocket = row('Pikachu 25');
  assert.equal(await ask(pocket, [{ id: 'A1-025', name: 'Pikachu', image: 'https://assets.tcgdex.net/en/tcgp/A1/025' }]), 'A1-025', 'the resolver still sees a Pocket card, only the picker leaves it out');
  assert.equal(pocket.tcgdexId, 'A1-025');

  const none = {};
  fetchMock.reset(); fetchMock.route('/cards?name=', { status: 404, json: {} });
  assert.equal(await ctx.resolveTcgdexId(row('Pikachu 25'), { priceReport: none }), null);
  assert.deepStrictEqual(plain(none), {}, 'a 404 is an answer, not a failure');
  const five = {};
  fetchMock.reset(); fetchMock.route('/cards?name=', { status: 503, json: {} });
  assert.equal(await ctx.resolveTcgdexId(row('Pikachu 25'), { priceReport: five }), null);
  assert.deepStrictEqual(plain(five), { transient: true, why: 'net', status: 503 });
  const shape = {};
  fetchMock.reset(); fetchMock.route('/cards?name=', { status: 200, json: { oops: 1 } });
  assert.equal(await ctx.resolveTcgdexId(row('Pikachu 25'), { priceReport: shape }), null);
  assert.deepStrictEqual(plain(shape), { transient: true, why: 'net' });
  const art = { transient: false };
  fetchMock.reset(); fetchMock.reject('/cards?name=', new TypeError('offline'));
  assert.equal(await ctx.resolveTcgdexId(row('Pikachu 25'), { art: true, report: art }), null);
  assert.deepStrictEqual(plain(art), { transient: true, why: 'net' });
  const timed = {};
  fetchMock.reset(); fetchMock.route('/cards?name=', async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; });
  assert.equal(await ctx.resolveTcgdexId(row('Pikachu 25'), { priceReport: timed }), null);
  assert.deepStrictEqual(plain(timed), { transient: true, why: 'net', timedOut: true });
  assert.equal(await ctx.resolveTcgdexId(row('Pikachu')), null, 'no number, nothing asked');
  assert.equal(await ctx.resolveTcgdexId(row('Pikachu 25', { tcgdexId: 'base1-58' })), 'base1-58', 'a known id is returned as it is');
});

// ── the sheet ───────────────────────────────────────────────────────────────────────────────────────────────

test('sheet: a numbered English card shows "Finding matches", then every candidate with its picture, set and number, and "Which one is yours?"', async () => {
  const app = (await setup([single('p1', 'Pikachu 25', MISS)])).route();
  app.ctx.kjrCustomReviewOpen();
  assert.match(app.body(), /<li class="kjr-cr-row has-pick">/);
  assert.match(app.body(), /<div class="kjr-cr-pick" data-cr-pick="p1"><div class="kjr-cr-status">Finding matches…<\/div><\/div>/, 'asked, not answered yet');
  assert.doesNotMatch(app.body(), /Which one is yours/);
  await app.settle();
  const html = app.body();
  assert.match(html, /<div class="kjr-cr-q">Which one is yours\?<\/div><div class="kjr-cr-cands" role="group" aria-label="Cards matching Pikachu 25">/);
  assert.equal((html.match(/<button type="button" class="kjr-cr-cand"/g) || []).length, 4);
  assert.match(html, /<button type="button" class="kjr-cr-cand" data-cr-act="pick" data-cr-id="p1" data-cr-card="sv03.5-025" aria-label="Pick 151 025" title="Pikachu"><span class="kjr-cr-thumb"><img src="https:\/\/assets\.tcgdex\.net\/en\/sv\/sv03\.5\/025\/low\.webp" alt="" width="63" height="88" loading="lazy" decoding="async" referrerpolicy="no-referrer"><\/span><span class="kjr-cr-cset">151<\/span><span class="kjr-cr-cnum">025<\/span><\/button>/);
  assert.match(html, /aria-label="Pick 2021swsh 25"[^>]*><span class="kjr-cr-thumb is-none" aria-hidden="true">No image<\/span><span class="kjr-cr-cset">2021swsh<\/span>/, 'no set name: the set id, no picture: a box of the same size');
  assert.doesNotMatch(html, /data-cr-card="A2a-025"|data-cr-card="A1a-025"|data-cr-card="A1-259"/, 'Pokémon TCG Pocket cards are not offered');
  assert.match(html, /data-cr-act="open" data-cr-id="p1"[^>]*>Open<\/button><button type="button" class="btn btn-sm" data-cr-act="mark" data-cr-id="p1"[^>]*>Custom card<\/button>/, 'Open and Custom card stay on the row');
  assert.ok(html.indexOf('kjr-cr-cands') < html.indexOf('data-cr-act="open"'), 'below the candidates');
  assert.equal(app.searches().length, 1);
});

test('sheet: 0 candidates says so, and the row keeps Open and Custom card', async () => {
  const app = await setup([single('p1', 'Pikachu 25', MISS)]);
  app.route([]);
  app.ctx.kjrCustomReviewOpen();
  await app.settle();
  assert.match(app.body(), /<div class="kjr-cr-status">No card found for this name and number<\/div>/);
  assert.doesNotMatch(app.body(), /kjr-cr-cand"|Which one is yours/);
  assert.match(app.body(), /data-cr-act="open" data-cr-id="p1"/);
});

test('sheet: a failed search says so with a Retry, stamps no miss, and Retry asks again', async () => {
  const app = await setup([single('p1', 'Pikachu 25', MISS)]);
  app.fetchMock.route('/en/cards?name=Pikachu&localId=25', { status: 500, json: {} });
  app.ctx.kjrCustomReviewOpen();
  await app.settle();
  assert.match(app.body(), /<div class="kjr-cr-status">Could not reach TCGdex, try again later<\/div><button type="button" class="btn btn-sm kjr-cr-retry" data-cr-act="retry" data-cr-id="p1" aria-label="Retry finding matches for Pikachu 25">Retry<\/button>/);
  assert.equal(rowOf(app.ctx, 'p1')._tcgdexMissDate, '2026-10-01', 'the old miss is untouched, no new one');
  assert.equal(app.searches().length, 1);
  // it stays failed on a redraw and on a reopen: only Retry asks again
  app.ctx.renderSingles();
  app.ctx.kjrCustomReviewClose();
  app.ctx.kjrCustomReviewOpen();
  await app.settle();
  assert.equal(app.searches().length, 1, 'no automatic second request');
  assert.match(app.body(), /Could not reach TCGdex/);
  // the network is back
  app.route();
  app.document.getElementById('kjr-custom-overlay').dispatchEvent(clickOf({ 'data-cr-act': 'retry', 'data-cr-id': 'p1' }));
  assert.match(app.body(), /Finding matches…/, 'asking again shows it at once');
  await app.settle();
  assert.equal(app.searches().length, 2);
  assert.equal((app.body().match(/class="kjr-cr-cand"/g) || []).length, 4);
  assert.doesNotMatch(app.body(), /Could not reach TCGdex/);
});

test('sheet: at most 3 searches run at once, in list order, each finished one starts the next', async () => {
  const names = ['Alpha 1', 'Bravo 2', 'Charlie 3', 'Delta 4', 'Echo 5', 'Foxtrot 6', 'Golf 7'];
  const app = await setup(names.map((n, i) => single('r' + (i + 1), n, MISS)));
  const pending = [];
  let inflight = 0, most = 0;
  app.fetchMock.route('/cards?name=', (url) => new Promise((resolve) => {
    inflight++; most = Math.max(most, inflight);
    const num = new URL(url).searchParams.get('localId');
    pending.push(() => { inflight--; resolve(jsonResponse([{ id: 'set-00' + num, localId: '00' + num, name: 'Card' }])); });
  }));
  app.fetchMock.route('/en/sets', () => jsonResponse(SETS));
  app.ctx.kjrCustomReviewOpen();
  assert.deepStrictEqual(app.searches().map((c) => new URL(c.url).searchParams.get('name')), ['Alpha', 'Bravo', 'Charlie'], 'three at once, the top rows first');
  for (let done = 1; done <= 4; done++) {
    pending.shift()();
    await app.settle();
    assert.equal(app.searches().length, Math.min(3 + done, 7), 'one finished, one more started');
    assert.ok(inflight <= 3);
  }
  while (pending.length) { pending.shift()(); await app.settle(); }
  assert.equal(app.searches().length, 7);
  assert.equal(most, 3, 'never more than 3 in flight');
  assert.equal((app.body().match(/Which one is yours/g) || []).length, 7, 'every row answered');
  // answered rows are kept for the session: closing and reopening asks for nothing
  app.ctx.kjrCustomReviewClose();
  app.ctx.kjrCustomReviewOpen();
  await app.settle();
  assert.equal(app.searches().length, 7);
});

test('sheet: closing drops the searches not started, the ones running keep their answer, and a reopen asks for the rest only', async () => {
  const app = await setup(['Alpha 1', 'Bravo 2', 'Charlie 3', 'Delta 4', 'Echo 5'].map((n, i) => single('r' + (i + 1), n, MISS)));
  const pending = [];
  app.fetchMock.route('/cards?name=', () => new Promise((resolve) => pending.push(() => resolve(jsonResponse([{ id: 'set-001', localId: '001', name: 'Card' }])))));
  app.fetchMock.route('/en/sets', () => jsonResponse(SETS));
  app.ctx.kjrCustomReviewOpen();
  assert.equal(app.searches().length, 3);
  app.ctx.kjrCustomReviewClose();
  while (pending.length) { pending.shift()(); await app.settle(); }
  assert.equal(app.searches().length, 3, 'nothing started after the close');
  app.ctx.kjrCustomReviewOpen();
  assert.deepStrictEqual(app.searches().slice(3).map((c) => new URL(c.url).searchParams.get('name')), ['Delta', 'Echo'], 'only the rows with no answer');
});

test('sheet: a row edited to another name or number is asked again, and a row that gets matched elsewhere is not', async () => {
  const app = await setup([single('p1', 'Pikachu 25', MISS)]);
  app.route();
  app.fetchMock.route('/en/cards?name=Pikachu&localId=26', () => jsonResponse([{ id: 'sv-026', localId: '026', name: 'Pikachu' }]));
  app.ctx.kjrCustomReviewOpen();
  await app.settle();
  assert.equal(app.searches().length, 1);
  rowOf(app.ctx, 'p1').name = 'Pikachu 26';
  app.ctx.renderSingles();
  await app.settle();
  assert.equal(app.searches().length, 2, 'the new number is a new question');
  assert.match(app.body(), /data-cr-card="sv-026"/);
  assert.doesNotMatch(app.body(), /data-cr-card="sv03.5-025"/);
  rowOf(app.ctx, 'p1').tcgdexId = 'sv-026'; // matched through the edit form
  app.ctx.renderSingles();
  assert.doesNotMatch(app.body(), /Pikachu 26/, 'it leaves the list');
});

test('sheet: a numberless card, a Japanese card and a custom card are drawn exactly as before, with no search', async () => {
  const rows = [single('n1', 'Umbreon Custom Card'), single('j1', 'Pikachu 25', Object.assign({ language: 'JP' }, MISS)), single('k1', 'Mew 8', Object.assign({ language: 'KR' }, MISS))];
  const app = await setup(rows, { jaLane: true });
  app.route();
  const cards = Array.from(app.ctx._kjrCustomUnmatchedSorted());
  assert.equal(cards.length, 2, 'the numberless one and the Japanese one the lane missed; Korean is manual by design');
  for (const c of cards) assert.equal(app.ctx.kjrCustomPickable(c), false, c.id);
  assert.equal(app.ctx.kjrCustomReviewHtml(cards, [], app.ctx._kjrCustomPicks), app.ctx.kjrCustomReviewHtml(cards, []), 'the same markup with and without the picker lookup');
  app.ctx.kjrCustomReviewOpen();
  await app.settle();
  assert.equal(app.searches().length, 0, 'no request');
  assert.doesNotMatch(app.body(), /has-pick|kjr-cr-pick|Finding matches|kjr-cr-cand/);
  assert.equal((app.body().match(/<li class="kjr-cr-row">/g) || []).length, 2);
  assert.equal((app.body().match(/data-cr-act="open"/g) || []).length, 2);
  // a blank language is English, a lowercase en too; a card with an id, or flagged custom, is not a pick row
  for (const [extra, want] of [[{ language: '' }, true], [{ language: ' en ' }, true], [{ language: 'EN', tcgdexId: 'base1-25' }, false], [{ customCard: true }, false], [{ language: 'CN' }, false]]) {
    assert.equal(app.ctx.kjrCustomPickable(single('x', 'Pikachu 25', extra)), want, JSON.stringify(extra));
  }
});

test('sheet: the picker markup escapes everything from TCGdex and the row, and the strip is a labelled group of real buttons', async () => {
  const { ctx } = await loadApp();
  const row = single('x"><b>', '<img src=x onerror=1> 25', MISS);
  const view = { state: 'ready', busy: '', list: [{ id: 'a"><i>-25', localId: '<25>', name: '"><script>', image: 'https://assets.tcgdex.net/en/a/25', setId: 'a"><i>', setName: '<set>' }] };
  const out = ctx.kjrCustomPickInner(row, view);
  assert.doesNotMatch(out, /<img src=x|<script>|<i>|<b>|<set>/);
  assert.match(out, /aria-label="Cards matching &lt;img src=x onerror=1&gt; 25"/);
  assert.match(out, /aria-label="Pick &lt;set&gt; &lt;25&gt;"/);
  assert.match(out, /data-cr-id="x&quot;&gt;&lt;b&gt;"/);
  assert.match(out, /data-cr-card="a&quot;&gt;&lt;i&gt;-25"/);
  assert.equal((out.match(/<button /g) || []).length, 1);
  assert.match(ctx.kjrCustomPickInner(row, { state: 'loading', list: [], busy: '' }), /Finding matches…/);
  assert.match(ctx.kjrCustomPickInner(row, { state: 'ready', list: [], busy: 'Set 025' }), /^<div class="kjr-cr-status">Matching to Set 025…<\/div>$/);
});

test('sheet: an answer is drawn into its own row, not the whole sheet, and the next redraw leaves the strips alone', async () => {
  const app = await setup([single('p1', 'Pikachu 25', MISS), single('p2', 'Zed 9', MISS)]);
  app.route();
  app.fetchMock.route('/en/cards?name=Zed&localId=9', () => jsonResponse([{ id: 'zz-009', localId: '009', name: 'Zed' }]));
  const body = app.document.getElementById('kjr-custom-body');
  const slots = { p1: { html: '' }, p2: { html: '' } };
  const slot = (id) => ({ getAttribute: (n) => (n === 'data-cr-pick' ? id : null), get innerHTML() { return slots[id].html; }, set innerHTML(v) { slots[id].html = String(v); } });
  body.querySelectorAll = (sel) => (sel === '[data-cr-pick]' ? [slot('p1'), slot('p2')] : []);
  let writes = 0, markup = '';
  Object.defineProperty(body, 'innerHTML', { configurable: true, get: () => markup, set: (v) => { markup = String(v); writes++; } });
  app.ctx.kjrCustomReviewOpen();
  assert.equal(writes, 1, 'the sheet is drawn once');
  await app.settle();
  assert.equal(writes, 1, 'two answers arrived and the body was not rewritten');
  assert.match(slots.p1.html, /Which one is yours\?/);
  assert.match(slots.p1.html, /data-cr-card="sv03.5-025"/);
  assert.match(slots.p2.html, /data-cr-card="zz-009"/);
  app.ctx.renderSingles();
  assert.equal(writes, 1, 'a Singles redraw finds the body already as it should be');
});

// ── the pick ────────────────────────────────────────────────────────────────────────────────────────────────

// A pick with every step that matters logged in order. refreshPrice and _flushDirtyToSupabase take a few ticks, so "awaited" means something.
// saveAllToSupabase is stubbed too and logs SAVE-ALL, which no pick may ever produce. opts.flush decides what the upload answers.
async function pickRig(rows, opts) {
  const app = (await setup(rows)).route();
  const order = [];
  const { ctx } = app;
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
  const realMark = ctx.markDirty;
  const realSnapshot = ctx.snapshotForUndo;
  ctx.snapshotForUndo = () => { order.push('snapshotForUndo'); return realSnapshot(); };
  ctx.markDirty = (table, id, snap) => { order.push('markDirty:' + table + ':' + id + ':' + (rowOf(ctx, id).tcgdexId || '-')); return realMark(table, id, snap); };
  ctx.refreshPrice = async (id, table) => {
    order.push('refresh:start:' + id + ':' + table);
    await tick();
    if (opts && opts.refresh) await opts.refresh(rowOf(ctx, id));
    order.push('refresh:end:' + id);
  };
  ctx._flushDirtyToSupabase = async () => {
    order.push('flush:start');
    await tick();
    order.push('flush:end');
    return opts && opts.flush ? opts.flush() : { status: 'confirmed', confirmed: true };
  };
  ctx.saveAllToSupabase = async () => { order.push('SAVE-ALL'); };
  const realToast = ctx.toast;
  app.toastLog = [];
  ctx.toast = (m, dur, isErr) => { order.push('toast:' + m); app.toastLog.push({ m: String(m), dur, isErr: !!isErr }); realToast(m); };
  app.order = order;
  app.priced = (row) => { row._tcgdexPricedDate = ctx.kjrLocalDay(); };
  ctx.kjrCustomReviewOpen();
  await app.settle();
  return app;
}

test('pick: undo snapshot, id on the row, markers cleared, row dirty, then the price, then the upload, awaited in that order, then the toast', async () => {
  const app = await pickRig([single('p1', 'Pikachu 25', Object.assign({ _tcgdexPricedDate: '2026-10-02' }, MISS))], { refresh: (row) => app.priced(row) });
  const { ctx, order } = app;
  ctx.showPage('dashboard'); // the sheet is open over the Overview, as when it is reached from Fix matches
  assert.match(app.document.getElementById('dash-hero').innerHTML, /1 card could not be matched/);
  assert.equal(await ctx.kjrCustomPick('p1', 'sv03.5-025'), true);
  assert.deepStrictEqual(plain(order), [
    'snapshotForUndo', 'markDirty:singles:p1:sv03.5-025', 'refresh:start:p1:singles', 'refresh:end:p1', 'flush:start', 'flush:end', 'toast:Matched to 151 025',
  ]);
  assert.equal(order.includes('SAVE-ALL'), false, 'the dirty rows are flushed, the whole database is not uploaded');
  assert.deepStrictEqual(app.toastLog.map((t) => [t.dur, t.isErr]).pop(), [4000, false], 'a plain toast, not an error');
  const row = rowOf(ctx, 'p1');
  assert.equal(row.tcgdexId, 'sv03.5-025');
  assert.equal(row._tcgdexResolvedName, 'Pikachu');
  assert.equal('_tcgdexMissDate' in row, false, 'the miss marker is gone');
  assert.equal(row._tcgdexPricedDate, ctx.kjrLocalDay(), 'the old priced marker was dropped and the refresh set its own');
  assert.equal(app.grab('_dirty')._dirty.singles.has('p1'), true, 'dirty until the (stubbed) flush clears it');
  assert.deepStrictEqual(plain(ctx._kjrUnresolvedSingles()), [], 'no longer unmatched');
  assert.doesNotMatch(app.body(), /Pikachu 25/, 'the row left the sheet');
  assert.match(app.body(), /All cards matched or marked custom/);
  assert.equal(app.document.getElementById('kjr-custom-live').textContent, 'All cards matched or marked custom');
  assert.equal(app.document.getElementById('singles-unresolved-banner').classList.contains('show'), false, 'and the banner count followed');
  assert.doesNotMatch(app.document.getElementById('dash-hero').innerHTML, /could not be matched/, 'and so does the Overview behind the sheet, without being asked');
});

test('pick: a price that could not be fetched leaves the match saved and says the price follows', async () => {
  for (const [why, refresh] of [['refreshPrice throws', () => { throw new Error('boom'); }], ['no price found (nothing stamped)', () => {}]]) {
    const app = await pickRig([single('p1', 'Pikachu 25', MISS)], { refresh });
    assert.equal(await app.ctx.kjrCustomPick('p1', '30th-025'), true, why);
    assert.equal(rowOf(app.ctx, 'p1').tcgdexId, '30th-025', why);
    assert.deepStrictEqual(plain(app.order).slice(-3), ['flush:start', 'flush:end', 'toast:Matched to Celebrations 025, the price will follow on the next pass'], why);
  }
});

test('pick: an upload that was refused or failed is said in the one final toast, and the match stays', async () => {
  const warn = '. Saved on this device, cloud sync will retry, check the sync indicator';
  for (const [why, flush] of [['an error', () => ({ status: 'error' })], ['blocked', () => ({ status: 'blocked' })], ['a throw', () => { throw new Error('offline'); }]]) {
    const app = await pickRig([single('p1', 'Pikachu 25', MISS)], { refresh: (row) => app.priced(row), flush });
    assert.equal(await app.ctx.kjrCustomPick('p1', 'sv03.5-025'), true, why);
    assert.equal(rowOf(app.ctx, 'p1').tcgdexId, 'sv03.5-025', why);
    assert.deepStrictEqual(plain(app.toastLog.slice(-1).map((t) => [t.m, t.dur, t.isErr])), [['Matched to 151 025' + warn, 6000, true]], why + ': one red toast, not a warning that "Matched" would replace');
    assert.equal(app.order.includes('SAVE-ALL'), false, why);
  }
  for (const status of ['confirmed', 'pending', 'idle', 'preview']) {
    const app = await pickRig([single('p1', 'Pikachu 25', MISS)], { refresh: (row) => app.priced(row), flush: () => ({ status }) });
    assert.equal(await app.ctx.kjrCustomPick('p1', 'sv03.5-025'), true, status);
    assert.deepStrictEqual(plain(app.toastLog.slice(-1).map((t) => [t.m, t.dur, t.isErr])), [['Matched to 151 025', 4000, false]], status + ' is no warning');
  }
  const both = await pickRig([single('p1', 'Pikachu 25', MISS)], { refresh: () => { throw new Error('boom'); }, flush: () => ({ status: 'error' }) });
  assert.equal(await both.ctx.kjrCustomPick('p1', 'sv03.5-025'), true);
  assert.equal(both.toastLog[both.toastLog.length - 1].m, 'Matched to 151 025, the price will follow on the next pass' + warn, 'a short price and a short upload are both said');
});

test('pick: a set the list does not name reads as its id in the toast, and a double tap saves once', async () => {
  const app = await pickRig([single('p1', 'Pikachu 25', MISS)], { refresh: (row) => app.priced(row) });
  const first = app.ctx.kjrCustomPick('p1', '2021swsh-25');
  assert.match(app.body(), /<div class="kjr-cr-status">Matching to 2021swsh 25…<\/div>/, 'the row reads Matching at once');
  assert.doesNotMatch(app.body(), /kjr-cr-cand"/, 'and cannot be tapped again');
  assert.equal(await app.ctx.kjrCustomPick('p1', 'sv03.5-025'), false, 'a second tap while it saves does nothing');
  assert.equal(await first, true);
  assert.equal(app.order.filter((o) => o.startsWith('refresh:start')).length, 1);
  assert.equal(rowOf(app.ctx, 'p1').tcgdexId, '2021swsh-25');
  assert.ok(app.order.includes('toast:Matched to 2021swsh 25'));
});

test('pick: two picks are saved one after the other, never two uploads at once', async () => {
  const app = (await setup([single('p1', 'Pikachu 25', MISS), single('p2', 'Pikachu 25 Again', MISS)])).route();
  const order = [];
  const tick = async () => { await Promise.resolve(); await new Promise((r) => setImmediate(r)); };
  app.ctx.refreshPrice = async (id) => { order.push('refresh:start:' + id); await tick(); order.push('refresh:end:' + id); };
  app.ctx._flushDirtyToSupabase = async () => { order.push('flush:start'); await tick(); order.push('flush:end'); return { status: 'confirmed' }; };
  app.ctx.saveAllToSupabase = async () => { order.push('SAVE-ALL'); };
  app.ctx.kjrCustomReviewOpen();
  await app.settle();
  const a = app.ctx.kjrCustomPick('p1', '30th-025');
  const b = app.ctx.kjrCustomPick('p2', '30th-025');
  assert.deepStrictEqual(await Promise.all([a, b]), [true, true]);
  assert.deepStrictEqual(plain(order), ['refresh:start:p1', 'refresh:end:p1', 'flush:start', 'flush:end', 'refresh:start:p2', 'refresh:end:p2', 'flush:start', 'flush:end']);
});

test('pick: a card that was matched, flagged custom or removed while the sheet was open is not touched', async () => {
  const app = await pickRig([single('p1', 'Pikachu 25', MISS), single('p2', 'Pikachu 25 Two', MISS)]);
  const { ctx, order } = app;
  rowOf(ctx, 'p1').tcgdexId = 'base1-25'; // matched in the edit form
  assert.equal(await ctx.kjrCustomPick('p1', 'sv03.5-025'), false);
  assert.equal(rowOf(ctx, 'p1').tcgdexId, 'base1-25', 'the id the edit form gave stays');
  assert.equal(await ctx.kjrCustomPick('gone', 'sv03.5-025'), false);
  assert.equal(await ctx.kjrCustomPick('p2', 'not-a-candidate'), false, 'an id that is not in its list');
  rowOf(ctx, 'p2').customCard = true;
  assert.equal(await ctx.kjrCustomPick('p2', 'sv03.5-025'), false);
  assert.equal(rowOf(ctx, 'p2').tcgdexId, '');
  assert.deepStrictEqual(plain(order).filter((o) => !o.startsWith('toast')), [], 'no snapshot, no dirty row, no price, no upload');
  assert.ok(app.toasts.some((t) => /no longer in your collection/.test(t)));
});

test('pick: a thrown write leaves the row as it was, nothing changed that is not queued to sync', async () => {
  const app = await pickRig([single('p1', 'Pikachu 25', Object.assign({ _tcgdexPricedDate: '2026-10-02' }, MISS))]);
  const { ctx, order } = app;
  ctx.markDirty = () => { throw new Error('storage is full'); };
  assert.equal(await ctx.kjrCustomPick('p1', 'sv03.5-025'), false);
  const row = rowOf(ctx, 'p1');
  assert.equal(row.tcgdexId, '', 'the id is back to what it was');
  assert.equal(row._tcgdexMissDate, '2026-10-01');
  assert.equal(row._tcgdexPricedDate, '2026-10-02');
  assert.equal('_tcgdexResolvedName' in row, false);
  assert.equal(order.some((o) => o.startsWith('refresh') || o.startsWith('flush') || o === 'SAVE-ALL'), false, 'no price and no upload for a change that did not take');
  assert.ok(app.toasts.some((t) => /^ERR Could not save that match/.test(t)));
  assert.match(app.body(), /data-cr-card="sv03.5-025"/, 'the row is still there, with its candidates, to try again');
  assert.equal(app.searches().length, 1, 'and they were not asked for again');
});

test('pick: through the dialog click, with the real price refresh and the real upload', async () => {
  const app = (await setup([single('p1', 'Pikachu 25', Object.assign({ _serverVersion: 3 }, MISS)), single('keep', 'Mew 8', { tcgdexId: 'base1-8', _serverVersion: 5 })])).route();
  app.fetchMock.route('frankfurter.dev', { ok: true, json: [{ quote: 'SGD', rate: 1 }] });
  app.fetchMock.route('/en/cards/sv03.5-025', () => jsonResponse({ pricing: { tcgplayer: { holofoil: { marketPrice: 70 } } } }));
  const requests = [];
  app.fetchMock.route('/sync/v2/mutate', (url, opts) => { requests.push(syncRequest(opts)); return syncSuccessResponse(opts); });
  app.ctx.kjrCustomReviewOpen();
  await app.settle();
  app.document.getElementById('kjr-custom-overlay').dispatchEvent(clickOf({ 'data-cr-act': 'pick', 'data-cr-id': 'p1', 'data-cr-card': 'sv03.5-025' }));
  await app.settle(60);
  const row = rowOf(app.ctx, 'p1');
  assert.equal(row.tcgdexId, 'sv03.5-025');
  assert.equal(row.marketPrice, '70', 'priced through refreshPrice');
  assert.equal(row.priceHistory.length, 1);
  assert.equal(row._tcgdexPricedDate, app.ctx.kjrLocalDay());
  assert.equal('_tcgdexMissDate' in row, false);
  const all = syncOperations(app.fetchMock);
  assert.deepStrictEqual(all.map((o) => o.table + ':' + o.id), ['singles:p1'], 'only the dirty row went up, not the whole database');
  assert.equal(requests.length, 1, 'in one request');
  assert.equal(app.toasts.some((t) => /All data synced/.test(t)), false, 'with no "All data synced" toast per pick');
  const ops = all.filter((o) => o.table === 'singles' && o.id === 'p1');
  assert.equal(ops.length, 1, 'one upsert for the row');
  assert.equal(ops[0].data.tcgdexId, 'sv03.5-025', 'the id is in the stored data');
  assert.equal(ops[0].data.marketPrice, '70');
  assert.equal('_tcgdexMissDate' in ops[0].data, false);
  assert.equal(ops[0].expected_version, 3, 'against the revision the row had');
  assert.equal(row._serverVersion, 4, 'and the cloud accepted it');
  assert.equal(app.grab('_dirty')._dirty.singles.has('p1'), false, 'the row is clean once the cloud has it');
  assert.equal(app.toasts[app.toasts.length - 1], 'Matched to 151 025', 'the last word is the match');
  assert.deepStrictEqual(plain(app.ctx._kjrUnresolvedSingles()), []);
  assert.doesNotMatch(app.body(), /Pikachu 25/);
});

test('pick: Ctrl+Z puts the card back to unmatched', async () => {
  const app = await pickRig([single('p1', 'Pikachu 25', MISS)]);
  assert.equal(await app.ctx.kjrCustomPick('p1', 'sv03.5-025'), true);
  assert.equal(rowOf(app.ctx, 'p1').tcgdexId, 'sv03.5-025');
  assert.ok(app.ctx.undoStack.length >= 1, 'one undo step was recorded');
  const snap = JSON.parse(app.ctx.undoStack[app.ctx.undoStack.length - 1]);
  const before = snap.singles.find((r) => r.id === 'p1');
  assert.equal(before.tcgdexId, '', 'the snapshot is of the row BEFORE the id was set');
  assert.equal(before._tcgdexMissDate, '2026-10-01');
});

// ── looks ───────────────────────────────────────────────────────────────────────────────────────────────────

test('looks: house tokens only, a 63:88 picture box, a strip that scrolls inside itself, a focus ring, and a sheet that never scrolls sideways', () => {
  const block = css.slice(css.indexOf('.kjr-cr-row.has-pick .kjr-cr-pick{'), css.indexOf('.kjr-cr-cnum{') + 120);
  assert.ok(block.length > 400, 'block found');
  assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, 'no hardcoded colour');
  assert.doesNotMatch(block, /rgba?\(/, 'no hardcoded colour');
  const rule = (sel) => { const m = css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}')); return m ? m[1] : ''; };
  assert.match(rule('.kjr-cr-thumb'), /aspect-ratio:63\/88/);
  assert.match(rule('.kjr-cr-thumb img'), /width:100%;height:100%/);
  assert.match(rule('.kjr-cr-cands'), /overflow-x:auto/);
  assert.match(rule('.kjr-cr-cands'), /overscroll-behavior-x:contain/);
  assert.match(rule('.kjr-cr-cands'), /max-width:100%/);
  assert.match(rule('.kjr-cr-cand'), /flex:none/);
  assert.match(rule('.kjr-cr-cand:focus-visible'), /outline:2px solid var\(--accent\)/);
  assert.match(rule('.kjr-cr-row.has-pick .kjr-cr-pick'), /min-width:0/);
  assert.match(rule('.kjr-custom-modal .modal-body'), /overflow-x:hidden/);
  assert.ok(css.indexOf('.kjr-cr-acts{') < css.indexOf('@media(max-width:480px){.kjr-cr-acts'), 'the phone layout still follows the base rules');
});
