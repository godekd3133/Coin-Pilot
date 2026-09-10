import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AIAdvisorService,
  buildAdvisorPrompt,
  normalizeAdvice,
  parseAdviceResponse
} from '../src/ai/aiAdvisorService.js';

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
  const prompt = buildAdvisorPrompt({ event: { type: 'SELL_SIGNAL', coin: 'KRW-ETH' } });

  assert.equal(advice.action, 'WAIT');
  assert.equal(advice.confidence, 5);
  assert.match(prompt, /Return JSON only/);
});

test('실제 CLI runner는 argv prompt 뒤에 열린 stdin 때문에 timeout되지 않는다', async () => {
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
