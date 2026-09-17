'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./harness.js');

function inputField(key, value) {
  const listeners = new Map();
  return {
    dataset: { k: key },
    value: String(value == null ? '' : value),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type) {
      (listeners.get(type) || []).slice().forEach(fn => fn({ type, target: this }));
    },
  };
}

test('sealed totals: boxes and packs calculate rounded Unit Price × Quantity, including blank, zero and decimal edges', async () => {
  const { ctx } = await loadApp();
  for (const table of ['boosterBoxes', 'boosterPacks']) {
    assert.equal(ctx.kjrCalcSealedTotal('21.90', '3'), 65.7, table + ' accepts decimal sources');
    assert.equal(ctx.kjrCalcSealedTotal('$1.005', 1), 1.01, table + ' rounds to cents');
    assert.equal(ctx.kjrCalcSealedTotal('0', '3'), 0, table + ' keeps valid zero');
    assert.equal(ctx.kjrCalcSealedTotal('', '3'), '', table + ' leaves a blank unit price blank');
    assert.equal(ctx.kjrCalcSealedTotal('21', ''), '', table + ' leaves a blank quantity blank');
    assert.equal(ctx.kjrCalcSealedTotal('not-a-number', '3'), '', table + ' rejects malformed sources');
    assert.equal(ctx.kjrCalcSealedTotal('-1', '3'), '', table + ' rejects negative monetary sources');
  }
});

test('sealed totals: existing manual discount survives Save until a later Unit Price or Quantity edit', async () => {
  const item = { id: 'pack-manual', product: 'Discounted pack', status: 'Sealed', unitPrice: 218, qty: 1, totalPrice: '' };
  const { ctx, document } = await loadApp({ seed: { boosterPacks: [item] } });
  let fields = {
    unitPrice: inputField('unitPrice', 218),
    qty: inputField('qty', 1),
    totalPrice: inputField('totalPrice', ''),
  };
  document.querySelectorAll = selector => selector === '#kjr-modal-fields [data-k]' ? Object.values(fields) : [];

  const firstCtx = { dbKey: 'boosterPacks', item: ctx.DB.boosterPacks[0], isNew: false };
  ctx._kjrModalCtx = firstCtx;
  ctx._kjrWireSealedTotal(firstCtx);
  assert.equal(fields.totalPrice.value, '218', 'a blank existing total can be derived on open');
  fields.unitPrice.value = '219';
  fields.unitPrice.dispatch('input');
  assert.equal(fields.totalPrice.value, '219', 'a source edit recalculates immediately');
  fields.totalPrice.value = '200';
  ctx.kjrSaveModal();
  assert.equal(ctx.DB.boosterPacks[0].totalPrice, 200, 'a manual discount entered after the source edit is saved');

  fields = {
    unitPrice: inputField('unitPrice', 219),
    qty: inputField('qty', 1),
    totalPrice: inputField('totalPrice', 200),
  };
  const secondCtx = { dbKey: 'boosterPacks', item: ctx.DB.boosterPacks[0], isNew: false };
  ctx._kjrModalCtx = secondCtx;
  ctx._kjrWireSealedTotal(secondCtx);
  fields.qty.value = '3';
  fields.qty.dispatch('input');
  assert.equal(fields.totalPrice.value, '657', 'a later quantity edit replaces the prior manual discount');
  ctx.kjrSaveModal();
  assert.equal(ctx.DB.boosterPacks[0].totalPrice, 657, 'the later derived total is persisted');
});
