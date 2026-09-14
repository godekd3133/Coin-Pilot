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
const expectedConfig = resolveMomentumShadowCandidateConfig();

const result = inspectMomentumShadowCandidate({
  targetDir,
  benchmarkDir,
  ownerDirs,
  expectedConfig,
  requireBenchmarkOpen: process.env.MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN !== 'false',
  minimumPollMs: Number.isFinite(Number(process.env.MOMO_SHADOW_MIN_POLL_MS))
    ? Number(process.env.MOMO_SHADOW_MIN_POLL_MS)
    : 15 * 60 * 1000
});

console.log(JSON.stringify(result, null, 2));
if (!result.launchAllowed) process.exitCode = 2;
