import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProfileWriterStartup, resolveVirtualPortfolioFile } from '../src/runtime/profileWriterStartup.js';
import { createRuntimeStoragePlan, getStoragePathEnvironment } from '../src/runtime/profileStoragePlan.js';
import { resolveOptimizationStoragePaths } from '../src/runtime/optimizationStorage.js';

function resource(plan, context, id) {
  return plan.resources.find(entry => entry.context === context && entry.id === id);
}

function groupContaining(plan, contextNames, logicalResource) {
  return plan.potentialCrossContextPathGroups.find(group =>
    contextNames.every(name => group.contexts.includes(name)) &&
    group.logicalResources.includes(logicalResource)
  );
}

test('same-cwd contexts with distinct portfolios share only cwd and project-root defaults', () => {
  const plan = createRuntimeStoragePlan({
    projectRoot: '/fixture/project',
    contexts: [
      {
        name: 'profile-a',
        cwd: '/fixture/shared-cwd',
        config: { virtualPortfolioFile: '/fixture/portfolios/a.json' },
        env: { NODE_ENV: 'production' }
      },
      {
        name: 'profile-b',
        cwd: '/fixture/shared-cwd',
        config: { virtualPortfolioFile: '/fixture/portfolios/b.json' },
        env: { NODE_ENV: 'production' }
      }
    ]
  });

  for (const id of ['virtualPortfolio', 'manualOrderIdempotency', 'profileWriterLock']) {
    assert.notEqual(resource(plan, 'profile-a', id).absolutePath, resource(plan, 'profile-b', id).absolutePath);
  }
  assert.equal(resource(plan, 'profile-a', 'manualOrderIdempotency').scope, 'profile-derived');
  assert.equal(resource(plan, 'profile-a', 'profileWriterLock').scope, 'profile-derived');

  for (const [id, logicalResource] of [
    ['paperValidation', 'paperValidation'],
    ['portfolioHistory', 'portfolioHistory'],
    ['liveExecutionEvidence.runtime', 'liveExecutionEvidence']
  ]) {
    assert.equal(resource(plan, 'profile-a', id).absolutePath, resource(plan, 'profile-b', id).absolutePath);
    const sharedGroup = groupContaining(plan, ['profile-a', 'profile-b'], logicalResource);
    assert.equal(sharedGroup?.risk, 'potential');
    assert.equal(sharedGroup?.actualCollisionVerified, false);
  }

  const sharedDefaults = plan.potentialSharedDefaultPathGroups.map(group => group.logicalResource);
  assert.ok(sharedDefaults.includes('paperValidation'));
  assert.ok(sharedDefaults.includes('portfolioHistory'));
  assert.ok(sharedDefaults.includes('liveExecutionEvidence'));
});

test('explicit per-context overrides resolve to separate paper, history, and evidence paths', () => {
  const plan = createRuntimeStoragePlan({
    projectRoot: '/fixture/project',
    contexts: [
      {
        name: 'profile-a',
        cwd: '/fixture/shared-cwd',
        config: {
          virtualPortfolioFile: '/fixture/portfolios/a.json',
          paperValidationFile: '/fixture/ledgers/a-paper.json',
          portfolioHistoryFile: '/fixture/history/a.json'
        },
        env: {
          NODE_ENV: 'production',
          LIVE_EXECUTION_EVIDENCE_FILE: '/fixture/evidence/a.jsonl'
        }
      },
      {
        name: 'profile-b',
        cwd: '/fixture/shared-cwd',
        config: {
          virtualPortfolioFile: '/fixture/portfolios/b.json',
          paperValidationFile: '/fixture/ledgers/b-paper.json',
          portfolioHistoryFile: '/fixture/history/b.json'
        },
        env: {
          NODE_ENV: 'production',
          LIVE_EXECUTION_EVIDENCE_FILE: '/fixture/evidence/b.jsonl'
        }
      }
    ]
  });

  for (const id of ['paperValidation', 'portfolioHistory', 'liveExecutionEvidence.runtime']) {
    assert.notEqual(resource(plan, 'profile-a', id).absolutePath, resource(plan, 'profile-b', id).absolutePath);
    assert.equal(
      groupContaining(plan, ['profile-a', 'profile-b'], resource(plan, 'profile-a', id).logicalResource),
      undefined
    );
  }
});

