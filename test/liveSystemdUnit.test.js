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
const rateCoordinatorUnit = fs.readFileSync(
  path.join(projectRoot, 'ops/systemd/coinpilot-upbit-rate.service'),
  'utf8'
);

test('LIVE systemd service does not force-kill an unbounded protective drain', () => {
  assert.match(liveServiceUnit, /^Restart=on-failure$/m);
  assert.match(liveServiceUnit, /^TimeoutStopSec=infinity$/m);
  assert.doesNotMatch(liveServiceUnit, /^TimeoutStopSec=(?:\d|\d+[a-z])/m);
});

test('LIVE systemd optimizer persistence is rooted in its writable state directory', () => {
  const stateDir = liveEnvironmentExample.match(/^COINPILOT_STATE_DIR=(.+)$/m)?.[1];
  const writableRoots = liveServiceUnit.match(/^ReadWritePaths=(.+)$/m)?.[1]?.split(/\s+/) || [];
  assert.ok(stateDir, 'the service environment example must select persistent optimizer state');
  assert.ok(writableRoots.length, 'the systemd unit must declare writable state roots');
  assert.ok(writableRoots.map(value => path.resolve(value)).includes(path.resolve(stateDir)));
});

test('LIVE and other same-host clients share a separate protected coordinator state directory', () => {
  const rateStateDir = liveEnvironmentExample.match(/^UPBIT_RATE_COORDINATOR_STATE_DIR=(.+)$/m)?.[1];
  const liveWritableRoots = liveServiceUnit.match(/^ReadWritePaths=(.+)$/m)?.[1]?.split(/\s+/) || [];
  const coordinatorWritableRoots = rateCoordinatorUnit.match(/^ReadWritePaths=(.+)$/m)?.[1]?.split(/\s+/) || [];

  assert.equal(liveEnvironmentExample.match(/^UPBIT_RATE_COORDINATOR_REQUIRED=(.+)$/m)?.[1], 'true');
  assert.ok(rateStateDir);
  assert.notEqual(path.resolve(rateStateDir), path.resolve(liveEnvironmentExample.match(/^COINPILOT_STATE_DIR=(.+)$/m)?.[1]));
  assert.match(liveServiceUnit, /^Requires=coinpilot-upbit-rate\.service$/m);
  assert.match(liveServiceUnit, /^After=.*coinpilot-upbit-rate\.service/m);
  assert.match(rateCoordinatorUnit, /^StateDirectory=coinpilot-rate$/m);
  assert.match(rateCoordinatorUnit, /^StateDirectoryMode=0700$/m);
  assert.ok(liveWritableRoots.map(value => path.resolve(value)).includes(path.resolve(rateStateDir)));
  assert.ok(coordinatorWritableRoots.map(value => path.resolve(value)).includes(path.resolve(rateStateDir)));
  assert.match(liveServiceUnit, /^ExecStartPre=\/usr\/bin\/node .*verifyNodeRuntime\.js$/m);
  assert.match(rateCoordinatorUnit, /^ExecStartPre=\/usr\/bin\/node .*verifyNodeRuntime\.js$/m);
});

test('LIVE environment example boots into the manual-only protected profile', () => {
  assert.equal(liveEnvironmentExample.match(/^DRY_RUN=(.+)$/m)?.[1], 'false');
  assert.equal(liveEnvironmentExample.match(/^DASHBOARD_LIVE_CREDENTIAL_SETUP_MODE=(.+)$/m)?.[1], 'true');
  assert.equal(liveEnvironmentExample.match(/^DASHBOARD_LIVE_MANUAL_PREPARE_ON_BOOT=(.+)$/m)?.[1], 'true');
  assert.equal(liveEnvironmentExample.match(/^DASHBOARD_LIVE_MANUAL_RISK_PROTECTION=(.+)$/m)?.[1], 'true');
  assert.equal(liveEnvironmentExample.match(/^DASHBOARD_START_TRADER_ON_BOOT=(.+)$/m)?.[1], 'false',
    'automatic trading must not start on boot for the manual LIVE profile');
  assert.equal(liveEnvironmentExample.match(/^DASHBOARD_HOST=(.+)$/m)?.[1], '127.0.0.1');
  assert.equal(liveEnvironmentExample.match(/^DASHBOARD_ALLOW_INSECURE=(.+)$/m)?.[1], 'false');
  assert.doesNotMatch(liveEnvironmentExample, /^UPBIT_(?:ACCESS|SECRET)_KEY=/m,
    'LIVE Upbit keys must come from the encrypted credential store, never the unit env file');
});
