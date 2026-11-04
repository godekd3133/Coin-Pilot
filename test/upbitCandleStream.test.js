import test from 'node:test';
import assert from 'node:assert/strict';
import { UpbitMinuteCandleStream } from '../src/market-data/upbitCandleStream.js';
import MultiCoinTrader from '../src/trader/multiCoinTrader.js';

function harness({ staleAfterMs = 30_000 } = {}) {
  let clock = Date.parse('2026-11-05T01:00:30Z');
  const sockets = [];
  const timeouts = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = {};
      sockets.push(this);
    }
    addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
    emit(name, payload) { for (const listener of this.listeners[name] || []) listener(payload); }
    send(data) { this.sent.push(data); }
    close() { this.closed = true; }
  }
  const timers = {
    setTimeout(fn) { const t = { fn }; timeouts.push(t); return t; },
    clearTimeout(t) { if (t) t.cancelled = true; },
    setInterval() { return {}; },
    clearInterval() {}
  };
  const stream = new UpbitMinuteCandleStream({
    WebSocketImpl: FakeSocket, now: () => clock, staleAfterMs, timers, logger: { log() {}, warn() {} }
  });
  const runTimers = () => {
    while (timeouts.length) {
      const t = timeouts.shift();
      if (!t.cancelled) t.fn();
    }
  };
  const push = (socket, market, minute, { close = 100, volume = 1 } = {}) => socket.emit('message', {
    data: new TextEncoder().encode(JSON.stringify({
      type: 'candle.1m', code: market, candle_date_time_utc: minute, candle_date_time_kst: minute,
      opening_price: 100, high_price: Math.max(101, close), low_price: 99, trade_price: close,
      candle_acc_trade_volume: volume, candle_acc_trade_price: volume * close, timestamp: clock, stream_type: 'REALTIME'
    })).buffer
  });
  return { stream, sockets, runTimers, push, advance: ms => { clock += ms; } };
}

const restCandles = (market, minutes) => minutes.map((minute, index) => ({
  market, candle_date_time_utc: minute, opening_price: 100, high_price: 101, low_price: 99,
  trade_price: 100 + index, candle_acc_trade_volume: 5, candle_acc_trade_price: 500, unit: 1
}));

test('the stream seeds a market once over REST, then serves stream updates without new requests', async () => {
  const { stream, sockets, runTimers, push } = harness();
  stream.start(['KRW-BTC']);
  const socket = sockets[0];
  socket.emit('open');
  const subscription = JSON.parse(socket.sent[0]);
  assert.deepEqual(subscription[1], { type: 'candle.1m', codes: ['KRW-BTC'] });

  let restCalls = 0;
  const fetchRest = async count => {
    restCalls += 1;
    assert.equal(count, 200);
    return restCandles('KRW-BTC', ['2026-11-05T00:59:00', '2026-11-05T00:58:00']);
  };
  const first = await stream.read('KRW-BTC', 2, fetchRest);
  assert.equal(restCalls, 1);
  assert.deepEqual(first.map(c => c.candle_date_time_utc), ['2026-11-05T00:59:00', '2026-11-05T00:58:00']);

  push(socket, 'KRW-BTC', '2026-11-05T01:00:00', { close: 110, volume: 2 });
  push(socket, 'KRW-BTC', '2026-11-05T00:59:00', { close: 90, volume: 1 }); // older, smaller copy loses
  const second = await stream.read('KRW-BTC', 3, fetchRest);
  assert.equal(restCalls, 1, 'a seeded market must not hit REST again');
  assert.deepEqual(second.map(c => c.candle_date_time_utc), ['2026-11-05T01:00:00', '2026-11-05T00:59:00', '2026-11-05T00:58:00']);
  assert.equal(second[0].trade_price, 110);
  assert.equal(second[1].trade_price, 100, 'the copy with more accumulated volume wins');
  assert.equal(second[0].unit, 1);
  runTimers();
  assert.equal(stream.getStatus().seededMarkets, 1);
});

test('a disconnect invalidates every seed and reads fall back to REST until re-seeded', async () => {
  const { stream, sockets, runTimers, push } = harness();
  stream.start(['KRW-ETH']);
  sockets[0].emit('open');
  let restCalls = 0;
  const fetchRest = async () => { restCalls += 1; return restCandles('KRW-ETH', ['2026-11-05T00:59:00']); };
  await stream.read('KRW-ETH', 1, fetchRest);
  push(sockets[0], 'KRW-ETH', '2026-11-05T01:00:00');
  sockets[0].emit('close');
  assert.equal(stream.isLive(), false);
  const during = await stream.read('KRW-ETH', 1, fetchRest);
  assert.equal(restCalls, 2, 'while disconnected every read is a REST read');
  assert.equal(during[0].candle_date_time_utc, '2026-11-05T00:59:00');

  runTimers(); // reconnect
  sockets[1].emit('open');
  await stream.read('KRW-ETH', 1, fetchRest);
  assert.equal(restCalls, 3, 'the new connection re-seeds before serving from cache');
  await stream.read('KRW-ETH', 1, fetchRest);
  assert.equal(restCalls, 3);
});

