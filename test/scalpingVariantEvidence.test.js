import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeVariantResults } from '../src/scripts/compareScalpingVariants.js';

function validVariant(market) {
  return {
    market,
    validation: {
      promoted: true,
      gate: { trainingGatePassed: true },
      tuning: { metrics: { totalReturnPercent: 0.2, tradeCount: 12, profitFactor: 1.2 } },
      validation: {
        totalReturnPercent: 0.1,
        netProfit: 100,
        tradeCount: 10,
        circuitBlockedEntries: 0,
        profitFactor: 1.1,
        maxDrawdownPercent: 1
      }
    }
  };
}

test('invalid market evidence is preserved and blocks variant promotion', () => {
  const summary = summarizeVariantResults([
    validVariant('KRW-BTC'),
    { market: 'KRW-ETH', error: 'historical_candle_gap' }
  ]);

  assert.equal(summary.attemptedMarketCount, 2);
  assert.equal(summary.marketCount, 1);
  assert.equal(summary.invalidMarketCount, 1);
  assert.deepEqual(summary.invalidMarkets, [
    { market: 'KRW-ETH', error: 'historical_candle_gap' }
  ]);
  assert.equal(summary.promoted, false);
  assert.equal(summary.promotionBlockedByInvalidMarkets, true);
});
