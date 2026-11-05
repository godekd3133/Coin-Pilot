// 토스증권 Open API 클라이언트 (REST).
// 공식 스펙: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json
// - OAuth2 client_credentials 토큰(24h)을 캐시하고 만료 5분 전에 갱신한다.
// - 계좌/주문 API는 X-Tossinvest-Account(accountSeq) 헤더가 필요하다.
// - Rate limit은 "클라이언트 × API 그룹" 단위 TPS이므로 그룹별 최소 간격으로 직렬화한다.
// 토스증권은 모의투자 서버를 제공하지 않는다. 모의투자는 이 클라이언트의
// 시세만 사용하고 주문은 로컬 가상 포트폴리오에서 체결한다.

export const TOSS_BASE_URL = 'https://openapi.tossinvest.com';

// 공식 문서의 그룹별 초당 한도에서 약간 여유를 둔 최소 요청 간격(ms).
const GROUP_MIN_INTERVAL_MS = {
  AUTH: 250,
  ACCOUNT: 1100,
  ASSET: 250,
  MARKET_INFO: 400,
  MARKET_DATA: 80,
  MARKET_DATA_CHART: 60,
  RANKING: 250,
  STOCK_ALL: 1000,
  ORDER: 120,
  ORDER_HISTORY: 250,
  ORDER_INFO: 350
};

const TERMINAL_ORDER_STATUSES = new Set(['FILLED', 'CANCELED', 'REJECTED', 'REPLACED']);

