function normalizeKey(value) {
  if (value === null || value === undefined) return null;
  const key = String(value).trim();
  return key && key !== 'undefined' && key !== 'null' ? key : null;
}

function normalizeMarket(value) {
  const market = normalizeKey(value);
  return market;
}

function timestampOf(key) {
  const timestamp = Date.parse(key || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isLaterKey(candidate, current) {
  if (!current) return true;
  const candidateTimestamp = timestampOf(candidate);
  const currentTimestamp = timestampOf(current);
  if (candidateTimestamp !== null && currentTimestamp !== null) {
    return candidateTimestamp > currentTimestamp;
  }
  // A persisted key is authoritative when either key is not date-like. Only
  // fill a missing/invalid slot from legacy history; never replace an opaque
  // key merely because it appeared later in a file.
  return false;
}

/**
 * Ensure the runner has a durable per-market signal idempotency map.
 *
 * The strategy object keeps its lastSignalKey in memory, which is enough for
 * repeated polling in one process but not across a restart. Existing ledgers
 * are migrated from open positions and historical trade entries so the first
 * restart after this guard cannot replay the latest completed-candle entry.
 */
export function ensureMomentumShadowConsumedSignalState(ledger) {
  if (!ledger || typeof ledger !== 'object') return {};
  if (!ledger.consumedSignalKeyByMarket ||
    typeof ledger.consumedSignalKeyByMarket !== 'object' ||
    Array.isArray(ledger.consumedSignalKeyByMarket)) {
    ledger.consumedSignalKeyByMarket = {};
  }

  for (const [market, position] of Object.entries(ledger.positions || {})) {
    const normalizedMarket = normalizeMarket(market);
    const signalKey = normalizeKey(position?.signalKey || position?.entryTs);
    if (!normalizedMarket || !signalKey) continue;
    const current = ledger.consumedSignalKeyByMarket[normalizedMarket];
    if (!current || isLaterKey(signalKey, current)) {
      ledger.consumedSignalKeyByMarket[normalizedMarket] = signalKey;
    }
  }

  for (const trade of Array.isArray(ledger.trades) ? ledger.trades : []) {
    const normalizedMarket = normalizeMarket(trade?.market);
    const signalKey = normalizeKey(
      trade?.signalKey || trade?.entry?.signalKey || trade?.entry?.entryTs || trade?.entryTs
    );
    if (!normalizedMarket || !signalKey) continue;
    const current = ledger.consumedSignalKeyByMarket[normalizedMarket];
    if (!current || isLaterKey(signalKey, current)) {
      ledger.consumedSignalKeyByMarket[normalizedMarket] = signalKey;
    }
  }

  return ledger.consumedSignalKeyByMarket;
}

export function isMomentumShadowSignalConsumed(ledger, market, signalKey) {
  const normalizedMarket = normalizeMarket(market);
  const normalizedKey = normalizeKey(signalKey);
  if (!normalizedMarket || !normalizedKey) return false;
  return ledger?.consumedSignalKeyByMarket?.[normalizedMarket] === normalizedKey;
}

export function recordMomentumShadowSignal(ledger, market, signalKey) {
  const normalizedMarket = normalizeMarket(market);
  const normalizedKey = normalizeKey(signalKey);
  if (!ledger || typeof ledger !== 'object' || !normalizedMarket || !normalizedKey) {
    return false;
  }
  ensureMomentumShadowConsumedSignalState(ledger);
  ledger.consumedSignalKeyByMarket[normalizedMarket] = normalizedKey;
  return true;
}
