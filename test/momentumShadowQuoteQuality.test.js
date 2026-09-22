import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessMomentumShadowQuoteQuality,
  compactMomentumShadowQuote,
  projectMomentumShadowQuote,
  projectMomentumShadowQuoteExecutionEvidence,
  summarizeMomentumShadowQuoteExecutionEvidence
} from '../src/research/momentumShadowQuoteQuality.js';

test('quote projection calculates the best-level spread without inventing a fill', () => {
  const quote = projectMomentumShadowQuote('KRW-ADA', {
    timestamp: 1_700_000_000_000,
    orderbook_units: [{
      bid_price: 281,
      ask_price: 282,
      bid_size: 100,
      ask_size: 80
    }]
  });

  assert.equal(quote.market, 'KRW-ADA');
  assert.equal(quote.available, true);
  assert.equal(quote.bidPrice, 281);
  assert.equal(quote.askPrice, 282);
  assert.ok(Math.abs(quote.spreadPercent - 0.3552397868561279) < 1e-12);
  assert.equal(quote.timestamp, 1_700_000_000_000);
});

test('quote guard fails closed for a partial response or a spread above the ceiling', () => {
  const result = assessMomentumShadowQuoteQuality({
    markets: ['KRW-ADA', 'KRW-DOGE'],
    quotes: {
      'KRW-ADA': { available: true, spreadPercent: 0.2 },
      'KRW-DOGE': { available: true, spreadPercent: 0.8 }
    },
    maxSpreadPercent: 0.5
  });

  assert.equal(result.valid, false);
  assert.equal(result.reason, 'orderbook_spread_above_limit');
  assert.deepEqual(result.blockedMarkets, ['KRW-DOGE']);
  assert.deepEqual(result.missingMarkets, []);

  const missing = assessMomentumShadowQuoteQuality({
    markets: ['KRW-ADA', 'KRW-DOGE'],
    quotes: { 'KRW-ADA': { available: true, spreadPercent: 0.2 } },
    maxSpreadPercent: 0.5
  });
  assert.equal(missing.valid, false);
  assert.equal(missing.reason, 'orderbook_market_missing');
  assert.deepEqual(missing.missingMarkets, ['KRW-DOGE']);
});

test('quote guard preserves an explicitly disabled default', () => {
  const result = assessMomentumShadowQuoteQuality({
    markets: ['KRW-BTC'],
    quotes: {},
    maxSpreadPercent: 0
  });

  assert.equal(result.enabled, false);
  assert.equal(result.valid, true);
  assert.equal(result.reason, 'orderbook_guard_disabled');
});

test('quote boundary evidence estimates crossing drag and never claims an observed fill', () => {
  const entry = compactMomentumShadowQuote(projectMomentumShadowQuote('KRW-BTC', {
    timestamp: 1_700_000_000_000,
    bidPrice: 100,
    askPrice: 102,
    bidSize: 10,
    askSize: 10
  }));
  const exit = compactMomentumShadowQuote(projectMomentumShadowQuote('KRW-BTC', {
    timestamp: 1_700_100_000_000,
    bidPrice: 108,
    askPrice: 110,
    bidSize: 8,
    askSize: 8
  }));

  const evidence = projectMomentumShadowQuoteExecutionEvidence({
    entryQuote: entry,
    exitQuote: exit
  });
  assert.equal(evidence.available, true);
  assert.equal(evidence.reason, 'best_level_midpoint_crossing_model');
  assert.ok(Math.abs(evidence.entryCrossingDragPercent - (1 / 101 * 100)) < 1e-12);
  assert.ok(Math.abs(evidence.exitCrossingDragPercent - (1 / 109 * 100)) < 1e-12);
  assert.ok(evidence.estimatedCrossingDragPercent > 1.9);
  assert.equal(evidence.entryTimestamp, 1_700_000_000_000);
  assert.equal(evidence.exitTimestamp, 1_700_100_000_000);

  const missing = projectMomentumShadowQuoteExecutionEvidence({ entryQuote: entry });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, 'exit_quote_missing_or_invalid');

  const timestampMissing = compactMomentumShadowQuote(projectMomentumShadowQuote('KRW-BTC', {
    bidPrice: 108,
    askPrice: 110
  }));
  const unverifiable = projectMomentumShadowQuoteExecutionEvidence({
    entryQuote: entry,
    exitQuote: timestampMissing
  });
  assert.equal(unverifiable.available, false);
  assert.equal(unverifiable.reason, 'exit_quote_timestamp_missing_or_invalid');
});

test('quote execution evidence summary separates available models from missing boundaries', () => {
  const summary = summarizeMomentumShadowQuoteExecutionEvidence([
    { quoteExecutionEvidence: { available: true, estimatedCrossingDragPercent: 0.4 } },
    { quoteExecutionEvidence: { available: false } },
    { quoteExecutionEvidence: null }
  ]);

  assert.equal(summary.closedTradeCount, 3);
  assert.equal(summary.availableCount, 1);
  assert.equal(summary.missingCount, 2);
  assert.equal(summary.averageEstimatedCrossingDragPercent, 0.4);
  assert.equal(summary.maxEstimatedCrossingDragPercent, 0.4);
});
