/**
 * Return the age of a persisted momentum-shadow heartbeat. A missing or
 * malformed timestamp is never treated as fresh.
 */
export function getMomentumShadowHeartbeatAgeMs({ heartbeatAt, now = Date.now() } = {}) {
  const heartbeatMs = Date.parse(heartbeatAt || '');
  if (!Number.isFinite(heartbeatMs)) return null;
  const ageMs = Number(now) - heartbeatMs;
  // A heartbeat in the future cannot be verified fresh — the writer's clock
  // disagrees with the reader's — so it is unusable like a missing value.
  return ageMs < 0 ? null : ageMs;
}

/**
 * A runner with a stale heartbeat must not remain an apparent live owner.
 * The caller decides how to persist the terminal state and release its lock.
 */
export function isMomentumShadowHeartbeatStale({
  heartbeatAt,
  now = Date.now(),
  staleLimitMs = 15 * 60 * 1000
} = {}) {
  const ageMs = getMomentumShadowHeartbeatAgeMs({ heartbeatAt, now });
  const limitMs = Number(staleLimitMs);
  return ageMs === null || !Number.isFinite(limitMs) || limitMs <= 0 || ageMs > limitMs;
}
