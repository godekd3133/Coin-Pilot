// Trade receipts: why a strict trade entered and exited and what it cost.
//
// The receipt is diagnostic metadata written next to the strategy position at
// fill time. It never feeds a trading decision: P&L, stops and every gate
// still read the strategy's own fields. Old records without a receipt are
// projected from the fields they already carry; anything not recorded stays
// null so the app can show "기록 없음" instead of a guess.

export const TRADE_RECEIPT_VERSION = 1;
export const DEFAULT_FEE_RATE = 0.0005;

const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const positive = value => {
  const number = finite(value);
  return number !== null && number > 0 ? number : null;
};

const round = (value, digits = 6) => (value === null ? null : Number(value.toFixed(digits)));

const toIso = value => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/**
 * Upbit `candle_date_time_utc` has no zone suffix ("2026-11-07T01:23:00").
 * Treat a zone-less ISO string as UTC; anything else must parse on its own.
 */
export function parseCandleTimeUtc(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value);
  const zoneless = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text);
  const parsed = Date.parse(zoneless ? `${text}Z` : text);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Map a strategy exit type (or a legacy reason string) to a receipt category. */
export function classifyExitType(type, reason = '') {
  const normalized = String(type || '').toUpperCase();
  if (normalized === 'TAKE_PROFIT') return 'TAKE_PROFIT';
  if (normalized === 'STOP_LOSS') return 'STOP_LOSS';
  if (normalized === 'MAX_HOLD_TIME') return 'MAX_HOLD';
  if (normalized === 'MAX_LOSING_HOLD_TIME') return 'MAX_LOSING_HOLD';
  if (normalized === 'BREAK_EVEN_STOP') return 'BREAK_EVEN_STOP';
  if (normalized === 'TRAILING_STOP') return 'TRAILING_STOP';
  if (normalized === 'EXCHANGE_SYNC') return 'EXCHANGE_SYNC';
  if (normalized === 'MANUAL') return 'MANUAL';
  const text = String(reason || '');
  if (!text) return null;
  if (text.includes('거래소 동기화')) return 'EXCHANGE_SYNC';
  if (text.includes('최대 보유시간')) return 'MAX_HOLD';
  if (text.includes('손실 포지션 조기 청산')) return 'MAX_LOSING_HOLD';
  if (text.includes('트레일링')) return 'TRAILING_STOP';
  if (text.includes('브레이크이븐')) return 'BREAK_EVEN_STOP';
  if (text.includes('익절')) return 'TAKE_PROFIT';
  if (text.includes('손절')) return 'STOP_LOSS';
  if (text.includes('수동') || text.includes('번들')) return 'MANUAL';
  if (text.includes('리밸런싱')) return 'REBALANCE';
  return 'OTHER';
}

function slippagePercent(side, expectedPrice, filledPrice) {
  if (expectedPrice === null || filledPrice === null) return null;
  // Positive = adverse: paid more on a buy, received less on a sell.
  const raw = side === 'entry'
    ? (filledPrice - expectedPrice) / expectedPrice * 100
    : (expectedPrice - filledPrice) / expectedPrice * 100;
  return round(raw, 4);
}

/**
 * Entry receipt written right after the strategy position opens.
 * `expectedPrice` is the price observed at the delayed revalidation (paper)
 * or the reference price sent with the LIVE order; `filledPrice` is the
 * booked fill (paper model) or Upbit avg_price (LIVE).
 */
