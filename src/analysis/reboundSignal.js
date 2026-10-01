/**
 * 과매도 반등 신호의 단일 평가기. 라이브(calculateClosedCandleRebound)와
 * 백테스트(calculateReboundAtIndex), 리서치 레인이 모두 여기의
 * 피처 생성 + 결정 계약을 공유한다.
 *
 * 입력 candles는 항상 시간순(오래된→최신)이며 index는 평가 대상의
 * "완료된" 캔들을 가리킨다. 라이브 어댑터가 최신-first 배열과
 * 진행 중 캔들 제거를 담당한다.
 *
 * 설정 기본값은 이 모듈에 두지 않는다 — 라이브와 백테스트의 기본값이
 * 의도적으로 다르므로(예: minVolumeRatio 0.8 vs 1.0) 호출자가 해석한
 * 설정을 넘긴다.
 */

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function getOpen(candle) {
  return number(candle?.opening_price, number(candle?.trade_price));
}

export function getClose(candle) {
  return number(candle?.trade_price, getOpen(candle));
}

export function getHigh(candle) {
  return number(candle?.high_price, Math.max(getOpen(candle), getClose(candle)));
}

export function getLow(candle) {
  return number(candle?.low_price, Math.min(getOpen(candle), getClose(candle)));
}

/**
 * Wilder RSI values for every chronological close. The live helper calculates
 * a full history slice for each signal; a backtest must reuse this series or
 * long walk-forward runs become needlessly quadratic.
 */
export function calculateRsiSeries(candles, period) {
  const prices = candles.map(getClose);
  const values = Array(prices.length).fill(null);
  if (prices.length < period + 1) return values;

  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const difference = prices[index] - prices[index - 1];
    if (difference >= 0) gains += difference;
    else losses -= difference;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  values[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

  for (let index = period + 1; index < prices.length; index += 1) {
    const difference = prices[index] - prices[index - 1];
    const currentGain = difference >= 0 ? difference : 0;
    const currentLoss = difference < 0 ? -difference : 0;
    avgGain = (avgGain * (period - 1) + currentGain) / period;
    avgLoss = (avgLoss * (period - 1) + currentLoss) / period;
    values[index] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
  }

  return values;
}

export function calculateBandAtIndex(closes, endIndex, period, stdDev) {
  const normalizedPeriod = Math.max(1, Math.floor(number(period, 20)));
  const startIndex = Math.max(0, endIndex - normalizedPeriod + 1);
  const length = endIndex - startIndex + 1;
  if (endIndex < 0 || length < normalizedPeriod) return null;

  let sum = 0;
  let squaredSum = 0;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const price = closes[index];
    sum += price;
  }
  const middle = sum / length;
  for (let index = startIndex; index <= endIndex; index += 1) {
    squaredSum += Math.pow(closes[index] - middle, 2);
  }
  const variance = squaredSum / length;
  const deviation = Math.sqrt(variance);
  return {
    lower: middle - deviation * stdDev,
    upper: middle + deviation * stdDev
  };
}

export function calculateWindowEma(closes, endIndex, period) {
  const normalizedPeriod = Math.max(1, Math.floor(number(period, 20)));
  const startIndex = Math.max(0, endIndex - normalizedPeriod + 1);
  const length = endIndex - startIndex + 1;
  if (endIndex < 0 || length < normalizedPeriod) return null;

  const multiplier = 2 / (normalizedPeriod + 1);
  let value = closes[startIndex];
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    value = (closes[index] - value) * multiplier + value;
  }
  return value;
}

/**
 * 캔들-로컬 피처의 표준 생성기. backtest의 featureSet.points[index]와
 * 정확히 같은 shape를 만든다 — 캐시된 producer는 같은 필드를 prefix-sum으로
 * 최적화해 생산하고, 이 함수는 단일 index의 비캐시 경로(라이브 포함)다.
 *
 * trendMinIndex: 트렌드 평가를 시작하는 최소 index. 백테스트 계약은
 * `trendPeriod + trendSlopeLookback`, 라이브 계약은 그보다 1 빠르다
 * (라이브는 캔들 개수 기준 `length >= trendPeriod + trendSlopeLookback`).
 */
