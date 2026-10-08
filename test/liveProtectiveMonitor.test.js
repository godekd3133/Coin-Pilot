import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import DashboardServer from '../src/api/dashboardServer.js';

function currentTicker(market, trade_price) {
  return { market, trade_price, trade_timestamp: Date.now() };
}

function makeLiveTrader(root, overrides = {}, exchangeStateKnown = true) {
  const trader = new MultiCoinTrader({
    accessKey: '',
    secretKey: '',
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: false,
    dryRunSeedMoney: 100_000,
    initialSeedMoney: 100_000,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    paperValidationFile: path.join(root, 'paper_validation.json'),
    liveExecutionEvidenceFile: path.join(root, 'live-execution.jsonl'),
    positionRiskCheckIntervalMs: 10_000,
    maxRiskDataGapSeconds: 5,
    maxCandleAgeSeconds: 0,
    candleUnit: 1,
    candleCount: 60,
    rsiPeriod: 14,
    rsiOversold: 30,
    rsiOverbought: 70,
    minReboundPercent: 0.15,
    minRsiRecovery: 2,
    minVolumeRatio: 1,
    minCloseStrength: 0.65,
    minTrendSlopePercent: -0.2,
    requirePreviousHighBreak: true,
    maxPositions: 3,
    portfolioAllocation: 0.1,
    investmentRatio: 0.02,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8,
    maxHoldMinutes: 30,
    maxLosingHoldMinutes: 0,
    cooldownAfterLossMinutes: 15,
    maxConsecutiveLosses: 3,
    ...overrides
  });
  trader._liveExchangeStateKnown = exchangeStateKnown;
  trader._liveAccountStateKnown = exchangeStateKnown;
  trader._liveOrderStateUnknownMarkets = new Set(exchangeStateKnown ? [] : trader.targetCoins);
  return trader;
}

test('LIVE startup refuses to run without the position risk monitor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-risk-monitor-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.positionRiskCheckIntervalMs = 0;
  trader.config.requireValidationPassForLive = false;

  assert.throws(
    () => trader.assertLiveValidationGate(),
    /포지션 위험 감시를 비활성화할 수 없습니다/
  );
});

test('LIVE startup refuses to disable the risk data freshness stop', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-risk-gap-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, { maxRiskDataGapSeconds: 0 });
  trader.config.requireValidationPassForLive = false;

  assert.equal(trader.positionRiskCheckIntervalMs > 0, true);
  assert.equal(trader.maxRiskDataGapSeconds, 0);
  assert.throws(
    () => trader.assertLiveValidationGate(),
    /리스크 데이터 공백 감지를 비활성화할 수 없습니다/
  );
});

test('LIVE scalping can start without performance evidence when the operator disables that requirement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-validation-bypass-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.config.requireValidationPassForLive = false;
  trader.config.scalpingValidationOutputFile = path.join(root, 'missing-scalping-validation.json');

  assert.doesNotThrow(() => trader.assertLiveValidationGate());
});

test('validation bypass flag remains outside DRY_RUN and non-scalping startup', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-validation-bypass-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const dryRunTrader = makeLiveTrader(root);
  dryRunTrader.dryRun = true;
  dryRunTrader.config.requireValidationPassForLive = false;
  assert.doesNotThrow(() => dryRunTrader.assertLiveValidationGate());

  const nonScalpingTrader = makeLiveTrader(root);
  nonScalpingTrader.isScalpingMode = false;
  nonScalpingTrader.config.requireValidationPassForLive = false;
  assert.doesNotThrow(() => nonScalpingTrader.assertLiveValidationGate());
});

test('start cannot clear a protective-only latch while a managed LIVE position remains', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-protective-restart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.assertLiveValidationGate = () => {};
  trader.getStrategy('KRW-BTC').openPosition(100, 100, 'BUY');
  trader._entriesPaused = true;
  trader._riskMonitorProtectiveOnly = true;
  trader.stopReason = 'risk_data_gap';

  trader.startPositionRiskMonitor = () => {};
  trader.startAnalysisDataWatchdog = () => {};
  trader.executeTradingCycle = async () => { trader.isRunning = false; };
  trader.recordPaperValidationSnapshot = async () => {};
  trader.sleep = async () => {};

  await assert.rejects(
    trader.start(),
    /보호 전용 상태에서는 자동매매를 다시 시작할 수 없습니다/
  );
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.equal(trader.isRunning, false);
  assert.equal(trader.getCurrentPositionCount(), 1);
});

test('LIVE startup remains paused until a complete exchange reconciliation succeeds', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-startup-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, {}, false);
  trader.config.requireValidationPassForLive = false;
  trader.config.scalpingValidationOutputFile = path.join(root, 'missing-report.json');
  const events = [];
  let syncAttempts = 0;
  trader.syncWithExchange = async () => {
    events.push('sync');
    assert.equal(trader._entriesPaused, true);
    syncAttempts += 1;
    const success = syncAttempts === 2;
    trader._liveExchangeStateKnown = success;
    return success;
  };
  trader.startPositionRiskMonitor = () => events.push('risk-monitor');
  trader.startAnalysisDataWatchdog = () => events.push('analysis-watchdog');
  trader.getCurrentPositionCount = () => 1;
  trader.monitorOpenPositions = async () => events.push('initial-risk-check');
  trader.executeTradingCycle = async () => {
    events.push('cycle');
    trader.isRunning = false;
    return true;
  };
  trader.recordPaperValidationSnapshot = async () => {};
  trader.sleep = async () => events.push('retry-delay');

  await trader.start();

  assert.equal(syncAttempts, 2);
  assert.deepEqual(events, [
    'sync', 'retry-delay', 'sync', 'risk-monitor', 'analysis-watchdog', 'initial-risk-check', 'cycle', 'retry-delay'
  ]);
  assert.equal(trader._entriesPaused, false);
});

