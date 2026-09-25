import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMomentumShadowTradeCostAudit } from '../src/research/momentumShadowTradeCostAudit.js';

function quoteReport(generatedAt, market, { median, p95, overrides = {} } = {}) {
  return {
    generatedAt,
    complete: true,
    sampleCount: 5,
    requestedSampleCount: 5,
    errors: 0,
    summary: {
      markets: {
        [market]: { median, p95 }
      }
    },
    ...overrides
  };
}

function assertApprox(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `expected ${actual} to be near ${expected}`);
}

function ledgerWithTrade({
  costPercent = 0.2,
  profitPercent = 1.25,
  size = 100_000,
  entryTimeMs = Date.parse('2026-09-22T00:06:00.000Z'),
  exitTs = '2026-09-22T00:00:00',
  market = 'KRW-NEAR',
  executionModel = 'candle_close',
  configDrift = null
} = {}) {
  return {
    active: true,
    config: { costPercent },
    configDrift,
    positions: { 'KRW-NEAR': { size: 50_000 } },
    trades: [{
      market,
      executionModel,
      entry: { entryTimeMs, entryTs: '2026-09-21T00:00:00', size },
      exitTs,
      profitPercent
    }]
  };
}

test('trade cost audit matches only prior complete quotes and keeps cost components separate', () => {
  const ledger = ledgerWithTrade({ configDrift: { changedAt: '2026-09-20T00:00:00.000Z' } });
  const result = summarizeMomentumShadowTradeCostAudit({
    ledger,
    quoteHistoryRecords: [
      quoteReport('2026-09-22T00:01:00.000Z', 'KRW-NEAR', { median: 0.2, p95: 0.3 }),
      quoteReport('2026-09-22T23:55:00.000Z', 'KRW-NEAR', { median: 0.4, p95: 0.6 })
    ],
    now: Date.parse('2026-09-23T00:05:00.000Z')
  });

  assert.equal(result.researchOnly, true);
  assert.equal(result.promoted, false);
  assert.equal(result.actualFillsObserved, false);
  assert.equal(result.ledger.configCostPercent, 0.2);
  assert.equal(result.ledger.requiredRoundTripCostPercent, 0.3);
  assert.ok(Math.abs(result.ledger.additionalCostToFloorPercent - 0.1) < 1e-9);
  assert.equal(result.ledger.configDrift, true);
  assert.equal(result.ledger.openPositionCount, 1);
  assert.equal(result.quoteHistory.latestFresh, true);
  assert.equal(result.quoteMatchedTradeCount, 1);
  assert.equal(result.unmatchedQuoteTradeCount, 0);
  assert.equal(result.spreadScenarioTradeCount, 1);

  const trade = result.trades[0];
  assert.equal(trade.exitExecutionTime, '2026-09-23T00:00:00.000Z');
  assert.equal(trade.entryQuoteMatch.ageSeconds, 300);
  assert.equal(trade.exitQuoteMatch.ageSeconds, 300);
  assertApprox(trade.roundTripSpreadMedianProxyPercent, 0.3);
  assertApprox(trade.roundTripSpreadReportP95ProxyPercent, 0.45);
  assert.ok(Math.abs(trade.additionalCostToFloorPercent - 0.1) < 1e-9);
  assertApprox(trade.costFloorStressNetPercent, 1.15);
  assertApprox(trade.medianSpreadScenarioNetPercent, 0.85);
  assertApprox(trade.reportP95SpreadScenarioNetPercent, 0.7);
  assertApprox(trade.medianSpreadScenarioNetKrw, 850);
  assertApprox(trade.reportP95SpreadScenarioNetKrw, 700);
  assertApprox(result.fullCohort.quoteSpreadAdjustedMedianScenarioNetPnlKrw, 850);
  assertApprox(result.fullCohort.quoteSpreadAdjustedReportP95ScenarioNetPnlKrw, 700);
  assertApprox(result.quoteMatchedSubset.medianSpreadScenarioNetPnlKrw, 850);
  assert.equal(result.promotionAllowed, false);
});

