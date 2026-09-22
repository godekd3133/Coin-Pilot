export const DEFAULT_MOMENTUM_SHADOW_MAX_CYCLE_DURATION_MS = 10 * 60 * 1000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(60_000, Math.floor(parsed))
    : fallback;
}

/**
 * Resolve the maximum wall-clock duration of one daily-fetch/decision cycle.
 * This is an operational liveness budget, not a strategy or position rule.
 */
export function resolveMomentumShadowMaxCycleDurationMs(
  value,
  fallback = DEFAULT_MOMENTUM_SHADOW_MAX_CYCLE_DURATION_MS
) {
  return positiveInteger(value, positiveInteger(fallback, DEFAULT_MOMENTUM_SHADOW_MAX_CYCLE_DURATION_MS));
}

export function isMomentumShadowCycleTimedOut({
  startedAt,
  now = Date.now(),
  timeoutMs = DEFAULT_MOMENTUM_SHADOW_MAX_CYCLE_DURATION_MS
} = {}) {
  const start = Number(startedAt);
  const current = Number(now);
  const limit = resolveMomentumShadowMaxCycleDurationMs(timeoutMs);
  if (!Number.isFinite(start) || !Number.isFinite(current)) return false;
  // The budget is fully consumed at exactly `limit`: elapsed == limit is a
  // timeout, not an in-budget cycle. Callers that re-arm a timer on a false
  // result stay responsible for the remaining slack.
  return current - start >= limit;
}

/**
 * Keep watchdog failures actionable without changing the liveness budget.
 * The runner supplies the last stage/market it reached before the timer
 * fired, so a persisted stop reason can distinguish API fetch latency from
 * quote or decision work.
 */
export function formatMomentumShadowCycleTimeoutMessage({
  elapsedMs,
  timeoutMs = DEFAULT_MOMENTUM_SHADOW_MAX_CYCLE_DURATION_MS,
  stage = 'unknown',
  market = null
} = {}) {
  const limit = resolveMomentumShadowMaxCycleDurationMs(timeoutMs);
  const elapsed = Number.isFinite(Number(elapsedMs))
    ? Math.max(0, Math.floor(Number(elapsedMs)))
    : null;
  const stageLabel = String(stage || 'unknown').replace(/\s+/g, '_');
  const marketLabel = String(market || 'none').replace(/\s+/g, '_');
  return `shadow cycle exceeded ${Math.round(limit / 1000)}s` +
    ` (elapsedMs=${elapsed === null ? 'unknown' : elapsed}` +
    ` stage=${stageLabel} market=${marketLabel})`;
}
