// 주식 자동매매 서비스: 하나의 토스 클라이언트(시세 rate limit 공유)로
// 모의(paper)/실전(live) 트레이더를 상시 실행한다(기본은 프로세스의 코인 프로필과 같은 모드).
// - 장이 열리면 자동으로 매매하고, 장외 시간에는 대기한다(프로세스는 계속 실행).
// - 운영자가 중지한 트레이더는 desiredRunning=false로 기록되어 재부팅 후에도 중지 상태를 유지한다.
// - 대상 종목: STOCK_SYMBOLS가 비어 있으면 실시간 거래대금·거래량·토스 거래대금·
//   하락률·상승률 순위(각 최대 100)를 합쳐 현재 시드로 1주 이상 살 수 있는 종목을 고른다.
// - 전체 종목 감시: 코스피·코스닥 상장 보통주 전체(약 2,500개)의 현재가를 10초마다 받아
//   분 단위 가격 이력을 만들고, 최근 5분 고점 대비 급락한 종목을 그 분의 1분봉 스캔에
//   우선 넣는다(전 종목 1분봉을 매분 받는 것은 rate limit상 약 2.5분이 걸려 불가능).
// - 토스 WebSocket에는 분봉 채널이 없고 체결 프레임은 유실·누적거래량 부재로 분봉을
//   복원할 수 없다(공식 스펙). 그래서 1분봉은 분이 바뀔 때마다 한 번만 REST로 훑고,
//   10초 사이클은 그 분의 스냅샷과 현재가로 진입·청산을 판단한다. 이전 분의 스냅샷은
//   진입에 쓰지 않는다(스캔이 끝나기 전에는 신규 진입 없이 보유 청산만 점검).

import path from 'node:path';
import TossInvestClient, { toNumber } from './tossInvestClient.js';
import StockMarketSession from './stockMarketSession.js';
import StockTrader from './stockTrader.js';
import { createStockHorizonRuntime } from '../portfolio/horizonService.js';

const UNIVERSE_REFRESH_MS = 30 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const LISTING_REFRESH_MS = 12 * 60 * 60 * 1000;
const LISTING_MARKETS = ['KOSPI', 'KOSDAQ'];
const MOVER_LOOKBACK_MINUTES = 5;
const MOVER_MIN_DROP_PERCENT = 1;
// 마지막 체결이 이보다 오래된 종목은 유동성이 없다고 보고 급락 후보에서 뺀다.
const MOVER_MAX_QUOTE_AGE_MS = 2 * MINUTE_MS;
// 순위 API는 종류당 최대 100건이다. 거래대금 순서를 우선하고 나머지로 넓힌다.
const UNIVERSE_RANKING_TYPES = [
  'MARKET_TRADING_AMOUNT',
  'TOSS_SECURITIES_TRADING_AMOUNT',
  'MARKET_TRADING_VOLUME',
  'TOP_LOSERS',
  'TOP_GAINERS'
];

