import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import MonitoringSessionService, { eventFromBundle } from '../src/ai/monitoringSessionService.js';

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
