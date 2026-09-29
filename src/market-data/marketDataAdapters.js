const adapterKinds = new WeakMap();

// Contract: normal ticker/candle analysis and portfolio mark prices use this
// seam. LIVE binds to the trader's Upbit client; account/order reads,
// manual-order preflight, and protective risk polling stay on exchange clients.

function cloneFixtureValue(value) {
  if (typeof globalThis.structuredClone === 'function') return globalThis.structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function normalizeRequestedMarkets(markets) {
  const values = Array.isArray(markets)
    ? markets
    : typeof markets === 'string'
      ? markets.split(',')
      : null;
  if (!values || values.some(market => typeof market !== 'string' || !market.trim())) {
    throw new TypeError('Market data reads require one or more market codes.');
  }
  return [...new Set(values.map(market => market.trim()))];
}

function candleSetKey(market, unit) {
  return `${market}:${unit}`;
}

function parseFixtureCandleTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/** Returns the built-in adapter kind, or null for an unsupported implementation. */
export function getMarketDataAdapterKind(adapter) {
  return adapter && typeof adapter === 'object'
    ? adapterKinds.get(adapter) || null
    : null;
}

/**
 * Delegates public ticker and minute-candle reads to the existing Upbit client.
 * The adapter intentionally returns Upbit's payload shape without normalization.
 */
export class UpbitMarketDataAdapter {
  constructor(upbitOrProvider) {
    const getUpbit = typeof upbitOrProvider === 'function'
      ? upbitOrProvider
      : () => upbitOrProvider;
    const upbit = getUpbit();
    if (typeof upbit?.getMarkets !== 'function' ||
      typeof upbit?.getTicker !== 'function' || typeof upbit?.getMinuteCandles !== 'function') {
      throw new TypeError('UpbitMarketDataAdapter requires market-list, ticker, and minute-candle readers.');
    }
    this.getUpbit = getUpbit;
    adapterKinds.set(this, 'upbit');
    Object.freeze(this);
  }

  getMarkets() {
    const upbit = this.getUpbit();
    if (typeof upbit?.getMarkets !== 'function') {
      throw new Error('Upbit market-list reader is unavailable.');
    }
    return upbit.getMarkets();
  }

  getTickers(markets) {
    const upbit = this.getUpbit();
    if (typeof upbit?.getTicker !== 'function') {
      throw new Error('Upbit ticker reader is unavailable.');
    }
    return upbit.getTicker(markets);
  }

  getMinuteCandles(market, unit, count, requestOptions = {}) {
    const upbit = this.getUpbit();
    if (typeof upbit?.getMinuteCandles !== 'function') {
      throw new Error('Upbit minute-candle reader is unavailable.');
    }
    return upbit.getMinuteCandles(market, unit, count, requestOptions);
  }
}

/**
 * Deterministic, in-memory market data for isolated DRY_RUN/replay work.
 * Each candle set must match the requested unit and use Upbit's newest-first
 * array order. Missing sets fail closed instead of falling through to network.
 */
export class FixtureMarketDataAdapter {
  #markets;
  #tickersByMarket;
  #candlesByMarketAndUnit;

  constructor({ markets, tickers = [], candleSets = [] } = {}) {
    if ((markets !== undefined && !Array.isArray(markets)) ||
      !Array.isArray(tickers) || !Array.isArray(candleSets)) {
      throw new TypeError('Fixture market data must use market, ticker, and candle-set arrays.');
    }

    this.#tickersByMarket = new Map();
    for (const ticker of tickers) {
      if (!ticker || typeof ticker.market !== 'string' || !ticker.market.trim() ||
        ticker.market !== ticker.market.trim() ||
        !Number.isFinite(ticker.trade_price) || ticker.trade_price <= 0) {
        throw new TypeError('Fixture tickers require a market and positive numeric trade_price.');
      }
      if (this.#tickersByMarket.has(ticker.market)) {
        throw new TypeError(`Duplicate fixture ticker for ${ticker.market}.`);
      }
      this.#tickersByMarket.set(ticker.market, cloneFixtureValue(ticker));
    }

    this.#candlesByMarketAndUnit = new Map();
    for (const candleSet of candleSets) {
      const { market, unit, candles } = candleSet || {};
      if (typeof market !== 'string' || !market.trim() ||
        market !== market.trim() ||
        !Number.isInteger(unit) || unit <= 0 || !Array.isArray(candles)) {
        throw new TypeError('Fixture candle sets require a market, positive integer unit, and candle array.');
      }
      const key = candleSetKey(market, unit);
      if (this.#candlesByMarketAndUnit.has(key)) {
        throw new TypeError(`Duplicate fixture candle set for ${key}.`);
      }
      this.#candlesByMarketAndUnit.set(key, cloneFixtureValue(candles));
    }

    const candleMarkets = candleSets.map(candleSet => candleSet.market);
    const inferredMarkets = [...new Set([
      ...this.#tickersByMarket.keys(),
      ...candleMarkets
    ])];
    const selectedMarkets = normalizeRequestedMarkets(markets ?? inferredMarkets);
    if (selectedMarkets.some(market => !/^[A-Z0-9]+-[A-Z0-9]+$/.test(market))) {
      throw new TypeError('Fixture markets must use valid exchange market codes.');
    }
    const selectedMarketSet = new Set(selectedMarkets);
    if ([...this.#tickersByMarket.keys(), ...candleMarkets]
      .some(market => !selectedMarketSet.has(market))) {
      throw new TypeError('Fixture ticker and candle rows must belong to the declared market list.');
    }
    this.#markets = selectedMarkets;

    adapterKinds.set(this, 'fixture');
    Object.freeze(this);
  }

  async getMarkets() {
    return this.#markets.map(market => ({ market }));
  }

  async getTickers(markets) {
    const requestedMarkets = normalizeRequestedMarkets(markets);
    return requestedMarkets.flatMap(market => {
      const ticker = this.#tickersByMarket.get(market);
      return ticker ? [cloneFixtureValue(ticker)] : [];
    });
  }

  async getMinuteCandles(market, unit, count, requestOptions = {}) {
    if (typeof market !== 'string' || !market.trim() || market !== market.trim() ||
      !Number.isInteger(unit) || unit <= 0 ||
      !Number.isInteger(count) || count < 1 || count > 200 ||
      !requestOptions || typeof requestOptions !== 'object' || Array.isArray(requestOptions)) {
      throw new TypeError('Fixture candle reads require a market, positive unit, and count from 1 to 200.');
    }

    const key = candleSetKey(market, unit);
    const candles = this.#candlesByMarketAndUnit.get(key);
    if (!candles) throw new Error(`No deterministic candle fixture is available for ${key}.`);
    const cursor = requestOptions.to;
    if (cursor === undefined || cursor === null) return cloneFixtureValue(candles.slice(0, count));
    const cursorTimestamp = parseFixtureCandleTimestamp(cursor);
    if (cursorTimestamp === null) throw new TypeError('Fixture candle cursor must be a valid UTC timestamp.');
    const olderCandles = candles.filter(candle => {
      const timestamp = parseFixtureCandleTimestamp(candle?.candle_date_time_utc);
      return timestamp !== null && timestamp < cursorTimestamp;
    });
    return cloneFixtureValue(olderCandles.slice(0, count));
  }
}
