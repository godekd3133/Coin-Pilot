import { getMarketDataAdapterKind } from '../market-data/marketDataAdapters.js';
import { DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS, inspectMarketQuoteFreshness } from './marketQuoteFreshness.js';

function timestampMilliseconds(value) {
  if (typeof value === 'string' && !/^\d+(\.\d+)?$/.test(value)) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function normalizeTimestamp(value) {
  const milliseconds = timestampMilliseconds(value);
  if (milliseconds === null) return null;
  const date = new Date(milliseconds);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeMarkets(markets) {
  return [...new Set((markets || []).filter(market => typeof market === 'string' && market))];
}

export const MARKET_DATA_FRESHNESS = Object.freeze({
  CACHED: 'cached',
  FRESH: 'fresh'
});

function normalizeFreshness(freshness) {
  if (freshness === MARKET_DATA_FRESHNESS.CACHED || freshness === MARKET_DATA_FRESHNESS.FRESH) {
    return freshness;
  }
  throw new TypeError(`Unsupported market-data freshness policy: ${freshness}`);
}

function emptySnapshot() {
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
    complete: true,
    allQuotesFresh: true,
    freshMarkets: [],
    staleMarkets: [],
    maximumQuoteAgeMs: DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS * 1000,
    sourceSkewMs: null,
    captureSkewMs: null,
    snapshotSource: 'none',
    fallbackReason: null,
    unavailableMarkets: []
  };
}

/**
 * Normalizes current ticker reads into one explicit market snapshot.
 * `readTickers` may return an array for legacy readers or `{ tickers, fetchedAt }`.
 */
export class MarketDataProvider {
  constructor({
    readMarkets,
    readTickers,
    readCandles,
    maximumQuoteAgeSeconds = DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS,
    now = Date.now
  }) {
    if (typeof readTickers !== 'function') {
      throw new TypeError('MarketDataProvider requires a readTickers function.');
    }
    if (readMarkets !== undefined && typeof readMarkets !== 'function') {
      throw new TypeError('MarketDataProvider readMarkets must be a function when provided.');
    }
    this.readTickers = readTickers;
    this.readMarkets = readMarkets;
    this.readCandles = readCandles;
    const configuredMaximumAge = Number(maximumQuoteAgeSeconds);
    this.maximumQuoteAgeSeconds = Number.isFinite(configuredMaximumAge) && configuredMaximumAge > 0
      ? configuredMaximumAge
      : DEFAULT_MARKET_QUOTE_MAX_AGE_SECONDS;
    this.now = typeof now === 'function' ? now : Date.now;
    this.inFlightReads = new Map();
  }

  async getMarkets() {
    if (typeof this.readMarkets !== 'function') {
      throw new Error('MarketDataProvider has no market-list reader.');
    }
    return this.readMarkets();
  }

  /** Returns the reader's raw ticker payload without cloning its rows or array. */
  async getTickers(markets, { freshness } = {}) {
    const policy = normalizeFreshness(freshness);
    return this.readTickers(markets, { freshness: policy });
  }

  async getMinuteCandles(market, unit, count) {
    if (typeof this.readCandles !== 'function') {
      throw new Error('MarketDataProvider has no candle reader.');
    }
    return this.readCandles(market, unit, count);
  }

  async getSnapshot(markets, { freshness = MARKET_DATA_FRESHNESS.CACHED } = {}) {
    const policy = normalizeFreshness(freshness);
    const requestedMarkets = normalizeMarkets(markets);
    if (requestedMarkets.length === 0) {
      return {
        ...emptySnapshot(),
        maximumQuoteAgeMs: this.maximumQuoteAgeSeconds * 1000
      };
    }

    const requestKey = `${policy}:${[...requestedMarkets].sort().join(',')}`;
    if (policy === MARKET_DATA_FRESHNESS.FRESH) {
      return this.readSnapshot(requestedMarkets, policy);
    }

    const inFlight = this.inFlightReads.get(requestKey);
    if (inFlight) return inFlight;

    let request;
    request = this.readSnapshot(requestedMarkets, policy).finally(() => {
      if (this.inFlightReads.get(requestKey) === request) {
        this.inFlightReads.delete(requestKey);
      }
    });
    this.inFlightReads.set(requestKey, request);
    return request;
  }

  async readSnapshot(requestedMarkets, freshness) {
    const result = await this.getTickers(requestedMarkets, { freshness });
    const tickers = Array.isArray(result) ? result : result?.tickers;
    if (!Array.isArray(tickers)) {
      throw new TypeError('MarketDataProvider returned an invalid ticker snapshot.');
    }
    const requestedTickers = tickers.filter(ticker => requestedMarkets.includes(ticker?.market));
    const resultFetchedAt = Array.isArray(result) ? null : normalizeTimestamp(result?.fetchedAt);
    const snapshotSource = !Array.isArray(result) && result?.snapshotSource === 'last_good'
      ? 'last_good'
      : 'upstream';
    const rawFallbackReason = !Array.isArray(result) ? result?.fallbackReason : null;
    const fallbackReason = typeof rawFallbackReason === 'string'
      ? rawFallbackReason.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48)
      : null;
    const priceMap = new Map();
    const freshPriceMap = new Map();
    const sourceAsOfByMarket = new Map();
    const quoteFreshnessByMarket = new Map();
    const fetchedAtByMarket = new Map();
    const nowValue = Number(this.now());
    const now = Number.isFinite(nowValue) ? nowValue : Date.now();
    const maximumQuoteAgeMs = this.maximumQuoteAgeSeconds * 1000;

    for (const ticker of requestedTickers) {
      const market = ticker?.market;
      const price = Number(ticker?.trade_price);
      const sourceAsOf = normalizeTimestamp(ticker?.trade_timestamp ?? ticker?.timestamp);
      if (!Number.isFinite(price) || price <= 0 || sourceAsOf === null) continue;

      const previousSourceAsOf = sourceAsOfByMarket.get(market);
      if (!previousSourceAsOf || Date.parse(sourceAsOf) > Date.parse(previousSourceAsOf)) {
        const sourceFreshness = inspectMarketQuoteFreshness(ticker, {
          now,
          maximumAgeSeconds: this.maximumQuoteAgeSeconds,
          expectedMarket: market
        });
        const quoteFreshness = snapshotSource === 'last_good' && sourceFreshness.fresh
          ? { ...sourceFreshness, fresh: false, reason: 'market_snapshot_last_good' }
          : sourceFreshness;
        const payloadFetchedAt = result?.fetchedAtByMarket instanceof Map
          ? result.fetchedAtByMarket.get(market)
          : result?.fetchedAtByMarket?.[market];
        const fetchedAt = normalizeTimestamp(ticker?.fetchedAt ?? payloadFetchedAt ?? resultFetchedAt);
        priceMap.set(market, price);
        sourceAsOfByMarket.set(market, sourceAsOf);
        quoteFreshnessByMarket.set(market, quoteFreshness);
        if (fetchedAt !== null) fetchedAtByMarket.set(market, new Date(fetchedAt).toISOString());
        if (quoteFreshness.fresh) freshPriceMap.set(market, price);
        else freshPriceMap.delete(market);
      }
    }

    const unavailableMarkets = requestedMarkets.filter(market => !priceMap.has(market));
    for (const market of unavailableMarkets) {
      quoteFreshnessByMarket.set(market, {
        fresh: false,
        market,
        sourceAsOf: null,
        ageMs: null,
        maximumAgeMs: maximumQuoteAgeMs,
        reason: 'market_quote_unavailable'
      });
    }
    const freshMarkets = requestedMarkets.filter(market => freshPriceMap.has(market));
    const staleMarkets = requestedMarkets.filter(market => {
      const quoteFreshness = quoteFreshnessByMarket.get(market);
      return priceMap.has(market) && quoteFreshness?.fresh !== true;
    });
    const sourceAsOf = sourceAsOfByMarket.size > 0
      ? [...sourceAsOfByMarket.values()].reduce((oldest, current) => (
        Date.parse(current) < Date.parse(oldest) ? current : oldest
      ))
      : null;
    const sourceTimes = [...sourceAsOfByMarket.values()].map(Date.parse);
    const sourceSkewMs = sourceTimes.length > 0
      ? Math.max(...sourceTimes) - Math.min(...sourceTimes)
      : null;
    const captureTimes = [...fetchedAtByMarket.values()].map(Date.parse);
    const captureSkewMs = captureTimes.length > 0
      ? Math.max(...captureTimes) - Math.min(...captureTimes)
      : null;
    const fetchedAt = resultFetchedAt !== null
      ? new Date(resultFetchedAt).toISOString()
      : captureTimes.length > 0
        ? new Date(Math.min(...captureTimes)).toISOString()
        : null;

    return {
      tickers: requestedTickers,
      priceMap,
      freshPriceMap,
      sourceAsOfByMarket,
      quoteFreshnessByMarket,
      fetchedAtByMarket,
      sourceAsOf,
      // Retain the established valuation timestamp alias for current consumers.
      asOf: sourceAsOf,
      fetchedAt,
      complete: unavailableMarkets.length === 0,
      allQuotesFresh: unavailableMarkets.length === 0 && staleMarkets.length === 0 &&
        snapshotSource !== 'last_good',
      freshMarkets,
      staleMarkets,
      maximumQuoteAgeMs,
      sourceSkewMs,
      captureSkewMs,
      snapshotSource,
      fallbackReason: snapshotSource === 'last_good' ? fallbackReason : null,
      unavailableMarkets
    };
  }
}

