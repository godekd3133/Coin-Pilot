import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DashboardServer from '../src/api/dashboardServer.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';
import {
  MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION
} from '../src/research/momentumShadowBenchmark.js';

test('strategy research route exposes a diagnostic report but hard-forces promotion false', async () => {
  const reportFile = path.join(os.tmpdir(), `coinpilot-strategy-research-${process.pid}-${Date.now()}.json`);
  const trader = createMockTrader();
  trader.config.higherTimeframeMomentumReportFile = reportFile;
  fs.writeFileSync(reportFile, JSON.stringify({
    study: 'higher_timeframe_momentum_walk_forward_diagnostic',
    promoted: true,
    generatedAt: new Date().toISOString(),
    markets: ['KRW-BTC'],
    variants: [{
      name: '1h_rsi65_trend7d',
      allMarketFoldsPassed: false,
      eligibleForFurtherShadow: false,
      portfolio: {
        unknownBoundaryPositionCount: 0,
        metrics: { totalReturnPercent: 1.2, tradeCount: 20, profitFactor: 1.1, maxDrawdownPercent: 3 }
      }
    }]
  }), 'utf8');

  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/strategy-research`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.available, true);
    assert.equal(body.researchOnly, true);
    assert.equal(body.promoted, false);
    assert.equal(body.projectionReason, 'research_artifact_never_authorizes_live_orders');
    assert.equal(body.reportFile, path.basename(reportFile));
    assert.equal(body.variants[0].portfolio.metrics.tradeCount, 20);
  } finally {
    dashboard.stop();
    trader.stop();
    if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
  }
});

test('strategy research route reports an unconfigured report without inventing results', async () => {
  const trader = createMockTrader();
  delete trader.config.higherTimeframeMomentumReportFile;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/strategy-research`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.available, false);
    assert.equal(body.researchOnly, true);
    assert.equal(body.promoted, false);
    assert.equal(body.reason, 'research_report_not_configured');
  } finally {
    dashboard.stop();
    trader.stop();
  }
});

test('strategy research route projects same-window scalping variants and invalid markets read-only', async () => {
  const reportFile = path.join(os.tmpdir(), `coinpilot-scalping-variant-research-${process.pid}-${Date.now()}.json`);
  const trader = createMockTrader();
  trader.config.scalpingVariantReportFile = reportFile;
  fs.writeFileSync(reportFile, JSON.stringify({
    study: 'same_window_scalping_variant_comparison',
    generatedAt: new Date().toISOString(),
    promoted: true,
    requestedMarketCount: 3,
    markets: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],
    variants: {
      baseline: {
        overrides: {},
        summary: {
          attemptedMarketCount: 3,
          marketCount: 1,
          invalidMarketCount: 2,
          invalidMarkets: [{ market: 'KRW-ETH', error: 'historical_candle_gap' }],
          promotionBlockedByInvalidMarkets: true,
          promoted: false,
          positiveHoldoutMarkets: 0,
          holdoutTradeCount: 10,
          sumHoldoutReturnPercent: -0.1,
          trainingGateFailures: 1
        }
      }
    }
  }), 'utf8');

  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/strategy-research`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.available, true);
    assert.equal(body.researchOnly, true);
    assert.equal(body.promoted, false);
    assert.equal(body.study, 'same_window_scalping_variant_comparison');
    assert.equal(body.reportFreshness.fresh, true);
    assert.equal(body.reportFreshness.reason, 'fresh');
    assert.equal(body.variants.baseline.summary.invalidMarketCount, 2);
    assert.equal(body.variants.baseline.summary.promotionBlockedByInvalidMarkets, true);

    const staleReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    staleReport.generatedAt = new Date(Date.now() - (25 * 60 * 60 * 1000)).toISOString();
    fs.writeFileSync(reportFile, JSON.stringify(staleReport), 'utf8');
    const staleResponse = await fetch(`http://127.0.0.1:${port}/api/strategy-research`);
    const staleBody = await staleResponse.json();
    assert.equal(staleBody.reportFreshness.fresh, false);
    assert.equal(staleBody.reportFreshness.reason, 'stale');
  } finally {
    dashboard.stop();
    trader.stop();
    if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);
  }
});

