import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE,
  inspectMomentumShadowCandidateSlot
} from './momentumShadowCandidateSlot.js';

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
  const relativeTrendValue = config.relativeTrendMinPercent;
  return {
    mode: config.mode || 'regime',
    maxHoldHours: Math.max(1, Number(config.maxHoldHours) || 0),
    markets: Array.isArray(config.markets) ? [...config.markets] : [],
    trendMinPercent: Number(config.trendMinPercent) || 0,
    breadthMin: Number(config.breadthMin) || 0,
    minUpBars: Number(config.minUpBars) || 1,
    positionFraction: Number(config.positionFraction) || 0,
    maxPositions: Number(config.maxPositions) || 0,
    costPercent: Math.max(0, Number(config.costPercent) || 0),
    benchmarkMarket: config.benchmarkMarket || null,
    benchmarkTrendMinPercent: Number.isFinite(Number(config.benchmarkTrendMinPercent))
      ? Number(config.benchmarkTrendMinPercent)
      : null,
    relativeTrendMinPercent: relativeTrendValue === null ||
      relativeTrendValue === undefined || relativeTrendValue === ''
      ? null
      : Number.isFinite(Number(relativeTrendValue))
        ? Math.max(0, Number(relativeTrendValue))
        : null,
    exitOnBenchmarkOff: config.exitOnBenchmarkOff === true,
    cooldownAfterLossDays: Number(config.cooldownAfterLossDays) || 0,
    volatilityLookbackDays: Math.max(2, Number(config.volatilityLookbackDays) || 14),
    volatilityTargetPercent: Number.isFinite(Number(config.volatilityTargetPercent)) &&
      Number(config.volatilityTargetPercent) > 0
      ? Number(config.volatilityTargetPercent)
      : null,
    entryExecution: config.entryExecution === 'next_open' ? 'next_open' : 'close',
    maxEntryGapPercent: Math.max(0, Number(config.maxEntryGapPercent) || 0),
    maxDailyCandleAgeHours: Math.max(0, Number(config.maxDailyCandleAgeHours) || 0),
    maxSpreadPercent: Math.max(0, Number(config.maxSpreadPercent) || 0),
    requestIntervalMs: Math.max(100, Number(config.requestIntervalMs) || 500),
    stopLossPercent: Math.max(0, Number(config.stopLossPercent) || 0),
    takeProfitPercent: Math.max(0, Number(config.takeProfitPercent) || 0),
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
  candidateSlotFile = DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE,
  now = Date.now()
} = {}) {
  const blockers = [];
  const warnings = [];
  const candidateSlot = inspectMomentumShadowCandidateSlot(candidateSlotFile);
  if (!candidateSlot.valid) {
    blockers.push('candidate_slot_unverifiable');
  } else if (candidateSlot.occupied) {
    blockers.push('candidate_slot_occupied');
  } else if (candidateSlot.exists) {
    warnings.push('candidate_slot_is_stale');
  }
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

  const expectedBenchmarkThreshold = Number.isFinite(Number(expectedConfig?.benchmarkTrendMinPercent))
    ? Number(expectedConfig.benchmarkTrendMinPercent)
    : null;
  const benchmark = readJson(path.join(path.resolve(benchmarkDir || ''), 'ledger.json'));
  let benchmarkHeartbeatAgeSeconds = null;
  let benchmarkHeartbeatFresh = false;
  let benchmarkPollMs = null;
  let benchmarkStaleLimitMs = null;
  let benchmarkNextPollAt = null;
  let benchmarkNextPollDueInSeconds = null;
  let benchmarkTrend = null;
  let benchmarkCandidateGateOpen = false;
  let benchmarkSourceGateOpen = false;
  let benchmarkDataQuality = null;
  let benchmarkFetchErrors = 0;
  let benchmarkFetchFailureStreak = 0;
  let benchmarkFetchCircuitOpen = false;
  if (!benchmark) {
    blockers.push('benchmark_ledger_missing');
  } else {
    const heartbeatMs = Date.parse(benchmark.heartbeatAt || '');
    const pollMs = Number(benchmark.config?.pollMs) || 15 * 60 * 1000;
    // A heartbeat written in the future is clock-skewed, not fresh — treat
    // it as unverifiable like a missing timestamp instead of age zero.
    const heartbeatAgeSeconds = Number.isFinite(heartbeatMs) && Number(now) >= heartbeatMs
      ? Math.round((Number(now) - heartbeatMs) / 1000)
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
    const rawBenchmarkTrend = benchmark.benchmarkTrendPercent;
    benchmarkTrend = rawBenchmarkTrend === null ||
      rawBenchmarkTrend === undefined || rawBenchmarkTrend === ''
      ? null
      : Number(rawBenchmarkTrend);
    benchmarkFetchErrors = Math.max(0, Number(benchmark.fetchErrors) || 0);
    benchmarkFetchFailureStreak = Math.max(0, Number(benchmark.networkFetchFailureStreak) || 0);
    benchmarkFetchCircuitOpen = benchmark.networkFetchCircuitOpen === true;
    benchmarkDataQuality = benchmark.dataQuality && typeof benchmark.dataQuality === 'object'
      ? {
        valid: benchmark.dataQuality.valid === true,
        reason: benchmark.dataQuality.reason || null,
        marketCount: Number(benchmark.dataQuality.marketCount) || 0,
        missingMarkets: Array.isArray(benchmark.dataQuality.missingMarkets)
          ? benchmark.dataQuality.missingMarkets
          : [],
        invalidMarkets: Array.isArray(benchmark.dataQuality.invalidMarkets)
          ? benchmark.dataQuality.invalidMarkets
          : [],
        unalignedMarkets: Array.isArray(benchmark.dataQuality.unalignedMarkets)
          ? benchmark.dataQuality.unalignedMarkets
          : [],
        staleMarkets: Array.isArray(benchmark.dataQuality.staleMarkets)
          ? benchmark.dataQuality.staleMarkets
          : [],
        latestTimestamp: benchmark.dataQuality.latestTimestamp || null
      }
      : null;
    benchmarkCandidateGateOpen = expectedBenchmarkThreshold !== null &&
      Number.isFinite(benchmarkTrend) && benchmarkTrend > expectedBenchmarkThreshold;
    benchmarkSourceGateOpen = benchmark.benchmarkGateOpen === true;
    if (benchmark.runnerState !== 'running' || !ownerAlive(benchmark.ownerPid)) {
      blockers.push('benchmark_owner_not_running');
    }
    if (!heartbeatFresh) {
      blockers.push('benchmark_heartbeat_stale');
    }
    if (benchmarkDataQuality?.valid !== true) {
      blockers.push(benchmarkDataQuality
        ? 'benchmark_data_quality_invalid'
        : 'benchmark_data_quality_unverified');
    }
    if (requireBenchmarkOpen && !benchmarkCandidateGateOpen) {
      blockers.push('benchmark_gate_closed');
    }
    if (pollMs < minimumPollMs) warnings.push('benchmark_poll_below_candidate_budget');
    // fetchErrors is a lifetime counter that never clears, so it cannot
    // distinguish a currently failing owner from a recovered one. Warn only
    // on an active streak or open circuit; the lifetime count stays visible
    // in the benchmark projection below.
    if (benchmarkFetchFailureStreak > 0 || benchmarkFetchCircuitOpen) {
      warnings.push(`benchmark_fetch_failures_active:${benchmarkFetchFailureStreak}`);
    }
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
    candidateSlot: {
      exists: candidateSlot.exists,
      valid: candidateSlot.valid,
      occupied: candidateSlot.occupied,
      ownerPid: candidateSlot.ownerPid,
      startedAt: candidateSlot.startedAt
    },
    candidateConfig,
    benchmark: benchmark ? {
      ownerPid: benchmark.ownerPid || null,
      runnerState: benchmark.runnerState || null,
      gateOpen: benchmarkCandidateGateOpen,
      sourceGateOpen: benchmarkSourceGateOpen,
      candidateThresholdPercent: expectedBenchmarkThreshold,
      sourceThresholdPercent: Number.isFinite(Number(benchmark.config?.benchmarkTrendMinPercent))
        ? Number(benchmark.config.benchmarkTrendMinPercent)
        : null,
      trendPercent: Number.isFinite(benchmarkTrend) ? benchmarkTrend : null,
      fetchErrors: benchmarkFetchErrors,
      fetchFailureStreak: benchmarkFetchFailureStreak,
      fetchCircuitOpen: benchmarkFetchCircuitOpen,
      heartbeatAt: benchmark.heartbeatAt || null,
      heartbeatAgeSeconds: benchmarkHeartbeatAgeSeconds,
      heartbeatFresh: benchmarkHeartbeatFresh,
      dataQuality: benchmarkDataQuality || {
        valid: false,
        reason: 'benchmark_data_quality_unverified',
        marketCount: 0,
        missingMarkets: [],
        invalidMarkets: [],
        unalignedMarkets: [],
        staleMarkets: [],
        latestTimestamp: null
      },
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
