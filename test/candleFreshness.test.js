import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectLatestCandleFreshness,
  resolveMaxCandleAgeSeconds
} from '../src/risk/candleFreshness.js';

test('UTC timestamp without a zone is interpreted as UTC and respects the adaptive 1-minute budget', () => {
  const now = Date.parse('2026-09-10T00:02:29Z');
  const result = inspectLatestCandleFreshness([
    { candle_date_time_utc: '2026-09-10T00:01:00' }
  ], { candleUnit: 1, now });

  assert.equal(resolveMaxCandleAgeSeconds(0, 1), 90);
  assert.equal(result.valid, true);
  assert.equal(result.ageMs, 89_000);
  assert.equal(result.source, 'candle_date_time_utc');
});
test('stale, missing, and future candle timestamps fail closed', () => {
  const now = Date.parse('2026-09-10T00:02:31Z');
  const stale = inspectLatestCandleFreshness([
    { candle_date_time_utc: '2026-09-10T00:01:00' }
  ], { candleUnit: 1, maxAgeSeconds: 90, now });
  const missing = inspectLatestCandleFreshness([{}], { candleUnit: 1, now });
  const future = inspectLatestCandleFreshness([
    { candle_date_time_utc: '2026-09-10T00:03:00' }
  ], { candleUnit: 1, now });

  assert.equal(stale.valid, false);
  assert.equal(stale.reason, 'stale_candle_snapshot');
  assert.equal(missing.valid, false);
  assert.equal(missing.reason, 'missing_candle_timestamp');
  assert.equal(future.valid, false);
  assert.equal(future.reason, 'candle_timestamp_in_future');
});

test('KST timestamp is parsed with an explicit KST offset', () => {
  const now = Date.parse('2026-09-09T15:02:00Z');
  const result = inspectLatestCandleFreshness([
    { candle_date_time_kst: '2026-09-10T00:01:00' }
  ], { candleUnit: 1, maxAgeSeconds: 90, now });

  assert.equal(result.valid, true);
  assert.equal(result.ageMs, 60_000);
  assert.equal(result.source, 'candle_date_time_kst');
});
