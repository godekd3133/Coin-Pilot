export const PAPER_EXIT_PATH_REPLAY_SCHEMA = 'coinpilot.paper-exit-path-replay.v1';
export const DEFAULT_PAPER_EXIT_PATH_TAKE_PROFIT_LEVELS = Object.freeze([0.3, 0.5, 0.8]);

const CANDLE_MS = 60_000;
const COST_MODEL = 'strict_paper_cost_model_v1';

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTimestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  if (!text) return null;
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? text : `${text}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function minuteStart(timestamp) {
  return Math.floor(timestamp / CANDLE_MS) * CANDLE_MS;
}

function isoMinute(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 19) + 'Z';
}

function normalizeCandle(raw) {
  const at = parseTimestamp(raw?.candle_date_time_utc ?? raw?.timestamp ?? raw?.ts);
  const open = finiteNumber(raw?.opening_price ?? raw?.open ?? raw?.o);
  const high = finiteNumber(raw?.high_price ?? raw?.high ?? raw?.h);
  const low = finiteNumber(raw?.low_price ?? raw?.low ?? raw?.l);
  const close = finiteNumber(raw?.trade_price ?? raw?.close ?? raw?.c);
  if ([at, open, high, low, close].some(value => value === null) ||
    open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
    high < Math.max(open, low, close) || low > Math.min(open, high, close)) {
    return null;
  }
  return { at, open, high, low, close };
}

function strictClosedTrades(ledger) {
  return (Array.isArray(ledger?.strictTrades) ? ledger.strictTrades : []).filter(trade =>
    trade?.type === 'CLOSE' || trade?.action === 'CLOSE' || trade?.action === 'PARTIAL_CLOSE'
  );
}

function resolveCostRates(trade, ledger) {
  if (trade?.paperExecutionCostModel === COST_MODEL) {
    const tradingFeeRate = finiteNumber(trade.paperExecutionTradingFeeRate);
    const slippageRate = finiteNumber(trade.paperExecutionSlippageRate);
    if (tradingFeeRate === null || slippageRate === null || tradingFeeRate < 0 || slippageRate < 0) {
      return { available: false, reason: 'marked_cost_model_missing_rates' };
    }
    return { available: true, tradingFeeRate, slippageRate, source: 'trade_cost_model' };
  }
  if (trade?.paperExecutionCostModel) {
    return { available: false, reason: 'unsupported_trade_cost_model' };
  }
  const tradingFeeRate = finiteNumber(ledger?.configSnapshot?.tradingFee);
  const slippageRate = finiteNumber(ledger?.configSnapshot?.slippage);
  if (tradingFeeRate === null || slippageRate === null || tradingFeeRate < 0 || slippageRate < 0) {
    return { available: false, reason: 'fee_and_slippage_config_required' };
  }
  return { available: true, tradingFeeRate, slippageRate, source: 'config_snapshot_sensitivity' };
}

function makeTradeWindow(trade, responseCandles = []) {
  const entryMs = parseTimestamp(trade?.entryTime ?? trade?.entryTimestamp);
  const exitMs = parseTimestamp(trade?.exitTime ?? trade?.exitTimestamp);
  if (entryMs === null || exitMs === null || exitMs <= entryMs) {
    return {
      complete: false,
      reason: 'invalid_entry_exit_timestamps',
      expectedInteriorBarCount: 0,
      observedInteriorBarCount: 0,
      missingInteriorBars: [],
      invalidCandleCount: 0,
      interiorCandles: []
    };
  }

  const entryMinute = minuteStart(entryMs);
  const exitMinute = minuteStart(exitMs);
  const expectedStarts = [];
  for (let at = entryMinute + CANDLE_MS; at < exitMinute; at += CANDLE_MS) expectedStarts.push(at);

  const candleMap = new Map();
  let invalidCandleCount = 0;
  for (const raw of Array.isArray(responseCandles) ? responseCandles : []) {
    const normalized = normalizeCandle(raw);
    if (!normalized) {
      invalidCandleCount += 1;
      continue;
    }
    candleMap.set(normalized.at, normalized);
  }
  const missingInteriorBars = expectedStarts.filter(at => !candleMap.has(at)).map(isoMinute);
  const interiorCandles = expectedStarts
    .map(at => candleMap.get(at))
    .filter(Boolean)
    .map(candle => ({
      candleStart: isoMinute(candle.at),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close
    }));
  const complete = expectedStarts.length > 0 && missingInteriorBars.length === 0 && invalidCandleCount === 0;
  return {
    complete,
    reason: complete
      ? null
      : expectedStarts.length === 0
        ? 'no_full_interior_minutes'
        : missingInteriorBars.length > 0
          ? 'missing_interior_minute_bars'
          : 'invalid_candle_values',
    expectedInteriorBarCount: expectedStarts.length,
    observedInteriorBarCount: interiorCandles.length,
    missingInteriorBars,
    invalidCandleCount,
    entryBoundaryMinuteExcluded: true,
    exitBoundaryMinuteExcluded: true,
    interiorCandles
  };
}

function calculateCostAdjustedExit(trade, exitPrice, costRates) {
  const entryPrice = finiteNumber(trade?.entryPrice);
  const amount = finiteNumber(trade?.amount);
  if (entryPrice === null || entryPrice <= 0 || amount === null || amount <= 0 ||
    !Number.isFinite(exitPrice) || exitPrice <= 0) {
    return { available: false, reason: 'entry_exit_price_and_amount_required' };
  }
  const entryNotional = entryPrice * amount;
  const exitNotional = exitPrice * amount;
  const twoSidedNotional = entryNotional + exitNotional;
  const grossProfit = (exitPrice - entryPrice) * amount;
  const tradingFeeCost = twoSidedNotional * costRates.tradingFeeRate;
  const modeledSlippageDrag = twoSidedNotional * costRates.slippageRate;
  return {
    available: true,
    exitPrice,
    grossProfitKrw: grossProfit,
    modeledTradingFeeKrw: tradingFeeCost,
    modeledSlippageDragKrw: modeledSlippageDrag,
    costAdjustedNetPnlKrw: grossProfit - tradingFeeCost - modeledSlippageDrag
  };
}

function simulateScenario(trade, candles, costRates, { takeProfitPercent, stopLossPercent }) {
  const entryPrice = finiteNumber(trade?.entryPrice);
  const stopPrice = stopLossPercent > 0 ? entryPrice * (1 - stopLossPercent / 100) : null;
  const targetPrice = entryPrice * (1 + takeProfitPercent / 100);
  for (const candle of candles) {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const openedThroughStop = stopPrice !== null && open <= stopPrice;
    const openedThroughTarget = open >= targetPrice;
    const stopHit = stopPrice !== null && (openedThroughStop || low <= stopPrice);
    const takeProfitHit = openedThroughTarget || high >= targetPrice;
    if (stopHit && takeProfitHit) {
      const exitPrice = openedThroughStop ? open : stopPrice;
      return {
        exitReason: 'same_bar_stop_first',
        exitBarStart: candle.candleStart,
        ambiguousBarCount: 1,
        ...calculateCostAdjustedExit(trade, exitPrice, costRates)
      };
    }
    if (stopHit) {
      const exitPrice = openedThroughStop ? open : stopPrice;
      return {
        exitReason: 'stop_loss',
        exitBarStart: candle.candleStart,
        ambiguousBarCount: 0,
        ...calculateCostAdjustedExit(trade, exitPrice, costRates)
      };
    }
    if (takeProfitHit) {
      const exitPrice = openedThroughTarget ? open : targetPrice;
      return {
        exitReason: 'take_profit',
        exitBarStart: candle.candleStart,
        ambiguousBarCount: 0,
        ...calculateCostAdjustedExit(trade, exitPrice, costRates)
      };
    }
  }

  const recordedExitPrice = finiteNumber(trade?.exitPrice);
  const fallback = calculateCostAdjustedExit(trade, recordedExitPrice, costRates);
  return {
    exitReason: 'max_hold_recorded_exit',
    exitBarStart: trade?.exitTime ?? trade?.exitTimestamp ?? null,
    ambiguousBarCount: 0,
    ...fallback
  };
}

function unavailableReport(reason, ledger, trades) {
  return {
    schema: PAPER_EXIT_PATH_REPLAY_SCHEMA,
    researchOnly: true,
    promoted: false,
    actualFillsObserved: false,
    available: false,
    reason,
    sessionId: ledger?.sessionId || null,
    active: ledger?.active === true,
    ledgerHeartbeatAt: ledger?.heartbeatAt || null,
    strictTradeCount: trades.length,
    coverage: {
      tradeCount: trades.length,
      completeTradeCount: 0,
      incompleteTradeCount: trades.length,
      costIneligibleTradeCount: 0
    },
    trades: [],
    scenarios: []
  };
}

export function buildPaperExitPathReplay({
  ledger,
  trades = strictClosedTrades(ledger),
  candleResponses = [],
  takeProfitLevelsPercent = DEFAULT_PAPER_EXIT_PATH_TAKE_PROFIT_LEVELS,
  generatedAt = new Date().toISOString()
} = {}) {
  const selectedTrades = Array.isArray(trades) ? trades : [];
  if (ledger?.configSnapshotComplete !== true) {
    return unavailableReport('complete_cost_config_required', ledger, selectedTrades);
  }
  const feeRate = finiteNumber(ledger?.configSnapshot?.tradingFee);
  const slippageRate = finiteNumber(ledger?.configSnapshot?.slippage);
  const stopLossPercent = finiteNumber(ledger?.configSnapshot?.stopLossPercent);
  if (feeRate === null || slippageRate === null || stopLossPercent === null ||
    feeRate < 0 || slippageRate < 0 || stopLossPercent < 0) {
    return unavailableReport('valid_fee_slippage_and_stop_config_required', ledger, selectedTrades);
  }
  const takeProfitLevels = [...new Set((Array.isArray(takeProfitLevelsPercent) ? takeProfitLevelsPercent : [])
    .map(finiteNumber)
    .filter(value => value !== null && value > 0))]
    .sort((left, right) => left - right);
  if (takeProfitLevels.length === 0) {
    return unavailableReport('positive_take_profit_levels_required', ledger, selectedTrades);
  }

  const tradeRows = selectedTrades.map((trade, index) => {
    const costRates = resolveCostRates(trade, ledger);
    const window = makeTradeWindow(trade, candleResponses[index]);
    const entryPrice = finiteNumber(trade?.entryPrice);
    const exitPrice = finiteNumber(trade?.exitPrice);
    const amount = finiteNumber(trade?.amount);
    const recordedProfit = finiteNumber(trade?.profit);
    const costEligible = costRates.available && entryPrice !== null && entryPrice > 0 &&
      exitPrice !== null && exitPrice > 0 && amount !== null && amount > 0 && recordedProfit !== null;
    let recordedExitCostParityDeltaKrw = null;
    let baselineCostAdjustedNetPnlKrw = null;
    if (costEligible) {
      const calculated = calculateCostAdjustedExit(trade, exitPrice, costRates);
      const costModelMarked = trade?.paperExecutionCostModel === COST_MODEL;
      const auditComparablePnl = costModelMarked
        ? recordedProfit
        : recordedProfit - (entryPrice * amount + exitPrice * amount) * costRates.slippageRate;
      baselineCostAdjustedNetPnlKrw = calculated.costAdjustedNetPnlKrw;
      recordedExitCostParityDeltaKrw = calculated.costAdjustedNetPnlKrw - auditComparablePnl;
    }
    const scenarios = window.complete && costEligible
      ? takeProfitLevels.map(takeProfitPercent => ({
        takeProfitPercent,
        stopLossPercent,
        ...simulateScenario(trade, window.interiorCandles, costRates, {
          takeProfitPercent,
          stopLossPercent
        })
      }))
      : [];
    return {
      tradeIndex: index,
      coin: trade?.coin || null,
      signalKey: trade?.signalKey || null,
      entryTime: trade?.entryTime || trade?.entryTimestamp || null,
      exitTime: trade?.exitTime || trade?.exitTimestamp || null,
      recordedNetPnlKrw: recordedProfit,
      recordedExitPrice: exitPrice,
      paperExecutionCostModel: trade?.paperExecutionCostModel || null,
      costRateSource: costRates.source || null,
      costIneligibleReason: costRates.available ? (costEligible ? null : 'valid_trade_prices_required') : costRates.reason,
      baselineCostAdjustedNetPnlKrw,
      recordedExitCostParityDeltaKrw,
      coverage: {
        complete: window.complete,
        reason: window.reason,
        expectedInteriorBarCount: window.expectedInteriorBarCount,
        observedInteriorBarCount: window.observedInteriorBarCount,
        missingInteriorBars: window.missingInteriorBars,
        invalidCandleCount: window.invalidCandleCount,
        entryBoundaryMinuteExcluded: window.entryBoundaryMinuteExcluded === true,
        exitBoundaryMinuteExcluded: window.exitBoundaryMinuteExcluded === true
      },
      interiorCandles: window.interiorCandles,
      scenarios
    };
  });

  const completeTradeCount = tradeRows.filter(row => row.coverage.complete).length;
  const costIneligibleTradeCount = tradeRows.filter(row => row.costIneligibleReason !== null).length;
  const eligibleRows = tradeRows.filter(row => row.coverage.complete && row.costIneligibleReason === null);
  const scenarios = takeProfitLevels.map(takeProfitPercent => {
    const rows = eligibleRows.map(trade => trade.scenarios.find(row => row.takeProfitPercent === takeProfitPercent)).filter(Boolean);
    const reasonCounts = rows.reduce((counts, row) => {
      counts[row.exitReason] = (counts[row.exitReason] || 0) + 1;
      return counts;
    }, {});
    const totalNet = rows.reduce((sum, row) => sum + row.costAdjustedNetPnlKrw, 0);
    return {
      takeProfitPercent,
      stopLossPercent,
      coveredTradeCount: rows.length,
      excludedTradeCount: selectedTrades.length - rows.length,
      takeProfitExitCount: reasonCounts.take_profit || 0,
      stopExitCount: reasonCounts.stop_loss || 0,
      ambiguousStopFirstExitCount: reasonCounts.same_bar_stop_first || 0,
      maxHoldExitCount: reasonCounts.max_hold_recorded_exit || 0,
      exitReasonCounts: reasonCounts,
      costAdjustedNetPnlKrw: rows.length ? totalNet : null,
      profitableTradeCount: rows.length ? rows.filter(row => row.costAdjustedNetPnlKrw > 0).length : null
    };
  });
  const parityDeltas = tradeRows.map(row => row.recordedExitCostParityDeltaKrw).filter(value => value !== null);
  return {
    schema: PAPER_EXIT_PATH_REPLAY_SCHEMA,
    generatedAt,
    researchOnly: true,
    promoted: false,
    actualFillsObserved: false,
    thresholdSelectionBasis: 'exploratory_sensitivity_not_independent_holdout',
    available: true,
    sessionId: ledger?.sessionId || null,
    active: ledger?.active === true,
    ledgerHeartbeatAt: ledger?.heartbeatAt || null,
    configSnapshotComplete: ledger?.configSnapshotComplete === true,
    costModel: {
      tradingFeeRate: feeRate,
      slippageRate,
      takeProfitLevelsPercent: takeProfitLevels,
      stopLossPercent,
      maxHoldMinutes: finiteNumber(ledger?.configSnapshot?.maxHoldMinutes)
    },
    coverage: {
      tradeCount: selectedTrades.length,
      completeTradeCount,
      incompleteTradeCount: selectedTrades.length - completeTradeCount,
      costIneligibleTradeCount,
      baselineCostParityCheckedTradeCount: parityDeltas.length,
      maximumAbsoluteBaselineCostParityDeltaKrw: parityDeltas.length
        ? Math.max(...parityDeltas.map(Math.abs))
        : null
    },
    scenarios,
    trades: tradeRows,
    limitations: [
      'Minute OHLC is not a fill, executable bid/ask, queue position, or wallet settlement.',
      'Take-profit levels are exploratory sensitivities, not a pre-registered or independently selected parameter.',
      'Entry and exit partial-minute candles are excluded because their within-minute path relative to the fill is unknown.',
      'Missing interior candles make that trade ineligible rather than implying no threshold touch.',
      'When stop and take-profit are both touched inside one minute, the adverse stop is assumed first.',
      'The small completed-trade sample is descriptive and cannot establish independent profitability or authorize parameter changes.'
    ]
  };
}
