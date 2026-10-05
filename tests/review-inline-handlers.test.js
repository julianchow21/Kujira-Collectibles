'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { loadApp, makeSeed } = require('./harness');

// Harmless text covering both parsers: quotes/backslashes in JavaScript and
// entity-looking text/angle brackets in HTML. No executable payload is needed.
const ROW_ID = 'legacy O\'Neil "quoted" \\ <row> & &#39;\nline\u2028next\u2029end';
const TRACKING = 'tracking O\'Neil "quoted" \\ & <parcel>';

function decodeAttribute(value) {
  // One HTML decoding pass, including &amp;#39; -> &#39; (not -> apostrophe).
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  return value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => entities[name]);
}

function handlers(html) {
  return [...html.matchAll(/\bon(?:click|change|input)="([^"]*)"/g)]
    .map(match => decodeAttribute(match[1]));
}

async function verifyCalls(html, expected, rowId = ROW_ID) {
  const calls = [];
  const sandbox = {
    button: { value: '12.50', checked: true, closest: () => ({ dataset: { id: rowId } }) },
    kjrMoneyStr: value => value,
    kjrConfirm: async () => true,
    toast() {}, toastError() {}, renderTrash() {},
  };
  for (const name of Object.keys(expected)) {
    sandbox[name] = (...args) => { calls.push({ name, args }); return false; };
  }
  for (const handler of handlers(html)) {
    // All handlers must parse after HTML decoding, even static section toggles.
    const script = new vm.Script('(function () { ' + handler + ' }).call(button)');
    if (Object.keys(expected).some(name => handler.includes(name + '('))) {
      script.runInNewContext(sandbox);
    }
  }
  await new Promise(resolve => setImmediate(resolve));
  for (const [name, { index, value }] of Object.entries(expected)) {
    const matching = calls.filter(call => call.name === name);
    assert.ok(matching.length, name + ' handler was rendered and called');
    for (const call of matching) assert.equal(call.args[index], value, name + ' receives the exact stored value');
  }
  return calls;
}

function idAt(index, value = ROW_ID) { return { index, value }; }

