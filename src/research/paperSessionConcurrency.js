import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PAPER_OUTPUT_DIRECTORY = /^\.paper-(?:forward|smoke)(?:-.+)?$/;

function normalizePath(value) {
  return value ? path.resolve(String(value)) : null;
}

function readLedger(ledgerFile) {
  try {
    const raw = fs.readFileSync(ledgerFile, 'utf8');
    const ledger = JSON.parse(raw);
    return ledger && typeof ledger === 'object' ? ledger : null;
  } catch {
    return null;
  }
}

/**
 * Check a ledger owner without treating a stale/orphaned record as a live
 * process. `process.kill(pid, 0)` is a read-only existence check on POSIX.
 */
export function isPaperOwnerAlive(processId) {
  const pid = Number(processId);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still means that the process exists but is not inspectable by the
    // current user. It must remain a concurrency conflict.
    return error?.code === 'EPERM';
  }
}

/**
 * Discover the conventional paper output ledgers in one workspace. Explicit
 * `ledgerFiles` can be supplied by callers that keep ledgers elsewhere.
 */
export function discoverPaperValidationFiles(workspaceRoot = process.cwd()) {
  const root = normalizePath(workspaceRoot) || process.cwd();
  const files = [];
  const rootLedger = path.join(root, 'paper_validation.json');
  if (fs.existsSync(rootLedger)) files.push(rootLedger);

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !PAPER_OUTPUT_DIRECTORY.test(entry.name)) continue;
    const ledgerFile = path.join(root, entry.name, 'paper_validation.json');
    if (fs.existsSync(ledgerFile)) files.push(ledgerFile);
  }
  return [...new Set(files.map(normalizePath).filter(Boolean))].sort();
}

function readLock(lockFile) {
  try {
    const value = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function createLockError(message, sessions = []) {
  const error = new Error(message);
  error.code = 'PAPER_CONCURRENT_LOCK';
  error.sessions = sessions;
  return error;
}

/**
 * Acquire an atomic workspace-wide lock for new paper processes. The ledger
 * scan below handles already-running legacy processes; this lock closes the
 * startup race where two new processes would otherwise both pass that scan.
 */
export function acquirePaperSessionLock({
  workspaceRoot = process.cwd(),
  lockFile = null,
  processId = process.pid,
  allowConcurrent = false
} = {}) {
  if (allowConcurrent === true) {
    return {
      acquired: false,
      lockFile: null,
      release() {}
    };
  }

  const target = normalizePath(lockFile) || path.join(
    normalizePath(workspaceRoot) || process.cwd(),
    '.paper-session.lock'
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const token = randomUUID();
  const owner = {
    processId: Number(processId) || null,
    token,
    acquiredAt: new Date().toISOString()
  };

  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    let descriptor = null;
    try {
      descriptor = fs.openSync(target, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(owner), 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      acquired = true;
    } catch (error) {
      if (descriptor !== null) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // Preserve the original lock acquisition error.
        }
      }
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const previous = readLock(target);
      if (!previous) {
        throw createLockError(
          `paper session lock을 읽을 수 없습니다: ${target}. 다른 process를 안전하게 확인한 뒤 lock을 정리하세요.`
        );
      }
      if (isPaperOwnerAlive(previous.processId)) {
        throw createLockError(
          `실행 중인 paper session lock이 이미 있습니다 (PID ${previous.processId || 'unknown'}).`,
          [{ lockFile: target, processId: Number(previous.processId) || null }]
        );
      }

      try {
        fs.unlinkSync(target);
      } catch (removeError) {
        throw createLockError(
          `stale paper session lock을 회수하지 못했습니다: ${target} (${removeError.message})`
        );
      }
    }
  }

  if (!acquired) {
    throw createLockError(`paper session lock을 획득하지 못했습니다: ${target}`);
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      const current = readLock(target);
      if (current?.token === token) fs.unlinkSync(target);
    } catch {
      // Exit/cleanup must not mask the paper session result.
    } finally {
      process.off('exit', release);
    }
  };
  process.once('exit', release);
  return {
    acquired: true,
    lockFile: target,
    release
  };
}

export function findConcurrentPaperSessions({
  workspaceRoot = process.cwd(),
  currentLedgerFile = null,
  ledgerFiles = null
} = {}) {
  const current = normalizePath(currentLedgerFile);
  const candidates = Array.isArray(ledgerFiles) && ledgerFiles.length > 0
    ? ledgerFiles.map(normalizePath).filter(Boolean)
    : discoverPaperValidationFiles(workspaceRoot);

  return candidates
    .filter(ledgerFile => ledgerFile !== current)
    .map(ledgerFile => ({ ledgerFile, ledger: readLedger(ledgerFile) }))
    .filter(({ ledger }) => ledger?.active === true && isPaperOwnerAlive(ledger.processId))
    .map(({ ledgerFile, ledger }) => ({
      ledgerFile,
      outputDir: path.dirname(ledgerFile),
      sessionId: ledger.sessionId || null,
      processId: Number(ledger.processId) || null,
      startedAt: ledger.startedAt || null,
      heartbeatAt: ledger.heartbeatAt || null,
      strategyMode: ledger.strategyMode || null,
      targetCoins: Array.isArray(ledger.targetCoins) ? ledger.targetCoins.slice(0, 20) : []
    }));
}

/**
 * Fail closed before a new CLI paper session starts. Orphaned ledgers are
 * intentionally excluded: they need separate recovery/read-only handling,
 * but their dead owner cannot consume the exchange request budget.
 */
export function assertNoConcurrentPaperSessions({
  workspaceRoot = process.cwd(),
  currentLedgerFile = null,
  ledgerFiles = null,
  allowConcurrent = false
} = {}) {
  if (allowConcurrent === true) return { allowed: true, sessions: [] };

  const sessions = findConcurrentPaperSessions({
    workspaceRoot,
    currentLedgerFile,
    ledgerFiles
  });
  if (sessions.length === 0) return { allowed: true, sessions: [] };

  const details = sessions
    .map(session => `${path.basename(session.outputDir)} (PID ${session.processId || 'unknown'})`)
    .join(', ');
  const error = new Error(
    `실행 중인 paper 세션이 이미 있습니다: ${details}. ` +
    '기존 세션을 종료한 뒤 새 output directory를 사용하거나 PAPER_ALLOW_CONCURRENT_SESSIONS=true를 명시하세요.'
  );
  error.code = 'PAPER_CONCURRENT_SESSION';
  error.sessions = sessions;
  throw error;
}

export default assertNoConcurrentPaperSessions;
