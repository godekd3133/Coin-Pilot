import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function ownerAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizedConfig(config = {}) {
  return {
    mode: config.mode || 'regime',
    markets: Array.isArray(config.markets) ? [...config.markets] : [],
    trendMinPercent: Number(config.trendMinPercent) || 0,
    breadthMin: Number(config.breadthMin) || 0,
    minUpBars: Number(config.minUpBars) || 1,
    positionFraction: Number(config.positionFraction) || 0,
    maxPositions: Number(config.maxPositions) || 0,
    benchmarkMarket: config.benchmarkMarket || null,
    benchmarkTrendMinPercent: Number.isFinite(Number(config.benchmarkTrendMinPercent))
      ? Number(config.benchmarkTrendMinPercent)
      : null,
    exitOnBenchmarkOff: config.exitOnBenchmarkOff === true,
    cooldownAfterLossDays: Number(config.cooldownAfterLossDays) || 0,
    maxPortfolioDrawdownPercent: Number(config.maxPortfolioDrawdownPercent) || 0,
    pollMs: Number(config.pollMs) || 0
  };
}

function configDifferences(actual, expected) {
  return Object.keys(expected).filter(key => {
    const left = actual[key];
    const right = expected[key];
    if (Array.isArray(left) || Array.isArray(right)) {
      return JSON.stringify(left || []) !== JSON.stringify(right || []);
    }
    return left !== right;
  });
}

/**
 * Read-only gate before starting a new risk-capped momentum shadow owner.
 * It deliberately blocks while the benchmark gate is closed so an empty
 * candidate process cannot silently become another competing API consumer.
 */
export function inspectMomentumShadowCandidate({
  targetDir,
  benchmarkDir,
  ownerDirs = [],
  expectedConfig = {},
  requireBenchmarkOpen = true,
  minimumPollMs = 15 * 60 * 1000,
  now = Date.now()
} = {}) {
  const blockers = [];
  const warnings = [];
  const target = path.resolve(targetDir || '.paper-momentum-shadow-candidate');
  const targetLedgerFile = path.join(target, 'ledger.json');
  const targetLockFile = path.join(target, '.momentum-shadow.lock');
  const targetLedger = readJson(targetLedgerFile);
  const targetLock = readJson(targetLockFile);
  if (targetLock?.pid && ownerAlive(targetLock.pid)) blockers.push('target_owner_already_running');
  if (targetLock && !ownerAlive(targetLock.pid)) warnings.push('target_lock_is_stale');
  if (targetLedger) {
    const differences = configDifferences(
      normalizedConfig(targetLedger.config),
      normalizedConfig(expectedConfig)
    );
    if (differences.length) blockers.push(`target_config_drift:${differences.join(',')}`);
    if (targetLedger.runnerState === 'running' && ownerAlive(targetLedger.ownerPid)) {
      blockers.push('target_ledger_owner_alive');
    }
  }

  const owners = ownerDirs.map(directory => {
    const resolved = path.resolve(directory);
    const ledger = readJson(path.join(resolved, 'ledger.json'));
    const alive = ownerAlive(ledger?.ownerPid);
    return {
      directory: resolved,
      ownerPid: ledger?.ownerPid || null,
      alive,
      runnerState: ledger?.runnerState || null,
      benchmarkGateOpen: ledger?.benchmarkGateOpen === true
    };
  });
  const liveOwnerCount = owners.filter(owner => owner.alive && owner.runnerState === 'running').length;
  if (liveOwnerCount > 0) warnings.push(`existing_live_owner_count:${liveOwnerCount}`);

  const benchmark = readJson(path.join(path.resolve(benchmarkDir || ''), 'ledger.json'));
  let benchmarkHeartbeatAgeSeconds = null;
  let benchmarkHeartbeatFresh = false;
  let benchmarkPollMs = null;
  let benchmarkStaleLimitMs = null;
  let benchmarkNextPollAt = null;
  let benchmarkNextPollDueInSeconds = null;
  if (!benchmark) {
    blockers.push('benchmark_ledger_missing');
  } else {
    const heartbeatMs = Date.parse(benchmark.heartbeatAt || '');
    const pollMs = Number(benchmark.config?.pollMs) || 15 * 60 * 1000;
    const heartbeatAgeSeconds = Number.isFinite(heartbeatMs)
      ? Math.max(0, Math.round((Number(now) - heartbeatMs) / 1000))
      : null;
    const staleLimitMs = Math.max(600_000, pollMs * 5);
    const heartbeatFresh = heartbeatAgeSeconds !== null && heartbeatAgeSeconds * 1000 <= staleLimitMs;
    const nextPollAtMs = Number.isFinite(heartbeatMs) ? heartbeatMs + pollMs : null;
    benchmarkHeartbeatAgeSeconds = heartbeatAgeSeconds;
    benchmarkHeartbeatFresh = heartbeatFresh;
    benchmarkPollMs = pollMs;
    benchmarkStaleLimitMs = staleLimitMs;
    benchmarkNextPollAt = nextPollAtMs === null ? null : new Date(nextPollAtMs).toISOString();
    benchmarkNextPollDueInSeconds = nextPollAtMs === null
      ? null
      : Math.max(0, Math.ceil((nextPollAtMs - Number(now)) / 1000));
    if (benchmark.runnerState !== 'running' || !ownerAlive(benchmark.ownerPid)) {
      blockers.push('benchmark_owner_not_running');
    }
    if (!heartbeatFresh) {
      blockers.push('benchmark_heartbeat_stale');
    }
    if (requireBenchmarkOpen && benchmark.benchmarkGateOpen !== true) {
      blockers.push('benchmark_gate_closed');
    }
    if (pollMs < minimumPollMs) warnings.push('benchmark_poll_below_candidate_budget');
  }

  const candidateConfig = normalizedConfig(expectedConfig);
  if (candidateConfig.pollMs < minimumPollMs) {
    blockers.push('candidate_poll_below_minimum');
  }
  if (candidateConfig.benchmarkMarket === null) blockers.push('candidate_benchmark_missing');
  if (candidateConfig.maxPortfolioDrawdownPercent <= 0) warnings.push('candidate_drawdown_stop_disabled');

  return {
    launchAllowed: blockers.length === 0,
    targetDir: target,
    targetLedgerExists: Boolean(targetLedger),
    targetLockExists: Boolean(targetLock),
    candidateConfig,
    benchmark: benchmark ? {
      ownerPid: benchmark.ownerPid || null,
      runnerState: benchmark.runnerState || null,
      gateOpen: benchmark.benchmarkGateOpen === true,
      trendPercent: Number.isFinite(Number(benchmark.benchmarkTrendPercent))
        ? Number(benchmark.benchmarkTrendPercent)
        : null,
      heartbeatAt: benchmark.heartbeatAt || null,
      heartbeatAgeSeconds: benchmarkHeartbeatAgeSeconds,
      heartbeatFresh: benchmarkHeartbeatFresh,
      pollMs: benchmarkPollMs,
      staleLimitSeconds: Math.round(benchmarkStaleLimitMs / 1000),
      nextPollAt: benchmarkNextPollAt,
      nextPollDueInSeconds: benchmarkNextPollDueInSeconds
    } : null,
    owners,
    liveOwnerCount,
    blockers,
    warnings,
    readOnly: true,
    promotionAllowed: false
  };
}
