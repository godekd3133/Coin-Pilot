import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectMarketQuoteFreshness,
  MARKET_QUOTE_FUTURE_TOLERANCE_MS
} from '../src/api/marketQuoteFreshness.js';

const now = Date.parse('2026-09-29T14:00:00.000Z');

function ticker(tradeTimestamp, overrides = {}) {
  return {
    market: 'KRW-BTC',
    trade_price: 60_000_000,
    trade_timestamp: tradeTimestamp,
    ...overrides
  };
}

test('market quote freshness normalizes Upbit millisecond timestamps and accepts the configured age boundary', () => {
  const result = inspectMarketQuoteFreshness(ticker(now - 90_000), {
    now,
    maximumAgeSeconds: 90
  });

  assert.equal(result.fresh, true);
  assert.equal(result.ageMs, 90_000);
  assert.equal(result.sourceAsOf, '2026-09-29T13:58:30.000Z');
});

test('market quote freshness rejects old trade timestamps even when the request was just fetched', () => {
  const result = inspectMarketQuoteFreshness(ticker(now - 600_000), {
    now,
    maximumAgeSeconds: 90
  });

  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'market_source_stale');
  assert.equal(result.ageMs, 600_000);
});

test('market quote freshness allows small clock skew but rejects timestamps beyond the future tolerance', () => {
  const withinTolerance = inspectMarketQuoteFreshness(ticker(now + 4_000), { now });
  const beyondTolerance = inspectMarketQuoteFreshness(ticker(now + MARKET_QUOTE_FUTURE_TOLERANCE_MS + 1), { now });

  assert.equal(withinTolerance.fresh, true);
  assert.equal(withinTolerance.ageMs, 0);
  assert.equal(beyondTolerance.fresh, false);
  assert.equal(beyondTolerance.reason, 'market_source_timestamp_in_future');
});

test('market quote freshness fails closed for a missing source timestamp or invalid price', () => {
  assert.equal(inspectMarketQuoteFreshness(ticker(null), { now }).reason, 'missing_market_source_timestamp');
  assert.equal(inspectMarketQuoteFreshness(ticker(now, { trade_price: 0 }), { now }).reason, 'invalid_market_quote');
});
