const DEFAULT_STOP_LOSS_PERCENT = 4;

function finiteOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Compare observed paper returns with a simple completed-close loss cap.
 * This is deliberately a counterfactual readout: it does not rewrite a
 * ledger, create a fill, or claim intraday stop execution.
 */
export function summarizeMomentumShadowLossCapCounterfactual(
  ledger,
  stopLossPercent = DEFAULT_STOP_LOSS_PERCENT
) {
  const cap = Number.isFinite(Number(stopLossPercent)) && Number(stopLossPercent) > 0
    ? Number(stopLossPercent)
    : DEFAULT_STOP_LOSS_PERCENT;
  const trades = Array.isArray(ledger?.trades) ? ledger.trades : [];
  const observedRows = trades
    .map(trade => ({ trade, profitPercent: finiteOrNull(trade?.profitPercent) }))
    .filter(row => row.profitPercent !== null);
  const observedReturns = observedRows.map(row => row.profitPercent);
  const cappedReturns = observedReturns.map(value => Math.max(value, -cap));
  const cappedTradeCount = observedReturns.filter(value => value < -cap).length;
  const openReturns = Object.values(ledger?.positions || {})
    .map(position => finiteOrNull(position?.markProfitPercent))
    .filter(value => value !== null);
  const openAtOrBelowCapCount = openReturns.filter(value => value <= -cap).length;
  const observedAverageReturnPercent = average(observedReturns);
  const cappedAverageReturnPercent = average(cappedReturns);
  const averageReturnDeltaPercent = observedAverageReturnPercent === null ||
    cappedAverageReturnPercent === null
    ? null
    : cappedAverageReturnPercent - observedAverageReturnPercent;
  const estimatedProfitDelta = observedRows.reduce((sum, row) => {
    const entrySize = finiteOrNull(row.trade?.entry?.size);
    const observed = row.profitPercent;
    if (entrySize === null || observed === undefined || observed >= -cap) return sum;
    return sum + entrySize * ((-cap) - observed) / 100;
  }, 0);
  const hasAllEntrySizes = observedRows.length === trades.length && trades.length > 0 && trades.every(trade =>
    finiteOrNull(trade?.entry?.size) !== null && finiteOrNull(trade?.profitPercent) !== null
  );

  return {
    researchOnly: true,
    promoted: false,
    stopLossPercent: cap,
    closedTradeCount: observedReturns.length,
    cappedTradeCount,
    observedAverageReturnPercent,
    cappedAverageReturnPercent,
    averageReturnDeltaPercent,
    estimatedProfitDelta: hasAllEntrySizes ? estimatedProfitDelta : null,
    estimatedProfitDeltaAvailable: hasAllEntrySizes,
    openPositionCount: openReturns.length,
    openAtOrBelowCapCount,
    note: '완료 일봉 종가 수익률을 단순 cap한 가상 비교이며 실제 stop fill·intraday 체결·wallet settlement가 아닙니다.'
  };
}

export { DEFAULT_STOP_LOSS_PERCENT as DEFAULT_MOMENTUM_SHADOW_LOSS_CAP_PERCENT };
