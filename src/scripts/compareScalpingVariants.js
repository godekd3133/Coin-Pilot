import dotenv from 'dotenv';
import fs from 'fs';
import axios from 'axios';
import UpbitAPI from '../api/upbit.js';
import { walkForwardValidate } from '../backtest/scalpingBacktest.js';
import { resolveMaxCandleAgeSeconds } from '../risk/candleFreshness.js';

dotenv.config();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

/**
 * Compare candidate contracts on the exact same candle window. This is a
 * research report only: it never writes the live promotion report and never
 * changes runtime settings.
 */
export const SCALPING_VARIANTS = {
  baseline: {},
  volume_15: { minVolumeRatio: 1.5 },
  rebound_25: { minReboundPercent: 0.25 },
  rebound_50: { minReboundPercent: 0.5 },
  range_floor_20: { minSignalRangePercent: 0.2 },
  range_floor_40: { minSignalRangePercent: 0.4 },
  volume_15_rebound_50_range_20: {
    minVolumeRatio: 1.5,
    minReboundPercent: 0.5,
    minSignalRangePercent: 0.2
  },
  volume_15_rebound_50_range_40: {
    minVolumeRatio: 1.5,
    minReboundPercent: 0.5,
    minSignalRangePercent: 0.4
  },
  volume_15_rebound_50: { minVolumeRatio: 1.5, minReboundPercent: 0.5 },
  rsi_30_volume_15_rebound_50: { rsiOversold: 30, minVolumeRatio: 1.5, minReboundPercent: 0.5 },
  rsi_25_volume_15_rebound_50: { rsiOversold: 25, minVolumeRatio: 1.5, minReboundPercent: 0.5 },
  fast_exit: { stopLossPercent: 0.8, takeProfitPercent: 1.0 },
  tight_exit: { stopLossPercent: 0.8, takeProfitPercent: 1.2 },
  balanced_exit: { stopLossPercent: 1.2, takeProfitPercent: 1.2 },
  max_hold_5m: { maxHoldMinutes: 5 },
  max_hold_15m: { maxHoldMinutes: 15 },
  max_hold_30m: { maxHoldMinutes: 30 },
  loss_timeout_5m: { maxLosingHoldMinutes: 5 },
  loss_timeout_10m: { maxLosingHoldMinutes: 10 },
  loss_circuit_3: {
    lossCircuitBreakerCount: 3,
    lossCircuitBreakerWindowMinutes: 30,
    lossCircuitBreakerCooldownMinutes: 60
  },
  bb_reclaim: { signalProfile: 'bb_reclaim' },
  trend_rebound: { signalProfile: 'trend_rebound' },
  momentum_breakout: { signalProfile: 'momentum_breakout' },
  protective_be_trailing: {
    breakEvenTriggerPercent: 0.5,
    breakEvenOffsetPercent: 0.05,
    trailingActivationPercent: 0.8,
    trailingStopPercent: 0.4
  },
  volume_15_protective: {
    minVolumeRatio: 1.5,
    breakEvenTriggerPercent: 0.5,
    breakEvenOffsetPercent: 0.05,
    trailingActivationPercent: 0.8,
    trailingStopPercent: 0.4
  }
};

