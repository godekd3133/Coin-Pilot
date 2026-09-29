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
  constructor({ readTickers }) {
    if (typeof readTickers !== 'function') {
      throw new TypeError('MarketDataProvider requires a readTickers function.');
    }
    this.readTickers = readTickers;
    this.inFlightReads = new Map();
  }

  async getSnapshot(markets) {
    const requestedMarkets = normalizeMarkets(markets);
    if (requestedMarkets.length === 0) return emptySnapshot();

    const requestKey = [...requestedMarkets].sort().join(',');
    const inFlight = this.inFlightReads.get(requestKey);
    if (inFlight) return inFlight;

    let request;
    request = this.readSnapshot(requestedMarkets).finally(() => {
      if (this.inFlightReads.get(requestKey) === request) {
        this.inFlightReads.delete(requestKey);
      }
    });
    this.inFlightReads.set(requestKey, request);
    return request;
  }

  async readSnapshot(requestedMarkets) {
    const result = await this.readTickers(requestedMarkets);
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

/** Production adapter backed by DashboardServer's existing Upbit ticker cache. */
export class UpbitCacheMarketDataProvider extends MarketDataProvider {
  constructor(server) {
    super({
      readTickers: async markets => {
        if (typeof server?.getCachedTickerWithMetadata === 'function') {
          return server.getCachedTickerWithMetadata(markets);
        }
        if (typeof server?.getCachedTicker === 'function') {
          return server.getCachedTicker(markets);
        }
        throw new Error('MarketDataProvider has no ticker reader.');
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
