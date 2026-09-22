import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import AutoTrader from '../src/trader/autoTrader.js';
import {
  executeLiveOrderWithEvidence,
  hasCompleteObservedLiveFill
} from '../src/api/routes/trading.js';
import {
  LIVE_EXECUTION_EVIDENCE_SCHEMA,
  compactLiveOrder,
  createLiveExecutionEvidenceEvent,
  inspectLiveExecutionEvidenceFile,
  reconcileLiveExecutionEvidence,
  projectLiveAccountReadback
} from '../src/research/liveExecutionEvidence.js';

test('live execution evidence keeps fill fields bounded and settlement explicit', () => {
  const event = createLiveExecutionEvidenceEvent({
    eventType: 'FILL_OBSERVED',
    orderId: 'order-1',
    market: 'KRW-BTC',
    side: 'bid',
    orderType: 'price',
    requested: { amount: 200_000 },
    referencePrice: 100_000_000,
    signal: { signalKey: 'signal-1', signalTime: '2026-09-18T00:00:00Z', entryDelayMs: 1500 },
    order: {
      uuid: 'order-1',
      market: 'KRW-BTC',
      side: 'bid',
      ord_type: 'price',
      state: 'done',
      executed_volume: '0.0019',
      remaining_volume: '0',
      avg_price: '100100000',
      paid_fee: '100.1',
      created_at: '2026-09-18T00:00:01Z',
      done_at: '2026-09-18T00:00:02Z',
      trades_count: 2,
      secret: 'must-not-be-copied'
    },
    fillResult: { filled: true, partial: false },
    recordedAt: '2026-09-18T00:00:03Z'
  });

  assert.equal(event.schema, LIVE_EXECUTION_EVIDENCE_SCHEMA);
  assert.equal(event.eventType, 'FILL_OBSERVED');
  assert.equal(event.orderId, 'order-1');
  assert.equal(event.fill.status, 'filled');
  assert.equal(event.fill.executedVolume, 0.0019);
  assert.equal(event.fill.averagePrice, 100100000);
  assert.equal(event.fill.paidFee, 100.1);
  assert.equal(event.settlement.status, 'not_observed');
  assert.equal(event.order.secret, undefined);
  assert.match(event.note, /wallet settlement/);
});

test('partial and not-filled events preserve remaining volume and error state', () => {
  const partialOrder = compactLiveOrder({
    uuid: 'order-2',
    state: 'wait',
    executed_volume: '1.5',
    remaining_volume: '0.5',
    avg_price: '100',
    paid_fee: '0.1'
  });
  assert.equal(partialOrder.executedVolume, 1.5);
  assert.equal(partialOrder.remainingVolume, 0.5);

  const event = createLiveExecutionEvidenceEvent({
    eventType: 'FILL_NOT_OBSERVED',
    orderId: 'order-3',
    market: 'KRW-ETH',
    side: 'ask',
    fillResult: { filled: false, error: '주문이 취소됨' },
    order: { uuid: 'order-3', state: 'cancel', executed_volume: '0', remaining_volume: '0' }
  });
  assert.equal(event.fill.status, 'not_observed');
  assert.equal(event.fill.error, '주문이 취소됨');
  assert.equal(event.settlement.status, 'not_observed');
});

