import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

function makeConfig(root, dryRun = true) {
  return {
    accessKey: '',
    secretKey: '',
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun,
    dryRunSeedMoney: 100_000,
    initialSeedMoney: 100_000,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    paperValidationFile: path.join(root, 'paper_validation.json'),
    positionRiskCheckIntervalMs: 0,
    paperDiagnosticShadowsEnabled: false,
    maxCandleAgeSeconds: 0,
    candleUnit: 1,
    candleCount: 60,
    rsiPeriod: 14,
    rsiOversold: 30,
    rsiOverbought: 70,
    minReboundPercent: 0.15,
    minRsiRecovery: 2,
    minVolumeRatio: 1,
    minCloseStrength: 0.65,
    minTrendSlopePercent: -0.2,
    requirePreviousHighBreak: true,
    maxPositions: 3,
    portfolioAllocation: 0.1,
    investmentRatio: 0.02,
    stopLossPercent: 1.2,
    takeProfitPercent: 1.8,
    maxHoldMinutes: 30,
    maxLosingHoldMinutes: 0,
    cooldownAfterLossMinutes: 15,
    maxConsecutiveLosses: 3
  };
}

function snapshot() {
  const ticker = { market: 'KRW-BTC', trade_price: 100 };
  return {
    capturedAt: '2026-09-22T00:00:00.000Z',
    tickerMap: new Map([['KRW-BTC', ticker]]),
    priceMap: new Map([['KRW-BTC', 100]]),
    marketDataByCoin: new Map([['KRW-BTC', {
      ticker,
      candles: Array.from({ length: 60 }, (_, index) => ({
        market: 'KRW-BTC',
        trade_price: 100,
        opening_price: 100,
        high_price: 100,
        low_price: 100,
        candle_date_time_utc: `2026-09-22T00:${String(index).padStart(2, '0')}:00`
      })),
      sharedSnapshot: true
    }]])
  };
}

test('shared snapshot cycle is dry-run only and restores the context boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shared-snapshot-'));
  const trader = new MultiCoinTrader(makeConfig(root));
  trader.isRunning = true;
  let seenContext = null;
  let seenSnapshotReason = null;

  trader.monitorOpenPositions = async context => {
    seenContext = context;
  };
  trader.executeTradingCycle = async () => {
    assert.equal(trader._snapshotContext.sharedSnapshot, true);
  };
  trader.recordPaperValidationSnapshot = async (reason, priceMap) => {
    seenSnapshotReason = { reason, priceMap };
    return { state: 'active' };
  };

  await trader.executeTradingCycleFromSnapshot(snapshot());

  assert.equal(seenContext.sharedSnapshot, true);
  assert.equal(seenContext.priceMap.get('KRW-BTC'), 100);
  assert.equal(seenSnapshotReason.reason, 'shared_snapshot_cycle');
  assert.equal(seenSnapshotReason.priceMap.get('KRW-BTC'), 100);
  assert.equal(trader._snapshotContext, undefined);
});

test('shared snapshot marks virtual holdings without an extra exchange ticker read', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shared-mark-'));
  const trader = new MultiCoinTrader(makeConfig(root));
  trader.virtualPortfolio.krwBalance = 10;
  trader.virtualPortfolio.holdings.set('KRW-BTC', { amount: 1, avgPrice: 100 });
  trader.upbit.getTicker = async () => {
    throw new Error('unexpected exchange read');
  };

  assert.equal(await trader.calculateTotalAssets(new Map([['KRW-BTC', 250]])), 260);
});

test('live trader cannot enter the shared snapshot research boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-shared-live-'));
  const trader = new MultiCoinTrader(makeConfig(root, false));

  await assert.rejects(
    trader.executeTradingCycleFromSnapshot(snapshot()),
    /DRY_RUN 연구 세션/
  );
});

