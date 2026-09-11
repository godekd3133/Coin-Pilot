import fs from 'node:fs';
import dotenv from 'dotenv';
import assessReplayRobustness from '../ai/replayRobustness.js';

dotenv.config();

const files = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : String(process.env.AI_ROBUSTNESS_REPORT_FILES || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);

if (files.length === 0) {
  console.error('사용법: npm run ai:robustness -- /tmp/replay-a.json /tmp/replay-b.json');
  process.exit(1);
}

try {
  const reports = files.map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
  const result = assessReplayRobustness(reports, {
    neutralBandPercent: Number(process.env.AI_REPLAY_NEUTRAL_BAND_PERCENT) || 0.3,
    minimumNonNeutralSamples: Number(process.env.AI_ROBUSTNESS_MIN_NON_NEUTRAL) || 20
  });
  const outputFile = process.env.AI_ROBUSTNESS_OUTPUT_FILE || '';
  if (outputFile) fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify({ ...result, outputFile: outputFile || null }, null, 2));
  if (result.status === 'INSUFFICIENT_WINDOWS' || result.status === 'INSUFFICIENT_NON_NEUTRAL' || result.status === 'WINDOW_CONFLICT') {
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`❌ AI replay robustness 오류: ${error.message}`);
  process.exitCode = 1;
}
