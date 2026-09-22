export const DEFAULT_MAX_CONSECUTIVE_FETCH_FAILURES = 3;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(1, Math.floor(parsed))
    : fallback;
}

/**
 * Resolve the operational circuit-breaker budget for one shadow cycle.
 * This is deliberately separate from strategy configuration: it controls
 * how long a runner keeps asking an unavailable public API, not which signals
 * or positions the runner may create.
 */
export function resolveMomentumShadowFetchFailureLimit(
  value,
  fallback = DEFAULT_MAX_CONSECUTIVE_FETCH_FAILURES
) {
  return positiveInteger(value, positiveInteger(fallback, DEFAULT_MAX_CONSECUTIVE_FETCH_FAILURES));
}

export function summarizeMomentumShadowNetworkError(error) {
  const status = Number(error?.response?.status);
  const code = typeof error?.code === 'string' && error.code
    ? error.code
    : Number.isInteger(status) ? `HTTP_${status}` : 'UNKNOWN_NETWORK_ERROR';
  const rawMessage = error?.message || String(error || 'network fetch failed');
  return {
    code,
    message: String(rawMessage).slice(0, 240)
  };
}

/**
 * Persist one fetch failure and report whether the cycle should stop asking
 * for more markets. The caller supplies the current cycle's consecutive
 * count so a successful market always starts a new streak.
 */
export function recordMomentumShadowFetchFailure(
  ledger,
  error,
  {
    consecutiveFailures = 1,
    maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FETCH_FAILURES,
    market = null,
    now = Date.now()
  } = {}
) {
  const count = Math.max(1, Math.floor(Number(consecutiveFailures) || 1));
  const limit = resolveMomentumShadowFetchFailureLimit(maxConsecutiveFailures);
  const summary = summarizeMomentumShadowNetworkError(error);
  const wasOpen = ledger?.networkFetchCircuitOpen === true;
  const circuitOpen = count >= limit;

  if (ledger && typeof ledger === 'object') {
    ledger.networkFetchFailureStreak = count;
    ledger.networkFetchCircuitOpen = circuitOpen;
    ledger.lastNetworkFetchError = {
      ...summary,
      ...(typeof market === 'string' && market ? { market } : {}),
      at: new Date(now).toISOString()
    };
    ledger.networkFetchFailureCount = (Number(ledger.networkFetchFailureCount) || 0) + 1;
    if (!ledger.networkFetchFailureCountsByCode ||
      typeof ledger.networkFetchFailureCountsByCode !== 'object') {
      ledger.networkFetchFailureCountsByCode = {};
    }
    ledger.networkFetchFailureCountsByCode[summary.code] =
      (Number(ledger.networkFetchFailureCountsByCode[summary.code]) || 0) + 1;
    if (typeof market === 'string' && market) {
      if (!ledger.networkFetchFailureCountsByMarket ||
        typeof ledger.networkFetchFailureCountsByMarket !== 'object') {
        ledger.networkFetchFailureCountsByMarket = {};
      }
      ledger.networkFetchFailureCountsByMarket[market] =
        (Number(ledger.networkFetchFailureCountsByMarket[market]) || 0) + 1;
    }
    if (!wasOpen && circuitOpen) {
      ledger.networkFetchCircuitBreaks = (Number(ledger.networkFetchCircuitBreaks) || 0) + 1;
      ledger.networkFetchCircuitLastOpenedAt = new Date(now).toISOString();
    }
  }

  return {
    consecutiveFailures: count,
    maxConsecutiveFailures: limit,
    circuitOpen,
    error: summary
  };
}

/**
 * A successful market response closes only the current failure streak. Past
 * failures and circuit-break counts remain as operational evidence.
 */
export function recordMomentumShadowFetchSuccess(ledger) {
  if (!ledger || typeof ledger !== 'object') {
    return { consecutiveFailures: 0, circuitOpen: false };
  }
  ledger.networkFetchFailureStreak = 0;
  ledger.networkFetchCircuitOpen = false;
  return { consecutiveFailures: 0, circuitOpen: false };
}