test('a silent connection is not trusted as a live candle source', async () => {
  const { stream, sockets, advance } = harness({ staleAfterMs: 30_000 });
  stream.start(['KRW-XRP']);
  sockets[0].emit('open');
  let restCalls = 0;
  const fetchRest = async () => { restCalls += 1; return restCandles('KRW-XRP', ['2026-11-05T00:59:00']); };
  await stream.read('KRW-XRP', 1, fetchRest);
  advance(31_000);
  assert.equal(stream.isLive(), false);
  await stream.read('KRW-XRP', 1, fetchRest);
  assert.equal(restCalls, 2);
});

test('a market first read while connected is subscribed before its REST seed', async () => {
  const { stream, sockets, runTimers } = harness();
  stream.start(['KRW-BTC']);
  sockets[0].emit('open');
  const order = [];
  const reading = stream.read('KRW-SOL', 1, async () => {
    order.push(JSON.parse(sockets[0].sent.at(-1))[1].codes.includes('KRW-SOL') ? 'subscribed' : 'not-subscribed');
    return restCandles('KRW-SOL', ['2026-11-05T00:59:00']);
  });
  runTimers();
  await reading;
  assert.deepEqual(order, ['subscribed']);
});

function quietTrader() {
  const trader = new MultiCoinTrader({
    strategyMode: 'oversold_reaction_scalping',
    targetCoins: ['KRW-BTC', 'KRW-QUIET'],
    dryRun: true,
    dryRunSeedMoney: 1_000_000,
    useNews: false,
    maxCandleAgeSeconds: 90
  });
  trader.getAccountInfo = async () => [];
  return trader;
}

test('a stale quote in a live batch is a quiet-market HOLD, not a cycle failure', async () => {
  const trader = quietTrader();
  const now = Date.now();
  let candleReads = 0;
  trader.upbit = {
    async getTicker() {
      return [
        { market: 'KRW-BTC', trade_price: 100, trade_timestamp: now - 1_000 },
        { market: 'KRW-QUIET', trade_price: 5, trade_timestamp: now - 600_000 }
      ];
    },
    async getMinuteCandles() { candleReads += 1; return []; }
  };
  const tickers = await trader.getTickerMapForCycle();
  const analysis = await trader.analyzeCoin('KRW-QUIET', { overall: 'neutral', score: 0 }, { ticker: tickers.get('KRW-QUIET') });
  assert.equal(analysis.decision.action, 'HOLD');
  assert.equal(analysis.inactiveMarket, 'market_quote_quiet');
  assert.equal(candleReads, 0);
});

test('a batch where every quote is stale still fails closed', async () => {
  const trader = quietTrader();
  const now = Date.now();
  trader.upbit = {
    async getTicker() {
      return [
        { market: 'KRW-BTC', trade_price: 100, trade_timestamp: now - 600_000 },
        { market: 'KRW-QUIET', trade_price: 5, trade_timestamp: now - 600_000 }
      ];
    },
    async getMinuteCandles() { return []; }
  };
  const tickers = await trader.getTickerMapForCycle();
  await assert.rejects(
    () => trader.analyzeCoin('KRW-QUIET', { overall: 'neutral', score: 0 }, { ticker: tickers.get('KRW-QUIET') }),
    error => error.code === 'MARKET_QUOTE_STALE'
  );
});

test('a newly listed market with a short history holds while the feed is live', async () => {
  const trader = quietTrader();
  const now = Date.now();
  trader.upbit = {
    async getTicker() {
      return [
        { market: 'KRW-BTC', trade_price: 100, trade_timestamp: now - 1_000 },
        { market: 'KRW-QUIET', trade_price: 5, trade_timestamp: now - 1_000 }
      ];
    },
    async getMinuteCandles() {
      return [{ candle_date_time_utc: new Date(now).toISOString(), trade_price: 5, opening_price: 5, high_price: 5, low_price: 5, candle_acc_trade_volume: 1 }];
    }
  };
  const tickers = await trader.getTickerMapForCycle();
  const analysis = await trader.analyzeCoin('KRW-QUIET', { overall: 'neutral', score: 0 }, { ticker: tickers.get('KRW-QUIET') });
  assert.equal(analysis.decision.action, 'HOLD');
  assert.equal(analysis.inactiveMarket, 'insufficient_candle_history');
});
