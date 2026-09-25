const finiteNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;

function timestampOf(value) {
  if (value instanceof Date) {
    const epoch = value.getTime();
    return Number.isFinite(epoch) ? epoch : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '');
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

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
  // Candle timestamps are naive UTC; parse them through the same Z-suffix
  // convention as the rest of the ledger instead of the host-local timezone.
  const markTimestampMs = markTimestamp ? timestampOf(markTimestamp) : null;
  const netProfitPercent = grossProfitPercent - (finiteNumber(costPercent) || 0);
  const markValue = size * (1 + netProfitPercent / 100);
  const previousMfe = finiteNumber(position.maxFavorableExcursionPercent);
  const previousMae = finiteNumber(position.maxAdverseExcursionPercent);

  return {
    ...position,
    markPrice: price,
    markTimestamp: markTimestampMs === null ? null : new Date(markTimestampMs).toISOString(),
    markGrossProfitPercent: grossProfitPercent,
    markProfitPercent: netProfitPercent,
    markValue,
    unrealizedProfit: markValue - size,
    maxFavorableExcursionPercent: Math.max(previousMfe ?? -Infinity, netProfitPercent),
    maxAdverseExcursionPercent: Math.min(previousMae ?? Infinity, netProfitPercent)
  };
}

/**
 * Report whether a completed bar covers a position's entry timestamp. A
 * next-open forward fill can be observed before its candle closes, so a bar
 * that predates the entry must not be used as a mark or exit reference. An
 * unparseable timestamp cannot prove pre-entry, so it keeps the legacy
 * evaluation instead of silently freezing the position's checks.
 */