export function buildEntryReceipt({
  mode,
  decision = null,
  signalProfile = null,
  candleUnit = null,
  expectedPrice = null,
  filledPrice = null,
  volume = null,
  fee = null,
  feeRate = null,
  feeSource = null,
  slippageSource = null,
  slippageRate = null,
  orderAt = null,
  confirmation = null,
  entryCost = null,
  orderId = null
} = {}) {
  const rebound = decision?.details?.rebound || {};
  const unit = positive(candleUnit);
  const candleStartMs = parseCandleTimeUtc(rebound.candleTime);
  const candleCloseMs = candleStartMs !== null && unit !== null ? candleStartMs + unit * 60_000 : null;
  const orderMs = orderAt === null ? null : new Date(orderAt).getTime();
  const latencyMs = candleCloseMs !== null && Number.isFinite(orderMs) && orderMs >= candleCloseMs
    ? orderMs - candleCloseMs
    : null;
  const expected = positive(expectedPrice);
  const filled = positive(filledPrice);
  return {
    version: TRADE_RECEIPT_VERSION,
    mode: mode === 'live' ? 'live' : mode === 'paper' ? 'paper' : null,
    signal: decision ? {
      profile: signalProfile || rebound.signalProfile || null,
      candleUnit: unit,
      candleTime: rebound.candleTime || null,
      candleCloseAt: candleCloseMs === null ? null : new Date(candleCloseMs).toISOString(),
      rsi: finite(rebound.rsi),
      oversoldRsi: finite(rebound.oversoldRsi ?? rebound.previousRsi),
      rsiRecovery: finite(rebound.rsiRecovery),
      reboundPercent: finite(rebound.reboundPriceChangePercent ?? rebound.priceChangePercent),
      volumeRatio: finite(rebound.volumeRatio),
      reason: typeof decision.reason === 'string' ? decision.reason : null
    } : null,
    confirmation: confirmation ? {
      outcome: confirmation.outcome || 'confirmed',
      reason: confirmation.reason || 'entry_revalidation_passed',
      delayMs: finite(confirmation.delayMs)
    } : null,
    entryCost: entryCost ? {
      spreadPercent: finite(entryCost.spreadPercent),
      tickPercent: finite(entryCost.tickPercent),
      costPercent: finite(entryCost.costPercent),
      limitPercent: finite(entryCost.limitPercent),
      filterMode: entryCost.filterMode || null
    } : null,
    expectedPrice: expected,
    filledPrice: filled,
    volume: positive(volume),
    slippagePercent: slippagePercent('entry', expected, filled),
    slippageSource: slippageSource || null,
    slippageRate: finite(slippageRate),
    fee: finite(fee),
    feeRate: finite(feeRate),
    feeSource: feeSource || null,
    orderAt: toIso(orderAt),
    signalToOrderMs: latencyMs,
    orderId: orderId || null
  };
}

/** Exit receipt set on the position just before `closePosition()` copies it. */
export function buildExitReceipt({
  mode,
  decision = null,
  exitType = null,
  maxHoldMinutes = null,
  expectedPrice = null,
  filledPrice = null,
  volume = null,
  fee = null,
  feeRate = null,
  feeSource = null,
  slippageSource = null,
  slippageRate = null,
  orderAt = null,
  orderId = null,
  estimated = false,
  estimateBasis = null
} = {}) {
  const expected = positive(expectedPrice);
  const filled = positive(filledPrice);
  const type = exitType || decision?.details?.positionCheck?.type || decision?.type || null;
  return {
    version: TRADE_RECEIPT_VERSION,
    mode: mode === 'live' ? 'live' : mode === 'paper' ? 'paper' : null,
    exitType: classifyExitType(type, decision?.reason),
    reason: typeof decision?.reason === 'string' ? decision.reason : null,
    trigger: decision?.details?.source || null,
    maxHoldMinutes: positive(maxHoldMinutes),
    expectedPrice: expected,
    filledPrice: filled,
    volume: positive(volume),
    slippagePercent: slippagePercent('exit', expected, filled),
    slippageSource: slippageSource || null,
    slippageRate: finite(slippageRate),
    fee: finite(fee),
    feeRate: finite(feeRate),
    feeSource: feeSource || null,
    orderAt: toIso(orderAt),
    orderId: orderId || null,
    estimated: estimated === true,
    estimateBasis: estimated === true ? (estimateBasis || null) : null
  };
}

