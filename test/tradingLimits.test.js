import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveTradingLimits } from '../src/config/tradingLimits.js';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

test('explicit zero scalping limits survive environment resolution', () => {
  assert.deepEqual(resolveTradingLimits({
    env: {
      SCALP_MAX_POSITIONS: 0,
      SCALP_PORTFOLIO_ALLOCATION: 0,
      SCALP_INVESTMENT_RATIO: 0
    },
    isScalpingMode: true
  }), {
    maxPositions: 0,
    portfolioAllocation: 0,
    investmentRatio: 0
  });
});

test('unset limits retain strategy-specific defaults and legacy optimized zeros remain explicit', () => {
  assert.deepEqual(resolveTradingLimits({ env: {}, isScalpingMode: true }), {
    maxPositions: 3,
    portfolioAllocation: 0.1,
    investmentRatio: 0.02
  });
  assert.deepEqual(resolveTradingLimits({ env: {}, isScalpingMode: false }), {
    maxPositions: 99999,
    portfolioAllocation: 0.5,
    investmentRatio: 0.05
  });
  assert.equal(resolveTradingLimits({
    env: { MAX_POSITIONS: 0, PORTFOLIO_ALLOCATION: 0 },
    isScalpingMode: false,
    optimalParams: { investmentRatio: 0 }
  }).investmentRatio, 0);
});

test('zero position cap blocks new simulated entries and zero ratio produces zero investment', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-zero-limits-'));
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    initialSeedMoney: 100_000,
    virtualPortfolioFile: path.join(storageRoot, 'dry-portfolio.json'),
    paperValidationFile: path.join(storageRoot, 'paper-ledger.json'),
    positionRiskCheckIntervalMs: 0,
    paperDiagnosticShadowsEnabled: false,
    maxCandleAgeSeconds: 0,
    candleUnit: 1,
    candleCount: 60,
    rsiPeriod: 14,
    maxPositions: 0,
    portfolioAllocation: 0,
    investmentRatio: 0
  });
  let tickerCalls = 0;
  trader.upbit.getTicker = async () => {
    tickerCalls += 1;
    throw new Error('zero position cap should block before a ticker read');
  };

  try {
    assert.equal(trader.maxPositions, 0);
    assert.equal(trader.portfolioAllocation, 0);
    assert.equal(trader.investmentRatio, 0);
    assert.equal(await trader.calculateDynamicInvestmentAmount(100_000, { multiplier: 1 }), 0);

    await trader.executeOrder('KRW-BTC', {
      action: 'BUY',
      signalStrength: { level: 'WEAK', multiplier: 1 },
      details: {}
    }, 100, 100_000, 0, 0, []);

    assert.equal(trader.virtualPortfolio.holdings.size, 0);
    assert.equal(trader.strategies.get('KRW-BTC').currentPosition, null);
    assert.equal(tickerCalls, 0);
  } finally {
    trader.stop();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});
