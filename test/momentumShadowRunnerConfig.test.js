import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MOMENTUM_SHADOW_MARKETS,
  getMomentumShadowConfigDriftChanges,
  recordMomentumShadowConfigDrift,
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

test('shadow config reconciliation ignores key order but preserves real value and array drift', () => {
  const persisted = {
    mode: 'fixed',
    markets: ['KRW-BTC', 'KRW-ETH'],
    execution: { model: 'candle_close', costPercent: 0.2 }
  };
  const sameValuesDifferentOrder = {
    execution: { costPercent: 0.2, model: 'candle_close' },
    markets: ['KRW-BTC', 'KRW-ETH'],
    mode: 'fixed'
  };
  const ledger = { config: persisted };

  assert.equal(recordMomentumShadowConfigDrift(ledger, sameValuesDifferentOrder, '2026-09-23T00:00:00.000Z'), false);
  assert.equal(ledger.configDrift, undefined);
  assert.equal(ledger.config, persisted);
  assert.deepEqual(getMomentumShadowConfigDriftChanges(persisted, sameValuesDifferentOrder), []);

  const driftedLedger = { config: persisted };
  const explicitRequestInterval = { ...sameValuesDifferentOrder, requestIntervalMs: 500 };
  assert.deepEqual(getMomentumShadowConfigDriftChanges(persisted, explicitRequestInterval), [{
    key: 'requestIntervalMs',
    previousRecorded: false,
    previousValue: null,
    currentRecorded: true,
    currentValue: 500
  }]);
  assert.equal(recordMomentumShadowConfigDrift(driftedLedger, explicitRequestInterval, '2026-09-23T00:00:01.000Z'), true);
  assert.deepEqual(driftedLedger.configDrift, {
    previous: persisted,
    changedAt: '2026-09-23T00:00:01.000Z'
  });
  assert.equal(driftedLedger.config, explicitRequestInterval);

  const valueDriftLedger = { config: persisted };
  assert.equal(recordMomentumShadowConfigDrift(valueDriftLedger, {
    ...sameValuesDifferentOrder,
    mode: 'regime'
  }, '2026-09-23T00:00:02.000Z'), true);

  const arrayDriftLedger = { config: persisted };
  assert.equal(recordMomentumShadowConfigDrift(arrayDriftLedger, {
    ...sameValuesDifferentOrder,
    markets: ['KRW-ETH', 'KRW-BTC']
  }, '2026-09-23T00:00:03.000Z'), true);
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
