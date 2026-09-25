import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE,
  inspectMomentumShadowCandidateSlot
} from './momentumShadowCandidateSlot.js';
import {
  MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION
} from './momentumShadowBenchmark.js';
import { assessMomentumShadowCostFloor } from './momentumShadowCostFloor.js';
import { resolveMomentumShadowExecutionModel } from './momentumShadowExecutionModel.js';
import { resolveMomentumShadowQuoteRuntimeFile } from './momentumShadowQuoteHistory.js';

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
    executionModel: resolveMomentumShadowExecutionModel(config.executionModel),
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

function inspectQuoteQualityReadiness({
  reportFile,
  expectedMarkets = [],
  maxAgeSeconds = 15 * 60,
  now = Date.now()
} = {}) {
  const resolvedFile = path.resolve(reportFile || resolveMomentumShadowQuoteRuntimeFile('quote-quality.json'));
  const result = {
    required: true,
    ready: false,
    reportFile: path.basename(resolvedFile),
    reason: null,
    generatedAt: null,
    ageSeconds: null,
    maxAgeSeconds,
    complete: false,
    errorCount: null,
    sampleCount: null,
    requestedSampleCount: null,
    marketCount: 0,
    missingMarkets: [],
    overCeilingMarkets: []
  };
  if (!fs.existsSync(resolvedFile)) {
    result.reason = 'quote_quality_report_missing';
    return result;
  }
  let report;
  try {
    report = readJson(resolvedFile);
  } catch {
    result.reason = 'quote_quality_report_invalid';
    return result;
  }
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    result.reason = 'quote_quality_report_invalid';
    return result;
  }
  result.generatedAt = report.generatedAt || null;
  const generatedAtMs = Date.parse(report.generatedAt || '');
  const nowMs = Number(now);
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(nowMs) || generatedAtMs > nowMs) {
    result.reason = 'quote_quality_report_timestamp_invalid';
    return result;
  }
  result.ageSeconds = Math.floor((nowMs - generatedAtMs) / 1000);
  if (result.ageSeconds > Number(maxAgeSeconds)) {
    result.reason = 'quote_quality_report_stale';
    return result;
  }
  const summary = report.summary && typeof report.summary === 'object' ? report.summary : {};
  const reportMarkets = summary.markets && typeof summary.markets === 'object'
    ? Object.keys(summary.markets)
    : [];
  const expected = [...new Set(Array.isArray(expectedMarkets) ? expectedMarkets : [])];
  result.marketCount = reportMarkets.length;
  result.missingMarkets = expected.filter(market => !reportMarkets.includes(market));
  result.overCeilingMarkets = expected.filter(market =>
    Number(summary.markets?.[market]?.overCeiling) > 0
  );
  result.complete = report.complete === true && summary.valid === true;
  result.errorCount = Array.isArray(report.errors)
    ? report.errors.length
    : Math.max(0, Number(report.errors) || 0);
  result.sampleCount = Math.max(0, Number(summary.sampleCount) || Number(report.samples?.length) || 0);
  result.requestedSampleCount = Math.max(0, Number(report.requestedSampleCount) || 0);
  if (result.errorCount > 0) {
    result.reason = 'quote_quality_report_errors';
  } else if (!result.complete) {
    result.reason = 'quote_quality_report_incomplete';
  } else if (result.missingMarkets.length > 0) {
    result.reason = 'quote_quality_market_set_incomplete';
  } else if (result.requestedSampleCount > 0 && result.sampleCount < result.requestedSampleCount) {
    result.reason = 'quote_quality_samples_incomplete';
  } else {
    result.ready = true;
    result.reason = 'quote_quality_report_fresh_and_complete';
  }
  return result;
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
  requireQuoteQuality = false,
  quoteReportFile,
  quoteMaxAgeSeconds = 15 * 60,
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

  const resolvedBenchmarkDir = path.resolve(benchmarkDir || '');
  const owners = ownerDirs.map(directory => {
    const resolved = path.resolve(directory);
    const ledger = readJson(path.join(resolved, 'ledger.json'));
    const alive = ownerAlive(ledger?.ownerPid);
    return {
      directory: resolved,
      ownerPid: ledger?.ownerPid || null,
      alive,
      runnerState: ledger?.runnerState || null,
      benchmarkGateOpen: ledger?.benchmarkGateOpen === true,
      isBenchmarkGateSource: resolved === resolvedBenchmarkDir
    };
  });
  const liveOwnerCount = owners.filter(owner =>
    owner.alive && owner.runnerState === 'running' && !owner.isBenchmarkGateSource
  ).length;
  // The benchmark process is the required live source of the gate and is
  // validated independently below. Other live momentum-shadow books still
  // block a candidate so their API load and config drift cannot contaminate
  // the new evidence window.
  if (liveOwnerCount > 0) blockers.push(`existing_live_owner_count:${liveOwnerCount}`);

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
  let benchmarkObservationSchemaVersion = null;
  let benchmarkObservationTelemetryReady = false;
  let benchmarkObservationAvailable = false;
  let benchmarkObservationReason = null;
  let benchmarkObservationCheckpointCount = 0;
  let benchmarkObservationValidCheckpointCount = 0;
  let benchmarkObservationRestart = {
    required: false,
    safe: false,
    blockers: [],
    openPositionCount: 0,
    tradeCount: 0,
    pendingEntryCount: 0
  };
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
    benchmarkObservationSchemaVersion = benchmark.benchmarkObservationSchemaVersion === null ||
      benchmark.benchmarkObservationSchemaVersion === undefined ||
      benchmark.benchmarkObservationSchemaVersion === ''
      ? null
      : Number(benchmark.benchmarkObservationSchemaVersion);
    benchmarkObservationTelemetryReady =
      benchmarkObservationSchemaVersion === MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION;
    benchmarkObservationAvailable = benchmarkObservationTelemetryReady &&
      benchmark.benchmarkObservationAvailable === true;
    benchmarkObservationReason = benchmark.benchmarkObservationReason || null;
    const benchmarkObservationCheckpoints = Array.isArray(benchmark.benchmarkObservationCheckpoints)
      ? benchmark.benchmarkObservationCheckpoints
      : [];
    benchmarkObservationCheckpointCount = benchmarkObservationCheckpoints.length;
    benchmarkObservationValidCheckpointCount = benchmarkObservationCheckpoints.filter(checkpoint =>
      checkpoint?.dataQualityValid === true
    ).length;
    const benchmarkOpenPositionCount = Object.keys(benchmark.positions || {}).length;
    const benchmarkTradeCount = Array.isArray(benchmark.trades) ? benchmark.trades.length : 0;
    const benchmarkPendingEntryCount = Array.isArray(benchmark.pendingEntries)
      ? benchmark.pendingEntries.length
      : 0;
    const restartBlockers = [];
    if (benchmark.runnerState !== 'running' || !ownerAlive(benchmark.ownerPid)) {
      restartBlockers.push('benchmark_owner_not_running');
    }
    if (!heartbeatFresh) restartBlockers.push('benchmark_heartbeat_stale');
    if (benchmarkOpenPositionCount > 0) restartBlockers.push('benchmark_positions_open');
    if (benchmarkTradeCount > 0) restartBlockers.push('benchmark_trades_exist');
    if (benchmarkPendingEntryCount > 0) restartBlockers.push('benchmark_pending_entries');
    if (benchmark.dataQuality?.valid !== true) restartBlockers.push('benchmark_data_quality_invalid');
    benchmarkObservationRestart = {
      required: !benchmarkObservationTelemetryReady,
      safe: !benchmarkObservationTelemetryReady && restartBlockers.length === 0,
      blockers: restartBlockers,
      openPositionCount: benchmarkOpenPositionCount,
      tradeCount: benchmarkTradeCount,
      pendingEntryCount: benchmarkPendingEntryCount
    };
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
    if (!benchmarkObservationTelemetryReady) {
      warnings.push('benchmark_observation_telemetry_legacy');
    } else if (!benchmarkObservationAvailable) {
      warnings.push('benchmark_observation_unavailable');
    }
  }

  const candidateConfig = normalizedConfig(expectedConfig);
  const costFloor = assessMomentumShadowCostFloor(candidateConfig.costPercent);
  const executionCost = {
    candidateRoundTripCostPercent: candidateConfig.costPercent,
    requiredRoundTripCostPercent: costFloor.requiredCostPercent,
    ready: costFloor.ready
  };
  executionCost.reason = costFloor.reason;
  if (!executionCost.ready) blockers.push('candidate_cost_below_round_trip_cost_floor');
  if (candidateConfig.pollMs < minimumPollMs) {
    blockers.push('candidate_poll_below_minimum');
  }
  if (candidateConfig.benchmarkMarket === null) blockers.push('candidate_benchmark_missing');
  if (candidateConfig.maxPortfolioDrawdownPercent <= 0) warnings.push('candidate_drawdown_stop_disabled');

  const quoteExecutionRequired = requireQuoteQuality ||
    candidateConfig.executionModel === 'quote_cross';
  const quoteQuality = quoteExecutionRequired
    ? inspectQuoteQualityReadiness({
      reportFile: quoteReportFile,
      expectedMarkets: candidateConfig.markets,
      maxAgeSeconds: quoteMaxAgeSeconds,
      now
    })
    : {
      required: false,
      ready: true,
      reportFile: null,
      reason: 'quote_quality_not_required_for_candle_close_contract'
    };
  if (quoteExecutionRequired && !quoteQuality.ready) {
    blockers.push(quoteQuality.reason);
  }
  if (quoteExecutionRequired && quoteQuality.overCeilingMarkets?.length) {
    warnings.push(`quote_quality_over_ceiling_markets:${quoteQuality.overCeilingMarkets.join(',')}`);
  }

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
    executionCost,
    quoteQuality,
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
      observationSchemaVersion: benchmarkObservationSchemaVersion,
      observationTelemetryReady: benchmarkObservationTelemetryReady,
      observationAvailable: benchmarkObservationAvailable,
      observationReason: benchmarkObservationAvailable
        ? benchmarkObservationReason || null
        : benchmarkObservationReason || 'benchmark_observation_not_recorded',
      observationCheckpointCount: benchmarkObservationCheckpointCount,
      observationValidCheckpointCount: benchmarkObservationValidCheckpointCount,
      observationRestart: benchmarkObservationRestart,
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
