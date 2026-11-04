// Read only the bounded history already held by the trading system.
export function latestTradeTimestamp(tradingSystem = {}) {
  const histories = [tradingSystem.smartTradeHistory];
  if (tradingSystem.strategies instanceof Map) {
    for (const strategy of tradingSystem.strategies.values()) {
      if (typeof strategy?.getTradeHistory === 'function') histories.push(strategy.getTradeHistory(100));
    }
  } else if (typeof tradingSystem.strategy?.getTradeHistory === 'function') {
    histories.push(tradingSystem.strategy.getTradeHistory(100));
  }
  let latest = null;
  for (const history of histories) {
    if (!Array.isArray(history)) continue;
    for (const trade of history) {
      if (!trade || typeof trade !== 'object') continue;
      const action = String(trade.action || trade.type || '').toUpperCase();
      const isSell = ['SELL', 'CLOSE', 'PARTIAL_CLOSE'].includes(action);
      const value = trade.timestamp || (isSell
        ? trade.exitTime || trade.entryTime
        : trade.entryTime || trade.exitTime);
      if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') continue;
      const milliseconds = new Date(value).getTime();
      if (!Number.isFinite(milliseconds)) continue;
      if (latest === null || milliseconds > latest) latest = milliseconds;
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}
