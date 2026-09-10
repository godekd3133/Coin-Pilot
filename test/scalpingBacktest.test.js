import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateQualityScore,
  simulateScalping,
  simulateScalpingPortfolio,
  tuneScalpingParameters,
  walkForwardValidate,
  walkForwardValidatePortfolio,
  walkForwardValidatePortfolioFolds
} from '../src/backtest/scalpingBacktest.js';
import { calculateCostAdjustedBreakEvenPrice } from '../src/strategy/protectionPrices.js';

function candle(index, close, open = close, high = close, low = close) {
  const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  return {
    candle_date_time_utc: timestamp,
    opening_price: open,
    high_price: high,
    low_price: low,
    trade_price: close,
    candle_acc_trade_volume: 100
  };
}

function syntheticRebound() {
  const candles = [];
  for (let index = 0; index < 26; index += 1) {
    const close = 120 - index;
    candles.push(candle(index, close, close + 0.5, close + 0.5, close - 0.5));
  }

  // Completed bullish rebound after a long RSI washout.
  candles.push(candle(26, 96, 95.2, 96.4, 95));
  // The next candle is the conservative delayed-entry proxy and reaches take profit.
  candles.push(candle(27, 97.8, 96, 98.2, 95.8));
  candles.push(candle(28, 97.5, 97.8, 98, 97.2));
  return candles;
}

function syntheticGivebackAfterRebound() {
  const candles = syntheticRebound().slice(0, 27);
  candles.push(candle(27, 96.2, 96, 97.2, 95.8));
  candles.push(candle(28, 97.0, 96.8, 97.2, 96.8));
  candles.push(candle(29, 96.0, 96.8, 97.0, 95.5));
  candles.push(candle(30, 94.0, 96.0, 96.2, 93.5));
  return candles;
}

test('스캘핑 시뮬레이터가 수수료를 포함한 지연 반등 수익을 계산한다', () => {
  const result = simulateScalping(syntheticRebound(), {
    initialBalance: 1_000_000,
    tradingFee: 0.0005,
    slippage: 0,
    investmentRatio: 0.02,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8
  });

  assert.equal(result.metrics.signals, 1);
  assert.equal(result.metrics.cancelledSignals, 0);
  assert.equal(result.metrics.tradeCount, 1);
  assert.equal(result.metrics.winningTrades, 1);
  assert.ok(result.metrics.fees > 0);
  assert.ok(result.metrics.totalReturnPercent > 0);
  assert.equal(result.trades[0].type, 'OPEN');
  assert.equal(result.trades.at(-1).reason, 'TAKE_PROFIT');
});

test('튜너는 후보 파라미터를 모두 평가하고 최고 품질 결과를 반환한다', () => {
  const tuning = tuneScalpingParameters(
    syntheticRebound(),
    { initialBalance: 1_000_000, slippage: 0 },
    {
      rsiOversold: [25, 30],
      minReboundPercent: [0.1, 0.15],
      minRsiRecovery: [1],
      stopLossPercent: [1.2],
      takeProfitPercent: [1.8]
    }
  );

  assert.equal(tuning.candidateCount, 4);
  assert.equal(tuning.topCandidates.length, 4);
  assert.ok(tuning.best.result.metrics);
});

test('워크포워드 검증은 데이터가 부족하면 승격하지 않는다', () => {
  const result = walkForwardValidate(syntheticRebound().slice(0, 10), {}, { minimumCandles: 30 });
  assert.equal(result.promoted, false);
  assert.match(result.reason, /insufficient_candles/);
});

test('튜닝 점수는 손실 후보의 거래 수를 보너스로 보상하지 않는다', () => {
  const noTrade = calculateQualityScore({
    totalReturnPercent: 0,
    maxDrawdownPercent: 0,
    profitFactor: 0,
    tradeCount: 0
  });
  const losingCandidate = calculateQualityScore({
    totalReturnPercent: -0.04,
    maxDrawdownPercent: 0.04,
    profitFactor: 0.05,
    tradeCount: 8
  });
  const profitableCandidate = calculateQualityScore({
    totalReturnPercent: 2,
    maxDrawdownPercent: 1,
    profitFactor: 1.2,
    tradeCount: 8
  });

  assert.ok(losingCandidate < noTrade);
  assert.ok(profitableCandidate > noTrade);
});

