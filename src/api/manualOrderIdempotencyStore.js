import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_SCHEMA = 'coinpilot.manual-order-idempotency.v1';
const WRITER_LOCK_SCHEMA = 'coinpilot.manual-order-writer-lock.v1';
const VALID_MODES = new Set(['DRY_RUN', 'LIVE']);
const VALID_STATES = new Set(['pending', 'unknown', 'completed']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function probeOwnerPid(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    return 'unknown';
  }
}

function syncDirectory(directory) {
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameFile(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino;
}

function parseWriterLock(filePath, { hostname, probePid }) {
  let before;
  let stat;
  let owner;
  try {
    before = fs.statSync(filePath);
    owner = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    stat = fs.statSync(filePath);
    if (!sameFile(before, stat)) {
      return { kind: 'ambiguous', detail: 'owner lock changed while being read', stat };
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    return { kind: 'ambiguous', detail: 'owner lock contents cannot be read', stat: before };
  }

  if (owner?.schema !== WRITER_LOCK_SCHEMA ||
    !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
    typeof owner.hostname !== 'string' ||
    typeof owner.lockId !== 'string' || !owner.lockId) {
    return { kind: 'ambiguous', detail: 'owner lock contents are incomplete', stat };
  }
  if (owner.hostname !== hostname) {
    return { kind: 'ambiguous', detail: 'owner lock belongs to another host', stat, owner };
  }
  const status = probePid(owner.pid);
  if (status === 'alive') return { kind: 'active', stat, owner };
  if (status === 'dead') return { kind: 'stale', stat, owner };
  return { kind: 'ambiguous', detail: 'owner process state cannot be verified', stat, owner };
}

function writerLockError(lockPath, state, detail = null) {
  const recoveryRequired = state !== 'active' && state !== 'contended';
  const message = state === 'active'
    ? 'Another process is using this profile. Stop that dashboard before retrying.'
    : state === 'stale'
      ? `The previous writer stopped unexpectedly. Verify that no process is using this profile, then remove ${lockPath} to recover.`
      : state === 'contended'
        ? 'The profile writer lock changed during acquisition. Retry the request.'
        : `The profile writer lock cannot be verified${detail ? ` (${detail})` : ''}. Verify that no process is using this profile, then remove ${lockPath} to recover.`;
  const error = new Error(message);
  error.code = state === 'active'
    ? 'MANUAL_ORDER_WRITER_LOCK_ACTIVE'
    : state === 'contended'
      ? 'MANUAL_ORDER_WRITER_LOCK_CONTENDED'
      : state === 'stale'
        ? 'MANUAL_ORDER_WRITER_LOCK_STALE'
        : 'MANUAL_ORDER_WRITER_LOCK_UNVERIFIABLE';
  error.recoveryRequired = recoveryRequired;
  error.writerLockPath = lockPath;
  return error;
}

function writeOwnerLockFile(filePath, owner) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  let stat = null;
  try {
    stat = fs.fstatSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(owner), 'utf8');
    fs.fsyncSync(descriptor);
    syncDirectory(path.dirname(filePath));
    return { descriptor, stat };
  } catch (error) {
    try {
      const current = fs.statSync(filePath);
      if (stat && sameFile(stat, current)) fs.unlinkSync(filePath);
    } catch {
      // If cleanup is not provably safe, leave the lock for explicit recovery.
    }
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the original durability error.
    }
    throw error;
  }
}

