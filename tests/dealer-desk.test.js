'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MONEY_SRC = fs.readFileSync(path.join(ROOT, 'dealer-money.js'), 'utf8');
const DESK_SRC = fs.readFileSync(path.join(ROOT, 'dealer-desk.js'), 'utf8');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function storage(initial) {
  const values = new Map(Object.entries(initial || {}));
  return {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    _values: values,
  };
}

function makeLocks() {
  const held = [];
  return {
    held,
    request(name, options, callback) {
      held.push(name);
      return Promise.resolve().then(callback);
    },
  };
}

function makeContext(seed) {
  const localStorage = storage({
    pokeinventory_v3: JSON.stringify(seed),
  });
  let id = 0;
  const locks = makeLocks();
  const sandbox = {
    localStorage,
    navigator: { locks },
    location: { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:8765', href: 'http://127.0.0.1:8765/' },
    __KJR_DEALER_PREVIEW__: true,
    __KJR_DEALER_PREVIEW_OWNER__: { label: 'Synthetic Dealer Desk preview owner' },
    crypto: { randomUUID() { id += 1; return '00000000-0000-4000-8000-' + String(id).padStart(12, '0'); } },
    console,
    DB: clone(seed),
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(MONEY_SRC, sandbox, { filename: 'dealer-money.js' });
  vm.runInContext(DESK_SRC, sandbox, { filename: 'dealer-desk.js' });
  return { sandbox, localStorage, locks };
}

function iso() {
  return '2026-09-23T00:00:00.000Z';
}

function inputCandidate() {
  return {
    id: 'candidate-001',
    name: 'Synthetic Eevee',
    set: 'Synthetic Set',
    number: '001',
    language: 'EN',
    variant: 'Holo',
    format: 'raw',
    ownership: 'Business',
    condition: { value: 'Near Mint', certainty: 'Known' },
    frontRef: 'synthetic://front',
    backRef: 'synthetic://back',
    evidenceRefs: [{
      id: 'evidence-001',
      class: 'manual',
      reference: 'synthetic://identity',
      sourceDate: iso(),
      match: 'Exact synthetic fixture',
      confidence: 'high',
      rationale: 'Synthetic fixture identity was entered manually',
      synthetic: true,
    }],
  };
}

function planInput() {
  return {
    reportingCurrency: 'SGD',
    expectedSaleAmount: '100.00',
    expectedSellingFee: '1.00',
    expectedOutboundShipping: '2.00',
    expectedRefundAllowance: '0.00',
    otherExpectedDeductions: '0.00',
    targetContribution: '20.00',
    riskAllowance: '5.00',
    knownNonItemAcquisitionCosts: '0.00',
    plannedItemCost: '10.00',
  };
}

function reviewedCost(overrides) {
  return Object.assign({
    confirmed: true,
    itemCost: '10.00',
    nonItemAcquisitionCosts: '0.00',
    currency: 'SGD',
    reviewedAt: iso(),
    reason: 'Synthetic fixture cost reviewed once',
  }, overrides || {});
}

function currentOptions(env, requestId, extra) {
  const state = env.sandbox.DealerDesk.getState();
  assert.equal(state.ok, true, state.message);
  return Object.assign({
    ownerId: env.sandbox.DealerDesk.ownerId(),
    expectedRevision: state.revision,
    requestId,
  }, extra || {});
}

async function call(env, method, args, requestId, extra) {
  const result = await env.sandbox.DealerDesk[method].apply(null, (args || []).concat(currentOptions(env, requestId, extra)));
  assert.ok(result, method + ' returned no result');
  return result;
}

function seed() {
  return {
    singles: [], slabs: [], sales: [], etbs: [], boosterBoxes: [], boosterPacks: [], ebayPurchases: [],
  };
}

test('Dealer Desk local synthetic golden path preserves exact row and settled sale links', async () => {
  const env = makeContext(seed());
  const desk = env.sandbox.DealerDesk;

  const created = await call(env, 'createCandidate', [inputCandidate()], 'create-001');
  assert.equal(created.ok, true, created.message);
  assert.equal(created.candidate.status, 'Draft');

  const planned = await call(env, 'createPlan', ['candidate-001', planInput()], 'plan-001', { reason: 'Synthetic buy scenario', expectedVersion: created.candidate.version });
  assert.equal(planned.ok, true, planned.message);
  assert.equal(planned.plan.plannedItemCost.amount, '10');
  assert.equal(planned.plan.expected.itemPriceCeiling, '72.00');

  const approved = await call(env, 'approveBuy', ['candidate-001'], 'approve-001', { reason: 'Synthetic fixture approved after identity and money review', expectedVersion: planned.plan.candidateVersion });
  assert.equal(approved.ok, true, approved.message);
  assert.equal(approved.candidate.status, 'Buy approved');

  const acquired = await call(env, 'acquireCopy', ['candidate-001', {
    inventoryTable: 'singles',
    inventoryId: 'synthetic-row-001',
    reviewedCost: reviewedCost(),
  }], 'acquire-001', { expectedCandidateVersion: approved.candidate.version });
  assert.equal(acquired.ok, true, acquired.message);
  assert.equal(acquired.candidate.status, 'Acquired');
  assert.equal(env.sandbox.DB.singles.length, 1);
  assert.equal(env.sandbox.DB.singles[0].qty, 1);
  assert.equal(env.sandbox.DB.singles[0].dealerCostBasis.total, '10');

  const asking = await call(env, 'approveAsk', ['candidate-001', { amount: '100.00', currency: 'SGD' }], 'ask-001', { expectedVersion: acquired.candidate.version });
  assert.equal(asking.ok, true, asking.message);
  const listing = await call(env, 'prepareListing', ['candidate-001'], 'listing-001', { expectedVersion: asking.candidate.version });
  assert.equal(listing.ok, true, listing.message);
  assert.equal(listing.listing.published, false);

  const sale = await call(env, 'recordSale', [{
    candidateId: 'candidate-001',
    copyId: acquired.copy.id,
    listingId: listing.listing.id,
    totalCollected: '100.005',
    shippingCost: '0.00',
    fees: '1.005',
    dateSold: iso(),
    buyer: 'Synthetic buyer',
  }], 'sale-001', { expectedCandidateVersion: asking.candidate.version });
  assert.equal(sale.ok, true, sale.message);
  assert.equal(sale.sale.paymentStatus, 'Unknown');
  assert.equal(sale.sale.dealerActual.proceeds, '100.01');
  assert.equal(sale.sale.dealerActual.sellingFee, '1.01');
  assert.equal(env.sandbox.DB.singles[0].status, 'Sold');
  assert.equal(env.sandbox.DB.sales.length, 1);

  const settled = await call(env, 'settleSale', [{
    outcomeId: sale.outcome.id,
    cashSettledAt: iso(),
    settlementEvidence: { class: 'transaction', reference: 'synthetic://receipt-001', sourceDate: iso(), match: 'Exact', confidence: 'high', rationale: 'Synthetic settled confirmation', synthetic: true },
  }], 'settle-001', { expectedSaleVersion: sale.outcome.saleRef.version, expectedSaleBytes: sale.outcome.saleRef.bytes });
  assert.equal(settled.ok, true, settled.message);
  assert.equal(settled.sale.paymentStatus, 'Settled');
  assert.equal(env.sandbox.DB.sales[0].paymentStatus, 'Settled');
  assert.equal(settled.outcome.saleRef.bytes, JSON.stringify(env.sandbox.DB.sales[0]));

  const review = await call(env, 'reviewOutcome', [{
    candidateId: 'candidate-001',
    outcomeId: sale.outcome.id,
    cause: 'Synthetic variance review',
    restockDecision: { decision: 'Review later', date: iso() },
  }], 'review-001');
  assert.equal(review.ok, true, review.message);
  assert.equal(review.review.actual.status, 'Known');
  assert.equal(review.review.planRef.id, approved.plan.id);
  assert.equal(review.review.actual.contribution.contribution, '89.00');

  const exported = desk.exportScoped();
  assert.equal(exported.ok, true, exported.message);
  assert.equal(exported.snapshot.references.inventory.length, 1);
  assert.equal(exported.snapshot.references.sales.length, 1);
  const nestedReviewCorrupt = clone(JSON.parse(env.localStorage.getItem('kjr_dealer_desk_r0_v1')));
  nestedReviewCorrupt.reviews[0].variance.components.outboundShipping.delta = 'NaN';
  env.localStorage.setItem('kjr_dealer_desk_r0_v1', JSON.stringify(nestedReviewCorrupt));
  assert.equal(desk.getState().code, 'metadata_corrupt');
  assert.equal(env.localStorage.getItem('kjr_dealer_desk_r0_v1') !== null, true);
  assert.equal(env.localStorage.getItem('kjr_dealer_desk_wal_r0_v1'), null);
});

test('Dealer Desk blocks unknowns, invalid identity, private evidence, stale writes, and unsupported actions', async () => {
  const env = makeContext(seed());
  const desk = env.sandbox.DealerDesk;
  const unknown = await call(env, 'createCandidate', [{ id: 'unknown-001', name: 'Unknown', set: 'Unknown', number: 'Unknown', language: 'Unknown', variant: 'Unknown', format: 'raw', ownership: 'Unknown', condition: { value: 'Unknown', certainty: 'Unknown' } }], 'unknown-create');
  assert.equal(unknown.ok, true);
  const state = desk.getState();
  const blocked = await desk.approveBuy('unknown-001', { ownerId: desk.ownerId(), expectedRevision: state.revision, expectedVersion: state.state.candidates[0].version, requestId: 'unknown-approve', reason: 'Trying unresolved candidate' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'buy_blocked');
  assert.ok(blocked.details.blockers.includes('exact_identity_required'));

  const privateEvidence = await call(env, 'addEvidence', ['unknown-001', { class: 'manual', reference: 'private message password', sourceDate: iso(), match: 'Exact', confidence: 'high', rationale: 'No' }], 'private-evidence');
  assert.equal(privateEvidence.ok, false);
  assert.equal(privateEvidence.code, 'sensitive_evidence_rejected');

  const first = await call(env, 'createCandidate', [inputCandidate()], 'candidate-retry');
  assert.equal(first.ok, true);
  const same = await desk.createCandidate(inputCandidate(), { ownerId: desk.ownerId(), expectedRevision: 0, requestId: 'candidate-retry', fingerprint: JSON.stringify({ different: true }) });
  assert.equal(same.ok, true);
  assert.equal(same.idempotent, true);
  const differentInput = inputCandidate();
  differentInput.name = 'Different payload';
  const duplicate = await desk.createCandidate(differentInput, { ownerId: desk.ownerId(), expectedRevision: 0, requestId: 'candidate-retry', fingerprint: JSON.stringify({ same: true }) });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.code, 'request_reuse_conflict');

  const unsupported = await desk.reserve({ ownerId: desk.ownerId(), expectedRevision: 0, requestId: 'reserve-001' });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.code, 'unsupported_release_0');
  assert.equal(desk.inspect().ok, true);
});

test('Dealer Desk rejects missing locks, wrong owners, duplicate copies, and stale row bytes without mutation', async () => {
  const env = makeContext(seed());
  const desk = env.sandbox.DealerDesk;
  const noLock = makeContext(seed());
  delete noLock.sandbox.navigator.locks;
  const denied = await noLock.sandbox.DealerDesk.createCandidate(inputCandidate(), { ownerId: noLock.sandbox.DealerDesk.ownerId(), expectedRevision: 0, requestId: 'no-lock' });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'lock_unavailable');

  const created = await call(env, 'createCandidate', [inputCandidate()], 'copy-candidate');
  assert.equal(created.ok, true);
  const plan = await call(env, 'createPlan', ['candidate-001', planInput()], 'copy-plan', { reason: 'Copy test plan', expectedVersion: created.candidate.version });
  assert.equal(plan.ok, true);
  const approved = await call(env, 'approveBuy', ['candidate-001'], 'copy-approve', { reason: 'Copy test approval', expectedVersion: plan.plan.candidateVersion });
  assert.equal(approved.ok, true);

  const badOwner = await call(env, 'acquireCopy', ['candidate-001', { inventoryTable: 'singles', inventoryId: 'owned-001', reviewedCost: reviewedCost(), expectedCandidateVersion: approved.candidate.version, row: { ownerId: 'another-owner' } }], 'bad-owner');
  assert.equal(badOwner.ok, false);
  assert.equal(badOwner.code, 'inventory_owner_required');
  assert.equal(env.sandbox.DB.singles.length, 0);
  const mixedCostCurrency = await call(env, 'acquireCopy', ['candidate-001', { inventoryTable: 'singles', inventoryId: 'mixed-currency-row', reviewedCost: reviewedCost({ nonItemCurrency: 'USD' }), expectedCandidateVersion: approved.candidate.version }], 'mixed-cost-currency');
  assert.equal(mixedCostCurrency.ok, false);
  assert.equal(mixedCostCurrency.code, 'cost_currency_mismatch');
  assert.equal(env.sandbox.DB.singles.length, 0);
  const acquired = await call(env, 'acquireCopy', ['candidate-001', { inventoryTable: 'singles', inventoryId: 'owned-001', reviewedCost: reviewedCost(), expectedCandidateVersion: approved.candidate.version }], 'good-owner');
  assert.equal(acquired.ok, true, acquired.message);
  assert.equal(env.sandbox.DB.singles[0]._dealerOwnerId, env.sandbox.DealerDesk.ownerId());
  const second = await env.sandbox.DealerDesk.acquireCopy('candidate-001', { inventoryTable: 'singles', inventoryId: 'owned-002', reviewedCost: reviewedCost(), expectedCandidateVersion: acquired.candidate.version }, currentOptions(env, 'second-copy'));
  assert.equal(second.ok, false);
  assert.equal(second.code, 'acquired_copy_required');
});