/** Cached snapshots use DashboardServer's cache; fresh reads delegate to the same Upbit client. */
export class UpbitCacheMarketDataProvider extends MarketDataProvider {
  constructor(server) {
    super({
      maximumQuoteAgeSeconds: server?.tradingSystem?.maxCandleAgeSeconds,
      readMarkets: async () => {
        const publicMarketDataSource = server?.publicMarketDataSource;
        if (publicMarketDataSource) return publicMarketDataSource.getMarkets();
        const adapter = server?.tradingSystem?.marketDataAdapter;
        if (typeof adapter?.getMarkets === 'function') return adapter.getMarkets();
        const upbit = server?.tradingSystem?.upbit;
        if (typeof upbit?.getMarkets !== 'function') {
          throw new Error('MarketDataProvider has no market-list reader.');
        }
        return upbit.getMarkets();
      },
      readTickers: async (markets, { freshness = MARKET_DATA_FRESHNESS.CACHED } = {}) => {
        const publicMarketDataSource = server?.publicMarketDataSource;
        if (publicMarketDataSource) {
          if (freshness === MARKET_DATA_FRESHNESS.FRESH) {
            return publicMarketDataSource.getTicker(markets);
          }
          if (typeof server?.getCachedTickerWithMetadata === 'function') {
            return server.getCachedTickerWithMetadata(markets);
          }
          if (typeof server?.getCachedTicker === 'function') {
            return server.getCachedTicker(markets);
          }
          return publicMarketDataSource.getTicker(markets);
        }
        const adapter = server?.tradingSystem?.marketDataAdapter;
        if (freshness === MARKET_DATA_FRESHNESS.FRESH) {
          const upbit = server?.tradingSystem?.upbit;
          const readTickers = adapter?.getTickers || upbit?.getTicker;
          if (typeof readTickers !== 'function') {
            throw new Error('MarketDataProvider has no fresh ticker reader.');
          }
          return readTickers.call(adapter?.getTickers ? adapter : upbit, markets);
        }
        if (getMarketDataAdapterKind(adapter) === 'fixture') {
          return adapter.getTickers(markets);
        }
        if (typeof server?.getCachedTickerWithMetadata === 'function') {
          return server.getCachedTickerWithMetadata(markets);
        }
        if (typeof server?.getCachedTicker === 'function') {
          return server.getCachedTicker(markets);
        }
        throw new Error('MarketDataProvider has no ticker reader.');
      },
      readCandles: async (market, unit, count) => {
        const publicMarketDataSource = server?.publicMarketDataSource;
        if (publicMarketDataSource) {
          return publicMarketDataSource.getMinuteCandles(market, unit, count);
        }
        const adapter = server?.tradingSystem?.marketDataAdapter;
        const upbit = server?.tradingSystem?.upbit;
        const readCandles = adapter?.getMinuteCandles || upbit?.getMinuteCandles;
        if (typeof readCandles !== 'function') {
          throw new Error('MarketDataProvider has no candle reader.');
        }
        return readCandles.call(adapter?.getMinuteCandles ? adapter : upbit, market, unit, count);
      }
    });
  }
}

export function getMarketDataProvider(server) {
  if (server?.marketDataProvider && typeof server.marketDataProvider.getSnapshot === 'function') {
    return server.marketDataProvider;
  }
  return new UpbitCacheMarketDataProvider(server);
}
