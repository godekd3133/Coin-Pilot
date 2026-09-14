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

  const dashboard = new DashboardServer(trader, 0);
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
  const dashboard = new DashboardServer(trader, 0);
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
    positions: { 'KRW-BTC': { entryPrice: 100, size: 300, markValue: 330, markProfitPercent: 10 } },
    trades: [{ profitPercent: 1, entry: { size: 100 } }]
  }), 'utf8');

  const trader = createMockTrader();
  trader.config.momentumShadowFixedDir = fixedDir;
  trader.config.momentumShadowRegimeDir = regimeDir;
  trader.config.momentumShadowBenchmarkDir = regimeDir;
  const dashboard = new DashboardServer(trader, 0);
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
    assert.equal(body.books[0].status, '관찰 중');
    assert.equal(body.books[0].markedEquity, 1030);
    assert.ok(Math.abs(body.books[0].markedReturnPercent - 3) < 1e-12);
    assert.equal(body.books[0].unrealizedProfit, 30);
    assert.match(body.books[0].configurationWarning, /설정 변경/);
    assert.equal(body.books[0].realizedProfit, 1);
    assert.equal(body.candidateReadiness.readOnly, true);
    assert.equal(body.candidateReadiness.promotionAllowed, false);
    assert.equal(typeof body.candidateReadiness.launchAllowed, 'boolean');
    assert.equal(body.candidateReadiness.candidateConfig.breadthMin, 2);
    assert.equal(body.candidateReadiness.candidateConfig.minUpBars, 2);
    assert.equal(body.books[0].openPositions[0].asset, 'BTC');
    assert.equal(body.books[0].openPositions[0].markProfitPercent, 10);
    assert.equal(body.books[0].riskControls.configured, true);
    assert.equal(body.books[0].riskControls.cooldownAfterLossDays, 3);
    assert.equal(body.books[0].riskControls.maxPortfolioDrawdownPercent, 10);
    assert.equal(body.books[0].riskControls.drawdownStopTriggered, true);
    assert.equal(body.books[0].riskControls.cooldownBlockedEntries, 2);
    assert.equal(body.books[0].riskControls.drawdownBlockedEntries, 4);
    assert.equal(Object.hasOwn(body.books[0], 'directory'), false);
    assert.equal(body.books[1].available, false);
    assert.equal(body.books[2].available, false);
  } finally {
    dashboard.stop();
    trader.stop();
    fs.rmSync(fixedDir, { recursive: true, force: true });
    fs.rmSync(regimeDir, { recursive: true, force: true });
  }
});
