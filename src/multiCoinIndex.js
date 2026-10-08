import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import MultiCoinTrader from './trader/multiCoinTrader.js';
import DashboardServer from './api/dashboardServer.js';
import { createPublicMarketDataSource as createDefaultPublicMarketDataSource } from './api/publicMarketDataSource.js';
import { createPublicMarketSnapshotStore } from './api/publicMarketSnapshotStore.js';
import Logger from './utils/logger.js';
import { loadEnv, formatEnvErrors, formatEnvWarnings } from './config/envLoader.js';
import { runAfterDashboardReady as runAfterDashboardReadyDefault } from './runtime/dashboardStartup.js';
import { acquireHeadlessRuntimeWriterLock, setupExitHandlers } from './runtime/exitHandlers.js';
import { createAutoRecoverySupervisor } from './runtime/autoRecoverySupervisor.js';
import { createProfileWriterStartup } from './runtime/profileWriterStartup.js';
import { derivePublicMarketSnapshotFilePath } from './runtime/profileStoragePlan.js';

let activeExitHandlers = null;

function createConfig(env) {
  return {
    accessKey: env.UPBIT_ACCESS_KEY || '',
    secretKey: env.UPBIT_SECRET_KEY || '',

    // 다중 코인 설정
    targetCoins: env.TARGET_COINS
      ? env.TARGET_COINS.split(',')
      : ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'],

    maxPositions: env.MAX_POSITIONS || 1000,
    portfolioAllocation: env.PORTFOLIO_ALLOCATION || 0.3,

    // 동적 투자금액 설정
    investmentAmount: env.INVESTMENT_AMOUNT || 50000,
    useProportionalInvestment: env.USE_PROPORTIONAL_INVESTMENT !== false, // 기본 true
    investmentRatio: env.INVESTMENT_RATIO || 0.05, // 총 자산의 5%
    minInvestmentAmount: env.MIN_INVESTMENT_AMOUNT || 5000,
    maxInvestmentAmount: env.MAX_INVESTMENT_AMOUNT || 500000,

    // 시드머니 설정 (드라이모드/실전모드 공통 - 누적손익 계산 기준)
    dryRunSeedMoney: env.DRY_RUN_SEED_MONEY || 10000000,
    initialSeedMoney: env.INITIAL_SEED_MONEY || 0, // 실전모드 초기투자금 (0이면 자동계산)

    stopLossPercent: env.STOP_LOSS_PERCENT || 5,
    takeProfitPercent: env.TAKE_PROFIT_PERCENT || 10,

    rsiPeriod: env.RSI_PERIOD || 14,
    rsiOversold: env.RSI_OVERSOLD || 30,
    rsiOverbought: env.RSI_OVERBOUGHT || 70,

    newsCheckInterval: env.NEWS_CHECK_INTERVAL || 300000,
    buyThreshold: env.BUY_THRESHOLD || 55,  // 기본값 55로 적극적 매수
    sellThreshold: env.SELL_THRESHOLD || 55,
    buyOnly: env.BUY_ONLY === true,  // 매수 전용 모드
    allowAveraging: env.ALLOW_AVERAGING !== false,  // 추가 매수 허용
    checkInterval: env.CHECK_INTERVAL || 60000,

    dryRun: env.DRY_RUN !== false,
    logLevel: env.LOG_LEVEL || 'info',
    enableDashboard: env.ENABLE_DASHBOARD !== false,
    dashboardPort: env.DASHBOARD_PORT || 3000,

    autoRecoveryEnabled: env.AUTO_RECOVERY_ENABLED !== false,
    autoRecoveryProbeIntervalMs: env.AUTO_RECOVERY_PROBE_INTERVAL_MS,
    autoRecoveryMinDownMs: env.AUTO_RECOVERY_MIN_DOWN_MS,
    autoRecoveryHealthyProbes: env.AUTO_RECOVERY_HEALTHY_PROBES,
    autoRecoveryStateFile: env.AUTO_RECOVERY_STATE_FILE
  };
}

async function main() {
  dotenv.config();

  // 스키마 검증: 필수 env 누락/형식 오류는 부팅 시점에 실패시킨다.
  const { values: env, errors: envErrors, warnings: envWarnings } = loadEnv();
  if (envErrors.length > 0) {
    console.error(formatEnvErrors(envErrors));
    process.exit(1);
  }
  if (envWarnings.length > 0) {
    console.warn(formatEnvWarnings(envWarnings));
  }

  // 이 엔트리의 createConfig는 레거시 전략 형태이며 SCALP_* 계약을 매핑하지 않는다.
  // strategyMode 미설정 시 trader가 스캘핑으로 fallback하면서 레거시 risk 값이
  // 적용되므로, 스캘핑 해석이면 fail-closed로 종료하고 index.js로 유도한다.
  const strategyMode = env.TRADING_STRATEGY || 'oversold_reaction_scalping';
  if (strategyMode === 'oversold_reaction_scalping') {
    console.error('⛔ multiCoinIndex.js는 레거시 엔트리입니다. 스캘핑 모드는 `npm start`(src/index.js)로 실행하세요.');
    process.exit(1);
  }

  console.log('\n' + '='.repeat(80));
  console.log('🤖 다중 코인 자동매매 시스템');
  console.log('='.repeat(80));

  const config = createConfig(env);
  config.strategyMode = strategyMode;
  const logger = new Logger(config.logLevel);

  console.log('\n⚙️  설정:');
  console.log(`  모드: ${config.dryRun ? '🧪 모의투자' : '💰 실전투자'}`);
  console.log(`  분석 대상: ${config.targetCoins.length}개 코인`);
  console.log(`  최대 동시 포지션: ${config.maxPositions}`);
  console.log(`  포트폴리오 할당: ${(config.portfolioAllocation * 100).toFixed(0)}%`);

  await runLegacyMultiCoinRuntime(config, { logger });
}

