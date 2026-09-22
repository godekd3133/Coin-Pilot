import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv, formatEnvErrors, formatEnvWarnings } from '../src/config/envLoader.js';

function keysOf(errors) {
  return errors.map(e => e.key);
}

test('schema-typed values parse into their declared types', () => {
  const { values, errors } = loadEnv({
    SCALP_MAX_MARKETS: '20',
    SCALP_MIN_VOLUME_RATIO: '1.5',
    SCALP_MARKET_REGIME_ENABLED: 'TRUE',
    TARGET_COINS: 'KRW-BTC, KRW-ETH',
    LOG_LEVEL: 'debug',
    MOMO_SHADOW_MODE: 'regime'
  });
  assert.deepEqual(errors, []);
  assert.equal(values.SCALP_MAX_MARKETS, 20);
  assert.equal(values.SCALP_MIN_VOLUME_RATIO, 1.5);
  assert.equal(values.SCALP_MARKET_REGIME_ENABLED, true);
  assert.equal(values.LOG_LEVEL, 'debug');
  assert.equal(values.MOMO_SHADOW_MODE, 'regime');
});

test('list type splits on commas and drops empty segments', () => {
  const { values } = loadEnv({ SCALP_VALIDATION_MARKETS: 'KRW-BTC, KRW-ETH,,KRW-XRP ' });
  assert.deepEqual(values.SCALP_VALIDATION_MARKETS, ['KRW-BTC', 'KRW-ETH', 'KRW-XRP']);
});

test('int keys reject non-integer input instead of truncating', () => {
  const { errors } = loadEnv({ SCALP_MAX_MARKETS: 'twenty', SCALP_CANDLE_COUNT: '1.5' });
  assert.deepEqual(keysOf(errors).sort(), ['SCALP_CANDLE_COUNT', 'SCALP_MAX_MARKETS']);
});

test('number keys reject non-numeric input', () => {
  const { errors } = loadEnv({ SCALP_MIN_VOLUME_RATIO: 'abc' });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /숫자여야 합니다/);
  assert.match(errors[0].message, /'abc'/);
});

test('range constraints are enforced', () => {
  const { errors } = loadEnv({
    SCALP_MAX_MARKETS: '-1',
    DASHBOARD_PORT: '70000',
    SCALP_PORTFOLIO_ALLOCATION: '1.5'
  });
  assert.deepEqual(keysOf(errors).sort(), ['DASHBOARD_PORT', 'SCALP_MAX_MARKETS', 'SCALP_PORTFOLIO_ALLOCATION']);
});

test('bool keys accept only true/false literals (fail fast, no silent misread)', () => {
  const { values, errors } = loadEnv({ BUY_ONLY: 'true', ALLOW_AVERAGING: 'False' });
  assert.deepEqual(errors, []);
  assert.equal(values.BUY_ONLY, true);
  assert.equal(values.ALLOW_AVERAGING, false);

  for (const bad of ['yes', '1', '0', 'ture', 'on']) {
    const { errors: errs } = loadEnv({ BUY_ONLY: bad });
    assert.equal(errs.length, 1, `expected error for ${bad}`);
    assert.match(errs[0].message, /true 또는 false/);
  }
});

test('DRY_RUN with a non-literal value errors instead of guessing the mode', () => {
  // '0' historically evaluated as "not 'false'" => dry-run true under !== 'false',
  // but reads as false under numeric coercion. Guessing either way is unsafe on
  // the live-trading switch, so the schema demands an explicit literal.
  const { errors } = loadEnv({ DRY_RUN: '0' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].key, 'DRY_RUN');
});

test('enum keys reject values outside the declared set', () => {
  const { errors } = loadEnv({ LOG_LEVEL: 'verbose', MOMO_SHADOW_MODE: 'chaos' });
  assert.deepEqual(keysOf(errors).sort(), ['LOG_LEVEL', 'MOMO_SHADOW_MODE']);
  assert.match(errors[0].message + errors[1].message, /허용 값/);
});

test('blank values count as unset, matching parseInt(env.X) || fallback history', () => {
  const { values, errors } = loadEnv({ SCALP_MAX_MARKETS: '', BUY_ONLY: '   ' });
  assert.deepEqual(errors, []);
  assert.equal(values.SCALP_MAX_MARKETS, undefined);
  assert.equal(values.BUY_ONLY, undefined);
});

test('UPBIT keys are required only in live mode', () => {
  const live = loadEnv({ DRY_RUN: 'false' });
  assert.deepEqual(keysOf(live.errors).sort(), ['UPBIT_ACCESS_KEY', 'UPBIT_SECRET_KEY']);
  assert.match(live.errors[0].message, /실전투자/);

  const liveWithKeys = loadEnv({
    DRY_RUN: 'false',
    UPBIT_ACCESS_KEY: 'ak',
    UPBIT_SECRET_KEY: 'sk'
  });
  assert.deepEqual(liveWithKeys.errors, []);

  const dry = loadEnv({ DRY_RUN: 'true' });
  assert.deepEqual(dry.errors, []);

  const unset = loadEnv({});
  assert.deepEqual(unset.errors, []);
});

test('unknown vars inside a project prefix warn; outside they stay silent', () => {
  const { warnings, errors } = loadEnv({
    SCALP_TYPO_X: '1',
    MOMO_SHADOW_TYPO: '2',
    TOTALLY_OTHER: 'x',
    NODE_ENV: 'test'
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.length, 2);
  assert.match(warnings.join('\n'), /SCALP_TYPO_X/);
  assert.match(warnings.join('\n'), /MOMO_SHADOW_TYPO/);
});

test('formatEnvErrors names every offending key; warnings list the unknowns', () => {
  const { errors, warnings } = loadEnv({ SCALP_MAX_MARKETS: 'abc', SCALP_TYPO_X: '1' });
  const text = formatEnvErrors(errors);
  assert.match(text, /SCALP_MAX_MARKETS/);
  assert.match(text, /1건/);
  assert.match(text, /\.env\.example/);
  assert.match(formatEnvWarnings(warnings), /SCALP_TYPO_X/);
});
