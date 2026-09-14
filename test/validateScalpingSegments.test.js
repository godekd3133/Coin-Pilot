import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSegmentedValidation } from '../src/scripts/validateScalpingSegments.js';

function candle(index) {
  const close = 100 + (index % 3);
  return {
    candle_date_time_utc: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    opening_price: close,
    high_price: close + 1,
    low_price: close - 1,
    trade_price: close,
    candle_acc_trade_volume: 100
  };
}

test('segmented validation CLI uses the authoritative paper snapshot and stays diagnostic-only', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-segmented-test-'));
  const cacheFile = path.join(directory, 'candles.json');
  const snapshotFile = path.join(directory, 'paper.json');
  const outputFile = path.join(directory, 'report.json');
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({ 'KRW-BTC': Array.from({ length: 30 }, (_, index) => candle(index)) }));
    fs.writeFileSync(snapshotFile, JSON.stringify({
      sessionId: 'segmented-fixture',
      startedAt: '2026-01-01T00:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: {
        candleUnit: 1,
        rsiOversold: 35,
        rsiOverbought: 65,
        signalProfile: 'rsi_rebound'
      }
    }));

    const report = runSegmentedValidation({
      cacheFile,
      snapshotFile,
      outputFile,
      minimumSegmentCandles: 10
    });

    assert.equal(report.config.rsiOversold, 35);
    assert.equal(report.config.rsiOverbought, 65);
    assert.equal(report.results[0].dataQuality.raw.valid, true);
    assert.equal(report.promoted, false);
    assert.equal(report.validationMode, 'segmented_diagnostic_only');
    assert.equal(fs.existsSync(outputFile), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
