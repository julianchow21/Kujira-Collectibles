/* Dealer Desk production presentation. The legacy fixture route remains in
   dealer-ui.js and never shares this controller's store or render state. */
(function (root, factory) {
  const api = factory(root);
  root.DealerProductionUI = api;
  root.renderDealerDeskProduction = function () {
    return api.mount();
  };
}(typeof globalThis !== 'undefined' ? globalThis : this, function createDealerProductionUI(root) {
  'use strict';

  const COMMAND_LABELS = {
    create_candidate: 'Save candidate',
    update_candidate: 'Save candidate changes',
    add_evidence: 'Add evidence',
    create_plan: 'Create buy plan',
    approve_buy: 'Approve buy',
    acquire_copy: 'Acquire copy',
    link_copy: 'Link inventory copy',
    set_asking: 'Set asking price',
    prepare_listing: 'Prepare listing',
    record_sale: 'Record sale',
    settle_sale: 'Confirm settlement',
    record_non_sale: 'Record non-sale',
    review_outcome: 'Review outcome'
  };

  const FIELD_NAMES = ['name', 'set', 'number', 'language', 'variant', 'condition', 'conditionCertainty', 'conditionScenario', 'format', 'grader', 'grade', 'gradeCertainty', 'certificateNumber', 'ownership', 'ownershipReviewed', 'source', 'notes'];
  const COMMANDS = Object.keys(COMMAND_LABELS);

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function text(value, fallback) {
    const result = String(value == null ? '' : value).trim();
    return result || (fallback || '');
  }

  function firstValue(object, keys, fallback) {
    const source = object && typeof object === 'object' ? object : {};
    for (const key of keys) if (source[key] != null && source[key] !== '') return source[key];
    const data = source.data && typeof source.data === 'object' ? source.data : null;
    if (data) for (const key of keys) if (data[key] != null && data[key] !== '') return data[key];
    return fallback;
  }

  function selectedRecord(snapshot, selectedId) {
    if (!snapshot) return null;
    // An empty selection is an intentional new-candidate draft. The initial
    // load selects the first server record explicitly, so never fall back to
    // the server's selected candidate after the user clicks New draft.
    if (selectedId && snapshot.selectedCandidate && String(snapshot.selectedCandidate.id) === String(selectedId)) {
      return Object.assign({}, snapshot.selectedCandidate, { __dealerDetail: snapshot.selectedDetail || null, __dealerCanonicalRefs: snapshot.canonicalRefs || [] });
    }
    if (!selectedId) return null;
    return (snapshot.candidates || []).find(item => item && String(item.id) === String(selectedId)) || null;
  }

  function candidateId(record) {
    return record && record.id != null ? String(record.id) : '';
  }

  function normaliseComparable(value) {
    if (value == null) return '';
    return String(value).trim().toLowerCase();
  }

  function candidateDraftChanged(record, draft) {
    if (!record || !draft || !draft.fields || typeof draft.fields !== 'object') return false;
    return FIELD_NAMES.some(name => {
      if (!Object.prototype.hasOwnProperty.call(draft.fields, name)) return false;
      return normaliseComparable(draft.fields[name]) !== normaliseComparable(firstValue(record, [name, name + 'Value'], ''));
    });
  }

  function fieldValue(record, draft, name) {
    const draftFields = draft && draft.fields && typeof draft.fields === 'object' ? draft.fields : {};
    if (draftFields[name] != null) return draftFields[name];
    if (name === 'ownership') return firstValue(record, [name, name + 'Value'], 'Business');
    if (name === 'ownershipReviewed') return firstValue(record, [name, name + 'Value'], 'false');
    return firstValue(record, [name, name + 'Value'], '');
  }

  function stageValue(draft, name, fallback) {
    const stage = draft && draft.stage && typeof draft.stage === 'object' ? draft.stage : {};
    return stage[name] != null ? stage[name] : (fallback == null ? '' : fallback);
  }

  function approvedPlanEntities(record) {
    const detail = record && record.__dealerDetail && typeof record.__dealerDetail === 'object' ? record.__dealerDetail : {};
    return (Array.isArray(detail.plans) ? detail.plans : [])
      .filter(item => String(firstValue(item, ['status', 'state'], '')).toLowerCase() === 'approved')
      .sort((left, right) => Number(firstValue(right, ['row_version', 'version'], 0)) - Number(firstValue(left, ['row_version', 'version'], 0)));
  }

  function approvedPlanOptions(record, draft) {
    const plans = approvedPlanEntities(record);
    if (!plans.length) return '';
    const options = plans.map(plan => {
      const id = firstValue(plan, ['id', 'planId', 'plan_id'], '');
      const data = plan && plan.data && typeof plan.data === 'object' ? plan.data : plan;
      const expected = firstValue(data, ['expected'], null) || {};
      const amount = firstValue(expected, ['saleAmount', 'expectedSaleAmount', 'expectedSale'], null);
      const currency = firstValue(data, ['reportingCurrency', 'currency'], null) || firstValue(expected, ['currency'], 'SGD');
      const revision = firstValue(plan, ['approvedAt', 'approved_at'], null) || firstValue(data, ['approvedAt', 'approved_at'], null);
      const label = 'Approved plan' + (revision ? ' · ' + String(revision).slice(0, 10) : '') + (amount != null ? ' · expected sale ' + amount + ' ' + currency : '');
      return '<option value="' + escapeHtml(id) + '"' + (String(stageValue(draft, 'supersedesPlanId', '')) === String(id) ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }).join('');
    return '<label class="dealer-production-wide"><span>Approved plan to revise</span><select data-stage-field="supersedesPlanId"><option value="">Choose only when revising an approved plan</option>' + options + '</select><small class="dealer-production-help">A revised plan needs a reason and fresh approval. A confirmed copy freezes the approved plan.</small></label>';
  }

  function latestFromArray(items) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    return list.reduce((latest, item) => {
      if (!latest) return item;
      const latestVersion = Number(firstValue(latest, ['row_version', 'rowVersion', 'version'], 0));
      const itemVersion = Number(firstValue(item, ['row_version', 'rowVersion', 'version'], 0));
      if (Number.isFinite(itemVersion) && Number.isFinite(latestVersion) && itemVersion !== latestVersion) return itemVersion > latestVersion ? item : latest;
      const latestAt = Date.parse(String(firstValue(latest, ['updated_at', 'updatedAt', 'created_at', 'createdAt'], '')));
      const itemAt = Date.parse(String(firstValue(item, ['updated_at', 'updatedAt', 'created_at', 'createdAt'], '')));
      return Number.isFinite(itemAt) && (!Number.isFinite(latestAt) || itemAt > latestAt) ? item : latest;
    }, null);
  }

  function latestEntity(record, collection) {
    const detail = record && record.__dealerDetail;
    return latestFromArray(detail && Array.isArray(detail[collection]) ? detail[collection] : []);
  }

  function planEntity(record) {
    const detail = record && record.__dealerDetail;
    const plans = detail && Array.isArray(detail.plans) ? detail.plans : [];
    const copy = latestEntity(record, 'copy');
    const frozenId = firstValue(copy, ['approvedPlanId', 'approved_plan_id'], null) || firstValue(record, ['approvedPlanId', 'approved_plan_id'], null);
    if (frozenId) {
      const frozen = plans.find(item => String(firstValue(item, ['id', 'planId', 'plan_id'], '')) === String(frozenId));
      if (frozen) return frozen;
    }
    const drafts = plans.filter(item => String(firstValue(item, ['status', 'state'], '')).toLowerCase() === 'draft');
    return latestFromArray(drafts) || latestFromArray(plans);
  }

  function reference(record, type) {
    if (!record || typeof record !== 'object') return null;
    let value = type === 'inventory'
      ? firstValue(record, ['inventoryRef', 'inventory_ref', 'copyRef', 'copy_ref'], null)
      : firstValue(record, ['saleRef', 'sale_ref'], null);
    if (!value && record.__dealerDetail) {
      const copy = latestEntity(record, 'copy');
      const outcome = latestEntity(record, 'outcomes');
      const refs = Array.isArray(record.__dealerCanonicalRefs) ? record.__dealerCanonicalRefs : [];
      if (type === 'inventory') value = (copy && firstValue(copy, ['itemRef', 'item_ref'], null)) || (refs[0] && { table: refs[0].inventoryTable, id: refs[0].inventoryId });
      else value = (outcome && firstValue(outcome, ['saleRef', 'sale_ref'], null)) ||
        (outcome && firstValue(outcome, ['saleId', 'sale_id'], null) ? { table: 'sales', id: firstValue(outcome, ['saleId', 'sale_id'], null) } : null) ||
        (refs[0] && refs[0].saleId ? { table: 'sales', id: refs[0].saleId } : null);
    }
    if (!value || typeof value !== 'object') return null;
    const id = firstValue(value, ['id', 'rowId', 'row_id'], null);
    if (id == null || id === '') return null;
    return { id: String(id), table: firstValue(value, ['table', 'tableName', 'table_name', 'inventoryTable'], type === 'inventory' ? 'singles' : 'sales') };
  }

  function statusLabel(record) {
    return text(firstValue(record, ['stage', 'status', 'state'], null), 'Candidate');
  }

  function expectedVersions(record) {
    if (!record) return {};
    const detail = record.__dealerDetail || {};
    const plan = planEntity(record);
    const copy = latestEntity(record, 'copy');
    const listing = latestEntity(record, 'listings');
    const outcome = latestEntity(record, 'outcomes');
    const sale = firstValue(outcome, ['sale', 'saleRecord', 'sale_record'], null) || firstValue(record, ['sale', 'saleRecord', 'sale_record'], null);
    const refs = Array.isArray(record.__dealerCanonicalRefs) ? record.__dealerCanonicalRefs : [];
    const candidateVersion = firstValue(record, ['candidateVersion', 'candidate_version', 'row_version', 'version'], null);
    const planVersion = firstValue(plan, ['row_version', 'planVersion', 'plan_version', 'version'], null);
    const copyVersion = firstValue(copy, ['row_version', 'copyVersion', 'copy_version', 'version'], null);
    const listingVersion = firstValue(listing, ['row_version', 'listingVersion', 'listing_version', 'version'], null);
    const outcomeVersion = firstValue(outcome, ['row_version', 'outcomeVersion', 'outcome_version', 'version'], null);
    const canonicalVersion = firstValue(refs[0], ['canonicalRowVersion', 'canonical_row_version', 'row_version'], null);
    const saleVersion = firstValue(outcome, ['saleRowVersion', 'sale_row_version', 'saleVersion', 'sale_version'], null) ||
      firstValue(sale, ['row_version', 'saleRowVersion', 'sale_row_version', 'saleVersion', 'sale_version'], null) ||
      firstValue(refs[0], ['saleRowVersion', 'sale_row_version'], null);
    const result = {};
    if (candidateVersion != null && Number.isSafeInteger(Number(candidateVersion))) result.candidate = Number(candidateVersion);
    if (planVersion != null && Number.isSafeInteger(Number(planVersion))) result.plan = Number(planVersion);
    if (copyVersion != null && Number.isSafeInteger(Number(copyVersion))) result.copy = Number(copyVersion);
    if (listingVersion != null && Number.isSafeInteger(Number(listingVersion))) result.listing = Number(listingVersion);
    if (outcomeVersion != null && Number.isSafeInteger(Number(outcomeVersion))) result.outcome = Number(outcomeVersion);
    if (canonicalVersion != null && Number.isSafeInteger(Number(canonicalVersion))) result.canonical = Number(canonicalVersion);
    if (saleVersion != null && Number.isSafeInteger(Number(saleVersion))) result.sale = Number(saleVersion);
    return result;
  }

  function sourceLabel(view) {
    if (!view || !view.snapshot) return 'Waiting for the server';
    if (!view.stale) return 'Online, server-confirmed records';
    const fetchedAt = view.snapshot.fetchedAt || view.snapshot.fetched_at;
    if (!fetchedAt) return 'Stale server snapshot, last confirmed time unavailable';
    let shown = String(fetchedAt);
    try {
      const date = new Date(fetchedAt);
      if (Number.isFinite(date.getTime())) {
        shown = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Singapore', day: '2-digit', month: '2-digit', year: 'numeric',
          hour: '2-digit', minute: '2-digit', hour12: false
        }).format(date).replace(',', '');
      }
    } catch (_) {}
    return 'Stale server snapshot, last confirmed ' + shown + ' Singapore time';
  }

  function statusMessage(message) {
    if (!message) return '';
    return '<div class="dealer-production-message ' + escapeHtml(message.tone || 'info') + '" role="status">' +
      '<strong>' + escapeHtml(message.title || 'Dealer Desk') + '</strong>' +
      '<span>' + escapeHtml(message.text || '') + '</span>' +
      (message.detail ? '<details class="dealer-production-technical"><summary>Technical details</summary><pre>' + escapeHtml(message.detail) + '</pre></details>' : '') +
      (message.action === 'retry' && message.commandId ? '<button class="btn btn-sm" data-action="retry" data-command-id="' + escapeHtml(message.commandId) + '">Retry same command</button>' : '') +
      (message.action === 'dismiss' && message.commandId ? '<button class="btn btn-sm" data-action="dismiss-pending" data-command-id="' + escapeHtml(message.commandId) + '">Dismiss attempted command</button>' : '') +
      '</div>';
  }

  function linkMarkup(record, type) {
    const ref = reference(record, type);
    const label = type === 'inventory' ? 'Inventory copy' : 'Sale record';
    if (!ref) return '<span class="dealer-production-unlinked">' + label + ': not linked on the server</span>';
    const page = type === 'inventory' ? (String(ref.table).toLowerCase() === 'slabs' ? 'slabs' : 'inventory') : 'sales';
    const actionLabel = type === 'inventory'
      ? 'Open linked ' + (page === 'slabs' ? 'Slabs' : 'Singles') + ' copy'
      : 'Open linked sale record';
    return '<a href="#" class="dealer-production-link" data-navigate-page="' + page + '" data-ref-table="' + escapeHtml(ref.table) + '" data-ref-id="' + escapeHtml(ref.id) + '" aria-label="' + escapeHtml(actionLabel) + '">' +
      escapeHtml(actionLabel) + '</a>';
  }

  function focusCoreRow(page, table, id) {
    if (!root.document || !id) return;
    const bodyIds = page === 'sales'
      ? ['sales-body']
      : page === 'slabs'
        ? ['slabs-body', 'slabs-sold-body']
        : ['singles-body', 'singles-sold-body'];
    setTimeout(() => {
      let row = null;
      bodyIds.some(bodyId => {
        const body = root.document.getElementById(bodyId);
        if (!body || typeof body.querySelectorAll !== 'function') return false;
        row = Array.from(body.querySelectorAll('[data-id]')).find(item => String(item.getAttribute('data-id') || '') === String(id)) || null;
        return !!row;
      });
      if (!row) return;
      if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      row.style.outline = '2px solid var(--accent)';
      row.style.outlineOffset = '-2px';
      setTimeout(() => { row.style.outline = ''; row.style.outlineOffset = ''; }, 2500);
    }, 320);
  }

  function safeHttpUrl(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!/^https?:\/\//i.test(raw)) return null;
    try {
      const parsed = new URL(raw);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch (_) { return null; }
  }

  function manualReferenceMarkup(value, label) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return '';
    const safeUrl = safeHttpUrl(raw);
    if (!safeUrl) return '<span class="dealer-production-reference">' + escapeHtml(label + ': ' + raw) + '</span>';
    return '<a class="dealer-production-reference" href="' + escapeHtml(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(label) + '</a>';
  }

  function confirmedReferenceMarkup(record) {
    const detail = record && record.__dealerDetail;
    if (!detail) return '';
    const evidence = latestEntity(record, 'evidence');
    const outcome = latestEntity(record, 'outcomes');
    const settlement = firstValue(outcome, ['settlementEvidence', 'settlement_evidence'], null);
    const settlementValue = settlement && typeof settlement === 'object'
      ? firstValue(settlement, ['url', 'reference', 'proof', 'source', 'note'], null)
      : settlement;
    return '<div class="dealer-production-references">' +
      manualReferenceMarkup(firstValue(evidence, ['url', 'reference', 'proof'], null), 'Evidence') +
      manualReferenceMarkup(settlementValue, 'Settlement evidence') +
    '</div>';
  }

  function settlementMarkup(record) {
    const outcome = latestEntity(record, 'outcomes');
    const settlement = record && (record.settlement || record.settlementState || record.settlement_state || (outcome && firstValue(outcome, ['paymentStatus', 'payment_status', 'settlement'], null)));
    const state = text(settlement && typeof settlement === 'object' ? firstValue(settlement, ['status', 'state'], '') : settlement, 'Unknown');
    if (state.toLowerCase() === 'settled' || state.toLowerCase() === 'confirmed') {
      return '<div class="dealer-production-settlement"><strong>Settlement confirmed</strong><span>Financial results may use the server-confirmed settlement.</span></div>';
    }
    return '<div class="dealer-production-settlement"><strong>Settlement ' + escapeHtml(state) + '</strong><span>Contribution stays unavailable until settlement is confirmed.</span></div>';
  }

  function moneyAmount(value) {
    if (value == null || value === '') return null;
    if (typeof value === 'object') {
      const status = String(firstValue(value, ['status', 'state'], '') || '').toLowerCase();
      if (status && status !== 'known' && status !== 'confirmed' && status !== 'settled') return null;
      value = firstValue(value, ['amount', 'value', 'total', 'number'], null);
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function moneyDisplay(value, currency) {
    const amount = moneyAmount(value);
    if (amount == null) return 'Unknown';
    const code = String(currency || 'SGD').toUpperCase();
    try {
      return new Intl.NumberFormat('en-SG', { style: 'currency', currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount);
    } catch (_) {
      return code + ' ' + amount.toFixed(2);
    }
  }

  function plannedActualMarkup(record) {
    const detail = record && record.__dealerDetail;
    if (!detail) return '';
    const plan = planEntity(record);
    const outcome = latestEntity(record, 'outcomes');
    const review = latestEntity(record, 'reviews');
    if (!plan && !outcome && !review) return '';
    const planData = (plan && plan.data) || plan || {};
    const expected = firstValue(planData, ['expected'], null) || {};
    const actual = firstValue(review, ['actual'], null) || firstValue(outcome, ['dealerActual', 'actual'], null) || {};
    const currency = firstValue(planData, ['reportingCurrency', 'currency'], null) || firstValue(expected, ['currency'], null) || firstValue(outcome, ['currency'], 'SGD');
    const paymentStatus = text(firstValue(outcome, ['paymentStatus', 'payment_status', 'settlement'], null), 'Unknown');
    const settled = ['settled', 'confirmed'].includes(paymentStatus.toLowerCase());
    const readiness = detail.readiness && typeof detail.readiness === 'object' ? detail.readiness : {};
    const readinessText = readiness.ready === true ? 'Ready' : readiness.ready === false ? 'Not ready' : 'Unknown';
    const readinessLabels = {
      evidence_required: 'Evidence required',
      evidence_detail_required: 'Evidence details required',
      business_ownership_review_required: 'Business ownership review required',
      condition_required: 'Condition required',
      condition_scenario_required: 'Condition scenario required',
      grade_certainty_required: 'Grade certainty required',
      grade_basis_required: 'Grade basis required',
      grade_evidence_required: 'Grade evidence required'
    };
    const blockers = Array.isArray(readiness.blockers) ? readiness.blockers.map(item => readinessLabels[item] || item).filter(Boolean) : [];
    const readinessValue = readinessText + (blockers.length ? ' · ' + blockers.join(', ') : '');
    const plannedRows = [
      ['Expected sale', firstValue(expected, ['saleAmount', 'expectedSaleAmount', 'expectedSale'], null)],
      ['Expected net proceeds', firstValue(expected, ['expectedNetProceeds', 'netProceeds'], null)],
      ['Maximum all-in acquisition cost', firstValue(expected, ['maximumAllInAcquisitionCostRounded', 'maximumAllInAcquisitionCost', 'maximumAllIn'], null)],
      ['Maximum item price', firstValue(expected, ['itemPriceCeiling', 'itemCeiling', 'rawItemPriceCeiling'], null)],
      ['Planned item cost', firstValue(planData, ['plannedItemCost'], null)],
      ['Planned landed cost', firstValue(planData, ['plannedLandedCost'], null)],
      ['Planned contribution', firstValue(expected, ['plannedContribution'], null)],
      ['Target contribution', firstValue(expected, ['targetContribution'], null)],
      ['Buy-plan readiness', readinessValue]
    ];
    const actualRows = [
      ['Actual proceeds', settled ? firstValue(actual, ['proceeds', 'totalCollected', 'revenue'], null) : null],
      ['Actual contribution', settled ? firstValue(actual, ['contribution', 'profit'], null) : null],
      ['Plan variance', settled ? firstValue(review, ['planVariance'], null) : null],
      ['Target variance', settled ? firstValue(review, ['targetVariance'], null) : null]
    ];
    const rows = plannedRows.concat(actualRows).map(row => {
      const raw = row[1];
      const display = row[0] === 'Buy-plan readiness' ? String(raw || 'Unknown') : (row[0] === 'Plan variance' || row[0] === 'Target variance') && raw && typeof raw === 'object'
        ? moneyDisplay(firstValue(raw, ['delta', 'variance'], null), currency)
        : moneyDisplay(raw, currency);
      return '<div><dt>' + escapeHtml(row[0]) + '</dt><dd>' + escapeHtml(display) + '</dd></div>';
    }).join('');
    return '<div class="dealer-review-summary"><strong>Plan and confirmed result</strong><dl class="dealer-money-summary">' + rows + '</dl><p>Settlement status: ' + escapeHtml(paymentStatus) + (settled ? '' : ', financial actuals remain Unknown until the server confirms settlement') + '.</p></div>';
  }

  function formFields(record, draft) {
    const labels = { name: 'Candidate name', set: 'Set', number: 'Number', language: 'Language', variant: 'Variant', condition: 'Condition', grader: 'Grader', grade: 'Grade', certificateNumber: 'Certificate number', format: 'Format', gradeCertainty: 'Grade certainty', conditionCertainty: 'Condition certainty', conditionScenario: 'Condition scenario', ownership: 'Ownership', source: 'Source' };
    return FIELD_NAMES.map(name => {
      if (name === 'ownershipReviewed') {
        return '<label class="dealer-production-checkbox-field"><span class="dealer-production-check"><input type="checkbox" data-dealer-field="ownershipReviewed"' +
          (fieldValue(record, draft, name) === true || String(fieldValue(record, draft, name)).toLowerCase() === 'true' ? ' checked' : '') + '> Business ownership reviewed</span></label>';
      }
      if (name === 'format' || name === 'gradeCertainty' || name === 'conditionCertainty') {
        const options = name === 'format'
          ? [['', 'Choose format'], ['raw', 'Raw / ungraded'], ['slab', 'Slab / graded']]
          : name === 'gradeCertainty'
            ? [['', 'Choose grade certainty'], ['known', 'Known from evidence'], ['verified', 'Verified by evidence'], ['uncertain', 'Uncertain']]
            : [['', 'Choose condition certainty'], ['confirmed', 'Confirmed'], ['estimated', 'Estimated'], ['uncertain', 'Uncertain'], ['unknown', 'Unknown']];
        return '<label><span>' + escapeHtml(labels[name]) + '</span><select data-dealer-field="' + name + '">' + options.map(option => '<option value="' + escapeHtml(option[0]) + '"' + (String(fieldValue(record, draft, name)) === option[0] ? ' selected' : '') + '>' + escapeHtml(option[1]) + '</option>').join('') + '</select></label>';
      }
      return '<label><span>' + escapeHtml(labels[name] || name) + '</span>' +
        (name === 'ownership'
          ? '<select data-dealer-field="ownership"><option value="Business"' + (fieldValue(record, draft, name) === 'Business' ? ' selected' : '') + '>Business</option><option value="Personal"' + (fieldValue(record, draft, name) === 'Personal' ? ' selected' : '') + '>Personal</option><option value="Unknown"' + (fieldValue(record, draft, name) === 'Unknown' ? ' selected' : '') + '>Unknown</option></select>'
          : name === 'notes'
          ? '<textarea data-dealer-field="' + name + '" rows="3" maxlength="4000" placeholder="Keep source notes here">' + escapeHtml(fieldValue(record, draft, name)) + '</textarea>'
          : '<input data-dealer-field="' + name + '" maxlength="240" value="' + escapeHtml(fieldValue(record, draft, name)) + '">') +
        '</label>';
    }).join('');
  }

  function stageFields(draft, inventoryOptions, actionMarkup, record) {
    const value = (name, fallback) => escapeHtml(stageValue(draft, name, fallback));
    const selected = (name, option) => stageValue(draft, name, '') === option ? ' selected' : '';
    const checked = name => stageValue(draft, name, '') === 'true' ? ' checked' : '';
    const picker = inventoryOptions || '<option value="">Choose a reviewed copy from authenticated stock</option>';
    const actions = typeof actionMarkup === 'function' ? actionMarkup : () => '';
    const input = (name, label, options) => '<label><span>' + label + '</span><input data-stage-field="' + name + '"' +
      (options && options.inputmode ? ' inputmode="' + options.inputmode + '"' : '') +
      (options && options.maxlength ? ' maxlength="' + options.maxlength + '"' : ' maxlength="240"') +
      ' value="' + value(name, options && options.fallback) + '"' +
      (options && options.placeholder ? ' placeholder="' + options.placeholder + '"' : '') + '></label>';
    const select = (name, label, options) => '<label><span>' + label + '</span><select data-stage-field="' + name + '">' +
      options.map(option => '<option value="' + escapeHtml(option[0]) + '"' + selected(name, option[0]) + '>' + escapeHtml(option[1]) + '</option>').join('') +
      '</select></label>';
    return '<div class="dealer-production-stages">' +
      '<fieldset class="dealer-production-stage"><legend>1. Evidence and provenance</legend><p class="dealer-production-help">Record where the identity, condition and ownership decision came from.</p><div class="dealer-production-stage-fields">' +
        select('evidenceClass', 'Evidence class', [['identity', 'Identity'], ['condition', 'Condition'], ['provenance', 'Provenance'], ['pricing', 'Pricing']]) +
        input('evidenceRef', 'Evidence reference', { maxlength: 1000, placeholder: 'URL or receipt reference' }) +
        select('evidenceMatch', 'Evidence match', [['confirmed', 'Confirmed'], ['partial', 'Partial'], ['unconfirmed', 'Unconfirmed']]) +
        select('evidenceConfidence', 'Confidence', [['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]) +
        input('evidenceDate', 'Observed date', { maxlength: 10, inputmode: 'numeric', placeholder: 'DD/MM/YYYY' }) +
        '<label class="dealer-production-wide"><span>Evidence rationale</span><textarea data-stage-field="evidenceRationale" maxlength="4000" rows="3" placeholder="What the evidence confirms and what remains uncertain">' + value('evidenceRationale') + '</textarea></label>' +
      '</div>' + actions('add_evidence') + '</fieldset>' +
      '<fieldset class="dealer-production-stage"><legend>2. Buy plan</legend><p class="dealer-production-help">Enter each known assumption explicitly. The server calculates readiness and the maximum buy amount.</p><div class="dealer-production-stage-fields">' +
        input('planReason', 'Plan reason', { maxlength: 1000, placeholder: 'Why this buy makes sense' }) +
        input('expectedSaleAmount', 'Expected sale amount', { inputmode: 'decimal', maxlength: 40, placeholder: 'Amount in reporting currency' }) +
        input('expectedSellingFee', 'Expected selling fee', { inputmode: 'decimal', maxlength: 40 }) +
        input('expectedOutboundShipping', 'Expected outbound shipping', { inputmode: 'decimal', maxlength: 40 }) +
        input('expectedRefundAllowance', 'Expected refund allowance', { inputmode: 'decimal', maxlength: 40 }) +
        input('otherExpectedDeductions', 'Other expected deductions', { inputmode: 'decimal', maxlength: 40 }) +
        input('targetContribution', 'Target contribution', { inputmode: 'decimal', maxlength: 40 }) +
        input('targetMargin', 'Target margin', { inputmode: 'decimal', maxlength: 40, placeholder: 'Percentage or decimal' }) +
        input('riskAllowance', 'Risk allowance', { inputmode: 'decimal', maxlength: 40 }) +
        input('knownNonItemAcquisitionCosts', 'Known non-item acquisition costs', { inputmode: 'decimal', maxlength: 40 }) +
        input('plannedItemCost', 'Planned item cost', { inputmode: 'decimal', maxlength: 40 }) +
        input('conditionScenario', 'Condition / grade scenario', { maxlength: 500, placeholder: 'For example, raw near mint or PSA 10' }) +
        input('reportingCurrency', 'Reporting currency', { maxlength: 8, fallback: 'SGD' }) +
        approvedPlanOptions(record, draft) +
        input('revisionReason', 'Revision reason', { maxlength: 1000, placeholder: 'Required when revising an approved plan' }) +
      '</div>' + actions('create_plan', 'approve_buy') + '</fieldset>' +
      '<fieldset class="dealer-production-stage"><legend>3. Acquisition</legend><p class="dealer-production-help">Acquire a new server-created inventory copy, or link one exact reviewed stock row.</p><div class="dealer-production-stage-fields">' +
        select('copyMode', 'Copy route', [['new', 'Acquire new server-created inventory copy'], ['existing', 'Link reviewed existing copy']]) +
        select('acquisitionTable', 'New copy table', [['singles', 'Singles'], ['slabs', 'Slabs']]) +
        '<label class="dealer-production-wide"><span>Existing reviewed copy</span><select data-stage-field="inventoryRef">' + picker + '</select><small class="dealer-production-help">Required only for linking existing stock. The server checks the selected record and reviewed cost before linking.</small></label>' +
        input('copyCost', 'Reviewed stock cost', { inputmode: 'decimal', maxlength: 40, placeholder: 'Exact reviewed cost' }) +
        input('copyCurrency', 'Cost currency', { maxlength: 8, fallback: 'SGD' }) +
        input('nonItemAcquisitionCosts', 'Non-item acquisition costs', { inputmode: 'decimal', maxlength: 40 }) +
        input('copyCostReason', 'Cost review reason', { maxlength: 1000, placeholder: 'Why this cost is confirmed' }) +
        input('copyCostDate', 'Cost review date', { maxlength: 10, inputmode: 'numeric', placeholder: 'DD/MM/YYYY' }) +
        input('settledCopyCost', 'Settled SGD cost', { inputmode: 'decimal', maxlength: 40, placeholder: 'Required when foreign cost is settled' }) +
        input('settledNonItemAcquisitionCosts', 'Settled non-item costs', { inputmode: 'decimal', maxlength: 40, placeholder: 'Required for a foreign cost' }) +
        input('settledAmount', 'Settled total cost', { inputmode: 'decimal', maxlength: 40, placeholder: 'Item plus non-item cost in SGD' }) +
        input('fxDirection', 'FX direction', { maxlength: 16, placeholder: 'JPY_SGD' }) +
        input('fxRate', 'FX rate', { inputmode: 'decimal', maxlength: 40, placeholder: 'Positive rate' }) +
        input('fxSource', 'FX source', { maxlength: 500, placeholder: 'Source or receipt' }) +
        input('fxAt', 'FX observed at', { maxlength: 40, placeholder: 'YYYY-MM-DDTHH:MM:SS+08:00' }) +
        '<label class="dealer-production-wide"><span class="dealer-production-check"><input type="checkbox" data-stage-field="inheritCost"' + checked('inheritCost') + '> Confirm reviewed cost once</span></label>' +
      '</div>' + actions('acquire_copy', 'link_copy') + '</fieldset>' +
      '<fieldset class="dealer-production-stage"><legend>4. Listing</legend><p class="dealer-production-help">Prepare the listing against the confirmed copy. Existing listing identity is retained when supplied by the server.</p><div class="dealer-production-stage-fields">' +
        input('platform', 'Platform', { maxlength: 80, placeholder: 'Carousell, eBay, direct' }) +
        input('channel', 'Channel', { maxlength: 80, placeholder: 'Selling channel' }) +
        input('askingAmount', 'Asking amount', { inputmode: 'decimal', maxlength: 40 }) +
        input('currency', 'Currency', { maxlength: 8, fallback: 'SGD' }) +
        '<label class="dealer-production-wide"><span>Listing notes</span><textarea data-stage-field="listingNotes" maxlength="4000" rows="3" placeholder="Listing or handover notes">' + value('listingNotes') + '</textarea></label>' +
      '</div>' + actions('set_asking', 'prepare_listing') + '</fieldset>' +
      '<fieldset class="dealer-production-stage"><legend>5. Sale and settlement</legend><p class="dealer-production-help">A recorded sale remains financially Unknown until the server confirms settlement with explicit charges.</p><div class="dealer-production-stage-fields">' +
        input('saleAmount', 'Agreed sale amount', { inputmode: 'decimal', maxlength: 40 }) +
        input('saleDate', 'Sale date', { maxlength: 10, inputmode: 'numeric', placeholder: 'DD/MM/YYYY' }) +
        input('settlementRef', 'Settlement reference', { maxlength: 500, placeholder: 'Receipt or payment reference' }) +
        input('settlementDate', 'Settlement date', { maxlength: 10, inputmode: 'numeric', placeholder: 'DD/MM/YYYY' }) +
        input('proceeds', 'Settled proceeds', { inputmode: 'decimal', maxlength: 40 }) +
        input('sellingFee', 'Selling fee', { inputmode: 'decimal', maxlength: 40 }) +
        input('outboundShipping', 'Outbound shipping', { inputmode: 'decimal', maxlength: 40 }) +
        input('nonSaleReason', 'Non-sale reason', { maxlength: 1000, placeholder: 'Required only for non-sale outcome' }) +
        '<label class="dealer-production-wide"><span>Sale and settlement notes</span><textarea data-stage-field="outcomeNotes" maxlength="4000" rows="3" placeholder="Payment or outcome notes">' + value('outcomeNotes') + '</textarea></label>' +
      '</div>' + actions('record_sale', 'settle_sale', 'record_non_sale') + '</fieldset>' +
      '<fieldset class="dealer-production-stage"><legend>6. Outcome review</legend><p class="dealer-production-help">Close the journey after the server confirms the actual result. Unknown settlement values stay Unknown.</p><div class="dealer-production-stage-fields">' +
        input('reviewCause', 'Review cause', { maxlength: 1000, placeholder: 'What happened and why' }) +
        select('restockDecision', 'Restock decision', [['', 'Choose a decision'], ['restock', 'Restock'], ['hold', 'Hold for review'], ['retire', 'Retire']]) +
        input('restockDate', 'Restock decision date', { maxlength: 10, inputmode: 'numeric', placeholder: 'DD/MM/YYYY' }) +
        '<label class="dealer-production-wide"><span>Review notes</span><textarea data-stage-field="reviewNotes" maxlength="4000" rows="3" placeholder="What you learned from the result">' + value('reviewNotes') + '</textarea></label>' +
      '</div>' + actions('review_outcome') + '</fieldset>' +
      '</div>';
  }

  function detailEntity(record, collection, fallback) {
    const detail = record && record.__dealerDetail && Array.isArray(record.__dealerDetail[collection]) ? record.__dealerDetail[collection] : [];
    return latestFromArray(detail) || fallback || null;
  }

  function reviewedCostPayload(fields) {
    const amount = fields.copyCost || fields.inventoryCost || '';
    const currency = String(fields.inventoryCurrency || fields.copyCurrency || fields.currency || 'SGD').toUpperCase();
    const cost = { confirmed: true, currency, itemCost: amount };
    if (fields.copyCostReason) cost.reason = fields.copyCostReason;
    if (fields.copyCostDate) cost.reviewedAt = settlementTimestamp(fields.copyCostDate);
    if (fields.nonItemAcquisitionCosts != null && fields.nonItemAcquisitionCosts !== '') cost.nonItemAcquisitionCosts = fields.nonItemAcquisitionCosts;
    if (currency !== 'SGD') {
      if (fields.settledCopyCost) cost.settledItemCost = fields.settledCopyCost;
      if (fields.settledNonItemAcquisitionCosts != null && fields.settledNonItemAcquisitionCosts !== '') cost.settledNonItemAcquisitionCosts = fields.settledNonItemAcquisitionCosts;
      if (fields.settledAmount) cost.settledAmount = fields.settledAmount;
      cost.settledCurrency = 'SGD';
      if (fields.fxDirection) cost.fxDirection = fields.fxDirection;
      if (fields.fxRate) cost.fxRate = fields.fxRate;
      if (fields.fxSource) cost.fxSource = fields.fxSource;
      if (fields.fxAt) cost.fxAt = fields.fxAt;
    }
    return cost;
  }

  function settlementTimestamp(value) {
    const input = String(value || '').trim();
    const match = input.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (match) {
      const year = Number(match[3]);
      const month = Number(match[2]);
      const day = Number(match[1]);
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      if (month < 1 || month > 12 || day < 1 || day > lastDay) return '';
      // Date-only inputs represent a Singapore calendar day. Midnight is a
      // valid past timestamp even when the user records today's settlement,
      // avoiding a future rejection caused by 23:59:59.
      return match[3] + '-' + match[2] + '-' + match[1] + 'T00:00:00+08:00';
    }
    return input;
  }

  function stagePayload(command, record, fields) {
    const id = candidateId(record);
    const plan = command === 'approve_buy' ? planEntity(record) : detailEntity(record, 'plans');
    const copy = detailEntity(record, 'copy');
    const outcome = detailEntity(record, 'outcomes');
    const copyId = firstValue(copy, ['id', 'copyId', 'copy_id'], fields.copyId || null);
    const outcomeId = firstValue(outcome, ['id', 'outcomeId', 'outcome_id'], fields.outcomeId || null);
    switch (command) {
      case 'add_evidence': return { candidateId: id, evidence: { class: fields.evidenceClass, source: fields.evidenceRef, match: fields.evidenceMatch, confidence: fields.evidenceConfidence, rationale: fields.evidenceRationale, observedAt: settlementTimestamp(fields.evidenceDate) } };
      case 'create_plan': {
        const planPayload = {
          candidateId: id,
          plan: { reason: fields.planReason, expectedSaleAmount: fields.expectedSaleAmount, expectedSellingFee: fields.expectedSellingFee, expectedOutboundShipping: fields.expectedOutboundShipping, expectedRefundAllowance: fields.expectedRefundAllowance, otherExpectedDeductions: fields.otherExpectedDeductions, targetContribution: fields.targetContribution, targetMargin: fields.targetMargin, riskAllowance: fields.riskAllowance, knownNonItemAcquisitionCosts: fields.knownNonItemAcquisitionCosts, plannedItemCost: fields.plannedItemCost, conditionScenario: fields.conditionScenario, reportingCurrency: fields.reportingCurrency || 'SGD' }
        };
        if (fields.revisionReason) planPayload.revisionReason = fields.revisionReason;
        if (fields.supersedesPlanId) planPayload.supersedesPlanId = fields.supersedesPlanId;
        return planPayload;
      }
      case 'approve_buy': {
        const approvalPayload = { candidateId: id, planId: firstValue(plan, ['id', 'planId', 'plan_id'], fields.planId || null), approval: { reason: fields.planReason } };
        const supersedesPlanId = firstValue(plan, ['supersedesPlanId', 'supersedes_plan_id'], fields.supersedesPlanId || null);
        if (supersedesPlanId) approvalPayload.supersedesPlanId = supersedesPlanId;
        return approvalPayload;
      }
      case 'acquire_copy': return { candidateId: id, inventoryTable: fields.acquisitionTable || fields.inventoryTable, reviewedCost: reviewedCostPayload(fields), cost: fields.copyCost || fields.inventoryCost || null, notes: fields.outcomeNotes };
      case 'link_copy': return { candidateId: id, inventoryTable: fields.inventoryTable, inventoryId: fields.inventoryId, reviewedCost: reviewedCostPayload(fields), cost: fields.copyCost || fields.inventoryCost || null };
      case 'set_asking': return { copyId, listingId: firstValue(detailEntity(record, 'listings'), ['id', 'listingId', 'listing_id'], null), asking: { amount: fields.askingAmount, currency: fields.currency || 'SGD' } };
      case 'prepare_listing': return { candidateId: id, copyId, listingId: firstValue(detailEntity(record, 'listings'), ['id', 'listingId', 'listing_id'], null), listing: { notes: fields.listingNotes || fields.outcomeNotes, platform: fields.platform, channel: fields.channel, asking: { amount: fields.askingAmount, currency: fields.currency || 'SGD' } } };
      case 'record_sale': return { candidateId: id, copyId, saleId: fields.saleId || null, outcomeId: fields.outcomeId || null, sale: { agreedAmount: fields.saleAmount, currency: fields.currency || 'SGD', soldAt: settlementTimestamp(fields.saleDate) }, agreedAmount: fields.saleAmount, currency: fields.currency || 'SGD', soldAt: settlementTimestamp(fields.saleDate) };
      case 'settle_sale': return { outcomeId, saleId: fields.saleId || null, settlementEvidence: { class: 'manual', reference: fields.settlementRef, note: fields.outcomeNotes, date: settlementTimestamp(fields.settlementDate) }, cashSettledAt: settlementTimestamp(fields.settlementDate), currency: fields.currency || 'SGD', proceeds: fields.proceeds, sellingFee: fields.sellingFee, outboundShipping: fields.outboundShipping };
      case 'record_non_sale': return { copyId, reason: fields.nonSaleReason, nonSale: { reason: fields.nonSaleReason, notes: fields.outcomeNotes } };
      case 'review_outcome': return { outcomeId, review: { cause: fields.reviewCause, notes: fields.reviewNotes || fields.outcomeNotes }, restockDecision: { decision: fields.restockDecision, date: settlementTimestamp(fields.restockDate) } };
      default: return { candidateId: id };
    }
  }

  function createController(options) {
    const config = options && typeof options === 'object' ? options : {};
    const document = config.document || root.document;
    const rootElement = config.root || (document && document.getElementById('dealer-production-root'));
    const store = config.store || root.DealerStore;
    const state = {
      mounted: false,
      loading: false,
      busy: false,
      selectedId: '',
      pageCursors: [null],
      pageIndex: 0,
      formDraft: null,
      formDraftKey: null,
      message: null,
      loadError: null,
      inventoryRows: [],
      lastOwnerId: null,
      unsubscribe: null
    };

    function view() {
      try { return store && typeof store.view === 'function' ? store.view() : null; } catch (_) { return null; }
    }

    function currentRecord(currentView) {
      return selectedRecord(currentView && currentView.snapshot, state.selectedId);
    }

    function draftFor(currentView, key) {
      const draftKey = String(key || 'new');
      if (state.formDraft && (state.formDraftKey == null || String(state.formDraftKey) === draftKey)) {
        return state.formDraft;
      }
      const drafts = currentView && currentView.drafts && typeof currentView.drafts === 'object' ? currentView.drafts : {};
      return drafts[draftKey] || null;
    }

    function setFormDraft(key, draft) {
      state.formDraft = draft || null;
      state.formDraftKey = draft ? String(key || 'new') : null;
    }

    function clearFormDraft() {
      state.formDraft = null;
      state.formDraftKey = null;
    }

    function readInput(selector) {
      const element = rootElement && rootElement.querySelector(selector);
      return element ? String(element.value == null ? '' : element.value).trim() : '';
    }

    function readCandidateFields() {
      const fields = {};
      FIELD_NAMES.forEach(name => {
        const element = rootElement && rootElement.querySelector('[data-dealer-field="' + name + '"]');
        fields[name] = element && element.type === 'checkbox' ? String(!!element.checked) : readInput('[data-dealer-field="' + name + '"]');
      });
      return fields;
    }

    function readStageFields(fallback) {
      const fields = {};
      if (!rootElement) return fields;
      rootElement.querySelectorAll('[data-stage-field]').forEach(element => {
        const name = element.getAttribute('data-stage-field');
        fields[name] = element.type === 'checkbox' ? String(!!element.checked) : String(element.value == null ? '' : element.value).trim();
      });
      const picker = fields.inventoryRef;
      const selected = state.inventoryRows.find(row => row.key === picker);
      if (selected) {
        fields.inventoryTable = selected.table;
        fields.inventoryId = selected.id;
        fields.inventoryVersion = selected.version == null ? '' : String(selected.version);
        fields.inventoryCost = selected.cost == null ? '' : String(selected.cost);
        fields.inventoryCurrency = selected.currency || 'SGD';
        fields.inventoryBlocked = selected.syncBlocked ? 'true' : 'false';
        if (!fields.copyCost) fields.copyCost = fields.inventoryCost;
        if (!fields.copyCurrency) fields.copyCurrency = fields.inventoryCurrency;
      } else if (fallback && String(fields.inventoryRef || '') === String(fallback.inventoryRef || '')) {
        ['inventoryTable', 'inventoryId', 'inventoryVersion', 'inventoryCost', 'inventoryCurrency', 'inventoryBlocked'].forEach(name => {
          if (fallback[name] != null) fields[name] = fallback[name];
        });
      }
      return fields;
    }

    function inventoryPickerMarkup(selectedKey) {
      let result = null;
      try { result = typeof root.kjrDealerInventorySummaries === 'function' ? root.kjrDealerInventorySummaries() : null; } catch (_) { result = null; }
      const rows = result && result.ok && Array.isArray(result.rows) ? result.rows : [];
      state.inventoryRows = rows.map(row => Object.assign({}, row, { key: String(row.table) + '::' + String(row.id) }));
      if (!state.inventoryRows.length) return '<option value="">No authenticated stock summaries are available</option>';
      return '<option value="">Choose a reviewed copy from authenticated stock</option>' + state.inventoryRows.map(row =>
        row.syncBlocked
          ? '<option value="blocked::' + escapeHtml(row.key) + '"' + (String(selectedKey || '') === 'blocked::' + row.key ? ' selected' : '') + ' disabled>' + (row.dealerControlled ? 'Already controlled by Dealer Desk · ' : 'Resolve pending generic edit first · ') + escapeHtml(row.label || (row.tableLabel + ' · selected copy')) + '</option>'
          : '<option value="' + escapeHtml(row.key) + '"' + (String(selectedKey || '') === row.key ? ' selected' : '') + '>' + escapeHtml(row.label || (row.tableLabel + ' · selected copy')) + '</option>').join('');
    }

    function candidateOptions(currentView) {
      const list = currentView && currentView.snapshot && Array.isArray(currentView.snapshot.candidates)
        ? currentView.snapshot.candidates : [];
      if (!list.length) return '<option value="">No server-confirmed candidates</option>';
      return list.map(item => '<option value="' + escapeHtml(candidateId(item)) + '"' + (candidateId(item) === state.selectedId ? ' selected' : '') + '>' +
        escapeHtml(text(firstValue(item, ['name', 'title'], null), candidateId(item))) + '</option>').join('');
    }

    function candidateListMarkup(currentView) {
      const list = currentView && currentView.snapshot && Array.isArray(currentView.snapshot.candidates)
        ? currentView.snapshot.candidates : [];
      if (!list.length) return '<div class="dealer-production-empty"><h2>No server-confirmed candidates</h2><p>Start a local candidate draft, then save it explicitly while online.</p></div>';
      return '<div class="dealer-production-cards">' + list.map(item =>
        '<button type="button" class="dealer-production-card' + (candidateId(item) === state.selectedId ? ' selected' : '') + '" data-action="select-candidate" data-candidate-id="' + escapeHtml(candidateId(item)) + '">' +
          '<strong title="' + escapeHtml(text(firstValue(item, ['name', 'title'], null), candidateId(item))) + '">' + escapeHtml(text(firstValue(item, ['name', 'title'], null), candidateId(item))) + '</strong>' +
          '<span>' + escapeHtml(statusLabel(item)) + '</span>' +
          '<small>' + escapeHtml(text(firstValue(item, ['set', 'setName', 'set_name'], null), 'Set not recorded')) + '</small>' +
        '</button>').join('') + '</div>';
    }

    function paginationMarkup(currentView) {
      const next = currentView && currentView.snapshot && currentView.snapshot.nextCursor;
      return '<div class="dealer-production-pagination">' +
        '<button class="btn btn-sm" type="button" data-action="previous-page"' + (state.pageIndex === 0 || state.loading ? ' disabled' : '') + '>Previous</button>' +
        '<span>Page ' + (state.pageIndex + 1) + ', up to 50 records</span>' +
        '<button class="btn btn-sm" type="button" data-action="next-page"' + (!next || state.loading ? ' disabled' : '') + '>Next</button>' +
        '</div>';
    }

    function draftSummaryMarkup(draft, label, actionMarkup) {
      const fields = draft && draft.fields && typeof draft.fields === 'object' ? draft.fields : {};
      const stage = draft && draft.stage && typeof draft.stage === 'object' ? draft.stage : {};
      const summary = [
        fields.name || 'Unnamed candidate',
        fields.set || 'Set not recorded',
        fields.number ? 'No. ' + fields.number : '',
        stage.planReason ? 'Plan: ' + stage.planReason : '',
        stage.expectedSaleAmount ? 'Expected sale: ' + stage.expectedSaleAmount + ' ' + (stage.reportingCurrency || 'SGD') : ''
      ].filter(Boolean).join(' · ');
      return '<div class="dealer-production-conflict-variant"><strong>' + escapeHtml(label) + '</strong><p>' + escapeHtml(summary) + '</p>' + (actionMarkup || '') + '</div>';
    }

    function draftConflictMarkup(draft) {
      const conflicts = draft && Array.isArray(draft.conflicts) ? draft.conflicts : [];
      if (!conflicts.length) return '';
      const choice = draft.conflictChoice ? ' Choice saved locally, every version remains available below.' : '';
      return '<section class="dealer-production-conflicts" role="region" aria-label="Draft versions needing review"><h3>Draft versions need your choice</h3><p class="dealer-production-help">Another tab or session saved a different local draft. Review the summaries, then choose which version to continue with.' + escapeHtml(choice) + '</p>' +
        draftSummaryMarkup(draft, 'Current draft', '<button type="button" class="btn btn-sm" data-action="restore-draft" data-variant-index="-1">Keep current draft</button>') +
        '<div class="dealer-production-conflict-list">' + conflicts.map((item, index) => draftSummaryMarkup(item, 'Alternate version ' + (index + 1), '<button type="button" class="btn btn-sm" data-action="restore-draft" data-variant-index="' + index + '">Use this version</button>')).join('') + '</div></section>';
    }

    function actionGate(command, record, draft) {
      if (!record && command !== 'create_candidate') return 'Save this candidate before moving to the next stage.';
      if (command !== 'create_candidate' && command !== 'update_candidate' && candidateDraftChanged(record, draft)) return 'Save candidate changes before moving to the next stage.';
      if (command === 'create_candidate' || command === 'update_candidate' || command === 'add_evidence') return '';
      const detail = record && record.__dealerDetail && typeof record.__dealerDetail === 'object' ? record.__dealerDetail : {};
      const evidence = Array.isArray(detail.evidence) ? detail.evidence.filter(Boolean) : [];
      const plan = planEntity(record);
      const copy = latestEntity(record, 'copy');
      const listing = latestEntity(record, 'listings');
      const outcome = latestEntity(record, 'outcomes');
      const planStatus = String(firstValue(plan, ['status', 'state'], '') || '').toLowerCase();
      const listingStatus = String(firstValue(listing, ['status', 'state'], '') || '').toLowerCase();
      const paymentStatus = String(firstValue(outcome, ['paymentStatus', 'payment_status', 'settlement'], '') || '').toLowerCase();
      const readiness = detail.readiness && typeof detail.readiness === 'object' ? detail.readiness : {};
      const draftFields = draft && draft.fields && typeof draft.fields === 'object' ? draft.fields : {};
      const draftStage = draft && draft.stage && typeof draft.stage === 'object' ? draft.stage : {};
      const candidateValue = name => String(draftFields[name] != null && draftFields[name] !== '' ? draftFields[name] : firstValue(record, [name, name + 'Value'], '') || '').trim();
      const approvedPlans = approvedPlanEntities(record);
      if (command === 'create_plan' && !evidence.length) return 'Add confirmed evidence before creating the buy plan.';
      if (command === 'create_plan' && approvedPlans.length) {
        if (copy) return 'A confirmed copy exists, so the approved buy plan cannot be revised.';
        if (!draftStage.supersedesPlanId || !draftStage.revisionReason) return 'Choose the approved plan being revised and enter a revision reason before creating a new plan.';
      }
      if (command === 'approve_buy') {
        if (!plan) return 'Create a buy plan before approving the buy.';
        const format = candidateValue('format').toLowerCase();
        const grade = candidateValue('grade');
        const gradeCertainty = candidateValue('gradeCertainty').toLowerCase();
        const conditionCertainty = candidateValue('conditionCertainty').toLowerCase();
        if (!format) return 'Choose whether this candidate is raw or slabbed before approving the buy.';
        if (['slab', 'graded'].includes(format) && ['grader', 'grade', 'certificateNumber'].some(name => !candidateValue(name))) return 'Enter the slab grader, grade, and certificate number before approving the buy.';
        if (grade && !['known', 'verified'].includes(gradeCertainty)) return 'Choose Known from evidence or Verified by evidence for the grade before approving the buy.';
        if (['estimated', 'uncertain', 'unknown'].includes(conditionCertainty) && !candidateValue('conditionScenario')) return 'Describe the condition scenario before approving the buy.';
        if (!draftStage.conditionScenario && !candidateValue('conditionScenario')) return 'Describe the condition or resale grade scenario in the buy plan before approving the buy.';
        if (readiness.ready !== true) return 'Complete the confirmed evidence and identity checks before approving the buy.';
        if (planStatus === 'approved') return 'This buy plan is already approved.';
        if (approvedPlans.length && !firstValue(plan, ['supersedesPlanId', 'supersedes_plan_id'], draftStage.supersedesPlanId || null)) return 'Approve the revised plan only after it records which approved plan it supersedes.';
      }
      if (command === 'acquire_copy' || command === 'link_copy') {
        if (planStatus !== 'approved') return 'Approve the ready buy plan before recording a copy.';
        if (copy) return 'A server-confirmed copy is already linked to this candidate.';
        const route = String(draftStage.inventoryTable || draftStage.acquisitionTable || '').toLowerCase();
        if (route === 'slabs' && ['grader', 'grade', 'certificateNumber'].some(name => !candidateValue(name))) {
          return 'Enter the slab grader, grade, and certificate number before recording this copy.';
        }
      }
      if (command === 'set_asking') {
        if (!copy) return 'Acquire or link a server-confirmed copy before setting an asking price.';
      }
      if (command === 'prepare_listing') {
        if (!copy) return 'Acquire or link a server-confirmed copy before preparing the listing.';
        if (!listing || !['asking_set', 'prepared'].includes(listingStatus)) return 'Set the asking price before preparing the listing.';
      }
      if (command === 'record_sale') {
        if (!copy) return 'Acquire or link a server-confirmed copy before recording a sale.';
        if (!listing || listingStatus !== 'prepared') return 'Prepare the listing before recording a sale.';
        if (outcome) return 'A server-confirmed outcome already exists for this copy.';
      }
      if (command === 'record_non_sale') {
        if (!copy) return 'Acquire or link a server-confirmed copy before recording a non-sale.';
        if (outcome) return 'A server-confirmed outcome already exists for this copy.';
      }
      if (command === 'settle_sale') {
        if (!outcome) return 'Record the sale before confirming settlement.';
        if (paymentStatus && paymentStatus !== 'unknown') return 'This outcome no longer needs settlement.';
      }
      if (command === 'review_outcome') {
        if (!outcome) return 'Record a sale or non-sale outcome before reviewing it.';
        if (paymentStatus === 'unknown') return 'Confirm settlement before reviewing a recorded sale.';
      }
      return '';
    }

    function commandButtons(commands, writable, record, pending, currentView, draft) {
      const unknownForCandidate = (pending || []).some(item => item && item.status === 'unknown' &&
        String((item.payload && (item.payload.candidateId || item.payload.candidate_id)) || '') === String(candidateId(record)));
      return (commands || []).map(command => {
        const needsCandidate = command !== 'create_candidate';
        const isCandidateAction = command === 'create_candidate' || command === 'update_candidate';
        const gate = actionGate(command, record, draft);
        const disabled = !writable || state.busy || (needsCandidate && !record) || (isCandidateAction && command === 'create_candidate' && record) ||
          (isCandidateAction && command === 'update_candidate' && !record) || (unknownForCandidate && command !== 'create_candidate') || !!gate;
        return '<button type="button" class="btn btn-sm" data-action="command" data-command="' + escapeHtml(command) + '"' +
          (disabled ? ' disabled' : '') + '>' + escapeHtml(COMMAND_LABELS[command] || command) + '</button>';
      }).join('') + (commands || []).map(command => {
        const gate = actionGate(command, record, draft);
        return gate ? '<span class="dealer-production-help dealer-production-action-help">' + escapeHtml(gate) + '</span>' : '';
      }).join('');
    }

    function render() {
      if (!rootElement) return;
      const currentView = view();
      if (!currentView || currentView.ok !== true) {
        // Auth expiry, logout, and an owner switch must remove protected
        // candidate text from the DOM as soon as the store hides its view.
        state.selectedId = '';
        clearFormDraft();
        state.pageCursors = [null];
        state.pageIndex = 0;
        state.inventoryRows = [];
        renderOwnerGate();
        return;
      }
      const record = currentRecord(currentView);
      const draftKey = state.selectedId || 'new';
      const draft = draftFor(currentView, draftKey);
      const localDraft = !!draft;
      const online = !!(currentView && currentView.online && !currentView.stale);
      const writable = online && !!record || online && !state.selectedId;
      const source = sourceLabel(currentView);
      const pending = currentView && currentView.pending ? Object.values(currentView.pending) : [];
      const pickerOptions = inventoryPickerMarkup(draft && draft.stage && draft.stage.inventoryRef);
      const selectedName = record ? text(firstValue(record, ['name', 'title'], null), candidateId(record)) : 'New candidate draft';
      const selected = '<strong title="' + escapeHtml(selectedName) + '">' + escapeHtml(selectedName) + '</strong>';
      const pendingMarkup = pending.length ? '<div class="dealer-production-pending"><strong>Pending server decisions</strong><ul>' + pending.map(item =>
        '<li><span>' + escapeHtml(item.command + ' · ' + item.status) + '</span>' + (item.status === 'unknown' ? '<button type="button" class="btn btn-sm" data-action="retry" data-command-id="' + escapeHtml(item.commandId) + '">Retry same command</button>' : '') + '</li>').join('') + '</ul></div>' : '';
      const stageActions = (...commands) => '<div class="dealer-production-actions">' + commandButtons(commands, writable, record, pending, currentView, draft) + '</div>';
      rootElement.innerHTML =
        '<div class="dealer-production-shell">' +
          '<div class="dealer-production-banner"><strong>' + escapeHtml(source) + '</strong><span>Dealer Desk writes require a server confirmation. Candidate drafts are clearly local until saved.</span><button type="button" class="btn btn-sm" data-action="reload"' + (state.loading ? ' disabled' : '') + '>Reload</button></div>' +
          statusMessage(state.message || (state.loadError ? { tone: 'error', title: 'Dealer Desk unavailable', text: state.loadError.message || String(state.loadError) } : null)) +
          '<header class="dealer-production-header"><div><h1>Dealer Desk</h1><p>Follow one candidate from evidence and buy plan through copy, listing, sale, settlement, and outcome review.</p></div><div class="dealer-production-selected">' + selected + (localDraft ? '<span class="dealer-production-local">Draft on this device</span>' : '') + '</div></header>' +
          '<div class="dealer-production-layout">' +
            '<aside class="dealer-production-list"><div class="dealer-production-list-head"><h2>Candidates</h2><button type="button" class="btn btn-sm" data-action="new-candidate">New draft</button></div>' +
              '<label class="dealer-production-picker"><span>Server-confirmed candidate</span><select data-action="select-picker">' + candidateOptions(currentView) + '</select></label>' +
              candidateListMarkup(currentView) + paginationMarkup(currentView) +
            '</aside>' +
            '<main class="dealer-production-detail">' +
              '<section class="dealer-production-section"><h2>' + (record ? 'Candidate details' : 'Candidate draft') + '</h2><div class="dealer-production-form">' + formFields(record, draft) + '</div>' +
                '<div class="dealer-production-actions"><button type="button" class="btn btn-sm" data-action="save-draft">Keep draft on this device</button>' + commandButtons(record ? ['update_candidate'] : ['create_candidate'], writable, record, pending, currentView, draft) + '<span class="dealer-production-help">Local draft saving never creates a server record.</span></div>' + draftConflictMarkup(draft) +
              '</section>' +
              '<section class="dealer-production-section"><h2>Dealer journey</h2><p class="dealer-production-help">Work through each stage using the server-confirmed record. If a response is unknown, use Retry same command before starting another write.</p>' + stageFields(draft, pickerOptions, stageActions, record) + '</section>' +
              '<section class="dealer-production-section"><h2>Confirmed links and result</h2><div class="dealer-production-links">' + linkMarkup(record, 'inventory') + ' ' + linkMarkup(record, 'sale') + '</div>' + confirmedReferenceMarkup(record) + settlementMarkup(record) + plannedActualMarkup(record) + '</section>' +
              pendingMarkup +
            '</main>' +
          '</div>' +
        '</div>';
    }

    function setMessage(result) {
      if (!result) { state.message = null; return; }
      const code = result.code || '';
      let title = result.ok ? 'Server confirmed' : 'Action blocked';
      let tone = result.ok ? 'success' : 'error';
      let action = null;
      if (result.status === 'unknown') { title = 'Response unknown'; tone = 'warning'; action = 'retry'; }
      if (result.status === 'conflict') { title = 'Review current server version'; tone = 'warning'; action = 'dismiss'; }
      if (result.status === 'blocked_offline') { title = 'Offline action blocked'; tone = 'warning'; }
      if (code === 'schema_mismatch' || code === 'schema_required') { title = 'Recovery required'; tone = 'error'; }
      const textMessage = result.message || (result.ok ? 'The server accepted the command.' : 'The server did not accept this action.');
      state.message = { title, tone: result.refreshWarning ? 'warning' : tone, text: result.refreshWarning ? textMessage + ' ' + result.refreshWarning : textMessage, detail: result.current ? JSON.stringify(result.current, null, 2) : '', action, commandId: result.commandId };
    }

    function renderOwnerGate() {
      if (!rootElement) return;
      const message = state.message && state.message.text
        ? state.message.text
        : 'Sign in with a verified owner session to open Dealer Desk.';
      rootElement.innerHTML = '<div class="dealer-production-shell dealer-production-owner-gate" role="status"><h1>Dealer Desk unavailable</h1><p>' + escapeHtml(message) + '</p></div>';
    }

    async function load(cursor, candidate) {
      if (!store || typeof store.pull !== 'function') {
        state.loadError = new Error('Dealer Desk store is unavailable');
        render();
        return;
      }
      state.loading = true;
      state.loadError = null;
      render();
      try {
        const result = await store.pull({ cursor: cursor == null ? null : cursor, candidateId: candidate || state.selectedId || null, limit: 50 });
        if (result && result.snapshot) {
          const snapshot = result.snapshot;
          if (!state.selectedId) {
            const first = snapshot.selectedCandidate || (snapshot.candidates || [])[0];
            if (first) state.selectedId = candidateId(first);
          }
        }
        state.message = result && result.code === 'offline_view' ? { title: 'Offline viewing', tone: 'warning', text: 'Showing the last server-confirmed snapshot. Local drafts remain local until an online save.' } : null;
      } catch (cause) {
        state.loadError = cause;
        setMessage({ ok: false, code: cause && cause.code, message: cause && cause.message });
      } finally {
        state.loading = false;
        render();
      }
    }

    async function refreshSelected() {
      const currentView = view();
      const cursor = currentView && currentView.snapshot ? currentView.snapshot.nextCursor : null;
      await load(state.pageCursors[state.pageIndex] || null, state.selectedId || null);
      if (cursor && state.selectedId) await load(state.pageCursors[state.pageIndex] || null, state.selectedId);
    }

    async function performCommand(command) {
      if (!store || typeof store.command !== 'function') return;
      if (state.busy) return;
      const currentView = view();
      const record = currentRecord(currentView);
      const draftKey = state.selectedId || candidateId(record) || 'new';
      const existingDraft = draftFor(currentView, draftKey);
      const fields = readCandidateFields();
      const stage = readStageFields(existingDraft && existingDraft.stage);
      // Read every input before the first await. This object is also the local
      // attempted draft shown after a conflict or unknown response.
      const candidatePayload = fields;
      const payload = command === 'create_candidate' ? candidatePayload : command === 'update_candidate'
        ? { candidateId: candidateId(record), patch: fields }
        : stagePayload(command, record, stage);
      const id = candidateId(record) || 'new';
      const versions = expectedVersions(record);
      const approvedPlans = approvedPlanEntities(record);
      if (stage.inventoryVersion && Number.isSafeInteger(Number(stage.inventoryVersion))) versions.canonical = Number(stage.inventoryVersion);
      if ((command === 'link_copy' || command === 'acquire_copy') && stage.inventoryTable && stage.inventoryId && typeof root.kjrDealerInventorySummaries === 'function') {
        try {
          const latest = root.kjrDealerInventorySummaries();
          const latestRow = latest && latest.ok && Array.isArray(latest.rows)
            ? latest.rows.find(row => String(row.table) === String(stage.inventoryTable) && String(row.id) === String(stage.inventoryId))
            : null;
          if (latestRow && latestRow.syncBlocked) stage.inventoryBlocked = 'true';
        } catch (_) { stage.inventoryBlocked = 'true'; }
      }
      const reject = (code, message) => {
        setFormDraft(draftKey, { fields, stage });
        setMessage({ ok: false, code, message });
        render();
        return false;
      };
      if (command !== 'create_candidate' && !record) {
        return reject('candidate_required', 'Choose a server-confirmed candidate before this action.');
      }
      if (command !== 'create_candidate' && command !== 'update_candidate' && candidateDraftChanged(record, { fields })) {
        return reject('candidate_changes_unsaved', 'Save candidate changes before moving to the next stage.');
      }
      const pending = currentView && currentView.pending ? Object.values(currentView.pending) : [];
      if (command !== 'create_candidate' && pending.some(item => item && item.status === 'unknown' &&
        String((item.payload && (item.payload.candidateId || item.payload.candidate_id)) || '') === String(candidateId(record)))) {
        return reject('unknown_command_pending', 'Resolve the pending server decision for this candidate before starting another write.');
      }
      if (command === 'create_candidate' && ['name', 'set', 'number', 'language', 'condition'].some(name => !fields[name])) {
        return reject('candidate_identity_required', 'Enter the candidate name, set, number, language, and condition before saving.');
      }
      if (command === 'create_candidate' && String(fields.ownershipReviewed).toLowerCase() !== 'true') {
        return reject('ownership_review_required', 'Confirm that the business ownership has been reviewed before saving.');
      }
      if (command === 'add_evidence' && ['evidenceRef', 'evidenceRationale', 'evidenceDate'].some(name => !stage[name])) {
        return reject('evidence_required', 'Enter the evidence reference, rationale, and DD/MM/YYYY observed date.');
      }
      if (command === 'create_plan' && ['planReason', 'expectedSaleAmount', 'expectedSellingFee', 'expectedOutboundShipping', 'expectedRefundAllowance', 'otherExpectedDeductions', 'targetContribution', 'riskAllowance', 'knownNonItemAcquisitionCosts', 'plannedItemCost', 'reportingCurrency'].some(name => !stage[name])) {
        return reject('buy_plan_required', 'Enter each buy-plan amount and the reporting currency. Use 0 only when that cost is known to be zero.');
      }
      if (command === 'create_plan' && approvedPlans.length) {
        if (detailEntity(record, 'copy')) return reject('plan_revision_blocked', 'A confirmed copy exists, so the approved buy plan cannot be revised.');
        if (!stage.supersedesPlanId || !stage.revisionReason) return reject('plan_revision_details_required', 'Choose the approved plan being revised and enter a revision reason before creating a new plan.');
      }
      if (command === 'link_copy' && !stage.inventoryId) {
        return reject('existing_copy_required', 'Choose a reviewed existing copy from the authenticated stock picker first.');
      }
      if (command === 'acquire_copy' && (!stage.acquisitionTable || stage.copyMode === 'existing')) {
        return reject('new_copy_route_required', 'Choose the server-created new copy route and its Singles or Slabs table.');
      }
      if ((command === 'link_copy' || command === 'acquire_copy') && String(stage.inventoryTable || stage.acquisitionTable || '').toLowerCase() === 'slabs' &&
        ['grader', 'grade', 'certificateNumber'].some(name => !String(fields[name] || '').trim())) {
        return reject('slab_identity_required', 'Enter the slab grader, grade, and certificate number before recording this copy.');
      }
      if ((command === 'link_copy' || command === 'acquire_copy') && stage.inventoryBlocked === 'true') {
        return reject('inventory_sync_required', 'Resolve and sync the selected core inventory edit before linking this copy.');
      }
      if ((command === 'link_copy' || command === 'acquire_copy') && stage.inheritCost !== 'true') {
        return reject('cost_inherit_confirmation_required', 'Confirm the reviewed cost once before saving this acquisition.');
      }
      if ((command === 'link_copy' || command === 'acquire_copy') && !stage.copyCost) {
        return reject('copy_cost_required', 'Enter the reviewed cost before saving this acquisition.');
      }
      if ((command === 'link_copy' || command === 'acquire_copy') && (!stage.copyCostReason || !settlementTimestamp(stage.copyCostDate) || stage.nonItemAcquisitionCosts === '')) {
        return reject('cost_review_details_required', 'Enter the cost review reason, valid DD/MM/YYYY review date, and non-item acquisition costs. Use 0 only when confirmed zero.');
      }
      if ((command === 'link_copy' || command === 'acquire_copy') && String(stage.copyCurrency || 'SGD').toUpperCase() !== 'SGD') {
        const fxMissing = ['fxDirection', 'fxRate', 'fxSource', 'fxAt', 'settledCopyCost', 'settledNonItemAcquisitionCosts', 'settledAmount'].some(name => !stage[name]);
        if (fxMissing) {
          return reject('fx_details_required', 'Foreign currency costs require FX direction, rate, source, and observed time before saving.');
        }
      }
      if (command === 'approve_buy' && !payload.planId) {
        return reject('plan_required', 'Create a server-confirmed buy plan before approving it.');
      }
      if (command === 'approve_buy') {
        const format = String(fields.format || '').trim().toLowerCase();
        const grade = String(fields.grade || '').trim();
        const gradeCertainty = String(fields.gradeCertainty || '').trim().toLowerCase();
        const conditionCertainty = String(fields.conditionCertainty || '').trim().toLowerCase();
        if (!format) return reject('format_required', 'Choose whether this candidate is raw or slabbed before approving the buy.');
        if (['slab', 'graded'].includes(format) && ['grader', 'grade', 'certificateNumber'].some(name => !String(fields[name] || '').trim())) return reject('slab_identity_required', 'Enter the slab grader, grade, and certificate number before approving the buy.');
        if (grade && !['known', 'verified'].includes(gradeCertainty)) return reject('grade_certainty_required', 'Choose Known from evidence or Verified by evidence for the grade before approving the buy.');
        if (['estimated', 'uncertain', 'unknown'].includes(conditionCertainty) && !String(fields.conditionScenario || '').trim()) return reject('condition_scenario_required', 'Describe the condition scenario before approving the buy.');
        if (!stage.conditionScenario && !String(fields.conditionScenario || '').trim()) return reject('condition_scenario_required', 'Describe the condition or resale grade scenario in the buy plan before approving the buy.');
        const currentStatus = String(firstValue(record, ['status', 'state'], '') || '').toLowerCase();
        if (approvedPlans.length && ['buy approved', 'acquired'].includes(currentStatus) && !payload.supersedesPlanId) return reject('plan_revision_supersedes_required', 'Approve the revised plan only after it records which approved plan it supersedes.');
      }
      if (['set_asking', 'prepare_listing', 'record_sale'].includes(command) && !payload.copyId) {
        return reject('copy_required', 'Acquire or link a server-confirmed copy before this action.');
      }
      if (['settle_sale', 'review_outcome'].includes(command) && !payload.outcomeId) {
        return reject('outcome_required', 'Record a server-confirmed sale or non-sale outcome before reviewing it.');
      }
      if (command === 'set_asking' && (!stage.askingAmount || !stage.currency)) return reject('asking_required', 'Enter the asking amount and currency before setting the listing price.');
      if (command === 'prepare_listing' && ['platform', 'channel', 'askingAmount', 'currency'].some(name => !stage[name])) return reject('listing_required', 'Enter the platform, channel, asking amount, and currency before preparing the listing.');
      if (command === 'record_sale' && !stage.saleAmount) {
        return reject('sale_amount_required', 'Enter the agreed sale amount before recording the sale.');
      }
      if (command === 'record_sale' && !settlementTimestamp(stage.saleDate)) return reject('sale_date_required', 'Enter a valid DD/MM/YYYY sale date before recording the sale.');
      if (command === 'settle_sale' && (!stage.settlementRef || !settlementTimestamp(stage.settlementDate) || !stage.proceeds || stage.sellingFee === '' || stage.outboundShipping === '')) {
        return reject('settlement_details_required', 'Enter settlement proof, valid DD/MM/YYYY date, proceeds, selling fee, and outbound shipping. Use 0 only when confirmed zero.');
      }
      if (command === 'record_non_sale' && !stage.nonSaleReason) return reject('non_sale_reason_required', 'Enter the reason before recording a non-sale outcome.');
      if (command === 'review_outcome' && (!stage.reviewCause || !stage.restockDecision || !settlementTimestamp(stage.restockDate))) return reject('review_required', 'Enter the review cause, restock decision, and valid DD/MM/YYYY decision date.');
      try { store.saveDraft(id, fields, stage); } catch (_) {}
      state.busy = true;
      state.message = { title: 'Saving', tone: 'info', text: 'Waiting for the server confirmation…' };
      render();
      let result;
      try {
        result = await store.command(command, payload, { expectedVersions: versions, busyKey: command });
      } catch (cause) {
        result = { ok: false, status: 'failed', code: cause && cause.code, message: cause && cause.message };
      }
      if (result && result.ok && ['acquire_copy', 'link_copy', 'record_sale', 'settle_sale'].includes(command) && typeof root.kjrDealerRefreshCore === 'function') {
        const refresh = await root.kjrDealerRefreshCore({ command, payload });
        if (!refresh || refresh.ok !== true) {
          result = Object.assign({}, result, { refreshWarning: refresh && refresh.message || 'The confirmed Dealer result was saved, but core records could not be refreshed safely.' });
        }
      }
      state.busy = false;
      if (result && result.ok) {
        const confirmed = result.candidate || result.record;
        const createdId = confirmed && confirmed.id != null ? String(confirmed.id) : '';
        if (command === 'create_candidate' && createdId) state.selectedId = createdId;
        // Keep the captured stage inputs after a confirmed candidate save or
        // stage action. The user may have filled later stages before the
        // first server write, and clearing that draft here would silently
        // erase those attempted values during the authoritative reload.
        const confirmedDraft = { fields, stage };
        if (command === 'create_candidate') {
          try { store.clearDraft('new'); } catch (_) {}
          if (createdId) {
            try { store.saveDraft(createdId, fields, stage); } catch (_) {}
          }
        }
        setFormDraft(createdId || id, confirmedDraft);
        await load(state.pageCursors[state.pageIndex] || null, state.selectedId || createdId || null);
        setMessage(result);
        render();
      } else {
        setFormDraft(id, { fields, stage });
        setMessage(result);
        render();
      }
    }

    async function handleClick(event) {
      const target = event.target && event.target.closest ? event.target.closest('[data-action], [data-navigate-page]') : null;
      if (!target || !rootElement.contains(target)) return;
      const action = target.getAttribute('data-action');
      if (target.hasAttribute('data-navigate-page')) {
        event.preventDefault();
        const page = target.getAttribute('data-navigate-page');
        const refId = target.getAttribute('data-ref-id');
        const refTable = target.getAttribute('data-ref-table') || (page === 'slabs' ? 'slabs' : 'singles');
        if (page !== 'sales' && refId && typeof root.viewSourceItem === 'function') root.viewSourceItem(refId, refTable);
        else {
          if (typeof root.showPage === 'function') root.showPage(page);
          focusCoreRow(page, refTable, refId);
        }
        return;
      }
      if (action === 'command') return performCommand(target.getAttribute('data-command'));
      if (action === 'reload') return load(state.pageCursors[state.pageIndex] || null, state.selectedId || null);
      if (action === 'save-draft') {
        const currentView = view();
        const record = currentRecord(currentView);
        const id = state.selectedId || candidateId(record) || 'new';
        const existingDraft = draftFor(currentView, id);
        const fields = readCandidateFields();
        const stage = readStageFields(existingDraft && existingDraft.stage);
        let result;
        try { result = store.saveDraft(id, fields, stage); } catch (cause) { result = { ok: false, code: cause && cause.code, message: cause && cause.message }; }
        setFormDraft(id, { fields, stage });
        setMessage(result);
        render();
        return;
      }
      if (action === 'new-candidate') { state.selectedId = ''; clearFormDraft(); state.message = null; render(); return; }
      if (action === 'select-candidate') { state.selectedId = target.getAttribute('data-candidate-id') || ''; clearFormDraft(); state.message = null; return load(state.pageCursors[state.pageIndex] || null, state.selectedId); }
      if (action === 'restore-draft') {
        const currentView = view();
        const id = state.selectedId || 'new';
        const index = Number(target.getAttribute('data-variant-index'));
        let result;
        try { result = typeof store.restoreDraft === 'function' ? store.restoreDraft(id, index) : { ok: false, code: 'draft_restore_unavailable', message: 'This draft choice is unavailable in the current session.' }; } catch (cause) { result = { ok: false, code: cause && cause.code, message: cause && cause.message }; }
        if (result && result.ok) setFormDraft(id, result.draft || null);
        setMessage(result);
        render();
        return;
      }
      if (action === 'next-page') {
        const currentView = view();
        const cursor = currentView && currentView.snapshot && currentView.snapshot.nextCursor;
        if (!cursor) return;
        state.pageIndex += 1;
        state.pageCursors[state.pageIndex] = cursor;
        state.selectedId = '';
        clearFormDraft();
        return load(cursor, null);
      }
      if (action === 'previous-page') {
        if (state.pageIndex <= 0) return;
        state.pageIndex -= 1;
        state.selectedId = '';
        clearFormDraft();
        return load(state.pageCursors[state.pageIndex] || null, null);
      }
      if (action === 'retry') {
        const commandId = target.getAttribute('data-command-id');
        const currentView = view();
        const pendingBefore = currentView && currentView.pending ? currentView.pending[commandId] : null;
        const retryCommand = pendingBefore && pendingBefore.command;
        const retryPayload = pendingBefore && pendingBefore.payload;
        const retryDraftKey = state.selectedId || 'new';
        const retryDraft = draftFor(currentView, retryDraftKey);
        state.busy = true;
        render();
        let result;
        try { result = await store.retry(commandId); } catch (cause) { result = { ok: false, status: 'failed', code: cause && cause.code, message: cause && cause.message }; }
        if (result && result.ok && ['acquire_copy', 'link_copy', 'record_sale', 'settle_sale'].includes(retryCommand) && typeof root.kjrDealerRefreshCore === 'function') {
          const refresh = await root.kjrDealerRefreshCore({ command: retryCommand, payload: retryPayload });
          if (!refresh || refresh.ok !== true) {
            result = Object.assign({}, result, { refreshWarning: refresh && refresh.message || 'The confirmed Dealer result was saved, but core records could not be refreshed safely.' });
          }
        }
        state.busy = false;
        if (result && result.ok) {
          const confirmed = result.candidate || result.record;
          const createdId = retryCommand === 'create_candidate' && confirmed && confirmed.id != null ? String(confirmed.id) : '';
          if (createdId) {
            state.selectedId = createdId;
            if (retryDraft && retryDraft.fields) {
              try { store.clearDraft('new'); } catch (_) {}
              try { store.saveDraft(createdId, retryDraft.fields, retryDraft.stage || {}); } catch (_) {}
              setFormDraft(createdId, retryDraft);
            } else {
              clearFormDraft();
            }
          }
          await load(state.pageCursors[state.pageIndex] || null, state.selectedId || null);
          setMessage(result);
          render();
        } else {
          setMessage(result);
          render();
        }
        return;
      }
      if (action === 'dismiss-pending') {
        try { store.dismissPending(target.getAttribute('data-command-id')); } catch (_) {}
        state.message = null;
        render();
      }
    }

    function handleChange(event) {
      const target = event.target;
      if (!target || !rootElement || !rootElement.contains(target)) return;
      if (target.getAttribute('data-action') === 'select-picker') {
        state.selectedId = target.value || '';
        clearFormDraft();
        state.message = null;
        load(state.pageCursors[state.pageIndex] || null, state.selectedId);
        return;
      }
      if (target.getAttribute('data-dealer-field') || target.getAttribute('data-stage-field')) return handleInput(event);
    }

    function handleInput(event) {
      const target = event.target;
      if (!target || !target.getAttribute) return;
      const isCandidateField = !!target.getAttribute('data-dealer-field');
      const isStageField = !!target.getAttribute('data-stage-field');
      if (!isCandidateField && !isStageField) return;
      const fields = readCandidateFields();
      const id = state.selectedId || 'new';
      const currentView = view();
      const existingDraft = draftFor(currentView, id);
      const stage = readStageFields(existingDraft && existingDraft.stage);
      setFormDraft(id, { fields, stage });
      try { store.saveDraft(id, fields, stage); } catch (_) {}
      const marker = rootElement.querySelector('.dealer-production-local');
      if (!marker && rootElement.querySelector('.dealer-production-detail')) {
        // Keep the editing surface stable, only the local marker needs a
        // repaint. The next command render also displays this state.
        const header = rootElement.querySelector('.dealer-production-selected');
        if (header) header.insertAdjacentHTML('beforeend', '<span class="dealer-production-local">Draft on this device</span>');
      }
    }

    function mount() {
      if (!rootElement || !store) return Promise.resolve(false);
      if (!state.mounted) {
        state.mounted = true;
        rootElement.addEventListener('click', handleClick);
        rootElement.addEventListener('change', handleChange);
        rootElement.addEventListener('input', handleInput);
        if (typeof store.subscribe === 'function') {
          state.unsubscribe = store.subscribe(nextView => {
            const nextOwnerId = nextView && nextView.ok ? nextView.ownerId : null;
            const ownerChanged = state.lastOwnerId != null && nextOwnerId != null && String(nextOwnerId) !== String(state.lastOwnerId);
            const ownerHidden = !nextOwnerId || (nextView && nextView.ok !== true);
            if (ownerChanged || ownerHidden) {
              state.selectedId = '';
              clearFormDraft();
              state.pageCursors = [null];
              state.pageIndex = 0;
              state.inventoryRows = [];
              state.message = ownerHidden ? { title: 'Dealer Desk unavailable', tone: 'warning', text: 'Sign in with a verified owner session to view Dealer Desk records.' } : null;
              state.loadError = null;
            }
            state.lastOwnerId = nextOwnerId;
            render();
          });
        }
      }
      return (async function () {
        if (!state.loading && !view()?.snapshot) {
          try { await store.init(); } catch (cause) { state.loadError = cause; setMessage({ ok: false, code: cause && cause.code, message: cause && cause.message }); render(); return false; }
        }
        await load(state.pageCursors[state.pageIndex] || null, state.selectedId || null);
        return true;
      }());
    }

    return { mount, render, load, performCommand, state, escapeHtml };
  }

  let defaultController = null;
  function mount() {
    if (!defaultController) defaultController = createController({});
    return defaultController.mount();
  }

  return {
    createController,
    mount,
    escapeHtml,
    safeHttpUrl,
    manualReferenceMarkup,
    expectedVersions,
    stagePayload,
    sourceLabel,
    COMMANDS: COMMANDS.slice()
  };
}));
