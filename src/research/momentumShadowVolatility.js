function closeOf(candle) {
  const value = Number(candle?.trade_price ?? candle?.close ?? candle?.c);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Calculate the completed-bar close-to-close volatility immediately before
 * `index`. The current bar is intentionally excluded so entry sizing cannot
 * consume the return it is about to act on.
 */
export function calculateCloseVolatilityPercent(candles, index, lookbackDays = 14) {
  if (!Array.isArray(candles)) return null;
  const normalizedIndex = Math.floor(Number(index));
  const lookback = Math.max(2, Math.floor(Number(lookbackDays) || 14));
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
 * Convert realized volatility to a capped position-size multiplier. A null
 * target disables the overlay and returns the legacy multiplier of 1.
 */
export function calculateVolatilityPositionScale(volatilityPercent, targetPercent) {
  const target = Number(targetPercent);
  if (!Number.isFinite(target) || target <= 0) return 1;
  const volatility = Number(volatilityPercent);
  if (!Number.isFinite(volatility) || volatility <= 0) return 1;
  return Math.min(1, target / volatility);
}
