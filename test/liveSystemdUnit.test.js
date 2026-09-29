import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const liveServiceUnit = fs.readFileSync(
  path.join(projectRoot, 'ops/systemd/coinpilot-live.service'),
  'utf8'
);
const liveEnvironmentExample = fs.readFileSync(
  path.join(projectRoot, 'ops/systemd/coinpilot-live.env.example'),
  'utf8'
);

test('LIVE systemd service does not force-kill an unbounded protective drain', () => {
  assert.match(liveServiceUnit, /^Restart=on-failure$/m);
  assert.match(liveServiceUnit, /^TimeoutStopSec=infinity$/m);
  assert.doesNotMatch(liveServiceUnit, /^TimeoutStopSec=(?:\d|\d+[a-z])/m);
});

test('LIVE systemd optimizer persistence is rooted in its writable state directory', () => {
  const stateDir = liveEnvironmentExample.match(/^COINPILOT_STATE_DIR=(.+)$/m)?.[1];
  const writableRoot = liveServiceUnit.match(/^ReadWritePaths=(.+)$/m)?.[1];
  assert.ok(stateDir, 'the service environment example must select persistent optimizer state');
  assert.ok(writableRoot, 'the systemd unit must declare a writable state root');
  assert.equal(path.resolve(stateDir), path.resolve(writableRoot));
});
