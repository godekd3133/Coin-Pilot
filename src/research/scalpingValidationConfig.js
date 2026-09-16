import fs from 'node:fs';

// Only copy fields that affect historical signal generation, entry, or exit.
// Runtime-only process identifiers and market lists must never become part of
// a backtest config by accident.
export const VALIDATION_SNAPSHOT_KEYS = Object.freeze([
  'tradingFee',
  'slippage',
  'investmentRatio',
  'rsiPeriod',
  'rsiOversold',
  'rsiOverbought',
  'oversoldLookback',
  'minReboundPercent',
  'minRsiRecovery',
  'minVolumeRatio',
  'volumeLookback',
  'minCloseStrength',
  'trendPeriod',
  'trendSlopeLookback',
  'minTrendSlopePercent',
  'requirePreviousHighBreak',
  'maxSignalRangePercent',
  'minSignalRangePercent',
  'maxReboundPercent',
  'requireReboundBelowOverbought',
  'signalProfile',
  'bbPeriod',
  'bbStdDev',
  'emaPeriod',
  'maxEntryRetracePercent',
  'maxEntryChasePercent',
  'requireNextCandleBullish',
  'breakEvenTriggerPercent',
  'breakEvenOffsetPercent',
  'trailingActivationPercent',
  'trailingStopPercent',
  'stopLossPercent',
  'takeProfitPercent',
  'maxHoldMinutes',
  'maxLosingHoldMinutes',
  'winnerExtendMinutes',
  'winnerExtendMinProfitPercent',
  'maxEntriesPerSignalWindow',
  'cooldownAfterLossMinutes',
  'maxConsecutiveLosses',
  'lossCircuitBreakerCount',
  'lossCircuitBreakerWindowMinutes',
  'lossCircuitBreakerCooldownMinutes',
  'marketRegimeEnabled',
  'marketRegimeLookback',
  'marketRegimeMinBreadth',
  'marketRegimeMinReturnPercent',
  'candleUnit',
  'maxPositions',
  'portfolioAllocation'
]);

// Runtime-behavior bounds that the live gate enforces but that must not be
// copied into a historical validation snapshot: they do not affect simulated
// signal/entry/exit results. They reach validation reports through each lane's
// env-driven baseConfig instead of the ledger snapshot overlay.
export const RUNTIME_BEHAVIOR_CONTRACT_KEYS = Object.freeze([
  'entryDelayMinMs',
  'entryDelayMaxMs',
  'maxCandleAgeSeconds',
  'maxRiskDataGapSeconds',
  'maxAnalysisDataGapSeconds'
]);

// Keys the live gate requires to match between the fixed validation report and
// the current runtime config. This is the single source of truth shared by
// the gate check in multiCoinTrader.js; adding a key here without recording it
// in report.config (snapshot contract or lane baseConfig) makes every fixed
// report fail closed on missingKeys, which is intentional.
export const LIVE_GATE_COMPARABLE_KEYS = Object.freeze([
  ...VALIDATION_SNAPSHOT_KEYS,
  ...RUNTIME_BEHAVIOR_CONTRACT_KEYS
]);

function copyValidationFields(config = {}) {
  return Object.fromEntries(
    VALIDATION_SNAPSHOT_KEYS
      .filter(key => config[key] !== undefined && config[key] !== null)
      .map(key => [key, config[key]])
  );
}

/**
 * Load an immutable paper ledger config for reproducible validation.
 * A partial/legacy snapshot is rejected instead of silently falling back to
 * DEFAULT_CONFIG, which could make a report look runtime-equivalent when it
 * is not.
 */
export function loadPaperValidationConfigSnapshot(filePath) {
  if (!filePath) return null;
  if (!fs.existsSync(filePath)) {
    throw new Error(`지정한 paper config snapshot이 없습니다: ${filePath}`);
  }

  let ledger;
  try {
    ledger = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`paper config snapshot을 읽을 수 없습니다 (${filePath}): ${error.message}`, { cause: error });
  }

  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new Error(`paper config snapshot 형식이 잘못되었습니다: ${filePath}`);
  }
  if (ledger.configSnapshotComplete !== true) {
    throw new Error(`paper config snapshot이 불완전하여 validation을 중단합니다: ${filePath}`);
  }
  if (!ledger.configSnapshot || typeof ledger.configSnapshot !== 'object' || Array.isArray(ledger.configSnapshot)) {
    throw new Error(`paper config snapshot의 configSnapshot 필드가 없습니다: ${filePath}`);
  }

  return {
    filePath,
    sessionId: ledger.sessionId || null,
    startedAt: ledger.startedAt || null,
    configSnapshotComplete: true,
    config: copyValidationFields(ledger.configSnapshot)
  };
}

/**
 * Merge a paper snapshot as the authoritative validation contract. The CLI's
 * candle unit is explicit and must agree with the recorded snapshot unit.
 */
export function mergePaperValidationConfig(baseConfig, snapshot, candleUnit) {
  if (!snapshot) return { ...baseConfig };

  const snapshotUnit = Number(snapshot.config?.candleUnit);
  const requestedUnit = Number(candleUnit);
  if (Number.isFinite(snapshotUnit) && Number.isFinite(requestedUnit) && snapshotUnit !== requestedUnit) {
    throw new Error(
      `candle unit 불일치: paper snapshot=${snapshotUnit}, validation=${requestedUnit}. ` +
      '혼합 timeframe validation을 만들지 않고 중단합니다.'
    );
  }

  return {
    ...baseConfig,
    ...snapshot.config,
    candleUnit: candleUnit ?? snapshot.config.candleUnit ?? baseConfig.candleUnit
  };
}

