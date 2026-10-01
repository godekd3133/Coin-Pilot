export const DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS = 90;
export const MARKET_QUOTE_FUTURE_TOLERANCE_MS = 5_000;

function normalizeTimestamp(value) {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (typeof value === 'string' && value.trim() && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

/** Validate an Upbit ticker's market, price, and last-trade timestamp at use time. */
export function inspectMarketQuoteFreshness(ticker, options = {}) {
  const nowValue = options.now instanceof Date ? options.now.getTime() : Number(options.now ?? Date.now());
  const now = Number.isFinite(nowValue) ? nowValue : Date.now();
  const configuredMaximumAge = Number(options.maximumAgeSeconds);
  const maximumAgeSeconds = Number.isFinite(configuredMaximumAge) && configuredMaximumAge > 0
    ? configuredMaximumAge
    : DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS;
  const maximumAgeMs = maximumAgeSeconds * 1000;
  const market = typeof ticker?.market === 'string' ? ticker.market : null;
  const expectedMarket = typeof options.expectedMarket === 'string' && options.expectedMarket.trim()
    ? options.expectedMarket.trim()
    : null;
  const price = Number(ticker?.trade_price);
  const sourceTimestamp = normalizeTimestamp(ticker?.trade_timestamp ?? ticker?.timestamp);
  const result = {
    fresh: false,
    market,
    sourceAsOf: sourceTimestamp === null ? null : new Date(sourceTimestamp).toISOString(),
    ageMs: sourceTimestamp === null ? null : now - sourceTimestamp,
    maximumAgeMs,
    reason: null
  };

  if (!market || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(market) || !Number.isFinite(price) || price <= 0) {
    return { ...result, reason: 'invalid_market_quote' };
  }
  if (expectedMarket !== null && market !== expectedMarket) {
    return { ...result, reason: 'market_quote_market_mismatch' };
  }
  if (sourceTimestamp === null) {
    return { ...result, reason: 'missing_market_source_timestamp' };
  }
  if (result.ageMs < -MARKET_QUOTE_FUTURE_TOLERANCE_MS) {
    return { ...result, reason: 'market_source_timestamp_in_future' };
  }
  if (result.ageMs > maximumAgeMs) {
    return { ...result, reason: 'market_source_stale' };
  }

  return { ...result, fresh: true, ageMs: Math.max(0, result.ageMs) };
}
