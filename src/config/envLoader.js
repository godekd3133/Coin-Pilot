import { ENV_SCHEMA, ENV_REQUIRED_RULES } from './envSchema.js';

// Platform-owned envs that are never CoinPilot configuration.
const PLATFORM_ENVS = new Set([
  'NODE_ENV',
  'PATH',
  'HOME',
  'PWD',
  'LANG',
  'SHELL',
  'USER',
  'TERM',
  'TMPDIR'
]);

// Project namespaces. An uppercase env var sharing one of these prefixes but
// missing from the schema is almost always a typo of a real knob, so it is
// surfaced as a boot warning (never a fatal error — shell envs are noisy).
const PROJECT_PREFIXES = [
  'SCALP_',
  'MOMO_',
  'PAPER_',
  'UPBIT_',
  'AI_',
  'DASHBOARD_',
  'DAILY_',
  'REGIME_',
  'SHADOW_',
  'STAGING_',
  'BACKTEST_',
  'OPTIMIZATION_',
  'NEWS_',
  'LOG_',
  'NODE_TEST_',
  'TARGET_',
  'TRADING_',
  'DRY_RUN_',
  'ENABLE_DASHBOARD_'
];

const MAX_WARNING_LINES = 20;

function displayValue(spec, raw) {
  return spec.secret ? '(redacted)' : `'${raw}'`;
}

// Returns { ok: true, value } or { ok: false, message }.
function parseValue(key, spec, raw) {
  switch (spec.type) {
    case 'string':
      return { ok: true, value: raw };
    case 'int': {
      const n = Number(raw);
      if (!Number.isInteger(n)) {
        return { ok: false, message: `정수여야 합니다 (현재 값: ${displayValue(spec, raw)})` };
      }
      return checkRange(spec, n, raw);
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        return { ok: false, message: `숫자여야 합니다 (현재 값: ${displayValue(spec, raw)})` };
      }
      return checkRange(spec, n, raw);
    }
    case 'bool': {
      // Strict literal set: 'true'/'false' (case-insensitive). Anything else
      // (e.g. 'yes', '1', 'ture') is a boot error rather than a silent
      // misread — on DRY_RUN a silent misread could flip live trading.
      if (/^true$/i.test(raw)) return { ok: true, value: true };
      if (/^false$/i.test(raw)) return { ok: true, value: false };
      return { ok: false, message: `true 또는 false여야 합니다 (현재 값: ${displayValue(spec, raw)})` };
    }
    case 'enum': {
      if (spec.values.includes(raw)) return { ok: true, value: raw };
      return {
        ok: false,
        message: `허용 값 ${spec.values.join('|')} 중 하나여야 합니다 (현재 값: ${displayValue(spec, raw)})`
      };
    }
    case 'list':
      return {
        ok: true,
        value: raw
          .split(',')
          .map(part => part.trim())
          .filter(part => part.length > 0)
      };
    default:
      return { ok: true, value: raw };
  }
}

function checkRange(spec, n, raw) {
  if (spec.min !== undefined && n < spec.min) {
    return { ok: false, message: `최솟값 ${spec.min} 이상이어야 합니다 (현재 값: ${displayValue(spec, raw)})` };
  }
  if (spec.max !== undefined && n > spec.max) {
    return { ok: false, message: `최댓값 ${spec.max} 이하여야 합니다 (현재 값: ${displayValue(spec, raw)})` };
  }
  return { ok: true, value: n };
}

/**
 * Validate `source` against ENV_SCHEMA.
 *
 * - Blank or whitespace-only values count as unset, matching the historical
 *   parse-then-fallback behavior for empty assignments.
 * - Every SET schema key is parsed; malformed values collect as errors.
 * - ENV_REQUIRED_RULES then check cross-key requirements on parsed values.
 * - Unknown uppercase vars inside a known project prefix become warnings.
 *
 * @param {object} source env map (defaults to process.env)
 * @returns {{values: object, errors: Array<{key:string,message:string}>,
 *            warnings: Array<string>}}
 */
export function loadEnv(source = process.env) {
  const values = {};
  const errors = [];
  const warnings = [];

  for (const [key, spec] of Object.entries(ENV_SCHEMA)) {
    const raw = source[key];
    if (raw === undefined || String(raw).trim() === '') continue;
    const parsed = parseValue(key, spec, String(raw));
    if (parsed.ok) values[key] = parsed.value;
    else errors.push({ key, message: parsed.message });
  }

  for (const rule of ENV_REQUIRED_RULES) {
    if (!rule.when(values)) continue;
    for (const key of rule.keys) {
      if (values[key] === undefined) errors.push({ key, message: rule.reason });
    }
  }

  for (const key of Object.keys(source)) {
    if (
      ENV_SCHEMA[key] ||
      PLATFORM_ENVS.has(key) ||
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      !PROJECT_PREFIXES.some(prefix => key.startsWith(prefix))
    ) {
      continue;
    }
    warnings.push(`${key}: 알 수 없는 설정 키입니다 (오타인지 확인하세요)`);
  }

  return { values, errors, warnings };
}

export function formatEnvErrors(errors) {
  const lines = errors.map(({ key, message }) => `   - ${key}: ${message}`);
  return [
    `❌ 환경설정 오류가 발견되었습니다 (${errors.length}건):`,
    ...lines,
    '',
    '.env.example을 참고해 .env를 수정한 뒤 다시 시작하세요.'
  ].join('\n');
}

export function formatEnvWarnings(warnings) {
  const shown = warnings.slice(0, MAX_WARNING_LINES);
  const lines = shown.map(warning => `   - ${warning}`);
  if (warnings.length > shown.length) {
    lines.push(`   - ... 외 ${warnings.length - shown.length}건`);
  }
  return [`⚠️  알 수 없는 환경변수 (${warnings.length}건):`, ...lines].join('\n');
}
