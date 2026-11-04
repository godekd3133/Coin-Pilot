import test from 'node:test';
import assert from 'node:assert/strict';
import createConfigRoutes from '../src/api/routes/config.js';

function apply(trader, body) {
  const router = createConfigRoutes({ tradingSystem: trader });
  const handler = router.stack.find(layer => layer.route?.path === '/investment-presets/apply').route.stack[0].handle;
  let status = 200;
  let result;
  handler({ body }, { status(value) { status = value; return this; }, json(value) { result = value; return this; } });
  return { status, result };
}
test('generic preset keeps existing scalp conditions that the preset does not define', () => {
  const preserved = { minReboundPercent: 0.15, minRsiRecovery: 2, oversoldLookback: 3, maxHoldMinutes: 30, entryDelayMinMs: 1000 };
  const strategy = { config: { ...preserved }, maxHoldMs: 30 * 60000 };
  const trader = { dryRun: true, isRunning: false, isScalpingMode: true, config: { ...preserved }, strategyConfig: { ...preserved }, strategies: new Map([['KRW-BTC', strategy]]) };
  const { status, result } = apply(trader, { presetId: 'conservative' });
  assert.equal(status, 200);
  assert.equal(result.success, true);
  for (const [key, value] of Object.entries(preserved)) {
    assert.equal(trader.config[key], value, key);
    assert.equal(trader.strategyConfig[key], value, key);
    assert.equal(strategy.config[key], value, key);
  }
  assert.equal(trader.investmentRatio, 0.03);
  assert.equal(strategy.config.stopLossPercent, 8);
  assert.equal(strategy.maxHoldMs, 30 * 60000);
});
test('a supplied scalp preset updates its actual hold time and entry conditions', () => {
  const strategy = { config: {}, maxHoldMs: 60 * 60000 };
  const trader = { dryRun: true, isRunning: false, isScalpingMode: true, config: { maxHoldMinutes: 60 }, strategyConfig: {}, strategies: new Map([['KRW-BTC', strategy]]) };
  const { result } = apply(trader, { presetId: 'scalping' });
  assert.equal(result.success, true);
  assert.equal(trader.config.maxHoldMinutes, 30);
  assert.equal(strategy.maxHoldMs, 30 * 60000);
  assert.equal(trader.config.minReboundPercent, 0.15);
});
test('preset changes stay blocked during an evidence-bearing paper session', () => {
  const trader = { dryRun: true, config: { maxHoldMinutes: 30 }, paperValidation: { active: true } };
  const before = { ...trader.config };
  const { status, result } = apply(trader, { presetId: 'conservative' });
  assert.equal(status, 409);
  assert.equal(result.success, false);
  assert.deepEqual(trader.config, before);
});