test('a shared manual-order journal is represented by one shared journal writer lock', () => {
  const sharedJournal = '/fixture/shared/manual-order-journal.json';
  const plan = createRuntimeStoragePlan({
    projectRoot: '/fixture/project',
    contexts: [
      {
        name: 'profile-a',
        cwd: '/fixture/a',
        config: { virtualPortfolioFile: '/fixture/a/portfolio.json', manualOrderIdempotencyFile: sharedJournal },
        env: { NODE_ENV: 'production' }
      },
      {
        name: 'profile-b',
        cwd: '/fixture/b',
        config: { virtualPortfolioFile: '/fixture/b/portfolio.json', manualOrderIdempotencyFile: sharedJournal },
        env: { NODE_ENV: 'production' }
      }
    ]
  });

  assert.notEqual(resource(plan, 'profile-a', 'profileWriterLock').absolutePath,
    resource(plan, 'profile-b', 'profileWriterLock').absolutePath);
  assert.equal(resource(plan, 'profile-a', 'manualOrderIdempotencyWriterLock').absolutePath,
    `${sharedJournal}.manual_order_journal_writer.lock`);
  assert.equal(resource(plan, 'profile-a', 'manualOrderIdempotencyWriterLock').absolutePath,
    resource(plan, 'profile-b', 'manualOrderIdempotencyWriterLock').absolutePath);
  assert.ok(groupContaining(plan, ['profile-a', 'profile-b'], 'manualOrderIdempotencyWriterLock'));
});

test('cwd-relative legacy paths move with cwd while PROJECT_ROOT optimizer paths stay fixed', () => {
  const plan = createRuntimeStoragePlan({
    projectRoot: '/fixture/shared-project',
    contexts: [
      {
        name: 'cwd-a',
        cwd: '/fixture/checkout-a',
        config: { virtualPortfolioFile: '/fixture/portfolios/a.json' },
        env: { NODE_ENV: 'production' }
      },
      {
        name: 'cwd-b',
        cwd: '/fixture/checkout-b',
        config: { virtualPortfolioFile: '/fixture/portfolios/b.json' },
        env: { NODE_ENV: 'production' }
      }
    ]
  });

  for (const id of [
    'paperValidation',
    'portfolioHistory',
    'liveExecutionEvidence.runtime',
    'optimalConfig.cwdOptimizer',
    'optimizationHistory.cwdOptimizer'
  ]) {
    assert.notEqual(resource(plan, 'cwd-a', id).absolutePath, resource(plan, 'cwd-b', id).absolutePath);
    assert.equal(resource(plan, 'cwd-a', id).resolutionBase, 'cwd');
  }

  for (const id of [
    'optimizationState.dashboard',
    'optimalConfig.dashboard',
    'optimizationHistory.dashboard',
    'liveExecutionEvidence.reconcileCli'
  ]) {
    assert.equal(resource(plan, 'cwd-a', id).absolutePath, resource(plan, 'cwd-b', id).absolutePath);
    assert.equal(resource(plan, 'cwd-a', id).resolutionBase, 'PROJECT_ROOT');
  }
});

test('COINPILOT_STATE_DIR unifies dashboard and runtime optimizer paths across checkout and state roots', () => {
  const plan = createRuntimeStoragePlan({
    contexts: [
      {
        name: 'systemd-runtime',
        cwd: '/var/lib/coinpilot-live',
        projectRoot: '/opt/coinpilot-live/current',
        config: {},
        env: { NODE_ENV: 'production', COINPILOT_STATE_DIR: '/var/lib/coinpilot-live' }
      },
      {
        name: 'admin-runtime',
        cwd: '/srv/coinpilot-state',
        projectRoot: '/opt/coinpilot-live/current',
        config: {},
        env: { NODE_ENV: 'production', COINPILOT_STATE_DIR: '/var/lib/coinpilot-live' }
      }
    ]
  });

  for (const [id, fileName] of [
    ['optimizationState.dashboard', 'optimization_state.json'],
    ['optimalConfig.dashboard', 'optimal_config.json'],
    ['optimizationHistory.dashboard', 'optimization_history.json'],
    ['optimalConfig.cwdOptimizer', 'optimal_config.json'],
    ['optimizationHistory.cwdOptimizer', 'optimization_history.json']
  ]) {
    assert.equal(resource(plan, 'systemd-runtime', id).absolutePath, path.join('/var/lib/coinpilot-live', fileName));
    assert.equal(resource(plan, 'admin-runtime', id).absolutePath, path.join('/var/lib/coinpilot-live', fileName));
    assert.equal(resource(plan, 'systemd-runtime', id).resolutionBase, 'COINPILOT_STATE_DIR');
  }
});

