import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Binance spot REST client presenting the Upbit-compatible surface used by the
 * trading system: getMarkets / getTicker / getMinuteCandles / getAccounts /
 * order / cancelOrder / getOrder / getOrders / waitForOrderFill.
 *
 * Market codes are normalized to the `QUOTE-BASE` convention (USDT-BTC ↔
 * BTCUSDT) so the rest of the codebase keeps working with exchange-neutral
 * codes. Responses are normalized to Upbit field names (trade_price,
 * candle_date_time_utc, executed_volume, ...) — values come from Binance.
 *
 * Order safety contract (same as UpbitAPI): a POST may have been accepted even
 * when its response is lost, so ambiguous dispatch errors are thrown — never
 * retried — and callers reconcile by identifier through getOrder().
 */

const BINANCE_MAINNET = 'https://api.binance.com';
const SUPPORTED_QUOTES = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'BTC', 'ETH']);
const MARKET_CODE_RE = /^[A-Z0-9]{2,10}-[A-Z0-9]{2,15}$/;
const MINUTE_UNIT_TO_INTERVAL = new Map([[1, '1m'], [3, '3m'], [5, '5m'], [15, '15m'], [30, '30m'], [60, '1h'], [240, '4h']]);
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const REQUEST_SPACING_MS = 60;
const RECV_WINDOW_MS = 5_000;
const WEIGHT_LIMIT_PER_MINUTE = 6_000;
const WEIGHT_SOFT_PAUSE = 0.8;

/** 'USDT-BTC' → 'BTCUSDT'. */
export function toBinanceSymbol(market) {
  if (typeof market !== 'string' || !MARKET_CODE_RE.test(market)) return null;
  const [quote, base] = market.split('-');
  return `${base}${quote}`;
}

/** 'BTCUSDT' → 'USDT-BTC' when the quote asset is known. */
export function fromBinanceSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const upper = symbol.toUpperCase();
  for (const quote of ['USDT', 'USDC', 'FDUSD', 'TUSD', 'BTC', 'ETH']) {
    if (upper.length > quote.length && upper.endsWith(quote)) {
      return `${quote}-${upper.slice(0, -quote.length)}`;
    }
  }
  return null;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Binance KST offset is fixed; the API timestamps are UTC epoch ms. */
function isoUtc(ms) {
  return new Date(ms).toISOString();
}

function isoKst(ms) {
  return new Date(ms + 9 * 3_600_000).toISOString().replace('Z', '+09:00');
}

export class BinanceExchange {
  constructor({ accessKey = '', secretKey = '', baseURL = BINANCE_MAINNET, requestTimeoutMs, stateDir = null, quoteAsset = 'USDT' } = {}) {
    this.accessKey = String(accessKey || '');
    this.secretKey = String(secretKey || '');
    this.baseURL = String(baseURL || BINANCE_MAINNET).replace(/\/+$/, '');
    this.requestTimeoutMs = Number.isFinite(Number(requestTimeoutMs)) && Number(requestTimeoutMs) > 0
      ? Number(requestTimeoutMs)
      : DEFAULT_REQUEST_TIMEOUT_MS;
    this.quoteAsset = SUPPORTED_QUOTES.has(String(quoteAsset).toUpperCase())
      ? String(quoteAsset).toUpperCase()
      : 'USDT';
    this.exchange = 'binance';
    this.quoteCurrency = this.quoteAsset;

    this._queue = Promise.resolve();
    this._lastRequestAt = 0;
    this._timeOffsetMs = null;
    this._symbolInfoCache = null;      // Map<symbol, {filters, base, quote}>
    this._clientOrderSymbols = new Map(); // clientOrderId → symbol
    this._stateDir = stateDir || null;
    this._indexFile = this._stateDir ? path.join(this._stateDir, 'binance-order-index.json') : null;
    this._loadOrderIndex();
  }

  // ------------------------------------------------------------------ queue

