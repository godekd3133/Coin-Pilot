import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOptimizationStoragePaths } from './optimizationStorage.js';

const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PROJECT_ROOT = path.resolve(MODULE_DIRECTORY, '..', '..');

const PATH_ENVIRONMENT_KEYS = [
  'COINPILOT_LIVE_CREDENTIALS_FILE',
  'COINPILOT_LIVE_CREDENTIALS_KEY_FILE',
  'COINPILOT_STATE_DIR',
  'COINPILOT_OPTIMIZATION_STATE_FILE',
  'COINPILOT_OPTIMIZATION_HISTORY_FILE',
  'COINPILOT_OPTIMAL_CONFIG_FILE',
  'DRY_PORTFOLIO_FILE',
  'AI_MONITORING_FILE',
  'PAPER_AI_MONITORING_FILE',
  'PAPER_FORWARD_MODE',
  'PAPER_VALIDATION_FILE',
  'PORTFOLIO_HISTORY_FILE',
  'LIVE_EXECUTION_EVIDENCE_FILE',
  'PAPER_SMOKE_OUTPUT_DIR',
  'STAGING_OUTPUT_DIR',
  'NODE_ENV',
  'NODE_TEST_CONTEXT'
];

function isTestEnvironment(env) {
  return env?.NODE_ENV === 'test' || Boolean(env?.NODE_TEST_CONTEXT);
}

function createTestStoragePrefix({ env, tempDir, pid, now, random }) {
  if (!isTestEnvironment(env)) return null;
  return path.join(
    tempDir,
    `coin-pilot-test-${pid}-${now()}-${random().toString(36).slice(2, 8)}`
  );
}

function describePath(configuredPath, {
  cwd,
  base,
  resolutionBaseLabel = base,
  source,
  scope,
  defaultSharing = null
}) {
  const isAbsolute = path.isAbsolute(configuredPath);
  const resolutionBase = source === 'testStoragePrefix'
    ? 'temporaryDirectory'
    : isAbsolute ? 'absolute-input' : resolutionBaseLabel;
  const absolutePath = isAbsolute
    ? path.resolve(configuredPath)
    : path.resolve(base === 'cwd' ? cwd : base, configuredPath);

  return {
    configuredPath,
    absolutePath,
    source,
    resolutionBase,
    scope: source === 'testStoragePrefix'
      ? 'test-temp'
      : isAbsolute && scope === 'cwd' ? 'explicit-path' : scope,
    defaultSharing
  };
}

function resolvePortfolioPath(config = {}, options = {}) {
  const env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const tempDir = path.resolve(options.tempDir || os.tmpdir());
  const pid = options.pid ?? process.pid;
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  let testStoragePrefix = options.testStoragePrefix;
  if (testStoragePrefix === undefined) {
    testStoragePrefix = config?.virtualPortfolioFile || env?.DRY_PORTFOLIO_FILE
      ? null
      : createTestStoragePrefix({ env, tempDir, pid, now, random });
  }

  let configuredPath;
  let source;
  let base;
  let defaultSharing = null;
  if (config?.virtualPortfolioFile) {
    configuredPath = config.virtualPortfolioFile;
    source = 'config.virtualPortfolioFile';
    base = 'cwd';
  } else if (env?.DRY_PORTFOLIO_FILE) {
    configuredPath = env.DRY_PORTFOLIO_FILE;
    source = 'env.DRY_PORTFOLIO_FILE';
    base = 'cwd';
  } else if (testStoragePrefix) {
    configuredPath = `${testStoragePrefix}.dry_portfolio.json`;
    source = 'testStoragePrefix';
    base = 'temporaryDirectory';
  } else {
    configuredPath = 'dry_portfolio.json';
    source = 'default';
    base = 'cwd';
    defaultSharing = {
      risk: 'potential',
      condition: 'another runtime context uses the same cwd and default portfolio path'
    };
  }

  const pathInfo = describePath(configuredPath, {
    cwd,
    base: base === 'temporaryDirectory' ? tempDir : base,
    resolutionBaseLabel: base,
    source,
    scope: 'profile',
    defaultSharing
  });
  return { ...pathInfo, source, configuredPath };
}

