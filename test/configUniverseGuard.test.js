import assert from 'node:assert/strict';
import test from 'node:test';
import createConfigRoutes from '../src/api/routes/config.js';

test('mixed LIVE universe and tuning updates reject during reconciliation before changing any runtime setting', async () => {
  const failure = Object.assign(new Error('stop LIVE before changing its market universe'), {
    code: 'live_universe_update_requires_stop'
  });
  let applyCalls = 0;
  const trader = {
    dryRun: false,
    isScalpingMode: true,
    isRunning: false,
    _startupReconciliationPending: true,
    config: { rsiPeriod: 14 },
    strategyConfig: { rsiPeriod: 14 },
    strategies: new Map(),
    investmentRatio: 0.02,
    targetCoins: ['KRW-BTC'],
    assertRuntimeMarketUniverseUpdateAllowed() { throw failure; },
    async applyRuntimeMarketUniverse() { applyCalls += 1; throw failure; }
  };
  const router = createConfigRoutes({ tradingSystem: trader });
  const handler = router.stack.find(layer => layer.route?.path === '/config/update').route.stack[0].handle;
  let statusCode = 200;
  let response;
  await handler({ body: { targetCoins: ['KRW-SOL'], rsiPeriod: 7, investmentRatio: 0.15 } }, {
    status(value) { statusCode = value; return this; },
    json(value) { response = value; return this; }
  });
  assert.equal(statusCode, 409);
  assert.equal(response.code, 'live_universe_update_requires_stop');
  assert.match(response.error, /중지/);
  assert.equal(response.success, false);
  assert.equal(applyCalls, 0);
  assert.deepEqual(trader.config, { rsiPeriod: 14 });
  assert.deepEqual(trader.strategyConfig, { rsiPeriod: 14 });
  assert.equal(trader.investmentRatio, 0.02);
  assert.deepEqual(trader.targetCoins, ['KRW-BTC']);
});
