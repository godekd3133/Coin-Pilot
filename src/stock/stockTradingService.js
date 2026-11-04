// 주식 자동매매 서비스: 하나의 토스 클라이언트(시세 rate limit 공유)로
// 모의(paper)/실전(live) 트레이더를 상시 실행한다(기본은 프로세스의 코인 프로필과 같은 모드).
// - 장이 열리면 자동으로 매매하고, 장외 시간에는 대기한다(프로세스는 계속 실행).
// - 운영자가 중지한 트레이더는 desiredRunning=false로 기록되어 재부팅 후에도 중지 상태를 유지한다.
// - 대상 종목: STOCK_SYMBOLS가 비어 있으면 실시간 거래대금 상위 종목 중
//   현재 시드로 1주 이상 살 수 있는 가격대를 자동 선별한다.

import path from 'node:path';
import TossInvestClient, { toNumber } from './tossInvestClient.js';
import StockMarketSession from './stockMarketSession.js';
import StockTrader from './stockTrader.js';
import { createStockHorizonRuntime } from '../portfolio/horizonService.js';

const UNIVERSE_REFRESH_MS = 30 * 60 * 1000;

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
    maxSymbols: env.STOCK_MAX_SYMBOLS ?? 20,
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
      const rankings = await this.client.getRankings({ type: 'MARKET_TRADING_AMOUNT', duration: 'realtime', count: 100 });
      this.universe = rankings
        .filter(item => item?.currency === 'KRW' || item?.currency === undefined)
        .filter(item => {
          const price = toNumber(item?.price?.lastPrice, null);
          return price !== null && price >= this.config.minPrice && price <= ceiling;
        })
        .map(item => item.symbol)
        .filter(Boolean)
        .slice(0, this.config.maxSymbols);
      this.universeUpdatedAt = this.now();
      this.lastUniverseError = this.universe.length === 0 ? `시드로 살 수 있는 종목이 없습니다 (1주 상한 ${Math.floor(ceiling).toLocaleString()}원)` : null;
    } catch (error) {
      this.lastUniverseError = `종목 선별 실패: ${error.message}`;
    }
    return this.universe;
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
      const universe = await this.refreshUniverse();
      const symbols = [...new Set(running.flatMap(trader => trader.requiredSymbols(universe)))];
      // 같은 사이클의 모의/실전이 동일 시세·캔들을 보도록 한 번만 조회해 공유한다.
      const prices = symbols.length > 0 ? await this.client.getPrices(symbols) : new Map();
      const candlesBySymbol = new Map();
      if (market.canEnter) {
        for (const symbol of universe) {
          try {
            candlesBySymbol.set(symbol, await this.client.getMinuteCandles(symbol, 120));
          } catch {
            candlesBySymbol.set(symbol, []);
          }
        }
      }
      for (const trader of running) await trader.runCycle(universe, { prices, candlesBySymbol });
    })()
      .catch(error => this.log.error?.(`❌ [주식] 사이클 오류: ${error.message}`))
      .finally(() => { this._tickInFlight = null; });
    return this._tickInFlight;
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
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    for (const trader of Object.values(this.traders)) trader.stop({ source: 'shutdown', persistIntent: false });
    for (const horizon of Object.values(this.horizons)) await horizon.stop();
    if (this._tickInFlight) await this._tickInFlight;
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
      paper: this.traders.paper?.getStatus() ?? null,
      live: this.traders.live?.getStatus() ?? null,
      horizons: Object.fromEntries(Object.entries(this.horizons).map(([mode, runtime]) => [mode, runtime.getStatus()]))
    };
  }
}

export default StockTradingService;
