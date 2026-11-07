import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import TradingStrategy from '../src/strategy/tradingStrategy.js';
import createPortfolioRoutes from '../src/api/routes/portfolio.js';
import {
  buildExitReceipt,
  classifyExitType,
  parseCandleTimeUtc,
  projectTradeReceipt
} from '../src/trader/tradeReceipt.js';

const near = (actual, expected, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

function buyDecision(candleTime = '2026-11-07T01:00:00') {
  return {
    action: 'BUY',
    reason: 'RSI 과매도 반등',
    signalStrength: { level: 'MEDIUM', multiplier: 1 },
    entrySignalKey: candleTime,
    entryReferencePrice: 100,
    details: {
      rebound: {
        signalKey: candleTime,
        referencePrice: 100,
        candleTime,
        reboundPriceChangePercent: 0.4,
        rsi: 36,
        oversoldRsi: 24,
        rsiRecovery: 12,
        volumeRatio: 1.5
      }
    }
  };
}

function maxHoldSell() {
  return {
    action: 'SELL',
    reason: '스캘핑 최대 보유시간 초과 (30분)',
    details: { positionCheck: { shouldClose: true, type: 'MAX_HOLD_TIME' }, source: 'position_risk_monitor' }
  };
}

function makeTrader(root, overrides = {}) {
  const trader = new MultiCoinTrader({
    accessKey: '',
    secretKey: '',
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRunSeedMoney: 1_000_000,
    investmentRatio: 0.02,
    portfolioAllocation: 1,
    useNews: false,
    candleUnit: 1,
    maxHoldMinutes: 30,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    paperValidationFile: path.join(root, 'paper_validation.json'),
    portfolioHistoryFile: path.join(root, 'history.json'),
    liveExecutionEvidenceFile: path.join(root, 'live-execution.jsonl'),
    aiMonitoringFile: path.join(root, 'ai.json'),
    ...overrides
  });
  trader.calculateTotalAssets = async () => 1_000_000;
  trader.calculateDynamicInvestmentAmount = async () => 20_000;
  trader.confirmScalpingEntry = async () => ({
    currentPrice: 100,
    delayMs: 2500,
    entryCost: { spreadPercent: 0.1, tickPercent: 0.1, costPercent: 0.2, limitPercent: 0.27, filterMode: 'observe' }
  });
  return trader;
}

test('candle times without a zone are read as UTC and exit reasons map to categories', () => {
  assert.equal(parseCandleTimeUtc('2026-11-07T01:00:00'), Date.parse('2026-11-07T01:00:00Z'));
  assert.equal(parseCandleTimeUtc('2026-11-07T10:00:00+09:00'), Date.parse('2026-11-07T01:00:00Z'));
  assert.equal(parseCandleTimeUtc('not a time'), null);
  assert.equal(classifyExitType('MAX_HOLD_TIME'), 'MAX_HOLD');
  assert.equal(classifyExitType(null, '스캘핑 최대 보유시간 초과 (30분)'), 'MAX_HOLD');
  assert.equal(classifyExitType(null, '익절 실행 (1.80% 상승)'), 'TAKE_PROFIT');
  assert.equal(classifyExitType(null, '손절 실행 (-1.20% 하락)'), 'STOP_LOSS');
  assert.equal(classifyExitType(null, '거래소 동기화: 보유량 없음 (최근 시세 추정 청산)'), 'EXCHANGE_SYNC');
  assert.equal(classifyExitType(null, '수동 매도'), 'MANUAL');
  assert.equal(classifyExitType(null, '알 수 없는 이유'), 'OTHER');
  assert.equal(classifyExitType(null, ''), null);
});

test('paper entry and max-hold exit write a receipt without changing the booked P&L', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-receipt-paper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trader = makeTrader(root, { dryRun: true, paperApplyCosts: true, paperSlippage: 0.002 });
  trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
  t.after(() => trader.stop());

  const decision = buyDecision();
  await trader.executeOrder('KRW-BTC', decision, 100, 1_000_000, 0, 0, []);
  const strategy = trader.getStrategy('KRW-BTC');
  const position = strategy.currentPosition;
  assert.ok(position);
  near(position.entryPrice, 100.2);

  const openRecord = strategy.tradeHistory.find(trade => trade.action === 'OPEN');
  assert.equal(openRecord.entryReceipt.mode, 'paper');
  assert.equal(openRecord.signalRsi, 36);
  assert.equal(openRecord.entryReceipt.signal.candleCloseAt, '2026-11-07T01:01:00.000Z');
  assert.equal(openRecord.entryReceipt.confirmation.delayMs, 2500);
  assert.equal(openRecord.entryReceipt.entryCost.costPercent, 0.2);
  assert.equal(openRecord.entryReceipt.slippageSource, 'paper_model');
  near(openRecord.entryReceipt.slippagePercent, 0.2, 1e-4);
  near(openRecord.entryReceipt.fee, 20_000 * 0.0005);
  const orderMs = Date.parse(openRecord.entryReceipt.orderAt);
  assert.equal(openRecord.entryReceipt.signalToOrderMs, orderMs - Date.parse('2026-11-07T01:01:00Z'));

  const volume = position.amount;
  await trader.executeOrder('KRW-BTC', maxHoldSell(), 110, trader.virtualPortfolio.krwBalance, volume, 1, []);
  const close = strategy.tradeHistory.at(-1);
  assert.equal(close.action, 'CLOSE');
  assert.equal(close.exitReceipt.exitType, 'MAX_HOLD');
  assert.equal(close.exitReceipt.maxHoldMinutes, 30);
  assert.equal(close.exitReceipt.trigger, 'position_risk_monitor');
  near(close.exitPrice, 110 * 0.998);
  // Receipts are metadata: the booked profit still equals the wallet change.
  near(close.profit, trader.virtualPortfolio.krwBalance - 1_000_000, 1e-6);

  const receipt = projectTradeReceipt(close, { mode: 'paper' });
  assert.equal(receipt.mode, 'paper');
  assert.equal(receipt.estimated, false);
  assert.equal(receipt.exit.type, 'MAX_HOLD');
  assert.equal(receipt.entry.signal.rsi, 36);
  assert.equal(receipt.entry.signal.oversoldRsi, 24);
  assert.equal(receipt.entry.confirmation.outcome, 'confirmed');
  assert.ok(receipt.exit.holdMs >= 0);
  near(receipt.costs.entrySlippage.krw, (100.2 - 100) * volume, 1e-2);
  near(receipt.costs.exitSlippage.krw, (110 - 109.78) * volume, 1e-2);
  near(receipt.costs.totalFee.krw, close.totalFee, 1e-2);
  near(receipt.result.netProfit, close.profit, 1e-2);
  near(receipt.result.grossProfit, close.grossProfit, 1e-2);
  assert.equal(receipt.result.netProfitWithPaidFees, null);
});

