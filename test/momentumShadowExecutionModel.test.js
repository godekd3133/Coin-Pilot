import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOMENTUM_SHADOW_EXECUTION_MODEL_CANDLE_CLOSE,
  MOMENTUM_SHADOW_EXECUTION_MODEL_QUOTE_CROSS,
  projectMomentumShadowExecutionPrice,
  resolveMomentumShadowExecutionModel
} from '../src/research/momentumShadowExecutionModel.js';

const quote = {
  available: true,
  bidPrice: 99,
  askPrice: 101,
  timestamp: 1_700_000_000_000
};

test('execution model defaults to the existing candle-close contract', () => {
  assert.equal(resolveMomentumShadowExecutionModel(), MOMENTUM_SHADOW_EXECUTION_MODEL_CANDLE_CLOSE);
  assert.equal(resolveMomentumShadowExecutionModel('unknown'), MOMENTUM_SHADOW_EXECUTION_MODEL_CANDLE_CLOSE);
  assert.deepEqual(
    projectMomentumShadowExecutionPrice({ candlePrice: 100 }),
    {
      available: true,
      model: MOMENTUM_SHADOW_EXECUTION_MODEL_CANDLE_CLOSE,
      side: 'entry',
      price: 100,
      source: 'candle_close',
      quoteTimestamp: null,
      reason: 'candle_close'
    }
  );
});

test('quote-cross model buys at ask and exits or marks at bid', () => {
  assert.equal(resolveMomentumShadowExecutionModel('quote_cross'), MOMENTUM_SHADOW_EXECUTION_MODEL_QUOTE_CROSS);
  const entry = projectMomentumShadowExecutionPrice({
    model: 'quote_cross',
    side: 'entry',
    candlePrice: 100,
    quote
  });
  const exit = projectMomentumShadowExecutionPrice({
    model: 'quote_cross',
    side: 'exit',
    candlePrice: 100,
    quote
  });
  const mark = projectMomentumShadowExecutionPrice({
    model: 'quote_cross',
    side: 'mark',
    candlePrice: 100,
    quote
  });

  assert.equal(entry.price, 101);
  assert.equal(entry.source, 'best_ask');
  assert.equal(entry.reason, 'best_ask_crossing_model');
  assert.equal(exit.price, 99);
  assert.equal(exit.source, 'best_bid');
  assert.equal(mark.price, 99);
  assert.equal(mark.quoteTimestamp, quote.timestamp);
});

test('quote-cross model fails closed for unavailable or unverifiable quotes', () => {
  const unavailable = projectMomentumShadowExecutionPrice({
    model: 'quote_cross',
    quote: { available: false }
  });
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.reason, 'quote_unavailable');

  const timestampMissing = projectMomentumShadowExecutionPrice({
    model: 'quote_cross',
    quote: { ...quote, timestamp: null }
  });
  assert.equal(timestampMissing.available, false);
  assert.equal(timestampMissing.reason, 'quote_timestamp_missing_or_invalid');

  const inverted = projectMomentumShadowExecutionPrice({
    model: 'quote_cross',
    quote: { ...quote, bidPrice: 102, askPrice: 101 }
  });
  assert.equal(inverted.available, false);
  assert.equal(inverted.reason, 'quote_price_invalid');
});