export function isMomentumShadowPositionCoveredByBar(position, bar) {
  const barTimestamp = timestampOf(bar?.ts ?? bar?.timestamp);
  const entryTimestamp = timestampOf(position?.entryTs ?? position?.entryTimestamp);
  return barTimestamp === null || entryTimestamp === null || barTimestamp >= entryTimestamp;
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
    if (!isMomentumShadowPositionCoveredByBar(position, latest)) {
      // A next-open forward fill can be observed before its candle closes. The
      // last completed candle predates the fill and must not be used as a
      // fabricated mark or exit reference.
      continue;
    }
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

function updateObservedMomentumShadowDrawdown(ledger, equity, markedAt) {
  if (!ledger || typeof ledger !== 'object') return;
  const markedEquity = finiteNumber(equity?.markedEquity);
  if (markedEquity === null || markedEquity < 0) return;

  const markMs = timestampOf(markedAt);
  const markedAtIso = markMs === null ? new Date().toISOString() : new Date(markMs).toISOString();
  const hasTelemetry = Number.isFinite(Number(ledger.observedMddSampleCount)) &&
    ledger.observedMddSampleCount !== null &&
    Number.isFinite(Number(ledger.observedMddPeakEquity)) &&
    ledger.observedMddPeakEquity !== null &&
    Number.isFinite(Number(ledger.observedMddMaxDrawdownPercent)) &&
    ledger.observedMddMaxDrawdownPercent !== null &&
    typeof ledger.observedMddFullSessionCoverage === 'boolean';
  const cycleCount = Math.max(0, Math.floor(Number(ledger.cycles) || 0));
  const startedAtMs = timestampOf(ledger.startedAt);
  const startsAtSessionBoundary = !hasTelemetry && cycleCount <= 1 && startedAtMs !== null;
  const initialBalance = finiteNumber(equity.initialBalance) || 0;

  if (!hasTelemetry) {
    const startingObservedPeak = startsAtSessionBoundary
      ? Math.max(initialBalance, markedEquity)
      : markedEquity;
    ledger.observedMddStartedAt = startsAtSessionBoundary
      ? new Date(startedAtMs).toISOString()
      : markedAtIso;
    ledger.observedMddPeakEquity = startingObservedPeak;
    ledger.observedMddSampleCount = 0;
    ledger.observedMddCurrentDrawdownPercent = 0;
    ledger.observedMddMaxDrawdownPercent = 0;
    ledger.observedMddMaxDrawdownAt = null;
    ledger.observedMddMaxDrawdownPeakEquity = startingObservedPeak;
    ledger.observedMddMaxDrawdownTroughEquity = startingObservedPeak;
    ledger.observedMddFullSessionCoverage = startsAtSessionBoundary;
    ledger.observedMddCoverageReasons = startsAtSessionBoundary
      ? []
      : ['telemetry_started_after_session_start'];
  }

  const coverageReasons = new Set(Array.isArray(ledger.observedMddCoverageReasons)
    ? ledger.observedMddCoverageReasons
    : []);
  if (ledger.configDrift) coverageReasons.add('config_drift');
  if (Array.isArray(ledger.interruptions) && ledger.interruptions.length > 0) {
    coverageReasons.add('continuity_interruption');
  }
  if (!ledger.dataQuality) coverageReasons.add('daily_data_quality_unverified');
  else if (ledger.dataQuality.valid !== true) coverageReasons.add('daily_data_quality_invalid');
  if (Number(ledger.dataQualityInvalidCycles) > 0) {
    coverageReasons.add('daily_data_quality_gap_history');
  }
  if (ledger.networkFetchCircuitOpen === true || Number(ledger.networkFetchCircuitBreaks) > 0) {
    coverageReasons.add('network_fetch_circuit_break');
  }
  if (Array.isArray(ledger.runnerEvents) &&
    ledger.runnerEvents.filter(event => event?.type === 'started').length > 1) {
    coverageReasons.add('runner_restarted');
  }

  const previousObservedPeak = Number(ledger.observedMddPeakEquity);
  const previousPeak = Math.max(
    Number.isFinite(previousObservedPeak) && previousObservedPeak > 0
      ? previousObservedPeak
      : markedEquity,
    markedEquity
  );
  const currentDrawdownPercent = previousPeak > 0
    ? Math.max(0, ((previousPeak - markedEquity) / previousPeak) * 100)
    : null;
  const previousMaximum = Math.max(0, Number(ledger.observedMddMaxDrawdownPercent) || 0);
  ledger.observedMddPeakEquity = previousPeak;
  ledger.observedMddCurrentDrawdownPercent = currentDrawdownPercent;
  ledger.observedMddSampleCount = Math.max(0, Number(ledger.observedMddSampleCount) || 0) + 1;
  ledger.observedMddLastAt = markedAtIso;
  ledger.observedMddSamplingIntervalMs = Math.max(0, Number(ledger.config?.pollMs) || 0) || null;
  ledger.observedMddCoverageReasons = [...coverageReasons];
  ledger.observedMddFullSessionCoverage = ledger.observedMddFullSessionCoverage === true &&
    coverageReasons.size === 0;

  if (currentDrawdownPercent !== null && currentDrawdownPercent > previousMaximum + 1e-12) {
    ledger.observedMddMaxDrawdownPercent = currentDrawdownPercent;
    ledger.observedMddMaxDrawdownAt = markedAtIso;
    ledger.observedMddMaxDrawdownPeakEquity = previousPeak;
    ledger.observedMddMaxDrawdownTroughEquity = markedEquity;
  }
}

/**
 * Persist the latest equity summary fields on a ledger after marking. The
 * fields are descriptive only and never participate in entry/exit decisions.
 */
export function updateMomentumShadowEquity(ledger, fallbackInitialBalance = 100_000_000, markedAt = null) {
  const equity = getMomentumShadowEquity(ledger, fallbackInitialBalance);
  if (ledger && typeof ledger === 'object') {
    const markedAtMs = timestampOf(markedAt);
    ledger.initialBalance = equity.initialBalance || ledger.initialBalance;
    ledger.markedAt = markedAtMs !== null ? new Date(markedAtMs).toISOString() : ledger.markedAt || null;
    ledger.markedEquity = equity.markedEquity;
    ledger.markedOpenValue = equity.markedOpenValue;
    ledger.investedOpen = equity.investedOpen;
    ledger.unrealizedProfit = equity.unrealizedProfit;
    ledger.markedReturnPercent = equity.markedReturnPercent;
    updateObservedMomentumShadowDrawdown(ledger, equity, markedAt);
  }
  return equity;
}
