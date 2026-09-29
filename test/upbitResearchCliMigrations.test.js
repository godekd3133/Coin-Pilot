import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getMultipleMinuteCandles as getBacktestCandles } from '../src/scripts/runBacktest.js';
import { getMultipleMinuteCandles as getOptimizationCandles } from '../src/scripts/runOptimization.js';
import { getHistoricalCandles as getShadowCandidateCandles } from '../src/scripts/validateShadowCandidate.js';
import { getHistoricalCandles as getScalpingCandles } from '../src/scripts/validateScalping.js';
import { getHistoricalCandles as getVariantCandles } from '../src/scripts/compareScalpingVariants.js';
import { getHistoricalCandles as getPortfolioCandles } from '../src/scripts/validatePortfolio.js';
import { fetchMarketCandles as fetchHigherTimeframeCandles } from '../src/scripts/fetchHigherTimeframeMomentumCandles.js';
import { fetchMarketCandles as fetchDailyCandles } from '../src/scripts/fetchDailyMomentumCandles.js';
import { fetchQuotes } from '../src/scripts/measureMomentumShadowQuotes.js';
import {
  fetchDailyCandles as fetchRegimeDailyCandles,
  fetchOrderbookQuotes as fetchRegimeOrderbookQuotes
} from '../src/scripts/runRegimeMomentumShadow.js';
import { fetchMinuteCandles as fetchPaperExitCandles } from '../src/scripts/analyzePaperExitPathReplay.js';
import { projectMomentumShadowQuote } from '../src/research/momentumShadowQuoteQuality.js';

const minute = (index) => ({
  candle_date_time_utc: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString().replace('.000Z', 'Z'),
  candle_date_time_kst: new Date(Date.UTC(2026, 0, 1, 9, index)).toISOString().replace('.000Z', 'Z'),
  marker: index,
  opening_price: 100 + index,
  high_price: 102 + index,
  low_price: 99 + index,
  trade_price: 101 + index,
  candle_acc_trade_volume: index + 1,
  candle_acc_trade_price: (index + 1) * (101 + index)
});

const daily = (index) => ({
  candle_date_time_utc: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 19),
  marker: index,
  opening_price: 100 + index,
  high_price: 102 + index,
  low_price: 99 + index,
  trade_price: 101 + index,
  candle_acc_trade_volume: index + 1
});

function pagedMinuteClient() {
  const firstPage = Array.from({ length: 200 }, (_, index) => minute(200 - index));
  const secondPage = [minute(0)];
  const pages = [firstPage, secondPage];
  const calls = [];
  return {
    calls,
    firstPage,
    secondPage,
    api: {
      async getMinuteCandles(...args) {
        calls.push(args);
        const page = pages.shift();
        if (!page) throw new Error('unexpected_minute_request');
        return page;
      }
    }
  };
}

function assertMinutePagination(calls) {
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['KRW-BTC', 1, 200]);
  assert.deepEqual(calls[1], [
    'KRW-BTC',
    1,
    1,
    { to: minute(1).candle_date_time_utc }
  ]);
}

const concatenatingMinuteFetchers = [
  ['backtest', getBacktestCandles],
  ['optimization', getOptimizationCandles]
];

for (const [name, fetchCandles] of concatenatingMinuteFetchers) {
  test(`${name} keeps paginated minute candle response order and values`, async () => {
    const { api, calls, firstPage, secondPage } = pagedMinuteClient();
    const rows = await fetchCandles(api, 'KRW-BTC', 1, 201);
    assert.deepEqual(rows, [...firstPage, ...secondPage]);
    assertMinutePagination(calls);
  });
}

const deduplicatingMinuteFetchers = [
  ['shadow candidate validation', getShadowCandidateCandles],
  ['scalping validation', getScalpingCandles],
  ['variant comparison', getVariantCandles],
  ['portfolio validation', getPortfolioCandles]
];

for (const [name, fetchCandles] of deduplicatingMinuteFetchers) {
  test(`${name} keeps paginated minute candle values and map order`, async () => {
    const { api, calls, firstPage, secondPage } = pagedMinuteClient();
    const rows = await fetchCandles(api, 'KRW-BTC', 1, 201);
    assert.deepEqual(rows, [...firstPage, ...secondPage]);
    assertMinutePagination(calls);
  });
}

test('higher-timeframe candle fetch keeps complete-candle filtering and chronological output', async () => {
  const { api, calls, firstPage, secondPage } = pagedMinuteClient();
  const rows = await fetchHigherTimeframeCandles(
    api,
    'KRW-BTC',
    Date.parse(minute(200).candle_date_time_utc) + 60_000,
    { baseCandleUnit: 1, requestedCandleCount: 201, sleepFn: async () => {} }
  );
  const expected = [...firstPage, ...secondPage]
    .sort((left, right) => Date.parse(left.candle_date_time_utc) - Date.parse(right.candle_date_time_utc));
  assert.deepEqual(rows.candles, expected);
  assert.equal(rows.requestCount, 2);
  assert.equal(rows.discardedPartialCount, 0);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['KRW-BTC', 1, 200]);
  assert.deepEqual(calls[1], [
    'KRW-BTC',
    1,
    1,
    { to: new Date(Date.parse(minute(1).candle_date_time_utc)).toISOString() }
  ]);
});

