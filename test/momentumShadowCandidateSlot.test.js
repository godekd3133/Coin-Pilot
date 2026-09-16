import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireMomentumShadowCandidateSlot,
  inspectMomentumShadowCandidateSlot,
  readMomentumShadowCandidateSlot,
  releaseMomentumShadowCandidateSlot
} from '../src/research/momentumShadowCandidateSlot.js';

test('candidate slot can be claimed, inspected, and released by its owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-candidate-slot-'));
  const file = path.join(root, 'candidate.lock');
  try {
    acquireMomentumShadowCandidateSlot({ file, pid: process.pid, dir: '/candidate' });
    const inspected = inspectMomentumShadowCandidateSlot(file);
    assert.equal(inspected.exists, true);
    assert.equal(inspected.valid, true);
    assert.equal(inspected.occupied, true);
    assert.equal(inspected.ownerPid, process.pid);
    assert.equal(inspected.ownerDir, '/candidate');
    assert.equal(releaseMomentumShadowCandidateSlot({ file, pid: process.pid }), true);
    assert.equal(readMomentumShadowCandidateSlot(file), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('candidate slot refuses a live owner and never overwrites malformed state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-candidate-slot-'));
  const liveFile = path.join(root, 'live.lock');
  const malformedFile = path.join(root, 'malformed.lock');
  try {
    fs.writeFileSync(liveFile, JSON.stringify({ pid: process.pid, dir: '/other' }));
    assert.throws(
      () => acquireMomentumShadowCandidateSlot({ file: liveFile, pid: 12345 }),
      /candidate slot held by live pid/
    );

    fs.writeFileSync(malformedFile, '{not-json');
    assert.equal(inspectMomentumShadowCandidateSlot(malformedFile).valid, false);
    assert.throws(
      () => acquireMomentumShadowCandidateSlot({ file: malformedFile, pid: process.pid }),
      /candidate slot is unverifiable/
    );
    assert.equal(fs.readFileSync(malformedFile, 'utf8'), '{not-json');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dead candidate slot is recoverable without deleting unrelated state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-candidate-slot-'));
  const file = path.join(root, 'stale.lock');
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, dir: '/stale' }));
    acquireMomentumShadowCandidateSlot({ file, pid: process.pid, dir: '/new' });
    const inspected = inspectMomentumShadowCandidateSlot(file);
    assert.equal(inspected.occupied, true);
    assert.equal(inspected.ownerPid, process.pid);
    assert.equal(inspected.ownerDir, '/new');
    releaseMomentumShadowCandidateSlot({ file, pid: process.pid });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