test('Dealer Desk refuses to roll back over an external in-memory inventory write', async () => {
  const env = makeContext(seed());
  const created = await call(env, 'createCandidate', [inputCandidate()], 'rollback-candidate');
  assert.equal(created.ok, true, created.message);
  const plan = await call(env, 'createPlan', ['candidate-001', planInput()], 'rollback-plan', { reason: 'Rollback conflict test', expectedVersion: created.candidate.version });
  assert.equal(plan.ok, true, plan.message);
  const approved = await call(env, 'approveBuy', ['candidate-001'], 'rollback-approve', { reason: 'Rollback conflict approval', expectedVersion: plan.plan.candidateVersion });
  assert.equal(approved.ok, true, approved.message);

  let singles = [];
  Object.defineProperty(env.sandbox.DB, 'singles', {
    configurable: true,
    enumerable: true,
    get() { return singles; },
    set() {
      singles = [{ id: 'external-row', qty: 1, status: 'Available' }];
      throw new Error('simulated external inventory write');
    },
  });
  const result = await call(env, 'acquireCopy', ['candidate-001', { inventoryTable: 'singles', inventoryId: 'rollback-row', reviewedCost: reviewedCost() }], 'rollback-acquire', { expectedCandidateVersion: approved.candidate.version });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'rollback_failed');
  assert.deepEqual(singles, [{ id: 'external-row', qty: 1, status: 'Available' }]);
  assert.equal(env.localStorage.getItem('kjr_dealer_desk_wal_r0_v1') !== null, true);
  assert.equal(JSON.parse(env.localStorage.getItem('kjr_dealer_desk_r0_v1')).revision, approved.state.revision);
});

