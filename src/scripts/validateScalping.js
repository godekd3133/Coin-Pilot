import dotenv from 'dotenv';
import fs from 'fs';
import axios from 'axios';
import UpbitAPI from '../api/upbit.js';
import { walkForwardValidate } from '../backtest/scalpingBacktest.js';
import { resolveMaxCandleAgeSeconds } from '../risk/candleFreshness.js';
import {
  loadPaperValidationConfigSnapshot,
  mergePaperValidationConfig
} from '../research/scalpingValidationConfig.js';

dotenv.config();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

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
    const oldest = batch[batch.length - 1];
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
  const explicit = (process.env.SCALP_VALIDATION_MARKETS || '')
    .split(',')
    .map(market => market.trim().toUpperCase())
    .filter(Boolean);
  if (explicit.length > 0) return explicit;

  const markets = await upbit.getMarkets();
  const excludedMarkets = new Set(['KRW-USDT', 'KRW-USDC', 'KRW-DAI', 'KRW-USD1']);
  const krwMarkets = markets
    .filter(market => market.market?.startsWith('KRW-') && !excludedMarkets.has(market.market))
    .map(market => market.market);
  const tickers = await upbit.getTicker(krwMarkets);
  const limit = number(process.env.SCALP_VALIDATION_MARKET_COUNT, 3);

  return (tickers || [])
    .filter(ticker => Number.isFinite(ticker?.acc_trade_price_24h))
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, limit)
    .map(ticker => ticker.market);
}

