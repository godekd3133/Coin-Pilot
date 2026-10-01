/**
 * 기술적 지표 계산 모듈
 */

import {
  calculateRsiSeries,
  computeReboundPoint,
  decideReboundSignal,
  emptyReboundSignal
} from './reboundSignal.js';

/**
 * RSI (Relative Strength Index) 계산
 * @param {Array} candles - 캔들 데이터 배열 (최신 데이터가 앞에)
 * @param {number} period - RSI 기간 (기본값: 14)
 * @returns {number} RSI 값 (0-100)
 */
export function calculateRSI(candles, period = 14) {
  if (candles.length < period + 1) {
    throw new Error(`RSI 계산을 위해서는 최소 ${period + 1}개의 캔들이 필요합니다.`);
  }

  // 최신 데이터가 앞에 있으므로 역순으로 처리
  const prices = candles.map(c => c.trade_price).reverse();

  let gains = 0;
  let losses = 0;

  // 첫 번째 평균 계산
  for (let i = 1; i <= period; i++) {
    const difference = prices[i] - prices[i - 1];
    if (difference >= 0) {
      gains += difference;
    } else {
      losses -= difference;
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder's smoothing 방식으로 평균 계산
  for (let i = period + 1; i < prices.length; i++) {
    const difference = prices[i] - prices[i - 1];
    const currentGain = difference >= 0 ? difference : 0;
    const currentLoss = difference < 0 ? -difference : 0;

    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  return rsi;
}

/**
 * MACD (Moving Average Convergence Divergence) 계산
 * @param {Array} candles - 캔들 데이터 배열
 * @param {number} fastPeriod - 빠른 EMA 기간 (기본값: 12)
 * @param {number} slowPeriod - 느린 EMA 기간 (기본값: 26)
 * @param {number} signalPeriod - 시그널 EMA 기간 (기본값: 9)
 * @returns {Object} {macd, signal, histogram}
 */
export function calculateMACD(candles, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (candles.length < slowPeriod + signalPeriod) {
    throw new Error(`MACD 계산을 위해서는 최소 ${slowPeriod + signalPeriod}개의 캔들이 필요합니다.`);
  }

  const prices = candles.map(c => c.trade_price).reverse();

  const fastEMA = calculateEMA(prices, fastPeriod);
  const slowEMA = calculateEMA(prices, slowPeriod);

  const macdLine = fastEMA - slowEMA;

  // MACD 라인의 배열 생성 (시그널 계산용)
  const macdValues = [];
  for (let i = slowPeriod - 1; i < prices.length; i++) {
    const fastEMAValue = calculateEMAAtIndex(prices, fastPeriod, i);
    const slowEMAValue = calculateEMAAtIndex(prices, slowPeriod, i);
    macdValues.push(fastEMAValue - slowEMAValue);
  }

  const signal = calculateEMA(macdValues, signalPeriod);
  const histogram = macdLine - signal;

  return {
    macd: macdLine,
    signal: signal,
    histogram: histogram
  };
}

/**
 * EMA (Exponential Moving Average) 계산
 * @param {Array} prices - 가격 배열
 * @param {number} period - 기간
 * @returns {number} EMA 값
 */
function calculateEMA(prices, period) {
  const multiplier = 2 / (period + 1);
  let ema = prices[0];

  for (let i = 1; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * 특정 인덱스에서의 EMA 계산
 */
function calculateEMAAtIndex(prices, period, index) {
  const multiplier = 2 / (period + 1);
  let ema = prices[0];

  for (let i = 1; i <= index; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * 볼린저 밴드 계산
 * @param {Array} candles - 캔들 데이터 배열
 * @param {number} period - 기간 (기본값: 20)
 * @param {number} stdDev - 표준편차 배수 (기본값: 2)
 * @returns {Object} {upper, middle, lower}
 */
export function calculateBollingerBands(candles, period = 20, stdDev = 2) {
  if (candles.length < period) {
    throw new Error(`볼린저 밴드 계산을 위해서는 최소 ${period}개의 캔들이 필요합니다.`);
  }

  const prices = candles.slice(0, period).map(c => c.trade_price);

  // 중간 밴드 (단순 이동평균)
  const middle = prices.reduce((sum, price) => sum + price, 0) / period;

  // 표준편차 계산
  const squaredDiffs = prices.map(price => Math.pow(price - middle, 2));
  const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / period;
  const standardDeviation = Math.sqrt(variance);

  // 상단/하단 밴드
  const upper = middle + (standardDeviation * stdDev);
  const lower = middle - (standardDeviation * stdDev);

  return {
    upper: upper,
    middle: middle,
    lower: lower,
    currentPrice: candles[0].trade_price
  };
}

/**
 * 이동평균선 계산
 * @param {Array} candles - 캔들 데이터 배열
 * @param {number} period - 기간
 * @returns {number} 이동평균 값
 */
export function calculateMA(candles, period) {
  if (candles.length < period) {
    throw new Error(`이동평균 계산을 위해서는 최소 ${period}개의 캔들이 필요합니다.`);
  }

  const prices = candles.slice(0, period).map(c => c.trade_price);
  return prices.reduce((sum, price) => sum + price, 0) / period;
}

/**
 * 골든크로스/데드크로스 확인
 * @param {Array} candles - 캔들 데이터 배열
 * @param {number} shortPeriod - 단기 이동평균 기간 (기본값: 5)
 * @param {number} longPeriod - 장기 이동평균 기간 (기본값: 20)
 * @returns {string} 'golden' | 'dead' | 'none'
 */
export function checkCrossover(candles, shortPeriod = 5, longPeriod = 20) {
  if (candles.length < longPeriod + 1) {
    return 'none';
  }

  const currentShortMA = calculateMA(candles, shortPeriod);
  const currentLongMA = calculateMA(candles, longPeriod);

  const prevShortMA = calculateMA(candles.slice(1), shortPeriod);
  const prevLongMA = calculateMA(candles.slice(1), longPeriod);

  // 골든크로스: 단기 이평선이 장기 이평선을 상향 돌파
  if (prevShortMA <= prevLongMA && currentShortMA > currentLongMA) {
    return 'golden';
  }

  // 데드크로스: 단기 이평선이 장기 이평선을 하향 돌파
  if (prevShortMA >= prevLongMA && currentShortMA < currentLongMA) {
    return 'dead';
  }

  return 'none';
}

/**
 * 거래량 분석
 * @param {Array} candles - 캔들 데이터 배열
 * @param {number} period - 비교 기간
 * @returns {Object} 거래량 분석 결과
 */
export function analyzeVolume(candles, period = 20) {
  if (candles.length < period) {
    return { isHighVolume: false, volumeRatio: 0 };
  }

  const currentVolume = candles[0].candle_acc_trade_volume;
  const avgVolume = candles
    .slice(1, period + 1)
    .reduce((sum, c) => sum + c.candle_acc_trade_volume, 0) / period;

  const volumeRatio = currentVolume / avgVolume;

  return {
    isHighVolume: volumeRatio > 1.5, // 평균의 1.5배 이상이면 고거래량
    volumeRatio: volumeRatio,
    currentVolume: currentVolume,
    averageVolume: avgVolume
  };
}

/**
 * 완료된 분봉 기준의 과매도 반등 확인
 *
 * Upbit 캔들은 최신 데이터가 앞에 오며, candles[0]은 아직 진행 중일 수
 * 있으므로 candles[1]과 candles[2]를 비교한다. 진행 중인 캔들로 신호를
 * 만들면 같은 캔들 안에서 신호가 되돌아가거나 재현되지 않는 문제가 있다.
 *
 * @param {Array} candles - 최신 데이터가 앞에 있는 캔들 배열
 * @param {Object} config - 반등 확인 설정
 * @returns {Object} 반등 상태와 신호 식별자
 */
/**
 * 라이브 완료-캔들 반등 평가 — 최신-first 캔들 배열을 받아 진행 중 캔들(0)을
 * 버리고, 가장 최근 완료 캔들을 공유 평가기(reboundSignal.js)에 넘긴다.
 * 결정 계약 자체는 decideReboundSignal이 소유하므로 백테스트와 드리프트하지
 * 않는다. 반환 shape는 라이브 호출자 계약을 유지한다(available:false 객체 +
 * OHLC 보조 필드 + nullable oversoldReferenceClose).
 */
export function calculateClosedCandleRebound(candles, config = {}) {
  const {
    rsiPeriod = 14,
    rsiOversold = 30,
    rsiOverbought = 70,
    oversoldLookback = 1,
    minReboundPercent = 0.15,
    minRsiRecovery = 2,
    minVolumeRatio = 0.8,
    volumeLookback = 20,
    minCloseStrength = 0.55,
    trendPeriod = 30,
    trendSlopeLookback = 3,
    minTrendSlopePercent = -0.5,
    requirePreviousHighBreak = false,
    maxSignalRangePercent = 0,
    minSignalRangePercent = 0,
    // Optional exhaustion guard. Zero keeps the existing lower-bound-only
    // rebound contract; positive values reject a candle that already moved
    // too far before the delayed entry can be confirmed.
    maxReboundPercent = 0,
    requireReboundBelowOverbought = false,
    signalProfile = 'rsi_rebound',
    bbPeriod = 20,
    bbStdDev = 2,
    emaPeriod = 20
  } = config;

  const resolved = {
    rsiPeriod,
    rsiOversold,
    rsiOverbought,
    oversoldLookback,
    minReboundPercent,
    minRsiRecovery,
    minVolumeRatio,
    volumeLookback,
    minCloseStrength,
    trendPeriod,
    trendSlopeLookback,
    minTrendSlopePercent,
    requirePreviousHighBreak,
    maxSignalRangePercent,
    minSignalRangePercent,
    maxReboundPercent,
    requireReboundBelowOverbought,
    signalProfile,
    bbPeriod,
    bbStdDev,
    emaPeriod
  };
  const noSignal = emptyReboundSignal(signalProfile);

  // 진행 중 캔들(0)을 제외한 완료 캔들에서 현재/직전 봉과 RSI를 계산한다.
  const closedCandles = Array.isArray(candles) ? candles.slice(1) : [];
  if (closedCandles.length < rsiPeriod + 2) {
    return noSignal;
  }

  const currentCandle = closedCandles[0];
  const previousCandle = closedCandles[1];
  const currentClose = Number(currentCandle?.trade_price);
  const previousClose = Number(previousCandle?.trade_price);
  const currentOpen = Number(currentCandle?.opening_price);
  const currentHigh = Number(currentCandle?.high_price);
  const currentLow = Number(currentCandle?.low_price);
  const previousHigh = Number(previousCandle?.high_price);
  const previousLow = Number(previousCandle?.low_price);

  if (![currentClose, previousClose, currentOpen].every(Number.isFinite) || previousClose <= 0) {
    return noSignal;
  }

  const chronological = closedCandles.slice().reverse();
  const rsiSeries = calculateRsiSeries(chronological, rsiPeriod);
  const index = chronological.length - 1;
  // 라이브 계약의 트렌드 평가 경계는 완료 캔들 개수 기준이므로
  // (length >= trendPeriod + trendSlopeLookback) index 기준으로는 1 빠르다.
  const point = computeReboundPoint(chronological, index, rsiSeries, resolved, {
    trendMinIndex: trendPeriod + trendSlopeLookback - 1
  });
  const decision = decideReboundSignal({ candles: chronological, index, point, rsiSeries, config: resolved });
  if (!decision) return noSignal;

  return {
    ...decision,
    oversoldReferenceClose: Number.isFinite(Number(decision.oversoldReference?.close))
      ? Number(decision.oversoldReference.close)
      : null,
    currentHigh: Number.isFinite(currentHigh) ? currentHigh : null,
    currentLow: Number.isFinite(currentLow) ? currentLow : null,
    previousHigh: Number.isFinite(previousHigh) ? previousHigh : null,
    previousLow: Number.isFinite(previousLow) ? previousLow : null
  };
}

/**
 * 종합 기술적 분석
 * @param {Array} candles - 캔들 데이터 배열
 * @param {Object} config - 설정 값
 * @returns {Object} 종합 분석 결과
 */
export function comprehensiveAnalysis(candles, config = {}) {
  const {
    rsiPeriod = 14,
    rsiOversold = 30,
    rsiOverbought = 70,
    oversoldLookback = 1,
    macdFast = 12,
    macdSlow = 26,
    macdSignal = 9,
    bbPeriod = 20,
    bbStdDev = 2,
    minReboundPercent = 0.15,
    minRsiRecovery = 2,
    minVolumeRatio = 0.8,
    volumeLookback = 20,
    minCloseStrength = 0.55,
    trendPeriod = 30,
    trendSlopeLookback = 3,
    minTrendSlopePercent = -0.5,
    requirePreviousHighBreak = false,
    maxSignalRangePercent = 0,
    minSignalRangePercent = 0,
    maxReboundPercent = 0,
    requireReboundBelowOverbought = false,
    signalProfile = 'rsi_rebound',
    emaPeriod = 20
  } = config;

  try {
    const rsi = calculateRSI(candles, rsiPeriod);
    const macd = calculateMACD(candles, macdFast, macdSlow, macdSignal);
    const bb = calculateBollingerBands(candles, bbPeriod, bbStdDev);
    const crossover = checkCrossover(candles);
    const volume = analyzeVolume(candles);
    const rebound = calculateClosedCandleRebound(candles, {
      rsiPeriod,
      rsiOversold,
      rsiOverbought,
      oversoldLookback,
      minReboundPercent,
      minRsiRecovery,
      minVolumeRatio,
      volumeLookback,
      minCloseStrength,
      trendPeriod,
      trendSlopeLookback,
      minTrendSlopePercent,
      requirePreviousHighBreak,
      maxSignalRangePercent,
      minSignalRangePercent,
      maxReboundPercent,
      requireReboundBelowOverbought,
      signalProfile,
      bbPeriod,
      bbStdDev,
      emaPeriod
    });

    // 매수/매도 신호 계산
    let buySignals = 0;
    let sellSignals = 0;

    // RSI 신호
    if (rsi < rsiOversold) buySignals++;
    if (rsi > rsiOverbought) sellSignals++;

    // MACD 신호
    if (macd.histogram > 0 && macd.macd > macd.signal) buySignals++;
    if (macd.histogram < 0 && macd.macd < macd.signal) sellSignals++;

    // 볼린저 밴드 신호
    if (bb.currentPrice < bb.lower) buySignals++;
    if (bb.currentPrice > bb.upper) sellSignals++;

    // 이동평균 교차 신호
    if (crossover === 'golden') buySignals += 2;
    if (crossover === 'dead') sellSignals += 2;

    // 거래량 가중치
    if (volume.isHighVolume) {
      buySignals *= 1.2;
      sellSignals *= 1.2;
    }

    return {
      indicators: {
        rsi: rsi.toFixed(2),
        macd: {
          macd: macd.macd.toFixed(2),
          signal: macd.signal.toFixed(2),
          histogram: macd.histogram.toFixed(2)
        },
        bollingerBands: {
          upper: bb.upper.toFixed(2),
          middle: bb.middle.toFixed(2),
          lower: bb.lower.toFixed(2),
          current: bb.currentPrice.toFixed(2)
        },
        crossover: crossover,
        volume: volume,
        rebound
      },
      signals: {
        buy: buySignals,
        sell: sellSignals,
        recommendation: buySignals > sellSignals ? 'BUY' :
                       sellSignals > buySignals ? 'SELL' : 'HOLD'
      }
    };
  } catch (error) {
    console.error('기술적 분석 중 오류:', error.message);
    return null;
  }
}