test('Dealer Desk preview guard and scoped restore fail closed without partial replacement', async () => {
  const env = makeContext(seed());
  const desk = env.sandbox.DealerDesk;
  const denied = makeContext(seed());
  delete denied.sandbox.__KJR_DEALER_PREVIEW__;
  assert.equal(denied.sandbox.DealerDesk.getState().code, 'local_preview_required');
  assert.equal(denied.sandbox.DealerDesk.inspect().code, 'local_preview_required');

  const created = await call(env, 'createCandidate', [inputCandidate()], 'restore-create');
  assert.equal(created.ok, true);
  const exported = desk.exportScoped();
  assert.equal(exported.ok, true);
  const bad = clone(exported.snapshot);
  bad.ownerId = 'other-owner';
  const before = env.localStorage.getItem('kjr_dealer_desk_r0_v1');
  const rejected = await desk.restoreScoped(bad, currentOptions(env, 'restore-bad'));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'restore_invalid');
  assert.equal(env.localStorage.getItem('kjr_dealer_desk_r0_v1'), before);
});

test('Dealer Desk restore reports reference counts and rejects an older snapshot over newer metadata', async () => {
  const source = makeContext(seed());
  const sourceCreated = await call(source, 'createCandidate', [inputCandidate()], 'restore-source-create');
  assert.equal(sourceCreated.ok, true, sourceCreated.message);
  const sourcePlan = await call(source, 'createPlan', ['candidate-001', planInput()], 'restore-source-plan', { reason: 'Restore receipt plan', expectedVersion: sourceCreated.candidate.version });
  assert.equal(sourcePlan.ok, true, sourcePlan.message);
  const sourceApproved = await call(source, 'approveBuy', ['candidate-001'], 'restore-source-approve', { reason: 'Restore receipt approval', expectedVersion: sourcePlan.plan.candidateVersion });
  assert.equal(sourceApproved.ok, true, sourceApproved.message);
  const sourceAcquired = await call(source, 'acquireCopy', ['candidate-001', { inventoryTable: 'singles', inventoryId: 'restore-row-001', reviewedCost: reviewedCost() }], 'restore-source-acquire', { expectedCandidateVersion: sourceApproved.candidate.version });
  assert.equal(sourceAcquired.ok, true, sourceAcquired.message);
  const exported = source.sandbox.DealerDesk.exportScoped();
  assert.equal(exported.ok, true, exported.message);

  const target = makeContext(seed());
  const inserted = await target.sandbox.DealerDesk.restoreScoped(exported.snapshot, currentOptions(target, 'restore-insert'));
  assert.equal(inserted.ok, true, inserted.message);
  assert.equal(inserted.restoredReferences, 1);
  assert.equal(inserted.insertedReferences, 1);
  assert.equal(inserted.skippedReferences, 0);
  assert.equal(inserted.conflicts, 0);

  const skipped = await target.sandbox.DealerDesk.restoreScoped(exported.snapshot, currentOptions(target, 'restore-skip'));
  assert.equal(skipped.ok, true, skipped.message);
  assert.equal(skipped.restoredReferences, 1);
  assert.equal(skipped.insertedReferences, 0);
  assert.equal(skipped.skippedReferences, 1);
  assert.equal(skipped.conflicts, 0);
  const preservedReceipts = target.sandbox.DealerDesk.getState().state.requestLedger.map(function (entry) { return entry.requestId; });
  assert.ok(preservedReceipts.includes('restore-insert'));
  assert.ok(preservedReceipts.includes('restore-skip'));

  const added = await call(target, 'createCandidate', [Object.assign({}, inputCandidate(), { id: 'new-current-candidate', name: 'New current candidate' })], 'restore-current-add');
  assert.equal(added.ok, true, added.message);
  const beforeRejectedRestore = target.localStorage.getItem('kjr_dealer_desk_r0_v1');
  const rejected = await target.sandbox.DealerDesk.restoreScoped(exported.snapshot, currentOptions(target, 'restore-stale'));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'restore_state_conflict');
  assert.equal(rejected.details.conflicts, 1);
  assert.equal(target.localStorage.getItem('kjr_dealer_desk_r0_v1'), beforeRejectedRestore);
  assert.ok(target.sandbox.DealerDesk.getState().state.candidates.some(function (candidate) { return candidate.id === 'new-current-candidate'; }));
});

