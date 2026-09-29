import { getMarketDataAdapterKind } from '../market-data/marketDataAdapters.js';

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
    sourceAsOfByMarket: new Map(),
    sourceAsOf: null,
    asOf: null,
    fetchedAt: null,
    complete: true,
    unavailableMarkets: []
  };
}

/**
 * Normalizes current ticker reads into one explicit market snapshot.
 * `readTickers` may return an array for legacy readers or `{ tickers, fetchedAt }`.
 */
export class MarketDataProvider {
  constructor({ readMarkets, readTickers, readCandles }) {
    if (typeof readTickers !== 'function') {
      throw new TypeError('MarketDataProvider requires a readTickers function.');
    }
    if (readMarkets !== undefined && typeof readMarkets !== 'function') {
      throw new TypeError('MarketDataProvider readMarkets must be a function when provided.');
    }
    this.readTickers = readTickers;
    this.readMarkets = readMarkets;
    this.readCandles = readCandles;
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
    if (requestedMarkets.length === 0) return emptySnapshot();

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
    const fetchedAt = Array.isArray(result) ? null : normalizeTimestamp(result?.fetchedAt);
    const priceMap = new Map();
    const sourceAsOfByMarket = new Map();

    for (const ticker of requestedTickers) {
      const market = ticker?.market;
      const price = Number(ticker?.trade_price);
      const sourceAsOf = normalizeTimestamp(ticker?.trade_timestamp ?? ticker?.timestamp);
      if (!Number.isFinite(price) || price <= 0 || sourceAsOf === null) continue;

      const previousSourceAsOf = sourceAsOfByMarket.get(market);
      if (!previousSourceAsOf || Date.parse(sourceAsOf) > Date.parse(previousSourceAsOf)) {
        priceMap.set(market, price);
        sourceAsOfByMarket.set(market, sourceAsOf);
      }
    }

    const unavailableMarkets = requestedMarkets.filter(market => !priceMap.has(market));
    const sourceAsOf = sourceAsOfByMarket.size > 0
      ? [...sourceAsOfByMarket.values()].reduce((oldest, current) => (
        Date.parse(current) < Date.parse(oldest) ? current : oldest
      ))
      : null;

    return {
      tickers: requestedTickers,
      priceMap,
      sourceAsOfByMarket,
      sourceAsOf,
      // Retain the established valuation timestamp alias for current consumers.
      asOf: sourceAsOf,
      fetchedAt,
      complete: unavailableMarkets.length === 0,
      unavailableMarkets
    };
  }
}

/** Cached snapshots use DashboardServer's cache; fresh reads delegate to the same Upbit client. */
export class UpbitCacheMarketDataProvider extends MarketDataProvider {
  constructor(server) {
    super({
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
