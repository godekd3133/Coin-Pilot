import { finalizeActivePaperValidation } from './paperShutdown.js';

/** Claim the profile writer lock for mutable runtimes that have no dashboard owner. */
export async function acquireHeadlessRuntimeWriterLock({ config, trader, createStore } = {}) {
  if (config?.enableDashboard !== false || trader?.readOnlyObserver === true) return null;
  if (typeof createStore !== 'function') {
    throw new TypeError('A manual-order writer-lock store factory is required for a mutable headless runtime.');
  }

  const store = createStore();
  if (!store || typeof store.initialize !== 'function' || typeof store.releaseWriterLock !== 'function') {
    throw new TypeError('The manual-order writer-lock store must support initialize() and releaseWriterLock().');
  }

  try {
    await store.initialize();
  } catch (error) {
    try {
      // initialize() claims the writer lock before loading the journal. Release
      // a partially acquired lock if journal initialization fails.
      store.releaseWriterLock();
    } catch (releaseError) {
      if (error && typeof error === 'object') error.writerLockReleaseError = releaseError;
    }
    throw error;
  }

  return store;
}

export function setupExitHandlers(
  trader,
  dashboardServer,
  backtestTimer,
  optimizationTimer,
  logger,
  options = {}
) {
  const processApi = options.processApi || process;
  const consoleApi = options.consoleApi || console;
  const exitProcess = options.exitProcess || (code => processApi.exit(code));
  const finalizePaper = options.finalizeActivePaperValidation || finalizeActivePaperValidation;
  const clearTimer = options.clearInterval || clearInterval;
  const runtimeWriterLockStore = options.runtimeWriterLockStore || null;
  let runtimeWriterLockReleaseStarted = false;
  let shutdownPromise = null;
  let shutdownExitCode = 0;

  const releaseRuntimeWriterLock = async () => {
    if (!runtimeWriterLockStore || runtimeWriterLockReleaseStarted) return false;
    runtimeWriterLockReleaseStarted = true;
    return runtimeWriterLockStore.releaseWriterLock();
  };

  const readLivePositionCount = () => {
    if (typeof trader?.getCurrentPositionCount !== 'function') return null;
    try {
      const count = trader.getCurrentPositionCount();
      return Number.isInteger(count) && count >= 0 ? count : null;
    } catch {
      return null;
    }
  };

  const readLiveSafetyStatus = () => {
    if (typeof trader?.getRuntimeSafetyStatus !== 'function') return null;
    try {
      const status = trader.getRuntimeSafetyStatus();
      return status && typeof status === 'object' ? status : null;
    } catch {
      return null;
    }
  };

  const keepLiveRuntimeAfterUnsafeShutdownFailure = (error, liveShutdownVerified) => {
    if (trader?.dryRun === true) return false;
    const positionCount = readLivePositionCount();
    const safety = readLiveSafetyStatus();
    const stateCannotBeProvenSafe = liveShutdownVerified !== true ||
      positionCount === null || positionCount > 0 ||
      safety?.exchangeStateKnown !== true;
    if (!stateCannotBeProvenSafe) return false;

    // Best effort: use the trader's own protective transition. If the adapter
    // is incomplete, pause its visible entry fields and hold the process/lock
    // so an unsupported runtime cannot be mistaken for a safe handoff.
    try {
      trader.pauseForSafetyIncident?.('shutdown_protection_unavailable');
    } catch (pauseError) {
      consoleApi.error(`⚠️ 보호 상태 전환 실패: ${pauseError.message}`);
    }
    if (trader && typeof trader === 'object') {
      if ('_entriesPaused' in trader) trader._entriesPaused = true;
      if ('isRunning' in trader) trader.isRunning = false;
    }

    shutdownExitCode = Math.max(shutdownExitCode, 1);
    processApi.exitCode = shutdownExitCode;
    consoleApi.error(
      `🛑 LIVE 종료 상태를 안전하다고 확인할 수 없어 프로세스와 writer lock을 유지합니다: ${error.message}`
    );
    shutdownPromise = null;
    return true;
  };

  const gracefulShutdown = (requestedExitCode = 0, settings = {}) => {
    shutdownExitCode = Math.max(shutdownExitCode, requestedExitCode);
    if (shutdownPromise) return shutdownPromise;

    const protectLivePositions = settings.protectLivePositions !== false;
    const shutdownReason = settings.reason || 'operator_shutdown';
    shutdownPromise = Promise.resolve().then(async () => {
      consoleApi.log('\n\n⏹️  시스템 종료 중...');

      let traderSafelyStopped;
      let liveShutdownVerified = false;
      let cleanupSucceeded = true;
      try {
        let drainRequired = false;
        if (trader?.dryRun !== true) {
          // LIVE never falls back to stop(): its position and exchange state
          // must be reconciled through the explicit protective shutdown API.
          if (typeof trader.requestGracefulShutdown !== 'function' ||
            typeof trader.getCurrentPositionCount !== 'function' ||
            typeof trader.getRuntimeSafetyStatus !== 'function') {
            throw new Error('필수 LIVE 보호 종료 인터페이스가 없습니다.');
          }
          drainRequired = await trader.requestGracefulShutdown(shutdownReason);
          if (typeof drainRequired !== 'boolean') {
            throw new Error('LIVE 보호 종료 결과를 확인할 수 없습니다.');
          }
          const initialPositionCount = readLivePositionCount();
          const initialSafety = readLiveSafetyStatus();
          if (initialPositionCount === null || !initialSafety || initialSafety.exchangeStateKnown !== true) {
            throw new Error('LIVE 포지션 또는 거래소 동기화 상태를 확인할 수 없습니다.');
          }
          if (!drainRequired) {
            if (initialPositionCount !== 0) {
              throw new Error('보호 종료가 완료됐다고 응답했지만 LIVE 포지션이 남아 있습니다.');
            }
            liveShutdownVerified = true;
            traderSafelyStopped = true;
          } else {
            if (initialPositionCount === 0 || typeof trader.waitForProtectiveDrain !== 'function') {
              throw new Error('LIVE 보호 감시 종료 인터페이스 또는 포지션 상태가 올바르지 않습니다.');
            }
          }
        } else if (protectLivePositions && typeof trader.requestGracefulShutdown === 'function') {
          drainRequired = await trader.requestGracefulShutdown(shutdownReason);
          traderSafelyStopped = drainRequired !== true;
        } else {
          trader.stop(shutdownReason);
          traderSafelyStopped = true;
        }

        if (drainRequired && typeof trader.waitForProtectiveDrain === 'function') {
          consoleApi.log('🛡️  감시 대상 LIVE 포지션이 닫힐 때까지 신규 진입을 잠그고 위험 감시를 유지합니다.');
          while (true) {
            const positionCount = readLivePositionCount();
            const safety = readLiveSafetyStatus();
            if (positionCount === null || !safety || safety.exchangeStateKnown !== true) {
              throw new Error('LIVE 보호 감시 중 포지션 또는 거래소 상태를 확인할 수 없습니다.');
            }
            if (positionCount === 0) break;
            if (safety.protectiveMonitorActive !== true &&
              await trader.requestGracefulShutdown(shutdownReason) !== true) {
              throw new Error('LIVE 포지션은 남았지만 보호 감시를 유지할 수 없습니다.');
            }
            const drained = await trader.waitForProtectiveDrain();
            if (drained !== true) {
              throw new Error('LIVE 보호 drain이 포지션 종료를 확인하지 못했습니다.');
            }
          }
          liveShutdownVerified = true;
          trader.stop(shutdownReason);
          traderSafelyStopped = true;
        } else if (drainRequired && trader?.dryRun !== true) {
          throw new Error('LIVE 보호 drain을 검증할 수 없습니다.');
        }
      } catch (error) {
        shutdownExitCode = Math.max(shutdownExitCode, 1);
        processApi.exitCode = shutdownExitCode;
        consoleApi.error(`⚠️ 안전 종료 대기 실패: ${error.message}`);
        if (keepLiveRuntimeAfterUnsafeShutdownFailure(error, liveShutdownVerified)) return false;
        throw error;
      }

      try {
        const paperResult = await finalizePaper(trader, consoleApi);
        if (paperResult?.error) {
          shutdownExitCode = Math.max(shutdownExitCode, 1);
          cleanupSucceeded = false;
        }
      } catch (error) {
        shutdownExitCode = Math.max(shutdownExitCode, 1);
        cleanupSucceeded = false;
        consoleApi.error(`⚠️ paper validation 종료 기록 실패: ${error.message}`);
      }

      if (dashboardServer) {
        try {
          await dashboardServer.stop();
        } catch (error) {
          shutdownExitCode = Math.max(shutdownExitCode, 1);
          cleanupSucceeded = false;
          consoleApi.error(`⚠️ 대시보드 종료 실패: ${error.message}`);
        }
      }

      for (const [name, timer] of [['backtest', backtestTimer], ['optimization', optimizationTimer]]) {
        if (!timer) continue;
        try {
          clearTimer(timer);
        } catch (error) {
          shutdownExitCode = Math.max(shutdownExitCode, 1);
          cleanupSucceeded = false;
          consoleApi.error(`⚠️ ${name} 타이머 종료 실패: ${error.message}`);
        }
      }

      let hasPositions = false;
      for (const [coin, strategy] of trader.strategies?.entries?.() || []) {
        if (strategy.currentPosition) {
          if (!hasPositions) {
            consoleApi.log('\n⚠️  아직 닫히지 않은 포지션이 있습니다.');
            hasPositions = true;
          }
          consoleApi.log(`\n[${coin}]`);
          consoleApi.log(strategy.currentPosition);
        }
      }

      consoleApi.log('\n📊 최종 거래 통계:');
      for (const [coin, strategy] of trader.strategies?.entries?.() || []) {
        const stats = strategy.getStatistics();
        if (stats.totalTrades > 0) {
          consoleApi.log(`\n[${coin}]`);
          consoleApi.log(stats);
        }
      }

      try {
        await logger?.flush?.();
      } catch (error) {
        shutdownExitCode = Math.max(shutdownExitCode, 1);
        cleanupSucceeded = false;
        consoleApi.error(`⚠️ 로그 flush 실패: ${error.message}`);
      }

      // Keep the writer lock across portfolio finalization, HTTP shutdown,
      // timer cleanup, and log flush. On cleanup failure the imminent process
      // exit closes the OS handle; the next owner can then recover the stale
      // lock after confirming this PID has exited.
      if (traderSafelyStopped && cleanupSucceeded) {
        try {
          await releaseRuntimeWriterLock();
        } catch (error) {
          shutdownExitCode = Math.max(shutdownExitCode, 1);
          consoleApi.error(`⚠️ profile writer lock 해제 실패: ${error.message}`);
        }
      }

      consoleApi.log('\n👋 프로그램을 종료합니다.\n');
      shutdownExitCode = Math.max(shutdownExitCode, Number(processApi.exitCode) || 0);
      processApi.exitCode = shutdownExitCode;
      exitProcess(shutdownExitCode);
    });
    return shutdownPromise;
  };

  const handleUnhandledRejection = reason => {
    const reasonType = reason instanceof Error ? 'Error' : typeof reason;
    consoleApi.error('\n💥 처리되지 않은 Promise 거부 (원인 유형:', reasonType, ')');
    logger?.error?.('Unhandled Rejection', { reasonType });
    processApi.exitCode = Math.max(Number(processApi.exitCode) || 0, 1);
    const shutdownAfterDrain = gracefulShutdown(1, { reason: 'unhandled_rejection' });
    shutdownAfterDrain.catch(error => {
      consoleApi.error('unhandled rejection 정리 실패:', error);
      processApi.exitCode = 1;
      exitProcess(1);
    });
    return shutdownAfterDrain;
  };

  const handleUncaughtException = error => {
    consoleApi.error('\n💥 예상치 못한 오류 발생:', error);
    logger?.error?.('Uncaught Exception', { error: error.message, stack: error.stack });
    // A fatal error is not a safe handoff while LIVE positions are open. Use
    // the normal protective shutdown path so new entries stay blocked and the
    // process (including its writer lock) remains alive until the positions
    // drain safely. If exchange state cannot be verified, gracefulShutdown
    // keeps the process alive in its protective/sync-required state.
    processApi.exitCode = Math.max(Number(processApi.exitCode) || 0, 1);
    return gracefulShutdown(1, { reason: 'uncaught_exception' });
  };

  processApi.on('SIGINT', () => {
    void gracefulShutdown(0).catch(error => {
      consoleApi.error('graceful shutdown 실패:', error);
      processApi.exitCode = 1;
      exitProcess(1);
    });
  });
  processApi.on('SIGTERM', () => {
    void gracefulShutdown(0).catch(error => {
      consoleApi.error('graceful shutdown 실패:', error);
      processApi.exitCode = 1;
      exitProcess(1);
    });
  });
  processApi.on('uncaughtException', handleUncaughtException);
  processApi.on('unhandledRejection', handleUnhandledRejection);

  return { gracefulShutdown, handleUnhandledRejection, handleUncaughtException };
}
