import { analyzeHistoricalCandleContinuity } from '../backtest/scalpingBacktest.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function timestampOf(candle) {
  const raw = candle?.ts ?? candle?.candle_date_time_utc ?? candle?.timestamp;
  if (raw instanceof Date) return raw.getTime();
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const text = raw.trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A daily bar is usable evidence only once its full UTC day has elapsed.
 * Comparing each candle's open+1d to the observation timestamp — instead of
 * matching a calendar date — keeps a response that crosses the UTC midnight
 * boundary from promoting the newly-forming candle or dropping the bar that
 * just closed.
 */
export function isMomentumShadowDailyCandleComplete(candle, nowMs) {
  const openMs = timestampOf(candle);
  const cutoff = Number(nowMs);
  if (openMs === null || !Number.isFinite(cutoff)) return false;
  return openMs + DAY_MS <= cutoff;
}

/**
 * Validate the shared completed-daily grid consumed by a momentum shadow
 * cycle. A missing/stale market must not silently reduce breadth and make a
 * partial response look like a valid portfolio signal.
 */
export function assessMomentumShadowDailyGrid(
  seriesByMarket = {},
  markets = [],
  { now = Date.now(), maxAgeHours = 36 } = {}
) {
  const selectedMarkets = [...new Set(Array.isArray(markets) ? markets : [])];
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const maxAgeMs = Number.isFinite(Number(maxAgeHours)) && Number(maxAgeHours) > 0
    ? Number(maxAgeHours) * 60 * 60 * 1000
    : null;
  const latestByMarket = {};
  const latestAgeSecondsByMarket = {};
  const continuityByMarket = {};
  const missingMarkets = [];
  const invalidMarkets = [];
  const staleMarkets = [];

  for (const market of selectedMarkets) {
    const candles = seriesByMarket?.[market];
    if (!Array.isArray(candles) || candles.length === 0) {
      missingMarkets.push(market);
      continue;
    }
    const continuityCandles = candles.map(candle => candle?.candle_date_time_utc ||
      candle?.timestamp
      ? candle
      : { ...candle, candle_date_time_utc: candle?.ts });
    const continuity = analyzeHistoricalCandleContinuity(continuityCandles, 1440);
    continuityByMarket[market] = continuity;
    if (!continuity.valid) invalidMarkets.push({ market, reason: continuity.reason });
    const latest = timestampOf(candles.at(-1));
    latestByMarket[market] = latest === null ? null : new Date(latest).toISOString();
    if (latest === null) {
      if (!invalidMarkets.some(entry => entry.market === market)) {
        invalidMarkets.push({ market, reason: 'latest_timestamp_missing' });
      }
    } else if (maxAgeMs !== null) {
      const ageSeconds = Math.max(0, Math.round((nowMs - latest) / 1000));
      latestAgeSecondsByMarket[market] = ageSeconds;
      if (ageSeconds * 1000 > maxAgeMs) {
        staleMarkets.push(market);
        if (!invalidMarkets.some(entry => entry.market === market)) {
          invalidMarkets.push({ market, reason: 'daily_market_stale' });
        }
      }
    }
  }

  const latestTimestamps = Object.values(latestByMarket).filter(Boolean);
  const latestTimestamp = latestTimestamps[0] || null;
  const unalignedMarkets = Object.entries(latestByMarket)
    .filter(([, timestamp]) => timestamp !== latestTimestamp)
    .map(([market]) => market);
  const valid = selectedMarkets.length > 0 &&
    missingMarkets.length === 0 &&
    invalidMarkets.length === 0 &&
    unalignedMarkets.length === 0;
  const reason = valid
    ? 'daily_grid_aligned_and_contiguous'
    : missingMarkets.length > 0
      ? 'daily_market_missing'
      : staleMarkets.length > 0
        ? 'daily_market_stale'
      : invalidMarkets.length > 0
        ? 'daily_market_grid_not_contiguous'
        : 'daily_market_latest_timestamp_mismatch';

  return {
    valid,
    reason,
    marketCount: selectedMarkets.length,
    missingMarkets,
    invalidMarkets,
    unalignedMarkets,
    staleMarkets,
    latestTimestamp,
    latestByMarket,
    latestAgeSecondsByMarket,
    maxAgeHours: maxAgeMs === null ? null : maxAgeMs / (60 * 60 * 1000),
    continuityByMarket
  };
}
