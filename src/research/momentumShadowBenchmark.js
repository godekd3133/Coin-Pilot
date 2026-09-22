/**
 * Resolve the optional benchmark gate used by a momentum shadow runner.
 * Missing benchmark data closes the entry gate; it never silently becomes a
 * passing benchmark observation.
 */
export const MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION = 1;

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveOrNull(value) {
  const parsed = numericOrNull(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

function timestampMs(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function calculateMomentumShadowBenchmarkReturnPercent(startPrice, currentPrice) {
  const from = positiveOrNull(startPrice);
  const to = positiveOrNull(currentPrice);
  if (from === null || to === null) return null;
  return ((to - from) / from) * 100;
}

export function calculateMomentumShadowRelativeMarkedReturnPercent(
  markedReturnPercent,
  benchmarkReturnPercent
) {
  const marked = numericOrNull(markedReturnPercent);
  const benchmark = numericOrNull(benchmarkReturnPercent);
  if (marked === null || benchmark === null) return null;
  return marked - benchmark;
}

export const DEFAULT_MOMENTUM_SHADOW_BENCHMARK_CHECKPOINT_LIMIT = 400;

function normalizeBenchmarkCheckpoint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const benchmarkMarkTs = String(value.benchmarkMarkTs ?? '').trim();
  if (timestampMs(benchmarkMarkTs) === null) return null;
  const markedReturnPercent = numericOrNull(value.markedReturnPercent);
  const benchmarkReturnPercent = numericOrNull(value.benchmarkReturnPercent);
  const relativeMarkedReturnPercent = numericOrNull(value.relativeMarkedReturnPercent);
  if (markedReturnPercent === null || benchmarkReturnPercent === null ||
    relativeMarkedReturnPercent === null) return null;
  return {
    benchmarkMarkTs,
    capturedAt: value.capturedAt || null,
    markedEquity: numericOrNull(value.markedEquity),
    markedReturnPercent,
    benchmarkReturnPercent,
    relativeMarkedReturnPercent,
    openPositionCount: Math.max(0, Number(value.openPositionCount) || 0),
    dataQualityValid: value.dataQualityValid === true,
    benchmarkGateOpen: value.benchmarkGateOpen === true
  };
}

/**
 * Append one completed-bar checkpoint while preserving chronological order.
 * Repeated polls for the same completed bar replace the prior checkpoint so
 * the bounded history stays daily rather than growing once per poll.
 */
export function appendMomentumShadowBenchmarkObservationCheckpoint(
  checkpoints,
  checkpoint,
  maxEntries = DEFAULT_MOMENTUM_SHADOW_BENCHMARK_CHECKPOINT_LIMIT
) {
  const limit = Math.max(1, Math.floor(Number(maxEntries) ||
    DEFAULT_MOMENTUM_SHADOW_BENCHMARK_CHECKPOINT_LIMIT));
  const history = (Array.isArray(checkpoints) ? checkpoints : [])
    .map(normalizeBenchmarkCheckpoint)
    .filter(Boolean);
  const normalized = normalizeBenchmarkCheckpoint(checkpoint);
  if (!normalized) return history.slice(-limit);
  const last = history.at(-1);
  const lastTsMs = last ? timestampMs(last.benchmarkMarkTs) : null;
  const currentTsMs = timestampMs(normalized.benchmarkMarkTs);
  if (lastTsMs !== null && currentTsMs < lastTsMs) return history.slice(-limit);
  if (last && last.benchmarkMarkTs === normalized.benchmarkMarkTs) {
    history[history.length - 1] = normalized;
  } else {
    history.push(normalized);
  }
  return history.slice(-limit);
}

export function summarizeMomentumShadowBenchmarkObservationCheckpoints(
  checkpoints,
  maxEntries = DEFAULT_MOMENTUM_SHADOW_BENCHMARK_CHECKPOINT_LIMIT
) {
  const history = appendMomentumShadowBenchmarkObservationCheckpoint(
    checkpoints,
    null,
    maxEntries
  );
  const validHistory = history.filter(checkpoint => checkpoint.dataQualityValid === true);
  if (history.length === 0) {
    return {
      available: false,
      checkpointCount: 0,
      validCheckpointCount: 0,
      invalidCheckpointCount: 0,
      firstBenchmarkMarkTs: null,
      latestBenchmarkMarkTs: null,
      latestRelativeMarkedReturnPercent: null,
      bestRelativeMarkedReturnPercent: null,
      worstRelativeMarkedReturnPercent: null
    };
  }
  if (validHistory.length === 0) {
    return {
      available: false,
      checkpointCount: history.length,
      validCheckpointCount: 0,
      invalidCheckpointCount: history.length,
      firstBenchmarkMarkTs: null,
      latestBenchmarkMarkTs: null,
      latestRelativeMarkedReturnPercent: null,
      bestRelativeMarkedReturnPercent: null,
      worstRelativeMarkedReturnPercent: null
    };
  }
  const relativeReturns = validHistory.map(item => item.relativeMarkedReturnPercent);
  return {
    available: true,
    checkpointCount: history.length,
    validCheckpointCount: validHistory.length,
    invalidCheckpointCount: history.length - validHistory.length,
    firstBenchmarkMarkTs: validHistory[0].benchmarkMarkTs,
    latestBenchmarkMarkTs: validHistory.at(-1).benchmarkMarkTs,
    latestRelativeMarkedReturnPercent: validHistory.at(-1).relativeMarkedReturnPercent,
    bestRelativeMarkedReturnPercent: Math.max(...relativeReturns),
    worstRelativeMarkedReturnPercent: Math.min(...relativeReturns)
  };
}

/**
 * Resolve one completed benchmark bar into a monotonic observation window.
 * This is descriptive telemetry only: it does not open or close a position.
 * A missing timestamp or price makes the observation unavailable instead of
 * manufacturing a return from an unverifiable value.
 */
export function projectMomentumShadowBenchmarkObservation({
  existing = {},
  bars,
  benchmarkMarket
} = {}) {
  if (!benchmarkMarket) {
    return { available: false, reason: 'benchmark_not_configured' };
  }

  const last = Array.isArray(bars) && bars.length ? bars[bars.length - 1] : null;
  const markPrice = positiveOrNull(last?.trade_price);
  const markTs = String(last?.ts ?? '').trim();
  const markTsMs = timestampMs(markTs);
  if (markPrice === null || markTsMs === null) {
    return { available: false, reason: 'benchmark_data_unavailable' };
  }

  const existingMarket = String(existing.benchmarkObservationMarket ?? '').trim();
  if (existingMarket && existingMarket !== benchmarkMarket) {
    return { available: false, reason: 'benchmark_market_changed' };
  }

  const existingStartPrice = positiveOrNull(existing.benchmarkObservationStartPrice);
  const existingStartTs = String(existing.benchmarkObservationStartTs ?? '').trim();
  const existingStartTsMs = timestampMs(existingStartTs);
  const initialized = existingStartPrice === null || existingStartTsMs === null;
  const startPrice = initialized ? markPrice : existingStartPrice;
  const startTs = initialized ? markTs : existingStartTs;

  const previousMarkPrice = positiveOrNull(existing.benchmarkObservationMarkPrice);
  const previousMarkTs = String(existing.benchmarkObservationMarkTs ?? '').trim();
  const previousMarkTsMs = timestampMs(previousMarkTs);
  if (previousMarkTsMs !== null && markTsMs < previousMarkTsMs) {
    const previousReturnPercent = calculateMomentumShadowBenchmarkReturnPercent(
      startPrice,
      previousMarkPrice
    );
    if (previousMarkPrice !== null && previousReturnPercent !== null) {
      return {
        available: true,
        initialized: false,
        updated: false,
        reason: 'benchmark_timestamp_regressed',
        benchmarkObservationMarket: benchmarkMarket,
        benchmarkObservationStartPrice: startPrice,
        benchmarkObservationStartTs: startTs,
        benchmarkObservationMarkPrice: previousMarkPrice,
        benchmarkObservationMarkTs: previousMarkTs,
        benchmarkObservationReturnPercent: previousReturnPercent
      };
    }
  }

  return {
    available: true,
    initialized,
    updated: true,
    reason: null,
    benchmarkObservationMarket: benchmarkMarket,
    benchmarkObservationStartPrice: startPrice,
    benchmarkObservationStartTs: startTs,
    benchmarkObservationMarkPrice: markPrice,
    benchmarkObservationMarkTs: markTs,
    benchmarkObservationReturnPercent: calculateMomentumShadowBenchmarkReturnPercent(
      startPrice,
      markPrice
    )
  };
}

export function getMomentumShadowBenchmarkGate(
  seriesByMarket,
  benchmarkMarket = null,
  index = -1,
  minimumTrendPercent = 0,
  lookbackDays = 7
) {
  if (!benchmarkMarket) {
    return {
      configured: false,
      available: true,
      gateOpen: true,
      trendPercent: null,
      reason: null
    };
  }
  const bars = seriesByMarket?.[benchmarkMarket];
  const lookback = Math.max(1, Math.floor(Number(lookbackDays) || 7));
  const currentIndex = Number.isInteger(index) && index >= 0 ? index : (bars?.length || 0) - 1;
  if (!Array.isArray(bars) || currentIndex < lookback || !bars[currentIndex] || !bars[currentIndex - lookback]) {
    return {
      configured: true,
      available: false,
      gateOpen: false,
      trendPercent: null,
      reason: 'benchmark_data_unavailable'
    };
  }
  const from = Number(bars[currentIndex - lookback].trade_price);
  const to = Number(bars[currentIndex].trade_price);
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) {
    return {
      configured: true,
      available: false,
      gateOpen: false,
      trendPercent: null,
      reason: 'benchmark_price_invalid'
    };
  }
  const trendPercent = ((to - from) / from) * 100;
  return {
    configured: true,
    available: true,
    gateOpen: trendPercent > Number(minimumTrendPercent || 0),
    trendPercent,
    reason: null
  };
}
