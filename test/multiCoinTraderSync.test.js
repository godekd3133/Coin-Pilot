import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import axios from 'axios';
import UpbitAPI from '../src/api/upbit.js';
import { executeLiveOrderWithEvidence } from '../src/api/routes/trading.js';
import { inspectLiveExecutionEvidenceFile } from '../src/research/liveExecutionEvidence.js';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

function makeLiveTrader(root, overrides = {}) {
  return new MultiCoinTrader({
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
}

function markLiveTraderExchangeReady(trader) {
  trader._liveAccountStateKnown = true;
  trader._liveExchangeStateKnown = true;
  trader._liveOrderStateUnknownMarkets.clear();
  trader._livePendingOrderMarkets.clear();
  for (const market of trader.getLiveManagedMarkets()) {
    trader._liveVerifiedOrderMarkets.set(market, Date.now());
  }
}

async function submitDurableMockOrder(trader, orderId, market = 'KRW-BTC') {
  markLiveTraderExchangeReady(trader);
  trader.upbit.order = async () => ({ success: true, data: { uuid: orderId } });
  return trader.submitLiveOrder(market, 'bid', 100_000, null, 'price');
}

test('failed exchange position sync skips analysis and remains due for retry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  let accountSyncAttempts = 0;
  let accountReads = 0;
  trader.upbit.getOrders = async () => [];
  trader.upbit.getAccounts = async () => {
    accountSyncAttempts += 1;
    throw new Error('temporary exchange outage');
  };
  trader.getAccountInfo = async () => {
    accountReads += 1;
    return [];
  };

  assert.equal(await trader.executeTradingCycle(), false);
  trader._lastExchangeSyncAttemptTime = 0;
  assert.equal(await trader.executeTradingCycle(), false);

  assert.equal(accountSyncAttempts, 2);
  assert.equal(accountReads, 0);
  assert.equal(trader._lastSyncTime, undefined);
  assert.equal(trader.analysisCycleProgress, null);
});

test('manual-only LIVE preparation syncs state without starting entries or cancelling existing orders', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-manual-prepare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root, {
    targetCoins: ['KRW-BTC', 'KRW-ETH'],
    accessKey: 'test-access-key',
    secretKey: 'test-secret-key',
    liveManualPrepareOnBoot: true
  });
  const staleOrderId = 'owned-stale-order';
  trader._liveEngineOrderIds.add(staleOrderId);
  trader._liveEngineOrderMarkets.set(staleOrderId, 'KRW-BTC');
  let cancelAttempts = 0;
  trader.upbit.getOrders = async market => market === 'KRW-BTC'
    ? [{
        uuid: staleOrderId,
        state: 'wait',
        created_at: new Date(Date.now() - 6 * 60 * 1000).toISOString()
      }]
    : [];
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' }
  ];
  trader.upbit.cancelOrder = async () => {
    cancelAttempts += 1;
    return { state: 'cancel' };
  };

  const prepared = await trader.prepareManualLiveSession();

  assert.equal(prepared.ready, true);
  assert.equal(trader.isRunning, false, 'Manual-only preparation must not start the automated cycle.');
  assert.equal(trader._entriesPaused, true, 'New automatic entries must remain paused.');
  assert.equal(trader.stopReason, 'operator_stop', 'A verified manual-only server must report an operator-stopped state.');
  assert.equal(trader.getRuntimeSafetyStatus().exchangeStateKnown, true);
  assert.equal(trader.getRuntimeSafetyStatus().runtimeState, 'STOPPED');
  assert.deepEqual(prepared.pendingOrderMarkets, ['KRW-BTC']);
  assert.equal(cancelAttempts, 0, 'Reconciliation must leave existing exchange orders untouched.');
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
  assert.equal(trader.canExecuteLiveOrder('KRW-ETH', { action: 'BUY' }), true);

  trader.stop();
});

