import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import test from 'node:test';
import createAccountRoutes from '../src/api/routes/account.js';
import createPortfolioRoutes from '../src/api/routes/portfolio.js';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

async function startReadServer(tradingSystem, getCachedTicker, onSnapshotRequest = null, getCachedTickerWithMetadata = null) {
  const app = express();
  const server = {
    tradingSystem,
    getCachedTicker,
    getHoldingsAsMap() {
      return tradingSystem.virtualPortfolio.holdings;
    },
    logApiError() {}
  };
  if (getCachedTickerWithMetadata) server.getCachedTickerWithMetadata = getCachedTickerWithMetadata;
  app.use('/api/portfolio/snapshot', (req, res, next) => {
    if (req.method === 'POST') onSnapshotRequest?.();
    next();
  });
  app.use('/api', createAccountRoutes(server));
  app.use('/api', createPortfolioRoutes(server));
  const httpServer = app.listen(0, '127.0.0.1');
  await once(httpServer, 'listening');
  const { port } = httpServer.address();
  return { httpServer, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopReadServer({ httpServer }) {
  const closed = once(httpServer, 'close');
  httpServer.close();
  await closed;
}

test('account status exposes protective-only runtime state for read-only clients', async () => {
  const runtimeSafety = {
    runtimeState: 'PROTECTIVE_ONLY',
    entriesPaused: true,
    protectiveMonitorActive: true,
    stopReason: 'risk_data_gap',
    exchangeStateKnown: true
  };
  const trader = {
    isRunning: false,
    dryRun: false,
    readOnlyObserver: true,
    strategyMode: 'oversold_reaction_scalping',
    isScalpingMode: true,
    maxPositions: 3,
    maxCandleAgeSeconds: 90,
    entryDelayMinMs: 1000,
    entryDelayMaxMs: 5000,
    targetCoins: ['KRW-BTC'],
    getRuntimeSafetyStatus: () => runtimeSafety
  };
  const ctx = await startReadServer(trader, async () => []);

  try {
    const response = await fetch(`${ctx.baseUrl}/api/status`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.runtimeState, 'PROTECTIVE_ONLY');
    assert.equal(body.entriesPaused, true);
    assert.equal(body.protectiveMonitorActive, true);
    assert.equal(body.stopReason, 'risk_data_gap');
    assert.equal(body.exchangeStateKnown, true);
    assert.equal(body.maxCandleAgeSeconds, 90);
  } finally {
    await stopReadServer(ctx);
  }
});

function createDryRunTrader() {
  const holdings = new Map([
    ['KRW-BTC', { amount: 2, avgPrice: 100 }]
  ]);
  const accounts = [{ currency: 'KRW', balance: '1000', locked: '0' }];
  const tradingSystem = {
    dryRun: true,
    initialSeedMoney: 1000,
    virtualPortfolio: { krwBalance: 1000, holdings },
    strategies: new Map([
      ['KRW-BTC', { currentPosition: { amount: 2, avgPrice: 100, entryPrice: 100 } }]
    ]),
    getAccountInfo: async () => accounts,
    getKRWBalance: () => 1000,
    async calculateTotalAssets(priceMap, options) {
      assert.equal(options.allowAveragePriceFallback, false);
      assert.deepEqual(options.accountsOverride, accounts);
      const price = priceMap.get('KRW-BTC');
      return Number.isFinite(price) ? 1000 + (2 * price) : null;
    },
    async calculateCumulativePnL(options) {
      assert.equal(options.allowAveragePriceFallback, false);
      assert.deepEqual(options.accountsOverride, accounts);
      const price = options.priceMapOverride.get('KRW-BTC');
      if (!Number.isFinite(price)) {
        return {
          initialSeedMoney: 1000,
          totalAssets: null,
          profit: null,
          profitPercent: null,
          valuationAvailable: false,
          valuationStatus: 'unavailable',
          mode: 'DRY_RUN'
        };
      }
      const totalAssets = 1000 + (2 * price);
      return {
        initialSeedMoney: 1000,
        totalAssets,
        profit: totalAssets - 1000,
        profitPercent: 100 * ((totalAssets / 1000) - 1),
        valuationAvailable: true,
        valuationStatus: 'available',
        mode: 'DRY_RUN'
      };
    }
  };
  return { tradingSystem, accounts };
}

function createSnapshotWriterTrader({ dryRun, accounts, holdings = [], historyFile }) {
  const storageRoot = path.dirname(historyFile);
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC', 'KRW-ETH'],
    dryRun,
    dryRunSeedMoney: 1000,
    virtualPortfolioFile: path.join(storageRoot, 'dry-portfolio.json'),
    paperValidationFile: path.join(storageRoot, 'paper-ledger.json'),
    portfolioHistoryFile: historyFile,
    liveExecutionEvidenceFile: path.join(storageRoot, 'live-evidence.jsonl'),
    positionRiskCheckIntervalMs: 0,
    useNews: false
  });
  trader.getAccountInfo = async () => accounts;
  trader.virtualPortfolio.krwBalance = 1000;
  trader.virtualPortfolio.holdings = new Map(holdings);
  return trader;
}

