import fs from 'node:fs';
import { getMomentumShadowEquity } from '../research/momentumShadowLedger.js';

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
  const realized = (l.trades || []).reduce((a, t) => a + (t.profitPercent || 0) / 100 * (t.entry?.size || 0), 0);
  const equity = getMomentumShadowEquity(l, Number(process.env.MOMO_SHADOW_INITIAL_BALANCE) || 100_000_000);
  console.log(`\n=== ${dir} (mode=${l.config?.mode || 'fixed'}) [${state}] ===`);
  const markedReturn = Number.isFinite(equity.markedReturnPercent)
    ? `${equity.markedReturnPercent >= 0 ? '+' : ''}${equity.markedReturnPercent.toFixed(2)}%`
    : '—';
  console.log(`heartbeat ${l.heartbeatAt} (age ${heartbeatAgeMs === null ? 'unknown' : `${Math.round(heartbeatAgeMs / 1000)}s`}) | owner ${l.ownerPid ?? '-'} | cycles ${l.cycles} | cash ${Math.round(l.balance).toLocaleString()} KRW | marked equity ${Math.round(equity.markedEquity).toLocaleString()} KRW | return ${markedReturn} | unrealized ${Math.round(equity.unrealizedProfit).toLocaleString()} KRW`);
  if (l.runnerState === 'running' && nextPollAtMs !== null) {
    console.log(`next poll ${new Date(nextPollAtMs).toISOString()} (in ${nextPollDueInSeconds}s)`);
  }
  console.log(`open: ${open.map(([m, p]) => `${m.replace('KRW-', '')}@${p.entryPrice}${p.markPrice !== undefined ? `→${p.markPrice} ${Number(p.markProfitPercent || 0) >= 0 ? '+' : ''}${Number(p.markProfitPercent || 0).toFixed(2)}%` : ''}`).join(' ') || 'none'}`);
  console.log(`closed trades: ${(l.trades || []).length} | realized ${Math.round(realized).toLocaleString()} KRW`);
  if (l.voidedEntries?.length) console.log(`voided entries: ${l.voidedEntries.length}`);
  if (l.configDrift) console.log(`config drift recorded at ${l.configDrift.changedAt}`);
  if (l.config?.benchmarkMarket) {
    console.log(`benchmark ${l.config.benchmarkMarket.replace(/^KRW-/, '')} trend ${l.benchmarkTrendPercent === null || l.benchmarkTrendPercent === undefined ? 'unknown' : `${Number(l.benchmarkTrendPercent).toFixed(2)}%`} | gate ${l.benchmarkGateOpen === true ? 'open' : 'closed'} | blocked ${l.benchmarkBlocked ?? 0}`);
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
    console.log(`entry execution ${l.config?.entryExecution || 'next_open'} | pending ${l.pendingEntries?.length ?? 0} | blocked ${l.pendingEntryBlocked ?? 0} | dataQualityBlocked ${l.pendingEntryDataQualityBlocked ?? 0} | gapBlocked ${l.pendingEntryGapBlocked ?? 0}`);
    if (Number(l.config?.maxEntryGapPercent) > 0) {
      console.log(`entry gap ceiling ${Number(l.config.maxEntryGapPercent).toFixed(2)}%`);
    }
  }
  if (Number(l.config?.maxSpreadPercent) > 0) {
    const quote = l.quoteQuality || {};
    console.log(`quote spread ceiling ${Number(l.config.maxSpreadPercent).toFixed(2)}% | ${quote.valid === true ? 'ok' : `blocked ${quote.reason || 'quote_check_failed'}`} | blocked markets ${(quote.blockedMarkets || []).length} | entries blocked ${Number(l.spreadBlocked) || 0}`);
  }
  if (Number(l.fetchErrors) > 0 || Number(l.networkFetchFailureStreak) > 0 || Number(l.networkFetchCircuitBreaks) > 0) {
    const lastError = l.lastNetworkFetchError?.code || 'none';
    console.log(`network fetch errors ${Number(l.fetchErrors) || 0} | streak ${Number(l.networkFetchFailureStreak) || 0}/${Number(l.networkFetchMaxConsecutiveFailures) || 3} | circuit ${l.networkFetchCircuitOpen === true ? 'open' : 'closed'} | breaks ${Number(l.networkFetchCircuitBreaks) || 0} | last ${lastError}`);
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
  console.log(`breadth ${l.breadth ?? '-'} | gateBlocked ${l.gateBlocked ?? 0} | breadthBlocked ${l.breadthBlocked ?? 0} | blockedSignal ${l.blockedSignalCount ?? 0} | duplicateSignalBlocked ${l.duplicateSignalBlocked ?? 0}`);
}
