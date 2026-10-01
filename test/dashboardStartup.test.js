import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import DashboardServer from '../src/api/dashboardServer.js';
import { runAfterDashboardReady } from '../src/runtime/dashboardStartup.js';

class TemporaryDashboardServer extends DashboardServer {
  getOptimizationStateFile() {
    return path.join(this.logger.logDir, 'optimization_state.json');
  }
}

function makeDashboard(port, directory) {
  return new TemporaryDashboardServer({}, port, {
    env: {
      ...process.env,
      DASHBOARD_TOKEN: '', DASHBOARD_READ_ONLY_TOKEN: '', DASHBOARD_MOBILE_TOKEN: '',
      DASHBOARD_HOST: '127.0.0.1',
      DASHBOARD_ALLOW_INSECURE: '',
      DASHBOARD_TLS_CERT_FILE: '',
      DASHBOARD_TLS_KEY_FILE: '',
      STAGING_OUTPUT_DIR: directory
    }
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

test('dashboard bind failure rejects before runtime loops or trader start', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-dashboard-startup-'));
  const occupiedPortServer = net.createServer();
  await listen(occupiedPortServer);

  const dashboard = makeDashboard(occupiedPortServer.address().port, directory);
  t.after(async () => {
    if (dashboard.io || dashboard.server) await dashboard.stop();
    await dashboard.logger.flush();
    await new Promise(resolve => occupiedPortServer.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const runtimeCalls = [];
  await assert.rejects(
    runAfterDashboardReady(dashboard, async () => {
      runtimeCalls.push('background-loops');
      runtimeCalls.push('trader-start');
    }),
    error => error.code === 'EADDRINUSE'
  );

  assert.deepEqual(runtimeCalls, []);
  assert.equal(occupiedPortServer.listening, true);
  assert.equal(dashboard.server, null);
});

test('runtime initialization follows dashboard listening on success', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-dashboard-startup-'));
  const dashboard = makeDashboard(0, directory);
  const startupOrder = [];
  t.after(async () => {
    if (dashboard.io || dashboard.server) await dashboard.stop();
    await dashboard.logger.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const result = await runAfterDashboardReady(dashboard, async () => {
    assert.equal(dashboard.server?.listening, true);
    startupOrder.push('background-loops');
    startupOrder.push('trader-start');
    return 'started';
  });

  assert.equal(result, 'started');
  assert.deepEqual(startupOrder, ['background-loops', 'trader-start']);
});

test('dashboard-disabled startup runs runtime initialization immediately', async () => {
  const startupOrder = [];
  const result = await runAfterDashboardReady(null, async () => {
    startupOrder.push('runtime');
    return 'started';
  });

  assert.equal(result, 'started');
  assert.deepEqual(startupOrder, ['runtime']);
});
