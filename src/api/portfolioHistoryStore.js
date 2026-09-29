import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const PORTFOLIO_HISTORY_RETENTION_LIMIT = 8640;

export class PortfolioHistoryFormatError extends Error {
  constructor() {
    super('Portfolio history must be a JSON array');
    this.name = 'PortfolioHistoryFormatError';
    this.code = 'portfolio_history_invalid_format';
  }
}

/** Local JSON storage for portfolio snapshots. */
export default class PortfolioHistoryStore {
  constructor({ filePath, retentionLimit = PORTFOLIO_HISTORY_RETENTION_LIMIT, fileSystem = fs } = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('A portfolio history file path is required');
    }
    if (!Number.isSafeInteger(retentionLimit) || retentionLimit < 1) {
      throw new TypeError('Portfolio history retention limit must be a positive integer');
    }

    this.filePath = filePath;
    this.retentionLimit = retentionLimit;
    this.fileSystem = fileSystem;
  }

  readAll() {
    if (!this.fileSystem.existsSync(this.filePath)) return [];

    const history = JSON.parse(this.fileSystem.readFileSync(this.filePath, 'utf8'));
    if (!Array.isArray(history)) throw new PortfolioHistoryFormatError();
    return history;
  }

  /**
   * Replace history atomically through an exclusive owner-only temp file,
   * flushing its contents before rename. Retain only the newest configured
   * number of entries and return the number that were persisted.
   */
  write(history) {
    if (!Array.isArray(history)) throw new TypeError('Portfolio history must be an array');
    const retainedHistory = history.length > this.retentionLimit
      ? history.slice(-this.retentionLimit)
      : history;

    this.fileSystem.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryFile = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const descriptor = this.fileSystem.openSync(temporaryFile, 'wx', 0o600);
      try {
        this.fileSystem.fchmodSync(descriptor, 0o600);
        this.fileSystem.writeFileSync(descriptor, JSON.stringify(retainedHistory, null, 2), 'utf8');
        this.fileSystem.fsyncSync(descriptor);
      } finally {
        this.fileSystem.closeSync(descriptor);
      }
      this.fileSystem.renameSync(temporaryFile, this.filePath);
    } finally {
      try {
        this.fileSystem.rmSync(temporaryFile, { force: true });
      } catch {
        // Preserve the original write or rename error.
      }
    }

    return retainedHistory.length;
  }

  readPeriod(period = '24h', { now, maxPoints = 100 } = {}) {
    const history = this.readAll().map(snapshot => {
      if (!snapshot || typeof snapshot !== 'object') return snapshot;
      return {
        ...snapshot,
        valuationStatus: typeof snapshot.valuationStatus === 'string'
          ? snapshot.valuationStatus
          : 'unknown_legacy'
      };
    });

    const currentTime = now ?? Date.now();
    let cutoff;
    switch (period) {
      case '10s': cutoff = currentTime - 10 * 1000; break;
      case '30s': cutoff = currentTime - 30 * 1000; break;
      case '1m': cutoff = currentTime - 60 * 1000; break;
      case '5m': cutoff = currentTime - 5 * 60 * 1000; break;
      case '15m': cutoff = currentTime - 15 * 60 * 1000; break;
      case '30m': cutoff = currentTime - 30 * 60 * 1000; break;
      case '1h': cutoff = currentTime - 60 * 60 * 1000; break;
      case '24h': cutoff = currentTime - 24 * 60 * 60 * 1000; break;
      case '7d': cutoff = currentTime - 7 * 24 * 60 * 60 * 1000; break;
      case '30d': cutoff = currentTime - 30 * 24 * 60 * 60 * 1000; break;
      default: cutoff = currentTime - 24 * 60 * 60 * 1000;
    }

    let selected = history.filter(snapshot =>
      snapshot && typeof snapshot === 'object' && new Date(snapshot.timestamp).getTime() > cutoff
    );

    if (selected.length > maxPoints) {
      const step = Math.ceil(selected.length / maxPoints);
      selected = selected.filter((_, index) => index % step === 0);
    }

    return { data: selected, period, count: selected.length };
  }
}
