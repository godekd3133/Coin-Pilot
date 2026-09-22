import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync(new URL('../ops/run-sealed-forward-rsi.sh', import.meta.url), 'utf8');

test('sealed forward strict-only switch maps to disabled diagnostic shadows', () => {
  assert.match(script, /true\)\s+COINPILOT_SEALED_FORWARD_DIAGNOSTIC_SHADOWS_ENABLED=false/);
  assert.match(script, /false\)\s+COINPILOT_SEALED_FORWARD_DIAGNOSTIC_SHADOWS_ENABLED=true/);
  assert.match(script, /SCALP_PAPER_DIAGNOSTIC_SHADOWS_ENABLED="\$COINPILOT_SEALED_FORWARD_DIAGNOSTIC_SHADOWS_ENABLED"/);
});

test('sealed forward strict-only switch rejects values outside true/false', () => {
  assert.match(script, /COINPILOT_SEALED_FORWARD_STRICT_ONLY must be true or false/);
  assert.match(script, /exit 2/);
});
