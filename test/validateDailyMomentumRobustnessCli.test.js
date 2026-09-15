import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function daily(count = 24) {
  const start = Date.parse('2020-01-01T00:00:00.000Z');
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

test('robustness CLI maps allocation and protection axes into one reproducible variant', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-daily-robustness-cli-'));
  const candlesFile = path.join(directory, 'candles.json');
  const reportFile = path.join(directory, 'report.json');
  fs.writeFileSync(candlesFile, JSON.stringify({
    'KRW-BTC': daily(),
    'KRW-ETH': daily()
  }));

  const result = spawnSync(process.execPath, ['src/scripts/validateDailyMomentumRobustness.js'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      DAILY_MOMENTUM_MARKETS: 'KRW-BTC,KRW-ETH',
      DAILY_MOMENTUM_CANDLES_FILE: candlesFile,
      DAILY_MOMENTUM_ROBUSTNESS_REPORT_FILE: reportFile,
      DAILY_MOMENTUM_ROBUSTNESS_SEGMENTS: '2',
      DAILY_MOMENTUM_ROBUSTNESS_MIN_TRADES: '1',
      DAILY_MOMENTUM_ROBUSTNESS_TREND_MIN_PERCENT: '2',
      DAILY_MOMENTUM_ROBUSTNESS_BREADTH_MIN: '2',
      DAILY_MOMENTUM_ROBUSTNESS_POSITION_FRACTION: '0.125',
      DAILY_MOMENTUM_ROBUSTNESS_MAX_POSITIONS: '2',
      DAILY_MOMENTUM_ROBUSTNESS_COOLDOWN_AFTER_LOSS_DAYS: '3',
      DAILY_MOMENTUM_ROBUSTNESS_MAX_PORTFOLIO_DRAWDOWN_PERCENT: '15',
      DAILY_MOMENTUM_ROBUSTNESS_MODES: 'fixed',
      DAILY_MOMENTUM_ROBUSTNESS_MAX_HOLD_DAYS: '1',
      DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_THRESHOLDS: '2',
      DAILY_MOMENTUM_ROBUSTNESS_MIN_UP_BARS: '1',
      DAILY_MOMENTUM_ROBUSTNESS_BENCHMARK_EXIT_CONFIRMATION_BARS: '1',
      DAILY_MOMENTUM_ROBUSTNESS_REGIME_EXIT_CONFIRMATION_BARS: '1',
      DAILY_MOMENTUM_ROBUSTNESS_VOLATILITY_LOOKBACK_DAYS: '14',
      DAILY_MOMENTUM_ROBUSTNESS_STOP_LOSS_PERCENT: '0'
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.variants.length, 1);
  assert.equal(report.variants[0].config.trendMinPercent, 2);
  assert.equal(report.variants[0].config.breadthMin, 2);
  assert.equal(report.variants[0].config.positionFraction, 0.125);
  assert.equal(report.variants[0].config.maxPositions, 2);
  assert.equal(report.variants[0].config.cooldownAfterLossDays, 3);
  assert.equal(report.variants[0].config.maxPortfolioDrawdownPercent, 15);
  assert.equal(report.variants[0].config.mode, 'fixed');
  assert.equal(report.variants[0].config.maxHoldDays, 1);
  assert.equal(report.promoted, false);
});
