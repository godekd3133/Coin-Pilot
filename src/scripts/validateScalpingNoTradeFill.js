import dotenv from 'dotenv';
import fs from 'node:fs';
import {
  DEFAULT_CONFIG,
  walkForwardValidate
} from '../backtest/scalpingBacktest.js';
import { resolveMaxCandleAgeSeconds } from '../risk/candleFreshness.js';
import { fillNoTradeCandleGaps } from '../research/historicalCandleSeries.js';
import {
  loadPaperValidationConfigSnapshot,
  mergePaperValidationConfig
} from '../research/scalpingValidationConfig.js';

dotenv.config();

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function loadCandleCache(filePath) {
  if (!filePath) {
    throw new Error(
      '무체결 gap fill diagnostic은 raw candle cache가 필요합니다. ' +
      'SCALP_NO_TRADE_FILL_CANDLES_FILE 또는 첫 번째 인자로 cache 경로를 지정하세요.'
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`지정한 raw candle cache가 없습니다: ${filePath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`raw candle cache를 읽을 수 없습니다 (${filePath}): ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`raw candle cache 형식이 잘못되었습니다: ${filePath}`);
  }
  return parsed;
}

function resolveMarkets(cache) {
  const explicit = (process.env.SCALP_NO_TRADE_FILL_MARKETS || '')
    .split(',')
    .map(market => market.trim().toUpperCase())
    .filter(Boolean);
  const markets = explicit.length > 0 ? explicit : Object.keys(cache);
  if (markets.length === 0) throw new Error('raw candle cache에 시장이 없습니다.');
  return markets;
}

function baseConfig(candleUnit) {
  return {
    ...DEFAULT_CONFIG,
    initialBalance: number(process.env.SCALP_VALIDATION_INITIAL_BALANCE, DEFAULT_CONFIG.initialBalance),
    tradingFee: number(process.env.SCALP_VALIDATION_FEE, DEFAULT_CONFIG.tradingFee),
    slippage: number(process.env.SCALP_VALIDATION_SLIPPAGE, DEFAULT_CONFIG.slippage),
    investmentRatio: number(process.env.SCALP_INVESTMENT_RATIO, DEFAULT_CONFIG.investmentRatio),
    maxCandleAgeSeconds: resolveMaxCandleAgeSeconds(
      number(process.env.SCALP_MAX_CANDLE_AGE_SECONDS, 0),
      candleUnit
    ),
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
    portfolioAllocation: number(process.env.SCALP_PORTFOLIO_ALLOCATION, DEFAULT_CONFIG.portfolioAllocation),
    candleUnit
  };
}

function summarizeMetrics(validation) {
  const metrics = validation?.validation;
  if (!metrics) return null;
  return {
    totalReturnPercent: metrics.totalReturnPercent,
    netProfit: metrics.netProfit,
    tradeCount: metrics.tradeCount,
    winningTrades: metrics.winningTrades,
    losingTrades: metrics.losingTrades,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    maxDrawdownPercent: metrics.maxDrawdownPercent,
    tradeReturnConfidence: metrics.tradeReturnConfidence
  };
}

