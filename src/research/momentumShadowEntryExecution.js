const DAY_MS = 24 * 60 * 60 * 1000;

function timestampOf(value) {
  const text = String(value ?? '');
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function priceOf(value) {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : null;
}

function timestampKey(candle) {
  return candle?.ts ?? candle?.candle_date_time_utc ?? candle?.timestamp ?? null;
}

function openPriceOf(candle) {
  return priceOf(candle?.opening_price ?? candle?.open ?? candle?.o);
}

/**
 * Resolve the only valid next-open fill for a completed-candle signal.
 *
 * A currently forming daily candle may expose its immutable opening price
 * before it becomes part of the completed-bar series. That observation is
 * accepted when its timestamp is exactly one day after the signal. If the
 * expected candle has already passed without a valid open, the pending order
 * is terminally invalid and must not be filled at a later candle.
 *
 * A completed candle at the expected timestamp is a valid retroactive fill
 * only while it remains the latest completed bar: that bounds the backdated
 * entry to less than one candle and keeps every exit evaluation observable.
 * When the grid has already advanced past the expected candle, the fill
 * window was missed during downtime and the entry must void fail-closed
 * rather than fabricate a hold whose intermediate exits were never checked.
 */
export function resolveMomentumShadowNextOpenFill({
  bars,
  signalKey,
  currentOpen = null
} = {}) {
  if (!Array.isArray(bars) || !bars.length) {
    return { available: false, terminal: false, reason: 'next_open_not_observed' };
  }
  const signalTimestamp = timestampOf(signalKey);
  if (signalTimestamp === null) {
    return { available: false, terminal: true, reason: 'signal_timestamp_invalid' };
  }
  const expectedTimestamp = signalTimestamp + DAY_MS;
  const currentTimestamp = timestampOf(currentOpen?.ts ?? currentOpen?.timestamp);
  const currentPrice = openPriceOf(currentOpen);
  if (currentTimestamp === expectedTimestamp) {
    if (currentPrice === null) {
      return { available: false, terminal: true, reason: 'next_open_price_missing' };
    }
    return {
      available: true,
      terminal: false,
      reason: 'next_open_current_candle',
      entryTimestamp: currentOpen.ts ?? currentOpen.timestamp,
      entryPrice: currentPrice
    };
  }

  const latestBar = bars.at(-1);
  const latestTimestamp = timestampOf(timestampKey(latestBar));
  if (latestTimestamp === expectedTimestamp) {
    const entryPrice = openPriceOf(latestBar);
    if (entryPrice === null) {
      return { available: false, terminal: true, reason: 'next_open_price_missing' };
    }
    return {
      available: true,
      terminal: false,
      reason: 'next_open_completed_candle',
      entryTimestamp: timestampKey(latestBar),
      entryPrice
    };
  }

  if (latestTimestamp !== null && latestTimestamp > expectedTimestamp) {
    const expectedCandleExists = bars.some(
      candle => timestampOf(timestampKey(candle)) === expectedTimestamp
    );
    return {
      available: false,
      terminal: true,
      reason: expectedCandleExists
        ? 'next_open_fill_window_missed'
        : 'next_open_candle_missing'
    };
  }
  return { available: false, terminal: false, reason: 'next_open_not_observed' };
}

export function resolveMomentumShadowEntryExecution(value) {
  return value === 'next_open' ? 'next_open' : 'close';
}
