// Stock trader (KRX via the securities Open API) presentation helpers.

export const MARKET_REASON_LABELS = Object.freeze({
  regular_session: '정규장 · 신규 진입 가능',
  entry_cutoff: '마감 전 신규 진입 중단',
  flatten_before_close: '마감 전 보유 종목 정리 중',
  before_open: '개장 전',
  after_close: '장 마감',
  market_holiday: '휴장일'
});

export function marketSessionPresentation(market) {
  if (!market || typeof market !== 'object') return { label: '장 상태 확인 전', tone: 'neutral', open: null };
  const label = MARKET_REASON_LABELS[market.reason] || (market.open ? '장 운영 중' : '장 운영 시간 아님');
  const tone = market.mustFlatten ? 'warning' : market.canEnter ? 'ok' : market.open ? 'warning' : 'neutral';
  return { label, tone, open: market.open === true, canEnter: market.canEnter === true, mustFlatten: market.mustFlatten === true };
}

export function stockTraderSummary(trader) {
  if (!trader) return null;
  const positions = Array.isArray(trader.positions) ? trader.positions : [];
  const unrealized = positions.reduce((sum, position) => sum + (Number.isFinite(Number(position.unrealizedProfit)) ? Number(position.unrealizedProfit) : 0), 0);
  return {
    mode: trader.mode === 'live' ? 'live' : 'paper',
    running: trader.running === true,
    desiredRunning: trader.desiredRunning !== false,
    entriesPaused: trader.entriesPaused === true,
    pauseReason: trader.pauseReason || null,
    pendingOrders: Number(trader.pendingOrders) || 0,
    market: marketSessionPresentation(trader.market),
    lastCycleAt: trader.lastCycleAt || null,
    lastError: trader.lastError || null,
    cash: Number.isFinite(Number(trader.cash)) ? Number(trader.cash) : null,
    initialSeedMoney: Number.isFinite(Number(trader.initialSeedMoney)) ? Number(trader.initialSeedMoney) : null,
    totalAssets: Number.isFinite(Number(trader.totalAssets)) ? Number(trader.totalAssets) : null,
    positions,
    unrealizedProfit: positions.some(position => Number.isFinite(Number(position.unrealizedProfit))) ? unrealized : null,
    maxPositions: trader.maxPositions ?? null,
    statistics: trader.statistics || null,
    recentTrades: Array.isArray(trader.recentTrades) ? trader.recentTrades : [],
    recentSignals: Array.isArray(trader.recentSignals) ? trader.recentSignals : []
  };
}

/** Paper reset is only possible on a paper trader without open positions. */
export function stockPaperResetAllowed(summary) {
  return summary?.mode === 'paper' && summary.positions.length === 0;
}
