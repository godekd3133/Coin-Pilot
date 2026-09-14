import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectMomentumShadowCandidate } from '../research/momentumShadowCandidatePreflight.js';
import { resolveMomentumShadowCandidateConfig } from '../research/momentumShadowCandidateConfig.js';

const csv = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

const targetDir = process.env.MOMO_SHADOW_CANDIDATE_DIR || '.paper-momentum-shadow-btc-gate-v2';
const benchmarkDir = process.env.MOMO_SHADOW_BENCHMARK_DIR || '.paper-momentum-shadow-btc-gate-v1';
const ownerDirs = csv(process.env.MOMO_SHADOW_OWNER_DIRS || [
  '.paper-momentum-shadow-v1',
  '.paper-momentum-shadow-regime',
  benchmarkDir
].join(','));
const candidateConfig = resolveMomentumShadowCandidateConfig();

const readiness = inspectMomentumShadowCandidate({
  targetDir,
  benchmarkDir,
  ownerDirs,
  expectedConfig: candidateConfig,
  requireBenchmarkOpen: process.env.MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN !== 'false',
  minimumPollMs: Number.isFinite(Number(process.env.MOMO_SHADOW_MIN_POLL_MS))
    ? Number(process.env.MOMO_SHADOW_MIN_POLL_MS)
    : 15 * 60 * 1000
});

console.log(JSON.stringify({ ...readiness, startAttempt: true, readOnly: false }, null, 2));

if (!readiness.launchAllowed) {
  console.error(`candidate launch refused: ${readiness.blockers.join(', ')}`);
  process.exitCode = 2;
} else if (process.env.MOMO_SHADOW_ALLOW_START !== 'true') {
  console.error('candidate launch refused: MOMO_SHADOW_ALLOW_START=true is required');
  process.exitCode = 3;
} else {
  const runnerPath = path.resolve('src/scripts/runRegimeMomentumShadow.js');
  const child = spawn(process.execPath, [runnerPath], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      MOMO_SHADOW_DIR: path.resolve(targetDir),
      MOMO_SHADOW_MODE: candidateConfig.mode,
      MOMO_SHADOW_MARKETS: candidateConfig.markets.join(','),
      MOMO_SHADOW_TREND_MIN_PERCENT: String(candidateConfig.trendMinPercent),
      MOMO_SHADOW_BREADTH_MIN: String(candidateConfig.breadthMin),
      MOMO_SHADOW_MIN_UP_BARS: String(candidateConfig.minUpBars),
      MOMO_SHADOW_POSITION_FRACTION: String(candidateConfig.positionFraction),
      MOMO_SHADOW_MAX_POSITIONS: String(candidateConfig.maxPositions),
      MOMO_SHADOW_BENCHMARK_MARKET: candidateConfig.benchmarkMarket,
      MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT: String(candidateConfig.benchmarkTrendMinPercent),
      MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF: String(candidateConfig.exitOnBenchmarkOff),
      MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS: String(candidateConfig.cooldownAfterLossDays),
      MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT: String(candidateConfig.maxPortfolioDrawdownPercent),
      MOMO_SHADOW_POLL_MS: String(candidateConfig.pollMs)
    }
  });
  child.unref();
  console.log(JSON.stringify({ started: true, ownerPid: child.pid, targetDir: path.resolve(targetDir) }));
}
