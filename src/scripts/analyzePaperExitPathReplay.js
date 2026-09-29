import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import UpbitAPI from '../api/upbit.js';
import { buildPaperExitPathReplay } from '../research/paperExitPathReplay.js';

const INPUT_LIMIT = 20;
const REQUEST_SPACING_MS = 1_200;
const CANDLE_COUNT = 80;
const MINUTE_CANDLE_URL = 'https://api.upbit.com/v1/candles/minutes/1';
const ledgerInput = process.argv[2];
const outputFile = process.env.PAPER_EXIT_PATH_REPLAY_OUTPUT_FILE ||
  process.argv[3] || '/private/tmp/coinpilot-paper-exit-path-replay.json';

function resolveLedgerFile(input) {
  const resolved = path.resolve(input);
  try {
    if (fs.statSync(resolved).isDirectory()) return path.join(resolved, 'paper_validation.json');
  } catch {
    // The subsequent read produces the actionable missing-file diagnostic.
  }
  return resolved;
}

function iso8601(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function fetchMinuteCandles(trade, upbit) {
  const market = String(trade?.coin || '').trim().toUpperCase();
  const to = iso8601(trade?.exitTime || trade?.exitTimestamp);
  if (!/^KRW-[A-Z0-9]{2,15}$/.test(market) || !to) {
    throw new Error('trade_market_or_exit_time_invalid');
  }
  let candles;
  try {
    candles = await upbit.getMinuteCandles(market, 1, CANDLE_COUNT, { to });
  } catch (error) {
    if (Number.isInteger(error?.response?.status)) {
      throw new Error(`public_minute_candle_http_${error.response.status}`, { cause: error });
    }
    throw error;
  }
  if (!Array.isArray(candles)) throw new Error('public_minute_candle_payload_invalid');
  return { market, to, candles };
}

async function main() {
  if (!ledgerInput) {
    console.error('usage: node src/scripts/analyzePaperExitPathReplay.js <paper_validation.json|paper-forward-dir> [output.json]');
    process.exitCode = 2;
    return;
  }

  const ledgerFile = resolveLedgerFile(ledgerInput);
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  } catch (error) {
    console.error(`paper ledger read failed: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const allTrades = (Array.isArray(ledger?.strictTrades) ? ledger.strictTrades : [])
    .filter(trade => trade?.type === 'CLOSE' || trade?.action === 'CLOSE' || trade?.action === 'PARTIAL_CLOSE');
  const trades = allTrades.slice(-INPUT_LIMIT);
  const upbit = new UpbitAPI('', '', { requestTimeoutMs: 10_000 });
  const candleResponses = [];
  const fetchErrors = [];
  const requests = [];

  for (let index = 0; index < trades.length; index += 1) {
    const trade = trades[index];
    try {
      const fetched = await fetchMinuteCandles(trade, upbit);
      candleResponses.push(fetched.candles);
      requests.push({ market: fetched.market, to: fetched.to, count: CANDLE_COUNT, returnedCount: fetched.candles.length });
    } catch (error) {
      candleResponses.push([]);
      const failure = {
        tradeIndex: index,
        market: trade?.coin || null,
        exitTime: trade?.exitTime || trade?.exitTimestamp || null,
        reason: error.message
      };
      fetchErrors.push(failure);
      requests.push({ market: trade?.coin || null, to: trade?.exitTime || trade?.exitTimestamp || null, count: CANDLE_COUNT, error: error.message });
    }
    if (index + 1 < trades.length) await delay(REQUEST_SPACING_MS);
  }

  const analysis = buildPaperExitPathReplay({ ledger, trades, candleResponses });
  const report = {
    ...analysis,
    generatedAt: new Date().toISOString(),
    source: {
      provider: 'Upbit public minute-candle API',
      endpoint: MINUTE_CANDLE_URL,
      documentation: 'https://docs.upbit.com/kr/reference/list-candles-minutes',
      unitMinutes: 1,
      countPerRequest: CANDLE_COUNT,
      minimumRequestSpacingMs: REQUEST_SPACING_MS,
      requestedTradeCount: trades.length,
      sourceLedgerName: path.basename(ledgerFile)
    },
    requests,
    fetchErrors
  };
  const resolvedOutput = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, JSON.stringify(report, null, 2), 'utf8');
  console.log(`paper exit path replay: ${report.coverage.completeTradeCount}/${report.coverage.tradeCount} complete candle paths`);
  console.log(`scenarios: ${report.scenarios.map(row => `TP${row.takeProfitPercent}% ${row.costAdjustedNetPnlKrw === null ? 'unavailable' : `${row.costAdjustedNetPnlKrw.toFixed(2)} KRW`}`).join(' · ')}`);
  console.log(`research-only output: ${resolvedOutput}`);
  console.log('No order, ledger, owner, or strategy configuration was changed.');
  if (!report.available || fetchErrors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`paper exit path replay failed: ${error.message}`);
    process.exitCode = 1;
  });
}
