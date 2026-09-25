import { calculateTradeReturnConfidence } from '../backtest/scalpingBacktest.js';

export const DEFAULT_MOMENTUM_SHADOW_MIN_RESEARCH_DAYS = 14;

/**
 * Calculate one comparable observation window for every read-only consumer.
 * A future or reversed boundary is unverifiable and therefore returns null
 * instead of allowing a clock-skewed ledger to claim extra observation time.
 */
export function calculateMomentumShadowObservationDays(ledger, now = Date.now()) {
  const startedAtMs = Date.parse(ledger?.startedAt || '');
  const endValue = ledger?.endedAt || ledger?.heartbeatAt || '';
  const observationEndMs = Date.parse(endValue);
  const nowMs = Number(now);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(observationEndMs) ||
    !Number.isFinite(nowMs) || startedAtMs > nowMs || observationEndMs > nowMs ||
    observationEndMs < startedAtMs) {
    return null;
  }
  return (observationEndMs - startedAtMs) / (24 * 60 * 60 * 1000);
}

/**
 * Keep realized-profit and trade-return confidence calculations identical for
 * the API, CLI, and any future read-only consumers. Momentum shadow trades
 * use a compact ledger shape, so they are normalized to the generic closed
 * trade contract before the shared confidence calculation runs.
 */
export function calculateMomentumShadowRealizedProfit(ledger) {
  const trades = Array.isArray(ledger?.trades) ? ledger.trades : [];
  return trades.reduce((total, trade) =>
    total + ((Number(trade.profitPercent) || 0) / 100) * (Number(trade.entry?.size) || 0), 0);
}

/**
 * Attribute closed shadow-trade results by market without treating malformed
 * rows as profitable or losing samples. The result is descriptive only: a
 * small losing market sample must not automatically remove that market from
 * the runner contract.
 */
export function summarizeMomentumShadowTradesByMarket(ledger) {
  const trades = Array.isArray(ledger?.trades) ? ledger.trades : [];
  const rows = {};
  for (const trade of trades) {
    const market = String(trade?.market || 'UNKNOWN').trim() || 'UNKNOWN';
    if (!rows[market]) {
      rows[market] = {
        tradeCount: 0,
        validReturnCount: 0,
        winningTrades: 0,
        losingTrades: 0,
        realizedProfit: 0,
        profitPercentSum: 0,
        averageProfitPercent: null,
        bestProfitPercent: null,
        worstProfitPercent: null
      };
    }
    const row = rows[market];
    row.tradeCount += 1;
    const profitPercent = trade?.profitPercent === null || trade?.profitPercent === undefined ||
      trade?.profitPercent === '' ? null : Number(trade.profitPercent);
    const size = trade?.entry?.size === null || trade?.entry?.size === undefined ||
      trade?.entry?.size === '' ? null : Number(trade.entry.size);
    if (!Number.isFinite(profitPercent) || !Number.isFinite(size) || size <= 0) continue;
    row.validReturnCount += 1;
    row.realizedProfit += (profitPercent / 100) * size;
    row.profitPercentSum += profitPercent;
    if (profitPercent > 0) row.winningTrades += 1;
    if (profitPercent < 0) row.losingTrades += 1;
    row.bestProfitPercent = row.bestProfitPercent === null
      ? profitPercent
      : Math.max(row.bestProfitPercent, profitPercent);
    row.worstProfitPercent = row.worstProfitPercent === null
      ? profitPercent
      : Math.min(row.worstProfitPercent, profitPercent);
  }

  for (const row of Object.values(rows)) {
    row.averageProfitPercent = row.validReturnCount
      ? row.profitPercentSum / row.validReturnCount
      : null;
    delete row.profitPercentSum;
  }

  return Object.fromEntries(Object.entries(rows).sort(([left], [right]) => left.localeCompare(right)));
}

export function calculateMomentumShadowRealizedReturnPercent(
  ledger,
  fallbackInitialBalance = 100_000_000
) {
  const initialBalance = Number(ledger?.initialBalance) || Number(fallbackInitialBalance) || 0;
  if (initialBalance <= 0) return null;
  return (calculateMomentumShadowRealizedProfit(ledger) / initialBalance) * 100;
}

