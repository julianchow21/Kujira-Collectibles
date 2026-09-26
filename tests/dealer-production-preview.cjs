'use strict';

// Loopback-only fixture for the production Dealer Desk page. It serves the
// real app and production store, while the auth, core sync, and Dealer
// endpoints are deterministic in-page fakes owned by the fixture. No token or
// private inventory data is used, and unknown requests never leave the page.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = 8766;
const OWNER_ID = 'fixture-owner';
const SESSION_ID = 'fixture-session';
const DEALER_CACHE_KEY = 'kjr-dealer-production-v1:' + encodeURIComponent(OWNER_ID);

const STATIC_FILES = Object.freeze({
  '/app.js': 'app.js',
  '/features.js': 'features.js',
  '/dealer-money.js': 'dealer-money.js',
  '/dealer-desk.js': 'dealer-desk.js',
  '/dealer-ui.js': 'dealer-ui.js',
  '/dealer-store.js': 'dealer-store.js',
  '/dealer-production-ui.js': 'dealer-production-ui.js',
  '/styles.css': 'styles.css',
  '/sw.js': 'sw.js',
  '/Assets/apple-touch-icon.png': 'Assets/apple-touch-icon.png',
  '/Assets/manifest.webmanifest': 'Assets/manifest.webmanifest',
  '/Assets/whale-icon.png': 'Assets/whale-icon.png',
  '/Assets/whale-icon-192.png': 'Assets/whale-icon-192.png',
  '/Assets/whale-icon-maskable-512.png': 'Assets/whale-icon-maskable-512.png',
  '/Assets/lib/three.core.min.js': 'Assets/lib/three.core.min.js',
  '/Assets/lib/three.module.js': 'Assets/lib/three.module.js'
});

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/manifest+json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png'
});

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function coreRow(table, id, data, version) {
  return { id, data: Object.assign({}, data || {}), row_version: version || 1, updated_at: '2026-09-26T10:00:00.000Z' };
}

function fixtureCore() {
  return {
    singles: [
      coreRow('singles', 'single-9', { name: 'Fixture Eevee VMAX', set: 'Fixture Set', number: '009', condition: 'Near Mint', costPrice: 20, status: 'Available' }, 2),
      coreRow('singles', 'single-10', { name: 'Fixture Pikachu V', set: 'Fixture Set', number: '010', condition: 'Near Mint', costPrice: 18, status: 'Available' }, 2)
    ],
    slabs: [coreRow('slabs', 'slab-44', { name: 'Fixture Graded Charizard', set: 'Fixture Set', number: '044', language: 'EN', condition: 'PSA 10', format: 'slab', grader: 'PSA', grade: '10', certNo: 'FIXTURE-SLAB-44', costPrice: 90, status: 'Available' }, 3)],
    sales: [], etbs: [], booster_boxes: [], booster_packs: [], ebay_purchases: [], trash: []
  };
}

function candidateRecord(id, data, version) {
  const fields = Object.assign({ name: 'Fixture candidate', set: 'Fixture Set', number: '009', variant: 'Normal', condition: 'Near mint', ownership: 'Business', source: 'Synthetic fixture', notes: '' }, data || {});
  return Object.assign({ id, entity_type: 'candidate', row_version: version || 1, candidateVersion: version || 1, stage: 'Candidate', status: 'Candidate', data: fields }, fields);
}

