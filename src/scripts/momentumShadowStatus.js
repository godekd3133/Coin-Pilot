import fs from 'node:fs';
import { getMomentumShadowEquity } from '../research/momentumShadowLedger.js';
import {
  summarizeMomentumShadowBenchmarkObservationCheckpoints,
  calculateMomentumShadowBenchmarkReturnPercent,
  calculateMomentumShadowRelativeMarkedReturnPercent,
  MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION
} from '../research/momentumShadowBenchmark.js';
import {
  calculateMomentumShadowRealizedProfit,
  calculateMomentumShadowRealizedReturnPercent,
  calculateMomentumShadowTradeConfidence,
  summarizeMomentumShadowTradesByMarket,
  calculateMomentumShadowObservationDays,
  DEFAULT_MOMENTUM_SHADOW_MIN_RESEARCH_DAYS
} from '../research/momentumShadowProfitability.js';
import { summarizeMomentumShadowQuoteExecutionEvidence } from '../research/momentumShadowQuoteQuality.js';
import { resolveMomentumShadowExecutionModel } from '../research/momentumShadowExecutionModel.js';

/**
 * Read-only status printer for the momentum shadow books.
 * Usage: node src/scripts/momentumShadowStatus.js [dir ...]
 * Defaults to all known books, including the volatility and fixed-hold A/B
 * books. Never mutates ledgers.
 *
 * Mirrors the forward-paper orphan convention: a book whose recorded owner
 * PID is dead, or whose heartbeat is older than five poll intervals, is
 * reported as STOPPED rather than as a healthy live session.
 */
const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
    '.paper-momentum-shadow-v1',
    '.paper-momentum-shadow-regime',
    '.paper-momentum-shadow-btc-gate-v1',
    '.paper-momentum-shadow-vol-target-v1',
    '.paper-momentum-shadow-next-open-v1',
    '.paper-momentum-shadow-fixed-hold-2d-v1',
    '.paper-momentum-shadow-fixed-hold-2d-spread-v1',
    '.paper-momentum-shadow-fixed-hold-2d-relative-v1'
  ];
const defaultPollMs = Number(process.env.MOMO_SHADOW_POLL_MS) || 5 * 60 * 1000;

function ownerAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return null;
  if (value === process.pid) return true;
  try { process.kill(value, 0); return true; } catch { return false; }
}

