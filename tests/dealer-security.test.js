import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import worker from '../Server/worker.js';

const RUN = process.env.KJ_DEALER_RUN_DOCKER === '1';
const IMAGE = 'postgres:17-alpine';
const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '00000000-0000-4000-8000-000000000002';
const SKIP = RUN ? false : 'set KJ_DEALER_RUN_DOCKER=1 to run the disposable PostgreSQL 17 security gates';

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

function request(command, id, expected = {}, payload = {}) {
  return { owner_user_id: OWNER, client_protocol: 2, schema_version: 1, command_id: id, command, expected, payload };
}

function command(container, body) {
  const encoded = JSON.stringify(body).replaceAll("'", "''");
  return JSON.parse(sql(container, `select public.collectibles_dealer_command_v1('${encoded}'::jsonb);`));
}

function cas(container, body) {
  const encoded = JSON.stringify(body).replaceAll("'", "''");
  return JSON.parse(sql(container, `select public.collectibles_mutate_v2('${encoded}'::jsonb);`));
}

function makeCandidate(container, prefix, n, itemPrice = '10.00') {
  const baseCommandNumber = n * 10;
  let result = command(container, request('create_candidate', `00000000-0000-4000-8000-${String(baseCommandNumber + 1).padStart(12, '0')}`, {}, {
    candidateId: prefix,
    name: prefix,
    set: 'Synthetic Set',
    number: String(n).padStart(3, '0'),
    language: 'EN',
    variant: 'Normal',
    condition: 'Near mint',
    ownership: 'Business',
    ownershipReviewed: true,
    status: 'Draft',
    identity: { name: prefix, set: 'Synthetic Set', number: String(n).padStart(3, '0'), language: 'EN', variant: 'Normal' }
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  result = command(container, request('add_evidence', `00000000-0000-4000-8000-${String(baseCommandNumber + 2).padStart(12, '0')}`, { candidate: 1 }, {
    candidateId: prefix,
    evidence: {
      class: 'identity', source: `synthetic://${prefix}/identity`, match: 'Exact', confidence: 'High',
      rationale: `${prefix} identity review`, observedAt: '2026-09-25T00:00:00+08:00'
    }
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  result = command(container, request('create_plan', `00000000-0000-4000-8000-${String(baseCommandNumber + 3).padStart(12, '0')}`, { candidate: 1 }, {
    candidateId: prefix,
    planId: `${prefix}-plan-1`,
    plan: {
      reason: `${prefix} review`, expectedSaleAmount: '35.00', expectedSellingFee: '1.00',
      expectedOutboundShipping: '2.00', expectedRefundAllowance: '1.00', otherExpectedDeductions: '0.00',
      targetContribution: '5.00', riskAllowance: '0.00', knownNonItemAcquisitionCosts: '2.00',
      plannedItemCost: itemPrice, reportingCurrency: 'SGD'
    }
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  result = command(container, request('approve_buy', `00000000-0000-4000-8000-${String(baseCommandNumber + 4).padStart(12, '0')}`, { candidate: 1, plan: 1 }, {
    candidateId: prefix,
    planId: `${prefix}-plan-1`,
    approval: { reason: 'approved' }
  }));
  assert.equal(result.ok, true, JSON.stringify(result));
  return { candidate: result.result.candidate, plan: result.result.plan };
}

function linkCopy(container, prefix, n, canonicalId, reviewedCost = {}, candidateVersion = 2, canonicalVersion = 1) {
  const completeReviewedCost = {
    confirmed: true,
    currency: 'SGD',
    itemCost: '10.00',
    nonItemAcquisitionCosts: '0.00',
    reason: 'Synthetic security cost review',
    reviewedAt: '2026-09-25T00:00:00+08:00',
    ...reviewedCost
  };
  return command(container, request('link_copy', `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, { candidate: candidateVersion, canonical: canonicalVersion }, {
    candidateId: prefix,
    copyId: `${prefix}-copy-1`,
    inventoryTable: 'singles',
    inventoryId: canonicalId,
    reviewedCost: completeReviewedCost
  }));
}

test('Dealer adversarial controls and Worker owner binding', { skip: SKIP }, async t => {
  const container = `kjr-dealer-security-${process.pid}-${Date.now()}`;
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
      if (probe.status === 0) break;
      if (attempt === 39) throw new Error(probe.stderr + probe.stdout);
      spawnSync('sleep', ['0.25']);
    }
    sql(container, setupSql());
    sql(container, fs.readFileSync(new URL('../Server/CAS.sql', import.meta.url), 'utf8'));
    sql(container, fs.readFileSync(new URL('../Server/Dealer.sql', import.meta.url), 'utf8'));
    sql(container, fs.readFileSync(new URL('../Server/Dealer.sql', import.meta.url), 'utf8'));
    sql(container, `insert into public.singles(id,data,row_version) values
      ('card-plan','{"name":"plan-candidate","ownership":"Business","status":"Available","qty":1,"costPrice":10}',1),
      ('card-sale','{"ownership":"Business","status":"Available","qty":1,"costPrice":10}',1),
      ('card-fx','{"ownership":"Business","status":"Available","qty":1,"costPrice":10}',1),
      ('card-fx-settle','{"ownership":"Business","status":"Available","qty":1,"costPrice":10}',1),
      ('card-negative','{"ownership":"Business","status":"Available","qty":1,"costPrice":12}',1),
      ('card-zero','{"ownership":"Business","status":"Available","qty":1,"costPrice":12}',1),
      ('card-nonsale','{"ownership":"Business","status":"Available","qty":1,"costPrice":10}',1),
      ('card-approval','{"name":"approval-binding-candidate","set":"Synthetic Set","number":"940","language":"EN","variant":"Normal","ownership":"Business","status":"Available","qty":1,"costPrice":10}',1),
      ('card-atomic','{"ownership":"Business","status":"Available","qty":1,"costPrice":10}',1),
      ('card-rollback','{"ownership":"Business","status":"Available","qty":1}',1),
      ('card-forged','{"ownership":"Business","status":"Available","qty":1,"costPrice":12}',1);`);

    await t.test('all Dealer and security-definer helpers deny public execution', () => {
      const rows = sql(container, `select p.oid::regprocedure || '|' || p.prosecdef || '|' || has_function_privilege('anon', p.oid, 'EXECUTE') || '|' || has_function_privilege('authenticated', p.oid, 'EXECUTE')
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public'
          and (p.prosecdef or p.proname like 'dealer_%' or p.proname like 'collectibles_dealer_%')
        order by p.oid::regprocedure;`).split('\n').filter(Boolean);
      assert.ok(rows.length > 0);
      const publicHelpers = [];
      for (const row of rows) {
        const [name, securityDefiner, anonExec, authenticatedExec] = row.split('|');
        if (anonExec !== 'false' || authenticatedExec !== 'false') {
          publicHelpers.push(`${name} security_definer=${securityDefiner} anon=${anonExec} authenticated=${authenticatedExec}`);
        }
      }
      assert.deepEqual(publicHelpers, [], `functions executable by anon or authenticated: ${publicHelpers.join(', ')}`);
      const direct = maybeSql(container, `select public.collectibles_dealer_command_v1('${JSON.stringify(request('create_candidate', '00000000-0000-4000-8000-000000000901', {}, { candidateId: 'anon' })).replaceAll("'", "''")}'::jsonb);`, 'anon');
      assert.notEqual(direct.status, 0, direct.stderr + direct.stdout);
    });

    await t.test('protected nested fields and derived output cannot be forged', () => {
      const blocked = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000902', {}, {
        candidateId: 'protected-candidate',
        ownership: 'Business',
        identity: { name: 'card', candidateId: 'forged', row_version: 99, owner_user_id: OTHER_OWNER }
      }));
      assert.equal(blocked.ok, false);
      assert.equal(blocked.code, 'protected_property');

      const blockedTopLevel = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000905', {}, {
        candidateId: 'protected-top-level', id: 'forged-id', owner_user_id: OTHER_OWNER, row_version: 99,
        updated_at: '2099-01-01T00:00:00Z'
      }));
      assert.equal(blockedTopLevel.ok, false);
      assert.equal(blockedTopLevel.code, 'unknown_property');

      const created = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000903', {}, {
        candidateId: 'serialised-candidate',
        ownership: 'Business',
        status: 'Draft',
        title: 'safe'
      }));
      assert.equal(created.ok, true, JSON.stringify(created));
      const candidate = created.result.candidate;
      assert.equal(candidate.id, 'serialised-candidate');
      assert.equal(candidate.data.candidateId, 'serialised-candidate');
      assert.equal(candidate.row_version, 1);
      assert.equal(candidate.data.owner_user_id, undefined);

      const protectedPatch = command(container, request('update_candidate', '00000000-0000-4000-8000-000000000904', { candidate: 1 }, {
        candidateId: 'serialised-candidate',
        patch: { id: 'forged-id', owner_user_id: OTHER_OWNER, row_version: 77, updated_at: '2099-01-01T00:00:00Z' }
      }));
      assert.equal(protectedPatch.ok, false);
      assert.equal(protectedPatch.code, 'protected_property');
      const persisted = JSON.parse(sql(container, "select data from public.dealer_records where entity_type='candidate' and id='serialised-candidate';"));
      assert.equal(persisted.id, undefined);
      assert.equal(persisted.owner_user_id, undefined);
      assert.equal(persisted.row_version, undefined);

      const plan = makeCandidate(container, 'non-sale-candidate', 910);
      const linked = linkCopy(container, 'non-sale-candidate', 913, 'card-nonsale');
      assert.equal(linked.ok, true, JSON.stringify(linked));
      const nonSale = command(container, request('record_non_sale', '00000000-0000-4000-8000-000000000914', { candidate: 3 }, {
        copyId: 'non-sale-candidate-copy-1',
        paymentStatus: 'Settled',
        actual: 'Settled',
        reason: { type: 'returned' }
      }));
      assert.equal(nonSale.ok, false, JSON.stringify(nonSale));
      assert.ok(['unknown_property', 'protected_property'].includes(nonSale.code), JSON.stringify(nonSale));
      assert.equal(sql(container, "select count(*) from public.dealer_records where entity_type='outcome' and id='00000000-0000-4000-8000-000000000914';"), '0');
      assert.equal(plan.candidate.data.status, 'Buy approved');
    });

    await t.test('command payloads reject fields owned by another command', () => {
      const rejected = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000919', {}, {
        candidateId: 'wrong-command-field', ownership: 'Business', proceeds: '10.00'
      }));
      assert.equal(rejected.ok, false);
      assert.equal(rejected.code, 'unknown_property');
    });

    await t.test('receipt replay is checked before the current version', () => {
      makeCandidate(container, 'idempotent-candidate', 915);
      const body = request('update_candidate', '00000000-0000-4000-8000-000000000918', { candidate: 2 }, {
        candidateId: 'idempotent-candidate', patch: { notes: 'first write' }
      });
      const first = command(container, body);
      assert.equal(first.ok, true, JSON.stringify(first));
      const replay = command(container, body);
      assert.deepEqual(replay, first);
      const reused = command(container, { ...body, payload: { candidateId: 'idempotent-candidate', patch: { notes: 'different write' } } });
      assert.equal(reused.ok, false);
      assert.equal(reused.code, 'mutation_id_reused');
    });

    await t.test('approved plans require explicit pre-acquisition revision and freeze after acquisition', () => {
      const approved = makeCandidate(container, 'plan-candidate', 920);
      const missingRevision = command(container, request('create_plan', '00000000-0000-4000-8000-000000000922', { candidate: 2 }, {
        candidateId: 'plan-candidate',
        planId: 'plan-candidate-plan-missing-revision',
        plan: {
          reason: 'unapproved silent replacement', expectedSaleAmount: '35.00', expectedSellingFee: '1.00',
          expectedOutboundShipping: '2.00', expectedRefundAllowance: '1.00', otherExpectedDeductions: '0.00',
          targetContribution: '5.00', riskAllowance: '0.00', knownNonItemAcquisitionCosts: '2.00',
          plannedItemCost: '10.00', reportingCurrency: 'SGD'
        }
      }));
      assert.equal(missingRevision.ok, false, JSON.stringify(missingRevision));
      assert.equal(missingRevision.code, 'plan_revision_reason_required');
      const revised = command(container, request('create_plan', '00000000-0000-4000-8000-000000000923', { candidate: 2 }, {
        candidateId: 'plan-candidate',
        planId: 'plan-candidate-plan-2',
        revisionReason: 'changed source evidence',
        supersedesPlanId: 'plan-candidate-plan-1',
        plan: {
          reason: 'revised', expectedSaleAmount: '35.00', expectedSellingFee: '1.00',
          expectedOutboundShipping: '2.00', expectedRefundAllowance: '1.00', otherExpectedDeductions: '0.00',
          targetContribution: '5.00', riskAllowance: '0.00', knownNonItemAcquisitionCosts: '2.00',
          plannedItemCost: '10.00', reportingCurrency: 'SGD'
        }
      }));
      assert.equal(revised.ok, true, JSON.stringify(revised));
      const secondApproval = command(container, request('approve_buy', '00000000-0000-4000-8000-000000000924', { candidate: 2, plan: 1 }, {
        candidateId: 'plan-candidate',
        planId: 'plan-candidate-plan-2',
        approval: { reason: 'reapproved' },
        supersedesPlanId: 'plan-candidate-plan-1'
      }));
      assert.equal(secondApproval.ok, true, JSON.stringify(secondApproval));
      assert.equal(secondApproval.result.candidate.data.approvedPlanId, 'plan-candidate-plan-2');
      const linked = linkCopy(container, 'plan-candidate', 926, 'card-plan', {}, 3, 1);
      assert.equal(linked.ok, true, JSON.stringify(linked));
      const relabelAfterAcquisition = command(container, request('update_candidate', '00000000-0000-4000-8000-000000009268', { candidate: linked.result.candidate.row_version }, {
        candidateId: 'plan-candidate', patch: { name: 'Relabelled after acquisition' }
      }));
      assert.equal(relabelAfterAcquisition.ok, false, JSON.stringify(relabelAfterAcquisition));
      assert.equal(relabelAfterAcquisition.code, 'frozen_candidate');
      assert.equal(sql(container, "select data->>'name' from public.singles where id='card-plan';"), 'plan-candidate');
      const afterAcquisition = command(container, request('create_plan', '00000000-0000-4000-8000-000000000927', { candidate: 4 }, {
        candidateId: 'plan-candidate',
        planId: 'plan-candidate-plan-3',
        revisionReason: 'late replacement attempt',
        supersedesPlanId: 'plan-candidate-plan-2',
        plan: {
          reason: 'late replacement attempt', expectedSaleAmount: '35.00', expectedSellingFee: '1.00',
          expectedOutboundShipping: '2.00', expectedRefundAllowance: '1.00', otherExpectedDeductions: '0.00',
          targetContribution: '5.00', riskAllowance: '0.00', knownNonItemAcquisitionCosts: '2.00',
          plannedItemCost: '10.00', reportingCurrency: 'SGD'
        }
      }));
      assert.equal(afterAcquisition.ok, false, JSON.stringify(afterAcquisition));
      assert.equal(afterAcquisition.code, 'plan_revision_blocked');
    });

    await t.test('approved candidate basis stays frozen while evidence append remains recoverable', () => {
      const approved = makeCandidate(container, 'approval-binding-candidate', 940);
      const protectedBasis = command(container, request('update_candidate', '00000000-0000-4000-8000-000000009410', { candidate: 2 }, {
        candidateId: 'approval-binding-candidate',
        patch: {
          name: 'Relabelled after approval', condition: 'Damaged', ownership: 'Personal', grading: { grade: '1' }
        }
      }));
      assert.equal(protectedBasis.ok, false, JSON.stringify(protectedBasis));
      assert.equal(protectedBasis.code, 'frozen_candidate');

      const evidenceAppend = command(container, request('add_evidence', '00000000-0000-4000-8000-000000009411', { candidate: approved.candidate.row_version }, {
        candidateId: 'approval-binding-candidate',
        evidenceId: 'approval-binding-evidence-2',
        evidence: {
          class: 'source', source: 'synthetic://additional-after-approval', match: 'Exact', confidence: 'High', rationale: 'Additional evidence after approval', observedAt: '2026-09-26T00:00:00+08:00'
        }
      }));
      assert.equal(evidenceAppend.ok, true, JSON.stringify(evidenceAppend));
      const linked = linkCopy(container, 'approval-binding-candidate', 9412, 'card-approval', {}, approved.candidate.row_version, 1);
      assert.equal(linked.ok, true, JSON.stringify(linked));
    });

    await t.test('duplicate physical copy and duplicate sale are rejected', () => {
      const approved = makeCandidate(container, 'sale-candidate', 930);
      const first = linkCopy(container, 'sale-candidate', 933, 'card-sale');
      assert.equal(first.ok, true, JSON.stringify(first));
      const duplicateCopy = command(container, request('link_copy', '00000000-0000-4000-8000-000000000934', { candidate: 3, canonical: 2 }, {
        candidateId: 'sale-candidate', copyId: 'sale-candidate-copy-2', inventoryTable: 'singles', inventoryId: 'card-sale',
        reviewedCost: { confirmed: true, currency: 'SGD', itemCost: '10.00' }
      }));
      assert.equal(duplicateCopy.ok, false);
      assert.ok(['state_conflict', 'canonical_already_linked'].includes(duplicateCopy.code), JSON.stringify(duplicateCopy));

      const sale = command(container, request('record_sale', '00000000-0000-4000-8000-000000000935', { candidate: 3, canonical: 2 }, {
        candidateId: 'sale-candidate', copyId: 'sale-candidate-copy-1', saleId: 'sale-candidate-sale-1', outcomeId: 'sale-candidate-outcome-1', agreedAmount: '20.00', currency: 'SGD'
      }));
      assert.equal(sale.ok, true, JSON.stringify(sale));
      const duplicateSale = command(container, request('record_sale', '00000000-0000-4000-8000-000000000936', { candidate: 4, canonical: 3 }, {
        candidateId: 'sale-candidate', copyId: 'sale-candidate-copy-1', saleId: 'sale-candidate-sale-2', outcomeId: 'sale-candidate-outcome-2', agreedAmount: '20.00', currency: 'SGD'
      }));
      assert.equal(duplicateSale.ok, false);
      assert.equal(duplicateSale.code, 'sale_already_recorded');
      assert.equal(approved.candidate.data.status, 'Buy approved');
    });

    await t.test('negative amounts and inherited cost overrides are rejected', () => {
      const negativePlan = command(container, request('create_candidate', '00000000-0000-4000-8000-000000000940', {}, { candidateId: 'negative-plan', ownership: 'Business', status: 'Draft' }));
      assert.equal(negativePlan.ok, true, JSON.stringify(negativePlan));
      const plan = command(container, request('create_plan', '00000000-0000-4000-8000-000000000941', { candidate: 1 }, { candidateId: 'negative-plan', planId: 'negative-plan-1', plan: {
        reason: 'negative amount rejection', expectedSaleAmount: '35.00', expectedSellingFee: '1.00',
        expectedOutboundShipping: '2.00', expectedRefundAllowance: '1.00', otherExpectedDeductions: '0.00',
        targetContribution: '5.00', riskAllowance: '0.00', knownNonItemAcquisitionCosts: '2.00',
        plannedItemCost: '-1.00', reportingCurrency: 'SGD'
      } }));
      assert.equal(plan.ok, false);
      assert.equal(plan.code, 'invalid_money');

      const approved = makeCandidate(container, 'inherit-candidate', 942, '10.00');
      const linked = linkCopy(container, 'inherit-candidate', 945, 'card-forged', { confirmed: true, currency: 'SGD', itemCost: '12.00' });
      assert.equal(linked.ok, true, JSON.stringify(linked));
      const sale = command(container, request('record_sale', '00000000-0000-4000-8000-000000000946', { candidate: 3, canonical: 2 }, { candidateId: 'inherit-candidate', copyId: 'inherit-candidate-copy-1', saleId: 'inherit-sale-1', outcomeId: 'inherit-outcome-1', agreedAmount: '20.00', currency: 'SGD' }));
      assert.equal(sale.ok, true, JSON.stringify(sale));
      const settle = command(container, request('settle_sale', '00000000-0000-4000-8000-000000000947', { outcome: 1, sale: 1 }, { outcomeId: 'inherit-outcome-1', cashSettledAt: '2026-09-25T10:00:00Z', settlementEvidence: { class: 'manual', proof: 'synthetic receipt', date: '2026-09-25' }, proceeds: '20.00', canonicalLandedCost: '11.00' }));
      assert.equal(settle.ok, false);
      assert.ok(['cost_basis_conflict', 'cost_basis_override_forbidden', 'unknown_property'].includes(settle.code), JSON.stringify(settle));
      assert.equal(approved.candidate.data.status, 'Buy approved');

      const negativeFlow = makeCandidate(container, 'negative-flow', 948);
      const negativeLink = linkCopy(container, 'negative-flow', 951, 'card-negative', { confirmed: true, currency: 'SGD', itemCost: '12.00' });
      assert.equal(negativeLink.ok, true, JSON.stringify(negativeLink));
      const negativeSale = command(container, request('record_sale', '00000000-0000-4000-8000-000000000952', { candidate: 3, canonical: 2 }, { candidateId: 'negative-flow', copyId: 'negative-flow-copy-1', saleId: 'negative-sale-1', outcomeId: 'negative-outcome-1', agreedAmount: '-1.00', currency: 'SGD' }));
      assert.equal(negativeSale.ok, false);
      assert.equal(negativeSale.code, 'invalid_money');
      assert.equal(negativeFlow.candidate.data.status, 'Buy approved');

      const zeroFlow = makeCandidate(container, 'zero-flow', 964);
      const zeroLink = linkCopy(container, 'zero-flow', 967, 'card-zero', { confirmed: true, currency: 'SGD', itemCost: '12.00' });
      assert.equal(zeroLink.ok, true, JSON.stringify(zeroLink));
      const zeroSale = command(container, request('record_sale', '00000000-0000-4000-8000-000000000968', { candidate: 3, canonical: 2 }, { candidateId: 'zero-flow', copyId: 'zero-flow-copy-1', saleId: 'zero-sale-1', outcomeId: 'zero-outcome-1', agreedAmount: '0.00', currency: 'SGD' }));
      assert.equal(zeroSale.ok, true, JSON.stringify(zeroSale));
      const zeroSettle = command(container, request('settle_sale', '00000000-0000-4000-8000-000000000969', { outcome: 1, sale: 1 }, { outcomeId: 'zero-outcome-1', cashSettledAt: '2026-09-25T10:00:00Z', settlementEvidence: { class: 'manual', proof: 'synthetic zero receipt', date: '2026-09-25' }, proceeds: '0.00', sellingFee: '0.00', outboundShipping: '0.00' }));
      assert.equal(zeroSettle.ok, true, JSON.stringify(zeroSettle));
      assert.equal(zeroSettle.result.outcome.data.paymentStatus, 'Settled');
      assert.equal(Number(zeroSettle.result.outcome.data.dealerActual.proceeds), 0);
    });

    await t.test('cross-currency metadata survives acquisition and settlement', () => {
      const approved = makeCandidate(container, 'fx-candidate', 980);
      const linked = linkCopy(container, 'fx-candidate', 983, 'card-fx', { confirmed: true, currency: 'JPY', itemCost: '1000', settledItemCost: '10.00' }, 2, 1);
      assert.equal(linked.ok, false, `test payload intentionally omits nested FX provenance: ${JSON.stringify(linked)}`);
      assert.equal(linked.code, 'fx_metadata_required');

      const linkedWithPayloadFx = command(container, request('link_copy', '00000000-0000-4000-8000-000000000984', { candidate: 2, canonical: 1 }, {
        candidateId: 'fx-candidate', copyId: 'fx-candidate-copy-1', inventoryTable: 'singles', inventoryId: 'card-fx',
        reviewedCost: { confirmed: true, currency: 'JPY', itemCost: '1000', settledItemCost: '10.00', settledNonItemAcquisitionCosts: '0.00', settledAmount: '10.00', reason: 'Synthetic foreign cost review', reviewedAt: '2026-09-25T00:00:00+08:00', fx: { base: 'JPY', quote: 'SGD', rate: '0.01', source: 'synthetic-rate', observedAt: '2026-09-25T10:00:00Z' } }
      }));
      assert.equal(linkedWithPayloadFx.ok, true, JSON.stringify(linkedWithPayloadFx));
      const cost = linkedWithPayloadFx.result.copy.data.costComponent;
      assert.equal(cost.fx.base, 'JPY');
      assert.equal(cost.fx.quote, 'SGD');
      assert.equal(cost.fx.rate, 0.01);
      assert.equal(cost.fx.source, 'synthetic-rate');
    });

    await t.test('cross-currency settlement stores conversion provenance', () => {
      makeCandidate(container, 'fx-settle-candidate', 990);
      const linked = linkCopy(container, 'fx-settle-candidate', 993, 'card-fx-settle', { confirmed: true, currency: 'SGD', itemCost: '10.00' });
      assert.equal(linked.ok, true, JSON.stringify(linked));
      const sale = command(container, request('record_sale', '00000000-0000-4000-8000-000000000994', { candidate: 3, canonical: 2 }, { candidateId: 'fx-settle-candidate', copyId: 'fx-settle-candidate-copy-1', saleId: 'fx-settle-sale-1', outcomeId: 'fx-settle-outcome-1', agreedAmount: '20.00', currency: 'EUR' }));
      assert.equal(sale.ok, true, JSON.stringify(sale));
      const settled = command(container, request('settle_sale', '00000000-0000-4000-8000-000000000995', { outcome: 1, sale: 1 }, { outcomeId: 'fx-settle-outcome-1', settlementCurrency: 'SGD', fx: { base: 'EUR', quote: 'SGD', rate: '1.50', source: 'synthetic-rate', observedAt: '2026-09-25T10:00:00Z' }, cashSettledAt: '2026-09-25T10:00:00Z', settlementEvidence: { class: 'manual', proof: 'synthetic FX receipt', date: '2026-09-25' }, proceeds: '30.00', sellingFee: '0.00', outboundShipping: '0.00' }));
      assert.equal(settled.ok, true, JSON.stringify(settled));
      assert.equal(settled.result.outcome.data.settlementFx.base, 'EUR');
      assert.equal(settled.result.outcome.data.settlementFx.quote, 'SGD');
      assert.equal(settled.result.outcome.data.settlementFx.rate, 1.5);
      assert.equal(settled.result.outcome.data.settlementFx.source, 'synthetic-rate');
      assert.equal(settled.result.outcome.data.settlementFx.observedAt, '2026-09-25T10:00:00Z');
    });

    await t.test('late command failure rolls back every earlier write', () => {
      const approved = makeCandidate(container, 'atomic-candidate', 955);
      const linked = linkCopy(container, 'atomic-candidate', 958, 'card-atomic');
      assert.equal(linked.ok, true, JSON.stringify(linked));
      sql(container, `create or replace function public.synthetic_fail_sale_insert() returns trigger language plpgsql as $$ begin if new.id='atomic-sale-1' then raise exception 'synthetic late failure'; end if; return new; end; $$;
        create trigger synthetic_fail_sale_insert before insert on public.sales for each row execute function public.synthetic_fail_sale_insert();`);
      const failed = command(container, request('record_sale', '00000000-0000-4000-8000-000000000959', { candidate: 3, canonical: 2 }, {
        candidateId: 'atomic-candidate', copyId: 'atomic-candidate-copy-1', saleId: 'atomic-sale-1', outcomeId: 'atomic-outcome-1', agreedAmount: '20.00', currency: 'SGD'
      }));
      sql(container, 'drop trigger synthetic_fail_sale_insert on public.sales; drop function public.synthetic_fail_sale_insert();');
      assert.equal(failed.ok, false);
      assert.equal(failed.code, 'dealer_command_failed');
      assert.equal(sql(container, "select data->>'status' from public.singles where id='card-atomic';"), 'Available');
      assert.equal(sql(container, "select row_version from public.singles where id='card-atomic';"), '2');
      assert.equal(sql(container, "select count(*) from public.dealer_records where id in ('atomic-outcome-1','atomic-sale-1');"), '0');
      assert.equal(sql(container, "select count(*) from public.dealer_command_receipts where command_id='00000000-0000-4000-8000-000000000959';"), '0');
      assert.equal(approved.candidate.data.status, 'Buy approved');
    });

    await t.test('CAS forged markers, restore, and rollback remain blocked', () => {
      const forged = cas(container, { client_protocol: 2, mutation_id: '00000000-0000-4000-8000-000000000960', operations: [{ type: 'upsert', table: 'singles', id: 'card-forged', expected_version: 1, data: { status: 'Available', dealerOwnerId: OWNER } }] });
      assert.equal(forged.ok, false);
      assert.equal(forged.code, 'dealer_controlled_row');

      const deleted = cas(container, { client_protocol: 2, mutation_id: '00000000-0000-4000-8000-000000000961', operations: [{ type: 'delete', table: 'singles', id: 'card-rollback', expected_version: 1, trash: { id: 'trash-rollback', data: { originalTable: 'singles', originalId: 'card-rollback', item: { name: 'Rollback card', ownership: 'Business', status: 'Available', qty: 1 } } } }] });
      assert.equal(deleted.ok, true, JSON.stringify(deleted));
      const restoreForged = cas(container, { client_protocol: 2, mutation_id: '00000000-0000-4000-8000-000000000962', operations: [{ type: 'restore', table: 'singles', id: 'card-rollback', expected_version: 0, tombstone_version: 2, trash_id: 'trash-rollback', data: { name: 'Rollback card', ownership: 'Business', status: 'Available', qty: 1, dealerCopyId: 'forged' } }] });
      assert.equal(restoreForged.ok, false);
      assert.equal(restoreForged.code, 'dealer_controlled_row');

      const rollback = cas(container, { client_protocol: 2, mutation_id: '00000000-0000-4000-8000-000000000963', operations: [
        { type: 'upsert', table: 'singles', id: 'rollback-new', expected_version: 0, data: { name: 'must rollback' } },
        { type: 'upsert', table: 'singles', id: 'card-forged', expected_version: 99, data: { status: 'Available' } }
      ] });
      assert.equal(rollback.ok, false);
      assert.equal(sql(container, "select count(*) from public.singles where id='rollback-new';"), '0');
    });

    await t.test('Worker injects authenticated owner and rejects caller owner fields', async () => {
      const originalFetch = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/auth/v1/user')) return new Response(JSON.stringify({ id: OWNER }), { status: 200, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      try {
        const body = { client_protocol: 2, schema_version: 1, command_id: '00000000-0000-4000-8000-000000000970', command: 'create_candidate', payload: { candidateId: 'worker-candidate' } };
        const response = await worker.fetch(new Request('https://worker.invalid/sync/v2/dealer/command', { method: 'POST', headers: { Origin: 'https://julianchow21.github.io', Authorization: 'Bearer synthetic-session' }, body: JSON.stringify(body) }), { SUPABASE_URL: 'https://supabase.invalid', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_KEY: 'synthetic-service', COLLECTIBLES_OWNER_USER_ID: OWNER });
        assert.equal(response.status, 200);
        const forwarded = JSON.parse(calls[1].init.body).p_request;
        assert.equal(forwarded.owner_user_id, OWNER);
        assert.equal(forwarded.payload.candidateId, 'worker-candidate');
        const callerOwner = { ...body, owner_user_id: OTHER_OWNER, command_id: '00000000-0000-4000-8000-000000000971' };
        const rejected = await worker.fetch(new Request('https://worker.invalid/sync/v2/dealer/command', { method: 'POST', headers: { Origin: 'https://julianchow21.github.io', Authorization: 'Bearer synthetic-session' }, body: JSON.stringify(callerOwner) }), { SUPABASE_URL: 'https://supabase.invalid', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_KEY: 'synthetic-service', COLLECTIBLES_OWNER_USER_ID: OWNER });
        assert.equal(rejected.status, 400);
        assert.equal((await rejected.json()).code, 'invalid_request');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  } finally {
    if (running) spawnSync('docker', ['rm', '--force', container], { encoding: 'utf8' });
  }
});
