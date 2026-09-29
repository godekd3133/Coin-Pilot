import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import UpbitAPI from '../api/upbit.js';
import { pathToFileURL } from 'node:url';
import {
  analyzeHistoricalCandleContinuity,
  historicalTimestampForCandle
} from '../backtest/scalpingBacktest.js';
import { fillNoTradeCandleGaps } from '../research/historicalCandleSeries.js';

dotenv.config();

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const markets = [...new Set((process.env.SCALP_HTF_MOMENTUM_MARKETS ||
  'KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL')
  .split(',')
  .map(market => market.trim().toUpperCase())
  .filter(Boolean))];
const baseCandleUnit = Math.max(1, Math.floor(number(process.env.SCALP_HTF_BASE_CANDLE_UNIT, 15)));
const requestedCandleCount = Math.max(200, Math.floor(number(
  process.env.SCALP_HTF_MOMENTUM_CANDLE_COUNT,
  8_000
)));
const outputFile = process.env.SCALP_HTF_MOMENTUM_CANDLES_FILE ||
  process.argv[2] || '/private/tmp/coinpilot-htf-momentum-candles.json';
const fillNoTrade = process.env.SCALP_HTF_MOMENTUM_FILL_NO_TRADE === 'true';
const maxFillIntervals = Math.max(0, Math.floor(number(
  process.env.SCALP_HTF_MOMENTUM_MAX_FILL_INTERVALS,
  4
)));

export async function fetchMarketCandles(upbit, market, asOfTimestamp, options = {}) {
  const candleUnit = options.baseCandleUnit ?? baseCandleUnit;
  const targetCandleCount = options.requestedCandleCount ?? requestedCandleCount;
  const wait = options.sleepFn || sleep;
  const byTimestamp = new Map();
  let to = null;
  let requestCount = 0;
  let discardedPartialCount = 0;

  while (byTimestamp.size < targetCandleCount) {
    const count = Math.min(200, targetCandleCount - byTimestamp.size);
    const batch = to
      ? await upbit.getMinuteCandles(market, candleUnit, count, { to })
      : await upbit.getMinuteCandles(market, candleUnit, count);
    requestCount += 1;
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const candle of batch) {
      const timestamp = historicalTimestampForCandle(candle);
      if (timestamp === null) continue;
      if (timestamp + candleUnit * 60 * 1000 > asOfTimestamp) {
        discardedPartialCount += 1;
        continue;
      }
      byTimestamp.set(timestamp, candle);
    }

    const oldest = batch
      .map(historicalTimestampForCandle)
      .filter(timestamp => timestamp !== null)
      .sort((a, b) => a - b)[0];
    const oldestIso = oldest === undefined || oldest === null
      ? null
      : new Date(oldest).toISOString();
    if (oldestIso === null || oldestIso === to) break;
    to = oldestIso;
    if (batch.length < count) break;
    await wait(180);
  }

  const candles = [...byTimestamp.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-targetCandleCount)
    .map(([, candle]) => candle);
  const continuity = analyzeHistoricalCandleContinuity(candles, candleUnit);
  return {
    candles,
    requestCount,
    discardedPartialCount,
    continuity
  };
}

async function main() {
  const asOfTimestamp = Date.now();
  const upbit = new UpbitAPI('', '', {
    requestTimeoutMs: number(process.env.UPBIT_REQUEST_TIMEOUT_MS, 10_000),
    minRequestIntervalMs: 180
  });
  const candles = {};
  const metadata = {};

  for (const market of markets) {
    const result = await fetchMarketCandles(upbit, market, asOfTimestamp);
    const rawContinuity = result.continuity;
    let marketCandles = result.candles;
    let fillMetadata = null;
    if (!rawContinuity.valid && fillNoTrade) {
      const filled = fillNoTradeCandleGaps(marketCandles, baseCandleUnit, {
        maxFillIntervals
      });
      marketCandles = filled.candles;
      fillMetadata = filled.dataQuality;
    }
    const continuity = analyzeHistoricalCandleContinuity(marketCandles, baseCandleUnit);
    candles[market] = marketCandles;
    metadata[market] = {
      requestCount: result.requestCount,
      discardedPartialCount: result.discardedPartialCount,
      rawContinuity,
      continuity,
      noTradeFill: fillMetadata
    };
    console.log(`${market}: ${marketCandles.length} completed ${baseCandleUnit}m candles · ` +
      `continuity=${continuity.valid ? 'valid' : continuity.reason}` +
      ` · gaps=${continuity.gapCount} · largestGapMinutes=${(continuity.largestGapSeconds / 60).toFixed(1)}` +
      `${fillMetadata ? ` · synthetic=${fillMetadata.syntheticNoTradeCount}` : ''}`);
  }

  const missing = markets.filter(market => candles[market].length < requestedCandleCount - 2);
  if (missing.length > 0) {
    throw new Error(`FAIL_CLOSED: requested history is incomplete for ${missing.join(', ')}`);
  }
  const invalidContinuity = markets.filter(market => !metadata[market].continuity.valid);
  if (invalidContinuity.length > 0) {
    throw new Error(`FAIL_CLOSED: raw candle continuity is invalid for ${invalidContinuity.join(', ')}`);
  }

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: new Date(asOfTimestamp).toISOString(),
    source: 'upbit_minute_candles',
    researchOnly: true,
    promoted: false,
    promotionEligible: false,
    noTradeFillEnabled: fillNoTrade,
    maxFillIntervals,
    baseCandleUnit,
    requestedCandleCount,
    markets,
    metadata,
    candles
  }, null, 2));
  console.log(`saved: ${outputFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
