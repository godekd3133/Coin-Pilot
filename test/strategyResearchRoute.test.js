import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DashboardServer from '../src/api/dashboardServer.js';
import { createMockTrader } from '../src/scripts/runDashboard.js';

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

test('momentum shadow route projects marked equity as read-only research evidence', async () => {
  const fixedDir = path.join(os.tmpdir(), `coinpilot-momentum-fixed-${process.pid}-${Date.now()}`);
  const regimeDir = path.join(os.tmpdir(), `coinpilot-momentum-regime-${process.pid}-${Date.now()}`);
  fs.mkdirSync(fixedDir, { recursive: true });
  fs.mkdirSync(regimeDir, { recursive: true });
  fs.writeFileSync(path.join(fixedDir, 'ledger.json'), JSON.stringify({
    diagnosticOnly: true,
    promoted: false,
    heartbeatAt: new Date().toISOString(),
    ownerPid: process.pid,
    runnerState: 'running',
    cycles: 4,
    configDrift: { changedAt: '2026-09-14T00:00:00.000Z' },
    config: {
      markets: ['KRW-BTC'],
      costPercent: 0.2,
      trendMinPercent: 0,
      breadthMin: 1,
      maxHoldHours: 72,
      positionFraction: 0.25,
      maxPositions: 4,
      cooldownAfterLossDays: 3,
      maxPortfolioDrawdownPercent: 10
    },
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
    lastNetworkFetchError: {
      code: 'ENOTFOUND',
      at: '2026-09-14T00:00:01.000Z'
    },
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
    assert.equal(body.books[0].label, '고정 72시간');
    assert.equal(body.books[0].description, '현재 진입계약 · 72시간 종료');
    assert.equal(body.books[0].benchmark.configured, false);
    assert.equal(typeof body.books[0].heartbeatAgeSeconds, 'number');
    assert.equal(body.books[0].promotionStatus, '승격 보류');
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('청산 표본')));
    assert.equal(body.books[0].dataQuality.valid, false);
    assert.ok(body.books[0].promotionBlockers.some(blocker => blocker.includes('일봉 데이터')));
    assert.equal(body.books[0].status, '관찰 중');
    assert.equal(body.books[0].markedEquity, 1030);
    assert.ok(Math.abs(body.books[0].markedReturnPercent - 3) < 1e-12);
    assert.equal(body.books[0].unrealizedProfit, 30);
    assert.match(body.books[0].configurationWarning, /설정 변경/);
    assert.equal(body.books[0].realizedProfit, 1);
    assert.equal(body.books[0].contract.relativeTrendMinPercent, null);
    assert.equal(body.books[0].network.circuitOpen, true);
    assert.equal(body.books[0].network.fetchErrors, 4);
    assert.equal(body.books[0].network.failureStreak, 2);
    assert.equal(body.books[0].network.maxConsecutiveFailures, 3);
    assert.equal(body.books[0].network.maxCycleDurationMs, 600_000);
    assert.equal(body.books[0].network.circuitBreaks, 1);
    assert.equal(body.books[0].network.failureCount, 4);
    assert.equal(body.books[0].network.lastErrorCode, 'ENOTFOUND');
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
    assert.equal(body.candidateReadinessVariants.length, 6);
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
    assert.equal(body.candidateReadinessVariants[4].key, 'fixed_2d_relative');
    assert.equal(body.candidateReadinessVariants[4].readiness.candidateConfig.mode, 'fixed');
    assert.equal(body.candidateReadinessVariants[4].readiness.candidateConfig.maxHoldHours, 48);
    assert.equal(body.candidateReadinessVariants[4].readiness.candidateConfig.relativeTrendMinPercent, 0);
    assert.equal(body.candidateReadinessVariants[4].readiness.candidateConfig.exitOnBenchmarkOff, true);
    assert.equal(body.candidateReadinessVariants[5].key, 'fixed_2d_spread');
    assert.equal(body.candidateReadinessVariants[5].readiness.candidateConfig.mode, 'fixed');
    assert.equal(body.candidateReadinessVariants[5].readiness.candidateConfig.maxHoldHours, 48);
    assert.equal(body.candidateReadinessVariants[5].readiness.candidateConfig.maxSpreadPercent, 0.5);
    assert.equal(body.candidateReadinessVariants[5].readiness.candidateConfig.exitOnBenchmarkOff, true);
    assert.equal(body.books[0].openPositions[0].asset, 'BTC');
    assert.equal(body.books[0].openPositions[0].markProfitPercent, 10);
    assert.equal(body.books[0].riskControls.configured, true);
    assert.equal(body.books[0].riskControls.cooldownAfterLossDays, 3);
    assert.equal(body.books[0].riskControls.maxPortfolioDrawdownPercent, 10);
    assert.equal(body.books[0].riskControls.drawdownStopTriggered, true);
    assert.equal(body.books[0].riskControls.cooldownBlockedEntries, 2);
    assert.equal(body.books[0].riskControls.drawdownBlockedEntries, 4);
    assert.equal(body.books[0].riskControls.duplicateSignalBlockedEntries, 3);
    assert.equal(Object.hasOwn(body.books[0], 'directory'), false);
    assert.equal(body.books[1].available, false);
    assert.equal(body.books[2].available, false);
    assert.equal(body.books[3].key, 'volatility');
    assert.equal(body.books[3].label, '변동성 제한 A/B 후보');
    assert.equal(body.books[3].available, false);
    assert.equal(body.books[4].key, 'next_open');
    assert.equal(body.books[4].available, false);
    assert.equal(body.books[5].key, 'fixed_2d');
    assert.equal(body.books[5].label, '2일 고정 종료 A/B 후보');
    assert.equal(body.books[5].available, false);
    assert.equal(body.books[6].key, 'fixed_2d_spread');
    assert.equal(body.books[6].label, '2일·호가 제한 A/B 후보');
    assert.equal(body.books[6].available, false);
    assert.equal(body.books[7].key, 'fixed_2d_relative');
    assert.equal(body.books[7].label, '2일·상대추세 A/B 후보');
    assert.equal(body.books[7].available, false);
  } finally {
    dashboard.stop();
    trader.stop();
    fs.rmSync(fixedDir, { recursive: true, force: true });
    fs.rmSync(regimeDir, { recursive: true, force: true });
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
    assert.equal(variants.fixed_2d_relative.mode, 'fixed');
    assert.equal(variants.fixed_2d_relative.relativeTrendMinPercent, 0);
    assert.equal(variants.fixed_2d_spread.maxSpreadPercent, 0.5);
  } finally {
    dashboard.stop();
    trader.stop();
    for (const key of pollutedKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
