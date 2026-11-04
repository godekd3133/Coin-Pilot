// 기간별 포트폴리오 서비스 조립.
// - 연구 결과(HORIZON_PARAMS_FILE / HORIZON_STOCK_PARAMS_FILE)를 읽어 슬리브 파라미터·비중을 정한다.
// - 연구 결과가 없거나 7일이 지나면 별도 프로세스로 재연구를 돌려(서버 이벤트 루프 차단 없음)
//   끝나면 엔진에 반영한다. 실전은 검증된 연구 결과가 있을 때만 신규 진입한다.
// - 코인: 업비트(모의=공개 시세, 실전=trader.upbit). 주식: 토스증권(StockTradingService가 조립).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import HorizonPortfolioManager from './horizonPortfolioManager.js';
import { PaperBroker, UpbitLiveBroker, TossLiveBroker } from './horizonBrokers.js';
import { UpbitPublicCandleLoader, TossCandleLoader } from './marketDataLoader.js';
import { toNumber } from '../stock/tossInvestClient.js';
import { resolveHorizonProfiles, HORIZON_KEYS } from './horizonProfiles.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const STUDY_SCRIPT = path.resolve(MODULE_DIR, '..', 'scripts', 'runHorizonStudy.js');
const RESTUDY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const UNIVERSE_REFRESH_MS = 6 * 60 * 60 * 1000;

export function createHorizonConfig(env = {}) {
  const stateDir = env.COINPILOT_STATE_DIR || path.join(process.cwd(), '.coinpilot-runtime');
  return {
    enabled: env.HORIZON_TRADING_ENABLED === true,
    enabledSleeves: Array.isArray(env.HORIZON_SLEEVES) && env.HORIZON_SLEEVES.length > 0
      ? env.HORIZON_SLEEVES.filter(key => HORIZON_KEYS.includes(key))
      : [...HORIZON_KEYS],
    capitalRatio: env.HORIZON_CAPITAL_RATIO ?? 0.6,
    paperSeedMoney: env.HORIZON_PAPER_SEED_MONEY ?? 1_000_000,
    universeSize: env.HORIZON_UNIVERSE_SIZE ?? 20,
    cycleIntervalMs: env.HORIZON_CYCLE_INTERVAL_MS ?? 60000,
    stateDir,
    coinParamsFile: env.HORIZON_PARAMS_FILE || path.join(stateDir, 'horizon_params.json'),
    stockParamsFile: env.HORIZON_STOCK_PARAMS_FILE || path.join(stateDir, 'horizon_params_stock.json')
  };
}

/** @returns {{overrides: object, generatedAt: string, results: Array}|null} */
export function loadStudyReport(file) {
  try {
    if (!file || !fs.existsSync(file)) return null;
    const report = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (report?.version !== 1 || typeof report.overrides !== 'object') return null;
    return report;
  } catch {
    return null;
  }
}

export function summarizeStudy(report) {
  if (!report) return null;
  return {
    generatedAt: report.generatedAt,
    method: report.method,
    markets: report.markets?.length ?? 0,
    sleeves: (report.results || []).map(result => ({
      horizon: result.horizon,
      interval: result.interval,
      passed: result.passed === true,
      outOfSampleReturnPercent: result.outOfSample?.compoundedReturnPercent ?? null,
      worstDrawdownPercent: result.outOfSample?.worstFoldDrawdownPercent ?? null,
      trades: result.outOfSample?.trades ?? null,
      params: result.chosenParams || null
    }))
  };
}

/** 연구 결과 반영 + 주기적 재연구(자식 프로세스). */
export class HorizonResearchScheduler {
  constructor({ assetClass, paramsFile, env = process.env, onReport, log = console, now = Date.now, spawnImpl = spawn }) {
    this.assetClass = assetClass;
    this.paramsFile = paramsFile;
    this.env = env;
    this.onReport = onReport;
    this.log = log;
    this.now = now;
    this.spawnImpl = spawnImpl;
    this.running = null;
    this.timer = null;
    this.lastRunAt = null;
    this.lastError = null;
  }

  applyCurrent() {
    const report = loadStudyReport(this.paramsFile);
    this.onReport(report);
    return report;
  }

  isStale() {
    try {
      return !fs.existsSync(this.paramsFile) || this.now() - fs.statSync(this.paramsFile).mtimeMs > RESTUDY_INTERVAL_MS;
    } catch {
      return true;
    }
  }

