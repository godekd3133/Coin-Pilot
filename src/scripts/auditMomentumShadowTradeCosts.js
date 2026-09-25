import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveMomentumShadowQuoteRuntimeFile
} from '../research/momentumShadowQuoteHistory.js';
import { summarizeMomentumShadowTradeCostAudit } from '../research/momentumShadowTradeCostAudit.js';

dotenv.config();

const ledgerArgument = process.argv[2] || '.paper-momentum-shadow-v1/ledger.json';
const ledgerArgumentPath = path.resolve(ledgerArgument);
const ledgerFile = fs.existsSync(ledgerArgumentPath) && fs.statSync(ledgerArgumentPath).isDirectory()
  ? path.join(ledgerArgumentPath, 'ledger.json')
  : ledgerArgumentPath;
const historyFile = path.resolve(
  process.argv[3] || process.env.MOMO_SHADOW_QUOTE_HISTORY_FILE ||
    resolveMomentumShadowQuoteRuntimeFile('quote-history.jsonl')
);

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} unavailable: ${error.message}`, { cause: error });
  }
}

function readQuoteHistory(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`quote history unavailable: ${error.message}`, { cause: error });
  }
  const records = [];
  let invalidRecordCount = 0;
  for (const line of source.split(/\r?\n/).filter(Boolean)) {
    try { records.push(JSON.parse(line)); } catch { invalidRecordCount += 1; }
  }
  return { records, invalidRecordCount };
}

function main() {
  let ledger;
  let history;
  try {
    ledger = readJsonFile(ledgerFile, 'paper ledger');
    history = readQuoteHistory(historyFile);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const result = summarizeMomentumShadowTradeCostAudit({
    ledger,
    quoteHistoryRecords: history.records,
    invalidQuoteHistoryRecordCount: history.invalidRecordCount
  });
  console.log(JSON.stringify({
    source: {
      ledgerDirectory: path.basename(path.dirname(ledgerFile)),
      ledgerFile: path.basename(ledgerFile),
      quoteHistoryFile: path.basename(historyFile)
    },
    ...result
  }, null, 2));
}

main();
