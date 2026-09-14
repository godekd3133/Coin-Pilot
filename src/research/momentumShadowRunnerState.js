const RUNNER_EVENT_LIMIT = 24;

function iso(value) {
  return new Date(value || Date.now()).toISOString();
}

function errorSummary(error) {
  if (!error) return null;
  if (typeof error === 'string') return { name: 'Error', message: error };
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
  };
}

function appendEvent(ledger, event) {
  ledger.runnerEvents = [...(Array.isArray(ledger.runnerEvents) ? ledger.runnerEvents : []), event]
    .slice(-RUNNER_EVENT_LIMIT);
}

/**
 * Mark a research-only momentum runner as active and preserve evidence when a
 * stale lock had to be recovered. A stale lock means the previous process
 * did not record a graceful stop; it must not be presented as clean.
 */
export function recordMomentumShadowRunnerStart(ledger, { pid, at, staleRecovery = null } = {}) {
  if (!ledger || typeof ledger !== 'object') return null;
  const startedAt = iso(at);

  if (staleRecovery) {
    appendEvent(ledger, {
      type: 'stale_lock_recovered',
      at: startedAt,
      reason: 'abrupt_or_external_termination',
      previousPid: staleRecovery.pid ?? null,
      previousStartedAt: staleRecovery.startedAt ?? null,
      previousHeartbeatAt: ledger.heartbeatAt ?? null,
    });
  }

  ledger.runnerState = 'running';
  ledger.runnerPid = pid ?? null;
  ledger.runnerStartedAt = startedAt;
  ledger.runnerLastHeartbeatAt = startedAt;
  ledger.runnerStoppedAt = null;
  ledger.runnerStopReason = null;
  ledger.runnerLastError = null;
  appendEvent(ledger, { type: 'started', at: startedAt, pid: pid ?? null });
  return ledger;
}

/**
 * Persist a terminal runner state before releasing the scoped lock. This is
 * synchronous by design because it is called from signal/fatal boundaries.
 */
export function recordMomentumShadowRunnerStop(ledger, { pid, at, reason = 'stopped_cleanly', error = null } = {}) {
  if (!ledger || typeof ledger !== 'object') return null;
  const stoppedAt = iso(at);
  const summary = errorSummary(error);
  ledger.runnerState = 'stopped';
  ledger.runnerPid = pid ?? ledger.runnerPid ?? null;
  ledger.runnerStoppedAt = stoppedAt;
  ledger.runnerStopReason = reason;
  ledger.runnerLastEventAt = stoppedAt;
  ledger.runnerLastError = summary;
  appendEvent(ledger, {
    type: 'stopped',
    at: stoppedAt,
    pid: pid ?? ledger.runnerPid ?? null,
    reason,
    error: summary,
  });
  return ledger;
}
