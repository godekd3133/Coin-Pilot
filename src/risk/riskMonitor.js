const DEFAULT_MAX_RISK_DATA_GAP_SECONDS = 30;

function asTimestamp(value) {
  const timestamp = value instanceof Date
    ? value.getTime()
    : new Date(value || 0).getTime();
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
}

function asIsoTimestamp(value) {
  const timestamp = asTimestamp(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function positiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

/**
 * Resolve the maximum period for which an open position may exist without a
 * successful ticker risk check. Zero disables the safety stop for legacy
 * non-scalping callers; scalping callers should use a positive value.
 */
export function resolveMaxRiskDataGapSeconds(value, fallback = DEFAULT_MAX_RISK_DATA_GAP_SECONDS) {
  const configured = Number(value);
  if (Number.isFinite(configured) && configured === 0) return 0;
  if (Number.isFinite(configured) && configured > 0) return Math.max(5, configured);
  const resolvedFallback = Number(fallback);
  return Number.isFinite(resolvedFallback) && resolvedFallback > 0
    ? Math.max(5, resolvedFallback)
    : 0;
}

export function createRiskMonitorState(existing = {}) {
  return {
    lastSuccessAt: asIsoTimestamp(existing.lastSuccessAt),
    lastFailureAt: asIsoTimestamp(existing.lastFailureAt),
    currentOutageStartedAt: asIsoTimestamp(existing.currentOutageStartedAt),
    lastCheckedAt: asIsoTimestamp(existing.lastCheckedAt),
    lastFailureCode: existing.lastFailureCode ? String(existing.lastFailureCode) : null,
    lastFailureMessage: existing.lastFailureMessage ? String(existing.lastFailureMessage).slice(0, 240) : null,
    consecutiveFailures: positiveInteger(existing.consecutiveFailures),
    totalFailures: positiveInteger(existing.totalFailures),
    outageCount: positiveInteger(existing.outageCount),
    maxObservedGapSeconds: Number.isFinite(Number(existing.maxObservedGapSeconds))
      ? Math.max(0, Number(existing.maxObservedGapSeconds))
      : 0,
    continuityEligible: existing.continuityEligible !== false
  };
}

export function recordRiskMonitorSuccess(existing = {}, now = Date.now()) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createRiskMonitorState(existing);
  const outageStartedAt = asTimestamp(state.currentOutageStartedAt);
  if (outageStartedAt !== null) {
    state.maxObservedGapSeconds = Math.max(
      state.maxObservedGapSeconds,
      (timestamp - outageStartedAt) / 1000
    );
  }
  state.lastSuccessAt = new Date(timestamp).toISOString();
  state.lastCheckedAt = state.lastSuccessAt;
  state.currentOutageStartedAt = null;
  state.consecutiveFailures = 0;
  return state;
}

export function recordRiskMonitorFailure(existing = {}, error = null, now = Date.now(), maxGapSeconds = DEFAULT_MAX_RISK_DATA_GAP_SECONDS) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createRiskMonitorState(existing);
  const outageStartedAt = asTimestamp(state.currentOutageStartedAt);
  if (outageStartedAt === null) {
    state.currentOutageStartedAt = new Date(timestamp).toISOString();
    state.outageCount += 1;
  }
  const currentOutageStartedAt = asTimestamp(state.currentOutageStartedAt) || timestamp;
  const outageDurationSeconds = Math.max(0, (timestamp - currentOutageStartedAt) / 1000);
  state.lastFailureAt = new Date(timestamp).toISOString();
  state.lastCheckedAt = state.lastFailureAt;
  state.lastFailureCode = error?.code || error?.response?.status
    ? String(error.code || `HTTP_${error.response.status}`)
    : 'RISK_DATA_UNAVAILABLE';
  state.lastFailureMessage = String(error?.message || 'risk ticker 조회 실패').slice(0, 240);
  state.consecutiveFailures += 1;
  state.totalFailures += 1;
  state.maxObservedGapSeconds = Math.max(state.maxObservedGapSeconds, outageDurationSeconds);

  const resolvedMaxGapSeconds = resolveMaxRiskDataGapSeconds(maxGapSeconds);
  const failClosed = resolvedMaxGapSeconds > 0 && outageDurationSeconds >= resolvedMaxGapSeconds;
  if (failClosed) state.continuityEligible = false;

  return {
    state,
    outageDurationSeconds,
    maxRiskDataGapSeconds: resolvedMaxGapSeconds,
    failClosed,
    continuityEligible: state.continuityEligible && !failClosed
  };
}

export function getRiskMonitorStatus(existing = {}, now = Date.now(), maxGapSeconds = DEFAULT_MAX_RISK_DATA_GAP_SECONDS) {
  const state = createRiskMonitorState(existing);
  const resolvedMaxGapSeconds = resolveMaxRiskDataGapSeconds(maxGapSeconds);
  const outageStartedAt = asTimestamp(state.currentOutageStartedAt);
  const nowTimestamp = asTimestamp(now) || Date.now();
  const currentOutageDurationSeconds = outageStartedAt === null
    ? 0
    : Math.max(0, (nowTimestamp - outageStartedAt) / 1000);
  const failClosed = resolvedMaxGapSeconds > 0 && outageStartedAt !== null &&
    currentOutageDurationSeconds >= resolvedMaxGapSeconds;
  return {
    ...state,
    maxRiskDataGapSeconds: resolvedMaxGapSeconds,
    currentOutageDurationSeconds,
    riskDataFresh: !failClosed,
    failClosed,
    continuityEligible: state.continuityEligible && !failClosed
  };
}
