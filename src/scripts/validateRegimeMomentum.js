import dotenv from 'dotenv';
import fs from 'node:fs';
import RegimeMomentumStrategy from '../strategy/regimeMomentumStrategy.js';
import {
  analyzeHistoricalCandleContinuity,
  splitHistoricalCandleSegments,
  calculateTradeReturnConfidence,
  evaluateStatisticalConfidenceGate
} from '../backtest/scalpingBacktest.js';
import { aggregateHigherTimeframeCandles } from '../research/higherTimeframeMomentum.js';

/**
 * Research-only validation lane for the regime-gated momentum candidate.
 *
 * Contract under test (see src/strategy/regimeMomentumStrategy.js):
 *   completed `signalUnit` candles; BUY when RSI(14) >= rsiEntryThreshold AND
 *   the latest bar closed up AND the trailing trendLookbackHours return > 0.
 *   One open position per market; exits = optional stop/take, else maxHoldHours.
 *
 * Hard rules:
 *   - REGIME_CANDLES_FILE is required and must contain every selected market.
 *     This lane never fetches a network window; missing data fails closed.
 *   - Source-candle continuity is checked per market; gapped series are
 *     excluded rather than replayed as if adjacent rows were adjacent time.
 *   - promoted is always false. This report is diagnostic evidence only and
 *     can never authorize live orders.
 *
 * Usage:
 *   REGIME_CANDLES_FILE=/tmp/cache.json node src/scripts/validateRegimeMomentum.js
 */
dotenv.config();

const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const CONFIG = {
  cacheFile: process.env.REGIME_CANDLES_FILE || '',
  markets: (process.env.REGIME_MARKETS || 'KRW-BTC,KRW-ETH,KRW-XRP,KRW-SOL')
    .split(',').map((m) => m.trim()).filter(Boolean),
  sourceUnitMinutes: number(process.env.REGIME_SOURCE_UNIT_MINUTES, 15),
  signalUnitMinutes: number(process.env.REGIME_SIGNAL_UNIT_MINUTES, 60),
  rsiPeriod: number(process.env.REGIME_RSI_PERIOD, 14),
  rsiEntryThreshold: number(process.env.REGIME_RSI_THRESHOLD, 65),
  trendLookbackHours: number(process.env.REGIME_TREND_LOOKBACK_HOURS, 168),
  requireUpBar: process.env.REGIME_REQUIRE_UP_BAR !== 'false',
  maxHoldHours: number(process.env.REGIME_MAX_HOLD_HOURS, 48),
  stopLossPercent: number(process.env.REGIME_STOP_LOSS_PERCENT, 0),
  takeProfitPercent: number(process.env.REGIME_TAKE_PROFIT_PERCENT, 0),
  maxPositions: number(process.env.REGIME_MAX_POSITIONS, 4),
  positionFraction: number(process.env.REGIME_POSITION_FRACTION, 0.25),
  initialBalance: number(process.env.REGIME_INITIAL_BALANCE, 100_000_000),
  costPercent: number(process.env.REGIME_COST_PERCENT, 0.2),
  trainFraction: Math.min(0.9, Math.max(0.1, number(process.env.REGIME_TRAIN_FRACTION, 0.6))),
  reportFile: process.env.REGIME_REPORT_FILE || '',
  maxGapIntervals: number(process.env.REGIME_MAX_GAP_INTERVALS, 1.5)
};

function resampleCandles(candles, unitMinutes) {
  const aggregation = aggregateHigherTimeframeCandles(candles, {
    baseCandleUnit: CONFIG.sourceUnitMinutes,
    timeframeMinutes: unitMinutes,
    requireHistoricalCandleContinuity: true
  });
  if (!aggregation.dataQuality.valid) return [];
  return aggregation.candles.map(candle => ({
    ...candle,
    ts: candle.candle_date_time_utc,
    v: candle.candle_acc_trade_volume
  }));
}

