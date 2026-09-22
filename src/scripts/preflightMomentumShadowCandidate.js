import { inspectMomentumShadowCandidate } from '../research/momentumShadowCandidatePreflight.js';
import {
  resolveMomentumShadowCandidateProfile
} from '../research/momentumShadowCandidateProfiles.js';
import { DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE } from '../research/momentumShadowCandidateSlot.js';

const csv = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

const benchmarkDir = process.env.MOMO_SHADOW_BENCHMARK_DIR || '.paper-momentum-shadow-btc-gate-v1';
const fixedHoldDir = process.env.MOMO_SHADOW_FIXED_HOLD_DIR || '.paper-momentum-shadow-fixed-hold-2d-v1';
const fixedHoldSpreadDir = process.env.MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR || '.paper-momentum-shadow-fixed-hold-2d-spread-v1';
const fixedHoldRelativeDir = process.env.MOMO_SHADOW_FIXED_HOLD_RELATIVE_DIR || '.paper-momentum-shadow-fixed-hold-2d-relative-v1';
let profileResolution;
try {
  profileResolution = resolveMomentumShadowCandidateProfile();
} catch (error) {
  console.error(`candidate preflight refused: ${error.message}`);
  process.exit(4);
}
const {
  candidateProfile,
  targetDir,
  candidateConfig,
  requireQuoteQuality,
  fixedHoldQuoteCrossDir,
  fixedHoldLossCapDir
} = profileResolution;
const ownerDirs = csv(process.env.MOMO_SHADOW_OWNER_DIRS || [
  '.paper-momentum-shadow-v1',
  '.paper-momentum-shadow-regime',
  benchmarkDir,
  process.env.MOMO_SHADOW_VOLATILITY_DIR || '.paper-momentum-shadow-vol-target-v1',
  process.env.MOMO_SHADOW_NEXT_OPEN_DIR || '.paper-momentum-shadow-next-open-v1',
  fixedHoldDir,
  fixedHoldSpreadDir,
  fixedHoldRelativeDir,
  fixedHoldQuoteCrossDir,
  fixedHoldLossCapDir
].join(','));
const candidateSlotFile = process.env.MOMO_SHADOW_CANDIDATE_SLOT_FILE || DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE;

const result = inspectMomentumShadowCandidate({
  targetDir,
  benchmarkDir,
  ownerDirs,
  expectedConfig: candidateConfig,
  requireBenchmarkOpen: process.env.MOMO_SHADOW_REQUIRE_BENCHMARK_OPEN !== 'false',
  requireQuoteQuality,
  quoteReportFile: process.env.MOMO_SHADOW_QUOTE_REPORT_FILE,
  quoteMaxAgeSeconds: Number.isFinite(Number(process.env.MOMO_SHADOW_QUOTE_MAX_AGE_SECONDS))
    ? Number(process.env.MOMO_SHADOW_QUOTE_MAX_AGE_SECONDS)
    : 15 * 60,
  candidateSlotFile,
  minimumPollMs: Number.isFinite(Number(process.env.MOMO_SHADOW_MIN_POLL_MS))
    ? Number(process.env.MOMO_SHADOW_MIN_POLL_MS)
    : 15 * 60 * 1000
});

console.log(JSON.stringify({ ...result, candidateProfile }, null, 2));
if (!result.launchAllowed) process.exitCode = 2;