test('unmatched trades keep spread cost unknown instead of treating it as zero', () => {
  const target = Date.parse('2026-09-22T00:06:00.000Z');
  const futureOnly = quoteReport('2026-09-22T00:07:00.000Z', 'KRW-NEAR', {
    median: 0,
    p95: 0
  });
  const result = summarizeMomentumShadowTradeCostAudit({
    ledger: ledgerWithTrade({}),
    quoteHistoryRecords: [futureOnly],
    now: Date.parse('2026-09-23T00:10:00.000Z')
  });
  const trade = result.trades[0];

  assert.equal(result.quoteMatchedTradeCount, 0);
  assert.equal(result.unmatchedQuoteTradeCount, 1);
  assert.equal(result.spreadScenarioTradeCount, 0);
  assert.equal(trade.entryQuoteMatch.reason, 'no_prior_complete_quote_within_freshness_limit');
  assert.equal(trade.exitQuoteMatch.reason, 'no_prior_complete_quote_within_freshness_limit');
  assert.equal(trade.roundTripSpreadMedianProxyPercent, null);
  assert.equal(trade.medianSpreadScenarioNetKrw, null);
  assert.equal(result.quoteMatchedSubset.tradeCount, 0);
  assert.equal(result.fullCohort.quoteSpreadAdjustedMedianScenarioNetPnlKrw, null);
  assert.equal(result.fullCohort.unmatchedSpreadCostTradeCount, 1);
  assert.equal(Number.isFinite(target), true);
});

test('signal candle time is not substituted for a missing actual entry time', () => {
  const result = summarizeMomentumShadowTradeCostAudit({
    ledger: ledgerWithTrade({ entryTimeMs: null }),
    quoteHistoryRecords: [
      quoteReport('2026-09-20T23:55:00.000Z', 'KRW-NEAR', { median: 0.2, p95: 0.3 }),
      quoteReport('2026-09-22T23:55:00.000Z', 'KRW-NEAR', { median: 0.4, p95: 0.6 })
    ],
    now: Date.parse('2026-09-23T00:05:00.000Z')
  });

  assert.equal(result.trades[0].entryTime, null);
  assert.equal(result.trades[0].entryQuoteMatch.reason, 'event_timestamp_unavailable');
  assert.equal(result.trades[0].exitQuoteMatch.available, true);
  assert.equal(result.quoteMatchedTradeCount, 0);
  assert.equal(result.spreadScenarioTradeCount, 0);
});

test('incomplete, erroneous, undersampled, and stale quotes cannot match a trade event', () => {
  const event = Date.parse('2026-09-22T00:06:00.000Z');
  const result = summarizeMomentumShadowTradeCostAudit({
    ledger: ledgerWithTrade({}),
    quoteHistoryRecords: [
      quoteReport('2026-09-22T00:05:00.000Z', 'KRW-NEAR', {
        median: 0.2,
        p95: 0.3,
        overrides: { complete: false }
      }),
      quoteReport('2026-09-22T00:04:00.000Z', 'KRW-NEAR', {
        median: 0.2,
        p95: 0.3,
        overrides: { errors: 1 }
      }),
      quoteReport('2026-09-22T00:03:00.000Z', 'KRW-NEAR', {
        median: 0.2,
        p95: 0.3,
        overrides: { sampleCount: 2 }
      }),
      quoteReport('2026-09-21T23:45:00.000Z', 'KRW-NEAR', { median: 0.2, p95: 0.3 }),
      quoteReport('2026-09-23T00:05:00.000Z', 'KRW-NEAR', {
        median: 0.1,
        p95: 0.2,
        overrides: { complete: false }
      })
    ],
    now: Date.parse('2026-09-23T00:10:00.000Z')
  });

  assert.equal(Number.isFinite(event), true);
  assert.equal(result.quoteMatchedTradeCount, 0);
  assert.equal(result.spreadScenarioTradeCount, 0);
  assert.equal(result.quoteHistory.usableReportCount, 1);
  assert.equal(result.quoteHistory.latestFresh, true);
  assert.equal(result.quoteHistory.latestUsable, false);
  assert.equal(result.trades[0].entryQuoteMatch.available, false);
  assert.equal(result.trades[0].exitQuoteMatch.available, false);
});