export function createStockConfig(env = {}) {
  return {
    enabled: env.STOCK_TRADING_ENABLED === true,
    clientId: env.TOSS_CLIENT_ID || '',
    clientSecret: env.TOSS_CLIENT_SECRET || '',
    accountSeq: env.TOSS_ACCOUNT_SEQ ?? null,
    // 기본값은 이 프로세스의 코인 프로필을 따른다(모의 서버 → 주식 모의, 실전 서버 → 주식 실전).
    // 모의/실전 서버가 각각 떠 있는 배포에서 실전 주문이 두 프로세스에서 중복되지 않게 한다.
    paperEnabled: env.STOCK_PAPER_ENABLED ?? env.DRY_RUN !== false,
    liveEnabled: env.STOCK_LIVE_ENABLED ?? env.DRY_RUN === false,
    symbols: Array.isArray(env.STOCK_SYMBOLS) ? env.STOCK_SYMBOLS.map(s => String(s).trim()).filter(Boolean) : [],
    maxSymbols: env.STOCK_MAX_SYMBOLS ?? 300,
    watchAllStocks: env.STOCK_WATCH_ALL ?? true,
    minPrice: env.STOCK_MIN_PRICE ?? 1000,
    cycleIntervalMs: env.STOCK_CYCLE_INTERVAL_MS ?? 10000,
    trader: {
      seedMoney: env.STOCK_PAPER_SEED_MONEY ?? 50000,
      maxPositions: env.STOCK_MAX_POSITIONS ?? 3,
      investmentRatio: env.STOCK_INVESTMENT_RATIO ?? 0.3,
      stopLossPercent: env.STOCK_STOP_LOSS_PERCENT ?? 1.5,
      takeProfitPercent: env.STOCK_TAKE_PROFIT_PERCENT ?? 2,
      maxHoldMinutes: env.STOCK_MAX_HOLD_MINUTES ?? 60,
      commissionRate: env.STOCK_COMMISSION_RATE ?? 0.00015,
      sellTaxRate: env.STOCK_SELL_TAX_RATE ?? 0.002,
      rsiOversold: env.STOCK_RSI_OVERSOLD ?? 30
    },
    stateDir: env.COINPILOT_STATE_DIR || process.cwd()
  };
}

