import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildForwardVariantDefinitions,
  createSharedMarketSnapshot,
  resolveForwardVariantNames,
  summarizeVariantLedger
} from '../src/research/forwardVariantRunner.js';
import { buildPaperRunnerConfig } from '../src/research/paperRunnerConfig.js';

const variants = {
  baseline: {},
  volume_15: { minVolumeRatio: 1.5 },
  rebound_25: { minReboundPercent: 0.25 }
};

test('forward variant names are explicit, deduplicated, and fail closed on typos', () => {
  assert.deepEqual(
    resolveForwardVariantNames('baseline, volume_15, baseline', variants),
    ['baseline', 'volume_15']
  );
  assert.deepEqual(
    resolveForwardVariantNames(undefined, variants, ['baseline', 'rebound_25']),
    ['baseline', 'rebound_25']
  );
  assert.throws(
    () => resolveForwardVariantNames('baseline,typo', variants),
    /알 수 없는 forward variant: typo/
  );
});

test('shared snapshot requires one complete ticker/candle payload per market', () => {
  const snapshot = createSharedMarketSnapshot({
    markets: ['KRW-BTC', 'KRW-ETH'],
    tickers: [
      { market: 'KRW-BTC', trade_price: 100 },
      { market: 'KRW-ETH', trade_price: 200 }
    ],
    candlesByMarket: {
      'KRW-BTC': [{ trade_price: 100 }],
      'KRW-ETH': [{ trade_price: 200 }]
    },
    capturedAt: '2026-09-22T00:00:00.000Z'
  });

  assert.equal(snapshot.capturedAt, '2026-09-22T00:00:00.000Z');
  assert.equal(snapshot.tickerMap.get('KRW-BTC').trade_price, 100);
  assert.equal(snapshot.priceMap.get('KRW-ETH'), 200);
  assert.equal(snapshot.marketDataByCoin.get('KRW-BTC').candles.length, 1);
  assert.throws(
    () => createSharedMarketSnapshot({
      markets: ['KRW-BTC', 'KRW-ETH'],
      tickers: [{ market: 'KRW-BTC', trade_price: 100 }],
      candlesByMarket: { 'KRW-BTC': [{ trade_price: 100 }] }
    }),
    /shared snapshot 데이터 누락: KRW-ETH/
  );
});

test('variant definitions copy overrides without sharing mutable objects', () => {
  const definitions = buildForwardVariantDefinitions(['baseline', 'volume_15'], variants);
  assert.deepEqual(definitions, [
    { name: 'baseline', overrides: {} },
    { name: 'volume_15', overrides: { minVolumeRatio: 1.5 } }
  ]);
  assert.notEqual(definitions[1].overrides, variants.volume_15);
});

test('variant config cannot escape the dry-run or runner-owned storage boundary', () => {
  const config = buildPaperRunnerConfig({
    portfolioFile: '/tmp/variant-portfolio.json',
    paperFile: '/tmp/variant-paper.json',
    markets: ['KRW-BTC'],
    variantOverrides: {
      dryRun: false,
      targetCoins: ['KRW-ETH'],
      minReboundPercent: 0.25
    }
  });

  assert.equal(config.dryRun, true);
  assert.deepEqual(config.targetCoins, ['KRW-BTC']);
  assert.equal(config.virtualPortfolioFile, '/tmp/variant-portfolio.json');
  assert.equal(config.paperValidationFile, '/tmp/variant-paper.json');
  assert.equal(config.minReboundPercent, 0.25);
});

test('variant summary counts only closed strict trades and keeps open positions visible', () => {
  const summary = summarizeVariantLedger({
    sessionId: 'paper-test',
    active: false,
    baselineAssets: 1_000_000,
    strictTrades: [
      { profit: 100, exitTime: '2026-09-22T00:01:00.000Z' },
      { profit: -50, exitTime: '2026-09-22T00:02:00.000Z' },
      { profit: 999 }
    ],
    strictOpenPositions: [{ coin: 'KRW-BTC' }]
  }, 'baseline', 1_000_000.05);

  assert.equal(summary.closedTradeCount, 2);
  assert.equal(summary.winningTrades, 1);
  assert.equal(summary.losingTrades, 1);
  assert.equal(summary.realizedProfit, 50);
  assert.equal(summary.openStrictPositions, 1);
  assert.ok(Math.abs(summary.returnPercent - 0.000005) < 1e-12);
});