test('Dealer Desk blocks synchronous reads behind a pending WAL and recovers only under the write lock', async () => {
  const env = makeContext(seed());
  const created = await call(env, 'createCandidate', [inputCandidate()], 'wal-create');
  assert.equal(created.ok, true, created.message);
  const beforeMetadataRaw = env.localStorage.getItem('kjr_dealer_desk_r0_v1');
  const beforeInventoryRaw = env.localStorage.getItem('pokeinventory_v3');
  const beforeMetadata = clone(JSON.parse(beforeMetadataRaw));
  const nextMetadata = clone(beforeMetadata);
  nextMetadata.revision += 1;
  nextMetadata.updatedAt = iso();
  const dbBefore = {
    singles: clone(env.sandbox.DB.singles),
    slabs: clone(env.sandbox.DB.slabs),
    sales: clone(env.sandbox.DB.sales),
    etbs: clone(env.sandbox.DB.etbs),
    boosterBoxes: clone(env.sandbox.DB.boosterBoxes),
    boosterPacks: clone(env.sandbox.DB.boosterPacks),
    ebayPurchases: clone(env.sandbox.DB.ebayPurchases),
  };
  env.localStorage.setItem('kjr_dealer_desk_wal_r0_v1', JSON.stringify({
    schemaVersion: 1,
    ownerId: env.sandbox.DealerDesk.ownerId(),
    txId: 'tx-wal-test',
    metadataBefore: beforeMetadataRaw,
    inventoryBefore: beforeInventoryRaw,
    metadataNext: JSON.stringify(nextMetadata),
    inventoryNext: beforeInventoryRaw,
    dbBefore,
    createdAt: iso(),
  }));
  const blocked = env.sandbox.DealerDesk.getState();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'recovery_required');
  const writeBlocked = await env.sandbox.DealerDesk.createCandidate({ id: 'blocked-write' }, {
    ownerId: env.sandbox.DealerDesk.ownerId(), expectedRevision: beforeMetadata.revision, requestId: 'blocked-write',
  });
  assert.equal(writeBlocked.ok, false);
  assert.equal(writeBlocked.code, 'recovery_required');
  assert.equal(env.localStorage.getItem('kjr_dealer_desk_wal_r0_v1') !== null, true);
  assert.equal(env.localStorage.getItem('kjr_dealer_desk_r0_v1'), beforeMetadataRaw);
  const recovered = await env.sandbox.DealerDesk.recover();
  assert.equal(recovered.ok, true, recovered.message);
  assert.equal(recovered.action, 'rolled_back');
  assert.equal(env.localStorage.getItem('kjr_dealer_desk_wal_r0_v1'), null);
  assert.equal(env.sandbox.DealerDesk.getState().ok, true);
});

