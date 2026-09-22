import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateMomentumShadowRelativeTrendGap,
  isMomentumShadowRelativeTrendAllowed
} from '../src/research/momentumShadowRelativeTrend.js';

test('relative trend gap compares the asset and benchmark without rounding', () => {
  assert.equal(calculateMomentumShadowRelativeTrendGap({
    trendPercent: 4.25,
    benchmarkTrendPercent: 2
  }), 2.25);
});

test('relative trend guard requires a strict premium over the threshold', () => {
  assert.equal(isMomentumShadowRelativeTrendAllowed({
    trendPercent: 4,
    benchmarkTrendPercent: 2,
    minimumGapPercent: 2
  }), false);
  assert.equal(isMomentumShadowRelativeTrendAllowed({
    trendPercent: 4.01,
    benchmarkTrendPercent: 2,
    minimumGapPercent: 2
  }), true);
});

test('relative trend guard fails closed when benchmark or configuration is unknown', () => {
  assert.equal(isMomentumShadowRelativeTrendAllowed({
    trendPercent: 4,
    benchmarkTrendPercent: null,
    minimumGapPercent: 0
  }), false);
  assert.equal(isMomentumShadowRelativeTrendAllowed({
    trendPercent: 4,
    benchmarkTrendPercent: 2,
    minimumGapPercent: null
  }), false);
  assert.equal(calculateMomentumShadowRelativeTrendGap({
    trendPercent: 'bad',
    benchmarkTrendPercent: 2
  }), null);
});