test('startup reconciliation retries keep recovered LIVE positions in protective-only mode', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-startup-protective-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, {}, false);
  trader.assertLiveValidationGate = () => {};
  const events = [];
  let syncAttempts = 0;
  trader.syncWithExchange = async () => {
    syncAttempts += 1;
    trader._liveAccountStateKnown = true;
    const success = syncAttempts === 2;
    trader._liveExchangeStateKnown = success;
    return success;
  };
  trader.getCurrentPositionCount = () => 1;
  trader.startPositionRiskMonitor = () => {
    events.push('risk-monitor');
    trader.positionRiskTimer = {};
  };
  trader.startAnalysisDataWatchdog = () => events.push('analysis-watchdog');
  trader.executeTradingCycle = async () => { events.push('cycle'); trader.isRunning = false; };
  trader.recordPaperValidationSnapshot = async () => {};
  trader.sleep = async () => {};

  await trader.start();

  assert.equal(syncAttempts, 2);
  assert.equal(trader.isRunning, false);
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.equal(trader.getRuntimeSafetyStatus().protectiveMonitorActive, true);
  assert.deepEqual(events, ['risk-monitor']);
});

test('graceful shutdown request drains a managed LIVE position before stopping its monitor', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-graceful-drain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100, 100, 'BUY');
  trader._liveExchangeStateKnown = true;
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
  ];
  trader.upbit.getOrders = async () => [];
  trader.isRunning = true;
  trader.startPositionRiskMonitor();
  t.after(() => trader.stopPositionRiskMonitor());

  assert.equal(await trader.requestGracefulShutdown('operator_shutdown'), true);
  assert.equal(trader.isRunning, false);
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.notEqual(trader.positionRiskTimer, null);
  assert.equal(trader.stopReason, 'operator_shutdown');
});

test('graceful shutdown reconciles exchange holdings before deciding the LIVE process is flat', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-shutdown-reconcile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '0.02', locked: '0', avg_buy_price: '1000000' }
  ];
  trader.upbit.getOrders = async () => [];
  trader.startPositionRiskMonitor = () => {};

  assert.equal(trader.getCurrentPositionCount(), 0);
  assert.equal(await trader.requestGracefulShutdown('operator_shutdown'), true);
  assert.equal(trader._liveExchangeStateKnown, true);
  assert.equal(trader.getCurrentPositionCount(), 1);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
});

test('graceful shutdown retries exchange reads and does not exit on an unverified empty local map', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-shutdown-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.exchangeSyncRetryMs = 1;
  let syncAttempts = 0;
  trader.syncWithExchange = async () => {
    syncAttempts += 1;
    const success = syncAttempts >= 2;
    trader._liveExchangeStateKnown = success;
    trader._liveAccountStateKnown = success;
    if (success) {
      trader._liveOrderStateUnknownMarkets.clear();
      trader._livePendingOrderMarkets.clear();
      trader._liveEvidenceBlockedMarkets.clear();
      trader._liveUnresolvedOrderIds.clear();
      trader._liveUnresolvedOrderIntents.clear();
    }
    return success;
  };

  assert.equal(await trader.requestGracefulShutdown('operator_shutdown'), false);
  assert.equal(syncAttempts, 2);
  assert.equal(trader._liveExchangeStateKnown, true);
  assert.equal(trader._stopRequested, true);
});

test('graceful shutdown keeps waiting while an exchange order remains unresolved', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-shutdown-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.exchangeSyncRetryMs = 1;
  let orderReads = 0;
  trader.upbit.getAccounts = async () => [];
  trader.upbit.getOrders = async () => {
    orderReads += 1;
    return orderReads === 1 ? [{
      uuid: 'recent-order',
      created_at: new Date().toISOString()
    }] : [];
  };

  assert.equal(await trader.requestGracefulShutdown('operator_shutdown'), false);
  assert.equal(orderReads, 2);
  assert.equal(trader._liveExchangeStateKnown, true);
  assert.equal(trader.getCurrentPositionCount(), 0);
});

test('graceful shutdown waits while UUID-level order evidence remains unresolved', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-shutdown-evidence-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.sleep = async () => {};
  let syncAttempts = 0;
  trader.syncWithExchange = async () => {
    syncAttempts += 1;
    trader._liveAccountStateKnown = true;
    trader._liveExchangeStateKnown = true;
    const unresolved = syncAttempts === 1;
    trader._liveOrderStateUnknownMarkets = new Set(unresolved ? ['KRW-BTC'] : []);
    trader._livePendingOrderMarkets = new Set(unresolved ? ['KRW-BTC'] : []);
    trader._liveEvidenceBlockedMarkets = new Set(unresolved ? ['KRW-BTC'] : []);
    trader._liveUnresolvedOrderIds = new Map(unresolved
      ? [['prior-order', { orderId: 'prior-order', market: 'KRW-BTC' }]]
      : []);
    trader._liveUnresolvedOrderIntents = new Map();
    return true;
  };

  assert.equal(await trader.requestGracefulShutdown('operator_shutdown'), false);
  assert.equal(syncAttempts, 2);
  assert.equal(trader._liveExchangeStateKnown, true);
  assert.equal(trader._stopRequested, true);
});

