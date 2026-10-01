// Upbit 레이트 코디네이터 클라이언트 — upbitRateCoordinator.js에서 추출.
// 프로세스 내 호출자를 데몬 소켓에 연결한다; 상태·락·wire 프로토콜은 공유 계층 소유.
import net from 'node:net';
import {
MAX_SOCKET_PATH_BYTES,
  coordinatorError,
  numberAtLeastZero,
  monotonicNowNs,
  delayMsToNs,
  normalizeGroup,
  normalizeScope,
  errorFromWire,
  parseWireMessage,
  validateAcquireOptions
} from './upbitRateCoordinatorShared.js';

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
