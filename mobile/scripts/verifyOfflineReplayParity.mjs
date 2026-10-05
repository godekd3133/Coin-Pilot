#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  historicalTimestampForCandle,
  normalizeHistoricalCandles
} from '../../src/backtest/historicalCandleIntegrity.js';
import { simulateScalping } from '../../src/backtest/scalpingBacktest.js';

const ABSOLUTE_TOLERANCE = 1e-8;
const RELATIVE_TOLERANCE = 1e-12;
const BASE_TIMESTAMP = 1_767_225_600_000;
const SWIFT_TIMEOUT_MS = 60_000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

function candle(offsetMinutes, close, { open = close, high = Math.max(open, close), low = Math.min(open, close), volume = 100 } = {}) {
  return {
    timestampMilliseconds: BASE_TIMESTAMP + offsetMinutes * 60_000,
    open,
    high,
    low,
    close,
    volume
  };
}

function baseCandles() {
  const candles = [];
  for (let index = 0; index < 26; index += 1) {
    const close = 120 - index;
    candles.push(candle(index, close, {
      open: close + 0.5,
      high: close + 0.5,
      low: close - 0.5
    }));
  }
  candles.push(candle(26, 96, { open: 95.2, high: 96.4, low: 95 }));
  return candles;
}

function buildRequest(candles) {
  const lastTimestamp = candles.at(-1).timestampMilliseconds;
  return {
    market: 'KRW-BTC',
    intervalMinutes: 1,
    source: 'upbit-public-market-api',
    generatedAt: new Date(lastTimestamp).toISOString(),
    candles
  };
}

function fixtures() {
  const stopGapDown = baseCandles();
  stopGapDown.push(candle(27, 96.2, { open: 96, high: 97.2, low: 95.8 }));
  stopGapDown.push(candle(28, 97, { open: 96.8, high: 97.2, low: 96.8 }));
  stopGapDown.push(candle(29, 96, { open: 96.8, high: 97, low: 95.5 }));
  stopGapDown.push(candle(30, 90, { open: 90, high: 99, low: 89.5 }));

  const ambiguousBar = baseCandles();
  ambiguousBar.push(candle(27, 97.8, { open: 96, high: 99, low: 94 }));
  ambiguousBar.push(candle(28, 97.5, { open: 97.8, high: 98, low: 97.2 }));

  const maximumHold = baseCandles();
  maximumHold.push(candle(27, 96, { open: 96, high: 96.4, low: 95.8 }));
  for (let minute = 28; minute <= 57; minute += 1) {
    maximumHold.push(candle(minute, 96, { open: 96, high: 96.2, low: 95.8 }));
  }

  const backtestEnd = baseCandles();
  backtestEnd.push(candle(27, 96, { open: 96, high: 96.4, low: 95.8 }));
  backtestEnd.push(candle(28, 96.1, { open: 96, high: 96.4, low: 95.8 }));

  return [
    ['stop-gap-down', stopGapDown],
    ['stop-vs-target-ambiguous-bar', ambiguousBar],
    ['max-hold', maximumHold],
    ['backtest-end', backtestEnd]
  ].map(([caseName, candles]) => ({ caseName, request: buildRequest(candles) }));
}

function assertFixtureCandlesMatchNodeInput(caseName, request) {
  const nodeCandles = request.candles.map(item => ({
    timestamp: item.timestampMilliseconds,
    candle_date_time_utc: new Date(item.timestampMilliseconds).toISOString(),
    opening_price: item.open,
    high_price: item.high,
    low_price: item.low,
    trade_price: item.close,
    candle_acc_trade_volume: item.volume
  }));
  const normalized = normalizeHistoricalCandles(nodeCandles);
  if (normalized.length !== request.candles.length) {
    throw new Error(`[${caseName}] fixture mismatch at candles.length: Swift input=${request.candles.length}, Node normalized=${normalized.length}`);
  }

  for (let index = 0; index < request.candles.length; index += 1) {
    const expected = request.candles[index];
    const actual = normalized[index];
    const fields = [
      ['timestampMilliseconds', historicalTimestampForCandle(actual), expected.timestampMilliseconds],
      ['open', actual.opening_price, expected.open],
      ['high', actual.high_price, expected.high],
      ['low', actual.low_price, expected.low],
      ['close', actual.trade_price, expected.close],
      ['volume', actual.candle_acc_trade_volume, expected.volume]
    ];
    for (const [field, nodeValue, swiftValue] of fields) {
      if (nodeValue !== swiftValue) {
        throw new Error(`[${caseName}] fixture mismatch at candles[${index}].${field}: Swift input=${swiftValue}, Node input=${nodeValue}`);
      }
    }
  }

  return nodeCandles;
}

