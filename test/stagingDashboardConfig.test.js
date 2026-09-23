import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_STAGING_CHECK_INTERVAL_MS,
  resolveStagingCheckIntervalMs,
  withStagingOutputDir
} from '../src/scripts/stagingDashboardConfig.js';

test('staging 기본 분석 주기는 analysis gap guard와 겹치지 않는 30초다', () => {
  assert.equal(DEFAULT_STAGING_CHECK_INTERVAL_MS, 30_000);
  assert.equal(resolveStagingCheckIntervalMs(undefined), 30_000);
  assert.equal(resolveStagingCheckIntervalMs('not-a-number'), 30_000);
});

test('staging 분석 주기는 명시된 양의 millisecond 값을 보존한다', () => {
  assert.equal(resolveStagingCheckIntervalMs('15000'), 15_000);
  assert.equal(resolveStagingCheckIntervalMs(1_234.9), 1_234);
  assert.equal(resolveStagingCheckIntervalMs(0), 30_000);
});

test('staging child environment overrides inherited output path with its isolated run root', () => {
  const env = withStagingOutputDir({ STAGING_OUTPUT_DIR: '/previous/run', KEEP_SETTING: 'yes' }, '/tmp/current-run');

  assert.equal(env.STAGING_OUTPUT_DIR, '/tmp/current-run');
  assert.equal(env.KEEP_SETTING, 'yes');
});
