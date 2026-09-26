/* Dealer Desk Release 0 guided local pilot UI. */
(function dealerDeskUi(root) {
  'use strict';

  var ui = {
    candidateId: '',
    candidatePage: 0,
    newCandidate: false,
    pending: null,
    technical: null,
    formDraft: null,
    message: null,
    messageTone: '',
    exportText: '',
    restoreText: ''
  };

  function doc() {
    return root.document || (typeof document !== 'undefined' ? document : null);
  }

  function api() {
    return root.DealerDesk || (typeof DealerDesk !== 'undefined' ? DealerDesk : null);
  }

  function isLocalPilot() {
    var locationValue = root.location || (typeof location !== 'undefined' ? location : null);
    var hostname = locationValue && String(locationValue.hostname || '').toLowerCase();
    var protocol = locationValue && String(locationValue.protocol || '').toLowerCase();
    var loopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
    var desk = api();
    return root.__KJR_DEALER_PREVIEW__ === true && (protocol === 'http:' || protocol === 'https:') && loopback && !!desk && typeof desk.isLocalPreview === 'function' && desk.isLocalPreview();
  }

  function mutationOptions(state, candidate, requestId, extra) {
    var desk = api();
    var options = Object.assign({}, extra || {});
    options.ownerId = state && state.ownerId ? state.ownerId : (desk && typeof desk.ownerId === 'function' ? desk.ownerId() : '');
    options.requestId = requestId;
    options.expectedRevision = state && Number.isSafeInteger(state.revision) ? state.revision : 0;
    options.candidateVersion = candidate && Number.isSafeInteger(candidate.version) ? candidate.version : 0;
    return options;
  }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value);
  }

  function el(id) {
    var documentValue = doc();
    return documentValue ? documentValue.getElementById(id) : null;
  }

  function value(id) {
    var node = el(id);
    return node ? node.value : '';
  }

  function setMessage(message, tone) {
    ui.message = message || '';
    ui.messageTone = tone || '';
  }

  function pretty(value) {
    try { return JSON.stringify(value, null, 2); } catch (error) { return String(value); }
  }

  function disclosureKey(detail) {
    if (!detail || (detail.classList && typeof detail.classList.contains === 'function' && detail.classList.contains('dealer-technical'))) return '';
    var summary = typeof detail.querySelector === 'function' ? detail.querySelector('summary') : null;
    var label = summary && (summary.textContent || summary.innerText);
    label = text(label).replace(/\s+/g, ' ').trim();
    return label ? 'summary:' + label : '';
  }

  function captureFormDraft() {
    var node = el('dealer-root');
    if (!node || typeof node.querySelectorAll !== 'function') return null;
    var fields = {};
    Array.prototype.forEach.call(node.querySelectorAll('input[id], select[id], textarea[id]'), function (field) {
      var entry = { value: field.value };
      if (field.type === 'checkbox' || field.type === 'radio') entry.checked = !!field.checked;
      fields[field.id] = entry;
    });
    var details = {};
    Array.prototype.forEach.call(node.querySelectorAll('details'), function (detail) {
      var key = disclosureKey(detail);
      if (key) details[key] = { open: !!detail.open };
    });
    return { fields: fields, details: details };
  }

  function restoreFormDraft() {
    var draft = ui.formDraft;
    var node = el('dealer-root');
    if (!draft || !node || typeof node.querySelectorAll !== 'function') return;
    Object.keys(draft.fields || {}).forEach(function (id) {
      var field = el(id);
      var entry = draft.fields[id];
      if (!field || !entry) return;
      field.value = entry.value;
      if (entry.checked !== undefined) field.checked = entry.checked;
    });
    Array.prototype.forEach.call(node.querySelectorAll('details'), function (detail) {
      var key = disclosureKey(detail);
      var entry = key && draft.details && draft.details[key];
      if (entry) detail.open = !!entry.open;
    });
  }

  function clearDraft() {
    ui.formDraft = null;
    ui.technical = null;
    ui.pending = null;
  }

  function selectCreatedCandidate(result) {
    if (result && result.ok && result.candidate && result.candidate.id) {
      ui.candidateId = result.candidate.id;
      ui.newCandidate = false;
    }
    return result;
  }

  function technicalMarkup(details) {
    if (!details) return '';
    return '<details class="dealer-technical"><summary>Technical details</summary><pre>' + esc(pretty(details)) + '</pre></details>';
  }

  function displayAmount(value) {
    if (value && typeof value === 'object') {
      var keys = ['amount', 'reportingAmount', 'convertedAmount'];
      for (var i = 0; i < keys.length; i += 1) {
        if (Object.prototype.hasOwnProperty.call(value, keys[i]) && value[keys[i]] !== null && value[keys[i]] !== undefined && value[keys[i]] !== '') return value[keys[i]];
      }
      return '';
    }
    return value === null || value === undefined ? '' : value;
  }

  function moneyApi() {
    return root.DealerMoney || (typeof DealerMoney !== 'undefined' ? DealerMoney : null);
  }

  function moneyValue(value) {
    var amount = displayAmount(value);
    if (amount === '' || amount === null || amount === undefined) return 'Unknown';
    var money = moneyApi();
    if (money && typeof money.formatMoney === 'function') {
      try {
        var formatted = money.formatMoney(text(amount));
        if (formatted !== null && formatted !== undefined) return 'SGD ' + formatted;
      } catch (error) {}
    }
    return 'SGD ' + text(amount);
  }

  function formatDateDisplay(value) {
    var raw = text(value).trim();
    var iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (iso) return iso[3] + '/' + iso[2] + '/' + iso[1];
    var date = new Date(raw);
    if (!raw || !Number.isFinite(date.getTime())) return raw || 'Unknown';
    var day = String(date.getDate()).padStart(2, '0');
    var month = String(date.getMonth() + 1).padStart(2, '0');
    return day + '/' + month + '/' + String(date.getFullYear());
  }

  var MONEY_LINE_LABELS = {
    proceeds: 'Sale proceeds',
    landed_cost: 'Landed cost',
    item_price: 'Item cost',
    selling_fee: 'Selling fee',
    outbound_shipping: 'Outbound shipping',
    refund_allowance: 'Refund allowance',
    risk_allowance: 'Risk allowance',
    other_deduction: 'Other deduction',
    other_acquisition: 'Other acquisition cost',
    acquisition_shipping: 'Acquisition shipping',
    payment_fee: 'Payment fee',
    tax: 'Tax',
    duty: 'Duty',
    grading: 'Grading',
    authentication: 'Authentication',
    insurance: 'Insurance',
    storage: 'Storage',
    platform_fee: 'Platform fee',
    refund: 'Refund',
    other: 'Other adjustment'
  };

  function moneyLineLabel(type) {
    var key = text(type).trim();
    if (MONEY_LINE_LABELS[key]) return MONEY_LINE_LABELS[key];
    return key ? key.replace(/_/g, ' ').replace(/^./, function (letter) { return letter.toUpperCase(); }) : 'Money line';
  }

  function planSummary(plan) {
    if (!plan || !plan.expected) return '';
    var expected = plan.expected;
    var rows = [
      ['Planned sale', moneyValue(expected.expectedSaleAmount)],
      ['Selling fee', moneyValue(expected.sellingFee)],
      ['Outbound shipping', moneyValue(expected.outboundShipping)],
      ['Refund allowance', moneyValue(expected.refundAllowance)],
      ['Other deductions', moneyValue(expected.otherDeductions)],
      ['Expected net proceeds', moneyValue(expected.expectedNetProceeds)],
      ['Target contribution before overhead/tax', moneyValue(expected.targetContribution)],
      ['Risk allowance', moneyValue(expected.riskAllowance)],
      ['Known non-item acquisition costs', moneyValue(expected.knownNonItemAcquisitionCosts)],
      ['Maximum all-in acquisition ceiling (floored)', moneyValue(expected.maximumAllInAcquisitionCostRounded !== null && expected.maximumAllInAcquisitionCostRounded !== undefined ? expected.maximumAllInAcquisitionCostRounded : expected.maximumAllInAcquisitionCost)],
      ['Item price ceiling', moneyValue(expected.itemPriceCeiling)]
    ];
    return '<dl class="dealer-money-summary">' + rows.map(function (row) {
      return '<div><dt>' + esc(row[0]) + '</dt><dd>' + esc(row[1]) + '</dd></div>';
    }).join('') +
      '<div><dt>Formula</dt><dd>' + esc(expected.formula || 'Expected sale - selling fee - outbound shipping - refund allowance - other deductions') + '</dd></div>' +
      '<div><dt>Ceiling formula</dt><dd>' + esc(expected.ceilingFormula || 'Expected net proceeds - target contribution - risk allowance - known non-item acquisition costs') + '</dd></div>' +
      '</dl>';
  }

  function actualSummary(review) {
    var actual = review && review.actual;
    if (!actual) return '<p class="dealer-help">Actual contribution appears after the sale is settled.</p>';
    var lines = Array.isArray(actual.lines) ? actual.lines : [];
    var output = '<div class="dealer-review-summary"><p><strong>Actual contribution status:</strong> ' + esc(actual.status || 'Unknown') + '</p>';
    if (actual.contribution) output += '<p><strong>Actual contribution:</strong> ' + esc(moneyValue(actual.contribution.contribution)) + '</p>';
    if (lines.length) {
      output += '<ul>' + lines.map(function (line) {
        return '<li>' + esc(moneyLineLabel(line.type)) + ': ' + esc(moneyValue(line.amount)) + '</li>';
      }).join('') + '</ul>';
    } else if (actual.reason) output += '<p>' + esc(actual.reason) + '</p>';
    if (review && review.variance) {
      var variance = review.variance;
      var plannedContribution = variance.plannedContribution !== undefined ? variance.plannedContribution : variance.expectedTargetContribution;
      output += '<p><strong>Difference from frozen plan:</strong> ' + esc(variance.status || 'Unknown') + '</p>';
      if (plannedContribution !== undefined && plannedContribution !== null) output += '<p><strong>Planned contribution:</strong> ' + esc(moneyValue(plannedContribution)) + '</p>';
      if (variance.actualContribution !== undefined && variance.actualContribution !== null) output += '<p><strong>Actual contribution:</strong> ' + esc(moneyValue(variance.actualContribution)) + '</p>';
      if (variance.delta !== undefined && variance.delta !== null) output += '<p><strong>Difference:</strong> ' + esc(moneyValue(variance.delta)) + '</p>';
      if (variance.targetComparison) {
        var target = variance.targetComparison;
        output += '<p><strong>Target contribution comparison:</strong> ' + esc(target.status || 'Unknown') + '</p>';
        if (target.targetContribution !== undefined && target.targetContribution !== null) output += '<p><strong>Target contribution:</strong> ' + esc(moneyValue(target.targetContribution)) + '</p>';
        if (target.actualContribution !== undefined && target.actualContribution !== null) output += '<p><strong>Actual contribution against target:</strong> ' + esc(moneyValue(target.actualContribution)) + '</p>';
        if (target.delta !== undefined && target.delta !== null) output += '<p><strong>Difference from target:</strong> ' + esc(moneyValue(target.delta)) + '</p>';
      }
    }
    return output + '</div>';
  }

  function resultMessage(result) {
    if (!result) return '';
    if (result.ok) return result.idempotent ? 'Already saved safely, no duplicate was created' : 'Saved locally';
    if (result.code === 'revision_conflict' || result.code === 'candidate_version_conflict' || result.code === 'storage_conflict' || result.code === 'inventory_version_conflict') return 'Conflict detected. The current record was kept. Review the pending values and retry.';
    var base = result.message || result.code || 'The action was blocked';
    var blockers = result.blockers || (result.details && result.details.blockers);
    return Array.isArray(blockers) && blockers.length ? base + ' [' + blockers.map(humanBlocker).join(', ') + ']' : base;
  }

  function restoreSuccessMessage(result) {
    var sources = [result, result && result.result, result && result.counts, result && result.result && result.result.counts];
    var restored = null;
    var inserted = null;
    var skipped = null;
    for (var i = 0; i < sources.length; i += 1) {
      var source = sources[i];
      if (!source || typeof source !== 'object') continue;
      if (restored === null) restored = source.restoredReferences !== undefined ? source.restoredReferences : (source.restoredCount !== undefined ? source.restoredCount : (source.restoredRows !== undefined ? source.restoredRows : (typeof source.restored === 'number' ? source.restored : null)));
      if (inserted === null) inserted = source.insertedReferences !== undefined ? source.insertedReferences : (source.insertedCount !== undefined ? source.insertedCount : (source.insertedRows !== undefined ? source.insertedRows : null));
      if (skipped === null) skipped = source.skippedReferences !== undefined ? source.skippedReferences : (source.skippedCount !== undefined ? source.skippedCount : (source.skippedRows !== undefined ? source.skippedRows : (typeof source.skipped === 'number' ? source.skipped : null)));
    }
    var counts = [];
    if (restored !== null) counts.push(String(restored) + ' references checked');
    if (inserted !== null) counts.push(String(inserted) + ' rows inserted');
    if (skipped !== null) counts.push(String(skipped) + ' existing rows kept');
    if (counts.length) return 'Restore completed: ' + counts.join(', ');
    return result && result.restored === true ? 'Restore completed safely' : 'Restore completed';
  }

  function humanBlocker(value) {
    var labels = {
      evidence_required: 'Add source evidence',
      evidence_class_required: 'Evidence class is required',
      evidence_date_required: 'Evidence date is required',
      evidence_match_required: 'Evidence match status is required',
      evidence_confidence_required: 'Evidence confidence is required',
      known_money_required: 'Complete all known plan money fields',
      planned_item_cost_unknown: 'Enter the planned item cost in SGD',
      buy_plan_required: 'Save a buy plan',
      snapshot_reason_required: 'Add a frozen plan reason',
      business_ownership_required: 'Set ownership to Business',
      exact_identity_required: 'Complete exact identity',
      card_number_required: 'Add the card number',
      condition_required: 'Complete condition and certainty',
      copy_missing: 'Link or acquire one physical copy',
      settlement_required: 'Confirm the sale payment with dated evidence',
      cost_review_required: 'Confirm the canonical acquisition cost',
      approved_asking_required: 'Approve the asking amount',
      inventory_copy_required: 'Link or acquire one physical copy',
      available_status_required: 'The physical copy must be available',
      raw_front_back_refs_required: 'Add front and back references',
      hold_active: 'Resolve the active hold before continuing'
    };
    return labels[value] || String(value).replace(/_/g, ' ');
  }

  function currentState() {
    var desk = api();
    if (!desk || typeof desk.getState !== 'function') return { ok: false, code: 'dealer_unavailable', message: 'Dealer Desk module is not loaded' };
    return desk.getState();
  }

  function candidateFromState(state) {
    if (!state || !state.state || !Array.isArray(state.state.candidates)) return null;
    if (ui.candidateId) {
      var selected = state.state.candidates.find(function (candidate) { return candidate.id === ui.candidateId; });
      if (selected) return selected;
    }
    return state.state.candidates[ui.candidatePage * 12] || state.state.candidates[0] || null;
  }

  function candidatePageItems(candidates) {
    var pageCount = Math.max(1, Math.ceil(candidates.length / 12));
    if (ui.candidateId) {
      var selectedIndex = candidates.findIndex(function (candidate) { return candidate.id === ui.candidateId; });
      if (selectedIndex >= 0) ui.candidatePage = Math.floor(selectedIndex / 12);
    }
    ui.candidatePage = Math.min(Math.max(ui.candidatePage, 0), pageCount - 1);
    return { page: ui.candidatePage, pageCount: pageCount, items: candidates.slice(ui.candidatePage * 12, ui.candidatePage * 12 + 12) };
  }

  function inputMarkup(candidate) {
    var identity = candidate && candidate.identity || {};
    var condition = candidate && candidate.condition || {};
    return '<details class="dealer-section" open>' +
      '<summary>1. Candidate identity and evidence</summary>' +
      '<div class="dealer-grid dealer-grid-identity">' +
      '<label>Name<input id="dealer-name" maxlength="160" value="' + esc(identity.name || '') + '"></label>' +
      '<label>Set<input id="dealer-set" maxlength="120" value="' + esc(identity.set || '') + '"></label>' +
      '<label>Number<input id="dealer-number" maxlength="40" value="' + esc(identity.number || '') + '"></label>' +
      '<label>Language<input id="dealer-language" maxlength="20" value="' + esc(identity.language || '') + '"></label>' +
      '<label>Variant<input id="dealer-variant" maxlength="80" value="' + esc(identity.variant || '') + '"></label>' +
      '<label>Format<select id="dealer-format"><option value="raw"' + (candidate && candidate.format === 'raw' ? ' selected' : '') + '>Raw</option><option value="slab"' + (candidate && candidate.format === 'slab' ? ' selected' : '') + '>Slab</option></select></label>' +
      '<label>Ownership<select id="dealer-ownership"><option>Unknown</option><option' + (candidate && candidate.ownership === 'Business' ? ' selected' : '') + '>Business</option><option' + (candidate && candidate.ownership === 'Collection' ? ' selected' : '') + '>Collection</option></select></label>' +
      '<label>Condition<input id="dealer-condition" maxlength="60" value="' + esc(condition.value || '') + '"></label>' +
      '<label>Condition certainty<select id="dealer-condition-certainty"><option' + (condition.certainty === 'Known' ? ' selected' : '') + '>Known</option><option' + (condition.certainty === 'Estimated' ? ' selected' : '') + '>Estimated</option><option' + (condition.certainty === 'Unknown' ? ' selected' : '') + '>Unknown</option></select></label>' +
      '<label class="dealer-wide">Estimated scenario<input id="dealer-condition-scenario" maxlength="240" placeholder="Required when condition is estimated" value="' + esc(condition.scenario || '') + '"></label>' +
      '<label>Grader<input id="dealer-grader" maxlength="40" value="' + esc(candidate && candidate.grader || '') + '"></label>' +
      '<label>Grade<input id="dealer-grade" maxlength="20" value="' + esc(candidate && candidate.grade || '') + '"></label>' +
      '<label class="dealer-wide">Slab certificate<input id="dealer-certificate" maxlength="80" value="' + esc(candidate && candidate.certificateNumber || '') + '"></label>' +
      '<label>Raw front reference<input id="dealer-front" maxlength="240" placeholder="synthetic://front" value="' + esc(candidate && candidate.frontRef || '') + '"></label>' +
      '<label>Raw back reference<input id="dealer-back" maxlength="240" placeholder="synthetic://back" value="' + esc(candidate && candidate.backRef || '') + '"></label>' +
      '<label class="dealer-wide">Candidate notes<textarea id="dealer-notes" rows="3" maxlength="800" placeholder="What is known, unknown, or held?">' + esc(candidate && candidate.notes || '') + '</textarea></label>' +
      '</div>' +
      '<p class="dealer-help">Use manual or visibly synthetic references. Do not paste credentials or private messages. Unknown values remain blockers until resolved.</p>' +
      '<details class="dealer-evidence"><summary>Add source evidence</summary><div class="dealer-grid dealer-grid-evidence">' +
      '<label>Source class<select id="dealer-evidence-class"><option value="manual">Manual</option><option value="asking">Asking</option><option value="sold">Sold</option><option value="transaction">Transaction</option></select></label>' +
      '<label>Source date<input id="dealer-evidence-date" type="datetime-local"></label>' +
      '<label>Match status<input id="dealer-evidence-match" maxlength="80" placeholder="Exact, partial, unresolved"></label>' +
      '<label>Confidence<select id="dealer-evidence-confidence"><option value="unknown">Unknown</option><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>' +
      '<label class="dealer-wide">Reference<input id="dealer-evidence-ref" maxlength="240" placeholder="manual://reference or synthetic://reference"></label>' +
      '<label class="dealer-wide">Source description<input id="dealer-evidence-source" maxlength="160" placeholder="Where this evidence came from"></label>' +
      '<label class="dealer-wide">Rationale<textarea id="dealer-evidence-rationale" rows="3" maxlength="500" placeholder="Why this evidence supports the candidate"></textarea></label>' +
      '</div><div class="dealer-actions"><button class="btn btn-ghost" id="dealer-add-evidence" type="button"' + (!candidate ? ' disabled' : '') + '>Add evidence</button></div></details>' +
      '<div class="dealer-actions"><button class="btn btn-primary" id="dealer-save-candidate" type="button">' + (candidate ? 'Save candidate revision' : 'Create candidate') + '</button><button class="btn btn-ghost" id="dealer-new-candidate" type="button">' + (ui.newCandidate ? 'Cancel new candidate' : 'New candidate') + '</button><button class="btn btn-ghost" id="dealer-load-synthetic" type="button">Load synthetic candidate</button></div>' +
      '</details>';
  }

  function planMarkup(candidate, state) {
    var plan = state && state.plans ? state.plans.filter(function (item) { return item.candidateId === candidate.id; }).sort(function (a, b) { return b.version - a.version; })[0] : null;
    var input = plan && plan.input || {};
    return '<details class="dealer-section">' +
      '<summary>2. Review economics and approve buy</summary>' +
      '<div class="dealer-grid dealer-grid-money">' +
      '<label>Expected sale (SGD)<input type="text" inputmode="decimal" id="dealer-plan-sale" value="' + esc(displayAmount(input.expectedSaleAmount)) + '"></label>' +
      '<label>Selling fee (SGD)<input type="text" inputmode="decimal" id="dealer-plan-fee" value="' + esc(displayAmount(input.expectedSellingFee)) + '"></label>' +
      '<label>Outbound shipping (SGD)<input type="text" inputmode="decimal" id="dealer-plan-shipping" value="' + esc(displayAmount(input.expectedOutboundShipping)) + '"></label>' +
      '<label>Refund allowance (SGD)<input type="text" inputmode="decimal" id="dealer-plan-refund" value="' + esc(displayAmount(input.expectedRefundAllowance)) + '"></label>' +
      '<label>Other deductions (SGD)<input type="text" inputmode="decimal" id="dealer-plan-other" value="' + esc(displayAmount(input.otherExpectedDeductions)) + '"></label>' +
      '<label>Target contribution before overhead/tax (SGD)<input type="text" inputmode="decimal" id="dealer-plan-target" value="' + esc(displayAmount(input.targetContribution)) + '"></label>' +
      '<label>Risk allowance (SGD)<input type="text" inputmode="decimal" id="dealer-plan-risk" value="' + esc(displayAmount(input.riskAllowance)) + '"></label>' +
      '<label>Known non-item acquisition (SGD)<input type="text" inputmode="decimal" id="dealer-plan-non-item" value="' + esc(displayAmount(input.knownNonItemAcquisitionCosts)) + '"></label>' +
      '<label>Planned item cost (SGD)<input type="text" inputmode="decimal" id="dealer-plan-item-cost" value="' + esc(plan && plan.plannedItemCost && plan.plannedItemCost.amount || displayAmount(input.plannedItemCost)) + '" placeholder="Required for Buy approval"></label>' +
      '<label class="dealer-wide">Frozen plan reason<textarea id="dealer-plan-reason" rows="3" maxlength="500" placeholder="Why is this expected snapshot being approved?">' + esc(input.snapshotReason || input.reason || (plan && plan.reason) || '') + '</textarea></label>' +
      '</div>' +
      '<p class="dealer-help">All plan amounts are SGD. Blank is unknown, enter <strong>0</strong> only when zero is known. Contribution is shown before overhead and tax. Planned item cost is the intended purchase amount, while the ceiling is a maximum spend and is never used as the purchase amount.</p>' +
      '<div class="dealer-actions"><button class="btn btn-primary" id="dealer-save-plan" type="button">Save plan</button><button class="btn btn-primary" id="dealer-approve-buy" type="button">Approve buy</button></div>' +
      (plan ? '<div class="dealer-result" aria-label="Current plan"><strong>Frozen expected economics, plan v' + esc(plan.version) + '</strong>' + planSummary(plan) + '</div>' : '') +
      '</details>';
  }

  function copyMarkup(candidate, state) {
    var copy = state && state.copies ? state.copies.filter(function (item) { return item.candidateId === candidate.id; })[0] : null;
    var cost = copy && copy.costComponent || {};
    var linkedVersion = copy && copy.itemRef && copy.itemRef.version !== undefined ? copy.itemRef.version : '';
    return '<details class="dealer-section">' +
      '<summary>3. Create or link one Business physical copy</summary>' +
      '<p class="dealer-help">Link the exact existing singles or slabs row, or acquire one clearly labelled synthetic row for this local pilot. The selected row version and cost are recorded automatically, so you do not type a row version.</p>' +
      '<div class="dealer-grid dealer-grid-copy">' +
      '<label>Inventory table<select id="dealer-copy-table"><option value="singles"' + (copy && copy.itemRef.table === 'singles' ? ' selected' : '') + '>singles</option><option value="slabs"' + (copy && copy.itemRef.table === 'slabs' ? ' selected' : '') + '>slabs</option></select></label>' +
      '<label>Exact inventory id<input id="dealer-copy-id" maxlength="180" value="' + esc(copy && copy.itemRef.id || '') + '"></label>' +
      '<label>Copy tag<input id="dealer-copy-tag" maxlength="100" value="' + esc(copy && copy.copyTag || '') + '"></label>' +
      '<label>Cost currency<select id="dealer-copy-cost-currency"><option value="SGD"' + (!cost.originalCurrency || cost.originalCurrency === 'SGD' ? ' selected' : '') + '>SGD</option><option value="USD"' + (cost.originalCurrency === 'USD' ? ' selected' : '') + '>USD</option><option value="EUR"' + (cost.originalCurrency === 'EUR' ? ' selected' : '') + '>EUR</option><option value="JPY"' + (cost.originalCurrency === 'JPY' ? ' selected' : '') + '>JPY</option></select></label>' +
      '<label>Item cost<input id="dealer-copy-item-cost" type="text" inputmode="decimal" value="' + esc(cost.itemCost || '') + '" placeholder="Derived for an existing row"></label>' +
      '<label>Non-item acquisition costs (same as cost currency)<input id="dealer-copy-non-item" type="text" inputmode="decimal" value="' + esc(cost.nonItemAcquisitionCosts || '') + '" placeholder="Enter 0 when known"></label>' +
      '<label>Cost reviewed date<input id="dealer-copy-reviewed-at" type="datetime-local" value="' + esc(cost.reviewedAt ? String(cost.reviewedAt).slice(0, 16) : '') + '"></label>' +
      '<label class="dealer-wide">Cost review reason<textarea id="dealer-copy-cost-reason" rows="2" maxlength="300" placeholder="Why is this canonical cost confirmed?">' + esc(cost.reason || '') + '</textarea></label>' +
      '<label>FX rate to SGD<input id="dealer-copy-fx-rate" type="text" inputmode="decimal" value="' + esc(cost.fx && cost.fx.rate || '') + '" placeholder="Required outside SGD"></label>' +
      '<label>FX source<input id="dealer-copy-fx-source" maxlength="120" value="' + esc(cost.fx && cost.fx.source || '') + '" placeholder="Manual source"></label>' +
      '<label>FX observed date<input id="dealer-copy-fx-date" type="date" value="' + esc(cost.fx && cost.fx.observedAt || '') + '"></label>' +
      '<label>Settled total (SGD)<input id="dealer-copy-settled-total" type="text" inputmode="decimal" value="' + esc(cost.settledAmount || '') + '" placeholder="Required outside SGD"></label>' +
      '<label>Settled item cost (SGD)<input id="dealer-copy-settled-item" type="text" inputmode="decimal" value="' + esc(cost.settledItemCost || '') + '" placeholder="Required outside SGD"></label>' +
      '<label>Settled non-item cost (SGD)<input id="dealer-copy-settled-non-item" type="text" inputmode="decimal" value="' + esc(cost.settledNonItemAcquisitionCosts || '') + '" placeholder="Required outside SGD"></label>' +
      '</div>' +
      (copy ? '<p class="dealer-help">Linked row: ' + esc(copy.itemRef.table + '/' + copy.itemRef.id) + ', recorded row version ' + esc(linkedVersion) + ', canonical cost ' + esc(moneyValue(cost.total)) + '</p>' : '<p class="dealer-help">After a successful link or acquisition, the exact row id, recorded version, and canonical cost stay visible here.</p>') +
      '<div class="dealer-actions"><button class="btn btn-primary" id="dealer-acquire-copy" type="button">Acquire synthetic Business copy</button><button class="btn btn-primary" id="dealer-link-copy" type="button">Link existing exact copy</button></div>' +
      '</details>';
  }

  function listingMarkup(candidate, deskState) {
    var desk = api();
    var readiness = desk && desk.getListingReadiness ? desk.getListingReadiness(candidate.id) : null;
    var asking = candidate.asking || {};
    var blockers = readiness && readiness.blockers || [];
    return '<details class="dealer-section">' +
      '<summary>4. Prepare manual listing handoff</summary>' +
      '<div class="dealer-grid dealer-grid-copy"><label>Approved asking amount<input id="dealer-asking-amount" inputmode="decimal" value="' + esc(asking.amount !== undefined ? asking.amount : '') + '"></label><label>Currency<input id="dealer-asking-currency" maxlength="3" value="' + esc(asking.currency || 'SGD') + '"></label></div>' +
      '<div class="dealer-actions"><button class="btn btn-primary" id="dealer-approve-asking" type="button">Approve asking</button><button class="btn btn-primary" id="dealer-prepare-listing" type="button">Prepare handoff</button></div>' +
      '<div class="dealer-blockers"><strong>' + (readiness && readiness.ready ? 'Ready for manual handoff' : 'Listing blockers') + '</strong>' +
      (blockers.length ? '<ul>' + blockers.map(function (blocker) { return '<li>' + esc(humanBlocker(blocker)) + '</li>'; }).join('') + '</ul>' : '<p>Manual handoff only, no marketplace publish.</p>') + '</div>' +
      '</details>';
  }

  function outcomeMarkup(candidate, state) {
    var latestOutcome = state.outcomes && state.outcomes.filter(function (item) { return item.candidateId === candidate.id; }).slice(-1)[0];
    var latestSale = latestOutcome && latestOutcome.kind === 'sale' ? latestOutcome : null;
    return '<details class="dealer-section">' +
      '<summary>5. Record completed sale or explicit non-sale</summary>' +
      '<div class="dealer-grid dealer-grid-money">' +
      '<label>Date sold<input id="dealer-sale-date" type="datetime-local"></label>' +
      '<label>Collected amount (SGD)<input id="dealer-sale-total" type="text" inputmode="decimal"></label>' +
      '<label>Shipping (SGD, enter 0 when known)<input id="dealer-sale-shipping" type="text" inputmode="decimal"></label>' +
      '<label>Fees (SGD, enter 0 when known)<input id="dealer-sale-fees" type="text" inputmode="decimal"></label>' +
      '<label>Buyer<input id="dealer-sale-buyer" maxlength="120"></label>' +
      '<label>Channel<input id="dealer-sale-channel" maxlength="60" value="Manual"></label>' +
      '</div>' +
      '<div class="dealer-actions"><button class="btn btn-primary" id="dealer-record-sale" type="button">Record completed sale</button></div>' +
      '<div class="dealer-grid dealer-grid-copy"><label>Non-sale reason<input id="dealer-no-sale-reason" maxlength="240"></label><label>Non-sale date<input id="dealer-no-sale-date" type="datetime-local"></label></div>' +
      '<div class="dealer-actions"><button class="btn btn-ghost" id="dealer-record-no-sale" type="button">Record explicit non-sale</button></div>' +
      (latestSale ? '<div class="dealer-settlement"><strong>Payment status:</strong> ' + esc(latestSale.paymentStatus || latestSale.status || 'Unknown') + '<p class="dealer-help">Sale is recorded with payment unknown until a dated manual or transaction evidence record is provided.</p><div class="dealer-grid dealer-grid-copy"><label>Settled date<input id="dealer-settled-date" type="datetime-local"></label><label>Evidence reference<input id="dealer-settlement-ref" maxlength="240" placeholder="synthetic://receipt"></label></div><div class="dealer-actions"><button class="btn btn-primary" id="dealer-settle-sale" type="button">Confirm settled with evidence</button></div></div>' : '') +
      '</details>';
  }

  function reviewMarkup(candidate, state) {
    var latest = state.outcomes && state.outcomes.filter(function (item) { return item.candidateId === candidate.id; }).slice(-1)[0];
    var review = state.reviews && state.reviews.filter(function (item) { return item.candidateId === candidate.id; }).slice(-1)[0];
    var plan = state.plans && state.plans.filter(function (item) { return item.candidateId === candidate.id; }).sort(function (a, b) { return b.version - a.version; })[0];
    return '<details class="dealer-section">' +
      '<summary>6. Review actual against the frozen plan</summary>' +
      '<p class="dealer-help">Actual contribution uses the linked, settled sale and acquisition costs.</p>' +
      (plan ? '<div class="dealer-result" aria-label="Frozen buy plan"><strong>Frozen plan v' + esc(plan.version) + '</strong>' + planSummary(plan) + '</div>' : '<p class="dealer-blocker">Create and approve a plan before review.</p>') +
      (latest ? '<div class="dealer-grid dealer-grid-money"><p class="dealer-help dealer-wide">The saved sale and linked acquisition record provide the proceeds, landed cost, fees and shipping. These values appear after payment is settled.</p><label class="dealer-wide">Variance cause<textarea id="dealer-review-cause" rows="3" maxlength="500" placeholder="What differed from the frozen plan?"></textarea></label><label>Restock decision<select id="dealer-review-restock"><option value="">Choose a decision</option><option value="Restock">Restock</option><option value="Do not restock">Do not restock</option><option value="Review later">Review later</option></select></label><label>Restock decision date<input id="dealer-review-restock-date" type="date"></label></div><div class="dealer-actions"><button class="btn btn-primary" id="dealer-review-outcome" type="button">Save outcome review</button></div>' : '<p class="dealer-blocker">Record a sale or explicit non-sale before review.</p>') +
      (review ? '<div class="dealer-result" aria-label="Saved outcome review"><strong>Actual contribution and variance</strong>' + actualSummary(review) + '<p><strong>Cause:</strong> ' + esc(review.cause || '') + '</p><p><strong>Restock decision:</strong> ' + esc(review.restockDecision && review.restockDecision.decision || '') + ' on ' + esc(formatDateDisplay(review.restockDecision && review.restockDecision.date)) + '</p></div>' : '') +
      '</details>';
  }

  function recoveryMarkup() {
    return '<details class="dealer-section">' +
      '<summary>Recovery and review</summary>' +
      '<div class="dealer-actions"><button class="btn btn-ghost" id="dealer-export" type="button">Export scoped recovery</button></div>' +
      '<label>Restore JSON<textarea id="dealer-restore-json" rows="5" placeholder="Paste a scoped Dealer Desk export"></textarea></label>' +
      '<div class="dealer-actions"><button class="btn btn-ghost" id="dealer-restore" type="button">Validate and restore</button></div>' +
      '<textarea id="dealer-export-json" rows="6" readonly aria-label="Scoped export"></textarea>' +
      (isLocalPilot() ? '<div class="dealer-actions"><button class="btn btn-ghost" id="dealer-reset-synthetic" type="button">Reset synthetic pilot state</button></div><p class="dealer-help">This removes only Dealer Desk metadata, its WAL and owner scope, plus the labelled synthetic canonical DB on this loopback fixture.</p>' : '') +
      '</details>';
  }

  function banner() {
    return '<div class="dealer-banner"><strong>LOCAL SYNTHETIC PILOT</strong><span>Manual trial only, local storage only, no cloud sync, no marketplace write, no external FX lookup</span><span class="dealer-next-action">Next: complete one stage, review blockers, then retry after any conflict</span></div>';
  }

  function blockedPage(message) {
    return banner() + '<div class="card dealer-blocked"><h2>Dealer Desk is local-only</h2><p>' + esc(message || 'Open the approved localhost preview to use Release 0.') + '</p></div>';
  }

  function formCandidate(candidate) {
    return {
      name: value('dealer-name'),
      set: value('dealer-set'),
      number: value('dealer-number'),
      language: value('dealer-language'),
      variant: value('dealer-variant'),
      format: value('dealer-format'),
      ownership: value('dealer-ownership'),
      condition: { value: value('dealer-condition'), certainty: value('dealer-condition-certainty'), scenario: value('dealer-condition-scenario') },
      grader: value('dealer-grader'),
      grade: value('dealer-grade'),
      certificateNumber: value('dealer-certificate'),
      frontRef: value('dealer-front'),
      backRef: value('dealer-back'),
      notes: value('dealer-notes'),
      status: candidate && candidate.status
    };
  }

  function plannedMoney(id, effect, type) {
    var amount = value(id);
    return amount;
  }

  function planInput() {
    return {
      reportingCurrency: 'SGD',
      expectedSaleAmount: plannedMoney('dealer-plan-sale', 'credit', 'proceeds'),
      expectedSellingFee: plannedMoney('dealer-plan-fee', 'debit', 'selling_fee'),
      expectedOutboundShipping: plannedMoney('dealer-plan-shipping', 'debit', 'shipping'),
      expectedRefundAllowance: plannedMoney('dealer-plan-refund', 'debit', 'refund_allowance'),
      otherExpectedDeductions: plannedMoney('dealer-plan-other', 'debit', 'other'),
      targetContribution: plannedMoney('dealer-plan-target', 'debit', 'target_contribution'),
      riskAllowance: plannedMoney('dealer-plan-risk', 'debit', 'risk_allowance'),
      knownNonItemAcquisitionCosts: plannedMoney('dealer-plan-non-item', 'debit', 'acquisition'),
      plannedItemCost: plannedMoney('dealer-plan-item-cost', 'debit', 'item_cost'),
      snapshotReason: value('dealer-plan-reason')
    };
  }

  function reviewedCostInput() {
    var currency = value('dealer-copy-cost-currency') || 'SGD';
    var output = {
      confirmed: true,
      itemCost: value('dealer-copy-item-cost'),
      nonItemAcquisitionCosts: value('dealer-copy-non-item'),
      nonItemCurrency: currency,
      currency: currency,
      reviewedAt: isoInput(value('dealer-copy-reviewed-at')),
      reason: value('dealer-copy-cost-reason')
    };
    if (currency !== 'SGD') {
      output.fx = {
        base: currency,
        quote: 'SGD',
        rate: value('dealer-copy-fx-rate'),
        source: value('dealer-copy-fx-source'),
        observedAt: value('dealer-copy-fx-date')
      };
      output.settledCurrency = 'SGD';
      output.settledAmount = value('dealer-copy-settled-total');
      output.settledItemCost = value('dealer-copy-settled-item');
      output.settledNonItemAcquisitionCosts = value('dealer-copy-settled-non-item');
    }
    return output;
  }

  function nowInput() {
    return new Date().toISOString().slice(0, 16);
  }

  function isoInput(valueText) {
    if (!text(valueText).trim()) return '';
    var valueDate = new Date(valueText || '');
    return Number.isFinite(valueDate.getTime()) ? valueDate.toISOString() : '';
  }

  function now() {
    return new Date().toISOString();
  }

  function requireFields(fields) {
    for (var i = 0; i < fields.length; i += 1) {
      if (!text(value(fields[i].id)).trim()) {
        ui.formDraft = captureFormDraft();
        ui.technical = null;
        ui.pending = null;
        setMessage(fields[i].label + ' is required. Leave it unknown only when this step explicitly allows an unknown value.', 'error');
        render();
        return false;
      }
    }
    return true;
  }

  async function action(work, pending, successMessage) {
    var draft = captureFormDraft();
    try {
      var result = await work();
      if (result && !result.ok) {
        ui.formDraft = draft;
        ui.pending = pending || null;
        ui.technical = { result: result, pending: pending || null };
      } else {
        clearDraft();
      }
      var resolvedSuccessMessage = typeof successMessage === 'function' ? successMessage(result) : successMessage;
      setMessage(result && result.ok && resolvedSuccessMessage ? resolvedSuccessMessage : resultMessage(result), result && result.ok ? 'success' : 'error');
      render();
      return result;
    } catch (error) {
      ui.formDraft = draft;
      ui.pending = pending || null;
      ui.technical = { error: error && error.message || String(error), pending: pending || null };
      setMessage('The action could not be saved. Review the form and retry.', 'error');
      render();
      return { ok: false, code: 'ui_action_failed', message: error && error.message || 'Dealer Desk action failed' };
    }
  }

  async function resetSyntheticPilot() {
    var confirmFn = typeof root.kjrConfirm === 'function' ? root.kjrConfirm : (typeof kjrConfirm === 'function' ? kjrConfirm : null);
    var approved = confirmFn ? await confirmFn('Reset the synthetic Dealer Desk pilot? This removes only Dealer metadata, its WAL/owner scope, and the labelled loopback canonical DB.', { ok: 'Reset synthetic pilot', danger: true }) : (typeof root.confirm === 'function' && root.confirm('Reset the synthetic Dealer Desk pilot? Only this loopback fixture state will be removed.'));
    if (!approved) return;
    if (typeof root.__KJR_DEALER_PREVIEW_RESET__ !== 'function') {
      setMessage('Synthetic reset is available only in the approved loopback fixture.', 'error');
      render();
      return;
    }
    root.__KJR_DEALER_PREVIEW_RESET__();
  }

  function bind(rootNode, candidate, state) {
    var desk = api();
    var optionsFor = function (prefix, extra) {
      return mutationOptions(state, candidate, 'ui-' + prefix + '-' + Date.now(), extra);
    };
    var copy = candidate && state && state.copies ? state.copies.filter(function (item) { return item.candidateId === candidate.id; })[0] : null;
    var saveCandidateButton = rootNode.querySelector('#dealer-save-candidate');
    if (saveCandidateButton) saveCandidateButton.addEventListener('click', function () {
      var payload = formCandidate(candidate);
      if (!candidate) {
        action(function () { return Promise.resolve(desk.createCandidate(payload, optionsFor('create', { candidateVersion: 0 }))).then(selectCreatedCandidate); }, payload);
      } else {
        action(function () { return desk.updateCandidate(candidate.id, payload, optionsFor('update', { expectedVersion: candidate.version })); }, payload);
      }
    });
    var newButton = rootNode.querySelector('#dealer-new-candidate');
    if (newButton) newButton.addEventListener('click', function () {
      clearDraft();
      if (ui.newCandidate) {
        ui.newCandidate = false;
        ui.candidateId = '';
        ui.message = '';
      } else {
        ui.newCandidate = true;
        ui.candidateId = '';
        ui.candidatePage = 0;
        ui.message = 'Enter a candidate, then save it locally';
      }
      ui.messageTone = '';
      render();
    });
    var syntheticButton = rootNode.querySelector('#dealer-load-synthetic');
    if (syntheticButton) syntheticButton.addEventListener('click', function () {
      var fixture = root.__KJR_DEALER_PREVIEW_FIXTURE__ && root.__KJR_DEALER_PREVIEW_FIXTURE__.candidate;
      var synthetic = Object.assign({ name: 'Synthetic Pikachu', set: 'Synthetic Base', number: '001', language: 'EN', variant: 'Synthetic holo', format: 'raw', ownership: 'Business', condition: { value: 'NM', certainty: 'Known' }, frontRef: 'synthetic://front', backRef: 'synthetic://back', notes: 'Synthetic Release 0 trial candidate' }, fixture || {});
      synthetic.condition = { value: synthetic.condition && synthetic.condition.value || 'NM', certainty: 'Known', scenario: '' };
      synthetic.frontRef = synthetic.frontRef || 'synthetic://front';
      synthetic.backRef = synthetic.backRef || 'synthetic://back';
      synthetic.ownership = 'Business';
      synthetic.evidenceRefs = [{ class: 'manual', sourceDate: new Date().toISOString(), match: 'Exact synthetic fixture match', confidence: 'high', reference: 'synthetic://dealer-preview-candidate-001', rationale: 'Synthetic fixture identity and references are controlled by the local Dealer Desk preview.', synthetic: true }];
      action(function () { return Promise.resolve(desk.createCandidate(synthetic, optionsFor('synthetic', { candidateVersion: 0 }))).then(selectCreatedCandidate); }, synthetic);
    });
    var evidenceButton = rootNode.querySelector('#dealer-add-evidence');
    if (evidenceButton && candidate) evidenceButton.addEventListener('click', function () {
      if (!requireFields([{ id: 'dealer-evidence-ref', label: 'Evidence reference' }, { id: 'dealer-evidence-date', label: 'Evidence source date' }])) return;
      var evidence = { class: value('dealer-evidence-class'), sourceDate: isoInput(value('dealer-evidence-date')), match: value('dealer-evidence-match'), confidence: value('dealer-evidence-confidence'), reference: value('dealer-evidence-ref'), source: value('dealer-evidence-source'), rationale: value('dealer-evidence-rationale'), synthetic: /^synthetic(?::|\/\/|[-_])/i.test(value('dealer-evidence-ref')) };
      action(function () { return desk.addEvidence(candidate.id, evidence, optionsFor('evidence', { expectedVersion: candidate.version })); }, evidence);
    });
    var savePlanButton = rootNode.querySelector('#dealer-save-plan');
    if (savePlanButton && candidate) savePlanButton.addEventListener('click', function () {
      if (!requireFields([{ id: 'dealer-plan-reason', label: 'Frozen plan reason' }])) return;
      var payload = planInput();
      action(function () { return desk.createPlan(candidate.id, payload, optionsFor('plan', { expectedVersion: candidate.version, reason: value('dealer-plan-reason') })); }, payload);
    });
    var approveBuyButton = rootNode.querySelector('#dealer-approve-buy');
    if (approveBuyButton && candidate) approveBuyButton.addEventListener('click', function () {
      if (!requireFields([{ id: 'dealer-plan-reason', label: 'Frozen plan reason' }])) return;
      action(function () { return desk.approveBuy(candidate.id, optionsFor('buy', { expectedVersion: candidate.version, reason: value('dealer-plan-reason') })); });
    });
    var acquireButton = rootNode.querySelector('#dealer-acquire-copy');
    if (acquireButton && candidate) acquireButton.addEventListener('click', function () {
      if (!requireFields([{ id: 'dealer-copy-id', label: 'Synthetic inventory id' }, { id: 'dealer-copy-item-cost', label: 'Item cost for synthetic acquisition' }, { id: 'dealer-copy-non-item', label: 'Non-item acquisition costs, enter 0 when known' }, { id: 'dealer-copy-reviewed-at', label: 'Cost reviewed date' }, { id: 'dealer-copy-cost-reason', label: 'Cost review reason' }])) return;
      var reviewedCost = reviewedCostInput();
      var payload = { inventoryTable: value('dealer-copy-table'), inventoryId: value('dealer-copy-id'), copyTag: value('dealer-copy-tag'), frontRef: value('dealer-front'), backRef: value('dealer-back'), reviewedCost: reviewedCost, expectedCandidateVersion: candidate.version };
      action(function () {
        var acquire = desk.acquireCopy || desk.createCopy;
        if (typeof acquire !== 'function') return Promise.resolve({ ok: false, code: 'acquire_copy_unavailable', message: 'Synthetic acquisition is not available in this Dealer Desk build' });
        return acquire.call(desk, candidate.id, payload, optionsFor('acquire-copy', { expectedCandidateVersion: candidate.version }));
      }, payload);
    });
    var linkButton = rootNode.querySelector('#dealer-link-copy');
    if (linkButton && candidate) linkButton.addEventListener('click', function () {
      if (!requireFields([{ id: 'dealer-copy-id', label: 'Exact inventory id' }, { id: 'dealer-copy-non-item', label: 'Non-item acquisition costs, enter 0 when known' }, { id: 'dealer-copy-reviewed-at', label: 'Cost reviewed date' }, { id: 'dealer-copy-cost-reason', label: 'Cost review reason' }])) return;
      var payload = { inventoryTable: value('dealer-copy-table'), inventoryId: value('dealer-copy-id'), copyTag: value('dealer-copy-tag'), frontRef: value('dealer-front'), backRef: value('dealer-back'), reviewedCost: reviewedCostInput(), expectedCandidateVersion: candidate.version };
      action(function () { return desk.linkCopy(candidate.id, payload, optionsFor('copy', { expectedCandidateVersion: candidate.version })); }, payload);
    });
    var askingButton = rootNode.querySelector('#dealer-approve-asking');
    if (askingButton && candidate) askingButton.addEventListener('click', function () { if (!requireFields([{ id: 'dealer-asking-amount', label: 'Approved asking amount' }])) return; action(function () { return desk.approveAsk(candidate.id, { amount: value('dealer-asking-amount'), currency: value('dealer-asking-currency') }, optionsFor('asking', { expectedVersion: candidate.version })); }); });
    var listingButton = rootNode.querySelector('#dealer-prepare-listing');
    if (listingButton && candidate) listingButton.addEventListener('click', function () { action(function () { return desk.prepareListing(candidate.id, optionsFor('listing', { expectedVersion: candidate.version })); }); });
    var saleButton = rootNode.querySelector('#dealer-record-sale');
    if (saleButton && candidate) saleButton.addEventListener('click', function () {
      if (!requireFields([{ id: 'dealer-sale-date', label: 'Sale date' }, { id: 'dealer-sale-total', label: 'Collected amount' }, { id: 'dealer-sale-shipping', label: 'Shipping, enter 0 when known' }, { id: 'dealer-sale-fees', label: 'Fees, enter 0 when known' }])) return;
      var saleOptions = optionsFor('sale', { expectedCandidateVersion: candidate.version });
      if (copy && copy.itemRef) { saleOptions.expectedItemVersion = copy.itemRef.version; saleOptions.expectedItemBytes = copy.itemRef.bytes; }
      action(function () { return desk.recordSale({ candidateId: candidate.id, copyId: copy && copy.id || '', dateSold: isoInput(value('dealer-sale-date')), totalCollected: value('dealer-sale-total'), shippingCost: value('dealer-sale-shipping'), fees: value('dealer-sale-fees'), buyer: value('dealer-sale-buyer'), channel: value('dealer-sale-channel'), expectedCandidateVersion: candidate.version }, saleOptions); });
    });
    var noSaleButton = rootNode.querySelector('#dealer-record-no-sale');
    if (noSaleButton && candidate) noSaleButton.addEventListener('click', function () { if (!requireFields([{ id: 'dealer-no-sale-reason', label: 'Non-sale reason' }, { id: 'dealer-no-sale-date', label: 'Non-sale date' }])) return; action(function () { return desk.recordNoSale({ candidateId: candidate.id, reason: value('dealer-no-sale-reason'), date: isoInput(value('dealer-no-sale-date')), expectedCandidateVersion: candidate.version }, optionsFor('no-sale', { expectedCandidateVersion: candidate.version })); }); });
    var settleButton = rootNode.querySelector('#dealer-settle-sale');
    if (settleButton && candidate && state) {
      var outcome = state.outcomes.filter(function (item) { return item.candidateId === candidate.id && item.kind === 'sale'; }).slice(-1)[0];
      if (outcome) settleButton.addEventListener('click', function () { if (!requireFields([{ id: 'dealer-settled-date', label: 'Settlement date' }, { id: 'dealer-settlement-ref', label: 'Settlement evidence reference' }])) return; var settleOptions = optionsFor('settle'); if (outcome.saleRef) { settleOptions.expectedSaleVersion = outcome.saleRef.version; settleOptions.expectedSaleBytes = outcome.saleRef.bytes; } action(function () { return desk.settleSale({ outcomeId: outcome.id, cashSettledAt: isoInput(value('dealer-settled-date')), settlementEvidence: { class: 'manual', reference: value('dealer-settlement-ref'), sourceDate: isoInput(value('dealer-settled-date')), confidence: 'high', rationale: 'Manual settled confirmation', synthetic: /^synthetic(?::|\/\/|[-_])/i.test(value('dealer-settlement-ref')) } }, settleOptions); }); });
    }
    var reviewButton = rootNode.querySelector('#dealer-review-outcome');
    if (reviewButton && candidate && state) reviewButton.addEventListener('click', function () {
      if (!requireFields([{ id: 'dealer-review-cause', label: 'Variance cause' }, { id: 'dealer-review-restock', label: 'Restock decision' }, { id: 'dealer-review-restock-date', label: 'Restock decision date' }])) return;
      var latest = state.outcomes.filter(function (item) { return item.candidateId === candidate.id; }).slice(-1)[0];
      var reviewInput = { candidateId: candidate.id, outcomeId: latest && latest.id, cause: value('dealer-review-cause'), restockDecision: { decision: value('dealer-review-restock'), date: isoInput(value('dealer-review-restock-date')) } };
      action(function () { return desk.reviewOutcome(reviewInput, optionsFor('review', { expectedVersion: candidate.version })); });
    });
    var exportButton = rootNode.querySelector('#dealer-export');
    if (exportButton) exportButton.addEventListener('click', function () {
      action(function () {
        var result = desk.exportScoped();
        if (result && result.ok) ui.exportText = result.json;
        return result;
      }, null, 'Scoped export prepared, references included');
    });
    var restoreButton = rootNode.querySelector('#dealer-restore');
    if (restoreButton) restoreButton.addEventListener('click', function () { action(function () { return desk.restoreScoped(value('dealer-restore-json'), optionsFor('restore')); }, null, restoreSuccessMessage); });
    var resetButton = rootNode.querySelector('#dealer-reset-synthetic');
    if (resetButton) resetButton.addEventListener('click', resetSyntheticPilot);
    var select = rootNode.querySelector('#dealer-candidate-select');
    if (select) select.addEventListener('change', function () { clearDraft(); ui.newCandidate = false; ui.candidateId = select.value; ui.message = ''; ui.messageTone = ''; render(); });
    var previousPage = rootNode.querySelector('#dealer-candidate-prev');
    if (previousPage) previousPage.addEventListener('click', function () { clearDraft(); ui.newCandidate = false; ui.candidatePage = Math.max(0, ui.candidatePage - 1); ui.candidateId = ''; render(); });
    var nextPage = rootNode.querySelector('#dealer-candidate-next');
    if (nextPage) nextPage.addEventListener('click', function () { clearDraft(); ui.newCandidate = false; ui.candidatePage += 1; ui.candidateId = ''; render(); });
  }

  function render() {
    var node = el('dealer-root');
    if (!node) return;
    var desk = api();
    if (!desk || !isLocalPilot()) {
      node.innerHTML = blockedPage('Release 0 controls stay disabled outside the approved localhost synthetic pilot. Open http://127.0.0.1:8765/ for the labelled synthetic review.');
      return;
    }
    var stateResult = currentState();
    if (!stateResult.ok) {
      var recoveryRequired = stateResult.code === 'pending_wal' || stateResult.code === 'recovery_required';
      var retryLabel = recoveryRequired ? 'Recover and retry' : 'Retry safely';
      var failureMessage = ui.message ? '<div class="dealer-message ' + esc(ui.messageTone) + '">' + esc(ui.message) + technicalMarkup(ui.technical) + '</div>' : '';
      node.innerHTML = banner() + failureMessage + '<div class="card dealer-blocked"><h2>Dealer Desk could not load</h2><p>' + esc(resultMessage(stateResult)) + '</p><div class="dealer-actions"><button class="btn btn-primary" id="dealer-retry" type="button">' + retryLabel + '</button>' + (isLocalPilot() && typeof root.__KJR_DEALER_PREVIEW_RESET__ === 'function' ? '<button class="btn btn-ghost" id="dealer-reset-synthetic" type="button">Reset synthetic pilot state</button>' : '') + '</div></div>';
      var retry = node.querySelector('#dealer-retry');
      if (retry) retry.addEventListener('click', async function () {
        if (!recoveryRequired || !desk || typeof desk.recover !== 'function') {
          render();
          return;
        }
        retry.disabled = true;
        retry.textContent = 'Recovering…';
        var recovery;
        try {
          recovery = await desk.recover();
        } catch (error) {
          recovery = { ok: false, code: 'recovery_failed', message: error && error.message || 'Dealer Desk recovery failed' };
        }
        if (recovery && recovery.ok) {
          ui.formDraft = null;
          ui.pending = null;
          ui.technical = null;
          setMessage(recovery.action === 'rolled_back' ? 'Interrupted Dealer Desk work was rolled back safely.' : recovery.action === 'committed' ? 'Pending Dealer Desk work was recovered safely.' : 'Dealer Desk recovery completed safely.', 'success');
        } else {
          ui.technical = { recovery: recovery };
          setMessage(resultMessage(recovery) || 'Recovery could not complete. Review the recovery details and retry.', 'error');
        }
        render();
      });
      var reset = node.querySelector('#dealer-reset-synthetic');
      if (reset) reset.addEventListener('click', resetSyntheticPilot);
      return;
    }
    var state = stateResult.state;
    var candidate = ui.newCandidate ? null : candidateFromState(stateResult);
    if (candidate) ui.candidateId = candidate.id;
    var candidatePage = candidatePageItems(state.candidates);
    var selectMarkup = !ui.newCandidate && state.candidates.length ? '<div class="dealer-candidate-picker"><label class="dealer-select-label">Current candidate<select id="dealer-candidate-select">' + candidatePage.items.map(function (item) { return '<option value="' + esc(item.id) + '"' + (candidate && item.id === candidate.id ? ' selected' : '') + '>' + esc(item.identity.name + ' · ' + item.status) + '</option>'; }).join('') + '</select></label>' + (candidatePage.pageCount > 1 ? '<div class="dealer-pager"><button class="btn btn-ghost btn-sm" id="dealer-candidate-prev" type="button"' + (candidatePage.page === 0 ? ' disabled' : '') + '>Previous</button><span aria-live="polite">Page ' + String(candidatePage.page + 1) + ' of ' + String(candidatePage.pageCount) + '</span><button class="btn btn-ghost btn-sm" id="dealer-candidate-next" type="button"' + (candidatePage.page >= candidatePage.pageCount - 1 ? ' disabled' : '') + '>Next</button></div>' : '') + '</div>' : '';
    node.innerHTML = banner() +
      '<div class="dealer-header"><div><h1>Dealer Desk</h1><p>Release 0 guides one synthetic candidate from identity to manual sale settlement.</p></div>' + selectMarkup + '</div>' +
      (ui.message ? '<div class="dealer-message ' + esc(ui.messageTone) + '">' + esc(ui.message) + technicalMarkup(ui.technical) + '</div>' : '') +
      (ui.newCandidate ? inputMarkup(null) : candidate ? inputMarkup(candidate) + planMarkup(candidate, state) + copyMarkup(candidate, state) + listingMarkup(candidate, state) + outcomeMarkup(candidate, state) + reviewMarkup(candidate, state) : '<div class="card dealer-empty"><h2>No candidates yet</h2><p>Create a candidate or load the clearly labelled synthetic example. Release 0 does not import history.</p><div class="dealer-actions"><button class="btn btn-primary" id="dealer-new-candidate" type="button">New candidate</button><button class="btn btn-ghost" id="dealer-load-synthetic" type="button">Load synthetic candidate</button></div></div>') +
      recoveryMarkup();
    bind(node, candidate, state);
    var exportText = node.querySelector('#dealer-export-json');
    if (exportText) exportText.value = ui.exportText;
    restoreFormDraft();
  }

  root.renderDealerDesk = render;
  if (!root.__dealerDeskUiBound) {
    root.__dealerDeskUiBound = true;
    try { if (typeof MORE_PAGES !== 'undefined') MORE_PAGES.add('dealer'); } catch (error) {}
    if (typeof root.showPage === 'function') {
      var originalShowPage = root.showPage;
      root.showPage = function (name) {
        var output = originalShowPage.apply(this, arguments);
        if (name === 'dealer') render();
        return output;
      };
    }
    if (doc()) {
      doc().addEventListener('DOMContentLoaded', function () {
        if (root.__KJR_DEALER_PREVIEW_RESTRICT_NAV__ === true && typeof root.showPage === 'function') root.showPage('dealer');
        if (el('dealer-root')) render();
      });
    }
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
