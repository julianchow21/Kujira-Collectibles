'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const DealerMoney = require('../dealer-money.js');

const FX_USD_SGD = {
  base: 'USD',
  quote: 'SGD',
  rate: '1.35',
  source: 'manual',
  observedAt: '2026-09-23',
};

function line(overrides = {}) {
  return {
    amount: '0',
    currency: 'SGD',
    status: 'Estimate',
    effect: 'debit',
    type: 'other',
    ...overrides,
  };
}

test('dealer-money exports the same dependency-free API through CommonJS and the browser global', () => {
  assert.equal(typeof DealerMoney.convertLines, 'function');
  const source = fs.readFileSync(require.resolve('../dealer-money.js'), 'utf8');
  const sandbox = { console };
  vm.runInNewContext(source, sandbox, { filename: 'dealer-money.js' });
  assert.equal(typeof sandbox.DealerMoney.convertLine, 'function');
  assert.equal(sandbox.DealerMoney.convertLine(line()).convertedAmount, '0.00');
});

test('dealer-money parses unknown and zero distinctly, and rejects negative, non-finite and exponent input', () => {
  assert.equal(DealerMoney.parseMagnitude(null), null);
  assert.equal(DealerMoney.parseMagnitude(''), null);
  assert.equal(DealerMoney.parseMagnitude('   '), null);
  assert.equal(DealerMoney.parseMagnitude('0.00'), '0');
  assert.equal(DealerMoney.parseMagnitude('001.2300'), '1.23');
  assert.throws(() => DealerMoney.parseMagnitude('-0.01'), /negative/i);
  assert.throws(() => DealerMoney.parseMagnitude('1e3'), /exponent/i);
  assert.throws(() => DealerMoney.parseMagnitude('Infinity'), /decimal/i);
  assert.throws(() => DealerMoney.parseMagnitude(1.25), /decimal string/i);
});

test('dealer-money validates Unknown and Not applicable without treating either as a numeric zero', () => {
  const unknown = DealerMoney.validateMoneyLine(line({ amount: null, status: 'Unknown' }));
  assert.equal(unknown.valid, true);
  assert.equal(DealerMoney.convertLine(line({ amount: null, status: 'Unknown' })).convertedAmount, null);

  const notApplicable = DealerMoney.validateMoneyLine(line({ amount: null, status: 'Not applicable' }));
  assert.equal(notApplicable.valid, true);
  const converted = DealerMoney.convertLine(line({ amount: null, status: 'Not applicable' }));
  assert.equal(converted.status, 'Not applicable');
  assert.equal(converted.convertedAmount, '0.00');

  assert.equal(DealerMoney.validateMoneyLine(line({ amount: '-1' })).valid, false);
  assert.equal(DealerMoney.validateMoneyLine(line({ status: 'Unsupported' })).valid, false);
  assert.equal(DealerMoney.validateMoneyLine(line({ amount: '1e3' })).valid, false);
});

test('dealer-money converts forward and inverse FX using the unrounded exact rate', () => {
  const forward = DealerMoney.convertLine(line({
    amount: '100',
    currency: 'USD',
    type: 'item_price',
    fx: FX_USD_SGD,
  }));
  assert.equal(forward.convertedAmount, '135.00');
  assert.equal(forward.basis, 'converted');

  const inverse = DealerMoney.convertLine(line({
    amount: '135',
    currency: 'SGD',
    type: 'item_price',
    fx: FX_USD_SGD,
  }), { reportingCurrency: 'USD' });
  assert.equal(inverse.convertedAmount, '100.00');
  assert.equal(inverse.basis, 'inverse_converted');
});

test('dealer-money allocates the PA-18 rounding residual to the named final line without mutating input', () => {
  const input = ['33.33', '33.33', '33.34'].map((amount, index) => line({
    id: `usd-${index}`,
    amount,
    currency: 'USD',
    type: 'item_price',
    fx: FX_USD_SGD,
  }));
  const before = JSON.stringify(input);
  const converted = DealerMoney.convertLines(input);

  assert.deepEqual(converted.lines.map(item => item.convertedAmount), ['45.00', '45.00', '45.01']);
  assert.equal(converted.total, '135.00');
  assert.equal(converted.grossRoundedTotal, '135.01');
  assert.deepEqual(converted.residualAdjustment, {
    amount: '0.01',
    currency: 'SGD',
    status: 'Estimate',
    effect: 'credit',
    type: 'rounding_adjustment',
    name: 'Rounding residual',
    description: 'Named residual allocated to the final converted line',
    lineIndex: 2,
  });
  assert.equal(converted.lines[2].netConvertedAmount, '45.00');
  assert.equal(converted.lines[2].adjustments[0].type, 'rounding_adjustment');
  assert.equal(JSON.stringify(input), before);
  assert.doesNotThrow(() => JSON.stringify(converted));
});

