import fs from 'node:fs';
import path from 'node:path';
import {
  PAPER_EXIT_EVIDENCE_SCHEMA,
  summarizePaperExitEvidence
} from '../research/paperExitEvidence.js';

const ledgerInput = process.argv[2];
const outputFile = process.env.PAPER_EXIT_EVIDENCE_OUTPUT_FILE ||
  process.argv[3] || '/private/tmp/coinpilot-paper-exit-evidence.json';

function resolveLedgerFile(input) {
  const resolved = path.resolve(input);
  try {
    if (fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, 'paper_validation.json');
    }
  } catch {
    // Let the read below produce the actionable missing-path error.
  }
  return resolved;
}

function main() {
  if (!ledgerInput) {
    console.error('usage: node src/scripts/analyzePaperExitEvidence.js <paper_validation.json> [output.json]');
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

  const report = {
    schema: PAPER_EXIT_EVIDENCE_SCHEMA,
    generatedAt: new Date().toISOString(),
    researchOnly: true,
    promoted: false,
    ledgerFile: path.basename(path.resolve(ledgerFile)),
    sessionId: ledger?.sessionId || null,
    active: ledger?.active === true,
    strict: summarizePaperExitEvidence(ledger?.strictTrades, { profitField: 'profit' }),
    shadow: summarizePaperExitEvidence(ledger?.shadow?.closedTrades, { profitField: 'netProfit' }),
    looseShadow: summarizePaperExitEvidence(ledger?.looseShadow?.closedTrades, { profitField: 'netProfit' }),
    note: 'This report reads completed paper trades only. It does not modify the ledger, start/stop an owner, query a private API, place an order, or authorize promotion.'
  };

  const resolvedOutput = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, JSON.stringify(report, null, 2), 'utf8');
  console.log(`paper exit evidence: strict ${report.strict.validTradeCount} trades · shadow ${report.shadow.validTradeCount} · loose ${report.looseShadow.validTradeCount}`);
  console.log(`saved: ${resolvedOutput}`);
  console.log('판정: exit attribution diagnostic only · live promotion 불가');
}

main();
