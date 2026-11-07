import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import createScorecardRoutes, {
  collectClosedTrades,
  summarizeTrades,
  computeHoldBenchmark,
  describeOpenPositions
} from '../src/api/routes/scorecard.js';

const NOW = Date.parse('2026-11-07T03:00:00Z'); // 12:00 KST

function closed({ coin = 'KRW-A', entry, exit, entryPrice = 1000, exitPrice, amount = 10, profit, action = 'CLOSE' }) {
  const cost = entryPrice * amount;
  return {
    action,
    coin,
    entryPrice,
    exitPrice,
    amount,
    entryTime: entry,
    exitTime: exit,
    grossProfit: (exitPrice - entryPrice) * amount,
    profit,
    profitPercent: (profit / cost) * 100
  };
}

function dayCandle(dateUtc, open, close) {
  return {
    market: 'KRW-BTC',
    candle_date_time_utc: `${dateUtc}T00:00:00`,
    opening_price: open,
    trade_price: close,
    timestamp: Date.parse(`${dateUtc}T00:00:00Z`) + 3 * 3600 * 1000
  };
}

async function request(server, options) {
  const app = express();
  app.use('/api', createScorecardRoutes(server, options));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listener.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/scorecard`);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise(resolve => listener.close(resolve));
  }
}

test('summary uses net profit already booked by the strategy and refuses a verdict on a small sample', () => {
  const strategies = new Map([
    ['KRW-A', { tradeHistory: [
      { action: 'OPEN', entryTime: '2026-11-05T00:00:00Z', entryPrice: 1000, amount: 10 },
      closed({ entry: '2026-11-05T00:00:00Z', exit: '2026-11-05T00:10:00Z', exitPrice: 1010, profit: 90 }),
      closed({ entry: '2026-11-05T01:00:00Z', exit: '2026-11-05T01:10:00Z', exitPrice: 990, profit: -110 })
    ] }],
    ['KRW-B', { tradeHistory: [
      closed({ coin: 'KRW-B', entry: '2026-11-06T00:00:00Z', exit: '2026-11-06T00:05:00Z', exitPrice: 1002, profit: 10, action: 'PARTIAL_CLOSE' })
    ] }]
  ]);
  const trades = collectClosedTrades(strategies);
  assert.equal(trades.length, 3, 'OPEN rows are not trades; PARTIAL_CLOSE counts');
  const summary = summarizeTrades(trades);
  assert.equal(summary.tradeCount, 3);
  assert.equal(summary.winCount, 2);
  assert.equal(summary.realizedNetProfit, -10);
  assert.ok(Math.abs(summary.avgNetReturnPercent - (-10 / 3 / 100)) < 1e-9);
  assert.ok(Math.abs(summary.avgGrossReturnPercent - (0.2 / 3)) < 1e-9);
  assert.ok(summary.avgCostPercent > 0, 'cost is gross minus net');
  assert.equal(summary.verdict, 'insufficient_sample');
  assert.equal(summary.ciIncludesZero, true);
});

test('verdict needs 100 trades and a 95% interval that excludes zero', () => {
  const make = returns => returns.map((netReturnPercent, index) => ({
    coin: 'KRW-A', entryMs: index, exitMs: index + 1, profit: netReturnPercent * 100, netReturnPercent, grossReturnPercent: netReturnPercent + 0.25
  }));
  const noisy = make(Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 1 : -0.98)));
  assert.equal(summarizeTrades(noisy).verdict, 'indistinguishable_from_luck');

  const losing = make(Array.from({ length: 120 }, (_, i) => -0.12 + (i % 3) * 0.01));
  const losingSummary = summarizeTrades(losing);
  assert.equal(losingSummary.verdict, 'negative_edge');
  assert.ok(losingSummary.ci95.high < 0);

  const winning = make(Array.from({ length: 120 }, (_, i) => 0.3 + (i % 3) * 0.01));
  assert.equal(summarizeTrades(winning).verdict, 'positive_edge');
  assert.equal(summarizeTrades(winning.slice(0, 99)).verdict, 'insufficient_sample');
  assert.equal(summarizeTrades([]).verdict, 'no_trades');
});

test('BTC hold benchmark buys at the open of the day containing the period start', () => {
  const candles = [
    dayCandle('2026-11-07', 110, 121),
    dayCandle('2026-11-06', 105, 110),
    dayCandle('2026-11-05', 100, 105)
  ];
  const benchmark = computeHoldBenchmark(candles, Date.parse('2026-11-05T05:00:00Z'));
  assert.equal(benchmark.available, true);
  assert.equal(benchmark.startPrice, 100);
  assert.equal(benchmark.endPrice, 121);
  assert.ok(Math.abs(benchmark.returnPercent - 21) < 1e-9);
  assert.equal(benchmark.coversFullPeriod, true);

  const truncated = computeHoldBenchmark(candles, Date.parse('2026-10-01T00:00:00Z'));
  assert.equal(truncated.coversFullPeriod, false);
  assert.equal(computeHoldBenchmark([], NOW).available, false);
});

test('open positions expose the stop price and the max-hold deadline the risk monitor enforces', () => {
  const trader = {
    lastRiskPrices: { at: NOW - 2000, prices: new Map([['KRW-A', 990]]) },
    strategies: new Map([
      ['KRW-A', {
        config: { stopLossPercent: 1.2, takeProfitPercent: 1.8 },
        maxHoldMs: 30 * 60000,
        maxLosingHoldMs: 0,
        currentPosition: { entryPrice: 1000, amount: 5, entryTime: new Date(NOW - 10 * 60000) }
      }],
      ['KRW-B', { config: {}, currentPosition: null }]
    ])
  };
  const [position, ...rest] = describeOpenPositions(trader, NOW);
  assert.equal(rest.length, 0);
  assert.equal(position.coin, 'KRW-A');
  assert.ok(Math.abs(position.stopLossPrice - 988) < 1e-9);
  assert.ok(Math.abs(position.takeProfitPrice - 1018) < 1e-9);
  assert.equal(position.maxHoldExitAt, new Date(NOW + 20 * 60000).toISOString());
  assert.equal(position.losingHoldExitAt, null);
  assert.equal(position.lastPrice, 990);
  assert.ok(Math.abs(position.unrealizedReturnPercent - (-1)) < 1e-9);

  trader.lastRiskPrices.at = NOW - 10 * 60000;
  assert.equal(describeOpenPositions(trader, NOW)[0].lastPrice, null, 'stale risk prices are not shown');
});

test('GET /api/scorecard is read-only, uses the KST day and compares with holding BTC', async () => {
  const history = [
    closed({ entry: '2026-11-05T00:00:00Z', exit: '2026-11-05T00:10:00Z', exitPrice: 1010, profit: 90 }),
    // 2026-11-06T16:00Z is 01:00 KST on 11-07: today in Korea, yesterday in UTC.
    { ...closed({ entry: '2026-11-06T15:50:00Z', exit: '2026-11-06T16:00:00Z', exitPrice: 995, profit: -60 }), paperExecutionCostModel: 'strict_paper_cost_model_v1' }
  ];
  const snapshot = JSON.stringify(history);
  const trader = {
    dryRun: true,
    exchange: 'upbit',
    initialSeedMoney: 1_000_000,
    config: { checkInterval: 5000 },
    getStrictPaperExecutionCostModel: () => ({ slippageRate: 0.002, tradingFeeRate: 0.0005 }),
    strategies: new Map([['KRW-A', { tradeHistory: history, config: {}, currentPosition: null }]])
  };
  let calls = 0;
  const fetchDayCandles = async (market, count) => {
    calls += 1;
    assert.equal(market, 'KRW-BTC');
    assert.ok(count >= 3);
    return [dayCandle('2026-11-07', 110, 110), dayCandle('2026-11-06', 105, 110), dayCandle('2026-11-05', 100, 105)];
  };
  const options = { now: () => NOW, fetchDayCandles };
  const { status, body } = await request({ tradingSystem: trader }, options);
  assert.equal(status, 200);
  assert.equal(body.available, true);
  assert.equal(body.mode, 'DRY_RUN');
  assert.equal(body.tradeCount, 2);
  assert.equal(body.realizedNetProfit, 30);
  assert.equal(body.verdict, 'insufficient_sample');
  assert.equal(body.today.date, '2026-11-07');
  assert.equal(body.today.tradeCount, 1);
  assert.equal(body.today.realizedNetProfit, -60);
  assert.equal(body.costs.source, 'paper_model');
  assert.equal(body.costs.slippageBooked, true);
  assert.equal(body.costs.slippageRate, 0.002);
  assert.equal(body.costs.unmodeledTradeCount, 1, 'only the trade carrying the paper cost model counts as slippage-booked');
  assert.equal(body.periodStartAt, '2026-11-05T00:00:00.000Z');
  assert.ok(Math.abs(body.benchmark.returnPercent - 10) < 1e-9);
  assert.ok(Math.abs(body.comparison.strategyReturnOnSeedPercent - 0.003) < 1e-9);
  assert.equal(body.comparison.holdProfit, 100_000);
  assert.ok(body.comparison.excessReturnPercent < 0);
  assert.equal(body.engine.stallAfterSeconds, 120);
  assert.deepEqual(body.openPositions, []);
  assert.equal(JSON.stringify(history), snapshot, 'trade history is not mutated');
  assert.equal(calls, 1);
});

test('GET /api/scorecard degrades without trades, for observers and when candles fail', async () => {
  const empty = await request({ tradingSystem: { dryRun: false, exchange: 'upbit', strategies: new Map() } }, {
    now: () => NOW,
    fetchDayCandles: async () => { throw new Error('must not fetch without trades'); }
  });
  assert.equal(empty.body.verdict, 'no_trades');
  assert.equal(empty.body.benchmark.available, false);
  assert.equal(empty.body.costs.source, 'exchange_fills');

  const observer = await request({ tradingSystem: { readOnlyObserver: true } }, { now: () => NOW });
  assert.equal(observer.body.available, false);
  assert.equal(observer.body.reason, 'read_only_observer');

  const failing = await request({
    logApiError: () => {},
    tradingSystem: {
      dryRun: true,
      exchange: 'upbit',
      initialSeedMoney: 1_000_000,
      strategies: new Map([['KRW-A', { tradeHistory: [
        closed({ entry: '2026-11-05T00:00:00Z', exit: '2026-11-05T00:10:00Z', exitPrice: 1010, profit: 90 })
      ] }]])
    }
  }, { now: () => NOW, fetchDayCandles: async () => { throw new Error('network'); } });
  assert.equal(failing.status, 200);
  assert.equal(failing.body.tradeCount, 1);
  assert.deepEqual(failing.body.benchmark, { available: false, reason: 'fetch_failed' });
  assert.equal(failing.body.comparison, null);
});
