function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Return the asset trend premium over the configured benchmark trend.
 * Unknown inputs are deliberately represented as null so callers can fail
 * closed instead of treating missing benchmark data as a zero trend.
 */
export function calculateMomentumShadowRelativeTrendGap({
  trendPercent,
  benchmarkTrendPercent
} = {}) {
  const trend = finite(trendPercent);
  const benchmarkTrend = finite(benchmarkTrendPercent);
  if (trend === null || benchmarkTrend === null) return null;
  return trend - benchmarkTrend;
}

/**
 * Check whether an asset has enough strength over the benchmark to enter.
 * This is an opt-in guard: the runner only calls it when a non-null threshold
 * is part of the sealed candidate contract. Once enabled, unknown trend data
 * never passes.
 */
export function isMomentumShadowRelativeTrendAllowed({
  trendPercent,
  benchmarkTrendPercent,
  minimumGapPercent
} = {}) {
  const threshold = finite(minimumGapPercent);
  if (threshold === null || threshold < 0) return false;
  const gap = calculateMomentumShadowRelativeTrendGap({ trendPercent, benchmarkTrendPercent });
  return gap !== null && gap > threshold;
}
