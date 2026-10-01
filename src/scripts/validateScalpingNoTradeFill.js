import dotenv from 'dotenv';
import fs from 'node:fs';
import {
  DEFAULT_CONFIG
} from '../backtest/scalpingBacktest.js';
import {
  walkForwardValidate
} from '../backtest/scalpingTuning.js';;
import { resolveMaxCandleAgeSeconds } from '../risk/candleFreshness.js';
import { fillNoTradeCandleGaps } from '../research/historicalCandleSeries.js';
import {
  loadPaperValidationConfigSnapshot,
  mergePaperValidationConfig
} from '../research/scalpingValidationConfig.js';
import { envBool, envList, envNumber, envRaw, envString } from '../config/envConfig.js';

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
    throw new Error(`raw candle cache를 읽을 수 없습니다 (${filePath}): ${error.message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`raw candle cache 형식이 잘못되었습니다: ${filePath}`);
  }
  return parsed;
}

function resolveMarkets(cache) {
  const explicit = envList('SCALP_NO_TRADE_FILL_MARKETS', [])
    .map(market => market.toUpperCase());
  const markets = explicit.length > 0 ? explicit : Object.keys(cache);
  if (markets.length === 0) throw new Error('raw candle cache에 시장이 없습니다.');
  return markets;
}

function baseConfig(candleUnit) {
  return {
    ...DEFAULT_CONFIG,
    initialBalance: envNumber('SCALP_VALIDATION_INITIAL_BALANCE', DEFAULT_CONFIG.initialBalance),
    tradingFee: envNumber('SCALP_VALIDATION_FEE', DEFAULT_CONFIG.tradingFee),
    slippage: envNumber('SCALP_VALIDATION_SLIPPAGE', DEFAULT_CONFIG.slippage),
    investmentRatio: envNumber('SCALP_INVESTMENT_RATIO', DEFAULT_CONFIG.investmentRatio),
    maxCandleAgeSeconds: resolveMaxCandleAgeSeconds(
      envNumber('SCALP_MAX_CANDLE_AGE_SECONDS', 0),
      candleUnit
    ),
    rsiPeriod: envNumber('SCALP_RSI_PERIOD', DEFAULT_CONFIG.rsiPeriod),
    rsiOversold: envNumber('SCALP_RSI_OVERSOLD', DEFAULT_CONFIG.rsiOversold),
    rsiOverbought: envNumber('SCALP_RSI_OVERBOUGHT', DEFAULT_CONFIG.rsiOverbought),
    oversoldLookback: envNumber('SCALP_OVERSOLD_LOOKBACK', DEFAULT_CONFIG.oversoldLookback),
    minReboundPercent: envNumber('SCALP_MIN_REBOUND_PERCENT', DEFAULT_CONFIG.minReboundPercent),
    minRsiRecovery: envNumber('SCALP_MIN_RSI_RECOVERY', DEFAULT_CONFIG.minRsiRecovery),
    minVolumeRatio: envNumber('SCALP_MIN_VOLUME_RATIO', DEFAULT_CONFIG.minVolumeRatio),
    volumeLookback: envNumber('SCALP_VOLUME_LOOKBACK', DEFAULT_CONFIG.volumeLookback),
    minCloseStrength: envNumber('SCALP_MIN_CLOSE_STRENGTH', DEFAULT_CONFIG.minCloseStrength),
    trendPeriod: envNumber('SCALP_TREND_PERIOD', DEFAULT_CONFIG.trendPeriod),
    trendSlopeLookback: envNumber('SCALP_TREND_SLOPE_LOOKBACK', DEFAULT_CONFIG.trendSlopeLookback),
    minTrendSlopePercent: envNumber('SCALP_MIN_TREND_SLOPE_PERCENT', DEFAULT_CONFIG.minTrendSlopePercent),
    requirePreviousHighBreak: envBool('SCALP_REQUIRE_PREVIOUS_HIGH_BREAK', true),
    maxSignalRangePercent: envNumber('SCALP_MAX_SIGNAL_RANGE_PERCENT', DEFAULT_CONFIG.maxSignalRangePercent),
    minSignalRangePercent: envNumber('SCALP_MIN_SIGNAL_RANGE_PERCENT', DEFAULT_CONFIG.minSignalRangePercent),
    maxReboundPercent: envNumber('SCALP_MAX_REBOUND_PERCENT', DEFAULT_CONFIG.maxReboundPercent),
    requireReboundBelowOverbought: envBool('SCALP_REQUIRE_REBOUND_BELOW_OVERBOUGHT', false),
    signalProfile: envString('SCALP_SIGNAL_PROFILE', DEFAULT_CONFIG.signalProfile),
    bbPeriod: envNumber('BB_PERIOD', DEFAULT_CONFIG.bbPeriod),
    bbStdDev: envNumber('BB_STD_DEV', DEFAULT_CONFIG.bbStdDev),
    emaPeriod: envNumber('EMA_LONG', 60),
    maxEntryRetracePercent: envNumber('SCALP_MAX_ENTRY_RETRACE_PERCENT', DEFAULT_CONFIG.maxEntryRetracePercent),
    maxEntryChasePercent: envNumber('SCALP_MAX_ENTRY_CHASE_PERCENT', DEFAULT_CONFIG.maxEntryChasePercent),
    requireNextCandleBullish: envBool('SCALP_PORTFOLIO_REQUIRE_NEXT_CANDLE_BULLISH', false),
    breakEvenTriggerPercent: envNumber('SCALP_BREAK_EVEN_TRIGGER_PERCENT', DEFAULT_CONFIG.breakEvenTriggerPercent),
    breakEvenOffsetPercent: envNumber('SCALP_BREAK_EVEN_OFFSET_PERCENT', DEFAULT_CONFIG.breakEvenOffsetPercent),
    trailingActivationPercent: envNumber('SCALP_TRAILING_ACTIVATION_PERCENT', DEFAULT_CONFIG.trailingActivationPercent),
    trailingStopPercent: envNumber('SCALP_TRAILING_STOP_PERCENT', DEFAULT_CONFIG.trailingStopPercent),
    stopLossPercent: envNumber('SCALP_STOP_LOSS_PERCENT', DEFAULT_CONFIG.stopLossPercent),
    takeProfitPercent: envNumber('SCALP_TAKE_PROFIT_PERCENT', DEFAULT_CONFIG.takeProfitPercent),
    maxHoldMinutes: envNumber('SCALP_MAX_HOLD_MINUTES', DEFAULT_CONFIG.maxHoldMinutes),
    maxLosingHoldMinutes: envNumber('SCALP_MAX_LOSING_HOLD_MINUTES', DEFAULT_CONFIG.maxLosingHoldMinutes),
    winnerExtendMinutes: envNumber('SCALP_WINNER_EXTEND_MINUTES', DEFAULT_CONFIG.winnerExtendMinutes),
    winnerExtendMinProfitPercent: envNumber('SCALP_WINNER_EXTEND_MIN_PROFIT_PERCENT', DEFAULT_CONFIG.winnerExtendMinProfitPercent),
    maxEntriesPerSignalWindow: envNumber('SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW', DEFAULT_CONFIG.maxEntriesPerSignalWindow),
    cooldownAfterLossMinutes: envNumber('SCALP_COOLDOWN_AFTER_LOSS_MINUTES', DEFAULT_CONFIG.cooldownAfterLossMinutes),
    maxConsecutiveLosses: envNumber('SCALP_MAX_CONSECUTIVE_LOSSES', DEFAULT_CONFIG.maxConsecutiveLosses),
    lossCircuitBreakerCount: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_COUNT', DEFAULT_CONFIG.lossCircuitBreakerCount),
    lossCircuitBreakerWindowMinutes: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES', DEFAULT_CONFIG.lossCircuitBreakerWindowMinutes),
    lossCircuitBreakerCooldownMinutes: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES', DEFAULT_CONFIG.lossCircuitBreakerCooldownMinutes),
    marketRegimeEnabled: envBool('SCALP_MARKET_REGIME_ENABLED', false),
    marketRegimeLookback: envNumber('SCALP_MARKET_REGIME_LOOKBACK', DEFAULT_CONFIG.marketRegimeLookback),
    marketRegimeMinBreadth: envNumber('SCALP_MARKET_REGIME_MIN_BREADTH', DEFAULT_CONFIG.marketRegimeMinBreadth),
    marketRegimeMinReturnPercent: envNumber('SCALP_MARKET_REGIME_MIN_RETURN_PERCENT', DEFAULT_CONFIG.marketRegimeMinReturnPercent),
    maxPositions: envNumber('SCALP_MAX_POSITIONS', DEFAULT_CONFIG.maxPositions),
    portfolioAllocation: envNumber('SCALP_PORTFOLIO_ALLOCATION', DEFAULT_CONFIG.portfolioAllocation),
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
  inputFile = envRaw('SCALP_NO_TRADE_FILL_CANDLES_FILE') || process.argv[2],
  outputFile = envString('SCALP_NO_TRADE_FILL_OUTPUT_FILE', 'scalping_validation_no_trade_fill.json'),
  filledCandleCacheOutputFile = envString('SCALP_NO_TRADE_FILL_CACHE_OUTPUT_FILE', ''),
  snapshotFile = envString('SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE', ''),
  maxFillIntervals = Math.max(
    0,
    Math.floor(envNumber('SCALP_NO_TRADE_FILL_MAX_INTERVALS', Number.MAX_SAFE_INTEGER))
  )
} = {}) {
  const cache = loadCandleCache(inputFile);
  const markets = resolveMarkets(cache);
  const snapshot = loadPaperValidationConfigSnapshot(snapshotFile);
  const explicitUnit = envRaw('SCALP_NO_TRADE_FILL_CANDLE_UNIT');
  const candleUnit = explicitUnit === undefined || explicitUnit === ''
    ? number(snapshot?.config?.candleUnit, envNumber('SCALP_CANDLE_UNIT', 1))
    : number(explicitUnit, 1);
  const config = mergePaperValidationConfig(baseConfig(candleUnit), snapshot, candleUnit);
  const requireStatisticalConfidence = envBool('SCALP_NO_TRADE_FILL_REQUIRE_STATISTICAL_CONFIDENCE', true);
  const validationOptions = {
    grid: {},
    trainRatio: envNumber('SCALP_VALIDATION_TRAIN_RATIO', 0.7),
    minimumCandles: envNumber('SCALP_VALIDATION_MIN_CANDLES', 2_000),
    minimumTrainingTrades: envNumber('SCALP_VALIDATION_MIN_TRAINING_TRADES', 3),
    minimumTrainingProfitFactor: envNumber('SCALP_VALIDATION_MIN_TRAINING_PROFIT_FACTOR', 1),
    minimumTrainingReturnPercent: envNumber('SCALP_VALIDATION_MIN_TRAINING_RETURN_PERCENT', 0),
    minimumValidationTrades: envNumber('SCALP_VALIDATION_MIN_TRADES', 10),
    minimumProfitFactor: envNumber('SCALP_VALIDATION_MIN_PROFIT_FACTOR', 1.05),
    minimumReturnPercent: envNumber('SCALP_VALIDATION_MIN_RETURN_PERCENT', 0.1),
    maximumDrawdownPercent: envNumber('SCALP_VALIDATION_MAX_DRAWDOWN', 15),
    requireStatisticalConfidence,
    minimumTrainingConfidenceTrades: envNumber('SCALP_VALIDATION_MIN_TRAINING_CONFIDENCE_TRADES', 10),
    minimumValidationConfidenceTrades: envNumber('SCALP_VALIDATION_MIN_CONFIDENCE_TRADES', 20),
    minimumConfidenceLowerBoundPercent: envNumber('SCALP_VALIDATION_MIN_CONFIDENCE_LOWER_PERCENT', 0)
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
    console.log(`\n💾 report: ${envString('SCALP_NO_TRADE_FILL_OUTPUT_FILE', 'scalping_validation_no_trade_fill.json')}`);
    console.log('판정: 진단 전용 · historical/live promotion 불가');
  } catch (error) {
    console.error('❌ no-trade flat-fill diagnostic 오류:', error.message);
    process.exitCode = 1;
  }
}
