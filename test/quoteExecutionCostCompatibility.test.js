import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessQuoteExecutionCostCompatibility,
  finiteCompatibilityNumber,
  parseCompatibilityMarkets,
  positiveCompatibilityNumber
} from '../src/research/quoteExecutionCostCompatibility.js';

function report(markets, overrides = {}) {
  return {
    generatedAt: '2026-09-17T20:00:00.000Z',
    complete: true,
    summary: {
      valid: true,
      markets: Object.fromEntries(markets.map(([market, p95, max = p95]) => [market, {
        sampleCount: 5,
        p95,
        max
      }]))
    },
    ...overrides
  };
}

test('compatibility keeps observed spread separate from modeled round-trip cost', () => {
  const result = assessQuoteExecutionCostCompatibility({
    report: report([
      ['KRW-BTC', 0.0265],
      ['KRW-XRP', 0.0718]
    ]),
    markets: ['KRW-BTC', 'KRW-XRP'],
    tradingFee: 0.0005,
    slippage: 0.001,
    minimumSamples: 5,
    maxAgeSeconds: 900,
    now: Date.parse('2026-09-17T20:05:00.000Z')
  });

  assert.equal(result.ready, true);
  assert.equal(result.reason, 'quote_compatibility_within_observed_budget');
  assert.equal(result.adverseSlippageBudgetPercent, 0.2);
  assert.equal(result.assumedRoundTripCostPercent, 0.3);
  assert.equal(result.rows[0].observedP95SpreadPercent, 0.0265);
  assert.equal(result.rows[0].p95WithinAdverseSlippageBudget, true);
  assert.match(result.note, /not fills/);
});

test('compatibility reports a market whose p95 exceeds the adverse-slippage budget', () => {
  const result = assessQuoteExecutionCostCompatibility({
    report: report([['KRW-DOGE', 0.25, 0.9]]),
    markets: ['KRW-DOGE'],
    tradingFee: 0.0005,
    slippage: 0.001,
    now: Date.parse('2026-09-17T20:05:00.000Z')
  });

  assert.equal(result.ready, false);
  assert.equal(result.reason, 'quote_compatibility_p95_above_adverse_slippage_budget');
  assert.equal(result.rows[0].status, 'P95_ABOVE_ADVERSE_SLIPPAGE_BUDGET');
  assert.equal(result.rows[0].p95WithinAdverseSlippageBudget, false);
  assert.equal(result.rows[0].observedMaxSpreadPercent, 0.9);
});

test('compatibility fails closed for stale, incomplete, or undersampled quote reports', () => {
  const stale = assessQuoteExecutionCostCompatibility({
    report: report([['KRW-BTC', 0.05]], { generatedAt: '2026-09-17T19:00:00.000Z' }),
    markets: ['KRW-BTC'],
    now: Date.parse('2026-09-17T20:05:00.000Z'),
    maxAgeSeconds: 900
  });
  assert.equal(stale.ready, false);
  assert.equal(stale.reason, 'quote_quality_report_stale');

  const incomplete = assessQuoteExecutionCostCompatibility({
    report: report([['KRW-BTC', 0.05]], { complete: false }),
    markets: ['KRW-BTC'],
    now: Date.parse('2026-09-17T20:05:00.000Z'),
    maxAgeSeconds: 900
  });
  assert.equal(incomplete.ready, false);
  assert.equal(incomplete.reason, 'quote_quality_report_incomplete');

  const undersampled = assessQuoteExecutionCostCompatibility({
    report: report([['KRW-BTC', 0.05]], {
      summary: { valid: true, markets: { 'KRW-BTC': { sampleCount: 2, p95: 0.05, max: 0.05 } } }
    }),
    markets: ['KRW-BTC'],
    now: Date.parse('2026-09-17T20:05:00.000Z'),
    minimumSamples: 5,
    maxAgeSeconds: 900
  });
  assert.equal(undersampled.ready, false);
  assert.equal(undersampled.reason, 'quote_compatibility_market_samples_insufficient_or_missing');
  assert.equal(undersampled.rows[0].status, 'INSUFFICIENT_SAMPLES');
});

test('compatibility helpers normalize explicit market lists and numeric settings', () => {
  assert.deepEqual(
    parseCompatibilityMarkets(' krw-btc,KRW-XRP,krw-btc ', ['KRW-ETH']),
    ['KRW-BTC', 'KRW-XRP']
  );
  assert.deepEqual(parseCompatibilityMarkets('', ['KRW-ETH']), ['KRW-ETH']);
  assert.equal(finiteCompatibilityNumber('0.001', 0), 0.001);
  assert.equal(finiteCompatibilityNumber('-1', 0.2), 0.2);
  assert.equal(positiveCompatibilityNumber('5', 1), 5);
  assert.equal(positiveCompatibilityNumber('0', 1), 1);
});
