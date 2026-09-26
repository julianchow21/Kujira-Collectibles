import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import DealerStore from '../dealer-store.js';

const RUN = process.env.KJ_DEALER_RUN_DOCKER === '1';
const IMAGE = 'postgres:17-alpine';
const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '00000000-0000-4000-8000-000000000002';
const SKIP = RUN ? false : 'set KJ_DEALER_RUN_DOCKER=1 to run the disposable PostgreSQL 17 Dealer gate';

function docker(args, input = '') {
  const result = spawnSync('docker', args, { input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  return result.stdout.trim();
}

function sql(container, statement, role = 'postgres') {
  const roleSql = role === 'postgres' ? '' : `set role ${role};\n`;
  return docker(['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-At', '-q'], roleSql + statement);
}

function maybeSql(container, statement, role = 'postgres') {
  const roleSql = role === 'postgres' ? '' : `set role ${role};\n`;
  return spawnSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-At', '-q'], { input: roleSql + statement, encoding: 'utf8' });
}

function request(command, id, expected = {}, payload = {}) {
  return { owner_user_id: OWNER, client_protocol: 2, schema_version: 1, command_id: id, command, expected, payload };
}

function command(container, body) {
  const encoded = JSON.stringify(body).replaceAll("'", "''");
  return JSON.parse(sql(container, `select public.collectibles_dealer_command_v1('${encoded}'::jsonb);`));
}

function dealerPull(container, body) {
  const encoded = JSON.stringify(body).replaceAll("'", "''");
  return JSON.parse(sql(container, `select public.collectibles_dealer_pull_v1('${encoded}'::jsonb);`));
}

function setupSql() {
  const roles = [
    'create role anon nologin;',
    'create role authenticated nologin;',
    'create role service_role nologin bypassrls;',
    'grant usage on schema public to anon, authenticated, service_role;'
  ];
  const tables = ['singles', 'slabs', 'sales', 'etbs', 'booster_boxes', 'booster_packs', 'ebay_purchases', 'trash', 'versions']
    .map(table => `create table public.${table} (id text primary key, data jsonb not null, row_version bigint not null default 1, updated_at timestamptz not null default clock_timestamp());`);
  return roles.concat(tables).join('\n');
}

test('Dealer migration, typed flow, idempotency and generic guard', { skip: SKIP }, async () => {
  const container = `kjr-dealer-${process.pid}-${Date.now()}`;
  let running = false;
  try {
    const supervisor = [
      'set -eu',
      'mkdir -p /var/lib/postgresql/data /var/run/postgresql',
      'chown -R postgres:postgres /var/lib/postgresql/data /var/run/postgresql',
      "if [ ! -s /var/lib/postgresql/data/PG_VERSION ]; then su postgres -s /bin/sh -c 'initdb -D /var/lib/postgresql/data -A trust --no-locale'; fi",
      "while :; do su postgres -s /bin/sh -c 'postgres -D /var/lib/postgresql/data -k /var/run/postgresql' & server_pid=$!; wait $server_pid; sleep 0.1; done"
    ].join('; ');
    docker(['run', '--pull=never', '--detach', '--rm', '--network', 'none', '--tmpfs', '/var/lib/postgresql/data', '--tmpfs', '/tmp', '--name', container, '--entrypoint', '/bin/sh', IMAGE, '-c', supervisor]);
    running = true;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const probe = maybeSql(container, 'select 1;');
      if (probe.status === 0 && maybeSql(container, 'select 1;').status === 0) break;
      if (attempt === 39) throw new Error(probe.stderr + probe.stdout);
      spawnSync('sleep', ['0.25']);
    }
    sql(container, setupSql());
    sql(container, fs.readFileSync(new URL('../Server/CAS.sql', import.meta.url), 'utf8'));
    sql(container, fs.readFileSync(new URL('../Server/Dealer.sql', import.meta.url), 'utf8'));
    sql(container, fs.readFileSync(new URL('../Server/Dealer.sql', import.meta.url), 'utf8'));
    sql(container, fs.readFileSync(new URL('../Server/CAS.sql', import.meta.url), 'utf8'));
    sql(container, `insert into public.singles(id,data,row_version) values ('card-1','{"name":"PA18","set":"SV Promo","number":"PA18","language":"EN","variant":"Holo","condition":{"value":"Near Mint","certainty":"Known"},"ownership":"Business","status":"Available","qty":1,"costPrice":20}',1);`);
    assert.equal(Number(sql(container, `select public.dealer_plan_economics('{"reportingCurrency":"SGD","expectedSaleAmount":"10.009","expectedSellingFee":"0.00","expectedOutboundShipping":"0.00","expectedRefundAllowance":"0.00","otherExpectedDeductions":"0.00","targetContribution":"0.00","riskAllowance":"0.00","knownNonItemAcquisitionCosts":"0.00"}'::jsonb)->>'itemPriceCeiling';`)), 10);

    const frontendContext = {
      authenticated: true,
      verified: true,
      userId: OWNER,
      sessionId: '00000000-0000-4000-8000-000000000010',
      generation: 1,
      offline: false
    };
    const frontendStore = DealerStore.create({
      ownerContext: () => frontendContext,
      storage: null,
      transport: {
        pull: async requestBody => dealerPull(container, { ...requestBody.body, owner_user_id: OWNER }),
        command: async requestBody => command(container, { ...requestBody.body, owner_user_id: OWNER })
      }
    });
    const frontendPage = await frontendStore.pull({ limit: 500 });
    assert.equal(frontendPage.ok, true);
    const frontendCommand = await frontendStore.command('create_candidate', {
      candidateId: 'frontend-wire-candidate',
      ownership: 'Business',
      status: 'Draft',
      name: 'Frontend wire contract'
    }, { commandId: '00000000-0000-4000-8000-000000000011' });
    assert.equal(frontendCommand.ok, true, JSON.stringify(frontendCommand));
    assert.equal(frontendCommand.candidate.id, 'frontend-wire-candidate');

    let result = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000101', {}, { candidateId: 'candidate-1', ownership: { class: 'Business', reviewed: true }, ownershipReviewed: true, status: 'Draft', identity: { name: 'PA18', set: 'SV Promo', number: 'PA18', language: 'EN', variant: 'Holo' }, condition: { value: 'Near Mint', certainty: 'Known' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.candidate.row_version, 1);
    result = command(container, request('add_evidence', '00000000-0000-4000-8000-000000000102', { candidate: 1 }, { candidateId: 'candidate-1', evidenceId: 'evidence-1', evidence: { class: 'purchase', source: 'receipt', reference: 'receipt-pa18', observedAt: '2026-09-25T10:00:00Z', match: 'Exact', confidence: 'High', rationale: 'Receipt matches the candidate identity' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('create_plan', '00000000-0000-4000-8000-000000000103', { candidate: 1 }, { candidateId: 'candidate-1', planId: 'plan-1', plan: { reason: 'PA18 review', reportingCurrency: 'SGD', expectedSaleAmount: { amount: '150.00', status: 'Known', currency: 'SGD' }, expectedSellingFee: { amount: '10.00', status: 'Known', currency: 'SGD' }, expectedOutboundShipping: { amount: '5.00', status: 'Known', currency: 'SGD' }, expectedRefundAllowance: { amount: '0.00', status: 'Known', currency: 'SGD' }, otherExpectedDeductions: { amount: '0.00', status: 'Known', currency: 'SGD' }, targetContribution: { amount: '5.00', status: 'Known', currency: 'SGD' }, riskAllowance: { amount: '0.00', status: 'Known', currency: 'SGD' }, knownNonItemAcquisitionCosts: { amount: '2.00', status: 'Known', currency: 'SGD' }, plannedItemCost: '20.00' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.plan.data.expected.expectedNetProceeds, 135);
    assert.equal(result.result.plan.data.expected.itemPriceCeiling, 128);
    assert.equal(result.result.plan.data.plannedLandedCost.amount, 22);
    result = command(container, request('approve_buy', '00000000-0000-4000-8000-000000000104', { candidate: 1, plan: 1 }, { candidateId: 'candidate-1', planId: 'plan-1', reason: 'approved' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.candidate.data.status, 'Buy approved');
    result = command(container, request('link_copy', '00000000-0000-4000-8000-000000000105', { candidate: 2, canonical: 1 }, { candidateId: 'candidate-1', copyId: 'copy-1', inventoryTable: 'singles', inventoryId: 'card-1', reviewedCost: { confirmed: true, currency: 'SGD', itemCost: '20.00', nonItemAcquisitionCosts: '2.00', reason: 'reviewed receipt', reviewedAt: '2026-09-25T10:00:00Z' } }));
    assert.equal(result.ok, true);
    assert.equal(result.result.candidate.data.status, 'Acquired');
    assert.equal(sql(container, "select data->>'costPrice' from public.singles where id='card-1';"), '20');
    assert.equal(result.result.copy.data.costComponent.settledAmount, 22);
    const repeatedAcquisition = command(container, request('link_copy', '00000000-0000-4000-8000-000000000159', { candidate: result.result.candidate.row_version, canonical: 2 }, { candidateId: 'candidate-1', copyId: 'copy-duplicate', inventoryTable: 'singles', inventoryId: 'card-1', reviewedCost: { confirmed: true, currency: 'SGD', itemCost: '20.00', nonItemAcquisitionCosts: '2.00', reason: 'repeat attempt', reviewedAt: '2026-09-25T10:00:00Z' } }));
    assert.equal(repeatedAcquisition.ok, false);
    assert.equal(repeatedAcquisition.code, 'state_conflict');
    result = command(container, request('prepare_listing', '00000000-0000-4000-8000-000000000106', { candidate: 3, copy: 1 }, { candidateId: 'candidate-1', copyId: 'copy-1', listingId: 'listing-1', platform: 'manual' }));
    assert.equal(result.ok, true);
    result = command(container, request('record_sale', '00000000-0000-4000-8000-000000000107', { candidate: 3, canonical: 2 }, { candidateId: 'candidate-1', copyId: 'copy-1', listingId: 'listing-1', saleId: 'sale-1', agreedAmount: '150.00', currency: 'SGD' }));
    assert.equal(result.ok, true);
    assert.equal(result.result.sale.paymentStatus, 'Unknown');
    assert.equal(JSON.parse(sql(container, "select coalesce(data->>'profit','null') from public.sales where id='sale-1';")), null);
    const unsettledSale = JSON.parse(sql(container, "select data::text from public.sales where id='sale-1';"));
    assert.equal(unsettledSale.product, 'PA18');
    assert.equal(unsettledSale.costPrice, 22);
    assert.equal(unsettledSale.shippingCost, null);
    assert.equal(unsettledSale.fees, null);
    assert.equal(unsettledSale.channel, 'Manual');
    assert.equal(unsettledSale.inventoryId, 'card-1');
    assert.equal(unsettledSale.inventoryTable, 'singles');
    assert.equal(unsettledSale.paymentStatus, 'Unknown');
    assert.equal(unsettledSale.profit, null);
    result = command(container, request('settle_sale', '00000000-0000-4000-8000-000000000108', { outcome: 1, sale: 1 }, { outcomeId: result.result.outcome.id, cashSettledAt: '2026-09-25T10:00:00Z', settlementEvidence: { class: 'manual', proof: 'PA18 receipt', date: '2026-09-25' }, proceeds: '150.00', sellingFee: '10.00', outboundShipping: '5.00' }));
    assert.equal(result.ok, true);
    assert.equal(Number(result.result.sale.contribution), 113);
    const settledSale = JSON.parse(sql(container, "select data::text from public.sales where id='sale-1';"));
    assert.equal(settledSale.totalCollected, 150);
    assert.equal(settledSale.fees, 10);
    assert.equal(settledSale.shippingCost, 5);
    assert.equal(settledSale.profit, 113);
    assert.equal(settledSale.paymentStatus, 'Settled');
    assert.equal(Number(sql(container, "select canonical_row_version from public.dealer_canonical_links where copy_id='copy-1';")), 3);
    assert.equal(Number(sql(container, "select sale_row_version from public.dealer_canonical_links where copy_id='copy-1';")), 2);
    result = command(container, request('review_outcome', '00000000-0000-4000-8000-000000000109', { outcome: 2 }, { outcomeId: result.result.outcome.id, review: { cause: 'reviewed', restockDecision: { decision: 'keep', date: '2026-09-25' } } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.review.data.planVariance.delta, 0);
    assert.equal(result.result.review.data.targetVariance.delta, 108);

    const pull = JSON.parse(sql(container, `select public.collectibles_dealer_pull_v1('${JSON.stringify({ owner_user_id: OWNER, client_protocol: 2, schema_version: 1, candidateId: 'candidate-1' }).replaceAll("'", "''")}'::jsonb);`));
    assert.equal(pull.ok, true);
    assert.equal(pull.selected.candidate.data.status, 'Acquired');
    assert.equal(pull.canonicalRefs.length, 1);

    const blocked = command(container, request('update_candidate', '00000000-0000-4000-8000-000000000120', { candidate: 4 }, { candidateId: 'candidate-1', patch: { ownership: 'Personal' } }));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'frozen_candidate');
    const frozenCandidateVersion = Number(sql(container, "select row_version from public.dealer_records where entity_type='candidate' and id='candidate-1';"));
    const frozenPlanBeforeEvidencePatch = sql(container, "select data::text from public.dealer_records where entity_type='plan' and id='plan-1';");
    const evidenceReplacement = command(container, request('update_candidate', '00000000-0000-4000-8000-000000000172', { candidate: frozenCandidateVersion }, { candidateId: 'candidate-1', patch: { evidence: { class: 'identity', source: 'forged-replacement', reference: 'replacement', observedAt: '2026-09-25T10:00:00Z', match: 'Exact', confidence: 'High', rationale: 'Must be appended through add_evidence' } } }));
    assert.equal(evidenceReplacement.ok, false);
    assert.equal(evidenceReplacement.code, 'frozen_candidate');
    const appendedEvidence = command(container, request('add_evidence', '00000000-0000-4000-8000-000000000173', { candidate: frozenCandidateVersion }, { candidateId: 'candidate-1', evidenceId: 'evidence-postapproval-append', evidence: { class: 'identity', source: 'review-note', reference: 'append-only', observedAt: '2026-09-25T10:00:00Z', match: 'Exact', confidence: 'High', rationale: 'Post-approval evidence is appended as its own record' } }));
    assert.equal(appendedEvidence.ok, true, JSON.stringify(appendedEvidence));
    assert.equal(sql(container, "select data::text from public.dealer_records where entity_type='plan' and id='plan-1';"), frozenPlanBeforeEvidencePatch);
    assert.equal(sql(container, "select count(*) from public.dealer_records where entity_type='evidence' and candidate_id='candidate-1' and id='evidence-postapproval-append';"), '1');
    const cas = JSON.parse(sql(container, `select public.collectibles_mutate_v2('${JSON.stringify({ client_protocol: 2, mutation_id: '00000000-0000-4000-8000-000000000121', operations: [{ type: 'upsert', table: 'singles', id: 'card-1', expected_version: 3, data: { status: 'Available' } }] }).replaceAll("'", "''")}'::jsonb);`));
    assert.equal(cas.ok, false);
    assert.equal(cas.code, 'dealer_controlled_row');

    result = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000130', {}, { candidateId: 'candidate-ns', ownership: { class: 'Business', reviewed: true }, ownershipReviewed: true, status: 'Draft', format: 'slab', identity: { name: 'Golden 35', set: 'Test', number: '35', language: 'EN', variant: 'Normal' }, condition: { value: 'Near Mint', certainty: 'Known' }, grader: 'PSA', grade: '10', gradeCertainty: 'Verified', certificateNumber: 'CERT-1' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('add_evidence', '00000000-0000-4000-8000-000000000131', { candidate: 1 }, { candidateId: 'candidate-ns', evidenceId: 'evidence-ns', evidence: { class: 'identity', source: 'catalogue', reference: 'golden-35', observedAt: '2026-09-25T10:00:00Z', match: 'Exact', confidence: 'High', rationale: 'Synthetic identity fixture' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('create_plan', '00000000-0000-4000-8000-000000000132', { candidate: 1 }, { candidateId: 'candidate-ns', planId: 'plan-ns', plan: { reason: 'golden money case', reportingCurrency: 'SGD', expectedSaleAmount: { amount: '35.00', status: 'Known', currency: 'SGD' }, expectedSellingFee: { amount: '1.00', status: 'Known', currency: 'SGD' }, expectedOutboundShipping: { amount: '2.00', status: 'Known', currency: 'SGD' }, expectedRefundAllowance: { amount: '1.00', status: 'Known', currency: 'SGD' }, otherExpectedDeductions: { amount: '0.00', status: 'Known', currency: 'SGD' }, targetContribution: { amount: '5.00', status: 'Known', currency: 'SGD' }, riskAllowance: { amount: '1.00', status: 'Known', currency: 'SGD' }, knownNonItemAcquisitionCosts: { amount: '2.00', status: 'Known', currency: 'SGD' }, plannedItemCost: '20.00' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.plan.data.expected.plannedContribution, 9);
    result = command(container, request('approve_buy', '00000000-0000-4000-8000-000000000133', { candidate: 1, plan: 1 }, { candidateId: 'candidate-ns', planId: 'plan-ns', reason: 'approved' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('acquire_copy', '00000000-0000-4000-8000-000000000134', { candidate: 2, canonical: 0 }, { candidateId: 'candidate-ns', copyId: 'copy-ns', inventoryTable: 'slabs', reviewedCost: { confirmed: true, currency: 'SGD', itemCost: '20.00', nonItemAcquisitionCosts: '2.00', reason: 'reviewed receipt', reviewedAt: '2026-09-25T10:00:00Z' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.canonicalRef.table, 'slabs');
    assert.equal(sql(container, "select data->>'ownership' from public.slabs where id='dealer-copy-ns';"), 'Business');
    assert.equal(sql(container, "select data->>'grader' from public.slabs where id='dealer-copy-ns';"), 'PSA');
    assert.equal(sql(container, "select data->>'grade' from public.slabs where id='dealer-copy-ns';"), '10');
    assert.equal(sql(container, "select data->>'certNo' from public.slabs where id='dealer-copy-ns';"), 'CERT-1');
    result = command(container, request('record_non_sale', '00000000-0000-4000-8000-000000000135', { candidate: 3 }, { candidateId: 'candidate-ns', copyId: 'copy-ns', outcomeId: 'outcome-ns', nonSale: { reason: 'returned' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.outcome.data.actual, 'Unknown');
    assert.equal(result.result.outcome.data.paymentStatus, 'NotApplicable');
    const nonSaleCandidateVersion = Number(sql(container, "select row_version from public.dealer_records where entity_type='candidate' and id='candidate-ns';"));
    const nonSaleCanonicalVersion = Number(sql(container, "select row_version from public.slabs where id='dealer-copy-ns';"));
    result = command(container, request('record_sale', '00000000-0000-4000-8000-000000000136', { candidate: nonSaleCandidateVersion, canonical: nonSaleCanonicalVersion }, { candidateId: 'candidate-ns', copyId: 'copy-ns', outcomeId: 'outcome-sale-after-ns', saleId: 'sale-after-ns', agreedAmount: '35.00', currency: 'SGD' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('settle_sale', '00000000-0000-4000-8000-000000000137', { outcome: 1, sale: 1 }, { outcomeId: 'outcome-sale-after-ns', cashSettledAt: '2026-09-26T00:00:00Z', settlementEvidence: { class: 'manual', proof: 'later sale receipt', date: '2026-09-26' }, proceeds: '35.00', sellingFee: '1.00', outboundShipping: '2.00' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('review_outcome', '00000000-0000-4000-8000-000000000138', { outcome: 2 }, { outcomeId: 'outcome-sale-after-ns', review: { cause: 'later sale reviewed', restockDecision: { decision: 'keep', date: '2026-09-26' } } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    const laterPull = dealerPull(container, { owner_user_id: OWNER, client_protocol: 2, schema_version: 1, candidateId: 'candidate-ns' });
    assert.equal(laterPull.selected.outcomes[0].id, 'outcome-sale-after-ns');
    assert.equal(laterPull.selected.outcomes[1].id, 'outcome-ns');
    assert.equal(laterPull.selected.reviews[0].data.actual.contribution, 10);

    result = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000160', {}, { candidateId: 'candidate-grade-gate', ownership: { class: 'Business', reviewed: true }, ownershipReviewed: true, status: 'Draft', format: 'raw', identity: { name: 'Grade Gate', set: 'Test', number: 'G1', language: 'EN', variant: 'Normal' }, condition: { value: 'Near Mint', certainty: 'Known' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('add_evidence', '00000000-0000-4000-8000-000000000161', { candidate: 1 }, { candidateId: 'candidate-grade-gate', evidenceId: 'evidence-grade-gate', evidence: { class: 'market', source: 'catalogue', reference: 'grade-gate', observedAt: '2026-09-25T10:00:00Z', match: 'Exact', confidence: 'High', rationale: 'Synthetic market evidence without a verified grade' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('create_plan', '00000000-0000-4000-8000-000000000162', { candidate: 1 }, { candidateId: 'candidate-grade-gate', planId: 'plan-grade-gate', plan: { reason: 'top-grade negative case', scenario: 'top-grade resale', reportingCurrency: 'SGD', expectedSaleAmount: '100.00', expectedSellingFee: '0.00', expectedOutboundShipping: '0.00', expectedRefundAllowance: '0.00', otherDeductions: '0.00', targetContribution: '0.00', riskAllowance: '0.00', knownNonItemAcquisitionCosts: '0.00', plannedItemCost: '10.00' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('approve_buy', '00000000-0000-4000-8000-000000000163', { candidate: 1, plan: 1 }, { candidateId: 'candidate-grade-gate', planId: 'plan-grade-gate', reason: 'top-grade negative case' }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'buy_not_ready');
    assert.ok(result.current.readiness.blockers.includes('grade_basis_required'));
    result = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000164', {}, { candidateId: 'candidate-grade-pass', ownership: { class: 'Business', reviewed: true }, ownershipReviewed: true, status: 'Draft', format: 'slab', identity: { name: 'Grade Pass', set: 'Test', number: 'G2', language: 'EN', variant: 'Normal' }, condition: { value: 'Gem Mint', certainty: 'Known' }, grading: { grader: 'PSA', grade: '10', certainty: 'Verified', certNo: 'CERT-2' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('add_evidence', '00000000-0000-4000-8000-000000000165', { candidate: 1 }, { candidateId: 'candidate-grade-pass', evidenceId: 'evidence-grade-pass', evidence: { class: 'condition', source: 'certificate', reference: 'cert-grade-pass', observedAt: '2026-09-25T10:00:00Z', match: 'Exact', confidence: 'High', rationale: 'Certificate verifies the recorded grade' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('create_plan', '00000000-0000-4000-8000-000000000166', { candidate: 1 }, { candidateId: 'candidate-grade-pass', planId: 'plan-grade-pass', plan: { reason: 'verified top-grade case', scenario: 'top-grade resale', reportingCurrency: 'SGD', expectedSaleAmount: '100.00', expectedSellingFee: '0.00', expectedOutboundShipping: '0.00', expectedRefundAllowance: '0.00', otherDeductions: '0.00', targetContribution: '0.00', riskAllowance: '0.00', knownNonItemAcquisitionCosts: '0.00', plannedItemCost: '10.00' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('approve_buy', '00000000-0000-4000-8000-000000000167', { candidate: 1, plan: 1 }, { candidateId: 'candidate-grade-pass', planId: 'plan-grade-pass', reason: 'verified top-grade case' }));
    assert.equal(result.ok, true, JSON.stringify(result));

    result = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000150', {}, { candidateId: 'candidate-gold', ownership: { class: 'Business', reviewed: true }, ownershipReviewed: true, status: 'Draft', identity: { name: 'Golden 35', set: 'Test', number: '35', language: 'EN', variant: 'Normal' }, condition: { value: 'Near Mint', certainty: 'Known' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('add_evidence', '00000000-0000-4000-8000-000000000151', { candidate: 1 }, { candidateId: 'candidate-gold', evidenceId: 'evidence-gold', evidence: { class: 'identity', source: 'catalogue', reference: 'golden-35', observedAt: '2026-09-25T10:00:00Z', match: 'Exact', confidence: 'High', rationale: 'Synthetic identity fixture' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('create_plan', '00000000-0000-4000-8000-000000000152', { candidate: 1 }, { candidateId: 'candidate-gold', planId: 'plan-gold', plan: { reason: 'golden sale case', reportingCurrency: 'SGD', expectedSaleAmount: { amount: '35.00', status: 'Known', currency: 'SGD' }, expectedSellingFee: { amount: '1.00', status: 'Known', currency: 'SGD' }, expectedOutboundShipping: { amount: '2.00', status: 'Known', currency: 'SGD' }, expectedRefundAllowance: { amount: '1.00', status: 'Known', currency: 'SGD' }, otherExpectedDeductions: { amount: '0.00', status: 'Known', currency: 'SGD' }, targetContribution: { amount: '5.00', status: 'Known', currency: 'SGD' }, riskAllowance: { amount: '1.00', status: 'Known', currency: 'SGD' }, knownNonItemAcquisitionCosts: { amount: '2.00', status: 'Known', currency: 'SGD' }, plannedItemCost: '20.00' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('approve_buy', '00000000-0000-4000-8000-000000000153', { candidate: 1, plan: 1 }, { candidateId: 'candidate-gold', planId: 'plan-gold', reason: 'approved' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('acquire_copy', '00000000-0000-4000-8000-000000000154', { candidate: 2, canonical: 0 }, { candidateId: 'candidate-gold', copyId: 'copy-gold', inventoryTable: 'singles', reviewedCost: { confirmed: true, currency: 'SGD', itemCost: '20.00', nonItemAcquisitionCosts: '2.00', reason: 'reviewed receipt', reviewedAt: '2026-09-25T10:00:00Z' } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('record_sale', '00000000-0000-4000-8000-000000000155', { candidate: 3, canonical: 1 }, { candidateId: 'candidate-gold', copyId: 'copy-gold', saleId: 'sale-gold', agreedAmount: '35.00', currency: 'SGD' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    result = command(container, request('settle_sale', '00000000-0000-4000-8000-000000000156', { outcome: 1, sale: 1 }, { outcomeId: result.result.outcome.id, cashSettledAt: '2026-09-25T10:00:00Z', settlementEvidence: { class: 'manual', proof: 'golden receipt', date: '2026-09-25' }, proceeds: '35.00', sellingFee: '1.00', outboundShipping: '2.00' }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(Number(result.result.sale.contribution), 10);
    result = command(container, request('review_outcome', '00000000-0000-4000-8000-000000000157', { outcome: 2 }, { outcomeId: result.result.outcome.id, review: { cause: 'golden reviewed', restockDecision: { decision: 'keep', date: '2026-09-25' } } }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.result.review.data.planVariance.delta, 1);
    assert.equal(result.result.review.data.targetVariance.delta, 5);

    const replayBody = request('create_candidate', '00000000-0000-4000-8000-000000000140', {}, { candidateId: 'candidate-replay', ownership: 'Business' });
    const first = command(container, replayBody);
    const second = command(container, replayBody);
    assert.deepEqual(second, first);
    const reused = command(container, { ...replayBody, payload: { candidateId: 'candidate-replay', ownership: 'Business', title: 'changed' } });
    assert.equal(reused.ok, false);
    assert.equal(reused.code, 'mutation_id_reused');
    const anon = maybeSql(container, 'select count(*) from public.dealer_records;', 'anon');
    assert.notEqual(anon.status, 0);
  } finally {
    if (running) spawnSync('docker', ['rm', '--force', container], { encoding: 'utf8' });
  }
});
