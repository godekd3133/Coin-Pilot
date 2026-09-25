import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessMomentumShadowCostFloor,
  DEFAULT_MOMENTUM_SHADOW_COST_PERCENT,
  gateMomentumShadowEntryCandidates,
  resolveMomentumShadowCostPercent
} from '../src/research/momentumShadowCostFloor.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('momentum shadow defaults new runs to the shared modeled round-trip floor', () => {
  assert.equal(DEFAULT_MOMENTUM_SHADOW_COST_PERCENT, 0.3);
  assert.equal(resolveMomentumShadowCostPercent(undefined), 0.3);
  assert.equal(resolveMomentumShadowCostPercent(''), 0.3);
  assert.equal(resolveMomentumShadowCostPercent('0.2'), 0.2);
  assert.equal(resolveMomentumShadowCostPercent('invalid'), 0.3);
});

test('momentum shadow cost-floor assessment blocks under-floor and invalid estimates', () => {
  assert.deepEqual(assessMomentumShadowCostFloor(0.2), {
    ready: false,
    configuredCostPercent: 0.2,
    requiredCostPercent: 0.3,
    reason: 'candidate_cost_below_round_trip_cost_floor'
  });
  assert.equal(assessMomentumShadowCostFloor(0.3).ready, true);
  assert.equal(assessMomentumShadowCostFloor(0.35).ready, true);
  assert.equal(assessMomentumShadowCostFloor(null).configuredCostPercent, null);
  assert.equal(assessMomentumShadowCostFloor(Number.NaN).ready, false);
});

test('momentum shadow cost-floor gate suppresses only new candidate entries without mutating them', () => {
  const candidates = [{ market: 'KRW-BTC' }, { market: 'KRW-ETH' }];
  const underFloor = gateMomentumShadowEntryCandidates(
    candidates,
    assessMomentumShadowCostFloor(0.2)
  );
  assert.deepEqual(underFloor, { entryCandidates: [], blockedEntryCount: 2 });
  assert.equal(candidates.length, 2);

  const ready = gateMomentumShadowEntryCandidates(
    candidates,
    assessMomentumShadowCostFloor(0.3)
  );
  assert.deepEqual(ready, { entryCandidates: candidates, blockedEntryCount: 0 });
});

test('daily shadow runner applies the cost guard after existing-position exits and to pending fills', () => {
  const runnerFile = path.join(projectRoot, 'src/scripts/runRegimeMomentumShadow.js');
  const source = fs.readFileSync(runnerFile, 'utf8');
  const cycleSource = source.split('async function cycle(ledger, strategies) {')[1]
    ?.split('async function main() {')[0];
  assert.ok(cycleSource);
  const exitsIndex = cycleSource.indexOf("markCycleStage('exits')");
  const pendingIndex = cycleSource.indexOf("markCycleStage('pending_entries')");
  assert.ok(exitsIndex >= 0 && pendingIndex > exitsIndex);
  assert.match(cycleSource, /executeMomentumShadowPendingEntries\([\s\S]*?costFloorReady: COST_FLOOR_STATUS\.ready/);
  assert.match(cycleSource, /gateMomentumShadowEntryCandidates\(/);
  assert.match(source, /ledger\.costFloorGuardVersion = 1/);
});
