'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const DealerStore = require('../dealer-store.js');
require('../dealer-production-ui.js');
const DealerProductionUI = globalThis.DealerProductionUI;
const SOURCE = fs.readFileSync(require.resolve('../dealer-production-ui.js'), 'utf8');

function ownerContext() {
  return { authenticated: true, verified: true, userId: 'ui-owner', sessionId: 'ui-session', generation: 1, offline: false };
}

function decodeHtml(value) {
  return String(value || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Small browser-faithful DOM surface. It reparses the controller's rendered
// HTML on every assignment, so selectors read the values that survived a
// render rather than a constant map that can hide form-loss bugs.
function browserLikeRoot() {
  let html = '';
  let elements = [];
  const handlers = {};
  const parse = () => {
    elements = [];
    const tags = /<(input|textarea|select)\b([^>]*)>([\s\S]*?)<\/\1>|<(input)\b([^>]*)\/?\s*>/gi;
    let match;
    while ((match = tags.exec(html))) {
      const tag = String(match[1] || match[4]).toLowerCase();
      const attrs = match[2] || match[5] || '';
      const content = match[3] || '';
      const field = attrs.match(/data-(dealer|stage)-field="([^"]+)"/i);
      if (!field) continue;
      const typeMatch = attrs.match(/type="([^"]+)"/i);
      const valueMatch = attrs.match(/value="([^"]*)"/i);
      const selectedMatch = content.match(/<option\b[^>]*value="([^"]*)"[^>]*selected/i);
      const element = {
        tagName: tag.toUpperCase(),
        type: (typeMatch && typeMatch[1]) || (tag === 'select' ? 'select-one' : 'text'),
        value: tag === 'textarea' ? decodeHtml(content) : decodeHtml((selectedMatch && selectedMatch[1]) || (valueMatch && valueMatch[1]) || ''),
        checked: /\bchecked\b/i.test(attrs),
        getAttribute(name) {
          const wanted = String(name || '');
          if (wanted === 'data-dealer-field' && field[1] === 'dealer') return field[2];
          if (wanted === 'data-stage-field' && field[1] === 'stage') return field[2];
          return null;
        },
        insertAdjacentHTML(position, value) { if (position === 'beforeend') html += String(value || ''); }
      };
      elements.push(element);
    }
  };
  const root = {
    get innerHTML() { return html; },
    set innerHTML(value) { html = String(value || ''); parse(); },
    addEventListener(type, handler) { handlers[type] = handler; },
    contains() { return true; },
    querySelector(selector) {
      const field = selector.match(/^\[data-(dealer|stage)-field="([^"]+)"\]$/);
      if (field) return elements.find(element => element.getAttribute('data-' + field[1] + '-field') === field[2]) || null;
      if (selector === '.dealer-production-local') return /dealer-production-local/.test(html) ? { } : null;
      if (selector === '.dealer-production-detail') return /dealer-production-detail/.test(html) ? { } : null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-stage-field]') return elements.filter(element => element.getAttribute('data-stage-field'));
      if (selector === '[data-dealer-field]') return elements.filter(element => element.getAttribute('data-dealer-field'));
      return [];
    },
    setField(kind, name, value) {
      const element = this.querySelector('[data-' + kind + '-field="' + name + '"]');
      if (!element) throw new Error('missing browser field ' + kind + '/' + name);
      if (element.type === 'checkbox') element.checked = value === true || String(value).toLowerCase() === 'true';
      else element.value = String(value);
      return element;
    },
    async clickAction(action, attributes) {
      const values = attributes || {};
      const target = {
        getAttribute(name) { return name === 'data-action' ? action : (Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : null); },
        hasAttribute() { return false; },
        closest() { return this; }
      };
      if (typeof handlers.click === 'function') return handlers.click({ target });
      return undefined;
    }
  };
  return root;
}

function response(candidate) {
  return {
    ok: true,
    client_protocol: 2,
    schema_version: 1,
    result: { candidate: Object.assign({ id: 'candidate-1', version: 2 }, candidate || {}), revisions: { 'candidate-1': 2 } }
  };
}

