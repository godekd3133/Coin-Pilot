function parseUtcTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function incompleteHistoryError(message) {
  const error = new Error(message);
  error.code = 'CANDLE_HISTORY_INCOMPLETE';
  return error;
}

/**
 * Fetch exactly the requested Upbit newest-first candle history, rejecting
 * short pages, invalid cursors, overlap, duplicates, or incorrect page order.
 */
export async function fetchCompleteUpbitCandleHistory({
  marketDataClient,
  market,
  intervalMinutes,
  totalCount,
  maxPerRequest = 200,
  requestSpacingMs = 0,
  sleepImpl = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
} = {}) {
  if (typeof marketDataClient?.getMinuteCandles !== 'function') {
    throw new TypeError('marketDataClient must provide getMinuteCandles');
  }
  if (typeof market !== 'string' || !market.trim()) throw new TypeError('market must be provided');
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 1) {
    throw new RangeError('intervalMinutes must be a positive safe integer');
  }
  if (!Number.isSafeInteger(totalCount) || totalCount < 1) {
    throw new RangeError('totalCount must be a positive safe integer');
  }
  if (!Number.isSafeInteger(maxPerRequest) || maxPerRequest < 1 || maxPerRequest > 200) {
    throw new RangeError('maxPerRequest must be between 1 and 200');
  }
  if (!Number.isFinite(requestSpacingMs) || requestSpacingMs < 0) {
    throw new RangeError('requestSpacingMs must be a non-negative finite number');
  }

  const candles = [];
  const seenTimestamps = new Set();
  let cursor = null;
  let previousOldestTimestamp = null;

  while (candles.length < totalCount) {
    const requestedPageSize = Math.min(maxPerRequest, totalCount - candles.length);
    const page = cursor === null
      ? await marketDataClient.getMinuteCandles(market, intervalMinutes, requestedPageSize)
      : await marketDataClient.getMinuteCandles(market, intervalMinutes, requestedPageSize, { to: cursor });

    if (!Array.isArray(page) || page.length !== requestedPageSize) {
      throw incompleteHistoryError(
        `expected ${requestedPageSize} candles for ${market}/${intervalMinutes}m page, received ${Array.isArray(page) ? page.length : 'invalid response'}`
      );
    }

    const pageTimestamps = page.map(candle => parseUtcTimestamp(candle?.candle_date_time_utc));
    if (pageTimestamps.some(timestamp => timestamp === null)) {
      throw incompleteHistoryError(`invalid candle timestamp for ${market}/${intervalMinutes}m page`);
    }
    for (let index = 1; index < pageTimestamps.length; index += 1) {
      if (pageTimestamps[index] >= pageTimestamps[index - 1]) {
        throw incompleteHistoryError(`Upbit candle page is not strictly newest-first for ${market}/${intervalMinutes}m`);
      }
    }
    if (previousOldestTimestamp !== null && pageTimestamps[0] >= previousOldestTimestamp) {
      throw incompleteHistoryError(`Upbit candle cursor did not advance for ${market}/${intervalMinutes}m`);
    }
    for (const timestamp of pageTimestamps) {
      if (seenTimestamps.has(timestamp)) {
        throw incompleteHistoryError(`duplicate candle timestamp for ${market}/${intervalMinutes}m`);
      }
      seenTimestamps.add(timestamp);
    }

    const oldestCandle = page[page.length - 1];
    const nextCursor = oldestCandle?.candle_date_time_utc;
    if (typeof nextCursor !== 'string' || !nextCursor.trim()) {
      throw incompleteHistoryError(`missing Upbit candle cursor for ${market}/${intervalMinutes}m`);
    }
    candles.push(...page);
    cursor = nextCursor;
    previousOldestTimestamp = pageTimestamps[pageTimestamps.length - 1];

    if (candles.length < totalCount && requestSpacingMs > 0) await sleepImpl(requestSpacingMs);
  }

  return candles;
}
