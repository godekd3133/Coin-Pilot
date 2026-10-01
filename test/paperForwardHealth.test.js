import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizePaperForwardHealth } from '../src/research/paperForwardHealth.js';
import { observeProcessExistence } from '../src/scripts/inspectPaperForwardHealth.js';

function activeLedger({ now, processId = 999_999_999, entryTime = new Date(now - 31 * 60_000).toISOString() } = {}) {
  const heartbeatAt = new Date(now - 60_000).toISOString();
  return {
    active: true,
    processId,
    heartbeatAt,
    telemetry: { heartbeatAt },
    configSnapshotComplete: true,
    configSnapshot: {
      strategyMode: 'oversold_reaction_scalping',
      checkInterval: 60_000,
      maxHoldMinutes: 30,
      winnerExtendMinutes: 0
    },
    strictOpenPositions: [{ coin: 'KRW-ETH', entryTime }]
  };
}

test('paper forward health reports an active missing owner and an unclosed hard max-hold deadline', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  const ledger = activeLedger({ now });
  const report = summarizePaperForwardHealth({
    ledger,
    now,
    processExistsObservation: { pid: ledger.processId, exists: false }
  });

  assert.equal(report.ledger.active, true);
  assert.equal(report.ownerProcess.status, 'missing');
  assert.equal(report.ownerProcess.exists, false);
  assert.equal(report.processIdentityVerified, false);
  assert.ok(report.findings.includes('active_owner_process_missing'));
  assert.equal(report.positions.length, 1);
  assert.equal(report.positions[0].baseDeadlineReached, true);
  assert.equal(report.positions[0].hardDeadlineReached, true);
  assert.equal(report.positions[0].deadlineStatus, 'hard_deadline_reached');
  assert.equal(report.positions[0].executionAsserted, false);
});

test('a live numeric PID is reported as existence only and never verifies paper-owner identity', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  const ledger = activeLedger({ now, processId: 4242 });
  ledger.strictOpenPositions = [];
  const report = summarizePaperForwardHealth({
    ledger,
    now,
    processExistsObservation: { pid: 4242, exists: true }
  });

  assert.equal(report.ownerProcess.exists, true);
  assert.equal(report.ownerProcess.status, 'exists_identity_unverified');
  assert.equal(report.processIdentityVerified, false);
  assert.match(report.processIdentityNote, /PID reuse/i);
  assert.equal(Object.hasOwn(report, 'healthy'), false);
});

test('PID observations with a missing or invalid ledger PID remain unknown', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  for (const processId of [undefined, null, 0, -2, 1.5, '4242']) {
    const ledger = activeLedger({ now, processId });
    ledger.strictOpenPositions = [];
    const report = summarizePaperForwardHealth({
      ledger,
      now,
      processExistsObservation: { pid: 4242, exists: true }
    });
    assert.equal(report.ownerProcess.exists, null, `processId=${String(processId)}`);
    assert.equal(report.ownerProcess.status, 'unknown', `processId=${String(processId)}`);
  }
});

