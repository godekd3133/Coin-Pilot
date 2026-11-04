import dotenv from 'dotenv';
import fs from 'fs';
import os from 'os';
import path from 'path';
import MultiCoinTrader from '../trader/multiCoinTrader.js';
import DashboardServer from '../api/dashboardServer.js';
import { createLossCircuitBreakerState } from '../risk/lossCircuitBreaker.js';
import { summarizePaperStrictTradeCostAudit } from '../research/paperStrictTradeCostAudit.js';
import { envNumber, envRaw } from '../config/envConfig.js';

dotenv.config();

/**
 * Attach an existing forward-paper ledger to the dashboard's deterministic
 * trader shell without allowing the UI to mutate that ledger. The observer
 * reads the latest persisted asset snapshot instead of querying an account or
 * creating a second trading process, so the displayed result remains tied to
 * the exact forward session being evaluated.
 */
export function attachReadOnlyPaperLedger(trader, ledgerFile) {
  const resolvedLedgerFile = path.resolve(ledgerFile);
  const readLedger = () => {
    const data = JSON.parse(fs.readFileSync(resolvedLedgerFile, 'utf8'));
    if (!data || typeof data !== 'object' || !data.sessionId) {
      throw new Error(`유효하지 않은 paper ledger: ${resolvedLedgerFile}`);
    }
    return data;
  };

  const originalGetPaperValidationStatus = trader.getPaperValidationStatus.bind(trader);
  // A read-only observer must not inherit the repository-root validation
  // report from the mock trader. Use an explicit override when supplied;
  // otherwise keep readiness reads beside the selected ledger, where a
  // missing report is correctly shown as pending instead of borrowing a
  // different session's market universe.
  const configuredValidationReport = trader.config?.scalpingValidationOutputFile ||
    envRaw('SCALP_VALIDATION_OUTPUT_FILE') ||
    path.join(path.dirname(resolvedLedgerFile), 'scalping_validation.json');
  trader.config = {
    ...trader.config,
    scalpingValidationOutputFile: configuredValidationReport
  };
  const applyLedgerConfig = ledger => {
    const baselineAssets = Number(ledger?.baselineAssets);
    if (Number.isFinite(baselineAssets) && baselineAssets > 0) {
      // The observer starts from a 1M mock by default, but the attached paper
      // ledger may use a different seed (the sealed r2 ledger uses 10M). Keep
      // account/cumulative-P&L projections on the ledger's authoritative
      // baseline instead of turning a small return into a huge percentage.
      trader.initialSeedMoney = baselineAssets;
      trader.config = { ...trader.config, dryRunSeedMoney: baselineAssets };
      if (trader.virtualPortfolio) trader.virtualPortfolio.krwBalance = baselineAssets;
    }
    const snapshot = ledger?.configSnapshot;
    if (!snapshot || typeof snapshot !== 'object') return;

    // The observer has no strategy loop of its own, but the status endpoint
    // still compares the current runtime snapshot with the recorded session
    // snapshot. Mirror the recorded values so a mock-shell default cannot be
    // reported as configuration drift for the real observed session.
    trader.config = { ...trader.config, ...snapshot };
    // The paper snapshot uses the canonical validation key `emaPeriod`,
    // while the runtime/mock config uses the legacy source key `emaLong`.
    // Mirror the recorded value into the runtime alias before comparing the
    // observer config, otherwise an unchanged forward session is reported as
    // a false `emaPeriod` drift.
    if (Number.isFinite(Number(snapshot.emaPeriod))) {
      trader.config.emaLong = Number(snapshot.emaPeriod);
      trader.strategyConfig = { ...trader.strategyConfig, emaLong: Number(snapshot.emaPeriod) };
    }
    trader.strategyMode = snapshot.strategyMode || trader.strategyMode;
    trader.isScalpingMode = trader.strategyMode === 'oversold_reaction_scalping';
    if (Array.isArray(snapshot.targetCoins)) trader.targetCoins = [...snapshot.targetCoins];
    for (const key of [
      'candleUnit',
      'candleCount',
      'maxCandleAgeSeconds',
      'maxRiskDataGapSeconds',
      'maxAnalysisDataGapSeconds',
      'maxPositions',
      'investmentRatio',
      'positionRiskCheckIntervalMs'
    ]) {
      if (snapshot[key] !== null && snapshot[key] !== undefined) {
        trader[key] = Number(snapshot[key]);
      }
    }
    trader.strategyConfig = { ...trader.strategyConfig, ...snapshot };
    const winnerShadow = ledger?.paperExperiments?.winnerShadow;
    if (winnerShadow && typeof winnerShadow === 'object') {
      trader.winnerShadowExtendMinutes = Math.max(0, Number(winnerShadow.winnerExtendMinutes) || 0);
      trader.winnerShadowExtendMinProfitPercent = Math.max(0, Number(winnerShadow.winnerExtendMinProfitPercent) || 0);
      trader.winnerShadowMaxReboundPercent = Math.max(0, Number(winnerShadow.entryMaxReboundPercent) || 0);
    }
    const diagnosticShadows = ledger?.paperExperiments?.diagnosticShadows;
    if (diagnosticShadows && typeof diagnosticShadows === 'object') {
      trader.paperDiagnosticShadowsEnabled = diagnosticShadows.enabled !== false;
    }
  };

  trader.paperValidationFile = resolvedLedgerFile;
  trader.readOnlyObserver = true;
  trader.readPaperValidationLedger = readLedger;
  trader.savePaperValidation = () => {};
  trader.recordPaperValidationSnapshot = async () => {
    throw new Error('읽기 전용 paper observer는 원본 forward ledger에 snapshot을 추가할 수 없습니다.');
  };
  trader.calculateTotalAssets = async () => {
    const ledger = readLedger();
    const snapshots = Array.isArray(ledger.snapshots) ? ledger.snapshots : [];
    const latest = snapshots.at(-1);
    const totalAssets = Number(latest?.totalAssets ?? ledger.baselineAssets);
    return Number.isFinite(totalAssets) ? totalAssets : 0;
  };
  trader.getPaperValidationStatus = async () => {
    trader.paperValidation = readLedger();
    applyLedgerConfig(trader.paperValidation);
    if (trader.paperValidation.riskMonitor) {
      trader.riskMonitorState = trader.paperValidation.riskMonitor;
    }
    if (trader.paperValidation.analysisDataHealth) {
      trader.analysisDataHealthState = trader.paperValidation.analysisDataHealth;
    }
    const status = await originalGetPaperValidationStatus();
    return {
      ...status,
      readOnlyObserver: true,
      strictExecutionCostAudit: summarizePaperStrictTradeCostAudit(trader.paperValidation)
    };
  };
  trader.startPaperValidationSession = async () => {
    throw new Error('실제 forward ledger 관찰 대시보드는 읽기 전용입니다. 원본 runner에서 세션을 관리하세요.');
  };
  trader.stopPaperValidationSession = async () => {
    throw new Error('실제 forward ledger 관찰 대시보드는 읽기 전용입니다. 원본 runner에서 세션을 관리하세요.');
  };

  // Fail closed if the selected ledger cannot be read before the server is
  // exposed. This also prevents a typo from silently falling back to mock data.
  trader.paperValidation = readLedger();
  applyLedgerConfig(trader.paperValidation);
  return trader;
}

