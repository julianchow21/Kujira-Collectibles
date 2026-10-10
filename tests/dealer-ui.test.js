'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ROOT } = require('./harness.js');

const UI_SOURCE = fs.readFileSync(ROOT + '/dealer-ui.js', 'utf8');

function makeDealerUiRuntime(getState, recover, resetSyntheticPilot) {
  const listeners = new Map();
  const retry = {
    disabled: false,
    textContent: '',
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    },
  };
  const reset = { addEventListener() {} };
  const dealerRoot = {
    innerHTML: '',
    querySelector(selector) {
      if (selector === '#dealer-retry') return retry;
      if (selector === '#dealer-reset-synthetic') return reset;
      return null;
    },
  };
  const elements = new Map([['dealer-root', dealerRoot]]);
  const document = {
    getElementById(id) { return elements.get(id) || null; },
    addEventListener() {},
  };
  const storageWrites = [];
  const storage = {
    value: 'dealer-storage-before-recovery',
    getItem() { return this.value; },
    setItem(key, value) { storageWrites.push({ key, value }); this.value = String(value); },
    removeItem(key) { storageWrites.push({ key, removed: true }); this.value = null; },
  };
  const sandbox = {
    document,
    location: { protocol: 'http:', hostname: '127.0.0.1' },
    localStorage: storage,
    DealerDesk: {
      isLocalPreview() { return true; },
      getState,
      recover,
    },
    __KJR_DEALER_PREVIEW__: true,
    __KJR_DEALER_PREVIEW_RESET__: resetSyntheticPilot,
    console,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(UI_SOURCE, sandbox, { filename: 'dealer-ui.js' });
  return { sandbox, dealerRoot, retry, listeners, storage, storageWrites };
}