test('paper forward health requires valid agreeing heartbeat sources and applies the configured limit boundary', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  const summarizeAtAge = ageMs => {
    const ledger = activeLedger({ now, processId: 4242 });
    ledger.strictOpenPositions = [];
    ledger.configSnapshot.checkInterval = 80_000;
    ledger.heartbeatAt = new Date(now - ageMs).toISOString();
    ledger.telemetry.heartbeatAt = ledger.heartbeatAt;
    return summarizePaperForwardHealth({ ledger, now, processExistsObservation: { pid: 4242, exists: true } });
  };

  assert.equal(summarizeAtAge(400_000).heartbeat.status, 'fresh');
  assert.equal(summarizeAtAge(400_001).heartbeat.status, 'stale');
  assert.equal(summarizeAtAge(400_001).heartbeat.limitMs, 400_000);
  assert.equal(summarizeAtAge(400_001).heartbeat.limitSource, 'config_snapshot_check_interval');

  const futureLedger = activeLedger({ now, processId: 4242 });
  futureLedger.strictOpenPositions = [];
  futureLedger.heartbeatAt = new Date(now + 1).toISOString();
  futureLedger.telemetry.heartbeatAt = futureLedger.heartbeatAt;
  const future = summarizePaperForwardHealth({ ledger: futureLedger, now });
  assert.equal(future.heartbeat.status, 'unknown');
  assert.equal(future.heartbeat.reason, 'heartbeat_in_future');

  const invalidLedger = activeLedger({ now, processId: 4242 });
  invalidLedger.strictOpenPositions = [];
  invalidLedger.heartbeatAt = 'not-a-time';
  invalidLedger.telemetry.heartbeatAt = 'not-a-time';
  const invalid = summarizePaperForwardHealth({ ledger: invalidLedger, now });
  assert.equal(invalid.heartbeat.status, 'unknown');
  assert.equal(invalid.heartbeat.reason, 'heartbeat_invalid');

  const disagreementLedger = activeLedger({ now, processId: 4242 });
  disagreementLedger.strictOpenPositions = [];
  disagreementLedger.heartbeatAt = new Date(now - 10_000).toISOString();
  disagreementLedger.telemetry.heartbeatAt = new Date(now - 20_000).toISOString();
  const disagreement = summarizePaperForwardHealth({ ledger: disagreementLedger, now });
  assert.equal(disagreement.heartbeat.status, 'unknown');
  assert.equal(disagreement.heartbeat.reason, 'heartbeat_sources_disagree');

  const missingLedger = activeLedger({ now, processId: 4242 });
  missingLedger.strictOpenPositions = [];
  delete missingLedger.telemetry.heartbeatAt;
  const missing = summarizePaperForwardHealth({ ledger: missingLedger, now });
  assert.equal(missing.heartbeat.status, 'unknown');
  assert.equal(missing.heartbeat.reason, 'heartbeat_missing_or_invalid');

  const documentedDefaultLedger = activeLedger({ now, processId: 4242 });
  documentedDefaultLedger.strictOpenPositions = [];
  delete documentedDefaultLedger.configSnapshot.checkInterval;
  const documentedDefault = summarizePaperForwardHealth({ ledger: documentedDefaultLedger, now });
  assert.equal(documentedDefault.heartbeat.limitMs, 300_000);
  assert.equal(documentedDefault.heartbeat.limitSource, 'documented_default_300000ms');
});

test('unrepresentable base or hard deadline dates stay unknown without throwing', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  const ledger = activeLedger({ now, processId: 4242 });
  ledger.configSnapshot.maxHoldMinutes = 1e20;
  ledger.configSnapshot.winnerExtendMinutes = 0;
  const baseOutsideDateRange = summarizePaperForwardHealth({ ledger, now });
  assert.equal(baseOutsideDateRange.positions[0].deadlineStatus, 'unknown');
  assert.equal(baseOutsideDateRange.positions[0].reason, 'deadline_unrepresentable');

  ledger.configSnapshot.maxHoldMinutes = 30;
  ledger.configSnapshot.winnerExtendMinutes = 1e20;
  const hardOutsideDateRange = summarizePaperForwardHealth({ ledger, now });
  assert.equal(hardOutsideDateRange.positions[0].deadlineStatus, 'unknown');
  assert.equal(hardOutsideDateRange.positions[0].reason, 'deadline_unrepresentable');

  const unrepresentableObservationTime = summarizePaperForwardHealth({ ledger, now: Number.MAX_VALUE });
  assert.equal(unrepresentableObservationTime.observedAt, null);
});

test('a reached base deadline within configured winner extension is not reported overdue', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  const ledger = activeLedger({ now, processId: 4242, entryTime: new Date(now - 35 * 60_000).toISOString() });
  ledger.configSnapshot.winnerExtendMinutes = 15;
  const report = summarizePaperForwardHealth({
    ledger,
    now,
    processExistsObservation: { pid: 4242, exists: true }
  });

  assert.equal(report.heartbeat.status, 'fresh');
  assert.equal(report.positions[0].baseDeadlineReached, true);
  assert.equal(report.positions[0].hardDeadlineReached, false);
  assert.equal(report.positions[0].deadlineStatus, 'base_deadline_reached_with_extension_remaining');
  assert.equal(report.findings.includes('unclosed_hard_max_hold_deadline_reached'), false);
  assert.equal(report.attentionRequired, false);
});

