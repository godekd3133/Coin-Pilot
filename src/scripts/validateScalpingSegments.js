import dotenv from 'dotenv';
import fs from 'node:fs';
import {
  DEFAULT_CONFIG,
  simulateScalpingSegmented
} from '../backtest/scalpingBacktest.js';
import {
  loadPaperValidationConfigSnapshot,
  mergePaperValidationConfig
} from '../research/scalpingValidationConfig.js';

dotenv.config();

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function resolveInputFile() {
  const explicit = process.env.SCALP_SEGMENT_CANDLES_FILE || process.argv[2];
  if (!explicit) {
    throw new Error(
      'segmented diagnostic은 혼합 window 방지를 위해 candle cache가 필요합니다. ' +
      'SCALP_SEGMENT_CANDLES_FILE 또는 첫 번째 인자로 cache 경로를 지정하세요.'
    );
  }
  if (!fs.existsSync(explicit)) {
    throw new Error(`segmented diagnostic candle cache가 없습니다: ${explicit}`);
  }
  return explicit;
}

function loadCandleCache(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`segmented diagnostic candle cache를 읽을 수 없습니다 (${filePath}): ${error.message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`segmented diagnostic candle cache 형식이 잘못되었습니다: ${filePath}`);
  }
  return parsed;
}

function resolveMarkets(cache) {
  const requested = (process.env.SCALP_SEGMENT_MARKETS || '')
    .split(',')
    .map(market => market.trim().toUpperCase())
    .filter(Boolean);
  const markets = requested.length > 0 ? requested : Object.keys(cache);
  if (markets.length === 0) throw new Error('segmented diagnostic 대상 market이 없습니다.');
  for (const market of markets) {
    if (!Array.isArray(cache[market])) {
      throw new Error(`segmented diagnostic candle cache에 ${market} 데이터가 없습니다.`);
    }
  }
  return markets;
}

function baseConfig(snapshot) {
  const requestedUnit = process.env.SCALP_SEGMENT_CANDLE_UNIT;
  const unit = requestedUnit === undefined || requestedUnit === ''
    ? number(snapshot?.config?.candleUnit, number(process.env.SCALP_CANDLE_UNIT, 1))
    : number(requestedUnit, 1);
  const envConfig = {
    initialBalance: number(process.env.SCALP_VALIDATION_INITIAL_BALANCE, DEFAULT_CONFIG.initialBalance),
    tradingFee: number(process.env.SCALP_VALIDATION_FEE, DEFAULT_CONFIG.tradingFee),
    slippage: number(process.env.SCALP_VALIDATION_SLIPPAGE, DEFAULT_CONFIG.slippage),
    investmentRatio: number(process.env.SCALP_INVESTMENT_RATIO, DEFAULT_CONFIG.investmentRatio),
    rsiPeriod: number(process.env.SCALP_RSI_PERIOD, DEFAULT_CONFIG.rsiPeriod),
    rsiOversold: number(process.env.SCALP_RSI_OVERSOLD, DEFAULT_CONFIG.rsiOversold),
    rsiOverbought: number(process.env.SCALP_RSI_OVERBOUGHT, DEFAULT_CONFIG.rsiOverbought),
    oversoldLookback: number(process.env.SCALP_OVERSOLD_LOOKBACK, DEFAULT_CONFIG.oversoldLookback),
    minReboundPercent: number(process.env.SCALP_MIN_REBOUND_PERCENT, DEFAULT_CONFIG.minReboundPercent),
    minRsiRecovery: number(process.env.SCALP_MIN_RSI_RECOVERY, DEFAULT_CONFIG.minRsiRecovery),
    minVolumeRatio: number(process.env.SCALP_MIN_VOLUME_RATIO, DEFAULT_CONFIG.minVolumeRatio),
    volumeLookback: number(process.env.SCALP_VOLUME_LOOKBACK, DEFAULT_CONFIG.volumeLookback),
    minCloseStrength: number(process.env.SCALP_MIN_CLOSE_STRENGTH, DEFAULT_CONFIG.minCloseStrength),
    trendPeriod: number(process.env.SCALP_TREND_PERIOD, DEFAULT_CONFIG.trendPeriod),
    trendSlopeLookback: number(process.env.SCALP_TREND_SLOPE_LOOKBACK, DEFAULT_CONFIG.trendSlopeLookback),
    minTrendSlopePercent: number(process.env.SCALP_MIN_TREND_SLOPE_PERCENT, DEFAULT_CONFIG.minTrendSlopePercent),
    requirePreviousHighBreak: process.env.SCALP_REQUIRE_PREVIOUS_HIGH_BREAK !== 'false',
    maxSignalRangePercent: number(process.env.SCALP_MAX_SIGNAL_RANGE_PERCENT, DEFAULT_CONFIG.maxSignalRangePercent),
    minSignalRangePercent: number(process.env.SCALP_MIN_SIGNAL_RANGE_PERCENT, DEFAULT_CONFIG.minSignalRangePercent),
    maxReboundPercent: number(process.env.SCALP_MAX_REBOUND_PERCENT, DEFAULT_CONFIG.maxReboundPercent),
    requireReboundBelowOverbought: process.env.SCALP_REQUIRE_REBOUND_BELOW_OVERBOUGHT === 'true',
    signalProfile: process.env.SCALP_SIGNAL_PROFILE || DEFAULT_CONFIG.signalProfile,
    bbPeriod: number(process.env.BB_PERIOD, DEFAULT_CONFIG.bbPeriod),
    bbStdDev: number(process.env.BB_STD_DEV, DEFAULT_CONFIG.bbStdDev),
    emaPeriod: number(process.env.EMA_LONG, 60),
    maxEntryRetracePercent: number(process.env.SCALP_MAX_ENTRY_RETRACE_PERCENT, DEFAULT_CONFIG.maxEntryRetracePercent),
    maxEntryChasePercent: number(process.env.SCALP_MAX_ENTRY_CHASE_PERCENT, DEFAULT_CONFIG.maxEntryChasePercent),
    requireNextCandleBullish: process.env.SCALP_PORTFOLIO_REQUIRE_NEXT_CANDLE_BULLISH === 'true',
    breakEvenTriggerPercent: number(process.env.SCALP_BREAK_EVEN_TRIGGER_PERCENT, DEFAULT_CONFIG.breakEvenTriggerPercent),
    breakEvenOffsetPercent: number(process.env.SCALP_BREAK_EVEN_OFFSET_PERCENT, DEFAULT_CONFIG.breakEvenOffsetPercent),
    trailingActivationPercent: number(process.env.SCALP_TRAILING_ACTIVATION_PERCENT, DEFAULT_CONFIG.trailingActivationPercent),
    trailingStopPercent: number(process.env.SCALP_TRAILING_STOP_PERCENT, DEFAULT_CONFIG.trailingStopPercent),
    stopLossPercent: number(process.env.SCALP_STOP_LOSS_PERCENT, DEFAULT_CONFIG.stopLossPercent),
    takeProfitPercent: number(process.env.SCALP_TAKE_PROFIT_PERCENT, DEFAULT_CONFIG.takeProfitPercent),
    maxHoldMinutes: number(process.env.SCALP_MAX_HOLD_MINUTES, DEFAULT_CONFIG.maxHoldMinutes),
    maxLosingHoldMinutes: number(process.env.SCALP_MAX_LOSING_HOLD_MINUTES, DEFAULT_CONFIG.maxLosingHoldMinutes),
    winnerExtendMinutes: number(process.env.SCALP_WINNER_EXTEND_MINUTES, DEFAULT_CONFIG.winnerExtendMinutes),
    winnerExtendMinProfitPercent: number(process.env.SCALP_WINNER_EXTEND_MIN_PROFIT_PERCENT, DEFAULT_CONFIG.winnerExtendMinProfitPercent),
    maxEntriesPerSignalWindow: number(process.env.SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW, DEFAULT_CONFIG.maxEntriesPerSignalWindow),
    cooldownAfterLossMinutes: number(process.env.SCALP_COOLDOWN_AFTER_LOSS_MINUTES, DEFAULT_CONFIG.cooldownAfterLossMinutes),
    maxConsecutiveLosses: number(process.env.SCALP_MAX_CONSECUTIVE_LOSSES, DEFAULT_CONFIG.maxConsecutiveLosses),
    lossCircuitBreakerCount: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_COUNT, DEFAULT_CONFIG.lossCircuitBreakerCount),
    lossCircuitBreakerWindowMinutes: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES, DEFAULT_CONFIG.lossCircuitBreakerWindowMinutes),
    lossCircuitBreakerCooldownMinutes: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES, DEFAULT_CONFIG.lossCircuitBreakerCooldownMinutes),
    marketRegimeEnabled: process.env.SCALP_MARKET_REGIME_ENABLED === 'true',
    marketRegimeLookback: number(process.env.SCALP_MARKET_REGIME_LOOKBACK, DEFAULT_CONFIG.marketRegimeLookback),
    marketRegimeMinBreadth: number(process.env.SCALP_MARKET_REGIME_MIN_BREADTH, DEFAULT_CONFIG.marketRegimeMinBreadth),
    marketRegimeMinReturnPercent: number(process.env.SCALP_MARKET_REGIME_MIN_RETURN_PERCENT, DEFAULT_CONFIG.marketRegimeMinReturnPercent),
    maxPositions: number(process.env.SCALP_MAX_POSITIONS, DEFAULT_CONFIG.maxPositions),
    portfolioAllocation: number(process.env.SCALP_PORTFOLIO_ALLOCATION, DEFAULT_CONFIG.portfolioAllocation)
  };
  return mergePaperValidationConfig(
    { ...DEFAULT_CONFIG, ...envConfig, candleUnit: unit },
    snapshot,
    unit
  );
}

function summarizeResult(market, result) {
  return {
    market,
    candleCount: result.candleCount,
    dataQuality: result.dataQuality,
    metrics: {
      initialBalance: result.metrics.initialBalance,
      finalBalance: result.metrics.finalBalance,
      netProfit: result.metrics.netProfit,
      totalReturnPercent: result.metrics.totalReturnPercent,
      tradeCount: result.metrics.tradeCount,
      winningTrades: result.metrics.winningTrades,
      losingTrades: result.metrics.losingTrades,
      winRate: result.metrics.winRate,
      profitFactor: result.metrics.profitFactor,
      maxDrawdownPercent: result.metrics.maxDrawdownPercent,
      fees: result.metrics.fees,
      tradeReturnConfidence: result.metrics.tradeReturnConfidence
    },
    segmentCount: result.segments.length,
    usedSegmentCount: result.dataQuality.usedSegmentCount,
    excludedSegmentCount: result.dataQuality.excludedSegmentCount,
    unknownBoundaryPositionCount: result.unknownBoundaryPositions.length,
    unknownBoundaryPositions: result.unknownBoundaryPositions,
    segments: result.segments,
    excludedSegments: result.excludedSegments
  };
}

export function runSegmentedValidation({
  cacheFile = resolveInputFile(),
  snapshotFile = process.env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE || '',
  outputFile = process.env.SCALP_SEGMENT_OUTPUT_FILE || 'scalping_validation_segments.json',
  minimumSegmentCandles = Math.max(1, Math.floor(number(process.env.SCALP_SEGMENT_MIN_CANDLES, 200))),
  maxHistoricalCandleGapSeconds = number(process.env.SCALP_SEGMENT_MAX_GAP_SECONDS, 0)
} = {}) {
  const cache = loadCandleCache(cacheFile);
  const markets = resolveMarkets(cache);
  const snapshot = loadPaperValidationConfigSnapshot(snapshotFile);
  const config = baseConfig(snapshot);
  const results = markets.map(market => summarizeResult(
    market,
    simulateScalpingSegmented(cache[market], config, {
      minimumSegmentCandles,
      ...(maxHistoricalCandleGapSeconds > 0 ? { maxHistoricalCandleGapSeconds } : {})
    })
  ));
  const report = {
    generatedAt: new Date().toISOString(),
    study: 'segmented_single_market_scalping_diagnostic',
    validationMode: 'segmented_diagnostic_only',
    candleSource: 'cache',
    candleCacheFile: cacheFile,
    configSource: snapshot
      ? {
          type: 'paper_validation_snapshot',
          filePath: snapshot.filePath,
          sessionId: snapshot.sessionId,
          startedAt: snapshot.startedAt,
          configSnapshotComplete: snapshot.configSnapshotComplete
        }
      : { type: 'environment_or_defaults' },
    config,
    candleUnit: config.candleUnit,
    minimumSegmentCandles,
    maxHistoricalCandleGapSeconds: maxHistoricalCandleGapSeconds > 0
      ? maxHistoricalCandleGapSeconds
      : null,
    markets,
    results,
    promoted: false,
    promotionReason: 'segmented_diagnostic_is_not_eligible_for_live_promotion',
    note: 'gap 경계의 missing path를 채우지 않습니다. segment 끝의 미청산 포지션은 unknown으로 제외하며, 이 report는 튜닝 참고용일 뿐 historical promotion gate나 live order를 승인하지 않습니다.'
  };
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const report = runSegmentedValidation();
    const closed = report.results.reduce((sum, result) => sum + result.metrics.tradeCount, 0);
    const unknown = report.results.reduce((sum, result) => sum + result.unknownBoundaryPositionCount, 0);
    console.log('\n📊 segmented scalping diagnostic');
    console.log(`cache: ${report.candleCacheFile}`);
    console.log(`market: ${report.markets.length}개 · candle: ${report.candleUnit}분봉 · minimum segment: ${report.minimumSegmentCandles}개`);
    console.log(`청산: ${closed}건 · unknown boundary: ${unknown}건`);
    console.log(`report: ${process.env.SCALP_SEGMENT_OUTPUT_FILE || 'scalping_validation_segments.json'}`);
    console.log('판정: 진단 전용 · historical/live promotion 불가');
  } catch (error) {
    console.error('❌ segmented scalping diagnostic 오류:', error.message);
    process.exitCode = 1;
  }
}