export function createMockTrader() {
  const markets = ['KRW-BTC', 'KRW-ETH'];
  // The constructor loads persistence files before this mock can replace its
  // in-memory portfolio. Point both files at unique temp paths up front so a
  // dashboard smoke can never read the user's real dry portfolio or paper
  // ledger, even if those files exist in the repository root.
  const mockStoragePrefix = path.join(os.tmpdir(), `coin-pilot-dashboard-${process.pid}`);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: markets,
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    checkInterval: 5_000,
    candleUnit: 1,
    candleCount: 120,
    maxPositions: 3,
    portfolioAllocation: 0.1,
    investmentRatio: 0.02,
    marketRegimeEnabled: false,
    marketRegimeLookback: 5,
    marketRegimeMinBreadth: 0.5,
    marketRegimeMinReturnPercent: -0.2,
    lossCircuitBreakerCount: 0,
    lossCircuitBreakerWindowMinutes: 30,
    lossCircuitBreakerCooldownMinutes: 60,
    useNews: false,
    enableDashboard: true,
    virtualPortfolioFile: `${mockStoragePrefix}.dry_portfolio.json`,
    paperValidationFile: `${mockStoragePrefix}.paper_validation.json`,
    portfolioHistoryFile: `${mockStoragePrefix}.portfolio_history.json`,
    aiMonitoringFile: `${mockStoragePrefix}.ai_monitoring_sessions.json`
  });

  // Dashboard-only mode must be deterministic and must never touch Upbit.
  const prices = { 'KRW-BTC': 100_000_000, 'KRW-ETH': 5_000_000 };
  const fakeUpbit = {
    async getMarkets() {
      return markets.map(market => ({ market, korean_name: market.replace('KRW-', '') }));
    },
    async getTicker(requestedMarkets) {
      const selected = Array.isArray(requestedMarkets) ? requestedMarkets : [requestedMarkets];
      return selected.filter(Boolean).map(market => ({
        market,
        trade_price: prices[market] || 1_000,
        trade_timestamp: Date.now(),
        acc_trade_price_24h: 10_000_000_000,
        signed_change_rate: 0.001,
        high_price: (prices[market] || 1_000) * 1.02,
        low_price: (prices[market] || 1_000) * 0.98
      }));
    },
    async getMinuteCandles(market, unit = 1, count = 120) {
      const base = prices[market] || 1_000;
      return Array.from({ length: Math.min(count, 120) }, (_, index) => {
        const price = base * (1 + (index % 8) * 0.0001);
        return {
          market,
          candle_date_time_utc: new Date(Date.now() - index * unit * 60_000).toISOString(),
          opening_price: price,
          high_price: price * 1.001,
          low_price: price * 0.999,
          trade_price: price,
          candle_acc_trade_volume: 100 + index
        };
      });
    },
    async getAccounts() {
      return [{ currency: 'KRW', balance: '1000000', locked: '0', avg_buy_price: '0' }];
    },
    async getOrders() { return []; },
    async getOrderChance() { return {}; },
    async order() { return { success: true, data: { uuid: `mock-${Date.now()}` } }; },
    async waitForOrderFill(uuid) {
      return { filled: true, partial: false, order: { uuid, executed_volume: '0', avg_price: '0', paid_fee: '0' } };
    },
    async cancelOrder() { return {}; }
  };

  trader.upbit = fakeUpbit;
  trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };
  trader.initialSeedMoney = 1_000_000;
  trader.strategies = new Map();
  trader.newsData = null;
  trader.saveVirtualPortfolio = () => {};
  // Keep the dashboard smoke deterministic while exposing the same paper
  // status shape as the integrated process. No ledger is written here.
  const dashboardSessionStartedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  trader.paperValidation = {
    schemaVersion: 1,
    sessionId: 'dashboard-mock-paper',
    active: false,
    startedAt: dashboardSessionStartedAt,
    endedAt: new Date().toISOString(),
    processId: process.pid,
    heartbeatAt: new Date().toISOString(),
    strategyMode: 'oversold_reaction_scalping',
    strategyProfile: 'rsi_rebound',
    targetCoins: markets,
    configSnapshot: trader.getPaperValidationConfigSnapshot(),
    configSnapshotComplete: true,
    baselineAssets: 1_000_000,
    baselineIncludesHoldings: false,
    thresholds: { minDays: 7, minTrades: 20, minReturnPercent: 0.2, maxDrawdownPercent: 15 },
    telemetry: {
      cycles: 24,
      buyCandidates: 0,
      shadowCandidates: 2,
      circuitBlockedEntries: 0,
      shadowCircuitBlockedEntries: 0,
      looseShadowCircuitBlockedEntries: 0,
      marketRegimeBlockedEntries: 0,
      sellSignals: 0,
      holdDecisions: 48,
      reasonCounts: { '과매도 조건 없음 - 관망': 46, '반등 확인 대기': 2 },
      rejectionCounts: { price_rebound_below_threshold: 2, volume_confirmation_failed: 1 },
      shadowCandidatesByCoin: { 'KRW-BTC': 1, 'KRW-ETH': 1 },
      lastCycleAt: new Date().toISOString(),
      lastBuyCandidateAt: null,
      heartbeatAt: new Date().toISOString()
    },
    strictRiskState: {
      cooldownUntilByCoin: {},
      consecutiveLossesByCoin: {},
      lossCircuitBreaker: createLossCircuitBreakerState()
    },
    strictOpenPositions: [],
    shadow: {
      positions: {},
      lastSignalByCoin: {},
      closedTrades: [],
      entryCount: 0,
      realizedProfit: 0,
      totalInvested: 0,
      winningTrades: 0,
      losingTrades: 0,
      lossCircuitBreaker: createLossCircuitBreakerState()
    },
    looseShadow: {
      positions: {},
      closedTrades: [],
      entryCount: 0,
      realizedProfit: 0,
      totalInvested: 0,
      winningTrades: 0,
      losingTrades: 0,
      lossCircuitBreaker: createLossCircuitBreakerState()
    },
    snapshots: [{ timestamp: dashboardSessionStartedAt, totalAssets: 1_000_000, reason: 'dashboard_mock' }]
  };
  trader.updateNews = async () => {};
  trader.start = function startDashboardOnly() {
    this.isRunning = true;
    console.log('✅ 트레이딩 시스템 시작 (대시보드 전용 모드)');
  };
  trader.stop = function stopDashboardOnly() {
    this.isRunning = false;
    console.log('⏹️  트레이딩 시스템 중지');
  };

  return trader;
}


