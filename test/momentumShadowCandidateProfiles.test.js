import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  MOMENTUM_SHADOW_CANDIDATE_PROFILES,
  resolveMomentumShadowCandidateProfile,
  getMomentumShadowHistoricalEvidence
} from '../src/research/momentumShadowCandidateProfiles.js';

test('candidate profile resolver keeps the baseline contract environment-driven', () => {
  const result = resolveMomentumShadowCandidateProfile({
    env: {
      MOMO_SHADOW_CANDIDATE_PROFILE: 'baseline',
      MOMO_SHADOW_MODE: 'regime',
      MOMO_SHADOW_BREADTH_MIN: '4',
      MOMO_SHADOW_CANDIDATE_DIR: '/tmp/coinpilot-baseline-candidate'
    }
  });

  assert.deepEqual(MOMENTUM_SHADOW_CANDIDATE_PROFILES, [
    'baseline',
    'quote_cross',
    'loss_cap',
    'loss_cap_no_doge'
  ]);
  assert.equal(result.candidateProfile, 'baseline');
  assert.equal(result.targetDir, '/tmp/coinpilot-baseline-candidate');
  assert.equal(result.candidateConfig.breadthMin, 4);
  assert.equal(result.candidateConfig.executionModel, 'candle_close');
  assert.equal(result.requireQuoteQuality, false);
});

test('candidate profile resolver seals loss-cap identity and settings', () => {
  const result = resolveMomentumShadowCandidateProfile({
    profile: 'loss_cap',
    env: {
      MOMO_SHADOW_CANDIDATE_PROFILE: 'loss_cap',
      MOMO_SHADOW_MODE: 'regime',
      MOMO_SHADOW_STOP_LOSS_PERCENT: '99',
      MOMO_SHADOW_CANDIDATE_DIR: '',
      MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_DIR: '/tmp/coinpilot-loss-cap'
    }
  });

  assert.equal(result.candidateProfile, 'loss_cap');
  assert.equal(result.targetDir, '/tmp/coinpilot-loss-cap');
  assert.equal(result.candidateConfig.mode, 'fixed');
  assert.equal(result.candidateConfig.maxHoldHours, 48);
  assert.equal(result.candidateConfig.entryExecution, 'next_open');
  assert.equal(result.candidateConfig.executionModel, 'candle_close');
  assert.equal(result.candidateConfig.stopLossPercent, 4);
  assert.equal(result.candidateConfig.takeProfitPercent, 0);
  assert.equal(result.requireQuoteQuality, false);
});

test('candidate profile resolver requires fresh quote evidence for quote-cross', () => {
  const result = resolveMomentumShadowCandidateProfile({
    profile: 'quote_cross',
    env: {
      MOMO_SHADOW_FIXED_HOLD_QUOTE_CROSS_DIR: '/tmp/coinpilot-quote-cross'
    }
  });

  assert.equal(result.targetDir, '/tmp/coinpilot-quote-cross');
  assert.equal(result.candidateConfig.entryExecution, 'next_open');
  assert.equal(result.candidateConfig.executionModel, 'quote_cross');
  assert.equal(result.candidateConfig.maxSpreadPercent, 0.5);
  assert.equal(result.requireQuoteQuality, true);
});

test('candidate profile resolver seals the daily-study loss-cap no-DOGE candidate', () => {
  const result = resolveMomentumShadowCandidateProfile({
    profile: 'loss_cap_no_doge',
    env: {
      MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_NO_DOGE_DIR: '/tmp/coinpilot-loss-cap-no-doge'
    }
  });

  assert.equal(result.candidateProfile, 'loss_cap_no_doge');
  assert.equal(result.targetDir, '/tmp/coinpilot-loss-cap-no-doge');
  assert.equal(result.candidateConfig.mode, 'fixed');
  assert.equal(result.candidateConfig.maxHoldHours, 48);
  assert.equal(result.candidateConfig.entryExecution, 'next_open');
  assert.equal(result.candidateConfig.executionModel, 'candle_close');
  assert.equal(result.candidateConfig.stopLossPercent, 4);
  assert.equal(result.candidateConfig.breadthMin, 3);
  assert.equal(result.candidateConfig.benchmarkTrendMinPercent, 1);
  assert.equal(result.candidateConfig.markets.includes('KRW-DOGE'), false);
  assert.equal(result.candidateConfig.markets.length, 11);
  assert.equal(result.requireQuoteQuality, false);
  const evidence = getMomentumShadowHistoricalEvidence('loss_cap_no_doge');
  assert.equal(evidence.researchOnly, true);
  assert.equal(evidence.promoted, false);
  assert.equal(evidence.windows.length, 2);
  assert.equal(evidence.windows[0].tradeCount, 88);
  assert.equal(evidence.rollingWindows.length, 9);
  assert.equal(evidence.rollingWindows.filter(window => window.status === 'POSITIVE_OBSERVATION').length, 8);
  assert.equal(evidence.rollingWindows.reduce((sum, window) => sum + window.unknownBoundaryCount, 0), 0);
  assert.equal(evidence.costStress.length, 7);
  assert.equal(evidence.costStress.find(row => row.costPercent === 1.5).status, 'HOLD');
});

test('candidate profile resolver fails closed for an unknown profile', () => {
  assert.throws(
    () => resolveMomentumShadowCandidateProfile({ profile: 'typo_profile', env: {} }),
    /unknown MOMO_SHADOW_CANDIDATE_PROFILE=typo_profile/
  );
});

test('CLI preflight applies the requested loss-cap profile instead of the baseline', () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-profile-preflight-'));
  const benchmarkDir = path.join(root, 'benchmark');
  const lossCapDir = path.join(root, 'loss-cap');
  const ownerDir = path.join(root, 'other-owner');
  const slotFile = path.join(root, 'candidate-slot.json');
  const now = new Date().toISOString();
  fs.mkdirSync(benchmarkDir, { recursive: true });
  fs.writeFileSync(path.join(benchmarkDir, 'ledger.json'), JSON.stringify({
    ownerPid: process.pid,
    runnerState: 'running',
    heartbeatAt: now,
    benchmarkGateOpen: false,
    benchmarkTrendPercent: -1,
    dataQuality: {
      valid: true,
      reason: 'daily_grid_aligned_and_contiguous',
      marketCount: 12
    },
    config: { pollMs: 900_000 }
  }));
  const env = {
    ...process.env,
    MOMO_SHADOW_CANDIDATE_PROFILE: 'loss_cap',
    MOMO_SHADOW_BENCHMARK_DIR: benchmarkDir,
    MOMO_SHADOW_FIXED_HOLD_LOSS_CAP_DIR: lossCapDir,
    MOMO_SHADOW_OWNER_DIRS: ownerDir,
    MOMO_SHADOW_CANDIDATE_SLOT_FILE: slotFile,
    MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN: 'true'
  };
  delete env.MOMO_SHADOW_CANDIDATE_DIR;
  try {
    const result = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'src/scripts/preflightMomentumShadowCandidate.js')],
      { cwd: projectRoot, env, encoding: 'utf8' }
    );
    assert.equal(result.status, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.candidateProfile, 'loss_cap');
    assert.equal(payload.candidateConfig.mode, 'fixed');
    assert.equal(payload.candidateConfig.maxHoldHours, 48);
    assert.equal(payload.candidateConfig.stopLossPercent, 4);
    assert.equal(payload.candidateConfig.executionModel, 'candle_close');
    assert.equal(payload.targetDir, lossCapDir);
    assert.ok(payload.blockers.includes('benchmark_gate_closed'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
