/*
 * Dealer Desk Release 0 domain and persistence engine.
 *
 * Release 0 is a local, synthetic, manual pilot.  This module deliberately
 * does not call Supabase, marketplace APIs, or the normal dirty-row queue.
 * It stores workflow metadata under its own key and changes the existing
 * inventory and sales rows only through the guarded local transaction helpers
 * below.  The existing DB rows remain the source of truth for physical copies
 * and completed sales.
 */
(function dealerDeskModule(root) {
  'use strict';

  var METADATA_KEY = 'kjr_dealer_desk_r0_v1';
  var INVENTORY_KEY = 'pokeinventory_v3';
  var WAL_KEY = 'kjr_dealer_desk_wal_r0_v1';
  var OWNER_KEY = 'kjr_dealer_owner_r0_v1';
  var SCHEMA_VERSION = 1;
  var VERSION = 'r0';
  var OWNER_FALLBACK = 'local-preview-owner-v1';
  var localQueue = Promise.resolve();
  var idCounter = 0;

  var TABLES = ['singles', 'slabs', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases', 'sales'];
  var ITEM_TABLES = ['singles', 'slabs'];
  var EVIDENCE_CLASSES = ['asking', 'sold', 'transaction', 'manual'];
  var FORMATS = ['raw', 'slab'];
  var OWNERSHIP = ['Business', 'Collection', 'Unknown'];
  var CONDITION_CERTAINTY = ['Known', 'Estimated', 'Unknown'];
  var CANDIDATE_STATES = ['Draft', 'Review', 'Buy approved', 'Pass', 'Hold', 'Acquired'];

  function now() {
    return new Date().toISOString();
  }

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  function text(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function nonEmpty(value) {
    return text(value).length > 0;
  }

  function fail(code, message, details) {
    var result = { ok: false, code: code, message: message };
    if (details !== undefined) result.details = clone(details);
    return result;
  }

  function success(value) {
    var result = { ok: true };
    if (value && isObject(value)) Object.keys(value).forEach(function (key) { result[key] = clone(value[key]); });
    return result;
  }

  function safeJson(value) {
    try { return JSON.stringify(value); } catch (error) { return null; }
  }

  function sameBytes(left, right) {
    return left === right;
  }

  function uuid(prefix) {
    var value = '';
    try {
      if (root.crypto && typeof root.crypto.randomUUID === 'function') value = root.crypto.randomUUID();
    } catch (error) {}
    if (!value) {
      idCounter += 1;
      value = String(Date.now()) + '-' + String(idCounter) + '-' + Math.random().toString(36).slice(2, 10);
    }
    return (prefix || 'dealer') + '-' + value;
  }

  function getLocalStorage() {
    try {
      return root.localStorage || (typeof localStorage !== 'undefined' ? localStorage : null);
    } catch (error) {
      return null;
    }
  }

  function getDb() {
    try {
      if (typeof DB !== 'undefined' && DB) return DB;
    } catch (error) {}
    return null;
  }

  function getMoney() {
    try {
      if (typeof DealerMoney !== 'undefined' && DealerMoney) return DealerMoney;
    } catch (error) {}
    try {
      if (root.DealerMoney) return root.DealerMoney;
    } catch (error) {}
    return null;
  }

  function isLocalPreview() {
    try {
      var locationValue = root.location || (typeof location !== 'undefined' ? location : null);
      if (!locationValue) return false;
      var hostname = text(locationValue.hostname).toLowerCase().replace(/^\[|\]$/g, '');
      var protocol = text(locationValue.protocol).toLowerCase();
      return (protocol === 'http:' || protocol === 'https:') && (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1');
    } catch (error) {
      return false;
    }
  }

  function ownerId() {
    var storage = getLocalStorage();
    if (storage) {
      try {
        var stored = text(storage.getItem(OWNER_KEY));
        if (stored) return stored;
        storage.setItem(OWNER_KEY, OWNER_FALLBACK);
      } catch (error) {}
    }
    return OWNER_FALLBACK;
  }

  function ownerScope() {
    try {
      var marker = root.__KJR_DEALER_PREVIEW_OWNER__;
      if (marker && nonEmpty(marker.id)) return text(marker.id);
      if (marker && nonEmpty(marker.label)) return text(marker.label);
    } catch (error) {}
    return '';
  }

  function guardPreview() {
    var explicitMarker = false;
    try { explicitMarker = root.__KJR_DEALER_PREVIEW__ === true; } catch (error) {}
    return isLocalPreview() && explicitMarker && nonEmpty(ownerScope()) ? null : fail('local_preview_required', 'Dealer Desk Release 0 is available only in the approved localhost synthetic pilot with an explicit owner scope');
  }

  function hasWebLocks() {
    try { return !!(root.navigator && root.navigator.locks && typeof root.navigator.locks.request === 'function'); }
    catch (error) { return false; }
  }

  function runLocked(task, keys) {
    keys = ['dealer-desk-r0'].concat(Array.isArray(keys) ? keys : []);
    var wrapped = function () {
      if (!hasWebLocks()) return fail('lock_unavailable', 'Dealer Desk needs browser locking for a write, retry in the supported localhost browser');
      try {
        if (typeof _withCrossTabRowLocks === 'function') return _withCrossTabRowLocks(keys, task);
      } catch (error) {}
      return root.navigator.locks.request('kjr-dealer-desk-r0', { mode: 'exclusive' }, task);
    };
    var next = localQueue.then(wrapped, wrapped);
    localQueue = next.catch(function () {});
    return next;
  }

  function defaultState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      release: VERSION,
      ownerId: ownerId(),
      ownerScope: ownerScope(),
      revision: 0,
      updatedAt: now(),
      candidates: [],
      evidence: [],
      plans: [],
      copies: [],
      listings: [],
      outcomes: [],
      reviews: [],
      requestLedger: []
    };
  }

  function readRaw(key) {
    var storage = getLocalStorage();
    if (!storage) return { ok: false, error: fail('storage_unavailable', 'Local storage is unavailable') };
    try { return { ok: true, raw: storage.getItem(key) }; }
    catch (error) { return { ok: false, error: fail('storage_read_failed', 'Local storage could not be read') }; }
  }

  function writeRaw(key, raw) {
    var storage = getLocalStorage();
    if (!storage) throw new Error('storage_unavailable');
    if (raw === null || raw === undefined) storage.removeItem(key);
    else storage.setItem(key, raw);
    var confirmed = storage.getItem(key);
    if (raw === null || raw === undefined) {
      if (confirmed !== null) throw new Error('storage_write_not_confirmed');
    } else if (!sameBytes(confirmed, raw)) {
      throw new Error('storage_write_not_confirmed');
    }
  }

  function rollbackRaw(key, raw) {
    try {
      writeRaw(key, raw);
      return true;
    } catch (error) {
      return false;
    }
  }

  function casRestoreRaw(key, before, ours) {
    var current = readRaw(key);
    if (!current.ok) return false;
    if (sameBytes(current.raw, before)) return true;
    if (!sameBytes(current.raw, ours)) return false;
    return rollbackRaw(key, before);
  }

  function removeWal() {
    try { writeRaw(WAL_KEY, null); return true; } catch (error) { return false; }
  }

  function validateWalIntent(intent) {
    if (!isObject(intent) || intent.schemaVersion !== SCHEMA_VERSION || intent.ownerId !== ownerId() || !nonEmpty(intent.txId) || !validTimestamp(intent.createdAt)) return fail('recovery_required', 'Dealer Desk transaction journal is invalid, no write was attempted');
    if ((typeof intent.metadataBefore !== 'string' && intent.metadataBefore !== null) || (typeof intent.inventoryBefore !== 'string' && intent.inventoryBefore !== null) || (typeof intent.metadataNext !== 'string' && intent.metadataNext !== null) || typeof intent.inventoryNext !== 'string') return fail('recovery_required', 'Dealer Desk transaction journal payload is invalid, no write was attempted');
    if (!isObject(intent.dbBefore)) return fail('recovery_required', 'Dealer Desk transaction journal database snapshot is invalid, no write was attempted');
    var dbTables = ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'];
    for (var i = 0; i < dbTables.length; i += 1) if (!Array.isArray(intent.dbBefore[dbTables[i]])) return fail('recovery_required', 'Dealer Desk transaction journal database snapshot is incomplete, no write was attempted');
    if (intent.metadataBefore !== null) {
      var before = parseState(intent.metadataBefore);
      if (!before.ok) return fail('recovery_required', 'Dealer Desk transaction journal metadata snapshot is invalid, no write was attempted');
    }
    var next = parseState(intent.metadataNext);
    if (!next.ok) return fail('recovery_required', 'Dealer Desk transaction journal pending metadata is invalid, no write was attempted');
    var inventoryNext;
    try { inventoryNext = JSON.parse(intent.inventoryNext); } catch (error) { return fail('recovery_required', 'Dealer Desk transaction journal pending inventory is invalid, no write was attempted'); }
    if (!isObject(inventoryNext)) return fail('recovery_required', 'Dealer Desk transaction journal pending inventory is invalid, no write was attempted');
    for (var t = 0; t < TABLES.length; t += 1) if (!Array.isArray(inventoryNext[TABLES[t]])) return fail('recovery_required', 'Dealer Desk transaction journal pending inventory is incomplete, no write was attempted');
    return { ok: true, intent: intent };
  }

  /* Synchronous reads fail closed. A journal is cleared only by recover(). */
  function recoverPendingWal() {
    var walResult = readRaw(WAL_KEY);
    if (!walResult.ok || walResult.raw === null) return walResult.ok ? null : walResult.error;
    var intent;
    try { intent = JSON.parse(walResult.raw); } catch (error) { return fail('recovery_required', 'Dealer Desk transaction journal is corrupt, no write was attempted'); }
    var valid = validateWalIntent(intent);
    if (!valid.ok) return valid;
    return fail('recovery_required', 'Dealer Desk has a pending transaction journal, explicit recovery is required before reading or writing');
  }

  function canonicalDbTables() {
    return ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'];
  }

  function parsedInventory(raw) {
    var value;
    try { value = JSON.parse(raw); } catch (error) { return null; }
    if (!isObject(value)) return null;
    for (var i = 0; i < TABLES.length; i += 1) if (!Array.isArray(value[TABLES[i]])) return null;
    return value;
  }

  function dbMatchesSnapshot(snapshot) {
    var db = getDb();
    if (!db || !isObject(snapshot)) return false;
    var tables = canonicalDbTables();
    for (var i = 0; i < tables.length; i += 1) if (safeJson(db[tables[i]] || []) !== safeJson(snapshot[tables[i]] || [])) return false;
    return true;
  }

  function dbMatchesInventory(payload) {
    var db = getDb();
    if (!db || !isObject(payload)) return false;
    var tables = canonicalDbTables();
    for (var i = 0; i < tables.length; i += 1) if (safeJson(db[tables[i]] || []) !== safeJson(payload[tables[i]] || [])) return false;
    return true;
  }

  function recover() {
    var guard = guardPreview();
    if (guard) return Promise.resolve(guard);
    return runLocked(function () {
      var walResult = readRaw(WAL_KEY);
      if (!walResult.ok) return walResult.error;
      if (walResult.raw === null) return success({ recovered: false, state: readState() });
      var intent;
      try { intent = JSON.parse(walResult.raw); } catch (error) { return fail('recovery_required', 'Dealer Desk transaction journal is corrupt, manual recovery is required'); }
      var valid = validateWalIntent(intent);
      if (!valid.ok) return valid;
      var metadataNow = readRaw(METADATA_KEY);
      var inventoryNow = readRaw(INVENTORY_KEY);
      if (!metadataNow.ok) return metadataNow.error;
      if (!inventoryNow.ok) return inventoryNow.error;
      var metadataBefore = intent.metadataBefore;
      var inventoryBefore = intent.inventoryBefore;
      var metadataNext = intent.metadataNext;
      var inventoryNext = intent.inventoryNext;
      var metadataIsBefore = sameBytes(metadataNow.raw, metadataBefore);
      var inventoryIsBefore = sameBytes(inventoryNow.raw, inventoryBefore);
      var metadataIsNext = sameBytes(metadataNow.raw, metadataNext);
      var inventoryIsNext = sameBytes(inventoryNow.raw, inventoryNext);
      var nextPayload = parsedInventory(inventoryNext);
      if (!nextPayload) return fail('recovery_required', 'Dealer Desk transaction journal pending inventory is invalid, manual recovery is required');
      var nextState = parseState(metadataNext);
      if (!nextState.ok || !validateStateLinks(nextState.state, nextPayload).ok) return fail('recovery_required', 'Dealer Desk transaction journal pending links are invalid, manual recovery is required');
      if (metadataIsNext && inventoryIsNext) {
        if (!dbMatchesInventory(nextPayload) && !dbMatchesSnapshot(intent.dbBefore)) return fail('recovery_required', 'Dealer Desk committed transaction has an in-memory conflict, manual recovery is required');
        if (dbMatchesSnapshot(intent.dbBefore) && !updateDbArrays(nextPayload)) return fail('recovery_required', 'Dealer Desk could not apply committed inventory recovery');
        if (!removeWal()) return fail('recovery_required', 'Dealer Desk could not clear its committed transaction journal');
        return success({ recovered: true, action: 'committed' });
      }
      if (!metadataIsBefore && !metadataIsNext || !inventoryIsBefore && !inventoryIsNext) return fail('recovery_required', 'Dealer Desk transaction changed outside its journal, manual recovery is required');
      if (!dbMatchesSnapshot(intent.dbBefore)) return fail('recovery_required', 'Dealer Desk interrupted transaction has an in-memory conflict, manual recovery is required');
      if (metadataIsBefore && inventoryIsBefore) {
        if (!removeWal()) return fail('recovery_required', 'Dealer Desk could not clear its interrupted transaction journal');
        return success({ recovered: true, action: 'rolled_back' });
      }
      var metadataRestored = metadataIsBefore || (metadataIsNext && rollbackRaw(METADATA_KEY, metadataBefore));
      var inventoryRestored = inventoryIsBefore || (inventoryIsNext && rollbackRaw(INVENTORY_KEY, inventoryBefore));
      if (!metadataRestored || !inventoryRestored) return fail('recovery_required', 'Dealer Desk could not roll back its interrupted transaction');
      if (!removeWal()) return fail('recovery_required', 'Dealer Desk rolled back but could not clear its transaction journal');
      return success({ recovered: true, action: 'rolled_back' });
    });
  }

  function parseState(raw) {
    if (raw === null || raw === undefined || raw === '') return { ok: true, state: defaultState(), raw: null };
    var parsed;
    try { parsed = JSON.parse(raw); } catch (error) { return fail('metadata_corrupt', 'Dealer Desk metadata is not valid JSON'); }
    var validation = validateState(parsed);
    if (!validation.ok) return validation;
    return { ok: true, state: parsed, raw: raw };
  }

  function readState() {
    var recovery = recoverPendingWal();
    if (recovery) return recovery;
    var rawResult = readRaw(METADATA_KEY);
    if (!rawResult.ok) return rawResult.error;
    var parsed = parseState(rawResult.raw);
    if (!parsed.ok) return parsed;
    if (rawResult.raw !== null) {
      var inventory = readInventory();
      if (!inventory.ok) return inventory;
      var links = validateStateLinks(parsed.state, inventory.payload);
      if (!links.ok) return links;
    }
    return parsed;
  }

  function validId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,180}$/.test(value);
  }

  function validTimestamp(value) {
    return typeof value === 'string' && nonEmpty(value) && Number.isFinite(Date.parse(value));
  }

  function containsSensitiveText(value) {
    var raw = '';
    try { raw = JSON.stringify(value); } catch (error) { raw = String(value); }
    return /password|passcode|bearer|api[ _-]?key|secret|otp|one[- ]time|private[ _-]?message|login|credential|recovery[ _-]?code|access[ _-]?code/i.test(raw);
  }

  function normaliseEvidence(ref) {
    if (!isObject(ref)) return fail('invalid_evidence', 'Evidence must be an object');
    if (containsSensitiveText(ref)) return fail('sensitive_evidence_rejected', 'Evidence contains credential or private-message-looking material');
    var evidenceClass = text(ref.class || ref.kind || ref.type).toLowerCase();
    if (EVIDENCE_CLASSES.indexOf(evidenceClass) < 0) return fail('invalid_evidence_class', 'Evidence class must be asking, sold, transaction, or manual');
    var reference = text(ref.reference || ref.ref || ref.url || ref.label);
    if (!reference) return fail('evidence_reference_required', 'Evidence needs a manual reference');
    var sourceDate = text(ref.sourceDate || ref.date || ref.observedAt);
    if (!validTimestamp(sourceDate)) return fail('evidence_date_required', 'Evidence needs a valid source date');
    var confidence = ref.confidence === undefined ? 'unknown' : ref.confidence;
    if (typeof confidence === 'number' && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) return fail('invalid_evidence_confidence', 'Evidence confidence must be between 0 and 1');
    if (typeof confidence !== 'number' && ['high', 'medium', 'low', 'unknown'].indexOf(text(confidence).toLowerCase()) < 0) return fail('invalid_evidence_confidence', 'Evidence confidence must be high, medium, low, unknown, or a number between 0 and 1');
    var out = {
      id: validId(text(ref.id)) ? text(ref.id) : uuid('evidence'),
      class: evidenceClass,
      reference: reference,
      sourceDate: sourceDate,
      match: text(ref.match || ref.matchStatus || 'Unknown') || 'Unknown',
      confidence: typeof confidence === 'number' ? confidence : text(confidence).toLowerCase(),
      rationale: text(ref.rationale || ''),
      redacted: ref.redacted === true,
      synthetic: ref.synthetic === true || /^synthetic(?::|:\/\/|[-_])/i.test(reference)
    };
    if (ref.source !== undefined) out.source = text(ref.source);
    return { ok: true, evidence: out };
  }

  function normaliseCondition(value, input) {
    var source = isObject(value) ? value : { value: value };
    var conditionValue = text(source.value || source.label || (typeof value === 'string' ? value : '')) || 'Unknown';
    var certainty = text(source.certainty || (input && input.conditionCertainty) || 'Unknown');
    if (CONDITION_CERTAINTY.indexOf(certainty) < 0) certainty = 'Unknown';
    var scenario = text(source.scenario || (input && input.conditionScenario) || '');
    return { value: conditionValue, certainty: certainty, scenario: scenario };
  }

  function candidateInput(input, existing) {
    if (!isObject(input)) return fail('candidate_required', 'Candidate input must be an object');
    var identitySource = isObject(input.identity) ? input.identity : {};
    function pick(name, fallback) {
      if (hasOwn(input, name)) return input[name];
      if (hasOwn(identitySource, name)) return identitySource[name];
      if (existing && hasOwn(existing.identity, name)) return existing.identity[name];
      return fallback;
    }
    var format = text(pick('format', input.type || (existing && existing.format) || 'raw')).toLowerCase();
    if (FORMATS.indexOf(format) < 0) return fail('invalid_format', 'Candidate format must be raw or slab');
    var identity = {
      name: text(pick('name', 'Unknown')) || 'Unknown',
      set: text(pick('set', 'Unknown')) || 'Unknown',
      number: text(pick('number', 'Unknown')) || 'Unknown',
      language: text(pick('language', 'Unknown')) || 'Unknown',
      variant: text(pick('variant', 'Unknown')) || 'Unknown'
    };
    var ownership = text(input.ownership || (existing && existing.ownership) || 'Unknown');
    if (OWNERSHIP.indexOf(ownership) < 0) return fail('invalid_ownership', 'Ownership must be Business, Collection, or Unknown');
    var condition = normaliseCondition(input.condition !== undefined ? input.condition : (existing && existing.condition), input);
    var cert = text(input.certificateNumber || input.certificate || input.certNo || (existing && existing.certificateNumber) || '');
    var grader = text(input.grader || (existing && existing.grader) || '');
    var grade = text(input.grade || (existing && existing.grade) || '');
    var frontRef = text(input.frontRef || (existing && existing.frontRef) || '');
    var backRef = text(input.backRef || (existing && existing.backRef) || '');
    var evidenceInput = input.evidenceRefs || input.evidence || (existing && existing.evidenceRefs) || [];
    if (!Array.isArray(evidenceInput)) return fail('invalid_evidence', 'Candidate evidence must be an array');
    var evidenceRefs = [];
    for (var i = 0; i < evidenceInput.length; i += 1) {
      var evidence = normaliseEvidence(evidenceInput[i]);
      if (!evidence.ok) return evidence;
      evidenceRefs.push(evidence.evidence);
    }
    var next = {
      identity: identity,
      format: format,
      ownership: ownership,
      condition: condition,
      grader: grader,
      grade: grade,
      certificateNumber: cert,
      frontRef: frontRef,
      backRef: backRef,
      evidenceRefs: evidenceRefs,
      notes: text(input.notes !== undefined ? input.notes : (existing && existing.notes) || ''),
      hold: input.hold === true || (existing && existing.hold === true),
      holdReason: text(input.holdReason !== undefined ? input.holdReason : (existing && existing.holdReason) || '')
    };
    if (input.asking !== undefined || (existing && existing.asking)) next.asking = clone(input.asking !== undefined ? input.asking : existing.asking);
    if (next.asking && !isObject(next.asking)) return fail('invalid_asking', 'Asking approval must be an object');
    return { ok: true, value: next };
  }

  function candidateIdentityChanged(before, after) {
    if (!before || !after) return true;
    if (before.format !== after.format || before.ownership !== after.ownership || before.grader !== after.grader || before.grade !== after.grade || before.certificateNumber !== after.certificateNumber || before.frontRef !== after.frontRef || before.backRef !== after.backRef) return true;
    if (safeJson(before.identity) !== safeJson(after.identity) || safeJson(before.condition) !== safeJson(after.condition)) return true;
    return false;
  }

  function validateCandidate(candidate, label) {
    var prefix = label || 'Candidate';
    if (!isObject(candidate) || !validId(candidate.id)) return fail('invalid_candidate', prefix + ' has an invalid id');
    if (candidate.ownerId !== ownerId()) return fail('owner_mismatch', prefix + ' belongs to another local owner');
    if (!Number.isSafeInteger(candidate.version) || candidate.version < 1) return fail('invalid_candidate_version', prefix + ' has an invalid version');
    if (CANDIDATE_STATES.indexOf(candidate.status) < 0) return fail('invalid_candidate_status', prefix + ' state is invalid');
    if (FORMATS.indexOf(candidate.format) < 0) return fail('invalid_format', prefix + ' format is invalid');
    if (!isObject(candidate.identity)) return fail('invalid_identity', prefix + ' identity is missing');
    for (var identityIndex = 0; identityIndex < 5; identityIndex += 1) {
      var identityKey = ['name', 'set', 'number', 'language', 'variant'][identityIndex];
      if (!nonEmpty(candidate.identity[identityKey])) return fail('invalid_identity', prefix + ' identity ' + identityKey + ' is missing');
    }
    if (OWNERSHIP.indexOf(candidate.ownership) < 0) return fail('invalid_ownership', prefix + ' ownership is invalid');
    if (!isObject(candidate.condition) || !nonEmpty(candidate.condition.value) || CONDITION_CERTAINTY.indexOf(candidate.condition.certainty) < 0) return fail('invalid_condition', prefix + ' condition is invalid');
    if (candidate.condition.certainty === 'Estimated' && !nonEmpty(candidate.condition.scenario)) return fail('condition_scenario_required', prefix + ' estimated condition needs an explicit scenario');
    if (!Array.isArray(candidate.evidenceRefs)) return fail('invalid_evidence', prefix + ' evidence is invalid');
    for (var i = 0; i < candidate.evidenceRefs.length; i += 1) {
      var evidence = normaliseEvidence(candidate.evidenceRefs[i]);
      if (!evidence.ok) return evidence;
    }
    return { ok: true };
  }

  function validateRef(ref, label, tables) {
    if (!isObject(ref) || !validId(text(ref.id)) || (tables && tables.indexOf(ref.table) < 0)) return fail('invalid_reference', (label || 'Reference') + ' is invalid');
    if (!Number.isSafeInteger(ref.version) || ref.version < 0) return fail('invalid_reference_version', (label || 'Reference') + ' version is invalid');
    if (typeof ref.bytes !== 'string' || !ref.bytes) return fail('invalid_reference_bytes', (label || 'Reference') + ' bytes are required');
    if (ref.ownerId !== ownerId()) return fail('owner_mismatch', (label || 'Reference') + ' belongs to another local owner');
    return { ok: true };
  }

  function validateExactMagnitude(value, label, required) {
    var money = getMoney();
    if (!money || typeof money.parseMagnitude !== 'function') return fail('money_module_required', 'Dealer Desk cannot validate exact money without DealerMoney');
    if (value === null || value === undefined || value === '') return required ? fail('metadata_corrupt', label + ' is required') : { ok: true };
    if (typeof value !== 'string') return fail('metadata_corrupt', label + ' must remain an exact decimal string');
    try {
      var canonical = money.parseMagnitude(value);
      if (canonical === null) return fail('metadata_corrupt', label + ' is not exact money');
    } catch (error) { return fail('metadata_corrupt', label + ' is invalid exact money'); }
    return { ok: true };
  }

  function validateSignedExactMagnitude(value, label, required) {
    var money = getMoney();
    if (!money || typeof money.parseSigned !== 'function') return fail('money_module_required', 'Dealer Desk cannot validate signed exact money without DealerMoney');
    if (value === null || value === undefined || value === '') return required ? fail('metadata_corrupt', label + ' is required') : { ok: true };
    if (typeof value !== 'string') return fail('metadata_corrupt', label + ' must remain an exact decimal string');
    try {
      var canonical = money.parseSigned(value);
      if (canonical === null) return fail('metadata_corrupt', label + ' is not exact signed money');
    } catch (error) { return fail('metadata_corrupt', label + ' is invalid signed exact money'); }
    return { ok: true };
  }

  function validateCostComponent(component, label) {
    if (!isObject(component) || component.ownerId !== ownerId() || component.confirmed !== true || !validTimestamp(component.reviewedAt) || !nonEmpty(component.reason)) return fail('metadata_corrupt', (label || 'Cost component') + ' is invalid');
    var fields = ['itemCost', 'nonItemAcquisitionCosts', 'total', 'originalTotal', 'settledAmount', 'settledItemCost', 'settledNonItemAcquisitionCosts'];
    for (var i = 0; i < fields.length; i += 1) {
      var checked = validateExactMagnitude(component[fields[i]], (label || 'Cost component') + '.' + fields[i], true);
      if (!checked.ok) return checked;
    }
    if (!/^[A-Z]{3}$/.test(text(component.currency)) || !/^[A-Z]{3}$/.test(text(component.originalCurrency))) return fail('metadata_corrupt', (label || 'Cost component') + ' currency is invalid');
    var money = getMoney();
    try {
      if (component.originalCurrency === 'SGD' && component.total !== money.add(component.itemCost, component.nonItemAcquisitionCosts)) return fail('metadata_corrupt', (label || 'Cost component') + ' total does not equal item plus non-item cost');
      if (component.originalCurrency !== 'SGD') {
        if (text(component.settledCurrency) !== 'SGD') return fail('metadata_corrupt', (label || 'Cost component') + ' settled currency is invalid');
        if (!isObject(component.fx) || typeof money.validateFx !== 'function') return fail('metadata_corrupt', (label || 'Cost component') + ' foreign currency settlement is missing FX metadata');
        money.validateFx(component.fx);
        if (component.settledAmount !== money.add(component.settledItemCost, component.settledNonItemAcquisitionCosts)) return fail('metadata_corrupt', (label || 'Cost component') + ' settled total does not equal settled components');
      }
    } catch (error) { return fail('metadata_corrupt', (label || 'Cost component') + ' arithmetic is invalid'); }
    return { ok: true };
  }

  function validateDealerActual(actual, label) {
    if (!isObject(actual) || text(actual.reportingCurrency) !== 'SGD' || ['Unknown', 'Settled'].indexOf(actual.paymentStatus) < 0) return fail('metadata_corrupt', (label || 'Sale actual') + ' is invalid');
    var fields = ['proceeds', 'canonicalLandedCost', 'sellingFee', 'outboundShipping'];
    for (var i = 0; i < fields.length; i += 1) {
      var checked = validateExactMagnitude(actual[fields[i]], (label || 'Sale actual') + '.' + fields[i], true);
      if (!checked.ok) return checked;
    }
    if (!Array.isArray(actual.lines) || actual.lines.length < 4) return fail('metadata_corrupt', (label || 'Sale actual') + ' must retain typed money lines');
    var money = getMoney();
    var requiredTypes = { proceeds: 'credit', landed_cost: 'debit', selling_fee: 'debit', outbound_shipping: 'debit' };
    for (var l = 0; l < actual.lines.length; l += 1) {
      var line = money && typeof money.validateMoneyLine === 'function' ? money.validateMoneyLine(actual.lines[l]) : { valid: false };
      if (!line.valid || !line.line || line.line.currency !== 'SGD' || line.line.status !== 'Posted' || requiredTypes[line.line.type] !== line.line.effect) return fail('metadata_corrupt', (label || 'Sale actual') + ' contains an invalid typed money line');
    }
    if (!isObject(actual.provenance)) return fail('metadata_corrupt', (label || 'Sale actual') + ' provenance is missing');
    var provenanceKeys = ['proceeds', 'sellingFee', 'outboundShipping'];
    for (var p = 0; p < provenanceKeys.length; p += 1) {
      var provenance = actual.provenance[provenanceKeys[p]];
      if (!isObject(provenance) || !nonEmpty(provenance.sourceCurrency)) return fail('metadata_corrupt', (label || 'Sale actual') + ' provenance is missing');
      var provenanceCheck = validateExactMagnitude(provenance.sourceAmount, (label || 'Sale actual') + '.provenance.' + provenanceKeys[p], true);
      if (!provenanceCheck.ok) return provenanceCheck;
    }
    if (actual.paymentStatus === 'Settled' && (!validTimestamp(actual.cashSettledAt) || !isObject(actual.settlementEvidence))) return fail('metadata_corrupt', (label || 'Sale actual') + ' settled evidence is missing');
    return { ok: true };
  }

  function validateContributionProjection(contribution, label) {
    if (!isObject(contribution) || ['Known', 'Unknown'].indexOf(contribution.status) < 0) return fail('metadata_corrupt', (label || 'Contribution') + ' status is invalid');
    if (contribution.status === 'Unknown') {
      if (!nonEmpty(contribution.reason)) return fail('metadata_corrupt', (label || 'Contribution') + ' Unknown reason is missing');
      return { ok: true };
    }
    var fields = ['realisedProceeds', 'canonicalLandedCost', 'sellingFee', 'outboundShipping', 'creditAdjustments', 'debitAdjustments'];
    for (var i = 0; i < fields.length; i += 1) {
      var checked = validateExactMagnitude(contribution[fields[i]], (label || 'Contribution') + '.' + fields[i], true);
      if (!checked.ok) return checked;
    }
    var contributionAmount = validateSignedExactMagnitude(contribution.contribution, (label || 'Contribution') + '.contribution', true);
    if (!contributionAmount.ok) return contributionAmount;
    if (contribution.settlementRequired !== true || contribution.inferredSettlement === true) return fail('metadata_corrupt', (label || 'Contribution') + ' settlement flags are invalid');
    return { ok: true };
  }

  function validateVarianceComponent(component, label) {
    if (!isObject(component) || ['Known', 'Unknown'].indexOf(component.status) < 0) return fail('metadata_corrupt', (label || 'Variance component') + ' status is invalid');
    if (component.status === 'Known') {
      var fields = ['expected', 'actual', 'delta'];
      for (var i = 0; i < fields.length; i += 1) {
        var checked = i === 2 ? validateSignedExactMagnitude(component[fields[i]], (label || 'Variance component') + '.' + fields[i], true) : validateExactMagnitude(component[fields[i]], (label || 'Variance component') + '.' + fields[i], true);
        if (!checked.ok) return checked;
      }
    } else if (component.reason !== undefined && !nonEmpty(component.reason)) return fail('metadata_corrupt', (label || 'Variance component') + ' Unknown reason is invalid');
    return { ok: true };
  }

  function validateVarianceProjection(variance, label) {
    if (!isObject(variance) || ['Known', 'Unknown'].indexOf(variance.status) < 0) return fail('metadata_corrupt', (label || 'Variance') + ' status is invalid');
    if (variance.status === 'Unknown') {
      if (!nonEmpty(variance.reason)) return fail('metadata_corrupt', (label || 'Variance') + ' Unknown reason is missing');
      return { ok: true };
    }
    var fields = ['plannedContribution', 'actualContribution', 'delta'];
    for (var i = 0; i < fields.length; i += 1) {
      var checked = validateSignedExactMagnitude(variance[fields[i]], (label || 'Variance') + '.' + fields[i], true);
      if (!checked.ok) return checked;
    }
    if (!isObject(variance.components)) return fail('metadata_corrupt', (label || 'Variance') + ' components are missing');
    var componentKeys = ['saleAmount', 'sellingFee', 'outboundShipping', 'landedCost'];
    for (var c = 0; c < componentKeys.length; c += 1) {
      var componentValid = validateVarianceComponent(variance.components[componentKeys[c]], (label || 'Variance') + '.components.' + componentKeys[c]);
      if (!componentValid.ok) return componentValid;
    }
    if (!isObject(variance.targetComparison) || ['Known', 'Unknown'].indexOf(variance.targetComparison.status) < 0) return fail('metadata_corrupt', (label || 'Variance') + ' target comparison is invalid');
    if (variance.targetComparison.status === 'Known') {
      var targetFields = ['targetContribution', 'actualContribution', 'delta'];
      for (var t = 0; t < targetFields.length; t += 1) {
        var targetValid = t === 0 ? validateExactMagnitude(variance.targetComparison[targetFields[t]], (label || 'Variance') + '.targetComparison.' + targetFields[t], true) : validateSignedExactMagnitude(variance.targetComparison[targetFields[t]], (label || 'Variance') + '.targetComparison.' + targetFields[t], true);
        if (!targetValid.ok) return targetValid;
      }
    }
    return { ok: true };
  }

  function validateReviewProjection(review) {
    if (!isObject(review.actual) || !isObject(review.variance)) return fail('metadata_corrupt', 'Dealer Desk review actual and variance are invalid');
    if (['Known', 'Unknown'].indexOf(review.actual.status) < 0) return fail('metadata_corrupt', 'Dealer Desk review actual status is invalid');
    if (review.actual.status === 'Unknown') {
      if (!nonEmpty(review.actual.reason)) return fail('metadata_corrupt', 'Dealer Desk review Unknown actual reason is missing');
    } else {
      var contributionValid = validateContributionProjection(review.actual.contribution, 'Dealer Desk review actual contribution');
      if (!contributionValid.ok) return contributionValid;
      if (review.actual.contribution.status !== review.actual.status || !Array.isArray(review.actual.lines) || review.actual.lines.length < 4) return fail('metadata_corrupt', 'Dealer Desk review actual lines are invalid');
      var money = getMoney();
      for (var i = 0; i < review.actual.lines.length; i += 1) {
        var line = money && typeof money.validateMoneyLine === 'function' ? money.validateMoneyLine(review.actual.lines[i]) : { valid: false };
        if (!line.valid) return fail('metadata_corrupt', 'Dealer Desk review actual line is invalid');
      }
      var saleRefValid = validateRef(review.actual.saleRef, 'Review sale reference', ['sales']);
      if (!saleRefValid.ok) return saleRefValid;
    }
    return validateVarianceProjection(review.variance, 'Dealer Desk review variance');
  }

  function sameMoneyValue(left, right) {
    if (left === null || left === undefined || right === null || right === undefined) return left === right;
    var money = getMoney();
    if (!money || typeof money.parseMagnitude !== 'function') return false;
    try { return money.parseMagnitude(String(left)) === money.parseMagnitude(String(right)); } catch (error) { return false; }
  }

  function derivedPlanCosts(plan) {
    var item = plan && plan.input && hasOwn(plan.input, 'plannedItemCost') ? moneyString(plan.input.plannedItemCost) : null;
    var nonItem = plan && plan.expected && plan.expected.knownNonItemAcquisitionCosts !== null && plan.expected.knownNonItemAcquisitionCosts !== undefined ? moneyString(plan.expected.knownNonItemAcquisitionCosts) : null;
    var landed = item !== null && nonItem !== null ? getMoney().add(item, nonItem) : null;
    return { item: item, landed: landed };
  }

  function actualInputFromSale(sale, costComponent) {
    return {
      reportingCurrency: 'SGD',
      realisedProceeds: { amount: sale.dealerActual.proceeds, currency: 'SGD', status: 'Posted', effect: 'credit', type: 'proceeds' },
      canonicalLandedCost: { amount: costComponent.total, currency: 'SGD', status: 'Posted', effect: 'debit', type: 'landed_cost' },
      sellingFee: { amount: sale.dealerActual.sellingFee, currency: 'SGD', status: 'Posted', effect: 'debit', type: 'selling_fee' },
      outboundShipping: { amount: sale.dealerActual.outboundShipping, currency: 'SGD', status: 'Posted', effect: 'debit', type: 'outbound_shipping' },
      creditAdjustments: [],
      debitAdjustments: []
    };
  }

  function buildVarianceProjection(plan, sale, contribution) {
    var money = getMoney();
    function componentVariance(expected, actualValue) {
      if (expected === null || expected === undefined || actualValue === null || actualValue === undefined) return { status: 'Unknown', expected: expected === undefined ? null : expected, actual: actualValue === undefined ? null : actualValue, delta: null };
      return { status: 'Known', expected: expected, actual: actualValue, delta: money.subtract(actualValue, expected) };
    }
    var plannedLanded = plan.plannedLandedCost && plan.plannedLandedCost.status === 'Known' ? plan.plannedLandedCost.amount : null;
    var plannedContribution = plan.expected && plan.expected.expectedNetProceeds !== null && plannedLanded !== null ? money.subtract(plan.expected.expectedNetProceeds, plannedLanded) : null;
    return {
      status: plannedContribution === null ? 'Unknown' : 'Known',
      plannedContribution: plannedContribution,
      actualContribution: contribution.contribution,
      delta: plannedContribution === null ? null : money.subtract(contribution.contribution, plannedContribution),
      formula: 'actual contribution - frozen planned contribution',
      components: {
        saleAmount: componentVariance(plan.expected ? plan.expected.expectedSaleAmount : null, sale.dealerActual.proceeds),
        sellingFee: componentVariance(plan.expected ? plan.expected.sellingFee : null, sale.dealerActual.sellingFee),
        outboundShipping: componentVariance(plan.expected ? plan.expected.outboundShipping : null, sale.dealerActual.outboundShipping),
        landedCost: componentVariance(plannedLanded, sale.dealerActual.canonicalLandedCost)
      },
      targetComparison: plan.expected && plan.expected.targetContribution !== null ? {
        status: 'Known',
        targetContribution: plan.expected.targetContribution,
        actualContribution: contribution.contribution,
        delta: money.subtract(contribution.contribution, plan.expected.targetContribution),
        formula: 'actual contribution - target contribution'
    } : { status: 'Unknown', targetContribution: null, actualContribution: contribution.contribution, delta: null }
    };
  }

  function comparableReviewActual(actual) {
    var comparable = clone(actual);
    if (comparable && comparable.status === 'Known' && comparable.reason === 'No settled completed sale') delete comparable.reason;
    return comparable;
  }

  function validateState(state) {
    if (!isObject(state)) return fail('metadata_corrupt', 'Dealer Desk metadata must be an object');
    if (state.schemaVersion !== SCHEMA_VERSION || state.release !== VERSION) return fail('unsupported_schema', 'Dealer Desk metadata schema is unsupported');
    if (state.ownerId !== ownerId() || state.ownerScope !== ownerScope()) return fail('owner_mismatch', 'Dealer Desk metadata belongs to another local owner scope');
    if (!Number.isSafeInteger(state.revision) || state.revision < 0) return fail('invalid_revision', 'Dealer Desk metadata revision is invalid');
    if (!validTimestamp(state.updatedAt)) return fail('invalid_metadata_timestamp', 'Dealer Desk metadata timestamp is invalid');
    var arrays = ['candidates', 'evidence', 'plans', 'copies', 'listings', 'outcomes', 'reviews', 'requestLedger'];
    for (var i = 0; i < arrays.length; i += 1) if (!Array.isArray(state[arrays[i]])) return fail('metadata_corrupt', 'Dealer Desk metadata array ' + arrays[i] + ' is invalid');
    var ids = {};
    for (var c = 0; c < state.candidates.length; c += 1) {
      if (ids['candidate/' + state.candidates[c].id]) return fail('metadata_corrupt', 'Dealer Desk candidate ids must be unique');
      ids['candidate/' + state.candidates[c].id] = true;
      var candidate = validateCandidate(state.candidates[c], 'Candidate');
      if (!candidate.ok) return candidate;
    }
    var planVersionKeys = {};
    for (var p = 0; p < state.plans.length; p += 1) {
      var plan = state.plans[p];
      if (!isObject(plan) || !validId(plan.id) || !validId(plan.candidateId) || !validId(plan.lineageId) || plan.ownerId !== ownerId() || !Number.isSafeInteger(plan.version) || plan.version < 1 || !validTimestamp(plan.snapshotAt || plan.createdAt) || !nonEmpty(plan.reason) || ['Draft', 'Approved', 'Superseded'].indexOf(plan.status) < 0 || !isObject(plan.plannedItemCost) || ['Known', 'Unknown'].indexOf(plan.plannedItemCost.status) < 0 || !isObject(plan.plannedLandedCost) || ['Known', 'Unknown'].indexOf(plan.plannedLandedCost.status) < 0 || !isObject(plan.input) || !isObject(plan.expected)) return fail('metadata_corrupt', 'Dealer Desk plan is invalid');
      if (ids['plan/' + plan.id] || !ids['candidate/' + plan.candidateId]) return fail('metadata_corrupt', 'Dealer Desk plan link is invalid');
      var planVersionKey = plan.candidateId + '/' + plan.version;
      if (planVersionKeys[planVersionKey]) return fail('metadata_corrupt', 'Dealer Desk plan versions must be unique per candidate');
      planVersionKeys[planVersionKey] = true;
      ids['plan/' + plan.id] = true;
      if (!isObject(plan.candidateSnapshot) || plan.candidateSnapshot.id !== plan.candidateId || plan.candidateSnapshot.ownerId !== ownerId() || plan.candidateSnapshot.version !== plan.candidateVersion) return fail('metadata_corrupt', 'Dealer Desk plan snapshot is invalid');
      var snapshotValid = validateCandidate(plan.candidateSnapshot, 'Plan candidate snapshot');
      if (!snapshotValid.ok) return snapshotValid;
      var planMoney = getMoney();
      if (!planMoney || typeof planMoney.planEconomics !== 'function') return fail('money_module_required', 'Dealer Desk cannot validate a frozen plan without DealerMoney');
      var recomputedPlan;
      try { recomputedPlan = planMoney.planEconomics(plan.input); } catch (error) { return fail('metadata_corrupt', 'Dealer Desk plan economics cannot be recomputed'); }
      if (stableFingerprint(recomputedPlan) !== stableFingerprint(plan.expected)) return fail('metadata_corrupt', 'Dealer Desk frozen plan economics do not match its input');
      var plannedItem = validateExactMagnitude(plan.plannedItemCost.amount, 'Dealer Desk planned item cost', plan.plannedItemCost.status === 'Known');
      if (!plannedItem.ok) return plannedItem;
      if (plan.plannedItemCost.status === 'Known' && plan.plannedItemCost.currency !== 'SGD') return fail('metadata_corrupt', 'Dealer Desk planned item cost currency is invalid');
      var plannedLanded = validateExactMagnitude(plan.plannedLandedCost.amount, 'Dealer Desk planned landed cost', plan.plannedLandedCost.status === 'Known');
      if (!plannedLanded.ok) return plannedLanded;
      if (plan.plannedLandedCost.status === 'Known' && plan.plannedLandedCost.currency !== 'SGD') return fail('metadata_corrupt', 'Dealer Desk planned landed cost currency is invalid');
      var derivedCosts;
      try { derivedCosts = derivedPlanCosts(plan); } catch (error) { return fail('metadata_corrupt', 'Dealer Desk planned costs cannot be derived from the frozen inputs'); }
      if ((derivedCosts.item === null) !== (plan.plannedItemCost.status === 'Unknown') || (derivedCosts.item !== null && !sameMoneyValue(derivedCosts.item, plan.plannedItemCost.amount))) return fail('metadata_corrupt', 'Dealer Desk planned item cost does not match its frozen input');
      if ((derivedCosts.landed === null) !== (plan.plannedLandedCost.status === 'Unknown') || (derivedCosts.landed !== null && !sameMoneyValue(derivedCosts.landed, plan.plannedLandedCost.amount))) return fail('metadata_corrupt', 'Dealer Desk planned landed cost does not match its frozen inputs');
      var knownExpectedKeys = ['expectedSaleAmount', 'sellingFee', 'outboundShipping', 'refundAllowance', 'otherDeductions', 'targetContribution', 'riskAllowance', 'knownNonItemAcquisitionCosts', 'expectedNetProceeds', 'maximumAllInAcquisitionCost', 'maximumAllInAcquisitionCostRounded', 'rawItemPriceCeiling', 'itemPriceCeiling', 'itemCeiling'];
      for (var pk = 0; pk < knownExpectedKeys.length; pk += 1) {
        var expectedCheck = validateExactMagnitude(plan.expected[knownExpectedKeys[pk]], 'Dealer Desk plan expected.' + knownExpectedKeys[pk], false);
        if (!expectedCheck.ok) return expectedCheck;
      }
    }
    var copyKeys = {};
    for (var cp = 0; cp < state.copies.length; cp += 1) {
      var copyRef = state.copies[cp];
      if (!isObject(copyRef) || !validId(copyRef.id) || !validId(copyRef.candidateId) || copyRef.ownerId !== ownerId()) return fail('metadata_corrupt', 'Dealer Desk copy is invalid');
      if (ids['copy/' + copyRef.id] || !ids['candidate/' + copyRef.candidateId] || copyRef.inventoryOwnerId !== ownerId() || !Number.isSafeInteger(copyRef.candidateVersion) || copyRef.candidateVersion < 1) return fail('metadata_corrupt', 'Dealer Desk copy link is invalid');
      var copyCandidate = findById(state.candidates, copyRef.candidateId);
      if (!copyCandidate || copyCandidate.status !== 'Acquired' || copyCandidate.version !== copyRef.candidateVersion) return fail('metadata_corrupt', 'Dealer Desk copy candidate state is invalid');
      var item = validateRef(copyRef.itemRef, 'Copy item', ITEM_TABLES);
      if (!item.ok) return item;
      if (copyRef.costRef && (!isObject(copyRef.costRef) || copyRef.costRef.table !== copyRef.itemRef.table || copyRef.costRef.id !== copyRef.itemRef.id || copyRef.costRef.field !== 'costPrice')) return fail('metadata_corrupt', 'Dealer Desk cost reference is invalid');
      var costValid = validateCostComponent(copyRef.costComponent, 'Dealer Desk canonical cost component');
      if (!costValid.ok) return costValid;
      var copyKey = copyRef.itemRef.table + '/' + copyRef.itemRef.id;
      if (copyKeys[copyKey]) return fail('metadata_corrupt', 'Dealer Desk physical copies cannot be linked twice');
      copyKeys[copyKey] = true;
      ids['copy/' + copyRef.id] = true;
    }
    for (var e = 0; e < state.evidence.length; e += 1) {
      var evidenceRecord = state.evidence[e];
      if (!isObject(evidenceRecord) || !validId(evidenceRecord.id) || evidenceRecord.ownerId !== ownerId() || !ids['candidate/' + evidenceRecord.candidateId]) return fail('metadata_corrupt', 'Dealer Desk evidence link is invalid');
      if (ids['evidence/' + evidenceRecord.id]) return fail('metadata_corrupt', 'Dealer Desk evidence ids must be unique');
      ids['evidence/' + evidenceRecord.id] = true;
    }
    for (var l = 0; l < state.listings.length; l += 1) {
      var listing = state.listings[l];
      if (!isObject(listing) || !validId(listing.id) || listing.ownerId !== ownerId() || !ids['candidate/' + listing.candidateId] || !ids['copy/' + listing.copyId] || listing.published === true) return fail('metadata_corrupt', 'Dealer Desk listing link is invalid');
      if (ids['listing/' + listing.id]) return fail('metadata_corrupt', 'Dealer Desk listing ids must be unique');
      ids['listing/' + listing.id] = true;
    }
    for (var o = 0; o < state.outcomes.length; o += 1) {
      var outcome = state.outcomes[o];
      if (!isObject(outcome) || !validId(outcome.id) || !validId(outcome.candidateId) || outcome.ownerId !== ownerId() || !ids['candidate/' + outcome.candidateId] || (outcome.copyId && !ids['copy/' + outcome.copyId])) return fail('metadata_corrupt', 'Dealer Desk outcome is invalid');
      if (ids['outcome/' + outcome.id]) return fail('metadata_corrupt', 'Dealer Desk outcome ids must be unique');
      ids['outcome/' + outcome.id] = true;
      if (outcome.saleRef) {
        var sale = validateRef(outcome.saleRef, 'Sale reference', ['sales']);
        if (!sale.ok) return sale;
      }
    }
    for (var r = 0; r < state.reviews.length; r += 1) {
      var review = state.reviews[r];
      if (!isObject(review) || !validId(review.id) || review.ownerId !== ownerId() || !ids['candidate/' + review.candidateId] || !ids['outcome/' + review.outcomeId] || !isObject(review.planRef) || !ids['plan/' + review.planRef.id] || !nonEmpty(review.cause) || !isObject(review.restockDecision) || !validTimestamp(review.restockDecision.date)) return fail('metadata_corrupt', 'Dealer Desk review link is invalid');
      if (ids['review/' + review.id]) return fail('metadata_corrupt', 'Dealer Desk review ids must be unique');
      ids['review/' + review.id] = true;
      var frozenPlan = findById(state.plans, review.planRef.id);
      if (!frozenPlan || review.planRef.version !== frozenPlan.version || !isObject(review.frozenPlan) || review.frozenPlan.id !== frozenPlan.id || review.frozenPlan.version !== frozenPlan.version || stableFingerprint(review.frozenPlan.expected) !== stableFingerprint(frozenPlan.expected)) return fail('metadata_corrupt', 'Dealer Desk review does not retain the approved frozen plan');
      var reviewProjectionValid = validateReviewProjection(review);
      if (!reviewProjectionValid.ok) return reviewProjectionValid;
    }
    var requestIds = {};
    for (var q = 0; q < state.requestLedger.length; q += 1) {
      var receipt = state.requestLedger[q];
      if (!isObject(receipt) || !nonEmpty(receipt.requestId) || requestIds[receipt.requestId] || !nonEmpty(receipt.fingerprint) || !isObject(receipt.result) || !validTimestamp(receipt.at)) return fail('metadata_corrupt', 'Dealer Desk request receipt is invalid');
      requestIds[receipt.requestId] = true;
    }
    return { ok: true };
  }

  function findById(array, id) {
    return Array.isArray(array) ? array.find(function (item) { return item && item.id === id; }) : null;
  }

  function inventoryPayloadFromDb() {
    var db = getDb() || {};
    var payload = {};
    ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'].forEach(function (table) {
      payload[table] = Array.isArray(db[table]) ? clone(db[table]) : [];
    });
    return payload;
  }

  function readInventory() {
    var recovery = recoverPendingWal();
    if (recovery) return recovery;
    var rawResult = readRaw(INVENTORY_KEY);
    if (!rawResult.ok) return rawResult.error;
    var raw = rawResult.raw;
    var payload;
    var storedRaw = raw;
    if (raw === null || raw === '') {
      payload = inventoryPayloadFromDb();
    } else {
      try { payload = JSON.parse(raw); } catch (error) { return fail('inventory_corrupt', 'Inventory cache is not valid JSON'); }
    }
    if (!isObject(payload)) return fail('inventory_corrupt', 'Inventory cache is not an object');
    for (var i = 0; i < TABLES.length; i += 1) {
      if (payload[TABLES[i]] !== undefined && !Array.isArray(payload[TABLES[i]])) return fail('inventory_corrupt', 'Inventory table ' + TABLES[i] + ' is invalid');
    }
    return { ok: true, raw: storedRaw, payload: payload };
  }

  function rowFromPayload(payload, table, id) {
    return payload && Array.isArray(payload[table]) ? payload[table].find(function (row) { return row && row.id === id; }) : null;
  }

  function rowQuantity(row) {
    if (!row) return 0;
    if (row.qty !== undefined && row.qty !== '') return Number(row.qty);
    if (row.quantity !== undefined && row.quantity !== '') return Number(row.quantity);
    return 1;
  }

  function rowVersion(row) {
    if (!row) return 0;
    if (Number.isSafeInteger(row._serverVersion)) return row._serverVersion;
    if (Number.isSafeInteger(row.rowVersion)) return row.rowVersion;
    if (Number.isSafeInteger(row.version)) return row.version;
    return 0;
  }

  function rowBytes(row) {
    return safeJson(row);
  }

  function dbRow(payload, table, id) {
    var db = getDb();
    var rawRow = rowFromPayload(payload, table, id);
    var liveRow = db && Array.isArray(db[table]) ? db[table].find(function (row) { return row && row.id === id; }) : null;
    if (!rawRow || !liveRow || rowBytes(rawRow) !== rowBytes(liveRow)) return null;
    return rawRow;
  }

  function validateStateLinks(state, payload) {
    if (!payload) return { ok: true };
    for (var i = 0; i < state.copies.length; i += 1) {
      var copy = state.copies[i];
      var row = rowFromPayload(payload, copy.itemRef.table, copy.itemRef.id);
      if (!row || rowBytes(row) !== copy.itemRef.bytes || rowQuantity(row) !== 1) return fail('inventory_version_conflict', 'Dealer Desk copy reference is stale or invalid', { table: copy.itemRef.table, id: copy.itemRef.id });
      if (text(row._dealerOwnerId || row.ownerId || '') !== ownerId()) return fail('inventory_owner_required', 'Dealer Desk copy row owner is outside the local owner scope');
      var candidate = findById(state.candidates, copy.candidateId);
      if (!candidate || !candidateMatchesRow(candidate, row, copy.itemRef.table)) return fail('identity_mismatch', 'Dealer Desk copy no longer matches its candidate');
      if (!isObject(row.dealerCostBasis) || safeJson(row.dealerCostBasis) !== safeJson(copy.costComponent)) return fail('cost_basis_mismatch', 'Dealer Desk canonical cost basis is not stored on the linked inventory row');
    }
    for (var o = 0; o < state.outcomes.length; o += 1) {
      var outcome = state.outcomes[o];
      if (!outcome.saleRef) continue;
      var sale = rowFromPayload(payload, 'sales', outcome.saleRef.id);
      if (!sale || rowBytes(sale) !== outcome.saleRef.bytes || sale.inventoryId !== (findById(state.copies, outcome.copyId) || {}).itemRef.id) return fail('sale_reference_conflict', 'Dealer Desk sale reference is stale or invalid');
      var saleActual = validateDealerActual(sale.dealerActual, 'Dealer Desk sale actual');
      if (!saleActual.ok) return saleActual;
      if (['Unknown', 'Settled'].indexOf(text(sale.paymentStatus)) < 0) return fail('sale_reference_conflict', 'Dealer Desk sale payment status is invalid');
      if (sale.inventoryTable !== (findById(state.copies, outcome.copyId) || {}).itemRef.table || !validId(text(sale.inventoryId))) return fail('sale_reference_conflict', 'Dealer Desk sale inventory link is invalid');
    }
    for (var rv = 0; rv < state.reviews.length; rv += 1) {
      var linkedReview = state.reviews[rv];
      var linkedOutcome = findById(state.outcomes, linkedReview.outcomeId);
      if (!linkedOutcome) return fail('review_reference_conflict', 'Dealer Desk review outcome is missing');
      if (linkedOutcome.kind !== 'sale') {
        if (!linkedReview.actual || linkedReview.actual.status !== 'Unknown' || !linkedReview.variance || linkedReview.variance.status !== 'Unknown') return fail('review_reference_conflict', 'Non-sale review cannot contain realised contribution');
        continue;
      }
      if (!linkedOutcome.saleRef || linkedOutcome.paymentStatus !== 'Settled') return fail('review_reference_conflict', 'Sale review requires the explicitly settled sale');
      var linkedSale = rowFromPayload(payload, 'sales', linkedOutcome.saleRef.id);
      var linkedCopy = findById(state.copies, linkedOutcome.copyId);
      var linkedPlan = linkedReview.planRef && findById(state.plans, linkedReview.planRef.id);
      var linkedCandidate = findById(state.candidates, linkedReview.candidateId);
      if (!linkedSale || !linkedCopy || !linkedPlan || !linkedCandidate || linkedPlan.status !== 'Approved' || linkedCandidate.approvedPlanId !== linkedPlan.id || linkedOutcome.planId !== linkedPlan.id || linkedSale.paymentStatus !== 'Settled' || rowBytes(linkedSale) !== linkedOutcome.saleRef.bytes) return fail('review_reference_conflict', 'Dealer Desk review sale or plan reference is stale');
      var linkedMoney = getMoney();
      var linkedActualInput = actualInputFromSale(linkedSale, linkedCopy.costComponent);
      var linkedContribution;
      try { linkedContribution = linkedMoney.actualContribution(linkedActualInput); } catch (error) { return fail('review_reference_conflict', 'Dealer Desk review actual contribution cannot be recomputed'); }
      var expectedActual = { status: linkedContribution.status, contribution: linkedContribution, saleRef: clone(linkedOutcome.saleRef), lines: [linkedActualInput.realisedProceeds, linkedActualInput.canonicalLandedCost, linkedActualInput.sellingFee, linkedActualInput.outboundShipping] };
      if (stableFingerprint(comparableReviewActual(linkedReview.actual)) !== stableFingerprint(comparableReviewActual(expectedActual))) return fail('review_reference_conflict', 'Dealer Desk review actual contribution does not match the settled sale');
      var expectedVariance;
      try { expectedVariance = buildVarianceProjection(linkedPlan, linkedSale, linkedContribution); } catch (error) { return fail('review_reference_conflict', 'Dealer Desk review variance cannot be recomputed'); }
      if (stableFingerprint(linkedReview.variance) !== stableFingerprint(expectedVariance)) return fail('review_reference_conflict', 'Dealer Desk review variance does not match the frozen plan and settled sale');
    }
    return { ok: true };
  }

  function availableStatus(row) {
    var status = text(row && row.status).toLowerCase();
    return ['available', 'in stock', 'owned', 'unlisted', 'active'].indexOf(status) >= 0;
  }

  function moneyString(value) {
    var money = getMoney();
    if (!money || typeof money.parseMagnitude !== 'function') return null;
    try { return money.parseMagnitude(String(value)); } catch (error) { return null; }
  }

  function numericMoney(value) {
    var normal = moneyString(value);
    if (normal === null) return null;
    var numeric = Number(normal);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function stableFingerprint(value) {
    if (Array.isArray(value)) return '[' + value.map(stableFingerprint).join(',') + ']';
    if (isObject(value)) return '{' + Object.keys(value).sort().map(function (key) { return JSON.stringify(key) + ':' + stableFingerprint(value[key]); }).join(',') + '}';
    return JSON.stringify(value);
  }

  function restoreCoreFingerprint(state) {
    var core = clone(state);
    if (!core) return '';
    delete core.revision;
    delete core.updatedAt;
    delete core.requestLedger;
    return stableFingerprint(core);
  }

  function hasCoreRecords(state) {
    var arrays = ['candidates', 'evidence', 'plans', 'copies', 'listings', 'outcomes', 'reviews'];
    for (var i = 0; i < arrays.length; i += 1) if (Array.isArray(state[arrays[i]]) && state[arrays[i]].length > 0) return true;
    return false;
  }

  function mergeRequestLedgers(current, snapshot) {
    var merged = [];
    var seen = {};
    (Array.isArray(current) ? current : []).concat(Array.isArray(snapshot) ? snapshot : []).forEach(function (entry) {
      if (!entry || !nonEmpty(entry.requestId) || seen[entry.requestId]) return;
      seen[entry.requestId] = true;
      merged.push(clone(entry));
    });
    return merged;
  }

  function metadataRequestId(options) {
    return text(options && (options.requestId || options.request_id));
  }

  function mutationContext(options, payload) {
    var source = options || {};
    var context = Object.assign({}, source);
    if (!nonEmpty(context.ownerId)) context.ownerId = '';
    if (!nonEmpty(context.requestId)) context.requestId = '';
    if (context.expectedRevision === undefined) context.expectedRevision = null;
    /* The caller-supplied fingerprint is advisory input, never an authority.
     * Derive it from the semantic operation payload so a reused request id
     * cannot disguise a different write. Generated ids and timestamps stay
     * inside the mutator and are therefore not part of this payload. */
    context.fingerprint = stableFingerprint(payload === undefined ? {} : payload);
    return context;
  }

  function validateMutationIdentity(options) {
    options = options || {};
    if (options.ownerId !== ownerId()) return fail('owner_required', 'Dealer Desk writes require the current local pilot owner');
    if (!nonEmpty(options.requestId)) return fail('request_id_required', 'Dealer Desk writes require a request id for safe retry');
    return { ok: true };
  }

  function validateMutationRevision(options, currentRevision) {
    options = options || {};
    if (!Number.isSafeInteger(options.expectedRevision)) return fail('revision_required', 'Dealer Desk writes require the current metadata revision');
    if (options.expectedRevision !== currentRevision) return fail('revision_conflict', 'Dealer Desk metadata changed in another tab', { currentRevision: currentRevision, expectedRevision: options.expectedRevision });
    return { ok: true };
  }

  function ledgerResult(state, requestId) {
    if (!requestId) return null;
    var entry = state.requestLedger.find(function (item) { return item && item.requestId === requestId; });
    return entry && entry.result ? clone(entry.result) : null;
  }

  function appendLedger(state, requestId, result, fingerprint) {
    if (!requestId) return;
    state.requestLedger = state.requestLedger.filter(function (item) { return item && item.requestId !== requestId; });
    state.requestLedger.push({ requestId: requestId, result: clone(result), fingerprint: text(fingerprint), at: now() });
  }

  function ledgerEntry(state, requestId) {
    if (!requestId) return null;
    return state.requestLedger.find(function (item) { return item && item.requestId === requestId; }) || null;
  }

  function storageError(error) {
    var message = error && error.message ? error.message : String(error || 'storage_write_failed');
    return fail('storage_write_failed', 'Dealer Desk could not confirm the local write', { reason: message });
  }

  function commitMetadata(mutator, options) {
    var guard = guardPreview();
    if (guard) return Promise.resolve(guard);
    options = options || {};
    return runLocked(function () {
      var pendingRecovery = recoverPendingWal();
      if (pendingRecovery) return pendingRecovery;
      var rawResult = readRaw(METADATA_KEY);
      if (!rawResult.ok) return rawResult.error;
      var parsed = parseState(rawResult.raw);
      if (!parsed.ok) return parsed;
      var state = parsed.state;
      if (rawResult.raw !== null) {
        var inventoryForValidation = readInventory();
        if (!inventoryForValidation.ok) return inventoryForValidation;
        var existingLinks = validateStateLinks(state, inventoryForValidation.payload);
        if (!existingLinks.ok) return existingLinks;
      }
      var context = validateMutationIdentity(options);
      if (!context.ok) return context;
      var requestId = metadataRequestId(options);
      var priorEntry = ledgerEntry(state, requestId);
      var prior = priorEntry && priorEntry.result;
      if (prior) {
        if (priorEntry.fingerprint !== options.fingerprint) return fail('request_reuse_conflict', 'Request id was already used for a different payload');
        return success(Object.assign({}, prior, { idempotent: true }));
      }
      var revisionContext = validateMutationRevision(options, state.revision);
      if (!revisionContext.ok) return revisionContext;
      var beforeRaw = rawResult.raw;
      if (typeof mutator !== 'function') return fail('invalid_operation', 'Dealer Desk operation is invalid');
      var working = clone(state);
      var mutation;
      try { mutation = mutator(working); } catch (error) { return fail('operation_failed', error.message || 'Dealer Desk operation failed'); }
      if (!mutation || mutation.ok === false) return mutation || fail('operation_failed', 'Dealer Desk operation failed');
      var result = mutation.result || {};
      if (requestId) appendLedger(working, requestId, result, options.fingerprint);
      working.revision = state.revision + 1;
      working.updatedAt = now();
      var valid = validateState(working);
      if (!valid.ok) return valid;
      if (rawResult.raw !== null) {
        var nextLinks = validateStateLinks(working, inventoryForValidation.payload);
        if (!nextLinks.ok) return nextLinks;
      }
      var nextRaw = safeJson(working);
      if (!nextRaw) return fail('metadata_serialise_failed', 'Dealer Desk metadata could not be serialised');
      var latest = readRaw(METADATA_KEY);
      if (!latest.ok) return latest.error;
      if (!sameBytes(latest.raw, beforeRaw)) return fail('revision_conflict', 'Dealer Desk metadata changed before the write', { current: parseState(latest.raw).state || null, pending: options.pending || null });
      try {
        writeRaw(METADATA_KEY, nextRaw);
      } catch (error) {
        if (!casRestoreRaw(METADATA_KEY, beforeRaw, nextRaw)) return fail('rollback_failed', 'Dealer Desk could not confirm metadata rollback without overwriting an external write');
        return storageError(error);
      }
      return success(Object.assign({}, result, { state: working, revision: working.revision }));
    }, options.lockKeys);
  }

  function updateDbArrays(nextPayload) {
    var db = getDb();
    if (!db) return false;
    var keys = ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'];
    for (var i = 0; i < keys.length; i += 1) db[keys[i]] = clone(nextPayload[keys[i]] || []);
    return true;
  }

  function restoreDatabaseArrays(snapshot) {
    var db = getDb();
    if (!db) return false;
    Object.keys(snapshot).forEach(function (key) { db[key] = clone(snapshot[key]); });
    return true;
  }

  function assertExpectedRow(ref, payload, table, id, expectedVersion, expectedBytes) {
    var row = rowFromPayload(payload, table, id);
    if (!row) return fail('inventory_reference_missing', 'Referenced inventory row is missing');
    var liveRow = dbRow(payload, table, id);
    if (!liveRow) return fail('inventory_version_conflict', 'Referenced inventory row changed in memory or storage');
    var actualBytes = rowBytes(row);
    var actualVersion = rowVersion(row);
    var wantedVersion = expectedVersion !== undefined ? expectedVersion : (ref && ref.version);
    var wantedBytes = expectedBytes !== undefined ? expectedBytes : (ref && ref.bytes);
    if (wantedVersion !== undefined && actualVersion !== wantedVersion) return fail('inventory_version_conflict', 'Referenced inventory row version is stale', { expectedVersion: wantedVersion, currentVersion: actualVersion });
    if (wantedBytes !== undefined && actualBytes !== wantedBytes) return fail('inventory_version_conflict', 'Referenced inventory row bytes are stale');
    return { ok: true, row: row, bytes: actualBytes, version: actualVersion };
  }

  function updatePayloadRow(payload, table, id, nextRow) {
    var rows = Array.isArray(payload[table]) ? payload[table] : [];
    var index = rows.findIndex(function (row) { return row && row.id === id; });
    if (index < 0) return false;
    rows[index] = clone(nextRow);
    payload[table] = rows;
    return true;
  }

  function commitInventoryAndMetadata(mutator, options) {
    var guard = guardPreview();
    if (guard) return Promise.resolve(guard);
    options = options || {};
    return runLocked(function () {
      var pendingRecovery = recoverPendingWal();
      if (pendingRecovery) return pendingRecovery;
      var metadataRawResult = readRaw(METADATA_KEY);
      if (!metadataRawResult.ok) return metadataRawResult.error;
      var parsed = parseState(metadataRawResult.raw);
      if (!parsed.ok) return parsed;
      var metadataBefore = parsed.state;
      var context = validateMutationIdentity(options);
      if (!context.ok) return context;
      var requestId = metadataRequestId(options);
      var priorEntry = ledgerEntry(metadataBefore, requestId);
      var prior = priorEntry && priorEntry.result;
      if (prior) {
        if (priorEntry.fingerprint !== options.fingerprint) return fail('request_reuse_conflict', 'Request id was already used for a different payload');
        return success(Object.assign({}, prior, { idempotent: true }));
      }
      var revisionContext = validateMutationRevision(options, metadataBefore.revision);
      if (!revisionContext.ok) return revisionContext;
      var inventoryBeforeResult = readInventory();
      if (!inventoryBeforeResult.ok) return inventoryBeforeResult;
      var inventoryBeforeRaw = inventoryBeforeResult.raw;
      var inventoryBeforePayload = inventoryBeforeResult.payload;
      var existingLinks = validateStateLinks(metadataBefore, inventoryBeforePayload);
      if (!existingLinks.ok) return existingLinks;
      var db = getDb();
      var dbBefore = {};
      ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'].forEach(function (table) { dbBefore[table] = db && Array.isArray(db[table]) ? clone(db[table]) : []; });
      if (db && inventoryBeforeRaw !== null && !dbMatchesInventory(inventoryBeforePayload)) return fail('inventory_version_conflict', 'In-memory inventory differs from the persisted canonical inventory cache');
      var workingMetadata = clone(metadataBefore);
      var workingInventory = clone(inventoryBeforePayload);
      var mutation;
      try { mutation = mutator(workingMetadata, workingInventory); } catch (error) { return fail('operation_failed', error.message || 'Dealer Desk operation failed'); }
      if (!mutation || mutation.ok === false) return mutation || fail('operation_failed', 'Dealer Desk operation failed');
      var result = mutation.result || {};
      if (requestId) appendLedger(workingMetadata, requestId, result, options.fingerprint);
      workingMetadata.revision = metadataBefore.revision + 1;
      workingMetadata.updatedAt = now();
      var metadataValid = validateState(workingMetadata);
      if (!metadataValid.ok) return metadataValid;
      var nextLinks = validateStateLinks(workingMetadata, workingInventory);
      if (!nextLinks.ok) return nextLinks;
      var inventoryNextRaw = safeJson(workingInventory);
      var metadataNextRaw = safeJson(workingMetadata);
      if (!inventoryNextRaw || !metadataNextRaw) return fail('serialise_failed', 'Dealer Desk transaction could not be serialised');
      var latestMetadata = readRaw(METADATA_KEY);
      var latestInventory = readRaw(INVENTORY_KEY);
      if (!latestMetadata.ok) return latestMetadata.error;
      if (!latestInventory.ok) return latestInventory.error;
      if (!sameBytes(latestMetadata.raw, metadataRawResult.raw) || !sameBytes(latestInventory.raw, inventoryBeforeRaw)) return fail('storage_conflict', 'Inventory or Dealer Desk metadata changed before the write');
      if (db) {
        var dbTables = ['singles', 'slabs', 'sales', 'etbs', 'boosterBoxes', 'boosterPacks', 'ebayPurchases'];
        for (var d = 0; d < dbTables.length; d += 1) {
          if (safeJson(db[dbTables[d]] || []) !== safeJson(dbBefore[dbTables[d]] || [])) return fail('inventory_version_conflict', 'In-memory inventory changed before the write');
        }
      }
      var inventoryWritten = false;
      var walIntent = {
        schemaVersion: SCHEMA_VERSION,
        ownerId: ownerId(),
        txId: uuid('tx'),
        metadataBefore: metadataRawResult.raw,
        inventoryBefore: inventoryBeforeRaw,
        metadataNext: metadataNextRaw,
        inventoryNext: inventoryNextRaw,
        dbBefore: dbBefore,
        createdAt: now()
      };
      var walValid = validateWalIntent(walIntent);
      if (!walValid.ok) return walValid;
      var walNextState = parseState(metadataNextRaw);
      var walNextPayload = parsedInventory(inventoryNextRaw);
      if (!walNextState.ok || !walNextPayload || !validateStateLinks(walNextState.state, walNextPayload).ok) return fail('recovery_required', 'Dealer Desk transaction journal links could not be validated before the write');
      try { writeRaw(WAL_KEY, safeJson(walIntent)); }
      catch (error) { return storageError(error); }
      try {
        writeRaw(INVENTORY_KEY, inventoryNextRaw);
        inventoryWritten = true;
        writeRaw(METADATA_KEY, metadataNextRaw);
        if (!updateDbArrays(workingInventory)) throw new Error('db_unavailable');
        if (!removeWal()) return fail('recovery_required', 'Dealer Desk committed the write but could not clear its transaction journal');
      } catch (error) {
        var inventoryRestored = casRestoreRaw(INVENTORY_KEY, inventoryBeforeRaw, inventoryNextRaw);
        var metadataRestored = casRestoreRaw(METADATA_KEY, metadataRawResult.raw, metadataNextRaw);
        var dbRestored = true;
        if (db) {
          var dbAtBaseline = dbMatchesSnapshot(dbBefore);
          var dbAtApplied = dbMatchesInventory(workingInventory);
          if (dbAtBaseline) dbRestored = true;
          else if (dbAtApplied) dbRestored = restoreDatabaseArrays(dbBefore);
          else return fail('rollback_failed', 'Dealer Desk found an in-memory inventory conflict and refused to overwrite it', { inventoryWritten: inventoryWritten });
        }
        if (!inventoryRestored || !metadataRestored || !dbRestored) return fail('rollback_failed', 'Dealer Desk could not confirm transaction rollback', { inventoryWritten: inventoryWritten });
        removeWal();
        return storageError(error);
      }
      return success(Object.assign({}, result, { state: workingMetadata, revision: workingMetadata.revision }));
    }, options.lockKeys);
  }

  function blockersForCandidate(candidate, requireApproved) {
    var blockers = [];
    if (!candidate) return ['candidate_missing'];
    if (requireApproved && ['Buy approved', 'Acquired'].indexOf(candidate.status) < 0) blockers.push('buy_approval_required');
    if (candidate.identity.name === 'Unknown' || candidate.identity.set === 'Unknown' || candidate.identity.language === 'Unknown' || candidate.identity.variant === 'Unknown') blockers.push('exact_identity_required');
    if (candidate.identity.number === 'Unknown') blockers.push('card_number_required');
    if (candidate.ownership !== 'Business') blockers.push('business_ownership_required');
    if (candidate.condition.certainty === 'Unknown' || candidate.condition.value === 'Unknown') blockers.push('condition_required');
    if (candidate.condition.certainty === 'Estimated' && !nonEmpty(candidate.condition.scenario)) blockers.push('condition_scenario_required');
    if (candidate.format === 'slab' && !nonEmpty(candidate.certificateNumber)) blockers.push('slab_certificate_required');
    if (!Array.isArray(candidate.evidenceRefs) || candidate.evidenceRefs.length === 0) blockers.push('evidence_required');
    (candidate.evidenceRefs || []).forEach(function (evidence) {
      if (!EVIDENCE_CLASSES.includes(evidence.class)) blockers.push('evidence_class_required');
      if (!validTimestamp(evidence.sourceDate)) blockers.push('evidence_date_required');
      if (!nonEmpty(evidence.match) || text(evidence.match).toLowerCase() === 'unknown') blockers.push('evidence_match_required');
      if (evidence.confidence === undefined || text(evidence.confidence).toLowerCase() === 'unknown') blockers.push('evidence_confidence_required');
      if (!nonEmpty(evidence.rationale)) blockers.push('evidence_rationale_required');
    });
    if (candidate.hold) blockers.push('hold_active');
    return blockers;
  }

  function planFor(state, candidateId, version) {
    var plans = state.plans.filter(function (plan) { return plan.candidateId === candidateId && (version === undefined || plan.version === version); });
    return plans.sort(function (a, b) { return b.version - a.version; })[0] || null;
  }

  function candidateRef(candidate) {
    return clone(candidate);
  }

  function sourceCost(row) {
    if (!row || row.costPrice === undefined || row.costPrice === null || text(row.costPrice) === '') return null;
    return moneyString(row.costPrice);
  }

  function reviewedCost(input, row) {
    var money = getMoney();
    if (!money || typeof money.parseMagnitude !== 'function' || typeof money.add !== 'function') return fail('money_module_required', 'A reviewed cost needs DealerMoney');
    if (!isObject(input) || input.confirmed !== true) return fail('cost_review_required', 'Copy linking needs an explicit reviewed canonical cost confirmation');
    var itemCost = moneyString(input.itemCost !== undefined ? input.itemCost : sourceCost(row));
    var nonItem = input.nonItemAcquisitionCosts === undefined ? null : moneyString(input.nonItemAcquisitionCosts);
    if (itemCost === null) return fail('cost_price_required', 'Reviewed cost needs the existing costPrice as an exact amount');
    if (nonItem === null) return fail('non_item_cost_required', 'Non-item acquisition costs need an explicit known amount, including zero');
    var currency = text(input.currency || 'SGD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return fail('cost_currency_invalid', 'Reviewed cost needs a three-letter currency');
    var nonItemCurrency = text(input.nonItemCurrency || currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(nonItemCurrency)) return fail('cost_currency_invalid', 'Non-item acquisition costs need a three-letter currency');
    if (nonItemCurrency !== currency) return fail('cost_currency_mismatch', 'Release 0 requires item and non-item acquisition costs to use the same currency');
    var rowCost = sourceCost(row);
    var settledAmount = null;
    var settledItemCost = null;
    var settledNonItem = null;
    var fx = null;
    if (rowCost !== null && currency === 'SGD' && itemCost !== rowCost) return fail('cost_price_mismatch', 'Reviewed item cost must match the existing costPrice exactly');
    if (currency !== 'SGD') {
      if (!isObject(input.fx) || !nonEmpty(input.settledAmount) || !nonEmpty(input.settledItemCost) || !nonEmpty(input.settledNonItemAcquisitionCosts) || text(input.settledCurrency || '').toUpperCase() !== 'SGD') return fail('foreign_cost_requires_settlement', 'Foreign acquisition cost needs FX metadata plus settled SGD item and non-item amounts');
      try {
        if (!money.validateFx) return fail('money_module_required', 'Foreign acquisition cost needs DealerMoney FX validation');
        fx = money.validateFx(input.fx);
        settledAmount = money.parseMagnitude(input.settledAmount);
        settledItemCost = money.parseMagnitude(input.settledItemCost);
        settledNonItem = money.parseMagnitude(input.settledNonItemAcquisitionCosts);
      } catch (error) { return fail('foreign_cost_invalid', error.message || 'Foreign acquisition cost settlement is invalid'); }
      if (rowCost !== null && settledItemCost !== rowCost) return fail('cost_price_mismatch', 'Settled item cost must match the existing costPrice exactly');
      var settledCheck;
      try { settledCheck = money.add(settledItemCost, settledNonItem); } catch (error) { return fail('foreign_cost_invalid', error.message || 'Settled acquisition cost is invalid'); }
      if (settledCheck !== settledAmount) return fail('foreign_cost_invalid', 'Settled item and non-item costs must add to the settled total');
    }
    var reviewedAt = text(input.reviewedAt || input.date || now());
    if (!validTimestamp(reviewedAt)) return fail('cost_review_date_required', 'Reviewed cost needs a valid date');
    var reason = text(input.reason);
    if (!reason) return fail('cost_review_reason_required', 'Reviewed cost needs a reason');
    var total;
    try { total = currency === 'SGD' ? money.add(itemCost, nonItem) : settledAmount; } catch (error) { return fail('cost_invalid', error.message || 'Reviewed cost is invalid'); }
    return { ok: true, cost: {
      id: validId(text(input.id)) ? text(input.id) : uuid('cost'),
      ownerId: ownerId(),
      currency: 'SGD',
      settledCurrency: 'SGD',
      originalCurrency: currency,
      itemCost: itemCost,
      nonItemAcquisitionCosts: nonItem,
      total: total,
      originalTotal: currency === 'SGD' ? total : money.add(itemCost, nonItem),
      settledAmount: currency === 'SGD' ? total : settledAmount,
      settledItemCost: currency === 'SGD' ? itemCost : settledItemCost,
      settledNonItemAcquisitionCosts: currency === 'SGD' ? nonItem : settledNonItem,
      fx: fx,
      reviewedAt: reviewedAt,
      reason: reason,
      confirmed: true,
      source: { table: row && row._dealerTable || '', id: row && row.id || '', field: 'costPrice' }
    } };
  }

  function candidateMatchesRow(candidate, row, table) {
    var fields = ['name', 'set', 'number', 'language', 'variant'];
    var identity = candidate.identity || {};
    for (var i = 0; i < fields.length; i += 1) {
      var field = fields[i];
      var expected = text(identity[field]);
      var actual = text(row && row[field]);
      if (expected && expected !== 'Unknown' && actual && expected !== actual) return false;
      if (expected && expected !== 'Unknown' && !actual) return false;
    }
    if (candidate.format === 'slab') {
      var cert = text(candidate.certificateNumber);
      if (!cert || text(row && (row.certNo || row.certificateNumber)) !== cert) return false;
      if (!text(row && row.grader) || !text(row && row.grade)) return false;
      if (!candidate.grader || !candidate.grade || text(row && row.grader) !== text(candidate.grader) || text(row && row.grade) !== text(candidate.grade)) return false;
    } else {
      var condition = text(candidate.condition && candidate.condition.value);
      if (condition && condition !== 'Unknown' && (!row || !text(row.condition) || text(row.condition) !== condition)) return false;
    }
    return true;
  }

  function rowOwnerMatches(row, input) {
    var explicit = text(input && (input.inventoryOwnerId || input.rowOwnerId));
    var rowOwner = text(row && (row.ownerId || row._dealerOwnerId || row.inventoryOwnerId));
    if (rowOwner && rowOwner !== ownerId()) return false;
    return rowOwner === ownerId() || explicit === ownerId();
  }

  function copyForCandidate(state, candidateId) {
    return state.copies.filter(function (copy) { return copy.candidateId === candidateId; })[0] || null;
  }

  function dateOnly(value) {
    if (!validTimestamp(value)) return text(value);
    return new Date(value).toISOString().slice(0, 10);
  }

  function daysBetween(acquired, sold) {
    if (!validTimestamp(acquired) || !validTimestamp(sold)) return '';
    var days = Math.floor((Date.parse(sold) - Date.parse(acquired)) / 86400000);
    return Number.isFinite(days) && days >= 0 ? days : '';
  }

  function buildSale(input, row, table, candidate, costComponent) {
    var money = getMoney();
    if (!money) return fail('money_module_required', 'Dealer Desk cannot record money without DealerMoney');
    var revenueExact = moneyString(input.totalCollected !== undefined ? input.totalCollected : input.proceeds);
    var revenue = revenueExact === null ? null : Number(revenueExact);
    if (revenue === null) return fail('sale_amount_required', 'Completed sale needs a known collected amount');
    var cost = costComponent && moneyString(costComponent.total);
    if (cost === null) return fail('cost_review_required', 'Completed sale needs the reviewed canonical cost component');
    if (input.shippingCost === undefined || input.shippingCost === null || text(input.shippingCost) === '' || input.fees === undefined || input.fees === null || text(input.fees) === '') return fail('sale_cost_unknown', 'Shipping and fees need explicit known amounts, including zero');
    var shippingExact = moneyString(input.shippingCost);
    var feesExact = moneyString(input.fees);
    var shipping = shippingExact === null ? null : Number(shippingExact);
    var fees = feesExact === null ? null : Number(feesExact);
    if (shipping === null || fees === null) return fail('sale_cost_invalid', 'Shipping and fees must be known money amounts');
    var postedRevenue;
    var postedShipping;
    var postedFees;
    try {
      postedRevenue = money.formatMoney(revenueExact);
      postedShipping = money.formatMoney(shippingExact);
      postedFees = money.formatMoney(feesExact);
    } catch (error) { return fail('sale_money_invalid', error.message || 'Sale money could not be posted'); }
    var profitString;
    try {
      profitString = money.subtract(postedRevenue, money.add(cost, money.add(postedShipping, postedFees)));
    } catch (error) { return fail('sale_money_invalid', error.message || 'Sale money is invalid'); }
    var totalString = postedRevenue;
    var margin = Number(totalString) > 0 ? Number(money.divide(profitString, totalString, 8)) * 100 : 0;
    var dateSold = text(input.dateSold || now());
    if (!validTimestamp(dateSold)) return fail('sale_date_required', 'Completed sale needs a valid sale date');
    var dateAcquired = text(row.dateAcquired || row.datePurchased || row.date || '');
    var sale = {
      id: text(input.saleId) || uuid('sale'),
      dateSold: dateOnly(dateSold),
      product: text(input.product || row.name || candidate.identity.name || 'Unknown'),
      buyer: text(input.buyer || ''),
      costPrice: Number(cost),
      totalCollected: Number(totalString),
      shippingCost: Number(postedShipping),
      fees: Number(postedFees),
      channel: text(input.channel || 'Manual'),
      dateAcquired: dateOnly(dateAcquired),
      daysHeld: daysBetween(dateAcquired, dateSold),
      profit: Number(profitString),
      margin: Number.isFinite(margin) ? margin : 0,
      inventoryId: row.id,
      inventoryTable: table,
      paymentStatus: 'Unknown',
      cashSettledAt: '',
      settlementEvidence: null,
      dealerRelease: VERSION,
      dealerCostBasis: clone(costComponent),
      dealerActual: {
        reportingCurrency: 'SGD',
        proceeds: postedRevenue,
        canonicalLandedCost: cost,
        sellingFee: postedFees,
        outboundShipping: postedShipping,
        paymentStatus: 'Unknown',
        lines: [
          { amount: postedRevenue, currency: 'SGD', status: 'Posted', effect: 'credit', type: 'proceeds' },
          { amount: cost, currency: 'SGD', status: 'Posted', effect: 'debit', type: 'landed_cost' },
          { amount: postedFees, currency: 'SGD', status: 'Posted', effect: 'debit', type: 'selling_fee' },
          { amount: postedShipping, currency: 'SGD', status: 'Posted', effect: 'debit', type: 'outbound_shipping' }
        ],
        provenance: {
          proceeds: { sourceAmount: revenueExact, sourceCurrency: 'SGD' },
          sellingFee: { sourceAmount: feesExact, sourceCurrency: 'SGD' },
          outboundShipping: { sourceAmount: shippingExact, sourceCurrency: 'SGD' }
        }
      }
    };
    return { ok: true, sale: sale, canonicalCost: cost };
  }

  function validateAsking(input) {
    if (!isObject(input)) return fail('asking_required', 'An asking approval object is required');
    var amount = moneyString(input.amount !== undefined ? input.amount : input.asking);
    if (amount === null) return fail('asking_amount_required', 'Approved asking needs a known money amount');
    var currency = text(input.currency || 'SGD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return fail('asking_currency_invalid', 'Approved asking needs a three-letter currency');
    var evidence = input.evidence ? normaliseEvidence(input.evidence) : null;
    if (evidence && !evidence.ok) return evidence;
    return { ok: true, asking: { amount: amount, currency: currency, approved: true, approvedAt: now(), evidence: evidence ? evidence.evidence : null } };
  }

  function getCandidateState(state, candidateId) {
    var candidate = findById(state.candidates, candidateId);
    if (!candidate) return fail('candidate_missing', 'Candidate was not found');
    return { ok: true, candidate: candidate };
  }

  function listingResult(state, candidateId) {
    var found = getCandidateState(state, candidateId);
    if (!found.ok) return found;
    var candidate = found.candidate;
    var copy = state.copies.filter(function (item) { return item.candidateId === candidateId; })[0] || null;
    var blockers = blockersForCandidate(candidate, true);
    if (!copy) blockers.push('inventory_copy_required');
    var inventory = copy ? readInventory() : null;
    var row = copy && inventory.ok ? rowFromPayload(inventory.payload, copy.itemRef.table, copy.itemRef.id) : null;
    if (copy && (!inventory || !inventory.ok || !row)) blockers.push('inventory_copy_missing');
    if (row && rowQuantity(row) !== 1) blockers.push('single_physical_copy_required');
    if (row && !availableStatus(row)) blockers.push('available_status_required');
    if (candidate.format === 'raw' && (!nonEmpty(candidate.frontRef) || !nonEmpty(candidate.backRef))) blockers.push('raw_front_back_refs_required');
    if (candidate.format === 'slab' && !nonEmpty(candidate.certificateNumber)) blockers.push('slab_certificate_required');
    if (candidate.format === 'slab' && !nonEmpty(candidate.grader)) blockers.push('slab_grader_required');
    if (candidate.format === 'slab' && !nonEmpty(candidate.grade)) blockers.push('slab_grade_required');
    if (!candidate.asking || candidate.asking.approved !== true) blockers.push('approved_asking_required');
    if (candidate.hold) blockers.push('hold_active');
    var listing = state.listings.filter(function (item) { return item.candidateId === candidateId; }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); })[0] || null;
    return { ok: true, ready: blockers.length === 0, blockers: blockers, candidate: candidate, copy: copy, row: row, listing: listing };
  }

  function createCandidate(input, options) {
    var normal = candidateInput(input || {});
    if (!normal.ok) return Promise.resolve(normal);
    var stamp = now();
    var candidate = Object.assign({
      id: validId(text(input && input.id)) ? text(input.id) : uuid('candidate'),
      ownerId: ownerId(),
      version: 1,
      status: 'Draft',
      createdAt: stamp,
      updatedAt: stamp,
      approvedAt: '',
      approvedPlanId: '',
      copyId: ''
    }, normal.value);
    var valid = validateCandidate(candidate);
    if (!valid.ok) return Promise.resolve(valid);
    options = mutationContext(options, { operation: 'createCandidate', input: input || {} });
    return commitMetadata(function (state) {
      if (findById(state.candidates, candidate.id)) return { ok: false, code: 'candidate_exists', message: 'Candidate id already exists' };
      state.candidates.push(candidate);
      return { ok: true, result: { candidate: candidate } };
    }, options);
  }

  function updateCandidate(candidateId, patch, options) {
    options = options || {};
    options = mutationContext(options, { operation: 'updateCandidate', candidateId: candidateId, patch: patch || {} });
    return commitMetadata(function (state) {
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var current = found.candidate;
      var expected = options.expectedVersion !== undefined ? options.expectedVersion : patch && patch.expectedVersion;
      if (!Number.isSafeInteger(expected)) return fail('candidate_version_required', 'Candidate edits require the current candidate version');
      if (expected !== current.version) return fail('candidate_version_conflict', 'Candidate changed before this edit', { current: current, pending: patch });
      var input = Object.assign({}, current, patch || {});
      delete input.id; delete input.ownerId; delete input.version; delete input.createdAt; delete input.updatedAt;
      var normal = candidateInput(input, current);
      if (!normal.ok) return normal;
      var next = Object.assign({}, current, normal.value, { version: current.version + 1, updatedAt: now() });
      var identityChanged = candidateIdentityChanged(current, next);
      if (current.status === 'Acquired' && identityChanged) return fail('identity_edit_after_acquisition', 'Identity and condition cannot be edited after acquisition');
      if (current.status === 'Buy approved') {
        next.status = 'Review';
        next.approvedAt = '';
        next.approvedPlanId = '';
        state.plans.filter(function (plan) { return plan.id === current.approvedPlanId; }).forEach(function (plan) { plan.status = 'Superseded'; });
      }
      var valid = validateCandidate(next);
      if (!valid.ok) return valid;
      state.candidates[state.candidates.indexOf(current)] = next;
      var linkedCopy = state.copies.filter(function (copy) { return copy.candidateId === candidateId; })[0];
      if (linkedCopy) linkedCopy.candidateVersion = next.version;
      return { ok: true, result: { candidate: next } };
    }, options);
  }

  function addEvidence(candidateId, evidenceInput, options) {
    var evidence = normaliseEvidence(evidenceInput);
    if (!evidence.ok) return Promise.resolve(evidence);
    options = options || {};
    options = mutationContext(options, { operation: 'addEvidence', candidateId: candidateId, evidence: evidenceInput });
    return commitMetadata(function (state) {
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var candidate = found.candidate;
      if (!Number.isSafeInteger(options.expectedVersion)) return fail('candidate_version_required', 'Evidence changes require the current candidate version');
      if (options.expectedVersion !== candidate.version) return fail('candidate_version_conflict', 'Candidate changed before evidence was added');
      var next = Object.assign({}, candidate, { version: candidate.version + 1, updatedAt: now(), evidenceRefs: candidate.evidenceRefs.concat([evidence.evidence]) });
      if (candidate.status === 'Buy approved') {
        next.status = 'Review';
        next.approvedAt = '';
        next.approvedPlanId = '';
        state.plans.filter(function (plan) { return plan.id === candidate.approvedPlanId; }).forEach(function (plan) { plan.status = 'Superseded'; });
      }
      state.candidates[state.candidates.indexOf(candidate)] = next;
      var linkedCopy = state.copies.filter(function (copy) { return copy.candidateId === candidateId; })[0];
      if (linkedCopy) linkedCopy.candidateVersion = next.version;
      state.evidence.push(Object.assign({}, evidence.evidence, { ownerId: ownerId(), candidateId: candidateId }));
      return { ok: true, result: { candidate: next, evidence: evidence.evidence } };
    }, options);
  }

  function createPlan(candidateId, input, options) {
    options = options || {};
    options = mutationContext(options, { operation: 'createPlan', candidateId: candidateId, input: input || {} });
    return commitMetadata(function (state) {
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var candidate = found.candidate;
      var expectedPlanCandidateVersion = options.expectedVersion !== undefined ? options.expectedVersion : input && input.expectedVersion;
      if (!Number.isSafeInteger(expectedPlanCandidateVersion)) return fail('candidate_version_required', 'Buy plans require the current candidate version');
      if (expectedPlanCandidateVersion !== candidate.version) return fail('candidate_version_conflict', 'Candidate changed before the buy plan was frozen');
      var money = getMoney();
      if (!money || typeof money.planEconomics !== 'function') return fail('money_module_required', 'Dealer Desk cannot create a plan without DealerMoney');
      var snapshotReason = text(options.reason || (input && (input.snapshotReason || input.reason)) || '');
      if (!snapshotReason) return fail('snapshot_reason_required', 'Buy planning needs a reason for the frozen expected snapshot');
      var expected;
      try { expected = money.planEconomics(input || {}); } catch (error) { return fail('plan_invalid', error.message || 'Plan economics are invalid'); }
      var plannedItemCost = input && input.plannedItemCost !== undefined ? moneyString(input.plannedItemCost) : null;
      var plannedItemCostStatus = plannedItemCost === null ? 'Unknown' : 'Known';
      var plannedLandedCost = plannedItemCost !== null && expected.knownNonItemAcquisitionCosts !== null ? money.add(plannedItemCost, expected.knownNonItemAcquisitionCosts) : null;
      var planningCandidate = candidate;
      if (candidate.status === 'Draft') {
        planningCandidate = Object.assign({}, candidate, { status: 'Review', version: candidate.version + 1, updatedAt: now() });
        state.candidates[state.candidates.indexOf(candidate)] = planningCandidate;
      }
      var priorPlans = state.plans.filter(function (item) { return item.candidateId === candidateId; });
      var plan = {
        id: uuid('plan'),
        ownerId: ownerId(),
        candidateId: candidateId,
        lineageId: priorPlans.length ? (priorPlans[0].lineageId || priorPlans[0].id) : uuid('lineage'),
        version: priorPlans.reduce(function (max, item) { return Math.max(max, item.version || 0); }, 0) + 1,
        status: 'Draft',
        createdAt: now(),
        snapshotAt: now(),
        reason: snapshotReason,
        candidateVersion: planningCandidate.version,
        input: clone(input || {}),
        expected: expected,
        plannedItemCost: { amount: plannedItemCost, currency: 'SGD', status: plannedItemCostStatus },
        plannedLandedCost: { amount: plannedLandedCost, currency: 'SGD', status: plannedLandedCost === null ? 'Unknown' : 'Known' },
        candidateSnapshot: candidateRef(planningCandidate)
      };
      state.plans.push(plan);
      return { ok: true, result: { plan: plan } };
    }, options);
  }

  function revisePlan(planId, input, options) {
    options = options || {};
    options = mutationContext(options, { operation: 'revisePlan', planId: planId, input: input || {} });
    return commitMetadata(function (state) {
      var current = findById(state.plans, planId);
      if (!current) return fail('plan_missing', 'Plan was not found');
      if (options.expectedVersion !== undefined && options.expectedVersion !== current.version) return fail('plan_version_conflict', 'Plan changed before this revision');
      var candidate = findById(state.candidates, current.candidateId);
      if (!candidate) return fail('candidate_missing', 'Plan candidate was not found');
      if (current.status === 'Approved') current.status = 'Superseded';
      if (candidate.status === 'Buy approved') {
        var candidateIndex = state.candidates.indexOf(candidate);
        candidate = Object.assign({}, candidate, { status: 'Review', version: candidate.version + 1, approvedAt: '', approvedPlanId: '', updatedAt: now() });
        state.candidates[candidateIndex] = candidate;
      }
      var money = getMoney();
      if (!money || typeof money.planEconomics !== 'function') return fail('money_module_required', 'Dealer Desk cannot revise a plan without DealerMoney');
      var snapshotReason = text(options.reason || (input && (input.snapshotReason || input.reason)) || current.reason || '');
      if (!snapshotReason) return fail('snapshot_reason_required', 'Plan revision needs a reason for the frozen expected snapshot');
      var expected;
      try { expected = money.planEconomics(input || {}); } catch (error) { return fail('plan_invalid', error.message || 'Plan economics are invalid'); }
      var plannedItemCost = input && input.plannedItemCost !== undefined ? moneyString(input.plannedItemCost) : null;
      var plannedLandedCost = plannedItemCost !== null && expected.knownNonItemAcquisitionCosts !== null ? money.add(plannedItemCost, expected.knownNonItemAcquisitionCosts) : null;
      var next = Object.assign({}, current, { id: uuid('plan'), lineageId: current.lineageId || current.id, version: current.version + 1, status: 'Draft', createdAt: now(), snapshotAt: now(), reason: snapshotReason, candidateVersion: candidate.version, input: clone(input || {}), expected: expected, plannedItemCost: { amount: plannedItemCost, currency: 'SGD', status: plannedItemCost === null ? 'Unknown' : 'Known' }, plannedLandedCost: { amount: plannedLandedCost, currency: 'SGD', status: plannedLandedCost === null ? 'Unknown' : 'Known' }, candidateSnapshot: candidateRef(candidate) });
      state.plans.push(next);
      return { ok: true, result: { plan: next, previousPlanId: current.id } };
    }, options);
  }

  function approveBuy(candidateId, options) {
    options = options || {};
    options = mutationContext(options, { operation: 'approveBuy', candidateId: candidateId, planId: options.planId || '', reason: options.reason || '' });
    return commitMetadata(function (state) {
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var candidate = found.candidate;
      var expectedBuyVersion = options.expectedVersion !== undefined ? options.expectedVersion : options.expectedCandidateVersion;
      if (!Number.isSafeInteger(expectedBuyVersion)) return fail('candidate_version_required', 'Buy approval requires the current candidate version');
      if (expectedBuyVersion !== candidate.version) return fail('candidate_version_conflict', 'Candidate changed before buy approval');
      if (!nonEmpty(options.reason)) return fail('approval_reason_required', 'Buy approval needs an explicit reason');
      var blockers = blockersForCandidate(candidate, false);
      var plan = options.planId ? findById(state.plans, options.planId) : planFor(state, candidateId);
      if (!plan) blockers.push('buy_plan_required');
      else {
        if (plan.status === 'Approved') return success({ candidate: candidate, plan: plan, idempotent: true });
        if (!plan.expected || plan.expected.status !== 'Known' || plan.expected.itemPriceCeiling === null) blockers.push('known_money_required');
        if (!plan.plannedItemCost || plan.plannedItemCost.status !== 'Known') blockers.push('planned_item_cost_unknown');
        if (plan.candidateId !== candidateId) blockers.push('plan_candidate_mismatch');
        if (plan.candidateVersion !== candidate.version) blockers.push('plan_candidate_version_stale');
        if (!nonEmpty(plan.reason) || !validTimestamp(plan.snapshotAt || plan.createdAt)) blockers.push('snapshot_reason_required');
      }
      if (blockers.length) return fail('buy_blocked', 'Buy approval is blocked by unresolved requirements', { blockers: blockers });
      if (candidate.status === 'Buy approved' && plan.status === 'Approved') return success({ candidate: candidate, plan: plan, idempotent: true });
      if (['Draft', 'Review'].indexOf(candidate.status) < 0) return fail('invalid_transition', 'Buy approval is only allowed from Draft or Review');
      var approved = Object.assign({}, candidate, { status: 'Buy approved', version: candidate.version + 1, updatedAt: now(), approvedAt: now(), approvedPlanId: plan.id });
      var approvedPlan = Object.assign({}, plan, { status: 'Approved', approvedAt: now(), approvalReason: text(options.reason || plan.reason || '') });
      state.candidates[state.candidates.indexOf(candidate)] = approved;
      var linkedCopy = state.copies.filter(function (copy) { return copy.candidateId === candidateId; })[0];
      if (linkedCopy) linkedCopy.candidateVersion = approved.version;
      state.plans[state.plans.indexOf(plan)] = approvedPlan;
      return { ok: true, result: { candidate: approved, plan: approvedPlan } };
    }, options);
  }

  function approveAsk(candidateId, input, options) {
    var asking = validateAsking(input);
    if (!asking.ok) return Promise.resolve(asking);
    options = options || {};
    options = mutationContext(options, { operation: 'approveAsk', candidateId: candidateId, input: input || {} });
    return commitMetadata(function (state) {
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var candidate = found.candidate;
      if (candidate.status !== 'Acquired') return fail('acquired_copy_required', 'Asking approval needs an acquired exact copy');
      if (!Number.isSafeInteger(options.expectedVersion)) return fail('candidate_version_required', 'Asking approval requires the current candidate version');
      if (options.expectedVersion !== candidate.version) return fail('candidate_version_conflict', 'Candidate changed before asking approval');
      var next = Object.assign({}, candidate, { asking: asking.asking, version: candidate.version + 1, updatedAt: now() });
      state.candidates[state.candidates.indexOf(candidate)] = next;
      var linkedCopy = state.copies.filter(function (copy) { return copy.candidateId === candidateId; })[0];
      if (linkedCopy) linkedCopy.candidateVersion = next.version;
      return { ok: true, result: { candidate: next } };
    }, options);
  }

  function acquireCopy(candidateId, input, options) {
    input = input || {};
    options = options || {};
    var table = text(input.inventoryTable || input.table);
    if (ITEM_TABLES.indexOf(table) < 0) return Promise.resolve(fail('inventory_reference_required', 'Synthetic acquisition needs singles or slabs'));
    var id = text(input.inventoryId || input.id) || uuid('inventory');
    if (!validId(id)) return Promise.resolve(fail('inventory_reference_required', 'Synthetic acquisition needs a valid stable id'));
    options = mutationContext(Object.assign({}, options, { lockKeys: (options.lockKeys || []).concat(['dealer-row:' + table + ':' + id]) }), { operation: 'acquireCopy', candidateId: candidateId, input: input });
    return commitInventoryAndMetadata(function (state, payload) {
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var candidate = found.candidate;
      var expectedAcquireVersion = input.expectedCandidateVersion !== undefined ? input.expectedCandidateVersion : (options.expectedCandidateVersion !== undefined ? options.expectedCandidateVersion : options.expectedVersion);
      if (!Number.isSafeInteger(expectedAcquireVersion)) return fail('candidate_version_required', 'Physical copy acquisition requires the current candidate version');
      if (expectedAcquireVersion !== candidate.version) return fail('candidate_version_conflict', 'Candidate changed before physical copy acquisition');
      if (copyForCandidate(state, candidateId)) return fail('acquired_copy_required', 'This candidate already has an acquired physical copy');
      if (candidate.status !== 'Buy approved') return fail('buy_approval_required', 'Synthetic acquisition needs a Buy approved candidate');
      if (candidate.ownership !== 'Business') return fail('business_ownership_required', 'Only Business owned copies can enter the Dealer Desk flow');
      if (rowFromPayload(payload, table, id)) return fail('inventory_reference_exists', 'That stable inventory id already exists');
      var reviewedInput = input.reviewedCost;
      if (!isObject(reviewedInput) || reviewedInput.confirmed !== true) return fail('cost_review_required', 'Synthetic acquisition needs an explicit reviewed canonical cost confirmation');
      if (input.row && text(input.row.ownerId || input.row._dealerOwnerId || input.row.inventoryOwnerId) && text(input.row.ownerId || input.row._dealerOwnerId || input.row.inventoryOwnerId) !== ownerId()) return fail('inventory_owner_required', 'Synthetic acquisition row owner conflicts with the local owner scope');
      var row = Object.assign({
        id: id,
        name: candidate.identity.name,
        set: candidate.identity.set,
        number: candidate.identity.number,
        language: candidate.identity.language,
        variant: candidate.identity.variant,
        status: 'Available',
        qty: 1,
        _dealerOwnerId: ownerId()
      }, clone(input.row || {}));
      row.id = id;
      row.qty = 1;
      row.status = 'Available';
      row.name = candidate.identity.name;
      row.set = candidate.identity.set;
      row.number = candidate.identity.number;
      row.language = candidate.identity.language;
      row.variant = candidate.identity.variant;
      row.condition = candidate.condition.value;
      row.type = candidate.format === 'slab' ? 'slab' : 'raw';
      row.dateAcquired = text(input.dateAcquired || now());
      row._dealerOwnerId = ownerId();
      if (candidate.format === 'slab') {
        row.certNo = candidate.certificateNumber;
        row.grader = candidate.grader;
        row.grade = candidate.grade;
      }
      var costAmount = text(reviewedInput.currency || 'SGD').toUpperCase() === 'SGD' ? moneyString(reviewedInput.itemCost) : moneyString(reviewedInput.settledItemCost);
      if (costAmount === null) return fail('cost_price_required', 'Synthetic acquisition needs an exact item cost');
      row.costPrice = Number(costAmount);
      var cost = reviewedCost(reviewedInput, row);
      if (!cost.ok) return cost;
      row.dealerCostBasis = clone(cost.cost);
      var existingClaim = state.copies.filter(function (copy) { return copy.itemRef && copy.itemRef.table === table && copy.itemRef.id === id; })[0];
      if (existingClaim) return fail('copy_already_linked', 'This physical copy is already linked');
      payload[table] = Array.isArray(payload[table]) ? payload[table] : [];
      payload[table].push(row);
      var nextCandidate = Object.assign({}, candidate, { copyId: uuid('copy'), status: 'Acquired', version: candidate.version + 1, updatedAt: now(), acquiredAt: now() });
      var copy = {
        id: nextCandidate.copyId,
        ownerId: ownerId(),
        candidateId: candidateId,
        createdAt: now(),
        itemRef: { table: table, id: id, version: rowVersion(row), bytes: rowBytes(row), ownerId: ownerId() },
        inventoryOwnerId: ownerId(),
        candidateVersion: nextCandidate.version,
        costRef: { table: table, id: id, field: 'costPrice' },
        costComponent: cost.cost,
        frontRef: text(input.frontRef || candidate.frontRef),
        backRef: text(input.backRef || candidate.backRef),
        copyTag: text(input.copyTag || ''),
        updatedAt: now()
      };
      state.candidates[state.candidates.indexOf(candidate)] = nextCandidate;
      state.copies.push(copy);
      return { ok: true, result: { candidate: nextCandidate, copy: copy, inventoryRow: row } };
    }, options);
  }

  var createCopy = acquireCopy;

  function linkCopy(candidateId, input, options) {
    options = options || {};
    input = input || {};
    options = mutationContext(Object.assign({}, options, { lockKeys: (options.lockKeys || []).concat(['dealer-row:' + text(input.inventoryTable || input.table) + ':' + text(input.inventoryId || input.id)]) }), { operation: 'linkCopy', candidateId: candidateId, input: input });
    return commitInventoryAndMetadata(function (state, payload) {
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var candidate = found.candidate;
      var expectedLinkVersion = input.expectedCandidateVersion !== undefined ? input.expectedCandidateVersion : (options.expectedCandidateVersion !== undefined ? options.expectedCandidateVersion : options.expectedVersion);
      if (!Number.isSafeInteger(expectedLinkVersion)) return fail('candidate_version_required', 'Physical copy linking requires the current candidate version');
      if (expectedLinkVersion !== candidate.version) return fail('candidate_version_conflict', 'Candidate changed before physical copy linking');
      if (candidate.status !== 'Buy approved') return fail('buy_approval_required', 'Copy linking needs a Buy approved candidate');
      if (candidate.ownership !== 'Business') return fail('business_ownership_required', 'Only Business owned copies can enter the Dealer Desk flow');
      var table = text(input.inventoryTable || input.table);
      var id = text(input.inventoryId || input.id);
      if (ITEM_TABLES.indexOf(table) < 0 || !validId(id)) return fail('inventory_reference_required', 'Copy needs an exact singles or slabs id');
      var row = rowFromPayload(payload, table, id);
      if (!row || !dbRow(payload, table, id)) return fail('inventory_reference_missing', 'Exact inventory row was not found');
      if (rowQuantity(row) !== 1) return fail('single_physical_copy_required', 'Dealer Desk Release 0 requires one physical copy per row');
      if (!rowOwnerMatches(row, input)) return fail('inventory_owner_required', 'Copy linking needs explicit Business inventory owner confirmation');
      if (!candidateMatchesRow(candidate, row, table)) return fail('identity_mismatch', 'Candidate identity does not match the exact inventory row');
      if (!availableStatus(row)) return fail('available_status_required', 'Only an available inventory row can be linked');
      var cost = reviewedCost(input.reviewedCost, row);
      if (!cost.ok) return cost;
      cost.cost.source.table = table;
      if (row.dealerCostBasis && safeJson(row.dealerCostBasis) !== safeJson(cost.cost)) return fail('cost_basis_conflict', 'Existing canonical cost basis differs from the reviewed component');
      var existing = state.copies.filter(function (copy) { return copy.candidateId === candidateId; })[0];
      if (existing && (existing.itemRef.table !== table || existing.itemRef.id !== id)) return fail('copy_already_linked', 'Candidate already has a different physical copy');
      var claimed = state.copies.filter(function (copy) { return copy.itemRef && copy.itemRef.table === table && copy.itemRef.id === id && copy.candidateId !== candidateId; })[0];
      if (claimed) return fail('copy_already_linked', 'This physical copy is already linked to another candidate');
      var itemVersion = rowVersion(row);
      var itemBytes = rowBytes(row);
      if (input.expectedItemVersion !== undefined && input.expectedItemVersion !== itemVersion) return fail('inventory_version_conflict', 'Inventory row version is stale');
      if (input.expectedItemBytes !== undefined && input.expectedItemBytes !== itemBytes) return fail('inventory_version_conflict', 'Inventory row bytes are stale');
      var nextRow = clone(row);
      nextRow._dealerOwnerId = ownerId();
      nextRow.dealerCostBasis = clone(cost.cost);
      if (!updatePayloadRow(payload, table, id, nextRow)) return fail('inventory_reference_missing', 'Inventory row disappeared before linking');
      var nextCandidate = Object.assign({}, candidate, { copyId: existing ? existing.id : uuid('copy'), status: 'Acquired', version: candidate.version + 1, updatedAt: now(), acquiredAt: now() });
      var copy = existing || {
        id: nextCandidate.copyId,
        ownerId: ownerId(),
        candidateId: candidateId,
        createdAt: now()
      };
      copy = Object.assign({}, copy, {
        itemRef: { table: table, id: id, version: itemVersion, bytes: rowBytes(nextRow), ownerId: ownerId() },
        inventoryOwnerId: ownerId(),
        candidateVersion: nextCandidate.version,
        costRef: { table: table, id: id, field: 'costPrice' },
        costComponent: cost.cost,
        frontRef: text(input.frontRef || candidate.frontRef),
        backRef: text(input.backRef || candidate.backRef),
        copyTag: text(input.copyTag || row.copyTag || ''),
        updatedAt: now()
      });
      if (existing) state.copies[state.copies.indexOf(existing)] = copy;
      else state.copies.push(copy);
      state.candidates[state.candidates.indexOf(candidate)] = nextCandidate;
      return { ok: true, result: { candidate: nextCandidate, copy: copy } };
    }, options);
  }

  function prepareListing(candidateId, options) {
    options = options || {};
    options = mutationContext(options, { operation: 'prepareListing', candidateId: candidateId });
    var guard = guardPreview();
    if (guard) return Promise.resolve(guard);
    var stateResult = readState();
    if (!stateResult.ok) return Promise.resolve(stateResult);
    var readiness = listingResult(stateResult.state, candidateId);
    if (!readiness.ok) return Promise.resolve(readiness);
    if (!readiness.ready) return Promise.resolve(fail('listing_blocked', 'Manual listing handoff is blocked', { blockers: readiness.blockers, readiness: readiness }));
    var expectedListingVersion = options.expectedVersion !== undefined ? options.expectedVersion : options.expectedCandidateVersion;
    if (!Number.isSafeInteger(expectedListingVersion)) return Promise.resolve(fail('candidate_version_required', 'Listing preparation requires the current candidate version'));
    if (expectedListingVersion !== readiness.candidate.version) return Promise.resolve(fail('candidate_version_conflict', 'Candidate changed before listing preparation'));
    if (readiness.copy && readiness.copy.itemRef) options.lockKeys = (options.lockKeys || []).concat(['dealer-row:' + readiness.copy.itemRef.table + ':' + readiness.copy.itemRef.id]);
    return commitMetadata(function (state) {
      var latest = listingResult(state, candidateId);
      if (!latest.ok) return latest;
      if (!latest.ready) return fail('listing_blocked', 'Manual listing handoff is blocked', { blockers: latest.blockers, readiness: latest });
      var existing = state.listings.filter(function (listing) { return listing.candidateId === candidateId && listing.status === 'manual-handoff'; })[0];
      if (existing) return { ok: true, result: { listing: existing, readiness: latest, idempotent: true } };
      var listing = { id: uuid('listing'), ownerId: ownerId(), candidateId: candidateId, copyId: latest.copy.id, status: 'manual-handoff', createdAt: now(), localOnly: true, published: false, candidateVersion: latest.candidate.version };
      state.listings.push(listing);
      return { ok: true, result: { listing: listing, readiness: latest } };
    }, options);
  }

  function recordSale(input, options) {
    input = input || {};
    options = options || {};
    var candidateId = text(input.candidateId);
    var copyId = text(input.copyId);
    var before = readState();
    if (!before.ok) return Promise.resolve(before);
    var beforeCopy = findById(before.state.copies, copyId) || before.state.copies.filter(function (item) { return item.candidateId === candidateId; })[0];
    var saleLock = beforeCopy && beforeCopy.itemRef ? ['dealer-row:' + beforeCopy.itemRef.table + ':' + beforeCopy.itemRef.id] : [];
    options = mutationContext(Object.assign({}, options, { lockKeys: (options.lockKeys || []).concat(saleLock) }), { operation: 'recordSale', input: input });
    return commitInventoryAndMetadata(function (state, payload) {
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var candidate = found.candidate;
      if (candidate.status !== 'Acquired') return fail('acquired_copy_required', 'Completed sale needs an acquired exact copy');
      if (candidate.ownership !== 'Business' || candidate.hold) return fail('business_ownership_required', 'Completed sale needs an available Business owned copy');
      var copy = findById(state.copies, copyId) || state.copies.filter(function (item) { return item.candidateId === candidateId; })[0];
      if (!copy || copy.candidateId !== candidateId) return fail('copy_missing', 'Completed sale needs an exact linked physical copy');
      if (copy.inventoryOwnerId !== ownerId()) return fail('inventory_owner_required', 'Linked inventory owner does not match the local pilot owner');
      var listing = state.listings.filter(function (item) { return item.candidateId === candidateId && item.copyId === copy.id && item.status === 'manual-handoff' && item.published !== true; })[0];
      if (!listing || (input.listingId && input.listingId !== listing.id)) return fail('listing_required', 'Completed sale needs the prepared manual listing handoff');
      var expectedCandidateVersion = input.expectedCandidateVersion !== undefined ? input.expectedCandidateVersion : options.expectedCandidateVersion;
      if (!Number.isSafeInteger(expectedCandidateVersion)) return fail('candidate_version_required', 'Completed sale requires the current candidate version');
      if (expectedCandidateVersion !== candidate.version) return fail('candidate_version_conflict', 'Candidate changed before the sale was recorded', { expectedVersion: expectedCandidateVersion, currentVersion: candidate.version });
      if (candidate.version !== copy.candidateVersion) return fail('candidate_version_conflict', 'Candidate changed after the physical copy was linked');
      var rowCheck = assertExpectedRow(copy.itemRef, payload, copy.itemRef.table, copy.itemRef.id, options.expectedItemVersion, options.expectedItemBytes);
      if (!rowCheck.ok) return rowCheck;
      if (rowQuantity(rowCheck.row) !== 1) return fail('single_physical_copy_required', 'Completed sale requires one physical copy');
      if (text(rowCheck.row.status).toLowerCase() === 'sold') return fail('already_sold', 'This physical copy already has a completed sale');
      if (!availableStatus(rowCheck.row)) return fail('available_status_required', 'Completed sale needs an available copy');
      if (!candidateMatchesRow(candidate, rowCheck.row, copy.itemRef.table)) return fail('identity_mismatch', 'Candidate identity no longer matches the physical copy');
      if (!copy.costComponent || copy.costComponent.confirmed !== true) return fail('cost_review_required', 'Completed sale needs the reviewed canonical cost component');
      var saleBuild = buildSale(input, rowCheck.row, copy.itemRef.table, candidate, copy.costComponent);
      if (!saleBuild.ok) return saleBuild;
      var sales = Array.isArray(payload.sales) ? payload.sales : [];
      if (sales.some(function (sale) { return sale && sale.inventoryId === rowCheck.row.id && sale.inventoryTable === copy.itemRef.table; })) return fail('sale_already_recorded', 'A sale already references this physical copy');
      var nextRow = clone(rowCheck.row);
      nextRow.status = 'Sold';
      nextRow.qty = 1;
      if (!updatePayloadRow(payload, copy.itemRef.table, copy.itemRef.id, nextRow)) return fail('inventory_reference_missing', 'Inventory row disappeared before sale');
      var sale = saleBuild.sale;
      sales.push(sale);
      payload.sales = sales;
      copy.itemRef.bytes = rowBytes(nextRow);
      copy.itemRef.version = rowVersion(nextRow);
      var saleRef = { table: 'sales', id: sale.id, version: rowVersion(sale), bytes: rowBytes(sale), ownerId: ownerId() };
      var outcome = { id: uuid('outcome'), ownerId: ownerId(), candidateId: candidateId, copyId: copy.id, kind: 'sale', status: 'Completed', createdAt: now(), saleRef: saleRef, planId: candidate.approvedPlanId || '', paymentStatus: 'Unknown' };
      state.outcomes.push(outcome);
      var nextCandidate = Object.assign({}, candidate, { status: 'Acquired', version: candidate.version + 1, updatedAt: now() });
      state.candidates[state.candidates.indexOf(candidate)] = nextCandidate;
      copy.candidateVersion = nextCandidate.version;
      return { ok: true, result: { sale: sale, outcome: outcome, candidate: nextCandidate, inventoryRef: { table: copy.itemRef.table, id: copy.itemRef.id, bytes: rowBytes(nextRow), version: rowVersion(nextRow) } } };
    }, Object.assign({}, options, { pending: { candidateId: candidateId, copyId: copyId } }));
  }

  function settleSale(input, options) {
    input = input || {};
    options = options || {};
    var outcomeId = text(input.outcomeId || input.id);
    var before = readState();
    if (!before.ok) return Promise.resolve(before);
    var beforeOutcome = findById(before.state.outcomes, outcomeId);
    var settlementLock = beforeOutcome && beforeOutcome.saleRef ? ['dealer-row:sales:' + beforeOutcome.saleRef.id] : [];
    options = mutationContext(Object.assign({}, options, { lockKeys: (options.lockKeys || []).concat(settlementLock) }), { operation: 'settleSale', input: input });
    return commitInventoryAndMetadata(function (state, payload) {
      var outcome = findById(state.outcomes, outcomeId);
      if (!outcome || outcome.kind !== 'sale' || !outcome.saleRef) return fail('sale_outcome_missing', 'Completed sale was not found');
      var saleRef = outcome.saleRef;
      var check = assertExpectedRow(saleRef, payload, 'sales', saleRef.id, options.expectedSaleVersion, options.expectedSaleBytes);
      if (!check.ok) return check;
      var sale = check.row;
      if (sale.paymentStatus === 'Settled') return success({ sale: sale, outcome: outcome, idempotent: true });
      if (!Number.isSafeInteger(options.expectedSaleVersion) || typeof options.expectedSaleBytes !== 'string') return fail('inventory_version_required', 'Settlement requires the current canonical sale version and bytes');
      var settledAt = text(input.cashSettledAt || input.settledAt);
      if (!validTimestamp(settledAt)) return fail('settlement_date_required', 'Settlement needs a valid dated confirmation');
      var evidence = normaliseEvidence(input.settlementEvidence || input.evidence || {});
      if (!evidence.ok) return evidence;
      if (['transaction', 'manual'].indexOf(evidence.evidence.class) < 0) return fail('settlement_evidence_required', 'Settlement evidence must be transaction or manual evidence');
      var nextActual = Object.assign({}, sale.dealerActual || {}, { paymentStatus: 'Settled', cashSettledAt: settledAt, settlementEvidence: evidence.evidence });
      var nextSale = Object.assign({}, sale, { paymentStatus: 'Settled', cashSettledAt: settledAt, settlementEvidence: evidence.evidence, dealerActual: nextActual });
      if (!updatePayloadRow(payload, 'sales', sale.id, nextSale)) return fail('sale_outcome_missing', 'Sale row disappeared before settlement');
      var nextOutcome = Object.assign({}, outcome, { status: 'Settled', paymentStatus: 'Settled', settledAt: settledAt, saleRef: Object.assign({}, saleRef, { bytes: rowBytes(nextSale), version: rowVersion(nextSale) }) });
      state.outcomes[state.outcomes.indexOf(outcome)] = nextOutcome;
      return { ok: true, result: { sale: nextSale, outcome: nextOutcome } };
    }, Object.assign({}, options, { pending: { outcomeId: outcomeId } }));
  }

  function recordNoSale(input, options) {
    input = input || {};
    options = options || {};
    var candidateId = text(input.candidateId);
    var before = readState();
    if (!before.ok) return Promise.resolve(before);
    var beforeCopy = text(input.copyId) ? findById(before.state.copies, text(input.copyId)) : before.state.copies.filter(function (copy) { return copy.candidateId === candidateId; })[0];
    var noSaleLock = beforeCopy && beforeCopy.itemRef ? ['dealer-row:' + beforeCopy.itemRef.table + ':' + beforeCopy.itemRef.id] : [];
    options = mutationContext(Object.assign({}, options, { lockKeys: (options.lockKeys || []).concat(noSaleLock) }), { operation: 'recordNoSale', input: input });
    return commitMetadata(function (state) {
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var candidate = found.candidate;
      if (candidate.status !== 'Acquired') return fail('acquired_copy_required', 'A non-sale outcome needs an acquired exact copy');
      if (candidate.ownership !== 'Business' || candidate.hold) return fail('business_ownership_required', 'A non-sale outcome needs an available Business owned copy');
      var copy = input.copyId ? findById(state.copies, text(input.copyId)) : copyForCandidate(state, candidateId);
      if (!copy || copy.candidateId !== candidateId || copy.inventoryOwnerId !== ownerId()) return fail('copy_missing', 'A non-sale outcome needs an exact linked physical copy');
      var expectedNoSaleVersion = input.expectedCandidateVersion !== undefined ? input.expectedCandidateVersion : (options.expectedCandidateVersion !== undefined ? options.expectedCandidateVersion : options.expectedVersion);
      if (!Number.isSafeInteger(expectedNoSaleVersion)) return fail('candidate_version_required', 'Non-sale outcomes require the current candidate version');
      if (expectedNoSaleVersion !== candidate.version) return fail('candidate_version_conflict', 'Candidate changed before the non-sale outcome was recorded');
      var inventory = readInventory();
      if (!inventory.ok) return inventory;
      var row = rowFromPayload(inventory.payload, copy.itemRef.table, copy.itemRef.id);
      if (!row || rowQuantity(row) !== 1 || !availableStatus(row) || !candidateMatchesRow(candidate, row, copy.itemRef.table)) return fail('available_status_required', 'A non-sale outcome needs the available exact Business copy');
      var reason = text(input.reason || input.cause);
      if (!reason) return fail('no_sale_reason_required', 'A non-sale outcome needs a reason');
      var outcome = { id: uuid('outcome'), ownerId: ownerId(), candidateId: candidateId, copyId: copy.id, kind: 'non_sale', status: 'Recorded', createdAt: text(input.date || now()), reason: reason, listingId: text(input.listingId || ''), localOnly: true };
      if (!validTimestamp(outcome.createdAt)) return fail('no_sale_date_required', 'A non-sale outcome needs a valid date');
      state.outcomes.push(outcome);
      return { ok: true, result: { outcome: outcome } };
    }, options);
  }

  function reviewOutcome(input, options) {
    input = input || {};
    options = options || {};
    var reviewBefore = readState();
    if (!reviewBefore.ok) return Promise.resolve(reviewBefore);
    var reviewCandidateId = text(input.candidateId);
    var reviewOutcomeRef = input.outcomeId ? findById(reviewBefore.state.outcomes, text(input.outcomeId)) : reviewBefore.state.outcomes.filter(function (item) { return item.candidateId === reviewCandidateId; }).slice(-1)[0];
    var reviewLock = reviewOutcomeRef && reviewOutcomeRef.saleRef ? ['dealer-row:sales:' + reviewOutcomeRef.saleRef.id] : [];
    options = mutationContext(Object.assign({}, options, { lockKeys: (options.lockKeys || []).concat(reviewLock) }), { operation: 'reviewOutcome', input: input });
    return commitMetadata(function (state) {
      var candidateId = text(input.candidateId);
      var found = getCandidateState(state, candidateId);
      if (!found.ok) return found;
      var outcome = input.outcomeId ? findById(state.outcomes, text(input.outcomeId)) : state.outcomes.filter(function (item) { return item.candidateId === candidateId; }).slice(-1)[0];
      if (!outcome) return fail('outcome_missing', 'Review needs a recorded sale or non-sale outcome');
      if (outcome.candidateId !== candidateId) return fail('outcome_candidate_mismatch', 'Review outcome belongs to another candidate');
      var candidate = found.candidate;
      var plan = input.planId ? findById(state.plans, text(input.planId)) : findById(state.plans, candidate.approvedPlanId);
      if (!plan) return fail('plan_missing', 'Review needs the frozen buy plan');
      if (plan.candidateId !== candidateId || plan.status !== 'Approved' || candidate.approvedPlanId !== plan.id) return fail('approved_plan_required', 'Review must use the approved frozen plan, not a later draft');
      var cause = text(input.cause);
      if (!cause) return fail('review_cause_required', 'Review needs a variance cause');
      var restock = input.restockDecision;
      if (!isObject(restock) || !text(restock.decision || restock.action) || !validTimestamp(text(restock.date || restock.at))) return fail('restock_decision_required', 'Review needs a dated restock decision');
      var actual = { status: 'Unknown', reason: 'No settled completed sale' };
      var money = getMoney();
      var variance = { status: 'Unknown', reason: 'No settled completed sale' };
      if (outcome.kind === 'sale') {
        if (!outcome.saleRef) return fail('sale_reference_missing', 'Sale review needs the existing sales row reference');
        var inventory = readInventory();
        if (!inventory.ok) return inventory;
        var sale = rowFromPayload(inventory.payload, 'sales', outcome.saleRef.id);
        if (!sale || rowBytes(sale) !== outcome.saleRef.bytes) return fail('sale_reference_conflict', 'Sale review reference is stale');
        if (sale.paymentStatus !== 'Settled' || !sale.dealerActual || !sale.dealerCostBasis) return fail('settlement_required', 'Contribution stays Unknown until the sale is explicitly settled');
        var copy = findById(state.copies, outcome.copyId);
        if (!copy || !copy.costComponent) return fail('cost_review_required', 'Sale review needs the canonical cost component');
        if (!money || typeof money.actualContribution !== 'function') return fail('money_module_required', 'Dealer Desk cannot review contribution without DealerMoney');
        var actualInput = actualInputFromSale(sale, copy.costComponent);
        try { actual.contribution = money.actualContribution(actualInput); } catch (error) { return fail('actual_contribution_invalid', error.message || 'Actual contribution is invalid'); }
        actual.status = actual.contribution.status;
        delete actual.reason;
        actual.saleRef = clone(outcome.saleRef);
        actual.lines = [actualInput.realisedProceeds, actualInput.canonicalLandedCost, actualInput.sellingFee, actualInput.outboundShipping];
        if (actual.contribution.status === 'Known') {
          try { variance = buildVarianceProjection(plan, sale, actual.contribution); }
          catch (error) { return fail('variance_invalid', error.message || 'Variance could not be calculated'); }
        }
      }
      var review = { id: uuid('review'), ownerId: ownerId(), candidateId: candidateId, outcomeId: outcome.id, planRef: { id: plan.id, version: plan.version, ownerId: ownerId() }, frozenPlan: { id: plan.id, version: plan.version, reason: plan.reason, candidateSnapshot: clone(plan.candidateSnapshot), expected: clone(plan.expected), plannedItemCost: clone(plan.plannedItemCost), plannedLandedCost: clone(plan.plannedLandedCost) }, createdAt: now(), actual: actual, variance: variance, cause: cause, restockDecision: { decision: text(restock.decision || restock.action), date: text(restock.date || restock.at) } };
      state.reviews.push(review);
      return { ok: true, result: { review: review } };
    }, options);
  }

  function readiness(candidateId) {
    var guard = guardPreview();
    if (guard) return guard;
    var state = readState();
    if (!state.ok) return state;
    return listingResult(state.state, candidateId);
  }

  function unsupported(operation) {
    return Promise.resolve(fail('unsupported_release_0', operation + ' is unavailable in Dealer Desk Release 0'));
  }

  function getState() {
    var guard = guardPreview();
    if (guard) return guard;
    var state = readState();
    if (!state.ok) return state;
    return success({ state: state.state, ownerId: state.state.ownerId, revision: state.state.revision });
  }

  function exportScoped() {
    var guard = guardPreview();
    if (guard) return guard;
    var stateResult = readState();
    if (!stateResult.ok) return stateResult;
    var inventory = readInventory();
    if (!inventory.ok) return inventory;
    var state = stateResult.state;
    var references = { inventory: [], sales: [] };
    for (var i = 0; i < state.copies.length; i += 1) {
      var copy = state.copies[i];
      var row = rowFromPayload(inventory.payload, copy.itemRef.table, copy.itemRef.id);
      if (!row) return fail('inventory_reference_missing', 'Scoped export cannot omit a referenced copy');
      references.inventory.push({ table: copy.itemRef.table, id: copy.itemRef.id, version: rowVersion(row), bytes: rowBytes(row), row: clone(row) });
    }
    for (var o = 0; o < state.outcomes.length; o += 1) {
      if (!state.outcomes[o].saleRef) continue;
      var saleRef = state.outcomes[o].saleRef;
      var sale = rowFromPayload(inventory.payload, 'sales', saleRef.id);
      if (!sale) return fail('sale_reference_missing', 'Scoped export cannot omit a referenced sale');
      references.sales.push({ table: 'sales', id: sale.id, version: rowVersion(sale), bytes: rowBytes(sale), row: clone(sale) });
    }
    var snapshot = { schemaVersion: SCHEMA_VERSION, release: VERSION, exportedAt: now(), ownerId: ownerId(), dealer: clone(state), references: references };
    return success({ snapshot: snapshot, json: JSON.stringify(snapshot, null, 2) });
  }

  function restoreScoped(input, options) {
    var guard = guardPreview();
    if (guard) return Promise.resolve(guard);
    options = options || {};
    var snapshot = input;
    if (typeof snapshot === 'string') {
      try { snapshot = JSON.parse(snapshot); } catch (error) { return Promise.resolve(fail('restore_corrupt', 'Restore JSON is invalid')); }
    }
    if (!isObject(snapshot) || snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.release !== VERSION || snapshot.ownerId !== ownerId() || !isObject(snapshot.dealer) || snapshot.dealer.ownerId !== ownerId()) return Promise.resolve(fail('restore_invalid', 'Restore owner or schema does not match this local pilot'));
    var valid = validateState(snapshot.dealer);
    if (!valid.ok) return Promise.resolve(fail('restore_invalid', valid.message, valid.details));
    if (!isObject(snapshot.references) || !Array.isArray(snapshot.references.inventory) || !Array.isArray(snapshot.references.sales)) return Promise.resolve(fail('restore_invalid', 'Restore references are missing'));
    for (var i = 0; i < snapshot.references.inventory.length; i += 1) {
      var ref = snapshot.references.inventory[i];
      var check = validateRef({ table: ref.table, id: ref.id, version: ref.version, bytes: ref.bytes, ownerId: ownerId() }, 'Restore inventory reference', ITEM_TABLES);
      if (!check.ok) return Promise.resolve(fail('restore_invalid', check.message));
      if (!isObject(ref.row) || ref.row.id !== ref.id || rowBytes(ref.row) !== ref.bytes || rowVersion(ref.row) !== ref.version) return Promise.resolve(fail('restore_invalid', 'Restore inventory row bytes or version are invalid'));
      if (rowQuantity(ref.row) !== 1 || text(ref.row._dealerOwnerId || ref.row.ownerId || ref.row.inventoryOwnerId) !== ownerId()) return Promise.resolve(fail('restore_invalid', 'Restore inventory row ownership or quantity is invalid'));
      var restoreCopy = snapshot.dealer.copies.filter(function (copy) { return copy.itemRef.table === ref.table && copy.itemRef.id === ref.id; })[0];
      var restoreCandidate = restoreCopy ? findById(snapshot.dealer.candidates, restoreCopy.candidateId) : null;
      if (!restoreCopy || !restoreCandidate || !candidateMatchesRow(restoreCandidate, ref.row, ref.table) || !isObject(ref.row.dealerCostBasis) || safeJson(ref.row.dealerCostBasis) !== safeJson(restoreCopy.costComponent)) return Promise.resolve(fail('restore_invalid', 'Restore inventory row does not match its candidate and canonical cost')); 
    }
    for (var s = 0; s < snapshot.references.sales.length; s += 1) {
      var saleRef = snapshot.references.sales[s];
      var saleCheck = validateRef({ table: 'sales', id: saleRef.id, version: saleRef.version, bytes: saleRef.bytes, ownerId: ownerId() }, 'Restore sale reference', ['sales']);
      if (!saleCheck.ok) return Promise.resolve(fail('restore_invalid', saleCheck.message));
      if (!isObject(saleRef.row) || saleRef.row.id !== saleRef.id || rowBytes(saleRef.row) !== saleRef.bytes || rowVersion(saleRef.row) !== saleRef.version) return Promise.resolve(fail('restore_invalid', 'Restore sale row bytes or version are invalid'));
      var restoreSaleActual = validateDealerActual(saleRef.row.dealerActual, 'Restore sale actual');
      if (!restoreSaleActual.ok || ['Unknown', 'Settled'].indexOf(text(saleRef.row.paymentStatus)) < 0) return Promise.resolve(fail('restore_invalid', 'Restore sale money or settlement status is invalid'));
    }
    var snapshotInventoryIds = snapshot.references.inventory.map(function (ref) { return ref.table + '/' + ref.id; });
    var requiredInventoryIds = snapshot.dealer.copies.map(function (copy) { return copy.itemRef.table + '/' + copy.itemRef.id; });
    var snapshotSaleIds = snapshot.references.sales.map(function (ref) { return 'sales/' + ref.id; });
    var requiredSaleIds = snapshot.dealer.outcomes.filter(function (outcome) { return !!outcome.saleRef; }).map(function (outcome) { return 'sales/' + outcome.saleRef.id; });
    if (snapshotInventoryIds.length !== requiredInventoryIds.length || requiredInventoryIds.some(function (id) { return snapshotInventoryIds.indexOf(id) < 0; })) return Promise.resolve(fail('restore_invalid', 'Restore is missing a referenced inventory copy'));
    if (snapshotSaleIds.length !== requiredSaleIds.length || requiredSaleIds.some(function (id) { return snapshotSaleIds.indexOf(id) < 0; })) return Promise.resolve(fail('restore_invalid', 'Restore is missing a referenced sale'));
    var currentStateResult = readState();
    if (!currentStateResult.ok) return Promise.resolve(currentStateResult);
    var currentState = currentStateResult.state;
    var sameCore = restoreCoreFingerprint(currentState) === restoreCoreFingerprint(snapshot.dealer);
    if (!sameCore && hasCoreRecords(currentState)) return Promise.resolve(fail('restore_state_conflict', 'Restore would replace newer local Dealer Desk metadata', { currentRevision: currentState.revision, conflicts: 1 }));
    options = mutationContext(Object.assign({}, options, { lockKeys: (options.lockKeys || []).concat(snapshot.references.inventory.map(function (ref) { return 'dealer-row:' + ref.table + ':' + ref.id; }), snapshot.references.sales.map(function (ref) { return 'dealer-row:sales:' + ref.id; })) }), { operation: 'restore', dealer: snapshot.dealer, references: snapshot.references });
    return commitInventoryAndMetadata(function (state, payload) {
      var previousRevision = state.revision;
      var requiredRefs = snapshot.references.inventory.concat(snapshot.references.sales);
      var insertedReferences = 0;
      var skippedReferences = 0;
      for (var r = 0; r < requiredRefs.length; r += 1) {
        var reference = requiredRefs[r];
        var table = reference.table;
        payload[table] = Array.isArray(payload[table]) ? payload[table] : [];
        var current = rowFromPayload(payload, table, reference.id);
        if (current && rowBytes(current) !== reference.bytes) return fail('restore_reference_conflict', 'Restore reference does not match current local data', { table: table, id: reference.id, restoredReferences: requiredRefs.length, insertedReferences: insertedReferences, skippedReferences: skippedReferences, conflicts: 1 });
        if (current) skippedReferences += 1;
        else {
          payload[table].push(clone(reference.row));
          insertedReferences += 1;
        }
      }
      var currentRequestLedger = state.requestLedger;
      Object.keys(state).forEach(function (key) { delete state[key]; });
      Object.keys(snapshot.dealer).forEach(function (key) { state[key] = clone(snapshot.dealer[key]); });
      state.requestLedger = mergeRequestLedgers(currentRequestLedger, snapshot.dealer.requestLedger);
      return { ok: true, result: { restored: true, previousRevision: previousRevision, restoredReferences: requiredRefs.length, insertedReferences: insertedReferences, skippedReferences: skippedReferences, conflicts: 0 } };
    }, options);
  }

  function inspect(candidateId) {
    var guard = guardPreview();
    if (guard) return guard;
    var state = readState();
    if (!state.ok) return state;
    var candidate = candidateId ? findById(state.state.candidates, candidateId) : null;
    return success({ state: state.state, candidate: candidate, readiness: candidate ? listingResult(state.state, candidateId) : null });
  }

  var api = {
    VERSION: VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    METADATA_KEY: METADATA_KEY,
    INVENTORY_KEY: INVENTORY_KEY,
    ownerId: ownerId,
    isLocalPreview: isLocalPreview,
    getState: getState,
    recover: recover,
    inspect: inspect,
    createCandidate: createCandidate,
    updateCandidate: updateCandidate,
    addEvidence: addEvidence,
    createPlan: createPlan,
    revisePlan: revisePlan,
    approveBuy: approveBuy,
    approveAsk: approveAsk,
    acquireCopy: acquireCopy,
    createCopy: createCopy,
    linkCopy: linkCopy,
    getListingReadiness: readiness,
    listingReadiness: readiness,
    prepareListing: prepareListing,
    recordSale: recordSale,
    settleSale: settleSale,
    recordNoSale: recordNoSale,
    recordNonSale: recordNoSale,
    reviewOutcome: reviewOutcome,
    recordReview: reviewOutcome,
    exportScoped: exportScoped,
    exportRecovery: exportScoped,
    restoreScoped: restoreScoped,
    restoreRecovery: restoreScoped,
    reserve: function () { return unsupported('Reservations'); },
    returnSale: function () { return unsupported('Returns'); },
    refund: function () { return unsupported('Refunds'); },
    bundle: function () { return unsupported('Bundles'); },
    publishListing: function () { return unsupported('Marketplace publishing'); }
  };

  root.DealerDesk = Object.freeze(api);
}(typeof globalThis !== 'undefined' ? globalThis : this));
