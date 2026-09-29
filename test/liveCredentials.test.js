import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import DashboardServer from '../src/api/dashboardServer.js';
import { LiveCredentialStore } from '../src/api/liveCredentialStore.js';

const FAKE_ACCESS_KEY = 'fake-access-key-for-tests';
const FAKE_SECRET_KEY = 'fake-secret-key-for-tests';

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-live-credentials-'));
}

function assertOwnerOnly(filePath, expectedType) {
  const stat = fs.statSync(filePath);
  assert.equal(expectedType === 'directory' ? stat.isDirectory() : stat.isFile(), true);
  assert.equal(stat.mode & 0o077, 0);
}

function makeTrader({ dryRun = false } = {}) {
  return {
    dryRun,
    isRunning: false,
    liveManualPrepared: true,
    strategyMode: 'oversold_reaction_scalping',
    maxPositions: 1,
    isScalpingMode: false,
    targetCoins: ['KRW-BTC'],
    config: { targetCoin: 'KRW-BTC' },
    getRuntimeSafetyStatus() { return {}; },
    getLossCircuitBreakerStatus() { return null; }
  };
}

function noOpLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

async function startServer({ directoryPath, dryRun = false, setupMode = true } = {}) {
  const store = new LiveCredentialStore({ directoryPath });
  let validated = 0;
  let applied = 0;
  const dashboard = new DashboardServer(makeTrader({ dryRun }), 0, {
    env: {
      DASHBOARD_TOKEN: 'full-operator-test-token',
      DASHBOARD_MOBILE_TOKEN: 'mobile-operator-test-token',
      DASHBOARD_READ_ONLY_TOKEN: '',
      DASHBOARD_HOST: '',
      DASHBOARD_ALLOW_INSECURE: ''
    },
    logger: noOpLogger(),
    manualOrderIdempotencyStore: { async initialize() {}, releaseWriterLock() {} },
    liveCredentialSetupMode: setupMode,
    liveCredentialStore: store,
    validateLiveCredentials: async credentials => {
      validated++;
      return credentials.accessKey === FAKE_ACCESS_KEY && credentials.secretKey === FAKE_SECRET_KEY;
    },
    onLiveCredentialsSaved: async credentials => {
      assert.deepEqual(credentials, { accessKey: FAKE_ACCESS_KEY, secretKey: FAKE_SECRET_KEY });
      applied++;
    }
  });
  await dashboard.start();
  const address = dashboard.httpServer.address();
  return {
    dashboard,
    store,
    counters: () => ({ validated, applied }),
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function stopServer(ctx) {
  const closed = ctx.dashboard.httpServer.listening
    ? once(ctx.dashboard.httpServer, 'close')
    : Promise.resolve();
  await ctx.dashboard.stop();
  await closed;
}

function credentialRequest(baseUrl, { token = 'mobile-operator-test-token', forwardedProto, body } = {}) {
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json'
  };
  if (forwardedProto) headers['x-forwarded-proto'] = forwardedProto;
  return fetch(`${baseUrl}/api/live/credentials`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || { accessKey: FAKE_ACCESS_KEY, secretKey: FAKE_SECRET_KEY })
  });
}

test('LiveCredentialStore validates before saving, encrypts at rest, and restricts file permissions', async t => {
  const directoryPath = tempDirectory();
  t.after(() => fs.rmSync(directoryPath, { recursive: true, force: true }));

  const store = new LiveCredentialStore({ directoryPath: path.join(directoryPath, 'live') });
  let validationCount = 0;
  store.setCredentialValidator(async credentials => {
    validationCount++;
    assert.equal(store.status(), false, 'credentials must not be written before validation');
    return credentials.accessKey === FAKE_ACCESS_KEY && credentials.secretKey === FAKE_SECRET_KEY;
  });

  assert.equal(store.status(), false);
  await assert.rejects(
    store.save({ accessKey: FAKE_ACCESS_KEY, secretKey: 'invalid-fake-secret' }),
    error => error.code === 'LIVE_CREDENTIALS_REJECTED'
  );
  assert.equal(store.status(), false);

  assert.equal(await store.save({ accessKey: FAKE_ACCESS_KEY, secretKey: FAKE_SECRET_KEY }), true);
  assert.equal(validationCount, 2);
  assert.deepEqual(store.load(), { accessKey: FAKE_ACCESS_KEY, secretKey: FAKE_SECRET_KEY });
  assertOwnerOnly(store.directoryPath, 'directory');
  assertOwnerOnly(store.keyPath, 'file');
  assertOwnerOnly(store.credentialsPath, 'file');
  const encrypted = fs.readFileSync(store.credentialsPath, 'utf8');
  assert.equal(encrypted.includes(FAKE_ACCESS_KEY), false);
  assert.equal(encrypted.includes(FAKE_SECRET_KEY), false);
});

