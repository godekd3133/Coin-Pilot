import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateQualityScore,
  calculateTradeReturnConfidence,
  createScalpingFeatureCache,
  analyzeHistoricalCandleContinuity,
  historicalTimestampForCandle,
  normalizeHistoricalCandles,
  splitHistoricalCandleSegments,
  simulateScalpingSegmented,
  evaluateStatisticalConfidenceGate,
  simulateScalping,
  simulateScalpingPortfolio,
  tuneScalpingParameters,
  walkForwardValidate,
  walkForwardValidatePortfolio,
  walkForwardValidatePortfolioFolds
} from '../src/backtest/scalpingBacktest.js';
import { calculateCostAdjustedBreakEvenPrice } from '../src/strategy/protectionPrices.js';
import { fillNoTradeCandleGaps } from '../src/research/historicalCandleSeries.js';

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

function syntheticReboundWithMinuteGap() {
  return syntheticRebound().map((value, index) => ({
    ...value,
    candle_date_time_utc: new Date(Date.UTC(2026, 0, 1, 0, index + (index >= 27 ? 2 : 0))).toISOString()
  }));
}

function syntheticReboundWithGapAfterEntry() {
  return syntheticRebound().map((value, index) => ({
    ...value,
    candle_date_time_utc: new Date(Date.UTC(2026, 0, 1, 0, index + (index >= 28 ? 2 : 0))).toISOString()
  }));
}

test('historical candle gap is detected and the simulator fails closed', () => {
  const candles = syntheticReboundWithMinuteGap();
  const continuity = analyzeHistoricalCandleContinuity(candles, 1);

  assert.equal(continuity.valid, false);
  assert.equal(continuity.gapCount, 1);
  assert.ok(continuity.largestGapSeconds > 60);

  const result = simulateScalping(candles, { slippage: 0, candleUnit: 1 });
  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.metrics.dataQuality.valid, false);
  assert.match(result.metrics.dataQuality.reason, /historical_candle_gap/);
});

test('epoch-ms 숫자 timestamp는 최신순 행을 시간순으로 뒤집고 continuity를 통과한다', () => {
  const base = Date.UTC(2026, 0, 1, 0, 0);
  const row = (minute, close) => ({
    timestamp: base + minute * 60_000,
    opening_price: close,
    high_price: close + 0.5,
    low_price: close - 0.5,
    trade_price: close,
    candle_acc_trade_volume: 100
  });
  // Upbit returns newest-first; the numeric timestamp alone must be enough to
  // detect and reverse that ordering.
  const newestFirst = [row(2, 102), row(1, 101), row(0, 100)];

  const normalized = normalizeHistoricalCandles(newestFirst);
  assert.deepEqual(
    normalized.map(value => value.timestamp),
    [base, base + 60_000, base + 120_000]
  );
  assert.equal(analyzeHistoricalCandleContinuity(newestFirst, 1).valid, true);
  assert.equal(analyzeHistoricalCandleContinuity(newestFirst, 1).reason, 'historical_candles_contiguous');
});

test('epoch-ms timestamp만 가진 캔들도 끝단 시뮬레이션을 재생한다', () => {
  const base = Date.UTC(2026, 0, 1, 0, 0);
  const candles = syntheticRebound().map((value, index) => {
    const { candle_date_time_utc, ...rest } = value;
    return { ...rest, timestamp: base + index * 60_000 };
  });

  const result = simulateScalping(candles, { slippage: 0 });
  assert.equal(result.metrics.tradeCount, 1);
  assert.equal(result.trades.at(-1).reason, 'TAKE_PROFIT');
  assert.equal(result.metrics.dataQuality.valid, true);
});

test('epoch-ms 문자열 timestamp도 파싱되어 무체결 gap을 채울 수 있다', () => {
  const base = Date.UTC(2026, 0, 1, 0, 0);
  const row = (minute, close) => ({
    timestamp: String(base + minute * 60_000),
    opening_price: close,
    high_price: close + 0.5,
    low_price: close - 0.5,
    trade_price: close,
    candle_acc_trade_volume: 100
  });
  const filled = fillNoTradeCandleGaps([row(2, 102), row(0, 100)], 1);

  assert.equal(filled.dataQuality.invalidTimestampCount, 0);
  assert.equal(filled.dataQuality.syntheticNoTradeCount, 1);
  assert.equal(filled.dataQuality.validForReplay, true);
  assert.equal(filled.candles[1].trade_price, 100);
  assert.equal(filled.candles[1].isSyntheticNoTrade, true);
});

