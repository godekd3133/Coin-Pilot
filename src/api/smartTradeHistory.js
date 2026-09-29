const MAX_SMART_TRADE_HISTORY = 100;

export function appendSmartTradeHistory(tradingSystem, tradeRecord) {
  if (!tradingSystem || typeof tradingSystem !== 'object') {
    throw new TypeError('tradingSystem must be an object');
  }

  if (!tradingSystem.smartTradeHistory) {
    tradingSystem.smartTradeHistory = [];
  }

  const history = tradingSystem.smartTradeHistory;
  if (!Array.isArray(history)) {
    throw new TypeError('smartTradeHistory must be an array');
  }

  history.unshift(tradeRecord);
  if (history.length > MAX_SMART_TRADE_HISTORY) {
    history.splice(MAX_SMART_TRADE_HISTORY);
  }

  return history;
}