function removeLockFileIfOwned(filePath, { descriptor, stat, lockId }) {
  let error = null;
  try {
    const current = fs.statSync(filePath);
    if (!sameFile(stat, current)) {
      throw writerLockError(filePath, 'ambiguous', 'owner lock file identity changed');
    }
    const owner = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const afterRead = fs.statSync(filePath);
    if (!sameFile(current, afterRead)) {
      throw writerLockError(filePath, 'ambiguous', 'owner lock changed while being released');
    }
    if (owner?.schema !== WRITER_LOCK_SCHEMA || owner.lockId !== lockId) {
      throw writerLockError(filePath, 'ambiguous', 'owner token changed');
    }
    fs.unlinkSync(filePath);
    syncDirectory(path.dirname(filePath));
  } catch (caught) {
    if (caught?.code !== 'ENOENT') error = caught;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (caught) {
      if (!error) error = caught;
    }
  }
  if (error) throw error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value ?? null);
    return serialized === undefined ? 'null' : serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function cloneJson(value) {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : JSON.parse(serialized);
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' ||
    typeof record.recordId !== 'string' ||
    typeof record.profileHash !== 'string' ||
    typeof record.keyHash !== 'string' ||
    typeof record.requestHash !== 'string' ||
    typeof record.bodyHash !== 'string' ||
    typeof record.method !== 'string' ||
    typeof record.endpoint !== 'string' ||
    record.operation !== `${record.method} ${record.endpoint}` ||
    !VALID_MODES.has(record.mode) ||
    !VALID_STATES.has(record.state) ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt))) {
    throw new Error('manual order idempotency record is incomplete');
  }
  if (record.clientIntentId !== undefined && !isUuid(record.clientIntentId)) {
    throw new Error('manual order idempotency client intent id is invalid');
  }
  if (record.legIntents !== undefined) {
    const legIntents = record.legIntents;
    if (!legIntents || typeof legIntents !== 'object' || Array.isArray(legIntents) ||
      Object.keys(legIntents).length === 0 ||
      Object.entries(legIntents).some(([leg, intent]) =>
        typeof leg !== 'string' || leg.trim() === '' || leg.length > 64 || !isUuid(intent))) {
      throw new Error('manual order idempotency leg intents are invalid');
    }
  }
  if (record.state === 'completed' &&
    (!Number.isInteger(record.responseStatus) ||
      record.responseStatus < 100 || record.responseStatus > 599 ||
      !Object.prototype.hasOwnProperty.call(record, 'responseBody'))) {
    throw new Error('completed manual order idempotency record is incomplete');
  }
  return cloneJson(record);
}

function validateRecords(records) {
  if (!Array.isArray(records)) throw new Error('manual order idempotency records must be an array');
  return records.map(validateRecord);
}

function writeJsonAtomically(filePath, data) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const descriptor = fs.openSync(temporaryFile, 'wx', 0o600);
    temporaryCreated = true;
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(data), 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporaryFile, filePath);
    temporaryCreated = false;
    const directoryDescriptor = fs.openSync(directory, 'r');
    try {
      fs.fsyncSync(directoryDescriptor);
    } finally {
      fs.closeSync(directoryDescriptor);
    }
  } catch (error) {
    try {
      if (temporaryCreated && fs.existsSync(temporaryFile)) fs.unlinkSync(temporaryFile);
    } catch {
      // Preserve the durable-write error; startup will fail closed if needed.
    }
    throw error;
  }
}

function chooseRecord(current, candidate) {
  if (!current) return candidate;
  if (current.state === 'completed' && candidate.state !== 'completed') return current;
  if (candidate.state === 'completed' && current.state !== 'completed') return candidate;
  return Date.parse(candidate.updatedAt) >= Date.parse(current.updatedAt) ? candidate : current;
}