// ---------------------------------------------------------------------------
// Deterministic demo data for `npm run dashboard` only. The server-side
// contracts mirror StockTradingService / HorizonRuntime getStatus() so the web
// shell's stock and portfolio screens can be smoke-tested without any broker.
// createMockTrader() above stays minimal because many tests depend on it.

const DEMO_MARKETS = {
  'KRW-BTC': 98_450_000, 'KRW-ETH': 4_812_000, 'KRW-XRP': 3_215, 'KRW-SOL': 241_300, 'KRW-DOGE': 412,
  'KRW-ADA': 1_087, 'KRW-AVAX': 52_400, 'KRW-LINK': 28_950, 'KRW-DOT': 11_230, 'KRW-ETC': 38_120
};

function seededWave(seed, index) {
  return Math.sin(index / 7 + seed) * 0.006 + Math.sin(index / 23 + seed * 2) * 0.012 + Math.cos(index / 3 + seed) * 0.002;
}

export function seedMockDashboardData(trader, now = Date.now()) {
  const markets = Object.keys(DEMO_MARKETS);
  const changeOf = market => (markets.indexOf(market) % 3 === 0 ? 0.018 : markets.indexOf(market) % 3 === 1 ? -0.011 : 0.004) * (1 + markets.indexOf(market) / 10);
  const upbit = trader.upbit;
  trader.targetCoins = markets;
  trader.upbit = {
    ...upbit,
    async getMarkets() {
      return markets.map(market => ({ market, korean_name: market.replace('KRW-', ''), english_name: market.replace('KRW-', '') }));
    },
    async getTicker(requested) {
      const selected = (Array.isArray(requested) ? requested : [requested]).filter(Boolean);
      return selected.map(market => {
        const price = DEMO_MARKETS[market] || 1_000;
        const rate = changeOf(market);
        return {
          market,
          trade_price: price,
          trade_timestamp: Date.now(),
          signed_change_rate: rate,
          signed_change_price: Math.round(price * rate),
          acc_trade_price_24h: 30_000_000_000 / (1 + markets.indexOf(market)),
          acc_trade_volume_24h: 1_000,
          high_price: price * 1.024,
          low_price: price * 0.979
        };
      });
    },
    async getMinuteCandles(market, unit = 1, count = 120) {
      const base = DEMO_MARKETS[market] || 1_000;
      const seed = markets.indexOf(market) + 1;
      return Array.from({ length: Math.min(count, 200) }, (_, index) => {
        const close = base * (1 + seededWave(seed, index));
        const open = base * (1 + seededWave(seed, index + 1));
        return {
          market,
          candle_date_time_utc: new Date(Date.now() - index * unit * 60_000).toISOString().slice(0, 19),
          candle_date_time_kst: new Date(Date.now() - index * unit * 60_000 + 9 * 3_600_000).toISOString().slice(0, 19),
          opening_price: open,
          high_price: Math.max(open, close) * 1.0015,
          low_price: Math.min(open, close) * 0.9985,
          trade_price: close,
          candle_acc_trade_volume: 120 + (index % 9) * 11
        };
      });
    }
  };
  trader.virtualPortfolio = {
    krwBalance: 612_400,
    holdings: new Map([
      ['KRW-BTC', { amount: 0.0021, avgPrice: 96_100_000, entryTime: new Date(now - 26 * 3_600_000).toISOString() }],
      ['KRW-SOL', { amount: 0.72, avgPrice: 246_000, entryTime: new Date(now - 5 * 3_600_000).toISOString() }]
    ])
  };
  trader.smartTradeHistory = [
    { coin: 'KRW-SOL', type: 'BUY', volume: 0.72, price: 246_000, grossAmount: 177_120, timestamp: new Date(now - 5 * 3_600_000).toISOString(), source: 'smart_buy' },
    { coin: 'KRW-XRP', type: 'SELL', volume: 40, price: 3_180, grossAmount: 127_200, profit: 3_420, timestamp: new Date(now - 9 * 3_600_000).toISOString(), source: 'manual' },
    { coin: 'KRW-BTC', type: 'BUY', volume: 0.0021, price: 96_100_000, grossAmount: 201_810, timestamp: new Date(now - 26 * 3_600_000).toISOString(), source: 'manual' }
  ];
  if (trader.portfolioHistoryFile) {
    const history = Array.from({ length: 96 }, (_, index) => ({
      timestamp: new Date(now - (95 - index) * 15 * 60_000).toISOString(),
      totalAssets: Math.round(1_000_000 * (1 + index * 0.00028 + seededWave(3, index) * 0.6))
    }));
    fs.writeFileSync(trader.portfolioHistoryFile, JSON.stringify(history));
  }
  return trader;
}

