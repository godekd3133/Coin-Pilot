// Upbit 레이트 코디네이터 공유 계층 — 파일 락, 상태 영속화, owner 프로토콜,
// 소켓 경로 해석, wire 메시지 직렬화. 클라이언트와 서버 데몬이 공동 소비한다.
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { envRaw } from '../config/envConfig.js';

const LEGACY_STATE_SCHEMA = 'coinpilot.upbit-rate-coordinator-state.v1';
const STATE_SCHEMA = 'coinpilot.upbit-rate-coordinator-state.v2';
const OWNER_SCHEMA = 'coinpilot.upbit-rate-coordinator-owner.v1';
export const MAX_SOCKET_PATH_BYTES = 100;
export const MIN_REQUEST_INTERVAL_MS = 120;
export const MAX_COORDINATOR_DELAY_MS = 24 * 60 * 60 * 1000;
const MAX_BACKOFF_GROUPS = 5;
const MAX_STATE_FILE_BYTES = 4 * 1024;
export const DEFAULT_QUEUE_TIMEOUT_MS = { normal: 10_000, risk: 30_000 };
const QUOTA_GROUPS = new Set(['market', 'candle', 'ticker', 'orderbook']);
const BACKOFF_KEYS = new Set([...QUOTA_GROUPS, '*']);
const MONOTONIC_NS_PER_MS = 1_000_000n;
export const MANUAL_BACKOFF_RECOVERY_CODE = 'UPBIT_RATE_COORDINATOR_BACKOFF_DELAY_EXCEEDS_MAX';
export const LEGACY_STATE_RECOVERY_CODE = 'UPBIT_RATE_COORDINATOR_LEGACY_STATE_REQUIRES_REVIEW';

export function coordinatorError(message, code, options = {}) {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined);
  error.name = options.name || 'UpbitRateCoordinatorError';
  error.code = code;
  return error;
}

export function numberAtLeastZero(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : fallback;
}

export function monotonicNowNs() {
  return process.hrtime.bigint();
}

export function delayMsToNs(delayMs) {
  return BigInt(Math.ceil(delayMs * Number(MONOTONIC_NS_PER_MS)));
}

export function remainingMs(untilNs, nowNs) {
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

export function normalizeGroup(value) {
  if (typeof value !== 'string' || !/^[a-z0-9-]+$/i.test(value.trim())) {
    throw coordinatorError('Upbit rate coordinator requires a valid quota group.', 'UPBIT_RATE_COORDINATOR_INVALID_GROUP');
  }
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 16 || !QUOTA_GROUPS.has(normalized)) {
    throw coordinatorError('Upbit rate coordinator only accepts market, candle, ticker, and orderbook quota groups.', 'UPBIT_RATE_COORDINATOR_INVALID_GROUP');
  }
  return normalized;
}

export function normalizeScope(options = {}) {
  const scope = options.scope ?? options.rateLimitScope ?? 'ip';
  if (scope !== 'ip') {
    throw coordinatorError(
      `Upbit shared rate coordinator only accepts the public IP scope (received ${String(scope)}).`,
      'UPBIT_RATE_COORDINATOR_SCOPE_UNSUPPORTED'
    );
  }
  return scope;
}

export function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

export function hasOnlyOwnerPermissions(stat) {
  return (stat.mode & 0o077) === 0;
}

export function sameFile(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

export function syncDirectory(directory) {
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

export function releaseOwnedFile(filePath, owned, label) {
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

export function acquireExclusiveFile(filePath, { allowStaleRecovery = true, onRecoveryMarkerCreated } = {}) {
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

export function ensurePrivateDirectory(directory) {
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

export function allowTemporaryTestState(options = {}) {
  if (options.allowTemporaryStateDir !== true) return false;
  if (process.env.NODE_ENV === 'test' || envRaw('NODE_TEST_CONTEXT')) return true;
  throw coordinatorError('Temporary coordinator state roots are available only to tests.', 'UPBIT_RATE_COORDINATOR_TEMP_STATE_FORBIDDEN');
}

export function createServerClock(options = {}) {
  const usesTestClockOverrides = options.bootIdentity !== undefined || options.monotonicNow !== undefined;
  if (usesTestClockOverrides && process.env.NODE_ENV !== 'test' && !envRaw('NODE_TEST_CONTEXT')) {
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
  stateDir = envRaw('UPBIT_RATE_COORDINATOR_STATE_DIR') || envRaw('COINPILOT_STATE_DIR'),
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

export function sameBackoffMap(left = {}, right = {}) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function sameState(left, right) {
  return left.schema === right.schema && left.version === right.version &&
    left.bootIdentity === right.bootIdentity && left.nextDispatchAt === right.nextDispatchAt &&
    left.nextDispatchMonoNs === right.nextDispatchMonoNs &&
    left.manualRecoveryRequired === right.manualRecoveryRequired &&
    sameBackoffMap(left.backoffUntilByGroup, right.backoffUntilByGroup) &&
    sameBackoffMap(left.backoffMonoNsByGroup, right.backoffMonoNsByGroup);
}

export class PersistentCoordinatorState {
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

export function socketProbe(socketPath, timeoutMs = 250) {
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

export async function removeStaleSocketIfOwned(socketPath, directory) {
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

export function validateAcquireOptions(options = {}) {
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

export function errorFromWire(wire) {
  const error = coordinatorError(
    typeof wire?.message === 'string' ? wire.message : 'Shared Upbit rate coordinator rejected the request.',
    typeof wire?.code === 'string' ? wire.code : 'UPBIT_RATE_COORDINATOR_PROTOCOL'
  );
  if (error.code === 'UPBIT_REQUEST_ABORTED') error.name = 'AbortError';
  return error;
}

export function parseWireMessage(line) {
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

