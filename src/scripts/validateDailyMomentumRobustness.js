import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DAILY_MOMENTUM_ROBUSTNESS_CONFIG,
  evaluateDailyMomentumRobustness
} from '../research/dailyMomentumRobustnessStudy.js';

dotenv.config();

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const inputFile = process.env.DAILY_MOMENTUM_CANDLES_FILE || process.argv[2];
const outputFile = process.env.DAILY_MOMENTUM_ROBUSTNESS_REPORT_FILE ||
  '/private/tmp/coinpilot-daily-momentum-robustness-report.json';
const benchmarkThresholds = process.env.DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_THRESHOLDS
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_THRESHOLDS
    .split(',').map(Number).filter(Number.isFinite)
  : null;
const minUpBars = process.env.DAILY_MOMENTUM_ROBUSTNESS_MIN_UP_BARS
  ? process.env.DAILY_MOMENTUM_ROBUSTNESS_MIN_UP_BARS.split(',').map(Number).filter(Number.isFinite)
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
    grid: benchmarkThresholds?.length || minUpBars?.length
      ? {
        ...(benchmarkThresholds?.length ? { benchmarkTrendMinPercent: benchmarkThresholds } : {}),
        ...(minUpBars?.length ? { minUpBars } : {})
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
