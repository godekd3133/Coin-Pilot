import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MOMENTUM_SHADOW_MARKETS,
  resolveMomentumShadowRunnerContract
} from '../src/research/momentumShadowRunnerConfig.js';

test('shadow runner inherits persisted mode and markets when env overrides are absent', () => {
  const contract = resolveMomentumShadowRunnerContract({
    persistedConfig: { mode: 'regime', markets: ['KRW-BTC', 'KRW-ETH', 'KRW-SOL'] }
  });

  assert.equal(contract.mode, 'regime');
  assert.deepEqual(contract.markets, ['KRW-BTC', 'KRW-ETH', 'KRW-SOL']);
  assert.equal(contract.inheritedMode, true);
  assert.equal(contract.inheritedMarkets, true);
});

test('shadow runner inherits benchmark gate and exit settings with an existing ledger', () => {
  const contract = resolveMomentumShadowRunnerContract({
    persistedConfig: {
      mode: 'regime',
      markets: ['KRW-BTC'],
      benchmarkMarket: 'KRW-BTC',
      benchmarkTrendMinPercent: 2,
      exitOnBenchmarkOff: true
    }
  });

  assert.equal(contract.benchmarkMarket, 'KRW-BTC');
  assert.equal(contract.benchmarkTrendMinPercent, 2);
  assert.equal(contract.exitOnBenchmarkOff, true);
  assert.equal(contract.inheritedBenchmark, true);
});

test('explicit shadow runner env values remain authoritative for an intentional research drift', () => {
  const contract = resolveMomentumShadowRunnerContract({
    mode: 'fixed',
    markets: 'KRW-BTC, KRW-ETH',
    persistedConfig: { mode: 'regime', markets: ['KRW-BTC', 'KRW-ETH', 'KRW-SOL'] }
  });

  assert.equal(contract.mode, 'fixed');
  assert.deepEqual(contract.markets, ['KRW-BTC', 'KRW-ETH']);
  assert.equal(contract.inheritedMode, false);
  assert.equal(contract.inheritedMarkets, false);
});

test('new shadow runners retain the four-market default contract', () => {
  const contract = resolveMomentumShadowRunnerContract();
  assert.equal(contract.mode, 'fixed');
  assert.deepEqual(contract.markets, DEFAULT_MOMENTUM_SHADOW_MARKETS);
});

test('shadow runner resolves optional cooldown and drawdown risk controls without inventing them for old ledgers', () => {
  const absent = resolveMomentumShadowRunnerContract({ persistedConfig: { mode: 'regime' } });
  assert.equal(absent.cooldownAfterLossDays, null);
  assert.equal(absent.maxPortfolioDrawdownPercent, null);
  assert.equal(absent.maxEntryGapPercent, null);
  assert.equal(absent.maxDailyCandleAgeHours, null);
  assert.equal(absent.maxSpreadPercent, null);
  assert.equal(absent.requestIntervalMs, null);
  assert.equal(absent.relativeTrendMinPercent, null);
  assert.equal(absent.executionModel, null);

  const explicit = resolveMomentumShadowRunnerContract({
    cooldownAfterLossDays: '3',
    maxPortfolioDrawdownPercent: '10',
    maxEntryGapPercent: '0.2',
    maxDailyCandleAgeHours: '36',
    maxSpreadPercent: '0.5',
    requestIntervalMs: '500',
    minUpBars: '2',
    relativeTrendMinPercent: '0',
    executionModel: 'quote_cross'
  });
  assert.equal(explicit.cooldownAfterLossDays, 3);
  assert.equal(explicit.maxPortfolioDrawdownPercent, 10);
  assert.equal(explicit.maxEntryGapPercent, 0.2);
  assert.equal(explicit.maxDailyCandleAgeHours, 36);
  assert.equal(explicit.maxSpreadPercent, 0.5);
  assert.equal(explicit.requestIntervalMs, 500);
  assert.equal(explicit.minUpBars, 2);
  assert.equal(explicit.relativeTrendMinPercent, 0);
  assert.equal(explicit.executionModel, 'quote_cross');

  const persisted = resolveMomentumShadowRunnerContract({
    persistedConfig: { cooldownAfterLossDays: 2, maxPortfolioDrawdownPercent: 15, maxEntryGapPercent: 0.3, maxDailyCandleAgeHours: 24, maxSpreadPercent: 0.4, requestIntervalMs: 700, minUpBars: 2, relativeTrendMinPercent: 0.5, executionModel: 'quote_cross' }
  });
  assert.equal(persisted.cooldownAfterLossDays, 2);
  assert.equal(persisted.maxPortfolioDrawdownPercent, 15);
  assert.equal(persisted.maxEntryGapPercent, 0.3);
  assert.equal(persisted.maxDailyCandleAgeHours, 24);
  assert.equal(persisted.maxSpreadPercent, 0.4);
  assert.equal(persisted.requestIntervalMs, 700);
  assert.equal(persisted.minUpBars, 2);
  assert.equal(persisted.relativeTrendMinPercent, 0.5);
  assert.equal(persisted.executionModel, 'quote_cross');
});

test('shadow runner inherits persisted volatility sizing while explicit env stays authoritative', () => {
  const inherited = resolveMomentumShadowRunnerContract({
    persistedConfig: { volatilityLookbackDays: 21, volatilityTargetPercent: 1.5 }
  });
  assert.equal(inherited.volatilityLookbackDays, 21);
  assert.equal(inherited.volatilityTargetPercent, 1.5);

  const explicit = resolveMomentumShadowRunnerContract({
    volatilityLookbackDays: '7',
    volatilityTargetPercent: '0.8',
    persistedConfig: { volatilityLookbackDays: 21, volatilityTargetPercent: 1.5 }
  });
  assert.equal(explicit.volatilityLookbackDays, 7);
  assert.equal(explicit.volatilityTargetPercent, 0.8);

  // An explicit zero disables a persisted target instead of silently
  // inheriting it; the runner records the disabled value as drift.
  const disabled = resolveMomentumShadowRunnerContract({
    volatilityTargetPercent: '0',
    persistedConfig: { volatilityTargetPercent: 1.5 }
  });
  assert.equal(disabled.volatilityTargetPercent, 0);

  const absent = resolveMomentumShadowRunnerContract({ persistedConfig: { mode: 'regime' } });
  assert.equal(absent.volatilityLookbackDays, null);
  assert.equal(absent.volatilityTargetPercent, null);
});
