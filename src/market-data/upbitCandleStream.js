import { UPBIT_WEBSOCKET_URL as DEFAULT_URL } from '../api/upbit.js';

/**
 * Upbit 1-minute candles over one WebSocket connection.
 *
 * REST candle reads are limited per IP (about 10/s), so scanning every KRW
 * market every few seconds is impossible over REST. Upbit pushes `candle.1m`
 * updates for any number of subscribed markets on one connection; this cache
 * keeps the recent candles of each market and answers the strategy's
 * `getMinuteCandles(market, 1, count)` read without a network request.
 *
 * Integrity contract:
 * - A market is served from the cache only after a REST seed taken while the
 *   connection was already subscribed to it, so no minute can fall between
 *   the seed and the stream.
 * - Any disconnect, or a silent connection (no message within
 *   `staleAfterMs`), invalidates every seed. Reads fall back to REST until the
 *   market is re-seeded on the new connection; a missed minute is never
 *   served as if it did not exist.
 * - Within one candle the accumulated volume only grows, so the copy with the
 *   larger `candle_acc_trade_volume` wins between REST and stream updates.
 * Minutes without trades are omitted exactly like the REST endpoint.
 */

const MARKET_PATTERN = /^[A-Z0-9]+-[A-Z0-9]+$/;

function toRestCandle(message) {
  const market = message?.code;
  const time = message?.candle_date_time_utc;
  const values = ['opening_price', 'high_price', 'low_price', 'trade_price', 'candle_acc_trade_volume', 'candle_acc_trade_price']
    .map(key => Number(message?.[key]));
  if (typeof market !== 'string' || !MARKET_PATTERN.test(market) || typeof time !== 'string' ||
    values.some(value => !Number.isFinite(value))) {
    return null;
  }
  const [open, high, low, close, volume, amount] = values;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low || volume < 0) return null;
  return {
    market,
    candle_date_time_utc: time,
    candle_date_time_kst: typeof message.candle_date_time_kst === 'string' ? message.candle_date_time_kst : null,
    opening_price: open,
    high_price: high,
    low_price: low,
    trade_price: close,
    timestamp: Number.isFinite(Number(message.timestamp)) ? Number(message.timestamp) : null,
    candle_acc_trade_price: amount,
    candle_acc_trade_volume: volume,
    unit: 1
  };
}

function preferCandle(current, next) {
  if (!current) return next;
  return Number(next.candle_acc_trade_volume) >= Number(current.candle_acc_trade_volume) ? next : current;
}

function decodeFrame(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  return null;
}

export class UpbitMinuteCandleStream {
  #WebSocket;
  #url;
  #now;
  #historyLimit;
  #staleAfterMs;
  #pingIntervalMs;
  #logger;
  #timers;
  #socket = null;
  #open = false;
  #stopped = true;
  #epoch = 0;
  #subscribed = new Set();
  #desired = new Set();
  #entries = new Map();
  #flushTimer = null;
  #flushWaiters = [];
  #reconnectTimer = null;
  #reconnectDelayMs = 1000;
  #watchdog = null;
  #pinger = null;
  #lastMessageAt = 0;
  #openedAt = 0;
  #stats = { messages: 0, connects: 0, disconnects: 0, seeds: 0, cacheReads: 0, restFallbacks: 0, rejectedMessages: 0 };

  constructor({
    WebSocketImpl = globalThis.WebSocket,
    url = DEFAULT_URL,
    now = () => Date.now(),
    historyLimit = 200,
    staleAfterMs = 30_000,
    pingIntervalMs = 20_000,
    logger = console,
    timers = { setTimeout, clearTimeout, setInterval, clearInterval }
  } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new TypeError('A WebSocket implementation is required.');
    this.#WebSocket = WebSocketImpl;
    this.#url = url;
    this.#now = now;
    this.#historyLimit = Math.max(50, Math.floor(historyLimit));
    this.#staleAfterMs = staleAfterMs;
    this.#pingIntervalMs = pingIntervalMs;
    this.#logger = logger;
    this.#timers = timers;
  }

  /** Subscribes to these markets (in addition to any already requested). */
  start(markets = []) {
    for (const market of markets) {
      if (typeof market === 'string' && MARKET_PATTERN.test(market)) this.#desired.add(market);
    }
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
    this.#watchdog = this.#timers.setInterval(() => this.#checkLiveness(), 5_000);
    this.#watchdog?.unref?.();
  }

