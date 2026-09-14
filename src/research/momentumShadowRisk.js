function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function recordMomentumShadowExit(
  ledger,
  market,
  profitPercent,
  at = Date.now(),
  cooldownAfterLossDays = 0
) {
  if (!ledger || typeof ledger !== 'object') return null;
  if (!ledger.cooldownUntilByMarket || typeof ledger.cooldownUntilByMarket !== 'object') {
    ledger.cooldownUntilByMarket = {};
  }
  const cooldownDays = Math.max(0, finite(cooldownAfterLossDays, 0));
  const profit = finite(profitPercent, 0);
  if (profit < 0 && cooldownDays > 0) {
    const until = new Date(Number(at) + cooldownDays * 24 * 60 * 60 * 1000).toISOString();
    ledger.cooldownUntilByMarket[market] = until;
    return until;
  }
  delete ledger.cooldownUntilByMarket[market];
  return null;
}

export function isMomentumShadowCooldownActive(ledger, market, at = Date.now()) {
  const until = Date.parse(ledger?.cooldownUntilByMarket?.[market] || '');
  return Number.isFinite(until) && until > Number(at);
}

export function updateMomentumShadowDrawdown(
  ledger,
  markedEquity,
  at,
  maxPortfolioDrawdownPercent = 0,
  fallbackInitialBalance = 100_000_000
) {
  if (!ledger || typeof ledger !== 'object') {
    return { drawdownPercent: 0, triggered: false };
  }
  const equity = finite(markedEquity, 0);
  const initialBalance = Math.max(0, finite(ledger.initialBalance, fallbackInitialBalance));
  const previousPeak = Math.max(initialBalance, finite(ledger.peakEquity, initialBalance));
  const peakEquity = Math.max(previousPeak, equity);
  const drawdownPercent = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
  ledger.peakEquity = peakEquity;
  ledger.drawdownPercent = drawdownPercent;
  const limit = Math.max(0, finite(maxPortfolioDrawdownPercent, 0));
  const hasPositions = Object.keys(ledger.positions || {}).length > 0;
  const triggered = !ledger.drawdownStopTriggered && limit > 0 && hasPositions && drawdownPercent >= limit;
  if (triggered) {
    ledger.drawdownStopTriggered = true;
    ledger.drawdownStopAt = at ? new Date(at).toISOString() : new Date().toISOString();
  }
  return { drawdownPercent, triggered };
}