test('unverified LIVE order state retries reconciliation before the regular sync interval', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-unknown-state-retry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader._liveExchangeStateKnown = false;
  trader._lastSyncTime = Date.now();
  let syncAttempts = 0;
  trader.syncWithExchange = async () => {
    syncAttempts += 1;
    return false;
  };

  assert.equal(await trader.executeTradingCycle(), false);
  assert.equal(syncAttempts, 1);
  assert.equal(await trader.executeTradingCycle(), false);
  assert.equal(syncAttempts, 1);

  trader._lastExchangeSyncAttemptTime = 0;
  assert.equal(await trader.executeTradingCycle(), false);
  assert.equal(syncAttempts, 2);
  assert.equal(trader.analysisCycleProgress, null);
});

test('failed pending-order read blocks a live cycle instead of marking sync successful', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-order-read-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  let orderReadAttempts = 0;
  let accountReads = 0;
  trader.upbit.getAccounts = async () => [];
  trader.upbit.getOrders = async () => {
    orderReadAttempts += 1;
    throw new Error('temporary order-read outage');
  };
  trader.getAccountInfo = async () => {
    accountReads += 1;
    return [];
  };

  assert.equal(await trader.executeTradingCycle(), false);
  assert.equal(orderReadAttempts, 1);
  assert.equal(accountReads, 0);
  assert.equal(trader._lastSyncTime, undefined);
});

test('failed stale-order cancellation keeps its market blocked while exchange state is readable', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-order-cancel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  let cancelAttempts = 0;
  let accountReads = 0;
  trader._liveEngineOrderIds.add('pending-order');
  trader._liveEngineOrderMarkets.set('pending-order', 'KRW-BTC');
  trader.upbit.getAccounts = async () => [];
  trader.upbit.getOrders = async () => [{
    uuid: 'pending-order',
    created_at: new Date(Date.now() - 6 * 60_000).toISOString()
  }];
  trader.upbit.cancelOrder = async () => {
    cancelAttempts += 1;
    throw new Error('temporary order-cancel outage');
  };
  trader.getAccountInfo = async () => {
    accountReads += 1;
    return [];
  };

  assert.equal(await trader.syncWithExchange(), true);
  assert.equal(cancelAttempts, 1);
  assert.equal(accountReads, 0);
  assert.equal(trader._liveExchangeStateKnown, true);
  assert.equal(trader._livePendingOrderMarkets.has('KRW-BTC'), true);
});

test('stale orders with unknown ownership are not cancelled automatically', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-unowned-stale-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  let cancelAttempts = 0;
  trader.upbit.getAccounts = async () => [];
  trader.upbit.getOrders = async () => [{
    uuid: 'manual-order',
    created_at: new Date(Date.now() - 6 * 60_000).toISOString()
  }];
  trader.upbit.cancelOrder = async () => { cancelAttempts += 1; return { state: 'cancel' }; };

  assert.equal(await trader.syncWithExchange(), true);
  assert.equal(trader._liveExchangeStateKnown, true);
  assert.equal(cancelAttempts, 0);
  assert.equal(trader._livePendingOrderMarkets.has('KRW-BTC'), true);
});

test('only order ids recorded by this engine remain eligible for stale-order cleanup after restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-owned-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const first = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  const event = first.createLiveExecutionEvidence({
    eventType: 'ORDER_SUBMITTED',
    orderId: 'engine-order',
    market: 'KRW-BTC',
    side: 'bid',
    orderType: 'price'
  });
  assert.equal(first.recordLiveExecutionEvidence(event), true);
  assert.equal(first._liveEngineOrderIds.has('engine-order'), true);

  const restarted = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  assert.equal(restarted._liveEngineOrderIds.has('engine-order'), true);
  assert.equal(restarted._liveEngineOrderMarkets.get('engine-order'), 'KRW-BTC');
});

