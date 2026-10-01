import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizePaperForwardHealth } from '../research/paperForwardHealth.js';
import { observeProcessExistence } from '../research/paperForwardOwnerProbe.js';
export { observeProcessExistence } from '../research/paperForwardOwnerProbe.js';

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function runPaperForwardHealthCli(args = process.argv.slice(2)) {
  if (args.length !== 1 || typeof args[0] !== 'string' || args[0].trim() === '') {
    writeJson({
      reportType: 'paper_forward_owner_and_strict_hold',
      researchOnly: true,
      promoted: false,
      error: {
        code: args.length === 0 ? 'ledger_path_required' : 'exactly_one_ledger_path_required',
        message: 'Pass one explicit paper_validation.json path.'
      },
      source: { ledgerPath: null, sessionId: null }
    });
    process.exitCode = 1;
    return;
  }

  const ledgerPath = path.resolve(args[0]);
  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch (error) {
    writeJson({
      reportType: 'paper_forward_owner_and_strict_hold',
      researchOnly: true,
      promoted: false,
      error: {
        code: error instanceof SyntaxError ? 'ledger_json_invalid' : 'ledger_read_failed',
        message: error.message
      },
      source: { ledgerPath, sessionId: null }
    });
    process.exitCode = 1;
    return;
  }

  const processObservation = observeProcessExistence(ledger?.processId);
  const report = summarizePaperForwardHealth({
    ledger,
    now: Date.now(),
    processExistsObservation: processObservation
  });
  report.source = {
    ledgerPath,
    sessionId: typeof ledger?.sessionId === 'string' ? ledger.sessionId : null
  };
  writeJson(report);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runPaperForwardHealthCli();
}