function parsePreviewFetchBody(input, init) {
  const hasInitBody = init && typeof init === 'object' && Object.prototype.hasOwnProperty.call(init, 'body');
  const raw = hasInitBody ? init.body : (input && typeof input === 'object' ? input.body : null);
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

function buildBootstrap() {
  const cacheKey = DEALER_CACHE_KEY;
  return `<script id="kjr-dealer-production-fixture-bootstrap">
(function () {
  'use strict';
  var CACHE_KEY = ${JSON.stringify(cacheKey)};
  var OWNER_ID = ${JSON.stringify(OWNER_ID)};
  var SESSION_ID = ${JSON.stringify(SESSION_ID)};
  var scenario = new URL(location.href).searchParams.get('scenario') || 'golden';
  var clone = function (value) { return JSON.parse(JSON.stringify(value)); };
  var mode = scenario === 'retry' ? 'unknown-once' : scenario === 'conflict' ? 'conflict' : '';
  var core = ${jsonForScript(fixtureCore())};
  var candidateCounter = 0;
  var candidateList = [];
  var details = new Map();

  function row(id, data, version) {
    return { id: id, entity_type: 'candidate', row_version: version || 1, candidateVersion: version || 1, stage: 'Candidate', status: 'Candidate', data: clone(data || {}) };
  }
  function coreItem(id, data, version) {
    return { id: id, data: clone(data || {}), row_version: version || 1, updated_at: '2026-09-26T10:00:00.000Z' };
  }
  function selectedDetail(record) {
    var detail = details.get(record.id) || { plans: [], evidence: [], copy: [], listings: [], outcomes: [], reviews: [], readiness: {} };
    return Object.assign({ candidate: record }, clone(detail));
  }
  function snapshotFor(cursor, candidateId) {
    var start = cursor === 'page-2' ? 50 : 0;
    var page = candidateList.slice(start, start + 50);
    var selected = candidateId ? candidateList.find(function (item) { return String(item.id) === String(candidateId); }) : page[0] || null;
    return {
      candidates: page,
      selected: selected ? selectedDetail(selected) : null,
      canonicalRefs: selected && selected._canonicalRefs ? clone(selected._canonicalRefs) : [],
      next_cursor: start + 50 < candidateList.length ? 'page-2' : null,
      revisions: {}
    };
  }
  function makeCandidates() {
    if (scenario === 'empty') return [];
    if (scenario === 'offline') return [row('candidate-offline', { name: 'Offline cached candidate with a long retained note', notes: 'Cached authoritative fixture record. Viewing is stale until a successful online pull.' }, 4)];
    if (scenario === 'long') return [row('candidate-long', { name: 'Fixture candidate with a deliberately long name for overflow checks '.repeat(18), notes: 'Long text '.repeat(140) }, 2)];
    if (scenario === 'many') return Array.from({ length: 62 }, function (_, index) { return row('candidate-' + String(index + 1).padStart(3, '0'), { name: 'Many candidate ' + String(index + 1).padStart(3, '0'), set: 'Fixture Set ' + (index % 4 + 1) }, 1); });
    return [];
  }
  candidateList = makeCandidates();

  function response(body, status) {
    var code = status || 200;
    return { ok: code >= 200 && code < 300, status: code, json: function () { return Promise.resolve(clone(body)); } };
  }
  function protocol(body) { return Object.assign({ ok: true, client_protocol: 2, schema_version: 1 }, body || {}); }
  function dealerPull(request) {
    var body = request || {};
    var data = snapshotFor(body.cursor, body.candidateId);
    return response(protocol({ data: data }));
  }
  function commandResponse(body) {
    var knownCommands = ['create_candidate', 'update_candidate', 'add_evidence', 'create_plan', 'approve_buy', 'acquire_copy', 'link_copy', 'set_asking', 'prepare_listing', 'record_sale', 'settle_sale', 'record_non_sale', 'review_outcome'];
    if (!body || typeof body.command !== 'string' || !knownCommands.includes(body.command)) {
      return response(protocol({ ok: false, error: { code: 'fixture_command_invalid', message: 'Dealer command name is required and must be recognised' } }), 400);
    }
    var command = body.command;
    if (mode === 'unknown-once') {
      mode = '';
      return response({ ok: false, client_protocol: 2, schema_version: 1, error: { code: 'sync_upstream_unavailable', message: 'Synthetic response lost after the command reached the Worker boundary' } }, 502);
    }
    if (mode === 'conflict') return response({ ok: false, client_protocol: 2, schema_version: 1, error: { code: 'version_conflict', message: 'Synthetic current server version changed', current: { id: body.payload && body.payload.candidateId || 'candidate-1', version: 9 } } }, 409);
    var payload = body.payload || {};
    var record;
    if (command === 'create_candidate') {
      candidateCounter += 1;
      var id = 'candidate-created-' + candidateCounter;
      // The production command contract accepts candidate fields at the
      // payload top level. Keep this fixture aligned with the Worker/SQL
      // shape so browser QA exercises the actual request body.
      record = row(id, payload, 1);
      candidateList.unshift(record);
      details.set(id, { plans: [], evidence: [], copy: [], listings: [], outcomes: [], reviews: [], readiness: {} });
    } else {
      var candidateId = payload.candidateId || payload.candidate_id || (candidateList[0] && candidateList[0].id) || 'candidate-created-1';
      record = candidateList.find(function (item) { return String(item.id) === String(candidateId); });
      if (!record) { record = row(String(candidateId), {}, 1); candidateList.unshift(record); }
      record.row_version = (Number(record.row_version) || 1) + 1;
      record.candidateVersion = record.row_version;
      if (command === 'update_candidate' && payload.patch) Object.assign(record, clone(payload.patch), { data: Object.assign({}, record.data, clone(payload.patch)) });
      var detail = details.get(record.id) || { plans: [], evidence: [], copy: [], listings: [], outcomes: [], reviews: [], readiness: {} };
      if (command === 'add_evidence') {
        detail.evidence = [{ id: 'evidence-1', row_version: 1, source: payload.evidence && payload.evidence.source || '', data: clone(payload.evidence || {}) }];
        // The synthetic fixture has already supplied a complete business
        // identity, so the next production gate can exercise plan approval.
        detail.readiness = { ready: true, blockers: [] };
      }
      if (command === 'create_plan') {
        var planInput = clone(payload.plan || {});
        var saleAmount = Number(planInput.expectedSaleAmount);
        var sellingFee = Number(planInput.expectedSellingFee);
        var outboundShipping = Number(planInput.expectedOutboundShipping);
        var refundAllowance = Number(planInput.expectedRefundAllowance);
        var otherDeductions = Number(planInput.otherExpectedDeductions);
        var targetContribution = Number(planInput.targetContribution);
        var riskAllowance = Number(planInput.riskAllowance);
        var nonItemCosts = Number(planInput.knownNonItemAcquisitionCosts);
        var plannedItemAmount = Number(planInput.plannedItemCost);
        var expectedNetProceeds = saleAmount - sellingFee - outboundShipping - refundAllowance - otherDeductions;
        var maximumAllIn = expectedNetProceeds - targetContribution - riskAllowance;
        var rawItemCeiling = maximumAllIn - nonItemCosts;
        var itemCeiling = Math.max(0, Math.floor(rawItemCeiling * 100) / 100);
        var plannedLandedAmount = plannedItemAmount + nonItemCosts;
        planInput.expected = {
          saleAmount: saleAmount, expectedSaleAmount: saleAmount, sellingFee: sellingFee, outboundShipping: outboundShipping,
          refundAllowance: refundAllowance, otherDeductions: otherDeductions, targetContribution: targetContribution,
          riskAllowance: riskAllowance, knownNonItemAcquisitionCosts: nonItemCosts, expectedNetProceeds: expectedNetProceeds,
          maximumAllInAcquisitionCost: maximumAllIn, maximumAllInAcquisitionCostRounded: Math.floor(maximumAllIn * 100) / 100,
          rawItemPriceCeiling: rawItemCeiling, itemPriceCeiling: itemCeiling, itemCeiling: itemCeiling,
          plannedContribution: expectedNetProceeds - plannedLandedAmount, plannedContributionStatus: 'Known', currency: planInput.reportingCurrency || 'SGD'
        };
        planInput.plannedItemCost = { status: 'Known', amount: plannedItemAmount, currency: 'SGD' };
        planInput.plannedLandedCost = { status: 'Known', amount: plannedLandedAmount, currency: 'SGD' };
        detail.readiness = { ready: true, blockers: [] };
        detail.plans = [{ id: 'plan-1', row_version: 1, reason: planInput.reason || '', currency: planInput.reportingCurrency || 'SGD', status: 'draft', data: planInput }];
      }
      if (command === 'approve_buy' && detail.plans[0]) { detail.plans[0].row_version += 1; detail.plans[0].status = 'approved'; }
      if (command === 'acquire_copy' || command === 'link_copy') {
        var copyId = command === 'link_copy' ? 'copy-linked-1' : 'copy-acquired-1';
        var inventoryTable = payload.inventoryTable || 'singles';
        var inventoryId = payload.inventoryId;
        var reviewedCost = payload.reviewedCost || {};
        var itemCost = Number(reviewedCost.itemCost);
        var nonItemCost = Number(reviewedCost.nonItemAcquisitionCosts == null ? 0 : reviewedCost.nonItemAcquisitionCosts);
        var settledAmount = itemCost + nonItemCost;
        var costComponent = Object.assign({}, clone(reviewedCost), { itemCost: itemCost, nonItemAcquisitionCosts: nonItemCost, settledAmount: settledAmount, settledCurrency: 'SGD' });
        if (!inventoryId) {
          inventoryId = 'dealer-' + inventoryTable + '-' + record.id;
          core[inventoryTable] = core[inventoryTable] || [];
          core[inventoryTable].push(coreItem(inventoryId, { name: record.data && record.data.name || 'Dealer fixture copy', set: record.data && record.data.set || 'Fixture Set', number: record.data && record.data.number || '009', condition: record.data && record.data.condition || 'Near Mint', costPrice: itemCost, nonItemAcquisitionCosts: nonItemCost, dealerCostBasis: clone(costComponent), status: 'Available', dealerCandidateId: record.id, dealerControlled: true }, 1));
        }
        detail.copy = [{ id: copyId, row_version: 1, itemRef: { table: inventoryTable, id: inventoryId }, costComponent: costComponent }];
        record.stage = 'Acquired'; record.status = 'Acquired';
        record._canonicalRefs = [{ copyId: copyId, inventoryTable: inventoryTable, inventoryId: inventoryId, canonicalRowVersion: Number(body.expected && body.expected.canonical) || 2 }];
        var table = inventoryTable === 'slabs' ? 'slabs' : 'singles';
        var coreRows = core[table] || [];
        var coreRow = coreRows.find(function (item) { return item.id === inventoryId; });
        if (coreRow) { coreRow.data.dealerCandidateId = record.id; coreRow.data.dealerControlled = true; }
      }
      if (command === 'set_asking' || command === 'prepare_listing') {
        detail.listings = [{ id: payload.listingId || 'listing-1', row_version: command === 'prepare_listing' ? 2 : 1, status: command === 'prepare_listing' ? 'prepared' : 'asking_set', asking: clone((payload.listing && payload.listing.asking) || payload.asking || {}), data: clone(payload.listing || {}) }];
      }
      if (command === 'record_sale') {
        detail.outcomes = [{ id: 'outcome-1', row_version: 1, saleId: 'sale-fixture-1', saleRowVersion: 1, paymentStatus: 'Unknown', agreedAmount: payload.agreedAmount, currency: payload.currency, soldAt: payload.soldAt }];
        record.stage = 'Sold'; record.status = 'Sold';
        core.sales = [coreItem('sale-fixture-1', { inventoryId: record._canonicalRefs && record._canonicalRefs[0] && record._canonicalRefs[0].inventoryId, dateSold: payload.soldAt, product: record.data && record.data.name || 'Dealer fixture sale', costPrice: detail.copy[0] && detail.copy[0].costComponent && (detail.copy[0].costComponent.settledAmount == null ? detail.copy[0].costComponent.itemCost : detail.copy[0].costComponent.settledAmount), totalCollected: payload.agreedAmount, shippingCost: null, fees: null, profit: null, margin: null, paymentStatus: 'Unknown', dealerPaymentStatus: 'Unknown', dealerCandidateId: record.id, dealerOutcomeId: 'outcome-1', dealerControlled: true, status: 'Recorded' }, 1)];
      }
      if (command === 'settle_sale' && detail.outcomes[0]) {
        var settledProceeds = Number(payload.proceeds);
        var settledSellingFee = Number(payload.sellingFee);
        var settledOutboundShipping = Number(payload.outboundShipping);
        var settledSale = (core.sales || [])[0];
        var settledCost = settledSale && settledSale.data ? Number(settledSale.data.costPrice) : Number(detail.copy[0] && detail.copy[0].costComponent && detail.copy[0].costComponent.itemCost);
        var settledContribution = settledProceeds - settledSellingFee - settledOutboundShipping - settledCost;
        detail.outcomes[0].row_version += 1;
        detail.outcomes[0].saleRowVersion = detail.outcomes[0].row_version;
        detail.outcomes[0].paymentStatus = 'Settled';
        detail.outcomes[0].settlement = { status: 'Settled', proceeds: payload.proceeds, sellingFee: payload.sellingFee, outboundShipping: payload.outboundShipping };
        detail.outcomes[0].contribution = settledContribution;
        detail.outcomes[0].dealerActual = {
          proceeds: settledProceeds,
          sellingFee: settledSellingFee,
          outboundShipping: settledOutboundShipping,
          canonicalLandedCost: settledCost,
          contribution: settledContribution,
          reportingCurrency: payload.currency || 'SGD',
          postedCurrency: payload.currency || 'SGD',
          postedProceeds: settledProceeds,
          postedSellingFee: settledSellingFee,
          postedOutboundShipping: settledOutboundShipping
        };
        if (settledSale) {
          settledSale.data.totalCollected = settledProceeds; settledSale.data.shippingCost = settledOutboundShipping; settledSale.data.fees = settledSellingFee; settledSale.data.profit = settledContribution; settledSale.data.margin = settledProceeds ? (settledContribution / settledProceeds * 100) : null; settledSale.data.paymentStatus = 'Settled'; settledSale.data.dealerPaymentStatus = 'Settled'; settledSale.data.dealerActual = clone(detail.outcomes[0].dealerActual);
        }
      }
      if (command === 'record_non_sale') { detail.outcomes = [{ id: 'outcome-non-sale-1', row_version: 1, paymentStatus: 'Not applicable', reason: payload.reason }]; record.stage = 'Reviewed'; record.status = 'Reviewed'; }
      if (command === 'review_outcome' && detail.outcomes[0]) {
        var reviewActual = clone(detail.outcomes[0].dealerActual || { status: 'Unknown' });
        var reviewPlan = detail.plans[0] && detail.plans[0].data || {};
        var reviewExpected = reviewPlan.expected || {};
        var reviewPlanned = Number(reviewExpected.plannedContribution);
        var reviewTarget = Number(reviewExpected.targetContribution);
        var reviewContribution = Number(reviewActual.contribution);
        var planVariance = Number.isFinite(reviewContribution) && Number.isFinite(reviewPlanned)
          ? { status: 'Known', plannedContribution: reviewPlanned, actualContribution: reviewContribution, delta: reviewContribution - reviewPlanned }
          : { status: 'Unknown' };
        var targetVariance = Number.isFinite(reviewContribution) && Number.isFinite(reviewTarget)
          ? { status: 'Known', targetContribution: reviewTarget, actualContribution: reviewContribution, delta: reviewContribution - reviewTarget }
          : { status: 'Unknown' };
        detail.reviews = [{ id: 'review-1', row_version: 1, notes: payload.review && payload.review.notes || '', data: { actual: reviewActual, planVariance: planVariance, targetVariance: targetVariance } }];
      }
      details.set(record.id, detail);
    }
    return response(protocol({ command_id: body.command_id, result: { candidate: clone(record), revisions: { candidate: record.row_version } } }));
  }

  function syncPull() {
    return response({ ok: true, client_protocol: 2, tables: clone(core), tombstones: [] });
  }

  // Synthetic owner session only. The bearer never leaves this page and all
  // unknown URL requests fail, so the fixture cannot call a live service.
  var session = { access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', expires_at: Math.floor(Date.now() / 1000) + 3600, user_id: OWNER_ID, session_id: SESSION_ID };
  localStorage.setItem('_kjrOwnerSessionV1', JSON.stringify(session));
  localStorage.setItem('_kjrOwnerVerifiedV1', JSON.stringify({ user_id: OWNER_ID, session_id: SESSION_ID }));
  localStorage.setItem('pokeinventory_v3', JSON.stringify({ singles: clone(core.singles.map(function (item) { return Object.assign({}, item.data, { id: item.id, row_version: item.row_version }); })), slabs: clone(core.slabs.map(function (item) { return Object.assign({}, item.data, { id: item.id, row_version: item.row_version }); })), sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [] }));
  if (scenario === 'offline') localStorage.setItem(CACHE_KEY, JSON.stringify({ owner_id: OWNER_ID, schema_version: 1, snapshot: { clientProtocol: 2, schemaVersion: 1, candidates: clone(candidateList), selectedCandidate: clone(candidateList[0]), selectedDetail: selectedDetail(candidateList[0]), canonicalRefs: [], nextCursor: null, revisions: {}, fetchedAt: '2026-09-26T10:00:00.000Z' }, stale: false, schema_known: true, drafts: {}, pending: {} }));

  try { Object.defineProperty(navigator, 'onLine', { configurable: true, value: scenario === 'offline' ? false : true }); } catch (_) {}
  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: function () { return Promise.resolve({ waiting: null, installing: null, addEventListener: function () {} }); } });
      Object.defineProperty(navigator.serviceWorker, 'addEventListener', { configurable: true, value: function () {} });
    }
  } catch (_) {}
  window.Chart = class { destroy() {} update() {} resize() {} };
  window.marked = { parse: function (value) { return String(value || ''); } };
  window.Sentry = undefined;
  window.__KJR_PRODUCTION_FIXTURE__ = { scenario: scenario, setMode: function (next) { mode = next; }, setOffline: function (offline) { try { Object.defineProperty(navigator, 'onLine', { configurable: true, value: !offline }); } catch (_) {} } };
  var parseRequestBody = ${parsePreviewFetchBody.toString()};
  window.fetch = function (input, init) {
    var url = String(input && input.url || input || '');
    if (url.indexOf('api.frankfurter.app/latest?from=USD') !== -1 || url.indexOf('open.er-api.com/v6/latest/USD') !== -1) return Promise.resolve(response({ rates: { SGD: 1.35 } }));
    if (url.indexOf('api.frankfurter.app/latest?from=EUR') !== -1 || url.indexOf('open.er-api.com/v6/latest/EUR') !== -1) return Promise.resolve(response({ rates: { SGD: 1.45 } }));
    if (url.indexOf('currency-api@latest/v1/currencies/usd.json') !== -1) return Promise.resolve(response({ usd: { sgd: 1.35 } }));
    if (url.indexOf('currency-api@latest/v1/currencies/eur.json') !== -1) return Promise.resolve(response({ eur: { sgd: 1.45 } }));
    if (url.indexOf('/auth/v1/user') !== -1) return Promise.resolve(response({ id: OWNER_ID }));
    if (url.indexOf('/sync/v2/pull') !== -1 && url.indexOf('/dealer/pull') === -1) return Promise.resolve(syncPull());
    if (url.indexOf('/sync/v2/dealer/pull') !== -1) {
      var request = parseRequestBody(input, init);
      if (!request) return Promise.resolve(response(protocol({ ok: false, error: { code: 'fixture_request_invalid', message: 'Dealer pull requires a JSON request body' } }), 400));
      return Promise.resolve(dealerPull(request));
    }
    if (url.indexOf('/sync/v2/dealer/command') !== -1) {
      var body = parseRequestBody(input, init);
      if (!body) return Promise.resolve(response(protocol({ ok: false, error: { code: 'fixture_request_invalid', message: 'Dealer command requires a JSON request body' } }), 400));
      return Promise.resolve(commandResponse(body));
    }
    if (url.indexOf('/sync/v2/mutate') !== -1) return Promise.resolve(response({ ok: true, client_protocol: 2, mutation_id: 'fixture-mutation', results: [] }));
    if (url.indexOf('/auth/v1/logout') !== -1) return Promise.resolve(response({}));
    return Promise.reject(new TypeError('Production fixture blocked non-fixture network request'));
  };
})();
</script>`;
}

const TOOLBAR = `<aside id="kjr-production-fixture-tools" aria-label="Dealer Desk fixture controls" style="position:fixed;right:10px;bottom:10px;z-index:10000;display:flex;align-items:center;gap:6px;flex-wrap:wrap;max-width:calc(100vw - 20px);padding:8px 10px;border:1px solid var(--border2);border-radius:var(--radius);background:var(--bg2);box-shadow:0 4px 20px rgba(0,0,0,.25);font:11px/1.3 system-ui,sans-serif"><strong style="color:var(--accent);white-space:nowrap">DEALER FIXTURE</strong><button type="button" onclick="window.__kjrProductionFill('golden')">Fill golden fields</button><button type="button" onclick="window.__kjrProductionFill('existing')">Select existing copy</button><button type="button" onclick="window.__KJR_PRODUCTION_FIXTURE__.setMode('unknown-once')">Next command unknown</button><button type="button" onclick="window.__KJR_PRODUCTION_FIXTURE__.setMode('conflict')">Next command conflict</button><button type="button" onclick="window.__KJR_PRODUCTION_FIXTURE__.setOffline(true);showPage('dealerProduction')">Offline view</button><button type="button" onclick="window.__KJR_PRODUCTION_FIXTURE__.setOffline(false);location.reload()">Online reset</button><span style="color:var(--text3)">Synthetic owner, loopback only</span></aside>`;

const FILL_SCRIPT = `<script>
(function () {
  function setValue(selector, value) {
    var element = document.querySelector(selector);
    if (!element) return;
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }
  window.__kjrProductionFill = function (mode) {
    setValue('[data-dealer-field="name"]', mode === 'existing' ? 'Fixture Graded Charizard' : 'Fixture golden candidate');
    setValue('[data-dealer-field="set"]', 'Fixture Set');
    setValue('[data-dealer-field="number"]', mode === 'existing' ? '044' : '009');
    setValue('[data-dealer-field="language"]', 'EN');
    setValue('[data-dealer-field="condition"]', mode === 'existing' ? 'PSA 10' : 'Near mint');
    setValue('[data-dealer-field="conditionCertainty"]', 'confirmed');
    setValue('[data-dealer-field="conditionScenario"]', mode === 'existing' ? 'PSA 10 slab' : 'raw near mint');
    setValue('[data-dealer-field="format"]', mode === 'existing' ? 'slab' : 'raw');
    if (mode === 'existing') {
      setValue('[data-dealer-field="grader"]', 'PSA');
      setValue('[data-dealer-field="grade"]', '10');
      setValue('[data-dealer-field="certificateNumber"]', 'FIXTURE-SLAB-44');
    }
    var ownership = document.querySelector('[data-dealer-field="ownershipReviewed"]');
    if (ownership) { ownership.checked = true; ownership.dispatchEvent(new Event('input', { bubbles: true })); }
    setValue('[data-stage-field="evidenceClass"]', 'identity');
    setValue('[data-stage-field="evidenceRef"]', 'https://fixture.invalid/evidence/1');
    setValue('[data-stage-field="evidenceMatch"]', 'confirmed');
    setValue('[data-stage-field="evidenceConfidence"]', 'high');
    setValue('[data-stage-field="evidenceRationale"]', 'Fixture identity and condition evidence');
    setValue('[data-stage-field="evidenceDate"]', '25/09/2026');
    setValue('[data-stage-field="planReason"]', 'Evidence-backed fixture buy');
    setValue('[data-stage-field="expectedSaleAmount"]', '35');
    setValue('[data-stage-field="expectedSellingFee"]', '1');
    setValue('[data-stage-field="expectedOutboundShipping"]', '2');
    setValue('[data-stage-field="expectedRefundAllowance"]', '0');
    setValue('[data-stage-field="otherExpectedDeductions"]', '1');
    setValue('[data-stage-field="targetContribution"]', '5');
    setValue('[data-stage-field="targetMargin"]', '0');
    setValue('[data-stage-field="riskAllowance"]', '0');
    setValue('[data-stage-field="knownNonItemAcquisitionCosts"]', '2');
    setValue('[data-stage-field="plannedItemCost"]', mode === 'existing' ? '90' : '20');
    setValue('[data-stage-field="conditionScenario"]', mode === 'existing' ? 'PSA 10 slab' : 'raw near mint');
    setValue('[data-stage-field="reportingCurrency"]', 'SGD');
    setValue('[data-stage-field="copyMode"]', mode === 'existing' ? 'existing' : 'new');
    setValue('[data-stage-field="acquisitionTable"]', 'singles');
    setValue('[data-stage-field="inventoryRef"]', mode === 'existing' ? 'slabs::slab-44' : '');
    setValue('[data-stage-field="copyCost"]', mode === 'existing' ? '90' : '20');
    setValue('[data-stage-field="copyCurrency"]', 'SGD');
    setValue('[data-stage-field="nonItemAcquisitionCosts"]', '2');
    setValue('[data-stage-field="copyCostReason"]', 'Fixture reviewed purchase cost');
    setValue('[data-stage-field="copyCostDate"]', '25/09/2026');
    var check = document.querySelector('[data-stage-field="inheritCost"]');
    if (check) { check.checked = true; check.dispatchEvent(new Event('input', { bubbles: true })); }
    setValue('[data-stage-field="platform"]', 'Fixture marketplace');
    setValue('[data-stage-field="channel"]', 'Online');
    setValue('[data-stage-field="askingAmount"]', '35');
    setValue('[data-stage-field="currency"]', 'SGD');
    setValue('[data-stage-field="saleAmount"]', '35');
    setValue('[data-stage-field="saleDate"]', '25/09/2026');
    setValue('[data-stage-field="settlementRef"]', 'fixture-settlement-1');
    setValue('[data-stage-field="settlementDate"]', '26/09/2026');
    setValue('[data-stage-field="proceeds"]', '35');
    setValue('[data-stage-field="sellingFee"]', '1');
    setValue('[data-stage-field="outboundShipping"]', '2');
    setValue('[data-stage-field="reviewCause"]', 'Fixture outcome review');
    setValue('[data-stage-field="restockDecision"]', 'restock');
    setValue('[data-stage-field="restockDate"]', '26/09/2026');
    setValue('[data-stage-field="outcomeNotes"]', 'Fixture review note');
    setValue('[data-stage-field="reviewNotes"]', 'Fixture review note');
  };
  var tries = 0;
  var open = function () { tries += 1; if (window.DealerStore && window.DealerStore.view && window.DealerStore.view().ok) { showPage('dealerProduction'); return; } if (tries < 200) setTimeout(open, 50); };
  setTimeout(open, 100);
})();
</script>`;

function readKnownFile(relativePath) {
  const absolutePath = path.resolve(ROOT, relativePath);
  const rootPrefix = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (absolutePath !== ROOT && !absolutePath.startsWith(rootPrefix)) throw new Error('fixture path escaped root');
  return fs.readFileSync(absolutePath);
}

function buildPreviewIndex() {
  let html = readKnownFile('index.html').toString('utf8');
  html = html.replace(/\s*<script\s+src="https?:\/\/[^\"]+"[^>]*><\/script>\s*/gi, '\n');
  html = html.replace(/\s*<link\s+rel="preconnect"[^>]*>\s*/gi, '\n');
  html = html.replace(/\s*<link\s+rel="stylesheet"\s+href="https?:\/\/[^\"]+"[^>]*>\s*/gi, '\n');
  html = html.replace(/\s*<script>\s*\(function\s*\(\)\s*\{\s*var DSN\s*=\s*[\s\S]*?<\/script>\s*/i, '\n');
  html = html.replace('</head>', '<style id="kjr-production-fixture-no-intro">#intro{display:none!important}@media(max-width:600px){#kjr-production-fixture-tools{bottom:96px!important;right:8px!important;max-width:calc(100vw - 16px);max-height:calc(100vh - 160px);overflow:auto}}</style>\n</head>');
  html = html.replace(/<script\s+src="app\.js[^\"]*"><\/script>/i, function (match) { return buildBootstrap() + '\n' + match; });
  html = html.replace('</body>', TOOLBAR + FILL_SCRIPT + '\n</body>');
  return html;
}

function contentTypeFor(relativePath) { return CONTENT_TYPES[path.extname(relativePath).toLowerCase()] || 'application/octet-stream'; }
function requestPath(req) { try { return new URL(req.url || '/', 'http://' + HOST + ':' + PORT).pathname; } catch (_) { return null; } }

function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return; }
  const pathname = requestPath(req);
  if (pathname === '/' || pathname === '/index.html') {
    const body = Buffer.from(buildPreviewIndex(), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; base-uri 'none'; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'none'", 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end(); else res.end(body);
    return;
  }
  const relativePath = STATIC_FILES[pathname];
  if (!relativePath) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end('Not found'); return; }
  try {
    const body = readKnownFile(relativePath);
    res.writeHead(200, { 'Content-Type': contentTypeFor(relativePath), 'Content-Length': body.length, 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; object-src 'none'; connect-src 'self'; worker-src 'none'", 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end(); else res.end(body);
  } catch (_) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Fixture asset unavailable'); }
}

function createPreviewServer() { return http.createServer(handleRequest); }

if (require.main === module) {
  const server = createPreviewServer();
  server.listen(PORT, HOST, function () {
    console.log('Dealer Desk production fixture: http://' + HOST + ':' + PORT + '/?scenario=golden');
    console.log('Scenarios: golden, empty, many, long, offline, retry, conflict');
    console.log('Synthetic auth, core rows, and Dealer commands are loopback-only. Unknown fetches are rejected.');
  });
  const stop = function () { server.close(function () { process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { HOST, PORT, ROOT, STATIC_FILES, buildBootstrap, buildPreviewIndex, createPreviewServer, handleRequest, parsePreviewFetchBody };