  _enqueue(fn, { timeoutMs = this.requestTimeoutMs } = {}) {
    const run = this._queue.then(async () => {
      const waitMs = Math.max(0, this._lastRequestAt + REQUEST_SPACING_MS - Date.now());
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      this._lastRequestAt = Date.now();
      return fn();
    });
    this._queue = run.catch(() => {});
    return Promise.race([
      run,
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('Binance request timed out.'), { code: 'binance_timeout' })), timeoutMs + 15_000))
    ]);
  }

  _signedParams(params) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    query.set('timestamp', String(this._now() + (this._timeOffsetMs ?? 0)));
    query.set('recvWindow', String(RECV_WINDOW_MS));
    const signature = crypto
      .createHmac('sha256', this.secretKey)
      .update(query.toString())
      .digest('hex');
    query.set('signature', signature);
    return query;
  }

  _now() { return Date.now(); }

  async _signedRequest(method, endpoint, params = {}, requestOptions = {}) {
    if (!this.accessKey || !this.secretKey) {
      const error = new Error('Binance API credentials are not configured.');
      error.code = 'binance_credentials_missing';
      throw error;
    }
    const query = this._signedParams(params);
    const headers = { 'X-MBX-APIKEY': this.accessKey };
    const url = `${this.baseURL}${endpoint}`;
    return this._enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestOptions.timeoutMs ?? this.requestTimeoutMs);
      try {
        const init = { method, headers, signal: controller.signal };
        const fullUrl = method === 'POST' || method === 'DELETE'
          ? url
          : `${url}?${query.toString()}`;
        if (method === 'POST' || method === 'DELETE') {
          init.body = query.toString();
          init.headers = { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' };
        }
        const response = await fetch(fullUrl, init);
        return await this._readResponse(response);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async _publicRequest(endpoint, params = {}, requestOptions = {}) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value));
    }
    const url = query.size ? `${this.baseURL}${endpoint}?${query.toString()}` : `${this.baseURL}${endpoint}`;
    return this._enqueue(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestOptions.timeoutMs ?? this.requestTimeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        return await this._readResponse(response);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  async _readResponse(response) {
    const weight = Number(response.headers?.get?.('x-mbx-used-weight-1m'));
    if (Number.isFinite(weight) && weight >= WEIGHT_LIMIT_PER_MINUTE * WEIGHT_SOFT_PAUSE) {
      this._lastRequestAt = Date.now() + 30_000; // pause the queue before the ban threshold
    }
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
    if (response.status === 418 || response.status === 429) {
      const retryAfterMs = Number(response.headers?.get?.('retry-after')) * 1000 || 60_000;
      const error = Object.assign(new Error(`Binance rate limit (HTTP ${response.status}).`), {
        code: 'binance_rate_limited', retryAfterMs
      });
      throw error;
    }
    if (response.status >= 400) {
      const error = Object.assign(new Error(body?.msg || `Binance HTTP ${response.status}`), {
        code: body?.code ?? `http_${response.status}`,
        status: response.status
      });
      throw error;
    }
    return body;
  }

  // ----------------------------------------------------------- symbol index

  async _symbolInfo(symbol) {
    if (!this._symbolInfoCache) {
      const info = await this._publicRequest('/api/v3/exchangeInfo');
      const map = new Map();
      for (const row of info?.symbols || []) {
        if (row?.status === 'TRADING' && row?.isSpotTradingAllowed === true) map.set(row.symbol, row);
      }
      this._symbolInfoCache = map;
    }
    return this._symbolInfoCache.get(symbol) || null;
  }

  _filters(symbolInfo) {
    const filters = {};
    for (const filter of symbolInfo?.filters || []) filters[filter.filterType] = filter;
    const tickSize = toNumber(filters.PRICE_FILTER?.tickSize);
    const stepSize = toNumber(filters.LOT_SIZE?.stepSize);
    const minNotional = toNumber(filters.NOTIONAL?.minNotional ?? filters.MIN_NOTIONAL?.minNotional);
    return { tickSize, stepSize, minNotional, minQty: toNumber(filters.LOT_SIZE?.minQty) };
  }

  static _roundDown(value, step) {
    if (!isFiniteNumber(value) || !isFiniteNumber(step) || step <= 0) return value;
    const precision = Math.max(0, Math.round(-Math.log10(step)));
    return Number((Math.floor(value / step) * step).toFixed(precision));
  }

  _recordClientOrderSymbol(clientOrderId, symbol) {
    if (clientOrderId && symbol) {
      this._clientOrderSymbols.set(clientOrderId, symbol);
      if (this._clientOrderSymbols.size > 5_000) {
        this._clientOrderSymbols.delete(this._clientOrderSymbols.keys().next().value);
      }
      this._persistOrderIndex();
    }
  }

  _loadOrderIndex() {
    if (!this._indexFile) return;
    try {
      const rows = JSON.parse(fs.readFileSync(this._indexFile, 'utf8'));
      if (Array.isArray(rows)) {
        for (const [id, symbol] of rows) {
          if (typeof id === 'string' && typeof symbol === 'string') this._clientOrderSymbols.set(id, symbol);
        }
      }
    } catch { /* fresh index */ }
  }

  _persistOrderIndex() {
    if (!this._indexFile) return;
    try {
      fs.mkdirSync(path.dirname(this._indexFile), { recursive: true });
      fs.writeFileSync(this._indexFile, JSON.stringify([...this._clientOrderSymbols].slice(-5_000)));
    } catch { /* index persistence is best-effort */ }
  }

  // ------------------------------------------------------------ data reads

  /** Upbit-shaped market list: [{ market: 'USDT-BTC' }] for the configured quote. */
  async getMarkets() {
    const info = await this._publicRequest('/api/v3/exchangeInfo');
    return (info?.symbols || [])
      .filter(row => row?.status === 'TRADING' && row?.isSpotTradingAllowed === true &&
        row.quoteAsset === this.quoteAsset)
      .map(row => ({ market: `${row.quoteAsset}-${row.baseAsset}` }));
  }

  /** Upbit-shaped 24h tickers: trade_price, signed_change_rate(fraction), high/low, 24h quote volume. */
  async getTicker(markets, requestOptions = {}) {
    const list = Array.isArray(markets) ? markets : String(markets || '').split(',');
    const symbols = list.map(toBinanceSymbol).filter(Boolean);
    if (!symbols.length) return [];
    const query = symbols.length === 1
      ? { symbol: symbols[0] }
      : { symbols: JSON.stringify(symbols) };
    const rows = await this._publicRequest('/api/v3/ticker/24hr', query, requestOptions);
    const arr = Array.isArray(rows) ? rows : rows ? [rows] : [];
    return arr.map(row => ({
      market: fromBinanceSymbol(row.symbol) || row.symbol,
      trade_price: toNumber(row.lastPrice),
      opening_price: toNumber(row.openPrice),
      high_price: toNumber(row.highPrice),
      low_price: toNumber(row.lowPrice),
      prev_closing_price: toNumber(row.prevClosePrice),
      signed_change_rate: (toNumber(row.priceChangePercent) ?? 0) / 100,
      acc_trade_volume_24h: toNumber(row.volume),
      acc_trade_price_24h: toNumber(row.quoteVolume),
      timestamp: toNumber(row.closeTime) ?? Date.now()
    }));
  }

  /** Upbit-shaped minute candles, newest first. */
  async getMinuteCandles(market, unit = 5, count = 200, requestOptions = {}) {
    const symbol = toBinanceSymbol(market);
    const interval = MINUTE_UNIT_TO_INTERVAL.get(Number(unit));
    if (!symbol || !interval) throw new TypeError(`Unsupported market or unit: ${market}/${unit}`);
    const limit = Math.max(1, Math.min(1000, Math.floor(count)));
    const params = { symbol, interval, limit };
    if (requestOptions?.to) {
      const cursor = Date.parse(requestOptions.to);
      if (Number.isFinite(cursor)) params.endTime = cursor - 1;
    }
    const rows = await this._publicRequest('/api/v3/klines', params, requestOptions);
    return (Array.isArray(rows) ? rows : []).map(k => ({
      market,
      candle_date_time_utc: isoUtc(k[0]),
      candle_date_time_kst: isoKst(k[0]),
      opening_price: toNumber(k[1]),
      high_price: toNumber(k[2]),
      low_price: toNumber(k[3]),
      trade_price: toNumber(k[4]),
      timestamp: k[6],
      candle_acc_trade_price: toNumber(k[7]),
      candle_acc_trade_volume: toNumber(k[5]),
      unit: Number(unit)
    })).reverse(); // Binance returns oldest-first; the codebase expects newest-first.
  }

  /** Upbit-shaped balances: [{ currency, balance, locked, avg_buy_price, unit_currency }]. */
  async getAccounts(requestOptions = {}) {
    const account = await this._signedRequest('GET', '/api/v3/account', {}, requestOptions);
    const balances = Array.isArray(account?.balances) ? account.balances : [];
    return balances
      .map(b => ({
        currency: b.asset,
        balance: toNumber(b.free) ?? 0,
        locked: toNumber(b.locked) ?? 0,
        avg_buy_price: 0,
        unit_currency: this.quoteAsset
      }))
      .filter(b => b.balance > 0 || b.locked > 0 || b.currency === this.quoteAsset);
  }

  // ------------------------------------------------------------- order ops

  /**
   * Upbit-compatible order(): returns { success, data } / { success:false, error }
   * or throws when dispatch was ambiguous (same no-redispatch contract).
   */
  async order(market, side, volume, price = null, ord_type = 'limit', identifier = null, requestOptions = {}) {
    const symbol = toBinanceSymbol(market);
    if (!symbol) return { success: false, error: { code: 'market_does_not_exist', message: `unknown market ${market}` } };
    const clientOrderId = (typeof identifier === 'string' && identifier.trim())
      ? identifier.trim().replace(/[^A-Za-z0-9_-]/g, '')
      : `coinpilot-${crypto.randomUUID()}`;

    const symbolInfo = await this._symbolInfo(symbol);
    const { tickSize, stepSize, minNotional, minQty } = this._filters(symbolInfo);

    const params = {
      symbol,
      side: side === 'bid' ? 'BUY' : 'SELL',
      newClientOrderId: clientOrderId,
      newOrderRespType: 'FULL'
    };
    if (ord_type === 'price') {
      // KRW-amount market buy → quoteOrderQty market buy
      const quoteAmount = toNumber(price ?? volume);
      if (!isFiniteNumber(quoteAmount) || quoteAmount <= 0) {
        return { success: false, error: { code: 'invalid_funds_bid', message: 'invalid order amount' } };
      }
      params.type = 'MARKET';
      params.quoteOrderQty = quoteAmount;
      if (minNotional !== null && quoteAmount < minNotional) {
        return { success: false, error: { code: 'under_min_total_bid', message: `below min notional ${minNotional} ${this.quoteAsset}` } };
      }
    } else if (ord_type === 'market') {
      // quantity market sell
      let qty = toNumber(volume);
      if (!isFiniteNumber(qty) || qty <= 0) {
        return { success: false, error: { code: 'invalid_volume_ask', message: 'invalid order volume' } };
      }
      qty = BinanceExchange._roundDown(qty, stepSize);
      params.type = 'MARKET';
      params.quantity = qty;
      if (minQty !== null && qty < minQty) {
        return { success: false, error: { code: 'invalid_volume_ask', message: `below min qty ${minQty}` } };
      }
    } else {
      // limit order
      let qty = toNumber(volume);
      let px = toNumber(price);
      if (!isFiniteNumber(qty) || !isFiniteNumber(px) || qty <= 0 || px <= 0) {
        return { success: false, error: { code: 'invalid_order', message: 'invalid limit order' } };
      }
      qty = BinanceExchange._roundDown(qty, stepSize);
      px = BinanceExchange._roundDown(px, tickSize);
      if (minQty !== null && qty < minQty) {
        return { success: false, error: { code: 'invalid_volume_bid', message: `below min qty ${minQty}` } };
      }
      if (minNotional !== null && qty * px < minNotional) {
        return { success: false, error: { code: 'under_min_total_bid', message: `below min notional ${minNotional} ${this.quoteAsset}` } };
      }
      params.type = 'LIMIT';
      params.timeInForce = 'GTC';
      params.quantity = qty;
      params.price = px;
    }

    try {
      this._recordClientOrderSymbol(clientOrderId, symbol);
      const data = await this._signedRequest('POST', '/api/v3/order', params, requestOptions);
      return { success: true, data: this._normalizeOrder(data, market) };
    } catch (error) {
      if (error?.code === 'binance_credentials_missing') throw error;
      const code = error?.code;
      const nonRetryable = new Set([-2010, -1013, -1100, -1104, -2011, -2015, -2018, -1021]);
      if (nonRetryable.has(code)) {
        const mapped = code === -2010
          ? (side === 'bid' ? 'insufficient_funds_bid' : 'insufficient_funds_ask')
          : code === -1013 ? (side === 'bid' ? 'under_min_total_bid' : 'invalid_volume_ask')
          : `binance_${code}`;
        return { success: false, error: { code: mapped, message: error.message, dispatched: true } };
      }
      // Ambiguous dispatch (timeout/network/5xx): the order may exist. Same
      // contract as UpbitAPI — throw so callers reconcile by identifier.
      throw error;
    }
  }

  async cancelOrder(clientOrderId, requestOptions = {}) {
    const symbol = await this._symbolForClientOrder(clientOrderId);
    if (!symbol) throw new Error(`Cannot resolve market for order ${clientOrderId}`);
    const data = await this._signedRequest('DELETE', '/api/v3/order',
      { symbol, origClientOrderId: clientOrderId }, requestOptions);
    return this._normalizeOrder(data);
  }

  async getOrder(uuidOrIdentifier, requestOptions = {}) {
    const symbol = await this._symbolForClientOrder(uuidOrIdentifier);
    if (!symbol) return null;
    try {
      const data = await this._signedRequest('GET', '/api/v3/order',
        { symbol, origClientOrderId: uuidOrIdentifier }, requestOptions);
      return this._normalizeOrder(data, fromBinanceSymbol(symbol));
    } catch (error) {
      if (error?.code === -2013) return null; // order does not exist
      throw error;
    }
  }

  async getOrders(market, states = ['wait'], requestOptions = {}) {
    const symbol = toBinanceSymbol(market);
    if (!symbol) return [];
    const rows = await this._signedRequest('GET', '/api/v3/openOrders', { symbol }, requestOptions);
    const wanted = new Set(states);
    return (Array.isArray(rows) ? rows : [])
      .map(row => this._normalizeOrder(row, market))
      .filter(row => wanted.has(row.state === 'wait' ? 'wait' : row.state) ||
        (wanted.has('watch') && row.state === 'wait'));
  }

  async waitForOrderFill(clientOrderId, maxWaitMs = 30_000, checkIntervalMs = 1_000, requestOptions = {}) {
    const deadline = Date.now() + Math.max(0, Number(maxWaitMs) || 0);
    while (Date.now() < deadline) {
      const order = await this.getOrder(clientOrderId, requestOptions);
      if (!order) return { filled: false, order: null, error: '주문 조회 실패' };
      if (order.state === 'done') return { filled: true, order };
      if (order.state === 'cancel') return { filled: false, order, error: '주문이 취소됨' };
      const executed = Number(order.executed_volume || 0);
      const remaining = Number(order.remaining_volume ?? 1);
      if (executed > 0 && remaining === 0) return { filled: true, order };
      await new Promise(resolve => setTimeout(resolve, Math.max(200, checkIntervalMs)));
    }
    return { filled: false, order: null, error: '체결 대기 시간 초과', deadlineExceeded: true };
  }

  async _symbolForClientOrder(clientOrderId) {
    const cached = this._clientOrderSymbols.get(clientOrderId);
    if (cached) return cached;
    // Restart path: scan open orders across all symbols for the identifier.
    try {
      const openOrders = await this._signedRequest('GET', '/api/v3/openOrders', {});
      for (const row of Array.isArray(openOrders) ? openOrders : []) {
        if (row?.clientOrderId) this._recordClientOrderSymbol(row.clientOrderId, row.symbol);
        if (row?.clientOrderId === clientOrderId) return row.symbol;
      }
    } catch { /* unresolved */ }
    return null;
  }

  // -------------------------------------------------------- normalization

  _normalizeOrder(raw, market = null) {
    const executedQty = toNumber(raw?.executedQty) ?? 0;
    const origQty = toNumber(raw?.origQty);
    const quoteQty = toNumber(raw?.cummulativeQuoteQty);
    const status = String(raw?.status || '').toUpperCase();
    const state = status === 'FILLED' ? 'done'
      : ['CANCELED', 'EXPIRED', 'REJECTED', 'PENDING_CANCEL'].includes(status) ? 'cancel'
      : 'wait';
    const avgPrice = executedQty > 0 && isFiniteNumber(quoteQty) ? quoteQty / executedQty : toNumber(raw?.price);
    const paidFee = this._commissionToQuote(raw?.fills, avgPrice);
    const isMarketBuy = raw?.type === 'MARKET' && raw?.side === 'BUY';
    return {
      uuid: raw?.clientOrderId || (raw?.orderId !== undefined ? String(raw.orderId) : null),
      side: raw?.side === 'BUY' ? 'bid' : 'ask',
      ord_type: raw?.type === 'LIMIT' ? 'limit' : (isMarketBuy ? 'price' : 'market'),
      price: toNumber(raw?.price) ?? (isMarketBuy ? quoteQty : null),
      state,
      market: market || fromBinanceSymbol(raw?.symbol) || raw?.symbol || null,
      created_at: isoUtc(raw?.transactTime ?? raw?.time ?? Date.now()),
      volume: origQty,
      remaining_volume: state === 'done' ? 0 : Math.max(0, (origQty ?? 0) - executedQty),
      paid_fee: paidFee,
      executed_volume: executedQty,
      avg_price: avgPrice,
      trades_count: Array.isArray(raw?.fills) ? raw.fills.length : null
    };
  }

  /** Commission sums → quote currency. BNB fees convert via the BNBUSDT mark when cached. */
  _commissionToQuote(fills, fallbackPrice) {
    if (!Array.isArray(fills) || !fills.length) return 0;
    let quoteFee = 0;
    for (const fill of fills) {
      const commission = toNumber(fill?.commission) ?? 0;
      const asset = fill?.commissionAsset;
      if (asset === this.quoteAsset) { quoteFee += commission; continue; }
      const px = toNumber(fill?.price) ?? fallbackPrice;
      quoteFee += isFiniteNumber(px) ? commission * px : 0;
    }
    return quoteFee;
  }

  /** Local order-id → symbol index plus exchange lookups for recovery. */
  get _orderIndexSize() { return this._clientOrderSymbols.size; }
}
