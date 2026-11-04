import crypto from 'node:crypto';

/**
 * Dashboard password hashes.
 *
 * Format: `scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>`. Colons and
 * base64url keep the value safe in a systemd EnvironmentFile, dotenv and a
 * shell `source` (no `$` expansion). Only the hash is ever stored; the
 * password itself never reaches the env file or the repository.
 */

const PREFIX = 'scrypt';
const DEFAULT_PARAMS = Object.freeze({ N: 16384, r: 8, p: 1 });
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
// Bound the work factor accepted from configuration so a typo cannot turn
// every login attempt into a multi-second CPU stall on a small host.
const MAX_N = 1 << 17;
const MAX_PASSWORD_BYTES = 1024;

export const MIN_PASSWORD_LENGTH = 8;

function scryptOptions({ N, r, p }) {
  return { N, r, p, maxmem: 128 * N * r * 2 };
}

export function hashPassword(password, { salt = crypto.randomBytes(SALT_LENGTH), params = DEFAULT_PARAMS } = {}) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다.`);
  }
  if (Buffer.byteLength(password) > MAX_PASSWORD_BYTES) throw new Error('비밀번호가 너무 깁니다.');
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, scryptOptions(params));
  return [PREFIX, params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

/** Returns the parsed hash, or null when the value is not a supported hash. */
export function parsePasswordHash(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(':');
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const isPowerOfTwo = Number.isSafeInteger(N) && N > 1 && (N & (N - 1)) === 0;
  if (!isPowerOfTwo || N > MAX_N || !Number.isSafeInteger(r) || r < 1 || r > 32 ||
      !Number.isSafeInteger(p) || p < 1 || p > 4) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(parts[4]) || !/^[A-Za-z0-9_-]+$/.test(parts[5])) return null;
  const salt = Buffer.from(parts[4], 'base64url');
  const hash = Buffer.from(parts[5], 'base64url');
  if (salt.length < 8 || hash.length !== KEY_LENGTH) return null;
  return { params: { N, r, p }, salt, hash };
}

/**
 * Constant-time check. A wrong username still runs the same scrypt work so
 * the response time does not reveal which half of the credential was wrong.
 */
export function verifyPassword(password, parsed) {
  if (!parsed) return false;
  const candidate = typeof password === 'string' && Buffer.byteLength(password) <= MAX_PASSWORD_BYTES
    ? password
    : '';
  const derived = crypto.scryptSync(candidate, parsed.salt, KEY_LENGTH, scryptOptions(parsed.params));
  return crypto.timingSafeEqual(derived, parsed.hash) && candidate.length > 0;
}
