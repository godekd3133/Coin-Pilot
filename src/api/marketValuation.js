import { getMarketDataProvider } from './marketDataProvider.js';
import { DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS } from './marketQuoteFreshness.js';

/** Read one shared, current-price snapshot for a set of KRW markets. */
export async function readCurrentMarketPrices(server, markets) {
  const requestedMarkets = [...new Set((markets || []).filter(market => typeof market === 'string' && market))];
  try {
    return await getMarketDataProvider(server).getSnapshot(requestedMarkets);
  } catch {
    return {
      tickers: [],
      priceMap: new Map(),
      freshPriceMap: new Map(),
      sourceAsOfByMarket: new Map(),
      quoteFreshnessByMarket: new Map(),
      fetchedAtByMarket: new Map(),
      sourceAsOf: null,
      asOf: null,
      fetchedAt: null,
      complete: requestedMarkets.length === 0,
      allQuotesFresh: requestedMarkets.length === 0,
      freshMarkets: [],
      staleMarkets: [],
      maximumQuoteAgeMs: DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS * 1000,
      sourceSkewMs: null,
      captureSkewMs: null,
      snapshotSource: 'unavailable',
      fallbackReason: null,
      unavailableMarkets: requestedMarkets
    };
  }
}

export function accountValuationMarkets(tradingSystem, accounts = [], positionCoins = []) {
  const markets = new Set(positionCoins);
  if (tradingSystem?.dryRun) {
    const holdings = tradingSystem.virtualPortfolio?.holdings;
    const entries = holdings instanceof Map ? holdings.keys() : Object.keys(holdings || {});
    for (const market of entries) markets.add(market);
  } else {
    for (const account of accounts) {
      if (account?.currency === 'KRW') continue;
      const amount = Number(account?.balance || 0) + Number(account?.locked || 0);
      if (Number.isFinite(amount) && amount > 0 && account?.currency) {
        markets.add(`KRW-${account.currency}`);
      }
    }
  }
  return [...markets];
}
