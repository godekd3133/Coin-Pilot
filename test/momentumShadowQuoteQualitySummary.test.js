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
