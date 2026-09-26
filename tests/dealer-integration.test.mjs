import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DealerStore = require('../dealer-store.js');
const DealerMoney = require('../dealer-money.js');
const { loadApp } = require('./harness.js');
require('../dealer-production-ui.js');
const DealerProductionUI = globalThis.DealerProductionUI;

globalThis.caches = { default: { match: async () => null, put: async () => {} } };
const workerSource = fs.readFileSync(new URL('../Server/worker.js', import.meta.url), 'utf8');
const worker = (await import('data:text/javascript;base64,' + Buffer.from(workerSource).toString('base64'))).default;

const RUN = process.env.KJ_DEALER_RUN_DOCKER === '1';
const IMAGE = 'postgres:17-alpine';
const OWNER = '00000000-0000-4000-8000-000000000001';
const SKIP = RUN ? false : 'set KJ_DEALER_RUN_DOCKER=1 to run the Worker to PostgreSQL bridge';
const ORIGIN = 'https://julianchow21.github.io';
const ENV_KEYS = {
  SUPABASE_ANON_KEY: 'synthetic-anon',
  SUPABASE_SERVICE_KEY: 'synthetic-service',
  COLLECTIBLES_OWNER_USER_ID: OWNER
};

function docker(args, input = '') {
  const result = spawnSync('docker', args, { input, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  return result.stdout.trim();
}

function maybeSql(container, statement, role = 'postgres') {
  const roleSql = role === 'postgres' ? '' : `set role ${role};\n`;
  return spawnSync('docker', [
    'exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
    '-U', 'postgres', '-d', 'postgres', '-At', '-q'
  ], { input: roleSql + statement, encoding: 'utf8' });
}

function sql(container, statement, role = 'postgres') {
  const result = maybeSql(container, statement, role);
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  return result.stdout.trim();
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

function startPostgres(container) {
  const supervisor = [
    'set -eu',
    'mkdir -p /var/lib/postgresql/data /var/run/postgresql',
    'chown -R postgres:postgres /var/lib/postgresql/data /var/run/postgresql',
    "if [ ! -s /var/lib/postgresql/data/PG_VERSION ]; then su postgres -s /bin/sh -c 'initdb -D /var/lib/postgresql/data -A trust --no-locale'; fi",
    "while :; do su postgres -s /bin/sh -c 'postgres -D /var/lib/postgresql/data -k /var/run/postgresql' & server_pid=$!; wait $server_pid; sleep 0.1; done"
  ].join('; ');
  docker([
    'run', '--pull=never', '--detach', '--rm', '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data', '--tmpfs', '/tmp', '--name', container,
    '--entrypoint', '/bin/sh', IMAGE, '-c', supervisor
  ]);
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
    ('bridge-card','{"name":"Bridge card","set":"Synthetic Set","number":"001","language":"EN","variant":"Normal","ownership":"Business","status":"Available","qty":1,"costPrice":"20.00","nonItemAcquisitionCosts":"2.00"}',1);`);
}

function commandId(number) {
  return '00000000-0000-4000-8000-' + String(number).padStart(12, '0');
}

function quoteJson(value) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function rpc(container, functionName, body, role = 'service_role') {
  return JSON.parse(sql(container, `select public.${functionName}('${quoteJson(body)}'::jsonb);`, role));
}

function tryRpc(container, functionName, body, role = 'service_role') {
  try {
    return { ok: true, value: rpc(container, functionName, body, role) };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error).split('\n')[0] };
  }
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function sendJson(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  response.end(text);
}

async function startPostgrestShim(container) {
  const calls = [];
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/auth/v1/user') {
        sendJson(response, 200, { id: OWNER });
        return;
      }
      if (request.method !== 'POST' || !request.url.startsWith('/rest/v1/rpc/')) {
        sendJson(response, 404, { code: 'PGRST404' });
        return;
      }
      assert.equal(request.headers.apikey, ENV_KEYS.SUPABASE_SERVICE_KEY);
      assert.equal(request.headers.authorization, 'Bearer ' + ENV_KEYS.SUPABASE_SERVICE_KEY);
      const body = JSON.parse(await readRequest(request));
      assert.ok(body && body.p_request && typeof body.p_request === 'object');
      assert.equal(body.p_request.owner_user_id, OWNER);
      calls.push({ url: request.url, body: body.p_request });
      if (request.url.endsWith('/collectibles_dealer_pull_v1')) {
        sendJson(response, 200, rpc(container, 'collectibles_dealer_pull_v1', body.p_request));
        return;
      }
      if (request.url.endsWith('/collectibles_dealer_command_v1')) {
        sendJson(response, 200, rpc(container, 'collectibles_dealer_command_v1', body.p_request));
        return;
      }
      sendJson(response, 404, { code: 'PGRST202' });
    } catch (error) {
      sendJson(response, 500, { code: 'PGRST500', detail: error.message });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { server, calls, url: `http://127.0.0.1:${address.port}` };
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function workerRequest(path, body, token = 'synthetic-session') {
  return new Request('https://worker.example' + path, {
    method: 'POST',
    headers: { Origin: ORIGIN, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function workerJson(path, body, env) {
  const response = await worker.fetch(workerRequest(path, body), env);
  return { response, body: await response.json() };
}

function selectedRecord(store) {
  const view = store.view();
  const snapshot = view.snapshot;
  const candidate = snapshot && snapshot.selectedCandidate;
  if (!candidate) return null;
  return Object.assign({}, candidate, {
    __dealerDetail: snapshot.selectedDetail || null,
    __dealerCanonicalRefs: snapshot.canonicalRefs || []
  });
}

function renderProductionSnapshot(store, candidateId) {
  const root = {
    innerHTML: '',
    addEventListener() {},
    contains() { return true; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const controller = DealerProductionUI.createController({ root, store });
  controller.state.selectedId = String(candidateId);
  controller.render();
  return root.innerHTML;
}

async function refreshRecord(store, candidateId) {
  const result = await store.pull({ limit: 50, candidateId });
  assert.equal(result.ok, true, JSON.stringify(result));
  const record = selectedRecord(store);
  assert.ok(record, 'the server must return the selected candidate');
  return record;
}

test('real Worker RPC and DealerStore drive the typed journey against disposable PostgreSQL', { skip: SKIP }, async () => {
  const container = `kjr-dealer-bridge-${process.pid}-${Date.now()}`;
  let running = false;
  let shim;
  try {
    const contractFailures = [];
    const expectContract = (actual, expected, label) => {
      if (!Object.is(actual, expected)) contractFailures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    };
    const pa18Fx = {
      base: 'USD', quote: 'SGD', rate: '1.35',
      source: 'synthetic://pa18-fx', observedAt: '2026-09-25T10:00:00Z'
    };
    const pa18 = DealerMoney.calculateExpectedEconomics({
      expectedSaleAmount: { amount: '100.00', currency: 'USD', status: 'Estimate', effect: 'credit', type: 'proceeds', fx: pa18Fx },
      sellingFee: '0', outboundShipping: '0', expectedRefundAllowance: '0', otherExpectedDeductions: '0',
      targetContribution: '0', riskAllowance: '0', knownNonItemAcquisitionCosts: '0'
    });
    expectContract(pa18.expectedNetProceeds, '135.00', 'PA-18 local USD to SGD');
    const pa18Inverse = DealerMoney.convertLine({ amount: '135.00', currency: 'SGD', status: 'Estimate', effect: 'debit', type: 'item_price', fx: pa18Fx }, { reportingCurrency: 'USD' });
    expectContract(pa18Inverse.convertedAmount, '100.00', 'PA-18 local inverse FX');
    const pa18Lines = DealerMoney.convertLines(['33.33', '33.33', '33.34'].map((amount, index) => ({
      id: `pa18-${index}`, amount, currency: 'USD', status: 'Estimate', effect: 'debit', type: 'item_price', fx: pa18Fx
    })));
    expectContract(pa18Lines.total, '135.00', 'PA-18 local converted total');
    expectContract(pa18Lines.residualAdjustment && pa18Lines.residualAdjustment.amount, '0.01', 'PA-18 named residual');
    const exactCeiling = DealerMoney.calculateExpectedEconomics({
      expectedSaleAmount: '10.009', sellingFee: '0', outboundShipping: '0', expectedRefundAllowance: '0',
      otherExpectedDeductions: '0', targetContribution: '0', riskAllowance: '0', knownNonItemAcquisitionCosts: '0'
    });
    expectContract(exactCeiling.maximumAllInAcquisitionCost, '10.009', 'local exact ceiling');
    expectContract(exactCeiling.maximumAllInAcquisitionCostRounded, '10.00', 'local floored ceiling');
    expectContract(exactCeiling.itemPriceCeiling, '10.00', 'local item ceiling');
    startPostgres(container);
    running = true;
    shim = await startPostgrestShim(container);
    const serverPa18 = tryRpc(container, 'dealer_plan_economics', {
      expectedSaleAmount: { amount: '100.00', currency: 'USD', fx: pa18Fx },
      sellingFee: '0.00', outboundShipping: '0.00', expectedRefundAllowance: '0.00',
      otherDeductions: '0.00', targetContribution: '0.00', riskAllowance: '0.00',
      knownNonItemAcquisitionCosts: '0.00'
    }, 'postgres');
    if (!serverPa18.ok) {
      contractFailures.push('PA-18 server economics raised ' + serverPa18.error);
    } else {
      expectContract(serverPa18.value.status, 'Known', 'PA-18 server status');
      expectContract(Number(serverPa18.value.expectedSaleAmount), 135, 'PA-18 server USD to SGD');
      expectContract(Number(serverPa18.value.expectedNetProceeds), 135, 'PA-18 server net proceeds');
    }
    const serverCeiling = tryRpc(container, 'dealer_plan_economics', {
      expectedSaleAmount: '10.009', sellingFee: '0.00', outboundShipping: '0.00', expectedRefundAllowance: '0.00',
      otherDeductions: '0.00', targetContribution: '0.00', riskAllowance: '0.00', knownNonItemAcquisitionCosts: '0.00'
    }, 'postgres');
    if (!serverCeiling.ok) {
      contractFailures.push('server exact ceiling raised ' + serverCeiling.error);
    } else {
      expectContract(serverCeiling.value.status, 'Known', 'server exact ceiling status');
      expectContract(String(serverCeiling.value.maximumAllInAcquisitionCost), '10.009', 'server exact ceiling');
      expectContract(Number(serverCeiling.value.maximumAllInAcquisitionCostRounded), 10, 'server floored ceiling');
      expectContract(Number(serverCeiling.value.itemPriceCeiling), 10, 'server item ceiling');
    }
    const env = {
      SUPABASE_URL: shim.url,
      ...ENV_KEYS
    };
    const context = { authenticated: true, verified: true, userId: OWNER, sessionId: 'bridge-session', generation: 1, offline: false };
    const transport = {
      pull: async request => (await workerJson('/sync/v2/dealer/pull', request.body, env)).body,
      command: async request => (await workerJson('/sync/v2/dealer/command', request.body, env)).body
    };
    const store = DealerStore.create({ ownerContext: () => context, storage: null, transport });
    await store.init();
    const initial = await store.pull({ limit: 50 });
    assert.equal(initial.ok, true, JSON.stringify(initial));
    assert.deepEqual(initial.snapshot.candidates, []);

    const forged = await workerJson('/sync/v2/dealer/command', {
      client_protocol: 2,
      schema_version: 1,
      command_id: commandId(1),
      command: 'create_candidate',
      expected: {},
      owner_user_id: 'forged-owner',
      payload: { candidateId: 'bridge-forged' }
    }, env);
    assert.equal(forged.response.status, 400);
    assert.equal(forged.body.code, 'invalid_request');
    assert.equal(shim.calls.length, 1, 'caller-owned identity fields must be stopped before RPC');

    const candidateId = 'bridge-candidate';
    const created = await store.command('create_candidate', {
      candidateId,
      name: 'Bridge card',
      set: 'Synthetic Set',
      number: '001',
      language: 'EN',
      variant: 'Normal',
      condition: 'Near mint',
      identity: { name: 'Bridge card', set: 'Synthetic Set', number: '001', language: 'EN', variant: 'Normal' },
      ownership: 'Business',
      ownershipReviewed: true,
      status: 'Draft'
    }, { commandId: commandId(2), expectedVersions: {} });
    assert.equal(created.ok, true, JSON.stringify(created));
    let record = await refreshRecord(store, candidateId);

    const evidencePayload = DealerProductionUI.stagePayload('add_evidence', record, {
      evidenceClass: 'identity', evidenceRef: 'synthetic://bridge-evidence', evidenceMatch: 'Exact',
      evidenceConfidence: 'High', evidenceRationale: 'Synthetic identity and ownership review', evidenceDate: '25/09/2026'
    });
    assert.deepEqual(evidencePayload.evidence, {
      class: 'identity', source: 'synthetic://bridge-evidence', match: 'Exact', confidence: 'High',
      rationale: 'Synthetic identity and ownership review', observedAt: '2026-09-25T00:00:00+08:00'
    });
    const evidence = await store.command('add_evidence', evidencePayload, {
      commandId: commandId(3), expectedVersions: DealerProductionUI.expectedVersions(record)
    });
    assert.equal(evidence.ok, true, JSON.stringify(evidence));
    record = await refreshRecord(store, candidateId);

    const economics = {
      reason: 'Synthetic economics with all required decision inputs',
      currency: 'SGD',
      expectedSaleAmount: '35.00',
      sellingFee: '1.00',
      outboundShipping: '2.00',
      refundAllowance: '1.00',
      otherDeductions: '0.00',
      targetContribution: '5.00',
      riskAllowance: '0.00',
      knownNonItemAcquisitionCosts: '2.00',
      plannedItemCost: '20.00',
      reportingCurrency: 'SGD'
    };
    const planOneId = 'bridge-candidate-plan-1';
    const planTwoId = 'bridge-candidate-plan-2';
    const planFields = {
      planReason: economics.reason, expectedSaleAmount: economics.expectedSaleAmount,
      expectedSellingFee: economics.sellingFee, expectedOutboundShipping: economics.outboundShipping,
      expectedRefundAllowance: economics.refundAllowance, otherExpectedDeductions: economics.otherDeductions,
      targetContribution: economics.targetContribution, riskAllowance: economics.riskAllowance,
      knownNonItemAcquisitionCosts: economics.knownNonItemAcquisitionCosts,
      plannedItemCost: economics.plannedItemCost, reportingCurrency: economics.reportingCurrency
    };
    const planPayload = Object.assign({}, DealerProductionUI.stagePayload('create_plan', record, planFields), { planId: planOneId });
    const plan = await store.command('create_plan', planPayload, {
      commandId: commandId(4),
      expectedVersions: DealerProductionUI.expectedVersions(record)
    });
    assert.equal(plan.ok, true, JSON.stringify(plan));
    record = await refreshRecord(store, candidateId);

    const approved = await store.command('approve_buy', DealerProductionUI.stagePayload('approve_buy', record, { planReason: economics.reason }), {
      commandId: commandId(5),
      expectedVersions: DealerProductionUI.expectedVersions(record)
    });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    record = await refreshRecord(store, candidateId);
    assert.equal(record.data.status, 'Buy approved');
    assert.equal(record.data.approvedPlanId, planOneId);

    const revisionPayload = Object.assign({}, DealerProductionUI.stagePayload('create_plan', record, Object.assign({}, planFields, { planReason: 'Fresh source evidence review' })), {
      planId: planTwoId,
      revisionReason: 'Fresh source evidence review',
      supersedesPlanId: planOneId
    });
    const revised = await store.command('create_plan', revisionPayload, {
      commandId: commandId(6),
      expectedVersions: { candidate: DealerProductionUI.expectedVersions(record).candidate }
    });
    assert.equal(revised.ok, true, JSON.stringify(revised));
    record = await refreshRecord(store, candidateId);
    const revisionPlan = record.__dealerDetail.plans.find(item => item.id === planTwoId);
    assert.ok(revisionPlan, 'the explicit pre-acquisition plan revision must be stored');
    const revisionApprovalPayload = Object.assign({}, DealerProductionUI.stagePayload('approve_buy', record, { planReason: 'Fresh source evidence review' }), {
      planId: planTwoId,
      supersedesPlanId: planOneId,
      approval: { reason: 'Fresh source evidence review' }
    });
    const revisionApproval = await store.command('approve_buy', revisionApprovalPayload, {
      commandId: commandId(7),
      expectedVersions: { candidate: DealerProductionUI.expectedVersions(record).candidate, plan: revisionPlan.row_version }
    });
    assert.equal(revisionApproval.ok, true, JSON.stringify(revisionApproval));
    record = await refreshRecord(store, candidateId);
    assert.equal(record.data.approvedPlanId, planTwoId);
    const serverPlan = record.__dealerDetail.plans.find(item => item.id === planTwoId);
    assert.equal(record.__dealerDetail.plans[0].id, planTwoId, 'pull returns the newest approved plan first');
    assert.equal(serverPlan.data.status, 'approved');
    assert.equal(serverPlan.data.supersedesPlanId, planOneId);
    assert.equal(serverPlan.data.revisionReason, 'Fresh source evidence review');

    const copyFields = {
      inventoryTable: 'singles', inventoryId: 'bridge-card', copyCost: '20.00', copyCurrency: 'SGD',
      inheritCost: 'true', inventoryVersion: '1', nonItemAcquisitionCosts: '2.00',
      copyCostReason: 'Synthetic reviewed canonical cost', copyCostDate: '25/09/2026',
      outcomeNotes: 'Synthetic reviewed canonical cost'
    };
    // The selected stock row is an existing canonical copy, so the production
    // journey must use link_copy. acquire_copy is reserved for a new canonical
    // row and correctly rejects an existing row.
    const acquirePayload = DealerProductionUI.stagePayload('link_copy', record, copyFields);
    assert.deepEqual(acquirePayload.reviewedCost, {
      confirmed: true,
      currency: 'SGD',
      itemCost: '20.00',
      reason: 'Synthetic reviewed canonical cost',
      reviewedAt: '2026-09-25T00:00:00+08:00',
      nonItemAcquisitionCosts: '2.00'
    });
    const acquireExpected = Object.assign({}, DealerProductionUI.expectedVersions(record), {
      canonical: Number(copyFields.inventoryVersion)
    });
    const acquired = await store.command('link_copy', acquirePayload, {
      commandId: commandId(8),
      expectedVersions: acquireExpected
    });
    assert.equal(acquired.ok, true, JSON.stringify({ acquired, acquireExpected, record }));
    record = await refreshRecord(store, candidateId);
    assert.equal(record.data.status, 'Acquired');
    assert.equal(record.data.approvedPlanId, planTwoId, 'acquisition must retain the frozen approved plan');
    const acquiredCost = record.__dealerDetail.copy[0].data.costComponent;
    assert.equal(record.__dealerDetail.copy[0].data.approvedPlanId, planTwoId);

    const asking = await store.command('set_asking', DealerProductionUI.stagePayload('set_asking', record, { askingAmount: '40.00', currency: 'SGD' }), {
      commandId: commandId(9),
      expectedVersions: DealerProductionUI.expectedVersions(record)
    });
    assert.equal(asking.ok, true, JSON.stringify(asking));
    record = await refreshRecord(store, candidateId);
    const prepareExpected = DealerProductionUI.expectedVersions(record);
    const stagePreparePayload = DealerProductionUI.stagePayload('prepare_listing', record, {
      listingNotes: 'Synthetic listing readiness', outcomeNotes: 'Synthetic listing readiness',
      platform: 'Synthetic marketplace', channel: 'Direct', askingAmount: '40.00', currency: 'SGD'
    });
    expectContract(stagePreparePayload.listingId, record.__dealerDetail.listings[0].id, 'UI prepare_listing payload listingId');
    const prepared = await store.command('prepare_listing', stagePreparePayload, {
      commandId: commandId(10),
      expectedVersions: prepareExpected
    });
    assert.equal(prepared.ok, true, JSON.stringify({ prepared, prepareExpected, record }));
    record = await refreshRecord(store, candidateId);

    const stageSalePayload = DealerProductionUI.stagePayload('record_sale', record, {
      saleAmount: '35.00', saleDate: '25/09/2026', currency: 'SGD', outcomeNotes: 'Synthetic recorded sale'
    });
    expectContract(stageSalePayload.soldAt, '2026-09-25T00:00:00+08:00', 'UI record_sale soldAt');
    const sale = await store.command('record_sale', stageSalePayload, {
      commandId: commandId(11),
      expectedVersions: DealerProductionUI.expectedVersions(record)
    });
    assert.equal(sale.ok, true, JSON.stringify(sale));
    record = await refreshRecord(store, candidateId);
    assert.equal(record.__dealerDetail.outcomes[0].data.paymentStatus, 'Unknown');
    assert.equal(record.__dealerDetail.outcomes[0].data.contribution, 'Unknown', 'Unknown payment must not become zero contribution');

    const settlePayload = DealerProductionUI.stagePayload('settle_sale', record, {
      settlementRef: 'synthetic://bridge-settlement', outcomeNotes: 'Synthetic settled receipt',
      settlementDate: '25/09/2026', currency: 'SGD', proceeds: '35.00', sellingFee: '1.00', outboundShipping: '2.00'
    });
    assert.deepEqual(settlePayload.settlementEvidence, {
      class: 'manual',
      reference: 'synthetic://bridge-settlement',
      note: 'Synthetic settled receipt',
      date: '2026-09-25T00:00:00+08:00'
    });
    const uiSettleExpected = DealerProductionUI.expectedVersions(record);
    const saleRowVersion = Number(record.__dealerCanonicalRefs[0].saleRowVersion);
    expectContract(saleRowVersion, 1, 'sale row version after record_sale');
    expectContract(uiSettleExpected.sale, saleRowVersion, 'UI settle expected sale version');
    const settled = await store.command('settle_sale', settlePayload, {
      commandId: commandId(12),
      expectedVersions: uiSettleExpected
    });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    record = await refreshRecord(store, candidateId);
    const outcome = record.__dealerDetail.outcomes[0];
    assert.equal(outcome.data.paymentStatus, 'Settled');
    const actual = outcome.data.dealerActual;

    const stageReviewPayload = DealerProductionUI.stagePayload('review_outcome', record, {
      outcomeNotes: 'Synthetic actual versus frozen plan review',
      reviewCause: 'Synthetic actual versus frozen plan review',
      restockDecision: 'restock',
      restockDate: '25/09/2026'
    });
    expectContract(stageReviewPayload.review && stageReviewPayload.review.cause, 'Synthetic actual versus frozen plan review', 'UI review cause');
    expectContract(stageReviewPayload.restockDecision && stageReviewPayload.restockDecision.date, '2026-09-25T00:00:00+08:00', 'UI review restock date');
    const reviewed = await store.command('review_outcome', stageReviewPayload, {
      commandId: commandId(13),
      expectedVersions: DealerProductionUI.expectedVersions(record)
    });
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
    record = await refreshRecord(store, candidateId);
    const review = record.__dealerDetail.reviews[0];
    expectContract(actual.proceeds, 35, 'settled proceeds');
    expectContract(actual.canonicalLandedCost, 22, 'settled landed cost');
    expectContract(actual.sellingFee, 1, 'settled selling fee');
    expectContract(actual.outboundShipping, 2, 'settled outbound shipping');
    expectContract(actual.contribution, 10, 'settled contribution');
    expectContract(acquiredCost.settledAmount, 22, 'acquisition settled amount');
    expectContract(review.data.actual && (review.data.actual.dealerActual?.contribution ?? review.data.actual.contribution), 10, 'review actual contribution');
    expectContract(review.data.planVariance && review.data.planVariance.delta, 1, 'review plan variance');
    expectContract(review.data.targetVariance && review.data.targetVariance.delta, 5, 'review target variance');
    const renderedFinancialSummary = renderProductionSnapshot(store, candidateId);
    for (const [label, value] of [
      ['Planned landed cost', '$22.00'],
      ['Planned contribution', '$9.00'],
      ['Actual proceeds', '$35.00'],
      ['Actual contribution', '$10.00'],
      ['Plan variance', '$1.00'],
      ['Target variance', '$5.00']
    ]) {
      const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      assert.match(renderedFinancialSummary, new RegExp(escapedLabel + '<\\/dt><dd>' + escapedValue), `production UI displayed ${label}`);
    }
    assert.match(renderedFinancialSummary, /Settlement status: Settled/);
    const canonicalInventoryVersion = Number(sql(container, "select row_version from public.singles where id='bridge-card';"));
    expectContract(record.__dealerCanonicalRefs[0].canonicalRowVersion, canonicalInventoryVersion, 'canonical link current inventory version');
    expectContract(serverPlan.data.expected.expectedNetProceeds, 31, 'expected net proceeds');
    expectContract(serverPlan.data.expected.plannedContribution, 9, 'planned contribution');
    expectContract(serverPlan.data.expected.targetContribution, 5, 'target contribution');
    expectContract(serverPlan.data.expected.itemPriceCeiling, 24, 'item price ceiling');
    expectContract(serverPlan.data.expected.maximumAllInAcquisitionCostRounded, 26, 'maximum all-in ceiling');
    expectContract(record.__dealerDetail.readiness.ready, true, 'buy readiness');

    const idempotent = await store.command('review_outcome', stageReviewPayload, {
      commandId: commandId(13),
      expectedVersions: DealerProductionUI.expectedVersions(record)
    });
    assert.deepEqual(idempotent, reviewed);

    const newCandidateId = 'bridge-new-acquisition';
    const newCreated = await store.command('create_candidate', {
      candidateId: newCandidateId,
      name: 'Bridge new acquisition',
      set: 'Synthetic Set',
      number: '002',
      language: 'EN',
      variant: 'Normal',
      condition: 'Near mint',
      identity: { name: 'Bridge new acquisition', set: 'Synthetic Set', number: '002', language: 'EN', variant: 'Normal' },
      ownership: 'Business',
      ownershipReviewed: true,
      status: 'Draft'
    }, { commandId: commandId(14), expectedVersions: {} });
    assert.equal(newCreated.ok, true, JSON.stringify(newCreated));
    let newRecord = await refreshRecord(store, newCandidateId);

    const newEvidencePayload = DealerProductionUI.stagePayload('add_evidence', newRecord, {
      evidenceClass: 'identity', evidenceRef: 'synthetic://bridge-new-evidence', evidenceMatch: 'Exact',
      evidenceConfidence: 'High', evidenceRationale: 'Exact synthetic identity for new acquisition', evidenceDate: '25/09/2026'
    });
    const newEvidence = await store.command('add_evidence', newEvidencePayload, {
      commandId: commandId(15), expectedVersions: DealerProductionUI.expectedVersions(newRecord)
    });
    assert.equal(newEvidence.ok, true, JSON.stringify(newEvidence));
    newRecord = await refreshRecord(store, newCandidateId);

    const newPlanPayload = Object.assign({}, DealerProductionUI.stagePayload('create_plan', newRecord, planFields), {
      planId: 'bridge-new-acquisition-plan-1'
    });
    const newPlan = await store.command('create_plan', newPlanPayload, {
      commandId: commandId(16), expectedVersions: DealerProductionUI.expectedVersions(newRecord)
    });
    assert.equal(newPlan.ok, true, JSON.stringify(newPlan));
    newRecord = await refreshRecord(store, newCandidateId);
    const newApproved = await store.command('approve_buy', DealerProductionUI.stagePayload('approve_buy', newRecord, { planReason: economics.reason }), {
      commandId: commandId(17), expectedVersions: DealerProductionUI.expectedVersions(newRecord)
    });
    assert.equal(newApproved.ok, true, JSON.stringify(newApproved));
    newRecord = await refreshRecord(store, newCandidateId);

    const newAcquireFields = {
      acquisitionTable: 'singles', copyCost: '20.00', copyCurrency: 'SGD', nonItemAcquisitionCosts: '2.00',
      copyCostReason: 'Synthetic new canonical cost review', copyCostDate: '25/09/2026', inheritCost: 'true',
      outcomeNotes: 'Synthetic new canonical acquisition'
    };
    const newAcquirePayload = DealerProductionUI.stagePayload('acquire_copy', newRecord, newAcquireFields);
    assert.equal(newAcquirePayload.inventoryId, undefined, 'new acquisition must let SQL allocate the canonical identity');
    assert.deepEqual(newAcquirePayload.reviewedCost, {
      confirmed: true,
      currency: 'SGD',
      itemCost: '20.00',
      reason: 'Synthetic new canonical cost review',
      reviewedAt: '2026-09-25T00:00:00+08:00',
      nonItemAcquisitionCosts: '2.00'
    });
    const newAcquireExpected = DealerProductionUI.expectedVersions(newRecord);
    assert.equal(Object.hasOwn(newAcquireExpected, 'canonical'), false, 'new acquisition must not invent a canonical version');
    const newAcquired = await store.command('acquire_copy', newAcquirePayload, {
      commandId: commandId(18), expectedVersions: newAcquireExpected
    });
    assert.equal(newAcquired.ok, true, JSON.stringify(newAcquired));
    newRecord = await refreshRecord(store, newCandidateId);
    const newCopy = newRecord.__dealerDetail.copy[0];
    assert.equal(newCopy.data.acquisitionType, 'acquired');
    assert.equal(Number(newCopy.data.costComponent.itemCost), 20);
    assert.equal(Number(newCopy.data.costComponent.nonItemAcquisitionCosts), 2);
    assert.equal(Number(newCopy.data.costComponent.settledAmount), 22, 'new acquisition landed cost must be item20 plus non-item2');
    assert.equal(newCopy.data.itemRef.table, 'singles');
    assert.equal(newCopy.data.itemRef.id, 'dealer-' + newCopy.id);
    assert.equal(sql(container, `select count(*) from public.singles where id='${newCopy.data.itemRef.id}';`), '1');
    const newCanonical = JSON.parse(sql(container, `select data from public.singles where id='${newCopy.data.itemRef.id}';`));
    assert.equal(Number(newCanonical.costPrice), 20);
    assert.equal(Number(newCanonical.dealerCostBasis.settledAmount), 22);

    const repeatedAcquisition = await store.command('acquire_copy', newAcquirePayload, {
      commandId: commandId(19), expectedVersions: DealerProductionUI.expectedVersions(newRecord)
    });
    assert.equal(repeatedAcquisition.ok, false, JSON.stringify(repeatedAcquisition));
    assert.equal(repeatedAcquisition.code, 'state_conflict');
    const replayedAcquisition = await store.command('acquire_copy', newAcquirePayload, {
      commandId: commandId(18), expectedVersions: newAcquireExpected
    });
    assert.deepEqual(replayedAcquisition, newAcquired);
    assert.ok(shim.calls.some(call => call.url.endsWith('/collectibles_dealer_pull_v1')));
    assert.ok(shim.calls.some(call => call.url.endsWith('/collectibles_dealer_command_v1')));
    assert.deepEqual(contractFailures, [], contractFailures.join('\n'));
  } finally {
    if (shim) await closeServer(shim.server);
    if (running) spawnSync('docker', ['rm', '--force', container], { encoding: 'utf8' });
  }
});

test('dashboard realised totals exclude an unsettled Dealer sale while retaining a settled one', async () => {
  const { ctx } = await loadApp({
    seed: {
      sales: [
        {
          id: 'dealer-unsettled', dateSold: '25 Sep 2026', product: 'Synthetic unsettled Dealer sale',
          costPrice: 20, totalCollected: 35, shippingCost: 2, fees: 1, profit: null, margin: null,
          paymentStatus: 'Unknown', dealerPaymentStatus: 'Unknown', dealerRelease: '3.62'
        },
        {
          id: 'dealer-settled', dateSold: '25 Sep 2026', product: 'Synthetic settled Dealer sale',
          costPrice: 22, totalCollected: 35, shippingCost: 2, fees: 1, profit: 10, margin: 28.57,
          paymentStatus: 'Settled', dealerPaymentStatus: 'Settled', dealerRelease: '3.62'
        }
      ]
    }
  });
  const stats = ctx.computeDashboardStats();
  assert.equal(stats.allTimeRevenue, 35, 'only the settled Dealer sale is realised revenue');
  assert.equal(stats.allTimeProfit, 10, 'unsettled null profit must not collapse into realised zero');
});
