import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acquirePaperSessionLock,
  assertNoConcurrentPaperSessions,
  findConcurrentPaperSessions
} from '../src/research/paperSessionConcurrency.js';

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-concurrency-'));
}

function writeLedger(workspace, directory, values = {}) {
  const outputDir = path.join(workspace, directory);
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, 'paper_validation.json');
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 4,
    active: false,
    processId: 999_999_999,
    sessionId: `${directory}-session`,
    ...values
  }), 'utf8');
  return file;
}

test('살아 있는 다른 paper owner가 있으면 새 session을 fail-closed 한다', () => {
  const workspace = makeWorkspace();
  const currentFile = writeLedger(workspace, '.paper-smoke-current', {
    active: true,
    processId: process.pid
  });
  const otherFile = writeLedger(workspace, '.paper-forward-v59', {
    active: true,
    processId: process.pid
  });

  const sessions = findConcurrentPaperSessions({
    workspaceRoot: workspace,
    currentLedgerFile: currentFile
  });
  assert.deepEqual(sessions.map(session => session.ledgerFile), [otherFile]);
  assert.throws(
    () => assertNoConcurrentPaperSessions({
      workspaceRoot: workspace,
      currentLedgerFile: currentFile
    }),
    error => error.code === 'PAPER_CONCURRENT_SESSION' && error.sessions.length === 1
  );
});

test('같은 ledger 재개는 허용하고 orphan/inactive ledger는 새 session을 막지 않는다', () => {
  const workspace = makeWorkspace();
  const currentFile = writeLedger(workspace, '.paper-forward-current', {
    active: true,
    processId: process.pid
  });
  writeLedger(workspace, '.paper-forward-orphan', {
    active: true,
    processId: 999_999_999
  });
  writeLedger(workspace, '.paper-smoke-stopped', {
    active: false,
    processId: process.pid
  });

  assert.deepEqual(findConcurrentPaperSessions({
    workspaceRoot: workspace,
    currentLedgerFile: currentFile
  }), []);
  assert.doesNotThrow(() => assertNoConcurrentPaperSessions({
    workspaceRoot: workspace,
    currentLedgerFile: currentFile
  }));
});

test('동시 실행 override가 명시되면 guard는 진단용 예외를 허용한다', () => {
  const workspace = makeWorkspace();
  const currentFile = writeLedger(workspace, '.paper-smoke-current', { active: false });
  writeLedger(workspace, '.paper-forward-live', {
    active: true,
    processId: process.pid
  });

  assert.deepEqual(assertNoConcurrentPaperSessions({
    workspaceRoot: workspace,
    currentLedgerFile: currentFile,
    allowConcurrent: true
  }), {
    allowed: true,
    sessions: []
  });
});

test('paper session lock은 동시에 시작하는 두 process의 race도 차단한다', () => {
  const workspace = makeWorkspace();
  const first = acquirePaperSessionLock({ workspaceRoot: workspace });

  assert.throws(
    () => acquirePaperSessionLock({ workspaceRoot: workspace }),
    error => error.code === 'PAPER_CONCURRENT_LOCK'
  );

  first.release();
  const second = acquirePaperSessionLock({ workspaceRoot: workspace });
  assert.equal(second.acquired, true);
  second.release();
});

test('dead owner의 stale lock은 새 session이 회수할 수 있다', () => {
  const workspace = makeWorkspace();
  const lockFile = path.join(workspace, '.paper-session.lock');
  fs.writeFileSync(lockFile, JSON.stringify({
    processId: 999_999_999,
    token: 'stale'
  }), 'utf8');

  const lock = acquirePaperSessionLock({ workspaceRoot: workspace });
  assert.equal(lock.acquired, true);
  assert.notEqual(JSON.parse(fs.readFileSync(lockFile, 'utf8')).token, 'stale');
  lock.release();
  assert.equal(fs.existsSync(lockFile), false);
});