function describe(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function assertEqual(caseName, field, nodeValue, swiftValue) {
  if (nodeValue !== swiftValue) {
    throw new Error(`[${caseName}] parity mismatch at ${field}: Node=${describe(nodeValue)}, Swift=${describe(swiftValue)}`);
  }
}

function assertNear(caseName, field, nodeValue, swiftValue) {
  const tolerance = ABSOLUTE_TOLERANCE + RELATIVE_TOLERANCE * Math.max(Math.abs(nodeValue), Math.abs(swiftValue));
  if (!Number.isFinite(nodeValue) || !Number.isFinite(swiftValue) || Math.abs(nodeValue - swiftValue) > tolerance) {
    throw new Error(`[${caseName}] parity mismatch at ${field}: Node=${nodeValue}, Swift=${swiftValue}, tolerance=${tolerance}`);
  }
}

function parseNodeTime(caseName, field, value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw new Error(`[${caseName}] parity mismatch at ${field}: Node timestamp is invalid (${describe(value)})`);
  }
  return timestamp;
}

function runSwift(binaryPath, caseName, request) {
  const input = `${JSON.stringify(request)}\n`;
  const child = spawnSync(binaryPath, [], {
    input,
    encoding: 'utf8',
    timeout: SWIFT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES
  });

  if (child.error) {
    throw new Error(`[${caseName}] Swift runner failed: ${child.error.message}`);
  }
  if (child.status !== 0) {
    const details = (child.stderr || child.stdout || `exit status ${child.status}`).trim();
    throw new Error(`[${caseName}] Swift replay failed: ${details}`);
  }
  try {
    return JSON.parse(child.stdout);
  } catch (error) {
    throw new Error(
      `[${caseName}] Swift runner emitted invalid JSON: ${error.message}; output=${child.stdout.trim()}`,
      { cause: error }
    );
  }
}