export function calculateMomentumShadowTradeConfidence(ledger) {
  const trades = Array.isArray(ledger?.trades) ? ledger.trades : [];
  return calculateTradeReturnConfidence(trades.map(trade => ({
    action: 'CLOSE',
    investAmount: Number(trade.entry?.size),
    profitPercent: trade.profitPercent
  })));
}

/**
 * Describe whether positive simulated closed-trade P&L is concentrated in a
 * small number of winners. The leave-winner-out values are post-hoc
 * sensitivity diagnostics only; they do not change promotion or execution.
 */
export function summarizeMomentumShadowProfitConcentration(ledger) {
  const trades = Array.isArray(ledger?.trades) ? ledger.trades : [];
  const validTrades = trades.map((trade, index) => {
    const investAmount = Number(trade?.entry?.size);
    const profitPercent = trade?.profitPercent === null || trade?.profitPercent === undefined ||
      trade?.profitPercent === ''
      ? null
      : Number(trade.profitPercent);
    if (!Number.isFinite(investAmount) || investAmount <= 0 || !Number.isFinite(profitPercent)) {
      return null;
    }
    const profitKrw = investAmount * profitPercent / 100;
    if (!Number.isFinite(profitKrw)) return null;
    return {
      index,
      investAmount,
      profitPercent,
      profitKrw
    };
  }).filter(Boolean);
  const winners = validTrades
    .filter(trade => trade.profitKrw > 0)
    .sort((left, right) => right.profitKrw - left.profitKrw || left.index - right.index);
  const totalPositivePnlKrw = winners.reduce((total, trade) => total + trade.profitKrw, 0);
  const totalNetPnlKrw = validTrades.reduce((total, trade) => total + trade.profitKrw, 0);

  const confidenceFor = excludedCount => {
    const excluded = new Set(winners.slice(0, excludedCount).map(trade => trade.index));
    const remaining = validTrades.filter(trade => !excluded.has(trade.index));
    const confidence = calculateTradeReturnConfidence(remaining.map(trade => ({
      action: 'CLOSE',
      investAmount: trade.investAmount,
      profitPercent: trade.profitPercent
    })));
    const excludedPnlKrw = winners.slice(0, excludedCount)
      .reduce((total, trade) => total + trade.profitKrw, 0);
    return {
      excludedWinnerCount: Math.min(excludedCount, winners.length),
      tradeCount: remaining.length,
      realizedPnlKrw: totalNetPnlKrw - excludedPnlKrw,
      tradeReturnConfidence: {
        method: confidence.method,
        confidenceLevel: confidence.confidenceLevel,
        sampleCount: confidence.sampleCount,
        lowerBoundPercent: confidence.lowerBoundPercent
      }
    };
  };

  const shareOfPositivePnl = profitKrw => totalPositivePnlKrw > 0
    ? (profitKrw / totalPositivePnlKrw) * 100
    : null;
  const topWinner = winners[0] || null;
  const topTwoWinnerPnlKrw = winners.slice(0, 2)
    .reduce((total, trade) => total + trade.profitKrw, 0);

  return {
    available: totalPositivePnlKrw > 0,
    researchOnly: true,
    promoted: false,
    actualFillsObserved: false,
    closedTradeCount: trades.length,
    validTradeCount: validTrades.length,
    winningTradeCount: winners.length,
    totalPositivePnlKrw,
    topWinnerShareOfPositivePnlPercent: topWinner
      ? shareOfPositivePnl(topWinner.profitKrw)
      : null,
    topTwoWinnersShareOfPositivePnlPercent: topWinner
      ? shareOfPositivePnl(topTwoWinnerPnlKrw)
      : null,
    netPnlWithoutTopWinnerKrw: topWinner
      ? confidenceFor(1).realizedPnlKrw
      : null,
    confidenceWithoutTopWinner: topWinner
      ? confidenceFor(1).tradeReturnConfidence
      : null,
    netPnlWithoutTopTwoWinnersKrw: topWinner
      ? confidenceFor(2).realizedPnlKrw
      : null,
    confidenceWithoutTopTwoWinners: topWinner
      ? confidenceFor(2).tradeReturnConfidence
      : null,
    note: '양수 시뮬레이션 청산손익 중 상위 승리 거래 집중도와 사후 제외 민감도입니다. 승격 기준이나 실제 체결 증거가 아닙니다.'
  };
}
