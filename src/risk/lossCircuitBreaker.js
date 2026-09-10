/**
 * Sliding-window loss circuit breaker shared by paper, backtest, and the
 * diagnostic shadow books. A zero limit disables the breaker while keeping
 * the surrounding state backward-compatible.
 */
export function createLossCircuitBreakerState() {
  return {
    lossTimestamps: [],
    cooldownUntil: 0
  };
}

function timestampMs(value) {
  const parsed = value instanceof Date ? value.getTime() : Number(value);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const dateParsed = new Date(value || 0).getTime();
  return Number.isFinite(dateParsed) && dateParsed > 0 ? dateParsed : Date.now();
}

export function isLossCircuitCoolingDown(
  state,
  now = Date.now(),
  { maxLosses = 0, windowMinutes = 30 } = {}
) {
  if (!state || Number(maxLosses) <= 0) return false;
  const windowMs = Math.max(1, Number(windowMinutes) || 30) * 60 * 1000;
  const nowMs = timestampMs(now);
  state.lossTimestamps = (Array.isArray(state.lossTimestamps) ? state.lossTimestamps : [])
    .map(timestampMs)
    .filter(timestamp => timestamp > nowMs - windowMs);
  return nowMs < (Number(state.cooldownUntil) || 0);
}

export function registerLoss(
  state,
  timestamp = Date.now(),
  {
    maxLosses = 0,
    windowMinutes = 30,
    cooldownMinutes = 60
  } = {}
) {
  if (!state) return { triggered: false, lossCount: 0, cooldownUntil: 0 };
  const limit = Math.max(0, Number(maxLosses) || 0);
  const windowMs = Math.max(1, Number(windowMinutes) || 30) * 60 * 1000;
  const nowMs = timestampMs(timestamp);
  state.lossTimestamps = (Array.isArray(state.lossTimestamps) ? state.lossTimestamps : [])
    .map(timestampMs)
    .filter(item => item > nowMs - windowMs);

  if (limit <= 0) {
    state.cooldownUntil = 0;
    return { triggered: false, lossCount: state.lossTimestamps.length, cooldownUntil: 0 };
  }

  state.lossTimestamps.push(nowMs);
  const triggered = state.lossTimestamps.length >= limit;
  if (triggered) {
    const cooldownMs = Math.max(1, Number(cooldownMinutes) || 60) * 60 * 1000;
    state.cooldownUntil = Math.max(Number(state.cooldownUntil) || 0, nowMs + cooldownMs);
  }
  return {
    triggered,
    lossCount: state.lossTimestamps.length,
    cooldownUntil: Number(state.cooldownUntil) || 0
  };
}

/**
 * Return a read-friendly snapshot without exposing the caller to the internal
 * timestamp pruning details. `isLossCircuitCoolingDown` intentionally mutates
 * the state by removing losses outside the sliding window, so the reported
 * count and cooling flag always describe the same window.
 */
export function getLossCircuitBreakerStatus(
  state,
  now = Date.now(),
  {
    maxLosses = 0,
    windowMinutes = 30,
    cooldownMinutes = 60
  } = {}
) {
  const limit = Math.max(0, Math.floor(Number(maxLosses) || 0));
  const window = Math.max(1, Number(windowMinutes) || 30);
  const cooldown = Math.max(1, Number(cooldownMinutes) || 60);
  const nowMs = timestampMs(now);
  const coolingDown = isLossCircuitCoolingDown(state, nowMs, {
    maxLosses: limit,
    windowMinutes: window
  });
  const cooldownUntil = Number(state?.cooldownUntil) || 0;

  return {
    enabled: limit > 0,
    maxLosses: limit,
    windowMinutes: window,
    cooldownMinutes: cooldown,
    lossCount: Array.isArray(state?.lossTimestamps) ? state.lossTimestamps.length : 0,
    coolingDown,
    cooldownUntil: cooldownUntil > nowMs ? cooldownUntil : 0,
    cooldownRemainingMs: Math.max(0, cooldownUntil - nowMs)
  };
}
