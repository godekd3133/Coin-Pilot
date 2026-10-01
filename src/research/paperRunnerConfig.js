import { envBool, envNumber, envString } from '../config/envConfig.js';

/**
 * Build the dry-run configuration for the shared-snapshot variant runner.
 *
 * The variant runner deliberately uses the same runtime contract as
 * runPaperSmoke. Variant overrides are applied only to strategy/research
 * fields; storage, target markets, and dry-run mode remain owned by the
 * runner so one variant cannot redirect another book or enable live orders.
 *
 * Env reads go through envConfig so an undeclared key or malformed value
 * fails fast here instead of silently falling back per call site.
 */
export function buildPaperRunnerConfig({
  portfolioFile,
  paperFile,
  markets,
  variantOverrides = {},
  seedMoney = envNumber('PAPER_SMOKE_SEED_MONEY', 1_000_000),
  diagnosticShadowsEnabled = true,
  env = process.env
} = {}) {
  const options = { source: env };
  return {
    strategyMode: 'oversold_reaction_scalping',
    dryRunSeedMoney: seedMoney,
    paperMinimumStorageMiB: envNumber('SCALP_PAPER_MIN_STORAGE_MIB', 1024, options),
    maxPositions: envNumber('SCALP_MAX_POSITIONS', 3, options),
    portfolioAllocation: envNumber('SCALP_PORTFOLIO_ALLOCATION', 0.1, options),
    investmentRatio: envNumber('SCALP_INVESTMENT_RATIO', 0.02, options),
    maxCandleAgeSeconds: envNumber('SCALP_MAX_CANDLE_AGE_SECONDS', 0, options),
    stopLossPercent: envNumber('SCALP_STOP_LOSS_PERCENT', 1.2, options),
    takeProfitPercent: envNumber('SCALP_TAKE_PROFIT_PERCENT', 1.8, options),
    rsiPeriod: envNumber('SCALP_RSI_PERIOD', envNumber('RSI_PERIOD', 14, options), options),
    rsiOversold: envNumber('SCALP_RSI_OVERSOLD', envNumber('RSI_OVERSOLD', 30, options), options),
    rsiOverbought: envNumber('SCALP_RSI_OVERBOUGHT', envNumber('RSI_OVERBOUGHT', 70, options), options),
    oversoldLookback: envNumber('SCALP_OVERSOLD_LOOKBACK', 1, options),
    candleUnit: envNumber('SCALP_CANDLE_UNIT', 1, options),
    candleCount: envNumber('SCALP_CANDLE_COUNT', 120, options),
    minReboundPercent: envNumber('SCALP_MIN_REBOUND_PERCENT', 0.15, options),
    minRsiRecovery: envNumber('SCALP_MIN_RSI_RECOVERY', 2, options),
    minVolumeRatio: envNumber('SCALP_MIN_VOLUME_RATIO', 1, options),
    volumeLookback: envNumber('SCALP_VOLUME_LOOKBACK', 20, options),
    minCloseStrength: envNumber('SCALP_MIN_CLOSE_STRENGTH', 0.65, options),
    trendPeriod: envNumber('SCALP_TREND_PERIOD', 30, options),
    trendSlopeLookback: envNumber('SCALP_TREND_SLOPE_LOOKBACK', 3, options),
    minTrendSlopePercent: envNumber('SCALP_MIN_TREND_SLOPE_PERCENT', -0.2, options),
    requirePreviousHighBreak: envBool('SCALP_REQUIRE_PREVIOUS_HIGH_BREAK', true, options),
    maxSignalRangePercent: envNumber('SCALP_MAX_SIGNAL_RANGE_PERCENT', 0, options),
    minSignalRangePercent: envNumber('SCALP_MIN_SIGNAL_RANGE_PERCENT', 0, options),
    maxReboundPercent: envNumber('SCALP_MAX_REBOUND_PERCENT', 0, options),
    marketRegimeEnabled: envBool('SCALP_MARKET_REGIME_ENABLED', false, options),
    marketRegimeLookback: envNumber('SCALP_MARKET_REGIME_LOOKBACK', 5, options),
    marketRegimeMinBreadth: envNumber('SCALP_MARKET_REGIME_MIN_BREADTH', 0.5, options),
    marketRegimeMinReturnPercent: envNumber('SCALP_MARKET_REGIME_MIN_RETURN_PERCENT', -0.2, options),
    requireReboundBelowOverbought: envBool('SCALP_REQUIRE_REBOUND_BELOW_OVERBOUGHT', false, options),
    signalProfile: envString('SCALP_SIGNAL_PROFILE', 'rsi_rebound', options),
    bbPeriod: envNumber('BB_PERIOD', 20, options),
    bbStdDev: envNumber('BB_STD_DEV', 2, options),
    emaLong: envNumber('EMA_LONG', 60, options),
    entryDelayMinMs: envNumber('SCALP_ENTRY_DELAY_MIN_MS', 1000, options),
    entryDelayMaxMs: envNumber('SCALP_ENTRY_DELAY_MAX_MS', 5000, options),
    maxEntryRetracePercent: envNumber('SCALP_MAX_ENTRY_RETRACE_PERCENT', 0.25, options),
    maxEntryChasePercent: envNumber('SCALP_MAX_ENTRY_CHASE_PERCENT', 0.35, options),
    breakEvenTriggerPercent: envNumber('SCALP_BREAK_EVEN_TRIGGER_PERCENT', 0, options),
    breakEvenOffsetPercent: envNumber('SCALP_BREAK_EVEN_OFFSET_PERCENT', 0.05, options),
    trailingActivationPercent: envNumber('SCALP_TRAILING_ACTIVATION_PERCENT', 0, options),
    trailingStopPercent: envNumber('SCALP_TRAILING_STOP_PERCENT', 0, options),
    maxHoldMinutes: envNumber('SCALP_MAX_HOLD_MINUTES', 30, options),
    maxLosingHoldMinutes: envNumber('SCALP_MAX_LOSING_HOLD_MINUTES', 0, options),
    winnerExtendMinutes: envNumber('SCALP_WINNER_EXTEND_MINUTES', 0, options),
    winnerExtendMinProfitPercent: envNumber('SCALP_WINNER_EXTEND_MIN_PROFIT_PERCENT', 0, options),
    winnerShadowExtendMinutes: 0,
    winnerShadowExtendMinProfitPercent: 0,
    winnerShadowMaxReboundPercent: 0,
    maxEntriesPerSignalWindow: envNumber('SCALP_MAX_ENTRIES_PER_SIGNAL_WINDOW', 0, options),
    positionRiskCheckIntervalMs: 0,
    maxRiskDataGapSeconds: envNumber('SCALP_MAX_RISK_DATA_GAP_SECONDS', 30, options),
    maxAnalysisDataGapSeconds: envNumber('SCALP_MAX_ANALYSIS_DATA_GAP_SECONDS', 60, options),
    cooldownAfterLossMinutes: envNumber('SCALP_COOLDOWN_AFTER_LOSS_MINUTES', 15, options),
    maxConsecutiveLosses: envNumber('SCALP_MAX_CONSECUTIVE_LOSSES', 3, options),
    lossCircuitBreakerCount: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_COUNT', 0, options),
    lossCircuitBreakerWindowMinutes: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_WINDOW_MINUTES', 30, options),
    lossCircuitBreakerCooldownMinutes: envNumber('SCALP_LOSS_CIRCUIT_BREAKER_COOLDOWN_MINUTES', 60, options),
    checkInterval: envNumber('PAPER_SMOKE_INTERVAL_MS', 5_000, options),
    upbitRequestTimeoutMs: envNumber('UPBIT_REQUEST_TIMEOUT_MS', 10_000, options),
    useNews: false,
    requireValidationPassForLive: true,
    paperValidationMinDays: envNumber('SCALP_PAPER_MIN_DAYS', 7, options),
    paperValidationMinTrades: envNumber('SCALP_PAPER_MIN_TRADES', 20, options),
    paperValidationMinReturnPercent: envNumber('SCALP_PAPER_MIN_RETURN_PERCENT', 0.2, options),
    paperValidationMaxDrawdownPercent: envNumber('SCALP_PAPER_MAX_DRAWDOWN_PERCENT', 15, options),
    paperValidationMaxHeartbeatGapMinutes: envNumber('SCALP_PAPER_MAX_HEARTBEAT_GAP_MINUTES', 15, options),
    scalpingValidationOutputFile: envString('SCALP_VALIDATION_OUTPUT_FILE', 'scalping_validation.json', options),
    logLevel: envString('LOG_LEVEL', 'warn', options),
    ...variantOverrides,
    // Runner-owned safety and storage boundaries cannot be overridden by a
    // variant definition or an environment typo.
    accessKey: '',
    secretKey: '',
    dryRun: true,
    targetCoins: markets,
    virtualPortfolioFile: portfolioFile,
    paperValidationFile: paperFile,
    paperDiagnosticShadowsEnabled: diagnosticShadowsEnabled
  };
}