function mockStockTrader(mode, now) {
  const paper = mode === 'paper';
  const state = {
    running: paper,
    desiredRunning: paper,
    cash: paper ? 7_412_300 : null,
    initialSeedMoney: 10_000_000,
    positions: paper ? [
      { symbol: '005930', quantity: 20, entryPrice: 71_200, lastPrice: 72_100, entryTime: new Date(now - 95 * 60_000).toISOString(), unrealizedProfit: 18_000 },
      { symbol: '000660', quantity: 6, entryPrice: 198_500, lastPrice: 196_000, entryTime: new Date(now - 40 * 60_000).toISOString(), unrealizedProfit: -15_000 }
    ] : [],
    trades: paper ? [
      { action: 'SELL', symbol: '035420', quantity: 4, price: 187_300, profit: 9_240, profitPercent: 1.24, reason: 'TAKE_PROFIT', at: new Date(now - 3 * 3_600_000).toISOString() },
      { action: 'BUY', symbol: '000660', quantity: 6, price: 198_500, reason: '과매도 반등', at: new Date(now - 40 * 60_000).toISOString() },
      { action: 'BUY', symbol: '005930', quantity: 20, price: 71_200, reason: '과매도 반등', at: new Date(now - 95 * 60_000).toISOString() }
    ] : []
  };
  return {
    state,
    getStatus() {
      const positionsValue = state.positions.reduce((sum, position) => sum + position.lastPrice * position.quantity, 0);
      const sells = state.trades.filter(trade => trade.action === 'SELL');
      return {
        mode, running: state.running, desiredRunning: state.desiredRunning, entriesPaused: false, pauseReason: null, pendingOrders: 0,
        market: { open: true, canEnter: true, mustFlatten: false, reason: 'regular_session' },
        lastCycleAt: state.running ? new Date().toISOString() : null, lastError: null,
        cash: state.cash, initialSeedMoney: state.initialSeedMoney,
        totalAssets: state.cash !== null ? Math.round(state.cash + positionsValue) : null,
        positions: state.positions, maxPositions: 5,
        statistics: { totalTrades: sells.length, winningTrades: sells.filter(trade => trade.profit > 0).length, winRate: sells.length ? 100 : 0, totalProfit: sells.reduce((sum, trade) => sum + trade.profit, 0) },
        recentTrades: state.trades,
        recentSignals: paper ? [{ symbol: '051910', reason: 'RSI 과매도 반등', valid: false, rejection: '현금 부족 (1주 412,000원)', at: new Date(now - 12 * 60_000).toISOString() }] : []
      };
    },
    start() { state.running = true; state.desiredRunning = true; return this.getStatus(); },
    stop() { state.running = false; state.desiredRunning = false; return this.getStatus(); },
    resetPaper(seed) {
      if (!paper) throw new Error('실전 계좌는 초기화할 수 없습니다.');
      if (state.positions.length) throw new Error('보유 포지션이 있어 초기화할 수 없습니다.');
      state.cash = Math.max(0, Number(seed) || 10_000_000);
      state.initialSeedMoney = state.cash;
      state.trades = [];
      return this.getStatus();
    }
  };
}

