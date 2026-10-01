import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import UpbitAPI from '../src/api/upbit.js';
import { createPublicMarketDataSource } from '../src/api/publicMarketDataSource.js';
import {
  FixtureMarketDataAdapter,
  getMarketDataAdapterKind,
  UpbitMarketDataAdapter
} from '../src/market-data/marketDataAdapters.js';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

function createRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-market-data-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeConfig(root, overrides = {}) {
  return {
    accessKey: '',
    secretKey: '',
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC'],
    dryRun: true,
    dryRunSeedMoney: 100_000,
    initialSeedMoney: 100_000,
    virtualPortfolioFile: path.join(root, 'dry_portfolio.json'),
    paperValidationFile: path.join(root, 'paper_validation.json'),
    liveExecutionEvidenceFile: path.join(root, 'live-execution.jsonl'),
    portfolioHistoryFile: path.join(root, 'portfolio-history.json'),
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
    maxConsecutiveLosses: 3,
    ...overrides
  };
}

function makeCandles(market = 'KRW-BTC', count = 60) {
  const newestMinute = Math.floor(Date.now() / 60_000) * 60_000;
  return Array.from({ length: count }, (_, index) => {
    const price = 100 + (count - index) * 0.1;
    return {
      market,
      candle_date_time_utc: new Date(newestMinute - index * 60_000).toISOString(),
      opening_price: price,
      high_price: price + 0.5,
      low_price: price - 0.5,
      trade_price: price,
      candle_acc_trade_volume: 10
    };
  });
}

function makeFixtureAdapter({ price = 123, market = 'KRW-BTC', candles = makeCandles(market), tradeTimestamp } = {}) {
  return new FixtureMarketDataAdapter({
    tickers: [{
      market,
      trade_price: price,
      ...(Number.isFinite(tradeTimestamp) ? { trade_timestamp: tradeTimestamp } : {})
    }],
    candleSets: [{ market, unit: 1, candles }]
  });
}

test('Upbit market data adapter delegates raw ticker and candle reads to the exchange client', async () => {
  const calls = [];
  const tickers = [{ market: 'KRW-BTC', trade_price: 123 }];
  const candles = makeCandles();
  const upbit = {
    async getMarkets() {
      calls.push(['markets']);
      return [{ market: 'KRW-BTC' }];
    },
    async getTicker(markets) {
      calls.push(['tickers', markets]);
      return tickers;
    },
    async getMinuteCandles(market, unit, count) {
      calls.push(['candles', market, unit, count]);
      return candles;
    }
  };
  const adapter = new UpbitMarketDataAdapter(upbit);

  assert.equal(getMarketDataAdapterKind(adapter), 'upbit');
  assert.deepEqual(await adapter.getMarkets(), [{ market: 'KRW-BTC' }]);
  assert.strictEqual(await adapter.getTickers(['KRW-BTC']), tickers);
  assert.strictEqual(await adapter.getMinuteCandles('KRW-BTC', 1, 60), candles);
  assert.deepEqual(calls, [
    ['markets'],
    ['tickers', ['KRW-BTC']],
    ['candles', 'KRW-BTC', 1, 60]
  ]);
});

test('default trader adapter follows the current exchange client when it is replaced', async t => {
  const root = createRoot(t);
  const trader = new MultiCoinTrader(makeConfig(root));
  const tickers = [{ market: 'KRW-BTC', trade_price: 321 }];
  const candles = makeCandles();
  const calls = [];
  trader.upbit = {
    async getMarkets() {
      calls.push(['markets']);
      return [{ market: 'KRW-BTC' }];
    },
    async getTicker(markets) {
      calls.push(['tickers', markets]);
      return tickers;
    },
    async getMinuteCandles(market, unit, count) {
      calls.push(['candles', market, unit, count]);
      return candles;
    }
  };

  assert.deepEqual(await trader.marketDataAdapter.getMarkets(), [{ market: 'KRW-BTC' }]);
  assert.strictEqual(await trader.marketDataAdapter.getTickers(['KRW-BTC']), tickers);
  assert.strictEqual(await trader.marketDataAdapter.getMinuteCandles('KRW-BTC', 1, 60), candles);
  assert.deepEqual(calls, [
    ['markets'],
    ['tickers', ['KRW-BTC']],
    ['candles', 'KRW-BTC', 1, 60]
  ]);
});