/** Derive the local public quote snapshot from the exact owned portfolio profile. */
export function derivePublicMarketSnapshotFilePath(virtualPortfolioFile) {
  if (typeof virtualPortfolioFile !== 'string' || !virtualPortfolioFile.trim()) {
    throw new TypeError('A virtual portfolio path is required for the public market snapshot.');
  }
  return `${path.resolve(virtualPortfolioFile)}.market_snapshot.json`;
}

/**
 * Resolve the virtual portfolio using MultiCoinTrader's startup precedence.
 * The returned configuredPath preserves the historic relative-path contract;
 * absolutePath is the physical target captured at startup.
 */
export function resolveVirtualPortfolioStoragePath(config, options = {}) {
  return resolvePortfolioPath(config, options);
}

/** Read-only wrapper retained for existing profile-writer callers and tests. */
export function resolveVirtualPortfolioFile(config, options = {}) {
  return resolveVirtualPortfolioStoragePath(config, options).configuredPath;
}

function resolveConfiguredFile({
  configValue,
  envValue,
  defaultPath,
  cwd,
  basePath = 'cwd',
  baseLabel = basePath,
  scope = 'cwd',
  testPath = null,
  testStoragePrefix = null
}) {
  let configuredPath;
  let source;
  let base = 'cwd';
  let defaultSharing = null;

  if (configValue) {
    configuredPath = configValue;
    source = 'config';
  } else if (envValue) {
    configuredPath = envValue;
    source = 'environment';
  } else if (testPath && testStoragePrefix) {
    configuredPath = `${testStoragePrefix}${testPath.suffix}`;
    source = 'testStoragePrefix';
    base = testPath.base || 'temporaryDirectory';
  } else {
    configuredPath = defaultPath;
    source = 'default';
    defaultSharing = {
      risk: 'potential',
      condition: `another runtime context resolves the same ${scope} default`
    };
  }

  const pathBase = base === 'temporaryDirectory'
    ? path.dirname(testStoragePrefix)
    : basePath === 'cwd' ? 'cwd' : basePath;
  return {
    ...describePath(configuredPath, {
      cwd,
      base: pathBase,
      resolutionBaseLabel: base === 'temporaryDirectory' ? base : baseLabel,
      source,
      scope,
      defaultSharing
    }),
    source,
    configuredPath
  };
}

function resolveLiveCredentialPath({
  options,
  env,
  optionKey,
  envKey,
  fileName,
  cwd,
  projectRoot
}) {
  const directoryPath = options.directoryPath
    ? path.resolve(cwd, options.directoryPath)
    : null;
  const optionPath = options[optionKey];
  const configuredPath = optionPath ?? (directoryPath ? null : env[envKey]);

  if (configuredPath) {
    return describePath(configuredPath, {
      cwd,
      base: 'cwd',
      source: optionPath !== undefined && optionPath !== null ? `storeOption.${optionKey}` : `env.${envKey}`,
      scope: 'cwd'
    });
  }

  if (directoryPath) {
    const relativeDirectoryPath = path.isAbsolute(options.directoryPath)
      ? options.directoryPath
      : path.join(options.directoryPath, fileName);
    const selectedPath = path.isAbsolute(options.directoryPath)
      ? path.join(directoryPath, fileName)
      : relativeDirectoryPath;
    return describePath(selectedPath, {
      cwd,
      base: 'cwd',
      source: 'storeOption.directoryPath',
      scope: 'cwd'
    });
  }

  const defaultPath = path.join('.secrets', 'live-upbit-credentials', fileName);
  return describePath(defaultPath, {
    cwd,
    base: projectRoot,
    resolutionBaseLabel: 'PROJECT_ROOT',
    source: 'default',
    scope: 'PROJECT_ROOT',
    defaultSharing: {
      risk: 'potential',
      condition: 'another runtime context uses the same PROJECT_ROOT credential-store default'
    }
  });
}