test('/positions keeps current value unavailable when the market quote is missing', async () => {
  const { tradingSystem } = createDryRunTrader();
  const ctx = await startReadServer(tradingSystem, async markets => {
    assert.deepEqual(markets, ['KRW-BTC']);
    return [];
  });

  try {
    const response = await fetch(`${ctx.baseUrl}/api/positions`);
    assert.equal(response.status, 200);
    const positions = await response.json();

    assert.equal(positions.count, 1);
    assert.equal(positions.valuationAvailable, false);
    assert.equal(positions.totalValue, null);
    assert.equal(positions.holdings[0].currentPrice, null);
    assert.equal(positions.holdings[0].currentValue, null);
    assert.equal(positions.holdings[0].profit, null);
    assert.equal(positions.holdings[0].profitPercent, null);
    assert.equal(positions.holdings[0].valuationAvailable, false);
  } finally {
    await stopReadServer(ctx);
  }
});

test('account and cumulative P&L routes use one valid ticker snapshot and report its timestamp', async () => {
  const { tradingSystem } = createDryRunTrader();
  const tickers = [{
    market: 'KRW-BTC',
    trade_price: 120,
    trade_timestamp: 1_790_000_000_000
  }];
  const ctx = await startReadServer(tradingSystem, async markets => {
    assert.deepEqual(markets, ['KRW-BTC']);
    return tickers;
  });

  try {
    const accountResponse = await fetch(`${ctx.baseUrl}/api/account`);
    assert.equal(accountResponse.status, 200);
    const account = await accountResponse.json();
    assert.equal(account.totalAssets, 1240);
    assert.equal(account.valuationAvailable, true);
    assert.equal(account.valuationStatus, 'available');
    assert.equal(account.valuationAsOf, new Date(1_790_000_000_000).toISOString());
    assert.equal(account.sourceAsOf, new Date(1_790_000_000_000).toISOString());
    assert.equal(account.fetchedAt, null);
    assert.equal(account.positions[0].currentPrice, 120);
    assert.equal(account.positions[0].currentValue, 240);
    assert.equal(account.positions[0].profit, 40);
    assert.equal(account.positions[0].profitPercent, '20.00');
    assert.equal(account.positions[0].valuationAvailable, true);
    assert.equal(account.positions[0].sourceAsOf, account.sourceAsOf);
    assert.equal(account.positions[0].fetchedAt, null);

    const pnlResponse = await fetch(`${ctx.baseUrl}/api/cumulative-pnl`);
    assert.equal(pnlResponse.status, 200);
    const pnl = await pnlResponse.json();
    assert.equal(pnl.totalAssets, 1240);
    assert.equal(pnl.profit, 240);
    assert.equal(pnl.valuationAvailable, true);
    assert.equal(pnl.valuationAsOf, new Date(1_790_000_000_000).toISOString());
    assert.equal(pnl.sourceAsOf, new Date(1_790_000_000_000).toISOString());
    assert.equal(pnl.fetchedAt, null);
  } finally {
    await stopReadServer(ctx);
  }
});

