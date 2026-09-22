function closeOf(candle) {
  const value = Number(candle?.trade_price ?? candle?.close ?? candle?.c);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Calculate sample standard deviation of completed minute close-to-close
 * returns immediately before `index`. The candle at `index` and every later
 * candle are excluded so entry sizing cannot consume the move it is about to
 * trade.
 */
export function calculateScalpingCloseVolatilityPercent(
  candles,
  index,
  lookbackCandles = 20
) {
  if (!Array.isArray(candles)) return null;
  const normalizedIndex = Math.floor(Number(index));
  const lookback = Math.max(2, Math.floor(Number(lookbackCandles) || 20));
  if (!Number.isInteger(normalizedIndex) || normalizedIndex < lookback + 1) return null;

  const returns = [];
  for (let returnIndex = normalizedIndex - lookback; returnIndex < normalizedIndex; returnIndex += 1) {
    const previousClose = closeOf(candles[returnIndex - 1]);
    const currentClose = closeOf(candles[returnIndex]);
    if (previousClose === null || currentClose === null) return null;
    returns.push(((currentClose / previousClose) - 1) * 100);
  }
  if (returns.length < lookback) return null;

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + ((value - mean) ** 2), 0) /
    (returns.length - 1);
  return Math.sqrt(variance);
}

/**
 * Convert completed-bar volatility to a capped size multiplier. A non-positive
 * target explicitly preserves the legacy fixed-size contract. When the target
 * is active, volatility above it can only reduce exposure; it never increases
 * the configured investment ratio.
 */
export function calculateScalpingVolatilityPositionScale(volatilityPercent, targetPercent) {
  const target = Number(targetPercent);
  if (!Number.isFinite(target) || target <= 0) return 1;
  const volatility = Number(volatilityPercent);
  if (!Number.isFinite(volatility) || volatility <= 0) return 1;
  return Math.min(1, target / volatility);
}

/**
 * Resolve the research-only sizing decision for one potential entry. An
 * enabled overlay with unavailable history is unavailable rather than silently
 * falling back to a full-size entry.
 */
export function resolveScalpingVolatilitySizing({
  candles,
  index,
  lookbackCandles = 20,
  targetPercent = 0
} = {}) {
  const target = Number(targetPercent);
  if (!Number.isFinite(target) || target <= 0) {
    return {
      enabled: false,
      available: true,
      volatilityPercent: null,
      scale: 1,
      reason: 'volatility_target_disabled'
    };
  }

  const volatilityPercent = calculateScalpingCloseVolatilityPercent(
    candles,
    index,
    lookbackCandles
  );
  if (volatilityPercent === null) {
    return {
      enabled: true,
      available: false,
      volatilityPercent: null,
      scale: null,
      reason: 'volatility_history_unavailable'
    };
  }

  const scale = calculateScalpingVolatilityPositionScale(volatilityPercent, target);
  return {
    enabled: true,
    available: true,
    volatilityPercent,
    scale,
    reason: scale < 1 ? 'volatility_scaled' : 'volatility_at_or_below_target'
  };
}