test('recent pending orders block only their market until the order is gone', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-recent-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  let orderReads = 0;
  trader.upbit.getAccounts = async () => [];
  trader.upbit.getOrders = async () => {
    orderReads += 1;
    return orderReads === 1 ? [{
      uuid: 'recent-order',
      created_at: new Date().toISOString()
    }] : [];
  };

  assert.equal(await trader.syncWithExchange(), true);
  assert.equal(trader._liveExchangeStateKnown, true);
  assert.equal(trader._livePendingOrderMarkets.has('KRW-BTC'), true);
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
  assert.equal(await trader.syncWithExchange(), true);
  assert.equal(trader._liveExchangeStateKnown, true);
  assert.equal(trader._livePendingOrderMarkets.has('KRW-BTC'), false);
  assert.equal(orderReads, 2);
});

test('watch reservation orders are queried and block LIVE trading on their market', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-watch-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  let queriedStates;
  trader.upbit.getOrders = async (_market, states) => {
    queriedStates = states;
    return [{
      uuid: 'exchange-watch-order',
      state: 'watch',
      created_at: new Date().toISOString()
    }];
  };
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '100000', locked: '0' }
  ];

  assert.equal(await trader.syncWithExchange(), true);
  assert.deepEqual(queriedStates, ['wait', 'watch']);
  assert.equal(trader._livePendingOrderMarkets.has('KRW-BTC'), true);
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
});

test('exchange-held target coins are restored even for universes over twenty markets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-large-universe-sync-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const targetCoins = Array.from({ length: 21 }, (_, index) => `KRW-TEST${index}`);
  targetCoins[0] = 'KRW-BTC';
  const trader = new MultiCoinTrader({
    accessKey: '',
    secretKey: '',
    strategyMode: 'oversold_reaction_scalping',
    targetCoins,
    dryRun: false,
    initialSeedMoney: 100_000,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    paperValidationFile: path.join(root, 'paper_validation.json'),
    positionRiskCheckIntervalMs: 10_000,
    maxRiskDataGapSeconds: 5
  });
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '0.02', locked: '0', avg_buy_price: '1000000' }
  ];
  trader.upbit.getOrders = async () => [];

  assert.equal(trader.strategies.size, 0);
  assert.equal(await trader.syncWithExchange(), true);
  assert.equal(trader.getStrategy('KRW-BTC').currentPosition?.amount, 0.02);
  assert.equal(trader.getCurrentPositionCount(), 1);
});

test('malformed exchange account balances keep sync unknown and preserve the last known position', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-malformed-account-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader.getStrategy('KRW-BTC').openPosition(100, 2, 'BUY');
  trader._liveAccountStateKnown = true;
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000', locked: '0' },
    { currency: 'BTC', balance: 'not-a-number', locked: '0', avg_buy_price: '100' }
  ];
  trader.upbit.getOrders = async () => [];

  assert.equal(await trader.syncWithExchange(), false);
  assert.equal(trader._liveExchangeStateKnown, false);
  assert.equal(trader._liveAccountStateKnown, false);
  assert.equal(trader.getCurrentPositionCount(), 1);
  assert.equal(trader.getStrategy('KRW-BTC').currentPosition.amount, 2);
});

test('markets with prior engine orders remain in the managed universe after target candidates change', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-managed-market-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const trader = makeLiveTrader(root);
  trader._liveEngineOrderIds.add('prior-old-market-order');
  trader._liveEngineOrderMarkets.set('prior-old-market-order', 'KRW-OLD');
  trader._liveRecoveredManagedMarkets.add('KRW-OLD');
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'OLD', balance: '10', locked: '0', avg_buy_price: '100' }
  ];
  const orderMarkets = [];
  trader.upbit.getOrders = async market => {
    orderMarkets.push(market);
    return [];
  };

  assert.deepEqual(trader.targetCoins, ['KRW-BTC']);
  assert.equal(await trader.syncWithExchange(), true);
  assert.equal(trader.getStrategy('KRW-OLD').currentPosition?.amount, 10);
  assert.equal(orderMarkets.includes('KRW-OLD'), true);
});

