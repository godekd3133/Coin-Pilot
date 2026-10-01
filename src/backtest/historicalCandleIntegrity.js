// 역사적 캔들 무결성 — 타임스탬프 정규화, 연속성 감사, 세그먼트 분할.
// scalpingBacktest.js에서 추출; 시뮬레이션은 이 모듈의 경계를 소비한다.
import { number } from './numeric.js';

export function parseHistoricalTimestampValue(raw, timezone = 'generic') {
  if (raw instanceof Date) {
    const timestamp = raw.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  // Upbit candle `timestamp` fields are epoch milliseconds. A number must be
  // accepted directly: routing it through Date.parse(String(raw)) always
  // produces NaN and silently discards otherwise valid rows.
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw !== 'string') return null;

  const text = raw.trim();
  if (!text) return null;
  // A digit-only string is the same epoch-ms value serialized as text. The
  // magnitude floor keeps short digit strings (bare years, counters) on the
  // normal date-parser path instead of turning them into 1970-era rows.
  if (/^\d+$/.test(text)) {
    const numeric = Number(text);
    if (Number.isFinite(numeric) && numeric >= 100_000_000_000) return numeric;
  }
  const normalized = !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text)
    ? timezone === 'utc'
      ? `${text}Z`
      : timezone === 'kst'
        ? `${text}+09:00`
        : text
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function historicalTimestampForCandle(candle) {
  // Truthiness matches the original `utc || kst || timestamp` chain: a falsy
  // field must not shadow a usable value in a lower-priority field.
  if (candle?.candle_date_time_utc) {
    return parseHistoricalTimestampValue(candle.candle_date_time_utc, 'utc');
  }
  if (candle?.candle_date_time_kst) {
    return parseHistoricalTimestampValue(candle.candle_date_time_kst, 'kst');
  }
  return parseHistoricalTimestampValue(candle?.timestamp);
}

export function candleTime(candle, fallback) {
  return historicalTimestampForCandle(candle) ?? fallback;
}

/**
 * Historical API responses are normally newest-first. The simulator normalizes
 * them to chronological order so that an entry can only consume future OHLC.
 */

export function normalizeHistoricalCandles(candles) {
  if (!Array.isArray(candles)) return [];

  const normalized = candles
    .filter(candle => Number.isFinite(number(candle?.trade_price)));

  if (normalized.length < 2) return normalized;

  const firstTime = candleTime(normalized[0], 0);
  const lastTime = candleTime(normalized[normalized.length - 1], 0);
  if (firstTime && lastTime && firstTime > lastTime) {
    return normalized.slice().reverse();
  }
  return normalized.slice();
}

/**
 * Check whether historical candles preserve the configured time interval.
 *
 * Exchange APIs may omit candles for illiquid markets. The simulator cannot
 * infer the missing price path or risk checks, so a gap is reported as an
 * invalid evidence window instead of silently compressing elapsed time into
 * adjacent array indexes.
 */

export function analyzeHistoricalCandleContinuity(rawCandles, candleUnit = 1, options = {}) {
  const candles = normalizeHistoricalCandles(rawCandles);
  const expectedIntervalSeconds = Number(candleUnit) * 60;
  if (!Number.isFinite(expectedIntervalSeconds) || expectedIntervalSeconds <= 0) {
    return {
      valid: false,
      reason: 'historical_candle_unit_invalid',
      candleCount: candles.length,
      expectedIntervalSeconds: null,
      maxGapSeconds: null,
      timestampCount: 0,
      missingTimestampCount: candles.length,
      gapCount: 0,
      missingIntervalCount: 0,
      largestGapSeconds: null,
      firstTimestamp: null,
      lastTimestamp: null
    };
  }

  const configuredMaxGapSeconds = Number(options.maxGapSeconds);
  const maxGapSeconds = Number.isFinite(configuredMaxGapSeconds) && configuredMaxGapSeconds > 0
    ? configuredMaxGapSeconds
    : expectedIntervalSeconds * 1.5;
  const timestamps = candles.map(historicalTimestampForCandle);
  const missingTimestampCount = timestamps.filter(timestamp => timestamp === null).length;
  const gaps = [];
  let nonIncreasingCount = 0;
  let missingIntervalCount = 0;

  for (let index = 1; index < timestamps.length; index += 1) {
    const previous = timestamps[index - 1];
    const current = timestamps[index];
    if (previous === null || current === null) continue;
    const gapSeconds = (current - previous) / 1000;
    if (gapSeconds <= 0) {
      nonIncreasingCount += 1;
      continue;
    }
    if (gapSeconds > maxGapSeconds) {
      gaps.push({
        index,
        previousTimestamp: new Date(previous).toISOString(),
        timestamp: new Date(current).toISOString(),
        gapSeconds,
        missingIntervals: Math.max(0, Math.floor(gapSeconds / expectedIntervalSeconds) - 1)
      });
      missingIntervalCount += Math.max(0, Math.floor(gapSeconds / expectedIntervalSeconds) - 1);
    }
  }

  const largestGapSeconds = gaps.length > 0
    ? Math.max(...gaps.map(gap => gap.gapSeconds))
    : 0;
  const firstTimestamp = timestamps.find(timestamp => timestamp !== null) || null;
  const lastTimestamp = [...timestamps].reverse().find(timestamp => timestamp !== null) || null;
  const valid = missingTimestampCount === 0 && nonIncreasingCount === 0 && gaps.length === 0;
  const reason = valid
    ? 'historical_candles_contiguous'
    : missingTimestampCount > 0
      ? 'historical_candle_timestamp_missing_or_invalid'
      : nonIncreasingCount > 0
        ? 'historical_candle_timestamps_not_increasing'
        : 'historical_candle_gap';

  return {
    valid,
    reason,
    candleCount: candles.length,
    expectedIntervalSeconds,
    maxGapSeconds,
    timestampCount: candles.length - missingTimestampCount,
    missingTimestampCount,
    nonIncreasingCount,
    gapCount: gaps.length,
    missingIntervalCount,
    largestGapSeconds,
    firstTimestamp: firstTimestamp ? new Date(firstTimestamp).toISOString() : null,
    lastTimestamp: lastTimestamp ? new Date(lastTimestamp).toISOString() : null,
    gaps: gaps.slice(0, 20),
    truncatedGapCount: Math.max(0, gaps.length - 20)
  };
}

