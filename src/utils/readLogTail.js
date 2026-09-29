import { open } from 'node:fs/promises';

const DEFAULT_MAX_LINES = 500;
const MAX_LINES = 1000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 16 * 1024;

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(number)));
}

/**
 * Read a bounded suffix of a log without blocking the event loop or loading
 * the whole file into memory. `totalLines` is null when the byte/line bound
 * means the complete file was not inspected.
 */
export async function readLogTail(filePath, options = {}) {
  const maxLines = boundedInteger(options.maxLines, DEFAULT_MAX_LINES, 1, MAX_LINES);
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 1, DEFAULT_MAX_BYTES);
  const chunkBytes = Math.min(
    maxBytes,
    boundedInteger(options.chunkBytes, DEFAULT_CHUNK_BYTES, 1, DEFAULT_CHUNK_BYTES)
  );

  let file;
  try {
    file = await open(filePath, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        lines: [],
        totalLines: 0,
        truncated: false,
        fileExists: false,
        fileSizeBytes: 0,
        bytesRead: 0
      };
    }
    throw error;
  }

  try {
    const { size } = await file.stat();
    if (size === 0) {
      return {
        lines: [],
        totalLines: 0,
        truncated: false,
        fileExists: true,
        fileSizeBytes: 0,
        bytesRead: 0
      };
    }

    let position = size;
    let bytesRead = 0;
    let newlineCount = 0;
    const chunks = [];

    while (position > 0 && bytesRead < maxBytes && newlineCount <= maxLines) {
      const length = Math.min(chunkBytes, position, maxBytes - bytesRead);
      if (length <= 0) break;

      const start = position - length;
      const chunk = Buffer.allocUnsafe(length);
      const result = await file.read(chunk, 0, length, start);
      if (result.bytesRead <= 0) break;

      const content = chunk.subarray(0, result.bytesRead);
      chunks.unshift(content);
      bytesRead += result.bytesRead;
      position = start;
      for (const byte of content) {
        if (byte === 0x0a) newlineCount += 1;
      }
    }

    const reachedBeginning = position === 0;
    let text = Buffer.concat(chunks).toString('utf8');
    if (!reachedBeginning) {
      // The first captured line may start midway through a UTF-8 sequence or
      // record. Drop it; the remaining suffix starts on a complete line.
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }

    const allLines = text
      .split('\n')
      .map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
      .filter(line => line.trim().length > 0);
    const totalLines = reachedBeginning ? allLines.length : null;
    const lineLimitExceeded = allLines.length > maxLines;
    const lines = lineLimitExceeded ? allLines.slice(-maxLines) : allLines;

    return {
      lines,
      totalLines,
      truncated: !reachedBeginning || lineLimitExceeded,
      fileExists: true,
      fileSizeBytes: size,
      bytesRead
    };
  } finally {
    await file.close();
  }
}
