function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonnegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function createSchedulerError(message, code, priority) {
  const error = new Error(message);
  error.code = code;
  error.priority = priority;
  return error;
}

function createAbortError(priority) {
  const error = createSchedulerError(
    'Upbit request was aborted before dispatch',
    'UPBIT_REQUEST_ABORTED',
    priority
  );
  error.name = 'AbortError';
  return error;
}

/**
 * Process-local admission control for Upbit HTTP work.
 *
 * The scheduler owns both dispatch spacing and the full lifetime of each
 * request permit. Callers must provide a callback that starts the HTTP request
 * synchronously when invoked and returns its promise.
 */
export class UpbitRequestScheduler {
  constructor(options = {}) {
    this.maxInFlight = positiveInteger(options.maxInFlight, 4);
    const configuredRiskReserveSlots = Number(options.riskReserveSlots);
    const requestedRiskReserveSlots = Number.isSafeInteger(configuredRiskReserveSlots) &&
      configuredRiskReserveSlots >= 0
      ? configuredRiskReserveSlots
      : 1;
    const maxRiskReserveSlots = Math.max(0, this.maxInFlight - 1);
    this.riskReserveSlots = Math.min(
      maxRiskReserveSlots,
      requestedRiskReserveSlots
    );
    this.maxNormalInFlight = this.maxInFlight - this.riskReserveSlots;
    this.maxQueuedNormal = nonnegativeNumber(options.maxQueuedNormal, 64);
    this.maxQueuedRisk = nonnegativeNumber(options.maxQueuedRisk, 16);
    this.normalQueueTimeoutMs = nonnegativeNumber(options.normalQueueTimeoutMs, 10_000);
    this.riskQueueTimeoutMs = nonnegativeNumber(options.riskQueueTimeoutMs, 30_000);
    this.defaultMinRequestIntervalMs = Math.max(
      120,
      nonnegativeNumber(options.minRequestIntervalMs, 120)
    );
    this.now = options.now || (() => Date.now());
    this.setTimer = options.setTimeout || ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimeout || (timer => clearTimeout(timer));

    this.queue = [];
    this.inFlight = new Set();
    this.sequence = 0;
    this.nextRequestAt = 0;
    this.backoffs = new Map();
    this.pumpTimer = null;
    this.pumpTimerAt = null;
  }

  schedule(run, options = {}) {
    if (typeof run !== 'function') {
      return Promise.reject(new TypeError('Upbit scheduler requires a request function'));
    }

    const priority = options.priority === 'risk' ? 'risk' : 'normal';
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(createAbortError(priority));

    const queuedForPriority = this.queue.reduce(
      (count, request) => count + (request.priority === priority ? 1 : 0),
      0
    );
    const queueLimit = priority === 'risk' ? this.maxQueuedRisk : this.maxQueuedNormal;
    if (queuedForPriority >= queueLimit) {
      return Promise.reject(createSchedulerError(
        `Upbit ${priority} request queue is full (${queueLimit})`,
        'UPBIT_QUEUE_FULL',
        priority
      ));
    }

    const queueWaitTimeoutMs = nonnegativeNumber(
      options.queueWaitTimeoutMs,
      priority === 'risk' ? this.riskQueueTimeoutMs : this.normalQueueTimeoutMs
    );

    return new Promise((resolve, reject) => {
      const addedAt = this.now();
      const requestedDeadlineAt = Number(options.deadlineAt);
      const hasAbsoluteDeadline = options.deadlineAt !== undefined &&
        options.deadlineAt !== null && Number.isFinite(requestedDeadlineAt);
      const deadlineAt = hasAbsoluteDeadline
        ? Math.min(addedAt + queueWaitTimeoutMs, requestedDeadlineAt)
        : addedAt + queueWaitTimeoutMs;
      const boundedQueueWaitMs = Math.max(0, deadlineAt - addedAt);
      const request = {
        run,
        priority,
        signal,
        rateLimitGroup: options.rateLimitGroup || 'all',
        rateLimitScope: options.rateLimitScope || 'process',
        resolve,
        reject,
        addedAt,
        deadlineAt,
        priorityOrder: Number.isFinite(Number(options.priorityOrder))
          ? Number(options.priorityOrder)
          : 0,
        minRequestIntervalMs: Math.max(
          this.defaultMinRequestIntervalMs,
          nonnegativeNumber(options.minRequestIntervalMs, this.defaultMinRequestIntervalMs)
        ),
        sequence: this.sequence++,
        state: 'queued',
        queueTimer: null,
        abortHandler: null
      };

      request.queueTimer = this.setTimer(() => {
        if (request.state !== 'queued') return;
        this._rejectQueued(request, createSchedulerError(
          `Upbit ${priority} request exceeded its ${boundedQueueWaitMs}ms queue deadline`,
          'UPBIT_QUEUE_TIMEOUT',
          priority
        ));
        this._pump();
      }, boundedQueueWaitMs);

      if (signal) {
        request.abortHandler = () => {
          if (request.state !== 'queued') return;
          this._rejectQueued(request, createAbortError(priority));
          this._pump();
        };
        signal.addEventListener('abort', request.abortHandler, { once: true });
      }

      this.queue.push(request);
      this._pump();
    });
  }

