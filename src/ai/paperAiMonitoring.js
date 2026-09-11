import path from 'node:path';
import AIAdvisorService from './aiAdvisorService.js';
import MonitoringSessionService from './monitoringSessionService.js';

function numericEnv(env, key, fallback) {
  const value = Number(env?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function listEnv(env, key, fallback) {
  const value = env?.[key];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return value.split(',').map(item => item.trim()).filter(Boolean);
  return fallback;
}

/**
 * Attach an opt-in AI monitoring session to a paper trader's read-only
 * analysis callback. The default paper smoke path remains unchanged; the
 * caller must explicitly set PAPER_AI_MONITORING=true.
 */
export function createPaperAiMonitor({
  trader,
  config = {},
  outputDir = process.cwd(),
  env = process.env,
  advisor = null
} = {}) {
  if (env?.PAPER_AI_MONITORING !== 'true') return null;
  if (typeof trader?.setAnalysisCallback !== 'function') {
    throw new Error('paper AI monitoring에는 trader analysis callback이 필요합니다.');
  }

  const stateFile = path.resolve(
    env.PAPER_AI_MONITORING_FILE || path.join(outputDir, 'ai_monitoring_sessions.json')
  );
  const monitorConfig = {
    ...config,
    aiMonitoringFile: stateFile,
    aiEvaluationMinutes: numericEnv(env, 'PAPER_AI_EVALUATION_MINUTES', config.aiEvaluationMinutes ?? 5),
    aiEvaluationNeutralBandPercent: numericEnv(
      env,
      'PAPER_AI_EVALUATION_NEUTRAL_BAND_PERCENT',
      config.aiEvaluationNeutralBandPercent ?? 0.1
    ),
    aiEvaluationMinSamples: numericEnv(env, 'PAPER_AI_EVALUATION_MIN_SAMPLES', config.aiEvaluationMinSamples ?? 20)
  };
  const aiAdvisor = advisor || new AIAdvisorService({
    workspaceRoot: process.cwd(),
    config: monitorConfig
  });
  const service = new MonitoringSessionService({
    workspaceRoot: process.cwd(),
    stateFile,
    config: monitorConfig,
    advisor: aiAdvisor
  });
  const session = service.createSession({
    name: env.PAPER_AI_SESSION_NAME || 'Paper AI efficacy monitoring',
    providers: listEnv(env, 'PAPER_AI_PROVIDERS', ['gpt']),
    eventTypes: listEnv(env, 'PAPER_AI_EVENTS', ['BUY_SIGNAL', 'SELL_SIGNAL']),
    coins: listEnv(env, 'PAPER_AI_COINS', config.targetCoins || []),
    autoConsult: true,
    cooldownSeconds: numericEnv(env, 'PAPER_AI_COOLDOWN_SECONDS', 300),
    evaluationMinutes: numericEnv(env, 'PAPER_AI_EVALUATION_MINUTES', monitorConfig.aiEvaluationMinutes),
    horizon: env.PAPER_AI_HORIZON || 'short-term'
  });

  trader.setAnalysisCallback(cycle => service.ingestCycle(cycle));
  let stopped = false;
  return {
    advisor: aiAdvisor,
    service,
    session,
    stateFile,
    async stop() {
      if (!stopped) {
        const current = service.findSession(session.id);
        if (current && current.status !== 'STOPPED') service.updateSessionStatus(session.id, 'STOPPED');
        stopped = true;
      }
      const pendingDrain = await service.waitForPendingConsultations(
        numericEnv(env, 'PAPER_AI_STOP_WAIT_MS', 35_000)
      );
      const effectiveness = service.getEffectiveness({ sessionId: session.id });
      effectiveness.pendingDrain = pendingDrain;
      return effectiveness;
    }
  };
}

export default createPaperAiMonitor;
