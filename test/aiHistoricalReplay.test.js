import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeProviderAttempt, summarizeRows } from '../src/scripts/runAiHistoricalReplay.js';

test('historical replay report는 provider별 실패와 quorum 상태를 보존한다', () => {
  const attempt = summarizeProviderAttempt({
    status: 'COMPLETED',
    results: [
      { provider: 'gpt', status: 'COMPLETED', latencyMs: 100, advice: { action: 'BUY', confidence: 80 } },
      { provider: 'claude', status: 'FAILED', errorCode: 'AI_TIMEOUT', error: 'timeout', latencyMs: 30 }
    ],
    consensus: { action: 'BUY', confidence: 80, providerCount: 1, quorum: false, conflict: false, singleProvider: true }
  });

  assert.equal(attempt.providers.length, 2);
  assert.equal(attempt.providers.find(row => row.provider === 'claude').errorCode, 'AI_TIMEOUT');
  assert.equal(attempt.consensus.quorum, false);
  assert.equal(attempt.consensus.singleProvider, true);
});

test('historical replay summary는 provider와 consensus row를 분리 집계할 수 있다', () => {
  const summary = summarizeRows([
    { provider: 'gpt', action: 'BUY', verdict: 'HIT', signedMovePercent: 0.5 },
    { provider: 'claude', action: 'BUY', verdict: 'HIT', signedMovePercent: 0.5 },
    { provider: 'consensus', action: 'BUY', verdict: 'HIT', signedMovePercent: 0.5 }
  ]);

  assert.equal(summary.gpt.hits, 1);
  assert.equal(summary.claude.hits, 1);
  assert.equal(summary.consensus.hits, 1);
});
