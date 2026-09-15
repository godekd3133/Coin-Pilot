import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG,
  evaluateDailyMomentumRobustness
} from '../research/dailyMomentumRobustnessStudy.js';

dotenv.config();

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const numberAxis = value => value.split(',').map(Number).filter(Number.isFinite);
const inputFile = process.env.DAILY_MOMENTUM_CANDLES_FILE || process.argv[2];
const outputFile = process.env.DAILY_MOMENTUM_ROBUSTNESS_REPORT_FILE ||
  process.argv[3] || '/private/tmp/coinpilot-daily-momentum-robustness-report.json';
const benchmarkThresholds = process.env.DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_THRESHOLDS
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_THRESHOLDS
    .split(',').map(Number).filter(Number.isFinite)
  : null;
const minUpBars = process.env.DAILY_MOMENTUM_ROBUSTNESS_MIN_UP_BARS
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_MIN_UP_BARS.split(',').map(Number).filter(Number.isFinite)
  : null;
const trendMinPercent = process.env.DAILY_MOMENTUM_ROBUSTNESS_TREND_MIN_PERCENT
  ? numberAxis(process.env.DAILY_MOMENTUM_ROBUSTNESS_TREND_MIN_PERCENT)
  : null;
const breadthMin = process.env.DAILY_MOMENTUM_ROBUSTNESS_BREADTH_MIN
  ? numberAxis(process.env.DAILY_MOMENTUM_ROBUSTNESS_BREADTH_MIN)
  : null;
const positionFraction = process.env.DAILY_MOMENTUM_ROBUSTNESS_POSITION_FRACTION
  ? numberAxis(process.env.DAILY_MOMENTUM_ROBUSTNESS_POSITION_FRACTION)
  : null;
const maxPositions = process.env.DAILY_MOMENTUM_ROBUSTNESS_MAX_POSITIONS
  ? numberAxis(process.env.DAILY_MOMENTUM_ROBUSTNESS_MAX_POSITIONS)
  : null;
const cooldownAfterLossDays = process.env.DAILY_MOMENTUM_ROBUSTNESS_COOLDOWN_AFTER_LOSS_DAYS
  ? numberAxis(process.env.DAILY_MOMENTUM_ROBUSTNESS_COOLDOWN_AFTER_LOSS_DAYS)
  : null;
const maxPortfolioDrawdownPercent = process.env.DAILY_MOMENTUM_ROBUSTNESS_MAX_PORTFOLIO_DRAWDOWN_PERCENT
  ? numberAxis(process.env.DAILY_MOMENTUM_ROBUSTNESS_MAX_PORTFOLIO_DRAWDOWN_PERCENT)
  : null;
const benchmarkExitConfirmationBars = process.env.DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_EXIT_CONFIRMATION_BARS
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_EXIT_CONFIRMATION_BARS
    .split(',').map(Number).filter(Number.isFinite)
  : null;
const regimeExitConfirmationBars = process.env.DAILY_MOMENTUM_ROBUSTNESS_REGIME_EXIT_CONFIRMATION_BARS
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_REGIME_EXIT_CONFIRMATION_BARS
    .split(',').map(Number).filter(Number.isFinite)
  : null;
const relativeTrendMinPercent = process.env.DAILY_MOMENTUM_ROBUSTNESS_RELATIVE_TREND_MIN_PERCENT
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_RELATIVE_TREND_MIN_PERCENT
    .split(',').map(Number).filter(Number.isFinite)
  : null;
const volatilityLookbackDays = process.env.DAILY_MOMENTUM_ROBUSTNESS_VOLATILITY_LOOKBACK_DAYS
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_VOLATILITY_LOOKBACK_DAYS
    .split(',').map(Number).filter(Number.isFinite)
  : null;
const volatilityTargetPercent = process.env.DAILY_MOMENTUM_ROBUSTNESS_VOLATILITY_TARGET_PERCENT
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_VOLATILITY_TARGET_PERCENT
    .split(',').map(Number).filter(Number.isFinite)
  : null;
const stopLossPercent = process.env.DAILY_MOMENTUM_ROBUSTNESS_STOP_LOSS_PERCENT
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_STOP_LOSS_PERCENT
    .split(',').map(Number).filter(Number.isFinite)
  : null;
