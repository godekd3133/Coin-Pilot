import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import MultiCoinTrader from '../trader/multiCoinTrader.js';
import UpbitAPI from '../api/upbit.js';
import { selectFreshMarketCohort } from '../research/marketQuality.js';
import {
  acquirePaperSessionLock,
  assertNoConcurrentPaperSessions
} from '../research/paperSessionConcurrency.js';
import { createPaperAiMonitor } from '../ai/paperAiMonitoring.js';
import { envBool, envNumber, envString } from '../config/envConfig.js';

dotenv.config();

// Keep the active paper session recoverable when the runner itself fails.
// SIGKILL/host termination cannot be intercepted, so the dashboard still
// treats a missing owner or stale heartbeat as orphaned and fail-closed.
let activeRuntime = null;

function serializeRuntimeError(error, source) {
  return {
    source,
    name: error?.name || 'Error',
    code: error?.code || null,
    message: error?.message || String(error),
    recordedAt: new Date().toISOString()
  };
}

async function failSafeShutdown(error, source = 'runner_error') {
  const runtime = activeRuntime;
  if (!runtime) {
    console.error(`❌ paper runner 오류 (${source}):`, error?.message || String(error));
    return;
  }
  if (runtime.failurePromise) return runtime.failurePromise;

  runtime.failurePromise = (async () => {
    const terminalError = serializeRuntimeError(error, source);
    try {
      if (runtime.statusTimer) clearInterval(runtime.statusTimer);
      const trader = runtime.trader;
      if (trader?.paperValidation?.active === true) {
        trader.stop(`runner_error:${source}`);
        trader.paperValidation.terminalError = terminalError;
        trader.paperValidation.lastError = terminalError;
        try {
          trader.savePaperValidation();
        } catch (persistError) {
          console.error('❌ paper runner 오류 상태 저장 실패:', persistError.message);
        }
        await trader.stopPaperValidationSession();
      }
      if (runtime.paperAiMonitor) await runtime.paperAiMonitor.stop();
    } catch (cleanupError) {
      console.error('❌ paper runner 오류 정리 실패:', cleanupError.message);
    } finally {
      runtime.paperSessionLock?.release();
      activeRuntime = null;
    }
    console.error(`❌ paper runner 종료 (${source}):`, terminalError.message);
  })();

  return runtime.failurePromise;
}

process.on('uncaughtException', error => {
  failSafeShutdown(error, 'uncaught_exception')
    .finally(() => process.exit(1));
});

process.on('unhandledRejection', reason => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  failSafeShutdown(error, 'unhandled_rejection')
    .finally(() => process.exit(1));
});

function assertSufficientStorage(outputDir, minimumMiB = 1024) {
  if (typeof fs.statfsSync !== 'function') return;
  const stats = fs.statfsSync(outputDir);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const minimumBytes = Math.max(128, Number(minimumMiB) || 1024) * 1024 * 1024;
  if (Number.isFinite(availableBytes) && availableBytes < minimumBytes) {
    throw new Error(`forward paper 저장 공간 부족: ${(availableBytes / 1024 / 1024).toFixed(0)}MiB 남음 (최소 ${minimumBytes / 1024 / 1024}MiB 필요)`);
  }
}