test('inline arguments preserve punctuation and control characters through both parsing contexts', async () => {
  const { ctx } = await loadApp();
  for (const value of [ROW_ID, '', 'literal &quot; and &#39;', '\u0000\t\r\n', null, 42]) {
    const encoded = ctx.kjrInlineArg(value);
    assert.doesNotMatch(encoded, /[<>"']/);
    const decoded = decodeAttribute(encoded);
    assert.equal(vm.runInNewContext(decoded), String(value ?? ''));
  }
});

const rowCases = [
  ['singles', 'renderSingles', 'singles-body', 'Available', {
    markStatus: idAt(1), openListingFor: idAt(1), toggleRowSelect: idAt(1),
    updateField: idAt(1), openEditSingle: idAt(0), deleteItem: idAt(0),
  }],
  ['singles', 'renderSingles', 'singles-sold-body', 'Sold', {
    markStatus: idAt(1), toggleRowSelect: idAt(1), updateField: idAt(1),
    openEditSingle: idAt(0), deleteItem: idAt(0),
  }],
  ['slabs', 'renderSlabs', 'slabs-body', 'Available', {
    markStatus: idAt(1), openListingFor: idAt(1), toggleRowSelect: idAt(1),
    updateField: idAt(1), openEditSlab: idAt(0), deleteItem: idAt(0),
  }],
  ['slabs', 'renderSlabs', 'slabs-sold-body', 'Sold', {
    markStatus: idAt(1), toggleRowSelect: idAt(1), updateField: idAt(1),
    openEditSlab: idAt(0), deleteItem: idAt(0),
  }],
  ['sales', 'renderSales', 'sales-body', '', {
    toggleRowSelect: idAt(1), openEditSale: idAt(0), deleteItem: idAt(0),
    viewSourceItem: idAt(0, ROW_ID + ' source'),
  }],
  ['etbs', 'renderEtbs', 'kjr-etb-body', 'In Stock', {
    updateField: idAt(1), kjrOpenEtbModal: idAt(0), kjrDeleteRow: idAt(1),
  }],
  ['boosterBoxes', 'renderBoosterBoxes', 'kjr-bb-body', 'Unopened', {
    updateField: idAt(1), kjrOpenBbModal: idAt(0), kjrDeleteRow: idAt(1),
  }],
  ['boosterPacks', 'renderBoosterPacks', 'kjr-bp-body', 'Sealed', {
    updateField: idAt(1), kjrOpenBpModal: idAt(0), kjrDeleteRow: idAt(1),
  }],
  ['ebayPurchases', 'renderEbayPurchases', 'kjr-ebay-body', 'Paid', {
    kjrEbaySetStatus: idAt(0), kjrToggleDeclared: idAt(0), kjrEbayToggleRow: idAt(0),
    kjrCopyTracking: idAt(1, TRACKING), kjrEbayInlineEdit: idAt(0),
    kjrOpenEbayModal: idAt(0), kjrDeleteRow: idAt(1),
  }],
];

for (const [table, render, bodyId, status, expected] of rowCases) {
  test('stored ' + table + ' ' + status + ' row actions preserve legacy punctuation IDs', async () => {
    const row = {
      ...makeSeed().singles[0], id: ROW_ID, status, name: 'Synthetic row', product: 'Synthetic product',
      grader: 'TAG', grade: '10', certNo: '1234', totalPrice: 10, totalCost: 10,
      dateSold: '1 Jan 2025', totalCollected: 20, shippingCost: 1, fees: 1,
      inventoryId: ROW_ID + ' source', inventoryTable: 'singles',
      tracking: TRACKING, priceUsd: 5, freightSgd: 1, totalSgd: 8,
    };
    const seed = makeSeed({ [table]: [row] });
    const { ctx, document } = await loadApp({ seed });
    if (status === 'Sold') document.getElementById(table + '-sold-divider').dataset.open = '1';
    ctx[render]();
    await verifyCalls(document.getElementById(bodyId).innerHTML, expected);
  });
}

test('cart, versions, TAG ranks, Trash and saved chart actions preserve legacy IDs', async () => {
  const row = { ...makeSeed().singles[0], id: ROW_ID };
  const { ctx, document } = await loadApp({ seed: makeSeed({
    singles: [row], slabs: [{ ...row, grader: 'TAG', grade: '10', certNo: '1234' }],
  }) });
  ctx.cmdSellCart = [{ ...row, _table: 'singles', qty: 1, availQty: 2, price: 20 }];
  ctx.renderCmdSellCart();
  await verifyCalls(document.getElementById('cmd-sell-cart-list').innerHTML, {
    cmdSellSetQty: idAt(0), cmdSellRemove: idAt(0), cmdSellSetPrice: idAt(0),
  });

  const versions = { innerHTML: '' };
  ctx._renderVerItems(versions, [{ id: ROW_ID, name: 'Synthetic version', ts: Date.now(), data: JSON.stringify(makeSeed()) }]);
  await verifyCalls(versions.innerHTML, { restoreVersion: idAt(0), deleteVersion: idAt(0) });

  ctx._renderTagRankList();
  await verifyCalls(document.getElementById('tag-rank-body').innerHTML, { _setTagRank: idAt(0) });

  ctx.fetchTrash = async () => [{ id: ROW_ID, data: { originalTable: 'singles', item: row, deletedAt: new Date().toISOString() } }];
  ctx.renderTrash(false);
  await new Promise(resolve => setImmediate(resolve));
  await verifyCalls(document.getElementById('trash-list').innerHTML, {
    restoreFromTrash: idAt(0), hardDeleteTrashEntry: idAt(0),
  });

  ctx._drawSavedChart = () => {};
  ctx._renderOneSavedChart({ id: ROW_ID, title: 'Synthetic <chart>', xFields: ['name'], yFields: ['costPrice'], source: 'singles', topN: 10, chartType: 'bar' });
  const chartHtml = document.getElementById('saved-charts-container').children.at(-1).innerHTML;
  assert.ok(chartHtml.includes('Synthetic &lt;chart&gt;'));
  assert.ok(chartHtml.includes('id="sc-canvas-' + ctx.esc(ROW_ID) + '"'));
  await verifyCalls(chartHtml, { togglePinChart: idAt(0), _refreshSavedChart: idAt(0), deleteSavedChart: idAt(0) });
});
