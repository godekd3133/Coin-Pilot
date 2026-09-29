import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ManualOrderIdempotencyStore } from '../src/api/manualOrderIdempotencyStore.js';
import { appendOptimizerHistory } from '../src/runtime/optimizerHistoryStore.js';

function makeRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-optimizer-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('optimizer history serializes cross-process writers and preserves every appended row', async t => {
  const root = makeRoot(t);
  const historyFile = path.join(root, 'state', 'optimization_history.json');
  const lockPath = `${historyFile}.optimizer_history_writer.lock`;
  const owner = new ManualOrderIdempotencyStore({ filePath: historyFile, writerLockPath: lockPath });
  owner.acquireWriterLock();

  let appendFinished = false;
  const appendPromise = appendOptimizerHistory(historyFile, history => ({
    timestamp: new Date().toISOString(),
    cycle: history.length + 1,
    source: 'dashboard'
  }), { lockWaitMs: 2_000 }).then(result => {
    appendFinished = true;
    return result;
  });

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(appendFinished, false, 'a second writer must wait for the current owner');
  owner.releaseWriterLock();

  const result = await appendPromise;
  assert.deepEqual(result.entry, {
    timestamp: result.entry.timestamp,
    cycle: 1,
    source: 'dashboard'
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(historyFile, 'utf8')), [result.entry]);
  assert.equal(fs.existsSync(lockPath), false);
});

test('optimizer history reloads under lock and trims only after append', async t => {
  const root = makeRoot(t);
  const historyFile = path.join(root, 'optimization_history.json');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(historyFile, JSON.stringify([{ id: 1 }, { id: 2 }]), 'utf8');

  const result = await appendOptimizerHistory(historyFile, history => ({ id: history.length + 1 }), { maxEntries: 2 });

  assert.deepEqual(result.history, [{ id: 2 }, { id: 3 }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(historyFile, 'utf8')), result.history);
  assert.deepEqual(fs.readdirSync(root), ['optimization_history.json']);
});

test('malformed optimizer history fails without replacing the original bytes', async t => {
  const root = makeRoot(t);
  const historyFile = path.join(root, 'optimization_history.json');
  const original = '{not-json';
  fs.writeFileSync(historyFile, original, 'utf8');

  await assert.rejects(appendOptimizerHistory(historyFile, { id: 1 }), SyntaxError);
  assert.equal(fs.readFileSync(historyFile, 'utf8'), original);
  assert.equal(fs.existsSync(`${historyFile}.optimizer_history_writer.lock`), false);
});
