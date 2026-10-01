import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import UpbitAPI from '../api/upbit.js';
import { pathToFileURL } from 'node:url';
import {
  projectMomentumShadowQuote,
  summarizeMomentumShadowQuoteSamples
} from '../research/momentumShadowQuoteQuality.js';
import {
  resolveMomentumShadowQuoteRuntimeFile
} from '../research/momentumShadowQuoteHistory.js';
import { envList, envNumber, envRaw } from '../config/envConfig.js';

dotenv.config();

const markets = [...new Set(envList('MOMO_SHADOW_QUOTE_MARKETS', ['KRW-BTC','KRW-ETH','KRW-XRP','KRW-SOL','KRW-DOGE','KRW-ADA','KRW-DOT','KRW-LINK','KRW-ATOM','KRW-NEAR','KRW-ETC','KRW-SUI']))];
const sampleCount = Math.max(1, Math.floor(envNumber('MOMO_SHADOW_QUOTE_SAMPLES', NaN) || 5));
const intervalMs = Math.max(0, Math.floor(envNumber('MOMO_SHADOW_QUOTE_INTERVAL_MS', NaN) || 2_000));
const configuredMaxSpread = envNumber('MOMO_SHADOW_QUOTE_MAX_SPREAD_PERCENT', NaN);
const maxSpreadPercent = Number.isFinite(configuredMaxSpread)
  ? Math.max(0, configuredMaxSpread)
  : 0.5;
const outputFile = envRaw('MOMO_SHADOW_QUOTE_REPORT_FILE') ||
  resolveMomentumShadowQuoteRuntimeFile('quote-quality.json');
const historyFile = envRaw('MOMO_SHADOW_QUOTE_HISTORY_FILE') ||
  resolveMomentumShadowQuoteRuntimeFile('quote-history.jsonl');
const upbit = new UpbitAPI('', '', { requestTimeoutMs: 10_000 });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function fetchQuotes(api = upbit, quoteMarkets = markets) {
  const orderbooks = await api.getOrderbook(quoteMarkets.join(','));
  return (orderbooks || [])
    .filter(book => book?.market)
    .map(book => projectMomentumShadowQuote(book.market, book));
}

async function main() {
  const startedAt = new Date().toISOString();
  const samples = [];
  const errors = [];
  for (let index = 0; index < sampleCount; index += 1) {
    try {
      samples.push({ at: new Date().toISOString(), quotes: await fetchQuotes() });
    } catch (error) {
      errors.push({ at: new Date().toISOString(), message: error.message });
    }
    if (index + 1 < sampleCount) await sleep(intervalMs);
  }
  const summary = summarizeMomentumShadowQuoteSamples({
    markets,
    samples,
    maxSpreadPercent
  });
  const output = {
    generatedAt: new Date().toISOString(),
    startedAt,
    researchOnly: true,
    promoted: false,
    source: 'upbit_orderbook_best_level',
    markets,
    requestedSampleCount: sampleCount,
    intervalMs,
    errors,
    complete: errors.length === 0 && summary.valid,
    maxSpreadPercent,
    samples,
    summary,
    note: 'Best bid/ask observations are quote-quality evidence only; they are not fills, realized P&L, or live-order authorization.'
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  fs.mkdirSync(path.dirname(historyFile), { recursive: true });
  fs.appendFileSync(historyFile, `${JSON.stringify({
    generatedAt: output.generatedAt,
    complete: output.complete,
    sampleCount: samples.length,
    requestedSampleCount: sampleCount,
    errors: errors.length,
    maxSpreadPercent,
    summary
  })}\n`);
  console.log(`momentum shadow quote samples: ${samples.length}/${sampleCount} · ${markets.length} markets`);
  console.log(`complete: ${output.complete} · errors: ${errors.length} · spread ceiling: ${maxSpreadPercent}%`);
  for (const [market, row] of Object.entries(summary.markets)) {
    console.log(`${market}: samples ${row.sampleCount} · median ${row.median === null ? '—' : row.median.toFixed(3)}% · p95 ${row.p95 === null ? '—' : row.p95.toFixed(3)}% · max ${row.max === null ? '—' : row.max.toFixed(3)}% · over ceiling ${row.overCeiling}`);
  }
  console.log(`saved: ${outputFile}`);
  console.log(`history: ${historyFile}`);
  if (!output.complete) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
