import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const LEGACY_STATE_SCHEMA = 'coinpilot.upbit-rate-coordinator-state.v1';
const STATE_SCHEMA = 'coinpilot.upbit-rate-coordinator-state.v2';
const OWNER_SCHEMA = 'coinpilot.upbit-rate-coordinator-owner.v1';
const MAX_SOCKET_PATH_BYTES = 100;
const MIN_REQUEST_INTERVAL_MS = 120;
const MAX_COORDINATOR_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_BACKOFF_GROUPS = 5;
const MAX_STATE_FILE_BYTES = 4 * 1024;
const DEFAULT_QUEUE_TIMEOUT_MS = { normal: 10_000, risk: 30_000 };
const QUOTA_GROUPS = new Set(['market', 'candle', 'ticker', 'orderbook']);
const BACKOFF_KEYS = new Set([...QUOTA_GROUPS, '*']);
const MONOTONIC_NS_PER_MS = 1_000_000n;
const MANUAL_BACKOFF_RECOVERY_CODE = 'UPBIT_RATE_COORDINATOR_BACKOFF_DELAY_EXCEEDS_MAX';
const LEGACY_STATE_RECOVERY_CODE = 'UPBIT_RATE_COORDINATOR_LEGACY_STATE_REQUIRES_REVIEW';

function coordinatorError(message, code, options = {}) {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined);
  error.name = options.name || 'UpbitRateCoordinatorError';
  error.code = code;
  return error;
}

function numberAtLeastZero(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

function monotonicNowNs() {
  return process.hrtime.bigint();
}

function delayMsToNs(delayMs) {
  return BigInt(Math.ceil(delayMs * Number(MONOTONIC_NS_PER_MS)));
}

function remainingMs(untilNs, nowNs) {
  const remainingNs = untilNs > nowNs ? untilNs - nowNs : 0n;
  return Number(remainingNs) / Number(MONOTONIC_NS_PER_MS);
}

function readBootIdentity() {
  if (process.platform === 'linux') {
    const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (/^[a-f0-9-]{16,64}$/i.test(bootId)) return `linux:${bootId}`;
    throw coordinatorError('Linux boot identity could not be verified.', 'UPBIT_RATE_COORDINATOR_CLOCK_IDENTITY_UNAVAILABLE');
  }
  if (process.platform === 'darwin') {
    let output;
    try {
      output = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (error) {
      throw coordinatorError('macOS boot identity could not be verified.', 'UPBIT_RATE_COORDINATOR_CLOCK_IDENTITY_UNAVAILABLE', { cause: error });
    }
    const match = output.match(/sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/);
    if (match) return `darwin:${match[1]}:${match[2]}`;
    throw coordinatorError('macOS boot identity could not be parsed.', 'UPBIT_RATE_COORDINATOR_CLOCK_IDENTITY_UNAVAILABLE');
  }
  throw coordinatorError('This platform does not expose a verifiable boot identity.', 'UPBIT_RATE_COORDINATOR_CLOCK_IDENTITY_UNAVAILABLE');
}

function readProcessIdentity(pid) {
  const bootIdentity = readBootIdentity();
  if (process.platform === 'linux') {
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return undefined;
    }
    const closingParen = stat.lastIndexOf(')');
    if (closingParen < 0) return undefined;
    const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
    const startTicks = fields[19];
    if (!/^\d+$/.test(startTicks || '')) return undefined;
    return `linux:${bootIdentity}:${startTicks}`;
  }
  if (process.platform === 'darwin') {
    let startText;
    try {
      startText = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    } catch (error) {
      if (error?.status === 1 && !String(error?.stdout || '').trim()) return null;
      return undefined;
    }
    if (!startText) return null;
    return `darwin:${bootIdentity}:${startText}`;
  }
  return undefined;
}

function processStateMatchesOwner(owner) {
  let observedIdentity;
  try {
    observedIdentity = readProcessIdentity(owner.pid);
  } catch {
    return 'unknown';
  }
  if (observedIdentity === null) return 'dead';
  if (observedIdentity === undefined) return 'unknown';
  return observedIdentity === owner.processIdentity ? 'active' : 'stale';
}

function normalizeGroup(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]+$/i.test(value.trim())) {
    throw coordinatorError('Upbit rate coordinator requires a valid quota group.', 'UPBIT_RATE_COORDINATOR_INVALID_GROUP');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 16 || !QUOTA_GROUPS.has(normalized)) {
    throw coordinatorError('Upbit rate coordinator only accepts market, candle, ticker, and orderbook quota groups.', 'UPBIT_RATE_COORDINATOR_INVALID_GROUP');
  }
  return normalized;
}

