import dotenv from 'dotenv';
import fs from 'fs';
import UpbitAPI from '../api/upbit.js';
import {
  walkForwardValidate
} from '../backtest/scalpingTuning.js';;
import { resolveMaxCandleAgeSeconds } from '../risk/candleFreshness.js';
import { pathToFileURL } from 'node:url';
import { envBool, envNumber, envString } from '../config/envConfig.js';

dotenv.config();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function getHistoricalCandles(upbit, market, unit, totalCount) {
  const candles = [];
  let to = null;

  while (candles.length < totalCount) {
    const count = Math.min(200, totalCount - candles.length);
    let batch = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const batchResult = to
          ? await upbit.getMinuteCandles(market, unit, count, { to })
          : await upbit.getMinuteCandles(market, unit, count);
        batch = batchResult;
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await sleep(1000 * (attempt + 1));
      }
    }

    if (!Array.isArray(batch) || batch.length === 0) break;
    candles.push(...batch);
    const oldest = batch.at(-1);
    to = oldest?.candle_date_time_utc;
    if (!to || batch.length < count) break;
    await sleep(150);
  }

  const byTimestamp = new Map();
  for (const candle of candles) {
    const key = candle?.candle_date_time_utc || candle?.candle_date_time_kst || candle?.timestamp;
    if (key !== undefined) byTimestamp.set(String(key), candle);
  }
  return Array.from(byTimestamp.values());
}

function shadowConfig() {
  return {
    initialBalance: envNumber('SCALP_VALIDATION_INITIAL_BALANCE', 1_000_000),
    tradingFee: envNumber('SCALP_VALIDATION_FEE', 0.0005),
    slippage: envNumber('SCALP_VALIDATION_SLIPPAGE', 0.001),
    investmentRatio: envNumber('SCALP_INVESTMENT_RATIO', 0.02),
    maxCandleAgeSeconds: resolveMaxCandleAgeSeconds(
      envNumber('SCALP_MAX_CANDLE_AGE_SECONDS', 0),
      envNumber('SCALP_VALIDATION_CANDLE_UNIT', 1)
    ),
    rsiPeriod: envNumber('SCALP_RSI_PERIOD', envNumber('RSI_PERIOD', 14)),
    rsiOversold: envNumber('SCALP_RSI_OVERSOLD', envNumber('RSI_OVERSOLD', 30)),
    rsiOverbought: envNumber('SCALP_RSI_OVERBOUGHT', envNumber('RSI_OVERBOUGHT', 70)),
    oversoldLookback: envNumber('SCALP_OVERSOLD_LOOKBACK', 1),
    minReboundPercent: 0.1,
    minRsiRecovery: 1,
    minVolumeRatio: 0,
    volumeLookback: envNumber('SCALP_VOLUME_LOOKBACK', 20),
    minCloseStrength: 0,
    trendPeriod: envNumber('SCALP_TREND_PERIOD', 30),
    trendSlopeLookback: envNumber('SCALP_TREND_SLOPE_LOOKBACK', 3),
    minTrendSlopePercent: -100,
    requirePreviousHighBreak: false,
    maxSignalRangePercent: envNumber('SCALP_MAX_SIGNAL_RANGE_PERCENT', 0),
    minSignalRangePercent: envNumber('SCALP_MIN_SIGNAL_RANGE_PERCENT', 0),
    maxReboundPercent: envNumber('SCALP_MAX_REBOUND_PERCENT', 0),
    marketRegimeEnabled: envBool('SCALP_MARKET_REGIME_ENABLED', false),
    marketRegimeLookback: envNumber('SCALP_MARKET_REGIME_LOOKBACK', 5),
    marketRegimeMinBreadth: envNumber('SCALP_MARKET_REGIME_MIN_BREADTH', 0.5),
    marketRegimeMinReturnPercent: envNumber('SCALP_MARKET_REGIME_MIN_RETURN_PERCENT', -0.2),
    requireReboundBelowOverbought: envBool('SCALP_REQUIRE_REBOUND_BELOW_OVERBOUGHT', false),
    signalProfile: 'rsi_rebound',
    bbPeriod: 20,
    bbStdDev: 2,
    emaPeriod: 20,
    maxEntryRetracePercent: 0.25,
    maxEntryChasePercent: 0.35,
    breakEvenTriggerPercent: envNumber('SCALP_BREAK_EVEN_TRIGGER_PERCENT', 0),
    breakEvenOffsetPercent: envNumber('SCALP_BREAK_EVEN_OFFSET_PERCENT', 0.05),
    trailingActivationPercent: envNumber('SCALP_TRAILING_ACTIVATION_PERCENT', 0),
    trailingStopPercent: envNumber('SCALP_TRAILING_STOP_PERCENT', 0),
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8,
    maxHoldMinutes: 30,
    maxLosingHoldMinutes: envNumber('SCALP_MAX_LOSING_HOLD_MINUTES', 0),
    winnerExtendMinutes: envNumber('SCALP_WINNER_EXTEND_MINUTES', 0),
    winnerExtendMinProfitPercent: envNumber('SCALP_WINNER_EXTEND_MIN_PROFIT_PERCENT', 0),
    maxEntriesPerSignalWindow: envNumber('SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW', 0),
    maxRiskDataGapSeconds: envNumber('SCALP_MAX_RISK_DATA_GAP_SECONDS', 30),
    maxAnalysisDataGapSeconds: envNumber('SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS', 60),
    cooldownAfterLossMinutes: 15,
    maxConsecutiveLosses: 3,
    lossCircuitBreakerCount: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_COUNT', 0),
    lossCircuitBreakerWindowMinutes: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES', 30),
    lossCircuitBreakerCooldownMinutes: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES', 60),
    candleUnit: 1
  };
}

