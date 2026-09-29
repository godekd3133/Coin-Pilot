import assert from 'node:assert/strict';
import test from 'node:test';
import DashboardServer from '../src/api/dashboardServer.js';

function readinessServer(trader, listening = true) {
  const server = Object.create(DashboardServer.prototype);
  server.tradingSystem = trader;
  server.httpServer = { listening };
  return server;
}

function healthyTrader({ lastCompleteAt = null, readOnlyObserver = false, entriesPaused = false } = {}) {
  return {
    isRunning: true,
    dryRun: false,
    readOnlyObserver,
    config: { checkInterval: 1_000 },
    paperValidation: { telemetry: { lastCycleAt: lastCompleteAt } },
    getRuntimeSafetyStatus: () => ({
      runtimeState: 'RUNNING',
      entriesPaused,
      protectiveMonitorActive: true,
      stopReason: null,
      exchangeStateKnown: true
    }),
    getAnalysisDataHealthStatus: () => ({
      failClosed: false,
      lastCompleteAt,
      maxAnalysisDataGapSeconds: 60
    }),
    getRiskMonitorStatus: () => ({ failClosed: false })
  };
}

test('service readiness is independent of the trading loop and its first market cycle', () => {
  const dashboard = readinessServer(healthyTrader());

  const service = dashboard.buildServiceReadiness(1_800_000_000_000);
  const trading = dashboard.buildTradingReadiness(1_800_000_000_000);

  assert.equal(service.ready, true);
  assert.equal(service.checks.httpServerListening, true);
  assert.equal(trading.ready, false);
  assert.equal(trading.checks.analysisFirstCycleComplete, false);
  assert.equal(trading.checks.analysisCycleFresh, false);
});

test('trading readiness passes only after a complete fresh analysis cycle', () => {
  const now = 1_800_000_000_000;
  const lastCompleteAt = new Date(now - 30_000).toISOString();
  const dashboard = readinessServer(healthyTrader({ lastCompleteAt }));

  const readiness = dashboard.buildTradingReadiness(now);

  assert.equal(readiness.ready, true);
  assert.equal(readiness.checks.traderCanTrade, true);
  assert.equal(readiness.checks.analysisFirstCycleComplete, true);
  assert.equal(readiness.checks.analysisCycleFresh, true);
  assert.equal(readiness.checks.analysisCycleAgeSeconds, 30);
});

test('trading readiness rejects stale or future-dated analysis cycles', () => {
  const now = 1_800_000_000_000;
  const stale = readinessServer(healthyTrader({
    lastCompleteAt: new Date(now - 121_000).toISOString()
  })).buildTradingReadiness(now);
  const future = readinessServer(healthyTrader({
    lastCompleteAt: new Date(now + 1_000).toISOString()
  })).buildTradingReadiness(now);

  assert.equal(stale.ready, false);
  assert.equal(stale.checks.analysisCycleFresh, false);
  assert.equal(future.ready, false);
  assert.equal(future.checks.analysisFirstCycleComplete, false);
});

test('trading readiness fails closed when a required health provider is missing or invalid', () => {
  const now = 1_800_000_000_000;
  const lastCompleteAt = new Date(now - 30_000).toISOString();

  const missingAnalysisTrader = healthyTrader({ lastCompleteAt });
  delete missingAnalysisTrader.getAnalysisDataHealthStatus;
  const missingAnalysis = readinessServer(missingAnalysisTrader).buildTradingReadiness(now);

  const invalidRiskTrader = healthyTrader({ lastCompleteAt });
  invalidRiskTrader.getRiskMonitorStatus = () => undefined;
  const invalidRisk = readinessServer(invalidRiskTrader).buildTradingReadiness(now);

  const missingSafetyTrader = healthyTrader({ lastCompleteAt });
  delete missingSafetyTrader.getRuntimeSafetyStatus;
  const missingSafety = readinessServer(missingSafetyTrader).buildTradingReadiness(now);

  assert.equal(missingAnalysis.ready, false);
  assert.equal(missingAnalysis.checks.analysisHealthAvailable, false);
  assert.equal(invalidRisk.ready, false);
  assert.equal(invalidRisk.checks.riskHealthAvailable, false);
  assert.equal(missingSafety.ready, false);
  assert.equal(missingSafety.checks.runtimeSafetyAvailable, false);
});

test('trading readiness is false while the trader has entries paused', () => {
  const now = 1_800_000_000_000;
  const lastCompleteAt = new Date(now - 30_000).toISOString();
  const dashboard = readinessServer(healthyTrader({ lastCompleteAt, entriesPaused: true }));

  const readiness = dashboard.buildTradingReadiness(now);

  assert.equal(readiness.checks.analysisCycleFresh, true);
  assert.equal(readiness.checks.entriesPaused, true);
  assert.equal(readiness.checks.tradingHealthChecksPassed, false);
  assert.equal(readiness.ready, false);
});

test('trading readiness rejects infinite analysis intervals and data-gap limits', () => {
  const now = 1_800_000_000_000;
  const oldCycle = new Date(now - 24 * 60 * 60 * 1000).toISOString();

  const infiniteIntervalTrader = healthyTrader({ lastCompleteAt: oldCycle });
  infiniteIntervalTrader.config.checkInterval = Number.POSITIVE_INFINITY;
  const infiniteInterval = readinessServer(infiniteIntervalTrader).buildTradingReadiness(now);

  const infiniteGapTrader = healthyTrader({ lastCompleteAt: oldCycle });
  infiniteGapTrader.getAnalysisDataHealthStatus = () => ({
    failClosed: false,
    lastCompleteAt: oldCycle,
    maxAnalysisDataGapSeconds: Number.POSITIVE_INFINITY
  });
  const infiniteGap = readinessServer(infiniteGapTrader).buildTradingReadiness(now);

  assert.equal(infiniteInterval.ready, false);
  assert.equal(infiniteInterval.checks.analysisCycleConfigValid, false);
  assert.equal(Number.isFinite(infiniteInterval.checks.analysisCycleMaxAgeSeconds), true);
  assert.equal(infiniteGap.ready, false);
  assert.equal(infiniteGap.checks.analysisCycleConfigValid, false);
  assert.equal(Number.isFinite(infiniteGap.checks.analysisCycleMaxAgeSeconds), true);
});

test('read-only observers can be service-ready but never trading-ready', () => {
  const lastCompleteAt = new Date().toISOString();
  const dashboard = readinessServer(healthyTrader({ lastCompleteAt, readOnlyObserver: true }));

  assert.equal(dashboard.buildServiceReadiness().ready, true);
  const readiness = dashboard.buildTradingReadiness();
  assert.equal(readiness.ready, false);
  assert.equal(readiness.checks.traderCanTrade, false);
});