test('momentum shadow route projects the latest quote snapshot as read-only evidence', async () => {
  const quoteFile = path.join(os.tmpdir(), `coinpilot-momentum-quotes-${process.pid}-${Date.now()}.json`);
  const historyFile = path.join(os.tmpdir(), `coinpilot-momentum-quote-history-${process.pid}-${Date.now()}.jsonl`);
  fs.writeFileSync(quoteFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    complete: true,
    requestedSampleCount: 5,
    samples: [{ quotes: [] }, { quotes: [] }, { quotes: [] }, { quotes: [] }, { quotes: [] }],
    errors: [],
    maxSpreadPercent: 0.5,
    summary: {
      valid: true,
      sampleCount: 5,
      maxSpreadPercent: 0.5,
      overall: { median: 0.08, p95: 0.92, max: 0.92 },
      markets: {
        'KRW-BTC': {
          sampleCount: 5,
          p95: 0.03,
          max: 0.03,
          overCeiling: 0,
          topOfBookDepth: {
            requestedSampleCount: 5,
            bidSampleCount: 5,
            askSampleCount: 5,
            minimumBidNotionalKrw: 13_000,
            minimumAskNotionalKrw: 6_000_000
          }
        },
        'KRW-DOGE': { sampleCount: 5, p95: 0.92, max: 0.92, overCeiling: 5 }
      }
    }
  }), 'utf8');
  fs.writeFileSync(historyFile, [
    JSON.stringify({
      generatedAt: new Date(Date.now() - 120_000).toISOString(),
      complete: true,
      errors: 0,
      summary: { markets: { 'KRW-DOGE': {
        p95: 0.91,
        overCeiling: 5,
        topOfBookDepth: {
          requestedSampleCount: 5,
          bidSampleCount: 5,
          askSampleCount: 5,
          minimumBidNotionalKrw: 900_000,
          minimumAskNotionalKrw: 800_000
        }
      } } }
    }),
    JSON.stringify({
      generatedAt: new Date(Date.now() - 60_000).toISOString(),
      complete: true,
      errors: 0,
      summary: { markets: { 'KRW-DOGE': {
        p95: 0.92,
        overCeiling: 5,
        topOfBookDepth: {
          requestedSampleCount: 5,
          bidSampleCount: 5,
          askSampleCount: 5,
          minimumBidNotionalKrw: 850_000,
          minimumAskNotionalKrw: 750_000
        }
      } } }
    })
  ].join('\n'), 'utf8');
  const trader = createMockTrader();
  trader.config.momentumShadowQuoteReportFile = quoteFile;
  trader.config.momentumShadowQuoteHistoryFile = historyFile;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/momentum-shadow`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.paperForwardCohort.researchOnly, true);
    assert.equal(body.paperForwardCohort.promoted, false);
    assert.equal(typeof body.paperForwardCohort.eligibleStrictConfigCount, 'number');
    assert.ok(['none', 'single_config', 'mixed_configs_not_aggregated'].includes(body.paperForwardCohort.eligibleStrictProfitAggregation));
    assert.equal(typeof body.paperForwardCohort.profitabilityEvidenceSessionCount, 'number');
    assert.equal(typeof body.paperForwardCohort.profitabilityEvidenceConfigCount, 'number');
    assert.ok(['none', 'single_config', 'mixed_configs_not_aggregated'].includes(body.paperForwardCohort.profitabilityEvidenceProfitAggregation));
    assert.equal(body.quoteQualitySnapshot.available, true);
    assert.equal(body.quoteQualitySnapshot.complete, true);
    assert.equal(body.quoteQualitySnapshot.fresh, true);
    assert.equal(body.quoteQualitySnapshot.freshnessReason, 'quote_quality_report_fresh');
    assert.equal(body.quoteQualitySnapshot.maxAgeSeconds, 900);
    assert.equal(body.quoteQualitySnapshot.sampleCount, 5);
    assert.equal(body.quoteQualitySnapshot.errorCount, 0);
    assert.equal(body.quoteQualitySnapshot.overall.p95, 0.92);
    assert.deepEqual(body.quoteQualitySnapshot.overCeilingMarkets, ['KRW-DOGE']);
    assert.deepEqual(body.quoteQualitySnapshot.markets['KRW-BTC'].topOfBookDepth, {
      requestedSampleCount: 5,
      bidSampleCount: 5,
      askSampleCount: 5,
      minimumBidNotionalKrw: 13_000,
      minimumAskNotionalKrw: 6_000_000
    });
    assert.equal(body.quoteQualitySnapshot.history.available, true);
    assert.equal(body.quoteQualitySnapshot.history.reportCount, 2);
    assert.equal(body.quoteQualitySnapshot.history.windowLimit, 48);
    assert.equal(body.quoteQualitySnapshot.history.minimumDepthReports, 30);
    assert.deepEqual(body.quoteQualitySnapshot.history.repeatedOverCeilingMarkets, ['KRW-DOGE']);
    assert.equal(body.quoteQualitySnapshot.history.markets['KRW-DOGE'].overCeilingReports, 2);
    assert.equal(body.quoteQualitySnapshot.history.markets['KRW-DOGE'].topOfBookDepth.twoSidedDepthReportCount, 2);
    assert.equal(body.quoteQualitySnapshot.history.markets['KRW-DOGE'].topOfBookDepth.status, 'INSUFFICIENT_DEPTH_REPORT_HISTORY');
    assert.equal(body.quoteQualitySnapshot.promoted, false);
    assert.equal(body.quoteQualitySnapshot.researchOnly, true);
    assert.equal(body.quoteQualitySnapshot.costCompatibility.researchOnly, true);
    assert.equal(body.quoteQualitySnapshot.costCompatibility.promoted, false);
    assert.equal(body.quoteQualitySnapshot.costCompatibility.ready, false);
    assert.equal(body.quoteQualitySnapshot.costCompatibility.reason, 'quote_compatibility_market_samples_insufficient_or_missing');
    assert.equal(body.quoteQualitySnapshot.costCompatibility.rows.length, 4);
    assert.equal(body.quoteQualitySnapshot.allObservedMarketCostCompatibility.researchOnly, true);
    assert.equal(body.quoteQualitySnapshot.allObservedMarketCostCompatibility.promoted, false);
    assert.equal(body.quoteQualitySnapshot.allObservedMarketCostCompatibility.rows.length, 2);
    assert.equal(body.quoteQualitySnapshot.allObservedMarketCostCompatibility.rows.find(row => row.market === 'KRW-DOGE').status, 'P95_ABOVE_ADVERSE_SLIPPAGE_BUDGET');
  } finally {
    dashboard.stop();
    trader.stop();
    if (fs.existsSync(quoteFile)) fs.unlinkSync(quoteFile);
    if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile);
  }
});

test('momentum shadow quote snapshot marks stale and future reports as not current', async () => {
  const quoteFile = path.join(os.tmpdir(), `coinpilot-momentum-quotes-stale-${process.pid}-${Date.now()}.json`);
  const report = generatedAt => ({
    generatedAt,
    complete: true,
    requestedSampleCount: 1,
    samples: [{ quotes: [] }],
    errors: [],
    summary: { valid: true, sampleCount: 1, overall: {}, markets: {} }
  });
  const trader = createMockTrader();
  trader.config.momentumShadowQuoteReportFile = quoteFile;
  trader.config.momentumShadowQuoteMaxAgeSeconds = 60;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    fs.writeFileSync(quoteFile, JSON.stringify(report(new Date(Date.now() - 61_000).toISOString())), 'utf8');
    const staleResponse = await fetch(`http://127.0.0.1:${port}/api/momentum-shadow`);
    const staleBody = await staleResponse.json();
    assert.equal(staleBody.quoteQualitySnapshot.fresh, false);
    assert.equal(staleBody.quoteQualitySnapshot.freshnessReason, 'quote_quality_report_stale');
    assert.ok(staleBody.quoteQualitySnapshot.ageSeconds >= 61);

    fs.writeFileSync(quoteFile, JSON.stringify(report(new Date(Date.now() + 60_000).toISOString())), 'utf8');
    const futureResponse = await fetch(`http://127.0.0.1:${port}/api/momentum-shadow`);
    const futureBody = await futureResponse.json();
    assert.equal(futureBody.quoteQualitySnapshot.fresh, false);
    assert.equal(futureBody.quoteQualitySnapshot.ageSeconds, null);
    assert.equal(futureBody.quoteQualitySnapshot.freshnessReason, 'quote_quality_report_future_timestamp');
  } finally {
    dashboard.stop();
    trader.stop();
    if (fs.existsSync(quoteFile)) fs.unlinkSync(quoteFile);
  }
});