function summarize(trades) {
  const net = trades.map((t) => t.profitPercent);
  const wins = net.filter((p) => p > 0);
  const losses = net.filter((p) => p < 0);
  const total = net.reduce((a, b) => a + b, 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const confidence = calculateTradeReturnConfidence(
    trades.map((trade) => ({ ...trade, type: 'CLOSE' }))
  );
  return {
    tradeCount: net.length,
    totalReturnPercent: Number(total.toFixed(4)),
    avgReturnPercent: net.length ? Number((total / net.length).toFixed(4)) : 0,
    winRate: net.length ? Number(((wins.length / net.length) * 100).toFixed(1)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(3)) : (grossWin > 0 ? null : 0),
    confidence,
    tradeReturnConfidence: confidence
  };
}

function simulateMarket(bars, rangeStart, rangeEnd, openPos) {
  const strategy = new RegimeMomentumStrategy({
    candleUnitMinutes: CONFIG.signalUnitMinutes,
    rsiPeriod: CONFIG.rsiPeriod,
    rsiEntryThreshold: CONFIG.rsiEntryThreshold,
    trendLookbackHours: CONFIG.trendLookbackHours,
    requireUpBar: CONFIG.requireUpBar,
    maxHoldHours: CONFIG.maxHoldHours,
    stopLossPercent: CONFIG.stopLossPercent,
    takeProfitPercent: CONFIG.takeProfitPercent
  });
  const trades = [];
  for (let i = rangeStart; i < rangeEnd; i++) {
    const nowMs = Date.parse(bars[i].ts);
    if (openPos) {
      const ex = strategy.checkPosition(openPos, bars[i].trade_price, nowMs);
      if (ex.exit) {
        trades.push({ exit: ex.exit, profitPercent: ex.profitPercent - CONFIG.costPercent, entryTs: openPos.entryTs });
        openPos = null;
      }
      continue;
    }
    const r = strategy.analyze(bars.slice(0, i + 1), nowMs);
    if (r.signal === 'BUY') {
      openPos = { entryPrice: r.referencePrice, entryTimeMs: nowMs, entryTs: bars[i].ts };
      strategy.consumeSignal(r.signalKey);
    }
  }
  return { trades, openPos };
}

function simulatePortfolio(segmentsByMarket) {
  // Shared-balance chronological replay. Positions may not span a segment
  // gap: a position still open at its segment's last bar is marked unknown
  // and excluded from realized metrics.
  const strategies = {};
  const merged = [];
  for (const [market, segs] of Object.entries(segmentsByMarket)) {
    strategies[market] = new RegimeMomentumStrategy({
      candleUnitMinutes: CONFIG.signalUnitMinutes,
      rsiPeriod: CONFIG.rsiPeriod,
      rsiEntryThreshold: CONFIG.rsiEntryThreshold,
      trendLookbackHours: CONFIG.trendLookbackHours,
      maxHoldHours: CONFIG.maxHoldHours,
      stopLossPercent: CONFIG.stopLossPercent,
      takeProfitPercent: CONFIG.takeProfitPercent
    });
    segs.forEach((bars, seg) => {
      for (let i = 0; i < bars.length; i++) merged.push({ market, seg, i, ts: bars[i].ts, last: i === bars.length - 1 });
    });
  }
  merged.sort((a, b) => a.ts.localeCompare(b.ts));

  let balance = CONFIG.initialBalance;
  const open = {};
  const trades = [];
  const equity = [];
  let blocked = 0;
  let unknownBoundary = 0;

  for (const ev of merged) {
    const bars = segmentsByMarket[ev.market][ev.seg];
    const bar = bars[ev.i];
    const nowMs = Date.parse(ev.ts);
    const pos = open[ev.market];
    if (pos && pos.seg !== ev.seg) {
      // Defensive: a position from an older segment should already have been
      // resolved at that segment's final bar; never leak its capital.
      unknownBoundary++;
      balance += pos.size;
      delete open[ev.market];
    }
    if (open[ev.market]) {
      const ex = strategies[ev.market].checkPosition(open[ev.market], bar.trade_price, nowMs);
      if (ex.exit) {
        balance += open[ev.market].size * (1 + ex.profitPercent / 100 - CONFIG.costPercent / 100);
        trades.push({ market: ev.market, exit: ex.exit, profitPercent: ex.profitPercent - CONFIG.costPercent });
        delete open[ev.market];
      } else if (ev.last) {
        // Segment boundary: return capital marked to the last observed close,
        // but exclude the position from realized metrics as unknown.
        unknownBoundary++;
        balance += open[ev.market].size * (1 + (bar.trade_price - open[ev.market].entryPrice) / open[ev.market].entryPrice);
        delete open[ev.market];
      }
      continue;
    }
    if (ev.last) continue; // never open on a segment's final bar
    if (Object.keys(open).length >= CONFIG.maxPositions) { blocked++; continue; }
    const r = strategies[ev.market].analyze(bars.slice(0, ev.i + 1), nowMs);
    if (r.signal === 'BUY') {
      const size = balance * CONFIG.positionFraction;
      balance -= size;
      open[ev.market] = { entryPrice: r.referencePrice, entryTimeMs: nowMs, size, seg: ev.seg };
      strategies[ev.market].consumeSignal(r.signalKey);
    }
    let eq = balance;
    for (const [m, p] of Object.entries(open)) {
      const b2 = segmentsByMarket[m][p.seg];
      const idx = Math.min(ev.i, b2.length - 1);
      eq += p.size * (1 + (b2[idx].trade_price - p.entryPrice) / p.entryPrice);
    }
    equity.push(eq);
  }
  let peak = CONFIG.initialBalance;
  let maxDD = 0;
  for (const e of equity) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, (peak - e) / peak * 100); }
  return {
    ...summarize(trades),
    portfolioReturnPercent: Number(((balance / CONFIG.initialBalance - 1) * 100).toFixed(4)),
    maxDrawdownPercent: Number(maxDD.toFixed(4)),
    blockedSignals: blocked,
    unknownBoundaryPositions: unknownBoundary
  };
}