function buildConfig(portfolioFile, paperFile, markets) {
  return {
    accessKey: '',
    secretKey: '',
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: markets,
    dryRun: true,
    dryRunSeedMoney: envNumber('PAPER_SMOKE_SEED_MONEY', 1_000_000),
    virtualPortfolioFile: portfolioFile,
    paperValidationFile: paperFile,
    paperMinimumStorageMiB: envNumber('SCALP_PAPER_MIN_STORAGE_MIB', 1024),
    maxPositions: envNumber('SCALP_MAX_POSITIONS', 3),
    portfolioAllocation: envNumber('SCALP_PORTFOLIO_ALLOCATION', 0.1),
    investmentRatio: envNumber('SCALP_INVESTMENT_RATIO', 0.02),
    maxCandleAgeSeconds: envNumber('SCALP_MAX_CANDLE_AGE_SECONDS', 0),
    stopLossPercent: envNumber('SCALP_STOP_LOSS_PERCENT', 1.2),
    takeProfitPercent: envNumber('SCALP_TAKE_PROFIT_PERCENT', 1.8),
    rsiPeriod: envNumber('SCALP_RSI_PERIOD', envNumber('RSI_PERIOD', 14)),
    rsiOversold: envNumber('SCALP_RSI_OVERSOLD', envNumber('RSI_OVERSOLD', 30)),
    rsiOverbought: envNumber('SCALP_RSI_OVERBOUGHT', envNumber('RSI_OVERBOUGHT', 70)),
    oversoldLookback: envNumber('SCALP_OVERSOLD_LOOKBACK', 1),
    candleUnit: envNumber('SCALP_CANDLE_UNIT', 1),
    candleCount: envNumber('SCALP_CANDLE_COUNT', 120),
    minReboundPercent: envNumber('SCALP_MIN_REBOUND_PERCENT', 0.15),
    minRsiRecovery: envNumber('SCALP_MIN_RSI_RECOVERY', 2),
    minVolumeRatio: envNumber('SCALP_MIN_VOLUME_RATIO', 1),
    volumeLookback: envNumber('SCALP_VOLUME_LOOKBACK', 20),
    minCloseStrength: envNumber('SCALP_MIN_CLOSE_STRENGTH', 0.65),
    trendPeriod: envNumber('SCALP_TREND_PERIOD', 30),
    trendSlopeLookback: envNumber('SCALP_TREND_SLOPE_LOOKBACK', 3),
    minTrendSlopePercent: envNumber('SCALP_MIN_TREND_SLOPE_PERCENT', -0.2),
    requirePreviousHighBreak: envBool('SCALP_REQUIRE_PREVIOUS_HIGH_BREAK', true),
    maxSignalRangePercent: envNumber('SCALP_MAX_SIGNAL_RANGE_PERCENT', 0),
    minSignalRangePercent: envNumber('SCALP_MIN_SIGNAL_RANGE_PERCENT', 0),
    maxReboundPercent: envNumber('SCALP_MAX_REBOUND_PERCENT', 0),
    marketRegimeEnabled: envBool('SCALP_MARKET_REGIME_ENABLED', false),
    marketRegimeLookback: envNumber('SCALP_MARKET_REGIME_LOOKBACK', 5),
    marketRegimeMinBreadth: envNumber('SCALP_MARKET_REGIME_MIN_BREADTH', 0.5),
    marketRegimeMinReturnPercent: envNumber('SCALP_MARKET_REGIME_MIN_RETURN_PERCENT', -0.2),
    requireReboundBelowOverbought: envBool('SCALP_REQUIRE_REBOUND_BELOW_OVERBOUGHT', false),
    signalProfile: envString('SCALP_SIGNAL_PROFILE', 'rsi_rebound'),
    bbPeriod: envNumber('BB_PERIOD', 20),
    bbStdDev: envNumber('BB_STD_DEV', 2),
    emaLong: envNumber('EMA_LONG', 60),
    entryDelayMinMs: envNumber('SCALP_ENTRY_DELAY_MIN_MS', 1000),
    entryDelayMaxMs: envNumber('SCALP_ENTRY_DELAY_MAX_MS', 5000),
    maxEntryRetracePercent: envNumber('SCALP_MAX_ENTRY_RETRACE_PERCENT', 0.25),
    maxEntryChasePercent: envNumber('SCALP_MAX_ENTRY_CHASE_PERCENT', 0.35),
    breakEvenTriggerPercent: envNumber('SCALP_BREAK_EVEN_TRIGGER_PERCENT', 0),
    breakEvenOffsetPercent: envNumber('SCALP_BREAK_EVEN_OFFSET_PERCENT', 0.05),
    trailingActivationPercent: envNumber('SCALP_TRAILING_ACTIVATION_PERCENT', 0),
    trailingStopPercent: envNumber('SCALP_TRAILING_STOP_PERCENT', 0),
    maxHoldMinutes: envNumber('SCALP_MAX_HOLD_MINUTES', 30),
    maxLosingHoldMinutes: envNumber('SCALP_MAX_LOSING_HOLD_MINUTES', 0),
    winnerExtendMinutes: envNumber('SCALP_WINNER_EXTEND_MINUTES', 0),
    winnerExtendMinProfitPercent: envNumber('SCALP_WINNER_EXTEND_MIN_PROFIT_PERCENT', 0),
    winnerShadowExtendMinutes: envNumber('SCALP_WINNER_SHADOW_EXTEND_MINUTES', 0),
    winnerShadowExtendMinProfitPercent: envNumber('SCALP_WINNER_SHADOW_EXTEND_MIN_PROFIT_PERCENT', 0),
    winnerShadowMaxReboundPercent: envNumber('SCALP_WINNER_SHADOW_MAX_REBOUND_PERCENT', 0),
    paperDiagnosticShadowsEnabled: envBool('SCALP_PAPER_DIAGNOSTIC_SHADOWS_ENABLED', true),
    maxEntriesPerSignalWindow: envNumber('SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW', 0),
    positionRiskCheckIntervalMs: envNumber('SCALP_RISK_CHECK_INTERVAL_MS', 1000),
    maxRiskDataGapSeconds: envNumber('SCALP_MAX_RISK_DATA_GAP_SECONDS', 30),
    maxAnalysisDataGapSeconds: envNumber('SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS', 60),
    cooldownAfterLossMinutes: envNumber('SCALP_COOLDOWN_AFTER_LOSS_MINUTES', 15),
    maxConsecutiveLosses: envNumber('SCALP_MAX_CONSECUTIVE_LOSSES', 3),
    lossCircuitBreakerCount: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_COUNT', 0),
    lossCircuitBreakerWindowMinutes: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES', 30),
    lossCircuitBreakerCooldownMinutes: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES', 60),
    checkInterval: envNumber('PAPER_SMOKE_INTERVAL_MS', 5_000),
    upbitRequestTimeoutMs: envNumber('UPBIT_REQUEST_TIMEOUT_MS', 10_000),
    useNews: false,
    requireValidationPassForLive: true,
    paperValidationMinDays: envNumber('SCALP_PAPER_MIN_DAYS', 7),
    paperValidationMinTrades: envNumber('SCALP_PAPER_MIN_TRADES', 20),
    paperValidationMinReturnPercent: envNumber('SCALP_PAPER_MIN_RETURN_PERCENT', 0.2),
    paperValidationMaxDrawdownPercent: envNumber('SCALP_PAPER_MAX_DRAWDOWN_PERCENT', 15),
    paperValidationMaxHeartbeatGapMinutes: envNumber('SCALP_PAPER_MAX_HEARTBEAT_GAP_MINUTES', 15),
    // Keep the validation artifact identity shared with the live config and
    // staging/API projection. Paper sessions do not read the report here,
    // but must still carry the same explicit path contract.
    scalpingValidationOutputFile: envString('SCALP_VALIDATION_OUTPUT_FILE', 'scalping_validation.json'),
    logLevel: envString('LOG_LEVEL', 'warn')
  };
}

