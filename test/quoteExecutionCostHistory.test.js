import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeQuoteExecutionCostHistory } from '../src/research/quoteExecutionCostCompatibility.js';

function quoteReport(generatedAt, markets, overrides = {}) {
  return {
    generatedAt,
    complete: true,
    errors: 0,
    requestedSampleCount: 5,
    summary: {
      valid: true,
      markets: Object.fromEntries(Object.entries(markets).map(([market, value]) => [market, {
        sampleCount: value.sampleCount ?? 5,
        p95: value.p95,
        max: value.max ?? value.p95,
        overCeiling: value.overCeiling ?? 0,
        ...(value.topOfBookDepth ? { topOfBookDepth: value.topOfBookDepth } : {})
      }]))
    },
    ...overrides
  };
}

test('historical quote compatibility summarizes per-report tails without treating them as fills', () => {
  const now = Date.parse('2026-09-23T07:00:00.000Z');
  const records = Array.from({ length: 40 }, (_, index) => quoteReport(
    new Date(now - (39 - index) * 600_000).toISOString(),
    {
      'KRW-BTC': { p95: index < 36 ? 0.05 : 0.3 },
      'KRW-ETH': { p95: 0.1 },
      'KRW-DOGE': { p95: 0.8, max: 1, overCeiling: 5 }
    }
  ));

  const result = summarizeQuoteExecutionCostHistory({
    records,
    now,
    markets: ['KRW-BTC', 'KRW-ETH', 'KRW-DOGE'],
    windowsHours: [24],
    minimumReports: 30
  });
  const window = result.windows.find(item => item.label === 'last_24h');

  assert.equal(result.researchOnly, true);
  assert.equal(result.promoted, false);
  assert.equal(result.costModel.assumedRoundTripCostPercent, 0.3);
  assert.equal(result.costModel.adverseSlippageBudgetPercent, 0.2);
  assert.equal(window.reportCount, 40);
  assert.equal(window.completeReportCount, 40);
  assert.equal(window.cadence.medianGapSeconds, 600);
  assert.equal(window.cadence.gapsOverFreshnessLimit, 0);
  assert.equal(window.markets['KRW-BTC'].p95OfReportP95SpreadPercent, 0.3);
  assert.equal(window.markets['KRW-BTC'].reportsAboveBudget, 4);
  assert.equal(window.markets['KRW-BTC'].status, 'P95_REPORT_TAIL_ABOVE_SLIPPAGE_BUDGET');
  assert.equal(window.markets['KRW-ETH'].p95OfReportP95SpreadPercent, 0.1);
  assert.equal(window.markets['KRW-ETH'].status, 'P95_REPORT_TAIL_WITHIN_SLIPPAGE_BUDGET');
  assert.equal(window.markets['KRW-DOGE'].reportsAboveSamplerCeiling, 40);
  assert.match(result.note, /not a fill/);
});

test('historical quote compatibility excludes incomplete, erroneous, future, and undersampled records', () => {
  const now = Date.parse('2026-09-23T07:00:00.000Z');
  const records = [
    quoteReport(new Date(now - 2_000_000).toISOString(), {
      'KRW-BTC': { p95: 0.1 }
    }),
    quoteReport(new Date(now - 60_000).toISOString(), {
      'KRW-BTC': { p95: 0.5, sampleCount: 2 }
    }, { complete: false, errors: 1 }),
    quoteReport(new Date(now + 60_000).toISOString(), {
      'KRW-BTC': { p95: 0.05 }
    })
  ];

  const result = summarizeQuoteExecutionCostHistory({
    records,
    now,
    markets: ['KRW-BTC', 'KRW-ETH'],
    invalidRecordCount: 2,
    windowsHours: [24],
    minimumReports: 30
  });
  const window = result.windows.find(item => item.label === 'last_24h');

  assert.equal(result.invalidRecordCount, 2);
  assert.equal(result.futureTimestampCount, 1);
  assert.equal(result.latestSampler.fresh, true);
  assert.equal(result.latestSampler.complete, false);
  assert.equal(result.latestSampler.contractReady, false);
  assert.equal(window.reportCount, 2);
  assert.equal(window.completeReportCount, 1);
  assert.equal(window.errorReportCount, 1);
  assert.equal(window.cadence.gapsOverFreshnessLimit, 1);
  assert.equal(window.markets['KRW-BTC'].validReportCount, 1);
  assert.equal(window.markets['KRW-BTC'].status, 'INSUFFICIENT_REPORT_HISTORY');
  assert.equal(window.markets['KRW-ETH'].status, 'MISSING_QUOTE_HISTORY');
});

test('historical quote compatibility preserves an invalid cost budget as unavailable', () => {
  const now = Date.parse('2026-09-23T07:00:00.000Z');
  const records = Array.from({ length: 30 }, (_, index) => quoteReport(
    new Date(now - (29 - index) * 600_000).toISOString(),
    { 'KRW-BTC': { p95: 0.05 } }
  ));
  const result = summarizeQuoteExecutionCostHistory({
    records,
    now,
    markets: ['KRW-BTC'],
    windowsHours: [24],
    slippage: null
  });
  const window = result.windows.find(item => item.label === 'last_24h');

  assert.equal(result.costModel.adverseSlippageBudgetPercent, null);
  assert.equal(window.markets['KRW-BTC'].reportsAboveBudget, null);
  assert.equal(window.markets['KRW-BTC'].status, 'INVALID_COST_CONFIG');
});

