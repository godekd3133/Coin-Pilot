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
    monitoringActive: existing.monitoringActive === true,
    monitoringStartedAt: asIsoTimestamp(existing.monitoringStartedAt),
    lastAttemptAt: asIsoTimestamp(existing.lastAttemptAt),
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

/**
 * Mark the beginning of a risk ticker attempt. This state is intentionally
 * separate from lastSuccessAt: an in-flight request can keep the Node event
 * loop alive while no successful price observation is being produced.
 */
export function recordRiskMonitorAttempt(existing = {}, now = Date.now()) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createRiskMonitorState(existing);
  const isoTimestamp = new Date(timestamp).toISOString();
  const wasMonitoring = state.monitoringActive === true;
  const hasExistingOutage = asTimestamp(state.currentOutageStartedAt) !== null;
  if (!wasMonitoring && !hasExistingOutage) {
    // An idle period without protected positions is not an outage. Start a
    // fresh monitoring epoch when a position becomes observable again, so a
    // new risk request cannot compare itself with a success from before the
    // idle period and falsely trip RISK_CHECK_STALE.
    state.lastSuccessAt = null;
    state.currentOutageStartedAt = null;
    state.consecutiveFailures = 0;
  }
  state.monitoringActive = true;
  state.lastAttemptAt = isoTimestamp;
  state.monitoringStartedAt = wasMonitoring
    ? state.monitoringStartedAt || isoTimestamp
    : isoTimestamp;
  return state;
}

/**
 * Clear the active risk observation when there are no open positions to
 * protect. A long idle period without positions is not a risk-data outage.
 */
export function recordRiskMonitorIdle(existing = {}) {
  const state = createRiskMonitorState(existing);
  state.monitoringActive = false;
  state.monitoringStartedAt = null;
  return state;
}

export function recordRiskMonitorSuccess(
  existing = {},
  now = Date.now(),
  maxGapSeconds = DEFAULT_MAX_RISK_DATA_GAP_SECONDS
) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createRiskMonitorState(existing);
  const outageStartedAt = asTimestamp(state.currentOutageStartedAt);
  const previousObservationAt = state.monitoringActive === true
    ? asTimestamp(state.lastSuccessAt) ||
      asTimestamp(state.monitoringStartedAt) ||
      asTimestamp(state.lastAttemptAt)
    : null;
  const resolvedMaxGapSeconds = resolveMaxRiskDataGapSeconds(maxGapSeconds);
  const observedGapSeconds = previousObservationAt === null
    ? 0
    : Math.max(0, (timestamp - previousObservationAt) / 1000);
  const delayedSuccess = outageStartedAt === null &&
    previousObservationAt !== null &&
    resolvedMaxGapSeconds > 0 &&
    observedGapSeconds >= resolvedMaxGapSeconds;
  if (outageStartedAt !== null) {
    state.maxObservedGapSeconds = Math.max(
      state.maxObservedGapSeconds,
      (timestamp - outageStartedAt) / 1000
    );
  }
  if (delayedSuccess) {
    state.maxObservedGapSeconds = Math.max(state.maxObservedGapSeconds, observedGapSeconds);
    state.currentOutageStartedAt = new Date(previousObservationAt).toISOString();
    state.lastFailureAt = new Date(timestamp).toISOString();
    state.lastFailureCode = 'RISK_CHECK_STALE';
    state.lastFailureMessage = 'risk ticker 성공 callback이 허용 공백 뒤에 도착했습니다';
    state.totalFailures += 1;
    state.outageCount += 1;
    state.continuityEligible = false;
  }
  state.lastSuccessAt = new Date(timestamp).toISOString();
  state.lastAttemptAt = state.lastSuccessAt;
  state.lastCheckedAt = state.lastSuccessAt;
  if (!delayedSuccess) state.currentOutageStartedAt = null;
  state.consecutiveFailures = 0;
  return state;
}

