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
  assert.equal(config.maxHoldHours, 8760);
  assert.equal(config.minUpBars, 2);
  assert.equal(config.positionFraction, 0.125);
  assert.equal(config.maxPositions, 2);
  assert.equal(config.costPercent, 0.2);
  assert.equal(config.maxEntryGapPercent, 0);
  assert.equal(config.maxDailyCandleAgeHours, 36);
  assert.equal(config.maxSpreadPercent, 0);
  assert.equal(config.requestIntervalMs, 500);
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

test('candidate config keeps volatility targeting opt-in and serializable', () => {
  const defaultConfig = resolveMomentumShadowCandidateConfig({});
  const targetedConfig = resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS: '21',
    MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: '1'
  });

  assert.equal(defaultConfig.volatilityLookbackDays, 14);
  assert.equal(defaultConfig.volatilityTargetPercent, null);
  assert.equal(targetedConfig.volatilityLookbackDays, 21);
  assert.equal(targetedConfig.volatilityTargetPercent, 1);
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: '0'
  }).volatilityTargetPercent, null);
});

test('candidate config keeps next-open execution explicit and defaults to close', () => {
  assert.equal(resolveMomentumShadowCandidateConfig({}).entryExecution, 'close');
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_ENTRY_EXECUTION: 'next_open'
  }).entryExecution, 'next_open');
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_ENTRY_EXECUTION: 'unexpected'
  }).entryExecution, 'close');
});

test('candidate config makes fixed hold duration explicit instead of inheriting the regime default', () => {
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_MODE: 'fixed'
  }).maxHoldHours, 72);
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_MODE: 'fixed',
    MOMO_SHADOW_MAX_HOLD_HOURS: '24'
  }).maxHoldHours, 24);
});

test('candidate config can pin volatility A/B to the validated cost stress', () => {
  const config = resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_COST_PERCENT: '0.3',
    MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: '1'
  });

  assert.equal(config.costPercent, 0.3);
  assert.equal(config.volatilityTargetPercent, 1);
});

test('candidate config accepts the next-open gap ceiling as an explicit research guard', () => {
  const config = resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_ENTRY_EXECUTION: 'next_open',
    MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT: '0.2'
  });

  assert.equal(config.entryExecution, 'next_open');
  assert.equal(config.maxEntryGapPercent, 0.2);
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT: '-1'
  }).maxEntryGapPercent, 0);
});

test('candidate config accepts an explicit daily candle freshness budget', () => {
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS: '24'
  }).maxDailyCandleAgeHours, 24);
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS: '-1'
  }).maxDailyCandleAgeHours, 0);
});

test('candidate config accepts an optional best-bid/ask spread ceiling', () => {
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_MAX_SPREAD_PERCENT: '0.5'
  }).maxSpreadPercent, 0.5);
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_MAX_SPREAD_PERCENT: '-1'
  }).maxSpreadPercent, 0);
});

test('candidate config seals runner exit overrides into the contract', () => {
  const defaultConfig = resolveMomentumShadowCandidateConfig({});
  assert.equal(defaultConfig.stopLossPercent, 0);
  assert.equal(defaultConfig.takeProfitPercent, 0);
  const overridden = resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_STOP_LOSS_PERCENT: '3',
    MOMO_SHADOW_TAKE_PROFIT_PERCENT: '6'
  });
  assert.equal(overridden.stopLossPercent, 3);
  assert.equal(overridden.takeProfitPercent, 6);
  assert.equal(resolveMomentumShadowCandidateConfig({
    MOMO_SHADOW_STOP_LOSS_PERCENT: '-2'
  }).stopLossPercent, 0);
});
