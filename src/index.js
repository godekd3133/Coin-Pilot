import dotenv from 'dotenv';
import MultiCoinTrader from './trader/multiCoinTrader.js';
import DashboardServer from './api/dashboardServer.js';
import { createPublicMarketDataSource } from './api/publicMarketDataSource.js';
import { createPublicMarketSnapshotStore } from './api/publicMarketSnapshotStore.js';
import { createExchangeClient } from './exchange/exchangeFactory.js';
import { LiveCredentialStore } from './api/liveCredentialStore.js';
import Logger from './utils/logger.js';
import { loadEnv, formatEnvErrors, formatEnvWarnings } from './config/envLoader.js';
import { acquireHeadlessRuntimeWriterLock, setupExitHandlers } from './runtime/exitHandlers.js';
import { createAutoRecoverySupervisor } from './runtime/autoRecoverySupervisor.js';
import { createLiveValidationReportRefresher } from './runtime/liveValidationReportRefresher.js';
import { runAfterDashboardReady } from './runtime/dashboardStartup.js';
import { createProfileWriterStartup } from './runtime/profileWriterStartup.js';
import { derivePublicMarketSnapshotFilePath } from './runtime/profileStoragePlan.js';
import { assertSupportedNodeVersion } from './runtime/nodeRuntimeRequirement.js';
import { createConfig, redactConfigForLog, printBanner, printConfig } from './config/runtimeConfig.js';
import { startBacktestingLoop, startOptimizationLoop } from './runtime/researchLoops.js';
import { envInt } from './config/envConfig.js';

dotenv.config();
assertSupportedNodeVersion();

let activeExitHandlers = null;


// 최적화된 파라미터 로드

// 설정 객체 생성

// 시작 배너 출력

// 설정 정보 출력

// 백테스팅 루프 (드라이 모드전용) - 보유 코인만 대상

// 지속적 최적화 루프 (드라이 모드에서 더 짧은 간격)