test('fixture adapter is deterministic, isolated from caller mutation, and strict about candle units', async () => {
  const candles = makeCandles();
  const adapter = makeFixtureAdapter({ candles });

  const firstTickers = await adapter.getTickers('KRW-BTC');
  firstTickers[0].trade_price = 0;
  const secondTickers = await adapter.getTickers(['KRW-BTC']);
  assert.deepEqual(secondTickers, [{ market: 'KRW-BTC', trade_price: 123 }]);
  assert.deepEqual(await adapter.getMarkets(), [{ market: 'KRW-BTC' }]);

  const firstCandles = await adapter.getMinuteCandles('KRW-BTC', 1, 3);
  firstCandles[0].trade_price = 0;
  const secondCandles = await adapter.getMinuteCandles('KRW-BTC', 1, 3);
  assert.equal(secondCandles.length, 3);
  assert.equal(secondCandles[0].trade_price, candles[0].trade_price);
  assert.equal(secondCandles[0].candle_date_time_utc, candles[0].candle_date_time_utc);
  await assert.rejects(
    adapter.getMinuteCandles('KRW-BTC', 5, 3),
    /No deterministic candle fixture/
  );
  assert.equal(getMarketDataAdapterKind(adapter), 'fixture');
});

test('DRY_RUN trader routes analysis, revalidation, and portfolio mark prices through the fixture adapter', async t => {
  const root = createRoot(t);
  const adapter = makeFixtureAdapter({ tradeTimestamp: Date.now() });
  const trader = new MultiCoinTrader(makeConfig(root), { marketDataAdapter: adapter });
  const exchangeReadCalls = [];
  trader.upbit.getTicker = async (...args) => {
    exchangeReadCalls.push(['ticker', ...args]);
    throw new Error('analysis bypassed market data adapter');
  };
  trader.upbit.getMinuteCandles = async (...args) => {
    exchangeReadCalls.push(['candles', ...args]);
    throw new Error('analysis bypassed market data adapter');
  };
  trader.recordPaperCandleFreshnessObservation = () => {};
  trader.recordPaperCandleFreshnessBlock = () => {};

  const tickerMap = await trader.getTickerMapForCycle();
  assert.equal(tickerMap.get('KRW-BTC').trade_price, 123);
  const analysis = await trader.analyzeCoin('KRW-BTC', { overall: 'neutral', score: 0 }, {
    ticker: tickerMap.get('KRW-BTC')
  });
  assert.equal(analysis.currentPrice, 123);
  assert.equal(analysis.technicalAnalysis !== null, true);

  trader.recordPaperEntryConfirmation = () => {};
  trader.resolveWinnerShadowBlockedEntryAsNotFilled = () => {};
  const confirmation = await trader.confirmScalpingEntry(
    'KRW-BTC',
    { entryDelayMs: 0 },
    { validateEntry: () => ({ valid: true }) },
    { skipConfirmationDelay: true }
  );
  assert.equal(confirmation.currentPrice, 123);

  trader.virtualPortfolio.krwBalance = 5;
  trader.virtualPortfolio.holdings.set('KRW-BTC', { amount: 2, avgPrice: 10 });
  assert.equal(await trader.calculateTotalAssets(), 251);
  assert.deepEqual(exchangeReadCalls, []);
});