export function computeReboundPoint(candles, index, rsiSeries, config, { trendMinIndex } = {}) {
  const currentCandle = candles[index];
  const previousCandle = candles[index - 1];
  const currentClose = getClose(currentCandle);
  const previousClose = getClose(previousCandle);
  const currentOpen = getOpen(currentCandle);
  const currentHigh = getHigh(currentCandle);
  const currentLow = getLow(currentCandle);
  const candleRange = currentHigh - currentLow;
  const priceChangePercent = previousClose > 0
    ? ((currentClose - previousClose) / previousClose) * 100
    : null;
  const signalRangePercent = previousClose > 0 && Number.isFinite(candleRange)
    ? (candleRange / previousClose) * 100
    : null;
  const closeStrength = candleRange > 0 ? (currentClose - currentLow) / candleRange : 1;

  const currentVolume = number(currentCandle?.candle_acc_trade_volume, NaN);
  const volumeLookback = Math.max(1, Math.floor(number(config.volumeLookback, 20)));
  const volumeHistory = candles
    .slice(Math.max(0, index - volumeLookback), index)
    .map(candle => number(candle?.candle_acc_trade_volume, NaN))
    .filter(Number.isFinite);
  const averageVolume = volumeHistory.length > 0
    ? volumeHistory.reduce((sum, volume) => sum + volume, 0) / volumeHistory.length
    : 0;
  const volumeRatio = Number.isFinite(currentVolume) && averageVolume > 0
    ? currentVolume / averageVolume
    : null;

  const previousHigh = getHigh(previousCandle);
  const bullishCandle = index > 0 && currentClose > currentOpen && currentClose > previousClose;

  let trendSlopePercent = null;
  let trendConfirmed = true;
  const trendPeriod = Math.max(1, Math.floor(number(config.trendPeriod, 30)));
  const trendSlopeLookback = Math.max(1, Math.floor(number(config.trendSlopeLookback, 3)));
  const effectiveTrendMinIndex = trendMinIndex ?? (trendPeriod + trendSlopeLookback);
  if (index >= effectiveTrendMinIndex) {
    const currentTrendPrices = candles
      .slice(index - trendPeriod + 1, index + 1)
      .map(getClose);
    const previousTrendPrices = candles
      .slice(index - trendSlopeLookback - trendPeriod + 1, index - trendSlopeLookback + 1)
      .map(getClose);
    const currentTrendAverage = currentTrendPrices.reduce((sum, price) => sum + price, 0) / currentTrendPrices.length;
    const previousTrendAverage = previousTrendPrices.reduce((sum, price) => sum + price, 0) / previousTrendPrices.length;
    if (previousTrendAverage > 0) {
      trendSlopePercent = ((currentTrendAverage - previousTrendAverage) / previousTrendAverage) * 100;
      trendConfirmed = trendSlopePercent >= config.minTrendSlopePercent;
    }
  }

  const bbPeriod = Math.max(1, Math.floor(number(config.bbPeriod, 20)));
  const bbStdDev = number(config.bbStdDev, 2);
  const closes = candles.map(getClose);
  const currentBand = calculateBandAtIndex(closes, index, bbPeriod, bbStdDev);
  const previousBand = calculateBandAtIndex(closes, index - 1, bbPeriod, bbStdDev);
  const bollingerReclaim = Boolean(
    currentBand && previousBand &&
    previousClose < previousBand.lower &&
    currentClose >= currentBand.lower &&
    currentClose > previousClose
  );

  const emaPeriod = Math.max(1, Math.floor(number(config.emaPeriod, 20)));
  const currentEma = calculateWindowEma(closes, index, emaPeriod);
  const previousEma = calculateWindowEma(closes, index - 1, emaPeriod);
  const emaSlopePercent = currentEma && previousEma
    ? ((currentEma - previousEma) / previousEma) * 100
    : null;
  const emaTrendConfirmed = currentEma !== null && previousEma !== null &&
    currentClose >= currentEma && emaSlopePercent >= 0;

  return {
    currentClose,
    previousClose,
    currentOpen,
    currentHigh,
    currentLow,
    priceChangePercent,
    signalRangePercent,
    closeStrength,
    currentVolume,
    averageVolume,
    volumeRatio,
    previousHigh,
    bullishCandle,
    trendSlopePercent,
    trendConfirmed,
    currentBand,
    previousBand,
    bollingerReclaim,
    currentEma,
    previousEma,
    emaSlopePercent,
    emaTrendConfirmed,
    rsi: rsiSeries[index],
    previousRsi: index > 0 ? rsiSeries[index - 1] : null
  };
}

