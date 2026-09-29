import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ManualOrderIdempotencyStore } from '../api/manualOrderIdempotencyStore.js';

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function writeJsonAtomically(filePath, value) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let descriptor = null;
  let created = false;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
    created = false;
    if (process.platform !== 'win32') {
      const directoryDescriptor = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryDescriptor);
      } finally {
        fs.closeSync(directoryDescriptor);
      }
    }
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* Preserve the write error. */ }
    }
    if (created) {
      try { fs.unlinkSync(temporaryPath); } catch { /* Preserve the write error. */ }
    }
    throw error;
  }
}

/** Append and atomically persist one optimizer history row under a same-host writer lock. */
export async function appendOptimizerHistory(filePath, entryOrFactory, {
  maxEntries = 100,
  lockWaitMs = 5_000,
  now = () => Date.now(),
  sleepImpl = sleep
} = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('optimizer history filePath must be a non-empty path');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError('maxEntries must be a positive safe integer');
  }
  if (!Number.isFinite(lockWaitMs) || lockWaitMs < 0) {
    throw new RangeError('lockWaitMs must be a non-negative finite number');
  }
  if (typeof entryOrFactory !== 'function' && (!entryOrFactory || typeof entryOrFactory !== 'object')) {
    throw new TypeError('optimizer history entry must be an object or a factory');
  }

  const absoluteFilePath = path.resolve(filePath);
  const directory = path.dirname(absoluteFilePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const writerLockPath = `${absoluteFilePath}.optimizer_history_writer.lock`;
  const deadline = now() + lockWaitMs;
  let lockStore = null;
  let lastLockError = null;

  while (!lockStore) {
    const contender = new ManualOrderIdempotencyStore({
      filePath: absoluteFilePath,
      writerLockPath
    });
    try {
      contender.acquireWriterLock();
      lockStore = contender;
    } catch (error) {
      lastLockError = error;
      if (error.code !== 'MANUAL_ORDER_WRITER_LOCK_ACTIVE' || now() >= deadline) throw error;
      await sleepImpl(Math.min(25, Math.max(1, deadline - now())));
    }
  }

  let result;
  let operationError = null;
  try {
    let history = [];
    if (fs.existsSync(absoluteFilePath)) {
      history = JSON.parse(fs.readFileSync(absoluteFilePath, 'utf8'));
      if (!Array.isArray(history)) {
        throw new TypeError('optimizer history file must contain a JSON array');
      }
    }
    const entry = typeof entryOrFactory === 'function'
      ? entryOrFactory(history.slice())
      : entryOrFactory;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError('optimizer history factory must return an object');
    }
    history.push(entry);
    if (history.length > maxEntries) history = history.slice(-maxEntries);
    writeJsonAtomically(absoluteFilePath, history);
    result = { entry, history };
  } catch (error) {
    operationError = error;
  }

  let releaseError = null;
  try {
    lockStore.releaseWriterLock();
  } catch (error) {
    releaseError = error;
  }
  if (operationError) {
    if (releaseError && typeof operationError === 'object') {
      operationError.writerLockReleaseError = releaseError;
    }
    throw operationError;
  }
  if (releaseError) {
    if (lastLockError && typeof lastLockError === 'object') releaseError.previousLockError = lastLockError;
    throw releaseError;
  }
  return result;
}
