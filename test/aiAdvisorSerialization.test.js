import test from 'node:test';
import assert from 'node:assert/strict';
import { AIAdvisorService } from '../src/ai/aiAdvisorService.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const EVENT = { type: 'BUY_SIGNAL', action: 'BUY', coin: 'KRW-BTC', price: 100, snapshot: { rsi: 28 } };

function advicePayload(action = 'WAIT', confidence = 50) {
  return JSON.stringify({ action, confidence, horizon: '1시간', rationale: 'fake', risks: [], invalidation: 'x' });
}

/**
 * 하나의 in-flight 카운터와 이벤트 로그를 공유하는 계측 runner.
 * consult와 probe 모두 같은 직렬화 lane을 통과하는지 검증한다.
 */
function createInstrumentedRunner({ consultDelayMs = 10, probeDelayMs = 5, consultGate = null, onConsultStart = null } = {}) {
  const state = { active: 0, maxActive: 0, events: [], calls: [] };
  const runner = async (provider, prompt, opts = {}) => {
    const kind = opts.statusArgs ? 'probe' : 'consult';
    state.calls.push({ provider, kind, timeoutMs: opts.timeoutMs, statusArgs: opts.statusArgs || null });
    state.active += 1;
    state.maxActive = Math.max(state.maxActive, state.active);
    state.events.push(`${provider}:${kind}:start`);
    if (kind === 'consult') {
      onConsultStart?.(provider);
      if (consultGate) await consultGate;
      else await sleep(consultDelayMs);
    } else {
      await sleep(probeDelayMs);
    }
    state.active -= 1;
    state.events.push(`${provider}:${kind}:end`);
    if (kind === 'probe') return { stdout: JSON.stringify({ loggedIn: true }), stderr: '' };
    return { stdout: advicePayload(provider === 'gpt' ? 'BUY' : 'WAIT', 70) };
  };
  return { runner, state };
}

test('동시 ask() 호출들도 provider 실행을 절대 겹치지 않는다', async () => {
  const { runner, state } = createInstrumentedRunner({ consultDelayMs: 15 });
  const service = new AIAdvisorService({ runner });

  const [first, second] = await Promise.all([
    service.ask({ provider: 'both', event: EVENT }),
    service.ask({ provider: 'both', event: { ...EVENT, coin: 'KRW-ETH' } })
  ]);

  assert.equal(state.maxActive, 1);
  assert.equal(state.calls.filter(call => call.kind === 'consult').length, 4);
  assert.equal(first.status, 'COMPLETED');
  assert.equal(second.status, 'COMPLETED');
  // 요청마다 provider 결과가 분리되어 유지된다
  assert.deepEqual(first.results.map(result => result.provider), ['gpt', 'claude']);
  assert.deepEqual(second.results.map(result => result.provider), ['gpt', 'claude']);
});

test('status probe는 진행 중인 consult와 겹칠 수 없고 probe끼리도 순차 실행된다', async () => {
  let releaseConsult;
  let markConsultStarted;
  const consultGate = new Promise(resolve => { releaseConsult = resolve; });
  const consultStarted = new Promise(resolve => { markConsultStarted = resolve; });
  const { runner, state } = createInstrumentedRunner({ consultGate, onConsultStart: markConsultStarted });
  const service = new AIAdvisorService({ runner });
  // status probe는 runner 주입 여부와 무관하게 runProvider 경로를 타므로 동일 계측 함수를 붙인다
  service.runProvider = runner;

  const askPromise = service.ask({ provider: 'gpt', event: EVENT });
  await consultStarted;

  const statusPromise = service.getProviderStatus({ force: true });
  await sleep(40);

  // consult가 끝나기 전까지 어떤 probe도 시작하지 못한다
  assert.equal(state.maxActive, 1);
  assert.equal(state.calls.filter(call => call.kind === 'probe').length, 0);

  releaseConsult();
  const [askResult, status] = await Promise.all([askPromise, statusPromise]);

  assert.equal(state.maxActive, 1);
  assert.deepEqual(state.events, [
    'gpt:consult:start', 'gpt:consult:end',
    'gpt:probe:start', 'gpt:probe:end',
    'claude:probe:start', 'claude:probe:end'
  ]);
  assert.equal(askResult.status, 'COMPLETED');
  assert.deepEqual(status.providers.map(item => item.id), ['gpt', 'claude']);
  assert.ok(status.providers.every(item => item.status === 'READY'));

  // probe timeout 상한(8s)과 provider별 statusArgs가 유지된다
  const probeCalls = state.calls.filter(call => call.kind === 'probe');
  assert.deepEqual(probeCalls.map(call => call.statusArgs), [['login', 'status'], ['auth', 'status']]);
  assert.ok(probeCalls.every(call => call.timeoutMs === Math.min(service.timeoutMs, 8_000)));

  // status cache TTL이 유지된다: 캐시 유효 기간 내 재조회는 probe를 다시 실행하지 않는다
  const cached = await service.getProviderStatus();
  assert.equal(cached, status);
  assert.equal(state.calls.filter(call => call.kind === 'probe').length, 2);
});

