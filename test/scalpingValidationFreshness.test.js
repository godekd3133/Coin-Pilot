import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SCALPING_VALIDATION_REPORT_MAX_AGE_SECONDS,
  assessScalpingValidationReportFreshness
} from '../src/research/scalpingValidationFreshness.js';

test('validation freshness marks a report within the read-only age budget as fresh', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z');
  const result = assessScalpingValidationReportFreshness(
    '2026-09-16T12:00:00.000Z',
    { now }
  );

  assert.equal(result.fresh, true);
  assert.equal(result.reason, 'fresh');
  assert.equal(result.ageSeconds, 43_200);
  assert.equal(result.maxAgeSeconds, DEFAULT_SCALPING_VALIDATION_REPORT_MAX_AGE_SECONDS);
});

test('validation freshness marks an old report stale without becoming a live gate', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z');
  const result = assessScalpingValidationReportFreshness(
    '2026-09-15T00:00:00.000Z',
    { now, maxAgeSeconds: 86_400 }
  );

  assert.equal(result.fresh, false);
  assert.equal(result.reason, 'stale');
  assert.equal(result.ageSeconds, 172_800);
});

test('validation freshness fails closed for future or malformed timestamps', () => {
  const now = Date.parse('2026-09-17T00:00:00.000Z');
  assert.equal(
    assessScalpingValidationReportFreshness('2026-09-18T00:00:00.000Z', { now }).reason,
    'future_timestamp'
  );
  assert.equal(
    assessScalpingValidationReportFreshness('not-a-timestamp', { now }).reason,
    'timestamp_missing_or_invalid'
  );
});
