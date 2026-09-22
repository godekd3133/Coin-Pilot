import path from 'node:path';
import { spawn } from 'node:child_process';
import { inspectMomentumShadowCandidate } from '../research/momentumShadowCandidatePreflight.js';
import {
  resolveMomentumShadowCandidateProfile
} from '../research/momentumShadowCandidateProfiles.js';
import { DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE } from '../research/momentumShadowCandidateSlot.js';

const csv = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);

let profileResolution;
try {
  profileResolution = resolveMomentumShadowCandidateProfile();
} catch (error) {
  console.error(`candidate launch refused: ${error.message}`);
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
const benchmarkDir = process.env.MOMO_SHADOW_BENCHMARK_DIR || '.paper-momentum-shadow-btc-gate-v1';
const fixedHoldDir = process.env.MOMO_SHADOW_FIXED_HOLD_DIR || '.paper-momentum-shadow-fixed-hold-2d-v1';
const fixedHoldSpreadDir = process.env.MOMO_SHADOW_FIXED_HOLD_SPREAD_DIR || '.paper-momentum-shadow-fixed-hold-2d-spread-v1';
const fixedHoldRelativeDir = process.env.MOMO_SHADOW_FIXED_HOLD_RELATIVE_DIR || '.paper-momentum-shadow-fixed-hold-2d-relative-v1';
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
const candidateSlotFile = path.resolve(
  process.env.MOMO_SHADOW_CANDIDATE_SLOT_FILE || DEFAULT_MOMENTUM_SHADOW_CANDIDATE_SLOT_FILE
);

const readiness = inspectMomentumShadowCandidate({
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

console.log(JSON.stringify({
  ...readiness,
  candidateProfile,
  startAttempt: true,
  readOnly: false
}, null, 2));

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
      MOMO_SHADOW_CANDIDATE_SLOT_FILE: candidateSlotFile,
      MOMO_SHADOW_MODE: candidateConfig.mode,
      MOMO_SHADOW_MAX_HOLD_HOURS: String(candidateConfig.maxHoldHours),
      MOMO_SHADOW_MARKETS: candidateConfig.markets.join(','),
      MOMO_SHADOW_TREND_MIN_PERCENT: String(candidateConfig.trendMinPercent),
      MOMO_SHADOW_BREADTH_MIN: String(candidateConfig.breadthMin),
      MOMO_SHADOW_MIN_UP_BARS: String(candidateConfig.minUpBars),
      MOMO_SHADOW_POSITION_FRACTION: String(candidateConfig.positionFraction),
      MOMO_SHADOW_MAX_POSITIONS: String(candidateConfig.maxPositions),
      MOMO_SHADOW_COST_PERCENT: String(candidateConfig.costPercent),
      MOMO_SHADOW_BENCHMARK_MARKET: candidateConfig.benchmarkMarket,
      MOMO_SHADOW_BENCHMARK_TREND_MIN_PERCENT: String(candidateConfig.benchmarkTrendMinPercent),
      ...(candidateConfig.relativeTrendMinPercent === null
        ? {}
        : { MOMO_SHADOW_RELATIVE_TREND_MIN_PERCENT: String(candidateConfig.relativeTrendMinPercent) }),
      MOMO_SHADOW_EXIT_ON_BENCHMARK_OFF: String(candidateConfig.exitOnBenchmarkOff),
      MOMO_SHADOW_COOLDOWN_AFTER_LOSS_DAYS: String(candidateConfig.cooldownAfterLossDays),
      MOMO_SHADOW_MAX_PORTFOLIO_DRAWDOWN_PERCENT: String(candidateConfig.maxPortfolioDrawdownPercent),
      MOMO_SHADOW_MAX_ENTRY_GAP_PERCENT: String(candidateConfig.maxEntryGapPercent),
      MOMO_SHADOW_MAX_DAILY_CANDLE_AGE_HOURS: String(candidateConfig.maxDailyCandleAgeHours),
      MOMO_SHADOW_MAX_SPREAD_PERCENT: String(candidateConfig.maxSpreadPercent),
      MOMO_SHADOW_REQUEST_INTERVAL_MS: String(candidateConfig.requestIntervalMs),
      MOMO_SHADOW_STOP_LOSS_PERCENT: String(candidateConfig.stopLossPercent),
      MOMO_SHADOW_TAKE_PROFIT_PERCENT: String(candidateConfig.takeProfitPercent),
      MOMO_SHADOW_VOLATILITY_LOOKBACK_DAYS: String(candidateConfig.volatilityLookbackDays),
      MOMO_SHADOW_POLL_MS: String(candidateConfig.pollMs),
      MOMO_SHADOW_ENTRY_EXECUTION: candidateConfig.entryExecution,
      MOMO_SHADOW_EXECUTION_MODEL: candidateConfig.executionModel,
      ...(candidateConfig.volatilityTargetPercent === null
        ? {}
        : { MOMO_SHADOW_VOLATILITY_TARGET_PERCENT: String(candidateConfig.volatilityTargetPercent) })
    }
  });
  child.unref();
  console.log(JSON.stringify({ started: true, ownerPid: child.pid, targetDir: path.resolve(targetDir) }));
}
