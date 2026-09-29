import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readLogTail } from '../src/utils/readLogTail.js';

async function withTemporaryLog(t, content) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coinpilot-log-tail-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'fixture.log');
  await fs.writeFile(filePath, content, 'utf8');
  return filePath;
}

test('readLogTail returns exact lines and count when the whole fixture fits', async t => {
  const filePath = await withTemporaryLog(t, 'first\n두 번째\nthird\n');

  const result = await readLogTail(filePath, { maxLines: 4, maxBytes: 128, chunkBytes: 7 });

  assert.deepEqual(result.lines, ['first', '두 번째', 'third']);
  assert.equal(result.totalLines, 3);
  assert.equal(result.truncated, false);
  assert.equal(result.fileExists, true);
  assert.equal(result.fileSizeBytes, Buffer.byteLength('first\n두 번째\nthird\n'));
});

test('readLogTail stays within its byte budget and drops a partial first record', async t => {
  const content = 'line-0\nline-1\nline-2\nline-3\nline-4\n';
  const filePath = await withTemporaryLog(t, content);

  const result = await readLogTail(filePath, { maxLines: 100, maxBytes: 16, chunkBytes: 5 });

  assert.deepEqual(result.lines, ['line-3', 'line-4']);
  assert.equal(result.totalLines, null);
  assert.equal(result.truncated, true);
  assert.ok(result.bytesRead <= 16);
});

test('readLogTail reports missing files as an empty exact result', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'coinpilot-log-tail-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const result = await readLogTail(path.join(directory, 'missing.log'));

  assert.deepEqual(result, {
    lines: [],
    totalLines: 0,
    truncated: false,
    fileExists: false,
    fileSizeBytes: 0,
    bytesRead: 0
  });
});