test('momentum shadow route projects marked equity as read-only research evidence', async () => {
  const fixedDir = path.join(os.tmpdir(), `coinpilot-momentum-fixed-${process.pid}-${Date.now()}`);
  const regimeDir = path.join(os.tmpdir(), `coinpilot-momentum-regime-${process.pid}-${Date.now()}`);
  const historyFile = path.join(os.tmpdir(), `coinpilot-momentum-cost-audit-${process.pid}-${Date.now()}.jsonl`);
  fs.mkdirSync(fixedDir, { recursive: true });
  fs.mkdirSync(regimeDir, { recursive: true });
  fs.writeFileSync(historyFile, '', 'utf8');
  const fixedConfig = {
    markets: ['KRW-BTC'],
    costPercent: 0.2,
    trendMinPercent: 0,
    breadthMin: 1,
    maxHoldHours: 72,
    positionFraction: 0.25,
    maxPositions: 4,
    cooldownAfterLossDays: 3,
    maxPortfolioDrawdownPercent: 10,
    executionModel: 'quote_cross',
    requestIntervalMs: 500
  };
  const previousFixedConfig = { ...fixedConfig };
  delete previousFixedConfig.requestIntervalMs;
  fs.writeFileSync(path.join(fixedDir, 'ledger.json'), JSON.stringify({
    diagnosticOnly: true,
    promoted: false,
    heartbeatAt: new Date().toISOString(),
    ownerPid: process.pid,
    runnerState: 'running',
    cycles: 4,
    costFloorGuardVersion: 1,
    costFloorBlockedEntries: 2,
    costFloorBlockedPendingEntries: 3,
    configDrift: {
      previous: previousFixedConfig,
      changedAt: '2026-09-14T00:00:00.000Z'
    },
    config: fixedConfig,
    initialBalance: 1_000,
    balance: 700,
    drawdownStopTriggered: true,
    drawdownStopAt: '2026-09-14T00:00:00.000Z',
    drawdownPercent: 10.5,
    cooldownBlocked: 2,
    drawdownBlocked: 4,
    duplicateSignalBlocked: 3,
    networkFetchFailureStreak: 2,
    fetchErrors: 4,
    networkFetchMaxConsecutiveFailures: 3,
    networkFetchMaxCycleDurationMs: 600_000,
    networkFetchCircuitOpen: true,
    networkFetchCircuitBreaks: 1,
    networkFetchFailureCount: 4,
    executionModelMarkBlocked: 1,
    dataQualityObservationCycles: 3,
    dataQualityInvalidCycles: 0,
    dataQualityBlocked: 4,
    lastNetworkFetchError: {
      code: 'ENOTFOUND',
      market: 'KRW-BTC',
      at: '2026-09-14T00:00:01.000Z'
    },
    runnerEvents: [
      { type: 'started', at: '2026-09-13T23:00:00.000Z' },
      { type: 'stopped', at: '2026-09-14T00:01:00.000Z', reason: 'signal:SIGTERM' },
      { type: 'started', at: '2026-09-14T00:01:05.000Z' }
    ],
    dataQuality: {
      valid: false,
      reason: 'daily_market_latest_timestamp_mismatch',
      marketCount: 1,
      missingMarkets: [],
      invalidMarkets: [],
      unalignedMarkets: ['KRW-ETH'],
      latestTimestamp: '2026-01-01T00:00:00.000Z'
    },
    positions: { 'KRW-BTC': { entryPrice: 100, size: 300, markValue: 330, markProfitPercent: 10 } },
    trades: [{ profitPercent: 1, entry: { size: 100 } }]
  }), 'utf8');

  const trader = createMockTrader();
  trader.config.momentumShadowFixedDir = fixedDir;
  trader.config.momentumShadowRegimeDir = regimeDir;
  trader.config.momentumShadowBenchmarkDir = regimeDir;
  trader.config.momentumShadowQuoteHistoryFile = historyFile;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/momentum-shadow`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.available, true);
    assert.equal(body.researchOnly, true);
    assert.equal(body.promoted, false);
    assert.equal(body.books[0].label, '진입 후 72시간 유지');
    assert.equal(body.books[0].description, '현재 진입계약 · 72시간 종료');
    assert.equal(body.books[0].benchmark.configured, false);
    assert.equal(body.books[0].executionModel, 'quote_cross');
    assert.match(body.books[0].executionModelNote, /가장 낮은 매도 호가/);
    assert.equal(body.books[0].executionModelBlockedCount, 1);
    assert.equal(typeof body.books[0].heartbeatAgeSeconds, 'number');
    assert.equal(body.books[0].promotionStatus, '실거래 적용 보류');
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('종료된 거래가')));
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('관찰 시작일이나 종료일을 확인할 수 없어')));
    assert.ok(body.books[0].promotionBlockers.includes('설정 변경 이력이 있어 동일 조건 비교를 할 수 없습니다.'));
    assert.equal(body.books[0].dataQuality.valid, false);
    assert.equal(body.books[0].dataQuality.blockedChecksAttribution, 'quality_history');
    assert.equal(body.books[0].minimumResearchTrades, 20);
    assert.equal(body.books[0].minimumResearchDays, 14);
    assert.equal(body.books[0].observationDays, null);
    assert.equal(body.books[0].realizedReturnPercent, 0.1);
    assert.equal(body.books[0].realizedTradeConfidence.sampleCount, 1);
    assert.equal(body.books[0].realizedTradeConfidence.lowerBoundPercent, null);
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('일봉 시세 기록이 불완전해 신규 진입을 막았습니다')));
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('시장 검토 차단 4회')));
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('같은 조건으로 관찰이 이어졌는지 확인할 수 없습니다')));
    assert.equal(body.books[0].promotionBlockers.some(blocker => blocker.includes('품질 실패 0/3 cycle')), false);
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('아직 종료되지 않은 포지션')));
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('시세 수집이 중단되어 관찰 기록이 이어지지 않았습니다')));
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('가격 모델이 1회 진입을 막아')));
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('관찰 세션')));
    assert.equal(body.books[0].status, '설정 변경 · 확인 필요');
    assert.equal(body.books[0].statusReason, '설정이 바뀌어 이 기록은 다른 전략과 비교하거나 실제 거래를 검토하는 데 사용할 수 없습니다.');
    assert.deepEqual(body.books[0].configurationDriftChanges, [{
      key: 'requestIntervalMs',
      previousRecorded: false,
      previousValue: null,
      currentRecorded: true,
      currentValue: 500
    }]);
    assert.deepEqual(body.books[0].runnerLifecycle, {
      previousStopReason: 'signal:SIGTERM',
      previousStopReasonLabel: '프로세스 종료 신호',
      previousStopAt: '2026-09-14T00:01:00.000Z',
      restartedAt: '2026-09-14T00:01:05.000Z',
      currentOpenPositionCount: 1
    });
    assert.equal(body.books[0].markedEquity, 1030);
    assert.ok(Math.abs(body.books[0].markedReturnPercent - 3) < 1e-12);
    assert.equal(body.books[0].unrealizedProfit, 30);
    assert.match(body.books[0].configurationWarning, /설정이 바뀌어 이 기록은 같은 조건의 전략 비교나 실제 거래 판단에 사용할 수 없습니다/);
    assert.equal(body.books[0].realizedProfit, 1);
    assert.equal(body.books[0].entryCostFloor.ready, false);
    assert.equal(body.books[0].entryCostFloor.configuredCostPercent, 0.2);
    assert.equal(body.books[0].entryCostFloor.requiredCostPercent, 0.3);
    assert.equal(body.books[0].entryCostFloor.runtimeGuardActive, true);
    assert.equal(body.books[0].entryCostFloor.blockedEntrySignals, 2);
    assert.equal(body.books[0].entryCostFloor.blockedPendingEntries, 3);
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('왕복 거래 비용 가정')));
    assert.equal(body.books[0].tradeCostAudit.available, true);
    assert.equal(body.books[0].tradeCostAudit.researchOnly, true);
    assert.equal(body.books[0].tradeCostAudit.promoted, false);
    assert.equal(body.books[0].tradeCostAudit.actualFillsObserved, false);
    assert.equal(body.books[0].tradeCostAudit.closedTradeCount, 1);
    assert.equal(body.books[0].tradeCostAudit.quoteMatchedTradeCount, 0);
    assert.equal(body.books[0].tradeCostAudit.unmatchedSpreadCostTradeCount, 1);
    assert.equal(body.books[0].tradeCostAudit.fullCohort.quoteSpreadAdjustedMedianScenarioNetPnlKrw, null);
    assert.equal(body.books[0].observedDrawdown.available, false);
    assert.equal(body.books[0].observedDrawdown.fullSessionCoverage, false);
    assert.equal(body.books[0].observedDrawdown.maxDrawdownPercent, null);
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('최대 낙폭 기록이 없거나 관찰 기간의 기록이 빠져')));
    assert.equal(body.books[0].observedDrawdown.available, false);
    assert.equal(body.books[0].observedDrawdown.fullSessionCoverage, false);
    assert.equal(body.books[0].observedDrawdown.maxDrawdownPercent, null);
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('최대 낙폭 기록이 없거나 관찰 기간의 기록이 빠져')));
    assert.equal(body.books[0].contract.relativeTrendMinPercent, null);
    assert.equal(body.books[0].network.circuitOpen, true);
    assert.equal(body.books[0].network.fetchErrors, 4);
    assert.equal(body.books[0].network.failureStreak, 2);
    assert.equal(body.books[0].network.maxConsecutiveFailures, 3);
    assert.equal(body.books[0].network.maxCycleDurationMs, 600_000);
    assert.equal(body.books[0].network.circuitBreaks, 1);
    assert.equal(body.books[0].network.failureCount, 4);
    assert.equal(body.books[0].network.lastErrorCode, 'ENOTFOUND');
    assert.equal(body.books[0].network.lastErrorMarket, 'KRW-BTC');
    assert.equal(body.candidateReadiness.readOnly, true);
    assert.equal(body.candidateReadiness.promotionAllowed, false);
    assert.equal(typeof body.candidateReadiness.launchAllowed, 'boolean');
    assert.equal(body.candidateReadiness.candidateSlot.occupied, false);
    assert.equal(body.candidateReadiness.candidateSlot.exists, false);
    assert.equal(Object.hasOwn(body.candidateReadiness.candidateSlot, 'ownerDir'), false);
    assert.equal(body.candidateReadiness.candidateConfig.breadthMin, 2);
    assert.equal(body.candidateReadiness.candidateConfig.minUpBars, 2);
    assert.equal(body.candidateReadiness.candidateConfig.maxHoldHours, 8760);
    assert.equal(body.candidateReadiness.candidateConfig.relativeTrendMinPercent, null);
    assert.equal(body.candidateReadinessVariants.length, 9);
    assert.equal(body.candidateReadinessVariants[1].key, 'volatility');
    assert.equal(body.candidateReadinessVariants[1].readiness.candidateConfig.volatilityTargetPercent, 1);
    assert.equal(body.candidateReadinessVariants[2].key, 'next_open');
    assert.equal(body.candidateReadinessVariants[2].readiness.candidateConfig.benchmarkTrendMinPercent, 1);
    assert.equal(body.candidateReadinessVariants[2].readiness.candidateConfig.costPercent, 0.3);
    assert.equal(body.candidateReadinessVariants[2].readiness.candidateConfig.volatilityTargetPercent, 1);
    assert.equal(body.candidateReadinessVariants[2].readiness.candidateConfig.entryExecution, 'next_open');
    assert.equal(body.candidateReadinessVariants[2].readiness.candidateConfig.maxEntryGapPercent, 0.2);
    assert.equal(body.candidateReadinessVariants[2].readiness.candidateConfig.maxDailyCandleAgeHours, 36);
    assert.equal(body.candidateReadinessVariants[3].key, 'fixed_2d');
    assert.equal(body.candidateReadinessVariants[3].readiness.candidateConfig.mode, 'fixed');
    assert.equal(body.candidateReadinessVariants[3].readiness.candidateConfig.maxHoldHours, 48);
    assert.equal(body.candidateReadinessVariants[3].readiness.candidateConfig.exitOnBenchmarkOff, true);
    assert.equal(body.candidateReadinessVariants[3].readiness.candidateConfig.maxSpreadPercent, 0);
    assert.equal(body.candidateReadinessVariants[4].key, 'fixed_2d_loss_cap');
    assert.equal(body.candidateReadinessVariants[4].readiness.candidateConfig.mode, 'fixed');
    assert.equal(body.candidateReadinessVariants[4].readiness.candidateConfig.maxHoldHours, 48);
    assert.equal(body.candidateReadinessVariants[4].readiness.candidateConfig.stopLossPercent, 4);
    assert.equal(body.candidateReadinessVariants[4].readiness.candidateConfig.takeProfitPercent, 0);
    assert.equal(body.candidateReadinessVariants[4].readiness.candidateConfig.exitOnBenchmarkOff, true);
    assert.equal(body.candidateReadinessVariants[5].key, 'fixed_2d_loss_cap_no_doge');
    assert.equal(body.candidateReadinessVariants[5].readiness.candidateConfig.mode, 'fixed');
    assert.equal(body.candidateReadinessVariants[5].readiness.candidateConfig.maxHoldHours, 48);
    assert.equal(body.candidateReadinessVariants[5].readiness.candidateConfig.stopLossPercent, 4);
    assert.equal(body.candidateReadinessVariants[5].readiness.candidateConfig.markets.includes('KRW-DOGE'), false);
    assert.equal(body.candidateReadinessVariants[5].readiness.historicalEvidence.researchOnly, true);
    assert.equal(body.candidateReadinessVariants[5].readiness.historicalEvidence.promoted, false);
    assert.equal(body.candidateReadinessVariants[5].readiness.historicalEvidence.windows.length, 2);
    assert.equal(body.candidateReadinessVariants[5].readiness.historicalEvidence.windows[1].tradeCount, 218);
    assert.equal(body.candidateReadinessVariants[5].readiness.historicalEvidence.rollingWindows.length, 9);
    assert.equal(body.candidateReadinessVariants[5].readiness.historicalEvidence.rollingWindows[0].status, 'INSUFFICIENT_SAMPLE');
    assert.equal(body.candidateReadinessVariants[5].readiness.historicalEvidence.rollingWindows.at(-1).tradeCount, 213);
    assert.equal(body.candidateReadinessVariants[5].readiness.historicalEvidence.costStress.length, 7);
    assert.equal(body.candidateReadinessVariants[5].readiness.historicalEvidence.costStress.at(-1).status, 'HOLD');
    assert.equal(body.candidateReadinessVariants[6].key, 'fixed_2d_relative');
    assert.equal(body.candidateReadinessVariants[6].readiness.candidateConfig.mode, 'fixed');
    assert.equal(body.candidateReadinessVariants[6].readiness.candidateConfig.maxHoldHours, 48);
    assert.equal(body.candidateReadinessVariants[6].readiness.candidateConfig.relativeTrendMinPercent, 0);
    assert.equal(body.candidateReadinessVariants[6].readiness.candidateConfig.exitOnBenchmarkOff, true);
    assert.equal(body.candidateReadinessVariants[7].key, 'fixed_2d_spread');
    assert.equal(body.candidateReadinessVariants[7].readiness.candidateConfig.mode, 'fixed');
    assert.equal(body.candidateReadinessVariants[7].readiness.candidateConfig.maxHoldHours, 48);
    assert.equal(body.candidateReadinessVariants[7].readiness.candidateConfig.maxSpreadPercent, 0.5);
    assert.equal(body.candidateReadinessVariants[7].readiness.candidateConfig.exitOnBenchmarkOff, true);
    assert.equal(body.candidateReadinessVariants[8].key, 'fixed_2d_quote_cross');
    assert.equal(body.candidateReadinessVariants[8].readiness.candidateConfig.mode, 'fixed');
    assert.equal(body.candidateReadinessVariants[8].readiness.candidateConfig.maxHoldHours, 48);
    assert.equal(body.candidateReadinessVariants[8].readiness.candidateConfig.executionModel, 'quote_cross');
    assert.equal(body.candidateReadinessVariants[8].readiness.candidateConfig.maxSpreadPercent, 0.5);
    assert.equal(body.candidateReadinessVariants[8].readiness.candidateConfig.exitOnBenchmarkOff, true);
    assert.equal(body.books[0].openPositions[0].asset, 'BTC');
    assert.equal(body.books[0].openPositions[0].markProfitPercent, 10);
    assert.equal(body.books[0].riskControls.configured, true);
    assert.equal(body.books[0].riskControls.cooldownAfterLossDays, 3);
    assert.equal(body.books[0].riskControls.maxPortfolioDrawdownPercent, 10);
    assert.equal(body.books[0].riskControls.drawdownStopTriggered, true);
    assert.equal(body.books[0].riskControls.cooldownBlockedEntries, 2);
    assert.equal(body.books[0].riskControls.drawdownBlockedEntries, 4);
    assert.equal(body.books[0].riskControls.duplicateSignalBlockedEntries, 3);
    assert.equal(body.books[0].riskControls.pendingEntryQuoteBlocked, 0);
    assert.equal(Object.hasOwn(body.books[0], 'directory'), false);
    assert.equal(body.books[1].available, false);
    assert.equal(body.books[2].available, false);
    assert.equal(body.books[3].key, 'volatility');
    assert.equal(body.books[3].label, '변동성에 따라 비중 조절');
    assert.equal(body.books[3].available, false);
    assert.equal(body.books[4].key, 'next_open');
    assert.equal(body.books[4].available, false);
    assert.equal(body.books[5].key, 'fixed_2d');
    assert.equal(body.books[5].label, '2일 뒤 청산');
    assert.equal(body.books[5].available, false);
    assert.equal(body.books[6].key, 'fixed_2d_loss_cap');
    assert.equal(body.books[6].label, '2일 보유 · 종가 기준 손실 제한');
    assert.equal(body.books[6].available, false);
    assert.equal(body.books[7].key, 'fixed_2d_spread');
    assert.equal(body.books[7].label, '2일 보유 · 호가 제한');
    assert.equal(body.books[7].available, false);
    assert.equal(body.books[8].key, 'fixed_2d_relative');
    assert.equal(body.books[8].label, '2일 보유 · 비트코인 대비 강한 추세');
    assert.equal(body.books[8].available, false);
    assert.equal(body.books[9].key, 'fixed_2d_quote_cross');
    assert.equal(body.books[9].label, '2일 보유 · 매수·매도 호가 기준');
    assert.equal(body.books[9].available, false);
  } finally {
    dashboard.stop();
    trader.stop();
    if (fs.existsSync(historyFile)) fs.unlinkSync(historyFile);
    fs.rmSync(fixedDir, { recursive: true, force: true });
    fs.rmSync(regimeDir, { recursive: true, force: true });
  }
});

test('momentum shadow route blocks a negative trade-return confidence bound', async () => {
  const fixedDir = path.join(os.tmpdir(), `coinpilot-momentum-confidence-${process.pid}-${Date.now()}`);
  fs.mkdirSync(fixedDir, { recursive: true });
  const startedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(fixedDir, 'ledger.json'), JSON.stringify({
    diagnosticOnly: true,
    promoted: false,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    ownerPid: 0,
    runnerState: 'stopped',
    runnerStopReason: 'stopped_cleanly',
    cycles: 20,
    initialBalance: 1_000,
    balance: 980,
    benchmarkTrendPercent: 3,
    benchmarkGateOpen: true,
    benchmarkAvailable: true,
    benchmarkObservationSchemaVersion: MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION,
    benchmarkObservationAvailable: true,
    benchmarkObservationStartPrice: 100,
    benchmarkObservationMarkPrice: 110,
    benchmarkObservationStartTs: '2026-01-01T00:00:00',
    benchmarkObservationMarkTs: '2026-01-03T00:00:00',
    benchmarkObservationCheckpoints: [{
      benchmarkMarkTs: '2026-01-03T00:00:00',
      capturedAt: '2026-01-03T00:00:00Z',
      markedEquity: 980,
      markedReturnPercent: -2,
      benchmarkReturnPercent: 10,
      relativeMarkedReturnPercent: -12,
      openPositionCount: 0,
      dataQualityValid: true,
      benchmarkGateOpen: true
    }],
    positions: {},
    trades: Array.from({ length: 20 }, () => ({
      market: 'KRW-BTC',
      entry: { size: 100 },
      profitPercent: -1
    })),
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 1 },
    config: {
      markets: ['KRW-BTC'],
      costPercent: 0.3,
      trendMinPercent: 2,
      breadthMin: 3,
      maxHoldHours: 48,
      positionFraction: 0.125,
      maxPositions: 2,
      benchmarkMarket: 'KRW-BTC',
      benchmarkTrendMinPercent: 2,
      cooldownAfterLossDays: 3,
      maxPortfolioDrawdownPercent: 15
    }
  }), 'utf8');

  const trader = createMockTrader();
  trader.config.momentumShadowFixedDir = fixedDir;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/momentum-shadow`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.books[0].realizedReturnPercent, -2);
    assert.equal(body.books[0].benchmark.observationAvailable, true);
    assert.equal(body.books[0].benchmark.observationReturnPercent, 10);
    assert.ok(Math.abs(body.books[0].benchmark.relativeMarkedReturnPercent + 12) < 1e-12);
    assert.equal(body.books[0].benchmark.observationStartTs, '2026-01-01T00:00:00');
    assert.equal(body.books[0].benchmark.observationCheckpoints.checkpointCount, 1);
    assert.equal(body.books[0].benchmark.observationCheckpoints.worstRelativeMarkedReturnPercent, -12);
    assert.equal(body.books[0].realizedByMarket['KRW-BTC'].tradeCount, 20);
    assert.equal(body.books[0].realizedByMarket['KRW-BTC'].realizedProfit, -20);
    assert.equal(body.books[0].realizedTradeConfidence.sampleCount, 20);
    assert.equal(body.books[0].realizedTradeConfidence.lowerBoundPercent, -1);
    assert.equal(body.books[0].profitConcentration.available, false);
    assert.equal(body.books[0].profitConcentration.winningTradeCount, 0);
    assert.equal(body.books[0].profitConcentration.topWinnerShareOfPositivePnlPercent, null);
    assert.equal(body.books[0].profitConcentration.promoted, false);
    assert.equal(body.books[0].entryCostFloor.ready, true);
    assert.equal(body.books[0].entryCostFloor.runtimeGuardActive, false);
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('수익률을 보수적으로 계산했을 때 0%를 밑돌아')));
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('기록된 모의 거래 수익률이 0% 이하')));
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('관찰을 실행하는 프로그램이 실행 중 상태가 아닙니다')));
  } finally {
    dashboard.stop();
    trader.stop();
    fs.rmSync(fixedDir, { recursive: true, force: true });
  }
});

