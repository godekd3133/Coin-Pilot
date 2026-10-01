// Upbit 레이트 코디네이터 데몬 — upbitRateCoordinator.js에서 추출.
// 독점 파일 락 + 유닉스 소켓으로 프로세스 전역 속도 예산을 직렬화한다.
// 클라이언트/공유 계층과의 공개 경계는 파일 끝의 re-export가 유지한다.
import fs from 'node:fs';
import net from 'node:net';
import { envRaw } from '../config/envConfig.js';
import {
MAX_SOCKET_PATH_BYTES,
  MIN_REQUEST_INTERVAL_MS,
  MAX_COORDINATOR_DELAY_MS,
  MANUAL_BACKOFF_RECOVERY_CODE,
  LEGACY_STATE_RECOVERY_CODE,
  coordinatorError,
  numberAtLeastZero,
  monotonicNowNs,
  delayMsToNs,
  remainingMs,
  normalizeGroup,
  normalizeScope,
  currentUid,
  hasOnlyOwnerPermissions,
  sameFile,
  syncDirectory,
  releaseOwnedFile,
  acquireExclusiveFile,
  ensurePrivateDirectory,
  allowTemporaryTestState,
  createServerClock,
  resolveUpbitRateCoordinatorPaths,
  PersistentCoordinatorState,
  removeStaleSocketIfOwned,
  validateAcquireOptions,
  parseWireMessage
} from './upbitRateCoordinatorShared.js';

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
      (process.env.NODE_ENV !== 'test' && !envRaw('NODE_TEST_CONTEXT')))) {
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
export { UpbitRateCoordinatorClient } from './upbitRateCoordinatorClient.js';
export { resolveUpbitRateCoordinatorPaths } from './upbitRateCoordinatorShared.js';