test('reconciliation does not infer settlement from submission or fill alone', () => {
  const submitted = createLiveExecutionEvidenceEvent({
    eventType: 'ORDER_SUBMITTED',
    orderId: 'order-4',
    market: 'KRW-BTC',
    side: 'bid'
  });
  const filled = createLiveExecutionEvidenceEvent({
    eventType: 'FILL_OBSERVED',
    orderId: 'order-4',
    market: 'KRW-BTC',
    side: 'bid',
    order: {
      uuid: 'order-4',
      state: 'done',
      executed_volume: '1',
      remaining_volume: '0',
      avg_price: '100',
      paid_fee: '0'
    },
    fillResult: { filled: true }
  });
  const notFilled = createLiveExecutionEvidenceEvent({
    eventType: 'FILL_NOT_OBSERVED',
    orderId: 'order-5',
    market: 'KRW-XRP',
    side: 'ask',
    fillResult: { filled: false, error: 'timeout' }
  });
  const result = reconcileLiveExecutionEvidence([submitted, filled, notFilled, { malformed: true }]);

  assert.equal(result.eventCount, 4);
  assert.equal(result.validEventCount, 3);
  assert.equal(result.invalidEventCount, 1);
  assert.equal(result.submittedOrderCount, 1);
  assert.equal(result.fillObservedCount, 1);
  assert.equal(result.completeFillObservedCount, 1);
  assert.equal(result.incompleteFillObservedCount, 0);
  assert.equal(result.notFilledCount, 1);
  assert.equal(result.settlementObservedCount, 0);
  assert.equal(result.readyForSettlementComparison, false);
  assert.deepEqual(result.unresolvedSubmittedOrderIds, []);
  assert.equal(result.promoted, false);
});

test('reconciliation does not treat an incomplete fill as settlement-ready evidence', () => {
  const incomplete = createLiveExecutionEvidenceEvent({
    eventType: 'FILL_OBSERVED',
    orderId: 'order-incomplete',
    market: 'KRW-BTC',
    side: 'bid',
    fillResult: { filled: true },
    order: {
      uuid: 'order-incomplete',
      state: 'done',
      executed_volume: '1',
      remaining_volume: '0'
    }
  });
  const result = reconcileLiveExecutionEvidence([incomplete]);
  assert.equal(result.fillObservedCount, 1);
  assert.equal(result.completeFillObservedCount, 0);
  assert.equal(result.incompleteFillObservedCount, 1);
  assert.equal(result.readyForSettlementComparison, false);
});

test('account readback projection identifies the relevant post-fill account without claiming causality', () => {
  const bid = projectLiveAccountReadback([
    { currency: 'KRW', balance: '800000', locked: '0' },
    { currency: 'BTC', balance: '0.002', locked: '0.001' }
  ], 'KRW-BTC', 'bid', '2026-09-18T00:00:00Z');
  assert.equal(bid.status, 'observed');
  assert.equal(bid.krwBalance, 800000);
  assert.equal(bid.assetBalance, 0.002);
  assert.equal(bid.lockedBalance, 0.001);
  assert.equal(bid.reason, 'account_readback_after_fill');

  const ask = projectLiveAccountReadback([{ currency: 'KRW', balance: '900000', locked: '0' }], 'KRW-BTC', 'ask');
  assert.equal(ask.status, 'observed');
  assert.equal(ask.assetBalance, null);
});

test('settlement readback does not double-count the fill event', () => {
  const fill = createLiveExecutionEvidenceEvent({
    eventType: 'FILL_OBSERVED',
    orderId: 'order-settled',
    market: 'KRW-BTC',
    side: 'bid',
    fillResult: { filled: true },
    order: {
      uuid: 'order-settled',
      state: 'done',
      executed_volume: '1',
      remaining_volume: '0',
      avg_price: '100',
      paid_fee: '0'
    }
  });
  const settlement = createLiveExecutionEvidenceEvent({
    eventType: 'SETTLEMENT_READBACK',
    orderId: 'order-settled',
    market: 'KRW-BTC',
    side: 'bid',
    fillResult: { filled: true },
    order: fill.order,
    settlementReadback: {
      status: 'observed',
      observedAt: '2026-09-18T00:00:01Z',
      krwBalance: 999900,
      assetBalance: 1,
      lockedBalance: 0
    }
  });
  const result = reconcileLiveExecutionEvidence([fill, settlement]);
  assert.equal(result.fillObservedCount, 1);
  assert.equal(result.completeFillObservedCount, 1);
  assert.equal(result.settlementObservedCount, 1);
  assert.equal(result.readyForSettlementComparison, true);
});

