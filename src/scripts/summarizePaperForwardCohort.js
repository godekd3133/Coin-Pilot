import fs from 'node:fs';
import path from 'node:path';
import { summarizePaperForwardCohort } from '../research/paperForwardCohort.js';

const rootDir = process.env.PAPER_COHORT_ROOT || process.argv[2] || '.';
const outputFile = process.env.PAPER_COHORT_OUTPUT_FILE ||
  process.argv[3] || '/private/tmp/coinpilot-paper-forward-cohort.json';

const report = summarizePaperForwardCohort({ rootDir });
fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify({
  generatedAt: new Date().toISOString(),
  inputRoot: path.basename(path.resolve(rootDir)),
  ...report
}, null, 2), 'utf8');

console.log(`paper forward cohort: ${report.sessionCount} sessions · strict trades ${report.strictTradeCount} · diagnostic trades ${report.diagnosticTradeCount}`);
console.log(`config snapshots complete: ${report.configSnapshotCompleteSessionCount} · active/ended ${report.activeSessionCount || 0}/${report.endedSessionCount || 0} · strict profit mixed aggregate (not evidence): ${Number(report.totalStrictProfit || 0).toFixed(2)} KRW`);
console.log(`integrity eligible strict cohort: ${report.eligibleStrictSessionCount} sessions · ${report.eligibleStrictTradeCount} trades · ${report.eligibleStrictConfigCount || 0} configs`);
const evidenceProfit = report.profitabilityEvidenceProfitAggregation === 'single_config'
  ? `${Number(report.profitabilityEvidenceProfit || 0).toFixed(2)} KRW`
  : `합산 보류 (${report.profitabilityEvidenceConfigCount || 0}개 config)`;
console.log(`profitability evidence cohort: ${report.profitabilityEvidenceSessionCount || 0} sessions · ${report.profitabilityEvidenceTradeCount || 0} trades · ${evidenceProfit}`);
if (Array.isArray(report.eligibleStrictConfigGroups) && report.eligibleStrictConfigGroups.length > 0) {
  console.log(`integrity config groups: ${report.eligibleStrictConfigGroups.map(group => `${group.configFingerprint}=${group.profit.toFixed(2)} KRW/${group.tradeCount} trades`).join(' · ')}`);
}
console.log(`saved: ${outputFile}`);
console.log('판정: cohort diagnostic only · live promotion 불가');
