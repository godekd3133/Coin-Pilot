import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightStrictOnlyForward } from '../src/scripts/preflightStrictOnlyForward.js';

function writeLedger(root, name, ledger) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'paper_validation.json'), JSON.stringify(ledger));
}

test('strict-only preflight는 살아 있는 다른 paper owner를 read-only로 차단한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-strict-only-preflight-'));
  try {
    writeLedger(root, '.paper-forward-active', {
      active: true,
      processId: process.pid,
      sessionId: 'paper-active',
      startedAt: new Date().toISOString()
    });
    const result = preflightStrictOnlyForward({
      workspaceRoot: root,
      outputDir: '.paper-forward-strict-only'
    });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.some(blocker => blocker.code === 'paper_owner_active'));
    assert.equal(fs.existsSync(path.join(root, '.paper-forward-strict-only')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict-only preflight는 비어 있는 새 output directory에서만 ready를 반환한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-strict-only-preflight-ready-'));
  try {
    const result = preflightStrictOnlyForward({
      workspaceRoot: root,
      outputDir: '.paper-forward-strict-only'
    });
    assert.equal(result.ready, true);
    assert.deepEqual(result.blockers, []);
    assert.equal(fs.existsSync(path.join(root, '.paper-forward-strict-only')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict-only preflight는 diagnostic ledger 재사용을 거부한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-strict-only-preflight-reuse-'));
  try {
    writeLedger(root, '.paper-forward-strict-only', {
      active: false,
      endedAt: new Date().toISOString(),
      stopReason: 'stopped_cleanly',
      paperExperiments: { diagnosticShadows: { enabled: true } },
      shadow: { closedTrades: [{ netProfit: 1 }], positions: {} },
      looseShadow: { closedTrades: [], positions: {} }
    });
    const result = preflightStrictOnlyForward({
      workspaceRoot: root,
      outputDir: '.paper-forward-strict-only'
    });
    assert.equal(result.ready, false);
    assert.ok(result.blockers.some(blocker => blocker.code === 'ledger_not_strict_only'));
    assert.ok(result.blockers.some(blocker => blocker.code === 'target_ledger_already_used'));
    assert.ok(result.blockers.some(blocker => blocker.code === 'diagnostic_state_present'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