test('optimizer paths prefer explicit per-file paths and preserve legacy roots when state dir is unset', () => {
  const explicit = resolveOptimizationStoragePaths({
    env: {
      COINPILOT_STATE_DIR: '/var/lib/coinpilot',
      COINPILOT_OPTIMIZATION_HISTORY_FILE: 'custom/history.json'
    },
    cwd: '/srv/service',
    projectRoot: '/opt/coinpilot/current',
    legacyBase: 'projectRoot',
    optimalConfigFile: '/secure/approved/optimal_config.json'
  });

  assert.equal(explicit.optimalConfigFile.absolutePath, '/secure/approved/optimal_config.json');
  assert.equal(explicit.optimalConfigFile.source, 'option.optimalConfigFile');
  assert.equal(explicit.optimizationHistoryFile.absolutePath, '/srv/service/custom/history.json');
  assert.equal(explicit.optimizationHistoryFile.source, 'env.COINPILOT_OPTIMIZATION_HISTORY_FILE');
  assert.equal(explicit.optimizationStateFile.absolutePath, '/var/lib/coinpilot/optimization_state.json');

  const legacyDashboard = resolveOptimizationStoragePaths({
    env: {},
    cwd: '/var/lib/service',
    projectRoot: '/opt/coinpilot/current',
    legacyBase: 'projectRoot'
  });
  const legacyRuntime = resolveOptimizationStoragePaths({
    env: {},
    cwd: '/var/lib/service',
    projectRoot: '/opt/coinpilot/current',
    legacyBase: 'cwd'
  });
  assert.equal(legacyDashboard.optimizationStateFile.absolutePath, '/opt/coinpilot/current/optimization_state.json');
  assert.equal(legacyDashboard.optimalConfigFile.absolutePath, '/opt/coinpilot/current/optimal_config.json');
  assert.equal(legacyRuntime.optimalConfigFile.absolutePath, '/var/lib/service/optimal_config.json');
});

