import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeMomentumShadowLossCapCounterfactual
} from '../src/research/momentumShadowLossCapCounterfactual.js';

test('loss-cap counterfactual caps only completed-close losses and keeps observed evidence separate', () => {
  const result = summarizeMomentumShadowLossCapCounterfactual({
    trades: [
      { profitPercent: -9.2, entry: { size: 10_000_000 } },
      { profitPercent: -3, entry: { size: 10_000_000 } },
      { profitPercent: 2, entry: { size: 10_000_000 } }
    ],
    positions: {
      'KRW-XRP': { markProfitPercent: -7.17 },
      'KRW-NEAR': { markProfitPercent: -0.2 }
    }
  }, 6);

  assert.equal(result.researchOnly, true);
  assert.equal(result.promoted, false);
  assert.equal(result.closedTradeCount, 3);
  assert.equal(result.cappedTradeCount, 1);
  assert.equal(result.openPositionCount, 2);
  assert.equal(result.openAtOrBelowCapCount, 1);
  assert.equal(result.observedAverageReturnPercent, (-9.2 - 3 + 2) / 3);
  assert.equal(result.cappedAverageReturnPercent, (-6 - 3 + 2) / 3);
  assert.ok(Math.abs(result.estimatedProfitDelta - 320_000) < 1e-6);
  assert.equal(result.estimatedProfitDeltaAvailable, true);
});

test('loss-cap counterfactual does not invent a sample from malformed returns or sizes', () => {
  const result = summarizeMomentumShadowLossCapCounterfactual({
    trades: [
      { profitPercent: 'not-a-number', entry: { size: 10_000_000 } },
      { profitPercent: -8, entry: {} }
    ],
    positions: {}
  }, 6);

  assert.equal(result.closedTradeCount, 1);
  assert.equal(result.cappedTradeCount, 1);
  assert.equal(result.estimatedProfitDelta, null);
  assert.equal(result.estimatedProfitDeltaAvailable, false);
});
