import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE =
  '.paper-momentum-shadow-candidate.lock';

function resolvedFile(file = DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE) {
  return path.resolve(String(file));
}

function readRaw(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function isMomentumShadowCandidateProcessAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the candidate-only slot without treating malformed state as empty.
 * A malformed slot is unverifiable and must be handled fail-closed by the
 * caller rather than silently overwritten.
 */
export function readMomentumShadowCandidateSlot(file = DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE) {
  const resolved = resolvedFile(file);
  const raw = readRaw(resolved);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { valid: false, file: resolved, error: 'candidate slot must contain an object' };
    }
    return { ...parsed, valid: true, file: resolved };
  } catch (error) {
    return { valid: false, file: resolved, error: error.message };
  }
}

export function inspectMomentumShadowCandidateSlot(
  file = DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE
) {
  const resolved = resolvedFile(file);
  const slot = readMomentumShadowCandidateSlot(resolved);
  if (!slot) {
    return {
      file: resolved,
      exists: false,
      valid: true,
      occupied: false,
      ownerAlive: false,
      ownerPid: null,
      ownerDir: null,
      startedAt: null
    };
  }
  if (slot.valid !== true) {
    return {
      file: resolved,
      exists: true,
      valid: false,
      occupied: false,
      ownerAlive: false,
      ownerPid: null,
      ownerDir: null,
      startedAt: null,
      error: slot.error
    };
  }
  const ownerAlive = isMomentumShadowCandidateProcessAlive(slot.pid);
  return {
    file: resolved,
    exists: true,
    valid: true,
    occupied: ownerAlive,
    ownerAlive,
    ownerPid: Number.isInteger(Number(slot.pid)) ? Number(slot.pid) : null,
    ownerDir: slot.dir || null,
    startedAt: slot.startedAt || null
  };
}

/**
 * Atomically claim the one candidate execution slot. Stale slots are removed
 * only after two identical reads and a dead owner check; malformed slots are
 * never deleted automatically.
 */
export function acquireMomentumShadowCandidateSlot({
  file = DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE,
  pid = process.pid,
  dir = null,
  startedAt = new Date().toISOString()
} = {}) {
  const resolved = resolvedFile(file);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const claim = () => {
    fs.writeFileSync(resolved, JSON.stringify({ pid, dir, startedAt }), { flag: 'wx' });
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      claim();
      const owned = readMomentumShadowCandidateSlot(resolved);
      if (owned?.valid !== true || Number(owned.pid) !== Number(pid)) {
        throw new Error('candidate slot claim could not be verified');
      }
      return resolved;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    const current = readMomentumShadowCandidateSlot(resolved);
    if (!current || current.valid !== true) {
      throw new Error(`FAIL_CLOSED: candidate slot is unverifiable (${current?.error || 'missing'})`);
    }
    if (isMomentumShadowCandidateProcessAlive(current.pid)) {
      throw new Error(`FAIL_CLOSED: candidate slot held by live pid ${current.pid}`);
    }
    const latest = readMomentumShadowCandidateSlot(resolved);
    if (JSON.stringify(latest) !== JSON.stringify(current)) continue;
    try {
      fs.unlinkSync(resolved);
    } catch (unlinkError) {
      if (unlinkError?.code !== 'ENOENT') throw unlinkError;
    }
  }
  throw new Error('FAIL_CLOSED: candidate slot contention did not resolve');
}

export function releaseMomentumShadowCandidateSlot({
  file = DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE,
  pid = process.pid
} = {}) {
  const resolved = resolvedFile(file);
  const current = readMomentumShadowCandidateSlot(resolved);
  if (!current || current.valid !== true || Number(current.pid) !== Number(pid)) return false;
  try {
    fs.unlinkSync(resolved);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