  applyBackoff(delayMs, options = {}) {
    const delay = nonnegativeNumber(delayMs, 0);
    const scope = options.rateLimitScope || 'process';
    const group = options.rateLimitGroup || 'all';
    const key = options.rateLimitScopeWide === true ? `${scope}:*` : `${scope}:${group}`;
    const nextBackoffUntil = Math.max(this.backoffs.get(key) || 0, this.now() + delay);
    this.backoffs.set(key, nextBackoffUntil);
    this._pump();
    return nextBackoffUntil;
  }

  getStatus() {
    const now = this.now();
    const queued = { normal: 0, risk: 0 };
    const oldestWaitAgeMs = { normal: null, risk: null };
    const inFlight = { normal: 0, risk: 0 };

    for (const request of this.queue) {
      queued[request.priority] += 1;
      const ageMs = Math.max(0, now - request.addedAt);
      if (oldestWaitAgeMs[request.priority] === null || ageMs > oldestWaitAgeMs[request.priority]) {
        oldestWaitAgeMs[request.priority] = ageMs;
      }
    }

    for (const request of this.inFlight) inFlight[request.priority] += 1;

    const backoffRemainingMsByScopeAndGroup = {};
    for (const [key, until] of this.backoffs) {
      const remainingMs = Math.max(0, until - now);
      if (remainingMs > 0) backoffRemainingMsByScopeAndGroup[key] = remainingMs;
    }

    return {
      queued,
      queuedTotal: queued.normal + queued.risk,
      inFlight,
      inFlightTotal: inFlight.normal + inFlight.risk,
      oldestWaitAgeMs,
      nextStartInMs: Math.max(0, this.nextRequestAt - now),
      backoffRemainingMs: Object.values(backoffRemainingMsByScopeAndGroup)
        .reduce((maximum, remainingMs) => Math.max(maximum, remainingMs), 0),
      backoffRemainingMsByScopeAndGroup,
      maxInFlight: this.maxInFlight,
      maxInFlightByPriority: {
        normal: this.maxNormalInFlight,
        risk: this.maxInFlight
      },
      maxQueuedByPriority: {
        normal: this.maxQueuedNormal,
        risk: this.maxQueuedRisk
      }
    };
  }

  _cleanupQueuedRequest(request) {
    if (request.queueTimer !== null) {
      this.clearTimer(request.queueTimer);
      request.queueTimer = null;
    }
    if (request.signal && request.abortHandler) {
      request.signal.removeEventListener('abort', request.abortHandler);
      request.abortHandler = null;
    }
  }

  _rejectQueued(request, error) {
    if (request.state !== 'queued') return;
    request.state = 'settled';
    this._cleanupQueuedRequest(request);
    const index = this.queue.indexOf(request);
    if (index >= 0) this.queue.splice(index, 1);
    request.reject(error);
  }

