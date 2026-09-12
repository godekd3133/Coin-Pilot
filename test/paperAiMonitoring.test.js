import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPaperAiMonitor } from '../src/ai/paperAiMonitoring.js';

function makeAnalysis(signalKey, price = 100) {
  return {
    coin: 'KRW-BTC',
    currentPrice: price,
    decision: {
      action: 'BUY',
      reason: 'synthetic paper AI signal',
      confidence: '0.8',
      signalStrength: { level: 'STRONG' },
      scores: { total: 82 },
      entrySignalKey: signalKey,
      details: {
        rebound: { reboundConfirmed: true, signalKey, rsi: 28, volumeRatio: 1.4 }
      }
    },
    technicalAnalysis: { indicators: { rsi: 28 } },
    candleFreshness: { valid: true, ageMs: 10_000 }
  };
}

test('paper AI monitoring은 명시적으로 켰을 때만 분석 callback과 격리 session을 연결한다', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-ai-'));
  const stateFile = path.join(outputDir, 'ai-monitoring.json');
  let callback = null;
  const trader = {
    setAnalysisCallback(next) { callback = next; }
  };
  const advisor = {
    async ask() {
      return {
        requestId: 'paper-ai-request',
        status: 'COMPLETED',
        results: [{
          provider: 'gpt',
          providerLabel: 'GPT / Codex',
          status: 'COMPLETED',
          latencyMs: 25,
          advice: { action: 'BUY', confidence: 70, horizon: '1분', rationale: 'synthetic', risks: [], invalidation: 'none' }
        }]
      };
    }
  };

  try {
    const disabled = createPaperAiMonitor({
      trader,
      config: { targetCoins: ['KRW-BTC'] },
      outputDir,
      env: { PAPER_AI_MONITORING: 'false' },
      advisor
    });
    assert.equal(disabled, null);
    assert.equal(callback, null);

    const monitor = createPaperAiMonitor({
      trader,
      config: { targetCoins: ['KRW-BTC'] },
      outputDir,
      env: {
        PAPER_AI_MONITORING: 'true',
        PAPER_AI_MONITORING_FILE: stateFile,
        PAPER_AI_PROVIDERS: 'gpt',
        PAPER_AI_EVALUATION_MINUTES: '1',
        PAPER_AI_COOLDOWN_SECONDS: '30'
      },
      advisor
    });

    assert.ok(monitor);
    assert.equal(typeof callback, 'function');
    assert.deepEqual(monitor.session.providers, ['gpt']);
    assert.deepEqual(monitor.session.eventTypes, ['REBOUND_CANDIDATE', 'BUY_SIGNAL', 'SELL_SIGNAL']);
    assert.deepEqual(monitor.session.autoConsultEventTypes, ['BUY_SIGNAL', 'SELL_SIGNAL']);
    assert.equal(monitor.session.evaluationMinutes, 1);

    await callback({
      timestamp: '2026-09-11T00:00:00.000Z',
      mode: 'DRY_RUN',
      analyses: [makeAnalysis('paper-ai-1')]
    });
    await new Promise(resolve => setImmediate(resolve));

    const snapshot = monitor.service.getSnapshot({ limit: 10 });
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.consultations.length, 1);
    assert.equal(snapshot.consultations[0].status, 'COMPLETED');

    const effectiveness = await monitor.stop();
    assert.equal(effectiveness.totalConsultations, 1);
    assert.equal(monitor.service.getSessions()[0].status, 'STOPPED');
    assert.ok(fs.existsSync(stateFile));
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('paper AI monitoring은 후보 event는 보존하되 확정 BUY/SELL만 자동 상담한다', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coinpilot-paper-ai-filter-'));
  const stateFile = path.join(outputDir, 'ai-monitoring.json');
  let callback = null;
  let calls = 0;
  const trader = { setAnalysisCallback(next) { callback = next; } };
  const advisor = {
    async ask() {
      calls += 1;
      return {
        requestId: `paper-ai-filter-${calls}`,
        status: 'COMPLETED',
        results: [{
          provider: 'gpt',
          status: 'COMPLETED',
          advice: { action: 'WAIT', confidence: 50, rationale: 'synthetic', risks: [], invalidation: 'none' }
        }]
      };
    }
  };

  try {
    const monitor = createPaperAiMonitor({
      trader,
      config: { targetCoins: ['KRW-BTC'] },
      outputDir,
      env: {
        PAPER_AI_MONITORING: 'true',
        PAPER_AI_MONITORING_FILE: stateFile,
        PAPER_AI_PROVIDERS: 'gpt',
        PAPER_AI_EVENTS: 'REBOUND_CANDIDATE,BUY_SIGNAL',
        PAPER_AI_COOLDOWN_SECONDS: '30'
      },
      advisor
    });

    const candidate = makeAnalysis('paper-ai-candidate');
    candidate.decision.action = 'HOLD';
    candidate.decision.details.rebound.available = true;
    candidate.decision.details.rebound.reboundConfirmed = false;
    candidate.decision.details.rebound.previousWasOversold = true;
    candidate.technicalAnalysis.indicators.rebound = {
      ...candidate.decision.details.rebound,
      available: true
    };
    candidate.technicalAnalysis.indicators.rebound.reboundConfirmed = false;
    candidate.technicalAnalysis.indicators.rebound.previousWasOversold = true;
    await callback({ timestamp: '2026-09-12T00:00:00.000Z', analyses: [candidate] });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(monitor.service.getSnapshot({ limit: 10 }).events.length, 1);
    assert.equal(monitor.service.getSnapshot({ limit: 10 }).consultations.length, 0);
    assert.equal(calls, 0);

    await callback({
      timestamp: '2026-09-12T00:00:30.000Z',
      analyses: [makeAnalysis('paper-ai-buy')]
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(monitor.service.getSnapshot({ limit: 10 }).consultations.length, 1);
    assert.equal(calls, 1);
    await monitor.stop();
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