test('LIVE trader rejects injected adapters and keeps its own Upbit adapter immutable', t => {
  const root = createRoot(t);
  const fixture = makeFixtureAdapter();
  const fakeExchangeAdapter = new UpbitMarketDataAdapter({
    async getMarkets() { return [{ market: 'KRW-BTC' }]; },
    async getTicker() { return [{ market: 'KRW-BTC', trade_price: 123 }]; },
    async getMinuteCandles() { return makeCandles(); }
  });

  assert.throws(
    () => new MultiCoinTrader(makeConfig(root, { dryRun: false }), { marketDataAdapter: fixture }),
    /DRY_RUN only/
  );
  assert.throws(
    () => new MultiCoinTrader(makeConfig(root, { dryRun: false }), { marketDataAdapter: fakeExchangeAdapter }),
    /DRY_RUN only/
  );

  const liveTrader = new MultiCoinTrader(makeConfig(root, { dryRun: false }));
  assert.equal(getMarketDataAdapterKind(liveTrader.marketDataAdapter), 'upbit');
  assert.equal(Reflect.set(liveTrader, 'marketDataAdapter', fixture), false);

  const changedModeTrader = new MultiCoinTrader(makeConfig(root), { marketDataAdapter: fixture });
  changedModeTrader.dryRun = false;
  assert.throws(() => changedModeTrader.marketDataAdapter, /DRY_RUN only/);
});

test('a LIVE trader shares a credential-free market source while keeping account and order credentials private', async t => {
  const root = createRoot(t);
  const descriptors = new Map(['getTicker', 'getMinuteCandles'].map(name => [
    name,
    Object.getOwnPropertyDescriptor(UpbitAPI.prototype, name)
  ]));
  const reads = [];
  UpbitAPI.prototype.getTicker = async function (markets, requestOptions = {}) {
    reads.push({ method: 'ticker', reader: this, accessKey: this.accessKey, secretKey: this.secretKey, markets, requestOptions });
    return [{ market: 'KRW-BTC', trade_price: 123 }];
  };
  UpbitAPI.prototype.getMinuteCandles = async function (market, unit, count, requestOptions = {}) {
    reads.push({ method: 'candles', reader: this, accessKey: this.accessKey, secretKey: this.secretKey, market, unit, count, requestOptions });
    return makeCandles(market, count);
  };
  t.after(() => {
    for (const [name, descriptor] of descriptors) {
      Object.defineProperty(UpbitAPI.prototype, name, descriptor);
    }
  });

  const publicMarketDataSource = createPublicMarketDataSource({ requestTimeoutMs: 2500 });
  const trader = new MultiCoinTrader(makeConfig(root, {
    dryRun: false,
    accessKey: 'private-account-access-test',
    secretKey: 'private-account-secret-test'
  }), { publicMarketDataSource });

  assert.strictEqual(trader.publicMarketDataSource, publicMarketDataSource);
  assert.equal(trader.upbit.accessKey, 'private-account-access-test');
  assert.equal(trader.upbit.secretKey, 'private-account-secret-test');
  assert.equal('accessKey' in trader.riskUpbit, false);

  assert.deepEqual(await trader.marketDataAdapter.getTickers(['KRW-BTC']), [
    { market: 'KRW-BTC', trade_price: 123 }
  ]);
  assert.equal((await trader.marketDataAdapter.getMinuteCandles('KRW-BTC', 1, 60)).length, 60);
  assert.deepEqual(await trader.riskUpbit.getTicker(['KRW-BTC'], { priority: 'risk' }), [
    { market: 'KRW-BTC', trade_price: 123 }
  ]);

  assert.equal(reads.every(read => read.accessKey === '' && read.secretKey === ''), true);
  assert.equal(reads.every(read => read.reader === reads[0].reader), true,
    'strategy ticker/candles and protective ticker must share the injected public reader');
  assert.equal(reads[2].requestOptions.priority, 'risk');
  assert.throws(() => new MultiCoinTrader(makeConfig(root, { dryRun: false }), {
    publicMarketDataSource: {
      getMarkets() {}, getTicker() {}, getMinuteCandles() {}
    }
  }), /built-in credential-free public market data source/);
});

test('trader rejects unrecognized injected adapters instead of treating them as exchange-backed', t => {
  const root = createRoot(t);
  const fake = {
    async getTickers() { return []; },
    async getMinuteCandles() { return []; }
  };

  assert.throws(
    () => new MultiCoinTrader(makeConfig(root), { marketDataAdapter: fake }),
    /built-in market data adapter/
  );
});