test('백테스트도 신호 캔들 변동폭 상한을 동일하게 적용한다', () => {
  const unrestricted = simulateScalping(syntheticRebound(), {
    slippage: 0,
    maxSignalRangePercent: 0
  });
  const guarded = simulateScalping(syntheticRebound(), {
    slippage: 0,
    maxSignalRangePercent: 0.5
  });

  assert.equal(unrestricted.metrics.tradeCount, 1);
  assert.equal(guarded.metrics.signals, 0);
  assert.equal(guarded.metrics.tradeCount, 0);
  assert.ok(guarded.metrics.rejectionCounts.signal_range_too_wide > 0);
});

test('백테스트도 신호 캔들 변동폭 하한을 동일하게 적용한다', () => {
  const guarded = simulateScalping(syntheticRebound(), {
    slippage: 0,
    minSignalRangePercent: 3
  });

  assert.equal(guarded.metrics.signals, 0);
  assert.equal(guarded.metrics.tradeCount, 0);
  assert.ok(guarded.metrics.rejectionCounts.signal_range_too_narrow > 0);
});

test('rebound overbought guard는 과열된 반등 후보를 백테스트에서도 제외한다', () => {
  const guarded = simulateScalping(syntheticRebound(), {
    slippage: 0,
    rsiOverbought: 1,
    requireReboundBelowOverbought: true
  });

  assert.equal(guarded.metrics.signals, 0);
  assert.equal(guarded.metrics.tradeCount, 0);
  assert.ok(guarded.metrics.rejectionCounts.rsi_overbought_blocked > 0);
});

test('다음 봉 양봉 확인 후보는 양봉 종가에만 진입한다', () => {
  const followed = simulateScalping(syntheticRebound(), {
    slippage: 0,
    requireNextCandleBullish: true
  });
  assert.equal(followed.metrics.tradeCount, 1);
  assert.equal(followed.trades[0].entryPrice, 97.8);

  const rejectedCandles = syntheticRebound();
  rejectedCandles[27] = candle(95.9, 96.2, 96.5, 95.5);
  const rejected = simulateScalping(rejectedCandles, {
    slippage: 0,
    requireNextCandleBullish: true
  });
  assert.equal(rejected.metrics.signals, 1);
  assert.equal(rejected.metrics.cancelledSignals, 1);
  assert.equal(rejected.metrics.tradeCount, 0);
});

test('보호 출구 후보는 이익을 보존하고 기본 고정 손절과 분리해 측정된다', () => {
  const baseConfig = {
    slippage: 0,
    stopLossPercent: 1.2,
    takeProfitPercent: 5,
    maxHoldMinutes: 30
  };
  const fixed = simulateScalping(syntheticGivebackAfterRebound(), baseConfig);
  const protectedResult = simulateScalping(syntheticGivebackAfterRebound(), {
    ...baseConfig,
    breakEvenTriggerPercent: 0.5,
    breakEvenOffsetPercent: 0.05,
    trailingActivationPercent: 0.8,
    trailingStopPercent: 0.4
  });

  assert.equal(fixed.metrics.tradeCount, 1);
  assert.equal(protectedResult.metrics.tradeCount, 1);
  assert.equal(protectedResult.trades.at(-1).reason, 'TRAILING_STOP');
  assert.ok(protectedResult.metrics.totalReturnPercent > fixed.metrics.totalReturnPercent);
});

test('break-even 기준가는 왕복 수수료와 adverse slippage를 포함한다', () => {
  const entryPrice = 100;
  const tradingFee = 0.0005;
  const slippage = 0.001;
  const price = calculateCostAdjustedBreakEvenPrice(entryPrice, {
    tradingFee,
    slippage,
    offsetPercent: 0.05
  });

  assert.ok(price > 100.2);
  const investAmount = 20_000;
  const amount = (investAmount * (1 - tradingFee)) / entryPrice;
  const exitPrice = price * (1 - slippage);
  const netProfit = amount * exitPrice * (1 - tradingFee) - investAmount;
  assert.ok(netProfit >= 0);
});

test('momentum_breakout 프로파일은 과매도 없이 고가 돌파를 시뮬레이션한다', () => {
  const result = simulateScalping(syntheticRebound(), {
    slippage: 0,
    signalProfile: 'momentum_breakout',
    rsiOverbought: 70,
    minRsiRecovery: 0,
    minVolumeRatio: 0,
    minCloseStrength: 0,
    minTrendSlopePercent: -100,
    emaPeriod: 2,
    requirePreviousHighBreak: true,
    takeProfitPercent: 1
  });

  assert.ok(result.metrics.signals >= 1);
  assert.equal(result.metrics.tradeCount, 1);
});