// 메인 함수
async function main() {
  printBanner();

  // 스키마 검증: 필수 env 누락/형식 오류는 부팅 시점에 실패시킨다.
  const { values: parsedEnv, errors: envErrors, warnings: envWarnings } = loadEnv();
  if (envErrors.length > 0) {
    console.error(formatEnvErrors(envErrors));
    process.exit(1);
  }
  if (envWarnings.length > 0) {
    console.warn(formatEnvWarnings(envWarnings));
  }

  // App-based Upbit enrollment is available only in the dedicated LIVE setup
  // profile. Load its encrypted pair before constructing the exchange clients.
  let liveCredentialStore = null;
  let env = parsedEnv;
  if (parsedEnv.DASHBOARD_LIVE_CREDENTIAL_SETUP_MODE === true) {
    liveCredentialStore = new LiveCredentialStore({
      credentialsFile: parsedEnv.COINPILOT_LIVE_CREDENTIALS_FILE,
      keyFile: parsedEnv.COINPILOT_LIVE_CREDENTIALS_KEY_FILE
    });
    const storedCredentials = liveCredentialStore.load();
    if (storedCredentials) {
      env = {
        ...parsedEnv,
        UPBIT_ACCESS_KEY: storedCredentials.accessKey,
        UPBIT_SECRET_KEY: storedCredentials.secretKey
      };
    } else if (parsedEnv.UPBIT_ACCESS_KEY || parsedEnv.UPBIT_SECRET_KEY) {
      throw new Error(
        'App-based LIVE setup requires Upbit keys to be absent from environment variables; register them in the native app.'
      );
    }
  }

  // 설정 로드
  const config = createConfig(env);

  // TARGET_COINS=ALL 인 경우 기준통화 마켓 전체 자동 로드
  if (config.analyzeAllCoins || config.targetCoins.length === 0) {
    const quotePrefix = `${config.quoteAsset}-`;
    console.log(`\n🔍 모든 ${config.quoteAsset} 마켓 코인 로드 중...`);
    try {
      const upbit = createExchangeClient(config);
      const markets = await upbit.getMarkets();
      const krwMarkets = markets
        .filter(m => m.market.startsWith(quotePrefix))
        .map(m => m.market);

      if (config.isScalpingMode) {
        // 1분봉을 수십~수백 마켓에 동시에 요청하면 신호 확인보다
        // API 대기열이 길어질 수 있으므로 유동성 상위 마켓만 스캔한다.
        const tickers = await upbit.getTicker(krwMarkets);
        config.targetCoins = [...tickers]
          .filter(ticker => Number.isFinite(ticker?.acc_trade_price_24h))
          .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
          .slice(0, config.maxScalpMarkets)
          .map(ticker => ticker.market);

        if (config.targetCoins.length === 0) {
          throw new Error('유동성 상위 스캘핑 마켓을 찾지 못했습니다.');
        }
        console.log(`✅ ${krwMarkets.length}개 KRW 마켓 중 유동성 상위 ${config.targetCoins.length}개 스캔`);
      } else {
        config.targetCoins = krwMarkets;
        console.log(`✅ ${krwMarkets.length}개 KRW 마켓 로드 완료`);
      }
    } catch (error) {
      console.error('❌ 마켓 목록 로드 실패:', error.message);
      // 실패 시 기본 코인으로 폴백
      config.targetCoins = config.isScalpingMode
        ? ['KRW-BTC', 'KRW-ETH', 'KRW-XRP']
        : ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL', 'KRW-DOGE'];
      console.log('⚠️ 기본 코인으로 대체:', config.targetCoins.join(', '));
    }
  }

  printConfig(config);

  // 로거 초기화
  const logger = new Logger(config.logLevel);
  logger.info('다중 코인 자동매매 시스템 시작', { config: redactConfigForLog(config) });

  // 오래된 로그 정리
  logger.cleanOldLogs(7);

  // Claim the profile before MultiCoinTrader hydrates or migrates its JSON.
  const profileWriterStartup = createProfileWriterStartup(config);
  let trader;
  let manualOrderIdempotencyStore;
  let dashboardServer = null;
  let runtimeLifecycleInstalled = false;
  let publicMarketDataSource = null;
  try {
    const runtime = profileWriterStartup.createTraderAndStore(() => {
      // Public market reads share a keyless client across strategy and the
      // dashboard. Account, reconciliation, and order calls stay on trader.upbit.
      const publicMarketSnapshotStore = createPublicMarketSnapshotStore({
        filePath: derivePublicMarketSnapshotFilePath(config.virtualPortfolioFile)
      });
      publicMarketDataSource = createPublicMarketDataSource({
        requestTimeoutMs: config.upbitRequestTimeoutMs,
        snapshotStore: publicMarketSnapshotStore,
        exchangeClient: config.exchange === 'binance' ? createExchangeClient(config) : null
      });
      return new MultiCoinTrader(config, { publicMarketDataSource });
    });
    trader = runtime.trader;
    if (!config.enableDashboard && typeof trader?.upbit?.assertRateCoordinatorReady === 'function') {
      await trader.upbit.assertRateCoordinatorReady();
    }
    manualOrderIdempotencyStore = runtime.manualOrderIdempotencyStore;

    // DashboardServer.start() initializes this same store and validates its
    // adopted lock before binding the HTTP listener.
    if (config.enableDashboard) {
      dashboardServer = new DashboardServer(trader, config.dashboardPort, {
        publicMarketDataSource,
        releaseManualOrderWriterLockOnStop: false,
        optimizationStateDir: config.stateDir,
        manualOrderIdempotencyStore,
        liveCredentialStore,
        liveCredentialSetupMode: config.liveCredentialSetupMode,
        validateLiveCredentials: async ({ accessKey, secretKey }) => {
          const credentialProbe = createExchangeClient({ ...config, accessKey, secretKey });
          const accounts = await credentialProbe.getAccounts();
          return Array.isArray(accounts);
        },
        onLiveCredentialsSaved: async credentials => {
          trader.configureUpbitCredentials(credentials);
          if (config.liveManualPrepareOnBoot) {
            const prepared = await trader.prepareManualLiveSession();
            trader.liveManualPrepared = prepared.ready === true;
          }
        }
      });
    }

    await runAfterDashboardReady(dashboardServer, async () => {
      // Headless startup initializes and verifies this already-owned store
      // instead of acquiring a second profile lock.
      await acquireHeadlessRuntimeWriterLock({
        config,
        trader,
        createStore: () => manualOrderIdempotencyStore
      });
      // The startup owner controls both the portfolio lock and the journal
      // lock so every clean shutdown releases the complete write boundary.
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

      // 스캘핑 모드에서는 기존 종합점수 전략용 백테스트/최적화가
      // 반등 전략 파라미터를 오염시키지 않도록 실행하지 않는다.
      let backtestTimer = null;
      let optimizationTimer = null;

      let exitHandlers;
      try {
        if (config.dryRun && !config.isScalpingMode) {
          backtestTimer = startBacktestingLoop(config, logger, trader);
        }

        if (!config.isScalpingMode) {
          optimizationTimer = startOptimizationLoop(config, logger);
        } else {
          console.log('ℹ️  스캘핑 모드: 기존 종합점수 백테스트/유전 최적화 루프는 비활성화됩니다.');
        }

        // 종료 핸들러 설정
        exitHandlers = setupExitHandlers(trader, dashboardServer, backtestTimer, optimizationTimer, logger, {
          runtimeWriterLockStore: runtimeWriterLockOwner
        });
        activeExitHandlers = exitHandlers;
        runtimeLifecycleInstalled = true;
      } catch (error) {
        if (backtestTimer) clearInterval(backtestTimer);
        if (optimizationTimer) clearInterval(optimizationTimer);
        try {
          await runtimeWriterLockOwner.releaseWriterLock();
        } catch (releaseError) {
          if (error && typeof error === 'object') error.writerLockReleaseError = releaseError;
        }
        throw error;
      }

      // 안내 메시지
      console.log('💡 팁:');
      console.log('  - Ctrl+C를 눌러 언제든지 종료할 수 있습니다.');
      console.log('  - 로그는 logs/ 디렉토리에 저장됩니다.');
      console.log('  - 웹 대시보드: ' + (dashboardServer?.protocol || 'http') + '://localhost:' + config.dashboardPort);
      if (config.dryRun && !config.isScalpingMode) {
        console.log('  - 백테스팅 결과: backtest_results_*.json 파일 확인');
        console.log('  - 백테스팅 간격: ' + (config.backtestInterval / 60000) + '분마다');
      }
      if (!config.isScalpingMode) {
        console.log('  - 최적화 결과: optimal_config.json 파일 확인');
        console.log('  - 최적화 간격: ' + (config.dryRun ?
          ((envInt('OPTIMIZATION_INTERVAL_DRY') || 21600000) / 3600000) :
          ((envInt('OPTIMIZATION_INTERVAL') || 86400000) / 3600000)) + '시간마다');
      }
      console.log('');
      console.log('─'.repeat(80));

      if (config.liveManualPrepareOnBoot) {
        if (trader.liveCredentialsConfigured) {
          const manualPreparation = await trader.prepareManualLiveSession();
          trader.liveManualPrepared = manualPreparation.ready === true;
          if (manualPreparation.ready) {
            console.log(`ℹ️  LIVE 수동 준비 완료: 계좌/미체결 주문을 확인했고 자동 진입은 시작하지 않았습니다. 수동 보호 감시: ${manualPreparation.manualRiskProtection === true ? 'ON' : 'OFF'}`);
          } else {
            console.warn('⚠️  LIVE 계좌/미체결 주문 상태를 확인할 수 없어 신규 주문을 잠급니다.');
          }
        } else {
          console.log('ℹ️  LIVE 키 등록 대기: 계좌 조회와 주문 기능은 키 검증 전까지 잠겨 있습니다.');
        }
      }

      // 안전 중지(fail-closed) 후 자동 재개 감시를 항상 켠다. 트레이더가
      // 스스로 멈추지 않고, 복구 가능한 중지 사유에만 start()를 재호출한다.
      // LIVE 스캘핑에서는 검증 리포트도 함께 갱신해 24h 신선도 게이트가
      // 자동 복구를 영구 차단하지 않게 한다.
      const validationRefresher = createLiveValidationReportRefresher(trader, config);
      trader.liveValidationRefresher = validationRefresher;
      validationRefresher.start();
      const autoRecovery = createAutoRecoverySupervisor(trader, config, {
        onStartFailure: () => validationRefresher.requestRefresh('auto_start_failure')
      });
      trader.autoRecovery = autoRecovery;
      autoRecovery.start();

      const startTraderOnBoot = config.dashboardStartTraderOnBoot;
      if (startTraderOnBoot) {
        // 카운트다운
        console.log('\n⏱️  3초 후 자동매매를 시작합니다...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('⏱️  2...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        console.log('⏱️  1...');
        await new Promise(resolve => setTimeout(resolve, 1000));

        // 자동매매 시작
        try {
          autoRecovery.noteDesiredRunning(true, 'boot_start');
          await trader.start();
        } catch (error) {
          console.error('\n❌ 치명적 오류:', error);
          logger.error('Fatal Error', { error: error.message, stack: error.stack });
          process.exitCode = Math.max(Number(process.exitCode) || 0, 1);
          await exitHandlers.gracefulShutdown(1, { reason: 'startup_failure' });
        }
      } else {
        console.log('ℹ️  부팅 시 자동매매 시작을 건너뜁니다. 대시보드에서 직접 시작할 수 있습니다.');
      }
    });
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

// 프로그램 실행
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
