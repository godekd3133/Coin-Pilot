import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
  verifyNodeRuntime
} from '../src/runtime/nodeRuntimeRequirement.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('supported Node runtime is limited to the fully validated maintained LTS line', () => {
  assert.equal(isSupportedNodeVersion('20.20.2'), false);
  assert.equal(isSupportedNodeVersion('22.12.0'), false);
  assert.equal(isSupportedNodeVersion('22.13.0'), false);
  assert.equal(isSupportedNodeVersion('22.23.3'), false);
  assert.equal(isSupportedNodeVersion('23.11.1'), false);
  assert.equal(isSupportedNodeVersion('24.0.0'), false);
  assert.equal(isSupportedNodeVersion('24.20.0'), false);
  assert.equal(isSupportedNodeVersion('24.21.0'), true);
  assert.equal(isSupportedNodeVersion('24.22.0'), true);
  assert.equal(isSupportedNodeVersion('25.9.0'), false);
  assert.equal(isSupportedNodeVersion('26.10.0'), false);
  assert.equal(isSupportedNodeVersion('not-a-version'), false);
});

test('runtime guard reports actionable minimum-version errors and remains testable', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.engines?.node, '^24.21.0');
  assert.equal(packageJson.scripts?.predev, packageJson.scripts?.prestart);
  assert.match(fs.readFileSync(path.join(repositoryRoot, 'src/index.js'), 'utf8'), /assertSupportedNodeVersion\(\)/);
  assert.equal(assertSupportedNodeVersion('24.21.0'), true);
  assert.throws(() => assertSupportedNodeVersion('20.20.2'), {
    code: 'COINPILOT_NODE_VERSION_UNSUPPORTED',
    supportedReleases: '24.21+ (24.x)',
    actualVersion: '20.20.2'
  });

  const messages = [];
  assert.equal(verifyNodeRuntime({
    version: '20.20.2',
    output: { log: message => messages.push(message), error: message => messages.push(message) }
  }), false);
  assert.match(messages[0], /supports Node\.js 24\.21\+ \(24\.x\)/);
});