test('포트폴리오 시뮬레이터는 공유 잔액과 최대 포지션 수로 동시 신호를 선택한다', () => {
  const candles = syntheticRebound().slice(0, 28);
  const result = simulateScalpingPortfolio({
    'KRW-A': candles,
    'KRW-B': candles
  }, {
    initialBalance: 1_000_000,
    slippage: 0,
    maxPositions: 1,
    portfolioAllocation: 0.1,
    investmentRatio: 0.02,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8
  });

  assert.equal(result.portfolio, true);
  assert.equal(result.marketCount, 2);
  assert.equal(result.metrics.tradeCount, 1);
  assert.equal(result.metrics.totalReturnPercent > 0, true);
  assert.equal(result.trades.filter(trade => trade.type === 'OPEN').length, 1);
  assert.equal(result.skippedEntries, 1);
  assert.equal(result.trades.find(trade => trade.type === 'OPEN').market, 'KRW-A');
});

test('포트폴리오 signal window 상한은 같은 완료 캔들의 동시 진입을 제한한다', () => {
  const candles = syntheticRebound().slice(0, 28);
  const result = simulateScalpingPortfolio({
    'KRW-A': candles,
    'KRW-B': candles
  }, {
    initialBalance: 1_000_000,
    slippage: 0,
    maxPositions: 3,
    maxEntriesPerSignalWindow: 1,
    portfolioAllocation: 0.1,
    investmentRatio: 0.02,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8
  });

  assert.equal(result.metrics.tradeCount, 1);
  assert.equal(result.trades.filter(trade => trade.type === 'OPEN').length, 1);
  assert.equal(result.metrics.signalWindowBlockedEntries, 1);
  assert.equal(result.signalWindowBlockedEntries, 1);
});

test('포트폴리오 워크포워드는 독립 market gate와 분리된 진단 결과를 반환한다', () => {
  const candles = syntheticRebound();
  const result = walkForwardValidatePortfolio({
    'KRW-A': candles,
    'KRW-B': candles
  }, {
    initialBalance: 1_000_000,
    slippage: 0,
    maxPositions: 1,
    rsiPeriod: 2,
    volumeLookback: 2,
    trendPeriod: 2,
    trendSlopeLookback: 1,
    bbPeriod: 2,
    emaPeriod: 2
  }, {
    grid: {},
    minimumCandles: 20,
    minimumValidationTrades: 1
  });

  assert.equal(result.marketCount, 2);
  assert.equal(result.promotion, 'diagnostic_only_never_authorizes_live_orders');
  assert.ok(result.validation);
  assert.equal(typeof result.selection.skippedEntries, 'number');
  assert.equal(result.promoted, false);
});

test('포트폴리오 regime gate는 시장 breadth가 약하면 반등 신호를 차단한다', () => {
  const candles = syntheticRebound();
  const result = simulateScalpingPortfolio({
    'KRW-A': candles,
    'KRW-B': candles
  }, {
    initialBalance: 1_000_000,
    slippage: 0,
    maxPositions: 1,
    marketRegimeEnabled: true,
    marketRegimeLookback: 5,
    marketRegimeMinBreadth: 1,
    marketRegimeMinReturnPercent: 100
  });

  assert.equal(result.metrics.tradeCount, 0);
  assert.ok(result.metrics.marketRegimeBlockedEntries > 0);
});

test('portfolio multi-fold 검증은 모든 미래 fold를 별도로 판정한다', () => {
  const candles = syntheticRebound();
  const result = walkForwardValidatePortfolioFolds({
    'KRW-A': candles,
    'KRW-B': candles
  }, {
    initialBalance: 1_000_000,
    slippage: 0,
    rsiPeriod: 2,
    volumeLookback: 2,
    trendPeriod: 2,
    trendSlopeLookback: 1,
    bbPeriod: 2,
    emaPeriod: 2
  }, {
    foldCount: 2,
    initialTrainRatio: 0.5,
    minimumCandles: 20,
    minimumValidationTrades: 1,
    grid: {}
  });

  assert.equal(result.foldCount, 2);
  assert.equal(result.folds.length, 2);
  assert.equal(result.promoted, false);
  assert.equal(result.promotion, 'diagnostic_only_never_authorizes_live_orders');
});