test('graceful shutdown keeps observing a known position while account reconciliation retries', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-shutdown-account-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.exchangeSyncRetryMs = 1;
  trader.getStrategy('KRW-BTC').openPosition(100, 100, 'BUY');
  trader.startPositionRiskMonitor = () => { trader.positionRiskTimer = {}; };
  let accountReads = 0;
  trader.upbit.getAccounts = async () => {
    accountReads += 1;
    if (accountReads === 1) throw new Error('temporary account outage');
    return [
      { currency: 'KRW', balance: '1000000', locked: '0' },
      { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
    ];
  };
  trader.upbit.getOrders = async () => [];
  let tickerReads = 0;
  trader.riskUpbit.getTicker = async () => {
    tickerReads += 1;
    return [currentTicker('KRW-BTC', 100)];
  };
  trader.getAccountInfo = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
  ];

  const shutdown = trader.requestGracefulShutdown('operator_shutdown');
  while (accountReads === 0) await new Promise(resolve => setImmediate(resolve));
  assert.equal(trader._riskMonitorProtectiveOnly, true);

  await trader.monitorOpenPositions();
  assert.equal(tickerReads, 1);
  assert.equal(trader.getCurrentPositionCount(), 1);

  assert.equal(await shutdown, true);
  assert.equal(accountReads, 2);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.equal(trader._liveExchangeStateKnown, true);
});

test('graceful shutdown starts monitoring a known LIVE position before exchange rechecks', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-shutdown-monitor-first-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.exchangeSyncRetryMs = 1;
  trader.getStrategy('KRW-BTC').openPosition(100, 100, 'BUY');
  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = true;
  trader.startPositionRiskMonitor = () => { trader.positionRiskTimer = {}; };
  trader.upbit.getAccounts = async () => [];
  trader.upbit.getOrders = async () => [];
  let releaseFirstSync;
  let syncAttempts = 0;
  trader.syncWithExchange = async () => {
    syncAttempts += 1;
    if (syncAttempts === 1) {
      return new Promise(resolve => { releaseFirstSync = resolve; });
    }
    trader._liveAccountStateKnown = true;
    trader._liveExchangeStateKnown = true;
    trader._liveOrderStateUnknownMarkets.clear();
    trader._livePendingOrderMarkets.clear();
    trader._liveEvidenceBlockedMarkets.clear();
    trader._liveUnresolvedOrderIds.clear();
    trader._liveUnresolvedOrderIntents.clear();
    return true;
  };

  const shutdown = trader.requestGracefulShutdown('operator_shutdown');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader.getRuntimeSafetyStatus().protectiveMonitorActive, true);

  releaseFirstSync(false);
  assert.equal(await shutdown, true);
  assert.equal(syncAttempts, 2);
});

test('known positions keep receiving ticker observations while another market sync is unresolved', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-monitor-sync-pending-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.getStrategy('KRW-BTC').openPosition(100, 100, 'BUY');
  trader.isRunning = true;
  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = false;
  trader._liveOrderStateUnknownMarkets = new Set(['KRW-ETH']);
  trader._livePendingOrderMarkets = new Set();
  let tickerReads = 0;
  trader.riskUpbit.getTicker = async () => {
    tickerReads += 1;
    return [currentTicker('KRW-BTC', 100)];
  };
  trader.getAccountInfo = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
  ];

  await trader.monitorOpenPositions();

  assert.equal(tickerReads, 1);
  assert.equal(trader.getCurrentPositionCount(), 1);
  assert.equal(trader._riskCheckInProgress, false);
});

test('protective LIVE sells are permitted only when that market order state is verified clear', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-market-order-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = false;
  trader._liveOrderStateUnknownMarkets = new Set();
  trader._livePendingOrderMarkets = new Set();
  trader._riskMonitorProtectiveOnly = true;
  trader._riskMonitorExitInProgress = false;

  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', {
    action: 'SELL',
    details: { source: 'position_risk_monitor' }
  }), false);
  trader._riskMonitorExitInProgress = true;

  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'SELL' }), true);
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
  trader._liveOrderStateUnknownMarkets.add('KRW-BTC');
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'SELL' }), false);
  trader._liveOrderStateUnknownMarkets.delete('KRW-BTC');
  trader._livePendingOrderMarkets.add('KRW-BTC');
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'SELL' }), false);
});