test('dealer-money exposes the aggregate exact rational alongside bounded exactTotal display text', () => {
  const converted = DealerMoney.convertLines([line({
    amount: '1',
    currency: 'SGD',
    type: 'item_price',
    fx: FX_USD_SGD,
  })], { reportingCurrency: 'USD' });

  assert.equal(converted.total, '0.74');
  assert.equal(converted.exactTotalNumerator, '20');
  assert.equal(converted.exactTotalDenominator, '27');
  assert.match(converted.exactTotal, /^0\.7407407407/);
  assert.notEqual(converted.exactTotal, '20/27');
});

test('dealer-money gives a posted settled reporting amount precedence over an FX estimate', () => {
  const converted = DealerMoney.convertLine(line({
    amount: '100',
    currency: 'USD',
    status: 'Posted',
    type: 'item_price',
    fx: { ...FX_USD_SGD, settledBaseAmount: '140.00', settledCurrency: 'SGD' },
  }));
  assert.equal(converted.convertedAmount, '140.00');
  assert.equal(converted.basis, 'settled');
  assert.equal(DealerMoney.validateMoneyLine(line({
    amount: '100', currency: 'USD', status: 'Posted', type: 'item_price',
    fx: { ...FX_USD_SGD, settledBaseAmount: '140.00' },
  })).valid, false, 'settled currency must be explicit');
  assert.throws(() => DealerMoney.convertLine(line({
    amount: '100', currency: 'USD', status: 'Posted', type: 'item_price',
    fx: { ...FX_USD_SGD, settledBaseAmount: '140.00', settledCurrency: 'SGD' },
  }), { reportingCurrency: 'USD' }), /settled amount currency/i);
});

test('dealer-money requires every settled amount to be Posted', () => {
  const topLevel = line({
    amount: '100',
    currency: 'USD',
    status: 'Estimate',
    type: 'item_price',
    fx: FX_USD_SGD,
    settledBaseAmount: '135',
    settledCurrency: 'SGD',
  });
  assert.equal(DealerMoney.validateMoneyLine(topLevel).valid, false);
  assert.throws(() => DealerMoney.convertLine(topLevel), /settled amounts require Posted status/i);

  const fxSettled = line({
    amount: '100',
    currency: 'USD',
    status: 'Estimate',
    type: 'item_price',
    fx: { ...FX_USD_SGD, settledBaseAmount: '135', settledCurrency: 'SGD' },
  });
  assert.equal(DealerMoney.validateMoneyLine(fxSettled).valid, false);
  assert.throws(() => DealerMoney.convertLine(fxSettled), /settled amounts require Posted status/i);
});

test('dealer-money floors an exact purchase ceiling at the reporting minor unit', () => {
  const plan = DealerMoney.calculateExpectedEconomics({
    expectedSaleAmount: '10.009',
    sellingFee: '0',
    outboundShipping: '0',
    expectedRefundAllowance: '0',
    otherExpectedDeductions: '0',
    targetContribution: '0',
    riskAllowance: '0',
    knownNonItemAcquisitionCosts: '0',
  });
  assert.equal(plan.maximumAllInAcquisitionCost, '10.009');
  assert.equal(plan.maximumAllInAcquisitionCostRounded, '10.00');
  assert.equal(plan.itemPriceCeiling, '10.00');
});

test('dealer-money propagates unknown planning inputs and keeps refund allowance out of risk twice', () => {
  const unknown = DealerMoney.calculateExpectedEconomics({
    expectedSaleAmount: '100',
    sellingFee: null,
    outboundShipping: '3',
    expectedRefundAllowance: '0',
    otherExpectedDeductions: '0',
    targetContribution: '10',
    riskAllowance: '2',
    knownNonItemAcquisitionCosts: '1',
  });
  assert.equal(unknown.status, 'Unknown');
  assert.equal(unknown.expectedNetProceeds, null);
  assert.equal(unknown.itemPriceCeiling, null);

  const plan = DealerMoney.calculateExpectedEconomics({
    expectedSaleAmount: '100',
    sellingFee: '5',
    outboundShipping: '3',
    expectedRefundAllowance: '10',
    otherExpectedDeductions: '0',
    targetContribution: '0',
    riskAllowance: '0',
    knownNonItemAcquisitionCosts: '0',
  });
  assert.equal(plan.expectedNetProceeds, '82.00');
  assert.equal(plan.refundAllowanceCountedOnce, true);
  assert.throws(() => DealerMoney.calculateExpectedEconomics({
    expectedSaleAmount: '100',
    sellingFee: '0',
    outboundShipping: '0',
    expectedRefundAllowance: '10',
    otherExpectedDeductions: [{ amount: '10', type: 'refund_allowance', status: 'Estimate' }],
    targetContribution: '0',
    riskAllowance: '0',
    knownNonItemAcquisitionCosts: '0',
  }), /refund allowance/i);
});

