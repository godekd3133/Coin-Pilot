import test from 'node:test';
import assert from 'node:assert/strict';
import RegimeMomentumStrategy from '../src/strategy/regimeMomentumStrategy.js';

function makeCandles(closes, unitMinutes = 60, endIso = '2026-09-13T00:00:00') {
  const end = Date.parse(endIso + 'Z');
  return closes.map((c, i) => ({
    candle_date_time_utc: new Date(end - (closes.length - 1 - i) * unitMinutes * 60000).toISOString().slice(0, 19),
    opening_price: c,
    high_price: c * 1.001,
    low_price: c * 0.999,
    trade_price: c,
    candle_acc_trade_volume: 1
  }));
}

// Build a series: flat for lookback, then steady uptrend with pullbacks so
// RSI oscillates; enough bars for 7d lookback (168) + rsi warmup.
function trendingSeries({ n = 400, start = 100, step = 0.002, pullbackEvery = 0, pullback = 0.01 } = {}) {
  const closes = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p = pullbackEvery && i % pullbackEvery === pullbackEvery - 1 ? p * (1 - pullback) : p * (1 + step);
    closes.push(p);
  }
  return closes;
}

test('regime momentum fires only on RSI>=65 + up bar + positive 7d trend', () => {
  const s = new RegimeMomentumStrategy();
  const candles = makeCandles(trendingSeries());
  const r = s.analyze(candles);
  assert.equal(r.signal, 'BUY');
  assert.ok(r.rsi >= 65, `rsi=${r.rsi}`);
  assert.ok(r.trendPercent > 0);
  assert.ok(r.signalKey);
});

test('trend gate blocks identical RSI strength when 7d trend is negative', () => {
  const s = new RegimeMomentumStrategy();
  // decline for the lookback window, then a sharp recent bounce so the last
  // bar is up and RSI high, while the 7d return is still negative.
  const closes = [];
  let p = 100;
  for (let i = 0; i < 344; i++) { p *= 0.998; closes.push(p); }   // long bleed ~-50%
  for (let i = 0; i < 8; i++) { p *= 1.03; closes.push(p); }      // brief hard bounce < 7d window
  const r = s.analyze(makeCandles(closes));
  assert.equal(r.signal, null);
  assert.equal(r.reason, 'trend_gate_blocked');
  assert.ok(r.trendPercent <= 0);
});

test('down bar blocks entry even with high RSI and positive trend', () => {
  const s = new RegimeMomentumStrategy();
  const closes = trendingSeries({ pullbackEvery: 0 });
  closes[closes.length - 1] = closes[closes.length - 2] * 0.995; // last bar down
  const r = s.analyze(makeCandles(closes));
  assert.equal(r.signal, null);
  assert.equal(r.reason, 'bar_not_up');
});

test('minUpBars=2 requires two consecutive completed up bars', () => {
  const closes = trendingSeries();
  closes[closes.length - 2] = closes[closes.length - 3] * 0.995;
  closes[closes.length - 1] = closes[closes.length - 2] * 1.01;
  const oneBar = new RegimeMomentumStrategy({ minUpBars: 1 });
  const twoBars = new RegimeMomentumStrategy({ minUpBars: 2 });

  assert.equal(oneBar.analyze(makeCandles(closes)).signal, 'BUY');
  assert.equal(twoBars.analyze(makeCandles(closes)).signal, null);
  assert.equal(twoBars.analyze(makeCandles(closes)).reason, 'bar_not_up');
});

test('duplicate signal key is rejected until consumed candle changes', () => {
  const s = new RegimeMomentumStrategy();
  const candles = makeCandles(trendingSeries());
  const first = s.analyze(candles);
  assert.equal(first.signal, 'BUY');
  s.consumeSignal(first.signalKey);
  const again = s.analyze(candles);
  assert.equal(again.signal, null);
  assert.equal(again.reason, 'duplicate_signal');
});

test('insufficient history fails closed', () => {
  const s = new RegimeMomentumStrategy();
  const r = s.analyze(makeCandles([1, 2, 3]));
  assert.equal(r.signal, null);
  assert.equal(r.reason, 'insufficient_candles');
});

test('position exits honor stop-loss, take-profit, and max-hold', () => {
  const s = new RegimeMomentumStrategy({ stopLossPercent: 4, takeProfitPercent: 8, maxHoldHours: 48 });
  const entry = { entryPrice: 100, entryTimeMs: 1_000_000 };
  assert.equal(s.checkPosition(entry, 95.5, entry.entryTimeMs + 1000).exit, 'STOP_LOSS');
  assert.equal(s.checkPosition(entry, 109, entry.entryTimeMs + 1000).exit, 'TAKE_PROFIT');
  assert.equal(s.checkPosition(entry, 102, entry.entryTimeMs + 48 * 3600 * 1000 + 1).exit, 'MAX_HOLD');
  assert.equal(s.checkPosition(entry, 102, entry.entryTimeMs + 1000).exit, null);
});

test('disabled protections keep the fixed max-hold contract', () => {
  const s = new RegimeMomentumStrategy({ stopLossPercent: 0, takeProfitPercent: 0, maxHoldHours: 48 });
  const entry = { entryPrice: 100, entryTimeMs: 0 };
  assert.equal(s.checkPosition(entry, 50, 1000).exit, null);        // no SL
  assert.equal(s.checkPosition(entry, 200, 1000).exit, null);       // no TP
  assert.equal(s.checkPosition(entry, 50, 48 * 3600 * 1000).exit, 'MAX_HOLD');
});
