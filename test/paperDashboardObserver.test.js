import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import DashboardServer from '../src/api/dashboardServer.js';
import { FixtureMarketDataAdapter } from '../src/market-data/marketDataAdapters.js';
import {
  attachReadOnlyPaperLedger,
  createMockTrader
} from '../src/scripts/runDashboard.js';

test('읽기 전용 paper dashboard는 최신 ledger를 표시하고 원본을 쓰지 않는다', async () => {
  const suffix = `coinpilot-dashboard-observer-${Date.now()}`;
  const ledgerFile = path.join(os.tmpdir(), `${suffix}.json`);
  const trader = createMockTrader();
  const now = new Date().toISOString();
  const baseLedger = trader.paperValidation;
  const ledger = {
    ...baseLedger,
    sessionId: 'paper-observer-fixture',
    active: true,
    processId: process.pid,
    startedAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    heartbeatAt: now,
    baselineAssets: 1_000_000,
    configSnapshot: {
      ...baseLedger.configSnapshot,
      emaPeriod: 60
    },
    snapshots: [
      { timestamp: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), totalAssets: 1_000_000 },
      { timestamp: now, totalAssets: 999_000 }
    ],
    strictTrades: [{
      action: 'CLOSE',
      coin: 'KRW-BTC',
      exitTime: now,
      profit: -100,
      profitPercent: -0.1,
      ledgerKey: 'paper-observer-fixture:close-1'
    }],
    strictOpenPositions: []
  };

  try {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8');
    attachReadOnlyPaperLedger(trader, ledgerFile);
    const before = fs.readFileSync(ledgerFile, 'utf8');

    const first = await trader.getPaperValidationStatus();
    assert.equal(first.sessionId, 'paper-observer-fixture');
    assert.equal(first.active, true);
    assert.equal(first.currentAssets, 999_000);
    assert.equal(first.closedTradeCount, 1);
    assert.equal(first.realizedProfit, -100);
    assert.equal(first.strictExecutionCostAudit.available, true);
    assert.equal(first.strictExecutionCostAudit.closedTradeCount, 1);
    assert.equal(first.strictExecutionCostAudit.evaluatedTradeCount, 0);
    assert.equal(first.strictExecutionCostAudit.costStressedNetPnlKrw, null);
    assert.equal(first.configConsistent, true);
    assert.equal(first.executionOutcomeComparison.researchOnly, true);
    assert.equal(first.executionOutcomeComparison.promoted, false);
    assert.equal(first.executionOutcomeComparison.available, false);
    assert.equal(first.executionRobustnessGate.required, true);
    assert.equal(first.executionRobustnessGate.passed, false);
    assert.equal(first.executionRobustnessGate.reason, 'execution_comparison_pairs_insufficient');
    assert.ok(first.promotionBlockers.some(blocker => blocker.includes('실행 경계 비교 표본')));
    assert.equal(
      trader.config.scalpingValidationOutputFile,
      path.join(path.dirname(ledgerFile), 'scalping_validation.json')
    );
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before);

    const updated = {
      ...ledger,
      heartbeatAt: new Date(Date.now() + 1_000).toISOString(),
      snapshots: [...ledger.snapshots, { timestamp: now, totalAssets: 998_500 }]
    };
    fs.writeFileSync(ledgerFile, JSON.stringify(updated, null, 2), 'utf8');
    const refreshed = await trader.getPaperValidationStatus();
    assert.equal(refreshed.currentAssets, 998_500);
    assert.equal(refreshed.closedTradeCount, 1);
    assert.equal(refreshed.executionOutcomeComparison.available, false);
    assert.equal(refreshed.executionRobustnessGate.passed, false);

    await assert.rejects(
      () => trader.startPaperValidationSession(),
      /읽기 전용/
    );
    await assert.rejects(
      () => trader.stopPaperValidationSession(),
      /읽기 전용/
    );
    assert.equal(fs.readFileSync(ledgerFile, 'utf8'), JSON.stringify(updated, null, 2));

    const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
    const httpServer = await dashboard.start();
    const port = httpServer.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/trade/buy`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coin: 'KRW-BTC', amount: 5000 })
      });
      const responseBody = await response.json();
      assert.equal(response.status, 403);
      assert.equal(responseBody.readOnlyObserver, true);

      const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
      const statusBody = await statusResponse.json();
      assert.equal(statusResponse.status, 200);
      assert.equal(statusBody.readOnlyObserver, true);

      const snapshotResponse = await fetch(`http://127.0.0.1:${port}/api/portfolio/snapshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      });
      const snapshotBody = await snapshotResponse.json();
      assert.equal(snapshotResponse.status, 200);
      assert.equal(snapshotBody.success, true);
      assert.equal(snapshotBody.readOnlyObserver, true);
      assert.equal(snapshotBody.recorded, false);
      assert.equal(fs.existsSync(trader.portfolioHistoryFile), false);
      assert.equal(fs.readFileSync(ledgerFile, 'utf8'), JSON.stringify(updated, null, 2));
      await assert.rejects(
        () => trader.recordPaperValidationSnapshot('test'),
        /읽기 전용/
      );
      assert.notEqual(
        path.resolve(trader.portfolioHistoryFile),
        path.resolve('portfolio_history.json')
      );
    } finally {
      await dashboard.stop();
    }
  } finally {
    trader.stop();
    for (const file of [ledgerFile, trader.portfolioHistoryFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('portfolio analysis does not substitute average price when the market snapshot is incomplete', async t => {
  const adapter = new FixtureMarketDataAdapter({
    markets: ['KRW-BTC'],
    candleSets: [{ market: 'KRW-BTC', unit: 1, candles: [] }]
  });
  const trader = {
    dryRun: true,
    initialSeedMoney: 1000,
    virtualPortfolio: {
      krwBalance: 1000,
      holdings: new Map([['KRW-BTC', { amount: 2, avgPrice: 100 }]])
    },
    marketDataAdapter: adapter,
    upbit: {},
    getKRWBalance: portfolio => portfolio?.krwBalance ?? 0
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...process.env, DASHBOARD_TOKEN: '' },
    logger,
    manualOrderIdempotencyStore: {
      async initialize() {},
      releaseWriterLock() {}
    }
  });
  t.after(() => dashboard.stop());
  const httpServer = await dashboard.start();
  const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/portfolio-analysis`);
  const analysis = await response.json();

  assert.equal(response.status, 200);
  assert.equal(analysis.summary.valuationAvailable, false);
  assert.equal(analysis.summary.valuationStatus, 'unavailable');
  assert.equal(analysis.summary.totalValue, null);
  assert.equal(analysis.summary.totalProfit, null);
  assert.equal(analysis.summary.totalAssets, null);
  assert.deepEqual(analysis.summary.unavailableMarkets, ['KRW-BTC']);
  assert.equal(analysis.holdings[0].currentPrice, null);
  assert.equal(analysis.holdings[0].currentValue, null);
  assert.equal(analysis.holdings[0].profit, null);
  assert.equal(analysis.holdings[0].profitPercent, null);
  assert.equal(analysis.holdings[0].weight, null);
  assert.equal(analysis.holdings[0].valuationAvailable, false);
});

test('portfolio analysis exposes source time and calculates values from a complete fixture snapshot', async t => {
  const sourceAsOf = new Date().toISOString();
  const adapter = new FixtureMarketDataAdapter({
    markets: ['KRW-BTC'],
    tickers: [{ market: 'KRW-BTC', trade_price: 120, trade_timestamp: sourceAsOf }]
  });
  const trader = {
    dryRun: true,
    initialSeedMoney: 1000,
    virtualPortfolio: {
      krwBalance: 1000,
      holdings: new Map([['KRW-BTC', { amount: 2, avgPrice: 100 }]])
    },
    marketDataAdapter: adapter,
    upbit: {},
    getKRWBalance: portfolio => portfolio?.krwBalance ?? 0
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const dashboard = new DashboardServer(trader, 0, {
    env: { ...process.env, DASHBOARD_TOKEN: '' },
    logger,
    manualOrderIdempotencyStore: {
      async initialize() {},
      releaseWriterLock() {}
    }
  });
  t.after(() => dashboard.stop());
  const httpServer = await dashboard.start();
  const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/portfolio-analysis`);
  const analysis = await response.json();

  assert.equal(response.status, 200);
  assert.equal(analysis.summary.valuationAvailable, true);
  assert.equal(analysis.summary.totalValue, 240);
  assert.equal(analysis.summary.totalCost, 200);
  assert.equal(analysis.summary.totalProfit, 40);
  assert.equal(analysis.summary.totalAssets, 1240);
  assert.equal(analysis.summary.valuationAsOf, sourceAsOf);
  assert.equal(analysis.summary.fetchedAt, null);
  assert.equal(analysis.holdings[0].currentPrice, 120);
  assert.equal(analysis.holdings[0].currentValue, 240);
  assert.equal(analysis.holdings[0].profit, 40);
  assert.equal(analysis.holdings[0].profitPercent, '20.00');
  assert.equal(analysis.holdings[0].change24h, null);
  assert.equal(analysis.holdings[0].valuationAvailable, true);
});

