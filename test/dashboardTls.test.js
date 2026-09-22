import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveDashboardTls } from '../src/api/dashboardTls.js';
import DashboardServer from '../src/api/dashboardServer.js';

test('dashboard TLS is disabled by default and keeps the HTTP development path', () => {
  const resolved = resolveDashboardTls({}, '/tmp/coinpilot-tls-test');
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.configured, false);
  assert.equal(resolved.error, null);
  assert.equal(resolved.cert, null);
  assert.equal(resolved.key, null);
});

test('dashboard TLS fails closed when only one certificate path is configured', () => {
  const resolved = resolveDashboardTls({ DASHBOARD_TLS_CERT_FILE: 'cert.pem' }, '/tmp/coinpilot-tls-test');
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.configured, true);
  assert.match(resolved.error, /함께 설정/);
  assert.throws(
    () => new DashboardServer({}, 0, {
      env: { DASHBOARD_TLS_CERT_FILE: 'cert.pem', DASHBOARD_TLS_KEY_FILE: '' }
    }),
    /함께 설정/
  );
});

test('dashboard TLS fails closed when the configured files cannot be read', () => {
  const resolved = resolveDashboardTls({
    DASHBOARD_TLS_CERT_FILE: 'missing/cert.pem',
    DASHBOARD_TLS_KEY_FILE: 'missing/key.pem'
  }, '/tmp/coinpilot-tls-test');
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.configured, true);
  assert.match(resolved.error, /읽을 수 없습니다/);
  assert.equal(resolved.cert, null);
  assert.equal(resolved.key, null);
});

test('dashboard TLS resolves both relative files without exposing their contents', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-dashboard-tls-'));
  const certFile = path.join(root, 'cert.pem');
  const keyFile = path.join(root, 'key.pem');
  fs.writeFileSync(certFile, 'certificate-fixture', 'utf8');
  fs.writeFileSync(keyFile, 'key-fixture', 'utf8');

  try {
    const resolved = resolveDashboardTls({
      DASHBOARD_TLS_CERT_FILE: 'cert.pem',
      DASHBOARD_TLS_KEY_FILE: 'key.pem'
    }, root);
    assert.equal(resolved.enabled, true);
    assert.equal(resolved.error, null);
    assert.equal(resolved.certFile, certFile);
    assert.equal(resolved.keyFile, keyFile);
    assert.equal(resolved.cert.toString(), 'certificate-fixture');
    assert.equal(resolved.key.toString(), 'key-fixture');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