test('protective LIVE exit remains pending when a stop is hit during exchange sync', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-deferred-protective-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100, 100, 'BUY');
  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = true;
  trader._liveVerifiedOrderMarkets.set('KRW-BTC', Date.now());
  trader.isRunning = true;

  let releaseOrdersRead;
  trader.upbit.getOrders = () => new Promise(resolve => { releaseOrdersRead = resolve; });
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
  ];
  let riskAccountReads = 0;
  trader.getAccountInfo = async () => {
    riskAccountReads += 1;
    return [
      { currency: 'KRW', balance: '1000000', locked: '0' },
      { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
    ];
  };
  let currentRiskPrice = 98;
  trader.riskUpbit.getTicker = async () => [
    currentTicker('KRW-BTC', currentRiskPrice)
  ];

  const sync = trader.syncWithExchange();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof releaseOrdersRead, 'function');
  assert.notEqual(trader._exchangeSyncPromise, null);
  assert.equal(trader._liveAccountStateKnown, false);

  const submittedOrders = [];
  trader.upbit.order = async (...args) => {
    submittedOrders.push(args);
    return { success: true, data: { uuid: `deferred-protective-sell-${submittedOrders.length}` } };
  };
  trader.upbit.waitForOrderFill = async () => ({
    filled: true,
    partial: false,
    order: {
      executed_volume: '100',
      avg_price: String(currentRiskPrice),
      paid_fee: '1',
      remaining_volume: '0'
    }
  });
  trader.recordLiveSettlementReadback = async () => ({ recorded: true });

  await trader.monitorOpenPositions();

  assert.equal(riskAccountReads, 0);
  assert.equal(submittedOrders.length, 0);
  assert.equal(strategy.currentPosition !== null, true);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.equal(trader._deferredProtectiveExitIntents.has('KRW-BTC'), true);

  releaseOrdersRead([]);
  assert.equal(await sync, true);
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', {
    action: 'SELL',
    details: { source: 'position_risk_monitor' }
  }), true);
  assert.equal(trader._deferredProtectiveExitIntents.has('KRW-BTC'), true);

  // The fresh quote has recovered above the fixed stop. The remembered stop
  // must still submit its exit instead of silently losing the trigger.
  currentRiskPrice = 99;
  await trader.monitorOpenPositions();

  assert.equal(riskAccountReads, 1);
  assert.equal(submittedOrders.length, 1);
  assert.deepEqual(submittedOrders[0].slice(0, 2), ['KRW-BTC', 'ask']);
  assert.equal(strategy.currentPosition, null);
  assert.equal(trader._deferredProtectiveExitIntents.has('KRW-BTC'), false);
});

test('a LIVE stop trigger survives a failed account read and retries with a fresh ticker', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-account-read-exit-intent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100, 100, 'BUY');
  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = true;
  trader._liveVerifiedOrderMarkets.set('KRW-BTC', Date.now());
  trader.isRunning = true;
  let currentRiskPrice = 98;
  trader.riskUpbit.getTicker = async () => [
    currentTicker('KRW-BTC', currentRiskPrice)
  ];
  let riskAccountReads = 0;
  trader.getAccountInfo = async () => {
    riskAccountReads += 1;
    if (riskAccountReads === 1) throw new Error('temporary account outage');
    return [
      { currency: 'KRW', balance: '1000000', locked: '0' },
      { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
    ];
  };
  const submittedOrders = [];
  trader.upbit.order = async (...args) => {
    submittedOrders.push(args);
    return { success: true, data: { uuid: `account-retry-sell-${submittedOrders.length}` } };
  };
  trader.upbit.waitForOrderFill = async () => ({
    filled: true,
    partial: false,
    order: {
      executed_volume: '100',
      avg_price: String(currentRiskPrice),
      paid_fee: '1',
      remaining_volume: '0'
    }
  });
  trader.recordLiveSettlementReadback = async () => ({ recorded: true });

  await trader.monitorOpenPositions();

  assert.equal(riskAccountReads, 1);
  assert.equal(submittedOrders.length, 0);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.equal(trader._deferredProtectiveExitIntents.has('KRW-BTC'), true);

  currentRiskPrice = 99;
  await trader.monitorOpenPositions();

  assert.equal(riskAccountReads, 2);
  assert.equal(submittedOrders.length, 1);
  assert.deepEqual(submittedOrders[0].slice(0, 2), ['KRW-BTC', 'ask']);
  assert.equal(strategy.currentPosition, null);
  assert.equal(trader._deferredProtectiveExitIntents.has('KRW-BTC'), false);
});

test('a malformed LIVE account snapshot leaves the protective exit intent queued', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-invalid-account-exit-intent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100, 100, 'BUY');
  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = true;
  trader._liveVerifiedOrderMarkets.set('KRW-BTC', Date.now());
  trader.isRunning = true;
  let currentRiskPrice = 98;
  trader.riskUpbit.getTicker = async () => [
    currentTicker('KRW-BTC', currentRiskPrice)
  ];
  let riskAccountReads = 0;
  trader.getAccountInfo = async () => {
    riskAccountReads += 1;
    return riskAccountReads === 1
      ? [{ currency: 'BTC', balance: 'invalid', locked: '0' }]
      : [{ currency: 'BTC', balance: '100', locked: '0' }];
  };
  let sellAttempts = 0;
  trader.executeOrder = async (...args) => {
    sellAttempts += 1;
    assert.equal(args[1].action, 'SELL');
    strategy.closePosition(args[2], args[1].reason);
  };

  await trader.monitorOpenPositions();

  assert.equal(sellAttempts, 0);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.equal(trader._deferredProtectiveExitIntents.has('KRW-BTC'), true);

  currentRiskPrice = 99;
  await trader.monitorOpenPositions();

  assert.equal(riskAccountReads, 2);
  assert.equal(sellAttempts, 1);
  assert.equal(strategy.currentPosition, null);
  assert.equal(trader._deferredProtectiveExitIntents.has('KRW-BTC'), false);
});

