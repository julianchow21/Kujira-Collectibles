/*
 * Dealer Desk money primitives.
 *
 * This file deliberately has no dependency on the application runtime.  It can
 * be loaded by the browser as `DealerMoney`, or by Node with require().  Money
 * enters this module as decimal strings.  BigInt is used only behind the
 * public API, so every returned money value remains JSON-safe.
 */
(function dealerMoneyModule(root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else if (root) {
    root.DealerMoney = factory();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createDealerMoney() {
  'use strict';

  var DEFAULT_REPORTING_CURRENCY = 'SGD';
  var MONEY_SCALE = 2;
  var MAX_DECIMAL_PLACES = 100;
  var MAX_INTEGER_DIGITS = 1000;
  var MAX_DIVISION_SCALE = 100;
  var VALID_STATUSES = ['Unknown', 'Estimate', 'Posted', 'Not applicable'];
  var VALID_EFFECTS = ['debit', 'credit'];
  var TYPE_RE = /^[a-z][a-z0-9_]*$/;

  var ZERO = 0n;
  var ONE = 1n;
  var TEN = 10n;

  var DEFAULT_TYPES = [
    'item_price',
    'acquisition_shipping',
    'selling_fee',
    'outbound_shipping',
    'refund_allowance',
    'risk_allowance',
    'rounding_adjustment',
    'tax',
    'duty',
    'payment_fee',
    'grading',
    'authentication',
    'other_deduction',
    'other_acquisition',
    'acquisition_credit',
    'fee_reimbursement',
    'refund',
    'proceeds',
    'landed_cost',
    'other',
    'insurance',
    'storage',
    'platform_fee',
    'discount',
    'coupon',
    'currency_adjustment'
  ];

  var TYPE_EFFECTS = {
    item_price: ['debit'],
    acquisition_shipping: ['debit'],
    selling_fee: ['debit'],
    outbound_shipping: ['debit'],
    refund_allowance: ['debit'],
    risk_allowance: ['debit'],
    rounding_adjustment: ['debit', 'credit'],
    tax: ['debit'],
    duty: ['debit'],
    payment_fee: ['debit'],
    grading: ['debit'],
    authentication: ['debit'],
    other_deduction: ['debit'],
    other_acquisition: ['debit'],
    acquisition_credit: ['credit'],
    fee_reimbursement: ['credit'],
    refund: ['debit'],
    proceeds: ['credit'],
    landed_cost: ['debit'],
    other: ['debit', 'credit'],
    insurance: ['debit'],
    storage: ['debit'],
    platform_fee: ['debit'],
    discount: ['credit'],
    coupon: ['credit'],
    currency_adjustment: ['debit', 'credit']
  };

  function DealerMoneyError(message, code, details) {
    this.name = 'DealerMoneyError';
    this.message = message;
    this.code = code || 'invalid_money';
    if (details !== undefined) this.details = details;
    if (Error.captureStackTrace) Error.captureStackTrace(this, DealerMoneyError);
  }
  DealerMoneyError.prototype = Object.create(Error.prototype);
  DealerMoneyError.prototype.constructor = DealerMoneyError;

  function fail(message, code, details) {
    throw new DealerMoneyError(message, code, details);
  }

  function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function abs(value) {
    return value < ZERO ? -value : value;
  }

  function gcd(a, b) {
    a = abs(a);
    b = abs(b);
    while (b !== ZERO) {
      var remainder = a % b;
      a = b;
      b = remainder;
    }
    return a || ONE;
  }

  function rational(numerator, denominator) {
    if (denominator === ZERO) fail('A decimal denominator cannot be zero', 'zero_denominator');
    if (denominator < ZERO) {
      numerator = -numerator;
      denominator = -denominator;
    }
    var divisor = gcd(numerator, denominator);
    return { n: numerator / divisor, d: denominator / divisor };
  }

  function ratAdd(a, b) {
    return rational(a.n * b.d + b.n * a.d, a.d * b.d);
  }

  function ratSub(a, b) {
    return rational(a.n * b.d - b.n * a.d, a.d * b.d);
  }

  function ratMul(a, b) {
    return rational(a.n * b.n, a.d * b.d);
  }

  function ratDiv(a, b) {
    if (b.n === ZERO) fail('Division by zero is not a money operation', 'division_by_zero');
    return rational(a.n * b.d, a.d * b.n);
  }

  function ratCmp(a, b) {
    var left = a.n * b.d;
    var right = b.n * a.d;
    return left < right ? -1 : (left > right ? 1 : 0);
  }

  function power10(scale) {
    return TEN ** BigInt(scale);
  }

  function ensureScale(scale) {
    if (!Number.isInteger(scale) || scale < 0 || scale > MAX_DIVISION_SCALE) {
      fail('Decimal precision must be an integer from 0 to ' + MAX_DIVISION_SCALE, 'invalid_precision');
    }
    return scale;
  }

  function decimalStringFromRational(value, scale, trim) {
    var requestedScale = scale;
    if (requestedScale === undefined || requestedScale === null) {
      requestedScale = MAX_DECIMAL_PLACES;
    }
    ensureScale(requestedScale);

    var negative = value.n < ZERO;
    var numerator = abs(value.n);
    var denominator = value.d;
    var factor = power10(requestedScale);
    var scaled = numerator * factor;
    var quotient = scaled / denominator;
    var remainder = scaled % denominator;

    // Round half-up away from zero at the requested precision.  Amounts are
    // magnitudes, but this also gives contribution the expected negative form.
    if (remainder * 2n >= denominator) quotient += ONE;

    var integerPart = quotient / factor;
    var fraction = requestedScale ? (quotient % factor).toString().padStart(requestedScale, '0') : '';
    var output = integerPart.toString();
    if (requestedScale > 0) {
      if (trim) {
        fraction = fraction.replace(/0+$/, '');
      }
      if (fraction) output += '.' + fraction;
    }
    if (negative && quotient !== ZERO) output = '-' + output;
    return output;
  }

  function canonicalRational(value) {
    return decimalStringFromRational(value, MAX_DECIMAL_PLACES, true);
  }

  function parseDecimalRecord(value, allowNegative) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string') {
      fail('Money must be supplied as a decimal string', 'decimal_string_required');
    }
    var text = value.trim();
    if (!text) return null;
    if (/[eE]/.test(text)) fail('Exponent notation is not accepted for money', 'exponent_not_allowed');
    var signedMatch = /^(-?)(?:(\d+)(?:\.(\d+))?|\.(\d+))$/.exec(text);
    if (!signedMatch) fail('Invalid decimal money value: ' + text, 'invalid_decimal');
    var sign = signedMatch[1] === '-' ? -1 : 1;
    if (sign < 0 && !allowNegative) fail('Money magnitudes cannot be negative', 'negative_magnitude');
    var integerPart = signedMatch[2] || '0';
    var fractionPart = signedMatch[3] || signedMatch[4] || '';
    if (integerPart.length > MAX_INTEGER_DIGITS) fail('Money integer part is too large', 'decimal_too_large');
    if (fractionPart.length > MAX_DECIMAL_PLACES) fail('Money precision exceeds the supported bound', 'decimal_too_precise');
    var allDigits = (integerPart + fractionPart).replace(/^0+(?=\d)/, '') || '0';
    var numerator = BigInt(allDigits) * BigInt(sign);
    var denominator = power10(fractionPart.length);
    var valueRational = rational(numerator, denominator);
    return {
      rational: valueRational,
      canonical: canonicalRational(valueRational),
      negative: sign < 0,
      scale: fractionPart.length
    };
  }

  function parseMagnitude(value) {
    var parsed = parseDecimalRecord(value, false);
    return parsed ? parsed.canonical : null;
  }

  function parseSigned(value) {
    var parsed = parseDecimalRecord(value, true);
    return parsed ? parsed.canonical : null;
  }

  function parseMagnitudeRecord(value, fieldName) {
    try {
      var parsed = parseDecimalRecord(value, false);
      if (!parsed && fieldName && value !== null && value !== undefined && String(value).trim() === '') {
        return null;
      }
      return parsed;
    } catch (error) {
      if (error instanceof DealerMoneyError && fieldName) {
        error.message = fieldName + ': ' + error.message;
      }
      throw error;
    }
  }

  function signedRecord(value, fieldName) {
    try {
      var parsed = parseDecimalRecord(value, true);
      return parsed;
    } catch (error) {
      if (error instanceof DealerMoneyError && fieldName) error.message = fieldName + ': ' + error.message;
      throw error;
    }
  }

  function roundRational(value, scale) {
    ensureScale(scale);
    var factor = power10(scale);
    var numerator = abs(value.n) * factor;
    var quotient = numerator / value.d;
    var remainder = numerator % value.d;
    if (remainder * 2n >= value.d) quotient += ONE;
    return value.n < ZERO ? -quotient : quotient;
  }

  function moneyString(value) {
    var decimal = typeof value === 'string' ? signedRecord(value, 'money') : value;
    var valueRational = decimal && decimal.rational ? decimal.rational : value;
    if (!valueRational || typeof valueRational.n !== 'bigint') fail('A rational value is required', 'rational_required');
    return decimalStringFromRational(valueRational, MONEY_SCALE, false);
  }

  function floorMoneyRational(value) {
    if (value.n < ZERO) {
      var negativeMagnitude = abs(value.n) * power10(MONEY_SCALE);
      var negativeQuotient = negativeMagnitude / value.d;
      if (negativeMagnitude % value.d !== ZERO) negativeQuotient += ONE;
      return decimalStringFromRational({ n: -negativeQuotient, d: power10(MONEY_SCALE) }, MONEY_SCALE, false);
    }
    var scaled = value.n * power10(MONEY_SCALE);
    var quotient = scaled / value.d;
    return decimalStringFromRational({ n: quotient, d: power10(MONEY_SCALE) }, MONEY_SCALE, false);
  }

  function floorMoney(value) {
    var parsed = signedRecord(value, 'money');
    if (!parsed) return null;
    return floorMoneyRational(parsed.rational);
  }

  function publicDecimalOperation(first, second, operation) {
    var a = signedRecord(first, 'first operand');
    var b = signedRecord(second, 'second operand');
    if (!a || !b) return null;
    var result;
    if (operation === 'add') result = ratAdd(a.rational, b.rational);
    else if (operation === 'subtract') result = ratSub(a.rational, b.rational);
    else if (operation === 'multiply') result = ratMul(a.rational, b.rational);
    else result = ratDiv(a.rational, b.rational);
    return canonicalRational(result);
  }

  function divide(first, second, precision) {
    var a = signedRecord(first, 'first operand');
    var b = signedRecord(second, 'second operand');
    if (!a || !b) return null;
    var scale = precision === undefined ? 50 : precision;
    ensureScale(scale);
    return decimalStringFromRational(ratDiv(a.rational, b.rational), scale, true);
  }

  function normaliseCurrency(value, fieldName) {
    if (typeof value !== 'string' || !/^[A-Za-z]{3}$/.test(value.trim())) {
      fail((fieldName || 'currency') + ' must be a three-letter currency code', 'invalid_currency');
    }
    return value.trim().toUpperCase();
  }

  function normaliseStatus(value, fieldName) {
    if (typeof value !== 'string' || VALID_STATUSES.indexOf(value) < 0) {
      fail((fieldName || 'status') + ' must be Unknown, Estimate, Posted or Not applicable', 'invalid_status');
    }
    return value;
  }

  function normaliseEffect(value, fieldName) {
    if (typeof value !== 'string' || VALID_EFFECTS.indexOf(value) < 0) {
      fail((fieldName || 'effect') + ' must be debit or credit', 'invalid_effect');
    }
    return value;
  }

  function normaliseType(value, fieldName) {
    if (typeof value !== 'string' || !TYPE_RE.test(value) || DEFAULT_TYPES.indexOf(value) < 0) {
      fail((fieldName || 'type') + ' must be a lowercase snake-case type', 'invalid_type');
    }
    return value;
  }

  function validateTypeEffect(type, effect) {
    var allowedEffects = TYPE_EFFECTS[type];
    if (!allowedEffects || allowedEffects.indexOf(effect) < 0) {
      fail('Effect ' + effect + ' is not valid for type ' + type, 'invalid_type_effect');
    }
  }

  function normaliseDate(value, fieldName) {
    if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
      fail((fieldName || 'observedAt') + ' must be a parseable timestamp', 'invalid_timestamp');
    }
    return value.trim();
  }

  function validateFxMetadata(fx, allowLineSettledCurrency) {
    if (fx === null || fx === undefined) return null;
    if (!isObject(fx)) fail('FX metadata must be an object', 'invalid_fx');
    var base = normaliseCurrency(fx.base, 'fx.base');
    var quote = normaliseCurrency(fx.quote, 'fx.quote');
    if (base === quote) fail('FX base and quote currencies must differ', 'invalid_fx_direction');
    var rate = parseMagnitudeRecord(fx.rate, 'fx.rate');
    if (!rate || rate.rational.n <= ZERO) fail('FX rate must be greater than zero', 'invalid_fx_rate');
    if (typeof fx.source !== 'string' || !fx.source.trim()) fail('FX source is required', 'invalid_fx_source');
    var observedAt = normaliseDate(fx.observedAt, 'fx.observedAt');
    var out = {
      base: base,
      quote: quote,
      rate: rate.canonical,
      source: fx.source.trim(),
      observedAt: observedAt
    };
    if (fx.settledBaseAmount !== undefined && fx.settledBaseAmount !== null && String(fx.settledBaseAmount).trim() !== '') {
      if (fx.settledCurrency === undefined && !allowLineSettledCurrency) {
        fail('A settled amount requires an explicit settledCurrency', 'settled_currency_required');
      }
      if (fx.settledCurrency !== undefined) out.settledCurrency = normaliseCurrency(fx.settledCurrency, 'fx.settledCurrency');
    } else if (fx.settledCurrency !== undefined) {
      out.settledCurrency = normaliseCurrency(fx.settledCurrency, 'fx.settledCurrency');
    }
    if (fx.precision !== undefined) {
      if (!Number.isInteger(fx.precision) || fx.precision < 0 || fx.precision > MAX_DECIMAL_PLACES) {
        fail('fx.precision must be a bounded non-negative integer', 'invalid_fx_precision');
      }
      out.precision = fx.precision;
    }
    if (fx.settledBaseAmount !== undefined && fx.settledBaseAmount !== null && String(fx.settledBaseAmount).trim() !== '') {
      var settled = parseMagnitudeRecord(fx.settledBaseAmount, 'fx.settledBaseAmount');
      out.settledBaseAmount = settled.canonical;
    }
    return out;
  }

  function normaliseMoneyLine(line) {
    if (!isObject(line)) fail('A monetary line must be an object', 'invalid_line');
    var status = normaliseStatus(line.status, 'line.status');
    var currency = normaliseCurrency(line.currency, 'line.currency');
    var effect = normaliseEffect(line.effect, 'line.effect');
    var type = normaliseType(line.type, 'line.type');
    validateTypeEffect(type, effect);
    var amount = parseMagnitudeRecord(line.amount, 'line.amount');

    if (status === 'Unknown') {
      if (amount) fail('Unknown lines must not carry a known amount', 'unknown_amount_conflict');
      amount = null;
    } else if (status === 'Not applicable') {
      if (amount && amount.rational.n !== ZERO) fail('Not applicable lines must contribute zero', 'not_applicable_nonzero');
      amount = { rational: { n: ZERO, d: ONE }, canonical: '0' };
    } else if (!amount) {
      fail('Estimate and Posted lines require an amount', 'amount_required');
    }

    var fx = validateFxMetadata(line.fx, true);
    var topLevelSettled = null;
    var topLevelSettledCurrency = line.settledCurrency === undefined ? null : normaliseCurrency(line.settledCurrency, 'line.settledCurrency');
    if (line.settledBaseAmount !== undefined && line.settledBaseAmount !== null && String(line.settledBaseAmount).trim() !== '') {
      topLevelSettled = parseMagnitudeRecord(line.settledBaseAmount, 'line.settledBaseAmount');
      if (fx && fx.settledBaseAmount && fx.settledBaseAmount !== topLevelSettled.canonical) {
        fail('FX and line settled amounts disagree', 'settled_amount_conflict');
      }
      if (!topLevelSettledCurrency && !(fx && fx.settledCurrency)) {
        fail('A settled amount requires an explicit settledCurrency', 'settled_currency_required');
      }
    }
    var settledBaseAmount = topLevelSettled ? topLevelSettled.canonical : (fx && fx.settledBaseAmount ? fx.settledBaseAmount : null);
    var settledCurrency = topLevelSettledCurrency || (fx && fx.settledCurrency ? fx.settledCurrency : null);
    if (settledBaseAmount !== null && !settledCurrency) {
      fail('A settled amount requires an explicit settledCurrency', 'settled_currency_required');
    }
    if (topLevelSettledCurrency && fx && fx.settledCurrency && topLevelSettledCurrency !== fx.settledCurrency) {
      fail('FX and line settled currencies disagree', 'settled_currency_conflict');
    }
    if (settledBaseAmount !== null && status !== 'Posted') {
      fail('Settled amounts require Posted status', 'settled_status_conflict');
    }

    var out = {
      amount: amount ? amount.canonical : null,
      currency: currency,
      status: status,
      effect: effect,
      type: type
    };
    if (fx) out.fx = fx;
    if (settledBaseAmount !== null) out.settledBaseAmount = settledBaseAmount;
    if (settledCurrency !== null) out.settledCurrency = settledCurrency;
    if (line.id !== undefined) out.id = line.id;
    if (line.name !== undefined) out.name = line.name;
    if (line.description !== undefined) out.description = line.description;
    if (line.reference !== undefined) out.reference = line.reference;
    return out;
  }

  function validateMoneyLine(line) {
    try {
      var normalised = normaliseMoneyLine(line);
      return { valid: true, ok: true, errors: [], line: normalised };
    } catch (error) {
      return {
        valid: false,
        ok: false,
        errors: [{ code: error.code || 'invalid_line', message: error.message }]
      };
    }
  }

  function assertMoneyLine(line) {
    return normaliseMoneyLine(line);
  }

  function conversionOptions(options) {
    if (typeof options === 'string') return { reportingCurrency: normaliseCurrency(options, 'reportingCurrency') };
    var input = isObject(options) ? options : {};
    return {
      reportingCurrency: normaliseCurrency(input.reportingCurrency || input.destinationCurrency || DEFAULT_REPORTING_CURRENCY, 'reportingCurrency'),
      fx: input.fx === undefined ? null : validateFxMetadata(input.fx)
    };
  }

  function conversionRational(line, options) {
    if (line.status === 'Unknown') return { rational: null, basis: 'unknown' };
    if (line.status === 'Not applicable') return { rational: { n: ZERO, d: ONE }, basis: 'not_applicable' };

    var settled = line.settledBaseAmount;
    if (settled !== null && settled !== undefined) {
      if (line.settledCurrency !== options.reportingCurrency) {
        fail('Settled amount currency ' + line.settledCurrency + ' does not match reporting currency ' + options.reportingCurrency, 'settled_currency_mismatch');
      }
      return { rational: parseMagnitudeRecord(settled, 'settledBaseAmount').rational, basis: 'settled' };
    }

    var amount = parseMagnitudeRecord(line.amount, 'line.amount');
    var reporting = options.reportingCurrency;
    if (line.currency === reporting) return { rational: amount.rational, basis: 'same_currency' };

    var fx = line.fx || options.fx;
    if (!fx) return { rational: null, basis: 'missing_fx' };
    if (fx.base === line.currency && fx.quote === reporting) {
      return {
        rational: ratMul(amount.rational, parseMagnitudeRecord(fx.rate, 'fx.rate').rational),
        basis: 'converted'
      };
    }
    if (fx.quote === line.currency && fx.base === reporting) {
      // Division uses the original rational rate, never its rounded display.
      return {
        rational: ratDiv(amount.rational, parseMagnitudeRecord(fx.rate, 'fx.rate').rational),
        basis: 'inverse_converted'
      };
    }
    fail('FX metadata does not describe line currency ' + line.currency + ' and reporting currency ' + reporting, 'fx_direction_mismatch');
  }

  function convertLine(line, options) {
    var normalised = normaliseMoneyLine(line);
    var opts = conversionOptions(options);
    var conversion = conversionRational(normalised, opts);
    var output = {
      amount: normalised.amount,
      currency: normalised.currency,
      status: normalised.status,
      effect: normalised.effect,
      type: normalised.type,
      reportingCurrency: opts.reportingCurrency,
      sourceAmount: normalised.amount,
      sourceCurrency: normalised.currency,
      convertedAmount: conversion.rational === null ? null : moneyString(conversion.rational),
      reportingAmount: conversion.rational === null ? null : moneyString(conversion.rational),
      exactConvertedAmount: conversion.rational === null ? null : canonicalRational(conversion.rational),
      basis: conversion.basis,
      known: conversion.rational !== null
    };
    if (normalised.fx) output.fx = normalised.fx;
    if (normalised.settledBaseAmount !== undefined) output.settledBaseAmount = normalised.settledBaseAmount;
    if (normalised.settledCurrency !== undefined) output.settledCurrency = normalised.settledCurrency;
    if (conversion.rational !== null) {
      // The display decimal is bounded for JSON and UI use.  These decimal
      // strings preserve the exact internal rational for later aggregation.
      output.exactNumerator = conversion.rational.n.toString();
      output.exactDenominator = conversion.rational.d.toString();
    }
    if (normalised.id !== undefined) output.id = normalised.id;
    if (normalised.name !== undefined) output.name = normalised.name;
    if (normalised.description !== undefined) output.description = normalised.description;
    if (normalised.reference !== undefined) output.reference = normalised.reference;
    return output;
  }

  function signedLineRational(converted, exact) {
    var amount = parseMagnitudeRecord(exact ? converted.exactConvertedAmount : converted.convertedAmount, 'convertedAmount');
    return converted.effect === 'credit' ? { n: -amount.rational.n, d: amount.rational.d } : amount.rational;
  }

  function convertLines(lines, options) {
    if (!Array.isArray(lines)) fail('convertLines expects an array', 'lines_required');
    var opts = conversionOptions(options);
    var normalisedLines = lines.map(normaliseMoneyLine);
    var conversionRecords = normalisedLines.map(function (line) { return conversionRational(line, opts); });
    var converted = normalisedLines.map(function (line) { return convertLine(line, opts); });
    var unknown = conversionRecords.some(function (conversion) { return conversion.rational === null; });
    if (unknown) {
      return {
        status: 'Unknown',
        reportingCurrency: opts.reportingCurrency,
        lines: converted,
        total: null,
        exactTotal: null,
        exactTotalNumerator: null,
        exactTotalDenominator: null,
        grossRoundedTotal: null,
        residualAdjustment: null,
        adjustments: [],
        known: false
      };
    }

    var exactTotal = { n: ZERO, d: ONE };
    var roundedLineTotal = { n: ZERO, d: ONE };
    converted.forEach(function (line, index) {
      exactTotal = ratAdd(exactTotal, signedByEffect(conversionRecords[index].rational, line.effect));
      var roundedRecord = signedRecord(line.convertedAmount, 'rounded line amount');
      roundedLineTotal = ratAdd(roundedLineTotal, line.effect === 'credit' ? { n: -abs(roundedRecord.rational.n), d: roundedRecord.rational.d } : roundedRecord.rational);
    });
    var roundedTarget = signedRecord(moneyString(exactTotal), 'rounded target').rational;
    var residual = ratSub(roundedLineTotal, roundedTarget);
    var residualCents = roundRational(residual, MONEY_SCALE);
    var residualAdjustment = null;
    var adjustments = [];
    if (residualCents !== ZERO) {
      var lastIndex = converted.length - 1;
      if (lastIndex < 0) fail('Cannot allocate a rounding residual without lines', 'empty_lines');
      var adjustmentEffect = residualCents > ZERO ? 'credit' : 'debit';
      var adjustment = {
        amount: decimalStringFromRational({ n: abs(residualCents), d: power10(MONEY_SCALE) }, MONEY_SCALE, false),
        currency: opts.reportingCurrency,
        status: 'Estimate',
        effect: adjustmentEffect,
        type: 'rounding_adjustment',
        name: 'Rounding residual',
        description: 'Named residual allocated to the final converted line',
        lineIndex: lastIndex
      };
      residualAdjustment = adjustment;
      adjustments.push(adjustment);
      converted = converted.map(function (line, index) {
        if (index !== lastIndex) return line;
        var copy = Object.assign({}, line);
        copy.adjustments = [Object.assign({}, adjustment)];
        var signedLine = signedLineRational(line);
        // The signed residual is the amount needed to bring the rounded line
        // sum to the rounded total, hence it is the inverse of lineSum-target.
        var signedAdjustment = { n: -residualCents, d: power10(MONEY_SCALE) };
        var netSigned = ratAdd(signedLine, signedAdjustment);
        copy.netConvertedAmount = moneyString({ n: abs(netSigned.n), d: netSigned.d });
        copy.netSignedConvertedAmount = moneyString(netSigned);
        return copy;
      });
    }

    var allNotApplicable = converted.length > 0 && converted.every(function (line) { return line.status === 'Not applicable'; });
    // exactTotal remains a bounded decimal compatibility field for display.
    // Use the aggregate numerator and denominator for exact rational work.
    return {
      status: allNotApplicable ? 'Not applicable' : (converted.some(function (line) { return line.status === 'Estimate'; }) ? 'Estimate' : 'Posted'),
      reportingCurrency: opts.reportingCurrency,
      lines: converted,
      total: moneyString(roundedTarget),
      exactTotal: canonicalRational(exactTotal),
      exactTotalNumerator: exactTotal.n.toString(),
      exactTotalDenominator: exactTotal.d.toString(),
      grossRoundedTotal: moneyString(roundedLineTotal),
      residualAdjustment: residualAdjustment,
      adjustments: adjustments,
      known: true
    };
  }

  function valueIsPresent(input, key) {
    return input && Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;
  }

  function firstValue(input, keys) {
    for (var index = 0; index < keys.length; index += 1) {
      if (valueIsPresent(input, keys[index])) return { found: true, key: keys[index], value: input[keys[index]] };
    }
    return { found: false, key: null, value: undefined };
  }

  function hasAnyLineField(value) {
    return ['currency', 'effect', 'type', 'fx', 'settledBaseAmount', 'settledCurrency'].some(function (key) {
      return Object.prototype.hasOwnProperty.call(value, key);
    });
  }

  function signedByEffect(valueRational, effect) {
    return effect === 'credit' ? { n: -valueRational.n, d: valueRational.d } : valueRational;
  }

  function assertContainerContract(line, fieldName, contract) {
    if (!contract) return;
    if (contract.effect && line.effect !== contract.effect) {
      fail(fieldName + ' requires ' + contract.effect + ' lines', 'container_effect_mismatch', {
        field: fieldName,
        expectedEffect: contract.effect,
        actualEffect: line.effect
      });
    }
    if (contract.type && line.type !== contract.type) {
      fail(fieldName + ' requires type ' + contract.type, 'container_type_mismatch', {
        field: fieldName,
        expectedType: contract.type,
        actualType: line.type
      });
    }
  }

  function componentRecord(value, fieldName, reportingCurrency, mode, contract) {
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      return { known: false, rational: null, reason: fieldName + '_unknown' };
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return { known: true, rational: { n: ZERO, d: ONE } };
      var total = { n: ZERO, d: ONE };
      for (var index = 0; index < value.length; index += 1) {
        var child = componentRecord(value[index], fieldName + '[' + index + ']', reportingCurrency, mode, contract);
        if (!child.known) return child;
        total = ratAdd(total, child.rational);
      }
      return { known: true, rational: total };
    }
    if (isObject(value)) {
      if (hasAnyLineField(value)) {
        var structuredLine = normaliseMoneyLine(value);
        assertContainerContract(structuredLine, fieldName, contract);
        var structuredConversion = conversionRational(structuredLine, { reportingCurrency: reportingCurrency, fx: null });
        if (structuredLine.status === 'Unknown' || structuredConversion.rational === null) {
          return { known: false, rational: null, reason: fieldName + (mode === 'actual' && structuredLine.currency !== reportingCurrency ? '_needs_settlement' : '_unknown') };
        }
        if (structuredLine.status === 'Not applicable') {
          return { known: true, rational: { n: ZERO, d: ONE }, notApplicable: true };
        }
        if (mode === 'actual' && structuredLine.status === 'Estimate') {
          return { known: false, rational: null, reason: fieldName + '_unsettled' };
        }
        if (mode === 'actual' && structuredLine.currency !== reportingCurrency && (structuredLine.settledBaseAmount === null || structuredLine.settledBaseAmount === undefined)) {
          return { known: false, rational: null, reason: fieldName + '_needs_settlement' };
        }
        var applyEffectSign = contract && contract.netEffects === true;
        return { known: true, rational: applyEffectSign ? signedByEffect(structuredConversion.rational, structuredLine.effect) : structuredConversion.rational, status: structuredLine.status };
      }

      // A compact wrapper is allowed for values already in the reporting
      // currency.  Validate its status and amount before branching so an
      // Unknown/Not applicable wrapper cannot hide a non-zero amount.
      var status = value.status;
      if (status !== undefined) status = normaliseStatus(status, fieldName + '.status');
      var rawAmount = value.reportingAmount !== undefined ? value.reportingAmount : (value.convertedAmount !== undefined ? value.convertedAmount : value.amount);
      var parsedObjectAmount = parseMagnitudeRecord(rawAmount, fieldName);
      if (status === 'Unknown') {
        if (parsedObjectAmount) fail(fieldName + ': Unknown values must not carry a known amount', 'unknown_amount_conflict');
        return { known: false, rational: null, reason: fieldName + '_unknown' };
      }
      if (status === 'Not applicable') {
        if (parsedObjectAmount && parsedObjectAmount.rational.n !== ZERO) fail(fieldName + ': Not applicable values must contribute zero', 'not_applicable_nonzero');
        return { known: true, rational: { n: ZERO, d: ONE }, notApplicable: true };
      }
      if (mode === 'actual' && status === 'Estimate') return { known: false, rational: null, reason: fieldName + '_unsettled' };
      if (!parsedObjectAmount) return { known: false, rational: null, reason: fieldName + '_unknown' };
      return { known: true, rational: parsedObjectAmount.rational, status: status };
    }
    var parsed = parseMagnitudeRecord(value, fieldName);
    return parsed ? { known: true, rational: parsed.rational } : { known: false, rational: null, reason: fieldName + '_unknown' };
  }

  function fieldValue(input, aliases, fieldName, reportingCurrency, mode, contract) {
    var picked = firstValue(input, aliases);
    if (!picked.found) return { known: false, rational: null, reason: fieldName + '_unknown' };
    return componentRecord(picked.value, fieldName, reportingCurrency, mode, contract);
  }

  function checkRefundRiskDuplication(input) {
    var refund = firstValue(input, ['expectedRefundAllowance', 'refundAllowance']);
    var risk = firstValue(input, ['riskAllowance']);
    function walk(value, path) {
      if (Array.isArray(value)) {
        value.forEach(function (item, index) { walk(item, path + '[' + index + ']'); });
        return;
      }
      if (!isObject(value)) return;
      if (value.type === 'refund_allowance' || value.includesRefundAllowance === true) {
        fail('Refund allowance cannot also be counted in risk allowance', 'refund_risk_double_count', { path: path });
      }
      if (Array.isArray(value.components)) walk(value.components, path + '.components');
    }
    if (refund.found) {
      var other = firstValue(input, ['otherExpectedDeductions', 'otherDeductions']);
      if (other.found) walk(other.value, 'otherDeductions');
    }
    if (risk.found) walk(risk.value, 'riskAllowance');
  }

  function outputAmount(value) {
    return value === null ? null : moneyString(value);
  }

  function calculateExpectedEconomics(input) {
    if (!isObject(input)) fail('Expected economics requires an object', 'planning_input_required');
    var reportingCurrency = normaliseCurrency(input.reportingCurrency || input.destinationCurrency || DEFAULT_REPORTING_CURRENCY, 'reportingCurrency');
    checkRefundRiskDuplication(input);

    var sale = fieldValue(input, ['expectedSaleAmount', 'saleAmount', 'expectedSale'], 'expectedSaleAmount', reportingCurrency, 'planned', { effect: 'credit', type: 'proceeds' });
    var fee = fieldValue(input, ['expectedSellingFee', 'sellingFee', 'fee'], 'sellingFee', reportingCurrency, 'planned', { effect: 'debit' });
    var shipping = fieldValue(input, ['expectedOutboundShipping', 'outboundShipping', 'shipping'], 'outboundShipping', reportingCurrency, 'planned', { effect: 'debit' });
    var refund = fieldValue(input, ['expectedRefundAllowance', 'refundAllowance'], 'refundAllowance', reportingCurrency, 'planned', { effect: 'debit' });
    var other = fieldValue(input, ['otherExpectedDeductions', 'otherDeductions'], 'otherDeductions', reportingCurrency, 'planned', { netEffects: true });
    var target = fieldValue(input, ['targetContribution', 'targetMargin'], 'targetContribution', reportingCurrency, 'planned', { effect: 'debit' });
    var risk = fieldValue(input, ['riskAllowance'], 'riskAllowance', reportingCurrency, 'planned', { effect: 'debit' });
    var nonItem = fieldValue(input, ['knownNonItemAcquisitionCosts', 'knownNonItemCosts', 'nonItemAcquisitionCosts'], 'knownNonItemAcquisitionCosts', reportingCurrency, 'planned', { netEffects: true });

    var unknownFields = [];
    [sale, fee, shipping, refund, other, target, risk, nonItem].forEach(function (field) {
      if (!field.known) unknownFields.push(field.reason.replace(/_unknown$/, '').replace(/_unsettled$/, ''));
    });
    var expectedNet = null;
    if (sale.known && fee.known && shipping.known && refund.known && other.known) {
      expectedNet = ratSub(ratSub(ratSub(ratSub(sale.rational, fee.rational), shipping.rational), refund.rational), other.rational);
    }
    var maximumAllIn = null;
    if (expectedNet && target.known && risk.known) {
      maximumAllIn = ratSub(ratSub(expectedNet, target.rational), risk.rational);
    }
    var itemCeiling = null;
    if (maximumAllIn && nonItem.known) {
      var rawItem = ratSub(maximumAllIn, nonItem.rational);
      // A ceiling is a maximum spend.  Negative room is therefore reported as
      // zero while the exact negative result remains inspectable separately.
      itemCeiling = ratCmp(rawItem, { n: ZERO, d: ONE }) < 0 ? '0.00' : floorMoneyRational(rawItem);
    }
    return {
      reportingCurrency: reportingCurrency,
      status: unknownFields.length ? 'Unknown' : 'Known',
      unknownFields: unknownFields,
      expectedSaleAmount: outputAmount(sale.rational),
      sellingFee: outputAmount(fee.rational),
      outboundShipping: outputAmount(shipping.rational),
      refundAllowance: outputAmount(refund.rational),
      otherDeductions: outputAmount(other.rational),
      targetContribution: outputAmount(target.rational),
      riskAllowance: outputAmount(risk.rational),
      knownNonItemAcquisitionCosts: outputAmount(nonItem.rational),
      expectedNetProceeds: outputAmount(expectedNet),
      maximumAllInAcquisitionCost: maximumAllIn ? canonicalRational(maximumAllIn) : null,
      maximumAllInAcquisitionCostRounded: maximumAllIn ? floorMoneyRational(maximumAllIn) : null,
      rawItemPriceCeiling: maximumAllIn && nonItem.known ? canonicalRational(ratSub(maximumAllIn, nonItem.rational)) : null,
      itemPriceCeiling: itemCeiling,
      itemCeiling: itemCeiling,
      refundAllowanceCountedOnce: true,
      formula: 'expected sale - selling fee - outbound shipping - refund allowance - other deductions',
      ceilingFormula: 'expected net proceeds - target contribution - risk allowance - known non-item acquisition costs'
    };
  }

  function actualComponent(input, aliases, fieldName, reportingCurrency, contract) {
    var picked = firstValue(input, aliases);
    if (!picked.found) return { known: false, rational: null, reason: fieldName + '_unknown' };
    return componentRecord(picked.value, fieldName, reportingCurrency, 'actual', contract);
  }

  function adjustmentTotal(value, fieldName, reportingCurrency, contract) {
    if (value === undefined) return { known: false, rational: null, reason: fieldName + '_unknown' };
    return componentRecord(value, fieldName, reportingCurrency, 'actual', contract);
  }

  function calculateActualContribution(input) {
    if (!isObject(input)) fail('Actual contribution requires an object', 'actual_input_required');
    if (valueIsPresent(input, 'refundAllowance') || valueIsPresent(input, 'expectedRefundAllowance')) {
      fail('Actual contribution takes refunds through debitAdjustments once', 'refund_risk_double_count');
    }
    var reportingCurrency = normaliseCurrency(input.reportingCurrency || input.destinationCurrency || DEFAULT_REPORTING_CURRENCY, 'reportingCurrency');
    var proceeds = actualComponent(input, ['realisedProceeds', 'realizedProceeds', 'income', 'actualIncome', 'proceeds'], 'realisedProceeds', reportingCurrency, { effect: 'credit', type: 'proceeds' });
    var landed = actualComponent(input, ['canonicalLandedCost', 'landedCost', 'actualLandedCost'], 'canonicalLandedCost', reportingCurrency, { netEffects: true });
    var fee = actualComponent(input, ['sellingFee', 'actualSellingFee'], 'sellingFee', reportingCurrency, { effect: 'debit' });
    var shipping = actualComponent(input, ['outboundShipping', 'actualOutboundShipping'], 'outboundShipping', reportingCurrency, { effect: 'debit' });
    var credits = adjustmentTotal(input.creditAdjustments !== undefined ? input.creditAdjustments : input.credits, 'creditAdjustments', reportingCurrency, { effect: 'credit' });
    var debits = adjustmentTotal(input.debitAdjustments !== undefined ? input.debitAdjustments : input.debits, 'debitAdjustments', reportingCurrency, { effect: 'debit' });
    var fields = [proceeds, landed, fee, shipping, credits, debits];
    var unknownFields = [];
    fields.forEach(function (field) { if (!field.known) unknownFields.push(field.reason.replace(/_unknown$/, '').replace(/_unsettled$/, '')); });
    var contribution = null;
    if (unknownFields.length === 0) {
      contribution = ratSub(ratSub(ratSub(ratAdd(ratSub(proceeds.rational, landed.rational), credits.rational), fee.rational), shipping.rational), debits.rational);
    }
    return {
      reportingCurrency: reportingCurrency,
      status: unknownFields.length ? 'Unknown' : 'Known',
      unknownFields: unknownFields,
      realisedProceeds: outputAmount(proceeds.rational),
      canonicalLandedCost: outputAmount(landed.rational),
      sellingFee: outputAmount(fee.rational),
      outboundShipping: outputAmount(shipping.rational),
      creditAdjustments: outputAmount(credits.rational),
      debitAdjustments: outputAmount(debits.rational),
      contribution: contribution ? moneyString(contribution) : null,
      formula: 'realised proceeds - canonical landed cost - selling fee - outbound shipping + credits - debits',
      settlementRequired: true,
      inferredSettlement: false
    };
  }

  var api = {
    DEFAULT_REPORTING_CURRENCY: DEFAULT_REPORTING_CURRENCY,
    MONEY_SCALE: MONEY_SCALE,
    MAX_DECIMAL_PLACES: MAX_DECIMAL_PLACES,
    VALID_STATUSES: VALID_STATUSES.slice(),
    VALID_EFFECTS: VALID_EFFECTS.slice(),
    TYPES: DEFAULT_TYPES.slice(),
    DealerMoneyError: DealerMoneyError,
    parseDecimal: parseMagnitude,
    parseMagnitude: parseMagnitude,
    parseSigned: parseSigned,
    formatMoney: function formatMoney(value) {
      var parsed = signedRecord(value, 'money');
      if (!parsed) return null;
      return moneyString(parsed.rational);
    },
    roundMoney: function roundMoney(value) {
      return api.formatMoney(value);
    },
    floorMoney: floorMoney,
    add: function add(first, second) { return publicDecimalOperation(first, second, 'add'); },
    subtract: function subtract(first, second) { return publicDecimalOperation(first, second, 'subtract'); },
    multiply: function multiply(first, second) { return publicDecimalOperation(first, second, 'multiply'); },
    divide: divide,
    validateFx: validateFxMetadata,
    validateMoneyLine: validateMoneyLine,
    validateLine: validateMoneyLine,
    assertMoneyLine: assertMoneyLine,
    convertAmount: function convertAmount(amount, currency, fx, reportingCurrency) {
      var line = {
        amount: amount,
        currency: currency,
        status: 'Estimate',
        effect: 'debit',
        type: 'other',
        fx: fx
      };
      return convertLine(line, { reportingCurrency: reportingCurrency || DEFAULT_REPORTING_CURRENCY });
    },
    convertLine: convertLine,
    convertLines: convertLines,
    calculateExpectedEconomics: calculateExpectedEconomics,
    expectedEconomics: calculateExpectedEconomics,
    planEconomics: calculateExpectedEconomics,
    calculateActualContribution: calculateActualContribution,
    actualContribution: calculateActualContribution
  };

  return Object.freeze(api);
}));