test('timestamp helper는 Date 인스턴스와 짧은 숫자 문자열을 구분한다', () => {
  const epoch = Date.UTC(2026, 0, 1, 0, 0);
  assert.equal(historicalTimestampForCandle({ timestamp: new Date(epoch) }), epoch);
  assert.equal(historicalTimestampForCandle({ timestamp: epoch }), epoch);
  assert.equal(historicalTimestampForCandle({ timestamp: String(epoch) }), epoch);
  // A bare year or counter-sized digit string is not an epoch-ms value; it
  // stays on the date-parser path instead of becoming a 1970-era row.
  assert.notEqual(historicalTimestampForCandle({ timestamp: '12345' }), 12345);
  assert.equal(historicalTimestampForCandle({ timestamp: -5 }), null);
  assert.equal(historicalTimestampForCandle({ timestamp: 'not-a-date' }), null);
});

test('무체결 gap filler는 전일 종가와 거래량 0으로 시간을 보존한다', () => {
  const raw = [candle(2, 102), candle(0, 100)];
  const filled = fillNoTradeCandleGaps(raw, 1);

  assert.equal(filled.dataQuality.validForReplay, true);
  assert.equal(filled.dataQuality.rawCandleCount, 2);
  assert.equal(filled.dataQuality.syntheticNoTradeCount, 1);
  assert.equal(filled.dataQuality.filledGapCount, 1);
  assert.equal(filled.dataQuality.continuityAfterFill.valid, true);
  assert.equal(filled.candles.length, 3);
  assert.deepEqual(
    filled.candles.map(value => value.candle_date_time_utc),
    [
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:01:00.000Z',
      '2026-01-01T00:02:00.000Z'
    ]
  );
  assert.equal(filled.candles[1].trade_price, 100);
  assert.equal(filled.candles[1].candle_acc_trade_volume, 0);
  assert.equal(filled.candles[1].isSyntheticNoTrade, true);
});

test('무체결 gap filler는 설정한 범위를 넘는 gap을 채우지 않는다', () => {
  const filled = fillNoTradeCandleGaps(
    [candle(3, 103), candle(0, 100)],
    1,
    { maxFillIntervals: 1 }
  );

  assert.equal(filled.dataQuality.syntheticNoTradeCount, 0);
  assert.equal(filled.dataQuality.unfilledGapCount, 1);
  assert.equal(filled.dataQuality.validForReplay, false);
  assert.equal(filled.dataQuality.continuityAfterFill.valid, false);
});

test('shared portfolio backtest refuses to mix an invalid market window', () => {
  const result = simulateScalpingPortfolio({
    'KRW-BTC': syntheticRebound(),
    'KRW-ETH': syntheticReboundWithMinuteGap()
  }, { slippage: 0, candleUnit: 1 });

  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.dataQuality.valid, false);
  assert.deepEqual(result.dataQuality.invalidMarkets, ['KRW-ETH']);
  assert.equal(result.metrics.dataQuality.reason, 'historical_candle_continuity_failed');
});

test('segmented diagnostic splits gaps and excludes open positions at boundaries', () => {
  const candles = syntheticReboundWithGapAfterEntry();
  const split = splitHistoricalCandleSegments(candles, 1, { minimumSegmentCandles: 10 });

  assert.equal(split.segments.length, 1);
  assert.equal(split.boundaryCount, 1);
  assert.equal(split.excludedSegmentCount, 1);
  assert.equal(split.segments[0].candleCount, 28);

  const result = simulateScalpingSegmented(candles, {
    slippage: 0,
    stopLossPercent: 50,
    takeProfitPercent: 50
  }, {
    minimumSegmentCandles: 10
  });

  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.unknownBoundaryPositions.length, 1);
  assert.equal(result.unknownBoundaryPositions[0].reason, 'open_position_at_gap_boundary');
  assert.equal(result.promotion, 'diagnostic_only_never_authorizes_live_orders');
});

