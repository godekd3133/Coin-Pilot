import test from 'node:test';
import assert from 'node:assert/strict';
import { rankMomentumShadowEntryCandidates } from '../src/research/momentumShadowCandidateSelection.js';

test('momentum shadow candidate selection ranks trend strength before market order', () => {
  const candidates = [
    { market: 'KRW-ETH', trendPercent: 3 },
    { market: 'KRW-BTC', trendPercent: 5 },
    { market: 'KRW-XRP', trendPercent: 5 }
  ];

  assert.deepEqual(
    rankMomentumShadowEntryCandidates(candidates).map(candidate => candidate.market),
    ['KRW-BTC', 'KRW-XRP', 'KRW-ETH']
  );
  assert.deepEqual(candidates.map(candidate => candidate.market), [
    'KRW-ETH',
    'KRW-BTC',
    'KRW-XRP'
  ]);
});

test('runner-shaped candidates still rank by the signal trend before market order', () => {
  const candidates = [
    { market: 'KRW-ETH', signal: { signalKey: '2026-09-14T00:00:00', trendPercent: 3 }, volatilityScale: 1, bars: [] },
    { market: 'KRW-BTC', signal: { signalKey: '2026-09-14T00:00:00', trendPercent: 5 }, volatilityScale: 0.5, bars: [] },
    { market: 'KRW-XRP', signal: { signalKey: '2026-09-14T00:00:00', trendPercent: 5 }, volatilityScale: 1, bars: [] }
  ];

  assert.deepEqual(
    rankMomentumShadowEntryCandidates(candidates).map(candidate => candidate.market),
    ['KRW-BTC', 'KRW-XRP', 'KRW-ETH']
  );
});