test('Dealer Desk rejects canonical cache divergence and nested plan corruption without losing rows', async () => {
  const env = makeContext(seed());
  assert.equal((await call(env, 'createCandidate', [inputCandidate()], 'divergence-create')).ok, true);
  const divergencePlan = await call(env, 'createPlan', ['candidate-001', planInput()], 'divergence-plan', { reason: 'Divergence test plan', expectedVersion: 1 });
  assert.equal(divergencePlan.ok, true, divergencePlan.message);
  const divergenceApproval = await call(env, 'approveBuy', ['candidate-001'], 'divergence-approve', { reason: 'Divergence test approval', expectedVersion: divergencePlan.plan.candidateVersion });
  assert.equal(divergenceApproval.ok, true, divergenceApproval.message);
  env.sandbox.DB.singles.push({ id: 'outside-row', qty: 1, status: 'Available' });
  const beforeRevision = env.sandbox.DealerDesk.getState().revision;
  const denied = await call(env, 'acquireCopy', ['candidate-001', { inventoryTable: 'singles', inventoryId: 'divergence-row', reviewedCost: reviewedCost(), expectedCandidateVersion: divergenceApproval.candidate.version }], 'divergence-acquire');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 'inventory_version_conflict');
  assert.equal(env.sandbox.DealerDesk.getState().revision, beforeRevision);
  assert.equal(env.sandbox.DB.singles.length, 1);

  const clean = makeContext(seed());
  assert.equal((await call(clean, 'createCandidate', [inputCandidate()], 'corrupt-create')).ok, true);
  assert.equal((await call(clean, 'createPlan', ['candidate-001', planInput()], 'corrupt-plan', { reason: 'Corrupt plan test', expectedVersion: 1 })).ok, true);
  const corrupted = JSON.parse(clean.localStorage.getItem('kjr_dealer_desk_r0_v1'));
  corrupted.plans[0].expected.expectedSaleAmount = 'NaN';
  clean.localStorage.setItem('kjr_dealer_desk_r0_v1', JSON.stringify(corrupted));
  const rejected = clean.sandbox.DealerDesk.getState();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'metadata_corrupt');

  const landedClean = makeContext(seed());
  assert.equal((await call(landedClean, 'createCandidate', [inputCandidate()], 'landed-create')).ok, true);
  assert.equal((await call(landedClean, 'createPlan', ['candidate-001', planInput()], 'landed-plan', { reason: 'Planned cost corruption test', expectedVersion: 1 })).ok, true);
  const landedCorrupted = JSON.parse(landedClean.localStorage.getItem('kjr_dealer_desk_r0_v1'));
  landedCorrupted.plans[0].plannedLandedCost.amount = '999';
  landedClean.localStorage.setItem('kjr_dealer_desk_r0_v1', JSON.stringify(landedCorrupted));
  const landedRejected = landedClean.sandbox.DealerDesk.getState();
  assert.equal(landedRejected.ok, false);
  assert.equal(landedRejected.code, 'metadata_corrupt');
});

