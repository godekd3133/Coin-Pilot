import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MonitoringSessionService, { eventFromAnalysis, eventFromBundle } from '../src/ai/monitoringSessionService.js';

function makeAnalysis(signalKey, action = 'BUY') {
  return {
    coin: 'KRW-BTC',
    currentPrice: 100,
    coinBalance: 0,
    decision: {
      action,
      reason: action === 'BUY' ? '과매도 후 반등' : '위험 신호',
      confidence: '0.80',
      signalStrength: { level: 'STRONG' },
      scores: { total: '82' },
      entrySignalKey: signalKey,
      details: {
        rebound: {
          available: true,
          reboundConfirmed: true,
          signalKey,
          rsi: 28,
          rsiRecovery: 3,
          rejectionReasons: []
        }
      }
    },
    technicalAnalysis: {
      indicators: {
        rsi: '28.00',
        rebound: { available: true, reboundConfirmed: true, signalKey }
      }
    },
    candleFreshness: { valid: true, ageMs: 20_000 }
  };
}

test('장기 session은 이벤트 필터, cooldown, 자동 자문, 재시작 복원을 유지한다', async () => {
  const file = path.join(os.tmpdir(), `coinpilot-ai-session-${Date.now()}-${Math.random()}.json`);
  const updates = [];
  const advisorCalls = [];
  const advisor = {
    async ask(request) {
      advisorCalls.push(request);
      return {
        requestId: `request-${advisorCalls.length}`,
        status: 'COMPLETED',
        results: [{
          provider: 'gpt',
          status: 'COMPLETED',
          advice: {
            action: 'WAIT',
            confidence: 70,
            horizon: '1시간',
            rationale: '추가 확인 필요',
            risks: ['변동성'],
            invalidation: '반등 실패'
          }
        }]
      };
    }
  };

  try {
    const service = new MonitoringSessionService({ stateFile: file, advisor });
    service.setUpdateCallback(update => updates.push(update));
    const session = service.createSession({
      name: 'BTC 반등 감시',
      providers: ['gpt'],
      eventTypes: ['BUY_SIGNAL'],
      coins: ['BTC'],
      autoConsult: true,
      cooldownSeconds: 30
    });

    assert.equal(session.status, 'RUNNING');
    assert.deepEqual(session.coins, ['KRW-BTC']);
    assert.equal(session.autoConsult, true);

    await service.ingestCycle({
      timestamp: '2026-09-10T00:00:00.000Z',
      mode: 'DRY_RUN',
      krwBalance: 1_000_000,
      currentPositions: 0,
      analyses: [makeAnalysis('candle-1', 'BUY')]
    });
    await new Promise(resolve => setImmediate(resolve));

    let snapshot = service.getSnapshot({ limit: 20 });
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].type, 'BUY_SIGNAL');
    assert.equal(snapshot.consultations.length, 1);
    assert.equal(snapshot.consultations[0].status, 'COMPLETED');
    assert.equal(advisorCalls.length, 1);

    // 같은 signal key는 같은 cycle에서 다시 자문하지 않는다.
    await service.ingestCycle({ analyses: [makeAnalysis('candle-1', 'BUY')] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.getSnapshot({ limit: 20 }).events.length, 1);
    assert.equal(advisorCalls.length, 1);

    service.updateSessionStatus(session.id, 'PAUSED');
    await service.ingestCycle({ analyses: [makeAnalysis('candle-2', 'BUY')] });
    assert.equal(service.getSnapshot({ limit: 20 }).events.length, 2);
    assert.equal(service.findEvent(service.getSnapshot({ limit: 20 }).events[0].id).sessionIds.includes(session.id), false);

    service.updateSessionStatus(session.id, 'RUNNING');
    await service.ingestCycle({ analyses: [makeAnalysis('candle-3', 'BUY')] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(advisorCalls.length, 2);

    const reloaded = new MonitoringSessionService({ stateFile: file, advisor });
    const restored = reloaded.getSnapshot({ limit: 20 });
    assert.equal(restored.sessions.length, 1);
    assert.equal(restored.sessions[0].name, 'BTC 반등 감시');
    assert.equal(restored.sessions[0].status, 'RUNNING');
    assert.equal(restored.events.length, 3);
    assert.ok(updates.some(update => update.type === 'consultation'));
  } finally {
    for (const candidate of [file, `${file}.tmp-${process.pid}`]) {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
  }
});

test('종료된 session은 재개되지 않고 수동 자문은 session 없이도 가능하다', async () => {
  const file = path.join(os.tmpdir(), `coinpilot-ai-manual-${Date.now()}-${Math.random()}.json`);
  const advisor = {
    async ask() {
      return { requestId: 'manual-request', status: 'COMPLETED', results: [] };
    }
  };
  try {
    const service = new MonitoringSessionService({ stateFile: file, advisor });
    const session = service.createSession({ eventTypes: ['SELL_SIGNAL'], providers: ['claude'], autoConsult: false });
    service.updateSessionStatus(session.id, 'STOPPED');
    assert.throws(() => service.updateSessionStatus(session.id, 'RUNNING'), /종료된 session/);

    const event = service.addManualEvent({ type: 'SELL_SIGNAL', coin: 'KRW-ETH', action: 'SELL', reason: '수동 자문 테스트' });
    const consultation = await service.requestConsultation({ eventId: event.id, provider: 'claude' });
    assert.equal(consultation.status, 'COMPLETED');
    assert.equal(consultation.sessionId, null);
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
});

test('기존 리밸런싱 제안도 선택 가능한 monitoring event로 보존된다', () => {
  const event = eventFromBundle({
    sell: { coin: 'KRW-ETH', value: 100_000 },
    buy: { coin: 'KRW-BTC', currentPrice: 100 },
    totalScore: 88,
    summary: 'ETH 매도 → BTC 매수',
    rationale: 'RSI 과매수 → 반등 확인'
  }, '2026-09-10T00:00:00.000Z');

  assert.equal(event.type, 'BUNDLE_SUGGESTION');
  assert.equal(event.action, 'BUY');
  assert.equal(event.coin, 'KRW-BTC');
  assert.equal(event.snapshot.totalScore, 88);
});

test('필터에서 탈락한 반등 후보도 선택형 REBOUND_CANDIDATE event로 보존된다', () => {
  const analysis = makeAnalysis('candidate-rejected', 'HOLD');
  analysis.decision.details.rebound.reboundConfirmed = false;
  analysis.decision.details.rebound.previousWasOversold = true;
  analysis.decision.details.rebound.rejectionReasons = ['volume_confirmation_failed'];

  const event = eventFromAnalysis(analysis, '2026-09-11T00:00:00.000Z');

  assert.equal(event.type, 'REBOUND_CANDIDATE');
  assert.equal(event.action, 'WAIT');
  assert.deepEqual(event.snapshot.indicators.rebound.rejectionReasons, ['volume_confirmation_failed']);
});

test('실제 provider 자문은 미래 가격과 대조되어 effectiveness로 누적된다', async () => {
  const file = path.join(os.tmpdir(), `coinpilot-ai-effectiveness-${Date.now()}-${Math.random()}.json`);
  const advisor = {
    async ask() {
      return {
        requestId: 'effectiveness-request',
        status: 'COMPLETED',
        results: [{
          provider: 'gpt',
          providerLabel: 'GPT / Codex',
          status: 'COMPLETED',
          latencyMs: 120,
          advice: {
            action: 'BUY',
            confidence: 80,
            horizon: '5분',
            rationale: '반등 지속 예상',
            risks: [],
            invalidation: '저점 재이탈'
          }
        }],
        consensus: {
          provider: 'consensus',
          action: 'BUY',
          confidence: 80,
          providerCount: 1,
          conflict: false
        }
      };
    }
  };

  try {
    const service = new MonitoringSessionService({
      stateFile: file,
      advisor,
      defaultEvaluationMinutes: 5,
      evaluationNeutralBandPercent: 0.1,
      minimumEvaluationSamples: 1
    });
    service.createSession({
      name: 'effectiveness test',
      providers: ['gpt'],
      eventTypes: ['BUY_SIGNAL'],
      autoConsult: true,
      evaluationMinutes: 5
    });

    await service.ingestCycle({
      timestamp: '2026-09-11T00:00:00.000Z',
      analyses: [makeAnalysis('effectiveness-1', 'BUY')]
    });
    await new Promise(resolve => setImmediate(resolve));

    const future = makeAnalysis('effectiveness-2', 'BUY');
    future.currentPrice = 101;
    future.decision.action = 'HOLD';
    future.decision.details.rebound.reboundConfirmed = false;
    future.technicalAnalysis.indicators.rebound.reboundConfirmed = false;
    await service.ingestCycle({
      timestamp: '2026-09-11T00:05:01.000Z',
      analyses: [future]
    });
    await new Promise(resolve => setImmediate(resolve));

    const snapshot = service.getSnapshot({ limit: 20 });
    assert.equal(snapshot.consultations.length, 1);
    assert.equal(snapshot.consultations[0].evaluation.status, 'COMPLETED');
    assert.equal(snapshot.consultations[0].evaluation.verdicts[0].verdict, 'HIT');
    assert.equal(snapshot.consultations[0].evaluation.priceChangePercent, 1);

    const effectiveness = service.getEffectiveness();
    assert.equal(effectiveness.evaluatedConsultations, 1);
    assert.equal(effectiveness.providerStats.gpt.evaluated, 1);
    assert.equal(effectiveness.providerStats.gpt.hits, 1);
    assert.equal(effectiveness.providerStats.gpt.misses, 0);
    assert.equal(effectiveness.providerStats.gpt.hitRate, 1);
    assert.equal(effectiveness.providerStats.gpt.sufficientEvidence, true);
    assert.equal(effectiveness.providerStats.consensus, undefined);

    const reloaded = new MonitoringSessionService({
      stateFile: file,
      advisor,
      defaultEvaluationMinutes: 5,
      evaluationNeutralBandPercent: 0.1,
      minimumEvaluationSamples: 1
    });
    const restored = reloaded.getSnapshot({ limit: 20 });
    assert.equal(restored.consultations[0].evaluation.status, 'COMPLETED');
    assert.equal(restored.effectiveness.providerStats.gpt.hits, 1);
  } finally {
    for (const candidate of [file, `${file}.tmp-${process.pid}`]) {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
  }
});

test('신선하지 않은 snapshot은 AI가 WAIT해도 efficacy 표본에서 제외된다', async () => {
  const file = path.join(os.tmpdir(), `coinpilot-ai-stale-efficacy-${Date.now()}-${Math.random()}.json`);
  const advisor = {
    async ask() {
      return {
        requestId: 'stale-request',
        status: 'COMPLETED',
        results: [{
          provider: 'gpt',
          status: 'COMPLETED',
          advice: { action: 'WAIT', confidence: 90, rationale: 'stale input', risks: [], invalidation: 'refresh' }
        }]
      };
    }
  };

  try {
    const service = new MonitoringSessionService({ stateFile: file, advisor, defaultEvaluationMinutes: 5 });
    const event = service.addManualEvent({
      type: 'BUY_SIGNAL',
      action: 'BUY',
      coin: 'KRW-BTC',
      price: 100,
      timestamp: '2026-09-11T00:00:00.000Z',
      snapshot: { freshness: { valid: false, reason: 'stale_candle_snapshot' } }
    });
    const session = service.createSession({ providers: ['gpt'], eventTypes: ['BUY_SIGNAL'], autoConsult: false });

    await service.requestConsultation({ sessionId: session.id, eventId: event.id, provider: 'gpt' });
    const future = makeAnalysis('stale-future', 'HOLD');
    future.currentPrice = 101;
    future.decision.details.rebound.reboundConfirmed = false;
    future.technicalAnalysis.indicators.rebound.reboundConfirmed = false;
    await service.ingestCycle({ timestamp: '2026-09-11T00:05:01.000Z', analyses: [future] });

    const snapshot = service.getSnapshot({ limit: 20 });
    assert.equal(snapshot.consultations[0].evaluation.status, 'NOT_EVALUABLE');
    assert.match(snapshot.consultations[0].evaluation.reason, /신선|stale/i);
    assert.equal(service.getEffectiveness().evaluatedConsultations, 0);
  } finally {
    for (const candidate of [file, `${file}.tmp-${process.pid}`]) {
      if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
  }
});
