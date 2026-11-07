import express from 'express';
import { startOfKstDay, kstDateKey } from '../operatorAlertMonitor.js';
import { roundQuoteAmount } from '../manualOrderLegs.js';

// GET /api/scorecard — read-only "is it actually making money after costs?"
// read model for the home screen.
//
// Every number comes from the strategies' existing CLOSE / PARTIAL_CLOSE
// records. Their `profit` is already net of fees, and paper fills already
// carry the configured slippage (SCALP_PAPER_APPLY_COSTS), so nothing is
// re-costed here. The benchmark is "buy BTC at the period start and hold",
// read from Upbit daily candles. This route never mutates trader state.

export const MIN_TRADES_FOR_VERDICT = 100;
const Z_95 = 1.96;
const DAY_MS = 24 * 60 * 60 * 1000;
const BENCHMARK_MARKET = 'KRW-BTC';
const BENCHMARK_CACHE_MS = 10 * 60 * 1000;
const MAX_DAY_CANDLES = 200;
const RISK_PRICE_MAX_AGE_MS = 5 * 60 * 1000;

const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const toMs = value => {
  if (value instanceof Date) return value.getTime();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** Closed (fully or partially) trades across every strategy, oldest exit first. */
export function collectClosedTrades(strategies) {
  const trades = [];
  for (const [coin, strategy] of strategies?.entries?.() || []) {
    for (const trade of strategy?.tradeHistory || []) {
      if (trade?.action !== 'CLOSE' && trade?.action !== 'PARTIAL_CLOSE') continue;
      const profit = finite(trade.profit);
      const entryPrice = finite(trade.entryPrice);
      const amount = finite(trade.amount);
      const exitMs = toMs(trade.exitTime ?? trade.timestamp);
      if (profit === null || exitMs === null) continue;
      const cost = entryPrice !== null && amount !== null && entryPrice > 0 && amount > 0
        ? entryPrice * amount
        : null;
      const netReturnPercent = cost !== null ? (profit / cost) * 100 : finite(trade.profitPercent);
      const grossProfit = finite(trade.grossProfit);
      const exitPrice = finite(trade.exitPrice);
      const grossReturnPercent = cost !== null && grossProfit !== null
        ? (grossProfit / cost) * 100
        : entryPrice > 0 && exitPrice !== null ? ((exitPrice - entryPrice) / entryPrice) * 100 : null;
      trades.push({
        coin,
        entryMs: toMs(trade.entryTime),
        exitMs,
        profit,
        netReturnPercent,
        grossReturnPercent,
        // Paper fills opened under the slippage cost model carry its version.
        paperCostModeled: typeof trade.paperExecutionCostModel === 'string'
      });
    }
  }
  return trades.sort((a, b) => a.exitMs - b.exitMs);
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function sampleStdDev(values, average) {
  if (values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Sample statistics plus an honest verdict. Below MIN_TRADES_FOR_VERDICT, or
 * when the normal-approximation 95% interval of the mean per-trade net return
 * contains 0, the result cannot be told apart from luck.
 */
export function summarizeTrades(trades, { minTrades = MIN_TRADES_FOR_VERDICT } = {}) {
  const count = trades.length;
  const wins = trades.filter(trade => trade.profit > 0).length;
  const realizedNetProfit = trades.reduce((sum, trade) => sum + trade.profit, 0);
  const netReturns = trades.map(trade => trade.netReturnPercent).filter(value => value !== null);
  const grossReturns = trades.map(trade => trade.grossReturnPercent).filter(value => value !== null);
  const avgNet = mean(netReturns);
  const avgGross = mean(grossReturns);
  const stdDev = avgNet === null ? null : sampleStdDev(netReturns, avgNet);
  const halfWidth = stdDev === null ? null : Z_95 * stdDev / Math.sqrt(netReturns.length);
  const ci95 = halfWidth === null ? null : { low: avgNet - halfWidth, high: avgNet + halfWidth };
  const ciIncludesZero = ci95 === null ? null : ci95.low <= 0 && ci95.high >= 0;

  let verdict;
  if (count === 0) verdict = 'no_trades';
  else if (count < minTrades || ci95 === null) verdict = 'insufficient_sample';
  else if (ciIncludesZero) verdict = 'indistinguishable_from_luck';
  else verdict = avgNet > 0 ? 'positive_edge' : 'negative_edge';

  return {
    tradeCount: count,
    winCount: wins,
    winRatePercent: count ? (wins / count) * 100 : null,
    realizedNetProfit,
    avgNetReturnPercent: avgNet,
    avgGrossReturnPercent: avgGross,
    avgCostPercent: avgNet !== null && avgGross !== null && grossReturns.length === netReturns.length
      ? avgGross - avgNet
      : null,
    netReturnStdDevPercent: stdDev,
    ci95,
    ciIncludesZero,
    minTradesForVerdict: minTrades,
    verdict
  };
}

/** Upbit day candles (newest first) → buy-and-hold return from `startMs` to the latest candle. */
export function computeHoldBenchmark(candles, startMs) {
  if (!Array.isArray(candles) || candles.length === 0 || !Number.isFinite(startMs)) {
    return { available: false, reason: 'no_candles' };
  }
  const rows = candles
    .map(candle => ({
      startMs: toMs(candle?.candle_date_time_utc ? `${candle.candle_date_time_utc}Z` : null),
      open: finite(candle?.opening_price),
      close: finite(candle?.trade_price),
      lastTradeMs: finite(candle?.timestamp)
    }))
    .filter(row => row.startMs !== null && row.open > 0 && row.close > 0)
    .sort((a, b) => a.startMs - b.startMs);
  if (rows.length === 0) return { available: false, reason: 'no_candles' };
  const startRow = rows.find(row => startMs >= row.startMs && startMs < row.startMs + DAY_MS) || null;
  const coversFullPeriod = startRow !== null;
  // Without a candle containing the start (period longer than the fetched
  // window), compare from the oldest candle and say so.
  const first = startRow || rows[0];
  const last = rows[rows.length - 1];
  return {
    available: true,
    market: BENCHMARK_MARKET,
    startAt: iso(first.startMs),
    startPrice: first.open,
    endAt: iso(last.lastTradeMs ?? last.startMs),
    endPrice: last.close,
    returnPercent: ((last.close / first.open) - 1) * 100,
    coversFullPeriod
  };
}

/** Open strategy positions with the exits the risk monitor will enforce. */
export function describeOpenPositions(tradingSystem, nowMs) {
  const positions = [];
  const riskPrices = tradingSystem?.lastRiskPrices;
  const pricesFresh = riskPrices && Number.isFinite(riskPrices.at) && nowMs - riskPrices.at <= RISK_PRICE_MAX_AGE_MS;
  for (const [coin, strategy] of tradingSystem?.strategies?.entries?.() || []) {
    const position = strategy?.currentPosition;
    if (!position) continue;
    const entryPrice = finite(position.entryPrice);
    const amount = finite(position.amount);
    const entryMs = toMs(position.entryTime);
    const stopLossPercent = finite(strategy.config?.stopLossPercent);
    const takeProfitPercent = finite(strategy.config?.takeProfitPercent);
    const maxHoldMs = finite(strategy.maxHoldMs) ??
      (finite(strategy.config?.maxHoldMinutes) !== null ? finite(strategy.config.maxHoldMinutes) * 60000 : null);
    const losingHoldMs = finite(strategy.maxLosingHoldMs);
    const winnerExtendMs = position.winnerExtended === true ? finite(strategy.winnerExtendMs) ?? 0 : 0;
    const lastPrice = pricesFresh ? finite(riskPrices.prices?.get?.(coin)) : null;
    positions.push({
      coin,
      entryPrice,
      amount,
      entryTime: iso(entryMs),
      stopLossPrice: entryPrice > 0 && stopLossPercent !== null ? entryPrice * (1 - stopLossPercent / 100) : null,
      stopLossPercent,
      takeProfitPrice: entryPrice > 0 && takeProfitPercent !== null ? entryPrice * (1 + takeProfitPercent / 100) : null,
      takeProfitPercent,
      protectiveStopArmed: position.breakEvenArmed === true || position.trailingArmed === true,
      maxHoldExitAt: entryMs !== null && maxHoldMs > 0 ? iso(entryMs + maxHoldMs + winnerExtendMs) : null,
      losingHoldExitAt: entryMs !== null && losingHoldMs > 0 ? iso(entryMs + losingHoldMs) : null,
      lastPrice,
      lastPriceAt: lastPrice !== null ? iso(riskPrices.at) : null,
      unrealizedReturnPercent: lastPrice !== null && entryPrice > 0 ? ((lastPrice / entryPrice) - 1) * 100 : null
    });
  }
  return positions.sort((a, b) => (Date.parse(a.entryTime) || 0) - (Date.parse(b.entryTime) || 0));
}

function costModel(tradingSystem, trades = []) {
  const feeRate = finite(tradingSystem?.config?.tradingFee ?? tradingSystem?.strategyConfig?.tradingFee) ?? 0.0005;
  if (tradingSystem?.dryRun !== true) {
    return { source: 'exchange_fills', feeRate, slippageRate: null, slippageBooked: true };
  }
  const paperCosts = typeof tradingSystem.getStrictPaperExecutionCostModel === 'function'
    ? tradingSystem.getStrictPaperExecutionCostModel()
    : null;
  return {
    source: 'paper_model',
    feeRate: finite(paperCosts?.tradingFeeRate) ?? feeRate,
    slippageRate: finite(paperCosts?.slippageRate),
    slippageBooked: paperCosts !== null,
    // Closed paper trades whose entry predates the slippage model: fees only.
    unmodeledTradeCount: trades.filter(trade => !trade.paperCostModeled).length
  };
}

export default function createScorecardRoutes(server, {
  now = () => Date.now(),
  fetchDayCandles = (market, count) => server.tradingSystem?.upbit?.getDayCandles?.(market, count)
} = {}) {
  const router = express.Router();
  let benchmarkCache = null;

  async function loadBenchmark(startMs, nowMs) {
    if ((server.tradingSystem?.exchange || 'upbit') !== 'upbit') {
      return { available: false, reason: 'exchange_not_supported' };
    }
    const days = Math.ceil((nowMs - startOfKstDay(startMs)) / DAY_MS) + 1;
    const count = Math.min(MAX_DAY_CANDLES, Math.max(2, days + 1));
    const key = `${kstDateKey(startMs)}|${count}`;
    if (benchmarkCache && benchmarkCache.key === key && nowMs - benchmarkCache.at < BENCHMARK_CACHE_MS) {
      return benchmarkCache.value;
    }
    try {
      const candles = await fetchDayCandles(BENCHMARK_MARKET, count);
      const value = computeHoldBenchmark(candles, startMs);
      if (value.available) benchmarkCache = { key, at: nowMs, value };
      return value;
    } catch (error) {
      server.logApiError?.('/api/scorecard/benchmark', error);
      return { available: false, reason: 'fetch_failed' };
    }
  }

  router.get('/scorecard', async (req, res) => {
    try {
      const trader = server.tradingSystem;
      const nowMs = now();
      const checkIntervalMs = finite(trader?.config?.checkInterval);
      const engine = {
        checkIntervalMs,
        stallAfterSeconds: Math.max(120, Math.round(((checkIntervalMs ?? 5000) * 6) / 1000))
      };
      if (trader?.readOnlyObserver === true) {
        return res.json({ available: false, reason: 'read_only_observer', engine, generatedAt: iso(nowMs) });
      }

      const trades = collectClosedTrades(trader?.strategies);
      const summary = summarizeTrades(trades);
      const firstEntry = trades.reduce((min, trade) => {
        const start = trade.entryMs ?? trade.exitMs;
        return start < min ? start : min;
      }, Infinity);
      const periodStartMs = Number.isFinite(firstEntry) ? firstEntry : null;
      const todayStart = startOfKstDay(nowMs);
      const todayTrades = trades.filter(trade => trade.exitMs >= todayStart);

      const seed = finite(trader?.initialSeedMoney);
      const benchmark = periodStartMs === null
        ? { available: false, reason: 'no_trades' }
        : await loadBenchmark(periodStartMs, nowMs);
      const strategyReturnOnSeedPercent = seed > 0 ? (summary.realizedNetProfit / seed) * 100 : null;
      const comparison = benchmark.available && seed > 0
        ? {
          seed,
          strategyReturnOnSeedPercent,
          holdReturnPercent: benchmark.returnPercent,
          holdProfit: roundQuoteAmount(trader, seed * benchmark.returnPercent / 100),
          excessReturnPercent: strategyReturnOnSeedPercent - benchmark.returnPercent
        }
        : null;

      res.json({
        available: true,
        mode: trader?.dryRun ? 'DRY_RUN' : 'LIVE',
        generatedAt: iso(nowMs),
        periodStartAt: iso(periodStartMs),
        periodEndAt: iso(nowMs),
        costs: costModel(trader, trades),
        ...summary,
        realizedNetProfit: roundQuoteAmount(trader, summary.realizedNetProfit),
        today: {
          date: kstDateKey(nowMs),
          tradeCount: todayTrades.length,
          realizedNetProfit: roundQuoteAmount(trader, todayTrades.reduce((sum, trade) => sum + trade.profit, 0))
        },
        benchmark,
        comparison,
        openPositions: describeOpenPositions(trader, nowMs),
        engine
      });
    } catch (error) {
      server.logApiError?.('/api/scorecard', error);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}
