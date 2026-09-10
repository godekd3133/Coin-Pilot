import assert from 'node:assert/strict';
import test from 'node:test';
import { selectFreshMarketCohort, summarizeMarketFreshness } from '../src/research/marketQuality.js';

test('시장별 freshness 표본과 차단률을 계산한다', () => {
  const rows = summarizeMarketFreshness({
    markets: ['KRW-BTC', 'KRW-ETH'],
    telemetry: {
      candleFreshnessObservedByCoin: { 'KRW-BTC': 100, 'KRW-ETH': 80 },
      candleFreshnessBlockedByCoin: { 'KRW-BTC': 2, 'KRW-ETH': 8 },
      candleFreshnessAgeStatsByCoin: {
        'KRW-BTC': { totalAgeSeconds: 4200, maxObservedAgeSeconds: 70 },
        'KRW-ETH': { totalAgeSeconds: 4800, maxObservedAgeSeconds: 110 }
      }
    }
  });

  assert.deepEqual(rows.map(row => row.market), ['KRW-BTC', 'KRW-ETH']);
  assert.equal(rows[0].freshnessBlocks, 2);
  assert.equal(rows[0].freshnessBlockRate, 0.02);
  assert.equal(rows[0].averageAgeSeconds, 42);
  assert.equal(rows[1].freshnessBlockRate, 0.1);
});

test('freshness 코호트는 표본 부족과 높은 차단률을 fail-closed로 제외한다', () => {
  const result = selectFreshMarketCohort({
    markets: ['KRW-BTC', 'KRW-ETH', 'KRW-XRP', 'KRW-SOL'],
    minObservations: 100,
    maxFreshnessBlockRate: 0.05,
    maxMarkets: 3,
    telemetry: {
      candleFreshnessObservedByCoin: {
        'KRW-BTC': 120,
        'KRW-ETH': 120,
        'KRW-XRP': 40,
        'KRW-SOL': 120
      },
      candleFreshnessBlockedByCoin: {
        'KRW-BTC': 0,
        'KRW-ETH': 12,
        'KRW-XRP': 0,
        'KRW-SOL': 1
      },
      candleFreshnessAgeStatsByCoin: {
        'KRW-BTC': { totalAgeSeconds: 3600 },
        'KRW-ETH': { totalAgeSeconds: 3600 },
        'KRW-XRP': { totalAgeSeconds: 1200 },
        'KRW-SOL': { totalAgeSeconds: 6000 }
      }
    }
  });

  assert.deepEqual(result.selectedMarkets, ['KRW-BTC', 'KRW-SOL']);
  assert.equal(result.excludedRows.find(row => row.market === 'KRW-ETH').exclusionReason, 'freshness_block_rate_too_high');
  assert.equal(result.excludedRows.find(row => row.market === 'KRW-XRP').exclusionReason, 'insufficient_observations');
});

test('코호트 선택 상한을 넘으면 원래 시장 순서를 유지한 채 제한한다', () => {
  const result = selectFreshMarketCohort({
    markets: ['KRW-B', 'KRW-A', 'KRW-C'],
    minObservations: 10,
    maxFreshnessBlockRate: 0.05,
    maxMarkets: 2,
    telemetry: {
      candleFreshnessObservedByCoin: { 'KRW-C': 10, 'KRW-A': 10, 'KRW-B': 10 },
      candleFreshnessBlockedByCoin: { 'KRW-C': 0, 'KRW-A': 0, 'KRW-B': 0 },
      candleFreshnessAgeStatsByCoin: {
        'KRW-C': { totalAgeSeconds: 30 },
        'KRW-A': { totalAgeSeconds: 10 },
        'KRW-B': { totalAgeSeconds: 20 }
      }
    }
  });

  assert.deepEqual(result.selectedMarkets, ['KRW-B', 'KRW-A']);
  assert.equal(result.excludedRows.find(row => row.market === 'KRW-C').exclusionReason, 'market_limit');
});