test('Dealer Desk uses a strict localhost preview boundary and keeps old request receipts idempotent', async () => {
  for (const location of [
    { protocol: 'file:', hostname: '' },
    { protocol: 'http:', hostname: '0.0.0.0' },
    { protocol: 'http:', hostname: 'preview.local' },
    { protocol: 'https:', hostname: 'evil.example' },
  ]) {
    const env = makeContext(seed());
    env.sandbox.location = location;
    env.sandbox.isLocalhostPreview = function () { return true; };
    assert.equal(env.sandbox.DealerDesk.getState().code, 'local_preview_required');
  }
  const env = makeContext(seed());
  const first = await call(env, 'createCandidate', [{ id: 'long-lived', name: 'Long lived' }], 'old-receipt');
  assert.equal(first.ok, true);
  for (let i = 0; i < 105; i += 1) {
    const result = await call(env, 'createCandidate', [{ id: 'later-' + i, name: 'Later ' + i }], 'later-' + i);
    assert.equal(result.ok, true, result.message);
  }
  const replay = await env.sandbox.DealerDesk.createCandidate({ id: 'long-lived', name: 'Long lived' }, {
    ownerId: env.sandbox.DealerDesk.ownerId(),
    expectedRevision: 0,
    requestId: 'old-receipt',
  });
  assert.equal(replay.ok, true, replay.message);
  assert.equal(replay.idempotent, true);
});

