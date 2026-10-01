import { ENV_SCHEMA } from './envSchema.js';

/**
 * 부팅 경로(index.js의 loadEnv)가 아닌 소비자를 위한 타입드 env 접근자.
 *
 * 계약:
 * - 키는 ENV_SCHEMA에 선언되어 있어야 한다 — 오타 키는 조용한 기본값이 아니라
 *   즉시 예외를 던진다 (부팅 로더의 알 수 없는 키 경고와 같은 fail-fast 의도).
 * - 값이 설정돼 있으면 스키마 타입으로 파싱한다 — 잘못된 값도 예외.
 *   기존 호출부별 `number(env, fallback)` 조용한 폴백은 오타를 숨겼다.
 * - 미설정/빈 문자열이면 호출자의 fallback을 반환한다 — 파일별 기본값은
 *   호출자 계약으로 남는다(라이브/백테스트 기본값이 의도적으로 다른 것처럼).
 *
 * 사용 예: envNumber('SCALP_MIN_REBOUND_PERCENT', 0.15)
 */

function specFor(key, expectedTypes = null) {
  const spec = ENV_SCHEMA[key];
  if (!spec) {
    throw new Error(
      `envConfig: '${key}'는 envSchema에 선언되지 않았습니다. ` +
      `오타이거나 새 설정이면 src/config/envSchema.js에 먼저 선언하세요.`
    );
  }
  if (expectedTypes && !expectedTypes.includes(spec.type)) {
    throw new Error(
      `envConfig: '${key}'의 스키마 타입은 '${spec.type}'입니다 — ` +
      `맞는 접근자(${expectedTypes.join('/')})를 사용하세요.`
    );
  }
  return spec;
}

function rawValue(key, source) {
  const raw = source[key];
  if (raw === undefined || String(raw).trim() === '') return undefined;
  return String(raw);
}

function parseNumber(key, spec, raw, { integer }) {
  const value = Number(raw);
  if (integer && !Number.isInteger(value)) {
    throw new Error(`envConfig: ${key}는 정수여야 합니다 (현재 값: '${raw}')`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`envConfig: ${key}는 숫자여야 합니다 (현재 값: '${raw}')`);
  }
  if (spec.min !== undefined && value < spec.min) {
    throw new Error(`envConfig: ${key}는 최솟값 ${spec.min} 이상이어야 합니다 (현재 값: '${raw}')`);
  }
  if (spec.max !== undefined && value > spec.max) {
    throw new Error(`envConfig: ${key}는 최댓값 ${spec.max} 이하여야 합니다 (현재 값: '${raw}')`);
  }
  return value;
}

function parseBool(key, raw) {
  if (/^true$/i.test(raw)) return true;
  if (/^false$/i.test(raw)) return false;
  throw new Error(`envConfig: ${key}는 true 또는 false여야 합니다 (현재 값: '${raw}')`);
}

/**
 * 수치 설정. 스키마는 'number' 또는 'int'여야 한다.
 * @param {string} key ENV_SCHEMA에 선언된 키
 * @param {number} fallback 미설정/빈 값일 때의 기본값
 */
export function envNumber(key, fallback, { source = process.env } = {}) {
  const spec = specFor(key, ['number', 'int']);
  const raw = rawValue(key, source);
  if (raw === undefined) return fallback;
  return parseNumber(key, spec, raw, { integer: spec.type === 'int' });
}

export function envInt(key, fallback, options) {
  return envNumber(key, fallback, options);
}

/**
 * 불리언 설정. 'true'/'false'만 허용(대소문자 무관) — 엄격 파싱으로
 * `!== 'false'`/`=== 'true'` 양쪽 레거시 패턴을 하나로 수렴한다.
 */
export function envBool(key, fallback, { source = process.env } = {}) {
  specFor(key, ['bool']);
  const raw = rawValue(key, source);
  if (raw === undefined) return fallback;
  return parseBool(key, raw);
}

/**
 * 문자열 설정. 스키마가 enum이면 허용 값 밖이면 예외.
 */
export function envString(key, fallback, { source = process.env } = {}) {
  const spec = specFor(key, ['string', 'enum']);
  const raw = rawValue(key, source);
  if (raw === undefined) return fallback;
  if (spec.type === 'enum' && !spec.values.includes(raw)) {
    throw new Error(
      `envConfig: ${key}는 허용 값 ${spec.values.join('|')} 중 하나여야 합니다 (현재 값: '${raw}')`
    );
  }
  return raw;
}

/**
 * 스냅샷/원장 기록용 verbatim 읽기 — 값은 파싱 없이 그대로 반환한다.
 * (기록 계약이 raw 문자열을 기대하는 곳 전용; 설정 소비는 타입드 접근자 사용)
 */
export function envRaw(key, { source = process.env } = {}) {
  specFor(key);
  const raw = source[key];
  return raw === undefined ? undefined : String(raw);
}

/**
 * 콤마 구분 목록 설정.
 */
export function envList(key, fallback, { source = process.env } = {}) {
  specFor(key, ['list']);
  const raw = rawValue(key, source);
  if (raw === undefined) return fallback;
  return raw.split(',').map(part => part.trim()).filter(part => part.length > 0);
}

/**
 * 수치 축(axis) 설정 — 스칼라 선언이지만 스윕용으로 '0.1,0.2' 목록을 담는
 * 리서치 키용. 비수치 항목은 기존 numberAxis처럼 조용히 걸러낸다.
 * (fail-fast는 스칼라 envNumber에만 두고, 축 파싱은 기존 필터 계약을 유지)
 */
export function envNumberList(key, fallback, { source = process.env } = {}) {
  specFor(key, ['list', 'number', 'int', 'string']);
  const raw = rawValue(key, source);
  if (raw === undefined) return fallback;
  return raw.split(',').map(Number).filter(Number.isFinite);
}
