const finitePositive = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

function finiteTimestamp(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export const MOMENTUM_SHADOW_EXECUTION_MODEL_CANDLE_CLOSE = 'candle_close';
export const MOMENTUM_SHADOW_EXECUTION_MODEL_QUOTE_CROSS = 'quote_cross';

/**
 * Resolve the optional forward-paper execution model. The default deliberately
 * preserves the existing completed-candle contract; quote_cross is an
 * explicit research-only model and never authorizes a live order.
 */
export function resolveMomentumShadowExecutionModel(value) {
  return value === MOMENTUM_SHADOW_EXECUTION_MODEL_QUOTE_CROSS
    ? MOMENTUM_SHADOW_EXECUTION_MODEL_QUOTE_CROSS
    : MOMENTUM_SHADOW_EXECUTION_MODEL_CANDLE_CLOSE;
}

/**
 * Project the price a long-only shadow book would use at one execution
 * boundary. `quote_cross` buys at best ask and exits/marks at best bid. A
 * missing or timestamp-less quote is never silently replaced by candle data.
 * The result is a modeled paper price, not an observed exchange fill.
 */
export function projectMomentumShadowExecutionPrice({
  model = MOMENTUM_SHADOW_EXECUTION_MODEL_CANDLE_CLOSE,
  side = 'entry',
  candlePrice,
  quote = null
} = {}) {
  const resolvedModel = resolveMomentumShadowExecutionModel(model);
  const normalizedSide = String(side);
  const candle = finitePositive(candlePrice);
  if (!['entry', 'exit', 'mark'].includes(normalizedSide)) {
    return {
      available: false,
      model: resolvedModel,
      side: normalizedSide,
      price: null,
      source: null,
      quoteTimestamp: null,
      reason: 'execution_side_invalid'
    };
  }

  if (resolvedModel === MOMENTUM_SHADOW_EXECUTION_MODEL_CANDLE_CLOSE) {
    return {
      available: candle !== null,
      model: resolvedModel,
      side: normalizedSide,
      price: candle,
      source: candle === null ? null : 'candle_close',
      quoteTimestamp: null,
      reason: candle === null ? 'candle_price_invalid' : 'candle_close'
    };
  }

  const bid = finitePositive(quote?.bidPrice);
  const ask = finitePositive(quote?.askPrice);
  const timestamp = finiteTimestamp(quote?.timestamp);
  // compactMomentumShadowQuote intentionally omits the derived `available`
  // flag after validating the source. Accept that bounded shape, while still
  // rejecting an explicitly unavailable raw quote.
  if (!quote || quote.available === false) {
    return {
      available: false,
      model: resolvedModel,
      side: normalizedSide,
      price: null,
      source: null,
      quoteTimestamp: timestamp,
      reason: 'quote_unavailable'
    };
  }
  if (bid === null || ask === null || ask < bid) {
    return {
      available: false,
      model: resolvedModel,
      side: normalizedSide,
      price: null,
      source: null,
      quoteTimestamp: timestamp,
      reason: 'quote_price_invalid'
    };
  }
  if (timestamp === null) {
    return {
      available: false,
      model: resolvedModel,
      side: normalizedSide,
      price: null,
      source: null,
      quoteTimestamp: null,
      reason: 'quote_timestamp_missing_or_invalid'
    };
  }

  const isEntry = normalizedSide === 'entry';
  return {
    available: true,
    model: resolvedModel,
    side: normalizedSide,
    price: isEntry ? ask : bid,
    source: isEntry ? 'best_ask' : 'best_bid',
    quoteTimestamp: timestamp,
    reason: isEntry ? 'best_ask_crossing_model' : 'best_bid_crossing_model'
  };
}