test('daily momentum fetch forwards pagination cursor and keeps chronological saved rows', async () => {
  const firstPage = Array.from({ length: 200 }, (_, index) => daily(200 - index));
  const secondPage = [daily(0)];
  const pages = [firstPage, secondPage];
  const calls = [];
  const api = {
    async getDayCandles(...args) {
      calls.push(args);
      const page = pages.shift();
      if (!page) throw new Error('unexpected_daily_request');
      return page;
    }
  };
  const rows = await fetchDailyCandles(api, 'KRW-BTC', { days: 201, sleepFn: async () => {} });
  assert.deepEqual(rows, [...firstPage, ...secondPage]
    .sort((left, right) => left.candle_date_time_utc.localeCompare(right.candle_date_time_utc)));
  assert.deepEqual(calls, [
    ['KRW-BTC', 200, undefined],
    ['KRW-BTC', 1, { to: daily(1).candle_date_time_utc }]
  ]);
});

test('regime momentum daily request returns the high-level client payload unchanged', async () => {
  const payload = [daily(4), daily(3), daily(2)];
  const calls = [];
  const result = await fetchRegimeDailyCandles('KRW-BTC', {
    async getDayCandles(...args) {
      calls.push(args);
      return payload;
    }
  });
  assert.strictEqual(result, payload);
  assert.deepEqual(calls, [['KRW-BTC', 200]]);
});

test('quote measurement and regime runner preserve their orderbook projections', async () => {
  const books = [
    {
      market: 'KRW-BTC',
      timestamp: 1_780_000_000_000,
      orderbook_units: [{ bid_price: 100, bid_size: 2, ask_price: 101, ask_size: 3 }]
    },
    {
      market: 'KRW-ETH',
      timestamp: 1_780_000_000_100,
      orderbook_units: [{ bid_price: 200, bid_size: 4, ask_price: 202, ask_size: 5 }]
    },
    { timestamp: 1_780_000_000_200, orderbook_units: [] }
  ];
  const calls = [];
  const api = {
    async getOrderbook(...args) {
      calls.push(args);
      return books;
    }
  };

  const measured = await fetchQuotes(api, ['KRW-BTC', 'KRW-ETH']);
  const regime = await fetchRegimeOrderbookQuotes(api, ['KRW-BTC', 'KRW-ETH']);
  const btcQuote = projectMomentumShadowQuote('KRW-BTC', books[0]);
  const ethQuote = projectMomentumShadowQuote('KRW-ETH', books[1]);
  assert.deepEqual(measured, [btcQuote, ethQuote]);
  assert.deepEqual(regime, { 'KRW-BTC': btcQuote, 'KRW-ETH': ethQuote });
  assert.deepEqual(calls, [
    ['KRW-BTC,KRW-ETH'],
    ['KRW-BTC,KRW-ETH']
  ]);
});

test('paper exit replay preserves market, normalized cursor, count, and raw candle rows', async () => {
  const payload = [minute(12), minute(11)];
  const calls = [];
  const result = await fetchPaperExitCandles({
    coin: 'krw-btc',
    exitTime: '2026-09-28T12:34:56.789Z'
  }, {
    async getMinuteCandles(...args) {
      calls.push(args);
      return payload;
    }
  });
  assert.deepEqual(result, {
    market: 'KRW-BTC',
    to: '2026-09-28T12:34:56Z',
    candles: payload
  });
  assert.deepEqual(calls, [[
    'KRW-BTC',
    1,
    80,
    { to: '2026-09-28T12:34:56Z' }
  ]]);
});

test('owned research CLI callsites no longer perform direct public Upbit HTTP requests', () => {
  const files = [
    'runRegimeMomentumShadow.js',
    'measureMomentumShadowQuotes.js',
    'validateShadowCandidate.js',
    'analyzePaperExitPathReplay.js',
    'validateScalping.js',
    'runBacktest.js',
    'runOptimization.js',
    'compareScalpingVariants.js',
    'fetchHigherTimeframeMomentumCandles.js',
    'fetchDailyMomentumCandles.js',
    'validatePortfolio.js'
  ];
  for (const file of files) {
    const source = fs.readFileSync(new URL(`../src/scripts/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\baxios\b/, `${file} should not import or call axios`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} should not perform direct fetch calls`);
    assert.doesNotMatch(source, /requestWithRetry\s*\(\s*async/, `${file} should not wrap raw egress in requestWithRetry`);
    if (file !== 'analyzePaperExitPathReplay.js') {
      assert.doesNotMatch(source, /https:\/\/api\.upbit\.com\/v1\/(?:candles|orderbook)/, `${file} should not own an Upbit endpoint URL`);
    }
  }

  const replaySource = fs.readFileSync(new URL('../src/scripts/analyzePaperExitPathReplay.js', import.meta.url), 'utf8');
  assert.match(replaySource, /source:\s*\{[\s\S]*endpoint:\s*MINUTE_CANDLE_URL/);
  assert.match(replaySource, /const MINUTE_CANDLE_URL = 'https:\/\/api\.upbit\.com\/v1\/candles\/minutes\/1'/);
});
