import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = path.join(projectRoot, 'src/scripts/startMomentumShadowCandidateIfReady.js');

test('candidate launcher fails closed for an unknown profile instead of falling back to baseline', () => {
  const result = spawnSync(process.execPath, [launcher], {
    cwd: projectRoot,
    env: {
      ...process.env,
      MOMO_SHADOW_CANDIDATE_PROFILE: 'typo_profile'
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 4);
  assert.match(result.stderr, /unknown MOMO_SHADOW_CANDIDATE_PROFILE=typo_profile/);
  assert.doesNotMatch(result.stdout, /candidateConfig/);
});

test('candidate launcher seals the loss-cap profile as a fixed two-day research contract', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-candidate-launcher-'));
  const benchmarkDir = path.join(root, 'benchmark');
  const ownerDir = path.join(root, 'owner');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  fs.mkdirSync(ownerDir, { recursive: true });
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: new Date().toISOString(),
    benchmarkGateOpen: false,
    benchmarkTrendPercent: 0,
    config: {
      pollMs: 900_000,
      benchmarkTrendMinPercent: 2
    },
    dataQuality: {
      valid: true,
      reason: 'daily_grid_aligned_and_contiguous',
      marketCount: 12,
      missingMarkets: [],
      invalidMarkets: [],
      unalignedMarkets: [],
      staleMarkets: []
    },
    positions: {},
    trades: [],
    pendingEntries: []
  }));

  try {
    const result = spawnSync(process.execPath, [launcher], {
      cwd: projectRoot,
      env: {
        ...process.env,
        MOMO_SHADOW_CANDIDATE_PROFILE: 'loss_cap',
        MOMO_SHADOW_BENCHMARK_DIR: benchmarkDir,
        MOMO_SHADOW_OWNER_DIRS: ownerDir,
        MOMO_SHADOW_CANDIDATE_SLOT_FILE: path.join(root, 'candidate-slot.json'),
        MOMO_SHADOW_CANDIDATE_DIR: path.join(root, 'candidate-target')
      },
      encoding: 'utf8'
    });

    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.candidateProfile, 'loss_cap');
    assert.equal(payload.candidateConfig.mode, 'fixed');
    assert.equal(payload.candidateConfig.maxHoldHours, 48);
    assert.equal(payload.candidateConfig.stopLossPercent, 4);
    assert.equal(payload.candidateConfig.takeProfitPercent, 0);
    assert.match(payload.targetDir, /candidate-target/);
    assert.ok(payload.blockers.includes('benchmark_gate_closed'));
    assert.equal(payload.blockers.some(blocker => blocker.startsWith('existing_live_owner_count:')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