for (const dir of dirs) {
  let l;
  try { l = JSON.parse(fs.readFileSync(`${dir}/ledger.json`, 'utf8')); }
  catch { console.log(`${dir}: no ledger`); continue; }
  const heartbeatMs = Date.parse(l.heartbeatAt);
  // Missing, malformed, or future heartbeats are all unverifiable freshness.
  const heartbeatAgeMs = Number.isFinite(heartbeatMs) && Date.now() >= heartbeatMs
    ? Date.now() - heartbeatMs
    : null;
  const pollMs = Number(l.config?.pollMs) ||
    (l.config?.benchmarkMarket ? 15 * 60 * 1000 : defaultPollMs);
  const heartbeatLimitMs = Math.max(600_000, pollMs * 5);
  const nextPollAtMs = Number.isFinite(heartbeatMs) ? heartbeatMs + pollMs : null;
  const nextPollDueInSeconds = nextPollAtMs === null
    ? null
    : Math.max(0, Math.ceil((nextPollAtMs - Date.now()) / 1000));
  const ownerProcessAlive = ownerAlive(l.ownerPid);
  const orphanReason = l.runnerState === 'stopped'
    ? 'recorded_stop'
    : l.runnerState !== 'running'
    ? 'runner_state_missing'
    : ownerProcessAlive !== true
    ? 'owner_process_missing'
    : heartbeatAgeMs === null || heartbeatAgeMs > heartbeatLimitMs
      ? 'heartbeat_stale'
      : null;
  const state = orphanReason ? `STOPPED:${orphanReason}` : 'RUNNING';
  const open = Object.entries(l.positions || {});
  const executionModel = resolveMomentumShadowExecutionModel(l.config?.executionModel);
  const equity = getMomentumShadowEquity(l, Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000);
  const benchmarkObservationSchemaVersion = l.benchmarkObservationSchemaVersion === null ||
    l.benchmarkObservationSchemaVersion === undefined ||
    l.benchmarkObservationSchemaVersion === ''
    ? null
    : Number(l.benchmarkObservationSchemaVersion);
  const benchmarkObservationTelemetryReady =
    benchmarkObservationSchemaVersion === MOMENTUM_SHADOW_BENCHMARK_OBSERVATION_SCHEMA_VERSION;
  const benchmarkObservationReturnPercent = calculateMomentumShadowBenchmarkReturnPercent(
    l.benchmarkObservationStartPrice,
    l.benchmarkObservationMarkPrice
  );
  const benchmarkObservationAvailable = benchmarkObservationTelemetryReady &&
    l.benchmarkObservationAvailable === true &&
    typeof l.benchmarkObservationStartTs === 'string' &&
    l.benchmarkObservationStartTs.trim().length > 0 &&
    typeof l.benchmarkObservationMarkTs === 'string' &&
    l.benchmarkObservationMarkTs.trim().length > 0 &&
    benchmarkObservationReturnPercent !== null;
  const relativeMarkedReturnPercent = benchmarkObservationAvailable
    ? calculateMomentumShadowRelativeMarkedReturnPercent(
      equity.markedReturnPercent,
      benchmarkObservationReturnPercent
    )
    : null;
  const benchmarkObservationCheckpoints =
    summarizeMomentumShadowBenchmarkObservationCheckpoints(
      benchmarkObservationTelemetryReady ? l.benchmarkObservationCheckpoints : []
    );
  const realized = calculateMomentumShadowRealizedProfit(l);
  const realizedByMarket = summarizeMomentumShadowTradesByMarket(l);
  const realizedReturnPercent = calculateMomentumShadowRealizedReturnPercent(
    l,
    Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000
  );
  const confidence = calculateMomentumShadowTradeConfidence(l);
  const quoteExecution = summarizeMomentumShadowQuoteExecutionEvidence(l.trades);
  const observationDays = calculateMomentumShadowObservationDays(l);
  const minimumResearchDays = Math.max(
    1,
    Number(process.env.MOMO_SHADOW_MIN_RESEARCH_DAYS) ||
      DEFAULT_MOMENTUM_SHADOW_MIN_RESEARCH_DAYS
  );
  console.log(`\n=== ${dir} (mode=${l.config?.mode || 'fixed'}) [${state}] ===`);
  const markedReturn = Number.isFinite(equity.markedReturnPercent)
    ? `${equity.markedReturnPercent >= 0 ? '+' : ''}${equity.markedReturnPercent.toFixed(2)}%`
    : '—';
  console.log(`heartbeat ${l.heartbeatAt} (age ${heartbeatAgeMs === null ? 'unknown' : `${Math.round(heartbeatAgeMs / 1000)}s`}) | owner ${l.ownerPid ?? '-'} | cycles ${l.cycles} | cash ${Math.round(l.balance).toLocaleString()} KRW | marked equity ${Math.round(equity.markedEquity).toLocaleString()} KRW | return ${markedReturn} | unrealized ${Math.round(equity.unrealizedProfit).toLocaleString()} KRW`);
  if (l.runnerState === 'running' && nextPollAtMs !== null) {
    console.log(`next poll ${new Date(nextPollAtMs).toISOString()} (in ${nextPollDueInSeconds}s)`);
  }
  console.log(`open: ${open.map(([m, p]) => `${m.replace('KRW-', '')}@${p.entryPrice}${p.markPrice !== undefined ? `→${p.markPrice} ${Number(p.markProfitPercent || 0) >= 0 ? '+' : ''}${Number(p.markProfitPercent || 0).toFixed(2)}%` : ''}`).join(' ') || 'none'}`);
  const executionModelBlockedCount =
    (Number(l.executionModelEntryBlocked) || 0) +
    (Number(l.executionModelExitBlocked) || 0) +
    (Number(l.executionModelMarkBlocked) || 0) +
    (Number(l.pendingEntryExecutionBlocked) || 0);
  console.log(`execution model ${executionModel} | ${executionModel === 'quote_cross' ? 'best ask entry · best bid exit/mark · modeled paper price' : 'completed candle close'} | blocked ${executionModelBlockedCount}`);
  if (executionModel === 'quote_cross') {
    const quoteReady = l.quoteQuality?.executionReady === true;
    console.log(`quote-cross readiness ${quoteReady ? 'ready' : `blocked ${l.quoteQuality?.reason || 'quote_boundary_unavailable'}`} | actual fills not observed`);
  }
  const realizedReturn = Number.isFinite(Number(realizedReturnPercent))
    ? `${realizedReturnPercent >= 0 ? '+' : ''}${realizedReturnPercent.toFixed(2)}%`
    : '—';
  const confidenceLowerBoundValue = confidence.lowerBoundPercent === null ||
    confidence.lowerBoundPercent === undefined ||
    !Number.isFinite(Number(confidence.lowerBoundPercent))
    ? null
    : Number(confidence.lowerBoundPercent);
  const confidenceLowerBound = confidenceLowerBoundValue === null
    ? 'unavailable'
    : `${confidenceLowerBoundValue >= 0 ? '+' : ''}${confidenceLowerBoundValue.toFixed(2)}%`;
  console.log(`closed trades: ${(l.trades || []).length} | realized ${Math.round(realized).toLocaleString()} KRW (${realizedReturn}) | trade-return 95% lower ${confidenceLowerBound} | valid returns ${confidence.sampleCount}/${(l.trades || []).length}`);
  const marketAttribution = Object.entries(realizedByMarket)
    .filter(([, row]) => row.validReturnCount > 0)
    .map(([market, row]) => {
      const profit = `${row.realizedProfit >= 0 ? '+' : ''}${Math.round(row.realizedProfit).toLocaleString()} KRW`;
      const average = row.averageProfitPercent === null
        ? 'unavailable'
        : `${row.averageProfitPercent >= 0 ? '+' : ''}${row.averageProfitPercent.toFixed(2)}% avg`;
      return `${market.replace(/^KRW-/, '')} ${profit} (${row.validReturnCount}/${row.tradeCount} valid, ${average})`;
    })
    .join(' | ');
  if (marketAttribution) console.log(`realized by market: ${marketAttribution}`);
  const observationLabel = observationDays === null ? 'unknown' : `${observationDays.toFixed(2)}d`;
  const finalEvaluation = orphanReason ? `not-ready:${orphanReason}` :
    l.configDrift ? 'not-ready:config_drift' :
      l.runnerState === 'running' ? 'in-progress' : 'stopped';
  console.log(`observation ${observationLabel} | minimum ${minimumResearchDays}d | final ${finalEvaluation}`);
  if (l.voidedEntries?.length) console.log(`voided entries: ${l.voidedEntries.length}`);
  if (l.configDrift) {
    console.log(`config drift recorded at ${l.configDrift.changedAt} | evidence not eligible for A/B or promotion`);
  }
  if (l.config?.benchmarkMarket) {
    console.log(`benchmark ${l.config.benchmarkMarket.replace(/^KRW-/, '')} trend ${l.benchmarkTrendPercent === null || l.benchmarkTrendPercent === undefined ? 'unknown' : `${Number(l.benchmarkTrendPercent).toFixed(2)}%`} | gate ${l.benchmarkGateOpen === true ? 'open' : 'closed'} | blocked ${l.benchmarkBlocked ?? 0}`);
    const benchmarkReturn = benchmarkObservationAvailable
      ? `${benchmarkObservationReturnPercent >= 0 ? '+' : ''}${benchmarkObservationReturnPercent.toFixed(2)}%`
      : 'unavailable';
    const relativeReturn = relativeMarkedReturnPercent !== null &&
      Number.isFinite(Number(relativeMarkedReturnPercent))
      ? `${relativeMarkedReturnPercent >= 0 ? '+' : ''}${relativeMarkedReturnPercent.toFixed(2)}%`
      : 'unavailable';
    console.log(`benchmark observation price return ${benchmarkReturn} | relative marked ${relativeReturn} | price-only, actual fills not observed`);
    console.log(`benchmark observation telemetry ${benchmarkObservationTelemetryReady ? `schema ${benchmarkObservationSchemaVersion}` : 'legacy owner restart required'}`);
    const checkpointRange = benchmarkObservationCheckpoints.available
      ? `${benchmarkObservationCheckpoints.worstRelativeMarkedReturnPercent >= 0 ? '+' : ''}${benchmarkObservationCheckpoints.worstRelativeMarkedReturnPercent.toFixed(2)}%~${benchmarkObservationCheckpoints.bestRelativeMarkedReturnPercent >= 0 ? '+' : ''}${benchmarkObservationCheckpoints.bestRelativeMarkedReturnPercent.toFixed(2)}%`
      : 'unavailable';
    console.log(`benchmark observation checkpoints ${benchmarkObservationCheckpoints.checkpointCount} | relative range ${checkpointRange} | daily completed-bar history`);
  }
  const relativeTrendMinPercent = l.config?.relativeTrendMinPercent;
  if (relativeTrendMinPercent !== null && relativeTrendMinPercent !== undefined &&
    relativeTrendMinPercent !== '' && Number.isFinite(Number(relativeTrendMinPercent))) {
    console.log(`relative trend > benchmark +${Number(relativeTrendMinPercent).toFixed(2)}% | blocked ${Number(l.relativeTrendBlocked) || 0}`);
  }
  const volatilityTarget = Number(l.config?.volatilityTargetPercent);
  if (Number.isFinite(volatilityTarget) && volatilityTarget > 0) {
    const scales = Object.values(l.volatilityScaleByMarket || {})
      .map(value => Number(value))
      .filter(value => Number.isFinite(value));
    const scaleSummary = scales.length
      ? `scale ${Math.min(...scales).toFixed(3)}~${Math.max(...scales).toFixed(3)}`
      : 'scale pending';
    console.log(`volatility target ${volatilityTarget.toFixed(2)}%/${Number(l.config?.volatilityLookbackDays) || 14}d | ${scaleSummary} | blocked ${l.volatilityBlocked ?? 0}`);
  }
  if (l.config?.entryExecution === 'next_open' || l.pendingEntries?.length) {
    console.log(`entry execution ${l.config?.entryExecution || 'next_open'} | pending ${l.pendingEntries?.length ?? 0} | blocked ${l.pendingEntryBlocked ?? 0} | dataQualityBlocked ${l.pendingEntryDataQualityBlocked ?? 0} | gapBlocked ${l.pendingEntryGapBlocked ?? 0} | quoteBlocked ${l.pendingEntryQuoteBlocked ?? 0}`);
    if (Number(l.config?.maxEntryGapPercent) > 0) {
      console.log(`entry gap ceiling ${Number(l.config.maxEntryGapPercent).toFixed(2)}%`);
    }
  }
  if (Number(l.config?.maxSpreadPercent) > 0) {
    const quote = l.quoteQuality || {};
    console.log(`quote spread ceiling ${Number(l.config.maxSpreadPercent).toFixed(2)}% | ${quote.valid === true ? 'ok' : `blocked ${quote.reason || 'quote_check_failed'}`} | blocked markets ${(quote.blockedMarkets || []).length} | entries blocked ${Number(l.spreadBlocked) || 0}`);
    const modeledDrag = Number.isFinite(Number(quoteExecution.averageEstimatedCrossingDragPercent))
      ? `${Number(quoteExecution.averageEstimatedCrossingDragPercent).toFixed(3)}%`
      : 'unavailable';
    console.log(`quote boundary evidence ${quoteExecution.availableCount}/${quoteExecution.closedTradeCount} | modeled crossing drag ${modeledDrag} | actual fills not observed`);
  }
  if (Number(l.fetchErrors) > 0 || Number(l.networkFetchFailureStreak) > 0 || Number(l.networkFetchCircuitBreaks) > 0) {
    const lastError = l.lastNetworkFetchError?.code || 'none';
    const lastErrorMarket = l.lastNetworkFetchError?.market || 'unknown-market';
    console.log(`network fetch errors ${Number(l.fetchErrors) || 0} | streak ${Number(l.networkFetchFailureStreak) || 0}/${Number(l.networkFetchMaxConsecutiveFailures) || 3} | circuit ${l.networkFetchCircuitOpen === true ? 'open' : 'closed'} | breaks ${Number(l.networkFetchCircuitBreaks) || 0} | last ${lastErrorMarket}:${lastError}`);
  }
  if (l.dataQuality && l.dataQuality.valid === false) {
    console.log(`data quality BLOCKED: ${l.dataQuality.reason} | missing ${(l.dataQuality.missingMarkets || []).join(',') || 'none'} | stale ${(l.dataQuality.staleMarkets || []).join(',') || 'none'} | unaligned ${(l.dataQuality.unalignedMarkets || []).join(',') || 'none'} | maxAge ${l.dataQuality.maxAgeHours ?? 'off'}h | blocked ${l.dataQualityBlocked ?? 0}`);
  } else if (l.dataQuality && Number(l.dataQuality.maxAgeHours) > 0) {
    const ages = Object.values(l.dataQuality.latestAgeSecondsByMarket || {})
      .map(value => Number(value))
      .filter(value => Number.isFinite(value));
    const latestAge = ages.length ? Math.max(...ages) : null;
    console.log(`daily freshness maxAge ${Number(l.dataQuality.maxAgeHours).toFixed(1)}h | latest age ${latestAge === null ? 'unknown' : `${Math.round(latestAge / 60)}m`}`);
  }
  const qualityObservationCycles = Number(l.dataQualityObservationCycles) || 0;
  const qualityInvalidCycles = Number(l.dataQualityInvalidCycles) || 0;
  const qualityBlockedChecks = Number(l.dataQualityBlocked) || 0;
  if (qualityObservationCycles > 0 || qualityInvalidCycles > 0 || qualityBlockedChecks > 0) {
    console.log(`daily quality history valid ${Number(l.dataQualityValidCycles) || 0}/${qualityObservationCycles || 'unknown'} cycles | invalid ${qualityInvalidCycles} | market checks blocked ${qualityBlockedChecks}`);
  }
  console.log(`breadth ${l.breadth ?? '-'} | gateBlocked ${l.gateBlocked ?? 0} | breadthBlocked ${l.breadthBlocked ?? 0} | blockedSignal ${l.blockedSignalCount ?? 0} | duplicateSignalBlocked ${l.duplicateSignalBlocked ?? 0}`);
}