  _expireQueuedRequests() {
    const now = this.now();
    for (const request of [...this.queue]) {
      if (request.signal?.aborted) {
        this._rejectQueued(request, createAbortError(request.priority));
      } else if (now >= request.deadlineAt) {
        this._rejectQueued(request, createSchedulerError(
          `Upbit ${request.priority} request exceeded its queue deadline`,
          'UPBIT_QUEUE_TIMEOUT',
          request.priority
        ));
      }
    }
  }

  _canDispatch(priority) {
    if (this.inFlight.size >= this.maxInFlight) return false;
    if (priority === 'risk') return true;
    const normalInFlight = [...this.inFlight]
      .reduce((count, request) => count + (request.priority === 'normal' ? 1 : 0), 0);
    return normalInFlight < this.maxNormalInFlight;
  }

  _backoffUntilFor(request) {
    const groupBackoffUntil = this.backoffs.get(`${request.rateLimitScope}:${request.rateLimitGroup}`) || 0;
    const scopeBackoffUntil = this.backoffs.get(`${request.rateLimitScope}:*`) || 0;
    return Math.max(groupBackoffUntil, scopeBackoffUntil);
  }

  _nextDispatchCandidate(now) {
    const candidates = this.queue
      .filter(request => this._canDispatch(request.priority))
      .sort((a, b) => {
        if (a.priority !== b.priority) return a.priority === 'risk' ? -1 : 1;
        if (a.priorityOrder !== b.priorityOrder) return a.priorityOrder - b.priorityOrder;
        return a.sequence - b.sequence;
      });
    const request = candidates.find(candidate => this._backoffUntilFor(candidate) <= now);
    if (request) return { request, wakeAt: null };
    if (candidates.length === 0) return { request: null, wakeAt: null };
    return {
      request: null,
      wakeAt: Math.min(...candidates.map(candidate => this._backoffUntilFor(candidate)))
    };
  }

  _clearPumpTimer() {
    if (this.pumpTimer === null) return;
    this.clearTimer(this.pumpTimer);
    this.pumpTimer = null;
    this.pumpTimerAt = null;
  }

  _schedulePumpAt(targetAt) {
    if (this.pumpTimer !== null && this.pumpTimerAt <= targetAt) return;
    this._clearPumpTimer();
    this.pumpTimerAt = targetAt;
    this.pumpTimer = this.setTimer(() => {
      this.pumpTimer = null;
      this.pumpTimerAt = null;
      this._pump();
    }, Math.min(2_147_483_647, Math.max(0, targetAt - this.now())));
  }

  _pump() {
    this._expireQueuedRequests();

    while (this.queue.length > 0) {
      const now = this.now();
      const candidate = this._nextDispatchCandidate(now);
      const request = candidate.request;
      if (!request) {
        if (candidate.wakeAt !== null) {
          this._schedulePumpAt(Math.max(this.nextRequestAt, candidate.wakeAt));
        } else {
          this._clearPumpTimer();
        }
        return;
      }

      const dispatchAt = Math.max(this.nextRequestAt, this._backoffUntilFor(request));
      if (dispatchAt > now) {
        this._schedulePumpAt(dispatchAt);
        return;
      }

      if (request.signal?.aborted) {
        this._rejectQueued(request, createAbortError(request.priority));
        continue;
      }
      if (now >= request.deadlineAt) {
        this._rejectQueued(request, createSchedulerError(
          `Upbit ${request.priority} request exceeded its queue deadline`,
          'UPBIT_QUEUE_TIMEOUT',
          request.priority
        ));
        continue;
      }

      this._clearPumpTimer();
      const queueIndex = this.queue.indexOf(request);
      if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
      this._cleanupQueuedRequest(request);
      request.state = 'inFlight';
      this.inFlight.add(request);
      this.nextRequestAt = now + request.minRequestIntervalMs;

      try {
        const result = request.run(now);
        Promise.resolve(result)
          .then(request.resolve, request.reject)
          .finally(() => {
            request.state = 'settled';
            this.inFlight.delete(request);
            this._pump();
          });
      } catch (error) {
        request.reject(error);
        request.state = 'settled';
        this.inFlight.delete(request);
      }
    }

    this._clearPumpTimer();
  }
}

export const sharedUpbitRequestScheduler = new UpbitRequestScheduler();