function resolveMonitoringSessionPath({ config, env, cwd }) {
  let configuredPath;
  let source;
  let defaultSharing = null;
  if (config.aiMonitoringFile) {
    configuredPath = config.aiMonitoringFile;
    source = 'config.aiMonitoringFile';
  } else if (env.AI_MONITORING_FILE) {
    configuredPath = env.AI_MONITORING_FILE;
    source = 'env.AI_MONITORING_FILE';
  } else {
    configuredPath = 'ai_monitoring_sessions.json';
    source = 'default';
    defaultSharing = {
      risk: 'potential',
      condition: 'another runtime context uses the same cwd monitoring-service default'
    };
  }

  return describePath(configuredPath, {
    cwd,
    base: 'cwd',
    source,
    scope: 'cwd',
    defaultSharing
  });
}

function resolvePaperAiMonitoringPath({ env, cwd }) {
  const outputDirectory = env.PAPER_SMOKE_OUTPUT_DIR ||
    (env.PAPER_FORWARD_MODE === 'true' ? '.paper-forward' : '.paper-smoke');
  const configuredPath = env.PAPER_AI_MONITORING_FILE ||
    path.join(outputDirectory, 'ai_monitoring_sessions.json');
  const hasExplicitStateFile = Boolean(env.PAPER_AI_MONITORING_FILE);
  const hasConfiguredOutputDirectory = Boolean(env.PAPER_SMOKE_OUTPUT_DIR);
  const source = hasExplicitStateFile
    ? 'env.PAPER_AI_MONITORING_FILE'
    : hasConfiguredOutputDirectory
      ? 'defaultUnderPAPER_SMOKE_OUTPUT_DIR'
      : 'default';
  const defaultSharing = !hasExplicitStateFile
    ? {
      risk: 'potential',
      condition: 'another runtime context uses the same paper output path while PAPER_AI_MONITORING is enabled'
    }
    : null;

  return describePath(configuredPath, {
    cwd,
    base: 'cwd',
    source,
    scope: 'cwd',
    defaultSharing
  });
}

function resolveLogDirectoryPath({ cwd, projectRoot, baseLabel, stagingOutputDir }) {
  const hasStagingOutput = typeof stagingOutputDir === 'string' && stagingOutputDir.trim().length > 0;
  const configuredPath = hasStagingOutput
    ? path.join(stagingOutputDir, 'logs')
    : 'logs';
  const base = baseLabel === 'PROJECT_ROOT' ? projectRoot : 'cwd';
  const defaultSharing = !hasStagingOutput
    ? {
      risk: 'potential',
      condition: `another runtime context uses the same ${baseLabel} log default`
    }
    : null;

  return describePath(configuredPath, {
    cwd,
    base,
    resolutionBaseLabel: baseLabel,
    source: hasStagingOutput ? 'env.STAGING_OUTPUT_DIR' : 'default',
    scope: baseLabel,
    defaultSharing
  });
}

function profileResource(id, details, producers, consumers, logicalResource = id) {
  return {
    id,
    logicalResource,
    ...details,
    producers,
    consumers
  };
}

