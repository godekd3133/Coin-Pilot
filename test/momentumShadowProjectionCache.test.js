import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import createResearchRoutes from '../src/api/routes/research.js';

test('momentum-shadow reuses one read-only projection within its bounded freshness window', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shadow-projection-cache-'));
  const cohortRoot = path.join(tempRoot, 'paper-forward-cohort');
  fs.mkdirSync(cohortRoot, { recursive: true });
  const bookConfigKeys = [
    'momentumShadowFixedDir',
    'momentumShadowRegimeDir',
    'momentumShadowBenchmarkDir',
    'momentumShadowVolatilityDir',
    'momentumShadowNextOpenDir',
    'momentumShadowFixedHoldDir',
    'momentumShadowFixedHoldLossCapDir',
    'momentumShadowFixedHoldLossCapNoDogeDir',
    'momentumShadowFixedHoldSpreadDir',
    'momentumShadowFixedHoldRelativeDir',
    'momentumShadowFixedHoldQuoteCrossDir'
  ];
  const config = {
    momentumShadowCandidateDir: path.join(tempRoot, 'candidate'),
    momentumShadowCandidateSlotFile: path.join(tempRoot, 'candidate-slot.json'),
    momentumShadowQuoteHistoryFile: path.join(tempRoot, 'quote-history.jsonl'),
    momentumShadowQuoteReportFile: path.join(tempRoot, 'quote-quality.json')
  };
  bookConfigKeys.forEach(key => { config[key] = path.join(tempRoot, key); });

  const trader = {
    dryRun: true,
    readOnlyObserver: true,
    liveExecutionEvidenceFile: path.join(tempRoot, 'live-execution-evidence.jsonl'),
    config
  };
  let now = 1_000;
  const app = express();
  app.use('/api', createResearchRoutes({ tradingSystem: trader }, {
    paperForwardCohortRootDir: cohortRoot,
    momentumShadowProjectionCacheMs: 500,
    projectionClock: () => now
  }));

  const previousOwnerDirs = process.env.MOMO_SHADOW_OWNER_DIRS;
  process.env.MOMO_SHADOW_OWNER_DIRS = '';
  let server = null;
  try {
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.once('error', reject);
    });
    const getProjection = async () => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/momentum-shadow`);
      assert.equal(response.status, 200);
      return response.json();
    };

    const first = await getProjection();
    assert.equal(first.paperForwardCohort.sessionCount, 0);
    assert.equal(first.projectionFetchedAt, new Date(1_000).toISOString());
    assert.equal(first.projectionAgeMs, 0);

    const sessionDir = path.join(cohortRoot, '.paper-forward-synthetic-cache-test');
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'paper_validation.json'), '{}', 'utf8');
    now += 250;

    const cached = await getProjection();
    assert.equal(cached.paperForwardCohort.sessionCount, 0, 'the existing snapshot is reused before its TTL expires');
    assert.equal(cached.projectionFetchedAt, first.projectionFetchedAt);
    assert.equal(cached.projectionAgeMs, 250);

    now += 250;
    const refreshed = await getProjection();
    assert.equal(refreshed.paperForwardCohort.sessionCount, 1, 'the next request refreshes at the TTL boundary');
    assert.equal(refreshed.projectionFetchedAt, new Date(1_500).toISOString());
    assert.equal(refreshed.projectionAgeMs, 0);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    if (previousOwnerDirs === undefined) delete process.env.MOMO_SHADOW_OWNER_DIRS;
    else process.env.MOMO_SHADOW_OWNER_DIRS = previousOwnerDirs;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
