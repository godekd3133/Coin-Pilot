import assert from 'node:assert/strict';
import test from 'node:test';
import { appendSmartTradeHistory } from '../src/api/smartTradeHistory.js';

test('smart trade history keeps only the latest 100 records in newest-first order', () => {
  const tradingSystem = {};

  for (let sequence = 0; sequence < 125; sequence += 1) {
    appendSmartTradeHistory(tradingSystem, { sequence });
  }

  const expectedSequences = Array.from({ length: 100 }, (_, index) => 124 - index);
  assert.equal(tradingSystem.smartTradeHistory.length, 100);
  assert.deepEqual(
    tradingSystem.smartTradeHistory.map(record => record.sequence),
    expectedSequences
  );
});

test('smart trade history updates its existing array in place', () => {
  const history = [{ sequence: 0 }];
  const tradingSystem = { smartTradeHistory: history };

  appendSmartTradeHistory(tradingSystem, { sequence: 1 });

  assert.strictEqual(tradingSystem.smartTradeHistory, history);
  assert.deepEqual(history.map(record => record.sequence), [1, 0]);
});