test('exchange recovery restores the original hold-time clock from execution evidence', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-entry-time-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const openedAt = new Date(Date.now() - 31 * 60_000).toISOString();
  fs.writeFileSync(evidenceFile, `${JSON.stringify({
    schema: 'coinpilot.live-execution-evidence.v1',
    eventType: 'FILL_OBSERVED',
    recordedAt: openedAt,
    orderId: 'engine-buy',
    market: 'KRW-BTC',
    side: 'bid',
    orderType: 'market',
    fill: {
      status: 'filled',
      executedVolume: 0.02,
      remainingVolume: 0,
      averagePrice: 1_000_000,
      paidFee: 10,
      exchangeState: 'done'
    }
  })}\n`, 'utf8');
  const trader = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  trader.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '1000000', locked: '0' },
    { currency: 'BTC', balance: '0.02', locked: '0', avg_buy_price: '1000000' }
  ];
  trader.upbit.getOrders = async () => [];

  assert.equal(await trader.syncWithExchange(), true);
  const strategy = trader.getStrategy('KRW-BTC');
  assert.equal(strategy.currentPosition.entryTime, openedAt);
  assert.equal(strategy.checkPosition(1_000_000).type, 'MAX_HOLD_TIME');
});

test('durable intent is fsynced before POST and UUID-less timeout blocks only its market across target changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-intent-timeout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const trader = makeLiveTrader(root, {
    targetCoins: ['KRW-BTC', 'KRW-ETH'],
    liveExecutionEvidenceFile: evidenceFile
  });
  markLiveTraderExchangeReady(trader);
  let intentWasDurableBeforePost = false;
  let evidenceFsyncCalls = 0;
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = descriptor => {
    evidenceFsyncCalls += 1;
    return originalFsync(descriptor);
  };
  trader.upbit.order = async (...args) => {
    const eventsAtDispatch = fs.readFileSync(evidenceFile, 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    intentWasDurableBeforePost = eventsAtDispatch.length === 1 &&
      eventsAtDispatch[0].eventType === 'ORDER_INTENT' &&
      typeof eventsAtDispatch[0].clientIntentId === 'string' &&
      evidenceFsyncCalls === 1 &&
      args[5] === eventsAtDispatch[0].identifier;
    throw new Error('response timeout after POST dispatch');
  };

  try {
    await assert.rejects(trader.submitLiveOrder('KRW-BTC', 'bid', 100_000, null, 'price'), /response timeout/);
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(intentWasDurableBeforePost, true);
  const events = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.eventType), ['ORDER_INTENT', 'ORDER_POST_AMBIGUOUS']);
  assert.match(events[0].clientIntentId, /^[0-9a-f-]{36}$/i);
  assert.equal(events[0].market, 'KRW-BTC');
  assert.equal(events[0].side, 'bid');
  assert.deepEqual(events[0].request, { amount: 100_000, volume: null, price: null });
  assert.equal(events[0].clientIntentId, events[1].clientIntentId);
  assert.equal(trader.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
  assert.equal(trader.canExecuteLiveOrder('KRW-ETH', { action: 'BUY' }), true);

  const restarted = makeLiveTrader(root, {
    targetCoins: ['KRW-ETH'],
    liveExecutionEvidenceFile: evidenceFile
  });
  const orderMarkets = [];
  let getOrderCalls = 0;
  restarted.upbit.getOrders = async market => { orderMarkets.push(market); return []; };
  let identifierLookup = false;
  restarted.upbit.getOrder = async (_identifier, options) => {
    getOrderCalls += 1;
    identifierLookup = options?.identifier === true;
    const error = new Error('order identifier not found');
    error.response = { status: 404 };
    throw error;
  };
  restarted.upbit.getAccounts = async () => [];
  assert.equal(await restarted.syncWithExchange(), true);
  assert.equal(getOrderCalls, 1);
  assert.equal(identifierLookup, true);
  assert.deepEqual(orderMarkets.sort(), ['KRW-BTC', 'KRW-ETH']);
  assert.equal(restarted.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
  assert.equal(restarted.canExecuteLiveOrder('KRW-ETH', { action: 'BUY' }), true);
  assert.equal(restarted.liveExecutionEvidenceDataError, null);

  orderMarkets.length = 0;
  restarted._lastSyncTime = Date.now();
  restarted.upbit.getOrder = async clientIntentId => ({
    uuid: 'late-order-response', identifier: clientIntentId, market: 'KRW-BTC', side: 'bid',
    ord_type: 'price', state: 'done', executed_volume: '0.001', remaining_volume: '0',
    avg_price: '100000', paid_fee: '0'
  });
  restarted.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '500000', locked: '0' },
    { currency: 'BTC', balance: '0.001', locked: '0', avg_buy_price: '100000' }
  ];
  assert.equal(await restarted.syncWithExchange(), true);
  assert.deepEqual(orderMarkets, ['KRW-BTC']);
  assert.equal(restarted.liveExecutionEvidenceStartup.reconciliation.unresolvedOrderIntentCount, 0);
  assert.equal(restarted._liveEvidenceBlockedMarkets.has('KRW-BTC'), false);
  const resolvedEvents = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(resolvedEvents.some(event => event.eventType === 'ORDER_SUBMITTED' && event.orderId === 'late-order-response'));
  assert.ok(resolvedEvents.some(event => event.eventType === 'FILL_OBSERVED' && event.orderId === 'late-order-response'));
});