const maxEntryGapPercent = process.env.DAILY_MOMENTUM_ROBUSTNESS_MAX_ENTRY_GAP_PERCENT
  ? numberAxis(process.env.DAILY_MOMENTUM_ROBUSTNESS_MAX_ENTRY_GAP_PERCENT)
  : null;
const entryExecution = process.env.DAILY_MOMENTUM_ROBUSTNESS_ENTRY_EXECUTION === 'next_open'
  ? 'next_open'
  : null;
const exitExecution = process.env.DAILY_MOMENTUM_ROBUSTNESS_EXIT_EXECUTION === 'next_open'
  ? 'next_open'
  : null;
const costPercent = process.env.DAILY_MOMENTUM_ROBUSTNESS_COST_PERCENT === undefined
  ? null
  : number(process.env.DAILY_MOMENTUM_ROBUSTNESS_COST_PERCENT, 0.2);
const modes = process.env.DAILY_MOMENTUM_ROBUSTNESS_MODES
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_MODES
    .split(',').map(value => value.trim()).filter(value => value === 'fixed' || value === 'regime')
  : null;
const maxHoldDays = process.env.DAILY_MOMENTUM_ROBUSTNESS_MAX_HOLD_DAYS
  ? numberAxis(process.env.DAILY_MOMENTUM_ROBUSTNESS_MAX_HOLD_DAYS)
    .map(value => Math.max(1, Math.floor(value)))
  : null;

