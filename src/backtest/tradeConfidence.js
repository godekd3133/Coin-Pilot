// 트레이드 수익률 통계 신뢰도 — one-sided t-gate와 샘플 집계.
// scalpingBacktest.js에서 추출; promotion gate가 아닌 진단/검증 증거이다.
import { number } from './numeric.js';

export const STATISTICAL_CONFIDENCE_LEVEL = 0.95;

export const ONE_SIDED_T_CRITICAL_95 = Object.freeze([
  0,
  6.314,
  2.920,
  2.353,
  2.132,
  2.015,
  1.943,
  1.895,
  1.860,
  1.833,
  1.812,
  1.796,
  1.782,
  1.771,
  1.761,
  1.753,
  1.746,
  1.740,
  1.734,
  1.729,
  1.725,
  1.721,
  1.717,
  1.714,
  1.711,
  1.708,
  1.706,
  1.703,
  1.701,
  1.699,
  1.697
]);

export function oneSidedTCritical95(sampleCount) {
  const degreesOfFreedom = Math.max(1, Math.floor(Number(sampleCount) || 0) - 1);
  if (degreesOfFreedom < 1) return null;
  return ONE_SIDED_T_CRITICAL_95[degreesOfFreedom] || 1.645;
}

export function tradeReturnPercent(trade) {
  const explicitProfitPercent = trade?.profitPercent;
  if (explicitProfitPercent !== null && explicitProfitPercent !== undefined &&
    Number.isFinite(Number(explicitProfitPercent))) {
    return Number(explicitProfitPercent);
  }
  const investAmount = Number(trade?.investAmount);
  const netProfit = Number(trade?.netProfit ?? trade?.profit ?? trade?.profitAmount);
  return Number.isFinite(investAmount) && investAmount > 0 && Number.isFinite(netProfit)
    ? (netProfit / investAmount) * 100
    : null;
}

export function isClosedTrade(trade) {
  return trade?.type === 'CLOSE' ||
    trade?.action === 'CLOSE' ||
    trade?.action === 'PARTIAL_CLOSE';
}

/**
 * Estimate a conservative one-sided lower confidence bound for the mean
 * closed-trade return. This is a screening guard, not a claim of statistical
 * independence or real-world profitability; the forward paper ledger and
 * exchange settlement remain separate acceptance lanes.
 */

export function calculateTradeReturnConfidence(trades = []) {
  const returns = (Array.isArray(trades) ? trades : [])
    .filter(isClosedTrade)
    .map(tradeReturnPercent)
    .filter(value => Number.isFinite(value));
  const sampleCount = returns.length;
  if (sampleCount === 0) {
    return {
      method: 'one_sided_t_mean',
      confidenceLevel: STATISTICAL_CONFIDENCE_LEVEL,
      sampleCount: 0,
      meanReturnPercent: null,
      standardDeviationPercent: null,
      standardErrorPercent: null,
      tCritical: null,
      lowerBoundPercent: null
    };
  }

  const meanReturnPercent = returns.reduce((sum, value) => sum + value, 0) / sampleCount;
  if (sampleCount < 2) {
    return {
      method: 'one_sided_t_mean',
      confidenceLevel: STATISTICAL_CONFIDENCE_LEVEL,
      sampleCount,
      meanReturnPercent,
      standardDeviationPercent: null,
      standardErrorPercent: null,
      tCritical: null,
      lowerBoundPercent: null
    };
  }

  const squaredDeviation = returns.reduce(
    (sum, value) => sum + Math.pow(value - meanReturnPercent, 2),
    0
  );
  const standardDeviationPercent = Math.sqrt(squaredDeviation / (sampleCount - 1));
  const standardErrorPercent = standardDeviationPercent / Math.sqrt(sampleCount);
  const tCritical = oneSidedTCritical95(sampleCount);
  return {
    method: 'one_sided_t_mean',
    confidenceLevel: STATISTICAL_CONFIDENCE_LEVEL,
    sampleCount,
    meanReturnPercent,
    standardDeviationPercent,
    standardErrorPercent,
    tCritical,
    lowerBoundPercent: meanReturnPercent - (tCritical * standardErrorPercent)
  };
}

/**
 * Evaluate the optional promotion confidence gate against one metrics object.
 * When `required` is false the result is explicitly marked as advisory so a
 * diagnostic study cannot be mistaken for a confidence-approved report.
 */

export function evaluateStatisticalConfidenceGate(
  metrics,
  {
    required = false,
    minimumTrades = 20,
    minimumLowerBoundPercent = 0
  } = {}
) {
  const confidence = metrics?.tradeReturnConfidence || calculateTradeReturnConfidence([]);
  const sampleCount = Number(confidence.sampleCount) || 0;
  const lowerBoundPercent = confidence.lowerBoundPercent === null || confidence.lowerBoundPercent === undefined
    ? null
    : Number.isFinite(Number(confidence.lowerBoundPercent))
    ? Number(confidence.lowerBoundPercent)
    : null;
  const normalizedMinimumTrades = Math.max(1, Math.floor(number(minimumTrades, 20)));
  const normalizedMinimumLowerBoundPercent = number(minimumLowerBoundPercent, 0);
  const passed = required !== true || (
    sampleCount >= normalizedMinimumTrades &&
    lowerBoundPercent !== null &&
    lowerBoundPercent >= normalizedMinimumLowerBoundPercent
  );
  return {
    required: required === true,
    method: confidence.method,
    confidenceLevel: confidence.confidenceLevel,
    minimumTrades: normalizedMinimumTrades,
    minimumLowerBoundPercent: normalizedMinimumLowerBoundPercent,
    sampleCount,
    meanReturnPercent: confidence.meanReturnPercent,
    lowerBoundPercent,
    passed
  };
}