test('pre-dispatch queue rejection resolves the durable intent without making the market ambiguous', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-pre-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const trader = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  markLiveTraderExchangeReady(trader);
  let orderClientCalls = 0;
  trader.upbit.order = async () => {
    orderClientCalls += 1;
    return {
      success: false,
      error: {
        code: 'upbit_request_not_dispatched',
        message: 'queue full before network dispatch',
        dispatched: false,
        schedulerCode: 'UPBIT_QUEUE_FULL'
      }
    };
  };

  const result = await trader.submitLiveOrder('KRW-BTC', 'bid', 100_000, null, 'price');

  assert.equal(orderClientCalls, 1);
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'upbit_request_not_dispatched');
  assert.equal(trader._liveOrderStateUnknownMarkets.has('KRW-BTC'), false);
  assert.equal(trader._livePendingOrderMarkets.has('KRW-BTC'), false);
  assert.equal(trader._liveUnresolvedOrderIntents.size, 0);
  const events = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.eventType), ['ORDER_INTENT', 'ORDER_REJECTED']);
  assert.equal(events[1].errorCode, 'upbit_request_not_dispatched');
  assert.equal(inspectLiveExecutionEvidenceFile(evidenceFile)
    .reconciliation.unresolvedOrderIntentCount, 0);
});

test('UI LIVE pre-dispatch rejection is a completed result and does not leave an idempotency lock', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-ui-live-pre-dispatch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const trader = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  markLiveTraderExchangeReady(trader);
  trader.upbit.order = async () => ({
    success: false,
    error: {
      code: 'upbit_request_not_dispatched',
      message: 'queue full before network dispatch',
      dispatched: false,
      schedulerCode: 'UPBIT_QUEUE_FULL'
    }
  });

  const result = await executeLiveOrderWithEvidence(trader, {
    market: 'KRW-BTC',
    side: 'bid',
    volume: 100_000,
    orderType: 'price',
    requested: { amount: 100_000 }
  });

  assert.equal(result.blocked, false);
  assert.equal(result.evidenceRecorded, true);
  assert.equal(result.orderResult.error.code, 'upbit_request_not_dispatched');
  assert.equal(trader._liveUnresolvedOrderIntents.size, 0);
  assert.equal(trader._liveEvidenceBlockedMarkets.has('KRW-BTC'), false);
  const events = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.eventType), ['ORDER_INTENT', 'ORDER_REJECTED']);
});

test('DRY_RUN refuses the LIVE submit method without writing evidence or calling the order client', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-dry-run-submit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const trader = makeLiveTrader(root, { dryRun: true, liveExecutionEvidenceFile: evidenceFile });
  let orderCalls = 0;
  trader.upbit.order = async () => { orderCalls += 1; return { success: true, data: { uuid: 'must-not-run' } }; };

  await assert.rejects(trader.submitLiveOrder('KRW-BTC', 'bid', 100_000, null, 'price'), /LIVE mode/);
  assert.equal(orderCalls, 0);
  assert.equal(fs.existsSync(evidenceFile), false);
});

