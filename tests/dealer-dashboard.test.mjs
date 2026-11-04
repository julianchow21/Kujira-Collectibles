import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const { loadApp } = createRequire(import.meta.url)('./harness.js');

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
