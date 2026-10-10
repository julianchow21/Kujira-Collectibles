'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const preview = require('./dealer-production-preview.cjs');

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
    end(body) { this.body = body ? Buffer.from(body).toString('utf8') : ''; }
  };
}

function fixtureWindow(scenario) {
  const values = new Map();
  const storage = {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
  const sandbox = {
    URL,
    location: { href: 'http://127.0.0.1:8766/?scenario=' + encodeURIComponent(scenario) },
    localStorage: storage,
    navigator: { onLine: true, serviceWorker: null },
    setTimeout() {},
    clearTimeout() {},
    console
  };
  sandbox.window = sandbox;
  const source = preview.buildBootstrap().replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
  vm.runInNewContext(source, sandbox, { filename: 'dealer-production-preview-bootstrap.js' });
  return sandbox;
}

test('production fixture serves the real page with a loopback-only synthetic transport', async () => {
  const html = preview.buildPreviewIndex();
  assert.match(html, /dealer-production-fixture-bootstrap/);
  assert.match(html, /window\.fetch = function/);
  assert.match(html, /DEALER FIXTURE/);
  assert.doesNotMatch(html, /<script[^>]+src="https?:\/\//i);
  assert.doesNotMatch(html, /<link[^>]+href="https?:\/\//i);
  assert.match(html, /dealer-production-ui\.js\?v=3\.68/);
  assert.match(html, /#kjr-production-fixture-tools\{bottom:96px!important/);
  assert.match(html, /production command contract accepts candidate fields at the/);
  assert.match(html, /mode === 'existing' \? 'Fixture Graded Charizard' : 'Fixture golden candidate'/);
  assert.match(html, /mode === 'existing' \? 'slabs::slab-44' : ''/);
  assert.match(html, /"certNo":"FIXTURE-SLAB-44"/);
});

test('production fixture serves only allowlisted app assets', () => {
  const pageResponse = fakeResponse();
  preview.handleRequest({ method: 'GET', url: '/?scenario=golden' }, pageResponse);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers['Content-Security-Policy'], /connect-src 'self'/);
  const appResponse = fakeResponse();
  preview.handleRequest({ method: 'GET', url: '/app.js?v=3.68' }, appResponse);
  assert.equal(appResponse.status, 200);
  const blockedResponse = fakeResponse();
  preview.handleRequest({ method: 'GET', url: '/not-an-asset.js' }, blockedResponse);
  assert.equal(blockedResponse.status, 404);
});

test('production fixture accepts the app fetch(url, init) signature and preserves create/update identity', async () => {
  const fixture = fixtureWindow('golden');
  const commandUrl = 'http://127.0.0.1:8766/sync/v2/dealer/command';
  const create = {
    client_protocol: 2,
    schema_version: 1,
    command_id: '00000000-0000-4000-8000-000000000001',
    command: 'create_candidate',
    expected: {},
    payload: { name: 'Fixture transport candidate', set: 'Transport set', number: '001', language: 'EN', condition: 'Near mint', ownership: 'Business', ownershipReviewed: 'true' }
  };
  const createdResponse = await fixture.fetch(commandUrl, { method: 'POST', body: JSON.stringify(create) });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 200);
  assert.equal(created.result.candidate.data.name, 'Fixture transport candidate');
  const candidateId = created.result.candidate.id;
  const update = {
    client_protocol: 2,
    schema_version: 1,
    command_id: '00000000-0000-4000-8000-000000000002',
    command: 'update_candidate',
    expected: { candidate: 1 },
    payload: { candidateId, patch: { name: 'Fixture transport updated', set: 'Transport set updated' } }
  };
  const updatedResponse = await fixture.fetch(commandUrl, { method: 'POST', body: JSON.stringify(update) });
  const updated = await updatedResponse.json();
  assert.equal(updatedResponse.status, 200);
  assert.equal(updated.result.candidate.data.name, 'Fixture transport updated');
  const pullResponse = await fixture.fetch('http://127.0.0.1:8766/sync/v2/dealer/pull', {
    method: 'POST',
    body: JSON.stringify({ client_protocol: 2, schema_version: 1, cursor: null, limit: 50, candidateId })
  });
  const pulled = await pullResponse.json();
  assert.equal(pulled.data.selected.candidate.data.name, 'Fixture transport updated');
  const invalidResponse = await fixture.fetch(commandUrl, { method: 'POST', body: JSON.stringify({ command: 'not_a_dealer_command' }) });
  assert.equal(invalidResponse.status, 400);
  assert.equal((await invalidResponse.json()).error.code, 'fixture_command_invalid');
});

test('production fixture honours bounded cursor paging through the app fetch signature', async () => {
  const fixture = fixtureWindow('many');
  const pullUrl = 'http://127.0.0.1:8766/sync/v2/dealer/pull';
  const pull = cursor => fixture.fetch(pullUrl, {
    method: 'POST',
    body: JSON.stringify({ client_protocol: 2, schema_version: 1, cursor, limit: 50 })
  }).then(response => response.json());
  const first = await pull(null);
  const second = await pull(first.data.next_cursor);
  assert.equal(first.data.candidates.length, 50);
  assert.equal(first.data.next_cursor, 'page-2');
  assert.equal(second.data.candidates.length, 12);
  assert.equal(second.data.candidates[0].id, 'candidate-051');
  assert.equal(second.data.next_cursor, null);
});

test('production fixture mirrors SQL-shaped plan and settled money results', async () => {
  const fixture = fixtureWindow('golden');
  const commandUrl = 'http://127.0.0.1:8766/sync/v2/dealer/command';
  let sequence = 0;
  const command = async (name, payload) => {
    const response = await fixture.fetch(commandUrl, {
      method: 'POST',
      body: JSON.stringify({
        client_protocol: 2,
        schema_version: 1,
        command_id: '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0'),
        command: name,
        expected: {},
        payload: payload || {}
      })
    });
    assert.equal(response.status, 200, name);
    return response.json();
  };
  const created = await command('create_candidate', { name: 'Money fixture candidate', set: 'Money set', number: '001', language: 'EN', condition: 'Near mint', ownershipReviewed: 'true' });
  const candidateId = created.result.candidate.id;
  await command('create_plan', {
    candidateId,
    plan: {
      expectedSaleAmount: '35', expectedSellingFee: '1', expectedOutboundShipping: '2', expectedRefundAllowance: '0',
      otherExpectedDeductions: '1', targetContribution: '5', riskAllowance: '0', knownNonItemAcquisitionCosts: '2',
      plannedItemCost: '20', reportingCurrency: 'SGD'
    }
  });
  await command('acquire_copy', { candidateId, inventoryTable: 'singles', reviewedCost: { itemCost: '20', nonItemAcquisitionCosts: '2', currency: 'SGD' } });
  await command('record_sale', { candidateId, agreedAmount: '35', currency: 'SGD', soldAt: '2026-09-26T00:00:00+08:00' });
  await command('settle_sale', { candidateId, proceeds: '35', sellingFee: '1', outboundShipping: '2', currency: 'SGD' });
  await command('review_outcome', { candidateId, review: { cause: 'Fixture review' } });
  const pullResponse = await fixture.fetch('http://127.0.0.1:8766/sync/v2/dealer/pull', {
    method: 'POST',
    body: JSON.stringify({ client_protocol: 2, schema_version: 1, cursor: null, limit: 50, candidateId })
  });
  const pulled = await pullResponse.json();
  const selected = pulled.data.selected;
  const plan = selected.plans[0].data;
  const outcome = selected.outcomes[0];
  const review = selected.reviews[0].data;
  assert.equal(plan.expected.expectedNetProceeds, 31);
  assert.equal(plan.plannedLandedCost.amount, 22);
  assert.equal(outcome.paymentStatus, 'Settled');
  assert.equal(outcome.dealerActual.proceeds, 35);
  assert.equal(outcome.dealerActual.canonicalLandedCost, 22);
  assert.equal(outcome.dealerActual.contribution, 10);
  assert.equal(review.actual.contribution, 10);
  assert.equal(review.planVariance.delta, 1);
  assert.equal(review.targetVariance.delta, 5);
});
