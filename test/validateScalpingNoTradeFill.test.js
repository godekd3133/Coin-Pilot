import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runNoTradeFilledValidation } from '../src/scripts/validateScalpingNoTradeFill.js';

function candle(index) {
  const close = 100 + index;
  return {
    candle_date_time_utc: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    opening_price: close,
    high_price: close,
    low_price: close,
    trade_price: close,
    candle_acc_trade_volume: 100
  };
}

test('no-trade flat-fill CLI는 snapshot을 사용하고 promotion을 항상 차단한다', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-no-trade-fill-test-'));
  const cacheFile = path.join(directory, 'candles.json');
  const snapshotFile = path.join(directory, 'paper.json');
  const outputFile = path.join(directory, 'report.json');
  const filledCacheFile = path.join(directory, 'filled-candles.json');
  try {
    fs.writeFileSync(cacheFile, JSON.stringify({
      'KRW-BTC': [candle(2), candle(0)]
    }));
    fs.writeFileSync(snapshotFile, JSON.stringify({
      sessionId: 'no-trade-fill-fixture',
      startedAt: '2026-01-01T00:00:00.000Z',
      configSnapshotComplete: true,
      configSnapshot: {
        candleUnit: 1,
        rsiOversold: 35,
        rsiOverbought: 65
      }
    }));

    const report = runNoTradeFilledValidation({
      inputFile: cacheFile,
      snapshotFile,
      outputFile,
      filledCandleCacheOutputFile: filledCacheFile,
      maxFillIntervals: 10
    });

    assert.equal(report.configSource.sessionId, 'no-trade-fill-fixture');
    assert.equal(report.results[0].syntheticNoTradeCount, 1);
    assert.equal(report.results[0].dataQuality.validForReplay, true);
    assert.equal(report.results[0].validation.promoted, false);
    assert.equal(report.promoted, false);
    assert.equal(report.filledCandleCacheOutputFile, filledCacheFile);
    const filledCache = JSON.parse(fs.readFileSync(filledCacheFile, 'utf8'));
    assert.equal(filledCache['KRW-BTC'].length, 3);
    assert.equal(filledCache['KRW-BTC'][1].isSyntheticNoTrade, true);
    assert.match(report.promotionReason, /research_only/);
    assert.equal(fs.existsSync(outputFile), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