function resolveContextStoragePaths({ name, cwd, projectRoot, config, env, liveCredentialStoreOptions }, commonOptions) {
  const absoluteCwd = path.resolve(cwd);
  const absoluteProjectRoot = path.resolve(projectRoot);
  const selectedConfig = config || {};
  const selectedEnv = env || {};
  const credentialStoreOptions = liveCredentialStoreOptions || {};
  const portfolioPath = resolvePortfolioPath(selectedConfig, {
    ...commonOptions,
    cwd: absoluteCwd,
    env: selectedEnv
  });
  const publicMarketSnapshotPath = {
    configuredPath: `${portfolioPath.configuredPath}.market_snapshot.json`,
    absolutePath: derivePublicMarketSnapshotFilePath(portfolioPath.absolutePath),
    source: 'derivedFromVirtualPortfolio',
    resolutionBase: 'virtualPortfolio.absolutePath',
    scope: 'profile-derived',
    defaultSharing: portfolioPath.defaultSharing
  };

  const manualOrderIdempotencyPath = selectedConfig.manualOrderIdempotencyFile
    ? describePath(selectedConfig.manualOrderIdempotencyFile, {
      cwd: absoluteCwd,
      base: 'cwd',
      source: 'config.manualOrderIdempotencyFile',
      scope: 'cwd'
    })
    : {
      configuredPath: `${portfolioPath.absolutePath}.manual_order_idempotency.json`,
      absolutePath: `${portfolioPath.absolutePath}.manual_order_idempotency.json`,
      source: 'derivedFromVirtualPortfolio',
      resolutionBase: 'virtualPortfolio.absolutePath',
      scope: 'profile-derived',
      defaultSharing: portfolioPath.defaultSharing
        ? {
          risk: 'potential',
          condition: 'another runtime context selects the same virtual portfolio path'
        }
        : null
    };
  if (!selectedConfig.manualOrderIdempotencyFile) {
    manualOrderIdempotencyPath.scope = 'profile-derived';
  }

  const lockPath = `${portfolioPath.absolutePath}.manual_order_writer.lock`;
  const journalLockPath = `${manualOrderIdempotencyPath.absolutePath}.manual_order_journal_writer.lock`;
  const lockDefaultSharing = portfolioPath.defaultSharing
    ? {
      risk: 'potential',
      condition: 'another runtime context selects the same virtual portfolio path'
    }
    : null;
  const paperTestPrefix = selectedConfig.paperValidationFile || selectedEnv.PAPER_VALIDATION_FILE
    ? null
    : createTestStoragePrefix({
      env: selectedEnv,
      tempDir: commonOptions.tempDir,
      pid: commonOptions.pid,
      now: commonOptions.now,
      random: commonOptions.random
    });
  const paperValidationPath = resolveConfiguredFile({
    configValue: selectedConfig.paperValidationFile,
    envValue: selectedEnv.PAPER_VALIDATION_FILE,
    defaultPath: 'paper_validation.json',
    cwd: absoluteCwd,
    scope: 'cwd',
    testStoragePrefix: paperTestPrefix,
    testPath: { suffix: '.paper_validation.json' }
  });
  const portfolioHistoryPath = resolveConfiguredFile({
    configValue: selectedConfig.portfolioHistoryFile,
    envValue: selectedEnv.PORTFOLIO_HISTORY_FILE,
    defaultPath: 'portfolio_history.json',
    cwd: absoluteCwd,
    scope: 'cwd'
  });
  const liveEvidencePath = resolveConfiguredFile({
    configValue: selectedConfig.liveExecutionEvidenceFile,
    envValue: selectedEnv.LIVE_EXECUTION_EVIDENCE_FILE,
    defaultPath: '.coinpilot-runtime/live-execution/evidence.jsonl',
    cwd: absoluteCwd,
    scope: 'cwd'
  });
  const liveCredentialFilePath = resolveLiveCredentialPath({
    options: credentialStoreOptions,
    env: selectedEnv,
    optionKey: 'credentialsFile',
    envKey: 'COINPILOT_LIVE_CREDENTIALS_FILE',
    fileName: 'credentials.enc',
    cwd: absoluteCwd,
    projectRoot: absoluteProjectRoot
  });
  const liveCredentialKeyFilePath = resolveLiveCredentialPath({
    options: credentialStoreOptions,
    env: selectedEnv,
    optionKey: 'keyFile',
    envKey: 'COINPILOT_LIVE_CREDENTIALS_KEY_FILE',
    fileName: 'encryption.key',
    cwd: absoluteCwd,
    projectRoot: absoluteProjectRoot
  });
  const monitoringSessionPath = resolveMonitoringSessionPath({
    config: selectedConfig,
    env: selectedEnv,
    cwd: absoluteCwd
  });
  const paperAiMonitoringPath = resolvePaperAiMonitoringPath({
    env: selectedEnv,
    cwd: absoluteCwd
  });
  const runtimeLogDirectoryPath = resolveLogDirectoryPath({
    cwd: absoluteCwd,
    projectRoot: absoluteProjectRoot,
    baseLabel: 'cwd',
    stagingOutputDir: selectedEnv.STAGING_OUTPUT_DIR
  });
  const dashboardLogDirectoryPath = resolveLogDirectoryPath({
    cwd: absoluteCwd,
    projectRoot: absoluteProjectRoot,
    baseLabel: 'PROJECT_ROOT',
    stagingOutputDir: selectedEnv.STAGING_OUTPUT_DIR
  });

  const dashboardOptimizationPaths = resolveOptimizationStoragePaths({
    env: selectedEnv,
    cwd: absoluteCwd,
    projectRoot: absoluteProjectRoot,
    legacyBase: 'projectRoot'
  });
  const cwdOptimizationPaths = resolveOptimizationStoragePaths({
    env: selectedEnv,
    cwd: absoluteCwd,
    projectRoot: absoluteProjectRoot,
    legacyBase: 'cwd'
  });
  const dashboardOptimizationState = dashboardOptimizationPaths.optimizationStateFile;
  const dashboardOptimalConfig = dashboardOptimizationPaths.optimalConfigFile;
  const dashboardOptimizationHistory = dashboardOptimizationPaths.optimizationHistoryFile;
  const cwdOptimalConfig = cwdOptimizationPaths.optimalConfigFile;
  const cwdOptimizationHistory = cwdOptimizationPaths.optimizationHistoryFile;
  const dashboardOptimalConfigWriterLockPath = `${dashboardOptimalConfig.absolutePath}.optimizer_config_writer.lock`;
  const cwdOptimalConfigWriterLockPath = `${cwdOptimalConfig.absolutePath}.optimizer_config_writer.lock`;
  const dashboardOptimizationHistoryWriterLockPath = `${dashboardOptimizationHistory.absolutePath}.optimizer_history_writer.lock`;
  const cwdOptimizationHistoryWriterLockPath = `${cwdOptimizationHistory.absolutePath}.optimizer_history_writer.lock`;

  const reconcileEvidencePath = resolveConfiguredFile({
    configValue: null,
    envValue: selectedEnv.LIVE_EXECUTION_EVIDENCE_FILE,
    defaultPath: '.coinpilot-runtime/live-execution/evidence.jsonl',
    cwd: absoluteCwd,
    basePath: absoluteProjectRoot,
    baseLabel: 'PROJECT_ROOT',
    scope: 'PROJECT_ROOT'
  });

  return [
    profileResource(
      'virtualPortfolio',
      portfolioPath,
      ['MultiCoinTrader persistence'],
      ['MultiCoinTrader startup hydration', 'ManualOrderIdempotencyStore receipt recovery'],
      'virtualPortfolio'
    ),
    profileResource(
      'publicMarketSnapshot',
      publicMarketSnapshotPath,
      ['PublicMarketDataSource ticker capture under the profile writer lock'],
      ['DashboardServer last-good read-only quote fallback'],
      'publicMarketSnapshot'
    ),
    profileResource(
      'manualOrderIdempotency',
      manualOrderIdempotencyPath,
      ['ManualOrderIdempotencyStore'],
      ['ManualOrderIdempotencyStore', 'manual-order mutation middleware'],
      'manualOrderIdempotency'
    ),
    profileResource(
      'profileWriterLock',
      {
        configuredPath: lockPath,
        absolutePath: lockPath,
        source: 'derivedFromVirtualPortfolio',
        resolutionBase: 'virtualPortfolio.absolutePath',
        scope: 'profile-derived',
        defaultSharing: lockDefaultSharing
      },
      ['createProfileWriterStartup', 'ManualOrderIdempotencyStore'],
      ['ManualOrderIdempotencyStore lock verification/release'],
      'profileWriterLock'
    ),
    profileResource(
      'manualOrderIdempotencyWriterLock',
      {
        configuredPath: journalLockPath,
        absolutePath: journalLockPath,
        source: 'derivedFromManualOrderIdempotency',
        resolutionBase: 'manualOrderIdempotency.absolutePath',
        scope: 'journal-derived',
        defaultSharing: manualOrderIdempotencyPath.defaultSharing
          ? {
            risk: 'potential',
            condition: 'another runtime context selects the same manual-order idempotency journal'
          }
          : null
      },
      ['createProfileWriterStartup'],
      ['createProfileWriterStartup lock verification/release'],
      'manualOrderIdempotencyWriterLock'
    ),
    profileResource(
      'liveCredentialFile',
      liveCredentialFilePath,
      ['LiveCredentialStore credential encryption persistence'],
      ['LiveCredentialStore credential load/status'],
      'liveCredentialFile'
    ),
    profileResource(
      'liveCredentialKeyFile',
      liveCredentialKeyFilePath,
      ['LiveCredentialStore encryption-key creation'],
      ['LiveCredentialStore credential encryption/decryption'],
      'liveCredentialKeyFile'
    ),
    profileResource(
      'paperValidation',
      paperValidationPath,
      ['MultiCoinTrader paper ledger persistence'],
      ['MultiCoinTrader paper ledger hydration', 'paper research/dashboard readers'],
      'paperValidation'
    ),
    profileResource(
      'aiMonitoringSessionService',
      monitoringSessionPath,
      ['MonitoringSessionService state persistence'],
      ['MonitoringSessionService state hydration'],
      'aiMonitoringState'
    ),
    profileResource(
      'paperAiMonitoring',
      paperAiMonitoringPath,
      ['createPaperAiMonitor / MonitoringSessionService (when enabled)'],
      ['MonitoringSessionService state hydration'],
      'aiMonitoringState'
    ),
    profileResource(
      'runtimeLogDirectory',
      runtimeLogDirectoryPath,
      ['src/index.js Logger'],
      ['Logger log and retention operations'],
      'logDirectory'
    ),
    profileResource(
      'dashboardLogDirectory',
      dashboardLogDirectoryPath,
      ['DashboardServer Logger'],
      ['DashboardServer and news log readers'],
      'logDirectory'
    ),
    profileResource(
      'portfolioHistory',
      portfolioHistoryPath,
      ['PortfolioSnapshotService / PortfolioHistoryStore'],
      ['portfolio history routes'],
      'portfolioHistory'
    ),
    profileResource(
      'liveExecutionEvidence.runtime',
      liveEvidencePath,
      ['MultiCoinTrader', 'AutoTrader'],
      ['MultiCoinTrader startup recovery', 'research live-execution-evidence route'],
      'liveExecutionEvidence'
    ),
    profileResource(
      'liveExecutionEvidence.reconcileCli',
      reconcileEvidencePath,
      [],
      ['reconcileLiveExecutionEvidence CLI'],
      'liveExecutionEvidence'
    ),
    profileResource(
      'optimizationState.dashboard',
      dashboardOptimizationState,
      ['DashboardServer optimization state persistence'],
      ['DashboardServer optimization state hydration'],
      'optimizationState'
    ),
    profileResource(
      'optimalConfig.dashboard',
      dashboardOptimalConfig,
      [],
      ['GET /api/optimization/optimal-config'],
      'optimalConfig'
    ),
    profileResource(
      'optimalConfigWriterLock.dashboard',
      {
        configuredPath: dashboardOptimalConfigWriterLockPath,
        absolutePath: dashboardOptimalConfigWriterLockPath,
        source: 'derivedFromOptimalConfig',
        resolutionBase: 'optimalConfig.dashboard.absolutePath',
        scope: 'config-derived',
        defaultSharing: dashboardOptimalConfig.defaultSharing
      },
      ['writeOptimizerJsonAtomically'],
      ['writeOptimizerJsonAtomically owner verification/release'],
      'optimizerConfigWriterLock'
    ),
    profileResource(
      'optimizationHistory.dashboard',
      dashboardOptimizationHistory,
      ['DashboardServer optimization cycle'],
      ['GET /api/optimization/optimization-history'],
      'optimizationHistory'
    ),
    profileResource(
      'optimizationHistoryWriterLock.dashboard',
      {
        configuredPath: dashboardOptimizationHistoryWriterLockPath,
        absolutePath: dashboardOptimizationHistoryWriterLockPath,
        source: 'derivedFromOptimizationHistory',
        resolutionBase: 'optimizationHistory.dashboard.absolutePath',
        scope: 'history-derived',
        defaultSharing: dashboardOptimizationHistory.defaultSharing
      },
      ['appendOptimizerHistory'],
      ['appendOptimizerHistory owner verification/release'],
      'optimizerHistoryWriterLock'
    ),
    profileResource(
      'optimalConfig.cwdOptimizer',
      cwdOptimalConfig,
      ['ParameterOptimizer', 'src/index.js optimization loop', 'runOptimization CLI'],
      ['ParameterOptimizer', 'src/index.js startup optimizer config reader'],
      'optimalConfig'
    ),
    profileResource(
      'optimalConfigWriterLock.cwdOptimizer',
      {
        configuredPath: cwdOptimalConfigWriterLockPath,
        absolutePath: cwdOptimalConfigWriterLockPath,
        source: 'derivedFromOptimalConfig',
        resolutionBase: 'optimalConfig.cwdOptimizer.absolutePath',
        scope: 'config-derived',
        defaultSharing: cwdOptimalConfig.defaultSharing
      },
      ['writeOptimizerJsonAtomically'],
      ['writeOptimizerJsonAtomically owner verification/release'],
      'optimizerConfigWriterLock'
    ),
    profileResource(
      'optimizationHistory.cwdOptimizer',
      cwdOptimizationHistory,
      ['src/index.js optimization loop', 'runOptimization CLI'],
      ['src/index.js optimization loop', 'runOptimization CLI'],
      'optimizationHistory'
    ),
    profileResource(
      'optimizationHistoryWriterLock.cwdOptimizer',
      {
        configuredPath: cwdOptimizationHistoryWriterLockPath,
        absolutePath: cwdOptimizationHistoryWriterLockPath,
        source: 'derivedFromOptimizationHistory',
        resolutionBase: 'optimizationHistory.cwdOptimizer.absolutePath',
        scope: 'history-derived',
        defaultSharing: cwdOptimizationHistory.defaultSharing
      },
      ['appendOptimizerHistory'],
      ['appendOptimizerHistory owner verification/release'],
      'optimizerHistoryWriterLock'
    )
  ].map(resource => ({ ...resource, context: name }));
}

