import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import { describeLiveTradingFailure, getStrategyReadiness } from '../src/research/strategyReadiness.js';

const TARGET_MARKETS = ['KRW-BTC', 'KRW-ETH', 'KRW-XRP'];

function createTrader(t, { dryRun = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-market-binding-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: [...TARGET_MARKETS],
    // Construct without reading LIVE state; tests never connect to an exchange.
    dryRun: true,
    useNews: false,
    virtualPortfolioFile: path.join(root, 'portfolio.json'),
    portfolioHistoryFile: path.join(root, 'history.json'),
    paperValidationFile: path.join(root, 'paper.json'),
    liveExecutionEvidenceFile: path.join(root, 'evidence.jsonl'),
    scalpingValidationOutputFile: path.join(root, 'validation.json'),
    maxScalpMarkets: 20,
    maxPositions: 3
  });
  trader.dryRun = dryRun;
  return trader;
}

function passingReport(trader, markets = TARGET_MARKETS) {
  return {
    generatedAt: new Date().toISOString(),
    validationMode: 'fixed_config',
    strategyMode: trader.strategyMode,
    promoted: true,
    markets: [...markets],
    promotedMarkets: [...markets],
    config: trader.getPaperValidationConfigSnapshot(),
    statisticalConfidence: {
      required: true,
      method: 'one_sided_t_mean',
      confidenceLevel: 0.95,
      passed: true
    },
    results: markets.map(market => ({
      market,
      validation: {
        gate: {
          statisticalConfidence: {
            required: true,
            training: { passed: true },
            validation: { passed: true }
          }
        }
      }
    }))
  };
}

test('matching unique report markets and result rows pass regardless of order', t => {
  const trader = createTrader(t);
  const report = passingReport(trader, ['KRW-XRP', 'KRW-BTC', 'KRW-ETH']);
  report.results.reverse();
  assert.doesNotThrow(() => trader.validatePromotionReport(report));
});

for (const markets of [
  ['KRW-BTC'],
  ['KRW-SOL'],
  ['KRW-BTC', 'KRW-ETH', 'KRW-SOL'],
  [...TARGET_MARKETS, 'KRW-SOL']
]) {
  test(`all other gates passing cannot promote different target markets: ${markets.join(',')}`, t => {
    const trader = createTrader(t);
    const report = passingReport(trader, markets);
    assert.throws(() => trader.validatePromotionReport(report), {
      code: 'validation_market_mismatch'
    });
  });
}

test('three duplicate BTC result rows cannot stand in for BTC, ETH, and XRP evidence', t => {
  const trader = createTrader(t);
  const report = passingReport(trader);
  report.results = report.results.map(row => ({ ...row, market: 'KRW-BTC' }));
  assert.throws(() => trader.validatePromotionReport(report), {
    code: 'validation_results_invalid'
  });
});

test('LIVE universe update refuses unvalidated targets before changing any field', async t => {
  const trader = createTrader(t);
  trader.isRunning = true;
  const originalStrategies = [...trader.strategies.keys()];
  const originalUnknownMarkets = [...trader._liveOrderStateUnknownMarkets];
  await assert.rejects(trader.applyRuntimeMarketUniverse({
    targetCoins: [...TARGET_MARKETS, 'KRW-SOL'],
    scalpMaxMarkets: 7,
    maxPositions: 2
  }), { code: 'live_universe_update_requires_stop' });
  assert.deepEqual(trader.targetCoins, TARGET_MARKETS);
  assert.deepEqual(trader.config.targetCoins, TARGET_MARKETS);
  assert.equal(trader.config.maxScalpMarkets, 20);
  assert.equal(trader.maxPositions, 3);
  assert.equal(trader.config.maxPositions, 3);
  assert.deepEqual([...trader.strategies.keys()], originalStrategies);
  assert.deepEqual([...trader._liveOrderStateUnknownMarkets], originalUnknownMarkets);
});

test('report and runtime market lists reject duplicate, invalid, missing, or unresolved codes', t => {
  const trader = createTrader(t);
  for (const markets of [
    ['KRW-BTC', 'KRW-BTC', 'KRW-XRP'],
    ['KRW-BTC', 'krw-eth', 'KRW-XRP'],
    ['KRW-BTC', 'KRW-ETH ', 'KRW-XRP'],
    ['KRW-BTC', 'ETH', 'KRW-XRP'],
    ['KRW-BTC', undefined, 'KRW-XRP'],
    Array(3)
  ]) {
    assert.throws(() => trader.validatePromotionReport(passingReport(trader, markets)), {
      code: 'validation_markets_invalid'
    });
  }
  const report = passingReport(trader);
  for (const targetCoins of [['KRW-BTC', 'KRW-BTC', 'KRW-XRP'], [], 'ALL']) {
    trader.targetCoins = targetCoins;
    assert.throws(() => trader.validatePromotionReport(report), {
      code: 'runtime_markets_invalid'
    });
  }
});