test('momentum shadow route does not treat zero realized return as paper profit', async () => {
  const fixedDir = path.join(os.tmpdir(), `coinpilot-momentum-zero-profit-${process.pid}-${Date.now()}`);
  fs.mkdirSync(fixedDir, { recursive: true });
  const startedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(fixedDir, 'ledger.json'), JSON.stringify({
    diagnosticOnly: true,
    promoted: false,
    startedAt,
    endedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ownerPid: 0,
    runnerState: 'stopped',
    runnerStopReason: 'stopped_cleanly',
    cycles: 20,
    initialBalance: 1_000,
    balance: 1_000,
    positions: {},
    trades: Array.from({ length: 20 }, () => ({
      market: 'KRW-BTC',
      entry: { size: 100 },
      profitPercent: 0
    })),
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 1 },
    config: {
      markets: ['KRW-BTC'],
      costPercent: 0.3,
      trendMinPercent: 2,
      breadthMin: 3,
      maxHoldHours: 48,
      positionFraction: 0.125,
      maxPositions: 2,
      benchmarkMarket: 'KRW-BTC',
      benchmarkTrendMinPercent: 2,
      cooldownAfterLossDays: 3,
      maxPortfolioDrawdownPercent: 15
    }
  }), 'utf8');

  const trader = createMockTrader();
  trader.config.momentumShadowFixedDir = fixedDir;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/momentum-shadow`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.books[0].realizedReturnPercent, 0);
    assert.equal(body.books[0].realizedTradeConfidence.sampleCount, 20);
    assert.equal(body.books[0].realizedTradeConfidence.lowerBoundPercent, 0);
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('기록된 모의 거래 수익률이 0% 이하')));
  } finally {
    dashboard.stop();
    trader.stop();
    fs.rmSync(fixedDir, { recursive: true, force: true });
  }
});

test('momentum shadow route reports modeled quote boundary evidence separately from fills', async () => {
  const fixedDir = path.join(os.tmpdir(), `coinpilot-momentum-quote-boundary-${process.pid}-${Date.now()}`);
  fs.mkdirSync(fixedDir, { recursive: true });
  fs.writeFileSync(path.join(fixedDir, 'ledger.json'), JSON.stringify({
    diagnosticOnly: true,
    promoted: false,
    startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    endedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    ownerPid: 0,
    runnerState: 'stopped',
    runnerStopReason: 'stopped_cleanly',
    initialBalance: 1_000,
    balance: 1_010,
    positions: {},
    trades: [
      {
        market: 'KRW-BTC',
        entry: { size: 100, entryQuote: { market: 'KRW-BTC' } },
        profitPercent: 1,
        quoteExecutionEvidence: {
          market: 'KRW-BTC',
          available: true,
          estimatedCrossingDragPercent: 0.4
        }
      },
      {
        market: 'KRW-ETH',
        entry: { size: 100 },
        profitPercent: 1,
        quoteExecutionEvidence: {
          market: 'KRW-ETH',
          available: false,
          reason: 'exit_quote_missing_or_invalid'
        }
      }
    ],
    dataQuality: { valid: true, reason: 'daily_grid_aligned_and_contiguous', marketCount: 2 },
    config: {
      markets: ['KRW-BTC', 'KRW-ETH'],
      mode: 'fixed',
      costPercent: 0.3,
      maxSpreadPercent: 0.5,
      maxHoldHours: 48,
      trendMinPercent: 2,
      breadthMin: 3,
      positionFraction: 0.125,
      maxPositions: 2
    }
  }), 'utf8');

  const trader = createMockTrader();
  trader.config.momentumShadowFixedDir = fixedDir;
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/momentum-shadow`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.books[0].quoteExecution.closedTradeCount, 2);
    assert.equal(body.books[0].quoteExecution.availableCount, 1);
    assert.equal(body.books[0].quoteExecution.missingCount, 1);
    assert.equal(body.books[0].quoteExecution.averageEstimatedCrossingDragPercent, 0.4);
    assert.equal(body.books[0].quoteExecution.maxEstimatedCrossingDragPercent, 0.4);
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('매수·매도 호가 기록이 1/2건뿐이라 예상 거래 비용을 계산할 자료가 부족')));
    assert.match(body.books[0].quoteExecution.note, /not an observed fill/);
  } finally {
    dashboard.stop();
    trader.stop();
    fs.rmSync(fixedDir, { recursive: true, force: true });
  }
});

