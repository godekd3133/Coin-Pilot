// Account loss guard: blocks NEW entries (never exits) when the account has
// lost enough. Two independent opt-in limits, both off at 0:
//   - equity floor: cash + open-position cost basis below `equityFloorKrw`
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

export function positionCostBasis(strategies) {
  let cost = 0;
  for (const strategy of strategies?.values?.() || []) {
    const position = strategy?.currentPosition;
    if (position) cost += (Number(position.amount) || 0) * (Number(position.entryPrice) || 0);
  }
  return cost;
}

export function evaluateAccountLossGuard({ equityFloorKrw = 0, dailyLossLimitKrw = 0, krwBalance, strategies, now = Date.now() }) {
  const floor = Number(equityFloorKrw) || 0;
  const limit = Number(dailyLossLimitKrw) || 0;
  const realizedToday = realizedSince(strategies, startOfKstDay(now));
  const cash = Number(krwBalance);
  const equity = Number.isFinite(cash) ? cash + positionCostBasis(strategies) : null;
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
