import fs from 'node:fs';
import path from 'node:path';

/**
 * Memoize file reads only for the lifetime of one caller-created request.
 * Callers must create a new snapshot at their request boundary; this module
 * has no process-wide cache, timers, or filesystem freshness heuristics.
 */
export function createRequestLocalFileSnapshot({
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync
} = {}) {
  const existenceByPath = new Map();
  const textByPath = new Map();
  const jsonByPath = new Map();

  const keyFor = file => path.resolve(Buffer.isBuffer(file) ? file.toString() : String(file));

  function fileExists(file) {
    const key = keyFor(file);
    if (existenceByPath.has(key)) return existenceByPath.get(key);
    const exists = existsSync(file);
    existenceByPath.set(key, exists);
    return exists;
  }

  function readText(file) {
    const key = keyFor(file);
    const cached = textByPath.get(key);
    if (cached) {
      if (cached.error) throw cached.error;
      return cached.value;
    }
    try {
      const value = readFileSync(file, 'utf8');
      textByPath.set(key, { value });
      existenceByPath.set(key, true);
      return value;
    } catch (error) {
      textByPath.set(key, { error });
      if (error?.code === 'ENOENT') existenceByPath.set(key, false);
      throw error;
    }
  }

  function readJsonOrThrow(file) {
    const key = keyFor(file);
    const cached = jsonByPath.get(key);
    if (cached) {
      if (cached.error) throw cached.error;
      return cached.value;
    }
    try {
      const value = JSON.parse(readText(file));
      jsonByPath.set(key, { value });
      return value;
    } catch (error) {
      jsonByPath.set(key, { error });
      throw error;
    }
  }

  function readJson(file) {
    try {
      return readJsonOrThrow(file);
    } catch {
      return null;
    }
  }

  return Object.freeze({
    existsSync: fileExists,
    readText,
    readJson,
    readJsonOrThrow
  });
}