function mockHorizonRuntime(assetClass, mode, now) {
  const sleeves = assetClass === 'coin'
    ? [['short', '단기 (1~3일)', '60m', true, 1.8, -6.2], ['swing', '스윙 (~1주)', '240m', true, 4.1, -9.8], ['mid', '중기 (1~3개월)', '1d', false, -2.3, -18.4], ['long', '장기 (3개월+)', '1w', true, 7.9, -14.1]]
    : [['short', '단기 (1~3일)', '1d', false, -0.8, -4.9], ['swing', '스윙 (~1주)', '1d', true, 2.6, -7.3], ['mid', '중기 (1~3개월)', '1d', true, 5.2, -11.2], ['long', '장기 (3개월+)', '1w', false, 1.1, -21.5]];
  const passed = sleeves.filter(item => item[3]);
  const weightEach = passed.length ? 100 / passed.length : 0;
  const state = { running: mode === 'paper', cash: assetClass === 'coin' ? 2_104_000 : 3_880_000 };
  const positions = assetClass === 'coin'
    ? [{ sleeve: 'swing', symbol: 'KRW-ETH', quantity: 0.12, entryPrice: 4_690_000, lastPrice: 4_812_000, cost: 562_800, stopPrice: 4_420_000, score: 64, barsHeld: 9, entryTime: new Date(now - 36 * 3_600_000).toISOString(), unrealizedProfit: 14_640, stuckBelowMinimum: false },
      { sleeve: 'long', symbol: 'KRW-BTC', quantity: 0.006, entryPrice: 91_200_000, lastPrice: 98_450_000, cost: 547_200, stopPrice: 84_000_000, score: 71, barsHeld: 3, entryTime: new Date(now - 20 * 86_400_000).toISOString(), unrealizedProfit: 43_500, stuckBelowMinimum: false }]
    : [{ sleeve: 'mid', symbol: '005380', quantity: 3, entryPrice: 241_000, lastPrice: 248_500, cost: 723_000, stopPrice: 226_000, score: 58, barsHeld: 12, entryTime: new Date(now - 17 * 86_400_000).toISOString(), unrealizedProfit: 22_500, stuckBelowMinimum: false }];
  const trades = [{ action: 'SELL', sleeve: 'short', symbol: assetClass === 'coin' ? 'KRW-SOL' : '035720', quantity: assetClass === 'coin' ? 1.1 : 12, price: assetClass === 'coin' ? 239_000 : 47_100, profit: 6_310, returnPercent: 2.4, reason: 'TRAILING_STOP', at: new Date(now - 30 * 3_600_000).toISOString() }];
  const manager = {
    async start() { state.running = true; },
    stop() { state.running = false; }
  };
  return {
    manager,
    getStatus() {
      const positionsValue = positions.reduce((sum, position) => sum + position.lastPrice * position.quantity, 0);
      return {
        assetClass, mode, running: state.running, desiredRunning: state.running, entriesPaused: false, pauseReason: null, pendingOrders: 0,
        lastCycleAt: state.running ? new Date(now - 4 * 60_000).toISOString() : null, lastError: null, gate: null,
        capitalRatio: 0.3, paramsValidated: true, paramsSource: new Date(now - 2 * 86_400_000).toISOString(),
        cash: mode === 'paper' ? state.cash : null, initialSeedMoney: 3_000_000,
        totalAssets: mode === 'paper' ? Math.round(state.cash + positionsValue) : null,
        sleeves: Object.fromEntries(sleeves.map(([key, label, interval, ok]) => [key, {
          label, enabled: ok, weight: ok ? Math.round(weightEach * 10) / 10 : 0, interval,
          positions: positions.filter(position => position.sleeve === key).length,
          realizedProfit: trades.filter(trade => trade.sleeve === key).reduce((sum, trade) => sum + trade.profit, 0),
          trades: trades.filter(trade => trade.sleeve === key).length, winRate: trades.some(trade => trade.sleeve === key) ? 100 : 0,
          lastAnalysis: { barStart: new Date(now - 3_600_000).toISOString(), benchmarkRegime: 'uptrend', top: [{ symbol: assetClass === 'coin' ? 'KRW-BTC' : '005930', score: 71, regime: 'uptrend', rsi: 58, atrPercent: 2.1 }] }
        }])),
        positions,
        recentTrades: trades,
        research: {
          generatedAt: new Date(now - 2 * 86_400_000).toISOString(), method: 'expanding_walk_forward_3fold', markets: assetClass === 'coin' ? 20 : 30,
          sleeves: sleeves.map(([key, , interval, ok, oos, dd]) => ({ horizon: key, interval, passed: ok, outOfSampleReturnPercent: oos, worstDrawdownPercent: dd, trades: 14 + key.length, params: null })),
          scheduler: { running: false, lastRunAt: new Date(now - 2 * 86_400_000).toISOString(), lastError: null, paramsFile: `horizon_${assetClass}.json` }
        }
      };
    }
  };
}