test('LIVE entry and exit receipts use the exchange avg_price and paid_fee', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-receipt-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trader = makeTrader(root, { dryRun: false });
  t.after(() => trader.stop());
  trader.canExecuteLiveOrder = () => true;
  trader.getAccountInfo = async () => [];
  trader.getKRWBalance = () => 1_000_000;
  trader.getCurrentPositionCount = () => 0;
  trader.createLiveExecutionEvidence = evidence => evidence;
  trader.recordLiveExecutionEvidence = () => true;
  trader.recordLiveSettlementReadback = async () => ({ recorded: true });
  trader.notifyTrade = () => {};
  const fills = [
    { uuid: 'buy-1', avg_price: '100.06', executed_volume: '199.8', paid_fee: '9.99', remaining_volume: '0' },
    { uuid: 'sell-1', avg_price: '101.9', executed_volume: '199.8', paid_fee: '10.18', remaining_volume: '0' }
  ];
  trader.submitLiveOrder = async () => ({ success: true, data: { uuid: fills[0].uuid } });
  trader.waitForLiveOrderFill = async () => ({ filled: true, partial: false, order: fills.shift() });

  await trader.executeOrder('KRW-BTC', buyDecision(), 100, 1_000_000, 0, 0, []);
  const strategy = trader.getStrategy('KRW-BTC');
  assert.equal(strategy.currentPosition.entryReceipt.feeSource, 'exchange_paid_fee');
  assert.equal(strategy.currentPosition.entryReceipt.orderId, 'buy-1');

  trader.submitLiveOrder = async () => ({ success: true, data: { uuid: 'sell-1' } });
  await trader.executeOrder('KRW-BTC', {
    action: 'SELL', reason: '익절 실행 (1.90% 상승)', details: { positionCheck: { type: 'TAKE_PROFIT' } }
  }, 102, 0, 199.8, 1, []);

  const close = strategy.tradeHistory.at(-1);
  const receipt = projectTradeReceipt(close, { mode: 'live' });
  assert.equal(receipt.mode, 'live');
  assert.equal(receipt.exit.type, 'TAKE_PROFIT');
  assert.equal(receipt.exit.orderId, 'sell-1');
  near(receipt.costs.entrySlippage.percent, 0.06, 1e-4);
  near(receipt.costs.exitSlippage.percent, (102 - 101.9) / 102 * 100, 1e-4);
  assert.equal(receipt.costs.entryFee.krw, 9.99);
  assert.equal(receipt.costs.exitFee.krw, 10.18);
  near(receipt.result.netProfitWithPaidFees, (101.9 - 100.06) * 199.8 - 9.99 - 10.18, 1e-2);
  assert.equal(receipt.entry.orderId, 'buy-1');
  assert.ok(receipt.entry.signalToOrderMs > 0);
});