test('each report market requires exactly one result with a valid matching market', t => {
  const trader = createTrader(t);
  for (const resultMarkets of [
    ['KRW-BTC', 'KRW-ETH'],
    ['KRW-BTC', 'KRW-ETH', 'KRW-SOL'],
    [...TARGET_MARKETS, 'KRW-SOL'],
    ['KRW-BTC', undefined, 'KRW-XRP'],
    ['KRW-BTC', 'KRW-ETH ', 'KRW-XRP']
  ]) {
    const report = passingReport(trader);
    report.results = passingReport(trader, resultMarkets).results;
    assert.throws(() => trader.validatePromotionReport(report), {
      code: 'validation_results_invalid'
    });
  }
  for (const results of [undefined, null, Array(3), [null, null, null]]) {
    const report = { ...passingReport(trader), results };
    assert.throws(() => trader.validatePromotionReport(report), {
      code: 'validation_results_invalid'
    });
  }
});

test('market binding keeps runtime config, confidence, promotion, and freshness blockers', t => {
  const trader = createTrader(t);
  const mutations = [
    [report => { report.config.rsiOversold += 1; }, /설정이 다릅니다/],
    [report => { report.statisticalConfidence.passed = false; }, /신뢰도 게이트/],
    [report => { report.results[1].validation.gate.statisticalConfidence.validation.passed = false; }, /신뢰도 게이트/],
    [report => { report.promoted = false; }, /워크포워드 게이트/],
    [report => { report.generatedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); }, /리포트가 오래되었거나/]
  ];
  for (const [mutate, expected] of mutations) {
    const report = passingReport(trader);
    mutate(report);
    assert.throws(() => trader.validatePromotionReport(report), expected);
  }
});

test('configured start gate and readiness reject a passing report for unrelated targets', t => {
  const trader = createTrader(t);
  fs.writeFileSync(trader.config.scalpingValidationOutputFile, JSON.stringify(passingReport(trader, ['KRW-SOL'])));
  assert.throws(() => trader.assertLiveValidationGate(), { code: 'validation_market_mismatch' });
  const readiness = getStrategyReadiness(trader);
  assert.equal(readiness.status, 'BLOCKED');
  assert.equal(readiness.currentEvidence, false);
  assert.equal(readiness.liveGate.passed, false);
  assert.equal(readiness.liveGate.code, 'validation_market_mismatch');
  assert.match(readiness.liveGate.reason, /현재 투자 대상 코인과 점검 당시 대상이 다릅니다/);
});

test('market failure messages stay Korean and hide raw error details', () => {
  for (const code of [
    'validation_markets_invalid', 'runtime_markets_invalid', 'validation_market_mismatch',
    'validation_results_invalid', 'live_universe_update_requires_stop'
  ]) {
    const failure = describeLiveTradingFailure(Object.assign(new Error('/private/report.json sensitive value'), { code }));
    assert.equal(failure.code, code);
    assert.match(failure.message, /[가-힣]/);
    assert.doesNotMatch(failure.message, /private|sensitive/);
  }
});

test('LIVE startup in progress and reconciliation refuse every universe field', async t => {
  const trader = createTrader(t);
  for (const state of ['_startPromise', '_startupReconciliationPending']) {
    trader[state] = state === '_startPromise' ? Promise.resolve() : true;
    for (const update of [
      { targetCoins: ['KRW-BTC'] }, { scalpMaxMarkets: 2 }, { maxPositions: 1 }
    ]) {
      assert.throws(() => trader.assertRuntimeMarketUniverseUpdateAllowed(update), {
        code: 'live_universe_update_requires_stop'
      });
      await assert.rejects(trader.applyRuntimeMarketUniverse(update), {
        code: 'live_universe_update_requires_stop'
      });
    }
    trader[state] = null;
  }
  assert.deepEqual(trader.targetCoins, TARGET_MARKETS);
  assert.equal(trader.config.maxScalpMarkets, 20);
  assert.equal(trader.maxPositions, 3);
});

test('stopped LIVE target change requires a new matching report on the next start', async t => {
  const trader = createTrader(t);
  const report = passingReport(trader);
  fs.writeFileSync(trader.config.scalpingValidationOutputFile, JSON.stringify(report));
  assert.doesNotThrow(() => trader.assertLiveValidationGate());
  await trader.applyRuntimeMarketUniverse({ targetCoins: ['KRW-BTC', 'KRW-SOL'] });
  assert.deepEqual(trader.targetCoins, ['KRW-BTC', 'KRW-SOL']);
  assert.throws(() => trader.assertLiveValidationGate(), { code: 'validation_market_mismatch' });
});