/** Durable single-profile idempotency journal for user-originated mutations. */
export class ManualOrderIdempotencyStore {
  constructor({
    filePath,
    writerLockPath = typeof filePath === 'string' ? `${path.resolve(filePath)}.writer.lock` : null,
    loadPortfolioRecords = null,
    persistPortfolioRecords = null,
    now = () => new Date().toISOString(),
    probePid = probeOwnerPid
  } = {}) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new TypeError('ManualOrderIdempotencyStore requires a filePath.');
    }
    this.filePath = path.resolve(filePath);
    if (typeof writerLockPath !== 'string' || !writerLockPath.trim()) {
      throw new TypeError('ManualOrderIdempotencyStore requires a writerLockPath.');
    }
    this.writerLockPath = path.resolve(writerLockPath);
    this.loadPortfolioRecords = loadPortfolioRecords;
    this.persistPortfolioRecords = persistPortfolioRecords;
    this.now = now;
    this.hostname = os.hostname();
    this.probePid = probePid;
    this.writerLock = null;
    this.recoveryLockPath = `${this.writerLockPath}.recovery`;
    this.records = new Map();
    this.initialized = false;
    this.initializing = null;
    this.writeTail = Promise.resolve();
  }

  createOwnerRecord() {
    return {
      schema: WRITER_LOCK_SCHEMA,
      pid: process.pid,
      hostname: this.hostname,
      lockId: randomUUID(),
      startedAt: this.now()
    };
  }

  rememberWriterLock(owner, file) {
    this.writerLock = {
      lockId: owner.lockId,
      descriptor: file.descriptor,
      stat: file.stat
    };
  }

  acquireWriterLockFile() {
    const owner = this.createOwnerRecord();
    const file = writeOwnerLockFile(this.writerLockPath, owner);
    this.rememberWriterLock(owner, file);
  }

  inspectExistingWriterLock() {
    return parseWriterLock(this.writerLockPath, {
      hostname: this.hostname,
      probePid: this.probePid
    });
  }

  verifyWriterLock() {
    if (!this.writerLock) return false;
    const current = this.inspectExistingWriterLock();
    if (current.kind !== 'active' ||
      current.owner.pid !== process.pid ||
      current.owner.lockId !== this.writerLock.lockId ||
      !sameFile(current.stat, this.writerLock.stat)) {
      throw writerLockError(this.writerLockPath, 'ambiguous', 'this process no longer owns the profile lock');
    }
    return true;
  }

  adoptWriterLockFrom(sourceStore) {
    if (!(sourceStore instanceof ManualOrderIdempotencyStore)) {
      throw new TypeError('Writer-lock ownership can only be adopted from another manual-order store.');
    }
    if (sourceStore === this) {
      if (!this.writerLock) {
        throw writerLockError(this.writerLockPath, 'ambiguous', 'store does not own a profile lock');
      }
      this.verifyWriterLock();
      return true;
    }
    if (this.writerLock) {
      throw writerLockError(this.writerLockPath, 'ambiguous', 'target store already owns a profile lock');
    }
    if (!sourceStore.writerLock) {
      throw writerLockError(sourceStore.writerLockPath, 'ambiguous', 'source store does not own a profile lock');
    }
    if (this.writerLockPath !== sourceStore.writerLockPath || this.hostname !== sourceStore.hostname) {
      throw writerLockError(this.writerLockPath, 'ambiguous', 'profile lock path or host does not match');
    }

    sourceStore.verifyWriterLock();
    const ownership = sourceStore.writerLock;
    this.writerLock = ownership;
    sourceStore.writerLock = null;
    try {
      this.verifyWriterLock();
    } catch (error) {
      this.writerLock = null;
      sourceStore.writerLock = ownership;
      throw error;
    }
    return true;
  }

  releaseRecoveryLock(recoveryLock) {
    removeLockFileIfOwned(this.recoveryLockPath, recoveryLock);
  }

  recoverStaleWriterLock(observed) {
    let recoveryLock;
    const recoveryOwner = this.createOwnerRecord();
    try {
      const file = writeOwnerLockFile(this.recoveryLockPath, recoveryOwner);
      recoveryLock = { lockId: recoveryOwner.lockId, ...file };
    } catch (error) {
      if (error?.code === 'EEXIST') {
        const recoveryStatus = parseWriterLock(this.recoveryLockPath, {
          hostname: this.hostname,
          probePid: this.probePid
        });
        if (recoveryStatus.kind === 'active') {
          throw writerLockError(this.recoveryLockPath, 'active');
        }
        if (recoveryStatus.kind === 'stale') {
          throw writerLockError(this.recoveryLockPath, 'stale');
        }
        throw writerLockError(
          this.recoveryLockPath,
          recoveryStatus.kind === 'missing' ? 'contended' : 'ambiguous',
          recoveryStatus.detail || 'lock recovery marker cannot be verified'
        );
      }
      throw error;
    }

    try {
      // The recovery sidecar serializes stale-owner cleanup across processes.
      // Re-read both the owner token and inode immediately before unlinking;
      // never remove a replacement lock or a lock whose PID became live.
      const current = this.inspectExistingWriterLock();
      if (current.kind !== 'stale' ||
        !sameFile(observed.stat, current.stat) ||
        observed.owner.lockId !== current.owner.lockId ||
        observed.owner.pid !== current.owner.pid ||
        this.probePid(current.owner.pid) !== 'dead') {
        throw writerLockError(this.writerLockPath, 'contended');
      }

      fs.unlinkSync(this.writerLockPath);
      syncDirectory(path.dirname(this.writerLockPath));

      // Another process may acquire the now-free path first. wx then refuses
      // to overwrite it, and this process fails closed without touching it.
      try {
        this.acquireWriterLockFile();
      } catch (error) {
        if (error?.code === 'EEXIST') {
          const nextOwner = this.inspectExistingWriterLock();
          throw writerLockError(
            this.writerLockPath,
            nextOwner.kind === 'active' ? 'active' : 'contended'
          );
        }
        throw error;
      }
    } finally {
      this.releaseRecoveryLock(recoveryLock);
    }
  }

  acquireWriterLock() {
    if (this.writerLock) {
      this.verifyWriterLock();
      return;
    }
    fs.mkdirSync(path.dirname(this.writerLockPath), { recursive: true });
    try {
      this.acquireWriterLockFile();
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const observed = this.inspectExistingWriterLock();
    if (observed.kind === 'missing') {
      throw writerLockError(this.writerLockPath, 'contended');
    }
    if (observed.kind === 'active') {
      throw writerLockError(this.writerLockPath, 'active');
    }
    if (observed.kind === 'stale') {
      this.recoverStaleWriterLock(observed);
      return;
    }
    throw writerLockError(this.writerLockPath, 'ambiguous', observed.detail);
  }

  releaseWriterLock() {
    if (!this.writerLock) return false;
    const owned = this.writerLock;
    this.writerLock = null;
    removeLockFileIfOwned(this.writerLockPath, owned);
    return true;
  }

  async initialize() {
    this.acquireWriterLock();
    if (this.initialized) return;
    if (!this.initializing) {
      this.initializing = this.initializeFromDisk();
    }
    await this.initializing;
  }

  async initializeFromDisk() {
    const recordsById = new Map();
    let journalRecords = [];
    if (fs.existsSync(this.filePath)) {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed?.schema !== STORE_SCHEMA) {
        throw new Error('manual order idempotency journal schema is unsupported');
      }
      journalRecords = validateRecords(parsed.records);
    }

    const portfolioRecords = typeof this.loadPortfolioRecords === 'function'
      ? validateRecords(this.loadPortfolioRecords() || [])
      : [];
    for (const record of [...journalRecords, ...portfolioRecords]) {
      recordsById.set(record.recordId, chooseRecord(recordsById.get(record.recordId), record));
    }

    let changed = false;
    for (const [recordId, record] of recordsById) {
      if (record.state === 'pending') {
        recordsById.set(recordId, { ...record, state: 'unknown', updatedAt: this.now() });
        changed = true;
      }
    }
    this.records = recordsById;
    const journalById = new Map(journalRecords.map(record => [record.recordId, record]));
    const journalMatchesMergedState = journalById.size === recordsById.size &&
      [...recordsById].every(([recordId, record]) => {
        const journalRecord = journalById.get(recordId);
        return journalRecord && canonicalize(journalRecord) === canonicalize(record);
      });
    if (changed || !journalMatchesMergedState) {
      await this.persistJournal();
      if (changed && this.persistPortfolioRecords) await this.persistPortfolio();
    }
    this.initialized = true;
  }

  async exclusive(operation) {
    const previous = this.writeTail;
    let release;
    this.writeTail = new Promise(resolve => { release = resolve; });
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }

  getRecordId(profileId, idempotencyKey) {
    const profile = String(profileId || '').trim();
    if (!profile) throw new TypeError('manual order profile id is required');
    const key = String(idempotencyKey || '').trim();
    if (!key || key.length > 256) throw new TypeError('Idempotency-Key is missing or invalid');
    const profileHash = sha256(profile);
    const keyHash = sha256(key);
    return {
      profileHash,
      keyHash,
      recordId: sha256(`${profileHash}\u0000${keyHash}`)
    };
  }

  async reserve({ profileId, idempotencyKey, method, endpoint, body, mode, clientIntentId = null } = {}) {
    await this.initialize();
    return this.exclusive(async () => {
      const identity = this.getRecordId(profileId, idempotencyKey);
      const normalizedMethod = String(method || '').toUpperCase();
      const normalizedEndpoint = String(endpoint || '');
      if (!normalizedMethod || !normalizedEndpoint || !VALID_MODES.has(mode)) {
        throw new TypeError('manual order idempotency request is incomplete');
      }
      if (clientIntentId !== null && (mode !== 'LIVE' || !isUuid(clientIntentId))) {
        throw new TypeError('manual order client intent id is invalid');
      }
      const bodyHash = sha256(canonicalize(body));
      const requestHash = sha256(canonicalize({ method: normalizedMethod, endpoint: normalizedEndpoint, bodyHash }));
      const existing = this.records.get(identity.recordId);

      if (existing) {
        const sameRequest = existing.requestHash === requestHash &&
          existing.method === normalizedMethod && existing.endpoint === normalizedEndpoint;
        if (!sameRequest) {
          return {
            kind: 'conflict',
            pending: existing.state !== 'completed',
            state: existing.state
          };
        }
        if (existing.state === 'completed') {
          return {
            kind: 'replay',
            responseStatus: existing.responseStatus,
            responseBody: cloneJson(existing.responseBody),
            record: cloneJson(existing)
          };
        }
        return { kind: 'pending', state: existing.state, record: cloneJson(existing) };
      }

      if (mode === 'DRY_RUN' && typeof this.persistPortfolioRecords !== 'function') {
        throw new Error('dry portfolio completion persistence is unavailable');
      }

      const now = this.now();
      const record = {
        ...identity,
        method: normalizedMethod,
        endpoint: normalizedEndpoint,
        requestHash,
        bodyHash,
        operation: `${normalizedMethod} ${normalizedEndpoint}`,
        mode,
        state: 'pending',
        ...(clientIntentId ? { clientIntentId } : {}),
        createdAt: now,
        updatedAt: now
      };
      const nextRecords = new Map(this.records);
      nextRecords.set(record.recordId, record);
      await this.persistJournal(nextRecords);
      this.records = nextRecords;
      if (mode === 'DRY_RUN') {
        // A request cannot reach the portfolio mutation until both durable
        // reservation copies are written. A write failure leaves the key locked.
        await this.persistPortfolio();
      }
      return { kind: 'reserved', record: cloneJson(record) };
    });
  }

  async complete(recordId, { status, body } = {}) {
    await this.initialize();
    return this.exclusive(async () => {
      const existing = this.records.get(recordId);
      if (!existing || existing.state !== 'pending') {
        throw new Error('manual order idempotency reservation is not pending');
      }
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new TypeError('manual order response status is invalid');
      }
      const completed = {
        ...existing,
        state: 'completed',
        responseStatus: status,
        responseBody: cloneJson(body),
        updatedAt: this.now()
      };
      const nextRecords = new Map(this.records);
      nextRecords.set(recordId, completed);

      if (existing.mode === 'DRY_RUN') {
        // The portfolio snapshot and completed response share one atomic file commit.
        await this.persistPortfolio(nextRecords);
        this.records = nextRecords;
        try {
          await this.persistJournal(nextRecords);
        } catch {
          // The embedded portfolio receipt is durable and can repair the journal on restart.
        }
      } else {
        await this.persistJournal(nextRecords);
        this.records = nextRecords;
      }
      return cloneJson(completed);
    });
  }

  /**
   * Durably bind one exchange-facing clientIntentId to a leg of a pending
   * multi-leg LIVE request. Routes must attach each leg before dispatch so a
   * lost response or restart can resolve that leg by GET-only identifier
   * readback instead of replaying the plan.
   */
  async attachLegIntent(recordId, leg, clientIntentId) {
    await this.initialize();
    return this.exclusive(async () => {
      const existing = this.records.get(recordId);
      if (!existing || !['pending', 'unknown'].includes(existing.state) ||
        existing.mode !== 'LIVE' || !isUuid(existing.clientIntentId)) {
        throw new Error('manual order idempotency reservation cannot attach a leg intent');
      }
      if (typeof leg !== 'string' || leg.trim() === '' || leg.length > 64 || !isUuid(clientIntentId)) {
        throw new TypeError('manual order leg intent is invalid');
      }
      const legIntents = { ...(existing.legIntents || {}) };
      const previous = legIntents[leg];
      if (previous !== undefined) {
        if (previous === clientIntentId) return cloneJson(existing);
        throw new Error('manual order leg intent is already recorded');
      }
      legIntents[leg] = clientIntentId;
      const updated = { ...existing, legIntents, updatedAt: this.now() };
      const nextRecords = new Map(this.records);
      nextRecords.set(recordId, updated);
      await this.persistJournal(nextRecords);
      this.records = nextRecords;
      return cloneJson(updated);
    });
  }

  async completeRecovered(recordId, { status, body } = {}) {
    await this.initialize();
    return this.exclusive(async () => {
      const existing = this.records.get(recordId);
      if (!existing) throw new Error('manual order idempotency reservation is missing');
      if (existing.state === 'completed') return cloneJson(existing);
      if (!['pending', 'unknown'].includes(existing.state) || existing.mode !== 'LIVE' ||
        !isUuid(existing.clientIntentId)) {
        throw new Error('manual order idempotency reservation is not recoverable');
      }
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        throw new TypeError('manual order response status is invalid');
      }
      const completed = {
        ...existing,
        state: 'completed',
        responseStatus: status,
        responseBody: cloneJson(body),
        recovered: true,
        updatedAt: this.now()
      };
      delete completed.reasonCode;
      const nextRecords = new Map(this.records);
      nextRecords.set(recordId, completed);
      await this.persistJournal(nextRecords);
      this.records = nextRecords;
      return cloneJson(completed);
    });
  }

  async markUnknown(recordId, reason = 'outcome_unknown') {
    await this.initialize();
    return this.exclusive(async () => {
      const existing = this.records.get(recordId);
      if (!existing || existing.state === 'completed') return existing ? cloneJson(existing) : null;
      const unknown = { ...existing, state: 'unknown', updatedAt: this.now(), reasonCode: String(reason) };
      const nextRecords = new Map(this.records);
      nextRecords.set(recordId, unknown);
      await this.persistJournal(nextRecords);
      this.records = nextRecords;
      if (existing.mode === 'DRY_RUN' && this.persistPortfolioRecords) await this.persistPortfolio(nextRecords);
      return cloneJson(unknown);
    });
  }

  async persistJournal(records = this.records) {
    writeJsonAtomically(this.filePath, {
      schema: STORE_SCHEMA,
      updatedAt: this.now(),
      records: [...records.values()]
    });
  }

  async persistPortfolio(records = this.records) {
    if (!this.persistPortfolioRecords) return;
    await this.persistPortfolioRecords([...records.values()].map(cloneJson));
  }

  getRecord(recordId) {
    const record = this.records.get(recordId);
    return record ? cloneJson(record) : null;
  }
}

