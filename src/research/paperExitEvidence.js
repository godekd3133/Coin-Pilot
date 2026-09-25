export const PAPER_EXIT_EVIDENCE_SCHEMA = 'coinpilot.paper-exit-evidence.v1';

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  if (value instanceof Date) {
    const result = value.getTime();
    return Number.isFinite(result) ? result : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const text = String(value ?? '').trim();
  if (!text) return null;
  const result = Date.parse(text);
  return Number.isFinite(result) ? result : null;
}

function exitReasonOf(trade) {
  const reason = trade?.reason || trade?.exitReason || trade?.closeReason;
  return reason === null || reason === undefined || String(reason).trim() === ''
    ? 'unknown_exit_reason'
    : String(reason);
}

function holdMinutesOf(trade) {
  const entry = timestamp(trade?.entryTime || trade?.entryTimestamp);
  const exit = timestamp(trade?.exitTime || trade?.exitTimestamp);
  if (entry === null || exit === null || exit < entry) return null;
  return (exit - entry) / 60_000;
}

function average(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function summarizeGroup(reason, rows) {
  const profits = rows.map(row => row.profit);
  const returns = rows.map(row => row.profitPercent).filter(value => value !== null);
  const holds = rows.map(row => row.holdMinutes).filter(value => value !== null);
  const mfes = rows.map(row => row.maxFavorableExcursionPercent).filter(value => value !== null);
  const maes = rows.map(row => row.maxAdverseExcursionPercent).filter(value => value !== null);
  const winningTrades = rows.filter(row => row.profit > 0).length;
  return {
    reason,
    tradeCount: rows.length,
    winningTrades,
    losingTrades: rows.length - winningTrades,
    winRate: rows.length > 0 ? (winningTrades / rows.length) * 100 : null,
    netProfit: profits.reduce((sum, value) => sum + value, 0),
    averageProfit: average(profits),
    averageProfitPercent: average(returns),
    averageHoldMinutes: average(holds),
    minimumHoldMinutes: holds.length > 0 ? Math.min(...holds) : null,
    maximumHoldMinutes: holds.length > 0 ? Math.max(...holds) : null,
    averageMaxFavorableExcursionPercent: average(mfes),
    averageMaxAdverseExcursionPercent: average(maes),
    validReturnCount: returns.length,
    validHoldCount: holds.length,
    validExcursionCount: Math.min(mfes.length, maes.length)
  };
}

/**
 * Count completed paper trades by their originating signal window. Multiple
 * markets entered from one completed-candle window are correlated observations,
 * not independent trade samples. This metric is descriptive only and does not
 * alter the existing promotion/confidence gates.
 */
export function summarizePaperSignalWindowCoverage(trades = []) {
  const rows = Array.isArray(trades) ? trades : [];
  const windows = new Map();
  let signalKeyTradeCount = 0;
  let signalTimeFallbackTradeCount = 0;
  let unlinkedTradeCount = 0;

  for (const trade of rows) {
    const signalKey = String(trade?.signalKey ?? '').trim();
    const signalTime = String(trade?.signalTime ?? '').trim();
    const key = signalKey || signalTime;
    if (!key) {
      unlinkedTradeCount += 1;
      continue;
    }
    if (signalKey) signalKeyTradeCount += 1;
    else signalTimeFallbackTradeCount += 1;
    windows.set(key, (windows.get(key) || 0) + 1);
  }

  const clusteredTradeCount = [...windows.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return {
    tradeCount: rows.length,
    uniqueSignalWindowCount: windows.size,
    linkedTradeCount: signalKeyTradeCount + signalTimeFallbackTradeCount,
    signalKeyTradeCount,
    signalTimeFallbackTradeCount,
    unlinkedTradeCount,
    clusteredTradeCount,
    coverageComplete: unlinkedTradeCount === 0
  };
}

/**
 * Summarize completed paper trades by the exit path that actually closed
 * them. This is an attribution report only: it does not replay prices,
 * infer an earlier exit, or authorize a new stop/take configuration.
 */
export function summarizePaperExitEvidence(trades = [], { profitField = 'profit' } = {}) {
  const rows = Array.isArray(trades) ? trades : [];
  const validRows = [];
  let invalidTradeCount = 0;
  for (const trade of rows) {
    const profit = finiteNumber(trade?.[profitField]);
    if (profit === null) {
      invalidTradeCount += 1;
      continue;
    }
    validRows.push({
      reason: exitReasonOf(trade),
      profit,
      profitPercent: finiteNumber(trade?.profitPercent),
      holdMinutes: holdMinutesOf(trade),
      maxFavorableExcursionPercent: finiteNumber(trade?.maxFavorableExcursionPercent),
      maxAdverseExcursionPercent: finiteNumber(trade?.maxAdverseExcursionPercent)
    });
  }

  const grouped = new Map();
  for (const row of validRows) {
    const group = grouped.get(row.reason) || [];
    group.push(row);
    grouped.set(row.reason, group);
  }
  const byReason = [...grouped.entries()]
    .map(([reason, group]) => summarizeGroup(reason, group))
    .sort((left, right) => right.tradeCount - left.tradeCount || right.netProfit - left.netProfit);

  const overall = summarizeGroup('all', validRows);
  return {
    schema: PAPER_EXIT_EVIDENCE_SCHEMA,
    researchOnly: true,
    promoted: false,
    profitField,
    tradeCount: rows.length,
    validTradeCount: validRows.length,
    invalidTradeCount,
    overall,
    byReason,
    signalWindowCoverage: summarizePaperSignalWindowCoverage(rows),
    note: 'Exit attribution is read-only paper evidence. It does not infer an earlier fill, wallet settlement, realized live P&L, or a profitable replacement exit.'
  };
}