test('LIVE startup during ALL resolution refuses the staged update without partial mutation', async t => {
  const trader = createTrader(t);
  trader.resolveAllKrwMarketUniverse = async options => {
    assert.equal(options.scalpMaxMarkets, 7);
    assert.equal(trader.config.maxScalpMarkets, 20);
    assert.equal(trader.maxPositions, 3);
    trader._startupReconciliationPending = true;
    return ['KRW-SOL'];
  };
  await assert.rejects(trader.applyRuntimeMarketUniverse({
    targetCoins: 'ALL', scalpMaxMarkets: 7, maxPositions: 2
  }), { code: 'live_universe_update_requires_stop' });
  assert.deepEqual(trader.targetCoins, TARGET_MARKETS);
  assert.equal(trader.config.maxScalpMarkets, 20);
  assert.equal(trader.maxPositions, 3);
});

test('invalid or failed ALL resolution never partially updates a stopped runtime', async t => {
  const trader = createTrader(t);
  await assert.rejects(trader.applyRuntimeMarketUniverse({
    targetCoins: [], scalpMaxMarkets: 7, maxPositions: 2
  }), /at least one valid/);
  trader.resolveAllKrwMarketUniverse = async () => { throw new Error('public market lookup failed'); };
  await assert.rejects(trader.applyRuntimeMarketUniverse({
    targetCoins: 'ALL', scalpMaxMarkets: 7, maxPositions: 2
  }), /public market lookup failed/);
  assert.deepEqual(trader.targetCoins, TARGET_MARKETS);
  assert.equal(trader.config.maxScalpMarkets, 20);
  assert.equal(trader.maxPositions, 3);
});

test('running paper mode retains runtime universe updates', async t => {
  const trader = createTrader(t, { dryRun: true });
  trader.isRunning = true;
  const result = await trader.applyRuntimeMarketUniverse({
    targetCoins: ['KRW-BTC', 'KRW-SOL'], scalpMaxMarkets: 7, maxPositions: 2
  });
  assert.deepEqual(result, {
    targetCoins: ['KRW-BTC', 'KRW-SOL'], scalpMaxMarkets: 7, maxPositions: 2
  });
});

test('a matching report and runtime list for another quote cannot pass a KRW trader', t => {
  const trader = createTrader(t);
  trader.targetCoins = ['BTC-XRP', 'BTC-ETH', 'BTC-SOL'];
  const report = passingReport(trader, trader.targetCoins);
  assert.throws(() => trader.validatePromotionReport(report), {
    code: 'validation_markets_invalid'
  });
});

test('stopped universe updates reject any foreign quote before changing fields', async t => {
  const trader = createTrader(t);
  for (const targetCoins of [['BTC-XRP'], ['KRW-BTC', 'USDT-ETH']]) {
    await assert.rejects(trader.applyRuntimeMarketUniverse({
      targetCoins, scalpMaxMarkets: 7, maxPositions: 2
    }), { code: 'runtime_markets_invalid' });
    assert.deepEqual(trader.targetCoins, TARGET_MARKETS);
    assert.deepEqual(trader.config.targetCoins, TARGET_MARKETS);
    assert.equal(trader.config.maxScalpMarkets, 20);
    assert.equal(trader.maxPositions, 3);
  }
});

test('unsupported short base codes are rejected instead of silently dropping a requested target', async t => {
  const trader = createTrader(t);
  for (const targetCoins of [['KRW-S'], ['KRW-BTC', 'USDT-S'], ['KRW-BTC', 'KRW-S']]) {
    await assert.rejects(trader.applyRuntimeMarketUniverse({
      targetCoins, scalpMaxMarkets: 7, maxPositions: 2
    }), { code: 'runtime_markets_invalid' });
    assert.deepEqual(trader.targetCoins, TARGET_MARKETS);
    assert.equal(trader.config.maxScalpMarkets, 20);
    assert.equal(trader.maxPositions, 3);
  }
  const report = passingReport(trader, ['KRW-S']);
  trader.targetCoins = ['KRW-S'];
  assert.throws(() => trader.validatePromotionReport(report), {
    code: 'validation_markets_invalid'
  });
});

test('foreign runtime and result market codes each fail their own gate', t => {
  const trader = createTrader(t);
  const report = passingReport(trader);
  trader.targetCoins = ['KRW-BTC', 'USDT-ETH', 'KRW-XRP'];
  assert.throws(() => trader.validatePromotionReport(report), {
    code: 'runtime_markets_invalid'
  });
  trader.targetCoins = [...TARGET_MARKETS];
  report.results[1].market = 'USDT-ETH';
  assert.throws(() => trader.validatePromotionReport(report), {
    code: 'validation_results_invalid'
  });
});

test('foreign quotes returned by ALL resolution never enter the runtime universe', async t => {
  const trader = createTrader(t);
  trader.resolveAllKrwMarketUniverse = async () => ['KRW-BTC', 'BTC-XRP'];
  await assert.rejects(trader.applyRuntimeMarketUniverse({
    targetCoins: 'ALL', scalpMaxMarkets: 7, maxPositions: 2
  }), { code: 'runtime_markets_invalid' });
  assert.deepEqual(trader.targetCoins, TARGET_MARKETS);
  assert.equal(trader.config.maxScalpMarkets, 20);
  assert.equal(trader.maxPositions, 3);
});
