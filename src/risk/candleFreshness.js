const DEFAULT_CANDLE_AGE_FLOOR_SECONDS = 90;
const DEFAULT_CANDLE_AGE_BUFFER_SECONDS = 30;
const FUTURE_TIMESTAMP_TOLERANCE_SECONDS = 5;

function parseTimestamp(value, timezone = 'generic') {
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (!text) return null;

  // Upbit's candle_date_time_utc/kst values are commonly returned without a
  // zone suffix. Do not let the host machine's timezone change the result.
  let normalized = text;
  if (timezone === 'utc' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    normalized = `${normalized}Z`;
  } else if (timezone === 'kst' && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized)) {
    normalized = `${normalized}+09:00`;
  }

  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}
function getLatestCandleTimestamp(candle) {
  if (!candle || typeof candle !== 'object') return null;

  const utc = parseTimestamp(candle.candle_date_time_utc, 'utc');
  if (utc !== null) return { timestamp: utc, source: 'candle_date_time_utc' };

  const kst = parseTimestamp(candle.candle_date_time_kst, 'kst');
  if (kst !== null) return { timestamp: kst, source: 'candle_date_time_kst' };

  const generic = parseTimestamp(candle.timestamp);
  if (generic !== null) return { timestamp: generic, source: 'timestamp' };

  return null;
}

/**
 * Resolve the operational freshness budget for a live candle snapshot.
 *
 * A 1-minute candle can legitimately be almost one minute old because its
 * timestamp identifies the candle open. The additional 30-second buffer
 * covers request/clock jitter without accepting an entire extra candle by
 * default. A caller may provide a stricter positive value explicitly.
 */
export function resolveMaxCandleAgeSeconds(configuredValue, candleUnit = 1) {
  const configured = Number(configuredValue);
  if (Number.isFinite(configured) && configured > 0) {
    return configured;
  }

  const unit = Number(candleUnit);
  const normalizedUnit = Number.isFinite(unit) && unit > 0 ? unit : 1;
  return Math.max(
    DEFAULT_CANDLE_AGE_FLOOR_SECONDS,
    normalizedUnit * 60 + DEFAULT_CANDLE_AGE_BUFFER_SECONDS
  );
}

/**
 * Check whether the newest live candle is recent enough to authorize a
 * scalping entry. Missing/invalid timestamps fail closed because a real
 * Upbit candle response must carry one of the supported time fields.
 */
export function inspectLatestCandleFreshness(candles, options = {}) {
  const {
    candleUnit = 1,
    maxAgeSeconds,
    now = Date.now()
  } = options;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const resolvedNow = Number.isFinite(nowMs) ? nowMs : Date.now();
  const resolvedMaxAgeSeconds = resolveMaxCandleAgeSeconds(maxAgeSeconds, candleUnit);
  const maxAgeMs = resolvedMaxAgeSeconds * 1000;
  const latest = Array.isArray(candles) ? candles[0] : null;
  const timestampInfo = getLatestCandleTimestamp(latest);

  const base = {
    valid: false,
    timestamp: null,
    source: null,
    ageMs: null,
    maxAgeMs,
    maxAgeSeconds: resolvedMaxAgeSeconds,
    reason: null
  };

  if (!timestampInfo) {
    return { ...base, reason: 'missing_candle_timestamp' };
  }

  const rawAgeMs = resolvedNow - timestampInfo.timestamp;
  if (rawAgeMs < -FUTURE_TIMESTAMP_TOLERANCE_SECONDS * 1000) {
    return {
      ...base,
      timestamp: new Date(timestampInfo.timestamp).toISOString(),
      source: timestampInfo.source,
      ageMs: rawAgeMs,
      reason: 'candle_timestamp_in_future'
    };
  }

  const ageMs = Math.max(0, rawAgeMs);
  const result = {
    ...base,
    timestamp: new Date(timestampInfo.timestamp).toISOString(),
    source: timestampInfo.source,
    ageMs,
    valid: ageMs <= maxAgeMs,
    reason: ageMs <= maxAgeMs ? null : 'stale_candle_snapshot'
  };
  return result;
}
