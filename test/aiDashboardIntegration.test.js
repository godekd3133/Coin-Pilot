import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import DashboardServer from '../src/api/dashboardServer.js';

function makeBuyAnalysis() {
  return {
    coin: 'KRW-BTC',
    currentPrice: 100,
    coinBalance: 0,
    decision: {
      action: 'BUY',
      reason: 'synthetic rebound',
      confidence: '0.80',
      signalStrength: { level: 'STRONG' },
      scores: { total: '82' },
      entrySignalKey: 'synthetic-candle-1',
      details: {
        rebound: {
          available: true,
          reboundConfirmed: true,
          signalKey: 'synthetic-candle-1',
          rsi: 28,
          rsiRecovery: 3,
          volumeRatio: 1.5,
          rejectionReasons: []
        }
      }
    },
    technicalAnalysis: {
      indicators: { rsi: '28.00', rebound: { reboundConfirmed: true, signalKey: 'synthetic-candle-1' } }
    },
    candleFreshness: { valid: true, ageMs: 10_000 }
  };
}

test('DashboardServer가 trader 분석 callback을 AI session/consultation까지 전달한다', async () => {
  const stateFile = path.join(os.tmpdir(), `coinpilot-ai-dashboard-${Date.now()}-${Math.random()}.json`);
  let analysisCallback = null;
  const trader = {
    config: {
      aiAdvisorEnabled: true,
      aiAdvisorTimeoutMs: 3_000,
      aiMonitoringFile: stateFile
    },
    isRunning: false,
    dryRun: true,
    newsMonitor: null,
    upbit: null,
    setAnalysisCallback(callback) { analysisCallback = callback; },
    setTradeCallback() {}
  };
  const server = new DashboardServer(trader, 0);

  // Avoid a real provider call while exercising the real DashboardServer seam.
  server.aiAdvisor.runner = async () => ({
    stdout: JSON.stringify({
      action: 'WAIT',
      confidence: 72,
      horizon: '1시간',
      rationale: 'synthetic integration advice',
      risks: ['synthetic risk'],
      invalidation: 'synthetic invalidation'
    })
  });
  server.aiAdvisor.preflightProviderStatus = false;
  server.monitoringSessions.advisor = server.aiAdvisor;

  try {
    const session = server.monitoringSessions.createSession({
      name: 'dashboard integration',
      providers: ['gpt'],
      eventTypes: ['BUY_SIGNAL'],
      autoConsult: true,
      cooldownSeconds: 30
    });
    assert.equal(typeof analysisCallback, 'function');

    await analysisCallback({
      type: 'monitoring-cycle',
      source: 'synthetic',
      timestamp: new Date().toISOString(),
      mode: 'DRY_RUN',
      krwBalance: 1_000_000,
      currentPositions: 0,
      analyses: [makeBuyAnalysis()]
    });
    await new Promise(resolve => setTimeout(resolve, 30));

    const snapshot = server.monitoringSessions.getSnapshot({ limit: 20 });
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].type, 'BUY_SIGNAL');
    assert.equal(snapshot.events[0].sessionIds.includes(session.id), true);
    assert.equal(snapshot.consultations.length, 1);
    assert.equal(snapshot.consultations[0].status, 'COMPLETED');
    assert.equal(snapshot.consultations[0].results[0].advice.action, 'WAIT');
  } finally {
    server.stop();
    if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  }
});
