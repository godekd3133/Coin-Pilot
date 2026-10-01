import test from 'node:test';
import assert from 'node:assert/strict';
import { BinanceExchange, toBinanceSymbol, fromBinanceSymbol } from '../src/exchange/binanceClient.js';
import { resolveExchange, quoteAssetForExchange, createExchangeClient } from '../src/exchange/exchangeFactory.js';
import { baseOfMarket, isMarketCode, marketsForQuote, quoteOfSystem } from '../src/exchange/marketCodes.js';
import UpbitAPI from '../src/api/upbit.js';

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  return () => calls;
}

function jsonResponse(body, status = 200) {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

test('market code mapping is bidirectional', () => {
  assert.equal(toBinanceSymbol('USDT-BTC'), 'BTCUSDT');
  assert.equal(toBinanceSymbol('USDC-ETH'), 'ETHUSDC');
  assert.equal(toBinanceSymbol('KRW-BTC'), 'BTCKRW');
  assert.equal(toBinanceSymbol('not-a-code'), null);
  assert.equal(fromBinanceSymbol('BTCUSDT'), 'USDT-BTC');
  assert.equal(fromBinanceSymbol('ETHUSDC'), 'USDC-ETH');
  assert.equal(fromBinanceSymbol('garbage'), null);
});

test('getMarkets returns QUOTE-BASE codes for the configured quote asset', async () => {
  const calls = stubFetch(() => jsonResponse({
    symbols: [
      { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
      { symbol: 'ETHBTC', baseAsset: 'ETH', quoteAsset: 'BTC', status: 'TRADING', isSpotTradingAllowed: true },
      { symbol: 'XXXUSDT', baseAsset: 'XXX', quoteAsset: 'USDT', status: 'BREAK', isSpotTradingAllowed: true }
    ]
  }));
  const exchange = new BinanceExchange({});
  const markets = await exchange.getMarkets();
  assert.deepEqual(markets, [{ market: 'USDT-BTC' }]);
  assert.ok(calls().some(c => c.url.includes('/api/v3/exchangeInfo')));
});

test('getTicker normalizes to Upbit field names', async () => {
  stubFetch(() => jsonResponse([{
    symbol: 'BTCUSDT', lastPrice: '100', openPrice: '95', highPrice: '110',
    lowPrice: '90', prevClosePrice: '94', priceChangePercent: '5.26',
    volume: '1234', quoteVolume: '123400', closeTime: 1700000000000
  }]));
  const exchange = new BinanceExchange({});
  const [ticker] = await exchange.getTicker(['USDT-BTC']);
  assert.equal(ticker.market, 'USDT-BTC');
  assert.equal(ticker.trade_price, 100);
  assert.equal(ticker.high_price, 110);
  assert.equal(ticker.low_price, 90);
  assert.ok(Math.abs(ticker.signed_change_rate - 0.0526) < 1e-9);
  assert.equal(ticker.acc_trade_price_24h, 123400);
});

test('getMinuteCandles normalizes to newest-first Upbit candles', async () => {
  stubFetch((url) => {
    assert.ok(url.includes('interval=5m'));
    assert.ok(url.includes('symbol=BTCUSDT'));
    return jsonResponse([
      [1699999800000, '10', '12', '9', '11', '50', 1699999999999, '550', 100, '0', '0', '0'],
      [1700000100000, '11', '13', '10', '12', '60', 1700000299999, '720', 120, '0', '0', '0']
    ]);
  });
  const exchange = new BinanceExchange({});
  const candles = await exchange.getMinuteCandles('USDT-BTC', 5, 2);
  assert.equal(candles.length, 2);
  // newest-first ordering
  assert.equal(candles[0].trade_price, 12);
  assert.equal(candles[1].trade_price, 11);
  assert.equal(candles[0].opening_price, 11);
  assert.equal(candles[0].candle_acc_trade_volume, 60);
  assert.equal(candles[0].candle_acc_trade_price, 720);
  assert.ok(candles[0].candle_date_time_utc.endsWith('Z'));
});

test('market buy by quote amount maps to quoteOrderQty and normalizes fill', async () => {
  let sent;
  stubFetch((url, init) => {
    if (url.includes('exchangeInfo')) return jsonResponse({ symbols: [] });
    if (url.includes('/api/v3/order') && init.method === 'POST') {
      sent = new URLSearchParams(init.body);
      return jsonResponse({
        symbol: 'BTCUSDT', orderId: 42, clientOrderId: 'intent-1', side: 'BUY',
        type: 'MARKET', status: 'FILLED', executedQty: '0.5', origQty: '0',
        cummulativeQuoteQty: '50', transactTime: 1700000000000,
        fills: [{ price: '100', qty: '0.5', commission: '0.05', commissionAsset: 'USDT' }]
      });
    }
    return jsonResponse({});
  });
  const exchange = new BinanceExchange({ accessKey: 'k', secretKey: 's' });
  const result = await exchange.order('USDT-BTC', 'bid', 50, 50, 'price', 'intent-1');
  assert.equal(result.success, true);
  assert.equal(sent.get('side'), 'BUY');
  assert.equal(sent.get('quoteOrderQty'), '50');
  assert.equal(sent.get('newClientOrderId'), 'intent-1');
  assert.equal(result.data.uuid, 'intent-1');
  assert.equal(result.data.state, 'done');
  assert.equal(result.data.executed_volume, 0.5);
  assert.equal(result.data.avg_price, 100);
  assert.equal(result.data.paid_fee, 0.05);
});

test('market sell rounds quantity to LOT_SIZE step', async () => {
  let sent;
  stubFetch((url, init) => {
    if (url.includes('exchangeInfo')) {
      return jsonResponse({ symbols: [{
        symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING',
        isSpotTradingAllowed: true,
        filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' }]
      }] });
    }
    if (init.method === 'POST') {
      sent = new URLSearchParams(init.body);
      return jsonResponse({
        symbol: 'BTCUSDT', clientOrderId: 'sell-1', side: 'SELL', type: 'MARKET',
        status: 'FILLED', executedQty: '0.123', origQty: '0.123', cummulativeQuoteQty: '12.3',
        fills: [{ price: '100', qty: '0.123', commission: '0.0123', commissionAsset: 'USDT' }]
      });
    }
    return jsonResponse({});
  });
  const exchange = new BinanceExchange({ accessKey: 'k', secretKey: 's' });
  const result = await exchange.order('USDT-BTC', 'ask', 0.12345, null, 'market', 'sell-1');
  assert.equal(result.success, true);
  assert.equal(sent.get('quantity'), '0.123');
  assert.equal(result.data.side, 'ask');
});

test('insufficient balance maps to the Upbit error code contract', async () => {
  stubFetch((url, _init) => {
    if (url.includes('exchangeInfo')) return jsonResponse({ symbols: [] });
    return jsonResponse({ code: -2010, msg: 'Account has insufficient balance' }, 400);
  });
  const exchange = new BinanceExchange({ accessKey: 'k', secretKey: 's' });
  const result = await exchange.order('USDT-BTC', 'bid', 50, 50, 'price', 'x');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'insufficient_funds_bid');
});

test('orders without credentials fail before dispatch', async () => {
  const exchange = new BinanceExchange({ accessKey: '', secretKey: '' });
  await assert.rejects(
    () => exchange.getAccounts(),
    error => error.code === 'binance_credentials_missing'
  );
});

test('getAccounts normalizes balances and quote currency', async () => {
  stubFetch(() => jsonResponse({
    balances: [
      { asset: 'USDT', free: '100.5', locked: '0' },
      { asset: 'BTC', free: '0.2', locked: '0.1' },
      { asset: 'DUST', free: '0', locked: '0' }
    ]
  }));
  const exchange = new BinanceExchange({ accessKey: 'k', secretKey: 's' });
  const accounts = await exchange.getAccounts();
  const usdt = accounts.find(a => a.currency === 'USDT');
  const btc = accounts.find(a => a.currency === 'BTC');
  assert.equal(usdt.balance, 100.5);
  assert.equal(btc.locked, 0.1);
  assert.equal(btc.unit_currency, 'USDT');
  assert.ok(!accounts.some(a => a.currency === 'DUST'));
});

test('exchange factory picks upbit by default and binance on EXCHANGE', () => {
  assert.equal(resolveExchange({}), 'upbit');
  assert.equal(resolveExchange({ EXCHANGE: 'binance' }), 'binance');
  assert.throws(() => resolveExchange({ EXCHANGE: 'kraken' }), /Unsupported EXCHANGE/);
  assert.equal(quoteAssetForExchange('upbit'), 'KRW');
  assert.equal(quoteAssetForExchange('binance', { BINANCE_QUOTE_ASSET: 'USDC' }), 'USDC');
  const upbit = createExchangeClient({ exchange: 'upbit' });
  assert.ok(upbit instanceof UpbitAPI);
  const binance = createExchangeClient({ exchange: 'binance' });
  assert.ok(binance instanceof BinanceExchange);
});

test('market code helpers are quote-agnostic', () => {
  assert.equal(isMarketCode('USDT-BTC'), true);
  assert.equal(isMarketCode('KRW-XRP'), true);
  assert.equal(isMarketCode('BTC'), false);
  assert.equal(baseOfMarket('USDT-BTC'), 'BTC');
  assert.equal(baseOfMarket('KRW-ETH'), 'ETH');
  assert.deepEqual(marketsForQuote([{ market: 'USDT-BTC' }, { market: 'BTC-ETH' }], 'USDT'), ['USDT-BTC']);
  assert.equal(quoteOfSystem({ quoteAsset: 'USDT' }), 'USDT');
  assert.equal(quoteOfSystem({}), 'KRW');
});

test('open orders normalize to wait state for cleanup', async () => {
  stubFetch((url, _init) => {
    if (url.includes('openOrders')) {
      return jsonResponse([{
        symbol: 'BTCUSDT', clientOrderId: 'pending-1', side: 'BUY', type: 'LIMIT',
        status: 'NEW', price: '90', origQty: '0.5', executedQty: '0',
        cummulativeQuoteQty: '0', time: 1700000000000
      }]);
    }
    return jsonResponse({});
  });
  const exchange = new BinanceExchange({ accessKey: 'k', secretKey: 's' });
  const orders = await exchange.getOrders('USDT-BTC', ['wait', 'watch']);
  assert.equal(orders.length, 1);
  assert.equal(orders[0].uuid, 'pending-1');
  assert.equal(orders[0].state, 'wait');
});
