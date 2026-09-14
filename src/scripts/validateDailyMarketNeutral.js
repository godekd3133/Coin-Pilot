import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DAILY_MARKET_NEUTRAL_CONFIG,
  DEFAULT_DAILY_MARKET_NEUTRAL_VARIANTS,
  evaluateDailyMarketNeutralCostSensitivity,
  evaluateDailyMarketNeutralVariants
} from '../research/dailyMarketNeutralStudy.js';

dotenv.config();

const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const inputFile = process.env.DAILY_MARKET_NEUTRAL_CANDLES_FILE ||
  process.env.DAILY_MOMENTUM_CANDLES_FILE || process.argv[2];
const outputFile = process.env.DAILY_MARKET_NEUTRAL_REPORT_FILE ||
  '/private/tmp/coinpilot-daily-market-neutral-report.json';

function loadCandles(file) {
  if (!file || !fs.existsSync(file)) {
    throw new Error('FAIL_CLOSED: DAILY_MARKET_NEUTRAL_CANDLES_FILE 또는 첫 번째 인자로 daily candle cache를 지정하세요.');
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const candles = parsed?.candles && typeof parsed.candles === 'object' ? parsed.candles : parsed;
  if (!candles || typeof candles !== 'object' || Array.isArray(candles)) {
    throw new Error('FAIL_CLOSED: daily candle cache 형식이 잘못되었습니다.');
  }
  const requestedMarkets = (process.env.DAILY_MARKET_NEUTRAL_MARKETS || Object.keys(candles).join(','))
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
    `MDD ${metrics.maxDrawdownPercent.toFixed(2)}% · long ${metrics.longExposurePercent.toFixed(1)}% · ` +
    `short ${metrics.shortExposurePercent.toFixed(1)}% · segments ${segments} · ` +
    `${variant.allSegmentsNonNegative ? 'CANDIDATE' : 'HOLD'}`);
}

function main() {
  const { candles, markets } = loadCandles(inputFile);
  const segmentCount = Math.max(2, Math.floor(number(process.env.DAILY_MARKET_NEUTRAL_SEGMENTS, 4)));
  const baseConfig = {
    ...DEFAULT_DAILY_MARKET_NEUTRAL_CONFIG,
    initialBalance: number(process.env.DAILY_MARKET_NEUTRAL_INITIAL_BALANCE, 100_000_000),
    costPercent: number(process.env.DAILY_MARKET_NEUTRAL_COST_PERCENT, 0.2),
    shortBorrowCostPercentPerDay: number(process.env.DAILY_MARKET_NEUTRAL_SHORT_BORROW_COST_PER_DAY, 0),
    longExposure: number(process.env.DAILY_MARKET_NEUTRAL_LONG_EXPOSURE, 0.4),
    shortExposure: number(process.env.DAILY_MARKET_NEUTRAL_SHORT_EXPOSURE, 0.4)
  };
  const report = evaluateDailyMarketNeutralVariants(candles, {
    variants: DEFAULT_DAILY_MARKET_NEUTRAL_VARIANTS,
    segmentCount,
    baseConfig
  });
  const costSensitivity = evaluateDailyMarketNeutralCostSensitivity(candles, {
    variant: DEFAULT_DAILY_MARKET_NEUTRAL_VARIANTS.find(variant =>
      variant.name === 'neutral_top3_bottom3_rebalance7'
    ),
    transactionCosts: [0.1, 0.2, 0.3],
    shortBorrowCostsPerDay: [0, 0.01, 0.03],
    segmentCount,
    baseConfig
  });
  const output = {
    ...report,
    inputFile,
    markets,
    costSensitivity,
    promoted: false,
    note: 'short leg는 synthetic inverse-return 연구이며 현재 Upbit 현물 주문 경로에 연결되지 않습니다. 어떤 variant도 live gate를 변경하지 않습니다.'
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`daily market-neutral study: ${markets.length} markets · synthetic short only`);
  output.variants.forEach(printVariant);
  console.log('cost sensitivity (top3/bottom3, rebalance7):');
  costSensitivity.rows.forEach(row => console.log(
    `  fee ${row.costPercent.toFixed(2)}% · borrow ${row.shortBorrowCostPercentPerDay.toFixed(2)}%/day · ` +
    `marked ${row.metrics.totalReturnPercent.toFixed(3)}% · realized ${row.metrics.realizedReturnPercent.toFixed(3)}% · ` +
    `segments ${row.segments.map(segment => segment.totalReturnPercent.toFixed(3) + '%').join(' / ')}`
  ));
  console.log(`saved: ${outputFile}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
