import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MOMENTUM_SHADOW_EVIDENCE_MAX_AGE_SECONDS,
  DEFAULT_MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_FILE,
  verifyMomentumShadowEvidenceSnapshot
} from '../research/momentumShadowEvidenceSnapshot.js';

const configuredFile = process.env.MOMO_SHADOW_EVIDENCE_SNAPSHOT_FILE || process.argv[2];
const file = configuredFile
  ? path.resolve(configuredFile)
  : path.resolve(DEFAULT_MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_FILE);
const configuredMaxAge = process.env.MOMO_SHADOW_EVIDENCE_MAX_AGE_SECONDS;
const maxAgeSeconds = Number.isFinite(Number(configuredMaxAge)) && Number(configuredMaxAge) >= 60
  ? Number(configuredMaxAge)
  : DEFAULT_MOMENTUM_SHADOW_EVIDENCE_MAX_AGE_SECONDS;

function main() {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    console.error(`evidence snapshot not readable: ${file}`);
    process.exitCode = 1;
    return;
  }
  let snapshot;
  try {
    snapshot = JSON.parse(raw.toString('utf8'));
  } catch {
    console.error(`evidence snapshot JSON invalid: ${file}`);
    process.exitCode = 1;
    return;
  }
  const verification = verifyMomentumShadowEvidenceSnapshot(
    snapshot,
    Date.now(),
    maxAgeSeconds
  );
  const output = {
    ...verification,
    file,
    bytes: raw.length,
    sha256: crypto.createHash('sha256').update(raw).digest('hex')
  };
  console.log(JSON.stringify(output, null, 2));
  if (!verification.valid) process.exitCode = 2;
  else if (!verification.fresh) process.exitCode = 3;
}

main();