test('segmented diagnostic preserves a contiguous simulation result', () => {
  const candles = syntheticRebound();
  const baseline = simulateScalping(candles, { slippage: 0 });
  const segmented = simulateScalpingSegmented(candles, { slippage: 0 }, {
    minimumSegmentCandles: 10
  });

  assert.equal(segmented.dataQuality.raw.valid, true);
  assert.equal(segmented.dataQuality.boundaryCount, 0);
  assert.equal(segmented.unknownBoundaryPositions.length, 0);
  assert.equal(segmented.metrics.tradeCount, baseline.metrics.tradeCount);
  assert.equal(segmented.metrics.netProfit, baseline.metrics.netProfit);
});

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

test('백테스트 청산 거래는 MFE/MAE를 함께 기록해 exit 후보를 진단할 수 있다', () => {
  const result = simulateScalping(syntheticRebound(), {
    slippage: 0,
    tradingFee: 0
  });
  const close = result.trades.at(-1);

  assert.equal(close.type, 'CLOSE');
  assert.equal(close.reason, 'TAKE_PROFIT');
  assert.ok(Number.isFinite(close.maxFavorableExcursionPercent));
  assert.ok(Number.isFinite(close.maxAdverseExcursionPercent));
  assert.ok(close.maxFavorableExcursionPercent >= 1.8);
  assert.ok(close.maxAdverseExcursionPercent <= 0);
});

test('튜닝 feature cache는 uncached 시뮬레이션과 같은 거래 결과를 재사용한다', () => {
  const config = {
    slippage: 0,
    rsiOversold: 30,
    rsiOverbought: 70,
    minVolumeRatio: 1,
    minCloseStrength: 0.65,
    minTrendSlopePercent: -0.2
  };
  const candles = syntheticRebound();
  const featureCache = createScalpingFeatureCache(candles);
  const uncached = simulateScalping(candles, config, { useFeatureCache: false });
  const cached = simulateScalping(candles, config, { featureCache });

  assert.deepEqual(cached.trades, uncached.trades);
  assert.deepEqual(cached.metrics, uncached.metrics);
  // Threshold-only changes share the same precomputed RSI/rolling features.
  simulateScalping(candles, { ...config, minReboundPercent: 0.5 }, { featureCache });
  assert.equal(featureCache.size(), 1);
});

test('max rebound exhaustion guard는 기본 비활성이고 양수 설정에서만 진입을 차단한다', () => {
  const candles = syntheticRebound();
  const baseline = simulateScalping(candles, { slippage: 0 });
  const guarded = simulateScalping(candles, { slippage: 0, maxReboundPercent: 0.1 });

  assert.equal(baseline.metrics.tradeCount, 1);
  assert.equal(guarded.metrics.tradeCount, 0);
  assert.ok(guarded.metrics.rejectionCounts.price_rebound_above_threshold >= 1);
});

