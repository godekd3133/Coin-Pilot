import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STORE_SCHEMA = 'coinpilot.manual-order-idempotency.v1';
const WRITER_LOCK_SCHEMA = 'coinpilot.manual-order-writer-lock.v1';
const VALID_MODES = new Set(['DRY_RUN', 'LIVE']);
const VALID_STATES = new Set(['pending', 'unknown', 'completed']);

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

  async reserve({ profileId, idempotencyKey, method, endpoint, body, mode } = {}) {
    await this.initialize();
    return this.exclusive(async () => {
      const identity = this.getRecordId(profileId, idempotencyKey);
      const normalizedMethod = String(method || '').toUpperCase();
      const normalizedEndpoint = String(endpoint || '');
      if (!normalizedMethod || !normalizedEndpoint || !VALID_MODES.has(mode)) {
        throw new TypeError('manual order idempotency request is incomplete');
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

export function canonicalManualRequestEndpoint(req) {
  const rawUrl = String(req?.originalUrl || req?.url || '/');
  const parsed = new URL(rawUrl, 'http://coinpilot.local');
  const query = [...parsed.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) =>
    aKey.localeCompare(bKey) || aValue.localeCompare(bValue)
  );
  const search = new URLSearchParams(query).toString();
  return search ? `${parsed.pathname}?${search}` : parsed.pathname;
}

function pendingResponse(state = 'pending') {
  return {
    success: false,
    pending: true,
    idempotency: { status: state },
    error: {
      code: 'idempotency_pending',
      message: '요청 결과를 확인하고 있습니다. 같은 요청을 다시 보내 확인해 주세요.'
    }
  };
}

function missingKeyResponse() {
  return {
    success: false,
    pending: false,
    error: {
      code: 'idempotency_key_required',
      message: '요청 키가 없어 변경을 시작하지 않았습니다.'
    }
  };
}

function conflictResponse(pending, state) {
  return {
    success: false,
    pending,
    idempotency: { status: pending ? state : 'conflict' },
    error: {
      code: 'idempotency_key_conflict',
      message: '같은 요청 키가 다른 경로나 내용에 이미 연결되어 있습니다.'
    }
  };
}

function unknownResponse() {
  return {
    success: false,
    pending: true,
    idempotency: { status: 'unknown' },
    error: {
      code: 'idempotency_outcome_unknown',
      message: '요청 결과를 확인할 수 없습니다. 같은 요청 키와 내용을 유지해 주세요.'
    }
  };
}

function writerLockResponse(error) {
  const active = error?.code === 'MANUAL_ORDER_WRITER_LOCK_ACTIVE';
  const contended = error?.code === 'MANUAL_ORDER_WRITER_LOCK_CONTENDED';
  return {
    success: false,
    pending: false,
    error: {
      code: active || contended ? 'manual_order_writer_locked' : 'manual_order_writer_recovery_required',
      message: error?.message || '프로필 변경 권한을 확인할 수 없어 요청을 시작하지 않았습니다.',
      recoveryRequired: error?.recoveryRequired === true
    }
  };
}

const UNCERTAIN_LIVE_CODES = new Set([
  'order_submission_unknown',
  'fill_not_observed',
  'order_uuid_missing',
  'live_execution_evidence_write_failed'
]);
const IDEMPOTENCY_STATUS_HEADER = 'Idempotency-Status';
const IDEMPOTENCY_STATUSES = new Set(['completed', 'pending', 'unknown', 'conflict', 'rejected']);

function setIdempotencyStatus(res, status) {
  if (!IDEMPOTENCY_STATUSES.has(status)) return;
  if (typeof res?.setHeader === 'function') {
    res.setHeader(IDEMPOTENCY_STATUS_HEADER, status);
  } else if (typeof res?.set === 'function') {
    res.set(IDEMPOTENCY_STATUS_HEADER, status);
  }
}

function respondWithIdempotencyStatus(res, statusCode, body, idempotencyStatus) {
  setIdempotencyStatus(res, idempotencyStatus);
  return res.status(statusCode).json(body);
}

const DEFINITIVE_LIVE_NO_SUBMIT_CODES = new Set([
  'live_order_in_progress',
  'protective_only',
  'trading_paused',
  'exchange_state_unverified',
  'live_order_gate_unavailable',
  'live_execution_evidence_unavailable'
]);

function containsUncertainLiveOutcome(value) {
  if (Array.isArray(value)) return value.some(containsUncertainLiveOutcome);
  if (!value || typeof value !== 'object') return false;
  if (typeof value.reason === 'string' && UNCERTAIN_LIVE_CODES.has(value.reason)) return true;
  if (typeof value.code === 'string' && UNCERTAIN_LIVE_CODES.has(value.code)) return true;
  if (value.status === 'not_observed' && (value.orderId || value.exchangeState)) return true;
  return Object.values(value).some(containsUncertainLiveOutcome);
}

function hasUncertainLiveResult(mode, status, body) {
  if (mode !== 'LIVE') return false;
  if (containsUncertainLiveOutcome(body)) return true;
  if (status < 500) return false;
  return !(body?.mode === 'LIVE' && DEFINITIVE_LIVE_NO_SUBMIT_CODES.has(body.reason));
}

function requestResponsePromise(req, res, next, reservation, store, tradingSystem, transaction) {
  return new Promise(resolve => {
    let settled = false;
    const originalJson = res.json.bind(res);
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    res.once('finish', finish);
    res.json = function jsonWithIdempotency(body) {
      if (settled) return originalJson(body);
      const responseStatus = this.statusCode || 200;
      const shouldRollbackDryRun = reservation.record.mode === 'DRY_RUN' &&
        (responseStatus >= 400 || body?.success === false);
      if (shouldRollbackDryRun && transaction?.rollback) transaction.rollback();

      const finalize = async () => {
        if (hasUncertainLiveResult(reservation.record.mode, responseStatus, body)) {
          await store.markUnknown(reservation.record.recordId, 'live_order_outcome_unknown');
          return { status: 202, body: unknownResponse(), idempotencyStatus: 'unknown' };
        }
        await store.complete(reservation.record.recordId, { status: responseStatus, body });
        transaction?.commit?.();
        return { status: responseStatus, body, idempotencyStatus: 'completed' };
      };

      finalize()
        .then(result => {
          setIdempotencyStatus(this, result.idempotencyStatus);
          originalJson.call(this.status(result.status), result.body);
          if (res.destroyed) finish();
        })
        .catch(async () => {
          if (reservation.record.mode === 'DRY_RUN') transaction?.rollback?.();
          try {
            await store.markUnknown(reservation.record.recordId, 'durable_commit_failed');
          } catch {
            // Keep the reservation pending in memory/disk and fail closed.
          }
          setIdempotencyStatus(this, 'unknown');
          originalJson.call(this.status(202), unknownResponse());
          if (res.destroyed) finish();
        })
      return this;
    };
    next();
  });
}

/** Middleware factory shared by manual trade and virtual-wallet routes only. */
export function createManualOrderIdempotencyMiddleware(server, { paths } = {}) {
  const supportedPaths = paths instanceof Set ? paths : new Set(paths || []);
  return async function manualOrderIdempotencyMiddleware(req, res, next) {
    if (req.method !== 'POST' || !supportedPaths.has(req.path)) return next();

    const tradingSystem = server?.tradingSystem;
    if (tradingSystem?.readOnlyObserver === true) {
      return respondWithIdempotencyStatus(res, 403, {
        success: false,
        pending: false,
        readOnlyObserver: true,
        error: {
          code: 'read_only_observer',
          message: '읽기 전용 연결에서는 계정 파일을 변경할 수 없습니다.'
        }
      }, 'rejected');
    }

    const idempotencyKey = String(req.get?.('Idempotency-Key') || req.headers?.['idempotency-key'] || '').trim();
    if (!idempotencyKey) return respondWithIdempotencyStatus(res, 428, missingKeyResponse(), 'rejected');
    if (idempotencyKey.length > 256) {
      return respondWithIdempotencyStatus(res, 400, {
        success: false,
        pending: false,
        error: { code: 'idempotency_key_invalid', message: '요청 키 형식이 올바르지 않습니다.' }
      }, 'rejected');
    }

    const store = server?.manualOrderIdempotencyStore;
    if (!store || typeof store.reserve !== 'function') {
      return respondWithIdempotencyStatus(res, 503, {
        ...pendingResponse('unavailable'),
        error: { code: 'idempotency_store_unavailable', message: '요청을 안전하게 기록할 수 없어 변경을 시작하지 않았습니다.' }
      }, 'unknown');
    }

    const mode = tradingSystem?.dryRun === true ? 'DRY_RUN' : 'LIVE';
    let reservation;
    try {
      reservation = await store.reserve({
        profileId: server?.auth?.writeProfileId || server?.manualOrderProfileId || 'operator',
        idempotencyKey,
        method: req.method,
        endpoint: canonicalManualRequestEndpoint(req),
        body: req.body ?? null,
        mode
      });
    } catch (error) {
      if (String(error?.code || '').startsWith('MANUAL_ORDER_WRITER_LOCK_')) {
        return respondWithIdempotencyStatus(res, 503, writerLockResponse(error), 'rejected');
      }
      return respondWithIdempotencyStatus(res, 503, unknownResponse(), 'unknown');
    }

    if (reservation.kind === 'conflict') {
      return respondWithIdempotencyStatus(res, 409, conflictResponse(reservation.pending, reservation.state), 'conflict');
    }
    if (reservation.kind === 'replay') {
      return respondWithIdempotencyStatus(res, reservation.responseStatus, reservation.responseBody, 'completed');
    }
    if (reservation.kind === 'pending') {
      const status = reservation.state === 'unknown' ? 'unknown' : 'pending';
      return respondWithIdempotencyStatus(res, 202, pendingResponse(reservation.state), status);
    }
    if (reservation.kind !== 'reserved' || reservation.record.mode !== mode) {
      return respondWithIdempotencyStatus(res, 202, unknownResponse(), 'unknown');
    }

    const execute = transaction => requestResponsePromise(req, res, next, reservation, store, tradingSystem, transaction);
    if (reservation.record.mode === 'DRY_RUN') {
      if (typeof tradingSystem?.withManualPortfolioTransaction !== 'function') {
        try {
          await store.markUnknown(reservation.record.recordId, 'portfolio_lock_unavailable');
        } catch {
          // The pending reservation remains durable.
        }
        return respondWithIdempotencyStatus(res, 202, unknownResponse(), 'unknown');
      }
      try {
        return await tradingSystem.withManualPortfolioTransaction(transaction => execute(transaction));
      } catch {
        try {
          await store.markUnknown(reservation.record.recordId, 'portfolio_transaction_failed');
        } catch {
          // Keep the durable reservation unresolved when rollback persistence also fails.
        }
        if (!res.headersSent) return respondWithIdempotencyStatus(res, 202, unknownResponse(), 'unknown');
        return undefined;
      }
    }
    return execute(null);
  };
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