function getBaseConfig() {
  return {
    initialBalance: number(process.env.SCALP_VALIDATION_INITIAL_BALANCE, 1_000_000),
    tradingFee: 0.0005,
    slippage: number(process.env.SCALP_VALIDATION_SLIPPAGE, 0.001),
    investmentRatio: number(process.env.SCALP_INVESTMENT_RATIO, 0.02),
    maxCandleAgeSeconds: resolveMaxCandleAgeSeconds(
      number(process.env.SCALP_MAX_CANDLE_AGE_SECONDS, 0),
      number(process.env.SCALP_VALIDATION_CANDLE_UNIT, 1)
    ),
    rsiPeriod: number(process.env.SCALP_RSI_PERIOD, number(process.env.RSI_PERIOD, 14)),
    rsiOversold: number(process.env.SCALP_RSI_OVERSOLD, number(process.env.RSI_OVERSOLD, 30)),
    rsiOverbought: number(process.env.SCALP_RSI_OVERBOUGHT, number(process.env.RSI_OVERBOUGHT, 70)),
    oversoldLookback: number(process.env.SCALP_OVERSOLD_LOOKBACK, 1),
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
    maxEntryRetracePercent: number(process.env.SCALP_MAX_ENTRY_RETRACE_PERCENT, 0.25),
    maxEntryChasePercent: number(process.env.SCALP_MAX_ENTRY_CHASE_PERCENT, 0.35),
    breakEvenTriggerPercent: number(process.env.SCALP_BREAK_EVEN_TRIGGER_PERCENT, 0),
    breakEvenOffsetPercent: number(process.env.SCALP_BREAK_EVEN_OFFSET_PERCENT, 0.05),
    trailingActivationPercent: number(process.env.SCALP_TRAILING_ACTIVATION_PERCENT, 0),
    trailingStopPercent: number(process.env.SCALP_TRAILING_STOP_PERCENT, 0),
    stopLossPercent: number(process.env.SCALP_STOP_LOSS_PERCENT, 1.2),
    takeProfitPercent: number(process.env.SCALP_TAKE_PROFIT_PERCENT, 1.8),
    maxHoldMinutes: number(process.env.SCALP_MAX_HOLD_MINUTES, 30),
    maxLosingHoldMinutes: number(process.env.SCALP_MAX_LOSING_HOLD_MINUTES, 0),
    maxEntriesPerSignalWindow: number(process.env.SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW, 0),
    maxRiskDataGapSeconds: number(process.env.SCALP_MAX_RISK_DATA_GAP_SECONDS, 30),
    cooldownAfterLossMinutes: number(process.env.SCALP_COOLDOWN_AFTER_LOSS_MINUTES, 15),
    maxConsecutiveLosses: number(process.env.SCALP_MAX_CONSECUTIVE_LOSSES, 3),
    lossCircuitBreakerCount: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_COUNT, 0),
    lossCircuitBreakerWindowMinutes: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES, 30),
    lossCircuitBreakerCooldownMinutes: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES, 60),
    candleUnit: number(process.env.SCALP_VALIDATION_CANDLE_UNIT, 1)
  };
}

async function getHistoricalCandles(upbit, market, unit, totalCount) {
  const candles = [];
  let to = null;

  while (candles.length < totalCount) {
    const count = Math.min(200, totalCount - candles.length);
    const batch = to
      ? await upbit.requestWithRetry(async () => {
          const response = await axios.get(
            `https://api.upbit.com/v1/candles/minutes/${unit}`,
            upbit.getRequestConfig({ params: { market, count, to } })
          );
          return response.data;
        })
      : await upbit.getMinuteCandles(market, unit, count);

    if (!Array.isArray(batch) || batch.length === 0) break;
    candles.push(...batch);
    const oldest = batch.at(-1);
    to = oldest?.candle_date_time_utc;
    if (!to || batch.length < count) break;
    await sleep(120);
  }

  const byTimestamp = new Map();
  for (const candle of candles) {
    const key = candle?.candle_date_time_utc || candle?.candle_date_time_kst || candle?.timestamp;
    if (key !== undefined) byTimestamp.set(String(key), candle);
  }
  return Array.from(byTimestamp.values());
}