function main() {
  if (!CONFIG.cacheFile || !fs.existsSync(CONFIG.cacheFile)) {
    console.error('FAIL_CLOSED: REGIME_CANDLES_FILE is required and must exist.');
    process.exit(2);
  }
  const cache = JSON.parse(fs.readFileSync(CONFIG.cacheFile, 'utf8'));
  const missing = CONFIG.markets.filter((m) => !Array.isArray(cache[m]) || cache[m].length === 0);
  if (missing.length) {
    console.error(`FAIL_CLOSED: cache is missing markets: ${missing.join(', ')}`);
    process.exit(2);
  }

  const report = {
    diagnosticOnly: true,
    promoted: false,
    candleSource: 'cache',
    cacheFile: CONFIG.cacheFile,
    contract: {
      signalUnitMinutes: CONFIG.signalUnitMinutes,
      rsiEntryThreshold: CONFIG.rsiEntryThreshold,
      trendLookbackHours: CONFIG.trendLookbackHours,
      requireUpBar: CONFIG.requireUpBar,
      maxHoldHours: CONFIG.maxHoldHours,
      stopLossPercent: CONFIG.stopLossPercent,
      takeProfitPercent: CONFIG.takeProfitPercent,
      costPercent: CONFIG.costPercent,
      maxPositions: CONFIG.maxPositions
    },
    dataQuality: {},
    markets: {},
    portfolio: null
  };

  const barsByMarket = {};
  const segmentsByMarket = {};
  for (const market of CONFIG.markets) {
    const split = splitHistoricalCandleSegments(cache[market], CONFIG.sourceUnitMinutes, {
      maxGapSeconds: CONFIG.sourceUnitMinutes * 60 * CONFIG.maxGapIntervals,
      minimumSegmentCandles: 200
    });
    const segList = split?.segments || [];
    report.dataQuality[market] = {
      candleCount: cache[market].length,
      segments: segList.length,
      excludedSegments: split?.excludedSegments?.length || 0,
      gaps: split?.dataQuality?.gapCount ?? Math.max(0, segList.length - 1)
    };
    const barsSegments = [];
    for (const seg of segList) {
      const bars = resampleCandles(seg.candles || seg, CONFIG.signalUnitMinutes);
      if (bars.length >= 400) barsSegments.push(bars);
    }
    if (!barsSegments.length) {
      report.dataQuality[market].excluded = 'no_contiguous_segment';
      continue;
    }
    segmentsByMarket[market] = barsSegments;
    barsByMarket[market] = barsSegments.flat();
  }

  // Global chronological cut for train/holdout classification.
  const allTs = Object.values(barsByMarket).flat().map((b) => b.ts).sort();
  const cutTs = allTs[Math.floor(allTs.length * CONFIG.trainFraction)];

  for (const [market, barsSegments] of Object.entries(segmentsByMarket)) {
    const train = [];
    const holdout = [];
    let unknownBoundary = 0;
    for (const bars of barsSegments) {
      const { trades, openPos } = simulateMarket(bars, 0, bars.length, null);
      if (openPos) unknownBoundary++;
      for (const t of trades) (t.entryTs < cutTs ? train : holdout).push(t);
    }
    report.dataQuality[market].unknownBoundaryPositions = unknownBoundary;
    const trainingSummary = summarize(train);
    const holdoutSummary = summarize(holdout);
    report.markets[market] = {
      segments: barsSegments.length,
      training: trainingSummary,
      holdout: holdoutSummary
    };
    report.markets[market].holdout.confidenceGate = evaluateStatisticalConfidenceGate(
      { tradeReturnConfidence: holdoutSummary.tradeReturnConfidence },
      {
        required: true,
        minimumTrades: 20,
        minimumLowerBoundPercent: 0
      }
    );
  }

  if (Object.keys(segmentsByMarket).length) {
    report.portfolio = simulatePortfolio(segmentsByMarket);
  }

  const out = JSON.stringify(report, null, 2);
  if (CONFIG.reportFile) fs.writeFileSync(CONFIG.reportFile, out);
  console.log(out);
}

main();
