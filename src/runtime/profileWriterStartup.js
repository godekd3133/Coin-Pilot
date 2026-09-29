import path from 'path';
import { createDefaultManualOrderIdempotencyStore } from '../api/manualOrderIdempotencyStore.js';
import { resolveVirtualPortfolioFile, resolveVirtualPortfolioStoragePath } from './profileStoragePlan.js';

export { resolveVirtualPortfolioFile };

/**
 * Hold the profile writer lock before MultiCoinTrader reads or migrates the
 * portfolio, then move that exact ownership handle onto the full store.
 */
export function createProfileWriterStartup(config, options = {}) {
  if (!config || typeof config !== 'object') {
    throw new TypeError('A runtime config is required to lock the profile before trader startup.');
  }

  const virtualPortfolioFile = resolveVirtualPortfolioStoragePath(config, options).absolutePath;
  // Capture the selected physical path before acquiring the lock. The trader
  // then receives the same absolute target even if the process cwd later changes.
  config.virtualPortfolioFile = virtualPortfolioFile;
  const idempotencyFile = config.manualOrderIdempotencyFile ||
    `${path.resolve(virtualPortfolioFile)}.manual_order_idempotency.json`;
  const lockOwnerStore = createDefaultManualOrderIdempotencyStore({
    dryRun: config.dryRun === true,
    config,
    virtualPortfolioFile
  }, idempotencyFile);
  const journalLockPath = `${path.resolve(idempotencyFile)}.manual_order_journal_writer.lock`;
  const journalLockOwnerStore = createDefaultManualOrderIdempotencyStore({
    dryRun: config.dryRun === true,
    config,
    virtualPortfolioFile
  }, idempotencyFile, { writerLockPath: journalLockPath });

  lockOwnerStore.acquireWriterLock();
  try {
    journalLockOwnerStore.acquireWriterLock();
  } catch (error) {
    try {
      lockOwnerStore.releaseWriterLock();
    } catch (releaseError) {
      if (error && typeof error === 'object') error.profileWriterLockReleaseError = releaseError;
    }
    throw error;
  }

  let actualStore = null;
  let traderCreationAttempted = false;

  function releaseWriterLock() {
    const profileLockReleased = (actualStore || lockOwnerStore).releaseWriterLock();
    const journalLockReleased = journalLockOwnerStore.releaseWriterLock();
    return profileLockReleased || journalLockReleased;
  }

  function createTraderAndStore(createTrader) {
    if (traderCreationAttempted) {
      throw new Error('Profile-writer startup can create a trader only once.');
    }
    traderCreationAttempted = true;

    try {
      if (typeof createTrader !== 'function') {
        throw new TypeError('A trader factory is required for profile-writer startup.');
      }
      const trader = createTrader();
      if (!trader || typeof trader !== 'object') {
        throw new TypeError('The trader factory did not return a trader instance.');
      }
      const store = createDefaultManualOrderIdempotencyStore(trader, idempotencyFile);
      store.adoptWriterLockFrom(lockOwnerStore);
      actualStore = store;
      return { trader, manualOrderIdempotencyStore: store };
    } catch (error) {
      try {
        releaseWriterLock();
      } catch (releaseError) {
        if (error && typeof error === 'object') error.writerLockReleaseError = releaseError;
      }
      throw error;
    }
  }

  return {
    virtualPortfolioFile,
    idempotencyFile,
    journalLockPath,
    createTraderAndStore,
    releaseWriterLock
  };
}