test('quote history window does not imply freshness or promote an otherwise matched ledger', () => {
  const result = summarizeMomentumShadowTradeCostAudit({
    ledger: ledgerWithTrade({ costPercent: 0.4 }),
    quoteHistoryRecords: [
      quoteReport('2026-09-22T00:01:00.000Z', 'KRW-NEAR', { median: 0.2, p95: 0.3 }),
      quoteReport('2026-09-22T23:55:00.000Z', 'KRW-NEAR', { median: 0.4, p95: 0.6 })
    ],
    now: Date.parse('2026-09-24T00:00:00.000Z')
  });

  assert.equal(result.quoteHistory.latestFresh, false);
  assert.equal(result.quoteMatchedTradeCount, 1);
  assert.equal(result.spreadScenarioTradeCount, 1);
  assert.equal(result.ledger.additionalCostToFloorPercent, 0);
  assert.equal(result.promotionAllowed, false);
});

test('quote-cross ledgers are not charged the spread proxy a second time', () => {
  const result = summarizeMomentumShadowTradeCostAudit({
    ledger: ledgerWithTrade({ executionModel: 'quote_cross' }),
    quoteHistoryRecords: [
      quoteReport('2026-09-22T00:01:00.000Z', 'KRW-NEAR', { median: 0.2, p95: 0.3 }),
      quoteReport('2026-09-22T23:55:00.000Z', 'KRW-NEAR', { median: 0.4, p95: 0.6 })
    ],
    now: Date.parse('2026-09-23T00:05:00.000Z')
  });

  assert.equal(result.quoteMatchedTradeCount, 1);
  assert.equal(result.spreadScenarioTradeCount, 0);
  assert.equal(result.trades[0].roundTripSpreadMedianProxyPercent, null);
  assert.equal(
    result.trades[0].spreadScenarioUnavailableReason,
    'execution_model_already_uses_or_does_not_identify_candle_close'
  );
  assert.equal(result.fullCohort.quoteSpreadAdjustedMedianScenarioNetPnlKrw, null);
});

test('missing trade P&L is unavailable rather than coerced to zero', () => {
  const result = summarizeMomentumShadowTradeCostAudit({
    ledger: ledgerWithTrade({ profitPercent: null }),
    quoteHistoryRecords: [],
    now: Date.parse('2026-09-23T00:05:00.000Z')
  });

  assert.equal(result.trades[0].ledgerNetProfitPercent, null);
  assert.equal(result.trades[0].currentNetPnlKrw, null);
  assert.equal(result.fullCohort.paperNetPnlKrw, null);
});

test('future-only quote history and an empty ledger do not create fresh or zero-profit evidence', () => {
  const now = Date.parse('2026-09-23T00:00:00.000Z');
  const result = summarizeMomentumShadowTradeCostAudit({
    ledger: { config: { costPercent: 0.2 }, trades: [], positions: {} },
    quoteHistoryRecords: [quoteReport('2026-09-23T00:01:00.000Z', 'KRW-BTC', {
      median: 0.05,
      p95: 0.1
    })],
    now
  });

  assert.equal(result.quoteHistory.futureTimestampCount, 1);
  assert.equal(result.quoteHistory.latestFresh, false);
  assert.equal(result.quoteHistory.latestUsable, false);
  assert.equal(result.fullCohort.paperNetPnlKrw, null);
  assert.equal(result.fullCohort.costFloorStressNetPnlKrw, null);
  assert.equal(result.fullCohort.quoteSpreadAdjustedMedianScenarioNetPnlKrw, null);
  assert.equal(result.quoteMatchedSubset.paperNetPnlKrw, null);
});