test('an explicitly invalid snapshot check interval makes heartbeat freshness unknown', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  for (const checkInterval of [0, -1, null, '60000', [], {}, Number.MAX_VALUE]) {
    const ledger = activeLedger({ now, processId: 4242 });
    ledger.strictOpenPositions = [];
    ledger.configSnapshot.checkInterval = checkInterval;
    const report = summarizePaperForwardHealth({ ledger, now });
    assert.equal(report.heartbeat.status, 'unknown', `checkInterval=${String(checkInterval)}`);
    assert.equal(report.heartbeat.reason, 'heartbeat_limit_invalid', `checkInterval=${String(checkInterval)}`);
    assert.equal(report.heartbeat.limitMs, null, `checkInterval=${String(checkInterval)}`);
  }
});

test('zero max-hold is explicitly disabled while missing or invalid extension config stays unknown', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  const ledger = activeLedger({ now, processId: 4242 });
  ledger.configSnapshot.maxHoldMinutes = 0;
  const disabled = summarizePaperForwardHealth({ ledger, now });
  assert.equal(disabled.positions[0].deadlineStatus, 'max_hold_disabled');
  assert.equal(disabled.positions[0].baseDeadlineAt, null);
  assert.equal(disabled.positions[0].hardDeadlineAt, null);
  assert.equal(disabled.positions[0].baseDeadlineReached, null);

  ledger.configSnapshot.maxHoldMinutes = 30;
  for (const winnerExtendMinutes of [undefined, -1, null, '15', []]) {
    if (winnerExtendMinutes === undefined) delete ledger.configSnapshot.winnerExtendMinutes;
    else ledger.configSnapshot.winnerExtendMinutes = winnerExtendMinutes;
    const report = summarizePaperForwardHealth({ ledger, now });
    assert.equal(report.positions[0].deadlineStatus, 'unknown');
    assert.equal(report.positions[0].reason, 'winner_extension_missing_or_invalid');
  }
});

test('future and ambiguous entry timestamps are unknown rather than eligible deadline times', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  for (const [entryTime, reason] of [
    [new Date(now + 1).toISOString(), 'entry_time_in_future'],
    ['0', 'entry_time_missing_or_invalid'],
    ['2026-02-30T10:00:00Z', 'entry_time_missing_or_invalid']
  ]) {
    const ledger = activeLedger({ now, processId: 4242, entryTime });
    const report = summarizePaperForwardHealth({ ledger, now });
    assert.equal(report.positions[0].deadlineStatus, 'unknown');
    assert.equal(report.positions[0].reason, reason);
  }
});

test('missing ledger active state stays null and requires attention', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  const ledger = activeLedger({ now, processId: 4242 });
  delete ledger.active;
  const report = summarizePaperForwardHealth({ ledger, now });
  assert.equal(report.ledger.active, null);
  assert.equal(report.ledger.activeState, 'unknown');
  assert.equal(report.findings.includes('ledger_activity_state_unknown'), true);
  assert.equal(report.attentionRequired, true);
});

test('inactive open strict positions are unsettled without an ever-growing overdue comparison', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  const ledger = activeLedger({ now, processId: 4242 });
  ledger.active = false;
  ledger.strictOpenPositions = { 'KRW-ETH': { entryTime: '2026-09-29T14:00:00.000Z' } };
  const report = summarizePaperForwardHealth({ ledger, now });
  assert.equal(report.positionCollectionStatus, 'available');
  assert.equal(report.positions[0].market, 'KRW-ETH');
  assert.equal(report.positions[0].deadlineStatus, 'unsettled_inactive');
  assert.equal(report.positions[0].baseDeadlineReached, null);
  assert.equal(report.positions[0].hardDeadlineReached, null);
  assert.equal(report.findings.includes('inactive_open_positions_unsettled'), true);
  assert.equal(report.findings.includes('unclosed_hard_max_hold_deadline_reached'), false);
});

