import { resolveMomentumShadowNextOpenFill } from './momentumShadowEntryExecution.js';
import { compactMomentumShadowQuote } from './momentumShadowQuoteQuality.js';
import { projectMomentumShadowExecutionPrice } from './momentumShadowExecutionModel.js';

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
 * entry pending, while a terminal missing next candle or unverifiable quote
 * at the fill boundary voids it fail-closed.
 */
export function executeMomentumShadowPendingEntries({
  ledger,
  series,
  currentOpenByMarket = {},
  dataQuality,
  maxPositions,
  maxEntryGapPercent = 0,
  maxSpreadPercent = 0,
  quoteQuality = null,
  entryQuotes = {},
  executionModel = 'candle_close',
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

    let entryQuote = null;
    const quoteRequired = Number(maxSpreadPercent) > 0 || executionModel === 'quote_cross';
    if (quoteRequired) {
      const quote = compactMomentumShadowQuote(entryQuotes?.[pending.market]);
      const quoteBlocked = quoteQuality?.error
        ? 'pending_entry_quote_request_failed'
        : quoteQuality?.missingMarkets?.includes(pending.market)
          ? 'pending_entry_quote_market_missing'
          : quoteQuality?.invalidMarkets?.includes(pending.market)
            ? 'pending_entry_quote_invalid'
            : quoteQuality?.blockedMarkets?.includes(pending.market)
              ? 'pending_entry_quote_spread_above_limit'
              : !quote
                ? 'pending_entry_quote_missing_or_invalid'
                : null;
      if (quoteBlocked) {
        recordVoidedPendingEntry(ledger, pending, quoteBlocked, new Date(now).toISOString());
        ledger.pendingEntryQuoteBlocked = (ledger.pendingEntryQuoteBlocked || 0) + 1;
        blocked += 1;
        continue;
      }
      entryQuote = quote;
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

    const execution = projectMomentumShadowExecutionPrice({
      model: executionModel,
      side: 'entry',
      candlePrice: fill.entryPrice,
      quote: entryQuote
    });
    if (!execution.available) {
      recordVoidedPendingEntry(ledger, pending, `pending_entry_${execution.reason}`, new Date(now).toISOString());
      ledger.pendingEntryExecutionBlocked = (ledger.pendingEntryExecutionBlocked || 0) + 1;
      blocked += 1;
      continue;
    }

    ledger.balance -= size;
    ledger.positions[pending.market] = {
      entryPrice: execution.price,
      decisionEntryPrice: fill.entryPrice,
      executionModel: execution.model,
      executionPriceSource: execution.source,
      executionQuoteTimestamp: execution.quoteTimestamp,
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
      // Older pending rows used entryQuote for the signal-cycle quote. Keep
      // it as signalQuote for compatibility, while entryQuote below is the
      // quote observed at the actual next-open fill cycle.
      signalQuote: pending.signalQuote || pending.entryQuote || null,
      entryQuote: entryQuote || (quoteRequired ? null : pending.entryQuote || null),
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