function normalizeScope(options = {}) {
  const scope = options.scope ?? options.rateLimitScope ?? 'ip';
  if (scope !== 'ip') {
    throw coordinatorError(
      `Upbit shared rate coordinator only accepts the public IP scope (received ${String(scope)}).`,
      'UPBIT_RATE_COORDINATOR_SCOPE_UNSUPPORTED'
    );
  }
  return scope;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function hasOnlyOwnerPermissions(stat) {
  return (stat.mode & 0o077) === 0;
}

function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureOwnedRegularFile(filePath, stat, label) {
  if (!stat.isFile() || stat.isSymbolicLink?.()) {
    throw coordinatorError(`${label} must be a regular file.`, 'UPBIT_RATE_COORDINATOR_FILE_AMBIGUOUS');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw coordinatorError(`${label} is owned by another user.`, 'UPBIT_RATE_COORDINATOR_FILE_AMBIGUOUS');
  }
  if (!hasOnlyOwnerPermissions(stat)) {
    throw coordinatorError(`${label} permissions must be owner-only.`, 'UPBIT_RATE_COORDINATOR_FILE_PERMISSIONS');
  }
}

function createOwnerRecord() {
  const processIdentity = readProcessIdentity(process.pid);
  if (!processIdentity) {
    throw coordinatorError('Coordinator process identity cannot be established.', 'UPBIT_RATE_COORDINATOR_PROCESS_IDENTITY_UNAVAILABLE');
  }
  return {
    schema: OWNER_SCHEMA,
    pid: process.pid,
    hostname: os.hostname(),
    processIdentity,
    lockId: crypto.randomUUID(),
    startedAt: Date.now()
  };
}

function writeOwnerFile(filePath, owner) {
  const descriptor = fs.openSync(filePath, 'wx', 0o600);
  let stat = null;
  try {
    stat = fs.fstatSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(owner), 'utf8');
    fs.fsyncSync(descriptor);
    syncDirectory(path.dirname(filePath));
    return { descriptor, stat, owner };
  } catch (error) {
    try {
      const current = fs.lstatSync(filePath);
      if (stat && sameFile(stat, current)) fs.unlinkSync(filePath);
    } catch {
      // Keep an unverified file for explicit recovery; never delete by path alone.
    }
    try {
      fs.closeSync(descriptor);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

function readOwnerFile(filePath) {
  let before;
  let after;
  let owner;
  try {
    before = fs.lstatSync(filePath);
    ensureOwnedRegularFile(filePath, before, 'Coordinator owner lock');
    owner = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    after = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing' };
    if (error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')) {
      return { kind: 'ambiguous', error };
    }
    return {
      kind: 'ambiguous',
      error: coordinatorError('Coordinator owner lock cannot be read or parsed.', 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS', { cause: error })
    };
  }

  if (!sameFile(before, after)) {
    return { kind: 'ambiguous', error: coordinatorError('Coordinator owner lock changed while being read.', 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS') };
  }
  if (owner?.schema !== OWNER_SCHEMA || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
    typeof owner.hostname !== 'string' || typeof owner.processIdentity !== 'string' ||
    owner.processIdentity.length > 256 || typeof owner.lockId !== 'string' || !owner.lockId) {
    return { kind: 'ambiguous', error: coordinatorError('Coordinator owner lock contents are incomplete.', 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS') };
  }
  if (owner.hostname !== os.hostname()) {
    return { kind: 'ambiguous', error: coordinatorError('Coordinator owner lock belongs to another host.', 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS') };
  }
  const processState = processStateMatchesOwner(owner);
  if (processState === 'active') return { kind: 'active', owner, stat: after };
  if (processState === 'dead' || processState === 'stale') return { kind: 'stale', owner, stat: after };
  return { kind: 'ambiguous', error: coordinatorError('Coordinator owner process identity cannot be verified.', 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS') };
}

function releaseOwnedFile(filePath, owned, label) {
  let caughtError = null;
  try {
    const current = fs.lstatSync(filePath);
    if (!sameFile(current, owned.stat)) {
      throw coordinatorError(`${label} file identity changed before release.`, 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS');
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const afterRead = fs.lstatSync(filePath);
    if (!sameFile(current, afterRead) || parsed?.schema !== OWNER_SCHEMA || parsed?.lockId !== owned.owner.lockId) {
      throw coordinatorError(`${label} owner token changed before release.`, 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS');
    }
    fs.unlinkSync(filePath);
    syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (error?.code !== 'ENOENT') caughtError = error;
  } finally {
    try {
      fs.closeSync(owned.descriptor);
    } catch (error) {
      if (!caughtError) caughtError = error;
    }
  }
  if (caughtError) throw caughtError;
}

function acquireExclusiveFile(filePath, { allowStaleRecovery = true, onRecoveryMarkerCreated } = {}) {
  const owner = createOwnerRecord();
  try {
    return writeOwnerFile(filePath, owner);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const observed = readOwnerFile(filePath);
  if (observed.kind === 'active') {
    throw coordinatorError('Another Upbit rate coordinator owns this state root.', 'UPBIT_RATE_COORDINATOR_ALREADY_RUNNING');
  }
  if (observed.kind !== 'stale' || !allowStaleRecovery) {
    throw observed.error || coordinatorError('Coordinator lock state is ambiguous; refusing recovery.', 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS');
  }

  const recoveryPath = `${filePath}.recovery`;
  let recoveryLock;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      recoveryLock = writeOwnerFile(recoveryPath, createOwnerRecord());
      if (onRecoveryMarkerCreated) onRecoveryMarkerCreated(recoveryPath);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const recovery = readOwnerFile(recoveryPath);
      if (recovery.kind === 'stale' && reclaimStaleOwnerFile(recoveryPath, recovery, 'Coordinator recovery marker')) {
        continue;
      }
      const markerState = recovery.kind === 'active' ? 'active' : recovery.kind;
      const recoveryError = coordinatorError(
        `Coordinator recovery marker at ${recoveryPath} is ${markerState}; automatic recovery is disabled. Stop the coordinator service, confirm no coordinator process is running, remove only this marker, then restart.`,
        'UPBIT_RATE_COORDINATOR_LOCK_RECOVERY_REQUIRED',
        { cause: recovery.error || error }
      );
      recoveryError.recoveryPath = recoveryPath;
      recoveryError.recoveryMarkerState = markerState;
      throw recoveryError;
    }
  }
  if (!recoveryLock) {
    throw coordinatorError('Coordinator recovery marker changed repeatedly; refusing recovery.', 'UPBIT_RATE_COORDINATOR_LOCK_CONTENDED');
  }

  try {
    const current = readOwnerFile(filePath);
    if (current.kind !== 'stale' || !sameFile(current.stat, observed.stat) ||
      current.owner.lockId !== observed.owner.lockId ||
      !['dead', 'stale'].includes(processStateMatchesOwner(current.owner))) {
      throw coordinatorError('Coordinator lock changed during stale recovery.', 'UPBIT_RATE_COORDINATOR_LOCK_CONTENDED');
    }
    fs.unlinkSync(filePath);
    syncDirectory(path.dirname(filePath));
    try {
      return writeOwnerFile(filePath, owner);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw coordinatorError('Coordinator lock was acquired by another process during recovery.', 'UPBIT_RATE_COORDINATOR_LOCK_CONTENDED', { cause: error });
      }
      throw error;
    }
  } finally {
    releaseOwnedFile(recoveryPath, recoveryLock, 'Coordinator recovery lock');
  }
}

function reclaimStaleOwnerFile(filePath, observed, label) {
  if (observed.kind !== 'stale' || !observed.stat || !observed.owner) return false;
  let before;
  let owner;
  let afterRead;
  try {
    before = fs.lstatSync(filePath);
    if (!sameFile(before, observed.stat)) return false;
    ensureOwnedRegularFile(filePath, before, label);
    owner = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    afterRead = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  if (!sameFile(before, afterRead) || owner?.schema !== OWNER_SCHEMA ||
    owner?.lockId !== observed.owner.lockId || owner?.processIdentity !== observed.owner.processIdentity ||
    !['dead', 'stale'].includes(processStateMatchesOwner(owner))) {
    return false;
  }
  let beforeUnlink;
  try {
    beforeUnlink = fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  if (!sameFile(before, beforeUnlink)) return false;
  fs.unlinkSync(filePath);
  syncDirectory(path.dirname(filePath));
  return true;
}

function validateState(state) {
  const expectedKeys = [
    'schema', 'version', 'bootIdentity', 'nextDispatchAt', 'nextDispatchMonoNs',
    'backoffUntilByGroup', 'backoffMonoNsByGroup', 'manualRecoveryRequired'
  ];
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
    Object.keys(state).sort().join(',') !== expectedKeys.sort().join(',') ||
    state.schema !== STATE_SCHEMA || state.version !== 2 ||
    typeof state.bootIdentity !== 'string' || !state.bootIdentity || state.bootIdentity.length > 128 ||
    !Number.isSafeInteger(state.nextDispatchAt) || state.nextDispatchAt < 0 ||
    typeof state.nextDispatchMonoNs !== 'string' || !/^\d{1,32}$/.test(state.nextDispatchMonoNs) ||
    !state.backoffUntilByGroup || typeof state.backoffUntilByGroup !== 'object' ||
    Array.isArray(state.backoffUntilByGroup) ||
    !state.backoffMonoNsByGroup || typeof state.backoffMonoNsByGroup !== 'object' ||
    Array.isArray(state.backoffMonoNsByGroup) ||
    (state.manualRecoveryRequired !== null && (typeof state.manualRecoveryRequired !== 'string' ||
      !/^UPBIT_RATE_COORDINATOR_[A-Z0-9_]{1,80}$/.test(state.manualRecoveryRequired)))) {
    throw coordinatorError('Upbit coordinator state has an unsupported or corrupt shape.', 'UPBIT_RATE_COORDINATOR_STATE_CORRUPT');
  }
  const backoffGroups = Object.keys(state.backoffUntilByGroup);
  const monoGroups = Object.keys(state.backoffMonoNsByGroup);
  if (backoffGroups.length > MAX_BACKOFF_GROUPS || monoGroups.length > MAX_BACKOFF_GROUPS ||
    !sameStringSet(backoffGroups, monoGroups)) {
    throw coordinatorError('Upbit coordinator state has too many or mismatched backoff groups.', 'UPBIT_RATE_COORDINATOR_STATE_CORRUPT');
  }
  for (const [group, until] of Object.entries(state.backoffUntilByGroup)) {
    if (!BACKOFF_KEYS.has(group) || !Number.isSafeInteger(until) || until < 0 ||
      typeof state.backoffMonoNsByGroup[group] !== 'string' || !/^\d{1,32}$/.test(state.backoffMonoNsByGroup[group])) {
      throw coordinatorError('Upbit coordinator state contains an invalid backoff entry.', 'UPBIT_RATE_COORDINATOR_STATE_CORRUPT');
    }
  }
  return {
    schema: STATE_SCHEMA,
    version: 2,
    bootIdentity: state.bootIdentity,
    nextDispatchAt: state.nextDispatchAt,
    nextDispatchMonoNs: state.nextDispatchMonoNs,
    backoffUntilByGroup: Object.fromEntries(Object.entries(state.backoffUntilByGroup)),
    backoffMonoNsByGroup: Object.fromEntries(Object.entries(state.backoffMonoNsByGroup)),
    manualRecoveryRequired: state.manualRecoveryRequired
  };
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every(value => right.includes(value));
}

function createEmptyState(bootIdentity) {
  return {
    schema: STATE_SCHEMA,
    version: 2,
    bootIdentity,
    nextDispatchAt: 0,
    nextDispatchMonoNs: '0',
    backoffUntilByGroup: {},
    backoffMonoNsByGroup: {},
    manualRecoveryRequired: null
  };
}

function readPersistentState(stateFilePath, bootIdentity, now, monoNowNs) {
  let stat;
  try {
    stat = fs.lstatSync(stateFilePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        state: createEmptyState(bootIdentity),
        stat: null,
        hash: null,
        recoveryKind: 'fresh'
      };
    }
    throw error;
  }
  ensureOwnedRegularFile(stateFilePath, stat, 'Coordinator state file');
  if (stat.size > MAX_STATE_FILE_BYTES) {
    throw coordinatorError(`Coordinator state file exceeds the ${MAX_STATE_FILE_BYTES}-byte safety limit.`, 'UPBIT_RATE_COORDINATOR_STATE_TOO_LARGE');
  }
  const raw = fs.readFileSync(stateFilePath, 'utf8');
  if (Buffer.byteLength(raw) > MAX_STATE_FILE_BYTES) {
    throw coordinatorError(`Coordinator state JSON exceeds the ${MAX_STATE_FILE_BYTES}-byte safety limit.`, 'UPBIT_RATE_COORDINATOR_STATE_TOO_LARGE');
  }
  const afterRead = fs.lstatSync(stateFilePath);
  if (!sameFile(stat, afterRead)) {
    throw coordinatorError('Upbit coordinator state changed while being read.', 'UPBIT_RATE_COORDINATOR_STATE_AMBIGUOUS');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw coordinatorError('Upbit coordinator state JSON is corrupt.', 'UPBIT_RATE_COORDINATOR_STATE_CORRUPT', { cause: error });
  }
  if (parsed?.schema === LEGACY_STATE_SCHEMA && parsed?.version === 1) {
    return {
      state: { ...createEmptyState(bootIdentity), manualRecoveryRequired: LEGACY_STATE_RECOVERY_CODE },
      stat: afterRead,
      hash: crypto.createHash('sha256').update(raw).digest('hex'),
      recoveryKind: 'legacy-state-manual-block'
    };
  }
  const validated = validateState(parsed);
  let state = validated;
  let recoveryKind = 'same-boot-monotonic-restored';
  if (validated.bootIdentity !== bootIdentity) {
    const nowWall = now();
    const hasPersistedBackoff = Object.keys(validated.backoffUntilByGroup).length > 0;
    const conservativeCooldownMs = hasPersistedBackoff
      ? MAX_COORDINATOR_DELAY_MS
      : MIN_REQUEST_INTERVAL_MS;
    const cooldownUntilNs = monoNowNs + delayMsToNs(conservativeCooldownMs);
    state = {
      ...createEmptyState(bootIdentity),
      nextDispatchAt: nowWall + conservativeCooldownMs,
      nextDispatchMonoNs: cooldownUntilNs.toString(),
      backoffUntilByGroup: hasPersistedBackoff ? { '*': nowWall + MAX_COORDINATOR_DELAY_MS } : {},
      backoffMonoNsByGroup: hasPersistedBackoff ? { '*': cooldownUntilNs.toString() } : {},
      manualRecoveryRequired: validated.manualRecoveryRequired
    };
    recoveryKind = hasPersistedBackoff
      ? 'os-boot-conservative-full-cooldown'
      : 'os-boot-minimum-dispatch-interval';
  }
  return {
    state,
    stat: afterRead,
    hash: crypto.createHash('sha256').update(raw).digest('hex'),
    recoveryKind
  };
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink?.()) {
    throw coordinatorError('Coordinator state directory must be a real directory.', 'UPBIT_RATE_COORDINATOR_DIRECTORY_AMBIGUOUS');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw coordinatorError('Coordinator state directory is owned by another user.', 'UPBIT_RATE_COORDINATOR_DIRECTORY_AMBIGUOUS');
  }
  if (!hasOnlyOwnerPermissions(stat)) {
    fs.chmodSync(directory, 0o700);
    stat = fs.lstatSync(directory);
  }
  if (!stat.isDirectory() || (uid !== null && stat.uid !== uid) || !hasOnlyOwnerPermissions(stat)) {
    throw coordinatorError('Coordinator state directory must be owner-only.', 'UPBIT_RATE_COORDINATOR_DIRECTORY_PERMISSIONS');
  }
}

function resolveStateRoot(stateDir, { allowTemporaryStateDir = false } = {}) {
  if (typeof stateDir !== 'string' || !stateDir.trim()) {
    throw coordinatorError(
      'UPBIT_RATE_COORDINATOR_STATE_DIR or COINPILOT_STATE_DIR is required for the shared Upbit rate coordinator.',
      'UPBIT_RATE_COORDINATOR_STATE_ROOT_REQUIRED'
    );
  }
  const absolute = path.resolve(stateDir);
  if (!allowTemporaryStateDir) {
    const blockedRoots = [os.tmpdir(), '/tmp', '/private/tmp'].map(value => path.resolve(value));
    const usesTemporaryRoot = blockedRoots.some(root => {
      const relative = path.relative(root, absolute);
      return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
    });
    if (usesTemporaryRoot) {
      throw coordinatorError('Coordinator state must be under a durable shared state root, not a temporary directory.', 'UPBIT_RATE_COORDINATOR_TEMP_STATE_FORBIDDEN');
    }
  }
  return absolute;
}

function allowTemporaryTestState(options = {}) {
  if (options.allowTemporaryStateDir !== true) return false;
  if (process.env.NODE_ENV === 'test' || process.env.NODE_TEST_CONTEXT) return true;
  throw coordinatorError('Temporary coordinator state roots are available only to tests.', 'UPBIT_RATE_COORDINATOR_TEMP_STATE_FORBIDDEN');
}

function createServerClock(options = {}) {
  const usesTestClockOverrides = options.bootIdentity !== undefined || options.monotonicNow !== undefined;
  if (usesTestClockOverrides && process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
    throw coordinatorError('Coordinator clock overrides are available only to tests.', 'UPBIT_RATE_COORDINATOR_TEST_CLOCK_FORBIDDEN');
  }
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const monoNowNs = typeof options.monotonicNow === 'function' ? options.monotonicNow : monotonicNowNs;
  const bootIdentity = options.bootIdentity ?? readBootIdentity();
  if (typeof bootIdentity !== 'string' || !bootIdentity || bootIdentity.length > 128) {
    throw coordinatorError('Coordinator boot identity is invalid.', 'UPBIT_RATE_COORDINATOR_CLOCK_IDENTITY_UNAVAILABLE');
  }
  const initialMono = monoNowNs();
  if (typeof initialMono !== 'bigint' || initialMono < 0n) {
    throw coordinatorError('Coordinator monotonic clock is invalid.', 'UPBIT_RATE_COORDINATOR_CLOCK_IDENTITY_UNAVAILABLE');
  }
  return { now, monoNowNs, bootIdentity };
}

export function resolveUpbitRateCoordinatorPaths(
  stateDir = process.env.UPBIT_RATE_COORDINATOR_STATE_DIR || process.env.COINPILOT_STATE_DIR,
  options = {}
) {
  const root = resolveStateRoot(stateDir, { allowTemporaryStateDir: allowTemporaryTestState(options) });
  const directory = path.join(root, 'upbit-rate-coordinator');
  const socketPath = path.join(directory, 'coordinator.sock');
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw coordinatorError('Coordinator Unix socket path is too long for this platform.', 'UPBIT_RATE_COORDINATOR_SOCKET_PATH_TOO_LONG');
  }
  return Object.freeze({
    stateRoot: root,
    directory,
    socketPath,
    stateFilePath: path.join(directory, 'state.json'),
    ownerLockPath: path.join(directory, 'daemon.lock')
  });
}

function sameBackoffMap(left = {}, right = {}) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function sameState(left, right) {
  return left.schema === right.schema && left.version === right.version &&
    left.bootIdentity === right.bootIdentity && left.nextDispatchAt === right.nextDispatchAt &&
    left.nextDispatchMonoNs === right.nextDispatchMonoNs &&
    left.manualRecoveryRequired === right.manualRecoveryRequired &&
    sameBackoffMap(left.backoffUntilByGroup, right.backoffUntilByGroup) &&
    sameBackoffMap(left.backoffMonoNsByGroup, right.backoffMonoNsByGroup);
}

class PersistentCoordinatorState {
  constructor(stateFilePath, directory, ownerLock, clock) {
    this.stateFilePath = stateFilePath;
    this.directory = directory;
    this.ownerLock = ownerLock;
    this.bootIdentity = clock.bootIdentity;
    this.now = clock.now;
    this.monoNowNs = clock.monoNowNs;
    this.initialWallMs = this.now();
    this.initialMonoNowNs = this.monoNowNs();
    const loaded = readPersistentState(
      stateFilePath,
      this.bootIdentity,
      () => this.initialWallMs,
      this.initialMonoNowNs
    );
    this.state = loaded.state;
    this.fileStat = loaded.stat;
    this.hash = loaded.hash;
    this.recoveryKind = loaded.recoveryKind;
    this.failure = null;
  }

  verifyOwnerLock() {
    const observed = readOwnerFile(this.ownerLockPath);
    if (observed.kind !== 'active' || observed.owner.pid !== process.pid ||
      observed.owner.processIdentity !== this.ownerLock.owner.processIdentity ||
      observed.owner.lockId !== this.ownerLock.owner.lockId || !sameFile(observed.stat, this.ownerLock.stat)) {
      throw observed.error || coordinatorError('Coordinator process no longer owns its lock.', 'UPBIT_RATE_COORDINATOR_LOCK_AMBIGUOUS');
    }
  }

  get ownerLockPath() {
    return this.ownerLock.filePath;
  }

  verifyCurrentStateFile() {
    const current = readPersistentState(
      this.stateFilePath,
      this.bootIdentity,
      () => this.initialWallMs,
      this.initialMonoNowNs
    );
    if (this.fileStat === null) {
      if (current.stat !== null) {
        throw coordinatorError('Coordinator state file appeared outside its owner.', 'UPBIT_RATE_COORDINATOR_STATE_AMBIGUOUS');
      }
      return;
    }
    if (!sameFile(current.stat, this.fileStat) || current.hash !== this.hash || !sameState(current.state, this.state)) {
      throw coordinatorError('Coordinator state file changed outside its owner.', 'UPBIT_RATE_COORDINATOR_STATE_AMBIGUOUS');
    }
  }

  save(nextState) {
    if (this.failure) throw this.failure;
    const validated = validateState(nextState);
    try {
      this.verifyOwnerLock();
      this.verifyCurrentStateFile();
      const serialized = JSON.stringify(validated);
      if (Buffer.byteLength(serialized) > MAX_STATE_FILE_BYTES) {
        throw coordinatorError(`Coordinator state JSON exceeds the ${MAX_STATE_FILE_BYTES}-byte safety limit.`, 'UPBIT_RATE_COORDINATOR_STATE_TOO_LARGE');
      }
      const temporaryPath = `${this.stateFilePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      let created = false;
      try {
        const descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
        created = true;
        try {
          fs.fchmodSync(descriptor, 0o600);
          fs.writeFileSync(descriptor, serialized, 'utf8');
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        fs.renameSync(temporaryPath, this.stateFilePath);
        created = false;
        syncDirectory(this.directory);
      } finally {
        if (created) {
          try { fs.unlinkSync(temporaryPath); } catch { /* preserve the original failure */ }
        }
      }
      const stat = fs.lstatSync(this.stateFilePath);
      ensureOwnedRegularFile(this.stateFilePath, stat, 'Coordinator state file');
      this.state = validated;
      this.fileStat = stat;
      this.hash = crypto.createHash('sha256').update(serialized).digest('hex');
      return this.state;
    } catch (error) {
      this.failure = error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
        ? error
        : coordinatorError('Unable to persist shared Upbit rate state.', 'UPBIT_RATE_COORDINATOR_STATE_WRITE_FAILED', { cause: error });
      throw this.failure;
    }
  }
}

function socketProbe(socketPath, timeoutMs = 250) {
  return new Promise(resolve => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ active: false, code: 'ETIMEDOUT' }), timeoutMs);
    socket.once('connect', () => finish({ active: true }));
    socket.once('error', error => finish({ active: false, code: error.code || 'UNKNOWN', error }));
  });
}

async function removeStaleSocketIfOwned(socketPath, directory) {
  let before;
  try {
    before = fs.lstatSync(socketPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!before.isSocket()) {
    throw coordinatorError('Coordinator socket path exists but is not a Unix socket; it was left untouched.', 'UPBIT_RATE_COORDINATOR_SOCKET_AMBIGUOUS');
  }
  const uid = currentUid();
  if ((uid !== null && before.uid !== uid) || !hasOnlyOwnerPermissions(before)) {
    throw coordinatorError('Existing coordinator socket owner or permissions cannot be verified; it was left untouched.', 'UPBIT_RATE_COORDINATOR_SOCKET_AMBIGUOUS');
  }

  const probe = await socketProbe(socketPath);
  if (probe.active) {
    throw coordinatorError('An active coordinator is already listening on this socket.', 'UPBIT_RATE_COORDINATOR_ALREADY_RUNNING');
  }
  if (!['ECONNREFUSED', 'ENOENT'].includes(probe.code)) {
    throw coordinatorError('Coordinator socket could not be safely classified; it was left untouched.', 'UPBIT_RATE_COORDINATOR_SOCKET_AMBIGUOUS', { cause: probe.error });
  }

  let after;
  try {
    after = fs.lstatSync(socketPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (!sameFile(before, after) || !after.isSocket() || (uid !== null && after.uid !== uid) || !hasOnlyOwnerPermissions(after)) {
    throw coordinatorError('Coordinator socket identity changed during stale recovery; it was left untouched.', 'UPBIT_RATE_COORDINATOR_SOCKET_AMBIGUOUS');
  }
  fs.unlinkSync(socketPath);
  syncDirectory(directory);
  return true;
}

function validateAcquireOptions(options = {}) {
  normalizeScope(options);
  const group = normalizeGroup(options.group ?? options.rateLimitGroup ?? 'all');
  const priority = options.priority === 'risk' ? 'risk' : 'normal';
  const priorityOrder = Number(options.priorityOrder);
  const deadlineAt = options.deadlineAt === undefined || options.deadlineAt === null
    ? null
    : Number(options.deadlineAt);
  if (deadlineAt !== null && !Number.isFinite(deadlineAt)) {
    throw coordinatorError('Coordinator deadlineAt must be a finite timestamp.', 'UPBIT_RATE_COORDINATOR_INVALID_REQUEST');
  }
  const rawQueueWaitTimeoutMs = options.queueWaitTimeoutMs;
  let queueWaitTimeoutMs = DEFAULT_QUEUE_TIMEOUT_MS[priority];
  if (rawQueueWaitTimeoutMs !== undefined) {
    try {
      queueWaitTimeoutMs = Number(rawQueueWaitTimeoutMs);
    } catch {
      throw coordinatorError('Coordinator queue wait must be a finite non-negative number.', 'UPBIT_RATE_COORDINATOR_INVALID_REQUEST');
    }
  }
  if (!Number.isFinite(queueWaitTimeoutMs) || queueWaitTimeoutMs < 0 ||
    queueWaitTimeoutMs > MAX_COORDINATOR_DELAY_MS) {
    throw coordinatorError(`Coordinator queue wait must be finite, non-negative, and no more than ${MAX_COORDINATOR_DELAY_MS}ms.`, 'UPBIT_RATE_COORDINATOR_INVALID_REQUEST');
  }
  const suppliedInterval = Number(options.minRequestIntervalMs);
  if (Number.isFinite(suppliedInterval) && suppliedInterval > MAX_COORDINATOR_DELAY_MS) {
    throw coordinatorError(`Coordinator request interval exceeds the ${MAX_COORDINATOR_DELAY_MS}ms safety limit.`, 'UPBIT_RATE_COORDINATOR_INVALID_REQUEST');
  }
  return {
    scope: 'ip',
    group,
    priority,
    priorityOrder: Number.isFinite(priorityOrder) ? priorityOrder : 0,
    deadlineAt,
    queueWaitTimeoutMs,
    minRequestIntervalMs: Math.max(
      MIN_REQUEST_INTERVAL_MS,
      numberAtLeastZero(options.minRequestIntervalMs, MIN_REQUEST_INTERVAL_MS)
    )
  };
}

function errorFromWire(wire) {
  const error = coordinatorError(
    typeof wire?.message === 'string' ? wire.message : 'Shared Upbit rate coordinator rejected the request.',
    typeof wire?.code === 'string' ? wire.code : 'UPBIT_RATE_COORDINATOR_PROTOCOL'
  );
  if (error.code === 'UPBIT_REQUEST_ABORTED') error.name = 'AbortError';
  return error;
}

function parseWireMessage(line) {
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.type !== 'string') {
      throw new Error('invalid wire message');
    }
    return value;
  } catch (error) {
    throw coordinatorError('Coordinator message is malformed.', 'UPBIT_RATE_COORDINATOR_PROTOCOL', { cause: error });
  }
}

export class UpbitRateCoordinatorClient {
  constructor({ socketPath, connectionTimeoutMs = 1_000, commandTimeoutMs = 2_000 } = {}) {
    if (typeof socketPath !== 'string' || !socketPath.trim()) {
      throw coordinatorError('A coordinator socket path is required.', 'UPBIT_RATE_COORDINATOR_SOCKET_REQUIRED');
    }
    if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
      throw coordinatorError('Coordinator Unix socket path is too long for this platform.', 'UPBIT_RATE_COORDINATOR_SOCKET_PATH_TOO_LONG');
    }
    this.socketPath = socketPath;
    this.connectionTimeoutMs = numberAtLeastZero(connectionTimeoutMs, 1_000);
    this.commandTimeoutMs = numberAtLeastZero(commandTimeoutMs, 2_000);
    this.closed = false;
    this.sockets = new Set();
    this.pending = new Set();
    this.leases = new Set();
  }

  #assertOpen() {
    if (this.closed) throw coordinatorError('Coordinator client is closed.', 'UPBIT_RATE_COORDINATOR_CLIENT_CLOSED');
  }

  #openCommand(command, { timeoutMs = this.commandTimeoutMs, signal } = {}) {
    this.#assertOpen();
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: this.socketPath });
      const pending = { socket, reject, settled: false, timer: null, abortHandler: null };
      this.sockets.add(socket);
      this.pending.add(pending);
      let buffer = '';
      let connected = false;

      const cleanup = () => {
        if (pending.timer !== null) clearTimeout(pending.timer);
        if (signal && pending.abortHandler) signal.removeEventListener('abort', pending.abortHandler);
        this.pending.delete(pending);
      };
      const fail = error => {
        if (pending.settled) return;
        pending.settled = true;
        cleanup();
        reject(error);
        socket.destroy();
      };
      const armTimeout = duration => {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.timer = setTimeout(() => fail(coordinatorError(
          connected ? 'Coordinator response timed out.' : 'Coordinator socket connection timed out.',
          'UPBIT_RATE_COORDINATOR_UNAVAILABLE'
        )), Math.max(0, duration));
      };

      if (signal?.aborted) {
        fail(coordinatorError('Upbit request was aborted before coordinator admission.', 'UPBIT_REQUEST_ABORTED', { name: 'AbortError' }));
        return;
      }
      if (signal) {
        pending.abortHandler = () => fail(coordinatorError(
          'Upbit request was aborted while waiting for coordinator admission.',
          'UPBIT_REQUEST_ABORTED',
          { name: 'AbortError' }
        ));
        signal.addEventListener('abort', pending.abortHandler, { once: true });
      }
      armTimeout(this.connectionTimeoutMs);
      socket.setEncoding('utf8');
      socket.setNoDelay(true);
      socket.on('connect', () => {
        connected = true;
        armTimeout(timeoutMs);
        socket.write(`${JSON.stringify(command)}\n`);
      });
      socket.on('data', chunk => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) {
          if (buffer.length > 65_536) fail(coordinatorError('Coordinator reply is too large.', 'UPBIT_RATE_COORDINATOR_PROTOCOL'));
          return;
        }
        let response;
        try {
          response = parseWireMessage(buffer.slice(0, newline));
        } catch (error) {
          fail(error);
          return;
        }
        if (pending.settled) return;
        if (response.type === 'error') {
          fail(errorFromWire(response.error));
          return;
        }
        pending.settled = true;
        cleanup();
        this.pending.delete(pending);
        resolve({ response, socket });
      });
      socket.on('error', error => {
        this.sockets.delete(socket);
        fail(coordinatorError('Unable to reach the shared Upbit rate coordinator.', 'UPBIT_RATE_COORDINATOR_UNAVAILABLE', { cause: error }));
      });
      socket.on('close', () => {
        this.sockets.delete(socket);
        if (!pending.settled) {
          fail(coordinatorError('Coordinator connection closed before admission.', 'UPBIT_RATE_COORDINATOR_UNAVAILABLE'));
        }
      });
    });
  }

  async acquireTurn(options = {}) {
    const normalized = validateAcquireOptions(options);
    const entryWallMs = Date.now();
    const entryMonoNs = monotonicNowNs();
    const queueDeadlineAt = entryWallMs + normalized.queueWaitTimeoutMs;
    const deadlineAt = normalized.deadlineAt === null
      ? queueDeadlineAt
      : Math.min(queueDeadlineAt, normalized.deadlineAt);
    const requestDeadlineIsEarlier = normalized.deadlineAt !== null && normalized.deadlineAt <= queueDeadlineAt;
    if (deadlineAt <= entryWallMs) {
      throw coordinatorError(
        requestDeadlineIsEarlier ? 'Upbit request deadline expired before coordinator admission.' : 'Upbit coordinator queue deadline expired before admission.',
        requestDeadlineIsEarlier ? 'UPBIT_REQUEST_DEADLINE' : 'UPBIT_QUEUE_TIMEOUT'
      );
    }
    const remaining = deadlineAt - entryWallMs;
    const effectiveDeadlineMonoNs = entryMonoNs + delayMsToNs(remaining);
    const { response, socket } = await this.#openCommand({
      type: 'acquire',
      request: {
        ...normalized,
        effectiveDeadlineMonoNs: effectiveDeadlineMonoNs.toString(),
        effectiveDeadlineCode: requestDeadlineIsEarlier ? 'UPBIT_REQUEST_DEADLINE' : 'UPBIT_QUEUE_TIMEOUT'
      }
    }, { timeoutMs: Math.min(remaining + this.connectionTimeoutMs, 2_147_483_647), signal: options.signal });
    if (response.type !== 'acquired' || typeof response.leaseId !== 'string') {
      socket.destroy();
      throw coordinatorError('Coordinator returned an invalid lease response.', 'UPBIT_RATE_COORDINATOR_PROTOCOL');
    }

    const lease = {
      leaseId: response.leaseId,
      startedAt: response.startedAt,
      released: false,
      socket,
      release: async () => {
        if (lease.released) return false;
        lease.released = true;
        this.leases.delete(lease);
        if (socket.destroyed) {
          this.sockets.delete(socket);
          return true;
        }
        try {
          const { response: releaseResponse } = await this.#exchangeOnSocket(socket, {
            type: 'release',
            leaseId: lease.leaseId
          }, 1_000);
          return releaseResponse.type === 'released';
        } catch {
          // Closing the lease socket also releases the server-side permit.
          socket.destroy();
          return false;
        } finally {
          this.sockets.delete(socket);
        }
      }
    };
    this.leases.add(lease);
    socket.on('close', () => {
      lease.released = true;
      this.leases.delete(lease);
      this.sockets.delete(socket);
    });
    return lease;
  }

  #exchangeOnSocket(socket, command, timeoutMs) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let settled = false;
      const timer = setTimeout(() => finish(coordinatorError('Coordinator command timed out.', 'UPBIT_RATE_COORDINATOR_UNAVAILABLE')), timeoutMs);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        if (error) reject(error);
        else resolve(value);
      };
      const onData = chunk => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const response = parseWireMessage(buffer.slice(0, newline));
          if (response.type === 'error') finish(errorFromWire(response.error));
          else finish(null, { response });
        } catch (error) {
          finish(error);
        }
      };
      const onError = error => finish(coordinatorError('Coordinator lease connection failed.', 'UPBIT_RATE_COORDINATOR_UNAVAILABLE', { cause: error }));
      const onClose = () => finish(coordinatorError('Coordinator lease connection closed before acknowledgement.', 'UPBIT_RATE_COORDINATOR_UNAVAILABLE'));
      socket.on('data', onData);
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.write(`${JSON.stringify(command)}\n`);
    });
  }

  async applyBackoff(delayMs, options = {}) {
    normalizeScope(options);
    const delay = Number(delayMs);
    if (!Number.isFinite(delay) || delay < 0) {
      throw coordinatorError('Shared backoff delay must be a finite non-negative number.', 'UPBIT_RATE_COORDINATOR_INVALID_BACKOFF');
    }
    const scopeWide = options.scopeWide === true || options.rateLimitScopeWide === true;
    const group = scopeWide ? null : normalizeGroup(options.group ?? options.rateLimitGroup ?? 'all');
    const { response, socket } = await this.#openCommand({
      type: 'backoff',
      scope: 'ip',
      group,
      scopeWide,
      delayMs: delay
    });
    socket.end();
    if (response.type !== 'backoff-applied') {
      throw coordinatorError('Coordinator returned an invalid backoff response.', 'UPBIT_RATE_COORDINATOR_PROTOCOL');
    }
    return response.until;
  }

  async observeRemaining(group, sec) {
    const normalizedGroup = normalizeGroup(group);
    const remaining = Number(sec);
    if (!Number.isSafeInteger(remaining) || remaining < 0) {
      throw coordinatorError('Remaining-Req sec must be a non-negative integer.', 'UPBIT_RATE_COORDINATOR_INVALID_REMAINING');
    }
    if (remaining > 0) return false;
    const { response, socket } = await this.#openCommand({
      type: 'remaining',
      scope: 'ip',
      group: normalizedGroup,
      sec: remaining
    });
    socket.end();
    if (response.type !== 'backoff-applied') {
      throw coordinatorError('Coordinator returned an invalid Remaining-Req response.', 'UPBIT_RATE_COORDINATOR_PROTOCOL');
    }
    return response.until;
  }

  async getStatus() {
    const { response, socket } = await this.#openCommand({ type: 'status', scope: 'ip' });
    socket.end();
    if (response.type !== 'status') {
      throw coordinatorError('Coordinator returned an invalid status response.', 'UPBIT_RATE_COORDINATOR_PROTOCOL');
    }
    return response.status;
  }

  async close() {
    if (this.closed) return false;
    this.closed = true;
    for (const pending of [...this.pending]) {
      pending.reject(coordinatorError('Coordinator client closed while a request was waiting.', 'UPBIT_RATE_COORDINATOR_CLIENT_CLOSED'));
      pending.socket.destroy();
    }
    await Promise.all([...this.leases].map(lease => lease.release()));
    for (const socket of [...this.sockets]) socket.destroy();
    this.sockets.clear();
    return true;
  }
}

function normalizeServerRequest(request, nowMonoNs) {
  const normalized = validateAcquireOptions(request);
  const localQueueDeadlineMonoNs = nowMonoNs + delayMsToNs(normalized.queueWaitTimeoutMs);
  const suppliedDeadline = request.effectiveDeadlineMonoNs;
  if (suppliedDeadline !== undefined && (typeof suppliedDeadline !== 'string' || !/^\d{1,32}$/.test(suppliedDeadline))) {
    throw coordinatorError('Coordinator monotonic deadline is malformed.', 'UPBIT_RATE_COORDINATOR_INVALID_REQUEST');
  }
  const requestedMonoNs = suppliedDeadline === undefined ? localQueueDeadlineMonoNs : BigInt(suppliedDeadline);
  const deadlineMonoNs = minBigInt([requestedMonoNs, localQueueDeadlineMonoNs]);
  const deadlineCode = request.effectiveDeadlineCode === 'UPBIT_REQUEST_DEADLINE'
    ? 'UPBIT_REQUEST_DEADLINE'
    : 'UPBIT_QUEUE_TIMEOUT';
  return { ...normalized, deadlineMonoNs, deadlineCode };
}

function minBigInt(values) {
  return values.reduce((minimum, value) => value < minimum ? value : minimum);
}

function maxBigInt(left, right) {
  return left > right ? left : right;
}

export async function startUpbitRateCoordinatorServer(options = {}) {
  if (options.onRecoveryMarkerCreated !== undefined &&
    (typeof options.onRecoveryMarkerCreated !== 'function' ||
      (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT))) {
    throw coordinatorError('Recovery marker hooks are available only to tests.', 'UPBIT_RATE_COORDINATOR_TEST_HOOK_FORBIDDEN');
  }
  const clock = createServerClock(options);
  const paths = resolveUpbitRateCoordinatorPaths(options.stateDir, {
    allowTemporaryStateDir: allowTemporaryTestState(options)
  });
  if (Buffer.byteLength(paths.socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw coordinatorError('Coordinator Unix socket path is too long for this platform.', 'UPBIT_RATE_COORDINATOR_SOCKET_PATH_TOO_LONG');
  }
  ensurePrivateDirectory(paths.directory);
  const ownerLock = acquireExclusiveFile(paths.ownerLockPath, {
    onRecoveryMarkerCreated: options.onRecoveryMarkerCreated
  });
  ownerLock.filePath = paths.ownerLockPath;
  let initial;
  try {
    initial = new PersistentCoordinatorState(paths.stateFilePath, paths.directory, ownerLock, clock);
    if (initial.recoveryKind === 'os-boot-conservative-full-cooldown') initial.save(initial.state);
    await removeStaleSocketIfOwned(paths.socketPath, paths.directory);
  } catch (error) {
    try { releaseOwnedFile(paths.ownerLockPath, ownerLock, 'Coordinator owner lock'); } catch { /* preserve startup failure */ }
    throw error;
  }

  const server = net.createServer();
  const coordinator = new UpbitRateCoordinatorServer(server, paths, ownerLock, initial, {
    ...options,
    now: clock.now,
    monotonicNow: clock.monoNowNs,
    bootIdentity: clock.bootIdentity
  });
  server.on('connection', socket => coordinator.accept(socket));
  try {
    await new Promise((resolve, reject) => {
      const onError = error => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(paths.socketPath);
    });
    fs.chmodSync(paths.socketPath, 0o600);
    const socketStat = fs.lstatSync(paths.socketPath);
    const uid = currentUid();
    if (!socketStat.isSocket() || (uid !== null && socketStat.uid !== uid) || !hasOnlyOwnerPermissions(socketStat)) {
      throw coordinatorError('Bound coordinator socket does not have verified owner-only permissions.', 'UPBIT_RATE_COORDINATOR_SOCKET_PERMISSIONS');
    }
    coordinator.socketStat = socketStat;
    coordinator.initialize();
    return coordinator;
  } catch (error) {
    try {
      if (server.listening) {
        await new Promise(resolve => server.close(() => resolve()));
      }
    } catch {
      // Preserve the startup failure; lock release below still verifies identity.
    }
    try { releaseOwnedFile(paths.ownerLockPath, ownerLock, 'Coordinator owner lock'); } catch { /* preserve startup failure */ }
    throw error;
  }
}

class UpbitRateCoordinatorServer {
  constructor(server, paths, ownerLock, persistentState, options = {}) {
    this.server = server;
    this.paths = paths;
    this.ownerLock = ownerLock;
    this.persistentState = persistentState;
    this.now = options.now || Date.now;
    this.monotonicNowNs = options.monotonicNow || monotonicNowNs;
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.maxInFlight = Number.isSafeInteger(options.maxInFlight) && options.maxInFlight > 0 ? options.maxInFlight : 4;
    const reserve = Number.isSafeInteger(options.riskReserveSlots) && options.riskReserveSlots >= 0
      ? options.riskReserveSlots
      : 1;
    this.riskReserveSlots = Math.min(Math.max(0, this.maxInFlight - 1), reserve);
    this.maxQueuedNormal = Number.isSafeInteger(options.maxQueuedNormal) && options.maxQueuedNormal >= 0 ? options.maxQueuedNormal : 256;
    this.maxQueuedRisk = Number.isSafeInteger(options.maxQueuedRisk) && options.maxQueuedRisk >= 0 ? options.maxQueuedRisk : 64;
    this.shutdownTimeoutMs = numberAtLeastZero(options.shutdownTimeoutMs, 10_000);
    this.queue = [];
    this.leases = new Map();
    this.connections = new Set();
    this.sequence = 0;
    this.pumpTimer = null;
    this.stopping = false;
    this.clockRecoveryMode = persistentState.recoveryKind;
    const manualRecoveryCode = persistentState.state.manualRecoveryRequired;
    this.failure = manualRecoveryCode
      ? coordinatorError(
        manualRecoveryCode === LEGACY_STATE_RECOVERY_CODE
          ? `Legacy wall-clock-only coordinator state at ${persistentState.stateFilePath} cannot be recovered safely. Stop all Upbit consumers, preserve the file, confirm the prior exchange cooldown has elapsed, then remove only this legacy state file before restart.`
          : `Coordinator state requires manual recovery (${manualRecoveryCode}). Stop all Upbit consumers, verify the exchange cooldown has elapsed, preserve state.json for review, then repair only the manualRecoveryRequired state field before restart.`,
        manualRecoveryCode
      )
      : null;
    this.socketStat = null;
    this.closePromise = null;
  }

  get socketPath() {
    return this.paths.socketPath;
  }

  get stateFilePath() {
    return this.paths.stateFilePath;
  }

  initialize() {
    this.#pump();
  }

  accept(socket) {
    const connection = { socket, buffer: '', waiter: null, leaseId: null, closed: false };
    this.connections.add(connection);
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('data', chunk => {
      connection.buffer += chunk;
      if (connection.buffer.length > 65_536) {
        this.#sendError(connection, coordinatorError('Coordinator request is too large.', 'UPBIT_RATE_COORDINATOR_PROTOCOL'));
        return;
      }
      while (true) {
        const newline = connection.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = connection.buffer.slice(0, newline);
        connection.buffer = connection.buffer.slice(newline + 1);
        try {
          this.#handleMessage(connection, parseWireMessage(line));
        } catch (error) {
          this.#sendError(connection, error);
        }
      }
    });
    socket.on('error', () => this.#disconnect(connection));
    socket.on('close', () => this.#disconnect(connection));
  }

  #send(connection, message, { end = false } = {}) {
    if (connection.closed || connection.socket.destroyed) return false;
    try {
      connection.socket.write(`${JSON.stringify(message)}\n`, () => {
        if (end && !connection.socket.destroyed) connection.socket.end();
      });
      return true;
    } catch {
      connection.socket.destroy();
      return false;
    }
  }

  #sendError(connection, error) {
    this.#send(connection, {
      type: 'error',
      error: { code: error?.code || 'UPBIT_RATE_COORDINATOR_INTERNAL', message: error?.message || 'Coordinator request failed.' }
    }, { end: true });
  }

  #handleMessage(connection, message) {
    if (connection.closed) return;
    if (message.type === 'acquire') {
      if (connection.waiter || connection.leaseId) {
        throw coordinatorError('A coordinator socket may own only one ticket or lease.', 'UPBIT_RATE_COORDINATOR_PROTOCOL');
      }
      if (this.stopping || this.failure) {
        throw this.failure || coordinatorError('Coordinator is shutting down.', 'UPBIT_RATE_COORDINATOR_UNAVAILABLE');
      }
      const nowMono = this.monotonicNowNs();
      const request = normalizeServerRequest(message.request || {}, nowMono);
      const queueDeadline = request.deadlineMonoNs;
      if (queueDeadline <= nowMono) {
        throw coordinatorError('Upbit request expired before shared admission.', request.deadlineCode);
      }
      const queuedPriority = this.queue.filter(item => item.priority === request.priority).length;
      const queueLimit = request.priority === 'risk' ? this.maxQueuedRisk : this.maxQueuedNormal;
      if (queuedPriority >= queueLimit) {
        throw coordinatorError(`Shared Upbit ${request.priority} queue is full (${queueLimit}).`, 'UPBIT_QUEUE_FULL');
      }
      const waiter = {
        ...request,
        sequence: this.sequence++,
        addedAtMonoNs: nowMono,
        connection
      };
      connection.waiter = waiter;
      this.queue.push(waiter);
      this.#pump();
      return;
    }
    if (message.type === 'release') {
      if (!connection.leaseId || connection.leaseId !== message.leaseId) {
        throw coordinatorError('Coordinator lease is not owned by this socket.', 'UPBIT_RATE_COORDINATOR_LEASE_INVALID');
      }
      this.#releaseLease(connection);
      this.#send(connection, { type: 'released', leaseId: message.leaseId }, { end: true });
      this.#pump();
      return;
    }
    if (message.type === 'backoff') {
      if (this.stopping || this.failure) throw this.failure || coordinatorError('Coordinator is shutting down.', 'UPBIT_RATE_COORDINATOR_UNAVAILABLE');
      normalizeScope({ scope: message.scope });
      const delayMs = message.delayMs;
      if (typeof delayMs !== 'number' || !Number.isFinite(delayMs) || delayMs < 0) {
        throw coordinatorError('Shared backoff delay must be a finite non-negative number.', 'UPBIT_RATE_COORDINATOR_INVALID_BACKOFF');
      }
      const scopeWide = message.scopeWide === true;
      const group = scopeWide ? null : normalizeGroup(message.group);
      if (delayMs > MAX_COORDINATOR_DELAY_MS) {
        throw this.#blockForManualRecovery(MANUAL_BACKOFF_RECOVERY_CODE);
      }
      const until = this.#applyBackoff(delayMs, group, scopeWide);
      this.#send(connection, { type: 'backoff-applied', until }, { end: true });
      return;
    }
    if (message.type === 'remaining') {
      if (this.stopping || this.failure) throw this.failure || coordinatorError('Coordinator is shutting down.', 'UPBIT_RATE_COORDINATOR_UNAVAILABLE');
      normalizeScope({ scope: message.scope });
      const group = normalizeGroup(message.group);
      const remaining = Number(message.sec);
      if (!Number.isSafeInteger(remaining) || remaining < 0) {
        throw coordinatorError('Remaining-Req sec must be a non-negative integer.', 'UPBIT_RATE_COORDINATOR_INVALID_REMAINING');
      }
      const until = remaining === 0
        ? this.#applyBackoff(1000, group, false)
        : false;
      this.#send(connection, { type: 'backoff-applied', until }, { end: true });
      return;
    }
    if (message.type === 'status') {
      normalizeScope({ scope: message.scope });
      this.#send(connection, { type: 'status', status: this.getStatus() }, { end: true });
      return;
    }
    throw coordinatorError('Unsupported coordinator message type.', 'UPBIT_RATE_COORDINATOR_PROTOCOL');
  }

  #disconnect(connection) {
    if (connection.closed) return;
    connection.closed = true;
    this.connections.delete(connection);
    if (connection.waiter) this.#removeWaiter(connection.waiter);
    if (connection.leaseId) this.#releaseLease(connection);
    if (!this.stopping && !this.failure) this.#pump();
  }

  #removeWaiter(waiter) {
    const index = this.queue.indexOf(waiter);
    if (index >= 0) this.queue.splice(index, 1);
    if (waiter.connection.waiter === waiter) waiter.connection.waiter = null;
  }

  #releaseLease(connection) {
    const leaseId = connection.leaseId;
    if (!leaseId) return false;
    connection.leaseId = null;
    this.leases.delete(leaseId);
    return true;
  }

  #inFlightByPriority() {
    const counts = { normal: 0, risk: 0 };
    for (const lease of this.leases.values()) counts[lease.priority] += 1;
    return counts;
  }

  #canDispatch(priority) {
    if (this.leases.size >= this.maxInFlight) return false;
    if (priority === 'risk') return true;
    return this.#inFlightByPriority().normal < this.maxInFlight - this.riskReserveSlots;
  }

  #backoffUntilFor(group) {
    const backoffs = this.persistentState.state.backoffMonoNsByGroup;
    return maxBigInt(BigInt(backoffs[group] || '0'), BigInt(backoffs['*'] || '0'));
  }

  #expireWaiters(now) {
    for (const waiter of [...this.queue]) {
      if (now < waiter.deadlineMonoNs) continue;
      this.#removeWaiter(waiter);
      this.#sendError(waiter.connection, coordinatorError('Upbit request exceeded its shared admission deadline.', waiter.deadlineCode));
    }
  }

  #pruneExpiredBackoffs(nowMono) {
    const current = this.persistentState.state;
    const expiredGroups = Object.entries(current.backoffMonoNsByGroup)
      .filter(([, until]) => BigInt(until) <= nowMono)
      .map(([group]) => group);
    if (expiredGroups.length === 0) return;

    const backoffUntilByGroup = { ...current.backoffUntilByGroup };
    const backoffMonoNsByGroup = { ...current.backoffMonoNsByGroup };
    for (const group of expiredGroups) {
      delete backoffUntilByGroup[group];
      delete backoffMonoNsByGroup[group];
    }
    try {
      this.persistentState.save({ ...current, backoffUntilByGroup, backoffMonoNsByGroup });
    } catch (error) {
      this.#fail(error);
    }
  }

  #scheduleBackoffExpiry(nowMono) {
    const deadlines = Object.values(this.persistentState.state.backoffMonoNsByGroup)
      .map(value => BigInt(value))
      .filter(until => until > nowMono);
    if (deadlines.length > 0) {
      this.#schedulePumpAt(minBigInt(deadlines));
      return;
    }
    if (this.pumpTimer !== null) this.clearTimer(this.pumpTimer);
    this.pumpTimer = null;
  }

  #schedulePumpAt(targetAt) {
    if (this.pumpTimer !== null) this.clearTimer(this.pumpTimer);
    this.pumpTimer = this.setTimer(() => {
      this.pumpTimer = null;
      this.#pump();
    }, Math.max(0, Math.min(2_147_483_647, remainingMs(targetAt, this.monotonicNowNs()))));
  }

  #pump() {
    if (this.stopping || this.failure) return;
    const nowWall = this.now();
    const nowMono = this.monotonicNowNs();
    this.#expireWaiters(nowMono);
    this.#pruneExpiredBackoffs(nowMono);
    if (this.failure) return;
    if (this.queue.length === 0) {
      this.#scheduleBackoffExpiry(nowMono);
      return;
    }
    while (this.queue.length > 0) {
      const candidates = this.queue
        .filter(waiter => this.#canDispatch(waiter.priority))
        .sort((left, right) => {
          if (left.priority !== right.priority) return left.priority === 'risk' ? -1 : 1;
          if (left.priorityOrder !== right.priorityOrder) return left.priorityOrder - right.priorityOrder;
          return left.sequence - right.sequence;
      });
      if (candidates.length === 0) {
        const deadlines = [
          ...this.queue.map(waiter => waiter.deadlineMonoNs),
          ...Object.values(this.persistentState.state.backoffMonoNsByGroup).map(value => BigInt(value))
        ];
        if (deadlines.length) this.#schedulePumpAt(minBigInt(deadlines));
        return;
      }
      const nextDispatchMonoNs = BigInt(this.persistentState.state.nextDispatchMonoNs);
      const candidate = candidates.find(waiter => maxBigInt(
        nextDispatchMonoNs,
        this.#backoffUntilFor(waiter.group)
      ) <= nowMono);
      if (!candidate) {
        const wakeAt = minBigInt(candidates.map(waiter => minBigInt([
          waiter.deadlineMonoNs,
          maxBigInt(nextDispatchMonoNs, this.#backoffUntilFor(waiter.group))
        ])));
        this.#schedulePumpAt(wakeAt);
        return;
      }

      this.#removeWaiter(candidate);
      const intervalMs = Math.max(MIN_REQUEST_INTERVAL_MS, candidate.minRequestIntervalMs);
      const nextState = {
        ...this.persistentState.state,
        nextDispatchAt: Math.ceil(nowWall + intervalMs),
        nextDispatchMonoNs: (nowMono + delayMsToNs(intervalMs)).toString()
      };
      try {
        this.persistentState.save(nextState);
      } catch (error) {
        this.#fail(error);
        this.#sendError(candidate.connection, error);
        return;
      }

      const leaseId = crypto.randomUUID();
      candidate.connection.leaseId = leaseId;
      this.leases.set(leaseId, { priority: candidate.priority, group: candidate.group, grantedAt: nowWall });
      this.#send(candidate.connection, { type: 'acquired', leaseId, startedAt: nowWall });
      if (this.queue.length > 0) {
        const nextCandidates = this.queue.filter(waiter => this.#canDispatch(waiter.priority));
        const wakeTimes = nextCandidates.length > 0
          ? nextCandidates.map(waiter => minBigInt([
            waiter.deadlineMonoNs,
            maxBigInt(BigInt(this.persistentState.state.nextDispatchMonoNs), this.#backoffUntilFor(waiter.group))
          ]))
          : this.queue.map(waiter => waiter.deadlineMonoNs);
        this.#schedulePumpAt(minBigInt(wakeTimes));
      } else {
        this.#scheduleBackoffExpiry(this.monotonicNowNs());
      }
      return;
    }
    if (this.pumpTimer !== null) this.clearTimer(this.pumpTimer);
    this.pumpTimer = null;
  }

  #applyBackoff(delayMs, group, scopeWide) {
    if (this.failure) throw this.failure;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw coordinatorError('Shared backoff delay must be a finite non-negative number.', 'UPBIT_RATE_COORDINATOR_INVALID_BACKOFF');
    }
    if (delayMs > MAX_COORDINATOR_DELAY_MS) throw this.#blockForManualRecovery(MANUAL_BACKOFF_RECOVERY_CODE);
    const nowWall = this.now();
    const nowMono = this.monotonicNowNs();
    const key = scopeWide ? '*' : group;
    const backoffUntilByGroup = { ...this.persistentState.state.backoffUntilByGroup };
    const backoffMonoNsByGroup = { ...this.persistentState.state.backoffMonoNsByGroup };
    const untilMono = maxBigInt(BigInt(backoffMonoNsByGroup[key] || '0'), nowMono + delayMsToNs(delayMs));
    const until = Math.ceil(nowWall + remainingMs(untilMono, nowMono));
    backoffUntilByGroup[key] = until;
    backoffMonoNsByGroup[key] = untilMono.toString();
    for (const [entryGroup, value] of Object.entries(backoffMonoNsByGroup)) {
      if (BigInt(value) <= nowMono) {
        delete backoffMonoNsByGroup[entryGroup];
        delete backoffUntilByGroup[entryGroup];
      }
    }
    try {
      this.persistentState.save({ ...this.persistentState.state, backoffUntilByGroup, backoffMonoNsByGroup });
    } catch (error) {
      this.#fail(error);
      throw error;
    }
    this.#pump();
    return until;
  }

  #blockForManualRecovery(code) {
    const error = coordinatorError(
      `Requested Upbit backoff exceeds the ${MAX_COORDINATOR_DELAY_MS}ms safety limit. The coordinator is persistently blocked; stop all Upbit consumers, preserve state.json, confirm the exchange cooldown, then repair only manualRecoveryRequired before restart.`,
      code
    );
    if (this.persistentState.state.manualRecoveryRequired !== code) {
      try {
        this.persistentState.save({ ...this.persistentState.state, manualRecoveryRequired: code });
      } catch (saveError) {
        this.#fail(saveError);
        return this.failure;
      }
    }
    this.#fail(error);
    return this.failure;
  }

  #fail(error) {
    if (this.failure) return;
    this.failure = error?.code?.startsWith?.('UPBIT_RATE_COORDINATOR_')
      ? error
      : coordinatorError('Shared Upbit rate state failed; public requests are blocked.', 'UPBIT_RATE_COORDINATOR_STATE_WRITE_FAILED', { cause: error });
    if (this.pumpTimer !== null) this.clearTimer(this.pumpTimer);
    this.pumpTimer = null;
    for (const waiter of [...this.queue]) {
      this.#removeWaiter(waiter);
      this.#sendError(waiter.connection, this.failure);
    }
  }

  getStatus() {
    const nowMono = this.monotonicNowNs();
    const queued = { normal: 0, risk: 0 };
    let oldestWaitAgeMs = { normal: null, risk: null };
    for (const waiter of this.queue) {
      queued[waiter.priority] += 1;
      const age = remainingMs(nowMono, waiter.addedAtMonoNs);
      if (oldestWaitAgeMs[waiter.priority] === null || age > oldestWaitAgeMs[waiter.priority]) {
        oldestWaitAgeMs[waiter.priority] = age;
      }
    }
    const inFlight = this.#inFlightByPriority();
    const backoffRemainingMsByScopeAndGroup = {};
    for (const [group, until] of Object.entries(this.persistentState.state.backoffMonoNsByGroup)) {
      const remaining = remainingMs(BigInt(until), nowMono);
      if (remaining > 0) backoffRemainingMsByScopeAndGroup[group === '*' ? 'ip:*' : `ip:${group}`] = remaining;
    }
    return {
      available: !this.stopping && !this.failure,
      failureCode: this.failure?.code || null,
      requiresManualRecovery: Boolean(this.persistentState.state.manualRecoveryRequired),
      clockRecovery: {
        mode: this.clockRecoveryMode,
        conservativeCooldownMs: this.clockRecoveryMode === 'os-boot-conservative-full-cooldown'
          ? MAX_COORDINATOR_DELAY_MS
          : this.clockRecoveryMode === 'os-boot-minimum-dispatch-interval'
            ? MIN_REQUEST_INTERVAL_MS
            : 0,
        maxBackoffMs: MAX_COORDINATOR_DELAY_MS
      },
      queued,
      queuedTotal: queued.normal + queued.risk,
      inFlight,
      inFlightTotal: inFlight.normal + inFlight.risk,
      oldestWaitAgeMs,
      nextStartInMs: remainingMs(BigInt(this.persistentState.state.nextDispatchMonoNs), nowMono),
      backoffRemainingMsByScopeAndGroup,
      maxInFlight: this.maxInFlight,
      maxInFlightByPriority: { normal: this.maxInFlight - this.riskReserveSlots, risk: this.maxInFlight },
      maxQueuedByPriority: { normal: this.maxQueuedNormal, risk: this.maxQueuedRisk }
    };
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.stopping = true;
    if (this.pumpTimer !== null) this.clearTimer(this.pumpTimer);
    this.pumpTimer = null;
    for (const waiter of [...this.queue]) {
      this.#removeWaiter(waiter);
      this.#sendError(waiter.connection, coordinatorError('Coordinator is shutting down.', 'UPBIT_RATE_COORDINATOR_UNAVAILABLE'));
    }
    this.closePromise = new Promise(resolve => {
      let forceTimer = null;
      let finished = false;
      const finish = async () => {
        if (finished) return;
        finished = true;
        if (forceTimer !== null) this.clearTimer(forceTimer);
        try {
          const current = fs.lstatSync(this.paths.socketPath);
          if (this.socketStat && sameFile(current, this.socketStat) && current.isSocket() &&
            (currentUid() === null || current.uid === currentUid()) && hasOnlyOwnerPermissions(current)) {
            fs.unlinkSync(this.paths.socketPath);
            syncDirectory(this.paths.directory);
          } else if (this.socketStat && !sameFile(current, this.socketStat)) {
            throw coordinatorError('Coordinator socket identity changed during shutdown; it was left untouched.', 'UPBIT_RATE_COORDINATOR_SOCKET_AMBIGUOUS');
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') this.failure ||= error;
        }
        try { releaseOwnedFile(this.paths.ownerLockPath, this.ownerLock, 'Coordinator owner lock'); } catch (error) { this.failure ||= error; }
        resolve();
      };
      forceTimer = this.setTimer(() => {
        for (const connection of this.connections) connection.socket.destroy();
      }, this.shutdownTimeoutMs);
      this.server.close(() => finish());
      if (this.connections.size === 0) finish();
    });
    await this.closePromise;
    return true;
  }
}
