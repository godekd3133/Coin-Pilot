import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_SCHEMA,
  DEFAULT_MOMENTUM_SHADOW_EVIDENCE_MAX_AGE_SECONDS,
  DEFAULT_MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_FILE,
  sanitizeMomentumShadowEvidenceValue,
  verifyMomentumShadowEvidenceSnapshot
} from '../research/momentumShadowEvidenceSnapshot.js';

const DEFAULT_SOURCE_URL = 'http://127.0.0.1:3000/api/momentum-shadow';

export async function exportMomentumShadowEvidenceFromUrl({
  sourceUrl = DEFAULT_SOURCE_URL,
  outputFile = DEFAULT_MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_FILE,
  fetchImpl = globalThis.fetch,
  now = Date.now()
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('FAIL_CLOSED: fetch is unavailable');
  const response = await fetchImpl(sourceUrl, {
    headers: { accept: 'application/json' },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`FAIL_CLOSED: evidence source returned HTTP ${response.status}`);
  const projection = await response.json();
  const snapshot = {
    schema: MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_SCHEMA,
    exportedAt: new Date(now).toISOString(),
    source: 'read-only /api/momentum-shadow projection',
    researchOnly: true,
    promoted: false,
    note: '이 파일은 paper/research projection 보관본이며 실제 fill, wallet settlement, live profitability 또는 주문 승인을 증명하지 않습니다.',
    projection: sanitizeMomentumShadowEvidenceValue(projection)
  };
  const raw = JSON.stringify(snapshot, null, 2);
  const resolvedOutput = path.resolve(outputFile);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, raw);
  const verification = verifyMomentumShadowEvidenceSnapshot(
    snapshot,
    now,
    DEFAULT_MOMENTUM_SHADOW_EVIDENCE_MAX_AGE_SECONDS
  );
  return {
    ...verification,
    sourceUrl,
    outputFile: resolvedOutput,
    bytes: Buffer.byteLength(raw),
    sha256: crypto.createHash('sha256').update(raw).digest('hex')
  };
}

async function main() {
  const result = await exportMomentumShadowEvidenceFromUrl({
    sourceUrl: process.argv[2] || DEFAULT_SOURCE_URL,
    outputFile: process.argv[3] || DEFAULT_MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_FILE
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 2;
  else if (!result.fresh) process.exitCode = 3;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
