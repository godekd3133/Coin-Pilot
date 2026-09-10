/**
 * 기술적 지표 계산 모듈
 */

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
    requireReboundBelowOverbought = false,
    signalProfile = 'rsi_rebound',
    bbPeriod = 20,
    bbStdDev = 2,
    emaPeriod = 20
  } = config;

  const noSignal = {
    available: false,
    oversold: false,
    previousWasOversold: false,
    oversoldCandleAge: null,
    oversoldRsi: null,
    oversoldReferenceClose: null,
    currentWasOversold: false,
    reboundConfirmed: false,
    bullishCandle: false,
    priceChangePercent: 0,
    reboundPriceChangePercent: 0,
    rsi: null,
    previousRsi: null,
    rsiRecovery: 0,
    currentClose: null,
    previousClose: null,
    referencePrice: null,
    volumeRatio: null,
    volumeConfirmed: false,
    signalRangePercent: null,
    volatilityConfirmed: false,
    signalRangeFloorConfirmed: false,
    closeStrength: null,
    closeStrengthConfirmed: false,
    trendSlopePercent: null,
    trendConfirmed: false,
    previousHighBreak: false,
    previousHighBreakConfirmed: false,
    signalProfile,
    profileConfirmed: false,
    momentumRsiConfirmed: false,
    reboundOverboughtConfirmed: false,
    momentumBreakoutConfirmed: false,
    bollingerReclaim: false,
    emaTrendConfirmed: false,
    rejectionReasons: [],
    signalKey: null,
    candleTime: null
  };

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

  let rsi;
  let previousRsi;
  try {
    rsi = calculateRSI(closedCandles, rsiPeriod);
    previousRsi = calculateRSI(closedCandles.slice(1), rsiPeriod);
  } catch {
    return noSignal;
  }

  const priceChangePercent = ((currentClose - previousClose) / previousClose) * 100;
  const immediateRsiRecovery = rsi - previousRsi;
  const bullishCandle = currentClose > currentOpen && currentClose > previousClose;
  const candleRange = currentHigh - currentLow;
  const configuredMaxSignalRangePercent = Number(maxSignalRangePercent);
  const configuredMinSignalRangePercent = Number(minSignalRangePercent);
  const signalRangePercent = previousClose > 0 && Number.isFinite(candleRange)
    ? (candleRange / previousClose) * 100
    : null;
  const volatilityConfirmed = !Number.isFinite(configuredMaxSignalRangePercent) ||
    configuredMaxSignalRangePercent <= 0 ||
    signalRangePercent === null ||
    signalRangePercent <= configuredMaxSignalRangePercent;
  const signalRangeFloorConfirmed = !Number.isFinite(configuredMinSignalRangePercent) ||
    configuredMinSignalRangePercent <= 0 ||
    signalRangePercent === null ||
    signalRangePercent >= configuredMinSignalRangePercent;
  const closeStrength = candleRange > 0 ? (currentClose - currentLow) / candleRange : 1;
  const currentVolume = Number(currentCandle?.candle_acc_trade_volume);
  const volumeHistory = closedCandles
    .slice(1, volumeLookback + 1)
    .map(candle => Number(candle?.candle_acc_trade_volume))
    .filter(Number.isFinite);
  const averageVolume = volumeHistory.length > 0
    ? volumeHistory.reduce((sum, volume) => sum + volume, 0) / volumeHistory.length
    : 0;
  const volumeRatio = Number.isFinite(currentVolume) && averageVolume > 0
    ? currentVolume / averageVolume
    : null;
  const volumeConfirmed = volumeRatio === null || volumeRatio >= minVolumeRatio;
  const closeStrengthConfirmed = closeStrength >= minCloseStrength;
  const previousHighBreak = Number.isFinite(previousHigh) && currentClose > previousHigh;
  const previousHighBreakConfirmed = !requirePreviousHighBreak || previousHighBreak;

  const band = candlesForBand => {
    const prices = candlesForBand.map(candle => Number(candle?.trade_price)).filter(Number.isFinite);
    if (prices.length < bbPeriod) return null;
    const middle = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const variance = prices.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) / prices.length;
    const deviation = Math.sqrt(variance);
    return { lower: middle - deviation * bbStdDev, upper: middle + deviation * bbStdDev };
  };
  const currentBand = band(closedCandles.slice(0, bbPeriod));
  const previousBand = band(closedCandles.slice(1, bbPeriod + 1));
  const bollingerReclaim = Boolean(
    currentBand && previousBand &&
    previousClose < previousBand.lower &&
    currentClose >= currentBand.lower &&
    currentClose > previousClose
  );

  const ema = candlesForEma => {
    const prices = candlesForEma.map(candle => Number(candle?.trade_price)).filter(Number.isFinite).reverse();
    if (prices.length < emaPeriod) return null;
    const multiplier = 2 / (emaPeriod + 1);
    let value = prices[0];
    for (let index = 1; index < prices.length; index += 1) {
      value = (prices[index] - value) * multiplier + value;
    }
    return value;
  };
  const currentEma = ema(closedCandles.slice(0, emaPeriod));
  const previousEma = ema(closedCandles.slice(1, emaPeriod + 1));
  const emaSlopePercent = currentEma && previousEma
    ? ((currentEma - previousEma) / previousEma) * 100
    : null;
  const emaTrendConfirmed = currentEma !== null && previousEma !== null &&
    currentClose >= currentEma && emaSlopePercent >= 0;
  const momentumRsiConfirmed = rsi < rsiOverbought;
  const reboundOverboughtConfirmed = !requireReboundBelowOverbought || rsi < rsiOverbought;
  const profileConfirmed = signalProfile === 'bb_reclaim'
    ? bollingerReclaim
    : signalProfile === 'trend_rebound'
      ? emaTrendConfirmed
      : signalProfile === 'momentum_breakout'
        ? emaTrendConfirmed && previousHighBreak && momentumRsiConfirmed
        : true;
  let trendSlopePercent = null;
  let trendConfirmed = true;
  if (closedCandles.length >= trendPeriod + trendSlopeLookback) {
    const currentTrendPrices = closedCandles
      .slice(0, trendPeriod)
      .map(candle => Number(candle?.trade_price))
      .filter(Number.isFinite);
    const previousTrendPrices = closedCandles
      .slice(trendSlopeLookback, trendSlopeLookback + trendPeriod)
      .map(candle => Number(candle?.trade_price))
      .filter(Number.isFinite);
    const currentTrendAverage = currentTrendPrices.reduce((sum, price) => sum + price, 0) / currentTrendPrices.length;
    const previousTrendAverage = previousTrendPrices.reduce((sum, price) => sum + price, 0) / previousTrendPrices.length;
    if (previousTrendAverage > 0 && currentTrendPrices.length > 0 && previousTrendPrices.length > 0) {
      trendSlopePercent = ((currentTrendAverage - previousTrendAverage) / previousTrendAverage) * 100;
      trendConfirmed = trendSlopePercent >= minTrendSlopePercent;
    }
  }
  const lookback = Math.max(1, Math.floor(Number(oversoldLookback) || 1));
  const oversoldCandidates = [];
  for (let offset = 1; offset <= lookback; offset += 1) {
    const candidateCandle = closedCandles[offset];
    if (!candidateCandle) continue;
    try {
      const candidateRsi = calculateRSI(closedCandles.slice(offset), rsiPeriod);
      if (candidateRsi <= rsiOversold) {
        oversoldCandidates.push({
          age: offset,
          rsi: candidateRsi,
          close: Number(candidateCandle?.trade_price)
        });
      }
    } catch {
      // The current RSI calculation already determines availability. A
      // shorter lookback slice may still be too short for this candidate.
    }
  }
  // Use the deepest RSI washout as the recovery reference. Ties prefer the
  // most recent candle so the signal cannot benefit from an unnecessarily old
  // low price.
  oversoldCandidates.sort((a, b) => a.rsi - b.rsi || a.age - b.age);
  const oversoldReference = oversoldCandidates[0] || null;
  const previousWasOversold = oversoldCandidates.length > 0;
  const currentWasOversold = rsi <= rsiOversold;
  const oversoldReferenceClose = Number(oversoldReference?.close);
  const reboundPriceChangePercent = Number.isFinite(oversoldReferenceClose) && oversoldReferenceClose > 0
    ? ((currentClose - oversoldReferenceClose) / oversoldReferenceClose) * 100
    : priceChangePercent;
  const rsiRecovery = oversoldReference ? rsi - oversoldReference.rsi : immediateRsiRecovery;
  const oversoldReboundConfirmed = previousWasOversold &&
    bullishCandle &&
    reboundPriceChangePercent >= minReboundPercent &&
    rsiRecovery >= minRsiRecovery &&
    volumeConfirmed &&
    volatilityConfirmed &&
    signalRangeFloorConfirmed &&
    closeStrengthConfirmed &&
    trendConfirmed &&
    previousHighBreakConfirmed &&
    reboundOverboughtConfirmed &&
    profileConfirmed;
  const momentumBreakoutConfirmed = signalProfile === 'momentum_breakout' &&
    bullishCandle &&
    priceChangePercent >= minReboundPercent &&
    momentumRsiConfirmed &&
    volumeConfirmed &&
    volatilityConfirmed &&
    closeStrengthConfirmed &&
    trendConfirmed &&
    previousHighBreak &&
    profileConfirmed;
  const reboundConfirmed = signalProfile === 'momentum_breakout'
    ? momentumBreakoutConfirmed
    : oversoldReboundConfirmed;

  const rejectionReasons = [];
  if (signalProfile !== 'momentum_breakout' && !previousWasOversold) rejectionReasons.push('previous_rsi_not_oversold');
  if (!bullishCandle) rejectionReasons.push('bullish_rebound_not_confirmed');
  if (signalProfile === 'momentum_breakout') {
    if (priceChangePercent < minReboundPercent) rejectionReasons.push('breakout_move_below_threshold');
    if (!momentumRsiConfirmed) rejectionReasons.push('rsi_overbought_blocked');
  } else {
    if (reboundPriceChangePercent < minReboundPercent) rejectionReasons.push('price_rebound_below_threshold');
    if (rsiRecovery < minRsiRecovery) rejectionReasons.push('rsi_recovery_below_threshold');
    if (!reboundOverboughtConfirmed) rejectionReasons.push('rsi_overbought_blocked');
  }
  if (!volumeConfirmed) rejectionReasons.push('volume_confirmation_failed');
  if (!volatilityConfirmed) rejectionReasons.push('signal_range_too_wide');
  if (!signalRangeFloorConfirmed) rejectionReasons.push('signal_range_too_narrow');
  if (!closeStrengthConfirmed) rejectionReasons.push('close_strength_failed');
  if (!trendConfirmed) rejectionReasons.push('trend_filter_failed');
  if (!previousHighBreakConfirmed) rejectionReasons.push('previous_high_break_failed');
  if (!profileConfirmed) rejectionReasons.push(`${signalProfile}_profile_failed`);

  const signalCandle = currentCandle;
  const candleTime = signalCandle?.candle_date_time_utc ||
    signalCandle?.candle_date_time_kst ||
    signalCandle?.timestamp ||
    null;

  return {
    available: true,
    oversold: previousWasOversold || currentWasOversold,
    previousWasOversold,
    oversoldCandleAge: oversoldReference?.age ?? null,
    oversoldRsi: oversoldReference?.rsi ?? null,
    oversoldReferenceClose: Number.isFinite(oversoldReferenceClose) ? oversoldReferenceClose : null,
    currentWasOversold,
    reboundConfirmed,
    bullishCandle,
    priceChangePercent,
    reboundPriceChangePercent,
    rsi,
    previousRsi,
    rsiRecovery,
    immediateRsiRecovery,
    currentClose,
    previousClose,
    currentHigh: Number.isFinite(currentHigh) ? currentHigh : null,
    currentLow: Number.isFinite(currentLow) ? currentLow : null,
    previousHigh: Number.isFinite(previousHigh) ? previousHigh : null,
    previousLow: Number.isFinite(previousLow) ? previousLow : null,
    referencePrice: currentClose,
    volumeRatio,
    volumeConfirmed,
    signalRangePercent,
    volatilityConfirmed,
    signalRangeFloorConfirmed,
    closeStrength,
    closeStrengthConfirmed,
    trendSlopePercent,
    trendConfirmed,
    previousHighBreak,
    previousHighBreakConfirmed,
    signalProfile,
    profileConfirmed,
    momentumRsiConfirmed,
    reboundOverboughtConfirmed,
    momentumBreakoutConfirmed,
    bollingerReclaim,
    emaTrendConfirmed,
    emaSlopePercent,
    rejectionReasons,
    signalKey: candleTime ? String(candleTime) : `${currentClose}:${previousClose}`,
    candleTime
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
