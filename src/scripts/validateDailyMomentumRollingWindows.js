import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_DAILY_MOMENTUM_ROLLING_CONFIG,
  DEFAULT_DAILY_MOMENTUM_ROLLING_WINDOWS,
  evaluateDailyMomentumRollingWindows
} from '../research/dailyMomentumRollingWindowStudy.js';

dotenv.config();

const inputFile = process.env.DAILY_MOMENTUM_ROLLING_CANDLES_FILE || process.argv[2];
const outputFile = process.env.DAILY_MOMENTUM_ROLLING_REPORT_FILE ||
  process.argv[3] || '/private/tmp/coinpilot-daily-momentum-rolling-report.json';

function loadCandles(file) {
  if (!file || !fs.existsSync(file)) {
    throw new Error('FAIL_CLOSED: DAILY_MOMENTUM_ROLLING_CANDLES_FILE 또는 첫 번째 인자로 daily candle cache를 지정하세요.');
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const candles = parsed?.candles && typeof parsed.candles === 'object' ? parsed.candles : parsed;
  if (!candles || typeof candles !== 'object' || Array.isArray(candles)) {
    throw new Error('FAIL_CLOSED: daily candle cache 형식이 잘못되었습니다.');
  }
  const requestedMarkets = (process.env.DAILY_MOMENTUM_ROLLING_MARKETS ||
    Object.keys(candles).join(','))
    .split(',').map(market => market.trim().toUpperCase()).filter(Boolean);
  const markets = [...new Set(requestedMarkets)];
  const missing = markets.filter(market => !Array.isArray(candles[market]));
  if (missing.length) throw new Error(`FAIL_CLOSED: cache에 시장 데이터가 없습니다: ${missing.join(', ')}`);
  return {
    candles: Object.fromEntries(markets.map(market => [market, candles[market]])),
    markets
  };
}

function parseWindows(value) {
  if (!value) return [...DEFAULT_DAILY_MOMENTUM_ROLLING_WINDOWS];
  const windows = value.split(',').map(Number).filter(Number.isFinite);
  return windows.length ? windows : [...DEFAULT_DAILY_MOMENTUM_ROLLING_WINDOWS];
}

function parseConfig() {
  const raw = process.env.DAILY_MOMENTUM_ROLLING_CONFIG_JSON;
  if (!raw) return { ...DEFAULT_DAILY_MOMENTUM_ROLLING_CONFIG };
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`FAIL_CLOSED: DAILY_MOMENTUM_ROLLING_CONFIG_JSON 형식 오류: ${error.message}`, { cause: error }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FAIL_CLOSED: DAILY_MOMENTUM_ROLLING_CONFIG_JSON은 객체여야 합니다.');
  }
  return { ...DEFAULT_DAILY_MOMENTUM_ROLLING_CONFIG, ...parsed };
}

function main() {
  const { candles, markets } = loadCandles(inputFile);
  const report = evaluateDailyMomentumRollingWindows(candles, {
    windows: parseWindows(process.env.DAILY_MOMENTUM_ROLLING_WINDOWS),
    baseConfig: parseConfig(),
    minimumTradeCount: Number(process.env.DAILY_MOMENTUM_ROLLING_MIN_TRADES) || 30
  });
  const output = { ...report, inputFile, markets, promoted: false };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
  console.log(`daily momentum rolling windows: ${markets.length} markets · ${inputFile}`);
  output.windows.forEach(row => {
    const metrics = row.metrics || {};
    console.log(`${row.windowDays}d: ${row.status} · ` +
      `return ${Number.isFinite(Number(metrics.totalReturnPercent)) ? Number(metrics.totalReturnPercent).toFixed(3) : '—'}% · ` +
      `PF ${Number.isFinite(Number(metrics.profitFactor)) ? Number(metrics.profitFactor).toFixed(2) : '—'} · ` +
      `MDD ${Number.isFinite(Number(metrics.maxDrawdownPercent)) ? Number(metrics.maxDrawdownPercent).toFixed(2) : '—'}% · ` +
      `trades ${row.tradeCount} · gaps blocked ${row.entryGapBlockedCount}`);
  });
  console.log(`saved: ${outputFile}`);
}

try { main(); }
catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