test('metadata-aware ticker adapter keeps source time and local fetched time separate', async () => {
  const { tradingSystem } = createDryRunTrader();
  const sourceAsOf = new Date(1_790_000_000_000).toISOString();
  const fetchedAt = new Date(1_790_000_001_234).toISOString();
  const tickers = [{
    market: 'KRW-BTC',
    trade_price: 120,
    trade_timestamp: 1_790_000_000_000
  }];
  const ctx = await startReadServer(
    tradingSystem,
    async () => { throw new Error('array adapter should not be used'); },
    null,
    async markets => {
      assert.deepEqual(markets, ['KRW-BTC']);
      return { tickers, fetchedAt };
    }
  );

  try {
    const accountResponse = await fetch(`${ctx.baseUrl}/api/account`);
    const account = await accountResponse.json();
    assert.equal(accountResponse.status, 200);
    assert.equal(account.valuationAsOf, sourceAsOf);
    assert.equal(account.sourceAsOf, sourceAsOf);
    assert.equal(account.fetchedAt, fetchedAt);

    const pnlResponse = await fetch(`${ctx.baseUrl}/api/cumulative-pnl`);
    const pnl = await pnlResponse.json();
    assert.equal(pnlResponse.status, 200);
    assert.equal(pnl.valuationAsOf, sourceAsOf);
    assert.equal(pnl.sourceAsOf, sourceAsOf);
    assert.equal(pnl.fetchedAt, fetchedAt);
  } finally {
    await stopReadServer(ctx);
  }
});

test('cumulative P&L fallback also exposes the ticker provenance fields', async () => {
  const sourceAsOf = new Date(1_790_000_000_000).toISOString();
  const fetchedAt = new Date(1_790_000_001_234).toISOString();
  const holdings = new Map([['KRW-BTC', { amount: 2, avgPrice: 100 }]]);
  const tradingSystem = {
    dryRun: true,
    initialSeedMoney: 1000,
    virtualPortfolio: { krwBalance: 1000, holdings },
    getAccountInfo: async () => [{ currency: 'KRW', balance: '1000', locked: '0' }],
    getKRWBalance: () => 1000
  };
  const tickers = [{ market: 'KRW-BTC', trade_price: 120, trade_timestamp: 1_790_000_000_000 }];
  const ctx = await startReadServer(
    tradingSystem,
    async () => { throw new Error('array adapter should not be used'); },
    null,
    async () => ({ tickers, fetchedAt })
  );

  try {
    const response = await fetch(`${ctx.baseUrl}/api/cumulative-pnl`);
    const pnl = await response.json();
    assert.equal(response.status, 200);
    assert.equal(pnl.totalAssets, 1240);
    assert.equal(pnl.valuationAsOf, sourceAsOf);
    assert.equal(pnl.sourceAsOf, sourceAsOf);
    assert.equal(pnl.fetchedAt, fetchedAt);
  } finally {
    await stopReadServer(ctx);
  }
});

test('a ticker without source time is not reported as a current account valuation or persisted snapshot', async t => {
  const { tradingSystem } = createDryRunTrader();
  const ctx = await startReadServer(tradingSystem, async () => [
    { market: 'KRW-BTC', trade_price: 120 }
  ]);

  try {
    const response = await fetch(`${ctx.baseUrl}/api/account`);
    const account = await response.json();
    assert.equal(response.status, 200);
    assert.equal(account.totalAssets, null);
    assert.equal(account.valuationAvailable, false);
    assert.equal(account.valuationStatus, 'unavailable');
    assert.equal(account.positions[0].currentPrice, null);
    assert.equal(account.positions[0].valuationAvailable, false);
  } finally {
    await stopReadServer(ctx);
  }

  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-untimestamped-quote-'));
  t.after(() => fs.rmSync(storageRoot, { recursive: true, force: true }));
  const historyFile = path.join(storageRoot, 'portfolio-history.json');
  const writer = createSnapshotWriterTrader({
    dryRun: true,
    accounts: [{ currency: 'KRW', balance: '1000', locked: '0' }],
    holdings: [['KRW-BTC', { amount: 2, avgPrice: 100 }]],
    historyFile
  });
  const writerContext = await startReadServer(writer, async () => [
    { market: 'KRW-BTC', trade_price: 120 }
  ]);

  try {
    const response = await fetch(`${writerContext.baseUrl}/api/portfolio/snapshot`, { method: 'POST' });
    const result = await response.json();
    assert.equal(response.status, 503);
    assert.equal(result.recorded, false);
    assert.equal(result.valuationStatus, 'unavailable');
    assert.equal(fs.existsSync(historyFile), false);
  } finally {
    writer.stop();
    await stopReadServer(writerContext);
  }
});