test('Upbit order sends the pre-recorded identifier and never retries ambiguous POST failures', async () => {
  for (const failure of [
    Object.assign(new Error('socket timed out after dispatch'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('server failed after dispatch'), { response: { status: 503, data: { error: { name: 'server_error' } } } })
  ]) {
    const api = new UpbitAPI('mock-access', 'mock-secret');
    let attempts = 0;
    let sentBody;
    let tokenQuery;
    const originalPost = axios.post;
    axios.post = async (_url, body) => {
      attempts += 1;
      sentBody = body;
      throw failure;
    };
    api.waitForRateLimit = async () => {};
    api.generateToken = query => { tokenQuery = query; return 'mock-token'; };
    try {
      await assert.rejects(api.order('KRW-BTC', 'bid', 100_000, null, 'price', 'coinpilot-intent-1'));
    } finally {
      axios.post = originalPost;
    }
    assert.equal(attempts, 1);
    assert.equal(sentBody.identifier, 'coinpilot-intent-1');
    assert.equal(sentBody.market, 'KRW-BTC');
    assert.equal(sentBody.side, 'bid');
    assert.equal(sentBody.price, '100000');
    assert.equal(tokenQuery.identifier, 'coinpilot-intent-1');
  }
});

test('Upbit getOrder signs and queries an identifier lookup', async () => {
  const api = new UpbitAPI('mock-access', 'mock-secret');
  let queriedParams;
  let tokenQuery;
  const originalGet = axios.get;
  axios.get = async (_url, config) => {
    queriedParams = config.params;
    return { data: { uuid: 'order-from-identifier', identifier: config.params.identifier } };
  };
  api.requestWithRetry = async request => request();
  api.generateToken = query => { tokenQuery = query; return 'mock-token'; };
  try {
    const order = await api.getOrder('coinpilot-intent-2', { identifier: true });
    assert.equal(order.uuid, 'order-from-identifier');
  } finally {
    axios.get = originalGet;
  }
  assert.deepEqual(queriedParams, { identifier: 'coinpilot-intent-2' });
  assert.deepEqual(tokenQuery, { identifier: 'coinpilot-intent-2' });
});

test('startup getOrder wait and partial fill stay ambiguous until terminal cancel is observed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-order-partial-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const origin = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  await submitDurableMockOrder(origin, 'partial-recovery-order');

  let exchangeOrder = {
    uuid: 'partial-recovery-order', market: 'KRW-BTC', side: 'bid', ord_type: 'price',
    state: 'wait', executed_volume: '0.25', remaining_volume: '0.75',
    avg_price: '100000', paid_fee: '10'
  };
  let openOrderList = [{ uuid: 'partial-recovery-order', created_at: new Date().toISOString() }];
  const restarted = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  restarted.upbit.getOrder = async orderId => orderId === exchangeOrder.uuid ? { ...exchangeOrder } : null;
  restarted.upbit.getOrders = async () => [...openOrderList];
  restarted.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '500000', locked: '0' },
    { currency: 'BTC', balance: '0.25', locked: '0', avg_buy_price: '100000' }
  ];

  assert.equal(await restarted.syncWithExchange(), true);
  let inspection = JSON.parse(fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').at(-1));
  assert.equal(inspection.eventType, 'FILL_PARTIAL');
  assert.equal(inspection.order.state, 'wait');
  assert.deepEqual(restarted.liveExecutionEvidenceStartup.reconciliation.unresolvedSubmittedOrderIds,
    ['partial-recovery-order']);
  assert.equal(restarted.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
  assert.equal(restarted.canExecuteLiveOrder('KRW-ETH', { action: 'BUY' }), false);

  exchangeOrder = { ...exchangeOrder, state: 'cancel' };
  openOrderList = [];
  assert.equal(await restarted.syncWithExchange(), true);
  const events = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.at(-1).eventType, 'FILL_PARTIAL');
  assert.equal(events.at(-1).order.state, 'cancel');
  assert.deepEqual(restarted.liveExecutionEvidenceStartup.reconciliation.unresolvedSubmittedOrderIds, []);
  assert.equal(restarted._liveEvidenceBlockedMarkets.has('KRW-BTC'), false);
  assert.equal(restarted.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), true);
});