export class StockTradingService {
  constructor(config, { client = null, marketSession = null, horizonConfig = null, env = process.env, now = Date.now, log = console } = {}) {
    this.config = config;
    this.now = now;
    this.log = log;
    this.client = client || new TossInvestClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      accountSeq: config.accountSeq
    });
    this.marketSession = marketSession || new StockMarketSession({ client: this.client, now });
    this.traders = {};
    if (config.paperEnabled) {
      this.traders.paper = new StockTrader({
        mode: 'paper',
        client: this.client,
        marketSession: this.marketSession,
        config: config.trader,
        stateFile: path.join(config.stateDir, 'stock_paper_portfolio.json'),
        now,
        log
      });
    }
    if (config.liveEnabled) {
      this.traders.live = new StockTrader({
        mode: 'live',
        client: this.client,
        marketSession: this.marketSession,
        config: config.trader,
        stateFile: path.join(config.stateDir, 'stock_live_ledger.json'),
        now,
        log
      });
    }
    // 차트 분석 기반 기간별(스윙/중기 등) 포트폴리오 — 스캘퍼와 같은 계좌·시세 클라이언트 공유
    this.horizons = {};
    if (horizonConfig?.enabled) {
      for (const mode of ['paper', 'live']) {
        if (!this.traders[mode]) continue;
        this.horizons[mode] = createStockHorizonRuntime({
          config: horizonConfig,
          mode,
          client: this.client,
          marketSession: this.marketSession,
          scalper: this.traders[mode],
          minPrice: config.minPrice,
          env,
          log
        });
      }
    }
    this.universe = [];
    this.universeUpdatedAt = 0;
    this.lastUniverseError = null;
    this.candleSnapshot = null;
    this.allSymbols = [];
    this.allSymbolsUpdatedAt = 0;
    this.lastListingError = null;
    this.priceHistory = new Map();
    this.priceCeiling = Infinity;
    this.lastMovers = [];
    this.lastCandleScan = null;
    this._candleScanInFlight = null;
    this._timer = null;
    this._tickInFlight = null;
  }

  get credentialsConfigured() {
    return this.client.credentialsConfigured;
  }

  /** 가장 작은 계좌 기준으로 1주를 살 수 있는 가격 상한. */
  async _affordablePriceCeiling() {
    const ceilings = [];
    for (const trader of Object.values(this.traders)) {
      try {
        const cash = await trader.availableCash();
        ceilings.push(cash + trader.positionsValue(new Map()));
      } catch {
        // LIVE 잔고 조회 실패 시 해당 계좌는 상한 계산에서 제외한다.
      }
    }
    if (ceilings.length === 0) return Infinity;
    return Math.max(...ceilings);
  }

  async refreshUniverse({ force = false } = {}) {
    if (!force && this.universe.length > 0 && this.now() - this.universeUpdatedAt < UNIVERSE_REFRESH_MS) {
      return this.universe;
    }
    if (this.config.symbols.length > 0) {
      this.universe = this.config.symbols.slice(0, this.config.maxSymbols);
      this.universeUpdatedAt = this.now();
      return this.universe;
    }
    try {
      const ceiling = await this._affordablePriceCeiling();
      this.priceCeiling = ceiling;
      const seen = new Set();
      const universe = [];
      let rankingFailures = 0;
      for (const type of UNIVERSE_RANKING_TYPES) {
        let rankings;
        try {
          rankings = await this.client.getRankings({ type, duration: 'realtime', count: 100 });
        } catch (error) {
          rankingFailures++;
          if (rankingFailures === UNIVERSE_RANKING_TYPES.length) throw error;
          continue;
        }
        for (const item of rankings) {
          if (item?.currency !== 'KRW' && item?.currency !== undefined) continue;
          const price = toNumber(item?.price?.lastPrice, null);
          if (price === null || price < this.config.minPrice || price > ceiling) continue;
          if (!item.symbol || seen.has(item.symbol)) continue;
          seen.add(item.symbol);
          universe.push(item.symbol);
        }
      }
      this.universe = universe.slice(0, this.config.maxSymbols);
      this.universeUpdatedAt = this.now();
      this.lastUniverseError = this.universe.length === 0 ? `시드로 살 수 있는 종목이 없습니다 (1주 상한 ${Math.floor(ceiling).toLocaleString()}원)` : null;
    } catch (error) {
      this.lastUniverseError = `종목 선별 실패: ${error.message}`;
    }
    return this.universe;
  }

  /** 코스피·코스닥 상장 보통주 전체 목록. 실패하면 순위 기반 유니버스만 쓴다. */
  async refreshListings() {
    if (this.config.symbols.length > 0 || this.config.watchAllStocks === false) return this.allSymbols;
    if (this.allSymbols.length > 0 && this.now() - this.allSymbolsUpdatedAt < LISTING_REFRESH_MS) return this.allSymbols;
    try {
      const symbols = new Set();
      for (const market of LISTING_MARKETS) {
        for (const item of await this.client.listStocks(market)) {
          if (item?.symbol) symbols.add(String(item.symbol));
        }
      }
      if (symbols.size > 0) {
        this.allSymbols = [...symbols];
        this.allSymbolsUpdatedAt = this.now();
        this.lastListingError = null;
      }
    } catch (error) {
      this.lastListingError = `전체 종목 목록 조회 실패: ${error.message}`;
      // 다음 시도까지 반복 호출하지 않도록 잠시 미룬다.
      this.allSymbolsUpdatedAt = this.now() - LISTING_REFRESH_MS + 10 * MINUTE_MS;
    }
    return this.allSymbols;
  }

  /** 분마다 마지막 현재가를 기록한다(종목당 최근 몇 분만 유지). */
  recordPrices(prices, nowMs) {
    const minute = Math.floor(nowMs / MINUTE_MS);
    for (const [symbol, quote] of prices) {
      let history = this.priceHistory.get(symbol);
      if (!history) {
        history = [];
        this.priceHistory.set(symbol, history);
      }
      const last = history.at(-1);
      const entry = { minute, price: quote.price, quoteMs: Date.parse(quote.timestamp) || null };
      if (last?.minute === minute) history[history.length - 1] = entry;
      else history.push(entry);
      while (history.length > MOVER_LOOKBACK_MINUTES + 1) history.shift();
    }
  }

  /** 최근 5분 고점 대비 급락했고 최근 체결이 있는 종목, 하락폭 큰 순. */
  findMovers(nowMs, limit) {
    const movers = [];
    for (const [symbol, history] of this.priceHistory) {
      if (history.length < 3) continue;
      const latest = history.at(-1);
      if (latest.quoteMs === null || nowMs - latest.quoteMs > MOVER_MAX_QUOTE_AGE_MS) continue;
      if (latest.price < this.config.minPrice || latest.price > this.priceCeiling) continue;
      const high = Math.max(...history.map(item => item.price));
      const dropPercent = (latest.price - high) / high * 100;
      if (dropPercent <= -MOVER_MIN_DROP_PERCENT) movers.push({ symbol, dropPercent });
    }
    movers.sort((a, b) => a.dropPercent - b.dropPercent);
    return movers.slice(0, limit);
  }

  /** 이번 분 1분봉 스캔 대상: 급락 종목을 먼저, 나머지는 순위 유니버스로 채운다. */
  composeScanUniverse(rankingUniverse, nowMs) {
    const moverLimit = this.allSymbols.length > 0 ? Math.floor(this.config.maxSymbols / 3) : 0;
    this.lastMovers = moverLimit > 0 ? this.findMovers(nowMs, moverLimit) : [];
    const scan = [];
    const seen = new Set();
    for (const symbol of [...this.lastMovers.map(item => item.symbol), ...rankingUniverse]) {
      if (seen.has(symbol)) continue;
      seen.add(symbol);
      scan.push(symbol);
      if (scan.length >= this.config.maxSymbols) break;
    }
    return scan;
  }

  async tick() {
    if (this._tickInFlight) return this._tickInFlight;
    this._tickInFlight = (async () => {
      const running = Object.values(this.traders).filter(trader => trader.isRunning);
      if (running.length === 0) return;
      const market = await this.marketSession.getState();
      if (!market.open) {
        for (const trader of running) await trader.runCycle([]);
        return;
      }
      const rankingUniverse = await this.refreshUniverse();
      const allSymbols = await this.refreshListings();
      const nowMs = this.now();
      const minute = Math.floor(nowMs / MINUTE_MS);
      // 진입 후보는 이번 분의 1분봉 스냅샷이 있는 종목만이다. 스캔 중이면 보유 청산만 점검한다.
      const snapshot = market.canEnter && this.candleSnapshot?.minute === minute ? this.candleSnapshot : null;
      const universe = snapshot ? snapshot.symbols.filter(symbol => snapshot.candles.has(symbol)) : [];
      const symbols = [...new Set([...running.flatMap(trader => trader.requiredSymbols(universe)), ...allSymbols])];
      // 같은 사이클의 모의/실전이 동일 시세·캔들을 보도록 한 번만 조회해 공유한다.
      const prices = symbols.length > 0 ? await this.client.getPrices(symbols) : new Map();
      this.recordPrices(prices, nowMs);
      if (market.canEnter && this.candleSnapshot?.minute !== minute) {
        this._startCandleScan(this.composeScanUniverse(rankingUniverse, nowMs), minute);
      }
      const candlesBySymbol = snapshot?.candles ?? new Map();
      for (const trader of running) await trader.runCycle(universe, { prices, candlesBySymbol });
    })()
      .catch(error => this.log.error?.(`❌ [주식] 사이클 오류: ${error.message}`))
      .finally(() => { this._tickInFlight = null; });
    return this._tickInFlight;
  }

  /**
   * 분이 바뀌면 유니버스 전체의 1분봉을 한 번 훑는다(MARKET_DATA_CHART 그룹 직렬화).
   * 보유 청산 사이클을 막지 않도록 tick과 별도로 실행하고, 끝나면 바로 진입을 판단한다.
   */
  _startCandleScan(universe, minute) {
    if (this._candleScanInFlight || universe.length === 0) return this._candleScanInFlight;
    const startedAt = this.now();
    this._candleScanInFlight = (async () => {
      const candles = new Map();
      let failed = 0;
      for (const symbol of universe) {
        if (this._stopping || Math.floor(this.now() / MINUTE_MS) !== minute) break;
        try {
          candles.set(symbol, await this.client.getMinuteCandles(symbol, 120));
        } catch {
          failed++;
        }
      }
      const completedInMinute = Math.floor(this.now() / MINUTE_MS) === minute;
      this.lastCandleScan = {
        minute: new Date(minute * MINUTE_MS).toISOString(),
        scanned: candles.size,
        failed,
        universe: universe.length,
        durationMs: this.now() - startedAt,
        completed: completedInMinute
      };
      // 다음 분으로 넘어간 스캔 결과는 이미 낡았으므로 버린다.
      if (completedInMinute) this.candleSnapshot = { minute, candles, symbols: universe };
    })()
      .catch(error => this.log.error?.(`❌ [주식] 1분봉 스캔 오류: ${error.message}`))
      .finally(() => {
        this._candleScanInFlight = null;
        if (!this._stopping && this.candleSnapshot?.minute === minute) this.tick();
      });
    return this._candleScanInFlight;
  }

  /** 상시 실행: 각 트레이더의 저장된 의사(desiredRunning)를 따라 시작한다. */
  async start() {
    if (!this.credentialsConfigured) {
      this.log.warn?.('⚠️  [주식] TOSS_CLIENT_ID/TOSS_CLIENT_SECRET이 없어 주식 자동매매를 시작하지 않습니다.');
      return this.getStatus();
    }
    for (const trader of Object.values(this.traders)) {
      if (trader.state.desiredRunning !== false) {
        try {
          await trader.start({ source: 'boot' });
        } catch (error) {
          trader.lastError = error.message;
        }
      }
    }
    this._stopping = false;
    if (!this._timer) {
      this._timer = setInterval(() => { this.tick(); }, Math.max(2000, this.config.cycleIntervalMs));
      this._timer.unref?.();
    }
    this.tick();
    for (const horizon of Object.values(this.horizons)) {
      horizon.start().catch(error => { horizon.manager.lastError = error.message; });
    }
    return this.getStatus();
  }

  async stop() {
    this._stopping = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    for (const trader of Object.values(this.traders)) trader.stop({ source: 'shutdown', persistIntent: false });
    for (const horizon of Object.values(this.horizons)) await horizon.stop();
    if (this._tickInFlight) await this._tickInFlight;
    if (this._candleScanInFlight) await this._candleScanInFlight;
  }

  getTrader(mode) {
    const trader = this.traders[mode];
    if (!trader) throw Object.assign(new Error(`주식 ${mode} 트레이더가 활성화되지 않았습니다.`), { status: 404 });
    return trader;
  }

  async startTrader(mode) {
    if (!this.credentialsConfigured) {
      throw Object.assign(new Error('토스증권 API 키(TOSS_CLIENT_ID/TOSS_CLIENT_SECRET)가 필요합니다.'), { status: 409 });
    }
    const status = await this.getTrader(mode).start({ source: 'operator' });
    if (!this._timer) await this.start();
    return status;
  }

  stopTrader(mode) {
    return this.getTrader(mode).stop({ source: 'operator' });
  }

  getStatus() {
    return {
      enabled: true,
      provider: 'tossinvest',
      credentialsConfigured: this.credentialsConfigured,
      universe: this.universe,
      universeUpdatedAt: this.universeUpdatedAt ? new Date(this.universeUpdatedAt).toISOString() : null,
      universeError: this.lastUniverseError,
      candleScan: this.lastCandleScan,
      watchedStocks: this.allSymbols.length,
      listingError: this.lastListingError,
      movers: this.lastMovers.slice(0, 10),
      paper: this.traders.paper?.getStatus() ?? null,
      live: this.traders.live?.getStatus() ?? null,
      horizons: Object.fromEntries(Object.entries(this.horizons).map(([mode, runtime]) => [mode, runtime.getStatus()]))
    };
  }
}

export default StockTradingService;