test('an exchange-sync close is labelled estimated and a legacy record never gains invented fields', () => {
  const strategy = new TradingStrategy({});
  strategy.openPosition(100, 2, 'BUY');
  strategy.currentPosition.exitReceipt = buildExitReceipt({
    mode: 'live',
    decision: { reason: '거래소 동기화: 보유량 없음 (최근 시세 추정 청산)' },
    exitType: 'EXCHANGE_SYNC',
    filledPrice: 98,
    estimated: true,
    estimateBasis: 'recent_risk_price'
  });
  const synced = projectTradeReceipt(
    { action: 'CLOSE', ...strategy.closePosition(98, '거래소 동기화: 보유량 없음 (최근 시세 추정 청산)') },
    { mode: 'live' }
  );
  assert.equal(synced.estimated, true);
  assert.equal(synced.estimateBasis, 'recent_risk_price');
  assert.equal(synced.exit.type, 'EXCHANGE_SYNC');

  const legacy = projectTradeReceipt({
    action: 'CLOSE',
    entryPrice: 100,
    exitPrice: 101,
    amount: 1,
    grossProfit: 1,
    profit: 0.8995,
    totalFee: 0.1005,
    entryTime: '2026-10-01T00:00:00.000Z',
    exitTime: '2026-10-01T00:30:00.000Z',
    reason: '스캘핑 최대 보유시간 초과 (30분)'
  }, { mode: null });
  assert.equal(legacy.mode, null);
  assert.equal(legacy.exit.type, 'MAX_HOLD');
  assert.equal(legacy.exit.holdMs, 30 * 60 * 1000);
  assert.equal(legacy.entry.signal, null);
  assert.equal(legacy.entry.confirmation, null);
  assert.equal(legacy.entry.expectedPrice, null);
  assert.equal(legacy.entry.signalToOrderMs, null);
  assert.equal(legacy.costs.entrySlippage, null);
  assert.equal(legacy.costs.entryFee, null);
  assert.equal(legacy.costs.totalFee.krw, 0.1);
  assert.equal(legacy.costs.entryCost, null);
  assert.equal(legacy.estimated, false);

  const legacySync = projectTradeReceipt({ action: 'CLOSE', reason: '거래소 동기화: 보유량 없음 (매수가 추정 청산)' });
  assert.equal(legacySync.estimated, true);
  assert.equal(projectTradeReceipt({ action: 'OPEN' }), null);
});

test('a partial close keeps its share of the entry fee and does not leak its exit receipt', () => {
  const strategy = new TradingStrategy({});
  strategy.openPosition(100, 4, 'BUY');
  strategy.currentPosition.entryReceipt = { mode: 'live', fee: 0.2, volume: 4, feeSource: 'exchange_paid_fee' };
  strategy.currentPosition.exitReceipt = buildExitReceipt({ mode: 'live', fee: 0.05, feeSource: 'exchange_paid_fee', filledPrice: 101 });
  const partial = strategy.recordPartialSell(101, 1, '익절 실행');
  assert.equal(strategy.currentPosition.exitReceipt, undefined);
  const receipt = projectTradeReceipt({ action: 'PARTIAL_CLOSE', ...partial });
  assert.equal(receipt.partial, true);
  near(receipt.costs.entryFee.krw, 0.05);
  near(receipt.costs.exitFee.krw, 0.05);
});

test('GET /api/trades adds mode and a receipt to strategy closes only', async t => {
  const server = {
    tradingSystem: {
      dryRun: true,
      config: {},
      strategies: new Map([['KRW-BTC', {
        getTradeHistory: () => [
          { action: 'OPEN', id: 1, entryPrice: 100, amount: 1, entryTime: '2026-11-07T00:00:00.000Z' },
          {
            action: 'CLOSE', id: 1, entryPrice: 100, exitPrice: 99, amount: 1, grossProfit: -1, profit: -1.1,
            totalFee: 0.1, entryTime: '2026-11-07T00:00:00.000Z', exitTime: '2026-11-07T00:30:00.000Z',
            reason: '스캘핑 최대 보유시간 초과 (30분)'
          }
        ]
      }]]),
      smartTradeHistory: [{ id: 'smart', type: 'BUY', timestamp: '2026-11-06T00:00:00.000Z' }]
    }
  };
  const app = express();
  app.use('/api', createPortfolioRoutes(server));
  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  t.after(() => new Promise(resolve => httpServer.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${httpServer.address().port}/api/trades?limit=10`);
  assert.equal(response.status, 200);
  const trades = await response.json();
  const close = trades.find(trade => trade.action === 'CLOSE');
  const open = trades.find(trade => trade.action === 'OPEN');
  const smart = trades.find(trade => trade.id === 'smart');
  assert.equal(close.mode, 'paper');
  assert.equal(close.receipt.exit.type, 'MAX_HOLD');
  assert.equal(close.receipt.result.netProfit, -1.1);
  assert.equal(open.mode, 'paper');
  assert.equal(open.receipt, undefined);
  assert.equal(smart.receipt, undefined);
});