test('credential, AI-monitoring, and log paths honor configured and default resolution bases', () => {
  const defaults = createRuntimeStoragePlan({
    cwd: '/fixture/default-cwd',
    projectRoot: '/fixture/default-project',
    config: {},
    env: { NODE_ENV: 'production' }
  });

  assert.equal(
    resource(defaults, 'current-runtime', 'liveCredentialFile').absolutePath,
    '/fixture/default-project/.secrets/live-upbit-credentials/credentials.enc'
  );
  assert.equal(resource(defaults, 'current-runtime', 'liveCredentialFile').resolutionBase, 'PROJECT_ROOT');
  assert.equal(
    resource(defaults, 'current-runtime', 'liveCredentialKeyFile').absolutePath,
    '/fixture/default-project/.secrets/live-upbit-credentials/encryption.key'
  );
  assert.equal(
    resource(defaults, 'current-runtime', 'aiMonitoringSessionService').absolutePath,
    '/fixture/default-cwd/ai_monitoring_sessions.json'
  );
  assert.equal(
    resource(defaults, 'current-runtime', 'paperAiMonitoring').absolutePath,
    '/fixture/default-cwd/.paper-smoke/ai_monitoring_sessions.json'
  );
  assert.equal(resource(defaults, 'current-runtime', 'runtimeLogDirectory').absolutePath, '/fixture/default-cwd/logs');
  assert.equal(resource(defaults, 'current-runtime', 'dashboardLogDirectory').absolutePath, '/fixture/default-project/logs');
  assert.equal(resource(defaults, 'current-runtime', 'dashboardLogDirectory').resolutionBase, 'PROJECT_ROOT');

  const sameRootDefaults = createRuntimeStoragePlan({
    cwd: '/fixture/same-root',
    projectRoot: '/fixture/same-root',
    config: {},
    env: { NODE_ENV: 'production' }
  });
  const logPathCandidates = sameRootDefaults.potentialSharedDefaultPathGroups.filter(group =>
    group.logicalResource === 'logDirectory'
  );
  assert.equal(logPathCandidates.length, 1);
  assert.deepEqual(new Set(logPathCandidates[0].resourceIds), new Set([
    'runtimeLogDirectory',
    'dashboardLogDirectory'
  ]));
  assert.deepEqual(new Set(logPathCandidates[0].scopes), new Set(['cwd', 'PROJECT_ROOT']));

  const evidencePathCandidates = sameRootDefaults.potentialSharedDefaultPathGroups.filter(group =>
    group.logicalResource === 'liveExecutionEvidence'
  );
  assert.equal(evidencePathCandidates.length, 1);
  assert.deepEqual(new Set(evidencePathCandidates[0].resourceIds), new Set([
    'liveExecutionEvidence.runtime',
    'liveExecutionEvidence.reconcileCli'
  ]));

  const configured = createRuntimeStoragePlan({
    projectRoot: '/fixture/configured-project',
    contexts: [{
      name: 'configured-runtime',
      cwd: '/fixture/configured-cwd',
      config: {},
      env: {
        NODE_ENV: 'production',
        COINPILOT_LIVE_CREDENTIALS_FILE: 'credentials/custom.enc',
        COINPILOT_LIVE_CREDENTIALS_KEY_FILE: '/fixture/secure/custom.key',
        AI_MONITORING_FILE: 'state/custom-ai.json',
        PAPER_AI_MONITORING_FILE: 'paper/custom-ai.json',
        PAPER_SMOKE_OUTPUT_DIR: 'custom-paper-output',
        STAGING_OUTPUT_DIR: '.staging-output'
      }
    }]
  });

  assert.equal(resource(configured, 'configured-runtime', 'liveCredentialFile').absolutePath,
    '/fixture/configured-cwd/credentials/custom.enc');
  assert.equal(resource(configured, 'configured-runtime', 'liveCredentialFile').resolutionBase, 'cwd');
  assert.equal(resource(configured, 'configured-runtime', 'liveCredentialKeyFile').absolutePath,
    '/fixture/secure/custom.key');
  assert.equal(resource(configured, 'configured-runtime', 'liveCredentialKeyFile').resolutionBase, 'absolute-input');
  assert.equal(resource(configured, 'configured-runtime', 'aiMonitoringSessionService').absolutePath,
    '/fixture/configured-cwd/state/custom-ai.json');
  assert.equal(resource(configured, 'configured-runtime', 'paperAiMonitoring').absolutePath,
    '/fixture/configured-cwd/paper/custom-ai.json');
  assert.equal(resource(configured, 'configured-runtime', 'runtimeLogDirectory').absolutePath,
    '/fixture/configured-cwd/.staging-output/logs');
  assert.equal(resource(configured, 'configured-runtime', 'runtimeLogDirectory').resolutionBase, 'cwd');
  assert.equal(resource(configured, 'configured-runtime', 'dashboardLogDirectory').absolutePath,
    '/fixture/configured-project/.staging-output/logs');
  assert.equal(resource(configured, 'configured-runtime', 'dashboardLogDirectory').resolutionBase, 'PROJECT_ROOT');
});

