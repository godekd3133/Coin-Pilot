import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluateDailyMomentumRollingWindows
} from '../src/research/dailyMomentumRollingWindowStudy.js';

function daily(count) {
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  return Array.from({ length: count }, (_, index) => {
    const price = 100 + index;
    return {
      candle_date_time_utc: new Date(start + index * 86_400_000).toISOString(),
      opening_price: price,
      high_price: price,
      low_price: price,
      trade_price: price,
      candle_acc_trade_volume: 1
    };
  });
}

test('rolling daily momentum windows never shorten a requested window and stay diagnostic-only', () => {
  const report = evaluateDailyMomentumRollingWindows({
    'KRW-BTC': daily(20),
    'KRW-ETH': daily(20)
  }, {
    windows: [10, 30],
    minimumTradeCount: 1,
    baseConfig: {
      trendLookbackDays: 2,
      trendMinPercent: 0,
      breadthMin: 2,
      minUpBars: 1,
      mode: 'fixed',
      maxHoldDays: 1,
      positionFraction: 0.25,
      maxPositions: 1,
      benchmarkMarket: null,
      volatilityTargetPercent: null,
      costPercent: 0
    }
  });

  assert.equal(report.study, 'daily_momentum_rolling_windows');
  assert.equal(report.researchOnly, true);
  assert.equal(report.promoted, false);
  assert.equal(report.windows.length, 2);
  assert.equal(report.windows[0].windowDays, 10);
  assert.equal(report.windows[0].available, true);
  assert.equal(report.windows[1].windowDays, 30);
  assert.equal(report.windows[1].available, false);
  assert.equal(report.windows[1].status, 'DATA_QUALITY_FAIL');
});

test('rolling window CLI writes a non-promotional report with an explicit config', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-daily-rolling-cli-'));
  const candlesFile = path.join(directory, 'candles.json');
  const reportFile = path.join(directory, 'report.json');
  const start = Date.parse('2026-01-01T00:00:00.000Z');
  const daily = Array.from({ length: 20 }, (_, index) => ({
    candle_date_time_utc: new Date(start + index * 86_400_000).toISOString(),
    opening_price: 100 + index,
    high_price: 100 + index,
    low_price: 100 + index,
    trade_price: 100 + index,
    candle_acc_trade_volume: 1
  }));
  fs.writeFileSync(candlesFile, JSON.stringify({ 'KRW-BTC': daily, 'KRW-ETH': daily }));

  const result = spawnSync(process.execPath, ['src/scripts/validateDailyMomentumRollingWindows.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DAILY_MOMENTUM_ROLLING_CANDLES_FILE: candlesFile,
      DAILY_MOMENTUM_ROLLING_REPORT_FILE: reportFile,
      DAILY_MOMENTUM_ROLLING_MARKETS: 'KRW-BTC,KRW-ETH',
      DAILY_MOMENTUM_ROLLING_WINDOWS: '10',
      DAILY_MOMENTUM_ROLLING_MIN_TRADES: '1',
      DAILY_MOMENTUM_ROLLING_CONFIG_JSON: JSON.stringify({
        mode: 'fixed',
        trendLookbackDays: 2,
        trendMinPercent: 0,
        breadthMin: 2,
        minUpBars: 1,
        maxHoldDays: 1,
        positionFraction: 0.25,
        maxPositions: 1,
        benchmarkMarket: null,
        volatilityTargetPercent: null,
        costPercent: 0,
        entryExecution: 'close'
      })
    }
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(report.study, 'daily_momentum_rolling_windows');
    assert.equal(report.promoted, false);
    assert.equal(report.windows.length, 1);
    assert.equal(report.windows[0].windowDays, 10);
    assert.equal(report.config.mode, 'fixed');
    assert.equal(report.config.maxHoldDays, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
