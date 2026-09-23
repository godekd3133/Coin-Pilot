import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Logger, { resolveLogDirectory } from '../src/utils/logger.js';

function tempLogDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coin-pilot-logs-'));
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test('file output is one structured JSON object per line', async () => {
  const logDir = tempLogDir();
  const logger = new Logger('debug', { logDir });

  logger.info('cycle complete', { cycles: 5, markets: ['KRW-BTC'] });
  logger.warn('stale feed');
  await logger.flush();

  const lines = readJsonLines(logger.logFile);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].level, 'info');
  assert.equal(lines[0].msg, 'cycle complete');
  assert.deepEqual(lines[0].data, { cycles: 5, markets: ['KRW-BTC'] });
  assert.ok(!Number.isNaN(Date.parse(lines[0].ts)));
  assert.equal(lines[1].level, 'warn');
  assert.equal(lines[1].msg, 'stale feed');
  assert.equal(lines[1].data, undefined);
});

test('error logs land in both the daily file and the error file', async () => {
  const logDir = tempLogDir();
  const logger = new Logger('info', { logDir });

  logger.error('order failed', { market: 'KRW-BTC' });
  await logger.flush();

  assert.equal(readJsonLines(logger.logFile).length, 1);
  const errorLines = readJsonLines(logger.errorFile);
  assert.equal(errorLines.length, 1);
  assert.equal(errorLines[0].level, 'error');
});

test('Error instances serialize with name/message/stack instead of {}', async () => {
  const logDir = tempLogDir();
  const logger = new Logger('debug', { logDir });

  logger.error('boom', { error: new TypeError('bad candle') });
  await logger.flush();

  const [line] = readJsonLines(logger.logFile);
  assert.equal(line.data.error.name, 'TypeError');
  assert.equal(line.data.error.message, 'bad candle');
  assert.ok(line.data.error.stack.includes('TypeError'));
});

test('circular payloads degrade to [Circular] instead of throwing', async () => {
  const logDir = tempLogDir();
  const logger = new Logger('debug', { logDir });
  const cyclic = { note: 'axios-like' };
  cyclic.self = cyclic;

  assert.doesNotThrow(() => logger.error('request failed', { error: cyclic }));
  await logger.flush();

  const [line] = readJsonLines(logger.logFile);
  assert.equal(line.data.error.self, '[Circular]');
});

test('level filtering keeps quieter levels out of the file', async () => {
  const logDir = tempLogDir();
  const logger = new Logger('warn', { logDir });

  logger.debug('hidden');
  logger.info('also hidden');
  logger.warn('visible');
  await logger.flush();

  const lines = readJsonLines(logger.logFile);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].level, 'warn');
});

test('trade and performance lanes stay JSONL with their existing fields', async () => {
  const logDir = tempLogDir();
  const logger = new Logger('info', { logDir });

  logger.trade('BUY', { market: 'KRW-BTC', price: 100 });
  logger.performance({ totalTrades: 3 });
  await logger.flush();

  const [tradeLine] = readJsonLines(path.join(logDir, 'trades.log'));
  assert.equal(tradeLine.action, 'BUY');
  assert.equal(tradeLine.market, 'KRW-BTC');
  assert.ok(tradeLine.timestamp);

  const [perfLine] = readJsonLines(path.join(logDir, 'performance.log'));
  assert.equal(perfLine.totalTrades, 3);
});

test('cleanOldLogs removes aged log/report files but leaves other files alone', () => {
  const logDir = tempLogDir();
  const logger = new Logger('info', { logDir });
  const old = Date.now() - 9 * 24 * 60 * 60 * 1000;

  const agedLog = path.join(logDir, 'trading-2000-01-01.log');
  const agedReport = path.join(logDir, 'report-2000-01-01.txt');
  const agedOther = path.join(logDir, 'keep-me.json');
  const freshLog = path.join(logDir, 'trading-fresh.log');
  for (const file of [agedLog, agedReport, agedOther]) {
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, old / 1000, old / 1000);
  }
  fs.writeFileSync(freshLog, 'x');

  logger.cleanOldLogs(7);

  assert.equal(fs.existsSync(agedLog), false);
  assert.equal(fs.existsSync(agedReport), false);
  assert.equal(fs.existsSync(agedOther), true);
  assert.equal(fs.existsSync(freshLog), true);
});

test('staging output routes the default logger and retention cleanup into the isolated run directory', () => {
  const previousStagingOutputDir = process.env.STAGING_OUTPUT_DIR;
  const stagingRoot = tempLogDir();
  const workspaceRoot = tempLogDir();
  const old = Date.now() - 9 * 24 * 60 * 60 * 1000;
  const workspaceLogs = path.join(workspaceRoot, 'logs');
  fs.mkdirSync(workspaceLogs, { recursive: true });
  const workspaceLog = path.join(workspaceLogs, 'trading-old.log');
  fs.writeFileSync(workspaceLog, 'preserve');
  fs.utimesSync(workspaceLog, old / 1000, old / 1000);

  try {
    process.env.STAGING_OUTPUT_DIR = stagingRoot;
    const logger = new Logger('info');
    const stagedOldLog = path.join(logger.logDir, 'trading-old.log');
    fs.writeFileSync(stagedOldLog, 'staging');
    fs.utimesSync(stagedOldLog, old / 1000, old / 1000);

    assert.equal(logger.logDir, path.join(stagingRoot, 'logs'));
    assert.equal(resolveLogDirectory(workspaceRoot, stagingRoot), path.join(stagingRoot, 'logs'));

    logger.cleanOldLogs(7);

    assert.equal(fs.existsSync(stagedOldLog), false);
    assert.equal(fs.readFileSync(workspaceLog, 'utf8'), 'preserve');
  } finally {
    if (previousStagingOutputDir === undefined) delete process.env.STAGING_OUTPUT_DIR;
    else process.env.STAGING_OUTPUT_DIR = previousStagingOutputDir;
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
