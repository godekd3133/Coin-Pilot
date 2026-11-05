// Account loss guard: blocks NEW entries (never exits) when the account has
// lost enough. Two independent opt-in limits, both off at 0:
//   - equity floor: cash + open positions at the last verified market price
//     (cost basis when no recent price) below `equityFloorKrw`
//   - daily loss:   realized P&L of the current KST day at or below -`dailyLossLimitKrw`
// Stop-loss/take-profit/max-hold exits keep running while it is tripped.
import { startOfKstDay } from '../api/operatorAlertMonitor.js';

export function realizedSince(strategies, sinceMs) {
  let realized = 0;
  for (const strategy of strategies?.values?.() || []) {
    for (const trade of strategy.tradeHistory || []) {
      if (trade.action !== 'CLOSE' && trade.action !== 'PARTIAL_CLOSE') continue;
      const exitMs = Date.parse(trade.exitTime || trade.timestamp);
      if (exitMs >= sinceMs) realized += Number(trade.profit) || 0;
    }
  }
  return realized;
}

/**
 * Open positions at market value when a recent price is known, otherwise at
 * cost (so a missing quote never hides the position entirely).
 */
export function positionValue(strategies, prices = null) {
  let value = 0;
  for (const [coin, strategy] of strategies?.entries?.() || []) {
    const position = strategy?.currentPosition;
    if (!position) continue;
    const market = Number(prices?.get?.(coin));
    const price = Number.isFinite(market) && market > 0 ? market : Number(position.entryPrice) || 0;
    value += (Number(position.amount) || 0) * price;
  }
  return value;
}

export function evaluateAccountLossGuard({ equityFloorKrw = 0, dailyLossLimitKrw = 0, krwBalance, strategies, prices = null, now = Date.now() }) {
  const floor = Number(equityFloorKrw) || 0;
  const limit = Number(dailyLossLimitKrw) || 0;
  const realizedToday = realizedSince(strategies, startOfKstDay(now));
  const cash = Number(krwBalance);
  const equity = Number.isFinite(cash) ? cash + positionValue(strategies, prices) : null;
  let blockedReason = null;
  if (limit > 0 && realizedToday <= -limit) blockedReason = 'daily_loss_limit';
  else if (floor > 0 && equity !== null && equity < floor) blockedReason = 'equity_floor';
  return {
    enabled: floor > 0 || limit > 0,
    equityFloorKrw: floor,
    dailyLossLimitKrw: limit,
    realizedToday: Math.round(realizedToday),
    equity: equity === null ? null : Math.round(equity),
    blocked: blockedReason !== null,
    blockedReason
  };
}
