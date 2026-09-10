import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import MultiCoinTrader from '../trader/multiCoinTrader.js';
import UpbitAPI from '../api/upbit.js';
import { selectFreshMarketCohort } from '../research/marketQuality.js';

dotenv.config();

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

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
    dryRunSeedMoney: number(process.env.PAPER_SMOKE_SEED_MONEY, 1_000_000),
    virtualPortfolioFile: portfolioFile,
    paperValidationFile: paperFile,
    paperMinimumStorageMiB: number(process.env.SCALP_PAPER_MIN_STORAGE_MIB, 1024),
    maxPositions: number(process.env.SCALP_MAX_POSITIONS, 3),
    portfolioAllocation: number(process.env.SCALP_PORTFOLIO_ALLOCATION, 0.1),
    investmentRatio: number(process.env.SCALP_INVESTMENT_RATIO, 0.02),
    maxCandleAgeSeconds: number(process.env.SCALP_MAX_CANDLE_AGE_SECONDS, 0),
    stopLossPercent: number(process.env.SCALP_STOP_LOSS_PERCENT, 1.2),
    takeProfitPercent: number(process.env.SCALP_TAKE_PROFIT_PERCENT, 1.8),
    rsiPeriod: number(process.env.SCALP_RSI_PERIOD, number(process.env.RSI_PERIOD, 14)),
    rsiOversold: number(process.env.SCALP_RSI_OVERSOLD, number(process.env.RSI_OVERSOLD, 30)),
    rsiOverbought: number(process.env.SCALP_RSI_OVERBOUGHT, number(process.env.RSI_OVERBOUGHT, 70)),
    oversoldLookback: number(process.env.SCALP_OVERSOLD_LOOKBACK, 1),
    candleUnit: number(process.env.SCALP_CANDLE_UNIT, 1),
    candleCount: number(process.env.SCALP_CANDLE_COUNT, 120),
    minReboundPercent: number(process.env.SCALP_MIN_REBOUND_PERCENT, 0.15),
    minRsiRecovery: number(process.env.SCALP_MIN_RSI_RECOVERY, 2),
    minVolumeRatio: number(process.env.SCALP_MIN_VOLUME_RATIO, 1),
    volumeLookback: number(process.env.SCALP_VOLUME_LOOKBACK, 20),
    minCloseStrength: number(process.env.SCALP_MIN_CLOSE_STRENGTH, 0.65),
    trendPeriod: number(process.env.SCALP_TREND_PERIOD, 30),
    trendSlopeLookback: number(process.env.SCALP_TREND_SLOPE_LOOKBACK, 3),
    minTrendSlopePercent: number(process.env.SCALP_MIN_TREND_SLOPE_PERCENT, -0.2),
    requirePreviousHighBreak: process.env.SCALP_REQUIRE_PREVIOUS_HIGH_BREAK !== 'false',
    maxSignalRangePercent: number(process.env.SCALP_MAX_SIGNAL_RANGE_PERCENT, 0),
    minSignalRangePercent: number(process.env.SCALP_MIN_SIGNAL_RANGE_PERCENT, 0),
    marketRegimeEnabled: process.env.SCALP_MARKET_REGIME_ENABLED === 'true',
    marketRegimeLookback: number(process.env.SCALP_MARKET_REGIME_LOOKBACK, 5),
    marketRegimeMinBreadth: number(process.env.SCALP_MARKET_REGIME_MIN_BREADTH, 0.5),
    marketRegimeMinReturnPercent: number(process.env.SCALP_MARKET_REGIME_MIN_RETURN_PERCENT, -0.2),
    requireReboundBelowOverbought: process.env.SCALP_REQUIRE_REBOUND_BELOW_OVERBOUGHT === 'true',
    signalProfile: process.env.SCALP_SIGNAL_PROFILE || 'rsi_rebound',
    entryDelayMinMs: number(process.env.SCALP_ENTRY_DELAY_MIN_MS, 1000),
    entryDelayMaxMs: number(process.env.SCALP_ENTRY_DELAY_MAX_MS, 5000),
    maxEntryRetracePercent: number(process.env.SCALP_MAX_ENTRY_RETRACE_PERCENT, 0.25),
    maxEntryChasePercent: number(process.env.SCALP_MAX_ENTRY_CHASE_PERCENT, 0.35),
    breakEvenTriggerPercent: number(process.env.SCALP_BREAK_EVEN_TRIGGER_PERCENT, 0),
    breakEvenOffsetPercent: number(process.env.SCALP_BREAK_EVEN_OFFSET_PERCENT, 0.05),
    trailingActivationPercent: number(process.env.SCALP_TRAILING_ACTIVATION_PERCENT, 0),
    trailingStopPercent: number(process.env.SCALP_TRAILING_STOP_PERCENT, 0),
    maxHoldMinutes: number(process.env.SCALP_MAX_HOLD_MINUTES, 30),
    maxLosingHoldMinutes: number(process.env.SCALP_MAX_LOSING_HOLD_MINUTES, 0),
    maxEntriesPerSignalWindow: number(process.env.SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW, 0),
    positionRiskCheckIntervalMs: number(process.env.SCALP_RISK_CHECK_INTERVAL_MS, 1000),
    maxRiskDataGapSeconds: number(process.env.SCALP_MAX_RISK_DATA_GAP_SECONDS, 30),
    cooldownAfterLossMinutes: number(process.env.SCALP_COOLDOWN_AFTER_LOSS_MINUTES, 15),
    maxConsecutiveLosses: number(process.env.SCALP_MAX_CONSECUTIVE_LOSSES, 3),
    lossCircuitBreakerCount: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_COUNT, 0),
    lossCircuitBreakerWindowMinutes: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES, 30),
    lossCircuitBreakerCooldownMinutes: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES, 60),
    checkInterval: number(process.env.PAPER_SMOKE_INTERVAL_MS, 5_000),
    upbitRequestTimeoutMs: number(process.env.UPBIT_REQUEST_TIMEOUT_MS, 10_000),
    useNews: false,
    requireValidationPassForLive: true,
    paperValidationMinDays: number(process.env.SCALP_PAPER_MIN_DAYS, 7),
    paperValidationMinTrades: number(process.env.SCALP_PAPER_MIN_TRADES, 20),
    paperValidationMinReturnPercent: number(process.env.SCALP_PAPER_MIN_RETURN_PERCENT, 0.2),
    paperValidationMaxDrawdownPercent: number(process.env.SCALP_PAPER_MAX_DRAWDOWN_PERCENT, 15),
    paperValidationMaxHeartbeatGapMinutes: number(process.env.SCALP_PAPER_MAX_HEARTBEAT_GAP_MINUTES, 15),
    logLevel: process.env.LOG_LEVEL || 'warn'
  };
}