test('deadline assessment stays unknown for unsupported strategy, incomplete config, or malformed position evidence', () => {
  const now = Date.parse('2026-09-29T16:30:00.000Z');
  const ledger = activeLedger({ now, processId: 4242 });
  ledger.configSnapshot.strategyMode = 'another_strategy';
  assert.equal(summarizePaperForwardHealth({ ledger, now }).positions[0].reason, 'unsupported_strategy_mode');

  ledger.configSnapshot.strategyMode = 'oversold_reaction_scalping';
  ledger.configSnapshotComplete = false;
  assert.equal(summarizePaperForwardHealth({ ledger, now }).positions[0].reason, 'config_snapshot_incomplete');
  ledger.configSnapshotComplete = true;

  for (const maxHoldMinutes of [undefined, -1, null, '30']) {
    if (maxHoldMinutes === undefined) delete ledger.configSnapshot.maxHoldMinutes;
    else ledger.configSnapshot.maxHoldMinutes = maxHoldMinutes;
    assert.equal(summarizePaperForwardHealth({ ledger, now }).positions[0].deadlineStatus, 'unknown');
  }

  ledger.configSnapshot.maxHoldMinutes = 30;
  ledger.strictOpenPositions[0].entryTime = undefined;
  assert.equal(summarizePaperForwardHealth({ ledger, now }).positions[0].reason, 'entry_time_missing_or_invalid');
  ledger.strictOpenPositions = [null];
  const malformedRow = summarizePaperForwardHealth({ ledger, now });
  assert.equal(malformedRow.positions[0].reason, 'malformed_position');
  assert.equal(malformedRow.findings.includes('strict_open_position_malformed'), true);
  ledger.strictOpenPositions = 'not-a-position-container';
  assert.equal(summarizePaperForwardHealth({ ledger, now }).positionCollectionStatus, 'malformed');
});

test('signal-zero PID probing maps ESRCH and EPERM correctly and leaves other errors unknown', () => {
  const failWith = code => Object.assign(new Error(code), { code });
  assert.deepEqual(observeProcessExistence(1234, () => { throw failWith('ESRCH'); }), {
    pid: 1234,
    exists: false,
    observation: 'process_missing'
  });
  assert.deepEqual(observeProcessExistence(1234, () => { throw failWith('EPERM'); }), {
    pid: 1234,
    exists: true,
    observation: 'exists_permission_denied'
  });
  assert.equal(observeProcessExistence(1234, () => { throw failWith('EIO'); }).exists, null);
  assert.equal(observeProcessExistence('1234', () => assert.fail('invalid PID must not be probed')).exists, null);
  assert.equal(observeProcessExistence(process.pid).exists, true);
});

test('explicit-path CLI emits JSON and leaves its ledger and lock fixtures unchanged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-forward-health-cli-'));
  const ledgerPath = path.join(root, 'paper_validation.json');
  const lockPath = path.join(root, '.paper-session.lock');
  const cliPath = fileURLToPath(new URL('../src/scripts/inspectPaperForwardHealth.js', import.meta.url));
  try {
    const now = Date.now();
    const heartbeatAt = new Date(now - 1000).toISOString();
    const ledger = {
      sessionId: 'health-fixture-session',
      active: true,
      processId: process.pid,
      heartbeatAt,
      telemetry: { heartbeatAt },
      configSnapshotComplete: true,
      configSnapshot: { strategyMode: 'oversold_reaction_scalping', checkInterval: 60_000 },
      strictOpenPositions: []
    };
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger));
    fs.writeFileSync(lockPath, JSON.stringify({ fixture: 'preserve-me', nonce: 'unit-test-only' }));
    const hash = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    const ledgerHashBefore = hash(ledgerPath);
    const lockHashBefore = hash(lockPath);

    const stdout = execFileSync(process.execPath, [cliPath, ledgerPath], { encoding: 'utf8' });
    const report = JSON.parse(stdout);
    assert.equal(stdout.trim().startsWith('{'), true);
    assert.equal(report.source.ledgerPath, ledgerPath);
    assert.equal(report.source.sessionId, ledger.sessionId);
    assert.equal(report.ownerProcess.status, 'exists_identity_unverified');
    assert.equal(report.processIdentityVerified, false);
    assert.match(report.scope, /diagnostic and shadow books are not covered/i);
    assert.equal(hash(ledgerPath), ledgerHashBefore);
    assert.equal(hash(lockPath), lockHashBefore);

    const noPath = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
    assert.equal(noPath.status, 1);
    assert.equal(JSON.parse(noPath.stdout).error.code, 'ledger_path_required');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