test('portfolio path resolver preserves test temp names and startup locks the absolute trader path', t => {
  const expectedTestPortfolio = path.join(
    '/fixture/tmp',
    'coin-pilot-test-123-456-zzzzzz.dry_portfolio.json'
  );
  assert.equal(resolveVirtualPortfolioFile({}, {
    env: { NODE_ENV: 'test' },
    tempDir: '/fixture/tmp',
    pid: 123,
    now: () => 456,
    random: () => 1 - Number.EPSILON
  }), expectedTestPortfolio);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-storage-plan-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const config = {
    dryRun: true,
    enableDashboard: false,
    virtualPortfolioFile: 'state/portfolio.json'
  };
  const startup = createProfileWriterStartup(config, {
    env: { NODE_ENV: 'production' },
    cwd: tempRoot
  });
  const expectedPortfolio = path.join(tempRoot, 'state/portfolio.json');
  const expectedLock = `${expectedPortfolio}.manual_order_writer.lock`;
  const runtime = startup.createTraderAndStore(() => ({
    config,
    dryRun: true,
    virtualPortfolioFile: config.virtualPortfolioFile,
    persistManualOrderIdempotencyRecords() {}
  }));

  assert.equal(config.virtualPortfolioFile, expectedPortfolio);
  assert.equal(startup.virtualPortfolioFile, expectedPortfolio);
  assert.equal(runtime.trader.virtualPortfolioFile, expectedPortfolio);
  assert.equal(runtime.manualOrderIdempotencyStore.writerLockPath, expectedLock);
  assert.equal(
    path.resolve('/fixture/changed-cwd', runtime.trader.virtualPortfolioFile),
    expectedPortfolio
  );
  assert.equal(startup.releaseWriterLock(), true);
});

test('manifest inspection accepts path variables only and marks potential risks without verification', () => {
  const pathEnv = getStoragePathEnvironment({
    DRY_PORTFOLIO_FILE: '/fixture/portfolio.json',
    LIVE_EXECUTION_EVIDENCE_FILE: '/fixture/evidence.jsonl',
    COINPILOT_LIVE_CREDENTIALS_FILE: 'credentials.enc',
    COINPILOT_LIVE_CREDENTIALS_KEY_FILE: 'encryption.key',
    COINPILOT_STATE_DIR: '/fixture/state',
    COINPILOT_OPTIMIZATION_HISTORY_FILE: 'state/custom-history.json',
    AI_MONITORING_FILE: 'state/ai.json',
    PAPER_AI_MONITORING_FILE: 'state/paper-ai.json',
    STAGING_OUTPUT_DIR: '.staging',
    UPBIT_ACCESS_KEY: 'must-not-be-included',
    UPBIT_SECRET_KEY: 'must-not-be-included',
    OPENAI_API_KEY: 'must-not-be-included'
  });
  assert.deepEqual(pathEnv, {
    DRY_PORTFOLIO_FILE: '/fixture/portfolio.json',
    AI_MONITORING_FILE: 'state/ai.json',
    PAPER_AI_MONITORING_FILE: 'state/paper-ai.json',
    LIVE_EXECUTION_EVIDENCE_FILE: '/fixture/evidence.jsonl',
    COINPILOT_LIVE_CREDENTIALS_FILE: 'credentials.enc',
    COINPILOT_LIVE_CREDENTIALS_KEY_FILE: 'encryption.key',
    COINPILOT_STATE_DIR: '/fixture/state',
    COINPILOT_OPTIMIZATION_HISTORY_FILE: 'state/custom-history.json',
    STAGING_OUTPUT_DIR: '.staging'
  });

  const plan = createRuntimeStoragePlan({
    cwd: '/fixture/current',
    projectRoot: '/fixture/project',
    config: { virtualPortfolioFile: '/fixture/portfolio.json' },
    env: pathEnv,
    environmentSource: 'current process.env path-variable allowlist'
  });
  assert.equal(plan.inspection.readFileContents, false);
  assert.equal(plan.inspection.readCredentials, false);
  assert.equal(plan.inspection.filesystemMutation, false);
  assert.equal(plan.inspection.environmentSource, 'current process.env path-variable allowlist');
  assert.equal(plan.inspection.dotenvLoadedByInspector, false);
  assert.equal(plan.inspection.dotenvOnlyOverridesVisible, false);
  assert.ok(plan.potentialSharedDefaultPathGroups.every(group => group.risk === 'potential'));
  assert.ok(plan.resources.every(entry => path.isAbsolute(entry.absolutePath)));
});
