import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDashboardAuth } from '../src/api/auth.js';
import DashboardServer from '../src/api/dashboardServer.js';
import { createManualOrderService } from '../src/api/manualOrderService.js';
import { BinanceExchange } from '../src/exchange/binanceClient.js';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';
import { VirtualPortfolioStore } from '../src/trader/virtualPortfolioStore.js';

function fixture(t, { quote = 'USDT', balance = 100.125 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-quote-contract-'));
  const markets = [`${quote}-BTC`, `${quote}-ETH`];
  const trader = new MultiCoinTrader({
    exchange: quote === 'KRW' ? 'upbit' : 'binance', quoteAsset: quote,
    strategyMode: 'oversold_reaction_scalping', targetCoins: markets,
    dryRun: true, dryRunSeedMoney: balance, positionRiskCheckIntervalMs: 0,
    virtualPortfolioFile: path.join(root, 'portfolio.json'),
    paperValidationFile: path.join(root, 'paper.json'),
    portfolioHistoryFile: path.join(root, 'history.json'),
    aiMonitoringFile: path.join(root, 'ai.json'), aiAdvisorEnabled: false,
    useNews: false
  });
  const provider = {
    async getMarkets() { return markets.map(market => ({ market })); },
    async getTickers(requested) {
      const selected = Array.isArray(requested) ? requested : [requested];
      return selected.map(market => ({
        market, trade_price: 2, trade_timestamp: Date.now(),
        signed_change_rate: 0, acc_trade_price_24h: 100_000
      }));
    },
    async getMinuteCandles(market) {
      return Array.from({ length: 60 }, (_, index) => ({
        market, candle_date_time_utc: new Date(Date.now() - index * 300_000).toISOString(),
        opening_price: 2, high_price: 2.1, low_price: 1.9, trade_price: 2,
        candle_acc_trade_volume: 100
      }));
    }
  };
  trader.upbit = {
    getMarkets: provider.getMarkets,
    getTicker: provider.getTickers,
    getMinuteCandles: provider.getMinuteCandles,
    async getAccounts() { throw new Error('private exchange reads are forbidden in this fixture'); },
    async order() { throw new Error('real orders are forbidden in this fixture'); }
  };
  trader.newsMonitor = null;
  t.after(() => {
    trader.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { trader, provider, root, markets, service: createManualOrderService({ tradingSystem: trader, marketDataProvider: provider }) };
}

function authorize(quote, endpoint, body) {
  const auth = createDashboardAuth({
    EXCHANGE: quote === 'KRW' ? 'upbit' : 'binance', BINANCE_QUOTE_ASSET: quote,
    DASHBOARD_MOBILE_TOKEN: 'synthetic-mobile-token'
  });
  let allowed = false;
  let status;
  const response = { status(value) { status = value; return this; }, json() { return this; } };
  auth.middleware({
    method: 'POST', originalUrl: endpoint, body,
    headers: { authorization: 'Bearer synthetic-mobile-token', 'idempotency-key': randomUUID() }
  }, response, () => { allowed = true; });
  return { allowed, status };
}

test('mobile amount admission uses the server quote and keeps KRW thresholds', () => {
  for (const quote of ['USDT', 'USDC']) {
    for (const [endpoint, body] of [
      ['/api/trade/smart-buy', { totalAmount: 5.25 }],
      ['/api/trade/smart-sell', { targetAmount: 5.25 }],
      ['/api/virtual/deposit', { amount: 1.25 }],
      ['/api/virtual/withdraw', { amount: 1.25 }],
      ['/api/virtual/reset', { seedMoney: 100.125 }]
    ]) assert.equal(authorize(quote, endpoint, body).allowed, true, `${quote} ${endpoint}`);
  }
  for (const [endpoint, body] of [
    ['/api/trade/smart-buy', { totalAmount: 4_999 }],
    ['/api/trade/smart-sell', { targetAmount: 999 }],
    ['/api/virtual/deposit', { amount: 999 }],
    ['/api/virtual/reset', { seedMoney: 99_999 }]
  ]) assert.equal(authorize('KRW', endpoint, body).status, 403, endpoint);
  assert.equal(authorize('USDT', '/api/trade/smart-buy', { totalAmount: 4.999 }).status, 403);
  assert.equal(authorize('USDT', '/api/virtual/deposit', { amount: 0.999 }).status, 403);
});

test('unsupported crypto quotes block every manual order before market reads or portfolio mutation', async t => {
  for (const quote of ['BTC', 'ETH']) {
    const { trader, provider, service } = fixture(t, { quote });
    const coin = `${quote}-${quote === 'BTC' ? 'ETH' : 'BTC'}`;
    trader.virtualPortfolio.holdings.set(coin, { amount: 99, avgPrice: 1.75 });
    let reads = 0;
    provider.getMarkets = provider.getTickers = provider.getMinuteCandles = async () => {
      reads += 1;
      throw new Error('unsupported quote must block before market access');
    };
    for (const [method, body] of [
      ['buy', { coin, amount: 12.5 }],
      ['sell', { coin, quantity: 1.25 }],
      ['execute', { coin, action: 'BUY', amount: 12.5 }],
      ['quick', { coin, action: 'BUY', amount: 12.5 }],
      ['smartBuy', { totalAmount: 12.5 }],
      ['smartSell', { targetAmount: 12.5 }],
      ['executeBundle', { sellCoin: coin, buyCoin: `${quote}-SOL` }]
    ]) {
      const result = await service[method](body);
      assert.equal(result.status, 400, `${quote} ${method}`);
      assert.equal(result.body.code, 'UNSUPPORTED_AMOUNT_CURRENCY');
      assert.match(result.body.error, /조회/);
      assert.equal(result.body.quoteCurrency, quote);
    }
    assert.equal(reads, 0);
    assert.equal(trader.virtualPortfolio.krwBalance, 100.125);
    assert.equal(trader.virtualPortfolio.holdings.get(coin).amount, 99);
  }
});

test('unsupported crypto quote wallet requests explain the restriction while account reads remain available', async t => {
  const { trader, root } = fixture(t, { quote: 'BTC' });
  const dashboard = new DashboardServer(trader, 0, {
    env: { EXCHANGE: 'binance', BINANCE_QUOTE_ASSET: 'BTC',
      DASHBOARD_MOBILE_TOKEN: 'synthetic-mobile-token', DASHBOARD_HOST: '127.0.0.1' },
    optimizationStateDir: path.join(root, 'optimization'),
    logger: { info() {}, debug() {}, warn() {}, error() {} }
  });
  await dashboard.start();
  const url = `http://127.0.0.1:${dashboard.httpServer.address().port}`;
  const headers = { authorization: 'Bearer synthetic-mobile-token', 'content-type': 'application/json' };
  try {
    for (const endpoint of ['/api/virtual/deposit', '/api/virtual/withdraw', '/api/virtual/reset']) {
      const body = endpoint.endsWith('/reset') ? { seedMoney: 100.25 } : { amount: 1.25 };
      const response = await fetch(`${url}${endpoint}`, {
        method: 'POST', body: JSON.stringify(body), headers: { ...headers, 'idempotency-key': randomUUID() }
      });
      assert.equal(response.status, 400);
      const result = await response.json();
      assert.equal(result.code, 'UNSUPPORTED_AMOUNT_CURRENCY');
      assert.match(result.error, /BTC.*조회/);
      assert.equal(trader.virtualPortfolio.krwBalance, 100.125);
    }
    const account = await fetch(`${url}/api/account`, { headers });
    assert.equal(account.status, 200);
    assert.equal((await account.json()).krwBalance, 100.125);
  } finally {
    await dashboard.stop();
  }
});

test('direct, conditional and quick USDT buys preserve fractional quote amounts', async t => {
  for (const method of ['buy', 'execute', 'quick']) {
    const { trader, service } = fixture(t);
    const result = await service[method]({ coin: 'USDT-BTC', action: 'BUY', amount: 12.5 });
    assert.equal(result.status, 200, `${method}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.success, true);
    assert.equal(trader.virtualPortfolio.krwBalance, 87.625);
    assert.equal(trader.virtualPortfolio.holdings.get('USDT-BTC').amount, 12.5 * 0.9995 / 2);
    assert.equal((await service[method]({ coin: 'USDT-BTC', action: 'BUY', amount: 4.99 })).status, 400);
  }
});

test('smart USDT buys split fractional quote amounts without integer truncation', async t => {
  const { trader, service } = fixture(t);
  const result = await service.smartBuy({ totalAmount: 12.5, minScore: 0, maxCoins: 2 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.trades.length, 2);
  assert.equal(result.body.totalInvested, 12.5);
  assert.deepEqual(result.body.trades.map(row => row.amount), [6.25, 6.25]);
  assert.equal(trader.virtualPortfolio.krwBalance, 87.625);
});

test('direct and smart USDT sells retain fractional proceeds and fees', async t => {
  const direct = fixture(t);
  direct.trader.virtualPortfolio.holdings.set('USDT-BTC', { amount: 10, avgPrice: 1.5 });
  const sell = await direct.service.sell({ coin: 'USDT-BTC', quantity: 1.25 });
  assert.equal(sell.status, 200);
  assert.equal(sell.body.grossAmount, 2.5);
  assert.equal(sell.body.fee, 0.00125);
  assert.equal(sell.body.receivedAmount, 2.49875);

  const smart = fixture(t);
  smart.trader.virtualPortfolio.holdings.set('USDT-BTC', { amount: 10, avgPrice: 1.5 });
  const result = await smart.service.smartSell({ targetAmount: 12.5 });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.trades.length, 1);
  assert.equal(result.body.trades[0].grossAmount, 12.5);
  assert.equal(result.body.trades[0].fee, 0.00625);
  assert.equal(result.body.totalReceived, 12.49375);
});

test('USDT bundle allocation retains decimals after the sell leg', async t => {
  const { trader, service } = fixture(t);
  trader.virtualPortfolio.holdings.set('USDT-BTC', { amount: 10, avgPrice: 1.5 });
  const result = await service.executeBundle({ sellCoin: 'USDT-BTC', buyCoin: 'USDT-ETH' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.ok(Math.abs(result.body.results.buy.grossValue - 20 * 0.9995 * 0.95) < 1e-12);
});

test('KRW direct buys retain the existing 5,000 minimum', async t => {
  const { service } = fixture(t, { quote: 'KRW', balance: 20_000 });
  assert.equal((await service.buy({ coin: 'KRW-BTC', amount: 4_999 })).status, 400);
  assert.equal((await service.buy({ coin: 'KRW-BTC', amount: 5_000 })).status, 200);
});

test('USDT wallet mutations keep fractional amounts through persistence and idempotent retry', async t => {
  const { trader, root } = fixture(t);
  const dashboard = new DashboardServer(trader, 0, {
    env: { EXCHANGE: 'binance', BINANCE_QUOTE_ASSET: 'USDT',
      DASHBOARD_TOKEN: 'synthetic-operator-token', DASHBOARD_MOBILE_TOKEN: 'synthetic-mobile-token', DASHBOARD_HOST: '127.0.0.1',
      STAGING_OUTPUT_DIR: path.join(root, 'logs') },
    optimizationStateDir: path.join(root, 'optimization'),
    logger: { info() {}, debug() {}, warn() {}, error() {} }
  });
  await dashboard.start();
  const url = `http://127.0.0.1:${dashboard.httpServer.address().port}`;
  const post = async (endpoint, body, key = randomUUID(), token = 'synthetic-mobile-token') => {
    const response = await fetch(`${url}${endpoint}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const depositKey = randomUUID();
    const deposited = await post('/api/virtual/deposit', { amount: 1.25 }, depositKey);
    assert.equal(deposited.status, 200, JSON.stringify(deposited.body));
    assert.equal(deposited.body.newBalance, 101.375);
    assert.match(deposited.body.message, /USDT/);
    assert.equal((await post('/api/virtual/deposit', { amount: 1.25 }, depositKey)).body.newBalance, 101.375);
    const withdrawn = await post('/api/virtual/withdraw', { amount: 1.125 });
    assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
    assert.equal(withdrawn.body.newBalance, 100.25);
    const reset = await post('/api/virtual/reset', { seedMoney: 100.125 });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.newBalance, 100.125);
    const persisted = JSON.parse(fs.readFileSync(trader.virtualPortfolioFile, 'utf8'));
    assert.equal(persisted.krwBalance, 100.125);
    assert.equal(persisted.initialSeedMoney, 100.125);
    const rejected = await post('/api/virtual/reset', { seedMoney: 99.999 });
    assert.equal(rejected.status, 403);
    assert.equal(trader.virtualPortfolio.krwBalance, 100.125);
    for (const invalid of [true, false, null, [], [100.25], {}]) {
      for (const endpoint of ['/api/virtual/deposit', '/api/virtual/withdraw', '/api/virtual/reset']) {
        const body = endpoint.endsWith('/reset') ? { seedMoney: invalid } : { amount: invalid };
        assert.equal((await post(endpoint, body, randomUUID(), 'synthetic-operator-token')).status, 400);
        assert.equal(trader.virtualPortfolio.krwBalance, 100.125);
      }
    }
  } finally {
    await dashboard.stop();
  }
});

test('KRW wallet internals reject fractional deltas while USDT accepts finite decimals', t => {
  const krw = fixture(t, { quote: 'KRW', balance: 100_000 });
  assert.throws(() => krw.trader.adjustVirtualWalletBalance(1000.25), /올바르지/);
  const usdt = fixture(t);
  usdt.trader.adjustVirtualWalletBalance(1.25);
  assert.equal(usdt.trader.virtualPortfolio.krwBalance, 101.375);
  for (let index = 0; index < 10; index += 1) {
    usdt.trader.adjustVirtualWalletBalance(1.125);
    usdt.trader.adjustVirtualWalletBalance(-1.125);
  }
  assert.equal(usdt.trader.virtualPortfolio.krwBalance, 101.375);
  for (const value of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => usdt.trader.adjustVirtualWalletBalance(value));
  }
  assert.equal(usdt.trader.virtualPortfolio.krwBalance, 101.375);
  usdt.trader.virtualPortfolio.krwBalance = 2 ** 50;
  usdt.trader.initialSeedMoney = 2 ** 50;
  assert.throws(() => usdt.trader.adjustVirtualWalletBalance(1.125), /소수 금액/);
  assert.equal(usdt.trader.virtualPortfolio.krwBalance, 2 ** 50);
  assert.equal(usdt.trader.initialSeedMoney, 2 ** 50);
});

test('USDT account, holding analysis and asset snapshots preserve fractional valuation', async t => {
  const { trader, root } = fixture(t);
  trader.virtualPortfolio.holdings.set('USDT-BTC', { amount: 1.25, avgPrice: 1.75 });
  trader.smartTradeHistory = [{ type: 'SELL', coin: 'USDT-BTC', amount: 2.49875, profit: 0.31125, timestamp: new Date().toISOString() }];
  const dashboard = new DashboardServer(trader, 0, {
    env: { EXCHANGE: 'binance', BINANCE_QUOTE_ASSET: 'USDT',
      DASHBOARD_MOBILE_TOKEN: 'synthetic-mobile-token', DASHBOARD_HOST: '127.0.0.1' },
    optimizationStateDir: path.join(root, 'optimization'),
    logger: { info() {}, debug() {}, warn() {}, error() {} }
  });
  await dashboard.start();
  const url = `http://127.0.0.1:${dashboard.httpServer.address().port}`;
  const headers = { authorization: 'Bearer synthetic-mobile-token' };
  const get = async endpoint => {
    const response = await fetch(`${url}${endpoint}`, { headers });
    assert.equal(response.status, 200, endpoint);
    return response.json();
  };
  try {
    const account = await get('/api/account');
    assert.equal(account.totalAssets, 102.625);
    assert.equal(account.positions[0].currentValue, 2.5);
    assert.equal(account.positions[0].costBasis, 2.1875);
    assert.equal(account.positions[0].profit, 0.3125);
    const positions = await get('/api/positions');
    assert.equal(positions.valuationAvailable, true);
    assert.equal(positions.holdings[0].currentPrice, 2);
    assert.equal(positions.totalValue, 2.5);
    const pnl = await get('/api/cumulative-pnl');
    assert.equal(pnl.totalAssets, 102.625);
    assert.equal(pnl.profit, 2.5);
    const analysis = await get('/api/portfolio-analysis');
    assert.equal(analysis.summary.totalAssets, 102.625);
    assert.equal(analysis.summary.totalCost, 2.1875);
    const detail = await get('/api/coin-detail/USDT-BTC');
    assert.equal(detail.holding.currentValue, 2.5);
    assert.equal(detail.holding.profit, 0.3125);
    assert.equal(detail.maxBuyAmount, 100.125 * 0.95);
    assert.notEqual(detail.indicators, null);
    const today = await get('/api/today-summary');
    assert.equal(today.realizedProfit, 0.31125);

    const snapshot = await fetch(`${url}/api/portfolio/snapshot`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}'
    });
    assert.equal(snapshot.status, 200, JSON.stringify(await snapshot.json()));
    const history = JSON.parse(fs.readFileSync(trader.portfolioHistoryFile, 'utf8'));
    assert.equal(history.at(-1).totalAssets, 102.625);
    assert.equal(history.at(-1).krwBalance, 100.125);
  } finally {
    await dashboard.stop();
  }
});

test('LIVE initial seed preserves USDT fractions and retains KRW rounding', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-seed-quote-'));
  const previousDirectory = process.cwd();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.chdir(root);
  try {
    for (const [quote, expected] of [['KRW', 100], ['USDT', 100.125]]) {
      let stored;
      const owner = {
        dryRun: false, quoteAsset: quote,
        async calculateTotalAssets() { return 100.125; },
        writeJsonAtomically(_file, data) { stored = data; }
      };
      const store = new VirtualPortfolioStore(owner);
      await store.saveInitialSeedMoney();
      assert.equal(stored.initialSeedMoney, expected);
      assert.equal(store.initialSeedMoney, expected);
    }
  } finally {
    process.chdir(previousDirectory);
  }
});

test('LIVE position reads exclude the configured quote balance', async t => {
  const { trader, root } = fixture(t);
  trader.dryRun = false;
  trader.virtualPortfolio.holdings.set('USDT-BTC', { amount: 99, avgPrice: 1.75 });
  trader.virtualPortfolio.holdings.set('USDT-SOL', { amount: 99, avgPrice: 1.75 });
  trader.upbit.getAccounts = async () => [
    { currency: 'USDT', balance: '100.125', locked: '0', avg_buy_price: '1' },
    { currency: 'BTC', balance: '1.25', locked: '0.25', avg_buy_price: '1.75' },
    { currency: 'ETH', balance: '0', locked: '2', avg_buy_price: '1.5' }
  ];
  const dashboard = new DashboardServer(trader, 0, {
    env: { EXCHANGE: 'binance', BINANCE_QUOTE_ASSET: 'USDT',
      DASHBOARD_MOBILE_TOKEN: 'synthetic-mobile-token', DASHBOARD_HOST: '127.0.0.1' },
    optimizationStateDir: path.join(root, 'optimization'),
    logger: { info() {}, debug() {}, warn() {}, error() {} }
  });
  await dashboard.start();
  try {
    const accountResponse = await fetch(`http://127.0.0.1:${dashboard.httpServer.address().port}/api/account`, {
      headers: { authorization: 'Bearer synthetic-mobile-token' }
    });
    assert.equal(accountResponse.status, 200);
    const account = await accountResponse.json();
    assert.deepEqual(account.positions.map(row => row.coin), ['USDT-BTC', 'USDT-ETH']);
    assert.equal(account.positions[0].amount, 1.5);
    assert.equal(account.positions[0].currentValue, 3);
    assert.equal(account.positions[1].amount, 2);
    assert.equal(account.positions[1].currentValue, 4);
    assert.equal(account.totalAssets, 107.125);
    assert.equal(trader.virtualPortfolio.holdings.get('USDT-BTC').amount, 99);
    const response = await fetch(`http://127.0.0.1:${dashboard.httpServer.address().port}/api/positions`, {
      headers: { authorization: 'Bearer synthetic-mobile-token' }
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.holdings.map(row => row.coin), ['USDT-BTC']);
    assert.equal(result.holdings[0].currentValue, 2.5);
    const detailResponse = await fetch(`http://127.0.0.1:${dashboard.httpServer.address().port}/api/coin-detail/USDT-BTC`, {
      headers: { authorization: 'Bearer synthetic-mobile-token' }
    });
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.holding.amount, 1.25);
    assert.equal(detail.holding.currentValue, 2.5);
    assert.equal(detail.krwBalance, 100.125);
  } finally {
    await dashboard.stop();
  }
});

test('coin detail withholds valuation for stale or failed quotes while preserving account quantities', async t => {
  for (const unavailable of ['stale', 'failed']) {
    const { trader, root } = fixture(t);
    trader.virtualPortfolio.holdings.set('USDT-BTC', { amount: 1.25, avgPrice: 1.75 });
    trader.upbit.getTicker = async () => {
      if (unavailable === 'failed') throw new Error('synthetic ticker failure');
      return [{ market: 'USDT-BTC', trade_price: 2, trade_timestamp: Date.now() - 3_600_000 }];
    };
    const dashboard = new DashboardServer(trader, 0, {
      env: { EXCHANGE: 'binance', BINANCE_QUOTE_ASSET: 'USDT',
        DASHBOARD_MOBILE_TOKEN: 'synthetic-mobile-token', DASHBOARD_HOST: '127.0.0.1' },
      optimizationStateDir: path.join(root, 'optimization'),
      logger: { info() {}, debug() {}, warn() {}, error() {} }
    });
    await dashboard.start();
    try {
      const response = await fetch(`http://127.0.0.1:${dashboard.httpServer.address().port}/api/coin-detail/USDT-BTC`, {
        headers: { authorization: 'Bearer synthetic-mobile-token' }
      });
      assert.equal(response.status, 200);
      const detail = await response.json();
      assert.equal(detail.valuationAvailable, false);
      assert.equal(detail.currentPrice, null);
      assert.equal(detail.holding.amount, 1.25);
      assert.equal(detail.holding.currentValue, null);
      assert.equal(detail.holding.profit, null);
      assert.equal(detail.holding.profitPercent, null);
      assert.equal(detail.maxBuyAmount, null);
      assert.equal(detail.maxSellAmount, null);
    } finally {
      await dashboard.stop();
    }
  }
});

test('Binance market-specific minNotional remains authoritative for decimal quote buys', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let submitted;
  globalThis.fetch = async (url, init = {}) => {
    let body = {};
    if (url.includes('exchangeInfo')) body = { symbols: [{
      symbol: 'BTCUSDT', status: 'TRADING', isSpotTradingAllowed: true,
      filters: [{ filterType: 'NOTIONAL', minNotional: '10' }]
    }] };
    if (url.includes('/time')) body = { serverTime: Date.now() };
    if (init.method === 'POST') {
      submitted = new URLSearchParams(init.body);
      body = { symbol: 'BTCUSDT', orderId: 1, clientOrderId: 'decimal-authority', side: 'BUY', type: 'MARKET',
        status: 'FILLED', executedQty: '6.25', origQty: '6.25', cummulativeQuoteQty: '12.5',
        fills: [{ price: '2', qty: '6.25', commission: '0.00625', commissionAsset: 'USDT' }] };
    }
    return { ok: true, status: 200, headers: new Headers(), async text() { return JSON.stringify(body); } };
  };
  const exchange = new BinanceExchange({ accessKey: 'synthetic', secretKey: 'synthetic' });
  const rejected = await exchange.order('USDT-BTC', 'bid', 5.25, null, 'price', 'too-small');
  assert.equal(rejected.success, false);
  assert.equal(rejected.error.code, 'under_min_total_bid');
  assert.equal(submitted, undefined);
  const accepted = await exchange.order('USDT-BTC', 'bid', 12.5, null, 'price', 'decimal-authority');
  assert.equal(accepted.success, true);
  assert.equal(submitted.get('quoteOrderQty'), '12.5');
});