/**
 * Split a historical window at every candle-time discontinuity.
 *
 * This helper deliberately does not fill missing candles. Each returned
 * segment can be replayed independently, while the boundary metadata remains
 * available to a diagnostic caller that needs to explain discarded evidence.
 */

export function splitHistoricalCandleSegments(rawCandles, candleUnit = 1, options = {}) {
  const candles = normalizeHistoricalCandles(rawCandles);
  const dataQuality = analyzeHistoricalCandleContinuity(candles, candleUnit, {
    maxGapSeconds: options.maxGapSeconds ?? options.maxHistoricalCandleGapSeconds
  });
  const expectedIntervalSeconds = Number(candleUnit) * 60;
  const configuredMaxGapSeconds = Number(options.maxGapSeconds ?? options.maxHistoricalCandleGapSeconds);
  const maxGapSeconds = Number.isFinite(configuredMaxGapSeconds) && configuredMaxGapSeconds > 0
    ? configuredMaxGapSeconds
    : expectedIntervalSeconds * 1.5;
  const minimumSegmentCandles = Math.max(1, Math.floor(number(options.minimumSegmentCandles, 200)));
  const segments = [];
  const excludedSegments = [];
  const boundaries = [];
  let segmentStart = 0;
  let nextSegmentIndex = 0;

  const addSegment = (startIndex, endIndex, reason = null) => {
    const segmentCandles = candles.slice(startIndex, endIndex);
    const segmentIndex = nextSegmentIndex;
    nextSegmentIndex += 1;
    const descriptor = {
      segmentIndex,
      startIndex,
      endIndex,
      candleCount: segmentCandles.length,
      firstTimestamp: historicalTimestampForCandle(segmentCandles[0]),
      lastTimestamp: historicalTimestampForCandle(segmentCandles.at(-1)),
      boundaryReason: reason
    };
    if (segmentCandles.length >= minimumSegmentCandles) {
      segments.push({
        candles: segmentCandles,
        ...descriptor,
        firstTimestamp: descriptor.firstTimestamp
          ? new Date(descriptor.firstTimestamp).toISOString()
          : null,
        lastTimestamp: descriptor.lastTimestamp
          ? new Date(descriptor.lastTimestamp).toISOString()
          : null
      });
    } else if (segmentCandles.length > 0) {
      excludedSegments.push({
        ...descriptor,
        reason: reason || 'segment_below_minimum_candles',
        firstTimestamp: descriptor.firstTimestamp
          ? new Date(descriptor.firstTimestamp).toISOString()
          : null,
        lastTimestamp: descriptor.lastTimestamp
          ? new Date(descriptor.lastTimestamp).toISOString()
          : null
      });
    }
  };

  for (let index = 1; index <= candles.length; index += 1) {
    if (index === candles.length) {
      addSegment(segmentStart, index);
      break;
    }

    const previousTimestamp = historicalTimestampForCandle(candles[index - 1]);
    const currentTimestamp = historicalTimestampForCandle(candles[index]);
    const gapSeconds = previousTimestamp !== null && currentTimestamp !== null
      ? (currentTimestamp - previousTimestamp) / 1000
      : null;
    const boundary = previousTimestamp === null || currentTimestamp === null
      ? { reason: 'historical_candle_timestamp_missing_or_invalid', gapSeconds: null }
      : gapSeconds <= 0
        ? { reason: 'historical_candle_timestamps_not_increasing', gapSeconds }
        : gapSeconds > maxGapSeconds
          ? { reason: 'historical_candle_gap', gapSeconds }
          : null;
    if (!boundary) continue;

    boundaries.push({
      index,
      previousTimestamp: previousTimestamp ? new Date(previousTimestamp).toISOString() : null,
      timestamp: currentTimestamp ? new Date(currentTimestamp).toISOString() : null,
      gapSeconds,
      reason: boundary.reason
    });
    addSegment(segmentStart, index, boundary.reason);
    segmentStart = index;
  }

  return {
    candleCount: candles.length,
    candleUnit,
    expectedIntervalSeconds,
    maxGapSeconds,
    minimumSegmentCandles,
    dataQuality,
    segments,
    excludedSegments,
    boundaries,
    boundaryCount: boundaries.length,
    excludedSegmentCount: excludedSegments.length,
    source: 'historical_candle_continuity_segments'
  };
}

/**
 * Precompute the candle-local features that do not change across most tuning
 * candidates. The previous implementation recalculated short rolling windows
 * inside every candidate simulation, making a 20,736-candidate grid needlessly
 * expensive. Thresholds and signal profiles remain evaluated per candidate;
 * only their shared inputs are cached here.
 */