  start() {
    this.applyCurrent();
    if (this.isStale()) this.runStudy('startup');
    this.timer = setInterval(() => { if (this.isStale()) this.runStudy('weekly'); }, 6 * 60 * 60 * 1000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running?.kill?.('SIGTERM');
  }

  runStudy(reason = 'manual') {
    if (this.running) return false;
    this.lastRunAt = new Date(this.now()).toISOString();
    this.log.log?.(`🔬 [기간별 ${this.assetClass}] 워크포워드 재연구 시작 (${reason})`);
    const child = this.spawnImpl(process.execPath, [STUDY_SCRIPT], {
      env: {
        ...this.env,
        HORIZON_STUDY_ASSET: this.assetClass,
        [this.assetClass === 'stock' ? 'HORIZON_STOCK_PARAMS_FILE' : 'HORIZON_PARAMS_FILE']: this.paramsFile
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    this.running = child;
    let stderr = '';
    child.stderr?.on?.('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
    child.on('exit', code => {
      this.running = null;
      if (code === 0) {
        this.lastError = null;
        this.applyCurrent();
        this.log.log?.(`✅ [기간별 ${this.assetClass}] 재연구 완료 — 파라미터를 반영했습니다.`);
      } else {
        this.lastError = `재연구 실패 (exit ${code}): ${stderr.split('\n').filter(Boolean).slice(-1)[0] || ''}`;
        this.log.error?.(`❌ [기간별 ${this.assetClass}] ${this.lastError}`);
      }
    });
    child.on('error', error => {
      this.running = null;
      this.lastError = `재연구 실행 실패: ${error.message}`;
    });
    return true;
  }

  getStatus() {
    return { running: Boolean(this.running), lastRunAt: this.lastRunAt, lastError: this.lastError, paramsFile: path.basename(this.paramsFile) };
  }
}

/**
 * 매니저 + 재연구 스케줄러 + 주기 실행을 묶는다.
 * 실전은 검증 통과한 연구 결과가 있을 때만 신규 진입(비중 > 0)한다.
 */
export class HorizonRuntime {
  constructor({ manager, scheduler, assetClass, cycleIntervalMs, log = console }) {
    this.manager = manager;
    this.scheduler = scheduler;
    this.assetClass = assetClass;
    this.cycleIntervalMs = Math.max(10000, cycleIntervalMs);
    this.log = log;
    this.timer = null;
    this.report = null;
  }

  applyReport(report) {
    this.report = report;
    const profiles = resolveHorizonProfiles(this.assetClass, report?.overrides || {});
    // 실전은 검증 결과가 있어야 진입. 모의는 연구 전에는 기본값으로 증거를 쌓는다.
    const validated = Boolean(report) || this.manager.mode === 'paper';
    this.manager.updateProfiles(profiles, { validated, source: report ? report.generatedAt : 'defaults' });
  }

  async start() {
    this.scheduler?.start();
    if (this.manager.state.desiredRunning !== false) {
      try {
        await this.manager.start({ source: 'boot' });
      } catch (error) {
        this.manager.lastError = error.message;
      }
    }
    if (!this.timer) {
      this.timer = setInterval(() => { this.manager.runCycle(); }, this.cycleIntervalMs);
      this.timer.unref?.();
    }
    this.manager.runCycle();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.scheduler?.stop();
    this.manager.stop({ source: 'shutdown', persistIntent: false });
    if (this.manager._cycleInFlight) await this.manager._cycleInFlight;
  }

  getStatus() {
    return {
      ...this.manager.getStatus(),
      research: { ...summarizeStudy(this.report), scheduler: this.scheduler?.getStatus() ?? null }
    };
  }
}

/** 코인 기간별 포트폴리오. trader: MultiCoinTrader (실전 주문·스캘퍼 예약 연동). */
export function createCoinHorizonRuntime({ config, trader, env = process.env, log = console, loader = null }) {
  // 시세·봉 조회도 스캘퍼와 같은 UpbitAPI 인스턴스를 거쳐 IP 요청 예산을 공유한다.
  loader ||= new UpbitPublicCandleLoader({ upbit: trader.upbit });
  const mode = trader.dryRun ? 'paper' : 'live';
  const broker = mode === 'paper'
    ? new PaperBroker({ assetClass: 'coin', priceSource: symbols => loader.getPrices(symbols) })
    : new UpbitLiveBroker({ trader, quoteAsset: trader.quoteAsset || 'KRW' });
  let universe = [];
  let universeAt = 0;
  const manager = new HorizonPortfolioManager({
    assetClass: 'coin',
    mode,
    loader,
    broker,
    profiles: resolveHorizonProfiles('coin'),
    universeProvider: async () => {
      if (universe.length === 0 || Date.now() - universeAt > UNIVERSE_REFRESH_MS) {
        try {
          universe = await loader.getKrwMarketsByTurnover(config.universeSize);
          universeAt = Date.now();
        } catch (error) {
          if (universe.length === 0) throw error;
        }
      }
      return universe;
    },
    marketGate: async () => ({
      canTrade: mode === 'paper' || trader.liveCredentialsConfigured === true,
      canEnter: true,
      reason: mode === 'live' && !trader.liveCredentialsConfigured ? 'live_credentials_missing' : 'open'
    }),
    onReservationsChanged: mode === 'live'
      ? reservations => trader.setExternalHoldingReservations?.('horizon', reservations)
      : null,
    config: {
      capitalRatio: config.capitalRatio,
      paperSeedMoney: config.paperSeedMoney,
      enabledSleeves: config.enabledSleeves
    },
    stateFile: path.join(config.stateDir, `horizon_coin_${mode}.json`),
    log
  });
  const runtime = new HorizonRuntime({ manager, scheduler: null, assetClass: 'coin', cycleIntervalMs: config.cycleIntervalMs, log });
  runtime.scheduler = new HorizonResearchScheduler({
    assetClass: 'coin',
    paramsFile: config.coinParamsFile,
    env,
    log,
    onReport: report => runtime.applyReport(report)
  });
  // 재시작 직후 스캘퍼 동기화 전에 예약을 등록해 기간별 보유분을 스캘퍼가 가져가지 않게 한다.
  manager._publishReservations();
  return runtime;
}

/**
 * 주식 기간별 포트폴리오. client/marketSession은 StockTradingService와 공유한다.
 * @param {object} deps.scalper 같은 계좌의 주식 스캘퍼(StockTrader) — 보유분 구분용
 */
export function createStockHorizonRuntime({ config, mode, client, marketSession, scalper = null, minPrice = 1000, env = process.env, log = console }) {
  const loader = new TossCandleLoader({ client });
  const priceSource = async symbols => new Map([...(await client.getPrices(symbols))].map(([symbol, quote]) => [symbol, quote.price]));
  const broker = mode === 'paper'
    ? new PaperBroker({ assetClass: 'stock', priceSource })
    : new TossLiveBroker({
      client,
      otherEngineQuantities: () => Object.fromEntries(Object.entries(scalper?.state?.positions || {}).map(([symbol, position]) => [symbol, position.quantity]))
    });
  let universe = [];
  let universeAt = 0;
  const manager = new HorizonPortfolioManager({
    assetClass: 'stock',
    mode,
    loader,
    broker,
    profiles: resolveHorizonProfiles('stock'),
    universeProvider: async () => {
      if (universe.length === 0 || Date.now() - universeAt > UNIVERSE_REFRESH_MS) {
        const rankings = await client.getRankings({ type: 'MARKET_TRADING_AMOUNT', duration: '1d', count: 100 });
        universe = rankings
          .filter(item => item?.symbol && (item.currency || 'KRW') === 'KRW' && (toNumber(item?.price?.lastPrice, 0) || 0) >= minPrice)
          .map(item => item.symbol)
          .slice(0, config.universeSize);
        universeAt = Date.now();
      }
      return universe;
    },
    marketGate: async () => {
      const state = await marketSession.getState();
      return { canTrade: state.open, canEnter: state.canEnter, reason: state.reason };
    },
    config: {
      capitalRatio: config.capitalRatio,
      paperSeedMoney: config.paperSeedMoney,
      enabledSleeves: config.enabledSleeves
    },
    stateFile: path.join(config.stateDir, `horizon_stock_${mode}.json`),
    log
  });
  const runtime = new HorizonRuntime({ manager, scheduler: null, assetClass: 'stock', cycleIntervalMs: config.cycleIntervalMs, log });
  runtime.scheduler = new HorizonResearchScheduler({
    assetClass: 'stock',
    paramsFile: config.stockParamsFile,
    env,
    log,
    onReport: report => runtime.applyReport(report)
  });
  return runtime;
}
