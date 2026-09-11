import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIAdvisorService,
  aggregateAdvice,
  buildLocalEvidenceBrief,
  buildAdvisorPrompt,
  normalizeAdvice,
  parseAdviceResponse
} from '../src/ai/aiAdvisorService.js';
import { scoreAdviceOutcome } from '../src/ai/monitoringSessionService.js';

test('구독 CLI의 변동하는 초기 응답 시간을 감당하는 기본 timeout을 사용한다', () => {
  const service = new AIAdvisorService({ runner: async () => ({ stdout: '{}' }) });
  assert.equal(service.timeoutMs, 30_000);
});

test('provider envelope와 markdown 안의 JSON 판단을 안전하게 추출한다', () => {
  const raw = [
    JSON.stringify({ type: 'thread.started', thread_id: 'hidden' }),
    JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '```json\n{"action":"BUY","confidence":0.82,"rationale":"반등 확인","risks":["거래량 부족"],"invalidation":"저점 재이탈"}\n```'
      }
    })
  ].join('\n');

  const parsed = parseAdviceResponse(raw);
  assert.equal(parsed.action, 'BUY');
  assert.equal(parsed.confidence, 0.82);
  assert.equal(parsed.rationale, '반등 확인');
});

test('GPT와 Claude 자문은 주문 경로 없이 독립적으로 실행된다', async () => {
  const calls = [];
  const service = new AIAdvisorService({
    runner: async (provider, prompt) => {
      calls.push({ provider, prompt });
      return {
        stdout: JSON.stringify({
          action: provider === 'gpt' ? 'BUY' : 'WAIT',
          confidence: provider === 'gpt' ? 75 : 0.4,
          horizon: '1시간',
          rationale: `${provider}의 읽기 전용 의견`,
          risks: ['변동성'],
          invalidation: '신호 캔들 무효화'
        })
      };
    }
  });

  const result = await service.ask({
    provider: 'both',
    event: {
      id: 'event-1',
      type: 'BUY_SIGNAL',
      coin: 'KRW-BTC',
      price: 100,
      snapshot: { rsi: 28 }
    },
    context: { latestSnapshot: { mode: 'DRY_RUN' } }
  });

  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map(item => item.provider).sort(), ['claude', 'gpt']);
  assert.equal(result.results.find(item => item.provider === 'gpt').advice.action, 'BUY');
  assert.equal(result.results.find(item => item.provider === 'claude').advice.action, 'WAIT');
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.prompt, /read-only trading decision advisor/i);
    assert.match(call.prompt, /existing settings-based automation remains/i);
    assert.doesNotMatch(call.prompt, /API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY/);
  }
});

test('잘못된 provider 판단은 WAIT로 fail-closed 된다', () => {
  const advice = normalizeAdvice({ action: 'unexpected', confidence: 5, rationale: '불확실' }, { provider: 'gpt' });
  const prompt = buildAdvisorPrompt({
    event: { type: 'BUY_SIGNAL', action: 'BUY', coin: 'KRW-ETH', snapshot: { freshness: { valid: true }, indicators: { rebound: { reboundConfirmed: true } } } },
    context: { evaluation: { horizonMinutes: 5, neutralBandPercent: 0.3 } }
  });

  assert.equal(advice.action, 'WAIT');
  assert.equal(advice.confidence, 5);
  assert.match(prompt, /Return JSON only/);
  assert.match(prompt, /confirmed BUY/);
  assert.match(prompt, /transaction costs/i);
  assert.match(prompt, /WAIT only when/i);
});

test('실제 CLI runner는 열린 stdin 때문에 timeout되지 않는다', async () => {
  const service = new AIAdvisorService({
    executables: { claude: process.execPath },
    timeoutMs: 3_000
  });
  const result = await service.runProvider('claude', '', {
    timeoutMs: 3_000,
    statusArgs: ['-e', "process.stdin.resume();process.stdin.on('end',()=>console.log('STDIN_CLOSED'))"]
  });

  assert.match(result.stdout, /STDIN_CLOSED/);
});

test('장기 snapshot prompt는 argv 제한 대신 provider stdin으로 전달되고 종료된다', async () => {
  const service = new AIAdvisorService({
    executables: { claude: process.execPath },
    argumentBuilder: () => ['-e', "let data='';process.stdin.on('data',chunk=>data+=chunk);process.stdin.on('end',()=>process.stdout.write(data))"],
    timeoutMs: 3_000
  });
  const result = await service.runProvider('claude', 'LONG_SNAPSHOT_PROMPT', { timeoutMs: 3_000 });

  assert.equal(result.stdout, 'LONG_SNAPSHOT_PROMPT');
});

