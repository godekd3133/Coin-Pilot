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
    analysisActive: existing.analysisActive === true,
    analysisStartedAt: asIsoTimestamp(existing.analysisStartedAt),
    lastAttemptAt: asIsoTimestamp(existing.lastAttemptAt),
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

/**
 * Mark a new full-market analysis cycle before the first network request.
 * Keeping this separate from lastCompleteAt makes an in-flight cycle visible
 * to the health watchdog and read-only observer.
 */
export function recordAnalysisDataAttempt(existing = {}, now = Date.now()) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createAnalysisDataHealthState(existing);
  const isoTimestamp = new Date(timestamp).toISOString();
  state.analysisActive = true;
  state.lastAttemptAt = isoTimestamp;
  state.analysisStartedAt = state.analysisStartedAt || isoTimestamp;
  return state;
}

/**
 * Clear the in-flight marker when there is no analysis request to account for.
 * This prevents an old completed timestamp from invalidating an idle runner.
 */
export function recordAnalysisDataIdle(existing = {}) {
  const state = createAnalysisDataHealthState(existing);
  state.analysisActive = false;
  state.analysisStartedAt = null;
  return state;
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
  state.lastAttemptAt = state.lastCompleteAt;
  state.analysisActive = false;
  state.analysisStartedAt = null;
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
  state.lastAttemptAt = state.lastIncompleteAt;
  state.analysisActive = false;
  state.analysisStartedAt = null;
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

/**
 * Convert a cycle that stayed in-flight past the configured budget into a
 * durable continuity failure. The gap starts at the last complete cycle (or
 * the first attempt if no cycle completed), not at watchdog observation time.
 */
export function recordAnalysisDataStale(
  existing = {},
  details = {},
  now = Date.now(),
  maxGapSeconds = DEFAULT_MAX_ANALYSIS_DATA_GAP_SECONDS
) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createAnalysisDataHealthState(existing);
  const existingGapStartedAt = asTimestamp(state.currentGapStartedAt);
  const staleSince = existingGapStartedAt ||
    asTimestamp(state.lastCompleteAt) ||
    asTimestamp(state.analysisStartedAt) ||
    asTimestamp(state.lastAttemptAt) ||
    timestamp;
  state.analysisActive = false;
  state.analysisStartedAt = null;
  state.lastAttemptAt = new Date(timestamp).toISOString();
  if (existingGapStartedAt === null) {
    state.currentGapStartedAt = new Date(staleSince).toISOString();
  }

  const gapStartedAt = asTimestamp(state.currentGapStartedAt) || staleSince;
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
    stale: true,
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
  const activeObservationAt = state.analysisActive === true
    ? asTimestamp(state.lastCompleteAt) ||
      asTimestamp(state.analysisStartedAt) ||
      asTimestamp(state.lastAttemptAt)
    : null;
  const staleCycle = gapStartedAt === null && activeObservationAt !== null &&
    resolvedMaxGapSeconds > 0 &&
    Math.max(0, (timestamp - activeObservationAt) / 1000) >= resolvedMaxGapSeconds;
  const gapStartForStatus = gapStartedAt === null && staleCycle
    ? activeObservationAt
    : gapStartedAt;
  const currentGapDurationSeconds = gapStartForStatus === null
    ? 0
    : Math.max(0, (timestamp - gapStartForStatus) / 1000);
  const failClosed = resolvedMaxGapSeconds > 0 && gapStartForStatus !== null &&
    currentGapDurationSeconds >= resolvedMaxGapSeconds;
  return {
    ...state,
    maxAnalysisDataGapSeconds: resolvedMaxGapSeconds,
    currentGapDurationSeconds,
    analysisDataFresh: !failClosed,
    failClosed,
    staleReason: staleCycle ? 'analysis_cycle_stale' : null,
    continuityEligible: state.continuityEligible && !failClosed
  };
}

export const ANALYSIS_DATA_HEALTH_DEFAULTS = Object.freeze({
  maxAnalysisDataGapSeconds: DEFAULT_MAX_ANALYSIS_DATA_GAP_SECONDS
});