export function runNoTradeFilledValidation({
  inputFile = process.env.SCALP_NO_TRADE_FILL_CANDLES_FILE || process.argv[2],
  outputFile = process.env.SCALP_NO_TRADE_FILL_OUTPUT_FILE || 'scalping_validation_no_trade_fill.json',
  filledCandleCacheOutputFile = process.env.SCALP_NO_TRADE_FILL_CACHE_OUTPUT_FILE || '',
  snapshotFile = process.env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE || '',
  maxFillIntervals = Math.max(
    0,
    Math.floor(number(process.env.SCALP_NO_TRADE_FILL_MAX_INTERVALS, Number.MAX_SAFE_INTEGER))
  )
} = {}) {
  const cache = loadCandleCache(inputFile);
  const markets = resolveMarkets(cache);
  const snapshot = loadPaperValidationConfigSnapshot(snapshotFile);
  const explicitUnit = process.env.SCALP_NO_TRADE_FILL_CANDLE_UNIT;
  const candleUnit = explicitUnit === undefined || explicitUnit === ''
    ? number(snapshot?.config?.candleUnit, number(process.env.SCALP_CANDLE_UNIT, 1))
    : number(explicitUnit, 1);
  const config = mergePaperValidationConfig(baseConfig(candleUnit), snapshot, candleUnit);
  const requireStatisticalConfidence = process.env.SCALP_NO_TRADE_FILL_REQUIRE_STATISTICAL_CONFIDENCE !== 'false';
  const validationOptions = {
    grid: {},
    trainRatio: number(process.env.SCALP_VALIDATION_TRAIN_RATIO, 0.7),
    minimumCandles: number(process.env.SCALP_VALIDATION_MIN_CANDLES, 2_000),
    minimumTrainingTrades: number(process.env.SCALP_VALIDATION_MIN_TRAINING_TRADES, 3),
    minimumTrainingProfitFactor: number(process.env.SCALP_VALIDATION_MIN_TRAINING_PROFIT_FACTOR, 1),
    minimumTrainingReturnPercent: number(process.env.SCALP_VALIDATION_MIN_TRAINING_RETURN_PERCENT, 0),
    minimumValidationTrades: number(process.env.SCALP_VALIDATION_MIN_TRADES, 10),
    minimumProfitFactor: number(process.env.SCALP_VALIDATION_MIN_PROFIT_FACTOR, 1.05),
    minimumReturnPercent: number(process.env.SCALP_VALIDATION_MIN_RETURN_PERCENT, 0.1),
    maximumDrawdownPercent: number(process.env.SCALP_VALIDATION_MAX_DRAWDOWN, 15),
    requireStatisticalConfidence,
    minimumTrainingConfidenceTrades: number(process.env.SCALP_VALIDATION_MIN_TRAINING_CONFIDENCE_TRADES, 10),
    minimumValidationConfidenceTrades: number(process.env.SCALP_VALIDATION_MIN_CONFIDENCE_TRADES, 20),
    minimumConfidenceLowerBoundPercent: number(process.env.SCALP_VALIDATION_MIN_CONFIDENCE_LOWER_PERCENT, 0)
  };
  const results = [];
  const filledCache = {};

  for (const market of markets) {
    const rawCandles = cache[market];
    if (!Array.isArray(rawCandles)) {
      throw new Error(`raw candle cache에 ${market} 데이터가 없습니다. 시장별 window를 섞지 않고 중단합니다.`);
    }

    const filled = fillNoTradeCandleGaps(rawCandles, candleUnit, { maxFillIntervals });
    filledCache[market] = filled.candles;
    const validation = filled.dataQuality.validForReplay
      ? walkForwardValidate(filled.candles, config, validationOptions)
      : {
          promoted: false,
          reason: 'no_trade_fill_data_quality_failed',
          candleCount: filled.candles.length,
          dataQuality: filled.dataQuality.continuityAfterFill
        };
    results.push({
      market,
      rawCandleCount: filled.dataQuality.rawCandleCount,
      filledCandleCount: filled.dataQuality.filledCandleCount,
      syntheticNoTradeCount: filled.dataQuality.syntheticNoTradeCount,
      dataQuality: filled.dataQuality,
      rawValidationPromoted: validation.promoted === true,
      validation: {
        ...validation,
        // This lane is never eligible for historical/live promotion even if
        // the fixed-config metrics happen to pass their screening gates.
        promoted: false,
        diagnosticReason: validation.promoted === true
          ? 'no_trade_flat_fill_is_research_only'
          : validation.reason,
        metrics: summarizeMetrics(validation)
      }
    });
  }

  if (filledCandleCacheOutputFile) {
    fs.writeFileSync(filledCandleCacheOutputFile, JSON.stringify(filledCache), 'utf8');
  }

  const report = {
    generatedAt: new Date().toISOString(),
    study: 'no_trade_flat_fill_scalping_diagnostic',
    validationMode: 'fixed_config_no_trade_flat_fill_research_only',
    candleSource: 'raw_cache_with_explicit_no_trade_fill',
    candleCacheFile: inputFile,
    filledCandleCacheOutputFile: filledCandleCacheOutputFile || null,
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
    candleUnit,
    maxFillIntervals,
    markets,
    results,
    promoted: false,
    promotionReason: 'no_trade_flat_fill_is_research_only_and_never_authorizes_live_orders',
    note: 'Upbit은 무체결 구간의 분봉을 생략합니다. 이 lane은 해당 구간을 전일 종가 고정·거래량 0으로 명시적으로 채워 elapsed time을 보존하지만, synthetic candle을 사용하므로 기본 historical/live promotion gate와 분리합니다.'
  };
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const report = runNoTradeFilledValidation();
    for (const result of report.results) {
      const metrics = result.validation.metrics;
      console.log(`\n${result.market}: raw ${result.rawCandleCount} → filled ${result.filledCandleCount} (synthetic ${result.syntheticNoTradeCount})`);
      if (metrics) {
        console.log(`  holdout ${metrics.totalReturnPercent.toFixed(4)}% / ${metrics.tradeCount} trades / PF ${Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : '∞'} / MDD ${metrics.maxDrawdownPercent.toFixed(4)}%`);
      }
      console.log(`  data quality ${result.dataQuality.validForReplay ? 'OK' : 'FAIL'} · diagnostic only`);
    }
    console.log(`\n💾 report: ${process.env.SCALP_NO_TRADE_FILL_OUTPUT_FILE || 'scalping_validation_no_trade_fill.json'}`);
    console.log('판정: 진단 전용 · historical/live promotion 불가');
  } catch (error) {
    console.error('❌ no-trade flat-fill diagnostic 오류:', error.message);
    process.exitCode = 1;
  }
}