export function createMockStockTradingService(now = Date.now()) {
  const traders = { paper: mockStockTrader('paper', now) };
  const horizons = { paper: mockHorizonRuntime('stock', 'paper', now) };
  return {
    traders,
    horizons,
    credentialsConfigured: true,
    getTrader(mode) {
      const trader = traders[mode];
      if (!trader) throw Object.assign(new Error(`주식 ${mode} 트레이더가 활성화되지 않았습니다.`), { status: 404 });
      return trader;
    },
    async startTrader(mode) { return this.getTrader(mode).start(); },
    stopTrader(mode) { return this.getTrader(mode).stop(); },
    getStatus() {
      return {
        enabled: true, provider: 'tossinvest', credentialsConfigured: true,
        universe: ['005930', '000660', '035420', '005380', '051910', '035720'], universeUpdatedAt: new Date(now - 20 * 60_000).toISOString(), universeError: null,
        paper: traders.paper.getStatus(), live: null,
        horizons: Object.fromEntries(Object.entries(horizons).map(([mode, runtime]) => [mode, runtime.getStatus()]))
      };
    }
  };
}

export function createMockCoinHorizon(now = Date.now()) {
  return mockHorizonRuntime('coin', 'paper', now);
}

export async function main() {
  console.log('\n🌐 대시보드 서버 시작...\n');

  const port = envNumber('DASHBOARD_PORT', NaN) || 3000;

  // 대시보드 전용 모드 (실제 트레이딩은 하지 않음)
  const mockTrader = seedMockDashboardData(createMockTrader());

  const server = new DashboardServer(mockTrader, port, {
    stockTradingService: createMockStockTradingService(),
    coinHorizon: createMockCoinHorizon()
  });
  await server.start();

  console.log('\n📊 대시보드에 접속하세요:');
  console.log(`   ${server.protocol}://localhost:${port}`);
  console.log('\nCtrl+C를 눌러 종료할 수 있습니다.\n');

  // 종료 핸들러
  process.on('SIGINT', () => {
    console.log('\n\n⏹️  대시보드 서버 종료 중...');
    server.stop();
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('대시보드 시작 실패:', error);
    process.exit(1);
  });
}