async function resolveMarkets() {
  const requested = envString('PAPER_SMOKE_MARKETS', '').trim().toUpperCase();
  if (requested === 'FRESH_FROM_LEDGER' || requested === 'FRESH_COHORT') {
    const sourceFile = envString('PAPER_SMOKE_FRESHNESS_LEDGER', null);
    if (!sourceFile) {
      throw new Error('freshness 코호트 선택에는 PAPER_SMOKE_FRESHNESS_LEDGER가 필요합니다.');
    }
    let sourceLedger;
    try {
      sourceLedger = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    } catch (error) {
      throw new Error(`freshness 원장 로드 실패 (${sourceFile}): ${error.message}`, { cause: error });
    }
    const cohort = selectFreshMarketCohort({
      markets: sourceLedger?.targetCoins,
      telemetry: sourceLedger?.telemetry,
      minObservations: envNumber('PAPER_SMOKE_MIN_FRESHNESS_OBSERVATIONS', 100),
      maxFreshnessBlockRate: envNumber('PAPER_SMOKE_MAX_STALE_RATE', 0.05),
      maxMarkets: envNumber('PAPER_SMOKE_MAX_MARKETS', 20)
    });
    if (cohort.selectedMarkets.length === 0) {
      throw new Error(`freshness 코호트 조건을 통과한 마켓이 없습니다 (최소 관측 ${cohort.minObservations}회, 최대 차단률 ${(cohort.maxFreshnessBlockRate * 100).toFixed(1)}%).`);
    }
    console.log(`📊 이전 paper 원장 기반 freshness 코호트: ${cohort.selectedMarkets.join(', ')}`);
    console.log(`   기준: 관측 ${cohort.minObservations}회 이상 · 차단률 ${(cohort.maxFreshnessBlockRate * 100).toFixed(1)}% 이하 · 최대 ${cohort.maxMarkets}개`);
    const excluded = cohort.excludedRows
      .map(row => `${row.market}:${row.exclusionReason}`)
      .join(', ');
    if (excluded) console.log(`   제외: ${excluded}`);
    return cohort.selectedMarkets;
  }
  if (requested && requested !== 'ALL') {
    return requested.split(',').map(market => market.trim()).filter(Boolean);
  }

  const upbit = new UpbitAPI('', '');
  const excluded = new Set(['KRW-USDT', 'KRW-USDC', 'KRW-DAI', 'KRW-USD1']);
  const markets = (await upbit.getMarkets())
    .filter(item => item.market?.startsWith('KRW-') && !excluded.has(item.market))
    .map(item => item.market);
  const tickers = await upbit.getTicker(markets);
  const limit = envNumber('PAPER_SMOKE_MAX_MARKETS', envNumber('SCALP_MAX_MARKETS', 20));
  return (tickers || [])
    .filter(ticker => Number.isFinite(ticker?.acc_trade_price_24h))
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, limit)
    .map(ticker => ticker.market);
}