function loadCandles(file) {
  if (!file || !fs.existsSync(file)) {
    throw new Error('FAIL_CLOSED: DAILY_MOMENTUM_CANDLES_FILE 또는 첫 번째 인자로 daily candle cache를 지정하세요.');
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const candles = parsed?.candles && typeof parsed.candles === 'object' ? parsed.candles : parsed;
  if (!candles || typeof candles !== 'object' || Array.isArray(candles)) {
    throw new Error('FAIL_CLOSED: daily candle cache 형식이 잘못되었습니다.');
  }
  const requestedMarkets = (process.env.DAILY_MOMENTUM_MARKETS || Object.keys(candles).join(','))
    .split(',').map(market => market.trim().toUpperCase()).filter(Boolean);
  const markets = [...new Set(requestedMarkets)];
  const missing = markets.filter(market => !Array.isArray(candles[market]));
  if (missing.length) throw new Error(`FAIL_CLOSED: cache에 시장 데이터가 없습니다: ${missing.join(', ')}`);
  return { candles: Object.fromEntries(markets.map(market => [market, candles[market]])), markets };
}

function printShortlist(item) {
  const metrics = item.fullMetrics || {};
  const risk = item.drawdownStopTriggered ? ' · drawdown stop 발동' : '';
  console.log(`${item.name}: ${item.status} · full ${number(metrics.totalReturnPercent, 0).toFixed(3)}% · ` +
    `PF ${Number.isFinite(Number(metrics.profitFactor)) ? Number(metrics.profitFactor).toFixed(2) : '∞'} · ` +
    `MDD ${number(metrics.maxDrawdownPercent, 0).toFixed(2)}% · trades ${metrics.tradeCount || 0} · ` +
    `worst segment ${number(item.worstSegmentReturnPercent, 0).toFixed(3)}%${risk}`);
}

function main() {
  const { candles, markets } = loadCandles(inputFile);
  const report = evaluateDailyMomentumRobustness(candles, {
    segmentCount: Math.max(2, Math.floor(number(
      process.env.DAILY_MOMENTUM_ROBUSTNESS_SEGMENTS,
      DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG.segmentCount
    ))),
    minimumFullReturnPercent: number(
      process.env.DAILY_MOMENTUM_ROBUSTNESS_MIN_RETURN_PERCENT,
      DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG.minimumFullReturnPercent
    ),
    maximumDrawdownPercent: number(
      process.env.DAILY_MOMENTUM_ROBUSTNESS_MAX_DRAWDOWN_PERCENT,
      DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG.maximumDrawdownPercent
    ),
    minimumWorstSegmentReturnPercent: number(
      process.env.DAILY_MOMENTUM_ROBUSTNESS_MIN_WORST_SEGMENT_PERCENT,
      DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG.minimumWorstSegmentReturnPercent
    ),
    minimumTradeCount: Math.max(1, Math.floor(number(
      process.env.DAILY_MOMENTUM_ROBUSTNESS_MIN_TRADES,
      DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG.minimumTradeCount
    ))),
    segmentMode: process.env.DAILY_MOMENTUM_ROBUSTNESS_SEGMENT_MODE === 'independent'
      ? 'independent'
      : DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG.segmentMode,
    ...((entryExecution || exitExecution || costPercent !== null) ? {
      baseConfig: {
        ...(entryExecution ? { entryExecution } : {}),
        ...(exitExecution ? { exitExecution } : {}),
        ...(costPercent !== null ? { costPercent } : {})
      }
    } : {}),
    grid: modes?.length || maxHoldDays?.length || trendMinPercent?.length || breadthMin?.length || positionFraction?.length || maxPositions?.length ||
      cooldownAfterLossDays?.length || maxPortfolioDrawdownPercent?.length ||
      benchmarkThresholds?.length || minUpBars?.length ||
      benchmarkExitConfirmationBars?.length || regimeExitConfirmationBars?.length ||
      relativeTrendMinPercent?.length || volatilityLookbackDays?.length ||
      volatilityTargetPercent?.length || stopLossPercent?.length || maxEntryGapPercent?.length
      ? {
        ...(modes?.length ? { mode: modes } : {}),
        ...(maxHoldDays?.length ? { maxHoldDays } : {}),
        ...(trendMinPercent?.length ? { trendMinPercent } : {}),
        ...(breadthMin?.length ? { breadthMin } : {}),
        ...(positionFraction?.length ? { positionFraction } : {}),
        ...(maxPositions?.length ? { maxPositions } : {}),
        ...(cooldownAfterLossDays?.length ? { cooldownAfterLossDays } : {}),
        ...(maxPortfolioDrawdownPercent?.length ? { maxPortfolioDrawdownPercent } : {}),
        ...(benchmarkThresholds?.length ? { benchmarkTrendMinPercent: benchmarkThresholds } : {}),
        ...(minUpBars?.length ? { minUpBars } : {}),
        ...(benchmarkExitConfirmationBars?.length ? { benchmarkExitConfirmationBars } : {}),
        ...(regimeExitConfirmationBars?.length ? { regimeExitConfirmationBars } : {}),
        ...(relativeTrendMinPercent?.length ? { relativeTrendMinPercent } : {}),
        ...(volatilityLookbackDays?.length ? { volatilityLookbackDays } : {}),
        ...(volatilityTargetPercent?.length ? { volatilityTargetPercent } : {}),
        ...(stopLossPercent?.length ? { stopLossPercent } : {}),
        ...(maxEntryGapPercent?.length ? { maxEntryGapPercent } : {})
      }
      : undefined
  });
  const output = {
    ...report,
    inputFile,
    markets,
    promoted: false,
    note: `${report.note} 이 파일은 동일한 완료 일봉과 비용 가정의 historical 비교 결과입니다.`
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`daily momentum robustness: ${markets.length} markets · ${inputFile}`);
  console.log(`shortlist ${output.shortlist.length}/${output.variants.length}`);
  console.log(`status counts: ${Object.entries(output.statusCounts).map(([status, count]) => `${status}=${count}`).join(' · ')}`);
  console.log(`benchmark thresholds: ${Object.entries(output.benchmarkThresholdSummary).map(([threshold, counts]) => `${threshold}% ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(',')}`).join(' · ')}`);
  output.shortlist.forEach(printShortlist);
  if (output.shortlist.length === 0 && output.nearMisses.length > 0) {
    console.log(`near misses ${output.nearMisses.length} · 승격/forward 후보가 아닌 fail-closed 참고 목록`);
    output.nearMisses.slice(0, 5).forEach(item => {
      const metrics = item.fullMetrics || {};
      console.log(`${item.name}: HOLD · full ${number(metrics.totalReturnPercent, 0).toFixed(3)}% · ` +
        `MDD ${number(metrics.maxDrawdownPercent, 0).toFixed(2)}% · ` +
        `worst segment ${number(item.worstSegmentReturnPercent, 0).toFixed(3)}% · ` +
        `blockers ${item.eligibilityBlockers.join(',')}${item.drawdownStopTriggered ? ' · drawdown stop 발동' : ''}`);
    });
  }
  console.log(`saved: ${outputFile}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
