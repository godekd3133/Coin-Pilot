import { getMarketDataProvider } from './marketDataProvider.js';
import { DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS, inspectMarketQuoteFreshness } from './marketQuoteFreshness.js';
import { quoteOfSystem } from '../exchange/marketCodes.js';

/** Read one shared, current-price snapshot for a set of KRW markets. */
export async function readCurrentMarketPrices(server, markets) {
  const requestedMarkets = [...new Set((markets || []).filter(market => typeof market === 'string' && market))];
  try {
    const provider = getMarketDataProvider(server);
    const snapshot = await provider.getSnapshot(requestedMarkets);
    return buildValuationSnapshot(snapshot, requestedMarkets, provider.now?.() ?? Date.now(), {
      confirmedObservation: typeof server?.getCachedTickerWithMetadata === 'function'
    });
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

/** Account valuation uses the exchange's ticker-generation timestamp. The
 * original last-trade timestamp and execution freshness checks stay intact. */
export function buildValuationSnapshot(snapshot, requestedMarkets, now = Date.now(), { confirmedObservation = false } = {}) {
  const freshPriceMap = new Map();
  const priceMap = new Map(snapshot.priceMap);
  const sourceAsOfByMarket = new Map(snapshot.sourceAsOfByMarket);
  const lastTradeAsOfByMarket = new Map(snapshot.sourceAsOfByMarket);
  const quoteFreshnessByMarket = new Map(snapshot.quoteFreshnessByMarket);
  const valuationTimes = [];
  for (const ticker of snapshot.tickers || []) {
    if (!requestedMarkets.includes(ticker.market)) continue;
    const quote = inspectMarketQuoteFreshness({ ...ticker,
      trade_timestamp: ticker.timestamp ?? ticker.trade_timestamp }, {
      now, expectedMarket: ticker.market,
      maximumAgeSeconds: snapshot.maximumQuoteAgeMs / 1000
    });
    const capturedAt = snapshot.fetchedAtByMarket?.get(ticker.market) ?? snapshot.fetchedAt;
    const capturedTime = Date.parse(capturedAt || '');
    const maximumAgeMs = snapshot.maximumQuoteAgeMs || DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS * 1000;
    const confirmedCurrent = confirmedObservation && snapshot.snapshotSource === 'upstream' &&
      Number.isFinite(capturedTime) && capturedTime <= now + 5000 && now - capturedTime <= maximumAgeMs;
    // A quiet market's last price remains the current exchange mark when a
    // recent successful ticker lookup confirms it. This is valuation only.
    const confirmedQuietMarket = quote.reason === 'market_source_stale' && confirmedCurrent;
    if (confirmedQuietMarket) {
      quote.fresh = true;
      quote.reason = 'confirmed_ticker_snapshot_last_trade';
    }
    if (snapshot.snapshotSource === 'last_good') {
      quote.fresh = false;
      quote.reason = 'market_snapshot_last_good';
    }
    quoteFreshnessByMarket.set(ticker.market, quote);
    if (quote.sourceAsOf) sourceAsOfByMarket.set(ticker.market, quote.sourceAsOf);
    if (quote.fresh) {
      freshPriceMap.set(ticker.market, Number(ticker.trade_price));
      priceMap.set(ticker.market, Number(ticker.trade_price));
      valuationTimes.push(confirmedQuietMarket ? capturedTime : Date.parse(quote.sourceAsOf));
    }
  }
  const freshMarkets = requestedMarkets.filter(market => freshPriceMap.has(market));
  const staleMarkets = requestedMarkets.filter(market => priceMap.has(market) && !freshPriceMap.has(market));
  const sourceTimes = [...sourceAsOfByMarket.values()].map(Date.parse).filter(Number.isFinite);
  const sourceAsOf = sourceTimes.length ? new Date(Math.min(...sourceTimes)).toISOString() : null;
  return { ...snapshot, priceMap, freshPriceMap, sourceAsOfByMarket, lastTradeAsOfByMarket,
    quoteFreshnessByMarket, freshMarkets, staleMarkets, sourceAsOf,
    asOf: valuationTimes.length ? new Date(Math.min(...valuationTimes)).toISOString() : sourceAsOf,
    sourceSkewMs: sourceTimes.length ? Math.max(...sourceTimes) - Math.min(...sourceTimes) : null,
    allQuotesFresh: freshMarkets.length === requestedMarkets.length && snapshot.snapshotSource !== 'last_good',
    valuationTimestampBasis: 'confirmed_exchange_ticker_snapshot' };
}

export function accountValuationMarkets(tradingSystem, accounts = [], positionCoins = []) {
  const markets = new Set(positionCoins);
  if (tradingSystem?.dryRun) {
    const holdings = tradingSystem.virtualPortfolio?.holdings;
    const entries = holdings instanceof Map ? holdings.keys() : Object.keys(holdings || {});
    for (const market of entries) markets.add(market);
  } else {
    const quote = quoteOfSystem(tradingSystem);
    for (const account of accounts) {
      if (account?.currency === quote) continue;
      const amount = Number(account?.balance || 0) + Number(account?.locked || 0);
      if (Number.isFinite(amount) && amount > 0 && account?.currency) {
        markets.add(`${quote}-${account.currency}`);
      }
    }
  }
  return [...markets];
}
