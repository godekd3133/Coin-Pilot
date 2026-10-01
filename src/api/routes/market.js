import express from 'express';
import { getMarketDataProvider, MARKET_DATA_FRESHNESS } from '../marketDataProvider.js';

const MARKETS_CACHE_TTL_MS = 60_000;
const CANDLES_CACHE_TTL_MS = 1_000;
const MAX_CANDLES_CACHE_ENTRIES = 128;
const MINUTE_CANDLE_UNITS = new Set([1, 3, 5, 10, 15, 30, 60, 240]);
const MAX_MINUTE_CANDLE_COUNT = 200;
const MARKET_LIST_UNAVAILABLE = 'MARKET_LIST_UNAVAILABLE';

class MarketListUnavailableError extends Error {
  constructor() {
    super('Market list unavailable.');
    this.name = 'MarketListUnavailableError';
    this.code = MARKET_LIST_UNAVAILABLE;
    this.statusCode = 503;
  }
}

class InvalidCandleQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidCandleQueryError';
    this.statusCode = 400;
  }
}

function normalizeKrwMarkets(payload, quote = 'KRW') {
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new TypeError('Market list response must be a non-empty array.');
  }

  const quotePrefix = `${quote}-`;
  const markets = new Set();
  for (const entry of payload) {
    const market = entry?.market;
    if (typeof market !== 'string' || !/^[A-Z0-9]+-[A-Z0-9]+$/.test(market)) {
      throw new TypeError('Market list response contains an invalid market code.');
    }
    if (market.startsWith(quotePrefix)) markets.add(market);
  }

  if (markets.size === 0) {
    throw new TypeError('Market list response contains no markets.');
  }

  const priority = new Map([`${quote}-BTC`, `${quote}-ETH`, `${quote}-XRP`, `${quote}-SOL`, `${quote}-DOGE`]
    .map((market, index) => [market, index]));
  return [...markets].sort((left, right) => {
    const leftPriority = priority.get(left);
    const rightPriority = priority.get(right);
    if (leftPriority !== undefined && rightPriority !== undefined) return leftPriority - rightPriority;
    if (leftPriority !== undefined) return -1;
    if (rightPriority !== undefined) return 1;
    return left.localeCompare(right);
  });
}

function setMarketListHeaders(res, marketList) {
  res.setHeader('X-Market-List-Stale', String(marketList.stale));
  res.setHeader('X-Market-List-Fetched-At', marketList.fetchedAt);
}

function mapPriceRows(snapshot) {
  return snapshot.tickers.map(ticker => {
    const quoteFreshness = snapshot.quoteFreshnessByMarket?.get(ticker.market) ?? null;
    return {
      coin: ticker.market,
      price: ticker.trade_price,
      change: ticker.signed_change_rate * 100,
      changePrice: ticker.signed_change_price,
      high: ticker.high_price,
      low: ticker.low_price,
      volume: ticker.acc_trade_volume_24h,
      volumeKrw: ticker.acc_trade_price_24h,
      sourceAsOf: snapshot.sourceAsOfByMarket.get(ticker.market) ?? null,
      fetchedAt: snapshot.fetchedAtByMarket?.get(ticker.market) ?? snapshot.fetchedAt,
      quoteFresh: quoteFreshness?.fresh === true,
      quoteAgeMs: quoteFreshness?.ageMs ?? null,
      quoteFreshnessReason: quoteFreshness ? quoteFreshness.reason : 'market_quote_unavailable'
    };
  });
}

function sendRouteError(res, error) {
  if (error?.code === MARKET_LIST_UNAVAILABLE) {
    return res.status(503).json({
      error: 'Market list unavailable.',
      code: MARKET_LIST_UNAVAILABLE,
      stale: false,
      fetchedAt: null
    });
  }

  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  return res.status(statusCode).json({ error: error?.message || String(error) });
}