test('LiveCredentialStore rejects missing validation and does not create credential files', async t => {
  const directoryPath = tempDirectory();
  t.after(() => fs.rmSync(directoryPath, { recursive: true, force: true }));
  const store = new LiveCredentialStore({ directoryPath: path.join(directoryPath, 'not-created') });

  await assert.rejects(
    store.save({ accessKey: FAKE_ACCESS_KEY, secretKey: FAKE_SECRET_KEY }),
    error => error.code === 'LIVE_CREDENTIALS_VALIDATION_UNAVAILABLE'
  );
  assert.equal(store.status(), false);
  assert.equal(fs.existsSync(store.directoryPath), false);
});

test('mobile credential enrollment requires LIVE setup, HTTPS through a loopback proxy, and never returns keys', async t => {
  const directoryPath = tempDirectory();
  t.after(() => fs.rmSync(directoryPath, { recursive: true, force: true }));
  const ctx = await startServer({ directoryPath: path.join(directoryPath, 'live') });
  t.after(() => stopServer(ctx));

  const insecure = await credentialRequest(ctx.baseUrl);
  assert.equal(insecure.status, 426);
  assert.equal(ctx.counters().validated, 0);

  const untrustedPeerHeader = await credentialRequest(ctx.baseUrl, { forwardedProto: 'http' });
  assert.equal(untrustedPeerHeader.status, 426);
  assert.equal(ctx.counters().validated, 0);

  const extraField = await credentialRequest(ctx.baseUrl, {
    forwardedProto: 'https',
    body: { accessKey: FAKE_ACCESS_KEY, secretKey: FAKE_SECRET_KEY, extra: 'not-allowed' }
  });
  assert.equal(extraField.status, 403);
  assert.equal(ctx.counters().validated, 0);

  const fullOperator = await credentialRequest(ctx.baseUrl, {
    token: 'full-operator-test-token',
    forwardedProto: 'https'
  });
  assert.equal(fullOperator.status, 403);
  assert.equal(ctx.counters().validated, 0);

  ctx.dashboard.tradingSystem.dryRun = true;
  const paperServer = await credentialRequest(ctx.baseUrl, { forwardedProto: 'https' });
  assert.equal(paperServer.status, 409);
  ctx.dashboard.tradingSystem.dryRun = false;

  ctx.dashboard.tradingSystem.isRunning = true;
  const runningServer = await credentialRequest(ctx.baseUrl, { forwardedProto: 'https' });
  assert.equal(runningServer.status, 409);
  ctx.dashboard.tradingSystem.isRunning = false;

  ctx.dashboard.liveCredentialSetupMode = false;
  const nonSetupServer = await credentialRequest(ctx.baseUrl, { forwardedProto: 'https' });
  assert.equal(nonSetupServer.status, 409);
  ctx.dashboard.liveCredentialSetupMode = true;

  const accepted = await credentialRequest(ctx.baseUrl, { forwardedProto: 'https' });
  assert.equal(accepted.status, 200);
  const response = await accepted.json();
  assert.deepEqual(response, { success: true, upbitCredentialsConfigured: true });
  assert.equal(JSON.stringify(response).includes(FAKE_ACCESS_KEY), false);
  assert.equal(JSON.stringify(response).includes(FAKE_SECRET_KEY), false);
  assert.deepEqual(ctx.counters(), { validated: 1, applied: 1 });
  assert.deepEqual(ctx.store.load(), { accessKey: FAKE_ACCESS_KEY, secretKey: FAKE_SECRET_KEY });

  const duplicateEnrollment = await credentialRequest(ctx.baseUrl, { forwardedProto: 'https' });
  assert.equal(duplicateEnrollment.status, 409);
  assert.deepEqual(ctx.counters(), { validated: 1, applied: 1 });

  const statusResponse = await fetch(`${ctx.baseUrl}/api/status`, {
    headers: { authorization: 'Bearer mobile-operator-test-token' }
  });
  assert.equal(statusResponse.status, 200);
  const status = await statusResponse.json();
  assert.equal(status.upbitCredentialsConfigured, true);
  assert.equal(status.liveManualPrepared, true);
  assert.equal(JSON.stringify(status).includes(FAKE_ACCESS_KEY), false);
  assert.equal(JSON.stringify(status).includes(FAKE_SECRET_KEY), false);
});
