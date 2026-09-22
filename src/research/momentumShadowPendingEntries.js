import { resolveMomentumShadowNextOpenFill } from './momentumShadowEntryExecution.js';

function timestampMs(value) {
  const text = String(value ?? '');
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function recordVoidedPendingEntry(ledger, pending, reason, at) {
  if (!Array.isArray(ledger.voidedEntries)) ledger.voidedEntries = [];
  ledger.voidedEntries.push({
    market: pending.market,
    signalKey: pending.signalKey || pending.signalTimestamp || null,
    signalTimestamp: pending.signalTimestamp || null,
    size: pending.size,
    reason,
    voidedAt: at
  });
}

/**
 * Execute persisted next-open entries against one authoritative candle grid.
 * This function owns only scoped ledger mutation; it never fetches data and
 * never authorizes a live order. Missing/incomplete data leaves a pending
 * entry pending, while a terminal missing next candle voids it fail-closed.
 */
export function executeMomentumShadowPendingEntries({
  ledger,
  series,
  currentOpenByMarket = {},
  dataQuality,
  maxPositions,
  maxEntryGapPercent = 0,
  now = Date.now(),
  entryExecution = 'next_open',
  notify = null,
  bookName = ''
} = {}) {
  if (entryExecution !== 'next_open' || !ledger ||
    !Array.isArray(ledger.pendingEntries) || ledger.pendingEntries.length === 0) {
    return { filled: 0, blocked: 0, pending: ledger?.pendingEntries?.length || 0 };
  }
  // A triggered portfolio drawdown stop permanently halts new positions, so
  // queued entries are voided as terminal rather than left to fill later.
  if (ledger.drawdownStopTriggered === true) {
    const at = new Date(now).toISOString();
    let blocked = 0;
    for (const pending of ledger.pendingEntries) {
      recordVoidedPendingEntry(ledger, pending, 'pending_entry_drawdown_stop', at);
      blocked += 1;
    }
    ledger.pendingEntries = [];
    ledger.pendingEntryBlocked = (ledger.pendingEntryBlocked || 0) + blocked;
    return { filled: 0, blocked, pending: 0 };
  }
  if (dataQuality?.valid !== true) {
    ledger.pendingEntryDataQualityBlocked = (ledger.pendingEntryDataQualityBlocked || 0) +
      ledger.pendingEntries.length;
    return { filled: 0, blocked: 0, pending: ledger.pendingEntries.length };
  }

  const remaining = [];
  let filled = 0;
  let blocked = 0;
  const gapCeiling = Math.max(0, Number(maxEntryGapPercent) || 0);
  for (const pending of ledger.pendingEntries) {
    const fill = resolveMomentumShadowNextOpenFill({
      bars: series?.[pending.market],
      signalKey: pending.signalKey || pending.signalTimestamp,
      currentOpen: currentOpenByMarket[pending.market]
    });
    if (!fill.available) {
      if (fill.terminal) {
        recordVoidedPendingEntry(ledger, pending, fill.reason, new Date(now).toISOString());
        blocked += 1;
      } else {
        remaining.push(pending);
      }
      continue;
    }

    const size = Number(pending.size);
    if (ledger.positions[pending.market]) {
      recordVoidedPendingEntry(ledger, pending, 'pending_entry_position_conflict', new Date(now).toISOString());
      blocked += 1;
      continue;
    }
    if (Object.keys(ledger.positions).length >= Number(maxPositions)) {
      recordVoidedPendingEntry(ledger, pending, 'pending_entry_position_limit', new Date(now).toISOString());
      blocked += 1;
      continue;
    }
    if (!Number.isFinite(size) || size < 5000 || size > ledger.balance) {
      recordVoidedPendingEntry(ledger, pending, 'pending_entry_cash_unavailable', new Date(now).toISOString());
      blocked += 1;
      continue;
    }

    const signalClosePrice = Number(pending.signalClosePrice);
    const entryGapPercent = Number.isFinite(signalClosePrice) && signalClosePrice > 0
      ? ((fill.entryPrice - signalClosePrice) / signalClosePrice) * 100
      : null;
    if (gapCeiling > 0 && (entryGapPercent === null || entryGapPercent > gapCeiling)) {
      recordVoidedPendingEntry(
        ledger,
        pending,
        entryGapPercent === null ? 'pending_entry_gap_unknown' : 'pending_entry_gap_above_limit',
        new Date(now).toISOString()
      );
      ledger.pendingEntryGapBlocked = (ledger.pendingEntryGapBlocked || 0) + 1;
      blocked += 1;
      continue;
    }

    ledger.balance -= size;
    ledger.positions[pending.market] = {
      entryPrice: fill.entryPrice,
      entryTs: fill.entryTimestamp,
      entryTimeMs: timestampMs(fill.entryTimestamp) ?? now,
      signalKey: pending.signalKey || pending.signalTimestamp,
      signalTimestamp: pending.signalTimestamp || pending.signalKey || null,
      size,
      volatilityPercent: pending.volatilityPercent ?? null,
      volatilityScale: pending.volatilityScale,
      selectionRank: pending.selectionRank,
      trendPercent: pending.trendPercent,
      breadth: pending.breadth,
      entryGapPercent,
      entryExecution
    };
    ledger.entries = (ledger.entries || 0) + 1;
    filled += 1;
    notify?.send?.(`momentum open ${pending.market.replace('KRW-', '')}`,
      `next_open fill ${fill.entryPrice} · 7d trend +${Number(pending.trendPercent || 0).toFixed(1)}% · ` +
      `size ${Math.round(size).toLocaleString()} · ${bookName}`,
      ['chart_with_upwards_trend']);
  }

  ledger.pendingEntries = remaining;
  ledger.pendingEntryBlocked = (ledger.pendingEntryBlocked || 0) + blocked;
  return { filled, blocked, pending: remaining.length };
}
