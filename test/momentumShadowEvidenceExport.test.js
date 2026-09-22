import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportMomentumShadowEvidenceFromUrl } from '../src/scripts/exportMomentumShadowEvidence.js';

test('read-only API projection export sanitizes private fields and verifies fresh evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-evidence-export-'));
  const outputFile = path.join(root, 'evidence.json');
  const now = Date.parse('2026-09-17T00:00:00.000Z');
  try {
    const result = await exportMomentumShadowEvidenceFromUrl({
      sourceUrl: 'http://127.0.0.1:3000/api/momentum-shadow',
      outputFile,
      now,
      fetchImpl: async () => new Response(JSON.stringify({
        available: true,
        researchOnly: true,
        promoted: false,
        targetDir: '/Users/private/.paper-momentum-shadow-v1',
        candidateReadiness: {
          targetDir: '/Users/private/.paper-momentum-shadow-v2',
          ownerPid: 1234,
          launchAllowed: false
        },
        books: [{
          available: true,
          runnerPid: 1234,
          directory: '/Users/private/.paper-momentum-shadow-v1',
          markedReturnPercent: -2.5
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    });
    assert.equal(result.valid, true);
    assert.equal(result.fresh, true);
    assert.equal(result.sourceUrl, 'http://127.0.0.1:3000/api/momentum-shadow');
    const saved = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    assert.equal(saved.projection.targetDir, undefined);
    assert.equal(saved.projection.candidateReadiness.targetDir, undefined);
    assert.equal(saved.projection.candidateReadiness.ownerPid, undefined);
    assert.equal(saved.projection.books[0].runnerPid, undefined);
    assert.equal(saved.projection.books[0].directory, undefined);
    assert.equal(saved.projection.books[0].markedReturnPercent, -2.5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