test('live recorder appends only in live mode and blocks after an evidence write failure', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-evidence-'));
  const evidenceFile = path.join(tempDir, 'evidence.jsonl');
  const liveTrader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: [],
    dryRun: false,
    useNews: false,
    liveExecutionEvidenceFile: evidenceFile
  });
  const dryEvidenceFile = path.join(tempDir, 'dry-evidence.jsonl');
  const dryTrader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: [],
    dryRun: true,
    useNews: false,
    liveExecutionEvidenceFile: dryEvidenceFile
  });

  try {
    const event = liveTrader.createLiveExecutionEvidence({
      eventType: 'ORDER_SUBMITTED',
      orderId: 'live-order-1',
      market: 'KRW-BTC',
      side: 'bid',
      orderType: 'price',
      requested: { amount: 200_000 }
    });
    assert.equal(liveTrader.recordLiveExecutionEvidence(event), true);
    assert.equal(liveTrader.recordLiveExecutionEvidence({
      ...event,
      eventType: 'FILL_NOT_OBSERVED',
      fill: { ...event.fill, status: 'not_observed', error: 'timeout' }
    }), true);
    const lines = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).orderId, 'live-order-1');
    assert.equal(dryTrader.recordLiveExecutionEvidence(event), true);
    assert.equal(fs.existsSync(dryEvidenceFile), false);

    const failingTrader = new MultiCoinTrader({
      strategyMode: 'oversold_reaction_scalping',
      targetCoins: [],
      dryRun: false,
      useNews: false,
      liveExecutionEvidenceFile: tempDir
    });
    try {
      assert.equal(failingTrader.recordLiveExecutionEvidence(event), false);
      assert.match(failingTrader.liveExecutionEvidenceDataError, /startup safety block|read failed|directory|EISDIR/i);
      assert.equal(failingTrader.recordLiveExecutionEvidence(event), false);
    } finally {
      failingTrader.stop();
    }
  } finally {
    liveTrader.stop();
    dryTrader.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('UI live-order helper waits for the exchange fill before reporting success', async () => {
  const events = [];
  const orders = [];
  const cancellations = [];
  const tradingSystem = {
    dryRun: false,
    upbit: {
      async order(...args) {
        orders.push(args);
        return { success: true, data: { uuid: 'ui-order-1' } };
      },
      async waitForOrderFill() {
        return {
          filled: false,
          error: '체결 대기 시간 초과',
          order: {
            uuid: 'ui-order-1',
            state: 'wait',
            executed_volume: '0',
            remaining_volume: '0'
          }
        };
      },
      async cancelOrder(orderId) {
        cancellations.push(orderId);
        return { uuid: orderId, state: 'cancel' };
      }
    },
    createLiveExecutionEvidence(options) {
      return createLiveExecutionEvidenceEvent(options);
    },
    recordLiveExecutionEvidence(event) {
      events.push(event);
      return true;
    }
  };

  const result = await executeLiveOrderWithEvidence(tradingSystem, {
    market: 'KRW-BTC',
    side: 'bid',
    volume: 200_000,
    orderType: 'price',
    requested: { amount: 200_000 },
    referencePrice: 100_000_000
  });

  assert.equal(orders.length, 1);
  assert.deepEqual(orders[0], ['KRW-BTC', 'bid', 200_000, null, 'price']);
  assert.equal(result.orderResult.success, true);
  assert.equal(result.fillResult.filled, false);
  assert.equal(result.fill.status, 'not_observed');
  assert.equal(result.fill.error, '체결 대기 시간 초과');
  assert.deepEqual(events.map(event => event.eventType), ['ORDER_SUBMITTED', 'FILL_NOT_OBSERVED']);
  assert.deepEqual(cancellations, ['ui-order-1']);
});

test('UI live-order helper records a post-fill account readback when available', async () => {
  const events = [];
  const tradingSystem = {
    dryRun: false,
    upbit: {
      async order() {
        return { success: true, data: { uuid: 'ui-filled-order-1' } };
      },
      async waitForOrderFill() {
        return {
          filled: true,
          partial: false,
          order: {
            uuid: 'ui-filled-order-1',
            market: 'KRW-BTC',
            side: 'bid',
            ord_type: 'price',
            state: 'done',
            executed_volume: '0.001',
            remaining_volume: '0',
            avg_price: '100000000',
            paid_fee: '50'
          }
        };
      }
    },
    async getAccountInfo() {
      return [
        { currency: 'KRW', balance: '899950', locked: '0' },
        { currency: 'BTC', balance: '0.001', locked: '0' }
      ];
    },
    createLiveExecutionEvidence(options) {
      return createLiveExecutionEvidenceEvent(options);
    },
    recordLiveExecutionEvidence(event) {
      events.push(event);
      return true;
    }
  };

  const result = await executeLiveOrderWithEvidence(tradingSystem, {
    market: 'KRW-BTC',
    side: 'bid',
    volume: 100_000,
    orderType: 'price',
    requested: { amount: 100_000 },
    referencePrice: 100_000_000
  });
  assert.equal(result.evidenceRecorded, true);
  assert.equal(result.fill.status, 'filled');
  assert.equal(result.settlement.status, 'observed');
  assert.equal(result.settlement.assetBalance, 0.001);
  assert.deepEqual(events.map(event => event.eventType), [
    'ORDER_SUBMITTED',
    'FILL_OBSERVED',
    'SETTLEMENT_READBACK'
  ]);
});

test('UI live routes require every observed fill accounting field', () => {
  const base = {
    evidenceRecorded: true,
    fillResult: { filled: true },
    fill: {
      executedVolume: 1,
      averagePrice: 100,
      paidFee: 0,
      remainingVolume: 0
    }
  };
  assert.equal(hasCompleteObservedLiveFill(base), true);
  for (const field of ['executedVolume', 'averagePrice', 'paidFee', 'remainingVolume']) {
    const incomplete = {
      ...base,
      fill: { ...base.fill, [field]: null }
    };
    assert.equal(hasCompleteObservedLiveFill(incomplete), false, `${field} must be observed`);
  }
});

test('live rebalancing records partial fill, cancels the remainder, and reads settlement', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-rebalance-'));
  const evidenceFile = path.join(tempDir, 'evidence.jsonl');
  const cancellations = [];
  const trader = new MultiCoinTrader({
    strategyMode: 'portfolio',
    targetCoins: ['KRW-BTC'],
    dryRun: false,
    useNews: false,
    liveExecutionEvidenceFile: evidenceFile
  });
  const strategy = trader.getStrategy('KRW-BTC');
  strategy.openPosition(100, 10, 'BUY');
  trader.upbit = {
    async order() {
      return { success: true, data: { uuid: 'rebalance-order-1' } };
    },
    async waitForOrderFill() {
      return {
        filled: true,
        partial: true,
        order: {
          uuid: 'rebalance-order-1',
          market: 'KRW-BTC',
          side: 'ask',
          ord_type: 'market',
          state: 'wait',
          executed_volume: '4',
          remaining_volume: '6',
          avg_price: '90',
          paid_fee: '0.18'
        }
      };
    },
    async cancelOrder(orderId) {
      cancellations.push(orderId);
      return { uuid: orderId, state: 'cancel' };
    },
    async getAccounts() {
      return [
        { currency: 'KRW', balance: '360', locked: '0' },
        { currency: 'BTC', balance: '6', locked: '0' }
      ];
    }
  };

  try {
    const received = await trader.sellForRebalancing({
      coin: 'KRW-BTC',
      strategy,
      currentPrice: 90,
      profitPercent: -1
    }, 'KRW-ETH');
    assert.equal(received, 360);
    assert.equal(strategy.currentPosition.amount, 6);
    assert.equal(strategy.tradeHistory.at(-1).action, 'PARTIAL_CLOSE');
    assert.deepEqual(cancellations, ['rebalance-order-1']);
    assert.equal(trader.liveExecutionEvidenceDataError, null);
    const events = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.eventType), [
      'ORDER_SUBMITTED',
      'FILL_PARTIAL',
      'SETTLEMENT_READBACK'
    ]);
    assert.equal(events.at(-1).settlement.status, 'observed');
    assert.equal(events.at(-1).settlement.krwBalance, 360);
    assert.equal(events.at(-1).settlement.assetBalance, 6);
  } finally {
    trader.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('legacy AutoTrader does not open a live position from submission alone', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-auto-live-'));
  const evidenceFile = path.join(tempDir, 'evidence.jsonl');
  const trader = new AutoTrader({
    targetCoin: 'KRW-BTC',
    dryRun: false,
    liveExecutionEvidenceFile: evidenceFile
  });
  const cancellations = [];
  trader.upbit = {
    async order() {
      return { success: true, data: { uuid: 'auto-live-order-1' } };
    },
    async waitForOrderFill() {
      return {
        filled: false,
        error: '체결 대기 시간 초과',
        order: {
          uuid: 'auto-live-order-1',
          market: 'KRW-BTC',
          side: 'bid',
          ord_type: 'price',
          state: 'wait',
          executed_volume: '0',
          remaining_volume: '0'
        }
      };
    },
    async cancelOrder(orderId) {
      cancellations.push(orderId);
      return { uuid: orderId, state: 'cancel' };
    }
  };

  try {
    await trader.executeOrder({ action: 'BUY' }, 100_000_000, 100_000, 0);
    assert.equal(trader.strategy.currentPosition, null);
    assert.deepEqual(cancellations, ['auto-live-order-1']);
    const events = fs.readFileSync(evidenceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.eventType), ['ORDER_SUBMITTED', 'FILL_NOT_OBSERVED']);
  } finally {
    trader.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('live evidence startup inspection blocks unresolved or malformed history', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-inspect-'));
  const evidenceFile = path.join(tempDir, 'evidence.jsonl');
  const submitted = createLiveExecutionEvidenceEvent({
    eventType: 'ORDER_SUBMITTED',
    orderId: 'unresolved-order-1',
    market: 'KRW-BTC',
    side: 'bid',
    requested: { amount: 100_000 }
  });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(submitted)}\nnot-json\n`, 'utf8');
  try {
    const inspection = inspectLiveExecutionEvidenceFile(evidenceFile);
    assert.equal(inspection.available, true);
    assert.equal(inspection.malformedLineCount, 1);
    assert.equal(inspection.reconciliation.unresolvedSubmittedOrderCount, 1);
    assert.ok(inspection.blockingReasons.some(reason => reason.includes('malformed')));
    assert.ok(inspection.blockingReasons.some(reason => reason.includes('unresolved')));
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('a restarted live trader blocks new orders while a prior submission is unresolved', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-restart-'));
  const evidenceFile = path.join(tempDir, 'evidence.jsonl');
  const submitted = createLiveExecutionEvidenceEvent({
    eventType: 'ORDER_SUBMITTED',
    orderId: 'unresolved-order-2',
    market: 'KRW-BTC',
    side: 'bid',
    requested: { amount: 100_000 }
  });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(submitted)}\n`, 'utf8');
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: [],
    dryRun: false,
    useNews: false,
    liveExecutionEvidenceFile: evidenceFile
  });
  let orderCalled = false;
  trader.upbit = {
    async order() {
      orderCalled = true;
      return { success: true, data: { uuid: 'must-not-run' } };
    }
  };
  try {
    const result = await executeLiveOrderWithEvidence(trader, {
      market: 'KRW-BTC',
      side: 'bid',
      volume: 100_000,
      orderType: 'price',
      requested: { amount: 100_000 }
    });
    assert.equal(result.blocked, true);
    assert.equal(orderCalled, false);
    assert.equal(result.reason, 'live_execution_evidence_unavailable');
  } finally {
    trader.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
