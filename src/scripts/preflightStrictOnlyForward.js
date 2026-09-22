import fs from 'node:fs';
import path from 'node:path';
import { findConcurrentPaperSessions, isPaperOwnerAlive } from '../research/paperSessionConcurrency.js';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function diagnosticTradeCount(ledger) {
  const closed = book => Array.isArray(book?.closedTrades)
    ? book.closedTrades.length
    : Array.isArray(book?.trades) ? book.trades.length : 0;
  return closed(ledger?.shadow) + closed(ledger?.looseShadow) + closed(ledger?.winnerShadow);
}

function diagnosticOpenPositionCount(ledger) {
  const open = book => Object.keys(book?.positions || book?.openPositions || {}).length;
  return open(ledger?.shadow) + open(ledger?.looseShadow) + open(ledger?.winnerShadow);
}

/**
 * Read-only preflight for the next strict-only forward paper session.
 * It never creates an output directory, repairs a ledger, or starts a runner.
 */
export function preflightStrictOnlyForward({
  workspaceRoot = process.cwd(),
  outputDir = '.paper-forward-sealed-rsi-strict-only-r1'
} = {}) {
  const root = path.resolve(workspaceRoot);
  const resolvedOutputDir = path.resolve(root, outputDir);
  const ledgerFile = path.join(resolvedOutputDir, 'paper_validation.json');
  const blockers = [];
  const concurrentSessions = findConcurrentPaperSessions({
    workspaceRoot: root,
    currentLedgerFile: ledgerFile
  });

  if (concurrentSessions.length > 0) {
    blockers.push({
      code: 'paper_owner_active',
      message: `실행 중인 paper owner ${concurrentSessions.map(session => `${path.basename(session.outputDir)}(PID ${session.processId || 'unknown'})`).join(', ')}`
    });
  }

  const outputExists = fs.existsSync(resolvedOutputDir);
  const ledger = fs.existsSync(ledgerFile) ? readJson(ledgerFile) : null;
  if (outputExists && !ledger) {
    let directoryHasEntries = true;
    try {
      directoryHasEntries = fs.readdirSync(resolvedOutputDir).length > 0;
    } catch {
      // An unreadable output directory is unsafe to reuse; keep the fail-closed default.
    }
    if (directoryHasEntries) {
      blockers.push({ code: 'output_directory_not_empty', message: '대상 output directory가 비어 있지 않고 유효한 paper ledger가 없습니다.' });
    }
  }

  if (ledger) {
    if (ledger.active === true) {
      const ownerAlive = isPaperOwnerAlive(ledger.processId);
      blockers.push({
        code: ownerAlive === true ? 'target_owner_active' : 'target_owner_orphaned',
        message: ownerAlive === true
          ? `대상 strict-only ledger가 이미 실행 중입니다 (PID ${ledger.processId || 'unknown'}).`
          : '대상 strict-only ledger가 active 상태지만 owner process를 확인할 수 없습니다. 자동 재사용하지 않습니다.'
      });
    }
    if (ledger.paperExperiments?.diagnosticShadows?.enabled !== false) {
      blockers.push({
        code: 'ledger_not_strict_only',
        message: '대상 ledger가 strict-only 설정으로 기록되지 않았습니다.'
      });
    }
    if (ledger.endedAt || ledger.stopReason) {
      blockers.push({
        code: 'target_ledger_already_used',
        message: '이미 종료된 ledger는 새 strict-only evidence window로 재사용하지 않습니다.'
      });
    }
    if (diagnosticTradeCount(ledger) > 0 || diagnosticOpenPositionCount(ledger) > 0) {
      blockers.push({
        code: 'diagnostic_state_present',
        message: '대상 ledger에 diagnostic trade 또는 미청산 diagnostic position이 있습니다.'
      });
    }
  }

  return {
    researchOnly: true,
    strictOnly: true,
    ready: blockers.length === 0,
    workspaceRoot: root,
    outputDir: resolvedOutputDir,
    ledgerFile,
    concurrentSessions,
    blockers,
    note: 'read-only preflight이며 output directory·ledger·paper owner를 변경하지 않습니다.'
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const outputDir = process.argv[2] || process.env.PAPER_SMOKE_OUTPUT_DIR || '.paper-forward-sealed-rsi-strict-only-r1';
  const result = preflightStrictOnlyForward({ outputDir });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 2;
}