export function createDefaultManualOrderIdempotencyStore(tradingSystem, filePath, { writerLockPath = null } = {}) {
  const dryRun = tradingSystem?.dryRun === true;
  const portfolioFile = tradingSystem?.virtualPortfolioFile ||
    tradingSystem?.config?.virtualPortfolioFile ||
    filePath;
  const loadPortfolioRecords = () => {
    if (typeof portfolioFile !== 'string' || !portfolioFile) return [];
    if (!fs.existsSync(portfolioFile)) return [];
    const portfolio = JSON.parse(fs.readFileSync(portfolioFile, 'utf8'));
    return portfolio.manualOrderIdempotencyRecords || [];
  };
  return new ManualOrderIdempotencyStore({
    filePath,
    // All server instances sharing a portfolio file share one same-host
    // writer lock, even when their idempotency journal paths differ.
    writerLockPath: writerLockPath || `${path.resolve(portfolioFile)}.manual_order_writer.lock`,
    // Always read the dry portfolio receipt, even in LIVE mode. The same
    // stable account profile can restart or switch modes between the portfolio
    // commit and the journal response commit.
    loadPortfolioRecords,
    persistPortfolioRecords: dryRun && typeof tradingSystem?.persistManualOrderIdempotencyRecords === 'function'
      ? records => tradingSystem.persistManualOrderIdempotencyRecords(records)
      : null
  });
}