test('an unresolved protective SELL cannot submit twice before order-state reconciliation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-unresolved-protective-sell-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100, 100, 'BUY');
  trader._entriesPaused = true;
  trader._riskMonitorProtectiveOnly = true;
  trader.isRunning = false;
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
  ];
  trader.upbit.getOrders = async () => [];
  trader.upbit.getOrder = async orderId => ({
    uuid: orderId,
    market: 'KRW-BTC',
    side: 'ask',
    ord_type: 'market',
    state: 'cancel',
    executed_volume: '0',
    remaining_volume: '0',
    avg_price: '0',
    paid_fee: '0'
  });
  let currentRiskPrice = 98;
  trader.riskUpbit.getTicker = async () => [
    currentTicker('KRW-BTC', currentRiskPrice)
  ];
  let orderCalls = 0;
  trader.upbit.order = async () => {
    orderCalls += 1;
    return { success: true, data: { uuid: `protective-order-${orderCalls}` } };
  };
  let fillCalls = 0;
  trader.upbit.waitForOrderFill = async orderId => {
    fillCalls += 1;
    if (fillCalls === 1) {
      return {
        filled: false,
        error: 'fill not observed',
        order: {
          uuid: orderId,
          state: 'wait',
          executed_volume: '0',
          remaining_volume: '100'
        }
      };
    }
    return {
      filled: true,
      partial: false,
      order: {
        uuid: orderId,
        market: 'KRW-BTC',
        side: 'ask',
        ord_type: 'market',
        state: 'done',
        executed_volume: '100',
        remaining_volume: '0',
        avg_price: '99',
        paid_fee: '1'
      }
    };
  };

  await trader.monitorOpenPositions();
  assert.equal(orderCalls, 1);
  assert.equal(trader._liveOrderStateUnknownMarkets.has('KRW-BTC'), true);
  assert.equal(trader._livePendingOrderMarkets.has('KRW-BTC'), true);

  currentRiskPrice = 97;
  await trader.monitorOpenPositions();
  assert.equal(orderCalls, 1);
  assert.equal(strategy.currentPosition !== null, true);

  assert.equal(await trader.syncWithExchange(), true);
  assert.equal(trader._liveOrderStateUnknownMarkets.has('KRW-BTC'), false);
  assert.equal(trader._livePendingOrderMarkets.has('KRW-BTC'), false);

  currentRiskPrice = 99;
  await trader.monitorOpenPositions();
  assert.equal(orderCalls, 2);
  assert.equal(strategy.currentPosition, null);
});

test('graceful shutdown waits for an in-flight order before checking whether LIVE is flat', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-order-drain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.isRunning = true;
  const strategy = trader.getStrategy('KRW-BTC');
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    ...(strategy.currentPosition
      ? [{ currency: 'BTC', balance: String(strategy.currentPosition.amount), locked: '0', avg_buy_price: '100' }]
      : [])
  ];
  trader.upbit.getOrders = async () => [];
  trader.startPositionRiskMonitor();
  t.after(() => trader.stopPositionRiskMonitor());
  trader._orderInProgress = true;

  let shutdownResult;
  const shutdown = trader.requestGracefulShutdown('operator_shutdown').then(result => {
    shutdownResult = result;
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(trader._entriesPaused, true);
  assert.equal(trader.isRunning, false);
  assert.equal(shutdownResult, undefined);

  strategy.openPosition(100, 100, 'BUY');
  trader._orderInProgress = false;
  await shutdown;

  assert.equal(shutdownResult, true);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.notEqual(trader.positionRiskTimer, null);
});

test('graceful shutdown waits for an in-flight risk check before reconciling exchange state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-risk-drain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.upbit.getAccounts = async () => [];
  trader.upbit.getOrders = async () => [];
  trader._riskCheckInProgress = true;
  let accountReads = 0;
  const getAccounts = trader.upbit.getAccounts;
  trader.upbit.getAccounts = async () => {
    accountReads += 1;
    return getAccounts();
  };

  const shutdown = trader.requestGracefulShutdown('operator_shutdown');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accountReads, 0);

  trader._riskCheckInProgress = false;
  assert.equal(await shutdown, false);
  assert.equal(accountReads, 1);
  assert.equal(trader._liveExchangeStateKnown, true);
});

