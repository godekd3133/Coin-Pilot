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

  const explicit = resolveMomentumShadowRunnerContract({
    cooldownAfterLossDays: '3',
    maxPortfolioDrawdownPercent: '10',
    minUpBars: '2'
  });
  assert.equal(explicit.cooldownAfterLossDays, 3);
  assert.equal(explicit.maxPortfolioDrawdownPercent, 10);
  assert.equal(explicit.minUpBars, 2);

  const persisted = resolveMomentumShadowRunnerContract({
    persistedConfig: { cooldownAfterLossDays: 2, maxPortfolioDrawdownPercent: 15, minUpBars: 2 }
  });
  assert.equal(persisted.cooldownAfterLossDays, 2);
  assert.equal(persisted.maxPortfolioDrawdownPercent, 15);
  assert.equal(persisted.minUpBars, 2);
});
