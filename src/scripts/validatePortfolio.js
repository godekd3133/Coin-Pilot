import dotenv from 'dotenv';
import fs from 'fs';
import axios from 'axios';
import UpbitAPI from '../api/upbit.js';
import {
  walkForwardValidatePortfolio,
  walkForwardValidatePortfolioFolds
} from '../backtest/scalpingBacktest.js';
import { resolveMaxCandleAgeSeconds } from '../risk/candleFreshness.js';

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
  return [...byTimestamp.values()];
}

async function selectMarkets(upbit) {
  const explicit = (process.env.SCALP_PORTFOLIO_VALIDATION_MARKETS || '')
    .split(',')
    .map(market => market.trim().toUpperCase())
    .filter(Boolean);
  if (explicit.length > 0) return explicit;

  const excludedMarkets = new Set(['KRW-USDT', 'KRW-USDC', 'KRW-DAI', 'KRW-USD1']);
  const markets = (await upbit.getMarkets())
    .filter(item => item.market?.startsWith('KRW-') && !excludedMarkets.has(item.market))
    .map(item => item.market);
  const tickers = await upbit.getTicker(markets);
  const limit = number(process.env.SCALP_PORTFOLIO_VALIDATION_MARKET_COUNT, 6);
  return (tickers || [])
    .filter(ticker => Number.isFinite(ticker?.acc_trade_price_24h))
    .sort((a, b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
    .slice(0, limit)
    .map(ticker => ticker.market);
}

function baseConfig() {
  return {
    initialBalance: number(process.env.SCALP_VALIDATION_INITIAL_BALANCE, 1_000_000),
    tradingFee: 0.0005,
    slippage: number(process.env.SCALP_VALIDATION_SLIPPAGE, 0.001),
    investmentRatio: number(process.env.SCALP_INVESTMENT_RATIO, 0.02),
    maxCandleAgeSeconds: resolveMaxCandleAgeSeconds(
      number(process.env.SCALP_MAX_CANDLE_AGE_SECONDS, 0),
      number(process.env.SCALP_VALIDATION_CANDLE_UNIT, 1)
    ),
    maxPositions: number(process.env.SCALP_MAX_POSITIONS, 3),
    portfolioAllocation: number(process.env.SCALP_PORTFOLIO_ALLOCATION, 0.1),
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
    marketRegimeEnabled: process.env.SCALP_MARKET_REGIME_ENABLED === 'true',
    marketRegimeLookback: number(process.env.SCALP_MARKET_REGIME_LOOKBACK, 5),
    marketRegimeMinBreadth: number(process.env.SCALP_MARKET_REGIME_MIN_BREADTH, 0.5),
    marketRegimeMinReturnPercent: number(process.env.SCALP_MARKET_REGIME_MIN_RETURN_PERCENT, -0.2),
    requireReboundBelowOverbought: process.env.SCALP_REQUIRE_REBOUND_BELOW_OVERBOUGHT === 'true',
    signalProfile: process.env.SCALP_SIGNAL_PROFILE || 'rsi_rebound',
    bbPeriod: 20,
    bbStdDev: 2,
    emaPeriod: 20,
    maxEntryRetracePercent: number(process.env.SCALP_MAX_ENTRY_RETRACE_PERCENT, 0.25),
    maxEntryChasePercent: number(process.env.SCALP_MAX_ENTRY_CHASE_PERCENT, 0.35),
    requireNextCandleBullish: process.env.SCALP_PORTFOLIO_REQUIRE_NEXT_CANDLE_BULLISH === 'true',
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

// Deliberately small compared with the per-market grid. This is a portfolio
// research hypothesis, not a live configuration or a promotion shortcut.
const PORTFOLIO_TUNING_GRID = {
  minReboundPercent: [0.15, 0.25, 0.5],
  minVolumeRatio: [1, 1.5],
  minSignalRangePercent: [0, 0.2, 0.4],
  maxHoldMinutes: [15, 30],
  maxEntriesPerSignalWindow: [0, 1, 2],
  marketRegimeEnabled: [false, true],
  marketRegimeLookback: [5],
  marketRegimeMinBreadth: [0.5],
  marketRegimeMinReturnPercent: [-0.2],
  requireReboundBelowOverbought: [false, true],
  requireNextCandleBullish: [false, true]
};

async function main() {
  const upbit = new UpbitAPI('', '', {
    requestTimeoutMs: number(process.env.UPBIT_REQUEST_TIMEOUT_MS, 10_000)
  });
  const markets = await selectMarkets(upbit);
  const config = baseConfig();
  const unit = config.candleUnit;
  const candleCount = number(
    process.env.SCALP_PORTFOLIO_VALIDATION_CANDLE_COUNT,
    number(process.env.SCALP_VALIDATION_CANDLE_COUNT, 10_080)
  );
  const tuned = process.env.SCALP_PORTFOLIO_VALIDATION_TUNED === 'true';
  const candleCacheFile = process.env.SCALP_PORTFOLIO_CANDLES_FILE || null;
  const foldCount = Math.max(0, Math.floor(number(process.env.SCALP_PORTFOLIO_VALIDATION_FOLDS, 0)));

  if (markets.length === 0) throw new Error('포트폴리오 검증 대상 KRW 마켓이 없습니다.');

  console.log('\n📊 공유 포트폴리오 스캘핑 워크포워드 검증');
  console.log(`마켓: ${markets.join(', ')}`);
  console.log(`캔들: ${unit}분봉 ${candleCount}개 / ${tuned ? '소형 튜닝 grid' : '현재 설정 고정'}`);

  const candlesByMarket = {};
  const fetched = [];
  let cachedCandles = {};
  if (candleCacheFile && fs.existsSync(candleCacheFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candleCacheFile, 'utf8'));
      if (parsed && typeof parsed === 'object') cachedCandles = parsed;
      console.log(`\n📦 동일 윈도우 candle cache 사용: ${candleCacheFile}`);
    } catch (error) {
      console.log(`\n⚠️ candle cache 로드 실패, 새로 수집합니다: ${error.message}`);
    }
  }
  for (const market of markets) {
    try {
      if (Array.isArray(cachedCandles[market]) && cachedCandles[market].length > 0) {
        candlesByMarket[market] = cachedCandles[market];
        fetched.push({ market, candleCount: cachedCandles[market].length, source: 'cache' });
        console.log(`\n✅ ${market} cache 사용: ${cachedCandles[market].length}개`);
        continue;
      }
      console.log(`\n⏳ ${market} 데이터 수집 중...`);
      const candles = await getHistoricalCandles(upbit, market, unit, candleCount);
      candlesByMarket[market] = candles;
      fetched.push({ market, candleCount: candles.length });
      console.log(`   수집 완료: ${candles.length}개`);
    } catch (error) {
      console.error(`   ❌ ${market} 수집 실패: ${error.message}`);
      fetched.push({ market, error: error.message });
    }
  }
  if (candleCacheFile && Object.keys(candlesByMarket).length > 0) {
    fs.writeFileSync(candleCacheFile, JSON.stringify(candlesByMarket), 'utf8');
    console.log(`\n💾 candle cache 저장: ${candleCacheFile}`);
  }

  const validationOptions = {
    grid: tuned ? PORTFOLIO_TUNING_GRID : {},
    trainRatio: number(process.env.SCALP_VALIDATION_TRAIN_RATIO, 0.7),
    minimumCandles: number(process.env.SCALP_VALIDATION_MIN_CANDLES, 2_000),
    minimumTrainingTrades: number(process.env.SCALP_VALIDATION_MIN_TRAINING_TRADES, 3),
    minimumTrainingProfitFactor: number(process.env.SCALP_VALIDATION_MIN_TRAINING_PROFIT_FACTOR, 1),
    minimumTrainingReturnPercent: number(process.env.SCALP_VALIDATION_MIN_TRAINING_RETURN_PERCENT, 0),
    minimumValidationTrades: number(process.env.SCALP_PORTFOLIO_VALIDATION_MIN_TRADES, 10),
    minimumProfitFactor: number(process.env.SCALP_VALIDATION_MIN_PROFIT_FACTOR, 1.05),
    minimumReturnPercent: number(process.env.SCALP_VALIDATION_MIN_RETURN_PERCENT, 0.1),
    maximumDrawdownPercent: number(process.env.SCALP_VALIDATION_MAX_DRAWDOWN, 15),
    foldCount: foldCount || undefined,
    initialTrainRatio: number(process.env.SCALP_PORTFOLIO_INITIAL_TRAIN_RATIO, 0.5)
  };
  const validation = foldCount >= 2
    ? walkForwardValidatePortfolioFolds(candlesByMarket, config, validationOptions)
    : walkForwardValidatePortfolio(candlesByMarket, config, validationOptions);

  const report = {
    generatedAt: new Date().toISOString(),
    study: 'shared_portfolio_scalping_walk_forward',
    strategyMode: 'oversold_reaction_scalping',
    validationMode: foldCount >= 2
      ? tuned ? 'portfolio_tuned_multi_fold_diagnostic' : 'portfolio_fixed_config_multi_fold_diagnostic'
      : tuned ? 'portfolio_tuned_diagnostic' : 'portfolio_fixed_config_diagnostic',
    candleUnit: unit,
    candleCount,
    candleCacheFile,
    config,
    markets,
    fetched,
    validation,
    promoted: false,
    promotionReason: 'portfolio_validation_is_diagnostic_only_and_never_authorizes_live_orders',
    note: '공유 KRW 잔액·최대 포지션·동시 신호 우선순위를 반영한 별도 검증 레인입니다. 결과는 수수료·슬리피지 포함 OHLC 대용치이며 실시간 체결 또는 수익을 보장하지 않습니다.'
  };
  const outputFile = process.env.SCALP_PORTFOLIO_VALIDATION_OUTPUT_FILE || 'scalping_portfolio_validation.json';
  fs.writeFileSync(outputFile, JSON.stringify(report, null, 2), 'utf8');

  console.log(`\n💾 포트폴리오 검증 리포트 저장: ${outputFile}`);
  if (validation.validation) {
    console.log(`학습: ${validation.tuning.metrics.totalReturnPercent.toFixed(4)}% / ${validation.tuning.metrics.tradeCount} trades / PF ${Number.isFinite(validation.tuning.metrics.profitFactor) ? validation.tuning.metrics.profitFactor.toFixed(2) : '∞'}`);
    console.log(`holdout: ${validation.validation.totalReturnPercent.toFixed(4)}% / ${validation.validation.tradeCount} trades / PF ${Number.isFinite(validation.validation.profitFactor) ? validation.validation.profitFactor.toFixed(2) : '∞'} / MDD ${validation.validation.maxDrawdownPercent.toFixed(4)}%`);
    console.log(`선정: ${validation.selection?.skippedEntries || 0}건 포트폴리오 슬롯 초과, circuit block ${validation.selection?.circuitBlockedEntries || 0}건`);
  } else if (validation.aggregate) {
    console.log(`multi-fold: ${validation.aggregate.promotedFoldCount}/${validation.foldCount} folds 통과 · holdout ${validation.aggregate.holdoutReturnPercent.toFixed(4)}% / ${validation.aggregate.holdoutTradeCount} trades · regime block ${validation.aggregate.marketRegimeBlockedEntries || 0}건`);
  }
  console.log(`판정: ${validation.promoted ? '진단상 통과' : '보류'} (live 승격 불가)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('❌ 포트폴리오 검증 오류:', error.message);
    process.exitCode = 1;
  });
}
