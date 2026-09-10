import dotenv from 'dotenv';
import os from 'os';
import path from 'path';
import MultiCoinTrader from '../trader/multiCoinTrader.js';
import DashboardServer from '../api/dashboardServer.js';
import { createLossCircuitBreakerState } from '../risk/lossCircuitBreaker.js';

dotenv.config();

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
    paperValidationFile: `${mockStoragePrefix}.paper_validation.json`
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

export async function main() {
  console.log('\n🌐 대시보드 서버 시작...\n');

  const port = parseInt(process.env.DASHBOARD_PORT) || 3000;

  // 대시보드 전용 모드 (실제 트레이딩은 하지 않음)
  const mockTrader = createMockTrader();

  const server = new DashboardServer(mockTrader, port);
  server.start();

  console.log('\n📊 대시보드에 접속하세요:');
  console.log(`   http://localhost:${port}`);
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