test('momentum shadow variant readiness is sealed against ambient candidate env', async () => {
  const pollutedKeys = [
    'MOMO_SHADOW_MODE',
    'MOMO_SHADOW_MAX_HOLD_HOURS',
    'MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT',
    'MOMO_SHADOW_ENTRY_EXECUTION',
    'MOMO_SHADOW_MAX_SPREAD_PERCENT',
    'MOMO_SHADOW_POSITION_FRACTION'
  ];
  const saved = Object.fromEntries(pollutedKeys.map(key => [key, process.env[key]]));
  process.env.MOMO_SHADOW_MODE = 'fixed';
  process.env.MOMO_SHADOW_MAX_HOLD_HOURS = '48';
  process.env.MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT = '-100';
  process.env.MOMO_SHADOW_ENTRY_EXECUTION = 'next_open';
  process.env.MOMO_SHADOW_MAX_SPREAD_PERCENT = '9';
  process.env.MOMO_SHADOW_POSITION_FRACTION = '0.9';

  const trader = createMockTrader();
  const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
  const httpServer = dashboard.start();
  await new Promise(resolve => httpServer.once('listening', resolve));
  const port = httpServer.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/momentum-shadow`);
    const body = await response.json();
    assert.equal(response.status, 200);

    // The baseline candidate intentionally resolves from ambient env.
    assert.equal(body.candidateReadiness.candidateConfig.mode, 'fixed');
    assert.equal(body.candidateReadiness.candidateConfig.maxHoldHours, 48);

    // Each variant keeps its own fixed contract instead of inheriting env.
    const variants = Object.fromEntries(
      body.candidateReadinessVariants.map(variant => [variant.key, variant.readiness.candidateConfig])
    );
    assert.equal(variants.volatility.mode, 'regime');
    assert.equal(variants.volatility.benchmarkTrendMinPercent, 2);
    assert.equal(variants.volatility.entryExecution, 'close');
    assert.equal(variants.volatility.maxSpreadPercent, 0);
    assert.equal(variants.next_open.mode, 'regime');
    assert.equal(variants.next_open.benchmarkTrendMinPercent, 1);
    assert.equal(variants.next_open.entryExecution, 'next_open');
    assert.equal(variants.next_open.maxSpreadPercent, 0);
    assert.equal(variants.fixed_2d.mode, 'fixed');
    assert.equal(variants.fixed_2d.positionFraction, 0.125);
    assert.equal(variants.fixed_2d_loss_cap.mode, 'fixed');
    assert.equal(variants.fixed_2d_loss_cap.stopLossPercent, 4);
    assert.equal(variants.fixed_2d_loss_cap.takeProfitPercent, 0);
    assert.equal(variants.fixed_2d_loss_cap_no_doge.stopLossPercent, 4);
    assert.equal(variants.fixed_2d_loss_cap_no_doge.markets.includes('KRW-DOGE'), false);
    assert.equal(variants.fixed_2d_relative.mode, 'fixed');
    assert.equal(variants.fixed_2d_relative.relativeTrendMinPercent, 0);
    assert.equal(variants.fixed_2d_spread.maxSpreadPercent, 0.5);
    assert.equal(variants.fixed_2d_quote_cross.executionModel, 'quote_cross');
    assert.equal(variants.fixed_2d_quote_cross.maxSpreadPercent, 0.5);
  } finally {
    dashboard.stop();
    trader.stop();
    for (const key of pollutedKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