test('ticker outage keeps account value and position P&L unavailable instead of reporting a flat position', async () => {
  const { tradingSystem } = createDryRunTrader();
  const ctx = await startReadServer(tradingSystem, async () => {
    throw new Error('ticker unavailable');
  });

  try {
    const accountResponse = await fetch(`${ctx.baseUrl}/api/account`);
    assert.equal(accountResponse.status, 200);
    const account = await accountResponse.json();
    assert.equal(account.totalAssets, null);
    assert.equal(account.valuationAvailable, false);
    assert.equal(account.valuationStatus, 'unavailable');
    assert.equal(account.positions[0].currentPrice, null);
    assert.equal(account.positions[0].currentValue, null);
    assert.equal(account.positions[0].profit, null);
    assert.equal(account.positions[0].profitPercent, null);
    assert.equal(account.positions[0].valuationAvailable, false);

    const pnlResponse = await fetch(`${ctx.baseUrl}/api/cumulative-pnl`);
    assert.equal(pnlResponse.status, 200);
    const pnl = await pnlResponse.json();
    assert.equal(pnl.totalAssets, null);
    assert.equal(pnl.profit, null);
    assert.equal(pnl.profitPercent, null);
    assert.equal(pnl.valuationAvailable, false);
    assert.equal(pnl.valuationStatus, 'unavailable');
  } finally {
    await stopReadServer(ctx);
  }
});

