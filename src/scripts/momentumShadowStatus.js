import fs from 'node:fs';
import { getMomentumShadowEquity } from '../research/momentumShadowLedger.js';

/**
 * Read-only status printer for the momentum shadow books.
 * Usage: node src/scripts/momentumShadowStatus.js [dir ...]
 * Defaults to both known books. Never mutates ledgers.
 *
 * Mirrors the forward-paper orphan convention: a book whose recorded owner
 * PID is dead, or whose heartbeat is older than five poll intervals, is
 * reported as STOPPED rather than as a healthy live session.
 */
const dirs = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['.paper-momentum-shadow-v1', '.paper-momentum-shadow-regime', '.paper-momentum-shadow-btc-gate-v1'];
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
  const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? Date.now() - heartbeatMs : null;
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
    : heartbeatAgeMs !== null && heartbeatAgeMs > heartbeatLimitMs
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
  console.log(`breadth ${l.breadth ?? '-'} | gateBlocked ${l.gateBlocked ?? 0} | breadthBlocked ${l.breadthBlocked ?? 0}`);
}