function collectPotentialCrossContextGroups(contexts) {
  const byPath = new Map();
  for (const context of contexts) {
    for (const resource of context.resources) {
      const entry = byPath.get(resource.absolutePath) || {
        absolutePath: resource.absolutePath,
        contexts: new Set(),
        resourceIds: new Set(),
        logicalResources: new Set(),
        scopes: new Set()
      };
      entry.contexts.add(context.name);
      entry.resourceIds.add(resource.id);
      entry.logicalResources.add(resource.logicalResource);
      entry.scopes.add(resource.scope);
      byPath.set(resource.absolutePath, entry);
    }
  }

  return [...byPath.values()]
    .filter(group => group.contexts.size > 1)
    .map(group => ({
      absolutePath: group.absolutePath,
      contexts: [...group.contexts],
      resourceIds: [...group.resourceIds],
      logicalResources: [...group.logicalResources],
      scopes: [...group.scopes],
      risk: 'potential',
      actualCollisionVerified: false
    }));
}

function collectSharedDefaultCandidates(contexts) {
  const candidates = new Map();
  for (const context of contexts) {
    for (const resource of context.resources) {
      if (!resource.defaultSharing) continue;
      // One physical target can have more than one legitimate resolution base
      // (for example runtime logs use CWD while DashboardServer logs use
      // PROJECT_ROOT). Report that shared target once and retain all scopes.
      const candidateKey = `${resource.logicalResource}\0${resource.absolutePath}`;
      const candidate = candidates.get(candidateKey) || {
        absolutePath: resource.absolutePath,
        logicalResource: resource.logicalResource,
        resourceIds: new Set(),
        scopes: new Set(),
        contexts: new Set(),
        conditions: new Set()
      };
      candidate.resourceIds.add(resource.id);
      candidate.scopes.add(resource.scope);
      candidate.contexts.add(context.name);
      candidate.conditions.add(resource.defaultSharing.condition);
      candidates.set(candidateKey, candidate);
    }
  }

  return [...candidates.values()].map(candidate => ({
    absolutePath: candidate.absolutePath,
    logicalResource: candidate.logicalResource,
    resourceIds: [...candidate.resourceIds],
    scopes: [...candidate.scopes],
    contexts: [...candidate.contexts],
    conditions: [...candidate.conditions],
    risk: 'potential',
    actualCollisionVerified: false
  }));
}