function parsePositiveInteger(value, name, defaultValue) {
  if (value === undefined) return defaultValue;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new InvalidCandleQueryError(`${name} must be a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidCandleQueryError(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseCandleOptions(query) {
  const unit = parsePositiveInteger(query.unit, 'unit', 5);
  if (!MINUTE_CANDLE_UNITS.has(unit)) {
    throw new InvalidCandleQueryError('unit must be one of 1, 3, 5, 10, 15, 30, 60, or 240.');
  }

  const count = parsePositiveInteger(query.count, 'count', 100);
  if (count > MAX_MINUTE_CANDLE_COUNT) {
    throw new InvalidCandleQueryError(`count must be between 1 and ${MAX_MINUTE_CANDLE_COUNT}.`);
  }

  return { unit, count };
}

/**
 * Market and price routes. The verified market list cache belongs to this
 * router instance so separate server instances cannot share market state.
 */
export default function createMarketRoutes(server) {
  const router = express.Router();
  const marketListCache = {
    value: null,
    inFlight: null
  };
  const candlesCache = new Map();
  const inFlightCandleReads = new Map();

  const getMinuteCandles = async (market, unit, count) => {
    const key = `${market}:${unit}:${count}`;
    const now = Date.now();
    const cached = candlesCache.get(key);
    if (cached && now >= cached.fetchedAtMs && now - cached.fetchedAtMs < CANDLES_CACHE_TTL_MS) {
      return cached.candles.map(candle => ({ ...candle }));
    }
    if (cached) candlesCache.delete(key);

    let request = inFlightCandleReads.get(key);
    if (!request) {
      request = Promise.resolve()
        .then(() => getMarketDataProvider(server).getMinuteCandles(market, unit, count))
        .then(candles => {
          if (!Array.isArray(candles)) {
            throw new TypeError('Market data provider returned an invalid candle list.');
          }
          const snapshot = candles.map(candle => candle && typeof candle === 'object'
            ? { ...candle }
            : candle);
          candlesCache.set(key, { fetchedAtMs: Date.now(), candles: snapshot });
          while (candlesCache.size > MAX_CANDLES_CACHE_ENTRIES) {
            candlesCache.delete(candlesCache.keys().next().value);
          }
          return snapshot;
        })
        .finally(() => {
          if (inFlightCandleReads.get(key) === request) inFlightCandleReads.delete(key);
        });
      inFlightCandleReads.set(key, request);
    }

    return (await request).map(candle => candle && typeof candle === 'object'
      ? { ...candle }
      : candle);
  };

  const getAllKrwMarkets = async () => {
    const now = Date.now();
    const cached = marketListCache.value;
    if (cached && now >= cached.fetchedAtMs && now - cached.fetchedAtMs < MARKETS_CACHE_TTL_MS) {
      return { ...cached, stale: false };
    }

    if (marketListCache.inFlight) return marketListCache.inFlight;

    let request;
    request = (async () => {
      try {
        const payload = await getMarketDataProvider(server).getMarkets();
        const coins = normalizeKrwMarkets(payload, server.tradingSystem?.quoteAsset || 'KRW');
        const fetchedAtMs = Date.now();
        const verified = {
          coins,
          fetchedAt: new Date(fetchedAtMs).toISOString(),
          fetchedAtMs
        };
        marketListCache.value = verified;
        return { ...verified, stale: false };
      } catch {
        if (marketListCache.value) return { ...marketListCache.value, stale: true };
        throw new MarketListUnavailableError();
      } finally {
        if (marketListCache.inFlight === request) marketListCache.inFlight = null;
      }
    })();

    marketListCache.inFlight = request;
    return request;
  };

  const readPriceSnapshot = async () => {
    const marketList = await getAllKrwMarkets();
    const snapshot = await getMarketDataProvider(server).getSnapshot(marketList.coins, {
      freshness: MARKET_DATA_FRESHNESS.CACHED
    });
    return { marketList, snapshot };
  };

  // 타겟 코인 목록 조회
  router.get('/target-coins', async (req, res) => {
    try {
      const marketList = await getAllKrwMarkets();
      res.json({
        coins: marketList.coins,
        count: marketList.coins.length,
        stale: marketList.stale,
        fetchedAt: marketList.fetchedAt
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  // 실시간 시세 조회. The legacy response stays a bare array; list freshness
  // metadata is carried in headers so existing array consumers keep working.
  router.get('/market/prices', async (req, res) => {
    try {
      const { marketList, snapshot } = await readPriceSnapshot();
      setMarketListHeaders(res, marketList);
      res.json(mapPriceRows(snapshot));
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  // Explicit market snapshot for consumers that need completeness and timing.
  router.get('/market/prices/snapshot', async (req, res) => {
    try {
      const { marketList, snapshot } = await readPriceSnapshot();
      const returnedMarkets = [...new Set(snapshot.tickers.map(ticker => ticker.market))];
      const returnedMarketSet = new Set(returnedMarkets);
      const missingMarkets = marketList.coins.filter(market => !returnedMarketSet.has(market));

      setMarketListHeaders(res, marketList);
      res.json({
        requestedMarkets: marketList.coins,
        returnedMarkets,
        missingMarkets,
        unavailableMarkets: snapshot.unavailableMarkets,
        complete: snapshot.complete,
        allQuotesFresh: snapshot.allQuotesFresh,
        freshMarkets: snapshot.freshMarkets,
        staleMarkets: snapshot.staleMarkets,
        maximumQuoteAgeMs: snapshot.maximumQuoteAgeMs,
        sourceSkewMs: snapshot.sourceSkewMs,
        captureSkewMs: snapshot.captureSkewMs,
        snapshotSource: snapshot.snapshotSource,
        fallbackReason: snapshot.fallbackReason,
        sourceAsOf: snapshot.sourceAsOf,
        fetchedAt: snapshot.fetchedAt,
        marketListStale: marketList.stale,
        marketListFetchedAt: marketList.fetchedAt,
        prices: mapPriceRows(snapshot)
      });
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  // 캔들 데이터 조회 (차트용)
  router.get('/market/candles/:coin', async (req, res) => {
    try {
      const coin = req.params.coin;
      const { unit, count } = parseCandleOptions(req.query);
      const candles = await getMinuteCandles(coin, unit, count);

      const chartData = [...candles].reverse().map(candle => ({
        time: candle.candle_date_time_kst,
        open: candle.opening_price,
        high: candle.high_price,
        low: candle.low_price,
        close: candle.trade_price,
        volume: candle.candle_acc_trade_volume
      }));

      res.json(chartData);
    } catch (error) {
      sendRouteError(res, error);
    }
  });

  return router;
}
