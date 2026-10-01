/**
 * Exchange-neutral market code helpers. Codes use the `QUOTE-BASE` convention
 * (KRW-BTC on Upbit, USDT-BTC on Binance spot). The configured process quote
 * comes from tradingSystem.quoteAsset / config.quoteAsset.
 */
export const MARKET_CODE_RE = /^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$/;

export function isMarketCode(value) {
  return typeof value === 'string' && MARKET_CODE_RE.test(value.trim().toUpperCase());
}

/** 'USDT' + 'BTC' → 'USDT-BTC'. */
export function marketCodeFor(quote, base) {
  return `${quote}-${base}`;
}

/** 'USDT-BTC' → 'BTC' — replaces replace('KRW-', '') for any quote. */
export function baseOfMarket(market) {
  if (typeof market !== 'string') return market;
  const idx = market.indexOf('-');
  return idx < 0 ? market : market.slice(idx + 1);
}

/** Resolved quote asset for a trading system / config object ('KRW' default). */
export function quoteOfSystem(system) {
  return system?.quoteAsset || system?.config?.quoteAsset || 'KRW';
}

/** Filter helper: markets belonging to the configured quote. */
export function marketsForQuote(markets, quote) {
  const prefix = `${quote}-`;
  return (Array.isArray(markets) ? markets : [])
    .filter(m => typeof m?.market === 'string' && m.market.startsWith(prefix))
    .map(m => m.market);
}
