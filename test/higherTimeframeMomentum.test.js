import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateHigherTimeframeCandles,
  calculateHigherTimeframeMomentumSignals,
  simulateHigherTimeframeMomentum,
  simulateHigherTimeframeMomentumPortfolio,
  walkForwardValidateHigherTimeframeMomentum
} from '../src/research/higherTimeframeMomentum.js';

function baseCandle(index, open, close, high = Math.max(open, close), low = Math.min(open, close)) {
  return {
    candle_date_time_utc: new Date(Date.UTC(2026, 0, 1, 0, index * 15)).toISOString(),
    opening_price: open,
    high_price: high,
    low_price: low,
    trade_price: close,
    candle_acc_trade_volume: 100
  };
}

function syntheticMomentumCandles(barCount = 24) {
  const candles = [];
  for (let bar = 0; bar < barCount; bar += 1) {
    const barOpen = 100 + bar;
    const barClose = barOpen + 0.5;
    for (let part = 0; part < 4; part += 1) {
      const open = barOpen + (part * 0.125);
      const close = part === 3 ? barClose : open + 0.125;
      candles.push(baseCandle(
        bar * 4 + part,
        open,
        close,
        close + 0.1,
        open - 0.1
      ));
    }
  }
  return candles;
}

test('higher timeframe aggregation keeps complete OHLCV groups and source bounds', () => {
  const raw = syntheticMomentumCandles(5);
  const result = aggregateHigherTimeframeCandles(raw, {
    baseCandleUnit: 15,
    timeframeMinutes: 60
  });

  assert.equal(result.dataQuality.valid, true);
  assert.equal(result.ratio, 4);
  assert.equal(result.candles.length, 5);
  assert.equal(result.candles[0].opening_price, raw[0].opening_price);
  assert.equal(result.candles[0].trade_price, raw[3].trade_price);
  assert.equal(result.candles[0].sourceStartIndex, 0);
  assert.equal(result.candles[0].sourceEndIndex, 3);
  assert.equal(result.candles[0].candle_acc_trade_volume, 400);
});

test('higher timeframe signal enters only after the completed aggregated candle', () => {
  const raw = syntheticMomentumCandles();
  const result = calculateHigherTimeframeMomentumSignals(raw, {
    baseCandleUnit: 15,
    timeframeMinutes: 60,
    rsiPeriod: 3,
    minRsi: 60,
    trendLookbackMinutes: 4 * 60,
    minTrendReturnPercent: 0
  });

  assert.equal(result.available, true);
  assert.ok(result.signals.length > 0);
  const signal = result.signals[0];
  const aggregate = result.aggregation.candles[signal.higherIndex];
  assert.ok(signal.entryIndex > aggregate.sourceEndIndex);
  assert.equal(signal.entryIndex, aggregate.sourceEndIndex + 1);
  assert.equal(signal.signalTimestamp, aggregate.candle_end_time_utc);
  assert.equal(signal.entryTimestamp, raw[signal.entryIndex].candle_date_time_utc);
  assert.ok(signal.rsi >= 60);
  assert.ok(signal.trendReturnPercent >= 0);
});

test('higher timeframe simulator applies fees, slippage, and conservative exits', () => {
  const result = simulateHigherTimeframeMomentum(syntheticMomentumCandles(), {
    baseCandleUnit: 15,
    timeframeMinutes: 60,
    rsiPeriod: 3,
    minRsi: 60,
    trendLookbackMinutes: 4 * 60,
    minTrendReturnPercent: 0,
    investmentRatio: 0.1,
    tradingFee: 0.001,
    slippage: 0,
    stopLossPercent: 1,
    takeProfitPercent: 1,
    maxHoldMinutes: 120
  });

  assert.equal(result.available, true);
  assert.ok(result.metrics.signals > 0);
  assert.ok(result.metrics.tradeCount > 0);
  assert.ok(result.metrics.fees > 0);
  assert.ok(result.trades.some(trade => trade.type === 'CLOSE'));
  assert.equal(result.promotion, 'diagnostic_only_never_authorizes_live_orders');
});