/**
 * Start the legacy entry with profile ownership established before trader
 * construction. Dependencies are injectable so startup and shutdown ownership
 * can be verified with temporary files and fake traders.
 */
export async function runLegacyMultiCoinRuntime(config, dependencies = {}) {
  const profileWriterStartup = createProfileWriterStartup(
    config,
    dependencies.profileWriterStartupOptions
  );
  const createTrader = dependencies.createTrader || (publicMarketDataSource => (
    new MultiCoinTrader(config, { publicMarketDataSource })
  ));
  const createDashboard = dependencies.createDashboard ||
    ((trader, port, options) => new DashboardServer(trader, port, options));
  const createPublicMarketDataSource = dependencies.createPublicMarketDataSource ||
    createDefaultPublicMarketDataSource;
  const runAfterDashboardReady = dependencies.runAfterDashboardReady || runAfterDashboardReadyDefault;
  const createExitHandlers = dependencies.createExitHandlers || setupExitHandlers;
  const processApi = dependencies.processApi || dependencies.exitHandlerOptions?.processApi || process;
  const consoleApi = dependencies.consoleApi || dependencies.exitHandlerOptions?.consoleApi || console;
  const logger = dependencies.logger || null;
  let trader = null;
  let publicMarketDataSource = null;
  let manualOrderIdempotencyStore = null;
  let dashboardServer = null;
  let exitHandlers = null;
  let runtimeLifecycleInstalled = false;

  try {
    const runtime = profileWriterStartup.createTraderAndStore(() => {
      publicMarketDataSource = createPublicMarketDataSource({
        requestTimeoutMs: config.upbitRequestTimeoutMs,
        snapshotStore: createPublicMarketSnapshotStore({
          filePath: derivePublicMarketSnapshotFilePath(config.virtualPortfolioFile)
        })
      });
      return createTrader(publicMarketDataSource);
    });
    trader = runtime.trader;
    manualOrderIdempotencyStore = runtime.manualOrderIdempotencyStore;

    if (config.enableDashboard) {
      dashboardServer = createDashboard(trader, config.dashboardPort, {
        publicMarketDataSource,
        releaseManualOrderWriterLockOnStop: false,
        manualOrderIdempotencyStore
      });
    }

    await runAfterDashboardReady(dashboardServer, async () => {
      await acquireHeadlessRuntimeWriterLock({
        config,
        trader,
        createStore: () => manualOrderIdempotencyStore
      });
      const runtimeWriterLockOwner = {
        releaseWriterLock: async () => {
          let closeError = null;
          try {
            await publicMarketDataSource?.close?.();
          } catch (error) {
            closeError = error;
          }
          const released = profileWriterStartup.releaseWriterLock();
          if (closeError) {
            closeError.profileWriterLockReleased = released;
            throw closeError;
          }
          return released;
        }
      };

      exitHandlers = createExitHandlers(trader, dashboardServer, null, null, logger, {
        ...(dependencies.exitHandlerOptions || {}),
        processApi,
        consoleApi,
        runtimeWriterLockStore: runtimeWriterLockOwner
      });
      activeExitHandlers = exitHandlers;
      runtimeLifecycleInstalled = true;

      const autoRecovery = createAutoRecoverySupervisor(trader, config);
      trader.autoRecovery = autoRecovery;
      autoRecovery.start();
      if (!autoRecovery.resolveBootIntent(true)) return;

      consoleApi.log('\n⏱️  3초 후 시작합니다...');
      const waitBeforeTraderStart = dependencies.waitBeforeTraderStart ||
        (() => new Promise(resolve => setTimeout(resolve, 3000)));
      try {
        await waitBeforeTraderStart();
        await trader.start();
      } catch (error) {
        consoleApi.error('\n❌ 치명적 오류:', error);
        logger?.error?.('Fatal Error', { error: error.message, stack: error.stack });
        processApi.exitCode = Math.max(Number(processApi.exitCode) || 0, 1);
        await exitHandlers.gracefulShutdown(1, { reason: 'startup_failure' });
      }
    });

    return { trader, dashboardServer, manualOrderIdempotencyStore, exitHandlers };
  } catch (error) {
    if (!runtimeLifecycleInstalled) {
      try {
        if (dashboardServer) await dashboardServer.stop();
      } catch (cleanupError) {
        if (error && typeof error === 'object') error.dashboardStartupCleanupError = cleanupError;
      }
      try {
        try {
          await publicMarketDataSource?.close?.();
        } catch (closeError) {
          if (error && typeof error === 'object') error.publicMarketSnapshotCloseError = closeError;
        }
        profileWriterStartup.releaseWriterLock();
      } catch (releaseError) {
        if (error && typeof error === 'object') error.writerLockReleaseError = releaseError;
      }
    }
    throw error;
  }
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPath === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    console.error('❌ 시작 실패:', error);
    process.exitCode = Math.max(Number(process.exitCode) || 0, 1);
    if (activeExitHandlers?.gracefulShutdown) {
      try {
        await activeExitHandlers.gracefulShutdown(1, { reason: 'startup_failure' });
      } catch (shutdownError) {
        console.error('시작 실패 정리 중 오류:', shutdownError);
      }
    }
  });
}
