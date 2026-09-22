import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMomentumShadowRealizedProfit,
  calculateMomentumShadowRealizedReturnPercent,
  calculateMomentumShadowTradeConfidence,
  calculateMomentumShadowObservationDays,
  summarizeMomentumShadowTradesByMarket
} from '../src/research/momentumShadowProfitability.js';

test('momentum shadow profitability helper shares realized return and confidence semantics', () => {
  const ledger = {
    initialBalance: 1_000,
    trades: [
      { entry: { size: 100 }, profitPercent: 2 },
      { entry: { size: 200 }, profitPercent: -1 }
    ]
  };
  assert.equal(calculateMomentumShadowRealizedProfit(ledger), 0);
  assert.equal(calculateMomentumShadowRealizedReturnPercent(ledger), 0);
  const confidence = calculateMomentumShadowTradeConfidence(ledger);
  assert.equal(confidence.sampleCount, 2);
  assert.equal(confidence.meanReturnPercent, 0.5);
  assert.ok(confidence.lowerBoundPercent < confidence.meanReturnPercent);
});

test('momentum shadow confidence ignores malformed trade returns without inventing a sample', () => {
  const confidence = calculateMomentumShadowTradeConfidence({
    trades: [
      { entry: { size: 100 }, profitPercent: null },
      { entry: { size: 100 }, profitPercent: 1 }
    ]
  });
  assert.equal(confidence.sampleCount, 1);
  assert.equal(confidence.lowerBoundPercent, null);
});

test('momentum shadow profitability attributes realized results by market', () => {
  const byMarket = summarizeMomentumShadowTradesByMarket({
    trades: [
      { market: 'KRW-ETH', entry: { size: 100 }, profitPercent: 2 },
      { market: 'KRW-ETH', entry: { size: 100 }, profitPercent: -1 },
      { market: 'KRW-XRP', entry: { size: 200 }, profitPercent: -2 },
      { market: 'KRW-DOGE', entry: { size: 100 }, profitPercent: null }
    ]
  });
  assert.equal(byMarket['KRW-ETH'].tradeCount, 2);
  assert.equal(byMarket['KRW-ETH'].validReturnCount, 2);
  assert.equal(byMarket['KRW-ETH'].realizedProfit, 1);
  assert.equal(byMarket['KRW-ETH'].averageProfitPercent, 0.5);
  assert.equal(byMarket['KRW-XRP'].winningTrades, 0);
  assert.equal(byMarket['KRW-XRP'].losingTrades, 1);
  assert.equal(byMarket['KRW-XRP'].realizedProfit, -4);
  assert.equal(byMarket['KRW-DOGE'].tradeCount, 1);
  assert.equal(byMarket['KRW-DOGE'].validReturnCount, 0);
  assert.equal(byMarket['KRW-DOGE'].averageProfitPercent, null);
});

test('momentum shadow observation window rejects future or reversed boundaries', () => {
  const now = Date.parse('2026-09-16T00:00:00.000Z');
  assert.equal(calculateMomentumShadowObservationDays({
    startedAt: '2026-09-01T00:00:00.000Z',
    heartbeatAt: '2026-09-16T00:00:00.000Z'
  }, now), 15);
  assert.equal(calculateMomentumShadowObservationDays({
    startedAt: '2026-09-01T00:00:00.000Z',
    heartbeatAt: '2026-09-17T00:00:00.000Z'
  }, now), null);
  assert.equal(calculateMomentumShadowObservationDays({
    startedAt: '2026-09-17T00:00:00.000Z',
    heartbeatAt: '2026-09-16T00:00:00.000Z'
  }, now), null);
});