test('읽기 전용 observer는 orphan 미청산 ledger를 UI에서도 fail-closed로 표시한다', async () => {
  const suffix = `coinpilot-dashboard-orphan-${Date.now()}`;
  const ledgerFile = path.join(os.tmpdir(), `${suffix}.json`);
  const trader = createMockTrader();
  const now = new Date().toISOString();
  const ledger = {
    ...trader.paperValidation,
    sessionId: 'paper-orphan-observer-fixture',
    active: true,
    processId: 999_999_999,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    heartbeatAt: now,
    telemetry: {
      ...(trader.paperValidation.telemetry || {}),
      heartbeatAt: now
    },
    strictOpenPositions: [{ coin: 'KRW-BTC', entryPrice: 100 }],
    shadow: {
      ...(trader.paperValidation.shadow || {}),
      positions: { 'KRW-BTC': { coin: 'KRW-BTC', entryPrice: 100 } }
    },
    looseShadow: {
      ...(trader.paperValidation.looseShadow || {}),
      positions: {}
    }
  };

  try {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2), 'utf8');
    attachReadOnlyPaperLedger(trader, ledgerFile);
    const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
    const httpServer = await dashboard.start();
    const port = httpServer.address().port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/paper-validation`);
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(body.readOnlyObserver, true);
      assert.equal(body.orphaned, true);
      assert.equal(body.orphanReason, 'owner_process_missing');
      assert.equal(body.active, false);
      assert.equal(body.state, 'STOPPED');
      assert.equal(body.continuityEligible, false);
      assert.equal(body.endedWithOpenPositions, true);
      assert.equal(body.endedWithDiagnosticOpenPositions, true);
      assert.deepEqual(body.strictEvaluation.positions.map(position => position.coin), ['KRW-BTC']);
      assert.deepEqual(body.diagnosticOpenPositions.map(position => position.coin), ['KRW-BTC']);
    } finally {
      await dashboard.stop();
    }
  } finally {
    trader.stop();
    if (fs.existsSync(ledgerFile)) fs.unlinkSync(ledgerFile);
  }
});

test('읽기 전용 paper dashboard는 ledger baseline으로 수익률을 계산한다', async () => {
  const suffix = `coinpilot-dashboard-baseline-${Date.now()}`;
  const ledgerFile = path.join(os.tmpdir(), `${suffix}.json`);
  const trader = createMockTrader();
  const now = new Date().toISOString();
  const ledger = {
    ...trader.paperValidation,
    sessionId: 'paper-baseline-observer-fixture',
    active: true,
    processId: process.pid,
    startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    heartbeatAt: now,
    baselineAssets: 10_000_000,
    snapshots: [
      { timestamp: now, totalAssets: 10_004_715 }
    ],
    strictTrades: [],
    strictOpenPositions: []
  };

  try {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger), 'utf8');
    attachReadOnlyPaperLedger(trader, ledgerFile);
    const pnl = await trader.calculateCumulativePnL();
    assert.equal(pnl.initialSeedMoney, 10_000_000);
    assert.equal(pnl.totalAssets, 10_004_715);
    assert.ok(Math.abs(pnl.profitPercent - 0.04715) < 1e-9);
    assert.equal(trader.virtualPortfolio.krwBalance, 10_000_000);
  } finally {
    trader.stop();
    if (fs.existsSync(ledgerFile)) fs.unlinkSync(ledgerFile);
  }
});

test('읽기 전용 observer의 계좌·보유·구성 API는 paper ledger를 따르고 미기록 현금·시세를 만들지 않는다', async () => {
  const suffix = `coinpilot-dashboard-portfolio-observer-${Date.now()}`;
  const ledgerFile = path.join(os.tmpdir(), `${suffix}.json`);
  const trader = createMockTrader();
  const now = new Date().toISOString();
  const position = {
    coin: 'KRW-SOL',
    entryPrice: 162_000,
    amount: 1.2339506172839507,
    entryTime: now
  };
  const ledger = {
    ...trader.paperValidation,
    sessionId: 'paper-portfolio-observer-fixture',
    active: true,
    processId: process.pid,
    heartbeatAt: now,
    baselineAssets: 10_000_000,
    snapshots: [{ timestamp: now, totalAssets: 10_000_640 }],
    strictTrades: [],
    strictOpenPositions: [position]
  };

  try {
    fs.writeFileSync(ledgerFile, JSON.stringify(ledger), 'utf8');
    attachReadOnlyPaperLedger(trader, ledgerFile);
    const originalGetAccountInfo = trader.getAccountInfo.bind(trader);
    let mockAccountReads = 0;
    trader.getAccountInfo = async (...args) => {
      mockAccountReads += 1;
      return originalGetAccountInfo(...args);
    };

    const dashboard = new DashboardServer(trader, 0, { env: { ...process.env, DASHBOARD_TOKEN: '' } });
    const httpServer = await dashboard.start();
    const port = httpServer.address().port;
    const ledgerBytes = fs.readFileSync(ledgerFile, 'utf8');
    try {
      const accountResponse = await fetch(`http://127.0.0.1:${port}/api/account`);
      const account = await accountResponse.json();
      assert.equal(accountResponse.status, 200);
      assert.equal(account.readOnlyObserver, true);
      assert.equal(account.valuationBasis, 'paper_ledger_snapshot');
      assert.equal(account.krwBalance, null);
      assert.equal(account.totalAssets, 10_000_640);
      assert.equal(account.initialSeedMoney, 10_000_000);
      assert.deepEqual(account.positions.map(item => item.coin), ['KRW-SOL']);
      assert.equal(account.positions[0].currentPrice, null);
      assert.equal(account.positions[0].currentValue, null);
      assert.equal(account.positions[0].profit, null);

      const positionsResponse = await fetch(`http://127.0.0.1:${port}/api/positions`);
      const positions = await positionsResponse.json();
      assert.equal(positions.readOnlyObserver, true);
      assert.deepEqual(positions.holdings.map(item => item.coin), ['KRW-SOL']);
      assert.equal(positions.holdings[0].currentPrice, null);

      const analysisResponse = await fetch(`http://127.0.0.1:${port}/api/portfolio-analysis`);
      const analysis = await analysisResponse.json();
      assert.equal(analysis.readOnlyObserver, true);
      assert.equal(analysis.allocationAvailable, false);
      assert.deepEqual(analysis.holdings.map(item => item.coin), ['KRW-SOL']);
      assert.equal(analysis.holdings[0].currentValue, null);
      assert.equal(analysis.summary.krwBalance, null);
      assert.equal(analysis.summary.totalAssets, 10_000_640);
      assert.equal(analysis.summary.totalProfit, 640);

      const historyResponse = await fetch(`http://127.0.0.1:${port}/api/portfolio/history?period=24h`);
      const history = await historyResponse.json();
      assert.equal(historyResponse.status, 200);
      assert.equal(history.readOnlyObserver, true);
      assert.equal(history.count, 1);
      assert.equal(history.data[0].totalAssets, 10_000_640);
      assert.equal(mockAccountReads, 0);
      assert.equal(fs.readFileSync(ledgerFile, 'utf8'), ledgerBytes);
    } finally {
      await dashboard.stop();
    }
  } finally {
    trader.stop();
    for (const file of [ledgerFile, trader.portfolioHistoryFile]) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});