test('명백한 미로그인은 모델 호출 전에 즉시 PROVIDER_NOT_READY로 종료한다', async () => {
  let runnerCalled = false;
  const service = new AIAdvisorService({
    preflightProviderStatus: true,
    allowLocalBrief: false,
    runner: async () => {
      runnerCalled = true;
      throw new Error('runner must not be called');
    }
  });
  service.statusCache = {
    enabled: true,
    providers: [{
      id: 'claude',
      status: 'NOT_AUTHENTICATED',
      detail: 'Claude CLI 로그인이 필요합니다.'
    }]
  };
  service.statusCacheAt = Date.now();

  const result = await service.ask({
    provider: 'claude',
    event: { type: 'BUY_SIGNAL', coin: 'KRW-BTC' }
  });

  assert.equal(runnerCalled, false);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.results[0].errorCode, 'PROVIDER_NOT_READY');
  assert.match(result.results[0].error, /로그인/);
});

test('Codex 설정 파싱 오류도 반복적인 20초 timeout 대신 즉시 차단한다', async () => {
  let runnerCalled = false;
  const service = new AIAdvisorService({
    preflightProviderStatus: true,
    gptIgnoreUserConfig: false,
    runner: async () => {
      runnerCalled = true;
      throw new Error('runner must not be called');
    }
  });
  service.statusCache = {
    enabled: true,
    providers: [{
      id: 'gpt',
      status: 'CONFIG_ERROR',
      detail: 'Codex 사용자 설정을 읽지 못했습니다.',
      canAttemptWithoutUserConfig: false
    }]
  };
  service.statusCacheAt = Date.now();

  const result = await service.ask({
    provider: 'gpt',
    event: { type: 'SELL_SIGNAL', coin: 'KRW-ETH' }
  });

  assert.equal(runnerCalled, false);
  assert.equal(result.results[0].errorCode, 'PROVIDER_NOT_READY');
  assert.match(result.results[0].error, /Codex/);
});

test('Codex 사용자 설정 오류가 있어도 격리 실행 경로는 실제 provider 호출을 시도한다', async () => {
  let runnerCalled = false;
  const service = new AIAdvisorService({
    preflightProviderStatus: true,
    runner: async (provider) => {
      runnerCalled = provider === 'gpt';
      return {
        stdout: JSON.stringify({
          action: 'WAIT',
          confidence: 60,
          horizon: 'smoke',
          rationale: '격리 실행 provider 응답',
          risks: [],
          invalidation: 'snapshot 변경'
        })
      };
    }
  });
  service.statusCache = {
    enabled: true,
    providers: [{
      id: 'gpt',
      status: 'CONFIG_ERROR',
      ready: false,
      detail: 'Codex 사용자 설정을 읽지 못했습니다.',
      canAttemptWithoutUserConfig: true
    }]
  };
  service.statusCacheAt = Date.now();

  const result = await service.ask({
    provider: 'gpt',
    event: { type: 'BUY_SIGNAL', coin: 'KRW-BTC' }
  });

  assert.equal(runnerCalled, true);
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.results[0].status, 'COMPLETED');
  assert.equal(result.results[0].advice.action, 'WAIT');
  assert.equal(result.results[0].configWarning, true);
  assert.equal(service.statusCache.providers[0].status, 'READY_WITH_CONFIG_WARNING');
  assert.equal(service.statusCache.providers[0].ready, true);
});

