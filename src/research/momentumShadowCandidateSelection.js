function trendOf(candidate) {
  const trend = candidate?.trendPercent ?? candidate?.signal?.trendPercent;
  return Number(trend) || 0;
}

/**
 * Keep forward candidate selection deterministic and aligned with the daily
 * research simulator: stronger trailing trend wins, then the market code is
 * used as a stable tie-breaker.
 */
export function rankMomentumShadowEntryCandidates(candidates = []) {
  return [...candidates].sort((left, right) =>
    trendOf(right) - trendOf(left) ||
    String(left?.market || '').localeCompare(String(right?.market || ''))
  );
}
