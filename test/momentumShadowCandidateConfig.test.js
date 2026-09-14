import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG,
  resolveMomentumShadowCandidateConfig
} from '../src/research/momentumShadowCandidateConfig.js';

test('candidate config has one evidence-backed default contract', () => {
  const config = resolveMomentumShadowCandidateConfig({});
  assert.deepEqual(config, {
    ...DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG,
    markets: [...DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG.markets]
  });
  assert.equal(config.breadthMin, 2);
  assert.equal(config.minUpBars, 2);
  assert.equal(config.positionFraction, 0.125);
  assert.equal(config.maxPositions, 2);
  assert.equal(config.maxPortfolioDrawdownPercent, 15);
});

test('candidate config accepts explicit research overrides without changing defaults', () => {
  const config = resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_BREADTH_MIN: '3',
    MOMO_SHADOW_MARKETS: 'KRW-BTC, KRW-ETH, KRW-BTC',
    MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF: 'false'
  });
  assert.equal(config.breadthMin, 3);
  assert.deepEqual(config.markets, ['KRW-BTC', 'KRW-ETH']);
  assert.equal(config.exitOnBenchmarkOff, false);
  assert.equal(DEFAULT_MOMENTUM_SHADOW_CANDIDATE_CONFIG.breadthMin, 2);
});
