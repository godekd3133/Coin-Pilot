import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import UpbitAPI from '../api/upbit.js';

dotenv.config();

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const number = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const markets = [...new Set((process.env.DAILY_MOMENTUM_MARKETS ||
  'KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL,KRW-DOGE,KRW-ADA,KRW-DOT,KRW-LINK,KRW-ATOM,KRW-NEAR,KRW-ETC,KRW-SUI')
  .split(',').map(market => market.trim().toUpperCase()).filter(Boolean))];
const days = Math.max(30, Math.floor(number(process.env.DAILY_MOMENTUM_DAYS, 400)));
const outputFile = process.env.DAILY_MOMENTUM_CANDLES_FILE || '/private/tmp/coinpilot-daily-momentum-candles.json';

async function fetchMarketCandles(upbit, market) {
  const byTimestamp = new Map();
  let to = null;
  let remaining = days;
  while (remaining > 0) {
    const count = Math.min(200, remaining);
    const batch = await upbit.requestWithRetry(async () => {
      const response = await axios.get(
        'https://api.upbit.com/v1/candles/days',
        upbit.getRequestConfig({ params: { market, count, ...(to ? { to } : {}) } })
      );
      return response.data;
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const candle of batch) {
      const timestamp = candle?.candle_date_time_utc;
      if (timestamp) byTimestamp.set(String(timestamp), candle);
    }
    const oldest = batch.at(-1)?.candle_date_time_utc;
    if (!oldest || oldest === to || batch.length < count) break;
    to = oldest;
    remaining -= batch.length;
    await sleep(180);
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

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