function baseConfig(candleUnit = 1) {
  return {
    initialBalance: number(process.env.SCALP_VALIDATION_INITIAL_BALANCE, 1_000_000),
    tradingFee: number(process.env.SCALP_VALIDATION_FEE, 0.0005),
    slippage: number(process.env.SCALP_VALIDATION_SLIPPAGE, 0.001),
    investmentRatio: number(process.env.SCALP_INVESTMENT_RATIO, 0.02),
    maxCandleAgeSeconds: resolveMaxCandleAgeSeconds(
      number(process.env.SCALP_MAX_CANDLE_AGE_SECONDS, 0),
      candleUnit
    ),
    rsiPeriod: number(process.env.SCALP_RSI_PERIOD, number(process.env.RSI_PERIOD, 14)),
    rsiOversold: number(process.env.SCALP_RSI_OVERSOLD, number(process.env.RSI_OVERSOLD, 30)),
    rsiOverbought: number(process.env.SCALP_RSI_OVERBOUGHT, number(process.env.RSI_OVERBOUGHT, 70)),
    oversoldLookback: number(process.env.SCALP_OVERSOLD_LOOKBACK, 1),
    minReboundPercent: number(process.env.SCALP_MIN_REBOUND_PERCENT, 0.15),
    minRsiRecovery: number(process.env.SCALP_MIN_RSI_RECOVERY, 2),
    minVolumeRatio: number(process.env.SCALP_MIN_VOLUME_RATIO, 1.0),
    volumeLookback: number(process.env.SCALP_VOLUME_LOOKBACK, 20),
    minCloseStrength: number(process.env.SCALP_MIN_CLOSE_STRENGTH, 0.65),
    trendPeriod: number(process.env.SCALP_TREND_PERIOD, 30),
    trendSlopeLookback: number(process.env.SCALP_TREND_SLOPE_LOOKBACK, 3),
    minTrendSlopePercent: number(process.env.SCALP_MIN_TREND_SLOPE_PERCENT, -0.2),
    requirePreviousHighBreak: process.env.SCALP_REQUIRE_PREVIOUS_HIGH_BREAK !== 'false',
    maxSignalRangePercent: number(process.env.SCALP_MAX_SIGNAL_RANGE_PERCENT, 0),
    minSignalRangePercent: number(process.env.SCALP_MIN_SIGNAL_RANGE_PERCENT, 0),
    maxReboundPercent: number(process.env.SCALP_MAX_REBOUND_PERCENT, 0),
    marketRegimeEnabled: process.env.SCALP_MARKET_REGIME_ENABLED === 'true',
    marketRegimeLookback: number(process.env.SCALP_MARKET_REGIME_LOOKBACK, 5),
    marketRegimeMinBreadth: number(process.env.SCALP_MARKET_REGIME_MIN_BREADTH, 0.5),
    marketRegimeMinReturnPercent: number(process.env.SCALP_MARKET_REGIME_MIN_RETURN_PERCENT, -0.2),
    requireReboundBelowOverbought: process.env.SCALP_REQUIRE_REBOUND_BELOW_OVERBOUGHT === 'true',
    signalProfile: process.env.SCALP_SIGNAL_PROFILE || 'rsi_rebound',
    bbPeriod: number(process.env.BB_PERIOD, 20),
    bbStdDev: number(process.env.BB_STD_DEV, 2),
    emaPeriod: number(process.env.EMA_LONG, 60),
    maxPositions: number(process.env.SCALP_MAX_POSITIONS, 3),
    portfolioAllocation: number(process.env.SCALP_PORTFOLIO_ALLOCATION, 0.1),
    requireNextCandleBullish: process.env.SCALP_PORTFOLIO_REQUIRE_NEXT_CANDLE_BULLISH === 'true',
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
    winnerExtendMinutes: number(process.env.SCALP_WINNER_EXTEND_MINUTES, 0),
    winnerExtendMinProfitPercent: number(process.env.SCALP_WINNER_EXTEND_MIN_PROFIT_PERCENT, 0),
    maxEntriesPerSignalWindow: number(process.env.SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW, 0),
    maxRiskDataGapSeconds: number(process.env.SCALP_MAX_RISK_DATA_GAP_SECONDS, 30),
    maxAnalysisDataGapSeconds: number(process.env.SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS, 60),
    entryDelayMinMs: number(process.env.SCALP_ENTRY_DELAY_MIN_MS, 1000),
    entryDelayMaxMs: number(process.env.SCALP_ENTRY_DELAY_MAX_MS, 5000),
    cooldownAfterLossMinutes: number(process.env.SCALP_COOLDOWN_AFTER_LOSS_MINUTES, 15),
    maxConsecutiveLosses: number(process.env.SCALP_MAX_CONSECUTIVE_LOSSES, 3),
    lossCircuitBreakerCount: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_COUNT, 0),
    lossCircuitBreakerWindowMinutes: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES, 30),
    lossCircuitBreakerCooldownMinutes: number(process.env.SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES, 60),
    candleUnit: number(process.env.SCALP_CANDLE_UNIT, 1)
  };
}

