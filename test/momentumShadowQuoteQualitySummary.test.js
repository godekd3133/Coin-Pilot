import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeMomentumShadowQuoteSamples
} from '../src/research/momentumShadowQuoteQuality.js';

test('quote sample summary preserves incomplete markets and calculates robust quantiles', () => {
  const result = summarizeMomentumShadowQuoteSamples({
    markets: ['KRW-BTC', 'KRW-DOGE'],
    maxSpreadPercent: 0.5,
    samples: [
      { quotes: [
        { market: 'KRW-BTC', spreadPercent: 0.1 },
        { market: 'KRW-DOGE', spreadPercent: 0.8 }
      ] },
      { quotes: [
        { market: 'KRW-BTC', spreadPercent: 0.2 }
      ] }
    ]
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.incompleteMarkets, ['KRW-DOGE']);
  assert.equal(result.markets['KRW-BTC'].sampleCount, 2);
  assert.equal(result.markets['KRW-DOGE'].sampleCount, 1);
  assert.equal(result.markets['KRW-DOGE'].overCeiling, 1);
  assert.equal(result.markets['KRW-BTC'].median, 0.15000000000000002);
});

test('empty quote samples are never reported as complete', () => {
  const result = summarizeMomentumShadowQuoteSamples({
    markets: ['KRW-BTC'],
    samples: [],
    maxSpreadPercent: 0.5
  });

  assert.equal(result.valid, false);
  assert.deepEqual(result.incompleteMarkets, ['KRW-BTC']);
});

test('quote summary retains best-level notional depth without changing spread completeness', () => {
  const result = summarizeMomentumShadowQuoteSamples({
    markets: ['KRW-BTC', 'KRW-ETH'],
    samples: [
      { quotes: [
        { market: 'KRW-BTC', available: true, bidPrice: 100, askPrice: 101, bidSize: 10, askSize: 5, spreadPercent: 0.995 },
        { market: 'KRW-ETH', available: true, bidPrice: 200, askPrice: 202, spreadPercent: 0.995 }
      ] },
      { quotes: [
        { market: 'KRW-BTC', available: true, bidPrice: 99, askPrice: 100, bidSize: 8, askSize: 7, spreadPercent: 1.005 },
        { market: 'KRW-ETH', available: true, bidPrice: 201, askPrice: 203, spreadPercent: 0.990 }
      ] }
    ]
  });

  assert.equal(result.valid, true);
  assert.equal(result.markets['KRW-BTC'].topOfBookDepth.bidSampleCount, 2);
  assert.equal(result.markets['KRW-BTC'].topOfBookDepth.askSampleCount, 2);
  assert.equal(result.markets['KRW-BTC'].topOfBookDepth.minimumBidNotionalKrw, 792);
  assert.equal(result.markets['KRW-BTC'].topOfBookDepth.minimumAskNotionalKrw, 505);
  assert.equal(result.markets['KRW-ETH'].topOfBookDepth.bidSampleCount, 0);
  assert.equal(result.markets['KRW-ETH'].topOfBookDepth.missingBidSampleCount, 2);
  assert.equal(result.markets['KRW-ETH'].sampleCount, 2);
  assert.ok(Math.abs(result.markets['KRW-ETH'].median - 0.9925) < 1e-12);
});
