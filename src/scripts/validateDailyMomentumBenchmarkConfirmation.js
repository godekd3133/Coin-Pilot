import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  evaluateDailyMomentumRobustness
} from '../research/dailyMomentumRobustnessStudy.js';

dotenv.config();

const inputFile = process.env.DAILY_MOMENTUM_CANDLES_FILE || process.argv[2];
const outputFile = process.env.DAILY_MOMENTUM_ROBUSTNESS_REPORT_FILE ||
  process.argv[3] || '/private/tmp/coinpilot-daily-momentum-benchmark-confirmation.json';
const confirmationBars = (process.argv[4] || '1,2,3')
  .split(',')
  .map(value => Math.floor(Number(value)))
  .filter(value => Number.isFinite(value) && value >= 1);
const segmentMode = process.argv[5] === 'independent' ? 'independent' : 'continuous';

function loadCandles(file) {
  if (!file || !fs.existsSync(file)) {
    throw new Error('FAIL_CLOSED: daily candle cache를 첫 번째 인자 또는 DAILY_MOMENTUM_CANDLES_FILE로 지정하세요.');
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const candles = parsed?.candles && typeof parsed.candles === 'object' ? parsed.candles : parsed;
  if (!candles || typeof candles !== 'object' || Array.isArray(candles)) {
    throw new Error('FAIL_CLOSED: daily candle cache 형식이 잘못되었습니다.');
  }
  const markets = [...new Set(Object.keys(candles))];
  if (!markets.length || markets.some(market => !Array.isArray(candles[market]))) {
    throw new Error('FAIL_CLOSED: 모든 daily market candle이 배열이어야 합니다.');
  }
  return Object.fromEntries(markets.map(market => [market, candles[market]]));
}

function main() {
  const candles = loadCandles(inputFile);
  const bars = [...new Set(confirmationBars.length ? confirmationBars : [1])];
  const baseConfig = {
    mode: 'regime',
    trendMinPercent: 2,
    breadthMin: 2,
    minUpBars: 2,
    positionFraction: 0.125,
    maxPositions: 2,
    costPercent: Number.isFinite(Number(process.env.DAILY_MOMENTUM_COST_PERCENT))
      ? Number(process.env.DAILY_MOMENTUM_COST_PERCENT)
      : 0.2,
    benchmarkMarket: 'KRW-BTC',
    benchmarkTrendMinPercent: 2,
    exitOnBenchmarkOff: true,
    cooldownAfterLossDays: 3,
    maxPortfolioDrawdownPercent: 0,
    maxHoldDays: 3650,
    entryExecution: process.env.DAILY_MOMENTUM_ENTRY_EXECUTION === 'next_open'
      ? 'next_open'
      : 'close',
    exitExecution: process.env.DAILY_MOMENTUM_EXIT_EXECUTION === 'next_open'
      ? 'next_open'
      : 'close'
  };
  const variants = bars.map(benchmarkMinUpBars => ({
    name: `benchmark_up${benchmarkMinUpBars}`,
    config: { ...baseConfig, benchmarkMinUpBars }
  }));
  const report = evaluateDailyMomentumRobustness(candles, {
    variants,
    segmentCount: 8,
    segmentMode,
    minimumFullReturnPercent: 0,
    maximumDrawdownPercent: 15,
    minimumWorstSegmentReturnPercent: -2,
    minimumTradeCount: 30
  });
  const output = {
    ...report,
    inputFile,
    markets: Object.keys(candles),
    promoted: false,
    note: 'benchmarkMinUpBars comparison is research-only and never changes the runtime or live gate.'
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`daily momentum benchmark confirmation: ${output.markets.length} markets · ${segmentMode}`);
  output.variants.forEach(variant => {
    const metrics = variant.full.metrics;
    console.log(`${variant.config.benchmarkMinUpBars} bars: ${variant.status} · ` +
      `return ${Number(metrics.totalReturnPercent).toFixed(3)}% · ` +
      `PF ${Number(metrics.profitFactor).toFixed(2)} · ` +
      `MDD ${Number(metrics.maxDrawdownPercent).toFixed(2)}% · ` +
      `trades ${metrics.tradeCount} · ` +
      `worst ${Number(variant.worstSegmentReturnPercent).toFixed(3)}% · ` +
      `${variant.eligibilityBlockers.length ? variant.eligibilityBlockers.join(',') : 'eligible'}`);
  });
  console.log(`saved: ${outputFile}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