test('LIVE risk-data gap pauses entries, retries quotes, and allows one protected exit only', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-protective-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100, 100, 'BUY');
  trader._liveExchangeStateKnown = true;
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
  ];
  trader.upbit.getOrders = async () => [];
  trader.isRunning = true;
  trader.startPositionRiskMonitor();
  t.after(() => trader.stopPositionRiskMonitor());

  const staleAt = Date.now() - 6_000;
  const staleIso = new Date(staleAt).toISOString();
  trader.riskMonitorState = {
    monitoringActive: true,
    monitoringStartedAt: staleIso,
    lastAttemptAt: staleIso,
    lastSuccessAt: staleIso,
    currentOutageStartedAt: staleIso,
    continuityEligible: true,
    totalFailures: 0,
    consecutiveFailures: 0,
    maxObservedGapSeconds: 0,
    outageCount: 0
  };

  trader.handleRiskMonitorFailure(Object.assign(new Error('ticker timeout'), { code: 'ETIMEDOUT' }));

  assert.equal(trader.isRunning, false);
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.equal(trader._stopRequested, false);
  assert.notEqual(trader.positionRiskTimer, null);
  assert.equal(trader.getRiskMonitorStatus().continuityEligible, false);
  assert.deepEqual(trader.getRuntimeSafetyStatus(), {
    runtimeState: 'PROTECTIVE_ONLY',
    entriesPaused: true,
    manualProtectionActive: false,
    protectiveMonitorActive: true,
    stopReason: 'risk_data_gap',
    exchangeStateKnown: true,
    autoRecovery: null
  });
  const drainWait = trader.waitForProtectiveDrain();

  let riskTickerCalls = 0;
  const submittedOrders = [];
  trader.riskUpbit.getTicker = async () => {
    riskTickerCalls += 1;
    if (riskTickerCalls === 1) throw Object.assign(new Error('still unavailable'), { code: 'EHOSTUNREACH' });
    return [currentTicker('KRW-BTC', 98)];
  };
  trader.getAccountInfo = async () => [
    { currency: 'KRW', balance: '0', locked: '0' },
    { currency: 'BTC', balance: '100', locked: '0', avg_buy_price: '100' }
  ];
  trader.upbit.order = async (market, side, volume, price, orderType) => {
    submittedOrders.push({ market, side, volume, price, orderType });
    return { success: true, data: { uuid: 'protective-sell-1' } };
  };
  trader.upbit.waitForOrderFill = async () => ({
    filled: true,
    partial: false,
    order: {
      executed_volume: '100',
      avg_price: '98',
      paid_fee: '1',
      remaining_volume: '0'
    }
  });
  trader.createLiveExecutionEvidence = value => value;
  trader.recordLiveExecutionEvidence = () => true;
  trader.recordLiveSettlementReadback = async () => ({ recorded: true });
  trader.registerRuntimeLoss = () => {};
  trader.notifyTrade = () => {};

  const buyWhilePaused = await trader._executeOrder(
    'KRW-BTC',
    { action: 'BUY', signalStrength: { level: 'STRONG', multiplier: 1 } },
    98,
    100_000,
    0,
    1
  );
  const manualSellWhilePaused = await trader._executeOrder(
    'KRW-BTC',
    { action: 'SELL', reason: 'manual', details: { source: 'manual' } },
    98,
    0,
    100,
    1
  );
  assert.equal(buyWhilePaused, null);
  assert.equal(manualSellWhilePaused, null);
  assert.equal(submittedOrders.length, 0);
  trader.sleep = async () => {};
  trader.recordPaperEntryConfirmation = () => {};
  trader.resolveWinnerShadowBlockedEntryAsNotFilled = () => {};
  trader.upbit.getTicker = async () => {
    throw new Error('a paused confirmation must not request entry data');
  };
  assert.equal(await trader.confirmScalpingEntry(
    'KRW-BTC',
    { entryDelayMs: 1 },
    strategy
  ), null);

  await trader.monitorOpenPositions();
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.notEqual(trader.positionRiskTimer, null);
  assert.equal(strategy.currentPosition !== null, true);
  assert.equal(submittedOrders.length, 0);

  await trader.monitorOpenPositions();

  assert.equal(riskTickerCalls, 2);
  assert.deepEqual(submittedOrders, [{
    market: 'KRW-BTC',
    side: 'ask',
    volume: 100,
    price: null,
    orderType: 'market'
  }]);
  assert.equal(strategy.currentPosition, null);
  assert.equal(trader.isRunning, false);
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader._riskMonitorProtectiveOnly, false);
  assert.equal(trader.positionRiskTimer, null);
  assert.equal(trader.getRiskMonitorStatus().continuityEligible, false);
  assert.deepEqual(trader.getRuntimeSafetyStatus(), {
    runtimeState: 'STOPPED',
    entriesPaused: true,
    manualProtectionActive: false,
    protectiveMonitorActive: false,
    stopReason: 'risk_data_gap',
    exchangeStateKnown: true,
    autoRecovery: null
  });
  assert.equal(await drainWait, true);
});

test('late LIVE risk ticker crossing the stale limit enters protective-only before it is evaluated', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-inflight-protective-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100, 100, 'BUY');
  trader._liveExchangeStateKnown = true;
  trader.isRunning = true;
  trader.startPositionRiskMonitor();
  t.after(() => trader.stopPositionRiskMonitor());

  const staleIso = new Date(Date.now() - 6_000).toISOString();
  trader.riskMonitorState = {
    monitoringActive: true,
    monitoringStartedAt: staleIso,
    lastAttemptAt: staleIso,
    lastSuccessAt: staleIso,
    continuityEligible: true,
    totalFailures: 0,
    consecutiveFailures: 0,
    maxObservedGapSeconds: 0,
    outageCount: 0
  };

  let resolveTicker;
  let riskExitCount = 0;
  trader.riskUpbit.getTicker = () => new Promise(resolve => { resolveTicker = resolve; });
  trader.getAccountInfo = async () => [];
  trader.executeOrder = async (...args) => {
    assert.equal(args[1].action, 'SELL');
    assert.equal(trader._riskMonitorExitInProgress, true);
    riskExitCount += 1;
    strategy.closePosition(args[2], args[1].reason);
  };

  const pendingRiskCheck = trader.monitorOpenPositions();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(trader._riskCheckInProgress, true);

  const stale = trader.enforceRiskMonitorFreshness();
  assert.equal(stale.failClosed, true);
  assert.equal(trader.isRunning, false);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.notEqual(trader.positionRiskTimer, null);

  resolveTicker([currentTicker('KRW-BTC', 98)]);
  await pendingRiskCheck;

  assert.equal(riskExitCount, 1);
  assert.equal(strategy.currentPosition, null);
  assert.equal(trader._riskMonitorProtectiveOnly, false);
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader.isRunning, false);
  assert.equal(trader.getRiskMonitorStatus().continuityEligible, false);
});