async function resolveMarkets() {
  const requested = (process.env.PAPER_SMOKE_MARKETS || '').trim().toUpperCase();
  if (requested === 'FRESH_FROM_LEDGER' || requested === 'FRESH_COHORT') {
    const sourceFile = process.env.PAPER_SMOKE_FRESHNESS_LEDGER;
    if (!sourceFile) {
      throw new Error('freshness 코호트 선택에는 PAPER_SMOKE_FRESHNESS_LEDGER가 필요합니다.');
    }
    let sourceLedger;
    try {
      sourceLedger = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    } catch (error) {
      throw new Error(`freshness 원장 로드 실패 (${sourceFile}): ${error.message}`);
    }
    const cohort = selectFreshMarketCohort({
      markets: sourceLedger?.targetCoins,
      telemetry: sourceLedger?.telemetry,
      minObservations: number(process.env.PAPER_SMOKE_MIN_FRESHNESS_OBSERVATIONS, 100),
      maxFreshnessBlockRate: number(process.env.PAPER_SMOKE_MAX_STALE_RATE, 0.05),
      maxMarkets: number(process.env.PAPER_SMOKE_MAX_MARKETS, 20)
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
  const limit = number(process.env.PAPER_SMOKE_MAX_MARKETS, number(process.env.SCALP_MAX_MARKETS, 20));
  return (tickers || [])
    .filter(ticker => Number.isFinite(ticker?.acc_trade_price_24h))
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, limit)
    .map(ticker => ticker.market);
}

async function main() {
  const forwardMode = process.env.PAPER_FORWARD_MODE === 'true';
  const defaultOutputDir = forwardMode ? '.paper-forward' : '.paper-smoke';
  const outputDir = path.resolve(process.env.PAPER_SMOKE_OUTPUT_DIR || defaultOutputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  assertSufficientStorage(outputDir, number(process.env.SCALP_PAPER_MIN_STORAGE_MIB, 1024));
  const portfolioFile = path.join(outputDir, 'dry_portfolio.json');
  const paperFile = path.join(outputDir, 'paper_validation.json');
  const durationSeconds = Math.max(10, number(process.env.PAPER_SMOKE_SECONDS, 60));
  const markets = await resolveMarkets();
  if (markets.length === 0) throw new Error('paper forward 대상 KRW 마켓이 없습니다.');
  const config = buildConfig(portfolioFile, paperFile, markets);
  const trader = new MultiCoinTrader(config);
  const originalConsoleLog = console.log.bind(console);
  const quietForward = forwardMode && process.env.PAPER_FORWARD_VERBOSE !== 'true';
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
    const gapMs = Number(existingPaperStatus.heartbeatAgeMs) || 0;
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
        if (statusTimer) clearInterval(statusTimer);
        originalConsoleLog(`\n🛑 forward paper 세션 중지: ${status.state}`);
      } finally {
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
    paperLedgerFile: paperFile
  }, null, 2));
}

main().catch(error => {
  console.error('❌ paper smoke 오류:', error.message);
  process.exitCode = 1;
});
