const finiteNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Mark one daily momentum-shadow position to the latest completed candle.
 * The mark includes the configured round-trip cost so an open position is
 * never presented as flat when liquidating it would already be negative.
 */
export function markMomentumShadowPosition(position, markPrice, markTimestamp, costPercent = 0) {
  const entryPrice = finiteNumber(position?.entryPrice);
  const size = finiteNumber(position?.size);
  const price = finiteNumber(markPrice);
  if (entryPrice === null || entryPrice <= 0 || size === null || size <= 0 || price === null || price <= 0) {
    return null;
  }

  const grossProfitPercent = ((price - entryPrice) / entryPrice) * 100;
  const netProfitPercent = grossProfitPercent - (finiteNumber(costPercent) || 0);
  const markValue = size * (1 + netProfitPercent / 100);
  const previousMfe = finiteNumber(position.maxFavorableExcursionPercent);
  const previousMae = finiteNumber(position.maxAdverseExcursionPercent);

  return {
    ...position,
    markPrice: price,
    markTimestamp: markTimestamp ? new Date(markTimestamp).toISOString() : null,
    markGrossProfitPercent: grossProfitPercent,
    markProfitPercent: netProfitPercent,
    markValue,
    unrealizedProfit: markValue - size,
    maxFavorableExcursionPercent: Math.max(previousMfe ?? -Infinity, netProfitPercent),
    maxAdverseExcursionPercent: Math.min(previousMae ?? Infinity, netProfitPercent)
  };
}

/**
 * Mark every open position for which a later completed candle is available.
 * Missing market data is left untouched rather than imputed.
 */
export function markMomentumShadowPositions(ledger, seriesByMarket, costPercent = 0) {
  if (!ledger || !ledger.positions || !seriesByMarket) return 0;
  let markedCount = 0;
  for (const [market, position] of Object.entries(ledger.positions)) {
    const bars = seriesByMarket[market];
    const latest = Array.isArray(bars) && bars.length > 0 ? bars[bars.length - 1] : null;
    const marked = markMomentumShadowPosition(
      position,
      latest?.trade_price,
      latest?.ts,
      costPercent
    );
    if (!marked) continue;
    ledger.positions[market] = marked;
    markedCount += 1;
  }
  return markedCount;
}

/**
 * Return cash + marked open positions using the ledger's original balance as
 * the denominator. `initialBalance` is intentionally caller-supplied or
 * persisted by the runner; this function never reconstructs it from a
 * potentially partial or drifted ledger.
 */
export function getMomentumShadowEquity(ledger, fallbackInitialBalance = 100_000_000) {
  const balance = finiteNumber(ledger?.balance) || 0;
  const positions = Object.values(ledger?.positions || {});
  const investedOpen = positions.reduce((sum, position) => sum + (finiteNumber(position?.size) || 0), 0);
  const markedOpenValue = positions.reduce((sum, position) => {
    const markedValue = finiteNumber(position?.markValue);
    return sum + (markedValue !== null ? markedValue : (finiteNumber(position?.size) || 0));
  }, 0);
  const initialBalance = (finiteNumber(ledger?.initialBalance) || finiteNumber(fallbackInitialBalance) || 0);
  const markedEquity = balance + markedOpenValue;
  const unrealizedProfit = markedOpenValue - investedOpen;
  const markedReturnPercent = initialBalance > 0
    ? ((markedEquity / initialBalance) - 1) * 100
    : null;

  return {
    balance,
    investedOpen,
    markedOpenValue,
    unrealizedProfit,
    markedEquity,
    initialBalance,
    markedReturnPercent,
    openPositionCount: positions.length
  };
}

export function ensureMomentumShadowInitialBalance(ledger, fallbackInitialBalance = 100_000_000) {
  if (!ledger || typeof ledger !== 'object') return null;
  const current = finiteNumber(ledger.initialBalance);
  if (current !== null && current > 0) return current;
  const fallback = finiteNumber(fallbackInitialBalance);
  if (fallback === null || fallback <= 0) return null;
  ledger.initialBalance = fallback;
  return fallback;
}

/**
 * Persist the latest equity summary fields on a ledger after marking. The
 * fields are descriptive only and never participate in entry/exit decisions.
 */
export function updateMomentumShadowEquity(ledger, fallbackInitialBalance = 100_000_000, markedAt = null) {
  const equity = getMomentumShadowEquity(ledger, fallbackInitialBalance);
  if (ledger && typeof ledger === 'object') {
    ledger.initialBalance = equity.initialBalance || ledger.initialBalance;
    ledger.markedAt = markedAt ? new Date(markedAt).toISOString() : ledger.markedAt || null;
    ledger.markedEquity = equity.markedEquity;
    ledger.markedOpenValue = equity.markedOpenValue;
    ledger.investedOpen = equity.investedOpen;
    ledger.unrealizedProfit = equity.unrealizedProfit;
    ledger.markedReturnPercent = equity.markedReturnPercent;
  }
  return equity;
}