test('Dealer Desk records an explicit non-sale without inventing realised contribution', async () => {
  const env = makeContext(seed());
  const created = await call(env, 'createCandidate', [inputCandidate()], 'non-sale-create');
  assert.equal(created.ok, true, created.message);
  const plan = await call(env, 'createPlan', ['candidate-001', planInput()], 'non-sale-plan', { reason: 'Non-sale plan', expectedVersion: created.candidate.version });
  assert.equal(plan.ok, true, plan.message);
  const approved = await call(env, 'approveBuy', ['candidate-001'], 'non-sale-approve', { reason: 'Non-sale approval', expectedVersion: plan.plan.candidateVersion });
  assert.equal(approved.ok, true, approved.message);
  const acquired = await call(env, 'acquireCopy', ['candidate-001', { inventoryTable: 'singles', inventoryId: 'non-sale-row', reviewedCost: reviewedCost(), expectedCandidateVersion: approved.candidate.version }], 'non-sale-acquire');
  assert.equal(acquired.ok, true, acquired.message);
  const outcome = await call(env, 'recordNoSale', [{ candidateId: 'candidate-001', copyId: acquired.copy.id, expectedCandidateVersion: acquired.candidate.version, reason: 'Synthetic listing expired', date: iso() }], 'non-sale-outcome');
  assert.equal(outcome.ok, true, outcome.message);
  assert.equal(outcome.outcome.kind, 'non_sale');
  const review = await call(env, 'reviewOutcome', [{ candidateId: 'candidate-001', outcomeId: outcome.outcome.id, cause: 'No completed transaction', restockDecision: { decision: 'Hold for review', date: iso() } }], 'non-sale-review');
  assert.equal(review.ok, true, review.message);
  assert.equal(review.review.actual.status, 'Unknown');
  assert.equal(review.review.variance.status, 'Unknown');
  assert.equal(review.review.actual.saleRef, undefined);
});
