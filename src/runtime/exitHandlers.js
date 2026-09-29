import { finalizeActivePaperValidation } from './paperShutdown.js';

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
  let shutdownPromise = null;
  let shutdownExitCode = 0;

  const gracefulShutdown = (requestedExitCode = 0, settings = {}) => {
    shutdownExitCode = Math.max(shutdownExitCode, requestedExitCode);
    if (shutdownPromise) return shutdownPromise;

    const protectLivePositions = settings.protectLivePositions !== false;
    const shutdownReason = settings.reason || 'operator_shutdown';
    shutdownPromise = Promise.resolve().then(async () => {
      consoleApi.log('\n\n⏹️  시스템 종료 중...');

      try {
        let drainRequired = false;
        if (protectLivePositions && typeof trader.requestGracefulShutdown === 'function') {
          drainRequired = await trader.requestGracefulShutdown(shutdownReason);
        } else {
          trader.stop(shutdownReason);
        }

        if (drainRequired && typeof trader.waitForProtectiveDrain === 'function') {
          consoleApi.log('🛡️  감시 대상 LIVE 포지션이 닫힐 때까지 신규 진입을 잠그고 위험 감시를 유지합니다.');
          while ((trader.getCurrentPositionCount?.() || 0) > 0) {
            const safety = trader.getRuntimeSafetyStatus?.();
            if (safety?.protectiveMonitorActive !== true &&
              await trader.requestGracefulShutdown(shutdownReason) !== true) {
              throw new Error('LIVE 포지션은 남았지만 보호 감시를 유지할 수 없습니다.');
            }
            const drained = await trader.waitForProtectiveDrain();
            if (drained) break;
          }
          if ((trader.getCurrentPositionCount?.() || 0) > 0) {
            throw new Error('보호 감시 종료 시 LIVE 포지션이 남아 있습니다.');
          }
          trader.stop(shutdownReason);
        }
      } catch (error) {
        shutdownExitCode = Math.max(shutdownExitCode, 1);
        processApi.exitCode = shutdownExitCode;
        consoleApi.error(`⚠️ 안전 종료 대기 실패: ${error.message}`);
        const hasLivePositions = (trader.getCurrentPositionCount?.() || 0) > 0;
        const exchangeStateUnknown = trader.dryRun !== true &&
          trader.getRuntimeSafetyStatus?.().exchangeStateKnown === false;
        if (protectLivePositions && trader.dryRun !== true && (hasLivePositions || exchangeStateUnknown)) {
          if (hasLivePositions) trader.pauseForSafetyIncident?.('shutdown_drain_failure');
          consoleApi.error('🛑 LIVE 상태가 확인되지 않아 프로세스를 종료하지 않고 대시보드를 유지합니다.');
          shutdownPromise = null;
          return false;
        }
        throw error;
      }

      try {
        const paperResult = await finalizePaper(trader, consoleApi);
        if (paperResult?.error) shutdownExitCode = Math.max(shutdownExitCode, 1);
      } catch (error) {
        shutdownExitCode = Math.max(shutdownExitCode, 1);
        consoleApi.error(`⚠️ paper validation 종료 기록 실패: ${error.message}`);
      }

      if (dashboardServer) {
        try {
          await dashboardServer.stop();
        } catch (error) {
          shutdownExitCode = Math.max(shutdownExitCode, 1);
          consoleApi.error(`⚠️ 대시보드 종료 실패: ${error.message}`);
        }
      }

      if (backtestTimer) clearTimer(backtestTimer);
      if (optimizationTimer) clearTimer(optimizationTimer);

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
        consoleApi.error(`⚠️ 로그 flush 실패: ${error.message}`);
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
    // A fatal error may arrive while SIGINT/SIGTERM is already draining LIVE
    // positions. Keep that existing protective drain, but mark the process as
    // failed immediately and retain exit code 1 when the drain completes.
    processApi.exitCode = Math.max(Number(processApi.exitCode) || 0, 1);
    return gracefulShutdown(1, { protectLivePositions: false, reason: 'uncaught_exception' });
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