async function main() {
  const forwardMode = envBool('PAPER_FORWARD_MODE', false);
  const defaultOutputDir = forwardMode ? '.paper-forward' : '.paper-smoke';
  const outputDir = path.resolve(envString('PAPER_SMOKE_OUTPUT_DIR', defaultOutputDir));
  fs.mkdirSync(outputDir, { recursive: true });
  assertSufficientStorage(outputDir, envNumber('SCALP_PAPER_MIN_STORAGE_MIB', 1024));
  const portfolioFile = path.join(outputDir, 'dry_portfolio.json');
  const paperFile = path.join(outputDir, 'paper_validation.json');
  const paperSessionLock = acquirePaperSessionLock({
    workspaceRoot: process.cwd(),
    allowConcurrent: envBool('PAPER_ALLOW_CONCURRENT_SESSIONS', false)
  });
  assertNoConcurrentPaperSessions({
    workspaceRoot: process.cwd(),
    currentLedgerFile: paperFile,
    allowConcurrent: envBool('PAPER_ALLOW_CONCURRENT_SESSIONS', false)
  });
  const durationSeconds = Math.max(10, envNumber('PAPER_SMOKE_SECONDS', 60));
  const markets = await resolveMarkets();
  if (markets.length === 0) throw new Error('paper forward 대상 KRW 마켓이 없습니다.');
  const config = buildConfig(portfolioFile, paperFile, markets);
  const trader = new MultiCoinTrader(config);
  const paperAiMonitor = createPaperAiMonitor({
    trader,
    config,
    outputDir
  });
  activeRuntime = {
    trader,
    paperSessionLock,
    paperAiMonitor,
    statusTimer: null,
    failurePromise: null
  };
  const originalConsoleLog = console.log.bind(console);
  const quietForward = forwardMode && !envBool('PAPER_FORWARD_VERBOSE', false);
  let statusTimer = null;
  if (quietForward) {
    console.log = (...args) => {
      const message = args.map(String).join(' ');
      if (/^(🧪|🛑|❌|💾|Rate limited|실전 스캘핑 차단)/.test(message)) {
        originalConsoleLog(...args);
      }
    };
  }

  const hasPortfolio = fs.existsSync(portfolioFile);
  const existingPaperStatus = trader.paperValidation?.active
    ? await trader.getPaperValidationStatus()
    : null;
  const hasActivePaperSession = trader.paperValidation?.active === true && existingPaperStatus?.orphaned !== true;
  if (forwardMode && trader.paperValidation?.active === true && existingPaperStatus?.configConsistent === false) {
    throw new Error(`기존 forward paper 설정 drift 감지: ${existingPaperStatus.configDrift.join(', ')}. 새 출력 디렉터리에서 별도 세션을 시작하세요.`);
  }
  if (forwardMode && trader.paperValidation?.active === true && existingPaperStatus?.paperExperimentConsistent === false) {
    throw new Error(`기존 forward paper 연구 실험 설정 drift 감지: ${(existingPaperStatus.paperExperimentDrift || []).join(', ')}. 새 출력 디렉터리에서 별도 세션을 시작하세요.`);
  }
  const canResumeOrphanedForward = forwardMode &&
    trader.paperValidation?.active === true &&
    existingPaperStatus?.orphaned === true;
  if (canResumeOrphanedForward) {
    // A process restart must preserve the same evidence window. Marking an
    // orphaned session as stopped and immediately replacing its ledger would
    // erase the observations collected before the crash.
    const resumedAt = new Date().toISOString();
    trader.paperValidation.active = true;
    trader.paperValidation.endedAt = null;
    trader.paperValidation.processId = process.pid;
    trader.paperValidation.heartbeatAt = resumedAt;
    trader.paperValidation.telemetry = {
      ...(trader.paperValidation.telemetry || {}),
      heartbeatAt: resumedAt
    };
    if (!trader.paperValidation.configSnapshot) {
      trader.paperValidation.configSnapshot = trader.getPaperValidationConfigSnapshot();
      trader.paperValidation.configSnapshotComplete = false;
      trader.paperValidation.configSnapshotBackfilledAt = resumedAt;
    }
    const gapMs = Number.isFinite(Number(existingPaperStatus.heartbeatAgeMs))
      ? Number(existingPaperStatus.heartbeatAgeMs)
      : null;
    trader.paperValidation.interruptions = [
      ...(Array.isArray(trader.paperValidation.interruptions)
        ? trader.paperValidation.interruptions
        : []),
      {
        detectedAt: resumedAt,
        previousHeartbeatAt: existingPaperStatus.heartbeatAt,
        resumedAt,
        gapMs
      }
    ].slice(-100);
    trader.savePaperValidation();
    console.log('🔁 orphaned forward paper 세션을 이어서 관찰합니다.');
  } else if (!hasActivePaperSession) {
    await trader.startPaperValidationSession({
      reset: !forwardMode || !hasPortfolio,
      seedMoney: config.dryRunSeedMoney,
      minDays: forwardMode ? undefined : 0.0001,
      minTrades: forwardMode ? undefined : 1
    });
  }

  console.log(`\n🧪 격리된 ${forwardMode ? 'forward paper' : 'forward paper smoke'} 시작${forwardMode ? ' (Ctrl+C로 중지)' : ` (${durationSeconds}초)`}`);
  console.log(`마켓: ${config.targetCoins.join(', ')}`);
  console.log(`상태 파일: ${paperFile}`);

  if (forwardMode) {
    statusTimer = setInterval(async () => {
      try {
        const status = await trader.getPaperValidationStatus();
        const circuit = status.lossCircuitBreaker;
        originalConsoleLog(`[paper] cycles=${status.telemetry?.cycles || 0} strictBuy=${status.telemetry?.buyCandidates || 0} circuit=${circuit?.coolingDown ? 'ON' : 'off'} shadow=${status.telemetry?.shadowCandidates || 0} shadowClosed=${status.shadowEvaluation?.closedTradeCount || 0} shadowPnl=${Math.round(status.shadowEvaluation?.realizedProfit || 0)} trades=${status.closedTradeCount || 0} assets=${Math.round(status.currentAssets || 0)} state=${status.state}`);
      } catch (error) {
        originalConsoleLog(`[paper] status error: ${error.message}`);
      }
    }, 60_000);
    activeRuntime.statusTimer = statusTimer;
  }

  const stopTimer = forwardMode ? null : setTimeout(() => trader.stop(), durationSeconds * 1000);
  if (forwardMode) {
    let signalShutdownStarted = false;
    const handleSignal = async () => {
      if (signalShutdownStarted) return;
      signalShutdownStarted = true;
      trader.stop();
      try {
        const status = await trader.stopPaperValidationSession();
        const aiEffectiveness = paperAiMonitor ? await paperAiMonitor.stop() : null;
        if (statusTimer) clearInterval(statusTimer);
        originalConsoleLog(`\n🛑 forward paper 세션 중지: ${status.state}`);
        if (aiEffectiveness) originalConsoleLog(`🧠 AI monitoring 세션 중지: ${aiEffectiveness.evaluatedConsultations}개 평가 표본`);
      } finally {
        paperSessionLock.release();
        activeRuntime = null;
        process.exit(0);
      }
    };
    process.once('SIGINT', handleSignal);
    process.once('SIGTERM', handleSignal);
  }
  try {
    await trader.start();
  } finally {
    if (stopTimer) clearTimeout(stopTimer);
    if (statusTimer) clearInterval(statusTimer);
  }

  const status = await trader.stopPaperValidationSession();
  const aiEffectiveness = paperAiMonitor ? await paperAiMonitor.stop() : null;
  originalConsoleLog(JSON.stringify({
    state: status.state,
    elapsedDays: status.elapsedDays,
    baselineAssets: status.baselineAssets,
    currentAssets: status.currentAssets,
    returnPercent: status.returnPercent,
    closedTradeCount: status.closedTradeCount,
    snapshotCount: status.snapshotCount,
    telemetry: status.telemetry,
    isolatedPortfolioFile: portfolioFile,
    paperLedgerFile: paperFile,
    aiMonitoring: paperAiMonitor
      ? {
          stateFile: paperAiMonitor.stateFile,
          sessionId: paperAiMonitor.session.id,
          effectiveness: aiEffectiveness
        }
      : null
  }, null, 2));
  paperSessionLock.release();
  activeRuntime = null;
}

main().catch(error => {
  failSafeShutdown(error, 'main_rejection')
    .finally(() => process.exit(1));
});