test('zero stop and take values stay disabled for fixed-hold diagnostics', () => {
  const result = simulateHigherTimeframeMomentum(syntheticMomentumCandles(), {
    baseCandleUnit: 15,
    timeframeMinutes: 60,
    rsiPeriod: 3,
    minRsi: 60,
    trendLookbackMinutes: 4 * 60,
    minTrendReturnPercent: 0,
    investmentRatio: 0.1,
    tradingFee: 0,
    slippage: 0,
    stopLossPercent: 0,
    takeProfitPercent: 0,
    maxHoldMinutes: 60
  });

  const closes = result.trades.filter(trade => trade.type === 'CLOSE');
  assert.ok(closes.length > 0);
  assert.equal(closes[0].reason, 'MAX_HOLD_TIME');
});

test('portfolio replay shares balance and blocks correlated entries at max positions', () => {
  const candles = syntheticMomentumCandles(24);
  const result = simulateHigherTimeframeMomentumPortfolio({
    'KRW-BTC': candles,
    'KRW-ETH': candles.map(candle => ({ ...candle }))
  }, {
    baseCandleUnit: 15,
    timeframeMinutes: 60,
    rsiPeriod: 3,
    minRsi: 60,
    trendLookbackMinutes: 4 * 60,
    minTrendReturnPercent: 0,
    initialBalance: 1_000_000,
    tradingFee: 0.001,
    slippage: 0,
    stopLossPercent: 0,
    takeProfitPercent: 0,
    maxHoldMinutes: 10_000,
    maxPositions: 1,
    portfolioPositionFraction: 0.5
  });

  assert.equal(result.available, true);
  assert.equal(result.dataQuality.gridAligned, true);
  assert.equal(result.entryCount, 1);
  assert.ok(result.blockedEntryCount > 0);
  assert.equal(result.openPositions.length, 1);
  assert.ok(result.metrics.fees > 0);
  assert.equal(result.promotion, 'diagnostic_only_never_authorizes_live_orders');
});

test('portfolio replay refuses markets with different base candle grids', () => {
  const btc = syntheticMomentumCandles(24);
  const eth = syntheticMomentumCandles(24).slice(1);
  const result = simulateHigherTimeframeMomentumPortfolio({
    'KRW-BTC': btc,
    'KRW-ETH': eth
  }, {
    baseCandleUnit: 15,
    timeframeMinutes: 60,
    rsiPeriod: 3,
    minRsi: 60,
    trendLookbackMinutes: 4 * 60
  });

  assert.equal(result.available, false);
  assert.equal(result.dataQuality.reason, 'portfolio_candle_count_mismatch');
  assert.equal(result.metrics.tradeCount, 0);
});

test('higher timeframe continuity failure is fail-closed', () => {
  const raw = syntheticMomentumCandles();
  raw[20].candle_date_time_utc = new Date(Date.UTC(2026, 0, 1, 6, 0)).toISOString();
  const result = simulateHigherTimeframeMomentum(raw, {
    baseCandleUnit: 15,
    timeframeMinutes: 60,
    rsiPeriod: 3
  });

  assert.equal(result.available, false);
  assert.equal(result.metrics.tradeCount, 0);
  assert.equal(result.dataQuality.valid, false);
});

test('higher timeframe walk-forward requires every validation fold and stays diagnostic-only', () => {
  const result = walkForwardValidateHigherTimeframeMomentum(syntheticMomentumCandles(40), {
    baseCandleUnit: 15,
    timeframeMinutes: 60,
    rsiPeriod: 3,
    minRsi: 60,
    trendLookbackMinutes: 4 * 60,
    minTrendReturnPercent: 0,
    investmentRatio: 0.1,
    stopLossPercent: 1,
    takeProfitPercent: 1,
    maxHoldMinutes: 120
  }, {
    folds: 3,
    minimumTrainingTrades: 0,
    minimumValidationTrades: 1,
    minimumProfitFactor: 0,
    minimumReturnPercent: -100,
    minimumConfidenceLowerBoundPercent: -100
  });

  assert.equal(result.foldCount, 3);
  assert.equal(result.promoted, false);
  assert.equal(result.promotionReason, 'higher_timeframe_momentum_is_research_only_and_not_wired_to_live_gate');
});
