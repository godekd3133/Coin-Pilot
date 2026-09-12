const DEFAULT_MAX_ANALYSIS_DATA_GAP_SECONDS = 60;

function asTimestamp(value) {
  const timestamp = value instanceof Date
    ? value.getTime()
    : Number.isFinite(Number(value))
      ? Number(value)
      : new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function asIsoTimestamp(value) {
  const timestamp = asTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeMarkets(markets) {
  return [...new Set((Array.isArray(markets) ? markets : [])
    .map(market => String(market || '').trim().toUpperCase())
    .filter(Boolean))];
}

/**
 * Resolve the maximum period for which an analysis cycle may be incomplete.
 * A positive value is clamped to five seconds so a misconfigured fail-closed
 * guard cannot become an effectively disabled safety control. Zero is kept as
 * an explicit compatibility escape hatch for non-scalping callers.
 */
export function resolveMaxAnalysisDataGapSeconds(value, fallback = DEFAULT_MAX_ANALYSIS_DATA_GAP_SECONDS) {
  const configured = Number(value);
  if (Number.isFinite(configured) && configured === 0) return 0;
  if (Number.isFinite(configured) && configured > 0) return Math.max(5, configured);
  const resolvedFallback = Number(fallback);
  return Number.isFinite(resolvedFallback) && resolvedFallback > 0
    ? Math.max(5, resolvedFallback)
    : 0;
}

export function createAnalysisDataHealthState(existing = {}) {
  return {
    lastCompleteAt: asIsoTimestamp(existing.lastCompleteAt),
    lastIncompleteAt: asIsoTimestamp(existing.lastIncompleteAt),
    currentGapStartedAt: asIsoTimestamp(existing.currentGapStartedAt),
    lastCheckedAt: asIsoTimestamp(existing.lastCheckedAt),
    consecutiveIncompleteCycles: nonNegativeInteger(existing.consecutiveIncompleteCycles),
    totalIncompleteCycles: nonNegativeInteger(existing.totalIncompleteCycles),
    totalMissingMarkets: nonNegativeInteger(existing.totalMissingMarkets),
    maxObservedGapSeconds: Number.isFinite(Number(existing.maxObservedGapSeconds))
      ? Math.max(0, Number(existing.maxObservedGapSeconds))
      : 0,
    expectedMarketCount: nonNegativeInteger(existing.expectedMarketCount),
    analyzedMarketCount: nonNegativeInteger(existing.analyzedMarketCount),
    lastMissingMarkets: normalizeMarkets(existing.lastMissingMarkets),
    continuityEligible: existing.continuityEligible !== false
  };
}

export function recordAnalysisDataSuccess(existing = {}, details = {}, now = Date.now()) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createAnalysisDataHealthState(existing);
  const gapStartedAt = asTimestamp(state.currentGapStartedAt);
  if (gapStartedAt !== null) {
    state.maxObservedGapSeconds = Math.max(
      state.maxObservedGapSeconds,
      Math.max(0, (timestamp - gapStartedAt) / 1000)
    );
  }
  state.lastCompleteAt = new Date(timestamp).toISOString();
  state.lastCheckedAt = state.lastCompleteAt;
  state.currentGapStartedAt = null;
  state.consecutiveIncompleteCycles = 0;
  state.expectedMarketCount = nonNegativeInteger(details.expectedMarketCount);
  state.analyzedMarketCount = nonNegativeInteger(details.analyzedMarketCount);
  state.lastMissingMarkets = [];
  return state;
}

export function recordAnalysisDataFailure(
  existing = {},
  details = {},
  now = Date.now(),
  maxGapSeconds = DEFAULT_MAX_ANALYSIS_DATA_GAP_SECONDS
) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createAnalysisDataHealthState(existing);
  if (asTimestamp(state.currentGapStartedAt) === null) {
    state.currentGapStartedAt = new Date(timestamp).toISOString();
  }
  const gapStartedAt = asTimestamp(state.currentGapStartedAt) || timestamp;
  const gapDurationSeconds = Math.max(0, (timestamp - gapStartedAt) / 1000);
  const missingMarkets = normalizeMarkets(details.missingMarkets);
  state.lastIncompleteAt = new Date(timestamp).toISOString();
  state.lastCheckedAt = state.lastIncompleteAt;
  state.consecutiveIncompleteCycles += 1;
  state.totalIncompleteCycles += 1;
  state.totalMissingMarkets += missingMarkets.length;
  state.expectedMarketCount = nonNegativeInteger(details.expectedMarketCount);
  state.analyzedMarketCount = nonNegativeInteger(details.analyzedMarketCount);
  state.lastMissingMarkets = missingMarkets;
  state.maxObservedGapSeconds = Math.max(state.maxObservedGapSeconds, gapDurationSeconds);

  const resolvedMaxGapSeconds = resolveMaxAnalysisDataGapSeconds(maxGapSeconds);
  const failClosed = resolvedMaxGapSeconds > 0 && gapDurationSeconds >= resolvedMaxGapSeconds;
  if (failClosed) state.continuityEligible = false;

  return {
    state,
    gapDurationSeconds,
    maxAnalysisDataGapSeconds: resolvedMaxGapSeconds,
    failClosed,
    continuityEligible: state.continuityEligible && !failClosed
  };
}

export function getAnalysisDataHealthStatus(
  existing = {},
  now = Date.now(),
  maxGapSeconds = DEFAULT_MAX_ANALYSIS_DATA_GAP_SECONDS
) {
  const state = createAnalysisDataHealthState(existing);
  const resolvedMaxGapSeconds = resolveMaxAnalysisDataGapSeconds(maxGapSeconds);
  const gapStartedAt = asTimestamp(state.currentGapStartedAt);
  const timestamp = asTimestamp(now) || Date.now();
  const currentGapDurationSeconds = gapStartedAt === null
    ? 0
    : Math.max(0, (timestamp - gapStartedAt) / 1000);
  const failClosed = resolvedMaxGapSeconds > 0 && gapStartedAt !== null &&
    currentGapDurationSeconds >= resolvedMaxGapSeconds;
  return {
    ...state,
    maxAnalysisDataGapSeconds: resolvedMaxGapSeconds,
    currentGapDurationSeconds,
    analysisDataFresh: !failClosed,
    failClosed,
    continuityEligible: state.continuityEligible && !failClosed
  };
}

export const ANALYSIS_DATA_HEALTH_DEFAULTS = Object.freeze({
  maxAnalysisDataGapSeconds: DEFAULT_MAX_ANALYSIS_DATA_GAP_SECONDS
});