test('terminal zero-fill cancel and complete done readbacks resolve durable UUIDs on restart', async t => {
  for (const { name, order, expectedEvent, accounts } of [
    {
      name: 'cancel',
      order: { state: 'cancel', executed_volume: '0', remaining_volume: '0.001', avg_price: '0', paid_fee: '0' },
      expectedEvent: 'FILL_NOT_OBSERVED',
      accounts: [{ currency: 'KRW', balance: '100000', locked: '0' }]
    },
    {
      name: 'done',
      order: { state: 'done', executed_volume: '0.001', remaining_volume: '0', avg_price: '100000', paid_fee: '10' },
      expectedEvent: 'FILL_OBSERVED',
      accounts: [
        { currency: 'KRW', balance: '0', locked: '0' },
        { currency: 'BTC', balance: '0.001', locked: '0', avg_buy_price: '100000' }
      ]
    }
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `coinpilot-live-terminal-${name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const evidenceFile = path.join(root, 'live-execution.jsonl');
    const origin = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
    await submitDurableMockOrder(origin, `${name}-recovered-order`);
    const restarted = makeLiveTrader(root, { targetCoins: ['KRW-ETH'], liveExecutionEvidenceFile: evidenceFile });
    restarted.upbit.getOrder = async () => ({
      uuid: `${name}-recovered-order`, market: 'KRW-BTC', side: 'bid', ord_type: 'price', ...order
    });
    restarted.upbit.getOrders = async () => [];
    restarted.upbit.getAccounts = async () => accounts;

    assert.equal(await restarted.syncWithExchange(), true, name);
    assert.equal(restarted.liveExecutionEvidenceStartup.reconciliation.unresolvedSubmittedOrderCount, 0, name);
    assert.equal(restarted._liveEvidenceBlockedMarkets.has('KRW-BTC'), false, name);
    const events = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(events.at(-1).eventType, expectedEvent, name);
    assert.equal(restarted._liveOrderStateUnknownMarkets.has('KRW-BTC'), false, name);
  }
});

test('getOrder failure preserves only the unresolved market lock and allows verified markets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-order-readback-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const origin = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  await submitDurableMockOrder(origin, 'readback-failure-order');

  const restarted = makeLiveTrader(root, { targetCoins: ['KRW-ETH'], liveExecutionEvidenceFile: evidenceFile });
  let getOrderCalls = 0;
  restarted.upbit.getOrder = async () => { getOrderCalls += 1; throw new Error('temporary getOrder outage'); };
  restarted.upbit.getOrders = async () => [];
  restarted.upbit.getAccounts = async () => [];

  assert.equal(await restarted.syncWithExchange(), true);
  assert.equal(getOrderCalls, 1);
  assert.equal(restarted._liveEvidenceBlockedMarkets.has('KRW-BTC'), true);
  assert.equal(restarted.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
  assert.equal(restarted.canExecuteLiveOrder('KRW-ETH', { action: 'BUY' }), true);
  assert.equal(restarted.liveExecutionEvidenceStartup.reconciliation.unresolvedSubmittedOrderCount, 1);
});

test('an unresolved UUID without a market keeps all LIVE markets globally unverified', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-unscoped-order-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const origin = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  const legacySubmission = origin.createLiveExecutionEvidence({
    eventType: 'ORDER_SUBMITTED',
    orderId: 'legacy-unscoped-order',
    side: 'bid',
    requested: { amount: 100_000 }
  });
  assert.equal(origin.recordLiveExecutionEvidence(legacySubmission), true);

  const restarted = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  let getOrderCalls = 0;
  restarted.upbit.getOrder = async () => {
    getOrderCalls += 1;
    const error = new Error('order not found');
    error.response = { status: 404 };
    throw error;
  };
  restarted.upbit.getOrders = async () => [];
  restarted.upbit.getAccounts = async () => [
    { currency: 'KRW', balance: '100000', locked: '0' }
  ];

  assert.equal(await restarted.syncWithExchange(), false);
  assert.equal(getOrderCalls, 1);
  assert.equal(restarted._liveExchangeStateKnown, false);
  assert.equal(restarted.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), false);
});

test('manual LIVE orders reconcile out-of-target markets and reject unknown or pending order state', async t => {
  for (const mode of ['clear', 'pending', 'unavailable']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `coinpilot-manual-market-${mode}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const trader = makeLiveTrader(root, { targetCoins: ['KRW-BTC'] });
    const orderReads = [];
    let orderPosts = 0;
    trader.upbit.getAccounts = async () => [
      { currency: 'KRW', balance: '100000', locked: '0' }
    ];
    trader.upbit.getOrders = async market => {
      orderReads.push(market);
      if (mode === 'unavailable' && market === 'KRW-XRP') {
        throw new Error('market order read unavailable');
      }
      if (mode === 'pending' && market === 'KRW-XRP') {
        return [{
          uuid: 'unmanaged-open-order',
          market,
          state: 'watch',
          created_at: new Date().toISOString()
        }];
      }
      return [];
    };
    trader.upbit.order = async () => {
      orderPosts += 1;
      return { success: true, data: { uuid: 'manual-market-order' } };
    };
    trader.upbit.waitForOrderFill = async () => ({
      filled: false,
      order: {
        uuid: 'manual-market-order',
        state: 'cancel',
        executed_volume: '0',
        remaining_volume: '0'
      }
    });

    const result = await executeLiveOrderWithEvidence(trader, {
      market: 'KRW-XRP',
      side: 'bid',
      volume: 50_000,
      orderType: 'price'
    });

    assert.ok(orderReads.includes('KRW-XRP'), mode);
    assert.equal(orderPosts, mode === 'clear' ? 1 : 0, mode);
    if (mode === 'clear') {
      assert.equal(result.orderResult.success, true);
      assert.equal(result.blocked, false);
    } else {
      assert.equal(result.blocked, true, mode);
      assert.equal(result.reason, 'exchange_state_unverified', mode);
      assert.equal(trader.canExecuteLiveOrder('KRW-XRP', { action: 'BUY' }), false, mode);
    }
    trader.stop();
  }
});

test('known UUID recovery remains in managed universe after configured targets change', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-order-target-change-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const evidenceFile = path.join(root, 'live-execution.jsonl');
  const origin = makeLiveTrader(root, { liveExecutionEvidenceFile: evidenceFile });
  await submitDurableMockOrder(origin, 'old-target-order');

  const restarted = makeLiveTrader(root, {
    targetCoins: ['KRW-ETH'],
    liveExecutionEvidenceFile: evidenceFile
  });
  const readMarkets = [];
  let getOrderCalls = 0;
  restarted.upbit.getOrder = async orderId => {
    getOrderCalls += 1;
    return {
      uuid: orderId, market: 'KRW-BTC', side: 'bid', ord_type: 'price',
      state: 'cancel', executed_volume: '0', remaining_volume: '0.001', avg_price: '0', paid_fee: '0'
    };
  };
  restarted.upbit.getOrders = async market => { readMarkets.push(market); return []; };
  restarted.upbit.getAccounts = async () => [];

  assert.equal(await restarted.syncWithExchange(), true);
  assert.equal(getOrderCalls, 1);
  assert.deepEqual(readMarkets.sort(), ['KRW-BTC', 'KRW-ETH']);
  assert.deepEqual(restarted.liveExecutionEvidenceStartup.reconciliation.unresolvedSubmittedOrderIds, []);
  assert.equal(restarted.canExecuteLiveOrder('KRW-BTC', { action: 'BUY' }), true);
  assert.equal(restarted.canExecuteLiveOrder('KRW-ETH', { action: 'BUY' }), true);
});