test('dealer-money actual contribution applies credits and debits once, and refuses inferred foreign settlement', () => {
  const actual = DealerMoney.calculateActualContribution({
    realisedProceeds: '100',
    canonicalLandedCost: '60',
    sellingFee: '5',
    outboundShipping: '3',
    creditAdjustments: [line({ amount: '5', type: 'fee_reimbursement', effect: 'credit', status: 'Posted' })],
    debitAdjustments: [line({ amount: '100', type: 'refund', effect: 'debit', status: 'Posted' })],
  });
  assert.equal(actual.contribution, '-63.00');

  const foreignEstimate = DealerMoney.calculateActualContribution({
    realisedProceeds: line({ amount: '100', currency: 'USD', status: 'Estimate', effect: 'credit', type: 'proceeds', fx: FX_USD_SGD }),
    canonicalLandedCost: '60',
    sellingFee: '5',
    outboundShipping: '3',
  });
  assert.equal(foreignEstimate.status, 'Unknown');
  assert.equal(foreignEstimate.contribution, null);

  const missingAdjustments = DealerMoney.calculateActualContribution({
    realisedProceeds: '100', canonicalLandedCost: '60', sellingFee: '5', outboundShipping: '3',
  });
  assert.equal(missingAdjustments.status, 'Unknown');
  assert.equal(missingAdjustments.contribution, null);

  assert.throws(() => DealerMoney.calculateActualContribution({
    realisedProceeds: '100', canonicalLandedCost: '50', sellingFee: '0', outboundShipping: '0',
    creditAdjustments: [line({ amount: '10', type: 'selling_fee', effect: 'debit', status: 'Posted' })],
    debitAdjustments: [],
  }), /creditAdjustments(?:\[0\])? requires credit lines/i);
});

test('dealer-money structured planning lines use FX, preserve unknown FX, and enforce type effects', () => {
  const known = DealerMoney.calculateExpectedEconomics({
    expectedSaleAmount: line({ amount: '100', currency: 'USD', effect: 'credit', type: 'proceeds', fx: FX_USD_SGD }),
    sellingFee: '0', outboundShipping: '0', expectedRefundAllowance: '0', otherExpectedDeductions: '0',
    targetContribution: '0', riskAllowance: '0', knownNonItemAcquisitionCosts: '0',
  });
  assert.equal(known.expectedNetProceeds, '135.00');

  const unknownFx = DealerMoney.calculateExpectedEconomics({
    expectedSaleAmount: line({ amount: '100', currency: 'USD', effect: 'credit', type: 'proceeds' }),
    sellingFee: '0', outboundShipping: '0', expectedRefundAllowance: '0', otherExpectedDeductions: '0',
    targetContribution: '0', riskAllowance: '0', knownNonItemAcquisitionCosts: '0',
  });
  assert.equal(unknownFx.expectedNetProceeds, null);
  assert.equal(DealerMoney.validateMoneyLine(line({ type: 'proceeds', effect: 'debit' })).valid, false);

  assert.equal(DealerMoney.formatMoney(null), null);
  assert.equal(DealerMoney.floorMoney(null), null);
  assert.equal(DealerMoney.add(null, '1'), null);
  assert.equal(DealerMoney.divide(null, '2'), null);
  assert.equal(DealerMoney.validateMoneyLine({ amount: '1', status: 'Unknown', currency: 'SGD', effect: 'debit', type: 'item_price' }).valid, false);
  assert.equal(DealerMoney.validateMoneyLine({ amount: '1', status: 'Not applicable', currency: 'SGD', effect: 'debit', type: 'item_price' }).valid, false);
});

test('dealer-money enforces adjustment containers while allowing canonical landed cost to net acquisition credits', () => {
  const actual = DealerMoney.calculateActualContribution({
    realisedProceeds: '100',
    canonicalLandedCost: [
      line({ amount: '60', type: 'item_price', status: 'Posted' }),
      line({ amount: '10', type: 'acquisition_credit', effect: 'credit', status: 'Posted' }),
    ],
    sellingFee: '0',
    outboundShipping: '0',
    creditAdjustments: [],
    debitAdjustments: [],
  });
  assert.equal(actual.canonicalLandedCost, '50.00');
  assert.equal(actual.contribution, '50.00');

  assert.throws(() => DealerMoney.calculateActualContribution({
    realisedProceeds: line({ amount: '100', type: 'other', effect: 'credit', status: 'Posted' }),
    canonicalLandedCost: '50', sellingFee: '0', outboundShipping: '0',
    creditAdjustments: [], debitAdjustments: [],
  }), /realisedProceeds requires type proceeds/i);
});

test('dealer-money treats a foreign Not applicable line as explicit zero without settlement metadata', () => {
  const actual = DealerMoney.calculateActualContribution({
    realisedProceeds: '100',
    canonicalLandedCost: '50',
    sellingFee: '0',
    outboundShipping: '0',
    creditAdjustments: [],
    debitAdjustments: [line({ amount: null, currency: 'USD', status: 'Not applicable', type: 'refund' })],
  });
  assert.equal(actual.status, 'Known');
  assert.equal(actual.debitAdjustments, '0.00');
  assert.equal(actual.contribution, '50.00');
});