export function recordRiskMonitorFailure(existing = {}, error = null, now = Date.now(), maxGapSeconds = DEFAULT_MAX_RISK_DATA_GAP_SECONDS) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createRiskMonitorState(existing);
  state.monitoringActive = true;
  state.lastAttemptAt = new Date(timestamp).toISOString();
  state.monitoringStartedAt = state.monitoringStartedAt || state.lastAttemptAt;
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

/**
 * Convert a stale in-flight observation into the same durable outage shape as
 * an explicit request failure. The outage begins at the last known good
 * observation (or the first attempt when no success exists), not at the time
 * the watchdog happens to notice it.
 */
export function recordRiskMonitorStale(
  existing = {},
  now = Date.now(),
  maxGapSeconds = DEFAULT_MAX_RISK_DATA_GAP_SECONDS
) {
  const timestamp = asTimestamp(now) || Date.now();
  const state = createRiskMonitorState(existing);
  state.monitoringActive = true;
  state.lastAttemptAt = new Date(timestamp).toISOString();
  state.monitoringStartedAt = state.monitoringStartedAt || state.lastAttemptAt;

  const existingOutageStartedAt = asTimestamp(state.currentOutageStartedAt);
  const staleSince = existingOutageStartedAt ||
    asTimestamp(state.lastSuccessAt) ||
    asTimestamp(state.monitoringStartedAt) ||
    asTimestamp(state.lastAttemptAt) ||
    timestamp;
  if (existingOutageStartedAt === null) {
    state.currentOutageStartedAt = new Date(staleSince).toISOString();
    state.outageCount += 1;
  }

  const outageStartedAt = asTimestamp(state.currentOutageStartedAt) || staleSince;
  const outageDurationSeconds = Math.max(0, (timestamp - outageStartedAt) / 1000);
  state.lastFailureAt = new Date(timestamp).toISOString();
  state.lastCheckedAt = state.lastFailureAt;
  state.lastFailureCode = 'RISK_CHECK_STALE';
  state.lastFailureMessage = 'risk ticker 성공 시각이 허용 공백을 초과했습니다';
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
    stale: true,
    continuityEligible: state.continuityEligible && !failClosed
  };
}

export function getRiskMonitorStatus(existing = {}, now = Date.now(), maxGapSeconds = DEFAULT_MAX_RISK_DATA_GAP_SECONDS) {
  const state = createRiskMonitorState(existing);
  const resolvedMaxGapSeconds = resolveMaxRiskDataGapSeconds(maxGapSeconds);
  const outageStartedAt = asTimestamp(state.currentOutageStartedAt);
  const nowTimestamp = asTimestamp(now) || Date.now();
  const activeObservationAt = state.monitoringActive === true
    ? asTimestamp(state.lastSuccessAt) ||
      asTimestamp(state.monitoringStartedAt) ||
      asTimestamp(state.lastAttemptAt)
    : null;
  const staleObservation = outageStartedAt === null && activeObservationAt !== null &&
    resolvedMaxGapSeconds > 0 &&
    Math.max(0, (nowTimestamp - activeObservationAt) / 1000) >= resolvedMaxGapSeconds;
  const outageStartForStatus = outageStartedAt === null && staleObservation
    ? activeObservationAt
    : outageStartedAt;
  const currentOutageDurationSeconds = outageStartForStatus === null
    ? 0
    : Math.max(0, (nowTimestamp - outageStartForStatus) / 1000);
  const failClosed = resolvedMaxGapSeconds > 0 && outageStartForStatus !== null &&
    currentOutageDurationSeconds >= resolvedMaxGapSeconds;
  return {
    ...state,
    maxRiskDataGapSeconds: resolvedMaxGapSeconds,
    currentOutageDurationSeconds,
    riskDataFresh: !failClosed,
    failClosed,
    staleReason: staleObservation ? 'risk_check_stale' : null,
    continuityEligible: state.continuityEligible && !failClosed
  };
}
