function finitePositive(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function quoteMidpoint(quote) {
  const bidPrice = finitePositive(quote?.bidPrice);
  const askPrice = finitePositive(quote?.askPrice);
  if (bidPrice === null || askPrice === null || askPrice < bidPrice) return null;
  return (bidPrice + askPrice) / 2;
}

function finiteTimestamp(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Keep only the bounded best-level fields needed to audit a quote boundary.
 * This is intentionally not an order or fill record.
 */
export function compactMomentumShadowQuote(quote) {
  if (!quote || quote.available !== true || quoteMidpoint(quote) === null) return null;
  return {
    market: typeof quote.market === 'string' ? quote.market : null,
    bidPrice: finitePositive(quote.bidPrice),
    askPrice: finitePositive(quote.askPrice),
    bidSize: finitePositive(quote.bidSize),
    askSize: finitePositive(quote.askSize),
    spreadPercent: Number.isFinite(Number(quote.spreadPercent))
      ? Number(quote.spreadPercent)
      : null,
    timestamp: finiteTimestamp(quote.timestamp)
  };
}

/**
 * Estimate the price drag of crossing the best level for a long entry and
 * long exit. The calculation is deliberately midpoint-based and must never
 * be presented as a fill, wallet settlement, or realized P&L observation.
 */
export function projectMomentumShadowQuoteExecutionEvidence({
  entryQuote,
  exitQuote
} = {}) {
  const entryMidpoint = quoteMidpoint(entryQuote);
  const exitMidpoint = quoteMidpoint(exitQuote);
  const entryAsk = finitePositive(entryQuote?.askPrice);
  const exitBid = finitePositive(exitQuote?.bidPrice);
  const entryTimestamp = finiteTimestamp(entryQuote?.timestamp);
  const exitTimestamp = finiteTimestamp(exitQuote?.timestamp);
  const entryPriceAvailable = entryMidpoint !== null && entryAsk !== null;
  const exitPriceAvailable = exitMidpoint !== null && exitBid !== null;
  const entryAvailable = entryPriceAvailable && entryTimestamp !== null;
  const exitAvailable = exitPriceAvailable && exitTimestamp !== null;
  const entrySpreadPercent = Number.isFinite(Number(entryQuote?.spreadPercent))
    ? Number(entryQuote.spreadPercent)
    : null;
  const exitSpreadPercent = Number.isFinite(Number(exitQuote?.spreadPercent))
    ? Number(exitQuote.spreadPercent)
    : null;

  if (!entryAvailable || !exitAvailable) {
    return {
      available: false,
      reason: !entryPriceAvailable
        ? 'entry_quote_missing_or_invalid'
        : entryTimestamp === null
          ? 'entry_quote_timestamp_missing_or_invalid'
          : !exitPriceAvailable
            ? 'exit_quote_missing_or_invalid'
            : 'exit_quote_timestamp_missing_or_invalid',
      entrySpreadPercent,
      exitSpreadPercent,
      estimatedCrossingDragPercent: null
    };
  }

  const entryCrossingDragPercent = ((entryAsk - entryMidpoint) / entryMidpoint) * 100;
  const exitCrossingDragPercent = ((exitMidpoint - exitBid) / exitMidpoint) * 100;
  return {
    available: true,
    reason: 'best_level_midpoint_crossing_model',
    entrySpreadPercent,
    exitSpreadPercent,
    entryCrossingDragPercent,
    exitCrossingDragPercent,
    estimatedCrossingDragPercent: entryCrossingDragPercent + exitCrossingDragPercent,
    entryTimestamp,
    exitTimestamp
  };
}

export function summarizeMomentumShadowQuoteExecutionEvidence(trades = []) {
  const rows = (Array.isArray(trades) ? trades : [])
    .map(trade => trade?.quoteExecutionEvidence)
    .filter(evidence => evidence && typeof evidence === 'object');
  const available = rows.filter(evidence => evidence.available === true &&
    Number.isFinite(Number(evidence.estimatedCrossingDragPercent)));
  const drags = available.map(evidence => Number(evidence.estimatedCrossingDragPercent));
  return {
    closedTradeCount: Array.isArray(trades) ? trades.length : 0,
    availableCount: available.length,
    missingCount: Math.max(0, (Array.isArray(trades) ? trades.length : 0) - available.length),
    averageEstimatedCrossingDragPercent: drags.length
      ? drags.reduce((total, value) => total + value, 0) / drags.length
      : null,
    maxEstimatedCrossingDragPercent: drags.length ? Math.max(...drags) : null,
    note: 'midpoint crossing model only; not an observed fill, realized P&L, or live-order authorization'
  };
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
  const byMarket = Object.fromEntries(selectedMarkets.map(market => [market, {
    spreads: [],
    bidNotionals: [],
    askNotionals: []
  }]));
  for (const sample of Array.isArray(samples) ? samples : []) {
    for (const quote of Array.isArray(sample?.quotes) ? sample.quotes : []) {
      if (!Object.hasOwn(byMarket, quote.market)) continue;
      const market = byMarket[quote.market];
      if (Number.isFinite(Number(quote.spreadPercent))) market.spreads.push(Number(quote.spreadPercent));
      if (quote.available !== true) continue;
      const bidPrice = finitePositive(quote.bidPrice);
      const bidSize = finitePositive(quote.bidSize);
      const askPrice = finitePositive(quote.askPrice);
      const askSize = finitePositive(quote.askSize);
      const bidNotional = bidPrice === null || bidSize === null ? null : bidPrice * bidSize;
      const askNotional = askPrice === null || askSize === null ? null : askPrice * askSize;
      if (Number.isFinite(bidNotional) && bidNotional > 0) market.bidNotionals.push(bidNotional);
      if (Number.isFinite(askNotional) && askNotional > 0) market.askNotionals.push(askNotional);
    }
  }
  const requestedSampleCount = Array.isArray(samples) ? samples.length : 0;
  const summary = Object.fromEntries(selectedMarkets.map(market => {
    const { spreads, bidNotionals, askNotionals } = byMarket[market];
    return [market, {
      sampleCount: spreads.length,
      median: quantile(spreads, 0.5),
      p95: quantile(spreads, 0.95),
      max: spreads.length ? Math.max(...spreads) : null,
      overCeiling: ceiling > 0 ? spreads.filter(value => value > ceiling).length : 0,
      topOfBookDepth: {
        requestedSampleCount,
        bidSampleCount: bidNotionals.length,
        askSampleCount: askNotionals.length,
        missingBidSampleCount: Math.max(0, requestedSampleCount - bidNotionals.length),
        missingAskSampleCount: Math.max(0, requestedSampleCount - askNotionals.length),
        medianBidNotionalKrw: quantile(bidNotionals, 0.5),
        minimumBidNotionalKrw: bidNotionals.length ? Math.min(...bidNotionals) : null,
        medianAskNotionalKrw: quantile(askNotionals, 0.5),
        minimumAskNotionalKrw: askNotionals.length ? Math.min(...askNotionals) : null
      }
    }];
  }));
  const allValues = Object.values(byMarket).flatMap(market => market.spreads);
  const complete = selectedMarkets.length > 0 &&
    Array.isArray(samples) && samples.length > 0 &&
    selectedMarkets.every(market => byMarket[market].spreads.length === (samples?.length || 0));
  return {
    valid: complete,
    maxSpreadPercent: ceiling,
    marketCount: selectedMarkets.length,
    sampleCount: Array.isArray(samples) ? samples.length : 0,
    incompleteMarkets: !Array.isArray(samples) || samples.length === 0
      ? selectedMarkets
      : selectedMarkets.filter(market => byMarket[market].spreads.length !== samples.length),
    overall: {
      median: quantile(allValues, 0.5),
      p95: quantile(allValues, 0.95),
      max: allValues.length ? Math.max(...allValues) : null
    },
    markets: summary
  };
}