export class TossApiError extends Error {
  constructor(message, { status = null, code = null, data = null } = {}) {
    super(message);
    this.name = 'TossApiError';
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export class TossInvestClient {
  constructor({
    clientId,
    clientSecret,
    accountSeq = null,
    baseUrl = TOSS_BASE_URL,
    requestTimeoutMs = 10000,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    sleepImpl = sleep
  } = {}) {
    this.clientId = typeof clientId === 'string' ? clientId.trim() : '';
    this.clientSecret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
    this.accountSeq = toNumber(accountSeq, null);
    this.baseUrl = String(baseUrl || TOSS_BASE_URL).replace(/\/+$/, '');
    this.requestTimeoutMs = Math.max(1000, Number(requestTimeoutMs) || 10000);
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.sleep = sleepImpl;
    this._token = null;
    this._tokenExpiresAt = 0;
    this._tokenPromise = null;
    this._groupQueues = new Map();
  }

  get credentialsConfigured() {
    return this.clientId.length > 0 && this.clientSecret.length > 0;
  }

  async _throttle(group) {
    const interval = GROUP_MIN_INTERVAL_MS[group] ?? 250;
    const previous = this._groupQueues.get(group) || Promise.resolve(0);
    let release;
    const next = new Promise(resolve => { release = resolve; });
    this._groupQueues.set(group, previous.then(() => next));
    const lastAt = await previous;
    const waitMs = Math.max(0, lastAt + interval - this.now());
    if (waitMs > 0) await this.sleep(waitMs);
    return () => release(this.now());
  }

  async _fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new TossApiError(`토스증권 API 응답 시간 초과 (${this.requestTimeoutMs}ms)`, { code: 'timeout' });
      }
      throw new TossApiError(`토스증권 API 네트워크 오류: ${error.message}`, { code: 'network_error' });
    } finally {
      clearTimeout(timer);
    }
  }

  async getAccessToken() {
    if (!this.credentialsConfigured) {
      throw new TossApiError('토스증권 client_id/client_secret이 설정되지 않았습니다.', { code: 'credentials_missing' });
    }
    if (this._token && this.now() < this._tokenExpiresAt - 5 * 60 * 1000) return this._token;
    if (this._tokenPromise) return this._tokenPromise;
    this._tokenPromise = (async () => {
      const release = await this._throttle('AUTH');
      try {
        const body = new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.clientId,
          client_secret: this.clientSecret
        });
        const response = await this._fetchWithTimeout(`${this.baseUrl}/oauth2/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: body.toString()
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || typeof payload?.access_token !== 'string') {
          throw new TossApiError(
            `토스증권 토큰 발급 실패 (${response.status}): ${payload?.error?.message || payload?.error_description || 'unknown'}`,
            { status: response.status, code: payload?.error?.code || payload?.error || 'token_failed' }
          );
        }
        this._token = payload.access_token;
        this._tokenExpiresAt = this.now() + Math.max(60, Number(payload.expires_in) || 86400) * 1000;
        return this._token;
      } finally {
        release();
      }
    })();
    try {
      return await this._tokenPromise;
    } finally {
      this._tokenPromise = null;
    }
  }

  async request(method, path, { group, query = null, body = null, account = false, retries = 2 } = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }

    for (let attempt = 0; ; attempt += 1) {
      const token = await this.getAccessToken();
      const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
      if (account) {
        const accountSeq = await this.resolveAccountSeq();
        headers['X-Tossinvest-Account'] = String(accountSeq);
      }
      if (body) headers['Content-Type'] = 'application/json';

      const release = await this._throttle(group);
      let response;
      try {
        response = await this._fetchWithTimeout(url.toString(), {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined
        });
      } finally {
        release();
      }
      const payload = await response.json().catch(() => ({}));
      if (response.ok) return payload?.result ?? payload;

      const errorCode = payload?.error?.code || null;
      const message = payload?.error?.message || `HTTP ${response.status}`;
      if (response.status === 401 && attempt < retries) {
        this._token = null;
        this._tokenExpiresAt = 0;
        continue;
      }
      // 주문 생성(POST /orders)은 clientOrderId 멱등키가 있을 때만 재시도한다.
      const retryable = response.status === 429 || response.status >= 500;
      const idempotent = method === 'GET' || Boolean(body?.clientOrderId);
      if (retryable && idempotent && attempt < retries) {
        const retryAfter = toNumber(response.headers?.get?.('Retry-After'), null);
        await this.sleep(retryAfter !== null ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      throw new TossApiError(`토스증권 API 오류 (${response.status} ${errorCode || ''}): ${message}`.trim(), {
        status: response.status,
        code: errorCode,
        data: payload?.error?.data ?? null
      });
    }
  }

  async resolveAccountSeq() {
    if (this.accountSeq !== null) return this.accountSeq;
    const accounts = await this.getAccounts();
    const brokerage = accounts.find(account => account?.accountType === 'BROKERAGE') || accounts[0];
    const seq = toNumber(brokerage?.accountSeq, null);
    if (seq === null) {
      throw new TossApiError('토스증권 종합매매 계좌를 찾을 수 없습니다.', { code: 'account_not_found' });
    }
    this.accountSeq = seq;
    return seq;
  }

  async getAccounts() {
    const result = await this.request('GET', '/api/v1/accounts', { group: 'ACCOUNT' });
    return Array.isArray(result) ? result : [];
  }

  /** @returns {Promise<Map<string, {price:number, timestamp:string|null}>>} */
  async getPrices(symbols) {
    const unique = [...new Set((symbols || []).map(symbol => String(symbol).trim()).filter(Boolean))];
    const prices = new Map();
    for (let index = 0; index < unique.length; index += 200) {
      const chunk = unique.slice(index, index + 200);
      const result = await this.request('GET', '/api/v1/prices', {
        group: 'MARKET_DATA',
        query: { symbols: chunk.join(',') }
      });
      for (const item of Array.isArray(result) ? result : []) {
        const price = toNumber(item?.lastPrice, null);
        if (item?.symbol && price !== null && price > 0) {
          prices.set(item.symbol, { price, timestamp: item.timestamp ?? null, currency: item.currency || 'KRW' });
        }
      }
    }
    return prices;
  }

  /** 1분봉, 최신순. */
  async getMinuteCandles(symbol, count = 100) {
    const result = await this.request('GET', '/api/v1/candles', {
      group: 'MARKET_DATA_CHART',
      query: { symbol, interval: '1m', count: Math.min(200, Math.max(1, count)) }
    });
    return Array.isArray(result?.candles) ? result.candles : [];
  }

  /** 일봉, 최신순. 200개를 넘으면 nextBefore 커서로 이어서 조회한다. */
  async getDailyCandles(symbol, count = 200) {
    const candles = [];
    let before = null;
    while (candles.length < count) {
      const result = await this.request('GET', '/api/v1/candles', {
        group: 'MARKET_DATA_CHART',
        query: { symbol, interval: '1d', count: Math.min(200, count - candles.length), before }
      });
      const page = Array.isArray(result?.candles) ? result.candles : [];
      candles.push(...page);
      if (!result?.nextBefore || page.length === 0) break;
      before = result.nextBefore;
    }
    return candles;
  }

  /** 시장별 상장 종목 전체 목록(보통주 등 STOCK, 상장 중). 일 1회 갱신 데이터. */
  async listStocks(market) {
    const result = await this.request('GET', '/api/v1/stocks/all', {
      group: 'STOCK_ALL',
      query: { market, status: 'ACTIVE', securityType: 'STOCK' }
    });
    return Array.isArray(result) ? result : [];
  }

  /**
   * Symbols of every listed KOSPI/KOSDAQ STOCK-type security (no ETF/ETN).
   * Horizon sleeves trade only these: the 0.20% sell tax in their cost model
   * then holds for every symbol, and leveraged/inverse ETFs (path-decaying
   * products that dominate the turnover ranking) never enter a multi-week hold.
   */
  async listStockSymbols(markets = ['KOSPI', 'KOSDAQ']) {
    const symbols = new Set();
    for (const market of markets) {
      for (const item of await this.listStocks(market)) {
        if (item?.symbol) symbols.add(String(item.symbol));
      }
    }
    return symbols;
  }

  async getRankings({ type = 'MARKET_TRADING_AMOUNT', duration = 'realtime', count = 100 } = {}) {
    const result = await this.request('GET', '/api/v1/rankings', {
      group: 'RANKING',
      query: { type, marketCountry: 'KR', duration, excludeInvestmentCaution: true, count }
    });
    return Array.isArray(result?.rankings) ? result.rankings : [];
  }

  async getMarketCalendarKR(date = null) {
    return this.request('GET', '/api/v1/market-calendar/KR', { group: 'MARKET_INFO', query: { date } });
  }

  async getHoldings() {
    const result = await this.request('GET', '/api/v1/holdings', { group: 'ASSET', account: true });
    return Array.isArray(result?.items) ? result.items : [];
  }

  async getCashBuyingPower() {
    const result = await this.request('GET', '/api/v1/buying-power', {
      group: 'ORDER_INFO',
      account: true,
      query: { currency: 'KRW' }
    });
    return toNumber(result?.cashBuyingPower, null);
  }

  async createMarketOrder({ symbol, side, quantity, clientOrderId }) {
    const qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty) || qty <= 0) {
      throw new TossApiError('주문 수량은 1주 이상의 정수여야 합니다.', { code: 'invalid_quantity' });
    }
    return this.request('POST', '/api/v1/orders', {
      group: 'ORDER',
      account: true,
      body: {
        clientOrderId,
        symbol,
        side,
        orderType: 'MARKET',
        timeInForce: 'DAY',
        quantity: String(qty)
      }
    });
  }

  async getOrder(orderId) {
    return this.request('GET', `/api/v1/orders/${encodeURIComponent(orderId)}`, { group: 'ORDER_INFO', account: true });
  }

  async cancelOrder(orderId) {
    return this.request('POST', `/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
      group: 'ORDER',
      account: true,
      body: {},
      retries: 0
    });
  }

  /** 주문이 종결 상태가 될 때까지 대기. 시간 초과 시 잔량 취소를 시도한다. */
  async waitForOrderFill(orderId, { timeoutMs = 20000, pollMs = 700 } = {}) {
    const deadline = this.now() + timeoutMs;
    let order = null;
    while (this.now() < deadline) {
      order = await this.getOrder(orderId);
      if (TERMINAL_ORDER_STATUSES.has(order?.status)) break;
      await this.sleep(pollMs);
    }
    if (!TERMINAL_ORDER_STATUSES.has(order?.status)) {
      try {
        await this.cancelOrder(orderId);
      } catch {
        // 이미 체결/취소된 경우 등. 최종 상태는 아래 재조회로 판단한다.
      }
      order = await this.getOrder(orderId).catch(() => order);
    }
    const filledQuantity = toNumber(order?.execution?.filledQuantity, 0);
    return {
      order,
      status: order?.status || 'UNKNOWN',
      filledQuantity,
      averageFilledPrice: toNumber(order?.execution?.averageFilledPrice, null),
      commission: toNumber(order?.execution?.commission, 0),
      tax: toNumber(order?.execution?.tax, 0)
    };
  }
}

export default TossInvestClient;
