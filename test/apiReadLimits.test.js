import test from 'node:test';
import assert from 'node:assert/strict';
import { API_READ_QUERY_LIMITS, parseBoundedIntegerQuery } from '../src/api/queryLimits.js';

test('read endpoints keep their defaults and share the approved cap', () => {
  assert.deepEqual(API_READ_QUERY_LIMITS, {
    allCoinScores: { defaultValue: 100, max: 100 },
    trades: { defaultValue: 50, max: 100 },
    news: { defaultValue: 100, max: 100 },
    coinNews: { defaultValue: 50, max: 100 }
  });

  for (const limits of Object.values(API_READ_QUERY_LIMITS)) {
    assert.equal(parseBoundedIntegerQuery(undefined, limits), limits.defaultValue);
  }
});

test('bounded query parser accepts positive integers in range and clamps above the cap', () => {
  const limits = API_READ_QUERY_LIMITS.trades;

  assert.equal(parseBoundedIntegerQuery('1', limits), 1);
  assert.equal(parseBoundedIntegerQuery('75', limits), 75);
  assert.equal(parseBoundedIntegerQuery('100', limits), 100);
  assert.equal(parseBoundedIntegerQuery('101', limits), 100);
  assert.equal(parseBoundedIntegerQuery(250, limits), 100);
});

test('malformed, repeated, fractional, non-finite, negative, and zero limits use the endpoint default', () => {
  const limits = API_READ_QUERY_LIMITS.trades;
  const invalidValues = [
    '',
    'abc',
    '10abc',
    '1.5',
    ['10', '20'],
    -1,
    '-1',
    0,
    '0',
    NaN,
    Infinity,
    '1e309'
  ];

  for (const value of invalidValues) {
    assert.equal(parseBoundedIntegerQuery(value, limits), limits.defaultValue, String(value));
  }
});

test('invalid parser configuration fails instead of creating unsafe slice bounds', () => {
  assert.throws(() => parseBoundedIntegerQuery('10', { defaultValue: 0, max: 100 }), RangeError);
  assert.throws(() => parseBoundedIntegerQuery('10', { defaultValue: 101, max: 100 }), RangeError);
});