/** Copy the receipt onto the OPEN history record (it was spread before decoration). */
export function attachEntryReceiptToOpenRecord(strategy, fields) {
  const position = strategy?.currentPosition;
  const history = strategy?.tradeHistory;
  if (!position || !Array.isArray(history)) return;
  for (let index = history.length - 1; index >= 0; index--) {
    const record = history[index];
    if (record?.action === 'OPEN' && record.id === position.id) {
      Object.assign(record, fields);
      return;
    }
  }
}

function costLine(percent, krw) {
  return percent === null && krw === null ? null : { percent, krw };
}

/**
 * Read-only projection for the app. Uses the stored receipt when present and
 * the legacy decoration fields otherwise; never invents a missing value.
 */
export function projectTradeReceipt(trade, { mode = null } = {}) {
  const action = String(trade?.action || '').toUpperCase();
  if (!['CLOSE', 'PARTIAL_CLOSE'].includes(action)) return null;
  const entry = trade.entryReceipt && typeof trade.entryReceipt === 'object' ? trade.entryReceipt : null;
  const exit = trade.exitReceipt && typeof trade.exitReceipt === 'object' ? trade.exitReceipt : null;
  const volume = positive(trade.amount);
  const entryPrice = positive(trade.entryPrice);
  const exitPrice = positive(trade.exitPrice);
  const notional = entryPrice !== null && volume !== null ? entryPrice * volume : null;

  const entryExpected = positive(entry?.expectedPrice) ?? positive(trade.paperObservedEntryPrice);
  const entryFilled = positive(entry?.filledPrice) ?? entryPrice;
  const exitExpected = positive(exit?.expectedPrice) ?? positive(trade.paperObservedExitPrice);
  const exitFilled = positive(exit?.filledPrice) ?? exitPrice;
  const entrySlipPct = entryExpected !== null && entryFilled !== null
    ? slippagePercent('entry', entryExpected, entryFilled) : null;
  const exitSlipPct = exitExpected !== null && exitFilled !== null
    ? slippagePercent('exit', exitExpected, exitFilled) : null;
  const entrySlipKrw = entrySlipPct !== null && volume !== null
    ? round((entryFilled - entryExpected) * volume, 2) : null;
  const exitSlipKrw = exitSlipPct !== null && volume !== null
    ? round((exitExpected - exitFilled) * volume, 2) : null;

  // A partial close carries only its share of the entry fee.
  const rawEntryFee = finite(entry?.fee) ?? finite(trade.paperEntryFee);
  const entryVolume = positive(entry?.volume) ?? positive(trade.originalAmount);
  const entryFee = rawEntryFee === null ? null
    : action === 'PARTIAL_CLOSE'
      ? (entryVolume !== null && volume !== null ? rawEntryFee * Math.min(1, volume / entryVolume) : null)
      : rawEntryFee;
  const exitFee = finite(exit?.fee);
  const recordedTotalFee = finite(trade.totalFee);
  const feeRate = finite(exit?.feeRate) ?? finite(entry?.feeRate) ?? finite(trade.paperExecutionTradingFeeRate);
  const feeTotal = entryFee !== null && exitFee !== null ? entryFee + exitFee : recordedTotalFee;
  const grossProfit = finite(trade.grossProfit);
  const netProfit = finite(trade.profit);
  const exchangeFees = entry?.feeSource === 'exchange_paid_fee' && exit?.feeSource === 'exchange_paid_fee' &&
    entryFee !== null && exitFee !== null;

  const entryTimeMs = new Date(trade.entryTime || '').getTime();
  const exitTimeMs = new Date(trade.exitTime || '').getTime();
  const holdMs = Number.isFinite(entryTimeMs) && Number.isFinite(exitTimeMs) && exitTimeMs >= entryTimeMs
    ? exitTimeMs - entryTimeMs : null;

  const signalSource = entry?.signal || null;
  const legacySignal = trade.signalTime || trade.signalRsi !== undefined;
  const signal = signalSource || legacySignal ? {
    profile: signalSource?.profile ?? null,
    candleUnit: finite(signalSource?.candleUnit),
    candleTime: signalSource?.candleTime ?? trade.signalTime ?? null,
    candleCloseAt: signalSource?.candleCloseAt ?? null,
    rsi: finite(signalSource?.rsi) ?? finite(trade.signalRsi),
    oversoldRsi: finite(signalSource?.oversoldRsi) ?? finite(trade.signalOversoldRsi),
    rsiRecovery: finite(signalSource?.rsiRecovery) ?? finite(trade.signalRsiRecovery),
    reboundPercent: finite(signalSource?.reboundPercent) ?? finite(trade.signalReboundPercent),
    volumeRatio: finite(signalSource?.volumeRatio) ?? finite(trade.signalVolumeRatio),
    reason: signalSource?.reason ?? null
  } : null;
  // entryDelayMs is only set by a passed delayed revalidation.
  const legacyDelay = finite(trade.entryDelayMs);
  const confirmation = entry?.confirmation || (legacyDelay !== null
    ? { outcome: 'confirmed', reason: 'entry_revalidation_passed', delayMs: legacyDelay }
    : null);

  const reason = typeof trade.reason === 'string' ? trade.reason : null;
  const estimated = exit?.estimated === true || (reason !== null && reason.includes('거래소 동기화') && reason.includes('추정'));
  const resolvedMode = entry?.mode || exit?.mode || mode || null;
  const slippageSource = entry?.slippageSource || exit?.slippageSource ||
    (trade.paperExecutionCostModel ? 'paper_model' : null);

  const pct = (krw) => (krw !== null && notional ? round(krw / notional * 100, 4) : null);
  return {
    version: TRADE_RECEIPT_VERSION,
    mode: resolvedMode,
    partial: action === 'PARTIAL_CLOSE',
    estimated,
    estimateBasis: estimated ? (exit?.estimateBasis ?? null) : null,
    entry: {
      time: toIso(trade.entryTime),
      price: entryFilled,
      expectedPrice: entryExpected,
      signal,
      confirmation,
      orderAt: entry?.orderAt ?? null,
      signalToOrderMs: finite(entry?.signalToOrderMs),
      orderId: entry?.orderId ?? null
    },
    exit: {
      time: toIso(trade.exitTime),
      price: exitFilled,
      expectedPrice: exitExpected,
      type: exit?.exitType || classifyExitType(null, reason),
      reason,
      maxHoldMinutes: finite(exit?.maxHoldMinutes),
      holdMs,
      orderId: exit?.orderId ?? null
    },
    volume,
    notional: notional === null ? null : round(notional, 2),
    costs: {
      feeRate,
      feeSource: entry?.feeSource || exit?.feeSource || (recordedTotalFee !== null ? 'model' : null),
      entryFee: costLine(pct(entryFee), entryFee === null ? null : round(entryFee, 2)),
      exitFee: costLine(pct(exitFee), exitFee === null ? null : round(exitFee, 2)),
      totalFee: costLine(pct(feeTotal), feeTotal === null ? null : round(feeTotal, 2)),
      recordedTotalFee: recordedTotalFee === null ? null : round(recordedTotalFee, 2),
      slippageSource,
      slippageRate: finite(entry?.slippageRate) ?? finite(exit?.slippageRate) ?? finite(trade.paperExecutionSlippageRate),
      entrySlippage: costLine(entrySlipPct, entrySlipKrw),
      exitSlippage: costLine(exitSlipPct, exitSlipKrw),
      entryCost: entry?.entryCost || null
    },
    result: {
      grossProfit: grossProfit === null ? null : round(grossProfit, 2),
      grossProfitPercent: pct(grossProfit),
      netProfit: netProfit === null ? null : round(netProfit, 2),
      netProfitPercent: finite(trade.profitPercent) === null ? pct(netProfit) : round(finite(trade.profitPercent), 4),
      // LIVE P&L is booked with the 0.05% fee model; show the paid-fee version beside it.
      netProfitWithPaidFees: exchangeFees && grossProfit !== null
        ? round(grossProfit - entryFee - exitFee, 2)
        : null
    }
  };
}