test('analysis data gap uses protective-only mode for an open LIVE position', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-analysis-protective-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.getStrategy('KRW-BTC').openPosition(100, 100, 'BUY');
  trader.isRunning = true;
  trader.startPositionRiskMonitor();
  t.after(() => trader.stopPositionRiskMonitor());

  assert.equal(trader.pauseForSafetyIncident('analysis_data_gap'), true);
  assert.equal(trader.isRunning, false);
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
  assert.equal(trader.stopReason, 'analysis_data_gap');
  assert.notEqual(trader.positionRiskTimer, null);
});

test('an in-flight BUY rechecks entry pause before dispatching its order', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-buy-pause-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader._liveExchangeStateKnown = true;
  trader._liveAccountStateKnown = true;
  trader._liveVerifiedOrderMarkets.set('KRW-BTC', Date.now());
  const otherStrategy = trader.createStrategy();
  otherStrategy.openPosition(100, 100, 'BUY');
  trader.strategies.set('KRW-ETH', otherStrategy);
  trader.isRunning = true;
  trader.startPositionRiskMonitor();
  t.after(() => trader.stopPositionRiskMonitor());

  let resolveAssets;
  let orderDispatches = 0;
  trader.confirmScalpingEntry = async () => ({ currentPrice: 100, delayMs: 0 });
  trader.getAccountInfo = async () => [{ currency: 'KRW', balance: '100000', locked: '0' }];
  trader.calculateTotalAssets = () => new Promise(resolve => { resolveAssets = resolve; });
  trader.calculateDynamicInvestmentAmount = async () => 10_000;
  trader.upbit.order = async () => {
    orderDispatches += 1;
    return { success: true, data: { uuid: 'unexpected-buy' } };
  };

  const pendingBuy = trader.executeOrder(
    'KRW-BTC',
    { action: 'BUY', reason: 'test', signalStrength: { level: 'STRONG', multiplier: 1 } },
    100,
    100_000,
    0,
    1,
    []
  );
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof resolveAssets, 'function');

  trader.pauseForSafetyIncident('analysis_data_gap');
  resolveAssets(100_000);
  await pendingBuy;

  assert.equal(orderDispatches, 0);
  assert.equal(otherStrategy.currentPosition !== null, true);
  assert.equal(trader._riskMonitorProtectiveOnly, true);
});

test('manual LIVE session opt-in arms protective monitoring without enabling entries', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-manual-protection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, {
    liveManualPrepareOnBoot: true,
    liveManualRiskProtection: true
  });
  trader.upbit.accessKey = 'access';
  trader.upbit.secretKey = 'secret';
  trader.syncWithExchange = async () => {
    trader._liveExchangeStateKnown = true;
    trader._liveAccountStateKnown = true;
    trader._liveOrderStateUnknownMarkets.clear();
    trader._livePendingOrderMarkets.clear();
    return true;
  };
  t.after(() => trader.stopPositionRiskMonitor());

  const prepared = await trader.prepareManualLiveSession();
  assert.equal(prepared.ready, true);
  assert.equal(prepared.manualRiskProtection, true);
  assert.equal(trader.liveManualPrepared, true);
  assert.equal(trader._manualRiskProtection, true);
  assert.equal(trader._riskMonitorProtectiveOnly, false);
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader.isRunning, false);
  assert.notEqual(trader.positionRiskTimer, null);
  assert.equal(trader.getRuntimeSafetyStatus().manualProtectionActive, true);
});

test('manual LIVE session without the protection opt-in leaves the monitor off', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-manual-protection-off-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, { liveManualPrepareOnBoot: true });
  trader.upbit.accessKey = 'access';
  trader.upbit.secretKey = 'secret';
  trader.syncWithExchange = async () => {
    trader._liveExchangeStateKnown = true;
    trader._liveAccountStateKnown = true;
    trader._liveOrderStateUnknownMarkets.clear();
    trader._livePendingOrderMarkets.clear();
    return true;
  };

  const prepared = await trader.prepareManualLiveSession();
  assert.equal(prepared.ready, true);
  assert.equal(prepared.manualRiskProtection, false);
  assert.equal(trader._manualRiskProtection, false);
  assert.equal(trader.positionRiskTimer, null);
  assert.equal(trader.getRuntimeSafetyStatus().manualProtectionActive, false);

  // Even with an open position the monitor stays inert without the opt-in.
  trader.getStrategy('KRW-BTC').openPosition(100, 1, 'BUY');
  let tickerReads = 0;
  trader.riskUpbit.getTicker = async () => { tickerReads += 1; return [currentTicker('KRW-BTC', 97)]; };
  await trader.monitorOpenPositions();
  assert.equal(tickerReads, 0);
});

