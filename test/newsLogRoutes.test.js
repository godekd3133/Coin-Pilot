import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import createNewsRoutes from '../src/api/routes/news.js';

async function startLogRoute(t, logDir) {
  const app = express();
  app.use('/api', createNewsRoutes({ logger: { logDir } }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coinpilot-news-logs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('/api/logs reads the logger-owned directory and reports a bounded tail', async t => {
  const logDir = await temporaryDirectory(t);
  const today = new Date().toISOString().split('T')[0];
  await fs.writeFile(path.join(logDir, `trading-${today}.log`), 'first\nsecond\nthird\n');
  const baseUrl = await startLogRoute(t, logDir);

  const response = await fetch(`${baseUrl}/api/logs?type=trading&lines=2`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.logs, ['second', 'third']);
  assert.equal(body.total, 3);
  assert.equal(body.truncated, true);
  assert.equal(body.fileSizeBytes, Buffer.byteLength('first\nsecond\nthird\n'));
});

test('/api/logs keeps the missing-file message without reading the project log directory', async t => {
  const logDir = await temporaryDirectory(t);
  const baseUrl = await startLogRoute(t, logDir);

  const response = await fetch(`${baseUrl}/api/logs?type=error`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.logs, []);
  assert.equal(body.total, 0);
  assert.equal(body.truncated, false);
  assert.equal(body.message, 'Log file not found');
});