/**
 * Build a filesystem-free path manifest. `contexts` are caller-supplied runtime
 * configurations used only for path comparison; their data files are never opened.
 */
export function createRuntimeStoragePlan({
  contexts = null,
  config = {},
  env = process.env,
  liveCredentialStoreOptions = {},
  cwd = process.cwd(),
  projectRoot = DEFAULT_PROJECT_ROOT,
  environmentSource = 'caller-supplied path-only snapshot',
  tempDir = os.tmpdir(),
  pid = process.pid,
  now = Date.now,
  random = Math.random
} = {}) {
  const requestedContexts = contexts?.length
    ? contexts
    : [{ name: 'current-runtime', cwd, projectRoot, config, env, liveCredentialStoreOptions }];
  const commonOptions = { tempDir, pid, now, random };
  const normalizedContexts = requestedContexts.map((context, index) => {
    const name = context.name || `runtime-context-${index + 1}`;
    const contextProjectRoot = path.resolve(context.projectRoot || projectRoot);
    const contextCwd = path.resolve(context.cwd || cwd);
    return {
      name,
      cwd: contextCwd,
      projectRoot: contextProjectRoot,
      resources: resolveContextStoragePaths({
        name,
        cwd: contextCwd,
        projectRoot: contextProjectRoot,
        config: context.config || config,
        env: context.env || env,
        liveCredentialStoreOptions: context.liveCredentialStoreOptions || liveCredentialStoreOptions
      }, commonOptions)
    };
  });

  return {
    schema: 'coinpilot.runtime-storage-plan.v1',
    inspection: {
      readFileContents: false,
      readCredentials: false,
      filesystemMutation: false,
      collisionVerification: false,
      environmentSource,
      dotenvLoadedByInspector: false,
      dotenvOnlyOverridesVisible: false
    },
    contexts: normalizedContexts.map(({ name, cwd: contextCwd, projectRoot: contextProjectRoot }) => ({
      name,
      cwd: contextCwd,
      projectRoot: contextProjectRoot
    })),
    resources: normalizedContexts.flatMap(context => context.resources),
    potentialCrossContextPathGroups: collectPotentialCrossContextGroups(normalizedContexts),
    potentialSharedDefaultPathGroups: collectSharedDefaultCandidates(normalizedContexts)
  };
}

/** Return only path-related environment values; credential variables are ignored. */
export function getStoragePathEnvironment(env = process.env) {
  return Object.fromEntries(
    PATH_ENVIRONMENT_KEYS
      .filter(key => env[key] !== undefined)
      .map(key => [key, env[key]])
  );
}
