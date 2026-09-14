import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPaperValidationConfigSnapshot,
  mergePaperValidationConfig
} from '../src/research/scalpingValidationConfig.js';

function tempFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-validation-')), name);
}

test('paper snapshot loader는 완료된 validation config만 허용한다', () => {
  const file = tempFile('paper_validation.json');
  fs.writeFileSync(file, JSON.stringify({
    sessionId: 'paper-test',
    startedAt: '2026-09-13T00:00:00.000Z',
    configSnapshotComplete: true,
    configSnapshot: {
      rsiOversold: 35,
      rsiOverbought: 65,
      candleUnit: 1,
      processId: 12345,
      targetCoins: ['KRW-BTC']
    }
  }));

  const snapshot = loadPaperValidationConfigSnapshot(file);
  assert.equal(snapshot.sessionId, 'paper-test');
  assert.equal(snapshot.config.rsiOversold, 35);
  assert.equal(snapshot.config.rsiOverbought, 65);
  assert.equal(snapshot.config.candleUnit, 1);
  assert.equal('processId' in snapshot.config, false);
  assert.equal('targetCoins' in snapshot.config, false);
});

test('불완전한 paper snapshot은 DEFAULT_CONFIG fallback 없이 fail-closed 한다', () => {
  const file = tempFile('paper_validation.json');
  fs.writeFileSync(file, JSON.stringify({
    configSnapshotComplete: false,
    configSnapshot: { rsiOversold: 35 }
  }));

  assert.throws(
    () => loadPaperValidationConfigSnapshot(file),
    /불완전/,
  );
});

test('paper snapshot과 validation candle unit이 다르면 혼합 timeframe을 차단한다', () => {
  const snapshot = {
    config: { rsiOversold: 35, candleUnit: 1 }
  };
  assert.throws(
    () => mergePaperValidationConfig({ rsiOversold: 30, candleUnit: 15 }, snapshot, 15),
    /candle unit 불일치/,
  );
});

test('완료된 snapshot은 validation config를 덮어쓰고 CLI candle unit을 보존한다', () => {
  const merged = mergePaperValidationConfig(
    { rsiOversold: 30, rsiOverbought: 70, candleUnit: 1 },
    { config: { rsiOversold: 35, rsiOverbought: 65, candleUnit: 1 } },
    1
  );
  assert.deepEqual(merged, {
    rsiOversold: 35,
    rsiOverbought: 65,
    candleUnit: 1
  });
});


test('live entry와 forward-paper entry는 동일한 SCALP_* env 계약을 해석한다', () => {
  const envNames = source =>
    new Set(
      [...source.matchAll(/(?:process\.env\.|envNumber\(')([A-Z_]+)'?\)?/g)]
        .map(match => match[1])
        .filter(name => name.startsWith('SCALP_'))
    );
  const live = envNames(fs.readFileSync('src/index.js', 'utf8'));
  const paper = envNames(fs.readFileSync('src/scripts/runPaperSmoke.js', 'utf8'));

  // Live-only knobs the paper lane intentionally never needs: the live gate
  // toggle itself and averaging, which scalping mode force-disables anyway.
  const liveOnly = new Set(['SCALP_REQUIRE_VALIDATION_PASS', 'SCALP_ALLOW_AVERAGING']);
  // Paper-session-only knobs the live entry intentionally never needs.
  const paperOnly = /^SCALP_PAPER_/;

  assert.deepEqual(
    [...live].filter(name => !paper.has(name) && !liveOnly.has(name)),
    []
  );
  assert.deepEqual(
    [...paper].filter(name => !live.has(name) && !paperOnly.test(name)),
    []
  );
});

test('legacy multiCoinIndex 엔트리는 스캘핑 해석 시 fail-closed로 거부한다', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['src/multiCoinIndex.js'], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, TRADING_STRATEGY: undefined }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr + result.stdout, /npm start/);
});