async function selectMarkets(upbit) {
  const explicit = (process.env.SCALP_VARIANT_MARKETS || process.env.SCALP_VALIDATION_MARKETS || '')
    .split(',')
    .map(market => market.trim().toUpperCase())
    .filter(Boolean);
  if (explicit.length > 0) return explicit;

  const excludedMarkets = new Set(['KRW-USDT', 'KRW-USDC', 'KRW-DAI', 'KRW-USD1']);
  const markets = (await upbit.getMarkets())
    .filter(item => item.market?.startsWith('KRW-') && !excludedMarkets.has(item.market))
    .map(item => item.market);
  const tickers = await upbit.getTicker(markets);
  const limit = number(process.env.SCALP_VARIANT_MARKET_COUNT, 20);
  return (tickers || [])
    .filter(ticker => Number.isFinite(ticker?.acc_trade_price_24h))
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, limit)
    .map(ticker => ticker.market);
}

function makeGateOptions() {
  return {
    grid: {},
    trainRatio: number(process.env.SCALP_VALIDATION_TRAIN_RATIO, 0.7),
    minimumCandles: number(process.env.SCALP_VALIDATION_MIN_CANDLES, 2000),
    minimumTrainingTrades: number(process.env.SCALP_VALIDATION_MIN_TRAINING_TRADES, 3),
    minimumTrainingProfitFactor: number(process.env.SCALP_VALIDATION_MIN_TRAINING_PROFIT_FACTOR, 1),
    minimumTrainingReturnPercent: number(process.env.SCALP_VALIDATION_MIN_TRAINING_RETURN_PERCENT, 0),
    minimumValidationTrades: number(process.env.SCALP_VALIDATION_MIN_TRADES, 10),
    minimumProfitFactor: number(process.env.SCALP_VALIDATION_MIN_PROFIT_FACTOR, 1.05),
    minimumReturnPercent: number(process.env.SCALP_VALIDATION_MIN_RETURN_PERCENT, 0.1),
    maximumDrawdownPercent: number(process.env.SCALP_VALIDATION_MAX_DRAWDOWN, 15)
  };
}

function summarizeVariantResults(results) {
  const rows = results.filter(result => result.validation?.validation);
  const sum = key => rows.reduce((total, row) => total + (Number(row.validation.validation?.[key]) || 0), 0);
  return {
    marketCount: rows.length,
    promotedMarketCount: rows.filter(row => row.validation.promoted === true).length,
    promoted: rows.length > 0 && rows.every(row => row.validation.promoted === true),
    trainingGateFailures: rows.filter(row => row.validation.gate?.trainingGatePassed !== true).length,
    holdoutGateFailures: rows.filter(row => row.validation.gate?.trainingGatePassed === true && row.validation.promoted !== true).length,
    positiveHoldoutMarkets: rows.filter(row => Number(row.validation.validation.totalReturnPercent) > 0).length,
    holdoutTradeCount: sum('tradeCount'),
    holdoutCircuitBlockedEntries: sum('circuitBlockedEntries'),
    sumHoldoutNetProfit: sum('netProfit'),
    sumHoldoutReturnPercent: sum('totalReturnPercent'),
    rows: rows.map(row => ({
      market: row.market,
      reason: row.validation.reason,
      training: {
        returnPercent: row.validation.tuning.metrics.totalReturnPercent,
        tradeCount: row.validation.tuning.metrics.tradeCount,
        profitFactor: row.validation.tuning.metrics.profitFactor
      },
      holdout: {
        returnPercent: row.validation.validation.totalReturnPercent,
        netProfit: row.validation.validation.netProfit,
        tradeCount: row.validation.validation.tradeCount,
        circuitBlockedEntries: row.validation.validation.circuitBlockedEntries || 0,
        profitFactor: row.validation.validation.profitFactor,
        maxDrawdownPercent: row.validation.validation.maxDrawdownPercent
      }
    }))
  };
}

