/**
 * Resolve the optional benchmark gate used by a momentum shadow runner.
 * Missing benchmark data closes the entry gate; it never silently becomes a
 * passing benchmark observation.
 */
export function getMomentumShadowBenchmarkGate(
  seriesByMarket,
  benchmarkMarket = null,
  index = -1,
  minimumTrendPercent = 0,
  lookbackDays = 7
) {
  if (!benchmarkMarket) {
    return {
      configured: false,
      available: true,
      gateOpen: true,
      trendPercent: null,
      reason: null
    };
  }
  const bars = seriesByMarket?.[benchmarkMarket];
  const lookback = Math.max(1, Math.floor(Number(lookbackDays) || 7));
  const currentIndex = Number.isInteger(index) && index >= 0 ? index : (bars?.length || 0) - 1;
  if (!Array.isArray(bars) || currentIndex < lookback || !bars[currentIndex] || !bars[currentIndex - lookback]) {
    return {
      configured: true,
      available: false,
      gateOpen: false,
      trendPercent: null,
      reason: 'benchmark_data_unavailable'
    };
  }
  const from = Number(bars[currentIndex - lookback].trade_price);
  const to = Number(bars[currentIndex].trade_price);
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) {
    return {
      configured: true,
      available: false,
      gateOpen: false,
      trendPercent: null,
      reason: 'benchmark_price_invalid'
    };
  }
  const trendPercent = ((to - from) / from) * 100;
  return {
    configured: true,
    available: true,
    gateOpen: trendPercent > Number(minimumTrendPercent || 0),
    trendPercent,
    reason: null
  };
}
