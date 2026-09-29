import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

test('mobile summary status uses the saved mark and does not issue another ticker read', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-mobile-summary-'));
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    virtualPortfolioFile: path.join(directory, 'portfolio.json'),
    paperValidationFile: path.join(directory, 'paper_validation.json'),
    useNews: false
  });
  trader.strategies = new Map();
  trader.virtualPortfolio = { krwBalance: 1_000_000, holdings: new Map() };

  let tickerReadCount = 0;
  trader.calculateTotalAssets = async () => {
    tickerReadCount += 1;
    return 1_000_000;
  };

  try {
    const started = await trader.startPaperValidationSession();
    assert.equal(started.active, true);
    assert.ok(tickerReadCount > 0, 'session start should establish its initial asset snapshot');
    const readsAtStart = tickerReadCount;

    trader.calculateTotalAssets = async () => {
      tickerReadCount += 1;
      throw new Error('summary read attempted an additional market quote');
    };

    const summary = await trader.getPaperValidationStatus({ includeCurrentAssets: false });
    assert.equal(tickerReadCount, readsAtStart);
    assert.equal(summary.currentAssets, 1_000_000);
    assert.equal(summary.active, true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