test('provider가 모두 unavailable이면 AI 결과를 위조하지 않고 local evidence brief로 degraded 된다', async () => {
  const service = new AIAdvisorService({
    preflightProviderStatus: true,
    runner: async () => { throw new Error('runner must not be called'); }
  });
  service.statusCache = {
    enabled: true,
    providers: [
      { id: 'gpt', status: 'CONFIG_ERROR', detail: 'Codex 설정 오류' },
      { id: 'claude', status: 'NOT_AUTHENTICATED', detail: 'Claude 로그인 필요' }
    ]
  };
  service.statusCacheAt = Date.now();

  const result = await service.ask({
    provider: 'both',
    event: {
      type: 'BUY_SIGNAL',
      action: 'BUY',
      coin: 'KRW-BTC',
      snapshot: {
        indicators: { rsi: 28.4, volumeRatio: 1.7 },
        freshness: { valid: true },
        marketRegime: { confirmed: true }
      }
    }
  });

  const fallback = result.results.find(item => item.provider === 'local-brief');
  assert.equal(result.status, 'DEGRADED');
  assert.equal(fallback.status, 'FALLBACK');
  assert.equal(fallback.advice.mode, 'LOCAL_EVIDENCE_ONLY');
  assert.equal(fallback.advice.action, 'WAIT');
  assert.equal(fallback.advice.confidence, 0);
  assert.match(fallback.advice.rationale, /AI provider 응답이 없어/);
  assert.ok(fallback.advice.risks.length > 0);

  const directBrief = buildLocalEvidenceBrief({ coin: 'KRW-ETH', type: 'SELL_SIGNAL', action: 'SELL' }, []);
  assert.equal(directBrief.mode, 'LOCAL_EVIDENCE_ONLY');
  assert.equal(directBrief.action, 'WAIT');

  const nestedBrief = buildLocalEvidenceBrief({
    coin: 'KRW-XRP',
    type: 'BUY_SIGNAL',
    snapshot: {
      indicators: {
        rsi: 31,
        rebound: { volumeRatio: 1.9, closeStrength: 0.88, reboundConfirmed: true }
      }
    }
  });
  assert.match(nestedBrief.rationale, /거래량 배수 1\.90/);
  assert.match(nestedBrief.rationale, /종가 강도 0\.88/);
  assert.match(nestedBrief.rationale, /반등 확정/);
});

test('provider 의견이 충돌하면 consensus는 안전하게 WAIT가 된다', () => {
  const shared = { horizon: '1시간', confidence: 80, invalidation: '신호 무효화' };
  const agreement = aggregateAdvice([
    { provider: 'gpt', providerLabel: 'GPT', status: 'COMPLETED', advice: { ...shared, action: 'BUY' } },
    { provider: 'claude', providerLabel: 'Claude', status: 'COMPLETED', advice: { ...shared, action: 'BUY' } }
  ]);
  const conflict = aggregateAdvice([
    { provider: 'gpt', providerLabel: 'GPT', status: 'COMPLETED', advice: { ...shared, action: 'BUY' } },
    { provider: 'claude', providerLabel: 'Claude', status: 'COMPLETED', advice: { ...shared, action: 'SELL' } }
  ]);

  assert.equal(agreement.action, 'BUY');
  assert.equal(agreement.agreementRatio, 1);
  assert.equal(agreement.conflict, false);
  assert.equal(conflict.action, 'WAIT');
  assert.equal(conflict.agreementRatio, 0.5);
  assert.equal(conflict.conflict, true);
  assert.match(conflict.rationale, /일치하지 않습니다/);
});

test('단일 provider 의견은 두 provider 합의로 과장되지 않는다', () => {
  const single = aggregateAdvice([
    { provider: 'gpt', providerLabel: 'GPT', status: 'COMPLETED', advice: { action: 'BUY', confidence: 90 } }
  ]);

  assert.equal(single.action, 'BUY');
  assert.equal(single.providerCount, 1);
  assert.equal(single.quorum, false);
  assert.equal(single.singleProvider, true);
  assert.match(single.rationale, /단일 provider/);
});

test('WAIT veto는 원래 BUY/SELL 신호의 회피 효과를 별도로 판정한다', () => {
  const avoidedLoss = scoreAdviceOutcome({ action: 'WAIT', confidence: 90 }, -0.5, 0.1, 'BUY');
  const missedGain = scoreAdviceOutcome({ action: 'WAIT', confidence: 90 }, 0.5, 0.1, 'BUY');
  const flat = scoreAdviceOutcome({ action: 'WAIT', confidence: 90 }, 0.03, 0.1, 'BUY');

  assert.equal(avoidedLoss.verdict, 'ABSTAINED');
  assert.equal(avoidedLoss.vetoVerdict, 'VETO_GOOD');
  assert.equal(missedGain.vetoVerdict, 'VETO_MISSED_OPPORTUNITY');
  assert.equal(flat.vetoVerdict, 'VETO_FLAT');
  assert.equal(
    scoreAdviceOutcome({ action: 'WAIT', confidence: 90 }, 0.1035, undefined, 'BUY').vetoVerdict,
    'VETO_FLAT'
  );
});
