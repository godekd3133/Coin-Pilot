// 스캘핑 튜닝 + 워크포워드 검증 — 그리드 확장, 후보 선택, 폴드 검증.
// scalpingBacktest.js에서 추출; 시뮬레이션 코어를 소비한다(역방향 의존 없음).
import { number } from './numeric.js';
import {
  analyzeHistoricalCandleContinuity,
  normalizeHistoricalCandles
} from './historicalCandleIntegrity.js';
import { evaluateStatisticalConfidenceGate } from './tradeConfidence.js';
import {
  DEFAULT_CONFIG,
  createScalpingFeatureCache,
  simulateScalping,
  requiresHistoricalCandleContinuity,
} from './scalpingBacktest.js';
import { marketEntries, simulateScalpingPortfolio } from './scalpingPortfolioSimulation.js';

export function expandGrid(baseConfig, grid) {
  const keys = Object.keys(grid);
  return keys.reduce((configs, key) => {
    const values = Array.isArray(grid[key]) ? grid[key] : [grid[key]];
    return configs.flatMap(config => values.map(value => ({ ...config, [key]: value })));
  }, [{ ...baseConfig }]);
}

export function configFingerprint(config) {
  return JSON.stringify(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Optionally take a deterministic, evenly spaced research sample from the
 * Cartesian grid. The full grid remains the default. A capped sample always
 * includes the actual base configuration so a quick study cannot silently
 * omit the runtime contract; reports expose both pool and selected counts.
 */

export function selectTuningCandidates(candidates, baseConfig, maxCandidates = 0) {
  const poolCount = candidates.length;
  const requestedLimit = Math.floor(number(maxCandidates, 0));
  if (requestedLimit <= 0 || requestedLimit >= poolCount) {
    return {
      candidates,
      candidatePoolCount: poolCount,
      candidateSelectionLimited: false
    };
  }

  const limit = Math.max(1, requestedLimit);
  const selected = [];
  const seen = new Set();
  const add = candidate => {
    const fingerprint = configFingerprint(candidate);
    if (seen.has(fingerprint) || selected.length >= limit) return;
    seen.add(fingerprint);
    selected.push(candidate);
  };
  add({ ...DEFAULT_CONFIG, ...baseConfig });
  if (limit > selected.length) {
    for (let offset = 0; offset < poolCount && selected.length < limit; offset += 1) {
      const index = limit === 1
        ? 0
        : Math.round((offset * (poolCount - 1)) / Math.max(1, limit - 2));
      add(candidates[Math.min(poolCount - 1, index)]);
    }
  }
  return {
    candidates: selected,
    candidatePoolCount: poolCount,
    candidateSelectionLimited: true
  };
}

export function selectBestTuningResult(ranked, minimumTradeCount = 0) {
  const requestedMinimum = Math.max(0, Math.floor(number(minimumTradeCount, 0)));
  const eligible = requestedMinimum > 0
    ? ranked.filter(candidate => candidate.metrics.tradeCount >= requestedMinimum)
    : ranked;
  const selectionPool = eligible.length > 0 ? eligible : ranked;
  const best = selectionPool[0] || null;
  return {
    best,
    minimumTradeCount: requestedMinimum,
    eligibleCandidateCount: eligible.length,
    minimumTradeFallback: requestedMinimum > 0 && eligible.length === 0
  };
}

export const DEFAULT_TUNING_GRID = {
  signalProfile: ['rsi_rebound', 'bb_reclaim', 'trend_rebound'],
  rsiOversold: [25, 30, 35],
  // Compare the original immediate-candle contract with a short reaction
  // window; do not assume a longer lookback is automatically better.
  oversoldLookback: [1, 3],
  minReboundPercent: [0.1, 0.25, 0.5],
  minRsiRecovery: [1, 2],
  // Forward shadow losses were concentrated in rejected low-volume
  // candidates. Explore a stricter 1.5x cohort, but keep live default at 1.0
  // until a complete holdout passes.
  minVolumeRatio: [0.8, 1, 1.5],
  minCloseStrength: [0.65, 0.8],
  minTrendSlopePercent: [-0.5, 0],
  // The live default remains strict=true, but validation must also test the
  // relaxed candidate instead of assuming that the high-break filter helps.
  requirePreviousHighBreak: [false, true],
  stopLossPercent: [0.8, 1.2],
  // Include sub-1.5% targets in research; trading costs make the target
  // distance itself a material hypothesis for short-lived rebounds.
  takeProfitPercent: [1, 1.2, 1.5, 2.5],
  // Protection candidates are intentionally absent from the default tuning
  // grid until a dedicated holdout study proves they generalize.
  breakEvenTriggerPercent: [0],
  trailingActivationPercent: [0],
  trailingStopPercent: [0]
};

/**
 * Tune only on the supplied training segment. The caller must evaluate the
 * selected config on a later holdout segment before promoting it.
 */

export function tuneScalpingParameters(candles, baseConfig = {}, grid = DEFAULT_TUNING_GRID, tuningOptions = {}) {
  const candidateSelection = selectTuningCandidates(
    expandGrid({ ...DEFAULT_CONFIG, ...baseConfig }, grid),
    baseConfig,
    tuningOptions.maxCandidates
  );
  const candidates = candidateSelection.candidates;
  const featureCache = createScalpingFeatureCache(candles);
  const ranked = [];

  for (const candidate of candidates) {
    const result = simulateScalping(candles, candidate, { featureCache });
    ranked.push({ config: candidate, metrics: result.metrics, result });
  }

  ranked.sort((a, b) => b.metrics.qualityScore - a.metrics.qualityScore);
  const selection = selectBestTuningResult(ranked, tuningOptions.minimumTradeCount);
  return {
    candidateCount: candidates.length,
    candidatePoolCount: candidateSelection.candidatePoolCount,
    candidateSelectionLimited: candidateSelection.candidateSelectionLimited,
    best: selection.best
      ? { config: selection.best.config, result: selection.best.result }
      : null,
    minimumTradeCount: selection.minimumTradeCount,
    eligibleCandidateCount: selection.eligibleCandidateCount,
    minimumTradeFallback: selection.minimumTradeFallback,
    topCandidates: ranked.slice(0, 10).map(({ config, metrics }) => ({ config, metrics }))
  };
}

/**
 * Tune a shared portfolio on one common training window. This deliberately
 * reuses the same candidate grid as the per-market study only when the caller
 * asks for it; portfolio runs can pass a smaller research grid to keep the
 * cross-market study bounded.
 */

export function tuneScalpingPortfolioParameters(candlesByMarket, baseConfig = {}, grid = DEFAULT_TUNING_GRID, tuningOptions = {}) {
  const candidateSelection = selectTuningCandidates(
    expandGrid({ ...DEFAULT_CONFIG, ...baseConfig }, grid),
    baseConfig,
    tuningOptions.maxCandidates
  );
  const candidates = candidateSelection.candidates;
  const featureCacheByMarket = Object.fromEntries(
    marketEntries(candlesByMarket)
      .map(([market, candles]) => [market, createScalpingFeatureCache(candles)])
  );
  const ranked = [];

  for (const candidate of candidates) {
    const result = simulateScalpingPortfolio(candlesByMarket, candidate, { featureCacheByMarket });
    ranked.push({ config: candidate, metrics: result.metrics, result });
  }

  ranked.sort((a, b) => b.metrics.qualityScore - a.metrics.qualityScore);
  const selection = selectBestTuningResult(ranked, tuningOptions.minimumTradeCount);
  return {
    candidateCount: candidates.length,
    candidatePoolCount: candidateSelection.candidatePoolCount,
    candidateSelectionLimited: candidateSelection.candidateSelectionLimited,
    best: selection.best
      ? { config: selection.best.config, result: selection.best.result }
      : null,
    minimumTradeCount: selection.minimumTradeCount,
    eligibleCandidateCount: selection.eligibleCandidateCount,
    minimumTradeFallback: selection.minimumTradeFallback,
    topCandidates: ranked.slice(0, 10).map(({ config, metrics }) => ({ config, metrics }))
  };
}

/**
 * Walk-forward validation for the shared portfolio lane. It is intentionally
 * separate from walkForwardValidate(): a passing portfolio result is useful
 * evidence about allocation and selection, but never authorizes live orders.
 */

export function walkForwardValidatePortfolio(rawCandlesByMarket, baseConfig = {}, options = {}) {
  const entries = marketEntries(rawCandlesByMarket)
    .map(([market, candles]) => [String(market), normalizeHistoricalCandles(candles)])
    .filter(([, candles]) => candles.length > 0);
  const resolvedConfig = { ...DEFAULT_CONFIG, ...baseConfig };
  const marketCount = entries.length;
  if (marketCount === 0) {
    return {
      promoted: false,
      reason: 'insufficient_markets:0',
      marketCount: 0,
      candleCount: 0
    };
  }

  const dataQualityByMarket = Object.fromEntries(entries.map(([market, candles]) => [
    market,
    analyzeHistoricalCandleContinuity(candles, resolvedConfig.candleUnit, {
      maxGapSeconds: options.maxHistoricalCandleGapSeconds ?? resolvedConfig.maxHistoricalCandleGapSeconds
    })
  ]));
  const invalidMarkets = entries
    .filter(([market]) => dataQualityByMarket[market]?.valid !== true)
    .map(([market]) => market);
  const dataQuality = {
    valid: invalidMarkets.length === 0,
    reason: invalidMarkets.length === 0
      ? 'historical_candles_contiguous'
      : 'historical_candle_continuity_failed',
    marketCount,
    invalidMarkets,
    byMarket: dataQualityByMarket
  };
  if (requiresHistoricalCandleContinuity(resolvedConfig, options) && invalidMarkets.length > 0) {
    return {
      promoted: false,
      reason: 'historical_candle_continuity_failed',
      marketCount,
      candleCount: Math.min(...entries.map(([, candles]) => candles.length)),
      dataQuality
    };
  }

  const shortestCandleCount = Math.min(...entries.map(([, candles]) => candles.length));
  const minimumCandles = options.minimumCandles ?? 120;
  if (shortestCandleCount < minimumCandles) {
    return {
      promoted: false,
      reason: `insufficient_candles:${shortestCandleCount}<${minimumCandles}`,
      marketCount,
      candleCount: shortestCandleCount
    };
  }

  const trainRatio = options.trainRatio ?? 0.7;
  const splitIndex = Math.max(
    Math.floor(shortestCandleCount * trainRatio),
    resolvedConfig.rsiPeriod + resolvedConfig.volumeLookback + resolvedConfig.trendPeriod + 5
  );
  if (splitIndex >= shortestCandleCount - 5) {
    return {
      promoted: false,
      reason: 'holdout_segment_too_small',
      marketCount,
      candleCount: shortestCandleCount
    };
  }

  const training = Object.fromEntries(entries.map(([market, candles]) => [market, candles.slice(0, splitIndex)]));
  const tuning = tuneScalpingPortfolioParameters(
    training,
    resolvedConfig,
    options.grid || DEFAULT_TUNING_GRID,
    {
      maxCandidates: options.maxTuningCandidates,
      minimumTradeCount: options.minimumTuningTrades ?? (
        options.requireStatisticalConfidence === true
          ? options.minimumTrainingConfidenceTrades ?? 10
          : options.minimumTrainingTrades ?? 3
      )
    }
  );
  const warmupLength = Math.min(
    splitIndex,
    Math.max(
      200,
      resolvedConfig.rsiPeriod + resolvedConfig.oversoldLookback + 2,
      resolvedConfig.volumeLookback + 2,
      resolvedConfig.trendPeriod + resolvedConfig.trendSlopeLookback + 2,
      resolvedConfig.bbPeriod + 2,
      resolvedConfig.emaPeriod + 2
    )
  );
  const validationCandles = Object.fromEntries(entries.map(([market, candles]) => [
    market,
    [...candles.slice(splitIndex - warmupLength, splitIndex), ...candles.slice(splitIndex)]
  ]));
  const validation = simulateScalpingPortfolio(
    validationCandles,
    tuning.best.config,
    { startTradingIndex: warmupLength }
  );
  const trainingMetrics = tuning.best.result.metrics;
  const minimumTrainingTrades = options.minimumTrainingTrades ?? 3;
  const minimumTrainingProfitFactor = options.minimumTrainingProfitFactor ?? 1;
  const minimumTrainingReturnPercent = options.minimumTrainingReturnPercent ?? 0;
  const requireStatisticalConfidence = options.requireStatisticalConfidence === true;
  const minimumTrainingConfidenceTrades = options.minimumTrainingConfidenceTrades ?? 10;
  const minimumValidationConfidenceTrades = options.minimumValidationConfidenceTrades ?? 20;
  const minimumConfidenceLowerBoundPercent = options.minimumConfidenceLowerBoundPercent ?? 0;
  const trainingConfidenceGate = evaluateStatisticalConfidenceGate(trainingMetrics, {
    required: requireStatisticalConfidence,
    minimumTrades: minimumTrainingConfidenceTrades,
    minimumLowerBoundPercent: minimumConfidenceLowerBoundPercent
  });
  const trainingGatePassed = trainingMetrics.tradeCount >= minimumTrainingTrades &&
    trainingMetrics.totalReturnPercent >= minimumTrainingReturnPercent &&
    trainingMetrics.profitFactor >= minimumTrainingProfitFactor &&
    trainingConfidenceGate.passed;
  const minimumValidationTrades = options.minimumValidationTrades ?? 10;
  const minimumProfitFactor = options.minimumProfitFactor ?? 1.05;
  const minimumReturnPercent = options.minimumReturnPercent ?? 0.1;
  const maximumDrawdownPercent = options.maximumDrawdownPercent ?? 15;
  const validationMetrics = validation.metrics;
  const validationConfidenceGate = evaluateStatisticalConfidenceGate(validationMetrics, {
    required: requireStatisticalConfidence,
    minimumTrades: minimumValidationConfidenceTrades,
    minimumLowerBoundPercent: minimumConfidenceLowerBoundPercent
  });
  const validationGatePassed = validationMetrics.tradeCount >= minimumValidationTrades &&
    validationMetrics.totalReturnPercent >= minimumReturnPercent &&
    validationMetrics.profitFactor >= minimumProfitFactor &&
    validationMetrics.maxDrawdownPercent <= maximumDrawdownPercent &&
    validationConfidenceGate.passed;

  return {
    promoted: trainingGatePassed && validationGatePassed,
    reason: trainingGatePassed && validationGatePassed
      ? 'portfolio_walk_forward_gate_passed_diagnostic_only'
      : !trainingGatePassed
        ? requireStatisticalConfidence && !trainingConfidenceGate.passed
          ? 'training_confidence_gate_failed'
          : 'training_gate_failed'
        : requireStatisticalConfidence && !validationConfidenceGate.passed
          ? 'validation_confidence_gate_failed'
          : 'portfolio_walk_forward_gate_failed',
    marketCount,
    candleCount: shortestCandleCount,
    trainCandleCount: splitIndex,
    holdoutCandleCount: shortestCandleCount - splitIndex,
    validationWarmupCandleCount: warmupLength,
    tuning: {
      candidateCount: tuning.candidateCount,
      candidatePoolCount: tuning.candidatePoolCount,
      candidateSelectionLimited: tuning.candidateSelectionLimited,
      minimumTradeCount: tuning.minimumTradeCount,
      eligibleCandidateCount: tuning.eligibleCandidateCount,
      minimumTradeFallback: tuning.minimumTradeFallback,
      bestConfig: tuning.best.config,
      metrics: trainingMetrics
    },
    validation: validationMetrics,
    gate: {
      minimumTrainingTrades,
      minimumTrainingProfitFactor,
      minimumTrainingReturnPercent,
      trainingGatePassed,
      minimumValidationTrades,
      minimumProfitFactor,
      minimumReturnPercent,
      maximumDrawdownPercent,
      statisticalConfidence: {
        required: requireStatisticalConfidence,
        method: 'one_sided_t_mean',
        confidenceLevel: 0.95,
        minimumTrainingTrades: trainingConfidenceGate.minimumTrades,
        minimumValidationTrades: validationConfidenceGate.minimumTrades,
        minimumLowerBoundPercent: trainingConfidenceGate.minimumLowerBoundPercent,
        training: trainingConfidenceGate,
        validation: validationConfidenceGate
      }
    },
    selection: {
      skippedEntries: validation.skippedEntries,
      circuitBlockedEntries: validationMetrics.circuitBlockedEntries,
      circuitBreaks: validationMetrics.circuitBreaks,
      marketRegimeBlockedEntries: validationMetrics.marketRegimeBlockedEntries,
      signalWindowBlockedEntries: validationMetrics.signalWindowBlockedEntries,
      volatilityScaledEntries: validationMetrics.volatilityScaledEntries,
      volatilityBlockedEntries: validationMetrics.volatilityBlockedEntries
    },
    dataQuality,
    promotion: 'diagnostic_only_never_authorizes_live_orders'
  };
}

/**
 * Run expanding-window portfolio validation over several future folds. A
 * candidate must pass every fold to be considered robust in this diagnostic
 * lane; a single favorable holdout is never enough.
 */

export function walkForwardValidatePortfolioFolds(rawCandlesByMarket, baseConfig = {}, options = {}) {
  const entries = marketEntries(rawCandlesByMarket)
    .map(([market, candles]) => [String(market), normalizeHistoricalCandles(candles)])
    .filter(([, candles]) => candles.length > 0);
  const foldCount = Math.max(2, Math.floor(number(options.foldCount, 3)));
  const initialTrainRatio = Math.max(0.3, Math.min(0.8, number(options.initialTrainRatio, 0.5)));
  const shortestCandleCount = entries.length > 0
    ? Math.min(...entries.map(([, candles]) => candles.length))
    : 0;
  const initialTrainEnd = Math.floor(shortestCandleCount * initialTrainRatio);
  const foldSize = Math.floor((shortestCandleCount - initialTrainEnd) / foldCount);
  if (entries.length === 0 || foldSize < 6) {
    return {
      promoted: false,
      reason: 'insufficient_data_for_multi_fold',
      marketCount: entries.length,
      candleCount: shortestCandleCount,
      foldCount,
      folds: []
    };
  }

  const folds = [];
  for (let foldIndex = 0; foldIndex < foldCount; foldIndex += 1) {
    const trainEnd = initialTrainEnd + foldIndex * foldSize;
    const evaluationEnd = Math.min(shortestCandleCount, trainEnd + foldSize);
    if (evaluationEnd - trainEnd < 6) continue;
    const foldCandles = Object.fromEntries(entries.map(([market, candles]) => [
      market,
      candles.slice(0, evaluationEnd)
    ]));
    const foldValidation = walkForwardValidatePortfolio(foldCandles, baseConfig, {
      ...options,
      foldCount: undefined,
      initialTrainRatio: undefined,
      trainRatio: trainEnd / evaluationEnd
    });
    folds.push({
      foldIndex: foldIndex + 1,
      trainCandleCount: trainEnd,
      holdoutCandleCount: evaluationEnd - trainEnd,
      validation: foldValidation
    });
  }

  const passed = folds.length === foldCount && folds.every(fold => fold.validation.promoted === true);
  const failedFold = folds.find(fold => fold.validation.promoted !== true);
  const sum = selector => folds.reduce((total, fold) => total + (Number(selector(fold.validation)) || 0), 0);
  return {
    promoted: passed,
    reason: passed
      ? 'all_portfolio_walk_forward_folds_passed_diagnostic_only'
      : failedFold
        ? `portfolio_fold_${failedFold.foldIndex}_failed:${failedFold.validation.reason}`
        : 'insufficient_completed_folds',
    marketCount: entries.length,
    candleCount: shortestCandleCount,
    foldCount,
    initialTrainRatio,
    foldSize,
    folds,
    aggregate: {
      promotedFoldCount: folds.filter(fold => fold.validation.promoted === true).length,
      holdoutTradeCount: sum(validation => validation.validation?.tradeCount),
      holdoutNetProfit: sum(validation => validation.validation?.netProfit),
      holdoutReturnPercent: sum(validation => validation.validation?.totalReturnPercent),
      marketRegimeBlockedEntries: sum(validation => validation.selection?.marketRegimeBlockedEntries),
      circuitBlockedEntries: sum(validation => validation.selection?.circuitBlockedEntries),
      signalWindowBlockedEntries: sum(validation => validation.selection?.signalWindowBlockedEntries),
      volatilityScaledEntries: sum(validation => validation.selection?.volatilityScaledEntries),
      volatilityBlockedEntries: sum(validation => validation.selection?.volatilityBlockedEntries)
    },
    promotion: 'diagnostic_only_never_authorizes_live_orders'
  };
}

/**
 * Walk-forward gate: tune on the earlier segment, then evaluate unchanged
 * parameters on the later segment. A positive training result alone is never
 * enough to promote a configuration.
 */

export function walkForwardValidate(candles, baseConfig = {}, options = {}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...baseConfig };
  const normalized = normalizeHistoricalCandles(candles);
  const dataQuality = analyzeHistoricalCandleContinuity(normalized, resolvedConfig.candleUnit, {
    maxGapSeconds: options.maxHistoricalCandleGapSeconds ?? resolvedConfig.maxHistoricalCandleGapSeconds
  });
  if (requiresHistoricalCandleContinuity(resolvedConfig, options) && !dataQuality.valid) {
    return {
      promoted: false,
      reason: 'historical_candle_continuity_failed',
      candleCount: normalized.length,
      dataQuality
    };
  }
  const trainRatio = options.trainRatio ?? 0.7;
  const minimumCandles = options.minimumCandles ?? 120;
  if (normalized.length < minimumCandles) {
    return {
      promoted: false,
      reason: `insufficient_candles:${normalized.length}<${minimumCandles}`,
      candleCount: normalized.length
    };
  }

  const splitIndex = Math.max(Math.floor(normalized.length * trainRatio), resolvedConfig.rsiPeriod + 20);
  if (splitIndex >= normalized.length - 5) {
    return { promoted: false, reason: 'holdout_segment_too_small', candleCount: normalized.length };
  }

  const trainingCandles = normalized.slice(0, splitIndex);
  const holdoutCandles = normalized.slice(splitIndex);
  const tuning = tuneScalpingParameters(
    trainingCandles,
    resolvedConfig,
    options.grid || DEFAULT_TUNING_GRID,
    {
      maxCandidates: options.maxTuningCandidates,
      minimumTradeCount: options.minimumTuningTrades ?? (
        options.requireStatisticalConfidence === true
          ? options.minimumTrainingConfidenceTrades ?? 10
          : options.minimumTrainingTrades ?? 3
      )
    }
  );
  // Preserve indicator state across the train/holdout boundary. Recomputing
  // RSI from the first holdout candle would create a different signal stream
  // from live trading. The warmup candles are data-only; no trade is allowed
  // before the first actual holdout candle.
  const warmupLength = Math.min(
    trainingCandles.length,
    Math.max(
      200,
      resolvedConfig.rsiPeriod + resolvedConfig.oversoldLookback + 2,
      resolvedConfig.volumeLookback + 2,
      resolvedConfig.trendPeriod + resolvedConfig.trendSlopeLookback + 2,
      resolvedConfig.bbPeriod + 2,
      resolvedConfig.emaPeriod + 2
    )
  );
  const validationCandles = [
    ...trainingCandles.slice(-warmupLength),
    ...holdoutCandles
  ];
  const validation = simulateScalping(validationCandles, tuning.best.config, {
    startTradingIndex: warmupLength
  });
  const trainingMetrics = tuning.best.result.metrics;
  const minimumTrainingTrades = options.minimumTrainingTrades ?? 3;
  const minimumTrainingProfitFactor = options.minimumTrainingProfitFactor ?? 1;
  const minimumTrainingReturnPercent = options.minimumTrainingReturnPercent ?? 0;
  const requireStatisticalConfidence = options.requireStatisticalConfidence === true;
  const minimumTrainingConfidenceTrades = options.minimumTrainingConfidenceTrades ?? 10;
  const minimumValidationConfidenceTrades = options.minimumValidationConfidenceTrades ?? 20;
  const minimumConfidenceLowerBoundPercent = options.minimumConfidenceLowerBoundPercent ?? 0;
  const trainingConfidenceGate = evaluateStatisticalConfidenceGate(trainingMetrics, {
    required: requireStatisticalConfidence,
    minimumTrades: minimumTrainingConfidenceTrades,
    minimumLowerBoundPercent: minimumConfidenceLowerBoundPercent
  });
  const trainingGatePassed = trainingMetrics.tradeCount >= minimumTrainingTrades &&
    trainingMetrics.totalReturnPercent >= minimumTrainingReturnPercent &&
    trainingMetrics.profitFactor >= minimumTrainingProfitFactor &&
    trainingConfidenceGate.passed;
  const minimumValidationTrades = options.minimumValidationTrades ?? 3;
  const minimumProfitFactor = options.minimumProfitFactor ?? 1;
  const minimumReturnPercent = options.minimumReturnPercent ?? 0;
  const maximumDrawdownPercent = options.maximumDrawdownPercent ?? 15;
  const validationMetrics = validation.metrics;
  const validationConfidenceGate = evaluateStatisticalConfidenceGate(validationMetrics, {
    required: requireStatisticalConfidence,
    minimumTrades: minimumValidationConfidenceTrades,
    minimumLowerBoundPercent: minimumConfidenceLowerBoundPercent
  });

  const validationGatePassed = validationMetrics.tradeCount >= minimumValidationTrades &&
    validationMetrics.totalReturnPercent >= minimumReturnPercent &&
    validationMetrics.profitFactor >= minimumProfitFactor &&
    validationMetrics.maxDrawdownPercent <= maximumDrawdownPercent &&
    validationConfidenceGate.passed;
  const promoted = trainingGatePassed && validationGatePassed;

  return {
    promoted,
    reason: promoted
      ? 'walk_forward_gate_passed'
      : !trainingGatePassed
        ? requireStatisticalConfidence && !trainingConfidenceGate.passed
          ? 'training_confidence_gate_failed'
          : 'training_gate_failed'
        : requireStatisticalConfidence && !validationConfidenceGate.passed
          ? 'validation_confidence_gate_failed'
          : 'walk_forward_gate_failed',
    candleCount: normalized.length,
    trainCandleCount: trainingCandles.length,
    holdoutCandleCount: holdoutCandles.length,
    validationWarmupCandleCount: warmupLength,
    tuning: {
      candidateCount: tuning.candidateCount,
      candidatePoolCount: tuning.candidatePoolCount,
      candidateSelectionLimited: tuning.candidateSelectionLimited,
      minimumTradeCount: tuning.minimumTradeCount,
      eligibleCandidateCount: tuning.eligibleCandidateCount,
      minimumTradeFallback: tuning.minimumTradeFallback,
      bestConfig: tuning.best.config,
      metrics: tuning.best.result.metrics
    },
    validation: validationMetrics,
    gate: {
      minimumTrainingTrades,
      minimumTrainingProfitFactor,
      minimumTrainingReturnPercent,
      trainingGatePassed,
      minimumValidationTrades,
      minimumProfitFactor,
      minimumReturnPercent,
      maximumDrawdownPercent,
      statisticalConfidence: {
        required: requireStatisticalConfidence,
        method: 'one_sided_t_mean',
        confidenceLevel: 0.95,
        minimumTrainingTrades: trainingConfidenceGate.minimumTrades,
        minimumValidationTrades: validationConfidenceGate.minimumTrades,
        minimumLowerBoundPercent: trainingConfidenceGate.minimumLowerBoundPercent,
        training: trainingConfidenceGate,
        validation: validationConfidenceGate
      }
    },
    dataQuality
  };
}

export { DEFAULT_CONFIG };
