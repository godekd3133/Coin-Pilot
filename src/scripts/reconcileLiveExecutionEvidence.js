import dotenv from 'dotenv';
import path from 'node:path';
import {
  LIVE_EXECUTION_EVIDENCE_SCHEMA,
  inspectLiveExecutionEvidenceFile
} from '../research/liveExecutionEvidence.js';

dotenv.config();

const projectRoot = path.resolve(new URL('../..', import.meta.url).pathname);
const configuredFile = process.env.LIVE_EXECUTION_EVIDENCE_FILE ||
  '.coinpilot-runtime/live-execution/evidence.jsonl';
const evidenceFile = path.isAbsolute(configuredFile)
  ? configuredFile
  : path.resolve(projectRoot, configuredFile);

function main() {
  const inspection = inspectLiveExecutionEvidenceFile(evidenceFile);
  if (!inspection.available && inspection.reconciliation === null && inspection.blockingReasons.length === 0) {
    console.log(JSON.stringify({
      schema: LIVE_EXECUTION_EVIDENCE_SCHEMA,
      researchOnly: true,
      promoted: false,
      evidenceFile,
      available: false,
      reason: 'evidence_file_not_found',
      note: 'No live order/fill evidence has been recorded. This command never queries or places an order.'
    }, null, 2));
    return;
  }
  console.log(JSON.stringify({
    schema: LIVE_EXECUTION_EVIDENCE_SCHEMA,
    researchOnly: true,
    promoted: false,
    evidenceFile,
    available: inspection.available,
    malformedLineCount: inspection.malformedLineCount,
    blockingReasons: inspection.blockingReasons,
    reconciliation: inspection.reconciliation
  }, null, 2));
}

main();
