import dotenv from 'dotenv';
import AIAdvisorService from '../ai/aiAdvisorService.js';

dotenv.config();

const requireProvider = process.argv.includes('--require-provider');
const providerSelection = process.env.AI_SMOKE_PROVIDERS || 'both';
const advisor = new AIAdvisorService({
  timeoutMs: Number(process.env.AI_ADVISOR_TIMEOUT_MS) || 30_000
});

const event = {
  id: 'synthetic-efficacy-smoke',
  type: 'BUY_SIGNAL',
  action: 'BUY',
  coin: 'KRW-BTC',
  price: 100_000_000,
  reason: 'synthetic oversold rebound fixture; never real market data',
  snapshot: {
    indicators: {
      rsi: 28.4,
      previousRsi: 24.1,
      rsiRecovery: 4.3,
      volumeRatio: 1.7,
      closeStrength: 0.82
    },
    freshness: { valid: true, ageSeconds: 18 },
    marketRegime: { confirmed: true, breadth: 0.62, averageReturnPercent: 0.14 }
  }
};

const startedAt = Date.now();
const providerStatus = await advisor.getProviderStatus({ force: true });
const consultation = await advisor.ask({
  provider: providerSelection,
  event,
  context: { mode: 'DRY_RUN', source: 'synthetic_fixture' },
  session: { name: 'AI efficacy smoke', horizon: 'short-term' }
});

const actualProviderCompleted = consultation.results?.some(result =>
  result.status === 'COMPLETED' && result.provider !== 'local-brief'
);

console.log(JSON.stringify({
  synthetic: true,
  checkedAt: new Date().toISOString(),
  elapsedMs: Date.now() - startedAt,
  providerSelection,
  effectiveAiResponse: actualProviderCompleted === true,
  consultationStatus: consultation.status,
  consensus: consultation.consensus
    ? {
        action: consultation.consensus.action,
        confidence: consultation.consensus.confidence,
        providerCount: consultation.consensus.providerCount,
        quorum: consultation.consensus.quorum === true,
        singleProvider: consultation.consensus.singleProvider === true,
        conflict: consultation.consensus.conflict === true
      }
    : null,
  providers: providerStatus.providers?.map(provider => ({
    id: provider.id,
    status: provider.status,
    ready: provider.ready,
    detail: provider.detail
  })),
  results: consultation.results?.map(result => ({
    provider: result.provider,
    status: result.status,
    errorCode: result.errorCode || null,
    latencyMs: result.latencyMs || 0,
    action: result.advice?.action || null,
    confidence: result.advice?.confidence ?? null,
    mode: result.advice?.mode || null,
    rationale: result.advice?.rationale || result.error || null
  }))
}, null, 2));

if (requireProvider && !actualProviderCompleted) process.exitCode = 2;