test('느린 provider(40s 초기화 시나리오)가 다른 provider 결과를 굶기거나 깨뜨리지 않는다', async () => {
  const order = [];
  const startedAt = Date.now();
  const service = new AIAdvisorService({
    runner: async provider => {
      order.push(`${provider}:start`);
      if (provider === 'gpt') await sleep(150); // Codex init 지연 시뮬레이션
      else await sleep(5);
      order.push(`${provider}:end`);
      return { stdout: advicePayload(provider === 'gpt' ? 'BUY' : 'WAIT', provider === 'gpt' ? 80 : 60) };
    }
  });

  const result = await service.ask({ provider: 'both', event: EVENT });

  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(order, ['gpt:start', 'gpt:end', 'claude:start', 'claude:end']);
  assert.ok(Date.now() - startedAt >= 140);
  // provider별 결과가 격리된다
  assert.equal(result.results.find(item => item.provider === 'gpt').advice.action, 'BUY');
  assert.equal(result.results.find(item => item.provider === 'claude').advice.action, 'WAIT');
  assert.equal(result.consensus.conflict, true);
  assert.equal(result.consensus.quorum, false);
});

test('느린 provider의 실패는 그 provider의 결과/cooldown에만 격리된다', async () => {
  const service = new AIAdvisorService({
    runner: async provider => {
      if (provider === 'gpt') {
        await sleep(80);
        const error = new Error('synthetic timeout');
        error.code = 'AI_TIMEOUT';
        throw error;
      }
      await sleep(5);
      return { stdout: advicePayload('HOLD', 65) };
    }
  });

  const result = await service.ask({ provider: 'both', event: EVENT });

  assert.equal(result.status, 'COMPLETED');
  const gpt = result.results.find(item => item.provider === 'gpt');
  const claude = result.results.find(item => item.provider === 'claude');
  assert.equal(gpt.status, 'FAILED');
  assert.equal(gpt.errorCode, 'AI_TIMEOUT');
  assert.equal(claude.status, 'COMPLETED');
  assert.equal(claude.advice.action, 'HOLD');
  // cooldown은 실패한 provider에만 기록된다
  assert.ok(service.getProviderCooldownRemaining('gpt') > 0);
  assert.equal(service.getProviderCooldownRemaining('claude'), 0);
});

test('실행 lane의 rejection이 후속 provider 실행을 오염시키지 않는다', async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const service = new AIAdvisorService({
    providerFailureCooldownMs: 0, // cooldown이 아니라 queue 회복 자체를 검증한다
    runner: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(5);
      active -= 1;
      if (calls === 1) {
        const error = new Error('synchronous lane failure');
        error.code = 'AI_PROVIDER_ERROR';
        throw error;
      }
      return { stdout: advicePayload('WAIT', 40) };
    }
  });

  const first = await service.ask({ provider: 'gpt', event: EVENT });
  const second = await service.ask({ provider: 'gpt', event: EVENT });

  assert.equal(first.results[0].status, 'FAILED');
  assert.equal(first.results[0].errorCode, 'AI_PROVIDER_ERROR');
  assert.equal(second.results[0].status, 'COMPLETED');
  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
});

test('기본 timeout은 60s이며 options/env로만 재정의된다', async () => {
  const runner = async () => ({ stdout: advicePayload() });
  const savedEnv = process.env.AI_ADVISOR_TIMEOUT_MS;
  try {
    delete process.env.AI_ADVISOR_TIMEOUT_MS;
    assert.equal(new AIAdvisorService({ runner }).timeoutMs, 60_000);
    assert.equal(new AIAdvisorService({ runner, timeoutMs: 45_000 }).timeoutMs, 45_000);
    assert.equal(new AIAdvisorService({ runner, config: { aiAdvisorTimeoutMs: 33_000 } }).timeoutMs, 33_000);
    // 하한 clamp 유지
    assert.equal(new AIAdvisorService({ runner, timeoutMs: 1_000 }).timeoutMs, 3_000);

    process.env.AI_ADVISOR_TIMEOUT_MS = '25000';
    assert.equal(new AIAdvisorService({ runner }).timeoutMs, 25_000);
    // 명시적 option이 env보다 우선한다
    assert.equal(new AIAdvisorService({ runner, timeoutMs: 9_000 }).timeoutMs, 9_000);
  } finally {
    if (savedEnv === undefined) delete process.env.AI_ADVISOR_TIMEOUT_MS;
    else process.env.AI_ADVISOR_TIMEOUT_MS = savedEnv;
  }

  // 해석된 timeout이 실제 runner 호출 옵션으로 전달된다
  const seen = [];
  const service = new AIAdvisorService({ runner: async (provider, prompt, opts) => { seen.push(opts.timeoutMs); return { stdout: advicePayload() }; } });
  await service.ask({ provider: 'claude', event: EVENT });
  assert.deepEqual(seen, [60_000]);
});
