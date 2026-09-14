import {
  analyzeHistoricalCandleContinuity,
  historicalTimestampForCandle,
  normalizeHistoricalCandles
} from '../backtest/scalpingBacktest.js';

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function utcMinuteString(timestamp) {
  // Keep the UTC designator. Upbit's `candle_date_time_utc` examples may omit
  // it, but a synthetic row must not be reinterpreted as local time by a
  // generic Date parser.
  return new Date(timestamp).toISOString();
}

function closePrice(candle) {
  const close = Number(candle?.trade_price);
  return Number.isFinite(close) && close > 0 ? close : null;
}

/**
 * Convert an Upbit candle response into a chronological, de-duplicated list.
 *
 * Upbit returns newest-first data and omits a minute when no trade occurred.
 * This helper keeps the raw response semantics visible to the caller; it does
 * not synthesize candles by itself.
 */
function normalizeWithTimestamps(rawCandles) {
  const normalized = normalizeHistoricalCandles(rawCandles);
  const byTimestamp = new Map();
  const invalidCandles = [];
  const duplicateTimestamps = [];

  for (const candle of normalized) {
    const timestamp = historicalTimestampForCandle(candle);
    if (timestamp === null) {
      invalidCandles.push(candle);
      continue;
    }
    if (byTimestamp.has(timestamp)) duplicateTimestamps.push(timestamp);
    byTimestamp.set(timestamp, { candle, timestamp });
  }

  const entries = [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  return { entries, invalidCandles, duplicateTimestamps };
}

/**
 * Fill only intervals that are explicitly explainable as no-trade periods.
 *
 * The Upbit minute-candle contract says that a candle is absent when there
 * were no executions in that interval. For a research replay, representing
 * that interval as a flat candle with zero volume preserves elapsed time for
 * RSI/rolling windows and max-hold exits without inventing a price movement.
 * The returned metadata is intentionally marked diagnostic-only. Callers
 * must not use this output as the live promotion artifact.
 *
 * Gaps with non-aligned timestamps or beyond maxFillIntervals remain
 * unfilled and therefore fail the normal historical continuity guard.
 */
export function fillNoTradeCandleGaps(rawCandles, candleUnit = 1, options = {}) {
  const expectedIntervalSeconds = Number(candleUnit) * 60;
  const expectedIntervalMs = expectedIntervalSeconds * 1000;
  const { entries, invalidCandles, duplicateTimestamps } = normalizeWithTimestamps(rawCandles);
  const maxFillIntervals = Math.max(
    0,
    Math.floor(number(options.maxFillIntervals, Number.MAX_SAFE_INTEGER))
  );
  const filledCandles = [];
  const gapDetails = [];
  let syntheticNoTradeCount = 0;
  let unfilledGapCount = 0;
  let unfilledIntervalCount = 0;
  let nonAlignedGapCount = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    if (index > 0) {
      const previous = entries[index - 1];
      const gapMs = current.timestamp - previous.timestamp;
      const missingIntervals = gapMs > 0 && gapMs % expectedIntervalMs === 0
        ? Math.max(0, Math.floor(gapMs / expectedIntervalMs) - 1)
        : null;
      if (gapMs <= 0) {
        unfilledGapCount += 1;
        gapDetails.push({
          previousTimestamp: utcMinuteString(previous.timestamp),
          timestamp: utcMinuteString(current.timestamp),
          gapSeconds: gapMs / 1000,
          missingIntervals: null,
          filledIntervals: 0,
          reason: 'historical_candle_timestamps_not_increasing'
        });
      } else if (missingIntervals === null) {
        nonAlignedGapCount += 1;
        unfilledGapCount += 1;
        gapDetails.push({
          previousTimestamp: utcMinuteString(previous.timestamp),
          timestamp: utcMinuteString(current.timestamp),
          gapSeconds: gapMs / 1000,
          missingIntervals: null,
          filledIntervals: 0,
          reason: 'historical_candle_gap_not_aligned_to_unit'
        });
      } else if (missingIntervals > 0) {
        const canFill = missingIntervals <= maxFillIntervals && closePrice(previous.candle) !== null;
        if (canFill) {
          const previousClose = closePrice(previous.candle);
          for (let missingIndex = 1; missingIndex <= missingIntervals; missingIndex += 1) {
            const syntheticTimestamp = previous.timestamp + (expectedIntervalMs * missingIndex);
            filledCandles.push({
              candle_date_time_utc: utcMinuteString(syntheticTimestamp),
              opening_price: previousClose,
              high_price: previousClose,
              low_price: previousClose,
              trade_price: previousClose,
              candle_acc_trade_volume: 0,
              candle_acc_trade_price: 0,
              isSyntheticNoTrade: true
            });
            syntheticNoTradeCount += 1;
          }
        } else {
          unfilledGapCount += 1;
          unfilledIntervalCount += missingIntervals;
        }
        gapDetails.push({
          previousTimestamp: utcMinuteString(previous.timestamp),
          timestamp: utcMinuteString(current.timestamp),
          gapSeconds: gapMs / 1000,
          missingIntervals,
          filledIntervals: canFill ? missingIntervals : 0,
          reason: canFill ? 'no_trade_intervals_filled' : 'no_trade_gap_not_filled'
        });
      }
    }
    filledCandles.push({ ...current.candle });
  }

  const dataQuality = analyzeHistoricalCandleContinuity(filledCandles, candleUnit);
  const validForReplay = invalidCandles.length === 0 &&
    duplicateTimestamps.length === 0 &&
    unfilledGapCount === 0 &&
    dataQuality.valid;
  return {
    candles: filledCandles,
    dataQuality: {
      source: 'upbit_minute_candles',
      mode: 'no_trade_flat_fill_research_only',
      diagnosticOnly: true,
      promotionEligible: false,
      validForReplay,
      rawCandleCount: Array.isArray(rawCandles) ? rawCandles.length : 0,
      normalizedCandleCount: entries.length,
      filledCandleCount: filledCandles.length,
      syntheticNoTradeCount,
      gapCount: gapDetails.filter(gap => gap.missingIntervals > 0).length,
      filledGapCount: gapDetails.filter(gap => gap.filledIntervals > 0).length,
      unfilledGapCount,
      unfilledIntervalCount,
      nonAlignedGapCount,
      invalidTimestampCount: invalidCandles.length,
      duplicateTimestampCount: duplicateTimestamps.length,
      maxFillIntervals,
      gapDetails: gapDetails.slice(0, 100),
      truncatedGapCount: Math.max(0, gapDetails.length - 100),
      continuityAfterFill: dataQuality
    }
  };
}
