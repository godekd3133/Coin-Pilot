import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperExitPathReplay } from '../src/research/paperExitPathReplay.js';

function candle(at, { open = 100, high = 100.1, low = 99.9, close = 100 } = {}) {
  return {
    candle_date_time_utc: `2026-09-01T${at}:00`,
    opening_price: open,
    high_price: high,
    low_price: low,
    trade_price: close
  };
}

function ledger(trade = {}) {
  return {
    sessionId: 'paper-exit-path-test',
    active: true,
    configSnapshotComplete: true,
    configSnapshot: {
      tradingFee: 0.0005,
      slippage: 0.001,
      stopLossPercent: 1.2,
      takeProfitPercent: 1.8,
      maxHoldMinutes: 30
    },
    strictTrades: [{
      type: 'CLOSE',
      coin: 'KRW-XRP',
      entryTime: '2026-09-01T10:00:30.000Z',
      exitTime: '2026-09-01T10:03:30.000Z',
      entryPrice: 100,
      exitPrice: 100.1,
      amount: 10,
      profit: -0.0005,
      totalFee: 1.0005,
      signalKey: '2026-09-01T10:00:00',
      ...trade
    }]
  };
}

test('paper exit replay excludes entry/exit partial minutes and detects an interior target', () => {
  const report = buildPaperExitPathReplay({
    ledger: ledger(),
    candleResponses: [[
      candle('10:00', { high: 150, low: 50 }),
      candle('10:01'),
      candle('10:02', { high: 101, low: 99.5 }),
      candle('10:03', { high: 200, low: 1 })
    ]],
    takeProfitLevelsPercent: [0.5]
  });

  assert.equal(report.researchOnly, true);
  assert.equal(report.promoted, false);
  assert.equal(report.actualFillsObserved, false);
  assert.equal(report.thresholdSelectionBasis, 'exploratory_sensitivity_not_independent_holdout');
  assert.equal(report.coverage.completeTradeCount, 1);
  assert.equal(report.trades[0].coverage.expectedInteriorBarCount, 2);
  assert.deepEqual(report.trades[0].coverage.missingInteriorBars, []);
  assert.equal(report.scenarios[0].takeProfitExitCount, 1);
  assert.equal(report.trades[0].scenarios[0].exitReason, 'take_profit');
  assert.equal(report.trades[0].scenarios[0].exitBarStart, '2026-09-01T10:02:00Z');
  assert.ok(Math.abs(report.trades[0].scenarios[0].exitPrice - 100.5) < 1e-12);
});

test('same-minute stop and target ambiguity resolves conservatively to the stop', () => {
  const report = buildPaperExitPathReplay({
    ledger: ledger(),
    candleResponses: [[
      candle('10:00', { high: 150, low: 50 }),
      candle('10:01', { high: 101, low: 98 }),
      candle('10:02')
    ]],
    takeProfitLevelsPercent: [0.5]
  });

  assert.equal(report.trades[0].scenarios[0].exitReason, 'same_bar_stop_first');
  assert.equal(report.trades[0].scenarios[0].ambiguousBarCount, 1);
  assert.equal(report.trades[0].scenarios[0].exitPrice, 98.8);
});

test('missing interior minute bars exclude a trade instead of implying no threshold hit', () => {
  const report = buildPaperExitPathReplay({
    ledger: ledger(),
    candleResponses: [[candle('10:00'), candle('10:02')]],
    takeProfitLevelsPercent: [0.5]
  });

  assert.equal(report.coverage.completeTradeCount, 0);
  assert.equal(report.coverage.incompleteTradeCount, 1);
  assert.deepEqual(report.trades[0].coverage.missingInteriorBars, ['2026-09-01T10:01:00Z']);
  assert.equal(report.scenarios[0].coveredTradeCount, 0);
  assert.equal(report.scenarios[0].costAdjustedNetPnlKrw, null);
});

test('recorded-exit cost parity subtracts configured slippage once and preserves recorded fee', () => {
  const report = buildPaperExitPathReplay({
    ledger: ledger(),
    candleResponses: [[candle('10:00'), candle('10:01'), candle('10:02')]],
    takeProfitLevelsPercent: [1.8]
  });

  const trade = report.trades[0];
  assert.equal(trade.scenarios[0].exitReason, 'max_hold_recorded_exit');
  assert.ok(Math.abs(trade.recordedExitCostParityDeltaKrw) < 1e-10);
  assert.equal(trade.scenarios[0].modeledSlippageDragKrw, 2.001);
  assert.ok(Math.abs(trade.scenarios[0].costAdjustedNetPnlKrw - (-2.0015)) < 1e-10);
});

test('an incomplete config snapshot makes the research replay unavailable', () => {
  const incomplete = ledger();
  incomplete.configSnapshotComplete = false;
  const report = buildPaperExitPathReplay({
    ledger: incomplete,
    candleResponses: [[]]
  });

  assert.equal(report.available, false);
  assert.equal(report.reason, 'complete_cost_config_required');
  assert.equal(report.scenarios.length, 0);
});
