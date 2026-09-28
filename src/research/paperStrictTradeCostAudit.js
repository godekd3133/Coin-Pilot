function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Add a separate configured-slippage sensitivity to strict paper closes.
 * This does not rewrite the ledger or represent observed exchange fills.
 */
export function summarizePaperStrictTradeCostAudit(ledger) {
  const strictTrades = Array.isArray(ledger?.strictTrades) ? ledger.strictTrades : [];
  const closedTrades = strictTrades.filter(trade =>
    trade?.action === 'CLOSE' || trade?.action === 'PARTIAL_CLOSE' || trade?.type === 'CLOSE'
  );
  const slippageRate = finiteNumber(ledger?.configSnapshot?.slippage);
  const base = {
    schema: 'coinpilot.paper-strict-trade-cost-audit.v1',
    researchOnly: true,
    promoted: false,
    actualFillsObserved: false,
    slippageAppliedToStrictPaperLedger: null,
    quoteCrossingCostAvailable: false,
    closedTradeCount: closedTrades.length,
    costMethod: 'per_trade_model_marker_else_fixed_quantity_both_sides_notional_stress'
  };

  if (ledger?.configSnapshotComplete !== true || slippageRate === null || slippageRate < 0) {
    return {
      ...base,
      available: false,
      reason: 'complete_slippage_config_required',
      evaluatedTradeCount: 0,
      unevaluableTradeCount: closedTrades.length,
      configuredSlippagePercent: null,
      recordedNetPnlKrw: null,
      twoSidedNotionalKrw: null,
      breakEvenAdditionalSlippagePerSidePercent: null,
      modeledSlippageDragKrw: null,
      costStressedNetPnlKrw: null,
      trades: [],
      note: '설정 기록이 완전하지 않아 비용 민감도를 계산하지 않았습니다.',
      breakEvenSlippageNote: '설정 기록이 완전하지 않아 손익분기 미끄러짐 한도를 계산하지 않았습니다.'
    };
  }

  const trades = closedTrades.map(trade => {
    const entryPrice = finiteNumber(trade.entryPrice);
    const exitPrice = finiteNumber(trade.exitPrice);
    const amount = finiteNumber(trade.amount);
    const recordedProfit = finiteNumber(trade.profit);
    const executionCostModelApplied = trade.paperExecutionCostModel === 'strict_paper_cost_model_v1';
    const recordedSlippageRate = finiteNumber(trade.paperExecutionSlippageRate);
    const recordedTradingFeeRate = finiteNumber(trade.paperExecutionTradingFeeRate);
    const slippageAlreadyApplied = executionCostModelApplied &&
      recordedSlippageRate !== null && recordedTradingFeeRate !== null &&
      recordedSlippageRate >= 0 && recordedTradingFeeRate >= 0;
    const tradeSlippageRate = slippageAlreadyApplied
      ? recordedSlippageRate
      : slippageRate;
    if (executionCostModelApplied && !slippageAlreadyApplied) return null;
    if ([entryPrice, exitPrice, amount, recordedProfit].some(value => value === null) ||
      entryPrice <= 0 || exitPrice <= 0 || amount <= 0 || tradeSlippageRate === null || tradeSlippageRate < 0) {
      return null;
    }

    const entryNotional = entryPrice * amount;
    const exitNotional = exitPrice * amount;
    const modeledSlippageDrag = slippageAlreadyApplied
      ? 0
      : (entryNotional + exitNotional) * tradeSlippageRate;
    return {
      coin: trade.coin || null,
      exitTime: trade.exitTime || null,
      observedEntryPrice: finiteNumber(trade.paperObservedEntryPrice),
      observedExitPrice: finiteNumber(trade.paperObservedExitPrice),
      paperExecutionCostModel: trade.paperExecutionCostModel || null,
      slippageAlreadyApplied,
      slippageRate: tradeSlippageRate,
      tradingFeeRate: slippageAlreadyApplied ? recordedTradingFeeRate : null,
      recordedNetPnlKrw: recordedProfit,
      twoSidedNotionalKrw: entryNotional + exitNotional,
      modeledSlippageDragKrw: modeledSlippageDrag,
      costStressedNetPnlKrw: recordedProfit - modeledSlippageDrag
    };
  });
  const validTrades = trades.filter(Boolean);
  const recordedNetPnlKrw = validTrades.length > 0
    ? validTrades.reduce((sum, trade) => sum + trade.recordedNetPnlKrw, 0)
    : null;
  const twoSidedNotionalKrw = validTrades.length > 0
    ? validTrades.reduce((sum, trade) => sum + trade.twoSidedNotionalKrw, 0)
    : null;
  const breakEvenAdditionalSlippagePerSidePercent = recordedNetPnlKrw > 0 && twoSidedNotionalKrw > 0
    ? (recordedNetPnlKrw / twoSidedNotionalKrw) * 100
    : null;
  const modeledSlippageDragKrw = validTrades.length > 0
    ? validTrades.reduce((sum, trade) => sum + trade.modeledSlippageDragKrw, 0)
    : null;
  const costStressedNetPnlKrw = validTrades.length > 0
    ? validTrades.reduce((sum, trade) => sum + trade.costStressedNetPnlKrw, 0)
    : null;
  const modeledExecutionTradeCount = validTrades.filter(trade => trade.slippageAlreadyApplied).length;
  const unmodeledExecutionTradeCount = validTrades.length - modeledExecutionTradeCount;

  return {
    ...base,
    available: true,
    reason: validTrades.length === 0
      ? closedTrades.length === 0 ? 'no_closed_trades' : 'no_evaluable_trades'
      : null,
    evaluatedTradeCount: validTrades.length,
    unevaluableTradeCount: closedTrades.length - validTrades.length,
    modeledExecutionTradeCount,
    unmodeledExecutionTradeCount,
    slippageAppliedToStrictPaperLedger: validTrades.length === 0
      ? null
      : unmodeledExecutionTradeCount === 0,
    configuredSlippagePercent: slippageRate * 100,
    recordedNetPnlKrw,
    twoSidedNotionalKrw,
    breakEvenAdditionalSlippagePerSidePercent,
    modeledSlippageDragKrw,
    costStressedNetPnlKrw,
    costStressedProfitableTradeCount: validTrades.length > 0
      ? validTrades.filter(trade => trade.costStressedNetPnlKrw > 0).length
      : null,
    trades: validTrades,
    note: unmodeledExecutionTradeCount > 0
      ? '설정 미끄러짐이 반영되지 않은 기록은 기록 수량을 고정하고 진입·청산 양쪽에 불리한 미끄러짐을 추가 차감한 단순 민감도입니다. 실제 체결이나 시간대별 호가 교차 비용이 아닙니다.'
      : validTrades.length > 0
        ? '설정 미끄러짐은 paper 기록 손익에 반영되어 있습니다. 실제 체결이나 시간대별 호가 교차 비용은 확인되지 않았습니다.'
        : '검증 가능한 청산 표본이 없습니다.',
    breakEvenSlippageNote: breakEvenAdditionalSlippagePerSidePercent === null
      ? '기록 순손익이 양수가 아니거나 계산 가능한 양방향 거래대금이 없어 손익분기 미끄러짐 한도를 계산하지 않았습니다.'
      : '양방향 거래대금에 같은 비율의 불리한 미끄러짐을 적용해 기록 순손익을 0까지 소진하는 민감도 임계값입니다. 실제 체결 비용이 아닙니다.'
  };
}