test('historical top-of-book depth reports remain unavailable for legacy rows and aggregate new minima', () => {
  const now = Date.parse('2026-09-23T07:00:00.000Z');
  const depth = (minimumBidNotionalKrw, minimumAskNotionalKrw) => ({
    requestedSampleCount: 5,
    bidSampleCount: 5,
    askSampleCount: 5,
    minimumBidNotionalKrw,
    minimumAskNotionalKrw
  });
  const records = [
    quoteReport(new Date(now - 1_200_000).toISOString(), {
      'KRW-BTC': { p95: 0.05 }
    }),
    quoteReport(new Date(now - 600_000).toISOString(), {
      'KRW-BTC': { p95: 0.06, topOfBookDepth: depth(50_000, 45_000) }
    }),
    quoteReport(new Date(now - 300_000).toISOString(), {
      'KRW-BTC': { p95: 0.04, topOfBookDepth: depth(30_000, 20_000) }
    }),
    quoteReport(new Date(now - 60_000).toISOString(), {
      'KRW-BTC': { p95: 0.05, topOfBookDepth: depth(25_000, 15_000) }
    })
  ];
  const result = summarizeQuoteExecutionCostHistory({
    records,
    now,
    markets: ['KRW-BTC'],
    referenceNotionalsKrw: [20_000, 25_000, 100_000, 25_000, 0, Number.NaN],
    windowsHours: [24],
    minimumReports: 3,
    minimumDepthReports: 3
  });
  const depthSummary = result.windows[0].markets['KRW-BTC'].topOfBookDepth;

  assert.equal(depthSummary.bidDepthReportCount, 3);
  assert.equal(depthSummary.missingBidDepthReportCount, 1);
  assert.equal(depthSummary.p05PerReportMinimumBidNotionalKrw, 25_000);
  assert.equal(depthSummary.medianPerReportMinimumBidNotionalKrw, 30_000);
  assert.equal(depthSummary.askDepthReportCount, 3);
  assert.equal(depthSummary.missingAskDepthReportCount, 1);
  assert.equal(depthSummary.p05PerReportMinimumAskNotionalKrw, 15_000);
  assert.equal(depthSummary.twoSidedDepthReportCount, 3);
  assert.deepEqual(result.referenceNotionalsKrw, [20_000, 25_000, 100_000]);
  assert.deepEqual(depthSummary.referenceNotionalCoverage, [
    {
      notionalKrw: 20_000,
      bidReportCount: 3,
      askReportCount: 2,
      twoSidedReportCount: 2,
      minimumDepthReportCount: 3,
      twoSidedCoverageRate: 2 / 3,
      status: 'TOP_OF_BOOK_REFERENCE_ONLY'
    },
    {
      notionalKrw: 25_000,
      bidReportCount: 3,
      askReportCount: 1,
      twoSidedReportCount: 1,
      minimumDepthReportCount: 3,
      twoSidedCoverageRate: 1 / 3,
      status: 'TOP_OF_BOOK_REFERENCE_ONLY'
    },
    {
      notionalKrw: 100_000,
      bidReportCount: 0,
      askReportCount: 0,
      twoSidedReportCount: 0,
      minimumDepthReportCount: 3,
      twoSidedCoverageRate: 0,
      status: 'TOP_OF_BOOK_REFERENCE_ONLY'
    }
  ]);
  assert.match(depthSummary.note, /best quote level only/);
  assert.equal(result.promoted, false);
});

test('depth coverage rate stays unavailable until the minimum report count is met', () => {
  const now = Date.parse('2026-09-23T07:00:00.000Z');
  const depth = {
    requestedSampleCount: 5,
    bidSampleCount: 5,
    askSampleCount: 5,
    minimumBidNotionalKrw: 100_000,
    minimumAskNotionalKrw: 100_000
  };
  const records = [0, 1].map(index => quoteReport(
    new Date(now - index * 600_000).toISOString(),
    { 'KRW-BTC': { p95: 0.05, topOfBookDepth: depth } }
  ));
  const result = summarizeQuoteExecutionCostHistory({
    records,
    now,
    markets: ['KRW-BTC'],
    windowsHours: [24],
    minimumReports: 1,
    minimumDepthReports: 30,
    referenceNotionalsKrw: [50_000]
  });
  const summary = result.windows[0].markets['KRW-BTC'].topOfBookDepth;

  assert.equal(summary.twoSidedDepthReportCount, 2);
  assert.equal(summary.minimumDepthReportCount, 30);
  assert.equal(summary.status, 'INSUFFICIENT_DEPTH_REPORT_HISTORY');
  assert.equal(summary.referenceNotionalCoverage[0].twoSidedReportCount, 2);
  assert.equal(summary.referenceNotionalCoverage[0].twoSidedCoverageRate, null);
  assert.equal(summary.referenceNotionalCoverage[0].status, 'INSUFFICIENT_DEPTH_REPORT_HISTORY');
});