function compareCase(caseName, request, swiftResult) {
  const nodeCandles = assertFixtureCandlesMatchNodeInput(caseName, request);
  // Omitting config is deliberate: this calls simulateScalping with its current
  // in-module DEFAULT_CONFIG, rather than a copied/paraphrased option set.
  const nodeResult = simulateScalping(nodeCandles);
  const nodeOpenEvents = nodeResult.trades.filter(trade => trade.type === 'OPEN');
  const nodeCloseEvents = nodeResult.trades.filter(trade => trade.type === 'CLOSE');
  const swiftTrades = swiftResult.trades;
  const prefix = 'summary';

  assertEqual(caseName, `${prefix}.candleCount/metadata.rowCount`, nodeResult.candleCount, swiftResult.metadata.rowCount);
  assertEqual(caseName, `${prefix}.signals`, nodeResult.metrics.signals, swiftResult.summary.signalCount);
  assertEqual(caseName, `${prefix}.cancelledSignals`, nodeResult.metrics.cancelledSignals, swiftResult.summary.cancelledSignalCount);
  assertEqual(caseName, `${prefix}.openEventCount`, nodeOpenEvents.length, swiftTrades.length);
  assertEqual(caseName, `${prefix}.closeEventCount/completeTradeCount`, nodeCloseEvents.length, swiftResult.summary.completedTradeCount);
  assertEqual(caseName, `${prefix}.tradeCount`, nodeResult.metrics.tradeCount, swiftResult.summary.completedTradeCount);

  assertNear(caseName, `${prefix}.initialBalance`, nodeResult.metrics.initialBalance, swiftResult.summary.initialBalance);
  assertNear(caseName, `${prefix}.finalBalance`, nodeResult.metrics.finalBalance, swiftResult.summary.finalBalance);
  assertNear(caseName, `${prefix}.netProfit`, nodeResult.metrics.netProfit, swiftResult.summary.netProfit);
  assertNear(caseName, `${prefix}.fees`, nodeResult.metrics.fees, swiftResult.summary.fees);

  for (let index = 0; index < nodeCloseEvents.length; index += 1) {
    const opened = nodeOpenEvents[index];
    const closed = nodeCloseEvents[index];
    const swiftTrade = swiftTrades[index];
    const tradePath = `trades[${index}]`;
    assertEqual(caseName, `${tradePath}.reason`, closed.reason, swiftTrade.reason);
    assertEqual(caseName, `${tradePath}.signalTimestampMilliseconds`, parseNodeTime(caseName, `${tradePath}.signalTime`, opened.signalTime), swiftTrade.signalTimestampMilliseconds);
    assertEqual(caseName, `${tradePath}.entryTimestampMilliseconds`, parseNodeTime(caseName, `${tradePath}.entryTime`, opened.entryTime), swiftTrade.entryTimestampMilliseconds);
    assertEqual(caseName, `${tradePath}.exitTimestampMilliseconds`, closed.exitTime, swiftTrade.exitTimestampMilliseconds);

    assertNear(caseName, `${tradePath}.entryPrice`, closed.entryPrice, swiftTrade.entryPrice);
    assertNear(caseName, `${tradePath}.exitPrice`, closed.exitPrice, swiftTrade.exitPrice);
    assertNear(caseName, `${tradePath}.quantity`, closed.amount, swiftTrade.quantity);
    assertNear(caseName, `${tradePath}.investmentAmount`, closed.investAmount, swiftTrade.investmentAmount);
    assertNear(caseName, `${tradePath}.buyFee`, opened.buyFee, swiftTrade.buyFee);
    assertNear(caseName, `${tradePath}.sellFee`, closed.sellFee, swiftTrade.sellFee);
    assertNear(caseName, `${tradePath}.netProfit`, closed.netProfit, swiftTrade.netProfit);
    assertNear(caseName, `${tradePath}.profitPercent`, closed.profitPercent, swiftTrade.profitPercent);
    assertNear(caseName, `${tradePath}.maxFavorableExcursionPercent`, closed.maxFavorableExcursionPercent, swiftTrade.maxFavorableExcursionPercent);
    assertNear(caseName, `${tradePath}.maxAdverseExcursionPercent`, closed.maxAdverseExcursionPercent, swiftTrade.maxAdverseExcursionPercent);
  }
}

function compileSwiftRunner(projectRoot, tempDirectory) {
  const sourcePath = resolve(projectRoot, 'mobile/ios/App/App/CoinPilotOfflineReplay.swift');
  const runnerPath = resolve(projectRoot, 'mobile/tests/OfflineReplayParityRunner.swift');
  const binaryPath = resolve(tempDirectory, 'coinpilot-offline-replay-parity');
  const compile = spawnSync('swiftc', [sourcePath, runnerPath, '-o', binaryPath], {
    encoding: 'utf8',
    timeout: SWIFT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER_BYTES
  });
  if (compile.error) throw new Error(`Swift compile failed: ${compile.error.message}`);
  if (compile.status !== 0) {
    const details = (compile.stderr || compile.stdout || `exit status ${compile.status}`).trim();
    throw new Error(`Swift compile failed: ${details}`);
  }
  return binaryPath;
}

function main() {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(scriptDirectory, '../..');
  const tempDirectory = mkdtempSync(resolve(tmpdir(), 'coinpilot-offline-replay-parity-'));
  try {
    const binaryPath = compileSwiftRunner(projectRoot, tempDirectory);
    const scenarios = fixtures();
    for (const { caseName, request } of scenarios) {
      const swiftResult = runSwift(binaryPath, caseName, request);
      compareCase(caseName, request, swiftResult);
      process.stdout.write(`PASS ${caseName}\n`);
    }
    process.stdout.write(`Offline replay runtime parity: ${scenarios.length}/${scenarios.length} scenarios passed (abs tol ${ABSOLUTE_TOLERANCE}, rel tol ${RELATIVE_TOLERANCE}).\n`);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

main();
