import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import UpbitAPI from '../api/upbit.js';
import { pathToFileURL } from 'node:url';
import { envList, envNumber, envString } from '../config/envConfig.js';

dotenv.config();

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const markets = [...new Set(envList('DAILY_MOMENTUM_MARKETS', ['KRW-BTC','KRW-ETH','KRW-XRP','KRW-SOL','KRW-DOGE','KRW-ADA','KRW-DOT','KRW-LINK','KRW-ATOM','KRW-NEAR','KRW-ETC','KRW-SUI'])
  .map(market => market.toUpperCase()))];
const days = Math.max(30, Math.floor(envNumber('DAILY_MOMENTUM_DAYS', 400)));
const outputFile = envString('DAILY_MOMENTUM_CANDLES_FILE', '/private/tmp/coinpilot-daily-momentum-candles.json');

export async function fetchMarketCandles(upbit, market, options = {}) {
  const requestedDays = options.days ?? days;
  const wait = options.sleepFn || sleep;
  const byTimestamp = new Map();
  let to = null;
  let remaining = requestedDays;
  while (remaining > 0) {
    const count = Math.min(200, remaining);
    const batch = await upbit.getDayCandles(market, count, to ? { to } : undefined);
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const candle of batch) {
      const timestamp = candle?.candle_date_time_utc;
      if (timestamp) byTimestamp.set(String(timestamp), candle);
    }
    const oldest = batch.at(-1)?.candle_date_time_utc;
    if (!oldest || oldest === to || batch.length < count) break;
    to = oldest;
    remaining -= batch.length;
    await wait(180);
  }
  return [...byTimestamp.values()]
    .sort((a, b) => String(a.candle_date_time_utc).localeCompare(String(b.candle_date_time_utc)));
}

async function main() {
  const upbit = new UpbitAPI('', '', { requestTimeoutMs: 10_000, minRequestIntervalMs: 180 });
  const candles = {};
  for (const market of markets) {
    candles[market] = await fetchMarketCandles(upbit, market);
    console.log(`${market}: ${candles[market].length} daily candles`);
  }
  const missing = markets.filter(market => candles[market].length < days - 2);
  if (missing.length) {
    throw new Error(`FAIL_CLOSED: requested history is incomplete for ${missing.join(', ')}`);
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'upbit_daily_candles',
    requestedDays: days,
    markets,
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
