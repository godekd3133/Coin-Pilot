import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessMomentumShadowQuoteQuality,
  projectMomentumShadowQuote
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
