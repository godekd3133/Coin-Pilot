import path from 'node:path';

const OPTIMIZATION_FILES = Object.freeze({
  optimizationStateFile: {
    fileName: 'optimization_state.json',
    environmentKey: 'COINPILOT_OPTIMIZATION_STATE_FILE'
  },
  optimizationHistoryFile: {
    fileName: 'optimization_history.json',
    environmentKey: 'COINPILOT_OPTIMIZATION_HISTORY_FILE'
  },
  optimalConfigFile: {
    fileName: 'optimal_config.json',
    environmentKey: 'COINPILOT_OPTIMAL_CONFIG_FILE'
  }
});

/**
 * Resolve optimizer persistence paths without changing the legacy defaults.
 * Explicit per-file options and environment paths win, then COINPILOT_STATE_DIR,
 * then the caller-specific historic root (cwd or PROJECT_ROOT).
 */
export function resolveOptimizationStoragePaths({
  env = process.env,
  cwd = process.cwd(),
  projectRoot = cwd,
  stateDir = env.COINPILOT_STATE_DIR,
  legacyBase = 'cwd',
  ...fileOptions
} = {}) {
  const absoluteCwd = path.resolve(cwd);
  const absoluteProjectRoot = path.resolve(projectRoot);
  const legacyRoot = legacyBase === 'projectRoot' ? absoluteProjectRoot : absoluteCwd;
  const absoluteStateDir = stateDir ? path.resolve(absoluteCwd, stateDir) : null;

  return Object.fromEntries(Object.entries(OPTIMIZATION_FILES).map(([optionKey, spec]) => {
    const explicitOption = fileOptions[optionKey];
    const explicitEnvironment = env[spec.environmentKey];
    let configuredPath;
    let source;
    let base;
    let resolutionBase;
    let scope;
    let defaultSharing = null;

    if (typeof explicitOption === 'string' && explicitOption.trim()) {
      configuredPath = explicitOption;
      source = `option.${optionKey}`;
      base = absoluteCwd;
      resolutionBase = path.isAbsolute(configuredPath) ? 'absolute-input' : 'cwd';
      scope = 'explicit-path';
    } else if (typeof explicitEnvironment === 'string' && explicitEnvironment.trim()) {
      configuredPath = explicitEnvironment;
      source = `env.${spec.environmentKey}`;
      base = absoluteCwd;
      resolutionBase = path.isAbsolute(configuredPath) ? 'absolute-input' : 'cwd';
      scope = 'explicit-path';
    } else if (absoluteStateDir) {
      configuredPath = path.join(absoluteStateDir, spec.fileName);
      source = 'env.COINPILOT_STATE_DIR';
      base = absoluteCwd;
      resolutionBase = 'COINPILOT_STATE_DIR';
      scope = 'state-dir';
    } else {
      configuredPath = path.join(legacyRoot, spec.fileName);
      source = 'legacyDefault';
      base = absoluteCwd;
      resolutionBase = legacyBase === 'projectRoot' ? 'PROJECT_ROOT' : 'cwd';
      scope = resolutionBase;
      defaultSharing = {
        risk: 'potential',
        condition: `another runtime context uses the same ${resolutionBase} optimizer default`
      };
    }

    const absolutePath = path.isAbsolute(configuredPath)
      ? path.resolve(configuredPath)
      : path.resolve(base, configuredPath);
    return [optionKey, {
      configuredPath,
      absolutePath,
      source,
      resolutionBase,
      scope,
      defaultSharing
    }];
  }));
}
