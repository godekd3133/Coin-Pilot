function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Project the best bid/ask level from an Upbit orderbook response. This is a
 * quote-quality observation only; it does not represent a fill or wallet
 * settlement.
 */
export function projectMomentumShadowQuote(market, orderbook = {}) {
  const unit = orderbook?.orderbook_units?.[0] || orderbook;
  const bidPrice = finitePositive(unit?.bid_price ?? unit?.bidPrice);
  const askPrice = finitePositive(unit?.ask_price ?? unit?.askPrice);
  const bidSize = finitePositive(unit?.bid_size ?? unit?.bidSize);
  const askSize = finitePositive(unit?.ask_size ?? unit?.askSize);
  const midpoint = bidPrice !== null && askPrice !== null
    ? (bidPrice + askPrice) / 2
    : null;
  const spreadPercent = midpoint !== null && midpoint > 0
    ? ((askPrice - bidPrice) / midpoint) * 100
    : null;
  const timestamp = Number(orderbook?.timestamp);

  return {
    market,
    available: bidPrice !== null && askPrice !== null && askPrice >= bidPrice,
    bidPrice,
    askPrice,
    bidSize,
    askSize,
    spreadPercent,
    timestamp: Number.isFinite(timestamp) ? timestamp : null
  };
}

/**
 * Validate a batch of best-bid/best-ask observations against an optional
 * maximum spread. When enabled, a missing or invalid quote makes the whole
 * entry grid invalid so a partial orderbook response cannot select a market.
 */
export function assessMomentumShadowQuoteQuality({
  markets = [],
  quotes = {},
  maxSpreadPercent = 0,
  error = null
} = {}) {
  const selectedMarkets = [...new Set(Array.isArray(markets) ? markets : [])];
  const ceiling = Number.isFinite(Number(maxSpreadPercent)) && Number(maxSpreadPercent) > 0
    ? Number(maxSpreadPercent)
    : 0;
  const missingMarkets = [];
  const invalidMarkets = [];
  const blockedMarkets = [];
  const byMarket = {};

  for (const market of selectedMarkets) {
    const quote = quotes?.[market];
    if (!quote) {
      missingMarkets.push(market);
      continue;
    }
    byMarket[market] = quote;
    if (quote.available !== true || !Number.isFinite(Number(quote.spreadPercent))) {
      invalidMarkets.push(market);
      continue;
    }
    if (ceiling > 0 && Number(quote.spreadPercent) > ceiling) {
      blockedMarkets.push(market);
    }
  }

  const valid = ceiling === 0 || (
    selectedMarkets.length > 0 &&
    missingMarkets.length === 0 &&
    invalidMarkets.length === 0 &&
    blockedMarkets.length === 0 &&
    !error
  );
  const reason = ceiling === 0
    ? 'orderbook_guard_disabled'
    : error
      ? 'orderbook_request_failed'
    : missingMarkets.length > 0
      ? 'orderbook_market_missing'
      : invalidMarkets.length > 0
        ? 'orderbook_quote_invalid'
        : blockedMarkets.length > 0
          ? 'orderbook_spread_above_limit'
          : 'orderbook_quotes_within_spread_limit';

  return {
    enabled: ceiling > 0,
    valid,
    reason,
    maxSpreadPercent: ceiling,
    marketCount: selectedMarkets.length,
    missingMarkets,
    invalidMarkets,
    blockedMarkets,
    byMarket,
    error: error ? String(error) : null
  };
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Summarize repeated quote observations without treating them as fills or
 * profitability evidence. Missing markets remain visible in the summary.
 */
export function summarizeMomentumShadowQuoteSamples({
  markets = [],
  samples = [],
  maxSpreadPercent = 0
} = {}) {
  const selectedMarkets = [...new Set(Array.isArray(markets) ? markets : [])];
  const ceiling = Number.isFinite(Number(maxSpreadPercent)) && Number(maxSpreadPercent) > 0
    ? Number(maxSpreadPercent)
    : 0;
  const byMarket = Object.fromEntries(selectedMarkets.map(market => [market, []]));
  for (const sample of Array.isArray(samples) ? samples : []) {
    for (const quote of Array.isArray(sample?.quotes) ? sample.quotes : []) {
      if (Object.hasOwn(byMarket, quote.market) && Number.isFinite(Number(quote.spreadPercent))) {
        byMarket[quote.market].push(Number(quote.spreadPercent));
      }
    }
  }
  const summary = Object.fromEntries(selectedMarkets.map(market => {
    const values = byMarket[market];
    return [market, {
      sampleCount: values.length,
      median: quantile(values, 0.5),
      p95: quantile(values, 0.95),
      max: values.length ? Math.max(...values) : null,
      overCeiling: ceiling > 0 ? values.filter(value => value > ceiling).length : 0
    }];
  }));
  const allValues = Object.values(byMarket).flat();
  const complete = selectedMarkets.length > 0 &&
    Array.isArray(samples) && samples.length > 0 &&
    selectedMarkets.every(market => byMarket[market].length === (samples?.length || 0));
  return {
    valid: complete,
    maxSpreadPercent: ceiling,
    marketCount: selectedMarkets.length,
    sampleCount: Array.isArray(samples) ? samples.length : 0,
    incompleteMarkets: !Array.isArray(samples) || samples.length === 0
      ? selectedMarkets
      : selectedMarkets.filter(market => byMarket[market].length !== samples.length),
    overall: {
      median: quantile(allValues, 0.5),
      p95: quantile(allValues, 0.95),
      max: allValues.length ? Math.max(...allValues) : null
    },
    markets: summary
  };
}
