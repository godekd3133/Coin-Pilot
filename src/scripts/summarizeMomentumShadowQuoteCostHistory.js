import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  finiteCompatibilityNumber,
  summarizeQuoteExecutionCostHistory
} from '../research/quoteExecutionCostCompatibility.js';
import { resolveMomentumShadowQuoteRuntimeFile } from '../research/momentumShadowQuoteHistory.js';

dotenv.config();

const historyFile = path.resolve(
  process.env.MOMO_SHADOW_QUOTE_HISTORY_FILE ||
    resolveMomentumShadowQuoteRuntimeFile('quote-history.jsonl')
);
const depthNotionalArgument = process.argv.find(argument =>
  argument.startsWith('--depth-notionals=')
);
const referenceNotionalsKrw = depthNotionalArgument
  ? depthNotionalArgument.slice('--depth-notionals='.length)
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value > 0)
  : [];

function main() {
  if (!fs.existsSync(historyFile)) {
    console.error('quote history not found');
    process.exitCode = 1;
    return;
  }

  let lines;
  try {
    lines = fs.readFileSync(historyFile, 'utf8').split(/\r?\n/).filter(Boolean);
  } catch {
    console.error('quote history not readable');
    process.exitCode = 1;
    return;
  }

  const records = [];
  let invalidRecordCount = 0;
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      invalidRecordCount += 1;
    }
  }

  const result = summarizeQuoteExecutionCostHistory({
    records,
    invalidRecordCount,
    tradingFee: finiteCompatibilityNumber(process.env.SCALP_VALIDATION_FEE, 0.0005),
    slippage: finiteCompatibilityNumber(process.env.SCALP_VALIDATION_SLIPPAGE, 0.001),
    minimumReports: 30,
    minimumSamplesPerReport: 5,
    expectedIntervalSeconds: 600,
    freshnessLimitSeconds: 900,
    referenceNotionalsKrw
  });

  console.log(JSON.stringify({ sourceFile: path.basename(historyFile), ...result }, null, 2));
  if (result.historyRecordCount === 0) process.exitCode = 1;
}

main();
