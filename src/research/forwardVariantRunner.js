export const DEFAULT_FORWARD_VARIANT_NAMES = Object.freeze([
  'baseline',
  'volume_15',
  'rebound_25',
  'max_rebound_04',
  'loss_timeout_5m'
]);

const finiteNumber = value => Number.isFinite(Number(value)) ? Number(value) : null;

/**
 * Resolve a pre-registered forward variant list.
 *
 * Unknown names fail closed instead of silently shrinking the experiment,
 * because a missing candidate would make the comparison report misleading.
 */
export function resolveForwardVariantNames(raw, availableVariants, defaults = DEFAULT_FORWARD_VARIANT_NAMES) {
  const available = new Set(Object.keys(availableVariants || {}));
  const requested = raw === undefined || raw === null || String(raw).trim() === ''
    ? defaults
    : String(raw).split(',').map(name => name.trim()).filter(Boolean);
  const names = [...new Set(requested)];
  const unknown = names.filter(name => !available.has(name));
  if (unknown.length > 0) {
    throw new Error(`알 수 없는 forward variant: ${unknown.join(', ')}`);
  }
  if (names.length === 0) throw new Error('forward variant가 하나 이상 필요합니다.');
  return names;
}

/**
 * Build one immutable variant definition per virtual book.
 */
export function buildForwardVariantDefinitions(names, availableVariants) {
  return names.map(name => Object.freeze({
    name,
    overrides: Object.freeze({ ...(availableVariants[name] || {}) })
  }));
}

/**
 * Normalize one common exchange read into the snapshot contract consumed by
 * MultiCoinTrader.executeTradingCycleFromSnapshot().
 */
export function createSharedMarketSnapshot({
  markets,
  tickers,
  candlesByMarket,
  capturedAt = new Date().toISOString()
} = {}) {
  const requestedMarkets = [...new Set(Array.isArray(markets) ? markets : [])];
  if (requestedMarkets.length === 0) throw new Error('shared snapshot 대상 market이 없습니다.');

  const tickerMap = new Map(
    (Array.isArray(tickers) ? tickers : [])
      .filter(ticker => requestedMarkets.includes(ticker?.market) && finiteNumber(ticker?.trade_price) !== null)
      .map(ticker => [ticker.market, ticker])
  );
  const priceMap = new Map(
    [...tickerMap.entries()].map(([market, ticker]) => [market, Number(ticker.trade_price)])
  );
  const marketDataByCoin = new Map();
  const missing = [];

  for (const market of requestedMarkets) {
    const candles = candlesByMarket instanceof Map
      ? candlesByMarket.get(market)
      : candlesByMarket?.[market];
    const ticker = tickerMap.get(market);
    if (!ticker || !Array.isArray(candles) || candles.length === 0) {
      missing.push(market);
      continue;
    }
    marketDataByCoin.set(market, {
      ticker,
      candles,
      sharedSnapshot: true
    });
  }

  if (missing.length > 0) {
    throw new Error(`shared snapshot 데이터 누락: ${missing.join(', ')}`);
  }

  return Object.freeze({
    capturedAt,
    markets: Object.freeze(requestedMarkets),
    tickerMap,
    priceMap,
    marketDataByCoin
  });
}

export function summarizeVariantLedger(ledger, variantName, currentAssets = null) {
  const strictTrades = (Array.isArray(ledger?.strictTrades) ? ledger.strictTrades : [])
    .filter(trade => finiteNumber(trade?.profit) !== null && trade?.exitTime);
  const realizedProfit = strictTrades.reduce((sum, trade) => sum + Number(trade.profit), 0);
  const winningTrades = strictTrades.filter(trade => Number(trade.profit) > 0).length;
  const losingTrades = strictTrades.filter(trade => Number(trade.profit) < 0).length;
  const seed = finiteNumber(ledger?.baselineAssets);
  return {
    variantName,
    sessionId: ledger?.sessionId || null,
    active: ledger?.active === true,
    stopReason: ledger?.stopReason || null,
    startedAt: ledger?.startedAt || null,
    endedAt: ledger?.endedAt || null,
    closedTradeCount: strictTrades.length,
    winningTrades,
    losingTrades,
    realizedProfit,
    returnPercent: seed && seed > 0 && currentAssets !== null
      ? ((Number(currentAssets) / seed) - 1) * 100
      : null,
    currentAssets,
    openStrictPositions: Array.isArray(ledger?.strictOpenPositions)
      ? ledger.strictOpenPositions.length
      : 0,
    continuityEligible: ledger?.riskMonitor?.continuityEligible !== false &&
      ledger?.analysisDataHealth?.continuityEligible !== false
  };
}