test('Dealer UI keeps Release 0 money and identity decisions explicit', () => {
  const src = UI_SOURCE;
  const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
  for (const anchor of [
    'Frozen plan reason',
    'Planned item cost (SGD)',
    'Acquire synthetic Business copy',
    'Link existing exact copy',
    'Reset synthetic pilot state',
    'Validate and restore',
    'reviewOutcome',
    'candidateVersion',
    'expectedRevision',
    'ownerId',
    'requestId',
    'plannedItemCost: plannedMoney',
    'captureFormDraft',
    'restoreFormDraft',
    'disclosureKey',
    'dealer-technical',
    'DealerMoney',
    'formatMoney',
    'formatDateDisplay',
    'Landed cost',
    'Actual contribution uses the linked, settled sale and acquisition costs.',
    'expectedVersion: candidate.version',
    'expectedCandidateVersion: candidate.version',
    'selectCreatedCandidate',
    'desk.recover',
    'await desk.recover()',
    'Recover and retry',
    'Non-item acquisition costs (same as cost currency)',
    'nonItemCurrency: currency',
    'restoreSuccessMessage',
    'Restore completed safely',
    'restoredReferences',
    'insertedReferences',
    'skippedReferences',
    'restoredCount',
    'skippedCount',
    'expectedVersion: candidate.version',
    'Difference from frozen plan',
    'Planned contribution',
    'Actual contribution against target',
    'Difference from target',
    'newCandidate',
    'Cancel new candidate',
  ]) assert.match(src, new RegExp(anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const contract of [
    /desk\.createPlan\(candidate\.id, payload, optionsFor\('plan', \{ expectedVersion: candidate\.version/,
    /desk\.approveBuy\(candidate\.id, optionsFor\('buy', \{ expectedVersion: candidate\.version/,
    /expectedCandidateVersion: candidate\.version \}/,
    /desk\.prepareListing\(candidate\.id, optionsFor\('listing', \{ expectedVersion: candidate\.version/,
    /expectedSaleVersion = outcome\.saleRef\.version/,
    /desk\.reviewOutcome\(reviewInput, optionsFor\('review', \{ expectedVersion: candidate\.version/
  ]) assert.match(src, contract);
  assert.doesNotMatch(src, /dealer-copy-version/);
  assert.doesNotMatch(src, /pretty\(plan\.expected\)/);
  assert.doesNotMatch(src, /actualContribution\s*=/);
  assert.doesNotMatch(src, /Validate and restore metadata/);
  assert.doesNotMatch(src, /The engine derives/);
  assert.doesNotMatch(src, /The UI does not calculate/);
  assert.doesNotMatch(src, /Engine-derived actual/);
  assert.doesNotMatch(src, /<pre>' \+ esc\(pretty\(ui\.pending\)\)/);
  assert.doesNotMatch(src, /draft\.details\)\.forEach\(function \(entry, index\)/);
  assert.match(src, /protocol === 'http:' \|\| protocol === 'https:'/);
  assert.doesNotMatch(src, /hostname === '0\.0\.0\.0'/);
  assert.doesNotMatch(src, /\.local\$\/\.test\(hostname\)/);
  assert.match(html, /release:\s*'kujira-collectibles@3\.69'/);
  assert.doesNotMatch(html, /release:\s*'kujira-collectibles@3\.61'/);
});

test('Dealer UI keeps stage disclosures and values after a failed non-sale action', async () => {
  const listeners = new Map();
  const fields = new Map();
  const summaries = [
    '1. Candidate identity and evidence',
    'Add source evidence',
    '2. Review economics and approve buy',
    '3. Create or link one Business physical copy',
    '4. Prepare manual listing handoff',
    '5. Record completed sale or explicit non-sale',
    '6. Review actual against the frozen plan',
    'Recovery and review',
  ];
  let details = [];
  let noSaleButton = null;
  const makeDetail = (label, open) => ({
    open,
    classList: { contains() { return false; } },
    querySelector(selector) { return selector === 'summary' ? { textContent: label } : null; },
  });
  const dealerRoot = {
    _html: '',
    set innerHTML(value) {
      this._html = value;
      const technical = value.includes('Technical details') ? [makeDetail('Technical details', false)] : [];
      const defaults = summaries.map((label, index) => makeDetail(label, index === 0));
      if (!value.includes('Technical details')) defaults[5].open = true;
      details = technical.concat(defaults);
      noSaleButton = { addEventListener(type, listener) { listeners.set(type, listener); } };
    },
    get innerHTML() { return this._html; },
    querySelector(selector) {
      if (selector === '#dealer-record-no-sale') return noSaleButton;
      return { addEventListener() {} };
    },
    querySelectorAll(selector) {
      if (selector === 'details') return details;
      if (selector === 'input[id], select[id], textarea[id]') return Array.from(fields.values());
      return [];
    },
  };
  const document = {
    getElementById(id) { return id === 'dealer-root' ? dealerRoot : fields.get(id) || null; },
    addEventListener() {},
  };
  const candidate = {
    id: 'candidate-1', version: 1, status: 'Draft',
    identity: { name: 'Synthetic card', set: 'Synthetic set', number: '001', language: 'EN', variant: 'Normal' },
    condition: { value: 'NM', certainty: 'Known', scenario: '' },
    format: 'raw', ownership: 'Business', evidenceRefs: [], asking: {},
  };
  const state = { ownerId: 'owner-1', revision: 1, candidates: [candidate], plans: [], copies: [], outcomes: [], reviews: [], listings: [] };
  const order = [];
  const desk = {
    isLocalPreview() { return true; },
    getState() { order.push('getState'); return { ok: true, state }; },
    getListingReadiness() { return { ready: false, blockers: [] }; },
    recordNoSale() { order.push('recordNoSale'); return Promise.resolve({ ok: false, code: 'copy_missing', message: 'Copy is required' }); },
  };
  const sandbox = {
    document,
    location: { protocol: 'http:', hostname: '127.0.0.1' },
    DealerDesk: desk,
    __KJR_DEALER_PREVIEW__: true,
    console,
  };
  for (const id of ['dealer-no-sale-reason', 'dealer-no-sale-date']) fields.set(id, { id, value: id.endsWith('reason') ? 'No demand' : '2026-09-23', type: 'text' });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(UI_SOURCE, sandbox, { filename: 'dealer-ui.js' });
  sandbox.renderDealerDesk();
  details.find(detail => detail.querySelector('summary').textContent.startsWith('5.')).open = true;
  const beforeStages = details.filter(detail => detail.querySelector('summary').textContent.startsWith('1.') || detail.querySelector('summary').textContent.startsWith('5.'));
  assert.deepEqual(beforeStages.map(detail => detail.open), [true, true]);
  listeners.get('click')();
  await new Promise(resolve => setImmediate(resolve));
  const afterTechnical = details.find(detail => detail.querySelector('summary').textContent === 'Technical details');
  const afterStages = details.filter(detail => detail.querySelector('summary').textContent.startsWith('1.') || detail.querySelector('summary').textContent.startsWith('5.'));
  assert.deepEqual(afterStages.map(detail => detail.open), [true, true]);
  assert.equal(afterTechnical.open, false, 'technical details stay collapsed by default');
  assert.equal(fields.get('dealer-no-sale-reason').value, 'No demand');
  assert.equal(fields.get('dealer-no-sale-date').value, '2026-09-23');
  assert.deepEqual(order, ['getState', 'recordNoSale', 'getState']);
});

test('Dealer UI new-candidate mode stays blank and selects the created row', async () => {
  const fields = new Map();
  let buttons = new Map();
  const makeButton = () => {
    const listeners = new Map();
    return {
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      listeners,
    };
  };
  const candidate = {
    id: 'candidate-existing', version: 1, status: 'Draft',
    identity: { name: 'Existing candidate', set: 'Existing set', number: '001', language: 'EN', variant: 'Normal' },
    condition: { value: 'NM', certainty: 'Known', scenario: '' },
    format: 'raw', ownership: 'Business', evidenceRefs: [], asking: {},
  };
  const created = Object.assign({}, candidate, { id: 'candidate-created', identity: Object.assign({}, candidate.identity, { name: 'New candidate' }) });
  const candidates = [candidate];
  const state = { ownerId: 'owner-1', revision: 1, candidates, plans: [], copies: [], outcomes: [], reviews: [], listings: [] };
  const dealerRoot = {
    _html: '',
    set innerHTML(value) {
      this._html = value;
      buttons = new Map();
    },
    get innerHTML() { return this._html; },
    querySelector(selector) {
      if (!buttons.has(selector)) buttons.set(selector, makeButton());
      return buttons.get(selector);
    },
    querySelectorAll() { return []; },
  };
  const document = {
    getElementById(id) { return id === 'dealer-root' ? dealerRoot : fields.get(id) || null; },
    addEventListener() {},
  };
  const desk = {
    isLocalPreview() { return true; },
    ownerId() { return 'owner-1'; },
    getState() { return { ok: true, state }; },
    getListingReadiness() { return { ready: false, blockers: [] }; },
    createCandidate(input) {
      candidates.push(created);
      state.revision += 1;
      return Promise.resolve({ ok: true, candidate: created, state, revision: state.revision });
    },
  };
  const sandbox = { document, location: { protocol: 'http:', hostname: '127.0.0.1' }, DealerDesk: desk, __KJR_DEALER_PREVIEW__: true, console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(UI_SOURCE, sandbox, { filename: 'dealer-ui.js' });
  sandbox.renderDealerDesk();
  assert.match(dealerRoot.innerHTML, /Existing candidate/);
  buttons.get('#dealer-new-candidate').listeners.get('click')[0]();
  assert.match(dealerRoot.innerHTML, /Create candidate/);
  assert.match(dealerRoot.innerHTML, /Cancel new candidate/);
  assert.doesNotMatch(dealerRoot.innerHTML, /Existing candidate/);
  for (const [id, value] of Object.entries({
    'dealer-name': 'New candidate', 'dealer-set': 'New set', 'dealer-number': '002', 'dealer-language': 'EN',
    'dealer-variant': 'Normal', 'dealer-format': 'raw', 'dealer-ownership': 'Business', 'dealer-condition': 'NM',
    'dealer-condition-certainty': 'Known', 'dealer-condition-scenario': '', 'dealer-grader': '', 'dealer-grade': '',
    'dealer-certificate': '', 'dealer-front': 'synthetic://front', 'dealer-back': 'synthetic://back', 'dealer-notes': '',
  })) fields.set(id, { id, value, type: 'text' });
  buttons.get('#dealer-save-candidate').listeners.get('click')[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.match(dealerRoot.innerHTML, /New candidate/);
  assert.match(dealerRoot.innerHTML, /Save candidate revision/);
  assert.doesNotMatch(dealerRoot.innerHTML, /Create candidate/);
});

test('Dealer UI awaits WAL recovery before rereading state and never resets storage after a failed recovery', async () => {
  const events = [];
  let getStateCalls = 0;
  let resolveRecovery;
  const recoveryPromise = new Promise(resolve => { resolveRecovery = resolve; });
  const first = makeDealerUiRuntime(() => {
    getStateCalls += 1;
    events.push('getState:' + getStateCalls);
    return getStateCalls === 1
      ? { ok: false, code: 'recovery_required', message: 'Pending WAL' }
      : { ok: true, state: { candidates: [] } };
  }, () => {
    events.push('recover:start');
    return recoveryPromise;
  }, () => { throw new Error('reset must not run during recovery'); });
  first.sandbox.renderDealerDesk();
  const click = first.listeners.get('click')[0];
  const pendingClick = click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ['getState:1', 'recover:start'], 'fresh state must wait for recover');
  resolveRecovery({ ok: true, recovered: true, action: 'rolled_back' });
  await pendingClick;
  assert.deepEqual(events, ['getState:1', 'recover:start', 'getState:2']);

  let failedGetStateCalls = 0;
  let resetCalls = 0;
  const second = makeDealerUiRuntime(() => {
    failedGetStateCalls += 1;
    return { ok: false, code: 'pending_wal', message: 'Pending WAL' };
  }, async () => ({ ok: false, code: 'recovery_required', message: 'Recovery conflict' }), () => {
    resetCalls += 1;
    second.storage.setItem('dealer', 'reset');
  });
  second.sandbox.renderDealerDesk();
  const failedClick = second.listeners.get('click')[0];
  await failedClick();
  assert.equal(failedGetStateCalls, 2, 'failed recovery may rerender the blocked state');
  assert.equal(resetCalls, 0, 'failed recovery must not invoke the destructive fixture reset');
  assert.equal(second.storage.value, 'dealer-storage-before-recovery');
  assert.deepEqual(second.storageWrites, []);
});