test('production presentation is isolated from the local pilot and exposes every typed journey action', () => {
  assert.ok(DealerProductionUI);
  assert.deepEqual(DealerProductionUI.COMMANDS, [
    'create_candidate', 'update_candidate', 'add_evidence', 'create_plan',
    'approve_buy', 'acquire_copy', 'link_copy', 'set_asking',
    'prepare_listing', 'record_sale', 'settle_sale', 'record_non_sale',
    'review_outcome'
  ]);
  assert.doesNotMatch(SOURCE, /\bmarkDirty\b|\bDB\s*\[/);
  assert.doesNotMatch(SOURCE, /synthetic pilot|local synthetic/i);
  assert.match(SOURCE, /Draft on this device/);
  assert.match(SOURCE, /Showing the last server-confirmed snapshot/);
  assert.match(SOURCE, /data-navigate-page/);
  assert.match(SOURCE, /const page = type === 'inventory' \? \(String\(ref\.table\)/);
  assert.match(SOURCE, /Acquire new server-created inventory copy/);
  assert.match(SOURCE, /expectedSaleAmount/);
  assert.match(SOURCE, /Pending server decisions/);
  assert.match(SOURCE, /Confirm reviewed cost once/);
  assert.match(SOURCE, /inventory_sync_required/);
  assert.match(SOURCE, /grader: 'Grader'/);
  assert.match(SOURCE, /certificateNumber: 'Certificate number'/);
  assert.match(SOURCE, /slab_identity_required/);
  assert.match(SOURCE, /kjrDealerRefreshCore/);
  assert.doesNotMatch(SOURCE, /Inventory row id|Sale row id/);
  assert.doesNotMatch(SOURCE, /Existing listing ID/);
  assert.doesNotMatch(SOURCE, /input\('listingId'/);
  assert.match(SOURCE, /limit: 50/);
  assert.equal(DealerProductionUI.safeHttpUrl('https://example.test/path'), 'https://example.test/path');
  assert.equal(DealerProductionUI.safeHttpUrl('javascript:alert(1)'), null);
  assert.match(DealerProductionUI.manualReferenceMarkup('receipt-1', 'Evidence'), /receipt-1/);
  assert.doesNotMatch(DealerProductionUI.manualReferenceMarkup('javascript:alert(1)', 'Evidence'), /href=/);
});

test('production presentation preserves exact copy and sale link payloads', () => {
  const record = {
    id: 'candidate-1',
    row_version: 7,
    __dealerDetail: {
      copy: [{ id: 'copy-1', row_version: 4 }],
      outcomes: [{ id: 'outcome-1', row_version: 2, saleRowVersion: 1 }]
    },
    __dealerCanonicalRefs: [{ inventoryTable: 'slabs', inventoryId: 'slab-44', canonicalRowVersion: 4, saleId: 'sale-9' }]
  };
  const fields = { inventoryTable: 'slabs', inventoryId: 'slab-44', inventoryVersion: '4', copyCost: '20.00', copyCurrency: 'SGD', nonItemAcquisitionCosts: '0.00', copyCostReason: 'Reviewed receipt', copyCostDate: '25/09/2026', saleAmount: '120.00', saleDate: '25/09/2026', currency: 'SGD' };
  assert.deepEqual(DealerProductionUI.expectedVersions(record), { candidate: 7, copy: 4, outcome: 2, canonical: 4, sale: 1 });
  assert.deepEqual(DealerProductionUI.stagePayload('link_copy', record, fields), {
    candidateId: 'candidate-1', inventoryTable: 'slabs', inventoryId: 'slab-44',
    reviewedCost: { confirmed: true, currency: 'SGD', itemCost: '20.00', reason: 'Reviewed receipt', reviewedAt: '2026-09-25T00:00:00+08:00', nonItemAcquisitionCosts: '0.00' }, cost: '20.00'
  });
  assert.deepEqual(DealerProductionUI.stagePayload('record_sale', record, fields), {
    candidateId: 'candidate-1', copyId: 'copy-1', saleId: null, outcomeId: null,
    sale: { agreedAmount: '120.00', currency: 'SGD', soldAt: '2026-09-25T00:00:00+08:00' },
    agreedAmount: '120.00', currency: 'SGD', soldAt: '2026-09-25T00:00:00+08:00'
  });
  assert.deepEqual(DealerProductionUI.stagePayload('link_copy', record, {
    inventoryTable: 'singles', inventoryId: 'single-9', copyCost: '1500', copyCurrency: 'JPY', nonItemAcquisitionCosts: '100', copyCostReason: 'Reviewed foreign receipt', copyCostDate: '25/09/2026', settledCopyCost: '13.65', settledNonItemAcquisitionCosts: '0.91', settledAmount: '14.56',
    fxDirection: 'JPY_SGD', fxRate: '0.0091', fxSource: 'receipt-44', fxAt: '2026-09-25T12:00:00+08:00'
  }), {
    candidateId: 'candidate-1', inventoryTable: 'singles', inventoryId: 'single-9',
    reviewedCost: {
      confirmed: true, currency: 'JPY', itemCost: '1500', fxDirection: 'JPY_SGD',
      fxRate: '0.0091', fxSource: 'receipt-44', fxAt: '2026-09-25T12:00:00+08:00', reason: 'Reviewed foreign receipt', reviewedAt: '2026-09-25T00:00:00+08:00', nonItemAcquisitionCosts: '100', settledItemCost: '13.65', settledNonItemAcquisitionCosts: '0.91', settledAmount: '14.56', settledCurrency: 'SGD'
    }, cost: '1500'
  });
});

test('buy plan revisions carry the frozen superseded plan and fresh scenario fields', () => {
  const record = {
    id: 'candidate-revision',
    __dealerDetail: {
      plans: [{ id: 'plan-old', row_version: 4, status: 'approved', data: { expected: { saleAmount: 100 } } }]
    }
  };
  const fields = {
    planReason: 'Fresh market evidence', expectedSaleAmount: '120', expectedSellingFee: '8', expectedOutboundShipping: '5',
    expectedRefundAllowance: '0', otherExpectedDeductions: '0', targetContribution: '20', targetMargin: '0', riskAllowance: '0',
    knownNonItemAcquisitionCosts: '2', plannedItemCost: '70', conditionScenario: 'raw near mint', reportingCurrency: 'SGD',
    revisionReason: 'Updated sale evidence', supersedesPlanId: 'plan-old'
  };
  const revised = DealerProductionUI.stagePayload('create_plan', record, fields);
  assert.equal(revised.revisionReason, 'Updated sale evidence');
  assert.equal(revised.supersedesPlanId, 'plan-old');
  assert.equal(revised.plan.conditionScenario, 'raw near mint');

  record.__dealerDetail.plans.push({ id: 'plan-new', row_version: 1, status: 'draft', supersedesPlanId: 'plan-old', data: { supersedesPlanId: 'plan-old' } });
  const approval = DealerProductionUI.stagePayload('approve_buy', record, fields);
  assert.equal(approval.planId, 'plan-new');
  assert.equal(approval.supersedesPlanId, 'plan-old');
});

test('fake transport can confirm the complete typed journey without local promotion', async () => {
  const context = ownerContext();
  const commands = [];
  const store = DealerStore.create({
    ownerContext: () => context,
    storage: null,
    transport: {
      pull: async () => ({ ok: true, client_protocol: 2, schema_version: 1, candidates: [{ id: 'candidate-1', name: 'Fixture candidate', version: 1 }], selected_candidate: { id: 'candidate-1', name: 'Fixture candidate', version: 1 }, next_cursor: null }),
      command: async request => {
        commands.push(JSON.parse(JSON.stringify(request.body)));
        return response({
          id: request.body.command === 'create_candidate' ? 'candidate-1' : 'candidate-1',
          inventoryRef: request.body.command === 'link_copy' ? { table: 'singles', id: 'single-9' } : undefined,
          saleRef: request.body.command === 'record_sale' ? { table: 'sales', id: 'sale-9' } : undefined,
          settlement: request.body.command === 'settle_sale' ? { status: 'confirmed' } : undefined
        });
      }
    }
  });
  await store.pull();
  const record = { id: 'candidate-1', candidateVersion: 1 };
  const fields = { evidenceRef: 'receipt-1', planReason: 'Evidence-backed buy', inventoryTable: 'singles', inventoryId: 'single-9', askingAmount: '150', currency: 'SGD', saleId: 'sale-9', saleAmount: '140', settlementRef: 'settlement-9', nonSaleReason: 'Held', outcomeNotes: 'Reviewed' };
  for (const [index, command] of DealerProductionUI.COMMANDS.entries()) {
    const payload = command === 'create_candidate'
      ? { candidate: { name: 'Fixture candidate' } }
      : command === 'update_candidate'
        ? { candidateId: record.id, candidate: { name: 'Fixture candidate' } }
        : DealerProductionUI.stagePayload(command, record, fields);
    const result = await store.command(command, payload, { commandId: '00000000-0000-4000-8000-' + String(100 + index).padStart(12, '0'), expectedVersions: { candidate: 1 } });
    assert.equal(result.ok, true, command);
  }
  assert.deepEqual(commands.map(item => item.command), DealerProductionUI.COMMANDS);
  assert.equal(store.view().pending && Object.keys(store.view().pending).length, 0);
});

test('controller follows a six-stage fake journey and auto-selects a newly confirmed candidate', async () => {
  const context = ownerContext();
  const commands = [];
  const refreshes = [];
  let created = false;
  let candidateVersion = 1;
  let plan = null;
  let copy = null;
  let listing = null;
  let outcome = null;
  const candidateFields = new Map([
    ['name', 'Controller candidate'], ['set', 'Demo set'], ['number', '001'], ['language', 'EN'], ['variant', 'Normal'],
    ['condition', 'Near mint'], ['conditionCertainty', 'confirmed'], ['conditionScenario', 'raw near mint'], ['format', 'raw'], ['gradeCertainty', 'uncertain'], ['ownership', 'Business'], ['ownershipReviewed', 'true'], ['source', 'Reviewed source'], ['notes', 'Long controller journey note']
  ]);
  const stageValues = new Map([
    ['evidenceClass', 'identity'], ['evidenceRef', 'https://example.test/receipt/1'], ['evidenceMatch', 'confirmed'], ['evidenceConfidence', 'high'], ['evidenceRationale', 'Fixture evidence'], ['evidenceDate', '25/09/2026'],
    ['planReason', 'Evidence-backed buy'], ['expectedSaleAmount', '150.00'], ['expectedSellingFee', '10.00'], ['expectedOutboundShipping', '5.00'], ['expectedRefundAllowance', '0'], ['otherExpectedDeductions', '0'], ['targetContribution', '20.00'], ['targetMargin', '0'], ['riskAllowance', '0'], ['knownNonItemAcquisitionCosts', '0'], ['plannedItemCost', '20.00'], ['conditionScenario', 'raw near mint'], ['reportingCurrency', 'SGD'], ['copyMode', 'new'],
    ['acquisitionTable', 'singles'], ['inventoryRef', 'singles::single-9'], ['copyCost', '20.00'], ['copyCurrency', 'SGD'], ['nonItemAcquisitionCosts', '0'], ['copyCostReason', 'Reviewed fixture receipt'], ['copyCostDate', '25/09/2026'], ['inheritCost', 'true'],
    ['platform', 'Fixture marketplace'], ['channel', 'Online'], ['listingId', ''], ['listingNotes', 'Fixture listing'], ['askingAmount', '150.00'], ['currency', 'SGD'], ['saleAmount', '140.00'], ['saleDate', '25/09/2026'], ['settlementRef', 'receipt-9'],
    ['settlementDate', '25/09/2026'], ['proceeds', '140.00'], ['sellingFee', '10.00'], ['outboundShipping', '5.00'],
    ['nonSaleReason', 'Held'], ['outcomeNotes', 'Reviewed after settlement'], ['reviewCause', 'Outcome reviewed'], ['restockDecision', 'restock'], ['restockDate', '25/09/2026'], ['reviewNotes', 'Reviewed after settlement']
  ]);
  const candidateElement = name => ({ value: candidateFields.get(name) || '', getAttribute() { return name; } });
  const stageElement = name => ({
    type: name === 'inheritCost' ? 'checkbox' : 'text',
    checked: name === 'inheritCost',
    value: stageValues.get(name) || '',
    getAttribute() { return name; }
  });
  const root = {
    innerHTML: '',
    addEventListener() {},
    contains() { return true; },
    querySelector(selector) {
      const candidateMatch = selector.match(/data-dealer-field="([^"]+)"/);
      if (candidateMatch) return candidateElement(candidateMatch[1]);
      const stageMatch = selector.match(/data-stage-field="([^"]+)"/);
      if (stageMatch) return stageElement(stageMatch[1]);
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[data-stage-field]') return Array.from(stageValues.keys()).map(stageElement);
      return [];
    }
  };
  globalThis.kjrDealerInventorySummaries = () => ({
    ok: true,
    rows: [{ table: 'singles', tableLabel: 'Singles', id: 'single-9', label: 'Singles · Demo set · 001', version: 2, cost: '20.00', currency: 'SGD' }]
  });
  globalThis.kjrDealerRefreshCore = async details => { refreshes.push(details.command); return { ok: true }; };

  function candidate() {
    return { id: 'candidate-1', entity_type: 'candidate', candidateId: 'candidate-1', state: 'Acquired', data: Object.assign({}, Object.fromEntries(candidateFields), { name: 'Controller candidate', ownership: 'Business', status: 'Acquired' }), row_version: candidateVersion };
  }

  function pullResponse(candidateId) {
    const row = candidate();
    return {
      ok: true,
      client_protocol: 2,
      schema_version: 1,
      candidates: created ? [row] : [],
      selected: candidateId && created ? { candidate: row, plans: plan ? [plan] : [], evidence: [{ id: 'evidence-1', row_version: 1 }], copy: copy ? [copy] : [], listings: listing ? [listing] : [], outcomes: outcome ? [outcome] : [], reviews: [], readiness: {} } : null,
      canonicalRefs: copy ? [{ copyId: 'copy-1', inventoryTable: 'singles', inventoryId: 'single-9', canonicalRowVersion: outcome ? 3 : 2, saleId: outcome ? 'sale-1' : null, row_version: 1 }] : [],
      nextCursor: null
    };
  }

  const store = DealerStore.create({
    ownerContext: () => context,
    storage: null,
    transport: {
      pull: async request => pullResponse(request.body.candidateId),
      command: async request => {
        commands.push(request.body);
        const command = request.body.command;
        if (command === 'create_candidate') created = true;
        if (command === 'create_plan') plan = { id: 'plan-1', row_version: 1, data: { status: 'draft' } };
        if (command === 'approve_buy') { plan = { id: 'plan-1', row_version: 2, data: { status: 'approved' } }; candidateVersion += 1; }
        if (command === 'acquire_copy') { copy = { id: 'copy-1', row_version: 1, data: { itemRef: { table: 'singles', id: 'single-9' }, costComponent: { settledAmount: '20.00' } } }; candidateVersion += 1; }
        if (command === 'set_asking') listing = { id: 'listing-1', row_version: 1, data: { status: 'asking_set' } };
        if (command === 'prepare_listing') listing = { id: 'listing-1', row_version: 2, data: { status: 'prepared' } };
        if (command === 'record_sale') { outcome = { id: 'outcome-1', row_version: 1, data: { saleId: 'sale-1', paymentStatus: 'Unknown' } }; candidateVersion += 1; }
        if (command === 'settle_sale') outcome = { id: 'outcome-1', row_version: 2, data: { saleId: 'sale-1', paymentStatus: 'Settled' } };
        if (command === 'review_outcome') outcome = { id: 'outcome-1', row_version: 2, data: { saleId: 'sale-1', paymentStatus: 'Settled' } };
        return { ok: true, client_protocol: 2, schema_version: 1, command_id: request.body.command_id, result: { candidate: candidate() }, revisions: [] };
      }
    }
  });
  const controller = DealerProductionUI.createController({ root, store });
  try {
    await controller.mount();
    assert.equal(controller.state.selectedId, '');
    await controller.performCommand('create_candidate');
    assert.equal(controller.state.selectedId, 'candidate-1');
    for (const command of ['add_evidence', 'create_plan', 'approve_buy', 'acquire_copy', 'set_asking', 'prepare_listing', 'record_sale', 'settle_sale', 'review_outcome']) {
      await controller.performCommand(command);
    }
    assert.deepEqual(commands.map(request => request.command), [
      'create_candidate', 'add_evidence', 'create_plan', 'approve_buy', 'acquire_copy',
      'set_asking', 'prepare_listing', 'record_sale', 'settle_sale', 'review_outcome'
    ]);
    assert.deepEqual(refreshes, ['acquire_copy', 'record_sale', 'settle_sale']);
    assert.deepEqual(commands.find(request => request.command === 'acquire_copy').payload.reviewedCost, { confirmed: true, currency: 'SGD', itemCost: '20.00', nonItemAcquisitionCosts: '0', reason: 'Reviewed fixture receipt', reviewedAt: '2026-09-25T00:00:00+08:00' });
    const settlementPayload = commands.find(request => request.command === 'settle_sale').payload;
    assert.equal(settlementPayload.cashSettledAt, '2026-09-25T00:00:00+08:00');
    assert.deepEqual(settlementPayload.settlementEvidence, { class: 'manual', reference: 'receipt-9', note: 'Reviewed after settlement', date: '2026-09-25T00:00:00+08:00' });
    assert.equal(store.view().pending && Object.keys(store.view().pending).length, 0);
  } finally {
    delete globalThis.kjrDealerInventorySummaries;
    delete globalThis.kjrDealerRefreshCore;
  }
});

test('browser-shaped render preserves create inputs and New draft creates a distinct second candidate', async () => {
  const context = ownerContext();
  const root = browserLikeRoot();
  const records = [];
  let nextId = 0;
  const details = () => ({ plans: [], evidence: [], copy: [], listings: [], outcomes: [], reviews: [], readiness: {} });
  const transport = {
    pull: async request => {
      const selected = records.find(record => !request.candidateId || String(record.id) === String(request.candidateId)) || null;
      return {
        ok: true,
        client_protocol: 2,
        schema_version: 1,
        candidates: records.map(record => JSON.parse(JSON.stringify(record))),
        selected: selected ? { candidate: JSON.parse(JSON.stringify(selected)), ...details() } : null,
        next_cursor: null
      };
    },
    command: async request => {
      const payload = request.body.payload || {};
      let record;
      if (request.body.command === 'create_candidate') {
        nextId += 1;
        record = { id: 'candidate-created-' + nextId, row_version: 1, data: Object.assign({}, payload) };
        records.unshift(record);
      } else {
        record = records.find(item => String(item.id) === String(payload.candidateId));
        record.data = Object.assign({}, record.data, payload.patch || {});
        record.row_version += 1;
      }
      return { ok: true, client_protocol: 2, schema_version: 1, result: { candidate: JSON.parse(JSON.stringify(record)) } };
    }
  };
  const store = DealerStore.create({ ownerContext: () => context, storage: null, transport });
  const controller = DealerProductionUI.createController({ root, store });
  await controller.mount();

  const fillCandidate = (name, set) => {
    root.setField('dealer', 'name', name);
    root.setField('dealer', 'set', set);
    root.setField('dealer', 'number', '009');
    root.setField('dealer', 'language', 'EN');
    root.setField('dealer', 'condition', 'Near mint');
    root.setField('dealer', 'ownershipReviewed', true);
  };
  fillCandidate('Browser candidate one', 'Browser set one');
  root.setField('stage', 'expectedSaleAmount', '35');
  root.setField('stage', 'planReason', 'Browser plan retained after candidate save');
  root.setField('stage', 'saleAmount', '35');
  await controller.performCommand('create_candidate');
  assert.equal(controller.state.selectedId, 'candidate-created-1');
  assert.equal(root.querySelector('[data-dealer-field="name"]').value, 'Browser candidate one');
  assert.equal(root.querySelector('[data-dealer-field="set"]').value, 'Browser set one');
  assert.equal(root.querySelector('[data-stage-field="expectedSaleAmount"]').value, '35');
  assert.equal(root.querySelector('[data-stage-field="planReason"]').value, 'Browser plan retained after candidate save');

  await root.clickAction('new-candidate');
  assert.equal(controller.state.selectedId, '');
  assert.match(root.innerHTML, /data-command="create_candidate"/);
  fillCandidate('Browser candidate two', 'Browser set two');
  await controller.performCommand('create_candidate');
  assert.equal(controller.state.selectedId, 'candidate-created-2');
  assert.equal(root.querySelector('[data-dealer-field="name"]').value, 'Browser candidate two');
  assert.equal(root.querySelector('[data-dealer-field="set"]').value, 'Browser set two');
  assert.deepEqual(records.map(record => record.data.name), ['Browser candidate two', 'Browser candidate one']);
});

test('browser retry promotes the retained new-candidate draft to its confirmed id', async () => {
  const context = ownerContext();
  const root = browserLikeRoot();
  let candidate = null;
  const commandBodies = [];
  const transport = {
    pull: async request => ({
      ok: true,
      client_protocol: 2,
      schema_version: 1,
      candidates: candidate ? [JSON.parse(JSON.stringify(candidate))] : [],
      selected: candidate && request.candidateId ? { candidate: JSON.parse(JSON.stringify(candidate)), plans: [], evidence: [], copy: [], listings: [], outcomes: [], reviews: [], readiness: {} } : null,
      next_cursor: null
    }),
    command: async request => {
      commandBodies.push(JSON.parse(JSON.stringify(request.body)));
      if (commandBodies.length === 1) {
        return { ok: false, client_protocol: 2, schema_version: 1, error: { code: 'sync_upstream_unavailable', message: 'Synthetic response lost after commit' } };
      }
      candidate = { id: 'candidate-retried-1', row_version: 1, data: Object.assign({}, request.body.payload) };
      return { ok: true, client_protocol: 2, schema_version: 1, result: { candidate: JSON.parse(JSON.stringify(candidate)) } };
    }
  };
  const store = DealerStore.create({ ownerContext: () => context, storage: null, transport });
  const controller = DealerProductionUI.createController({ root, store });
  await controller.mount();
  root.setField('dealer', 'name', 'Retry candidate');
  root.setField('dealer', 'set', 'Retry set');
  root.setField('dealer', 'number', '009');
  root.setField('dealer', 'language', 'EN');
  root.setField('dealer', 'condition', 'Near mint');
  root.setField('dealer', 'ownershipReviewed', true);
  root.setField('stage', 'expectedSaleAmount', '35');
  await controller.performCommand('create_candidate');
  assert.equal(controller.state.selectedId, '');
  assert.match(root.innerHTML, /Response unknown/);
  const commandId = Object.keys(store.view().pending)[0];
  assert.ok(commandId);
  await root.clickAction('retry', { 'data-command-id': commandId });
  assert.equal(controller.state.selectedId, 'candidate-retried-1');
  assert.equal(root.querySelector('[data-dealer-field="name"]').value, 'Retry candidate');
  assert.equal(root.querySelector('[data-stage-field="expectedSaleAmount"]').value, '35');
  assert.match(root.innerHTML, /Draft on this device/);
  assert.equal(commandBodies.length, 2);
  assert.equal(commandBodies[0].command_id, commandBodies[1].command_id);
  assert.deepEqual(commandBodies[0].payload, commandBodies[1].payload);
});

test('production stage controls explain and gate unconfirmed prerequisites', async () => {
  const record = { id: 'candidate-gate', name: 'Gate candidate', set: 'Gate set', number: '001', language: 'EN', condition: 'Near mint', ownership: 'Business', ownershipReviewed: true };
  const snapshot = {
    candidates: [record],
    selectedCandidate: record,
    selectedDetail: { candidate: record, plans: [], evidence: [], copy: [], listings: [], outcomes: [], reviews: [], readiness: { ready: false, blockers: ['evidence_required'] } },
    canonicalRefs: [],
    nextCursor: null
  };
  let current = { ok: true, ownerId: 'ui-owner', online: true, stale: false, snapshot, drafts: { new: { fields: { name: 'Previous scenario draft' }, stage: { expectedSaleAmount: '999' } } }, pending: {} };
  const root = browserLikeRoot();
  const store = {
    view: () => current,
    init: async () => current,
    pull: async () => ({ ok: true, status: 'confirmed', snapshot })
  };
  const controller = DealerProductionUI.createController({ root, store });
  await controller.mount();
  assert.equal(root.querySelector('[data-dealer-field="name"]').value, 'Gate candidate', 'a selected server candidate must not inherit the owner new-draft form');
  assert.match(root.innerHTML, /data-command="add_evidence"/);
  assert.match(root.innerHTML, /data-command="create_plan" disabled/);
  assert.match(root.innerHTML, /Add confirmed evidence before creating the buy plan/);
  assert.match(root.innerHTML, /data-command="approve_buy" disabled/);
  assert.match(root.innerHTML, /data-command="acquire_copy" disabled/);
  assert.match(root.innerHTML, /data-command="record_sale" disabled/);
  assert.match(root.innerHTML, /Acquire or link a server-confirmed copy before recording a sale/);
  assert.match(root.innerHTML, /data-command="review_outcome" disabled/);
  snapshot.selectedDetail.copy = [{ id: 'copy-gate', row_version: 1 }];
  controller.render();
  assert.match(root.innerHTML, /Prepare the listing before recording a sale/);
  assert.equal(controller.state.selectedId, 'candidate-gate');
});

test('confirmed buy plan renders server economics and keeps missing values Unknown', async () => {
  const record = { id: 'candidate-money', name: 'Money candidate', set: 'Money set', number: '001', language: 'EN', condition: 'Near mint', format: 'raw', ownership: 'Business', ownershipReviewed: true };
  const snapshot = {
    candidates: [record], selectedCandidate: record,
    selectedDetail: {
      candidate: record,
      plans: [{ id: 'plan-money', row_version: 2, status: 'approved', data: {
        reportingCurrency: 'SGD', expected: {
          saleAmount: 150, expectedNetProceeds: 135, maximumAllInAcquisitionCostRounded: 115,
          itemPriceCeiling: 115, plannedContribution: 115, targetContribution: 20
        },
        plannedItemCost: { status: 'Known', amount: 20, currency: 'SGD' },
        plannedLandedCost: { status: 'Known', amount: 20, currency: 'SGD' }
      } }],
      evidence: [], copy: [], listings: [], outcomes: [], reviews: [], readiness: { ready: true, blockers: [] }
    }, canonicalRefs: [], nextCursor: null
  };
  const current = { ok: true, ownerId: 'ui-owner', online: true, stale: false, snapshot, drafts: {}, pending: {} };
  const root = browserLikeRoot();
  const store = { view: () => current, init: async () => current, pull: async () => ({ ok: true, status: 'confirmed', snapshot }) };
  const controller = DealerProductionUI.createController({ root, store });
  await controller.mount();
  assert.match(root.innerHTML, /Expected net proceeds/);
  assert.match(root.innerHTML, /135\.00/);
  assert.match(root.innerHTML, /Maximum all-in acquisition cost/);
  assert.match(root.innerHTML, /Buy-plan readiness/);
  snapshot.selectedDetail.plans[0].data.expected.expectedNetProceeds = null;
  controller.render();
  assert.match(root.innerHTML, /Expected net proceeds<\/dt><dd>Unknown/);
  assert.doesNotMatch(root.innerHTML, /Expected net proceeds<\/dt><dd>[^<]*0\.00/);
});

test('conflicting local drafts are visible and can be explicitly restored', async () => {
  const record = { id: 'candidate-conflict', name: 'Server candidate', set: 'Set', number: '001', language: 'EN', condition: 'Near mint', format: 'raw', ownership: 'Business', ownershipReviewed: true };
  const snapshot = { candidates: [record], selectedCandidate: record, selectedDetail: { candidate: record, plans: [], evidence: [], copy: [], listings: [], outcomes: [], reviews: [], readiness: {} }, canonicalRefs: [], nextCursor: null };
  const current = { ok: true, ownerId: 'ui-owner', online: true, stale: false, snapshot, drafts: { 'candidate-conflict': { ownerId: 'ui-owner', localOnly: true, fields: { name: 'Current local version' }, stage: {}, conflicts: [{ ownerId: 'ui-owner', localOnly: true, fields: { name: 'Alternate local version' }, stage: {} }] } }, pending: {} };
  const root = browserLikeRoot();
  let restored = null;
  const store = {
    view: () => current,
    init: async () => current,
    pull: async () => ({ ok: true, status: 'confirmed', snapshot }),
    restoreDraft: (id, index) => {
      restored = { id, index };
      current.drafts[id].fields = { name: index === 0 ? 'Alternate local version' : 'Current local version' };
      current.drafts[id].conflictChoice = index === 0 ? 'alternate' : 'current';
      return { ok: true, status: 'draft_restored', draft: current.drafts[id] };
    }
  };
  const controller = DealerProductionUI.createController({ root, store });
  await controller.mount();
  assert.match(root.innerHTML, /Draft versions need your choice/);
  assert.match(root.innerHTML, /Alternate local version/);
  await root.clickAction('restore-draft', { 'data-variant-index': 0 });
  assert.deepEqual(restored, { id: 'candidate-conflict', index: 0 });
  assert.match(root.innerHTML, /Choice saved locally/);
});

test('slab acquisition exposes and validates server-required identity fields', async () => {
  const record = { id: 'candidate-slab', name: 'Slab candidate', set: 'Slab set', number: '044', language: 'EN', condition: 'Graded', format: 'slab', ownership: 'Business', ownershipReviewed: true };
  const snapshot = {
    candidates: [record],
    selectedCandidate: record,
    selectedDetail: {
      candidate: record,
      plans: [{ id: 'plan-slab', row_version: 2, status: 'approved' }],
      evidence: [{ id: 'evidence-slab', row_version: 1 }],
      copy: [], listings: [], outcomes: [], reviews: [], readiness: { ready: true }
    },
    canonicalRefs: [], nextCursor: null
  };
  let current = { ok: true, ownerId: 'ui-owner', online: true, stale: false, snapshot, drafts: {}, pending: {} };
  const commands = [];
  const root = browserLikeRoot();
  const store = {
    view: () => current,
    init: async () => current,
    pull: async () => ({ ok: true, status: 'confirmed', snapshot }),
    command: async (command, payload, options) => {
      commands.push({ command, payload, options });
      return { ok: true, client_protocol: 2, schema_version: 1, result: { candidate: record } };
    },
    saveDraft() {}
  };
  const controller = DealerProductionUI.createController({ root, store });
  await controller.mount();
  assert.match(root.innerHTML, /data-dealer-field="grader"/);
  assert.match(root.innerHTML, /data-dealer-field="grade"/);
  assert.match(root.innerHTML, /data-dealer-field="certificateNumber"/);
  root.setField('stage', 'acquisitionTable', 'slabs');
  root.setField('stage', 'copyMode', 'new');
  root.setField('stage', 'copyCost', '90');
  root.setField('stage', 'copyCurrency', 'SGD');
  root.setField('stage', 'nonItemAcquisitionCosts', '0');
  root.setField('stage', 'copyCostReason', 'Reviewed slab receipt');
  root.setField('stage', 'copyCostDate', '26/09/2026');
  root.setField('stage', 'inheritCost', true);
  await controller.performCommand('acquire_copy');
  assert.equal(commands.length, 0, 'the UI must not send a slab acquisition without identity fields');
  assert.match(root.innerHTML, /Enter the slab grader, grade, and certificate number/);

  record.grader = 'PSA';
  record.grade = '10';
  record.gradeCertainty = 'verified';
  record.certificateNumber = 'FIXTURE-SLAB-44';
  root.setField('dealer', 'grader', 'PSA');
  root.setField('dealer', 'grade', '10');
  root.setField('dealer', 'gradeCertainty', 'verified');
  root.setField('dealer', 'certificateNumber', 'FIXTURE-SLAB-44');
  await controller.performCommand('acquire_copy');
  assert.equal(commands.length, 1);
  assert.equal(commands[0].command, 'acquire_copy');
  assert.equal(commands[0].payload.inventoryTable, 'slabs');
});

test('production page shows an owner gate when the app facade has no verified session', async () => {
  const root = {
    innerHTML: '',
    addEventListener() {},
    contains() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const controller = DealerProductionUI.createController({
    root,
    store: {
      view: () => ({ online: true, snapshot: null, drafts: {}, pending: {} }),
      init: async () => { const error = new Error('Dealer Desk needs a verified owner session'); error.code = 'owner_session_required'; throw error; }
    }
  });
  assert.equal(await controller.mount(), false);
  assert.match(root.innerHTML, /Dealer Desk unavailable|verified owner session/);
});

test('owner invalidation clears rendered Dealer data and stage state', async () => {
  let currentView = {
    ok: true,
    ownerId: 'owner-a',
    online: true,
    stale: false,
    snapshot: {
      candidates: [{ id: 'candidate-a', name: 'Owner A private candidate', version: 1 }],
      selectedCandidate: { id: 'candidate-a', name: 'Owner A private candidate', version: 1 },
      selectedDetail: null,
      nextCursor: null
    },
    drafts: {}, pending: {}
  };
  let listener = null;
  const root = {
    innerHTML: '',
    addEventListener() {},
    contains() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const store = {
    view: () => currentView,
    subscribe: callback => { listener = callback; return () => { listener = null; }; },
    init: async () => currentView,
    pull: async () => ({ ok: true, status: 'confirmed', snapshot: currentView.snapshot })
  };
  const controller = DealerProductionUI.createController({ root, store });
  await controller.mount();
  assert.match(root.innerHTML, /Owner A private candidate/);
  controller.state.formDraft = { fields: { name: 'Owner A private candidate' }, stage: { saleAmount: '100' } };
  currentView = { ok: false, ownerId: 'owner-a', online: false, snapshot: null, drafts: {}, pending: {} };
  listener(currentView);
  assert.doesNotMatch(root.innerHTML, /Owner A private candidate|saleAmount|100/);
  assert.match(root.innerHTML, /Dealer Desk unavailable/);
  assert.equal(controller.state.selectedId, '');
  assert.equal(controller.state.formDraft, null);
});
