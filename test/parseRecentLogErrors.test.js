import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRecentLogErrors } from '../src/utils/parseRecentLogErrors.js';

test('parseRecentLogErrors selects structured error records and skips other levels', () => {
  const info = JSON.stringify({ ts: '2026-09-29T00:00:00.000Z', level: 'info', msg: 'started' });
  const error = JSON.stringify({ ts: '2026-09-29T00:00:01.000Z', level: 'error', msg: 'failed' });

  assert.deepEqual(parseRecentLogErrors([info, error]), [error]);
});

test('parseRecentLogErrors keeps legacy multi-line error entries together', () => {
  const lines = [
    '[2026-09-29T00:00:00.000Z] [ERROR] old failure',
    '{"code":"E_FAKE"}',
    '[2026-09-29T00:00:01.000Z] [ERROR] second failure'
  ];

  assert.deepEqual(parseRecentLogErrors(lines), [
    '[2026-09-29T00:00:00.000Z] [ERROR] old failure\n{"code":"E_FAKE"}',
    '[2026-09-29T00:00:01.000Z] [ERROR] second failure'
  ]);
});

test('parseRecentLogErrors bounds entry count and characters', () => {
  const entries = Array.from({ length: 3 }, (_, index) => JSON.stringify({ level: 'error', msg: `failure-${index}` }));

  assert.deepEqual(parseRecentLogErrors(entries, { limit: 2, maxCharacters: 20 }), [
    `${entries[1].substring(0, 20)}...(truncated)`,
    `${entries[2].substring(0, 20)}...(truncated)`
  ]);
});
