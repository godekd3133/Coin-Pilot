import { getMarketDataAdapterKind } from '../market-data/marketDataAdapters.js';

/**
 * 대시보드 읽기 경로의 단기 캐시와 인플라이트 요청 병합.
 *
 * HTTP 라우트마다 반복되던 TTL 캐시·계좌/시세 스냅샷 dedup을 한 모듈로
 * 수렴한다. 캐시 메타데이터는 거래소 소스 시각과 로컬 fetch 시각을 구분하고,
 * collector 캐시/last-good 폴백 출처를 보존한다.
 */
export class DashboardReadCache {
  constructor({ tradingSystem = null, publicMarketDataSource = null,
    getTradingSystem = null, getPublicMarketDataSource = null } = {}) {
    // deps는 호출 시점에 조회한다 — duck-typed 인스턴스가 생성 순서와 무관하게
    // 최신 참조를 얻기 위함(필드 대입 후 첫 호출에서도 최신 trader를 본다).
    this._getTradingSystem = getTradingSystem || (() => tradingSystem);
    this._getPublicSource = getPublicMarketDataSource || (() => publicMarketDataSource);
    this.cache = new Map();
    this.inFlightAccountRequests = new Map();
    this.inFlightTickerRequests = new Map();
    this.ttl = {
      ticker: 1000,      // 시세: 1초
      account: 1000,     // 계좌: 1초
      statistics: 1000,  // 통계: 1초
      candles: 1000      // 캔들: 1초
    };
  }

  getEntry(key) {
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.time < (this.ttl[key.split(':')[0]] || 2000)) {
      return cached;
    }
    return null;
  }

  get(key) {
    return this.getEntry(key)?.data ?? null;
  }

  set(key, data, time = Date.now(), metadata = {}) {
    this.cache.set(key, { data, time, ...metadata });
  }

  // Observer GET routes share a short-lived account snapshot. Every caller
  // receives its own array and row objects so a response projection cannot
  // mutate another caller's view or the cached snapshot.
  async getObserverAccountInfo() {
    const cacheKey = 'account';
    const cloneRows = rows => Array.isArray(rows)
      ? rows.map(row => row && typeof row === 'object' ? { ...row } : row)
      : rows;
    const cached = this.getEntry(cacheKey);
    if (cached) return cloneRows(cached.data);

    const inFlight = this.inFlightAccountRequests.get(cacheKey);
    if (inFlight) return cloneRows(await inFlight);

    let request;
    request = Promise.resolve()
      .then(() => this._getTradingSystem().getAccountInfo())
      .then(rows => {
        const snapshot = cloneRows(rows);
        this.set(cacheKey, snapshot);
        return snapshot;
      })
      .finally(() => {
        if (this.inFlightAccountRequests.get(cacheKey) === request) {
          this.inFlightAccountRequests.delete(cacheKey);
        }
      });
    this.inFlightAccountRequests.set(cacheKey, request);
    return cloneRows(await request);
  }

  // Cache metadata distinguishes exchange source time from local fetch time.
  async getTickerWithMetadata(coins) {
    const requestedCoins = Array.isArray(coins) ? [...coins] : coins;
    const publicMarketDataSource = this._getPublicSource();
    if (publicMarketDataSource && typeof publicMarketDataSource.getTicker !== 'function') {
      throw new TypeError('publicMarketDataSource has no ticker reader.');
    }
    const adapter = this._getTradingSystem()?.marketDataAdapter;
    if (!publicMarketDataSource && getMarketDataAdapterKind(adapter) === 'fixture') {
      return {
        tickers: await adapter.getTickers(requestedCoins),
        fetchedAt: null
      };
    }
    const coinKey = Array.isArray(requestedCoins) ? [...requestedCoins].sort().join(',') : requestedCoins;
    const cacheKey = `ticker:${coinKey}`;

    const cached = this.getEntry(cacheKey);
    if (cached) {
      return {
        tickers: cached.data,
        fetchedAt: cached.fetchedAt ||
          (Number.isFinite(cached.time) ? new Date(cached.time).toISOString() : null),
        ...(cached.fetchedAtByMarket ? { fetchedAtByMarket: cached.fetchedAtByMarket } : {}),
        ...(cached.snapshotSource ? { snapshotSource: cached.snapshotSource } : {}),
        ...(cached.fallbackReason ? { fallbackReason: cached.fallbackReason } : {})
      };
    }

    const publicSnapshot = publicMarketDataSource?.getCachedTickerSnapshot?.(requestedCoins, {
      maxAgeMs: this.ttl.ticker || 1_000
    });
    if (Array.isArray(publicSnapshot?.tickers) && publicSnapshot.tickers.length > 0) {
      const cachedAt = Date.now();
      this.set(cacheKey, publicSnapshot.tickers, cachedAt, {
        fetchedAt: publicSnapshot.fetchedAt,
        fetchedAtByMarket: publicSnapshot.fetchedAtByMarket,
        snapshotSource: 'collector_cache'
      });
      return {
        tickers: publicSnapshot.tickers,
        fetchedAt: publicSnapshot.fetchedAt,
        fetchedAtByMarket: publicSnapshot.fetchedAtByMarket,
        snapshotSource: 'collector_cache'
      };
    }

    const inFlight = this.inFlightTickerRequests.get(cacheKey);
    if (inFlight) return inFlight;

    let request;
    request = Promise.resolve()
      .then(() => publicMarketDataSource
        ? publicMarketDataSource.getTicker(requestedCoins)
        : this._getTradingSystem().upbit.getTicker(requestedCoins))
      .then(data => {
        const cachedAt = Date.now();
        this.set(cacheKey, data, cachedAt, {
          fetchedAt: new Date(cachedAt).toISOString(),
          snapshotSource: 'upstream'
        });
        return {
          tickers: data,
          fetchedAt: new Date(cachedAt).toISOString(),
          snapshotSource: 'upstream'
        };
      })
      .catch(error => {
        const fallback = publicMarketDataSource?.getLastGoodTickerSnapshot?.(requestedCoins);
        if (!Array.isArray(fallback?.tickers) || fallback.tickers.length === 0) throw error;

        const cachedAt = Date.now();
        const fallbackReason = String(error?.code || error?.response?.status || 'UPSTREAM_UNAVAILABLE')
          .replace(/[^A-Za-z0-9_-]/g, '_')
          .slice(0, 48);
        this.cache.set(cacheKey, {
          data: fallback.tickers,
          time: cachedAt,
          fetchedAt: fallback.fetchedAt,
          fetchedAtByMarket: fallback.fetchedAtByMarket,
          snapshotSource: 'last_good',
          fallbackReason
        });
        return {
          tickers: fallback.tickers,
          fetchedAt: fallback.fetchedAt,
          fetchedAtByMarket: fallback.fetchedAtByMarket,
          snapshotSource: 'last_good',
          fallbackReason
        };
      })
      .finally(() => {
        if (this.inFlightTickerRequests.get(cacheKey) === request) {
          this.inFlightTickerRequests.delete(cacheKey);
        }
      });
    this.inFlightTickerRequests.set(cacheKey, request);
    return request;
  }

  // Keep the existing array-only contract for current callers.
  async getTicker(coins) {
    const result = await this.getTickerWithMetadata(coins);
    return result.tickers;
  }
}

export default DashboardReadCache;