test('manual protection dispatches a protective sell while entries stay paused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-manual-protection-exit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, {
    liveManualPrepareOnBoot: true,
    liveManualRiskProtection: true
  });
  trader.upbit.accessKey = 'access';
  trader.upbit.secretKey = 'secret';
  trader.syncWithExchange = async () => {
    trader._liveExchangeStateKnown = true;
    trader._liveAccountStateKnown = true;
    trader._liveOrderStateUnknownMarkets.clear();
    trader._livePendingOrderMarkets.clear();
    return true;
  };
  t.after(() => trader.stopPositionRiskMonitor());
  await trader.prepareManualLiveSession();

  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100, 1, 'BUY');
  const exits = [];
  trader.executeOrder = async (coin, decision) => { exits.push({ coin, decision }); return 'exit'; };
  trader.getAccountInfo = async () => ([
    { currency: 'KRW', balance: '900000', locked: '0' },
    { currency: 'BTC', balance: '1', locked: '0', avg_buy_price: '100' }
  ]);
  trader.riskUpbit.getTicker = async () => [currentTicker('KRW-BTC', 97)];

  await trader.monitorOpenPositions();
  assert.equal(exits.length, 1);
  assert.equal(exits[0].coin, 'KRW-BTC');
  assert.equal(exits[0].decision.action, 'SELL');
  assert.equal(trader._entriesPaused, true);
  assert.equal(trader.isRunning, false);
});

test('manual protection permits a protective sell only while the monitor holds the exit flag', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-manual-protection-gate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, {
    liveManualPrepareOnBoot: true,
    liveManualRiskProtection: true
  });
  trader._manualRiskProtection = true;
  trader._liveVerifiedOrderMarkets.clear();

  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'SELL' }), false);
  trader._riskMonitorExitInProgress = true;
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'SELL' }), true);
  trader._livePendingOrderMarkets.add('KRW-BTC');
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'SELL' }), false);
});

test('a protective drain in a manual session hands monitoring back instead of stopping it', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-manual-protection-drain-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, {
    liveManualPrepareOnBoot: true,
    liveManualRiskProtection: true
  });
  trader._manualRiskProtection = true;
  trader._riskMonitorProtectiveOnly = true;
  trader.startPositionRiskMonitor();
  t.after(() => trader.stopPositionRiskMonitor());

  assert.equal(trader.finishProtectiveMonitoringWhenFlat(), true);
  assert.equal(trader._riskMonitorProtectiveOnly, false);
  assert.equal(trader._manualRiskProtection, true);
  assert.notEqual(trader.positionRiskTimer, null);
  assert.equal(trader.getRuntimeSafetyStatus().manualProtectionActive, true);
});

test('stopping a manual session clears protection and its timer', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-manual-protection-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, {
    liveManualPrepareOnBoot: true,
    liveManualRiskProtection: true
  });
  trader._manualRiskProtection = true;
  trader.startPositionRiskMonitor();
  trader.stop('operator_stop');
  assert.equal(trader._manualRiskProtection, false);
  assert.equal(trader.positionRiskTimer, null);
  assert.equal(trader.getRuntimeSafetyStatus().manualProtectionActive, false);
});


test('LIVE control API starts analysis without a performance report and stops it without sending orders', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-optional-control-'));
  const trader = makeLiveTrader(root, {
    requireValidationPassForLive: false,
    scalpingValidationOutputFile: path.join(root, 'missing-report.json')
  });
  let cycleCount = 0;
  let orderCount = 0;
  trader.startPositionRiskMonitor = () => {};
  trader.startAnalysisDataWatchdog = () => {};
  trader.syncWithExchange = async () => true;
  trader.executeTradingCycle = async () => { cycleCount += 1; };
  trader.recordPaperValidationSnapshot = async () => {};
  trader.sleep = async () => new Promise(resolve => setTimeout(resolve, 5));
  trader.upbit.order = async () => { orderCount += 1; throw new Error('No real exchange in this test'); };
  const dashboard = new DashboardServer(trader, 0, { env: {
    ...process.env, DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '',
    DASHBOARD_MOBILE_TOKEN: '', DASHBOARD_HOST: '127.0.0.1'
  } });
  const httpServer = await dashboard.start();
  t.after(async () => {
    trader.stop();
    await dashboard.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${httpServer.address().port}/api`;
  const start = await fetch(`${base}/control/start`, { method: 'POST' });
  assert.equal(start.status, 202);
  assert.equal((await start.json()).success, true);
  assert.equal(trader.isRunning, true);
  assert.ok(cycleCount > 0);
  const duplicate = await fetch(`${base}/control/start`, { method: 'POST' });
  assert.equal((await duplicate.json()).success, false);
  const stop = await fetch(`${base}/control/stop`, { method: 'POST' });
  assert.ok([200, 202].includes(stop.status));
  assert.equal((await stop.json()).success, true);
  await trader._startPromise;
  await trader._gracefulShutdownPromise;
  assert.equal(trader.isRunning, false);
  assert.equal(trader.getRuntimeSafetyStatus().entriesPaused, true);
  const cyclesAtStop = cycleCount;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(cycleCount, cyclesAtStop);
  assert.equal(orderCount, 0);
});
