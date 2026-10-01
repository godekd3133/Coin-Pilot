const DEFAULT_HEARTBEAT_LIMIT_MS = 300_000;
const MIN_HEARTBEAT_LIMIT_MS = 120_000;

function validPid(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isoTimestampOrNull(value) {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/i);
  if (!match) return null;
  const [, yearPart, monthPart, dayPart, hourPart, minutePart, secondPart, zone, , offsetHourPart, offsetMinutePart] = match;
  const year = Number(yearPart);
  const month = Number(monthPart);
  const day = Number(dayPart);
  const hour = Number(hourPart);
  const minute = Number(minutePart);
  const second = Number(secondPart);
  const daysInMonth = month === 2
    ? ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  if (zone.toUpperCase() !== 'Z' && (Number(offsetHourPart) > 23 || Number(offsetMinutePart) > 59)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function heartbeatValue(value, present, nowMs) {
  if (!present) return { status: 'missing', value: null, ageMs: null };
  const timestamp = parseIsoTimestamp(value);
  if (timestamp === null) return { status: 'invalid', value, ageMs: null };
  if (!Number.isFinite(nowMs)) return { status: 'unknown_now', value, ageMs: null };
  if (timestamp > nowMs) return { status: 'future', value, ageMs: null };
  return { status: 'valid', value, ageMs: nowMs - timestamp, timestamp };
}

function heartbeatLimit(ledger) {
  const snapshot = ledger?.configSnapshot;
  const hasCheckInterval = snapshot && typeof snapshot === 'object' && Object.hasOwn(snapshot, 'checkInterval');
  const checkInterval = snapshot?.checkInterval;
  if (hasCheckInterval && typeof checkInterval === 'number' && Number.isFinite(checkInterval) && checkInterval > 0) {
    const derived = Math.max(MIN_HEARTBEAT_LIMIT_MS, checkInterval * 5);
    if (Number.isFinite(derived)) {
      return { limitMs: derived, source: 'config_snapshot_check_interval', checkInterval };
    }
    return { limitMs: null, source: 'invalid_config_snapshot_check_interval', checkInterval: null };
  }
  if (hasCheckInterval) return { limitMs: null, source: 'invalid_config_snapshot_check_interval', checkInterval: null };
  return { limitMs: DEFAULT_HEARTBEAT_LIMIT_MS, source: 'documented_default_300000ms', checkInterval: null };
}

function summarizeHeartbeats(ledger, nowMs) {
  const topPresent = Object.hasOwn(ledger || {}, 'heartbeatAt');
  const telemetryPresent = Object.hasOwn(ledger?.telemetry || {}, 'heartbeatAt');
  const topLevel = heartbeatValue(ledger?.heartbeatAt, topPresent, nowMs);
  const telemetry = heartbeatValue(ledger?.telemetry?.heartbeatAt, telemetryPresent, nowMs);
  const limit = heartbeatLimit(ledger);
  let status = 'unknown';
  let reason = 'heartbeat_missing_or_invalid';
  let ageMs = null;

  if (limit.limitMs === null) {
    status = 'unknown';
    reason = 'heartbeat_limit_invalid';
  } else if (topLevel.status === 'future' || telemetry.status === 'future') {
    status = 'unknown';
    reason = 'heartbeat_in_future';
  } else if (topLevel.status === 'invalid' || telemetry.status === 'invalid') {
    status = 'unknown';
    reason = 'heartbeat_invalid';
  } else if (topLevel.status === 'unknown_now' || telemetry.status === 'unknown_now') {
    status = 'unknown';
    reason = 'observation_time_invalid';
  } else if (topLevel.status === 'valid' && telemetry.status === 'valid') {
    if (topLevel.timestamp !== telemetry.timestamp) {
      status = 'unknown';
      reason = 'heartbeat_sources_disagree';
    } else {
      ageMs = topLevel.ageMs;
      status = ageMs > limit.limitMs ? 'stale' : 'fresh';
      reason = status === 'stale' ? 'heartbeat_stale' : null;
    }
  }

  return {
    status,
    reason,
    ageMs,
    limitMs: limit.limitMs,
    limitSource: limit.source,
    topLevel,
    telemetry
  };
}

function positionRows(ledger) {
  const positions = ledger?.strictOpenPositions;
  if (Array.isArray(positions)) {
    return {
      status: 'available',
      rows: positions.map((position, index) => ({
        market: typeof position?.coin === 'string' && position.coin ? position.coin : null,
        position,
        index
      }))
    };
  }
  if (positions && typeof positions === 'object') {
    return {
      status: 'available',
      rows: Object.entries(positions).map(([market, position]) => ({ market, position }))
    };
  }
  return { status: positions === undefined || positions === null ? 'missing' : 'malformed', rows: [] };
}

function summarizePosition(row, ledger, activeState, nowMs) {
  const base = {
    market: row.market,
    entryTime: typeof row.position?.entryTime === 'string' ? row.position.entryTime : null,
    deadlineStatus: 'unknown',
    baseDeadlineAt: null,
    hardDeadlineAt: null,
    baseDeadlineReached: null,
    hardDeadlineReached: null,
    executionAsserted: false
  };
  if (!row.position || typeof row.position !== 'object' || Array.isArray(row.position) || !row.market) {
    return { ...base, reason: 'malformed_position' };
  }

  const snapshot = ledger?.configSnapshot;
  if (ledger?.configSnapshotComplete !== true || !snapshot || typeof snapshot !== 'object') {
    return { ...base, reason: 'config_snapshot_incomplete' };
  }
  if (snapshot.strategyMode !== 'oversold_reaction_scalping') {
    return { ...base, reason: 'unsupported_strategy_mode' };
  }
  if (typeof snapshot.maxHoldMinutes !== 'number' || !Number.isFinite(snapshot.maxHoldMinutes) || snapshot.maxHoldMinutes < 0) {
    return { ...base, reason: 'max_hold_minutes_missing_or_invalid' };
  }
  if (snapshot.maxHoldMinutes === 0) return { ...base, deadlineStatus: 'max_hold_disabled' };
  if (typeof snapshot.winnerExtendMinutes !== 'number' || !Number.isFinite(snapshot.winnerExtendMinutes) || snapshot.winnerExtendMinutes < 0) {
    return { ...base, reason: 'winner_extension_missing_or_invalid' };
  }
  const entryMs = parseIsoTimestamp(base.entryTime);
  if (entryMs === null) return { ...base, reason: 'entry_time_missing_or_invalid' };
  if (Number.isFinite(nowMs) && entryMs > nowMs) return { ...base, reason: 'entry_time_in_future' };

  const baseMs = entryMs + snapshot.maxHoldMinutes * 60_000;
  const hardMs = entryMs + (snapshot.maxHoldMinutes + snapshot.winnerExtendMinutes) * 60_000;
  const baseDate = new Date(baseMs);
  const hardDate = new Date(hardMs);
  if (!Number.isFinite(baseMs) || !Number.isFinite(hardMs) ||
    !Number.isFinite(baseDate.getTime()) || !Number.isFinite(hardDate.getTime())) {
    return { ...base, reason: 'deadline_unrepresentable' };
  }
  const baseDeadlineAt = baseDate.toISOString();
  const hardDeadlineAt = hardDate.toISOString();
  if (activeState === 'inactive') {
    return { ...base, baseDeadlineAt, hardDeadlineAt, deadlineStatus: 'unsettled_inactive' };
  }
  if (activeState !== 'active' || !Number.isFinite(nowMs)) {
    return { ...base, baseDeadlineAt, hardDeadlineAt, deadlineStatus: 'observation_state_unknown' };
  }

  const baseDeadlineReached = nowMs >= baseMs;
  const hardDeadlineReached = nowMs >= hardMs;
  const deadlineStatus = hardDeadlineReached
    ? 'hard_deadline_reached'
    : baseDeadlineReached
      ? 'base_deadline_reached_with_extension_remaining'
      : 'before_base_deadline';
  return { ...base, baseDeadlineAt, hardDeadlineAt, baseDeadlineReached, hardDeadlineReached, deadlineStatus };
}

/**
 * Summarize persisted paper-forward owner and max-hold health without reading
 * the filesystem, probing PIDs, or changing a ledger. PID existence is an
 * injected observation only and never verifies process identity.
 */
export function summarizePaperForwardHealth({ ledger, now = Date.now(), processExistsObservation = null } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const activeState = ledger?.active === true ? 'active' : ledger?.active === false ? 'inactive' : 'unknown';
  const pid = validPid(ledger?.processId) ? ledger.processId : null;
  const observationMatchesPid = pid !== null && processExistsObservation?.pid === pid;
  const exists = observationMatchesPid && [true, false].includes(processExistsObservation.exists)
    ? processExistsObservation.exists
    : null;
  const ownerProcessStatus = exists === false
    ? 'missing'
    : exists === true
      ? 'exists_identity_unverified'
      : 'unknown';
  const heartbeat = summarizeHeartbeats(ledger, nowMs);
  const positionCollection = positionRows(ledger);
  const positions = positionCollection.rows.map(row => summarizePosition(row, ledger, activeState, nowMs));
  const findings = [];

  if (positionCollection.status !== 'available') findings.push('strict_open_positions_unavailable');
  if (positions.some(position => position.reason === 'malformed_position')) findings.push('strict_open_position_malformed');
  if (activeState === 'unknown') findings.push('ledger_activity_state_unknown');
  if (activeState === 'active' && ownerProcessStatus === 'missing') findings.push('active_owner_process_missing');
  if (activeState === 'active' && ownerProcessStatus === 'unknown') findings.push('active_owner_process_unknown');
  if (activeState === 'active' && heartbeat.status === 'stale') findings.push('active_heartbeat_stale');
  if (activeState === 'active' && heartbeat.status === 'unknown') findings.push(heartbeat.reason || 'active_heartbeat_unknown');
  if (activeState === 'inactive' && positions.length > 0) findings.push('inactive_open_positions_unsettled');
  if (positions.some(position => position.deadlineStatus === 'max_hold_disabled')) findings.push('position_max_hold_disabled');
  if (positions.some(position => position.hardDeadlineReached === true)) findings.push('unclosed_hard_max_hold_deadline_reached');
  for (const position of positions) {
    if (position.reason && position.reason !== 'malformed_position') findings.push(`position_deadline_unknown:${position.market || position.index || 'unknown'}:${position.reason}`);
  }

  return {
    reportType: 'paper_forward_owner_and_strict_hold',
    scope: 'Persisted ledger owner existence/heartbeat and strict-position max-hold deadlines only; diagnostic and shadow books are not covered.',
    researchOnly: true,
    promoted: false,
    observedAt: isoTimestampOrNull(nowMs),
    ledger: {
      active: ledger?.active === true ? true : ledger?.active === false ? false : null,
      sessionId: typeof ledger?.sessionId === 'string' ? ledger.sessionId : null,
      activeState,
      processId: pid,
      heartbeatAt: ledger?.heartbeatAt ?? null,
      telemetryHeartbeatAt: ledger?.telemetry?.heartbeatAt ?? null
    },
    ownerProcess: { pid, exists, status: ownerProcessStatus },
    processIdentityVerified: false,
    processIdentityNote: 'signal 0 reports only whether a PID currently exists; it does not verify that the process is the recorded paper owner and PID reuse is possible.',
    heartbeat,
    positionCollectionStatus: positionCollection.status,
    positions,
    findings: [...new Set(findings)],
    attentionRequired: findings.length > 0,
    deadlineInterpretation: 'Deadline checks compare configured timestamps only. They do not assert a price trigger, order, fill, close, or trade execution.'
  };
}
