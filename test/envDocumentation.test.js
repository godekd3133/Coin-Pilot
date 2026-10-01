import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ENV_SCHEMA } from '../src/config/envSchema.js';

const SRC_ROOT = 'src';
const ENV_EXAMPLE = '.env.example';

// Process-level envs that are universal platform conventions rather than
// CoinPilot configuration and therefore never belong in .env.example.
const PLATFORM_ENVS = new Set([
  'NODE_ENV',
  'PATH',
  'HOME',
  'PWD',
  'LANG',
  'SHELL',
  'USER',
  'TERM',
  'TMPDIR'
]);

const ACCESS_PATTERNS = [
  /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  /process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g,
  // Resolver functions take `env = process.env`; uppercase reads on that
  // parameter are environment reads.
  /\benv\.([A-Z_][A-Z0-9_]*)/g,
  // Env helper calls that receive the variable name as a string literal.
  /(?:numericEnv|listEnv|envNumber|envFlag|booleanEnv|stringEnv|csvEnv|envBool|envInt|envString|envList|envNumberList|envRaw)\(\s*(?:env\s*,\s*)?['"]([A-Z_][A-Z0-9_]*)['"]/g
];

function collectSourceFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(entryPath));
    else if (/\.js$/.test(entry.name)) files.push(entryPath);
  }
  return files;
}

test('src에서 소비하는 모든 env는 .env.example에 문서화되어 있다', () => {
  const consumed = new Map();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of ACCESS_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        if (!consumed.has(match[1])) consumed.set(match[1], new Set());
        consumed.get(match[1]).add(file);
      }
    }
  }

  const documented = new Set(
    [...fs.readFileSync(ENV_EXAMPLE, 'utf8').matchAll(/\b([A-Z_][A-Z0-9_]{2,})\b/g)]
      .map(match => match[1])
  );

  const undocumented = [...consumed.keys()]
    .filter(name => !PLATFORM_ENVS.has(name) && !documented.has(name))
    .sort();

  assert.deepEqual(
    undocumented.map(name => `${name} (${[...consumed.get(name)].join(', ')})`),
    []
  );
});

// Assignment keys are `NAME=value` lines (optionally commented out). This is
// stricter than the free-text scan above: prose tokens like ALL or TRUE do not
// count as documented knobs.
function documentedAssignmentKeys() {
  const keys = new Set();
  for (const line of fs.readFileSync(ENV_EXAMPLE, 'utf8').split('\n')) {
    const match = line.match(/^\s*#?\s*([A-Z_][A-Z0-9_]*)\s*=/);
    if (match) keys.add(match[1]);
  }
  return keys;
}

function consumedKeys() {
  const consumed = new Set();
  for (const file of collectSourceFiles(SRC_ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const pattern of ACCESS_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        consumed.add(match[1]);
      }
    }
  }
  return consumed;
}

test('.env.example의 모든 할당 키는 ENV_SCHEMA에 선언되어 있다', () => {
  const missing = [...documentedAssignmentKeys()]
    .filter(key => !(key in ENV_SCHEMA))
    .sort();
  assert.deepEqual(missing, []);
});

// envConfig로 이전이 끝난 파일은 직접 `process.env.KEY` 읽기가 금지된다.
// 재발하면 여기서 실패한다 — 새 파일을 이전할 때마다 목록에 추가한다.
const TYPED_ENV_MIGRATED_FILES = [
  'src/ai/aiAdvisorService.js',
  'src/ai/monitoringSessionService.js',
  'src/api/liveCredentialStore.js',
  'src/api/routes/research.js',
  'src/api/upbit.js',
  'src/api/upbitRateCoordinator.js',
  'src/optimization/parameterOptimizer.js',
  'src/research/paperRunnerConfig.js',
  'src/scripts/analyzePaperExitEvidence.js',
  'src/scripts/analyzePaperExitPathReplay.js',
  'src/scripts/auditMomentumShadowTradeCosts.js',
  'src/scripts/checkQuoteExecutionCostCompatibility.js',
  'src/scripts/compareScalpingVariants.js',
  'src/scripts/fetchDailyMomentumCandles.js',
  'src/scripts/fetchHigherTimeframeMomentumCandles.js',
  'src/scripts/measureMomentumShadowQuotes.js',
  'src/scripts/momentumShadowStatus.js',
  'src/scripts/preflightMomentumShadowCandidate.js',
  'src/scripts/preflightStrictOnlyForward.js',
  'src/scripts/reconcileLiveExecutionEvidence.js',
  'src/scripts/runAiAdvisorSmoke.js',
  'src/scripts/runAiHistoricalReplay.js',
  'src/scripts/runAiReplayRobustness.js',
  'src/scripts/runBacktest.js',
  'src/scripts/runDashboard.js',
  'src/scripts/runOptimization.js',
  'src/scripts/runPaperDashboard.js',
  'src/scripts/runPaperSmoke.js',
  'src/scripts/runRegimeMomentumShadow.js',
  'src/scripts/runScalpingVariantForward.js',
  'src/scripts/runStagingDashboard.js',
  'src/scripts/startMomentumShadowCandidateIfReady.js',
  'src/scripts/summarizeMomentumShadowQuoteCostHistory.js',
  'src/scripts/summarizePaperForwardCohort.js',
  'src/scripts/validateDailyMarketNeutral.js',
  'src/scripts/validateDailyMomentumBenchmarkConfirmation.js',
  'src/scripts/validateDailyMomentumRobustness.js',
  'src/scripts/validateDailyMomentumRollingWindows.js',
  'src/scripts/validateDailyMomentumVariants.js',
  'src/scripts/validateHigherTimeframeMomentum.js',
  'src/scripts/validatePortfolio.js',
  'src/scripts/validateRegimeMomentum.js',
  'src/scripts/validateScalping.js',
  'src/scripts/validateScalpingNoTradeFill.js',
  'src/scripts/validateScalpingSegments.js',
  'src/scripts/validateShadowCandidate.js',
  'src/scripts/verifyMomentumShadowEvidenceSnapshot.js',
  'src/trader/autoTrader.js',
  'src/utils/logger.js'
];

test('envConfig로 이전된 파일은 직접 env 접근이 없다', () => {
  for (const file of TYPED_ENV_MIGRATED_FILES) {
    const source = fs.readFileSync(file, 'utf8');
    // `process.env.X = ...` writes are child-process env propagation (e.g. the
    // optimizer's runtime-param handoff), not config reads — only reads count.
    const directReads = [
      ...source.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)/g)
    ].filter(match =>
      // `process.env.X = v` / `+= v` writes are child-process env propagation,
      // not config reads — `==`/`===` comparisons still count as reads.
      !/^\s*\+?=(?!=)/.test(source.slice(match.index + match[0].length))
    ).map(match => match[1])
      .concat(
        [...source.matchAll(/process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g)].map(match => match[1])
      )
      .filter(name => !PLATFORM_ENVS.has(name));
    assert.deepEqual(directReads, [], `${file} must read env through envConfig accessors`);
  }
});

test('ENV_SCHEMA의 모든 키는 .env.example 또는 src 소비처에 존재한다', () => {
  const documented = documentedAssignmentKeys();
  const consumed = consumedKeys();
  const orphans = Object.keys(ENV_SCHEMA)
    .filter(key => !documented.has(key) && !consumed.has(key))
    .sort();
  assert.deepEqual(orphans, []);
});