async function main() {
  const market = (envString('SHADOW_VALIDATION_MARKET', 'KRW-KAT')).trim().toUpperCase();
  const unit = envNumber('SCALP_VALIDATION_CANDLE_UNIT', 1);
  const candleCount = envNumber('SCALP_VALIDATION_CANDLE_COUNT', 10080);
  const config = shadowConfig();
  const upbit = new UpbitAPI('', '');
  const candleCacheFile = envString('SHADOW_VALIDATION_CANDLES_FILE', null);
  let cachedCandles = null;
  if (candleCacheFile && fs.existsSync(candleCacheFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candleCacheFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cachedCandles = parsed[market];
      }
      console.log(`\n📦 동일 윈도우 candle cache 확인: ${candleCacheFile}`);
    } catch (error) {
      console.log(`\n⚠️ candle cache 로드 실패, 새로 수집합니다: ${error.message}`);
    }
  }

  console.log(`\n🧪 relaxed shadow 후보 holdout 검증: ${market}`);
  console.log(`캔들: ${unit}분봉 ${candleCount}개 / 고가돌파·거래량·종가강도·추세 필터 완화`);
  const fromCache = Array.isArray(cachedCandles) && cachedCandles.length > 0;
  const candles = fromCache
    ? cachedCandles
    : await getHistoricalCandles(upbit, market, unit, candleCount);
  console.log(`${fromCache ? 'cache 사용' : '수집 완료'}: ${candles.length}개`);

  const validation = walkForwardValidate(candles, config, {
    grid: {},
    trainRatio: envNumber('SCALP_VALIDATION_TRAIN_RATIO', 0.7),
    minimumCandles: envNumber('SCALP_VALIDATION_MIN_CANDLES', 2000),
    minimumTrainingTrades: envNumber('SCALP_VALIDATION_MIN_TRAINING_TRADES', 3),
    minimumTrainingProfitFactor: envNumber('SCALP_VALIDATION_MIN_TRAINING_PROFIT_FACTOR', 1),
    minimumTrainingReturnPercent: envNumber('SCALP_VALIDATION_MIN_TRAINING_RETURN_PERCENT', 0),
    minimumValidationTrades: envNumber('SCALP_VALIDATION_MIN_TRADES', 3),
    minimumProfitFactor: envNumber('SCALP_VALIDATION_MIN_PROFIT_FACTOR', 1.05),
    minimumReturnPercent: envNumber('SCALP_VALIDATION_MIN_RETURN_PERCENT', 0.1),
    maximumDrawdownPercent: envNumber('SCALP_VALIDATION_MAX_DRAWDOWN', 15)
  });

  const report = {
    generatedAt: new Date().toISOString(),
    study: 'relaxed_shadow_cohort',
    strategyMode: 'oversold_reaction_scalping',
    market,
    candleUnit: unit,
    candleCount,
    fetchedCandles: candles.length,
    candleSource: fromCache ? 'cache' : 'upbit',
    config,
    validation,
    promotion: {
      promoted: false,
      reason: 'diagnostic_shadow_only_never_authorizes_live_orders'
    },
    note: 'This report evaluates the relaxed shadow cohort only. It never changes runtime filters or live-order eligibility.'
  };

  const outputFile = envString('SHADOW_VALIDATION_OUTPUT_FILE', 'scalping_validation_shadow.json');
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n💾 shadow 검증 리포트 저장: ${outputFile}`);
  console.log(`검증 수익률: ${validation.validation?.totalReturnPercent?.toFixed(4) ?? 'n/a'}%`);
  console.log(`검증 거래: ${validation.validation?.tradeCount ?? 0}회 / PF ${Number.isFinite(validation.validation?.profitFactor) ? validation.validation.profitFactor.toFixed(2) : '∞'}`);
  console.log('승격: 항상 보류 (diagnostic shadow 전용)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error('❌ shadow 검증 오류:', error.message);
    process.exitCode = 1;
  });
}