  stop() {
    this.#stopped = true;
    for (const timer of [this.#reconnectTimer, this.#flushTimer]) if (timer) this.#timers.clearTimeout(timer);
    for (const timer of [this.#watchdog, this.#pinger]) if (timer) this.#timers.clearInterval(timer);
    this.#reconnectTimer = this.#flushTimer = this.#watchdog = this.#pinger = null;
    this.#invalidate('stopped');
    try { this.#socket?.close(); } catch { /* already closed */ }
    this.#socket = null;
    this.#resolveFlushWaiters(false);
  }

  /** The connection is open, subscribed, and has delivered data recently. */
  isLive() {
    if (!this.#open || this.#subscribed.size === 0) return false;
    const lastActivity = Math.max(this.#lastMessageAt, this.#openedAt);
    return this.#now() - lastActivity <= this.#staleAfterMs;
  }

  getStatus() {
    let seeded = 0;
    for (const entry of this.#entries.values()) if (entry.seededEpoch === this.#epoch) seeded += 1;
    return {
      enabled: !this.#stopped,
      live: this.isLive(),
      subscribedMarkets: this.#subscribed.size,
      seededMarkets: seeded,
      lastMessageAt: this.#lastMessageAt ? new Date(this.#lastMessageAt).toISOString() : null,
      ...this.#stats
    };
  }

  /**
   * Newest-first 1-minute candles for `market`, Upbit REST shape. `fetchRest`
   * is the REST reader `(count) => candles`; it seeds the cache and is the
   * fallback whenever the stream cannot vouch for continuity.
   */
  async read(market, count, fetchRest) {
    const wanted = Math.floor(Number(count));
    if (!MARKET_PATTERN.test(String(market)) || !Number.isFinite(wanted) || wanted < 1 ||
      wanted > this.#historyLimit || this.#stopped) {
      this.#stats.restFallbacks += 1;
      return fetchRest(count);
    }
    if (!this.isLive()) {
      this.#desired.add(market);
      this.#scheduleFlush();
      this.#stats.restFallbacks += 1;
      return fetchRest(count);
    }
    let entry = this.#entries.get(market);
    if (entry?.seededEpoch === this.#epoch) {
      this.#stats.cacheReads += 1;
      return this.#snapshot(entry, wanted);
    }
    if (!entry?.seeding) {
      const epoch = this.#epoch;
      const seeding = (async () => {
        const subscribed = await this.#ensureSubscribed(market);
        const rest = await fetchRest(this.#historyLimit);
        if (subscribed && epoch === this.#epoch && this.isLive() && Array.isArray(rest)) {
          const target = this.#entryFor(market);
          for (const candle of rest) {
            if (candle?.candle_date_time_utc) {
              target.candles.set(candle.candle_date_time_utc, preferCandle(target.candles.get(candle.candle_date_time_utc), candle));
            }
          }
          this.#trim(target);
          target.seededEpoch = epoch;
          this.#stats.seeds += 1;
        }
        return rest;
      })();
      entry = this.#entryFor(market);
      entry.seeding = seeding;
      seeding.finally(() => {
        const current = this.#entries.get(market);
        if (current?.seeding === seeding) current.seeding = null;
      }).catch(() => { /* the awaiting reader receives the REST error */ });
    }
    const rest = await entry.seeding;
    const seeded = this.#entries.get(market);
    if (seeded?.seededEpoch === this.#epoch) {
      this.#stats.cacheReads += 1;
      return this.#snapshot(seeded, wanted);
    }
    this.#stats.restFallbacks += 1;
    return Array.isArray(rest) ? rest.slice(0, wanted) : rest;
  }

  // ------------------------------------------------------------------ internals
  #entryFor(market) {
    let entry = this.#entries.get(market);
    if (!entry) {
      entry = { candles: new Map(), seededEpoch: -1, seeding: null };
      this.#entries.set(market, entry);
    }
    return entry;
  }

  #snapshot(entry, count) {
    return [...entry.candles.keys()]
      .sort()
      .reverse()
      .slice(0, count)
      .map(key => ({ ...entry.candles.get(key) }));
  }

  #trim(entry) {
    const excess = entry.candles.size - (this.#historyLimit + 5);
    if (excess <= 0) return;
    const oldest = [...entry.candles.keys()].sort().slice(0, excess);
    for (const key of oldest) entry.candles.delete(key);
  }

  #invalidate(reason) {
    this.#epoch += 1;
    for (const entry of this.#entries.values()) {
      entry.candles.clear();
      entry.seededEpoch = -1;
    }
    this.#subscribed.clear();
    if (reason && reason !== 'stopped') this.#logger?.warn?.(`⚠️  실시간 1분봉 연결 끊김 (${reason}) - 다시 연결할 때까지 REST로 조회합니다.`);
  }

  #connect() {
    if (this.#stopped) return;
    let socket;
    try {
      socket = new this.#WebSocket(this.#url);
    } catch (error) {
      this.#logger?.warn?.(`⚠️  실시간 1분봉 연결 생성 실패: ${error?.message || error}`);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    try { socket.binaryType = 'arraybuffer'; } catch { /* optional */ }
    const handle = (name, listener) => {
      if (typeof socket.addEventListener === 'function') socket.addEventListener(name, listener);
      else socket[`on${name}`] = listener;
    };
    handle('open', () => {
      if (this.#socket !== socket) return;
      this.#open = true;
      this.#openedAt = this.#now();
      this.#reconnectDelayMs = 1000;
      this.#stats.connects += 1;
      this.#flush();
      if (this.#pinger) this.#timers.clearInterval(this.#pinger);
      this.#pinger = this.#timers.setInterval(() => {
        try { if (this.#open) socket.send('PING'); } catch { /* close handler reconnects */ }
      }, this.#pingIntervalMs);
      this.#pinger?.unref?.();
      this.#logger?.log?.(`🔌 실시간 1분봉 연결됨 (${this.#desired.size}개 마켓 구독)`);
    });
    handle('message', event => this.#onMessage(event?.data ?? event));
    const closed = reason => {
      if (this.#socket !== socket) return;
      const wasOpen = this.#open;
      this.#open = false;
      this.#socket = null;
      this.#stats.disconnects += 1;
      this.#invalidate(wasOpen ? reason : null);
      this.#resolveFlushWaiters(false);
      this.#scheduleReconnect();
    };
    handle('close', () => closed('close'));
    handle('error', () => {
      try { socket.close(); } catch { /* ignore */ }
      closed('error');
    });
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = this.#reconnectDelayMs;
    this.#reconnectDelayMs = Math.min(30_000, this.#reconnectDelayMs * 2);
    this.#reconnectTimer = this.#timers.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
    this.#reconnectTimer?.unref?.();
  }

  #checkLiveness() {
    if (!this.#open || this.#subscribed.size === 0) return;
    if (this.#now() - Math.max(this.#lastMessageAt, this.#openedAt) <= this.#staleAfterMs) return;
    const socket = this.#socket;
    this.#open = false;
    this.#socket = null;
    this.#stats.disconnects += 1;
    this.#invalidate('silent');
    this.#resolveFlushWaiters(false);
    try { socket?.close(); } catch { /* ignore */ }
    this.#scheduleReconnect();
  }

  #onMessage(data) {
    const text = decodeFrame(data);
    if (text === null) return;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    this.#lastMessageAt = this.#now();
    if (message?.type !== 'candle.1m') return;
    const candle = toRestCandle(message);
    if (!candle || !this.#subscribed.has(candle.market)) {
      this.#stats.rejectedMessages += 1;
      return;
    }
    this.#stats.messages += 1;
    const entry = this.#entryFor(candle.market);
    entry.candles.set(candle.candle_date_time_utc, preferCandle(entry.candles.get(candle.candle_date_time_utc), candle));
    this.#trim(entry);
  }

  #ensureSubscribed(market) {
    if (this.#open && this.#subscribed.has(market)) return Promise.resolve(true);
    this.#desired.add(market);
    return new Promise(resolve => {
      this.#flushWaiters.push(resolve);
      this.#scheduleFlush();
    });
  }

  #scheduleFlush() {
    if (this.#flushTimer || !this.#open) return;
    // Batch new markets into one subscription message (Upbit allows 5/s).
    this.#flushTimer = this.#timers.setTimeout(() => {
      this.#flushTimer = null;
      this.#flush();
    }, 250);
    this.#flushTimer?.unref?.();
  }

  #flush() {
    if (!this.#open || !this.#socket) return;
    const codes = [...this.#desired].sort();
    if (codes.length === 0) {
      this.#resolveFlushWaiters(false);
      return;
    }
    try {
      this.#socket.send(JSON.stringify([
        { ticket: `coinpilot-candles-${this.#now()}` },
        { type: 'candle.1m', codes },
        { format: 'DEFAULT' }
      ]));
      this.#subscribed = new Set(codes);
      this.#resolveFlushWaiters(true);
    } catch {
      this.#resolveFlushWaiters(false);
    }
  }

  #resolveFlushWaiters(subscribed) {
    const waiters = this.#flushWaiters;
    this.#flushWaiters = [];
    for (const resolve of waiters) resolve(subscribed);
  }
}

export function createUpbitMinuteCandleStream(options = {}) {
  return new UpbitMinuteCandleStream(options);
}

/**
 * The scalping runtime's stream: enabled by UPBIT_CANDLE_STREAM_ENABLED for
 * Upbit 1-minute scalping only, subscribed to the scanned universe, with a
 * periodic status line so the journal shows whether the cache is serving.
 */
export function createScalpingCandleStream(config, { logger = console } = {}) {
  if (!config?.upbitCandleStreamEnabled || config.exchange === 'binance' || !config.isScalpingMode ||
    Number(config.candleUnit || 1) !== 1) return null;
  return new UpbitMinuteCandleStream({ historyLimit: Math.max(200, Number(config.candleCount) || 200), logger });
}

export function startScalpingCandleStream(stream, source, markets, { logger = console, intervalMs = 10 * 60 * 1000 } = {}) {
  if (!stream) return null;
  stream.start(markets || []);
  const timer = setInterval(() => {
    const status = source.getCandleStreamStatus();
    logger.log(`📡 실시간 1분봉: ${status.live ? '연결됨' : '끊김'} · 구독 ${status.subscribedMarkets} · 준비 ${status.seededMarkets} · 캐시 조회 ${status.cacheReads} · REST 대체 ${status.restFallbacks} · 재연결 ${status.disconnects}`);
  }, intervalMs);
  timer.unref?.();
  return timer;
}
