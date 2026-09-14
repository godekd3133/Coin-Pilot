import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DAILY_MOMENTUM_CONFIG,
  DEFAULT_DAILY_MOMENTUM_VARIANTS,
  evaluateDailyMomentumVariants
} from '../research/dailyMomentumStudy.js';

dotenv.config();

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const inputFile = process.env.DAILY_MOMENTUM_CANDLES_FILE || process.argv[2];
const outputFile = process.env.DAILY_MOMENTUM_REPORT_FILE || '/private/tmp/coinpilot-daily-momentum-report.json';

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

function printVariant(variant) {
  const metrics = variant.full.metrics;
  const segments = variant.segments
    .map(segment => `${segment.metrics.totalReturnPercent.toFixed(3)}%`)
    .join(' / ');
  console.log(`${variant.name}: full ${metrics.totalReturnPercent.toFixed(3)}% · ` +
    `realized ${metrics.realizedReturnPercent.toFixed(3)}% · ` +
    `trades ${metrics.tradeCount} · PF ${Number.isFinite(metrics.profitFactor) ? metrics.profitFactor.toFixed(2) : '∞'} · ` +
    `MDD ${metrics.maxDrawdownPercent.toFixed(2)}% · segments ${segments} · ` +
    `${variant.allSegmentsNonNegative ? 'CANDIDATE' : 'HOLD'}`);
}

function main() {
  const { candles, markets } = loadCandles(inputFile);
  const report = evaluateDailyMomentumVariants(candles, {
    variants: DEFAULT_DAILY_MOMENTUM_VARIANTS,
    segmentCount: Math.max(2, Math.floor(number(process.env.DAILY_MOMENTUM_SEGMENTS, 4))),
    baseConfig: {
      ...DEFAULT_DAILY_MOMENTUM_CONFIG,
      initialBalance: number(process.env.DAILY_MOMENTUM_INITIAL_BALANCE, 100_000_000),
      costPercent: number(process.env.DAILY_MOMENTUM_COST_PERCENT, 0.2),
      positionFraction: number(process.env.DAILY_MOMENTUM_POSITION_FRACTION, 0.25),
      maxPositions: Math.max(1, Math.floor(number(process.env.DAILY_MOMENTUM_MAX_POSITIONS, 4))),
      benchmarkExposureMinPercent: process.env.DAILY_MOMENTUM_BENCHMARK_EXPOSURE_MIN_PERCENT === undefined
        ? null
        : number(process.env.DAILY_MOMENTUM_BENCHMARK_EXPOSURE_MIN_PERCENT, null),
      benchmarkExposureMaxPercent: process.env.DAILY_MOMENTUM_BENCHMARK_EXPOSURE_MAX_PERCENT === undefined
        ? null
        : number(process.env.DAILY_MOMENTUM_BENCHMARK_EXPOSURE_MAX_PERCENT, null)
    }
  });
  const output = {
    ...report,
    inputFile,
    markets,
    promoted: false,
    note: '이 sweep는 동일한 완료 일봉과 비용 가정의 research-only 비교입니다. 어떤 variant도 runtime/live gate를 변경하지 않습니다.'
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`daily momentum study: ${markets.length} markets · ${inputFile}`);
  output.variants.forEach(printVariant);
  console.log(`saved: ${outputFile}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
