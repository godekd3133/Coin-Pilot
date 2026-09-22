import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_SCHEMA,
  verifyMomentumShadowEvidenceSnapshot
} from '../src/research/momentumShadowEvidenceSnapshot.js';

function snapshot(overrides = {}) {
  return {
    schema: MOMENTUM_SHADOW_EVIDENCE_SNAPSHOT_SCHEMA,
    exportedAt: '2026-01-01T00:00:00.000Z',
    source: 'read-only /api/momentum-shadow projection',
    researchOnly: true,
    promoted: false,
    projection: {
      available: true,
      researchOnly: true,
      promoted: false,
      books: [{
        key: 'benchmark',
        available: true,
        heartbeatAt: '2026-01-01T00:00:00.000Z',
        heartbeatAgeSeconds: 0
      }]
    },
    ...overrides
  };
}

test('momentum shadow evidence verifier accepts a read-only snapshot', () => {
  const result = verifyMomentumShadowEvidenceSnapshot(snapshot(), Date.parse('2026-01-01T00:01:00.000Z'));
  assert.equal(result.valid, true);
  assert.equal(result.bookCount, 1);
  assert.equal(result.availableBookCount, 1);
  assert.equal(result.ageSeconds, 60);
  assert.equal(result.fresh, true);
  assert.equal(result.freshnessReason, 'fresh');
  assert.equal(result.unverifiableHeartbeatCount, 0);
});

test('momentum shadow evidence verifier rejects private fields and promoted snapshots', () => {
  const result = verifyMomentumShadowEvidenceSnapshot(snapshot({
    promoted: true,
    projection: {
      available: true,
      researchOnly: true,
      promoted: false,
      targetDir: '/Users/example/.paper-momentum-shadow-v2',
      books: []
    }
  }), Date.parse('2026-01-01T00:01:00.000Z'));
  assert.equal(result.valid, false);
  assert.equal(result.fresh, true);
  assert.ok(result.errors.includes('promoted_must_be_false'));
  assert.ok(result.errors.some(error => error.includes('targetDir:private_field')));
  assert.ok(result.errors.some(error => error.includes('targetDir:internal_path_value')));
});

test('momentum shadow evidence verifier rejects a future export timestamp', () => {
  const result = verifyMomentumShadowEvidenceSnapshot(
    snapshot({ exportedAt: '2026-01-02T00:00:00.000Z' }),
    Date.parse('2026-01-01T00:00:00.000Z')
  );
  assert.equal(result.valid, false);
  assert.equal(result.fresh, false);
  assert.equal(result.freshnessReason, 'exported_at_in_future');
  assert.ok(result.errors.includes('exported_at_in_future'));
});

test('momentum shadow evidence verifier separates a stale artifact from structural invalidity', () => {
  const result = verifyMomentumShadowEvidenceSnapshot(
    snapshot(),
    Date.parse('2026-01-01T00:16:00.000Z')
  );
  assert.equal(result.valid, true);
  assert.equal(result.fresh, false);
  assert.equal(result.freshnessReason, 'snapshot_stale');
  assert.equal(result.ageSeconds, 960);
});

test('momentum shadow evidence verifier reports stale heartbeat captured in the artifact', () => {
  const result = verifyMomentumShadowEvidenceSnapshot({
    ...snapshot(),
    projection: {
      ...snapshot().projection,
      books: [{
        key: 'benchmark',
        available: true,
        heartbeatAt: '2026-01-01T00:00:00.000Z',
        heartbeatAgeSeconds: 901
      }]
    }
  }, Date.parse('2026-01-01T00:01:00.000Z'));
  assert.equal(result.valid, true);
  assert.equal(result.fresh, false);
  assert.equal(result.freshnessReason, 'heartbeat_stale_at_export');
  assert.equal(result.staleHeartbeatCount, 1);
});