function loadCandleCache(cacheFile) {
  if (!cacheFile) return null;
  if (!fs.existsSync(cacheFile)) {
    throw new Error(`지정한 validation candle cache가 없습니다: ${cacheFile}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch (error) {
    throw new Error(`validation candle cache를 읽을 수 없습니다 (${cacheFile}): ${error.message}`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`validation candle cache 형식이 잘못되었습니다: ${cacheFile}`);
  }
  return parsed;
}

async function main() {
  const upbit = new UpbitAPI('', '');
  const snapshotFile = process.env.SCALP_VALIDATION_CONFIG_SNAPSHOT_FILE || '';
  const paperSnapshot = loadPaperValidationConfigSnapshot(snapshotFile);
  const explicitUnit = process.env.SCALP_VALIDATION_CANDLE_UNIT;
  const unit = explicitUnit === undefined || explicitUnit === ''
    ? number(paperSnapshot?.config?.candleUnit, 1)
    : number(explicitUnit, 1);
  const candleCount = number(process.env.SCALP_VALIDATION_CANDLE_COUNT, 10080);
  const markets = await selectMarkets(upbit);
  const config = mergePaperValidationConfig(
    { ...baseConfig(unit), candleUnit: unit },
    paperSnapshot,
    unit
  );
  const candleCacheFile = process.env.SCALP_VALIDATION_CANDLES_FILE || '';
  const candleCache = loadCandleCache(candleCacheFile);
  const fixedConfigValidation = process.env.SCALP_VALIDATION_FIXED === 'true';
  const requireStatisticalConfidence = fixedConfigValidation &&
    process.env.SCALP_VALIDATION_REQUIRE_STATISTICAL_CONFIDENCE !== 'false';
  const minimumTrainingConfidenceTrades = number(
    process.env.SCALP_VALIDATION_MIN_TRAINING_CONFIDENCE_TRADES,
    10
  );
  const minimumValidationConfidenceTrades = number(
    process.env.SCALP_VALIDATION_MIN_CONFIDENCE_TRADES,
    20
  );
  const minimumConfidenceLowerBoundPercent = number(
    process.env.SCALP_VALIDATION_MIN_CONFIDENCE_LOWER_PERCENT,
    0
  );
  const results = [];

  if (markets.length === 0) {
    throw new Error('검증할 KRW 마켓이 없습니다.');
  }

  console.log('\n📈 과매도 반응 스캘핑 워크포워드 검증');
  console.log(`마켓: ${markets.join(', ')}`);
  console.log(`캔들: ${unit}분봉 ${candleCount}개 / 수수료 ${(config.tradingFee * 100).toFixed(3)}% / 슬리피지 ${(config.slippage * 100).toFixed(3)}%`);
  console.log(`검증 모드: ${fixedConfigValidation ? 'fixed_config (현재 설정 그대로)' : 'tuned_holdout (학습 구간 튜닝)'}`);
  console.log(paperSnapshot
    ? `설정 source: paper snapshot ${paperSnapshot.filePath} (session ${paperSnapshot.sessionId || 'unknown'})`
    : '설정 source: environment/defaults');

  for (const market of markets) {
    try {
      const cachedCandles = candleCache?.[market];
      if (candleCacheFile && !Array.isArray(cachedCandles)) {
        throw new Error(`validation candle cache에 ${market} 데이터가 없습니다. 혼합 window를 만들지 않고 중단합니다.`);
      }
      const fromCache = Array.isArray(cachedCandles);
      console.log(`\n⏳ ${market} ${fromCache ? 'cache 확인' : '데이터 수집'} 중...`);
      const candles = fromCache
        ? cachedCandles
        : await getHistoricalCandles(upbit, market, unit, candleCount);
      console.log(`   ${fromCache ? 'cache 사용' : '수집 완료'}: ${candles.length}개`);

      const validation = walkForwardValidate(candles, config, {
        grid: fixedConfigValidation ? {} : undefined,
        trainRatio: number(process.env.SCALP_VALIDATION_TRAIN_RATIO, 0.7),
        minimumCandles: number(process.env.SCALP_VALIDATION_MIN_CANDLES, 2000),
        minimumTrainingTrades: number(process.env.SCALP_VALIDATION_MIN_TRAINING_TRADES, 3),
        minimumTrainingProfitFactor: number(process.env.SCALP_VALIDATION_MIN_TRAINING_PROFIT_FACTOR, 1),
        minimumTrainingReturnPercent: number(process.env.SCALP_VALIDATION_MIN_TRAINING_RETURN_PERCENT, 0),
        minimumValidationTrades: number(process.env.SCALP_VALIDATION_MIN_TRADES, 10),
        minimumProfitFactor: number(process.env.SCALP_VALIDATION_MIN_PROFIT_FACTOR, 1.05),
        minimumReturnPercent: number(process.env.SCALP_VALIDATION_MIN_RETURN_PERCENT, 0.1),
        maximumDrawdownPercent: number(process.env.SCALP_VALIDATION_MAX_DRAWDOWN, 15),
        maxTuningCandidates: number(process.env.SCALP_VALIDATION_MAX_CANDIDATES, 0),
        requireStatisticalConfidence,
        minimumTrainingConfidenceTrades,
        minimumValidationConfidenceTrades,
        minimumConfidenceLowerBoundPercent
      });

      results.push({
        market,
        fetchedCandles: candles.length,
        candleSource: fromCache ? 'cache' : 'upbit',
        validation
      });
      const metrics = validation.validation;
      if (metrics) {
        console.log(`   학습 수익률: ${validation.tuning.metrics.totalReturnPercent.toFixed(2)}%`);
        console.log(`   검증 수익률: ${metrics.totalReturnPercent.toFixed(2)}%`);
        console.log(`   검증 거래: ${metrics.tradeCount}회 / 승률 ${metrics.winRate.toFixed(2)}% / PF ${Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : '∞'} / MDD ${metrics.maxDrawdownPercent.toFixed(2)}%`);
        console.log(`   판정: ${validation.promoted ? '✅ 승격 가능' : '⛔ 보류/튜닝 필요'} (${validation.reason})`);
      } else {
        console.log(`   판정: ⛔ ${validation.reason}`);
      }
    } catch (error) {
      console.error(`   ❌ ${market} 검증 실패: ${error.message}`);
      results.push({ market, error: error.message });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    strategyMode: 'oversold_reaction_scalping',
    candleUnit: unit,
    candleCount,
    candleCacheFile: candleCacheFile || null,
    configSource: paperSnapshot
      ? {
          type: 'paper_validation_snapshot',
          filePath: paperSnapshot.filePath,
          sessionId: paperSnapshot.sessionId,
          startedAt: paperSnapshot.startedAt,
          configSnapshotComplete: paperSnapshot.configSnapshotComplete
        }
      : { type: 'environment_or_defaults' },
    validationMode: fixedConfigValidation ? 'fixed_config' : 'tuned_holdout',
    config,
    markets,
    results,
    statisticalConfidence: {
      required: requireStatisticalConfidence,
      method: 'one_sided_t_mean',
      confidenceLevel: 0.95,
      minimumTrainingTrades: minimumTrainingConfidenceTrades,
      minimumValidationTrades: minimumValidationConfidenceTrades,
      minimumLowerBoundPercent: minimumConfidenceLowerBoundPercent,
      passed: requireStatisticalConfidence
        ? results.length === markets.length &&
          results.length > 0 &&
          results.every(result => {
            const gate = result.validation?.gate?.statisticalConfidence;
            return gate?.required === true &&
              gate.training?.passed === true &&
              gate.validation?.passed === true;
          })
        : false
    },
    promotedMarkets: results.filter(result => result.validation?.promoted).map(result => result.market),
    promoted: results.length === markets.length &&
      results.length > 0 &&
      results.every(result => result.validation?.promoted === true),
    promotionReason: results.length === markets.length &&
      results.length > 0 &&
      results.every(result => result.validation?.promoted === true)
      ? 'all_validation_markets_passed'
      : 'all_markets_must_pass_before_live_promotion',
    note: '분봉 OHLC 기반 결과입니다. 1~5초 지연은 다음 캔들 시가를 보수적 대용치로 사용했으며 실시간 체결/슬리피지와 동일하지 않습니다.'
  };

  const outputFile = process.env.SCALP_VALIDATION_OUTPUT_FILE || 'scalping_validation.json';
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n💾 검증 리포트 저장: ${outputFile}`);
  console.log(`승격 가능 마켓: ${report.promotedMarkets.length}/${markets.length}`);
  console.log(`전체 전략 승격: ${report.promoted ? '✅ 가능' : '⛔ 보류'}`);

  if (process.argv.includes('--strict') && !report.promoted) {
    process.exitCode = 2;
  }
}

main().catch(error => {
  console.error('❌ 스캘핑 검증 오류:', error.message);
  process.exitCode = 1;
});