test('strict current valuation preserves normal paper fallback behavior for non-reporting callers', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-account-valuation-'));
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 1000,
    virtualPortfolioFile: path.join(storageRoot, 'dry-portfolio.json'),
    paperValidationFile: path.join(storageRoot, 'paper-ledger.json'),
    positionRiskCheckIntervalMs: 0,
    paperDiagnosticShadowsEnabled: false,
    maxPositions: 3,
    portfolioAllocation: 0.1,
    investmentRatio: 0.02
  });
  trader.virtualPortfolio.krwBalance = 1000;
  trader.virtualPortfolio.holdings.set('KRW-BTC', { amount: 2, avgPrice: 100 });
  trader.upbit.getTicker = async () => { throw new Error('offline'); };

  try {
    assert.equal(await trader.calculateTotalAssets(), 1200);
    assert.equal(await trader.calculateTotalAssets(null, { allowAveragePriceFallback: false }), null);
    assert.equal(await trader.calculateTotalAssets(
      new Map([['KRW-BTC', 125]]),
      { allowAveragePriceFallback: false }
    ), 1250);
  } finally {
    trader.stop();
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('portfolio history returns an empty selected period instead of substituting older records', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-portfolio-period-'));
  const historyFile = path.join(storageRoot, 'portfolio-history.json');
  fs.writeFileSync(historyFile, JSON.stringify([
    { timestamp: '2020-01-01T00:00:00.000Z', totalAssets: 1000 }
  ]));
  const tradingSystem = {
    readOnlyObserver: false,
    portfolioHistoryFile: historyFile,
    virtualPortfolio: { holdings: new Map() }
  };
  const ctx = await startReadServer(tradingSystem, async () => []);

  try {
    const response = await fetch(`${ctx.baseUrl}/api/portfolio/history?period=24h`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.data, []);
    assert.equal(result.count, 0);
    assert.equal(result.period, '24h');
  } finally {
    await stopReadServer(ctx);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('portfolio history preserves current valuation metadata and flags older unverified points', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-portfolio-history-provenance-'));
  const historyFile = path.join(storageRoot, 'portfolio-history.json');
  const now = Date.now();
  fs.writeFileSync(historyFile, JSON.stringify([
    { timestamp: new Date(now - 60_000).toISOString(), totalAssets: 900 },
    {
      timestamp: new Date(now - 30_000).toISOString(),
      capturedAt: new Date(now - 30_000).toISOString(),
      valuationAsOf: new Date(now - 31_000).toISOString(),
      sourceAsOf: new Date(now - 31_000).toISOString(),
      fetchedAt: new Date(now - 29_000).toISOString(),
      valuationAvailable: true,
      valuationStatus: 'available',
      totalAssets: 1000
    }
  ]));
  const tradingSystem = {
    readOnlyObserver: false,
    portfolioHistoryFile: historyFile,
    virtualPortfolio: { holdings: new Map() }
  };
  const ctx = await startReadServer(tradingSystem, async () => []);

  try {
    const response = await fetch(`${ctx.baseUrl}/api/portfolio/history?period=24h`);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.data[0].valuationStatus, 'unknown_legacy');
    assert.equal(result.data[1].valuationStatus, 'available');
    assert.equal(result.data[1].valuationAsOf, new Date(now - 31_000).toISOString());
    assert.equal(result.data[1].sourceAsOf, new Date(now - 31_000).toISOString());
    assert.equal(result.data[1].fetchedAt, new Date(now - 29_000).toISOString());
  } finally {
    await stopReadServer(ctx);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('LIVE portfolio snapshots include exchange coin and locked balances instead of an empty virtual wallet', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-portfolio-snapshot-'));
  const historyFile = path.join(storageRoot, 'portfolio-history.json');
  const accounts = [
    { currency: 'KRW', balance: '1000', locked: '300' },
    { currency: 'BTC', balance: '0.5', locked: '0.1', avg_buy_price: '100' }
  ];
  const trader = createSnapshotWriterTrader({ dryRun: false, accounts, historyFile });
  const tickers = [{ market: 'KRW-BTC', trade_price: 200, trade_timestamp: 1_790_000_000_000 }];
  const fetchedAt = new Date(1_790_000_001_234).toISOString();
  const ctx = await startReadServer(trader, async markets => {
    assert.deepEqual(markets, ['KRW-BTC']);
    return tickers;
  }, null, async markets => {
    assert.deepEqual(markets, ['KRW-BTC']);
    return { tickers, fetchedAt };
  });

  try {
    const response = await fetch(`${ctx.baseUrl}/api/portfolio/snapshot`, { method: 'POST' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, true);
    assert.equal(result.recorded, true);
    assert.equal(result.valuationAsOf, new Date(1_790_000_000_000).toISOString());
    assert.equal(result.sourceAsOf, new Date(1_790_000_000_000).toISOString());
    assert.equal(result.fetchedAt, fetchedAt);
    assert.equal(typeof result.capturedAt, 'string');

    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    assert.equal(history.length, 1);
    assert.equal(history[0].totalAssets, 1420);
    assert.equal(history[0].krwBalance, 1000);
    assert.equal(history[0].positionCount, 1);
    assert.equal(history[0].valuationAvailable, true);
    assert.equal(history[0].valuationAsOf, new Date(1_790_000_000_000).toISOString());
    assert.equal(history[0].sourceAsOf, new Date(1_790_000_000_000).toISOString());
    assert.equal(history[0].fetchedAt, fetchedAt);
    assert.equal(history[0].capturedAt, result.capturedAt);
  } finally {
    trader.stop();
    await stopReadServer(ctx);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('partial portfolio quotes leave the existing history byte-for-byte unchanged', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-partial-portfolio-snapshot-'));
  const historyFile = path.join(storageRoot, 'portfolio-history.json');
  const initialHistory = JSON.stringify([
    { timestamp: '2026-09-29T00:00:00.000Z', totalAssets: 1000 }
  ], null, 2);
  fs.writeFileSync(historyFile, initialHistory);
  const trader = createSnapshotWriterTrader({
    dryRun: true,
    accounts: [{ currency: 'KRW', balance: '1000', locked: '0' }],
    holdings: [
      ['KRW-BTC', { amount: 2, avgPrice: 100 }],
      ['KRW-ETH', { amount: 1, avgPrice: 50 }]
    ],
    historyFile
  });
  const ctx = await startReadServer(trader, async () => [
    { market: 'KRW-BTC', trade_price: 120, trade_timestamp: 1_790_000_000_000 }
  ]);

  try {
    const response = await fetch(`${ctx.baseUrl}/api/portfolio/snapshot`, { method: 'POST' });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.equal(result.recorded, false);
    assert.equal(result.valuationAvailable, false);
    assert.deepEqual(result.unavailableMarkets, ['KRW-ETH']);
    assert.equal(fs.readFileSync(historyFile, 'utf8'), initialHistory);
  } finally {
    trader.stop();
    await stopReadServer(ctx);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('ticker outage does not persist an average-price estimate as a current portfolio snapshot', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-failed-portfolio-snapshot-'));
  const historyFile = path.join(storageRoot, 'portfolio-history.json');
  const trader = createSnapshotWriterTrader({
    dryRun: true,
    accounts: [{ currency: 'KRW', balance: '1000', locked: '0' }],
    holdings: [['KRW-BTC', { amount: 2, avgPrice: 100 }]],
    historyFile
  });
  const ctx = await startReadServer(trader, async () => {
    throw new Error('ticker unavailable');
  });

  try {
    const response = await fetch(`${ctx.baseUrl}/api/portfolio/snapshot`, { method: 'POST' });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.equal(result.success, false);
    assert.equal(result.recorded, false);
    assert.equal(result.valuationAvailable, false);
    assert.deepEqual(result.unavailableMarkets, ['KRW-BTC']);
    assert.equal(fs.existsSync(historyFile), false);
  } finally {
    trader.stop();
    await stopReadServer(ctx);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});

test('overlapping portfolio snapshot writes do not overwrite the first snapshot', async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-overlapping-portfolio-snapshot-'));
  const historyFile = path.join(storageRoot, 'portfolio-history.json');
  const trader = createSnapshotWriterTrader({
    dryRun: true,
    accounts: [{ currency: 'KRW', balance: '1000', locked: '0' }],
    holdings: [['KRW-BTC', { amount: 2, avgPrice: 100 }]],
    historyFile
  });
  let notifyTickerStarted;
  const tickerStarted = new Promise(resolve => { notifyTickerStarted = resolve; });
  let notifySecondRequest;
  const secondRequestArrived = new Promise(resolve => { notifySecondRequest = resolve; });
  let requestCount = 0;
  let releaseTicker;
  const tickerPromise = new Promise(resolve => { releaseTicker = resolve; });
  const ctx = await startReadServer(trader, async () => {
    notifyTickerStarted();
    return tickerPromise;
  }, () => {
    requestCount += 1;
    if (requestCount === 2) notifySecondRequest();
  });

  try {
    const firstRequest = fetch(`${ctx.baseUrl}/api/portfolio/snapshot`, { method: 'POST' });
    await tickerStarted;

    const secondRequest = fetch(`${ctx.baseUrl}/api/portfolio/snapshot`, { method: 'POST' });
    await secondRequestArrived;
    releaseTicker([{ market: 'KRW-BTC', trade_price: 120, trade_timestamp: 1_790_000_000_000 }]);
    const [firstResponse, secondResponse] = await Promise.all([firstRequest, secondRequest]);
    assert.equal(secondResponse.status, 409);
    const secondResult = await secondResponse.json();
    assert.equal(secondResult.recorded, false);

    assert.equal(firstResponse.status, 200);

    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
    assert.equal(history.length, 1);
    assert.equal(history[0].totalAssets, 1240);
  } finally {
    trader.stop();
    await stopReadServer(ctx);
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});