export async function runVariantStudy() {
  const upbit = new UpbitAPI('', '', {
    requestTimeoutMs: number(process.env.UPBIT_REQUEST_TIMEOUT_MS, 10_000)
  });
  const baseConfig = getBaseConfig();
  const unit = baseConfig.candleUnit;
  const candleCount = number(process.env.SCALP_VARIANT_CANDLE_COUNT, number(process.env.SCALP_VALIDATION_CANDLE_COUNT, 10_080));
  const selectedNames = (process.env.SCALP_VARIANT_NAMES || Object.keys(SCALPING_VARIANTS).join(','))
    .split(',')
    .map(name => name.trim())
    .filter(name => SCALPING_VARIANTS[name]);
  const markets = await selectMarkets(upbit);
  const candleCacheFile = process.env.SCALP_VARIANT_CANDLES_FILE || null;
  let cachedCandles = {};
  if (candleCacheFile && fs.existsSync(candleCacheFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candleCacheFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        cachedCandles = parsed;
      }
      console.log(`\n📦 동일 윈도우 candle cache 사용: ${candleCacheFile}`);
    } catch (error) {
      console.log(`\n⚠️ candle cache 로드 실패, 새로 수집합니다: ${error.message}`);
    }
  }
  const gateOptions = makeGateOptions();
  const variantResults = Object.fromEntries(selectedNames.map(name => [name, []]));
  const fetched = [];

  for (const market of markets) {
    console.log(`\n⏳ ${market} 공통 데이터 ${candleCacheFile ? '확인' : '수집'} 중...`);
    try {
      const cached = cachedCandles[market];
      const fromCache = Array.isArray(cached) && cached.length > 0;
      const candles = fromCache
        ? cached
        : await getHistoricalCandles(upbit, market, unit, candleCount);
      fetched.push({ market, candleCount: candles.length, source: fromCache ? 'cache' : 'upbit' });
      console.log(`   ${fromCache ? 'cache 사용' : '수집 완료'}: ${candles.length}개 / ${selectedNames.length}개 variant 평가`);
      for (const name of selectedNames) {
        try {
          const validation = walkForwardValidate(
            candles,
            { ...baseConfig, ...SCALPING_VARIANTS[name] },
            gateOptions
          );
          variantResults[name].push({ market, validation });
        } catch (error) {
          variantResults[name].push({ market, error: error.message });
        }
      }
    } catch (error) {
      console.error(`   ❌ ${market} 공통 데이터 수집 실패: ${error.message}`);
      for (const name of selectedNames) variantResults[name].push({ market, error: error.message });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    study: 'same_window_scalping_variant_comparison',
    strategyMode: 'oversold_reaction_scalping',
    candleUnit: unit,
    candleCount,
    baseConfig,
    markets,
    fetched,
    variants: Object.fromEntries(selectedNames.map(name => [name, {
      overrides: SCALPING_VARIANTS[name],
      summary: summarizeVariantResults(variantResults[name])
    }])),
    promotion: 'diagnostic_only_never_authorizes_live_orders',
    note: '모든 variant는 시장별 동일 캔들 수집 창에서 비교했습니다. 결과는 수수료·슬리피지 포함 OHLC 대용치이며 실시간 체결 또는 수익을 보장하지 않습니다.'
  };
  const outputFile = process.env.SCALP_VARIANT_OUTPUT_FILE || 'scalping_variant_study.json';
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runVariantStudy()
    .then(report => {
      console.log(`\n💾 동일 윈도우 variant study 저장: ${process.env.SCALP_VARIANT_OUTPUT_FILE || 'scalping_variant_study.json'}`);
      for (const [name, variant] of Object.entries(report.variants)) {
        const summary = variant.summary;
        console.log(`  ${name}: ${summary.positiveHoldoutMarkets}/${summary.marketCount} 양수, ${summary.holdoutTradeCount} trades, circuit block ${summary.holdoutCircuitBlockedEntries || 0}회, 합산 ${summary.sumHoldoutReturnPercent.toFixed(4)}%, 승격 ${summary.promoted ? '가능' : '보류'}`);
      }
    })
    .catch(error => {
      console.error('❌ variant study 오류:', error.message);
      process.exitCode = 1;
    });
}