test('feature cache는 대체 signal profile의 지표 결과도 보존한다', () => {
  const candles = syntheticRebound();
  for (const signalProfile of ['bb_reclaim', 'trend_rebound', 'momentum_breakout']) {
    const config = {
      signalProfile,
      slippage: 0,
      rsiOversold: 30,
      rsiOverbought: 70,
      emaPeriod: 2,
      bbPeriod: 5,
      trendPeriod: 4,
      trendSlopeLookback: 1,
      minVolumeRatio: 0,
      minCloseStrength: 0,
      minTrendSlopePercent: -100
    };
    const featureCache = createScalpingFeatureCache(candles);
    const uncached = simulateScalping(candles, config, { useFeatureCache: false });
    const cached = simulateScalping(candles, config, { featureCache });
    assert.deepEqual(cached.trades, uncached.trades, signalProfile);
    assert.deepEqual(cached.metrics, uncached.metrics, signalProfile);
  }
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

test('tuned holdout 후보 상한은 full pool과 선택 수를 분리해 기록한다', () => {
  const tuning = tuneScalpingParameters(
    syntheticRebound(),
    { initialBalance: 1_000_000, slippage: 0 },
    {
      rsiOversold: [25, 30],
      minReboundPercent: [0.1, 0.15],
      minRsiRecovery: [1],
      stopLossPercent: [1.2],
      takeProfitPercent: [1.8]
    },
    { maxCandidates: 2 }
  );

  assert.equal(tuning.candidatePoolCount, 4);
  assert.equal(tuning.candidateCount, 2);
  assert.equal(tuning.candidateSelectionLimited, true);
});

test('튜너의 최소 거래수 guard는 fallback 여부를 숨기지 않는다', () => {
  const tuning = tuneScalpingParameters(
    syntheticRebound(),
    { initialBalance: 1_000_000, slippage: 0 },
    {
      rsiOversold: [25, 30],
      minReboundPercent: [0.1, 0.15],
      minRsiRecovery: [1],
      stopLossPercent: [1.2],
      takeProfitPercent: [1.8]
    },
    { minimumTradeCount: 2 }
  );

  assert.equal(tuning.minimumTradeCount, 2);
  assert.equal(tuning.eligibleCandidateCount, 0);
  assert.equal(tuning.minimumTradeFallback, true);
  assert.ok(tuning.best);
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

test('거래별 95% 신뢰도 하한은 소표본 양수를 승격 근거로 만들지 않는다', () => {
  const oneTrade = calculateTradeReturnConfidence([
    { type: 'OPEN', investAmount: 100 },
    { type: 'CLOSE', investAmount: 100, netProfit: 2, profitPercent: 2 }
  ]);
  assert.equal(oneTrade.sampleCount, 1);
  assert.equal(oneTrade.lowerBoundPercent, null);

  const stableTrades = calculateTradeReturnConfidence([
    { type: 'CLOSE', investAmount: 100, netProfit: 2, profitPercent: 2 },
    { type: 'CLOSE', investAmount: 100, netProfit: 2, profitPercent: 2 },
    { type: 'CLOSE', investAmount: 100, netProfit: 2, profitPercent: 2 },
    { type: 'CLOSE', investAmount: 100, netProfit: 2, profitPercent: 2 }
  ]);
  assert.equal(stableTrades.sampleCount, 4);
  assert.equal(stableTrades.meanReturnPercent, 2);
  assert.equal(stableTrades.lowerBoundPercent, 2);

  const legacyTradeFallback = calculateTradeReturnConfidence([
    { type: 'CLOSE', investAmount: 100, netProfit: 5, profitPercent: null },
    { type: 'CLOSE', investAmount: 100, netProfit: 5 },
  ]);
  assert.equal(legacyTradeFallback.meanReturnPercent, 5);
  assert.equal(legacyTradeFallback.lowerBoundPercent, 5);

  const paperLedgerClose = calculateTradeReturnConfidence([
    { type: 'BUY', action: 'CLOSE', investAmount: 100, profit: 4, profitPercent: null }
  ]);
  assert.equal(paperLedgerClose.sampleCount, 1);
  assert.equal(paperLedgerClose.meanReturnPercent, 4);

  const metrics = { tradeReturnConfidence: stableTrades };
  assert.equal(evaluateStatisticalConfidenceGate(metrics, {
    required: true,
    minimumTrades: 4,
    minimumLowerBoundPercent: 0
  }).passed, true);
  assert.equal(evaluateStatisticalConfidenceGate(metrics, {
    required: true,
    minimumTrades: 5,
    minimumLowerBoundPercent: 0
  }).passed, false);
  assert.equal(evaluateStatisticalConfidenceGate(metrics, {
    required: false,
    minimumTrades: 20,
    minimumLowerBoundPercent: 0
  }).passed, true);
  const unavailableGate = evaluateStatisticalConfidenceGate({
    tradeReturnConfidence: oneTrade
  }, {
    required: true,
    minimumTrades: 1,
    minimumLowerBoundPercent: 0
  });
  assert.equal(unavailableGate.lowerBoundPercent, null);
  assert.equal(unavailableGate.passed, false);
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
  rejectedCandles[27] = candle(27, 95.9, 96.2, 96.5, 95.5);
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

function syntheticWinnerExtension(mode = 'rally') {
  const candles = [];
  for (let index = 0; index < 26; index += 1) {
    const close = 120 - index;
    candles.push(candle(index, close, close + 0.5, close + 0.5, close - 0.5));
  }
  candles.push(candle(26, 96, 95.2, 96.4, 95));
  // Entry happens at the open of index 27 (96) via the delayed-entry proxy.
  candles.push(candle(27, 96.1, 96, 96.3, 95.9));
  if (mode === 'rally') {
    for (let index = 28; index <= 56; index += 1) {
      const close = 96.1 + (index - 28) * 0.018;
      candles.push(candle(index, close, close - 0.01, close + 0.02, close - 0.03));
    }
    for (let index = 57; index <= 117; index += 1) {
      const close = 96.6 + (index - 56) * 0.18;
      candles.push(candle(index, close, close - 0.05, close + 0.05, close - 0.08));
    }
  } else if (mode === 'fade') {
    for (let index = 28; index <= 60; index += 1) {
      const close = 96.1 - (index - 28) * 0.02;
      candles.push(candle(index, close, close + 0.01, close + 0.02, close - 0.03));
    }
  } else if (mode === 'dip') {
    for (let index = 28; index <= 56; index += 1) {
      const close = 96.1 + (index - 28) * 0.018;
      candles.push(candle(index, close, close - 0.01, close + 0.02, close - 0.03));
    }
    candles.push(candle(57, 96.7, 96.6, 96.8, 96.5));
    candles.push(candle(58, 96.75, 96.7, 96.9, 96.6));
    // Break-even floor breach after the extension is armed.
    candles.push(candle(59, 96.0, 96.75, 96.8, 95.9));
    candles.push(candle(60, 95.5, 96.0, 96.1, 95.3));
  }
  return candles;
}

test('winner hold 연장은 max-hold 경계의 수익 포지션만 본전 스탑과 함께 연장한다', () => {
  const baseConfig = {
    slippage: 0,
    stopLossPercent: 20,
    takeProfitPercent: 50,
    maxHoldMinutes: 30
  };
  const candles = syntheticWinnerExtension('rally');
  const fixed = simulateScalping(candles, baseConfig);
  const extended = simulateScalping(candles, {
    ...baseConfig,
    winnerExtendMinutes: 60
  });

  assert.equal(fixed.metrics.tradeCount, 1);
  const fixedClose = fixed.trades.at(-1);
  assert.equal(fixedClose.reason, 'MAX_HOLD_TIME');
  assert.equal(fixedClose.winnerExtended, false);
  assert.ok(fixedClose.exitPrice < 97);

  assert.equal(extended.metrics.tradeCount, 1);
  const extendedClose = extended.trades.at(-1);
  assert.equal(extendedClose.reason, 'MAX_HOLD_TIME');
  assert.equal(extendedClose.winnerExtended, true);
  assert.ok(extendedClose.exitPrice > 107);
  assert.ok(extendedClose.profitPercent > fixedClose.profitPercent + 5);
});

test('winner hold 연장의 최소 수익 기준을 넘지 못하면 기존 max-hold를 유지한다', () => {
  const candles = syntheticWinnerExtension('rally');
  const result = simulateScalping(candles, {
    slippage: 0,
    stopLossPercent: 20,
    takeProfitPercent: 50,
    maxHoldMinutes: 30,
    winnerExtendMinutes: 60,
    winnerExtendMinProfitPercent: 1.0
  });

  const close = result.trades.at(-1);
  assert.equal(close.reason, 'MAX_HOLD_TIME');
  assert.equal(close.winnerExtended, false);
  assert.ok(close.exitPrice < 97);
});

test('경계에서 손실 중이면 winner hold 연장이 적용되지 않는다', () => {
  const result = simulateScalping(syntheticWinnerExtension('fade'), {
    slippage: 0,
    stopLossPercent: 20,
    takeProfitPercent: 50,
    maxHoldMinutes: 30,
    winnerExtendMinutes: 60
  });

  const close = result.trades.at(-1);
  assert.equal(close.reason, 'MAX_HOLD_TIME');
  assert.equal(close.winnerExtended, false);
  assert.ok(close.exitPrice < 96);
});

test('연장된 포지션은 본전 스탑으로 추가 하락 대신 수익을 보존한다', () => {
  const result = simulateScalping(syntheticWinnerExtension('dip'), {
    slippage: 0,
    stopLossPercent: 20,
    takeProfitPercent: 50,
    maxHoldMinutes: 30,
    winnerExtendMinutes: 60
  });

  const close = result.trades.at(-1);
  assert.equal(close.reason, 'BREAK_EVEN_STOP');
  assert.equal(close.winnerExtended, true);
  assert.ok(close.netProfit >= 0);
});