/**
 * 신호 결정 계약의 단일 구현. 피처(캐시 여부 무관)와 RSI 시리즈를 받아
 * 과매도 참조, 반등/모멘텀 확정, 거부 사유, 결과 객체를 만든다.
 * RSI/이전 종가를 얻을 수 없으면 null을 반환한다 (라이브의 noSignal 경계와
 * 백테스트의 null 경계가 같다).
 */
export function decideReboundSignal({ candles, index, point, rsiSeries, config }) {
  const currentCandle = candles[index];
  const rsi = point.rsi;
  const previousRsi = point.previousRsi;
  const previousClose = point.previousClose;
  const currentClose = point.currentClose;

  if (!Number.isFinite(rsi) || !Number.isFinite(previousRsi) || previousClose <= 0) {
    return null;
  }

  const priceChangePercent = point.priceChangePercent;
  const immediateRsiRecovery = rsi - previousRsi;
  const bullishCandle = point.bullishCandle;
  const configuredMaxSignalRangePercent = Number(config.maxSignalRangePercent);
  const configuredMinSignalRangePercent = Number(config.minSignalRangePercent);
  const signalRangePercent = point.signalRangePercent;
  const volatilityConfirmed = !Number.isFinite(configuredMaxSignalRangePercent) ||
    configuredMaxSignalRangePercent <= 0 ||
    signalRangePercent === null ||
    signalRangePercent <= configuredMaxSignalRangePercent;
  const signalRangeFloorConfirmed = !Number.isFinite(configuredMinSignalRangePercent) ||
    configuredMinSignalRangePercent <= 0 ||
    signalRangePercent === null ||
    signalRangePercent >= configuredMinSignalRangePercent;
  const closeStrength = point.closeStrength;
  const volumeRatio = point.volumeRatio;
  const volumeConfirmed = volumeRatio === null || volumeRatio >= config.minVolumeRatio;
  const closeStrengthConfirmed = closeStrength >= config.minCloseStrength;
  const previousHigh = point.previousHigh;
  const previousHighBreak = currentClose > previousHigh;
  const previousHighBreakConfirmed = !config.requirePreviousHighBreak || previousHighBreak;
  const bollingerReclaim = point.bollingerReclaim;
  const emaSlopePercent = point.emaSlopePercent;
  const emaTrendConfirmed = point.emaTrendConfirmed;
  const momentumRsiConfirmed = rsi < config.rsiOverbought;
  const profileConfirmed = config.signalProfile === 'bb_reclaim'
    ? bollingerReclaim
    : config.signalProfile === 'trend_rebound'
      ? emaTrendConfirmed
      : config.signalProfile === 'momentum_breakout'
        ? emaTrendConfirmed && previousHighBreak && momentumRsiConfirmed
        : true;
  const trendSlopePercent = point.trendSlopePercent;
  const trendConfirmed = trendSlopePercent === null || trendSlopePercent >= config.minTrendSlopePercent;

  const lookback = Math.max(1, Math.floor(number(config.oversoldLookback, 1)));
  const oversoldCandidates = [];
  for (let offset = 1; offset <= lookback; offset += 1) {
    const candidateRsi = rsiSeries[index - offset];
    const candidateCandle = candles[index - offset];
    if (Number.isFinite(candidateRsi) && candidateRsi <= config.rsiOversold && candidateCandle) {
      oversoldCandidates.push({
        age: offset,
        rsi: candidateRsi,
        close: getClose(candidateCandle)
      });
    }
  }
  oversoldCandidates.sort((a, b) => a.rsi - b.rsi || a.age - b.age);
  const oversoldReference = oversoldCandidates[0] || null;
  const previousWasOversold = oversoldCandidates.length > 0;
  const currentWasOversold = rsi <= config.rsiOversold;
  const oversoldReferenceClose = number(oversoldReference?.close, previousClose);
  const reboundPriceChangePercent = oversoldReferenceClose > 0
    ? ((currentClose - oversoldReferenceClose) / oversoldReferenceClose) * 100
    : priceChangePercent;
  const rsiRecovery = oversoldReference ? rsi - oversoldReference.rsi : immediateRsiRecovery;
  const configuredMaxReboundPercent = Number(config.maxReboundPercent);
  const reboundCeilingConfirmed = config.signalProfile === 'momentum_breakout' ||
    !Number.isFinite(configuredMaxReboundPercent) ||
    configuredMaxReboundPercent <= 0 ||
    reboundPriceChangePercent <= configuredMaxReboundPercent;
  const reboundOverboughtConfirmed = config.requireReboundBelowOverbought !== true || rsi < config.rsiOverbought;
  const candleTime = currentCandle?.candle_date_time_utc || currentCandle?.candle_date_time_kst || currentCandle?.timestamp || null;
  const oversoldReboundConfirmed = previousWasOversold && bullishCandle &&
    reboundPriceChangePercent >= config.minReboundPercent &&
    rsiRecovery >= config.minRsiRecovery &&
    volumeConfirmed && volatilityConfirmed && signalRangeFloorConfirmed && closeStrengthConfirmed && trendConfirmed && previousHighBreakConfirmed &&
    reboundOverboughtConfirmed && reboundCeilingConfirmed && profileConfirmed;
  const momentumBreakoutConfirmed = config.signalProfile === 'momentum_breakout' &&
    bullishCandle &&
    priceChangePercent >= config.minReboundPercent &&
    momentumRsiConfirmed &&
    volumeConfirmed && volatilityConfirmed && signalRangeFloorConfirmed && closeStrengthConfirmed && trendConfirmed &&
    previousHighBreak && profileConfirmed;
  const reboundConfirmed = config.signalProfile === 'momentum_breakout'
    ? momentumBreakoutConfirmed
    : oversoldReboundConfirmed;

  const rejectionReasons = [];
  if (config.signalProfile !== 'momentum_breakout' && !previousWasOversold) rejectionReasons.push('previous_rsi_not_oversold');
  if (!bullishCandle) rejectionReasons.push('bullish_rebound_not_confirmed');
  if (config.signalProfile === 'momentum_breakout') {
    if (priceChangePercent < config.minReboundPercent) rejectionReasons.push('breakout_move_below_threshold');
    if (!momentumRsiConfirmed) rejectionReasons.push('rsi_overbought_blocked');
  } else {
    if (reboundPriceChangePercent < config.minReboundPercent) rejectionReasons.push('price_rebound_below_threshold');
    if (!reboundCeilingConfirmed) rejectionReasons.push('price_rebound_above_threshold');
    if (rsiRecovery < config.minRsiRecovery) rejectionReasons.push('rsi_recovery_below_threshold');
    if (!reboundOverboughtConfirmed) rejectionReasons.push('rsi_overbought_blocked');
  }
  if (!volumeConfirmed) rejectionReasons.push('volume_confirmation_failed');
  if (!volatilityConfirmed) rejectionReasons.push('signal_range_too_wide');
  if (!signalRangeFloorConfirmed) rejectionReasons.push('signal_range_too_narrow');
  if (!closeStrengthConfirmed) rejectionReasons.push('close_strength_failed');
  if (!trendConfirmed) rejectionReasons.push('trend_filter_failed');
  if (!previousHighBreakConfirmed) rejectionReasons.push('previous_high_break_failed');
  if (!profileConfirmed) rejectionReasons.push(`${config.signalProfile}_profile_failed`);

  return {
    available: true,
    oversold: previousWasOversold || currentWasOversold,
    previousWasOversold,
    currentWasOversold,
    reboundConfirmed,
    bullishCandle,
    priceChangePercent,
    reboundPriceChangePercent,
    rsi,
    previousRsi,
    rsiRecovery,
    immediateRsiRecovery,
    oversoldReference,
    oversoldCandleAge: oversoldReference?.age ?? null,
    oversoldRsi: oversoldReference?.rsi ?? null,
    oversoldReferenceClose,
    currentClose,
    previousClose,
    volumeRatio,
    volumeConfirmed,
    signalRangePercent,
    volatilityConfirmed,
    signalRangeFloorConfirmed,
    reboundCeilingConfirmed,
    closeStrength,
    closeStrengthConfirmed,
    trendSlopePercent,
    trendConfirmed,
    previousHighBreak,
    previousHighBreakConfirmed,
    signalProfile: config.signalProfile,
    profileConfirmed,
    momentumRsiConfirmed,
    reboundOverboughtConfirmed,
    momentumBreakoutConfirmed,
    bollingerReclaim,
    emaTrendConfirmed,
    emaSlopePercent,
    rejectionReasons,
    referencePrice: currentClose,
    signalKey: candleTime ? String(candleTime) : `${currentClose}:${previousClose}`,
    candleTime
  };
}

/**
 * 라이브 경로의 "데이터 부족" 결과 템플릿 — available:false로 전체 필드를
 * 기본값 채운다. 백테스트는 같은 경계를 null로 표현하므로 어댑터가 매핑한다.
 */
export function emptyReboundSignal(signalProfile = 'rsi_rebound') {
  return {
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
    reboundCeilingConfirmed: false,
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
}
